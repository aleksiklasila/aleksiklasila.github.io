// The area range boxes made for a whole layout by SIM_KERNEL_AREA_BOX (unit.js
// _simMoveAreaBoxes, on the helpers' build lane) equal getAreaRangeTileBox's
// (the BFS over the area graph), every area at every distance, on several
// maps; the empty box is [1, 1, 0, 0] as _simMoveEnsureAreaBox writes it.
//   node tests/area-box-kernel.test.cjs
'use strict';
const assert = require('node:assert/strict');
const H = require('./net-harness.cjs');
for (const map of ['arena', 'islands', 'crossroads', 'random']) {
    const world = new H.World({ controls: { ...H.SMALL_MATCH_CONTROLS, 'cfg-mapsize': '90', 'cfg-map-type': map } });
    const inst = world.spawn('abox' + map, { simWorker: false });
    inst.eval('startSoloGame();');
    const r = JSON.parse(inst.eval(`JSON.stringify((() => {
        gameTick(); gameTick();
        if (_simAreaBoxJob) return { pending: true };
        const D = SIM_MOVE_BOX_STEPS, A = areaDistanceMatrix.length, B = _simMoveAreaBox;
        let bad = 0, first = null, checked = 0;
        for (let a = 0; a < A; a++) for (let d = 0; d < D; d++) {
            _simMoveAreaSource[0] = a;
            const box = getAreaRangeTileBox(_simMoveAreaSource, d), k = (a * D + d) * 4;
            const want = box[2] < 0 ? [1, 1, 0, 0] : [box[0], box[1], box[2], box[3]];
            checked++;
            if (B[k] !== want[0] || B[k + 1] !== want[1] || B[k + 2] !== want[2] || B[k + 3] !== want[3]) { bad++; if (!first) first = { a, d, got: [B[k], B[k + 1], B[k + 2], B[k + 3]], want }; }
        }
        return { A, checked, bad, first, ok: _simMoveAreaBoxOk.every(v => v === 1) };
    })())`));
    assert.ok(!r.pending, map + ': boxes taken');
    assert.equal(r.bad, 0, map + ': ' + JSON.stringify(r.first));
    assert.ok(r.ok && r.A > 1, map);
    console.log(map, r.A, 'areas,', r.checked, 'boxes equal');
}
console.log('PASS: area box kernel');
