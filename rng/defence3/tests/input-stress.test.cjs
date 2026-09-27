const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const H = require('./net-harness.cjs');
const main = fs.readFileSync(path.join(__dirname, '../src/main.js'), 'utf8');
function nested(name) {
    const begin = main.indexOf('    function ' + name + '(');
    const end = main.indexOf('\n    function ', begin + 1);
    assert.ok(begin >= 0 && end > begin);
    return main.slice(begin, end);
}

// Same-type selection may only add owned, live, visible things; shared mines
// are still selectable. Both views use the same ownership and union logic.
const fixture = new Function(`
    let selectedUnits=[], selectedEntities=[], units=[], towers=[], barracks=[], collectorSpawners=[], goldMines=[], astarMines=[];
    let localPlayerId=0,TILE=32,GRID_W=120,GRID_H=120,items=[],grid=Array.from({length:120},()=>[]);
    let isTileVisible=(x,y)=>x!==5,createCurrentViewPointTester=()=>((x,y)=>y<1000);
    let getCellItemsRowMajor=()=>items;
    ${nested('getVisibleSameTypeUnits')}
    ${nested('getVisibleSameTypeEntities')}
    ${nested('toggleVisibleSameTypeSelectionFromHit')}
    return {run:toggleVisibleSameTypeSelectionFromHit,
        set(u,b,t,s,f){units=u;barracks=b;towers=t;collectorSpawners=s;items=f;
          for(const e of f) grid[e.gy][e.gx]={item:e,owner:e.owner};selectedUnits=[];selectedEntities=[];},
        get:()=>({units:selectedUnits,entities:selectedEntities}),
        mines(g,a){goldMines=g;astarMines=a;},
        seed(u,e){selectedUnits=u;selectedEntities=e;}};
`)();
const u = (id, props={})=>({id,owner:0,unitType:'snake',x:48,y:48,r:8,...props});
const b = (id, props={})=>({id,owner:0,type:'house',gx:1,gy:1,x:48,y:48,energy:10,...props});
for (const listType of ['barracks','towers','spawners','floor']) {
    const own=b(1), enemy=b(2,{owner:1,gx:2}), dead=b(3,{energy:0,gx:3});
    const hidden=b(4,{gx:5}), outside=b(5,{y:2000,gy:65});
    const list=[own,enemy,dead,hidden,outside];
    fixture.set([],listType==='barracks'?list:[],listType==='towers'?list:[],listType==='spawners'?list:[],listType==='floor'?list:[]);
    fixture.run({kind:'entity',ref:own});
    assert.deepEqual(fixture.get().entities,[own], listType+' excludes enemy/dead/hidden/offscreen entities');
    fixture.run({kind:'entity',ref:own});
    assert.deepEqual(fixture.get().entities,[],listType+' toggles off');
}
const mine=b(7,{_isGoldMine:true,owner:-1}), astar=b(8,{_isAstarMine:true,owner:-1});
fixture.set([],[],[],[],[]);fixture.mines([mine],[astar]);
fixture.run({kind:'entity',ref:mine});fixture.run({kind:'entity',ref:astar});
assert.deepEqual(fixture.get().entities,[mine,astar]);
const army=Array.from({length:12000},(_,i)=>u(i));
fixture.set([...army,u(12001,{owner:1}),u(12002,{dead:true}),u(12003,{x:176})],[],[],[],[]);
fixture.seed(army.slice(1,6000),[]);
let membershipScans=0;
fixture.get().units.includes=function(value){assert.ok(++membershipScans<=2,'one membership scan per gesture');return Array.prototype.includes.call(this,value);};
fixture.run({kind:'unit',ref:army[0]});
assert.equal(fixture.get().units.length,12000);
assert.equal(new Set(fixture.get().units).size,12000);
fixture.run({kind:'unit',ref:army[0]});assert.equal(fixture.get().units.length,0);

// Real handlers: large building boxes, repeated shift unions, selection order,
// and wheel events without a preceding mousemove (trackpads/keyboard panning).
const world=new H.World();const game=world.spawn('input');
game.eval(`
    GRID_W=GRID_H=120;WORLD_W=WORLD_H=120*TILE;initGrid();initTileEntityLookup();
    fullVisibility=true;gameStarted=true;gameOver=false;
    updateInfoPanel=()=>{};requestInfoPanelRefreshAfterFrame=()=>{};
    minimapCanvas=document.getElementById('minimapCanvas');canvas=document.getElementById('gameCanvas');initInput();
    camera={x:0,y:0,zoom:.1};viewW=1280;viewH=720;
    for(let gy=1;gy<100;gy++)for(let gx=1;gx<100;gx++){
        const item={gx,gy,x:gx*TILE+16,y:gy*TILE+16,type:'house',owner:(gx===90?1:0),energy:10};
        grid[gy][gx].item=item;grid[gy][gx].owner=item.owner;setTileEntity(gx,gy,'house',item);
        if(gx%3===0){barracks.push(item);item.type='barrack';}
    }
`);
const drag=shift=>{
    game.dispatch('game-area','mousedown',{button:0,clientX:1,clientY:1,shiftKey:shift});
    game.dispatch('game-area','mousemove',{buttons:1,clientX:330,clientY:330,shiftKey:shift});
    game.dispatch('game-area','mouseup',{button:0,clientX:330,clientY:330,shiftKey:shift});
};
for(let i=0;i<20;i++)drag(i%2===1);
assert.equal(game.eval('selectedEntities.length'),9702);
assert.equal(game.eval('new Set(selectedEntities).size'),9702);
assert.equal(game.eval('selectedEntities.some(e=>e.owner!==0)'),false);
assert.equal(game.eval('selectedEntities[0]===barracks[0]'),true,'array priority is preserved');
game.eval('__scratch.selection=selectedEntities;__scratch.groups=activeSubGroups;activeSubGroups.house=true;');
drag(false);
assert.equal(game.eval('selectedEntities===__scratch.selection && activeSubGroups===__scratch.groups'),true,'repeat drags retain panel bindings');
game.eval('activeSubGroups.house=false;');drag(false);
assert.equal(game.eval('activeSubGroups===__scratch.groups'),false,'reselection reenables disabled groups');
game.eval('camera={x:900,y:800,zoom:1};mouseWorldX=-10000;mouseWorldY=50000;');
game.dispatch('game-area','wheel',{clientX:400,clientY:300,deltaY:-1});
assert.ok(Math.abs(game.eval('camera.x+400/camera.zoom')-1300)<1e-8,'zoom pins actual wheel x');
assert.ok(Math.abs(game.eval('camera.y+300/camera.zoom')-1100)<1e-8,'zoom pins actual wheel y');
const before=game.eval('JSON.stringify(camera)');
for(const deltaY of [0,NaN,Infinity])game.dispatch('game-area','wheel',{clientX:100,clientY:100,deltaY});
assert.equal(game.eval('JSON.stringify(camera)'),before,'horizontal/invalid wheels are no-ops');
game.eval('gameOver=true');game.dispatch('game-area','wheel',{clientX:100,clientY:100,deltaY:1});
assert.equal(game.eval('JSON.stringify(camera)'),before,'inactive matches do not zoom');
assert.deepEqual(game.errors,[]);
console.log('PASS: 12,000 same-type units, 9,702 buildings, repeated unions, ownership, shared mines, wheel anchoring and inactive input.');
