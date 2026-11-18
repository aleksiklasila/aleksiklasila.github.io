"use strict";
// The page's multi-point order split off its own thread (main.js
// applyUnitCommandTargets): which of the points each unit goes to, the
// nearest pairs first, each point an equal share (the same as
// _assignToNearestPoints there: assign_nearest.js). In: { seq, xs, ys, has (per unit), points
// [{x, y}], ?ids (Int32Array per unit) }; out: { seq, pick: Int32Array (point
// per unit) }, or with ids { seq, buckets: [Int32Array of each point's ids] }.
// A rally (main.js applyRallyTargets): in { seq, rally: true, keys (tile key
// per building), xs, ys, has, points }; out { seq, keys: [Int32Array of each
// point's tile keys, ascending], tkz: [their wire form] } (rallyAssignTiles).
// A pure function of its input: the orders it leads to are sent as any others.
importScripts('../utils/assign_nearest.js?v=20261029-tkz', '../utils/id_codec.js?v=20261116-enc');
const assign = assignNearestXY;
// (Each of ids' point in the last split (a: its ids, p: their points), -1 none: an open-addressing table of a.)
let _hashT = new Int32Array(0);
function prevByIds(a, p, ids) {
    const n = ids.length, out = new Int32Array(n).fill(-1);
    let size = 1; while (size < a.length * 2) size <<= 1;
    if (_hashT.length < size) _hashT = new Int32Array(size);
    const T = _hashT.subarray(0, size), m = size - 1;
    T.fill(-1);
    for (let j = 0; j < a.length; j++) { let h = (Math.imul(a[j], 0x9E3779B1) >>> 0) & m; while (T[h] >= 0) h = (h + 1) & m; T[h] = j; }
    for (let i = 0; i < n; i++) {
        const id = ids[i];
        let h = (Math.imul(id, 0x9E3779B1) >>> 0) & m;
        for (let j; (j = T[h]) >= 0; h = (h + 1) & m) if (a[j] === id) { out[i] = p[j]; break; }
    }
    return out;
}
self.onmessage = event => {
    const m = event.data;
    try {
        if (m.rally) {
            const r = rallyAssignTiles(m.keys, m.xs, m.ys, m.has, m.points);
            self.postMessage({ seq: m.seq, keys: r.keys, tkz: r.tkz }, r.keys.map(b => b.buffer));
            return;
        }
        const pick = assign(m.xs, m.ys, m.has, m.points);
        if (!m.ids) { self.postMessage({ seq: m.seq, pick }, [pick.buffer]); return; }
        // (With ids: each point's ids, in their order. With prevIds / prevPick (a chain's last split sent: its ids and
        // a point each, -1 unknown): matched to these ids by id, only the units whose point changed, and the whole
        // split back (the page's next prev).)
        const k = m.points.length, count = new Int32Array(k), prev = m.prevIds && m.prevPick ? prevByIds(m.prevIds, m.prevPick, m.ids) : null;
        for (let i = 0; i < pick.length; i++) if (!prev || prev[i] !== pick[i]) count[pick[i]]++;
        const buckets = Array.from({ length: k }, (_, j) => new Int32Array(count[j])), at = new Int32Array(k);
        for (let i = 0; i < pick.length; i++) { const j = pick[i]; if (!prev || prev[i] !== j) buckets[j][at[j]++] = m.ids[i]; }
        self.postMessage({ seq: m.seq, buckets, pick }, [...buckets.map(b => b.buffer), pick.buffer]);
    } catch (err) {
        self.postMessage({ seq: m.seq, error: String(err && err.stack || err) });
    }
};
