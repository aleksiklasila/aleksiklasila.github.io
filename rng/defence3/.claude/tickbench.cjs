// Headless tick benchmark on tests/1500.json: host + guest over the net
// harness (the real game code, no rendering), both teams' combat units sent
// to 10 rally points, then N seconds of play. Prints per-tick times of the
// host and a hash of the state for determinism checks.
//   node .claude/tickbench.cjs [seconds] [--prof]   (run with --cpu-prof for a profile)
const path = require('node:path');
const H = require(path.join(__dirname, '../tests/net-harness.cjs'));
const data = require(path.join(__dirname, '../tests/1500.json'));
const seconds = Number(process.argv[2]) || 15;
(async () => {
    const controls = { ...H.SMALL_MATCH_CONTROLS };
    for (const [k, v] of Object.entries(data.lobby.numbers)) controls[k] = String(v);
    for (const [k, v] of Object.entries(data.lobby.selects)) controls[k] = String(v);
    controls['cfg-full-vis'] = data.lobby.selects['cfg-full-vis'] || 'full';
    const world = new H.World({ controls });
    // The gameplay parts of applyMainMenuSettingsSnapshot (the rest is DOM).
    const hostSetup = `
        MAX_THING_LEVEL = ${data.lobby.numbers['cfg-max-thing-level'] || 20};
        MAX_RESEARCH_LEVEL = ${data.lobby.numbers['cfg-max-research-level'] || 10};
        startingResourcesConfig = normalizeStartingResourcesConfig(${JSON.stringify(data.startingResources)});
        applyMainMenuControlsToRuntimeState();
        applyEditableRuntimeConfigObject(${JSON.stringify(data.editableConfig)}, { fromTransport: true });`;
    const { host, guests } = await H.startHostedMatch(world, { guests: 1, maxMs: 60000, controls, hostSetup });
    const peers = [host, ...guests];
    await world.run(1000);
    for (const g of peers) g.eval(`(() => {
        const mine = units.filter(u => !u.dead && u.owner === localPlayerId && !u.workerType);
        for (let i = 0; i < 10; i++) queueAction({ action: 'move', unitIds: mine.filter((u, k) => k % 10 === i).map(u => u.id),
            targetX: (0.15 + 0.7 * ((i * 7) % 10) / 9) * GRID_W * TILE, targetY: (0.15 + 0.7 * ((i * 3) % 10) / 9) * GRID_H * TILE });
    })()`);
    const { performance: realPerf } = require('node:perf_hooks');
    host.scratch.realNow = () => realPerf.now();
    // PROFILE_TICK=n: CPU profile of that one whole tick (commands included).
    const profileTick = Number(process.env.PROFILE_TICK) || -1;
    const inspector = require('node:inspector');
    const session = profileTick >= 0 ? new inspector.Session() : null;
    if (session) { session.connect(); session.post('Profiler.enable'); session.post('Profiler.setSamplingInterval', { interval: 100 }); }
    host.scratch.profStart = () => session && session.post('Profiler.start');
    host.scratch.profStop = () => session && session.post('Profiler.stop', (err, { profile }) => {
        require('node:fs').writeFileSync(require('node:path').join(__dirname, 'tick' + profileTick + '.cpuprofile'), JSON.stringify(profile));
    });
    host.eval(`__scratch.tickMs = []; __scratch.byTick = [];
        { const f = runOneTick; runOneTick = function () {
            const tick = currentTick, prof = tick === ${profileTick};
            if (prof) __scratch.profStart();
            const a = __scratch.realNow();
            try { return f.apply(this, arguments); } finally {
                const ms = __scratch.realNow() - a;
                if (prof) __scratch.profStop();
                __scratch.tickMs.push(ms); __scratch.byTick.push([tick, Math.round(ms * 10) / 10]); if (__scratch.tickLog) __scratch.tickLog(tick, ms); if (__scratch.colStats) { __scratch.colStats.push([tick, Math.round(ms), globalThis.__colChecks|0, globalThis.__colScanned|0, globalThis.__colNear|0, globalThis.__colHits|0]); globalThis.__colChecks = globalThis.__colScanned = globalThis.__colNear = globalThis.__colHits = 0; }
                if (gameTime === ${Number(process.env.HASH_AT || 300)}) __scratch.hashAt = __exactStateHash() + '/' + computeLockstepStateHashFast(currentTick);
            } }; }`);
    // PATHSTATS=1: count and time path searches per tick (heaviest ticks).
    if (process.env.PATHSTATS) host.eval(`__scratch.ps = {};
        for (const name of ['findGroupPathsToTarget', '_findPathForUnitTagged', 'findNearestWalkable', '_resolveDeferredPathsByGroup', '_issueGroupMoveOrder']) {
            const f = globalThis[name] || eval(name); const wrapped = function () { const a = __scratch.realNow(); try { return f.apply(this, arguments); } finally {
                const t = currentTick, r = (__scratch.ps[t] ||= {}); const e = (r[name] ||= [0, 0]); e[0]++; e[1] += __scratch.realNow() - a; } };
            eval(name + ' = wrapped');
        }`);
    // PHASES=1: time the parts of each tick.
    if (process.env.PHASES) host.eval(`__scratch.ph = {};
        const rec = (name, ms) => { const r = (__scratch.ph[currentTick] ||= {}); r[name] = (r[name] || 0) + ms; };
        const wrapProto = (C, m, name) => { const f = C.prototype[m]; C.prototype[m] = function () { const a = __scratch.realNow(); try { return f.apply(this, arguments); } finally { rec(name, __scratch.realNow() - a); } }; };
        wrapProto(Unit, 'update', 'unitUpdate'); wrapProto(Tower, 'update', 'towerUpdate'); wrapProto(Projectile, 'update', 'projectile');
        for (const name of ['updateAllPlayerVisibility', 'recalculateUnitEffectiveStats', 'recalculateThingPrecomputedStats', 'processGlobalSpawnerQueue',
            'processActions', 'updateVisibility', 'resyncAfterTick', 'sampleGameStats', '_buildDeterministicUnitUpdateOrderForTick', 'recomputePlayerPopCaps',
            'flushPendingMovementAstarSpend', 'flushPendingResourceStatRebuilds', '_runAdjacencyRecalculation', 'updateAudioReactiveState', 'tickStatusEffects', 'destroyBuilding']) {
            const f = eval(name); const w = function () { const a = __scratch.realNow(); try { return f.apply(this, arguments); } finally { rec(name, __scratch.realNow() - a); } }; eval(name + ' = w');
        }
        for (const C of [Barrack]) if (C && C.prototype.update) wrapProto(C, 'update', C.name + 'Update');
        for (const m of ['doMoving', 'doAttackMoving', 'doAttacking', 'doIdle', 'tryDriveByAttack', 'followPath', '_performAttackOnUnit', '_performAttackOnBuilding']) if (Unit.prototype[m]) wrapProto(Unit, m, 'u.' + m);
        for (const name of ['applyUnitSeparation', 'pushUnitOutOfBlockedTile', 'updateWorkerAI', 'updateUnitSpatial', 'recordDamageVisual', 'applyStatusEffect', 'createExplosion', 'pushHostileDamageAlert', '_findClosestEnemyUnitByChunks', '_findAutoStructureTarget', '_tryUpgradeAstarFallbackPath']) {
            let f; try { f = eval(name); } catch { continue; } if (typeof f !== 'function') continue;
            const w = function () { const a = __scratch.realNow(); try { return f.apply(this, arguments); } finally { rec('f.' + name, __scratch.realNow() - a); } }; eval(name + ' = w');
        }`);
    // CROWD_AT=n: unit/tile occupancy stats right before tick n.
    if (process.env.CROWD_AT) host.eval(`{ const f = runOneTick; runOneTick = function () {
        if (currentTick === ${Number(process.env.CROWD_AT)}) {
            const sizes = spatialUnits.map(b => b ? b.length : 0).filter(n => n > 0).sort((a, b) => b - a);
            const moving = units.filter(u => !u.dead && u.commandState !== CMD_IDLE).length;
            const inBig = sizes.filter(n => n > 12).reduce((a, b) => a + b, 0);
            let scans = 0; for (const u of units) { if (u.dead) continue; const gx = Math.floor(u.x / TILE), gy = Math.floor(u.y / TILE);
                for (let y = gy - 1; y <= gy + 1; y++) for (let x = gx - 1; x <= gx + 1; x++) { const b = spatialUnits[y * CHUNKS_W + x]; if (b && x >= 0 && y >= 0 && x < CHUNKS_W && y < CHUNKS_H) scans += b.length; } }
            __scratch.crowd = { units: units.length, moving, tiles: sizes.length, top: sizes.slice(0, 12), unitsInTilesOver12: inBig, neighbours3x3Avg: Math.round(scans / units.length),
                commandStates: units.reduce((m, u) => (m[u.commandState] = (m[u.commandState] || 0) + 1, m), {}) };
        }
        return f.apply(this, arguments); }; }`);
    // TICKLOG=1: print each tick's time as it ends (interleaves with --trace-gc).
    if (process.env.TICKLOG) host.scratch.tickLog = (t, ms) => { if (ms > 30) console.log('TICK', t, ms.toFixed(1), 'end@', Math.round(realPerf.now())); };
    if (process.env.COLSTATS) host.eval('__scratch.colStats = []');
    // FIELDKINDS=a,b: which unit fields changed value kind between ticks a and b
    // (int -> fraction, only-undefined -> value, number -> object...): each such
    // first change makes V8 recompile every function reading units.
    if (process.env.FIELDKINDS) {
        const [ka, kb] = process.env.FIELDKINDS.split(',').map(Number);
        host.eval(`{ const kinds = () => { const k = {}; for (const u of units) for (const f of Object.keys(u)) { const v = u[f];
                const t = v === undefined ? 'u' : v === null ? 'n' : typeof v === 'number' ? (Number.isInteger(v) && Math.abs(v) < 1073741824 && !Object.is(v, -0) ? 'i' : 'd') : typeof v === 'object' ? (Array.isArray(v) ? 'a' : 'o:' + (v.constructor && v.constructor.name)) : typeof v[0];
                (k[f] ||= new Set()).add(t); } return k; };
            const f = runOneTick; runOneTick = function () { if (currentTick === ${ka}) __scratch.kA = kinds(); if (currentTick === ${kb}) __scratch.kB = kinds(); return f.apply(this, arguments); }; }`);
    }
    // FIELDCHURN=1: per unit field, share of ticks x units in which it changed.
    if (process.env.FIELDCHURN) host.eval(`{ const prev = new Map(), churn = {}; let samples = 0;
        const snap = v => (v === null || typeof v !== 'object') ? v : (Array.isArray(v) ? 'A' + v.length : (v.id !== undefined ? 'U' + v.id : 'O'));
        const f = runOneTick; runOneTick = function () { const r = f.apply(this, arguments);
            if (currentTick > 40 && currentTick % 3 === 0) { samples++;
                for (const u of units) { const p = prev.get(u), cur = {}; for (const k of Object.keys(u)) { cur[k] = snap(u[k]); if (p && p[k] !== cur[k] && !(Number.isNaN(p[k]) && Number.isNaN(cur[k]))) churn[k] = (churn[k] || 0) + 1; } prev.set(u, cur); } }
            __scratch.churn = churn; __scratch.churnSamples = samples * units.length; return r; }; }`);
    // STUCKTEST=1: after the 10-point rally, the host sends all its
    // water-resistant units to 5 more points; report how many never got going.
    if (process.env.STUCKTEST) {
        await world.run(2000);
        host.eval(`(() => {
            const sel = units.filter(u => !u.dead && u.owner === localPlayerId && u.unitType === 'water_resistant');
            __scratch.stuckIds = sel.map(u => u.id);
            const pts = [[.2,.2],[.8,.25],[.5,.5],[.25,.8],[.75,.75]];
            // Like shift right-click: the selection split over the points, one order each.
            pts.forEach(([fx, fy], i) => queueAction({ action: 'move', unitIds: sel.filter((u, k) => k % pts.length === i).map(u => u.id), targetX: fx * GRID_W * TILE, targetY: fy * GRID_H * TILE }));
        })()`);
        const report = () => JSON.parse(host.eval(`JSON.stringify((() => { const ids = new Set(__scratch.stuckIds); const sel = units.filter(u => ids.has(u.id) && !u.dead);
            return { tick: currentTick, alive: sel.length, noPath: sel.filter(u => !u.path || u.pathIndex >= u.path.length).length,
                pending: sel.filter(u => u._pendingPathTarget).length, awaiting: sel.filter(u => u._awaitGroupPath).length,
                moved: sel.filter(u => u.x !== u.prevX || u.y !== u.prevY).length }; })())`));
        for (let i = 0; i < 6; i++) { await world.run(1000); console.log('stuck?', JSON.stringify(report())); }
    }
    // LISTCHURN=1: per snapshot list and field, share of (sampled ticks x
    // entities) in which the field changed (entities matched by key).
    if (process.env.LISTCHURN) host.eval(`{ const prev = {}, churn = {}, counts = {};
        const snap = v => (v === null || typeof v !== 'object') ? v : (Array.isArray(v) ? 'A' + v.length : (v.id !== undefined ? 'U' + v.id : (v.gx !== undefined ? 'B' + v.gx + ',' + v.gy : 'O')));
        const f = runOneTick; runOneTick = function () { const r = f.apply(this, arguments);
            if (currentTick > 40 && currentTick % 2 === 0) for (const list of SNAP_LISTS) { const arr = _snapListEntities(list); const pl = prev[list] ||= new Map(), next = new Map(); const ch = churn[list] ||= {};
                counts[list] = (counts[list] || 0) + arr.length;
                arr.forEach((e, i) => { const key = _snapEntityKey(list, e, i); const p = pl.get(key); const cur = {};
                    for (const k of Object.keys(e)) { if (SNAP_SKIP_KEYS.has(k)) continue; cur[k] = snap(e[k]); if (p && p[k] !== cur[k] && !(Number.isNaN(p[k]) && Number.isNaN(cur[k]))) ch[k] = (ch[k] || 0) + 1; }
                    next.set(key, cur); }); prev[list] = next; }
            __scratch.lchurn = { churn, counts }; return r; }; }`);
    const t0 = Date.now();
    await world.run(seconds * 1000);
    const ms = host.eval('JSON.stringify(__scratch.tickMs)');
    const a = JSON.parse(ms).sort((x, y) => x - y);
    const mean = a.reduce((s, v) => s + v, 0) / a.length;
    const r = v => Math.round(v * 100) / 100;
    console.log(JSON.stringify({ ticks: a.length, units: host.eval('units.length'), meanMs: r(mean), p50: r(a[a.length >> 1]), p95: r(a[Math.floor(a.length * .95)]), max: r(a[a.length - 1]),
        wallS: r((Date.now() - t0) / 1000), tick: host.eval('currentTick'), hashAtTick: host.eval('__scratch.hashAt'),
        pathStats: process.env.PATHSTATS ? JSON.parse(host.eval('JSON.stringify(__scratch.ps)')) : undefined,
        phases: process.env.PHASES ? JSON.parse(host.eval('JSON.stringify(__scratch.ph)')) : undefined,
        crowd: process.env.CROWD_AT ? JSON.parse(host.eval('JSON.stringify(__scratch.crowd)')) : undefined,
        colStats: process.env.COLSTATS ? JSON.parse(host.eval('JSON.stringify(__scratch.colStats)')) : undefined,
        fieldKinds: process.env.FIELDKINDS ? JSON.parse(host.eval(`JSON.stringify((() => { const a = __scratch.kA, b = __scratch.kB, out = {};
            for (const f in b) { const before = a[f] ? [...a[f]] : []; const added = [...b[f]].filter(t => !before.includes(t)); if (added.length) out[f] = before.join('') + ' -> +' + added.join(','); } return out; })())`)) : undefined,
        churn: process.env.FIELDCHURN ? JSON.parse(host.eval('JSON.stringify(Object.fromEntries(Object.entries(__scratch.churn).sort((a,b)=>b[1]-a[1]).map(([k,v])=>[k, Math.round(1e4*v/__scratch.churnSamples)/100])))')) : undefined,
        unitFieldCount: process.env.FIELDCHURN ? host.eval('Object.keys(units[0]).length') : undefined,
        listChurn: process.env.LISTCHURN ? JSON.parse(host.eval(`JSON.stringify((() => { const { churn, counts } = __scratch.lchurn; const out = {};
            for (const l in churn) out[l] = { n: counts[l], fields: Object.fromEntries(Object.entries(churn[l]).sort((a, b) => b[1] - a[1]).slice(0, 30).map(([k, v]) => [k, Math.round(1e4 * v / counts[l]) / 100])) }; return out; })())`)) : undefined,
        heaviest: JSON.parse(host.eval('JSON.stringify(__scratch.byTick.slice().sort((a, b) => b[1] - a[1]).slice(0, 8))')) }));
    process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
