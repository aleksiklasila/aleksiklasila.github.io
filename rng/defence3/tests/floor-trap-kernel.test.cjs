// Floor traps in the movement kernel (mv.rs floor_hit, unit.js trap table):
// units moved by the kernel across hostile traps get the trap's status
// (sand, water, ice, poison, fire) without being handed to Unit.update on
// those tiles; a resistant type gets nothing; a trap under construction does
// nothing; a mine is still Unit.update's (it goes off).
//   node tests/floor-trap-kernel.test.cjs
'use strict';
const assert = require('node:assert/strict');
const H = require('./net-harness.cjs');
const world = new H.World({ controls: { ...H.SMALL_MATCH_CONTROLS, 'cfg-mapsize': '80', 'cfg-map-type': 'arena' } });
const inst = world.spawn('trapk', { simWorker: false });
inst.eval('startSoloGame();');
inst.eval('SPATIAL_PARALLEL_MIN_UNITS = 0; SEPARATION_SLOT_MIN_UNITS = 0;');
const r = JSON.parse(inst.eval(`JSON.stringify((() => {
    // A clear row: traps of player 1 on tiles x0 + 2k, units of player 0
    // walking along it (one lane per trap kind).
    const kinds = ['sand', 'water_puddle', 'ice_patch', 'poison_puddle', 'lava'];
    const effectOf = { sand: 'sandy', water_puddle: 'wet', ice_patch: 'frozen', poison_puddle: 'poisoned', lava: 'burning' };
    let found = null;
    for (let gy = 4; gy < GRID_H - 20 && !found; gy++) for (let gx = 4; gx < GRID_W - 30 && !found; gx++) {
        let ok = true;
        for (let y = gy; y < gy + kinds.length * 2 + 2 && ok; y++) for (let x = gx; x < gx + 20 && ok; x++)
            if (grid[y][x].type === TYPE_WALL || grid[y][x].item || getTileEntityRef(x, y)) ok = false;
        if (ok) found = { gx, gy };
    }
    if (!found) return { err: 'no clear area' };
    const out = { lanes: [] };
    const updCalls = new Map();
    { const f = Unit.prototype.update; Unit.prototype.update = function () { const c = this._us; if (c) { const t = Math.floor(c.y[this._si] / 8 / TILE) * GRID_W + Math.floor(c.x[this._si] / 8 / TILE); const k = this.id + ':' + t; updCalls.set(k, (updCalls.get(k) || 0) + 1); } return f.call(this); }; }
    const traps = [];
    kinds.forEach((kind, i) => {
        const gy = found.gy + 1 + i * 2;
        for (const dx of [6, 10]) {
            const gx = found.gx + dx;
            if (!placeBuilding(gx, gy, kind, 1, { ignorePlacementRules: true, silent: true, autoUpgradeEnabled: false, buildEnabled: true })) return;
            const it = grid[gy][gx].item;
            it.underConstruction = false; it.energy = it.maxEnergy; it.level = 1; markConstructionComplete(it);
            traps.push(gy * GRID_W + gx);
        }
        const u = new Unit('norm', 0, found.gx * TILE + 16, gy * TILE + 16); units.push(u); updateUnitSpatial(u);
        out.lanes.push({ kind, id: u.id, gy, eff: effectOf[kind] });
    });
    for (let t = 0; t < 3; t++) gameTick();
    const ids = out.lanes.map(l => l.id);
    for (const l of out.lanes) processAction({ action: 'move', unitIds: [l.id], targetX: (found.gx + 16) * TILE + 16, targetY: l.gy * TILE + 16 }, 0);
    const seen = {};
    for (let t = 0; t < 120; t++) {
        gameTick();
        for (const l of out.lanes) { const u = units.find(v => v.id === l.id); if (!u) continue; if (u[l.eff] > 0) seen[l.kind] = Math.max(seen[l.kind] || 0, u[l.eff]); if (traps.includes(Math.floor(u.y / TILE) * GRID_W + Math.floor(u.x / TILE))) l.crossed = true; }
    }
    out.seen = seen;
    // Unit.update calls of the lane units standing on a trap tile.
    let onTrap = 0;
    for (const [k, n] of updCalls) { const [id, t] = k.split(':').map(Number); if (ids.includes(id) && traps.includes(t)) onTrap += n; }
    out.onTrapUpdates = onTrap;
    out.lanesArrived = out.lanes.map(l => { const u = units.find(v => v.id === l.id); return u ? Math.floor(u.x / TILE) - found.gx : -1; });
    return out;
})())`));
assert.ok(!r.err, r.err);
// (Lanes whose unit stepped on a trap tile: the navigation may route a
// unit around a trap.)
const crossed = r.lanes.filter(l => l.crossed);
assert.ok(crossed.length >= 3, 'lanes crossing a trap: ' + crossed.map(l => l.kind));
for (const l of crossed) assert.ok(r.seen[l.kind] > 0, l.kind + ' applied ' + l.eff + ': ' + JSON.stringify(r.seen));
console.log('trap statuses', JSON.stringify(r.seen), 'Unit.update calls on trap tiles', r.onTrapUpdates, 'columns walked', JSON.stringify(r.lanesArrived));
assert.ok(r.onTrapUpdates <= 2, 'units on trap tiles handed to Unit.update: ' + r.onTrapUpdates);
console.log('PASS: floor traps applied by the movement kernel');
