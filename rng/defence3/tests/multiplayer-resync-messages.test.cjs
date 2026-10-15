// Repair and join messages that are lost, late or refused (audit
// 2026-10-15, MULTIPLAYER_AUDIT_2026-10-15.md 1, 2, 5):
// 1. A lost JOIN_LIVE (the joiner's "caught up") is sent again until the
//    host answers: it was sent once, and the joiner held its commands for
//    good. A command issued while held runs on every peer.
// 2. A repair announcement older than one already seen from this host is
//    ignored (an overtaken RESYNC_AT replaced the newer one); a patch whose
//    decode finishes after a reset of the repair state is dropped (it was
//    installed into the reset state).
// 5. A patch the decoder refuses (another format) is neither counted nor
//    acknowledged as applied, on the page and with the simulation worker.
//   node tests/multiplayer-resync-messages.test.cjs
'use strict';
const assert = require('node:assert/strict');
const H = require('./net-harness.cjs');
const WAN = { latencyMs: 60, jitterMs: 10 };

(async () => {
    const rows = [];
    // 1. A reloaded player whose first JOIN_LIVE the host never sees.
    {
        const world = new H.World({ network: WAN, controls: H.SMALL_MATCH_CONTROLS });
        const { host, guests, hostId } = await H.startHostedMatch(world, { guests: 2, teams: [0, 1, 1] });
        await H.playFor(world, [host, ...guests], 2000, { seed: 3 });
        host.eval(`(() => { const f = resyncHostHandleJoinLive; let dropped = 0; resyncHostHandleJoinLive = function () { if (dropped++ === 0) return; return f.apply(this, arguments); }; })()`);
        const storage = guests[1].storage;
        world.kill(guests[1]);
        const fresh = world.spawn('reloaded', { storage });
        fresh.eval('loadOrCreateLocalIdentity()');
        fresh.eval(`joinGame(${JSON.stringify(hostId)})`);
        assert.ok(await world.runUntil(() => fresh.eval('gameStarted && resyncGuest.awaitingLive'), 20000), 'the joiner caught up and waits for the answer');
        // A command while held (issued, with its id, once released).
        const before = new Set(world.issued.keys());
        fresh.eval(`(() => { const u = units.find(u => u.owner === localPlayerId && !u.dead); queueAction({ action: 'move', unitIds: [u.id], targetX: u.x + 64, targetY: u.y }); })()`);
        assert.equal(fresh.eval('resyncGuest.heldActions.length'), 1, 'held while not live');
        assert.ok(await world.runUntil(() => !fresh.eval('resyncGuest.awaitingLive'), 5000), 'JOIN_LIVE sent again and answered');
        const netId = [...world.issued].find(([id, i]) => !before.has(id) && i.by === 'reloaded')?.[0];
        assert.ok(netId, 'the held command went out');
        const all = [host, guests[0], fresh];
        assert.ok(await world.runUntil(() => all.every(i => i.executedActions.has(netId)), 5000), 'the held command ran on every peer');
        const from = fresh.eval('currentTick') + 5;
        await H.playFor(world, all, 3000, { seed: 4 });
        await world.run(1500);
        H.checkHealthy(world, all, { minCompared: 10, fromTick: from, label: 'lost JOIN_LIVE' });
        rows.push('a lost JOIN_LIVE is sent again; the command held meanwhile ran everywhere');
    }
    // 2 and 5 on a guest, with and without the simulation worker.
    for (const simWorker of [false, true]) {
        const world = new H.World({ network: WAN, controls: H.SMALL_MATCH_CONTROLS });
        world.simWorker = simWorker;
        const { host, guests } = await H.startHostedMatch(world, { guests: 1 });
        await H.playFor(world, [host, ...guests], 1500, { seed: 7 });
        const g = guests[0];
        // An older announcement after a newer one.
        const at = JSON.parse(g.eval(`JSON.stringify((() => {
            const t = currentTick;
            resyncGuestHandleAt({ tick: t + 400, id: 20, full: false });
            resyncGuestHandleAt({ tick: t + 300, id: 10, full: false });
            const r = { T: resyncGuest.T - t, id: resyncGuest.patchId };
            resyncGuest.T = -1; resyncGuest.patch = null;
            return r;
        })())`));
        assert.deepEqual(at, { T: 400, id: 20 }, 'the older announcement is ignored');
        // A patch decoding while the repair state is reset (a new match, a
        // whole restore): dropped when its decode finishes.
        g.eval(`(() => {
            resyncGuestHandlePatch({ tick: currentTick + 300, id: 30, full: false, payload: { json: '{"v":7}' } });
            resyncResetState();
        })()`);
        await world.run(200);
        assert.equal(g.eval('resyncGuest.patch'), null, 'a decode finished after a reset installs nothing');
        assert.equal(g.eval('resyncGuest.T'), -1);
        // A patch the decoder refuses: not counted, not acknowledged.
        host.eval(`(() => { __scratch.applied = 0; const f = _handleConnectionMessage; _handleConnectionMessage = function (conn, data) { if (data && data.type === 'RESYNC_PATCH_APPLIED') __scratch.applied++; return f.apply(this, arguments); }; })()`);
        const counts = () => JSON.parse(g.eval('JSON.stringify([netCounters.patches, netCounters.fullPatches, resyncGuest.patches, netCounters.patchesRefused | 0])'));
        const c0 = counts();
        g.eval(`applyResyncPatch('{"v":-999}', false)`);
        await world.run(500);
        const c1 = counts();
        assert.deepEqual(c1.slice(0, 3), c0.slice(0, 3), 'a refused patch is not counted as applied');
        assert.equal(c1[3], c0[3] + 1, 'counted as refused');
        assert.equal(host.eval('__scratch.applied'), 0, 'and not acknowledged');
        const from = host.eval('currentTick') + 5;
        await H.playFor(world, [host, g], 2000, { seed: 8 });
        await world.run(1000);
        H.checkHealthy(world, [host, g], { minCompared: 10, fromTick: from, label: 'refused patch' + (simWorker ? ' (worker)' : '') });
        rows.push(`${simWorker ? 'worker' : 'page'}: older announcement ignored, a decode after a reset dropped, a refused patch neither counted nor acknowledged`);
    }
    console.log('PASS multiplayer-resync-messages\n  ' + rows.join('\n  '));
})().catch(e => { console.error(e); process.exit(1); });
