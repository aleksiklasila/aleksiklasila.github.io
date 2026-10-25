"use strict";
// ============================================================
// SIMULATION WORKER, PAGE SIDE (authority)
//
// With the simulation worker on (the default; ?simworker=0 turns it off),
// game ticks run in src/sim/sim_worker.js. The page keeps the lockstep, the
// network and everything on screen:
//
// - runOneTick hands the tick's commands to the worker (simClientRunTick)
//   instead of simulating; a few ticks can be in flight.
// - The world: each result carries its frame (sim_frame.js: units;
//   sim_frame_world.js: structures, projectiles, players and globals, changed
//   cells), buffers the page reads it from (as views) until the next frame
//   arrives, and then hands back. The selection also gets detail records.
// - Side effects (sounds, flashes, alerts, particles, combat effects) are
//   replayed, then the per-tick page work runs (stats, win/defeat UI,
//   visual visibility).
// - Multiplayer: the worker's rolling state hash of each tick feeds the
//   resync bookkeeping; resync patches are encoded or applied by the worker
//   in tick order. Whole-state restores start a new epoch: results of the
//   old one are dropped.
// ============================================================

const simClientEnabled = (() => {
    // On by default; ?simworker=0 keeps ticks on the page (?simworker=shadow
    // is the separate comparison mode, sim_shadow.js).
    if (typeof Worker === 'undefined') return false;
    try { let v = new URLSearchParams(location.search).get('simworker'); return v !== '0' && v !== 'shadow'; } catch { return true; }
})();

let _simClient = null;
// Ticks dispatched to the worker whose results have not come back yet.
const SIM_CLIENT_MAX_IN_FLIGHT = 2;
// With shared memory: ticks ready to run (multiplayer: sealed, their
// commands final) are dispatched ahead of the worker, each with its deadline
// on the tick clock. The worker runs them on time whatever the page is doing
// (drawing, applying results); the page tops the queue up when it can,
// reading the worker's progress from shared memory (never waiting for
// results). A sealed tick's commands are fixed, so queueing it adds no
// input delay; a page stalled up to the lead's worth of ticks no longer
// stalls the simulation.
const SIM_CLIENT_LEAD_TICKS = 3;
// The lead in steps: SIM_CLIENT_LEAD_TICKS base ticks' worth of time, one at
// least. (A step of several base ticks lasts their time: three steps of
// lead at one step a second put three seconds between an order and the
// step it runs in.)
function simClientLeadTicks() {
    const ms = typeof netSimulationTickMs === 'function' ? netSimulationTickMs() : TICK_MS;
    return Math.max(1, Math.ceil(SIM_CLIENT_LEAD_TICKS * TICK_MS / Math.max(TICK_MS, ms) - 1e-9));
}
// (?simahead=0: as before, ticks dispatched when due; for comparisons.)
const simClientAheadEnabled = (() => { try { return new URLSearchParams(location.search).get('simahead') !== '0'; } catch { return true; } })();
// The current units' frame (sim_frame.js views) while `units` is its list.
function simClientCurrentUnitVis() {
    let c = _simClient;
    return c && c.active && c.frameUnits === units && _pageFrame ? _pageFrame : null;
}

// Test hook: called with each tick once its result is applied.
let simClientTickAppliedHook = null;

function simClientInFlight() {
    return _simClient ? _simClient.inFlight : 0;
}

function _simClientScriptUrls() {
    return [...document.querySelectorAll('script[src]')]
        .map(s => s.src)
        .filter(src => /\/src\//.test(src) && !/bootstrap\.js|sim_shadow\.js|sim_worker\.js|sim_client\.js/.test(src));
}

const SIM_CLIENT_WORKER_URL = './src/sim/sim_worker.js?v=20261024-ui5';

function _simClientCreate() {
    let c = {
        worker: null, loaded: false, active: false, epoch: 0, startTick: -1, nextRequestId: 1, replies: new Map(),
        inFlight: 0, lastDispatchAt: 0, tickClock: 0, dispatchAt: new Map(), appliedTick: -1, appliedAt: 0, latencyMs: TICK_MS, arrivedAt: 0, intervalMs: TICK_MS, drawnAlpha: -1, errors: [],
        // (Presentation frames: their playout, see _simPlayArrived; when a frame was last drawn.)
        play: _simPlayNew(), drawAt: 0,
        // [epoch, last tick the worker ran, ...the words of the worker's own
        // ticks: SIM_CTL_*] (shared memory only).
        ctl: (typeof SharedArrayBuffer === 'function' && typeof window !== 'undefined' && window.crossOriginIsolated) ? new Int32Array(new SharedArrayBuffer(64)) : null,
        // (The heartbeat's origin, absolute ms: the worker's clock has another.)
        ctlBase: typeof performance.timeOrigin === 'number' ? Math.floor(performance.timeOrigin + performance.now()) : NaN,
        autoKey: '', autoDeferred: [], autoTicks: 0, autoSeals: 0,
        lateMs: 0,
        stats: { applied: 0, applyMs: [], simMs: [], encodeMs: [], latencyMs: [], lateMs: [], rows: 0, heals: 0, dropped: 0 }
    };
    if (c.ctl) c.ctl[0] = -1;
    // ?simhelpers=N: at most N helper workers for the parallel jobs (0: none).
    let maxHelpers = null;
    try { let q = new URLSearchParams(location.search).get('simhelpers'); if (q !== null && q !== '') maxHelpers = Math.max(0, Math.floor(Number(q)) || 0); } catch { }
    _simClientSpawn(c, false, maxHelpers);
    return c;
}

// Some local servers send .js as text/plain, and Firefox will not start a
// worker from that. The first load error before 'loaded' retries once from a
// blob of the script (told its real URL, for the files it loads itself).
function _simClientSpawn(c, viaBlob, maxHelpers) {
    let worker;
    if (!viaBlob) worker = new Worker(SIM_CLIENT_WORKER_URL);
    else {
        let url = new URL(SIM_CLIENT_WORKER_URL, location.href).href;
        let xhr = new XMLHttpRequest();
        xhr.open('GET', url, false);
        xhr.send();
        if (xhr.status !== 200 && xhr.status !== 0) throw new Error('could not load ' + url + ' (' + xhr.status + ')');
        let nl = String.fromCharCode(10);
        let blobUrl = URL.createObjectURL(new Blob(['self.SIM_WORKER_BASE = ' + JSON.stringify(url) + ';' + nl + xhr.responseText + nl + '//# sourceURL=' + url], { type: 'text/javascript' }));
        worker = new Worker(blobUrl);
        setTimeout(() => URL.revokeObjectURL(blobUrl), 10000);
    }
    c.worker = worker;
    // (A lost worker's client is replaced: what its worker still says is not
    // the new one's.)
    worker.onmessage = ev => { if (_simClient !== c) return; try { _simClientOnMessage(ev.data || {}); } catch (err) { reportRuntimeError('sim worker', err); } };
    worker.onerror = ev => {
        if (c.worker !== worker) return;
        if (!ev.message && !c.loaded && !viaBlob) {
            ev.preventDefault();
            worker.terminate();
            console.warn('[sim worker] could not start from its URL (served as text/plain?); retrying from a blob');
            try { _simClientSpawn(c, true, maxHelpers); } catch (err) { c.failed = String(err.message || err); console.error('[sim worker]', c.failed); }
            return;
        }
        // No message: a script failed to load (the worker's, or a nested one's).
        let where = ev.filename ? ` (${ev.filename}:${ev.lineno}:${ev.colno})` : '';
        let text = (ev.message || 'worker error, no message (script failed to load?)') + where;
        c.errors.push(text); if (!c.loaded) c.failed = text; console.error('[sim worker]', text, ev);
    };
    worker.postMessage({ type: 'load', scripts: _simClientScriptUrls(), maxHelpers, ctl: c.ctl, ctlBase: c.ctlBase, trace: /[?&]simtrace=1(?:&|$)/.test(location.search),
        // (The kernel build, as the page picks it: sim_wasm.js SIM_WASM64_ENABLED.)
        wasm64: typeof SIM_WASM64_ENABLED !== 'undefined' ? !!SIM_WASM64_ENABLED : false });
}

// Loaded ahead (the scripts take a few hundred ms), so matches start at once.
function simClientPreload() {
    if (!simClientEnabled || _simClient) return;
    _simClient = _simClientCreate();
}

// Whether ticks run in the worker for the current match.
function simClientActive() {
    return !!(_simClient && _simClient.active);
}
// Whether this match's world is loaded where it is simulated (the worker
// said 'started' for it), so the player can tick: a match start waits for
// this on every peer (utils_networking.js), not only for the page's state.
function simClientWorldReady() {
    const c = _simClient;
    return !c || !c.active || c.startedEpoch === c.epoch;
}

// ---- match start: the worker starts from the page's state ----
// Whether the worker takes the match about to start (it loaded, no exact
// lockstep debugging): the page then needs no units of its own.
// (Exact lockstep debugging runs on the page only where the page can run
// the kernels: a page whose worker simulates has none (sim_wasm.js), and
// its matches did not tick at all.)
function _simClientPageSimulates() {
    return lockstepStrictDebugMode && typeof _simHeap !== 'undefined' && !!_simHeap.ready;
}
function simClientWillTakeMatch() {
    if (!simClientEnabled || _simClientPageSimulates()) return false;
    simClientPreload();
    const c = _simClient;
    return !!(c && c.loaded && !c.failed);
}
// A start state without its units, for the page: its units come from the
// worker's frames (made and dropped at once, 200k of them were seconds);
// references to them are the worker's business.
function simClientStripUnits(state) {
    if (state && state.lists) { state.lists.u = []; state.res = []; }
}
// At a match's load, on every peer (the host once its start snapshot is
// made, a guest once it restored the host's, solo after startGame), so the
// start waits for the worker to have the world (simClientWorldReady); the
// first tick starts it otherwise. startText: the start snapshot (made from
// the page's state when not given); decodePage: restores it on the page
// (without units; a plain decode when not given). The worker gets the text
// first: it loads while the page decodes.
function simClientStartMatch(startText = null, decodePage = null) {
    if (!simClientEnabled || _simClientPageSimulates()) return false;
    simClientPreload();
    let c = _simClient;
    // A worker that is still loading, or could not load the game, does not
    // take the match: it runs on the page as without ?simworker=1.
    if (!c.loaded || c.failed) {
        console.warn('[sim worker] ' + (c.failed ? 'failed to load (' + c.failed + ')' : 'not loaded yet') + '; this match runs on the page');
        return false;
    }
    if (typeof _simClientStartedThisMatch !== 'undefined') _simClientStartedThisMatch = true;
    let text = startText || JSON.stringify(buildHostAuthoritativeStateSnapshot({ includeConfig: false, includeStaticMapState: true, includeGridTypes: true }));
    let controls = {};
    for (let el of document.querySelectorAll('input[id], select[id]')) controls[el.id] = el.type === 'checkbox' ? { checked: el.checked } : { value: el.value };
    c.epoch++;
    c.active = true;
    // (Kept until the worker has the world: the page's own if it fails.)
    c.startText = text;
    for (let [, r] of c.replies) r.reject(new Error('match restarted'));
    c.replies.clear();
    c.worker.postMessage({
        type: 'start', mode: 'authority', epoch: c.epoch, snapshotText: text, controls,
        globals: {
            assign: _simClientGlobals(),
            editableConfig: typeof serializeEditableRuntimeConfigForTransport === 'function' ? serializeEditableRuntimeConfigForTransport() : null,
            startingResources: typeof startingResourcesConfig !== 'undefined' ? startingResourcesConfig : null
        }
    });
    // The page's copy decodes the same state (the lockstep bookkeeping stays
    // as it is) while the worker loads it. Its own units go first: the
    // restore has none to detach (200k took ~1 s). The page ran no tick since
    // its last restore, so no peer has history caches to drop yet.
    _simClientResetUnits();
    // (The page's restore of the start state is not a resync for the
    // worker, which loads the full text: simClientAfterSnapshotApplied.)
    if (decodePage) { c.decodingStart = true; try { decodePage(); } finally { c.decodingStart = false; } }
    else {
        let pageTick = currentTick;
        snapFlushHistoryCaches();
        let pageState = JSON.parse(text).state;
        simClientStripUnits(pageState);
        snapDecodeState(pageState);
        currentTick = pageTick;
    }
    // Units come from the worker's frames (the first one with 'started').
    _simClientResetUnits();
    recomputePlayerPopCaps();
    // The worker simulates from here on: the page reads its grids.
    _visCoverSimContext = false;
    clearGameplayVisibilityCache();
    updateVisibility(localPlayerId);
    c.startTick = currentTick;
    c.inFlight = 0;
    c.dispatchAt.clear();
    c.appliedTick = currentTick - 1;
    c.appliedAt = 0; c.arrivedAt = 0;
    c.gameOverShown = false;
    _simAutoSync(c);
    return true;
}

// A match the worker makes (solo, a host): the page ran startGame without
// the starting units and buildings (startGameSkipStarters: the map, the
// players), the worker runs it with them, and the page's copy of the world
// comes from it (the state without units, 'startState'; units from frames).
// No world is made on the page and no snapshot of it crosses to the worker
// (at 2M units the page's world and the JSON both ways were ~100 s and
// several GB at once). opts.startText: also the start text for guests (a
// host; the worker restores it too, as they do). opts.onFail: runs when the
// worker cannot make it (the page then makes the match itself). Returns a
// promise of the start text (null without opts.startText), or false when
// the worker does not take the match.
function simClientCreateMatch(opts = {}) {
    if (!simClientEnabled || _simClientPageSimulates()) return false;
    simClientPreload();
    const c = _simClient;
    if (!c.loaded || c.failed) return false;
    if (typeof _simClientStartedThisMatch !== 'undefined') _simClientStartedThisMatch = true;
    let controls = {};
    for (let el of document.querySelectorAll('input[id], select[id]')) controls[el.id] = el.type === 'checkbox' ? { checked: el.checked } : { value: el.value };
    c.epoch++;
    c.active = true;
    c.startText = null;
    for (let [, r] of c.replies) r.reject(new Error('match restarted'));
    c.replies.clear();
    const promise = new Promise((resolve, reject) => { c.creating = { epoch: c.epoch, resolve, reject, scene: !!opts.scene, onFail: opts.onFail || null }; });
    promise.catch(() => { });
    c.worker.postMessage({
        type: 'start', mode: 'authority', epoch: c.epoch, create: true, startText: !!opts.startText, scene: opts.scene || null, controls,
        globals: {
            assign: _simClientGlobals(),
            editableConfig: typeof serializeEditableRuntimeConfigForTransport === 'function' ? serializeEditableRuntimeConfigForTransport() : null,
            startingResources: typeof startingResourcesConfig !== 'undefined' ? startingResourcesConfig : null
        }
    });
    _simClientResetUnits();
    _visCoverSimContext = false;
    c.startTick = currentTick;
    c.inFlight = 0;
    c.dispatchAt.clear();
    c.appliedTick = currentTick - 1;
    c.appliedAt = 0; c.arrivedAt = 0;
    c.gameOverShown = false;
    _simAutoSync(c);
    return promise;
}
// The worker's world for the page (before its 'started'): restored without
// units, as a start the page restored itself.
function _simClientCreated(c, msg) {
    const job = c.creating;
    c.creating = null;
    const pageTick = currentTick;
    let parsed = JSON.parse(msg.pageText);
    msg.pageText = null;
    c.decodingStart = true;
    try {
        if (isMultiplayer || job.scene) applyAuthoritativeStateSnapshot(parsed);
        else { snapFlushHistoryCaches(); snapDecodeState(parsed.state); currentTick = pageTick; }
    } finally { c.decodingStart = false; }
    parsed = null;
    _simClientResetUnits();
    recomputePlayerPopCaps();
    clearGameplayVisibilityCache();
    updateVisibility(localPlayerId);
    job.resolve(msg.startText || null);
}

// The worker could not start the match (an error loading its state): the
// match runs on the page, as with a worker that never loaded, from the start
// state the page kept (its copy had no units: the worker's were to come).
// (It waited for the worker's world for good: the match stood at tick 0.)
// A match the worker was to make: the page makes it (opts.onFail).
function _simClientStartFailed(reason) {
    const c = _simClient;
    if (!c || !c.active) return;
    c.failed = 'start: ' + reason;
    c.active = false;
    _simClientRestoreSettle(c, false);
    _simAutoSync(c);
    console.warn('[sim worker] could not start the match (' + reason + '); this match runs on the page');
    try { c.worker.terminate(); } catch { }
    const job = c.creating;
    if (job) {
        c.creating = null;
        job.reject(new Error(reason));
        if (job.onFail) job.onFail(reason);
        return;
    }
    const text = c.startText;
    c.startText = null;
    if (!text) return;
    const pageTick = currentTick;
    snapFlushHistoryCaches();
    snapDecodeState(JSON.parse(text).state);
    currentTick = pageTick;
    recomputePlayerPopCaps();
    clearGameplayVisibilityCache();
    updateVisibility(localPlayerId);
}

// ---- a worker lost mid-match ----
// A worker whose match state is gone (a restore it could not make) takes
// the match with it: the page stops ticking, starts a new worker (a few at
// most: one that keeps failing leaves matches to the page) and gets the
// match again where there is one to get (utils_networking.js
// netRecoverLostSimulation: a guest from its host, a host by handing the
// match to a player and joining it); the match's reload (startGame) ends
// the hold.
// Silence is not a loss: the worker catches and reports its own errors,
// and one killed by the browser takes the tab with it. A silence limit
// (10 s in a match, at most 2 min loading) only ever caught slow work: a
// 2M-unit world's first ticks took longer, and the page threw the loaded
// world away (2026-10-17). A slow worker is waited for.
const SIM_CLIENT_RESPAWNS = 3;
let _simClientLost = null, _simClientRespawns = 0;
function simClientLostPending() { return !!_simClientLost; }
// From the page's tick pump: true while ticks must wait (the worker lost).
function simClientLostHold(now) { return !!_simClientLost; }
function _simClientWorkerLost(reason) {
    const c = _simClient;
    if (!c || !c.active || _simClientLost) return;
    console.error('[sim worker] lost during the match (' + reason + ')');
    c.failed = 'lost: ' + reason;
    c.active = false;
    c.epoch++;
    try { c.worker.terminate(); } catch { }
    const lost = new Error('the simulation worker was lost');
    for (const [, r] of c.replies) { try { r.reject(lost); } catch { } }
    c.replies.clear();
    for (const d of c.autoDeferred) { try { d.reject(lost); } catch { } }
    c.autoDeferred = [];
    c.inFlight = 0;
    _simClientLost = { reason, at: performance.now() };
    _simClientRestoreSettle(c, false);
    _simClientRespawn(c);
    if (typeof netRecoverLostSimulation === 'function') netRecoverLostSimulation(reason);
}
// A new worker for later matches (a few at most: one that keeps failing
// leaves matches to the page).
function _simClientRespawn(c) {
    if (_simClient === c && ++_simClientRespawns <= SIM_CLIENT_RESPAWNS) _simClient = _simClientCreate();
}
// ---- a whole-state restore in the worker ----
// Whether the worker is loading a match now (a start, a restore): it may
// take as long as it takes, not a recovery's timeout.
function simClientLoading() {
    const c = _simClient;
    return !!(c && c.active && c.startedEpoch !== c.epoch && !_simClientLost);
}
// Resolves true once the worker restored what the page restored last (its
// 'started' for that epoch), false when it could not (it says so, or was
// lost): the page acknowledges a recovery only then (a refused one was
// acknowledged: audit 2026-10-16, 28). At once without a worker.
function simClientRestoreDone() {
    const c = _simClient;
    if (!c || !c.active) return Promise.resolve(!_simClientLost);
    if (c.startedEpoch === c.epoch) return Promise.resolve(true);
    return new Promise(resolve => (c.restoreWaiters || (c.restoreWaiters = [])).push(resolve));
}
function _simClientRestoreSettle(c, ok) {
    const list = c && c.restoreWaiters;
    if (!list) return;
    c.restoreWaiters = null;
    for (const r of list) { try { r(ok); } catch { } }
}
// A match (re)starts (startGame): the page ticks again.
function simClientLostClear() { _simClientLost = null; }
// Resolves once the worker loaded (or failed), or after ms.
function simClientWhenLoaded(ms) {
    return new Promise(resolve => {
        const t0 = performance.now();
        const check = () => {
            const c = _simClient;
            if (!c || c.loaded || c.failed || performance.now() - t0 >= ms) { resolve(!!(c && c.loaded && !c.failed)); return; }
            setTimeout(check, 50);
        };
        check();
    });
}

// Page globals the simulation reads.
function _simClientGlobals() {
    return {
        isMultiplayer, isHost, localPlayerId, gameSeed, activeTeamIds, gameMode, fullVisibility, matchFullVisibility, lockstepStrictDebugMode,
        SIM_ACQ_AREA_TARGETS: typeof SIM_ACQ_AREA_TARGETS!=='undefined'&&SIM_ACQ_AREA_TARGETS,
        SIM_ACQ_SAMPLE_BUDGET: typeof SIM_ACQ_SAMPLE_BUDGET!=='undefined'?SIM_ACQ_SAMPLE_BUDGET:0,
        SIM_OCCUPANCY_ENABLED: typeof SIM_OCCUPANCY_ENABLED!=='undefined'&&SIM_OCCUPANCY_ENABLED,
        SIM_OCCUPANCY_PLANES: typeof SIM_OCCUPANCY_PLANES!=='undefined'?SIM_OCCUPANCY_PLANES:1,
        SIM_TRAFFIC_MODE: typeof SIM_TRAFFIC_MODE!=='undefined'?SIM_TRAFFIC_MODE:0,
        SIM_TRAFFIC_RESPONSE: typeof SIM_TRAFFIC_RESPONSE!=='undefined'?SIM_TRAFFIC_RESPONSE:1,
        SIM_TRAFFIC_PASSES: typeof SIM_TRAFFIC_PASSES!=='undefined'?SIM_TRAFFIC_PASSES:1,
        SIM_TRAFFIC_LOCAL: typeof SIM_TRAFFIC_LOCAL!=='undefined'?SIM_TRAFFIC_LOCAL:1,
        myPeerId: typeof myPeerId !== 'undefined' ? myPeerId : null,
        lobbyPlayers: typeof lobbyPlayers !== 'undefined' ? lobbyPlayers : [], gameStarted: true,
        // (Its tick bundles carry the match: main.js packTickBundleForWire.)
        matchStartSessionId: typeof matchStartSessionId !== 'undefined' ? matchStartSessionId : ''
    };
}

// When the page's role or view changes (host migration, defeat...).
function simClientSyncGlobals() {
    if (simClientActive()) _simClient.worker.postMessage({ type: 'request', op: 'setGlobals', args: { assign: _simClientGlobals() } });
}

function simClientStop() {
    if (_simClient) _simClientRestoreSettle(_simClient, false);
    // (A match it was making is dropped: its world is not wanted now.)
    if (_simClient && _simClient.creating) { const job = _simClient.creating; _simClient.creating = null; job.reject(new Error('match stopped')); }
    if (_simClient) { _simClient.active = false; _simClient.epoch++; _simAutoSync(_simClient); _simClient.worker.postMessage({type:'presentationStop'}); }
}

// ---- ticks the worker takes by itself (a stalled page) ----
// See sim_worker.js (_simAutoStep): while this page's pump is not heard
// (its heartbeat in the shared block), the worker runs the ticks it holds
// the commands of (sealed bundles, handed to it as they are sealed:
// simClientNoteSealed; alone, ticks without commands), and a host's worker
// seals and sends ticks without commands. A tick has one source: the page
// claims each tick it dispatches (simClientClaimTick) and each a host seals
// (simClientSealClaim) in the shared block, where the worker claims its
// own; the worker's notes ('autoRan', 'autoSealed') move the page's lockstep
// on (main.js lockstepAdoptAutoTick, lockstepAdoptAutoSeal).
// ?simauto=0: off (a stalled page stalls its ticks, as before).
const SIM_CTL_CLAIM = 2, SIM_CTL_SEALED = 3, SIM_CTL_LIMIT = 4, SIM_CTL_INTENT = 5, SIM_CTL_BEAT = 6, SIM_CTL_PEPOCH = 7, SIM_CTL_STALE = 8;
// The pump not heard for this long: stalled (it runs with every drawn frame,
// and from a worker's timer every 25 ms when frames stop; a hidden page's
// from a timer every tick).
const SIM_AUTO_STALE_MS = 70, SIM_AUTO_STALE_HIDDEN_MS = 170;
const simClientAutoEnabled = (() => { try { return new URLSearchParams(location.search).get('simauto') !== '0'; } catch { return true; } })();
function _simAutoCtl() {
    let c = _simClient;
    return c && c.active && c.ctl && c.ctl.length >= 16 && simClientAutoEnabled && simClientAheadEnabled && Number.isFinite(c.ctlBase) ? c.ctl : null;
}
// The first tick the worker must leave to the page (0: all of them). Lowered
// only once the worker is out of a claim it began under the old limit.
function _simAutoSetLimit(C, limit) {
    let prev = Atomics.exchange(C, SIM_CTL_LIMIT, limit);
    if (limit < prev) { let t = performance.now(); while (Atomics.load(C, SIM_CTL_INTENT) !== 0 && performance.now() - t < 50) { } }
}
// A match starts or is restored: the worker takes nothing until the pump
// arms it again, and the words count from the page's tick.
function _simAutoSync(c) {
    let C = c.ctl;
    if (!C || C.length < 16) return;
    _simAutoSetLimit(C, 0);
    Atomics.store(C, SIM_CTL_PEPOCH, c.epoch);
    Atomics.store(C, SIM_CTL_CLAIM, currentTick - 1);
    Atomics.store(C, SIM_CTL_SEALED, currentTick - 1);
    c.autoKey = '';
    for (let r of c.autoDeferred.splice(0)) r.reject(new Error('match restarted'));
}
// The page is alive (every pump, every frame).
function simClientAutoBeat(now) {
    let C = _simAutoCtl();
    if (C) Atomics.store(C, SIM_CTL_BEAT, (performance.timeOrigin + now - _simClient.ctlBase) | 0);
}
// Every pump: how far the worker may go by itself, and what it needs to
// know for it (sent when it changes).
function simClientAutoArm(now) {
    let c = _simClient, C = _simAutoCtl();
    if (!C) return;
    simClientAutoBeat(now);
    Atomics.store(C, SIM_CTL_STALE, document.hidden ? SIM_AUTO_STALE_HIDDEN_MS : SIM_AUTO_STALE_MS);
    _simAutoSetLimit(C, c.autoDeferred.length || typeof lockstepAutoLimit !== 'function' ? 0 : lockstepAutoLimit());
    let info = lockstepAutoInfo(), key = JSON.stringify(info);
    if (key !== c.autoKey) { c.autoKey = key; c.worker.postMessage({ type: 'auto', ...info }); }
}
// A tick of the page's plans (a resync point) that the worker must not
// pass: from this moment, not from the next pump.
function simClientAutoBarrier(tick) {
    let C = _simAutoCtl();
    if (C && Atomics.load(C, SIM_CTL_LIMIT) > tick) _simAutoSetLimit(C, Math.max(0, tick));
}
// The worker stops taking ticks (till the next pump); returns the last tick
// the page or the worker has sealed or taken.
function simClientAutoFreeze() {
    let C = _simAutoCtl();
    if (!C) return currentTick - 1;
    _simAutoSetLimit(C, 0);
    return Math.max(currentTick - 1, Atomics.load(C, SIM_CTL_CLAIM), Atomics.load(C, SIM_CTL_SEALED));
}
// Whether the worker has not taken `tick` by itself (when it has, its note
// is on its way and the page's lockstep waits for it).
function simClientTickFree(tick) {
    let C = _simAutoCtl();
    return !C || Atomics.load(C, SIM_CTL_CLAIM) < tick;
}
// The worker took `tick`, or (a host) sealed it, and the page has not had
// its note yet: the page's lockstep waits for it.
function simClientAutoPending(tick) {
    let C = _simAutoCtl();
    if (!C) return false;
    return Atomics.load(C, SIM_CTL_CLAIM) >= tick || (isMultiplayer && isHost && Atomics.load(C, SIM_CTL_SEALED) >= tick && !lockstepBundleByTick[tick]);
}
function _simAutoClaimWord(word, tick) {
    let C = _simAutoCtl();
    if (!C) return true;
    let got = Atomics.compareExchange(C, word, tick - 1, tick);
    if (got === tick - 1) return true;
    if (got >= tick) return false;
    // (The word behind the page's count: never the worker's doing.)
    _simAutoSetLimit(C, 0);
    Atomics.store(C, word, tick);
    return true;
}
// Before the page dispatches `tick` / a host seals it: false when the worker
// did by itself.
function simClientClaimTick(tick) { return _simAutoClaimWord(SIM_CTL_CLAIM, tick); }
function simClientSealClaim(tick) { return _simAutoClaimWord(SIM_CTL_SEALED, tick); }
// A tick's commands are final: the worker holds them from now on (a host's:
// the bundle's message, which its worker sends on to the guests' workers).
function simClientNoteSealed(tick, payload) {
    let c = _simClient;
    if (_simAutoCtl()) c.worker.postMessage({ type: 'sealed', epoch: c.epoch, tick, ...payload });
}
// The worker ran `tick` by itself (lockstepAdoptAutoTick): in flight like
// one the page dispatched, on the worker's deadline for it.
function simClientNoteAutoTick(tick, dueAbs) {
    let c = _simClient;
    c.inFlight++;
    c.autoTicks++;
    let at = Number.isFinite(dueAbs) ? dueAbs - performance.timeOrigin : performance.now();
    c.tickClock = at;
    c.dispatchAt.set(tick, at);
    _simAutoFlushDeferred(c);
}
// Requests that waited for the page to hear of the worker's own ticks (the
// state a request reads or writes is the page's tick's).
function _simAutoFlushDeferred(c) {
    if (!c.autoDeferred.length || !simClientTickFree(currentTick)) return;
    for (let r of c.autoDeferred.splice(0)) {
        if (r.epoch !== c.epoch) { r.reject(new Error('match restarted')); continue; }
        let id = c.nextRequestId++;
        c.replies.set(id, { resolve: r.resolve, reject: r.reject, epoch: c.epoch });
        c.worker.postMessage({ type: 'request', id, op: r.op, args: r.args });
    }
}
// The page's link to a peer has a second data channel for the worker (the
// same peer connection; both ends make it, with the same id): a host's
// worker sends bundles over it, a guest's receives them, whatever the pages
// are doing. Where a channel cannot be handed to a worker, there is none
// (the other end's then closes) and ticks go over the page's link alone.
const SIM_NET_CHANNEL_ID = 64;
function simClientNetAttach(conn) {
    let c = _simClient;
    if (!c || !c.worker || !c.ctl || c.ctl.length < 16 || !simClientAutoEnabled || !simClientAheadEnabled) return;
    let pc = conn && conn.peerConnection;
    if (!pc || typeof pc.createDataChannel !== 'function') return;
    let dc = null;
    try {
        dc = pc.createDataChannel('defence3-ticks', { negotiated: true, id: SIM_NET_CHANNEL_ID });
        c.worker.postMessage({ type: 'netChannel', peer: String(conn.peer), dc }, [dc]);
    } catch (err) {
        if (dc) { try { dc.close(); } catch { } }
    }
}

// ---- ticks ----
// A catch-up tick (a guest behind its host): no deadline, the worker runs it
// at once (set by the page's pump for the next dispatch).
let simClientNextAsap = false;
function simClientRunTick(tick, actions, teams, flush, dk = 1) {
    let c = _simClient;
    let asap = simClientNextAsap;
    simClientNextAsap = false;
    c.inFlight++;
    // Ticks on the shared wall clock: one interval after the previous, unless
    // the match stalled (then from now), so frame timing does not jitter it.
    let now = performance.now();
    let tickMs = netSimulationTickMs();
    let at = c.tickClock + tickMs;
    if (!(at >= now - tickMs) || asap) at = now;
    c.tickClock = at;
    c.dispatchAt.set(tick, at);
    // (Its deadline as absolute time: the worker's clock has another origin.
    // Only when dispatched ahead: otherwise at once, as before.)
    let due = simClientDispatchAhead() && !asap && typeof performance.timeOrigin === 'number' ? performance.timeOrigin + at : undefined;
    // (The state hash only for a match with others: it is what peers compare
    // and repair from; alone it was ~2 ms of every tick for nobody.)
    c.worker.postMessage({ type: 'tick', tick, actions, teams, flush: !!flush, hash: !!isMultiplayer, due, dk });
}

// Whether ticks go to the worker ahead of time (shared memory).
function simClientDispatchAhead() {
    let c = _simClient;
    return !!(c && c.active && c.ctl && simClientAheadEnabled);
}
// Ticks dispatched that the worker has not run yet (its shared progress;
// without shared memory, the results not back yet).
function simClientWorkerAhead() {
    let c = _simClient;
    if (!c || !c.active) return 0;
    if (c.ctl && Atomics.load(c.ctl, 0) === c.epoch) return Math.max(0, (currentTick - 1) - Atomics.load(c.ctl, 1));
    return c.inFlight;
}
// A tick came due while the worker still had the whole lead queued (the
// page's pump): the worker is not keeping up (netSimulationBusy).
function simClientNoteBehind(now) { if (_simClient) _simClient.behindAt = now; }
function simClientBehind(now = performance.now()) { let c = _simClient; return !!(c && c.behindAt && now - c.behindAt < 1000); }
// The last tick the worker ran (shared memory), else the last result applied.
function simClientWorkerTick() {
    let c = _simClient;
    if (!c || !c.active) return currentTick - 1;
    if (c.ctl && Atomics.load(c.ctl, 0) === c.epoch) return Atomics.load(c.ctl, 1);
    return c.appliedTick;
}


// Tests: code the worker runs at this point of the tick stream.
function simClientWorkerEval(code) {
    if (simClientActive()) _simClient.worker.postMessage({ type: 'request', op: 'eval', args: { code } });
}

// Commands and requests go out in order; a reply resolves its promise.
function simClientRequest(op, args = null) {
    let c = _simClient;
    // A request reads or writes the state as of the page's tick: the worker
    // takes no tick by itself from here to the next pump, and when it has
    // taken some the page has not heard of yet, the request waits for that.
    let C = op !== 'debugEval' ? _simAutoCtl() : null;
    if (C) {
        _simAutoSetLimit(C, 0);
        if (!simClientTickFree(currentTick)) return new Promise((resolve, reject) => { c.autoDeferred.push({ op, args, resolve, reject, epoch: c.epoch }); });
    }
    let id = c.nextRequestId++;
    return new Promise((resolve, reject) => {
        c.replies.set(id, { resolve, reject, epoch: c.epoch });
        c.worker.postMessage({ type: 'request', id, op, args });
    });
}

function _simClientOnMessage(msg) {
    let c = _simClient;
    if (!c) return;
    switch (msg.type) {
        case 'loaded': c.loaded = true; c.helpers = msg.helpers || 0; c.shared = !!msg.shared; break;
        case 'startState':
            if (msg.epoch === c.epoch && c.creating && c.creating.epoch === msg.epoch) _simClientCreated(c, msg);
            break;
        case 'started':
            if (msg.epoch === c.epoch) { c.startedEpoch = msg.epoch; c.startTimings = msg.timings || null; c.startText = null; _simClientRestoreSettle(c, true); }
            if (msg.world) { if (msg.epoch === c.epoch) _simClientApplyWorld(msg.world, 1); else _simClientReturnBufs(_simClientWorldBufs(msg.world)); }
            break;
        case 'ticked': _simClientApplyTick(msg); break;
        // (?simtrace=1: the worker's per-tick phase times, see sim_worker.js.)
        case 'trace': { const T = window.__simTrace || (window.__simTrace = []); for (const r of msg.rows || []) T.push(r); if (T.length > 6000) T.splice(0, T.length - 6000); break; }
        // The worker's own ticks (a stalled page): one it ran, one a host's
        // worker sealed, a bundle the host's worker sealed (to a guest).
        case 'autoRan': if (msg.epoch === c.epoch && c.active) lockstepAdoptAutoTick(msg.tick, msg.due); break;
        case 'autoSealed': if (msg.epoch === c.epoch && c.active) { c.autoSeals++; lockstepAdoptAutoSeal(msg.tick, msg.msg); } break;
        case 'netBundle': if (msg.epoch === c.epoch && c.active && isMultiplayer && !isHost) handleIncomingTickBundle(netGetHostConnection(), msg.msg); break;
        // The presentation reader's own channel (frames come over it, their
        // buffers go back over it: not through the simulation worker).
        case 'presentationPort': {
            if (c.presentationPort) { try { c.presentationPort.close(); } catch { } }
            c.presentationPort = msg.port;
            msg.port.onmessage = ev => { if (_simClient !== c) return; try { _simClientOnMessage(ev.data || {}); } catch (err) { reportRuntimeError('presentation', err); } };
            break;
        }
        // The fog's grids, made by the presentation reader (shared; see
        // visibility_history.js updateVisualVisibility).
        case 'fogBind': {
            if (msg.epoch !== c.epoch) break;
            visibilityPresentationFog = { light: msg.light, fog: msg.fog, explored: msg.explored, head: msg.head, width: msg.width, height: msg.height, player: localPlayerId, rows: null };
            break;
        }
        case 'presentation': {
            if (msg.epoch !== c.epoch || !c.active) { _simClientReturnBufs(_simClientWorldBufs(msg.world)); break; }
            _simPlayArrived(c, msg, performance.now());
            break;
        }
        case 'reply': {
            let r = c.replies.get(msg.id);
            c.replies.delete(msg.id);
            // (A request that threw answers with its error: it waited for
            // good, a malformed patch held the page's ticks.)
            if (r) { if (msg.error !== undefined) r.reject(new Error(String(msg.error))); else r.resolve(msg.result); }
            break;
        }
        // A whole-state restore it could not make: its state is gone; the
        // match is got again, as for a worker lost (sim_worker.js _simRequest).
        case 'restoreFailed':
            if (msg.epoch === c.epoch && c.active) _simClientWorkerLost('could not restore the match (' + msg.message + ')');
            break;
        case 'error': {
            if (c.errors.length < 50) c.errors.push(msg.where + ': ' + msg.message);
            if (msg.where === 'load') c.failed = msg.message || 'load error';
            // (It could not start this match: the page runs it.)
            if (msg.where === 'start' && c.active && c.startedEpoch !== c.epoch) { _simClientStartFailed(String(msg.message || 'start error')); break; }
            // A tick that threw in the worker counts (and logs) as it would
            // on the page.
            let err = new Error(msg.message);
            err.stack = msg.stack || err.stack;
            if (msg.where === 'gameTick' || msg.where === 'actions') reportRuntimeError(msg.where === 'gameTick' ? 'tick' : 'actions', err);
            else console.error('[sim worker]', msg.where, msg.message, msg.stack);
            break;
        }
    }
}

// ---- the playout of presentation frames ----
// Each frame holds its units where they are at its tick (x) and where the
// frame before it had them (px): the stretch of motion between two ticks.
// Drawn motion is the frames played end to end on one steady clock: a play
// position in ticks (play.p) that advances with the drawn frames' time at
// the pace the frames come at (play.period: ms a tick, a slow average), a
// little behind the newest frame (play.want ticks: the frames' spacing plus
// what their arrival times vary by). A frame is shown when the position
// reaches the end of the one before it, at once from its start: no unit's
// start is moved to where it is drawn (the rebase: a pass over every unit),
// and when a frame happens to arrive no longer shapes the drawn speed.
// (Before: each frame's motion ran from its arrival over the average gap
// between arrivals; a frame a few ms early or late cut the last tenths of
// a step short or held the unit still for a frame: a lone unit's drawn
// speed varied +-50% from frame to frame at every tick.) The position waits
// at a frame's end when no newer one has come (the frames are late: the
// distance behind grows by that), and runs up to SIM_PLAY_RATE_MAX faster or
// slower to hold its distance behind the newest. Without frames being drawn
// (a hidden page, tests) every frame is shown as it comes.
// (SIM_PLAY_MARGIN_TICKS: the least room for a late frame, 20 ms at 20 TPS.)
const SIM_PLAY_PERIOD_MAX = 4000;
const SIM_PLAY_QUEUE_MAX = 2, SIM_PLAY_SNAP_TICKS = 8, SIM_PLAY_RATE_MIN = 0.9, SIM_PLAY_RATE_MAX = 1.35, SIM_PLAY_MARGIN_TICKS = 0.4;
function _simPlayNew() { return { started: false, p: 0, at: 0, k0: 0, k1: 0, period: 0, gap: 1, jit: 0, err: 0, rate: 1, want: 1.25, lastK: 0, lastAt: 0, queue: [], stalls: 0, snaps: 0 }; }
function _simClientShowPresentation(c, msg, at) {
    // (Shown from its start: its units begin where the frame before left them.)
    _simClientApplyWorld(msg.world, 1);
    c.arrivedAt = at; c.drawnAlpha = -1; c.presentationTick = msg.tick;
    c.presentationBuildMs = msg.buildMs; c.presentationPhases = msg.phases; c.presentationTorn = msg.torn;
}
function _simPlayShow(c, P, msg, at) {
    P.k0 = P.started ? P.k1 : msg.tick - 1;
    P.k1 = Math.max(P.k0 + 1, msg.tick);
    P.started = true;
    _simClientShowPresentation(c, msg, at);
}
// A frame came (at `now`).
function _simPlayArrived(c, msg, now) {
    const P = c.play, K = msg.tick;
    if (!(P.period > 0)) P.period = Math.max(10, netSimulationTickMs());
    if (P.lastAt > 0 && K > P.lastK) {
        // (Up to SIM_PLAY_PERIOD_MAX a tick: a simulation of millions of units
        // runs at 1-2 TPS. Clamped at 250 ms, a 500 ms tick's motion played in
        // half of it, then the units stood; a period far off is followed at
        // once, not over twenty frames.)
        const dk = K - P.lastK, per = (now - P.lastAt) / dk;
        if (per > 4 && per < SIM_PLAY_PERIOD_MAX * 1.5) {
            const want = Math.max(10, Math.min(SIM_PLAY_PERIOD_MAX, per)), far = want > P.period * 1.4 || want < P.period / 1.4;
            P.jit += (Math.min(SIM_PLAY_PERIOD_MAX, Math.abs(now - P.lastAt - P.period * dk)) - P.jit) * 0.1;
            P.period += (want - P.period) * (far ? 0.4 : 0.05);
            P.gap += (Math.min(8, dk) - P.gap) * 0.1;
        }
    }
    P.lastAt = now; P.lastK = K;
    c.intervalMs = P.period * P.gap;
    // Not drawing (or the first frame): shown as it comes, the clock at its end.
    if (!P.started || !(c.drawAt > 0 && now - c.drawAt < 100)) {
        while (P.queue.length) _simPlayShow(c, P, P.queue.shift(), now);
        _simPlayShow(c, P, msg, now);
        P.p = P.k1; P.at = 0; P.err = 0; P.rate = 1;
        return;
    }
    // (More waiting than the page may hold of the reader's buffers: the
    // oldest is shown now, the position at its start.)
    if (P.queue.length >= SIM_PLAY_QUEUE_MAX) { _simPlayShow(c, P, P.queue.shift(), now); P.p = Math.max(P.p, P.k0); P.snaps++; }
    P.queue.push(msg);
    // How far behind the newest frame the position is against what it
    // should be, measured as each frame comes (between frames the distance
    // falls as the position advances: read then, it would sway the pace
    // within every tick): the pace until the next frame.
    P.want = P.gap + Math.min(P.gap, Math.max(SIM_PLAY_MARGIN_TICKS, 3 * P.jit / P.period));
    P.err += ((K - P.p) - P.want - P.err) * 0.25;
    P.rate = Math.max(SIM_PLAY_RATE_MIN, Math.min(SIM_PLAY_RATE_MAX, 1 + P.err * 0.12));
}
// A drawn frame's time: the play position moves on, frames whose turn has
// come are shown; returns the shown frame's interpolation.
function _simPlayAdvance(c, frameTime) {
    const P = c.play;
    if (!P.started) return 1;
    let dt = P.at > 0 ? frameTime - P.at : 0;
    P.at = frameTime;
    if (!(dt > 0)) dt = 0; else if (dt > 250) dt = 250;
    P.p += dt / P.period * P.rate;
    // (Far behind, after a stall of the page: to the newest at once.)
    const newest = P.queue.length ? P.queue[P.queue.length - 1].tick : P.k1;
    if (newest - P.p > Math.max(SIM_PLAY_SNAP_TICKS, P.want * 3)) { P.p = newest; P.err = 0; P.rate = 1; P.snaps++; }
    while (P.queue.length && P.p >= P.k1) {
        const msg = P.queue.shift();
        if (msg.epoch === c.epoch && c.active) { try { _simPlayShow(c, P, msg, frameTime); } catch (err) { reportRuntimeError('presentation', err); } }
        else _simClientReturnBufs(_simClientWorldBufs(msg.world));
    }
    // (Nothing newer has come: it stands at this frame's end.)
    if (P.p >= P.k1) { if (P.p > P.k1 + 0.02) P.stalls++; P.p = P.k1; return 1; }
    const a = (P.p - P.k0) / (P.k1 - P.k0);
    return a < 0 ? 0 : a > 1 ? 1 : a;
}
// (Frames waiting to be shown, of a match that ended or was restored.)
function _simClientDropHeld(c) {
    if (!c || !c.play) return;
    const queue = c.play.queue;
    c.play = _simPlayNew();
    for (const msg of queue) _simClientReturnBufs(_simClientWorldBufs(msg.world));
}

function _simClientApplyTick(msg) {
    let c = _simClient;
    if (msg.epoch !== c.epoch) {
        c.stats.dropped++;
        let bufs = _simClientWorldBufs(msg.world);
        if (msg.sight) bufs.push(msg.sight.buffer);
        _simClientReturnBufs(bufs);
        return;
    }
    c.inFlight = Math.max(0, c.inFlight - 1);
    let t0 = performance.now();
    let dispatchedAt = c.dispatchAt.get(msg.tick);
    c.dispatchAt.delete(msg.tick);
    // The page's lockstep tick counter runs ahead of the results.
    let pageTick = currentTick;
    // Units move on from where they are drawn now (the interpolation of the
    // last frame at this moment), so motion stays continuous however the
    // results arrive. (The alpha of the last frame drawn with the previous
    // result; none drawn since it arrived: from its start.)
    let shown = c.arrivedAt > 0 ? (c.drawnAlpha >= 0 ? c.drawnAlpha : 0) : 1;
    c.presentation = !!msg.presentation;
    if (!c.presentation) c.drawnAlpha = -1;
    const gt0 = gameTime;
    try { _simClientApplyWorld(msg.world, shown); } catch (err) { reportRuntimeError('sim frame', err); }
    // (The step's game time, for the effects' clock: simClientDrawnGameTime.)
    if (gameTime > gt0) { c.gtPrev = gt0; c.gtNow = gameTime; c.gtOff = gameTime - msg.tick; }
    currentTick = pageTick;
    c.appliedTick = msg.tick;
    c.appliedAt = dispatchedAt !== undefined ? dispatchedAt : t0;
    // Units move from the previous tick to this one over the time the
    // next result is expected to take (the recent spacing of results), so
    // motion stays continuous whether results come on time, late or in a
    // burst while catching up.
    if (!c.presentation && c.arrivedAt > 0) {
        let tickMs = netSimulationTickMs();
        let interval = Math.max(tickMs * 0.25, Math.min(tickMs * 3, t0 - c.arrivedAt));
        c.intervalMs += (interval - c.intervalMs) * 0.25;
    }
    if (!c.presentation) c.arrivedAt = t0;
    if (dispatchedAt !== undefined) {
        let latency = Math.max(0, t0 - dispatchedAt);
        c.latencyMs += (Math.min(latency, TICK_MS * 3) - c.latencyMs) * (latency > c.latencyMs ? 0.3 : 0.05);
        c.stats.latencyMs.push(latency);
    }
    c.lastSight = msg.sight ? { data: msg.sight, player: msg.sightPlayer, id: msg.sightId || 0 } : null;
    // (Its attacks spread over the step they came in: recordCombatFx.)
    combatFxSpan = c.gtNow === gameTime && c.gtNow > c.gtPrev ? [c.gtPrev, c.gtNow] : null;
    try { _simClientReplayEvents(msg.events || []); } finally { combatFxSpan = null; }
    _simClientPageTickWork(msg.tick);
    // The tick's record (the peers compare them).
    if (msg.hash) {
        if (isMultiplayer) resyncAfterTick(msg.tick, msg.hash);
        else snapStoreTickHash(msg.hash);
    }
    if (simClientTickAppliedHook) simClientTickAppliedHook(msg.tick, msg.lockHashes ? msg.lockHashes[0] : undefined, msg.report);
    let ms = performance.now() - t0;
    // The simulation's own pace (multiplayer feedback): when the worker
    // finished the tick and what it cost there, not when or how fast the
    // page got to its result.
    let doneAt = Number.isFinite(msg.doneAt) && typeof performance.timeOrigin === 'number' ? msg.doneAt - performance.timeOrigin : performance.now();
    netNoteSimulationTick(doneAt, (Number(msg.simMs) || 0) + (Number(msg.encodeMs) || 0));
    let late = Number(msg.lateMs) || 0;
    c.lateMs += (late - c.lateMs) * 0.2;
    c.stats.applied++;
    c.stats.applyMs.push(ms); c.stats.simMs.push(msg.simMs); c.stats.encodeMs.push(msg.encodeMs); c.stats.lateMs.push(late);
    for (let k of ['applyMs', 'simMs', 'encodeMs', 'latencyMs', 'lateMs']) if (c.stats[k].length > 600) c.stats[k].splice(0, 300);
}

// ---- units: frames and their views ----

// View per slot (while alive; by id in _pageUnitsById).
let _pageSlotViews = [];
let _pageViewStamp = 0;

// (The presentation reader's buffers: a trailer, its magic last.)
function _simClientIsPresentBuf(b) {
    return typeof SharedArrayBuffer === 'function' && b instanceof SharedArrayBuffer && b.byteLength >= 12
        && new DataView(b, b.byteLength - 4).getInt32(0, true) === 0x50524553;
}
function _simClientReturnBufs(bufs) {
    let c = _simClient;
    bufs = bufs.filter(b => b && b.byteLength);
    if (c && c.presentationPort && bufs.length) {
        const rest = [];
        for (const b of bufs) { if (_simClientIsPresentBuf(b)) c.presentationPort.postMessage({ type: 'release', buf: b }); else rest.push(b); }
        bufs = rest;
    }
    if (c && bufs.length) c.worker.postMessage({ type: 'frameReturn', bufs }, bufs.filter(b => !(typeof SharedArrayBuffer === 'function' && b instanceof SharedArrayBuffer)));
}

// The page's units: none until the worker's next frame (objects from a
// restore on the page are not the simulation's).
function _simClientResetUnits() {
    let c = _simClient;
    _simClientDropHeld(c);
    for (let u of _pageUnitsById.values()) { u._freeze(); u.dead = true; }
    if (typeof selectionIndexRemapped === 'function') selectionIndexRemapped();
    _pageUnitsById = new PageUnitIdMap();
    _pageSlotViews = [];
    let bufs = pageResetWorldTables(c);
    if (_pageFrame) { bufs.push(_pageFrame.buf); _pageFrame = null; }
    _simClientReturnBufs(bufs);
    units = [];
    simUnitStateReset();
    if (typeof initSpatialHash === 'function') initSpatialHash();
    if (c) { c.frameUnits = null; c.mver = -1; c.watchKey = ''; }
    _pageFrameStrings.length = 1;
    _pageFrameStringsVersion++;
}

// The buffers of a world frame (to hand back).
function _simClientWorldBufs(w) {
    return w ? [w.units, w.structures, w.projectiles].filter(t => t && t.buf).map(t => t.buf) : [];
}

// A world frame: string codes, units, structures, projectiles, the state and
// the details; the previous frame's buffers go back.
function _simClientApplyWorld(w, shown) {
    let c = _simClient;
    if (!w) return;
    // (The presentation sends its whole table with each frame: the version
    // moves only for a code that changed.)
    if (w.strings) { let base = w.strings[0], list = w.strings[1]; for (let i = 0; i < list.length; i++) if (_pageFrameStrings[base + i] !== list[i]) { _pageFrameStrings[base + i] = list[i]; _pageFrameStringsVersion++; } }
    let back = [];
    if (w.units) _simClientApplyFrame(w.units, shown);
    if (w.structures) { let old = pageApplyStructures(w.structures, c); if (old) back.push(old.buf); }
    if (w.projectiles) { let old = pageApplyProjectiles(w.projectiles, c, shown); if (old) back.push(old.buf); }
    pageApplyState(w.state);
    if ('details' in w) _simClientApplyDetails(w.details);
    if ('structureDetails' in w) pageApplyStructureDetails(w.structureDetails, c);
    _simClientWatch();
    // Selected structures replaced by new objects (a restore): the new ones.
    if (selectedEntities.length && selectedEntities.some(e => e && e._structView && e.dead)) {
        selectedEntities = selectedEntities.map(e => {
            if (!e || !e._structView || !e.dead) return e;
            let cell = grid[e.gy] && grid[e.gy][e.gx];
            let now = getTileEntityRef(e.gx, e.gy) || (cell && cell.item) || null;
            return now && now._structView && !now.dead ? now : null;
        }).filter(Boolean);
    }
    _simClientReturnBufs(back);
}

// A new units table: where drawn units continue from, which views live (new
// ones made, gone ones frozen dead), then it becomes the current one and the
// previous buffer goes back.
function _simClientUpdateStableSlots(F, old) {
    // Most membership changes are a few deaths/births in stable slots. Do
    // not stamp and revisit every PageUnit (and all its render-cache fields)
    // when the packed ID columns already identify exactly what changed.
    const changed = [], n = Math.max(F.n, old.n);
    for (let s = 0; s < n; s++) {
        const id = s < F.n ? F.id[s] : -1, before = s < old.n ? old.id[s] : -1;
        if (id === before) continue;
        // A restore can move an existing ID between slots. Leave it to the
        // general path, which preserves object identity across that remap.
        if (id >= 0 && _pageUnitsById.has(id)) return null;
        changed.push(s);
    }
    for (const s of changed) {
        const v = _pageSlotViews[s];
        if (v && !v.dead) { if (typeof selectionNoteDead === 'function') selectionNoteDead(s); v._freeze(); v.dead = true; _pageUnitsById.delete(v.id); }
        const id = s < F.n ? F.id[s] : -1;
        if (id >= 0) {
            const next = new PageUnit(id, s);
            _pageUnitsById.set(id, next); _pageSlotViews[s] = next;
        } else _pageSlotViews[s] = undefined;
    }
    const list = new Array(F.count), order = F.order;
    for (let k = 0; k < F.count; k++) list[k] = _pageSlotViews[order[k]];
    return list;
}
// Keep the population loop separate from frame installation so V8 can
// optimize it without the object/membership slow paths in that function.
let _simRebaseMarks = new Uint32Array(0), _simRebaseStamp = 0;
function _simClientRebaseMovingFrame(F, old, shown) {
    if (_simRebaseMarks.length < F.cap) _simRebaseMarks = new Uint32Array(F.cap);
    if (!(_simRebaseStamp = (_simRebaseStamp + 1) >>> 0)) { _simRebaseMarks.fill(0); _simRebaseStamp = 1; }
    const stamp = _simRebaseStamp, marks = _simRebaseMarks, moving = F.renderMoving;
    const initialCount = F.renderMovingCount, n = Math.min(F.n, old.n);
    const id = F.id, px = F.px, py = F.py, x = F.x, y = F.y;
    const oid = old.id, ox = old.x, oy = old.y, opx = old.px, opy = old.py;
    let count = 0, pad = 0;
    for (let pass = 0; pass < 2; pass++) {
        const list = pass ? old.renderMoving : moving, length = pass ? old.renderMovingCount : initialCount;
        for (let k = 0; k < length; k++) {
            const s = list[k];
            if (s >= F.n || marks[s] === stamp) continue;
            marks[s] = stamp;
            let rx = px[s], ry = py[s];
            if (s < n && id[s] >= 0 && oid[s] === id[s]) {
                rx = opx[s] + (ox[s] - opx[s]) * shown;
                ry = opy[s] + (oy[s] - opy[s]) * shown;
                px[s] = rx; py[s] = ry;
            }
            const dx = rx - x[s], dy = ry - y[s];
            if (dx > pad) pad = dx; else if (-dx > pad) pad = -dx;
            if (dy > pad) pad = dy; else if (-dy > pad) pad = -dy;
            // Carry stopped-but-still-interpolating units into the next frame.
            if (px[s] !== x[s] || py[s] !== y[s]) moving[count++] = s;
        }
    }
    F.renderMovingCount = count;
    F.renderMotionPad = pad;
}
function _simClientRebaseFrame(F, old, shown) {
    // Sparse lists are for small moving groups only. Dense armies use bulk
    // native interpolation, including the cost of copying frame columns.
    const sparse = F.renderMoving && old.renderMoving && F.renderMovingCount + old.renderMovingCount < 8192;
    if (!sparse && F.n >= 8192 && typeof simRebaseNative === 'function' && simRebaseNative(F, old, shown)) return;
    if (F.renderMoving && old.renderMoving) { _simClientRebaseMovingFrame(F, old, shown); return; }
    const n = Math.min(F.n, old.n), oid = old.id, ox = old.x, oy = old.y, opx = old.px, opy = old.py;
    const id = F.id, px = F.px, py = F.py, x = F.x, y = F.y, indexed = !!F.renderBuckets;
    let motionPad = 0;
    for (let s = 0; s < n; s++) {
        if (id[s] < 0 || oid[s] !== id[s]) continue;
        // An unchanged position has an exact interpolation result.
        const cx = x[s], cy = y[s];
        if (cx === ox[s] && cy === oy[s] && cx === opx[s] && cy === opy[s]) {
            px[s] = cx; py[s] = cy;
            continue;
        }
        const rx = opx[s] + (ox[s] - opx[s]) * shown, ry = opy[s] + (oy[s] - opy[s]) * shown;
        px[s] = rx; py[s] = ry;
        if (indexed) {
            const dx = rx - cx, dy = ry - cy;
            if (dx > motionPad) motionPad = dx; else if (-dx > motionPad) motionPad = -dx;
            if (dy > motionPad) motionPad = dy; else if (-dy > motionPad) motionPad = -dy;
        }
    }
    F.renderMotionPad = motionPad;
}
function _simClientApplyFrame(frame, shown) {
    let c = _simClient;
    let F = simFrameViews(frame.buf, frame.cap);
    F.n = frame.n; F.count = frame.count;
    if (frame.renderBuckets) {
        const B = frame.renderBuckets, cells = B.columns * B.rows;
        F.renderBuckets = { ...B, head: new Int32Array(F.buf, B.offset, cells),
            motion: new Float32Array(F.buf, B.offset + cells * 4, cells),
            next: new Int32Array(F.buf, B.offset + cells * 8, F.cap) };
        if (Number.isFinite(B.movingOffset)) {
            F.renderMoving = new Int32Array(F.buf, B.movingOffset, F.cap);
            F.renderMovingCount = B.movingCount;
        }
    }
    // (Which blocks of the renderer's columns changed: presentation_worker.js markDirty.)
    if (frame.dirty) {
        const D = frame.dirty;
        F.dirty = { seq: D.seq, stream: D.stream, block: D.block, nb: D.nb, cols: D.cols, stamps: new Int32Array(F.buf, D.offset, D.cols.length * D.nb) };
    }
    F.renderMotionPad = 0;
    let old = _pageFrame;
    if (old && shown < 1) {
        // Keep worker buckets conservative after rebasing to the last drawn position.
        _simClientRebaseFrame(F, old, shown);
        // (Its px, py rewritten here: not what the worker marked.)
        F.dirty = null;
    }
    if (frame.mver !== c.mver || c.frameUnits !== units) {
        let list = old && c.frameUnits === units ? _simClientUpdateStableSlots(F, old) : null;
        if (!list) {
            let stamp = ++_pageViewStamp, order = F.order, ids = F.id;
            list = new Array(frame.count);
            for (let k = 0; k < frame.count; k++) {
                let s = order[k], id = ids[s], v = _pageSlotViews[s];
                if (!v || v.id !== id || v.dead) {
                    v = _pageUnitsById.get(id);
                    if (!v || v.dead) { v = new PageUnit(id, s); _pageUnitsById.set(id, v); }
                    _pageSlotViews[s] = v;
                }
                v._stamp = stamp;
                list[k] = v;
            }
            // Gone: their last values, from the frame they were last in.
            let prev = c.frameUnits || [];
            for (let v of prev) if (v._stamp !== stamp && !v.dead) { v._freeze(); v.dead = true; _pageUnitsById.delete(v.id); }
            for (let k = 0; k < list.length; k++) list[k]._s = order[k];
            // (Slots dealt again: the selection's slots are found again.
            // This path only: a restore, a match's first frame.)
            if (typeof selectionIndexRemapped === 'function') selectionIndexRemapped();
            // A restore brought new objects for units the page had selected.
            if (selectedUnits.length && selectedUnits.some(u => !(u instanceof PageUnit))) {
                selectedUnits = selectedUnits.map(u => u instanceof PageUnit ? u : _pageUnitsById.get(u.id)).filter(u => u && !u.dead);
            }
        }
        units = list;
        c.frameUnits = list;
        c.mver = frame.mver;
    }
    _pageFrame = F;
    _pageFrameSerial++;
    if (old) _simClientReturnBufs([old.buf]);
}

// Details of watched units (their paths, targets and stats), and which
// units the page watches next: the selection (up to a cap).
const SIM_CLIENT_WATCH_MAX = 256;
let _simClientDetailed = [];
function _simClientApplyDetails(details) {
    for (let v of _simClientDetailed) v._det = null;
    _simClientDetailed = [];
    if (details) for (let d of details) {
        let v = _pageUnitsById.get(d.id);
        if (v) { v._det = d; _simClientDetailed.push(v); }
    }
}
// The tiles the page draws (each frame's view): the worker shows the looks
// of hits there first (unit.js simLookView); sent when it moved a few tiles.
function simClientNoteView(minGx, minGy, maxGx, maxGy) {
    const c = _simClient;
    if (!c || !c.active || !c.worker) return;
    const v = c.view || (c.view = [1, 0, 0, 0]), pad = 4;
    const r = [Math.floor(minGx) - pad, Math.floor(minGy) - pad, Math.ceil(maxGx) + pad, Math.ceil(maxGy) + pad];
    if (Math.abs(r[0] - v[0]) < 2 && Math.abs(r[1] - v[1]) < 2 && Math.abs(r[2] - v[2]) < 2 && Math.abs(r[3] - v[3]) < 2) return;
    c.view = r;
    const e = TILE * 8;
    c.worker.postMessage({ type: 'view', r: [r[0] * e, r[1] * e, (r[2] + 1) * e, (r[3] + 1) * e] });
}
// What the page watches: the selected units and structures (up to caps).
function _simClientWatch() {
    let c = _simClient, list = [], structures = [], key = '';
    // (A big selection is shown by groups: a few of its units' details do;
    // each watched unit's details cross the threads every tick.)
    const maxUnits = selectedUnits.length > 300 ? 32 : SIM_CLIENT_WATCH_MAX, maxStructures = selectedEntities.length > 300 ? 32 : 128;
    for (let i = 0; i < selectedUnits.length && list.length < maxUnits * 2; i++) {
        let u = selectedUnits[i];
        if (!(u instanceof PageUnit) || u.dead) continue;
        list.push(u.id, u._s);
        key += u.id + ':' + u._s + ',';
    }
    key += '|';
    for (let i = 0; i < selectedEntities.length && structures.length < maxStructures; i++) {
        let e = selectedEntities[i];
        if (!e || !Number.isFinite(e.gx) || !Number.isFinite(e.gy)) continue;
        structures.push(e.gx, e.gy);
        key += e.gx + ',' + e.gy + ';';
    }
    if (key !== c.watchKey) { c.watchKey = key; c.worker.postMessage({ type: 'watch', list, structures }); }
}

// Buildings, floor items or tiles changed: the cached map layers redraw.
function _simClientMapChanged() {
    dirtyGrid = true;
    _minimapStaticDirty = true;
    if (typeof _requestStaticCacheCommit === 'function') _requestStaticCacheCommit();
    if (typeof requestBuildMenuRefresh === 'function') requestBuildMenuRefresh();
}
// Some structures came or went (their tiles marked dirty by the caller, the
// background's and the minimap's: _markCombinedBgTileDirty,
// minimapStaticTileChanged): the build menu (what can be stacked).
function _simClientStructuresChanged() {
    if (typeof requestBuildMenuRefresh === 'function') requestBuildMenuRefresh();
}

// Entities referenced by the worker's side effects.
function _simClientResolve(ref) {
    if (!ref) return null;
    if (ref[0] === 'u') return _pageUnitsById.get(ref[1]) || null;
    let gx = ref[1], gy = ref[2];
    let cell = grid[gy] && grid[gy][gx];
    return getTileEntityRef(gx, gy) || (cell && cell.item) || null;
}

function _simClientReplayEvents(events) {
    for (let e of events) {
        switch (e[0]) {
            case 's': playSound(e[1], e[2], e[3], e[4]); break;
            case 'd': { let t = _simClientResolve(e[1]); if (t) recordDamageVisual(t, e[2], e[3] === null ? undefined : e[3]); break; }
            case 'h': { let t = _simClientResolve(e[1]); if (t) pushHostileDamageAlert(t, e[2], e[3]); break; }
            case 'x': createExplosion(e[1], e[2], e[3], e[4]); break;
            case 'p': createDirectedParticles(e[1], e[2], e[3], e[4], e[5], e[6]); break;
            case 'f': recordCombatFx(e[1], e[2], e[3], e[4], e[5], e[6] === null ? undefined : e[6], e[7] | 0, e[8] | 0); break;
            // (A tick's energy and star gains and costs by source: the HUD's rates.)
            case 'E': recordEnergyDelta(e[1], e[2], e[3]); break;
            case 'A': recordAstarDelta(e[1], e[4], { unitType: e[2] }, e[3]); break;
        }
    }
}

// This player's sight grid as the worker sent it (flat), with its tick.
let visibilityRawFlat = null;
// Rows of the worker's shared sight grid (by its id: sim_worker.js _simPostResult).
const _simClientSightRows = { id: 0, epoch: -1, player: -1, rows: null, w: 0 };
// What the page did as part of a tick: visuals, audio state and UI.
function _simClientPageTickWork(tick) {
    for (let i = particles.length - 1; i >= 0; i--) if (!particles[i].update()) particles.splice(i, 1);
    _simClientLaserSound();
    // (The selection's dead: known from the frame's membership changes, no
    // pass over the selection each tick.)
    if (typeof selectionCompactDead === 'function') selectionCompactDead();
    else if (selectedUnits.length && selectedUnits.some(u => u.dead)) selectedUnits = selectedUnits.filter(u => !u.dead);
    // What this player sees: the worker's grid for this tick when it sent
    // one (rows are views of it), else computed here. Other players' grids
    // are computed on the page only when asked for.
    let sight = _simClient.lastSight;
    if (sight && sight.player === localPlayerId && sight.data.length === GRID_W * GRID_H) {
        // (Flat, for the GPU range outline: renderer.js getRangeVisibilityOverlay.)
        visibilityRawFlat = { data: sight.data, player: sight.player, version: tick };
        // (The worker's shared grid, the same each tick: its rows made once.
        // A thousand new row views a tick were the page's largest garbage,
        // ~1.7 MB/s, and every scavenge it brings can stall a frame.)
        const S = _simClientSightRows;
        const epoch = _simClient.epoch;
        let rows = sight.id && S.id === sight.id && S.epoch === epoch && S.player === sight.player && S.rows && S.rows.length === GRID_H && S.w === GRID_W ? S.rows : null;
        if (!rows) {
            rows = new Array(GRID_H);
            for (let y = 0; y < GRID_H; y++) rows[y] = sight.data.subarray(y * GRID_W, (y + 1) * GRID_W);
            S.id = sight.id; S.epoch = epoch; S.player = sight.player; S.rows = sight.id ? rows : null; S.w = GRID_W;
        }
        visibilityGridRawByPlayerCache.set(localPlayerId, rows);
        visibilityGridStampByPlayer.set(localPlayerId, gameTime);
        visibilityCacheTick = gameTime;
    }
    _simClient.lastSight = null;
    visibilityGrid = updateVisualVisibility(localPlayerId, getRawVisibilityGridForPlayer(localPlayerId));
    // The graph's counts a slice a tick (sampleGameStats otherwise gathers
    // every unit at once: up to ~70 ms on the page at 200k units).
    gameStatsStep(tick);
    if ((tick + 1) % TICK_RATE === 0) sampleGameStats();
    requestResearchPopupRefresh();
    let c = _simClient;
    // (A repair can take an end back: the next one is shown again.)
    if (!gameOver) c.gameOverShown = false;
    else if (!c.gameOverShown) {
        // The worker ended the match: the same check on the page marks
        // this player defeated (spectating) and shows the result.
        c.gameOverShown = true;
        gameOver = false;
        checkWinCondition();
        if (!gameOver) { gameOver = true; matchOverShow(); }
    }
}

// As gameTick does: the laser buzz follows the active laser nearest the view.
// (The laser's string code, by the string table's version.)
const _simLaserCode = { version: -1, n: -1, code: -1 };
function _simClientLaserSound() {
    let any = false, lx = 0, ly = 0, best = Infinity;
    let cx = camera.x + viewW / camera.zoom / 2, cy = camera.y + viewH / camera.zoom / 2;
    // From the structure table's columns: every tower through its view's
    // getters each tick was a few ms and ~150 KB of garbage a second.
    const F = _pageTables.s;
    if (F && F.laser) {
        const L = _simLaserCode;
        if (L.version !== _pageFrameStringsVersion || L.n !== _pageFrameStrings.length) { L.version = _pageFrameStringsVersion; L.n = _pageFrameStrings.length; L.code = _pageFrameStrings.indexOf('laser'); }
        const code = L.code, n = F.n, alive = F.alive, kind = F.kind, type = F.type, laser = F.laser, flags = F.flags, X = F.x, Y = F.y;
        if (code > 0) for (let s = 0; s < n; s++) {
            if (!alive[s] || kind[s] !== 0 || type[s] !== code || laser[s] !== 1 || (flags[s] & SIM_SF_UC)) continue;
            any = true;
            let dx = X[s] - cx, dy = Y[s] - cy, d2 = dx * dx + dy * dy;
            if (d2 < best) { best = d2; lx = X[s]; ly = Y[s]; }
        }
        if (any) startLaserSound(lx, ly); else stopLaserSound();
        return;
    }
    for (let t of towers) {
        if (t.type !== 'laser' || t.laserState !== 1 || t.underConstruction) continue;
        any = true;
        let dx = t.x - cx, dy = t.y - cy, d2 = dx * dx + dy * dy;
        if (d2 < best) { best = d2; lx = t.x; ly = t.y; }
    }
    if (any) startLaserSound(lx, ly); else stopLaserSound();
}

// ---- points where the page's network code reads or replaces the state ----

// Whether every dispatched tick's result is back (nothing in flight).
function simClientQuiescent() {
    let c = _simClient;
    return !c || !c.active || c.inFlight === 0;
}

// Host: a resync patch of the simulation as it is before the next tick
// dispatched (requests and ticks are handled in order). Resolves to its text.
function simClientEncodePatch(buckets) {
    return simClientRequest('encodePatch', { buckets });
}

// Host: a whole-state snapshot's JSON text, with the simulation state taken
// from the worker at this point: the page's part (lockstep window, config;
// built withoutState) around the state's text, which the worker encodes and
// stringifies itself. (A join encoded the page's own copy of the state
// first, then cloned the worker's over as objects and stringified it on the
// page: 200k units, seconds and ~78 MB on the host's main thread: audit
// 2026-10-17, 44.)
function simClientSnapshotText(snapshot) {
    return simClientRequest('encodeStateText').then(r => {
        snapshot.gameTime = r.gameTime;
        delete snapshot.state;
        let head = JSON.stringify(snapshot);
        return head.slice(0, -1) + (head.length > 2 ? ',' : '') + '"state":' + r.text + '}';
    });
}

// Guest: a resync patch, for the worker to apply before the next tick.
// (Posted at once, in order with the ticks: the worker applies it before the
// next one. The promise: whether its decoder took it.)
function simClientAfterPatchApplied(text, full) {
    if (!simClientActive()) return Promise.resolve(false);
    let c = _simClient, id = c.nextRequestId++;
    return new Promise((resolve, reject) => {
        c.replies.set(id, { resolve, reject, epoch: c.epoch });
        c.worker.postMessage({ type: 'request', id, op: 'applyPatch', args: { text, full: !!full } });
    });
}

// A whole-state restore on the page (join, hard resync...): the worker
// restores the same, and results of ticks dispatched before are dropped.
function simClientAfterSnapshotApplied(snapshot) {
    if (!simClientActive() || _simClient.decodingStart) return;
    let c = _simClient;
    c.startText = null;
    c.epoch++;
    _simAutoSync(c);
    c.inFlight = 0;
    c.dispatchAt.clear();
    c.appliedTick = currentTick - 1;
    c.appliedAt = 0; c.arrivedAt = 0;
    // Units come with the worker's next frame.
    _simClientResetUnits();
    c.gameOverShown = !!gameOver;
    c.worker.postMessage({ type: 'request', op: 'applySnapshot', args: { snapshot, epoch: c.epoch, globals: _simClientGlobals() } });
}

// ---- interpolation between the last two applied ticks ----
function simClientTickAlpha(frameTime) {
    let c = _simClient;
    if (!c) return 1;
    c.drawAt = performance.now();
    // The presentation reader's frames: on the playout clock.
    if (c.presentation && c.play && c.play.started) {
        const a = _simPlayAdvance(c, frameTime);
        c.drawnAlpha = a;
        return a;
    }
    if (!c.arrivedAt) return 1;
    let alpha = (frameTime - c.arrivedAt) / Math.max(1, c.intervalMs);
    // Called once per drawn frame: remembered for the next result's start.
    c.drawnAlpha = alpha < 0 ? 0 : alpha > 1 ? 1 : alpha;
    return alpha < 0 ? 0 : alpha > 1 ? 1 : alpha;
}

// The game time the drawn units stand at (in ticks, fractional): the
// presentation frames' play position, else the last result's interpolation
// (alpha). Effects play on it, so an attack shows where and when its units
// are drawn: a slow simulation's step of many ticks plays as the ticks it
// covers, not frozen at its start and gone at the next. NaN: no worker.
function simClientDrawnGameTime(alpha) {
    const c = _simClient;
    if (!c || !c.active || !(c.gtNow > c.gtPrev)) return NaN;
    if (c.presentation && c.play && c.play.started && Number.isFinite(c.gtOff)) return Math.min(c.gtNow, c.play.p + c.gtOff);
    return c.gtPrev + (c.gtNow - c.gtPrev) * (alpha < 0 ? 0 : alpha > 1 ? 1 : alpha);
}

window.simClientStats = function () {
    let c = _simClient;
    if (!c) return { enabled: simClientEnabled };
    let q = (a, p) => { if (!a.length) return 0; let b = [...a].sort((x, y) => x - y); return Math.round(b[Math.min(b.length - 1, Math.floor(b.length * p))] * 100) / 100; };
    let m = a => a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length * 100) / 100 : 0;
    let s = c.stats;
    return {
        enabled: true, loaded: c.loaded, active: c.active, helpers: c.helpers || 0, shared: !!c.shared, epoch: c.epoch, appliedTick: c.appliedTick, inFlight: c.inFlight, heals: s.heals, dropped: s.dropped,
        presentation:!!c.presentation, presentationTick:c.presentationTick, presentationBuildMs:c.presentationBuildMs, presentationPhases:c.presentationPhases, presentationTorn:c.presentationTorn, errors: c.errors.slice(0, 5), firstDiff: s.firstDiff || null, rowsPerTick: s.applied ? Math.round(s.rows / s.applied * 10) / 10 : 0,
        rowsPerTickByList: s.applied ? Object.fromEntries(Object.entries(s.rowsBy || {}).map(([k, v]) => [k, Math.round(v / s.applied * 10) / 10])) : null,
        applyMs: { mean: m(s.applyMs), p95: q(s.applyMs, .95) }, workerSimMs: { mean: m(s.simMs), p95: q(s.simMs, .95) },
        workerEncodeMs: { mean: m(s.encodeMs), p95: q(s.encodeMs, .95) }, latencyMs: { mean: m(s.latencyMs), p95: q(s.latencyMs, .95), shown: Math.round(c.latencyMs) },
        workerLateMs: { mean: m(s.lateMs), p95: q(s.lateMs, .95) }, dispatchAhead: simClientDispatchAhead(), workerAhead: simClientWorkerAhead(),
        auto: !!_simAutoCtl(), autoTicks: c.autoTicks, autoSeals: c.autoSeals
    };
};

// The worker loads the game scripts while the menu is up.
if (simClientEnabled) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => simClientPreload());
    else simClientPreload();
}
