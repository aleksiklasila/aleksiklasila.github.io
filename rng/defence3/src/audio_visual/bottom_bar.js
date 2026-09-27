"use strict";

// Bottom bar between the side panels.
//  - Things row: every thing type; owned ones first in the order they first
//    appeared (drag to reorder, visual only), then the never-owned ones. Click
//    opens a menu: rates, production queue, shop and selection.
//  - Research row: the shared research queue, active task on the left. Click a
//    task for its details; drag to reorder; drag a thing from the things row in
//    to insert upgrades at that position.

const BB_REFRESH_MS = 250;
const BB_DRAG_THRESHOLD_PX = 5;
const BB_DROP_FREEZE_MS = 1500;
const BB_MAX_EMPTY_SLOTS = 200;
const BB_WORKER_ENERGY_SOURCE = {
    collector: 'collect', salvager_unit: 'salvage', researcher_unit: 'research', builder_unit: 'builder', healer_unit: 'healer'
};
// Research stat shorthands for the queue items, at most 3 characters.
const BB_STAT_ABBR = {
    maxLevel: 'lvl', maxEnergy: '⚡', energy: '⚡', upKeep: '⚡s', unitPrice: 'u⚡', astarCost: '★t',
    popCap: 'pop', damage: 'dmg', blastDamage: 'bdm', blastRadius: 'brd', cd: 'cd', spawnCd: 'scd',
    visionRange: 'vis', multiplier: 'mul', efficiency: 'eff', watchDuration: 'wch',
    burnDps: 'brn', burnDuration: 'brt', poisonDps: 'psn', poisonDuration: 'pst',
    freezeDps: 'frz', freezeDuration: 'frt', wetDuration: 'wet', sandDuration: 'slw',
    speed: 'spd', atk: 'atk', attackRange: 'rng', atkCd: 'acd', transferCooldown: 'tcd',
    workerSearchDistance: 'dst', gatherPerTrip: 'wrk', builderDps: 'wrk', healerDps: 'wrk', researcherDps: 'wrk',
};

let bb = {
    els: null,
    order: [],              // owned thing ids in display order
    known: new Set(),
    owner: -1,
    lastGameTime: -1,
    lastRefresh: 0,
    things: new Map(),      // id -> { id, kind, key, isUnit, count, idle }
    thingsSig: '',
    researchSig: '',
    press: null,            // pointer press / drag state
    menu: null,             // { type: 'thing' | 'task' | 'drop', id, task, el, anchor, insertAt, added, html, pressed }
    freezeUntil: 0,
    freezeOrderSig: '',
};

function _bbEscape(s) {
    return String(s === undefined || s === null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Whole numbers, compact above 1000 (4 -> "4", 12345 -> "12.3K").
function _bbFmtInt(n) {
    n = Math.max(0, Math.floor(Number(n) || 0));
    return n < 1000 ? String(n) : formatBigNumber(n, 1);
}

function _bbThingLabel(kind, key) {
    return kind === 'unit' ? getUnitDisplayName(key) : getBuildingDisplayName(key);
}

// Outline colour by category, so kinds read at a glance.
const BB_CATEGORY = {
    unit: { color: '#ff9f43', label: 'Combat unit' },
    worker: { color: '#48dbfb', label: 'Worker unit' },
    barrack: { color: '#ff6b6b', label: 'Barrack' },
    turret: { color: '#b18cff', label: 'Turret' },
    producer: { color: '#3ddc84', label: 'Worker building' },
    floor: { color: '#d4a373', label: 'Floor' },
    other: { color: '#f6e05e', label: 'Building' },
};

function _bbThingCategory(kind, key) {
    if (kind === 'unit') return (BASE_UNIT_STATS[key] || {}).isWorker ? 'worker' : 'unit';
    if (key.startsWith('barrack_')) return 'barrack';
    if (BUILD_CATEGORIES.towers.includes(key)) return 'turret';
    if (BUILD_CATEGORIES.floor.includes(key)) return 'floor';
    if (getSpawnedUnitTypeForBuildingKey(key)) return 'producer';
    return 'other';
}

function _bbThingColor(kind, key) {
    return BB_CATEGORY[_bbThingCategory(kind, key)].color;
}

function _bbTaskStatId(t) {
    return `${t.kind}:${t.key}:${t.statKey}`;
}

function _bbStatAbbrHtml(statKey, label) {
    let abbr = BB_STAT_ABBR[statKey] || String(label || statKey).replace(/[^a-z]/gi, '').slice(0, 3).toLowerCase();
    return _bbEscape(abbr).replace('★', '<span class="bb-star">★</span>');
}

// ---------------------------------------------------------------- data

function _bbCollectThings(owner) {
    let map = new Map();
    let add = (kind, key, idle) => {
        if (!key) return;
        let id = `${kind}:${key}`;
        let info = map.get(id);
        if (!info) {
            info = { id, kind, key, isUnit: kind === 'unit', count: 0, idle: 0 };
            map.set(id, info);
        }
        info.count++;
        if (idle) info.idle++;
    };
    for (let u of units) {
        if (!u || u.dead || u.owner !== owner) continue;
        add('unit', String(u.unitType || ''), _isInfoPanelUnitIdleLike(u));
    }
    for (let e of _getOwnedInfoPanelBuildings(owner)) {
        add('building', String(getEntityStatsCalcType(e) || ''), _isInfoPanelBuildingIdleLike(e));
    }
    return map;
}

// First-seen order: a new batch is sorted (shop order, then units) and
// appended after everything already shown.
function _bbSyncOrder(map) {
    let fresh = [];
    for (let id of map.keys()) if (!bb.known.has(id)) fresh.push(map.get(id));
    if (fresh.length <= 0) return;
    let shopOrder = [];
    for (let tab of Object.keys(BUILD_CATEGORIES)) shopOrder.push(...BUILD_CATEGORIES[tab]);
    let rank = (info) => info.isUnit ? 1e6 : (shopOrder.indexOf(info.key) >= 0 ? shopOrder.indexOf(info.key) : 1e5);
    fresh.sort((a, b) => {
        let d = rank(a) - rank(b);
        if (d) return d;
        return a.isUnit ? _compareInfoPanelUnitTypes(a.key, b.key) : a.key.localeCompare(b.key);
    });
    for (let info of fresh) {
        bb.known.add(info.id);
        bb.order.push(info.id);
    }
}

// Things never owned yet, in shop order and then units; shown after the owned ones.
function _bbUnownedIds() {
    let out = [];
    let seen = new Set();
    let push = (id) => {
        if (bb.known.has(id) || seen.has(id)) return;
        seen.add(id);
        out.push(id);
    };
    for (let tab of Object.keys(BUILD_CATEGORIES)) {
        for (let key of BUILD_CATEGORIES[tab]) if (BASE_CARD_TYPES[key]) push(`building:${key}`);
    }
    for (let t of RESEARCH_THINGS) if (t.kind === 'building') push(`building:${t.key}`);
    let unitKeys = RESEARCH_THINGS.filter(t => t.kind === 'unit').map(t => t.key).sort(_compareInfoPanelUnitTypes);
    for (let key of unitKeys) push(`unit:${key}`);
    return out;
}

function _bbThingInfo(id) {
    let info = bb.things.get(id);
    if (info) return info;
    let [kind, key] = String(id).split(':');
    return { id, kind, key, isUnit: kind === 'unit', count: 0, idle: 0 };
}

function _bbOrderedTasks(owner) {
    let p = ensurePlayerResearchQueueState(owner);
    let out = [];
    if (p.researchTask) out.push(p.researchTask);
    for (let t of p.researchQueue) if (t) out.push(t);
    return out;
}

function _bbResearchLab(owner) {
    let labs = getOwnedActiveResearchLabs(owner);
    return labs.length > 0 ? labs[0] : null;
}

// Share of a task's work (and energy) already done.
function _bbTaskProgress(t) {
    let req = Math.max(0, Number(t.workRequired) || 0);
    return req > 0 ? Math.max(0, Math.min(1, (Number(t.workDone) || 0) / req)) : 0;
}

// Producers of a thing: the buildings that spawn it (a unit) or the building
// type itself when it spawns something.
function _bbProducerKeysForThing(info) {
    if (!info.isUnit) return getSpawnedUnitTypeForBuildingKey(info.key) ? [info.key] : [];
    let out = [];
    for (let key in BASE_CARD_TYPES) {
        if (getSpawnedUnitTypeForBuildingKey(key) === info.key) out.push(key);
    }
    return out;
}

function _bbShopKeyForThing(info) {
    let inShop = (key) => Object.keys(BUILD_CATEGORIES).some(tab => BUILD_CATEGORIES[tab].includes(key));
    if (!info.isUnit) return inShop(info.key) ? info.key : null;
    return _bbProducerKeysForThing(info).find(inShop) || null;
}

function _bbProducerQueueState(info, owner) {
    let keys = _bbProducerKeysForThing(info);
    if (keys.length <= 0) return null;
    let isWorker = !keys[0].startsWith('barrack_');
    let pool = isWorker
        ? collectorSpawners.filter(s => s && s.owner === owner && keys.includes(s.type))
        : barracks.filter(b => b && b.owner === owner && keys.includes(getEntityStatsCalcType(b)));
    let ready = pool.filter(p => p.energy > 0 && !p.underConstruction);
    let queued = 0;
    for (let p of ready) queued += (p.spawnQueue || []).length;
    let count = Math.max(1, Math.floor(queuePurchaseMultiplier || 1));
    let unitCost = ready.length > 0 && typeof ready[0].getUnitCost === 'function' ? ready[0].getUnitCost() : 0;
    return {
        isWorker,
        ready,
        coords: ready.map(p => ({ gx: p.gx, gy: p.gy })),
        queued,
        cap: ready.length * (isWorker ? 10 : 20),
        cost: unitCost * count,
        count,
        progress: getSpawnerGroupEnergyProgress(ready),
        producerLabel: getBuildingDisplayName(keys[0]),
    };
}

function _bbThingRates(info, owner) {
    let sec = ENERGY_DELTA_DEFAULT_WINDOW_SECONDS;
    let upkeep = typeof getPlayerUpKeepBreakdown === 'function' ? getPlayerUpKeepBreakdown(owner) : { unitTypes: {}, buildingTypes: {} };
    if (info.isUnit) {
        let src = BB_WORKER_ENERGY_SOURCE[info.key];
        let energy = (src ? getPlayerEnergyDeltaRate(owner, src, sec) : 0) - (Number(upkeep.unitTypes[info.key]) || 0);
        let astar = _getPlayerAstarDeltaRate(owner, sec, ev => ev.unitType === info.key);
        return { energy, astar, sec };
    }
    return { energy: -(Number(upkeep.buildingTypes[info.key]) || 0), astar: null, sec };
}

// ---------------------------------------------------------------- DOM

function _bbEnsureDom() {
    if (bb.els) return bb.els;
    let bar = document.getElementById('bottom-bar');
    if (!bar) return null;
    bb.els = {
        bar,
        things: document.getElementById('bb-things'),
        research: document.getElementById('bb-research'),
        researchLabel: document.getElementById('bb-research-label'),
    };
    bar.addEventListener('pointerdown', _bbOnPointerDown);
    bar.addEventListener('contextmenu', ev => ev.preventDefault());
    // Vertical wheel scrolls the rows sideways.
    for (let row of [bb.els.things, bb.els.research]) {
        row.addEventListener('wheel', ev => {
            if (Math.abs(ev.deltaY) <= Math.abs(ev.deltaX) || row.scrollWidth <= row.clientWidth) return;
            row.scrollLeft += ev.deltaY;
            ev.preventDefault();
        }, { passive: false });
        row.addEventListener('scroll', () => { if (bb.menu) _bbPositionMenu(); }, { passive: true });
    }
    document.addEventListener('pointerdown', _bbOnDocumentPointerDown, true);
    window.addEventListener('resize', () => closeBottomBarMenus());
    return bb.els;
}

function _bbResetForNewMatch() {
    bb.order = [];
    bb.known = new Set();
    bb.things = new Map();
    bb.thingsSig = '';
    bb.researchSig = '';
    closeBottomBarMenus();
}

function updateBottomBar(now) {
    let els = _bbEnsureDom();
    if (!els) return;
    if (!gameStarted || !players[localPlayerId]) return;
    if (bb.owner !== localPlayerId || gameTime < bb.lastGameTime) {
        _bbResetForNewMatch();
        bb.owner = localPlayerId;
    }
    bb.lastGameTime = gameTime;

    if (bb.press && bb.press.dragging) _bbAutoScroll();
    if (now - bb.lastRefresh < BB_REFRESH_MS) return;
    bb.lastRefresh = now;

    bb.things = _bbCollectThings(localPlayerId);
    _bbSyncOrder(bb.things);

    // Never swap the DOM under a press: the press may still become a click or drag.
    if (!bb.press) {
        _bbRenderThings();
        _bbRenderResearch(now);
    }
    if (bb.menu) _bbRenderMenu();
}

function _bbThingHtml(id, owned) {
    let info = _bbThingInfo(id);
    let label = _bbThingLabel(info.kind, info.key);
    let open = bb.menu && bb.menu.type === 'thing' && bb.menu.id === id;
    let cls = 'bb-thing' + (info.isUnit ? ' bb-unit' : '') + (info.count <= 0 ? ' bb-none' : '')
        + (owned ? '' : ' bb-unowned') + (open ? ' bb-open' : '');
    let cat = BB_CATEGORY[_bbThingCategory(info.kind, info.key)].label;
    let title = `${label} (${cat}): ${info.count > 0 ? `${info.count}, ${info.idle} idle` : 'none owned'}\n`
        + `Click: menu · Hold + drag onto the research row: upgrade${owned ? ' · drag in this row: reorder' : ''}`;
    return `<div class="${cls}" data-id="${_bbEscape(id)}" style="--bb-c:${_bbThingColor(info.kind, info.key)}" title="${_bbEscape(title)}">`
        + `<img src="${getItemThumbnail(info.key, 20)}" width="20" height="20" alt="" draggable="false">`
        + `<span class="bb-count">x${_bbFmtInt(info.count)}</span>`
        + `</div>`;
}

function _bbRenderThings() {
    let els = bb.els;
    let unowned = _bbUnownedIds();
    let sig = bb.order.map(id => {
        let info = _bbThingInfo(id);
        return `${id}/${info.count}/${info.idle}`;
    }).join('|') + '#' + unowned.join('|') + '#' + (bb.menu && bb.menu.type === 'thing' ? bb.menu.id : '');
    if (sig === bb.thingsSig) return;
    bb.thingsSig = sig;
    let html = '';
    for (let id of bb.order) html += _bbThingHtml(id, true);
    if (unowned.length > 0) {
        html += `<div class="bb-sep" title="Not owned yet"></div>`;
        for (let id of unowned) html += _bbThingHtml(id, false);
    }
    els.things.innerHTML = html;
}

function _bbResearchOrderSig(tasks) {
    return tasks.map(_bbTaskStatId).join('|');
}

function _bbRenderResearch(now) {
    let els = bb.els;
    let owner = localPlayerId;
    let tasks = _bbOrderedTasks(owner);
    let cap = getResearchQueueCapacityForPlayer(owner);
    let orderSig = _bbResearchOrderSig(tasks);
    if (bb.freezeUntil > now && orderSig === bb.freezeOrderSig) return;
    bb.freezeUntil = 0;

    let caret = (bb.menu && bb.menu.type === 'drop') ? Math.min(tasks.length, bb.menu.insertAt + bb.menu.added) : -1;
    let openIndex = (bb.menu && bb.menu.type === 'task') ? tasks.indexOf(bb.menu.task) : -1;
    let parts = [];
    for (let t of tasks) {
        parts.push(`${_bbTaskStatId(t)}/${t.toLevel}/${Math.round(_bbTaskProgress(t) * 200)}/${Math.round(Number(t.cost) || 0)}`);
    }
    let sig = parts.join('|') + `#${cap}#${caret}#${openIndex}`;
    let labelHtml = `<span class="bb-rl-title">Research</span><span class="bb-rl-count">${tasks.length}/${cap}</span>`;
    if (els.researchLabel.innerHTML !== labelHtml) els.researchLabel.innerHTML = labelHtml;
    if (sig === bb.researchSig) return;
    bb.researchSig = sig;

    let html = '';
    for (let i = 0; i < tasks.length; i++) {
        if (i === caret) html += `<div class="bb-caret"></div>`;
        html += _bbTaskHtml(tasks[i], i, i === openIndex);
    }
    if (caret >= tasks.length) html += `<div class="bb-caret"></div>`;
    let empty = Math.min(BB_MAX_EMPTY_SLOTS, Math.max(0, cap - tasks.length));
    for (let i = 0; i < empty; i++) html += `<div class="bb-slot"></div>`;
    if (cap <= 0 && tasks.length <= 0) {
        html += `<div class="bb-empty-msg">No research lab. Build one to research upgrades.</div>`;
    }
    els.research.innerHTML = html;
}

function _bbTaskHtml(t, index, open) {
    let thing = getResearchThing(t.kind, t.key);
    let stat = getResearchStatEntry(t.kind, t.key, t.statKey);
    let statLabel = stat ? stat.label : t.statKey;
    let active = index === 0;
    let pct = _bbTaskProgress(t);
    let cost = Math.max(0, Number(t.cost) || 0);
    let left = cost * (1 - pct);
    let thingLabel = thing ? thing.label : `${t.kind}:${t.key}`;
    let title = `${active ? 'Researching' : `#${index + 1} in queue`}: ${thingLabel} / ${statLabel} R${t.fromLevel}->R${t.toLevel}\n`
        + `Energy left: ${formatBigNumber(left, 0)} of ${formatBigNumber(cost, 0)} (${Math.floor(pct * 100)}%)\n`
        + `Click: details · Hold + drag: reorder`;
    let cls = 'bb-task' + (active ? ' bb-active' : '') + (t.kind === 'unit' ? ' bb-unit' : '') + (open ? ' bb-open' : '');
    let html = `<div class="${cls}" data-index="${index}" style="--bb-c:${_bbThingColor(t.kind, t.key)}" title="${_bbEscape(title)}">`;
    html += `<div class="bb-task-progress"><div style="height:${(pct * 100).toFixed(1)}%"></div></div>`;
    if (active) html += `<span class="bb-task-arrow">◀</span>`;
    html += `<img src="${getItemThumbnail(t.key, 20)}" width="20" height="20" alt="" draggable="false">`;
    html += `<div class="bb-task-info"><div class="bb-task-top"><span class="bb-task-lvl">R${t.toLevel}</span><span class="bb-task-stat">${_bbStatAbbrHtml(t.statKey, statLabel)}</span></div>`;
    html += `<div class="bb-task-cost">⚡${_bbFmtInt(Math.ceil(left))}</div></div>`;
    html += `</div>`;
    return html;
}

// ---------------------------------------------------------------- drag and drop

function _bbOnPointerDown(ev) {
    if (ev.button !== 0) return;
    let el = ev.target instanceof Element ? ev.target.closest('.bb-thing, .bb-task') : null;
    if (!el) return;
    ev.preventDefault();
    let isTask = el.classList.contains('bb-task');
    bb.press = {
        type: isTask ? 'task' : 'thing',
        id: isTask ? null : el.dataset.id,
        index: isTask ? Number(el.dataset.index) : -1,
        src: el,
        owned: !el.classList.contains('bb-unowned'),
        startX: ev.clientX,
        startY: ev.clientY,
        x: ev.clientX,
        y: ev.clientY,
        dragging: false,
        ghost: null,
        placeholder: null,
        zone: null,
        pointerId: ev.pointerId,
    };
    document.addEventListener('pointermove', _bbOnPointerMove, true);
    document.addEventListener('pointerup', _bbOnPointerUp, true);
    document.addEventListener('pointercancel', _bbOnPointerCancel, true);
}

function _bbOnPointerMove(ev) {
    let press = bb.press;
    if (!press || ev.pointerId !== press.pointerId) return;
    press.x = ev.clientX;
    press.y = ev.clientY;
    if (!press.dragging) {
        if (Math.hypot(ev.clientX - press.startX, ev.clientY - press.startY) < BB_DRAG_THRESHOLD_PX) return;
        _bbStartDrag();
    }
    ev.preventDefault();
    _bbUpdateDrag();
}

function _bbStartDrag() {
    let press = bb.press;
    press.dragging = true;
    if (bb.menu) closeBottomBarMenus();
    let rect = press.src.getBoundingClientRect();
    press.offX = press.startX - rect.left;
    press.offY = press.startY - rect.top;
    let ghost = press.src.cloneNode(true);
    ghost.classList.add('bb-ghost');
    ghost.classList.remove('bb-open');
    ghost.removeAttribute('title');
    ghost.style.width = rect.width + 'px';
    ghost.style.height = rect.height + 'px';
    document.body.appendChild(ghost);
    press.ghost = ghost;
    document.body.classList.add('bb-dragging');
    if (press.type === 'task') {
        // The source leaves the row; a placeholder takes its place.
        press.placeholder = _bbMakePlaceholder(press.src, 'task');
        press.src.parentNode.insertBefore(press.placeholder, press.src);
        press.src.classList.add('bb-src-hidden');
        press.zone = 'research';
    } else {
        press.src.classList.add('bb-src-dim');
    }
}

function _bbMakePlaceholder(src, kind) {
    let ph = document.createElement('div');
    ph.className = 'bb-placeholder ' + (kind === 'task' ? 'bb-ph-task' : 'bb-ph-thing');
    let img = src.querySelector('img');
    if (img) ph.appendChild(img.cloneNode());
    return ph;
}

function _bbRowItems(row, selector) {
    return Array.from(row.querySelectorAll(selector)).filter(el => !el.classList.contains('bb-src-hidden'));
}

function _bbInsertionIndex(items, x) {
    let idx = 0;
    for (let el of items) {
        let r = el.getBoundingClientRect();
        if (x > r.left + r.width / 2) idx++;
    }
    return idx;
}

function _bbPointInRect(x, y, r, pad = 0) {
    return x >= r.left - pad && x <= r.right + pad && y >= r.top - pad && y <= r.bottom + pad;
}

// Animates siblings from their old to their new positions after mutate().
function _bbFlip(row, mutate) {
    let items = Array.from(row.children);
    let before = new Map(items.map(el => [el, el.getBoundingClientRect().left]));
    mutate();
    for (let el of items) {
        if (!before.has(el) || !el.isConnected) continue;
        let dx = before.get(el) - el.getBoundingClientRect().left;
        if (Math.abs(dx) < 0.5) continue;
        el.style.transition = 'none';
        el.style.transform = `translateX(${dx}px)`;
        void el.offsetWidth;
        el.style.transition = 'transform 140ms ease-out';
        el.style.transform = '';
    }
}

function _bbUpdateDrag() {
    let press = bb.press;
    let els = bb.els;
    press.ghost.style.left = (press.x - press.offX) + 'px';
    press.ghost.style.top = (press.y - press.offY) + 'px';

    let researchRect = els.research.getBoundingClientRect();
    let thingsRect = els.things.getBoundingClientRect();
    let zone = null;
    if (_bbPointInRect(press.x, press.y, researchRect, 14)) zone = 'research';
    else if (press.type === 'thing' && press.owned && _bbPointInRect(press.x, press.y, thingsRect, 8)) zone = 'things';
    else if (press.type === 'task') zone = 'research-out';

    let full = press.type === 'thing' && getPlayerResearchQueueTotalLength(localPlayerId) >= getResearchQueueCapacityForPlayer(localPlayerId);
    press.ghost.classList.toggle('bb-ghost-blocked', zone === 'research' && full);
    press.ghost.classList.toggle('bb-ghost-cancel', zone === null || zone === 'research-out');

    if (zone === 'research' && !full) {
        let items = _bbRowItems(els.research, '.bb-task');
        let idx = _bbInsertionIndex(items, press.x);
        if (!press.placeholder || press.placeholder.parentNode !== els.research) {
            if (press.placeholder) press.placeholder.remove();
            press.placeholder = _bbMakePlaceholder(press.src, 'task');
        }
        _bbPlaceAt(els.research, press.placeholder, items, idx);
        press.dropIndex = idx;
    } else if (zone === 'things') {
        let items = _bbRowItems(els.things, '.bb-thing:not(.bb-unowned)').filter(el => el !== press.src);
        let idx = _bbInsertionIndex(items, press.x);
        if (!press.placeholder || press.placeholder.parentNode !== els.things) {
            if (press.placeholder) press.placeholder.remove();
            press.placeholder = _bbMakePlaceholder(press.src, 'thing');
            press.src.classList.add('bb-src-hidden');
        }
        _bbPlaceAt(els.things, press.placeholder, items, idx);
        press.dropIndex = idx;
    } else if (zone === 'research-out') {
        // A task dragged away keeps its slot and snaps back on release.
        let items = _bbRowItems(els.research, '.bb-task');
        _bbPlaceAt(els.research, press.placeholder, items, press.index);
        press.dropIndex = press.index;
    } else if (press.placeholder && press.placeholder.parentNode) {
        let row = press.placeholder.parentNode;
        _bbFlip(row, () => press.placeholder.remove());
        if (press.type === 'thing') press.src.classList.remove('bb-src-hidden');
        press.dropIndex = -1;
    }
    press.zone = zone;
}

function _bbPlaceAt(row, placeholder, items, idx) {
    let ref = idx < items.length ? items[idx] : null;
    // After the last item: before the first empty slot / divider, else at the end.
    if (!ref) ref = row.querySelector('.bb-slot, .bb-empty-msg, .bb-sep');
    if (ref === placeholder || (!ref && row.lastChild === placeholder)) return;
    if (placeholder.parentNode === row && placeholder.nextSibling === ref) return;
    _bbFlip(row, () => row.insertBefore(placeholder, ref));
}

function _bbAutoScroll() {
    let press = bb.press;
    let row = press.zone === 'things' ? bb.els.things : (press.zone === 'research' || press.zone === 'research-out') ? bb.els.research : null;
    if (!row) return;
    let r = row.getBoundingClientRect();
    let edge = 36;
    let before = row.scrollLeft;
    if (press.x < r.left + edge) row.scrollLeft -= Math.ceil((r.left + edge - press.x) / 3);
    else if (press.x > r.right - edge) row.scrollLeft += Math.ceil((press.x - (r.right - edge)) / 3);
    if (row.scrollLeft !== before) _bbUpdateDrag();
}

function _bbEndPress() {
    document.removeEventListener('pointermove', _bbOnPointerMove, true);
    document.removeEventListener('pointerup', _bbOnPointerUp, true);
    document.removeEventListener('pointercancel', _bbOnPointerCancel, true);
    document.body.classList.remove('bb-dragging');
    let press = bb.press;
    bb.press = null;
    if (!press) return;
    if (press.ghost) press.ghost.remove();
    if (press.src) press.src.classList.remove('bb-src-dim');
}

function _bbOnPointerCancel() {
    let press = bb.press;
    _bbEndPress();
    if (press && press.dragging) _bbForceRerender();
}

function _bbForceRerender() {
    bb.thingsSig = '';
    bb.researchSig = '';
    bb.lastRefresh = 0;
}

function _bbOnPointerUp(ev) {
    let press = bb.press;
    if (!press || ev.pointerId !== press.pointerId) return;
    ev.preventDefault();
    if (!press.dragging) {
        _bbEndPress();
        _bbToggleClickMenu(press);
        return;
    }
    let zone = press.zone;
    let idx = press.dropIndex;
    let placeholder = press.placeholder;
    _bbEndPress();

    if (press.type === 'task') {
        let tasks = _bbOrderedTasks(localPlayerId);
        if (zone === 'research' && Number.isFinite(idx) && idx >= 0 && idx !== press.index && press.index < tasks.length) {
            queueAction({ action: 'moveResearch', from: press.index, to: idx });
            // Show the dropped order until the move lands.
            if (placeholder && placeholder.parentNode) {
                placeholder.parentNode.insertBefore(press.src, placeholder);
                placeholder.remove();
            }
            press.src.classList.remove('bb-src-hidden');
            bb.freezeOrderSig = _bbResearchOrderSig(tasks);
            bb.freezeUntil = performance.now() + BB_DROP_FREEZE_MS;
            bb.researchSig = '';
            return;
        }
        if (placeholder) placeholder.remove();
        press.src.classList.remove('bb-src-hidden');
        return;
    }

    if (zone === 'things' && Number.isFinite(idx) && idx >= 0) {
        let from = bb.order.indexOf(press.id);
        if (from >= 0) {
            bb.order.splice(from, 1);
            bb.order.splice(Math.min(idx, bb.order.length), 0, press.id);
        }
        if (placeholder && placeholder.parentNode) {
            placeholder.parentNode.insertBefore(press.src, placeholder);
            placeholder.remove();
        }
        press.src.classList.remove('bb-src-hidden');
        bb.thingsSig = '';
        return;
    }
    press.src.classList.remove('bb-src-hidden');

    if (zone === 'research' && Number.isFinite(idx) && idx >= 0) {
        let anchor = placeholder && placeholder.isConnected ? placeholder.getBoundingClientRect() : null;
        if (placeholder) placeholder.remove();
        _bbOpenMenu({
            type: 'drop', id: press.id, insertAt: idx,
            anchor: { x: anchor ? anchor.left + anchor.width / 2 : press.x, top: bb.els.research.getBoundingClientRect().top },
        });
        return;
    }
    if (placeholder) placeholder.remove();
}

// A click (no drag) toggles the item's menu.
function _bbToggleClickMenu(press) {
    if (press.type === 'thing') {
        if (bb.menu && bb.menu.type === 'thing' && bb.menu.id === press.id) { closeBottomBarMenus(); return; }
        _bbOpenMenu({ type: 'thing', id: press.id });
        return;
    }
    let task = _bbOrderedTasks(localPlayerId)[press.index];
    if (!task) return;
    if (bb.menu && bb.menu.type === 'task' && bb.menu.task === task) { closeBottomBarMenus(); return; }
    _bbOpenMenu({ type: 'task', task });
}

// ---------------------------------------------------------------- selection / shop

function _bbSelect(info, mode) {
    if (!info) return false;
    return selectInfoPanelPlayerRoster(info.isUnit ? 'units' : 'buildings', info.key, mode, localPlayerId);
}

function _bbSelectInShop(key) {
    let tab = Object.keys(BUILD_CATEGORIES).find(t => BUILD_CATEGORIES[t].includes(key));
    if (!tab) return false;
    document.querySelectorAll('.build-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
    activeBuildTab = tab;
    selectedBuildItem = isBuildItemAvailable(key) ? key : null;
    updateBuildMenu();
    let item = _buildMenuItems[key];
    if (item && item.scrollIntoView) item.scrollIntoView({ block: 'nearest' });
    return true;
}

// ---------------------------------------------------------------- menus

function closeBottomBarMenus() {
    if (!bb.menu) return false;
    bb.menu.el.remove();
    bb.menu = null;
    bb.thingsSig = '';
    bb.researchSig = '';
    return true;
}

function _bbOnDocumentPointerDown(ev) {
    if (!bb.menu) return;
    let t = ev.target instanceof Element ? ev.target : null;
    if (!t) return;
    if (bb.menu.el.contains(t)) return;
    if (researchThingLevelDropdown && researchThingLevelDropdown.contains(t)) return;
    if (t.closest('#research-matrix-popup')) return;
    // Items handle their own click (toggle or switch menus) on release.
    if (bb.menu.type !== 'drop' && bb.els && bb.els.bar.contains(t) && t.closest('.bb-thing, .bb-task')) return;
    closeBottomBarMenus();
}

function _bbOpenMenu(spec) {
    closeBottomBarMenus();
    let el = document.createElement('div');
    el.className = 'bb-menu bb-menu-' + spec.type;
    el.setAttribute('role', 'dialog');
    document.body.appendChild(el);
    bb.menu = {
        type: spec.type, id: spec.id || null, task: spec.task || null, el,
        anchor: spec.anchor || null, insertAt: spec.insertAt || 0, added: 0, html: '', pressed: false,
    };
    el.addEventListener('pointerdown', () => { if (bb.menu) bb.menu.pressed = true; });
    el.addEventListener('pointerup', () => { setTimeout(() => { if (bb.menu) bb.menu.pressed = false; }, 0); });
    el.addEventListener('click', _bbOnMenuClickCapture, true);
    el.addEventListener('click', _bbOnMenuClick);
    bindResearchPopupControls(el);
    _bbForceRerender();
    if (!bb.press) {
        _bbRenderThings();
        _bbRenderResearch(performance.now());
    }
    _bbRenderMenu(true);
}

function _bbFmtRate(v, glyph) {
    if (v === null || v === undefined) return `<span class="bb-muted">– ${glyph}/s</span>`;
    let color = v > 0.05 ? '#7f7' : v < -0.05 ? '#f88' : '#aa9';
    let text = Math.abs(v) < 0.05 ? '0.0' : `${v > 0 ? '+' : ''}${formatBigNumber(v, 1)}`;
    return `<span style="color:${color}">${text} ${glyph}/s</span>`;
}

function _bbMenuHeadHtml(kind, key, subHtml) {
    let isUnitCls = kind === 'unit' ? ' bb-unit' : '';
    let cat = BB_CATEGORY[_bbThingCategory(kind, key)];
    return `<div class="bb-menu-head">`
        + `<span class="bb-menu-icon${isUnitCls}" style="--bb-c:${cat.color}"><img src="${getItemThumbnail(key, 20)}" width="20" height="20" alt=""></span>`
        + `<span class="bb-menu-title">${_bbEscape(_bbThingLabel(kind, key))} <span class="bb-menu-cat" style="color:${cat.color}">${cat.label}</span></span>`
        + `<span class="bb-menu-sub">${subHtml}</span>`
        + `</div>`;
}

function _bbThingMenuHtml() {
    let owner = localPlayerId;
    let info = _bbThingInfo(bb.menu.id);
    let html = _bbMenuHeadHtml(info.kind, info.key, `x${_bbFmtInt(info.count)}`);
    if (info.count <= 0) {
        html += `<div class="bb-menu-stats"><span class="bb-muted">None owned yet · drag onto the research row to upgrade</span></div>`;
    } else {
        let rates = _bbThingRates(info, owner);
        let idlePct = Math.round(100 * info.idle / info.count);
        html += `<div class="bb-menu-stats" title="Rates over the last ${rates.sec}s">`
            + `<span>Idle <b>${info.idle}/${info.count}</b> <span class="bb-muted">${idlePct}%</span></span>`
            + _bbFmtRate(rates.energy, '⚡')
            + _bbFmtRate(rates.astar, '<span class="bb-star">★</span>')
            + `</div>`;
    }

    // Production queue, as for all of these selected.
    let q = _bbProducerQueueState(info, owner);
    if (q) {
        let coords = q.coords.map(c => `${c.gx},${c.gy}`).join(';');
        let can = q.ready.length > 0;
        let pct = Math.max(0, Math.min(1, Number(q.progress.pct) || 0));
        html += `<div class="bb-menu-queue" title="${_bbEscape(`${q.producerLabel}: ${q.ready.length} ready`)}">`
            + `<span class="bb-menu-queue-label">Queue</span>`
            + `<span style="color:#fd0">${formatInfoCurrency(q.cost)}</span>`
            + `<span class="bb-menu-queue-frac">${_bbFmtInt(q.queued)}/${_bbFmtInt(q.cap)}</span>`
            + `<span class="bb-menu-queue-btns">`
            + `<span class="bb-btn-sub${can ? '' : ' bb-off'}" data-bb-act="queue-sub" data-worker="${q.isWorker ? 1 : 0}" data-coords="${coords}">[-]</span>`
            + `<span class="bb-btn-add${can ? '' : ' bb-off'}" data-bb-act="queue-add" data-worker="${q.isWorker ? 1 : 0}" data-coords="${coords}">[+]</span>`
            + `</span>`
            + `<div class="bb-menu-queue-bar"><div style="width:${(pct * 100).toFixed(1)}%"></div>`
            + `<span>${q.progress.hasQueue ? `${formatInfoCurrency(q.progress.paid)}/${formatInfoCurrency(q.progress.required)}` : (can ? 'idle' : `no ready ${_bbEscape(q.producerLabel)}`)}</span></div>`
            + `</div>`;
    }

    let shopKey = _bbShopKeyForThing(info);
    let safeId = _bbEscape(info.id);
    html += `<div class="bb-menu-actions">`;
    if (shopKey) {
        let shopLabel = shopKey === info.key ? 'Select in Shop' : `Shop: ${_bbEscape(getBuildingDisplayName(shopKey))}`;
        html += `<button type="button" class="bb-menu-btn" data-bb-act="shop" data-key="${_bbEscape(shopKey)}">${shopLabel}</button>`;
    }
    if (info.count > 0) {
        html += `<button type="button" class="bb-menu-btn" data-bb-act="select" data-mode="one" data-id="${safeId}">Select One</button>`;
        html += `<button type="button" class="bb-menu-btn${info.idle > 0 ? '' : ' bb-off'}" data-bb-act="select" data-mode="idle" data-id="${safeId}">Select Idle <span class="bb-muted">${info.idle}</span></button>`;
        html += `<button type="button" class="bb-menu-btn" data-bb-act="select" data-mode="all" data-id="${safeId}">Select All <span class="bb-muted">${info.count}</span></button>`;
    }
    html += `</div>`;
    return html;
}

function _bbDropMenuHtml() {
    let menu = bb.menu;
    let owner = localPlayerId;
    let info = _bbThingInfo(menu.id);
    let html = _bbMenuHeadHtml(info.kind, info.key, `insert at #${menu.insertAt + menu.added + 1}`);
    let thing = getResearchThing(info.kind, info.key);
    let lab = _bbResearchLab(owner);
    html += `<div class="bb-menu-upgrades">`;
    if (!thing || !Array.isArray(thing.stats) || thing.stats.length <= 0) {
        html += `<div class="bb-menu-note">No upgrades for this thing.</div>`;
    } else if (!lab) {
        html += `<div class="bb-menu-note">Build a research lab to upgrade.</div>`;
    } else {
        let cap = getResearchQueueCapacityForPlayer(owner);
        html += `<div class="bb-menu-section">Upgrades <span class="bb-muted">queue ${getPlayerResearchQueueTotalLength(owner)}/${cap} · x${Math.max(1, Math.floor(queuePurchaseMultiplier || 1))} per click</span></div>`;
        html += _renderResearchSingleThingStatsPanel(owner, `single:${lab.gx},${lab.gy}`, lab, thing, false)
            .replace(/<div style="font-size:10px;color:#ddd;margin-bottom:3px">[^<]*<\/div>/, '');
    }
    html += `</div>`;
    html += `<div class="bb-menu-hint">[+] inserts here · Esc or click outside when done</div>`;
    return html;
}

// A queued task, laid out like an item of the research building's queue.
function _bbTaskMenuHtml() {
    let owner = localPlayerId;
    let tasks = _bbOrderedTasks(owner);
    let i = tasks.indexOf(bb.menu.task);
    if (i < 0) return null;
    let t = tasks[i];
    let preview = getQueuedResearchTaskPreview(owner, tasks, i);
    if (!preview) return null;
    let stat = getResearchStatEntry(t.kind, t.key, t.statKey);
    let statLabel = stat ? stat.label : t.statKey;
    let baseValue = getResearchStatValueAtLevel(t.kind, t.key, t.statKey, 0, getResearchPreviewThingLevel());
    let mult = (Number.isFinite(baseValue) && Math.abs(baseValue) > 1e-9 && Number.isFinite(preview.toValue)) ? preview.toValue / baseValue : NaN;
    let valueLabel = t.statKey === 'maxLevel' ? formatResearchStatValue('maxLevel', preview.toValue) : `x${formatResearchMultiplierValue(mult)}`;
    let pct = _bbTaskProgress(t);
    let cost = Math.max(0, Number(t.cost) || 0);
    let btn = 'cursor:pointer;color:#9cf;background:#141414;border:1px solid #355;border-radius:3px;padding:0 4px;line-height:14px;font-size:11px;';
    let pos = i === 0 ? 'Researching' : `#${i + 1} in queue`;

    let html = `<div class="bb-menu-task-head"><span>${pos}</span><span class="bb-muted">${_bbEscape(_bbThingLabel(t.kind, t.key))}</span></div>`;
    html += `<div class="bb-menu-task">`;
    html += `<div class="bb-menu-task-row">`;
    html += `<span class="bb-menu-task-name"><button type="button" class="info-research-stat-matrix-btn" data-kind="${t.kind}" data-key="${t.key}" data-stat-key="${t.statKey}" data-from-level="${preview.fromLevel}" data-to-level="${preview.toLevel}" style="cursor:pointer;background:#111;color:#9cf;border:1px solid #355;border-radius:3px;padding:0 5px;height:18px;line-height:16px;font-size:10px;">M</button>`
        + _renderResearchQueueThingIconHtml(getResearchThing(t.kind, t.key), 18)
        + `<span>${_bbEscape(statLabel)}</span></span>`;
    html += `<span style="color:#8fc">${valueLabel}</span>`;
    html += `</div>`;
    html += `<div class="bb-menu-task-row">`;
    html += `<span class="bb-menu-task-name" style="color:#fd0">`
        + `<button type="button" data-bb-act="task-first" title="Move to first in queue" style="${btn}"${i === 0 ? ' disabled' : ''}>↑</button>`
        + `<button type="button" data-bb-act="task-last" title="Move to last in queue" style="${btn}"${i === tasks.length - 1 ? ' disabled' : ''}>↓</button>`
        + `<span>${preview.atMax ? 'MAX' : formatInfoCurrency(cost)} <span style="color:#9cf">R${t.toLevel}</span></span></span>`;
    html += `<span class="bb-menu-queue-btns">`
        + `<span class="bb-btn-sub" data-bb-act="task-sub" title="Remove this task">[-]</span>`
        + `<span class="bb-btn-add${preview.atMax ? ' bb-off' : ''}" data-bb-act="task-add" title="Queue the next level right after this one">[+]</span>`
        + `</span>`;
    html += `</div>`;
    html += renderResearchWorkProgressRow(cost * pct, cost);
    html += `</div>`;
    return html;
}

function _bbRenderMenu(force = false) {
    let menu = bb.menu;
    if (!menu) return;
    if (!force && (menu.pressed || researchThingLevelDropdown)) return;
    let html = menu.type === 'thing' ? _bbThingMenuHtml() : menu.type === 'drop' ? _bbDropMenuHtml() : _bbTaskMenuHtml();
    if (html === null) { closeBottomBarMenus(); return; }
    if (html !== menu.html) {
        let up = menu.el.querySelector('.bb-menu-upgrades');
        let scroll = up ? up.scrollTop : 0;
        menu.html = html;
        menu.el.innerHTML = html;
        let up2 = menu.el.querySelector('.bb-menu-upgrades');
        if (up2) up2.scrollTop = scroll;
    }
    _bbPositionMenu();
}

// Anchor above the item the menu belongs to (it can scroll or move).
function _bbPositionMenu() {
    let menu = bb.menu;
    if (!menu) return;
    let el = menu.el;
    let cur = null;
    if (menu.type === 'thing') cur = bb.els.things.querySelector(`.bb-thing[data-id="${CSS.escape(menu.id)}"]`);
    else if (menu.type === 'task') {
        let i = _bbOrderedTasks(localPlayerId).indexOf(menu.task);
        cur = i >= 0 ? bb.els.research.querySelector(`.bb-task[data-index="${i}"]`) : null;
    }
    if (cur) {
        let r = cur.getBoundingClientRect();
        menu.anchor = { x: r.left + r.width / 2, top: r.top };
    }
    let a = menu.anchor;
    if (!a) return;
    let vw = window.innerWidth;
    let width = el.offsetWidth;
    let left = Math.round(a.x - width / 2);
    left = Math.max(6, Math.min(vw - width - 6, left));
    el.style.left = left + 'px';
    el.style.bottom = Math.round(window.innerHeight - a.top + 8) + 'px';
    el.style.maxHeight = Math.max(160, Math.min(560, Math.round(a.top - 52))) + 'px';
    el.style.setProperty('--bb-arrow-x', Math.round(Math.max(12, Math.min(width - 12, a.x - left))) + 'px');
}

// Drop menu: [+] inserts at the dropped position, one after another.
function _bbOnMenuClickCapture(ev) {
    let menu = bb.menu;
    if (!menu || menu.type !== 'drop' || !(ev.target instanceof Element)) return;
    let btn = ev.target.closest('.info-research-buy-btn, .info-research-dequeue-btn');
    if (!btn) return;
    let count = Math.max(1, Math.floor(queuePurchaseMultiplier || 1));
    if (btn.classList.contains('info-research-buy-btn')) {
        ev.stopPropagation();
        let owner = localPlayerId;
        let room = getResearchQueueCapacityForPlayer(owner) - getPlayerResearchQueueTotalLength(owner);
        queueAction({
            action: 'queueResearch', gx: Number(btn.dataset.gx), gy: Number(btn.dataset.gy),
            kind: btn.dataset.kind, key: btn.dataset.key, statKey: btn.dataset.statKey,
            count, insertAt: menu.insertAt + menu.added
        });
        menu.added += Math.max(0, Math.min(count, room));
    } else {
        menu.added = Math.max(0, menu.added - count);
    }
    _bbRefreshSoon();
}

function _bbRefreshSoon() {
    // Actions land after the input delay; refresh a little later.
    for (let ms of [60, 260]) setTimeout(() => { bb.lastRefresh = 0; bb.researchSig = ''; }, ms);
}

function _bbOnMenuClick(ev) {
    let btn = ev.target instanceof Element ? ev.target.closest('[data-bb-act]') : null;
    if (!btn || btn.disabled || btn.classList.contains('bb-off')) return;
    let act = btn.dataset.bbAct;
    if (act === 'select') {
        _bbSelect(_bbThingInfo(btn.dataset.id), btn.dataset.mode);
    } else if (act === 'shop') {
        _bbSelectInShop(btn.dataset.key);
    } else if (act === 'queue-add' || act === 'queue-sub') {
        let coords = parseInfoCoordList(btn.dataset.coords);
        let isWorker = btn.dataset.worker === '1';
        if (act === 'queue-add') queueGroupSpawns(coords, isWorker, queuePurchaseMultiplier);
        else dequeueGroupSpawns(coords, isWorker, queuePurchaseMultiplier);
        updateInfoPanel();
    } else if (act.startsWith('task-')) {
        _bbTaskAction(act);
    }
    _bbRefreshSoon();
}

function _bbTaskAction(act) {
    let owner = localPlayerId;
    let tasks = _bbOrderedTasks(owner);
    let t = bb.menu && bb.menu.task;
    let i = tasks.indexOf(t);
    if (i < 0) return;
    let last = tasks.length - 1;
    let lab = _bbResearchLab(owner);
    if (!lab) return;
    if (act === 'task-first') {
        queueAction({ action: 'moveResearch', from: i, to: 0 });
    } else if (act === 'task-last') {
        queueAction({ action: 'moveResearch', from: i, to: last });
    } else if (act === 'task-sub') {
        // Same-stat tasks are interchangeable, so removing the last of this
        // stat after moving this one to the end removes exactly this slot.
        if (i !== last) queueAction({ action: 'moveResearch', from: i, to: last });
        queueAction({ action: 'dequeueResearch', gx: lab.gx, gy: lab.gy, kind: t.kind, key: t.key, statKey: t.statKey, count: 1 });
    } else if (act === 'task-add') {
        queueAction({
            action: 'queueResearch', gx: lab.gx, gy: lab.gy, kind: t.kind, key: t.key, statKey: t.statKey,
            count: Math.max(1, Math.floor(queuePurchaseMultiplier || 1)), insertAt: i + 1
        });
    }
}

Object.assign(globalThis, { updateBottomBar, closeBottomBarMenus });
