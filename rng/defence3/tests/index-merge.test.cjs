// The unit index built by merging the last index (SIM_KERNEL_INDEX_MERGE,
// chunk.js spatialIndexPrebuild) lists the same entries in the same order
// as a sort by (chunk, units index), tick after tick while units move, die
// and are added (slots given to new units), on several maps.
//   node tests/index-merge.test.cjs
'use strict';
const assert = require('node:assert/strict');
const H = require('./net-harness.cjs');
for (const [map, seed] of [['arena', 3], ['islands', 7], ['crossroads', 11]]) {
    const world = new H.World({ controls: { ...H.SMALL_MATCH_CONTROLS, 'cfg-mapsize': '80', 'cfg-map-type': map } });
    const inst = world.spawn('ixm' + map, { simWorker: false });
    inst.eval('startSoloGame();');
    inst.eval('SPATIAL_PARALLEL_MIN_UNITS = 0; SEPARATION_SLOT_MIN_UNITS = 0;');
    const r = JSON.parse(inst.eval(`JSON.stringify((() => {
        let s = ${seed};
        const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
        const spawn = k => { for (let i = 0; i < k; i++) { const t = findNearestWalkable(2 + Math.floor(rnd() * (GRID_W - 4)), 2 + Math.floor(rnd() * (GRID_H - 4))); const u = new Unit(i % 5 === 0 ? 'tank' : 'norm', i & 1, t.x * TILE + 4 + rnd() * 24, t.y * TILE + 4 + rnd() * 24); units.push(u); updateUnitSpatial(u); } };
        spawn(2500);
        let merges = 0, checks = 0, bad = '';
        { const f = SIM_KERNELS[SIM_KERNEL_INDEX_MERGE]; SIM_KERNELS[SIM_KERNEL_INDEX_MERGE] = function () { merges++; return f.apply(this, arguments); }; }
        for (let t = 0; t < 260 && !bad; t++) {
            if (t % 20 === 0) for (const p of [0, 1]) processAction({ action: 'move', unitIds: units.filter(u => !u.dead && u.owner === p && rnd() < 0.7).map(u => u.id), targetX: rnd() * GRID_W * TILE, targetY: rnd() * GRID_H * TILE }, p);
            if (t % 7 === 3) for (const u of units) if (!u.dead && rnd() < 0.01) { u.energy = 0; u.dead = true; }
            if (t % 11 === 5) spawn(40);
            gameTick();
            const X = _sxPar;
            if (!_sxPre || !X) continue;
            // (The prebuild ran at once, without helpers.)
            const n = _sxPre.n, keys = X.keys, slots = _unitSlotMap.slots, nChunks = CHUNKS_W * CHUNKS_H;
            const want = [];
            for (let i = 0; i < n; i++) if (keys[i] < nChunks) want.push(i);
            want.sort((a, b) => keys[a] - keys[b] || a - b);
            const listed = X.listed[0];
            checks++;
            if (listed !== want.length) { bad = 'tick ' + t + ': listed ' + listed + ' want ' + want.length; break; }
            for (let p = 0; p < listed; p++) {
                const i = want[p];
                if (_sxESlot[p] !== slots[i] || _sxEKey[p] !== keys[i]) { bad = 'tick ' + t + ' pos ' + p + ': slot ' + _sxESlot[p] + '/' + slots[i] + ' key ' + _sxEKey[p] + '/' + keys[i]; break; }
            }
        }
        return { merges, checks, bad, units: units.length };
    })())`));
    assert.equal(r.bad, '', map);
    assert.ok(r.merges > 100 && r.checks > 100, map + ' merges ' + r.merges + ' checks ' + r.checks);
    console.log(map, r.checks, 'ticks checked,', r.merges, 'merged builds,', r.units, 'units');
}
console.log('PASS: merged unit index equals the sorted one');
