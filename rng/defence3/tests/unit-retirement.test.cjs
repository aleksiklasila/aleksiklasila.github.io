'use strict';
const assert = require('node:assert/strict');
const H = require('./net-harness.cjs');
const world = new H.World({ controls: H.SMALL_MATCH_CONTROLS });
const inst = world.spawn('retirement', { simWorker: false });
inst.eval('startSoloGame();');
const result = JSON.parse(inst.eval(`JSON.stringify((() => {
    for (let i = 0; i < 17000; i++) { const u = new Unit('norm', 0, 100, 100); units.push(u); }
    const original = units.slice(), dead = [3, 4, 8191, 8192, units.length - 1];
    for (const i of dead) { units[i].dead = true; units[i]._removedNow = true; }
    selectedUnits = [units[3], units[6], units[8192]];
    const want = original.filter((u, i) => !dead.includes(i)).map(u => u.id);
    const blocks = unitRetirePrepare(), got = [];
    for (let b = 0; b < blocks; b++) for (let j = 0; j < _unitRetireCounts[b]; j++) got.push(_unitRetireList[b * UNIT_RETIRE_BLOCK + j]);
    // Isolate lifecycle processing from combat/movement in this dense fixture.
    _forEachUnitInTickOrder = () => {}; simMoveRun = () => {}; combatScanRun = () => {};
    separationStart = () => {}; runUnitSeparationPass = () => {};
    gameTick();
    const slots = _unitSlotMapEnsure();
    return { got, dead, want, ids: units.map(u => u.id), selected: selectedUnits.map(u => u.id),
        kept: original[6].id, slotsMatch: units.every((u, i) => slots[i] === u._si) };
})())`));
assert.deepEqual(result.got, result.dead);
// (Dead units leave by swap-removal, O(1) each: the order changes alike on
// every peer; exactly the survivors remain.)
assert.deepEqual(result.ids.slice().sort((a, b) => a - b), result.want.slice().sort((a, b) => a - b), 'compaction keeps exactly the survivors');
assert.equal(new Set(result.ids).size, result.ids.length, 'no unit listed twice');
assert.deepEqual(result.selected, [result.kept]);
assert.equal(result.slotsMatch, true);
assert.deepEqual(inst.errors.map(String), []);
console.log('PASS: sparse retirement across block boundaries keeps the survivors, selections, and slot mapping.');
