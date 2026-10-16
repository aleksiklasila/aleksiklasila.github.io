// The detail split's pick (renderer.js _detailPick: the budget best positive
// scores by selection, linear) picks exactly what the bounded heap it
// replaced picked (_detailPickHeap: score first, then the lower index), in
// index order: random scores with many ties, zeros, negatives, NaN and
// Infinity, budgets below, at and above the count.
//   node tests/detail-pick.test.cjs
'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const src = fs.readFileSync(process.env.RENDERER_FILE || path.join(__dirname, '..', 'src/audio_visual/renderer.js'), 'utf8');
const from = src.indexOf('let _detailPickBuf'), to = src.indexOf('const STRUCT_DETAIL_BUDGET');
assert.ok(from > 0 && to > from, 'the functions found');
const c = vm.createContext({});
vm.runInContext(src.slice(from, to) + '\nthis.pick = _detailPick; this.heap = _detailPickHeap;', c);
let seed = 99;
const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
let checks = 0;
for (let round = 0; round < 400; round++) {
    const n = 1 + Math.floor(rnd() * (round < 200 ? 60 : 5000));
    const levels = 1 + Math.floor(rnd() * 12);
    const P = new Float32Array(n);
    for (let i = 0; i < n; i++) {
        const r = rnd();
        P[i] = r < .25 ? 0 : r < .3 ? -1 : r < .32 ? NaN : r < .34 ? Infinity : r < .7 ? Math.floor(rnd() * levels) + .5 : rnd() * 48;
    }
    for (const budget of [0, 1, 7, Math.floor(n / 3), n, n + 5, 600]) {
        assert.deepEqual(c.pick(P, budget), c.heap(P, budget), `round ${round}, n ${n}, budget ${budget}`);
        checks++;
    }
}
console.log('PASS detail-pick: ' + checks + ' picks equal to the heap');
