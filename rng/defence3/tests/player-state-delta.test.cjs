// The players' state the simulation worker sends the page each tick goes as
// deltas (research queue: front drop + kept run + tail; research levels:
// changed and removed keys; unchanged keys in __same). Random mutations of
// queues and levels, encoded and applied, must leave the page's players
// equal to the simulation's.
//   node tests/player-state-delta.test.cjs
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm'), assert = require('assert');
const src = fs.readFileSync(path.join(__dirname, '../src/sim/sim_frame_world.js'), 'utf8');
function instance() {
    const ctx = { Unit: class Unit { }, players: [], console, Math, Object, Array, JSON, Float64Array, Int32Array, Map, Set, WeakMap, Number, String, dirtyAreas: false, areas: [], gameTime: 0, gameOver: false, winner: null, resignedTeams: new Set(), activeTeamIds: [], pathfindBudgetByPlayer: null, astarNodeBudgetRemainingByPlayer: null, localDefeated: false };
    vm.createContext(ctx);
    vm.runInContext(src, ctx);
    return ctx;
}
const sim = instance(), page = instance();
page.rebuildPrecomputedStatsMapPlayer = undefined;
let seed = 12345;
const rnd = () => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 4294967296;
let taskId = 0;
const task = () => ({ kind: 'unit', key: 'k' + (taskId % 37), statKey: 's' + (taskId++ % 5), fromLevel: 0, toLevel: 1, cost: 10, workRequired: 100, workDone: 0, id: taskId });
function newPlayer() { const q = []; for (let i = 0; i < 50; i++) q.push(task()); const lv = {}; for (let i = 0; i < 20; i++) lv['unit:k' + i + ':s0'] = i % 4; const mu = {}; for (let i = 0; i < 20; i++) mu['unit:k' + i + ':s0'] = 1 + i / 7; return { energy: 100, researchQueue: q, researchTask: task(), researchLevels: lv, researchMultipliers: mu }; }
sim.players.push(newPlayer(), newPlayer());
const mkAreas = () => Array.from({ length: 300 }, (_, id) => ({ id, active: false, multiplierLevel: 0 }));
sim.areas = mkAreas(); page.areas = mkAreas();
sim.areaDirtyIds = { ids: new Int32Array(4), n: 0, all: true };
const plain = v => JSON.parse(JSON.stringify(v));
const canon = o => JSON.stringify(Object.keys(o || {}).sort().map(k => [k, o[k]]));
let deltas = 0, sames = 0;
const lastEq = [0, 0];
for (let tick = 0; tick < 3000; tick++) {
    for (const p of sim.players) {
        const r = rnd(), q = p.researchQueue;
        if (r < 0.3 && q.length) q.splice(0, 1 + Math.floor(rnd() * 3));
        else if (r < 0.45) for (let n = Math.floor(rnd() * 5); n > 0; n--) q.push(task());
        else if (r < 0.5 && q.length > 3) { const i = Math.floor(rnd() * q.length); q.splice(i, 1); }
        else if (r < 0.55 && q.length) q[Math.floor(rnd() * q.length)].workDone += 7;
        else if (r < 0.58 && q.length > 2) { const a = q.shift(); q.splice(1, 0, a); }
        else if (r < 0.6) p.researchQueue = q.slice();
        else if (r < 0.62) { q.length = 0; for (let n = 10; n > 0; n--) q.push(task()); }
        const s = rnd();
        if (s < 0.2) { const k = 'unit:k' + Math.floor(rnd() * 30) + ':s' + Math.floor(rnd() * 3); p.researchLevels[k] = (p.researchLevels[k] || 0) + 1; }
        else if (s < 0.23) { const ks = Object.keys(p.researchLevels); if (ks.length) delete p.researchLevels[ks[Math.floor(rnd() * ks.length)]]; }
        else if (s < 0.24) p.researchLevels = Object.assign({}, p.researchLevels);
        if (rnd() < 0.3) p.researchMultipliers['unit:k' + Math.floor(rnd() * 30) + ':s1'] = rnd() * 3;
        p.energy = Math.floor(rnd() * 1000);
    }
    if (rnd() < 0.5) { const ar = sim.areas[Math.floor(rnd() * sim.areas.length)]; if (rnd() < 0.5) ar.active = !ar.active; else ar.multiplierLevel = Math.floor(rnd() * 4); sim.dirtyAreas = true; const D = sim.areaDirtyIds; if (D.n < D.ids.length) D.ids[D.n++] = ar.id; else D.all = true; }
    if (tick === 1500) sim.players[1] = newPlayer();
    if (tick === 2000) { sim.areas = mkAreas(); sim.areas[3].active = true; }
    const st = plain(sim.simFrameEncodeState(false));
    for (const e of st.players) { if (e.__same) sames++; if (e.researchQueue && e.researchQueue.__qd) deltas++; }
    page.pageApplyState(st);
    for (let i = 0; i < sim.players.length; i++) {
        const a = sim.players[i], b = page.players[i];
        assert.deepStrictEqual(plain(b.researchQueue), plain(a.researchQueue), 'queue tick ' + tick + ' player ' + i);
        // (The flat maps may lag up to 10 frames when the task and queue did not change.)
        const eq = canon(b.researchLevels) === canon(a.researchLevels) && canon(b.researchMultipliers) === canon(a.researchMultipliers);
        if (eq) lastEq[i] = tick; else assert.ok(tick - lastEq[i] < 10, 'flat maps lag at tick ' + tick + ' player ' + i);
        assert.strictEqual(b.energy, a.energy);
    }
    for (let i = 0; i < sim.areas.length; i++) assert.ok(!!page.areas[i].active === !!sim.areas[i].active && (page.areas[i].multiplierLevel || 0) === sim.areas[i].multiplierLevel, 'area ' + i + ' tick ' + tick);
}
assert.ok(deltas > 500 && sames > 500, 'deltas ' + deltas + ' sames ' + sames);
console.log('player-state-delta ok: deltas', deltas, 'unchanged', sames);
