const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const renderer = read('src/audio_visual/renderer.js');

// A deliberately straightforward reference retains the original scan's tie rule.
function referenceScan(unit, lists, range, visible) {
    let result = null;
    for (const list of lists) for (const target of list) {
        if (target.owner === unit.owner || target.energy <= 0 || !visible(unit.owner, target)) continue;
        const distance = Math.hypot(target.x - unit.x, target.y - unit.y);
        if (distance < range) { range = distance; result = target; }
    }
    return result;
}

let seed = 97;
function random(n) { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n; }
const grids = Array.from({ length: 3 }, () => Array.from({ length: 48 }, () => Float32Array.from({ length: 64 }, () => random(3))));
let lookups = [];
const ctx = {
    TILE: 32, GRID_W: 64, GRID_H: 48, localPlayerId: 0,
    getRawVisibilityGridForPlayer(owner) { lookups.push(owner); return grids[owner]; }
};
vm.createContext(ctx);
vm.runInContext(read('src/things/unit.js'), ctx);
function visible(owner, target) {
    const gx = Number.isFinite(target.gx) ? Math.floor(target.gx) : Math.floor((Number(target.x) || 0) / 32);
    const gy = Number.isFinite(target.gy) ? Math.floor(target.gy) : Math.floor((Number(target.y) || 0) / 32);
    if (gx < 0 || gx >= 64 || gy < 0 || gy >= 48) return false;
    return !!(grids[owner][gy] && grids[owner][gy][gx] > 0);
}
const buildings = Array.from({ length: 600 }, (_, id) => ({
    id, x: random(2048), y: random(1536), owner: random(3), energy: random(5), underConstruction: !!random(2)
}));
const lists = [buildings.slice(0, 300), buildings.slice(300)];
for (let i = 0; i < 1200; i++) {
    const unit = { x: random(2048), y: random(1536), owner: random(3) };
    const range = random(1000);
    lookups = [];
    assert.equal(ctx._findClosestHostileStructure(unit, lists[0], range, lists[1]), referenceScan(unit, lists, range, visible));
    assert.equal(lookups.length, 1, 'one raw-grid lookup for the whole scan');
}
grids[0].forEach(row => row.fill(1));
const origin = { x: 0, y: 0, owner: 0 };
const first = { x: 32, y: 0, owner: 1, energy: 1 };
const tied = { x: 0, y: 32, owner: 1, energy: 1 };
assert.equal(ctx._findClosestHostileStructure(origin, [first], 33, [tied]), first);
assert.equal(ctx._findClosestHostileStructure(origin, [first], 32), null, 'strict range boundary');
lookups = [];
assert.equal(ctx._findClosestHostileStructure(origin, [{ ...first, gx: -1 }], 99), null);
assert.equal(lookups.length, 0, 'out-of-map targets must not materialize a visibility snapshot');
ctx.getRawVisibilityGridForPlayer = owner => { lookups.push(owner); return grids[owner]; };
lookups = [];
ctx._findClosestHostileStructure(origin, [first], 1);
assert.equal(lookups.length, 1, 'even an out-of-range target retains the original lazy snapshot timing');
const Unit = vm.runInContext('Unit', ctx);
ctx._findClosestEnemyUnitByChunks = () => null;
ctx.towers = [first]; ctx.barracks = [{ ...tied, x: 1, y: 0 }]; ctx.collectorSpawners = [];
for (const method of ['doIdle', 'doAttackMoving']) {
    const attacker = Object.assign(Object.create(Unit.prototype), origin, { unitType: 'norm', preComputed: { visionRange: 4 } });
    attacker[method](1);
    assert.equal(attacker.targetBuilding, first, 'towers retain priority over closer barracks');
    first.energy = 0;
    attacker[method](1);
    assert.equal(attacker.targetBuilding, ctx.barracks[0], 'same-tick destruction is observed immediately');
    first.energy = 1;
}

// Scratch storage must not leak reveal coverage between teams, ticks or maps.
const visCtx = {
    GRID_W: 8, GRID_H: 8, TILE: 32, AREA_UNIT_TILE_EQUIVALENT: 1,
    units: [], towers: [], barracks: [], collectorSpawners: [],
    grid: Array.from({ length: 8 }, () => Array.from({ length: 8 }, () => ({}))),
    getAreaIdAtWorld: () => -1,
    getEntityVisibilityRangeArea: b => b.range,
    getGridCellsWithinAreaDistance: () => []
};
vm.createContext(visCtx);
vm.runInContext('let visibilityIncludedTilesScratch = [];\n' + renderer.slice(renderer.indexOf('function computeVisibilityGridForPlayer('), renderer.indexOf('function getVisibilityGridForPlayer(')), visCtx);
const makeGrid = () => Array.from({ length: visCtx.GRID_H }, () => new Float32Array(visCtx.GRID_W));
const unit = { x: 3 * 32, y: 3 * 32, owner: 0, preComputed: { visionRangeArea: 2 } };
visCtx.units.push(unit);
let a = makeGrid();
visCtx.computeVisibilityGridForPlayer(0, a);
assert.equal(a[3][3], 2);
assert.equal(a[3][2], 1);
assert.equal(a[2][2], 1);
let b = makeGrid();
visCtx.computeVisibilityGridForPlayer(1, b);
assert.ok(b.every(row => row.every(value => value === 0)));
assert.equal(a[3][3], 2, 'another team cannot mutate the previous result');
unit.watched = 10; unit.watchedByTeam = 1;
visCtx.computeVisibilityGridForPlayer(1, b);
assert.deepEqual(b, a, 'team watch shares exactly the same source coverage');
unit.dead = true;
visCtx.computeVisibilityGridForPlayer(0, a);
assert.ok(a.every(row => row.every(value => value === 0)), 'dead sources leave no stale coverage');
visCtx.GRID_W = 5; visCtx.GRID_H = 3;
visCtx.grid = Array.from({ length: 3 }, () => Array.from({ length: 5 }, () => ({})));
visCtx.computeVisibilityGridForPlayer(0, makeGrid());

// Observe draw calls, including captured transforms/compositing and layer replay.
const draws = [];
function canvasContext(name) {
    return {
        name, globalAlpha: 1, globalCompositeOperation: 'source-over', imageSmoothingEnabled: false, filter: 'none',
        transform: [1, 0, 0, 1, 0, 0], stack: [],
        save() { this.stack.push([this.globalAlpha, this.globalCompositeOperation, this.imageSmoothingEnabled, this.filter, this.transform]); },
        restore() { [this.globalAlpha, this.globalCompositeOperation, this.imageSmoothingEnabled, this.filter, this.transform] = this.stack.pop(); },
        setTransform(...args) { this.transform = args; },
        getTransform() { const [a,b,c,d,e,f] = this.transform; return { a,b,c,d,e,f }; },
        drawImage(image, ...args) { draws.push({ name, image: image.id, args, alpha: this.globalAlpha, transform: [...this.transform], comp: this.globalCompositeOperation, filter: this.filter }); }
    };
}
const layer = canvasContext('layer');
const queueCtx = { renderer3dLayerContexts: new Map([[300, layer]]), renderer3dLayerStats: new Map([[300, { commandCount: 0 }]]) };
vm.createContext(queueCtx);
vm.runInContext(renderer.slice(renderer.indexOf('let _frameDrawImageQueueActive'), renderer.indexOf('function ensureRenderer3DLayerCanvas')), queueCtx);
const c = canvasContext('main'), images = [{ id: 0 }, { id: 1 }];
const commands = [];
queueCtx.beginFrameDrawImageQueue();
for (let i = 0; i < 1200; i++) {
    const z = [200, 300, 400][random(3)], image = images[random(2)];
    c.globalAlpha = (random(8) + 1) / 8;
    c.globalCompositeOperation = i % 2 ? 'source-over' : 'lighter';
    c.filter = i % 5 ? 'none' : 'blur(1px)';
    queueCtx._setDrawImageTrackedTransform(c, 2, 0, 0, 2, i, -i);
    queueCtx.setFrameDrawImageDepth(z);
    const args = i % 3 === 0 ? [i, 0] : i % 3 === 1 ? [i, 0, 32, 32] : [0, 0, 16, 16, i, 0, 32, 32];
    queueCtx.queueDrawImage(c, image, ...args);
    commands.push({ z, name: 'main', image: image.id, args, alpha: c.globalAlpha, transform: [...c.transform], comp: c.globalCompositeOperation, filter: c.filter });
}
queueCtx.flushFrameDrawImageQueue();
const expected = [];
for (const z of [400, 300, 200]) {
    const atDepth = commands.filter(cmd => cmd.z === z);
    for (const image of new Set(atDepth.map(cmd => cmd.image))) {
        for (const { z: unused, ...cmd } of atDepth.filter(cmd => cmd.image === image)) {
            expected.push(cmd);
            if (z === 300) expected.push({ ...cmd, name: 'layer' });
        }
    }
}
assert.deepEqual(draws, expected, 'sprite batching must preserve exact draw order and captured state');
queueCtx.beginFrameDrawImageQueue(); queueCtx.flushFrameDrawImageQueue();
assert.equal(draws.length, expected.length, 'empty next frame cannot replay stale commands');
queueCtx.queueDrawImage(c, images[0], 1, 2);
assert.equal(draws.length, expected.length + 1, 'non-queued calls remain immediate');

// Exercise the real 3D render loop with a recording GL implementation.
const threeCtx = { window: {} };
vm.runInNewContext(read('src/audio_visual/renderer3d.js'), threeCtx);
const r = Object.create(threeCtx.window.Defence3Renderer3D.prototype);
r.enabled = r.supported = true;
r.gl = new Proxy({}, { get: () => () => {} });
for (const method of ['resize', 'buildViewProjection', 'drawBackground', 'resolveScene', 'presentSceneToCanvas']) r[method] = () => {};
r.overlayDepthCache = new Map(); r.topTextureCache = new Map();
r.tmpInverseViewProjection = new Float32Array(16);
r.figureMeshes = new Map();
const mesh = { vao: {}, indexCount: 36 };
r.requestModel = object => object.modelKey === 'custom' ? mesh : null;
r.getPrimitiveMesh = () => mesh;
r.tmpModel = new Float32Array(16); r.tmpNormal = new Float32Array(9);
r.instancedMeshUniforms = {}; r.meshUniforms = {};
r.cubeInstanceCapacity = 2048; r.cubeInstanceArray = new Float32Array(2048 * 26);
r.getTopTexture = () => ({});
let shadowComputations = 0, shadowInstances = 0, colorInstances = 0;
const originalShadow = r.getShadowInfo;
r.getShadowInfo = object => { shadowComputations++; return originalShadow.call(r, object); };
const originalDrawShadows = r.drawShadows;
r.drawShadows = (meshes, groups) => {
    shadowInstances += meshes.length;
    for (const group of groups.values()) for (const shadow of group) {
        assert.ok(shadow.scaleX > 0 && shadow.alpha > 0);
        shadowInstances++;
    }
    originalDrawShadows.call(r, meshes, groups);
};
r.drawObject = () => { colorInstances++; };
r.drawTexturedCubeInstances = objects => { colorInstances += objects.length; };
r.drawCubeInstances = objects => { colorInstances += objects.length; };
const objects = Array.from({ length: 1400 }, (_, i) => ({
    modelKey: i === 0 ? 'custom' : i < 1000 ? 'unit_norm' : 'tower_smg', x: i % 40, z: Math.floor(i / 40),
    scaleX: 1, scaleY: 1, scaleZ: 1, lightLevel: 1, alpha: 1, topTextureKey: 'status', topTextureCanvas: {}
}));
r.render({ objects, camera: {}, viewportWidth: 800, viewportHeight: 600 });
assert.equal(shadowComputations, objects.length);
assert.equal(shadowInstances, objects.length);
assert.equal(colorInstances, objects.length);
r.sceneTargetSize = { width: 800, height: 600 };
r.captureOverlayDepthFrame();
const depthBytes = r.overlayDepthFrame.bytes;
r.render({ objects: [], camera: {}, viewportWidth: 800, viewportHeight: 600 });
assert.equal(r.overlayDepthFrame, null, 'previous frame depth must remain invalid until recaptured');
r.captureOverlayDepthFrame();
assert.equal(r.overlayDepthFrame.bytes, depthBytes, 'reuse readback storage across frames');
r.sceneTargetSize = { width: 400, height: 600 };
r.captureOverlayDepthFrame();
assert.equal(r.overlayDepthFrame.bytes.length, 400 * 600 * 4);
assert.notEqual(r.overlayDepthFrame.bytes, depthBytes, 'resize replaces incompatible storage');
const build = renderer.slice(renderer.indexOf('function build3DFrameData'), renderer.indexOf('\nfunction ', renderer.indexOf('function build3DFrameData') + 20));
assert.doesNotMatch(build, /get3DSideAudioTextureFor|getAudioReactiveSideTextureAngle/, 'procedural frame construction must not rasterize unused side textures');
console.log('PASS: 1200 target scans, visibility lifecycle, 1200 sprite replays and 1400 shadow instances preserve behavior.');
