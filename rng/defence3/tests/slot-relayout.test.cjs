'use strict';
// The online slot relayout (sim_unit_state.js simUnitStateRelayoutStep): after deaths and drift, steps move units into denser
// slots of the block they stand in and give up empty slabs at the end, and everything that names a unit by slot follows it:
// the owners, the units' own slots, their columns, other units' targets (tuS), the id table and index, the books.
const assert=require('node:assert/strict'),H=require('./net-harness.cjs');
const world=new H.World({controls:{...H.SMALL_MATCH_CONTROLS,'cfg-mapsize':'200','cfg-map-type':'arena'}}),inst=world.spawn('relayout',{simWorker:false});
const result=inst.eval(`(() => {
    startSoloGame();
    const out = {};
    simUnitStateReserve(16384);
    let seed = 777; const rnd = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296;
    const all = [];
    // Interleaved creation in six blocks.
    const centres = [[600, 600], [1700, 600], [2800, 1700], [600, 2800], [3900, 3900], [5000, 1200]];
    for (let i = 0; i < 1500; i++) for (let g = 0; g < centres.length; g++) {
        const [cx, cy] = centres[g], u = new Unit('norm', g & 1, cx + (i % 25) * 14, cy + Math.floor(i / 25) * 10);
        units.push(u); unitAdded(u); all.push(u);
    }
    const S = _simUnitState, C = () => _simUnitState.columns;
    const slabsInUse = () => { let n = 0; for (let b = 0; b < S.sl.slabs; b++) if (S.sl.sfree[b] < SIM_SLAB) n++; return n; };
    // Two thirds die; a quarter of the rest walk to another block (drift).
    for (const u of all) if (rnd() < 0.66) u.dead = true;
    for (let t = 1; t <= 64; t++) { gameTime = t; simUnitStateCollect(); }
    const live = all.filter(u => !u.dead);
    for (const u of live) if (rnd() < 0.25) { const [cx, cy] = centres[Math.floor(rnd() * centres.length)]; u.x = cx + rnd() * 300; u.y = cy + rnd() * 300; u.prevX = u.x; u.prevY = u.y; }
    // Every unit's target: another living unit (its slot and id).
    for (let i = 0; i < live.length; i++) { const t = live[(i * 7 + 3) % live.length]; const c = C(), s = live[i]._si; c.tuS[s] = t._si; c.tuId[s] = t.id; }
    simUnitStateReleaseFreed();
    _uixFromList(units.filter(u => !u.dead));
    const before = new Map(live.map(u => [u.id, { x: C().x[u._si], y: C().y[u._si], e: C().energy[u._si], o: C().owner[u._si], t: C().tuId[u._si] }]));
    out.slots0 = S.owners.length; out.slabs0 = slabsInUse(); out.live = live.length;
    out.audit0 = simUnitSlabAudit();
    // Steps (the lanes idle in this world), as many as it takes.
    SIM_RELAYOUT_PERIOD = 4; SIM_RELAYOUT_EVERY = 1;
    let steps = 0, moved = 0;
    for (; steps < 400; steps++) { const n = simUnitStateRelayoutStep(); if (!n) break; moved += n; }
    out.steps = steps; out.moved = moved; out.stats = simUnitRelayoutStats();
    out.slots1 = _simUnitState.owners.length; out.slabs1 = slabsInUse();
    out.audit1 = simUnitSlabAudit();
    const c = C(), O = _simUnitState.owners;
    let bad = 0, badCol = 0, badTarget = 0, badRow = 0, badId = 0, homeMiss = 0;
    for (const u of live) {
        const s = u._si;
        if (u._us !== c || O.at(s) !== u || c.id[s] !== u.id || c.live[s] !== 1) bad++;
        const b = before.get(u.id);
        if (c.x[s] !== b.x || c.y[s] !== b.y || c.energy[s] !== b.e || c.owner[s] !== b.o || c.tuId[s] !== b.t) badCol++;
        const ts = c.tuS[s];
        if (!(ts >= 0) || c.id[ts] !== c.tuId[s] || O.at(ts) === null) badTarget++;
        if (getUnitById(u.id) !== u) badId++;
        if (_simSlabKey(S.sl, u.x, u.y) !== _simUnitState.sl.home[s >> 6]) homeMiss++;
    }
    for (let r = 0; r < _uix.n; r++) { const s = _uix.slots[r]; if (s >= 0 && (!O.at(s) || O.at(s).id !== _uix.ids[r])) badRow++; }
    Object.assign(out, { bad, badCol, badTarget, badId, badRow, homeMiss });
    // New units after the steps take slots as before; the books agree.
    for (let i = 0; i < 400; i++) { const [cx, cy] = centres[i % centres.length]; const u = new Unit('norm', 0, cx + rnd() * 200, cy + rnd() * 200); units.push(u); unitAdded(u); }
    out.audit2 = simUnitSlabAudit();
    return out;
})()`);
const r=JSON.parse(JSON.stringify(result));
for(const k of ['audit0','audit1','audit2'])assert.equal(r[k].ok,true,k+' '+JSON.stringify(r[k]));
assert.ok(r.moved>0,'the steps moved units: '+JSON.stringify(r.stats));
for(const k of ['bad','badCol','badTarget','badId','badRow'])assert.equal(r[k],0,k+' '+JSON.stringify(r));
// Denser: the slabs in use come down to near what the living units need, and the end comes free.
const need=Math.ceil(r.live/64);
assert.ok(r.slabs1<r.slabs0,'fewer slabs in use: '+r.slabs0+' -> '+r.slabs1);
assert.ok(r.slabs1<=need*1.6+12,'slabs in use near the need: '+r.slabs1+' for '+r.live+' units ('+need+' slabs)');
assert.ok(r.slots1<r.slots0,'slots given up at the end: '+r.slots0+' -> '+r.slots1);
// In block order: few units stand outside their slab's block (a slab moves once most of its units are out).
assert.ok(r.homeMiss<=r.live*0.2,"units out of their slab's block: "+r.homeMiss+' of '+r.live);
console.log('slot relayout ok',JSON.stringify({live:r.live,slabs:[r.slabs0,r.slabs1,need],slots:[r.slots0,r.slots1],moved:r.moved,steps:r.steps,homeMiss:r.homeMiss}));
