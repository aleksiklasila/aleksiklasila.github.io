"use strict";
// ============================================================
// SIMULATION WORKER
//
// Runs the game's own scripts (the same files, in the same order, as the
// page) in a Web Worker with a stand-in DOM, so the simulation can tick off
// the main thread. Plain importScripts: works from any static host
// (GitHub Pages included), no special headers.
//
// Authority mode (the default): the worker owns the world. Each tick it
// sends the page the world's frame (sim_frame.js, sim_frame_world.js:
// transferred buffers the page hands back), side effects, the state hash,
// the local player's sight and details of the entities the page watches. Shadow mode (?simworker=shadow, sim_shadow.js):
// the page simulates too, and compares the worker's hash per tick.
//
// Messages in:  { type: 'load', scripts } | { type: 'start', globals, snapshotText }
//               { type: 'tick', tick, actions, teams } | { type: 'request', id, op, args }
//               { type: 'frameReturn', bufs } | { type: 'watch', list: [id, slot, ...] }
// Messages out: { type: 'loaded' } | { type: 'started', frame } | { type: 'ticked', frame, delta, ... }
//               { type: 'reply', id, result } | { type: 'error', where, message, stack }
// ============================================================

// ---- stand-in DOM (the simulation touches a few UI hooks) ----
class SimFakeElement {
    constructor(id = '') {
        this.id = id; this.style = {}; this.dataset = {}; this.tagName = 'DIV'; this.type = ''; this.value = '';
        this.checked = false; this.options = []; this.disabled = false; this.hidden = false; this.textContent = '';
        this.innerHTML = ''; this.title = ''; this.children = []; this.listeners = {};
        let classes = new Set();
        this.classList = {
            add: (...c) => c.forEach(x => classes.add(x)), remove: (...c) => c.forEach(x => classes.delete(x)),
            toggle: (c, on) => { if (on === undefined ? !classes.has(c) : on) classes.add(c); else classes.delete(c); },
            contains: c => classes.has(c)
        };
    }
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
    removeEventListener() { }
    dispatchEvent() { return true; }
    click() { }
    querySelector() { return null; }
    querySelectorAll() { return []; }
    appendChild(c) { this.children.push(c); return c; }
    insertBefore(c) { this.children.push(c); return c; }
    removeChild() { }
    remove() { }
    replaceChildren() { this.children = []; }
    setAttribute(k, v) { this[k] = v; }
    getAttribute(k) { return this[k] ?? null; }
    removeAttribute() { }
    matches() { return true; }
    closest() { return null; }
    contains() { return false; }
    focus() { } blur() { } select() { }
    scrollTo() { } scrollIntoView() { }
    getBoundingClientRect() { return { left: 0, top: 0, width: 1280, height: 720, right: 1280, bottom: 720 }; }
    // A 2D context that accepts every call (text sprites, thumbnails...).
    getContext() { return this._ctx || (this._ctx = _simFakeContext(this)); }
    animate() { return { cancel() { }, startTime: 0 }; }
    get offsetWidth() { return 100; }
    get offsetHeight() { return 100; }
    get offsetLeft() { return 0; }
    get clientWidth() { return 1280; }
    get clientHeight() { return 720; }
}
function _simFakeContext(canvas) {
    let store = { canvas, measureText: t => ({ width: String(t || '').length * 6, actualBoundingBoxAscent: 8, actualBoundingBoxDescent: 2 }),
        getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(Math.max(0, w * h * 4)), width: w, height: h }),
        createImageData: (w, h) => ({ data: new Uint8ClampedArray(Math.max(0, (w.width || w) * (h || w.height || 0) * 4)), width: w.width || w, height: h || w.height }),
        createLinearGradient: () => ({ addColorStop() { } }), createRadialGradient: () => ({ addColorStop() { } }),
        createPattern: () => ({}), getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }), isPointInPath: () => false };
    let noop = () => { };
    return new Proxy(store, { get: (t, k) => (k in t ? t[k] : noop), set: (t, k, v) => { t[k] = v; return true; } });
}
const _simElements = new Map();
const _simElement = id => { if (!_simElements.has(id)) _simElements.set(id, new SimFakeElement(id)); return _simElements.get(id); };
self.document = {
    getElementById: id => _simElement(id),
    createElement: () => new SimFakeElement(),
    createElementNS: () => new SimFakeElement(),
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() { }, removeEventListener() { },
    body: new SimFakeElement('body'),
    documentElement: new SimFakeElement('html'),
    hidden: false, visibilityState: 'visible', fullscreenElement: null
};
self.window = self;
// (Presentation-only work the game's code skips in this context: see
// gameTick's visibility.)
self.SIM_IN_WORKER = true;
self.innerWidth = 1280; self.innerHeight = 720; self.devicePixelRatio = 1;
self.matchMedia = () => ({ matches: false, addEventListener() { }, removeEventListener() { } });
self.screen = { width: 1920, height: 1080, availLeft: 0, availTop: 0 };
const _simStore = new Map();
self.localStorage = self.sessionStorage = {
    getItem: k => (_simStore.has(k) ? _simStore.get(k) : null), setItem: (k, v) => _simStore.set(k, String(v)),
    removeItem: k => _simStore.delete(k), clear: () => _simStore.clear()
};
// (navigator and location exist in workers already, read-only.)
self.requestAnimationFrame = () => 0;
self.cancelAnimationFrame = () => { };
self.alert = () => { }; self.confirm = () => true; self.prompt = () => null;
self.Image = class { constructor() { this.onload = null; } set src(v) { } };
self.Event = self.Event || class { constructor(type) { this.type = type; } };
// No network from the worker: the page owns the connections.
self.Peer = class { constructor() { throw new Error('no network in the simulation worker'); } };

function _simPost(msg, transfer) { self.postMessage(msg, transfer || []); }
function _simError(where, err) {
    _simPost({ type: 'error', where, message: String(err && err.message || err), stack: String(err && err.stack || '') });
}

// ---- side effects the page replays (sounds, flashes, alerts, particles, fx) ----
let _simEvents = [];
// Set when the simulation's win check found this player defeated.
let _simLocalDefeat = '';
// An entity as the page finds it: ['u', id] or ['b', gx, gy].
function _simRef(e) {
    if (!e || typeof e !== 'object') return null;
    if (e instanceof Unit) return ['u', e.id];
    if (typeof e.gx === 'number' && typeof e.gy === 'number') return ['b', e.gx, e.gy];
    return null;
}

// Hooks that only drive sound, visuals or UI: recorded for the page or dropped.
function _simStubUi() {
    for (let name of ['startLaserSound', 'stopLaserSound', 'initAudio', 'startBackgroundMusic',
        'applyAudioSettings', 'updateInfoPanel', 'updateHUD', 'requestBuildMenuRefresh', 'updateBuildMenu', 'updateControlGroupBar',
        'queueRenderFrame', 'queueSimulationFrame', 'startMainThreadLoops', 'invalidateStaticLayerCache', 'clearRendererTransientVisualCaches',
        'commitStaticCaches', '_requestStaticCacheCommit', 'showGameOver', 'renderGameGraph', 'setResearchPopupOpen', 'showUiBanner',
        'prewarmItemThumbnails', 'syncRenderModeUi', 'updateBottomBar', 'requestResearchPopupRefresh', 'updateItemTextCache',
        'ensureLevelTextCanvas', 'enterSpectateMode', 'sampleGameStats']) {
        try { if (typeof self.eval(name) === 'function') self.eval(name + ' = ' + '(() => {})'); } catch { }
    }
    // This player defeated (the win check's spectate mode): the page's to show.
    self.enterSpectateMode = mode => { _simLocalDefeat = String(mode || 'defeated'); };
    self._simRecordSound = (type, x, y, sub) => { _simEvents.push(['s', type, x, y, sub === undefined ? '' : sub]); };
    self._simRecordDamage = (target, amount, owner) => { let r = _simRef(target); if (r) _simEvents.push(['d', r, amount, owner === undefined ? null : owner]); };
    self._simRecordAlert = (target, dmg, owner) => { let r = _simRef(target); if (r) _simEvents.push(['h', r, dmg, owner]); };
    self._simRecordExplosion = (x, y, c, n) => { _simEvents.push(['x', x, y, c, n]); };
    self._simRecordDirected = (fx, fy, tx, ty, c, n) => { _simEvents.push(['p', fx, fy, tx, ty, c, n]); };
    self._simRecordFx = (kind, x0, y0, x1, y1, style) => { _simEvents.push(['f', kind, x0, y0, x1, y1, style === undefined ? null : style]); };
    for (let [name, rec] of [['playSound', '_simRecordSound'], ['recordDamageVisual', '_simRecordDamage'], ['pushHostileDamageAlert', '_simRecordAlert'],
        ['createExplosion', '_simRecordExplosion'], ['createDirectedParticles', '_simRecordDirected'], ['recordCombatFx', '_simRecordFx']]) {
        try { self.eval(name + ' = self.' + rec); } catch { }
    }
}

// importScripts only runs files served with a JavaScript MIME type; some
// local servers send .js as text/plain (pages run those anyway). Such a file
// is fetched and run from a blob of the right type instead.
let _simImportViaBlob = false;
function _simImport(url) {
    if (!_simImportViaBlob) {
        try { importScripts(url); return; } catch (err) {
            if (!err || err.name !== 'NetworkError' || typeof XMLHttpRequest === 'undefined') throw err;
            _simImportViaBlob = true;
        }
    }
    let xhr = new XMLHttpRequest();
    xhr.open('GET', url, false);
    xhr.send();
    if (xhr.status !== 200 && xhr.status !== 0) throw new Error('could not load ' + url + ' (' + xhr.status + ')');
    let blobUrl = URL.createObjectURL(new Blob([xhr.responseText + String.fromCharCode(10) + '//# sourceURL=' + url], { type: 'text/javascript' }));
    try { importScripts(blobUrl); } finally { URL.revokeObjectURL(blobUrl); }
}

// The helpers' script. Started from a blob (the page's fallback for servers
// sending .js as text/plain), or when imports needed blobs, it is the helper
// sources in one blob too: a relative URL or a text/plain script would fail.
function _simHelperUrl() {
    let base = self.SIM_WORKER_BASE || location.href;
    let url = new URL('sim_helper.js?v=20261008-mem2', base).href;
    if (!self.SIM_WORKER_BASE && !_simImportViaBlob) return url;
    let nl = String.fromCharCode(10);
    let parts = ['sim_parallel.js?v=20261008-mem2', 'sim_wasm_bin.js?v=20261008-mem2', 'sim_wasm.js?v=20261008-mem2', 'sim_frame.js?v=20261008-mem2', '../game/flownav.js?v=20261021-w'].map(f => {
        let xhr = new XMLHttpRequest();
        xhr.open('GET', new URL(f, base).href, false);
        xhr.send();
        if (xhr.status !== 200 && xhr.status !== 0) throw new Error('could not load ' + f + ' (' + xhr.status + ')');
        return xhr.responseText;
    });
    return URL.createObjectURL(new Blob([parts.join(nl + ';' + nl) + nl + 'simParallelHelperMain();' + nl + '//# sourceURL=' + url], { type: 'text/javascript' }));
}

let _simLoaded = false;
let _simMode = 'shadow';
let _simEpoch = 0;
self.onmessage = (ev) => {
    let msg = ev.data || {};
    try {
        if (msg.type === 'load') {
            let t0 = performance.now();
            // (The page's shared control block: [epoch, last tick run].)
            _simCtl = msg.ctl instanceof Int32Array ? msg.ctl : null;
            for (let url of msg.scripts) _simImport(url);
            _simStubUi();
            _simLoaded = true;
            // Helpers for the parallel jobs (with shared memory; sim_parallel.js).
            let helpers = 0;
            try { helpers = simParallelInit(_simHelperUrl(), msg.maxHelpers); } catch (err) { _simError('helpers', err); }
            _simPost({ type: 'loaded', ms: performance.now() - t0, helpers, shared: SIM_PAR_SHARED });
        } else if (msg.type === 'start') {
            _simStreamClear(false);
            _simStart(msg);
            _simCtlPublish(currentTick - 1);
        } else if (msg.type === 'presentationStop') {
            simPresentationStop();
        } else if (msg.type === 'tick') {
            _simStreamPush(msg);
        } else if (msg.type === 'frameReturn') {
            // The page is done with these buffers: the next frames reuse them.
            for (let b of msg.bufs || []) if (!simPresentationReturn(b)) simFrameReturn(b);
        } else if (msg.type === 'watch') {
            simFrameWatch(msg.list);
            simFrameWatchStructures(msg.structures);
        } else if (msg.type === 'request') {
            // A whole-state restore: the ticks queued before it belong to the
            // old epoch (dropped; requests before it still run, in order).
            if (msg.op === 'applySnapshot') { _simStreamClear(true); _simRequest(msg); _simCtlPublish(currentTick - 1); }
            else _simStreamPush(msg);
        }
    } catch (err) { _simError(msg.type, err); }
};

// ---- the tick stream ----
// Ticks and the requests between them are one ordered stream. A tick runs
// at its deadline (absolute time on the page's tick clock, sim_client.js) or
// at once when late or without one; a request runs once every tick before
// it has. So ticks the page dispatched ahead run on time however busy the
// page is (drawing, applying results), and patches and snapshots still
// land between the right ticks.
const _simStream = [];
let _simStreamTimer = 0;
// The shared control block (when the page has shared memory): the epoch and
// the last tick run, for the page's dispatch (it never waits for results).
let _simCtl = null;
function _simCtlPublish(tick) {
    if (!_simCtl) return;
    Atomics.store(_simCtl, 1, tick | 0);
    Atomics.store(_simCtl, 0, _simEpoch | 0);
}
function _simNowAbs() { return typeof performance.timeOrigin === 'number' ? performance.timeOrigin + performance.now() : NaN; }
function _simStreamPush(msg) { _simStream.push(msg); _simStreamRun(); }
function _simStreamRun() {
    if (_simStreamTimer) { clearTimeout(_simStreamTimer); _simStreamTimer = 0; }
    while (_simStream.length) {
        const m = _simStream[0];
        if (m.type === 'tick' && Number.isFinite(m.due)) {
            const wait = m.due - _simNowAbs();
            if (wait > 0.5) { _simStreamTimer = setTimeout(_simStreamRun, wait); return; }
        }
        _simStream.shift();
        try { if (m.type === 'tick') _simTick(m); else _simRequest(m); } catch (err) { _simError(m.type, err); }
    }
}
// (keepRequests: the requests run now, in order; the ticks are dropped.)
function _simStreamClear(keepRequests) {
    if (_simStreamTimer) { clearTimeout(_simStreamTimer); _simStreamTimer = 0; }
    const list = _simStream.splice(0);
    if (keepRequests) for (const m of list) if (m.type === 'request') { try { _simRequest(m); } catch (err) { _simError('request', err); } }
}

// ---- match start: the page's lobby and config, then its start snapshot ----
function _simStart(msg) {
    simPresentationStop();
    let g = msg.globals || {};
    _simMode = msg.mode === 'authority' ? 'authority' : 'shadow';
    _simEpoch = msg.epoch || 0;
    // The page's lobby controls: startGame reads the match settings from them.
    for (let [id, c] of Object.entries(msg.controls || {})) {
        let el = _simElement(id);
        if ('checked' in c) { el.type = 'checkbox'; el.checked = c.checked; } else el.value = c.value;
    }
    for (let [name, value] of Object.entries(g.assign || {})) self.eval(name + ' = ' + JSON.stringify(value));
    if (g.editableConfig) applyEditableRuntimeConfigObject(g.editableConfig, { fromTransport: true });
    if (g.startingResources) startingResourcesConfig = normalizeStartingResourcesConfig(g.startingResources);
    // (Where a big match's start goes: sent back with 'started'.)
    const T = {}, t0 = performance.now();
    // (Its entities come with the snapshot.)
    startGameSkipStarters = true;
    try { startGame(); } finally { startGameSkipStarters = false; }
    T.startGame = performance.now() - t0;
    _simStubUi();
    // gameStarted, isMultiplayer... as on the page (startGame may reset them).
    for (let [name, value] of Object.entries(g.assign || {})) self.eval(name + ' = ' + JSON.stringify(value));
    const t1 = performance.now();
    const snap = JSON.parse(msg.snapshotText);
    T.parse = performance.now() - t1;
    const t2 = performance.now();
    applyAuthoritativeStateSnapshot(snap);
    T.apply = performance.now() - t2;
    // The map's first navigation builds, which its first tick makes
    // (navTick) from this same state: made before the match is reported
    // started, not in a first tick of ~1 s right after the start.
    const t4 = performance.now();
    if (typeof _navProfilesInUse === 'function' && !_nav[NAV_PROFILE_GROUND]) for (const p of _navProfilesInUse()) navEnsure(p);
    T.nav = performance.now() - t4;
    _simStartTimings = T;
    _simEvents = [];
    _simLocalDefeat = '';
    if (_simMode !== 'authority') {
        _simPost({ type: 'started', epoch: _simEpoch, tick: currentTick, hash: computeLockstepStateHashFast(currentTick) });
        return;
    }
    simFrameResetAll();
    // The page's world comes from frames: this one before the first tick.
    let transfer = [];
    const t3 = performance.now();
    let world = _simEncodeWorld(transfer);
    T.encodeWorld = performance.now() - t3;
    _simPost({ type: 'started', epoch: _simEpoch, tick: currentTick, hash: computeLockstepStateHashFast(currentTick), world, timings: T }, transfer);
    simPresentationStart();
}

let _simStartTimings = null;
// ---- one tick: the same work runOneTick does, with the page's commands ----
function _simTick(msg) {
    let t0 = performance.now();
    if (msg.tick !== currentTick) {
        _simPost({ type: 'error', where: 'tick', message: `tick ${msg.tick} arrived at ${currentTick}` });
        return;
    }
    // (How late it starts against its deadline.)
    let lateMs = Number.isFinite(msg.due) ? Math.max(0, _simNowAbs() - msg.due) : 0;
    pathfindBudget = 0;
    // A resync tick: every peer starts it without history caches.
    if (msg.flush) snapFlushHistoryCaches();
    // (The presentation reader keeps off the state while it changes.)
    if (typeof simPresentTickBegin === 'function') simPresentTickBegin();
    let teams = msg.teams;
    let firstTeam = currentTick % teams.length;
    let actions = msg.actions || [];
    for (let k = 0; k < teams.length; k++) {
        let teamId = teams[(firstTeam + k) % teams.length];
        let acts = actions.filter(a => (a.teamId ?? 0) === teamId);
        if (acts.length > 0) {
            try { processActions(acts, teamId); } catch (err) { _simError('actions', err); }
        }
    }
    try { gameTick(); } catch (err) { _simError('gameTick', err); }
    if (typeof simPresentTickEnd === 'function') simPresentTickEnd();
    let tick = currentTick;
    currentTick++;
    let simMs = performance.now() - t0;
    _simCtlPublish(tick);
    _simTickLateMs = lateMs;
    if (_simMode !== 'authority') {
        _simPost({ type: 'ticked', tick, hash: computeLockstepStateHashFast(tick), ms: simMs });
        return;
    }
    // The rolling state hash, as every peer records it after a tick.
    let hash = msg.hash ? snapRecordTickHash(tick) : null;
    let report = typeof simTickReportHook === 'function' ? simTickReportHook(tick) : null;
    _simPostResult(tick, hash, simReportLockstepHashes ? [computeLockstepStateHashFast(tick)] : null, simMs, report);
}

// (The last tick's lateness against its deadline, reported with it.)
let _simTickLateMs = 0;
// Tests: each tick's lockstep hash goes out too, and what the hook reports.
let simReportLockstepHashes = false;
let simTickReportHook = null;

// Everything the page shows of the world, as of now: the tables (units,
// structures, projectiles; their buffers go in `transfer`), the state and
// details of the entities the page watches.
function simFrameResetAll() {
    simFrameReset();
    _simStructSlots.reset();
    _simProjSlots.reset();
    simFrameResetState();
}
function _simEncodeWorld(transfer) {
    let w = {};
    try { w.units = simFrameEncode(); if (!SIM_PAR_SHARED) transfer.push(w.units.buf); } catch (err) { _simError('frame', err); }
    try { w.structures = simFrameEncodeStructures(); transfer.push(w.structures.buf); } catch (err) { _simError('structures', err); }
    try { w.projectiles = simFrameEncodeProjectiles(); transfer.push(w.projectiles.buf); } catch (err) { _simError('projectiles', err); }
    try { w.state = simFrameEncodeState(); } catch (err) { _simError('state', err); }
    try { w.details = simFrameDetails(); w.structureDetails = simFrameStructureDetails(); } catch (err) { _simError('details', err); }
    // Codes the tables introduced (after all of them).
    let S = _simFrameStrings;
    if (S.sent < S.list.length) { w.strings = [S.sent, S.list.slice(S.sent)]; S.sent = S.list.length; }
    return w;
}

// The tick's result: the world frame, the hash, side effects and the local
// player's sight.
function _simPostResult(tick, hash, lock, simMs, report = null) {
    let t1 = performance.now();
    let transfer = [];
    let world;
    if (_simPresentation) {
        // No unit/structure scans, animation, signatures, or buffer waits in
        // the authority tick. The independent reader samples shared columns.
        simPresentationPublish(tick);
        world = {state:simFrameEncodeState(false), details:simFrameDetails(), structureDetails:simFrameStructureDetails()};
    } else world = _simEncodeWorld(transfer);
    let events = _simEvents;
    _simEvents = [];
    // The local player's raw visibility grid (computed here anyway): the
    // page uses it instead of computing its own. (A pooled buffer.)
    let sight = null;
    try {
        // The grid this tick computed (asking for it now would compute the
        // next tick's: the clock has moved on).
        let rows = visibilityGridRawByPlayerCache.get(localPlayerId) || getRawVisibilityGridForPlayer(localPlayerId), n = GRID_W * GRID_H;
        if (_simPresentation && rows._flat && rows._flat.buffer instanceof SharedArrayBuffer) {
            // A read-only presentation binding: no million-cell allocation or
            // copy each tick. The renderer tolerates visibility advancing.
            sight=rows._flat;
        } else {
            let buf = _simFrameAcquireExact(n * 4);
            sight = new Float32Array(buf, 0, n);
            for (let y = 0; y < GRID_H; y++) if (rows[y]) sight.set(rows[y], y * GRID_W);
            transfer.push(buf);
        }
    } catch (err) { sight = null; _simError('sight', err); }
    _simPost({ type: 'ticked', epoch: _simEpoch, tick, world, presentation:!!_simPresentation, hash, lockHashes: lock, events, sight, sightPlayer: localPlayerId, simMs, encodeMs: performance.now() - t1, report,
        lateMs: _simTickLateMs, doneAt: _simNowAbs() }, transfer);
}

// ---- requests the page's network code needs in tick order ----
function _simRequest(msg) {
    let result = null;
    switch (msg.op) {
        // Host: a resync patch of the state before the next tick.
        case 'encodePatch':
            result = JSON.stringify(snapEncodeState(msg.args && msg.args.buckets ? { buckets: msg.args.buckets } : null));
            break;
        // The whole state (joins, reloads, rematch...), for the page to wrap.
        case 'encodeState':
            result = { state: snapEncodeState(), gameTime };
            break;
        // Guest: a resync patch before the next tick. (The page sees its
        // effects in the next frame and records.)
        case 'applyPatch': {
            const presenting=!!_simPresentation;
            if(presenting) simPresentationStop();
            snapDecodeState(JSON.parse(msg.args.text), { collectChanges: !msg.args.full });
            visibilityCacheTick = -1;
            updateVisibility(localPlayerId);
            if(presenting) simPresentationStart();
            break;
        }
        // A whole-state restore; results before it belong to the old epoch.
        case 'applySnapshot': {
            simPresentationStop();
            let snap = msg.args.snapshot || JSON.parse(msg.args.text);
            if (msg.args.globals) for (let [name, value] of Object.entries(msg.args.globals)) self.eval(name + ' = ' + JSON.stringify(value));
            applyAuthoritativeStateSnapshot(snap);
            _simEpoch = msg.args.epoch;
            _simEvents = [];
            _simLocalDefeat = '';
            // The page's world comes whole with the next frame.
            simFrameResetAll();
            simPresentationStart();
            break;
        }
        case 'setGlobals':
            for (let [name, value] of Object.entries(msg.args.assign || {})) self.eval(name + ' = ' + JSON.stringify(value));
            break;
        // Tests: scripted setup at this point of the tick stream.
        case 'eval':
            self.eval(msg.args.code);
            break;
        // Diagnostics (window.simClientRequest('debugEval', { expr })).
        case 'debugEval':
            result = JSON.stringify(self.eval(msg.args.expr));
            break;
        case 'lockstepHash':
            result = computeLockstepStateHashFast(msg.args.tick);
            break;
    }
    if (msg.id) _simPost({ type: 'reply', id: msg.id, result });
}
