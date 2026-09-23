const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const overlay = read('src/audio_visual/selection_overlay.js');
// Run the pure geometry with the host intrinsics, as in the browser (VM proxy
// lookups distort arithmetic benchmarks). Assertions never depend on timings.
const { buildSelectionContours, getSelectionContours, drawRallySegments2D } = new Function(`
    let TILE=32, camera={zoom:1}, OVERLAY_LINE_DOTTED='dotted', OVERLAY_LINE_SOLID='solid';
    let showSelectionOutlinesForUnits=()=>true, showSelectionOutlinesForBuildings=()=>true;
    let _getOverlayLineSprite=()=>({canvas:{},baseLen:64,halfW:35,halfH:4,drawW:70,drawH:8});
    let _setDrawImageTrackedTransform=(ctx,...args)=>ctx.setTransform(...args);
    ${overlay}
    return {buildSelectionContours,getSelectionContours,drawRallySegments2D};
`)();
const unit = (x,y,color='#f00') => ({x,y,radius:14,color});
const countPaths = groups => groups.reduce((n,g)=>n+g.paths.length,0);
const countEdges = groups => groups.reduce((n,g)=>n+g.paths.reduce((n,p)=>n+p.length,0),0);
const dense = Array.from({length:1200},(_,i)=>unit(i%40*18,Math.floor(i/40)*18));
const before = JSON.stringify(dense);
const denseContours = buildSelectionContours(dense);
assert.equal(countPaths(denseContours),1,'dense selection has one boundary');
assert.ok(countEdges(denseContours)<500,'only the perimeter remains, not 1200 individual outlines');
assert.equal(buildSelectionContours(dense),denseContours,'stationary geometry is reused');
assert.equal(JSON.stringify(dense),before,'building contours does not change input state');
const separate = dense.map((p,i)=>({...p,x:p.x+(i>=600?1500:0)}));
assert.equal(countPaths(buildSelectionContours(separate)),2,'separate clusters are not bridged');
assert.equal(buildSelectionContours([unit(0,0),unit(0,0,'#0f0')]).length,2,'different teams remain separate');
const ring = Array.from({length:32},(_,i)=>({...unit(Math.cos(i*Math.PI/16)*120,Math.sin(i*Math.PI/16)*120),radius:18}));
assert.equal(countPaths(buildSelectionContours(ring)),2,'concave selections retain their inner hole');
const scattered = Array.from({length:1200},(_,i)=>unit(i%40*100,Math.floor(i/40)*100));
assert.equal(countPaths(buildSelectionContours(scattered)),1200,'isolated selections survive');
dense[0].x -= 100;
assert.notEqual(buildSelectionContours(dense),denseContours,'movement invalidates geometry');
assert.deepEqual(buildSelectionContours([]),[],'deselection clears all outlines');
const interpolated = getSelectionContours([], [{x:100,y:80,prevX:0,prevY:0,r:8,owner:0}],.5,()=> '#f00');
const xs = interpolated[0].paths[0].map(p=>p[0]);
assert.equal((Math.min(...xs)+Math.max(...xs))/2,50,'boundary follows interpolated position');

// Direct sprite transforms must match the old translate/rotate/scale path,
// including when the main canvas is scaled/transformed for zoom and DPR.
const matrix = {a:1.3,b:.2,c:-.1,d:.8,e:71,f:-37};
let transforms=[],images=0,saves=0;
let ctx={getTransform:()=>matrix,save(){saves++;},restore(){},setTransform(...m){transforms.push(m);},drawImage(){images++;}};
const segments = Array.from({length:1200},(_,i)=>[i,i/3,550-i,900+i/7]);
drawRallySegments2D(ctx,segments,'#fff',true);
assert.equal(images,1200,'all destinations remain represented');
assert.equal(saves,1,'one save per group instead of one per line');
for(let i=0;i<segments.length;i++) {
    const p=segments[i],dx=p[2]-p[0],dy=p[3]-p[1],angle=Math.atan2(dy,dx),scale=Math.hypot(dx,dy)/64;
    const a=Math.cos(angle)*scale,b=Math.sin(angle)*scale,c=-Math.sin(angle),d=Math.cos(angle);
    const x=Math.round((p[0]+p[2])/2),y=Math.round((p[1]+p[3])/2);
    const expected=[matrix.a*a+matrix.c*b,matrix.b*a+matrix.d*b,matrix.a*c+matrix.c*d,matrix.b*c+matrix.d*d,matrix.a*x+matrix.c*y+matrix.e,matrix.b*x+matrix.d*y+matrix.f];
    expected.forEach((v,j)=>assert.ok(Math.abs(v-transforms[i][j])<1e-9));
}
assert.deepEqual(transforms.at(-1),Object.values(matrix),'tracked transform restored');

const audio = read('src/audio_visual/audio.js');
const start = audio.indexOf('function doesCurrentSelectionMatchSnapshot(');
const end = audio.indexOf('\nfunction ',start+1);
const selectedUnits = Array.from({length:1200},(_,id)=>({id}));
selectedUnits.includes=()=>{throw Error('quadratic includes scan');};
const ac=vm.createContext({selectedUnits,selectedEntities:[],activeSubGroups:{snake:true}});
vm.runInContext(audio.slice(start,end),ac);
const group={units:[...selectedUnits].reverse(),entities:[],activeSubGroups:{snake:true}};
assert.equal(ac.doesCurrentSelectionMatchSnapshot(group),true);
group.units[0]={id:99999};
assert.equal(ac.doesCurrentSelectionMatchSnapshot(group),false,'same length with different members is not active');
group.units=[...selectedUnits];group.activeSubGroups.snake=false;
assert.equal(ac.doesCurrentSelectionMatchSnapshot(group),false,'subgroup toggles are preserved');
group.activeSubGroups.snake=true;selectedUnits[10].dead=true;
assert.equal(ac.doesCurrentSelectionMatchSnapshot(group),false,'dead members retain the original matching rules');

const rc=vm.createContext({window:{},console});
vm.runInContext(read('src/audio_visual/renderer3d.js'),rc);
const renderer=Object.create(rc.window.Defence3Renderer3D.prototype);
const calls=[];
renderer.gl=new Proxy({}, {get(target,name){
    if (/^[A-Z_0-9]+$/.test(name)) return name;
    return (...args)=>{calls.push([name,...args]);if(name==='getShaderParameter'||name==='getProgramParameter')return true;return {};};
}});
renderer.cssWidth=1200;renderer.cssHeight=800;renderer.tmpViewProjection=new Float32Array(16);
renderer.projectWorldToScreen=(x,y,z)=>({x:x*32,y:z*32});
const data={selectionContours:denseContours,selectionDashed:true,worldTileSize:32,
    lines:Array.from({length:1200},(_,i)=>({x1:i,z1:0,x2:15,z2:15,color:'rgba(100,255,100,0.5)',dashed:true}))};
renderer.drawGroundOverlays(data);
assert.equal(calls.filter(c=>c[0]==='drawArraysInstanced').length,1,'outlines and rallies share one GPU draw');
assert.equal(calls.find(c=>c[0]==='drawArraysInstanced')[4],countEdges(denseContours)+1200);
assert.ok(calls.some(c=>c[0]==='enable'&&c[1]==='DEPTH_TEST'));
assert.ok(calls.some(c=>c[0]==='depthMask'&&c[1]===false));
assert.equal(calls.filter(c=>c[0]==='readPixels').length,0,'occlusion must not cause CPU depth readback');
assert.equal(data.groundLinesRendered,true,'canvas must not stroke these again');
const buffer=renderer.groundLineData;
renderer.drawGroundOverlays(data);
assert.equal(renderer.groundLineData,buffer,'instance storage is reused');
assert.equal(calls.filter(c=>c[0]==='bufferData').length,1,'no per-frame buffer reallocation');
console.log(`PASS: 1200 selections -> ${countEdges(denseContours)} boundary edges; separated clusters, holes, interpolation, rally transforms, membership and depth-tested GPU batching.`);
