// With the simulation worker, the page sees the world through each tick's
// frame (src/sim/sim_frame.js: units; src/sim/sim_frame_world.js: the rest).
// After every result (one tick in flight, so the
// worker is exactly at that tick) the page's unit views read what the
// worker's units hold, and its structures, items, players and grid hash as
// the worker's, through spawning, movement, combat, deaths, building and
// worker activity. Selected units carry their details (paths, stats).
const assert = require('node:assert/strict');
const H = require('./net-harness.cjs');

const TICKS = Number(process.env.SIM_FRAME_TICKS) || 400;

// Units by id: what a view reads, as the worker has it.
const UNIT_FIELDS = `(u => [u.id, Math.fround(u.x), Math.fround(u.y), u.owner, u.unitType, Math.fround(u.energy), u.workerType || null, u.workerState || null,
    u.effectiveLevel, u.commandState | 0, !!u.isFlying, !!u.isSnake, !!u.holdPosition, u.attackStyle || null, Math.fround(u.r)])`;
const UNITS = `JSON.stringify(units.filter(u => !u.dead).map(${UNIT_FIELDS}).sort((a, b) => a[0] - b[0]))`;
// Everything but units: structures (what their views carry), players,
// projectiles and the grid.
const OTHERS = `(() => { const out = {};
    const S = e => [e.gx, e.gy, e.type || null, e.unitType || null, e.owner, Math.fround(Number(e.energy) || 0), e.level ?? null, e.effectiveLevel ?? null,
        !!e.underConstruction, !!e.isUpgrading, !!e.markedForSalvage, Array.isArray(e.spawnQueue) ? e.spawnQueue.length : 0, Math.fround(Number(e.spawnTimer) || 0),
        e.gold ?? null, e.astar ?? null, e.value ?? null, Array.isArray(e.connectedLasers) ? e.connectedLasers.length : 0, e._structView ? e._labelText() : getLevelLabelText(e)];
    for (const [name, list] of [['t', towers], ['b', barracks], ['s', collectorSpawners], ['g', goldMines], ['a', astarMines], ['d', droppedItems]]) out[name] = JSON.stringify(list.map(S));
    out.f = JSON.stringify(getCellItemsRowMajor().filter(e => !(e instanceof Tower) && !(e instanceof Barrack) && !isSpawnerEntity(e)).map(S));
    out.P = JSON.stringify(players.map(p => [p.energy, p.astar, p.popCount, JSON.stringify(p.researchLevels), (p.researchQueue || []).length]));
    out.p = JSON.stringify(projectiles.map(p => [Math.fround(p.x), Math.fround(p.y), p.type]));
    let g = 0; for (const row of grid) for (const c of row) g = Math.imul(g ^ (String(c.type).length * 131 + (typeof c.type === 'number' ? c.type : 0) * 31 + c.owner + 7), 16777619);
    out.grid = g >>> 0;
    out.globals = JSON.stringify([gameTime, !!gameOver, winner, [...resignedTeams]]);
    return JSON.stringify(out); })()`;

(async () => {
    const controls = { ...H.SMALL_MATCH_CONTROLS, 'cfg-mapsize': '40', 'cfg-map-type': 'arena', 'cfg-max-pop': '5000',
        'cfg-starting-energy': '100000000', 'cfg-starting-astar': '100000000', 'cfg-full-vis': 'team' };
    const world = new H.World({ controls });
    world.simWorker = true;
    const spawnCounts = {
        'unit:norm': { 1: 60, 3: 20 }, 'unit:snake': { 2: 20 }, 'unit:water_resistant': { 1: 40 }, 'unit:ice_resistant': { 1: 40 },
        'unit:builder_unit': { 1: 20 }, 'unit:collector': { 1: 20 }, 'unit:healer_unit': { 1: 6 }, 'unit:flying': { 1: 10 },
        'building:pistol': { 1: 6 }, 'building:fire': { 2: 3 }, 'building:barrack_norm': { 1: 2 }, 'building:house': { 3: 2 },
        'building:builder_spawner': { 1: 1 }, 'building:lava': { 1: 4 }
    };
    const P = world.spawn('page', { controls });
    // One tick in flight: each result leaves the worker at that tick.
    P.eval(`startingResourcesConfig = ${JSON.stringify({ spawnCounts, researchLevels: {} })}; simClientInFlight = () => _simClient && _simClient.inFlight ? 99 : 0; startSoloGame();`);
    await world.run(1500);
    assert.equal(P.eval('simClientActive()'), true, 'the match runs in the worker');
    const W = P.simWorker;

    let checked = 0, unitsSeen = 0, failure = null;
    P.scratch.check = tick => {
        if (failure) return;
        try {
            const pu = P.eval(UNITS), wu = W.eval(UNITS);
            if (pu !== wu) {
                const a = JSON.parse(pu), b = JSON.parse(wu), byId = new Map(b.map(r => [r[0], r]));
                const diffs = [];
                for (const r of a) { const w = byId.get(r[0]); if (!w) diffs.push('page-only u' + r[0]); else if (JSON.stringify(r) !== JSON.stringify(w)) diffs.push(JSON.stringify(r) + ' vs ' + JSON.stringify(w)); }
                if (a.length !== b.length) diffs.push(`count ${a.length} vs ${b.length}`);
                failure = `tick ${tick}: units differ: ${diffs.slice(0, 6).join(' | ')}`;
                return;
            }
            const po = JSON.parse(P.eval(OTHERS)), wo = JSON.parse(W.eval(OTHERS));
            const keys = [...new Set([...Object.keys(po), ...Object.keys(wo)])].filter(k => po[k] !== wo[k]);
            if (keys.length) { failure = `tick ${tick}: page differs from the worker in ${keys.slice(0, 8).join(', ')}: ` + keys.slice(0, 2).map(k => String(po[k]).slice(0, 300) + ' vs ' + String(wo[k]).slice(0, 300)).join(' ;; '); return; }
            unitsSeen = Math.max(unitsSeen, JSON.parse(pu).length);
            checked++;
        } catch (err) { failure = `tick ${tick}: ${err && err.stack || err}`; }
    };
    P.eval(`(() => { const hook = simClientTickAppliedHook; simClientTickAppliedHook = function (tick) { if (hook) hook.apply(this, arguments); __scratch.check(tick); }; })()`);

    // Orders during the run: moves, attack-moves into the enemy, production,
    // placements; a selection (its details: paths and stats).
    const orders = [
        `(() => { const mine = units.filter(u => !u.dead && u.owner === 0 && !u.workerType); queueAction({ action: 'attackMove', unitIds: mine.map(u => u.id), targetX: GRID_W * TILE * .8, targetY: GRID_H * TILE * .5 }); selectedUnits = mine.slice(0, 12); })()`,
        `(() => { const b = barracks.find(b => b.owner === 0); if (b) queueAction({ action: 'queueUnit', gx: b.gx, gy: b.gy, count: 10 }); })()`,
        `(() => { const mine = units.filter(u => !u.dead && u.owner === 0 && u.unitType === 'water_resistant'); [[.2,.2],[.5,.8],[.8,.3]].forEach(([fx, fy], i) => queueAction({ action: 'move', unitIds: mine.filter((u, k) => k % 3 === i).map(u => u.id), targetX: fx * GRID_W * TILE, targetY: fy * GRID_H * TILE })); })()`,
        `(() => { for (let i = 0; i < 4; i++) queueAction({ action: 'place', gx: 3 + i, gy: 3, itemType: 'smg', count: 1, autoUpgradeEnabled: true, buildEnabled: true }); })()`
    ];
    let issued = 0, detailed = false;
    const start = P.eval('currentTick');
    while (P.eval('currentTick') < start + TICKS && !failure) {
        if (issued < orders.length && P.eval('currentTick') > start + 20 + issued * 60) P.eval(orders[issued++]);
        await world.run(50);
        if (!detailed && issued > 0) {
            detailed = P.eval(`selectedUnits.length > 0 && selectedUnits.every(u => u.dead || (u._det && u.preComputed && u.preComputed.attackDamage !== undefined))
                && selectedUnits.some(u => !u.dead && Array.isArray(u.path) && u.path.length > 0)`);
        }
    }
    assert.equal(failure, null, failure || '');
    assert.ok(checked > TICKS * 0.8, 'compared ' + checked + ' results');
    assert.ok(detailed, 'selected units get their details (paths, stats)');
    assert.deepEqual(P.errors.map(e => String(e.stack || e).slice(0, 400)), [], 'no errors');
    const stats = JSON.parse(P.eval('JSON.stringify(window.simClientStats())'));
    console.log(`PASS: the page's units and world matched the worker on ${checked} results (up to ${unitsSeen} units); page apply ${stats.applyMs.mean} ms, worker encode ${stats.workerEncodeMs.mean} ms.`);
    process.exit(0);
})().catch(err => { console.error(err); process.exit(1); });
