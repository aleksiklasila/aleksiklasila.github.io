"use strict";
// ============================================================
// PROJECTILES
// ============================================================
// The shots are a pool in the wasm heap (wasm/src/proj.rs), a slot a shot,
// sized at the match's start (PROJ_POOL_CAP; a shot past it is not made,
// counted in hdr[3]): pj.* columns by slot, pj.live the slots in flight,
// pj.free a stack of the others, pj.hdr the counts. No objects. A step
// (projectilesAdvance): the flight kernel on the helpers, then the resolve
// kernel (spent slots freed; the hits listed); the hits on structures and
// floor targets by ord.rs k_proj_struct_hits (in the order of the shots'
// ids), those on units with the unit hits (unit.js unitHitsResolve, k.rs
// k_hits: sums, any order). Nothing depends on which slot a shot has, so a
// restored peer may lay them out differently.

// (Room for this many shots; the one budget's share: data_static.js.)
const PROJ_POOL_CAP = 1 << 17;
const PROJ_LOOKS = 256, PROJ_FLIGHT_PER_JOB = 512, PROJ_BLAST_PER_JOB = 256;
// Type codes (the kernels' pj.ty: tower.js _towerAcqTypes).
const PROJ_TYPE_CODES = { fire: 1, water: 2, poison: 3, ice: 4, elements: 5, sand_gun: 6, watch_tower: 7 };
// The status a type's stats map (renderer.js _getEffectStat), by its code.
const _PROJ_EFFECT = [null, 'fire', 'water', 'poison', 'ice', null, 'sand', 'watch'];
const _PROJ_COLS = {
    f64: ['x', 'y', 'vx', 'vy', 'sx', 'sy', 'range', 'dmg', 'bd', 'br'],
    f32: ['px', 'py', 'aim', 'sp'],
    i32: ['life', 'ft', 'lvl', 'shots', 'sd', 'id', 'ev', 'arg'],
    i16: ['tt'], i8: ['own'], u8: ['ty']
};
const _PROJ_TYPED = { f64: Float64Array, f32: Float32Array, i32: Int32Array, i16: Int16Array, i8: Int8Array, u8: Uint8Array };
// hdr: [0] in flight, [1] free, [2] next id, [3] not made (full), [4] unit
// hits, [5] structure hits, [6] looks, [7] unit hits with a status, [9] hash.
const _pj = { cap: 0, a: null, hdr: null, live: null, free: null, uev: null, sev: null, look: null, bsum: null, tfl: null, tflN: -1,
    hw: 0, unitHits: 0, P: new Float64Array(12), stats: { steps: 0, shots: 0 } };
// Type names by a static index (pj.tt: the same on every peer).
let _projTypeNames = null, _projTypeIds = null;
function _projTypeId(name) {
    if (!_projTypeIds) {
        _projTypeNames = typeof BASE_CARD_TYPES !== 'undefined' ? Object.keys(BASE_CARD_TYPES) : [];
        _projTypeIds = new Map(_projTypeNames.map((k, i) => [k, i]));
    }
    let i = _projTypeIds.get(name);
    if (i === undefined) { i = _projTypeNames.length; _projTypeNames.push(name); _projTypeIds.set(name, i); }
    return i;
}
function projTypeName(tt) { if (!_projTypeNames) _projTypeId(''); return _projTypeNames[tt] || ''; }

function _pjEnsure() {
    const P = _pj;
    if (P.cap && simHeapHas(P.hdr)) return P;
    const cap = PROJ_POOL_CAP, a = {};
    for (const kind in _PROJ_COLS) for (const k of _PROJ_COLS[kind]) { a[k] = simSharedArray(_PROJ_TYPED[kind], cap); simParallelBind('pj.' + k, a[k]); }
    P.a = a; P.cap = cap;
    for (const k of ['live', 'free', 'uev', 'sev']) { P[k] = simSharedArray(Int32Array, cap); simParallelBind('pj.' + k, P[k]); }
    P.hdr = simSharedArray(Int32Array, 16); P.look = simSharedArray(Int32Array, PROJ_LOOKS);
    P.bsum = simSharedArray(Int32Array, 2 * 128);
    for (const k of ['hdr', 'look', 'bsum']) simParallelBind('pj.' + k, P[k]);
    P.tflN = -1;
    projPoolClear();
    return P;
}
// Empty: every slot free (taken lowest first).
function projPoolClear() {
    const P = _pj;
    if (!P.cap) return;
    const F = P.free, H = P.hdr, n = P.cap;
    for (let i = 0; i < n; i++) F[i] = n - 1 - i;
    H.fill(0); H[1] = n; P.hw = 0; P.unitHits = 0;
}
function projCount() { return _pj.cap ? _pj.hdr[0] : 0; }

// A shot from (x, y) at t (a unit, a structure, a point): as the old
// Projectile's constructor. Its status's duration and tick damage as its
// owner's stats map them (else the kernels' defaults: 0, -1).
function projectileFire(x, y, t, type, dmg, level, source, maxRange, blastDamage = NaN, blastRadius = NaN, shots = 1) {
    const P = _pjEnsure(), H = P.hdr;
    if (H[1] <= 0) { H[3]++; return -1; }
    const s = P.free[--H[1]];
    P.live[H[0]++] = s;
    if (s >= P.hw) P.hw = s + 1;
    const A = P.a;
    // cos/sin(atan2) as an exact normalization: trig results may differ
    // between browsers, and lockstep peers must agree on every shot.
    const dx = t.x - x, dy = t.y - y, len = detHypot(dx, dy);
    A.x[s] = x; A.y[s] = y; A.sx[s] = x; A.sy[s] = y; A.px[s] = x; A.py[s] = y; A.aim[s] = len;
    if (len > 0) { A.vx[s] = dx / len * 8; A.vy[s] = dy / len * 8; } else { A.vx[s] = 8; A.vy[s] = 0; }
    A.life[s] = 100; A.range[s] = maxRange || 9999;
    const own = source ? source.owner : -1, lvl = Math.floor(Number(level) || 0), code = PROJ_TYPE_CODES[type] || 0;
    A.dmg[s] = dmg; A.lvl[s] = lvl; A.own[s] = Number.isFinite(own) ? own : -1; A.ty[s] = code; A.tt[s] = _projTypeId(type);
    A.shots[s] = shots > 1 ? shots : 1;
    // A blast: its damage around the unit hit, within its radius (pixels).
    const bd = Number.isFinite(blastDamage) ? Math.max(0, blastDamage) : 0, br = Number.isFinite(blastRadius) ? Math.max(0, blastRadius) : 0;
    A.bd[s] = bd > 0 && br > 0 ? bd : 0; A.br[s] = bd > 0 && br > 0 ? br * AREA_UNIT_TILE_EQUIVALENT * TILE : 0;
    // Floor items do not block shots; only the aimed-at one is hit.
    const floor = t && t.unitType === undefined && Number.isFinite(t.gx) && Number.isFinite(t.gy) && getFloorItemAtTile(t.gx, t.gy) === t;
    A.ft[s] = floor ? t.gy * GRID_W + t.gx : -1;
    const eff = _PROJ_EFFECT[code], lv = Math.max(1, lvl || 1);
    const dur = eff ? _getEffectStat(own, type, lv, eff, 'duration') : NaN, dps = eff ? _getEffectStat(own, type, lv, eff, 'dps') : NaN;
    A.sd[s] = Number.isFinite(dur) ? secondsToTicks(dur) : 0; A.sp[s] = Number.isFinite(dps) && dps >= 0 ? dps : -1;
    // (Its id: the tick and its tower's tile, as k_tower_fire's: one shot a
    // tower a step, unique among those in flight; a shot from nowhere by the count.)
    const tile = source && source._stT >= 0 ? source._stT : -1;
    A.id[s] = tile >= 0 ? (((gameTime & 1023) << 22) | tile) : (0x80000000 | H[2]) | 0; H[2] = (H[2] + 1) | 0;
    A.ev[s] = 0; A.arg[s] = -1;
    return s;
}

// The step's flight, its spent shots freed and their hits: structures here,
// units with the unit hits (P.unitHits for unitHitsResolve).
function projectilesAdvance() {
    const P = _pjEnsure(), H = P.hdr, n = H[0];
    P.unitHits = 0;
    if (n === 0) return;
    spatialIndexEnsure();
    for (const key of ['code', 'own', 'val']) simParallelBind('st.' + key, _ST[key]);
    const cplxOk = spatialUnitsComplex.length > 0 && spatialUnitsComplexStridePerChunk > 0 && spatialUnitsComplexStridePerPlayer > 0;
    if (cplxOk) simParallelBind('ix.complex', spatialUnitsComplex);
    const K = _simParams, per = Math.max(PROJ_FLIGHT_PER_JOB, Math.ceil(n / 64));
    K[0] = n; K[1] = per; K[2] = simDk; K[3] = GRID_W; K[4] = GRID_H; K[5] = TILE; K[6] = _sxEpoch;
    K[7] = spatialUnitsComplexPlayerCount; K[8] = cplxOk && _simParReg['ix.complex'] === spatialUnitsComplex ? spatialUnitsComplexStridePerChunk : 0; K[9] = GRID_W * GRID_H;
    simParallelRun(SIM_KERNEL_PROJ_FLIGHT, Math.ceil(n / per));
    const R = P.P;
    R[0] = PROJ_LOOKS;
    simRustDirect('k_proj_resolve', [P.live, P.free, H, P.a.ev, P.uev, P.sev, P.look, P.a.ty], R);
    const st = P.stats; st.steps++; st.shots += n;
    // (The looks: presentation only.)
    const A = P.a;
    for (let i = 0, nl = H[6]; i < nl; i++) {
        const s = P.look[i], type = projTypeName(A.tt[s]), x = A.x[s], y = A.y[s];
        recordCombatFx(COMBAT_FX.IMPACT, A.sx[s], A.sy[s], x, y, type);
        createExplosion(x, y, (A.ev[s] & 15) === 1 ? (A.ty[s] === 1 ? 'orange' : A.ty[s] === 2 ? '#4af' : A.ty[s] === 7 ? '#fd0' : '#fff') : '#f84', 4);
        playSound('impact', x, y, type);
    }
    if (H[5] > 0) _projStructHits(H[5]);
    P.unitHits = H[4];
}
// The step's hits on structures and floor targets (ord.rs k_proj_struct_hits).
function _projStructHits(n) {
    const P = _pj, A = P.a, R = P.P;
    // (The step's n hits: the list holds stale slots past them, which differ by peer.)
    R[0] = n;
    const K = _structHitsRun('k_proj_struct_hits', [P.sev, 'keys', A.id, A.dmg, A.ty, A.lvl, A.own, A.sd, A.sp, A.shots, A.arg, null, null, null], R, n);
    if (!K) return;
    _structHitsAfter(K, (s, tb, dmg) => { const own = A.own[s]; pushHostileDamageAlert(tb, dmg, own); recordDamageVisual(tb, dmg, own); });
}
// The unit hits' part (unit.js unitHitsResolve, before k_hits): the
// blasts' reach as room (touched units, fire's status records).
function projBlastRoom(nu) {
    const P = _pj, K = _simParams, per = Math.max(PROJ_BLAST_PER_JOB, Math.ceil(nu / 128)), jobs = Math.ceil(nu / per);
    K[0] = nu; K[1] = per; K[2] = GRID_W; K[3] = GRID_H; K[4] = TILE; K[5] = _sxEpoch;
    simParallelRun(SIM_KERNEL_PROJ_BLAST, jobs);
    let all = 0, fire = 0;
    for (let j = 0; j < jobs; j++) { all += P.bsum[2 * j]; fire += P.bsum[2 * j + 1]; }
    return [all, fire];
}
// Unit type flags (pj.tfl, by unit.upT): 1 immune to towers, 2 fire, 4
// water, 8 poison, 16 ice, 32 sand resistant.
function _projUnitFlags(b) {
    return (b.turretImmune ? 1 : 0) | (b.fireResistant ? 2 : 0) | (b.waterResistant ? 4 : 0) | (b.poisonResistant ? 8 : 0) | (b.iceResistant ? 16 : 0) | (b.sandResistant ? 32 : 0);
}
function projUnitFlagsTable() {
    const P = _pjEnsure(), nt = _simUnitTypeNames.length;
    if (P.tflN !== nt || !P.tfl || !simHeapHas(P.tfl)) {
        P.tfl = simSharedArray(Uint8Array, Math.max(64, nt * 2)); simParallelBind('pj.tfl', P.tfl);
        for (let i = 0; i < nt; i++) P.tfl[i] = _projUnitFlags(BASE_UNIT_STATS[_simUnitTypeNames[i]] || BASE_UNIT_STATS.norm);
        P.tflN = nt;
    }
    return P.tfl;
}

// ---- The pool's state outside the kernels: hash, snapshots, presentation ----
// The shots in flight hashed (k_proj_hash: a sum over them, any order).
function projHash() {
    const P = _pjEnsure(), A = P.a;
    simRustDirect('k_proj_hash', [P.live, P.hdr, A.x, A.y, A.vx, A.vy, A.life, A.sx, A.sy, A.range, A.own, A.ft, A.dmg, A.lvl, A.ty, A.tt, A.bd, A.br, A.shots, A.sd, A.sp, A.id], P.P);
    return P.hdr[9] >>> 0;
}
// The snapshot's records (utils_snapshot.js list 'p'): one plain object a
// shot, in id order, made when a snapshot is taken; the next id on the first.
const _PROJ_SNAP_FIELDS = ['x', 'y', 'vx', 'vy', 'life', 'sx', 'sy', 'range', 'own', 'ft', 'dmg', 'lvl', 'ty', 'bd', 'br', 'shots', 'sd', 'sp', 'id', 'aim'];
function projSnapshotRecords() {
    const P = _pjEnsure(), A = P.a, H = P.hdr, n = H[0], order = Array.from(P.live.subarray(0, n));
    order.sort((a, b) => A.id[a] - A.id[b]);
    const out = new Array(n);
    for (let i = 0; i < n; i++) {
        const s = order[i], r = { type: projTypeName(A.tt[s]) };
        for (const k of _PROJ_SNAP_FIELDS) r[k] = A[k][s];
        if (i === 0) r.next = H[2];
        out[i] = r;
    }
    if (n === 0 && H[2] !== 0) out.push({ next: H[2], none: 1 });
    return out;
}
// A restore: the pool made from the records (slots in their order).
function projSnapshotLoad(list) {
    const P = _pjEnsure(), A = P.a, H = P.hdr;
    projPoolClear();
    let next = 0;
    for (const r of list || []) {
        if (!r) continue;
        if (Number.isFinite(r.next)) next = r.next | 0;
        if (r.none || H[1] <= 0) continue;
        const s = P.free[--H[1]];
        P.live[H[0]++] = s;
        if (s >= P.hw) P.hw = s + 1;
        for (const k of _PROJ_SNAP_FIELDS) A[k][s] = Number(r[k]) || 0;
        A.tt[s] = _projTypeId(r.type || ''); A.px[s] = A.x[s]; A.py[s] = A.y[s]; A.ev[s] = 0; A.arg[s] = -1;
        if (!Number.isFinite(r.ft)) A.ft[s] = -1;
    }
    H[2] = next;
}
// Each shot in flight: fn(slot, columns) (presentation encoders).
function projForEach(fn) {
    const P = _pj;
    if (!P.cap) return 0;
    const n = P.hdr[0], L = P.live, A = P.a;
    for (let i = 0; i < n; i++) fn(L[i], A);
    return n;
}

// A structure's kind among those shots hit (tower.js): 0 tower, 1 barrack,
// 2 spawner, -1 none of these.
function _projBuildingKind(b) {
    return b instanceof Tower ? 0 : b instanceof Barrack ? 1 : isSpawnerEntity(b) ? 2 : -1;
}
