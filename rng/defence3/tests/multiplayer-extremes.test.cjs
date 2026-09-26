// Extremes, all at once: every team slot taken (8 players, 8 teams), every
// unit and building type for each, the chaos command stream, research raised
// from 0 to the maximum for every stat of every team, and resources driven
// far negative and back. The state must stay bit-identical on every peer,
// every number finite, the match at speed, and a forced divergence must
// still be repaired by a single patch.
//
// Usage: node tests/multiplayer-extremes.test.cjs [seconds]
const assert = require('node:assert/strict');
const C = require('./multiplayer-chaos-determinism.test.cjs');

const SECONDS = Number(process.argv[2]) || 36;

// Raise every research stat of every team by one level, through the game's
// own completion path (which also upgrades existing units and buildings).
const RESEARCH_STEP = `(() => {
    for (const pid of activeTeamIds) {
        for (const thing of RESEARCH_THINGS) for (const st of (thing.stats || [])) applyResearchCompletion(pid, { kind: thing.kind, key: thing.key, statKey: st.statKey });
    }
})()`;

// Every number the simulation keeps about units, buildings and players.
const NON_FINITE = `(() => {
    const bad = [];
    const check = (label, o, keys) => { for (const k of keys) { const v = o[k]; if (typeof v === 'number' && !Number.isFinite(v)) bad.push(label + '.' + k + '=' + v); } };
    for (const u of units) check('u' + u.id, u, ['x', 'y', 'energy', 'maxEnergy', 'vx', 'vy', 'attackTimer', 'stackCount', 'effectiveLevel']);
    for (const b of [...towers, ...barracks, ...collectorSpawners]) check(b.type + '@' + b.gx + ',' + b.gy, b, ['energy', 'maxEnergy', 'level', 'stacks', 'spawnTimer', 'cd']);
    players.forEach((p, i) => check('P' + i, p, ['energy', 'astar', 'popCount']));
    for (const p of projectiles) check('proj', p, ['x', 'y', 'vx', 'vy', 'dmg']);
    return JSON.stringify(bad.slice(0, 10));
})()`;

(async () => {
    const rows = [];
    const teams = [0, 1, 2, 3, 4, 5, 6, 7];
    const { world, host, guests, all, setupCounts } = await C.setupChaosWorld('random', 7777, { teams, mapSize: 64, exactHashes: true });
    const counts = JSON.parse(setupCounts);
    assert.equal(host.eval('activeTeamIds.length'), 8, 'eight teams');
    let s = 31;
    const rand = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
    const maxLevel = host.eval('MAX_RESEARCH_LEVEL');
    const startTick = host.eval('currentTick');
    const t0 = world.now;
    const end = world.now + SECONDS * 1000;
    let researchSteps = 0, negativeAt = world.now + SECONDS * 300, restoreAt = world.now + SECONDS * 650;
    let nextResearch = world.now + 1500;
    let negativeSeen = false;
    while (world.now < end) {
        for (const inst of all) if (rand() < 0.5) inst.eval(C.CHAOS_COMMAND + '(' + rand() + ')');
        if (world.now >= nextResearch && researchSteps < maxLevel) {
            world.atNextSafeTick(RESEARCH_STEP, 10);
            researchSteps++;
            nextResearch = world.now + (SECONDS * 1000 * 0.6) / maxLevel;
        }
        if (negativeAt && world.now >= negativeAt) {
            negativeAt = 0;
            // Deep debt for half the teams (energy and A*).
            world.atNextSafeTick(`(() => { for (const pid of [0, 2, 4, 6]) { addPlayerResource(pid, 'energy', -(players[pid].energy + 250000)); addPlayerResource(pid, 'astar', -(players[pid].astar + 90000)); } })()`, 10);
        }
        if (restoreAt && world.now >= restoreAt) {
            restoreAt = 0;
            world.atNextSafeTick(`(() => { for (const pid of [0, 2, 4, 6]) { addPlayerResource(pid, 'energy', 400000); addPlayerResource(pid, 'astar', 200000); } })()`, 10);
        }
        if (!negativeSeen && host.eval('players[0].energy < 0 && players[2].astar < 0')) negativeSeen = true;
        await world.run(250);
    }
    await world.run(3000);
    const tps = (host.eval('currentTick') - startTick) / ((world.now - t0) / 1000);

    for (const i of all) {
        assert.deepEqual(i.errors.map(e => String(e && e.stack || e).slice(0, 500)), [], i.name + ' threw');
        assert.equal(i.eval('runtimeErrorCount'), 0, i.name + ' runtime errors');
        assert.equal(i.eval(NON_FINITE), '[]', i.name + ' non-finite values');
        assert.equal(i.patchesApplied + i.snapshotsApplied, 1, i.name + ' needed a repair');
    }
    assert.ok(negativeSeen, 'resources went negative');
    const levels = JSON.parse(host.eval(`JSON.stringify(activeTeamIds.map(pid => Math.min(...RESEARCH_THINGS.flatMap(t => (t.stats || []).filter(st => !(t.kind === 'building' && st.statKey === 'maxLevel')).map(st => (players[pid].researchLevels || {})[makeResearchLevelId(t.kind, t.key, st.statKey)] || 0)))))`));
    assert.ok(levels.every(l => l === maxLevel), 'every stat of every team at the maximum: ' + levels);
    const cmp = world.compareHashes(all, startTick, 'tickExact');
    assert.equal(cmp.mismatches.length, 0, 'bit-exact on all peers: ' + JSON.stringify(cmp.mismatches.slice(0, 3)));
    assert.ok(cmp.compared > SECONDS * 20 * 7 * 0.8, 'compared ' + cmp.compared);
    assert.ok(tps > host.eval('TICK_RATE') * 0.85, 'match speed ' + tps.toFixed(1));
    rows.push(`8 teams, ${counts.units} units + ${counts.towers + counts.barracks + counts.spawners + counts.floor} buildings at start (max ${host.eval('units.length')} units now), research 0 -> ${maxLevel} on every stat, debt and back: ${cmp.compared} tick fingerprints equal, ${tps.toFixed(1)} TPS`);

    // A divergence now (maxed stats, big armies) is still one patch.
    {
        const g = guests[3];
        const before = g.patchesApplied;
        g.eval(`(() => { const us = units.filter(u => !u.dead); for (let i = 0; i < 10; i++) { const u = us[(i * 53) % us.length]; u.x += 5; u.energy = Math.max(1, u.energy - 2); } players[3].energy += 77; })()`);
        assert.ok(await world.runUntil(() => g.patchesApplied > before && g.eval('resyncGuest.T < 0'), 20000, 20), 'patched');
        await world.run(4000);
        const from = g.lastSnapshotTick;
        const after = world.compareHashes(all, from, 'tickExact');
        assert.equal(after.mismatches.length, 0, 'exact after the patch: ' + JSON.stringify(after.mismatches.slice(0, 3)));
        assert.ok(g.patchesApplied - before <= 2 && g.fullPatchesApplied === 0, 'patches ' + (g.patchesApplied - before));
        rows.push(`divergence on one of 8 peers after all that: ${g.patchesApplied - before} patch(es) of ${Math.round(g.eval('netCounters.snapshotBytes') / 1024)} KB, exact again`);
    }

    console.log('PASS: extremes\n  ' + rows.join('\n  '));
    process.exit(0);
})().catch(err => { console.error(err); process.exit(1); });
