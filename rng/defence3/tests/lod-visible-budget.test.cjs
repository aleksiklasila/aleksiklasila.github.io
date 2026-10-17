'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const read = p => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const c = vm.createContext({window:{}, console, TILE:32, GRID_W:1000,GRID_H:1000,viewW:1280,viewH:800,camera:{zoom:3},tickAlpha:1,
    fullVisibility:true,visibilityGrid:[],visibilityVersion:1,gameTime:1,localPlayerId:0,VISIBILITY_LIGHT_NORMALIZATION_RANGE:6,
    SIM_UF_GHOST:65536,SIM_UF_HIDDEN:1024,get3DRenderOwnerColor:()=> '#fff',_isLiveRenderGrid:()=>true});
vm.runInContext(read('src/audio_visual/renderer3d.js'), c);
const R=c.renderer3dInstance=Object.create(c.window.Defence3Renderer3D.prototype);
Object.assign(R,{cssWidth:1280,cssHeight:800,pixelRatio:1,sceneTargetSize:{width:1280,height:800},orbitPitch:.18,orbitYaw:0});
for(const key of ['tmpViewProjection','tmpInverseViewProjection','tmpProjection','tmpView']) R[key]=new Float32Array(16);
const source=read('src/audio_visual/renderer.js');
vm.runInContext(source.slice(source.indexOf('// Rank only visible models.'),source.indexOf('function drawInteractionOverlay')),c);
function populate(points) {
    const n=points.length,F={cap:n,count:n,order:Int32Array.from(points,(_,i)=>i)};
    for(const field of ['x','y','px','py','r','flags','energy']) F[field]=new Float32Array(n);
    c.units=points.map(([x,z,r=8],s)=>{F.x[s]=F.px[s]=x*32;F.y[s]=F.py[s]=z*32;F.r[s]=r;F.energy[s]=10;return {_s:s};});
    c.simClientCurrentUnitVis=()=>F;
    vm.runInContext('_detailMaskClear(); _detailMode=false;',c);
    return F;
}
function project(flat2d,zoom=3,pitch=.18,yaw=0) {
    c.camera.zoom=zoom;R.orbitPitch=pitch;R.orbitYaw=yaw;
    R.buildViewProjection({flat2d,viewportWidth:1280,viewportHeight:800,worldWidth:1000,worldHeight:1000,
        camera:{centerX:500,centerZ:500,visibleWidth:1280/(zoom*32),visibleHeight:800/(zoom*32)}});
}
project(true);
populate(Array.from({length:2000},(_,i)=>[495+(i%50)*.2,497+Math.floor(i/50)*.15]));
let split=c._unitDetailSplit(c.units,true,{});
assert.equal(split.units.length,600,'equal sizes fill the hard budget instead of selecting none');
assert.equal(split.columns.detailMask.reduce((a,b)=>a+(b>0),0),600,'each detailed unit has exactly one GPU exclusion');
assert.equal(c._unitDetailSplit(c.units,true,{}).units,split.units,'stable selection reuses the persistent layer');
// Big units outside the viewport must never starve visible small units.
populate([...Array.from({length:2000},()=>[530,500,30]),...Array.from({length:200},(_,i)=>[499+(i%20)*.1,499+Math.floor(i/20)*.1,5])]);
split=c._unitDetailSplit(c.units,true,{});
assert.equal(split.units.length,200);
assert.ok(split.units.every(u=>u._s>=2000));
project(true,.5);assert.ok(c._unitDetailSplit(c.units,true,{}).units.every(u=>u._s<2000),'small distant bodies remain cheap glyphs');
project(true,4);assert.equal(c._unitDetailSplit(c.units,true,{}).units.length,200,'small bodies become detailed on zoom');
// A tilted camera's padded ground AABB contains nearby off-screen objects.
const points=Array.from({length:20000},(_,i)=>[460+(i%200)*.4,460+Math.floor(i/200)*.8]);
const F=populate(points);
// Worker-owned buckets must agree with the fallback for camera rotations and
// a long rebased interpolation. They share the frame's buffer lifetime.
const worker=read('src/sim/presentation_worker.js');
vm.runInContext(worker.slice(worker.indexOf('function buildRenderBuckets('),worker.indexOf('function draw()')),c);
c.SIM_FRAME_SLOT_BYTES=108;
F.buf=new ArrayBuffer(F.cap*108+63*63*8+F.cap*8);
const B=c.buildRenderBuckets(F,F.count,63,63,32), cells=B.columns*B.rows;
F.renderBuckets={...B,head:new Int32Array(F.buf,B.offset,cells),motion:new Float32Array(F.buf,B.offset+cells*4,cells),next:new Int32Array(F.buf,B.offset+cells*8,F.cap)};
const indexed=[];
for(let b=0;b<cells;b++)for(let k=F.renderBuckets.head[b];k>=0;k=F.renderBuckets.next[k])indexed.push(k);
assert.equal(new Set(indexed).size,F.count,'every unit occurs in exactly one worker bucket');
assert.equal(indexed.length,F.count);
for(const pitch of [.18,.55,1.35]) for(const yaw of [0,Math.PI/2,Math.PI,3*Math.PI/2]) {
    project(false,3,pitch,yaw);
    split=c._unitDetailSplit(c.units,false,{});
    assert.ok(split.units.length>0&&split.units.length<=600,`visible budget at pitch ${pitch}, yaw ${yaw}`);
    const visible=split.units.filter(u=>{const p=R.projectWorldToScreenDetailed(F.x[u._s]/32,.02,F.y[u._s]/32);return p&&p.x>=0&&p.x<=1280&&p.y>=0&&p.y<=800&&p.ndcZ>=-1&&p.ndcZ<=1;});
    assert.ok(visible.length>=split.units.length*.7,'budget is spent on screen, including near-ground rotations');
}
project(true);
c._pageTables={s:{cap:2000}};
c.getCellItemsRowMajor=()=>[];
const structures=Array.from({length:2000},(_,i)=>({_s:i,gx:495+i%10,gy:497+Math.floor(i/10)%6}));
const buildings=c._structureDetailSplit([structures],true,{},true);
assert.equal(buildings.selected.size,600,'equal-sized structures also fill a bounded budget');
assert.equal(buildings.mask.reduce((a,b)=>a+(b>0),0),600);
assert.equal(c._structureDetailSplit([structures],true,{},true),buildings,'unchanged structures reuse their model layer');
// One object has the same size-based representation as an army. Populations
// below the old 600/750 cutoffs must not bypass the column renderer.
for(const flat of [true,false]) {
    project(flat,.15);
    populate([[500,500]]);
    const farUnit=c._unitDetailSplit(c.units,flat,{});
    assert.ok(farUnit?.columns.units,'a single distant unit uses the shared columns');
    assert.equal(farUnit.units.length,0);
    project(flat,4);
    assert.equal(c._unitDetailSplit(c.units,flat,{}).units.length,1);
}
project(true,.15);
c._pageTables.s={cap:1,n:1,kind:new Float32Array([0]),alive:new Float32Array([1]),energy:new Float32Array([10]),gx:new Float32Array([500]),gy:new Float32Array([500])};
c._pageStructViews=[{_s:0,gx:500,gy:500}];c.gameTime++;
assert.equal(c._structureDetailSplit([c._pageStructViews,[],[],[],[]],true,{},true).selected.size,0,'one small building uses the same far LOD');
project(true,4);c.gameTime++;
assert.equal(c._structureDetailSplit([c._pageStructViews,[],[],[],[]],true,{},true).selected.size,1,'one readable building receives detail');
c.units=points.map((_,s)=>({_s:s}));c.simClientCurrentUnitVis=()=>F;
project(true);
// The packed structure path rejects off-screen slots without touching views.
const T={cap:2000,n:2000};
for(const name of ['kind','alive','energy','gx','gy']) T[name]=new Float32Array(2000);
for(let i=0;i<2000;i++) {T.alive[i]=1;T.energy[i]=10;T.kind[i]=i%6;T.gx[i]=495+i%10;T.gy[i]=497+Math.floor(i/10)%6;}
c._pageTables.s=T;c._pageStructViews=structures;c.gameTime++;
const packed=c._structureDetailSplit([[],[],[],[],[]],true,{},true);
assert.equal(packed.selected.size,600);
assert.equal(packed.mask.reduce((a,b)=>a+(b>0),0),600);
// A live structure's research task (SIM_SF_RESEARCH_TASK, 65536) is not a
// remembered one: in the dark it is not drawn (a lab at work was seen
// through the fog in Team visibility).
T.flags=new Float32Array(2000).fill(65536);c.fullVisibility=false;c.visibilityGrid=[];c.gameTime++;
assert.equal(c._structureDetailSplit([[],[],[],[],[]],true,{},true).selected.size,0,'a structure at research in the dark stays hidden');
c.fullVisibility=true;delete T.flags;
T.alive.fill(0);c.gameTime++;
assert.equal(c._structureDetailSplit([[],[],[],[],[]],true,{},true).selected.size,0,'retired structures cannot hold detail slots');
// A zoomed camera in a huge world still needs columns for its far population
// even when the CPU query yields fewer units than the model budget.
project(true,3);
const sparse=c.units.slice(0,1);
assert.ok(c._unitDetailSplit(sparse,true,{}).columns.units,'small query preserves the distant GPU army');
vm.runInContext('let rendererChunkCache=null;'+source.slice(source.indexOf('function getChunkRenderView('),source.indexOf('function useScaleRendering(')),c);
const world={grid:[],units:c.units,towers:[],barracks:[],collectorSpawners:[],goldMines:[],astarMines:[],droppedItems:[]};
for(const flat of [true,false])for(const zoom of [.6,3,15])for(const yaw of [0,Math.PI/2,Math.PI]) {
    project(flat,zoom,.38,yaw);c.gameTime++;
    const subset=new Set(c.getChunkRenderView(world,{minGx:0,minGy:0,maxGx:999,maxGy:999},flat).units);
    for(let i=0;i<c.units.length;i++) if(c._detailScore(F.x[i]/32,F.y[i]/32,.55,flat)>0) assert.ok(subset.has(c.units[i]),'early packed-column culling retains every readable visible model');
}
// Long movement across chunk boundaries must not disappear mid-tick.
F.px[0]=470*32;F.py[0]=500*32;F.x[0]=530*32;F.y[0]=500*32;
// Rebuild at the destination, then emulate a page interpolation rebase.
F.px[0]=F.x[0];F.py[0]=F.y[0];c.buildRenderBuckets(F,F.count,63,63,32);
F.px[0]=470*32;F.renderMotionPad=60*32;
c.simClientCurrentUnitVis=()=>({...F});c.tickAlpha=.5;project(true,15);c.gameTime++;
assert.ok(c.getChunkRenderView(world,{minGx:495,minGy:495,maxGx:505,maxGy:505},true).units.includes(c.units[0]));
console.log('PASS visible detail, equal sizes, small-unit zoom, hard budgets, exact masks, reuse, and 12 low/high camera rotations');
const lod=c.window.figureLodLevel;
assert.equal(lod(0,80),0);
assert.equal(lod(0,55),1,'medium mesh is visible before the detail cutoff');
assert.equal(lod(1,32),2,'coarse mesh bridges to GPU silhouettes');
assert.equal(lod(1,67),1,'medium mesh does not flicker near the full boundary');
assert.equal(lod(2,42),2,'coarse mesh does not flicker near the medium boundary');
assert.equal(lod(2,45),1);
assert.equal(lod(1,71),0);

// Fog history is a source adapter, not a different rendering policy: the
// remembered structures are the live table's columns slot by slot
// (visibility_history.js historyStructureFrame), a remembered one its row as
// last seen marked a ghost, one whose slot was taken over kept past the slots.
vm.runInContext(source.slice(source.indexOf('function _detailColumns('),source.indexOf('// Rank only visible models.')),c);
vm.runInContext(read('src/audio_visual/visibility_history.js'),c);
const liveGrid=[];c._isLiveRenderGrid=g=>g===liveGrid;
const GHOST=vm.runInContext('STRUCT_FRAME_GHOST',c);
assert.equal(GHOST,vm.runInContext('HISTORY_GHOST_FLAG',c),'one ghost bit for the page and the GPU');
let HT={n:3,cap:8};
for(const [type,names] of [[Float32Array,['x','y','energy','angle','vision','amount']],[Int32Array,['serial','flags']],[Int16Array,['kind','gx','gy','owner','type','utype']],[Uint8Array,['alive']]]) for(const k of names) HT[k]=new type(8);
const view=(s,kind,extra)=>({_s:s,_serial:HT.serial[s],_structView:true,_kind:kind,dead:false,gx:HT.gx[s],gy:HT.gy[s],x:HT.x[s],y:HT.y[s],owner:0,type:'fire',...extra});
const put=(s,kind,gx,gy,serial,extra={})=>{
    HT.alive[s]=1;HT.serial[s]=serial;HT.kind[s]=kind;HT.gx[s]=gx;HT.gy[s]=gy;HT.x[s]=(gx+.5)*32;HT.y[s]=(gy+.5)*32;
    HT.energy[s]=kind<4?10:0;HT.amount[s]=extra.astar||0;HT.type[s]=1;HT.flags[s]=65536;
    return view(s,kind,{energy:kind<4?10:undefined,...extra});
};
const tower=put(0,0,500,500,1), mine=put(1,5,501,500,2,{astar:123}), floor=put(2,3,502,500,3);
c._pageTables={s:HT};c._pageStructViews=[tower,mine,floor];c.simClientActive=()=>true;c._simClient={structMver:1};
c.units=[];c.projectiles=[];c.particles=[];c.droppedItems=[];
const rows=flat=>{const r=Array.from({length:1000},(_,y)=>flat.subarray(y*1000,(y+1)*1000));r._flat=flat;return r;};
const light=new Float32Array(1e6),h={light:rows(light),fog:rows(new Float32Array(1e6)),width:1000,height:1000};
const see=(gx,on)=>{light[500*1000+gx]=on?3:0;c.visibilityVersion++;};
// (A new table from the worker: the same columns here.)
const table=()=>{HT=Object.assign({},HT);c._pageTables.s=HT;};
see(500,1);see(501,1);see(502,1);
c.__h=h;vm.runInContext('visibilityHistoryState=__h; teamVisibilityHistory=true;',c);
c.updateLocalVisibilityHistory(h);
c.fullVisibility=false;c.visibilityGrid=h.light;
const historyView=h.view;
let H=c._structureRenderFrame(historyView);
assert.equal(H.n,3);
assert.deepEqual([...H.sources],[tower,mine,floor],'what is seen now: the live views');
assert.equal(H.flags[0],65536,'a live row is the table\'s row');
assert.equal(H.flags[0]&GHOST,0);
const ver=H.ver;
assert.equal(c._structureRenderFrame(historyView),H,'the same frame');
c.visibilityVersion++;
assert.equal(c._structureRenderFrame(historyView).ver,ver,'the light changed, no row: no new upload');
// Out of sight: remembered as last seen (the table goes on: its amount).
see(501,0);table();HT.amount[1]=0;mine.astar=0;
H=c._structureRenderFrame(historyView);
assert.ok(H.ver>ver);
assert.ok(H.flags[1]&GHOST,'a remembered row is marked');
assert.equal(H.amount[1],123,'frozen resource state');assert.equal(H.alive[1],1);
assert.equal(H.sources[1]._historyGhost,true);assert.equal(H.sources[1].astar,123,'its source a frozen copy');
assert.equal(tower._s,0,'history never overwrites live slots');
// Its slot taken over out of sight: the ghost kept past the slots.
const rev=H.rev;
table();HT.serial[1]=9;HT.kind[1]=0;HT.gx[1]=600;HT.gy[1]=600;HT.x[1]=600.5*32;HT.y[1]=600.5*32;HT.energy[1]=10;HT.amount[1]=0;
c._pageStructViews[1]=view(1,0,{energy:10});c._simClient.structMver++;
H=c._structureRenderFrame(historyView);
assert.equal(H.n,4,'the remembered mine past the slots');
assert.equal(H.kind[3],5);assert.equal(H.gx[3],501);assert.ok(H.flags[3]&GHOST);assert.equal(H.amount[3],123);
assert.equal(H.flags[1]&GHOST,0,'the slot is the new structure\'s, hidden where nothing sees');
assert.equal(H.sources[1],c._pageStructViews[1]);
assert.notEqual(H.rev,rev,'slots taken over: a new spatial index');
// Its tile seen again, nothing there: forgotten.
see(501,1);
H=c._structureRenderFrame(historyView);
assert.equal(H.n,3,'seen gone: forgotten');
// Destroyed out of sight: still remembered where it stood.
see(502,0);table();HT.alive[2]=0;HT.energy[2]=0;floor.dead=true;
H=c._structureRenderFrame(historyView);
assert.ok(H.flags[2]&GHOST);assert.equal(H.alive[2],1);assert.equal(H.energy[2],10,'its energy as last seen');
project(true,.15);c.gameTime++;
const D=c._structureDetailSplit([[],[],[],[],[]],true,{},false,H);
assert.equal(D.selected.size,0);
assert.equal(c._detailColumns(null,D).structures,H,'history buildings use the same GPU columns at far zoom');
project(true,4);c.gameTime++;
const near=c._structureDetailSplit([[],[],[],[],[]],true,{},false,H);
assert.deepEqual([...near.selected].map(e=>e._historyGhost?'ghost':e._kind),[0,'ghost'],'the seen tower and the remembered floor item, not the hidden one');
assert.equal(near.lists[0][0],tower);assert.equal(near.floors[0],H.sources[2]);
R.columnLayers=c._detailColumns(null,D);
let pickedHistory=null;
R.visitScaleCandidates([tower],(entity,x,z)=>{pickedHistory={entity,x,z};});
assert.equal(pickedHistory.entity,tower);
assert.equal(pickedHistory.x,500.5,'picking a live structure reads its own row');
pickedHistory=null;R.visitScaleCandidates([H.sources[2]],(entity)=>{pickedHistory=entity;});
assert.equal(pickedHistory,null,'remembered ones are not picked');
// The canvas renderer's view: lists and cells.
c.grid=Array.from({length:1000},()=>Array.from({length:1000},()=>({type:0,owner:-1})));
const canvasView=c.getLiveRenderView(true);
assert.equal(canvasView.towers.length,1);assert.equal(canvasView.towers[0],tower);assert.equal(canvasView.grid[500][502].item,H.sources[2]);
c.fullVisibility=true;c.visibilityGrid=[];vm.runInContext('teamVisibilityHistory=false;',c);

// Small 2D pans must reuse the same bounded selection between simulation
// ticks, just like 3D. Projection still updates each frame; a jump or mode
// switch cannot reuse a selection for a different view.
c.performance={now:()=>1000};c.camera.x=100;c.camera.y=100;c.gameTime++;
const flatKey=c._detailViewKey(true);
c.camera.x+=10;
assert.equal(c._detailViewKey(true),flatKey,'2D pan does not rescan the population every display frame');
c.gameTime++;
assert.notEqual(c._detailViewKey(true),flatKey,'next tick admits newly visible detail');
const panKey=c._detailViewKey(true);
c.camera.x+=1000;
assert.notEqual(c._detailViewKey(true),panKey,'camera jumps refresh immediately');
assert.notEqual(c._detailViewKey(false),c._detailViewKey(true),'2D and 3D never share a held selection');
