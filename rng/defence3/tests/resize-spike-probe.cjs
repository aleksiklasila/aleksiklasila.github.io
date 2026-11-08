'use strict';
// q / e on a big selection (PERF_FUZZ_SPIKES_2026-11-07.md S1): a solo scene
// restored with real helpers, every combat unit of player 0 selected, then
// x2 (e) and d2 (q) as actions, each timed as processActions, with the
// ticks around them (gameTick wall). Prints units before/after.
// ACTIONS=stop,hold,stop (any unitIds action), WARM=n warm ticks.
// Usage: node --max-old-space-size=12000 tests/resize-spike-probe.cjs [scene.gz] [helpers]
//   (default tests/scenes/mixed-200k.gz, 11 helpers); PROF=file.cpuprofile profiles the x2 action.
const path = require('node:path');
globalThis.self = { crossOriginIsolated: true };
const H = require('./net-harness.cjs');
const scene = path.resolve(process.argv[2] || path.join(__dirname, 'scenes/mixed-200k.gz')), helpers = process.argv[3] !== undefined ? Number(process.argv[3]) : 11;
(async () => {
    const controls = { ...H.SMALL_MATCH_CONTROLS };
    const world = new H.World({ controls, hashEvery: 1e9 });
    const host = world.spawn('host', { controls, simWorker: false });
    host.scratch.records = JSON.parse(require('node:zlib').gunzipSync(require('node:fs').readFileSync(scene)));
    host.scratch.scene = host.eval('(() => { const r = soloSceneReader(); for (const a of __scratch.records) r.line(JSON.stringify(a)); return r.finish(); })()');
    host.scratch.records = null;
    host.eval('document.getElementById("starting-resources-popup").classList.add("hidden")');
    let done = false, error;
    host.eval('restoreSoloGameSnapshot(__scratch.scene)').then(() => done = true, e => { done = true; error = e; });
    while (!done) await world.run(20);
    if (error) throw error;
    host.scratch.scene = null;
    host.scratch.Worker = require('./real-sim-helper.cjs');
    console.log('helpers', host.eval(`Worker = __scratch.Worker; navigator.hardwareConcurrency = 32; simParallelInit('', ${helpers})`));
    host.scratch.now = () => Number(process.hrtime.bigint()) / 1e6;
    const tick = () => host.eval('(() => { const a = __scratch.now(); gameTick(); return Math.round((__scratch.now() - a) * 10) / 10; })()');
    const ticks = k => { const r = []; for (let i = 0; i < k; i++) r.push(tick()); return r; };
    // (The scene's population is at its cap: room for the doubling, probe only.)
    host.eval('{ const f = getPlayerPopCap; getPlayerPopCap = p => f(p) + 4000000; }');
    // STAGES=1: wall time per parallel kernel and direct kernel during the actions.
    if (process.env.STAGES) host.eval('{ __scratch.st = {}; const f = simParallelRun, d = simRustDirect; simParallelRun = function (k, n) { const a = __scratch.now(); const r = f.apply(this, arguments); const e = __scratch.st["k" + k] ||= [0, 0]; e[0] += __scratch.now() - a; e[1]++; return r; }; simRustDirect = function (fn) { const a = __scratch.now(); const r = d.apply(this, arguments); const e = __scratch.st[fn] ||= [0, 0]; e[0] += __scratch.now() - a; e[1]++; return r; }; }');
    // PHASES=1: per tick the phases of sim_worker.js SIM_TRACE_FNS (plus the q / e commit), printed for the ticks after each action.
    if (process.env.PHASES) host.eval(`{ __scratch.ph = {};
        for (const name of ['processActions', 'spatialIndexRebuild', 'navTick', 'navFieldsFlush', 'recalculateUnitEffectiveLevel', 'updateAllPlayerVisibility', 'towersTick', 'projectilesAdvance', 'statusPrepassRun', 'simMoveRun', 'combatScanRun',
            '_acqCommit', '_acqPost', 'unitEventsRun', 'unitHitsResolve', 'unitRetirePrepare', 'simUnitStateCollect', 'workerSearchTierStep', 'adjacencyLaneStep', 'tickStatusEffects', 'occupancyPrepareMovement', 'trafficAfterMovement',
            'simParallelBackgroundWait', 'processGlobalSpawnerQueue', 'healerCandidatesStep', 'spawnerStructuresTick', 'visCoverHoldEnd', 'rzCommitDue', 'spatialIndexPrebuild', 'simUnitStateRelayoutStep', 'unitPassEnd', 'compactRemovedUnits', 'spatialCountsDeferEnd', '_unitRetirePass', '_unitGoneRun', 'simUnitStateDetachGone']) {
            let f; try { f = eval(name); } catch (e) { continue; }
            if (typeof f !== 'function') continue;
            const w = function () { const a = __scratch.now(); try { return f.apply(this, arguments); } finally { __scratch.ph[name] = (__scratch.ph[name] || 0) + __scratch.now() - a; } };
            eval(name + ' = w');
        } }`);
    // EVCODES=1: per tick the unit event codes (unit.js _unitEvent) and how many units the event pass listed.
    if (process.env.EVCODES) host.eval('{ __scratch.ev = {}; const f = _unitEvent; _unitEvent = function (u, c, s, code) { __scratch.ev[code] = (__scratch.ev[code] || 0) + 1; return f.apply(this, arguments); }; const g = simParallelRun; simParallelRun = function (k, n) { const r = g.apply(this, arguments); if (k === SIM_KERNEL_UNIT_EVENTS) { let m = 0; for (let i = 0; i < n; i++) m += _unitEvCnt[i * 16]; __scratch.ev.listed = (__scratch.ev.listed || 0) + m; } return r; }; }');
    // SEPDBG=1: the new units' separation keys (absent ones of the first 2000 of _rz.newl) after each tick, before / after the index rebuild, and whether the index was prebuilt.
    if (process.env.SEPDBG) host.eval('{ __scratch.sd = []; const absent = () => { if (!_rz || !_rz.out[0]) return -1; let a = 0; const m = Math.min(2000, _rz.out[0]); for (let i = 0; i < m; i++) if (_simUnitState.sepKey[_rz.newl[i]] === SIM_SEP_ABSENT) a++; return a; }; __scratch.absent = absent; const f = spatialIndexRebuild; spatialIndexRebuild = function () { const b = absent(), pre = !!_sxPre; const r = f.apply(this, arguments); __scratch.sd.push({ before: b, after: absent(), prebuilt: pre, cap: _sxPar ? _sxPar.cap : -1, n: unitCount() }); return r; }; }');
    // MVDBG=1: before each movement, every new unit (_rz.newl) by what the movement controller checks (mv.rs ctl's EV_SPATIAL).
    if (process.env.MVDBG) host.eval('{ __scratch.md = []; const f = simMoveRun; simMoveRun = function () { if (_rz && _rz.out[0] > 0) { const S = _simUnitState, c = S.columns, n = _rz.out[0], r = { n, absent: 0, oob: 0, owner: 0, dead: 0, live0: 0, en0: 0, bindOk: _simParReg["unit.sepKey"] === S.sepKey, xOk: _simParReg["unit.x"] === c.x }; for (let i = 0; i < n; i++) { const s = _rz.newl[i]; if (S.sepKey[s] === SIM_SEP_ABSENT) r.absent++; const gx = Math.floor(c.x[s] / (TILE * 8)), gy = Math.floor(c.y[s] / (TILE * 8)); if (!(gx >= 0 && gx < GRID_W && gy >= 0 && gy < GRID_H)) r.oob++; if (!(c.owner[s] >= 0 && c.owner[s] < players.length)) r.owner++; if (c.dead[s]) r.dead++; if (!c.live[s]) r.live0++; if (!(c.energy[s] > 0)) r.en0++; } __scratch.md.push(r); } const ret = f.apply(this, arguments); if (_rz && _rz.out[0] > 0) { const S = _simUnitState, c = S.columns, cols = ["mvOn", "mvOut", "mvEv", "mvFlags", "commandState", "x", "y", "x0", "y0", "owner", "spOwner", "energy", "dead", "live", "spTile", "spEpoch", "spType", "spArea", "cmMode", "mvWake", "statRow", "esOk", "upT"]; const row = s => Object.fromEntries(cols.filter(k => c[k]).map(k => [k, c[k][s]]).concat([["sep", S.sepKey[s]], ["layer", S.sepLayer[s]]])); const ex = []; for (let i = 0; i < _rz.out[0] && ex.length < 2; i++) { const s = _rz.newl[i]; if (c.mvEv[s] === 4) ex.push(row(s)); } const kept = _rz.list[0] >= 0 ? row(_rz.list[0]) : null; __scratch.md.push({ ev4: ex, kept, spatialEpoch }); } return ret; }; }');
    // KTIME=1: CPU ms per kernel id run on this thread (with 0 helpers: every chunk), printed after each action's ticks.
    if (process.env.KTIME) host.eval('{ __scratch.kt = {}; for (const k in SIM_KERNELS) { const f = SIM_KERNELS[k]; SIM_KERNELS[k] = function (R, P, c) { const a = __scratch.now(); try { return f(R, P, c); } finally { const e = __scratch.kt[k] ||= [0, 0]; e[0] += __scratch.now() - a; e[1]++; } }; } }');
    // (LANEDBG: per tick the background waits by lane, wall ms; which call waited: lane:caller.)
    if (process.env.LANEDBG) host.eval('{ __scratch.lw = {}; const f = simParallelBackgroundWait; simParallelBackgroundWait = function (lane = 1) { const a = __scratch.now(); try { return f.apply(this, arguments); } finally { const d = __scratch.now() - a; if (d >= 0.5) { const who = (new Error().stack.split("\\n")[2] || "").trim().replace(/^at /, "").replace(/ \\(.*$/, ""); const k = lane + ":" + who; __scratch.lw[k] = (__scratch.lw[k] || 0) + d; } } }; }');
    console.log('warm ticks', JSON.stringify(ticks(Number(process.env.WARM) || 5)));
    const count = () => host.eval('units.filter(u => u && !u.dead && u.owner === 0).length');
    const act = (mode) => {
        host.eval(`__scratch.ids = units.filter(u => u && !u.dead && u.owner === 0 && !u.workerType && !u.isKing).map(u => u.id)`);
        if (mode === 'x2') host.eval(`for (const id of __scratch.ids) { const u = getUnitById(id); if (u && u.stackCount < 4) u.stackCount = 4; }`);
        const sel = host.eval('__scratch.ids.length'), before = count(), room = host.eval('getPlayerPopCap(0) - players[0].popCount');
        let session = null;
        if (process.env.PROF && (process.env.PROFMODE || 'x2') === mode) { session = new (require('node:inspector').Session)(); session.connect(); session.post('Profiler.enable'); session.post('Profiler.setSamplingInterval', { interval: 200 }); session.post('Profiler.start'); }
        if (process.env.STAGES) host.eval("__scratch.st = {}");
        if (process.env.DRAIN) host.eval("simParallelBackgroundWaitAll()");
        // (As a peer gets it: the ids in their wire form (uidz), through JSON, prepared before the tick as the
        // worker's tick stream does (actionsPrepare: prepMs); PLAIN=1 sends the ids as a plain list instead.)
        const body = mode === 'x2' || mode === 'd2' ? `{ action: 'resizeUnitGroup', mode: '${mode}', bySub: true, byLevel: false }` : mode === 'move' ? `{ action: 'move', targetX: GRID_W * TILE / 2, targetY: GRID_H * TILE / 2 }` : `{ action: '${mode}' }`;
        const prepMs = host.eval(`(() => { const raw = Object.assign(${body}, ${process.env.PLAIN ? '{ unitIds: __scratch.ids }' : '{ uidz: actionIdsEncode(__scratch.ids) }'}); __scratch.act = JSON.parse(JSON.stringify(raw)); const a = __scratch.now(); actionsPrepare([__scratch.act]); return Math.round((__scratch.now() - a) * 10) / 10; })()`);
        const ms = host.eval(`(() => { const a = __scratch.now(); processActions([__scratch.act], 0); return Math.round((__scratch.now() - a) * 10) / 10; })()`);
        act.prep = prepMs;
        if (session) session.post('Profiler.stop', (e, r) => require('node:fs').writeFileSync(process.env.PROF, JSON.stringify(r.profile)));
        const stages = process.env.STAGES ? host.eval('JSON.stringify(Object.fromEntries(Object.entries(__scratch.st).map(([k, v]) => [k, [Math.round(v[0] * 10) / 10, v[1]]])))') : undefined;
        // (Staged: the action's tick, then the commit at the end of the next one; per tick its kernels when STAGES.)
        const next = [], perTick = [];
        // (PROFTICK=dir: a CPU profile of each of the three ticks after the action, <dir>/<mode><n>-t<i>.cpuprofile.)
        for (let i = 0; i < 8; i++) {
            if (process.env.STAGES) host.eval('__scratch.st = {}');
            if (process.env.PHASES) host.eval('__scratch.ph = {}');
            if (process.env.EVCODES) host.eval('__scratch.ev = {}');
            if (process.env.SEPDBG) host.eval('__scratch.sd = []');
            if (process.env.MVDBG) host.eval('__scratch.md = []');
            let ps = null;
            if (process.env.PROFTICK && i < 7) { ps = new (require('node:inspector').Session)(); ps.connect(); ps.post('Profiler.enable'); ps.post('Profiler.setSamplingInterval', { interval: 500 }); ps.post('Profiler.start'); }
            next.push(tick());
            if (process.env.LANEDBG && i < 4) console.log('  ' + mode + ' waits +' + i, host.eval('JSON.stringify(Object.fromEntries(Object.entries(__scratch.lw || {}).filter(([k, v]) => v >= 1).map(([k, v]) => [k, Math.round(v)])))'));
            if (process.env.LANEDBG) host.eval('__scratch.lw = {}');
            // LANEDBG=1: the q / e lane after the tick: stage, chunks done / total, done.
            if (process.env.LANEDBG && i < 4) console.log('  ' + mode + ' lane +' + i, host.eval('(() => { const P = _simPool; if (!P) return "no pool"; const b = SIM_PAR_BG_BASE + SIM_LANE_RZ * 8, c = P.ctl; return JSON.stringify({ pending: simParallelBackgroundPending(SIM_LANE_RZ), done: simParallelBackgroundDone(SIM_LANE_RZ), stage: Atomics.load(c, b + SIM_PAR_BG_STAGE), chunks: Atomics.load(c, b + SIM_PAR_BG_DONE) + "/" + Atomics.load(c, b + SIM_PAR_BG_TOTAL), job: _rzJob ? { due: _rzJob.due, ends: _rzTickEnds, ns: _rzJob.ns } : null }); })()'));
            if (process.env.MVDBG && i < 3) console.log('  ' + mode + ' mv +' + i, host.eval('JSON.stringify(__scratch.md)'));
            if (process.env.SEPDBG && i < 3) console.log('  ' + mode + ' sep +' + i, host.eval('JSON.stringify({ rebuilds: __scratch.sd, endAbsent: __scratch.absent(), prebuiltAtEnd: !!_sxPre })'));
            if (process.env.EVCODES && i < 3) console.log('  ' + mode + ' events +' + i, host.eval('JSON.stringify(__scratch.ev)'));
            if (process.env.PHASES && i < 7) console.log('  ' + mode + ' tick +' + i, host.eval('JSON.stringify(Object.fromEntries(Object.entries(__scratch.ph).filter(([k, v]) => v >= 3).sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, Math.round(v)])))'));
            if (ps) { const f = path.join(process.env.PROFTICK, mode + (++act.n) + '-t' + i + '.cpuprofile'); ps.post('Profiler.stop', (e, r) => require('node:fs').writeFileSync(f, JSON.stringify(r.profile))); } if (process.env.STAGES && i < 8) perTick.push(host.eval('JSON.stringify(Object.fromEntries(Object.entries(__scratch.st).filter(([k, v]) => /rz|^k1[5-9][0-9]$|^k_(rz|spawn|upk)/.test(k)).map(([k, v]) => [k, Math.round(v[0] * 10) / 10])))')); }
        if (process.env.STAGES) console.log('  rz kernels in the next ticks', JSON.stringify(perTick), 'staged counts', host.eval('JSON.stringify(_rz ? { births: _rz.aout[0], commitJobs: _rz.aout[1], reserved: _rz.rout[0], made: _rz.out[0] } : null)'));
        if (process.env.KTIME) { console.log('  ' + mode + ' kernels', host.eval('JSON.stringify(Object.entries(__scratch.kt).filter(([k, v]) => k >= 158 && k <= 186).map(([k, v]) => [k, Math.round(v[0] * 10) / 10, v[1]]))')); host.eval('__scratch.kt = {}'); }
        console.log(mode, JSON.stringify({ prepMs: act.prep, stages, selected: sel, room, unitsBefore: before, unitsAfter: count(), actionMs: ms, nextTicks: next }));
    };
    act.n = 0;
    // (ACTIONS=stop,hold,...: those actions on the same selection instead of x2, d2, x2.)
    for (const m of (process.env.ACTIONS || 'x2,d2,x2').split(',')) act(m);
    console.log('errors', JSON.stringify(host.errors.map(String).slice(0, 5)));
    process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
