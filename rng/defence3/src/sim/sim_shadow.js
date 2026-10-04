"use strict";
// ============================================================
// SIMULATION WORKER, PAGE SIDE (stage 1: shadow)
//
// With ?simworker=shadow in the URL, every match also runs in a simulation
// worker (src/sim/sim_worker.js): it starts from the page's start snapshot,
// receives each tick's commands and reports its state hash, which is checked
// against the page's own. Nothing on screen depends on it yet; it proves the
// worker computes the same game and measures its tick cost.
// window.simShadowStats() returns the comparison so far.
// ============================================================

const simShadowEnabled = (() => {
    try { return new URLSearchParams(location.search).get('simworker') === 'shadow'; } catch { return false; }
})();

let _simShadow = null;

// The page's own script list (same files and cache versions) minus the
// page-only boot script and these simulation-worker scripts.
function _simShadowScriptUrls() {
    return [...document.querySelectorAll('script[src]')]
        .map(s => s.src)
        .filter(src => /\/src\//.test(src) && !/bootstrap\.js|sim_shadow\.js|sim_worker\.js/.test(src));
}

function simShadowLoad() {
    if (!simShadowEnabled || _simShadow) return _simShadow;
    let worker = new Worker('./src/sim/sim_worker.js?v=20261022-w');
    _simShadow = {
        worker, loaded: false, started: false, loadMs: 0, pending: new Map(), compared: 0, mismatches: [], errors: [],
        workerMs: [], lastTick: -1, startTick: -1, queue: []
    };
    worker.onmessage = ev => _simShadowOnMessage(ev.data || {});
    worker.onerror = ev => { _simShadow.errors.push({ where: 'worker', message: String(ev.message || ev) }); console.error('[sim worker]', ev.message || ev); };
    worker.postMessage({ type: 'load', scripts: _simShadowScriptUrls() });
    return _simShadow;
}

function _simShadowOnMessage(msg) {
    let s = _simShadow;
    if (!s) return;
    if (msg.type === 'loaded') { s.loaded = true; s.loadMs = msg.ms; console.info('[sim worker] loaded in', Math.round(msg.ms), 'ms'); }
    else if (msg.type === 'started') {
        s.started = true;
        s.startTick = msg.tick;
        let mine = s.pending.get('start');
        if (mine !== undefined && mine !== msg.hash) s.mismatches.push({ tick: msg.tick, page: mine, worker: msg.hash, at: 'start' });
        for (let m of s.queue) s.worker.postMessage(m);
        s.queue = [];
    } else if (msg.type === 'ticked') {
        s.workerMs.push(msg.ms);
        if (s.workerMs.length > 2000) s.workerMs.shift();
        let mine = s.pending.get(msg.tick);
        s.pending.delete(msg.tick);
        s.compared++;
        s.lastTick = msg.tick;
        if (mine !== msg.hash) {
            if (s.mismatches.length < 20) s.mismatches.push({ tick: msg.tick, page: mine, worker: msg.hash });
            if (s.mismatches.length === 1) console.warn('[sim worker] state differs from the page at tick', msg.tick);
        }
    } else if (msg.type === 'error') {
        if (s.errors.length < 50) s.errors.push(msg);
        console.error('[sim worker]', msg.where, msg.message, msg.stack);
    }
}

// Right after the match start snapshot is restored on the page.
function simShadowStartMatch(snapshotText) {
    if (!simShadowEnabled) return;
    let s = simShadowLoad();
    s.started = false; s.pending = new Map(); s.compared = 0; s.mismatches = []; s.queue = []; s.workerMs = [];
    let controls = {};
    for (let el of document.querySelectorAll('input[id], select[id]')) {
        controls[el.id] = el.type === 'checkbox' ? { checked: el.checked } : { value: el.value };
    }
    s.pending.set('start', computeLockstepStateHashFast(currentTick));
    s.worker.postMessage({
        type: 'start', snapshotText, controls,
        globals: {
            assign: {
                isMultiplayer, isHost, localPlayerId, gameSeed, activeTeamIds, lobbyPlayers: typeof lobbyPlayers !== 'undefined' ? lobbyPlayers : [],
                gameMode, fullVisibility, matchFullVisibility
            },
            editableConfig: typeof serializeEditableRuntimeConfigForTransport === 'function' ? serializeEditableRuntimeConfigForTransport() : null,
            startingResources: typeof startingResourcesConfig !== 'undefined' ? startingResourcesConfig : null
        }
    });
}

// From runOneTick, after the page ran the tick: the same commands for the worker.
function simShadowAfterTick(tick, actions, teams, flush) {
    let s = _simShadow;
    if (!s) return;
    s.pending.set(tick, computeLockstepStateHashFast(tick));
    let msg = { type: 'tick', tick, actions, teams, flush: !!flush };
    if (s.started) s.worker.postMessage(msg); else s.queue.push(msg);
}

window.simShadowStats = function () {
    let s = _simShadow;
    if (!s) return { enabled: simShadowEnabled };
    let ms = [...s.workerMs].sort((a, b) => a - b);
    let q = p => ms.length ? Math.round(ms[Math.min(ms.length - 1, Math.floor(ms.length * p))] * 10) / 10 : 0;
    return {
        enabled: true, loaded: s.loaded, loadMs: Math.round(s.loadMs), started: s.started, startTick: s.startTick, compared: s.compared,
        lastTick: s.lastTick, mismatches: s.mismatches, errors: s.errors.slice(0, 5),
        workerTickMs: { mean: ms.length ? Math.round(ms.reduce((a, b) => a + b, 0) / ms.length * 10) / 10 : 0, p50: q(.5), p95: q(.95), max: q(1) }
    };
};
