// The host has no edge over its guests (and no guest over another):
// - a command takes effect the same number of ticks after it is issued, for
//   the host and for every guest, whatever their pings;
// - commands of the same tick are applied team by team, with the first team
//   rotating, so no team always wins a race for the same tile or target.
const assert = require('node:assert/strict');
const H = require('./net-harness.cjs');

async function latencyCase(network, label, perLink = null) {
    const world = new H.World({ network, controls: H.SMALL_MATCH_CONTROLS });
    const { host, guests } = await H.startHostedMatch(world, { guests: 2, teams: [0, 1, 2] });
    const all = [host, ...guests];
    if (perLink) perLink(world, host, guests);
    // Let pings and the delay settle.
    await H.playFor(world, all, 5000, { seed: 1 });
    await world.run(2000);
    const delays = new Map(all.map(i => [i.name, []]));
    const start = world.now;
    let s = 5;
    const rand = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
    for (let k = 0; k < 40; k++) {
        // Everyone issues a harmless command at the same moment.
        for (const i of all) i.eval(`(() => { const u = units.find(u => u.owner === localPlayerId && !u.dead); queueAction({ action: 'hold', unitIds: u ? [u.id] : [] }); })()`);
        await world.run(100 + Math.floor(rand() * 400));
    }
    await world.run(3000);
    for (const [netId, info] of world.issued) {
        if (info.at < start) continue;
        const inst = all.find(i => i.name === info.by);
        const ran = inst.executedActions.get(netId);
        assert.ok(ran, `${label}: ${netId} ran`);
        delays.get(info.by).push({ ticks: ran.tick - info.tick, ms: ran.at - info.at });
    }
    const avg = arr => arr.reduce((a, b) => a + b, 0) / arr.length;
    const out = all.map(i => ({ name: i.name, ticks: avg(delays.get(i.name).map(d => d.ticks)), ms: avg(delays.get(i.name).map(d => d.ms)), n: delays.get(i.name).length }));
    for (const o of out) assert.ok(o.n >= 35, `${label}: ${o.name} commands measured ${o.n}`);
    const hostTicks = out[0].ticks;
    for (const o of out.slice(1)) {
        assert.ok(Math.abs(o.ticks - hostTicks) <= 1.01, `${label}: ${o.name} waits ${o.ticks.toFixed(2)} ticks, host ${hostTicks.toFixed(2)}`);
    }
    const lead = host.eval('netCommandLeadTicks()');
    assert.ok(hostTicks >= lead - 0.5, `${label}: host commands wait the match delay (${hostTicks.toFixed(2)} of ${lead})`);
    H.checkHealthy(world, all, { minCompared: 20, fromTick: 0, label });
    return `${label}: command delay host ${out.map(o => o.ticks.toFixed(1) + ' ticks/' + Math.round(o.ms) + 'ms').join(', guests ')} (match delay ${lead} ticks)`;
}

(async () => {
    const rows = [];
    rows.push(await latencyCase({ latencyMs: 100, jitterMs: 15 }, '200ms RTT'));
    rows.push(await latencyCase({ latencyMs: 20, jitterMs: 3 }, '40ms RTT'));
    // One guest near, one far: both (and the host) wait what the far one needs.
    rows.push(await latencyCase({ latencyMs: 20, jitterMs: 3 }, 'mixed pings', (world, host, guests) => {
        world.net.setProfile({ latencyMs: 280, jitterMs: 20 }, host.name, guests[1].name);
    }));

    // Same-tick order rotates between teams.
    {
        const world = new H.World({ network: { latencyMs: 40, jitterMs: 5 }, controls: H.SMALL_MATCH_CONTROLS });
        const { host, guests } = await H.startHostedMatch(world, { guests: 2, teams: [0, 1, 2] });
        const all = [host, ...guests];
        for (const i of all) i.eval(`(() => { __scratch.order = []; const o = processActions; processActions = function (acts, team) { if (acts.length) __scratch.order.push([currentTick, team]); return o.apply(this, arguments); }; })()`);
        const T = world.atNextSafeTick('', 30);
        // Every team has a command in each of ticks T..T+5.
        for (const i of all) i.eval(`(() => { for (let t = ${T}; t < ${T} + 6; t++) (localInputBuffer[t] ||= []).push({ action: 'hold', unitIds: [], teamId: localPlayerId, netId: myPeerId + ':fair' + t }); })()`);
        await world.runUntil(() => all.every(i => i.eval('currentTick') > T + 8), 20000, 10);
        const firsts = new Map();
        for (const [tick, team] of host.scratch.order) if (tick >= T && tick < T + 6 && !firsts.has(tick)) firsts.set(tick, team);
        assert.equal(firsts.size, 6, 'all six ticks ran commands: ' + JSON.stringify([...firsts]));
        assert.deepEqual(new Set(firsts.values()), new Set([0, 1, 2]), 'each team goes first in turn: ' + JSON.stringify([...firsts]));
        for (const i of guests) assert.deepEqual(i.scratch.order.filter(([t]) => t >= T && t < T + 6), host.scratch.order.filter(([t]) => t >= T && t < T + 6), 'same order on ' + i.name);
        H.checkHealthy(world, all, { minCompared: 5, fromTick: 0, label: 'rotation' });
        rows.push('same-tick commands: first team rotates ' + [...firsts.values()].join(','));
    }
    console.log('PASS: fairness\n  ' + rows.join('\n  '));
    process.exit(0);
})().catch(err => { console.error(err); process.exit(1); });
