const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const read = p => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

// Visual combat records (particle.js) become GPU effect instances
// (effects3d.js) in the renderer's typed batch (renderer3d.js).
const c = vm.createContext({ window: {}, console, Math, gameTime: 100, tickAlpha: 0, TICK_RATE: 20, TILE: 32,
    fullVisibility: true, visualRng: null, particles: [], BASE_CARD_TYPES: {} });
vm.runInContext(read('src/audio_visual/renderer3d.js'), c);
vm.runInContext(read('src/things/particle.js'), c);
vm.runInContext(read('src/audio_visual/effects3d.js'), c);
vm.runInContext('var batch = new window.Defence3Renderer3D.FxBatch();', c);
const M = vm.runInContext('window.Defence3Renderer3D.FX_MESH', c);
const P = vm.runInContext('window.Defence3Renderer3D.FX_PATTERN', c);
const bounds = { minGx: 0, minGy: 0, maxGx: 40, maxGy: 40 };
const frame = (flat = false, projectiles = [], particles = [], towers = []) => {
    c.beginFrameEffects(c.batch, flat, bounds, [], 32);
    c.buildFrameEffects(projectiles, particles, towers);
    c.endFrameEffects();
    return c.batch;
};
// Script-level consts are not context properties.
const combatFxData = vm.runInContext('combatFxData', c), STRIDE = vm.runInContext('COMBAT_FX_STRIDE', c);
const kinds = () => { const out = []; for (let o = 0; o < combatFxData.length; o += STRIDE) if (combatFxData[o]) out.push(combatFxData[o]); return out; };
// Instances of one mesh, as objects.
const instances = (mesh) => {
    const out = [], d = c.batch.data[mesh];
    for (let i = 0; i < c.batch.count[mesh]; i++) {
        const o = i * 16;
        out.push({ x: d[o], y: d[o + 1], z: d[o + 2], pattern: d[o + 12] });
    }
    return out;
};

// Roles map to their own effect; related roles share one.
const unit = (unitType, attackStyle) => ({ unitType, attackStyle, x: 5 * 32, y: 5 * 32 });
const target = { x: 6 * 32, y: 5 * 32 };
const FX = vm.runInContext('COMBAT_FX', c);
const cases = [['norm', 'melee', FX.SLASH], ['fast', 'melee', FX.DUAL], ['tank', 'melee', FX.SMASH], ['boss', 'melee', FX.SMASH],
    ['king', 'melee', FX.CLEAVE], ['fire_resistant', 'fire', FX.CAST], ['ice_resistant', 'ice', FX.CAST],
    ['laser_resistant', 'laser', FX.BEAM], ['flying', 'swoop', FX.SWOOP], ['scout', 'swoop', FX.SCOUT],
    ['snake', 'ram', FX.SPIT], ['mole', undefined, FX.DIG]];
for (const [type, style, kind] of cases) {
    c.clearCombatFx();
    c.recordUnitAttackFx(unit(type, style), target);
    assert.deepEqual(kinds(), [kind], `${type} attacks with its own effect`);
}

// A cast marks the target with a rune circle on the ground.
c.clearCombatFx();
c.recordUnitAttackFx(unit('fire_resistant', 'fire'), target);
frame();
const rune = instances(M.DECAL).find(i => i.pattern === P.RUNE);
assert.ok(rune, 'cast draws a rune');
assert.equal(rune.x, 6);
assert.equal(rune.z, 5);
assert.ok(rune.y < .05, 'the rune lies on the ground');

// Records expire after their duration and are released; a rewind (new
// game, resync) drops records from the future.
c.gameTime = 140;
frame();
assert.equal(c.batch.total, 0, 'expired effects draw nothing');
assert.deepEqual(kinds(), [], 'expired records are released');
c.recordUnitAttackFx(unit('norm', 'melee'), target);
c.gameTime = 10;
frame();
assert.deepEqual(kinds(), [], 'a rewind clears pending records');

// Culling: an attack far outside the view adds no instances.
c.gameTime = 100;
frame();
c.recordCombatFx(FX.SLASH, 900 * 32, 900 * 32, 901 * 32, 900 * 32, 'default');
frame();
assert.equal(c.batch.total, 0, 'off-screen effects are culled');

// Lobbed shots arc (highest mid-flight, with a ground shadow); tracers fly flat.
const shot = (type, traveled) => ({ type, startX: 2 * 32, startY: 10 * 32, x: (2 + traveled) * 32, y: 10 * 32,
    prevX: (2 + traveled) * 32, prevY: 10 * 32, vx: 8, vy: 0, aimDist: 8 * 32 });
const heightOf = (type, traveled) => {
    frame(false, [shot(type, traveled)]);
    const mesh = type === 'fire' ? M.ORB : M.BOX;
    return instances(mesh)[0].y;
};
assert.ok(heightOf('fire', 4) > heightOf('fire', .2) + .5, 'fireballs are lobbed');
assert.ok(heightOf('fire', 4) > heightOf('fire', 7.8), 'and come down on the target');
assert.ok(Math.abs(heightOf('smg', 4) - heightOf('smg', 7.8)) < .5, 'tracers stay low and flat');
frame(false, [shot('fire', 4)]);
assert.ok(instances(M.DECAL).some(i => i.pattern === P.SHADOW), 'airborne shots cast a ground shadow');

// The 2D view draws the same effects, flattening resting heights so only
// arcs and hops lift shapes up the screen.
c.clearCombatFx();
c.recordUnitAttackFx(unit('norm', 'melee'), target);
frame(true);
const slash = instances(M.DECAL).find(i => i.pattern === P.CRESCENT);
assert.ok(slash && slash.y < .1, '2D slashes lie flat');

// Laser fences between connected turrets, brighter while burning.
const a = { type: 'laser', gx: 2, gy: 2, x: 2.5 * 32, y: 2.5 * 32, laserState: 1 };
const b = { type: 'laser', gx: 6, gy: 2, x: 6.5 * 32, y: 2.5 * 32, laserState: 1 };
a.connectedLasers = [b]; b.connectedLasers = [a];
c.clearCombatFx();
frame(false, [], [], [a, b]);
assert.equal(c.batch.count[M.BOX], 2, 'one burning fence: glow and core, drawn once per pair');

console.log('PASS: role-specific attack effects, runes, expiry, culling, rewinds, lobbed shots, 2D flattening and laser fences.');
