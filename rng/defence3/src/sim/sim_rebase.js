// The GPU interpolates drawing positions. When a new presentation arrives
// early, this small native kernel preserves the previous displayed position
// without a JavaScript population loop. Typed-array bulk copies also work
// with transferred frames; the simulation's shared heap is never modified.
let _simRebaseNative = null;
const _simRebaseReady = typeof WebAssembly !== 'undefined' && typeof SIM_REBASE_WASM_BIN !== 'undefined'
    ? WebAssembly.instantiate(Uint8Array.from(atob(SIM_REBASE_WASM_BIN), c => c.charCodeAt(0)))
        .then(({instance}) => { _simRebaseNative = {exports:instance.exports,cap:0}; })
        .catch(() => {}) // JavaScript remains available if Wasm is unavailable.
    : Promise.resolve();
function simRebaseNative(F, old, shown) {
    const K = _simRebaseNative;
    if (!K) return false;
    if (K.cap < F.n) {
        const cap = K.cap = Math.max(F.n, 1024), X = K.exports;
        const base = Number(X.__heap_base.value), bytes = base + (11 * cap + 1) * 4;
        if (X.memory.buffer.byteLength < bytes) X.memory.grow(Math.ceil((bytes - X.memory.buffer.byteLength) / 65536));
        K.base = base;
        K.columns = Array.from({length:11}, (_,i) => new (i===4||i===9||i===10 ? Int32Array : Float32Array)(X.memory.buffer,base+i*cap*4,cap));
        K.count = new Uint32Array(X.memory.buffer,base+11*cap*4,1);
    }
    const C = K.columns, n = F.n, oldN = Math.min(n,old.n);
    C[0].set(F.x.subarray(0,n)); C[1].set(F.y.subarray(0,n));
    C[2].set(F.px.subarray(0,n)); C[3].set(F.py.subarray(0,n)); C[4].set(F.id.subarray(0,n));
    C[5].set(old.x.subarray(0,oldN)); C[6].set(old.y.subarray(0,oldN));
    C[7].set(old.px.subarray(0,oldN)); C[8].set(old.py.subarray(0,oldN)); C[9].set(old.id.subarray(0,oldN));
    F.renderMotionPad = K.exports.rebase(K.base,K.cap,n,oldN,shown,F.renderBuckets?1:0);
    F.px.set(C[2].subarray(0,n)); F.py.set(C[3].subarray(0,n));
    if (F.renderMoving) {
        F.renderMovingCount = K.count[0];
        F.renderMoving.set(C[10].subarray(0,F.renderMovingCount));
    }
    return true;
}
