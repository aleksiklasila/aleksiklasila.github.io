'use strict';
// The info panel's packer: a thread of the page's that works out every
// number the panel shows, so the page only writes them into its elements
// (info_panel_static.js). It reads, in place: the presentation structure
// table and the stat tables in the simulation's wasm heap (shared memory:
// sim_presentation.js simInfoPackPayload / simInfoPackStatDir), and the
// page's unit frame columns (shared buffers). Structures are binned by a
// kernel (wasm/src/info.rs k_info_bins), units here; each group's numbers
// from its bins and the stat tables. Read only, nothing of the match depends
// on it; rows may be mid-write (a number a tick old or new).
//   page -> init {pack, cat}; strings {list}; stats {dir}; sel {seq, sSlots,
//   sSers, uSlots} (transferred); frame {cols}; local {player}
//   page <- out {seq, rows (Float64Array, IPF_N a group), ms}
importScripts('./info_pack_fields.js?v=20261101-b', '../utils/id_codec.js?v=20261101-b');
let X = null, P = null, mem = null, cat = null, strings = [''], sel = null, frame = null, localPlayer = 0, timer = 0, busy = false;
const INFO_PACK_EVERY_MS = 100;
// Group lookups by string code (made again when the strings grow).
let groupOf = null, codesFor = -1;
// The stat tables: by "owner|kind|key", a Float32Array over the heap and its columns.
const stats = new Map();

self.onmessage = ev => {
    const m = ev.data || {};
    try {
        if (m.type === 'init') init(m);
        else if (m.type === 'strings') { strings = m.list; codesFor = -1; }
        else if (m.type === 'stats') setStats(m.dir);
        else if (m.type === 'frame') frame = m.cols;
        else if (m.type === 'local') localPlayer = m.player;
        else if (m.type === 'box') boxSelect(m);
        else if (m.type === 'sel') {
            sel = (m.sSlots && m.sSlots.length) || (m.uSlots && m.uSlots.length) ? m : null;
            // (In slot order, once a selection: the columns read in memory order.)
            if (sel) { if (sel.uSlots && sel.uSlots.length > 1) sel.uSlots = radixSort(sel.uSlots, null).a; if (sel.sSlots && sel.sSlots.length > 1) { const r = radixSort(sel.sSlots, sel.sSers); sel.sSlots = r.a; sel.sSers = r.b; } }
            stop(); if (sel) { selectionIds(m.seq); run(); } else self.postMessage({ type: 'out', seq: m.seq, rows: null, ms: 0 });
        }
    } catch (err) { self.postMessage({ type: 'error', message: String(err && err.stack || err) }); }
};

function init(m) {
    P = m.pack; cat = m.cat; localPlayer = m.cat.localPlayer;
    const w = P.wasm;
    const exp = new WebAssembly.Instance(w.module, { env: { memory: w.memory } }).exports;
    if (typeof exp.k_info_bins !== 'function') throw new Error('k_info_bins: not in this build');
    exp.__stack_pointer.value = w.stackTop;
    X = exp; mem = w.memory;
    setStats(P.stats);
    self.postMessage({ type: 'ready' });
}
function setStats(dir) {
    stats.clear();
    if (!dir) return;
    for (const t of dir.tables) {
        const col = {};
        t.cols.forEach((name, k) => { col[name] = k; });
        stats.set(t.owner + '|' + t.kind + '|' + t.key, { f: new Float32Array(mem.buffer, t.at, (t.levels - 1) * t.rowStride + (t.cols.length - 1) * t.statStride + 1), levels: t.levels, rs: t.rowStride, ss: t.statStride, col });
    }
}
function stop() { if (timer) { clearTimeout(timer); timer = 0; } }
// LSD radix sort of non-negative int32 keys (8-bit passes; b, if given, moved alongside).
function radixSort(a, b) {
    const n = a.length;
    let max = 0;
    for (let i = 0; i < n; i++) if (a[i] > max) max = a[i];
    let A = a, B = b, TA = new Int32Array(n), TB = b ? new Int32Array(n) : null;
    const cnt = new Int32Array(256);
    for (let shift = 0; shift < 32 && (max >>> shift) > 0; shift += 8) {
        cnt.fill(0);
        for (let i = 0; i < n; i++) cnt[(A[i] >>> shift) & 255]++;
        for (let k = 0, sum = 0; k < 256; k++) { const c = cnt[k]; cnt[k] = sum; sum += c; }
        for (let i = 0; i < n; i++) { const d = cnt[(A[i] >>> shift) & 255]++; TA[d] = A[i]; if (B) TB[d] = B[i]; }
        let t = A; A = TA; TA = t; if (B) { t = B; B = TB; TB = t; }
    }
    return { a: A, b: B };
}

// ---- small helpers (data_static.js / things_utils.js, the same rules) ----
const clampL = l => Math.max(1, Math.min(cat.maxLevel, Math.floor(Number(l) || 1)));
const areaSteps = v => { v = Number(v); return v > 0 ? Math.min(cat.areaStepsMax, Math.floor(v + 1e-9)) : 0; };
const visTiles = area => Number.isFinite(area) ? Math.max(0.6, areaSteps(area)) * cat.areaUnit : NaN;
const stacksForLevel = l => Math.max(1, Math.round(Math.pow(2, clampL(l) - 1)));
// A stat of an owner's table at a level (NaN without one).
function stat(owner, kind, key, level, name) {
    const t = stats.get(owner + '|' + kind + '|' + key);
    if (!t) return NaN;
    const k = t.col[name];
    if (k === undefined) return NaN;
    return t.f[Math.min(t.levels - 1, clampL(level)) * t.rs + k * t.ss];
}
const bstat = (o, key, l, name) => stat(o, 'building', key, l, name);
const ustat = (o, key, l, name) => stat(o, 'unit', key, l, name);
const num = v => Number.isFinite(v) ? v : 0;

// ---- codes to groups ----
function groupsFromCodes() {
    if (codesFor === strings.length) return;
    const G = cat.groups, byKey = new Map(G.map((g, i) => [g.key, i]));
    const towers = new Set(cat.towers), spawners = new Set(cat.spawners);
    // [code] -> group of a structure of that type (non-barrack), of a barrack of that unit type, of a unit of that type.
    const n = strings.length, sType = new Int16Array(n).fill(-1), sBarrack = new Int16Array(n).fill(-1), uType = new Int16Array(n).fill(-1);
    for (let c = 1; c < n; c++) {
        const t = strings[c];
        if (!t) continue;
        const k = towers.has(t) ? 'tower_' + t : spawners.has(t) ? t : 'floor_' + t;
        if (byKey.has(k)) sType[c] = byKey.get(k);
        if (byKey.has('barrack_' + t)) sBarrack[c] = byKey.get('barrack_' + t);
        if (byKey.has('unit_' + t)) uType[c] = byKey.get('unit_' + t);
    }
    groupOf = { sType, sBarrack, uType, barrack: strings.indexOf('barrack'), gold: byKey.get('goldmine'), astar: byKey.get('astarmine') };
    codesFor = n;
}
// The structure table's columns at base with cap slots (sim_frame_world.js simTableViews).
function tableCols(base, cap) {
    const S = P.spec, at = {};
    let off = base;
    for (const k of S.f32) { at[k] = off; off += 4 * cap; }
    for (const k of S.i32) { at[k] = off; off += 4 * cap; }
    off += 4 * cap;
    for (const k of S.i16) { at[k] = off; off += 2 * cap; }
    for (const k of S.u8) { at[k] = off; off += cap; }
    return at;
}

function run() {
    if (!X || !sel || busy) return;
    busy = true;
    stop();
    try {
        const t0 = performance.now();
        groupsFromCodes();
        const G = cat.groups, rows = new Float64Array(G.length * IPF_N);
        for (let g = 0; g < G.length; g++) { const o = g * IPF_N; rows[o + IPF.lvMin] = rows[o + IPF.elvMin] = 1e9; rows[o + IPF.rallyMin] = 1e18; rows[o + IPF.rallyMax] = -1; rows[o + IPF.repSlot] = -1; }
        if (sel.sSlots && sel.sSlots.length) structures(rows);
        const t1 = performance.now();
        if (sel.uSlots && sel.uSlots.length && frame) units(rows);
        const t2 = performance.now();
        // (Each present group's text, the page writes it as it is.)
        const texts = new Array(G.length);
        for (let g = 0; g < G.length; g++) texts[g] = groupText(g, rows);
        const t3 = performance.now();
        self.postMessage({ type: 'out', seq: sel.seq, rows, texts, ms: t3 - t0, phases: [t1 - t0, t2 - t1, t3 - t2, unitPassMs, unitBinCount, sel.uSlots ? sel.uSlots.length : 0] }, [rows.buffer]);
    } finally {
        busy = false;
        if (sel) timer = setTimeout(run, INFO_PACK_EVERY_MS);
    }
}

// ---- structures: the kernel's bins, then each group's numbers ----
const BF = 21;
function structures(rows) {
    const buf = mem.buffer, A = P.at, hdr = new Uint32Array(buf, A.hdr, 4);
    const base = Atomics.load(hdr, 0), cap = Atomics.load(hdr, 1);
    if (!(base > 0 && cap > 0)) return;
    const c = tableCols(base, cap);
    const kind = new Int16Array(buf, c.kind, cap), type = new Int16Array(buf, c.type, cap), utype = new Int16Array(buf, c.utype, cap);
    const stacksC = new Int16Array(buf, c.stacks, cap), mstacksC = new Int16Array(buf, c.mstacks, cap), estacksC = new Int16Array(buf, c.estacks, cap);
    const flagsC = new Int32Array(buf, c.flags, cap), rallyXC = new Float32Array(buf, c.rallyX, cap), rallyYC = new Float32Array(buf, c.rallyY, cap);
    // (A selection past the members' room: an even sample of it, the counts scaled.)
    const total = sel.sSlots.length, n = Math.min(total, P.members), step = total / n, scale = total / n;
    const S = new Int32Array(buf, A.slots, n), R = new Int32Array(buf, A.sers, n), Gr = new Int32Array(buf, A.groups, n);
    const go = groupOf;
    for (let i = 0; i < n; i++) {
        const j = n === total ? i : Math.floor(i * step), s = sel.sSlots[j];
        S[i] = s; R[i] = sel.sSers[j];
        let g = -1;
        if (s >= 0 && s < cap) {
            const k = kind[s], t = type[s];
            g = k === 4 ? go.gold : k === 5 ? go.astar : t === go.barrack ? go.sBarrack[utype[s]] : t > 0 && t < go.sType.length ? go.sType[t] : -1;
            if (g === undefined) g = -1;
        }
        Gr[i] = g;
    }
    const I = new Int32Array(buf, P.wasm.args, 1024), F = new Float64Array(buf, P.wasm.args + 4096, 512);
    const words = [c.alive, c.serial, c.flags, c.owner, c.level, c.elevel, c.qlen, c.energy, c.amount, c.amountMax, c.rallyX, c.rallyY,
        A.slots, A.sers, A.groups, A.table, A.binOf, A.bins, A.out];
    for (let i = 0; i < words.length; i++) I[512 + i] = words[i];
    I[1000] = P.wasm.scratch; I[1001] = P.wasm.scratchWords;
    F[0] = n; F[1] = P.tableEntries; F[2] = P.bins; F[3] = cap; F[4] = P.tile;
    X.k_info_bins(P.wasm.args, 0);
    const out = new Int32Array(buf, A.out, 4), nb = out[0], B = new Float64Array(buf, A.bins, nb * BF);
    const best = new Float64Array(cat.groups.length), tok = new Map();
    for (let b = 0; b < nb; b++) {
        const q = b * BF, g = B[q];
        if (!(g >= 0)) continue;
        const grp = cat.groups[g], o = g * IPF_N, own = B[q + 1], n = B[q + 6] * scale, st = B[q + 4];
        if (!(n > 0)) continue;
        const lvRaw = B[q + 2], bl = lvRaw >= 1 ? clampL(lvRaw) : 1, el = B[q + 3] >= 0 ? clampL(Math.max(1, B[q + 3])) : bl;
        const ready = st !== 1, sk = grp.statKey, uk = grp.upkeepKey;
        const add = (f, v) => { rows[o + f] += v; };
        add(IPF.n, n); add(ready ? IPF.ready : IPF.uc, n); if (st === 2) add(IPF.upg, n); if (st === 3) add(IPF.stacking, n);
        add(IPF.energy, B[q + 7] * scale);
        if (grp.kind !== 'mine') {
            // Energy display (hud.js getThingEnergyDisplayValues): over the
            // upgrade trigger (the next level's maximum while above it) and
            // the effective maximum.
            const baseMax = Math.max(1, Math.floor(num(bstat(own, sk, bl, 'maxEnergy')) || 1)), effMax = Math.max(1, Math.floor(num(bstat(own, sk, el, 'maxEnergy')) || 1));
            const trig = el > bl ? Math.max(1, Math.floor(num(bstat(own, sk, bl + 1, 'maxEnergy')) || baseMax)) : baseMax;
            add(IPF.trig, trig * n); add(IPF.effMax, effMax * n); add(IPF.maxCol, effMax * n);
            add(IPF.upB, num(bstat(own, uk, bl, 'upKeep')) * n); add(IPF.upE, num(bstat(own, uk, el, 'upKeep')) * n);
            add(IPF.visB, num(visTiles(bstat(own, sk, bl, 'visionRangeArea'))) * n); add(IPF.visE, num(visTiles(bstat(own, sk, el, 'visionRangeArea'))) * n);
            if (grp.unitKey) { add(IPF.uupB, num(ustat(own, grp.unitKey, bl, 'upKeep')) * n); add(IPF.uupE, num(ustat(own, grp.unitKey, el, 'upKeep')) * n); }
            if (ready && grp.spawnKey) {
                const queued = B[q + 8] * scale, withQ = B[q + 9] * scale;
                add(IPF.queued, queued); add(IPF.withQ, withQ);
                add(IPF.qcost, queued * Math.max(1, Math.floor(num(ustat(own, grp.spawnKey, bl, 'maxEnergy')) || 1)));
                add(IPF.qreq, withQ * Math.max(1, Math.floor(num(ustat(own, grp.spawnKey, el, 'maxEnergy')) || 1)));
            }
            if (grp.type === 'house') { add(IPF.popB, Math.max(1, Math.floor(num(bstat(own, 'house', bl, 'popCap')) || 1)) * n); add(IPF.popE, Math.max(1, Math.floor(num(bstat(own, 'house', el, 'popCap')) || 1)) * n); }
            if (grp.type === 'farm' || grp.type === 'astar_farm') {
                const mb = bstat(own, grp.type, bl, 'multiplier'), me = bstat(own, grp.type, el, 'multiplier');
                add(IPF.multB, (Number.isFinite(mb) ? mb : bl) * n); add(IPF.multE, (Number.isFinite(me) ? me : el) * n);
            }
        }
        add(IPF.salvage, B[q + 10] * scale); add(IPF.autoUp, B[q + 11] * scale); add(IPF.autoStack, B[q + 12] * scale); add(IPF.queueOn, B[q + 13] * scale);
        add(IPF.buildOn, B[q + 14] * scale); add(IPF.autoRes, B[q + 15] * scale); add(IPF.researching, B[q + 16] * scale);
        add(IPF.amount, B[q + 17] * scale); add(IPF.amountMax, B[q + 18] * scale);
        if (B[q + 19] < rows[o + IPF.rallyMin]) rows[o + IPF.rallyMin] = B[q + 19];
        if (B[q + 20] > rows[o + IPF.rallyMax]) rows[o + IPF.rallyMax] = B[q + 20];
        if (bl < rows[o + IPF.lvMin]) rows[o + IPF.lvMin] = bl; if (bl > rows[o + IPF.lvMax]) rows[o + IPF.lvMax] = bl;
        if (el < rows[o + IPF.elvMin]) rows[o + IPF.elvMin] = el; if (el > rows[o + IPF.elvMax]) rows[o + IPF.elvMax] = el;
        const tk = g * 64 + (st === 0 ? el : 40 + st);
        if (!tok.has(tk)) { tok.set(tk, 1); add(IPF.tokens, 1); }
        // The standing member: of the group's largest bin.
        if (n > best[g]) {
            best[g] = n;
            const slot = B[q + 5];
            rows[o + IPF.repSlot] = slot; rows[o + IPF.repLv] = bl; rows[o + IPF.repElv] = el;
            rows[o + IPF.repStacks] = stacksC[slot]; rows[o + IPF.repMStacks] = mstacksC[slot]; rows[o + IPF.repEStacks] = estacksC[slot];
            rows[o + IPF.local] = own === localPlayer ? 1 : 0;
            rows[o + IPF.repRally] = (flagsC[slot] & 32768) ? Math.floor(rallyXC[slot] / P.tile) * 65536 + Math.floor(rallyYC[slot] / P.tile) : -1;
            repStats(rows, o, grp, own, bl, el);
        }
    }
}
// The standing member's own stats (a tower's damage, range, cooldown and
// effect; a floor item's; a barrack's unit).
function repStats(rows, o, grp, own, bl, el) {
    const sk = grp.statKey;
    rows[o + IPF.dmgB] = bstat(own, sk, bl, 'damage'); rows[o + IPF.dmgE] = bstat(own, sk, el, 'damage');
    rows[o + IPF.rangeB] = bstat(own, sk, bl, 'attackRangeArea'); rows[o + IPF.rangeE] = bstat(own, sk, el, 'attackRangeArea');
    rows[o + IPF.cdB] = bstat(own, sk, bl, 'cd'); rows[o + IPF.cdE] = bstat(own, sk, el, 'cd');
    const fx = grp.fx;
    if (fx) { rows[o + IPF.x1] = bstat(own, sk, bl, fx[0]); rows[o + IPF.x2] = bstat(own, sk, el, fx[0]); if (fx[1]) { rows[o + IPF.x3] = bstat(own, sk, bl, fx[1]); rows[o + IPF.x4] = bstat(own, sk, el, fx[1]); } }
    if (grp.kind === 'barrack') {
        const u = grp.utype;
        rows[o + IPF.uEnergy] = ustat(own, u, el, 'maxEnergy'); rows[o + IPF.uAtk] = ustat(own, u, el, 'attackDamage');
        rows[o + IPF.uRange] = ustat(own, u, el, 'attackRangeArea'); rows[o + IPF.uSpd] = ustat(own, u, el, 'speed');
    }
}

// ---- units: binned here from the frame's columns ----
// (An open table of typed arrays: a key per unit of what the sums depend
// on: group, owner, base / effective level, slowed, holding.)
let UB = null;
function unitBinsAlloc(cap) { UB = { cap, key: new Int32Array(cap).fill(-1), n: new Float64Array(cap), en: new Float64Array(cap), mx: new Float64Array(cap), wt: new Int16Array(cap), used: new Int32Array(cap), count: 0 }; }
// The pass over the selected slots: its own function, typed arrays only (a
// key fits 2^25: group, owner, base / effective level, slowed, holding).
// Returns false when the table got half full.
function unitBinPass(slots, nSlots, T, OW, BL, LV, FL, EN, MX, WT, uOf, key, cnt, en, mx, wt, used, capMask, limit) {
    let count = 0, lastK = -2, lastH = -1;
    const cap = T.length, nOf = uOf.length;
    for (let i = 0; i < nSlots; i++) {
        const s = slots[i];
        if (s < 0 || s >= cap) continue;
        const e = EN[s];
        if (!(e > 0)) continue;
        const t = T[s];
        if (t <= 0 || t >= nOf) continue;
        const g = uOf[t];
        if (g < 0) continue;
        const fl = FL[s];
        const k = ((((g * 16 + ((OW[s] + 1) & 15)) * 32 + ((BL[s] + 1) & 31)) * 32 + ((LV[s] + 1) & 31)) * 4 + ((fl >> 6) & 1) + ((fl >> 7) & 2)) * 2 + ((fl >> 3) & 1);
        // (Units next to each other are mostly alike: the last key's bin again.)
        if (k === lastK) { cnt[lastH]++; en[lastH] += e; mx[lastH] += MX[s]; continue; }
        let h = (Math.imul(k, -1640531535) >>> 7) & capMask;
        for (;;) {
            const kh = key[h];
            if (kh === k) break;
            if (kh === -1) {
                if (count >= limit) { UB.count = count; return false; }
                key[h] = k; cnt[h] = 0; en[h] = 0; mx[h] = 0; wt[h] = WT[s]; used[count++] = h;
                break;
            }
            h = (h + 1) & capMask;
        }
        cnt[h]++; en[h] += e; mx[h] += MX[s];
        lastK = k; lastH = h;
    }
    UB.count = count;
    return true;
}
let unitPassMs = 0, unitBinCount = 0;
function units(rows) {
    const tu0 = performance.now();
    const Fc = frame, uOf = groupOf.uType, slots = sel.uSlots;
    if (!UB) unitBinsAlloc(4096);
    for (;;) {
        for (let i = 0; i < UB.count; i++) UB.key[UB.used[i]] = -1;
        UB.count = 0;
        if (unitBinPass(slots, slots.length, Fc.type, Fc.owner, Fc.blevel, Fc.level, Fc.flags, Fc.energy, Fc.maxEnergy, Fc.wtype, uOf, UB.key, UB.n, UB.en, UB.mx, UB.wt, UB.used, UB.cap - 1, UB.cap >> 1)) break;
        unitBinsAlloc(UB.cap * 4);
    }
    unitPassMs = performance.now() - tu0; unitBinCount = UB.count;
    const lvlSeen = new Map();
    for (let i = 0; i < UB.count; i++) {
        const h = UB.used[i], k = UB.key[h], n = UB.n[h];
        let r = k;
        const hold = r % 2; r = (r - hold) / 2;
        const slow = r % 4; r = (r - slow) / 4;
        const lvc = r % 32; r = (r - lvc) / 32;
        const blc = r % 32; r = (r - blc) / 32;
        const own = (r % 16) - 1; const g = (r - (own + 1)) / 16;
        const grp = cat.groups[g], o = g * IPF_N, key = grp.unitKey;
        const lvl = blc - 1 >= 1 ? clampL(blc - 1) : 1, eff = lvc - 1 >= 1 ? clampL(lvc - 1) : lvl;
        // (A unit's stats: its owner's table at its effective level (sim_frame.js
        // _frameStats); the frame's maximum energy over them.)
        const baseMax = Math.max(1, Math.floor(num(ustat(own, key, eff, 'maxEnergy')) || 1));
        const effMaxAvg = Math.max(1, Math.floor(UB.mx[h] / n) || 1), ratio = (UB.en[h] / n) / effMaxAvg;
        const atk = Math.max(0, num(ustat(own, key, eff, 'attackDamage'))), cd = Math.max(1, num(ustat(own, key, eff, 'attackCooldown')) || 1);
        const spd = num(ustat(own, key, eff, 'speed')) * (slow & 1 ? 0.5 : 1) * (slow & 2 ? 0.5 : 1);
        const range = Math.max(0, Math.floor(num(ustat(own, key, eff, 'attackRangeArea')))), vis = Math.max(0, num(ustat(own, key, eff, 'visionRange')));
        const stacks = stacksForLevel(lvl);
        const add = (f, v) => { rows[o + f] += v; };
        add(IPF.n, n); add(IPF.uEnergySum, UB.en[h]); add(IPF.uMaxSum, UB.mx[h]);
        add(IPF.uBe, Math.max(1, Math.floor(baseMax * ratio)) * n); add(IPF.uBm, baseMax * n);
        add(IPF.uSt, stacks * n); add(IPF.uEst, stacks * n);
        add(IPF.uBa, atk * n); add(IPF.uEa, atk * n); add(IPF.uBd, atk / cd * cat.tickRate * n); add(IPF.uEd, atk / cd * cat.tickRate * n);
        add(IPF.uBs, spd * n); add(IPF.uEs, spd * n); add(IPF.uBr, range * n); add(IPF.uEr, range * n); add(IPF.uBv, vis * n); add(IPF.uEv, vis * n);
        add(IPF.uBu, num(ustat(own, key, lvl, 'upKeep')) * n); add(IPF.uEu, num(ustat(own, key, eff, 'upKeep')) * n);
        if (grp.type === 'scout') { add(IPF.uBw, num(ustat(own, key, lvl, 'watchDuration')) * n); add(IPF.uEw, num(ustat(own, key, eff, 'watchDuration')) * n); }
        const wtype = strings[UB.wt[h]] || '', wk = cat.workStat[wtype];
        if (wk) { add(IPF.uWork, num(ustat(own, key, eff, wk) || ustat(own, key, lvl, wk)) * n); add(IPF.uEwork, num(ustat(own, key, eff, wk)) * n); }
        if (wk || wtype === 'salvager') { add(IPF.uTcd, num(ustat(own, key, lvl, 'transferCooldownSec')) * n); add(IPF.uEtcd, num(ustat(own, key, eff, 'transferCooldownSec')) * n); }
        if (wtype === 'salvager') { add(IPF.uSl, lvl * n); add(IPF.uEsl, eff * n); }
        if (hold) add(IPF.uHold, n);
        if (lvl < rows[o + IPF.lvMin]) rows[o + IPF.lvMin] = lvl; if (lvl > rows[o + IPF.lvMax]) rows[o + IPF.lvMax] = lvl;
        if (eff < rows[o + IPF.elvMin]) rows[o + IPF.elvMin] = eff; if (eff > rows[o + IPF.elvMax]) rows[o + IPF.elvMax] = eff;
        // (Units: repSlot holds their worker kind's string code, for the page's rows.)
        if (!lvlSeen.has(g)) { lvlSeen.set(g, 1); rows[o + IPF.repSlot] = UB.wt[h]; }
    }
}

// ---- the rows' text (the page writes it as it is) ----
// (The formatters of utils_common.js / things_utils.js / hud.js, the same
// rules; the main panel's big numbers with a suffix from 1000 on.)
const IPS_SUFFIXES = ['', 'K', 'M', 'B', 'T', 'Qa', 'Qi', 'Sx', 'Sp', 'Oc', 'No', 'Dc'];
function fmt(n, d = 1, suffixStart = 1000) {
    if (n == null) return '...';
    if (typeof n === 'string') return n;
    if (!Number.isFinite(n)) return '' + n;
    const decimals = Math.max(1, Math.floor(Number.isFinite(d) ? d : 1)), sign = n < 0 ? '-' : '', abs = Math.abs(n);
    if (abs < suffixStart) return sign + abs.toFixed(decimals);
    let tier = Math.floor(Math.log10(abs) / 3);
    if (tier >= IPS_SUFFIXES.length) return sign + 'e' + Math.floor(Math.log10(abs));
    let scaled = abs / Math.pow(1000, tier), rounded = Number(scaled.toFixed(decimals));
    if (rounded >= 1000 && tier < IPS_SUFFIXES.length - 1) { tier++; scaled = rounded / 1000; rounded = Number(scaled.toFixed(decimals)); }
    return sign + rounded.toFixed(decimals) + IPS_SUFFIXES[tier];
}
const fmtArea = v => Number.isFinite(v) ? Math.floor(Math.max(0, v) + 1e-9) + 'a' : '-';
const fmtRange = v => Number.isFinite(v) ? fmtArea(v / cat.areaUnit) : '-';
const fmtStacks = (s, allowZero = false) => Math.max(allowZero ? 0 : 1, Number(s) || (allowZero ? 0 : 1)).toFixed(1);
const fmtFrac = (a, b, d = 0) => fmt(a, d) + '/​' + fmt(b, d);
const stackLevel = s => Math.max(1, Math.min(cat.maxLevel, Math.floor(Math.log2(Math.max(1, s || 1))) + 1));
// A group's text, or null when absent: { t (title), mixed, hl, he, hs, pot
// (a pending target level, 0 none), stacksRem, qcost, ptext, v (per row of
// the group, in its row order: show, base, eff) }.
function groupText(g, R) {
    const grp = cat.groups[g], o = g * IPF_N, f = k => R[o + IPF[k]], n = f('n');
    if (!(n > 0)) return null;
    const count = Math.round(n), out = { t: (count > 1 ? count + 'x ' : '') + grp.label + ' ', mixed: 0, hl: '', he: '', hs: '', pot: 0, stacksRem: '', qcost: '', ptext: '', v: null };
    const rows = {};
    const row = (id, show, b, e) => { rows[id] = [show ? 1 : 0, b === undefined || b === null ? '' : String(b), e === undefined || e === null ? '' : String(e)]; };
    row('count', true, String(count));
    if (grp.kind === 'mine') {
        const max = Math.round(f('amountMax'));
        row('amount', true, fmtFrac(Math.floor(f('amount')), max));
        row('remaining', true, (max > 0 ? Math.round(f('amount') / max * 100) : 0) + '%');
    } else if (grp.kind === 'unit') {
        const c = Math.max(1, count), lmin = f('lvMin'), lmax = f('lvMax'), emin = f('elvMin'), emax = f('elvMax'), mixed = emin !== emax || lmin !== lmax, hold = f('uHold');
        out.mixed = mixed ? 1 : 0; out.hl = mixed ? '' : 'L' + lmin; out.he = mixed || emin === lmin ? '' : ' L' + emin;
        row('status', true, hold > 0 ? Math.round(hold) + ' holding, ' + Math.round(count - hold) + ' free' : count + ' free');
        row('uenergy', true, fmtFrac(Math.floor(f('uBe')), f('uBm')));
        row('ulevel', true, lmin === lmax ? 'L' + lmin : 'L' + lmin + '-L' + lmax, emin === emax ? 'L' + emin : 'Mixed');
        row('ustacks', true, fmtStacks(f('uSt')), fmtStacks(f('uEst')));
        row('uupkeep', true, fmt(f('uBu'), 2));
        row('urange', true, fmtArea(Math.round(f('uBr') / c)) + ' avg', fmtArea(Math.round(f('uEr') / c)) + ' avg');
        row('uvis', true, fmtRange(f('uBv') / c) + ' avg', fmtRange(f('uEv') / c) + ' avg');
        row('uwatch', true, (f('uBw') / c).toFixed(1) + 's avg', (f('uEw') / c).toFixed(1) + 's avg');
        const wt = strings[f('repSlot')] || '', work = !!cat.workStat[wt], salv = wt === 'salvager';
        row('uwork', work, fmt(f('uWork'), 1) + '⚡', fmt(f('uEwork'), 1) + '⚡');
        row('usalv', salv, '10% x SumL' + Math.round(f('uSl')), '10% x SumL' + Math.round(f('uEsl')));
        row('utcd', work || salv, (f('uTcd') / c).toFixed(2) + 's avg', (f('uEtcd') / c).toFixed(2) + 's avg');
        row('uatk', !work && !salv, fmt(f('uBa'), 1), fmt(f('uEa'), 1));
        row('udps', !work && !salv, f('uBd').toFixed(1), f('uEd').toFixed(1));
        row('uspd', true, (f('uBs') / c).toFixed(1) + ' avg', (f('uEs') / c).toFixed(1) + ' avg');
        row('umixed', emin !== emax, 'Mixed (L' + emin + '-L' + emax + ')');
        row('immune', true, grp.immune || '');
    } else {
        const mixed = f('tokens') > 1, bl = f('repLv'), el = f('repElv'), st = f('repStacks'), est = f('repEStacks');
        out.mixed = mixed ? 1 : 0; out.hl = mixed ? '' : (f('uc') >= n ? 'L0' : 'L' + bl); out.he = mixed || el === bl ? '' : ' L' + el;
        out.hs = est > 0 && st > 0 && est !== st ? ' S' + est : '';
        const parts = [], ready = f('ready') - f('upg') - f('stacking');
        if (ready > 0) parts.push(Math.round(ready) + ' ready');
        if (f('uc') > 0) parts.push(Math.round(f('uc')) + ' building');
        if (f('upg') > 0) parts.push(Math.round(f('upg')) + ' upgrading');
        if (f('stacking') > 0) parts.push(Math.round(f('stacking')) + ' stacking');
        if (f('researching') > 0) parts.push(Math.round(f('researching')) + ' researching');
        row('status', true, parts.join(', '));
        const cur = Math.floor(f('energy'));
        row('energy', true, fmtFrac(cur, Math.max(1, Math.floor(f('trig')))), fmtFrac(cur, Math.max(1, Math.floor(f('effMax')))));
        const lmin = f('lvMin'), lmax = f('lvMax'), emin = f('elvMin'), emax = f('elvMax');
        row('level', true, lmin === lmax ? 'L' + lmin : 'L' + lmin + '-L' + lmax, emin === emax ? 'L' + emin : 'L' + emin + '-L' + emax);
        const ms = f('repMStacks'), pot = ms > st && ms > 0 ? stackLevel(ms) : 0;
        if (pot > Math.max(bl, el)) out.pot = pot;
        const stacked = Math.max(1, st || 1), manual = Math.max(stacked, ms || stacked), rem = Math.max(0, manual - stacked);
        row('stacks', true, fmtStacks(stacked), fmtStacks(est > 0 ? est : stacked));
        out.stacksRem = rem > 0 ? fmtStacks(rem, true) : '';
        row('vis', true, fmtRange(f('visB') / n) + ' avg', fmtRange(f('visE') / n) + ' avg');
        row('upkeep', true, fmt(f('upB'), 2), fmt(f('upE'), 2));
        const local = f('local') > 0;
        if (grp.kind === 'barrack') {
            row('uen', true, Number.isFinite(f('uEnergy')) ? Math.floor(f('uEnergy')) : '?');
            row('uup', true, fmt(f('uupB'), 2));
            row('uatk1', true, Number.isFinite(f('uAtk')) ? Math.floor(f('uAtk')) : '?');
            row('urng1', true, fmtArea(Number(f('uRange')) || 0));
            row('uspd1', true, Number.isFinite(f('uSpd')) ? f('uSpd').toFixed(2) : '?');
            const rk = f('repRally');
            row('rally', local, rk >= 0 ? '(' + Math.floor(rk / 65536) + ',' + (rk % 65536) + ')' : 'None');
        } else if (grp.kind === 'tower') {
            const dB = f('dmgB'), dE = f('dmgE'), cB = f('cdB'), cE = f('cdE');
            row('damage', true, fmt(Number.isFinite(dB) ? dB : dE, 1), fmt(dE, 1));
            row('range', true, fmtArea(f('rangeB')), fmtArea(f('rangeE')));
            row('cooldown', true, (cB || 0).toFixed(2) + 's', (cE || 0).toFixed(2) + 's');
            row('dps', true, cB > 0 ? (dB / cB).toFixed(1) : '0', cE > 0 ? (dE / cE).toFixed(1) : '0');
            row('ldps', true, ((dE || 0) / 60 * cat.tickRate).toFixed(1) + '/s');
            if (grp.fx) grp.fx.forEach((fx, k) => { const v = f(k === 0 ? 'x2' : 'x4'); row('fx_' + fx, Number.isFinite(v), /Dps$/.test(fx) ? (v * cat.tickRate).toFixed(2) + '/s' : (v || 0).toFixed(1) + 's'); });
            row('value', true, '⚡' + fmt(grp.price || '?'));
        } else if (grp.kind === 'spawner' || grp.kind === 'research') {
            row('wup', true, fmt(f('uupB'), 2), fmt(f('uupE'), 2));
            row('owner', true, local ? 'You' : 'Enemy');
            row('value', true, '⚡' + fmt(grp.price || '?'));
            const rmin = f('rallyMin'), rmax = f('rallyMax');
            row('rally', local, rmin !== rmax ? 'Mixed' : rmin < 0 || rmin >= 1e18 ? 'None' : '(' + Math.floor(rmin / 65536) + ',' + (rmin % 65536) + ')');
        } else {
            const dB = f('dmgB'), dE = f('dmgE');
            if (grp.type === 'mine') row('fdmg', dE > 0, Math.floor(dB), Math.floor(dE));
            else if (grp.fx) {
                const b1 = f('x1'), e1 = f('x2'), b2 = f('x3'), e2 = f('x4');
                row('fdps', dE > 0, ((Number.isFinite(b1) ? b1 : dB) * cat.tickRate).toFixed(2) + '/s', ((Number.isFinite(e1) ? e1 : dE) * cat.tickRate).toFixed(2) + '/s');
                row('fdur', dE > 0 && (Number.isFinite(b2) || Number.isFinite(e2)), (b2 || 0).toFixed(1) + 's', (e2 || 0).toFixed(1) + 's');
            } else row('fdmg', dE > 0, (dB || 0).toFixed(2), (dE || 0).toFixed(2));
            row('effect', true, { sand: '50% slow', ice_patch: '50% slow + freeze', water_puddle: 'Soak (ice combo)' }[grp.type] || '');
            row('mult', true, (f('multB') / n).toFixed(2) + 'x Work Speed', (f('multE') / n).toFixed(2) + 'x Work Speed');
            row('pop', true, '+' + fmt(Math.round(f('popB'))), '+' + fmt(Math.round(f('popE'))));
            row('value', true, '⚡' + fmt(grp.price || '?'));
        }
        if (local && (grp.kind === 'barrack' || grp.kind === 'spawner' || grp.kind === 'research')) {
            out.qcost = '≈⚡' + fmt(f('qcost'), 0);
            const req = f('qreq');
            out.ptext = req > 0 ? '⚡0/⚡' + fmt(req, 0) : '⚡0/⚡0';
        }
    }
    const v = [];
    for (const id of grp.rowIds) { const r = rows[id]; v.push(r ? r[0] : 0, r ? r[1] : '', r ? r[2] : ''); }
    out.v = v;
    return out;
}

// ---- box selection (renderer.js get3DBoxSelection, main.js _ownUnitsInBox) ----
// The player's units and structures (and every mine: the page checks those
// it sees) inside the box. 3D: a thing counts when its ground point or its
// top (its model's height above) is drawn inside the screen box, or the line
// between them crosses it (a tall model up close); 2D: its point in the world
// rectangle. m: { id, mode '3d' | '2d', vp (16), alpha, w, h, pad, rect
// [minX, minY, maxX, maxY] (screen px; 2D: world px), me, tile }.
const BOX_LIFT = [0.18, 0.12, 0.14, 0.08, 0.06, 0.06], BOX_TOP = [0.9, 0.7, 0.7, 0.2, 0.3, 0.3], UNIT_LIFT = 0.28, UNIT_TOP = 0.9;
// (A segment p-q against the box, Liang-Barsky.)
function segHitsBox(px, py, qx, qy, x0, y0, x1, y1) {
    let t0 = 0, t1 = 1;
    const dx = qx - px, dy = qy - py;
    const P0 = -dx, P1 = dx, P2 = -dy, P3 = dy, Q0 = px - x0, Q1 = x1 - px, Q2 = py - y0, Q3 = y1 - py;
    const clip = (p, q) => {
        if (p === 0) return q >= 0;
        const r = q / p;
        if (p < 0) { if (r > t1) return false; if (r > t0) t0 = r; } else { if (r < t0) return false; if (r < t1) t1 = r; }
        return true;
    };
    return clip(P0, Q0) && clip(P1, Q1) && clip(P2, Q2) && clip(P3, Q3);
}
function boxSelect(m) {
    const t0 = performance.now(), F = frame, it = 1 / m.tile, me = m.me, flat = m.mode === '2d';
    const minX = m.rect[0], minY = m.rect[1], maxX = m.rect[2], maxY = m.rect[3];
    const VP = m.vp || [], W = m.w, H = m.h, pad = m.pad;
    let sx = 0, sy = 0;
    // (A world point at a lift on the screen, into sx, sy; false behind the eye.)
    const proj = (wx, lift, wz) => {
        const cw = VP[3] * wx + VP[7] * lift + VP[11] * wz + VP[15];
        if (!(cw > 0)) return false;
        sx = ((VP[0] * wx + VP[4] * lift + VP[8] * wz + VP[12]) / cw * 0.5 + 0.5) * W - pad;
        sy = (1 - ((VP[1] * wx + VP[5] * lift + VP[9] * wz + VP[13]) / cw * 0.5 + 0.5)) * H - pad;
        return true;
    };
    const inBox = (x, y) => x >= minX && x <= maxX && y >= minY && y <= maxY;
    const hit3d = (wx, wz, lift, top) => {
        const a = proj(wx, lift, wz), ax = sx, ay = sy;
        if (a && inBox(ax, ay)) return true;
        const b = proj(wx, top, wz), bx = sx, by = sy;
        if (b && inBox(bx, by)) return true;
        return a && b && segHitsBox(ax, ay, bx, by, minX, minY, maxX, maxY);
    };
    let units = new Int32Array(0), nu = 0;
    if (F && F.x) {
        const n = F.x.length, O = F.owner, ID = F.id, X = F.x, Y = F.y, PX = F.px, PY = F.py, a = m.alpha;
        units = new Int32Array(n);
        for (let s = 0; s < n; s++) {
            if (O[s] !== me || ID[s] < 0) continue;
            const ux = PX[s] + (X[s] - PX[s]) * a, uy = PY[s] + (Y[s] - PY[s]) * a;
            if (flat ? inBox(ux, uy) : hit3d(ux * it, uy * it, UNIT_LIFT, UNIT_TOP)) units[nu++] = s;
        }
    }
    let structs = new Int32Array(0), ns = 0, mines = new Int32Array(0), nm = 0;
    const buf = mem && P ? mem.buffer : null, hdr = buf ? new Uint32Array(buf, P.at.hdr, 4) : null;
    const base = hdr ? Atomics.load(hdr, 0) : 0, cap = hdr ? Atomics.load(hdr, 1) : 0;
    if (base > 0 && cap > 0) {
        const c = tableCols(base, cap);
        const alive = new Uint8Array(buf, c.alive, cap), kind = new Int16Array(buf, c.kind, cap), owner = new Int16Array(buf, c.owner, cap);
        const en = new Float32Array(buf, c.energy, cap), X = new Float32Array(buf, c.x, cap), Y = new Float32Array(buf, c.y, cap);
        structs = new Int32Array(cap); mines = new Int32Array(cap);
        for (let s = 0; s < cap; s++) {
            if (alive[s] !== 1) continue;
            const k = kind[s];
            if (k > 5) continue;
            const mine = k === 4 || k === 5;
            if (!mine && (owner[s] !== me || (k <= 2 && !(en[s] > 0)))) continue;
            if (!(flat ? inBox(X[s], Y[s]) : hit3d(X[s] * it, Y[s] * it, BOX_LIFT[k], BOX_TOP[k]))) continue;
            if (mine) mines[nm++] = s; else structs[ns++] = s;
        }
    }
    const u = units.slice(0, nu), st = structs.slice(0, ns), mi = mines.slice(0, nm);
    self.postMessage({ type: 'box', id: m.id, units: u, structs: st, mines: mi, ms: performance.now() - t0 }, [u.buffer, st.buffer, mi.buffer]);
}

// ---- a selection's unit ids for orders (hud.js _slotUnitIds), made when it
// changes: every live unit's, the combat units', the workers', and their
// wire strings (id_codec.js actionIdsEncode; every peer decodes the same) ----
function selectionIds(seq) {
    if (!sel || !sel.uSlots || !frame || !frame.id) return;
    const slots = sel.uSlots, ID = frame.id, WT = frame.wtype, EN = frame.energy, n = slots.length, cap = ID.length;
    const all = new Int32Array(n), combat = new Int32Array(n), workers = new Int32Array(n);
    let na = 0, nc = 0, nw = 0;
    for (let i = 0; i < n; i++) {
        const s = slots[i];
        if (s < 0 || s >= cap) continue;
        const id = ID[s];
        if (id < 0 || !(EN[s] > 0)) continue;
        all[na++] = id;
        if (WT[s] === 0) combat[nc++] = id; else workers[nw++] = id;
    }
    const a = all.slice(0, na), c = combat.slice(0, nc), w = workers.slice(0, nw);
    // (In the order split's pieces, worker.js _queueLocalAction: each piece's string.)
    const chunk = cat.idsChunk || 20000;
    const enc = x => { if (x.length < 64 || typeof actionIdsEncode !== 'function') return null; const out = []; for (let i = 0; i < x.length; i += chunk) { const p = x.subarray(i, i + chunk); out.push(p.length >= 64 ? actionIdsEncode(p) : null); } return out; };
    self.postMessage({ type: 'ids', seq, all: a, combat: c, workers: w, allZ: enc(a), combatZ: enc(c), workersZ: enc(w) }, [a.buffer, c.buffer, w.buffer]);
}
