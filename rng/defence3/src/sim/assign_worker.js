"use strict";
// The page's multi-point order split off its own thread (main.js
// applyUnitCommandTargets): which of the points each unit goes to, the
// nearest pairs first, each point an equal share (the same as
// _assignToNearestPoints there: assign_nearest.js). In: { seq, xs, ys, has (per unit), points
// [{x, y}], ?ids (Int32Array per unit) }; out: { seq, pick: Int32Array (point
// per unit) }, or with ids { seq, buckets: [Int32Array of each point's ids] }. A pure
// function of its input: the orders it leads to are sent as any others.
importScripts('../utils/assign_nearest.js?v=20261024-cells');
const assign = assignNearestXY;
self.onmessage = event => {
    const m = event.data;
    try {
        const pick = assign(m.xs, m.ys, m.has, m.points);
        if (!m.ids && !m.coords) { self.postMessage({ seq: m.seq, pick }, [pick.buffer]); return; }
        // (With ids: each point's ids, in their order.)
        const k = m.points.length, count = new Int32Array(k);
        for (let i = 0; i < pick.length; i++) count[pick[i]]++;
        const stride = m.coords ? 2 : 1;
        const buckets = Array.from({ length: k }, (_, j) => new Int32Array(count[j] * stride)), at = new Int32Array(k);
        for (let i = 0; i < pick.length; i++) {
            const j = pick[i];
            if (m.coords) { buckets[j][at[j]++] = m.coords[i * 2]; buckets[j][at[j]++] = m.coords[i * 2 + 1]; }
            else buckets[j][at[j]++] = m.ids[i];
        }
        self.postMessage({ seq: m.seq, buckets }, buckets.map(b => b.buffer));
    } catch (err) {
        self.postMessage({ seq: m.seq, error: String(err && err.stack || err) });
    }
};
