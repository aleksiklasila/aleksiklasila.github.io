// A snapshot's units as a block of columns (RESTORE_WASM_PLAN.md; kernels wasm/src/snap_units.rs).
//
// The sender gathers each unit's state columns in id order into one binary block (base64 in the snapshot's
// JSON); the receiver makes the units in slots and writes the columns over them. No unit object on either
// side (unit objects are lazy: sim_unit_state.js _simUnitObject). What travels is the columns as they are:
// a unit's targets as ids and tiles, its type's index with the sender's type names, shared columns' ids with
// the sender's pools, its worker and status records, its path as nodes (a path many units share: once).

// The state columns: [column, mode, word, flags] (snap_units.rs: modes 0 by slot, 1 worker record, 2 status
// record, 3 a word of the slot's record; flags 1 ids remapped, 2 unit.esVer as the stats-behind bit).
const SNAP_UB_SLOT_COLS = ['id', 'owner', 'x', 'y', 'vx', 'vy', 'energy', 'r', 'collisionR', 'pathIndex', 'commandState', 'attackTimer',
    'attackFlash', 'workerTransferCooldown', ...SIM_UNIT_LEVEL_COLUMNS, 'jRmNow', 'jFly', 'jMaxE', 'maxE', 'atkL', 'wtcL', 'nvPK', 'tbT',
    'acqB', 'mvTgX', 'mvTgY', 'rkF', 'tuId', 'fatF', 'amGx', 'amGy', 'ptSt', 'ptGx', 'ptGy', 'ptCmd', 'ptSrc', 'ptVer', 'ptAt', 'ptSub',
    'mvPP', 'mvPF', 'wkS', 'wkT', 'wkR', 'wkN', 'wkIdle', 'dead', 'mvNavLD', 'sepMov', 'fLsX', 'fLsY', 'rtEnd', 'nvProf', 'wTeam', 'holdF',
    'isWk', 'rsEnd', 'navRdy', 'agWait', 'idleFV', 'esOk', 'esRad', 'esType', 'lzAcc', 'lzBeam', 'hObj', 'abBlk'];
// (Object fields kept as ids into a pool of values: the pools travel. And a number column.)
const SNAP_UB_SHARED_COLS = ['oc_holdPosition', 'oc__scoutTarget', 'oc_workerType'];
const SNAP_UB_NUM_COLS = ['oc__astarBudgetRetryTick'];
const SNAP_UB_WK_COLS = ['wkWx', 'wkWy', 'wkLmt', 'wbType', 'wbTick', ...SIM_WK_MEM_COLS.map(e => e[1])];
const SNAP_UB_ST_COLS = SIM_UNIT_ST_SIDE.filter(e => e[2]).map(e => e[0]);
let _snapUbSpecs = null;
function _snapUbSpec() {
    if (_snapUbSpecs) return _snapUbSpecs;
    const L = [];
    for (const k of SNAP_UB_SLOT_COLS) L.push([k, 0, 0, 0]);
    L.push(['upT', 0, 0, 1], ['esVer', 0, 0, 2]);
    for (const k of SNAP_UB_SHARED_COLS) L.push([k, 0, 0, 1]);
    for (const k of SNAP_UB_NUM_COLS) L.push([k, 0, 0, 0]);
    L.push(['mvSteer', 3, SIM_ST_FLOOR, 0]);
    for (const k of SNAP_UB_WK_COLS) L.push([k, 1, 0, 0]);
    for (const k of SNAP_UB_ST_COLS) L.push([k, 2, 0, 0]);
    return _snapUbSpecs = L;
}
// The kernels' scratch: heap arrays kept from call to call (grown, never per unit).
const _ub = { P: new Float64Array(40), text: typeof TextDecoder === 'function' ? new TextDecoder() : null, bytes: typeof TextEncoder === 'function' ? new TextEncoder() : null };
function _ubArr(key, Type, n) {
    let a = _ub[key];
    if (!a || a.length < n || !simHeapHas(a)) {
        if (a && simHeapHas(a)) simHeapFree(a);
        a = _ub[key] = simHeapArray(Type, Math.max(1024, Math.ceil(n * 1.125)));
        if (!simHeapHas(a)) throw new Error('snapshot units: no room in the wasm heap for ' + n + ' ' + Type.name);
        // (Zeroed: the marks' scratch is clear between calls, the kernels clear what they set.)
        a.fill(0);
    }
    return a;
}
// The column table (CT_W = 8 words a column) for the state's columns as they are now.
function _snapUbTable(S) {
    const C = S.columns, spec = _snapUbSpec(), n = spec.length, ct = _ubArr('ct', Int32Array, n * 8);
    ct.fill(0, 0, n * 8);
    const sig = [];
    for (let j = 0; j < n; j++) {
        const [k, mode, word, fl] = spec[j];
        let a = C[k];
        if (a && !ArrayBuffer.isView(a)) a = a.data;
        if (!a || !simHeapHas(a)) throw new Error('snapshot units: column ' + k + ' not in the wasm heap');
        const signed = a instanceof Int8Array || a instanceof Int16Array || a instanceof Int32Array;
        ct[8 * j] = _simWEnc(_simHeapPtrOf(a)); ct[8 * j + 1] = a.BYTES_PER_ELEMENT; ct[8 * j + 2] = mode;
        ct[8 * j + 3] = mode === 3 ? SIM_STEER_W : 1; ct[8 * j + 4] = word; ct[8 * j + 5] = fl | ((fl & 1) && !signed ? 4 : 0);
        sig.push(k + (mode === 3 ? '@' + word : '') + ':' + ((fl & 3) ? 4 : a.BYTES_PER_ELEMENT));
    }
    return { ct, n, sig: sig.join(','), at: name => spec.findIndex(e => e[0] === name) };
}
// The block's length in bytes (snap_units.rs layout).
function _snapUbBytes(T, n, nwk, nst, np, nodes) {
    let b = 64 + 12 * n;
    for (let j = 0; j < T.n; j++) {
        const mode = T.ct[8 * j + 2], cnt = mode === 1 ? nwk : mode === 2 ? nst : n, bb = (T.ct[8 * j + 5] & 3) ? 4 : T.ct[8 * j + 1];
        b = (b + cnt * bb + 3) & ~3;
    }
    return b + 12 * np + 12 * nodes;
}
// A worker record's columns at their defaults (sim_unit_state.js _simWkInit), as a table for the kernel
// (nfs.rs spawn_put: address, bytes, 1; kinds; defaults).
function _snapUbWkTable(S) {
    const C = S.columns;
    if (_ub.wFor === C.wbType && simHeapHas(_ub.wtab)) return _ub;
    const L = SIM_UNIT_WK_SIDE.filter(([k]) => C[k] && simHeapHas(C[k])), m = L.length;
    for (const a of [_ub.wtab, _ub.wkind, _ub.wdefs]) if (a && simHeapHas(a)) simHeapFree(a);
    _ub.wtab = simHeapArray(Int32Array, 3 * m + 3); _ub.wkind = simHeapArray(Int32Array, m + 4); _ub.wdefs = simHeapArray(Float64Array, m + 2);
    L.forEach(([k], j) => {
        const a = C[k];
        _ub.wtab[3 * j] = _simWEnc(_simHeapPtrOf(a)); _ub.wtab[3 * j + 1] = a.BYTES_PER_ELEMENT; _ub.wtab[3 * j + 2] = 1;
        _ub.wkind[j] = a instanceof Float64Array ? 3 : a instanceof Float32Array ? 2 : 1;
        _ub.wdefs[j] = k in SIM_WK_DEFAULTS ? SIM_WK_DEFAULTS[k] : 0;
    });
    _ub.wN = m; _ub.wFor = C.wbType;
    return _ub;
}

// ---- Encode ----
// The units of slots list[0..n) (in id order) as the snapshot's unit block: { n, sig, types, pools, b }.
function snapUnitsEncode(list, n) {
    const S = _simUnitState, C = S.columns, P = _ub.P;
    simUnitWkReserve(1); simUnitStReserve(1);
    const T = _snapUbTable(S);
    let H = 1024;
    while (H < 2 * n) H *= 2;
    const sc = _ubArr('sc', Int32Array, 7 * n + H), out = _ubArr('out', Int32Array, 16);
    const arena = SIM_PATH.a && simHeapHas(SIM_PATH.a) ? SIM_PATH.a : null;
    P.fill(0); P[0] = n; P[1] = H;
    simRustDirect('k_ub_count', [list, C.wkIx, C.stIx, C.pthH, C.pathIndex, arena, sc, out], P);
    const nwk = out[0], nst = out[1], np = out[2], nodes = out[3];
    const bytes = _snapUbBytes(T, n, nwk, nst, np, nodes), blk = _ubArr('blk', Uint8Array, bytes);
    _spbSpatialTables();
    const sver = _unitStatsVerTable(spatialUnitsComplexPlayerCount), sverOk = simHeapHas(sver);
    P.fill(0); P[0] = n; P[1] = T.n; P[2] = nwk; P[3] = nst; P[4] = np; P[5] = nodes; P[6] = UNIT_STATS_VER_TYPES; P[7] = _spbTyN; P[8] = sverOk ? sver.length : 0;
    simRustDirect('k_ub_gather', [list, C.wkIx, C.stIx, T.ct, sc, arena, blk, C.owner, C.upT, _spbTy, sverOk ? sver : null], P);
    const tlen = 4 * Math.ceil(bytes / 3), txt = _ubArr('txt', Uint8Array, tlen);
    P[0] = bytes;
    simRustDirect('k_b64_enc', [blk, txt], P);
    // (Text from a copy: a decoder takes no view of shared memory.)
    const copy = new Uint8Array(tlen);
    copy.set(txt.subarray(0, tlen));
    const pools = {};
    for (const k of SNAP_UB_SHARED_COLS) pools[k] = C[k].pool.values.map(_snapE);
    return { n, sig: T.sig, types: _simUnitTypeNames.slice(), pools, b: _ub.text.decode(copy) };
}
// The slots of the units to send, in id order (the id table's rows): all of them, or those standing in the
// carried regions (a set of region codes, SNAP_REGION_TILES) plus the units of `also` (objects).
function snapUnitsSelect(regions, also) {
    const R = unitRows(), n = R.n, P = _ub.P, out = _ubArr('sel', Int32Array, n + 1), cnt = _ubArr('selN', Int32Array, 4);
    let bits = null, mark = null;
    if (regions) {
        const words = 32768;
        bits = _ubArr('rbits', Uint32Array, words);
        bits.fill(0, 0, words);
        for (const r of regions) if (r >= 0 && r < words * 32) bits[r >>> 5] |= 1 << (r & 31);
        const S = _simUnitState;
        if (also && also.length) {
            mark = _ubArr('smark', Uint8Array, S.cap);
            mark.fill(0, 0, S.cap);
            for (const u of also) if (u && u._us === S.columns && u._si >= 0) mark[u._si] = 1;
        }
    }
    const C = _simUnitState.columns;
    P.fill(0); P[0] = n; P[1] = TILE * SNAP_REGION_TILES; P[2] = regions ? 0 : 1; P[3] = mark ? 1 : 0;
    simRustDirect('k_ub_select', [R.ids, R.slots, C.x, C.y, bits, mark, out, cnt], P);
    if (!regions && cnt[1] > 0) throw new Error('snapshot units: ' + cnt[1] + ' units without a slot');
    return { list: out, n: cnt[0] };
}
// The units' order (runs of consecutive ids: start, count), from the id table.
function snapUnitsOrder() {
    const R = unitRows(), out = _ubArr('ord', Int32Array, 2 * R.n + 2), cnt = _ubArr('selN', Int32Array, 4), P = _ub.P;
    P.fill(0); P[0] = R.n;
    simRustDirect('k_ub_order', [R.ids, R.slots, out, cnt], P);
    return Array.from(out.subarray(0, cnt[0]));
}

// ---- Decode ----
// The block's bytes in the heap (blk), its header.
function _snapUbBlock(ub) {
    const src = _ub.bytes.encode(ub.b), m = src.length;
    if (m % 4 !== 0) throw new Error('snapshot units: block text of ' + m + ' characters');
    const inb = _ubArr('txt', Uint8Array, m), blk = _ubArr('blk', Uint8Array, (m / 4) * 3 + 16), out = _ubArr('out', Int32Array, 16), P = _ub.P;
    inb.set(src);
    P.fill(0); P[0] = m;
    simRustDirect('k_b64_dec', [inb, blk, out], P);
    if (!(out[0] >= 64)) throw new Error('snapshot units: block not base64');
    if (blk.byteOffset % 4 !== 0) throw new Error('snapshot units: block not aligned');
    const h = new Int32Array(blk.buffer, blk.byteOffset, 16);
    return { blk, n: h[1], ncol: h[2], nwk: h[3], nst: h[4], np: h[5], nodes: h[6], bytes: h[7], ver: h[0] };
}
// Ids of the sender's values into this peer's: the unit types (by name), the shared columns' pools (by value;
// values this peer's pool lacks join it, the column widened as a set would).
function _snapUbRemaps(S, ub) {
    const C = S.columns, maps = [];
    const types = Array.isArray(ub.types) ? ub.types : [];
    maps.push(['upT', types.map(name => simUnitTypeIndex(name))]);
    for (const k of SNAP_UB_SHARED_COLS) {
        const col = C[k], P = col.pool, vals = (ub.pools && Array.isArray(ub.pools[k]) ? ub.pools[k] : []).map(_snapD);
        const ids = vals.map(v => {
            const key = Object.is(v, -0) ? P.negativeZero : v;
            let id = P.ids.get(key);
            if (id === undefined) { id = P.values.length; P.values.push(v); P.ids.set(key, id); }
            return id;
        });
        const top = ids.length ? Math.max(...ids) : 0, w = col.data.BYTES_PER_ELEMENT;
        if (top > (w === 1 ? 255 : w === 2 ? 65535 : 4294967295)) col._replace(simHeapArray(top > 65535 ? Uint32Array : Uint16Array, col.length).fill(0));
        maps.push([k, ids]);
    }
    return maps;
}
function _snapUbRemapTable(T, maps) {
    let total = 0;
    for (const [, m] of maps) total += m.length;
    const R = _ubArr('remap', Int32Array, total + 1);
    let at = 0;
    for (const [k, m] of maps) {
        const j = T.at(k);
        T.ct[8 * j + 6] = at; T.ct[8 * j + 7] = m.length;
        for (let i = 0; i < m.length; i++) R[at + i] = m[i];
        at += m.length;
    }
    return R;
}
// The block's units made in slots, their columns written: a whole restore (after simUnitStateReleaseAll and
// the reservation: the units in slots 0.. by block) or a patch (a unit this peer has keeps its slot, the
// others take free ones). Returns { list: their slots (heap, in the block's order), n, kept: per unit 1 when
// it kept its slot (a patch), fresh: the new units' rows for the id table (a patch: ids, slots, count) }.
function snapUnitsDecode(ub, partial) {
    const S = _simUnitState || _simUnitStateNew(), P = _ub.P;
    if (!ub || ub.sig === undefined) throw new Error('snapshot units: no unit block');
    const B = _snapUbBlock(ub), n = B.n;
    if (B.ver !== 1) throw new Error('snapshot units: block version ' + B.ver);
    // Room first (worker and status records, handles, the id table and hash): their columns may be made anew, the
    // table names them after.
    simUnitWkReserve(B.nwk + 1); simUnitStReserve(B.nst + 1);
    const maps = _snapUbRemaps(S, ub);
    const T = _snapUbTable(S);
    if (T.sig !== ub.sig || T.n !== B.ncol) throw new Error('snapshot units: columns differ from this peer\'s');
    const remap = _snapUbRemapTable(T, maps), C = S.columns, W = _simWkPool(S), ST = S.st;
    _simHandleGrow(S, S.hnext + n + 1);
    if (!simHeapHas(S.hfree)) { const h = simHeapArray(Int32Array, Math.max(1024, S.hfree.length)); h.set(S.hfree); S.hfree = h; }
    if (!partial) { _uix.n = 0; _uix.holes = 0; _uix.loose.clear(); }
    _uixRoom(_uix.n + n);
    // (The id hash: made anew for a whole restore, room for the patch's units otherwise.)
    if (!partial) { _unitById.dispose(); _unitById = new UnitIdIndex(); _unitById.S = S; _unitById._make(n); }
    const map = _unitById;
    if (partial) { if (!map._ok()) map._make(n); if ((map.used + n) * 2 > map.t.length) map._make(n); }
    const sl = S.sl;
    if (sl.gw !== GRID_W || sl.gh !== GRID_H) { _simSlabKeys(sl); for (let i = 0; i < sl.slabs; i++) sl.home[i] = -1; _simSlabRelist(sl); }
    _simSlabReserve(sl, Math.ceil(S.cap / SIM_SLAB));
    if (!simHeapHas(sl.hdr)) { const h = simHeapArray(Int32Array, 8); h.set(sl.hdr); sl.hdr = h; }
    sl.hdr[7] = S.owners.length;
    const wt = _snapUbWkTable(S);
    const bs = _ubArr('bs', Int32Array, n + 1), kept = _ubArr('kept', Uint8Array, n + 1), keys = _ubArr('keys', Int32Array, n + sl.nk + 2), out = _ubArr('out', Int32Array, 16);
    const nids = _ubArr('nids', Int32Array, n + 1), nslots = _ubArr('nslots', Int32Array, n + 1);
    kept.fill(0, 0, n);
    P.fill(0);
    P[0] = n; P[1] = Math.min(S.cap, sl.sfree.length * SIM_SLAB); P[2] = SIM_SLAB_SLACK_MIN; P[3] = SIM_SLAB_SLACK_SHIFT; P[4] = TILE; P[5] = SIM_SLAB_KEY_TILES;
    P[6] = sl.kw; P[7] = sl.kh; P[8] = sl.nk; P[9] = S.hfreeN; P[10] = S.hnext; P[11] = W.freeCount; P[12] = W.used; P[13] = W.cap;
    P[14] = map.mask; P[15] = _uix.n; P[16] = SIM_SEP_ABSENT; P[17] = T.at('x'); P[18] = T.at('y'); P[19] = T.at('id'); P[20] = wt.wN; P[21] = partial ? 1 : 0; P[22] = ST.cap;
    simRustDirect('k_ub_births', [B.blk, T.ct, sl.bits, sl.sfree, sl.home, sl.cur, sl.heads, sl.entries, sl.used, sl.ever, sl.hdr,
        C.hslot, S.hfree, _uix.ids, _uix.slots, map.t, W.free, ST.free, ST.hdr, out, bs, C.hnd, C.live, C.tmOn, S.sepKey, C.wkIx, C.stIx,
        wt.wtab, wt.wkind, wt.wdefs, keys, C.id, kept, nids, nslots], P);
    if (out[5] >= 0) throw new Error('snapshot units: no slot for unit ' + out[5] + ' of ' + n);
    if (out[6] || out[7]) throw new Error('snapshot units: records past the reservation (worker ' + out[6] + ', status ' + out[7] + ')');
    const made = out[0], fresh = out[9];
    S.hfreeN = out[1]; S.hnext = out[2]; W.freeCount = out[3]; W.used = out[4];
    if (S.objs.length < S.hnext) { const L0 = S.objs.length; S.objs.length = S.hnext; S.objs.fill(null, L0); }
    S.owners.length = sl.hdr[7];
    if (!partial) { sl.layout = 1; _uix.n = n; _uix.holes = 0; }
    else if (fresh > 0) {
        // (A patch's new units into the id table, in id order: holes squeezed first.)
        unitRows();
        P.fill(0); P[0] = _uix.n; P[1] = fresh;
        simRustDirect('k_ub_uix_merge', [_uix.ids, _uix.slots, nids, nslots], P);
        _uix.n += fresh;
    }
    _uix.ver++;
    map.used += made; map.size += made;
    // (A whole restore: a new id table; its index and the slots' collection go by it.)
    if (!partial) { _uix.epoch++; _unitByIdFor = _uix.epoch; S.unitsRef = _simUnitsEpoch(); }
    // (A patch's kept units' reservations let go before their columns are written: the patch has their entries.)
    if (partial) snapUnitsReservationsDrop(bs, kept, n);
    // The columns (chunks of 4096 units).
    P.fill(0); P[0] = n; P[1] = n; P[3] = T.at('x'); P[4] = T.at('y');
    simRustDirect('k_ub_scatter', [B.blk, T.ct, bs, C.wkIx, C.stIx, remap, C.x0, C.y0, C.prevX, C.prevY, partial ? kept : null, C.tmOn], P);
    // (Their upkeep bins, as the level and owner setters keep them: birth.rs k_upk_bins.)
    _spawnUpkeep(bs, n, C);
    // The paths: the room they may take, then made.
    const pa = simPathArena(), hs = _ubArr('hs', Int32Array, B.np + 1);
    P.fill(0); P[0] = n; P[1] = pa.top; P[2] = 0; P[3] = pa.a.length;
    simRustDirect('k_ub_paths', [B.blk, T.ct, pa.a, pa.free, C.pthH, out, bs, hs], P);
    simPathArena(out[0]);
    const pb = SIM_PATH;
    P[1] = pb.top; P[2] = 1; P[3] = pb.a.length; out[1] = 0;
    simRustDirect('k_ub_paths', [B.blk, T.ct, pb.a, pb.free, C.pthH, out, bs, hs, C.mvPath, S.pathPool ? S.pathPool.fs : null], P);
    if (out[1]) throw new Error('snapshot units: the path store had no room');
    pb.top = out[0];
    // Their target units' slots (from the ids, the hash now holding every unit).
    P.fill(0); P[0] = n; P[1] = n; P[2] = map.mask;
    simRustDirect('k_ub_targets', [bs, C.tuId, C.tuS, map.t, C.id, C.hnd], P);
    return { list: bs, n, kept, made };
}

// ---- After the columns ----
// Units' stat rows and movement columns from their levels (k.rs k_unit_stats_apply: the rows as
// things_utils.js _effRowAttach makes them, the movement columns as unit.js simMoveStatsChanged; energy, max
// energy and the last applied level as they are; no arming: every unit is disarmed then). The type by the
// unit type's index (unit.upT -> its stats type), not unit.esType (set only once its effective stats ran).
function snapUnitsDerive(list, n) {
    const S = _simUnitState, C = S.columns, U = unitStatTables(), P = _ub.P;
    if (!(n > 0)) return;
    _spbSpatialTables();
    const ty = _ubArr('ty8', Int8Array, S.cap);
    P.fill(0); P[0] = n; P[1] = _spbTyN;
    simRustDirect('k_ub_types', [list, C.upT, _spbTy, ty], P);
    _simMoveAreaBoxes();
    P.fill(0); P[0] = n; P[1] = U.NT; P[2] = U.L1; P[3] = U.NP; P[4] = SIM_MOVE_BOX_STEPS;
    simRustDirect('k_unit_stats_apply', [list, C.owner, ty, C.baseLevel, C.effectiveLevel, null, null, null, null, C.statRow, C.bsRow,
        null, null, null, C.r, _effHot, _effRowCols.rMaxE, U.tys, _effRowCols.rWch, C.mvLane, C.mvReachD, C.mvReachA, C.mvShoot, C.mvRangeK, C.lzFlags,
        C.atkSty, C.atkWatch, null, null, null, C.spArea, _simMoveAreaBoxOk], P);
}
// Units into the unit index (tch.rs k_spawn_spatial, as updateUnitSpatial puts a unit there: the dead too).
function snapUnitsSpatialIn(list, n) {
    const S = _simUnitState, c = S.columns;
    if (!(n > 0)) return;
    if (CHUNK_SIZE !== 1) throw new Error('snapshot units: k_spawn_spatial takes chunks of one tile');
    if (_spatialCountDefer) throw new Error('snapshot units: a restore inside the unit pass');
    if (_sxPre && typeof _inGameTick !== 'undefined' && !_inGameTick) spatialIndexInvalidate();
    _spbSpatialTables();
    if (!simHeapHas(cellArea) && typeof cellColumnsRehome === 'function') cellColumnsRehome();
    const P = _ub.P;
    P.fill(0);
    P[0] = n; P[1] = GRID_W; P[2] = GRID_H; P[3] = TILE * 8; P[4] = spatialEpoch; P[5] = spatialUnitsComplexStridePerChunk; P[6] = spatialTypeStridePerBlock; P[7] = spatialUnitsComplexUnitTypeCount;
    P[8] = spatialUnitsComplexPlayerCount; P[9] = spatialNormUnitTypeIndex; P[10] = CHUNKS_W; P[11] = SPATIAL_TYPE_BLOCK; P[12] = spatialTypeBlocksW; P[13] = SPATIAL_BLOCK_SIZE; P[14] = spatialBlockCols;
    if (typeof tickStartChainSettleHostile === 'function') tickStartChainSettleHostile();
    simRustDirect('k_spawn_spatial', [list, c.x, c.y, c.owner, c.upT, _spbTy, _spbLayer, cellArea, c.spTile, S.sepKey, S.sepLayer, c.spArea, c.spOwner, c.spEpoch, c.spType, c.mvOn,
        spatialUnitsComplex, spatialTypeCounts, spatialBlockCounts, null], P);
}
// Units out of it (chunk.js removeUnitSpatial's counts; the occupancy is made again after a restore).
function snapUnitsSpatialOut(list, n) {
    const S = _simUnitState, c = S.columns, P = _ub.P;
    if (!(n > 0)) return;
    if (_sxPre && typeof _inGameTick !== 'undefined' && !_inGameTick) spatialIndexInvalidate();
    if (typeof tickStartChainSettleHostile === 'function') tickStartChainSettleHostile();
    P.fill(0);
    P[0] = n; P[1] = spatialEpoch; P[2] = SIM_SEP_ABSENT; P[3] = spatialUnitsComplexStridePerChunk; P[4] = SPATIAL_TYPE_BLOCK; P[5] = spatialTypeBlocksW; P[6] = spatialTypeStridePerBlock;
    P[7] = SPATIAL_BLOCK_SIZE; P[8] = spatialBlockCols; P[9] = spatialUnitsComplexPlayerCount; P[10] = spatialUnitsComplexUnitTypeCount; P[11] = CHUNKS_W;
    simRustDirect('k_ub_spatial_out', [list, c.spEpoch, S.sepKey, c.spOwner, c.spType, spatialUnitsComplex, spatialTypeCounts, spatialBlockCounts, c.spTile, c.mvOn], P);
}
// Worker reservations as [slot, unit id, ...]: the whole table, or those of the units of list (n) outside the
// carried regions (region bits as snapUnitsSelect made them: _ub.rbits).
function snapUnitsReservations(list, n) {
    let table = workerReservedTiles;
    if (!table || !table.length) return [];
    if (!simHeapHas(table)) { const t = workerReservedTable(); t.set(table.subarray(0, Math.min(t.length, table.length))); workerReservedTiles = table = t; workerReservedCountsInvalidate(); }
    const C = _simUnitState.columns, P = _ub.P, cnt = _ubArr('selN', Int32Array, 4);
    const out = _ubArr('res', Int32Array, list ? 2 * n + 2 : 2 * table.length + 2);
    P.fill(0); P[0] = table.length; P[1] = list ? 1 : 0; P[2] = n; P[3] = _WORKER_TARGET_LOAD_TYPE_COUNT; P[4] = GRID_W; P[5] = SNAP_REGION_TILES;
    simRustDirect('k_ub_res', [table, list, C.wkR, C.id, list ? _ub.rbits : null, out, cnt], P);
    return Array.from(out.subarray(0, cnt[0]));
}
// A patch's kept units' reservations let go before their columns are written (the patch's entries follow).
function snapUnitsReservationsDrop(bs, kept, n) {
    const table = workerReservedTiles, C = _simUnitState.columns, P = _ub.P;
    if (!table || !table.length || !simHeapHas(table) || !(n > 0)) return;
    if (typeof workerReservedCountsInvalidate === 'function') workerReservedCountsInvalidate();
    P.fill(0); P[0] = n; P[1] = table.length;
    simRustDirect('k_ub_res_drop', [bs, kept, C.wkR, table, C.id], P);
}
// A patch with the units' order: the units this peer has that the sender's lacks leave (out of the unit index,
// the id table and hash; their slots let go as the retire pass lets them go). Their count.
function snapUnitsDropByOrder(runs) {
    const S = _simUnitState, R = unitRows(), P = _ub.P;
    const enc = _ubArr('runs', Int32Array, runs.length + 2), out = _ubArr('drop', Int32Array, R.n + 1), cnt = _ubArr('selN', Int32Array, 4);
    for (let i = 0; i < runs.length; i++) enc[i] = runs[i];
    P.fill(0); P[0] = R.n; P[1] = runs.length;
    simRustDirect('k_ub_drop', [R.ids, R.slots, enc, out, cnt], P);
    const m = cnt[0];
    if (cnt[1] > 0) throw new Error('snapshot units: ' + cnt[1] + ' units without a slot to drop');
    if (!(m > 0)) return 0;
    _uix.holes += m; _uix.ver++;
    _snapUnitsRelease(out, m);
    return m;
}
// Units' slots let go (m slots of the heap list L): out of the unit index and the id hash, no rows, paths or path
// windows, then as the retire pass lets them go.
function _snapUnitsRelease(L, m) {
    const S = _simUnitState, C = S.columns, P = _ub.P, pa = SIM_PATH.a && simHeapHas(SIM_PATH.a) ? SIM_PATH : null;
    snapUnitsSpatialOut(L, m);
    _unitById.deleteSlots(L, m, []);
    P.fill(0); P[0] = m;
    simRustDirect('k_ub_unslot', [L, C.statRow, C.bsRow, C.live, C.mvOut, C.mvPath, S.pathPool ? S.pathPool.fs : null, C.pthH, pa ? pa.a : null, pa ? pa.free : null], P);
    simUnitStateDetachGoneMany(S, L, m);
}
// A patch: the slots holding a unit the id table does not (snap_units.rs k_ub_ghosts) let go, as a new units list
// collected them (simUnitStateCollect): a unit taken out of the list without its slot.
function snapUnitsCollectGhosts() {
    const S = _simUnitState, R = unitRows(), P = _ub.P, n = Math.min(S.owners.length, S.cap);
    const mark = _ubArr('ghMark', Uint8Array, S.cap), out = _ubArr('ghost', Int32Array, n + 1), cnt = _ubArr('selN', Int32Array, 4);
    P.fill(0); P[0] = n; P[1] = R.n;
    simRustDirect('k_ub_ghosts', [S.columns.hnd, R.slots, mark, out, cnt], P);
    if (cnt[0] > 0) _snapUnitsRelease(out, cnt[0]);
    return cnt[0];
}
// effStatsAllUnits' marks (snap_units.rs k_ub_eff_taken): every unit but the stale owners' units the patch did not
// carry (skip: its units' slots, n) taken at stamp.
function snapUnitsEffTaken(owners, skip, n, stamp) {
    const S = _simUnitState, R = unitRows(), P = _ub.P, np = Math.max(1, players.length);
    const own = _ubArr('effOwn', Uint8Array, np), mark = _ubArr('effMark', Uint8Array, S.cap);
    own.fill(0, 0, np);
    for (const o of owners) if (o >= 0 && o < np) own[o] = 1;
    if (!skip) skip = _ubArr('effNone', Int32Array, 1);
    P.fill(0); P[0] = R.n; P[1] = skip ? (n | 0) : 0; P[2] = np; P[3] = stamp;
    simRustDirect('k_ub_eff_taken', [R.slots, S.columns.owner, own, skip, mark, S.columns.esTaken], P);
}
