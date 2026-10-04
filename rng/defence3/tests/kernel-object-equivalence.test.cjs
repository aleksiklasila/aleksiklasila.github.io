// The movement/attack-hold kernels decide exactly as Unit.update would.
// A restore disarms every unit on the restoring peer only (snapDecodeState:
// simMoveDisarmAll), so any difference between a kernel-moved unit and the
// same unit updated as an object is a desync after a resync patch.
//
// Guest1 disarms every unit before each kernel run (everything goes through
// Unit.update); the host runs the kernels as usual. Every snapshot field of
// every entity is compared at sampled ticks, and the exact per-tick hashes
// on every tick. Decisions in the unit pass must read other units where they
// were at the pass's start (_unitTickX), not where a kernel already moved them.
//
// Usage: node tests/kernel-object-equivalence.test.cjs [seed:map,...]
//   env ROUNDS (chaos rounds of 200 ms, default 120), EVERY (sample ticks, 25), LOWASTAR
//   env PU=<unit id> PT0/PT1: log that unit's Unit.update calls on both peers.
const assert = require('node:assert/strict');
const C = require('./multiplayer-chaos-determinism.test.cjs');

const FULL_VALUES = `(() => {
    const S = snapEncodeState();
    const out = {};
    for (const list of Object.keys(S.lists)) for (const row of S.lists[list]) {
        const tpl = S.tpls[row[1]];
        const keys = _snapGetShape(S.shapes[tpl[0]]).cols;
        const v = tpl[1].slice();
        for (let j = 2; j < row.length; j += 2) v[row[j]] = row[j + 1];
        const o = {};
        const deref = (x, d) => { if (typeof x === 'string' && x.startsWith('~o') && d < 3) { const e = S.pool[+x.slice(2)]; return JSON.stringify(e, (k, y) => typeof y === 'string' && y.startsWith('~o') ? deref(y, d + 1) : y); } return x; };
        keys.forEach((k, i) => { o[k] = deref(v[i], 0); });
        out[list + row[0]] = o;
    }
    out.G = { g: JSON.stringify(S.g) };
    return JSON.stringify(out);
})()`;

function describeDiff(hostText, guestText) {
    const a = JSON.parse(hostText), b = JSON.parse(guestText), diffs = [];
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
        if (!a[k] || !b[k]) { diffs.push(k + ' only on ' + (a[k] ? 'host' : 'guest')); continue; }
        for (const f of Object.keys(a[k])) if (JSON.stringify(a[k][f]) !== JSON.stringify(b[k][f])) diffs.push(k + '.' + f + ' host=' + JSON.stringify(a[k][f]).slice(0, 100) + ' objects=' + JSON.stringify(b[k][f]).slice(0, 100));
    }
    // (DIFFU=1: unit fields first.)
    if (process.env.DIFFU) diffs.sort((x, y) => (x[0] === 'u' ? 0 : 1) - (y[0] === 'u' ? 0 : 1));
    return diffs.length + ' fields: ' + diffs.slice(0, 10).join(' | ');
}

async function runCase(seed, map, lowAstar = Number(process.env.LOWASTAR) || 0) {
    const { world, host, guests, all } = await C.setupChaosWorld(map, seed, { teams: [0, 1, 2, 3], exactHashes: true, network: { latencyMs: 30, jitterMs: 5 } });
    const g = guests[0];
    g.evalSim(`{ const run = simMoveRun; simMoveRun = function () { simMoveDisarmAll(); return run.apply(this, arguments); }; }`);
    if (process.env.PU) for (const inst of [host, g]) inst.evalSim(`{ const f = Unit.prototype.update; Unit.prototype.update = function () {
        if (this.id !== ${+process.env.PU} || currentTick < ${+process.env.PT0 || 0} || currentTick > ${+process.env.PT1 || 1e9}) return f.apply(this, arguments);
        const c = this._us, s = this._si, st = u => [u.unitType, u.workerState, u.commandState, u.path ? JSON.stringify(u.path.slice(0, 3)) + '/' + u.path.length : '-', u.pathIndex, u.x, u.y, u.targetUnit ? u.targetUnit.id : '-'].join(' ');
        const b = st(this) + ' on ' + c.mvOn[s];
        const r = f.apply(this, arguments);
        (globalThis.__plog ||= []).push(currentTick + ' ' + b + ' -> ' + st(this)); return r; }; }`);
    // Kernel outcomes on the host (moves by mode), to show what was compared.
    if (!process.env.NOKOUT) host.evalSim(`{ globalThis.__kout = {}; const run = simMoveRun; simMoveRun = function () { const r = run.apply(this, arguments); const S = _simUnitState; if (!S) return r; const O = S.columns.mvOut;
        for (let s = 0; s < S.owners.length; s++) { const o = O[s]; if (o) { const k = o === 10 ? 'fire' : o >= 7 ? 'chase' : o === 6 ? 'hold' : 'move'; globalThis.__kout[k] = (globalThis.__kout[k] || 0) + 1;
            // (Forced targets' holds and chases: mvFlags 8.)
            const on = S.columns.mvOn[s]; if ((on === 3 || on === 4) && (S.columns.mvFlags[s] & 8)) globalThis.__kout.forced = (globalThis.__kout.forced || 0) + 1; } } return r; }; }`);
    // LOWASTAR=n: every player starts with n A* (movement then runs the
    // budget out: steps that are not covered mark their units).
    if (lowAstar) world.atTick(host.eval('currentTick') + 5, `for (let p = 0; p < players.length; p++) _setPlayerResourceValue(p, 'astar', ${lowAstar})`);
    // HOST_SIM_EVAL: code for the host's simulation alone (a kernel path
    // switched on there only, e.g. EFF_STATS_KERNEL_MIN_UNITS = 0: the guest
    // keeps the object path, and every field is compared).
    if (process.env.HOST_SIM_EVAL) host.evalSim(process.env.HOST_SIM_EVAL);
    const repairs0 = g.patchesApplied + g.snapshotsApplied;
    const shared = { rec: {} };
    for (const i of all) i.scratch.shared = shared;
    const gid = JSON.stringify(g.eval('myPeerId'));
    const t0 = host.eval('currentTick'), every = +process.env.EVERY || 25, rounds = +process.env.ROUNDS || 120;
    for (let t = t0 + 10; t < t0 + rounds * 4 + 20; t += every) world.atTick(t, `(() => { if (isHost || myPeerId === ${gid}) (__scratch.shared.rec[currentTick] ||= {})[isHost ? 'h' : 'g'] = ${FULL_VALUES}; })()`);
    let s = seed;
    const rand = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
    for (let k = 0; k < rounds; k++) { for (const i of all) if (rand() < 0.6) i.eval(C.CHAOS_COMMAND + '(' + rand() + ')'); await world.run(200); }
    if (process.env.PU) for (const [name, inst] of [['host', host], ['objects', g]]) { console.log(name); for (const l of JSON.parse(inst.evalSim('JSON.stringify(globalThis.__plog || [])'))) console.log('  ' + l); }
    if (process.env.PU && process.env.HOST_SIM_EVAL) console.log('host stat', host.evalSim('JSON.stringify(globalThis.__hostStat || null)'));
    const bad = [];
    for (const [t, h] of host.tickExact || []) { if (t < t0) continue; const o = g.tickExact.get(t); if (o !== undefined && o !== h) bad.push(t); }
    let compared = 0;
    for (const t of Object.keys(shared.rec).map(Number).sort((a, b) => a - b)) {
        const r = shared.rec[t];
        if (!r.h || !r.g) continue;
        compared++;
        assert.ok(r.h === r.g, `seed ${seed} ${map}: kernel and object updates differ at tick ${t}: ` + (r.h === r.g ? '' : describeDiff(r.h, r.g)));
    }
    assert.equal(bad.length, 0, `seed ${seed} ${map}: exact hashes differ from tick ${bad[0]} (${bad.length} ticks)`);
    assert.equal(g.patchesApplied + g.snapshotsApplied - repairs0, 0, `seed ${seed} ${map}: repairs on the object-update guest`);
    assert.ok(compared >= 5, `seed ${seed} ${map}: sampled ticks compared (${compared})`);
    const armed = host.evalSim('(() => { let a = 0; const c = _simUnitState.columns; for (let s = 0; s < _simUnitState.owners.length; s++) if (c.mvOn[s]) a++; return a; })()');
    const kout = host.evalSim('JSON.stringify(globalThis.__kout || null)') + (process.env.HOST_SIM_EVAL ? ' host extra ' + host.evalSim('JSON.stringify(globalThis.__hostStat || null)') : '');
    return `seed ${seed} ${map}${lowAstar ? ' (A* ' + lowAstar + ')' : ''}: ${compared} sampled ticks equal field by field, exact hashes equal (${armed} units armed on the host at the end; kernel unit-ticks ${kout})`;
}

(async () => {
    // seed:map[:astar] (astar: every player's A* set that low early on).
    const cases = (process.argv[2] || '5:islands,7:solar_system,13:crossroads,9:crossroads:300').split(',').map(c => { const [s, m, a] = c.split(':'); return [+s, m || 'crossroads', +a || 0]; });
    const rows = [];
    for (const [seed, map, astar] of cases) rows.push(await runCase(seed, map, astar || undefined));
    console.log('PASS: kernel/object equivalence\n  ' + rows.join('\n  '));
    process.exit(0);
})().catch(err => { console.error(err); process.exit(1); });
