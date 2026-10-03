// tickbench EVALALL probe: SIM_KERNEL_SEP_PAIRS with counters (run on the
// guest, which runs kernels on its own thread): entries visited, entries
// taking part, neighbour chunks looked at / passing the box test, candidate
// pairs, pairs of a layer, touching pairs. AFTERALL='JSON.stringify(__sepCnt)'.
(() => {
    // (The guest only: a peer without helpers runs every chunk here.)
    if (typeof _simPool !== 'undefined' && _simPool) { globalThis.__sepCnt = null; return; }
    const C = globalThis.__sepCnt = { ticks: 0, entries: 0, part: 0, chunks: 0, boxPass: 0, cand: 0, layer: 0, touch: 0, lastTick: -1 };
    const orig = SIM_KERNELS[SIM_KERNEL_SEP_PAIRS];
    SIM_KERNELS[SIM_KERNEL_SEP_PAIRS] = function (R, P, chunk) {
        if (C.lastTick !== gameTime) { C.lastTick = gameTime; C.ticks++; }
        const CW = P[0] | 0, CH = P[1] | 0, H = P[2] | 0, pad = P[3], farAny = P[4];
        const listed = P[15] === 1 ? R['ix.listed'][0] | 0 : P[9] | 0, cws = P[10], ep = P[11] | 0;
        const band = chunk * 2 + (P[14] | 0), row0 = band * H, row1 = Math.min(CH, row0 + H);
        if (row0 < CH) {
            const ord = R['sep.ord'], rec = R['sep.rec'], meta = R['sep.meta'];
            const keys = R['sep.ekey'], rs = R['sep.rs'], rc = R['sep.rc'], rstamp = R['sep.rstamp'];
            const chunkR = R['sep.chunkR'], sole = R['sep.sole'], BOX = R['sep.box'], CP = R['sep.chunkP'];
            const reach = Math.max(1, Math.ceil(farAny / cws)), maxR = (farAny - pad) / 2;
            const lo = _simSepLowerBound(keys, 0, listed, row0 * CW), hi = _simSepLowerBound(keys, lo, listed, row1 * CW);
            for (let p = lo; p < hi; p++) {
                const a = ord[p];
                if (a < 0) continue;
                C.entries++;
                const pm = meta[p], pPart = (pm >>> 16) & 1, op = pm & 255, pl = pm & 65280;
                if (pPart) C.part++;
                const key = keys[p] | 0, cx = key % CW, cy = (key - cx) / CW;
                const xp = rec[p * 4], yp = rec[p * 4 + 1], rp = rec[p * 4 + 2];
                const ex0 = xp - cx * cws, ex1 = (cx + 1) * cws - xp, ey1 = (cy + 1) * cws - yp;
                const lim = rp + maxR + pad;
                const ox0 = ex0 >= lim ? 0 : -Math.min(reach, Math.ceil((lim - ex0) / cws)), ox1 = ex1 >= lim ? 0 : Math.min(reach, Math.ceil((lim - ex1) / cws));
                const oy1 = ey1 >= lim ? 0 : Math.min(reach, Math.ceil((lim - ey1) / cws));
                for (let oy = 0; oy <= oy1; oy++) {
                    const ny = cy + oy;
                    if (ny >= CH) break;
                    for (let ox = oy === 0 ? 0 : ox0; ox <= ox1; ox++) {
                        let b0, b1;
                        if (ox === 0 && oy === 0) { b0 = p + 1; b1 = rs[key] + rc[key]; }
                        else {
                            const nx = cx + ox;
                            if (nx < 0 || nx >= CW) continue;
                            const key2 = ny * CW + nx;
                            if (rstamp[key2] !== ep || (!pPart && !CP[key2])) continue;
                            C.chunks++;
                            const b = key2 * 4, bx = xp < BOX[b] ? BOX[b] - xp : (xp > BOX[b + 1] ? xp - BOX[b + 1] : 0);
                            const by = yp < BOX[b + 2] ? BOX[b + 2] - yp : (yp > BOX[b + 3] ? yp - BOX[b + 3] : 0);
                            const reachB = rp + chunkR[key2] + (sole[key2] === op ? 0 : pad);
                            if (bx * bx + by * by >= reachB * reachB) continue;
                            C.boxPass++;
                            b0 = rs[key2]; b1 = b0 + rc[key2];
                        }
                        for (let q = b0; q < b1; q++) {
                            const qm = meta[q], qPart = (qm >>> 16) & 1;
                            C.cand++;
                            if (!(pPart | qPart) || (qm & 65280) !== pl) continue;
                            C.layer++;
                            const q4 = q * 4, dx = rec[q4] - xp, dy = rec[q4 + 1] - yp, d2 = dx * dx + dy * dy;
                            const minDist = rp + rec[q4 + 2] + ((qm & 255) === op ? 0 : pad);
                            if (d2 < minDist * minDist && ord[q] >= 0) C.touch++;
                        }
                    }
                }
            }
        }
        return orig.apply(this, arguments);
    };
})();
