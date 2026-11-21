// A guest whose simulation worker takes long to load the match start is waited for (audit row 65,
// MULTIPLAYER_AUDIT_2026-10-15.md). Old code: the guest's startGame() cleared `matchStartWaitingForReady`, which
// stopped its start loading beat (START_GAME_LOADING every 2 s) while its worker still loaded; the host took it for
// silent and dropped it after MATCH_START_SILENT_MS (45 s): out of its own match, its team resigned. Now the guest
// waits for the host's ALL_READY again after startGame, the beat goes on, and the match starts with it.
// Here guest1's worker reports its start 55 s late.
//   node tests/multiplayer-slow-worker-start.test.cjs   (worker mode always)
'use strict';
const assert = require('node:assert/strict');
const H = require('./net-harness.cjs');
const WAN = { latencyMs: 40, jitterMs: 5 };
const LATE_MS = 55000;
// The page hears its worker's first 'started' LATE_MS later (the worker's load of the start, slow).
const SLOW_START = `(() => { const f = _simClientOnMessage; let first = true;
    _simClientOnMessage = function (msg) {
        if (first && msg && msg.type === 'started') { first = false; __scratch.slowStartAt = performance.now(); setTimeout(() => f(msg), ${LATE_MS}); return; }
        return f.apply(this, arguments);
    }; })()`;

(async () => {
    const world = new H.World({ network: WAN, controls: H.SMALL_MATCH_CONTROLS });
    world.simWorker = true;
    const spawn = world.spawn.bind(world);
    world.spawn = (name, o) => { const i = spawn(name, o); if (name === 'guest1') i.eval(SLOW_START); return i; };
    const { host, guests } = await H.startHostedMatch(world, { guests: 2, teams: [0, 1, 2], maxMs: LATE_MS + 40000 });
    const all = [host, ...guests], g = guests[0];
    assert.ok(g.eval('__scratch.slowStartAt > 0'), 'the slow worker start was injected');
    const gp = g.eval('myPeerId'), gpl = g.eval('localPlayerId');
    // (main.js hostRemovePlayerFromMatch: out of the start's players, its link closed, its team resigned.)
    assert.ok(host.eval(`matchStartLobbyPlayers.some(p => p && p.peerId === ${JSON.stringify(gp)})`), 'the slow guest is still one of the match\'s players');
    assert.ok(host.eval(`connections.some(c => c.peer === ${JSON.stringify(gp)})`), 'the slow guest is still connected');
    assert.deepEqual(JSON.parse(host.eval('JSON.stringify([...resignedTeams])')), [], 'no team resigned');
    assert.equal(g.eval('spectateMode'), 'none', 'the slow guest plays (not spectating)');
    assert.ok(all.every(i => i.eval('simClientActive()')), 'every page runs its match in a worker');
    const from = Math.max(...all.map(i => i.eval('currentTick'))) + 3;
    const before = new Set(world.issued.keys());
    await H.playFor(world, all, 4000, { seed: 101 });
    await world.run(1500);
    H.checkHealthy(world, all, { minCompared: 20, fromTick: from, label: 'slow worker start' });
    // The slow guest's own commands run (its player is in the match).
    const mine = [...world.issued].filter(([id, i]) => !before.has(id) && i.by === g.name).map(([id]) => id);
    assert.ok(mine.length > 0 && mine.every(id => host.executedActions.has(id)), 'the slow guest\'s commands ran on the host');
    console.log('PASS multiplayer-slow-worker-start: guest1 (player ' + gpl + ') started ' + LATE_MS / 1000 + ' s late, kept, in sync from tick ' + from);
    process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
