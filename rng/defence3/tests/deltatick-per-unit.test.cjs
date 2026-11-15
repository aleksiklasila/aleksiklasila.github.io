// Steps of several base ticks (simDk): each unit's own rates are its dk 1 rates, judged per unit, not as averages
// over a crowd (user, 2026-11-14: about 1.0 at any dk, never faster). A lone walker covers the same ground a base
// tick (on open ground and on a map with walls to turn around), arrives and stops on its destination, and a lone
// attacker deals the same damage a base tick.
// node tests/deltatick-per-unit.test.cjs [--sizes=1,2,4,8,16] [--maps=arena,random] [--speed-tol=0.03] [--dmg-tol=0.05]
const assert = require('node:assert/strict');
const H = require('./net-harness.cjs');

const arg = (k, d) => (process.argv.find(a => a.startsWith('--' + k + '=')) || '').split('=')[1] || d;
const sizes = arg('sizes', '1,2,4,8,16').split(',').map(Number);
const maps = arg('maps', 'arena,random').split(',');
// (The walkers: unit types, each alone; workers walk on a move order as a manual move.)
const types = arg('types', 'norm,fast').split(',');
const SPEED_TOL = Number(arg('speed-tol', '0.03')), DMG_TOL = Number(arg('dmg-tol', '0.05'));
// (Base ticks: the walk measured, short of the walker's arrival; the fight measured.)
const WALK = 96, HIT = 240;

async function run(K, map) {
    const controls = { ...H.SMALL_MATCH_CONTROLS, 'cfg-mapsize': '48', 'cfg-map-type': map, 'cfg-max-pop': '5000', 'cfg-full-vis': 'all' };
    const world = new H.World({ simWorker: true, controls });
    const inst = world.spawn('solo', { controls });
    inst.eval(`netStepTicks = () => ${K};`);
    inst.eval(`startingResourcesConfig = ${JSON.stringify({ spawnCounts: { 'unit:king': { 1: 1 }, 'unit:norm': { 1: 1 }, ...Object.fromEntries(types.map(t => ['unit:' + t, { 1: 1 }])) }, researchLevels: {} })}; startSoloGame();`);
    await world.run(1500);
    assert.equal(inst.eval('gameStarted && simClientActive()'), true, 'solo match on the worker');
    const errors = () => inst.errors.map(e => String(e.stack || e).slice(0, 300));
    const me = Number(inst.eval('localPlayerId'));
    const gt = () => Number(inst.evalSim('gameTime'));

    // ---- each walker alone: ordered across the map along its own row ----
    const res = { K, map, walk: {}, dmg: NaN };
    for (const type of types) {
        const w = JSON.parse(inst.evalSim(`JSON.stringify((() => {
            const u = units.find(v => !v.dead && v.owner === ${me} && v.unitType === '${type}');
            const tx = (u.x < GRID_W * TILE / 2 ? 0.92 : 0.08) * GRID_W * TILE;
            return { id: u.id, x: u.x, y: u.y, tx };
        })())`));
        inst.eval(`queueAction({ action: 'move', unitIds: [${w.id}], targetX: ${w.tx}, targetY: ${w.y} })`);
        const pos = () => JSON.parse(inst.evalSim(`JSON.stringify((() => { const u = units.find(v => v.id === ${w.id}); return { g: gameTime, x: u.x, y: u.y }; })())`));
        // (From a few steps after it set off: the order's latency is not the rate.)
        await world.runUntil(() => Math.hypot(pos().x - w.x, pos().y - w.y) > 0.5, 4000, 10);
        const g = gt(); await world.runUntil(() => gt() >= g + 16, 4000, 10);
        const a = pos();
        await world.runUntil(() => gt() >= a.g + WALK, 20000, 10);
        const b = pos();
        res.walk[type] = { rate: Math.hypot(b.x - a.x, b.y - a.y) / (b.g - a.g) };
        // (Then it arrives and stands: no step over its destination and back.)
        const g2 = gt(); await world.runUntil(() => gt() >= g2 + 400, 40000, 10);
        const c = pos(); const g3 = gt(); await world.runUntil(() => gt() >= g3 + 48, 20000, 10);
        const d = pos();
        res.walk[type].settled = Math.hypot(d.x - c.x, d.y - c.y);
    }

    // ---- a lone attacker in a fight (open ground only): the damage it deals a base tick ----
    // (Every unit's energy set high and restored each poll: no one falls. Its target may be any of the enemies (they
    // meet it on the way); the same damage a hit whatever it hits.)
    if (map === maps[0]) {
        const att = JSON.parse(inst.evalSim(`JSON.stringify((() => {
            const u = units.find(v => !v.dead && v.owner === ${me} && v.unitType === 'norm');
            const k = units.find(v => v.isKing && v.owner !== ${me});
            __scratch.full = Object.fromEntries(units.filter(v => !v.dead).map(v => [v.id, 100000])); for (const v of units) if (!v.dead) v.energy = 100000;
            return { id: u.id, kx: k.x, ky: k.y };
        })())`));
        inst.eval(`queueAction({ action: 'attackMove', unitIds: [${att.id}], targetX: ${att.kx}, targetY: ${att.ky} })`);
        const poll = () => JSON.parse(inst.evalSim(`JSON.stringify((() => { let lost = 0; for (const v of units) { const e = __scratch.full[v.id]; if (e === undefined || v.dead) continue; if (v.owner !== ${me}) lost += e - v.energy; v.energy = e; } return { g: gameTime, lost }; })())`));
        await world.runUntil(() => poll().lost > 0, 240000, 10);
        const f = poll(); let lost = 0, g = f.g;
        while (g < f.g + HIT) { const t0 = g; await world.runUntil(() => gt() >= t0 + 4, 20000, 5); const p = poll(); lost += p.lost; g = p.g; }
        assert.equal(Number(inst.evalSim(`units.filter(v => !v.dead && __scratch.full[v.id] !== undefined).length`)), Object.keys(JSON.parse(inst.evalSim('JSON.stringify(__scratch.full)'))).length, 'no one fell (energy restored)');
        res.dmg = lost / (g - f.g);
    }
    res.errors = errors();
    world.instances.forEach(i => { try { i.kill({ silent: true }); } catch { } });
    return res;
}

(async () => {
    const rows = [];
    for (const map of maps) for (const K of sizes) {
        const r = await run(K, map); rows.push(r);
        console.log(`${map} dk ${K}: walk px a base tick ${types.map(t => t + ' ' + r.walk[t].rate.toFixed(4)).join(' ')}; moved after arriving ${types.map(t => t + ' ' + r.walk[t].settled.toFixed(2)).join(' ')}${r.dmg === r.dmg ? '; damage a base tick ' + r.dmg.toFixed(4) : ''}`);
        assert.deepEqual(r.errors, [], 'no errors at dk ' + K);
    }
    const bad = [];
    for (const r of rows) {
        for (const t of types) if (!(r.walk[t].settled < 1)) bad.push(`${r.map} ${t} at dk ${r.K} still moving after arriving: ${r.walk[t].settled.toFixed(2)} px`);
        const A = rows.find(x => x.map === r.map && x.K === sizes[0]);
        if (r === A) continue;
        const q = Object.fromEntries(types.map(t => [t + ' walk', r.walk[t].rate / A.walk[t].rate]));
        if (r.dmg === r.dmg) q.damage = r.dmg / A.dmg;
        console.log(`${r.map} dk ${r.K} / dk ${A.K}: ` + Object.entries(q).map(([k, v]) => `${k} ${v.toFixed(3)}`).join(', '));
        for (const [k, v] of Object.entries(q)) if (!(Math.abs(v - 1) <= (k === 'damage' ? DMG_TOL : SPEED_TOL))) bad.push(`${r.map} ${k} at dk ${r.K}: ${v.toFixed(3)}x`);
    }
    assert.deepEqual(bad, [], 'per-unit rates at 1.0 whatever the step size');
    console.log('PASS: a lone unit walks, arrives and hits at its dk 1 rates at every step size.');
    process.exit(0);
})().catch(err => { console.error(err); process.exit(1); });
