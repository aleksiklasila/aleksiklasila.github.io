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

// ---- argument words (sim_parallel.js _SIM_MOVE_WNAMES) ----
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
const W_DBT: usize = 36;
const W_DBS: usize = 37;
const W_DBTK: usize = 38;
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
const W_NVT: usize = 91;
const W_NVV: usize = 92;
const W_NVW: usize = 93;
const W_NVG: usize = 94;
const W_NVD: usize = 95;
const W_NVN1: usize = 96;
const W_NVN2: usize = 97;
const W_NVF: usize = 98;
const W_NVO: usize = 99;
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
const W_DBTI: usize = 138;
const W_FIRE: usize = 139;
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
    x: *mut F32,
    y: *mut F32,
    px: *mut F32,
    py: *mut F32,
    floor: *mut i32,
    sc: *const i8,
    d0: *mut u8,
    wake: *mut i32,
    wkwx: *const F32,
    wkwy: *const F32,
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
    dbt: *mut i32,
    dbs: *mut i32,
    dbtk: *mut i32,
    wk: *const u8,
    wtc: *const i32,
    flow: *const i32,
    fgen: *const i32,
    rdy: *const i32,
    fmn: *const i32,
    fmw: *const i32,
    npr: *const u8,
    spd: *const F32,
    ht: *const i32,
    htid: *const i32,
    x0: *const F32,
    y0: *const F32,
    crc: *const F32,
    rrc: *const F32,
    aoff: *const i32,
    anb: *const i32,
    covf: *const u8,
    ag: *const i32,
    frz: *const i32,
    snd: *const i32,
    cbt: *const i32,
    cbtk: *const i32,
    chs: *const F32,
    rng: *const F32,
    wkv: *const i32,
    wkty: *const i32,
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
    nvt: *mut i32,
    nvv: *mut i32,
    nvw: *mut i32,
    nvg: *mut i32,
    nvd: *mut i32,
    nvn1: *mut i32,
    nvn2: *mut i32,
    nvf: *mut i32,
    nvo: *mut u8,
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
    dbti: *mut i32,
    fire: *mut u8,
    acd: *const F32,
    flash: *mut U8I32,
    hita: *mut i32,
    hitt: *mut i32,
    hitc: *mut i32,
    tmon: *mut u8,
    cmode: *mut u8,
    cmt: *const i32,
    ctid: *const i32,
    slayer: *const u8,
    brain: bool,
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
}

#[inline(always)]
unsafe fn word(a: *const i32, i: usize) -> usize {
    rd(a, i) as u32 as usize
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
            dbt: p!(W_DBT),
            dbs: p!(W_DBS),
            dbtk: p!(W_DBTK),
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
            nvt: p!(W_NVT),
            nvv: p!(W_NVV),
            nvw: p!(W_NVW),
            nvg: p!(W_NVG),
            nvd: p!(W_NVD),
            nvn1: p!(W_NVN1),
            nvn2: p!(W_NVN2),
            nvf: p!(W_NVF),
            nvo: p!(W_NVO),
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
            dbti: p!(W_DBTI),
            fire: p!(W_FIRE),
            acd: p!(W_ACD),
            flash: p!(W_FLASH),
            hita: p!(W_HITA),
            hitt: p!(W_HITT),
            hitc: p!(W_HITC),
            tmon: p!(W_TMON),
            cmode: p!(W_CMODE),
            cmt: p!(W_CMT),
            ctid: p!(W_CTID),
            slayer: p!(W_SLAYER),
            brain: rd((a as usize + 4096) as *const f64, 48) == 1.0,
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
        }
    }
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
    if r != 0 {
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
/// _simAcqHit.
#[inline(always)]
unsafe fn acq_hit(m: &Mv, s: usize, stamp: i32) -> bool {
    if rd(m.cbtk, s) != stamp || rd(m.crs, s) != rd(m.rng, s) {
        return false;
    }
    let q = rd(m.cbt, s);
    q >= 0 && rd(m.dead, q as usize) == 0 && rd(m.id, q as usize) == rd(m.cti, s)
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
    irem(n, w)
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
    idiv(n - irem(n, w), w)
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
    let ax = irem(aim, w);
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
/// The navigation context of one look (simFlowLook's arguments).
struct Nav {
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
        let cf = idiv(y, v.c) * v.cw + idiv(x, v.c);
        if rd(v.rows, (v.ro + rd(v.pb, cf as usize) + l as i32) as usize) != 255 {
            return n;
        }
    }
    first
}
/// simNavStepXY.
unsafe fn nav_step(v: &Nav, t: i32, tx: i32, ty: i32, dest: i32) -> i32 {
    if t == dest {
        return -1;
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
/// simFlowLook: 1 in the look-ahead columns, 0 no way, -1 walled in, -2 a
/// bad build.
unsafe fn flow_look(m: &Mv, v: &Nav, s: usize, refresh: bool, tl: i32, gx: i32, gy: i32, dk: i32, wl: *const u8, nav_ver: i32, wv: i32, fgen: i32) -> i32 {
    if rd(m.nvt, s) == tl && rd(m.nvd, s) == dk && rd(m.nvg, s) == fgen && (!refresh || (rd(m.nvv, s) == nav_ver && rd(m.nvw, s) == wv)) {
        return 1;
    }
    let (w, h) = (v.w, v.h);
    let mut n1 = nav_step(v, tl, gx, gy, dk);
    if n1 < 0 {
        return 0;
    }
    let mut n2 = -1;
    let mut far = n1;
    let mut open = false;
    let n1x = step_x(n1, tl, gx, w);
    let n1y = step_y(n1, tl, gx, gy, w);
    if rd(wl, n1 as usize) != 0 {
        let mut aim = nav_step(v, n1, n1x, n1y, dk);
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
        let lim = if open { 6 } else { 2 };
        let mut k = 1;
        while k < lim {
            let nx = nav_step(v, cur, cx, cy, dk);
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
            cx = nxx;
            cy = nxy;
            k += 1;
        }
    }
    wr(m.nvt, s, tl);
    wr(m.nvd, s, dk);
    wr(m.nvv, s, nav_ver);
    wr(m.nvw, s, wv);
    wr(m.nvg, s, fgen);
    wr(m.nvn1, s, n1);
    wr(m.nvn2, s, n2);
    wr(m.nvf, s, far);
    wr(m.nvo, s, if open { 1 } else { 0 });
    1
}

// ---- the movement kernels ----

/// A move's step written: position quantized, the output by tile.
#[inline(always)]
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
    wr(m.x, s, qx);
    wr(m.y, s, qy);
    wr(m.out, s, if floor(qx * itile) != gx as f64 || floor(qy * itile) != gy as f64 { 3 } else { 1 });
}

/// SIM_KERNEL_MOVE_STEP over slots s0..end.
#[no_mangle]
pub unsafe extern "C" fn mv_step(a: *const i32, s0: i32, end: i32) {
    let m = Mv::load(a);
    let f = (a as usize + 4096) as *const f64;
    let t = m.t;
    let tr = to_i32(rd(f, 3));
    let (w, h, itile) = (m.w, m.h, m.itile);
    let q = rd(f, 8);
    let iq = 1.0 / q;
    let bc = to_i32(rd(f, 9)) as i64;
    let br = to_i32(rd(f, 10)) as i64;
    let players = to_i32(rd(f, 11));
    let bsz = rd(f, 14);
    let absent = rd(f, 15);
    let boxsteps = to_i32(rd(f, 17));
    let wcheck = to_i32(rd(f, 21));
    let acq_t = js_max(1.0, to_i32(rd(f, 38)) as f64) as i64;
    let wkwatch = js_max(1.0, to_i32(rd(f, 29)) as f64) as i64;
    let stride = bc + 1;
    let plane = stride * (br + 1);
    let mut s = s0.max(0) as usize;
    let end = if end > 0 { end as usize } else { 0 };
    while s < end {
        let dead = rd(m.dead, s);
        if rd(m.d0, s) != dead { wr(m.d0, s, dead); }
        if m.brain && rd(m.cmode, s) != 0 {
            s += 1;
            continue;
        }
        let on = rd(m.on, s);
        if on == 2 {
            // A parked unit before its wake tick: stands.
            let fl = rd(m.fl, s);
            let id = rd(m.id, s);
            let ts = tsum(t, id);
            let tw = t.wrapping_add(id);
            if t >= rd(m.wake, s) || (fl & 1) != 0 || ((fl & 16) != 0 && (rem64(ts, acq_t) == 0 || (tw & 3) == 0)) {
                s += 1;
                continue;
            }
            if (fl & 4) != 0 && rem64(ts, wkwatch) == 0 && (rd(m.x, s) != rd(m.wkwx, s) || rd(m.y, s) != rd(m.wkwy, s)) {
                s += 1;
                continue;
            }
            if !(rd(m.en, s) > 0.0) || rd(m.sep, s) as f64 == absent || dead != 0 {
                s += 1;
                continue;
            }
            let owner = rd(m.own, s);
            let x = rd(m.x, s);
            let y = rd(m.y, s);
            let gx = floor(x * itile);
            let gy = floor(y * itile);
            if !(owner >= 0 && owner < players) || !(inb(gx, w) && inb(gy, h)) {
                s += 1;
                continue;
            }
            let tl = gy as i32 * w + gx as i32;
            if rd(m.floor, s) != tl || irem(tw, tr) == 0 {
                let code = rd(m.sc, tl as usize) as i32;
                if code != -1 && code != owner {
                    s += 1;
                    continue;
                }
                wr(m.floor, s, tl);
            }
            wr(m.px, s, x);
            wr(m.py, s, y);
            wr(m.out, s, 1);
            wr(m.stept, s - m.stepbase, 1);
            s += 1;
            continue;
        }
        if on != 1 || (rd(m.fl, s) & 64) == 0 {
            s += 1;
            continue;
        }
        // A flow unit's committed step (_simStepFlow).
        step_flow(&m, s, t, tr, w, h, itile, q, iq, bsz, absent, boxsteps, wcheck, acq_t, stride, plane, players);
        s += 1;
    }
}

#[inline(always)]
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
    if rd(m.floor, s) != tl || irem(tw, tr) == 0 {
        let code = rd(m.sc, tl as usize) as i32;
        if code != -1 && code != owner {
            return;
        }
    }
    let ts = tsum(t, id);
    let at = rd(m.at, s);
    if (f & 16) != 0 {
        if rem64(ts, acq_t) == 0 || (tw & 3) == 0 {
            return;
        }
    } else if (f & 1) != 0 && (tw & 1) == 0 && !(rd(m.area, s) >= 0) {
        return;
    } else if (f & 1) != 0 && (tw & 1) == 0 && !(at > 0.0) && rd(m.dbtk, s) == t && rd(m.dbt, s) != -2 {
        if rd(m.dbt, s) != -1 || rd(m.dbs, s) >= 0 {
            return;
        }
    } else if (f & 1) != 0 && (tw & 1) == 0 && !(at > 0.0) {
        let area = rd(m.area, s);
        let k = area * boxsteps + rd(m.reach, s) as i32;
        if rd(m.abok, k as usize) == 0 {
            return;
        }
        let k4 = (k * 4) as usize;
        let mut x0 = rd(m.ab, k4);
        let mut y0 = rd(m.ab, k4 + 1);
        let mut x1 = rd(m.ab, k4 + 2);
        let mut y1 = rd(m.ab, k4 + 3);
        x0 = if x0 < 0 { 0 } else { x0 };
        y0 = if y0 < 0 { 0 } else { y0 };
        x1 = if x1 >= w { w - 1 } else { x1 };
        y1 = if y1 >= h { h - 1 } else { y1 };
        if x0 <= x1 && y0 <= y1 {
            let bx0 = floor(x0 as f64 / bsz) as i64;
            let by0 = floor(y0 as f64 / bsz) as i64;
            let bx1 = floor(x1 as f64 / bsz) as i64;
            let by1 = floor(y1 as f64 / bsz) as i64;
            let o = owner as i64 * plane;
            if box_sum(m.hs, o, stride, bx0, by0, bx1, by1) > 0 && !(at > 0.0) && (rd(m.dbtk, s) != t || rd(m.dbt, s) != -1 || rd(m.dbs, s) >= 0) {
                return;
            }
        }
    }
    if rd(m.wk, s) == 1 && irem(tw, wcheck) == 0 && !(rd(m.wtc, s) > 0) {
        return;
    }
    let fid = rd(m.flow, s);
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
    if t < rd(m.rdy, s) {
        return;
    }
    let mut vx = rd(m.cvx, s);
    let mut vy = rd(m.cvy, s);
    let sgx = floor((x + vx) * itile);
    let sgy = floor((y + vy) * itile);
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
        }
    }
    commit_step(m, s, x, y, vx, vy, gx, gy, tl, q, iq);
    wr(m.stept, s - m.stepbase, 1);
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

/// SIM_KERNEL_MOVE over slots s0..end (chunk: the epilogue's).
#[no_mangle]
pub unsafe extern "C" fn mv_move(a: *const i32, s0: i32, end: i32, chunk: i32) {
    wr(a as *mut i32, 299, s0);
    core::ptr::write_bytes(a.add(300) as *mut u8, 0, (end - s0).max(0) as usize);
    if rd((a as usize + 4096) as *const f64, 46) == 1.0 { mv_step(a, s0, end); }
    let m = Mv::load(a);
    let f = (a as usize + 4096) as *const f64;
    let q = rd(f, 8);
    let p = MoveP {
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
    if !m.hita.is_null() {
        wr(m.hitc, p.chunk, 0);
    }
    let mut s = s0.max(0) as usize;
    let e = if end > 0 { end as usize } else { 0 };
    while s < e {
        match move_pre(&m, &p, s) {
            1 => move_flow(&m, &p, s),
            2 => move_path(&m, &p, s),
            _ => {}
        }
        s += 1;
    }
    move_epilogue(&m, f, s0.max(0) as usize, e, chunk);
}

/// _simMoveCombat: the combat brain's instruction for slot s (cmMode bits
/// 0-1 the move: 0 own, 1 stand, 2 toward the target; bit 4 fire). False:
/// the unit's own move this tick (ended, or fire only).
unsafe fn move_combat(m: &Mv, p: &MoveP, s: usize) -> bool {
    if !(rd(m.en, s) > 0.0) || rd(m.sep, s) as f64 == p.absent || rd(m.dead, s) != 0 {
        wr(m.cmode, s, 0);
        wr(m.on, s, 0);
        return false;
    }
    let q = rd(m.cmt, s);
    if q < 0 || rd(m.dead, q as usize) != 0 || rd(m.id, q as usize) != rd(m.ctid, s) {
        wr(m.cmode, s, 0);
        return false;
    }
    let cm = rd(m.cmode, s);
    if (cm & 4) != 0 && !(rd(m.at, s) > 0.0) && !m.hita.is_null() {
        wr(m.at as *mut F32, s, rd(m.acd, s));
        wr(m.flash, s, 8);
        wr(m.tmon, s, 1);
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
    let mut spd = rd(m.spd, s);
    if rd(m.frz, s) > 0 {
        spd *= 0.5;
    }
    if rd(m.snd, s) > 0 {
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
    wr(m.x, s, qx);
    wr(m.y, s, qy);
    wr(m.vx, s, vx);
    wr(m.vy, s, vy);
    wr(m.out, s, if floor(qx * itile) as i32 != gx || floor(qy * itile) as i32 != gy { 3 } else { 1 });
    true
}
/// _simMovePre for slot s: 0 done, 1 on to the flow, 2 on to the path.
unsafe fn move_pre(m: &Mv, p: &MoveP, s: usize) -> i32 {
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
    // (An instruction of the combat brain: followed in O(1); see the
    // JavaScript twin, _simMoveCombat.)
    if m.brain && rd(m.cmode, s) != 0 && move_combat(m, p, s) {
        return 0;
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
    let hold = on == 3;
    let bhold = on == 5;
    let id0 = rd(m.id, s);
    if parked && (rd(m.fl, s) & 4) != 0 && rem64(tsum(t, id0), p.wkwatch) == 0 && (rd(m.x, s) != rd(m.wkwx, s) || rd(m.y, s) != rd(m.wkwy, s)) {
        back!();
    }
    if parked && t >= rd(m.wake, s) {
        let mut stay = false;
        if (rd(m.fl, s) & 2) != 0 && !m.wkv.is_null() && (t as f64) < rd(m.wksc, s) && (t as f64) < rd(m.wku, s) && rem64(tsum(t, id0), p.wkper as i64) == 0 {
            let gx = floor(rd(m.x, s) * itile);
            let gy = floor(rd(m.y, s) * itile);
            let o = rd(m.own, s);
            if o >= 0 && o < p.wknp {
                stay = wk_stay(m, p, s, gx, gy, o);
                if stay {
                    wr(m.wake, s, to_i32(js_min((t + p.wkper) as f64, rd(m.wksc, s))));
                }
            }
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
    if rd(m.floor, s) != tl || irem(tw, p.tr) == 0 {
        let code = rd(m.sc, tl as usize) as i32;
        if code != -1 && code != owner {
            back!();
        }
        wr(m.floor, s, tl);
    }
    let mut hchase = false;
    if hold {
        let qq = rd(m.ht, s);
        // (Its target dead: output 15, simTargetDiedCommit at its turn.)
        if !(qq >= 0) || rd(m.dead, qq as usize) != 0 || rd(m.id, qq as usize) != rd(m.htid, s) {
            wr(m.on, s, 0);
            wr(m.px, s, x);
            wr(m.py, s, y);
            wr(m.out, s, 15);
            return 0;
        }
        if (rd(m.wall, tl as usize) != 0 && (f & 32) == 0) || m.aoff.is_null() {
            back!();
        }
        let qu = qq as usize;
        let tx = rd(m.x0, qu);
        let ty = rd(m.y0, qu);
        let qgx = floor(tx * itile);
        let qgy = floor(ty * itile);
        // (Not numbers: JavaScript reads AG[NaN], no area: back too.)
        if !(inb(qgx, w) && inb(qgy, h)) {
            back!();
        }
        let tt = qgy as i32 * w + qgx as i32;
        let a = if m.ag.is_null() { -1 } else { rd(m.ag, tt as usize) };
        if !covered(m, owner, a) {
            back!();
        }
        if (f & 8) != 0 {
            wr(m.lspx, s, rd(m.lsx, s));
            wr(m.lspy, s, rd(m.lsy, s));
            wr(m.lst, s, t);
            wr(m.lsx, s, tx);
            wr(m.lsy, s, ty);
        }
        let reach = rd(m.reach, s) as i32;
        if reach <= 1 {
            let win = window_key(x, y, tile);
            if !(rd(m.hver, s) == p.area_ver && rd(m.hwin, s) as f64 == win && rd(m.htt, s) == tt) {
                let mut ir = in_area_range(m, x, y, tx, ty, reach);
                if ir == 1 {
                    wr(m.hwin, s, to_i32(win));
                    wr(m.htt, s, tt);
                    wr(m.hver, s, p.area_ver);
                } else if ir == 0 {
                    ir = in_contact_range(m, p.pad, s, qu, x, y, tx, ty, reach);
                }
                if ir == 0 {
                    hchase = true;
                } else if ir != 1 {
                    back!();
                }
            }
        } else if rd(m.hver, s) != p.area_ver || rd(m.htt, s) != tt || rd(m.hwin, s) as f64 != window_key(x, y, tile) {
            back!();
        }
        if !hchase {
            wr(m.px, s, x);
            wr(m.py, s, y);
            if rd(m.at, s) > 0.0 {
                wr(m.out, s, 6);
            } else if (f & 4) != 0 && !m.hita.is_null() {
                // (A plain attacker's attack made here, its hit listed.)
                wr(m.at as *mut F32, s, rd(m.acd, s));
                wr(m.flash, s, 8);
                wr(m.tmon, s, 1);
                let c = rd(m.hitc, p.chunk);
                wr(m.hita, p.s0 + c as usize, s as i32);
                wr(m.hitt, p.s0 + c as usize, qq);
                wr(m.hitc, p.chunk, c + 1);
                wr(m.out, s, 6);
            } else {
                wr(m.out, s, 10);
            }
            return 0;
        }
    }
    if bhold {
        let bt = rd(m.dest, s);
        if !(bt >= 0 && (bt as i64) < (w as i64) * (h as i64)) || rd(m.wall, tl as usize) != 0 || m.aoff.is_null() || m.ag.is_null() {
            back!();
        }
        let code = rd(m.sc, bt as usize) as i32;
        if code == -1 || code == owner {
            back!();
        }
        if (rd(m.fl, s) & 1) == 0 && rem64(ts, 8) == 0 && acq_hit(m, s, p.acq_stamp) {
            back!();
        }
        let a = rd(m.ag, bt as usize);
        if !covered(m, owner, a) {
            back!();
        }
        let bgx = irem(bt, w);
        let bgy = idiv(bt - bgx, w);
        if in_area_range(m, x, y, bgx as f64 * tile + tile / 2.0, bgy as f64 * tile + tile / 2.0, rd(m.reach, s) as i32) != 1 {
            back!();
        }
        wr(m.px, s, x);
        wr(m.py, s, y);
        wr(m.out, s, if rd(m.at, s) > 0.0 { 6 } else { 10 });
        return 0;
    }
    if on == 4 || hchase {
        let qq = rd(m.ht, s);
        if !hchase && (!(qq >= 0) || rd(m.dead, qq as usize) != 0 || rd(m.id, qq as usize) != rd(m.htid, s)) {
            wr(m.on, s, 0);
            wr(m.px, s, x);
            wr(m.py, s, y);
            wr(m.out, s, 15);
            return 0;
        }
        if !hchase && m.aoff.is_null() {
            back!();
        }
        let qu = qq as usize;
        let tx = rd(m.x0, qu);
        let ty = rd(m.y0, qu);
        let qgxf = floor(tx * itile);
        let qgyf = floor(ty * itile);
        if !hchase {
            if !(inb(qgxf, w) && inb(qgyf, h)) {
                back!();
            }
            let a = if m.ag.is_null() { -1 } else { rd(m.ag, (qgyf as i32 * w + qgxf as i32) as usize) };
            if !covered(m, owner, a) {
                back!();
            }
            if (f & 8) != 0 {
                wr(m.lspx, s, rd(m.lsx, s));
                wr(m.lspy, s, rd(m.lsy, s));
                wr(m.lst, s, t);
                wr(m.lsx, s, tx);
                wr(m.lsy, s, ty);
            }
            let ir = in_attack_range(m, p.pad, s, qu, x, y, tx, ty, rd(m.reach, s) as i32);
            if ir == 1 {
                wr(m.on, s, 3);
                wr(m.hver, s, -1);
                wr(m.px, s, x);
                wr(m.py, s, y);
                wr(m.out, s, 13);
                if !(rd(m.at, s) > 0.0) && (f & 4) != 0 && !m.hita.is_null() {
                    wr(m.at as *mut F32, s, rd(m.acd, s));
                    wr(m.flash, s, 8);
                wr(m.tmon, s, 1);
                    let c = rd(m.hitc, p.chunk);
                    wr(m.hita, p.s0 + c as usize, s as i32);
                    wr(m.hitt, p.s0 + c as usize, qq);
                    wr(m.hitc, p.chunk, c + 1);
                }
                return 0;
            }
            if ir != 0 {
                back!();
            }
        }
        // (The target's tile: in the map, checked above for both.)
        let (qgx, qgy) = (qgxf as i32, qgyf as i32);
        let dx = tx - x;
        let dy = ty - y;
        let d = sqrt(dx * dx + dy * dy);
        if !(d > 0.0) || (d > 8.0 * tile && (f & 8) == 0) {
            back!();
        }
        let fly = (f & 32) != 0;
        if !fly && rd(m.wall, tl as usize) != 0 {
            back!();
        }
        let mut direct = d < 2.0 * tile || (fly && (f & 2) == 0);
        if !direct && d < 6.0 * tile {
            let st = rd(m.chs, s);
            let ax = x + dx / d * st;
            let ay = y + dy / d * st;
            let agx = floor(ax * itile);
            let agy = floor(ay * itile);
            direct = inb(agx, w) && inb(agy, h) && rd(m.wall, (agy as i32 * w + agx as i32) as usize) == 0 && rd(m.wall, (qgy * w + qgx) as usize) == 0;
        }
        if !direct && (hchase || (f & 64) == 0) {
            back!();
        }
        if direct {
            let mut spd = rd(m.spd, s);
            if rd(m.frz, s) > 0 {
                spd *= 0.5;
            }
            if rd(m.snd, s) > 0 {
                spd *= 0.5;
            }
            let nx = (x + (dx / d) * spd) as f32 as f64;
            let ny = (y + (dy / d) * spd) as f32 as f64;
            let ngx = floor(nx * itile);
            let ngy = floor(ny * itile);
            // (JavaScript: WALL[NaN] is undefined, no wall.)
            if !fly && (ngx < 0.0 || ngy < 0.0 || ngx >= w as f64 || ngy >= h as f64 || (inb(ngx, w) && inb(ngy, h) && rd(m.wall, (ngy as i32 * w + ngx as i32) as usize) != 0)) {
                back!();
            }
            let qx = quant_div(nx, p.q);
            let qy = quant_div(ny, p.q);
            wr(m.px, s, x);
            wr(m.py, s, y);
            wr(m.x, s, qx);
            wr(m.y, s, qy);
            let moved = floor(qx * itile) != gx as f64 || floor(qy * itile) != gy as f64;
            wr(m.out, s, if moved { if hchase { 12 } else { 9 } } else if hchase { 11 } else { 7 });
            return 0;
        }
    }
    if on == 6 {
        let bt = rd(m.ht, s);
        if !(bt >= 0 && (bt as i64) < (w as i64) * (h as i64)) || m.aoff.is_null() || m.ag.is_null() {
            back!();
        }
        let code = rd(m.sc, bt as usize) as i32;
        if code == -1 || code == owner {
            back!();
        }
        if rd(m.htid, s) == 0 && rem64(ts, 8) == 0 && acq_hit(m, s, p.acq_stamp) {
            back!();
        }
        let a = rd(m.ag, bt as usize);
        if !covered(m, owner, a) {
            back!();
        }
        let bgx = irem(bt, w);
        let bgy = idiv(bt - bgx, w);
        if in_area_range(m, x, y, bgx as f64 * tile + tile / 2.0, bgy as f64 * tile + tile / 2.0, rd(m.reach, s) as i32) != 0 {
            back!();
        }
    }
    let atk = (f & 16) != 0;
    let mut db_look = !m.brain && !atk && (f & 1) != 0 && (tw & 1) == 0;
    let at = rd(m.at, s);
    if db_look {
        if !(rd(m.area, s) >= 0) {
            back!();
        }
        if at > 0.0 {
            db_look = false;
        } else if rd(m.dbtk, s) == t && rd(m.dbt, s) != -2 {
            // (Found something: on with its move, the shot at its turn.)
            if rd(m.dbt, s) != -1 || rd(m.dbs, s) >= 0 {
                wr(m.fire, s, 1);
            }
            db_look = false;
        }
    }
    if if atk { !m.brain && (rem64(ts, p.acq_t) == 0 || (tw & 3) == 0) } else { db_look } {
        let (x0, y0, x1, y1);
        if atk {
            let r = rd(m.reach, s) as f64;
            x0 = gxf - r;
            y0 = gyf - r;
            x1 = gxf + r;
            y1 = gyf + r;
        } else {
            let area = rd(m.area, s);
            let k = area * p.boxsteps + rd(m.reach, s) as i32;
            if !(area >= 0) || rd(m.abok, k as usize) == 0 {
                back!();
            }
            let k4 = (k * 4) as usize;
            x0 = rd(m.ab, k4) as f64;
            y0 = rd(m.ab, k4 + 1) as f64;
            x1 = rd(m.ab, k4 + 2) as f64;
            y1 = rd(m.ab, k4 + 3) as f64;
        }
        let (x0, y0, x1, y1) = clamp_box(x0, y0, x1, y1, w, h);
        if x0 <= x1 && y0 <= y1 {
            let bx0 = floor(x0 / p.bsz) as i64;
            let by0 = floor(y0 / p.bsz) as i64;
            let bx1 = floor(x1 / p.bsz) as i64;
            let by1 = floor(y1 / p.bsz) as i64;
            let stride = p.bc + 1;
            let plane = stride * (p.br + 1);
            if box_sum(m.hs, owner as i64 * plane, stride, bx0, by0, bx1, by1) > 0 {
                if !atk {
                    if !(at > 0.0) && (rd(m.dbtk, s) != t || rd(m.dbt, s) != -1 || rd(m.dbs, s) >= 0) {
                        back!();
                    }
                } else if rem64(ts, p.acq_t) == 0 && acq_hit(m, s, p.acq_stamp) {
                    wr(m.on, s, 0);
                    wr(m.px, s, x);
                    wr(m.py, s, y);
                    wr(m.out, s, 14);
                    return 0;
                }
                if atk && (tw & 3) == 0 && rd(m.cbtk, s) == p.acq_stamp && rd(m.crs, s) == rd(m.rng, s) {
                    let cb = rd(m.cbs, s);
                    if cb >= 0 {
                        let code = rd(m.sc, cb as usize) as i32;
                        if code != -1 && code != owner && !m.ag.is_null() {
                            let a = rd(m.ag, cb as usize);
                            if a >= 0 && covered(m, owner, a) {
                                back!();
                            }
                        }
                    }
                }
            }
        }
    }
    if parked {
        wr(m.px, s, x);
        wr(m.py, s, y);
        wr(m.out, s, 1);
        return 0;
    }
    if (f & 64) != 0 { 1 } else { 2 }
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
    let mine = (o as i64 * p.wktypes as i64 + rd(m.wkty, s) as i64) * span;
    let d = rd(m.wkd, s) as f64;
    let tw = rd(m.wktw, s);
    let mut hh = to_i32(imul(get(all).unwrap_or(0), 31) as f64 + nan(get(mine)));
    if tw & 2 != 0 {
        hh = imul(hh, 31).wrapping_add(p.wkhgen);
    }
    let passes = if tw & 1 != 0 { 2 } else { 1 };
    let wkr = p.wkr as f64;
    for pass in 0..passes {
        let (cx, cy) = if pass != 0 || (tw & 1) == 0 { (gx, gy) } else { (rd(m.wkox, s) as f64, rd(m.wkoy, s) as f64) };
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
    hh == rd(m.wkf, s)
}

/// _simMoveFlow for slot s.
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
    if rd(m.wk, s) == 1 && irem(tw, p.wcheck) == 0 && !(rd(m.wtc, s) > 0) {
        back!();
    }
    let dk = rd(m.dest, s);
    let dx0 = irem(dk, w);
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
    let wide = fid >= 4194304;
    let did = if wide { fid - 4194304 } else { fid };
    let dm = (did as i64 * 8) as usize;
    let (fmeta, fmn, fpool) = if wide { (m.fmw, m.fmwn, m.fpw) } else { (m.fmn, m.fmnn, m.fpn) };
    if !(fid >= 0) || fmeta.is_null() || dm + 7 >= fmn || rd(fmeta, dm + 6) != rd(m.fgen, s) || rd(fmeta, dm + 1) != dk {
        back!();
    }
    if t < rd(m.rdy, s) {
        stand!();
    }
    if rd(fmeta, dm + 7) != 1 {
        back!();
    }
    if rd(m.cd, s) == dk && rd(m.ctl, s) == tl && t - rd(m.ct, s) < rd(m.cn, s) as i32 {
        if tl == dk {
            back!();
        }
        let mut vx = rd(m.cvx, s);
        let mut vy = rd(m.cvy, s);
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
            }
        }
        commit_step(m, s, x, y, vx, vy, gx, gy, tl, p.q, p.iq);
        return;
    }
    wr(m.cd, s, -1);
    let nv = match navp {
        Some(n) => n,
        None => back!(),
    };
    let rows = if wide { m.frw } else { m.frn };
    let rw = if m.fhd.is_null() { 0 } else { rd(m.fhd, if wide { 1 } else { 0 }) };
    if nv.fields.is_null() || nv.meta.is_null() || nv.partl.is_null() || nv.partb.is_null() || rows.is_null() || !(rw > 0) {
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
        let look = (tw & 15) == 0;
        if !look || ((tw & 63) != 0 && !(rd(m.cwt, s) == t && rd(m.cwd, s) < 9)) {
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
        let mut es = rd(m.spd, s);
        if rd(m.frz, s) > 0 {
            es *= 0.5;
        }
        if rd(m.snd, s) > 0 {
            es *= 0.5;
        }
        let near = (dx0 - gx).abs() <= 8 && (dy0 - gy).abs() <= 8;
        if last >= 0.0 && last - now < es * 0.3 * SIM_STEER_NEAR_TICKS as f64 {
            if near && rd(m.cwt, s) == t && rd(m.cwn, s) == 1 {
                back!();
            }
            if rd(m.cwt, s) == t && rd(m.cwn, s) == 1 {
                wr(m.nld, s, (-2 - dk) as f64);
                stand!();
            }
        }
        nav_ld = now;
    }
    // The look-ahead (simFlowLook): clusters of 2^cs tiles.
    let cs = 31 - (n_c as u32).leading_zeros() as i32;
    let v = Nav {
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
        df: fpool,
        doff: did * span * span,
        bx: rd(fmeta, dm + 2),
        by: rd(fmeta, dm + 3),
        bw: rd(fmeta, dm + 4),
        bh: rd(fmeta, dm + 5),
    };
    let wv = if m.wblk9.is_null() { p.wver } else { rd(m.wblk9, ((gy >> 3) * p.wbw + (gx >> 3)) as usize) };
    let refresh = (tw & (SIM_FLOW_REFRESH_TICKS - 1)) == 0;
    let lk = flow_look(m, &v, s, refresh, tl, gx, gy, dk, wl, rd(nv.meta, 6), wv, if wide { 2 } else { 1 });
    if lk == 0 {
        if rd(m.wk, s) == 1 && ((dx0 - gx).abs() > 1 || (dy0 - gy).abs() > 1) {
            stand!();
        }
        back!();
    }
    if lk == -1 {
        stand!();
    }
    if lk == -2 {
        back!();
    }
    let n1 = rd(m.nvn1, s);
    let n2 = rd(m.nvn2, s);
    let far = rd(m.nvf, s);
    let open = rd(m.nvo, s) == 1;
    wr(m.nld, s, nav_ld);
    let kx = irem(far, w);
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
        let mut side = ((x - (gx as f64 * tile + 16.0)) * sx + (y - (gy as f64 * tile + 16.0)) * sy) * 0.875;
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
        let n2x = irem(n2, w);
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
        let n2x = irem(n2, w);
        tx = n2x as f64 * tile + 16.0;
        ty = idiv(n2 - n2x, w) as f64 * tile + 16.0;
        dx = tx - x;
        dy = ty - y;
        dist = sqrt(dx * dx + dy * dy);
        if dist < 4.0 {
            stand!();
        }
    }
    let mut spd = rd(m.spd, s);
    if rd(m.frz, s) > 0 {
        spd *= 0.5;
    }
    if rd(m.snd, s) > 0 {
        spd *= 0.5;
    }
    let mut vx = (dx / dist) * spd;
    let mut vy = (dy / dist) * spd;
    if (f & 32) == 0 {
        let sl = flow_slide(wl, w, h, gx, gy, floor((x + vx) * itile), floor((y + vy) * itile));
        if sl & 1 != 0 {
            vx = 0.0;
        }
        if sl & 2 != 0 {
            vy = 0.0;
        }
    }
    wr(m.cd, s, dk);
    wr(m.ct, s, t);
    wr(m.cvx, s, vx);
    wr(m.cvy, s, vy);
    wr(m.ctl, s, tl);
    wr(m.cn, s, if (dx0 - gx).abs() <= 8 && (dy0 - gy).abs() <= 8 { SIM_STEER_NEAR_TICKS } else { SIM_STEER_TICKS });
    commit_step(m, s, x, y, vx, vy, gx, gy, tl, p.q, p.iq);
}

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
    let kx = irem(k, w);
    let ky = idiv(k - kx, w);
    let nx = irem(nk, w);
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
    if rd(m.wk, s) == 1 && irem(t.wrapping_add(id), p.wcheck) == 0 && !(rd(m.wtc, s) > 0) {
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
            let kx = irem(k, w);
            let ky = idiv(k - kx, w);
            let dx = kx - gx;
            let dy = ky - gy;
            if i + 1 < len {
                let nk = node(m, nb, base, wl, i + 1);
                if nk < 0 {
                    back!();
                }
                let nx = irem(nk, w);
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
    let kx = irem(k, w);
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
        px = irem(pk, w);
        py = idiv(pk - px, w);
        seg_dx = kx - px;
        seg_dy = ky - py;
    } else if idx + 1 < len {
        let nk = node(m, nb, base, wl, idx + 1);
        if nk < 0 {
            back!();
        }
        let nx = irem(nk, w);
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
            let nx = irem(nk, w);
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
        let mut ax = irem(ak, w);
        let mut ay = idiv(ak - ax, w);
        if fk >= 0 {
            let fx = irem(fk, w);
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
    let mut spd = rd(m.spd, s);
    if rd(m.frz, s) > 0 {
        spd *= 0.5;
    }
    if rd(m.snd, s) > 0 {
        spd *= 0.5;
    }
    let vx = (dx / dist) * spd;
    let vy = (dy / dist) * spd;
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
        wr(m.x, s, nx);
        wr(m.y, s, ny);
        wr(m.on, s, 0);
        wr(m.out, s, 4);
        return;
    }
    let qx = quant_mul(nx, p.q, p.iq);
    let qy = quant_mul(ny, p.q, p.iq);
    wr(m.x, s, qx);
    wr(m.y, s, qy);
    wr(m.out, s, if floor(qx * itile) != gx as f64 || floor(qy * itile) != gy as f64 { 3 } else { 1 });
}

/// _simMoveEpilogue over the chunk's slots b0..end.
unsafe fn move_epilogue(m: &Mv, f: *const f64, b0: usize, end: usize, chunk: i32) {
    if m.post.is_null() || m.postc.is_null() {
        return;
    }
    let (w, h, itile) = (m.w, m.h, m.itile);
    let absent = rd(f, 15);
    let boxsteps = to_i32(rd(f, 17));
    let epoch = to_i32(rd(f, 40));
    let vis_gen = to_i32(rd(f, 41));
    let vis_all = to_i32(rd(f, 42));
    let cwn = to_i32(rd(f, 34));
    let csz = to_i32(rd(f, 36));
    let np = to_i32(rd(f, 43));
    let nt = to_i32(rd(f, 44));
    let scale = rd(f, 45);
    let per = to_i32(rd(f, 1)) as usize;
    let chunk = chunk.max(0) as usize;
    let f0 = chunk * np.max(0) as usize;
    let u0 = f0 * nt.max(0) as usize;
    for i in 0..np.max(0) as usize {
        wr(m.fix, f0 + i, 0.0);
    }
    for i in 0..(np.max(0) * nt.max(0)) as usize {
        wr(m.use_, u0 + i, 0.0);
    }
    let pb = chunk * per;
    let mut cnt = 0usize;
    let mut s = b0;
    while s < end {
        let o = rd(m.out, s);
        if o == 0 {
            s += 1;
            continue;
        }
        let mut list = o == 4 || o == 5;
        let k = rd(m.spent, s);
        if k != 0 {
            wr(m.spent, s, 0);
            let pid = rd(m.own, s);
            let cost = rd(m.cost, s);
            if cost > 0.0 && pid >= 0 && pid < np {
                if rd(m.rem, pid as usize) < cost {
                    wr(m.blk, s, 1);
                    list = true;
                }
                let fi = f0 + pid as usize;
                wr(m.fix, fi, rd(m.fix, fi) + k as f64 * js_round(-cost * scale));
                let ty = rd(m.spty, s) as i32;
                let r = u0 + (pid * nt) as usize + (if ty >= 0 && ty < nt - 1 { ty } else { nt - 1 }) as usize;
                for _ in 0..k {
                    wr(m.use_, r, rd(m.use_, r) + cost);
                }
            }
        }
        if o == 3 || o == 9 || o == 12 {
            let gxf = floor(rd(m.x, s) * itile);
            let gyf = floor(rd(m.y, s) * itile);
            let gx = if !(gxf >= 0.0) { 0 } else if gxf >= w as f64 { w - 1 } else { gxf as i32 };
            let gy = if !(gyf >= 0.0) { 0 } else if gyf >= h as f64 { h - 1 } else { gyf as i32 };
            let tt = gy * w + gx;
            let sep = rd(m.sep, s);
            if rd(m.spe, s) == epoch && rd(m.spo, s) == rd(m.own, s) && sep as f64 != absent && (vis_all != 0 || rd(m.vsg, s) == vis_gen) {
                if tt != rd(m.spt, s) {
                    let key = if csz == 1 { tt } else { idiv(gy, csz) * cwn + idiv(gx, csz) };
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
                    if o == 3 && (rd(m.fl, s) & 1) != 0 && na != a0 && na >= 0 && rd(m.abok, (na * boxsteps + rd(m.reach, s) as i32) as usize) == 0 {
                        list = true;
                    }
                }
            } else {
                list = true;
            }
        }
        if list {
            wr(m.post, pb + cnt, s as i32);
            cnt += 1;
        }
        s += 1;
    }
    wr(m.postc, chunk, cnt as i32);
}

/// A drive-by look's candidate q (the JavaScript twin's cheap checks): its
/// squared distance, or None.
const DB_CANDS: usize = 64;
#[inline(always)]
unsafe fn db_candidate(m: &Mv, q: i32, owner: i32, x: f64, y: f64, x0: i32, y0: i32, x1: i32, y1: i32, tile: f64, w: i32) -> Option<f64> {
    if q < 0 || rd(m.dead, q as usize) != 0 || rd(m.own, q as usize) == owner {
        return None;
    }
    let qu = q as usize;
    let tx = rd(m.x0, qu);
    let ty = rd(m.y0, qu);
    let qgx = floor(tx / tile);
    let qgy = floor(ty / tile);
    // (Not numbers: no area there, skipped as in JavaScript.)
    if !(qgx >= x0 as f64 && qgy >= y0 as f64 && qgx <= x1 as f64 && qgy <= y1 as f64) {
        return None;
    }
    let a = rd(m.ag, (qgy as i32 * w + qgx as i32) as usize);
    if !covered(m, owner, a) {
        return None;
    }
    let dx = tx - x;
    let dy = ty - y;
    Some(dx * dx + dy * dy)
}


/// SIM_KERNEL_DRIVEBY over slots s0..end.
#[no_mangle]
pub unsafe extern "C" fn mv_driveby(a: *const i32, s0: i32, end: i32) {
    let m = Mv::load(a);
    let f = (a as usize + 4096) as *const f64;
    let t = m.t;
    let cw = to_i32(rd(f, 3));
    let ch = to_i32(rd(f, 4));
    let tile = rd(f, 5);
    let ep = to_i32(rd(f, 6));
    let players = to_i32(rd(f, 7));
    let cmd_move = rd(f, 8);
    let w = to_i32(rd(f, 9));
    let h = to_i32(rd(f, 10));
    let cs = to_i32(rd(f, 11));
    let absent = rd(f, 12);
    let boxsteps = to_i32(rd(f, 13));
    let pad = rd(f, 14);
    let bk = to_i32(rd(f, 15));
    let bc = to_i32(rd(f, 16));
    let br = to_i32(rd(f, 17));
    let om = if rd(f, 18) != 0.0 && rd(f, 18) == rd(f, 18) { m.om } else { 0 as *const u8 };
    let stride = bc as i64 + 1;
    let plane = stride * (br as i64 + 1);
    let half = tile / 2.0;
    // (The area helpers read the map's size and tile from the context.)
    let mut m = m;
    m.w = w;
    m.h = h;
    m.tile = tile;
    m.itile = 1.0 / tile;
    let m = &m;
    if m.ag.is_null() || m.aoff.is_null() || m.ab.is_null() || m.abok.is_null() || m.covf.is_null() || m.rs.is_null() || m.sc.is_null() || m.scls.is_null() {
        return;
    }
    let mut s = s0.max(0) as usize;
    let end = if end > 0 { end as usize } else { 0 };
    while s < end {
        let su = s;
        s += 1;
        if rd(m.cmd, su) as f64 != cmd_move || rd(m.dead, su) != 0 || rd(m.sep, su) as f64 == absent || rd(m.shoot, su) == 0 || rd(m.at, su) > 0.0 {
            continue;
        }
        let id = rd(m.id, su);
        if (t.wrapping_add(id) & 1) != 0 {
            continue;
        }
        wr(m.dbtk, su, t);
        wr(m.dbt, su, -2);
        wr(m.dbs, su, -1);
        let owner = rd(m.own, su);
        let area = rd(m.area, su);
        let steps = rd(m.rd_, su);
        if !(owner >= 0 && owner < players) || !(area >= 0) || steps == 255 {
            continue;
        }
        let kb = (area * boxsteps + steps as i32) as usize;
        if rd(m.abok, kb) == 0 {
            continue;
        }
        if !cover_row(m, owner) {
            continue;
        }
        let x0 = rd(m.ab, kb * 4).max(0);
        let y0 = rd(m.ab, kb * 4 + 1).max(0);
        let x1 = (w - 1).min(rd(m.ab, kb * 4 + 2));
        let y1 = (h - 1).min(rd(m.ab, kb * 4 + 3));
        let k = rd(m.rk, su) as i32;
        let whole = (rd(m.lzf, su) & 4) != 0;
        let x = rd(m.x, su);
        let y = rd(m.y, su);
        let foe: u8 = if owner < 8 { 0xFF ^ (1u8 << owner) } else { 0xFF };
        if !m.hs.is_null() && x0 <= x1 && y0 <= y1 {
            let bx0 = idiv(x0, bk);
            let by0 = idiv(y0, bk);
            let bx1 = (bc - 1).min(idiv(x1, bk));
            let by1 = (br - 1).min(idiv(y1, bk));
            if bx0 <= bx1 && by0 <= by1 && box_sum(m.hs, owner as i64 * plane, stride, bx0 as i64, by0 as i64, bx1 as i64, by1 as i64) <= 0 {
                wr(m.dbt, su, -1);
                continue;
            }
        }
        // The nearest enemy unit in range (then the lower id): candidates
        // listed, then range-checked nearest first; over DB_CANDS, the scan
        // again range-checking each new best. See the JavaScript twin.
        let mut best: i32 = -1;
        let mut unknown = false;
        if x0 <= x1 && y0 <= y1 {
            let cx0 = floor(x0 as f64 / cs as f64) as i32;
            let cy0 = floor(y0 as f64 / cs as f64) as i32;
            let cx1 = (cw - 1).min(floor(x1 as f64 / cs as f64) as i32);
            let cy1 = (ch - 1).min(floor(y1 as f64 / cs as f64) as i32);
            // (Each cell's owner mask, 8 cells at a time as one u64: runs
            // with no foe bit are passed over whole. Same cells, same order.)
            let rep = (foe as u64).wrapping_mul(0x0101_0101_0101_0101);
            let mut cqa = [0i32; DB_CANDS];
            let mut cda = [0f64; DB_CANDS];
            // (Unchecked: indices stay under DB_CANDS; no panic paths in the module.)
            let cq = cqa.as_mut_ptr();
            let cd = cda.as_mut_ptr();
            let mut nc = 0usize;
            let mut over = false;
            let mut cy = cy0;
            'scan: while cy <= cy1 {
                let mut cx = cx0;
                while cx <= cx1 {
                    if !om.is_null() {
                        while cx + 7 <= cx1 {
                            let hit = (om.add((cy * cw + cx) as usize) as *const u64).read_unaligned() & rep;
                            if hit == 0 {
                                cx += 8;
                                continue;
                            }
                            cx += (hit.trailing_zeros() / 8) as i32;
                            break;
                        }
                        if cx > cx1 {
                            break;
                        }
                    }
                    let ck = (cy * cw + cx) as usize;
                    cx += 1;
                    if rd(m.rst, ck) != ep || (!om.is_null() && (rd(om, ck) & foe) == 0) {
                        continue;
                    }
                    let e0 = rd(m.rs, ck);
                    let e1 = e0 + rd(m.rc, ck);
                    let mut e = e0;
                    while e < e1 {
                        let q = rd(m.es, e as usize);
                        e += 1;
                        if let Some(d2) = db_candidate(m, q, owner, x, y, x0, y0, x1, y1, tile, w) {
                            if nc == DB_CANDS {
                                over = true;
                                break 'scan;
                            }
                            *cq.add(nc) = q;
                            *cd.add(nc) = d2;
                            nc += 1;
                        }
                    }
                }
                cy += 1;
            }
            if !over {
                let mut i = 0;
                while i < nc {
                    let mut k2 = i;
                    let mut j = i + 1;
                    while j < nc {
                        let (dj, dk) = (*cd.add(j), *cd.add(k2));
                        if dj < dk || (dj == dk && rd(m.id, *cq.add(j) as usize) < rd(m.id, *cq.add(k2) as usize)) {
                            k2 = j;
                        }
                        j += 1;
                    }
                    core::ptr::swap(cq.add(i), cq.add(k2));
                    core::ptr::swap(cd.add(i), cd.add(k2));
                    let qu = *cq.add(i) as usize;
                    let tx = rd(m.x0, qu);
                    let ty = rd(m.y0, qu);
                    let r = if whole { in_area_range(m, x, y, tx, ty, k) } else { in_attack_range(m, pad, su, qu, x, y, tx, ty, k) };
                    if r < 0 {
                        unknown = true;
                        break;
                    }
                    if r == 1 {
                        best = *cq.add(i);
                        break;
                    }
                    i += 1;
                }
            } else {
                let mut bd2 = f64::INFINITY;
                let mut cy = cy0;
                'rows: while cy <= cy1 {
                    let mut cx = cx0;
                    while cx <= cx1 {
                        let ck = (cy * cw + cx) as usize;
                        cx += 1;
                        if rd(m.rst, ck) != ep || (!om.is_null() && (rd(om, ck) & foe) == 0) {
                            continue;
                        }
                        let e0 = rd(m.rs, ck);
                        let e1 = e0 + rd(m.rc, ck);
                        let mut e = e0;
                        while e < e1 {
                            let q = rd(m.es, e as usize);
                            e += 1;
                            let d2 = match db_candidate(m, q, owner, x, y, x0, y0, x1, y1, tile, w) {
                                Some(d) => d,
                                None => continue,
                            };
                            let qu = q as usize;
                            let best_id = if best >= 0 { rd(m.id, best as usize) } else { 0 };
                            if !(d2 < bd2 || (d2 == bd2 && rd(m.id, qu) < best_id)) {
                                continue;
                            }
                            let tx = rd(m.x0, qu);
                            let ty = rd(m.y0, qu);
                            let r = if whole { in_area_range(m, x, y, tx, ty, k) } else { in_attack_range(m, pad, su, qu, x, y, tx, ty, k) };
                            if r < 0 {
                                unknown = true;
                                break 'rows;
                            }
                            if r != 1 {
                                continue;
                            }
                            best = q;
                            bd2 = d2;
                        }
                    }
                    cy += 1;
                }
            }
        }
        if unknown {
            continue;
        }
        if best >= 0 {
            wr(m.dbt, su, best);
            wr(m.dbti, su, rd(m.id, best as usize));
            continue;
        }
        wr(m.dbt, su, -1);
        if !(x0 <= x1 && y0 <= y1) {
            continue;
        }
        if !m.hss.is_null() {
            let bx0 = idiv(x0, bk);
            let by0 = idiv(y0, bk);
            let bx1 = (bc - 1).min(idiv(x1, bk));
            let by1 = (br - 1).min(idiv(y1, bk));
            if bx0 <= bx1 && by0 <= by1 && box_sum(m.hss, owner as i64 * plane, stride, bx0 as i64, by0 as i64, bx1 as i64, by1 as i64) <= 0 {
                continue;
            }
        }
        let mut best_t: i32 = -1;
        let mut best_r = 9;
        let mut best_d = f64::INFINITY;
        let mut gy = y0;
        'srows: while gy <= y1 {
            let mut gx = x0;
            let mut tt = gy * w + x0;
            let by = idiv(gy, bk);
            while gx <= x1 {
                // (A block of the row with no hostile structure: passed
                // over whole; see the JavaScript twin.)
                if !m.hss.is_null() && (gx == x0 || irem(gx, bk) == 0) {
                    let bx = idiv(gx, bk);
                    if bx < bc && by < br && box_sum(m.hss, owner as i64 * plane, stride, bx as i64, by as i64, bx as i64, by as i64) <= 0 {
                        let last = x1.min((bx + 1) * bk - 1);
                        tt += last - gx + 1;
                        gx = last + 1;
                        continue;
                    }
                }
                let (cgx, ctt) = (gx, tt);
                gx += 1;
                tt += 1;
                let cls = rd(m.scls, ctt as usize);
                if cls <= 0 {
                    continue;
                }
                let rank = if cls == 1 { 0 } else if cls == 2 { 2 } else { 3 };
                if rank > best_r {
                    continue;
                }
                let code = rd(m.sc, ctt as usize) as i32;
                if code == -1 || code == owner {
                    continue;
                }
                let a = rd(m.ag, ctt as usize);
                if !covered(m, owner, a) {
                    continue;
                }
                let cxp = cgx as f64 * tile + half;
                let cyp = gy as f64 * tile + half;
                let dx = cxp - x;
                let dy = cyp - y;
                let d2 = dx * dx + dy * dy;
                if rank == best_r && (d2 > best_d || (d2 == best_d && ctt > best_t)) {
                    continue;
                }
                let r = in_area_range(m, x, y, cxp, cyp, k);
                if r < 0 {
                    unknown = true;
                    break 'srows;
                }
                if r != 1 {
                    continue;
                }
                best_t = ctt;
                best_r = rank;
                best_d = d2;
            }
            gy += 1;
        }
        if unknown {
            wr(m.dbt, su, -2);
            continue;
        }
        wr(m.dbs, su, best_t);
    }
}
