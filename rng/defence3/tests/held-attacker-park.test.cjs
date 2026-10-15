// Held units with an order to attack something out of their range (a hold
// never chases) are parked between their acquisition ticks
// (unit.js simMoveTryParkHeldAttacker): Unit.update runs for them about one
// tick in SIM_ACQUIRE_TICKS, not every tick; an enemy stepping into their
// range is still shot within those ticks; released (stop), their order goes
// on at once.
//   node tests/held-attacker-park.test.cjs
'use strict';
const assert = require('node:assert/strict');
const H = require('./net-harness.cjs');
const world = new H.World({ controls: { ...H.SMALL_MATCH_CONTROLS, 'cfg-mapsize': '120', 'cfg-map-type': 'arena', 'cfg-full-vis': 'full' } });
const inst = world.spawn('held', { simWorker: false });
inst.eval('startSoloGame();');
const r = JSON.parse(inst.eval(`JSON.stringify((() => {
    gameTick();
    const free = (gx, gy) => { const c = grid[gy][gx]; return c.type === TYPE_FLOOR && !c.item && !getTileEntityRef(gx, gy); };
    // A hostile barrack far off.
    let bx = 95, by = 95;
    while (!free(bx, by)) bx--;
    placeBuilding(bx, by, 'barrack_norm', 1, { ignorePlacementRules: true, silent: true });
    const b = getTileEntityRef(bx, by) || grid[by][bx].item;
    b.underConstruction = false; b.energy = b.maxEnergy;
    // (In sight of player 0: a watch tower of its own beside it.)
    let wx = bx - 3;
    while (!free(wx, by)) wx--;
    placeBuilding(wx, by, 'watch_tower', 0, { ignorePlacementRules: true, silent: true });
    const wt = getTileEntityRef(wx, by) || grid[by][wx].item;
    if (wt) { wt.underConstruction = false; wt.energy = wt.maxEnergy; if (wt.updateStats) wt.updateStats(); }
    // Thirty units of player 0, as a barrack spawns them.
    const ids = [];
    for (let i = 0; ids.length < 30 && i < 200; i++) {
        const gx = 20 + (i % 6), gy = 20 + Math.floor(i / 6);
        if (!free(gx, gy)) continue;
        const u = new Unit('norm', 0, gx * TILE + 16, gy * TILE + 16);
        configureWorkerUnitFromType(u); applyUnitLevelScaling(u, 1); u.energy = u.maxEnergy;
        units.push(u); unitSlotMapPushed(u); players[0].popCount++; ids.push(u.id);
    }
    const idSet = new Set(ids);
    for (let t = 0; t < 3; t++) gameTick();
    processActions([{ action: 'attackBuilding', unitIds: ids, targetGx: bx, targetGy: by }], 0);
    gameTick();
    processActions([{ action: 'hold', unitIds: ids }], 0);
    for (let t = 0; t < 4; t++) gameTick();
    let calls = 0;
    const f = Unit.prototype.update;
    Unit.prototype.update = function () { if (idSet.has(this.id)) calls++; return f.apply(this, arguments); };
    for (let t = 0; t < 40; t++) gameTick();
    const holdCalls = calls;
    const live = ids.map(id => getUnitById(id)).filter(u => u && !u.dead);
    const parked = live.filter(u => u._us.mvOn[u._si] === 2).length;
    const holding = live.filter(u => u.holdPosition && u.commandState === CMD_ATTACKING && u.targetBuilding === b).length;
    // An enemy beside the group.
    const c = live[Math.floor(live.length / 2)];
    const foe = new Unit('tank', 1, c.x + 6, c.y + 2);
    configureWorkerUnitFromType(foe); applyUnitLevelScaling(foe, 1); foe.energy = foe.maxEnergy;
    units.push(foe); unitSlotMapPushed(foe); players[1].popCount++;
    const e0 = foe.energy;
    let hitAt = -1;
    for (let t = 0; t < 12; t++) { gameTick(); if (hitAt < 0 && (foe.dead || foe.energy < e0)) hitAt = t; }
    // Released: on toward the barrack at once.
    const pos0 = live.map(u => [u.x, u.y]);
    processActions([{ action: 'stop', unitIds: ids }], 0);
    for (let t = 0; t < 6; t++) gameTick();
    const moved = live.filter((u, i) => !u.dead && (u.x !== pos0[i][0] || u.y !== pos0[i][1])).length;
    Unit.prototype.update = f;
    return { visible: isGameplayTargetVisibleToPlayer(0, bx, by), units: live.length, holding, parked, calls: holdCalls, perUnitTick: holdCalls / live.length / 40, hitAt, moved, P: SIM_ACQUIRE_TICKS };
})())`));
console.log(JSON.stringify(r));
assert.ok(r.units >= 25, 'units: ' + r.units);
assert.equal(r.holding, r.units, 'held with their order to attack the barrack');
assert.ok(r.parked >= r.units * 0.5, 'parked between looks: ' + r.parked);
assert.ok(r.perUnitTick <= 1 / r.P + 0.1, 'Unit.update about once in ' + r.P + ' ticks: ' + r.perUnitTick.toFixed(2));
assert.ok(r.hitAt >= 0 && r.hitAt < r.P + 2, 'an enemy in range shot within an acquisition interval: ' + r.hitAt);
assert.ok(r.moved >= r.units * 0.5, 'released, on toward the target: ' + r.moved);
assert.deepEqual(inst.errors, []);
console.log('PASS: held attackers parked between looks (' + r.perUnitTick.toFixed(2) + ' updates a unit a tick), an enemy shot after ' + r.hitAt + ' ticks, released ones move on');
process.exit(0);
