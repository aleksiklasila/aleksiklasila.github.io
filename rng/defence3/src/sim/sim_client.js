"use strict";
// ============================================================
// SIMULATION WORKER, PAGE SIDE (authority)
//
// With the simulation worker on (?simworker=1), game ticks run in
// src/sim/sim_worker.js. The page keeps the lockstep, the network and
// everything on screen, and a full copy of the world that each tick's
// changes keep equal to the worker's (src/sim/sim_delta.js):
//
// - runOneTick hands the tick's commands to the worker (simClientRunTick)
//   instead of simulating; several ticks can be in flight.
// - Each result is applied to the page's copy, then its side effects
//   (sounds, flashes, alerts, particles, combat effects) are replayed and the
//   per-tick page work runs (stats, win/defeat UI, visual visibility).
// - Multiplayer: the worker's rolling state hash of each tick feeds the
//   unchanged resync bookkeeping; resync patches are encoded or applied by the
//   worker in tick order, and the page's copy applies the same patch at the
//   same point of the stream. Whole-state restores start a new epoch:
//   results of the old one are dropped.
// - The page's copy is checked against the worker's hash every tick and
//   reloaded from the worker if it ever differs.
// ============================================================

const simClientEnabled = (() => {
    try { return new URLSearchParams(location.search).get('simworker') === '1'; } catch { return false; }
})();

let _simClient = null;
// Ticks dispatched to the worker whose results have not come back yet.
const SIM_CLIENT_MAX_IN_FLIGHT = 2;

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

function _simClientCreate() {
    let worker = new Worker('./src/sim/sim_worker.js?v=20261002-sim4');
    let c = {
        worker, loaded: false, active: false, epoch: 0, startTick: -1, nextRequestId: 1, replies: new Map(),
        inFlight: 0, tickClock: 0, dispatchAt: new Map(), appliedTick: -1, appliedAt: 0, latencyMs: TICK_MS, errors: [],
        stats: { applied: 0, applyMs: [], simMs: [], encodeMs: [], latencyMs: [], rows: 0, heals: 0, dropped: 0 }
    };
    worker.onmessage = ev => { try { _simClientOnMessage(ev.data || {}); } catch (err) { reportRuntimeError('sim worker', err); } };
    worker.onerror = ev => { c.errors.push(String(ev.message || ev)); if (!c.loaded) c.failed = String(ev.message || 'worker error'); console.error('[sim worker]', ev.message || ev); };
    worker.postMessage({ type: 'load', scripts: _simClientScriptUrls() });
    return c;
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

// ---- match start (first tick): the worker starts from the page's state ----
function simClientStartMatch() {
    if (!simClientEnabled || lockstepStrictDebugMode) return false;
    simClientPreload();
    let c = _simClient;
    // A worker that is still loading, or could not load the game, does not
    // take the match: it runs on the page as without ?simworker=1.
    if (!c.loaded || c.failed) {
        console.warn('[sim worker] ' + (c.failed ? 'failed to load (' + c.failed + ')' : 'not loaded yet') + '; this match runs on the page');
        return false;
    }
    // The worker restores this; the page's copy decodes the same state (the
    // lockstep bookkeeping stays as it is). The page ran no tick since its
    // last restore, so no peer has history caches to drop yet.
    let text = JSON.stringify(buildHostAuthoritativeStateSnapshot({ includeConfig: false, includeStaticMapState: true, includeGridTypes: true }));
    let pageTick = currentTick;
    snapFlushHistoryCaches();
    snapDecodeState(JSON.parse(text).state);
    currentTick = pageTick;
    recomputePlayerPopCaps();
    clearGameplayVisibilityCache();
    updateVisibility(localPlayerId);
    let controls = {};
    for (let el of document.querySelectorAll('input[id], select[id]')) controls[el.id] = el.type === 'checkbox' ? { checked: el.checked } : { value: el.value };
    c.epoch++;
    c.active = true;
    c.startTick = currentTick;
    c.inFlight = 0;
    c.dispatchAt.clear();
    c.appliedTick = currentTick - 1;
    c.appliedAt = 0;
    c.gameOverShown = false;
    c.healing = false;
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
    return true;
}

// Page globals the simulation reads.
function _simClientGlobals() {
    return {
        isMultiplayer, isHost, localPlayerId, gameSeed, activeTeamIds, gameMode, fullVisibility, matchFullVisibility,
        lobbyPlayers: typeof lobbyPlayers !== 'undefined' ? lobbyPlayers : [], gameStarted: true
    };
}

// When the page's role or view changes (host migration, defeat...).
function simClientSyncGlobals() {
    if (simClientActive()) _simClient.worker.postMessage({ type: 'request', op: 'setGlobals', args: { assign: _simClientGlobals() } });
}

function simClientStop() {
    if (_simClient) { _simClient.active = false; _simClient.epoch++; }
}

// ---- ticks ----
function simClientRunTick(tick, actions, teams, flush) {
    let c = _simClient;
    c.inFlight++;
    // Ticks on a steady clock: one TICK_MS after the previous one, unless
    // the match stalled (then from now), so frame timing does not jitter it.
    let now = performance.now();
    let at = c.tickClock + TICK_MS;
    if (!(at >= now - TICK_MS)) at = now;
    c.tickClock = at;
    c.dispatchAt.set(tick, at);
    c.worker.postMessage({ type: 'tick', tick, actions, teams, flush: !!flush, hash: true });
}

// Tests: code the worker runs at this point of the tick stream.
function simClientWorkerEval(code) {
    if (simClientActive()) _simClient.worker.postMessage({ type: 'request', op: 'eval', args: { code } });
}

// Commands and requests go out in order; a reply resolves its promise.
function simClientRequest(op, args = null) {
    let c = _simClient;
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
        case 'loaded': c.loaded = true; break;
        case 'started': break;
        case 'ticked': _simClientApplyTick(msg); break;
        case 'replicaState': if (msg.epoch === c.epoch) _simClientApplyReplicaState(msg); break;
        case 'reply': {
            let r = c.replies.get(msg.id);
            c.replies.delete(msg.id);
            if (r) r.resolve(msg.result);
            break;
        }
        case 'error': {
            if (c.errors.length < 50) c.errors.push(msg.where + ': ' + msg.message);
            if (msg.where === 'load') c.failed = msg.message || 'load error';
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

function _simClientApplyTick(msg) {
    let c = _simClient;
    if (msg.epoch !== c.epoch) { c.stats.dropped++; return; }
    c.inFlight = Math.max(0, c.inFlight - 1);
    let t0 = performance.now();
    let dispatchedAt = c.dispatchAt.get(msg.tick);
    c.dispatchAt.delete(msg.tick);
    // While a reload of the page's copy is on its way, results only count.
    if (c.healing) return;
    // The page's lockstep tick counter runs ahead of the results.
    let pageTick = currentTick;
    let applied = true;
    try { simDeltaApply(msg.delta); } catch (err) { applied = false; reportRuntimeError('sim delta', err); }
    currentTick = pageTick;
    c.appliedTick = msg.tick;
    c.appliedAt = dispatchedAt !== undefined ? dispatchedAt : t0;
    if (dispatchedAt !== undefined) {
        // Units are shown this far behind their tick's time, so results
        // that come a little late still move smoothly.
        let latency = Math.max(0, t0 - dispatchedAt);
        c.latencyMs += (Math.min(latency, TICK_MS * 3) - c.latencyMs) * (latency > c.latencyMs ? 0.3 : 0.05);
        c.stats.latencyMs.push(latency);
    }
    if (!applied) { _simClientHeal(msg.tick); return; }
    if (msg.delta.dirtyMap) _simClientMapChanged();
    _simClientReplayEvents(msg.events || []);
    _simClientPageTickWork(msg.tick);
    // The page's copy must hash as the worker's; otherwise it is reloaded.
    // The worker's record is the one the resync compares with the peers.
    if (msg.hash) {
        let mine = snapTickHash(msg.tick, !!lockstepStrictDebugMode);
        if (mine.sum !== msg.hash.sum) {
            c.stats.mismatch = (c.stats.mismatch || 0) + 1;
            if (!c.stats.firstDiff) try { c.stats.firstDiff = { tick: msg.tick, parts: snapDescribeCodes(snapDiffTickHash(mine, msg.hash)) }; } catch { }
            _simClientHeal(msg.tick);
        }
        if (isMultiplayer) resyncAfterTick(msg.tick, msg.hash);
        else snapStoreTickHash(msg.hash);
    }
    if (simClientTickAppliedHook) simClientTickAppliedHook(msg.tick);
    let ms = performance.now() - t0;
    c.stats.applied++;
    c.stats.rows += msg.delta.rows || 0;
    c.stats.applyMs.push(ms); c.stats.simMs.push(msg.simMs); c.stats.encodeMs.push(msg.encodeMs);
    for (let k of ['applyMs', 'simMs', 'encodeMs', 'latencyMs']) if (c.stats[k].length > 600) c.stats[k].splice(0, 300);
}

// Buildings, floor items or tiles changed: the cached map layers redraw.
function _simClientMapChanged() {
    dirtyGrid = true;
    _minimapStaticDirty = true;
    if (typeof _requestStaticCacheCommit === 'function') _requestStaticCacheCommit();
    if (typeof requestBuildMenuRefresh === 'function') requestBuildMenuRefresh();
}

// Entities referenced by the worker's side effects.
function _simClientResolve(ref) {
    if (!ref) return null;
    if (ref[0] === 'u') {
        let id = ref[1];
        let lo = 0, hi = units.length - 1;
        while (lo <= hi) { let mid = (lo + hi) >> 1, v = units[mid].id; if (v === id) return units[mid]; if (v < id) lo = mid + 1; else hi = mid - 1; }
        return units.find(u => u.id === id) || null;
    }
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
            case 'f': recordCombatFx(e[1], e[2], e[3], e[4], e[5], e[6] === null ? undefined : e[6]); break;
        }
    }
}

// What the page did as part of a tick: visuals, audio state and UI.
function _simClientPageTickWork(tick) {
    for (let i = particles.length - 1; i >= 0; i--) if (!particles[i].update()) particles.splice(i, 1);
    _simClientLaserSound();
    updateAudioReactiveState();
    if (selectedUnits.length && selectedUnits.some(u => u.dead)) selectedUnits = selectedUnits.filter(u => !u.dead);
    updateVisibility(localPlayerId);
    if ((tick + 1) % TICK_RATE === 0) sampleGameStats();
    requestResearchPopupRefresh();
    let c = _simClient;
    if (!c.gameOverShown) {
        if (gameOver) {
            // The worker ended the match: the same check on the page marks
            // this player defeated (spectating) and shows the result.
            c.gameOverShown = true;
            gameOver = false;
            checkWinCondition();
            if (!gameOver) { gameOver = true; showGameOver(); }
        }
        // Defeat of this player (spectating) is page state.
        else if ((tick & 3) === 0 && !localDefeated) checkWinCondition();
    }
}

// As gameTick does: the laser buzz follows the active laser nearest the view.
function _simClientLaserSound() {
    let any = false, lx = 0, ly = 0, best = Infinity;
    let cx = camera.x + viewW / camera.zoom / 2, cy = camera.y + viewH / camera.zoom / 2;
    for (let t of towers) {
        if (t.type !== 'laser' || t.laserState !== 1 || t.underConstruction) continue;
        any = true;
        let dx = t.x - cx, dy = t.y - cy, d2 = dx * dx + dy * dy;
        if (d2 < best) { best = d2; lx = t.x; ly = t.y; }
    }
    if (any) startLaserSound(lx, ly); else stopLaserSound();
}

// The page's copy differs from the worker's: reload it (the worker sends its
// whole state after the ticks it already ran, and restarts its baseline).
function _simClientHeal(tick) {
    let c = _simClient;
    if (c.healing) return;
    c.healing = true;
    c.stats.heals++;
    logLockstepWarning('Simulation copy differs from the worker; reloading it', { tick });
    c.worker.postMessage({ type: 'request', op: 'replicaState', args: { epoch: c.epoch } });
}

function _simClientApplyReplicaState(msg) {
    let c = _simClient;
    let pageTick = currentTick;
    let uiState = _captureSnapshotApplyUiState();
    let res = snapDecodeState(JSON.parse(msg.text));
    currentTick = pageTick;
    recomputePlayerPopCaps();
    for (let u of units) { u.prevX = u.x; u.prevY = u.y; }
    _restoreSnapshotApplyUiState(uiState, { unitsById: res ? res.unitsById : new Map(), towers, barracks, spawners: collectorSpawners, goldMines, astarMines });
    clearGameplayVisibilityCache();
    updateVisibility(localPlayerId);
    _simClientMapChanged();
    invalidateStaticLayerCache();
    c.appliedTick = msg.tick;
    c.healing = false;
}

// ---- points where the page's network code reads or replaces the state ----

// Whether the page's copy is the worker's current state (nothing in flight).
// Encoding a resync patch or applying one waits for this, so it happens at
// exactly the same point of the simulation on the page as in the worker.
function simClientQuiescent() {
    let c = _simClient;
    return !c || !c.active || (c.inFlight === 0 && !c.healing);
}

// Host: a resync patch of the simulation as it is before the next tick
// dispatched (requests and ticks are handled in order). Resolves to its text.
function simClientEncodePatch(buckets) {
    return simClientRequest('encodePatch', { buckets });
}

// Host: a whole-state snapshot built on the page (lockstep window, config),
// with the simulation state taken from the worker at this point.
function simClientFillSnapshotState(snapshot) {
    return simClientRequest('encodeState').then(r => { snapshot.state = r.state; snapshot.gameTime = r.gameTime; return snapshot; });
}

// Guest: the page applied a resync patch at a quiescent point; the worker
// applies the same text there.
function simClientAfterPatchApplied(text, full) {
    if (!simClientActive()) return;
    _simClient.worker.postMessage({ type: 'request', op: 'applyPatch', args: { text, full: !!full } });
}

// A whole-state restore on the page (join, hard resync...): the worker
// restores the same, and results of ticks dispatched before are dropped.
function simClientAfterSnapshotApplied(snapshot) {
    if (!simClientActive()) return;
    let c = _simClient;
    c.epoch++;
    c.inFlight = 0;
    c.dispatchAt.clear();
    c.appliedTick = currentTick - 1;
    c.appliedAt = 0;
    c.healing = false;
    c.gameOverShown = !!gameOver;
    c.worker.postMessage({ type: 'request', op: 'applySnapshot', args: { snapshot, epoch: c.epoch, globals: _simClientGlobals() } });
}

// ---- interpolation between the last two applied ticks ----
function simClientTickAlpha(frameTime) {
    let c = _simClient;
    if (!c || !c.appliedAt) return 1;
    let alpha = (frameTime - c.appliedAt - c.latencyMs) / TICK_MS;
    return alpha < 0 ? 0 : alpha > 1 ? 1 : alpha;
}

window.simClientStats = function () {
    let c = _simClient;
    if (!c) return { enabled: simClientEnabled };
    let q = (a, p) => { if (!a.length) return 0; let b = [...a].sort((x, y) => x - y); return Math.round(b[Math.min(b.length - 1, Math.floor(b.length * p))] * 100) / 100; };
    let m = a => a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length * 100) / 100 : 0;
    let s = c.stats;
    return {
        enabled: true, loaded: c.loaded, active: c.active, epoch: c.epoch, appliedTick: c.appliedTick, inFlight: c.inFlight, heals: s.heals, dropped: s.dropped,
        errors: c.errors.slice(0, 5), firstDiff: s.firstDiff || null, rowsPerTick: s.applied ? Math.round(s.rows / s.applied * 10) / 10 : 0,
        applyMs: { mean: m(s.applyMs), p95: q(s.applyMs, .95) }, workerSimMs: { mean: m(s.simMs), p95: q(s.simMs, .95) },
        workerEncodeMs: { mean: m(s.encodeMs), p95: q(s.encodeMs, .95) }, latencyMs: { mean: m(s.latencyMs), p95: q(s.latencyMs, .95), shown: Math.round(c.latencyMs) }
    };
};

// The worker loads the game scripts while the menu is up.
if (simClientEnabled) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => simClientPreload());
    else simClientPreload();
}
