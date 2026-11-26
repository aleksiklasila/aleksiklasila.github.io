//! A structure placed (things_utils.js placeBuilding: a place action, a starter building, a snapshot's), the inverse
//! of dst.rs: the checks, its class table's row taken and written as the constructors and the placement wrote it, its
//! tile's entry in the per-tile structure table, its cell, the marks (adjacency, the workers' work versions, the tile
//! entity journal, the collectors' groups' journal), the tower due entry. No object is made: the JavaScript makes one
//! when the structure is first read (data_state.js structRowObj), and applies the events of systems that are not
//! tables yet (list versions, the walk classes, laser and cloud lists, sounds).
use super::*;
use super::k::K;

#[inline(always)]
unsafe fn g<T: Copy>(p: *const T, i: usize) -> T {
    *p.add(i)
}
#[inline(always)]
unsafe fn s<T>(p: *mut T, i: usize, v: T) {
    *p.add(i) = v;
}

const ST_OWNER_NONE: i32 = 0x7ff9;

// The row's columns (array [29], encoded heap addresses; 0: the class has none), data_state.js PLACE_COLS.
const F_STT: usize = 0; // i32 _stT
const F_OW: usize = 1; // i8 _ow
const F_UC: usize = 2; // u8 _uc (b)
const F_EN: usize = 3; // f64 _en
const F_GX: usize = 4; // i16
const F_GY: usize = 5; // i16
const F_STACKS: usize = 6; // i32
const F_MANUAL: usize = 7; // i32
const F_EFFST: usize = 8; // i32
const F_LEVEL: usize = 9; // i8
const F_EFFLV: usize = 10; // i8
const F_POTLV: usize = 11; // i8
const F_ISSTACK: usize = 12; // u8 (b)
const F_STWORK: usize = 13; // f64
const F_SALV: usize = 14; // u8 (b)
const F_AUTO: usize = 15; // u8 (b)
const F_BUILD: usize = 16; // u8 (b)
const F_CD: usize = 17; // f64 _cdUntil
const F_ANGLE: usize = 18; // f32
const F_LZST: usize = 19; // i8 laserState
const F_LZTIM: usize = 20; // f64 laserTimer
const F_PTK: usize = 21; // i8 _ptK
const F_PTV: usize = 22; // i32 _ptV
const F_LZLV: usize = 23; // i8 _lzLv
const F_LZUC: usize = 24; // u8 _lzUc (b)
const F_SPT: usize = 25; // f64 _spt
const F_QEN: usize = 26; // u8 queueEnabled (b)
const F_QN: usize = 27; // i8 _qN
const F_ARES: usize = 28; // u8 autoResearchEnabled (b)
const F_COUNT: usize = 29;

// Flags (P[13]).
const FL_IGNORE: i32 = 1; // placement rules off (starter buildings, a snapshot)
const FL_AUTO: i32 = 2; // auto upgrade
const FL_BUILD: i32 = 4; // build enabled
const FL_CONTEST: i32 = 8; // the contested-area check (not a started multiplayer match)
const FL_CLOUD: i32 = 16; // one of a cloud type a player
const FL_LASER: i32 = 32;
const FL_TOWER: i32 = 64;
const FL_SPAWN: i32 = 128; // barracks and spawners: the spawn timer and queue
const FL_RESEARCH: i32 = 256;

#[inline(always)]
unsafe fn col<T>(fp: *const i32, f: usize) -> *mut T {
    let v = g(fp, f);
    if v == 0 { core::ptr::null_mut() } else { waddr(v as u32) as *mut T }
}
#[inline(always)]
unsafe fn put<T>(fp: *const i32, f: usize, r: usize, v: T) {
    let p = col::<T>(fp, f);
    if !p.is_null() { s(p, r, v); }
}
// A boolean column ('b'): 0 unset, 1 false, 2 true.
#[inline(always)]
fn bv(v: bool) -> u8 { if v { 2 } else { 1 } }

/// k_struct_place. Arrays: the structure table st.* [0] code, [1] own, [2] uc, [3] val, [4] tim, [5] brain, [6] rtab,
/// [7] stab, [8] rrow, [9] ctab, [10] rcnt, [11] cnt; cells [12] type, [13] owner, [14] area; [15] the player's cover
/// by area (null: visibility P[32]); [16] / [17] each area's tiles (start per area + 1, tiles: null without the
/// contested check); adjacency [18] flags, [19] per-256 counts; [20] the work versions; [21] the journal (ring);
/// [22] / [23] the collectors' groups' journal flags and list (null: made whole next); [24] the cloud towers' tiles
/// (P[28] of them); [25] the tower due table; out [26] header; the class table: [27] its row pool header (rows, free
/// rows, rows with defaults, capacity), [28] its free rows, [29] its columns (F_COUNT encoded addresses), [30] mTok,
/// [31] the type column's pool ids (width P[30]), [32] the unit type's (barracks; width P[31]).
/// P: [0] gx, [1] gy, [2] width, [3] height, [4] player, [5] class code (ctab), [6] rally index, [7] status index,
/// [8] hash code (_stCode), [9] stationary type, [10] its type's pool id, [11] the unit type's, [12] stacks ordered,
/// [13] flags (FL_*), [14] game time, [15] the structure limit, [16] the player's structures, [17] hash region tiles,
/// [18] regions a row, [19] adjacency flags' length, [20] work players, [21] work types, [22] work regions a row,
/// [23] rows, [24] work region tiles, [25] journal end, [26] journal length, [27] the labs' class code, [28] cloud
/// tiles, [29] TYPE_WALL, [30] / [31] pool id widths (bytes), [32] visibility when no cover (0 / 1), [33] the groups'
/// journal length, [34] the due table's length.
/// Header: [0] 0 refused, 1 placed, 2 the same structure stands there (its stacks: the caller's), [1] its row,
/// [2] adjacency flags set, [3] their digest's change, [4] the lowest set (-1 none), [5] the work checksum's change,
/// [6] journal end, [7] the groups' journal length, [8] the owner counted (-1 none), [9] a cell item (0x33 / 0x44 /
/// 0x55), [10] a lab.
#[no_mangle]
pub unsafe extern "C" fn k_struct_place(a: u32, _chunk: i32) {
    let k = K::new(waddr(a) as *const i32);
    let (code, own, uc, val, tim, brain) = (k.p::<u8>(0), k.p::<i32>(1), k.p::<u8>(2), k.p::<f64>(3), k.p::<f64>(4), k.p::<i32>(5));
    let (rtab, stab, rrow, ctab, rcnt, cnt) = (k.p::<u8>(6), k.p::<u8>(7), k.p::<i32>(8), k.p::<u8>(9), k.p::<u8>(10), k.p::<u8>(11));
    let (ctype, cown, carea, cover) = (k.p::<u8>(12), k.p::<i8>(13), k.p::<i32>(14), k.p::<i32>(15));
    let (ast, atl) = (k.p::<i32>(16), k.p::<i32>(17));
    let (aflag, ablk, wver, tel) = (k.p::<u8>(18), k.p::<i32>(19), k.p::<i32>(20), k.p::<u32>(21));
    let (jflag, jlist, clouds, due, hdr) = (k.p::<u8>(22), k.p::<i32>(23), k.p::<i32>(24), k.p::<i32>(25), k.p::<i32>(26));
    let (rh, free, fp, mtok, tyc, utc) = (k.p::<i32>(27), k.p::<i32>(28), k.p::<i32>(29) as *const i32, k.p::<i32>(30), k.p::<u8>(31), k.p::<u8>(32));
    let (gx, gy, w, h, player) = (k.i(0), k.i(1), k.i(2), k.i(3), k.i(4));
    let (ct, ri, si, scode, ty, typ, utyp) = (k.i(5), k.i(6), k.i(7), k.i(8), k.i(9), k.i(10), k.i(11));
    let (stacks, fl, now, limit, count) = (k.i(12).max(1), k.i(13), k.f(14), k.i(15), k.i(16));
    for i in 0..11 { s(hdr, i, 0); }
    s(hdr, 1, -1); s(hdr, 4, -1); s(hdr, 6, k.i(25)); s(hdr, 7, k.i(33)); s(hdr, 8, -1);
    if gx < 0 || gy < 0 || gx >= w || gy >= h || ct <= 0 {
        return;
    }
    let t = gy * w + gx;
    let tu = t as usize;
    let ignore = fl & FL_IGNORE != 0;
    let occupied = g(ctab, tu) != 0;
    // The building limit: a new structure on an empty tile only.
    if !ignore && player >= 0 && !occupied && count >= limit {
        return;
    }
    // One cloud tower of a type a player (pathfinding.js cloudTowerOwned: live, at its tile, energy left).
    if fl & FL_CLOUD != 0 && !clouds.is_null() {
        for i in 0..k.i(28).max(0) as usize {
            let c = g(clouds, i);
            if c < 0 || c >= w * h { continue; }
            let cu = c as usize;
            if g(code, cu) == 0x22 && g(own, cu) == player && (g(brain, cu) & 0xffff) == ty + 1 && g(val, cu) > 0.0 {
                return;
            }
        }
    }
    // The same structure (type and owner; a floor item's owner is its cell's) standing there.
    let same = occupied && g(ctab, tu) as i32 == ct && (g(brain, tu) & 0xffff) == ty + 1
        && if scode == 0x55 { g(cown, tu) as i32 == player } else { g(own, tu) == player };
    if !ignore {
        // things_utils.js canStackAt / canBuildAt: in sight, its area not held by another player (solo), and the
        // same structure there, or a free tile that is no wall.
        let area = g(carea, tu);
        let visible = if cover.is_null() { k.i(32) != 0 } else { area >= 0 && g(cover, area as usize) > 0 };
        if !visible { return; }
        if fl & FL_CONTEST != 0 && !ast.is_null() && area >= 0 {
            let (a0, a1) = (g(ast, area as usize), g(ast, area as usize + 1));
            for j in a0..a1 {
                let q = g(atl, j as usize);
                if q < 0 || q >= w * h { continue; }
                let qu = q as usize;
                if g(ctab, qu) == 0 { continue; }
                let o = g(own, qu);
                if o >= 0 && o != ST_OWNER_NONE && o != player { return; }
            }
        }
        if !same && (occupied || g(ctype, tu) as i32 == k.i(29)) { return; }
    }
    if same {
        s(hdr, 0, 2);
        s(hdr, 1, g(rrow, tu));
        return;
    }
    // (Another structure there with the rules off: refused; the old placement replaced it without removing it.)
    if occupied {
        return;
    }
    // Its row: a freed one first, else the next (the caller made room and gave the next rows their defaults).
    let (n, nfree, lz, cap) = (g(rh, 0), g(rh, 1), g(rh, 2), g(rh, 3));
    // (A freed row has its defaults back (_sRowFree); a fresh one needs them (below lz).)
    let r = if nfree > 0 { g(free, (nfree - 1) as usize) } else { n };
    if r < 0 || r >= cap || (nfree == 0 && r >= lz) {
        return;
    }
    if nfree > 0 { s(rh, 1, nfree - 1); } else { s(rh, 0, n + 1); }
    let ru = r as usize;
    // The row as the constructors and placeBuilding wrote it.
    put::<i32>(fp, F_STT, ru, t);
    put::<i8>(fp, F_OW, ru, player as i8);
    put::<u8>(fp, F_UC, ru, 2);
    put::<f64>(fp, F_EN, ru, 1.0);
    put::<i16>(fp, F_GX, ru, gx as i16);
    put::<i16>(fp, F_GY, ru, gy as i16);
    put::<i32>(fp, F_STACKS, ru, 1);
    put::<i32>(fp, F_MANUAL, ru, stacks);
    put::<i32>(fp, F_EFFST, ru, 1);
    put::<i8>(fp, F_LEVEL, ru, 0);
    put::<i8>(fp, F_EFFLV, ru, 0);
    put::<i8>(fp, F_POTLV, ru, 0);
    put::<u8>(fp, F_ISSTACK, ru, bv(false));
    put::<f64>(fp, F_STWORK, ru, 0.0);
    put::<u8>(fp, F_SALV, ru, bv(false));
    put::<u8>(fp, F_AUTO, ru, bv(fl & FL_AUTO != 0));
    put::<u8>(fp, F_BUILD, ru, bv(fl & FL_BUILD != 0));
    if fl & FL_TOWER != 0 {
        // (Tower: its cooldown from now (cd = 0), its angle, laser state, no preferred target; a laser's beam inputs
        // as its constructor's check saw it (level 1, not under construction yet).)
        put::<f64>(fp, F_CD, ru, now);
        put::<f32>(fp, F_ANGLE, ru, 0.0);
        put::<i8>(fp, F_LZST, ru, 0);
        put::<f64>(fp, F_LZTIM, ru, 0.0);
        put::<i8>(fp, F_PTK, ru, 0);
        put::<i32>(fp, F_PTV, ru, -1);
        if fl & FL_LASER != 0 {
            put::<i8>(fp, F_LZLV, ru, 1);
            put::<u8>(fp, F_LZUC, ru, bv(false));
        }
    }
    if fl & FL_SPAWN != 0 {
        put::<f64>(fp, F_SPT, ru, 0.0);
        put::<u8>(fp, F_QEN, ru, bv(true));
        put::<i8>(fp, F_QN, ru, 0);
    }
    if fl & FL_RESEARCH != 0 {
        put::<u8>(fp, F_ARES, ru, bv(true));
    }
    // (Its pool ids: type, a barrack's unit type.)
    let pool = |p: *mut u8, width: i32, id: i32| {
        if p.is_null() || id < 0 { return; }
        match width { 1 => s(p, ru, id as u8), 2 => s(p as *mut u16, ru, id as u16), _ => s(p as *mut u32, ru, id as u32) }
    };
    pool(tyc, k.i(30), typ);
    pool(utc, k.i(31), utyp);
    if !mtok.is_null() { s(mtok, ru * 3, 0); s(mtok, ru * 3 + 1, 0); s(mtok, ru * 3 + 2, 0); }
    if !due.is_null() && fl & FL_TOWER != 0 && r < k.i(34) { s(due, ru, 0); }
    // Its tile's entry (data_state.js structTableSet / _stWrite on an empty tile).
    s(rrow, tu, r); s(rtab, tu, ri as u8); s(stab, tu, si as u8); s(ctab, tu, ct as u8);
    s(code, tu, scode as u8);
    let (rt, rw) = (k.i(17).max(1), k.i(18));
    let reg = (idiv(gy, rt) * rw + idiv(gx, rt)) as usize;
    s(rcnt, reg, g(rcnt, reg).wrapping_add(1));
    s(own, tu, player);
    if player >= 0 && player < 64 && scode < 0x66 {
        s(cnt, tu, (player + 1) as u8);
        s(hdr, 8, player);
        if matches!(scode, 0x33 | 0x44 | 0x55) { s(hdr, 9, 1); }
        if k.i(27) > 0 && ct == k.i(27) { s(hdr, 10, 1); }
    } else {
        s(cnt, tu, 0);
    }
    s(uc, tu, 1);
    s(val, tu, 1.0);
    s(tim, tu, if fl & FL_TOWER != 0 { now } else { 0.0 });
    // (Its brain word: type, base level 1, effective level 1; no preferred target, no custom values.)
    s(brain, tu, (ty + 1) | (1 << 16) | (1 << 26));
    // Its cell.
    s(cown, tu, player as i8);
    // The collectors' groups' journal (data_state.js _wsjMark).
    if !jflag.is_null() && !jlist.is_null() && g(jflag, tu) == 0 {
        s(jflag, tu, 1);
        let jn = k.i(33);
        s(jlist, jn as usize, t);
        s(hdr, 7, jn + 1);
    }
    // The tile entity journal.
    if !tel.is_null() {
        let mask = (k.i(26).max(1) as u32) - 1;
        let tend = k.i(25) as u32;
        s(tel, (tend & mask) as usize, t as u32);
        s(hdr, 6, tend.wrapping_add(1) as i32);
    }
    // Workers of the owner (none: every player) near it look again (worker.js workerWorkChanged).
    if !wver.is_null() {
        let (wnp, wnt, wrw, wrh, wrt) = (k.i(20), k.i(21), k.i(22), k.i(23), k.i(24).max(1));
        let reg = 1 + idiv(gy, wrt).min(wrh - 1) * wrw + idiv(gx, wrt).min(wrw - 1);
        let (p0, p1) = if player < 0 { (0, wnp) } else { (player, player + 1) };
        let mut wsum = 0i32;
        let mut p = p0;
        while p < p1 && p < wnp {
            let wi = (p * wnt) * (1 + wrw * wrh) + reg;
            s(wver, wi as usize, g(wver, wi as usize).wrapping_add(1));
            wsum = wsum.wrapping_add(((wi + 1) ^ 0x9e3779b9u32 as i32).wrapping_mul(2654435761u32 as i32));
            p += 1;
        }
        s(hdr, 5, wsum);
    }
    // Adjacency: the tile and its neighbours worked out again (data_state.js _markAdjacencyDirtyAt, pad 1).
    if !aflag.is_null() {
        let alen = k.i(19).max(0);
        let (mut na, mut asum, mut amin) = (0i32, 0i32, -1i32);
        for y in (gy - 1).max(0)..=(gy + 1).min(h - 1) {
            for x in (gx - 1).max(0)..=(gx + 1).min(w - 1) {
                let q = y * w + x;
                if q >= alen || g(aflag, q as usize) != 0 { continue; }
                s(aflag, q as usize, 1);
                s(ablk, (q >> 8) as usize, g(ablk, (q >> 8) as usize) + 1);
                na += 1;
                asum = asum.wrapping_add((q + 1).wrapping_mul(2654435761u32 as i32));
                if amin < 0 || q < amin { amin = q; }
            }
        }
        s(hdr, 2, na); s(hdr, 3, asum); s(hdr, 4, amin);
    }
    s(hdr, 0, 1);
    s(hdr, 1, r);
}
