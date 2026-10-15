// The units' columns and a full wasm heap (sim_unit_state.js
// simUnitStateReserve, _simUnitStateGrow, simUnitPopulationSlots;
// sim_wasm.js simHeapRoom, simHeapHas). A column the heap could not hold
// was made outside it, where no Rust kernel reads it: every kernel over it
// failed each tick, for good (a restore kept the columns). Now:
// - a small map's match reserves what the map plausibly holds, not every
//   player's maximum population (~500 MB of columns per match: a test
//   process of many matches ran out of memory);
// - a reservation the heap has no room for is made smaller (the slots
//   needed), never outside the heap;
// - columns left outside it (as an earlier build made them) are made again
//   in the heap at the next reservation (a restore's), and the ticks run.
//   node tests/heap-full-reserve.test.cjs
'use strict';
const assert = require('node:assert/strict');
const H = require('./net-harness.cjs');

const world = new H.World({ controls: { ...H.SMALL_MATCH_CONTROLS } });
const inst = world.spawn('full', { simWorker: false });
inst.eval('startSoloGame();');
const run = async ms => { await world.run(ms); };
(async () => {
    await run(2000);
    const start = JSON.parse(inst.eval(`JSON.stringify({ cap: _simUnitState.cap, grid: GRID_W * GRID_H, pop: getConfiguredMaxPop(), units: units.length,
        heapMB: _simHeap.memory.buffer.byteLength / 1048576, outside: _simUnitColumnsOutside(_simUnitState), ticks: currentTick })`));
    console.log('start', JSON.stringify(start));
    assert.ok(start.ticks > 10, 'the match runs');
    assert.ok(start.cap <= Math.max(4096, Math.ceil(start.grid * 8 / 4096) * 4096), 'a 20x20 map reserves what it holds, not ' + start.pop + ' a player: ' + start.cap);
    assert.ok(start.heapMB < 128, 'the heap stays small: ' + start.heapMB + ' MB');
    assert.equal(start.outside, false);

    // The heap cannot grow any more (the system's memory used up): a big
    // reservation is made smaller, in the heap.
    const full = JSON.parse(inst.eval(`JSON.stringify((() => {
        const M = _simHeap.memory;
        M.grow = () => { throw new RangeError('out of memory (test)'); };
        const before = _simUnitState.cap;
        simUnitStateReserve(16, 2000000);
        return { before, cap: _simUnitState.cap, outside: _simUnitColumnsOutside(_simUnitState) };
    })())`));
    console.log('heap full, a reservation of 2M', JSON.stringify(full));
    assert.equal(full.outside, false, 'no column outside the heap');
    assert.ok(full.cap < 2000000, 'the reservation made smaller');
    await run(1000);
    assert.deepEqual(inst.errors.map(e => String(e.message || e).slice(0, 200)), [], 'ticks run');

    // Columns outside the heap (what a full heap made before): a reservation
    // made later, with room again (a restore's), makes them again in the
    // heap, and the kernels run.
    const fixed = JSON.parse(inst.eval(`JSON.stringify((() => {
        const S = _simUnitState, cap = S.cap + 4096;
        // (The heap filled up, then the columns grown as the old growth did:
        // outside it.)
        const fill = [];
        for (;;) { const a = simHeapArray(Uint8Array, 1 << 20); if (!simHeapHas(a)) break; fill.push(a); }
        _simUnitStateGrow(S, cap, cap);
        const broken = _simUnitColumnsOutside(S);
        let threw = null;
        try { gameTick(); } catch (e) { threw = String(e.message || e).slice(0, 120); }
        delete _simHeap.memory.grow;
        for (const a of fill) simHeapFree(a);
        simUnitStateReserve(units.length, simUnitPopulationSlots());
        return { broken, threw, outside: _simUnitColumnsOutside(S), cap: S.cap };
    })())`));
    console.log('columns outside, then a reservation with room', JSON.stringify(fixed));
    assert.equal(fixed.broken, true, 'the test made columns outside the heap');
    assert.ok(fixed.threw && /Rust kernel cannot run/.test(fixed.threw), 'a kernel over them fails: ' + fixed.threw);
    assert.equal(fixed.outside, false, 'made again in the heap');
    inst.errors.length = 0;
    const t0 = inst.eval('currentTick');
    await run(1500);
    assert.ok(inst.eval('currentTick') > t0 + 10, 'ticks go on');
    assert.deepEqual(inst.errors.map(e => String(e.message || e).slice(0, 200)), [], 'no kernel fails after');
    console.log('PASS heap-full-reserve');
})().catch(e => { console.error(e); process.exit(1); });
