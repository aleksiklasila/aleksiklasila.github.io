const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const context = {window:{}};
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/audio_visual/renderer3d.js'), 'utf8'), context);
const r = Object.create(context.window.Defence3Renderer3D.prototype);
let uploads = 0;
let flipY = true, gpuData, gpuWidth, gpuHeight;
r.gl = new Proxy({}, {get: (_, name) => {
    if (/^[A-Z_0-9]+$/.test(name)) return name;
    if (name === 'pixelStorei') return (key, value) => {if (key === 'UNPACK_FLIP_Y_WEBGL') flipY = value;};
    if (name === 'texImage2D') return (...args) => {
        uploads++; gpuWidth=args[3]; gpuHeight=args[4]; gpuData=Float32Array.from(args[8]);
        assert.equal(flipY, false, 'world-grid uploads must not inherit the preceding sprite row flip');
    };
    return () => {};
}});
const platform = (modelKey, x, scaleY, y = 0) => ({modelKey, x, z:2.5, y, scaleY, pickSource:{}});
const platforms = [
    platform('barrack_norm', 1.5, .62), platform('spawner_healer_spawner', 2.5, .62),
    platform('tower_cloud_fire', 3.5, 1.05), platform('item_farm', 4.5, .72),
    platform('item_astar_farm', 5.5, .72), platform('gold_mine_active', 6.5, .35),
    platform('astar_mine_empty', 7.5, .35)
];
const snapshot = {worldWidth:20,worldHeight:20,objects:platforms};
r.updateWalkSurfaces(snapshot);
const expected = [.112*.62, .112*.62, .085*1.05, .425*.72, .425*.72, .31*.35, .31*.35];
platforms.forEach((p, i) => {
    const h = expected[i], x = p.x;
    assert.ok(Math.abs(r.walkSurfaceHeightAt(x, 2.5) - h) < 1e-8, p.modelKey + ' uses its floor height');
    assert.equal(r.walkSurfaceHeightAt(x - .5, 2.5), 0, 'edge meets the ground');
    assert.ok(Math.abs(r.walkSurfaceHeightAt(x - .41, 2.5) - h * .5) < 1e-8, 'smooth halfway ramp');
    assert.equal(r.walkSurfaceHeightAt(x - .3, 2.5), h, 'broad flat center');
    assert.ok(Math.abs(r.walkSurfaceHeightAt(x - .41, 2.5) - r.walkSurfaceHeightAt(x + .41, 2.5)) < 1e-8, 'symmetric descent');
    assert.ok(r.walkSurfaceHeightAt(x - .5 + 1e-5, 2.5) < h * 1e-7, 'no abrupt edge slope');
});
assert.equal(r.walkSurfaceHeightAt(-.5, 2.5), 0);
assert.equal(r.walkSurfaceHeightAt(20.5, 1.5), 0, 'outside coordinates cannot wrap into another row');
assert.equal(r.walkSurfaceObjectY({modelKey:'unit_norm',x:4.5,z:2.5,y:.012}), expected[3]);
assert.equal(r.walkSurfaceObjectY({modelKey:'unit_snake',x:4.5,z:2.5,y:.02}), expected[3]);
assert.equal(r.walkSurfaceObjectY({modelKey:'unit_norm',x:4.5,z:2.5,y:.5}), .5, 'never lower a unit already above the floor');
assert.equal(r.walkSurfaceObjectY({modelKey:'unit_flying',x:4.5,z:2.5,y:.2,isFlying:true}), .2, 'flyers keep their altitude');
assert.equal(r.walkSurfaceObjectY({modelKey:'unit_flying',x:4.5,z:2.5,y:.2,pickSource:{isFlying:true}}), .2, 'packed picking proxies preserve flight');
r.updateWalkSurfaces(snapshot);
assert.equal(uploads, 1, 'unchanged platforms do not upload each frame');
r.updateWalkSurfaces({...snapshot, objects:[platform('tower_fire', 1.5, 2), platform('item_house', 2.5, .82)]});
assert.equal(r.walkSurfaceHeightAt(1.5, 2.5), 0, 'tower is not walkable');
assert.equal(r.walkSurfaceHeightAt(2.5, 2.5), 0, 'house is not walkable');
assert.equal(r.walkSurfaceHeightAt(4.5, 2.5), 0, 'removed farms leave no stale height');
r.updateWalkSurfaces({...snapshot, objects:[],staticLayer:{objects:platforms}});
assert.equal(r.walkSurfaceHeightAt(4.5, 2.5), expected[3], 'cached structure layer contributes floors');
r.updateWalkSurfaces({...snapshot, objects:[{...platforms[3],pickSource:null}]});
assert.equal(r.walkSurfaceHeightAt(4.5, 2.5), 0, 'placement preview cannot lift units');
r.updateWalkSurfaces({...snapshot,flat2d:true});
assert.equal(r.walkSurfaceHeightAt(4.5, 2.5), 0, '2D remains flat');
// Multiple rows reproduce the real scene; a single-row fixture cannot reveal
// an inherited image flip. Include a remembered worker yard with no pick source.
const rows = [platforms[0], {...platforms[1],z:4.5,pickSource:null,historyGhost:true}, {...platforms[3],z:7.5}];
flipY = true;
r.updateWalkSurfaces({...snapshot,objects:rows});
for (const p of rows) {
    const [x0,z0] = r.walkSurfaceBounds;
    const at = (Math.floor(p.z)-z0)*gpuWidth + Math.floor(p.x)-x0;
    assert.ok(Math.abs(gpuData[at]-r.walkSurfaceHeightAt(p.x,p.z)) < 1e-7, 'GPU and CPU agree for '+p.modelKey);
}
assert.equal(gpuHeight, 6);
assert.equal(r.walkSurfaceHeightAt(2.5,4.5), expected[1], 'remembered worker deck is still walkable');
// Exercise the real scene-building paths too, not just hand-made map entries.
const renderer = fs.readFileSync(path.join(__dirname, '../src/audio_visual/renderer.js'),'utf8');
const scene = vm.createContext({
    objects:[], fullVisibility:true, flat2d:false, TILE:32, visibilityGrid:[],
    sBounds:{minGx:0,minGy:0,maxGx:19,maxGy:19},
    BASE_CARD_TYPES:{}, BASE_UNIT_STATS:{norm:{color:'#fff'}},
    VISIBILITY_LIGHT_NORMALIZATION_RANGE:1, DEFAULT_SHADOW_DIR_X:0, DEFAULT_SHADOW_DIR_Y:1,
    RENDER_NO_MODEL_CANDIDATES:[], renderer3dExactTextureFallback:false,
    resolveRenderVisionRange:()=>NaN, _getCachedLitTint:c=>c,
    _reuseStatic3DObject:()=>false, _rememberStatic3DObject:()=>{},
    _pushStructureActivity:()=>{}, _pushProductionGhost:()=>{},
    get3DExact2DTexture:()=>({}), get3DExact2DFloorTexture:()=>({}), get3DWorkshopSignTexture:()=>({}),
    get3DConstructionLift:()=>0, get3DConstructionAlpha:()=>1, get3DStructureModelHeight:()=>.62,
    get3DRenderOwnerColor:()=>'#fff', get3DDamageFlashTint:(_,c)=>c,
    getOverlapFadeForTile:()=>{throw Error('walkable structures must not flatten');}
});
const pushStart=renderer.indexOf('function push3DRenderObject(');
vm.runInContext(renderer.slice(pushStart,renderer.indexOf('function drawWithTrackedContextTransform(',pushStart)),scene);
for (const name of ['pushSpawner','pushBarrack','pushCellItem']) {
    const start=renderer.indexOf('    let '+name+' = ');
    const end=renderer.indexOf('\n    };',start)+7;
    vm.runInContext(renderer.slice(start,end)+'\nthis.'+name+'='+name+';',scene);
}
for (const [i,type] of ['spawner','astar_spawner','builder_spawner','healer_spawner','salvager','research'].entries()) {
    scene.pushSpawner({gx:i+1,gy:3,x:(i+1.5)*32,y:112,type,owner:0});
}
scene.pushBarrack({gx:1,gy:5,x:48,y:176,type:'barrack',unitType:'norm',owner:0});
scene.pushCellItem(2,5,{item:{type:'farm'},owner:0});
scene.pushCellItem(3,5,{item:{type:'astar_farm'},owner:0});
r.updateWalkSurfaces({...snapshot,objects:scene.objects});
for (const o of scene.objects) {
    assert.ok(r.walkSurfaceHeightAt(o.x,o.z)>0, 'live scene registers '+o.modelKey);
    assert.equal(o.overlapFadeKey,undefined,'low structure has no flatten state');
    const [x0,z0] = r.walkSurfaceBounds;
    const at = (Math.floor(o.z)-z0)*gpuWidth+Math.floor(o.x)-x0;
    assert.ok(Math.abs(gpuData[at]-r.walkSurfaceHeightAt(o.x,o.z))<1e-7,'uploaded height matches live '+o.modelKey);
}
console.log('PASS: low floors, smooth ramps, flat centers, flight, snake heads, cached layers, removal and preview exclusion.');
