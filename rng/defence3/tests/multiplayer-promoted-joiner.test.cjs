// A joining guest that becomes the host releases the commands it held (audit row 77, MULTIPLAYER_AUDIT_2026-10-15.md,
// utils_resync.js resyncGuestReleaseOnPromotion). A joiner holds its commands until the host acknowledges its
// JOIN_LIVE; here the acknowledgement never comes (the host is lost first) and the joiner, the first successor,
// takes over. Old code: its commands stayed held for good (the acknowledgement that releases them is refused once it
// hosts). After the takeover the new host drops the lost host's player (the match waits for it otherwise) and the
// held command runs on both remaining peers, in sync.
//   node tests/multiplayer-promoted-joiner.test.cjs   (SIM_WORKER=1: worker mode)
'use strict';
const assert = require('node:assert/strict');
const H = require('./net-harness.cjs');
const WAN = { latencyMs: 40, jitterMs: 5 };
const url = hostId => `http://localhost/rng/defence3/index.html?game=${hostId}&room=${hostId}`;
// (In the map, and no random command's target (those are tile centres).)
const TX = 517;
// (A held command has no net id yet (given when sent): its run is seen by its target, on the simulation's side.)
const COUNT_MOVES = `(() => { __scratch.moves = 0; const f = processAction; processAction = function (a) { if (a && a.action === 'move' && a.targetX === ${TX}) __scratch.moves++; return f.apply(this, arguments); }; })()`;

(async () => {
    const world = new H.World({ network: WAN, controls: H.SMALL_MATCH_CONTROLS });
    const { host, guests, hostId } = await H.startHostedMatch(world, { guests: 2, teams: [0, 1, 2] });
    await H.playFor(world, [host, ...guests], 2000, { seed: 181 });
    const order = JSON.parse(guests[0].eval('JSON.stringify(computeHostMigrationCandidates(wsHostId))'));
    const g = guests.find(i => i.eval('myPeerId') === order[0]), other = guests.find(i => i !== g);
    world.kill(g);
    const fresh = world.spawn('reloaded', { storage: g.storage, session: g.session, url: url(hostId) });
    fresh.eval('loadOrCreateLocalIdentity()');
    // (Its JOIN_LIVE never reaches the host: it keeps holding its commands.)
    fresh.eval(`(() => { const j = joinGame; joinGame = function () { const r = j.apply(this, arguments);
        const wrap = () => { for (const c of connections) if (c && !c.__noLive) { c.__noLive = true; const f = c.send.bind(c); c.send = d => { if (d && d.type === 'JOIN_LIVE') return; f(d); }; } };
        wrap(); __scratch.wrapTimer = setInterval(wrap, 20); return r; }; })()`);
    fresh.eval(`joinGame(${JSON.stringify(hostId)})`);
    assert.ok(await world.runUntil(() => fresh.eval('gameStarted && resyncGuest.awaitingLive'), 30000, 50), 'the reloaded guest joined and waits for its JOIN_LIVE_ACK');
    assert.equal(JSON.parse(other.eval('JSON.stringify(computeHostMigrationCandidates(wsHostId))'))[0], fresh.eval('myPeerId'), 'the reloaded guest is still the first successor');
    for (const i of [fresh, other]) i.evalSim(COUNT_MOVES);
    fresh.eval(`(() => { const u = units.find(u => u.owner === localPlayerId && !u.dead); queueAction({ action: 'move', unitIds: [u.id], targetX: ${TX}, targetY: 519 }); })()`);
    assert.ok(fresh.eval('resyncGuest.heldActions.length') >= 1, 'the command queued while joining is held');
    world.kill(host);
    assert.ok(await world.runUntil(() => fresh.eval('isHost') && other.eval('wsHostId') === fresh.eval('myPeerId'), 60000, 100), 'the joiner took over');
    fresh.eval(`hostRemovePlayerFromMatch(${JSON.stringify(hostId)})`);
    const both = [fresh, other];
    assert.ok(await world.runUntil(() => both.every(i => i.evalSim('__scratch.moves') > 0), 15000, 50), 'its held command ran on both peers after it took over: ' + JSON.stringify([fresh.eval('resyncGuest.heldActions.length'), both.map(i => [i.eval('currentTick'), i.evalSim('__scratch.moves')])]));
    assert.equal(fresh.eval('resyncGuest.heldActions.length'), 0, 'nothing held any more');
    const from = Math.max(...both.map(i => i.eval('currentTick'))) + 3;
    await H.playFor(world, both, 3000, { seed: 182 });
    await world.run(1500);
    H.checkHealthy(world, both, { minCompared: 10, fromTick: from, label: 'promoted joiner' });
    console.log('PASS multiplayer-promoted-joiner: the held command ran on both peers, in sync to tick ' + fresh.eval('currentTick'));
    process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
