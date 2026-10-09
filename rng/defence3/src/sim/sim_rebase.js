// The GPU interpolates drawing positions. When a new presentation arrives
// early, this small native kernel preserves the previous displayed position
// without a JavaScript population loop. Typed-array bulk copies also work
// with transferred frames; the simulation's shared heap is never modified.
let _simRebaseNative = null;
const _simRebaseReady = typeof WebAssembly !== 'undefined' && typeof atob === 'function' && typeof SIM_REBASE_WASM_BIN !== 'undefined'
    ? WebAssembly.instantiate(Uint8Array.from(atob(SIM_REBASE_WASM_BIN), c => c.charCodeAt(0)))
        .then(({instance}) => { _simRebaseNative = {exports:instance.exports,cap:0,serial:0}; })
        .catch(() => {}) // JavaScript remains available if Wasm is unavailable.
    : Promise.resolve();
function simRebaseNative(F, old, shown) {
    const K = _simRebaseNative;
    if (!K) return false;
    const required = Math.max(F.cap||F.n,old.cap||old.n);
    if (K.cap < required) {
        // Growing Wasm memory detaches its old views. Preserve just the old
        // interpolation output before growth; authority columns live elsewhere.
        if (old._rebaseArena) {old.px=old.px.slice();old.py=old.py.slice();old.renderMoving=old.renderMoving?.slice();}
        const cap = K.cap = Math.max(required, 1024), X = K.exports;
        const base = Number(X.__heap_base.value), stride = (6*cap+1)*4, bytes = base + stride*2;
        if (X.memory.buffer.byteLength < bytes) X.memory.grow(Math.ceil((bytes - X.memory.buffer.byteLength) / 65536));
        K.arenas = [0,1].map(index => ({base:base+stride*index,frame:null,
            columns:Array.from({length:6},(_,i)=>new (i>=4?Int32Array:Float32Array)(X.memory.buffer,base+stride*index+i*cap*4,cap)),
            count:new Uint32Array(X.memory.buffer,base+stride*index+6*cap*4,1)}));
    }
    const copy = (A, frame, n) => {
        for (let i=0;i<5;i++) A.columns[i].set(frame[['x','y','px','py','id'][i]].subarray(0,n));
        A.frame=frame;
    };
    let O=K.arenas.find(A=>A===old._rebaseArena&&A.frame===old);
    if (!O) {O=K.arenas.find(A=>A!==F._rebaseArena)||K.arenas[0];copy(O,old,Math.min(F.n,old.n));}
    const A=K.arenas[O===K.arenas[0]?1:0], n=F.n;
    copy(A,F,n);
    F.renderMotionPad = K.exports.rebase(A.base,O.base,K.cap,n,Math.min(n,old.n),shown,F.renderBuckets?1:0);
    // The page retains at most the current and preceding frame. Keep their
    // interpolation columns here, so the next rebase reuses old inputs and
    // the renderer uploads these views directly. Worker buffers stay separate.
    F.px=A.columns[2];F.py=A.columns[3];F._rebaseArena=A;
    if (F.renderMoving) {
        F.renderMovingCount = A.count[0];F.renderMoving=A.columns[5];
    }
    return true;
}
