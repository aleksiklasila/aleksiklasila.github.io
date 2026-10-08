const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const read = p => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const src = read('src/things/unit.js');
const c = vm.createContext({TILE:32,UNIT_POSITION_QUANTIZATION:1024,gameTime:0,GRID_W:100,GRID_H:100,
    CROSS_TEAM_UNIT_COLLISION_PADDING:16,CHUNK_SIZE:1000,spatialUnitsComplexPlayerCount:0,spatialUnitsComplex:new Int32Array(0),
    spatialUnitsComplexStridePerChunk:0,spatialUnitsComplexStridePerPlayer:0,BASE_UNIT_STATS:{norm:{r:8}},CHUNKS_W:1,CHUNKS_H:1,
    getUnitCollisionRecalcTicks:()=>5,canUnitOccupyTile:()=>true,canUnitOccupyTileCached:()=>true,updateUnitSpatial:()=>{}});
vm.runInContext(read('src/utils/utils_common.js'),c);
// The separation pass runs its pair search as a kernel (sim_parallel.js).
vm.runInContext(read('src/sim/sim_parallel.js'),c);
vm.runInContext(read('src/sim/sim_unit_state.js'),c);
vm.runInContext(src,c);
// (The crowd's separation itself: tests/separation-jitter.test.cjs and
// unit-collision-smoothness.test.cjs, on the real Rust chain.)
// A huge accumulated push cannot skip a wall even if its endpoint is empty.
c.canUnitOccupyTile=(_u,x)=>x!==1;
let u={x:16,y:16,getCollisionRadius:()=>64};c.applyUnitSeparation(u,10000,0,128);
assert.ok(u.x<32,'swept large correction cannot jump an intervening wall');

const r=vm.createContext({});vm.runInContext(read('src/audio_visual/range_overlay.js'),r);
const a=r.buildRangeBoundary([{x:0,y:0},{x:0,y:1}],3,2);
const b=r.buildRangeBoundary([{x:1,y:0},{x:2,y:0}],3,2);
const boundary=r.unionRangePerimeters([a,b]);
assert.ok(!boundary.some(l=>l.x1===1&&l.x2===1&&l.z1===0&&l.z2>0),'partial shared edges cancel');
assert.equal(r.clipRangeBoundaryToBounds(boundary,10,10,20,20).length,0,'off-screen range work is culled');
const clipped=r.clipRangeBoundaryToBounds(boundary,0,0,1,1);
assert.equal(r.clipRangeBoundaryToBounds(boundary,0,0,1,1),clipped,'camera-stable clipped geometry is reused');

// Exercise object/shadow preparation in both visibility modes with the same
// live light field and a different (lifted) presentation field.
const render=read('src/audio_visual/renderer.js');
let p=render.indexOf('function getRenderLightGradient('),q=render.indexOf('\nfunction drawWithTrackedContextTransform',p+1);
const light=vm.createContext({fullVisibility:false,VISIBILITY_LIGHT_NORMALIZATION_RANGE:6,
    DEFAULT_SHADOW_DIR_X:1,DEFAULT_SHADOW_DIR_Y:0,AREA_UNIT_TILE_EQUIVALENT:5,GRID_W:4,
    visibilityGrid:[[0,0,0,0],[0,.1,3,6],[0,.2,2,4],[0,0,0,0]],
    _getCachedLitTint:(_color,l)=>String(l),getHistoryRenderView:()=>null,
    visibilityHistoryState:{explored:new Uint8Array(16).fill(1),raw:[[0,0,0,0],[0,1,1,1],[0,1,1,1],[0,0,0,0]]}});
light.getRenderVisibilityGrid=()=>light.visibilityGrid.map(row=>row.map(v=>Math.max(.84,v)));
vm.runInContext(render.slice(p,q),light);
let team=[],history=[],object={x:1.4,z:1.4,scaleX:1,scaleY:1,scaleZ:1};
light.push3DRenderObject(team,object);
light.getHistoryRenderView=()=>({});light.push3DRenderObject(history,object);
assert.deepEqual(history,team,'visible object light, shadow direction and length exactly match Team mode');
console.log('PASS: swept push stops at walls, clipped perimeter and identical live shadows.');
