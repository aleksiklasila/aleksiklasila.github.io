// Typed-array memory of one peer, by where it is reachable from (global name
// and path), each buffer counted once (the first path that reaches it).
// Use as AFTER (tickbench): AFTER="$(cat .claude/probes/typed_mem.js)".
(() => {
    const seen = new Set(), byPath = new Map(), visited = new Set();
    let total = 0;
    const add = (path, ta) => {
        const b = ta.buffer;
        if (!b || seen.has(b)) return;
        seen.add(b);
        total += b.byteLength;
        byPath.set(path, (byPath.get(path) || 0) + b.byteLength);
    };
    const walk = (v, path, depth) => {
        if (v === null || typeof v !== 'object' && typeof v !== 'function') return;
        if (ArrayBuffer.isView(v)) { add(path, v); return; }
        if (v instanceof ArrayBuffer || (typeof SharedArrayBuffer !== 'undefined' && v instanceof SharedArrayBuffer)) {
            if (!seen.has(v)) { seen.add(v); total += v.byteLength; byPath.set(path, (byPath.get(path) || 0) + v.byteLength); }
            return;
        }
        if (depth <= 0 || visited.has(v)) return;
        visited.add(v);
        if (typeof v === 'function') return;
        if (Array.isArray(v)) {
            // Big lists of entities: sample their typed fields by the list's name.
            const n = v.length, step = n > 4096 ? Math.ceil(n / 4096) : 1;
            for (let i = 0; i < n; i += step) {
                const e = v[i];
                if (e && typeof e === 'object') walk(e, path + '[]', depth - 1);
            }
            return;
        }
        if (v instanceof Map) { for (const [k, e] of v) walk(e, path + '{}', depth - 1); return; }
        if (v instanceof Set) return;
        let keys;
        try { keys = Object.keys(v); } catch { return; }
        if (keys.length > 5000) return;
        for (const k of keys) { let e; try { e = v[k]; } catch { continue; } walk(e, path + '.' + k, depth - 1); }
    };
    const names = Object.getOwnPropertyNames(globalThis);
    for (const name of names) {
        if (name === 'globalThis' || name === 'window' || name === 'self' || name === '__scratch') continue;
        let v; try { v = globalThis[name]; } catch { continue; }
        walk(v, name, 4);
    }
    // Script-level let/const bindings are not on globalThis: look them up by name.
    const src = [];
    for (const extra of (globalThis.__typedMemNames || [])) { try { walk(eval(extra), extra, 4); } catch { } }
    const top = [...byPath].sort((a, b) => b[1] - a[1]).slice(0, 400).map(([k, v]) => [k, Math.round(v / 1048576 * 10) / 10]);
    return JSON.stringify({ totalMB: Math.round(total / 1048576), buffers: seen.size, top });
})()
