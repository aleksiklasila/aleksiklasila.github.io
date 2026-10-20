// Boosts (data_dynamic.js BOOSTS): a player's thing reads its stats a few
// levels up its tables: every stat but move speed and star per tile by its
// energy boost, those two by its star boost; a stockpile in debt switches
// that resource's boosts off and scales nothing itself. The tables made in
// place equal a full rebuild, units take them over the following ticks, and
// both peers of a match stay in the same state through boost orders.
const assert = require('node:assert/strict');
const H = require('../../net-harness.cjs');

(async () => {
    const world = new H.World({ seed: 7 });
    const { host, guests } = await H.startHostedMatch(world, { guests: 1, controls: H.SMALL_MATCH_CONTROLS });
    const simEval = (inst, code) => (inst.simWorker && inst.eval('simClientActive()') ? inst.simWorker.eval(code) : inst.eval(code));
    const read = (inst, expr) => JSON.parse(simEval(inst, `JSON.stringify(${expr})`));
    const stats = `(pid => { const e = PRECOMPUTED_STATS_MAP_PLAYER[pid].unit.norm; return [1, 2, 3, 9].map(l => [e[l].attackDamage, e[l].attackRange, e[l].upKeep, e[l].speed, e[l].astarCost, e[l].maxEnergy]); })(${0})`;
    const pid = host.eval('localPlayerId');
    assert.equal(pid, 0);
    const base = read(host, stats);
    // Level 1 with an energy boost of 2 steps: level 3's stats, but level 1's
    // speed and star per tile.
    host.eval("queueAction({ action: 'setBoost', kind: 'unit', key: 'norm', res: 'energy', steps: 2 });");
    await world.run(1500);
    let now = read(host, stats);
    assert.deepEqual(now[0].slice(0, 3), base[2].slice(0, 3), 'energy boost: attack, range and upkeep of two levels up');
    assert.deepEqual(now[0].slice(3), base[0].slice(3), 'energy boost leaves move speed, star per tile and health');
    assert.deepEqual(read(guests[0], stats), now, 'the other peer has the same tables');
    // The star boost: the other two stats.
    host.eval("queueAction({ action: 'setBoost', kind: 'unit', key: 'norm', res: 'astar', steps: 4 });");
    await world.run(1500);
    now = read(host, stats);
    assert.deepEqual(now[0].slice(3, 5), base[3].slice(3, 5), 'star boost (4 steps: +8 levels): move speed and star per tile of eight levels up');
    assert.deepEqual(now[0].slice(0, 3), base[2].slice(0, 3), 'star boost leaves the rest');
    assert.equal(read(host, 'players[0].boosts["unit:norm"]').join(), '2,4');
    // Its units took the tables (staggered: within a few seconds).
    const unitAtk = `(() => { const u = units.find(u => u.owner === 0 && u.unitType === 'norm' && !u.dead); return u ? [u.unitLevel, u.preComputedEffective.attackDamage, getUnitEffectiveLevel(u)] : null; })()`;
    await world.run(4000);
    const ua = read(host, unitAtk);
    if (ua) {
        const expected = read(host, `PRECOMPUTED_STATS_MAP_PLAYER[0].unit.norm[${ua[2]}].attackDamage`);
        assert.equal(ua[1], expected, 'a unit of the boosted type fights with the boosted table of its level');
    }
    // In place equals a full rebuild.
    const same = read(host, `(() => { const a = JSON.stringify(PRECOMPUTED_STATS_MAP_PLAYER[0]); rebuildPrecomputedStatsMapPlayer(0); const b=JSON.stringify(PRECOMPUTED_STATS_MAP_PLAYER[0]);globalThis._boostDiff=[];const aa=JSON.parse(a),bb=JSON.parse(b);for(const kind of ['unit','building'])for(const key in aa[kind])for(let l=0;l<aa[kind][key].length;l++)for(const stat in aa[kind][key][l])if(aa[kind][key][l][stat]!==bb[kind][key][l][stat])globalThis._boostDiff.push([kind,key,l,stat,aa[kind][key][l][stat],bb[kind][key][l][stat]]);return a===b; })()`);
    console.log('BOOST DIFF',read(host,'globalThis._boostDiff').slice(0,40));assert.equal(same, true, 'tables rebuilt in place equal a full rebuild');
    // Energy in debt: the energy boost is off (the star one stays), and
    // nothing else is scaled. (One page alone: the stockpile is set by hand.)
    {
        const solo = new H.World({ seed: 3 }).spawn('solo', { simWorker: false });
        solo.eval('startSoloGame();');
        const sread = expr => JSON.parse(solo.eval('JSON.stringify(' + expr + ')'));
        const tick = n => solo.eval('for (let i = 0; i < ' + n + '; i++) runOneTick();');
        tick(3);
        const sbase = sread(stats);
        solo.eval("processActions([{ action: 'setBoost', kind: 'unit', key: 'norm', res: 'energy', steps: 2 }, { action: 'setBoost', kind: 'unit', key: 'norm', res: 'astar', steps: 4 }], 0);");
        tick(2);
        assert.deepEqual(sread(stats)[0], [...sbase[2].slice(0, 3), ...sbase[3].slice(3, 5), sbase[0][5]], 'alone: both boosts');
        solo.eval("_setPlayerResourceValue(0, 'energy', -5000);");
        tick(25);
        if (sread('players[0].energy') < 0) {
            assert.equal(sread('players[0].boostOn.energy'), false);
            assert.deepEqual(sread(stats)[0].slice(0, 3), sbase[0].slice(0, 3), 'in debt: the energy boost does nothing, and no stat is scaled down');
            assert.deepEqual(sread(stats)[0].slice(3, 5), sbase[3].slice(3, 5), 'the star boost is not touched by the energy debt');
        }
        solo.eval("_setPlayerResourceValue(0, 'energy', 1e9);");
        tick(25);
        assert.equal(sread('players[0].boostOn.energy'), true);
        assert.deepEqual(sread(stats)[0].slice(0, 3), sbase[2].slice(0, 3), 'out of debt: the boost is back');
        // A house's boost reaches the population cap at once (as a research
        // of it does).
        const house = `[getHousePopCapContribution(0, 1), getHousePopCapContribution(0, 3), playerPopCaps[0], [...towers, ...barracks, ...collectorSpawners, ...getCellItemsRowMajor()].filter(e => e && e.type === 'house').length]`;
        const h0 = sread(house);
        solo.eval("processActions([{ action: 'setBoost', kind: 'building', key: 'house', res: 'energy', steps: 2 }], 0);");
        const h1 = sread(house);
        assert.equal(h1[0], h0[1], 'a boosted house holds what a house two levels up holds');
        if (h0[3] > 0 && h0[1] > h0[0]) assert.ok(h1[2] > h0[2], 'the population cap follows the boost at once: ' + JSON.stringify([h0, h1]));
        assert.deepEqual(solo.errors, []);
    }
    // A building's boost, and the cap at the last level.
    const bstats = `(() => { const e = PRECOMPUTED_STATS_MAP_PLAYER[0].building.pistol; return [1, 5, MAX_THING_LEVEL].map(l => [e[l].damage, e[l].upKeep, e[l].maxEnergy]); })()`;
    const bbase = read(host, bstats);
    host.eval("queueAction({ action: 'setBoost', kind: 'building', key: 'pistol', res: 'energy', steps: 3 }); queueAction({ action: 'setBoost', kind: 'building', key: 'pistol', res: 'astar', steps: 3 });");
    await world.run(1500);
    const bnow = read(host, bstats);
    assert.deepEqual(bnow[0].slice(0, 2), bbase[1].slice(0, 2), 'a building at 3 steps: four levels up');
    assert.equal(bnow[0][2], bbase[0][2], 'a boost leaves health as it is');
    assert.deepEqual(bnow[2], bbase[2], 'never past the last level');
    assert.equal(read(host, 'players[0].boosts["building:pistol"]').join(), '3,0', 'buildings have no star boost');
    // The peers are in the same state after all of it.
    await world.run(3000);
    H.checkHealthy(world, [host, ...guests]);
    const hashes = [host, ...guests].map(i => simEval(i, 'computeLockstepStateHashFast(currentTick)') + '@' + simEval(i, 'currentTick'));
    console.log(`PASS: boosts shift a thing's stats up its tables (energy and star apart), debt switches them off and scales nothing, in-place equals full; ${hashes.length} peers healthy.`);
    process.exit(0);
})().catch(err => { console.error(err); process.exit(1); });
