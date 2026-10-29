"use strict";
// Which of k points each of n things goes to (a ctrl multi-point order or
// rally: main.js _assignToNearestPoints, assign_worker.js): each point an
// equal share (ceil(n / k) at most), the nearest pairs first. The things are
// counted into the cells of a grid over them (at most ASSIGN_CELLS_MAX cells
// a side, fewer with many points), and the cell/point pairs taken nearest
// first: a cell's things go, in their order, to the points nearest the
// cell's middle while those have room. O(n + cells * k log): a million units
// and ten points ~30 ms (per thing/point pairs were a second or more and
// k arrays of n a click). A pure function of its input: the orders it leads
// to are sent as any others. xs, ys, has: per thing (has 0: no position,
// given last, in order, to the points with room); pts: [{x, y} | null]
// (null: as near as any). Returns an Int32Array of point indices.
const ASSIGN_CELLS_MAX = 128, ASSIGN_PAIRS_MAX = 1 << 20;
function assignNearestXY(xs, ys, has, pts) {
    const n = xs.length, k = pts.length, pick = new Int32Array(n);
    if (k <= 1 || n === 0) return pick;
    const cap = Math.ceil(n / k), load = new Int32Array(k);
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, placed = 0;
    for (let i = 0; i < n; i++) {
        if (!has[i]) continue;
        const x = xs[i], y = ys[i];
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
        placed++;
    }
    if (placed) {
        const M = Math.max(2, Math.min(ASSIGN_CELLS_MAX, Math.floor(Math.sqrt(ASSIGN_PAIRS_MAX / k))));
        const cs = Math.max(1, Math.max(x1 - x0, y1 - y0) / M);
        const cellOf = new Int32Array(n), count = new Int32Array(M * M);
        for (let i = 0; i < n; i++) {
            if (!has[i]) { cellOf[i] = -1; continue; }
            const gx = Math.min(M - 1, Math.floor((xs[i] - x0) / cs)), gy = Math.min(M - 1, Math.floor((ys[i] - y0) / cs));
            const c = gy * M + gx;
            cellOf[i] = c; count[c]++;
        }
        // (The cells with things, ranked in grid order.)
        const rank = new Int32Array(M * M).fill(-1), cells = [];
        for (let c = 0; c < M * M; c++) if (count[c]) { rank[c] = cells.length; cells.push(c); }
        const nc = cells.length, P = nc * k, SH = 2097152;
        // (Each pair's key: its distance in whole pixels, then its index: the
        // nearest first, ties in cell then point order.)
        const keys = new Float64Array(P);
        for (let r = 0; r < nc; r++) {
            const c = cells[r], cx = x0 + ((c % M) + .5) * cs, cy = y0 + (Math.floor(c / M) + .5) * cs;
            for (let j = 0; j < k; j++) {
                const p = pts[j], d = p ? Math.floor(Math.sqrt((cx - p.x) * (cx - p.x) + (cy - p.y) * (cy - p.y))) : 0;
                keys[r * k + j] = Math.min(d, 1e9) * SH + r * k + j;
            }
        }
        keys.sort();
        const rem = new Int32Array(nc);
        for (let r = 0; r < nc; r++) rem[r] = count[cells[r]];
        // (The shares: cell, point, how many; in the order they were made.)
        const aR = [], aJ = [], aN = [];
        for (let q = 0; q < P; q++) {
            const idx = keys[q] % SH, r = Math.floor(idx / k), j = idx - r * k;
            if (rem[r] === 0 || load[j] >= cap) continue;
            const take = Math.min(rem[r], cap - load[j]);
            rem[r] -= take; load[j] += take;
            aR.push(r); aJ.push(j); aN.push(take);
        }
        // (Each cell's shares, in order, then its things in order.)
        const first = new Int32Array(nc + 1);
        for (let a = 0; a < aR.length; a++) first[aR[a] + 1]++;
        for (let r = 0; r < nc; r++) first[r + 1] += first[r];
        const fill = first.slice(0, nc), sj = new Int32Array(aR.length), sn = new Int32Array(aR.length);
        for (let a = 0; a < aR.length; a++) { const o = fill[aR[a]]++; sj[o] = aJ[a]; sn[o] = aN[a]; }
        const at = first.slice(0, nc), left = new Int32Array(nc);
        for (let r = 0; r < nc; r++) left[r] = first[r] < first[r + 1] ? sn[first[r]] : 0;
        for (let i = 0; i < n; i++) {
            const c = cellOf[i];
            if (c < 0) continue;
            const r = rank[c];
            while (left[r] === 0 && at[r] + 1 < first[r + 1]) { at[r]++; left[r] = sn[at[r]]; }
            pick[i] = sj[at[r]]; left[r]--;
        }
    }
    // (Things without a position: in order, to the points with room.)
    if (placed < n) {
        let j = 0;
        for (let i = 0; i < n; i++) {
            if (has[i]) continue;
            while (j < k - 1 && load[j] >= cap) j++;
            pick[i] = j; load[j]++;
        }
    }
    return pick;
}

// A rally order's split (main.js applyRallyTargets, assign_worker.js): per
// point its buildings' tile keys, ascending, and their wire form
// (id_codec.js actionIdsEncode). keys, xs, ys, has: per building.
// -> { keys: [Int32Array a point], tkz: [string a point] }
function rallyAssignTiles(keys, xs, ys, has, points) {
    const k = points.length, n = keys.length;
    const pick = k > 1 ? assignNearestXY(xs, ys, has, points) : null;
    const count = new Int32Array(k), at = new Int32Array(k);
    if (pick) for (let i = 0; i < n; i++) count[pick[i]]++;
    else count[0] = n;
    const out = [];
    for (let j = 0; j < k; j++) out.push(new Int32Array(count[j]));
    for (let i = 0; i < n; i++) { const j = pick ? pick[i] : 0; out[j][at[j]++] = keys[i]; }
    for (const b of out) b.sort();
    return { keys: out, tkz: out.map(b => actionIdsEncode(b)) };
}
