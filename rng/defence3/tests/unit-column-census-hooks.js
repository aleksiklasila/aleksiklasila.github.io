// The unit column census (chaos-spikes.bench.cjs --census=steps): loaded into
// the simulation instance. For the census steps, every per-slot array (the
// unit columns, and every registered array a whole number of words a slot)
// is shadowed; around each foreground kernel run (simParallelRun), background
// chain run on this thread (simParallelBackgroundWait without helpers) and
// direct kernel call (simRustDirect) the arrays are compared with their
// shadow: the changed elements and 64-byte lines per array are the caller's
// (the JavaScript between two calls: "js after <label>"). The per-slot
// arrays each kernel binds (_simWPtrs, simRustDirect's arguments) are
// recorded too: what it may read. Writes of the value already there are not
// seen. Needs --helpers=0 (every kernel on this thread, in order).
//# sourceURL=unit-column-census-hooks.js
(() => {
    const S = _simUnitState, cap = S.cap;
    // (The per-slot arrays: name, array, elements a slot.)
    // (By memory: a column and its registry name are often two views of the same bytes.)
    const arrays = [], seen = new Map(), bufs = new Map();
    const key = a => { let b = bufs.get(a.buffer); if (b === undefined) bufs.set(a.buffer, b = bufs.size); return b + ':' + a.byteOffset; };
    const nameOf = a => ArrayBuffer.isView(a) ? seen.get(key(a)) : undefined;
    const add = (name, a) => {
        if (!ArrayBuffer.isView(a) || a.length < cap || a.length % cap !== 0) return;
        const k = key(a), had = seen.get(k);
        if (had !== undefined) { const e = arrays.find(x => x.name === had); if (e && had.startsWith('col.') && !name.startsWith('col.')) { e.alias = had; e.name = name; seen.set(k, name); } return; }
        const stride = a.length / cap;
        if (stride > 16) return;
        seen.set(k, name); arrays.push({ name, a, stride, bpe: a.BYTES_PER_ELEMENT });
    };
    for (const [k, v] of Object.entries(S.columns)) { add('col.' + k, v); if (v && typeof v === 'object' && !ArrayBuffer.isView(v) && ArrayBuffer.isView(v.data)) add('col.' + k + '.data', v.data); }
    for (const [k, v] of Object.entries(_simParReg)) add(k, v);
    const kname = {};
    try { for (const m of String(__scratch.kernelNames || '').split(',')) { const [n, v] = m.split('='); if (n) kname[v] = n; } } catch (e) { }
    const stats = new Map(); // label -> { calls, w: Map(name -> [elements, lines]), b: Set(names) }
    const S_ = l => { let x = stats.get(l); if (!x) stats.set(l, x = { calls: 0, w: new Map(), b: new Set() }); return x; };
    let on = false;
    const shadows = arrays.map(e => {
        const bytes = e.a.byteLength;
        return { e, sh: new Uint8Array(bytes), w32: null };
    });
    const views = e => new Uint8Array(e.a.buffer, e.a.byteOffset, e.a.byteLength);
    const snap = () => { for (const x of shadows) x.sh.set(views(x.e)); };
    // (Compared by 32-bit words, by 64-byte lines: the changed elements counted within changed lines.)
    const diff = label => {
        const st = S_(label);
        for (const x of shadows) {
            const cur = views(x.e), sh = x.sh, n = cur.length, bpe = x.e.bpe;
            const c32 = (cur.byteOffset & 3) === 0 ? new Uint32Array(cur.buffer, cur.byteOffset, n >> 2) : null;
            const s32 = new Uint32Array(sh.buffer, 0, n >> 2);
            let lines = 0, els = 0;
            if (c32) {
                for (let w = 0; w < s32.length; w += 16) {
                    let ch = false;
                    const e = Math.min(s32.length, w + 16);
                    for (let j = w; j < e; j++) if (c32[j] !== s32[j]) { ch = true; break; }
                    if (!ch) continue;
                    lines++;
                    for (let b = w * 4, eb = e * 4; b < eb; b += bpe) { let d = false; for (let q = 0; q < bpe; q++) if (cur[b + q] !== sh[b + q]) { d = true; break; } if (d) els++; }
                }
                for (let b = s32.length * 4; b < n; b++) if (cur[b] !== sh[b]) els++;
            }
            if (lines || els) { const v = st.w.get(x.e.name) || [0, 0]; v[0] += els; v[1] += lines; st.w.set(x.e.name, v); sh.set(cur); }
        }
    };
    let stack = [], last = 'tick start';
    const enter = label => { if (!on) return; diff(stack.length ? stack[stack.length - 1] : 'js after ' + last); stack.push(label); S_(label).calls++; };
    const exit = () => { if (!on) return; const l = stack.pop(); diff(l); last = l; };
    const bound = names => { if (!on || !stack.length) return; const st = S_(stack[stack.length - 1]); for (const n of names) { const m = nameOf(_simParReg[n]); if (m) st.b.add(m); } };
    const run0 = simParallelRun;
    simParallelRun = function (kernel, total) { if (!on) return run0(kernel, total); enter('k:' + (kname[kernel] || kernel)); try { return run0(kernel, total); } finally { exit(); } };
    const wait0 = simParallelBackgroundWait;
    simParallelBackgroundWait = function (lane = 1) {
        const J = typeof _simBg !== 'undefined' ? _simBg[lane] : null;
        if (!on || !J) return wait0(lane);
        enter('bg:' + J.stages.map(s => kname[s[0]] || s[0]).join('+'));
        try { return wait0(lane); } finally { exit(); }
    };
    const direct0 = simRustDirect;
    simRustDirect = function (fn, arr, P) {
        if (!on) return direct0(fn, arr, P);
        enter('d:' + fn);
        if (Array.isArray(arr)) { const st = S_('d:' + fn); for (const a of arr) { const m = nameOf(a); if (m) st.b.add(m); } }
        try { return direct0(fn, arr, P); } finally { exit(); }
    };
    const ptrs0 = _simWPtrs;
    _simWPtrs = function (K) { if (on && K && K.names) bound(K.names); return ptrs0(K); };
    __scratch.census = {
        begin() { snap(); on = true; stack = []; last = 'tick start'; },
        end() { if (!on) return; diff('js after ' + last); on = false; },
        report(ticks) {
            // Each array's value profile over the live slots: non-default
            // (not its most common value) fraction, min / max, distinct (to 257).
            const n = S.owners.length, live = S.columns.live, prof = {};
            for (const e of arrays) {
                const a = e.a, st = e.stride, cnt = new Map();
                let mn = Infinity, mx = -Infinity, m = 0;
                for (let s = 0; s < n; s++) { if (live && !live[s]) continue; m++; for (let k = 0; k < st; k++) { const v = a[s * st + k]; if (v < mn) mn = v; if (v > mx) mx = v; if (cnt.size <= 256 || cnt.has(v)) cnt.set(v, (cnt.get(v) || 0) + 1); } }
                let top = 0; for (const c of cnt.values()) if (c > top) top = c;
                prof[e.name] = { alias: e.alias || null, stride: st, bpe: e.bpe, type: a.constructor.name, bytesPerSlot: st * e.bpe, min: mn, max: mx, distinct: cnt.size > 256 ? '>256' : cnt.size, nonDefault: m ? 1 - top / (m * st) : 0 };
            }
            const labels = {};
            for (const [l, x] of stats) labels[l] = { calls: x.calls, writes: Object.fromEntries([...x.w].map(([k, v]) => [k, { elements: v[0], lines: v[1] }])), binds: [...x.b] };
            return { ticks, cap, slots: n, liveSlots: live ? Array.from(live.subarray(0, n)).filter(Boolean).length : n, arrays: prof, labels };
        },
    };
})();
