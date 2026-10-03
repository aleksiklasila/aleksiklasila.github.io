// kbench variant: SEPARATION_FINISH without the fast[] writes of unlisted slots.
var KBENCH_VARIANT = function (R, P, chunk) {
    const X = R['unit.x'], Y = R['unit.y'], ON = R['unit.mvOn'], FL = R['unit.mvFlags'], ID = R['unit.id'], DEAD = R['unit.dead'];
    const PX = R['sep.px'], PY = R['sep.py'], OV = R['sep.ov'], HIT = R['sep.hit'];
    const outX = R['sep.nextX'], outY = R['sep.nextY'], fast = R['sep.fast'], EX = R['sep.ex'], EXC = R['sep.exc'];
    const CX = R['unit.sepCx'], CY = R['unit.sepCy'];
    const tile = P[2], quant = P[3], contacts = P[4], pushQuant = P[5], t = P[6] | 0, retry = P[7] | 0, per = P[1] | 0, gain = P[10] > 0 ? P[10] : 1;
    const now = P[11] > 0 ? P[11] : 1;
    const WALL = R['mv.wall'], LAYER = R['unit.sepLayer'], GW = P[8] | 0, GH = P[9] | 0;
    // Whether each unit moved by itself this tick (before the pushes), for
    // the next tick's separationStart.
    const SMV = R['unit.sepMov'], PRX = R['unit.prevX'], PRY = R['unit.prevY'];
    // (P[12] 1: tile changes indexed here; [13] index epoch, [14] sight
    // generation, [15] 1: any, [16] chunk size, [17] chunks across, [18]
    // absent key.)
    const IX = P[12] === 1, epoch = P[13] | 0, visGen = P[14] | 0, visAll = P[15] === 1, CS = P[16] | 0, CWK = P[17] | 0, absent = P[18];
    const SPE = R['unit.spEpoch'], SPO = R['unit.spOwner'], OWNO = R['unit.owner'], SEPK = R['unit.sepKey'], VSG = R['unit.vsGen'], SPT = R['unit.spTile'], AREA = R['unit.spArea'];
    const MVO = R['unit.spMvOld'], MVN = R['unit.spMvNew'], MVW = R['unit.spMvOwn'], AGF = R['ix.agrid'], MOVES = R['sep.moves'];
    let ne = 0, moves = 0;
    for (let i = chunk * per, end = Math.min(P[0], i + per); i < end; i++) {
        SMV[i] = X[i] !== PRX[i] || Y[i] !== PRY[i] ? 1 : 0;
        let dx = CX[i], dy = CY[i];
        if (dx !== 0 || dy !== 0) { CX[i] = 0; CY[i] = 0; }
        const hits = HIT[i];
        if (hits) {
            const scale = (hits <= contacts ? 1 : Math.sqrt(contacts / hits)) * gain;
            let px = PX[i] * scale / pushQuant, py = PY[i] * scale / pushQuant;
            const length = Math.sqrt(px * px + py * py), limit = Math.max(0, OV[i]);
            PX[i] = 0; PY[i] = 0; OV[i] = 0; HIT[i] = 0;
            if (length > limit) { px *= limit / length; py *= limit / length; }
            const hx = px * now, hy = py * now;
            dx += hx; dy += hy;
            if (!DEAD[i]) { CX[i] = px - hx; CY[i] = py - hy; }
        }
        if ((dx === 0 && dy === 0) || DEAD[i]) continue;
        const s = i, x = X[s], y = Y[s];
        outX[i] = dx; outY[i] = dy;
        // Preserve the sweep's last-step arithmetic (dx * steps / steps),
        // including its rounding before the final quantization.
        const steps = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) / (tile / 4)));
        const rawX = x + dx * steps / steps, rawY = y + dy * steps / steps;
        const nx = Number.isFinite(rawX) ? Math.round(rawX * quant) / quant : 0;
        const ny = Number.isFinite(rawY) ? Math.round(rawY * quant) / quant : 0;
        const gx = Math.floor(nx / tile), gy = Math.floor(ny / tile), ox = Math.floor(x / tile), oy = Math.floor(y / tile);
        if (gx !== ox || gy !== oy) {
            // Into another tile: committed here when the sweep cannot meet
            // a blocked tile (a flyer, or open ground over the tiles
            // between; off the map counts as blocked). Otherwise the swept
            // object commit (_commitUnitSeparation), in id order.
            let open = !!(WALL && LAYER);
            if (open && LAYER[s] !== 1) {
                if (Math.abs(gx - ox) > 1 || Math.abs(gy - oy) > 1) open = false;
                else {
                    const x0 = gx < ox ? gx : ox, x1 = gx < ox ? ox : gx, y0 = gy < oy ? gy : oy, y1 = gy < oy ? oy : gy;
                    if (x0 < 0 || y0 < 0 || x1 >= GW || y1 >= GH) open = false;
                    else if (WALL[y0 * GW + x0] | WALL[y0 * GW + x1] | WALL[y1 * GW + x0] | WALL[y1 * GW + x1]) open = false;
                }
            }
            if (open) {
                X[s] = nx; Y[s] = ny; fast[i] = 2;
                // Indexed as it was: its tile, area and chunk here (as the
                // movement kernel's epilogue), the chunk move counted by
                // SIM_KERNEL_SP_COUNTS; listed only on a retry tick.
                if (IX && SPE[s] === epoch && SPO[s] === OWNO[s] && SEPK[s] !== absent && (visAll || VSG[s] === visGen)) {
                    const cgx = gx < 0 ? 0 : gx >= GW ? GW - 1 : gx, cgy = gy < 0 ? 0 : gy >= GH ? GH - 1 : gy, tl = cgy * GW + cgx;
                    if (tl !== SPT[s]) {
                        const key = CS === 1 ? tl : Math.floor(cgy / CS) * CWK + Math.floor(cgx / CS), old = SEPK[s];
                        if (old !== key) { if (!MVW[s]) MVO[s] = old; MVN[s] = key; MVW[s] = SPO[s] + 1; SEPK[s] = key; moves = 1; }
                        const a = AGF[tl];
                        AREA[s] = a >= 0 ? a : -1;
                        SPT[s] = tl;
                    }
                    if (!(hits && (((t + ID[s]) | 0) % retry) === 0)) { fast[i] = 3; continue; }
                }
            }
            EX[chunk * per + ne++] = i;
            continue;
        }
        X[s] = nx; Y[s] = ny;
        fast[i] = hits && (((t + ID[s]) | 0) % retry) === 0 && !(ON[s] && (FL[s] & 4) === 0) ? 2 : 1;
        if (fast[i] === 2) EX[chunk * per + ne++] = i;
    }
    EXC[chunk] = ne;
    if (moves && MOVES) MOVES[0] = 1;
};
