"use strict";
// ============================================================
// RUST/WASM KERNELS AND THE SHARED HEAP THEY READ
//
// The kernels are Rust (wasm/src/lib.rs, mv.rs; built by wasm/build.cjs into
// sim_wasm_bin.js): there are no JavaScript versions. They work on the
// game's own typed arrays in place: the arrays kernels read are allocated in
// one shared WebAssembly.Memory (simHeapArray / simSharedArray,
// sim_parallel.js), and every thread of the simulation (the simulation
// worker and each helper) instantiates the module over that memory, each
// with a stack of its own. A kernel call passes the arrays' addresses
// (simParallelBind records them, _simWPtrs reads them). A kernel that cannot
// run (no module, an array outside the heap) is an error (_simNoWasm).
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
// Each thread's argument block (sim_parallel.js _simWasmArgs): 4 KB of
// addresses, 4 KB of doubles.
const SIM_WASM_ARGS = 8192;
function _simWasmArgsAt(p) {
    _simWasmArgs = p;
    _simWasmArgI = p > 0 ? new Int32Array(_simWasmMem.buffer, p, 1024) : null;
    _simWasmArgF = p > 0 ? new Float64Array(_simWasmMem.buffer, p + 4096, 512) : null;
}
const _simHeap = {
    tried: false, ready: false, memory: null, module: null, top: 0,
    // The highest address ever handed out: memory above it has never been
    // written since the memory grew (zero), so a take from there is not
    // cleared again (clearing it only made the system commit every page:
    // ~100 ms for a navigation rebuild's fields at 400k a team); fresh: the
    // first such address of the last take.
    hw: 0, fresh: 0,
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
        H.hw = H.top;
        const on = new Int32Array(new SharedArrayBuffer(4));
        on[0] = 1;
        _simWasmOn = on;
        _simWasmX = exp;
        _simWasmMem = memory;
        H.ready = true;
        const scratch = _simHeapTake(SIM_WASM_SCRATCH);
        if (scratch > 0) { _simWasmScratch = scratch; _simWasmScratchWords = SIM_WASM_SCRATCH >> 2; }
        const args = _simHeapTake(SIM_WASM_ARGS);
        _simWasmArgsAt(args > 0 ? args : 0);
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
function _simHeapAllocImpl(Type, n, clear = true) {
    if (!simWasmInit()) return simSharedArray(Type, n);
    const H = _simHeap, len = Math.max(1, n | 0), bytes = _simHeapRound(len * Type.BYTES_PER_ELEMENT + SIM_HEAP_PAD);
    const ptr = _simHeapTake(bytes);
    // (The heap full: plain shared memory, which the Rust kernels cannot read.)
    if (ptr < 0) return new Type(new SharedArrayBuffer(Math.max(1, n) * Type.BYTES_PER_ELEMENT));
    const buf = H.memory.buffer;
    // (Only below the high-water mark; big ones by the helpers too:
    // simParallelZeroHeap.)
    const used = clear ? Math.min(bytes, H.fresh - ptr) : 0;
    if (!clear && SIM_HEAP_POISON >= 0) new Uint8Array(buf, ptr, bytes).fill(SIM_HEAP_POISON);
    if (used > 0) {
        if (typeof simParallelZeroHeap === 'function') simParallelZeroHeap(buf, ptr, used);
        else new Uint8Array(buf, ptr, used).fill(0);
    }
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
        H.fresh = p + bytes;
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
    H.fresh = Math.max(p, H.hw);
    if (end > H.hw) H.hw = end;
    return p;
}
function _simHeapReleaseImpl(arr) {
    const H = _simHeap;
    if (!arr || _simHeapAuto.has(arr)) return;
    const p = H.ptr.get(arr);
    if (p === undefined) return;
    const s = H.size.get(arr);
    H.ptr.delete(arr); H.size.delete(arr);
    _simHeapQueue(arr, p, s);
}
// A block to give back once nothing can read it (arr: its array while
// alive, for the binding check; null when the collector took it).
function _simHeapQueue(arr, p, s) {
    const H = _simHeap;
    // (The chains in flight now: each lane's posted count.)
    const waits = [];
    for (let lane = 0; lane < SIM_PAR_BG_LANES; lane++) if (simParallelBackgroundPending(lane)) waits.push(lane, _simBgPosted[lane]);
    H.pending.push({ arr, p, s, t: H.clock, waits });
}
// Arrays the collector gives back (simHeapArrayAuto): when one is
// collected, nothing on this thread reaches it any more (no name binds it
// either); a helper's copy is read only by a job, which the queue waits for.
const _simHeapAuto = new WeakSet();
const _simHeapAutoGone = typeof FinalizationRegistry === 'function' ? new FinalizationRegistry(h => { if ((SIM_HEAP_GC_FREE & 4) && (!SIM_HEAP_GC_FREE_SITES || new RegExp(SIM_HEAP_GC_FREE_SITES).test(h.site))) _simHeapQueue(null, h.p, h.s); }) : null;
function _simHeapAllocAutoImpl(Type, n, clear = true) {
    const arr = _simHeapAllocImpl(Type, n, clear), H = _simHeap, p = H.ptr.get(arr);
    if (p === undefined || !_simHeapAutoGone) return arr;
    _simHeapAuto.add(arr);
    _simHeapAutoGone.register(arr, { p, s: H.size.get(arr), site: SIM_HEAP_GC_FREE_SITES ? String(new Error().stack).split('\n')[3] || '' : '' });
    return arr;
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
            if (e.arr === null || !bound.has(e.arr)) { _simHeapGive(e.p, e.s); continue; }
        }
        Q[w++] = e;
    }
    Q.length = w;
}
// (Debug, tests: a byte (0-255) freed blocks and uncleared allocations are
// filled with, different on each peer, so that a read of memory no longer
// or not yet owned shows as a desync. -1: off.)
let SIM_HEAP_POISON = -1;
// (Debug: which collector-driven frees run (bits: 1 unit columns, 2 path
// pools, 4 auto arrays); 7: all, as normally.)
let SIM_HEAP_GC_FREE = 7;
// (Debug: only auto arrays allocated at a matching call site (a RegExp
// source against the allocating stack line) go back when collected.)
let SIM_HEAP_GC_FREE_SITES = '';
function _simHeapGive(p, s) {
    const H = _simHeap, F = H.free;
    if (SIM_HEAP_POISON >= 0 && H.memory) new Uint8Array(H.memory.buffer, p, s).fill(SIM_HEAP_POISON);
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
    const scratch = _simHeapTake(SIM_WASM_SCRATCH), args = _simHeapTake(SIM_WASM_ARGS);
    return { module: _simHeap.module, memory: _simHeap.memory, stackTop: p + SIM_WASM_STACK, on: _simWasmOn,
        scratch: scratch > 0 ? scratch : 0, scratchWords: scratch > 0 ? SIM_WASM_SCRATCH >> 2 : 0, args: args > 0 ? args : 0 };
}
// In a helper: its instance (none if it fails: its chunks run in JS).
function simWasmHelperInit(w) {
    try {
        const exp = new WebAssembly.Instance(w.module, { env: { memory: w.memory } }).exports;
        exp.__stack_pointer.value = w.stackTop;
        _simWasmOn = w.on;
        _simWasmMem = w.memory;
        _simWasmScratch = w.scratch | 0; _simWasmScratchWords = w.scratchWords | 0;
        _simWasmArgsAt(w.args | 0);
        _simWasmX = exp;
    } catch (err) { _simWasmX = null; console.error('[sim helper] wasm kernels unavailable, JS kernels run here:', err && err.message || err); }
}

_simHeapAlloc = _simHeapAllocImpl;
_simHeapAllocAuto = _simHeapAllocAutoImpl;
_simHeapRelease = _simHeapReleaseImpl;
_simHeapPtrOf = _simHeapPtrImpl;
_simHeapViewReg = (arr, v, off) => { const p = _simHeap.ptr.get(arr); if (p !== undefined) _simHeap.ptr.set(v, p + off); };
