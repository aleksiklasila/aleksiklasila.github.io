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
// The near list's entries (effects3d.js _fxNear: drawn on the GPU, renderer3d.js drawFxNear), as objects.
const nearEntries = () => { const N = c.batch.near, out = []; if (!N) return out; for (let i = 0; i < N.n; i++) { const o = i * 8, d = N.data; out.push({ x0: d[o], z0: d[o + 1], x1: d[o + 2], z1: d[o + 3], kind: d[o + 4], style: d[o + 5], q: d[o + 7] }); } return out; };
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

// A cast near the camera: an entry of the near list at its target (its rune and eruption the GPU's).
c.clearCombatFx();
c.recordUnitAttackFx(unit('fire_resistant', 'fire'), target);
frame();
const cast = nearEntries().find(e => e.kind === FX.CAST);
assert.ok(cast, 'a cast is listed for the GPU');
assert.equal(cast.x1, 6);
assert.equal(cast.z1, 5);
assert.ok(cast.q >= 0 && cast.q < 1, 'with its phase');
assert.equal(c.batch.total, 0, 'its shapes are not made on the page');

// Records expire after their duration and are released; a rewind (new
// game, resync) drops records from the future.
c.gameTime = 140;
frame();
assert.equal(c.batch.total + nearEntries().length, 0, 'expired effects draw nothing');
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
assert.equal(c.batch.total + nearEntries().length, 0, 'off-screen effects are culled');

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
assert.ok(nearEntries().some(e => e.kind === FX.SLASH), '2D slashes are listed (flattened by the GPU, uFlat)');

// Laser fences between connected turrets, brighter while burning.
const a = { type: 'laser', gx: 2, gy: 2, x: 2.5 * 32, y: 2.5 * 32, laserState: 1 };
const b = { type: 'laser', gx: 6, gy: 2, x: 6.5 * 32, y: 2.5 * 32, laserState: 1 };
a.connectedLasers = [b]; b.connectedLasers = [a];
c.clearCombatFx();
frame(false, [], [], [a, b]);
assert.equal(c.batch.count[M.BOX], 2, 'one burning fence: glow and core, drawn once per pair');

// A tilted close camera still sees a distant battle. Use depth at the attack,
// not the camera centre: far away each attack is the GPU's (renderer3d.js
// drawFxFar reads the ring the frame publishes as batch.far), none of its parts
// on the page; nothing in view near enough: the page reads no record at all.
c.clearCombatFx();
for (let i=0;i<100;i++) c.recordCombatFx(FX.CAST,5*32,5*32,6*32,5*32,'fire');
// (A perspective camera as renderer3d.js has it: pixels a world unit by depth along the view.)
const cam=(eye,fwd,scale=64)=>{const l=Math.hypot(...fwd),f=fwd.map(v=>v/l);return {lodPixelsPerWorld:scale/50,lodEye:eye,lodForward:f,lodProjectionScale:scale,
    pixelsPerWorldAt:(x,y,z)=>scale/Math.max(.1,(x-eye[0])*f[0]+(y-eye[1])*f[1]+(z-eye[2])*f[2])};};
c.beginFrameEffects(c.batch,false,bounds,[],64,cam([5,2,-100],[0,0,1]));
c.buildFrameEffects([],[],[]);c.endFrameEffects();
assert.equal(c.batch.total+nearEntries().length,0,'distant attacks: none drawn on the page, even in a close tilted view');
const far=c.batch.far;
assert.ok(far&&far.data===combatFxData&&far.cap===vm.runInContext('COMBAT_FX_CAPACITY',c)&&far.serial===vm.runInContext('combatFxSerial',c)&&far.head===vm.runInContext('combatFxHead',c),'the ring is handed to the GPU with its head and serial');
assert.equal(far.now,100,'on the drawn clock');
// (The ray hits nothing near: no record is read, none released or changed.)
assert.equal(kinds().length,100,'distant records stay for the GPU');
c.beginFrameEffects(c.batch,false,bounds,[],64,cam([40,2,40],[-1,0,-1]));
c.buildFrameEffects([],[],[]);c.endFrameEffects();
assert.equal(c.batch.total+nearEntries().length,0,'a view with near ground but the attacks far: still on the GPU');
c.beginFrameEffects(c.batch,false,bounds,[],64,cam([6,2,0],[0,0,1]));
c.buildFrameEffects([],[],[]);c.endFrameEffects();
assert.equal(nearEntries().length,100,'nearby spell effects: each listed for its shapes on the GPU');
assert.equal(c.batch.total,0,'none made on the page');

// A tower's volley beside the worker: its shots' muzzle flashes, flights and hits as entries.
c.clearCombatFx();
c.gameTime = 100;
vm.runInContext('simClientActive = () => true; pageUnitDrawnAt = () => false;', c);
c.recordCombatFx(FX.MUZZLE, 5 * 32, 5 * 32, 9 * 32, 5 * 32, 'pistol', -3, 0);
c.gameTime = 108;
frame();
const vk = nearEntries().map(e => e.kind);
assert.ok(vk.includes(13) && vk.includes(10), 'a volley lists its shots in flight and its muzzle flashes: ' + vk.join(','));
vm.runInContext('simClientActive = undefined; pageUnitDrawnAt = undefined;', c);
c.gameTime = 100;
console.log('PASS: role-specific attack effects, runes, expiry, culling, rewinds, lobbed shots, 2D flattening and laser fences.');

const alerts = vm.createContext({ gameTime: 100, tickAlpha: 0, TICK_RATE: 20, TILE: 32, mapAlerts: [] });
vm.runInContext(read('src/audio_visual/audio.js') + '\nmarkControlGroupsDamaged = () => {}; playSound = () => {};', alerts);
const available = new Set(vm.runInContext('_mapAlertSpare', alerts));
for (let i = 0; i < 40; i++) alerts.pushDamageAlert({ x: i, y: 12 }, 1);
assert.equal(alerts.mapAlerts.length, 40);
const suppressed = { get x() { throw new Error('suppressed hit looked up its position'); } };
alerts.pushDamageAlert(suppressed, 1);
alerts.pushDamageAlert({ isKing: true, x: 999, y: 12 }, 1);
assert.equal(alerts.mapAlerts[0].x, 1, 'a new king alert evicts the oldest alert');
assert.equal(alerts.mapAlerts[39].x, 999);
assert.ok(alerts.mapAlerts.every(a => available.has(a)), 'alerts use the reserved records');
alerts.gameTime = 250;
alerts.drawMinimapAlerts({}, 1);
assert.equal(alerts.mapAlerts.length, 0);
alerts.pushDamageAlert({ x: 5, y: 12 }, 1);
alerts.resetMapDamageAlerts();
assert.equal(vm.runInContext('_mapAlertSpareCount', alerts), 40, 'expiry and reset both return records');
console.log('PASS: capped damage alerts skip unused positions and reuse records after expiry and reset.');
