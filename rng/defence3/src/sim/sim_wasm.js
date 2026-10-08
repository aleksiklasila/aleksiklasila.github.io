"use strict";
// ============================================================
// RUST/WASM KERNELS AND THE SHARED HEAP THEY READ
//
// The heaviest kernels (the separation chain, the acquisition scan) have
// Rust twins (wasm/src/lib.rs, built by wasm/build.cjs into
// sim_wasm_bin.js). They work on the game's own typed arrays in place: the
// arrays those kernels read are allocated in one shared WebAssembly.Memory
// (simHeapArray, sim_parallel.js), and every thread of the simulation (the
// simulation worker and each helper) instantiates the module over that
// memory, each with a stack of its own. A kernel call passes the arrays'
// addresses (simParallelBind records them, _simWPtrs reads them).
//
// A twin gives the JS kernel's results bit for bit, so either may run any
// chunk: a thread without the module, an array not in the heap (the heap
// full, a test's own arrays) or simWasmKernels(false) runs the JS kernel.
// Peers with and without wasm (a browser without SIMD, a page that is not
// cross-origin isolated) stay in lockstep.
//
// Load after sim_parallel.js (it installs that file's heap hooks) and
// sim_wasm_bin.js.
// ============================================================

// false before a match: every array in plain shared memory, JS kernels only.
let SIM_WASM_ENABLED = true;
const SIM_HEAP_ALIGN = 64;
// Bytes past each array's end: the SIMD loops read whole vectors.
const SIM_HEAP_PAD = 64;
// A freed array's memory is reused once every background chain in flight
// when it was freed is done (a tier job may still read it), at least
// SIM_HEAP_FREE_TICKS ticks later (code of that tick may still hold it),
// and only once no name binds it.
const SIM_HEAP_FREE_TICKS = 2;
const SIM_HEAP_PAGE = 65536, SIM_HEAP_MAX_PAGES = 65536;
// Each helper's stack (the module's own, at the memory's start, is the
// simulation thread's).
const SIM_WASM_STACK = 256 * 1024;
// Each thread's scratch for kernels' work arrays (a flow field's row search).
const SIM_WASM_SCRATCH = 4 * 1024 * 1024;
const _simHeap = {
    tried: false, ready: false, memory: null, module: null, top: 0,
    // Free blocks [ptr, size, ...] by address; freed arrays waiting
    // { arr, p, s, t, waits: [lane, chains posted then, ...] }.
    free: [], pending: [], clock: 0,
    ptr: new WeakMap(), size: new WeakMap(), live: 0, peak: 0, arrays: 0, error: null
};

function _simWasmDecode(b64) {
    const T = new Uint8Array(128), A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    for (let i = 0; i < 64; i++) T[A.charCodeAt(i)] = i;
    let n = b64.length;
    while (n > 0 && b64.charCodeAt(n - 1) === 61) n--;
    const out = new Uint8Array((n * 3) >> 2);
    let o = 0, acc = 0, bits = 0;
    for (let i = 0; i < n; i++) {
        acc = (acc << 6) | T[b64.charCodeAt(i)]; bits += 6;
        if (bits >= 8) { bits -= 8; out[o++] = (acc >> bits) & 255; acc &= (1 << bits) - 1; }
    }
    return out;
}

// The module and the heap in this (the simulation) thread: once, on first
// use; false when not available (no shared memory, no SIMD, no module, or
// a browser's main thread, where compiling it synchronously is refused).
function simWasmInit() {
    const H = _simHeap;
    if (H.tried) return H.ready;
    H.tried = true;
    try {
        if (!SIM_WASM_ENABLED || typeof SIM_WASM_BIN !== 'string' || typeof WebAssembly !== 'object' || typeof SharedArrayBuffer !== 'function') return false;
        // (Only where the ticks run: a page whose simulation runs in its
        // worker (sim_client.js) keeps arrays for presentation only and never
        // ticks, so arrays freed there would never be reused.)
        if (typeof simClientEnabled !== 'undefined' && simClientEnabled) return false;
        const memory = new WebAssembly.Memory({ initial: 256, maximum: SIM_HEAP_MAX_PAGES, shared: true });
        if (!(memory.buffer instanceof SharedArrayBuffer)) return false;
        const module = new WebAssembly.Module(_simWasmDecode(SIM_WASM_BIN));
        const exp = new WebAssembly.Instance(module, { env: { memory } }).exports;
        H.memory = memory; H.module = module;
        H.top = _simHeapRound(exp.__heap_base.value);
        const on = new Int32Array(new SharedArrayBuffer(4));
        on[0] = 1;
        _simWasmOn = on;
        _simWasmX = exp;
        _simWasmMem = memory;
        H.ready = true;
        const scratch = _simHeapTake(SIM_WASM_SCRATCH);
        if (scratch > 0) { _simWasmScratch = scratch; _simWasmScratchWords = SIM_WASM_SCRATCH >> 2; }
    } catch (err) { H.ready = false; H.error = String(err && err.message || err); _simWasmX = null; }
    return H.ready;
}
function _simHeapRound(n) { return Math.ceil(n / SIM_HEAP_ALIGN) * SIM_HEAP_ALIGN; }

// Whether the wasm kernels run (every thread of this simulation: the flag
// is shared). The heap stays; only the kernels change, the same results.
function simWasmKernels(on) {
    if (!_simHeap.ready) return false;
    _simWasmOn[0] = on ? 1 : 0;
    return true;
}
function simWasmActive() { return _simHeap.ready && _simWasmX !== null && _simWasmOn[0] === 1; }

// ---- the heap ----
function _simHeapAllocImpl(Type, n) {
    if (!simWasmInit()) return simSharedArray(Type, n);
    const H = _simHeap, len = Math.max(1, n | 0), bytes = _simHeapRound(len * Type.BYTES_PER_ELEMENT + SIM_HEAP_PAD);
    const ptr = _simHeapTake(bytes);
    if (ptr < 0) return simSharedArray(Type, n);
    const buf = H.memory.buffer;
    new Uint8Array(buf, ptr, bytes).fill(0);
    const arr = new Type(buf, ptr, len);
    H.ptr.set(arr, ptr); H.size.set(arr, bytes);
    H.live += bytes; H.arrays++;
    if (H.live > H.peak) H.peak = H.live;
    return arr;
}
// Best fit among the free blocks, else from the top (growing the memory).
function _simHeapTake(bytes) {
    const H = _simHeap, F = H.free;
    let best = -1;
    for (let i = 0; i < F.length; i += 2) if (F[i + 1] >= bytes && (best < 0 || F[i + 1] < F[best + 1])) best = i;
    if (best >= 0) {
        const p = F[best];
        if (F[best + 1] === bytes) F.splice(best, 2);
        else { F[best] += bytes; F[best + 1] -= bytes; }
        return p;
    }
    const p = H.top, end = p + bytes, have = H.memory.buffer.byteLength;
    if (end > have) {
        const cur = have / SIM_HEAP_PAGE, need = Math.ceil((end - have) / SIM_HEAP_PAGE);
        if (cur + need > SIM_HEAP_MAX_PAGES) return -1;
        // (In steps of an eighth, at least 16 MB: growing is a commit.)
        const step = Math.min(SIM_HEAP_MAX_PAGES - cur, Math.max(need, Math.ceil(cur / 8), 256));
        try { H.memory.grow(step); } catch (err) { try { H.memory.grow(need); } catch (err2) { return -1; } }
    }
    H.top = end;
    return p;
}
function _simHeapReleaseImpl(arr) {
    const H = _simHeap;
    if (!arr) return;
    const p = H.ptr.get(arr);
    if (p === undefined) return;
    const s = H.size.get(arr);
    H.ptr.delete(arr); H.size.delete(arr);
    // (The chains in flight now: each lane's posted count.)
    const waits = [];
    for (let lane = 0; lane < SIM_PAR_BG_LANES; lane++) if (simParallelBackgroundPending(lane)) waits.push(lane, _simBgPosted[lane]);
    H.pending.push({ arr, p, s, t: H.clock, waits });
}
// Once per tick (gameTick): freed arrays that nothing can still read go
// back to the free blocks.
function simHeapTick() {
    const H = _simHeap;
    H.clock++;
    const Q = H.pending;
    if (!Q.length) return;
    let bound = null, w = 0;
    for (let i = 0; i < Q.length; i++) {
        const e = Q[i];
        let done = H.clock - e.t >= SIM_HEAP_FREE_TICKS;
        // (A chain is done once its lane is not pending or has a newer one.)
        for (let j = 0; done && j < e.waits.length; j += 2) if (simParallelBackgroundPending(e.waits[j]) && _simBgPosted[e.waits[j]] === e.waits[j + 1]) done = false;
        if (done) {
            if (!bound) { bound = new Set(); for (const k in _simParReg) if (_simParReg[k]) bound.add(_simParReg[k]); }
            if (!bound.has(e.arr)) { _simHeapGive(e.p, e.s); continue; }
        }
        Q[w++] = e;
    }
    Q.length = w;
}
function _simHeapGive(p, s) {
    const H = _simHeap, F = H.free;
    H.live -= s; H.arrays--;
    let i = 0;
    while (i < F.length && F[i] < p) i += 2;
    F.splice(i, 0, p, s);
    // (Joined with the blocks on either side.)
    if (i + 2 < F.length && F[i] + F[i + 1] === F[i + 2]) { F[i + 1] += F[i + 3]; F.splice(i + 2, 2); }
    if (i > 0 && F[i - 2] + F[i - 1] === F[i]) { F[i - 1] += F[i + 1]; F.splice(i, 2); i -= 2; }
    // (The last block: back to the top.)
    if (F.length && F[F.length - 2] + F[F.length - 1] === H.top) { H.top = F[F.length - 2]; F.length -= 2; }
}
function _simHeapPtrImpl(arr) {
    const p = arr ? _simHeap.ptr.get(arr) : undefined;
    return p === undefined ? -1 : p;
}
function simHeapStats() {
    const H = _simHeap;
    let freeBytes = 0;
    for (let i = 1; i < H.free.length; i += 2) freeBytes += H.free[i];
    return { ready: H.ready, kernels: simWasmActive(), hash: typeof SIM_WASM_HASH === 'string' ? SIM_WASM_HASH : null, error: H.error,
        memoryMB: H.memory ? Math.round(H.memory.buffer.byteLength / 1048576) : 0, liveMB: Math.round(H.live / 1048576), peakMB: Math.round(H.peak / 1048576),
        freeMB: Math.round(freeBytes / 1048576), arrays: H.arrays, pendingFrees: H.pending.length };
}

// ---- helpers ----
// What a new helper needs (simParallelInit): the module, the memory, its stack.
function simWasmHelperPayload() {
    if (!_simHeap.ready) return null;
    const p = _simHeapTake(SIM_WASM_STACK);
    if (p < 0) return null;
    const scratch = _simHeapTake(SIM_WASM_SCRATCH);
    return { module: _simHeap.module, memory: _simHeap.memory, stackTop: p + SIM_WASM_STACK, on: _simWasmOn,
        scratch: scratch > 0 ? scratch : 0, scratchWords: scratch > 0 ? SIM_WASM_SCRATCH >> 2 : 0 };
}
// In a helper: its instance (none if it fails: its chunks run in JS).
function simWasmHelperInit(w) {
    try {
        const exp = new WebAssembly.Instance(w.module, { env: { memory: w.memory } }).exports;
        exp.__stack_pointer.value = w.stackTop;
        _simWasmOn = w.on;
        _simWasmMem = w.memory;
        _simWasmScratch = w.scratch | 0; _simWasmScratchWords = w.scratchWords | 0;
        _simWasmX = exp;
    } catch (err) { _simWasmX = null; console.error('[sim helper] wasm kernels unavailable, JS kernels run here:', err && err.message || err); }
}

_simHeapAlloc = _simHeapAllocImpl;
_simHeapRelease = _simHeapReleaseImpl;
_simHeapPtrOf = _simHeapPtrImpl;
