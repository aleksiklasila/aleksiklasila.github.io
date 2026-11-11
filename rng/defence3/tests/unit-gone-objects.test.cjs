'use strict';
// Unit objects across their units' deaths (sim_unit_state.js
// simUnitStateDetachGoneMany, unit.js Unit.prototype._us / _gone*): nothing
// is written to an object at a death; a held object reads as dead with its
// last id, owner and position (by its handle), its handle is free at once (its
// generation moves on), so a new unit taking it is not read through a held object.
// Usage: node tests/unit-gone-objects.test.cjs
const assert = require('node:assert/strict'), H = require('./net-harness.cjs');
globalThis.self = { crossOriginIsolated: true };
const controls = { ...H.SMALL_MATCH_CONTROLS, 'cfg-mapsize': '120', 'cfg-map-type': 'arena', 'cfg-max-pop': '20000' };
const world = new H.World({ controls }), i = world.spawn('go', { controls, simWorker: false });
i.eval('startSoloGame();');
const r = JSON.parse(i.eval(`JSON.stringify((() => {
    const made = [];
    for (let k = 0; k < 400; k++) { const gx = 20 + (k % 40), gy = 30 + Math.floor(k / 40); if (cellType[(grid[gy][gx]) - 1] === TYPE_WALL) continue; const u = new Unit('norm', 0, gx * TILE + 16, gy * TILE + 16); units.push(u); unitSlotMapPushed(u); made.push(u); }
    for (let t = 0; t < 3; t++) gameTick();
    // (Held: the first 100; their last values noted.)
    __scratch.held = made.slice(0, 100);
    const last = __scratch.held.map(u => [u.id, u.owner, u.x, u.y, u._h]);
    for (let t = 0; t < 4; t++) { for (const u of made.slice(0, 200)) if (!u.dead) u.energy = 0; gameTick(); }
    const held = __scratch.held, S = _simUnitState;
    let bad = 0, why = [];
    held.forEach((u, k) => { const [id, owner, x, y] = last[k]; if (!u.dead || u._si !== -1 || u._us !== null || u.id !== id || u.owner !== owner || Math.abs(u.x - x) > 64 || Math.abs(u.y - y) > 64) { bad++; why.push([k, u.dead, u._si, u._us === null, id, u.id, owner, u.owner, x, u.x, y, u.y, u.energy]); } });
    const heldH = new Set(last.map(l => l[4]));
    // New units take the freed handles: held objects still read their dead units.
    const fresh = [];
    for (let k = 0; k < 300; k++) { const gx = 20 + (k % 40), gy = 50 + Math.floor(k / 40); if (cellType[(grid[gy][gx]) - 1] === TYPE_WALL) continue; const u = new Unit('norm', 0, gx * TILE + 16, gy * TILE + 16); units.push(u); unitSlotMapPushed(u); fresh.push(u); }
    gameTick();
    const reused = held.filter(u => u._us !== null || u._si !== -1 || !u.dead).length;
    const audit = simUnitSlabAudit(), occ = occupancyAudit();
    return { bad, why: why.slice(0, 4), reused, held: held.length, audit: audit.ok, occ: occ.ok, hfree: S.hfreeN };
})())`));
assert.equal(r.bad, 0, 'held objects read as their dead units ' + JSON.stringify(r));
assert.equal(r.reused, 0, 'held objects not read through a reused handle');
assert.ok(r.audit && r.occ, 'slot books and occupancy');
// (The objects were not written at the deaths: their handles' generations moved on, unit.js _us.)
const left = Number(i.eval('__scratch.held.filter(u => _simUnitState.columns.hgen[u._h] === u._g).length'));
assert.equal(left, 0, 'every held object is a generation behind its handle');
assert.deepEqual(i.errors.map(String), []);
console.log('PASS: unit objects across deaths', JSON.stringify({ ...r, left }));
