// JS vs Rust/wasm timing of kernels on inputs dumped by .claude/kdump.js
// (tickbench EVALALL + DUMPBIN, the guest's calls of one tick): each
// kernel's calls of that tick replayed in order on one thread, JS (plain
// arrays) then wasm (the same arrays copied into the wasm heap and bound),
// repeated; every array either run writes compared after one replay.
//   node .claude/wbench.cjs <dumpdir> <KERNEL_NAME[,KERNEL_NAME...]> [peer=1] [reps=10]
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const dir = process.argv[2], names = process.argv[3].split(','), peer = process.argv[4] || '1', reps = +process.argv[5] || 10;
// (The real global: a vm context's sandboxed globals are slow.)
for (const f of ['sim_parallel.js', 'sim_wasm_bin.js', 'sim_wasm.js'])
    vm.runInThisContext(fs.readFileSync(path.join(__dirname, '../src/sim', f), 'utf8'), { filename: f });
const G = vm.runInThisContext('({ reg: _simParReg, bind: simParallelBind, heap: simHeapArray, init: simWasmInit, K: SIM_KERNELS, kernels: simWasmKernels })');
if (!G.init()) throw new Error('no wasm');
const files = fs.readdirSync(dir);
const median = a => a.slice().sort((x, y) => x - y)[a.length >> 1];
for (const name of names) {
    const src = {}, P = [];
    let calls = null;
    for (const f of files) {
        const m = f.match(/^(\d+)-(.+?)@(.+)\.(\w+Array)\.bin$/);
        if (!m || m[1] !== peer || m[2] !== name) continue;
        const buf = fs.readFileSync(path.join(dir, f)), T = globalThis[m[4]];
        const arr = new T(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
        if (m[3] === 'calls') calls = arr;
        else if (/^P\d+$/.test(m[3])) P[+m[3].slice(1)] = arr;
        else src[m[3]] = arr;
    }
    if (!calls) { console.log(name, ': no dump'); continue; }
    // (An acquisition dump from before the transposed owners: made here,
    // as the tier's first stage would, and the scan told so.)
    if (name === 'SIM_KERNEL_ACQ_SCAN' && !src['acq.omt'] && src['acq.om'] && process.env.OMT !== '0') {
        const Q = P[0], CW = Q[3] | 0, CH = Q[4] | 0, om = src['acq.om'], omt = new Uint8Array(Math.max(1024, CW * CH));
        for (let y = 0; y < CH; y++) for (let x = 0; x < CW; x++) omt[x * CH + y] = om[y * CW + x];
        src['acq.omt'] = omt;
        // (The packed entries, as SIM_KERNEL_ACQ_OMT makes them.)
        const es = src['acq.es'], n2 = es.length, tile = Q[5], GW = Q[15] | 0, GH = Q[16] | 0;
        const EX = new Float64Array(n2), EY = new Float64Array(n2), EO = new Int32Array(n2), EA = new Int32Array(n2), EID = new Int32Array(n2);
        for (let e = 0; e < n2; e++) {
            const q = es[e];
            if (q < 0 || (src['acq.flags'][q] & 1)) { EA[e] = -1; continue; }
            const qx = src['acq.x'][q], qy = src['acq.y'][q], gx = Math.floor(qx / tile), gy = Math.floor(qy / tile);
            EX[e] = qx; EY[e] = qy; EO[e] = src['acq.own'][q] | 0; EID[e] = src['acq.id'][q] | 0;
            const a = gx < 0 || gy < 0 || gx >= GW || gy >= GH ? -1 : src['acq.agrid'][gy * GW + gx];
            EA[e] = a >= 0 ? a : -1;
        }
        Object.assign(src, { 'acq.ex': EX, 'acq.ey': EY, 'acq.eo': EO, 'acq.ea': EA, 'acq.eid': EID });
        for (const q of P) if (q.length < 24) { const z = new Float64Array(64); z.set(q); P[P.indexOf(q)] = z; }
        // (And in the index's order: its entries from the chunk ranges.)
        let ne = 0;
        const rs = src['acq.rs'], rc = src['acq.rc'], rst = src['acq.rst'], ep = Q[6] | 0;
        for (let k = 0; k < rst.length; k++) if (rst[k] === ep && rs[k] + rc[k] > ne) ne = rs[k] + rc[k];
        for (const q of P) { q[21] = 1; if (process.env.BYSLOT !== '1') { q[22] = 1; q[23] = ne; } }
    }
    const fn = G.K[vm.runInThisContext(name)];
    const replay = R => { for (let i = 0; i < calls.length; i += 2) fn(R, P[calls[i + 1]], calls[i]); };
    // JS: fresh plain copies per run.
    const copy = () => { const R = {}; for (const k in src) R[k] = src[k].slice(); return R; };
    // wasm: heap arrays bound once, refilled per run (not timed).
    const H = {};
    for (const k in src) { H[k] = G.heap(src[k].constructor, src[k].length); G.bind(k, H[k]); }
    const refill = () => { for (const k in src) H[k].set(src[k]); };
    const tj = [], tw = [];
    for (let r = 0; r < reps; r++) {
        const R = copy();
        let t = process.hrtime.bigint(); replay(R); tj.push(Number(process.hrtime.bigint() - t) / 1e6);
        refill();
        t = process.hrtime.bigint(); replay(G.reg); tw.push(Number(process.hrtime.bigint() - t) / 1e6);
    }
    // Outputs compared byte for byte.
    const A = copy(); replay(A); refill(); replay(G.reg);
    let bad = 0;
    for (const k in A) {
        const a = new Uint8Array(A[k].buffer, A[k].byteOffset, A[k].byteLength), b = new Uint8Array(H[k].buffer, H[k].byteOffset, A[k].byteLength);
        for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) { if (bad++ < 5) { const j = Math.floor(i / A[k].BYTES_PER_ELEMENT); console.log('  differs', k, j, A[k][j], H[k][j]); } break; }
    }
    const mj = median(tj), mw = median(tw);
    console.log(`${name.padEnd(30)} calls ${String(calls.length / 2).padStart(4)}  JS ${mj.toFixed(2).padStart(7)} ms  wasm ${mw.toFixed(2).padStart(7)} ms  x${(mj / mw).toFixed(2)}  (min ${Math.min(...tj).toFixed(2)} / ${Math.min(...tw).toFixed(2)})  ${bad ? 'DIFFERENT' : 'outputs equal'}`);
}
