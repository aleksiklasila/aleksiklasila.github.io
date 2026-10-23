const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

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
    return {get3DExact2DVisualSignature};`)();
const entity = {unitType:'norm',energy:10,preComputed:{maxEnergy:10}};
const key = signatures.get3DExact2DVisualSignature(entity, true);
const entry = entity._r3dSig;
signatures.get3DExact2DVisualSignature(entity, true);
assert.equal(entity._r3dSig,entry,'unchanged visuals reuse the key entry');
entity.energy = 5;
assert.notEqual(signatures.get3DExact2DVisualSignature(entity,true),key,'damage invalidates panel immediately');

let canvas;
const sprites = vm.createContext({camera:{zoom:.25},window:{devicePixelRatio:1},drawUnitBodyGeometry(){},
    document:{createElement(){return canvas={getContext:()=>({setTransform(){}})};}}});
const two = read('src/audio_visual/renderer2d.js');
vm.runInContext(two.slice(two.indexOf('const _unitBodySprites'),two.indexOf('function _drawAreaCoverageOverlay2D')),sprites);
sprites.drawCachedUnitBody({imageSmoothingEnabled:false,drawImage(){}},{unitType:'norm',vis:'circle',r:8,x:0,y:0,color:'#fff'},'#000',1);
assert.equal(canvas.width,8,'zoomed-out body uses 8px rather than 64px source');
console.log('PASS: selection reuse, panel invalidation, and zoomed sprite resolution.');
