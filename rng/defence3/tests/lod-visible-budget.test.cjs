'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const read = p => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const c = vm.createContext({window:{}, console, TILE:32, viewW:1280,viewH:800,camera:{zoom:3},tickAlpha:1,
    fullVisibility:true,visibilityGrid:[],visibilityVersion:1,gameTime:1,VISIBILITY_LIGHT_NORMALIZATION_RANGE:6,
    SIM_UF_GHOST:65536,SIM_UF_HIDDEN:1024,get3DRenderOwnerColor:()=> '#fff'});
vm.runInContext(read('src/audio_visual/renderer3d.js'), c);
const R=c.renderer3dInstance=Object.create(c.window.Defence3Renderer3D.prototype);
Object.assign(R,{cssWidth:1280,cssHeight:800,pixelRatio:1,sceneTargetSize:{width:1280,height:800},orbitPitch:.18,orbitYaw:0});
for(const key of ['tmpViewProjection','tmpInverseViewProjection','tmpProjection','tmpView']) R[key]=new Float32Array(16);
const source=read('src/audio_visual/renderer.js');
vm.runInContext(source.slice(source.indexOf('// Rank only visible models.'),source.indexOf('function drawInteractionOverlay')),c);
function populate(points) {
    const n=points.length,F={cap:n,count:n};
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
assert.equal(split.columns.detailMask.reduce((a,b)=>a+b,0),600,'each detailed unit has exactly one GPU exclusion');
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
assert.equal(buildings.mask.reduce((a,b)=>a+b,0),600);
assert.equal(c._structureDetailSplit([structures],true,{},true),buildings,'unchanged structures reuse their model layer');
console.log('PASS visible detail, equal sizes, small-unit zoom, hard budgets, exact masks, reuse, and 12 low/high camera rotations');
