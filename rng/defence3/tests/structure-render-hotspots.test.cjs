const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

let reads = 0;
const buildings = Array.from({length: 10000}, (_, i) => {
    const x = (i % 100) * 32 + 16;
    return {get x() { reads++; return x; }, y: Math.floor(i / 100) * 32 + 16, owner: 1, energy: 10};
});
const c = vm.createContext({TILE:32, GRID_W:100, GRID_H:100, gameTime:1, pathTopologyVersion:1,
    localPlayerId:0, getRawVisibilityGridForPlayer:()=>Array.from({length:100},()=>new Uint8Array(100).fill(1))});
const visibility = c.getRawVisibilityGridForPlayer();
c.getRawVisibilityGridForPlayer = () => visibility;
vm.runInContext(read('src/utils/utils_common.js'), c);
vm.runInContext(read('src/things/unit.js'), c);
const unit = {x:16,y:16,owner:0};
assert.equal(c._findClosestHostileStructure(unit, buildings, 64), buildings[0]);
reads = 0;
for (let i=0;i<1000;i++) assert.equal(c._findClosestHostileStructure(unit, buildings, 64), buildings[0]);
assert.ok(reads <= 64000, `nearby queries must not scan 10 million buildings: ${reads}`);
const queryReads = reads;
// Moving origins and changing owners/visibility must select exactly the same
// target as the ordered exhaustive scan, including strict range boundaries.
for (let i=0;i<1000;i++) {
    const moving={x:(i*173)%3200,y:(i*311)%3200,owner:i%3};
    const radius=32+(i%9)*29;
    let expected=null,best=radius;
    for(const b of buildings) {
        if(b.owner===moving.owner || b.energy<=0) continue;
        const d=Math.hypot(b.x-moving.x,b.y-moving.y);
        if(d<best){best=d;expected=b;}
    }
    assert.equal(c._findClosestHostileStructure(moving,buildings,radius),expected);
}
buildings[0].energy = 0;
assert.equal(c._findClosestHostileStructure(unit, buildings, 64), buildings[1], 'death and list-order ties are immediate');
const replacement = {x:16,y:16,owner:1,energy:10};
buildings[0] = replacement;
c.pathTopologyVersion++;
assert.equal(c._findClosestHostileStructure(unit, buildings, 64), replacement, 'same-length topology changes rebuild');
visibility[0][0] = 0;
assert.equal(c._findClosestHostileStructure(unit, buildings, 64), buildings[1], 'visibility is checked live');
visibility[0][0] = 1;
replacement.owner = 0;
assert.equal(c._findClosestHostileStructure(unit, buildings, 64), buildings[1], 'ownership is checked live');
c.gameTime++;
assert.equal(c._findClosestHostileStructure(unit, buildings, 64), buildings[1]);

const build = new Function('let camera={zoom:1};' + read('src/audio_visual/selection_overlay.js') + ';return buildSelectionContours;')();
const footprints = Array.from({length:1000},(_,i)=>({x:i%40*18,y:Math.floor(i/40)*18,radius:14,color:'#f00'}));
const original = build(footprints);
for (const p of footprints) p.x += .5;
assert.equal(build(footprints), original, 'large selections reuse subpixel geometry');
for (const p of footprints) p.x += .5;
assert.notEqual(build(footprints), original, 'motion is measured from last build, so cannot accumulate drift');
const moved = build(footprints);
footprints[0].color = '#0f0';
assert.notEqual(build(footprints), moved, 'style changes are immediate');
assert.equal(build([]).length, 0, 'deselection is immediate');

const renderer = read('src/audio_visual/renderer.js');
const signatures = new Function(`let RENDERER3D_TOP_TEXTURE_SIZE=128, gameTime=0;
    let shouldShowBuildingLevels=()=>false, shouldShowUnitLevels=()=>false;
    ${renderer.slice(renderer.indexOf('function quantize3DExactRatio'), renderer.indexOf('function get3DExact2DCapture'))}
    return {get3DExact2DVisualSignature, renderer3dVisualSignatures};`)();
const entity = {unitType:'norm',energy:10,preComputed:{maxEnergy:10}};
const key = signatures.get3DExact2DVisualSignature(entity, true);
const entry = signatures.renderer3dVisualSignatures.get(entity);
signatures.get3DExact2DVisualSignature(entity, true);
assert.equal(signatures.renderer3dVisualSignatures.get(entity),entry,'unchanged visuals reuse the key entry');
entity.energy = 5;
assert.notEqual(signatures.get3DExact2DVisualSignature(entity,true),key,'damage invalidates panel immediately');

let canvas;
const sprites = vm.createContext({camera:{zoom:.25},window:{devicePixelRatio:1},drawUnitBodyGeometry(){},
    document:{createElement(){return canvas={getContext:()=>({setTransform(){}})};}}});
const two = read('src/audio_visual/renderer2d.js');
vm.runInContext(two.slice(two.indexOf('const _unitBodySprites'),two.indexOf('function _drawAreaCoverageOverlay2D')),sprites);
sprites.drawCachedUnitBody({imageSmoothingEnabled:false,drawImage(){}},{unitType:'norm',vis:'circle',r:8,x:0,y:0,color:'#fff'},'#000',1);
assert.equal(canvas.width,8,'zoomed-out body uses 8px rather than 64px source');
console.log(`PASS: 1000 queries against 10000 buildings read ${queryReads} candidates; selection reuse, panel invalidation, and zoomed sprite resolution.`);
