// Headless tick benchmark on tests/1500.json: host + guest over the net
// harness (the real game code, no rendering), both teams' combat units sent
// to 10 rally points, then N seconds of play. Prints per-tick times of the
// host and a hash of the state for determinism checks.
//   node .claude/tickbench.cjs [seconds] [--prof]   (run with --cpu-prof for a profile)
const path = require('node:path');
// HELPERS=n: the host's simulation gets n real helper threads (shared
// memory kernels, as in a cross-origin isolated browser).
if (process.env.HELPERS) globalThis.self = { crossOriginIsolated: true };
const H = require(path.join(__dirname, '../tests/net-harness.cjs'));
// DATA=path: another lobby settings file (default tests/1500.json).
const data = require(process.env.DATA ? path.resolve(process.env.DATA) : path.join(__dirname, '../tests/1500.json'));
const seconds = Number(process.argv[2]) || 15;
(async () => {
    const controls = { ...H.SMALL_MATCH_CONTROLS };
    for (const [k, v] of Object.entries(data.lobby.numbers)) controls[k] = String(v);
    for (const [k, v] of Object.entries(data.lobby.selects)) controls[k] = String(v);
    controls['cfg-full-vis'] = data.lobby.selects['cfg-full-vis'] || 'full';
    const world = new H.World({ controls, hashEvery: Number(process.env.HASHEVERY) || 1e9 });
    // The gameplay parts of applyMainMenuSettingsSnapshot (the rest is DOM).
    const hostSetup = `
        MAX_THING_LEVEL = ${data.lobby.numbers['cfg-max-thing-level'] || 20};
        MAX_RESEARCH_LEVEL = ${data.lobby.numbers['cfg-max-research-level'] || 10};
        startingResourcesConfig = normalizeStartingResourcesConfig(${JSON.stringify(data.startingResources)});
        applyMainMenuControlsToRuntimeState();
        applyEditableRuntimeConfigObject(${JSON.stringify(data.editableConfig)}, { fromTransport: true });`;
    const { host, guests } = await H.startHostedMatch(world, { guests: 1, maxMs: 60000, controls, hostSetup });
    const peers = [host, ...guests];
    // (Helpers before the workloads' setups: as in the game, they run from
    // the match's start, so background jobs posted by the setups use them.)
    if (process.env.HELPERS) {
        host.scratch.Worker = require(path.join(__dirname, '../tests/real-sim-helper.cjs'));
        console.log('helpers', host.eval(`Worker = __scratch.Worker; navigator.hardwareConcurrency = 32; simParallelInit('', ${Number(process.env.HELPERS)})`));
    }
    await world.run(1000);
    for (const g of peers) g.eval(`(() => {
        const mine = units.filter(u => !u.dead && u.owner === localPlayerId && !u.workerType);
        for (let i = 0; i < 10; i++) queueAction({ action: 'move', unitIds: mine.filter((u, k) => k % 10 === i).map(u => u.id),
            targetX: (0.15 + 0.7 * ((i * 7) % 10) / 9) * GRID_W * TILE, targetY: (0.15 + 0.7 * ((i * 3) % 10) / 9) * GRID_H * TILE });
    })()`);
    // ACTIVE=1: give the workers work (as players would have sent them to
    // it), on every peer at the same tick: each collector at a mine of its
    // own, builders with towers to build beside them, healers beside
    // barracks with queues to pay for, salvagers beside towers marked for
    // salvage, researchers beside research buildings.
    if (process.env.ACTIVE) {
        const at = world.atNextSafeTick(`try { (() => {
            const put = (u, gx, gy) => { const t = findNearestWalkable(gx, gy); u.x = u.prevX = t.x * TILE + 16; u.y = u.prevY = t.y * TILE + 16; updateUnitSpatial(u); u._workerNextIdleRetargetTick = gameTime; u._idleFailVer = -1; };
            const freeNear = (gx, gy, key, p, r) => { for (let d = 1; d <= r; d++) for (let dy = -d; dy <= d; dy++) for (let dx = -d; dx <= d; dx++) {
                if (Math.max(Math.abs(dx), Math.abs(dy)) !== d) continue; const x = gx + dx, y = gy + dy;
                if (x < 1 || y < 1 || x >= GRID_W - 1 || y >= GRID_H - 1) continue;
                const c = grid[y][x]; if (c.type !== TYPE_FLOOR || c.item || getTileEntityRef(x, y)) continue;
                if (placeBuilding(x, y, key, p, { ignorePlacementRules: true, silent: true })) return getTileEntityRef(x, y) || grid[y][x].item; } return null; };
            const np = players.length, mineNext = new Map(), stats = { mine: 0, build: 0, queue: 0, salvage: 0, research: 0 };
            const byOwner = p => units.filter(u => !u.dead && u.owner === p && u.workerType);
            for (let p = 0; p < np; p++) {
                const ws = byOwner(p), bs = barracks.filter(b => b.owner === p && !b.underConstruction), rs = collectorSpawners.filter(s => s.owner === p && s.type === 'research' && !s.underConstruction);
                let bi = 0, ri = 0, k = 0;
                for (const u of ws) {
                    k++;
                    const gx = Math.floor(u.x / TILE), gy = Math.floor(u.y / TILE);
                    const cfg = _getResourceCollectorConfigForUnit(u);
                    if (cfg) {
                        const mines = _getResourceCollectorMineArray(cfg) || [];
                        let i = mineNext.get(mines) ?? 0;
                        while (i < mines.length && (i % np !== p)) i++;
                        if (i < mines.length) { put(u, mines[i].gx, mines[i].gy); stats.mine++; }
                        mineNext.set(mines, i + 1);
                    } else if (u.workerType === 'builder') {
                        if (k % 2 === 0 && freeNear(gx, gy, 'pistol', p, 4)) stats.build++;
                        u._workerNextIdleRetargetTick = gameTime; u._idleFailVer = -1;
                    } else if (u.workerType === 'healer' && bs.length) {
                        const b = bs[bi++ % bs.length]; put(u, b.gx + 1, b.gy);
                        if (bi <= bs.length) { processAction({ action: 'queueUnit', gx: b.gx, gy: b.gy, count: 5 }, p); stats.queue++; }
                    } else if (u.workerType === 'salvager') {
                        const t = freeNear(gx, gy, 'pistol', p, 4);
                        if (t) { t.markedForSalvage = true; stats.salvage++; }
                        u._workerNextIdleRetargetTick = gameTime; u._idleFailVer = -1;
                    } else if (u.workerType === 'researcher' && rs.length) {
                        const s = rs[ri++ % rs.length]; put(u, s.gx + 1, s.gy); s.autoResearchEnabled = true; stats.research++;
                    }
                }
            }
            __scratch.activeStats = stats;
        })() } catch (e) { __scratch.activeStats = String(e && e.stack || e).slice(0, 400); }`);
        while (host.eval('currentTick') <= at + 2) await world.run(250);
        console.log('active setup at', at, host.eval('JSON.stringify(__scratch.activeStats || null)'));
    }
    // BATTLE=lines|blocks|spiral|mix: the combat units of both teams moved
    // into formations against each other (every peer, same tick):
    //  lines: rows side by side, teams alternating row by row, with rows of
    //    towers and traps between some of them;
    //  blocks: 24x24 groups facing each other 12 tiles apart;
    //  spiral: two interleaved spiral arms, one per team;
    //  mix: the map in quarters (lines, blocks, spiral, groups far apart).
    // Then every unit attack-moves toward the other team's side, and every
    // barrack rallies to the middle.
    // TOWERS=n: n built towers per team (every tower type, lasers in rows),
    // half in two facing bands across the middle of the map, in range of each
    // other (towers engage towers; armies crossing meet them), half spread
    // over the team's own half. Combine with BATTLE= for armies against them.
    if (process.env.TOWERS) {
        const at = world.atNextSafeTick(`try { (() => {
            const per = ${Number(process.env.TOWERS) || 0}, W = GRID_W, H = GRID_H, keys = BUILD_CATEGORIES.towers.filter(k => k !== 'watch_tower');
            let placed = [0, 0], seed = 12345;
            const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
            const place = (gx, gy, key, p) => { if (gx < 2 || gy < 2 || gx >= W - 2 || gy >= H - 2) return false; const c = grid[gy][gx];
                if (c.type !== TYPE_FLOOR || c.item || getTileEntityRef(gx, gy)) return false;
                if (!placeBuilding(gx, gy, key, p, { ignorePlacementRules: true, silent: true })) return false;
                const e = getTileEntityRef(gx, gy) || c.item; if (e && e.underConstruction) { e.underConstruction = false; e.buildProgress = 1; e.energy = e.maxEnergy; }
                placed[p]++; return true; };
            for (let p = 0; p < 2; p++) {
                // The band: rows 3..9 tiles from the middle on the team's side,
                // a tower on every other tile (units pass between); a laser row.
                const dir = p ? 1 : -1, band = Math.floor(per / 2);
                outer: for (let row = 0; row < 7; row++) {
                    const gy = Math.floor(H / 2) + dir * (3 + row);
                    for (let gx = 4 + (row & 1); gx < W - 4; gx += 2) {
                        if (placed[p] >= band) break outer;
                        place(gx, gy, row === 2 ? 'laser' : keys[(gx + row) % keys.length], p);
                    }
                }
                // The rest over the team's half.
                for (let tries = 0; placed[p] < per && tries < per * 20; tries++) {
                    const gx = 4 + Math.floor(rnd() * (W - 8)), gy = p ? Math.floor(H / 2) + 12 + Math.floor(rnd() * (H / 2 - 16)) : 4 + Math.floor(rnd() * (H / 2 - 16));
                    place(gx, gy, keys[Math.floor(rnd() * keys.length)], p);
                }
            }
            if (typeof recalculateLaserConnections === 'function') recalculateLaserConnections();
            recalculateAdjacency(true);
            __scratch.towerStats = { placed, towers: towers.length };
        })() } catch (e) { __scratch.towerStats = String(e && e.stack || e).slice(0, 400); }`);
        while (host.eval('currentTick') <= at + 2) await world.run(250);
        console.log('towers setup at', at, host.eval('JSON.stringify(__scratch.towerStats || null)'));
    }
    if (process.env.BATTLE) {
        const at = world.atNextSafeTick(`try { (() => {
            const mode = ${JSON.stringify(process.env.BATTLE)}, np = players.length;
            const teams = [0, 1].map(p => units.filter(u => !u.dead && u.owner === p && !u.workerType));
            const put = (u, gx, gy) => { if (gx < 1 || gy < 1 || gx >= GRID_W - 1 || gy >= GRID_H - 1) return false; const t = findNearestWalkable(gx, gy);
                u.x = u.prevX = t.x * TILE + 16; u.y = u.prevY = t.y * TILE + 16; updateUnitSpatial(u); return true; };
            const towersKeys = BUILD_CATEGORIES.towers.filter(k => k !== 'watch_tower'), traps = ['lava', 'poison_puddle', 'ice_patch', 'water_puddle', 'sand'];
            let placed = 0;
            const place = (gx, gy, key, p) => { if (gx < 1 || gy < 1 || gx >= GRID_W - 1 || gy >= GRID_H - 1) return; const c = grid[gy][gx];
                if (c.type !== TYPE_FLOOR || c.item || getTileEntityRef(gx, gy)) return;
                if (placeBuilding(gx, gy, key, p, { ignorePlacementRules: true, silent: true })) { placed++; const e = getTileEntityRef(gx, gy) || c.item; if (e && e.underConstruction) { e.underConstruction = false; e.buildProgress = 1; } } };
            const next = [0, 0], take = p => teams[p][next[p]++];
            const W = GRID_W, H = GRID_H;
            const lines = (x0, y0, x1, y1) => {
                for (let row = 0, y = y0; y < y1; row++, y += 2) {
                    const p = row & 1;
                    if (row % 6 === 5) { for (let x = x0; x < x1; x += 3) place(x, y, row % 12 === 5 ? towersKeys[(x / 3 | 0) % towersKeys.length] : traps[(x / 3 | 0) % traps.length], (x & 1)); continue; }
                    for (let x = x0; x < x1; x++) { const u = take(p); if (!u) return; put(u, x, y); }
                }
            };
            const blocks = (x0, y0, x1, y1) => {
                for (let by = y0; by + 60 < y1; by += 64) for (let bx = x0; bx + 24 < x1; bx += 32) for (let p = 0; p < 2; p++)
                    for (let j = 0; j < 24; j++) for (let i = 0; i < 24; i++) { const u = take(p); if (!u) return; put(u, bx + i, by + p * 36 + j); }
            };
            const spiral = (x0, y0, x1, y1) => {
                const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, rmax = Math.min(x1 - x0, y1 - y0) / 2 - 2;
                for (let s = 0; s < 400000; s++) {
                    const a = s * 0.02, r = 2 + a * 1.2; if (r > rmax) break;
                    for (let p = 0; p < 2; p++) { const u = take(p); if (!u) return; put(u, Math.round(cx + Math.cos(a + p * Math.PI) * r), Math.round(cy + Math.sin(a + p * Math.PI) * r)); }
                }
            };
            const far = (x0, y0, x1, y1) => {
                for (let g = 0; g < 16; g++) for (let p = 0; p < 2; p++) { const gx = x0 + 10 + (g % 4) * ((x1 - x0 - 40) / 3 | 0), gy = p ? y1 - 40 : y0 + 10;
                    for (let j = 0; j < 30; j++) for (let i = 0; i < 30; i++) { const u = take(p); if (!u) return; put(u, gx + i, gy + j); } }
            };
            if (mode === 'lines') lines(20, 20, W - 20, H - 20);
            else if (mode === 'blocks') blocks(20, 20, W - 20, H - 20);
            else if (mode === 'spiral') spiral(20, 20, W - 20, H - 20);
            else { lines(20, 20, W / 2 - 10, H / 2 - 10); blocks(W / 2 + 10, 20, W - 20, H / 2 - 10); spiral(20, H / 2 + 10, W / 2 - 10, H - 20); far(W / 2 + 10, H / 2 + 10, W - 20, H - 20); }
            // The rest stay where they are. Everyone placed attack-moves
            // across (team 0 down, team 1 up); the rally points meet in the middle.
            for (let p = 0; p < 2; p++) {
                const ids = teams[p].slice(0, next[p]).map(u => u.id);
                for (let k = 0; k < ids.length; k += 5000) processAction(sanitizeAction({ action: 'attackMove', unitIds: ids.slice(k, k + 5000), targetX: (W / 2) * TILE, targetY: (p ? 0.2 : 0.8) * H * TILE }), p);
                for (const b of barracks) if (b.owner === p) { b.rallyX = W / 2 * TILE; b.rallyY = H / 2 * TILE; }
            }
            __scratch.battleStats = { placed: next, buildings: placed };
        })() } catch (e) { __scratch.battleStats = String(e && e.stack || e).slice(0, 400); }`);
        while (host.eval('currentTick') <= at + 2) await world.run(250);
        console.log('battle setup at', at, host.eval('JSON.stringify(__scratch.battleStats || null)'));
    }
    const { performance: realPerf } = require('node:perf_hooks');
    host.scratch.realNow = () => realPerf.now();
    // KDUMP=file (with EVAL setting __scratch.dumpAt/dumpKernel and the
    // dump hook): a kernel run's inputs, for replaying it alone.
    if (process.env.KDUMP) host.scratch.dump = obj => require('node:fs').writeFileSync(process.env.KDUMP, require('node:v8').serialize(obj));
    // EVAL=<code>: evaluated on the host before the timed run (ad-hoc
    // instrumentation; read results back with AFTER=).
    if (process.env.EVAL) host.eval(process.env.EVAL);
    // PROFILE_TICK=n: CPU profile of that one whole tick (commands included).
    const profileTick = Number(process.env.PROFILE_TICK) || -1;
    // PROFILE_RANGE=a,b: one CPU profile of ticks a..b (steady state).
    const [profA, profB] = (process.env.PROFILE_RANGE || '-1,-1').split(',').map(Number);
    const inspector = require('node:inspector');
    const session = profileTick >= 0 || profA >= 0 ? new inspector.Session() : null;
    if (session) { session.connect(); session.post('Profiler.enable'); session.post('Profiler.setSamplingInterval', { interval: 100 }); }
    host.scratch.profStart = () => session && session.post('Profiler.start');
    host.scratch.profStop = () => session && session.post('Profiler.stop', (err, { profile }) => {
        require('node:fs').writeFileSync(process.env.PROFILE_OUT || require('node:path').join(__dirname, 'tick' + profileTick + '.cpuprofile'), JSON.stringify(profile));
    });
    host.eval(`__scratch.tickMs = []; __scratch.byTick = [];
        { const f = runOneTick; runOneTick = function () {
            const tick = currentTick, prof = tick === ${profileTick} || tick === ${profB};
            if (tick === ${profileTick} || tick === ${profA}) __scratch.profStart();
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
            'processActions', 'updateVisibility', 'resyncAfterTick', 'simMoveRun', 'spatialIndexRebuild', 'runUnitSeparationPass', '_forEachUnitInTickOrder', 'snapRecordTickHash', 'simUnitStateCollect', 'advanceGroupRoutes', '_resolveDeferredPathsByGroup', 'takeDuePendingPathUnits', 'syncVisibilityCoverage', 'sampleGameStats', '_buildDeterministicUnitUpdateOrderForTick', 'recomputePlayerPopCaps',
            'flushPendingMovementAstarSpend', 'flushPendingResourceStatRebuilds', '_runAdjacencyRecalculation', 'updateAudioReactiveState', 'tickStatusEffects', 'destroyBuilding']) {
            const f = eval(name); const w = function () { const a = __scratch.realNow(); try { return f.apply(this, arguments); } finally { rec(name, __scratch.realNow() - a); } }; eval(name + ' = w');
        }
        for (const C of [Barrack]) if (C && C.prototype.update) wrapProto(C, 'update', C.name + 'Update');
        for (const m of ['doMoving', 'doAttackMoving', 'doAttacking', 'doIdle', 'tryDriveByAttack', 'followPath', '_performAttackOnUnit', '_performAttackOnBuilding']) if (Unit.prototype[m]) wrapProto(Unit, m, 'u.' + m);
        for (const name of ['applyUnitSeparation', 'pushUnitOutOfBlockedTile', 'updateWorkerAI', 'updateUnitSpatial', 'recordDamageVisual', 'applyStatusEffect', 'createExplosion', 'pushHostileDamageAlert', '_findClosestEnemyUnitByChunks', '_findAutoStructureTarget', '_tryUpgradeAstarFallbackPath']) {
            let f; try { f = eval(name); } catch { continue; } if (typeof f !== 'function') continue;
            const w = function () { const a = __scratch.realNow(); try { return f.apply(this, arguments); } finally { rec('f.' + name, __scratch.realNow() - a); } }; eval(name + ' = w');
        }`);
    // TOPPHASES=1: wall time of the top-level parts of a tick only (no per-unit wrappers).
    if (process.env.TOPPHASES) host.eval(`__scratch.ph = {};
        const rec = (name, ms) => { const r = (__scratch.ph[currentTick] ||= {}); r[name] = (r[name] || 0) + ms; };
        for (const name of ['updateAllPlayerVisibility', 'recalculateUnitEffectiveStats', 'recalculateThingPrecomputedStats', 'processGlobalSpawnerQueue',
            'processActions', 'resyncAfterTick', 'simMoveRun', 'spatialIndexRebuild', 'runUnitSeparationPass', '_forEachUnitInTickOrder', 'simUnitStateCollect',
            'advanceGroupRoutes', '_resolveDeferredPathsByGroup', 'takeDuePendingPathUnits', 'syncVisibilityCoverage', 'flushPendingMovementAstarSpend',
            'recomputePlayerPopCaps', '_runAdjacencyRecalculation', 'sampleGameStats', 'gameTick', 'simMoveEndTick',
            'visCoverHoldEnd', 'unitHitsResolve', 'statusPrepassRun', 'runQueuedOrders', 'navTick', 'navFieldsFlush', 'compactRemovedUnits',
            'updateVisibility', 'flushPendingResourceStatRebuilds', 'ensureLaserConnections', 'processActions', 'gameStatsStep', 'projectilesBegin',
            '_buildDeterministicBuildingUpdateOrderForTick', 'healerCandidatesStep', 'tickStatusEffects', 'getCellItemsRowMajor', 'updateAudioReactiveState', '_finalizePathfindPerfTick',
            ...${JSON.stringify((process.env.SUBPHASES || '').split(',').filter(Boolean))}]) {
            let f; try { f = eval(name); } catch { continue; } if (typeof f !== 'function') continue;
            const w = function () { const a = __scratch.realNow(); try { return f.apply(this, arguments); } finally { rec(name, __scratch.realNow() - a); } }; eval(name + ' = w');
        }
        { const T = Tower.prototype.update, B = Barrack.prototype.update, PR = Projectile.prototype.update;
          let tt = 0; Tower.prototype.update = function () { const a = __scratch.realNow(); try { return T.apply(this, arguments); } finally { rec('towers', __scratch.realNow() - a); } };
          Barrack.prototype.update = function () { const a = __scratch.realNow(); try { return B.apply(this, arguments); } finally { rec('barracks', __scratch.realNow() - a); } };
          for (const C of [CollectorSpawner, AstarSpawner, SalvagerSpawner, BuilderSpawner, HealerSpawner, ResearchSpawner]) { const U = C.prototype.update; if (C.prototype.hasOwnProperty('update')) C.prototype.update = function () { const a = __scratch.realNow(); try { return U.apply(this, arguments); } finally { rec('spawners', __scratch.realNow() - a); } }; }
          Projectile.prototype.update = function () { const a = __scratch.realNow(); try { return PR.apply(this, arguments); } finally { rec('projectiles', __scratch.realNow() - a); } }; }`);
    // DUMPSEP=n: the collision pass's kernel inputs at tick n, written to DUMPSEP_OUT (for kernel benchmarks).
    if (process.env.DUMPSEP) host.eval(`{ const f = SIM_KERNELS[SIM_KERNEL_SEPARATION]; let done = false;
        SIM_KERNELS[SIM_KERNEL_SEPARATION] = function (R, P, chunk) {
            if (!done && currentTick === ${Number(process.env.DUMPSEP)}) { done = true; const out = { P: Array.from(P), arrays: {} };
                for (const k in R) if (k.startsWith('sep.') && R[k] && R[k].length !== undefined) out.arrays[k] = [R[k].constructor.name, Array.from(R[k])];
                __scratch.sepDump = JSON.stringify(out); }
            return f.apply(this, arguments); }; }`);
    // SLOTMAP=1: count slot map rebuilds.
    if (process.env.SLOTMAP) host.eval(`__scratch.smr = 0; { const f = _unitSlotMapEnsure; _unitSlotMapEnsure = function () { if (!(_unitSlotMap.ref === units && _unitSlotMap.len === units.length)) __scratch.smr++; return f.apply(this, arguments); }; }`);
    // LOOPCOST=1: time the update-pass walk alone (no-op per unit) after each tick.
    if (process.env.LOOPCOST) host.eval(`__scratch.lc = []; { const f = runOneTick; runOneTick = function () { const r = f.apply(this, arguments);
        const S = _simUnitState; S.columns.mvOut.fill(1, 0, S.owners.length); let n = 0; const a = __scratch.realNow(); _forEachUnitInTickOrder(u => { n++; }); const b = __scratch.realNow();
        S.columns.mvOut.fill(0, 0, S.owners.length); const c = __scratch.realNow(); let m = 0; _forEachUnitInTickOrder(u => { m++; }); const d = __scratch.realNow();
        __scratch.lc.push([currentTick, Math.round((b - a) * 10) / 10, n, Math.round((d - c) * 10) / 10, m]); return r; }; }`);
    // UPDSPLIT=1: Unit.update time and count by kind (worker state / command).
    if (process.env.UPDSPLIT) host.eval(`__scratch.us = {}; { const f = Unit.prototype.update; Unit.prototype.update = function () {
        if (this._us && this._us.mvOut[this._si]) return f.call(this);
        let k = this.workerState ? 'w:' + this.workerState + (this.workerState === 'IDLE' ? ':' + this.workerType : '') : 'c' + this.commandState;
        // (Attacking: a building target, a unit in range (its attack tick), or a chase.)
        if (!this.workerState && this.commandState === CMD_ATTACKING) k += this.targetBuilding ? ':bld' : this.attackTarget === this.targetUnit && this.targetUnit ? ':inrange' : ':chase';
        const a = __scratch.realNow();
        try { return f.call(this); } finally { if (currentTick >= 48) { const e = (__scratch.us[k] ||= [0, 0]); e[0] += __scratch.realNow() - a; e[1]++; } } }; }`);
    // WMOVESTAT=1: workers in a moving state that ran Unit.update, by why:
    // their path done, an A* path, a nav node (on its check tick or not,
    // with its mvOn before the kernel ran); ms and calls per tick.
    if (process.env.WMOVESTAT) host.eval(`__scratch.wm = {}; { let pre = null; const fr = simMoveRun; simMoveRun = function () { const S = _simUnitState; pre = S.columns.mvOn.slice(0, S.owners.length); return fr.apply(this, arguments); };
        const MV = new Set(['MANUAL_MOVE', 'MOVING_TO', 'MOVING_TO_ASTAR', 'RETURNING', 'RETURNING_ASTAR', 'MOVING_TO_BUILD', 'RETURNING_FOR_GOLD', 'MOVING_TO_HEAL', 'MOVING_TO_RESEARCH']);
        const f = Unit.prototype.update; Unit.prototype.update = function () {
            const c = this._us, s = this._si; if (!c || c.mvOut[s] || !MV.has(this.workerState)) return f.call(this);
            const chk = ((gameTime + this.id) | 0) % WORKER_MOVE_CHECK_TICKS === 0, p = this.path, i = this.pathIndex;
            const k = this.workerState + ':' + (this.holdPosition ? 'hold' : !p || i >= p.length ? 'pathDone' + (this._pendingPathTarget ? ':pending' : '') + (this.workerTransferCooldown > 0 ? ':cd' : '') + (this.workerTarget ? (_isWorkerWithinTileInteractionRange(this, this.workerTarget, 1) ? ':inRange' : ':far') : ':noTarget') + (typeof _workerHasPendingAutoRouteToTarget === 'function' && _workerHasPendingAutoRouteToTarget(this) ? ':autoRoute' : '') + ':on' + this._us.mvOn[s] + ':cmd' + this.commandState : p[i].nav ? 'nav:' + (chk ? 'check' : 'pre' + (pre ? pre[s] : '-')) : 'astar' + (chk ? ':check' : ''));
            const a = __scratch.realNow();
            try { return f.call(this); } finally { if (currentTick >= 48) { const e = (__scratch.wm[k] ||= [0, 0]); e[0] += __scratch.realNow() - a; e[1]++; } } }; }`);
    // CHASESTAT=1: chasing units that ran Unit.update, by the first unmet
    // condition of simMoveTryChase (all met: the kernel handed it back).
    if (process.env.CHASESTAT) host.eval(`__scratch.chase = {}; { const f = Unit.prototype.update; Unit.prototype.update = function () {
        if (!(this._us && !this._us.mvOut[this._si] && !this.workerState && this.commandState === CMD_ATTACKING && !this.targetBuilding && this.targetUnit && this.attackTarget !== this.targetUnit)) return f.call(this);
        const tu = this.targetUnit, k = Math.floor(Math.max(0, Number(_getUnitAttackRangeArea(this)) || 0));
        const why = this.holdPosition ? 'hold' : tu.dead ? 'tdead' : this.forcedAttackTarget ? 'forced' : (this.path && this.pathIndex < this.path.length) ? 'path' : !(this.preComputed.attackDamage > 0) ? 'nodmg' : k > 1 ? 'range' + Math.min(k, 9) : 'handback';
        __scratch.chase[why] = (__scratch.chase[why] || 0) + 1; return f.call(this); }; }`);
    // ORDERSPLIT=1: time of the move-order handler and its callees in the order tick.
    if (process.env.ORDERSPLIT) host.eval(`__scratch.os = {};
        for (const name of ['_issueGroupMoveOrder', '_findPathForUnitTagged', 'routeGroupMembers', 'findNearestWalkable', 'interruptWorkerForManualMove', '_makeFallbackPathForUnit', 'getPathRegions', '_actionUnits', '_canUsePathfindRequestBudget', '_consumePathfindRequestBudget', 'getPathCanWalkForUnit', '_pathStartInRegion']) {
            let f; try { f = eval(name); } catch { continue; }
            const w = function () { const a = __scratch.realNow(); try { return f.apply(this, arguments); } finally { const e = (__scratch.os[name] ||= [0, 0]); e[0] += __scratch.realNow() - a; e[1]++; } }; eval(name + ' = w');
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
    // ARMSTAT=1: per tick, units moved by the movement kernel and why the rest were not armed.
    if (process.env.ARMSTAT) host.eval(`__scratch.arm = []; { const dbg = new Int32Array(64); simParallelBind('mv.dbg', dbg); __scratch.dbg = dbg; const f = simMoveEndTick; simMoveEndTick = function () { const S = _simUnitState; let h = [0,0,0,0], on = 0;
        for (let s = 0; s < S.owners.length; s++) { h[S.columns.mvOut[s]]++; if (S.columns.mvOn[s]) on++; }
        let why = {}; if (currentTick % 10 === 0) for (const u of units) { if (u.dead || S.columns.mvOut[u._si]) continue; const k = u.workerState ? 'worker' : u.commandState !== CMD_MOVING && u.commandState !== CMD_ATTACK_MOVING ? 'cmd' + u.commandState : !u.path || u.pathIndex >= u.path.length ? 'nopath:c' + u.commandState + (u._pendingPathTarget ? ':pend' : '') + (u._awaitGroupPath > gameTime ? ':await' : '') + (u._routeKey ? ':rk' : '') + (u.pathIsFallbackAstar ? ':fb' : '') + ':on' + S.columns.mvOn[u._si] : u.attackTimer > 0 || u.attackFlash > 0 ? 'atk' : S.columns.mvOn[u._si] ? 'armedNotRun' : 'other'; why[k] = (why[k] || 0) + 1; }
        __scratch.arm.push([currentTick, h, on, why, Object.fromEntries(Array.from(__scratch.dbg).map((v,i)=>[i,v]).filter(e=>e[1]))]); __scratch.dbg.fill(0); return f.apply(this, arguments); }; }`);
    // HOLDSTAT=1: attacking units not held by the kernel (mvOn 3), by the first failed condition of simMoveTryHold.
    if (process.env.HOLDSTAT) host.eval(`__scratch.hold = {}; { const f = simMoveEndTick; simMoveEndTick = function () { if (currentTick % 10 === 0) { const S = _simUnitState, H = __scratch.hold;
        for (const u of units) { if (u.dead || u.commandState !== CMD_ATTACKING) continue; const on = S.columns.mvOn[u._si]; const tu = u.targetUnit;
            const k = on === 3 ? 'held' : on === 5 ? 'heldBld' : u.workerState ? 'worker' : u.holdPosition ? 'holdPos' : u.targetBuilding ? 'building' : !tu || tu.dead ? 'noTarget' : u.forcedAttackTarget ? 'forced' : u.attackTarget !== tu ? 'atkTargetDiff' : !(u.attackTimer > 1) ? 'timer' + Math.min(2, Math.max(0, Math.floor(u.attackTimer))) : (u.burning > 0 || u.poisoned > 0 || u.frozen > 0 || u.wet > 0 || u.sandy > 0 || u.watched > 0 || u.teleportHideTicks > 0) ? 'status' : !isWorldTargetWithinAreaRange(u.x, u.y, tu.x, tu.y, Math.floor(Math.max(0, Number(_getUnitAttackRangeArea(u)) || 0))) ? 'range' : 'other:on' + on;
            H[k] = (H[k] || 0) + 1; }
        for (const u of units) { if (u.dead || u.workerState !== 'IDLE') continue; const on = S.columns.mvOn[u._si];
            const nx = u._workerNextIdleRetargetTick;
            const k = 'park:' + u.workerType + ':' + (on === 2 ? 'parked' : u.commandState !== CMD_IDLE ? 'cmd' + u.commandState : u.holdPosition ? 'holdPos' : u.workerTransferCooldown > 0 ? 'cooldown' : (u.burning > 0 || u.poisoned > 0 || u.frozen > 0 || u.wet > 0 || u.sandy > 0 || u.watched > 0 || u.teleportHideTicks > 0) ? 'status' : (u.attackTimer > 0 || u.attackFlash > 0) ? 'atk' : !Number.isFinite(nx) ? 'noNext' : nx <= gameTime + 1 ? 'nextDue' : 'other:on' + on);
            H[k] = (H[k] || 0) + 1; } } return f.apply(this, arguments); }; }`);
    // WAKESTAT=1: idle workers that ran Unit.update, by why they were not
    // parked through the tick: 'unparked:<reason>' (their last update did not
    // park them: the first unmet condition of simMoveTryPark), 'disarmed'
    // (parked after their last update, unarmed before the kernel ran: a
    // hook, e.g. a push into another tile), 'woke:<why>' (the kernel woke
    // them: wake tick reached with or without the version check, watchdog,
    // floor); ms and calls per tick, and how many searched (retarget ran).
    if (process.env.WAKESTAT) host.eval(`__scratch.wk = {}; { const S0 = () => _simUnitState; let pre = null, post = null, wakeAt = null, endParked = new Int8Array(0), endWhy = [];
        const fr = simMoveRun; simMoveRun = function () { const S = S0(), n = S.owners.length; pre = S.columns.mvOn.slice(0, n); wakeAt = S.columns.mvWake.slice(0, n); const fl = S.columns.mvFlags.slice(0, n);
            try { return fr.apply(this, arguments); } finally { post = S.columns.mvOn.slice(0, n); __scratch.wkFl = fl; } };
        const why = u => { const c = u._us, s = u._si; if (c.mvOn[s] === 2) return 'parked'; if (u.commandState !== CMD_IDLE) return 'cmd' + u.commandState; if (u.holdPosition) return 'holdPos'; if (u.workerTransferCooldown > 0) return 'cooldown';
            if (u._spatialEpoch !== spatialEpoch) return 'epoch'; const nx = u._workerNextIdleRetargetTick; if (!Number.isFinite(nx)) return 'noNext'; if (nx <= gameTime + 1) return 'nextDue'; return 'wakeSoon'; };
        const f = Unit.prototype.update; Unit.prototype.update = function () {
            const c = this._us, s = this._si; if (!c || c.mvOut[s] || this.workerState !== 'IDLE') return f.call(this);
            let k; const t = this.workerType;
            if (pre && pre[s] === 2 && post[s] === 0) { const fl = __scratch.wkFl[s]; k = 'woke:' + (gameTime >= wakeAt[s] ? ((fl & 2) ? 'wakeVer:' + (gameTime >= c.wkSched[s] ? 'sched:' + (c.wkSched[s] === this._workerNextIdleRetargetTick ? 'next' : c.wkSched[s] === this._builderNextRecheckTick ? 'recheck' : 'other') : gameTime >= c.wkUntil[s] ? 'until' : (Math.floor(c.y[s] / TILE) * GRID_W + Math.floor(c.x[s] / TILE)) !== c.wkTile[s] ? 'moved' : _workerWorkVerOf(this) !== c.wkFail[s] ? 'ver' : 'other') : 'wakeNoVer') : (fl & 4) ? 'watch' : 'floor'); }
            else if (pre && pre[s] === 0) k = endParked[s] === 1 ? 'disarmed' : 'unparked:' + (endWhy[s] || '?');
            else k = 'other' + (pre ? pre[s] : '-');
            const a = __scratch.realNow(); const r0 = globalThis.__wkSearch | 0;
            try { return f.call(this); } finally { const ms = __scratch.realNow() - a;
                if (currentTick >= 48) { const e = (__scratch.wk[t + ':' + k] ||= [0, 0]); e[0] += ms; e[1]++; }
                if (endParked.length < c.mvOn.length) { const a2 = new Int8Array(c.mvOn.length * 2); a2.set(endParked); endParked = a2; }
                const w = why(this); endParked[s] = w === 'parked' ? 1 : 0; endWhy[s] = w; } }; }`);
    // AMSTAT=1: combat units (not workers) that ran Unit.update, by command,
    // armed state before the kernel (pre mvOn), the combat scan's answer
    // (cb: enemy found / none / not scanned), structure tick, and the command
    // after the update (->state); ms and calls per tick.
    if (process.env.AMSTAT) host.eval(`__scratch.am = {}; { let pre = null;
        const fr = simMoveRun; simMoveRun = function () { const S = _simUnitState; pre = S.columns.mvOn.slice(0, S.owners.length); return fr.apply(this, arguments); };
        const f = Unit.prototype.update; Unit.prototype.update = function () {
            const c = this._us, s = this._si; if (!c || c.mvOut[s] || this.workerState) return f.call(this);
            const cmd = this.commandState; if (cmd !== CMD_ATTACK_MOVING && cmd !== CMD_IDLE) return f.call(this);
            const cb = c.cbTick[s] !== gameTime ? 'cbNo' : c.cbT[s] >= 0 ? 'cbHit' : 'cbNone';
            const st = ((gameTime + this.id) & 3) === 0 ? 'st' : '';
            const pend = (!this.path || this.pathIndex >= this.path.length) ? (this._pendingPathTarget ? 'pend' : 'nopath') : 'path';
            const a = __scratch.realNow();
            try { return f.call(this); } finally { const ms = __scratch.realNow() - a; if (currentTick >= 48) {
                const k = 'c' + cmd + ':on' + (pre ? pre[s] : '-') + ':' + cb + ':' + pend + (st ? ':st' : '') + '->' + this.commandState + (this.targetBuilding ? 'b' : '');
                const e = (__scratch.am[k] ||= [0, 0]); e[0] += ms; e[1]++; } } }; }`);
    // KTIME=1: wall time per kernel per tick (ms, averaged over the run).
    if (process.env.KTIME) host.eval(`__scratch.kt = {}; { const f = simParallelRun; simParallelRun = function (k, total) { const a = __scratch.realNow(); try { return f.apply(this, arguments); } finally { __scratch.kt[k] = (__scratch.kt[k] || 0) + __scratch.realNow() - a; } }; }`);
    // KSHARE=1: per kernel, the share of chunks the main thread ran itself; binds per tick (by name).
    if (process.env.KSHARE) host.eval(`__scratch.ks = {}; __scratch.kb = {}; __scratch.kbt = {};
        for (const k in SIM_KERNELS) { const f = SIM_KERNELS[k]; SIM_KERNELS[k] = function () { const e = (__scratch.ks[k] ||= [0, 0]); e[0]++; return f.apply(this, arguments); }; }
        { const f = simParallelRun; simParallelRun = function (k, total) { const e = (__scratch.ks[k] ||= [0, 0]); e[1] += total; return f.apply(this, arguments); }; }
        { const f = simParallelBind; simParallelBind = function (name, arr) { if (_simParReg[name] !== arr) { __scratch.kb[name] = (__scratch.kb[name] || 0) + 1; __scratch.kbt[currentTick] = 1; } return f.apply(this, arguments); }; }`);
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
    // REORDER=1: the same orders again after the run's first part (a second order's cost).
    if (process.env.REORDER) {
        await world.run(seconds * 500);
        for (const g of peers) g.eval(`(() => {
            const mine = units.filter(u => !u.dead && u.owner === localPlayerId && !u.workerType);
            for (let i = 0; i < 10; i++) queueAction({ action: 'move', unitIds: mine.filter((u, k) => k % 10 === i).map(u => u.id),
                targetX: (0.85 - 0.7 * ((i * 7) % 10) / 9) * GRID_W * TILE, targetY: (0.85 - 0.7 * ((i * 3) % 10) / 9) * GRID_H * TILE });
        })()`);
        await world.run(seconds * 500);
    } else
    await world.run(seconds * 1000);
    const ms = host.eval('JSON.stringify(__scratch.tickMs)');
    const a = JSON.parse(ms).sort((x, y) => x - y);
    const mean = a.reduce((s, v) => s + v, 0) / a.length;
    const r = v => Math.round(v * 100) / 100;
    // AFTER=<expression>: evaluated on the host after the run (between
    // ticks, the world as it is); its result printed first (micro timings).
    if (process.env.AFTER) console.log('AFTER', host.eval(process.env.AFTER));
    console.log(JSON.stringify({ ticks: a.length, units: host.eval('units.length'), meanMs: r(mean), p50: r(a[a.length >> 1]), p95: r(a[Math.floor(a.length * .95)]), max: r(a[a.length - 1]),
        wallS: r((Date.now() - t0) / 1000), tick: host.eval('currentTick'), hashAtTick: host.eval('__scratch.hashAt'),
        pathStats: process.env.PATHSTATS ? JSON.parse(host.eval('JSON.stringify(__scratch.ps)')) : undefined,
        phases: process.env.PHASES || process.env.TOPPHASES ? JSON.parse(host.eval('JSON.stringify(__scratch.ph)')) : undefined,
        crowd: process.env.CROWD_AT ? JSON.parse(host.eval('JSON.stringify(__scratch.crowd)')) : undefined,
        colStats: process.env.COLSTATS ? JSON.parse(host.eval('JSON.stringify(__scratch.colStats)')) : undefined,
        fieldKinds: process.env.FIELDKINDS ? JSON.parse(host.eval(`JSON.stringify((() => { const a = __scratch.kA, b = __scratch.kB, out = {};
            for (const f in b) { const before = a[f] ? [...a[f]] : []; const added = [...b[f]].filter(t => !before.includes(t)); if (added.length) out[f] = before.join('') + ' -> +' + added.join(','); } return out; })())`)) : undefined,
        churn: process.env.FIELDCHURN ? JSON.parse(host.eval('JSON.stringify(Object.fromEntries(Object.entries(__scratch.churn).sort((a,b)=>b[1]-a[1]).map(([k,v])=>[k, Math.round(1e4*v/__scratch.churnSamples)/100])))')) : undefined,
        unitFieldCount: process.env.FIELDCHURN ? host.eval('Object.keys(units[0]).length') : undefined,
        listChurn: process.env.LISTCHURN ? JSON.parse(host.eval(`JSON.stringify((() => { const { churn, counts } = __scratch.lchurn; const out = {};
            for (const l in churn) out[l] = { n: counts[l], fields: Object.fromEntries(Object.entries(churn[l]).sort((a, b) => b[1] - a[1]).slice(0, 30).map(([k, v]) => [k, Math.round(1e4 * v / counts[l]) / 100])) }; return out; })())`)) : undefined,
        arm: process.env.ARMSTAT ? JSON.parse(host.eval('JSON.stringify(__scratch.arm.filter(a => a[0] % 10 === 0))')) : undefined,
        ktime: process.env.KTIME ? JSON.parse(host.eval('JSON.stringify(Object.fromEntries(Object.entries(__scratch.kt).map(([k,v])=>[k, Math.round(v / __scratch.tickMs.length * 10) / 10])))')) : undefined,
        states: process.env.STATES ? JSON.parse(host.eval('JSON.stringify(units.reduce((m, u) => { const k = (u.workerType || "combat") + ":" + (u.workerState || u.commandState); m[k] = (m[k] || 0) + 1; return m; }, {}))')) : undefined,
        buildings: process.env.STATES ? host.eval('towers.length + "/" + barracks.length + "/" + collectorSpawners.length + "/" + getCellItemsRowMajor().length') : undefined,
        desyncs: guests.map(g => g.eval('netCounters.desyncsDetected')), patches: guests.map(g => g.patchesApplied),
        kshare: process.env.KSHARE ? JSON.parse(host.eval('JSON.stringify({ share: __scratch.ks, binds: __scratch.kb, bindTicks: Object.keys(__scratch.kbt).length })')) : undefined,
        slotMapRebuilds:process.env.SLOTMAP ? host.eval('__scratch.smr') : undefined,
        loopCost: process.env.LOOPCOST ? JSON.parse(host.eval('JSON.stringify(__scratch.lc.filter(a => a[0] % 10 === 0))')) : undefined,
        chaseStat: process.env.CHASESTAT ? JSON.parse(host.eval('JSON.stringify(__scratch.chase)')) : undefined,
        holdStat: process.env.HOLDSTAT ? JSON.parse(host.eval('JSON.stringify(__scratch.hold)')) : undefined,
        amStat: process.env.AMSTAT ? JSON.parse(host.eval('(() => { const n = Math.max(1, __scratch.tickMs.length - 48); return JSON.stringify(Object.fromEntries(Object.entries(__scratch.am).sort((a,b)=>b[1][0]-a[1][0]).slice(0, 40).map(([k,v])=>[k,[Math.round(v[0]/n*10)/10, Math.round(v[1]/n)]]))); })()')) : undefined,
        wmoveStat: process.env.WMOVESTAT ? JSON.parse(host.eval('(() => { const n = Math.max(1, __scratch.tickMs.length - 48); return JSON.stringify(Object.fromEntries(Object.entries(__scratch.wm).sort((a,b)=>b[1][0]-a[1][0]).map(([k,v])=>[k,[Math.round(v[0]/n*10)/10, Math.round(v[1]/n)]]))); })()')) : undefined,
        wakeStat: process.env.WAKESTAT ? JSON.parse(host.eval('(() => { const n = Math.max(1, __scratch.tickMs.length - 48); return JSON.stringify(Object.fromEntries(Object.entries(__scratch.wk).sort((a,b)=>b[1][0]-a[1][0]).map(([k,v])=>[k,[Math.round(v[0]/n*10)/10, Math.round(v[1]/n)]]))); })()')) : undefined,
        updSplit: process.env.UPDSPLIT ? JSON.parse(host.eval('(() => { const n = Math.max(1, __scratch.tickMs.length - 48); return JSON.stringify(Object.fromEntries(Object.entries(__scratch.us).sort((a,b)=>b[1][0]-a[1][0]).map(([k,v])=>[k,[Math.round(v[0]/n*10)/10, Math.round(v[1]/n)]]))); })()')) : undefined,
        orderSplit: process.env.ORDERSPLIT ? JSON.parse(host.eval('JSON.stringify(Object.fromEntries(Object.entries(__scratch.os).map(([k,v])=>[k,[Math.round(v[0]),v[1]]])))')) : undefined,
                fastProps: process.env.FASTPROPS ? [host, ...guests].map(p => p.eval('(() => { let fast = 0, slow = 0; for (const u of units) { if (%HasFastProperties(u)) fast++; else slow++; } return fast + "/" + slow + " cols:" + %HasFastProperties(_simUnitState.columns); })()')) : undefined,
        stuck: process.env.ARMSTAT ? JSON.parse(host.eval(`JSON.stringify(units.filter(u => !u.dead && !u.workerType && u.commandState === CMD_MOVING && (!u.path || u.pathIndex >= u.path.length) && u._routeKey && !u._us.mvOn[u._si]).slice(0, 6).map(u => { const r = _groupRoutes.get(u._routeKey); const t = Math.floor(u.y / TILE) * GRID_W + Math.floor(u.x / TILE); return { id: u.id, rk: u._routeKey, seg: u._routeSegEnd, end: u._routeEnd, t, g: r ? r.g[t] : 'noroute', fl: r ? r.flags[t] : null, fid: r && r.fid, pend: !!u._pendingPathTarget, hold: u.holdPosition, path: u.path && u.path.length, pi: u.pathIndex, spd: u.preComputed.speed, fr: u.frozen, at: u.attackTimer }; }))`)) : undefined,
        heaviest: JSON.parse(host.eval('JSON.stringify(__scratch.byTick.slice().sort((a, b) => b[1] - a[1]).slice(0, 8))')) }));
    if (process.env.DUMPSEP) require('node:fs').writeFileSync(process.env.DUMPSEP_OUT, host.scratch.sepDump || '{}');
    process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
