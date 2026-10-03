// sepbench variant B: the pair kernel's sums by entry (4 values an entry:
// push x, push y, deepest overlap, contacts; a pair's entries are near each
// other in the index order), gathered by slot after.
var SEP_ACC = null, SEP_ORD = null;
function _sepSideA(ACC, a, ux, uy, d, id, oid, overlap, share, Q) {
    let nxv, nyv;
    if (d > 0.001) { nxv = ux / d; nyv = uy / d; }
    else {
        const dir = id & 3, mdx = dir === 0 ? 1 : dir === 2 ? -1 : 0, mdy = dir === 1 ? 1 : dir === 3 ? -1 : 0;
        const pairSign = id < oid ? -1 : 1;
        if (Math.abs(mdx) >= Math.abs(mdy)) { nxv = 0; nyv = (mdx >= 0 ? -1 : 1) * pairSign; }
        else { nxv = (mdy >= 0 ? 1 : -1) * pairSign; nyv = 0; }
    }
    const f = overlap * share * Q, o = a * 4;
    ACC[o] += Math.round(nxv * f); ACC[o + 1] += Math.round(nyv * f);
    if (overlap > ACC[o + 2]) ACC[o + 2] = overlap;
    ACC[o + 3]++;
}
var SEP_PAIRS_VARIANT_PREP = function (R) { const n = R["sep.ord"].length; if (!SEP_ACC || SEP_ACC.length !== n * 4) SEP_ACC = new Float64Array(n * 4); else SEP_ACC.fill(0); };
var SEP_PAIRS_VARIANT_POST = function (R) {
    const PX = R['sep.px'], PY = R['sep.py'], OV = R['sep.ov'], HIT = R['sep.hit'], A = SEP_ACC, ord = R['sep.ord'];
    const n = R['ix.listed'] ? R['ix.listed'][0] : ord.length;
    for (let p = 0; p < n; p++) { const s = ord[p]; if (s < 0 || A[p * 4 + 3] === 0) continue; PX[s] = A[p * 4]; PY[s] = A[p * 4 + 1]; OV[s] = A[p * 4 + 2]; HIT[s] = A[p * 4 + 3]; }
};
var SEP_PAIRS_VARIANT = function (R, P, chunk) {
    const CW = P[0] | 0, CH = P[1] | 0, H = P[2] | 0, pad = P[3], farAny = P[4], Q = P[5], BOTH = P[6], ONE = P[7];
    const listed = P[15] === 1 ? R['ix.listed'][0] | 0 : P[9] | 0, cws = P[10], ep = P[11] | 0, MOVER = P[12], YIELD = P[13];
    const band = chunk * 2 + (P[14] | 0), row0 = band * H, row1 = Math.min(CH, row0 + H);
    if (row0 >= CH) return;
    const ord = R['sep.ord'], rec = R['sep.rec'], meta = R['sep.meta'], sid = R['sep.sid'];
    const keys = R['sep.ekey'], rs = R['sep.rs'], rc = R['sep.rc'], rstamp = R['sep.rstamp'];
    const chunkR = R['sep.chunkR'], sole = R['sep.sole'], BOX = R['sep.box'], CP = R['sep.chunkP'];
    const ACC = SEP_ACC;
    const reach = Math.max(1, Math.ceil(farAny / cws)), maxR = (farAny - pad) / 2;
    const lo = _simSepLowerBound(keys, 0, listed, row0 * CW), hi = _simSepLowerBound(keys, lo, listed, row1 * CW);
    for (let p = lo; p < hi; p++) {
        const a = ord[p];
        if (a < 0) continue;
        const pm = meta[p], pPart = (pm >>> 16) & 1, pMoved = (pm & 131072) !== 0, op = pm & 255, pl = pm & 65280;
        const key = keys[p] | 0, cx = key % CW, cy = (key - cx) / CW;
        const xp = rec[p * 4], yp = rec[p * 4 + 1], rp = rec[p * 4 + 2], ip = sid[p];
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
                    const b = key2 * 4, bx = xp < BOX[b] ? BOX[b] - xp : (xp > BOX[b + 1] ? xp - BOX[b + 1] : 0);
                    const by = yp < BOX[b + 2] ? BOX[b + 2] - yp : (yp > BOX[b + 3] ? yp - BOX[b + 3] : 0);
                    const reachB = rp + chunkR[key2] + (sole[key2] === op ? 0 : pad);
                    if (bx * bx + by * by >= reachB * reachB) continue;
                    b0 = rs[key2]; b1 = b0 + rc[key2];
                }
                for (let q = b0; q < b1; q++) {
                    const qm = meta[q], qPart = (qm >>> 16) & 1;
                    if (!(pPart | qPart) || (qm & 65280) !== pl) continue;
                    const q4 = q * 4, dx = rec[q4] - xp, dy = rec[q4 + 1] - yp, d2 = dx * dx + dy * dy;
                    const minDist = rp + rec[q4 + 2] + ((qm & 255) === op ? 0 : pad);
                    if (d2 >= minDist * minDist) continue;
                    const bq = ord[q];
                    if (bq < 0) continue;
                    const d = Math.sqrt(d2), overlap = minDist - Math.max(d, 0.001), qMoved = (qm & 131072) !== 0, iq = sid[q];
                    if (pPart) _sepSideA(ACC, p, -dx, -dy, d, ip, iq, overlap,
                        pMoved === qMoved ? (qPart ? BOTH : ONE) : (pMoved ? (qPart ? MOVER : ONE) : YIELD), Q);
                    if (qPart) _sepSideA(ACC, q, dx, dy, d, iq, ip, overlap,
                        qMoved === pMoved ? (pPart ? BOTH : ONE) : (qMoved ? (pPart ? MOVER : ONE) : YIELD), Q);
                }
            }
        }
    }
};
