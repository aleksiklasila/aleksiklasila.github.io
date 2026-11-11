// Step probe (chaos-spikes.bench.cjs --step-eval=@tests/probes/flow-records.js):
// the flow walkers' look records (unit.mvNav, 8 words: tile, destination,
// build, wall version, kind | approx bit, next, after, far << 1 | open) by
// state: on their record's tile or not, exact or approximate, open or not,
// and for exact open records off their tile, what stops a carry.
(() => {
    const S = _simUnitState; if (!S) return null;
    const c = S.columns, R = c.mvNav, n = S.owners.length, W = GRID_W, T = TILE;
    const o = { walkers: 0, onTile: 0, approx: 0, exact: 0, exactOpen: 0, offExactOpen: 0, near: 0, noProgress: 0, rest: 0, noRecord: 0 };
    for (let s = 0; s < n; s++) {
        if (c.mvOn[s] !== 1 || c.dead[s]) continue;
        o.walkers++;
        // (Positions in the columns: eighths of a pixel.)
        const tl = Math.floor(c.y[s] / 8 / T) * W + Math.floor(c.x[s] / 8 / T), r = s * 8;
        const g = R[r + 4];
        if (!(g > 0)) { o.noRecord++; continue; }
        if (R[r] === tl) o.onTile++;
        if (g & 65536) { o.approx++; continue; }
        o.exact++;
        if (!(R[r + 7] & 1)) continue;
        o.exactOpen++;
        if (R[r] === tl) continue;
        o.offExactOpen++;
        const far = R[r + 7] >> 1, fx = far % W, fy = Math.floor(far / W), gx = tl % W, gy = Math.floor(tl / W), x0 = R[r] % W, y0 = Math.floor(R[r] / W);
        if (Math.max(Math.abs(fx - gx), Math.abs(fy - gy)) < 8) { o.near++; continue; }
        if (Math.abs(fx - gx) + Math.abs(fy - gy) >= Math.abs(fx - x0) + Math.abs(fy - y0)) { o.noProgress++; continue; }
        o.rest++;
    }
    return o;
})()
