const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const context = { window: {} };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/audio_visual/renderer3d.js'), 'utf8'), context);
const picker = Object.create(context.window.Defence3Renderer3D.prototype);
picker.cssWidth = picker.cssHeight = 100;
picker.pickInverseViewProjection = [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1];
const mesh = { positions: [-.5,0,0, .5,0,0, 0,1,0], indices: [0,1,2], bounds: [-.5,0,0,.5,1,0] };
function object(source, extra = {}, shape = mesh) {
    return { object: { pickSource: source, x: 0, y: 0, z: 0, scaleX: 1, scaleY: 1, scaleZ: 1, rotationY: 0, ...extra }, mesh: shape };
}
const unit = {}, building = {};
const candidates = new Map([[unit, {}], [building, {}]]);
const pick = (x, y) => picker.pickRenderedSource(x, y, candidates);
picker.pickObjects = [object(unit)];
assert.equal(pick(50, 10), unit, 'head hits the triangle');
assert.equal(pick(72, 10), null, 'empty corner inside bounding box must miss');
picker.pickObjects = [object(building, { scaleY: .2 })];
assert.equal(pick(50, 10), null, 'squashed building cannot intercept clicks at its old height');
assert.equal(pick(50, 45), building, 'flattened surface remains selectable');
picker.pickObjects = [object(building, { z: .3 }), object(unit, { z: -.3 })];
assert.equal(pick(50, 30), unit, 'nearest surface wins regardless of candidate order');
picker.pickObjects.reverse();
assert.equal(pick(50, 30), unit);
picker.pickObjects = [object(unit, { x: -.5 }), object(building, { x: .5 })];
assert.equal(pick(25, 30), unit);
assert.equal(pick(75, 30), building);
const animatedMesh = { ...mesh, details: [0,0,0,0, 0,0,0,0, 0,0,0,0] };
picker.pickObjects = [object(unit, { animationMode: 5, walkPhase: 0 }, animatedMesh)];
assert.equal(pick(50, 0), unit, 'animated vertices follow the shader pose');
picker.pickObjects = [object(unit, { z: 2 })];
assert.equal(pick(50, 30), null, 'beyond far clip plane is excluded');
const panelMesh = { ...mesh, details: [4,0,0,0, 4,0,0,0, 4,0,0,0], uvs: [0,0,1,0,.5,1] };
let alpha = 0;
const canvas = { width: 1, height: 1, getContext: () => ({ getImageData: () => ({ width: 1, height: 1, data: [255,255,255,alpha] }) }) };
picker.pickObjects = [object(unit, { topTextureCanvas: canvas }, panelMesh)];
assert.equal(pick(50, 30), null, 'transparent panel pixels are not clickable');
alpha = 255;
assert.equal(pick(50, 30), unit, 'opaque panel pixels are clickable');

// Box selection tests the drawn mesh on screen, not its ground point.
picker.pickViewProjection = [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1];
const box = (x0, y0, x1, y1) => [...picker.boxRenderedSources(x0, y0, x1, y1)];
picker.pickObjects = [object(unit)];
assert.deepEqual(box(45, 5, 55, 15), [unit], 'a box over only the head (above the ground point) selects');
assert.deepEqual(box(70, 5, 80, 15), [], 'a box in the empty corner of the bounds misses');
assert.deepEqual(box(0, 0, 100, 100), [unit], 'an enclosing box selects');
picker.pickObjects = [object(building, { scaleY: .2 })];
assert.deepEqual(box(45, 5, 55, 15), [], 'a squashed building is not caught at its old height');
assert.deepEqual(box(45, 42, 55, 48), [building]);
picker.pickObjects = [object(unit, { x: -.5 }), object(building, { x: .5 })];
assert.deepEqual(box(60, 20, 90, 40), [building], 'only the object under the box');
console.log('PASS: mesh picking covers heads, silhouette gaps, squashing, depth, adjacent targets, animation and clipping; box selection follows the drawn mesh.');

// Click candidates are a Map from main.js; drag selection supplies a Set.
const distantUnit = { _s: 0 }, distantBuilding = { _s: 0, _structView: true };
const distantCandidates = new Map([[distantUnit, {}], [distantBuilding, {}]]);
picker.tmpViewProjection = picker.pickViewProjection;
picker.viewPad = picker.pickViewPad = 7;
picker.pixelsPerWorldAt = () => 10;
picker.scaleLayers = [];
picker.columnLayers = {
    units: { x: [-.2], y: [0], px: [-.6], py: [0], r: [.2], flags: [0] },
    structures: { x: [.5], y: [0] },
    unitSources: [distantUnit], structureSources: [distantBuilding],
    tile: 1, alpha: .5, fullVisibility: true,
    detailMask: new Uint8Array(1), detailMaskS: new Uint8Array(1),
};
const clickDistant = (x, y = 42) => picker.pickRenderedSource(x, y, distantCandidates);
assert.equal(clickDistant(23), distantUnit, 'single click selects an interpolated distant sprite unit');
assert.equal(clickDistant(68), distantBuilding, 'single click selects a distant sprite building');
assert.equal(clickDistant(90), null, 'empty space remains unselectable');
assert.deepEqual([...picker.boxRenderedSources(20, 40, 26, 44, new Set([distantUnit]))], [distantUnit]);

// A detailed scene can still contain distant sprites outside its mesh list.
picker.scaleLayers = null;
picker.pickObjects = [object(unit)];
assert.equal(clickDistant(23), distantUnit, 'mixed scene includes distant unit sprites');
assert.equal(clickDistant(68), distantBuilding, 'mixed scene includes distant building sprites');
picker.pickObjects = [object(unit, { x: -.4, y: -.2 })];
distantCandidates.set(unit, {});
assert.equal(clickDistant(23), unit, 'precise nearby mesh hits take priority over sprite fallback');
distantCandidates.delete(unit);
picker.pickObjects = [];
picker.columnLayers.detailMask[0] = 255;
assert.equal(clickDistant(23), null, 'fully detailed units keep precise mesh picking');
picker.columnLayers.detailMask[0] = 128;
assert.equal(clickDistant(23), distantUnit, 'partly blended sprites remain clickable');
picker.columnLayers.detailMaskS[0] = 255;
assert.equal(clickDistant(68), null, 'fully detailed buildings keep precise mesh picking');
picker.columnLayers.units.flags[0] = 1024;
assert.equal(clickDistant(23), null, 'hidden units are excluded');
picker.columnLayers.units.flags[0] = 0;
distantUnit.dead = true;
assert.equal(clickDistant(23), null, 'dead units are excluded');
delete distantUnit.dead;
picker.columnLayers.fullVisibility = false;
picker.columnLayers.visibility = [];
assert.equal(clickDistant(23), null, 'units outside visibility are excluded');

// Legacy packed layers also accept click Maps, including later layers.
picker.columnLayers = null;
picker.scaleLayers = [distantUnit, distantBuilding].map((source, i) => ({
    sources: [source], alpha: 1,
    data: [i ? .5 : -.4, 0, 0, 0, .4, .04, 0, 0, 0, 0, 0, 0],
}));
assert.equal(clickDistant(23), distantUnit);
assert.equal(clickDistant(68), distantBuilding);
console.log('PASS: distant units and buildings support single clicks in sprite-only and mixed detail scenes.');
