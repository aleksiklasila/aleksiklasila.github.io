// Gameplay state survives snapshots exactly; local visual state (unit
// history, particles, visual RNG, render caches) stays client-side.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const H = require('./net-harness.cjs');
// The snapshot codec on the simulation's own objects: the page runs it here.
process.env.SIM_WORKER = '0';
const read = p => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

(async () => {
    const world = new H.World({ network: { latencyMs: 20, jitterMs: 0 }, controls: H.SMALL_MATCH_CONTROLS });
    const { host, guests } = await H.startHostedMatch(world, { guests: 1 });
    const guest = guests[0];

    // A projectile in flight (the pool's, projectile.js), restored on the
    // guest from the host's snapshot.
    host.eval(`(() => {
        const src = towers[0] || barracks[0] || collectorSpawners[0];
        projectileFire(40, 16 + 32 * 3, { x: 400, y: 16 + 32 * 3 }, 'arrow', 7, 1, src, 300);
        projectilesAdvance();
    })()`);
    guest.scratch.text = host.eval('JSON.stringify(snapEncodeState())');
    for (const k of ['prevX', 'prevY', '_spatialKey', 'textCanvas', '_damageFlashUntil', '_historyGhost']) assert.ok(host.eval(`SNAP_SKIP_KEYS.has(${JSON.stringify(k)})`), k + ' stays local');
    guest.eval('snapDecodeState(JSON.parse(__scratch.text))');
    const restored = JSON.parse(guest.eval(`(() => { const r = projSnapshotRecords(), p = r[r.length - 1], s = _pj.live[_pj.hdr[0] - 1]; return JSON.stringify({ n: r.length, dmg: p.dmg, px: _pj.a.px[s] === _pj.a.x[s], py: _pj.a.py[s] === _pj.a.y[s] }); })()`));
    assert.deepEqual(restored, { n: host.eval('projCount()'), dmg: 7, px: true, py: true });
    assert.equal(guest.eval('projHash()'), host.eval('projHash()'));

    // Exact movement and expiry after the round trip.
    const step = inst => inst.eval(`(() => { projectilesAdvance(); return JSON.stringify(projSnapshotRecords()); })()`);
    for (let tick = 0; tick < 45; tick++) assert.equal(step(guest), step(host), 'projectile step ' + tick);
    assert.equal(guest.eval('projCount()'), 0, 'the shot ran out of range');

    // Units keep every gameplay field; spatial bookkeeping is rebuilt.
    const unitFields = inst => inst.eval(`(() => { const u = units.find(u => !u.dead); return JSON.stringify([u.id, u.energy, u.x, u.y, u.unitType, u.owner, typeof u._spatialKey]); })()`);
    assert.equal(unitFields(guest), unitFields(host));

    const net = read('src/utils/utils_networking.js');
    const snap = read('src/utils/utils_snapshot.js');
    assert.ok(![net, snap].some(s => s.includes('snakeHistory')), 'snakes keep no tail samples to preserve across resyncs');
    const applyWhole = net.slice(net.indexOf('function applyAuthoritativeStateSnapshot('), net.indexOf('\nfunction ', net.indexOf('function applyAuthoritativeStateSnapshot(') + 1));
    assert.ok(!applyWhole.includes('visibilityHistoryState = null'));
    assert.ok(!applyWhole.includes('particles = []'));
    assert.ok(![net, snap].some(s => s.includes('visualRngState')));
    const particle = vm.createContext({ visualRng: null, rng: () => { throw Error('visuals consumed gameplay RNG'); } });
    vm.runInContext(read('src/things/particle.js') + '\nnew Particle(0,0,"red");', particle);
    for (const i of [host, guest]) assert.deepEqual(i.errors, [], i.name + ' threw');
    console.log('PASS: gameplay projectiles and units survive snapshots; local history, particles and visual RNG stay client-side.');
    process.exit(0);
})().catch(err => { console.error(err); process.exit(1); });
