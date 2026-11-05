'use strict';
const assert = require('node:assert/strict');
const H = require('./net-harness.cjs');
// (A map with room: units cannot overlap on the occupancy raster, and one refused a place is dead.)
const world = new H.World({ controls: { ...H.SMALL_MATCH_CONTROLS, 'cfg-mapsize': '200', 'cfg-map-type': 'arena' } });
const inst = world.spawn('retirement', { simWorker: false });
inst.eval('startSoloGame();');
const result = JSON.parse(inst.eval(`JSON.stringify((() => {
    for (let i = 0; i < 17000; i++) { const u = new Unit('norm', 0, 400 + (i % 130) * 14, 400 + Math.floor(i / 130) * 14); units.push(u); }
    const original = units.slice(), dead = [3, 4, 8191, 8192, units.length - 1];
    const stale = original[dead[0]];
    const workerRecord = simUnitWk(stale._us, stale._si), workerPool = _simUnitState.wk;
    const freeStack = workerPool.free;
    // Fractional coordinates are still exact after the slot is released.
    stale.x += 0.125;
    stale.y += 0.375;
    const retiredPosition = [stale.id, stale.owner, stale.x, stale.y];
    for (const i of dead) { units[i].dead = true; units[i]._removedNow = true; }
    selectedUnits = [units[3], units[6], units[8192]];
    const want = original.filter((u, i) => !dead.includes(i)).map(u => u.id);
    const blocks = unitRetirePrepare(), got = [];
    for (let b = 0; b < blocks; b++) for (let j = 0; j < _unitRetireCounts[b]; j++) got.push(_unitRetireList[b * UNIT_RETIRE_BLOCK + j]);
    // Isolate lifecycle processing from combat/movement in this dense fixture.
    _forEachUnitInTickOrder = () => {}; simMoveRun = () => {}; combatScanRun = () => {};
    separationStart = () => {}; runUnitSeparationPass = () => {};
    gameTick();
    const detached = [stale.id, stale.owner, stale.x, stale.y];
    const deadAndEmpty = stale.dead === true && stale.energy === 0;
    stale.x = 17.123;
    stale.y = undefined;
    const detachedWrites = stale.x === 17.123 && stale.y === undefined;
    const slots = _unitSlotMapEnsure();
    const workerRecordReleased = workerPool.free === freeStack
        && freeStack.subarray(0, workerPool.freeCount).includes(workerRecord);
    return { got, dead, want, ids: units.map(u => u.id), selected: selectedUnits.map(u => u.id),
        kept: original[6].id, slotsMatch: units.every((u, i) => slots[i] === u._si),
        retiredPosition, detached, deadAndEmpty, detachedWrites, workerRecordReleased };
})())`));
assert.deepEqual(result.got, result.dead);
// (Dead units leave by swap-removal, O(1) each: the order changes alike on
// every peer; exactly the survivors remain.)
assert.deepEqual(result.ids.slice().sort((a, b) => a - b), result.want.slice().sort((a, b) => a - b), 'compaction keeps exactly the survivors');
assert.equal(new Set(result.ids).size, result.ids.length, 'no unit listed twice');
assert.deepEqual(result.selected, [result.kept]);
assert.equal(result.slotsMatch, true);
assert.deepEqual(result.detached, result.retiredPosition);
assert.equal(result.deadAndEmpty, true);
assert.equal(result.detachedWrites, true);
assert.equal(result.workerRecordReleased, true);
assert.deepEqual(inst.errors.map(String), []);
console.log('PASS: sparse retirement across block boundaries keeps the survivors, selections, and slot mapping.');
