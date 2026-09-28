"use strict";
// ============================================================
// SIMULATION WORKER
//
// Runs the game's own scripts (the same files, in the same order, as the
// page) in a Web Worker with a stand-in DOM, so the simulation can tick off
// the main thread. Plain importScripts: works from any static host
// (GitHub Pages included), no special headers.
//
// Stage 1 (shadow): the page keeps simulating as before; this worker gets
// the match start state and every tick's commands, runs the same ticks and
// reports its state hash per tick, which the page compares with its own.
//
// Messages in:  { type: 'load', scripts: [urls] }
//               { type: 'start', globals, snapshotText }
//               { type: 'tick', tick, actions, teams }
// Messages out: { type: 'loaded', ms } | { type: 'started', tick, hash }
//               { type: 'ticked', tick, hash, ms } | { type: 'error', where, message, stack }
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
// An entity as the page finds it: ['u', id] or ['b', gx, gy].
function _simRef(e) {
    if (!e || typeof e !== 'object') return null;
    if (e instanceof Unit) return ['u', e.id];
    if (typeof e.gx === 'number' && typeof e.gy === 'number') return ['b', e.gx, e.gy];
    return null;
}

// Hooks that only drive sound, visuals or UI: recorded for the page or dropped.
function _simStubUi() {
    for (let name of ['startLaserSound', 'stopLaserSound', 'updateAudioReactiveState', 'initAudio', 'startBackgroundMusic',
        'applyAudioSettings', 'updateInfoPanel', 'updateHUD', 'requestBuildMenuRefresh', 'updateBuildMenu', 'updateControlGroupBar',
        'queueRenderFrame', 'queueSimulationFrame', 'startMainThreadLoops', 'invalidateStaticLayerCache', 'clearRendererTransientVisualCaches',
        'commitStaticCaches', '_requestStaticCacheCommit', 'showGameOver', 'renderGameGraph', 'setResearchPopupOpen', 'showUiBanner',
        'prewarmItemThumbnails', 'syncRenderModeUi', 'updateBottomBar', 'requestResearchPopupRefresh', 'updateItemTextCache',
        'ensureLevelTextCanvas', 'enterSpectateMode', 'sampleGameStats']) {
        try { if (typeof self.eval(name) === 'function') self.eval(name + ' = ' + '(() => {})'); } catch { }
    }
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

let _simLoaded = false;
let _simMode = 'shadow';
let _simEpoch = 0;
self.onmessage = (ev) => {
    let msg = ev.data || {};
    try {
        if (msg.type === 'load') {
            let t0 = performance.now();
            for (let url of msg.scripts) _simImport(url);
            _simStubUi();
            _simLoaded = true;
            _simPost({ type: 'loaded', ms: performance.now() - t0 });
        } else if (msg.type === 'start') {
            _simStart(msg);
        } else if (msg.type === 'tick') {
            _simTick(msg);
        } else if (msg.type === 'request') {
            _simRequest(msg);
        }
    } catch (err) { _simError(msg.type, err); }
};

// ---- match start: the page's lobby and config, then its start snapshot ----
function _simStart(msg) {
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
    startGame();
    _simStubUi();
    // gameStarted, isMultiplayer... as on the page (startGame may reset them).
    for (let [name, value] of Object.entries(g.assign || {})) self.eval(name + ' = ' + JSON.stringify(value));
    applyAuthoritativeStateSnapshot(JSON.parse(msg.snapshotText));
    _simEvents = [];
    if (_simMode === 'authority') simDeltaEncoderReset();
    _simPost({ type: 'started', epoch: _simEpoch, tick: currentTick, hash: computeLockstepStateHashFast(currentTick) });
}

// ---- one tick: the same work runOneTick does, with the page's commands ----
function _simTick(msg) {
    let t0 = performance.now();
    if (msg.tick !== currentTick) {
        _simPost({ type: 'error', where: 'tick', message: `tick ${msg.tick} arrived at ${currentTick}` });
        return;
    }
    pathfindBudget = 0;
    // A resync tick: every peer starts it without history caches.
    if (msg.flush) snapFlushHistoryCaches();
    let teams = msg.teams;
    let firstTeam = currentTick % teams.length;
    for (let k = 0; k < teams.length; k++) {
        let teamId = teams[(firstTeam + k) % teams.length];
        let acts = (msg.actions || []).filter(a => (a.teamId ?? 0) === teamId);
        if (acts.length > 0) {
            try { processActions(acts, teamId); } catch (err) { _simError('actions', err); }
        }
    }
    try { gameTick(); } catch (err) { _simError('gameTick', err); }
    let tick = currentTick;
    currentTick++;
    let simMs = performance.now() - t0;
    if (_simMode !== 'authority') {
        _simPost({ type: 'ticked', tick, hash: computeLockstepStateHashFast(tick), ms: simMs });
        return;
    }
    // The rolling state hash, as every peer records it after a tick.
    let hash = msg.hash ? snapRecordTickHash(tick) : null;
    let t1 = performance.now();
    let delta = simDeltaEncode();
    let transfer = [];
    for (let list in delta.hot) { let h = delta.hot[list]; transfer.push(h.v.buffer, h.k.buffer); }
    let events = _simEvents;
    _simEvents = [];
    _simPost({ type: 'ticked', epoch: _simEpoch, tick, delta, hash, events, simMs, encodeMs: performance.now() - t1 }, transfer);
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
        // Guest: a resync patch before the next tick; the page's copy applies
        // the same text at the same point of the stream.
        case 'applyPatch': {
            // As applyResyncPatch does on the page, at the same point.
            snapDecodeState(JSON.parse(msg.args.text), { collectChanges: !msg.args.full });
            visibilityCacheTick = -1;
            updateVisibility(localPlayerId);
            simDeltaEncoderReset();
            break;
        }
        // A whole-state restore; results before it belong to the old epoch.
        case 'applySnapshot': {
            let snap = msg.args.snapshot || JSON.parse(msg.args.text);
            if (msg.args.globals) for (let [name, value] of Object.entries(msg.args.globals)) self.eval(name + ' = ' + JSON.stringify(value));
            applyAuthoritativeStateSnapshot(snap);
            _simEpoch = msg.args.epoch;
            _simEvents = [];
            simDeltaEncoderReset();
            break;
        }
        // The page's copy differs: the whole state, for it to reload.
        case 'replicaState':
            _simPost({ type: 'replicaState', epoch: _simEpoch, tick: currentTick - 1, text: JSON.stringify(snapEncodeState()) });
            simDeltaEncoderReset();
            break;
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
