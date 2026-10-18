// The unit index built by its changes (SIM_KERNEL_IXD_*, chunk.js
// spatialIndexPrebuild) lists the same entries in the same order as a sort
// by (chunk, unit id), with each chunk's range and owner bits, tick
// after tick while units move, die and are added (slots given to new
// units), on several maps; and most builds are by changes (units added
// outside a tick, as here, have the next two built whole).
//   node tests/index-delta.test.cjs
'use strict';
const assert = require('node:assert/strict');
const H = require('./net-harness.cjs');
for (const [map, seed] of [['arena', 3], ['islands', 7], ['crossroads', 11]]) {
    const world = new H.World({ controls: { ...H.SMALL_MATCH_CONTROLS, 'cfg-mapsize': '80', 'cfg-map-type': map } });
    const inst = world.spawn('ixd' + map, { simWorker: false });
    inst.eval('startSoloGame();');
    inst.eval('SPATIAL_PARALLEL_MIN_UNITS = 0; SEPARATION_SLOT_MIN_UNITS = 0;');
    const r = JSON.parse(inst.eval(`JSON.stringify((() => {
        let s = ${seed};
        const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
        const spawn = k => { for (let i = 0; i < k; i++) { const t = findNearestWalkable(2 + Math.floor(rnd() * (GRID_W - 4)), 2 + Math.floor(rnd() * (GRID_H - 4))); const u = new Unit(i % 5 === 0 ? 'tank' : 'norm', i & 1, t.x * TILE + 4 + rnd() * 24, t.y * TILE + 4 + rnd() * 24); units.push(u); unitSlotMapPushed(u); updateUnitSpatial(u); } };
        spawn(2500);
        let deltas = 0, fulls = 0, checks = 0, bad = '';
        for (let t = 0; t < 260 && !bad; t++) {
            if (t % 20 === 0) for (const p of [0, 1]) processAction({ action: 'move', unitIds: units.filter(u => !u.dead && u.owner === p && rnd() < 0.7).map(u => u.id), targetX: rnd() * GRID_W * TILE, targetY: rnd() * GRID_H * TILE }, p);
            if (t % 7 === 3) for (const u of units) if (!u.dead && rnd() < 0.01) { u.energy = 0; u.dead = true; }
            if (t % 11 === 5) spawn(40);
            gameTick();
            const X = _sxPar, J = _sxPre;
            if (!J || !X) continue;
            if (J.delta) deltas++; else fulls++;
            // (The prebuild ran at once, without helpers: what it lists now,
            // from the units as they stand.)
            const C = _simUnitState.columns, nChunks = CHUNKS_W * CHUNKS_H, want = [];
            for (let i = 0; i < units.length; i++) {
                const u = units[i];
                if (!u || !u._us || u.dead) continue;
                const sl = u._si;
                let gx = Math.floor(C.x[sl] / 8 / TILE), gy = Math.floor(C.y[sl] / 8 / TILE);
                gx = Math.max(0, Math.min(GRID_W - 1, gx)); gy = Math.max(0, Math.min(GRID_H - 1, gy));
                want.push([gy * GRID_W + gx, i, sl, C.id[sl]]);
            }
            want.sort((a, b) => a[0] - b[0] || a[3] - b[3]);
            const listed = X.listed[0];
            checks++;
            if (listed !== want.length) { bad = 'tick ' + t + (J.delta ? ' delta' : ' full') + ': listed ' + listed + ' want ' + want.length; break; }
            for (let p = 0; p < listed && !bad; p++) {
                const [k, , sl, id] = want[p];
                if (_sxESlot[p] !== sl || _sxEKey[p] !== k || _sxEId[p] !== id) bad = 'tick ' + t + (J.delta ? ' delta' : ' full') + ' pos ' + p + ': slot ' + _sxESlot[p] + '/' + sl + ' key ' + _sxEKey[p] + '/' + k + ' id ' + _sxEId[p] + '/' + id;
                if (!bad && (p === 0 || want[p - 1][0] !== k)) {
                    let e = p; while (e < listed && want[e][0] === k) e++;
                    if (X.stamp[k] !== J.ep || X.start[k] !== p || X.cnt[k] !== e - p) bad = 'tick ' + t + ' chunk ' + k + ': stamp ' + X.stamp[k] + '/' + J.ep + ' start ' + X.start[k] + '/' + p + ' cnt ' + X.cnt[k] + '/' + (e - p);
                    if (!bad && J.masks) {
                        let m = 0; for (let q = p; q < e; q++) { const o = C.owner[want[q][2]]; m |= o >= 0 && o < 8 ? 1 << o : 0xFF; }
                        if (_combatScanOwnerMask[k] !== m) bad = 'tick ' + t + ' chunk ' + k + ': owners ' + _combatScanOwnerMask[k] + '/' + m;
                    }
                }
            }
        }
        return { deltas, fulls, checks, bad, units: units.length };
    })())`));
    assert.equal(r.bad, '', map);
    assert.ok(r.checks > 100 && r.deltas > r.checks * 0.7, map + ': ' + r.deltas + ' by changes, ' + r.fulls + ' whole, ' + r.checks + ' checks');
    console.log(map, r.checks, 'ticks checked,', r.deltas, 'by changes,', r.fulls, 'whole,', r.units, 'units');
}
console.log('PASS: the unit index by its changes equals the sorted one');
