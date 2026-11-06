'use strict';
// q / e (resizeUnitGroup by wasm/src/k.rs k_unit_resize): per subgroup (type
// and level) d2 halves the units (a single one stays), x2 doubles them
// (within the stacks and the population room); a subgroup's stacks stay the
// same, its energy never grows and fits the new maxEnergy, every unit's
// level is its stacks' and its maxEnergy its type's at that level.
// Usage: node tests/unit-resize-kernel.test.cjs
const assert = require('node:assert/strict'), H = require('./net-harness.cjs');
globalThis.self = { crossOriginIsolated: true };
const controls = { ...H.SMALL_MATCH_CONTROLS, 'cfg-mapsize': '120', 'cfg-map-type': 'arena', 'cfg-max-pop': '20000' };
const world = new H.World({ controls }), i = world.spawn('rs', { controls, simWorker: false });
i.eval('startSoloGame();');
const r = JSON.parse(i.eval(`(() => {
    const cx = Math.floor(GRID_W / 2), cy = Math.floor(GRID_H / 2), mk = [];
    for (let k = 0; k < 90; k++) {
        const t = findNearestWalkable(cx + (k % 9) - 4, cy + Math.floor(k / 9) - 5);
        const u = new Unit(k % 3 ? 'norm' : 'tank', 0, t.x * TILE + 16, t.y * TILE + 16);
        u.stackCount = 4; units.push(u); updateUnitSpatial(u); mk.push(u);
    }
    for (let k = 0; k < 3; k++) gameTick();
    const sub = () => { const m = new Map(); for (const u of units) if (u && !u.dead && u.owner === 0 && (u.unitType === 'norm' || u.unitType === 'tank')) {
        const key = u.unitType, e = m.get(key) || { n: 0, st: 0, en: 0, bad: 0 };
        e.n++; e.st += u.stackCount; e.en += u.energy;
        if (u.unitLevel !== stackCountToLevel(u.stackCount) || u.energy > u.maxEnergy + 1e-3 || u.maxEnergy !== Math.max(1, Math.floor(getUnitStatForOwner(0, u.unitType, u.unitLevel, 'energy')))) e.bad++;
        m.set(key, e); } return Object.fromEntries(m); };
    const before = sub(), room = Math.max(0, getPlayerPopCap(0) - players[0].popCount);
    const ids = () => units.filter(u => u && !u.dead && u.owner === 0 && (u.unitType === 'norm' || u.unitType === 'tank')).map(u => u.id);
    processActions([{ action: 'resizeUnitGroup', unitIds: ids(), mode: 'x2', bySub: true, byLevel: false }], 0);
    const afterX2 = sub();
    gameTick();
    processActions([{ action: 'resizeUnitGroup', unitIds: ids(), mode: 'd2', bySub: true, byLevel: false }], 0);
    gameTick();
    const afterD2 = sub();
    return JSON.stringify({ before, afterX2, afterD2, room }); })()`));
for (const t of ['norm', 'tank']) {
    const b = r.before[t], x = r.afterX2[t], d = r.afterD2[t];
    assert.ok(x.n >= b.n && x.n <= Math.min(b.st, 2 * b.n), t + ' x2 within its stacks and double ' + JSON.stringify(r));
    assert.equal(x.st, b.st, t + ' x2 keeps the stacks');
    assert.ok(x.en <= b.en + 1e-3, t + ' x2 energy no more');
    assert.equal(d.n, Math.floor(x.n / 2), t + ' d2 halves');
    assert.equal(d.st, x.st, t + ' d2 keeps the stacks');
    assert.ok(d.en <= x.en + 1e-3, t + ' d2 energy no more');
    assert.equal(x.bad + d.bad, 0, t + ' levels and maxEnergy from the stacks ' + JSON.stringify(r));
}
const want = Math.min(r.room, ['norm', 'tank'].reduce((s, k) => s + Math.min(r.before[k].st, 2 * r.before[k].n) - r.before[k].n, 0));
assert.equal(['norm', 'tank'].reduce((s, k) => s + r.afterX2[k].n - r.before[k].n, 0), want, 'x2 spawns what the population room allows');
assert.deepEqual(i.errors.map(String), []);
console.log('PASS: q / e by k_unit_resize', JSON.stringify(r));
