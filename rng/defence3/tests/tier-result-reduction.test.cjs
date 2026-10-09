'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
// (The kernels are Rust: the wasm module and its heap, the arrays in it with
// their production types, worker.js _hcArr / _wsArr.)
const source = ['sim_parallel.js', 'sim_wasm_bin.js', 'sim_wasm.js'].map(f => fs.readFileSync(path.join(__dirname, '../src/sim', f), 'utf8')).join('\n');
const ctx = vm.createContext({ self: { crossOriginIsolated: true }, console });
vm.runInContext(source + '\nglobalThis.scan = SIM_KERNELS[SIM_KERNEL_HEAL_CAND]; globalThis.merge = SIM_KERNELS[SIM_KERNEL_HEAL_REDUCE]; globalThis.order = SIM_KERNELS[SIM_KERNEL_WS_ORDER];', ctx);
assert.ok(vm.runInContext('simWasmInit()', ctx), 'wasm module');
const heap = (name, type, n) => { const a = vm.runInContext(`(() => { const a = simHeapArray(${type}, ${Math.max(1, n)}); simParallelBind(${JSON.stringify(name)}, a); return a; })()`, ctx); return a; };
const f32 = Math.fround;

// Independent whole-world oracle, including ties, dead/retired slots,
// empty owners, and different slot orders/chunk boundaries after restore.
for (const per of [7, 37, 1000]) for (const reverse of [false, true]) {
    const n = 237, np = 5, K = 12, chunks = Math.ceil(n / per);
    const R = {
        'hc.e': heap('hc.e', 'Float32Array', n), 'hc.m': heap('hc.m', 'Float32Array', n), 'hc.o': heap('hc.o', 'Int16Array', n),
        'hc.id': heap('hc.id', 'Int32Array', n), 'hc.l': heap('hc.l', 'Uint8Array', n), 'hc.d': heap('hc.d', 'Uint8Array', n)
    };
    for (let s = 0; s < n; s++) {
        const id = reverse ? n - s : s + 1;
        R['hc.id'][s] = id; R['hc.e'][s] = id % 11; R['hc.m'][s] = 10;
        R['hc.o'][s] = id % 4; R['hc.l'][s] = id % 13 !== 0 ? 1 : 0; R['hc.d'][s] = id % 17 === 0 ? 1 : 0;
    }
    R['hc.res'] = heap('hc.res', 'Int32Array', chunks * np * K); R['hc.rat'] = heap('hc.rat', 'Float32Array', chunks * np * K);
    R['hc.best'] = heap('hc.best', 'Int32Array', np * K); R['hc.bestRat'] = heap('hc.bestRat', 'Float32Array', np * K);
    for (let ch = chunks - 1; ch >= 0; ch--) ctx.scan(R, [n, per, np, K], ch);
    const ratio = s => f32(R['hc.e'][s] / R['hc.m'][s]);
    for (let o = 0; o < np; o++) {
        ctx.merge(R, [chunks, np, K], o);
        const want = Array.from({ length: n }, (_, s) => s).filter(s => R['hc.l'][s] && !R['hc.d'][s] && R['hc.o'][s] === o && R['hc.e'][s] > 0 && R['hc.e'][s] < R['hc.m'][s])
            .sort((a, b) => ratio(a) - ratio(b) || R['hc.id'][a] - R['hc.id'][b]).slice(0, K);
        const got = Array.from(R['hc.best'].subarray(o * K, (o + 1) * K)).filter(s => s >= 0);
        assert.deepEqual(got, want, `per ${per}${reverse ? ' reversed' : ''}, owner ${o}`);
        for (let k = 0; k < got.length; k++) assert.equal(R['hc.bestRat'][o * K + k], ratio(got[k]));
    }
}
// Ignore chunk padding and empty replies; include healer-only replies.
const W = (name, values) => { const a = heap(name, 'Int32Array', values.length); a.set(values); return a; };
const R = { 'ws.rcnt': W('ws.rcnt', [2, 3]), 'ws.rkind': W('ws.rkind', [1, 4, 0, 0, 3, 1, 4, 0]),
    'ws.rid': W('ws.rid', [70, 10, 0, 0, 30, 20, 40, 0]), 'ws.res': W('ws.res', new Array(48).fill(-1)),
    'ws.ures': W('ws.ures', new Array(24).fill(-1)), 'ws.order': W('ws.order', new Array(8).fill(0)), 'ws.orderCount': W('ws.orderCount', [0]) };
R['ws.res'][0] = 1; R['ws.ures'][3] = 0; R['ws.res'][24] = 2;
ctx.order(R, [2, 4, 6, 4], 0);
assert.deepEqual(Array.from(R['ws.order'].subarray(0, R['ws.orderCount'][0])), [1, 4, 0]);
console.log('PASS: healer top-K matches full-sort oracle across slot layouts; worker replies ordered without padding/empty results.');
