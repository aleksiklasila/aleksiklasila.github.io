// Many starting configurations, each played with the chaos command stream
// and then ended: maps, game modes, visibility, manual and automatic tick
// rates, team layouts (1v1, 2v2, free-for-all, shared teams), equal or own
// command delay, exact-lockstep mode, and network profiles from LAN to lossy
// and unstable. Every peer must agree on every tick with no repair, end on
// the same tick with the same winner, and start a rematch cleanly.
//
// Usage: node tests/multiplayer-matrix.test.cjs [case,case,...]
const assert = require('node:assert/strict');
const C = require('./multiplayer-chaos-determinism.test.cjs');

const CASES = [
    { name: '1v1 arena destroy LAN', map: 'arena', teams: [0, 1], mode: 'destroy', vis: 'team', net: { latencyMs: 4, jitterMs: 1 } },
    { name: '2v2 islands kill-king 200ms', map: 'islands', teams: [0, 1, 0, 1], mode: 'killking', vis: 'history', net: { latencyMs: 200, jitterMs: 30 } },
    { name: 'FFA4 crossroads full-vis 10TPS', map: 'crossroads', teams: [0, 1, 2, 3], mode: 'destroy', vis: 'full', tps: 10, net: { latencyMs: 60, jitterMs: 10 } },
    { name: '1v1 solar kill-king 30TPS lossy', map: 'solar_system', teams: [0, 1], mode: 'killking', vis: 'team', tps: 30, net: { latencyMs: 150, jitterMs: 20, lossRate: 0.01 } },
    { name: '2v1v1 random unstable', map: 'random', teams: [0, 1, 2, 0], mode: 'destroy', vis: 'history', net: { latencyMs: 80, jitterMs: 120, lossRate: 0.02, spikeEveryMs: 6000, spikeMs: 400 } },
    { name: 'FFA3 island own-delay 300ms', map: 'island', teams: [0, 1, 2], mode: 'killking', vis: 'full', fair: false, net: { latencyMs: 300, jitterMs: 40 } },
    { name: '1v1 arena exact-lockstep', map: 'arena', teams: [0, 1], mode: 'destroy', vis: 'team', exact: true, net: { latencyMs: 40, jitterMs: 5 } },
    { name: 'FFA6 big map', map: 'random', teams: [0, 1, 2, 3, 4, 5], mode: 'destroy', vis: 'team', mapSize: 72, net: { latencyMs: 50, jitterMs: 10 } },
];

async function runCase(c, seed) {
    const controls = { 'cfg-gamemode': c.mode, 'cfg-full-vis': c.vis };
    // Manual timing: the pipeline covers the round trip (manual mode does not
    // adapt it).
    if (c.tps) Object.assign(controls, { 'cfg-net-auto': false, 'cfg-tick-rate': String(c.tps), 'cfg-pipeline-delay': String(Math.ceil((c.net.latencyMs + 2 * (c.net.jitterMs || 0) + 30) / (1000 / c.tps)) + 1) });
    if (c.fair === false) controls['cfg-fair-delay'] = false;
    if (c.exact) controls['cfg-exact-lockstep'] = true;
    const { world, host, guests, all } = await C.setupChaosWorld(c.map, seed, { teams: c.teams, mapSize: c.mapSize || 40, network: c.net, controls, exactHashes: true });
    if (c.tps) for (const i of all) assert.equal(i.eval('TICK_RATE'), c.tps, i.name + ' tick rate');
    let s = seed;
    const rand = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
    const startTick = host.eval('currentTick');
    const end = world.now + 12000;
    while (world.now < end) {
        for (const inst of all) if (rand() < 0.6) inst.eval(C.CHAOS_COMMAND + '(' + rand() + ')');
        await world.run(200);
    }
    await world.run(2000);
    const tickRate = host.eval('TICK_RATE');
    const played = host.eval('currentTick') - startTick;
    // Ending: every team but the host's resigns.
    const hostTeam = host.eval('localPlayerId');
    for (const g of guests) if (g.eval('localPlayerId') !== hostTeam && !g.eval('gameOver')) g.eval(`queueAction({ action: 'resign' })`);
    const ended = await world.runUntil(() => all.every(i => i.eval('gameOver')), 20000, 20);
    assert.ok(ended, c.name + ': match ended everywhere');
    const endings = all.map(i => i.eval('JSON.stringify([winner, gameTime])'));
    assert.ok(endings.every(e => e === endings[0]), c.name + ': same winner and end tick: ' + endings);
    assert.equal(JSON.parse(endings[0])[0], hostTeam, c.name + ': the host team won');
    for (const i of all) {
        assert.deepEqual(i.errors.map(e => String(e && e.stack || e).slice(0, 500)), [], c.name + ': ' + i.name + ' threw');
        assert.equal(i.eval('runtimeErrorCount'), 0, c.name + ': ' + i.name + ' runtime errors');
        assert.equal(i.patchesApplied + i.snapshotsApplied, 1, c.name + ': ' + i.name + ' needed a repair');
        if (c.exact) assert.equal(i.eval('lockstepFatalStopActive'), false, c.name + ': exact lockstep stopped');
    }
    const cmp = world.compareHashes(all, startTick, 'tickExact');
    assert.equal(cmp.mismatches.length, 0, c.name + ': ' + JSON.stringify(cmp.mismatches.slice(0, 3)));
    const minTps = (c.net.spikeEveryMs || c.net.lossRate >= 0.02) ? 0.75 : 0.9;
    const tps = played / 14;
    assert.ok(tps > tickRate * minTps, c.name + `: ${tps.toFixed(1)} of ${tickRate} TPS`);

    // And the next match.
    host.eval('hostRematch()');
    const again = await world.runUntil(() => all.every(i => i.eval('gameStarted && !gameOver && !matchStartWaitingForReady')) && host.eval('currentTick') > 10, 30000, 20);
    assert.ok(again, c.name + ': rematch started');
    const from = host.eval('currentTick');
    await world.run(3000);
    const cmp2 = world.compareHashes(all, from, 'tickExact');
    assert.equal(cmp2.mismatches.length, 0, c.name + ' rematch: ' + JSON.stringify(cmp2.mismatches.slice(0, 3)));
    for (const i of all) assert.deepEqual(i.errors, [], c.name + ' rematch: ' + i.name + ' threw');
    return `${c.name}: ${cmp.compared} fingerprints equal, ${tps.toFixed(1)}/${tickRate} TPS, delay ${host.eval('netCommandLeadTicks()')} ticks, ended together, rematch ok`;
}

(async () => {
    const pick = process.argv[2] ? process.argv[2].split(',').map(Number) : CASES.map((_, i) => i);
    const rows = [];
    for (const k of pick) rows.push(await runCase(CASES[k], 4000 + k * 97));
    console.log('PASS: configuration matrix\n  ' + rows.join('\n  '));
    process.exit(0);
})().catch(err => { console.error(err); process.exit(1); });
