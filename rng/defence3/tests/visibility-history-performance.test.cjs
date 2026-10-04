const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const fn = (source, name) => {
    const start = source.indexOf(`function ${name}(`);
    const end = source.indexOf('\nfunction ', start + 1);
    assert.ok(start >= 0, name);
    return source.slice(start, end < 0 ? undefined : end);
};
const c = vm.createContext({
    TILE:32, GRID_W:80, GRID_H:80, TICK_RATE:20, localPlayerId:0, gameTime:0, visibilityVersion:0,
    fullVisibility:false, VISIBILITY_LIGHT_NORMALIZATION_RANGE:6,
    VISIBILITY_LIGHT_MAX_CHANGE_PER_SECOND:6, VISIBILITY_FADE_MAX_CHANGE_PER_SECOND:3,
    grid:Array.from({length:80},()=>Array.from({length:80},()=>({}))),
    visibilityGrid:[], units:Array.from({length:1500},(_,id)=>new Proxy({id,x:16,y:16,energy:10}, {
        ownKeys(){throw Error('visual hold cannot enumerate entity state');},
        get(target,key){if(key==='preComputed') throw Error('visible objects must not be copied'); return target[key];}
    })),
    towers:[],barracks:[],collectorSpawners:[],goldMines:[],astarMines:[],droppedItems:[],projectiles:[],particles:[],
    document:{createElement(){throw Error('visual hold cannot create terrain canvases');}}
});
vm.runInContext(read('src/audio_visual/visibility_history.js')+'\nteamVisibilityHistory=true;',c);
const renderer=read('src/audio_visual/renderer.js');
c.getRawVisibilityGridForPlayer=()=>c.raw;
// No gameplay coverage in this sandbox: the queries read the grid.
c._visCoverTileVisible=()=>null;
for (const name of ['isTileActuallyVisibleToPlayer','isGameplayTargetVisibleToPlayer']) vm.runInContext(fn(renderer,name),c);
const raw=()=>Array.from({length:80},()=>new Float32Array(80));
c.raw=raw();c.raw[0][0]=3;
const update=()=>c.visibilityGrid=c.updateVisualVisibility(c.localPlayerId,c.raw);
update();
const h=vm.runInContext('visibilityHistoryState',c);
const light=h.light,fog=h.fog,expiry=h.holdUntil;
const version=c.visibilityVersion;
assert.equal(c.getLiveRenderView().units[0],c.units[0],'visible objects render directly without copies');
assert.equal(c.isGameplayTargetVisibleToPlayer(0,0,0),true);
for(let tick=1;tick<=20;tick++) {c.gameTime=tick;update();}
assert.equal(c.visibilityVersion,version,'unchanged lighting does not invalidate the fog mask every tick');
assert.equal(h.light,light);assert.equal(h.fog,fog);assert.equal(h.holdUntil,expiry);
const bytes=light.reduce((sum,row)=>sum+row.byteLength,0)+fog.reduce((sum,row)=>sum+row.byteLength,0)
    +h.holdUntil.byteLength+h.explored.byteLength;
assert.equal(bytes,80*80*13,'presentation memory is fixed per tile and independent of army size');

// Immediate gameplay, a one-second visual hold, then a fade. Re-entry renews it.
c.gameTime=21;c.raw=raw();update();
assert.equal(c.isGameplayTargetVisibleToPlayer(0,0,0),false,'targeting immediately loses vision');
assert.equal(c.raw[0][0],0,'presentation must never write to the gameplay grid');
assert.equal(light[0][0],3);
c.gameTime=30;c.raw[0][0]=3;update();
c.gameTime=31;c.raw[0][0]=0;update();
c.gameTime=50;update();assert.equal(light[0][0],3,'brief re-entry renews the hold');
c.units=c.units.map(u=>({id:u.id,x:u.x,y:u.y,energy:u.energy}));
c.goldMines=[{gx:0,gy:0,gold:123}];
c.gameTime=51;update();assert.ok(light[0][0]<3,'fade starts after the visual hold');
for(let tick=52;tick<=90;tick++) {c.gameTime=tick;update();}
assert.equal(light[0][0],0,'live entities eventually stop rendering in a departed area');
assert.ok(fog[0][0]>0 && fog[0][0]<1,'explored terrain alone remains dim');
assert.equal(fog[0][1],0,'unexplored terrain remains black');
assert.equal(c.isGameplayTargetVisibleToPlayer(0,0,0),false,'exploration does not reveal gameplay targets');
const remembered=c.getLiveRenderView().units[0];
assert.equal(remembered._historyGhost,true);
assert.equal(c.getLiveRenderView().goldMines[0].gold,123);
assert.equal(h.memories.units.get(0).source,null,'hidden snapshots detach live world references');
c.units[0].energy=0; c.goldMines[0].gold=0; c.gameTime++;update();
assert.equal(c.getLiveRenderView().units[0],remembered,'hidden records are not copied repeatedly');
assert.equal(remembered.energy,10);
c.gameTime=12;update();
assert.equal(vm.runInContext('visibilityHistoryState',c),h,'rewind retains local exploration/history');
assert.equal(c.getLiveRenderView().goldMines[0].gold,123);
c.localPlayerId=1;update();assert.equal(c.getRenderVisibilityGrid()[0][0],0,'switching teams clears local exploration');
c.fullVisibility=true;update();assert.equal(c.visibilityGrid,c.raw);

// Integer expiry also works at tick rates with fractional millisecond periods.
c.fullVisibility=false;c.localPlayerId=0;
for(let rate of [10,30,60]) {
    vm.runInContext("visibilityHistoryState=null",c);
    c.TICK_RATE=rate;c.gameTime=0;c.raw=raw();c.raw[0][0]=3;update();
    c.gameTime=1;c.raw[0][0]=0;update();
    c.gameTime=rate;update();assert.equal(c.visibilityGrid[0][0],3);
    c.gameTime=rate+1;update();assert.ok(c.visibilityGrid[0][0]<3);
}

// Visibility must not change background texture versions or add a history canvas.
const gpuSource=read('src/audio_visual/renderer3d.js');
const start=gpuSource.indexOf('        uploadBackgroundTexture('),end=gpuSource.indexOf('        uploadFogTexture(',start);
const upload=vm.runInNewContext('({' + gpuSource.slice(start,end) + '})').uploadBackgroundTexture;
let uploads=0,mipmaps=0;
const gpu={backgroundTextureSize:{width:0,height:0},backgroundTextureVersion:-1,
    gl:{bindTexture(){},pixelStorei(){},texImage2D(){uploads++;},texSubImage2D(){uploads++;},
        texParameteri(){},generateMipmap(){mipmaps++;}}};
const background={width:2560,height:2560};
for(let i=0;i<100;i++) {c.gameTime++;update();upload.call(gpu,background,7);}
assert.equal(uploads,1);assert.equal(mipmaps,1);
assert.ok(!renderer.includes('getHistoryBackground('));
assert.ok(!renderer.includes('updateVisibilityHistory('));
assert.ok(!read('src/utils/utils_networking.js').includes('snapshotVisibilityAreaHold'));
// The simulation worker exposes all structures through a shared frame schema.
// Mines/drops have energy=0 there even though their resource amount is positive.
c.units=[{id:999,x:16,y:16,energy:0}];
c.goldMines=[{gx:0,gy:0,x:16,y:16,energy:0,gold:123,maxGold:200}];
c.astarMines=[{gx:1,gy:0,x:48,y:16,energy:0,astar:0,maxAstar:300}];
c.droppedItems=[{gx:0,gy:0,x:16,y:16,energy:0,value:4}];
c.raw=raw();c.raw[0][0]=c.raw[0][1]=3;c.gameTime=0;
vm.runInContext('visibilityHistoryState=null; teamVisibilityHistory=true;',c);
update();
assert.equal(c.getLiveRenderView().goldMines.length,1,'live frame energy mine survives health filter');
assert.equal(c.getLiveRenderView().astarMines.length,1,'depleted frame A* mine stays visible');
assert.equal(c.getLiveRenderView().droppedItems.length,1,'resource drops have no health');
assert.equal(c.getLiveRenderView().units.length,0,'dead units are still excluded');
c.raw=raw();
for(let tick=1;tick<=180;tick++) {c.gameTime=tick;update();}
const ghostGold=c.getLiveRenderView().goldMines[0],ghostAstar=c.getLiveRenderView().astarMines[0];
assert.equal(ghostGold._historyGhost,true);assert.equal(ghostGold.gold,123);assert.equal(ghostGold.maxGold,200);
assert.equal(ghostAstar._historyGhost,true);assert.equal(ghostAstar.astar,0);assert.equal(ghostAstar.maxAstar,300);
console.log(`PASS: immediate targeting, local visual hold/fade at 10/30/60 Hz, ${bytes} bytes for 80x80 tiles, freeze-on-hide entity records, retained mine resources, no repeat terrain uploads.`);
