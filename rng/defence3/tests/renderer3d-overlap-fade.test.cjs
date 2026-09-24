const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../src/audio_visual/renderer.js'), 'utf8');
const start = source.indexOf('function push3DRenderObject(');
const end = source.indexOf('function drawWithTrackedContextTransform(', start);
const context = {
    renderer3dOverlapFadeState: new Map(), RENDERER3D_OVERLAP_FADE_DURATION_MS: 500,
    fullVisibility: true, visibilityGrid: [], VISIBILITY_LIGHT_NORMALIZATION_RANGE: 1,
    DEFAULT_SHADOW_DIR_X: 0, DEFAULT_SHADOW_DIR_Y: 1,
    resolveRenderVisionRange: () => NaN,
    _getCachedLitTint: color => color
};
vm.createContext(context);
vm.runInContext(source.slice(start, end), context);
const push = vm.runInContext('push3DRenderObject', context);

function height(modelKey, scaleY, nowMs, occupied, visionRange = NaN) {
    const target = [];
    push(target, {
        modelKey, x: 2.5, z: 3.5, scaleY, visibilityRangeTiles: visionRange,
        overlapFade: { gx: 2, gy: 3, occupied, nowMs, activeKeys: new Set() }
    });
    return target[0].scaleY;
}

assert.equal(height('tower_watch', 1, 1000, true, 10), 2);
const halfTower = height('tower_watch', 1, 1250, true, 10);
assert.ok(halfTower > 0.05 && halfTower < 2, 'tower descends gradually after overlap');
assert.equal(height('tower_watch', 1, 2000, true, 10), 0.05);
const risingTower = height('tower_watch', 1, 2250, false, 10);
assert.ok(risingTower > 0.05 && risingTower < 2, 'tower rises gradually after overlap');
assert.equal(height('tower_watch', 1, 3000, false, 10), 2);

assert.equal(height('gold_mine_active', 0.35, 1000, true), 0.35);
assert.ok(height('gold_mine_active', 0.35, 1250, true) > 0.05,
    'mines use the same gradual transition');
assert.equal(height('gold_mine_active', 0.35, 2000, true), 0.05);

console.log('PASS: towers and mines ease between full height and the occupied height limit.');
