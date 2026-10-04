"use strict";
// The page's multi-point order split off its own thread (main.js
// applyUnitCommandTargets): which of the points each unit goes to, the
// nearest pairs first, each point an equal share (the same as
// _assignToNearestPoints there). In: { seq, xs, ys, has (per unit), points
// [{x, y}] }; out: { seq, pick: Int32Array (point per unit) }. A pure
// function of its input: the orders it leads to are sent as any others.
function assign(xs, ys, has, pts) {
    const n = xs.length, k = pts.length, pick = new Int32Array(n);
    if (k <= 1 || n === 0) return pick;
    const capacity = Math.ceil(n / k), load = new Int32Array(k);
    const B = 65536, cnt = new Int32Array(B + 1), dist = new Int32Array(n);
    const lists = [], keys = [];
    for (let j = 0; j < k; j++) {
        const p = pts[j];
        cnt.fill(0);
        for (let i = 0; i < n; i++) {
            const dx = (has[i] && p) ? xs[i] - p.x : 0, dy = (has[i] && p) ? ys[i] - p.y : 0;
            const d = Math.min(B - 1, Math.floor(Math.sqrt(dx * dx + dy * dy)));
            dist[i] = d; cnt[d + 1]++;
        }
        for (let d = 0; d < B; d++) cnt[d + 1] += cnt[d];
        const L = new Int32Array(n), K = new Int32Array(n);
        for (let i = 0; i < n; i++) { const o = cnt[dist[i]]++; L[o] = i; K[o] = dist[i]; }
        lists.push(L); keys.push(K);
    }
    const head = new Int32Array(k), done = new Uint8Array(n), alive = new Uint8Array(k).fill(1);
    let left = n, open = k;
    while (left && open) {
        let bj = -1, bk = Infinity, bi = 0;
        for (let j = 0; j < k; j++) {
            if (!alive[j]) continue;
            const L = lists[j];
            let h = head[j];
            while (h < n && done[L[h]]) h++;
            head[j] = h;
            if (h >= n) { alive[j] = 0; open--; continue; }
            const kk = keys[j][h];
            if (kk < bk || (kk === bk && L[h] < bi)) { bk = kk; bj = j; bi = L[h]; }
        }
        if (bj < 0) break;
        head[bj]++;
        done[bi] = 1; left--; load[bj]++; pick[bi] = bj;
        if (load[bj] >= capacity) { alive[bj] = 0; open--; }
    }
    return pick;
}
self.onmessage = event => {
    const m = event.data;
    try {
        const pick = assign(m.xs, m.ys, m.has, m.points);
        self.postMessage({ seq: m.seq, pick }, [pick.buffer]);
    } catch (err) {
        self.postMessage({ seq: m.seq, error: String(err && err.stack || err) });
    }
};
