'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const ctx = vm.createContext({});
vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/sim/sim_parallel.js'), 'utf8') +
    '\nglobalThis.scan = SIM_KERNELS[SIM_KERNEL_HEAL_CAND]; globalThis.merge = SIM_KERNELS[SIM_KERNEL_HEAL_REDUCE]; globalThis.order = SIM_KERNELS[SIM_KERNEL_WS_ORDER];', ctx);

// Independent whole-world oracle, including ties, dead/retired slots,
// empty owners, and different slot orders/chunk boundaries after restore.
for (const per of [7, 37, 1000]) for (const reverse of [false, true]) {
    const n = 237, np = 5, K = 12, chunks = Math.ceil(n / per), R = {};
    for (const k of ['e', 'm', 'o', 'id', 'l', 'd']) R['hc.' + k] = new Float64Array(n);
    for (let s = 0; s < n; s++) {
        const id = reverse ? n - s : s + 1;
        R['hc.id'][s] = id; R['hc.e'][s] = id % 11; R['hc.m'][s] = 10;
        R['hc.o'][s] = id % 4; R['hc.l'][s] = id % 13 !== 0; R['hc.d'][s] = id % 17 === 0;
    }
    R['hc.res'] = new Int32Array(chunks * np * K); R['hc.rat'] = new Float64Array(chunks * np * K);
    R['hc.best'] = new Int32Array(np * K); R['hc.bestRat'] = new Float64Array(np * K);
    for (let ch = chunks - 1; ch >= 0; ch--) ctx.scan(R, [n, per, np, K], ch);
    for (let o = 0; o < np; o++) {
        ctx.merge(R, [chunks, np, K], o);
        const want = Array.from({ length: n }, (_, s) => s).filter(s => R['hc.l'][s] && !R['hc.d'][s] && R['hc.o'][s] === o && R['hc.e'][s] > 0 && R['hc.e'][s] < R['hc.m'][s])
            .sort((a, b) => R['hc.e'][a] / R['hc.m'][a] - R['hc.e'][b] / R['hc.m'][b] || R['hc.id'][a] - R['hc.id'][b]).slice(0, K);
        const got = Array.from(R['hc.best'].subarray(o * K, (o + 1) * K)).filter(s => s >= 0);
        assert.deepEqual(got, want);
        for (let k = 0; k < got.length; k++) assert.equal(R['hc.bestRat'][o * K + k], R['hc.e'][got[k]] / R['hc.m'][got[k]]);
    }
}
// Ignore chunk padding and empty replies; include healer-only replies.
const R = { 'ws.rcnt': Int32Array.from([2, 3]), 'ws.rkind': Int32Array.from([1, 4, 0, 0, 3, 1, 4, 0]),
    'ws.rid': Int32Array.from([70, 10, 0, 0, 30, 20, 40, 0]), 'ws.res': new Int32Array(48).fill(-1),
    'ws.ures': new Int32Array(24).fill(-1), 'ws.order': new Int32Array(8), 'ws.orderCount': new Int32Array(1) };
R['ws.res'][0] = 1; R['ws.ures'][3] = 0; R['ws.res'][24] = 2;
ctx.order(R, [2, 4, 6, 4], 0);
assert.deepEqual(Array.from(R['ws.order'].subarray(0, R['ws.orderCount'][0])), [1, 4, 0]);
console.log('PASS: healer top-K matches full-sort oracle across slot layouts; worker replies ordered without padding/empty results.');
