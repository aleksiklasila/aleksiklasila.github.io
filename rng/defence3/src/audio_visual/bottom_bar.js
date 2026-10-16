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
    order: [],              // owned (or pinned) thing ids in display order
    rest: [],               // never-owned thing ids in display order, after the divider
    known: new Set(),
    rates: null,            // per-thing and total ⚡/s and ★/s, refreshed with the bar
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
    return formatCompactNumber(n);
}

function _bbFmtEnergy(n) {
    return '⚡' + formatCompactNumber(Math.max(0, Number(n) || 0));
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
// The open menu's task in the queue as it is now. The queue's task objects
// are not kept: beside the simulation worker every tick's state brings new
// ones (a menu told by the object closed within a second), so a task is told
// by its stat and the level it researches to (one of each in a queue).
function _bbTaskKey(t) { return _bbTaskStatId(t) + ':' + t.toLevel; }
function _bbMenuTaskIndex(tasks) {
    let menu = bb.menu;
    if (!menu || menu.type !== 'task') return -1;
    let i = tasks.indexOf(menu.task);
    if (i < 0 && menu.taskKey) i = tasks.findIndex(t => _bbTaskKey(t) === menu.taskKey);
    if (i >= 0) menu.task = tasks[i];
    return i;
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
    const groups = typeof getFrameUnitSummary === 'function' ? getFrameUnitSummary(owner) : null;
    if (groups) {
        for (const [key, n] of groups) {
            const id = 'unit:' + key;
            map.set(id, {id,kind:'unit',key,isUnit:true,count:n.total,idle:n.idle});
        }
    } else for (let u of units) {
        if (!u || u.dead || u.owner !== owner) continue;
        add('unit', String(u.unitType || ''), _isInfoPanelUnitIdleLike(u));
    }
    const buildings=typeof getFrameBuildingSummary==='function'?getFrameBuildingSummary(owner):null;
    if(buildings)for(const [key,n] of buildings.stats){
        const id='building:'+key;map.set(id,{id,kind:'building',key,isUnit:false,count:n.total,idle:n.idle});
    }
    else for (let e of _getOwnedInfoPanelBuildings(owner)) {
        add('building', String(getEntityStatsCalcType(e) || ''), _isInfoPanelBuildingIdleLike(e));
    }
    if (SHRINES_ENABLED && BASE_CARD_TYPES.shrine) add('building', 'shrine', false);
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
        // The shrine leads the row (everyone has one).
        if (info.id === 'building:shrine') bb.order.unshift(info.id);
        else bb.order.push(info.id);
    }
    bb.rest = bb.rest.filter(id => !bb.known.has(id));
}

// The not-owned section, in the player's order: defaults are appended once,
// and anything owned or pinned leaves it.
function _bbRestIds() {
    let have = new Set(bb.rest);
    for (let id of _bbUnownedIds()) if (!have.has(id)) bb.rest.push(id);
    bb.rest = bb.rest.filter(id => !bb.known.has(id));
    return bb.rest;
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

// Every thing's ⚡/s and ★/s plus the totals, in one pass over the logs.
// Units: work income (workers) minus upkeep, and ★ used moving. Buildings: upkeep.
function _bbComputeRates(owner) {
    let sec = ENERGY_DELTA_DEFAULT_WINDOW_SECONDS;
    let upkeep = typeof getPlayerUpKeepBreakdown === 'function' ? getPlayerUpKeepBreakdown(owner) : { total: 0, unitTypes: {}, buildingTypes: {} };
    let bySource = Object.create(null);
    for (let src of new Set(Object.values(BB_WORKER_ENERGY_SOURCE))) bySource[src] = getPlayerEnergyDeltaRate(owner, src, sec);
    let astarByUnit = Object.create(null);
    let astarTotal = 0;
    let cutoff = gameTime - Math.max(1, Math.floor(TICK_RATE * sec));
    for (let ev of (_ensureAstarLogPlayer(owner) || [])) {
        if (!ev || !(ev.tick >= cutoff)) continue;
        let d = Number.isFinite(Number(ev.delta)) ? Number(ev.delta) : -(Math.max(0, Number(ev.used) || 0));
        astarByUnit[ev.unitType] = (astarByUnit[ev.unitType] || 0) + d;
        astarTotal += d;
    }
    for (let k in astarByUnit) astarByUnit[k] /= sec;
    // The totals (the bottom-left corner): over the windows the right
    // panel's totals use (its 1s/10s/30s/60s buttons), so both say the same.
    let energySec = typeof getEnergyDeltaWindowSeconds === 'function' ? getEnergyDeltaWindowSeconds('total') : sec;
    let astarSec = typeof getAstarWindowSeconds === 'function' ? getAstarWindowSeconds('total') : sec;
    if (astarSec !== sec) {
        astarTotal = 0;
        let from = gameTime - Math.max(1, Math.floor(TICK_RATE * astarSec));
        for (let ev of (_ensureAstarLogPlayer(owner) || [])) {
            if (!ev || !(ev.tick >= from)) continue;
            astarTotal += Number.isFinite(Number(ev.delta)) ? Number(ev.delta) : -(Math.max(0, Number(ev.used) || 0));
        }
    }
    return {
        sec, upkeep, bySource, astarByUnit, energySec, astarSec,
        energyTotal: getPlayerEnergyDeltaRate(owner, '', energySec) - (Number(upkeep.total) || 0),
        astarTotal: astarTotal / astarSec,
    };
}

function _bbThingRates(info) {
    let R = bb.rates;
    if (!R) return { energy: 0, astar: null, sec: ENERGY_DELTA_DEFAULT_WINDOW_SECONDS };
    if (info.isUnit) {
        let src = BB_WORKER_ENERGY_SOURCE[info.key];
        return { energy: (src ? (R.bySource[src] || 0) : 0) - (Number(R.upkeep.unitTypes[info.key]) || 0), astar: R.astarByUnit[info.key] || 0, sec: R.sec };
    }
    return { energy: -(Number(R.upkeep.buildingTypes[info.key]) || 0), astar: null, sec: R.sec };
}

// Compact signed rate: "-0.5", "+12", "-1.2K"; "0" when negligible.
function _bbFmtRateShort(v) {
    if (!Number.isFinite(v) || Math.abs(v) < 0.05) return '0';
    let a = Math.abs(v);
    let body = formatCompactNumber(a);
    return (v > 0 ? '+' : '-') + body;
}

function _bbRateClass(v) {
    return !Number.isFinite(v) || Math.abs(v) < 0.05 ? 'bb-r0' : v > 0 ? 'bb-rpos' : 'bb-rneg';
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
        thingsLabel: document.getElementById('bb-things-label'),
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
    bb.rest = [];
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

    // (The counts walk every unit and building: twice a second at most, and
    // at once for another player or map.)
    if (bb.thingsOwner !== localPlayerId || bb.thingsGrid !== grid || ((bb.thingsTick !== gameTime || bb.thingsUnits !== units) && !(now - (bb.thingsAt || -Infinity) < 500))) {
        bb.thingsAt = now;
        bb.things = _bbCollectThings(localPlayerId);
        bb.thingsTick = gameTime; bb.thingsOwner = localPlayerId; bb.thingsUnits = units; bb.thingsGrid = grid;
    }
    _bbSyncOrder(bb.things);
    bb.rates = _bbComputeRates(localPlayerId);
    _bbRenderTotals();

    // Never swap the DOM under a press: the press may still become a click or drag.
    if (!bb.press) {
        _bbRenderThings();
        _bbRenderResearch(now);
    }
    if (bb.menu) _bbRenderMenu();
}

function _bbRenderTotals() {
    // (The totals now live in the bottom-left stack, updateHUD.)
    if (!bb.els.thingsLabel) return;
    let R = bb.rates;
    let row = (v, glyph, res) => `<span class="bb-lv ${_bbRateClass(v)}" style="color:${getDeltaRateColor(v, res)}">${_bbFmtRateShort(v)}</span><span class="bb-lu">${glyph}<span class="bb-per">/s</span></span>`;
    let html = row(R.energyTotal, '<span class="bb-glyph">⚡</span>', 'energy') + row(R.astarTotal, '<span class="bb-glyph bb-star">★</span>', 'astar');
    if (bb.els.thingsLabel.innerHTML !== html) bb.els.thingsLabel.innerHTML = html;
}

// ---------------------------------------------------------------- boosts
// Two rows of slots on top of each thing's tile: the ★ boost (units
// only) over the energy boost; a slot is a step, a thing level (data_dynamic.js
// BOOSTS). A click on a slot sets the boost to it (on the last filled one:
// one less). What the simulation holds is shown filled; an order on its way
// shows at once, and filled slots brighten over the time the thing's units
// and buildings take to follow (their staggered refresh). A resource in debt:
// its boosts are off, the slots hollow.
const BB_BOOST_APPLY_MS = 2500;
function _bbBoostState(info, res) {
    let branch = info.kind === 'building' ? 'building' : 'unit';
    let key = typeof _boostThingKey === 'function' ? _boostThingKey(branch, info.key) : info.key;
    let steps = typeof getPlayerThingBoost === 'function' ? getPlayerThingBoost(localPlayerId, branch, key, res) : 0;
    let id = info.id + '/' + res, pending = bb.boostPending && bb.boostPending[id], now = performance.now();
    // (An order sent: shown until the simulation has it, or a few seconds.)
    if (pending && (pending.steps === steps || now - pending.at > 3000)) { delete bb.boostPending[id]; pending = null; }
    let shown = pending ? pending.steps : steps;
    let seen = bb.boostSeen || (bb.boostSeen = {});
    if (!seen[id] || seen[id].steps !== shown) seen[id] = { steps: shown, at: seen[id] ? now : -Infinity };
    return { steps: shown, on: typeof isPlayerBoostOn !== 'function' || isPlayerBoostOn(localPlayerId, res), age: now - seen[id].at, at: seen[id].at };
}
// (A step's levels: +L1, +L2, +L4, +L8.)
function _bbBoostLevels(steps) { return typeof boostStepLevels === 'function' ? boostStepLevels(steps) : steps; }
function _bbBoostMult(steps) { return '+L' + _bbBoostLevels(steps); }
function _bbBoostWhat(res) {
    return res === 'astar' ? 'move speed and ★ per tile' : 'every stat but health, move speed and ★ per tile (upkeep too)';
}
function _bbBoostText(info, res, st) {
    let glyph = res === 'astar' ? '★' : '⚡';
    if (st.steps <= 0) return `${glyph} boost: none. The slots on the tile set it: ${_bbBoostWhat(res)} as of that many levels higher.`;
    return `${glyph} boost ${_bbBoostMult(st.steps)}: ${_bbBoostWhat(res)} as ${_bbBoostLevels(st.steps)} level${_bbBoostLevels(st.steps) > 1 ? 's' : ''} higher (up to the last level)`
        + (st.on ? '' : ` — not applied while ${glyph} is below 0`);
}
// One slot's own words (its hover text).
function _bbBoostSlotText(res, step, st) {
    let glyph = res === 'astar' ? '★' : '⚡';
    if (step <= 0) return `${glyph} +L0: no boost${st.steps === 0 ? ' (now)' : ' — click to remove the boost'}`;
    return `${glyph} ${_bbBoostMult(step)} — ${_bbBoostWhat(res)} as ${_bbBoostLevels(step)} level${_bbBoostLevels(step) > 1 ? 's' : ''} higher`
        + (step === st.steps ? (st.on ? ' (now)' : ` (chosen; not applied while ${glyph} is below 0)`) : '');
}
function _bbBoostHtml(info) {
    let max = typeof BOOST_MAX_STEPS === 'number' ? BOOST_MAX_STEPS : 4;
    let row = res => {
        let st = _bbBoostState(info, res);
        let cls = 'bb-boost-row bb-boost-' + (res === 'astar' ? 'a' : 'e') + (st.on ? '' : ' bb-boost-off') + (st.steps > 0 ? ' bb-boost-set' : '');
        // (The same text for the whole time it is taken up: the row is
        // only made again when what it shows changes.)
        let fresh = st.steps > 0 && st.on && st.age < BB_BOOST_APPLY_MS ? ` data-since="${Math.round(st.at)}"` : '';
        let html = `<div class="${cls}${fresh ? ' bb-boost-applying' : ''}"${fresh}>`;
        // (The first slot is x1, no boost: always there, always filled.)
        for (let i = 0; i <= max; i++) html += `<i class="${i <= st.steps ? 'on' : ''}${i === 0 ? ' bb-boost-x1' : ''}" data-bb-boost="${res}" data-step="${i}" title="${_bbEscape(_bbBoostSlotText(res, i, st))}"></i>`;
        return html + '</div>';
    };
    // (A thing without a ★ boost: its one row as tall as two.)
    return `<div class="bb-boost">${info.isUnit ? row('astar') : ''}${row('energy')}</div>`;
}
function _bbBoostSig(info) {
    let e = _bbBoostState(info, 'energy'), a = info.isUnit ? _bbBoostState(info, 'astar') : null;
    return `${e.steps}${e.on ? '' : '!'}${e.age < BB_BOOST_APPLY_MS ? '~' : ''}${a ? '/' + a.steps + (a.on ? '' : '!') + (a.age < BB_BOOST_APPLY_MS ? '~' : '') : ''}`;
}
// A click on a slot: the order, shown at once.
function _bbOnBoostClick(slot) {
    let tile = slot.closest('.bb-thing');
    if (!tile || !gameStarted || gameOver) return;
    let info = _bbThingInfo(tile.dataset.id), res = slot.dataset.bbBoost === 'astar' ? 'astar' : 'energy';
    let steps = Math.max(0, Math.floor(Number(slot.dataset.step) || 0));
    if (steps === _bbBoostState(info, res).steps) return;
    (bb.boostPending || (bb.boostPending = {}))[info.id + '/' + res] = { steps, at: performance.now() };
    queueAction({ action: 'setBoost', kind: info.kind === 'building' ? 'building' : 'unit', key: info.key, res, steps });
    bb.thingsSig = '';
    if (!bb.press) _bbRenderThings();
    if (bb.menu) _bbRenderMenu(true);
}

function _bbThingHtml(id, owned) {
    let info = _bbThingInfo(id);
    let label = _bbThingLabel(info.kind, info.key);
    let open = bb.menu && bb.menu.type === 'thing' && bb.menu.id === id;
    let cls = 'bb-thing' + (info.isUnit ? ' bb-unit' : '') + (info.count <= 0 ? ' bb-none' : '')
        + (owned ? '' : ' bb-unowned') + (open ? ' bb-open' : '');
    let cat = BB_CATEGORY[_bbThingCategory(info.kind, info.key)].label;
    let rates = _bbThingRates(info);
    let astarText = rates.astar === null ? '–' : _bbFmtRateShort(rates.astar);
    let title = `${label} (${cat}): ${info.count > 0 ? `${info.count}, ${info.idle} idle` : 'none owned'}\n`
        + `⚡ ${_bbFmtRateShort(rates.energy)}/s · ★ ${astarText}/s (last ${rates.sec}s)\n`
        + 'Click: menu · Hold + drag: reorder, or drop on the research row to upgrade';
    // (In parts: _bbRenderThings changes only the parts that changed, so the
    // tile and the slot under the mouse stay the same elements. Made anew
    // every quarter second, they lost and regained their hover: a flicker.)
    return { id, cls, title, boost: _bbBoostHtml(info), body: _bbThingBodyHtml(info, rates, astarText) };
}
function _bbThingBodyHtml(info, rates, astarText) {
    return `<img src="${getItemThumbnail(info.key, 20)}" width="20" height="20" alt="" draggable="false">`
        + `<span class="bb-rate bb-rate-e ${_bbRateClass(rates.energy)}" style="color:${getDeltaRateColor(rates.energy, 'energy')}">${_bbFmtRateShort(rates.energy)}<span class="bb-glyph">⚡</span></span>`
        + `<span class="bb-rate bb-rate-a ${rates.astar === null ? 'bb-r0' : _bbRateClass(rates.astar)}"${rates.astar === null ? '' : ` style="color:${getDeltaRateColor(rates.astar, 'astar')}"`}>${astarText}<span class="bb-glyph bb-star">★</span></span>`;
}
function _bbThingPartsHtml(p) {
    return `<div class="${p.cls}" data-id="${_bbEscape(p.id)}" title="${_bbEscape(p.title)}">${p.boost}<span class="bb-thing-body">${p.body}</span></div>`;
}

function _bbRenderThings() {
    let els = bb.els;
    let rest = _bbRestIds();
    let part = (id) => {
        let info = _bbThingInfo(id);
        let rates = _bbThingRates(info);
        return `${id}/${info.count}/${info.idle}/${_bbFmtRateShort(rates.energy)}/${rates.astar === null ? '' : _bbFmtRateShort(rates.astar)}/${_bbBoostSig(info)}`;
    };
    let sig = bb.order.map(part).join('|') + '#' + rest.map(part).join('|') + '#' + (bb.menu && bb.menu.type === 'thing' ? bb.menu.id : '')
        + '#' + formatCompactNumber(getPlayerDeltaFlowScale(localPlayerId, 'energy')) + '/' + formatCompactNumber(getPlayerDeltaFlowScale(localPlayerId, 'astar'));
    if (sig === bb.thingsSig) return;
    bb.thingsSig = sig;
    // (null: the line between owned and never owned.)
    let parts = bb.order.map(id => _bbThingHtml(id, true));
    if (rest.length > 0) { parts.push(null); for (let id of rest) parts.push(_bbThingHtml(id, false)); }
    let kids = els.things.children, same = kids.length === parts.length;
    for (let i = 0; same && i < parts.length; i++) same = parts[i] ? kids[i].dataset.id === parts[i].id : kids[i].classList.contains('bb-sep');
    if (!same) {
        let html = '';
        for (let p of parts) html += p ? _bbThingPartsHtml(p) : `<div class="bb-sep" title="Never owned yet (drag things across to pin them left of this line)"></div>`;
        els.things.innerHTML = html;
        kids = els.things.children;
        for (let i = 0; i < parts.length; i++) if (parts[i]) { kids[i]._bbBoost = parts[i].boost; kids[i]._bbBody = parts[i].body; }
        return;
    }
    for (let i = 0; i < parts.length; i++) {
        let p = parts[i], el = kids[i];
        if (!p) continue;
        if (el.className !== p.cls) el.className = p.cls;
        if (el.getAttribute('title') !== p.title) el.setAttribute('title', p.title);
        if (el._bbBoost !== p.boost) { el.firstElementChild.outerHTML = p.boost; el._bbBoost = p.boost; }
        if (el._bbBody !== p.body) { el.lastElementChild.innerHTML = p.body; el._bbBody = p.body; }
    }
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
    let openIndex = _bbMenuTaskIndex(tasks);
    let parts = [];
    for (let t of tasks) {
        parts.push(`${_bbTaskStatId(t)}/${t.toLevel}/${Math.round(_bbTaskProgress(t) * 200)}/${Math.round(Number(t.cost) || 0)}`);
    }
    // (Orders given and not there yet: faded tiles after the queue, counted in.)
    let ahead = typeof researchOrdersAheadList === 'function' ? researchOrdersAheadList().filter(a => a.delta > 0) : [];
    let aheadCount = 0;
    for (let a of ahead) aheadCount += a.delta;
    aheadCount = Math.max(0, Math.min(aheadCount, cap - tasks.length));
    let sig = parts.join('|') + `#${cap}#${caret}#${openIndex}#${ahead.map(a => a.key + '/' + a.statKey + '/' + a.delta).join(',')}`;
    let labelHtml = `<span class="bb-lcap">Research</span><span class="bb-lcount">${tasks.length + aheadCount}<span class="bb-per">/${cap}</span></span>`;
    if (els.researchLabel.innerHTML !== labelHtml) els.researchLabel.innerHTML = labelHtml;
    if (sig === bb.researchSig) return;
    bb.researchSig = sig;

    let html = '';
    for (let i = 0; i < tasks.length; i++) {
        if (i === caret) html += `<div class="bb-caret"></div>`;
        html += _bbTaskHtml(tasks[i], i, i === openIndex);
    }
    if (caret >= tasks.length) html += `<div class="bb-caret"></div>`;
    let aheadLeft = aheadCount;
    for (let a of ahead) for (let n = 0; n < a.delta && aheadLeft > 0; n++, aheadLeft--) {
        let stat = getResearchStatEntry(a.kind, a.key, a.statKey);
        html += `<div class="bb-slot bb-ahead${a.kind === 'unit' ? ' bb-unit' : ''}" title="Ordered: on its way"><img src="${getItemThumbnail(a.key, 20)}" width="20" height="20" alt="" draggable="false"><span class="bb-task-stat">${_bbStatAbbrHtml(a.statKey, stat ? stat.label : a.statKey)}</span></div>`;
    }
    let empty = Math.min(BB_MAX_EMPTY_SLOTS, Math.max(0, cap - tasks.length - aheadCount));
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
    let html = `<div class="${cls}" data-index="${index}" title="${_bbEscape(title)}">`;
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
    // (A boost slot: its own click, never the tile's press, menu or drag.)
    let slot = ev.target instanceof Element ? ev.target.closest('[data-bb-boost]') : null;
    if (slot) { ev.preventDefault(); ev.stopPropagation(); _bbOnBoostClick(slot); return; }
    if (ev.target instanceof Element && ev.target.closest('.bb-boost')) { ev.preventDefault(); return; }
    let el = ev.target instanceof Element ? ev.target.closest('.bb-thing, .bb-task') : null;
    if (!el) return;
    ev.preventDefault();
    let isTask = el.classList.contains('bb-task');
    bb.press = {
        type: isTask ? 'task' : 'thing',
        id: isTask ? null : el.dataset.id,
        index: isTask ? Number(el.dataset.index) : -1,
        src: el,
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
    else if (press.type === 'thing' && _bbPointInRect(press.x, press.y, thingsRect, 8)) zone = 'things';
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
        // The divider counts as an item: left of it is the pinned (owned)
        // section, right of it the never-owned one. Owned things stay left.
        let items = _bbRowItems(els.things, '.bb-thing, .bb-sep').filter(el => el !== press.src);
        let sepPos = items.findIndex(el => el.classList.contains('bb-sep'));
        let idx = _bbInsertionIndex(items, press.x);
        if (sepPos >= 0 && idx > sepPos && _bbThingInfo(press.id).count > 0) idx = sepPos;
        if (!press.placeholder || press.placeholder.parentNode !== els.things) {
            if (press.placeholder) press.placeholder.remove();
            press.placeholder = _bbMakePlaceholder(press.src, 'thing');
            press.src.classList.add('bb-src-hidden');
        }
        let ref = idx < items.length ? items[idx] : null;
        if (ref !== press.placeholder && press.placeholder.nextSibling !== ref && !(ref === null && els.things.lastChild === press.placeholder)) {
            _bbFlip(els.things, () => els.things.insertBefore(press.placeholder, ref));
        }
        press.dropIndex = idx;
        press.dropRest = sepPos >= 0 && idx > sepPos;
        press.dropPos = press.dropRest ? idx - sepPos - 1 : idx;
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
        let id = press.id;
        bb.order = bb.order.filter(x => x !== id);
        bb.rest = bb.rest.filter(x => x !== id);
        if (press.dropRest) {
            bb.known.delete(id);
            bb.rest.splice(Math.min(press.dropPos, bb.rest.length), 0, id);
        } else {
            // Pinned: stays left of the divider even while none are owned.
            bb.known.add(id);
            bb.order.splice(Math.min(press.dropPos, bb.order.length), 0, id);
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
    if (bb.menu && bb.menu.type === 'task' && (bb.menu.task === task || bb.menu.taskKey === _bbTaskKey(task))) { closeBottomBarMenus(); return; }
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
        type: spec.type, id: spec.id || null, task: spec.task || null, taskKey: spec.task ? _bbTaskKey(spec.task) : '', el,
        anchor: spec.anchor || null, insertAt: spec.insertAt || 0, added: 0, html: '', pressed: false,
    };
    el.addEventListener('pointerdown', () => { if (bb.menu) bb.menu.pressed = true; });
    el.addEventListener('pointerup', () => { setTimeout(() => { if (bb.menu) bb.menu.pressed = false; }, 0); });
    el.addEventListener('click', _bbOnMenuClick);
    bindResearchPopupControls(el);
    _bbForceRerender();
    if (!bb.press) {
        _bbRenderThings();
        _bbRenderResearch(performance.now());
    }
    _bbRenderMenu(true);
}

function _bbFmtRate(v, glyph, res) {
    if (v === null || v === undefined) return `<span class="bb-muted">– ${glyph}/s</span>`;
    let color = getDeltaRateColor(v, res);
    let text = Math.abs(v) < 0.05 ? '0' : `${v > 0 ? '+' : ''}${formatCompactNumber(v)}`;
    return `<span style="color:${color}">${text} ${glyph}/s</span>`;
}

function _bbMenuHeadHtml(kind, key, subHtml) {
    let isUnitCls = kind === 'unit' ? ' bb-unit' : '';
    let cat = BB_CATEGORY[_bbThingCategory(kind, key)];
    return `<div class="bb-menu-head">`
        + `<span class="bb-menu-icon${isUnitCls}"><img src="${getItemThumbnail(key, 20)}" width="20" height="20" alt=""></span>`
        + `<span class="bb-menu-title">${_bbEscape(_bbThingLabel(kind, key))}</span>`
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
        let rates = _bbThingRates(info);
        let idlePct = Math.round(100 * info.idle / info.count);
        html += `<div class="bb-menu-stats" title="Rates over the last ${rates.sec}s">`
            + `<span>Idle <b>${info.idle}/${info.count}</b> <span class="bb-muted">${idlePct}%</span></span>`
            + _bbFmtRate(rates.energy, '⚡', 'energy')
            + _bbFmtRate(rates.astar, '<span class="bb-star">★</span>', 'astar')
            + `</div>`;
    }

    // Its boosts, in words (the slots on the tile set them).
    {
        let e = _bbBoostState(info, 'energy'), a = info.isUnit ? _bbBoostState(info, 'astar') : null;
        html += `<div class="bb-menu-boost">`
            + `<div class="${e.steps > 0 && e.on ? 'bb-boost-txt-e' : 'bb-muted'}">${_bbEscape(_bbBoostText(info, 'energy', e))}</div>`
            + (a ? `<div class="${a.steps > 0 && a.on ? 'bb-boost-txt-a' : 'bb-muted'}">${_bbEscape(_bbBoostText(info, 'astar', a))}</div>` : '')
            + `</div>`;
    }

    // Production queue, as for all of these selected.
    let q = _bbProducerQueueState(info, owner);
    if (q) {
        let coords = q.coords.map(c => `${c.gx},${c.gy}`).join(';');
        let can = q.ready.length > 0;
        let pct = Math.max(0, Math.min(1, Number(q.progress.pct) || 0));
        html += researchEnergySummaryHtml(spawnQueueEnergyEstimate(q.coords, q.isWorker), 'Queue remaining');
        html += `<div class="bb-menu-queue" title="${_bbEscape(`${q.producerLabel}: ${q.ready.length} ready`)}">`
            + `<span class="bb-menu-queue-label">Queue</span>`
            + `<span></span>`
            + spawnCountBar(q.coords, q.isWorker)
            + `<div class="bb-menu-queue-bar"><div style="width:${(pct * 100).toFixed(1)}%"></div>`
            + `<span>${q.progress.hasQueue ? `${_bbFmtEnergy(q.progress.paid)}/${_bbFmtEnergy(q.progress.required)}` : (can ? 'idle' : `no ready ${_bbEscape(q.producerLabel)}`)}</span></div>`
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
        html += `<div class="bb-menu-section">Upgrades <span class="bb-muted">queue ${getPlayerResearchQueueTotalLength(owner)}/${cap}</span></div>`;
        html += _renderResearchSingleThingStatsPanel(owner, `single:${lab.gx},${lab.gy}`, lab, thing, false)
            .replace(/<div style="font-size:10px;color:#ddd;margin-bottom:3px">[^<]*<\/div>/, '');
    }
    html += `</div>`;
    html += `<div class="bb-menu-hint">Slide to set the research target; new levels insert here · Esc or click outside when done</div>`;
    return html;
}

// A queued task, laid out like an item of the research building's queue.
function _bbTaskMenuHtml() {
    let owner = localPlayerId;
    let tasks = _bbOrderedTasks(owner);
    let i = _bbMenuTaskIndex(tasks);
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
    html += researchEnergySummaryHtml(researchQueueEnergyEstimate(tasks), 'Queue remaining');
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
        + `</span>`;
    html += researchCountBar(owner, _bbResearchLab(owner), [{ kind: t.kind, key: t.key, statKey: t.statKey }], preview.toLevel);
    html += `</div>`;
    html += `<div class="bb-menu-queue-bar"><div style="width:${(pct * 100).toFixed(1)}%"></div><span>${_bbFmtEnergy(cost * pct)}/${_bbFmtEnergy(cost)}</span></div>`;
    html += `</div>`;
    return html;
}

function _bbRenderMenu(force = false) {
    let menu = bb.menu;
    if (!menu || countBarBusy(menu.el)) return;
    if (!force && (menu.pressed || researchThingLevelDropdown)) return;
    // (A count just changed by a click stays until the simulation's can differ.)
    if (!force && bb.menuHoldUntil && performance.now() < bb.menuHoldUntil) return;
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
        let i = _bbMenuTaskIndex(_bbOrderedTasks(localPlayerId));
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

// The rows made again with the next frame (an order was just given).
function bottomBarRefreshNow() {
    bb.lastRefresh = 0; bb.researchSig = '';
}

function _bbRefreshSoon() {
    // Actions land after the input delay; refresh a little later.
    for (let ms of [60, 260]) setTimeout(() => { bb.lastRefresh = 0; bb.researchSig = ''; }, ms);
}

function _bbOnMenuClick(ev) {
    let btn = ev.target instanceof Element ? ev.target.closest('[data-bb-act]') : null;
    if (!btn || btn.disabled || btn.classList.contains('bb-off')) return;
    let act = btn.dataset.bbAct;
    // Select and shop finish what the menu was opened for; queue and task
    // buttons are often pressed repeatedly, so those keep it open.
    if (act === 'select') {
        _bbSelect(_bbThingInfo(btn.dataset.id), btn.dataset.mode);
        closeBottomBarMenus();
        return;
    } else if (act === 'shop') {
        _bbSelectInShop(btn.dataset.key);
        closeBottomBarMenus();
        return;
    } else if (act.startsWith('task-')) {
        _bbTaskAction(act);
    }
    _bbRefreshSoon();
}

function _bbTaskAction(act) {
    let owner = localPlayerId;
    let tasks = _bbOrderedTasks(owner);
    let i = _bbMenuTaskIndex(tasks);
    if (i < 0) return;
    let t = tasks[i];
    let last = tasks.length - 1;
    let lab = _bbResearchLab(owner);
    if (!lab) return;
    if (act === 'task-first') {
        queueAction({ action: 'moveResearch', from: i, to: 0 });
    } else if (act === 'task-last') {
        queueAction({ action: 'moveResearch', from: i, to: last });

    }
}

Object.assign(globalThis, { updateBottomBar, closeBottomBarMenus, bottomBarRefreshNow });
