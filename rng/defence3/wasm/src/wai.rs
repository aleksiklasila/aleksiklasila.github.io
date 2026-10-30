//! The worker state machine (worker.js updateWorkerAI with unit.js
//! _unitWorkerEvent around it): one serial pass over the tick's worker
//! events in their order (unit.js unitEventsRun), the workers' columns,
//! the structure tables and the reservation and work version tables
//! written as the JavaScript did, payments into the resource batch rows,
//! out events for what stays JavaScript (presentation, the research queue's
//! advance, the events of types not converted yet). MAIN_THREAD_SERIAL_PLAN.md
//! "Stage D". Converted: researchers.
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

// Worker states (sim_unit_state.js SIM_WS_NAMES).
const WS_IDLE: u32 = 1;
const WS_RETURNING: u32 = 4;
const WS_RETURNING_ASTAR: u32 = 5;
const WS_RETURNING_FOR_GOLD: u32 = 6;
const WS_MOVING_TO_RESEARCH: u32 = 11;
const WS_RESEARCHING: u32 = 12;
const WS_MANUAL: u32 = 13;
#[inline(always)]
fn ws_moving(st: u32) -> bool {
    st < 32 && (WS_MOVING_MASK >> st) & 1 != 0
}
#[inline(always)]
fn ws_standing(st: u32) -> bool {
    st < 32 && (WS_STANDING_MASK >> st) & 1 != 0
}
// (Bit masks, no lookup tables: the module may have no data segments.)
const WS_MOVING_MASK: u32 = (1 << 2) | (1 << 3) | (1 << 4) | (1 << 5) | (1 << 6) | (1 << 7) | (1 << 9) | (1 << 11) | (1 << 13);
const WS_STANDING_MASK: u32 = (1 << 1) | (1 << 8) | (1 << 10) | (1 << 12);
// Target kinds (SIM_WT_*).
const WT_NULL: u32 = 1;
const WT_ITEM: u32 = 2;
const WT_TILE: u32 = 3;
const WT_UNIT: u32 = 5;
const CMD_IDLE: u8 = 0;
const CMD_MOVING: u8 = 1;
// Unit event codes (mv.rs EV_*).
const EV_NOWAY: i32 = 2;
// Out events.
const OUT_SOUND_RESEARCH: i32 = 1;
const OUT_RESEARCH_ADVANCE: i32 = 2;
const OUT_DECLINED: i32 = 3;
const OUT_ARM: i32 = 4;
const OUT_SALVAGE: i32 = 5;
const OUT_SOUND_UNIT: i32 = 6;
// (Sounds at a unit, OUT_SOUND_UNIT's value.)
const SND_SALVAGER_WORK: i32 = 1;
const SND_SALVAGE_COLLECTED: i32 = 2;
const SND_COLLECTOR_WORK: i32 = 3;
const SND_ASTAR_WORK: i32 = 4;
const SND_GOLD_COLLECTED: i32 = 5;
const SND_ASTAR_COLLECTED: i32 = 6;
const OUT_MINE: i32 = 7;
const OUT_ASTAR_LOG: i32 = 8;
const OUT_CLEAR_ROUTE: i32 = 9;
// (A spawn queue paid: its production and ready order, barrack.js.)
const OUT_QUEUE_PAID: i32 = 10;
// (heal_tick at a structure's tile (a) or a unit's slot (b >= 0), as an
// ambient sound of the target.)
const OUT_SOUND_HEAL: i32 = 11;
// (A structure's work done: construction (b 0), an upgrade (1), stacks (2,
// v stacked any), its maxEnergy to set (3, v the value): worker.js
// _waiBuilt, things_utils.js's completions.)
const OUT_BUILT: i32 = 12;
// (builder_work at a structure, an ambient sound.)
const OUT_SOUND_BUILD: i32 = 13;
// (A candidate's start, _isBuilderWorkTarget's side effect: b 0 stacking
// (refreshThingProgressState), 1 an upgrade (beginUpgradeProgress).)
// Worker record types (unit.wbType).
const WB_COLLECTOR: u8 = 1;
const WB_ASTAR: u8 = 2;
const WB_SALVAGER: u8 = 3;
const WB_BUILDER: u8 = 4;
const WB_HEALER: u8 = 5;
const WB_RESEARCHER: u8 = 6;
// Search kinds and work bits (worker.js WSR_*, WSW_*).
const WSR_RESEARCH: u8 = 5;
const WSW_RESEARCH: i32 = 8;
// The per-owner research words (rs, RS_W a player).
const RS_W: usize = 12;
const ATLAS_FID: i32 = 1 << 30;
// The energy log's sources (sums per owner, ES_W a player).
const ES_W: usize = 8;
const ES_RESEARCH: usize = 0;
const ES_SALVAGE: usize = 1;
const ES_COLLECT: usize = 2;
const ES_HEALER: usize = 3;
const ES_BUILDER: usize = 4;
const WSW_BUILD: i32 = 1;
const WS_MOVING_TO_BUILD: u32 = 7;
const WS_BUILDING_IN_PLACE: u32 = 8;
// (adj.ctab, ord.rs ADJ_COLS a class: things_utils.js _ADJ_CTAB_COLS.)
const AJ_W: usize = 27;
const WSR_HEAL: u8 = 4;
const WSW_QUEUE: i32 = 4;
// The grid picks' work tests.
const PICK_BUILD: u8 = 1;
const PICK_SALVAGE: u8 = 2;
const PICK_RESEARCH: u8 = 3;
const PICK_QUEUE: u8 = 4;
const WS_MOVING_TO_HEAL: u32 = 9;
const WS_HEALING: u32 = 10;
const WSR_COLLECT: u8 = 1;
const WT_DROP: u32 = 4;
const WS_MOVING_TO_ASTAR: u32 = 3;
// Search kinds and work bits for the grid searches.
const WSR_GRID: u8 = 3;
const WSW_SALVAGE: i32 = 2;
const WS_MOVING_TO: u32 = 2;
// The class columns (wai.ctab, WAI_CTAB_COLS a class): markedForSalvage, stacks.
const CT_W: usize = 8;
const CT_MARKED: usize = 0;
const CT_STACKS: usize = 1;
const CT_LEVEL: usize = 2;
const CT_QON: usize = 3;
const CT_QN: usize = 4;
const CT_QREQ: usize = 5;
const CT_QPAID: usize = 6;
const CT_UC: usize = 7;

struct W {
    list: *mut i32, out: *mut i32, cnt: *mut i32,
    id: *mut i32, own: *mut i8, x: *mut i32, y: *mut i32, dead: *mut u8,
    wks: *mut u32, wkt: *mut i32, wkr: *mut i32, wkn: *mut i32, idlefv: *mut i32, cmd: *mut u8, pidx: *mut i32, nvpk: *mut i32,
    on: *mut u8, mcd: *mut i32, mpath: *mut i32, mfree: *mut i32, mout: *mut u8, wskind: *mut u8, wkidle: *mut u8, sepk: *mut u32,
    spep: *mut i32, cool: *mut u16, tgx: *mut f32, tgy: *mut f32, navld: *mut f32, srow: *mut i16, elev: *mut i8, wkix: *mut i32,
    wbt: *mut u8, wake: *mut i32, mflags: *mut u8, mreach: *mut u8, mflow: *mut i32, mfgen: *mut i32, mdest: *mut i32, mready: *mut i32,
    mnp: *mut u8, msteady: *mut i32, mwk: *mut u8, mspent: *mut u8, mshoot: *mut u8,
    wkty: *mut i32, wkd: *mut i32, wkox: *mut i32, wkoy: *mut i32, wktw: *mut u8, wkfail: *mut i32, wkuntil: *mut i32, wksched: *mut i32,
    wst: *mut i32, wscfg: *mut i8, wsou: *mut i32, wsox: *mut f32, wsoy: *mut f32, wsr: *mut f32, wsax: *mut f32, wsay: *mut f32,
    wsak: *mut i8, wsneed: *mut i32, wsjid: *mut i32, wscur: *mut i32, wsmy: *mut i32, wsfail: *mut u8,
    wmsp: *mut i32, wmfailu: *mut f64, holdf: *mut u8, mvpp: *mut u8, hot: *mut f32,
    ctab: *mut u8, rrow: *mut i32, stown: *mut i32, stuc: *mut u8, stval: *mut f64,
    rmark: *mut u8, rauto: *mut u8, rlevel: *mut i8, rstacks: *mut i32,
    wall0: *mut u8, resv: *mut i32, rcount: *mut i32, rsum: *mut i32, wswl: *mut i32, ver: *mut i32, ttab: *mut i32,
    rs: *mut f64, teff: *mut f64, tdps: *mut f64, tspx: *mut f64, tsak: *mut f64, payt: *mut i32, payl: *mut f64, es: *mut f64,
    wall1: *mut u8, layer: *mut u8, tmon: *mut u8,
    // The take (mode 1): the tier's found requests (ws.rslot, rid, rkind, rwt, rgrp), its results
    // (ws.res, ws.score, ws.ures), the collectors' groups' tile and kind arrays (gtab: two words a
    // group, encoded), the healers' damaged units' ids by owner (hid, HM an owner).
    trs: *mut i32, trid: *mut i32, trk: *mut i32, trwt: *mut i32, trg: *mut i32, tres: *mut i32, tsc: *mut f32, tur: *mut i32, gtab: *mut i32, hid: *mut i32,
    cwall: *mut i32, ctabw: *mut i32, price: *mut f64, ulevel: *mut i8, uidt: *mut i32, stbrain: *mut i32, wbtick: *mut i32, wbsp: *mut i32, wmcarry: *mut f64, wsst: *mut f32,
    wmpin: *mut i32, wmpinty: *mut u8, wmwx: *mut f64, wmwy: *mut f64, wmwgx: *mut f64, wmwgy: *mut f64, wmwty: *mut u8, wmdrop: *mut i32,
    wmmine: *mut i32, wmminety: *mut u8, wmidle: *mut f64, tfarm: *mut f64, stcode: *mut u8,
    wmqc: *mut i32, wmqr: *mut f64, wmqp: *mut f64, wmtrip: *mut f64, wmblk: *mut f64, energy: *mut f32, maxe: *mut f32, x0: *mut i32, y0: *mut i32,
    stab: *mut u8, ajtab: *mut i32, wstab: *mut i32, tykey: *mut i32, rml: *mut i32, smxe: *mut f64, rlv: *mut i32, wkwx: *mut f32, wkwy: *mut f32, wklmt: *mut i32, wmre: *mut f64,
    // Params.
    n: usize, now: i32, dk: i32, gw: i32, gh: i32, tile: f64, delay: i32, retarget: i32, search_ticks: i32, backoff: i32,
    nt: i32, srt: i32, rcols: i32, vtypes: i32, vrw: i32, vrh: i32, vnp: i32, wrt: i32, epoch: i32, absent: u32,
    atlas: i32, local: i32, rcls: u8, l1: i32, maxl: i32, outcap: usize, nres: i32, nver: i32, nwsw: i32, np: i32,
    scale: f64, research_tt: u32, fallback_rdps: f64, base_cd: i32, umask: u32, salv_type: i32, salv_cd: i32, nprice: i32,
    // Per resource (0 energy, 1 A*): the target type codes of its mines and farms, its farms' and dropoff
    // buildings' stationary types, its mines' structure code, its collectors' base cooldown, its config index.
    tt_mine: [u32; 2], tt_farm: [u32; 2], tt_drop: u32, farm_type: [i32; 2], drop_type: [i32; 2], mine_code: [u8; 2], coll_cd: [i32; 2],
    cfg_ix: [i32; 2], five_s: i32, area_search: bool,
    heal_type: i32, heal_base_dps: f64, heal_cd: i32, blocked_ticks: i32, pass_on: bool, tt_queue: u32, tt_unit: u32,
    ntypes: i32, nkeys: i32, snp: i32, sl1: usize, sr1: usize, build_type: i32, build_base_dps: f64, build_cd: i32, recheck: i32, stuck: i32,
    mode: i32, tk: usize, hm: i32, ws_ticks: i32, bld_li: i32,
}

impl W {
    unsafe fn new(k: &K) -> W {
        W {
            list: k.p(0), out: k.p(1), cnt: k.p(2), id: k.p(3), own: k.p(4), x: k.p(5), y: k.p(6), dead: k.p(7),
            wks: k.p(8), wkt: k.p(9), wkr: k.p(10), wkn: k.p(11), idlefv: k.p(12), cmd: k.p(13), pidx: k.p(14), nvpk: k.p(15),
            on: k.p(16), mcd: k.p(17), mpath: k.p(18), mfree: k.p(19), mout: k.p(20), wskind: k.p(21), wkidle: k.p(22), sepk: k.p(23),
            spep: k.p(24), cool: k.p(25), tgx: k.p(26), tgy: k.p(27), navld: k.p(28), srow: k.p(29), elev: k.p(30), wkix: k.p(31),
            wbt: k.p(32), wake: k.p(33), mflags: k.p(34), mreach: k.p(35), mflow: k.p(36), mfgen: k.p(37), mdest: k.p(38), mready: k.p(39),
            mnp: k.p(40), msteady: k.p(41), mwk: k.p(42), mspent: k.p(43), mshoot: k.p(44),
            wkty: k.p(45), wkd: k.p(46), wkox: k.p(47), wkoy: k.p(48), wktw: k.p(49), wkfail: k.p(50), wkuntil: k.p(51), wksched: k.p(52),
            wst: k.p(53), wscfg: k.p(54), wsou: k.p(55), wsox: k.p(56), wsoy: k.p(57), wsr: k.p(58), wsax: k.p(59), wsay: k.p(60),
            wsak: k.p(61), wsneed: k.p(62), wsjid: k.p(63), wscur: k.p(64), wsmy: k.p(65), wsfail: k.p(66),
            wmsp: k.p(67), wmfailu: k.p(68), holdf: k.p(69), mvpp: k.p(70), hot: k.p(71),
            ctab: k.p(72), rrow: k.p(73), stown: k.p(74), stuc: k.p(75), stval: k.p(76),
            rmark: k.p(77), rauto: k.p(78), rlevel: k.p(79), rstacks: k.p(80),
            wall0: k.p(81), resv: k.p(82), rcount: k.p(83), rsum: k.p(84), wswl: k.p(85), ver: k.p(86), ttab: k.p(87),
            rs: k.p(88), teff: k.p(89), tdps: k.p(90), tspx: k.p(91), tsak: k.p(92), payt: k.p(93), payl: k.p(94), es: k.p(95),
            wall1: k.p(96), layer: k.p(97), tmon: k.p(98),
            trs: k.p(142), trid: k.p(143), trk: k.p(144), trwt: k.p(145), trg: k.p(146), tres: k.p(147), tsc: k.p(148), tur: k.p(149), gtab: k.p(150), hid: k.p(151),
            cwall: k.p(99), ctabw: k.p(100), price: k.p(101), ulevel: k.p(102), uidt: k.p(103), stbrain: k.p(104), wbtick: k.p(105), wbsp: k.p(106), wmcarry: k.p(107),
            wmpin: k.p(108), wmpinty: k.p(109), wmwx: k.p(110), wmwy: k.p(111), wmwgx: k.p(112), wmwgy: k.p(113), wmwty: k.p(114), wmdrop: k.p(115),
            wmmine: k.p(116), wmminety: k.p(117), wmidle: k.p(118), tfarm: k.p(119), stcode: k.p(120),
            wmqc: k.p(121), wmqr: k.p(122), wmqp: k.p(123), wmtrip: k.p(124), wmblk: k.p(125), energy: k.p(126), maxe: k.p(127), x0: k.p(128), y0: k.p(129),
            stab: k.p(130), ajtab: k.p(131), wstab: k.p(132), tykey: k.p(133), rml: k.p(134), smxe: k.p(135), rlv: k.p(136), wkwx: k.p(137), wkwy: k.p(138), wklmt: k.p(139), wmre: k.p(140), wsst: k.p(141),
            n: k.i(0).max(0) as usize, now: k.i(1), dk: k.i(2).max(1), gw: k.i(3).max(1), gh: k.i(4).max(1), tile: k.f(5),
            delay: k.i(6).max(1), retarget: k.i(7), search_ticks: k.i(8), backoff: k.i(9), nt: k.i(10).max(1), srt: k.i(11).max(1),
            rcols: k.i(12), vtypes: k.i(13), vrw: k.i(14), vrh: k.i(15), vnp: k.i(16), wrt: k.i(17).max(1), epoch: k.i(18),
            absent: k.f(19) as u32, atlas: k.i(20), local: k.i(21), rcls: k.i(22) as u8, l1: k.i(23).max(2), maxl: k.i(24).max(1),
            outcap: k.i(25).max(0) as usize, nres: k.i(26), nver: k.i(27), nwsw: k.i(28), np: k.i(29), scale: k.f(30),
            research_tt: k.i(31) as u32, fallback_rdps: k.f(32), base_cd: k.i(33),
            umask: (k.i(34).max(1) as u32) - 1, salv_type: k.i(35), salv_cd: k.i(36), nprice: k.i(37),
            tt_mine: [k.i(38) as u32, k.i(39) as u32], tt_farm: [k.i(40) as u32, k.i(41) as u32], tt_drop: k.i(42) as u32,
            farm_type: [k.i(43), k.i(44)], drop_type: [k.i(45), k.i(46)], mine_code: [k.i(47) as u8, k.i(48) as u8], coll_cd: [k.i(49), k.i(50)],
            cfg_ix: [k.i(51), k.i(52)], five_s: k.i(53), area_search: k.i(54) != 0,
            heal_type: k.i(55), heal_base_dps: k.f(56), heal_cd: k.i(57), blocked_ticks: k.i(58), pass_on: k.i(59) != 0, tt_queue: k.i(60) as u32, tt_unit: k.i(61) as u32,
            ntypes: k.i(62), nkeys: k.i(63), snp: k.i(64), sl1: k.i(65).max(1) as usize, sr1: k.i(66).max(1) as usize, build_type: k.i(67), build_base_dps: k.f(68), build_cd: k.i(69),
            recheck: k.i(70), stuck: k.i(71),
            mode: k.i(72), tk: k.i(73).max(1) as usize, hm: k.i(74), ws_ticks: k.i(75), bld_li: k.i(76),
        }
    }
}

/// SIM_KERNEL-less, serial (unit.js unitEventsRun, worker.js waiRun):
/// arrays and params as W::new lists them (worker.js _waiArgs).
#[no_mangle]
pub unsafe extern "C" fn k_worker_ai(a: u32, _chunk: i32) {
    let k = K::new(waddr(a) as *const i32);
    let w = W::new(&k);
    let mut c = Ctx { w: &w, no: 0, vsum: 0, full: 0, take: -1 };
    if w.mode == 1 {
        // The tier's takes (worker.js _wsCommit): every found request, in its order.
        for j in 0..w.n {
            let i = g(w.list, j);
            if i < 0 { continue; }
            c.take_one(i as usize);
        }
    } else if w.mode == 2 {
        // Structures' progress (things_utils.js structProgressOps): (tile, op, value) triples.
        for j in 0..w.n {
            let (t, op, v) = (g(w.list, j * 3), g(w.list, j * 3 + 1), g(w.list, j * 3 + 2));
            c.p_op(t, op, v);
        }
    } else {
        for i in 0..w.n {
            let e = g(w.list, i);
            if e < 0 { continue; }
            c.event((e >> 3) as usize, e & 7);
        }
    }
    s(w.cnt, 0, c.no as i32);
    s(w.cnt, 2, c.vsum);
    s(w.cnt, 3, c.full);
}

struct Ctx<'a> {
    w: &'a W,
    no: usize,
    vsum: i32,
    full: i32,
    // (The take being made: its request's index, -1 none.)
    take: i32,
}

impl<'a> Ctx<'a> {
    unsafe fn emit(&mut self, code: i32, a: i32, b: i32, v: i32) {
        let w = self.w;
        if self.no >= w.outcap { s(w.cnt, 1, 1); return; }
        let at = self.no * 4;
        s(w.out, at, code); s(w.out, at + 1, a); s(w.out, at + 2, b); s(w.out, at + 3, v);
        self.no += 1;
    }
    #[inline(always)]
    unsafe fn rec(&self, q: usize) -> usize { g(self.w.wkix, q).max(0) as usize }
    #[inline(always)]
    unsafe fn wb(&self, q: usize) -> u8 { g(self.w.wbt, self.rec(q)) }
    #[inline(always)]
    unsafe fn st(&self, q: usize) -> u32 { g(self.w.wks, q) & 31 }
    #[inline(always)]
    unsafe fn crosses(&self, phase: i32, period: i32) -> bool {
        if period <= 1 { return true; }
        let r = irem(self.w.now.wrapping_add(phase), period);
        (if r < 0 { r + period } else { r }) < self.w.dk
    }
    #[inline(always)]
    unsafe fn utile(&self, q: usize) -> (i32, i32) {
        let it = 1.0 / (self.w.tile * 8.0);
        (floor(g(self.w.x, q) as f64 * it) as i32, floor(g(self.w.y, q) as f64 * it) as i32)
    }
    // ---- The unit's fields as their setters keep them (unit.js) ----
    unsafe fn set_state(&self, q: usize, code: u32) {
        let w = self.w;
        let v = g(w.wks, q);
        if (v & 31) != code {
            s(w.on, q, 0);
            if code != WS_IDLE { s(w.wskind, q, 0); }
            s(w.wkidle, q, if code == WS_IDLE { 1 } else { 0 });
            s(w.wks, q, (v & !31) | code);
        }
    }
    unsafe fn set_cmd(&self, q: usize, v: u8) {
        if g(self.w.cmd, q) != v { s(self.w.on, q, 0); s(self.w.cmd, q, v); }
    }
    unsafe fn set_pidx(&self, q: usize, v: i32) {
        if g(self.w.pidx, q) != v { s(self.w.on, q, 0); }
        s(self.w.pidx, q, v);
    }
    /// u.path = (a node of key, or none: -1): its window back, disarmed.
    unsafe fn set_path(&self, q: usize, key: i32) {
        let w = self.w;
        s(w.nvpk, q, key);
        let h = g(w.mpath, q);
        if h >= 0 { let m = g(w.mfree, 0); s(w.mfree, (m + 1) as usize, h); s(w.mfree, 0, m + 1); s(w.mpath, q, -1); }
        s(w.on, q, 0);
        s(w.mcd, q, -1);
    }
    #[inline(always)]
    unsafe fn path_done(&self, q: usize) -> bool { !(g(self.w.nvpk, q) >= 0 && g(self.w.pidx, q) < 1) }
    /// The path's node's tile (its destination), -1 none.
    #[inline(always)]
    unsafe fn path_dest(&self, q: usize) -> i32 {
        let k = g(self.w.nvpk, q);
        if k < 0 { return -1; }
        irem(k >> 1, 16777216)
    }
    unsafe fn sync_cmd(&self, q: usize) {
        let st = self.st(q);
        if ws_moving(st) { self.set_cmd(q, CMD_MOVING); } else if ws_standing(st) { self.set_cmd(q, CMD_IDLE); }
    }
    /// _clearWorkerAutoRoute (no pending way: the pass's units have none).
    unsafe fn clear_auto_route(&self, q: usize) {
        self.set_path(q, -1);
        self.set_pidx(q, 0);
        self.set_cmd(q, CMD_IDLE);
    }
    // ---- Navigation (flownav.js) ----
    /// navProfileOf: the air's for a flier, the ground's (the class
    /// profiles' workers are not the pass's yet).
    #[inline(always)]
    unsafe fn profile(&self, q: usize) -> i32 {
        if g(self.w.layer, q) == 1 { return 1; }
        match self.wb(q) {
            1 | 2 => 2,
            3 | 4 => { let o = g(self.w.own, q) as i32; if (0..8).contains(&o) { 3 + o } else { 0 } }
            _ => 0,
        }
    }
    /// navApproachTile on the profile's walls.
    unsafe fn approach(&self, p: i32, t: i32) -> i32 {
        let w = self.w;
        let (gw, gh) = (w.gw, w.gh);
        // (Each profile's walls, flownav.js navWallTable: cwall, encoded.)
        let wall = if p == 0 { w.wall0 } else if p == 1 { w.wall1 } else { waddr(g(w.cwall, p as usize) as u32) as *const u8 };
        if wall.is_null() { return t; }
        if !(t >= 0 && t < gw * gh) { return -1; }
        if g(wall, t as usize) == 0 { return t; }
        let (tx, ty) = (irem(t, gw), idiv(t, gw));
        let mut r = -1;
        let mut d: i32 = 1;
        while d <= 6 && r < 0 {
            let mut best = i32::MAX;
            for dy in -d..=d {
                for dx in -d..=d {
                    if dx.abs().max(dy.abs()) != d { continue; }
                    let (x, y) = (tx + dx, ty + dy);
                    if x < 0 || y < 0 || x >= gw || y >= gh || g(wall, (y * gw + x) as usize) != 0 { continue; }
                    let dd = dx.abs() + dy.abs();
                    if dd < best { best = dd; r = y * gw + x; }
                }
            }
            d += 1;
        }
        r
    }
    /// navPathTo: its node's key (unit.nvPK), -1 none.
    unsafe fn path_to(&self, q: usize, t: i32) -> i32 {
        let p = self.profile(q);
        let a = self.approach(p, t);
        if a < 0 { -1 } else { (p * 16777216 + a) * 2 }
    }
    /// _isWorkerWithinTileInteractionRange (a tile target, reach 1).
    unsafe fn within(&self, q: usize, t: i32) -> bool {
        let (ux, uy) = self.utile(q);
        let (tx, ty) = (irem(t, self.w.gw), idiv(t, self.w.gw));
        if (ux - tx).abs() <= 1 && (uy - ty).abs() <= 1 { return true; }
        self.approach(self.profile(q), t) == uy * self.w.gw + ux
    }
    // ---- Reservations and work versions (worker.js) ----
    unsafe fn resv_set(&mut self, slot: i32, id: i32) {
        let w = self.w;
        if slot < 0 || slot >= w.nres { return; }
        let old = g(w.resv, slot as usize);
        s(w.resv, slot as usize, id);
        if old == id { return; }
        if !w.wswl.is_null() {
            let m = g(w.wswl, 0);
            if m + 1 < w.nwsw { s(w.wswl, (m + 1) as usize, slot); s(w.wswl, 0, m + 1); } else { self.full = 1; }
        }
        if !w.rcount.is_null() {
            let t = idiv(slot, w.nt);
            let rg = idiv(idiv(t, w.gw), w.srt) * w.rcols + idiv(irem(t, w.gw), w.srt);
            if (old == 0) != (id == 0) { s(w.rcount, rg as usize, g(w.rcount, rg as usize) + if id != 0 { 1 } else { -1 }); }
            s(w.rsum, rg as usize, g(w.rsum, rg as usize).wrapping_add(res_term(slot, id)).wrapping_sub(res_term(slot, old)));
        }
    }
    #[inline(always)]
    fn vbase(&self, o: i32, ty: i32) -> i32 { (o * self.w.vtypes + ty) * (1 + self.w.vrw * self.w.vrh) }
    unsafe fn work_changed(&mut self, o: i32, ty: i32, gx: i32, gy: i32) {
        let w = self.w;
        if !(o >= 0 && o < w.vnp) { return; }
        let mut i = self.vbase(o, ty);
        if gx >= 0 && gy >= 0 { i += 1 + (w.vrh - 1).min(idiv(gy, w.wrt)) * w.vrw + (w.vrw - 1).min(idiv(gx, w.wrt)); }
        if i < 0 || i >= w.nver { return; }
        s(w.ver, i as usize, g(w.ver, i as usize).wrapping_add(1));
        self.vsum = self.vsum.wrapping_add(work_mix(i));
    }
    /// _workerWorkHash (not a healer's, from one origin tile).
    unsafe fn work_hash(&self, o: i32, ty: i32, d: i32, ogx: i32, ogy: i32, twice: bool, pgx: i32, pgy: i32) -> i32 {
        let w = self.w;
        if !(o >= 0 && o < w.vnp) { return 0; }
        let get = |i: i32| -> i32 { if i >= 0 && i < w.nver { g(w.ver, i as usize) } else { 0 } };
        let (all, mine) = (self.vbase(o, 0), self.vbase(o, ty));
        let mut h = get(all).wrapping_mul(31).wrapping_add(get(mine));
        let r = w.wrt as f64;
        for pass in 0..(if twice { 2 } else { 1 }) {
        let (gx, gy) = if pass != 0 { (pgx, pgy) } else { (ogx, ogy) };
        let ry0 = (floor((gy - d) as f64 / r) as i32).max(0);
        let ry1 = (floor((gy + d) as f64 / r) as i32).min(w.vrh - 1);
        let rx0 = (floor((gx - d) as f64 / r) as i32).max(0);
        let rx1 = (floor((gx + d) as f64 / r) as i32).min(w.vrw - 1);
        let mut ry = ry0;
        while ry <= ry1 {
            let mut rx = rx0;
            while rx <= rx1 {
                let i = 1 + ry * w.vrw + rx;
                h = h.wrapping_mul(31).wrapping_add(get(all + i).wrapping_mul(7)).wrapping_add(get(mine + i));
                rx += 1;
            }
            ry += 1;
        }
        }
        h
    }
    // ---- Stats (things_utils.js _effRowWrite's worker slots, the tables) ----
    #[inline(always)]
    unsafe fn hot(&self, q: usize, k: usize) -> f64 {
        let r = g(self.w.srow, q);
        // (Its own tables, no row: their words in its record, wsSt, worker.js _waiOwnStats.)
        if r < 0 { return if k >= 11 && k <= 15 && !self.w.wsst.is_null() { g(self.w.wsst, self.rec(q) * 8 + k - 11) as f64 } else { 0.0 }; }
        g(self.w.hot, r as usize * 16 + k) as f64
    }
    #[inline(always)]
    unsafe fn level(&self, q: usize) -> i32 { (g(self.w.elev, q) as i32).max(1).min(self.w.maxl) }
    /// (Search range in pixels and area steps: per owner, record type, level.)
    unsafe fn search(&self, q: usize) -> (f64, i32) {
        let w = self.w;
        let o = g(w.own, q) as i32;
        if !(o >= 0 && o < w.np) { return (w.tile * 10.0, 2); }
        let i = ((o * 8 + self.wb(q) as i32) * w.l1 + self.level(q)) as usize;
        (g(w.tspx, i), g(w.tsak, i) as i32)
    }
    // ---- The worker's target (wkS bits 5-12, wkT; its reservation wkR) ----
    #[inline(always)]
    unsafe fn tkind(&self, q: usize) -> u32 { (g(self.w.wks, q) >> 10) & 7 }
    /// The target's tile when it is a structure there now (-1: none).
    unsafe fn target_tile(&self, q: usize) -> i32 {
        let kd = self.tkind(q);
        if kd != WT_TILE && kd != WT_ITEM { return -1; }
        let t = g(self.w.wkt, q);
        if t < 0 || t >= self.w.gw * self.w.gh || g(self.w.ctab, t as usize) == 0 { return -1; }
        t
    }
    /// _clearWorkerTarget(u, reason): `allowed` the reasons a returning
    /// worker lets go for (target_missing, target_no_work...).
    unsafe fn clear_target(&mut self, q: usize, allowed: bool) {
        let w = self.w;
        let wb = self.wb(q);
        let kd = self.tkind(q);
        let tl = self.target_tile(q);
        let has = tl >= 0;
        if wb == 0 && !has { return; }
        let o = g(w.own, q) as i32;
        if has && wb != 0 && tl >= 0 {
            let ty = (g(w.ttab, wb as usize) >> 8) & 255;
            self.work_changed(o, ty, irem(tl, w.gw), idiv(tl, w.gw));
        }
        let st = self.st(q);
        if (st == WS_RETURNING || st == WS_RETURNING_ASTAR || st == WS_RETURNING_FOR_GOLD) && !allowed { return; }
        // (Its target null, or gone, and its type null: nothing to let go.)
        let ttc = (g(w.wks, q) >> 5) & 31;
        if (kd == WT_NULL || (kd >= WT_ITEM && !has)) && ttc == 1 { return; }
        if has {
            let slot = g(w.wkr, q);
            if slot >= 0 && slot < w.nres && g(w.resv, slot as usize) == g(w.id, q) { self.resv_set(slot, 0); }
        }
        let v = g(w.wks, q);
        s(w.wks, q, (v & !((31 << 5) | (7 << 10))) | (1 << 5) | (WT_NULL << 10));
        s(w.wkt, q, 0);
        s(w.wkr, q, -1);
    }
    // ---- Idle searches (worker.js) ----
    unsafe fn fail_until(&self, q: usize) -> f64 { g(self.w.wmfailu, self.rec(q)) }
    unsafe fn backoff(&self, q: usize, tick: i32) -> bool {
        let v = g(self.w.idlefv, q);
        let u = self.fail_until(q);
        v != -1 && u == u && (tick as f64) < u
    }
    unsafe fn work_ver(&self, q: usize) -> i32 {
        let w = self.w;
        let wb = self.wb(q);
        let ty = (g(w.ttab, wb as usize) >> 8) & 255;
        let (px, _) = self.search(q);
        let d = ceil(px / w.tile) as i32 + 1;
        let (gx, gy) = self.utile(q);
        let (ox, oy, twice) = self.work_origin(q);
        self.work_hash(g(w.own, q) as i32, ty, d, ox, oy, twice, gx, gy)
    }
    #[inline(always)]
    unsafe fn is_collector(&self, q: usize) -> bool { let b = self.wb(q); b == WB_COLLECTOR || b == WB_ASTAR }
    /// _workerWorkOrigin as tiles: a collector idle less than 5 s, or with
    /// no gather site yet, looks from where it stands; after, from its last
    /// gather site (twice: and its own tile).
    unsafe fn work_origin(&self, q: usize) -> (i32, i32, bool) {
        let w = self.w;
        let (gx, gy) = self.utile(q);
        if self.wb(q) == WB_HEALER || self.wb(q) == WB_BUILDER {
            let r = self.rec(q);
            let (x, y) = (g(w.wmwx, r), g(w.wmwy, r));
            if x == x && y == y { return (floor(x / w.tile) as i32, floor(y / w.tile) as i32, true); }
            return (gx, gy, false);
        }
        if !self.is_collector(q) { return (gx, gy, false); }
        let r = self.rec(q);
        let since = g(w.wmidle, r);
        if self.st(q) == WS_IDLE && ((w.now as f64) - (if since == since && since != 0.0 { since } else { 0.0 })) < w.five_s as f64 { return (gx, gy, false); }
        let (x, y) = (g(w.wmwx, r), g(w.wmwy, r));
        if x == x && y == y { return (floor(x / w.tile) as i32, floor(y / w.tile) as i32, true); }
        (gx, gy, false)
    }
    /// A collector's idle start (_lastIdleStateTime), 0 unset.
    #[inline(always)]
    unsafe fn idle_since(&self, q: usize) -> f64 { let v = g(self.w.wmidle, self.rec(q)); if v == v { v } else { 0.0 } }
    unsafe fn set_next(&self, q: usize, v: i32) {
        if g(self.w.wkn, q) != v { s(self.w.on, q, 0); s(self.w.wkn, q, v); }
    }
    /// shouldRunWorkerIdleRetarget.
    unsafe fn idle_retarget(&mut self, q: usize, heavy: bool) -> bool {
        let w = self.w;
        let now = w.now;
        let next = g(w.wkn, q);
        let r = self.rec(q);
        let fin = next != i32::MIN && next != i32::MIN + 1;
        let ver = self.work_ver(q);
        let mut go = false;
        if !fin {
            go = true;
        } else if g(w.idlefv, q) == ver && (now as f64) < self.fail_until(q) {
            return false;
        } else if heavy && self.crosses(g(w.id, q), w.delay * idiv(w.search_ticks + w.delay - 1, w.delay)) {
            go = true;
        } else if now >= next && !self.backoff(q, now) {
            go = true;
        }
        if go {
            self.set_next(q, now + w.retarget);
            s(w.idlefv, q, ver);
            s(w.wmfailu, r, (now + w.backoff) as f64);
        }
        go
    }
    /// wsRegister for a grid search, then _wsWait.
    unsafe fn ws_register(&self, q: usize, kind: u8, need: i32, r: f64, ak: i32, jitter: bool) {
        self.ws_register_at(q, kind, need, r, ak, jitter, true, -1, 0, f32::NAN, f32::NAN, f32::NAN, f32::NAN);
    }
    unsafe fn ws_register_at(&self, q: usize, kind: u8, need: i32, r: f64, ak: i32, jitter: bool, cur: bool, cfg: i32, ou: i32, ox: f32, oy: f32, ax: f32, ay: f32) {
        let w = self.w;
        let rc = self.rec(q);
        if rc == 0 { return; }
        s(w.wskind, q, kind);
        s(w.wst, rc, if self.take >= 0 { w.now - w.ws_ticks } else { w.now });
        if self.take < 0 { s(w.wsfail, q, 0); }
        s(w.wscfg, rc, cfg as i8);
        s(w.wsou, rc, ou);
        s(w.wsox, rc, ox); s(w.wsoy, rc, oy);
        s(w.wsr, rc, r as f32);
        s(w.wsak, rc, if ak < 0 { -1 } else { ak.min(127) as i8 });
        s(w.wsax, rc, ax); s(w.wsay, rc, ay);
        let li = g(w.ttab, self.wb(q) as usize) & 255;
        let rb = if li < 8 { 1 << li } else { 0 };
        let ci = if need != 0 { 31 - (need & -need).leading_zeros() as i32 } else { 0 };
        s(w.wsneed, rc, if need != 0 { need | (ci << 8) | (rb << 16) } else { rb << 16 });
        s(w.wsjid, rc, if jitter { g(w.id, q) } else { -1 });
        s(w.wscur, rc, if cur { self.target_tile(q) } else { -1 });
        let slot = g(w.wkr, q);
        s(w.wsmy, rc, if slot >= 0 { idiv(slot, w.nt) } else { -1 });
        self.set_state(q, WS_IDLE);
        self.set_cmd(q, CMD_IDLE);
    }
    // ---- Payments (data_dynamic.js addPlayerResource in a batch) ----
    unsafe fn pay(&mut self, o: i32, lane: usize, amount: f64) {
        let w = self.w;
        if !(o >= 0 && o < w.np) { return; }
        let d = js_round(amount * w.scale);
        if d == 0.0 || d != d { return; }
        let pb = o as usize * 4;
        let (addr, cap, n) = (g(w.payt, pb) as u32, g(w.payt, pb + 1), g(w.payt, pb + 2));
        if addr == 0 || n >= cap { s(w.cnt, 1, 1); return; }
        let dl = waddr(addr) as *mut f64;
        s(dl, n as usize * 2, if lane == 0 { d } else { 0.0 });
        s(dl, n as usize * 2 + 1, if lane == 1 { d } else { 0.0 });
        s(w.payt, pb + 2, n + 1);
        s(w.payl, o as usize * 2 + lane, g(w.payl, o as usize * 2 + lane) + d);
    }
    unsafe fn energy_log(&self, o: i32, src: usize, d: f64) {
        let w = self.w;
        if o >= 0 && o < w.np { let i = o as usize * ES_W + src; s(w.es, i, g(w.es, i) + d); }
    }
    // ---- The movement kernel's arming (unit.js _unitArmAgain) ----
    unsafe fn arm_again(&mut self, q: usize) {
        let w = self.w;
        let st = self.st(q);
        if st == 0 { return; }
        let cmd = g(w.cmd, q);
        let cd = g(w.cool, q) as i32;
        if st != WS_MANUAL && cd > 0 { self.park_work(q); if g(w.on, q) != 0 { return; } }
        if cmd == CMD_MOVING { if g(w.holdf, q) == 0 { self.try_arm(q); } } else if cmd == CMD_IDLE && cd > 0 { self.park_work(q); } else if cmd == CMD_IDLE && st == WS_IDLE { self.park_idle(q); }
    }
    #[inline(always)]
    unsafe fn indexed(&self, q: usize) -> bool { g(self.w.spep, q) == self.w.epoch && g(self.w.sepk, q) != self.w.absent }
    unsafe fn park_work(&self, q: usize) {
        let w = self.w;
        let cd = g(w.cool, q) as i32;
        if g(w.holdf, q) != 0 || self.st(q) == WS_MANUAL || !(cd > 0) || !self.path_done(q) || !self.indexed(q) { return; }
        s(w.wake, q, w.now + cd); s(w.mflags, q, 0); s(w.on, q, 2);
    }
    unsafe fn try_arm(&mut self, q: usize) {
        let w = self.w;
        if self.path_done(q) || g(w.spep, q) != w.epoch { return; }
        let key = g(w.nvpk, q);
        let prof = idiv(key >> 1, 16777216);
        let dest = irem(key >> 1, 16777216);
        let (ux, uy) = self.utile(q);
        if uy * w.gw + ux == dest { return; }
        // (Off the atlas the destination's field is JavaScript's: simMoveTryArm.)
        // (Its own stats, not a row: its speed is the JavaScript's.)
        if (w.atlas >> prof) & 1 == 0 || g(w.srow, q) < 0 { self.emit(OUT_ARM, q as i32, 0, 0); return; }
        if !(self.hot(q, 0) >= 0.0) || g(w.sepk, q) == w.absent { return; }
        let st = self.st(q);
        let kind = if st == WS_MANUAL { 2 } else if st == WS_RETURNING_FOR_GOLD || (st == WS_RETURNING && self.wb(q) == WB_SALVAGER) { 3 } else { 1 };
        s(w.mflags, q, 64 | if prof == 1 { 32 } else { 0 } | 128); s(w.mreach, q, 0); s(w.mflow, q, ATLAS_FID); s(w.mfgen, q, 0); s(w.mdest, q, dest); s(w.mready, q, 0);
        s(w.mnp, q, prof as u8); s(w.msteady, q, 0); s(w.mwk, q, kind); s(w.mspent, q, 0); s(w.on, q, 1);
    }
    /// simMoveTryPark for an idle worker (not a builder or collector).
    unsafe fn park_idle(&self, q: usize) {
        let w = self.w;
        if g(w.holdf, q) != 0 || g(w.cool, q) > 0 || !self.indexed(q) { return; }
        let now = w.now;
        if g(w.wskind, q) != 0 {
            let mut wake = now + 0x3fffffff;
            let bld = self.wb(q) == WB_BUILDER;
            if bld { let re = g(w.wmre, self.rec(q)); if self.target_tile(q) >= 0 && re == re && (re as i32) < wake { wake = re as i32; } }
            if !(wake > now + 1) { return; }
            s(w.wake, q, wake); s(w.mflags, q, if bld && self.watching(q) { 4 } else { 0 }); s(w.on, q, 2);
            return;
        }
        let next = g(w.wkn, q);
        if next == i32::MIN || next == i32::MIN + 1 { return; }
        // (A collector with no idle start yet sets it on its next update: not parked.)
        let coll = self.is_collector(q);
        if coll && self.idle_since(q) == 0.0 { return; }
        let id = g(w.id, q);
        let per = idiv(w.search_ticks + w.delay - 1, w.delay);
        let fv = g(w.idlefv, q);
        let fu = self.fail_until(q);
        let back = self.backoff(q, now + 1);
        let mut sched = if back { (next as f64).max(fu) } else { next as f64 };
        let bld = self.wb(q) == WB_BUILDER;
        if bld { let re = g(w.wmre, self.rec(q)); if self.target_tile(q) >= 0 && re == re && re < sched { sched = re; } }
        // (_workerWorkOriginUntil: a collector's origin moves 5 s into its idle.)
        if coll && self.st(q) == WS_IDLE {
            let since = self.idle_since(q);
            if (now as f64) - since < w.five_s as f64 && since + (w.five_s as f64) < sched { sched = since + w.five_s as f64; }
        }
        let mut wake = sched;
        let mut t = now + 1;
        while (t as f64) < wake {
            let tw = t.wrapping_add(id);
            if irem(tw, w.delay) == 0 && irem(idiv(tw, w.delay), per.max(1)) == 0 { wake = t as f64; break; }
            t += 1;
        }
        if !(wake > (now + 1) as f64) { return; }
        s(w.wake, q, to_i32(wake));
        s(w.mflags, q, if bld && self.watching(q) { 4 } else { 0 });
        if back {
            let r = self.rec(q);
            let wb = self.wb(q);
            let (px, _) = self.search(q);
            let (ox, oy, twice) = self.work_origin(q);
            s(w.wkty, r, (g(w.ttab, wb as usize) >> 8) & 255);
            s(w.wkd, r, ceil(px / w.tile) as i32 + 1);
            s(w.wkox, r, ox); s(w.wkoy, r, oy); s(w.wktw, r, if twice { 1 } else { 0 });
            s(w.wkfail, r, fv); s(w.wkuntil, r, tick_bound(fu)); s(w.wksched, r, tick_bound(sched));
            s(w.mflags, q, g(w.mflags, q) | 2);
        }
        s(w.on, q, 2);
    }
    // ---- The event (unit.js _unitWorkerEvent) ----
    unsafe fn event(&mut self, q: usize, code: i32) {
        let w = self.w;
        if g(w.dead, q) != 0 { return; }
        // (What the pass does not take yet: back to the JavaScript.)
        let wb = self.wb(q);
        if wb == 0 || self.st(q) == WS_MANUAL || g(w.mvpp, q) != 0 || g(w.mshoot, q) != 0 {
            self.emit(OUT_DECLINED, q as i32, code, 0);
            return;
        }
        let moved = g(w.mout, q) != 0;
        self.ai(q);
        self.sync_cmd(q);
        let left = if g(w.nvpk, q) >= 0 { 1 - g(w.pidx, q) } else { 0 };
        if !moved && g(w.cmd, q) == CMD_MOVING { self.way_end(q, code); }
        if left > 0 && g(w.dead, q) == 0 && self.path_done(q) { self.ai(q); self.sync_cmd(q); }
        if g(w.dead, q) == 0 && g(w.on, q) == 0 { self.arm_again(q); }
    }
    /// _unitWorkerWayEnd (no pending way, not held).
    unsafe fn way_end(&self, q: usize, code: i32) {
        let w = self.w;
        // (Held: it keeps its way and its progress.)
        if g(w.holdf, q) != 0 { return; }
        if !self.path_done(q) {
            let dest = self.path_dest(q);
            let (ux, uy) = self.utile(q);
            let (dx, dy) = (irem(dest, w.gw), idiv(dest, w.gw));
            if ux == dx && uy == dy { self.set_pidx(q, g(w.pidx, q) + 1); s(w.navld, q, -1.0); }
            else if code == EV_NOWAY {
                if (dx - ux).abs() > 1 || (dy - uy).abs() > 1 { return; }
                self.set_pidx(q, 1);
            } else { return; }
            if !self.path_done(q) { return; }
        }
        self.set_cmd(q, CMD_IDLE);
        self.set_path(q, -1);
        s(w.tgx, q, f32::NAN); s(w.tgy, q, f32::NAN);
    }
    /// updateWorkerAI.
    unsafe fn ai(&mut self, q: usize) {
        let w = self.w;
        let st = self.st(q);
        if st == 0 { return; }
        let id = g(w.id, q);
        // (isWorkerBetweenMoveChecks: on its way, looked at every 128 ticks.)
        if ws_moving(st) && !self.path_done(q) && g(w.holdf, q) == 0 && !self.crosses(id, 128) { return; }
        if g(w.cool, q) > 0 && st != WS_MANUAL { return; }
        self.finish_approach(q);
        let heavy = self.crosses(id, w.delay);
        match self.wb(q) {
            WB_RESEARCHER => self.researcher(q, heavy),
            WB_SALVAGER => self.salvager(q, heavy),
            WB_COLLECTOR | WB_ASTAR => self.collector(q, heavy),
            WB_HEALER => self.healer(q, heavy),
            WB_BUILDER => self.builder(q, heavy),
            _ => {}
        }
    }
    /// _workerFinishApproachInRange.
    unsafe fn finish_approach(&self, q: usize) {
        let w = self.w;
        let st = self.st(q);
        if g(w.holdf, q) != 0 || st == WS_MANUAL || !ws_moving(st) || self.path_done(q) { return; }
        let returning = st == WS_RETURNING || st == WS_RETURNING_ASTAR || st == WS_RETURNING_FOR_GOLD;
        let t = if returning {
            let sp = g(w.wmsp, self.rec(q));
            if sp != 0 { sp >> 3 } else { self.path_dest(q) }
        } else { self.target_tile(q) };
        if t < 0 { return; }
        let (ux, uy) = self.utile(q);
        if (ux - irem(t, w.gw)).abs() > 1 || (uy - idiv(t, w.gw)).abs() > 1 { return; }
        self.clear_auto_route(q);
    }
    // ---- Structures by tile (the class tables' columns) ----
    #[inline(always)]
    unsafe fn ccol<T>(&self, t: usize, j: usize) -> *mut T {
        let c = g(self.w.ctab, t) as usize;
        if c == 0 { return core::ptr::null_mut(); }
        waddr(g(self.w.ctabw, c * CT_W + j) as u32) as *mut T
    }
    /// Whether unit id lives (the id table: main.js UnitIdIndex).
    unsafe fn alive(&self, id: i32) -> bool {
        let w = self.w;
        if id <= 0 || w.uidt.is_null() { return false; }
        let mut h = (id as u32).wrapping_mul(2654435761u32) & w.umask;
        loop {
            let sl = g(w.uidt, h as usize);
            if sl == -1 { return false; }
            if g(w.id, sl as usize) == id { return g(w.dead, sl as usize) == 0; }
            h = (h + 1) & w.umask;
        }
    }
    /// _workerOwnsReservedTarget: tile t's slot for its type holds q (a
    /// holder no longer alive let go, as _getReservedWorkerForTarget).
    unsafe fn owns_reserved(&mut self, q: usize, t: i32) -> bool {
        let w = self.w;
        let li = g(w.ttab, self.wb(q) as usize) & 255;
        let slot = t * w.nt + li;
        if t < 0 || slot >= w.nres { return false; }
        let id = g(w.resv, slot as usize);
        if id <= 0 { return false; }
        if !self.alive(id) { self.resv_set(slot, 0); return false; }
        id == g(w.id, q)
    }
    /// _findClosestSpawner from the worker brain (worker_brain.rs: this
    /// tick's nearest of its type for each event), -1 none.
    unsafe fn brain_spawner(&self, q: usize, stype: i32) -> i32 {
        let w = self.w;
        let r = self.rec(q);
        if r == 0 || g(w.wbtick, r) != w.now { return -1; }
        let t = g(w.wbsp, r);
        if t < 0 { return -1; }
        let tu = t as usize;
        if (g(w.stbrain, tu) & 65535) != stype || g(w.stown, tu) != g(w.own, q) as i32 || !(g(w.stval, tu) > 0.0) || g(w.stuc, tu) != 0 { return -1; }
        t
    }
    /// getUnitBaseLevel (its unitLevel column).
    unsafe fn base_level(&self, q: usize) -> i32 { (g(self.w.ulevel, q) as i32).min(self.w.maxl).max(1) }
    // ---- Targets and their reservations (worker.js _setWorkerTarget) ----
    /// The slot of unit id (the id table), -1 none.
    unsafe fn slot_of(&self, id: i32) -> i32 {
        let w = self.w;
        if id <= 0 || w.uidt.is_null() { return -1; }
        let mut h = (id as u32).wrapping_mul(2654435761u32) & w.umask;
        loop {
            let sl = g(w.uidt, h as usize);
            if sl == -1 { return -1; }
            if g(w.id, sl as usize) == id { return sl; }
            h = (h + 1) & w.umask;
        }
    }
    #[inline(always)]
    unsafe fn ttype(&self, q: usize) -> u32 { (g(self.w.wks, q) >> 5) & 31 }
    /// Whether q's target is the structure at tile t of type code tt.
    #[inline(always)]
    unsafe fn targets(&self, q: usize, t: i32, tt: u32) -> bool { self.target_tile(q) == t && self.ttype(q) == tt }
    /// _canAssignWorkerTargetExclusive (a structure at tile t, type tt).
    unsafe fn can_assign(&mut self, q: usize, t: i32, tt: u32) -> bool {
        let w = self.w;
        if self.targets(q, t, tt) { return true; }
        let li = g(w.ttab, self.wb(q) as usize) & 255;
        let slot = t * w.nt + li;
        if t < 0 || slot >= w.nres { return false; }
        let id = g(w.resv, slot as usize);
        if id <= 0 { return true; }
        let sl = self.slot_of(id);
        if sl < 0 || g(w.dead, sl as usize) != 0 { self.resv_set(slot, 0); return true; }
        let r = sl as usize;
        if r == q { return true; }
        g(w.own, r) != g(w.own, q) || self.wb(r) != self.wb(q)
    }
    /// _setWorkerTarget(q, the structure at tile t of kind kd, type tt): a
    /// lower id of the same owner and type holding it keeps it.
    unsafe fn set_target(&mut self, q: usize, t: i32, kd: u32, tt: u32) -> bool {
        let w = self.w;
        if self.targets(q, t, tt) { return true; }
        let my = g(w.id, q);
        let li = g(w.ttab, self.wb(q) as usize) & 255;
        let next = if t >= 0 && li >= 0 { t * w.nt + li } else { -1 };
        if next >= 0 && next < w.nres {
            let rid = g(w.resv, next as usize);
            let sl = self.slot_of(rid);
            if rid > 0 && sl >= 0 && sl as usize != q && g(w.dead, sl as usize) == 0 && g(w.own, sl as usize) == g(w.own, q) && self.wb(sl as usize) == self.wb(q) {
                let r = sl as usize;
                if rid <= my { return false; }
                let rs = g(w.wkr, r);
                if rs >= 0 && rs < w.nres && g(w.resv, rs as usize) == rid { self.resv_set(rs, 0); }
                if self.target_tile(r) == t {
                    let v = g(w.wks, r);
                    s(w.wks, r, (v & !((31 << 5) | (7 << 10))) | (1 << 5) | (WT_NULL << 10));
                    s(w.wkt, r, 0);
                    let rst = self.st(r);
                    if rst == WS_MOVING_TO || rst == WS_MOVING_TO_ASTAR || rst == WS_IDLE {
                        self.set_state(r, WS_IDLE);
                        self.set_cmd(r, CMD_IDLE);
                        self.clear_auto_route(r);
                        if g(w.mvpp, r) != 0 { self.emit(OUT_CLEAR_ROUTE, r as i32, 0, 0); }
                    }
                }
                s(w.wkr, r, -1);
            }
        }
        if self.target_tile(q) >= 0 {
            let ps = g(w.wkr, q);
            if ps >= 0 && ps < w.nres && g(w.resv, ps as usize) == my { self.resv_set(ps, 0); }
        }
        let v = g(w.wks, q);
        s(w.wks, q, (v & !((31 << 5) | (7 << 10))) | (tt << 5) | (kd << 10));
        s(w.wkt, q, t);
        if t >= 0 { s(w.wskind, q, 0); }
        s(w.wkr, q, -1);
        if t >= 0 && next >= 0 && next < w.nres { self.resv_set(next, my); s(w.wkr, q, next); }
        true
    }
    // ---- Collectors (both resources: res 0 energy, 1 A*) ----
    #[inline(always)]
    unsafe fn res(&self, q: usize) -> usize { if self.wb(q) == WB_ASTAR { 1 } else { 0 } }
    /// _isResourceCollectorTargetValid (a mine with something left, a working farm of its owner; drops never).
    unsafe fn coll_valid(&self, q: usize, t: i32, tt: u32) -> bool {
        let w = self.w;
        if t < 0 { return false; }
        let (tu, rz) = (t as usize, self.res(q));
        if tt == w.tt_mine[rz] { return g(w.stcode, tu) == w.mine_code[rz] && g(w.stval, tu) > 0.0; }
        if tt == w.tt_farm[rz] {
            return g(w.ctab, tu) != 0 && (g(w.stbrain, tu) & 65535) == w.farm_type[rz] && g(w.stown, tu) == g(w.own, q) as i32 && g(w.stuc, tu) == 0 && g(w.stval, tu) > 0.0;
        }
        false
    }
    /// _isResourceCollectorSpawnerValidForUnit (a target word, tile * 8 + kind; 0 none).
    unsafe fn coll_spawner_ok(&self, q: usize, word: i32) -> i32 {
        let w = self.w;
        if word == 0 { return -1; }
        let t = word >> 3;
        if t < 0 || t >= w.gw * w.gh { return -1; }
        let tu = t as usize;
        if g(w.ctab, tu) == 0 || (g(w.stbrain, tu) & 65535) != w.drop_type[self.res(q)] || g(w.stown, tu) != g(w.own, q) as i32 || !(g(w.stval, tu) > 0.0) || g(w.stuc, tu) != 0 { return -1; }
        t
    }
    /// _rememberResourceCollectorGatherSite.
    unsafe fn remember_site(&self, q: usize, t: i32, tt: u32) {
        let w = self.w;
        let r = self.rec(q);
        let (gx, gy) = (irem(t, w.gw), idiv(t, w.gw));
        s(w.wmwx, r, gx as f64 * w.tile + w.tile * 0.5); s(w.wmwy, r, gy as f64 * w.tile + w.tile * 0.5);
        s(w.wmwgx, r, gx as f64); s(w.wmwgy, r, gy as f64);
        if tt > 1 { s(w.wmwty, r, tt as u8); }
    }
    /// _resourceCollectorAssignTarget.
    unsafe fn coll_assign(&mut self, q: usize, t: i32, tt: u32) {
        if !self.set_target(q, t, WT_TILE, tt) { self.set_state(q, WS_IDLE); self.set_cmd(q, CMD_IDLE); return; }
        let key = self.path_to(q, t);
        self.set_path(q, key);
        if key >= 0 {
            self.remember_site(q, t, tt);
            self.set_state(q, WS_MOVING_TO);
            self.set_pidx(q, 0);
            self.set_cmd(q, CMD_MOVING);
        } else {
            self.clear_auto_route(q);
            self.clear_target(q, false);
            self.set_state(q, WS_IDLE);
            self.set_cmd(q, CMD_IDLE);
        }
    }
    /// _resourceCollectorFindTarget (its pin, else the search tier's request).
    unsafe fn coll_find(&mut self, q: usize) {
        let w = self.w;
        let r = self.rec(q);
        let (pin, pty) = (g(w.wmpin, r), g(w.wmpinty, r) as u32);
        let pt = if pin != 0 && ((pin & 7) as u32 == WT_TILE || (pin & 7) as u32 == WT_ITEM) { pin >> 3 } else { -1 };
        if pt >= 0 && self.coll_valid(q, pt, pty) && self.can_assign(q, pt, pty) { self.coll_assign(q, pt, pty); return; }
        s(w.wmpin, r, 0); s(w.wmpinty, r, 1);
        if self.take >= 0 {
            let (t, tt) = self.coll_pick(q);
            if t >= 0 { self.coll_assign(q, t, tt); } else { self.set_state(q, WS_IDLE); self.set_cmd(q, CMD_IDLE); }
            return;
        }
        let rz = self.res(q);
        let anchor = { let a = self.coll_spawner_ok(q, g(w.wmsp, r)); if a >= 0 { a } else { self.coll_spawner_ok(q, g(w.wmdrop, r)) } };
        if self.idle_since(q) == 0.0 { s(w.wmidle, r, w.now as f64); }
        let (px, ak) = self.search(q);
        let (gx, gy) = (g(w.wmwx, r), g(w.wmwy, r));
        let site = gx == gx && gy == gy;
        let (ax, ay) = if anchor >= 0 { ((irem(anchor, w.gw) as f64 * w.tile + w.tile * 0.5) as f32, (idiv(anchor, w.gw) as f64 * w.tile + w.tile * 0.5) as f32) } else { (f32::NAN, f32::NAN) };
        self.ws_register_at(q, WSR_COLLECT, 0, px, if w.area_search { ak } else { -1 }, false, false, w.cfg_ix[rz],
            (self.idle_since(q) as i32).wrapping_add(w.five_s), if site { gx as f32 } else { f32::NAN }, if site { gy as f32 } else { f32::NAN }, ax, ay);
    }
    /// _workerReturnPath for a collector: to its preferred or nearest dropoff with its load.
    unsafe fn coll_return(&mut self, q: usize) {
        let w = self.w;
        let r = self.rec(q);
        if !(g(w.wmcarry, r) > 0.0) { self.clear_auto_route(q); return; }
        let sp = self.brain_spawner(q, w.drop_type[self.res(q)]);
        let key = if sp >= 0 { self.path_to(q, sp) } else { -1 };
        if key >= 0 {
            s(w.wmsp, r, sp * 8 + WT_TILE as i32);
            self.set_path(q, key);
            self.set_pidx(q, 0);
            self.set_cmd(q, CMD_MOVING);
        } else {
            self.set_path(q, -1);
            self.set_pidx(q, 0);
            self.set_cmd(q, CMD_IDLE);
        }
    }
    /// _updateResourceCollectorAI.
    unsafe fn collector(&mut self, q: usize, heavy: bool) {
        let w = self.w;
        let st = self.st(q);
        let o = g(w.own, q) as i32;
        let r = self.rec(q);
        let rz = self.res(q);
        if st == WS_IDLE {
            if self.idle_since(q) == 0.0 { s(w.wmidle, r, w.now as f64); }
            if g(w.wskind, q) != 0 { return; }
            if !self.idle_retarget(q, heavy) { return; }
            self.coll_find(q);
            return;
        }
        if st == WS_MOVING_TO || st == WS_MOVING_TO_ASTAR {
            s(w.wmidle, r, 0.0);
            let t = self.target_tile(q);
            let tt = self.ttype(q);
            if t < 0 || !self.owns_reserved(q, t) {
                self.clear_target(q, true);
                self.clear_auto_route(q);
                self.coll_find(q);
                return;
            }
            if !self.coll_valid(q, t, tt) { self.clear_target(q, true); self.coll_find(q); return; }
            if !self.path_done(q) { return; }
            if self.within(q, t) {
                if g(w.cool, q) > 0 { return; }
                let mut gather = self.hot(q, 14);
                if !(gather > 0.0) { gather = 1.0; }
                let tu = t as usize;
                if tt == w.tt_farm[rz] {
                    // (The farm's level: its level, else its stacks'; its multiplier by owner and level.)
                    let lv = { let p = self.ccol::<i8>(tu, CT_LEVEL); if p.is_null() { -128 } else { g(p, g(w.rrow, tu).max(0) as usize) as i32 } };
                    let bl = if lv != -128 { lv.min(w.maxl).max(1) } else {
                        let p = self.ccol::<i32>(tu, CT_STACKS);
                        let sk = if p.is_null() { i32::MIN } else { g(p, g(w.rrow, tu).max(0) as usize) };
                        if sk != i32::MIN { stack_level(sk, w.maxl) } else { 1 }
                    };
                    let mult = if o >= 0 && o < w.np { g(w.tfarm, ((o as usize * 2 + rz) * w.l1 as usize) + bl as usize) } else { bl as f64 };
                    s(w.wmcarry, r, floor(js_max(1.0, gather * mult)));
                } else {
                    let left = g(w.stval, tu);
                    let ex = floor(js_min(gather, js_max(0.0, left)));
                    s(w.wmcarry, r, ex);
                    self.emit(OUT_MINE, t, rz as i32, ex as i32);
                }
                if o == w.local { self.emit(OUT_SOUND_UNIT, q as i32, 0, if rz == 1 { SND_ASTAR_WORK } else { SND_COLLECTOR_WORK }); }
                self.set_cooldown(q, w.coll_cd[rz]);
                self.remember_site(q, t, tt);
                let mine = tt == w.tt_mine[rz];
                s(w.wmmine, r, if mine { t * 8 + WT_TILE as i32 } else { 0 });
                s(w.wmminety, r, if mine { tt as u8 } else { 1 });
                self.set_state(q, WS_RETURNING);
                self.coll_return(q);
            } else {
                let key = self.path_to(q, t);
                self.set_path(q, key);
                if key >= 0 { self.set_pidx(q, 0); self.set_cmd(q, CMD_MOVING); } else { self.coll_find(q); }
            }
            return;
        }
        if st == WS_RETURNING || st == WS_RETURNING_ASTAR {
            if !self.path_done(q) { return; }
            let pref = { let a = self.coll_spawner_ok(q, g(w.wmsp, r)); if a >= 0 { a } else { self.coll_spawner_ok(q, g(w.wmdrop, r)) } };
            let drop = if pref >= 0 { pref } else { self.brain_spawner(q, w.drop_type[rz]) };
            let at = drop >= 0 && self.within(q, drop);
            if at { s(w.wmdrop, r, drop * 8 + WT_TILE as i32); s(w.wmsp, r, drop * 8 + WT_TILE as i32); }
            let carry = g(w.wmcarry, r);
            if carry > 0.0 && !at { self.coll_return(q); return; }
            if carry > 0.0 && at {
                if g(w.cool, q) > 0 { return; }
                self.pay(o, rz, carry);
                if rz == 0 { self.energy_log(o, ES_COLLECT, carry); } else { self.emit(OUT_ASTAR_LOG, q as i32, 0, carry as i32); }
                s(w.cnt, 5 + rz, g(w.cnt, 5 + rz) + 1);
                if o == w.local { self.emit(OUT_SOUND_UNIT, q as i32, 0, if rz == 1 { SND_ASTAR_COLLECTED } else { SND_GOLD_COLLECTED }); }
                self.set_cooldown(q, w.coll_cd[rz]);
            }
            s(w.wmcarry, r, 0.0);
            if !heavy { return; }
            let t = self.target_tile(q);
            let tt = self.ttype(q);
            if self.coll_valid(q, t, tt) && self.owns_reserved(q, t) { self.coll_assign(q, t, tt); return; }
            s(w.wmmine, r, 0); s(w.wmminety, r, 1);
            self.clear_target(q, true);
            self.coll_find(q);
        }
    }
    // ---- Builders: the structures' build state (adj.ctab's columns) ----
    /// Tile t's owned structure's class (stab - 1) and row, when one.
    unsafe fn brow(&self, t: i32) -> Option<(usize, usize)> {
        if t < 0 { return None; }
        let (c, r) = (g(self.w.stab, t as usize) as usize, g(self.w.rrow, t as usize));
        if c >= 1 && c <= 9 && r >= 0 { Some((c - 1, r as usize)) } else { None }
    }
    #[inline(always)]
    unsafe fn ac<T: Copy>(&self, c: usize, r: usize, j: usize) -> Option<T> {
        let p = waddr(g(self.w.ajtab, c * AJ_W + j) as u32) as *mut T;
        if p.is_null() { None } else { Some(g(p, r)) }
    }
    #[inline(always)]
    unsafe fn ac_set<T>(&self, c: usize, r: usize, j: usize, v: T) {
        let p = waddr(g(self.w.ajtab, c * AJ_W + j) as u32) as *mut T;
        if !p.is_null() { s(p, r, v); }
    }
    /// A flag column (Uint8: 0 unset, 1 false, 2 true).
    #[inline(always)]
    unsafe fn af(&self, c: usize, r: usize, j: usize) -> u8 { self.ac::<u8>(c, r, j).unwrap_or(0) }
    #[inline(always)]
    unsafe fn wf(&self, c: usize, r: usize, j: usize) -> u8 {
        let p = waddr(g(self.w.wstab, c * 7 + j) as u32) as *mut u8;
        if p.is_null() { 0 } else { g(p, r) }
    }
    /// getThingStackedStacks, getThingManualStacks.
    unsafe fn b_stacks(&self, c: usize, r: usize) -> (i32, i32) {
        let st0 = self.ac::<i32>(c, r, 2).unwrap_or(i32::MIN);
        let man0 = self.ac::<i32>(c, r, 3).unwrap_or(i32::MIN);
        let stacked = if st0 == i32::MIN || st0 < 1 { 1 } else { st0 };
        (stacked, stacked.max(if man0 == i32::MIN { stacked } else { man0 }.max(1)))
    }
    /// getThingBaseLevel, getThingEffectiveLevel.
    unsafe fn b_levels(&self, c: usize, r: usize) -> (i32, i32) {
        let w = self.w;
        let lv = self.ac::<i8>(c, r, 5).unwrap_or(-128);
        let elv = self.ac::<i8>(c, r, 6).unwrap_or(-128);
        let st0 = self.ac::<i32>(c, r, 2).unwrap_or(i32::MIN);
        let base = if lv != -128 { (lv as i32).min(w.maxl).max(1) } else if st0 != i32::MIN { stack_level(st0, w.maxl) } else { 1 };
        (base, if elv != -128 { (elv as i32).min(w.maxl).max(1) } else { base })
    }
    /// The stat tables' word for tile t's structure: its key's offset and its researched max level.
    unsafe fn b_key(&self, t: i32, o: i32) -> Option<(usize, i32)> {
        let w = self.w;
        let ty = (g(w.stbrain, t as usize) & 65535) - 1;
        let oi = if o < 0 || o + 1 >= w.snp { 0 } else { o + 1 };
        let kb = if ty >= 0 && ty < w.ntypes { g(w.tykey, ty as usize) } else { -1 };
        if !(kb >= 0 && kb < w.nkeys) { return None; }
        Some(((oi * w.nkeys + kb) as usize, kb))
    }
    /// getThingResearchedMaxLevel.
    unsafe fn b_rmax(&self, t: i32, o: i32) -> i32 { match self.b_key(t, o) { Some((otx, _)) => g(self.w.rml, otx), None => self.w.maxl } }
    /// getUpgrademaxEnergy(item, level): its key's maximum energy at a level (NaN: none).
    unsafe fn b_mxe(&self, t: i32, o: i32, lvl: i32) -> f64 {
        let w = self.w;
        match self.b_key(t, o) {
            Some((otx, kb)) => g(w.smxe, ((kb as usize * w.sl1) + lvl.max(1).min(w.maxl) as usize) * w.sr1 + g(w.rlv, 4 * otx) as usize),
            None => f64::NAN,
        }
    }
    /// The maxEnergy getter (its override, an upgrade's target, its tables').
    unsafe fn b_maxe(&self, t: i32, c: usize, r: usize, o: i32) -> f64 {
        let mxo = self.ac::<f64>(c, r, 21).unwrap_or(f64::NAN);
        if mxo == mxo { return mxo; }
        let um = self.ac::<f64>(c, r, 20).unwrap_or(f64::NAN);
        if self.af(c, r, 11) == 2 && um > 0.0 { return floor(um).max(1.0); }
        let ovmx = self.ac::<f64>(c, r, 22).unwrap_or(f64::NAN);
        if ovmx == ovmx { return floor(ovmx).max(1.0); }
        let (base, _) = self.b_levels(c, r);
        let m = self.b_mxe(t, o, base);
        if m == m { floor(m).max(1.0) } else { 1.0 }
    }
    #[inline(always)]
    unsafe fn b_energy(&self, t: i32) -> f64 { g(self.w.stval, t as usize) }
    unsafe fn b_energy_set(&self, t: i32, c: usize, r: usize, v: f64) { s(self.w.stval, t as usize, v); self.ac_set::<f64>(c, r, 16, v); }
    /// Whether its watchdog samples (unit.js simMoveTryPark, mvFlags 4).
    #[inline(always)]
    unsafe fn watching(&self, q: usize) -> bool { let r = self.rec(q); let (x, y) = (g(self.w.wkwx, r), g(self.w.wkwy, r)); x == x && y == y }
    /// _isBuilderRepairTarget.
    unsafe fn b_repair(&self, t: i32, c: usize, r: usize, o: i32) -> bool {
        let (e, m) = (self.b_energy(t), self.b_maxe(t, c, r, o));
        e.is_finite() && m.is_finite() && m > 0.0 && e > 0.0 && e < m && g(self.w.stuc, t as usize) == 0 && self.af(c, r, 11) != 2 && self.af(c, r, 8) != 2
    }
    /// _isBuilderStackCandidate.
    unsafe fn b_stack_cand(&self, t: i32, c: usize, r: usize, o: i32) -> bool {
        if g(self.w.stuc, t as usize) != 0 || self.af(c, r, 11) == 2 || self.af(c, r, 8) == 2 || self.af(c, r, 14) == 1 { return false; }
        let (stacked, manual) = self.b_stacks(c, r);
        manual - stacked > 0 && stack_level(stacked + 1, self.w.maxl) <= self.b_rmax(t, o)
    }
    /// _isBuilderUpgradeCandidate.
    unsafe fn b_upgrade_cand(&self, t: i32, c: usize, r: usize, o: i32) -> bool {
        if g(self.w.stuc, t as usize) != 0 || self.af(c, r, 11) == 2 || self.af(c, r, 8) == 2 || self.af(c, r, 10) == 1 { return false; }
        let (base, eff) = self.b_levels(c, r);
        eff > base && eff.min(self.b_rmax(t, o)) > base
    }
    /// _isBuilderWorkTarget (a candidate's start: its flags now, the
    /// JavaScript's start after the pass).
    unsafe fn b_valid(&mut self, t: i32, o: i32) -> bool {
        let w = self.w;
        let (c, r) = match self.brow(t) { Some(v) => v, None => return false };
        if g(w.stown, t as usize) != o || self.wf(c, r, 0) == 2 { return false; }
        let uc = g(w.stuc, t as usize) != 0;
        if !uc && self.af(c, r, 11) != 2 && self.af(c, r, 8) != 2 && !self.b_repair(t, c, r, o) {
            if self.b_stack_cand(t, c, r, o) {
                self.ac_set::<u8>(c, r, 8, 2);
                self.p_refresh(t, c, r, o);
                self.p_tok(t, c, r);
            } else if self.b_upgrade_cand(t, c, r, o) {
                let (base, _) = self.b_levels(c, r);
                self.p_begin(t, c, r, o, base + 1);
            }
        }
        if !uc && self.af(c, r, 11) != 2 && self.af(c, r, 8) != 2 && !self.b_repair(t, c, r, o) { return false; }
        if uc && self.wf(c, r, 1) == 1 { return false; }
        true
    }
    /// _builderRememberWorkSite.
    unsafe fn b_remember(&self, q: usize, t: i32) {
        let w = self.w;
        if t < 0 { return; }
        let rc = self.rec(q);
        let (gx, gy) = (irem(t, w.gw), idiv(t, w.gw));
        s(w.wmwx, rc, gx as f64 * w.tile + w.tile * 0.5); s(w.wmwy, rc, gy as f64 * w.tile + w.tile * 0.5);
        s(w.wmwgx, rc, gx as f64); s(w.wmwgy, rc, gy as f64);
    }
    #[inline(always)]
    unsafe fn b_material(&self, q: usize) -> bool { (g(self.w.wks, q) >> 13) & 3 == 2 }
    #[inline(always)]
    unsafe fn b_material_set(&self, q: usize, v: bool) { let x = g(self.w.wks, q); s(self.w.wks, q, (x & !(3 << 13)) | (if v { 2 } else { 1 } << 13)); }
    #[inline(always)]
    unsafe fn b_dps(&self, q: usize) -> f64 { let d = self.hot(q, 11); if d != 0.0 && d == d { d } else { self.w.build_base_dps } }
    /// getBuilderTripGoldCost.
    #[inline(always)]
    unsafe fn b_trip(&self, q: usize) -> f64 { let d = self.hot(q, 11); js_max(1.0, js_round(if d > 0.0 { d } else { 5.0 })) }
    /// The route to its nearest builder spawner (RETURNING_FOR_GOLD), true when one.
    unsafe fn b_route(&mut self, q: usize) -> bool {
        let w = self.w;
        let sp = self.brain_spawner(q, w.build_type);
        let key = if sp >= 0 { self.path_to(q, sp) } else { -1 };
        if key < 0 { return false; }
        self.set_state(q, WS_RETURNING_FOR_GOLD);
        self.set_path(q, key); self.set_pidx(q, 0); self.set_cmd(q, CMD_MOVING);
        s(w.wmsp, self.rec(q), sp * 8 + WT_TILE as i32);
        s(w.tgx, q, (irem(sp, w.gw) as f64 * w.tile + 16.0) as f32); s(w.tgy, q, (idiv(sp, w.gw) as f64 * w.tile + 16.0) as f32);
        true
    }
    /// _builderFindTarget without the tier's answer: its target, its last
    /// work site and around it, else the tier's request.
    unsafe fn b_find(&mut self, q: usize) {
        let w = self.w;
        let o = g(w.own, q) as i32;
        let rc = self.rec(q);
        let mut t = -1;
        let cur = self.target_tile(q);
        if cur >= 0 && self.b_valid(cur, o) && self.can_assign(q, cur, 1) { t = cur; }
        let (gxf, gyf) = (g(w.wmwgx, rc), g(w.wmwgy, rc));
        if t < 0 && gxf == gxf && gyf == gyf {
            let c = (gyf as i32) * w.gw + gxf as i32;
            if gxf >= 0.0 && gyf >= 0.0 && (gxf as i32) < w.gw && (gyf as i32) < w.gh && self.b_valid(c, o) && self.can_assign(q, c, 1) { t = c; }
        }
        let (wx, wy) = (g(w.wmwx, rc), g(w.wmwy, rc));
        if t < 0 && wx == wx && wy == wy {
            // (_getBuilderWorkTargetNear: the 3x3 tiles around, nearest within 1.5 tiles, the last of equals.)
            let (cx, cy) = (floor(wx / w.tile) as i32, floor(wy / w.tile) as i32);
            let radius = js_max(22.0, w.tile * 1.5);
            let mut best = radius;
            let mut bt = -1;
            for fy in (cy - 1).max(0)..=(cy + 1).min(w.gh - 1) {
                for fx in (cx - 1).max(0)..=(cx + 1).min(w.gw - 1) {
                    let c = fy * w.gw + fx;
                    if !self.b_valid(c, o) { continue; }
                    let (dx, dy) = (fx as f64 * w.tile + w.tile * 0.5 - wx, fy as f64 * w.tile + w.tile * 0.5 - wy);
                    let d = sqrt(dx * dx + dy * dy);
                    if d <= best { best = d; bt = c; }
                }
            }
            if bt >= 0 && self.can_assign(q, bt, 1) { t = bt; }
        }
        if t < 0 && self.take >= 0 {
            t = self.grid_pick(q, PICK_BUILD, 1);
            if t < 0 { self.set_state(q, WS_IDLE); self.set_cmd(q, CMD_IDLE); return; }
        }
        if t < 0 {
            let (px, ak) = self.search(q);
            self.ws_register_at(q, WSR_GRID, WSW_BUILD, px, ak, true, true, -1, 0, if wx == wx { wx as f32 } else { f32::NAN }, if wy == wy { wy as f32 } else { f32::NAN }, f32::NAN, f32::NAN);
            return;
        }
        self.b_assign(q, t);
    }
    /// _builderAssignTarget.
    unsafe fn b_assign(&mut self, q: usize, t: i32) {
        let w = self.w;
        let marked = match self.brow(t) { Some((c, r)) => self.wf(c, r, 0) == 2, None => true };
        if marked || !self.can_assign(q, t, 1) { self.clear_target(q, false); self.set_state(q, WS_IDLE); self.set_cmd(q, CMD_IDLE); return; }
        if !self.set_target(q, t, WT_TILE, 1) { self.set_state(q, WS_IDLE); self.set_cmd(q, CMD_IDLE); return; }
        self.b_remember(q, t);
        if self.b_material(q) || !self.b_route(q) {
            self.set_state(q, WS_MOVING_TO_BUILD);
            let key = self.path_to(q, t);
            self.set_path(q, key); self.set_pidx(q, 0); self.set_cmd(q, CMD_MOVING);
        }
        let _ = w;
    }
    /// Its work (dps) into structure t: construction, an upgrade, stacking, a
    /// repair. Returns (did work, still work there).
    unsafe fn b_work(&mut self, q: usize, t: i32, dps: f64) -> (bool, bool) {
        let w = self.w;
        let o = g(w.own, q) as i32;
        let (c, r) = match self.brow(t) { Some(v) => v, None => return (false, false) };
        let round3 = |v: f64| js_round(v * 1000.0) / 1000.0;
        if g(w.stuc, t as usize) != 0 {
            // _getBuilderProgressRequiredEnergy for a site.
            let up = self.b_mxe(t, o, 1);
            let vis = self.b_maxe(t, c, r, o);
            let ue = if vis > 0.0 { if up == up && up > 0.0 { js_min(up, vis) } else { vis } } else { up };
            let req = js_max(1.0, floor(if ue == ue && ue > 0.0 { ue } else { 1.0 }));
            if req != vis { self.p_maxe_set(t, c, r, o, req); }
            let e = round3(js_min(req, self.b_energy(t) + dps));
            self.b_energy_set(t, c, r, e);
            if e >= req {
                // (Built: markConstructionComplete and the rest after the pass; no longer a site now.)
                s(w.stuc, t as usize, 0);
                self.p_complete(t, c, r, o);
                self.emit(OUT_BUILT, t, 0, 0);
                self.b_remember(q, t);
                return (true, false);
            }
            return (true, true);
        }
        if self.af(c, r, 11) == 2 {
            let (base, _) = self.b_levels(c, r);
            let m = self.b_mxe(t, o, base + 1);
            let um = self.ac::<f64>(c, r, 20).unwrap_or(f64::NAN);
            let req = js_max(1.0, floor(if m == m && m != 0.0 { m } else if um == um && um != 0.0 { um } else { self.b_maxe(t, c, r, o) }));
            self.ac_set::<f64>(c, r, 20, req);
            let e = round3(js_min(req, self.b_energy(t) + dps));
            self.b_energy_set(t, c, r, e);
            if e >= req {
                // (Upgraded: its level, stacks and the rest after the pass.)
                self.ac_set::<u8>(c, r, 11, 1);
                self.p_upgraded(t, c, r, o, base + 1);
                self.emit(OUT_BUILT, t, 1, base + 1);
                return (true, false);
            }
            return (true, true);
        }
        if self.af(c, r, 8) == 2 {
            let m = self.b_mxe(t, o, 1);
            let cost = js_max(1.0, floor(if m == m && m > 0.0 { m } else { self.b_maxe(t, c, r, o) }));
            let mut done = js_max(0.0, { let v = self.ac::<f64>(c, r, 9).unwrap_or(0.0); if v == v { v } else { 0.0 } }) + dps;
            let (mut stacked, manual) = self.b_stacks(c, r);
            let rmax = self.b_rmax(t, o);
            let mut any = 0;
            while done >= cost && manual - stacked > 0 {
                if stack_level(stacked + 1, w.maxl) > rmax { break; }
                done -= cost;
                stacked += 1;
                any = 1;
            }
            self.ac_set::<f64>(c, r, 9, done);
            if any != 0 { self.ac_set::<i32>(c, r, 2, stacked); }
            let more = manual - stacked > 0 && stack_level(stacked + 1, w.maxl) <= rmax;
            if !more { self.ac_set::<u8>(c, r, 8, 1); self.ac_set::<f64>(c, r, 9, 0.0); }
            self.p_refresh(t, c, r, o);
            self.p_tok(t, c, r);
            self.emit(OUT_BUILT, t, 2, any);
            return (true, more);
        }
        if self.b_repair(t, c, r, o) {
            let m = self.b_maxe(t, c, r, o);
            let e = round3(js_min(m, self.b_energy(t) + dps));
            self.b_energy_set(t, c, r, e);
            return (true, self.b_repair(t, c, r, o));
        }
        (false, true)
    }
    // ---- Structures' progress (things_utils.js): the state the JavaScript's
    // setters and refreshThingProgressState kept, on the class columns ----
    /// One op (mode 2, structProgressOps): 0 construction done, 1 upgraded to
    /// level v, 2 stacked (the state again), 3 maxEnergy to v, 4 the progress
    /// state again, 5 an upgrade to level v begun.
    unsafe fn p_op(&mut self, t: i32, op: i32, v: i32) {
        let (c, r) = match self.brow(t) { Some(x) => x, None => return };
        let o = g(self.w.stown, t as usize);
        match op {
            0 => self.p_complete(t, c, r, o),
            1 => self.p_upgraded(t, c, r, o, v),
            2 | 4 => { self.p_refresh(t, c, r, o); self.p_tok(t, c, r); }
            3 => self.p_maxe_set(t, c, r, o, v as f64),
            5 => self.p_begin(t, c, r, o, v),
            _ => {}
        }
    }
    /// The derived stats' tokens (_sDerivedReconcile) and the descriptor's
    /// levels (stationaryBrainChanged): made again at their next read.
    unsafe fn p_tok(&self, t: i32, c: usize, r: usize) {
        let p = waddr(g(self.w.ajtab, c * AJ_W + 19) as u32) as *mut i32;
        if !p.is_null() { s(p, r * 3, 0); s(p, r * 3 + 1, 0); s(p, r * 3 + 2, 0); }
        let b = g(self.w.stbrain, t as usize);
        if b & 65535 == 0 { return; }
        let (base, eff) = self.b_levels(c, r);
        let keep = (b & 65535) | (b & (1 << 24)) | (b & (1 << 25)) | if eff > 63 { 1 << 25 } else { 0 };
        s(self.w.stbrain, t as usize, keep | (base.min(255) << 16) | (eff.min(63) << 26));
    }
    /// A level column (Int8, -128 unset) at least 1.
    unsafe fn p_lv1(&self, c: usize, r: usize, j: usize) {
        let v = self.ac::<i8>(c, r, j).unwrap_or(-128);
        if v == -128 || v < 1 { self.ac_set::<i8>(c, r, j, 1); }
    }
    /// markConstructionComplete's state (its hooks: the JavaScript's).
    unsafe fn p_complete(&mut self, t: i32, c: usize, r: usize, o: i32) {
        s(self.w.stuc, t as usize, 0);
        let uc = self.ccol::<u8>(t as usize, CT_UC);
        if !uc.is_null() { s(uc, r, 1); }
        self.p_lv1(c, r, 5); self.p_lv1(c, r, 6); self.p_lv1(c, r, 7);
        self.p_refresh(t, c, r, o);
        self.p_tok(t, c, r);
    }
    /// An upgrade done (worker.js _waiBuilt kind 1): level v, the stacks it needs.
    unsafe fn p_upgraded(&mut self, t: i32, c: usize, r: usize, o: i32, v: i32) {
        let (ps, pm) = self.b_stacks(c, r);
        let left = (pm - ps).max(0);
        self.ac_set::<i8>(c, r, 5, v as i8);
        // (getRequiredStacksForLevel: 2^(level - 1).)
        let need = 1i32 << (v.max(1).min(self.w.maxl).max(1) - 1).min(30);
        let st = ps.max(need);
        self.ac_set::<i32>(c, r, 2, st);
        self.ac_set::<i32>(c, r, 3, pm.max(st + left));
        self.ac_set::<u8>(c, r, 11, 1);
        self.ac_set::<f64>(c, r, 20, 0.0);
        self.p_refresh(t, c, r, o);
        self.p_tok(t, c, r);
    }
    /// refreshThingProgressState.
    unsafe fn p_refresh(&mut self, t: i32, c: usize, r: usize, o: i32) {
        let w = self.w;
        let (stacked, manual) = self.b_stacks(c, r);
        self.ac_set::<i32>(c, r, 2, stacked);
        self.ac_set::<i32>(c, r, 3, manual);
        let wd = self.ac::<f64>(c, r, 9).unwrap_or(f64::NAN);
        if !(wd.is_finite() && wd >= 0.0) { self.ac_set::<f64>(c, r, 9, 0.0); }
        let pending = manual - stacked > 0;
        if g(w.stuc, t as usize) != 0 || self.af(c, r, 11) == 2 { self.ac_set::<u8>(c, r, 8, 1); return; }
        let (base, eff) = self.b_levels(c, r);
        let rmax = self.b_rmax(t, o);
        if base < eff.min(rmax) && self.af(c, r, 10) != 1 {
            self.p_begin(t, c, r, o, base + 1);
            self.ac_set::<u8>(c, r, 8, 1);
            return;
        }
        let stacking = pending && self.af(c, r, 14) != 1 && stack_level(stacked + 1, w.maxl) <= rmax;
        self.ac_set::<u8>(c, r, 8, if stacking { 2 } else { 1 });
        if stacking { return; }
        self.ac_set::<f64>(c, r, 9, 0.0);
        if self.af(c, r, 11) == 2 { return; }
        // (Nothing to build: the builders' reservation of it let go.)
        let slot = t * w.nt + w.bld_li;
        if w.bld_li < 0 || slot < 0 || slot >= w.nres { return; }
        let id = g(w.resv, slot as usize);
        if id <= 0 { return; }
        let sl = self.slot_of(id);
        if sl >= 0 { s(w.wkr, sl as usize, -1); }
        self.resv_set(slot, 0);
    }
    /// beginUpgradeProgress.
    unsafe fn p_begin(&mut self, t: i32, c: usize, r: usize, o: i32, lvl: i32) {
        let target = lvl.max(0).min(self.w.maxl).max(1);
        if target > self.b_rmax(t, o) { return; }
        let m = self.b_mxe(t, o, lvl);
        let tm = js_max(1.0, floor(if m == m && m != 0.0 { m } else { self.b_maxe(t, c, r, o) }));
        self.ac_set::<u8>(c, r, 11, 2); self.ac_set::<u8>(c, r, 8, 1); self.ac_set::<f64>(c, r, 20, tm);
        self.p_maxe_set(t, c, r, o, tm);
        let e = self.b_energy(t);
        self.b_energy_set(t, c, r, js_min(if e == e && e >= 1.0 { e } else { 1.0 }, tm));
    }
    /// The maxEnergy setter (_sDerivedSet): an override (_mxOv and its count)
    /// unless v is what its tables say.
    unsafe fn p_maxe_set(&self, t: i32, c: usize, r: usize, o: i32, v: f64) {
        let normal = self.p_maxe_normal(t, c, r, o);
        let old = self.ac::<f64>(c, r, 21).unwrap_or(f64::NAN);
        let cnt = waddr(g(self.w.ajtab, c * AJ_W + 24) as u32) as *mut i32;
        if v != v || v == normal {
            if old == old { self.ac_set::<f64>(c, r, 21, f64::NAN); if !cnt.is_null() { s(cnt, 0, g(cnt, 0) - 1); } }
        } else {
            if old != old && !cnt.is_null() { s(cnt, 0, g(cnt, 0) + 1); }
            self.ac_set::<f64>(c, r, 21, v);
        }
    }
    /// The maxEnergy getter without its override (_sDerivedValue).
    unsafe fn p_maxe_normal(&self, t: i32, c: usize, r: usize, o: i32) -> f64 {
        let um = self.ac::<f64>(c, r, 20).unwrap_or(f64::NAN);
        if self.af(c, r, 11) == 2 && um > 0.0 { return js_max(1.0, floor(um)); }
        let ovmx = self.ac::<f64>(c, r, 22).unwrap_or(f64::NAN);
        if ovmx == ovmx { return js_max(1.0, floor(if ovmx != 0.0 { ovmx } else { 1.0 })); }
        let (base, _) = self.b_levels(c, r);
        let m = self.b_mxe(t, o, base);
        js_max(1.0, floor(if m == m && m != 0.0 { m } else { 1.0 }))
    }
    /// The builder's branch of updateWorkerAI.
    unsafe fn builder(&mut self, q: usize, heavy: bool) {
        let w = self.w;
        let st = self.st(q);
        let o = g(w.own, q) as i32;
        let rc = self.rec(q);
        let now = w.now;
        // (Held: its wait is not being stuck.)
        if g(w.holdf, q) != 0 { s(w.wklmt, rc, now); }
        // The watchdog: its position sampled every 64 ticks, the tick it last moved.
        let (x, y) = (g(w.x, q) as f64 * 0.125, g(w.y, q) as f64 * 0.125);
        let (lx, ly) = (g(w.wkwx, rc), g(w.wkwy, rc));
        if lx != lx || ly != ly {
            s(w.wkwx, rc, x as f32); s(w.wkwy, rc, y as f32); s(w.wklmt, rc, now);
        } else if self.crosses(g(w.id, q), 64) {
            let (dx, dy) = (x - lx as f64, y - ly as f64);
            let moved = sqrt(dx * dx + dy * dy) >= 2.0;
            s(w.wkwx, rc, x as f32); s(w.wkwy, rc, y as f32);
            if moved { s(w.wklmt, rc, now); }
        }
        let nr = g(w.wmre, rc);
        if nr != nr { s(w.wmre, rc, (now + w.recheck) as f64); }
        if g(w.wklmt, rc) == i32::MIN { s(w.wklmt, rc, now); }
        let t0 = self.target_tile(q);
        if st == WS_IDLE && t0 >= 0 && (now as f64) >= g(w.wmre, rc) {
            s(w.wmre, rc, (now + w.recheck) as f64);
            if now - g(w.wklmt, rc) >= w.stuck {
                self.set_path(q, -1); self.set_pidx(q, 0);
                s(w.wmsp, rc, 0);
                self.clear_target(q, false);
                self.b_find(q);
            }
        }
        let st = self.st(q);
        if st == WS_IDLE {
            if g(w.wskind, q) != 0 { return; }
            if !self.idle_retarget(q, heavy) { return; }
            self.b_find(q);
            return;
        }
        let t = self.target_tile(q);
        if st == WS_MOVING_TO_BUILD {
            if !self.b_valid(t, o) { self.b_remember(q, t); self.clear_target(q, false); self.b_find(q); return; }
            if !self.path_done(q) { return; }
            if !self.within(q, t) {
                let key = self.path_to(q, t);
                self.set_path(q, key); self.set_pidx(q, 0); self.set_cmd(q, CMD_MOVING);
                return;
            }
            if !self.b_material(q) {
                if self.b_route(q) { return; }
                if g(w.cool, q) == 0 {
                    let trip = self.b_trip(q);
                    self.pay(o, 0, -trip); self.energy_log(o, ES_BUILDER, -trip);
                    self.b_material_set(q, true);
                    self.set_cooldown(q, w.build_cd);
                }
                self.set_state(q, WS_BUILDING_IN_PLACE);
                return;
            }
            if g(w.cool, q) > 0 { return; }
            let (did, more) = self.b_work(q, t, self.b_dps(q));
            if !more { self.b_remember(q, t); self.clear_target(q, false); self.b_find(q); }
            if did {
                self.b_material_set(q, false);
                self.set_cooldown(q, w.build_cd);
                if g(w.stown, t as usize) == w.local { self.emit(OUT_SOUND_BUILD, t, 0, 0); }
            }
            if self.target_tile(q) >= 0 && !self.b_route(q) { self.set_state(q, WS_BUILDING_IN_PLACE); }
            return;
        }
        if st == WS_RETURNING_FOR_GOLD {
            if !self.path_done(q) { return; }
            if !self.b_valid(t, o) { self.b_remember(q, t); self.clear_target(q, false); self.b_find(q); return; }
            let sp0 = Self::tile_of_word(g(w.wmsp, rc));
            let sp = if sp0 >= 0 && g(w.ctab, sp0 as usize) != 0 { sp0 } else { self.brain_spawner(q, w.build_type) };
            if sp < 0 || self.within(q, sp) {
                if g(w.cool, q) > 0 { return; }
                let trip = self.b_trip(q);
                if sp >= 0 {
                    self.pay(o, 0, -trip); self.energy_log(o, ES_BUILDER, -trip);
                    self.b_material_set(q, true);
                    self.set_cooldown(q, w.build_cd);
                } else { s(w.wmblk, rc, (now + w.blocked_ticks) as f64); }
                s(w.wmsp, rc, 0);
                self.set_state(q, WS_MOVING_TO_BUILD);
                let key = self.path_to(q, t);
                self.set_path(q, key); self.set_pidx(q, 0); self.set_cmd(q, CMD_MOVING);
            } else if !self.b_route(q) {
                s(w.wmsp, rc, 0);
                self.set_state(q, WS_BUILDING_IN_PLACE);
                self.set_cmd(q, CMD_IDLE);
            }
            return;
        }
        if st == WS_BUILDING_IN_PLACE {
            if !self.b_valid(t, o) { self.b_remember(q, t); self.clear_target(q, false); self.b_find(q); return; }
            if !self.b_material(q) && g(w.cool, q) == 0 {
                let trip = self.b_trip(q);
                self.pay(o, 0, -trip); self.energy_log(o, ES_BUILDER, -trip);
                self.b_material_set(q, true);
                self.set_cooldown(q, w.build_cd);
            }
            let mut step = 0.0;
            if self.b_material(q) { step = self.b_dps(q); }
            else if self.crosses(0, 20) { self.pay(o, 0, -1.0); self.energy_log(o, ES_BUILDER, -1.0); step = 1.0; }
            if step > 0.0 {
                let (_, more) = self.b_work(q, t, step);
                if !more { self.b_remember(q, t); self.clear_target(q, false); self.b_find(q); }
                if self.b_material(q) { self.b_material_set(q, false); }
                if g(w.stown, t as usize) == w.local { self.emit(OUT_SOUND_BUILD, t, 0, 0); }
            }
            if self.target_tile(q) >= 0 { self.b_route(q); }
        }
    }
    // ---- Healers ----
    /// The unit target's slot (alive), -1 none.
    unsafe fn target_unit(&self, q: usize) -> i32 {
        if self.tkind(q) != WT_UNIT { return -1; }
        let sl = self.slot_of(g(self.w.wkt, q));
        if sl < 0 || g(self.w.dead, sl as usize) != 0 { -1 } else { sl }
    }
    /// A unit's position this pass (_unitTickX: its start's while the pass runs).
    unsafe fn tick_pos(&self, sl: usize) -> (f64, f64) {
        let w = self.w;
        if w.pass_on { (g(w.x0, sl) as f64 * 0.125, g(w.y0, sl) as f64 * 0.125) } else { (g(w.x, sl) as f64 * 0.125, g(w.y, sl) as f64 * 0.125) }
    }
    /// _isHealerTargetUnit.
    unsafe fn heal_unit_ok(&self, sl: i32, o: i32) -> bool {
        let w = self.w;
        if sl < 0 { return false; }
        let su = sl as usize;
        if g(w.dead, su) != 0 || g(w.own, su) as i32 != o { return false; }
        let (e, m) = (g(w.energy, su), g(w.maxe, su));
        e == e && m == m && e.is_finite() && m.is_finite() && e > 0.0 && e < m
    }
    /// A structure's class column j at tile t (null: its class has none).
    #[inline(always)]
    unsafe fn qcol<T: Copy>(&self, t: i32, j: usize) -> Option<T> {
        if t < 0 { return None; }
        let p = self.ccol::<T>(t as usize, j);
        if p.is_null() { None } else { Some(g(p, g(self.w.rrow, t as usize).max(0) as usize)) }
    }
    /// Its queue's count, required and paid (no queue: none).
    unsafe fn queue_of(&self, t: i32) -> Option<(i32, f64, f64)> {
        let n = self.qcol::<i8>(t, CT_QN)?;
        if n == -128 { return None; }
        Some((n as i32, self.qcol::<f64>(t, CT_QREQ).unwrap_or(0.0), self.qcol::<f64>(t, CT_QPAID).unwrap_or(0.0)))
    }
    #[inline(always)]
    unsafe fn queue_on(&self, t: i32) -> bool { self.qcol::<u8>(t, CT_QON).unwrap_or(0) != 1 }
    /// _isHealerQueueTarget.
    unsafe fn heal_queue_ok(&self, t: i32, o: i32) -> bool {
        let w = self.w;
        if t < 0 { return false; }
        let tu = t as usize;
        if g(w.stown, tu) != o || !(g(w.stval, tu) > 0.0) || g(w.stuc, tu) != 0 || !self.queue_on(t) { return false; }
        match self.queue_of(t) { Some((n, req, paid)) => n > 0 && paid < req, None => false }
    }
    /// _isHealerQueueAnchorTarget.
    unsafe fn heal_anchor_ok(&self, t: i32, o: i32) -> bool {
        t >= 0 && g(self.w.stown, t as usize) == o && g(self.w.stuc, t as usize) == 0 && self.queue_of(t).is_some()
    }
    #[inline(always)]
    unsafe fn heal_dps_round(&self, q: usize) -> f64 { let d = self.hot(q, 12); js_round(if d != 0.0 && d == d { d } else { 1.0 }) }
    /// _getHealerQueueTripCost.
    unsafe fn heal_trip_cost(&self, q: usize, t: i32) -> f64 {
        let (n, req, paid) = match self.queue_of(t) { Some(v) => v, None => return 0.0 };
        if !(n > 0) || !self.queue_on(t) { return 0.0; }
        let rem = js_max(0.0, floor(req - paid));
        if rem <= 0.0 { return 0.0; }
        js_max(0.0, js_min(js_max(1.0, self.heal_dps_round(q)), rem))
    }
    #[inline(always)]
    unsafe fn tile_of_word(word: i32) -> i32 { if word == 0 { -1 } else { word >> 3 } }
    /// _clearHealerQueueCommit.
    unsafe fn heal_commit_clear(&self, q: usize) {
        let r = self.rec(q);
        s(self.w.wmqc, r, 0); s(self.w.wmqr, r, 0.0); s(self.w.wmqp, r, 0.0);
    }
    /// _setHealerQueueCommit.
    unsafe fn heal_commit_set(&self, q: usize, t: i32) {
        let w = self.w;
        let r = self.rec(q);
        match self.queue_of(t) {
            Some((n, req, paid)) if n > 0 => {
                s(w.wmqc, r, t * 8 + WT_TILE as i32);
                s(w.wmqr, r, js_max(1.0, floor(req)));
                s(w.wmqp, r, js_max(0.0, floor(paid)));
            }
            _ => self.heal_commit_clear(q),
        }
    }
    /// _getHealerCommittedQueueTarget.
    unsafe fn heal_committed(&self, q: usize) -> i32 {
        let w = self.w;
        if self.ttype(q) != w.tt_queue { return -1; }
        let t = self.target_tile(q);
        let r = self.rec(q);
        if t < 0 || Self::tile_of_word(g(w.wmqc, r)) != t { return -1; }
        let o = g(w.own, q) as i32;
        if !self.heal_queue_ok(t, o) { self.heal_commit_clear(q); return -1; }
        let paid = js_max(0.0, floor(self.queue_of(t).map(|v| v.2).unwrap_or(0.0)));
        let req = js_max(1.0, floor(g(w.wmqr, r)));
        let mp = js_max(floor(g(w.wmqp, r)), paid);
        s(w.wmqp, r, mp);
        if mp >= req { self.heal_commit_clear(q); return -1; }
        t
    }
    /// _healerRememberWorkSite (a structure at t, or a unit's slot sl).
    unsafe fn heal_remember(&self, q: usize, t: i32, sl: i32) {
        let w = self.w;
        let r = self.rec(q);
        if t >= 0 {
            let (gx, gy) = (irem(t, w.gw), idiv(t, w.gw));
            s(w.wmwx, r, gx as f64 * w.tile + w.tile * 0.5); s(w.wmwy, r, gy as f64 * w.tile + w.tile * 0.5);
            s(w.wmwgx, r, gx as f64); s(w.wmwgy, r, gy as f64);
        } else if sl >= 0 {
            let (x, y) = self.tick_pos(sl as usize);
            s(w.wmwx, r, x); s(w.wmwy, r, y);
        }
    }
    /// The route to its nearest healer spawner (RETURNING_FOR_GOLD), true when one.
    unsafe fn heal_route(&mut self, q: usize) -> bool {
        let w = self.w;
        let sp = self.brain_spawner(q, w.heal_type);
        let key = if sp >= 0 { self.path_to(q, sp) } else { -1 };
        if key < 0 { return false; }
        self.set_state(q, WS_RETURNING_FOR_GOLD);
        self.set_path(q, key);
        self.set_pidx(q, 0);
        self.set_cmd(q, CMD_MOVING);
        s(w.wmsp, self.rec(q), sp * 8 + WT_TILE as i32);
        s(w.tgx, q, (irem(sp, w.gw) as f64 * w.tile + 16.0) as f32); s(w.tgy, q, (idiv(sp, w.gw) as f64 * w.tile + 16.0) as f32);
        true
    }
    /// The heal target's tile (a structure's, or a unit's where it is this pass).
    unsafe fn heal_target_tile(&self, q: usize) -> i32 {
        let w = self.w;
        let sl = self.target_unit(q);
        if sl >= 0 {
            let (x, y) = self.tick_pos(sl as usize);
            return floor(y / w.tile) as i32 * w.gw + floor(x / w.tile) as i32;
        }
        self.target_tile(q)
    }
    /// _workerRunHealerRetargetIfDue.
    unsafe fn heal_retarget_due(&mut self, q: usize, heavy: bool) -> bool {
        if g(self.w.wskind, q) != 0 { return false; }
        if !self.idle_retarget(q, heavy) { return false; }
        self.heal_find(q);
        true
    }
    /// _healerFindTarget without the tier's answer (its committed or pinned
    /// queue, else the tier's request).
    unsafe fn heal_find(&mut self, q: usize) {
        let w = self.w;
        let o = g(w.own, q) as i32;
        let r = self.rec(q);
        let (ox, oy, from_site) = { let (x, y) = (g(w.wmwx, r), g(w.wmwy, r)); if x == x && y == y { (x, y, true) } else { let (ux, uy) = (g(w.x, q) as f64 * 0.125, g(w.y, q) as f64 * 0.125); (ux, uy, false) } };
        let (px, ak) = self.search(q);
        let pin = Self::tile_of_word(g(w.wmpin, r));
        let pinned = self.heal_anchor_ok(pin, o);
        let mut qt = self.heal_committed(q);
        if qt < 0 && self.heal_queue_ok(pin, o) { qt = pin; }
        if qt < 0 && self.take >= 0 { qt = self.grid_pick(q, PICK_QUEUE, w.tt_queue); }
        if qt < 0 && self.take < 0 {
            self.ws_register_at(q, WSR_HEAL, WSW_QUEUE, px, ak, true, true, -1, 0, if from_site { ox as f32 } else { f32::NAN }, if from_site { oy as f32 } else { f32::NAN }, f32::NAN, f32::NAN);
            return;
        }
        // (Out of its reach, unless pinned.)
        let (cx, cy) = (irem(qt, w.gw) as f64 * w.tile + w.tile * 0.5, idiv(qt, w.gw) as f64 * w.tile + w.tile * 0.5);
        let far = if w.area_search { false } else { sqrt((cx - ox) * (cx - ox) + (cy - oy) * (cy - oy)) > px };
        if !pinned && far { qt = -1; self.heal_commit_clear(q); }
        if qt >= 0 && !self.can_assign(q, qt, w.tt_queue) { qt = -1; }
        if qt >= 0 {
            if !self.set_target(q, qt, WT_TILE, w.tt_queue) { self.set_state(q, WS_IDLE); self.set_cmd(q, CMD_IDLE); return; }
            self.heal_remember(q, qt, -1);
            if Self::tile_of_word(g(w.wmqc, r)) != qt { self.heal_commit_set(q, qt); }
            if (g(w.wks, q) >> 15) & 3 == 2 {
                self.set_state(q, WS_MOVING_TO_HEAL);
                let key = self.path_to(q, qt);
                self.set_path(q, key); self.set_pidx(q, 0); self.set_cmd(q, CMD_MOVING);
                return;
            }
            let trip = self.heal_trip_cost(q, qt);
            if trip > 0.0 && self.heal_route(q) { s(w.wmtrip, r, trip); return; }
            self.set_state(q, WS_IDLE); self.set_cmd(q, CMD_IDLE);
            return;
        }
        if pin >= 0 && !self.heal_anchor_ok(pin, o) { s(w.wmpin, r, 0); }
        if self.take >= 0 {
            let sl = self.heal_take_unit(q);
            if sl < 0 { self.heal_commit_clear(q); self.clear_target(q, false); self.set_state(q, WS_IDLE); self.set_cmd(q, CMD_IDLE); return; }
            self.heal_commit_clear(q);
            if !self.set_target_unit(q, sl as usize) { self.set_state(q, WS_IDLE); self.set_cmd(q, CMD_IDLE); return; }
            self.heal_remember(q, -1, sl);
            if self.heal_material(q) {
                self.set_state(q, WS_MOVING_TO_HEAL);
                let key = self.path_to(q, self.unit_tile(sl as usize));
                self.set_path(q, key); self.set_pidx(q, 0); self.set_cmd(q, CMD_MOVING);
                return;
            }
            if self.heal_route(q) { return; }
            self.set_state(q, WS_IDLE); self.clear_target(q, false); self.set_cmd(q, CMD_IDLE);
            return;
        }
        // (Its queue out of reach or taken: the tier's search, damaged units too.)
        self.heal_commit_clear(q);
        self.ws_register_at(q, WSR_HEAL, WSW_QUEUE, px, ak, true, true, -1, 0, if from_site { ox as f32 } else { f32::NAN }, if from_site { oy as f32 } else { f32::NAN }, f32::NAN, f32::NAN);
    }
    #[inline(always)]
    unsafe fn heal_material(&self, q: usize) -> bool { (g(self.w.wks, q) >> 15) & 3 == 2 }
    #[inline(always)]
    unsafe fn heal_material_set(&self, q: usize, v: bool) { let x = g(self.w.wks, q); s(self.w.wks, q, (x & !(3 << 15)) | (if v { 2 } else { 1 } << 15)); }
    /// The healer's branch of updateWorkerAI.
    unsafe fn healer(&mut self, q: usize, heavy: bool) {
        let w = self.w;
        let st = self.st(q);
        let o = g(w.own, q) as i32;
        let r = self.rec(q);
        if st == WS_IDLE { self.heal_retarget_due(q, heavy); return; }
        if st == WS_HEALING { self.set_state(q, WS_MOVING_TO_HEAL); return; }
        let is_queue = self.ttype(q) == w.tt_queue;
        let tq = if is_queue { self.target_tile(q) } else { -1 };
        let tu = if is_queue { -1 } else { self.target_unit(q) };
        let valid = if is_queue { self.heal_queue_ok(tq, o) } else { self.heal_unit_ok(tu, o) };
        if st == WS_MOVING_TO_HEAL {
            if !valid {
                if is_queue { self.heal_commit_clear(q); }
                self.clear_target(q, true);
                if !self.heal_retarget_due(q, heavy) { self.set_state(q, WS_IDLE); self.set_cmd(q, CMD_IDLE); }
                return;
            }
            if !self.path_done(q) { return; }
            let tt = self.heal_target_tile(q);
            if !self.within(q, tt) {
                let key = self.path_to(q, tt);
                self.set_path(q, key); self.set_pidx(q, 0); self.set_cmd(q, CMD_MOVING);
                return;
            }
            if !self.heal_material(q) {
                if !self.heal_route(q) { self.set_state(q, WS_IDLE); self.set_cmd(q, CMD_IDLE); }
                return;
            }
            if g(w.cool, q) > 0 { return; }
            if is_queue {
                let tr = g(w.wmtrip, r);
                let work = js_max(1.0, floor(if tr != 0.0 && tr == tr { tr } else { self.heal_dps_round(q) }));
                let mut did = false;
                if let Some((n, req, paid)) = self.queue_of(tq) {
                    if n > 0 && paid < req {
                        let p = self.ccol::<f64>(tq as usize, CT_QPAID);
                        s(p, g(w.rrow, tq as usize).max(0) as usize, js_min(req, paid + work));
                        did = true;
                    }
                }
                if did {
                    self.heal_material_set(q, false);
                    s(w.wmtrip, r, 0.0);
                    self.set_cooldown(q, w.heal_cd);
                    if g(w.stown, tq as usize) == w.local { self.emit(OUT_SOUND_HEAL, tq, -1, 0); }
                }
                // (Its production, and a ready order once paid: barrack.js, after the pass.)
                self.emit(OUT_QUEUE_PAID, tq, if did { 1 } else { 0 }, 0);
                if !self.heal_queue_ok(tq, o) {
                    self.clear_target(q, true);
                    if !self.heal_retarget_due(q, heavy) { self.set_state(q, WS_IDLE); self.set_cmd(q, CMD_IDLE); }
                    return;
                }
                let trip = self.heal_trip_cost(q, tq);
                if trip > 0.0 && self.heal_route(q) { s(w.wmtrip, r, trip); return; }
                self.set_state(q, WS_IDLE); self.set_cmd(q, CMD_IDLE);
                return;
            }
            self.set_state(q, WS_HEALING);
            let d = self.hot(q, 12);
            let dps = if d != 0.0 && d == d { d } else { w.heal_base_dps };
            let su = tu as usize;
            let m = g(w.maxe, su) as f64;
            s(w.energy, su, js_min(m, g(w.energy, su) as f64 + dps) as f32);
            self.heal_material_set(q, false);
            self.set_cooldown(q, w.heal_cd);
            if g(w.own, su) as i32 == w.local { self.emit(OUT_SOUND_HEAL, -1, tu, 0); }
            if !self.heal_unit_ok(tu, o) {
                self.clear_target(q, true);
                if !self.heal_retarget_due(q, heavy) { self.set_state(q, WS_IDLE); self.set_cmd(q, CMD_IDLE); }
                return;
            }
            if !self.heal_route(q) { self.set_state(q, WS_IDLE); self.set_cmd(q, CMD_IDLE); }
            return;
        }
        if st == WS_RETURNING_FOR_GOLD {
            if !self.path_done(q) { return; }
            if !valid {
                if is_queue { self.heal_commit_clear(q); }
                self.clear_target(q, true);
                s(w.wmtrip, r, 0.0);
                if !self.heal_retarget_due(q, heavy) { self.set_state(q, WS_IDLE); self.set_cmd(q, CMD_IDLE); }
                return;
            }
            let sp0 = Self::tile_of_word(g(w.wmsp, r));
            let sp = if sp0 >= 0 && g(w.ctab, sp0 as usize) != 0 { sp0 } else { self.brain_spawner(q, w.heal_type) };
            let at = sp < 0 || self.within(q, sp);
            if at {
                if g(w.cool, q) > 0 { return; }
                let trip = if is_queue { self.heal_trip_cost(q, tq) } else { 1.0 };
                if sp >= 0 && trip > 0.0 {
                    self.pay(o, 0, -trip);
                    self.energy_log(o, ES_HEALER, -trip);
                    self.heal_material_set(q, true);
                    s(w.wmtrip, r, if is_queue { trip } else { 0.0 });
                    self.set_cooldown(q, w.heal_cd);
                } else if trip > 0.0 {
                    s(w.wmblk, r, (w.now + w.blocked_ticks) as f64);
                }
                s(w.wmsp, r, 0);
                self.set_state(q, WS_MOVING_TO_HEAL);
                let tt = self.heal_target_tile(q);
                let key = self.path_to(q, tt);
                self.set_path(q, key); self.set_pidx(q, 0); self.set_cmd(q, CMD_MOVING);
            } else if !self.heal_route(q) {
                s(w.wmsp, r, 0);
                self.set_state(q, WS_IDLE); self.set_cmd(q, CMD_IDLE);
            }
        }
    }
    // ---- Salvagers ----
    unsafe fn salvager(&mut self, q: usize, heavy: bool) {
        let w = self.w;
        let st = self.st(q);
        let o = g(w.own, q) as i32;
        if st == WS_IDLE {
            if g(w.wskind, q) != 0 { return; }
            if !self.idle_retarget(q, heavy) { return; }
            self.salvager_find(q);
        } else if st == WS_MOVING_TO {
            let t = self.target_tile(q);
            let marked = t >= 0 && { let m = self.ccol::<u8>(t as usize, CT_MARKED); !m.is_null() && g(m, g(w.rrow, t as usize).max(0) as usize) == 2 };
            if !marked || !self.owns_reserved(q, t) {
                self.clear_target(q, true);
                self.clear_auto_route(q);
                self.salvager_find(q);
                return;
            }
            if !self.path_done(q) { return; }
            if self.within(q, t) {
                if g(w.cool, q) > 0 { return; }
                // The refund: a tenth of its price per stack, times the salvager's level.
                let tu = t as usize;
                // (The descriptor's type: the stationary type id + 1.)
                let ty = (g(w.stbrain, tu) & 65535) - 1;
                let price = if ty >= 0 && ty < w.nprice { g(w.price, ty as usize) } else { 0.0 };
                let sk = { let p = self.ccol::<i32>(tu, CT_STACKS); if p.is_null() { i32::MIN } else { g(p, g(w.rrow, tu).max(0) as usize) } };
                let stacks = if sk == i32::MIN || sk == 0 { 1.0 } else { sk as f64 };
                let refund = floor(price * stacks * 0.1);
                s(w.wmcarry, self.rec(q), refund * self.base_level(q) as f64);
                if o == w.local { self.emit(OUT_SOUND_UNIT, q as i32, 0, SND_SALVAGER_WORK); }
                self.emit(OUT_SALVAGE, t, (g(w.wks, q) >> 10 & 7) as i32, 0);
                self.set_cooldown(q, w.salv_cd);
                self.clear_target(q, true);
                self.set_state(q, WS_RETURNING);
                self.return_path(q);
            } else {
                let key = self.path_to(q, t);
                self.set_path(q, key);
                if key >= 0 {
                    self.set_pidx(q, 0);
                    self.set_cmd(q, CMD_MOVING);
                } else {
                    self.clear_target(q, true);
                    self.clear_auto_route(q);
                    self.salvager_find(q);
                }
            }
        } else if st == WS_RETURNING {
            if !self.path_done(q) { return; }
            let r = self.rec(q);
            let carry = g(w.wmcarry, r);
            if carry > 0.0 {
                if g(w.cool, q) > 0 { return; }
                self.pay(o, 0, carry);
                self.energy_log(o, ES_SALVAGE, carry);
                self.set_cooldown(q, w.salv_cd);
                if o == w.local { self.emit(OUT_SOUND_UNIT, q as i32, 0, SND_SALVAGE_COLLECTED); }
            }
            s(w.wmcarry, r, 0.0);
            if !heavy { return; }
            self.salvager_find(q);
        }
    }
    /// _salvagerFindTarget: the search tier's pick, a request now.
    unsafe fn salvager_find(&mut self, q: usize) {
        if self.take >= 0 {
            let t = self.grid_pick(q, PICK_SALVAGE, 1);
            if t < 0 || !self.set_target(q, t, WT_TILE, 1) { self.set_state(q, WS_IDLE); self.set_cmd(q, CMD_IDLE); return; }
            let key = self.path_to(q, t);
            self.set_path(q, key);
            if key >= 0 { self.set_state(q, WS_MOVING_TO); self.set_pidx(q, 0); self.set_cmd(q, CMD_MOVING); }
            else { self.clear_auto_route(q); self.clear_target(q, false); self.set_state(q, WS_IDLE); self.set_cmd(q, CMD_IDLE); }
            return;
        }
        let (px, ak) = self.search(q);
        self.ws_register(q, WSR_GRID, WSW_SALVAGE, px, ak, false);
    }
    /// _researcherSearch in a take: the grid's pick.
    unsafe fn research_take(&mut self, q: usize) {
        let w = self.w;
        let t = self.grid_pick(q, PICK_RESEARCH, w.research_tt);
        if t < 0 { self.set_cmd(q, CMD_IDLE); return; }
        if !self.set_target(q, t, WT_TILE, w.research_tt) { self.set_state(q, WS_IDLE); self.set_cmd(q, CMD_IDLE); return; }
        self.set_state(q, WS_MOVING_TO_RESEARCH);
        let key = self.path_to(q, t);
        self.set_path(q, key); self.set_pidx(q, 0); self.set_cmd(q, CMD_MOVING);
    }
    // ---- The tier's takes (worker.js _wsTakeSome, all at once) ----
    /// Request i: its worker's find with the results (the same request still: id, kind, stamp).
    unsafe fn take_one(&mut self, i: usize) {
        let w = self.w;
        let q = g(w.trs, i);
        if q < 0 { return; }
        let q = q as usize;
        let kind = g(w.trk, i);
        if g(w.dead, q) != 0 || g(w.id, q) != g(w.trid, i) || g(w.wskind, q) as i32 != kind || g(w.wst, self.rec(q)) != g(w.trwt, i) { return; }
        self.take = i as i32;
        match self.wb(q) {
            WB_COLLECTOR | WB_ASTAR => self.coll_find(q),
            WB_BUILDER => self.b_find(q),
            WB_SALVAGER => self.salvager_find(q),
            WB_HEALER => self.heal_find(q),
            WB_RESEARCHER => self.research_take(q),
            _ => {}
        }
        self.take = -1;
        // (Still searching: nothing it could take; its next searches further apart.)
        if g(w.wskind, q) != 0 { let f = g(w.wsfail, q); if f < 255 { s(w.wsfail, q, f + 1); } } else { s(w.wsfail, q, 0); }
    }
    /// _wsGridPick with the take's results: the first site whose owned
    /// structure is still the worker's work and free for it.
    unsafe fn grid_pick(&mut self, q: usize, kind: u8, tt: u32) -> i32 {
        let w = self.w;
        let o = g(w.own, q) as i32;
        let base = self.take as usize * w.tk;
        for k in 0..w.tk {
            let t = g(w.tres, base + k);
            if t < 0 { break; }
            if t >= w.gw * w.gh || g(w.ctab, t as usize) == 0 || g(w.stown, t as usize) != o { continue; }
            let ok = match kind {
                PICK_BUILD => self.b_valid(t, o),
                PICK_SALVAGE => { let m = self.ccol::<u8>(t as usize, CT_MARKED); !m.is_null() && g(m, g(w.rrow, t as usize).max(0) as usize) == 2 }
                PICK_RESEARCH => self.research_valid(t, o),
                _ => self.heal_queue_ok(t, o),
            };
            if ok && self.can_assign(q, t, tt) { return t; }
        }
        -1
    }
    /// The collectors' pick from the take's sites (_pickDistributedWorkerCandidate):
    /// the least score (the search's distance, less for its current target, a jitter
    /// by id and tile), ties by type and tile.
    unsafe fn coll_pick(&mut self, q: usize) -> (i32, u32) {
        let w = self.w;
        let rz = self.res(q);
        let i = self.take as usize;
        let gi = g(w.trg, i);
        if gi < 0 || gi >= 16 { return (-1, 0); }
        let tiles = waddr(g(w.gtab, gi as usize * 2) as u32) as *const i32;
        let kinds = waddr(g(w.gtab, gi as usize * 2 + 1) as u32) as *const i32;
        if tiles.is_null() || kinds.is_null() { return (-1, 0); }
        let id = g(w.id, q) as i64;
        let (mut best, mut bs, mut btt) = (-1i32, f64::INFINITY, 0u32);
        for k in 0..w.tk {
            let x = g(w.tres, i * w.tk + k);
            if x < 0 { break; }
            let t = g(tiles, x as usize);
            let tt = if g(kinds, x as usize) == 1 { w.tt_mine[rz] } else { w.tt_farm[rz] };
            if !self.coll_valid(q, t, tt) || !self.can_assign(q, t, tt) { continue; }
            let (gx, gy) = (irem(t, w.gw) as i64, idiv(t, w.gw) as i64);
            let mut sc = g(w.tsc, i * w.tk + k) as f64;
            if self.targets(q, t, tt) { sc -= w.tile * 0.75; }
            let seed = ((id.wrapping_mul(1103515245) + gx * 12345 + gy * 54321) as u32) % 1024;
            sc += (seed as f64 / 1024.0) * w.tile * 0.35;
            if sc < bs - 1e-9 || ((sc - bs).abs() <= 1e-9 && (tt, t) < (btt, best)) { bs = sc; best = t; btt = tt; }
        }
        (best, btt)
    }
    /// A healer's damaged unit from the take (_wsHealUnit): the first still damaged and free.
    unsafe fn heal_take_unit(&mut self, q: usize) -> i32 {
        let w = self.w;
        let o = g(w.own, q) as i32;
        if !(o >= 0) || w.hid.is_null() { return -1; }
        let i = self.take as usize;
        for k in 0..3 {
            let x = g(w.tur, i * 3 + k);
            if x < 0 || x >= w.hm { continue; }
            let sl = self.slot_of(g(w.hid, (o * w.hm + x) as usize));
            if self.heal_unit_ok(sl, o) && self.can_assign_unit(q, sl) { return sl; }
        }
        -1
    }
    /// A unit's tile this pass (its reservation's tile).
    unsafe fn unit_tile(&self, sl: usize) -> i32 {
        let (x, y) = self.tick_pos(sl);
        floor(y / self.w.tile) as i32 * self.w.gw + floor(x / self.w.tile) as i32
    }
    /// _canAssignWorkerTargetExclusive for a unit target (its slot).
    unsafe fn can_assign_unit(&mut self, q: usize, sl: i32) -> bool {
        let w = self.w;
        if sl < 0 { return false; }
        if self.tkind(q) == WT_UNIT && g(w.wkt, q) == g(w.id, sl as usize) && self.ttype(q) == w.tt_unit { return true; }
        let li = g(w.ttab, self.wb(q) as usize) & 255;
        let slot = self.unit_tile(sl as usize) * w.nt + li;
        if slot < 0 || slot >= w.nres { return false; }
        let id = g(w.resv, slot as usize);
        if id <= 0 { return true; }
        let rs = self.slot_of(id);
        if rs < 0 || g(w.dead, rs as usize) != 0 { self.resv_set(slot, 0); return true; }
        let r = rs as usize;
        r == q || g(w.own, r) != g(w.own, q) || self.wb(r) != self.wb(q)
    }
    /// _setWorkerTarget for a unit target (reserved at its tile; a lower id of the
    /// same owner and type holding the slot keeps it).
    unsafe fn set_target_unit(&mut self, q: usize, sl: usize) -> bool {
        let w = self.w;
        let tid = g(w.id, sl);
        if self.tkind(q) == WT_UNIT && g(w.wkt, q) == tid && self.ttype(q) == w.tt_unit { return true; }
        let my = g(w.id, q);
        let li = g(w.ttab, self.wb(q) as usize) & 255;
        let next = self.unit_tile(sl) * w.nt + li;
        if next >= 0 && next < w.nres {
            let rid = g(w.resv, next as usize);
            let rsl = self.slot_of(rid);
            if rid > 0 && rsl >= 0 && rsl as usize != q && g(w.dead, rsl as usize) == 0 && g(w.own, rsl as usize) == g(w.own, q) && self.wb(rsl as usize) == self.wb(q) {
                let r = rsl as usize;
                if rid <= my { return false; }
                let rs = g(w.wkr, r);
                if rs >= 0 && rs < w.nres && g(w.resv, rs as usize) == rid { self.resv_set(rs, 0); }
                if self.tkind(r) == WT_UNIT && g(w.wkt, r) == tid {
                    let v = g(w.wks, r);
                    s(w.wks, r, (v & !((31 << 5) | (7 << 10))) | (1 << 5) | (WT_NULL << 10));
                    s(w.wkt, r, 0);
                    let rst = self.st(r);
                    if rst == WS_MOVING_TO || rst == WS_MOVING_TO_ASTAR || rst == WS_IDLE { self.set_state(r, WS_IDLE); self.set_cmd(r, CMD_IDLE); self.clear_auto_route(r); }
                }
                s(w.wkr, r, -1);
            }
        }
        if self.target_tile(q) >= 0 || self.tkind(q) == WT_UNIT {
            let ps = g(w.wkr, q);
            if ps >= 0 && ps < w.nres && g(w.resv, ps as usize) == my { self.resv_set(ps, 0); }
        }
        let v = g(w.wks, q);
        s(w.wks, q, (v & !((31 << 5) | (7 << 10))) | (w.tt_unit << 5) | (WT_UNIT << 10));
        s(w.wkt, q, tid);
        s(w.wskind, q, 0);
        s(w.wkr, q, -1);
        if next >= 0 && next < w.nres { self.resv_set(next, my); s(w.wkr, q, next); }
        true
    }
    /// _workerReturnPath for a salvager: to its nearest salvage yard with
    /// what it carries.
    unsafe fn return_path(&mut self, q: usize) {
        let w = self.w;
        if !(g(w.wmcarry, self.rec(q)) > 0.0) { self.clear_auto_route(q); return; }
        let sp = self.brain_spawner(q, w.salv_type);
        let key = if sp >= 0 { self.path_to(q, sp) } else { -1 };
        if key >= 0 {
            self.set_path(q, key);
            self.set_pidx(q, 0);
            self.set_cmd(q, CMD_MOVING);
        } else {
            self.set_path(q, -1);
            self.set_pidx(q, 0);
            self.set_cmd(q, CMD_IDLE);
        }
    }
    /// The transfer cooldown: a Uint16 timer, saturated as its setter
    /// stores it (tmOn: counted down by the status pre-pass).
    unsafe fn set_cooldown(&self, q: usize, base: i32) {
        let w = self.w;
        let cd = self.hot(q, 15) as i32;
        let cd = if cd > 0 { cd } else { base };
        s(w.cool, q, cd.max(0).min(65535) as u16);
        if cd > 0 { s(w.tmon, q, 1); }
    }
    // ---- Researchers ----
    unsafe fn researcher(&mut self, q: usize, heavy: bool) {
        let w = self.w;
        let st = self.st(q);
        let o = g(w.own, q) as i32;
        if st == WS_IDLE {
            if g(w.wskind, q) != 0 { return; }
            if !self.idle_retarget(q, heavy) { return; }
            // (_researcherSearch: the search tier's pick, a request now.)
            let (px, ak) = self.search(q);
            self.ws_register(q, WSR_RESEARCH, WSW_RESEARCH, px.max(w.tile * 32.0), ak, true);
            return;
        }
        if st != WS_MOVING_TO_RESEARCH && st != WS_RESEARCHING && st != WS_RETURNING_FOR_GOLD { return; }
        if st != WS_MOVING_TO_RESEARCH { self.set_state(q, WS_MOVING_TO_RESEARCH); self.set_path(q, -1); self.set_pidx(q, 0); }
        let t = self.target_tile(q);
        if !self.research_valid(t, o) {
            self.clear_target(q, true);
            self.set_state(q, WS_IDLE);
            self.set_cmd(q, CMD_IDLE);
            return;
        }
        if !self.path_done(q) { return; }
        if !self.within(q, t) {
            let key = self.path_to(q, t);
            self.set_path(q, key);
            self.set_pidx(q, 0);
            self.set_cmd(q, CMD_MOVING);
            return;
        }
        if g(w.cool, q) > 0 { return; }
        self.research_deposit(q, t, o);
        self.set_cmd(q, CMD_IDLE);
    }
    /// _isResearcherTargetBuilding (a task started for an idle queue: the
    /// queue's advance after the pass, its next task's words now).
    unsafe fn research_valid(&mut self, t: i32, o: i32) -> bool {
        let w = self.w;
        if t < 0 || g(w.ctab, t as usize) != w.rcls { return false; }
        let tu = t as usize;
        if g(w.stown, tu) != o || !(g(w.stval, tu) > 0.0) || g(w.stuc, tu) != 0 { return false; }
        let row = g(w.rrow, tu);
        if row < 0 || g(w.rmark, row as usize) == 2 { return false; }
        if !(o >= 0 && o < w.np) { return false; }
        let b = o as usize * RS_W;
        if g(w.rs, b) == 0.0 {
            if g(w.rauto, row as usize) == 1 { return false; }
            if g(w.rs, b + 5) == 0.0 { return false; }
            // (The queue's next task, active from now: worker.js
            // tryAdvancePlayerResearchTask after the pass.)
            s(w.rs, b, 1.0); s(w.rs, b + 1, g(w.rs, b + 6)); s(w.rs, b + 2, g(w.rs, b + 7)); s(w.rs, b + 3, g(w.rs, b + 8)); s(w.rs, b + 5, 0.0);
            self.emit(OUT_RESEARCH_ADVANCE, o, 0, 0);
        }
        self.research_needs(o)
    }
    unsafe fn research_needs(&self, o: i32) -> bool {
        let b = o as usize * RS_W;
        let w = self.w;
        g(w.rs, b) != 0.0 && g(w.rs, b + 2) + g(w.rs, b + 4) < g(w.rs, b + 1)
    }
    /// _researcherDeposit.
    unsafe fn research_deposit(&mut self, q: usize, t: i32, o: i32) {
        let w = self.w;
        if !(o >= 0 && o < w.np) || !self.research_needs(o) { return; }
        let b = o as usize * RS_W;
        let req = g(w.rs, b + 1).max(0.0);
        let cost = g(w.rs, b + 3).max(0.0);
        let row = g(w.rrow, t as usize) as usize;
        // (getThingBaseLevel: its level, else its stacks' level.)
        let lv = g(w.rlevel, row) as i32;
        let bl = if lv != -128 { (lv.min(w.maxl)).max(1) } else {
            let sk = g(w.rstacks, row);
            if sk != i32::MIN { stack_level(sk, w.maxl) } else { 1 }
        };
        let ti = (o * w.l1 + bl) as usize;
        let mut dps = self.hot(q, 13);
        if !(dps != 0.0 && dps == dps) { dps = g(w.tdps, ti); }
        if !(dps != 0.0 && dps == dps) { dps = w.fallback_rdps; }
        let work = js_max(0.1, dps * g(w.teff, ti));
        let trip = if req > 0.0 { work * cost / req } else { 0.0 };
        if trip > 0.0 {
            self.pay(o, 0, -trip);
            self.energy_log(o, ES_RESEARCH, -trip);
        }
        s(w.rs, b + 4, g(w.rs, b + 4) + work);
        s(w.cnt, 4, g(w.cnt, 4) + 1);
        self.set_cooldown(q, w.base_cd);
        if g(w.stown, t as usize) == w.local { self.emit(OUT_SOUND_RESEARCH, q as i32, t, 0); }
    }
}

/// stackCountToLevel (a whole count).
fn stack_level(n: i32, max: i32) -> i32 {
    let v = if n == 0 { 1 } else { n };
    if v <= 0 { return 1; }
    (31 - (v as u32).leading_zeros() as i32 + 1).min(max).max(1)
}
/// unit.js _simTickBound.
fn tick_bound(v: f64) -> i32 {
    if v != v { return i32::MIN; }
    if v >= 2147483647.0 { return i32::MAX; }
    if v <= -2147483648.0 { return i32::MIN; }
    ceil(v) as i32
}
/// worker.js _workerResTerm.
#[inline(always)]
fn res_term(slot: i32, id: i32) -> i32 {
    if id == 0 { return 0; }
    let h = ((slot.wrapping_add(1)) ^ (id.wrapping_add(0x3c6ef372)).wrapping_mul(2654435761u32 as i32)).wrapping_mul(2246822519u32 as i32);
    (h ^ ((h as u32) >> 13) as i32).wrapping_mul(3266489917u32 as i32)
}
/// worker.js _workerWorkMix.
#[inline(always)]
fn work_mix(i: i32) -> i32 {
    (i.wrapping_add(1) ^ 0x9e3779b9u32 as i32).wrapping_mul(2654435761u32 as i32)
}
