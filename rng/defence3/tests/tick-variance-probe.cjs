'use strict';
// Idle tick variance (no player action): a solo scene restored with real
// helpers, WARM ticks, then TICKS ticks each timed (gameTick wall) with the
// time of every phase of sim_worker.js SIM_TRACE_FNS (plus the background
// waits by lane:caller). Prints per tick the total and the phases, then per
// phase mean / min / max / spread (max - min) and its correlation with the
// tick total: the phases that make one tick unlike the next.
// Usage: node --max-old-space-size=14000 tests/tick-variance-probe.cjs [scene.gz] [helpers] [ticks]
const path = require('node:path');
globalThis.self = { crossOriginIsolated: true };
const H = require('./net-harness.cjs');
const scene = path.resolve(process.argv[2] || path.join(__dirname, 'scenes/chaos-1m-250k.gz'));
const helpers = process.argv[3] !== undefined ? Number(process.argv[3]) : 11, N = Number(process.argv[4]) || 40, WARM = Number(process.env.WARM) || 15;
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
    host.eval(`Worker = __scratch.Worker; navigator.hardwareConcurrency = 32; simParallelInit('', ${helpers})`);
    host.scratch.now = () => Number(process.hrtime.bigint()) / 1e6;
    // PF=1: page faults per phase (pf:name, over 200).
    if (process.env.PF) host.scratch.pf = () => { const r = process.resourceUsage(); return r.minorPageFault + r.majorPageFault; };
    host.eval(`{ __scratch.ph = {};
        const names = ['processActions', 'spatialIndexRebuild', 'navTick', 'navFieldsFlush', 'recalculateUnitEffectiveLevel', 'updateAllPlayerVisibility', 'towersTick', 'projectilesAdvance', 'statusPrepassRun', 'simMoveRun', 'combatScanRun', 'workerSearchTierStep', 'adjacencyLaneStep', 'tickStatusEffects', 'occupancyPrepareMovement', 'trafficAfterMovement', 'processGlobalSpawnerQueue', 'healerCandidatesStep', 'spawnerStructuresTick', 'visCoverHoldEnd', 'unitPassEnd', 'spatialCountsDeferEnd', 'simUnitStateCollect', 'unitRetirePrepare', 'simUnitStateDetachGone'].concat(['_acqCommit', '_acqPost', 'unitEventsRun', 'unitHitsResolve', 'simUnitStateRelayoutStep', 'compactRemovedUnits', '_unitRetirePass', '_unitGoneRun', 'rzCommitDue', 'flowLooksCommit', '_spatialIndexCollect', 'workerBrainsCollect', 'simUnitStateReleaseFreed', 'spatialIndexPrebuild', 'simStateHashStep', '_retirePlan', '_unitByIdRemovedRows', 'simUnitStateDetachGoneMany', '_simFreeReturn', '_simFreePost', 'simUnitStateReleaseFreed', '_simPlayerEncode', '_simLevelsEncode', '_simQueueEncode', '_simPlain', 'ensurePlayerResearchQueueState', '_simTaskStore']);
        for (const name of [...new Set(names)]) {
            let f; try { f = eval(name); } catch (e) { continue; }
            if (typeof f !== 'function') continue;
            const w = function () { const a = __scratch.now(), p0 = __scratch.pf ? __scratch.pf() : 0; try { return f.apply(this, arguments); } finally { __scratch.ph[name] = (__scratch.ph[name] || 0) + __scratch.now() - a; if (__scratch.pf) { const d = __scratch.pf() - p0; if (d > 200) __scratch.ph['pf:' + name] = (__scratch.ph['pf:' + name] || 0) + d; } } };
            eval(name + ' = w');
        }
        // (Parallel kernels by id: kp:<id>.)
        const pr = simParallelRun; simParallelRun = function (kk, n) { const a = __scratch.now(); try { return pr.apply(this, arguments); } finally { const d = __scratch.now() - a; if (d >= 0.3) { const key = 'kp:' + kk; __scratch.ph[key] = (__scratch.ph[key] || 0) + d; } } };
        // (Direct kernels by name, and pendingPathUnlink calls.)
        const rd = simRustDirect; simRustDirect = function (fn) { const a = __scratch.now(); try { return rd.apply(this, arguments); } finally { const d = __scratch.now() - a; if (d >= 0.5) { const k = 'k:' + fn; __scratch.ph[k] = (__scratch.ph[k] || 0) + d; } } };
        const pu = pendingPathUnlink; pendingPathUnlink = function () { __scratch.ph['n:pendingPathUnlink'] = (__scratch.ph['n:pendingPathUnlink'] || 0) + 1; const a = __scratch.now(); try { return pu.apply(this, arguments); } finally { __scratch.ph['pendingPathUnlink'] = (__scratch.ph['pendingPathUnlink'] || 0) + __scratch.now() - a; } };
        const bw = simParallelBackgroundWait; simParallelBackgroundWait = function (lane = 1) { const a = __scratch.now(); try { return bw.apply(this, arguments); } finally { const d = __scratch.now() - a; if (d >= 0.2) { const k = 'wait' + lane; __scratch.ph[k] = (__scratch.ph[k] || 0) + d; if (d >= 5) { const busy = []; for (let l = 0; l < SIM_PAR_BG_LANES; l++) if (l !== lane && simParallelBackgroundPending(l)) busy.push(l); __scratch.ph['busy@' + lane + ':' + busy.join('.')] = 1; } } } };
    }`);
    // OBJ=1: unit objects made per tick, by caller (the two frames above _simUnitObject).
    if (process.env.OBJ) host.eval('{ __scratch.ob = {}; const f = _simUnitObject; _simUnitObject = function () { const st = new Error().stack.split(String.fromCharCode(10)); const k = (st[2] || "").trim().slice(3, 90) + " < " + (st[3] || "").trim().slice(3, 90); __scratch.ob[k] = (__scratch.ob[k] || 0) + 1; return f.apply(this, arguments); }; }');
    for (let i = 0; i < WARM; i++) host.eval('gameTick()');
    if (process.env.OBJ) { console.log('objects made in the warm ticks', host.eval('JSON.stringify(Object.entries(__scratch.ob).sort((a, b) => b[1] - a[1]).slice(0, 12))')); host.eval('__scratch.ob = {}'); }
    // (The wasm heap's allocations in play, by call site: simHeapPlayMark.)
    host.eval('simHeapPlayMark(true)');
    // HEAPPROF=file: a sampling heap profile (JavaScript allocations) of the measured ticks.
    let hs = null;
    if (process.env.HEAPPROF) { hs = new (require('node:inspector').Session)(); hs.connect(); hs.post('HeapProfiler.enable'); hs.post('HeapProfiler.startSampling', { samplingInterval: 4096, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true }); }
    const rows = [];
    for (let i = 0; i < N; i++) {
        host.eval('globalThis.__flowPend = []; __scratch.ph = {}; globalThis.__relStats = { n: 0, obj: 0, ref: 0 }');
        const pf0 = process.resourceUsage();
        const ms = host.eval('(() => { const a = __scratch.now(); gameTick(); return __scratch.now() - a; })()');
        // ENC=1: the worker's state encode after the tick (sim_frame_world.js simFrameEncodeState), timed with its parts.
        if (process.env.ENC) host.eval('{ if (!__scratch.qw) { __scratch.qw = 1; const f = _simQueueEncode; _simQueueEncode = function (C, q, fresh) { const r = f.apply(this, arguments); const k = r === _SIM_SAME ? "same" : r && r.__qr ? "runs" + r.tail.length : r && r.__qd ? "tail" + r.tail.length + "@" + r.__qd[1] : Array.isArray(r) ? "full" + r.length : "other"; __scratch.ph["q:" + k] = (__scratch.ph["q:" + k] || 0) + 1; return r; }; } const a = __scratch.now(); simFrameEncodeState(false); __scratch.ph.encState = __scratch.now() - a; }');
        const pf1 = process.resourceUsage();
        const ph = JSON.parse(host.eval('JSON.stringify(__scratch.ph)')); const rs = JSON.parse(host.eval('JSON.stringify(globalThis.__relStats)')); { const fp = JSON.parse(host.eval('JSON.stringify(globalThis.__flowPend)')); if (fp.length) ph['flowPend'] = fp[0]; } if (rs.n) { ph['rel:n'] = rs.n; ph['rel:obj'] = rs.obj; ph['rel:ref'] = rs.ref; }
        rows.push({ ms, ph, pf: (pf1.minorPageFault - pf0.minorPageFault) + (pf1.majorPageFault - pf0.majorPageFault), units: i % 10 === 0 ? host.eval('unitCount()') : undefined });
    }
    if (hs) await new Promise(r => hs.post('HeapProfiler.stopSampling', (e, res) => { require('node:fs').writeFileSync(process.env.HEAPPROF, JSON.stringify(res.profile)); r(); }));
    // (Wrapped phases nest (spatialIndexRebuild inside the tick body...): spread per name, not a sum.)
    const keys = [...new Set(rows.flatMap(r => Object.keys(r.ph)))];
    const tot = rows.map(r => r.ms), mean = a => a.reduce((x, y) => x + y, 0) / a.length;
    const corr = (a, b) => { const ma = mean(a), mb = mean(b); let s = 0, sa = 0, sb = 0; for (let i = 0; i < a.length; i++) { s += (a[i] - ma) * (b[i] - mb); sa += (a[i] - ma) ** 2; sb += (b[i] - mb) ** 2; } return sa && sb ? s / Math.sqrt(sa * sb) : 0; };
    const sorted = [...tot].sort((a, b) => a - b), q = p => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
    console.log('ticks', JSON.stringify(tot.map(x => Math.round(x))));
    console.log('total', JSON.stringify({ mean: Math.round(mean(tot)), p50: Math.round(q(0.5)), p95: Math.round(q(0.95)), min: Math.round(sorted[0]), max: Math.round(sorted[sorted.length - 1]), units: rows[0].units }));
    const stats = keys.map(k => { const v = rows.map(r => r.ph[k] || 0); return [k, Math.round(mean(v) * 10) / 10, Math.round(Math.min(...v) * 10) / 10, Math.round(Math.max(...v) * 10) / 10, Math.round(corr(v, tot) * 100) / 100]; })
        .filter(s => s[3] >= 2).sort((a, b) => (b[3] - b[2]) - (a[3] - a[2]));
    console.log('phase [mean, min, max, corr with total] by spread:');
    for (const s of stats.slice(0, 30)) console.log('  ' + s[0].padEnd(32) + JSON.stringify(s.slice(1)));
    if (process.env.ROWS) for (let i = 0; i < rows.length; i++) console.log('  t' + i, Math.round(rows[i].ms), 'pf', rows[i].pf, JSON.stringify(Object.fromEntries(Object.entries(rows[i].ph).filter(([k, v]) => v >= 4).sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, Math.round(v)]))));
    if (process.env.ENC) console.log('players', host.eval('JSON.stringify(players.map(p => ({ q: Array.isArray(p.researchQueue) ? p.researchQueue.length : -1, keys: Object.keys(p).length, lv: p.researchLevels ? Object.keys(p.researchLevels).length : 0, task: !!p.researchTask })))'));
    console.log('heap in play', host.eval('JSON.stringify(simHeapPlayStats(25))'));
    console.log('audit', host.eval('JSON.stringify({ slabs: simUnitSlabAudit().ok, occupancy: occupancyAudit().ok, errors: host_errors() })'.replace('host_errors()', '0')), 'errors', JSON.stringify(host.errors.map(String).slice(0, 3)));
    console.log('audit', host.eval('JSON.stringify({ slabs: simUnitSlabAudit().ok, occupancy: occupancyAudit().ok })'), 'errors', JSON.stringify(host.errors.map(String).slice(0, 3)));
    process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
