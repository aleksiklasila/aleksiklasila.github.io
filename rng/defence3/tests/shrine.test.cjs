// Shrines (SHRINES_ENABLED): damage taken goes to the owner's shrine (💀),
// drained every tick into energy/★ per the player's shrineDrain order, and
// peers agree. Also: damage-free changes (healing, stat refreshes) add
// nothing, overkill is not counted, and no bounty drops appear.
// Usage: node tests/shrine.test.cjs
const assert = require('node:assert/strict');
const C = require('./multiplayer-chaos-determinism.test.cjs');

(async () => {
    const { world, host, guests, all } = await C.setupChaosWorld('crossroads', 11, { teams: [0, 1], exactHashes: true });
    const g = guests[0];
    // Unit tests of the hook on the host's simulation (between ticks).
    const unit = JSON.parse(host.evalSim(`(() => {
        const out = {};
        const u = units.find(x => !x.dead && x.owner === 0);
        const p = players[0], f0 = _shrinePendingFixed[0];
        const e0 = u.energy;
        u.energy -= 10; shrineDamageTaken(u, 10);
        out.normal = (_shrinePendingFixed[0] - f0) / RESOURCE_FIXED_POINT_SCALE;
        const f1 = _shrinePendingFixed[0];
        u.energy = 3; u.energy -= 50; shrineDamageTaken(u, 50);
        out.overkill = (_shrinePendingFixed[0] - f1) / RESOURCE_FIXED_POINT_SCALE;
        u.energy = e0; _shrinePendingFixed[0] = f0;
        out.drops = droppedItems.length;
        // Shrines off: damage still counts, nothing drains, drain orders ignored.
        const was = SHRINES_ENABLED, fx = p._resourceFixedValues || (p._resourceFixedValues = {});
        const sh0 = fx.shrine, en0 = p.energy, as0 = p.astar, dr0 = p.shrineDrain;
        SHRINES_ENABLED = false;
        fx.shrine = 50 * RESOURCE_FIXED_POINT_SCALE;
        u.energy -= 10; shrineDamageTaken(u, 10);
        out.offMode = getPlayerShrineDrainMode(0);
        shrineTick();
        out.offShrine = fx.shrine / RESOURCE_FIXED_POINT_SCALE;
        out.offEnergy = p.energy - en0; out.offAstar = p.astar - as0;
        SHRINES_ENABLED = was; fx.shrine = sh0; if (sh0 === undefined) delete fx.shrine; p.shrine = (Number(sh0) || 0) / RESOURCE_FIXED_POINT_SCALE;
        u.energy = e0; p.shrineDrain = dr0;
        return JSON.stringify(out);
    })()`));
    assert.equal(unit.normal, 10, 'damage taken goes to the shrine');
    assert.equal(unit.overkill, 3, 'only the energy actually lost counts');
    assert.equal(unit.drops, 0, 'nothing dropped on the map');
    assert.equal(unit.offMode, 0, 'shrines off: no drain mode');
    assert.equal(unit.offShrine, 60, 'shrines off: damage still counts, nothing drained');
    assert.equal(unit.offEnergy, 0); assert.equal(unit.offAstar, 0);
    // Fight: both teams attack-move into each other for a while.
    for (const i of all) i.eval(`(() => { const mine = units.filter(u => !u.dead && u.owner === localPlayerId && !u.workerType);
        queueAction({ action: 'attackMove', unitIds: mine.map(u => u.id), targetX: GRID_W * TILE / 2, targetY: GRID_H * TILE / 2 }); })()`);
    // Player 1 drains into ★ only; player 0 keeps the default (both).
    for (const i of all) i.eval(`if (localPlayerId === 1) queueAction({ action: 'shrineDrain', drain: 2 })`);
    let s = 7;
    const rand = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
    for (let k = 0; k < 60; k++) { for (const i of all) if (rand() < 0.4) i.eval(C.CHAOS_COMMAND + '(' + rand() + ')'); await world.run(200); }
    // (Read after the same tick on both: shrines drain every tick, and with
    // the worker the peers are a few ticks apart at any moment.)
    world.atNextSafeTick(`__scratch.shrines = JSON.stringify(players.slice(0, 2).map(p => ({ shrine: p.shrine, drain: p.shrineDrain, fixed: p._resourceFixedValues && p._resourceFixedValues.shrine })))`);
    await world.runUntil(() => all.every(i => i.scratch.shrines), 10000, 50);
    const st = i => JSON.parse(i.scratch.shrines);
    const hs = st(host), gs = st(g);
    assert.deepEqual(gs, hs, 'peers agree on the shrines');
    assert.equal(hs[1].drain, 2, 'drain order applied');
    const drops = JSON.parse(host.evalSim('JSON.stringify(droppedItems.length)'));
    assert.equal(drops, 0, 'no bounty drops with shrines on');
    const taken = JSON.parse(host.evalSim(`JSON.stringify((() => { const S = _snapHashGlobals ? 1 : 0; return gameStatsHistory.length ? gameStatsHistory[gameStatsHistory.length - 1].shrine : null; })())`));
    const bad = [];
    for (const [t, h] of host.tickExact || []) { const o = g.tickExact.get(t); if (o !== undefined && o !== h) bad.push(t); }
    assert.equal(bad.length, 0, 'exact hashes equal');
    // Drain math: an isolated check of _shrineDrainFixed.
    const d = JSON.parse(host.evalSim(`JSON.stringify([_shrineDrainFixed(0, 1e9, 3), _shrineDrainFixed(0, 1e9, 1), _shrineDrainFixed(0, 1e9, 2), _shrineDrainFixed(0, 1e9, 0), _shrineDrainFixed(0, 5, 3),
        getBuildingStatForOwner(0, 'shrine', 1, 'drainRate'), getBuildingStatForOwner(0, 'shrine', 1, 'multiplier')])`));
    const [both, en, as, none, small, rate, mult] = d;
    assert.equal(none, null, 'no drain when neither is selected');
    assert.equal(both[0], Math.floor(rate * 1024 / host.evalSim('TICK_RATE')), 'drain per tick from drainRate');
    assert.equal(en[2], 0); assert.equal(as[1], 0);
    assert.equal(both[1] + both[2], Math.floor(both[0] * mult), 'both: the gain split');
    assert.equal(small[0], 5, 'never more than the shrine holds');
    console.log('PASS: shrines', JSON.stringify({ host: hs, lastSample: taken, rate, mult }));
    process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
