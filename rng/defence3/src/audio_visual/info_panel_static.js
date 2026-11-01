'use strict';
// The info panel, static: one element per thing type (a King's, a Fast
// Brk's, an Energy Farm's...) made once at the match's start from one
// markup string, each with all its rows; a refresh shows the types in the
// selection, hides the rest and writes each row's value (text written only
// when it changed). Every number comes from the packer thread
// (info_pack_worker.js: the selection binned and summed from the
// structure table and stat tables in the wasm heap and the frame's unit
// columns, all shared memory): the page formats and writes them, nothing
// else. The research block and the player status: info_research_static.js.

// ---- the packer ----
const INFO_PACK_URL = './src/audio_visual/info_pack_worker.js?v=20261101-f';
// state: 0 off, 1 asked, 2 ready, -1 none (no simulation worker: the in-page
// simulation draws the old panel, see infoPanelStaticActive).
const _ipk = { state: 0, worker: null, seq: 0, rows: null, rowsSeq: -1, ms: 0, sent: null };
function _ipkSentReset() { _ipk.sent = { ents: null, entsLen: -1, units: null, unitsLen: -1, frame: null, strings: -1, local: null }; }
_ipkSentReset();
function infoPackMatchStarted() {
    if (_ipk.worker) { try { _ipk.worker.terminate(); } catch { } }
    _ipk.worker = null; _ipk.rows = null; _ipk.rowsSeq = -1; _ipkSentReset();
    _ipk.state = typeof simClientInfoPackAsk === 'function' && simClientInfoPackAsk() ? 1 : -1;
}
function infoPackOnPayload(pack) {
    if (_ipk.state !== 1) return;
    if (!pack || (pack.wasm && pack.wasm.w64)) { _ipk.state = -1; return; }
    try {
        if (!_ips.cat) { _ipk.state = -1; return; }
        const w = new Worker(INFO_PACK_URL);
        w.onmessage = ev => _infoPackMsg(ev.data || {});
        w.onerror = ev => { _ipk.state = -1; console.warn('[info pack]', ev && ev.message); };
        _ips.cat.wire.localPlayer = localPlayerId;
        w.postMessage({ type: 'init', pack, cat: _ips.cat.wire });
        _ipk.worker = w;
    } catch (err) { _ipk.state = -1; }
}
function infoPackOnStats(dir) { if (_ipk.worker) _ipk.worker.postMessage({ type: 'stats', dir }); }
function _infoPackMsg(m) {
    if (m.type === 'ready') { _ipk.state = 2; _infoPanelNudge(); }
    else if (m.type === 'error') console.warn('[info pack]', m.message);
    else if (m.type === 'box') _infoPackBoxDone(m);
    else if (m.type === 'sum') { _ipkSum.units = m.units; _ipkSum.structs = m.structs; _ipkSum.n = m.n; _ipkSum.owners = m.owners; _ipkSum.version++; _ipkSum.byOwner.clear(); }
    else if (m.type === 'ids' && m.seq === _ipk.seq) _infoPackIds(m);
    else if (m.type === 'out' && m.seq === _ipk.seq) {
        _ipk.rows = m.rows; _ipk.texts = m.texts; _ipk.rowsSeq = m.seq; _ipk.ms = m.ms;
        // (Written at once: a few hundred text nodes at most.)
        if (_ips.panel && _ips.active) _ipsApply(_ips.panel);
    }
}
// Every player's counts by type from the packer (info_pack_worker.js
// summarize, every 250 ms): hud.js getFrameUnitSummary / getFrameBuildingSummary
// read them through infoPackUnitSummary / infoPackBuildingSummary.
const _ipkSum = { units: null, structs: null, n: 0, owners: 0, version: 0, byOwner: new Map() };
function _ipkSumReady(owner) { return _ipk.state === 2 && _ipkSum.units !== null && owner + 1 >= 0 && owner + 1 < _ipkSum.owners; }
// owner -> Map(unit type -> {label, total, idle}), or null (no counts yet).
function infoPackUnitSummary(owner) {
    if (!_ipkSumReady(owner)) return null;
    const S = _ipkSum, key = 'u' + owner;
    let groups = S.byOwner.get(key);
    if (groups) return groups;
    groups = new Map();
    const strings = _pageFrameStrings, n = S.n, U = S.units, base = (owner + 1) * n * 2;
    for (let t = 0; t < n; t++) if (U[base + t * 2]) { const k = strings[t] || 'other'; groups.set(k, { label: _prettyUnitTypeLabel(k), total: U[base + t * 2], idle: U[base + t * 2 + 1] }); }
    S.byOwner.set(key, groups);
    return groups;
}
// owner -> {groups (tower:<type>, barrack:<unit type>, <type>), stats (barrack_<unit type>, <type>), total, idle}, or null.
function infoPackBuildingSummary(owner) {
    if (!_ipkSumReady(owner)) return null;
    const S = _ipkSum, key = 'b' + owner;
    let v = S.byOwner.get(key);
    if (v) return v;
    const strings = _pageFrameStrings, n = S.n, C = S.structs, groups = new Map(), stats = new Map();
    let total = 0, idle = 0;
    for (let cls = 0; cls < 3; cls++) {
        const base = ((owner + 1) * 3 + cls) * n * 2;
        for (let t = 0; t < n; t++) {
            const a = C[base + t * 2];
            if (!a) continue;
            const b = C[base + t * 2 + 1], type = strings[t] || '', statsKey = cls === 1 ? 'barrack_' + type : type, gk = cls === 1 ? 'barrack:' + type : cls === 0 ? 'tower:' + type : type || 'unknown';
            let g = groups.get(gk); if (!g) groups.set(gk, g = { label: getBuildingDisplayName(statsKey), total: 0, idle: 0 });
            let st = stats.get(statsKey); if (!st) stats.set(statsKey, st = { total: 0, idle: 0 });
            g.total += a; g.idle += b; st.total += a; st.idle += b; total += a; idle += b;
        }
    }
    v = { groups, stats, total, idle };
    S.byOwner.set(key, v);
    return v;
}
function _infoPanelNudge() { if (typeof _infoPanelNextRefreshAt !== 'undefined') _infoPanelNextRefreshAt = 0; }
// What the packer reads changed: the selection's slots (made when it
// changes, transferred), the frame's columns (shared buffers, by reference),
// the string codes, the player.
function _infoPackSync() {
    if (_ipk.state !== 2) return;
    const S = _ipk.sent, w = _ipk.worker;
    const strings = typeof _pageFrameStrings !== 'undefined' ? _pageFrameStrings : null;
    if (strings && strings.length !== S.strings) { w.postMessage({ type: 'strings', list: strings.slice() }); S.strings = strings.length; }
    if (S.local !== localPlayerId) { w.postMessage({ type: 'local', player: localPlayerId }); S.local = localPlayerId; }
    const F = typeof simClientCurrentUnitVis === 'function' ? simClientCurrentUnitVis() : null;
    if (F && F.buf !== S.frame) {
        S.frame = F.buf;
        w.postMessage({ type: 'frame', cols: { type: F.type, owner: F.owner, blevel: F.blevel, level: F.level, flags: F.flags, energy: F.energy, maxEnergy: F.maxEnergy, wtype: F.wtype, wstate: F.wstate, cmd: F.cmd, x: F.x, y: F.y, px: F.px, py: F.py, id: F.id } });
    }
    const ents = selectedEntities, us = selectedUnits;
    if (S.ents === ents && S.entsLen === ents.length && S.units === us && S.unitsLen === us.length) return;
    S.ents = ents; S.entsLen = ents.length; S.units = us; S.unitsLen = us.length;
    let n = 0;
    const sl = new Int32Array(ents.length), se = new Int32Array(ents.length);
    for (const e of ents) if (e && e._structView && e._s >= 0) { sl[n] = e._s; se[n] = e._serial; n++; }
    const X = typeof selectionIndex === 'function' ? selectionIndex() : null;
    const ul = X && X.framed ? X.slots.slice(0, X.n) : new Int32Array(0);
    _ipk.seq++;
    const a = sl.slice(0, n), b = se.slice(0, n);
    w.postMessage({ type: 'sel', seq: _ipk.seq, sSlots: a, sSers: b, uSlots: ul }, [a.buffer, b.buffer, ul.buffer]);
}

// ---- the catalogue: every thing type the panel can show ----
const IPS_SPAWNER_UNIT = { spawner: 'collector', astar_spawner: 'astar_collector', builder_spawner: 'builder_unit', healer_spawner: 'healer_unit', salvager: 'salvager_unit', research: 'researcher_unit' };
const IPS_FX = { fire: ['burnDps', 'burnDuration'], poison: ['poisonDps', 'poisonDuration'], ice: ['freezeDps', 'freezeDuration'], water: ['wetDuration'], sand_gun: ['sandDuration'], watch_tower: ['watchDuration'],
    lava: ['burnDps', 'burnDuration'], poison_puddle: ['poisonDps', 'poisonDuration'], ice_patch: ['freezeDps', 'freezeDuration'] };
const IPS_FX_LABEL = { burnDps: 'Burn DPS', burnDuration: 'Burn Duration', poisonDps: 'Poison DPS', poisonDuration: 'Poison Duration', freezeDps: 'Freeze DPS', freezeDuration: 'Freeze Duration',
    wetDuration: 'Wet Duration', sandDuration: 'Slow Duration', watchDuration: 'Watch Duration' };
function _ipsCatalogue() {
    const groups = [], towers = (typeof BUILD_CATEGORIES !== 'undefined' && BUILD_CATEGORIES.towers) || [];
    const bkey = t => _normalizePlayerPrecomputedBuildingKey(t), ukey = t => _normalizePlayerPrecomputedUnitKey(t);
    const price = t => (BASE_CARD_TYPES[t] || {}).price;
    for (const t of Object.keys(BASE_CARD_TYPES)) {
        if (t.startsWith('barrack_')) {
            const u = t.slice(8);
            groups.push({ key: t, kind: 'barrack', type: 'barrack', utype: u, label: getBuildingDisplayName(t), thumb: t, statKey: normalizeBuildingResearchKey(t), upkeepKey: bkey('barrack'),
                unitKey: ukey(u), spawnKey: ukey(u), desc: DESCRIPTIONS[t] || 'Trains units for combat.' });
        } else if (towers.includes(t)) {
            groups.push({ key: 'tower_' + t, kind: 'tower', type: t, label: getBuildingDisplayName(t), thumb: t, statKey: normalizeBuildingResearchKey(t), upkeepKey: bkey(t), fx: IPS_FX[t] || null,
                price: price(t), desc: DESCRIPTIONS[t] || 'Defensive tower.' });
        } else if (IPS_SPAWNER_UNIT[t]) {
            const w = IPS_SPAWNER_UNIT[t];
            groups.push({ key: t, kind: t === 'research' ? 'research' : 'spawner', type: t, label: getBuildingDisplayName(t), thumb: t, statKey: normalizeBuildingResearchKey(t), upkeepKey: bkey(t),
                unitKey: ukey(w), workerType: w, spawnKey: ukey(getSpawnerFallbackUnitType({ type: t })), price: price(t),
                desc: t === 'research' ? (DESCRIPTIONS.research || 'Runs queued research projects.') : (DESCRIPTIONS[t] || 'Spawns worker units.') });
        } else {
            groups.push({ key: 'floor_' + t, kind: 'floor', type: t, label: getBuildingDisplayName(t), thumb: t, statKey: normalizeBuildingResearchKey(t), upkeepKey: bkey(t), fx: IPS_FX[t] || null,
                price: price(t), desc: DESCRIPTIONS[t] || 'Placed floor item.' });
        }
    }
    groups.push({ key: 'goldmine', kind: 'mine', type: 'goldmine', gold: true, label: 'Energy Mine', thumb: 'goldmine', desc: 'Natural energy deposit. Send ⚡ collectors to gather.' });
    groups.push({ key: 'astarmine', kind: 'mine', type: 'astarmine', gold: false, label: '★ Mine', thumb: 'astarmine', desc: 'Natural ★ deposit. Send ★ collectors to gather.' });
    for (const u of Object.keys(BASE_UNIT_STATS)) {
        const s = BASE_UNIT_STATS[u] || {}, imm = [];
        if (s.fireResistant) imm.push('Fire'); if (s.poisonResistant) imm.push('Poison'); if (s.waterResistant) imm.push('Water');
        if (s.iceResistant) imm.push('Ice'); if (s.laserResistant) imm.push('Laser'); if (s.turretImmune) imm.push('Towers'); if (s.isFlying) imm.push('Walls');
        groups.push({ key: 'unit_' + u, kind: 'unit', type: u, label: getUnitDisplayName(u), thumb: u, unitKey: ukey(u), immune: imm.join(', '), desc: getUnitDescription(u) });
    }
    const wire = { groups: groups.map(g => ({ key: g.key, kind: g.kind, type: g.type, utype: g.utype, statKey: g.statKey, upkeepKey: g.upkeepKey, unitKey: g.unitKey, spawnKey: g.spawnKey, fx: g.fx,
            label: g.label, price: g.price, immune: g.immune, gold: g.gold, rowIds: null })),
        towers, spawners: Object.keys(IPS_SPAWNER_UNIT), maxLevel: MAX_THING_LEVEL, areaStepsMax: AREA_STEPS_MAX, areaUnit: AREA_UNIT_TILE_EQUIVALENT, tickRate: TICK_RATE,
        idsChunk: typeof ACTION_MAX_UNIT_IDS === 'number' ? ACTION_MAX_UNIT_IDS : 20000, localPlayer: localPlayerId, workStat: { builder: 'builderDps', healer: 'healerDps', researcher: 'researcherDps', collector: 'gatherPerTrip', astar_collector: 'gatherPerTrip' } };
    return { groups, wire };
}

// ---- rows: fixed per group (labels and matrix buttons made once) ----
// A row: { id, l (label), m (matrix options), two (base and effective columns), unit (a rate) }.
function _ipsRowsOf(g) {
    const R = [], mx = (title, kind, key, statKey) => ({ title, kind, key, statKey });
    const add = (id, l, two = false, m = null, unit = false) => R.push({ id, l, two, m, unit });
    add('count', 'Count');
    add('status', 'Status');
    if (g.kind === 'mine') { add('amount', g.gold ? 'Energy' : '★'); add('remaining', 'Remaining'); return R; }
    if (g.kind === 'unit') {
        const t = g.type;
        add('uenergy', 'Energy'); add('ulevel', 'Level', true); add('ustacks', 'Stacks', true);
        add('uupkeep', 'UpKeep', false, mx(`${t} / UpKeep`, 'unit', t, 'upKeep'), true);
        add('urange', 'Range', true, mx(`${t} / Range`, 'unit', t, 'attackRange')); add('uvis', 'Visibility', true, mx(`${t} / Visibility`, 'unit', t, 'visionRange'));
        if (t === 'scout') add('uwatch', 'Watch Duration', true, mx(`${t} / Watch Duration`, 'unit', t, 'watchDuration'));
        add('uwork', 'Work Speed', true, mx(`${t} / Work Speed`, 'unit', t, 'builderDps')); add('usalv', 'Salvage Yield', true);
        add('utcd', 'Transfer CD', true, mx(`${t} / Transfer CD`, 'unit', t, 'transferCooldown'));
        add('uatk', 'Attack', true, mx(`${t} / Attack`, 'unit', t, 'atk'));
        add('udps', 'DPS', true, { title: `${t} / DPS`, getValue: (thingLevel, researchLevel) => {
            const atk = getUnitStatFromMap(t, thingLevel, 'atk', researchLevel), cd = getUnitStatFromMap(t, thingLevel, 'atkCd', researchLevel);
            return !Number.isFinite(atk) || !Number.isFinite(cd) || cd <= 0 ? '0' : formatBigNumber(atk / cd * TICK_RATE, 1);
        } });
        add('uspd', 'Speed', true, mx(`${t} / Speed`, 'unit', t, 'speed')); add('umixed', 'Levels (Eff)');
        if (g.immune) add('immune', 'Immune');
        return R;
    }
    const t = g.type, mk = g.kind === 'barrack' ? 'barrack' : t;
    add('energy', 'Energy', true);
    add('level', 'Level', true, { title: `${mk} / Level`, getValue: (thingLevel, researchLevel) => { const v = _ipsRepView(g.i); return v ? getInfoPanelLevelMatrixEnergyText(v, thingLevel, researchLevel) : ''; } });
    add('maxlevel', 'Max Level', false, mx(`${mk} / Max Level`, 'building', mk, 'maxLevel'));
    add('stacks', 'Stacks', true, { title: 'Stacks', getValue: (thingLevel) => `x${getRequiredStacksForLevel(Math.max(1, Math.floor(Number(thingLevel) || 1)))}` });
    if (g.kind !== 'tower') add('vis', 'Visibility', true);
    add('upkeep', 'UpKeep', true, mx(`${mk} / UpKeep`, 'building', mk, 'upKeep'), true);
    if (g.kind === 'barrack') {
        const u = g.utype;
        add('uen', 'Unit Energy'); add('uup', 'Unit UpKeep', false, mx(`${u} / UpKeep`, 'unit', u, 'upKeep'), true);
        add('uatk1', 'Unit Atk'); add('urng1', 'Unit Range'); add('uspd1', 'Unit Spd'); add('rally', 'Rally');
    } else if (g.kind === 'tower') {
        add('damage', 'Damage', true);
        if (t !== 'laser') { add('range', 'Range', true, mx(`${t} / Range`, 'building', t, 'attackRange')); add('vis', 'Visibility', true); add('cooldown', 'Cooldown', true); add('dps', 'DPS', true); }
        else { add('ldps', 'DPS'); add('vis', 'Visibility', true); }
        if (g.fx) for (const f of g.fx) add('fx_' + f, IPS_FX_LABEL[f]);
        add('value', 'Value'); add('rally', 'Rally');
    } else if (g.kind === 'spawner' || g.kind === 'research') {
        add('wup', 'Worker UpKeep', true, mx(`${g.workerType} / UpKeep`, 'unit', g.workerType, 'upKeep'), true);
        if (g.kind === 'spawner') { add('owner', 'Owner'); add('value', 'Value'); } else add('rally', 'Rally');
    } else {
        if (t === 'mine') add('fdmg', 'Explode Dmg', true);
        else if (g.fx) { add('fdps', IPS_FX_LABEL[g.fx[0]], true); if (g.fx[1]) add('fdur', IPS_FX_LABEL[g.fx[1]], true); }
        else add('fdmg', 'Damage', true);
        if ({ sand: 1, ice_patch: 1, water_puddle: 1 }[t]) add('effect', 'Effect');
        if (t === 'farm' || t === 'astar_farm') add('mult', 'Multiplier', true, mx(`${t} / Multiplier`, 'building', t, 'multiplier'));
        if (t === 'house') add('pop', 'Pop Cap', true);
        add('value', 'Value');
    }
    return R;
}
// Which buttons a group's kind has.
function _ipsButtonsOf(g) {
    if (g.kind === 'mine') return [];
    if (g.kind === 'unit') return ['kill', 'hold', 'x2', 'd2'];
    const b = ['salvage', 'build', 'buildOff'];
    if (g.kind !== 'tower' && g.kind !== 'floor') b.push('queue');
    b.push('stack');
    if (g.kind === 'research') b.push('research');
    b.push('auto');
    return b;
}
const IPS_PILL_CLASS = { salvage: 'info-salvage-group-btn', kill: 'info-kill-group-btn', hold: 'info-hold-group-btn', build: 'info-build-toggle-group-btn', buildOff: 'info-disabled-pill',
    queue: 'info-queue-toggle-group-btn', stack: 'info-auto-stack-group-btn', research: 'info-auto-research-group-btn', auto: 'info-auto-upgrade-group-btn', x2: 'info-scale-group-btn', d2: 'info-scale-group-btn' };
const IPS_PILL = 'cursor:pointer;padding:2px 8px;border-radius:3px;font-size:9px;';
const IPS_PILL_ON = { salvage: ['#232', '#6f6', '#9f9'], kill: ['#232', '#6f6', '#9f9'], hold: ['#232', '#6f6', '#9f9'], build: ['#232', '#6f6', '#9f9'], auto: ['#223', '#4af', '#8cf'],
    research: ['#243025', '#6ccf7c', '#9fdaab'], stack: ['#2c261c', '#d9aa60', '#ffd8a0'], queue: ['#222c34', '#6cb7ff', '#a7d6ff'] };
const _ipsPillCss = (kind, on) => { const c = on ? IPS_PILL_ON[kind] : ['#222', '#555', '#888']; return `${IPS_PILL}background:${c[0]};border:1px solid ${c[1]};color:${c[2]}`; };

// ---- the markup, made once ----
const _ipsEsc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
function _ipsMarkup(cat) {
    let h = '<div class="info-panel-section ips-status" hidden></div>';
    h += '<div class="info-panel-section ips-bar" hidden><div id="subgroup-bar" style="display:flex;flex-wrap:wrap;gap:3px;margin-bottom:4px;align-items:flex-end">';
    cat.groups.forEach((g, i) => {
        const unit = g.kind === 'unit';
        h += `<div class="subgroup-toggle" data-key="${_ipsEsc(g.key)}" data-g="${i}" hidden style="cursor:pointer;width:36px;text-align:center;position:relative">`
            + `<div class="sg-icon-box ${unit ? 'sg-unit' : 'sg-entity'}" style="width:34px;height:34px;border:2px solid #4a4a4a;border-radius:${unit ? '50%' : '3px'};background:#111;display:flex;align-items:center;justify-content:center;position:relative">`
            + `<img width="26" height="26" data-thumb="${_ipsEsc(g.thumb)}" style="${unit ? 'border-radius:50%' : ''}">`
            + `<span class="ips-n" style="position:absolute;bottom:-1px;${unit ? 'left:50%;transform:translateX(-50%);' : 'right:1px;'}font-size:8px;color:#fd0;font-weight:bold;z-index:1"></span></div></div>`;
    });
    h += '<div style="display:flex;flex-direction:column;gap:1px;margin-left:auto">'
        + '<span class="subgroup-all" data-action="all" style="cursor:pointer;font-size:8px;color:#4f4;padding:1px 4px;border:1px solid #333;border-radius:2px;background:#1a1a1a">All</span>'
        + '<span class="subgroup-all" data-action="none" style="cursor:pointer;font-size:8px;color:#f44;padding:1px 4px;border:1px solid #333;border-radius:2px;background:#1a1a1a">None</span></div>';
    h += '</div><div style="border-bottom:1px solid #333;margin:4px 0"></div></div>';
    h += '<div class="info-panel-section ips-sum" hidden><div class="info-title ips-sum-t"></div><div class="info-row info-stat"><span class="info-label"><span class="info-label-plain">Total Energy</span></span><span class="info-value ips-sum-v"></span></div><div style="border-bottom:1px solid #333;margin:4px 0"></div></div>';
    cat.groups.forEach((g, i) => {
        h += `<div class="info-panel-section ips ips-off" data-g="${i}"><div class="info-title"><button type="button" class="info-label-btn info-subgroup-research-btn" data-key="${_ipsEsc(g.key)}" title="Open research popup for this subgroup">P</button>`
            + `<span class="ips-t"></span> <span class="ips-mixed" style="color:#fc8" hidden>Mixed</span><span class="ips-hl" style="color:#888"></span><span class="ips-he" style="color:#4f4"></span>`
            + `<span class="ips-ha ips-small" style="color:#fd0"></span><span class="ips-hm ips-small"></span><span class="ips-hs ips-small" style="color:#4f4"></span></div>`;
        for (const r of g.rows) {
            const mid = r.m ? registerInfoPanelStatMatrixDescriptor(r.l, r.m) : null;
            const label = mid !== null ? `<span class="info-label-wrap"><button type="button" class="info-label-btn info-stat-matrix-btn" data-matrix-id="${mid}" title="Open level/research matrix">M</button><span>${_ipsEsc(r.l)}</span></span>` : `<span class="info-label-plain">${_ipsEsc(r.l)}</span>`;
            const unit = r.unit ? '<span class="info-unit">⚡/s</span>' : '';
            const cell = cls => r.id === 'level' && cls === 'info-eff'
                ? `<span class="${cls} level-display"><span class="v"></span><span class="ar" style="color:#aaa" hidden>→</span><span class="p" hidden></span></span>`
                : r.id === 'stacks' && cls === 'info-base' ? `<span class="${cls}"><span class="v"></span><span class="sp" hidden><span style="color:#7f7"> +</span> <span class="sr" style="color:#49c0ff"></span></span></span>`
                : `<span class="${cls}${r.id === 'level' ? ' level-display' : ''}"><span class="v"></span>${unit}</span>`;
            h += `<div class="info-row info-stat" data-r="${r.id}" hidden><span class="info-label">${label}</span>` + (r.two ? cell('info-base') + cell('info-eff') : cell('info-value')) + '</div>';
        }
        if (g.kind === 'barrack' || g.kind === 'spawner' || g.kind === 'research') {
            h += '<div class="info-row info-queue-row ips-q" hidden><span class="count-cost" title="Approximate energy remaining for the queue"></span><span class="count-control"><input class="count-slider" type="range" min="0" max="0" step="1" value="0" title=""><span class="count-min">0</span><output>0</output><span class="count-max">0</span></span></div>';
            h += '<div class="info-row ips-p" style="padding-top:0;" hidden><div style="position:relative;width:100%;height:12px;border:1px solid #35516a;border-radius:3px;background:#0f161c;overflow:hidden;"><div class="ips-pf" style="position:absolute;left:0;top:0;bottom:0;width:0%;background:linear-gradient(90deg,#2d7dd2,#49c0ff);"></div><div class="ips-pt" style="position:absolute;left:0;right:0;top:0;bottom:0;display:flex;align-items:center;justify-content:center;color:#d6ecff;font-size:9px;font-weight:700;text-shadow:0 1px 1px #000;"></div></div></div>';
        }
        if (g.kind === 'research') h += '<div class="ips-research" hidden></div>';
        const btns = _ipsButtonsOf(g);
        if (btns.length) {
            const left = btns.filter(b => b === 'salvage' || b === 'kill' || b === 'hold'), right = btns.filter(b => !left.includes(b));
            const pill = b => b === 'buildOff' ? `<span class="info-disabled-pill" data-b="buildOff" hidden style="cursor:default;background:#1a1a1a;padding:2px 8px;border:1px solid #333;border-radius:3px;font-size:9px;color:#555;">🔨 --</span>`
                : b === 'x2' || b === 'd2' ? `<span class="info-scale-group-btn" data-b="${b}" data-mode="${b}" hidden style="cursor:pointer;background:#222;padding:2px 8px;border:1px solid #555;border-radius:3px;font-size:9px;color:${b === 'x2' ? '#8cf' : '#fc8'}">${b === 'x2' ? 'x2' : '/2'}</span>`
                : `<span class="${IPS_PILL_CLASS[b]}" data-b="${b}" hidden></span>`;
            h += `<div class="info-row info-btn-row ips-b" hidden style="justify-content:space-between;align-items:center;gap:6px;"><div style="display:flex;align-items:center;gap:4px;"><span class="info-btn-help-btn" title="Explain these buttons" style="cursor:pointer;background:#222;padding:2px 8px;border:1px solid #555;border-radius:3px;font-size:9px;font-weight:bold;color:#d9b84a">?</span>${left.map(pill).join('')}</div><div style="display:flex;align-items:center;gap:4px;">${right.map(pill).join('')}</div></div>`;
        }
        h += `<div style="font-size:9px;color:#777;margin-top:4px;border-top:1px solid #333;padding-top:3px;font-style:italic">${_ipsEsc(g.desc || '')}</div><div style="border-bottom:1px solid #333;margin:4px 0"></div></div>`;
    });
    return h;
}

// ---- the panel's elements ----
const _ips = { panel: null, cat: null, active: false, secs: [], toggles: [], status: null, statusRec: null, bar: null, sum: null };
// Made at the match's start (main.js startGame): the markup once, its
// elements found once, its controls bound once.
function infoPanelMatchStart() {
    const panel = typeof document !== 'undefined' ? document.getElementById('info-panel') : null;
    if (!panel) return;
    // (A match of the simulation worker's: this panel; the in-page simulation: the old one.)
    _ips.mode = typeof simClientWillTakeMatch === 'function' && simClientWillTakeMatch();
    if (!_ips.mode) { _ips.cat = null; return; }
    const cat = _ips.cat = _ipsCatalogue();
    cat.groups.forEach((g, i) => { g.i = i; g.rows = _ipsRowsOf(g); cat.wire.groups[i].rowIds = g.rows.map(r => r.id); });
    panel.innerHTML = _ipsMarkup(cat);
    _ips.panel = panel; _ips.active = false;
    _ips.status = panel.querySelector('.ips-status');
    if (typeof infoStatusStaticMake === 'function') infoStatusStaticMake(_ips.status);
    _ips.bar = panel.querySelector('.ips-bar'); _ips.sum = panel.querySelector('.ips-sum');
    _ips.sumT = panel.querySelector('.ips-sum-t'); _ips.sumV = panel.querySelector('.ips-sum-v');
    _ips.toggles = [...panel.querySelectorAll('.subgroup-toggle')].map(el => ({ el, img: el.querySelector('img'), n: el.querySelector('.ips-n'), box: el.querySelector('.sg-icon-box') }));
    for (const T of _ips.toggles) {
        if (typeof getItemThumbnail === 'function' && T.img.dataset.thumb) T.img.src = getItemThumbnail(T.img.dataset.thumb, 26);
        T.el._h = true;
        bindInstantPress(T.el, () => { const k = T.el.dataset.key; activeSubGroups[k] = activeSubGroups[k] === false; updateInfoPanel(); });
    }
    for (const b of panel.querySelectorAll('.subgroup-all')) bindInstantPress(b, () => { const v = b.dataset.action === 'all'; for (const g of cat.groups) activeSubGroups[g.key] = v; updateInfoPanel(); });
    _ips.secs = [...panel.querySelectorAll('.info-panel-section.ips')].map(el => {
        const g = cat.groups[Number(el.dataset.g)], S = { el, g, rows: {}, btn: {}, shown: false };
        S.t = el.querySelector('.ips-t'); S.mixed = el.querySelector('.ips-mixed'); S.hl = el.querySelector('.ips-hl'); S.he = el.querySelector('.ips-he');
        S.ha = el.querySelector('.ips-ha'); S.hm = el.querySelector('.ips-hm'); S.hs = el.querySelector('.ips-hs');
        for (const row of el.querySelectorAll('.info-row[data-r]')) {
            const cells = [...row.querySelectorAll('.info-base, .info-eff, .info-value')].map(c => ({ c, v: c.querySelector('.v'), ar: c.querySelector('.ar'), p: c.querySelector('.p'), sp: c.querySelector('.sp'), sr: c.querySelector('.sr') }));
            row._h = true;
            S.rows[row.dataset.r] = { row, cells };
        }
        S.rowList = g.rows.map(r => S.rows[r.id]);
        S.specU = JSON.stringify({ type: 'spawn', coordsRef: '@g:' + g.key + ':ready', worker: false }); S.specW = JSON.stringify({ type: 'spawn', coordsRef: '@g:' + g.key + ':ready', worker: true });
        S.q = el.querySelector('.ips-q');
        if (S.q) { S.qCost = S.q.querySelector('.count-cost'); S.qCtl = S.q.querySelector('.count-control'); S.qIn = S.q.querySelector('input'); S.qOut = S.q.querySelector('output'); S.qMax = S.q.querySelector('.count-max'); }
        S.p = el.querySelector('.ips-p'); if (S.p) { S.pf = S.p.querySelector('.ips-pf'); S.pt = S.p.querySelector('.ips-pt'); }
        S.research = el.querySelector('.ips-research');
        if (S.research && typeof infoResearchStaticMake === 'function') infoResearchStaticMake(S.research);
        S.b = el.querySelector('.ips-b');
        for (const p of el.querySelectorAll('[data-b]')) { S.btn[p.dataset.b] = p; p._h = true; }
        for (const x of [S.mixed, S.q, S.p, S.research, S.b]) if (x) x._h = x.hidden;
        _ipsBind(S);
        return S;
    });
    if (typeof bindCountBarEvents === 'function') bindCountBarEvents();
    _ipsPrewarmLayout(panel);
}
// Every section laid out once, now, at the match's start: shown again later
// (content-visibility: hidden keeps it) without a first layout in play.
function _ipsPrewarmLayout(panel) {
    const display = panel.style.display, visibility = panel.style.visibility;
    panel.style.visibility = 'hidden'; panel.style.display = 'block';
    for (const S of _ips.secs) { S.el.classList.add('ips-warm'); S.el.classList.remove('ips-off'); for (const k in S.rows) S.rows[k].row.hidden = false; }
    void panel.offsetHeight;
    for (const S of _ips.secs) { for (const k in S.rows) { S.rows[k].row.hidden = true; S.rows[k].row._h = true; } S.el.classList.add('ips-off'); S.el.classList.remove('ips-warm'); }
    void panel.offsetHeight;
    panel.style.display = display; panel.style.visibility = visibility;
}
// (A press restyles a pill itself, infoTogglePressed: what was written last is then unknown.)
function _ipsForget(el) { el._a = null; el._t = undefined; el._css = undefined; }
function _ipsBind(S) {
    const g = S.g, el = S.el;
    for (const b of el.querySelectorAll('.info-stat-matrix-btn')) bindInstantPress(b, () => {
        const id = Number.parseInt(b.dataset.matrixId || '', 10);
        if (!Number.isFinite(id)) return;
        researchStatMatrixPopupPayload = { infoPanelMatrixId: id };
        setResearchStatMatrixPopupOpen(true);
    });
    const help = el.querySelector('.info-btn-help-btn');
    if (help) bindInstantPress(help, () => openInfoButtonHelpPopup(help));
    bindInstantPress(el.querySelector('.info-subgroup-research-btn'), () => {
        popupControlGroups.__single_subgroup_popup__ = { units: g.kind === 'unit' ? _ipsMembersUnits(g) : [], entities: g.kind === 'unit' ? [] : _ipsMembers(g), activeSubGroups: {} };
        activePopupControlGroupKey = '__single_subgroup_popup__';
        setResearchPopupOpen(true);
    });
    const later = () => setTimeout(updateInfoPanel, 50);
    const coords = p => infoCoordText(p.dataset.coords).split(';').filter(Boolean).map(c => { const [x, y] = c.split(','); return { gx: parseInt(x), gy: parseInt(y) }; });
    const toggle = (name, action) => { const p = S.btn[name]; if (p) bindInstantPress(p, () => { const enabled = p.dataset.enabled === '1'; for (const c of coords(p)) queueAction({ action, gx: c.gx, gy: c.gy, enabled }); _ipsForget(p); later(); }); };
    toggle('build', 'setBuildEnabled'); toggle('queue', 'setQueueEnabled'); toggle('stack', 'setAutoStack'); toggle('research', 'setAutoResearch'); toggle('auto', 'setAutoUpgrade');
    if (S.btn.salvage) { const p = S.btn.salvage; bindInstantPress(p, () => { const marked = p.dataset.marked === '1'; for (const c of coords(p)) { queueAction({ action: 'setSalvage', gx: c.gx, gy: c.gy, marked: !marked }); if (typeof noteSalvageShown === 'function') noteSalvageShown(c.gx, c.gy, !marked); } _ipsForget(p); later(); }); }
    if (S.btn.kill) { const p = S.btn.kill; bindInstantPress(p, () => { const ids = infoPanelUnitIds(p.dataset.ids); if (ids.length) queueAction({ action: 'killUnit', unitIds: ids }); later(); }); }
    if (S.btn.hold) { const p = S.btn.hold; bindInstantPress(p, () => {
        const us = infoPanelUnitIds(p.dataset.ids).map(id => _infoPanelUnitById(id)).filter(u => u && !u.dead);
        if (p.dataset.hold === '1') queueAction({ action: 'hold', unitIds: us.map(u => u.id) });
        else queueAction({ action: 'stop', unitIds: us.filter(u => u.holdPosition).map(u => u.id) });
        _ipsForget(p); later();
    }); }
    for (const k of ['x2', 'd2']) if (S.btn[k]) { const p = S.btn[k]; bindInstantPress(p, () => {
        const ids = infoPanelUnitIds(p.dataset.ids);
        if (ids.length) queueAction({ action: 'resizeUnitGroup', unitIds: ids, mode: k, unitType: g.type, unitLevel: null });
        later();
    }); }
    // (The group's members as tokens, made at a press: infoCoordText.)
    if (g.kind !== 'unit') {
        _infoLazyCoords.set('@g:' + g.key + ':all', () => _ipsMembers(g));
        _infoLazyCoords.set('@g:' + g.key + ':ready', () => _ipsMembers(g).filter(e => !e.underConstruction));
    }
}
function _ipsMembers(g) { return selectedEntities.filter(e => e && getEntityGroupKey(e) === g.key && !(e.energy !== undefined && e.energy <= 0)); }
function _ipsMembersUnits(g) { return selectedUnits.filter(u => u && !u.dead && u.unitType === g.type); }
// The standing member's view (its slot, from the packer).
function _ipsRepView(gi) {
    const R = _ipk.rows;
    if (!R) return null;
    const s = R[gi * IPF_N + IPF.repSlot];
    const v = s >= 0 && typeof _pageStructViews !== 'undefined' ? _pageStructViews[s] : null;
    return v && !v.dead ? v : null;
}

// ---- writes (only what changed) ----
function _ipsText(el, t) { t = t === undefined || t === null ? '' : String(t); if (el._t !== t) { el.textContent = t; el._t = t; } }
function _ipsShow(el, on) { on = !!on; if (el._h !== !on) { el.hidden = !on; el._h = !on; } }
function _ipsAttr(el, k, v) { v = String(v); const c = el._a || (el._a = {}); if (c[k] !== v) { el.setAttribute(k, v); c[k] = v; } }
function _ipsCss(el, css) { if (el._css !== css) { el.style.cssText = css; el._css = css; } }
function _ipsColor(el, c) { if (el._c !== c) { el.style.color = c; el._c = c; } }
const _ivB = (v, d = 0) => formatBigNumber(v, d);
const _ivFrac = (a, b, d = 0) => formatBigNumber(a, d) + '/​' + formatBigNumber(b, d);
function _ipsRow(S, id, show, base, eff) {
    const R = S.rows[id];
    if (!R) return;
    _ipsShow(R.row, show);
    if (!show) return;
    _ipsText(R.cells[0].v, base);
    if (R.cells[1]) _ipsText(R.cells[1].v, eff);
}
function _ipsToggle(el, kind, ref, all, any, icon) {
    if (!el) return;
    if (!ref) { _ipsShow(el, false); return; }
    [all, any] = _infoToggleGroupState(IPS_PILL_CLASS[kind], ref, all, any);
    _ipsShow(el, true);
    _ipsAttr(el, 'data-coords', ref);
    if (kind === 'salvage') { _ipsAttr(el, 'data-marked', any ? '1' : '0'); _ipsCss(el, _ipsPillCss(kind, !any)); _ipsText(el, `❤️ ${!any ? 'ON' : all ? 'OFF' : 'MIXED'}`); return; }
    _ipsAttr(el, 'data-enabled', all ? '0' : '1'); _ipsCss(el, _ipsPillCss(kind, all)); _ipsText(el, `${icon}${all ? 'ON' : any ? 'MIXED' : 'OFF'}`);
}

// Whether the main panel is this one: a simulation worker and its packer,
// known at the match's start (never switched during play); the in-page
// simulation (tests) draws the old panel.
function infoPanelStaticActive() { return _ips.mode && !!_ips.cat && _ipk.state >= 0; }
// updateInfoPanel's main panel: what the packer reads, then the last numbers it made.
function infoPanelStaticRender(panel) {
    if (_ips.panel !== panel) return;
    _ips.active = true;
    _infoPackSync();
    _ipsApply(panel);
}
function _ipsApply(panel) {
    const R = _ipk.rows, cat = _ips.cat;
    const totalSel = selectedEntities.length + selectedUnits.length;
    if (totalSel === 0) {
        const html = infoStatusStaticWrite();
        _ipsShow(_ips.status, html);
        _ipsShow(_ips.bar, false); _ipsShow(_ips.sum, false);
        for (const S of _ips.secs) if (S.shown) { S.el.classList.add('ips-off'); S.shown = false; }
        for (const T of _ips.toggles) _ipsShow(T.el, false);
        panel.style.display = html ? 'block' : 'none';
        return;
    }
    panel.style.display = 'block';
    _ipsShow(_ips.status, false);
    const fresh = R && _ipk.rowsSeq === _ipk.seq;
    let groups = 0, energy = 0, max = 0;
    for (let i = 0; i < cat.groups.length; i++) {
        const g = cat.groups[i], o = i * IPF_N, n = fresh ? R[o + IPF.n] : 0, T = _ips.toggles[i], S = _ips.secs[i];
        const present = n > 0;
        _ipsShow(T.el, present);
        const on = present && activeSubGroups[g.key] !== false;
        if (present) {
            groups++;
            _ipsText(T.n, 'x' + Math.round(n));
            if (T.el._op !== on) { T.el.style.opacity = on ? '1' : '0.35'; T.box.style.borderColor = on ? '#4a4a4a' : '#333'; T.el._op = on; }
            energy += g.kind === 'unit' ? R[o + IPF.uEnergySum] : R[o + IPF.energy];
            max += g.kind === 'unit' ? R[o + IPF.uMaxSum] : R[o + IPF.maxCol];
        }
        // (Off: content-visibility hidden, its rendering kept; see style.css .ips-off.)
        if (S.shown !== on) { S.el.classList.toggle('ips-off', !on); S.shown = on; }
        if (on) _ipsGroup(S, g, R, o, n, _ipk.texts ? _ipk.texts[i] : null);
    }
    _ipsShow(_ips.bar, groups > 0);
    _ipsShow(_ips.sum, totalSel > 1);
    if (totalSel > 1) { _ipsText(_ips.sumT, `${totalSel} selected`); _ipsText(_ips.sumV, `${Math.floor(energy)}/${Math.floor(max)}`); }
    if (typeof applyInfoPanelScrollLock === 'function') applyInfoPanelScrollLock(panel);
}
// One group: the packer's text written as it is (X: its groupText), then
// what only the page knows (the area under the standing member, its
// researched maximum level, a tower's preferred target), the queue slider,
// the research block and the buttons from the numbers.
function _ipsGroup(S, g, R, o, n, X) {
    if (!X) return;
    _ipsText(S.t, X.t);
    _ipsShow(S.mixed, X.mixed); _ipsText(S.hl, X.hl); _ipsText(S.he, X.he); _ipsText(S.hs, X.hs);
    const v = X.v, list = S.rowList;
    for (let k = 0; k < list.length; k++) {
        const r = list[k], show = v[k * 3] === 1;
        _ipsShow(r.row, show);
        if (!show) continue;
        _ipsText(r.cells[0].v, v[k * 3 + 1]);
        if (r.cells[1]) _ipsText(r.cells[1].v, v[k * 3 + 2]);
    }
    if (g.kind === 'unit') return _ipsUnitButtons(S, g, R, o, n);
    if (g.kind === 'mine') { _ipsText(S.ha, ''); _ipsText(S.hm, ''); return; }
    const own = _ipsRepView(g.i), local = R[o + IPF.local] > 0;
    let areaSize = 0, areaLevel = 0;
    if (own && own.gx >= 0 && own.gy >= 0 && own.gy < GRID_H && own.gx < GRID_W) { const aId = grid[own.gy][own.gx].areaId; if (aId !== -1) { const a = getAreaById(aId); if (a) { areaSize = a.cells.length; areaLevel = a.multiplierLevel || 0; } } }
    _ipsText(S.ha, areaSize > 0 ? ` A${areaSize}` : '');
    _ipsText(S.hm, ` M${areaLevel}`); _ipsColor(S.hm, AREA_LEVEL_COLORS[areaLevel] || '#888');
    const rmax = own ? getThingResearchedMaxLevel(own) : MAX_THING_LEVEL;
    _ipsRow(S, 'maxlevel', true, `L${rmax}`);
    const lr = S.rows.level;
    if (lr) {
        _ipsColor(lr.cells[0].v, '#888'); _ipsColor(lr.cells[1].v, lr.cells[0].v._t !== lr.cells[1].v._t ? '#4f4' : '#888');
        const pot = X.pot;
        _ipsShow(lr.cells[1].ar, pot > 0); _ipsShow(lr.cells[1].p, pot > 0);
        if (pot > 0) { _ipsText(lr.cells[1].p, 'L' + pot); _ipsColor(lr.cells[1].p, pot > rmax ? '#d88' : '#f44'); const c = pot > rmax ? 'p ips-strike' : 'p'; if (lr.cells[1].p.className !== c) lr.cells[1].p.className = c; }
    }
    const sr = S.rows.stacks;
    if (sr) { _ipsShow(sr.cells[0].sp, !!X.stacksRem); if (X.stacksRem) _ipsText(sr.cells[0].sr, X.stacksRem); }
    if (g.kind === 'tower') _ipsRow(S, 'rally', local, own ? getTowerPreferredTargetDisplay(own) : '');
    // The queue and its progress.
    if (S.q) {
        _ipsShow(S.q, local); _ipsShow(S.p, local);
        if (local) {
            const worker = g.kind !== 'barrack', max = Math.round(R[o + IPF.ready]) * (worker ? 10 : 20), value = Math.max(0, Math.min(max, Math.round(R[o + IPF.queued])));
            const label = worker ? 'Worker queue count' : 'Unit queue count', pos = value / Math.max(1, max) * 100;
            _ipsText(S.qCost, X.qcost);
            _ipsAttr(S.qIn, 'max', max); if (S.qIn.value !== String(value)) S.qIn.value = String(value); _ipsAttr(S.qIn, 'value', value);
            _ipsAttr(S.qIn, 'data-floor', 0); _ipsAttr(S.qIn, 'data-count-spec', worker ? S.specW : S.specU); _ipsAttr(S.qIn, 'data-prefix', ''); _ipsAttr(S.qIn, 'data-label', label); _ipsAttr(S.qIn, 'aria-label', label);
            if (S.qIn.disabled !== (max <= 0)) S.qIn.disabled = max <= 0;
            const p = pos + '%'; if (S.qCtl._p !== p) { S.qCtl.style.setProperty('--position', p); S.qCtl.style.setProperty('--locked', '0%'); S.qCtl._p = p; }
            _ipsAttr(S.qCtl, 'data-label-side', pos < 40 ? 'after' : 'before'); _ipsAttr(S.qCtl, 'data-edge', pos <= 10 ? 'min' : pos >= 90 ? 'max' : '');
            _ipsText(S.qMax, String(max)); _ipsText(S.qOut, String(value));
            _ipsText(S.pt, X.ptext);
        }
    }
    // A research group's queue and research rows: from its standing lab, its labs counted by the packer.
    if (S.research) {
        _ipsShow(S.research, local);
        if (local && own) infoResearchStaticWrite(own, Math.round(R[o + IPF.ready]));
    }
    if (S.b) {
        _ipsShow(S.b, local);
        if (local) {
            const f = k => R[o + IPF[k]], all = c => c >= n - 1e-6, refAll = '@g:' + g.key + ':all', B = S.btn;
            _ipsToggle(B.salvage, 'salvage', refAll, all(f('salvage')), f('salvage') > 0, '');
            _ipsToggle(B.build, 'build', f('uc') > 0 ? refAll : null, all(f('buildOn')), f('buildOn') > 0, '🔨 ');
            if (B.buildOff) _ipsShow(B.buildOff, !(f('uc') > 0) && g.kind !== 'tower' && g.kind !== 'floor');
            _ipsToggle(B.queue, 'queue', refAll, all(f('queueOn')), f('queueOn') > 0, 'Q ');
            _ipsToggle(B.stack, 'stack', refAll, all(f('autoStack')), f('autoStack') > 0, '🧱 ');
            _ipsToggle(B.research, 'research', refAll, all(f('autoRes')), f('autoRes') > 0, 'R ');
            _ipsToggle(B.auto, 'auto', refAll, all(f('autoUp')), f('autoUp') > 0, 'L+');
        }
    }
}
// A unit group's buttons: the player's own units (a selection is of one owner's).
function _ipsUnitButtons(S, g, R, o, n) {
    _ipsText(S.ha, ''); _ipsText(S.hm, '');
    const own = selectedUnits.length > 0 && selectedUnits[0] && selectedUnits[0].owner === localPlayerId;
    _ipsShow(S.b, own);
    if (!own) return;
    const count = Math.round(n), ref = '@group:unit_' + g.type, B = S.btn;
    _ipsShow(B.kill, true); _ipsAttr(B.kill, 'data-ids', ref); _ipsCss(B.kill, _ipsPillCss('kill', true)); _ipsText(B.kill, '❤️ ON');
    let h = Math.round(R[o + IPF.uHold]);
    if (_infoToggleShown.size > 0) { const [a, any] = _infoToggleGroupState('info-hold-group-btn', ref, count > 0 && h === count, h > 0); h = a ? count : any ? h : 0; }
    _ipsShow(B.hold, true); _ipsAttr(B.hold, 'data-ids', ref); _ipsAttr(B.hold, 'data-hold', h === 0 ? '1' : '0');
    _ipsCss(B.hold, _ipsPillCss('hold', h === 0)); _ipsText(B.hold, `🚶 ${h === 0 ? 'ON' : h === count ? 'OFF' : 'MIXED'}`);
    for (const k of ['x2', 'd2']) { _ipsShow(B[k], true); _ipsAttr(B[k], 'data-ids', ref); }
}
// ---- a far view's box selection, in the packer (renderer.js get3DBoxSelection) ----
// (true: asked; main.js boxSelectionApply takes the result, a few ms later.
// No packer (the in-page simulation): the page's own pass.)
const _ipkBox = { id: 0, shift: false, pending: false };
function infoPackBoxSelect(screenRect, shift, worldRect) {
    if (_ipk.state !== 2) return false;
    let msg = null;
    if (renderDimensionMode === '3d' && screenRect && renderer3dInstance) {
        if (typeof renderer3dInstance.buildViewProjection === 'function') renderer3dInstance.buildViewProjection(get3DProjectionSnapshot());
        const VP = renderer3dInstance.tmpViewProjection, W = renderer3dInstance.cssWidth, H = renderer3dInstance.cssHeight;
        if (!VP || !(W > 0) || !(H > 0)) return false;
        msg = { mode: '3d', vp: Array.from(VP), w: W, h: H, pad: renderer3dInstance.viewPad || 0,
            rect: [Math.min(screenRect.sx, screenRect.ex), Math.min(screenRect.sy, screenRect.ey), Math.max(screenRect.sx, screenRect.ex), Math.max(screenRect.sy, screenRect.ey)] };
    } else if (worldRect) msg = { mode: '2d', rect: [worldRect.sx, worldRect.sy, worldRect.ex, worldRect.ey] };
    if (!msg) return false;
    _infoPackSync();
    _ipkBox.id++; _ipkBox.shift = !!shift; _ipkBox.pending = true;
    _ipk.worker.postMessage(Object.assign({ type: 'box', id: _ipkBox.id, alpha: tickAlpha, me: localPlayerId, tile: TILE }, msg));
    return true;
}
function _infoPackBoxDone(m) {
    if (m.id !== _ipkBox.id || !_ipkBox.pending) return;
    _ipkBox.pending = false;
    const views = _pageSlotViews, sv = typeof _pageStructViews !== 'undefined' ? _pageStructViews : [];
    const units = [], slots = new Int32Array(m.units.length);
    let k = 0;
    for (let i = 0; i < m.units.length; i++) { const s = m.units[i], u = views[s]; if (u) { units.push(u); slots[k++] = s; } }
    const entities = [];
    for (let i = 0; i < m.structs.length; i++) { const v = sv[m.structs[i]]; if (v && !v.dead) entities.push(v); }
    for (let i = 0; i < m.mines.length; i++) {
        const v = sv[m.mines[i]];
        if (!v || v.dead || !isTileVisible(v.gx, v.gy)) continue;
        if (v._kind === 4) v._isGoldMine = true; else v._isAstarMine = true;
        entities.push(v);
    }
    if (typeof boxSelectionApply === 'function') boxSelectionApply(units, entities, slots, k, _ipkBox.shift);
}

// ---- a selection's order ids, from the packer (made when it changed) ----
// (hud.js _slotUnitIds takes them for the selection they were made for;
// worker.js _queueLocalAction takes their wire strings: no encoding of
// 200k ids on the click.)
const _ipkIds = { sel: null, len: -1, all: null, combat: null, workers: null };
const _ipkIdsZ = new WeakMap();
function _infoPackIds(m) {
    const S = _ipk.sent;
    _ipkIds.sel = S.units; _ipkIds.len = S.unitsLen;
    const keep = (ids, z) => { const a = Array.from(ids); if (z) _ipkIdsZ.set(a, z); return a; };
    _ipkIds.all = keep(m.all, m.allZ); _ipkIds.combat = keep(m.combat, m.combatZ); _ipkIds.workers = keep(m.workers, m.workersZ);
}
// The packer's ids for kind (0 all, 1 combat, 2 workers) of the selection now, or null.
function infoPackSelectionIds(kind) {
    if (_ipkIds.sel !== selectedUnits || _ipkIds.len !== selectedUnits.length) return null;
    return kind === 0 ? _ipkIds.all : kind === 1 ? _ipkIds.combat : _ipkIds.workers;
}
// The wire string of piece k (ACTION_MAX_UNIT_IDS ids each) of ids, or null.
function infoPackIdsWire(ids, k = 0) { const z = _ipkIdsZ.get(ids); return z ? z[k] || null : null; }
