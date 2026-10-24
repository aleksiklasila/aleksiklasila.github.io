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
// Set when the simulation's win check found this player defeated (and
// cleared by a restore or patch that shows its team alive: reviewLocalDefeat).
let _simLocalDefeat = '';
// The teams the win check found out (for the page's roles, a host's).
let _simDefeatedTeams = [];
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
    self.reviewLocalDefeat = (alive = null) => { if (!gameStarted || gameOver) return; if (alive === null) alive = isTeamAliveNow(localPlayerId); _simLocalDefeat = alive ? '' : (_simLocalDefeat || 'defeated'); };
    self.noteTeamsDefeated = list => { _simDefeatedTeams = Array.isArray(list) ? list.slice() : []; };
    self.hostBroadcastMatchResult = () => { };
    self._simRecordSound = (type, x, y, sub) => { _simEvents.push(['s', type, x, y, sub === undefined ? '' : sub]); };
    self._simRecordDamage = (target, amount, owner) => { let r = _simRef(target); if (r) _simEvents.push(['d', r, amount, owner === undefined ? null : owner]); };
    self._simRecordAlert = (target, dmg, owner) => { let r = _simRef(target); if (r) _simEvents.push(['h', r, dmg, owner]); };
    self._simRecordExplosion = (x, y, c, n) => { _simEvents.push(['x', x, y, c, n]); };
    self._simRecordDirected = (fx, fy, tx, ty, c, n) => { _simEvents.push(['p', fx, fy, tx, ty, c, n]); };
    self._simRecordFx = (kind, x0, y0, x1, y1, style, src = 0, dst = 0) => { _simEvents.push(['f', kind, x0, y0, x1, y1, style === undefined ? null : style, src | 0, dst | 0]); };
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
    let url = new URL('sim_helper.js?v=20261024-ui2', base).href;
    if (!self.SIM_WORKER_BASE && !_simImportViaBlob) return url;
    let nl = String.fromCharCode(10);
    let parts = ['sim_parallel.js?v=20261024-ui2', 'sim_wasm_bin.js?v=20261024-ui2', 'sim_wasm.js?v=20261024-ui2', 'sim_frame.js?v=20261024-ui2', '../game/flownav.js?v=20261024-ui2'].map(f => {
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
            _simAuto.base = Number(msg.ctlBase) || 0;
            for (let url of msg.scripts) _simImport(url);
            _simStubUi();
            _simLoaded = true;
            if (msg.trace) _simTraceInstall();
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
        } else if (msg.type === 'sealed') {
            _simAutoSealed(msg);
        } else if (msg.type === 'auto') {
            _simAuto.arm = msg;
            _simAutoPoll();
        } else if (msg.type === 'netChannel') {
            _simNetAdd(String(msg.peer || ''), msg.dc);
        } else if (msg.type === 'frameReturn') {
            // The page is done with these buffers: the next frames reuse them.
            for (let b of msg.bufs || []) if (!simPresentationReturn(b)) simFrameReturn(b);
        } else if (msg.type === 'watch') {
            simFrameWatch(msg.list);
            simFrameWatchStructures(msg.structures);
        } else if (msg.type === 'view') {
            // (The page's view: its hits' looks first, unit.js.)
            if (Array.isArray(msg.r) && msg.r.length === 4 && typeof simLookView !== 'undefined') for (let i = 0; i < 4; i++) simLookView[i] = msg.r[i] | 0;
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
    _simAutoPoll();
}
// (keepRequests: the requests run now, in order; the ticks are dropped.)
function _simStreamClear(keepRequests) {
    if (_simStreamTimer) { clearTimeout(_simStreamTimer); _simStreamTimer = 0; }
    const list = _simStream.splice(0);
    _simSealed.clear();
    _simAuto.dueTick = -1;
    if (keepRequests) for (const m of list) if (m.type === 'request') { try { _simRequest(m); } catch (err) { _simError('request', err); } }
}

// ---- its own ticks while the page is stalled ----
// The page dispatches ticks (sim_client.js) a few ahead; a page whose main
// thread is held up longer than that (a long task, a collection, a view
// switch) left the worker without ticks, and in a match every other peer
// waited for that page's bundles or its packets: one player's stall was
// everyone's tick rate. So the worker goes on by itself when the page's
// pump has not been heard for SIM_AUTO_STALE_MS (the page's heartbeat in the
// shared block), on the page's tick clock (the deadlines of the ticks it
// dispatched, continued at the match's pace):
// - a tick whose commands it holds (sealed bundles the page handed it at
//   once, 'sealed'; a guest's worker gets the host's over its own data
//   channel too, below) runs at its deadline;
// - alone (no match), a tick without commands: a stalled page gave none;
// - a host's worker seals ticks the page has not, without anyone's commands
//   (they run on a later tick, as a late packet's do: main.js), and sends
//   those bundles to the guests over its own channels, as far ahead of their
//   deadlines as the page seals.
// Who takes a tick is settled in the shared block: the page claims each tick
// it dispatches (and a host each tick it seals) by a compare-and-exchange,
// the worker the same, so a tick has one source; the worker tells the page
// of each tick it took ('autoRan', 'autoSealed'), and the page's lockstep
// follows from those. The page bounds it (the limit: the first tick the
// worker must leave to it, a resync point; none while a match is paused),
// and lowers the limit only while the worker is not in the middle of a claim
// (the intent word).
const SIM_CTL_CLAIM = 2, SIM_CTL_SEALED = 3, SIM_CTL_LIMIT = 4, SIM_CTL_INTENT = 5, SIM_CTL_BEAT = 6, SIM_CTL_PEPOCH = 7, SIM_CTL_STALE = 8;
// (The most ticks it takes in one stall, 3 s: a page gone longer is an
// outage, which the match's own rules handle. How far before a tick's
// deadline a host's worker seals it: the page's lead.)
const SIM_AUTO_MAX_TICKS = 60, SIM_AUTO_SEAL_AHEAD_MS = 150;
const _simAuto = { base: 0, due: NaN, dueTick: -1, teams: null, run: 0, arm: null, timer: 0, ran: 0, sealed: 0 };
// Sealed ticks not run yet: tick -> { actions, flush }.
const _simSealed = new Map();
function _simAutoOn() {
    const C = _simCtl, A = _simAuto;
    return !!(C && C.length >= 16 && A.arm && _simMode === 'authority' && A.dueTick >= 0 && Atomics.load(C, SIM_CTL_PEPOCH) === _simEpoch);
}
function _simAutoPoll(ms = 15) {
    const A = _simAuto;
    if (A.timer) { clearTimeout(A.timer); A.timer = 0; }
    if (!_simCtl || _simCtl.length < 16 || !A.arm) return;
    A.timer = setTimeout(_simAutoStep, Math.max(1, Math.min(15, ms)));
}
// A tick's commands, sealed: from the page ({ tick, actions } or, a host's,
// { tick, msg }: the bundle as it goes to the guests, sent on to them over
// the worker's channels too), or from the host's worker (_simNetMessage).
function _simAutoSealed(m) {
    const t = m.tick | 0;
    if (m.epoch !== _simEpoch || t < currentTick) return;
    if (m.msg) _simNetBroadcast(m.msg);
    // (The page's own word goes before a copy from the host's worker.)
    const have = _simSealed.get(t);
    if (have && !have.gen) return;
    let actions = m.actions, flush = !!m.flush, dk = m.dk | 0 || 1;
    if (m.msg) {
        const b = unpackTickBundleFromWire(m.msg.w);
        if (!b || b.tick !== t) return;
        actions = b.packets.flatMap(p => Array.isArray(p.actions) ? p.actions : []);
        flush = !!b.flush;
        dk = b.dk | 0 || 1;
    }
    _simSealed.set(t, { actions: actions || [], flush, dk });
}
// Claims the next tick of a word (SEALED, CLAIM) unless the page did, or
// lowered its limit to it.
function _simAutoClaim(word, t) {
    const C = _simCtl;
    Atomics.store(C, SIM_CTL_INTENT, 1);
    let ok = false;
    if (Atomics.load(C, SIM_CTL_LIMIT) > t && Atomics.load(C, SIM_CTL_PEPOCH) === _simEpoch) ok = Atomics.compareExchange(C, word, t - 1, t) === t - 1;
    Atomics.store(C, SIM_CTL_INTENT, 0);
    return ok;
}
function _simAutoStep() {
    const C = _simCtl, A = _simAuto;
    A.timer = 0;
    if (!_simAutoOn()) { _simAutoPoll(); return; }
    const limit = Atomics.load(C, SIM_CTL_LIMIT);
    let now = _simNowAbs();
    if (limit <= 0 || now - (A.base + Atomics.load(C, SIM_CTL_BEAT)) < Math.max(40, Atomics.load(C, SIM_CTL_STALE))) { A.run = 0; _simAutoPoll(); return; }
    const arm = A.arm, tickMs = Math.max(1, Number(arm.tickMs) || 50);
    if (A.run >= SIM_AUTO_MAX_TICKS) { _simAutoPoll(); return; }
    // A host: the ticks the page would have sealed by now.
    if (arm.role === 'host' && Array.isArray(arm.participants) && _simNetReady(arm.peers)) {
        let s = Atomics.load(C, SIM_CTL_SEALED);
        while (s + 1 < limit && s + 1 >= currentTick && A.due + (s + 1 - A.dueTick) * tickMs - now < SIM_AUTO_SEAL_AHEAD_MS && s + 1 - currentTick < SIM_AUTO_MAX_TICKS - A.run) {
            if (!_simAutoClaim(SIM_CTL_SEALED, s + 1)) break;
            s++;
            const dk = Math.max(1, Math.min(SIM_DK_MAX, arm.dk | 0 || 1));
            const bundle = buildEmptyTickBundle(s, arm.participants, dk);
            const msg = { type: 'TICK_BUNDLE', w: packTickBundleForWire(bundle), c: 1, d: arm.d, pace: arm.pace, l: arm.peers, auto: 1 };
            _simSealed.set(s, { actions: [], flush: false, dk });
            _simNetBroadcast(msg);
            A.sealed++;
            _simPost({ type: 'autoSealed', epoch: _simEpoch, tick: s, msg });
        }
    }
    // (Running: the page's ticks and requests first; the stream holds a
    // tick waiting for its deadline.)
    const t = currentTick;
    if (_simStream.length || t >= limit) { _simAutoPoll(); return; }
    const due = A.due + (t - A.dueTick) * tickMs;
    if (now < due - 0.5) { _simAutoPoll(due - now); return; }
    // (More than a tick late, the worker itself held up: from now, as the
    // page's clock does.)
    if (due < now - tickMs) { A.due = now - (t - A.dueTick) * tickMs; }
    let e = _simSealed.get(t);
    // (One from the host's worker: of the host's state as it is now, not of
    // one a restore replaced.)
    if (e && e.gen && e.gen !== _simNetGen) e = null;
    if (!e && arm.role === 'solo') e = { actions: [], flush: false, dk: Math.max(1, Math.min(SIM_DK_MAX, arm.dk | 0 || 1)) };
    if (!e || !_simAutoClaim(SIM_CTL_CLAIM, t)) { _simAutoPoll(); return; }
    A.run++; A.ran++;
    const at = A.due + (t - A.dueTick) * tickMs;
    _simPost({ type: 'autoRan', epoch: _simEpoch, tick: t, due: at });
    try { _simTick({ type: 'tick', tick: t, actions: e.actions, teams: A.teams || [0, 1], flush: e.flush, hash: arm.role !== 'solo', due: at, auto: true, dk: e.dk | 0 || 1 }); } catch (err) { _simError('tick', err); }
    _simAutoPoll(1);
}

// ---- the worker's own data channels (a match's ticks past a stalled page) ----
// One per link of the page (sim_client.js simClientNetAttach: a second
// channel of the same peer connection, handed over as it is made). A host's
// worker sends every sealed bundle over them (the page's, as it seals them,
// and its own); a guest's worker keeps the host's (its page gets them over
// its own link as before, and the worker's copy when the host's worker
// sealed them: its page sent none). JSON text, long ones in parts.
const _simNet = new Map();
const SIM_NET_PART_CHARS = 60000;
// A guest: the host's state its bundles are of (the host's epoch: a restore
// there starts another; bundles of the one before no longer hold). Each
// host counts its own: a new host's (a migration) starts the count again
// (its lower counts were refused, and the worker took no ticks past a
// stalled page: audit 2026-10-15, 18).
let _simNetGen = 0, _simNetGenHost = '', _simNetOtherMatch = 0;
// The sealed ticks the host's worker sent (not the page's own word): their
// host or its state changed.
function _simSealedDropNet() { for (const [t, e] of _simSealed) if (e.gen) _simSealed.delete(t); }
function _simNetAdd(peer, dc) {
    if (!peer || !dc) return;
    const old = _simNet.get(peer);
    if (old) { try { old.dc.close(); } catch { } }
    const e = { dc, ready: false, parts: null };
    _simNet.set(peer, e);
    const hello = () => { try { dc.send('{"t":"H"}'); } catch { } };
    dc.onopen = hello;
    dc.onclose = () => { if (_simNet.get(peer) === e) _simNet.delete(peer); };
    dc.onmessage = ev => { try { _simNetMessage(peer, e, ev.data); } catch (err) { _simError('net', err); } };
    if (dc.readyState === 'open') hello();
}
// Every one of these peers has a worker listening on its channel.
function _simNetReady(peers) {
    if (!Array.isArray(peers)) return false;
    for (const p of peers) { const e = _simNet.get(p); if (!e || !e.ready || e.dc.readyState !== 'open') return false; }
    return true;
}
function _simNetBroadcast(msg) {
    if (_simNet.size === 0) return;
    const text = JSON.stringify({ t: 'B', e: _simEpoch, m: msg });
    for (const [, e] of _simNet) {
        if (!e.ready || e.dc.readyState !== 'open') continue;
        try {
            if (text.length <= SIM_NET_PART_CHARS) { e.dc.send(text); continue; }
            const n = Math.ceil(text.length / SIM_NET_PART_CHARS);
            for (let i = 0; i < n; i++) e.dc.send(JSON.stringify({ t: 'C', i, n, s: text.slice(i * SIM_NET_PART_CHARS, (i + 1) * SIM_NET_PART_CHARS) }));
        } catch { }
    }
}
function _simNetMessage(peer, e, data) {
    if (typeof data !== 'string') return;
    let m = JSON.parse(data);
    if (m.t === 'H') { e.ready = true; return; }
    if (m.t === 'C') {
        if (m.i === 0) e.parts = [];
        if (!e.parts || e.parts.length !== m.i) { e.parts = null; return; }
        e.parts.push(m.s);
        if (e.parts.length < m.n) return;
        m = JSON.parse(e.parts.join(''));
        e.parts = null;
    }
    const arm = _simAuto.arm;
    // (Bundles: from the match's host only, to a guest.)
    if (m.t !== 'B' || !arm || arm.role !== 'guest' || peer !== arm.host || !m.m || _simMode !== 'authority') return;
    // (Of this match only, before anything is counted or kept: another
    // match's (a rematch counts its ticks from 0 again) went into the sealed
    // ticks and ran (audit 2026-10-16, 24). A tagged match only: the page's
    // check passes untagged ones, a match without a session.)
    const w = m.m.w;
    if (!w || typeof w !== 'object' || String(w.m || '') !== String(matchStartSessionId || '')) { _simNetOtherMatch++; return; }
    const gen = (m.e | 0) + 1;
    if (peer !== _simNetGenHost) { _simNetGenHost = peer; _simNetGen = 0; _simSealedDropNet(); }
    if (gen < _simNetGen) return;
    // (A new state of the host's (a restore there): its bundles of the one
    // before no longer hold.)
    if (gen !== _simNetGen) { _simNetGen = gen; _simSealedDropNet(); }
    const b = unpackTickBundleFromWire(w);
    if (!b || !validateTickBundle(b) || b.tick < currentTick) return;
    const have = _simSealed.get(b.tick);
    if (!have || (have.gen && have.gen !== gen)) _simSealed.set(b.tick, { actions: b.packets.flatMap(p => Array.isArray(p.actions) ? p.actions : []), flush: !!b.flush, gen, dk: b.dk | 0 || 1 });
    // (One the host's worker sealed: its page did not send it.)
    if (m.m.auto) _simPost({ type: 'netBundle', epoch: _simEpoch, msg: m.m });
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
    // A match made here (msg.create: solo, a host): startGame makes the whole
    // world, starting units and buildings too; the page made the same map
    // without them and gets the world from here ('startState', then frames).
    // Otherwise its entities come with the snapshot.
    const create = !!msg.create;
    startGameSkipStarters = !create || !!msg.scene;
    try { startGame(); } finally { startGameSkipStarters = false; }
    T.startGame = performance.now() - t0;
    _simStubUi();
    if (msg.scene) applySoloScene(msg.scene);
    // gameStarted, isMultiplayer... as on the page (startGame may reset them).
    for (let [name, value] of Object.entries(g.assign || {})) self.eval(name + ' = ' + JSON.stringify(value));
    let startText = null;
    if (create && msg.startText) {
        // A host: the start text for its guests, and restored here as they
        // restore it, so the match starts identical everywhere (fields a
        // restore rebuilds would otherwise differ on the host).
        const t5 = performance.now();
        startText = JSON.stringify(buildHostAuthoritativeStateSnapshot({ includeConfig: false, includeStaticMapState: true, includeGridTypes: true }));
        T.encodeStart = performance.now() - t5;
    }
    if (!create || startText) {
        const t1 = performance.now();
        const snap = JSON.parse(create ? startText : msg.snapshotText);
        T.parse = performance.now() - t1;
        const t2 = performance.now();
        applyAuthoritativeStateSnapshot(snap);
        T.apply = performance.now() - t2;
    }
    if (create) {
        // The page's copy: the state without units (they come from frames),
        // with the map's areas and grid types, as the page restored a start.
        const t6 = performance.now();
        const head = buildHostAuthoritativeStateSnapshot({ includeConfig: false, includeStaticMapState: true, includeGridTypes: true, withoutState: true });
        const pageText = JSON.stringify(head).slice(0, -1) + ',"state":' + JSON.stringify(snapEncodeState({ noUnits: true })) + '}';
        T.encodePage = performance.now() - t6;
        _simPost({ type: 'startState', epoch: _simEpoch, pageText, startText, units: units.length });
    }
    // The map's first navigation builds, which its first tick makes
    // (navTick) from this same state: made before the match is reported
    // started, not in a first tick of ~1 s right after the start.
    const t4 = performance.now();
    if (typeof _navProfilesInUse === 'function' && !_nav[NAV_PROFILE_GROUND]) for (const p of _navProfilesInUse()) navEnsure(p);
    T.nav = performance.now() - t4;
    _simStartTimings = T;
    _simEvents = [];
    _simLocalDefeat = '';
    // (The last match's defeated teams went on in this one's frames: in a
    // rematch the host took its guests for spectators and left their
    // commands out of the bundles.)
    _simDefeatedTeams = [];
    _simDeltaLast = { e: [], a: [] };
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
// What each player's energy and star stockpiles gained and paid this tick,
// by source (the logs the HUD's rates are read from are filled here, in the
// simulation: the page gets each tick's sums and keeps logs of its own).
// (Per log, the last entry already sent.)
let _simDeltaLast = { e: [], a: [] };
function _simDeltaEvents(events) {
    if (typeof energyDeltaEventLogByPlayer === 'undefined' || typeof astarUsageEventLogByPlayer === 'undefined') return;
    for (const [tag, logs, last] of [['E', energyDeltaEventLogByPlayer, _simDeltaLast.e], ['A', astarUsageEventLogByPlayer, _simDeltaLast.a]]) {
        for (let pid = 0; pid < logs.length; pid++) {
            const b = logs[pid];
            if (!Array.isArray(b) || b.length === 0) continue;
            const stop = last[pid], sums = new Map();
            for (let i = b.length - 1; i >= 0 && b[i] !== stop; i--) {
                const ev = b[i];
                if (!ev) continue;
                const d = tag === 'E' ? Number(ev.delta) : (Number.isFinite(Number(ev.delta)) ? Number(ev.delta) : -Math.max(0, Number(ev.used) || 0));
                if (!Number.isFinite(d) || d === 0) continue;
                const key = tag === 'E' ? String(ev.source || '') : String(ev.unitType || 'other') + '|' + String(ev.source || '');
                sums.set(key, (sums.get(key) || 0) + d);
            }
            last[pid] = b[b.length - 1];
            for (const [key, d] of sums) {
                if (tag === 'E') events.push(['E', pid, key, d]);
                else { const cut = key.indexOf('|'); events.push(['A', pid, key.slice(0, cut), key.slice(cut + 1), d]); }
            }
        }
    }
}
// ---- ?simtrace=1: where the slow ticks go ----
// Each tick's time by phase (the functions below, nested ones counted in
// both), the gap since the previous tick's end and how late it started; the
// page keeps them in window.__simTrace (sim_client.js). A phase that is long
// only in the slow ticks is the spike; time in the tick but in none of the
// phases is the rest (collections, the pump).
const SIM_TRACE_FNS = ['processActions', 'spatialIndexRebuild', 'navTick', 'navFieldsFlush', 'recalculateUnitEffectiveLevel',
    'updateAllPlayerVisibility', 'towersTick', 'projectilesBegin', 'projectilesEnd', 'statusPrepassRun', 'simMoveRun', 'combatScanRun', '_acqCommit', '_acqPost',
    'unitEventsRun', 'unitHitsResolve', 'unitRetirePrepare', 'simUnitStateCollect', 'workerSearchTierStep', 'adjacencyLaneStep', 'gameStatsStep',
    'tickStatusEffects', 'occupancyPrepareMovement', 'trafficAfterMovement', 'simParallelBackgroundWait', 'simPresentTickEnd', 'snapRecordTickHash', '_simPostResult',
    'processGlobalSpawnerQueue', 'healerCandidatesStep', 'spawnerStructuresTick', 'laserBeamsTick', 'projectilesAdvance', 'visCoverHoldEnd',
    // (The worker search tier's parts.)
    '_wsPost', '_wsOrder', '_wsCommit', '_wsTakeSome', '_wswStep', '_wswBuild', '_wsCollectorGroup', '_wsNearField', '_ensureHealerDamagedCandidatesCacheCurrent'];
let _simTraceCur = null, _simTraceRows = [], _simTraceEndAt = 0;
function _simTraceInstall() {
    for (const name of SIM_TRACE_FNS) {
        const f = self[name];
        if (typeof f !== 'function') continue;
        self[name] = function () {
            const cur = _simTraceCur;
            if (!cur) return f.apply(this, arguments);
            const a = performance.now();
            try { return f.apply(this, arguments); } finally { const ph = cur.ph; ph[name] = (ph[name] || 0) + performance.now() - a; }
        };
    }
    const inner = _simTick;
    _simTick = function (msg) {
        const a = performance.now(), cur = _simTraceCur = { tick: msg.tick, gap: _simTraceEndAt ? a - _simTraceEndAt : 0, late: Number.isFinite(msg.due) ? Math.max(0, _simNowAbs() - msg.due) : 0, total: 0, ph: {} };
        try { return inner.apply(this, arguments); } finally {
            const b = performance.now();
            cur.total = b - a; _simTraceCur = null; _simTraceEndAt = b;
            _simTraceRows.push(cur);
            if (_simTraceRows.length >= 40) { _simPost({ type: 'trace', rows: _simTraceRows }); _simTraceRows = []; }
        }
    };
}

// ---- one tick: the same work runOneTick does, with the page's commands ----
function _simTick(msg) {
    let t0 = performance.now();
    if (msg.tick !== currentTick) {
        _simPost({ type: 'error', where: 'tick', message: `tick ${msg.tick} arrived at ${currentTick}` });
        return;
    }
    // (How late it starts against its deadline.)
    let lateMs = Number.isFinite(msg.due) ? Math.max(0, _simNowAbs() - msg.due) : 0;
    // (The tick clock, for ticks the worker runs by itself: _simAutoStep.)
    _simAuto.dueTick = msg.tick; _simAuto.due = Number.isFinite(msg.due) ? msg.due : _simNowAbs(); _simAuto.teams = msg.teams;
    _simSealed.delete(msg.tick);
    pathfindBudget = 0;
    // (The step's base ticks, as sealed.)
    simDk = Math.max(1, Math.min(SIM_DK_MAX, msg.dk | 0 || 1));
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
    let hash = msg.hash && snapHashDue(tick) ? snapRecordTickHash(tick) : null;
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

// Shared sight grids sent to the page, by id.
const _simSightIds = new WeakMap();
let _simSightSeq = 0;
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
    _simDeltaEvents(_simEvents);
    let events = _simEvents;
    _simEvents = [];
    // The local player's raw visibility grid (computed here anyway): the
    // page uses it instead of computing its own. (A pooled buffer.)
    let sight = null, sightId = 0;
    try {
        // The grid this tick computed (asking for it now would compute the
        // next tick's: the clock has moved on).
        let rows = visibilityGridRawByPlayerCache.get(localPlayerId) || getRawVisibilityGridForPlayer(localPlayerId), n = GRID_W * GRID_H;
        if (_simPresentation && rows._flat && rows._flat.buffer instanceof SharedArrayBuffer) {
            // A read-only presentation binding: no million-cell allocation or
            // copy each tick. The renderer tolerates visibility advancing.
            sight=rows._flat;
            // (Its id: the page keeps its rows of the same shared grid.)
            sightId = _simSightIds.get(sight) || 0;
            if (!sightId) _simSightIds.set(sight, sightId = ++_simSightSeq);
        } else {
            let buf = _simFrameAcquireExact(n * 4);
            sight = new Float32Array(buf, 0, n);
            for (let y = 0; y < GRID_H; y++) if (rows[y]) sight.set(rows[y], y * GRID_W);
            transfer.push(buf);
        }
    } catch (err) { sight = null; _simError('sight', err); }
    _simPost({ type: 'ticked', epoch: _simEpoch, tick, world, presentation:!!_simPresentation, hash, lockHashes: lock, events, sight, sightId, sightPlayer: localPlayerId, simMs, encodeMs: performance.now() - t1, report,
        lateMs: _simTickLateMs, doneAt: _simNowAbs() }, transfer);
}

// ---- requests the page's network code needs in tick order ----
function _simRequest(msg) {
    let result = null;
    try { result = _simRequestRun(msg); } catch (err) {
        // (A request that throws still answers: its promise on the page
        // waited for good (a malformed patch held the page's ticks), and the
        // silence looked like a lost worker. A restore that failed left no
        // state to go on from: the page gets the match again.)
        const message = String(err && err.message || err);
        if (msg.op === 'applySnapshot') _simPost({ type: 'restoreFailed', epoch: msg.args && msg.args.epoch, message });
        if (msg.id) _simPost({ type: 'reply', id: msg.id, error: message });
        _simError('request ' + msg.op, err);
        return;
    }
    if (msg.id) _simPost({ type: 'reply', id: msg.id, result });
}
function _simRequestRun(msg) {
    let result = null;
    switch (msg.op) {
        // Runs in the tick stream, after all ticks dispatched before the click.
        // Both the clock and the entities must come from this same world.
        case 'soloSnapshot':
            result = buildSoloGameSnapshotParts(msg.args);
            break;
        // Host: a resync patch of the state before the next tick.
        case 'encodePatch':
            result = JSON.stringify(snapEncodeState(msg.args && msg.args.buckets ? { buckets: msg.args.buckets } : null));
            break;
        // The whole state (joins, reloads, rematch...) as JSON text, for the
        // page to wrap (it cloned the state over as objects and stringified
        // it on its main thread).
        case 'encodeStateText':
            result = { text: JSON.stringify(snapEncodeState()), gameTime };
            break;
        // Guest: a resync patch before the next tick. (The page sees its
        // effects in the next frame and records.)
        case 'applyPatch': {
            const presenting=!!_simPresentation;
            if(presenting) simPresentationStop();
            // (The result: whether the decoder took it; null when it refused
            // it (another format or rules): nothing changed then. One that
            // throws answers with its error: _simRequest.)
            try {
                result = !!snapDecodeState(JSON.parse(msg.args.text), { collectChanges: !msg.args.full });
                if (result) reviewLocalDefeat();
                visibilityCacheTick = -1;
                updateVisibility(localPlayerId);
            } finally { if(presenting) simPresentationStart(); }
            break;
        }
        // A whole-state restore; results before it belong to the old epoch.
        case 'applySnapshot': {
            simPresentationStop();
            let snap = msg.args.snapshot || JSON.parse(msg.args.text);
            if (msg.args.globals) for (let [name, value] of Object.entries(msg.args.globals)) self.eval(name + ' = ' + JSON.stringify(value));
            if (!applyAuthoritativeStateSnapshot(snap)) throw new Error('the snapshot was refused (another format or rules)');
            _simEpoch = msg.args.epoch;
            _simEvents = [];
            _simLocalDefeat = '';
            _simDefeatedTeams = [];
            reviewLocalDefeat();
            // The page's world comes whole with the next frame.
            simFrameResetAll();
            simPresentationStart();
            // The page's clock waits for this epoch's world (simClientWorldReady):
            // without it a match stopped for good after a mid-match restore.
            _simPost({ type: 'started', epoch: _simEpoch, tick: currentTick });
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
    return result;
}
