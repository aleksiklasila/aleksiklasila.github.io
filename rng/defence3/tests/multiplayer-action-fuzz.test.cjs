// A hostile or broken guest: its packets (with valid checksums, as a
// modified client would send them) carry commands against other teams and
// malformed payloads of every kind. No peer may throw, stall or diverge, and
// no other team's units or buildings may be touched.
const assert = require('node:assert/strict');
const H = require('./net-harness.cjs');

const ACTIONS = ['place', 'move', 'attackMove', 'attack', 'attackBuilding', 'stop', 'hold', 'queueUnit', 'queueWorker', 'queueResearch',
    'workerAssign', 'setRally', 'resign', 'forceResignTeam', 'dequeueUnit', 'dequeueWorker', 'dequeueResearch', 'reorderResearch',
    'markSalvage', 'setSalvage', 'setAutoUpgrade', 'setAutoStack', 'setBuildEnabled', 'setQueueEnabled', 'setAutoResearch',
    'killUnit', 'resizeUnitGroup', 'towerTarget', 'explode', '', '__proto__', 'constructor', 'toString'];

function makeGarbage(seed, ctx) {
    let s = (seed * 7919 + 13) % 2147483647 || 1;
    const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
    const pick = arr => arr[Math.floor(rnd() * arr.length)];
    const deep = n => (n <= 0 ? 1 : { a: deep(n - 1), b: [deep(n - 1)] });
    const junk = () => pick([undefined, null, true, false, -1, 0, 3.5, 1e9, -1e9, 1e300, '5', 'x', '__proto__', 'constructor', {}, [], [1, 'a', null], { gx: 'a' }, deep(3)]);
    const coord = () => pick([...ctx.coords, -1, 1e6, 3.5, '2', null, undefined, {}]);
    const ids = () => pick([undefined, 'abc', 42, [1, 'x', null, {}, 2.5], ctx.enemyIds, ctx.ownIds, Array.from({ length: 30000 }, (_, i) => i), [...ctx.enemyIds, ...ctx.ownIds]]);
    const out = [];
    const n = Math.floor(rnd() * 5);
    for (let k = 0; k < n; k++) {
        const a = { action: pick(ACTIONS) };
        if (a.action === 'resign') a.action = 'forceResignTeam';
        for (const f of ['gx', 'gy', 'targetGx', 'targetGy']) if (rnd() < 0.7) a[f] = coord();
        for (const f of ['targetX', 'targetY']) if (rnd() < 0.6) a[f] = pick([junk(), rnd() * 4000, -50, 1e12]);
        if (rnd() < 0.8) a.unitIds = ids();
        if (rnd() < 0.5) a.count = pick([-5, 0, 1, 7, 1e9, 'lots', 3.7, null]);
        for (const f of ['targetId', 'unitId', 'targetUnitId', 'targetTeam', 'unitLevel', 'fromIndex', 'toIndex']) if (rnd() < 0.3) a[f] = pick([...ctx.enemyIds.slice(0, 3), junk(), 0, 1, 2, -1]);
        for (const f of ['itemType', 'kind', 'key', 'statKey', 'targetType', 'mode', 'unitType']) if (rnd() < 0.3) a[f] = pick([...ctx.strings, junk()]);
        if (rnd() < 0.2) a.towerCoords = pick(['x', [{ gx: 'a' }], ctx.coordPairs, Array.from({ length: 9000 }, () => ({ gx: 1, gy: 1 }))]);
        if (rnd() < 0.2) a.target = pick(['x', null, { type: 5 }, { type: 'unit', id: ctx.enemyIds[0] }, { type: 'tower', gx: coord(), gy: coord() }]);
        for (const f of ['enabled', 'marked', 'fromActive', 'toActive', 'autoUpgradeEnabled', 'buildEnabled']) if (rnd() < 0.2) a[f] = junk();
        if (rnd() < 0.3) a.teamId = pick([0, 1, 2, -1, 'x']);
        out.push(a);
    }
    if (rnd() < 0.02) for (let k = 0; k < 400; k++) out.push({ action: 'stop', unitIds: ctx.ownIds });
    return out;
}

// Send `fn(tick)`'s actions in every packet the guest builds (the same ones
// for a tick, however often it is rebuilt).
function armHostile(guest, fn) {
    guest.scratch.hostile = fn;
    guest.eval(`(() => {
        const orig = buildLocalTickPacket;
        buildLocalTickPacket = function (tick) {
            const p = orig.apply(this, arguments);
            const extra = __scratch.hostile ? __scratch.hostile(tick) : null;
            if (!p || !extra || !extra.length) return p;
            p.actions = p.actions.concat(extra.map(a => normalizeLockstepPayload(a)).filter(Boolean));
            p.checksum = computeTickPacketChecksum(p.tick, p.peerId, p.teamId, p.actions);
            lockstepLocalPacketByTick[tick] = p;
            return p;
        };
    })()`);
}

(async () => {
    const rows = [];
    const world = new H.World({ network: { latencyMs: 60, jitterMs: 10 }, controls: H.SMALL_MATCH_CONTROLS });
    const { host, guests } = await H.startHostedMatch(world, { guests: 2, teams: [0, 1, 2] });
    const all = [host, ...guests];
    const evil = guests[1];
    await H.playFor(world, all, 4000, { seed: 3 });

    // 1. Targeted: every command, aimed at the host's team.
    const victim = JSON.parse(host.eval(`JSON.stringify({
        units: units.filter(u => u.owner === 0 && !u.dead).map(u => u.id),
        buildings: [...towers, ...barracks, ...collectorSpawners].filter(b => b.owner === 0).map(b => ({ gx: b.gx, gy: b.gy })),
    })`));
    assert.ok(victim.units.length > 0 && victim.buildings.length > 0);
    const snapshotVictim = () => host.eval(`JSON.stringify({
        units: units.filter(u => u.owner === 0).map(u => [u.id, !!u.holdPosition, u.commandState, u.forcedAttackTarget]).sort((a, b) => a[0] - b[0]),
        buildings: [...towers, ...barracks, ...collectorSpawners].filter(b => b.owner === 0).map(b => [b.gx, b.gy, !!b.markedForSalvage, b.autoUpgradeEnabled, b.autoStackEnabled, b.buildEnabled, b.queueEnabled, b.rallyX, b.rallyY, (b.spawnQueue || []).length, b.preferredTargetSpec ? 1 : 0]),
        research: JSON.stringify(players[0].researchQueue || []), resigned: [...resignedTeams]
    })`);
    const before = snapshotVictim();
    const b0 = victim.buildings;
    const attackTick = world.atNextSafeTick('', 20);
    armHostile(evil, tick => tick !== attackTick ? [] : [
        { action: 'killUnit', unitId: victim.units[0] },
        ...victim.units.slice(0, 5).map(id => ({ action: 'killUnit', unitId: id })),
        { action: 'stop', unitIds: victim.units }, { action: 'hold', unitIds: victim.units },
        { action: 'move', unitIds: victim.units, targetX: 10, targetY: 10 }, { action: 'attackMove', unitIds: victim.units, targetX: 10, targetY: 10 },
        { action: 'resizeUnitGroup', unitIds: victim.units, mode: 'd2' }, { action: 'resizeUnitGroup', unitIds: victim.units, mode: 'm2' },
        { action: 'workerAssign', unitIds: victim.units, targetType: 'build', targetGx: b0[0].gx, targetGy: b0[0].gy },
        ...b0.flatMap(b => [
            { action: 'setSalvage', gx: b.gx, gy: b.gy, marked: true }, { action: 'markSalvage', gx: b.gx, gy: b.gy },
            { action: 'setAutoUpgrade', gx: b.gx, gy: b.gy, enabled: false }, { action: 'setAutoStack', gx: b.gx, gy: b.gy, enabled: false },
            { action: 'setBuildEnabled', gx: b.gx, gy: b.gy, enabled: false }, { action: 'setQueueEnabled', gx: b.gx, gy: b.gy, enabled: false },
            { action: 'setRally', gx: b.gx, gy: b.gy, targetX: 5, targetY: 5 }, { action: 'dequeueUnit', gx: b.gx, gy: b.gy, count: 99 },
            { action: 'dequeueWorker', gx: b.gx, gy: b.gy, count: 99 }, { action: 'dequeueResearch', gx: b.gx, gy: b.gy, count: 99 },
            { action: 'setAutoResearch', gx: b.gx, gy: b.gy, enabled: false }, { action: 'queueUnit', gx: b.gx, gy: b.gy, count: 5 },
            { action: 'reorderResearch', gx: b.gx, gy: b.gy, fromIndex: 0, toIndex: 1 }
        ]),
        { action: 'towerTarget', towerCoords: b0, target: { type: 'unit', id: victim.units[0] } },
        { action: 'forceResignTeam', targetTeam: 0 }, { action: 'forceResignTeam', targetTeam: 1 }
    ]);
    await world.runUntil(() => all.every(i => i.eval('currentTick') > attackTick + 1), 10000, 10);
    const after = snapshotVictim();
    const [vb, va] = [JSON.parse(before), JSON.parse(after)];
    // Compare what only a command sets (units and buildings may also die, or
    // queues run, meanwhile).
    const holdBefore = new Map(vb.units.map(u => [u[0], u[1]]));
    for (const u of va.units) if (holdBefore.has(u[0])) assert.equal(u[1], holdBefore.get(u[0]), 'hold of victim unit ' + u[0]);
    const bBefore = new Map(vb.buildings.map(b => [b[0] + ',' + b[1], b]));
    for (const b of va.buildings) {
        const old = bBefore.get(b[0] + ',' + b[1]);
        if (!old) continue;
        assert.deepEqual([...b.slice(0, 9), b[10]], [...old.slice(0, 9), old[10]], 'victim building ' + b[0] + ',' + b[1] + ' untouched');
    }
    assert.deepEqual(va.resigned, [], 'no team resigned by another');
    for (const id of victim.units.slice(0, 5)) assert.equal(host.eval(`(units.find(u => u.id === ${id}) || { dead: true, energy: 0 }).energy > 0 || !!(units.find(u => u.id === ${id}) || {}).dead`), true);
    assert.equal(host.eval(`units.filter(u => ${JSON.stringify(victim.units.slice(0, 5))}.includes(u.id) && u.dead && u.energy === 0).length`), 0, 'no victim unit killed by a command');
    rows.push(`targeted: ${b0.length} of the host's buildings and ${victim.units.length} units attacked with every command kind: untouched`);

    // 2. Random malformed payloads for 30 s, with normal play around them.
    const ctx = JSON.parse(host.eval(`JSON.stringify({
        coords: [...towers, ...barracks, ...collectorSpawners].slice(0, 20).flatMap(b => [b.gx, b.gy]),
        coordPairs: [...towers, ...barracks, ...collectorSpawners].slice(0, 20).map(b => ({ gx: b.gx, gy: b.gy })),
        enemyIds: units.filter(u => u.owner !== 2).slice(0, 40).map(u => u.id),
        ownIds: units.filter(u => u.owner === 2).slice(0, 40).map(u => u.id),
        strings: ['tower', 'pistol', 'barrack_norm', 'unit', 'building', 'norm', 'maxEnergy', 'attackDamage', 'd2', 'm2', 'build', 'queue', 'research', 'gold']
    })`));
    armHostile(evil, tick => makeGarbage(tick, ctx));
    const t0 = world.now, tick0 = host.eval('currentTick');
    await H.playFor(world, all, 30000, { seed: 9 });
    await world.run(2000);
    const tps = (host.eval('currentTick') - tick0) / ((world.now - t0) / 1000);
    for (const i of all) {
        assert.equal(i.eval('runtimeErrorCount'), 0, i.name + ' raised errors: ' + JSON.stringify(i.errors.slice(0, 2).map(e => String(e && e.stack || e).slice(0, 1500))));
        assert.deepEqual(i.errors, [], i.name + ' threw');
    }
    assert.ok(tps > host.eval('TICK_RATE') * 0.9, 'match kept its pace: ' + tps.toFixed(1));
    H.checkHealthy(world, all, { minCompared: 100, fromTick: tick0, label: 'fuzzed actions' });
    for (const i of all) assert.equal(i.patchesApplied + i.snapshotsApplied, 1, i.name + ' needed no repair');
    rows.push(`30s of malformed commands from one guest: no errors, no divergence, ${tps.toFixed(1)} TPS`);

    console.log('PASS: action fuzz\n  ' + rows.join('\n  '));
    process.exit(0);
})().catch(err => { console.error(err); process.exit(1); });
