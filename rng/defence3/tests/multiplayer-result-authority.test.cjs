// A match's outcome is the host's (audit 2026-10-15,
// MULTIPLAYER_AUDIT_2026-10-15.md 20): a guest's win check reads its own
// state, which may have diverged.
// a. A king killed only in a guest's state: that guest's automatic defeat
//    made the host resign its team, a real defeat. Now nothing is resigned,
//    the divergence is repaired, and the guest plays again.
// b. A false local victory (the other king killed only here): the guest
//    stood at its tick for good. Now it asks for the match and plays on.
// c. A real end (the same king on every peer): every peer shows the same
//    result, the guests once the host's agrees.
//   node tests/multiplayer-result-authority.test.cjs
'use strict';
const assert = require('node:assert/strict');
const H = require('./net-harness.cjs');
const WAN = { latencyMs: 50, jitterMs: 5 };
const CONTROLS = { ...H.SMALL_MATCH_CONTROLS, 'cfg-gamemode': 'killking' };
const killKing = (inst, team) => inst.evalSim(`(() => { const k = units.find(u => u.isKing && u.owner === ${team} && !u.dead); if (!k) return false; k.energy = 0; return true; })()`);

(async () => {
    const rows = [];
    for (const sim of [false, true]) {
        const tag = sim ? 'worker' : 'page';
        // a. Three teams: a guest's own king, in its state only.
        {
            const world = new H.World({ network: WAN, controls: CONTROLS });
            world.simWorker = sim;
            const { host, guests } = await H.startHostedMatch(world, { guests: 2, teams: [0, 1, 2] });
            const g = guests[0], all = [host, ...guests], team = g.eval('localPlayerId');
            await H.playFor(world, all, 1500, { seed: 71 });
            assert.ok(killKing(g, team), 'the guest has a king');
            assert.ok(await world.runUntil(() => g.eval('localDefeated'), 5000), tag + ' a: the guest saw itself defeated');
            // (Repaired: the host's state has the king alive.)
            assert.ok(await world.runUntil(() => !g.eval('localDefeated') && g.eval(`units.some(u => u.isKing && u.owner === ${team} && !u.dead)`) || g.eval('simClientActive()') && !g.eval('localDefeated'), 20000), tag + ' a: the guest plays again: ' + JSON.stringify({ defeated: g.eval('localDefeated'), resigned: host.eval('[...resignedTeams]') }));
            assert.deepEqual(host.eval('[...resignedTeams]'), [], tag + ' a: no team resigned on the host');
            assert.equal(host.eval('gameOver'), false, tag + ' a: the match goes on');
            const from = Math.max(...all.map(i => i.eval('currentTick'))) + 5;
            await H.playFor(world, all, 2500, { seed: 72 });
            await world.run(1500);
            H.checkHealthy(world, all, { minCompared: 10, fromTick: from, label: tag + ' a' });
            assert.deepEqual(all.map(i => i.eval('[...resignedTeams]').length), [0, 0, 0], tag + ' a: nobody resigned');
            rows.push(`${tag}: a king killed only in a guest's state: no resignation, the guest repaired and playing`);
        }
        // b and c. Two teams.
        {
            const world = new H.World({ network: WAN, controls: CONTROLS });
            world.simWorker = sim;
            const { host, guests } = await H.startHostedMatch(world, { guests: 1, teams: [0, 1] });
            const g = guests[0], all = [host, g], hostTeam = host.eval('localPlayerId'), gTeam = g.eval('localPlayerId');
            await H.playFor(world, all, 1500, { seed: 73 });
            // b. The host's king, in the guest's state only: a false victory.
            assert.ok(killKing(g, hostTeam), 'the host has a king');
            assert.ok(await world.runUntil(() => g.eval('gameOver'), 5000), tag + ' b: the guest saw the match end');
            assert.ok(await world.runUntil(() => !g.eval('gameOver'), 20000), tag + ' b: the guest got the match back');
            assert.equal(g.eval('_guestResultShown'), false, tag + ' b: no result shown');
            const tick = g.eval('currentTick');
            await world.run(2000);
            assert.ok(g.eval('currentTick') > tick + 20, tag + ' b: the guest plays on');
            const from = Math.max(...all.map(i => i.eval('currentTick'))) + 5;
            await H.playFor(world, all, 2000, { seed: 74 });
            await world.run(1500);
            H.checkHealthy(world, all, { minCompared: 10, fromTick: from, label: tag + ' b' });
            rows.push(`${tag}: a false victory on a guest: repaired, played on`);
            // c. The guest's king on every peer at the same tick: a real end.
            const T = Math.max(...all.map(i => i.eval('currentTick'))) + 40;
            for (const i of all) i.evalSim(`(() => { const f = gameTick; gameTick = function () { if (currentTick === ${T}) { const k = units.find(u => u.isKing && u.owner === ${gTeam} && !u.dead); if (k) k.energy = 0; } return f.apply(this, arguments); }; })()`);
            assert.ok(await world.runUntil(() => all.every(i => i.eval('gameOver')), 15000), tag + ' c: the match ended everywhere');
            assert.ok(await world.runUntil(() => g.eval('_guestResultShown'), 5000), tag + ' c: the guest shows the result');
            assert.deepEqual(all.map(i => i.eval('winner')), [hostTeam, hostTeam], tag + ' c: the same winner');
            await world.run(8000);
            assert.equal(g.eval('netCounters.resultRepairs | 0') <= 1, true, tag + ' c: no repair asked for a real end (' + g.eval('netCounters.resultRepairs | 0') + ' in all)');
            rows.push(`${tag}: a real end: the same result on both, shown on the guest`);
        }
    }
    console.log('PASS multiplayer-result-authority\n  ' + rows.join('\n  '));
})().catch(e => { console.error(e); process.exit(1); });
