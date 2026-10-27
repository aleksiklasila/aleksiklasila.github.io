//! The movement kernels' twins (src/sim/sim_parallel.js): SIM_KERNEL_MOVE_STEP
//! (_simStepParked, _simStepFlow), SIM_KERNEL_MOVE (_simMovePre,
//! _simMoveFlow, _simMovePath, _simMoveEpilogue) and SIM_KERNEL_DRIVEBY,
//! with their helpers (simFlowLook, simNavStepXY, _simInAreaRange...). Bit
//! for bit what the JavaScript writes, so chunks may run in either.
//!
//! Their many arrays come in the thread's argument block (sim_wasm.js): its
//! 32-bit words are addresses (W_* below, in the order of sim_parallel.js
//! _SIM_MOVE_WNAMES; 0 for an unbound optional one), the kernel's params P
//! follow as doubles at +4096 (F[0..64]). A unit's passes run one after
//! another (the JavaScript runs each pass over the chunk in turn: a unit's
//! sections read nothing another unit's write, so the order between units
//! does not show).
use super::*;

// A common four-lane row broadcasts from one cache line; mixed levels gather.
#[inline(always)]
unsafe fn mv_stat(m: &Mv, s: usize, k: usize, fallback: *const F32) -> f64 {
    if !m.shared_hot.is_null() { return *m.shared_hot.add(k) as f64; }
    if !m.hot.is_null() && !m.statrow.is_null() {
        let r = *m.statrow.add(s);
        if r >= 0 { return *m.hot.add(r as usize * 16 + k) as f64; }
    }
    if fallback.is_null() { 0.0 } else { rd(fallback, s) }
}
#[inline(always)]
unsafe fn mv_stat4(m: &Mv, s: usize, k: usize, fallback: *const F32) -> v128 {
    if !m.shared_hot.is_null() { return f32x4_splat(*m.shared_hot.add(k)); }
    if m.hot.is_null() || m.statrow.is_null() { return if fallback.is_null() {f32x4_splat(0.0)} else {v128_load(fallback.add(s) as *const v128)}; }
    // Idle groups still need speed in contact response. Load their row IDs
    // together too, rather than doing four scalar pointer chains.
    let rows=i32x4_load_extend_i16x4(m.statrow.add(s));
    let r=i32x4_extract_lane::<0>(rows);
    if r>=0 && i32x4_bitmask(i32x4_eq(rows,i32x4_splat(r)))==15 {return f32x4_splat(*m.hot.add(r as usize*16+k));}
    let at=|r:i32| if r>=0 {*m.hot.add(r as usize*16+k)} else {0.0};
    f32x4(at(r),at(i32x4_extract_lane::<1>(rows)),at(i32x4_extract_lane::<2>(rows)),at(i32x4_extract_lane::<3>(rows)))
}


// ---- argument words (sim_parallel.js _SIM_MOVE_WNAMES) ----
/// The combat brain (unit.js SIM_COMBAT_BRAIN, always on: its instructions (cmMode) steer the units, the look-by-area of the old
/// mode is gone from the game). The branches of the other mode are removed from this file.
const BRAIN: bool = true;
const W_ON: usize = 0;
const W_OUT: usize = 1;
const W_FL: usize = 2;
const W_ID: usize = 3;
const W_PATH: usize = 4;
const W_EN: usize = 5;
const W_SEP: usize = 6;
const W_DEAD: usize = 7;
const W_OWN: usize = 8;
const W_X: usize = 9;
const W_Y: usize = 10;
const W_PX: usize = 11;
const W_PY: usize = 12;
const W_FLOOR: usize = 13;
const W_SC: usize = 14;
const W_D0: usize = 15;
const W_WAKE: usize = 16;
const W_WKWX: usize = 17;
const W_WKWY: usize = 18;
const W_DEST: usize = 19;
const W_CD: usize = 20;
const W_CT: usize = 21;
const W_CVX: usize = 22;
const W_CVY: usize = 23;
const W_CTL: usize = 24;
const W_CN: usize = 25;
const W_VX: usize = 26;
const W_VY: usize = 27;
const W_SPENT: usize = 28;
const W_WALL: usize = 29;
const W_AREA: usize = 30;
const W_REACH: usize = 31;
const W_AB: usize = 32;
const W_ABOK: usize = 33;
const W_HS: usize = 34;
const W_AT: usize = 35;
const W_WK: usize = 39;
const W_WTC: usize = 40;
const W_FLOW: usize = 41;
const W_FGEN: usize = 42;
const W_RDY: usize = 43;
const W_FMN: usize = 44;
const W_FMW: usize = 45;
const W_NPR: usize = 46;
const W_SPD: usize = 47;
const W_HT: usize = 48;
const W_HTID: usize = 49;
const W_X0: usize = 50;
const W_Y0: usize = 51;
const W_CRC: usize = 52;
const W_RRC: usize = 53;
const W_AOFF: usize = 54;
const W_ANB: usize = 55;
const W_COVF: usize = 56;
const W_AG: usize = 57;
const W_FRZ: usize = 58;
const W_SND: usize = 59;
const W_CBT: usize = 60;
const W_CBTK: usize = 61;
const W_CHS: usize = 62;
const W_RNG: usize = 63;
const W_WKV: usize = 64;
const W_WKTY: usize = 65;
const W_WKD: usize = 66;
const W_WKOX: usize = 67;
const W_WKOY: usize = 68;
const W_WKTW: usize = 69;
const W_WKF: usize = 70;
const W_WKU: usize = 71;
const W_WKSC: usize = 72;
const W_HWIN: usize = 73;
const W_HTT: usize = 74;
const W_HVER: usize = 75;
const W_CTI: usize = 76;
const W_CRS: usize = 77;
const W_CBS: usize = 78;
const W_LSX: usize = 79;
const W_LSY: usize = 80;
const W_LSPX: usize = 81;
const W_LSPY: usize = 82;
const W_LST: usize = 83;
const W_LANE: usize = 84;
const W_AIRW: usize = 85;
const W_FRN: usize = 86;
const W_FRW: usize = 87;
const W_FHD: usize = 88;
const W_FPN: usize = 89;
const W_FPW: usize = 90;
// (The flow look-ahead record, unit.mvNav: NV_STRIDE words a slot, see nv.)
const W_NV: usize = 91;
const W_STATROW: usize = 92;
const W_HOT: usize = 93;
const W_NLD: usize = 100;
const W_CWN: usize = 101;
const W_CWT: usize = 102;
const W_CWD: usize = 103;
const W_WBLK9: usize = 104;
const W_BASE: usize = 105;
const W_WLEN: usize = 106;
const W_PLEN: usize = 107;
const W_SCAN: usize = 108;
const W_NODES: usize = 109;
const W_PIDX: usize = 110;
const W_POST: usize = 111;
const W_POSTC: usize = 112;
const W_SPE: usize = 113;
const W_SPO: usize = 114;
const W_SPT: usize = 115;
const W_SPTY: usize = 116;
const W_VSG: usize = 117;
const W_MVO: usize = 118;
const W_MVN: usize = 119;
const W_MVW: usize = 120;
const W_BLK: usize = 121;
const W_REM: usize = 122;
const W_FIX: usize = 123;
const W_USE: usize = 124;
const W_COST: usize = 125;
const W_CMD: usize = 126;
const W_SHOOT: usize = 127;
const W_RD: usize = 128;
const W_RK: usize = 129;
const W_LZF: usize = 130;
const W_RS: usize = 131;
const W_RC: usize = 132;
const W_RST: usize = 133;
const W_ES: usize = 134;
const W_OM: usize = 135;
const W_SCLS: usize = 136;
const W_HSS: usize = 137;
const W_FIRE: usize = 139;
/// unit.js SIM_IDLE_PARK_TICKS.
const IDLE_PARK_TICKS: i32 = 1000;
const W_ACD: usize = 140;
const W_FLASH: usize = 141;
const W_HITA: usize = 142;
const W_HITT: usize = 143;
const W_HITC: usize = 144;
const W_TMON: usize = 145;
const W_CMODE: usize = 146;
const W_CMT: usize = 147;
const W_CTID: usize = 148;
const W_SLAYER: usize = 149;
const W_TGX: usize = 150;
const W_TGY: usize = 151;
const W_TGTOL: usize = 152;
const W_STEADY: usize = 153;
const W_WKLMT: usize = 154;
// (The separation's, for the epilogue's fused finish: sim_parallel.js
// _SIM_MOVE_WNAMES then _SIM_MOVE_WNAMES2 from word 268.)
const W_SPX: usize = 155;
const W_SPY: usize = 156;
const W_SOV: usize = 157;
const W_SHIT: usize = 158;
const W_SCX: usize = 159;
const W_SCY: usize = 268;
const W_SMV: usize = 269;
const W_SNX: usize = 270;
const W_SNY: usize = 271;
const W_SFAST: usize = 272;
const W_SEX: usize = 273;
const W_SEXC: usize = 274;
const W_PF: usize = 275;
const W_LOOKC: usize = 276;
// (Floor traps applied in the kernel: the status columns, the unit types'
// resistances, the trap table by tile; see floor_hit.)
const W_BURN: usize = 277;
const W_BURND: usize = 278;
const W_POI: usize = 279;
const W_POID: usize = 280;
const W_FRZW: usize = 281;
const W_ICED: usize = 282;
const W_WET: usize = 283;
const W_SNDW: usize = 284;
// (Each slot's status record, unit.stIx: the status columns above and
// unit.stFr / unit.stSa (W_FRZ, W_SND) are by record, sim_unit_state.js
// SIM_UNIT_ST_SIDE; the pool's words and free stack at W_STHDR, W_STFREE.)
const W_STON: usize = 285;
const W_STHDR: usize = 94;
const W_STFREE: usize = 95;
// (The attackers' styles and each chunk's count of listed attacks with a
// status style: hit_sty_count.)
const W_ASTY: usize = 96;
const W_HSC: usize = 97;
const W_UPT: usize = 286;
const W_TRK: usize = 287;
const W_TRL: usize = 288;
const W_TRT: usize = 289;
const W_TRTG: usize = 291;
// (Each slot's worker record: unit.wkIx; the wk* arrays are by record.)
const W_WKIX: usize = 292;
// (The step's attack carry and shots: unit.atkL, unit.atkN; see fire.)
const W_ATL: usize = 293;
const W_ATN: usize = 294;
// (A route's profile and an attack-mover's aggro reach: what a structure instruction gives back, resume_order.)
const W_NVP: usize = 295;
const W_RDA: usize = 296;
// (Words 463..: the unit controller's columns, sim_parallel.js _simMoveWasm.)
const W_CTLX: usize = 463;
/// Per navigation profile p: its routing atlas's header (nav.<p>.atl,
/// atlas.rs Atl) at word W_ATLAS + p; 0 none.
const W_ATLAS: usize = 430;
// (Words 448..: the flow-relative contact response's (push4; 300..427 are
// mv_move's step scratch, 430.. the atlas headers): unit.sepIv, unit.sepCv,
// sep.cx, sep.cy, sep.fx, sep.fy.)
const W_SIV: usize = 448;
const W_SCV: usize = 449;
const W_SCCX: usize = 450;
const W_SCCY: usize = 451;
const W_SFX: usize = 452;
const W_SFY: usize = 453;
/// The field id of a route on the atlas (flownav.js NAV_ATLAS_FID): no
/// destination field, every destination by lookups (atlas.rs).
pub const NAV_ATLAS_FID: i32 = 1 << 30;
const W_TRES: usize = 290;
/// Per navigation profile p: 8 words from W_NAV + 8p (fields, partL, partB,
/// nb, nt, np, meta, walls).
const W_NAV: usize = 160;
pub const NAV_PROFILES: usize = 11;
/// partL's length per profile (11 words).
const W_PARTLN: usize = 250;
/// Lengths and counts: area.off's, wk.ver's, nav.fmeta.0's, nav.fmeta.1's,
/// the cover's players and areas per player (its stride).
const W_OFFN: usize = 262;
const W_WKVN: usize = 263;
const W_FMNN: usize = 264;
const W_FMWN: usize = 265;
const W_COVP: usize = 266;
const W_COVS: usize = 267;

const SIM_FLOW_REFRESH_TICKS: i32 = 4;
const SIM_STEER_TICKS: u8 = 16;
const SIM_STEER_NEAR_TICKS: u8 = 4;
/// A full crowd's units in 3x3 tiles (unit.js NAV_CROWD_FULL).
const SIM_CROWD_FULL: u16 = 18;
/// sim_parallel.js SIM_REROUTE_TICKS.
const SIM_REROUTE_TICKS: i32 = 32;

#[derive(Clone, Copy)]
struct NavP {
    fields: *const u16,
    partl: *const u16,
    partb: *const i32,
    nb: *const i32,
    nt: *const i32,
    np: *const i32,
    meta: *const i32,
    walls: *const u8,
    partln: usize,
}

struct Mv {
    area_only: bool,
    nav_step_cache: *mut AtlasStepEntry,
    occ: *const super::occ::MoveGrid,
    traffic: *const i32,
    traffic_mode: i32,
    /// unit.rtEnd (word 458): a route's end tile, kept after arrival.
    rte: *const i32,
    /// Whether the first stage marks the units the occupancy's second stage visits (word 459 not 0: mark_need writes the mark into
    /// the footprint record's byte 3, else every slot is visited) and the footprint records (word 460: occ.rec, four words a slot:
    /// x, y, radius | layer << 8 | active << 16 | need << 24).
    need: *mut i32,
    orec: *mut i32,
    /// This occupancy job's swapped idle units (traffic_swap), to list in
    /// its second pass; null outside one.
    swl: *mut i32,
    swn: *mut i32,
    // Occupancy jobs may end inside a four-lane group. Stores must touch
    // only these owned slots; masked full-width RMW would race a helper.
    span_n: usize,
    #[cfg(feature="prof")]
    skip_hold_stores: bool,
    #[cfg(feature="prof")]
    bulk_hold_targets: bool,
    #[cfg(feature="prof")]
    pair_holds: bool,
    /// The step's base ticks (simDk, P[58]; at least 1) and as a double.
    dk: i32,
    dkf: f64,
    /// The profiles' atlas headers (null: none).
    atlh: [*const i32; NAV_PROFILES],
    atl: *mut u8,
    atn: *mut u8,
    /// unit.nvProf (the profile of its route) and unit.mvReachA.
    nvp: *const I8I32,
    rda: *const u8,
    /// The unit controller's columns (words 463..): holding position, worker, route key, attack-move tile x / y (i16, -1 none), target
    /// unit slot and id, forced, target structure's tile, path key (unit.nvPK), the scout's type index (one word), acquisition flag,
    /// the event left to the main thread (unit.mvEv, EV_*).
    holdf: *const u8,
    iswk: *const u8,
    rkf: *mut u8,
    amgx: *mut i16,
    amgy: *mut i16,
    tus: *mut i32,
    tuid: *mut i32,
    fatf: *mut u8,
    tbt: *mut i32,
    nvpk: *mut i32,
    scoutt: *const i32,
    acqb: *mut u8,
    ev: *mut u8,
    on: *mut u8,
    out: *mut u8,
    fl: *mut u8,
    id: *const i32,
    path: *const i32,
    stept: *mut u8,
    stepbase: usize,
    en: *const F32,
    sep: *mut u32,
    dead: *const u8,
    own: *const I8I32,
    x: *mut Q8,
    y: *mut Q8,
    px: *mut Q8,
    py: *mut Q8,
    floor: *mut i32,
    sc: *const i8,
    d0: *mut u8,
    wake: *mut i32,
    wkwx: *mut F32,
    wkwy: *mut F32,
    dest: *const i32,
    cd: *mut i32,
    ct: *mut i32,
    cvx: *mut F32,
    cvy: *mut F32,
    ctl: *mut i32,
    cn: *mut u8,
    vx: *mut F32,
    vy: *mut F32,
    spent: *mut u8,
    wall: *const u8,
    area: *mut i32,
    reach: *const u8,
    ab: *const i32,
    abok: *const u8,
    hs: *const i32,
    at: *const F32,
    wk: *const u8,
    wtc: *const U16I32,
    flow: *const i32,
    fgen: *mut i32,
    rdy: *const i32,
    fmn: *const i32,
    fmw: *const i32,
    npr: *const u8,
    spd: *const F32,
    ht: *const i32,
    htid: *const i32,
    x0: *const Q8,
    y0: *const Q8,
    crc: *const F32,
    rrc: *const F32,
    aoff: *const i32,
    anb: *const i32,
    covf: *const u8,
    ag: *const i32,
    frz: *const U16I32,
    snd: *const U16I32,
    cbt: *const i32,
    cbtk: *const i32,
    chs: *const F32,
    rng: *const F32,
    wkv: *const i32,
    wkty: *const i32,
    wkix: *const i32,
    wkd: *const i32,
    wkox: *const i32,
    wkoy: *const i32,
    wktw: *const u8,
    wkf: *const i32,
    wku: *const I32Number,
    wksc: *const I32Number,
    hwin: *mut i32,
    htt: *mut i32,
    hver: *mut i32,
    cti: *const i32,
    crs: *const F32,
    cbs: *const i32,
    lsx: *mut F32,
    lsy: *mut F32,
    lspx: *mut F32,
    lspy: *mut F32,
    lst: *mut i32,
    lane: *const F32,
    airw: *const u8,
    frn: *const u8,
    frw: *const u8,
    fhd: *const i32,
    fpn: *const u16,
    fpw: *const u16,
    nv: *mut i32,
    statrow: *const i16,
    hot: *const f32,
    shared_hot: *const f32,
    nld: *mut F32,
    cwn: *const u8,
    cwt: *const i32,
    cwd: *const u16,
    wblk9: *const i32,
    base: *const i32,
    wlen: *const u8,
    plen: *const i32,
    scan: *mut i32,
    nodes: *const i32,
    pidx: *mut I32Number,
    post: *mut i32,
    postc: *mut i32,
    spe: *const i32,
    spo: *const I8I32,
    spt: *mut i32,
    spty: *const i16,
    vsg: *const i32,
    mvo: *mut i32,
    mvn: *mut i32,
    mvw: *mut i8,
    blk: *mut u8,
    rem: *const f64,
    fix: *mut f64,
    use_: *mut f64,
    cost: *const F32,
    cmd: *const U8I32,
    shoot: *const u8,
    rd_: *const u8,
    rk: *const u8,
    lzf: *const u8,
    rs: *const i32,
    rc: *const i32,
    rst: *const i32,
    es: *const i32,
    om: *const u8,
    scls: *const i8,
    hss: *const i32,
    fire: *mut u8,
    acd: *const F32,
    flash: *mut U8I32,
    hita: *mut i32,
    hitt: *mut i32,
    hitc: *mut i32,
    asty: *const u8,
    hsc: *mut i32,
    tmon: *mut u8,
    cmode: *mut u8,
    cmt: *const i32,
    ctid: *const i32,
    slayer: *const u8,
    tgx: *const F32,
    tgy: *const F32,
    tgtol: *const F32,
    steady: *mut i32,
    wklmt: *mut i32,
    spx: *mut i32,
    spy: *mut i32,
    sov: *mut F32,
    shit: *mut u32,
    // (unit.sepCx: the carried separation velocity, x and y as i16 halves (iv_pack); scy unused.)
    scx: *mut i32,
    scy: *mut F32,
    siv: *mut i32,
    scv: *mut i32,
    sccx: *mut i32,
    sccy: *mut i32,
    sfx: *mut i32,
    sfy: *mut i32,
    smv: *mut u8,
    snx: *mut F32,
    sny: *mut F32,
    sfast: *mut u8,
    sex: *mut i32,
    sexc: *mut i32,
    pf: *const u8,
    lookc: *mut u32,
    burn: *mut U16I32,
    burnd: *mut F32,
    poi: *mut U16I32,
    poid: *mut F32,
    frzw: *mut U16I32,
    iced: *mut F32,
    wet: *mut U16I32,
    sndw: *mut U16I32,
    stix: *mut i32,
    sthdr: *mut i32,
    stfree: *mut i32,
    upt: *const i16,
    trk: *const u8,
    trl: *const u8,
    trt: *const i32,
    trtg: *const F32,
    trlv: i32,
    trpl: i32,
    tres: *const u8,
    tresn: i32,
    nav: [NavP; NAV_PROFILES],
    offn: usize,
    wkvn: usize,
    fmnn: usize,
    fmwn: usize,
    covp: i32,
    covs: i32,
    // (Params.)
    t: i32,
    w: i32,
    h: i32,
    tile: f64,
    itile: f64,
    /// (Positions in eighths: a tile is tile * 8 of them; tsh its log2 when
    /// that is a power of two, else -1 and itq its inverse.)
    tsh: i32,
    itq: f32,
    #[allow(dead_code)]
    argp: usize,
}

/// (A counting build, --features dbgc: counter i of the thread's argument
/// block, words 1536.. .)
macro_rules! dbgc {
    ($m:expr, $i:expr) => {
        #[cfg(feature = "dbgc")]
        {
            let p = ($m.argp as *mut u32).add(1536 + $i);
            *p = (*p).wrapping_add(1);
        }
    };
    ($m:expr, $i:expr, $n:expr) => {
        #[cfg(feature = "dbgc")]
        {
            let p = ($m.argp as *mut u32).add(1536 + $i);
            *p = (*p).wrapping_add($n as u32);
        }
    };
}
/// Tiles of four positions in eighths (floor).
#[inline(always)]
unsafe fn tile4(m: &Mv, v: v128) -> v128 {
    if m.tsh >= 0 {
        i32x4_shr(v, m.tsh as u32)
    } else {
        i32x4_trunc_sat_f32x4(f32x4_floor(f32x4_mul(f32x4_convert_i32x4(v), f32x4_splat(m.itq))))
    }
}
/// Four pixel offsets (f32) as whole eighths, halves up (NaN: 0).
#[inline(always)]
fn q8x4(v: v128) -> v128 {
    i32x4_trunc_sat_f32x4(f32x4_floor(f32x4_add(f32x4_mul(v, f32x4_splat(8.0)), f32x4_splat(0.5))))
}
/// Eighths as pixels (f32).
#[inline(always)]
fn px4(v: v128) -> v128 {
    f32x4_mul(f32x4_convert_i32x4(v), f32x4_splat(0.125))
}

#[inline(always)]
unsafe fn word(a: *const i32, i: usize) -> usize {
    waddr(rd(a, i) as u32)
}

impl Mv {
    #[inline(never)]
    unsafe fn load(a: *const i32) -> Mv {
        macro_rules! p {
            ($i:expr) => {
                word(a, $i) as *mut _
            };
        }
        let f = (a as usize + 4096) as *const f64;
        let nul = NavP {
            fields: 0 as *const u16,
            partl: 0 as *const u16,
            partb: 0 as *const i32,
            nb: 0 as *const i32,
            nt: 0 as *const i32,
            np: 0 as *const i32,
            meta: 0 as *const i32,
            walls: 0 as *const u8,
            partln: 0,
        };
        let mut nav = [nul; NAV_PROFILES];
        for (p, n) in nav.iter_mut().enumerate() {
            let b = W_NAV + 8 * p;
            n.fields = p!(b);
            n.partl = p!(b + 1);
            n.partb = p!(b + 2);
            n.nb = p!(b + 3);
            n.nt = p!(b + 4);
            n.np = p!(b + 5);
            n.meta = p!(b + 6);
            n.walls = p!(b + 7);
            n.partln = word(a, W_PARTLN + p);
        }
        let tile = rd(f, 7);
        Mv {
            area_only: rd(f,47)==1.0,
            nav_step_cache: core::ptr::null_mut(),
            occ: core::ptr::null(),
            traffic: p!(456),
            traffic_mode: {let c:*const i32=p!(456);if c.is_null(){0}else{*c}},
            rte: p!(458),
            need: p!(459),
            orec: p!(460),
            swl: core::ptr::null_mut(),
            swn: core::ptr::null_mut(),
            span_n: 4,
            #[cfg(feature="prof")]
            skip_hold_stores: true,
            #[cfg(feature="prof")]
            bulk_hold_targets: true,
            #[cfg(feature="prof")]
            pair_holds: true,
            dk: { let k = to_i32(rd(f, 58)); if k > 1 { k.min(64) } else { 1 } },
            dkf: { let k = to_i32(rd(f, 58)); if k > 1 { k.min(64) as f64 } else { 1.0 } },
            atlh: {
                let mut h = [0 as *const i32; NAV_PROFILES];
                for (p, e) in h.iter_mut().enumerate() {
                    *e = word(a, W_ATLAS + p) as *const i32;
                }
                h
            },
            atl: p!(W_ATL),
            atn: p!(W_ATN),
            nvp: p!(W_NVP),
            rda: p!(W_RDA),
            holdf: p!(W_CTLX),
            iswk: p!(W_CTLX + 1),
            rkf: p!(W_CTLX + 2),
            amgx: p!(W_CTLX + 3),
            amgy: p!(W_CTLX + 4),
            tus: p!(W_CTLX + 5),
            tuid: p!(W_CTLX + 6),
            fatf: p!(W_CTLX + 7),
            tbt: p!(W_CTLX + 8),
            nvpk: p!(W_CTLX + 9),
            scoutt: p!(W_CTLX + 10),
            acqb: p!(W_CTLX + 11),
            ev: p!(W_CTLX + 12),
            on: p!(W_ON),
            out: p!(W_OUT),
            fl: p!(W_FL),
            id: p!(W_ID),
            path: p!(W_PATH),
            stept: a.add(300) as *mut u8,
            stepbase: rd(a, 299) as usize,
            en: p!(W_EN),
            sep: p!(W_SEP),
            dead: p!(W_DEAD),
            own: p!(W_OWN),
            x: p!(W_X),
            y: p!(W_Y),
            px: p!(W_PX),
            py: p!(W_PY),
            floor: p!(W_FLOOR),
            sc: p!(W_SC),
            d0: p!(W_D0),
            wake: p!(W_WAKE),
            wkwx: p!(W_WKWX),
            wkwy: p!(W_WKWY),
            dest: p!(W_DEST),
            cd: p!(W_CD),
            ct: p!(W_CT),
            cvx: p!(W_CVX),
            cvy: p!(W_CVY),
            ctl: p!(W_CTL),
            cn: p!(W_CN),
            vx: p!(W_VX),
            vy: p!(W_VY),
            spent: p!(W_SPENT),
            wall: p!(W_WALL),
            area: p!(W_AREA),
            reach: p!(W_REACH),
            ab: p!(W_AB),
            abok: p!(W_ABOK),
            hs: p!(W_HS),
            at: p!(W_AT),
            wk: p!(W_WK),
            wtc: p!(W_WTC),
            flow: p!(W_FLOW),
            fgen: p!(W_FGEN),
            rdy: p!(W_RDY),
            fmn: p!(W_FMN),
            fmw: p!(W_FMW),
            npr: p!(W_NPR),
            spd: p!(W_SPD),
            ht: p!(W_HT),
            htid: p!(W_HTID),
            x0: p!(W_X0),
            y0: p!(W_Y0),
            crc: p!(W_CRC),
            rrc: p!(W_RRC),
            aoff: p!(W_AOFF),
            anb: p!(W_ANB),
            covf: p!(W_COVF),
            ag: p!(W_AG),
            frz: p!(W_FRZ),
            snd: p!(W_SND),
            cbt: p!(W_CBT),
            cbtk: p!(W_CBTK),
            chs: p!(W_CHS),
            rng: p!(W_RNG),
            wkv: p!(W_WKV),
            wkty: p!(W_WKTY),
            wkix: p!(W_WKIX),
            wkd: p!(W_WKD),
            wkox: p!(W_WKOX),
            wkoy: p!(W_WKOY),
            wktw: p!(W_WKTW),
            wkf: p!(W_WKF),
            wku: p!(W_WKU),
            wksc: p!(W_WKSC),
            hwin: p!(W_HWIN),
            htt: p!(W_HTT),
            hver: p!(W_HVER),
            cti: p!(W_CTI),
            crs: p!(W_CRS),
            cbs: p!(W_CBS),
            lsx: p!(W_LSX),
            lsy: p!(W_LSY),
            lspx: p!(W_LSPX),
            lspy: p!(W_LSPY),
            lst: p!(W_LST),
            lane: p!(W_LANE),
            airw: p!(W_AIRW),
            frn: p!(W_FRN),
            frw: p!(W_FRW),
            fhd: p!(W_FHD),
            fpn: p!(W_FPN),
            fpw: p!(W_FPW),
            nv: p!(W_NV),
            statrow: p!(W_STATROW),
            hot: p!(W_HOT),
            shared_hot: core::ptr::null(),
            nld: p!(W_NLD),
            cwn: p!(W_CWN),
            cwt: p!(W_CWT),
            cwd: p!(W_CWD),
            wblk9: p!(W_WBLK9),
            base: p!(W_BASE),
            wlen: p!(W_WLEN),
            plen: p!(W_PLEN),
            scan: p!(W_SCAN),
            nodes: p!(W_NODES),
            pidx: p!(W_PIDX),
            post: p!(W_POST),
            postc: p!(W_POSTC),
            spe: p!(W_SPE),
            spo: p!(W_SPO),
            spt: p!(W_SPT),
            spty: p!(W_SPTY),
            vsg: p!(W_VSG),
            mvo: p!(W_MVO),
            mvn: p!(W_MVN),
            mvw: p!(W_MVW),
            blk: p!(W_BLK),
            rem: p!(W_REM),
            fix: p!(W_FIX),
            use_: p!(W_USE),
            cost: p!(W_COST),
            cmd: p!(W_CMD),
            shoot: p!(W_SHOOT),
            rd_: p!(W_RD),
            rk: p!(W_RK),
            lzf: p!(W_LZF),
            rs: p!(W_RS),
            rc: p!(W_RC),
            rst: p!(W_RST),
            es: p!(W_ES),
            om: p!(W_OM),
            scls: p!(W_SCLS),
            hss: p!(W_HSS),
            fire: p!(W_FIRE),
            acd: p!(W_ACD),
            flash: p!(W_FLASH),
            hita: p!(W_HITA),
            hitt: p!(W_HITT),
            hitc: p!(W_HITC),
            asty: p!(W_ASTY),
            hsc: p!(W_HSC),
            tmon: p!(W_TMON),
            cmode: p!(W_CMODE),
            cmt: p!(W_CMT),
            ctid: p!(W_CTID),
            slayer: p!(W_SLAYER),
            tgx: p!(W_TGX),
            tgy: p!(W_TGY),
            tgtol: p!(W_TGTOL),
            steady: p!(W_STEADY),
            wklmt: p!(W_WKLMT),
            spx: p!(W_SPX),
            spy: p!(W_SPY),
            sov: p!(W_SOV),
            shit: p!(W_SHIT),
            scx: p!(W_SCX),
            scy: p!(W_SCY),
            siv: p!(W_SIV),
            scv: p!(W_SCV),
            sccx: p!(W_SCCX),
            sccy: p!(W_SCCY),
            sfx: p!(W_SFX),
            sfy: p!(W_SFY),
            smv: p!(W_SMV),
            snx: p!(W_SNX),
            sny: p!(W_SNY),
            sfast: p!(W_SFAST),
            sex: p!(W_SEX),
            sexc: p!(W_SEXC),
            pf: p!(W_PF),
            lookc: p!(W_LOOKC),
            burn: p!(W_BURN),
            burnd: p!(W_BURND),
            poi: p!(W_POI),
            poid: p!(W_POID),
            frzw: p!(W_FRZW),
            iced: p!(W_ICED),
            wet: p!(W_WET),
            sndw: p!(W_SNDW),
            stix: p!(W_STON),
            sthdr: p!(W_STHDR),
            stfree: p!(W_STFREE),
            upt: p!(W_UPT),
            trk: p!(W_TRK),
            trl: p!(W_TRL),
            trt: p!(W_TRT),
            trtg: p!(W_TRTG),
            trlv: to_i32(rd(f, 56)),
            trpl: to_i32(rd(f, 57)),
            tres: p!(W_TRES),
            tresn: to_i32(rd(f, 55)),
            nav,
            offn: word(a, W_OFFN),
            wkvn: word(a, W_WKVN),
            fmnn: word(a, W_FMNN),
            fmwn: word(a, W_FMWN),
            covp: rd(a, W_COVP),
            covs: rd(a, W_COVS),
            t: to_i32(rd(f, 2)),
            w: to_i32(rd(f, 5)),
            h: to_i32(rd(f, 6)),
            tile,
            itile: 1.0 / tile,
            tsh: {
                let tq = to_i32(tile * 8.0);
                if tq > 0 && (tq & (tq - 1)) == 0 { tq.trailing_zeros() as i32 } else { -1 }
            },
            itq: (1.0 / (tile * 8.0)) as f32,
            argp: a as usize,
        }
    }
}

/// Whether a hostile structure on tile tl does anything to a unit standing
/// there: only traps do (mv.scls class 2; Unit.update's floor check). Without
/// the class grid, any.
#[inline(always)]
unsafe fn floor_acts(m: &Mv, tl: i32) -> bool {
    m.scls.is_null() || rd(m.scls, tl as usize) == 2
}

/// A unit (slot s) looking at its floor, tile tl holding a structure
/// hostile to it (Unit.update's floor items): true when Unit.update must
/// act (a mine, or what the kernel cannot tell: no trap table, a unit of no
/// known type); else a trap's status applied here, as applyStatusEffect
/// (timer and damage the largest of the old and the trap's: the trap's
/// kind and level by tile, its strength by owner, kind and level from the
/// owner's precomputed stats, unit.js _simTrapTable; none for a trap under
/// construction or a unit resisting it).
#[inline(never)]
unsafe fn floor_hit(m: &Mv, s: usize, tl: i32) -> bool {
    if !floor_acts(m, tl) {
        return false;
    }
    if m.trk.is_null() || m.trl.is_null() || m.trt.is_null() || m.trtg.is_null() || m.burn.is_null() || m.tres.is_null() || m.upt.is_null() || m.stix.is_null() || m.sthdr.is_null() || m.stfree.is_null() {
        return true;
    }
    let tu = tl as usize;
    let k = rd(m.trk, tu);
    if k == 0 {
        return false;
    }
    if k > 5 {
        return true;
    }
    let ut = rd(m.upt, s) as i32;
    if ut < 0 || ut >= m.tresn {
        return true;
    }
    // (Resistances by unit type: bit k - 1.)
    if (rd(m.tres, ut as usize) >> (k - 1)) & 1 != 0 {
        return false;
    }
    // (Its owner: the tile's structure code; mixed ownership: Unit.update.)
    let o = rd(m.sc, tu) as i32;
    let lv = rd(m.trl, tu) as i32;
    if o < 0 || o >= m.trpl || lv >= m.trlv {
        return true;
    }
    let ti = ((o * 6 + k as i32) * m.trlv + lv) as usize;
    let d = rd(m.trt, ti);
    let g = rd(m.trtg, ti);
    let (tm, dm): (*mut U16I32, *mut F32) = match k {
        1 => (m.burn, m.burnd),
        2 => (m.poi, m.poid),
        3 => (m.frzw, m.iced),
        4 => (m.wet, core::ptr::null_mut()),
        _ => (m.sndw, core::ptr::null_mut()),
    };
    // (Its status record, taken when the trap gives it anything: room for
    // every unit in a trap's chunk is made before the kernel, unit.js
    // simMoveRun; none left (never expected): the main thread's, as a mine.)
    let mut r = rd(m.stix, s) as usize;
    if !(rd(tm, r) < d || (!dm.is_null() && rd(dm, r) < g)) {
        return false;
    }
    if r == 0 {
        r = st_take(m.sthdr, m.stfree, m.stix, s) as usize;
        if r == 0 {
            return true;
        }
    }
    if rd(tm, r) < d {
        wr(tm, r, d);
    }
    if !dm.is_null() && rd(dm, r) < g {
        wr(dm, r, g);
    }
    false
}

/// Slot s's frozen and sand timers (by its status record; record 0 the zeros).
#[inline(always)]
unsafe fn st_frz(m: &Mv, s: usize) -> i32 {
    rd(m.frz, rd(m.stix, s) as usize)
}
#[inline(always)]
unsafe fn st_snd(m: &Mv, s: usize) -> i32 {
    rd(m.snd, rd(m.stix, s) as usize)
}

// ---- JavaScript helpers ----
/// (t + id) as a double (no wrap): for `%` by a tick count.
#[inline(always)]
fn tsum(t: i32, id: i32) -> i64 {
    t as i64 + id as i64
}
#[inline(always)]
fn rem64(a: i64, b: i64) -> i64 {
    if b == 0 { 0 } else { a.wrapping_rem(b) }
}
/// irem / rem64 for the kernels' tick tests ((t + id) % ticks): a
/// non-negative dividend by a positive divisor as unsigned 32-bit (a power
/// of two by its mask, the usual tick counts by constants); the same
/// results, without a division in most calls (a 64-bit remainder is ~40
/// cycles in wasm, and the step pass made up to three per moving unit).
#[inline(always)]
fn urem_f(a: u32, b: u32) -> u32 {
    if b & (b - 1) == 0 {
        return a & (b - 1);
    }
    match b {
        20 => a % 20,
        10 => a % 10,
        30 => a % 30,
        _ => a % b,
    }
}
#[inline(always)]
fn irem_f(a: i32, b: i32) -> i32 {
    if a >= 0 && b > 0 { urem_f(a as u32, b as u32) as i32 } else { irem(a, b) }
}
#[inline(always)]
fn rem64_f(a: i64, b: i64) -> i64 {
    if a >= 0 && b > 0 && a <= u32::MAX as i64 && b <= u32::MAX as i64 { urem_f(a as u32, b as u32) as i64 } else { rem64(a, b) }
}
/// Math.imul.
#[inline(always)]
fn imul(a: i32, b: i32) -> i32 {
    a.wrapping_mul(b)
}
/// Math.round(v * q) * iq (or 0 when v is not finite).
#[inline(always)]
fn quant_mul(v: f64, q: f64, iq: f64) -> f64 {
    if v.is_finite() { js_round(v * q) * iq } else { 0.0 }
}
/// Math.round(v * q) / q (or 0).
#[inline(always)]
fn quant_div(v: f64, q: f64) -> f64 {
    if v.is_finite() { js_round(v * q) / q } else { 0.0 }
}
/// A tile coordinate (an integer-valued double) in [0, n).
#[inline(always)]
fn inb(v: f64, n: i32) -> bool {
    v >= 0.0 && v < n as f64
}


// ---- areas ----
/// Area a's neighbours in the CSR (none beyond it: JavaScript's undefined).
#[inline(always)]
unsafe fn off_range(m: &Mv, a: i32) -> (usize, usize) {
    if a < 0 || (a as usize) + 1 >= m.offn {
        return (0, 0);
    }
    let a0 = rd(m.aoff, a as usize);
    let a1 = rd(m.aoff, a as usize + 1);
    if a0 < 0 || a1 <= a0 {
        return (0, 0);
    }
    (a0 as usize, a1 as usize)
}
/// _simAreaNear.
unsafe fn area_near(m: &Mv, a: i32, b: i32, k: i32) -> i32 {
    if a == b {
        return 1;
    }
    if k <= 0 {
        return 0;
    }
    let (a0, a1) = off_range(m, a);
    let mut i = a0;
    while i < a1 {
        if rd(m.anb, i) == b {
            return 1;
        }
        i += 1;
    }
    if k == 1 {
        return 0;
    }
    if k > 2 {
        return -1;
    }
    i = a0;
    while i < a1 {
        let (j0, j1) = off_range(m, rd(m.anb, i));
        let mut j = j0;
        while j < j1 {
            if rd(m.anb, j) == b {
                return 1;
            }
            j += 1;
        }
        i += 1;
    }
    0
}
/// _simInAreaRange.
unsafe fn in_area_range(m: &Mv, x: f64, y: f64, tx: f64, ty: f64, k: i32) -> i32 {
    let (w, h, tile) = (m.w, m.h, m.tile);
    let tgx = floor(tx / tile);
    let tgy = floor(ty / tile);
    if !(inb(tgx, w) && inb(tgy, h)) {
        return 0;
    }
    let ta = rd(m.ag, (tgy as i32 * w + tgx as i32) as usize);
    if !(ta >= 0) {
        return 0;
    }
    let fx = x / tile;
    let fy = y / tile;
    let gx = floor(fx);
    let gy = floor(fy);
    let rx = fx - gx;
    let ry = fy - gy;
    let x0 = if rx < 0.3 { gx - 1.0 } else { gx };
    let x1 = if rx < 0.7 { gx } else { gx + 1.0 };
    let y0 = if ry < 0.3 { gy - 1.0 } else { gy };
    let y1 = if ry < 0.7 { gy } else { gy + 1.0 };
    // (Not a number: the loops do not run.)
    if !(x0 == x0 && x1 == x1 && y0 == y0 && y1 == y1) {
        return 0;
    }
    let (x0, x1, y0, y1) = (x0 as i64, x1 as i64, y0 as i64, y1 as i64);
    let (wl, hl) = (w as i64, h as i64);
    let mut unknown = false;
    let mut yy = y0;
    while yy <= y1 {
        if yy >= 0 && yy < hl {
            let mut xx = x0;
            while xx <= x1 {
                if xx >= 0 && xx < wl {
                    let a = rd(m.ag, (yy * wl + xx) as usize);
                    if a >= 0 {
                        let r = area_near(m, a, ta, k);
                        if r == 1 {
                            return 1;
                        }
                        if r < 0 {
                            unknown = true;
                        }
                    }
                }
                xx += 1;
            }
        }
        yy += 1;
    }
    if unknown { -1 } else { 0 }
}
/// _simUnitInContactRange.
unsafe fn in_contact_range(m: &Mv, pad: f64, s: usize, q: usize, x: f64, y: f64, tx: f64, ty: f64, k: i32) -> i32 {
    if m.area_only {return in_area_range(m,x,y,tx,ty,k+1);}
    let (w, h, tile) = (m.w, m.h, m.tile);
    let rs = sep_radius(rd(m.crc, s), rd(m.rrc, s));
    let rq = sep_radius(rd(m.crc, q), rd(m.rrc, q));
    let reach = rs + rq + pad;
    let dx = tx - x;
    let dy = ty - y;
    if dx * dx + dy * dy > reach * reach {
        return 0;
    }
    let ugx = floor(x / tile);
    let ugy = floor(y / tile);
    let tgx = floor(tx / tile);
    let tgy = floor(ty / tile);
    let sx = tgx - ugx;
    let sy = tgy - ugy;
    if sx > 1.0 || sx < -1.0 || sy > 1.0 || sy < -1.0 {
        return 0;
    }
    if sx != 0.0 && sy != 0.0 {
        let in1 = inb(tgx, w) && inb(ugy, h);
        let in2 = inb(ugx, w) && inb(tgy, h);
        let b1 = !in1 || rd(m.wall, (ugy as i32 * w + tgx as i32) as usize) != 0;
        let b2 = !in2 || rd(m.wall, (tgy as i32 * w + ugx as i32) as usize) != 0;
        if b1 && b2 {
            return 0;
        }
    }
    in_area_range(m, x, y, tx, ty, k + 1)
}
/// _simUnitInAttackRange.
#[inline(always)]
unsafe fn in_attack_range(m: &Mv, pad: f64, s: usize, q: usize, x: f64, y: f64, tx: f64, ty: f64, k: i32) -> i32 {
    let r = in_area_range(m, x, y, tx, ty, k);
    if r != 0 || m.area_only {
        return r;
    }
    in_contact_range(m, pad, s, q, x, y, tx, ty, k)
}
/// cov[a] > 0 for the cover row of `owner` (vis.cover[owner]): none beyond
/// the players or the areas.
#[inline(always)]
unsafe fn covered(m: &Mv, owner: i32, a: i32) -> bool {
    !m.covf.is_null() && owner >= 0 && owner < m.covp && a >= 0 && a < m.covs && rd(m.covf, (owner * m.covs + a) as usize) > 0
}
#[inline(always)]
unsafe fn cover_row(m: &Mv, owner: i32) -> bool {
    !m.covf.is_null() && owner >= 0 && owner < m.covp
}
/// simWindowKey.
#[inline(always)]
fn window_key(x: f64, y: f64, tile: f64) -> f64 {
    let fx = x / tile;
    let fy = y / tile;
    let gx = floor(fx);
    let gy = floor(fy);
    let rx = fx - gx;
    let ry = fy - gy;
    (gy * 65536.0 + gx) * 9.0 + (if rx < 0.3 { 0.0 } else if rx < 0.7 { 1.0 } else { 2.0 }) * 3.0
        + (if ry < 0.3 { 0.0 } else if ry < 0.7 { 1.0 } else { 2.0 })
}
/// The summed hostile count of blocks bx0..bx1, by0..by1 (as doubles: no wrap).
#[inline(always)]
unsafe fn box_sum(t: *const i32, o: i64, stride: i64, bx0: i64, by0: i64, bx1: i64, by1: i64) -> i64 {
    rd(t, (o + (by1 + 1) * stride + bx1 + 1) as usize) as i64 - rd(t, (o + by0 * stride + bx1 + 1) as usize) as i64
        - rd(t, (o + (by1 + 1) * stride + bx0) as usize) as i64
        + rd(t, (o + by0 * stride + bx0) as usize) as i64
}

// ---- flow navigation ----
/// _simStepX.
#[inline(always)]
fn step_x(n: i32, t: i32, tx: i32, w: i32) -> i32 {
    let d = n - t;
    if d == w || d == -w {
        return tx;
    }
    if d == 1 && tx + 1 < w {
        return tx + 1;
    }
    if d == -1 && tx > 0 {
        return tx - 1;
    }
    irem_f(n, w)
}
/// _simStepY.
#[inline(always)]
fn step_y(n: i32, t: i32, tx: i32, ty: i32, w: i32) -> i32 {
    let d = n - t;
    if d == w {
        return ty + 1;
    }
    if d == -w {
        return ty - 1;
    }
    if (d == 1 && tx + 1 < w) || (d == -1 && tx > 0) {
        return ty;
    }
    idiv(n - irem_f(n, w), w)
}
/// _simOpenBlockXY.
#[inline(always)]
unsafe fn open_block(wall: *const u8, x: i32, y: i32, w: i32, h: i32) -> bool {
    if x < 1 || y < 1 || x >= w - 1 || y >= h - 1 {
        return false;
    }
    let mut yy = y - 1;
    while yy <= y + 1 {
        let r = (yy * w) as usize;
        if (rd(wall, r + x as usize - 1) | rd(wall, r + x as usize) | rd(wall, r + x as usize + 1)) != 0 {
            return false;
        }
        yy += 1;
    }
    true
}
/// simNavDetour.
unsafe fn nav_detour(wl: *const u8, w: i32, h: i32, gx: i32, gy: i32, aim: i32) -> i32 {
    let ax = irem_f(aim, w);
    let ay = idiv(aim - ax, w);
    let mut best = -1;
    let mut bd = i64::MAX;
    for k in 0..4 {
        let x = gx + if k == 2 { -1 } else if k == 3 { 1 } else { 0 };
        let y = gy + if k == 0 { -1 } else if k == 1 { 1 } else { 0 };
        if x < 0 || y < 0 || x >= w || y >= h || rd(wl, (y * w + x) as usize) != 0 {
            continue;
        }
        let ex = (ax - x) as i64;
        let ey = (ay - y) as i64;
        let d = ex * ex + ey * ey;
        if d < bd {
            bd = d;
            best = y * w + x;
        }
    }
    best
}
/// simFlowSlide (ngx, ngy as doubles: maybe not numbers).
#[inline(always)]
unsafe fn flow_slide(wl: *const u8, w: i32, h: i32, gx: i32, gy: i32, ngx: f64, ngy: f64) -> i32 {
    if ngx == gx as f64 && ngy == gy as f64 {
        return 0;
    }
    let ox = inb(ngx, w);
    let oy = inb(ngy, h);
    if ox && oy && rd(wl, (ngy as i32 * w + ngx as i32) as usize) == 0 {
        return 0;
    }
    if ox && gy >= 0 && gy < h && rd(wl, (gy * w + ngx as i32) as usize) == 0 {
        return 2;
    }
    if oy && gx >= 0 && gx < w && rd(wl, (ngy as i32 * w + gx) as usize) == 0 {
        return 1;
    }
    3
}
// A look-ahead asks for up to 32 successive tiles. Nearby units' looks
// overlap, even when their complete look-ahead cache entries miss. Keep
// the pure atlas steps on this job's stack, shared by its units, so a burst
// of steers does not rescan the atlas exits for every overlapping segment.
const ATLAS_STEP_CACHE_ENTRIES: usize = 512;
struct AtlasStepEntry {
    atlas: *const i32,
    tile: i32,
    dest: i32,
    next: i32,
}
/// The navigation context of one look (simFlowLook's arguments).
struct Nav {
    /// The profile's atlas header when the route is on the atlas (no rows,
    /// no destination field): null otherwise.
    atl: *const i32,
    step_cache: *mut AtlasStepEntry,
    w: i32,
    h: i32,
    cs: i32,
    c: i32,
    cw: i32,
    pl: *const u16,
    plh: i32,
    pb: *const i32,
    rows: *const u8,
    ro: i32,
    fields: *const u16,
    nb: *const i32,
    nt: *const i32,
    np: *const i32,
    df: *const u16,
    doff: i32,
    bx: i32,
    by: i32,
    bw: i32,
    bh: i32,
}
/// _simWallStepOut (rows always given here).
unsafe fn wall_step_out(v: &Nav, tx: i32, ty: i32) -> i32 {
    let mut first = -1;
    for k in 0..4 {
        let x = tx + if k == 2 { -1 } else if k == 3 { 1 } else { 0 };
        let y = ty + if k == 0 { -1 } else if k == 1 { 1 } else { 0 };
        if x < 0 || y < 0 || x >= v.w || y >= v.plh {
            continue;
        }
        let n = y * v.w + x;
        let l = rd(v.pl, n as usize);
        if l == 0xFFFF {
            continue;
        }
        if first < 0 {
            first = n;
        }
        // (On the atlas: no rows, the first open side.)
        if v.rows.is_null() {
            return n;
        }
        let cf = idiv(y, v.c) * v.cw + idiv(x, v.c);
        if rd(v.rows, (v.ro + rd(v.pb, cf as usize) + l as i32) as usize) != 255 {
            return n;
        }
    }
    first
}
/// simNavStepXY.
unsafe fn nav_step(v: &Nav, t: i32, tx: i32, ty: i32, dest: i32, exit_cache: *mut crate::atlas::ExitCache) -> i32 {
    if t == dest {
        return -1;
    }
    if !v.atl.is_null() {
        if rd(v.pl, t as usize) == 0xFFFF {
            return wall_step_out(v, tx, ty);
        }
        let cache = if v.step_cache.is_null() { core::ptr::null_mut() } else {
            let h = (t as u32).wrapping_mul(0x9e3779b1) ^ (dest as u32).wrapping_mul(0x85ebca77);
            v.step_cache.add(((h ^ (h >> 16)) as usize) & (ATLAS_STEP_CACHE_ENTRIES - 1))
        };
        if !cache.is_null() && (*cache).atlas == v.atl && (*cache).tile == t && (*cache).dest == dest {
            return (*cache).next;
        }
        let next = match crate::atlas::Atl::from(v.atl) {
            Some(mut a) => {
                a.exit_cache = exit_cache;
                crate::atlas::atlas_step(&a, v.pl, v.pb, v.nt, v.np, v.fields, v.w, t, dest)
            },
            None => -1,
        };
        if !cache.is_null() { core::ptr::write(cache, AtlasStepEntry { atlas: v.atl, tile: t, dest, next }); }
        return next;
    }
    if !v.df.is_null() {
        let lx = tx - v.bx;
        let ly = ty - v.by;
        if lx >= 0 && ly >= 0 && lx < v.bw && ly < v.bh {
            let o = (v.doff + ly * v.bw + lx) as usize;
            let here = rd(v.df, o);
            if here != 0xFFFF {
                let bwu = v.bw as usize;
                let mut best = -1;
                let mut bv = here;
                if lx + 1 < v.bw && rd(v.df, o + 1) < bv {
                    bv = rd(v.df, o + 1);
                    best = t + 1;
                }
                if lx > 0 && rd(v.df, o - 1) < bv {
                    bv = rd(v.df, o - 1);
                    best = t - 1;
                }
                if ly + 1 < v.bh && rd(v.df, o + bwu) < bv {
                    bv = rd(v.df, o + bwu);
                    best = t + v.w;
                }
                if ly > 0 && rd(v.df, o - bwu) < bv {
                    best = t - v.w;
                }
                return best;
            }
        }
    }
    let cxi = tx >> v.cs;
    let cyi = ty >> v.cs;
    let cf = (cyi * v.cw + cxi) as usize;
    let pl = rd(v.pl, t as usize);
    if pl == 0xFFFF {
        return wall_step_out(v, tx, ty);
    }
    let e = rd(v.rows, (v.ro + rd(v.pb, cf) + pl as i32) as usize);
    if e >= 254 {
        return -1;
    }
    let node = (rd(v.nb, cf) + e as i32) as usize;
    if rd(v.nt, node) == t {
        let p = rd(v.np, node);
        return if p >= 0 { rd(v.nt, p as usize) } else { -1 };
    }
    let c = v.c as usize;
    let lx = tx - (cxi << v.cs);
    let ly = ty - (cyi << v.cs);
    let o = node * c * c + ly as usize * c + lx as usize;
    let f = v.fields;
    let mut best = -1;
    let mut bv = rd(f, o);
    if lx + 1 < v.c && rd(f, o + 1) < bv {
        bv = rd(f, o + 1);
        best = t + 1;
    }
    if lx > 0 && rd(f, o - 1) < bv {
        bv = rd(f, o - 1);
        best = t - 1;
    }
    if ly + 1 < v.c && rd(f, o + c) < bv {
        bv = rd(f, o + c);
        best = t + v.w;
    }
    if ly > 0 && rd(f, o - c) < bv {
        best = t - v.w;
    }
    best
}
/// The flow looks shared by every thread (mv.lookc, LOOKC_ENTRIES entries
/// of 16 words): a look's result is a pure function of its tile, its
/// destination and field kind, the navigation profile, its build and the
/// wall version of its block (what the per-unit look-ahead columns are
/// trusted by), so the units walking a route through a tile share one look.
/// Entries are seqlocked (word 0 even and at least 2: valid; a writer makes
/// it odd while it writes): a torn or busy entry is a miss, never a wrong
/// answer; which thread made an entry does not show.
pub const LOOKC_ENTRIES: usize = 1 << 18;
#[inline(always)]
fn look_hash(tl: i32, dk: i32, kp: i32, ver: i32, wv: i32) -> usize {
    let mut h = (tl as u32).wrapping_mul(0x9E3779B1) ^ (dk as u32).wrapping_mul(0x85EBCA77);
    h ^= (kp as u32).wrapping_mul(0xC2B2AE3D) ^ (ver as u32).wrapping_mul(0x27D4EB2F) ^ (wv as u32).wrapping_mul(0x165667B1);
    h ^= h >> 15;
    h = h.wrapping_mul(0x2C1B3C6D);
    h ^= h >> 13;
    (h as usize) & (LOOKC_ENTRIES - 1)
}
/// (code, n1, n2, far, open) of the shared entry for the key, if there.
#[inline(always)]
unsafe fn look_get(m: &Mv, tl: i32, dk: i32, kp: i32, ver: i32, wv: i32) -> Option<(i32, i32, i32, i32, u8)> {
    use core::sync::atomic::{fence, AtomicU32, Ordering};
    if m.lookc.is_null() {
        return None;
    }
    let e = m.lookc.add(look_hash(tl, dk, kp, ver, wv) * 16) as *const AtomicU32;
    let s1 = (*e).load(Ordering::Acquire);
    if s1 < 2 || (s1 & 1) != 0 {
        return None;
    }
    // (The data words plainly: only the sequence word is atomic.)
    let w = |i: usize| core::ptr::read_volatile((e as *const i32).add(i));
    let (a, b, c, d, f) = (w(1), w(2), w(3), w(4), w(5));
    let (code, n1, n2, far, open) = (w(6), w(7), w(8), w(9), w(10));
    fence(Ordering::Acquire);
    if (*e).load(Ordering::Relaxed) != s1 || a != tl || b != dk || c != kp || d != ver || f != wv {
        return None;
    }
    Some((code, n1, n2, far, open as u8))
}
#[inline(always)]
unsafe fn look_put(m: &Mv, tl: i32, dk: i32, kp: i32, ver: i32, wv: i32, code: i32, n1: i32, n2: i32, far: i32, open: bool) {
    use core::sync::atomic::{AtomicU32, Ordering};
    if m.lookc.is_null() {
        return;
    }
    let e = m.lookc.add(look_hash(tl, dk, kp, ver, wv) * 16) as *const AtomicU32;
    let s0 = (*e).load(Ordering::Relaxed);
    if (s0 & 1) != 0 || (*e).compare_exchange(s0, s0 | 1, Ordering::Acquire, Ordering::Relaxed).is_err() {
        return;
    }
    let st = |i: usize, v: i32| core::ptr::write_volatile((e as *mut i32).add(i), v);
    st(1, tl);
    st(2, dk);
    st(3, kp);
    st(4, ver);
    st(5, wv);
    st(6, code);
    st(7, n1);
    st(8, n2);
    st(9, far);
    st(10, if open { 1 } else { 0 });
    // (Even again, and at least 2: valid.)
    let nx = (s0 | 1).wrapping_add(1);
    (*e).store(if nx < 2 { 2 } else { nx }, Ordering::Release);
}

// A slot's flow look-ahead record (unit.mvNav, sim_unit_state.js): its key
// (tile, destination, build, wall version, field kind) and result (next
// tile, the one after, the farthest tile << 1 | open), one 32-byte record:
// a steer reads and writes one cache line, not nine columns' lines.
const NV_STRIDE: usize = 8;
const NV_D: usize = 1;
const NV_V: usize = 2;
const NV_W: usize = 3;
const NV_G: usize = 4;
const NV_N1: usize = 5;
const NV_N2: usize = 6;
const NV_FO: usize = 7;
#[inline(always)]
unsafe fn nv_put(m: &Mv, s: usize, tl: i32, dk: i32, ver: i32, wv: i32, fgen: i32, n1: i32, n2: i32, far: i32, open: bool) {
    let r = m.nv.add(s * NV_STRIDE);
    *r = tl;
    *r.add(NV_D) = dk;
    *r.add(NV_V) = ver;
    *r.add(NV_W) = wv;
    *r.add(NV_G) = fgen;
    *r.add(NV_N1) = n1;
    *r.add(NV_N2) = n2;
    *r.add(NV_FO) = (far << 1) | (open as i32);
}

/// simFlowLook: 1 in the look-ahead record, 0 no way, -1 walled in, -2 a
/// bad build.
#[cfg_attr(feature = "prof", inline(never))]
unsafe fn flow_look(m: &Mv, v: &Nav, s: usize, refresh: bool, tl: i32, gx: i32, gy: i32, dk: i32, wl: *const u8, nav_ver: i32, wv: i32, fgen: i32) -> i32 {
    let r = m.nv.add(s * NV_STRIDE);
    if *r == tl && *r.add(NV_D) == dk && *r.add(NV_G) == fgen && (!refresh || (*r.add(NV_V) == nav_ver && *r.add(NV_W) == wv)) {
        return 1;
    }
    // (The shared looks: the field kind and the profile in one key word.)
    // (The walls it looks against: the profile's, else the air or ground
    // map: a flyer's bit.)
    let kp = fgen | ((rd(m.npr, s) as i32) << 8) | (if wl == m.airw { 1 << 20 } else { 0 });
    if let Some((code, n1, n2, far, open)) = look_get(m, tl, dk, kp, nav_ver, wv) {
        if code == 1 {
            nv_put(m, s, tl, dk, nav_ver, wv, fgen, n1, n2, far, open != 0);
        }
        return code;
    }
    dbgc!(m, 18);
    let code = flow_look_calc(m, v, s, tl, gx, gy, dk, wl, nav_ver, wv, fgen);
    if code != 1 {
        look_put(m, tl, dk, kp, nav_ver, wv, code, 0, 0, 0, false);
    } else {
        let r = m.nv.add(s * NV_STRIDE);
        let fo = *r.add(NV_FO);
        look_put(m, tl, dk, kp, nav_ver, wv, 1, *r.add(NV_N1), *r.add(NV_N2), fo >> 1, (fo & 1) != 0);
    }
    code
}
/// The look itself (flow_look's miss).
#[inline(never)]
unsafe fn flow_look_calc(m: &Mv, v: &Nav, s: usize, tl: i32, gx: i32, gy: i32, dk: i32, wl: *const u8, nav_ver: i32, wv: i32, fgen: i32) -> i32 {
    let (w, h) = (v.w, v.h);
    if !v.atl.is_null() && dk>=0 && dk<w*h && tl!=dk {
        let dx=irem_f(dk,w);let dy=idiv(dk-dx,w);
        if let Some(a)=crate::atlas::Atl::from(v.atl) {
            if a.clear_rect(gx,gy,dx,dy) {
                let n=if (dx-gx).abs()>=(dy-gy).abs(){tl+if dx>gx{1}else{-1}}
                    else{tl+if dy>gy{w}else{-w}};
                // Live walls can be newer than this immutable atlas.
                let nx=step_x(n,tl,gx,w);let ny=step_y(n,tl,gx,gy,w);
                if open_block(wl,gx,gy,w,h) && open_block(wl,nx,ny,w,h) {
                    nv_put(m,s,tl,dk,nav_ver,wv,fgen,n,-1,dk,true);
                    return 1;
                }
            }
        }
    }
    let mut exit_cache = crate::atlas::ExitCache::new();
    let exit_cache = &mut exit_cache as *mut crate::atlas::ExitCache;
    let mut n1 = nav_step(v, tl, gx, gy, dk, exit_cache);
    if n1 < 0 {
        return 0;
    }
    let mut n2 = -1;
    let mut far = n1;
    let mut open = false;
    let n1x = step_x(n1, tl, gx, w);
    let n1y = step_y(n1, tl, gx, gy, w);
    if rd(wl, n1 as usize) != 0 {
        let mut aim = nav_step(v, n1, n1x, n1y, dk, exit_cache);
        if !(aim >= 0) || rd(wl, aim as usize) != 0 {
            aim = dk;
        }
        n1 = nav_detour(wl, w, h, gx, gy, aim);
        if n1 < 0 {
            return -1;
        }
        far = n1;
    } else {
        if (n1x - gx).abs() + (n1y - gy).abs() != 1 {
            return -2;
        }
        open = open_block(wl, gx, gy, w, h) && open_block(wl, n1x, n1y, w, h);
        let mut cur = n1;
        let mut cx = n1x;
        let mut cy = n1y;
        let mut short = n1;
        let lim = if open { 32 } else { 2 };
        let mut k = 1;
        while k < lim {
            let nx = nav_step(v, cur, cx, cy, dk, exit_cache);
            if nx < 0 || rd(wl, nx as usize) != 0 {
                break;
            }
            if k == 1 {
                n2 = nx;
            }
            if !open {
                break;
            }
            let nxx = step_x(nx, cur, cx, w);
            let nxy = step_y(nx, cur, cx, cy, w);
            if !open_block(wl, nxx, nxy, w, h) {
                break;
            }
            cur = nx;
            far = nx;
            if k < 6 {short=nx;}
            cx = nxx;
            cy = nxy;
            k += 1;
        }
        // Pull the shared route taut across artificial cluster exits.
        // One segment check per cached tile/destination, never per unit.
        if open && far != short {
            let fx=irem_f(far,w);let fy=idiv(far-fx,w);
            if !seg_open(wl,w,h,gx as f64*m.tile+16.0,gy as f64*m.tile+16.0,
                fx as f64*m.tile+16.0,fy as f64*m.tile+16.0,m.itile,m.tile) {far=short;}
        }
    }
    nv_put(m, s, tl, dk, nav_ver, wv, fgen, n1, n2, far, open);
    1
}

// ---- the movement kernels ----

/// Whether the segment (x0, y0)-(x1, y1) stays on open tiles of `wl` (in the
/// map): its points a quarter tile apart. (A step of several base ticks
/// (simDk) can pass more than one tile: the slide checks only the tile it
/// ends in.)
#[inline(never)]
unsafe fn seg_open(wl: *const u8, w: i32, h: i32, x0: f64, y0: f64, x1: f64, y1: f64, itile: f64, tile: f64) -> bool {
    let dx = x1 - x0;
    let dy = y1 - y0;
    // (Ending in its own tile or one beside it, the most: the tiles the
    // segment passes, exactly: the end one, and on a diagonal the one whose
    // edge it crosses first.)
    let inv = f64x2_splat(itile);
    let axy = f64x2_floor(f64x2_mul(f64x2(x0, y0), inv));
    let bxy = f64x2_floor(f64x2_mul(f64x2(x1, y1), inv));
    let (ax, ay) = (f64x2_extract_lane::<0>(axy), f64x2_extract_lane::<1>(axy));
    let (bx, by) = (f64x2_extract_lane::<0>(bxy), f64x2_extract_lane::<1>(bxy));
    if (bx - ax).abs() <= 1.0 && (by - ay).abs() <= 1.0 {
        let open = |gx: f64, gy: f64| inb(gx, w) && inb(gy, h) && rd(wl, (gy as i32 * w + gx as i32) as usize) == 0;
        if !open(bx, by) { return false; }
        if bx != ax && by != ay {
            let ex = (if bx > ax { bx } else { ax }) * tile;
            let ey = (if by > ay { by } else { ay }) * tile;
            let tx = (ex - x0) / dx;
            let ty = (ey - y0) / dy;
            if tx < ty { return open(bx, ay); }
            if ty < tx { return open(ax, by); }
            return open(bx, ay) && open(ax, by);
        }
        return true;
    }
    let len = sqrt(dx * dx + dy * dy);
    let n = (floor(len / (tile * 0.25)) as i32 + 1).min(256);
    // Exact f64 sample arithmetic in two lanes: no reciprocal approximation
    // or reassociation, so a point on a tile boundary keeps the same tile.
    let (vx0, vy0, vdx, vdy, vn) = (f64x2_splat(x0), f64x2_splat(y0), f64x2_splat(dx), f64x2_splat(dy), f64x2_splat(n as f64));
    let (zero, vw, vh) = (f64x2_splat(0.0), f64x2_splat(w as f64), f64x2_splat(h as f64));
    let mut i = 1;
    while i + 1 <= n {
        let k = f64x2_div(f64x2(i as f64, (i + 1) as f64), vn);
        let gx = f64x2_floor(f64x2_mul(f64x2_add(vx0, f64x2_mul(vdx, k)), inv));
        let gy = f64x2_floor(f64x2_mul(f64x2_add(vy0, f64x2_mul(vdy, k)), inv));
        let valid = v128_and(v128_and(f64x2_ge(gx, zero), f64x2_lt(gx, vw)), v128_and(f64x2_ge(gy, zero), f64x2_lt(gy, vh)));
        if i64x2_bitmask(valid) != 3 { return false; }
        let cells = i32x4_add(i32x4_trunc_sat_f64x2_zero(gx), i32x4_mul(i32x4_trunc_sat_f64x2_zero(gy), i32x4_splat(w)));
        if (rd(wl, i32x4_extract_lane::<0>(cells) as usize) | rd(wl, i32x4_extract_lane::<1>(cells) as usize)) != 0 { return false; }
        i += 2;
    }
    if i <= n {
        let k = i as f64 / n as f64;
        let gx = floor((x0 + dx * k) * itile);
        let gy = floor((y0 + dy * k) * itile);
        if !inb(gx, w) || !inb(gy, h) || rd(wl, (gy as i32 * w + gx as i32) as usize) != 0 {
            return false;
        }
    }
    true
}

/// An attack made now by slot s: its shots for the step's base ticks (the
/// carry, unit.atkL: the base ticks it stood ready before the step's end,
/// k_status; 1 + carry / cooldown shots, into unit.atkN for the hit
/// kernel), its timer the cooldown past the carry; flash and timer flags.
/// (One base tick a step: no carry, one shot, the timer the cooldown.)
#[inline(always)]
unsafe fn fire(m: &Mv, s: usize) {
    let cd = mv_stat(m, s, 4, m.acd);
    let mut at = cd;
    let mut n = 1u8;
    if !m.atl.is_null() {
        let l = rd(m.atl, s);
        if l != 0 {
            let lf = l as f64;
            if cd > 0.0 {
                n = (1 + floor(lf / cd) as i32).min(255) as u8;
            }
            at = cd * n as f64 - lf;
            wr(m.atl, s, 0);
        }
    }
    if !m.atn.is_null() {
        wr(m.atn, s, n);
    }
    wr(m.at as *mut F32, s, at);
    wr(m.flash, s, 8);
    wr(m.tmon, s, 1);
}


#[inline(always)]
unsafe fn checked_position(m:&Mv,s:usize,x:f64,y:f64)->(f64,f64) {
    if m.occ.is_null(){return (x,y);}
    if m.traffic_mode==0{return checked_position_legacy(m,s,x,y);}
    checked_traffic_position(m,s,x,y,true)
}
#[inline(never)]
unsafe fn checked_traffic_position(m:&Mv,s:usize,x:f64,y:f64,intent:bool)->(f64,f64) {
    let nx=floor(x*8.0+0.5) as i32;let ny=floor(y*8.0+0.5) as i32;
    // (Where it stands: the grid's (unit.x holds the wanted position in the
    // occupancy's second stage).)
    let (ox,oy)=if (*m.occ).active(s){(*m.occ).pos(s)}else{(*(m.x.add(s) as *const i32),*(m.y.add(s) as *const i32))};
    checked_traffic_q(m,s,ox,oy,nx,ny,intent)
}
/// The same in eighths: from (ox, oy) where it stands, to (nx, ny).
#[inline(never)]
unsafe fn checked_traffic_q(m:&Mv,s:usize,ox:i32,oy:i32,nx:i32,ny:i32,intent:bool)->(f64,f64) {
    let (mut nx,mut ny)=(nx,ny);
    if nx==ox&&ny==oy{return (ox as f64*0.125,oy as f64*0.125);}
    let original_nx=nx;let original_ny=ny;
    let np=rd(m.npr,s) as usize;
    let wl=if np<NAV_PROFILES&&!m.nav.get_unchecked(np).walls.is_null(){m.nav.get_unchecked(np).walls}else if rd(m.fl,s)&32!=0{m.airw}else{m.wall};
    let clear=|ax:i32,ay:i32|{
        (m.tsh>=0&&(ax>>m.tsh)==(ox>>m.tsh)&&(ay>>m.tsh)==(oy>>m.tsh))
            ||seg_open(wl,m.w,m.h,ox as f64*0.125,oy as f64*0.125,ax as f64*0.125,ay as f64*0.125,m.itile,m.tile)
    };
    let original_dx=(nx-ox) as f64;let original_dy=(ny-oy) as f64;
    let original_len=sqrt(original_dx*original_dx+original_dy*original_dy);
    let (layer,mass)=(*m.occ).layer_mass(s);
    if intent && m.traffic_mode>=2 && original_len>0.0{
        let (fx,fy)=super::traffic::sample(m.traffic,ox,oy,layer);
        let response=if *m.traffic.add(11)!=0{(original_len/(24.0*m.dkf)).max(1.0)}else{1.0};
        // The pressure only steers: its part across the step, never back
        // against it (a crowd ordered inward must not walk outward), and at
        // most ~50 degrees off the step's own heading.
        let ux=original_dx/original_len;let uy=original_dy/original_len;
        let along=fx*ux+fy*uy;let (lx,ly)=keep_right(fx-along*ux,fy-along*uy,along,ux,uy);
        let sx=lx*8.0*m.dkf*response;let sy=ly*8.0*m.dkf*response;
        let side=sqrt(sx*sx+sy*sy);let cap=original_len*1.2;
        let k=if side>cap{cap/side}else{1.0};
        let dx=original_dx+sx*k;let dy=original_dy+sy*k;
        let length=sqrt(dx*dx+dy*dy);
        if length>0.0&&side>0.0{
            let ax=ox+floor(dx/length*original_len+0.5) as i32;let ay=oy+floor(dy/length*original_len+0.5) as i32;
            nx=ax;ny=ay;
        }
    }
    // Validate the quantized segment too: rounding a point just short of a
    // wall can otherwise put its center exactly onto the blocked tile.
    let mut open=clear(nx,ny);
    if !open&&(nx!=original_nx||ny!=original_ny)&&clear(original_nx,original_ny){nx=original_nx;ny=original_ny;open=true;}
    let (mut tx,mut ty)=if open{(*m.occ).preview(s,nx,ny)}else{(ox,oy)};
    let dx=(nx-ox) as f64;let dy=(ny-oy) as f64;let want=dx*dx+dy*dy;
    let ax=(tx-ox) as f64;let ay=(ty-oy) as f64;
    if m.traffic_mode&1!=0 && want>0.0 && ax*ax+ay*ay<want*0.64 {
        // A blocked flow may use the free shoulder. At most one accepted
        // move, at the requested speed; every candidate keeps the same
        // swept exclusive footprint, block halo and wall checks.
        let len=sqrt(want);
        let handed=!m.traffic.is_null()&&*m.traffic.add(13)!=0;
        let mut best=(ax*dx+ay*dy)/len*0.7+sqrt(ax*ax+ay*ay)*0.3;
        for k in 0..4 {
            let direction=if handed{match k{0=>0,1=>2,2=>1,_=>3}}else{k};
            let (vx,vy)=match direction {
                0=>((dx-dy)*0.7071067811865476,(dy+dx)*0.7071067811865476),
                1=>((dx+dy)*0.7071067811865476,(dy-dx)*0.7071067811865476),
                2=>(-dy,dx),_ =>(dy,-dx),
            };
            let ax=ox+floor(vx+0.5) as i32;let ay=oy+floor(vy+0.5) as i32;
            if clear(ax,ay) {
                let (px,py)=(*m.occ).preview(s,ax,ay);
                let vx=(px-ox) as f64;let vy=(py-oy) as f64;
                let distance=sqrt(vx*vx+vy*vy);
                let score=(vx*dx+vy*dy)/len*0.7+distance*0.3+if handed&&k<2{distance*0.4}else{0.0};
                if score>best+0.0625 {best=score;tx=px;ty=py;}
                if handed&&k<2&&distance>=len*0.65{break;}
                if best>len*0.78 {break;}
            }
        }
    }
    let (mut tx,mut ty)=(*m.occ).commit_preview(s,tx,ty,nx,ny);
    if intent && m.traffic_mode>=2 && original_len>0.0{
        let mut progress=((tx-ox) as f64*original_dx+(ty-oy) as f64*original_dy)/original_len;
        dbgc!(m,64);
        if progress<original_len*0.25&&traffic_deferred(m){dbgc!(m,65);
            if let Some((sx,sy))=traffic_swap(m,s,tx,ty,original_dx/original_len,original_dy/original_len,wl,false){
                tx=sx;ty=sy;progress=original_len;
            }
        }
        let x0=*(m.x0.add(s) as *const i32);let y0=*(m.y0.add(s) as *const i32);
        super::traffic::deposit(m.traffic,x0,y0,layer,mass,original_dx,original_dy,(original_len-progress).max(0.0),m.dkf);
        // Blocked: a push for whoever stands in the way (read next step).
        let blocked=1.0-progress.max(0.0)/original_len;
        if blocked>0.3{super::traffic::push_deposit(m.traffic,tx,ty,original_dx,original_dy,original_len,blocked,(*m.occ).radius_q(s),rd(m.own,s),0);}
    }
    if tx!=nx || ty!=ny {wr(m.steady,s,0);wr(m.ct,s,-1);wr(m.cd,s,-1);}
    if tx!=original_nx || ty!=original_ny {
        wr(m.vx,s,(tx-ox) as f64/(8.0*m.dkf));wr(m.vy,s,(ty-oy) as f64/(8.0*m.dkf));
    }
    (tx as f64*0.125,ty as f64*0.125)
}
#[inline(never)]
unsafe fn checked_position_legacy(m:&Mv,s:usize,x:f64,y:f64)->(f64,f64) {
    let nx=js_round(x*8.0) as i32;let ny=js_round(y*8.0) as i32;
    let (ox,oy)=if (*m.occ).active(s){(*m.occ).pos(s)}else{(*(m.x.add(s) as *const i32),*(m.y.add(s) as *const i32))};
    let (mut tx,mut ty)=(*m.occ).position(s,nx,ny);
    if tx==ox&&ty==oy&&(nx!=ox||ny!=oy)&&rd(m.on,s)==6{
        let dx=(nx-ox) as f64;let dy=(ny-oy) as f64;let np=rd(m.npr,s) as usize;
        let wl=if np<NAV_PROFILES&&!m.nav.get_unchecked(np).walls.is_null(){m.nav.get_unchecked(np).walls}else if rd(m.fl,s)&32!=0{m.airw}else{m.wall};
        for k in 0..4{let (vx,vy)=match k{0=>((dx-dy)*0.7071067811865476,(dy+dx)*0.7071067811865476),1=>((dx+dy)*0.7071067811865476,(dy-dx)*0.7071067811865476),2=>(-dy,dx),_=>(dy,-dx)};
            let ax=ox+js_round(vx) as i32;let ay=oy+js_round(vy) as i32;
            if seg_open(wl,m.w,m.h,ox as f64*0.125,oy as f64*0.125,ax as f64*0.125,ay as f64*0.125,m.itile,m.tile){(tx,ty)=(*m.occ).position(s,ax,ay);if tx!=ox||ty!=oy{break;}}
        }
    }
    if tx!=nx||ty!=ny{wr(m.steady,s,0);wr(m.ct,s,-1);wr(m.cd,s,-1);wr(m.vx,s,(tx-ox) as f64/(8.0*m.dkf));wr(m.vy,s,(ty-oy) as f64/(8.0*m.dkf));}
    (tx as f64*0.125,ty as f64*0.125)
}
#[inline(always)]
unsafe fn checked_positions4(m:&Mv,s:usize,nx:v128,ny:v128,bits:i32)->(v128,v128) {
    if m.occ.is_null(){return (nx,ny);}
    let mut xx:[i32;4]=core::mem::transmute(nx);let mut yy:[i32;4]=core::mem::transmute(ny);
    for l in 0..4 {if bits&(1<<l)!=0 {
        let (x,y)=checked_position(m,s+l,xx[l] as f64*0.125,yy[l] as f64*0.125);
        xx[l]=(x*8.0) as i32;yy[l]=(y*8.0) as i32;
    }}
    (core::mem::transmute(xx),core::mem::transmute(yy))
}

/// A move's step written: position quantized, the output by tile.
#[cfg_attr(not(feature = "prof"), inline(always))]
#[cfg_attr(feature = "prof", inline(never))]
unsafe fn commit_step(m: &Mv, s: usize, x: f64, y: f64, vx: f64, vy: f64, gx: i32, gy: i32, tl: i32, q: f64, iq: f64) {
    let itile = m.itile;
    // (Rounded as the position column stores it: Unit.update's x += vx.)
    let nx = (x + vx) as f32 as f64;
    let ny = (y + vy) as f32 as f64;
    wr(m.px, s, x);
    wr(m.py, s, y);
    wr(m.vx, s, vx);
    wr(m.vy, s, vy);
    wr(m.spent, s, if floor(nx * itile) != gx as f64 || floor(ny * itile) != gy as f64 { 1 } else { 0 });
    wr(m.floor, s, tl);
    let qx = quant_mul(nx, q, iq);
    let qy = quant_mul(ny, q, iq);
    let (qx,qy)=checked_position(m,s,qx,qy);
    wr(m.x,s,qx);
    wr(m.y,s,qy);
    wr(m.out, s, if floor(qx * itile) != gx as f64 || floor(qy * itile) != gy as f64 { 3 } else { 1 });
}

/// The params of the step kernel (from F).
struct StepP {
    tr: i32,
    q: f64,
    iq: f64,
    players: i32,
    bsz: f64,
    absent: f64,
    boxsteps: i32,
    wcheck: i32,
    acq_t: i64,
    wkwatch: i64,
    stride: i64,
    plane: i64,
}

/// SIM_KERNEL_MOVE_STEP over slots s0..end: four slots at a time through the
/// steady step (step4: a flow unit walking its committed step inside its
/// tile, nothing to look at this tick), the rest one by one (step_slot).
#[no_mangle]
pub unsafe extern "C" fn mv_step(a: u32, s0: i32, end: i32) {
    let a = waddr(a) as *const i32;
    let m = Mv::load(a);
    let f = (a as usize + 4096) as *const f64;
    let p = step_params(f);
    let mut s = s0.max(0) as usize;
    let end = if end > 0 { end as usize } else { 0 };
    // (The steady step's tick tests as masks: the aggro look ticks are
    // (t + id) & 3 with four acquisition ticks; else every lane one by one.)
    let fast = p.acq_t == 4 && p.tr > 0;
    // (The last group too, its missing lanes masked: which path a unit takes
    // must not depend on where its slot falls, which differs between peers;
    // the vector and scalar steps leave different steady windows.)
    while fast && s < end {
        let n = (end - s).min(4);
        let valid = (1i32 << n) - 1;
        let mut mvd = 0;
        let done = step4(&m, &p, s, &mut mvd, valid);
        if done != valid {
            for l in 0..n {
                if done & (1 << l) == 0 {
                    step_slot(&m, &p, s + l);
                }
            }
        }
        s += 4;
    }
    while s < end {
        step_slot(&m, &p, s);
        s += 1;
    }
}

#[inline(always)]
unsafe fn ld_u8x4(p: *const u8) -> v128 {
    u32x4_extend_low_u16x8(u16x8_extend_low_u8x16(v128_load32_zero(p as *const u32)))
}
#[inline(always)]
unsafe fn ld_i8x4(p: *const i8) -> v128 {
    i32x4_extend_low_i16x8(i16x8_extend_low_i8x16(v128_load32_zero(p as *const u32)))
}

/// Slots s..s + 4 through the steady step: those that take it (bits of the
/// result) are done, the others are for step_slot. A lane takes it when the
/// slot is a flow unit (on 1, mvFlags 64; no brain instruction) inside its
/// committed step's steady window (mvSteady, steady_until: the step good and
/// nothing to look at), alive and indexed, in the map on the step's tile
/// (mvCTl) and its floor's, with its flow field as made (its generation,
/// destination, ready) and a step that stays in its tile (or a flyer's, 32).
/// Then the step as commit_step (in f32: x + vx, quantized to the nearest;
/// spent and output by tile).
#[cfg_attr(not(feature = "prof"), inline(always))]
#[cfg_attr(feature = "prof", inline(never))]
unsafe fn step4(m: &Mv, p: &StepP, s: usize, mvd: &mut i32, valid: i32) -> i32 {
    if m.span_n==1&&*m.on.add(s)!=1{return 0;}
    let t = m.t;
    let ti = i32x4_splat(t);
    let zero = i32x4_splat(0);
    let one = i32x4_splat(1);
    let on = ld_u8x4(m.on.add(s));
    let fl = ld_u8x4(m.fl.add(s));
    let dead = ld_u8x4(m.dead.add(s));
    // (valid: the group's lanes holding slots, the last group's fewer.)
    let vm = i32x4_ne(v128_and(i32x4_splat(valid), i32x4(1, 2, 4, 8)), zero);
    let mut ok = v128_and(vm, v128_and(v128_and(i32x4_eq(on, one), i32x4_ne(v128_and(fl, i32x4_splat(64)), zero)), i32x4_eq(dead, zero)));
    if !v128_any_true(ok) { return 0; }
    if BRAIN {
        ok = v128_and(ok, i32x4_eq(ld_u8x4(m.cmode.add(s)), zero));
    }
    if m.steady.is_null() {
        return 0;
    }
    // (Counters: why flow lanes leave the vector step. 20 candidates, 21
    // window over, 22 rejected after the window (state, tile, floor), 23
    // leaving their tile, 24 field not as made, 25 on 1 without flag 64.)
    #[cfg(feature = "dbgc")]
    let cand0 = i32x4_bitmask(ok) as i32;
    #[cfg(feature = "dbgc")]
    {
        dbgc!(m, 20, cand0.count_ones());
        let on1 = i32x4_bitmask(v128_and(i32x4_eq(on, one), i32x4_eq(v128_and(fl, i32x4_splat(64)), zero))) as i32;
        dbgc!(m, 25, on1.count_ones());
    }
    ok = v128_and(ok, i32x4_lt(ti, v128_load(m.steady.add(s) as *const v128)));
    #[cfg(feature = "dbgc")]
    let cand1 = i32x4_bitmask(ok) as i32;
    #[cfg(feature = "dbgc")]
    dbgc!(m, 21, (cand0 & !cand1).count_ones());
    if i32x4_bitmask(ok) == 0 {
        return 0;
    }
    ok = v128_and(ok, f32x4_gt(v128_load(m.en.add(s) as *const v128), f32x4_splat(0.0)));
    ok = v128_and(ok, v128_not(i32x4_eq(v128_load(m.sep.add(s) as *const v128), i32x4_splat(p.absent as u32 as i32))));
    // (Positions in eighths: the tile by a shift, the step as whole eighths
    // of the committed step, halves up: the same as quantizing x + vx.)
    let x = v128_load(m.x.add(s) as *const v128);
    let y = v128_load(m.y.add(s) as *const v128);
    let gx = tile4(m, x);
    let gy = tile4(m, y);
    ok = v128_and(ok, v128_and(i32x4_ge(gx, zero), i32x4_lt(gx, i32x4_splat(m.w))));
    ok = v128_and(ok, v128_and(i32x4_ge(gy, zero), i32x4_lt(gy, i32x4_splat(m.h))));
    let tl = i32x4_add(i32x4_mul(gy, i32x4_splat(m.w)), gx);
    ok = v128_and(ok, i32x4_eq(tl, v128_load(m.ctl.add(s) as *const v128)));
    ok = v128_and(ok, i32x4_eq(tl, v128_load(m.floor.add(s) as *const v128)));
    // (The committed step is per base tick: dk of them this step.)
    let mut vx = v128_load(m.cvx.add(s) as *const v128);
    let mut vy = v128_load(m.cvy.add(s) as *const v128);
    if m.dk > 1 {
        let k = f32x4_splat(m.dk as f32);
        vx = f32x4_mul(vx, k);
        vy = f32x4_mul(vy, k);
    }
    let nx = i32x4_add(x, q8x4(vx));
    let ny = i32x4_add(y, q8x4(vy));
    let stay = v128_and(i32x4_eq(tile4(m, nx), gx), i32x4_eq(tile4(m, ny), gy));
    #[cfg(feature = "dbgc")]
    {
        // (26 dead energy / absent from the index, 27 committed tile not
        // this one, 28 floor tile not this one.)
        let alive = v128_and(f32x4_gt(v128_load(m.en.add(s) as *const v128), f32x4_splat(0.0)), v128_not(i32x4_eq(v128_load(m.sep.add(s) as *const v128), i32x4_splat(p.absent as u32 as i32))));
        let a = cand1 & !(i32x4_bitmask(alive) as i32);
        dbgc!(m, 26, a.count_ones());
        let c = cand1 & !a & !(i32x4_bitmask(i32x4_eq(tl, v128_load(m.ctl.add(s) as *const v128))) as i32);
        dbgc!(m, 27, c.count_ones());
        let f = cand1 & !a & !c & !(i32x4_bitmask(i32x4_eq(tl, v128_load(m.floor.add(s) as *const v128))) as i32);
        dbgc!(m, 28, f.count_ones());
        let c2 = i32x4_bitmask(ok) as i32;
        dbgc!(m, 22, (cand1 & !c2).count_ones());
        let c3 = c2 & i32x4_bitmask(v128_or(stay, i32x4_ne(v128_and(fl, i32x4_splat(32)), zero))) as i32;
        dbgc!(m, 23, (c2 & !c3).count_ones());
    }
    let fly4 = i32x4_ne(v128_and(fl, i32x4_splat(32)), zero);
    // (Ground lanes stepping into another tile: taken when that tile is open
    // to them (step_flow's commit without a slide, flow_slide 0), checked
    // one by one: few lanes cross on a tick.)
    // (Several base ticks a step: no crossing here, move_flow steers it.)
    let cross = if m.dk > 1 { 0 } else { i32x4_bitmask(v128_andnot(ok, v128_or(stay, fly4))) as i32 };
    ok = v128_and(ok, v128_or(stay, fly4));
    let mut bits = i32x4_bitmask(ok) as i32;
    if cross != 0 {
        let ngx: [i32; 4] = core::mem::transmute(tile4(m, nx));
        let ngy: [i32; 4] = core::mem::transmute(tile4(m, ny));
        for l in 0..4usize {
            if cross & (1 << l) == 0 || ngx[l] < 0 || ngx[l] >= m.w || ngy[l] < 0 || ngy[l] >= m.h {
                continue;
            }
            let np = rd(m.npr, s + l) as usize;
            let wl = if np < NAV_PROFILES && !m.nav.get_unchecked(np).walls.is_null() { m.nav.get_unchecked(np).walls } else { m.wall };
            if rd(wl, (ngy[l] * m.w + ngx[l]) as usize) == 0 {
                bits |= 1 << l;
                dbgc!(m, 30);
            }
        }
    }
    #[cfg(feature = "dbgc")]
    let cand4 = bits;
    if bits == 0 {
        return 0;
    }
    // The flow field as made (its generation, destination, ready): once for
    // the four when they follow the same field (an army's slots mostly
    // do), else one by one.
    let fl4 = v128_load(m.flow.add(s) as *const v128);
    let fg4 = v128_load(m.fgen.add(s) as *const v128);
    let dk4 = v128_load(m.dest.add(s) as *const v128);
    let same = |v: v128| i32x4_all_true(i32x4_eq(v, i32x4_shuffle::<0, 0, 0, 0>(v, v)));
    let field_ok = |fid: i32, fgen: i32, dk: i32| -> bool {
        if fid == NAV_ATLAS_FID {
            return true;
        }
        let wide = fid >= 4194304;
        let did = if wide { fid - 4194304 } else { fid };
        let (fmeta, fmn) = if wide { (m.fmw, m.fmwn) } else { (m.fmn, m.fmnn) };
        let dm = (did.max(0)) as usize * 8;
        fid >= 0 && !fmeta.is_null() && dm + 7 < fmn && rd(fmeta, dm + 6) == fgen && rd(fmeta, dm + 1) == dk && rd(fmeta, dm + 7) == 1
    };
    if same(fl4) && same(fg4) && same(dk4) {
        if !field_ok(i32x4_extract_lane::<0>(fl4), i32x4_extract_lane::<0>(fg4), i32x4_extract_lane::<0>(dk4)) {
            dbgc!(m, 24, cand4.count_ones());
            return 0;
        }
    } else {
        for l in 0..4usize {
            if bits & (1 << l) == 0 {
                continue;
            }
            let q = s + l;
            if !field_ok(rd(m.flow, q), rd(m.fgen, q), rd(m.dest, q)) {
                bits &= !(1 << l);
            }
        }
    }
    #[cfg(feature = "dbgc")]
    dbgc!(m, 24, (cand4 & !bits).count_ones());
    // The floor's once-a-second look (step_flow's: a trap may have been
    // built under a unit standing in its tile), here rather than ending the
    // steady window: a lane on its second's tick standing on a hostile
    // structure goes to step_slot.
    if bits != 0 && p.tr > 0 {
        let due = i32x4_bitmask(i32x4_lt(urem4(i32x4_add(ti, v128_load(m.id.add(s) as *const v128)), p.tr), i32x4_splat(m.dk))) as i32 & bits;
        if due != 0 {
            let tla: [i32; 4] = core::mem::transmute(tl);
            for l in 0..4usize {
                if due & (1 << l) != 0 {
                    let code = rd(m.sc, tla[l] as usize) as i32;
                    if code != -1 && code != rd(m.own, s + l) as i32 {
                        bits &= !(1 << l);
                        dbgc!(m, 29);
                    }
                }
            }
        }
    }
    if bits == 0 {
        return 0;
    }
    // The step (lanes of `bits`).
    let mk = i32x4_ne(v128_and(i32x4_splat(bits), i32x4(1, 2, 4, 8)), zero);
    let st = |pp: *mut v128, v: v128| {
        mv_store32(m,pp,v,mk);
    };
    st(m.px.add(s) as *mut v128, x);
    st(m.py.add(s) as *mut v128, y);
    // (The velocity is the committed step's after its first tick: stored
    // only when a lane's differs, so a steady stepper's lines stay clean.)
    let pvx = m.vx.add(s) as *mut v128;
    let pvy = m.vy.add(s) as *mut v128;
    let ovx = v128_load(pvx);
    let ovy = v128_load(pvy);
    if v128_any_true(v128_and(mk, v128_or(v128_xor(ovx, vx), v128_xor(ovy, vy)))) {
        mv_store32(m,pvx,vx,mk);
        mv_store32(m,pvy,vy,mk);
    }
    let (nx,ny)=checked_positions4(m,s,nx,ny,bits);
    let stay=v128_and(i32x4_eq(tile4(m,nx),gx),i32x4_eq(tile4(m,ny),gy));
    st(m.x.add(s) as *mut v128, nx);
    st(m.y.add(s) as *mut v128, ny);
    // (Bytes of the four lanes at once: d0 0, spent 1 when it left its
    // tile, out 3 then else 1, the step mark.)
    let gone = v128_not(stay);
    *mvd |= (i32x4_bitmask(v128_or(i32x4_ne(nx, x), i32x4_ne(ny, y))) as i32) & bits;
    if (m.d0.add(s) as *const u32).read_unaligned() != 0 {
        mv_store8(m,m.d0.add(s), zero, mk);
    }
    mv_store8(m,m.spent.add(s), v128_and(gone, one), mk);
    mv_store8(m,m.out.add(s), v128_bitselect(i32x4_splat(3), one, gone), mk);
    mv_store8(m,m.stept.add(s - m.stepbase), one, mk);
    bits
}

/// Stores the low bytes of four i32 lanes at p..p + 4 where `mk` is set.
#[inline(always)]
unsafe fn st_u8x4(p: *mut u8, v: v128, mk: v128) {
    let b = i8x16_narrow_i16x8(i16x8_narrow_i32x4(v, v), i16x8_narrow_i32x4(v, v));
    let k = i8x16_narrow_i16x8(i16x8_narrow_i32x4(mk, mk), i16x8_narrow_i32x4(mk, mk));
    let old = v128_load32_zero(p as *const u32);
    let r = v128_bitselect(b, old, k);
    (p as *mut u32).write_unaligned(i32x4_extract_lane::<0>(r) as u32);
}

#[inline(always)]
unsafe fn mv_store32(m:&Mv,p:*mut v128,v:v128,mask:v128) {
    if m.span_n==4 {
        v128_store(p,v128_bitselect(v,v128_load(p),mask));
    }else{
        let bits=i32x4_bitmask(mask);
        if m.span_n==2 && bits&3==3 {
            (p as *mut u64).write_unaligned(i64x2_extract_lane::<0>(v) as u64);return;
        }
        let values:[u32;4]=core::mem::transmute(v);
        for l in 0..m.span_n {if bits&(1<<l)!=0 {(p as *mut u32).add(l).write_unaligned(*values.get_unchecked(l));}}
    }
}
#[inline(always)]
unsafe fn mv_store8(m:&Mv,p:*mut u8,v:v128,mask:v128) {
    if m.span_n==4 {st_u8x4(p,v,mask);}else{
        let values:[i32;4]=core::mem::transmute(v);let bits=i32x4_bitmask(mask);
        if m.span_n==2 && bits&3==3 {
            (p as *mut u16).write_unaligned((i32x4_extract_lane::<0>(v) as u8 as u16)|((i32x4_extract_lane::<1>(v) as u8 as u16)<<8));return;
        }
        for l in 0..m.span_n {if bits&(1<<l)!=0 {*p.add(l)=*values.get_unchecked(l) as u8;}}
    }
}

/// v % d for four non-negative i32 lanes (d > 0), exact (f64 quotients).
#[inline(always)]
fn urem4(v: v128, d: i32) -> v128 {
    let df = f64x2_splat(d as f64);
    let lo = f64x2_floor(f64x2_div(f64x2_convert_low_i32x4(v), df));
    let hi = f64x2_floor(f64x2_div(f64x2_convert_low_i32x4(i32x4_shuffle::<2, 3, 0, 1>(v, v)), df));
    let q = i32x4_shuffle::<0, 1, 4, 5>(i32x4_trunc_sat_f64x2_zero(lo), i32x4_trunc_sat_f64x2_zero(hi));
    i32x4_sub(v, i32x4_mul(q, i32x4_splat(d)))
}

/// Slots s..s + 4 (lanes not in `done`) parked before their wake tick
/// (mvOn 2): step_slot's stand four a lane. A lane takes it when the slot
/// is parked, no brain instruction, before its wake, no look this tick
/// (flags 1, 8 never; 16 not on its aggro tick; 4, the builder's watch,
/// left to step_slot), alive and indexed, its owner a player, in the map on
/// its floor's tile, not on its floor's look tick. Then: stands (prev =
/// position), output 1, its step mark. Returns the lanes taken.
#[cfg_attr(not(feature = "prof"), inline(always))]
#[cfg_attr(feature = "prof", inline(never))]
unsafe fn park4(m: &Mv, p: &StepP, s: usize, done: i32) -> i32 {
    // Every lane needs a floor look at this coarse step. The vector park
    // predicate below is then always false, independent of unit state.
    if p.tr>0&&m.dk>=p.tr{return 0;}
    let zero = i32x4_splat(0);
    let one = i32x4_splat(1);
    let on = ld_u8x4(m.on.add(s));
    let mut ok = v128_and(i32x4_eq(on, i32x4_splat(2)), i32x4_eq(v128_and(i32x4_splat(done), i32x4(1, 2, 4, 8)), zero));
    if !v128_any_true(ok) {
        return 0;
    }
    if BRAIN {
        ok = v128_and(ok, i32x4_eq(ld_u8x4(m.cmode.add(s)), zero));
    }
    let t = i32x4_splat(m.t);
    ok = v128_and(ok, i32x4_lt(t, v128_load(m.wake.add(s) as *const v128)));
    let fl = ld_u8x4(m.fl.add(s));
    ok = v128_and(ok, i32x4_eq(v128_and(fl, i32x4_splat(13)), zero));
    let tw = i32x4_add(t, v128_load(m.id.add(s) as *const v128));
    // (Aggro parks: not on their look tick, (t + id) & 3 with four ticks.)
    ok = v128_andnot(ok, v128_and(i32x4_ne(v128_and(fl, i32x4_splat(16)), zero), i32x4_lt(v128_and(tw, i32x4_splat(3)), i32x4_splat(m.dk))));
    ok = v128_and(ok, i32x4_eq(ld_u8x4(m.dead.add(s)), zero));
    if !v128_any_true(ok) {
        return 0;
    }
    ok = v128_and(ok, f32x4_gt(v128_load(m.en.add(s) as *const v128), f32x4_splat(0.0)));
    ok = v128_and(ok, v128_not(i32x4_eq(v128_load(m.sep.add(s) as *const v128), i32x4_splat(p.absent as u32 as i32))));
    let own = i32x4_extend_low_i16x8(i16x8_extend_low_i8x16(v128_load32_zero(m.own.add(s) as *const u32)));
    ok = v128_and(ok, v128_and(i32x4_ge(own, zero), i32x4_lt(own, i32x4_splat(p.players))));
    let x = v128_load(m.x.add(s) as *const v128);
    let y = v128_load(m.y.add(s) as *const v128);
    let gx = tile4(m, x);
    let gy = tile4(m, y);
    ok = v128_and(ok, v128_and(i32x4_ge(gx, zero), i32x4_lt(gx, i32x4_splat(m.w))));
    ok = v128_and(ok, v128_and(i32x4_ge(gy, zero), i32x4_lt(gy, i32x4_splat(m.h))));
    let tl = i32x4_add(i32x4_mul(gy, i32x4_splat(m.w)), gx);
    ok = v128_and(ok, i32x4_eq(tl, v128_load(m.floor.add(s) as *const v128)));
    if !v128_any_true(ok) {
        return 0;
    }
    if p.tr > 0 {
        ok = v128_and(ok, i32x4_ge(urem4(v128_and(tw, i32x4_splat(0x7fffffff)), p.tr), i32x4_splat(m.dk)));
    }
    let bits = i32x4_bitmask(ok) as i32;
    if bits == 0 {
        return 0;
    }
    let st = |pp: *mut v128, v: v128| {
        mv_store32(m,pp,v,ok);
    };
    st(m.px.add(s) as *mut v128, x);
    st(m.py.add(s) as *mut v128, y);
    mv_store8(m,m.d0.add(s), zero, ok);
    mv_store8(m,m.out.add(s), one, ok);
    mv_store8(m,m.stept.add(s - m.stepbase), one, ok);
    bits
}

/// Slots s..s + 4 (lanes not in `done`) the kernel does not move (mvOn 0:
/// Unit.update's, or dead; no brain instruction): what the scalar passes
/// write for them, four a lane (dead0 the dead column, output 0). Returns
/// the lanes taken.
#[cfg_attr(not(feature = "prof"), inline(always))]
#[cfg_attr(feature = "prof", inline(never))]
unsafe fn idle4(m: &Mv, s: usize, done: i32) -> i32 {
    if m.span_n==1&&*m.on.add(s)!=0{return 0;}
    let zero = i32x4_splat(0);
    let mut ok = v128_and(i32x4_eq(ld_u8x4(m.on.add(s)), zero), i32x4_eq(v128_and(i32x4_splat(done), i32x4(1, 2, 4, 8)), zero));
    if BRAIN {
        ok = v128_and(ok, i32x4_eq(ld_u8x4(m.cmode.add(s)), zero));
    }
    // (A live unit that is not a worker goes to the controller, one by one.)
    if !m.holdf.is_null() {
        ok = v128_and(ok, v128_or(i32x4_ne(ld_u8x4(m.dead.add(s)), zero), i32x4_ne(ld_u8x4(m.iswk.add(s)), zero)));
    }
    let bits = i32x4_bitmask(ok) as i32;
    if bits == 0 {
        return 0;
    }
    mv_store8(m,m.d0.add(s), ld_u8x4(m.dead.add(s)), ok);
    mv_store8(m,m.out.add(s), zero, ok);
    bits
}

/// One slot of SIM_KERNEL_MOVE_STEP.
#[cfg_attr(not(feature = "prof"), inline(always))]
#[cfg_attr(feature = "prof", inline(never))]
unsafe fn step_slot(m: &Mv, p: &StepP, s: usize) {
    let t = m.t;
    let (tr, w, h, itile, q, iq, bsz, absent, boxsteps, wcheck, acq_t, wkwatch, stride, plane, players) =
        (p.tr, m.w, m.h, m.itile, p.q, p.iq, p.bsz, p.absent, p.boxsteps, p.wcheck, p.acq_t, p.wkwatch, p.stride, p.plane, p.players);
    let dead = rd(m.dead, s);
    if rd(m.d0, s) != dead { wr(m.d0, s, dead); }
    if BRAIN && rd(m.cmode, s) != 0 {
        return;
    }
    if !m.holdf.is_null() && rd(m.cmd, s) == CMD_ATK && rd(m.iswk, s) == 0 {
        return;
    }
    let on = rd(m.on, s);
    // (A builder on its way back: its watchdog sample on its watch tick.)
    if on == 1 && rd(m.wk, s) == 3 && rem64_f(tsum(t, rd(m.id, s)), wkwatch) < m.dk as i64 && { let w = wki(m, s); rd(m.wkwx, w) == rd(m.wkwx, w) } {
        wk_watch(m, s, t);
    }
    if on == 2 {
        // A parked unit before its wake tick: stands.
        let fl = rd(m.fl, s);
        let id = rd(m.id, s);
        let ts = tsum(t, id);
        let tw = t.wrapping_add(id);
        if t >= rd(m.wake, s) || (fl & 9) != 0 || ((fl & 16) != 0 && (rem64_f(ts, acq_t) < m.dk as i64 || (tw & 3) < m.dk)) {
            return;
        }
        if (fl & 4) != 0 && rem64_f(ts, wkwatch) < m.dk as i64 {
            wk_watch(m, s, t);
        }
        if !(rd(m.en, s) > 0.0) || rd(m.sep, s) as f64 == absent || dead != 0 {
            return;
        }
        let owner = rd(m.own, s);
        let x = rd(m.x, s);
        let y = rd(m.y, s);
        let gx = floor(x * itile);
        let gy = floor(y * itile);
        if !(owner >= 0 && owner < players) || !(inb(gx, w) && inb(gy, h)) {
            return;
        }
        let tl = gy as i32 * w + gx as i32;
        if rd(m.floor, s) != tl || irem_f(tw, tr) < m.dk {
            let code = rd(m.sc, tl as usize) as i32;
            if code != -1 && code != owner && floor_hit(m, s, tl) {
                return;
            }
            wr(m.floor, s, tl);
        }
        wr(m.px, s, x);
        wr(m.py, s, y);
        wr(m.out, s, 1);
        wr(m.stept, s - m.stepbase, 1);
        return;
    }
    if on != 1 || (rd(m.fl, s) & 64) == 0 {
        return;
    }
    // A flow unit's committed step (_simStepFlow).
    step_flow(m, s, t, tr, w, h, itile, q, iq, bsz, absent, boxsteps, wcheck, acq_t, stride, plane, players);
}

#[cfg_attr(not(feature = "prof"), inline(always))]
#[cfg_attr(feature = "prof", inline(never))]
unsafe fn step_flow(
    m: &Mv, s: usize, t: i32, tr: i32, w: i32, h: i32, itile: f64, q: f64, iq: f64, bsz: f64, absent: f64, boxsteps: i32, wcheck: i32, acq_t: i64, stride: i64,
    plane: i64, players: i32,
) {
    let f = rd(m.fl, s);
    let id = rd(m.id, s);
    let dk = rd(m.dest, s);
    if rd(m.cd, s) != dk || t - rd(m.ct, s) >= rd(m.cn, s) as i32 {
        return;
    }
    if !(rd(m.en, s) > 0.0) || rd(m.sep, s) as f64 == absent || rd(m.dead, s) != 0 {
        return;
    }
    let owner = rd(m.own, s);
    let x = rd(m.x, s);
    let y = rd(m.y, s);
    let gxf = floor(x * itile);
    let gyf = floor(y * itile);
    if !(owner >= 0 && owner < players) || !(inb(gxf, w) && inb(gyf, h)) {
        return;
    }
    let (gx, gy) = (gxf as i32, gyf as i32);
    let tl = gy * w + gx;
    if tl == dk || tl != rd(m.ctl, s) {
        return;
    }
    let tw = t.wrapping_add(id);
    if rd(m.floor, s) != tl || irem_f(tw, tr) < m.dk {
        let code = rd(m.sc, tl as usize) as i32;
        if code != -1 && code != owner && floor_hit(m, s, tl) {
            return;
        }
    }
    let ts = tsum(t, id);
    let at = rd(m.at, s);
    if rd(m.wk, s) == 1 && irem_f(tw, wcheck) < m.dk && !(rd(m.wtc, s) > 0) {
        return;
    }
    let fid = rd(m.flow, s);
    if fid != NAV_ATLAS_FID {
        let wide = fid >= 4194304;
        let did = if wide { fid - 4194304 } else { fid };
        let (fmeta, fmn) = if wide { (m.fmw, m.fmwn) } else { (m.fmn, m.fmnn) };
        if !(fid >= 0) || fmeta.is_null() {
            return;
        }
        let dm = did as usize * 8;
        if dm + 7 >= fmn || rd(fmeta, dm + 6) != rd(m.fgen, s) || rd(fmeta, dm + 1) != dk || rd(fmeta, dm + 7) != 1 {
            return;
        }
    }
    if t < rd(m.rdy, s) {
        return;
    }
    let mut vx = rd(m.cvx, s) * m.dkf;
    let mut vy = rd(m.cvy, s) * m.dkf;
    let sgx = floor((x + vx) * itile);
    let sgy = floor((y + vy) * itile);
    // (Several base ticks a step leaving the tile: steered by move_flow.)
    if m.dk > 1 && (sgx != gx as f64 || sgy != gy as f64) {
        return;
    }
    if (f & 32) == 0 && (sgx != gx as f64 || sgy != gy as f64) {
        let np = rd(m.npr, s) as usize;
        let wl = if np < NAV_PROFILES && !m.nav.get_unchecked(np).walls.is_null() { m.nav.get_unchecked(np).walls } else { m.wall };
        let sl = flow_slide(wl, w, h, gx, gy, sgx, sgy);
        if sl != 0 {
            if sl & 1 != 0 {
                vx = 0.0;
            }
            if sl & 2 != 0 {
                vy = 0.0;
            }
            wr(m.cd, s, -1);
            if !m.steady.is_null() { wr(m.steady, s, 0); }
        }
    }
    commit_step(m, s, x, y, vx, vy, gx, gy, tl, q, iq);
    wr(m.stept, s - m.stepbase, 1);
    // (Its window again, to the step's end or its next look: the steady step
    // takes the next ticks. Not after a slide: the step ends.)
    if !m.steady.is_null() && rd(m.cd, s) == dk {
        let end = rd(m.ct, s).wrapping_add(rd(m.cn, s) as i32);
        wr(m.steady, s, if end > t + 1 { steady_until(m, s, t, end, f, tr, acq_t, wcheck) } else { 0 });
    }
}

/// The look's box clamped to the map, as the kernels clamp it.
#[inline(always)]
fn clamp_box(x0: f64, y0: f64, x1: f64, y1: f64, w: i32, h: i32) -> (f64, f64, f64, f64) {
    (
        if x0 < 0.0 { 0.0 } else { x0 },
        if y0 < 0.0 { 0.0 } else { y0 },
        if x1 >= w as f64 { (w - 1) as f64 } else { x1 },
        if y1 >= h as f64 { (h - 1) as f64 } else { y1 },
    )
}

/// The params of SIM_KERNEL_MOVE (from F).
struct MoveP {
    tr: i32,
    q: f64,
    iq: f64,
    bc: i64,
    br: i64,
    players: i32,
    bsz: f64,
    absent: f64,
    win: i32,
    boxsteps: i32,
    wver: i32,
    pad: f64,
    wcheck: i32,
    wknp: i32,
    wktypes: i32,
    wkrw: i32,
    wkrh: i32,
    wkr: i32,
    wkper: i32,
    wkhgen: i32,
    wkwatch: i64,
    wbw: i32,
    area_ver: i32,
    acq_t: i64,
    acq_stamp: i32,
    step_ran: bool,
    /// (The chunk's first slot and index: its attack list.)
    s0: usize,
    chunk: usize,
}

/// The block's flow direction: the desired velocities of the first unit of
/// each tile that walks the flow (summed), which sets the sweep's direction.
#[cfg_attr(feature="prof",inline(never))]
unsafe fn leader_dir(m:&Mv,a:*const i32,x0:i32,x1:i32,y0:i32,y1:i32,cw:i32,epoch:i32)->(f64,f64) {
    let ptr=|i:usize|waddr(*a.add(512+i) as u32) as *const i32;
    let mut dx=0.0;let mut dy=0.0;
    for cy in y0..y1 {for cx in x0..x1 {
        let key=(cy*cw+cx) as usize;
        if *ptr(27).add(key)!=epoch || *ptr(26).add(key)==0 {continue;}
        let slot=*ptr(24).add(*ptr(25).add(key) as usize);
        if slot>=0 && (if m.traffic_mode==0{rd(m.on,slot as usize)==6}else{
            let s=slot as usize;
            rd(m.on,s)==1 && rd(m.fl,s)&64!=0 && (!BRAIN||rd(m.cmode,s)&3==0)
                && rd(m.cd,s)==rd(m.dest,s) && rd(m.ctl,s)==key as i32
        }) {
            dx+=rd(m.cvx,slot as usize);dy+=rd(m.cvy,slot as usize);
        }
    }}
    (dx,dy)
}
/// SIM_KERNEL_MOVE over slots s0..end (chunk: the epilogue's lists), four
/// slots at a time, each unit once: a flow unit's steady step (step4) and a
/// combat brain instruction (combat4) four a lane; the other lanes one by
/// one (step_slot, then move_pre / move_flow / move_path); then the group's
/// separation pushes (push4) and, for the lanes with anything left (another
/// tile, a node step's charge, a push leaving its tile, a listing), the
/// epilogue (epi_slot). (Units' passes read nothing another unit's write
/// in the same tick: the order between units does not show.)
unsafe fn move_job(a: u32, s0: i32, end: i32, chunk: i32, spatial:bool) {
    let a = waddr(a) as *const i32;
    wr(a as *mut i32, 299, s0);
    core::ptr::write_bytes(a.add(300) as *mut u8, 0, if spatial {4}else{(end-s0).max(0) as usize});
    let mut m = Mv::load(a);
    let mut step_cache = core::mem::MaybeUninit::<[AtlasStepEntry; ATLAS_STEP_CACHE_ENTRIES]>::uninit();
    if !spatial {
        m.nav_step_cache = step_cache.as_mut_ptr() as *mut AtlasStepEntry;
        core::ptr::write_bytes(m.nav_step_cache, 0, ATLAS_STEP_CACHE_ENTRIES);
    }
    let f = (a as usize + 4096) as *const f64;
    let q = rd(f, 8);
    let mut p = MoveP {
        tr: to_i32(rd(f, 3)),
        q,
        iq: 1.0 / q,
        bc: to_i32(rd(f, 9)) as i64,
        br: to_i32(rd(f, 10)) as i64,
        players: to_i32(rd(f, 11)),
        bsz: rd(f, 14),
        absent: rd(f, 15),
        win: to_i32(rd(f, 16)),
        boxsteps: to_i32(rd(f, 17)),
        wver: to_i32(rd(f, 19)),
        pad: rd(f, 20),
        wcheck: to_i32(rd(f, 21)),
        wknp: to_i32(rd(f, 22)),
        wktypes: to_i32(rd(f, 23)),
        wkrw: to_i32(rd(f, 24)),
        wkrh: to_i32(rd(f, 25)),
        wkr: to_i32(rd(f, 26)),
        wkper: js_max(1.0, to_i32(rd(f, 27)) as f64) as i32,
        wkhgen: to_i32(rd(f, 28)),
        wkwatch: js_max(1.0, to_i32(rd(f, 29)) as f64) as i64,
        wbw: to_i32(rd(f, 30)),
        area_ver: to_i32(rd(f, 32)),
        acq_t: js_max(1.0, to_i32(rd(f, 38)) as f64) as i64,
        acq_stamp: to_i32(rd(f, 39)),
        step_ran: rd(f, 46) == 1.0,
        s0: s0.max(0) as usize,
        chunk: chunk.max(0) as usize,
    };
    let sp = step_params(f);
    if spatial {
        let ptr=|i:usize|waddr(*a.add(512+i) as u32) as *const i32;
        let cfg=ptr(33);let bw=*cfg.add(5);let bh=*cfg.add(6);let block=*cfg.add(7);
        let phase=rd(f,4) as i32;let halfw=(bw+1)>>1;
        // (36: the phase's blocks with units, heaviest first (occ.jobs, see
        // sim_occupancy.js occupancyJobs: [0..4) the phases' starts, [4..8)
        // their counts, then the blocks): the empty blocks are not run, the
        // caller zeroes their outputs and the traffic inputs. Else every
        // block of the phase's colour by the chunk.)
        let listed=*a.add(512+36)!=0;
        let (bx,by)=if listed{let jl=ptr(36);let j=*jl.add((8+*jl.add(phase as usize)+chunk) as usize);(irem(j,bw),idiv(j,bw))}
            else{(irem(chunk,halfw)*2+(phase&1),idiv(chunk,halfw)*2+(phase>>1))};
        if bx>=bw || by>=bh {return;}
        let job=by*bw+bx;let base=*ptr(32).add(job as usize) as usize;
        p.chunk=job as usize;p.s0=base;
        let mut grid=super::occ::MoveGrid::load(a,bx,by,job);grid.reset();
        let mut lcbuf=[0i32;2*18*18];grid.cache_chunks(lcbuf.as_mut_ptr(),18*18,block);
        m.occ=&grid;
        let mut swbuf=[0i32;SWAP_CAP];let mut swn=0i32;m.swl=swbuf.as_mut_ptr();m.swn=&mut swn;
        // The units the second pass looks at (in the order the first met
        // them), at the job's range of occ.work: out bit 7 marks one listed.
        let wk=if *a.add(512+35)==0{core::ptr::null_mut()}else{(ptr(35) as *mut i32).add(base)};let mut wn=0usize;
        // (37: the first stage's marks, mark_need; a unit not marked in a cell
        // without a push record is passed over.)
        let need=if *a.add(512+37)==0{core::ptr::null()}else{ptr(37)};
        let mut ep=epi_begin(&m,f,job,0,1);ep.pb=base;
        // (The attacks are listed by the first stage's slot chunks.)
        let cw=*cfg.add(9);let ch=*cfg.add(10);let epoch=*cfg.add(11);
        let x0=bx*block;let x1=((bx+1)*block).min(cw);
        let y0=by*block;let y1=((by+1)*block).min(ch);
        if !listed{super::traffic::clear_job(m.traffic,bx*block* *cfg.add(15)* *cfg.add(14),by*block* *cfg.add(15)* *cfg.add(14),
            (bx+1)*block* *cfg.add(15)* *cfg.add(14),(by+1)*block* *cfg.add(15)* *cfg.add(14));}
        // Leaders vacate space before followers claim it. Sample cached
        // desired velocities (actual velocity is zero in a jam), bounded
        // to one unit per tile; no sorting or per-unit allocation.
        let (dx,dy)=leader_dir(&m,a,x0,x1,y0,y1,cw,epoch);
        for yi in 0..y1-y0 {let cy=if dy>0.0{y1-1-yi}else{y0+yi};
        for xi in 0..x1-x0 {let cx=if dx>0.0{x1-1-xi}else{x0+xi};
            let key=(cy*cw+cx) as usize;if *ptr(27).add(key)!=epoch {continue;}
            let mut i=*ptr(25).add(key);let end=i+*ptr(26).add(key);
            // (Standing units here may give way: last step's pushes at the tile.)
            let pushed=traffic_deferred(&m)&&super::traffic::push_at(m.traffic,cx,cy);
            while i<end {
                let slot=*ptr(24).add(i as usize);
                if slot>=0 && (need.is_null()||pushed||*need.add(slot as usize*4+2)>>24!=0) {
                    let s=slot as usize;
                    resolve_slot(&m,s);
                    dbgc!(m,86);
                    #[cfg(feature="dbgc")]
                    {
                        if *m.out.add(s)>1{dbgc!(m,82);}
                        if *m.spent.add(s)!=0{dbgc!(m,83);}
                        if traffic_deferred(&m)&&pushed{dbgc!(m,84);}
                        if traffic_deferred(&m)&&walker_short(&m,s){dbgc!(m,85);}
                    }
                    if !wk.is_null()&&(*m.out.add(s)>1||*m.spent.add(s)!=0||(traffic_deferred(&m)&&(pushed||walker_short(&m,s)))){
                        *wk.add(wn)=slot;wn+=1;*m.out.add(s)|=128;
                    }
                }
                i+=1;
            }
        }}
        {
            // (Idle units a mover swapped with: their new tile for the index,
            // listed by their epilogue below. Their own visit above, if it
            // came after the swap, cleared their output.)
            for k in 0..swn as usize{let b=*swbuf.as_ptr().add(k) as usize;
                let listed=*m.out.add(b)&128;
                let gx=floor(rd(m.x,b)*m.itile) as i32;let gy=floor(rd(m.y,b)*m.itile) as i32;
                if gy*m.w+gx!=rd(m.spt,b){wr(m.out,b,3|listed);}else if *m.out.add(b)&127==0{wr(m.out,b,1|listed);}
                if listed==0&&!wk.is_null(){*wk.add(wn)=b as i32;wn+=1;*m.out.add(b)|=128;}
            }
            // (Swaps made from here on, walkers passing each other in the
            // second pass: their partners' tiles go to the index after it.)
            let sw0=swn as usize;
            // All intentions/ordinary moves in this ownership block finish
            // first. Resolve residual pressure only after leaders have had
            // their turn, then publish each unit's epilogue exactly once.
            m.shared_hot=core::ptr::null();m.span_n=1;
            let yield_on=traffic_deferred(&m);
            if !wk.is_null(){
                for k in 0..wn{let s=*wk.add(k) as usize;
                    *m.out.add(s)&=127;
                    if yield_on{traffic_yield(&m,s);}
                    if *m.out.add(s)>1||*m.spent.add(s)!=0{epi_slot(&m,f,&mut ep,s,false);}
                }
            }else{
            for yi in 0..y1-y0{let cy=if dy>0.0{y1-1-yi}else{y0+yi};
            for xi in 0..x1-x0{let cx=if dx>0.0{x1-1-xi}else{x0+xi};
                let key=(cy*cw+cx) as usize;if *ptr(27).add(key)!=epoch{continue;}
                let start=*ptr(25).add(key);let end=start+*ptr(26).add(key);
                for i in start..end{let slot=*ptr(24).add(i as usize);if slot<0{continue;}let s=slot as usize;
                    if yield_on{traffic_yield(&m,s);}
                    if *m.out.add(s)>1||*m.spent.add(s)!=0{epi_slot(&m,f,&mut ep,s,false);}
                }
            }}
            }
            // The partners of the second pass's swaps: their own epilogue may
            // have run before they were moved (the index then kept their old
            // tile until they next crossed one). epi_slot's index update is a
            // no-op for a slot already at its tile.
            for k in sw0..swn as usize{let b=*swbuf.as_ptr().add(k) as usize;
                let gx=floor(rd(m.x,b)*m.itile) as i32;let gy=floor(rd(m.y,b)*m.itile) as i32;
                if gy*m.w+gx==rd(m.spt,b){continue;}
                let o=*m.out.add(b)&127;
                wr(m.out,b,3);epi_slot(&m,f,&mut ep,b,false);
                if o>3{wr(m.out,b,o);}
            }
        }
        epi_end(&m,&ep,job);
        let _=(&p,&sp);
    }else{
        // (P[4] -1: the occupancy's first stage: every unit's step, as it
        // wants it, from its slot chunk (the vector paths), its position the
        // one it wants; the occupancy jobs then resolve the positions against
        // the footprints and run the epilogue: mv_move_occupancy.)
        let intent=rd(f,4)<0.0;
        if !m.hita.is_null(){wr(m.hitc,p.chunk,0);if !m.hsc.is_null(){wr(m.hsc,p.chunk,0);}}
        let b0=s0.max(0) as usize;let e=end.max(0) as usize;
        let mut ep=if intent{epi_none()}else{epi_begin(&m,f,chunk,b0,e)};
        move_span(&mut m,f,&p,&sp,&mut ep,b0,e);
        if intent&&!m.need.is_null(){mark_need(&m,b0,e);}
        if !intent{epi_end(&m,&ep,chunk);}
    }
}
/// The first stage's marks for the second (occ.need), a byte a slot in slot
/// order: a unit whose wanted position is not its footprint's (resolve_slot
/// moves it), with an epilogue (out > 1, spent) or a flow walker (its short
/// step's retry, walker_short). The second stage's visit of any other unit
/// did nothing but read its columns (~6 cache lines a unit in index order;
/// idle armies were most of its time), unless its cell holds a push record:
/// then every unit there is visited, as before.
#[cfg_attr(feature="prof",inline(never))]
unsafe fn mark_need(m:&Mv,b0:usize,e:usize){
    let occ=!m.orec.is_null();
    for s in b0..e{
        let r=if occ{m.orec.add(s*4)}else{core::ptr::null_mut()};
        let moved=!occ||((*r.add(2)>>16)&255!=0&&(*(m.x.add(s) as *const i32)!=*r||*(m.y.add(s) as *const i32)!=*r.add(1)));
        let mark=(moved||*m.out.add(s)>1||*m.spent.add(s)!=0||*m.on.add(s)==1) as i32;
        if occ{*r.add(2)=(*r.add(2)&0x00ffffff)|(mark<<24);}
    }
}
/// A flow unit left short of its step (its second-pass retry may move it:
/// traffic_yield's walker branch, the same test).
#[inline(always)]
unsafe fn walker_short(m:&Mv,s:usize)->bool{
    if *m.on.add(s)!=1||rd(m.fl,s)&64==0||(BRAIN&&rd(m.cmode,s)!=0){return false;}
    let (hx,hy)=(rd(m.cvx,s),rd(m.cvy,s));let hl2=hx*hx+hy*hy;
    if !(hl2>0.0){return false;}
    let dx=rd(m.x,s)-rd(m.x0,s);let dy=rd(m.y,s)-rd(m.y0,s);
    // (Along its heading, as traffic_yield measures it.)
    let along=(dx*hx+dy*hy)/sqrt(hl2);
    along<=sqrt(hl2)*m.dkf*0.75
}
/// The occupancy's second stage for slot s: the position its step wanted
/// (unit.x / y, the first stage's) against the exclusive footprints, as the
/// step resolved it itself before: the pressure's steering, shoulders, swaps,
/// pushes. Its tile flags (out 1 / 3, spent) for where it ended up.
#[inline(always)]
unsafe fn resolve_slot(m:&Mv,s:usize){
    let g=&*m.occ;
    if !g.active(s){return;}
    let (ox,oy)=g.pos(s);
    let nx=*(m.x.add(s) as *const i32);let ny=*(m.y.add(s) as *const i32);
    if nx==ox&&ny==oy{return;}
    let (tx,ty)=if m.traffic_mode==0{checked_position_legacy(m,s,nx as f64*0.125,ny as f64*0.125)}else{checked_traffic_q(m,s,ox,oy,nx,ny,true)};
    wr(m.x,s,tx);wr(m.y,s,ty);
    let o=rd(m.out,s);
    if o==1||o==3{
        let x0=rd(m.x0,s);let y0=rd(m.y0,s);
        let crossed=floor(tx*m.itile)!=floor(x0*m.itile)||floor(ty*m.itile)!=floor(y0*m.itile);
        wr(m.out,s,if crossed{3}else{1});
        if !crossed&&rd(m.spent,s)!=0{wr(m.spent,s,0);}
    }
}
#[no_mangle]
pub unsafe extern "C" fn mv_move(a:u32,s0:i32,end:i32,chunk:i32){move_job(a,s0,end,chunk,false);}
#[no_mangle]
pub unsafe extern "C" fn mv_move_occupancy(a:u32,chunk:i32){move_job(a,0,4,chunk,true);}
#[inline(always)]
unsafe fn move_span(m:&mut Mv,f:*const f64,p:&MoveP,sp:&StepP,ep:&mut Epi,b0:usize,e:usize) {
    let pc=if ep.push {Some(push_consts(m,f))}else{None};
    // Exclusive contacts and steering must resolve in the same identity
    // order regardless of whether restored slots happen to form SIMD runs.
    // Bulk status/index/pressure passes remain vectorized.
    let fast = p.step_ran && sp.acq_t == 4 && sp.tr > 0 && !m.steady.is_null()
        && (m.occ.is_null() || m.traffic_mode==0);
    let zero = i32x4_splat(0);
    if !m.occ.is_null() {(*m.occ).visit(e-b0);}
    let mut s = b0;
    while s < e {
        let n = (e - s).min(4);
        m.span_n=if m.occ.is_null(){4}else{n};
        m.shared_hot = core::ptr::null();
        // Spatially mixed crowds commonly give a job only one owned slot.
        // An idle short span must not run four-lane flow/park/combat probes
        // over unrelated units. Keep its exact idle stores, then yield only
        // where the coarse pressure field actually reaches it.
        if m.traffic_mode>0 && n<4 {
            let mut quiet=true;
            // (A live unit that is not a worker is the controller's: not quiet.)
            for l in 0..n{quiet&=*m.on.add(s+l)==0&&(!BRAIN||*m.cmode.add(s+l)==0)&&(m.holdf.is_null()||*m.dead.add(s+l)!=0||*m.iswk.add(s+l)!=0);}
            if quiet{
                for l in 0..n{let u=s+l;let dead=*m.dead.add(u);
                    if *m.d0.add(u)!=dead{*m.d0.add(u)=dead;}
                    if *m.out.add(u)!=0{*m.out.add(u)=0;}if *m.fire.add(u)!=0{*m.fire.add(u)=0;}
                    if !traffic_deferred(m){
                        if m.traffic_mode>=2&&!m.occ.is_null(){traffic_yield(m,u);}
                        if *m.out.add(u)>1||*m.spent.add(u)!=0{epi_slot(m,f,ep,u,false);}
                    }
                }
                s+=4;continue;
            }
            if n==1&&!m.hot.is_null()&&!m.statrow.is_null(){let row=*m.statrow.add(s);if row>=0{m.shared_hot=m.hot.add(row as usize*16);}}
        }

        // (The last group's missing lanes count as done for the vector
        // passes, which then run on every group: which path a unit takes must
        // not depend on where its slot falls (that differs between peers:
        // the vector and scalar paths keep different caches, e.g. steady
        // windows). `done` and `known` below hold the group's own lanes.)
        let valid = (1i32 << n) - 1;
        let pad = 15 & !valid;
        let mut done = pad;
        let known;
        // (Lanes whose sepMov the vector paths know: known, moved.)
        let mut mvd = 0i32;
        // Idle groups need no flow, wake, energy or navigation cache reads.
        // Their JS update already ran; copy only the dead/output bytes and
        // leave separation to derive movement from the positions as before.
        let handed = 0i32;
        let idle = handed == 0 && n == 4 && (m.on.add(s) as *const u32).read_unaligned() == 0
            && (!BRAIN || (m.cmode.add(s) as *const u32).read_unaligned() == 0)
            && (m.holdf.is_null() || (0..4).all(|l| *m.dead.add(s + l) != 0 || *m.iswk.add(s + l) != 0));
        if idle {
            let dead = (m.dead.add(s) as *const u32).read_unaligned();
            let d0 = m.d0.add(s) as *mut u32;
            if d0.read_unaligned() != dead { d0.write_unaligned(dead); }
            let out = m.out.add(s) as *mut u32;
            if out.read_unaligned() != 0 { out.write_unaligned(0); }
            let fire = m.fire.add(s) as *mut u32;
            if fire.read_unaligned() != 0 { fire.write_unaligned(0); }
            done = valid; known = 0;
        } else {
        // Occupancy jobs usually contain combat holds/chases. Finish those
        // before touching flow caches, rather than testing every flow lane
        // first and then discovering it has a combat instruction.
        if !m.occ.is_null() && BRAIN {
            let c=combat4(m,p,s,done,&mut mvd);done|=c;dbgc!(m,2,(c&15).count_ones());
        }
        if fast && done!=15 {
            done |= step4(m, sp, s, &mut mvd, valid);
        }
        if BRAIN && done != 15 && m.occ.is_null() {
            let c = combat4(m, p, s, done, &mut mvd);
            dbgc!(m, 2, (c & 15).count_ones());
            done |= c;
        }
        if fast && done != 15 {
            let c = park4(m, sp, s, done);
            dbgc!(m, 3, (c & 15).count_ones());
            done |= c;
        }
        known = done & valid & !handed;
        if done != 15 {
            let c = idle4(m, s, done);
            dbgc!(m, 19, (c & 15).count_ones());
            done |= c;
        }
        done &= valid;
        dbgc!(m, 0, n);
        dbgc!(m, 1, (done & 15).count_ones());
        // (The lanes done: their fire bytes cleared, four at once.)
        if done != 0 {
            if m.span_n<4 {
                for l in 0..n {if done&(1<<l)!=0 {*m.fire.add(s+l)=0;}}
            }else{
            let fp = m.fire.add(s) as *mut u32;
            let fv = fp.read_unaligned();
            if fv != 0 {
                let km = (if done & 1 != 0 { 0xFFu32 } else { 0 }) | (if done & 2 != 0 { 0xFF00 } else { 0 }) | (if done & 4 != 0 { 0xFF0000 } else { 0 }) | (if done & 8 != 0 { 0xFF000000 } else { 0 });
                fp.write_unaligned(fv & !km);
            }
            }
        }
        if done == valid {
            // (Nothing scalar left in the group.)
        } else {
        for l in 0..n {
            let u = s + l;
            if done & (1 << l) != 0 {
                continue;
            }
            dbgc!(m,32);
            if !m.occ.is_null(){(*m.occ).scalar_lane();}
            #[cfg(feature = "dbgc")]
            {
                let on = rd(m.on, u) as usize;
                dbgc!(m, 4 + on.min(6));
                if BRAIN && rd(m.cmode, u) != 0 { dbgc!(m, 11); }
                if rd(m.dead, u) != 0 { dbgc!(m, 12); }
            }
            if p.step_ran {
                step_slot(m, sp, u);
            }
            #[cfg(feature = "dbgc")]
            {
                if rd(m.stept, u - m.stepbase) == 1 { dbgc!(m, 13); }
            }
            match move_pre(m, p, u) {
                1 => {
                    dbgc!(m, 14);
                    move_flow(m, p, u);
                    // (The flow handed the unit back: its arrival or what else, the controller's.)
                    if !m.holdf.is_null() && rd(m.out, u) == 0 && rd(m.on, u) == 0 && rd(m.dead, u) == 0 && rd(m.iswk, u) == 0 && ctl(m, p, u) == 1 {
                        move_flow(m, p, u);
                    }
                }
                2 => { dbgc!(m, 15); move_path(m, p, u) }
                _ => {}
            }
        }
        }
        }
        if traffic_deferred(m){s+=4;continue;}
        if m.traffic_mode>=2 && !m.occ.is_null(){for l in 0..n{traffic_yield(m,s+l);}}
        let nd = if let Some(ref pc)=pc {push4(m,pc,s,e,known,mvd)}else{0};
        // (The lanes with anything for the epilogue.)
        let o4 = ld_u8x4(m.out.add(s));
        let k4 = ld_u8x4(m.spent.add(s));
        let eb = i32x4_bitmask(v128_or(i32x4_gt(o4, i32x4_splat(1)), i32x4_ne(k4, zero))) as i32 | nd | (nd >> 4);
        if eb & 15 != 0 {
            dbgc!(m, 16, (eb & 15).count_ones());
            dbgc!(m, 17, ((nd | (nd >> 4)) & 15).count_ones());
            for l in 0..n {
                if eb & (1 << l) != 0 {
                    epi_slot(m, f, ep, s + l, (nd >> l) & 0x11 != 0);
                }
            }
        }
        s += 4;
    }
}

const SWAP_CAP:usize=1024;
// A blocked mover and the idle friendly unit in its way trade places when
// that unit is not of the mover's own destination crowd (its route's end
// more than 3 tiles from the mover's; never ordered: none): units leave a
// group or pass through another at about their speed (a swap of one spacing
// every few steps), while arrivals still stop at their own crowd's edge.
// One chunk's index entries looked at, this job's own.
#[inline(never)]
// walkers: partners walking the other way (two flows pass each other), in
// the job's second pass only, when every unit of the job has had its step
// (each exchange then within both units' steps), this job's own; else
// standing partners (idle or parked), in the step itself.
unsafe fn traffic_swap(m:&Mv,s:usize,ox:i32,oy:i32,ux:f64,uy:f64,wl:*const u8,walkers:bool)->Option<(i32,i32)>{
    let g=&*m.occ;
    if m.rte.is_null()||m.swn.is_null()||*m.swn>=SWAP_CAP as i32||!g.active(s){return None;}
    let own=rd(m.own,s);if own<0{return None;}
    let mine=rd(m.rte,s);let rq=g.radius_q(s);
    // (At its speed: within its step from where it stood at the step's
    // start when that reaches a neighbour (long steps); else a hop of a
    // contact spacing once every k steps, its speed on average; the looks
    // only on those steps.)
    let mut spd=mv_stat(m,s,0,m.spd);if st_frz(m, s)>0{spd*=0.5;}if st_snd(m, s)>0{spd*=0.5;}
    let step=spd*m.dkf*8.0;if !(step>0.0){return None;}
    dbgc!(m,66);
    let spacing=(2*rq+16) as f64;
    let k=((floor(spacing/step) as i64)+1).max(1).min(64);
    let hop=step<spacing&&rem64_f(tsum(m.t,rd(m.id,s)),k*m.dk as i64)<m.dk as i64;
    if step<spacing&&!hop{return None;}
    dbgc!(m,67);
    let (sx0,sy0)=(*(m.x0.add(s) as *const i32),*(m.y0.add(s) as *const i32));
    // Candidates in the 3x3 chunks around a point half a contact ahead:
    // the three best by distance ahead and off its line, its own size first.
    let reach=(rq+16) as f64;
    let (qx,qy)=(ox+js_round(ux*reach) as i32,oy+js_round(uy*reach) as i32);
    let cq=g.chunk_q();
    let mut cand=[(f64::MAX,0usize);3];
    for pass in 0..9{
        let (a,e)=g.chunk_entries_near(qx+(pass%3-1)*cq,qy+(pass/3-1)*cq);
        let mut i=a;
        while i<e{
            let n=(e-i).min(4) as usize;let mut slots=[-1i32;4];
            for lane in 0..n {*slots.get_unchecked_mut(lane)=g.slot(i+lane as i32);}
            i+=n as i32;
            let mut mask=g.swap_candidates4(&slots,ox,oy,rq)&((1<<n)-1);
            while mask!=0 {
            let lane=mask.trailing_zeros() as usize;mask&=mask-1;
            let b=*slots.get_unchecked(lane);dbgc!(m,68);
            if b<0||b as usize==s||!g.active(b as usize){continue;}
            let b=b as usize;
            let (bx,by)=g.pos(b);
            let vx=(bx-ox) as f64;let vy=(by-oy) as f64;let rb=g.radius_q(b);
            let along=vx*ux+vy*uy;let lat=(vx*uy-vy*ux).abs();let rr=(rq+rb) as f64;
            if along<=lat*0.3||along*along+lat*lat>(rr+96.0)*(rr+96.0){continue;}
            dbgc!(m,69);
            let ob=rd(m.on,b);
            // (A worker standing at its work keeps its spot; one walking the
            // other way swaps as any walker: two workers meeting in a one-unit
            // pocket otherwise pushed against each other for good.)
            if rd(m.dead,b)!=0||rd(m.own,b)!=own||(rd(m.wk,b)!=0&&!walkers)||(BRAIN&&rd(m.cmode,b)!=0){continue;}
            if walkers{
                if !(ob==1&&rd(m.fl,b)&64!=0&&{let (hx,hy)=(rd(m.cvx,b),rd(m.cvy,b));hx*ux+hy*uy< -0.3*sqrt(hx*hx+hy*hy)}){continue;}
            }else if ob!=0&&ob!=2{continue;}
            let re=rd(m.rte,b);
            if mine>=0&&re>=0&&(irem(mine,m.w)-irem(re,m.w)).abs()<=3&&(idiv(mine,m.w)-idiv(re,m.w)).abs()<=3{continue;}
            let score=along+lat*0.6+if rb!=rq{4096.0}else{0.0};
            dbgc!(m,70);
            let mut j=3;while j>0&&cand[j-1].0>score{j-=1;}
            if j<3{let mut q=2;while q>j{cand[q]=cand[q-1];q-=1;}cand[j]=(score,b);}
            }
        }
    }
    let walls=|b:usize|{let p=rd(m.npr,b) as usize;
        if p<NAV_PROFILES&&!m.nav.get_unchecked(p).walls.is_null(){m.nav.get_unchecked(p).walls}else if rd(m.fl,b)&32!=0{m.airw}else{m.wall}};
    for k in 0..3{
        let (score,b)=*cand.as_ptr().add(k);
        if score==f64::MAX{break;}
        let (bx,by)=g.pos(b);
        let walker=walkers;
        if !hop{
            let ex=(bx-sx0) as f64;let ey=(by-sy0) as f64;if ex*ex+ey*ey>step*step{continue;}
            // (A walker's exchange within its own step too.)
            if walker{let mut sb=mv_stat(m,b,0,m.spd);if st_frz(m, b)>0{sb*=0.5;}if st_snd(m, b)>0{sb*=0.5;}let sb=sb*m.dkf*8.0;
                let ex=(ox-*(m.x0.add(b) as *const i32)) as f64;let ey=(oy-*(m.y0.add(b) as *const i32)) as f64;if ex*ex+ey*ey>sb*sb{continue;}}
        }
        let (x0,y0,x1,y1)=(ox as f64*0.125,oy as f64*0.125,bx as f64*0.125,by as f64*0.125);
        if !seg_open(wl,m.w,m.h,x0,y0,x1,y1,m.itile,m.tile)||!seg_open(walls(b),m.w,m.h,x1,y1,x0,y0,m.itile,m.tile){continue;}
        // (A neighbouring block's unit: listed for the index after the phases.)
        let (ix,iy)=(irem(rd(m.spt,b),m.w),idiv(rd(m.spt,b),m.w));
        let tq=(m.tile*8.0) as i32;let home=g.owns(ix*tq+1,iy*tq+1);
        if !home&&(walker||!g.xswap_room()){continue;}
        dbgc!(m,71);
        let (nx,ny)=match g.swap(s,b,-ux,-uy){Some(p)=>p,None=>continue};
        dbgc!(m,72);
        let (x0,y0)=(nx as f64*0.125,ny as f64*0.125);
        // The other: where the mover stood (its tile's change is listed in
        // the job's second pass; its orders stay as they are).
        wr(m.px,b,rd(m.x0,b));wr(m.py,b,rd(m.y0,b));wr(m.x,b,x0);wr(m.y,b,y0);
        if rd(m.fl,b)&64==0{wr(m.cd,b,-1);wr(m.ct,b,-1);}
        wr(m.steady,b,0);
        if walker{wr(m.vx,b,(x0-rd(m.x0,b))/m.dkf);wr(m.vy,b,(y0-rd(m.y0,b))/m.dkf);}
        if home{*m.swl.add(*m.swn as usize)=b as i32;*m.swn+=1;}else{g.xswap_push(b);}
        return Some((bx,by));
    }
    None
}
/// The pressure's sideways part (lx, ly) for a step along (ux, uy) pressed
/// along it by `along`: pressed head-on (against the step, more than across
/// it), to the step's right whatever side the pressure leans, at least half
/// the head-on press: two meeting head-on pass each other (both keep right)
/// instead of mirroring each other's sidesteps tick after tick.
#[inline(always)]
fn keep_right(lx:f64,ly:f64,along:f64,ux:f64,uy:f64)->(f64,f64){
    if !(along<0.0)||lx*lx+ly*ly>=along*along{return (lx,ly);}
    let k=sqrt(lx*lx+ly*ly).max(-along*0.5);
    (-uy*k,ux*k)
}
#[inline(always)]
unsafe fn traffic_deferred(m:&Mv)->bool{m.traffic_mode>=2&&!m.occ.is_null()&&*m.traffic.add(12)==2}

// Standing units (idle, parked, attacking in place) give way to the pushes
// blocked movers left at their tile last step: off a friend's line, back
// before a hostile push their side does not answer. Walkers and chasers
// steer in their own step. One record read; no neighbour search.
#[inline(never)]
unsafe fn traffic_yield(m:&Mv,s:usize){
    dbgc!(m,73);
    if rd(m.dead,s)!=0||!(rd(m.en,s)>0.0){return;}
    // (Handed back to Unit.update this step: left where it is.)
    if BRAIN&&rd(m.cmode,s)&8!=0{return;}
    dbgc!(m,75);
    let on=rd(m.on,s);
    let walker=on==1||on==4||on==6||on==7||(BRAIN&&rd(m.cmode,s)&3==2);
    // (A walker other than a flow unit has no cached heading: nothing more.)
    if walker&&(on!=1||rd(m.fl,s)&64==0||(BRAIN&&rd(m.cmode,s)!=0)){return;}
    dbgc!(m,76);
    let xq=*(m.x.add(s) as *const i32);let yq=*(m.y.add(s) as *const i32);
    let x0=rd(m.x0,s);let y0=rd(m.y0,s);let x=xq as f64*0.125;let y=yq as f64*0.125;
    let dx=x-x0;let dy=y-y0;let spent=sqrt(dx*dx+dy*dy);
    let mut spd=mv_stat(m,s,0,m.spd);if st_frz(m, s)>0{spd*=0.5;}if st_snd(m, s)>0{spd*=0.5;}
    let remaining=(spd*m.dkf-spent).max(0.0);if remaining<0.25{return;}
    dbgc!(m,77);
    let own=rd(m.own,s);
    let (fx,fy,hop,step);
    // (A walker's heading, unit length.)
    let (mut hux,mut huy)=(0.0,0.0);
    if walker{
        // A flow unit left short of its step once the block's leaders had
        // theirs: the rest along its own heading, bent only sideways by the
        // pressure (never back, at most ~50 degrees), as its step was.
        // (Short of it along its heading: a unit sliding to and fro beside a
        // blocker spends its step without getting on.)
        let (hx,hy)=(rd(m.cvx,s),rd(m.cvy,s));let hl=sqrt(hx*hx+hy*hy);
        if !(hl>0.0)||(dx*hx+dy*hy)/hl>hl*m.dkf*0.75{return;}
        dbgc!(m,78);
        let ux=hx/hl;let uy=hy/hl;hux=ux;huy=uy;
        let (layer,_)=(*m.occ).layer_mass(s);
        let (px,py)=super::traffic::sample(m.traffic,xq,yq,layer);
        let along=px*ux+py*uy;let (lx,ly)=keep_right(px-along*ux,py-along*uy,along,ux,uy);
        let mut sx=lx/spd.max(0.25);let mut sy=ly/spd.max(0.25);
        let side=sqrt(sx*sx+sy*sy);if side>1.2{sx*=1.2/side;sy*=1.2/side;}
        let vx=ux+sx;let vy=uy+sy;let l=sqrt(vx*vx+vy*vy);
        fx=vx/l;fy=vy/l;hop=-1;step=remaining;
    }else{
        let (vx,vy,h)=super::traffic::push_response(m.traffic,xq,yq,own);
        let force=sqrt(vx*vx+vy*vy);if force<0.15{return;}
        dbgc!(m,79);
        fx=vx/force;fy=vy/force;hop=h;step=remaining*(force*0.6).min(0.75);
    }
    let nx=x+fx*step;let ny=y+fy*step;
    let np=rd(m.npr,s) as usize;let wl=if np<NAV_PROFILES&&!m.nav.get_unchecked(np).walls.is_null(){m.nav.get_unchecked(np).walls}else{m.wall};
    if !seg_open(wl,m.w,m.h,x,y,nx,ny,m.itile,m.tile){return;}
    dbgc!(m,80);
    let (mut tx,mut ty)=checked_traffic_position(m,s,nx,ny,false);
    // (Still blocked on its way (a slide to the side is no way on): one
    // walking the other way may pass it.)
    if walker&&(tx-x)*hux+(ty-y)*huy<step*0.25{
        dbgc!(m,74);
        if let Some((sx,sy))=traffic_swap(m,s,(tx*8.0) as i32,(ty*8.0) as i32,fx,fy,wl,true){tx=sx as f64*0.125;ty=sy as f64*0.125;}
    }
    // Pressed by friends but boxed in itself: pass a weaker push on (a
    // corridor opens through a packed crowd; it fades within a few units).
    if hop>=0&&hop<super::traffic::PUSH_HOPS{
        let gx=tx-x;let gy=ty-y;let moved=sqrt(gx*gx+gy*gy)/step;
        let force=step/(remaining*0.6);
        if moved<0.5{super::traffic::push_deposit(m.traffic,(tx*8.0) as i32,(ty*8.0) as i32,fx,fy,1.0,(1.0-moved)*force.min(1.0)*0.5,(*m.occ).radius_q(s),own,hop+1);}
    }
    if tx==x&&ty==y{return;}
    dbgc!(m,81);
    wr(m.px,s,x0);wr(m.py,s,y0);wr(m.x,s,tx);wr(m.y,s,ty);
    wr(m.vx,s,(tx-x0)/m.dkf);wr(m.vy,s,(ty-y0)/m.dkf);
    if rd(m.fl,s)&64==0{wr(m.cd,s,-1);wr(m.ct,s,-1);wr(m.steady,s,0);}
    let cross=floor(tx*m.itile)!=floor(x0*m.itile)||floor(ty*m.itile)!=floor(y0*m.itile);
    if cross{wr(m.out,s,3);}else if rd(m.out,s)==0{wr(m.out,s,1);}
}

/// Four slots' combat brain instructions, move_combat's common cases four a
/// lane: a unit holding (cmMode move 1) stands; one chasing (2) steps toward
/// its target (where it was at the pass's start, unit.x0/y0) at its speed
/// (halved frozen, halved sandy), staying in its tile or flying (in f32,
/// quantized half up). Left to move_combat: a unit not alive or not indexed,
/// its target gone (dead, another unit in its slot), its shot due (fire bit,
/// timer out), a ground step into another tile (the wall slide). Returns the
/// lanes done (not in `done`).
#[cfg_attr(not(feature = "prof"), inline(always))]
#[cfg_attr(feature = "prof", inline(never))]
unsafe fn combat4(m: &Mv, p: &MoveP, s: usize, done: i32, mvd: &mut i32) -> i32 {
    if m.span_n==1&&((*m.cmode.add(s)&3)==0||(*m.cmode.add(s)&32)!=0){return 0;}
    #[cfg(not(feature="prof"))]
    let pair_holds=true;
    #[cfg(feature="prof")]
    let pair_holds=m.pair_holds;
    if pair_holds && m.span_n==2 && !m.occ.is_null() && done&3==0 {
        let cm=(m.cmode.add(s) as *const u16).read_unaligned();
        if cm&0x1313==0x0101 && combat_hold2(m,p,s,cm) {return 3;}
    }
    let zero = i32x4_splat(0);
    let fz = f32x4_splat(0.0);
    let cm = ld_u8x4(m.cmode.add(s));
    let mk = v128_and(cm, i32x4_splat(3));
    let hold = i32x4_eq(mk, i32x4_splat(1));
    let chase = i32x4_eq(mk, i32x4_splat(2));
    let free = i32x4_eq(v128_and(i32x4_splat(done), i32x4(1, 2, 4, 8)), zero);
    // (A structure instruction, bit 16: its holds stand here, but on a unit's recheck tick (one in four, every one of a longer
    // step), when move_struct looks at the structure; its approaches are move_struct's, one by one.)
    let is_st = i32x4_ne(v128_and(cm, i32x4_splat(16)), zero);
    // (Bit 32: an attack order's, see forced.)
    let free = v128_andnot(free, i32x4_ne(v128_and(cm, i32x4_splat(32)), zero));
    let tw = i32x4_add(i32x4_splat(m.t), v128_load(m.id.add(s) as *const v128));
    let recheck = i32x4_lt(v128_and(tw, i32x4_splat(3)), i32x4_splat(m.dk));
    let st_hold = v128_andnot(v128_and(is_st, hold), recheck);
    let mut ok = v128_and(free, v128_or(v128_andnot(v128_or(hold, chase), is_st), st_hold));
    if !v128_any_true(ok) {
        return 0;
    }
    if !m.hita.is_null() && m.occ.is_null() {
        let firing = v128_andnot(i32x4_ne(v128_and(cm, i32x4_splat(4)), zero), f32x4_gt(v128_load(m.at.add(s) as *const v128), fz));
        ok = v128_andnot(ok, firing);
    }
    ok = v128_and(ok, f32x4_gt(v128_load(m.en.add(s) as *const v128), fz));
    ok = v128_and(ok, v128_not(i32x4_eq(v128_load(m.sep.add(s) as *const v128), i32x4_splat(p.absent as u32 as i32))));
    ok = v128_and(ok, i32x4_eq(ld_u8x4(m.dead.add(s)), zero));
    ok = v128_and(ok, i32x4_ge(v128_load(m.cmt.add(s) as *const v128), zero));
    let mut bits = i32x4_bitmask(ok) as i32;
    if bits == 0 {
        return 0;
    }
    // (The targets: alive and the same unit; where they were, in eighths.)
    let mut tx = zero;
    let mut ty = zero;
    let (x0, y0) = (m.x0 as *const i32, m.y0 as *const i32);
    #[cfg(not(feature="prof"))]
    let bulk=true;
    #[cfg(feature="prof")]
    let bulk=m.bulk_hold_targets;
    let mut held_targets_valid=false;
    if bulk && !m.occ.is_null() && (i32x4_bitmask(chase) as i32&bits)==0 && m.span_n==2 && bits==3 {
        let q0=rd(m.cmt,s) as usize;let q1=rd(m.cmt,s+1) as usize;
        let expected=(m.ctid.add(s) as *const u64).read_unaligned();
        if q1==q0+1 {
            held_targets_valid=(m.id.add(q0) as *const u64).read_unaligned()==expected
                && (m.dead.add(q0) as *const u16).read_unaligned()==0;
        }else if q1==q0 {
            let id=rd(m.id,q0) as u32 as u64;
            held_targets_valid=(id|(id<<32))==expected && rd(m.dead,q0)==0;
        }
        if held_targets_valid {dbgc!(m,39);}
    }
    if !held_targets_valid {for l in 0..4usize {
        if bits & (1 << l) == 0 {
            continue;
        }
        // (A structure's hold has no target unit to look at.)
        if rd(m.cmode, s + l) & 16 != 0 {
            continue;
        }
        let q = rd(m.cmt, s + l) as usize;
        if rd(m.dead, q) != 0 || rd(m.id, q) != rd(m.ctid, s + l) {
            bits &= !(1 << l);
            continue;
        }
        // Holds only validate identity; they do not need target positions,
        // speed/stat rows, frozen/sand columns or a square root.
        if !m.occ.is_null() && (rd(m.cmode,s+l)&3)==1 {continue;}
        let (a, b) = (rd(x0, q), rd(y0, q));
        match l {
            0 => { tx = i32x4_replace_lane::<0>(tx, a); ty = i32x4_replace_lane::<0>(ty, b); }
            1 => { tx = i32x4_replace_lane::<1>(tx, a); ty = i32x4_replace_lane::<1>(ty, b); }
            2 => { tx = i32x4_replace_lane::<2>(tx, a); ty = i32x4_replace_lane::<2>(ty, b); }
            _ => { tx = i32x4_replace_lane::<3>(tx, a); ty = i32x4_replace_lane::<3>(ty, b); }
        }
    }}
    if bits == 0 {
        return 0;
    }
    let lane = i32x4_ne(v128_and(i32x4_splat(bits), i32x4(1, 2, 4, 8)), zero);
    let x = v128_load(m.x.add(s) as *const v128);
    let y = v128_load(m.y.add(s) as *const v128);
    if !m.occ.is_null() {
        if !m.hita.is_null() {
            let firing=v128_and(lane,v128_and(i32x4_ne(v128_and(cm,i32x4_splat(4)),zero),v128_not(f32x4_gt(v128_load(m.at.add(s) as *const v128),fz))));
            let fire_bits=i32x4_bitmask(firing);
            for l in 0..m.span_n {if fire_bits&(1<<l)!=0 {
                let u=s+l;fire(m,u);hit_sty_count(m,p,u);let c=rd(m.hitc,p.chunk);
                let ct=rd(m.cmt,u);
                wr(m.hita,p.s0+c as usize,u as i32);wr(m.hitt,p.s0+c as usize,if rd(m.cmode,u)&16!=0 {-(ct+2)}else{ct});wr(m.hitc,p.chunk,c+1);
                dbgc!(m,34);
            }}
        }
        if i32x4_bitmask(v128_and(lane,chase))==0 {
            // Most held units already have prev==position and zero velocity.
            // Do not dirty four large columns merely to rewrite those values.
            #[cfg(not(feature="prof"))]
            let skip=true;
            #[cfg(feature="prof")]
            let skip=m.skip_hold_stores;
            let changed=if skip {v128_or(v128_or(v128_xor(v128_load(m.px.add(s) as *const v128),x),v128_xor(v128_load(m.py.add(s) as *const v128),y)),
                v128_or(v128_load(m.vx.add(s) as *const v128),v128_load(m.vy.add(s) as *const v128)))
                }else{i32x4_splat(-1)};
            if v128_any_true(v128_and(changed,lane)) {
                mv_store32(m,m.px.add(s) as *mut v128,x,lane);mv_store32(m,m.py.add(s) as *mut v128,y,lane);
                mv_store32(m,m.vx.add(s) as *mut v128,fz,lane);mv_store32(m,m.vy.add(s) as *mut v128,fz,lane);dbgc!(m,37);
            }else{dbgc!(m,38);}
            if (m.d0.add(s) as *const u32).read_unaligned()!=0 {mv_store8(m,m.d0.add(s),zero,lane);}
            mv_store8(m,m.out.add(s),i32x4_splat(1),lane);
            dbgc!(m,35,bits.count_ones());return bits;
        }
    }
    // (The way in pixels, f32.)
    let dx = px4(i32x4_sub(tx, x));
    let dy = px4(i32x4_sub(ty, y));
    let d = f32x4_sqrt(f32x4_add(f32x4_mul(dx, dx), f32x4_mul(dy, dy)));
    let half = f32x4_splat(0.5);
    let one = f32x4_splat(1.0);
    let mut spd = mv_stat4(m, s, 0, m.spd);
    // (Frozen, sandy: by the four's status records, none the most.)
    if v128_any_true(v128_load(m.stix.add(s) as *const v128)) {
        let fz4 = i32x4(st_frz(m, s), st_frz(m, s + 1), st_frz(m, s + 2), st_frz(m, s + 3));
        let sd4 = i32x4(st_snd(m, s), st_snd(m, s + 1), st_snd(m, s + 2), st_snd(m, s + 3));
        spd = f32x4_mul(spd, v128_bitselect(half, one, i32x4_gt(fz4, zero)));
        spd = f32x4_mul(spd, v128_bitselect(half, one, i32x4_gt(sd4, zero)));
    }
    let go = v128_and(v128_and(lane, chase), v128_and(f32x4_gt(d, spd), f32x4_gt(spd, fz)));
    let stand = v128_andnot(lane, go);
    // (Several base ticks: their way, stopping a base tick's step short of
    // the target, where one a step stops.)
    let stp = if m.dk > 1 { f32x4_min(f32x4_mul(spd, f32x4_splat(m.dk as f32)), f32x4_sub(d, spd)) } else { spd };
    let k = f32x4_div(stp, d);
    let mut vx = v128_and(f32x4_mul(dx, k), go);
    let mut vy = v128_and(f32x4_mul(dy, k), go);
    let gx = tile4(m, x);
    let gy = tile4(m, y);
    // (The step as whole eighths, halves up: lanes not going 0.)
    let mut nx = i32x4_add(x, q8x4(vx));
    let mut ny = i32x4_add(y, q8x4(vy));
    let cross = v128_or(i32x4_ne(tile4(m, nx), gx), i32x4_ne(tile4(m, ny), gy));
    let fly = i32x4_eq(ld_u8x4(m.slayer.add(s)), i32x4_splat(1));
    // (A ground step into another tile: move_combat's wall slide.)
    let mut slide = v128_andnot(v128_and(go, cross), fly);
    if !m.occ.is_null() && m.dk==1 && v128_any_true(slide) {
        let sb=i32x4_bitmask(slide);
        let gxv:[i32;4]=core::mem::transmute(gx);let gyv:[i32;4]=core::mem::transmute(gy);
        let ngx:[i32;4]=core::mem::transmute(tile4(m,nx));let ngy:[i32;4]=core::mem::transmute(tile4(m,ny));
        let mut sx=[0i32;4];let mut sy=[0i32;4];
        for l in 0..m.span_n {if sb&(1<<l)!=0 {
            let sl=flow_slide(m.wall,m.w,m.h,*gxv.get_unchecked(l),*gyv.get_unchecked(l),*ngx.get_unchecked(l) as f64,*ngy.get_unchecked(l) as f64);
            *sx.get_unchecked_mut(l)=if sl&1!=0 {-1}else{0};*sy.get_unchecked_mut(l)=if sl&2!=0 {-1}else{0};
            dbgc!(m,36);
        }}
        vx=v128_andnot(vx,core::mem::transmute(sx));vy=v128_andnot(vy,core::mem::transmute(sy));
        nx=i32x4_add(x,q8x4(vx));ny=i32x4_add(y,q8x4(vy));slide=zero;
    }
    let take = v128_andnot(v128_or(stand, go), slide);
    let tb = i32x4_bitmask(take) as i32;
    if tb == 0 {
        return 0;
    }
    let moved = v128_and(go, cross);
    *mvd |= (i32x4_bitmask(v128_or(i32x4_ne(nx, x), i32x4_ne(ny, y))) as i32) & tb;
    let st = |pp: *mut v128, v: v128| {
        mv_store32(m,pp,v,take);
    };
    st(m.px.add(s) as *mut v128, x);
    st(m.py.add(s) as *mut v128, y);
    st(m.vx.add(s) as *mut v128, vx);
    st(m.vy.add(s) as *mut v128, vy);
    let (nx,ny)=checked_positions4(m,s,nx,ny,tb);
    let moved=v128_and(go,v128_or(i32x4_ne(tile4(m,nx),gx),i32x4_ne(tile4(m,ny),gy)));
    st(m.x.add(s) as *mut v128, nx);
    st(m.y.add(s) as *mut v128, ny);
    let i1 = i32x4_splat(1);
    mv_store8(m,m.d0.add(s), zero, take);
    mv_store8(m,m.out.add(s), v128_bitselect(i32x4_splat(3), i1, moved), take);
    tb
}

// Spatial cells commonly contain two consecutive held units. Keep their
// validation and stores pair-sized: four-lane loads read unrelated slots,
// and masked SIMD stores need extra lane extraction for this ownership span.
#[inline(always)]
unsafe fn combat_hold2(m:&Mv,p:&MoveP,s:usize,cm:u16)->bool {
    if (m.dead.add(s) as *const u16).read_unaligned()!=0
        || !(rd(m.en,s)>0.0 && rd(m.en,s+1)>0.0)
        || *m.sep.add(s)==p.absent as u32 || *m.sep.add(s+1)==p.absent as u32 {return false;}
    let q0=*m.cmt.add(s);let q1=*m.cmt.add(s+1);
    if q0<0 || q1<0 {return false;}
    let q0=q0 as usize;let q1=q1 as usize;
    let expected=(m.ctid.add(s) as *const u64).read_unaligned();
    let valid=if q1==q0+1 {
        (m.id.add(q0) as *const u64).read_unaligned()==expected
            && (m.dead.add(q0) as *const u16).read_unaligned()==0
    }else if q1==q0 {
        let id=*m.id.add(q0) as u32 as u64;
        (id|(id<<32))==expected && *m.dead.add(q0)==0
    }else{
        *m.dead.add(q0)==0 && *m.dead.add(q1)==0
            && *m.id.add(q0)==*m.ctid.add(s) && *m.id.add(q1)==*m.ctid.add(s+1)
    };
    if !valid {return false;}
    if cm&0x0404!=0 && !m.hita.is_null() {
        for l in 0..2 {let u=s+l;if cm&(4<<(l*8))!=0 && !(rd(m.at,u)>0.0) {
            fire(m,u);hit_sty_count(m,p,u);let c=rd(m.hitc,p.chunk);
            wr(m.hita,p.s0+c as usize,u as i32);wr(m.hitt,p.s0+c as usize,*m.cmt.add(u));wr(m.hitc,p.chunk,c+1);
            dbgc!(m,34);
        }}
    }
    let x=(m.x.add(s) as *const u64).read_unaligned();let y=(m.y.add(s) as *const u64).read_unaligned();
    let px=m.px.add(s) as *mut u64;let py=m.py.add(s) as *mut u64;
    let vx=m.vx.add(s) as *mut u64;let vy=m.vy.add(s) as *mut u64;
    if px.read_unaligned()!=x || py.read_unaligned()!=y || vx.read_unaligned()!=0 || vy.read_unaligned()!=0 {
        px.write_unaligned(x);py.write_unaligned(y);vx.write_unaligned(0);vy.write_unaligned(0);dbgc!(m,37);
    }else{dbgc!(m,38);}
    let d0=m.d0.add(s) as *mut u16;if d0.read_unaligned()!=0 {d0.write_unaligned(0);}
    (m.out.add(s) as *mut u16).write_unaligned(0x0101);
    dbgc!(m,35,2);dbgc!(m,39);true
}

/// The step kernel's params (from F).
// Standalone stationary-hold replay. Only the columns used by combat4's
// hold path are allocated, so the cache/write experiment needs ~200 MiB
// rather than another full multi-gigabyte world. Profiling builds only.
#[cfg(feature="prof")]
#[no_mangle]
pub unsafe extern "C" fn mv_hold_bench(a:u32,n:i32,rounds:i32,skip:i32,bulk:i32)->i32 {
    let a=waddr(a) as *const i32;
    let ptr=|i:usize|waddr(*a.add(512+i) as u32);
    let mut m:Mv=core::mem::zeroed();
    m.occ=core::ptr::NonNull::<super::occ::MoveGrid>::dangling().as_ptr();
    m.span_n=2;m.skip_hold_stores=skip!=0;m.bulk_hold_targets=bulk!=0;m.pair_holds=bulk==2;m.dk=1;m.dkf=1.0;m.argp=a as usize;
    m.cmode=ptr(0) as *mut u8;m.cmt=ptr(1) as *mut i32;m.ctid=ptr(2) as *mut i32;m.id=ptr(3) as *const i32;
    m.dead=ptr(4) as *const u8;m.en=ptr(5) as *const F32;m.sep=ptr(6) as *mut u32;
    m.x=ptr(7) as *mut Q8;m.y=ptr(8) as *mut Q8;m.px=ptr(9) as *mut Q8;m.py=ptr(10) as *mut Q8;
    m.vx=ptr(11) as *mut F32;m.vy=ptr(12) as *mut F32;m.d0=ptr(13) as *mut u8;m.out=ptr(14) as *mut u8;
    m.at=ptr(15) as *const F32;m.acd=ptr(16) as *const F32;m.flash=ptr(17) as *mut U8I32;m.tmon=ptr(18) as *mut u8;
    m.hita=ptr(19) as *mut i32;m.hitt=ptr(20) as *mut i32;m.hitc=ptr(21) as *mut i32;
    m.atl=ptr(22) as *mut u8;m.atn=ptr(23) as *mut u8;
    let mut p:MoveP=core::mem::zeroed();p.absent=u32::MAX as f64;
    let mut sum=0;
    for _ in 0..rounds {let mut s=0;while s+2<=n as usize {
        let mut moved=0;sum+=combat4(&m,&p,s,12,&mut moved).count_ones() as i32;s+=2;
    }}sum
}

/// The step kernel's params (from F).
#[inline(always)]
unsafe fn step_params(f: *const f64) -> StepP {
    let q = rd(f, 8);
    let bc = to_i32(rd(f, 9)) as i64;
    let br = to_i32(rd(f, 10)) as i64;
    StepP {
        tr: to_i32(rd(f, 3)),
        q,
        iq: 1.0 / q,
        players: to_i32(rd(f, 11)),
        bsz: rd(f, 14),
        absent: rd(f, 15),
        boxsteps: to_i32(rd(f, 17)),
        wcheck: to_i32(rd(f, 21)),
        acq_t: js_max(1.0, to_i32(rd(f, 38)) as f64) as i64,
        wkwatch: js_max(1.0, to_i32(rd(f, 29)) as f64) as i64,
        stride: bc + 1,
        plane: (bc + 1) * (br + 1),
    }
}

/// Writes through a pointer the loader holds as read-only (the columns the
/// arming functions also write).
#[inline(always)]
unsafe fn wc<T: Scalar>(p: *const T, i: usize, v: T::Value) {
    wr(p as *mut T, i, v)
}

/// flownav.js navApproachTile: tile t when open, else the open tile nearest
/// it within six rings (in steps, then the scan's order); -1 none.
unsafe fn approach_tile(wl: *const u8, w: i32, h: i32, t: i32) -> i32 {
    if !(t >= 0 && (t as i64) < (w as i64) * (h as i64)) {
        return -1;
    }
    if rd(wl, t as usize) == 0 {
        return t;
    }
    let (tx, ty) = (irem_f(t, w), idiv(t - irem_f(t, w), w));
    let mut r = -1i32;
    let mut d = 1i32;
    while d <= 6 && r < 0 {
        let mut best = i32::MAX;
        let mut dy = -d;
        while dy <= d {
            let mut dx = -d;
            while dx <= d {
                if dx.abs().max(dy.abs()) == d {
                    let (x, y) = (tx + dx, ty + dy);
                    if x >= 0 && y >= 0 && x < w && y < h && rd(wl, (y * w + x) as usize) == 0 {
                        let dd = dx.abs() + dy.abs();
                        if dd < best {
                            best = dd;
                            r = y * w + x;
                        }
                    }
                }
                dx += 1;
            }
            dy += 1;
        }
        d += 1;
    }
    r
}

/// A structure instruction of the combat brain (cmMode bit 16, cmT the
/// structure's tile; bits 0-1 hold (1) or approach (2), bit 4 fire): the
/// unit's order (idle, attack-move) stays what it is underneath; it stands and
/// fires at the structure in its attack range (the areas' reach: worked out
/// here up to two steps, else the brain's word), else walks to it: straight
/// when it flies or is within two tiles, else by the atlas to the open tile
/// beside it (the flow columns taken for it: mvWk 4). The attack is listed
/// with a target of -(tile + 2) (k_hits passes it over; unit.js
/// unitHitsResolve applies it to the structure). The instruction ends (cmMode
/// 0) when the structure is gone, no longer hostile or out of sight; the
/// order's movement is given back by resume_order. True: the unit's step is
/// done.
#[cfg_attr(feature = "prof", inline(never))]
unsafe fn move_struct(m: &Mv, p: &MoveP, s: usize, cm: u8) -> bool {
    let (w, h, tile, itile) = (m.w, m.h, m.tile, m.itile);
    let t = rd(m.cmt, s);
    let owner = rd(m.own, s);
    let valid = t >= 0 && (t as i64) < (w as i64) * (h as i64) && !m.ag.is_null() && !m.sc.is_null() && {
        let code = rd(m.sc, t as usize) as i32;
        code != -1 && code != owner && covered(m, owner, rd(m.ag, t as usize))
    };
    if !valid {
        wr(m.cmode, s, 0);
        return false;
    }
    let x = rd(m.x, s);
    let y = rd(m.y, s);
    let tx0 = irem_f(t, w);
    let tx = tx0 as f64 * tile + tile / 2.0;
    let ty = idiv(t - tx0, w) as f64 * tile + tile / 2.0;
    let k = rd(m.rk, s) as i32;
    // (Hold, or a moving shooter's fire-only word: in range by the brain.)
    let fire_only = (cm & 7) == 4;
    let mut inr = (cm & 3) == 1 || fire_only;
    if k <= 2 {
        let r = in_area_range(m, x, y, tx, ty, k);
        if r == 1 {
            inr = true;
        } else if r == 0 {
            inr = false;
        }
    }
    macro_rules! stand {
        () => {{
            wr(m.px, s, x);
            wr(m.py, s, y);
            wr(m.vx, s, 0.0);
            wr(m.vy, s, 0.0);
            wr(m.out, s, 1);
            return true;
        }};
    }
    if inr {
        if (k <= 2 || (cm & 4) != 0) && !(rd(m.at, s) > 0.0) && !m.hita.is_null() {
            fire(m, s);
            hit_sty_count(m, p, s);
            let c = rd(m.hitc, p.chunk);
            wr(m.hita, p.s0 + c as usize, s as i32);
            wr(m.hitt, p.s0 + c as usize, -(t + 2));
            wr(m.hitc, p.chunk, c + 1);
        }
        // (A drive-by shot: the unit goes on with its own move.)
        if fire_only {
            return false;
        }
        stand!();
    }
    if (cm & 3) == 0 {
        // (Fire only: the unit's own move.)
        return false;
    }
    let fly = rd(m.slayer, s) == 1;
    let dx = tx - x;
    let dy = ty - y;
    let d = sqrt(dx * dx + dy * dy);
    let mut spd = mv_stat(m, s, 0, m.spd);
    if st_frz(m, s) > 0 {
        spd *= 0.5;
    }
    if st_snd(m, s) > 0 {
        spd *= 0.5;
    }
    if !(d > 0.0) || !(spd > 0.0) {
        stand!();
    }
    if fly || d < 2.0 * tile {
        // Straight at it (doAttacking's building branch: simChaseStep).
        let mut st = spd;
        if m.dk > 1 {
            let kk = js_min(spd * m.dkf, js_max(spd, d - spd));
            if fly || seg_open(m.wall, w, h, x, y, x + dx / d * kk, y + dy / d * kk, itile, tile) {
                st = kk;
            }
        }
        let nx = (x + (dx / d) * st) as f32 as f64;
        let ny = (y + (dy / d) * st) as f32 as f64;
        let ngx = floor(nx * itile);
        let ngy = floor(ny * itile);
        if !fly && (ngx < 0.0 || ngy < 0.0 || ngx >= w as f64 || ngy >= h as f64 || (inb(ngx, w) && inb(ngy, h) && rd(m.wall, (ngy as i32 * w + ngx as i32) as usize) != 0)) {
            stand!();
        }
        let qx = quant_div(nx, p.q);
        let qy = quant_div(ny, p.q);
        let (qx, qy) = checked_position(m, s, qx, qy);
        let gx = floor(x * itile);
        let gy = floor(y * itile);
        wr(m.px, s, x);
        wr(m.py, s, y);
        wr(m.vx, s, dx / d * st);
        wr(m.vy, s, dy / d * st);
        wr(m.x, s, qx);
        wr(m.y, s, qy);
        wr(m.out, s, if floor(qx * itile) != gx || floor(qy * itile) != gy { 3 } else { 1 });
        return true;
    }
    // By the atlas to the open tile beside it.
    if rd(m.on, s) != 6 || rd(m.wk, s) != 4 || rd(m.ht, s) != t {
        let nv = m.nav.get_unchecked(0);
        let wl = if nv.walls.is_null() { m.wall } else { nv.walls };
        let dest = approach_tile(wl, w, h, t);
        if dest < 0 || m.atlh[0].is_null() {
            stand!();
        }
        wc(m.flow, s, NAV_ATLAS_FID);
        wr(m.fgen, s, 0);
        wc(m.dest, s, dest);
        wc(m.npr, s, 0);
        wc(m.rdy, s, 0);
        wr(m.fl, s, 64 | 128);
        wc(m.reach, s, k.min(255) as u8);
        wc(m.ht, s, t);
        wc(m.htid, s, 0);
        wc(m.wk, s, 4);
        wr(m.spent, s, 0);
        wr(m.cd, s, -1);
        if !m.steady.is_null() {
            wr(m.steady, s, 0);
        }
        wr(m.on, s, 6);
    }
    move_flow(m, p, s);
    if rd(m.on, s) == 0 || rd(m.out, s) == 0 {
        // (Arrived, or no way on: it stands, and takes the way again next tick.)
        wr(m.on, s, 0);
        stand!();
    }
    true
}

/// A unit whose structure instruction ended (mvWk 4: the flow columns were
/// taken for the approach): its order's movement again, from its columns. An
/// attack-mover goes on by the atlas to its route's end (unit.rtEnd, profile
/// unit.nvProf); an idle combat unit parks as simMoveTryParkIdle does; else
/// it is left to Unit.update.
#[cfg_attr(feature = "prof", inline(never))]
unsafe fn resume_order(m: &Mv, s: usize) {
    wc(m.wk, s, 0);
    wr(m.on, s, 0);
    let cmd = rd(m.cmd, s);
    let ra = rd(m.rda, s);
    if ra == 255 {
        return;
    }
    if cmd == 2 {
        let dest = if m.rte.is_null() { -1 } else { rd(m.rte, s) };
        let np = rd(m.nvp, s);
        let (w, itile) = (m.w, m.itile);
        let tl = floor(rd(m.y, s) * itile) as i32 * w + floor(rd(m.x, s) * itile) as i32;
        if dest >= 0 && np >= 0 && (np as usize) < NAV_PROFILES && !m.atlh[np as usize].is_null() && tl != dest {
            wc(m.flow, s, NAV_ATLAS_FID);
            wr(m.fgen, s, 0);
            wc(m.dest, s, dest);
            wc(m.npr, s, np as u8);
            wc(m.rdy, s, 0);
            wr(m.fl, s, 64 | 16 | if rd(m.slayer, s) == 1 { 32 } else { 0 });
            wc(m.reach, s, ra);
            wr(m.spent, s, 0);
            wr(m.cd, s, -1);
            if !m.steady.is_null() {
                wr(m.steady, s, 0);
            }
            wr(m.on, s, 1);
        }
    } else if cmd == 0 {
        let ph = irem_f(m.t.wrapping_add(rd(m.id, s)), IDLE_PARK_TICKS);
        wr(m.wake, s, m.t + IDLE_PARK_TICKS - ph);
        wr(m.fl, s, 16 | 128);
        wc(m.reach, s, ra);
        wr(m.on, s, 2);
    }
}

// =====================================================================
// THE UNIT CONTROLLER
// =====================================================================
// The order of a unit the kernel does not move (unarmed, or handed back), for
// the units that are not workers (UNIT_UPDATE_TO_KERNELS_PROGRESS.md): from
// its columns (commandState, the path's key unit.nvPK, the attack-move tile,
// hold, the issued target position mvTgX / mvTgY, the attack order's target),
// armed for the kernel, parked, or ended; scouts pick their destinations here.
// What only the main thread can do is an event (unit.mvEv, EV_*: a mine under
// it, a way that is not there, a wait that ended), listed after the kernel
// (SIM_KERNEL_UNIT_EVENTS) and handled there in O(events) (unit.js
// unitEventsRun).

/// The events (unit.mvEv): a floor item the kernel cannot apply (a mine), no
/// way on (the flow's look found none), a wait for a way that ended near its
/// target, a unit not in the unit index (or off the map, or of no player), a
/// worker's AI look on its way (its check tick: the kernel moves it on).
const EV_FLOOR: u8 = 1;
const EV_NOWAY: u8 = 2;
const EV_WAITED: u8 = 3;
const EV_SPATIAL: u8 = 4;
const EV_CHECK: u8 = 5;
#[inline(always)]
unsafe fn set_ev(m: &Mv, s: usize, e: u8) {
    if !m.ev.is_null() {
        wr(m.ev, s, e);
    }
}
/// commandState values (unit.js CMD_*).
const CMD_IDLE: i32 = 0;
const CMD_MOVE: i32 = 1;
const CMD_AM: i32 = 2;
const CMD_ATK: i32 = 3;
const CMD_HOLD_OLD: i32 = 4;
/// cmMode of an attack-mover whose target fell while it stood fighting: it
/// stands until the brain's next instruction (move_combat).
const CM_WAIT: u8 = 64;

/// The unit stands where it is this tick.
#[inline(always)]
unsafe fn stand_here(m: &Mv, s: usize) {
    wr(m.px, s, rd(m.x, s));
    wr(m.py, s, rd(m.y, s));
    wr(m.vx, s, 0.0);
    wr(m.vy, s, 0.0);
    wr(m.out, s, 1);
}

/// Parked, waking at its phase of IDLE_PARK_TICKS (flags: aggro look 16 and the
/// kernel's own periodic check 128, as simMoveTryParkIdle).
#[inline(always)]
unsafe fn park_with(m: &Mv, s: usize, flags: u8) {
    let ph = irem_f(m.t.wrapping_add(rd(m.id, s)), IDLE_PARK_TICKS);
    wr(m.wake, s, m.t + IDLE_PARK_TICKS - ph);
    wr(m.fl, s, flags);
    wc(m.reach, s, rd(m.rda, s).min(254));
    wc(m.wk, s, 0);
    wr(m.on, s, 2);
}

/// The path (its key, its index) gone.
#[inline(always)]
unsafe fn clear_path(m: &Mv, s: usize) {
    wr(m.nvpk, s, -1);
    wr(m.pidx, s, 0.0);
    wr(m.rkf, s, 0);
    wr(m.cd, s, -1);
}

/// An order done (simFlowArrive's end): idle, nothing issued, parked.
unsafe fn end_order(m: &Mv, s: usize) {
    clear_path(m, s);
    wc(m.cmd, s, 0);
    wc(m.tgx, s, f64::NAN);
    wc(m.tgy, s, f64::NAN);
    wr(m.amgx, s, -1);
    wr(m.amgy, s, -1);
    park_with(m, s, 16 | 128);
}

/// Armed in flow mode toward tile `dest` of navigation profile `profile` (the atlas: no field).
unsafe fn arm_common(m: &Mv, s: usize, profile: usize, dest: i32, cmd: i32, wide: bool) -> bool {
    if profile >= NAV_PROFILES || m.atlh[profile].is_null() {
        return false;
    }
    let ra = rd(m.rda, s);
    if cmd == 2 && ra == 255 {
        return false;
    }
    let fly = rd(m.slayer, s) == 1;
    wc(m.flow, s, NAV_ATLAS_FID);
    wr(m.fgen, s, 0);
    wc(m.dest, s, dest);
    wc(m.npr, s, profile as u8);
    wc(m.rdy, s, 0);
    wr(m.fl, s, 64 | if fly { 32 } else { 0 } | if cmd == 2 { 16 } else { 0 } | if wide { 0 } else { 128 });
    wc(m.reach, s, if cmd == 2 { ra } else { 0 });
    wc(m.wk, s, 0);
    wr(m.spent, s, 0);
    wr(m.cd, s, -1);
    if !m.steady.is_null() {
        wr(m.steady, s, 0);
    }
    wr(m.on, s, 1);
    true
}

/// A new way to tile `dest` under command cmd (1 move, 2 attack-move): the navigation's node written
/// as the path's columns (flownav.js navPathReach's single node; not checked reachable here: a way that is
/// not there is found by the flow, Unit.update's) and the unit armed on it.
unsafe fn issue_flow(m: &Mv, s: usize, dest: i32, cmd: i32, wide: bool) -> bool {
    let profile = if rd(m.slayer, s) == 1 { 1usize } else { 0usize };
    if !arm_common(m, s, profile, dest, cmd, wide) {
        return false;
    }
    let w = m.w;
    wr(m.nvpk, s, (profile as i32 * 16777216 + dest) * 2 + wide as i32);
    wr(m.pidx, s, 0.0);
    wc(m.rte, s, dest);
    wc(m.nvp, s, profile as i32);
    wc(m.cmd, s, cmd);
    wc(m.tgx, s, (irem_f(dest, w) as f64) * m.tile + 16.0);
    wc(m.tgy, s, (idiv(dest - irem_f(dest, w), w) as f64) * m.tile + 16.0);
    true
}

/// Parked holding a way it keeps (hold keeps the route and its progress).
unsafe fn park_held(m: &Mv, s: usize, cmd: i32) {
    park_with(m, s, if cmd == 2 { 16 } else { 0 });
    stand_here(m, s);
}

/// Whether the unit stands within arrival tolerance of its issued target (Unit._isNearIssuedTarget).
unsafe fn near_issued(m: &Mv, s: usize) -> bool {
    let tx = rd(m.tgx, s);
    let ty = rd(m.tgy, s);
    if !(tx == tx && ty == ty) {
        return false;
    }
    let mut spd = mv_stat(m, s, 0, m.spd);
    if st_frz(m, s) > 0 {
        spd *= 0.5;
    }
    if st_snd(m, s) > 0 {
        spd *= 0.5;
    }
    let tol = js_max(8.0, js_min(m.tile, floor(spd * 2.0)));
    let dx = tx - rd(m.x, s);
    let dy = ty - rd(m.y, s);
    sqrt(dx * dx + dy * dy) <= tol
}

/// Waiting for a way (a pending target: the helpers' answer, the pending
/// resolver's): parked with the arrival check on its issued target (flags 8,
/// mvTgX / mvTgY and the tolerance); near it, back to this controller.
unsafe fn park_route(m: &Mv, s: usize, cmd: i32) {
    let mut spd = mv_stat(m, s, 0, m.spd);
    if st_frz(m, s) > 0 {
        spd *= 0.5;
    }
    if st_snd(m, s) > 0 {
        spd *= 0.5;
    }
    wc(m.tgtol, s, js_max(8.0, js_min(m.tile, floor(spd * 2.0))));
    park_with(m, s, 8 | if cmd == 2 { 16 } else { 0 });
    stand_here(m, s);
}

/// simFlowArrive: the move is done (a flow's end or its crowd's edge). An
/// attack-mover short of its tile goes on as an individual; a unit with a
/// pending target keeps waiting for the navigation (near its issued target its
/// wait ends: an event, the main thread clears the pending target). 1: armed,
/// step on.
unsafe fn arrive(m: &Mv, s: usize) -> i32 {
    let cmd = rd(m.cmd, s);
    clear_path(m, s);
    if rd(m.pf, s) != 0 {
        if !near_issued(m, s) {
            park_route(m, s, cmd);
        } else {
            set_ev(m, s, EV_WAITED);
            stand_here(m, s);
        }
        return 0;
    }
    let (w, itile) = (m.w, m.itile);
    let tl = floor(rd(m.y, s) * itile) as i32 * w + floor(rd(m.x, s) * itile) as i32;
    if cmd == CMD_AM && rd(m.amgx, s) >= 0 && rd(m.holdf, s) == 0 {
        let am = rd(m.amgy, s) as i32 * w + rd(m.amgx, s) as i32;
        let rt = rd(m.rte, s);
        if tl != am && !(rt >= 0 && tl == rt) && issue_flow(m, s, am, CMD_AM, false) {
            return 1;
        }
    }
    end_order(m, s);
    stand_here(m, s);
    0
}

/// The idle rule (Unit.doIdle): an attack-move it was on goes on by the atlas
/// to its tile; else it parks (its aggro look, the periodic check). 1: armed.
unsafe fn idle_rule(m: &Mv, s: usize, tl: i32) -> i32 {
    if rd(m.amgx, s) >= 0 && rd(m.holdf, s) == 0 {
        let am = rd(m.amgy, s) as i32 * m.w + rd(m.amgx, s) as i32;
        if tl != am && issue_flow(m, s, am, CMD_AM, false) {
            return 1;
        }
    }
    park_with(m, s, 16 | 128);
    stand_here(m, s);
    0
}

// ---- scouts ----
/// Scouts explore toward the centres of a grid of at most this many cells a
/// side (a destination of its own by a hash of the tick and its id), by the
/// air atlas; arrived, they rest a moment (half a second, at least 8 ticks)
/// and take the next.
const SCOUT_CELLS: f64 = 32.0;
/// sim_unit_state.js simHashRand: a number in [0, 1) of (a, b, c).
#[inline(always)]
fn hash_rand(a: i32, b: i32, c: i32) -> f64 {
    let mut h = (a ^ 0x9e3779b9u32 as i32).wrapping_mul(0x85ebca6bu32 as i32)
        ^ b.wrapping_add(0x632be5ab).wrapping_mul(0xc2b2ae35u32 as i32)
        ^ c.wrapping_add(0x27d4eb2f).wrapping_mul(0x165667b1);
    h = (h ^ ((h as u32 >> 16) as i32)).wrapping_mul(0x7feb352d);
    h = (h ^ ((h as u32 >> 15) as i32)).wrapping_mul(0x846ca68bu32 as i32);
    ((h ^ ((h as u32 >> 16) as i32)) as u32) as f64 / 4294967296.0
}
/// A scout's rest after it got where it went (parked, no aggro look).
unsafe fn scout_rest(m: &Mv, p: &MoveP, s: usize) {
    park_with(m, s, 0);
    wr(m.wake, s, m.t + (p.tr / 2).max(8));
    stand_here(m, s);
}
/// A scout's next destination, armed on the atlas (1), else it rests (0).
unsafe fn scout_on(m: &Mv, p: &MoveP, s: usize, tl: i32) -> i32 {
    let (w, h) = (m.w, m.h);
    let step = js_max(1.0, ceil(js_max(w as f64, h as f64) / SCOUT_CELLS)) as i32;
    let id = rd(m.id, s);
    let cx = ceil(w as f64 / step as f64);
    let cy = ceil(h as f64 / step as f64);
    let gx = (floor(hash_rand(m.t, id, 1) * cx) as i32 * step + (step >> 1)).max(0).min(w - 1);
    let gy = (floor(hash_rand(m.t, id, 2) * cy) as i32 * step + (step >> 1)).max(0).min(h - 1);
    let dest = gy * w + gx;
    if dest != tl && issue_flow(m, s, dest, CMD_MOVE, false) {
        return 1;
    }
    scout_rest(m, p, s);
    0
}

// ---- attack orders ----
/// A hit listed for unitHitsResolve (target: a unit's slot, or -(tile + 2) a
/// structure's), with the attacker's shot (fire).
#[inline(always)]
unsafe fn list_hit(m: &Mv, p: &MoveP, s: usize, target: i32) {
    if m.hita.is_null() {
        return;
    }
    fire(m, s);
    hit_sty_count(m, p, s);
    let c = rd(m.hitc, p.chunk);
    wr(m.hita, p.s0 + c as usize, s as i32);
    wr(m.hitt, p.s0 + c as usize, target);
    wr(m.hitc, p.chunk, c + 1);
}
/// An attack of slot s listed in chunk p.chunk: counted when its style gives
/// a status (k.rs hit_one: 1-4, 5 a swoop's watch), the most status
/// sub-records the hits may take (unit.js unitHitsResolve).
#[inline(always)]
unsafe fn hit_sty_count(m: &Mv, p: &MoveP, s: usize) {
    if m.hsc.is_null() || m.asty.is_null() {
        return;
    }
    let a = rd(m.asty, s);
    if a >= 1 && a <= 5 {
        wr(m.hsc, p.chunk, rd(m.hsc, p.chunk) + 1);
    }
}

/// The unit's speed this tick (frozen, sandy: half).
#[inline(always)]
unsafe fn speed_now(m: &Mv, s: usize) -> f64 {
    let mut spd = mv_stat(m, s, 0, m.spd);
    if st_frz(m, s) > 0 {
        spd *= 0.5;
    }
    if st_snd(m, s) > 0 {
        spd *= 0.5;
    }
    spd
}

/// An attack order that ended (its target gone, out of sight, past its
/// leash): the order's targets cleared, idle, its attack-move (if any) taken
/// up again (idle_rule). 1: armed.
unsafe fn order_done(m: &Mv, s: usize, tl: i32) -> i32 {
    wr(m.tus, s, -1);
    wr(m.tuid, s, 0);
    wr(m.fatf, s, 0);
    wr(m.tbt, s, -1);
    wr(m.acqb, s, 0);
    wr(m.cmode, s, 0);
    wc(m.wk, s, 0);
    wr(m.on, s, 0);
    clear_path(m, s);
    wc(m.cmd, s, CMD_IDLE);
    wc(m.tgx, s, f64::NAN);
    wc(m.tgy, s, f64::NAN);
    idle_rule(m, s, tl)
}

/// Toward a target at (tx, ty) on tile tt, out of the unit's attack range:
/// straight when it flies, is within two tiles of it or the next step and the
/// target's tile are open ground within CHASE_DIRECT_TILES (6) (Unit
/// _isChaseStepOpen; sliding along walls), else by the ground atlas to the
/// open tile by it (the flow columns taken: mvOn 6, mvWk 4, mvHT the target's
/// tile; armed again when the target changes tiles). Always done this tick.
unsafe fn close_in(m: &Mv, p: &MoveP, s: usize, tx: f64, ty: f64, tt: i32) -> i32 {
    let (w, h, tile, itile) = (m.w, m.h, m.tile, m.itile);
    let x = rd(m.x, s);
    let y = rd(m.y, s);
    let gx = floor(x * itile) as i32;
    let gy = floor(y * itile) as i32;
    let fly = rd(m.slayer, s) == 1;
    let dx = tx - x;
    let dy = ty - y;
    let d = sqrt(dx * dx + dy * dy);
    let spd = speed_now(m, s);
    if !(d > spd) || !(spd > 0.0) {
        wr(m.on, s, 0);
        stand_here(m, s);
        return 0;
    }
    let mut direct = fly || d < 2.0 * tile;
    if !direct && d < 6.0 * tile {
        let st = mv_stat(m, s, 2, m.chs);
        let agx = floor((x + dx / d * st) * itile);
        let agy = floor((y + dy / d * st) * itile);
        direct = inb(agx, w) && inb(agy, h) && rd(m.wall, (agy as i32 * w + agx as i32) as usize) == 0 && rd(m.wall, tt as usize) == 0;
    }
    if direct {
        wr(m.on, s, 0);
        let mut vx = dx / d * spd;
        let mut vy = dy / d * spd;
        if m.dk > 1 {
            // (Several base ticks, short of the target by a base tick's step;
            // one base tick's when the way has walls.)
            let st = js_min(spd * m.dkf, d - spd);
            let (ax, ay) = (dx / d * st, dy / d * st);
            if fly || seg_open(m.wall, w, h, x, y, x + ax, y + ay, itile, tile) {
                vx = ax;
                vy = ay;
            }
        }
        if !fly {
            let sl = flow_slide(m.wall, w, h, gx, gy, floor((x + vx) * itile), floor((y + vy) * itile));
            if (sl & 1) != 0 {
                vx = 0.0;
            }
            if (sl & 2) != 0 {
                vy = 0.0;
            }
        }
        let nx = (x + vx) as f32 as f64;
        let ny = (y + vy) as f32 as f64;
        let qx = if nx.is_finite() { js_round(nx * p.q) * p.iq } else { x };
        let qy = if ny.is_finite() { js_round(ny * p.q) * p.iq } else { y };
        let (qx, qy) = checked_position(m, s, qx, qy);
        wr(m.px, s, x);
        wr(m.py, s, y);
        wr(m.x, s, qx);
        wr(m.y, s, qy);
        wr(m.vx, s, vx);
        wr(m.vy, s, vy);
        wr(m.out, s, if floor(qx * itile) as i32 != gx || floor(qy * itile) as i32 != gy { 3 } else { 1 });
        return 0;
    }
    if rd(m.on, s) != 6 || rd(m.wk, s) != 4 || rd(m.ht, s) != tt {
        let nv = m.nav.get_unchecked(0);
        let wl = if nv.walls.is_null() { m.wall } else { nv.walls };
        let dest = approach_tile(wl, w, h, tt);
        if dest < 0 || m.atlh[0].is_null() {
            wr(m.on, s, 0);
            stand_here(m, s);
            return 0;
        }
        wc(m.flow, s, NAV_ATLAS_FID);
        wr(m.fgen, s, 0);
        wc(m.dest, s, dest);
        wc(m.npr, s, 0);
        wc(m.rdy, s, 0);
        wr(m.fl, s, 64 | 128);
        wc(m.reach, s, 0);
        wc(m.ht, s, tt);
        wc(m.htid, s, 0);
        wc(m.wk, s, 4);
        wr(m.spent, s, 0);
        wr(m.cd, s, -1);
        wr(m.on, s, 6);
    }
    move_flow(m, p, s);
    if !m.steady.is_null() {
        wr(m.steady, s, 0);
    }
    if rd(m.on, s) == 0 || rd(m.out, s) == 0 {
        // (There, or no way on from here: it stands and looks again next tick.)
        if !m.ev.is_null() && rd(m.ev, s) == EV_NOWAY {
            wr(m.ev, s, 0);
        }
        wr(m.on, s, 0);
        stand_here(m, s);
    }
    0
}

/// A unit attacking by order (commandState 3): a player's attack on a unit
/// (forced, unit.fatF: kept while its tile is in sight or the two touch, no
/// leash; out of sight it goes on to where it saw it last, unit.fLsX / fLsY),
/// on a structure (unit.tbT: kept while it stands hostile and in sight), or a
/// unit target not forced (an old order: lost out of sight or past eight
/// tiles). Unit.doAttacking's rules in O(1) a tick: in its attack range it
/// stands and fires (the hit listed), held it stands, else it closes in
/// (close_in). Whether it is in range: worked out here up to two area steps,
/// beyond that the combat brain's word (cmMode 32, its target the order's:
/// k_combat_brain). An order that ended leaves it idle (order_done) or moving
/// to the last seen position. 1: armed, the flow step follows.
#[cfg_attr(feature = "prof", inline(never))]
unsafe fn forced(m: &Mv, p: &MoveP, s: usize) -> i32 {
    let (w, h, tile, itile) = (m.w, m.h, m.tile, m.itile);
    if !m.steady.is_null() && rd(m.steady, s) != 0 {
        wr(m.steady, s, 0);
    }
    if !(rd(m.en, s) > 0.0) || rd(m.dead, s) != 0 {
        wr(m.on, s, 0);
        return 0;
    }
    let owner = rd(m.own, s);
    let x = rd(m.x, s);
    let y = rd(m.y, s);
    let gxf = floor(x * itile);
    let gyf = floor(y * itile);
    if !(owner >= 0 && owner < p.players) || !(inb(gxf, w) && inb(gyf, h)) || rd(m.sep, s) as f64 == p.absent {
        wr(m.on, s, 0);
        set_ev(m, s, EV_SPATIAL);
        return 0;
    }
    let tl = gyf as i32 * w + gxf as i32;
    if rd(m.floor, s) != tl || irem_f(m.t.wrapping_add(rd(m.id, s)), p.tr) < m.dk {
        let code = rd(m.sc, tl as usize) as i32;
        if code != -1 && code != owner && floor_hit(m, s, tl) {
            wr(m.on, s, 0);
            set_ev(m, s, EV_FLOOR);
            stand_here(m, s);
            return 0;
        }
        wr(m.floor, s, tl);
    }
    let hold = rd(m.holdf, s) != 0;
    let k = rd(m.rk, s) as i32;
    let cm = rd(m.cmode, s);
    let tid = rd(m.tuid, s);
    if tid != 0 {
        let q = rd(m.tus, s);
        if q < 0 || rd(m.dead, q as usize) != 0 || rd(m.id, q as usize) != tid {
            return order_done(m, s, tl);
        }
        let qu = q as usize;
        let tx = rd(m.x0, qu);
        let ty = rd(m.y0, qu);
        let tgx = floor(tx * itile);
        let tgy = floor(ty * itile);
        let forcedf = rd(m.fatf, s) != 0;
        let tt = if inb(tgx, w) && inb(tgy, h) { tgy as i32 * w + tgx as i32 } else { -1 };
        let seen = tt >= 0
            && ((!m.ag.is_null() && covered(m, owner, rd(m.ag, tt as usize))) || (forcedf && in_contact_range(m, p.pad, s, qu, x, y, tx, ty, k) != 0));
        if !seen {
            if !forcedf {
                return order_done(m, s, tl);
            }
            // On to where it was seen last.
            let lx = rd(m.lsx, s);
            let ly = rd(m.lsy, s);
            let (lx, ly) = if lx == lx && ly == ly { (lx, ly) } else { (tx, ty) };
            let r = order_done(m, s, tl);
            if r == 1 {
                return 1;
            }
            let lgx = (floor(lx * itile) as i32).max(0).min(w - 1);
            let lgy = (floor(ly * itile) as i32).max(0).min(h - 1);
            let nv = m.nav.get_unchecked(if rd(m.slayer, s) == 1 { 1 } else { 0 });
            let wl = if nv.walls.is_null() { m.wall } else { nv.walls };
            let dest = if rd(m.slayer, s) == 1 { lgy * w + lgx } else { approach_tile(wl, w, h, lgy * w + lgx) };
            if dest >= 0 && dest != tl && issue_flow(m, s, dest, CMD_MOVE, false) {
                return 1;
            }
            return 0;
        }
        if forcedf {
            wr(m.lsx, s, tx);
            wr(m.lsy, s, ty);
        }
        let mut inr = (cm & 48) == 32 && rd(m.cmt, s) == q && rd(m.ctid, s) == tid && (cm & 3) == 1;
        if k <= 2 {
            let r = in_attack_range(m, p.pad, s, qu, x, y, tx, ty, k);
            if r == 1 {
                inr = true;
            } else if r == 0 {
                inr = false;
            }
        }
        if inr {
            wr(m.on, s, 0);
            if !(rd(m.at, s) > 0.0) {
                list_hit(m, p, s, q);
            }
            stand_here(m, s);
            return 0;
        }
        if !forcedf && sqrt((tx - x) * (tx - x) + (ty - y) * (ty - y)) > 8.0 * tile {
            return order_done(m, s, tl);
        }
        if hold {
            wr(m.on, s, 0);
            stand_here(m, s);
            return 0;
        }
        return close_in(m, p, s, tx, ty, tt);
    }
    let t = rd(m.tbt, s);
    let valid = t >= 0 && (t as i64) < (w as i64) * (h as i64) && !m.ag.is_null() && !m.sc.is_null() && {
        let code = rd(m.sc, t as usize) as i32;
        code != -1 && code != owner && covered(m, owner, rd(m.ag, t as usize))
    };
    if !valid {
        return order_done(m, s, tl);
    }
    let tx0 = irem_f(t, w);
    let tx = tx0 as f64 * tile + tile / 2.0;
    let ty = idiv(t - tx0, w) as f64 * tile + tile / 2.0;
    let mut inr = (cm & 48) == 48 && rd(m.cmt, s) == t && (cm & 3) == 1;
    if k <= 2 {
        let r = in_area_range(m, x, y, tx, ty, k);
        if r == 1 {
            inr = true;
        } else if r == 0 {
            inr = false;
        }
    }
    if inr {
        wr(m.on, s, 0);
        if !(rd(m.at, s) > 0.0) {
            list_hit(m, p, s, -(t + 2));
        }
        stand_here(m, s);
        return 0;
    }
    if hold {
        wr(m.on, s, 0);
        stand_here(m, s);
        return 0;
    }
    close_in(m, p, s, tx, ty, t)
}

/// The controller for slot s (see above). 1: armed, the flow step follows this
/// tick; 0: done (out written), or an event, or dead (out 0).
#[cfg_attr(feature = "prof", inline(never))]
unsafe fn ctl(m: &Mv, p: &MoveP, s: usize) -> i32 {
    let (w, h, itile) = (m.w, m.h, m.itile);
    let owner = rd(m.own, s);
    if !(rd(m.en, s) > 0.0) {
        return 0;
    }
    let cmd = rd(m.cmd, s);
    if cmd == CMD_ATK {
        return forced(m, p, s);
    }
    let x = rd(m.x, s);
    let y = rd(m.y, s);
    let gxf = floor(x * itile);
    let gyf = floor(y * itile);
    if !(owner >= 0 && owner < p.players) || !(inb(gxf, w) && inb(gyf, h)) || rd(m.sep, s) as f64 == p.absent {
        set_ev(m, s, EV_SPATIAL);
        return 0;
    }
    let tl = gyf as i32 * w + gxf as i32;
    // (A hostile mine under it, or a floor this cannot tell: the main thread's.)
    if rd(m.floor, s) != tl || irem_f(m.t.wrapping_add(rd(m.id, s)), p.tr) < m.dk {
        let code = rd(m.sc, tl as usize) as i32;
        if code != -1 && code != owner && floor_hit(m, s, tl) {
            set_ev(m, s, EV_FLOOR);
            stand_here(m, s);
            return 0;
        }
        wr(m.floor, s, tl);
    }
    let scout = !m.scoutt.is_null() && rd(m.upt, s) as i32 == rd(m.scoutt, 0);
    let r = ctl_order(m, p, s, cmd, tl);
    // (A scout whose move ended rests a moment, then goes on.)
    if scout && r == 0 && rd(m.cmd, s) == CMD_IDLE && rd(m.on, s) == 2 && rd(m.holdf, s) == 0 && (rd(m.fl, s) & 128) != 0 {
        scout_rest(m, p, s);
    }
    r
}

/// The order's part of ctl: tile tl the unit's.
#[inline(always)]
unsafe fn ctl_order(m: &Mv, p: &MoveP, s: usize, cmd: i32, tl: i32) -> i32 {
    // (Arrived in a crowd at its destination: marked by the flow.)
    if rd(m.wk, s) == 5 {
        wc(m.wk, s, 0);
        return arrive(m, s);
    }
    let hold = rd(m.holdf, s) != 0;
    match cmd {
        CMD_IDLE => {
            if !hold && !m.scoutt.is_null() && rd(m.upt, s) as i32 == rd(m.scoutt, 0) {
                return scout_on(m, p, s, tl);
            }
            idle_rule(m, s, tl)
        }
        CMD_MOVE | CMD_AM => {
            let pk = rd(m.nvpk, s);
            let pending = rd(m.pf, s) != 0;
            if pk >= 0 && rd(m.pidx, s) < 1.0 {
                let key = pk >> 1;
                let profile = (key / 16777216) as usize;
                let dest = key - (profile as i32) * 16777216;
                if hold {
                    park_held(m, s, cmd);
                    return 0;
                }
                if tl == dest {
                    return arrive(m, s);
                }
                if arm_common(m, s, profile, dest, cmd, (pk & 1) != 0) {
                    return 1;
                }
                // (No atlas for its profile yet: it stands, and looks again next tick.)
                stand_here(m, s);
                return 0;
            }
            // (Its path used up, its route not: on toward the route's end, as a group.)
            let rt = rd(m.rte, s);
            if rd(m.rkf, s) == 1 && rt >= 0 && tl != rt && !pending && !hold {
                let profile = if rd(m.slayer, s) == 1 { 1usize } else { 0usize };
                if arm_common(m, s, profile, rt, cmd, true) {
                    wr(m.nvpk, s, (profile as i32 * 16777216 + rt) * 2 + 1);
                    wr(m.pidx, s, 0.0);
                    return 1;
                }
                stand_here(m, s);
                return 0;
            }
            if pending {
                if !near_issued(m, s) {
                    park_route(m, s, cmd);
                } else {
                    set_ev(m, s, EV_WAITED);
                    stand_here(m, s);
                }
                return 0;
            }
            // (Nothing to follow: the order ends where it stands.)
            end_order(m, s);
            stand_here(m, s);
            0
        }
        CMD_HOLD_OLD => {
            // (An old snapshot's holding state: hold is a flag now.)
            wc(m.holdf, s, 1);
            wc(m.cmd, s, CMD_IDLE);
            idle_rule(m, s, tl)
        }
        _ => {
            stand_here(m, s);
            0
        }
    }
}

/// _simMoveCombat: the combat brain's instruction for slot s (cmMode bits
/// 0-1 the move: 0 own, 1 stand, 2 toward the target; bit 4 fire; bit 16 the
/// target is a structure, move_struct). False:
/// the unit's own move this tick (ended, or fire only).
#[cfg_attr(feature = "prof", inline(never))]
unsafe fn move_combat(m: &Mv, p: &MoveP, s: usize) -> bool {
    if !(rd(m.en, s) > 0.0) || rd(m.sep, s) as f64 == p.absent || rd(m.dead, s) != 0 {
        wr(m.cmode, s, 0);
        wr(m.on, s, 0);
        return false;
    }
    let cm = rd(m.cmode, s);
    // (Waiting for the brain's next word, CM_WAIT below; still attack-moving.)
    if cm == CM_WAIT {
        if rd(m.cmd, s) != CMD_AM {
            wr(m.cmode, s, 0);
            return false;
        }
        stand_here(m, s);
        return true;
    }
    if (cm & 16) != 0 {
        return move_struct(m, p, s, cm);
    }
    let q = rd(m.cmt, s);
    if q < 0 || rd(m.dead, q as usize) != 0 || rd(m.id, q as usize) != rd(m.ctid, s) {
        // (An attack-mover that stood fighting when its target fell waits there
        // for the brain's next word (one cycle of SIM_ACQUIRE_TICKS, a step of
        // several base ticks) rather than walk on past the fight meanwhile.)
        if (cm & 3) == 1 && rd(m.cmd, s) == CMD_AM && rd(m.holdf, s) == 0 {
            wr(m.cmode, s, CM_WAIT);
            stand_here(m, s);
            return true;
        }
        wr(m.cmode, s, 0);
        return false;
    }
    if (cm & 4) != 0 && !(rd(m.at, s) > 0.0) && !m.hita.is_null() {
        fire(m, s);
        hit_sty_count(m, p, s);
        let c = rd(m.hitc, p.chunk);
        wr(m.hita, p.s0 + c as usize, s as i32);
        wr(m.hitt, p.s0 + c as usize, q);
        wr(m.hitc, p.chunk, c + 1);
    }
    let mv = cm & 3;
    if mv == 0 {
        return false;
    }
    let qu = q as usize;
    let x = rd(m.x, s);
    let y = rd(m.y, s);
    wr(m.px, s, x);
    wr(m.py, s, y);
    if mv == 1 {
        wr(m.vx, s, 0.0);
        wr(m.vy, s, 0.0);
        wr(m.out, s, 1);
        return true;
    }
    let dx = rd(m.x0, qu) - x;
    let dy = rd(m.y0, qu) - y;
    let d = sqrt(dx * dx + dy * dy);
    let mut spd = mv_stat(m, s, 0, m.spd);
    if st_frz(m, s) > 0 {
        spd *= 0.5;
    }
    if st_snd(m, s) > 0 {
        spd *= 0.5;
    }
    if !(d > spd) || !(spd > 0.0) {
        wr(m.vx, s, 0.0);
        wr(m.vy, s, 0.0);
        wr(m.out, s, 1);
        return true;
    }
    let (w, h, itile) = (m.w, m.h, m.itile);
    let mut vx = dx / d * spd;
    let mut vy = dy / d * spd;
    let gx = floor(x * itile) as i32;
    let gy = floor(y * itile) as i32;
    if m.dk > 1 {
        // (Several base ticks, short of the target by a base tick's step;
        // one base tick's when the way has walls.)
        let st = js_min(spd * m.dkf, d - spd);
        let (ax, ay) = (dx / d * st, dy / d * st);
        if rd(m.slayer, s) == 1 || seg_open(m.wall, w, h, x, y, x + ax, y + ay, itile, m.tile) {
            vx = ax;
            vy = ay;
        }
    }
    if rd(m.slayer, s) != 1 {
        let sl = flow_slide(m.wall, w, h, gx, gy, floor((x + vx) * itile), floor((y + vy) * itile));
        if (sl & 1) != 0 {
            vx = 0.0;
        }
        if (sl & 2) != 0 {
            vy = 0.0;
        }
    }
    let nx = (x + vx) as f32 as f64;
    let ny = (y + vy) as f32 as f64;
    let qx = if nx.is_finite() { js_round(nx * p.q) * p.iq } else { x };
    let qy = if ny.is_finite() { js_round(ny * p.q) * p.iq } else { y };
    let (qx,qy)=checked_position(m,s,qx,qy);
    wr(m.x,s,qx);
    wr(m.y,s,qy);
    wr(m.vx, s, vx);
    wr(m.vy, s, vy);
    wr(m.out, s, if floor(qx * itile) as i32 != gx || floor(qy * itile) as i32 != gy { 3 } else { 1 });
    true
}
/// _simMovePre for slot s: 0 done, 1 on to the flow, 2 on to the path. A unit
/// that is not a worker and came out of it unarmed with nothing written for it
/// (handed back) goes to the unit controller (ctl).
#[cfg_attr(feature = "prof", inline(never))]
unsafe fn move_pre(m: &Mv, p: &MoveP, s: usize) -> i32 {
    let r = move_pre0(m, p, s);
    if r == 0 && !m.holdf.is_null() && rd(m.out, s) == 0 && rd(m.on, s) == 0 && rd(m.dead, s) == 0 && rd(m.iswk, s) == 0 {
        return ctl(m, p, s);
    }
    r
}
#[cfg_attr(feature = "prof", inline(never))]
unsafe fn move_pre0(m: &Mv, p: &MoveP, s: usize) -> i32 {
    let (t, w, h, tile, itile) = (m.t, m.w, m.h, m.tile, m.itile);
    // (Stores only where the value changes: most slots keep 0 / their copy.)
    if rd(m.fire, s) != 0 { wr(m.fire, s, 0); }
    if !p.step_ran {
        let dead = rd(m.dead, s);
        if rd(m.d0, s) != dead { wr(m.d0, s, dead); }
    }
    if rd(m.stept, s - m.stepbase) == 1 {
        return 0;
    }
    wr(m.out, s, 0);
    // (An attack order: the controller's, every tick.)
    if !m.holdf.is_null() && rd(m.cmd, s) == CMD_ATK && rd(m.iswk, s) == 0 {
        return forced(m, p, s);
    }
    // (The brain's word on an attack order that has ended since: dropped.)
    if BRAIN && (rd(m.cmode, s) & 32) != 0 {
        wr(m.cmode, s, 0);
    }
    // (An instruction of the combat brain: followed in O(1).)
    if BRAIN && rd(m.cmode, s) != 0 && move_combat(m, p, s) {
        return 0;
    }
    // (A structure instruction that ended: its order again.)
    if BRAIN && rd(m.cmode, s) == 0 && rd(m.wk, s) == 4 {
        resume_order(m, s);
    }
    let on = rd(m.on, s);
    if on == 0 {
        return 0;
    }
    macro_rules! back {
        () => {{
            wr(m.on, s, 0);
            return 0;
        }};
    }
    if !(rd(m.en, s) > 0.0) || rd(m.sep, s) as f64 == p.absent || rd(m.dead, s) != 0 {
        back!();
    }
    let parked = on == 2;
    let id0 = rd(m.id, s);
    if parked && (rd(m.fl, s) & 4) != 0 && rem64_f(tsum(t, id0), p.wkwatch) < m.dk as i64 {
        wk_watch(m, s, t);
    }
    if parked && t >= rd(m.wake, s) {
        let mut stay = false;
        if (rd(m.fl, s) & 2) != 0 && !m.wkv.is_null() && (t as f64) < rd(m.wksc, wki(m, s)) && (t as f64) < rd(m.wku, wki(m, s)) && rem64_f(tsum(t, id0), p.wkper as i64) < m.dk as i64 {
            let gx = floor(rd(m.x, s) * itile);
            let gy = floor(rd(m.y, s) * itile);
            let o = rd(m.own, s);
            if o >= 0 && o < p.wknp {
                stay = wk_stay(m, p, s, gx, gy, o);
                if stay {
                    wr(m.wake, s, to_i32(js_min((t + p.wkper) as f64, rd(m.wksc, wki(m, s)))));
                }
            }
        }
        // A combat unit's periodic check (mvFlags 128 on its aggro park, simMoveTryParkIdle):
        // its update would do nothing the kernel does not (the brain's units are
        // engaged by instruction, cmode; the floor is looked at every tick below),
        // so it stays parked until its next phase of IDLE_PARK_TICKS.
        if !stay && BRAIN && (rd(m.fl, s) & 144) == 144 && rd(m.cmode, s) == 0 {
            wr(m.wake, s, t + IDLE_PARK_TICKS - irem_f(t.wrapping_add(id0), IDLE_PARK_TICKS));
            stay = true;
        }
        if !stay {
            back!();
        }
    }
    let f = rd(m.fl, s);
    let id = id0;
    let owner = rd(m.own, s);
    let x = rd(m.x, s);
    let y = rd(m.y, s);
    let gxf = floor(x * itile);
    let gyf = floor(y * itile);
    if !(owner >= 0 && owner < p.players) || !(inb(gxf, w) && inb(gyf, h)) {
        back!();
    }
    let (gx, gy) = (gxf as i32, gyf as i32);
    let tl = gy * w + gx;
    let tw = t.wrapping_add(id);
    let ts = tsum(t, id);
    if rd(m.floor, s) != tl || irem_f(tw, p.tr) < m.dk {
        let code = rd(m.sc, tl as usize) as i32;
        if code != -1 && code != owner && floor_hit(m, s, tl) {
            set_ev(m, s, EV_FLOOR);
            back!();
        }
        wr(m.floor, s, tl);
    }
    if parked {
        // (Waiting for its way: near enough to where it was sent, the
        // controller's look, mv.rs ctl.)
        if (f & 8) != 0 && !m.tgx.is_null() && !m.tgy.is_null() && !m.tgtol.is_null() {
            let dx = rd(m.tgx, s) - x;
            let dy = rd(m.tgy, s) - y;
            if !(sqrt(dx * dx + dy * dy) > rd(m.tgtol, s)) {
                back!();
            }
        }
        wr(m.px, s, x);
        wr(m.py, s, y);
        wr(m.out, s, 1);
        return 0;
    }
    if (f & 64) != 0 { 1 } else { 2 }
}

/// A parked builder's watchdog sample (worker.js updateWorkerAI's): moved two
/// pixels or more since the last one: it moved now; the sample where it is.
#[inline(always)]
unsafe fn wk_watch(m: &Mv, s: usize, t: i32) {
    // (Its worker record; none: record 0, the defaults, never written.)
    let w = wki(m, s);
    if w == 0 {
        return;
    }
    let (x, y) = (rd(m.x, s), rd(m.y, s));
    let (wx, wy) = (rd(m.wkwx, w), rd(m.wkwy, w));
    if wx - wx != 0.0 || wy - wy != 0.0 {
        if !m.wklmt.is_null() { wr(m.wklmt, w, t); }
    } else {
        let (dx, dy) = (x - wx, y - wy);
        if sqrt(dx * dx + dy * dy) >= 2.0 && !m.wklmt.is_null() {
            wr(m.wklmt, w, t);
        }
    }
    wr(m.wkwx, w, x);
    wr(m.wkwy, w, y);
}
/// Slot s's worker record (unit.wkIx; 0: none, the defaults' record).
#[inline(always)]
unsafe fn wki(m: &Mv, s: usize) -> usize {
    let w = rd(m.wkix, s);
    if w > 0 { w as usize } else { 0 }
}

/// An idle worker's search would return at once (its work hash as at its
/// failed search): _simMovePre's `stay`.
unsafe fn wk_stay(m: &Mv, p: &MoveP, s: usize, gx: f64, gy: f64, o: i32) -> bool {
    // (Reads past the table: JavaScript's undefined, 0 in Math.imul, NaN
    // in a sum.)
    let get = |i: i64| -> Option<i32> {
        if i >= 0 && (i as usize) < m.wkvn { Some(rd(m.wkv, i as usize)) } else { None }
    };
    let nan = |v: Option<i32>| -> f64 {
        match v {
            Some(x) => x as f64,
            None => f64::NAN,
        }
    };
    let span = 1 + p.wkrw as i64 * p.wkrh as i64;
    let all = (o as i64 * p.wktypes as i64) * span;
    let w = wki(m, s);
    let mine = (o as i64 * p.wktypes as i64 + rd(m.wkty, w) as i64) * span;
    let d = rd(m.wkd, w) as f64;
    let tw = rd(m.wktw, w);
    let mut hh = to_i32(imul(get(all).unwrap_or(0), 31) as f64 + nan(get(mine)));
    if tw & 2 != 0 {
        hh = imul(hh, 31).wrapping_add(p.wkhgen);
    }
    let passes = if tw & 1 != 0 { 2 } else { 1 };
    let wkr = p.wkr as f64;
    for pass in 0..passes {
        let (cx, cy) = if pass != 0 || (tw & 1) == 0 { (gx, gy) } else { (rd(m.wkox, w) as f64, rd(m.wkoy, w) as f64) };
        let ry0 = js_max(0.0, floor((cy - d) / wkr));
        let ry1 = js_min((p.wkrh - 1) as f64, floor((cy + d) / wkr));
        let rx0 = js_max(0.0, floor((cx - d) / wkr));
        let rx1 = js_min((p.wkrw - 1) as f64, floor((cx + d) / wkr));
        if !(ry0 == ry0 && ry1 == ry1) {
            continue;
        }
        let mut ry = ry0;
        while ry <= ry1 {
            // (The inner bounds: NaN, no columns.)
            if rx0 == rx0 && rx1 == rx1 {
                let mut rx = rx0;
                while rx <= rx1 {
                    let r = 1 + ry as i64 * p.wkrw as i64 + rx as i64;
                    hh = to_i32((imul(hh, 31) as f64 + imul(get(all + r).unwrap_or(0), 7) as f64) + nan(get(mine + r)));
                    rx += 1.0;
                }
            }
            ry += 1.0;
        }
    }
    hh == rd(m.wkf, w)
}

/// _simMoveFlow for slot s.
#[cfg_attr(feature = "prof", inline(never))]
unsafe fn move_flow(m: &Mv, p: &MoveP, s: usize) {
    let (t, w, h, tile, itile) = (m.t, m.w, m.h, m.tile, m.itile);
    let f = rd(m.fl, s);
    let id = rd(m.id, s);
    let x = rd(m.x, s);
    let y = rd(m.y, s);
    let gx = floor(x * itile) as i32;
    let gy = floor(y * itile) as i32;
    let tl = gy * w + gx;
    let tw = t.wrapping_add(id);
    macro_rules! back {
        () => {{
            wr(m.on, s, 0);
            return;
        }};
    }
    macro_rules! stand {
        () => {{
            wr(m.px, s, x);
            wr(m.py, s, y);
            wr(m.out, s, 1);
            return;
        }};
    }
    // (A worker at its task: its AI looks on its check ticks, after the kernel; it moves on.)
    if rd(m.wk, s) == 1 && irem_f(tw, p.wcheck) < m.dk && !(rd(m.wtc, s) > 0) {
        set_ev(m, s, EV_CHECK);
    }
    let dk = rd(m.dest, s);
    let dx0 = irem_f(dk, w);
    let dy0 = idiv(dk - dx0, w);
    let fly = (f & 32) != 0;
    let np = rd(m.npr, s) as usize;
    let navp = if np < NAV_PROFILES { Some(m.nav.get_unchecked(np)) } else { None };
    let wl = match navp {
        Some(n) if !n.walls.is_null() => n.walls,
        _ => {
            if fly { m.airw } else { m.wall }
        }
    };
    let fid = rd(m.flow, s);
    // (On the atlas: no destination field to check, ready at once.)
    let on_atl = fid == NAV_ATLAS_FID;
    let atlh = if on_atl && np < NAV_PROFILES { *m.atlh.get_unchecked(np) } else { 0 as *const i32 };
    if on_atl && atlh.is_null() {
        back!();
    }
    let wide = !on_atl && fid >= 4194304;
    let did = if on_atl { 0 } else if wide { fid - 4194304 } else { fid };
    let dm = (did as i64 * 8) as usize;
    let (fmeta, fmn, fpool) = if wide { (m.fmw, m.fmwn, m.fpw) } else { (m.fmn, m.fmnn, m.fpn) };
    if !on_atl && (!(fid >= 0) || fmeta.is_null() || dm + 7 >= fmn || rd(fmeta, dm + 1) != dk) {
        back!();
    }
    if !on_atl && rd(fmeta, dm + 6) != rd(m.fgen, s) {
        // (Its destination's field made again (a navigation build installed):
        // the same slot and destination, its new generation taken here, as
        // _simMoveTryFlowArm would; its committed step dropped.)
        if rd(fmeta, dm + 7) != 1 {
            back!();
        }
        wr(m.fgen, s, rd(fmeta, dm + 6));
        wr(m.cd, s, -1);
        if !m.steady.is_null() { wr(m.steady, s, 0); }
    }
    if t < rd(m.rdy, s) {
        stand!();
    }
    if !on_atl && rd(fmeta, dm + 7) != 1 {
        back!();
    }
    // (The committed step is per base tick; several a step leaving the tile
    // are steered again below.)
    if rd(m.cd, s) == dk && rd(m.ctl, s) == tl && t - rd(m.ct, s) < rd(m.cn, s) as i32
        && (m.dk == 1 || (floor((x + rd(m.cvx, s) * m.dkf) * itile) == gx as f64 && floor((y + rd(m.cvy, s) * m.dkf) * itile) == gy as f64)) {
        if tl == dk {
            back!();
        }
        let mut vx = rd(m.cvx, s) * m.dkf;
        let mut vy = rd(m.cvy, s) * m.dkf;
        let sgx = floor((x + vx) * itile);
        let sgy = floor((y + vy) * itile);
        if (f & 32) == 0 && (sgx != gx as f64 || sgy != gy as f64) {
            let sl = flow_slide(wl, w, h, gx, gy, sgx, sgy);
            if sl != 0 {
                if sl & 1 != 0 {
                    vx = 0.0;
                }
                if sl & 2 != 0 {
                    vy = 0.0;
                }
                wr(m.cd, s, -1);
            if !m.steady.is_null() { wr(m.steady, s, 0); }
            }
        }
        commit_step(m, s, x, y, vx, vy, gx, gy, tl, p.q, p.iq);
        return;
    }
    wr(m.cd, s, -1);
            if !m.steady.is_null() { wr(m.steady, s, 0); }
    let nv = match navp {
        Some(n) => n,
        None => back!(),
    };
    let rows = if on_atl { 0 as *const u8 } else if wide { m.frw } else { m.frn };
    let rw = if on_atl { 1 } else if m.fhd.is_null() { 0 } else { rd(m.fhd, if wide { 1 } else { 0 }) };
    if nv.fields.is_null() || nv.meta.is_null() || nv.partl.is_null() || nv.partb.is_null() || (!on_atl && rows.is_null()) || !(rw > 0) {
        back!();
    }
    let n_c = rd(nv.meta, 0);
    let ncw = rd(nv.meta, 1);
    let span = if wide { 3 * n_c } else { n_c };
    if tl == dk {
        back!();
    }
    let nld = rd(m.nld, s);
    if nld == (-2 - dk) as f64 {
        let look = (tw & 15) < m.dk;
        if !look || ((tw & 63) >= m.dk && !(rd(m.cwt, s) == t && rd(m.cwd, s) < 9)) {
            stand!();
        }
        wr(m.nld, s, -1.0);
    }
    let mut nav_ld = -1.0;
    if (f & 128) == 0 && (dx0 - gx).abs() <= 64 && (dy0 - gy).abs() <= 64 {
        let ex = dx0 as f64 * tile + 16.0 - x;
        let ey = dy0 as f64 * tile + 16.0 - y;
        let now = sqrt(ex * ex + ey * ey);
        let last = rd(m.nld, s);
        let mut es = mv_stat(m, s, 0, m.spd);
        if st_frz(m, s) > 0 {
            es *= 0.5;
        }
        if st_snd(m, s) > 0 {
            es *= 0.5;
        }
        let near = (dx0 - gx).abs() <= 8 && (dy0 - gy).abs() <= 8;
        // At a full destination crowd's edge: arrived before pressing into
        // it (unit.js _unitCrowdFull).
        if near && rd(m.cwt, s) == t && rd(m.cwn, s) != 0 && rd(m.cwd, s) >= SIM_CROWD_FULL {
            wc(m.wk, s, 5);
            back!();
        }
        // (The progress expected since the last look: its base ticks, at
        // least a step's.)
        if last >= 0.0 && last - now < es * 0.3 * (SIM_STEER_NEAR_TICKS as i32).max(m.dk) as f64 {
            // (Held at a full crowd's edge: arrived, however far its middle
            // is: a big crowd is wider than `near`.)
            if (near || (rd(m.cwd, s) >= SIM_CROWD_FULL && rd(m.cwn, s) == 2)) && rd(m.cwt, s) == t && rd(m.cwn, s) != 0 {
                wc(m.wk, s, 5);
                back!();
            }
            if rd(m.cwt, s) == t && rd(m.cwn, s) != 0 {
                wr(m.nld, s, (-2 - dk) as f64);
                stand!();
            }
        }
        nav_ld = now;
    }
    // The look-ahead (simFlowLook): clusters of 2^cs tiles.
    let cs = 31 - (n_c as u32).leading_zeros() as i32;
    let v = Nav {
        atl: atlh,
        step_cache: m.nav_step_cache,
        w,
        h,
        cs,
        c: n_c,
        cw: ncw,
        pl: nv.partl,
        plh: if w > 0 { (nv.partln as i64).wrapping_div(w as i64) as i32 } else { 0 },
        pb: nv.partb,
        rows,
        ro: did * rw,
        fields: nv.fields,
        nb: nv.nb,
        nt: nv.nt,
        np: nv.np,
        df: if on_atl { 0 as *const u16 } else { fpool },
        doff: did * span * span,
        bx: if on_atl { 0 } else { rd(fmeta, dm + 2) },
        by: if on_atl { 0 } else { rd(fmeta, dm + 3) },
        bw: if on_atl { 0 } else { rd(fmeta, dm + 4) },
        bh: if on_atl { 0 } else { rd(fmeta, dm + 5) },
    };
    let wv = if m.wblk9.is_null() { p.wver } else { rd(m.wblk9, ((gy >> 3) * p.wbw + (gx >> 3)) as usize) };
    let refresh = (tw & (SIM_FLOW_REFRESH_TICKS - 1)) < m.dk;
    let lk = flow_look(m, &v, s, refresh, tl, gx, gy, dk, wl, rd(nv.meta, 6), wv, if on_atl { 3 } else if wide { 2 } else { 1 });
    if lk == 0 {
        // (No way: an event on its own tick of SIM_REROUTE_TICKS (the main
        // thread's pending target, a worker at its task done there), standing
        // until then.)
        if ((rd(m.wk, s) == 1 || rd(m.wk, s) == 3) && ((dx0 - gx).abs() > 1 || (dy0 - gy).abs() > 1)) || (tw & (SIM_REROUTE_TICKS - 1)) >= m.dk {
            stand!();
        }
        set_ev(m, s, EV_NOWAY);
        back!();
    }
    if lk == -1 {
        stand!();
    }
    if lk == -2 {
        back!();
    }
    let nr = m.nv.add(s * NV_STRIDE);
    let n1 = *nr.add(NV_N1);
    let n2 = *nr.add(NV_N2);
    let far = *nr.add(NV_FO) >> 1;
    let open = (*nr.add(NV_FO) & 1) != 0;
    wr(m.nld, s, nav_ld);
    let kx = irem_f(far, w);
    let ky = idiv(far - kx, w);
    let base_tx = kx as f64 * tile + 16.0;
    let base_ty = ky as f64 * tile + 16.0;
    let max_side = tile * 0.8;
    let (mut tx, mut ty);
    if open {
        let route_dx = (kx - gx) as f64;
        let route_dy = (ky - gy) as f64;
        let route_len = sqrt(route_dx * route_dx + route_dy * route_dy);
        let sx = -route_dy / route_len;
        let sy = route_dx / route_len;
        let mut side = (x - (gx as f64 * tile + 16.0)) * sx + (y - (gy as f64 * tile + 16.0)) * sy;
        side = if side > max_side { max_side } else if side < -max_side { -max_side } else { side };
        tx = base_tx + sx * side;
        ty = base_ty + sy * side;
    } else {
        let lane = rd(m.lane, s);
        let seg_dx = kx - gx;
        let seg_dy = ky - gy;
        let mut lx = 0.0;
        let mut ly = 0.0;
        if seg_dx.abs() >= seg_dy.abs() {
            ly = if seg_dx < 0 { lane } else { -lane };
        } else {
            lx = if seg_dy < 0 { -lane } else { lane };
        }
        tx = base_tx + lx;
        ty = base_ty + ly;
    }
    let mut dx = tx - x;
    let mut dy = ty - y;
    let mut dist = sqrt(dx * dx + dy * dy);
    if n2 >= 0 && far == n1 && rd(m.vx, s) * dx + rd(m.vy, s) * dy < 0.0 {
        let n2x = irem_f(n2, w);
        tx = n2x as f64 * tile + 16.0;
        ty = idiv(n2 - n2x, w) as f64 * tile + 16.0;
        dx = tx - x;
        dy = ty - y;
        dist = sqrt(dx * dx + dy * dy);
    }
    if dist < 4.0 {
        if n2 < 0 {
            stand!();
        }
        let n2x = irem_f(n2, w);
        tx = n2x as f64 * tile + 16.0;
        ty = idiv(n2 - n2x, w) as f64 * tile + 16.0;
        dx = tx - x;
        dy = ty - y;
        dist = sqrt(dx * dx + dy * dy);
        if dist < 4.0 {
            stand!();
        }
    }
    let mut spd = mv_stat(m, s, 0, m.spd);
    if st_frz(m, s) > 0 {
        spd *= 0.5;
    }
    if st_snd(m, s) > 0 {
        spd *= 0.5;
    }
    let mut vx = (dx / dist) * spd;
    let mut vy = (dy / dist) * spd;
    // (The committed step per base tick; this step's for its base ticks:
    // to the look's target at most, a base tick's step when walls are on
    // the way.)
    let (mut cvx, mut cvy) = (vx, vy);
    if m.dk > 1 {
        let st = js_min(spd * m.dkf, js_max(dist, spd));
        let (ax, ay) = ((dx / dist) * st, (dy / dist) * st);
        if (f & 32) != 0 || seg_open(wl, w, h, x, y, x + ax, y + ay, itile, tile) {
            vx = ax;
            vy = ay;
        }
    }
    if (f & 32) == 0 {
        let sl = flow_slide(wl, w, h, gx, gy, floor((x + vx) * itile), floor((y + vy) * itile));
        if sl & 1 != 0 {
            vx = 0.0;
            cvx = 0.0;
        }
        if sl & 2 != 0 {
            vy = 0.0;
            cvy = 0.0;
        }
    }
    if rd(m.ctl, s) == tl { dbgc!(m, 33); }
    wr(m.cd, s, dk);
    wr(m.ct, s, t);
    wr(m.cvx, s, cvx);
    wr(m.cvy, s, cvy);
    wr(m.ctl, s, tl);
    let cn = if (dx0 - gx).abs() <= 8 && (dy0 - gy).abs() <= 8 { SIM_STEER_NEAR_TICKS } else { SIM_STEER_TICKS };
    // (Counters: 31 steers near the destination, 32 far, 33 steers in the
    // tile the last one was made in.)
    dbgc!(m, if cn == SIM_STEER_NEAR_TICKS { 31 } else { 32 });
    wr(m.cn, s, cn);
    commit_step(m, s, x, y, vx, vy, gx, gy, tl, p.q, p.iq);
    if !m.steady.is_null() {
        wr(m.steady, s, if tl != dk { steady_until(m, s, t, t + cn as i32, f, p.tr, p.acq_t, p.wcheck) } else { 0 });
    }
}

/// A committed step's steady window: the first tick after t on which the
/// step kernel looks at more than the step (the steer's end; an aggro
/// look, a drive-by shooter's even tick, the floor's look, a worker's
/// check), so its steady step may be taken before it.
#[cfg_attr(not(feature = "prof"), inline(always))]
#[cfg_attr(feature = "prof", inline(never))]
unsafe fn steady_until(m: &Mv, s: usize, t: i32, end: i32, f: u8, tr: i32, acq_t: i64, wcheck: i32) -> i32 {
    let tw = t.wrapping_add(rd(m.id, s));
    if tw < 0 || tr <= 0 {
        return 0;
    }
    let next = |k: i32| -> i32 { if k <= 0 { t + 1 } else { t + (k - irem_f(tw, k)) } };
    // (Not the second's tick: step4 takes the floor's look itself.)
    let mut u = end;
    if rd(m.wk, s) == 1 {
        u = u.min(next(wcheck));
    }
    // (A returning builder's watchdog sample: step_slot's.)
    if rd(m.wk, s) == 3 && { let w = wki(m, s); rd(m.wkwx, w) == rd(m.wkwx, w) } {
        u = u.min(next(BUILDER_WATCH_TICKS));
    }
    u
}
/// worker.js BUILDER_WATCH_TICKS (P[29] of the movement kernel).
const BUILDER_WATCH_TICKS: i32 = 64;

/// _simMoveNode.
#[inline(always)]
unsafe fn node(m: &Mv, nb: usize, base: i32, wl: i32, i: i32) -> i32 {
    if i >= base && i < base + wl { rd(m.nodes, nb + (i - base) as usize) } else { -2 }
}
/// _simMoveRoomy.
unsafe fn roomy(m: &Mv, nb: usize, base: i32, wl: i32, len: i32, i: i32) -> i32 {
    let (w, h) = (m.w, m.h);
    if i + 1 >= len {
        return 0;
    }
    let k = node(m, nb, base, wl, i);
    let nk = node(m, nb, base, wl, i + 1);
    if k < 0 || nk < 0 {
        return -1;
    }
    let kx = irem_f(k, w);
    let ky = idiv(k - kx, w);
    let nx = irem_f(nk, w);
    let ny = idiv(nk - nx, w);
    if (nx - kx).abs() + (ny - ky).abs() != 1 {
        return 0;
    }
    if kx < 1 || ky < 1 || kx >= w - 1 || ky >= h - 1 {
        return 0;
    }
    if open_block(m.wall, kx, ky, w, h) { 1 } else { 0 }
}

/// _simMovePath for slot s.
#[cfg_attr(feature = "prof", inline(never))]
unsafe fn move_path(m: &Mv, p: &MoveP, s: usize) {
    let (t, w, h, tile, itile) = (m.t, m.w, m.h, m.tile, m.itile);
    let f = rd(m.fl, s);
    let id = rd(m.id, s);
    let x = rd(m.x, s);
    let y = rd(m.y, s);
    let gx = floor(x * itile) as i32;
    let gy = floor(y * itile) as i32;
    let tl = gy * w + gx;
    macro_rules! back {
        () => {{
            wr(m.on, s, 0);
            return;
        }};
    }
    if rd(m.wk, s) == 1 && irem_f(t.wrapping_add(id), p.wcheck) < m.dk && !(rd(m.wtc, s) > 0) {
        back!();
    }
    let len = rd(m.plen, s);
    let base = rd(m.base, s);
    let wl = rd(m.wlen, s) as i32;
    let nb = rd(m.path, s) as usize * p.win as usize;
    let mut idx = to_i32(rd(m.pidx, s));
    let mut spent: i32 = 0;
    if idx >= len {
        back!();
    }
    if rd(m.scan, s) != tl {
        let first = if idx - 1 > 0 { idx - 1 } else { 0 };
        let limit = (len - 1).min(idx + 6);
        let mut reached = -1;
        let mut i = first;
        while i <= limit {
            let mut r1 = 0;
            let k = node(m, nb, base, wl, i);
            if k < 0 {
                back!();
            }
            let kx = irem_f(k, w);
            let ky = idiv(k - kx, w);
            let dx = kx - gx;
            let dy = ky - gy;
            if i + 1 < len {
                let nk = node(m, nb, base, wl, i + 1);
                if nk < 0 {
                    back!();
                }
                let nx = irem_f(nk, w);
                let ny = idiv(nk - nx, w);
                if (nx - kx).abs() + (ny - ky).abs() != 1 {
                    back!();
                }
            }
            if dx == 0 && dy == 0 {
                reached = i;
            } else if dx >= -1 && dx <= 1 && dy >= -1 && dy <= 1 {
                r1 = roomy(m, nb, base, wl, len, i);
                if r1 == 1 {
                    reached = i;
                }
            }
            if r1 < 0 {
                back!();
            }
            i += 1;
        }
        while idx <= reached {
            if idx > 0 {
                spent += 1;
            }
            idx += 1;
        }
        if idx >= len {
            back!();
        }
        loop {
            let k = node(m, nb, base, wl, idx);
            if k < 0 {
                back!();
            }
            if k != tl {
                break;
            }
            if idx > 0 {
                spent += 1;
            }
            idx += 1;
            if idx >= len {
                back!();
            }
        }
    }
    let k = node(m, nb, base, wl, idx);
    if k < 0 {
        back!();
    }
    if (f & (8 | 32)) == 0 && rd(m.wall, k as usize) != 0 {
        back!();
    }
    let kx = irem_f(k, w);
    let ky = idiv(k - kx, w);
    let base_tx = kx as f64 * tile + 16.0;
    let base_ty = ky as f64 * tile + 16.0;
    let mut seg_dx = 0;
    let mut seg_dy = 0;
    let pk = if idx > 0 { node(m, nb, base, wl, idx - 1) } else { -1 };
    if idx > 0 && pk < 0 {
        back!();
    }
    let mut px = 0;
    let mut py = 0;
    if idx > 0 {
        px = irem_f(pk, w);
        py = idiv(pk - px, w);
        seg_dx = kx - px;
        seg_dy = ky - py;
    } else if idx + 1 < len {
        let nk = node(m, nb, base, wl, idx + 1);
        if nk < 0 {
            back!();
        }
        let nx = irem_f(nk, w);
        seg_dx = nx - kx;
        seg_dy = idiv(nk - nx, w) - ky;
    }
    if seg_dx == 0 && seg_dy == 0 {
        if kx != gx {
            seg_dx = kx - gx;
        } else if ky != gy {
            seg_dy = ky - gy;
        } else if idx + 1 < len {
            let nk = node(m, nb, base, wl, idx + 1);
            if nk < 0 {
                back!();
            }
            let nx = irem_f(nk, w);
            seg_dx = nx - kx;
            seg_dy = idiv(nk - nx, w) - ky;
        } else {
            seg_dx = 1;
        }
    }
    let max_side = tile * 0.8;
    let (tx, ty);
    let mut ra = 0;
    let mut rb = 0;
    if idx > 0 && (px - gx).abs() <= 1 && (py - gy).abs() <= 1 {
        ra = roomy(m, nb, base, wl, len, idx - 1);
        if ra == 1 {
            rb = roomy(m, nb, base, wl, len, idx);
        }
        if ra < 0 || rb < 0 {
            back!();
        }
    }
    if ra == 1 && rb == 1 {
        let ak = node(m, nb, base, wl, idx + 1);
        let fk = if idx + 2 < len { node(m, nb, base, wl, idx + 2) } else { -1 };
        if ak < 0 || (idx + 2 < len && fk < 0) {
            back!();
        }
        let mut ax = irem_f(ak, w);
        let mut ay = idiv(ak - ax, w);
        if fk >= 0 {
            let fx = irem_f(fk, w);
            let fy = idiv(fk - fx, w);
            if (fx - ax).abs() + (fy - ay).abs() == 1 {
                ax = fx;
                ay = fy;
            }
        }
        let route_dx = (ax - px) as f64;
        let route_dy = (ay - py) as f64;
        let route_len = sqrt(route_dx * route_dx + route_dy * route_dy);
        let lx = -route_dy / route_len;
        let ly = route_dx / route_len;
        let mut side = ((x - base_tx) * lx + (y - base_ty) * ly) * 0.875;
        side = if side > max_side { max_side } else if side < -max_side { -max_side } else { side };
        tx = base_tx + lx * side;
        ty = base_ty + ly * side;
    } else {
        let lane = rd(m.lane, s);
        let mut lx = 0.0;
        let mut ly = 0.0;
        if seg_dx.abs() >= seg_dy.abs() {
            ly = if seg_dx < 0 { lane } else { -lane };
        } else {
            lx = if seg_dy < 0 { -lane } else { lane };
        }
        tx = base_tx + lx;
        ty = base_ty + ly;
    }
    let dx = tx - x;
    let dy = ty - y;
    let dist = sqrt(dx * dx + dy * dy);
    if dist < 4.0 {
        if idx + 1 < len && node(m, nb, base, wl, idx + 1) < 0 {
            back!();
        }
        if idx > 0 {
            spent += 1;
        }
        idx += 1;
        if idx >= len {
            back!();
        }
        wr(m.px, s, x);
        wr(m.py, s, y);
        wr(m.pidx, s, idx as f64);
        wr(m.spent, s, spent as u8);
        wr(m.scan, s, -1);
        wr(m.floor, s, tl);
        wr(m.out, s, 1);
        return;
    }
    let mut spd = mv_stat(m, s, 0, m.spd);
    if st_frz(m, s) > 0 {
        spd *= 0.5;
    }
    if st_snd(m, s) > 0 {
        spd *= 0.5;
    }
    // (Several base ticks a step: to the node's point at most.)
    let st = if m.dk > 1 { js_min(spd * m.dkf, js_max(dist, spd)) } else { spd };
    let vx = (dx / dist) * st;
    let vy = (dy / dist) * st;
    // (Rounded as the position column stores it: Unit.update's x += vx.)
    let nx = (x + vx) as f32 as f64;
    let ny = (y + vy) as f32 as f64;
    wr(m.px, s, x);
    wr(m.py, s, y);
    wr(m.vx, s, vx);
    wr(m.vy, s, vy);
    wr(m.pidx, s, idx as f64);
    wr(m.spent, s, spent as u8);
    wr(m.floor, s, tl);
    wr(m.scan, s, tl);
    let ngx = floor(nx * itile);
    let ngy = floor(ny * itile);
    if (f & 32) == 0 && (ngx < 0.0 || ngy < 0.0 || ngx >= w as f64 || ngy >= h as f64 || (inb(ngx, w) && inb(ngy, h) && rd(m.wall, (ngy as i32 * w + ngx as i32) as usize) != 0)) {
        let (nx,ny)=checked_position(m,s,nx,ny);
        wr(m.x,s,nx);
        wr(m.y,s,ny);
        wr(m.on, s, 0);
        wr(m.out, s, 4);
        return;
    }
    let qx = quant_mul(nx, p.q, p.iq);
    let qy = quant_mul(ny, p.q, p.iq);
    let (qx,qy)=checked_position(m,s,qx,qy);
    wr(m.x,s,qx);
    wr(m.y,s,qy);
    wr(m.out, s, if floor(qx * itile) != gx as f64 || floor(qy * itile) != gy as f64 { 3 } else { 1 });
}

/// The push pass's constants (P[49]-[54]).
struct PushC {
    contacts: v128,
    k: v128,
    now: v128,
    q: v128,
    iq: v128,
    itile: v128,
    retry: i32,
    rmask: v128,
    rpow2: bool,
    tid: v128,
    // (The contact response's, P[59]-[63]: the share of the overlap
    // relaxed over a sample's two updates, 1 - exp(-2 dk / tau); a resting
    // unit's depth to sleep under and to wake over (of its radius); the
    // share of sideways separation kept inside a coherent flow; the contact
    // displacement's bound in its speeds; 1 / Q.)
    relax: v128,
    sleep: v128,
    wake: v128,
    side: v128,
    dmax: v128,
    iqs: v128,
}
#[inline(always)]
unsafe fn push_consts(m: &Mv, f: *const f64) -> PushC {
    let q = rd(f, 8) as f32;
    let retry = to_i32(rd(f, 51));
    PushC {
        relax: f32x4_splat(rd(f, 59) as f32),
        sleep: f32x4_splat(rd(f, 60) as f32),
        wake: f32x4_splat(rd(f, 61) as f32),
        side: f32x4_splat(rd(f, 62) as f32),
        dmax: f32x4_splat(rd(f, 63) as f32),
        iqs: f32x4_splat((1.0 / rd(f, 50)) as f32),
        contacts: f32x4_splat(rd(f, 49) as f32),
        k: f32x4_splat((rd(f, 52) / rd(f, 50)) as f32),
        now: f32x4_splat(rd(f, 53) as f32),
        q: f32x4_splat(q),
        iq: f32x4_splat(1.0 / q),
        itile: f32x4_splat(m.itile as f32),
        retry,
        rmask: i32x4_splat(retry - 1),
        rpow2: retry > 0 && (retry & (retry - 1)) == 0,
        tid: i32x4_splat(m.t),
    }
}

/// The compression brake's depths (of the radius; the separation radius has
/// a skin, about 0.35 is touching), see push4.
const SEP_BRAKE0: f32 = 0.6;
const SEP_BRAKE1: f32 = 1.2;
/// The share of its own step its neighbours' flow (lib.rs pair_exact, under-
/// counted: contacts weigh in partly) must reach to count as carrying it.
const SEP_FLOW_SHARE: f32 = 0.3;
/// Within this many tiles of its group's destination a unit's neighbours
/// heading its way do not count as carrying it (unit.js SEP_GOAL_TILES).
const SEP_GOAL_TILES: f32 = 8.0;
/// Four velocities packed as unit.sepIv (lib.rs sep_iv_x: x the high i16,
/// y the low, 1/256 px a base tick; NaN 0).
#[inline(always)]
fn iv_pack(x: v128, y: v128) -> v128 {
    let q = f32x4_splat(crate::SEP_IV_Q as f32);
    let lo = i32x4_splat(-32767);
    let hi = i32x4_splat(32767);
    let ix = i32x4_min(i32x4_max(i32x4_trunc_sat_f32x4(f32x4_nearest(f32x4_mul(x, q))), lo), hi);
    let iy = i32x4_min(i32x4_max(i32x4_trunc_sat_f32x4(f32x4_nearest(f32x4_mul(y, q))), lo), hi);
    v128_or(i32x4_shl(ix, 16), v128_and(iy, i32x4_splat(0xFFFF)))
}
#[inline(always)]
fn iv_unpack(v: v128) -> (v128, v128) {
    let iq = f32x4_splat(1.0 / crate::SEP_IV_Q as f32);
    (f32x4_mul(f32x4_convert_i32x4(i32x4_shr(v, 16)), iq), f32x4_mul(f32x4_convert_i32x4(i32x4_shr(i32x4_shl(v, 16), 16)), iq))
}

/// The separation's pushes of slots s..s + 4 (the lanes past `end` are
/// unused slots, past the last: their sums and carries 0): whether each
/// moved by itself this tick (unit.sepMov, from where the kernel left it;
/// out 0: the simulation thread's update sets it); the push the pair kernel
/// summed (sep.px/py/ov/hit, cleared by the separation chain's first stage:
/// scaled by its contacts,
/// converted to a bounded velocity, `now` of it used now, the rest carried
/// to the next tick in unit.sepCx/Cy) times simDk, quantized half
/// up, when that stays in its tile (every lane's arithmetic its own: the
/// same in whichever lane a unit is). Returns the lanes for push_slot: bits
/// 0-3 leaving their tile (sep.fast 4, the push in sep.nextX/Y), 4-7 on
/// their path retry tick with a push (sep.fast 5).
#[cfg_attr(not(feature = "prof"), inline(always))]
#[cfg_attr(feature = "prof", inline(never))]
unsafe fn push4(m: &Mv, c: &PushC, s: usize, end: usize, known: i32, mvd: i32) -> i32 {
    let zero = i32x4_splat(0);
    let fz = f32x4_splat(0.0);
    let lane_bits = i32x4(1, 2, 4, 8);
    // Asleep or awake (sepMov bit 1) as the last update left it.
    let smv0 = ld_u8x4(m.smv.add(s));
    let was_awake = i32x4_ne(v128_and(smv0, i32x4_splat(2)), zero);
    // (Bits 2-4: its contacts at its last sample, at most 7; bits 5-7 the
    // brake on its whole step it carries through the stagger's other update,
    // in sevenths.)
    let cn_old = v128_and(u32x4_shr(smv0, 2), i32x4_splat(7));
    let bb_old = f32x4_mul(f32x4_convert_i32x4(v128_and(u32x4_shr(smv0, 5), i32x4_splat(7))), f32x4_splat(1.0 / 7.0));
    // (sepMov: the vector paths' lanes as they moved (known: no position
    // read); the rest from the positions, output 0 keeping its own; its
    // contact count kept, the rest set below.)
    if known & 15 == 15 {
        let v = v128_or(v128_and(i32x4_ne(v128_and(i32x4_splat(mvd), lane_bits), zero), i32x4_splat(1)), i32x4_shl(cn_old, 2));
        let b = i8x16_narrow_i16x8(i16x8_narrow_i32x4(v, v), i16x8_narrow_i32x4(v, v));
        (m.smv.add(s) as *mut u32).write_unaligned(i32x4_extract_lane::<0>(b) as u32);
    } else {
        let x = v128_load(m.x.add(s) as *const v128);
        let y = v128_load(m.y.add(s) as *const v128);
        let o4 = ld_u8x4(m.out.add(s));
        let mv = v128_and(v128_or(i32x4_ne(x, v128_load(m.px.add(s) as *const v128)), i32x4_ne(y, v128_load(m.py.add(s) as *const v128))), i32x4_splat(1));
        let kv = i32x4_ne(v128_and(i32x4_splat(known), lane_bits), zero);
        let mv = v128_bitselect(v128_and(i32x4_ne(v128_and(i32x4_splat(mvd), lane_bits), zero), i32x4_splat(1)), mv, kv);
        let old = v128_and(ld_u8x4(m.smv.add(s)), i32x4_splat(1));
        let v = v128_or(v128_bitselect(old, mv, v128_andnot(i32x4_eq(o4, zero), kv)), i32x4_shl(cn_old, 2));
        let b = i8x16_narrow_i16x8(i16x8_narrow_i32x4(v, v), i16x8_narrow_i32x4(v, v));
        (m.smv.add(s) as *mut u32).write_unaligned(i32x4_extract_lane::<0>(b) as u32);
    }
    let dead = i32x4_ne(ld_u8x4(m.dead.add(s)), zero);
    // This update's navigation step (from where it stood as the update began,
    // before any contact response) a base tick: its intent; with no contact
    // also what the next sample's pairs see (unit.sepIv, set again below
    // with its brakes; the JS fallback writes its own, _unitPassUpdate).
    let idk = f32x4_splat(1.0 / m.dk as f32);
    let ivx = f32x4_mul(px4(i32x4_sub(v128_load(m.x.add(s) as *const v128), v128_load(m.x0.add(s) as *const v128))), idk);
    let ivy = f32x4_mul(px4(i32x4_sub(v128_load(m.y.add(s) as *const v128), v128_load(m.y0.add(s) as *const v128))), idk);
    if !m.siv.is_null() {
        v128_store(m.siv.add(s) as *mut v128, v128_andnot(iv_pack(ivx, ivy), dead));
    }
    let hits = v128_load(m.shit.add(s) as *const v128);
    let (cx, cy) = iv_unpack(v128_load(m.scx.add(s) as *const v128));
    let cv = if m.scv.is_null() { zero } else { v128_load(m.scv.add(s) as *const v128) };
    if !v128_any_true(v128_or(v128_or(hits, bb_old), v128_or(cv, v128_or(cx, cy)))) {
        return 0;
    }
    let hf = f32x4_convert_u32x4(hits);
    let one = f32x4_splat(1.0);
    // Geometric separation: the summed overlap correction (px), relaxed by
    // the share of it due over the sample's two updates (exponential in
    // elapsed base ticks: never more than the overlap, at any step size).
    let radius = f32x4_max(one, v128_load(m.rrc.add(s) as *const v128));
    let speed = f32x4_max(f32x4_splat(0.25), mv_stat4(m, s, 0, m.spd));
    let depth = v128_load(m.sov.add(s) as *const v128);
    // Its friendly neighbours' mean intended velocity (the pair kernel's
    // local flow, weighted by contact).
    let (flx, fly) = if m.sfx.is_null() { (fz, fz) } else {
        let ih = f32x4_div(c.iqs, f32x4_max(hf, one));
        (f32x4_mul(f32x4_convert_i32x4(v128_load(m.sfx.add(s) as *const v128)), ih), f32x4_mul(f32x4_convert_i32x4(v128_load(m.sfy.add(s) as *const v128)), ih))
    };
    let fl2 = f32x4_add(f32x4_mul(flx, flx), f32x4_mul(fly, fly));
    let iv2 = f32x4_add(f32x4_mul(ivx, ivx), f32x4_mul(ivy, ivy));
    // A resting unit in a resting crowd sleeps while its deepest contact is
    // shallow (hysteresis: it wakes past c.wake of its radius, sleeps again
    // under c.sleep), so a settled crowd is still; deeper compression, a
    // mover's closing response or flow around it wake it.
    let resting = v128_and(f32x4_lt(iv2, f32x4_splat(0.0025)), f32x4_lt(fl2, f32x4_splat(0.01)));
    let thr = f32x4_mul(v128_bitselect(c.sleep, c.wake, was_awake), radius);
    let quiet = v128_and(resting, f32x4_lt(depth, thr));
    // A sleeping, stationary group with no carried or closing response has
    // no displacement. Keep its contact/brake history, but do not load the
    // geometric sums or evaluate the movement/flow normalizations. These
    // are the same writes as the full response below, including clearing a
    // brake on its unsampled update. Nonzero forces and retry work retain
    // the general path.
    if c.retry <= 0 && i32x4_bitmask(quiet) == 15
        && !v128_any_true(v128_or(v128_or(ivx, ivy), v128_or(v128_or(flx, fly), v128_or(cv, v128_or(cx, cy)))))
        && (m.sccx.is_null() || !v128_any_true(v128_or(v128_load(m.sccx.add(s) as *const v128), v128_load(m.sccy.add(s) as *const v128))))
        && i32x4_bitmask(f32x4_ge(speed, f32x4_splat(0.25))) == 15 {
        let sampled = i32x4_ne(hits, zero);
        let b = f32x4_min(one, f32x4_max(fz, f32x4_mul(f32x4_sub(f32x4_div(depth, radius), f32x4_splat(SEP_BRAKE0)), f32x4_splat(1.0 / (SEP_BRAKE1 - SEP_BRAKE0)))));
        let bq = v128_and(i32x4_trunc_sat_f32x4(f32x4_nearest(f32x4_mul(b, f32x4_splat(7.0)))), sampled);
        let cn = v128_bitselect(i32x4_min(hits, i32x4_splat(7)), cn_old, sampled);
        let bits = v128_andnot(v128_or(i32x4_shl(cn, 2), i32x4_shl(bq, 5)), dead);
        let motion = v128_or(v128_and(ld_u8x4(m.smv.add(s)), i32x4_splat(1)), bits);
        let bytes = u8x16_narrow_i16x8(i16x8_narrow_i32x4(motion, motion), i16x8_narrow_i32x4(motion, motion));
        (m.smv.add(s) as *mut u32).write_unaligned(i32x4_extract_lane::<0>(bytes) as u32);
        return 0;
    }
    let sc = f32x4_mul(v128_bitselect(one, f32x4_sqrt(f32x4_div(c.contacts, f32x4_max(hf, one))), f32x4_le(hf, c.contacts)), c.k);
    let mut gx = f32x4_mul(f32x4_mul(f32x4_convert_i32x4(v128_load(m.spx.add(s) as *const v128)), sc), c.relax);
    let mut gy = f32x4_mul(f32x4_mul(f32x4_convert_i32x4(v128_load(m.spy.add(s) as *const v128)), sc), c.relax);
    gx = v128_andnot(gx, quiet);
    gy = v128_andnot(gy, quiet);
    // Moving with its neighbours' flow: sideways separation damped (lanes
    // kept, no weaving), along the flow kept (spacing in the column).
    let coh = v128_and(f32x4_gt(fl2, f32x4_splat(0.01)), f32x4_gt(f32x4_add(f32x4_mul(ivx, flx), f32x4_mul(ivy, fly)), fz));
    if v128_any_true(coh) {
        let inv = f32x4_div(one, f32x4_sqrt(f32x4_max(fl2, f32x4_splat(1e-6))));
        let (ux, uy) = (f32x4_mul(flx, inv), f32x4_mul(fly, inv));
        let al = f32x4_add(f32x4_mul(gx, ux), f32x4_mul(gy, uy));
        let (ax, ay) = (f32x4_mul(ux, al), f32x4_mul(uy, al));
        let keep = v128_bitselect(c.side, one, coh);
        gx = f32x4_add(ax, f32x4_mul(f32x4_sub(gx, ax), keep));
        gy = f32x4_add(ay, f32x4_mul(f32x4_sub(gy, ay), keep));
    }
    let dkv = f32x4_splat(m.dk as f32);
    let hx = f32x4_mul(gx, c.now);
    let hy = f32x4_mul(gy, c.now);
    let sampled = i32x4_ne(hits, zero);
    // Brakes on its navigation step (bx, by), from SEP_BRAKE0 of its radius
    // deep to all of it at SEP_BRAKE1. Not moving with its neighbourhood
    // (their flow, from the sample, does not carry its own step: a resting
    // crowd, a crossing stream) the whole step is braked so: measured
    // obstruction (intents alone would take a jam for flowing traffic, and a
    // fresh order's first steps have none). Carried through the stagger's
    // unsampled update. Of the rest, the part heading into the pressure
    // (against its summed overlap push) is braked on a sample.
    let b = f32x4_min(one, f32x4_max(fz, f32x4_mul(f32x4_sub(f32x4_div(depth, radius), f32x4_splat(SEP_BRAKE0)), f32x4_splat(1.0 / (SEP_BRAKE1 - SEP_BRAKE0)))));
    let ivl = f32x4_sqrt(iv2);
    let fll = f32x4_sqrt(fl2);
    let cosv = f32x4_div(f32x4_add(f32x4_mul(ivx, flx), f32x4_mul(ivy, fly)), f32x4_max(f32x4_mul(ivl, fll), f32x4_splat(1e-6)));
    let carried = f32x4_min(one, f32x4_div(fll, f32x4_max(f32x4_mul(ivl, f32x4_splat(SEP_FLOW_SHARE)), f32x4_splat(1e-6))));
    // (Near its group's destination (mvNavLD: its distance there, the flow's
    // look) travel converges: neighbours heading the same way do not carry
    // it there.)
    let nld = v128_load(m.nld.add(s) as *const v128);
    let converging = v128_and(f32x4_ge(nld, fz), f32x4_lt(nld, f32x4_splat(SEP_GOAL_TILES * m.tile as f32)));
    let a = v128_andnot(v128_and(f32x4_mul(f32x4_max(fz, cosv), carried), f32x4_gt(iv2, fz)), converging);
    let bb = v128_bitselect(f32x4_mul(b, f32x4_sub(one, a)), bb_old, sampled);
    let mut bx = f32x4_neg(f32x4_mul(ivx, f32x4_mul(bb, dkv)));
    let mut by = f32x4_neg(f32x4_mul(ivy, f32x4_mul(bb, dkv)));
    if v128_any_true(v128_and(f32x4_gt(b, fz), f32x4_gt(iv2, fz))) {
        let rest = f32x4_mul(f32x4_sub(one, bb), dkv);
        let px = f32x4_convert_i32x4(v128_load(m.spx.add(s) as *const v128));
        let py = f32x4_convert_i32x4(v128_load(m.spy.add(s) as *const v128));
        let pl = f32x4_sqrt(f32x4_add(f32x4_mul(px, px), f32x4_mul(py, py)));
        let ipl = f32x4_div(one, f32x4_max(pl, one));
        let (ux, uy) = (f32x4_mul(px, ipl), f32x4_mul(py, ipl));
        let into = f32x4_max(fz, f32x4_neg(f32x4_add(f32x4_mul(ivx, ux), f32x4_mul(ivy, uy))));
        let kd = v128_and(f32x4_mul(f32x4_mul(into, b), rest), f32x4_gt(pl, fz));
        bx = f32x4_add(bx, f32x4_mul(ux, kd));
        by = f32x4_add(by, f32x4_mul(uy, kd));
    }
    // The closing response (a velocity a base tick, at most its speed), used
    // this update and carried into the next (a sample covers two).
    let (mut vcx, mut vcy) = if m.sccx.is_null() { (fz, fz) } else {
        (f32x4_mul(f32x4_convert_i32x4(v128_load(m.sccx.add(s) as *const v128)), c.iqs), f32x4_mul(f32x4_convert_i32x4(v128_load(m.sccy.add(s) as *const v128)), c.iqs))
    };
    {
        let l = f32x4_sqrt(f32x4_add(f32x4_mul(vcx, vcx), f32x4_mul(vcy, vcy)));
        let r = v128_bitselect(f32x4_div(speed, l), one, f32x4_gt(l, speed));
        vcx = f32x4_mul(vcx, r);
        vcy = f32x4_mul(vcy, r);
    }
    let (ocx, ocy) = iv_unpack(cv);
    let mut dx = f32x4_add(hx, f32x4_mul(f32x4_add(cx, f32x4_add(vcx, ocx)), dkv));
    let mut dy = f32x4_add(hy, f32x4_mul(f32x4_add(cy, f32x4_add(vcy, ocy)), dkv));
    // The whole contact displacement bounded (no throw at long steps).
    {
        let lim = f32x4_add(f32x4_mul(f32x4_mul(speed, c.dmax), dkv), one);
        let l = f32x4_sqrt(f32x4_add(f32x4_mul(dx, dx), f32x4_mul(dy, dy)));
        let r = v128_bitselect(f32x4_div(lim, l), one, f32x4_gt(l, lim));
        dx = f32x4_mul(dx, r);
        dy = f32x4_mul(dy, r);
    }
    // (The brakes on its own step, not bounded: never more than the step.)
    dx = f32x4_add(dx, bx);
    dy = f32x4_add(dy, by);
    // The velocity the next sample's pairs see: its movement as committed
    // (its step less the brakes), not its intent alone: a front held by a
    // crowd holds the ones walking behind it (a queue), while units moving
    // together are untouched. Not the separation's corrections nor the
    // closing response (fed back, they swayed crowds; a yield would carry
    // resting units along).
    if !m.siv.is_null() {
        v128_store(m.siv.add(s) as *mut v128, v128_andnot(iv_pack(f32x4_add(ivx, f32x4_mul(bx, idk)), f32x4_add(ivy, f32x4_mul(by, idk))), dead));
    }
    v128_store(m.scx.add(s) as *mut v128, v128_andnot(iv_pack(f32x4_mul(f32x4_sub(gx, hx), idk), f32x4_mul(f32x4_sub(gy, hy), idk)), dead));
    if !m.scv.is_null() {
        v128_store(m.scv.add(s) as *mut v128, v128_andnot(iv_pack(vcx, vcy), dead));
    }
    {
        // Awake: in contact and not asleep (sep_pack lists it every sample).
        let awake = v128_andnot(i32x4_ne(hits, zero), v128_or(quiet, dead));
        // (Bits 2-4: its contacts, at most 7: how much room it has to give
        // way, lib.rs pair_exact; bits 5-7 its whole-step brake.)
        let cn = v128_bitselect(i32x4_min(hits, i32x4_splat(7)), cn_old, sampled);
        // (The brake is carried one update only: a unit its contacts have
        // left gets no sample to clear it.)
        let bq = v128_and(i32x4_trunc_sat_f32x4(f32x4_nearest(f32x4_mul(bb, f32x4_splat(7.0)))), sampled);
        let bits = v128_andnot(v128_or(i32x4_shl(cn, 2), i32x4_shl(bq, 5)), dead);
        let motion = v128_or(v128_or(v128_and(ld_u8x4(m.smv.add(s)), i32x4_splat(1)), v128_and(awake, i32x4_splat(2))), bits);
        let bytes = u8x16_narrow_i16x8(i16x8_narrow_i32x4(motion, motion), i16x8_narrow_i32x4(motion, motion));
        (m.smv.add(s) as *mut u32).write_unaligned(i32x4_extract_lane::<0>(bytes) as u32);
    }
    let lanes = i32x4_lt(i32x4(0, 1, 2, 3), i32x4_splat(end as i32 - s as i32));
    let apply = v128_andnot(v128_or(f32x4_ne(dx, fz), f32x4_ne(dy, fz)), dead);
    let mut nd = 0i32;
    if v128_any_true(apply) {
        let x = v128_load(m.x.add(s) as *const v128);
        let y = v128_load(m.y.add(s) as *const v128);
        // (In eighths: the push as whole eighths, halves up.)
        let nx = i32x4_add(x, q8x4(dx));
        let ny = i32x4_add(y, q8x4(dy));
        let same = v128_and(i32x4_eq(tile4(m, nx), tile4(m, x)), i32x4_eq(tile4(m, ny), tile4(m, y)));
        let stay = v128_and(apply, same);
        v128_store(m.x.add(s) as *mut v128, v128_bitselect(nx, x, stay));
        v128_store(m.y.add(s) as *mut v128, v128_bitselect(ny, y, stay));
        let cross = v128_and(v128_andnot(apply, same), lanes);
        if v128_any_true(cross) {
            v128_store(m.snx.add(s) as *mut v128, dx);
            v128_store(m.sny.add(s) as *mut v128, dy);
            nd = i32x4_bitmask(cross) as i32;
        }
    }
    // (Pushed on its path retry tick: push_slot looks.)
    if c.retry > 0 {
        // (A unit with a fallback path and a pending target (mvPF), not armed
        // (or a builder's watch), pushed, on its retry tick.)
        let mut hit = v128_and(i32x4_ne(hits, zero), lanes);
        if !m.pf.is_null() {
            hit = v128_and(hit, i32x4_ne(ld_u8x4(m.pf.add(s)), zero));
        }
        hit = v128_and(hit, v128_or(i32x4_eq(ld_u8x4(m.on.add(s)), zero), i32x4_ne(v128_and(ld_u8x4(m.fl.add(s)), i32x4_splat(4)), zero)));
        if v128_any_true(hit) {
            let due = if c.rpow2 { i32x4_eq(v128_and(i32x4_add(c.tid, v128_load(m.id.add(s) as *const v128)), c.rmask), zero) } else { hit };
            nd |= (i32x4_bitmask(v128_and(hit, due)) as i32) << 4;
        }
    }
    if nd != 0 {
        for l in 0..4usize {
            if nd & (1 << l) != 0 {
                wr(m.sfast, s + l, 4);
            } else if nd & (16 << l) != 0 {
                wr(m.sfast, s + l, 5);
            }
        }
    }
    nd
}
#[inline(always)]
fn floor32(v: f32) -> f32 {
    unsafe { f32x4_extract_lane::<0>(f32x4_floor(f32x4_splat(v))) }
}

/// One slot's push in the scalar part (push4 marked it, sep.fast: 4 it
/// leaves its tile, the push in sep.nextX/Y; 5 its retry tick, the push in
/// its tile applied): into an open neighbouring tile (flyers anywhere), else
/// listed for the swept commit (sep.fast 0). In f32 as push4 (whichever part
/// a unit takes, the same position). Returns (moved into another tile,
/// listed).
#[inline(never)]
unsafe fn push_slot(m: &Mv, f: *const f64, s: usize) -> (bool, bool) {
    let mode = rd(m.sfast, s);
    let (w, h) = (m.w, m.h);
    let it = m.itile as f32;
    let mut moved = false;
    if mode == 4 {
        let dx = rd(m.snx, s) as f32;
        let dy = rd(m.sny, s) as f32;
        let q = rd(f, 8) as f32;
        let iq = 1.0 / q;
        let x = rd(m.x, s) as f32;
        let y = rd(m.y, s) as f32;
        let (ax, ay) = (x + dx, y + dy);
        let nx = if ax - ax == 0.0 { floor32(ax * q + 0.5) * iq } else { x };
        let ny = if ay - ay == 0.0 { floor32(ay * q + 0.5) * iq } else { y };
        let gx = floor32(nx * it) as f64;
        let gy = floor32(ny * it) as f64;
        let ox = floor32(x * it) as f64;
        let oy = floor32(y * it) as f64;
        let mut open = !m.wall.is_null();
        if open && rd(m.slayer, s) != 1 {
            if abs(gx - ox) > 1.0 || abs(gy - oy) > 1.0 {
                open = false;
            } else {
                let x0 = if gx < ox { gx } else { ox };
                let x1 = if gx < ox { ox } else { gx };
                let y0 = if gy < oy { gy } else { oy };
                let y1 = if gy < oy { oy } else { gy };
                if !(x0 >= 0.0 && y0 >= 0.0 && x1 < w as f64 && y1 < h as f64) {
                    open = false;
                } else {
                    let (ix0, ix1, iy0, iy1) = (x0 as usize, x1 as usize, y0 as usize, y1 as usize);
                    let g = w as usize;
                    if (rd(m.wall, iy0 * g + ix0) | rd(m.wall, iy0 * g + ix1) | rd(m.wall, iy1 * g + ix0) | rd(m.wall, iy1 * g + ix1)) != 0 {
                        open = false;
                    }
                }
            }
        }
        if open {
            wr(m.x, s, nx as f64);
            wr(m.y, s, ny as f64);
        } else {
            // Blocked on the way (unit.js applyUnitSeparation): in steps of a
            // quarter tile against its profile's walls, sliding along one
            // axis where the other is blocked; a unit left on a blocked tile
            // goes to the simulation thread (pushUnitOutOfBlockedTile).
            let fly = rd(m.slayer, s) == 1;
            let np = rd(m.npr, s) as usize;
            let wl = if np < NAV_PROFILES && !m.nav.get_unchecked(np).walls.is_null() { m.nav.get_unchecked(np).walls } else { m.wall };
            let occ = |gx: f32, gy: f32| -> bool {
                gx >= 0.0 && gy >= 0.0 && gx < w as f32 && gy < h as f32 && (fly || wl.is_null() || rd(wl, (gy as usize) * w as usize + gx as usize) == 0)
            };
            let tq = m.tile as f32 / 4.0;
            let am = if dx.abs() > dy.abs() { dx.abs() } else { dy.abs() };
            let steps = (-floor32(-(am / tq))).max(1.0).min(64.0) as i32;
            let (mut cx, mut cy) = (x, y);
            let mut i = 1;
            while i <= steps {
                let fi = i as f32 / steps as f32;
                let (tx, ty) = (x + dx * fi, y + dy * fi);
                let sx = if tx - tx == 0.0 { floor32(tx * q + 0.5) * iq } else { cx };
                let sy = if ty - ty == 0.0 { floor32(ty * q + 0.5) * iq } else { cy };
                if !fly {
                    let (gx, gy) = (floor32(cx * it), floor32(cy * it));
                    let (ngx, ngy) = (floor32(sx * it), floor32(sy * it));
                    let side_x = occ(ngx, gy);
                    let side_y = occ(gx, ngy);
                    if !occ(ngx, ngy) || (gx != ngx && gy != ngy && (!side_x || !side_y)) {
                        if side_x && ngx != gx {
                            cx = sx;
                        } else if side_y && ngy != gy {
                            cy = sy;
                        }
                        break;
                    }
                }
                cx = sx;
                cy = sy;
                i += 1;
            }
            // Left on a blocked tile: toward the open neighbouring tile
            // whose centre is nearest, at most half a tile a tick (none
            // open: it stays).
            let (fgx, fgy) = (floor32(cx * it), floor32(cy * it));
            if !occ(fgx, fgy) {
                let half = m.tile as f32 * 0.5;
                let (mut best, mut bx, mut by) = (f32::MAX, 0.0f32, 0.0f32);
                let mut k = 0;
                while k < 9 {
                    let (ox_, oy_) = ((k % 3) as f32 - 1.0, (k / 3) as f32 - 1.0);
                    k += 1;
                    if ox_ == 0.0 && oy_ == 0.0 {
                        continue;
                    }
                    let (tx, ty) = (fgx + ox_, fgy + oy_);
                    if !occ(tx, ty) {
                        continue;
                    }
                    let (ccx, ccy) = (tx * m.tile as f32 + half, ty * m.tile as f32 + half);
                    let d = (ccx - cx) * (ccx - cx) + (ccy - cy) * (ccy - cy);
                    if d < best {
                        best = d;
                        bx = ccx;
                        by = ccy;
                    }
                }
                if best < f32::MAX {
                    let d = f32x4_extract_lane::<0>(f32x4_sqrt(f32x4_splat(best)));
                    let st = if d > half { half / d } else { 1.0 };
                    cx = floor32((cx + (bx - cx) * st) * q + 0.5) * iq;
                    cy = floor32((cy + (by - cy) * st) * q + 0.5) * iq;
                }
            }
            wr(m.x, s, cx as f64);
            wr(m.y, s, cy as f64);
        }
        moved = floor32(rd(m.x, s) as f32 * it) as f64 != ox || floor32(rd(m.y, s) as f32 * it) as f64 != oy;
    }
    // (Pushed on its retry tick: its fallback path tried again.)
    let retry = to_i32(rd(f, 51));
    if retry > 0 && irem_f(m.t.wrapping_add(rd(m.id, s)), retry) < m.dk && !(rd(m.on, s) != 0 && (rd(m.fl, s) & 4) == 0) && (m.pf.is_null() || rd(m.pf, s) != 0) {
        wr(m.sfast, s, 2);
        return (moved, true);
    }
    wr(m.sfast, s, 1);
    (moved, false)
}

/// The epilogue's state over a chunk (_simMoveEpilogue).
struct Epi {
    absent: f64,
    boxsteps: i32,
    epoch: i32,
    vis_gen: i32,
    vis_all: i32,
    cwn: i32,
    csz: i32,
    np: i32,
    nt: i32,
    scale: f64,
    f0: usize,
    u0: usize,
    pb: usize,
    cnt: usize,
    ne: usize,
    on: bool,
    push: bool,
}
/// No epilogue (the occupancy's first stage: the second runs it).
#[inline(always)]
fn epi_none() -> Epi {
    Epi { absent: 0.0, boxsteps: 0, epoch: 0, vis_gen: 0, vis_all: 0, cwn: 0, csz: 0, np: 0, nt: 0, scale: 0.0, f0: 0, u0: 0, pb: 0, cnt: 0, ne: 0, on: false, push: false }
}
/// The chunk's charge sums cleared; the separation's pushes when P[54] 1.
#[inline(always)]
unsafe fn epi_begin(m: &Mv, f: *const f64, chunk: i32, b0: usize, end: usize) -> Epi {
    let on = !m.post.is_null() && !m.postc.is_null();
    let np = to_i32(rd(f, 43));
    let nt = to_i32(rd(f, 44));
    let per = to_i32(rd(f, 1)) as usize;
    let chunk = chunk.max(0) as usize;
    // (Per chunk np + 1 sums: the last 1 when any is charged, so the
    // simulation thread skips the chunks without.)
    let f0 = chunk * (np.max(0) as usize + 1);
    let u0 = chunk * np.max(0) as usize * nt.max(0) as usize;
    if on {
        for i in 0..=np.max(0) as usize {
            wr(m.fix, f0 + i, 0.0);
        }
        for i in 0..(np.max(0) * nt.max(0)) as usize {
            wr(m.use_, u0 + i, 0.0);
        }
    }
    let push = on && rd(f, 54) == 1.0 && end > b0 && !m.shit.is_null() && !m.spx.is_null() && !m.spy.is_null() && !m.sov.is_null() && !m.scx.is_null()
        && !m.smv.is_null() && !m.snx.is_null() && !m.sny.is_null() && !m.sfast.is_null() && !m.sex.is_null() && !m.sexc.is_null();
    Epi {
        absent: rd(f, 15),
        boxsteps: to_i32(rd(f, 17)),
        epoch: to_i32(rd(f, 40)),
        vis_gen: to_i32(rd(f, 41)),
        vis_all: to_i32(rd(f, 42)),
        cwn: to_i32(rd(f, 34)),
        csz: to_i32(rd(f, 36)),
        np,
        nt,
        scale: rd(f, 45),
        f0,
        u0,
        pb: chunk * per,
        cnt: 0,
        ne: 0,
        on,
        push,
    }
}
/// One slot of the epilogue (one with anything left: another tile, a node
/// step's charge, a listing, a push for push_slot): its charges, its push,
/// then its index entry for its new tile once; what the kernel cannot do is
/// listed (mv.post by out code; a pushed unit in sep.ex: sep.fast 0 the
/// swept commit, 2 its index, a path retry, a drive-by box).
#[inline(never)]
unsafe fn epi_slot(m: &Mv, f: *const f64, e: &mut Epi, s: usize, need: bool) {
    if !e.on {
        return;
    }
    let (w, h, itile) = (m.w, m.h, m.itile);
    let (np, nt) = (e.np, e.nt);
    let o = rd(m.out, s);
    let mut list = o == 4 || o == 5;
    let k = rd(m.spent, s);
    if k != 0 {
        wr(m.spent, s, 0);
        let pid = rd(m.own, s);
        let cost = mv_stat(m, s, 1, m.cost);
        if cost > 0.0 && pid >= 0 && pid < np {
            if rd(m.rem, pid as usize) < cost {
                wr(m.blk, s, 1);
                list = true;
            }
            let fi = e.f0 + pid as usize;
            wr(m.fix, fi, rd(m.fix, fi) + k as f64 * js_round(-cost * e.scale));
            wr(m.fix, e.f0 + np as usize, 1.0);
            let ty = rd(m.spty, s) as i32;
            let r = e.u0 + (pid * nt) as usize + (if ty >= 0 && ty < nt - 1 { ty } else { nt - 1 }) as usize;
            for _ in 0..k {
                wr(m.use_, r, rd(m.use_, r) + cost);
            }
        }
    }
    let mut retile = o == 3 || o == 9 || o == 12;
    let mut pushed = false;
    let mut exl = false;
    if e.push && need {
        let (mv, l) = push_slot(m, f, s);
        pushed = mv;
        retile |= mv;
        exl = l;
    }
    if retile {
        let gxf = floor(rd(m.x, s) * itile);
        let gyf = floor(rd(m.y, s) * itile);
        let gx = if !(gxf >= 0.0) { 0 } else if gxf >= w as f64 { w - 1 } else { gxf as i32 };
        let gy = if !(gyf >= 0.0) { 0 } else if gyf >= h as f64 { h - 1 } else { gyf as i32 };
        let tt = gy * w + gx;
        let sep = rd(m.sep, s);
        if rd(m.spe, s) == e.epoch && rd(m.spo, s) == rd(m.own, s) && sep as f64 != e.absent && (e.vis_all != 0 || rd(m.vsg, s) == e.vis_gen) {
            if tt != rd(m.spt, s) {
                let key = if e.csz == 1 { tt } else { idiv(gy, e.csz) * e.cwn + idiv(gx, e.csz) };
                if sep as f64 != key as f64 {
                    if rd(m.mvw, s) == 0 {
                        wr(m.mvo, s, sep as i32);
                    }
                    wr(m.mvn, s, key);
                    wr(m.mvw, s, rd(m.spo, s).wrapping_add(1) as i8);
                    wr(m.sep, s, key as u32);
                }
                let a = rd(m.ag, tt as usize);
                let a0 = rd(m.area, s);
                let na = if a >= 0 { a } else { -1 };
                wr(m.area, s, na);
                wr(m.spt, s, tt);
                if (rd(m.fl, s) & 1) != 0 && na != a0 && na >= 0 && rd(m.abok, (na * e.boxsteps + rd(m.reach, s) as i32) as usize) == 0 {
                    if o == 3 {
                        list = true;
                    } else if pushed && !exl {
                        wr(m.sfast, s, 2);
                        exl = true;
                    }
                }
            }
        } else if o == 3 || o == 9 || o == 12 {
            list = true;
        } else if pushed && !exl {
            wr(m.sfast, s, 2);
            exl = true;
        }
    }
    if list {
        wr(m.post, e.pb + e.cnt, s as i32);
        e.cnt += 1;
    }
    if exl {
        wr(m.sex, e.pb + e.ne, s as i32);
        e.ne += 1;
    }
}
/// The chunk's list counts.
#[inline(always)]
unsafe fn epi_end(m: &Mv, e: &Epi, chunk: i32) {
    if !e.on {
        return;
    }
    let chunk = chunk.max(0) as usize;
    wr(m.postc, chunk, e.cnt as i32);
    if e.push {
        wr(m.sexc, chunk, e.ne as i32);
    }
}
