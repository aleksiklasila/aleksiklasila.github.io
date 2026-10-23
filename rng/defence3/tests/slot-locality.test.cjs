'use strict';
// Unit slots by place (sim_unit_state.js): units made in one 16-tile block take neighbouring slots, a block's freed slots serve its next
// units, free slots stay bounded under churn, planned layouts are dense and sorted by block, and the books agree with the owners.
const assert=require('node:assert/strict'),H=require('./net-harness.cjs');
const world=new H.World({controls:{...H.SMALL_MATCH_CONTROLS,'cfg-mapsize':'200','cfg-map-type':'arena'}}),inst=world.spawn('slots',{simWorker:false});
const result=inst.eval(`(() => {
    startSoloGame();
    const out = {};
    const S0 = _simUnitState;
    simUnitStateReserve(8192);
    const centres = [[1100, 1100], [3200, 1100], [5200, 3200]], groups = [[], [], []];
    const make = (g, i) => { const [cx, cy] = centres[g]; const u = new Unit('norm', 0, cx + (i % 20) * 14, cy + Math.floor(i / 20) * 14); units.push(u); groups[g].push(u); return u; };
    // 1. Interleaved creation in three blocks: each block's units fill whole slabs.
    for (let i = 0; i < 300; i++) for (let g = 0; g < 3; g++) make(g, i);
    const S = _simUnitState, slabsOf = list => new Set(list.filter(u => !u.dead).map(u => u._si >> 6));
    out.live = groups.map(l => l.filter(u => !u.dead).length);
    out.slabs1 = groups.map(l => slabsOf(l).size);
    out.audit1 = simUnitSlabAudit();
    // 2. A third of block 0 dies; its next units take those slots (same slabs, no new slots).
    const aSlabs = slabsOf(groups[0]), slotsBefore = S.owners.length;
    const dead = groups[0].filter((u, i) => !u.dead && i % 3 === 0);
    for (const u of dead) u.dead = true;
    for (let t = 1; t <= 64; t++) { gameTime = t; simUnitStateCollect(); }
    simUnitStateReleaseFreed();
    out.audit2 = simUnitSlabAudit();
    const fresh = [];
    for (let i = 0; i < dead.length; i++) fresh.push(make(0, 300 + i));
    out.reusedInSlabs = fresh.filter(u => !u.dead).every(u => aSlabs.has(u._si >> 6));
    out.noGrowth = S.owners.length === slotsBefore;
    out.audit3 = simUnitSlabAudit();
    // 3. Churn: a third of everything dies, the same number are made in random blocks, 12 times; free slots and slot count stay bounded.
    let seed = 12345; const rnd = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296;
    let worst = 0;
    for (let round = 0; round < 12; round++) {
        let killed = 0;
        for (let g = 0; g < 3; g++) for (const u of groups[g]) if (!u.dead && rnd() < 0.33) { u.dead = true; killed++; }
        for (let t = 1; t <= 64; t++) { gameTime = 1000 + round * 100 + t; simUnitStateCollect(); }
        simUnitStateReleaseFreed();
        for (let i = 0; i < killed; i++) make(Math.floor(rnd() * 3), 1000 + round * 1000 + i);
        worst = Math.max(worst, S.sl.nfree); (out.rounds ||= []).push([round, killed, S.sl.nfree, S.owners.length, S.sl.slabs]);
    }
    out.audit4 = simUnitSlabAudit();
    out.worstFree = worst;
    out.slotsNow = S.owners.length;
    out.slack = Math.max(SIM_SLAB_SLACK_MIN, S.owners.length >> SIM_SLAB_SLACK_SHIFT);
    // 4. A plan is dense and sorted by block.
    const n = 5000, xs = new Float64Array(n), ys = new Float64Array(n);
    for (let i = 0; i < n; i++) { xs[i] = (rnd() * GRID_W * TILE) | 0; ys[i] = (rnd() * GRID_H * TILE) | 0; }
    const plan = simUnitStatePlanSlots(xs, ys, n), sl = S.sl;
    const base = S.owners.length, seen = new Uint8Array(n);
    let dense = true, sorted = true, lastKey = -1;
    const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => plan[a] - plan[b]);
    for (const i of order) { const k = _simSlabKey(sl, xs[i], ys[i]); if (k < lastKey) sorted = false; lastKey = k; }
    for (let i = 0; i < n; i++) { const o = plan[i] - base; if (o < 0 || o >= n || seen[o]) dense = false; else seen[o] = 1; }
    out.plan = { dense, sorted };
    // 5. Made by that plan: the books agree, the units sit in the planned slots.
    simUnitStatePlanBegin();
    const planned = [];
    for (let i = 0; i < 600; i++) { simUnitStateWantSlot(plan[i]); const u = new Unit('norm', 1, xs[i], ys[i]); units.push(u); planned.push([u, plan[i]]); }
    simUnitStatePlanEnd();
    out.plannedAt = planned.filter(([u]) => !u.dead).every(([u, s]) => u._si === s);
    out.audit5 = simUnitSlabAudit();
    // 6. A compaction lays the live units out again, the books anew.
    const liveBefore = units.filter(u => !u.dead).length;
    simUnitStateCompact(true);
    out.audit6 = simUnitSlabAudit();
    out.consistent = units.every(u => u.dead || (u._us && S.owners[u._si] === u) || (_simUnitState.owners[u._si] === u));
    out.liveSame = units.filter(u => !u.dead).length === liveBefore;
    return out;
})()`);
const r=JSON.parse(JSON.stringify(result));
for(const k of ['audit1','audit2','audit3','audit4','audit5','audit6'])assert.equal(r[k].ok,true,k+' '+JSON.stringify(r[k]));
// 900 units in three interleaved blocks: 5 slabs each (300 units), not 15 shared ones.
assert.ok(r.slabs1.every(n=>n<=6),'slabs per block '+JSON.stringify(r.slabs1));
assert.ok(r.reusedInSlabs,'a block\'s freed slots serve its next units');
assert.ok(r.noGrowth,'no new slots while holes lie in the block\'s slabs');
// (A soft limit: new slabs open only below it; a burst of deaths (a third of ~1100 units a round) can stand above it until the next births.)
const burst=Math.max(...r.rounds.map(x=>x[1]));
assert.ok(r.worstFree<=r.slack+2*burst+64,'free slots stay near the slack: '+r.worstFree+' > '+r.slack+' + '+burst);
assert.ok(r.rounds[11][2]<=r.rounds[5][2]+3*burst,'free slots stop growing: '+JSON.stringify(r.rounds.map(x=>x[2])));
assert.deepEqual(r.plan,{dense:true,sorted:true});
assert.ok(r.plannedAt,'planned slots taken');
assert.ok(r.consistent&&r.liveSame,'compaction keeps every live unit');
console.log('PASS: slots by place — blocks fill their own slabs, holes serve the same block, churn stays bounded, plans are dense and sorted',JSON.stringify({slabs:r.slabs1,worstFree:r.worstFree,slots:r.slotsNow}));
