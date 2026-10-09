'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const read = p => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const c = vm.createContext({window:{}, console, TILE:32, GRID_W:1000,GRID_H:1000,viewW:1280,viewH:800,camera:{zoom:3},tickAlpha:1,
    fullVisibility:true,visibilityGrid:[],visibilityVersion:1,gameTime:1,VISIBILITY_LIGHT_NORMALIZATION_RANGE:6,
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
F.buf=new ArrayBuffer(F.cap*108+63*63*8+F.cap*4);
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
// The packed structure path rejects off-screen slots without touching views.
const T={cap:2000,n:2000};
for(const name of ['kind','alive','energy','gx','gy']) T[name]=new Float32Array(2000);
for(let i=0;i<2000;i++) {T.alive[i]=1;T.energy[i]=10;T.kind[i]=i%6;T.gx[i]=495+i%10;T.gy[i]=497+Math.floor(i/10)%6;}
c._pageTables.s=T;c._pageStructViews=structures;c.gameTime++;
const packed=c._structureDetailSplit([[],[],[],[],[]],true,{},true);
assert.equal(packed.selected.size,600);
assert.equal(packed.mask.reduce((a,b)=>a+(b>0),0),600);
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
