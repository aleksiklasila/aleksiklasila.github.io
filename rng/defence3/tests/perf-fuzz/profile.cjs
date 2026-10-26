'use strict';
// CPU profile (Chrome .cpuprofile) summaries: self time per function over a
// stretch of the profile, who called the native functions that hold time, the
// difference between a profile of the slow stretch and one of an idle stretch
// of the same length (what the action added, not what the match always
// costs), and the make-up of one long task.
const path = require('node:path');

const keyOf = n => {
    const f = n.callFrame;
    const file = path.basename(String(f.url || '').replace(/\?.*$/, '')) || '(native)';
    return `${f.functionName || '(anon)'} ${file}:${(f.lineNumber || 0) + 1}`;
};

const IX = new WeakMap();
function index(p) {
    let ix = IX.get(p);
    if (ix) return ix;
    const byId = new Map(p.nodes.map(n => [n.id, n])), parent = new Map();
    for (const n of p.nodes) for (const c of n.children || []) parent.set(c, n.id);
    IX.set(p, ix = { byId, parent });
    return ix;
}

// Self ms per function between `fromMs` and `toMs` after the profile's first sample.
function selfTimes(p, { fromMs = 0, toMs = Infinity } = {}) {
    const out = { map: new Map(), callers: new Map(), spanMs: 0, busyMs: 0, gcMs: 0, idleMs: 0, programMs: 0 };
    if (!p || !p.nodes || !p.samples || !p.samples.length) return out;
    const { byId, parent } = index(p);
    let t = 0;
    for (let i = 0; i < p.samples.length; i++) {
        t += (p.timeDeltas[i] || 0) / 1000;
        if (t < fromMs) continue;
        if (t > toMs) break;
        const dt = (p.timeDeltas[i + 1] !== undefined ? p.timeDeltas[i + 1] : p.timeDeltas[i] || 0) / 1000;
        const n = byId.get(p.samples[i]);
        if (!n) continue;
        const fn = n.callFrame.functionName;
        out.spanMs += dt;
        if (fn === '(idle)') { out.idleMs += dt; continue; }
        if (fn === '(garbage collector)') { out.gcMs += dt; out.busyMs += dt; continue; }
        if (fn === '(program)') { out.programMs += dt; out.busyMs += dt; continue; }
        out.busyMs += dt;
        const k = keyOf(n);
        out.map.set(k, (out.map.get(k) || 0) + dt);
        // Native functions (getParameter, now, drawImage...) say nothing without their caller.
        if (/\(native\)/.test(k)) {
            const pn = byId.get(parent.get(n.id));
            if (pn) { const c = out.callers.get(k) || out.callers.set(k, new Map()).get(k), ck = keyOf(pn); c.set(ck, (c.get(ck) || 0) + dt); }
        }
    }
    return out;
}

const r1 = v => Math.round(v * 10) / 10;
const via = (st, k) => { const c = st.callers.get(k); if (!c) return undefined; let best = null, ms = 0; for (const [ck, v] of c) if (v > ms) { ms = v; best = ck; } return best || undefined; };
const top = (st, n) => [...st.map].sort((a, b) => b[1] - a[1]).slice(0, n).map(([name, ms]) => ({ name, ms: r1(ms), via: via(st, name) }));

// What `act` spent more than `ctl` did (scaled to the same span): [{ name, ms, actMs, ctlMs, via }].
function excess(act, ctl, n = 10) {
    const scale = ctl.spanMs > 0 ? act.spanMs / ctl.spanMs : 1, rows = [];
    for (const [name, ms] of act.map) { const c = (ctl.map.get(name) || 0) * scale; if (ms - c > 2) rows.push({ name, ms: r1(ms - c), actMs: r1(ms), ctlMs: r1(c), via: via(act, name) }); }
    return rows.sort((a, b) => b.ms - a.ms).slice(0, n);
}
const totals = st => ({ spanMs: Math.round(st.spanMs), busyMs: Math.round(st.busyMs), gcMs: Math.round(st.gcMs), idleMs: Math.round(st.idleMs) });

// One stretch (a long task): self and inclusive ms per function, biggest first.
function stretch(p, fromMs, toMs, n = 8) {
    const out = { self: new Map(), total: new Map(), ms: 0 };
    if (!p || !p.samples || !p.samples.length) return { ms: 0, self: [], total: [] };
    const { byId, parent } = index(p);
    let t = 0;
    for (let i = 0; i < p.samples.length; i++) {
        t += (p.timeDeltas[i] || 0) / 1000;
        if (t < fromMs) continue;
        if (t > toMs) break;
        const dt = (p.timeDeltas[i + 1] !== undefined ? p.timeDeltas[i + 1] : p.timeDeltas[i] || 0) / 1000;
        let id = p.samples[i];
        const fn0 = byId.get(id) && byId.get(id).callFrame.functionName;
        if (fn0 === '(idle)') continue;
        out.ms += dt;
        const seen = new Set();
        let first = true;
        for (; id !== undefined; id = parent.get(id)) {
            const nd = byId.get(id); if (!nd) break;
            const k = keyOf(nd);
            if (/^\((root|program|idle)\)/.test(k)) continue;
            if (first) { out.self.set(k, (out.self.get(k) || 0) + dt); first = false; }
            if (!seen.has(k)) { seen.add(k); out.total.set(k, (out.total.get(k) || 0) + dt); }
        }
    }
    const rows = m => [...m].sort((a, b) => b[1] - a[1]).slice(0, n).map(([name, ms]) => ({ name, ms: r1(ms) }));
    return { ms: r1(out.ms), self: rows(out.self), total: rows(out.total) };
}

module.exports = { selfTimes, top, excess, totals, stretch };
