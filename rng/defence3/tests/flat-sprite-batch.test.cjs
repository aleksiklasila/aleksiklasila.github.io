const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const read = p => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const renderer = read('src/audio_visual/renderer.js');
const slice = (from, to) => renderer.slice(renderer.indexOf(from), renderer.indexOf(to));

// Units write their sprite straight into the typed batch; panel and own
// light are looked up once per tick.
const c = vm.createContext({ window: {}, console, Math });
vm.runInContext(read('src/audio_visual/renderer3d.js'), c);
let panelLookups = 0;
const panelA = { _panelCtx: {}, _textureVersion: 1, _flatWorldSize: 1.5, _flatOffsetZ: -0.25 };
Object.assign(c, {
    gameTime: 10, fullVisibility: false, VISIBILITY_LIGHT_NORMALIZATION_RANGE: 8, renderer3dExactTextureFrame: 1,
    visibilityGrid: [[0, 0, 0], [0, 4, 8], [0, 0, 0]], ghostGrid: [[0, 0, 0], [0, 8, 0], [0, 0, 0]],
    getRenderVisibilityGrid: () => c.ghostGrid,
    getVisualUnitSourceLight: u => u.ownLight || 0,
    get3DExact2DTexture() { panelLookups++; return c.nextPanel; },
    renderer3dExactTextureFallback: false, nextPanel: panelA,
});
vm.runInContext(slice('function _touch3DPanel', 'function cache3DExact2DTexture'), c);
vm.runInContext(slice('let renderer3dFlatBatch = null;', 'const renderer3dFlatProjectileSprites'), c);
vm.runInContext('var batch = new window.Defence3Renderer3D.FlatSpriteBatch(2);', c);
const push = (u, x, z, view = 1) => vm.runInContext('batch', c) && c._pushFlatUnit(c.batch, u, x, z, view);

const unit = { id: 2, ownLight: 0 };
assert.equal(push(unit, 1.5, 1.5), true);
assert.deepEqual(Array.from(c.batch.data.slice(0, 10)), [1.5, 1.25, 1.5, 1.5, 0.5, 0.5, 0.5, 1, 0, 0],
    'center, label offset, panel footprint, lit by the grid');
assert.equal(c.batch.textures[0], panelA);
for (let frame = 0; frame < 5; frame++) push(unit, 2.5, 1.5);
assert.equal(panelLookups, 1, 'panel looked up once per tick, not per frame');
assert.equal(c.batch.data[c.batch.count * 10 - 10 + 4], 1, 'light follows the interpolated position');
assert.ok(c.batch.count > 2, 'batch grows past its initial capacity');

const glowing = { id: 4, ownLight: 6 };
push(glowing, 0.5, 0.5);
assert.equal(c.batch.data[c.batch.count * 10 - 10 + 4], 0.75, "a unit's own vision lights it in the dark");
const ghost = { id: 6, _historyGhost: true };
push(ghost, 1.5, 1.5);
assert.equal(Math.fround(0.65), c.batch.data[c.batch.count * 10 - 10 + 4], 'remembered units use the history light, dimmed');

// Next tick: an even id may reuse last tick's panel, an odd id may not.
c.gameTime = 11;
panelLookups = 0;
push({ id: 2 }, 1, 1); // new unit: lookup
push(unit, 1, 1);      // (2 + 11) & 1 = 1: one tick old is fine
assert.equal(panelLookups, 1);
c.gameTime = 12;
push(unit, 1, 1);      // two ticks old
assert.equal(panelLookups, 2);

// A recycled panel (new version) is replaced at once.
panelLookups = 0;
panelA._textureVersion++;
push(unit, 1, 1);
assert.equal(panelLookups, 1, 'recycled panel canvas refreshes the cached unit');
assert.equal(panelA._usedFrame, 1, 'cached panels stay marked as used');
c.nextPanel = null;
assert.equal(push({ id: 9 }, 1, 1), false, 'no exact panel: caller builds a scene object');

// Evicted panel canvases are redrawn for new signatures.
let created = 0;
const pc = vm.createContext({
    RENDERER3D_TOP_TEXTURE_SIZE: 96, TILE: 32, gameTime: 5, performance: { now: () => 0 },
    shouldShowBuildingLevels: () => false, shouldShowUnitLevels: () => false, get3DUnitStatusGlyph: () => null,
    drawUnitBodyGeometry() {}, get2DRenderOwnerColor: () => '#fff',
    document: { createElement() { created++; return { getContext() { return { setTransform() {}, clearRect() {}, save() {}, restore() {} }; } }; } }
});
vm.runInContext(slice('const renderer3dExact2DTextureCache', 'function get3DExact2DFloorTexture'), pc);
const entity = i => ({ x: 32, y: 32, r: 8, owner: 0, unitType: 'norm', color: 'c' + i, energy: 1, preComputed: { maxEnergy: 1 }, draw() {} });
const frame = list => {
    pc.begin3DTextureFrame();
    vm.runInContext('renderer3dExactUnitTextureBuildsRemaining = 1e9; renderer3dExactUnitTextureTimeRemaining = 1e9;', pc);
    return list.map(e => pc.get3DExact2DTexture(e, true));
};
const first = Array.from({ length: 1100 }, (_, i) => entity(i));
const firstPanels = frame(first);
for (let i = 0; i < 3; i++) frame(first.slice(0, 10));
assert.equal(vm.runInContext('renderer3dPanelPool.length', pc), 76, 'evicted canvases are pooled');
const createdBefore = created;
const recycled = frame([entity('new')])[0];
assert.equal(created, createdBefore, 'new panel reuses a pooled canvas');
const previousOwner = first[firstPanels.indexOf(recycled)];
assert.ok(previousOwner, 'the canvas belonged to an evicted panel');
assert.ok(recycled._textureVersion > 1100, 'redrawn canvas has a new version');
vm.runInContext('renderer3dExactUnitTextureBuildsRemaining = 0;', pc);
assert.notEqual(pc.get3DExact2DTexture(Object.assign(previousOwner, { energy: 0.5 }), true), recycled,
    "a recycled canvas is never shown as the previous owner's stand-in");

console.log('PASS: units write panel sprites straight into the batch (lookups once per tick, lit like scene objects); panel canvases are pooled and versioned.');
