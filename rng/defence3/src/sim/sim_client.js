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

const SIM_CLIENT_WORKER_URL = './src/sim/sim_worker.js?v=20261018-a';

function _simClientCreate() {
    let c = {
        worker: null, loaded: false, active: false, epoch: 0, startTick: -1, nextRequestId: 1, replies: new Map(),
        inFlight: 0, lastDispatchAt: 0, tickClock: 0, dispatchAt: new Map(), appliedTick: -1, appliedAt: 0, latencyMs: TICK_MS, arrivedAt: 0, intervalMs: TICK_MS, drawnAlpha: -1, errors: [],
        stats: { applied: 0, applyMs: [], simMs: [], encodeMs: [], latencyMs: [], rows: 0, heals: 0, dropped: 0 }
    };
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
    worker.onmessage = ev => { try { _simClientOnMessage(ev.data || {}); } catch (err) { reportRuntimeError('sim worker', err); } };
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
    worker.postMessage({ type: 'load', scripts: _simClientScriptUrls(), maxHelpers });
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
    // Units come from the worker's frames (the first one with 'started').
    _simClientResetUnits();
    recomputePlayerPopCaps();
    // The worker simulates from here on: the page reads its grids.
    _visCoverSimContext = false;
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
    c.appliedAt = 0; c.arrivedAt = 0;
    c.gameOverShown = false;
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
        myPeerId: typeof myPeerId !== 'undefined' ? myPeerId : null,
        lobbyPlayers: typeof lobbyPlayers !== 'undefined' ? lobbyPlayers : [], gameStarted: true
    };
}

// When the page's role or view changes (host migration, defeat...).
function simClientSyncGlobals() {
    if (simClientActive()) _simClient.worker.postMessage({ type: 'request', op: 'setGlobals', args: { assign: _simClientGlobals() } });
}

function simClientStop() {
    if (_simClient) { _simClient.active = false; _simClient.epoch++; _simClient.worker.postMessage({type:'presentationStop'}); }
}

// ---- ticks ----
function simClientRunTick(tick, actions, teams, flush) {
    let c = _simClient;
    c.inFlight++;
    // Ticks on the shared wall clock: one interval after the previous, unless
    // the match stalled (then from now), so frame timing does not jitter it.
    let now = performance.now();
    let tickMs = netSimulationTickMs();
    let at = c.tickClock + tickMs;
    if (!(at >= now - tickMs)) at = now;
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
        case 'loaded': c.loaded = true; c.helpers = msg.helpers || 0; c.shared = !!msg.shared; break;
        case 'started':
            if (msg.world) { if (msg.epoch === c.epoch) _simClientApplyWorld(msg.world, 1); else _simClientReturnBufs(_simClientWorldBufs(msg.world)); }
            break;
        case 'ticked': _simClientApplyTick(msg); break;
        case 'presentation': {
            if (msg.epoch !== c.epoch || !c.active) { _simClientReturnBufs(_simClientWorldBufs(msg.world)); break; }
            const now=performance.now(), shown=c.arrivedAt>0 ? Math.max(0,c.drawnAlpha) : 1;
            _simClientApplyWorld(msg.world,shown);
            if (c.arrivedAt>0) c.intervalMs += (Math.max(10,Math.min(250,now-c.arrivedAt))-c.intervalMs)*.25;
            c.arrivedAt=now;c.drawnAlpha=-1;c.presentationTick=msg.tick;
            c.presentationBuildMs=msg.buildMs;
            break;
        }
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
    try { _simClientApplyWorld(msg.world, shown); } catch (err) { reportRuntimeError('sim frame', err); }
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
    c.lastSight = msg.sight ? { data: msg.sight, player: msg.sightPlayer } : null;
    _simClientReplayEvents(msg.events || []);
    _simClientPageTickWork(msg.tick);
    // The tick's record (the peers compare them).
    if (msg.hash) {
        if (isMultiplayer) resyncAfterTick(msg.tick, msg.hash);
        else snapStoreTickHash(msg.hash);
    }
    if (simClientTickAppliedHook) simClientTickAppliedHook(msg.tick, msg.lockHashes ? msg.lockHashes[0] : undefined, msg.report);
    let ms = performance.now() - t0;
    netNoteSimulationTick(performance.now(), (Number(msg.simMs) || 0) + (Number(msg.encodeMs) || 0) + ms);
    c.stats.applied++;
    c.stats.applyMs.push(ms); c.stats.simMs.push(msg.simMs); c.stats.encodeMs.push(msg.encodeMs);
    for (let k of ['applyMs', 'simMs', 'encodeMs', 'latencyMs']) if (c.stats[k].length > 600) c.stats[k].splice(0, 300);
}

// ---- units: frames and their views ----

// View per slot (while alive; by id in _pageUnitsById).
let _pageSlotViews = [];
let _pageViewStamp = 0;

function _simClientReturnBufs(bufs) {
    let c = _simClient;
    bufs = bufs.filter(b => b && b.byteLength);
    if (c && bufs.length) c.worker.postMessage({ type: 'frameReturn', bufs }, bufs.filter(b => !(typeof SharedArrayBuffer === 'function' && b instanceof SharedArrayBuffer)));
}

// The page's units: none until the worker's next frame (objects from a
// restore on the page are not the simulation's).
function _simClientResetUnits() {
    let c = _simClient;
    for (let u of _pageUnitsById.values()) { u._freeze(); u.dead = true; }
    _pageUnitsById = new Map();
    _pageSlotViews = [];
    let bufs = pageResetWorldTables(c);
    if (_pageFrame) { bufs.push(_pageFrame.buf); _pageFrame = null; }
    _simClientReturnBufs(bufs);
    units = [];
    simUnitStateReset();
    if (typeof initSpatialHash === 'function') initSpatialHash();
    if (c) { c.frameUnits = null; c.mver = -1; c.watchKey = ''; }
    _pageFrameStrings.length = 1;
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
    if (w.strings) { let base = w.strings[0], list = w.strings[1]; for (let i = 0; i < list.length; i++) _pageFrameStrings[base + i] = list[i]; }
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
function _simClientApplyFrame(frame, shown) {
    let c = _simClient;
    let F = simFrameViews(frame.buf, frame.cap);
    F.n = frame.n; F.count = frame.count;
    let old = _pageFrame;
    if (old && shown < 1) {
        let n = Math.min(F.n, old.n), oid = old.id, ox = old.x, oy = old.y, opx = old.px, opy = old.py, id = F.id, px = F.px, py = F.py;
        for (let s = 0; s < n; s++) {
            if (id[s] < 0 || oid[s] !== id[s]) continue;
            px[s] = opx[s] + (ox[s] - opx[s]) * shown;
            py[s] = opy[s] + (oy[s] - opy[s]) * shown;
        }
    }
    if (frame.mver !== c.mver || c.frameUnits !== units) {
        let stamp = ++_pageViewStamp, list = new Array(frame.count), order = F.order, ids = F.id;
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
        units = list;
        c.frameUnits = list;
        c.mver = frame.mver;
        // A restore brought new objects for units the page had selected.
        if (selectedUnits.length && selectedUnits.some(u => !(u instanceof PageUnit))) {
            selectedUnits = selectedUnits.map(u => u instanceof PageUnit ? u : _pageUnitsById.get(u.id)).filter(u => u && !u.dead);
        }
    }
    _pageFrame = F;
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
// What the page watches: the selected units and structures (up to caps).
function _simClientWatch() {
    let c = _simClient, list = [], structures = [], key = '';
    for (let i = 0; i < selectedUnits.length && list.length < SIM_CLIENT_WATCH_MAX * 2; i++) {
        let u = selectedUnits[i];
        if (!(u instanceof PageUnit) || u.dead) continue;
        list.push(u.id, u._s);
        key += u.id + ':' + u._s + ',';
    }
    key += '|';
    for (let i = 0; i < selectedEntities.length && structures.length < 128; i++) {
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
    // What this player sees: the worker's grid for this tick when it sent
    // one (rows are views of it), else computed here. Other players' grids
    // are computed on the page only when asked for.
    let sight = _simClient.lastSight;
    if (sight && sight.player === localPlayerId && sight.data.length === GRID_W * GRID_H) {
        let rows = new Array(GRID_H);
        for (let y = 0; y < GRID_H; y++) rows[y] = sight.data.subarray(y * GRID_W, (y + 1) * GRID_W);
        visibilityGridRawByPlayerCache.set(localPlayerId, rows);
        visibilityGridStampByPlayer.set(localPlayerId, gameTime);
        visibilityCacheTick = gameTime;
    }
    _simClient.lastSight = null;
    visibilityGrid = updateVisualVisibility(localPlayerId, getRawVisibilityGridForPlayer(localPlayerId));
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

// Host: a whole-state snapshot built on the page (lockstep window, config),
// with the simulation state taken from the worker at this point.
function simClientFillSnapshotState(snapshot) {
    return simClientRequest('encodeState').then(r => { snapshot.state = r.state; snapshot.gameTime = r.gameTime; return snapshot; });
}

// Guest: a resync patch, for the worker to apply before the next tick.
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
    c.appliedAt = 0; c.arrivedAt = 0;
    // Units come with the worker's next frame.
    _simClientResetUnits();
    c.gameOverShown = !!gameOver;
    c.worker.postMessage({ type: 'request', op: 'applySnapshot', args: { snapshot, epoch: c.epoch, globals: _simClientGlobals() } });
}

// ---- interpolation between the last two applied ticks ----
function simClientTickAlpha(frameTime) {
    let c = _simClient;
    if (!c || !c.arrivedAt) return 1;
    let alpha = (frameTime - c.arrivedAt) / Math.max(1, c.intervalMs);
    // Called once per drawn frame: remembered for the next result's start.
    c.drawnAlpha = alpha < 0 ? 0 : alpha > 1 ? 1 : alpha;
    return alpha < 0 ? 0 : alpha > 1 ? 1 : alpha;
}

window.simClientStats = function () {
    let c = _simClient;
    if (!c) return { enabled: simClientEnabled };
    let q = (a, p) => { if (!a.length) return 0; let b = [...a].sort((x, y) => x - y); return Math.round(b[Math.min(b.length - 1, Math.floor(b.length * p))] * 100) / 100; };
    let m = a => a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length * 100) / 100 : 0;
    let s = c.stats;
    return {
        enabled: true, loaded: c.loaded, active: c.active, helpers: c.helpers || 0, shared: !!c.shared, epoch: c.epoch, appliedTick: c.appliedTick, inFlight: c.inFlight, heals: s.heals, dropped: s.dropped,
        presentation:!!c.presentation, presentationTick:c.presentationTick, presentationBuildMs:c.presentationBuildMs, errors: c.errors.slice(0, 5), firstDiff: s.firstDiff || null, rowsPerTick: s.applied ? Math.round(s.rows / s.applied * 10) / 10 : 0,
        rowsPerTickByList: s.applied ? Object.fromEntries(Object.entries(s.rowsBy || {}).map(([k, v]) => [k, Math.round(v / s.applied * 10) / 10])) : null,
        applyMs: { mean: m(s.applyMs), p95: q(s.applyMs, .95) }, workerSimMs: { mean: m(s.simMs), p95: q(s.simMs, .95) },
        workerEncodeMs: { mean: m(s.encodeMs), p95: q(s.encodeMs, .95) }, latencyMs: { mean: m(s.latencyMs), p95: q(s.latencyMs, .95), shown: Math.round(c.latencyMs) }
    };
};

// The worker loads the game scripts while the menu is up.
if (simClientEnabled) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => simClientPreload());
    else simClientPreload();
}
