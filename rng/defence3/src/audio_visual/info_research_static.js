'use strict';
// The info panel's research block (a research group's section) and the
// player status (nothing selected), static: their elements made once at the
// match's start (info_panel_static.js infoPanelMatchStart), a refresh writes
// values into them (text, attributes, shown or hidden), no markup per refresh.
//
// Research block: the queue toggle, the queue (open: a list of its own
// height with a fixed pool of row elements placed where its scroll shows
// them; a refresh fills only those, so a 300-task queue costs what a
// 10-task one does), the thing buttons (every research thing, made once) and
// the stat rows (one per stat group of every thing, shown for the things
// picked). The controls keep their classes and data attributes: the same
// handlers (hud.js bindInfoPanelSectionControls, count_bars.js) read them at
// the press.

const IPR_ROW_H = 72, IPR_VIEW_ROWS = 6, IPR_POOL = IPR_VIEW_ROWS + 3;
const _ipr = { el: null, rows: [], top: 0, n: 0, owner: -1, things: [], stats: new Map(), lab: null };

// A slider of the count bar's markup (count_bars.js countBarHtml), its values written later by _iprBar.
function _iprBarMarkup(others, item) {
    let m = '';
    for (let i = 0; i < others; i++) m += '<span class="count-other-thumb" hidden></span>';
    if (item) m += '<span class="count-item-marker" role="img" hidden></span>';
    const max = MAX_RESEARCH_LEVEL;
    return `<span class="count-control" style="--position:0%;--locked:0%"><input class="count-slider" type="range" min="0" max="${max}" step="1" value="0" data-floor="0" data-prefix="R" title="">${m}<span class="count-min">R0</span><output></output><span class="count-max">R${max}</span></span>`;
}
function _iprBarRefs(ctl) {
    return { ctl, input: ctl.querySelector('input'), out: ctl.querySelector('output'),
        others: [...ctl.querySelectorAll('.count-other-thumb')], item: ctl.querySelector('.count-item-marker') };
}
// countBarHtml's values: value = the lowest target of stats, the other
// targets as extra thumbs, the floor = the lowest completed level.
function _iprBar(B, owner, coords, stats, itemLevel) {
    if (B.input === activeCountBar) return;
    const max = MAX_RESEARCH_LEVEL;
    let value = max, top = 0, floor = max;
    for (const s of stats) {
        const L = researchBarLevel(owner, s);
        if (L.target < value) value = L.target;
        if (L.target > top) top = L.target;
        if (L.level < floor) floor = L.level;
    }
    value = Math.max(0, Math.min(max, value));
    const text = top > value ? `R${value}–R${top}` : countBarLabel(value, 'R');
    const pos = value / Math.max(1, max) * 100, locked = Math.max(0, Math.min(100, floor / Math.max(1, max) * 100));
    const css = pos + '|' + locked;
    if (B.ctl._css !== css) { B.ctl.style.setProperty('--position', pos + '%'); B.ctl.style.setProperty('--locked', locked + '%'); B.ctl._css = css; }
    _ipsAttr(B.ctl, 'data-label-side', pos < 40 ? 'after' : 'before');
    _ipsAttr(B.ctl, 'data-edge', pos <= 10 ? 'min' : pos >= 90 ? 'max' : '');
    const spec = JSON.stringify({ type: 'research', owner, coords, stats, itemLevel });
    const label = `${top > value ? 'Mixed targets — set all selected stats to' : 'Research target'} level (completed research is kept)`;
    const I = B.input;
    _ipsAttr(I, 'value', value); if (I.value !== String(value)) I.value = String(value);
    _ipsAttr(I, 'data-floor', floor); _ipsAttr(I, 'data-count-spec', spec);
    _ipsAttr(I, 'data-label', label); _ipsAttr(I, 'aria-label', label); _ipsAttr(I, 'aria-valuetext', text);
    const off = owner !== localPlayerId || !coords.length;
    if (I.disabled !== off) I.disabled = off;
    _ipsText(B.out, text);
    // (The other targets above the value, one thumb each, distinct.)
    let k = 0;
    if (top > value) for (const s of stats) {
        const t = researchBarLevel(owner, s).target;
        if (t <= value) continue;
        let seen = false;
        for (let j = 0; j < k; j++) if (B.others[j]._v === t) { seen = true; break; }
        if (seen || k >= B.others.length) continue;
        const o = B.others[k++];
        if (o._v !== t) { o.style.left = `calc((100% - 4px) * ${t / Math.max(1, max)})`; o._v = t; }
        _ipsShow(o, true);
    }
    for (; k < B.others.length; k++) { _ipsShow(B.others[k], false); B.others[k]._v = -1; }
    if (B.item) {
        const has = Number.isFinite(itemLevel);
        _ipsShow(B.item, has);
        if (has && B.item._v !== itemLevel) { B.item.style.left = `calc(2px + (100% - 4px) * ${Math.max(0, Math.min(1, itemLevel / Math.max(1, max)))})`; _ipsAttr(B.item, 'aria-label', `This queue item: R${itemLevel}`); B.item._v = itemLevel; }
    }
}

// ---- the markup, made once ----
function _iprMarkup() {
    const things = RESEARCH_THINGS;
    // (One stat row per stat group: _buildResearchMultiStatEntries's keys.)
    const groups = new Map();
    for (const thing of things) for (const stat of thing.stats || []) {
        const k = getResearchMultiStatGroupKey(stat);
        if (!groups.has(k)) groups.set(k, 0);
        groups.set(k, groups.get(k) + 1);
    }
    let h = '<div class="ipr" style="margin-top:4px;border-top:1px solid #333;padding-top:4px">';
    h += '<div class="info-row info-research-queue-toggle" style="cursor:pointer;display:flex;justify-content:space-between;align-items:center"><span>Queue</span><span class="ipr-qs"></span></div>';
    h += '<div class="ipr-qbox" hidden style="margin-top:4px;border-top:1px solid #333;padding-top:4px">';
    h += '<div class="research-energy-summary"><span>Queue remaining</span><span class="ipr-qe" title="Approximate energy cost"></span></div>';
    h += '<div class="ipr-empty" style="font-size:10px;color:#777;padding:4px 0">Queue is empty.</div>';
    h += '<div class="ipr-shared" style="border:1px solid #2a2a2a;border-radius:4px;padding:4px;background:#111"><div style="font-size:10px;color:#9cf;margin-bottom:4px">Shared Queue (<span class="ipr-labs"></span> labs)</div>';
    h += `<div class="info-research-queue-list ipr-scroll" style="position:relative;overflow-y:auto;overflow-x:hidden;max-height:${IPR_VIEW_ROWS * IPR_ROW_H}px"><div class="ipr-spacer" style="position:relative;height:0">`;
    for (let i = 0; i < IPR_POOL; i++) {
        const btn = 'cursor:pointer;color:#9cf;background:#141414;border:1px solid #355;border-radius:3px;padding:0 4px;line-height:12px;font-size:10px;';
        h += `<div class="info-research-queue-row ipr-row" hidden style="position:absolute;left:0;right:0;top:0;height:${IPR_ROW_H - 4}px;box-sizing:border-box;overflow:hidden">`
            + '<div class="info-research-queue-item" style="padding:4px;border:1px solid #242424;border-radius:4px;background:#101010;height:100%;box-sizing:border-box">'
            + '<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;white-space:nowrap">'
            + '<span style="display:flex;align-items:center;gap:4px;color:#bbb;overflow:hidden"><button type="button" class="info-research-stat-matrix-btn" style="cursor:pointer;background:#111;color:#9cf;border:1px solid #355;border-radius:3px;padding:0 5px;height:18px;line-height:16px;font-size:10px;">M</button>'
            + '<span class="ipr-ib" style="display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;border:1px solid #2b2b2b;background:#111;overflow:hidden;flex:0 0 auto"><img width="18" height="18" style="display:block"></span><span class="ipr-lb"></span></span>'
            + '<span class="ipr-mul" style="color:#8fc;min-width:54px;text-align:right;display:inline-block;"></span></div>'
            + '<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:2px">'
            + `<span style="display:flex;align-items:center;gap:4px;color:#fd0"><button type="button" class="info-research-move-top-btn" title="Move to first in queue" style="${btn}">↑</button><button type="button" class="info-research-move-bottom-btn" title="Move to last in queue" style="${btn}">↓</button></span>`
            + `<div style="display:flex;align-items:center;gap:4px">${_iprBarMarkup(0, true)}</div></div>`
            + '<div class="info-row" style="padding-top:2px;"><div style="position:relative;width:100%;height:12px;border:1px solid #35516a;border-radius:3px;background:#0f161c;overflow:hidden;">'
            + '<div class="ipr-pf" style="position:absolute;left:0;top:0;bottom:0;width:0%;background:linear-gradient(90deg,#2d7dd2,#49c0ff);"></div>'
            + '<div class="ipr-pt" style="position:absolute;left:0;right:0;top:0;bottom:0;display:flex;align-items:center;justify-content:center;color:#d6ecff;font-size:9px;font-weight:700;text-shadow:0 1px 1px #000;"></div></div></div>'
            + '</div></div>';
    }
    h += '</div></div></div></div>';
    h += '<div style="margin-top:4px;border-top:1px solid #333;padding-top:4px">';
    h += '<div class="info-row" style="display:flex;flex-wrap:wrap;gap:4px;align-items:flex-start">';
    for (const thing of things) h += `<button class="info-research-thing-btn info-thing-btn${thing.kind === 'unit' ? ' info-thing-btn-unit' : ''}" data-thing-id="${_ipsEsc(thing.kind + ':' + thing.key)}" title="${_ipsEsc(thing.label)}"><img src="${getItemThumbnail(thing.key, 24)}" width="24" height="24"></button>`;
    h += '</div><div class="research-stat-pane ipr-stats">';
    h += '<div class="research-energy-summary"><span>Selected research</span><span class="ipr-se" title="Approximate energy cost"></span></div>';
    for (const [k, n] of groups) h += `<div class="compact-research-row ipr-stat" data-k="${_ipsEsc(k)}" hidden><span class="compact-research-name"></span><button type="button" class="info-research-stat-matrix-btn" style="padding:0 3px;height:16px;line-height:14px;font-size:10px">M</button>${_iprBarMarkup(Math.max(0, n - 1), false)}</div>`;
    h += '</div></div></div>';
    return h;
}
// Made in the research section's host (info_panel_static.js), once.
function infoResearchStaticMake(host) {
    _ipr.el = null; _ipr.rows = []; _ipr.stats = new Map(); _ipr.top = 0; _ipr.n = 0; _ipr.owner = -1;
    if (!host || typeof RESEARCH_THINGS === 'undefined') return;
    host.innerHTML = _iprMarkup();
    const el = _ipr.el = host.firstElementChild;
    _ipr.toggle = el.querySelector('.info-research-queue-toggle'); _ipr.qs = el.querySelector('.ipr-qs');
    _ipr.qbox = el.querySelector('.ipr-qbox'); _ipr.qe = el.querySelector('.ipr-qe'); _ipr.empty = el.querySelector('.ipr-empty');
    _ipr.shared = el.querySelector('.ipr-shared'); _ipr.labs = el.querySelector('.ipr-labs');
    _ipr.scroll = el.querySelector('.ipr-scroll'); _ipr.spacer = el.querySelector('.ipr-spacer');
    for (const x of [_ipr.qbox, _ipr.empty, _ipr.shared]) x._h = x.hidden;
    _ipr.rows = [...el.querySelectorAll('.ipr-row')].map(row => ({ row, slot: -1, m: row.querySelector('.info-research-stat-matrix-btn'), ib: row.querySelector('.ipr-ib'), img: row.querySelector('.ipr-ib img'),
        lb: row.querySelector('.ipr-lb'), mul: row.querySelector('.ipr-mul'), up: row.querySelector('.info-research-move-top-btn'), down: row.querySelector('.info-research-move-bottom-btn'),
        item: row.querySelector('.info-research-queue-item'), bar: _iprBarRefs(row.querySelector('.count-control')), pf: row.querySelector('.ipr-pf'), pt: row.querySelector('.ipr-pt') }));
    for (const R of _ipr.rows) R.row._h = true;
    _ipr.things = [...el.querySelectorAll('.info-research-thing-btn')].map(b => ({ b, id: b.dataset.thingId }));
    _ipr.se = el.querySelector('.ipr-se');
    for (const r of el.querySelectorAll('.ipr-stat')) { r._h = true; _ipr.stats.set(r.dataset.k, { row: r, name: r.querySelector('.compact-research-name'), m: r.querySelector('.info-research-stat-matrix-btn'), bar: _iprBarRefs(r.querySelector('.count-control')) }); }
    // (The scroll position, kept from its event: no layout read at a refresh.)
    _ipr.scroll.addEventListener('scroll', () => { _ipr.top = _ipr.scroll.scrollTop; if (_ipr.lab) _iprQueueRows(_ipr.lab); }, { passive: true });
    _iprBind(el);
}
// The controls, bound once (hud.js bindInfoPanelSectionControls' handlers: they read the data attributes at the press).
function _iprBind(el) {
    const int = v => Number.parseInt(v, 10);
    bindInstantPress(_ipr.toggle, () => {
        const owner = int(_ipr.toggle.dataset.owner), scope = _ipr.toggle.dataset.scope;
        if (!Number.isFinite(owner) || !scope) return;
        const key = getResearchPanelScopeKey(owner, scope);
        researchQueuePanelOpenState[key] = !researchQueuePanelOpenState[key];
        updateInfoPanel();
    });
    for (const T of _ipr.things) bindInstantPress(T.b, ev => {
        const owner = int(T.b.dataset.owner), scope = T.b.dataset.scope;
        if (!Number.isFinite(owner) || !scope) return;
        setResearchThingPanelSelection(owner, scope, T.id, ev);
        updateInfoPanel();
    });
    for (const b of el.querySelectorAll('.info-research-stat-matrix-btn')) bindInstantPress(b, () => {
        if (!b.dataset.kind) return;
        openResearchStatMatrixPopup(b.dataset.kind, b.dataset.key, b.dataset.statKey, int(b.dataset.fromLevel), int(b.dataset.toLevel));
    });
    const move = (b, top) => bindInstantPress(b, () => {
        const gx = int(b.dataset.gx), gy = int(b.dataset.gy), owner = int(b.dataset.owner), from = Math.floor(Number(b.dataset.pendingIndex)), active = b.dataset.active === '1';
        if (!Number.isFinite(gx) || !Number.isFinite(gy) || !Number.isFinite(owner) || !Number.isFinite(from)) return;
        const len = getPlayerResearchQueue(owner).length;
        if (top) {
            if (active || from < 0 || from >= len) return;
            lockInfoPanelScroll(b);
            queueAction({ action: 'reorderResearch', gx, gy, fromIndex: from, toIndex: 0, fromActive: false, toActive: false });
        } else {
            if (len <= 0) return;
            const to = len - 1;
            if (!active && (from < 0 || from >= len || from === to)) return;
            lockInfoPanelScroll(b);
            queueAction({ action: 'reorderResearch', gx, gy, fromIndex: from, toIndex: to, fromActive: active, toActive: false });
        }
        updateInfoPanel();
    });
    for (const R of _ipr.rows) { move(R.up, true); move(R.down, false); }
}

// ---- writes ----
// lab: the group's standing lab (its owner's shared queue), labs: how many.
function infoResearchStaticWrite(lab, labs) {
    if (!_ipr.el || !lab) return;
    const owner = lab.owner, scope = `group:${owner}`;
    _ipr.lab = lab;
    if (_ipr.owner !== owner) { _ipr.owner = owner; for (const T of _ipr.things) { _ipsAttr(T.b, 'data-owner', owner); _ipsAttr(T.b, 'data-scope', scope); } }
    // The toggle and the queue.
    const open = isResearchQueuePanelOpen(owner, scope);
    _ipsAttr(_ipr.toggle, 'data-owner', owner); _ipsAttr(_ipr.toggle, 'data-scope', scope);
    _ipsText(_ipr.qs, `${open ? '▾' : '▸'} ${_ivFrac(getResearchQueueTotalLength(lab), getResearchQueueCapacityForPlayer(owner))}`);
    _ipsShow(_ipr.qbox, open);
    if (open) {
        const task = getPlayerResearchTask(owner), queue = getPlayerResearchQueue(owner), n = (task ? 1 : 0) + queue.length;
        let remain = 0;
        if (task) { const p = researchTaskEnergyProgress(task); remain += p.cost - p.paid; }
        for (let i = 0; i < queue.length; i++) { const p = researchTaskEnergyProgress(queue[i]); remain += p.cost - p.paid; }
        _ipsText(_ipr.qe, '≈' + formatInfoCurrency(remain));
        _ipsShow(_ipr.empty, n === 0); _ipsShow(_ipr.shared, n > 0);
        _ipsText(_ipr.labs, String(labs));
        if (_ipr.n !== n) { _ipr.spacer.style.height = n * IPR_ROW_H + 'px'; _ipr.n = n; }
        _iprQueueRows(lab);
    } else _ipr.n = -1;
    // The things picked and their stat rows.
    const sel = getResearchThingPanelSelection(owner, scope), picked = sel.selectedThingIds;
    for (const T of _ipr.things) { const on = picked.includes(T.id); if (T.b._sel !== on) { T.b.classList.toggle('info-thing-btn-selected', on); T.b._sel = on; } }
    const things = sel.selectedThings, single = things.length <= 1, coords = [{ gx: lab.gx, gy: lab.gy }];
    _ipsText(_ipr.se, '≈' + formatInfoCurrency(things.length ? researchSelectionEnergyEstimate(owner, things) : 0));
    const shown = new Set();
    for (const entry of _buildResearchMultiStatEntries(things)) {
        const S = _ipr.stats.get(entry.groupKey);
        if (!S) continue;
        shown.add(entry.groupKey);
        _ipsShow(S.row, true);
        const first = entry.items[0], stats = entry.items.map(it => ({ kind: it.thing.kind, key: it.thing.key, statKey: it.stat.statKey }));
        _ipsText(S.name, single ? first.stat.label : entry.label);
        _ipsShow(S.m, single);
        if (single) {
            const L = researchBarLevel(owner, stats[0]);
            _ipsAttr(S.m, 'data-kind', stats[0].kind); _ipsAttr(S.m, 'data-key', stats[0].key); _ipsAttr(S.m, 'data-stat-key', stats[0].statKey);
            _ipsAttr(S.m, 'data-from-level', L.level); _ipsAttr(S.m, 'data-to-level', L.target);
        }
        _iprBar(S.bar, owner, coords, stats, null);
    }
    for (const [k, S] of _ipr.stats) if (!shown.has(k)) _ipsShow(S.row, false);
}
// The queue rows the list's scroll shows: tasks [first, first + pool).
function _iprQueueRows(lab) {
    const owner = lab.owner, task = getPlayerResearchTask(owner), queue = getPlayerResearchQueue(owner);
    const n = (task ? 1 : 0) + queue.length, at = i => task ? (i === 0 ? task : queue[i - 1]) : queue[i];
    const first = Math.max(0, Math.min(Math.max(0, n - IPR_POOL), Math.floor(_ipr.top / IPR_ROW_H) - 1));
    const end = Math.min(n, first + IPR_POOL);
    // (Each task's level: its stat's completed level plus the same stat's tasks before it.)
    const prior = new Map();
    for (let i = 0; i < first; i++) { const t = at(i), id = t.kind + ':' + t.key + ':' + t.statKey; prior.set(id, (prior.get(id) || 0) + 1); }
    const thingLevel = getResearchPreviewThingLevel(), coords = [{ gx: lab.gx, gy: lab.gy }];
    let k = 0;
    for (let i = first; i < end; i++, k++) {
        const t = at(i), R = _ipr.rows[k], id = t.kind + ':' + t.key + ':' + t.statKey, before = prior.get(id) || 0;
        prior.set(id, before + 1);
        const fromLevel = Math.min(MAX_RESEARCH_LEVEL, getPlayerResearchLevel(owner, t.kind, t.key, t.statKey) + before);
        const atMax = fromLevel >= MAX_RESEARCH_LEVEL, toLevel = atMax ? fromLevel : fromLevel + 1;
        const cost = atMax ? 0 : getResearchCost(t.kind, t.key, t.statKey, fromLevel), work = atMax ? 0 : getResearchWork(t.kind, t.key, t.statKey, fromLevel);
        let toValue = getResearchStatValueAtLevel(t.kind, t.key, t.statKey, toLevel);
        if (!Number.isFinite(toValue)) { const fv = getResearchStatValueAtLevel(t.kind, t.key, t.statKey, fromLevel); toValue = Number.isFinite(fv) ? fv : getResearchCurrentStatValue(owner, t.kind, t.key, t.statKey); }
        const base = getResearchStatValueAtLevel(t.kind, t.key, t.statKey, 0, thingLevel);
        const mult = Number.isFinite(base) && Math.abs(base) > 1e-9 && Number.isFinite(toValue) ? toValue / base : NaN;
        _ipsShow(R.row, true);
        if (R.slot !== i) { R.row.style.top = i * IPR_ROW_H + 'px'; R.slot = i; }
        const active = task && i === 0, pending = active ? -1 : i - (task ? 1 : 0);
        _ipsAttr(R.row, 'data-research-id', `${id}:${fromLevel}`);
        for (const b of [R.item, R.up, R.down]) { _ipsAttr(b, 'data-owner', owner); _ipsAttr(b, 'data-gx', lab.gx); _ipsAttr(b, 'data-gy', lab.gy); _ipsAttr(b, 'data-active', active ? '1' : '0'); _ipsAttr(b, 'data-pending-index', pending); }
        _ipsAttr(R.m, 'data-kind', t.kind); _ipsAttr(R.m, 'data-key', t.key); _ipsAttr(R.m, 'data-stat-key', t.statKey); _ipsAttr(R.m, 'data-from-level', fromLevel); _ipsAttr(R.m, 'data-to-level', toLevel);
        const thing = getResearchThing(t.kind, t.key), stat = getResearchStatEntry(t.kind, t.key, t.statKey);
        _ipsShow(R.ib, !!thing);
        if (thing && R.img._k !== thing.key) { R.img.src = getItemThumbnail(thing.key, 18); R.img.alt = thing.label || thing.key; R.ib.style.borderRadius = thing.kind === 'unit' ? '50%' : '4px'; R.img.style.borderRadius = thing.kind === 'unit' ? '50%' : ''; R.img._k = thing.key; }
        _ipsText(R.lb, (thing ? '' : `${t.kind}:${t.key} / `) + (stat ? stat.label : (t.statKey || 'stat')));
        _ipsAttr(R.lb, 'title', thing ? thing.label : `${t.kind}:${t.key}`);
        _ipsText(R.mul, 'x' + formatResearchMultiplierValue(mult));
        _iprBar(R.bar, owner, coords, [{ kind: t.kind, key: t.key, statKey: t.statKey }], toLevel);
        const p = researchTaskEnergyProgress(t, { cost, work }), done = Math.max(0, Math.min(p.cost, p.paid)), pct = p.cost > 0 ? done / p.cost : 0;
        const w = (Math.max(0, Math.min(1, pct)) * 100).toFixed(1) + '%';
        if (R.pf._w !== w) { R.pf.style.width = w; R.pf._w = w; }
        _ipsText(R.pt, `${formatInfoCurrency(done)}/${formatInfoCurrency(p.cost)}`);
    }
    for (; k < _ipr.rows.length; k++) { _ipsShow(_ipr.rows[k].row, false); _ipr.rows[k].slot = -1; }
}

// ---- the player status (nothing selected) ----
// Every row it can have made once (hud.js buildInfoPanelEnergyDeltaHtml,
// buildInfoPanelAstarBudgetHtml, buildInfoPanelIdleWorkersHtml and
// utils_networking.js buildInfoPanelPlayerStatusHtml are its markup): a row
// per metric, per unit type and per building type, in the order those sort
// them; a refresh shows the rows with something and writes their values.
// The online players' and network rows are made again only when the players
// change (a join, a leave, the ping/remove toggles), not per refresh.
const _ipst = { host: null, sec: {}, rows: [], peers: null, net: null };
const _IPST_SEP = '<div style="border-bottom:1px solid #333;margin:4px 0"></div>';
const _ipstWinBtn = (cls, metric) => `<button class="${cls}" data-metric="${_ipsEsc(metric)}" style="cursor:pointer;background:#1b1b1b;color:#9dd;border:1px solid #3b4a52;border-radius:3px;font-size:10px;line-height:1;padding:1px 5px;min-width:34px;text-align:center"></button>`;
const _ipstVal = w => `<span class="info-value ipst-v" style="flex:0 0 ${w}px;min-width:${w}px;padding-left:${w === 84 ? 4 : 6}px;text-align:right;font-variant-numeric:tabular-nums;color:#ddd"></span>`;
// A rate row: window button, the thing's select button, the value.
function _ipstRateRow(cls, metric, domain, filterKey, thumb, title) {
    return `<div class="info-row ipst-r" style="margin:0;gap:6px;align-items:center">${_ipstWinBtn(cls, metric)}${_buildInfoPanelThingSelectableVisualHtml(domain, filterKey, thumb, 40, title)}${_ipstVal(84)}</div>`;
}
function _ipstTitle(key, title, controls) { return `<div class="ipst-t" data-k="${key}">${_buildCollapsibleInfoSectionTitle(key, title, controls)}</div>`; }
function _ipstStatusMarkup() {
    const P = _ipst.plan = { e: [], a: [], u: [], b: [] };
    const units = Object.keys(BASE_UNIT_STATS), cards = Object.keys(BASE_CARD_TYPES);
    const towers = (typeof BUILD_CATEGORIES !== 'undefined' && BUILD_CATEGORIES.towers) || [];
    const byLabel = f => (a, b) => f(a).localeCompare(f(b));
    let h = '';
    // Energy rates.
    h += _ipstTitle('energyDelta', '⚡/ s', _buildInfoPanelRosterModeButtonHtml('all-owned', 'total', 'all', 'All', 'Select all owned units and buildings', 28) + _ipstWinBtn('info-energy-delta-window-btn', 'total') + _ipstVal(84));
    h += '<div class="ipst-body" data-k="energyDelta">';
    const eFixed = [['collect', 'collector'], ['salvage', 'salvager_unit'], ['research', 'researcher_unit'], ['builder', 'builder_unit'], ['healer', 'healer_unit']];
    for (const [m, u] of eFixed) { P.e.push({ kind: 'fixed', metric: m, src: m, upkeep: m }); h += _ipstRateRow('info-energy-delta-window-btn', m, 'units', u, { thumbKey: u, isUnit: true }, `Select all ${_infoPanelFilterName('units', u)}`); }
    if (SHRINES_ENABLED) { P.e.push({ kind: 'fixed', metric: 'shrine', src: 'shrine', upkeep: 'shrine', fine: true }); h += _ipstRateRow('info-energy-delta-window-btn', 'shrine', 'buildings', 'shrine', { thumbKey: 'shrine', isUnit: false }, `Select all ${_infoPanelFilterName('buildings', 'shrine')}`); }
    const explicit = new Set(eFixed.map(x => x[1]));
    P.e.push({ kind: 'sep', group: 'u' }); h += `<div class="ipst-r">${_IPST_SEP}</div>`;
    for (const u of units.filter(u => !explicit.has(u)).sort(byLabel(_prettyUnitTypeLabel))) { P.e.push({ kind: 'unit', type: u, metric: 'unit_' + u }); h += _ipstRateRow('info-energy-delta-window-btn', 'unit_' + u, 'units', u, { thumbKey: u, isUnit: true }, `Select all ${getUnitDisplayName(u)}`); }
    P.e.push({ kind: 'sep', group: 'b' }); h += `<div class="ipst-r">${_IPST_SEP}</div>`;
    for (const b of cards.slice().sort(byLabel(_prettyBuildingTypeLabel))) { P.e.push({ kind: 'building', type: b, metric: 'building_' + b }); h += _ipstRateRow('info-energy-delta-window-btn', 'building_' + b, 'buildings', b, { thumbKey: b, isUnit: false }, `Select all ${_prettyBuildingTypeLabel(b)}`); }
    h += '</div>' + _IPST_SEP;
    // ★ rates.
    h += _ipstTitle('astarDelta', '★ / s', _buildInfoPanelRosterModeButtonHtml('all-owned', 'total', 'all', 'All', 'Select all owned units and buildings', 28) + _ipstWinBtn('info-astar-window-btn', 'total') + _ipstVal(84));
    h += '<div class="ipst-body" data-k="astarDelta">';
    const aFixed = [['astarCollector', 'astar_collector', ev => ev.unitType === 'astar_collector'], ['king', 'king', ev => ev.unitMetric === 'king'], ['collector', 'collector', ev => ev.unitMetric === 'collector'],
        ['salvager', 'salvager_unit', ev => ev.unitMetric === 'salvager'], ['builder', 'builder_unit', ev => ev.unitMetric === 'builder'], ['healer', 'healer_unit', ev => ev.unitMetric === 'healer'], ['researcher', 'researcher_unit', ev => ev.unitMetric === 'researcher']];
    for (const [m, u, f] of aFixed) { P.a.push({ kind: 'fixed', metric: m, match: f }); h += _ipstRateRow('info-astar-window-btn', m, 'units', u, { thumbKey: u, isUnit: true }, `Select all ${_infoPanelFilterName('units', u)}`); }
    if (SHRINES_ENABLED) { P.a.push({ kind: 'fixed', metric: 'shrine', match: ev => ev.source === 'shrine', fine: true }); h += _ipstRateRow('info-astar-window-btn', 'shrine', 'buildings', 'shrine', { thumbKey: 'shrine', isUnit: false }, `Select all ${_infoPanelFilterName('buildings', 'shrine')}`); }
    const special = new Set(['king', 'collector', 'astar_collector', 'salvager_unit', 'builder_unit', 'healer_unit', 'researcher_unit']);
    for (const u of units.filter(u => !special.has(u)).sort()) { P.a.push({ kind: 'unit', type: u, metric: 'u_' + u, match: ev => ev.unitType === u }); h += _ipstRateRow('info-astar-window-btn', 'u_' + u, 'units', u, { thumbKey: u, isUnit: true }, `Select all ${_infoPanelFilterName('units', u)}`); }
    P.a.push({ kind: 'sep', group: 'b' }); h += `<div class="ipst-r">${_IPST_SEP}</div>`;
    for (const b of cards.slice().sort(byLabel(_prettyBuildingTypeLabel))) { P.a.push({ kind: 'building', type: b, metric: 'b_' + b }); h += _ipstRateRow('info-astar-window-btn', 'b_' + b, 'buildings', b, { thumbKey: b, isUnit: false }, `Select all ${_infoPanelFilterName('buildings', b)}`); }
    h += '</div>' + _IPST_SEP;
    // Units and buildings: idle / total by type.
    h += _ipstTitle('units', 'Units', _buildInfoPanelRosterModeButtonHtml('units', 'total', 'all', 'All', 'Select all units', 28) + _buildInfoPanelRosterModeButtonHtml('units', 'total', 'idle', 'Idle', 'Select idle units', 35) + _ipstVal(72));
    h += '<div class="ipst-body" data-k="units">';
    for (const u of units.slice().sort(_compareInfoPanelUnitTypes)) { P.u.push({ key: u }); h += `<div class="ipst-r">${_buildInfoPanelRosterRow('units', u, _prettyUnitTypeLabel(u), 0, 0, 'units')}</div>`; }
    h += '</div>' + _IPST_SEP;
    h += _ipstTitle('buildings', 'Buildings', _buildInfoPanelRosterModeButtonHtml('buildings', 'total', 'all', 'All', 'Select all buildings', 28) + _buildInfoPanelRosterModeButtonHtml('buildings', 'total', 'idle', 'Idle', 'Select idle buildings', 35) + _ipstVal(72));
    h += '<div class="ipst-body" data-k="buildings">';
    // (getFrameBuildingSummary's keys: tower:<type>, barrack:<unit type>, else the type.)
    // (A type outside the towers' list can still be a tower (the cloud portals): both keys, the one it has shows.)
    const bkeys = cards.flatMap(t => t.startsWith('barrack_') ? [{ key: 'barrack:' + t.slice(8), stats: t }] : towers.includes(t) ? [{ key: 'tower:' + t, stats: t }] : [{ key: t, stats: t }, { key: 'tower:' + t, stats: t }]);
    for (const b of bkeys.sort((x, y) => getBuildingDisplayName(x.stats).localeCompare(getBuildingDisplayName(y.stats)))) { P.b.push(b); h += `<div class="ipst-r">${_buildInfoPanelRosterRow('buildings', b.key, getBuildingDisplayName(b.stats), 0, 0, 'buildings')}</div>`; }
    h += '</div>' + _IPST_SEP;
    h += '<div class="ipst-online"></div>';
    return h;
}
function infoStatusStaticMake(host) {
    _ipst.host = host; _ipst.sec = {}; _ipst.peers = null; _ipst.net = null;
    if (!host) return;
    host.innerHTML = _ipstStatusMarkup();
    for (const t of host.querySelectorAll('.ipst-t')) {
        const k = t.dataset.k, arrow = t.querySelector('button.info-section-toggle');
        _ipst.sec[k] = { arrow, win: t.querySelector('[data-metric]'), v: t.querySelector('.ipst-v'), body: host.querySelector(`.ipst-body[data-k="${k}"]`) };
        _ipst.sec[k].body._h = false;
    }
    const rowsOf = k => [..._ipst.sec[k].body.children].map(el => { el._h = false; return { el, win: el.querySelector('[data-metric]'), v: el.querySelector('.ipst-v') || el.querySelector('.info-value') }; });
    _ipst.rows = { e: rowsOf('energyDelta'), a: rowsOf('astarDelta'), u: rowsOf('units'), b: rowsOf('buildings') };
    _ipst.online = host.querySelector('.ipst-online');
    bindInfoPanelPlayerStatusControls(host);
}
function _ipstSection(k, controlsValue, color) {
    const S = _ipst.sec[k], collapsed = _isInfoSectionCollapsed(k), title = S.arrow.getAttribute('title') || '';
    _ipsText(S.arrow, collapsed ? '▸' : '▾');
    _ipsAttr(S.arrow, 'title', title.replace(/^(Expand|Collapse)/, collapsed ? 'Expand' : 'Collapse'));
    _ipsShow(S.body, !collapsed);
    if (S.v && controlsValue !== undefined) { _ipsText(S.v, controlsValue); if (color) _ipsColor(S.v, color); }
    return !collapsed;
}
function _ipstWin(btn, sec) { _ipsText(btn, sec + 's'); _ipsAttr(btn, 'title', `Window: ${sec}s (click to cycle 1s/10s/30s/60s)`); }
const _ipstFmt = v => !Number.isFinite(v) || Math.abs(v) < 0.05 ? '0.0' : `${v > 0 ? '+' : ''}${formatBigNumber(v, 1)}`;
const _ipstFine = v => !Number.isFinite(v) || Math.abs(v) < 0.0005 ? '0.0' : Math.abs(v) >= 0.05 ? _ipstFmt(v) : `${v > 0 ? '+' : ''}${v.toFixed(Math.abs(v) < 0.005 ? 4 : 3)}`;
// The ★ log's rates of every row, one pass a window length (_getPlayerAstarDeltaRate's sums).
function _ipstAstarRates(owner, plan) {
    const out = new Float64Array(plan.length + 1), bucket = _ensureAstarLogPlayer(owner);
    if (!bucket || !bucket.length) return out;
    const wins = new Map();
    const want = (i, sec) => { let a = wins.get(sec); if (!a) wins.set(sec, a = []); a.push(i); };
    want(plan.length, Math.max(1, Number(getAstarWindowSeconds('total')) || ENERGY_DELTA_DEFAULT_WINDOW_SECONDS));
    for (let i = 0; i < plan.length; i++) if (plan[i].match) want(i, Math.max(1, Number(getAstarWindowSeconds(plan[i].metric)) || ENERGY_DELTA_DEFAULT_WINDOW_SECONDS));
    let longest = 1; for (const s of wins.keys()) if (s > longest) longest = s;
    _pruneTickLogBucket(bucket, gameTime - Math.max(Math.floor(TICK_RATE * longest) * 2, Math.floor(TICK_RATE * ASTAR_USAGE_LOG_MAX_SECONDS)));
    for (const [sec, rows] of wins) {
        const cutoff = gameTime - Math.max(1, Math.floor(TICK_RATE * sec));
        for (let k = 0; k < bucket.length; k++) {
            const ev = bucket[k];
            if (!ev || !Number.isFinite(ev.tick) || ev.tick < cutoff) continue;
            const d = Number.isFinite(Number(ev.delta)) ? Number(ev.delta) : -(Math.max(0, Number(ev.used) || 0));
            for (const i of rows) if (i === plan.length || plan[i].match(ev)) out[i] += d;
        }
        for (const i of rows) out[i] /= sec;
    }
    return out;
}
// (true: something to show.)
function infoStatusStaticWrite() {
    if (!_ipst.host || !gameStarted) return false;
    const owner = localPlayerId;
    if (!Number.isFinite(owner) || owner < 0 || owner >= players.length) { _ipstOnline(); return false; }
    const P = _ipst.plan, R = _ipst.rows;
    // Energy.
    const up = typeof getPlayerUpKeepBreakdown === 'function' ? getPlayerUpKeepBreakdown(owner) : { total: 0, unitTypes: {}, buildingTypes: {} };
    const uT = up.unitTypes || {}, bT = up.buildingTypes || {};
    const upOf = m => m === 'total' ? Math.max(0, Number(up.total) || 0) : m === 'collect' ? Math.max(0, Number(uT.collector) || 0) : m === 'salvage' ? Math.max(0, Number(uT.salvager_unit) || 0)
        : m === 'research' ? Math.max(0, Number(uT.researcher_unit) || 0) : m === 'builder' ? Math.max(0, Number(uT.builder_unit) || 0) : m === 'healer' ? Math.max(0, Number(uT.healer_unit) || 0) : 0;
    const color = v => getDeltaRateColor(v, 'energy', owner);
    const totalSec = getEnergyDeltaWindowSeconds('total'), total = getPlayerEnergyDeltaRate(owner, '', totalSec) - upOf('total');
    _ipstWin(_ipst.sec.energyDelta.win, totalSec);
    if (_ipstSection('energyDelta', _ipstFmt(total) + ' ⚡/ s', color(total))) {
        let anyU = false, anyB = false;
        for (let i = 0; i < P.e.length; i++) {
            const p = P.e[i], r = R.e[i];
            if (p.kind === 'sep') continue;
            let show = true, sec, value;
            if (p.kind === 'fixed') { sec = getEnergyDeltaWindowSeconds(p.metric); value = getPlayerEnergyDeltaRate(owner, p.src, sec) - upOf(p.upkeep); }
            else if (p.kind === 'unit') { const k = Math.max(0, Number(uT[p.type]) || 0); show = k > 0; if (show) { anyU = true; sec = getEnergyDeltaWindowSeconds(p.metric); value = -k; } }
            else { const k = Math.max(0, Number(bT[p.type]) || 0); show = k > 0; if (show) { anyB = true; sec = totalSec; value = -k; } }
            _ipsShow(r.el, show);
            if (!show) continue;
            _ipstWin(r.win, sec); _ipsText(r.v, (p.fine ? _ipstFine : _ipstFmt)(value) + ' ⚡/ s'); _ipsColor(r.v, color(value));
        }
        for (let i = 0; i < P.e.length; i++) if (P.e[i].kind === 'sep') _ipsShow(R.e[i].el, P.e[i].group === 'u' ? anyU : anyB);
    }
    // ★.
    const rates = _ipstAstarRates(owner, P.a), aColor = v => getDeltaRateColor(v, 'astar', owner), aTotal = rates[P.a.length];
    _ipstWin(_ipst.sec.astarDelta.win, getAstarWindowSeconds('total'));
    if (_ipstSection('astarDelta', _ipstFmt(aTotal) + ' ★ / s', aColor(aTotal))) {
        const summary = typeof getFrameUnitSummary === 'function' ? getFrameUnitSummary(owner) : null;
        let anyB = false;
        for (let i = 0; i < P.a.length; i++) {
            const p = P.a[i], r = R.a[i];
            if (p.kind === 'sep') continue;
            let show = true;
            if (p.kind === 'unit') { const g = summary ? summary.get(p.type) : null; show = !!(g && g.total > 0); }
            else if (p.kind === 'building') { show = !!bT[p.type]; if (show) anyB = true; }
            _ipsShow(r.el, show);
            if (!show) continue;
            const v = p.kind === 'building' ? 0 : rates[i];
            _ipstWin(r.win, getAstarWindowSeconds(p.metric)); _ipsText(r.v, (p.fine ? _ipstFine : _ipstFmt)(v) + ' ★ / s'); _ipsColor(r.v, aColor(v));
        }
        for (let i = 0; i < P.a.length; i++) if (P.a[i].kind === 'sep') _ipsShow(R.a[i].el, anyB);
    }
    // Rosters (the frame's counts by type).
    const fu = typeof getFrameUnitSummary === 'function' ? getFrameUnitSummary(owner) : null, fb = typeof getFrameBuildingSummary === 'function' ? getFrameBuildingSummary(owner) : null;
    let uIdle = 0, uTotal = 0;
    if (fu) for (const g of fu.values()) { uIdle += g.idle; uTotal += g.total; }
    if (_ipstSection('units', `${uIdle} / ${uTotal}`)) for (let i = 0; i < P.u.length; i++) {
        const g = fu ? fu.get(P.u[i].key) : null, show = !!(g && g.total > 0);
        _ipsShow(R.u[i].el, show);
        if (show) _ipsText(R.u[i].v, `${g.idle} / ${g.total}`);
    }
    if (_ipstSection('buildings', fb ? `${fb.idle} / ${fb.total}` : '0 / 0')) for (let i = 0; i < P.b.length; i++) {
        const g = fb ? fb.groups.get(P.b[i].key) : null, show = !!(g && g.total > 0);
        _ipsShow(R.b[i].el, show);
        if (show) _ipsText(R.b[i].v, `${g.idle} / ${g.total}`);
    }
    _ipstOnline();
    return true;
}
// Online players and the network (multiplayer): their rows made again when
// the players or the toggles change, values written per refresh.
function _ipstOnline() {
    const host = _ipst.online;
    const mp = isMultiplayer && gameStarted && Array.isArray(lobbyPlayers) && lobbyPlayers.length > 0;
    _ipsShow(host, mp);
    if (!mp) return;
    const peers = lobbyPlayers.filter(lp => lp && lp.peerId);
    const key = peers.map(lp => lp.peerId + '\u0001' + (lp.name || '')).join('\u0002') + '|' + infoPanelShowPing + infoPanelShowHostRemoveButtons + isHost + _isInfoSectionCollapsed('network');
    if (_ipst.peers !== key) {
        _ipst.peers = key;
        const setup = computeTeamSetupFromLobby();
        let h = '<div class="info-title">Online Players</div><div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:2px 0 5px 0;color:#9aa;font-size:10px;">'
            + `<label style="display:inline-flex;align-items:center;gap:4px;cursor:pointer;"><input id="info-toggle-show-ping" type="checkbox" ${infoPanelShowPing ? 'checked' : ''} /> Ping</label>`
            + (isHost ? `<label style="display:inline-flex;align-items:center;gap:4px;cursor:pointer;"><input id="info-toggle-show-remove" type="checkbox" ${infoPanelShowHostRemoveButtons ? 'checked' : ''} /> Remove Buttons</label>` : '') + '</div>';
        for (const lp of peers) {
            const teamId = setup.teamByPeer[lp.peerId], teamColor = Number.isFinite(teamId) ? (teamColorById[teamId] || PLAYER_COLORS[teamId] || '#888') : '#888', name = _escapeHtml(lp.name || defaultLobbyName(lp.peerId));
            h += `<div class="info-row ipst-p" style="align-items:center;gap:6px"><span style="display:inline-block;width:9px;height:9px;border-radius:50%;background:${teamColor};border:1px solid #444;flex:0 0 auto"></span>`
                + `<span class="info-label" style="color:#ddd;flex:1 1 48px;min-width:48px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis" title="${name}">${name}</span>`
                + (infoPanelShowPing ? '<span class="info-value ipst-ping" style="flex:0 0 auto;color:#8cf;text-align:right;min-width:56px" title="Round trip time"></span>' : '')
                + '<span class="info-value ipst-state" style="flex:0 0 auto;text-align:right"></span>'
                + (isHost && infoPanelShowHostRemoveButtons && lp.peerId !== myPeerId ? `<button class="host-remove-player-btn" data-peer-id="${_escapeHtml(lp.peerId)}" style="cursor:pointer;background:#2a1111;color:#f88;border:1px solid #744;border-radius:3px;font-size:10px;padding:2px 6px">Remove</button>` : '') + '</div>';
        }
        // (The network rows: buildNetworkInfoPanelHtml's, values written below.)
        h += `<div class="ipst-net">${_buildCollapsibleInfoSectionTitle('network', 'Network', `<span style="color:#8ab;font-size:10px">${TICK_RATE} TPS · auto</span>`)}`;
        if (!_isInfoSectionCollapsed('network')) {
            for (const id of ['tps', 'cmd', 'delay', 'ping', 'wait', 'desync', 'resend', 'host', 'repair', 'last'])
                h += `<div class="info-row ipst-n" data-n="${id}" style="gap:6px"><span class="info-label" style="color:#9aa"></span><span class="info-value" style="font-variant-numeric:tabular-nums"></span></div>`;
            h += '<table style="width:100%;border-collapse:collapse;font-size:10px;color:#abc;margin-top:3px"><tr style="color:#789"><th style="text-align:left">Player</th><th style="padding-left:6px;text-align:right">Ping</th><th style="padding-left:6px;text-align:right">Jitter</th><th style="padding-left:6px;text-align:right" title="Input delay in ticks">Delay</th><th style="padding-left:6px;text-align:right" title="Share of the last 10s spent waiting">Wait</th><th></th></tr>';
            for (const lp of peers) h += `<tr class="ipst-np"><td style="color:#ddd;max-width:84px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${_escapeHtml(lp.name || defaultLobbyName(lp.peerId))}</td><td style="padding-left:6px;text-align:right"></td><td style="padding-left:6px;text-align:right"></td><td style="padding-left:6px;text-align:right"></td><td style="padding-left:6px;text-align:right"></td><td style="color:#fc8"></td></tr>`;
            h += '</table>';
        }
        h += '</div>';
        host.innerHTML = h;
        bindInfoPanelPlayerStatusControls(host);
        _ipst.net = { players: [...host.querySelectorAll('.ipst-p')].map(el => ({ ping: el.querySelector('.ipst-ping'), state: el.querySelector('.ipst-state') })),
            rows: Object.fromEntries([...host.querySelectorAll('.ipst-n')].map(el => [el.dataset.n, { el, l: el.children[0], v: el.children[1] }])),
            table: [...host.querySelectorAll('.ipst-np')].map(tr => [...tr.children]) };
        for (const r of Object.values(_ipst.net.rows)) r.el._h = false;
    }
    const N = _ipst.net, setup = computeTeamSetupFromLobby(), now = performance.now();
    peers.forEach((lp, i) => {
        const P = N.players[i]; if (!P) return;
        const state = getPeerMatchState(lp.peerId, setup);
        if (P.ping) _ipsText(P.ping, getPeerLatencyLabel(lp.peerId));
        _ipsText(P.state, state === 'spectator' ? 'Spectator' : state === 'left' ? 'Disconnected' : state === 'removed' ? 'Removed' : 'Playing');
        _ipsColor(P.state, state === 'spectator' ? '#fc8' : state === 'left' ? '#f88' : state === 'removed' ? '#f66' : '#9f9');
    });
    if (!N.rows.tps) return;
    const row = (id, show, label, value, color = '#cde') => { const r = N.rows[id]; _ipsShow(r.el, show); if (!show) return; _ipsText(r.l, label); _ipsText(r.v, value); _ipsColor(r.v, color); };
    const delayTicks = Math.floor(Number(LOCKSTEP_PIPELINE_TICKS) || 0), tps = netCompletedSimulationTps() ?? (Number(_tpsDisplay) || 0), lead = netCommandLeadTicks(), seen = Math.min(TICK_RATE, Math.max(1, tps || TICK_RATE)), stall = netStallPercent(now);
    row('tps', true, 'Tick rate', `${Math.round(tps * 10) / 10} / ${TICK_RATE} TPS`, tps >= TICK_RATE * 0.9 ? '#9f9' : '#fc8');
    row('cmd', true, 'Command delay', `${lead} ticks (~${Math.round(lead * 1000 / seen)} ms) · equal for all`);
    const link = isHost ? null : netGetHostLinkStats();
    row('delay', true, isHost ? 'Your input delay' : 'Input delay', isHost ? `${delayTicks} ticks (${Math.round(delayTicks * TICK_MS)} ms)` : `${delayTicks} ticks (${Math.round((delayTicks + 1) * TICK_MS)} ms) auto`);
    row('ping', !isHost, 'Ping to host', link && Number.isFinite(link.srtt) ? `${Math.round(link.srtt)} ms ±${Math.round(link.rttvar)}` : '--');
    row('wait', true, 'Waiting (10s)', `${stall.toFixed(1)}%`, stall < 2 ? '#9f9' : stall < 10 ? '#fc8' : '#f88');
    const C = netCounters;
    row('desync', true, 'Desyncs', `${C.desyncsDetected} · ${C.patches + C.fullPatches} patched · ${C.hardResyncs} full resyncs`, C.desyncsDetected > 0 ? '#fc8' : '#cde');
    row('resend', true, 'Resend requests', `${C.resendRequestsSent} sent · ${C.resendRequestsServed} served`);
    row('host', C.hostMigrations > 0, 'Host changes', String(C.hostMigrations), '#fc8');
    row('repair', !!C.lastSnapshotAt, 'Last repair', C.lastSnapshotAt ? `${Math.round(C.snapshotBytes / 1024)} KB · ${Math.round(isHost ? C.snapshotBuildMs : C.snapshotApplyMs)} ms${!isHost && C.patchStallMs > 0 ? ` · waited ${Math.round(C.patchStallMs)} ms` : ''} · ${_formatSecs(now - C.lastSnapshotAt)} ago` : '');
    row('last', C.lastDesyncTick >= 0, 'Last desync', `tick ${C.lastDesyncTick}${C.lastDesyncParts ? ` (${C.lastDesyncParts})` : ''}`, '#fc8');
    peers.forEach((lp, i) => {
        const T = N.table[i]; if (!T) return;
        const pid = lp.peerId, self = pid === myPeerId;
        let r = netRemoteReportByPeer[pid] || null;
        if (self) r = netLocalReport(now);
        let rtt = isHost ? (self ? 0 : (netGetLinkStats(pid) || {}).srtt) : (r ? r.srtt : null);
        if (!isHost && pid === wsHostId) rtt = 0;
        const jitter = isHost ? (self ? 0 : (netGetLinkStats(pid) || {}).rttvar) : (r ? r.jitter : null), delay = r ? r.inputDelay : null, sp = r ? r.stallPct : null;
        const flags = [];
        if (r && r.hidden) flags.push('tab hidden');
        if (isHost && netDisconnectedSinceByPeer[pid]) flags.push('offline');
        _ipsText(T[1], _fmtMs(rtt)); _ipsText(T[2], Number.isFinite(jitter) ? '±' + Math.round(jitter) : '--'); _ipsText(T[3], Number.isFinite(delay) ? delay : '--');
        _ipsText(T[4], Number.isFinite(sp) ? sp.toFixed(0) + '%' : '--'); _ipsColor(T[4], (sp || 0) < 2 ? '#9f9' : '#fc8'); _ipsText(T[5], flags.join(', '));
    });
}
