// Steps of several base ticks (simDk, the shared deltatick): units cover
// about the same ground per second of game time, and fights deal about the
// same damage, whatever the step size; game time moves on by the step's base
// ticks. Each step size runs the same solo match (the simulation worker,
// the step size forced as a match's pace would set it).
// node tests/deltatick-fairness.test.cjs [--sizes=1,4,10]
const assert = require('node:assert/strict');
const H = require('./net-harness.cjs');

const sizes = ((process.argv.find(a => a.startsWith('--sizes=')) || '').split('=')[1] || '1,4,10').split(',').map(Number);
// (Rates averaged over scenes: one fight is chaotic (a 50-a-side fight's damage swung 0.67-0.82x with unrelated changes).)
const maps = ((process.argv.find(a => a.startsWith('--maps=')) || '').split('=')[1] || 'arena,random').split(',');

async function run(K, map) {
    const controls = { ...H.SMALL_MATCH_CONTROLS, 'cfg-mapsize': '48', 'cfg-map-type': map, 'cfg-max-pop': '5000', 'cfg-full-vis': 'all' };
    const world = new H.World({ simWorker: true, controls });
    const inst = world.spawn('solo', { controls });
    inst.eval(`netStepTicks = () => ${K};`);
    inst.eval(`startingResourcesConfig = ${JSON.stringify({ spawnCounts: { 'unit:king': { 1: 1 }, 'unit:norm': { 1: 40 }, 'unit:fast': { 1: 10 } }, researchLevels: {} })}; startSoloGame();`);
    await world.run(1500);
    assert.equal(inst.eval('gameStarted && simClientActive()'), true, 'solo match on the worker');
    const errors = () => inst.errors.map(e => String(e.stack || e).slice(0, 300));

    // ---- game time: a step's base ticks ----
    const g0 = Number(inst.evalSim('gameTime')), c0 = Number(inst.evalSim('currentTick'));
    await world.run(1000);
    const g1 = Number(inst.evalSim('gameTime')), c1 = Number(inst.evalSim('currentTick'));
    const perStep = (g1 - g0) / Math.max(1, c1 - c0);

    // ---- movement: own fighters ordered across the map ----
    const order = JSON.parse(inst.evalSim(`JSON.stringify((() => {
        const mine = units.filter(u => !u.dead && u.owner === localPlayerId && !u.workerType && !u.isKing);
        const k = units.find(u => u.isKing && u.owner === localPlayerId);
        const tx = (k.x < GRID_W * TILE / 2 ? 0.8 : 0.2) * GRID_W * TILE, ty = k.y;
        __scratch.mv = { ids: mine.map(u => u.id), start: Object.fromEntries(mine.map(u => [u.id, [u.x, u.y, u.unitType]])), tx, ty };
        return { n: mine.length, tx, ty };
    })())`));
    inst.eval(`queueAction({ action: 'move', unitIds: __scratch.mv.ids.slice(), targetX: ${order.tx}, targetY: ${order.ty} })`);
    // (From the step the order ran on: the first that moved them.)
    await world.runUntil(() => Number(inst.evalSim(`units.filter(u => __scratch.mv.start[u.id] && Math.hypot(u.x - __scratch.mv.start[u.id][0], u.y - __scratch.mv.start[u.id][1]) > 0.5).length`)) > order.n / 2, 4000, 10);
    const m0 = JSON.parse(inst.evalSim(`JSON.stringify({ g: gameTime, at: Object.fromEntries(units.filter(u => __scratch.mv.start[u.id]).map(u => [u.id, [u.x, u.y]])) })`));
    await world.runUntil(() => Number(inst.evalSim('gameTime')) >= m0.g + 120, 20000, 10);
    const m1 = JSON.parse(inst.evalSim(`JSON.stringify({ g: gameTime, at: Object.fromEntries(units.filter(u => __scratch.mv.start[u.id]).map(u => [u.id, [u.x, u.y]])) })`));
    const start = JSON.parse(inst.evalSim('JSON.stringify(__scratch.mv.start)'));
    const rate = { norm: [], fast: [] };
    for (const id of Object.keys(m1.at)) {
        const a = m0.at[id], b = m1.at[id], t = start[id][2];
        if (!a || !b || !rate[t]) continue;
        rate[t].push(Math.hypot(b[0] - a[0], b[1] - a[1]) / (m1.g - m0.g));
    }
    const mean = a => a.length ? a.reduce((s, v) => s + v, 0) / a.length : NaN;

    // ---- a fight: everything of both sides attack-moves at the other king ----
    inst.evalSim(`(() => {
        __scratch.e0 = {};
        for (const u of units) if (!u.dead && !u.workerType) __scratch.e0[u.owner] = (__scratch.e0[u.owner] || 0) + u.energy;
    })()`);
    const kings = JSON.parse(inst.evalSim(`JSON.stringify(units.filter(u => u.isKing).map(u => ({ o: u.owner, x: u.x, y: u.y })))`));
    const enemyKing = kings.find(k => k.o !== Number(inst.eval('localPlayerId')));
    const own = JSON.parse(inst.evalSim(`JSON.stringify(units.filter(u => !u.dead && u.owner === localPlayerId && !u.workerType && !u.isKing).map(u => u.id))`));
    inst.eval(`queueAction({ action: 'attackMove', unitIds: ${JSON.stringify(own)}, targetX: ${enemyKing.x}, targetY: ${enemyKing.y} })`);
    const f0 = Number(inst.evalSim('gameTime'));
    await world.runUntil(() => Number(inst.evalSim('gameTime')) >= f0 + 400, 240000, 10);
    const fight = JSON.parse(inst.evalSim(`JSON.stringify((() => {
        const now = {};
        for (const u of units) if (!u.dead && !u.workerType) now[u.owner] = (now[u.owner] || 0) + u.energy;
        const lost = {};
        for (const o in __scratch.e0) lost[o] = __scratch.e0[o] - (now[o] || 0);
        return { g: gameTime, lost };
    })())`));
    const res = { K, perStep, norm: mean(rate.norm), fast: mean(rate.fast), fightTicks: fight.g - f0, lost: fight.lost, errors: errors() };
    world.instances.forEach(i => { try { i.kill({ silent: true }); } catch { } });
    return res;
}

(async () => {
    const rows = [];
    for (const map of maps) for (const K of sizes) {
        const r = await run(K, map);
        r.map = map; rows.push(r);
        console.log(`${map} dk ${K}: ${r.perStep.toFixed(2)} base ticks a step; px a base tick norm ${r.norm.toFixed(3)} fast ${r.fast.toFixed(3)}; fight over ${r.fightTicks} base ticks lost ${JSON.stringify(Object.fromEntries(Object.entries(r.lost).map(([k, v]) => [k, Math.round(v)])))}`);
        assert.deepEqual(r.errors, [], 'no errors at dk ' + K);
        assert.ok(Math.abs(r.perStep - r.K) < 0.01, `game time moves on by the step size (dk ${r.K}: ${r.perStep})`);
        assert.ok(r.fightTicks >= 400 && r.fightTicks < 400 + r.K, 'the fight ran its 400 base ticks');
    }
    const dmgOf = r => Object.values(r.lost).reduce((s, v) => s + v, 0) / r.fightTicks;
    const avg = a => a.reduce((s, v) => s + v, 0) / a.length;
    for (const K of sizes.slice(1)) {
        // (Each scene's ratio to its own first-size run, then the mean over scenes.)
        const q = { norm: [], fast: [], dmg: [] };
        for (const map of maps) {
            const a = rows.find(r => r.map === map && r.K === sizes[0]), b = rows.find(r => r.map === map && r.K === K);
            q.norm.push(b.norm / a.norm); q.fast.push(b.fast / a.fast); q.dmg.push(dmgOf(b) / dmgOf(a));
        }
        const [n, fst, dmg] = [avg(q.norm), avg(q.fast), avg(q.dmg)], speed = (n + fst) / 2;
        console.log(`dk ${K} / dk ${sizes[0]} over ${maps.length} scenes: speed ${speed.toFixed(3)} (norm ${n.toFixed(3)} fast ${fst.toFixed(3)}), fight damage ${dmg.toFixed(3)}`);
        // Movement is calibrated (data_static.js SIM_DK_KNOBS, tests/dk-calibrate.cjs): the mean of the types near 1.
        assert.ok(Math.abs(speed - 1) < 0.05, `units cover the same ground a base tick at dk ${K} (types averaged): ${speed.toFixed(3)}x`);
        for (const [t, v] of [['norm', n], ['fast', fst]]) assert.ok(v > 0.85 && v < 1.15, `${t} units' ground a base tick at dk ${K}: ${v.toFixed(3)}x`);
        // (Interim: fights engage later at large steps (acquisition's post-to-commit lag is a step); not calibrated
        // yet, see data_static.js SIM_DK_KNOBS. The old bound until that is fixed.)
        assert.ok(dmg > 0.75 && dmg < 1.33, `a fight deals about the same damage a base tick at dk ${K}: ${dmg.toFixed(3)}x`);
    }
    console.log('PASS: steps of several base ticks keep movement and damage per game time.');
    process.exit(0);
})().catch(err => { console.error(err); process.exit(1); });
