// A reload of the match on one guest (the host sends it the whole match:
// a live join) while that guest plays on (audit 2026-10-15,
// MULTIPLAYER_AUDIT_2026-10-15.md 3, 4):
// 3. A command queued while the snapshot decodes (sent, or not yet sent
//    when the reload is applied) runs on every peer, once: the
//    reload's startGame() cleared the input, and it was lost.
// 4. Leaving for the main menu while it decodes: the match does not start
//    again when the decode finishes (it set gameStarted again, in the menu).
//   node tests/multiplayer-reload-input.test.cjs
'use strict';
const assert = require('node:assert/strict');
const H = require('./net-harness.cjs');
const WAN = { latencyMs: 50, jitterMs: 5 };

// The guest's next snapshot decode waits until __scratch.release() is called.
const HOLD = `(() => {
    const f = netDecodeSnapshotPayload;
    netDecodeSnapshotPayload = function (payload) {
        if (!__scratch.holdNext) return f.apply(this, arguments);
        __scratch.holdNext = false; __scratch.holding = true;
        const p = f.apply(this, arguments);
        return new Promise(res => { __scratch.release = () => { __scratch.holding = false; res(p); }; });
    };
    __scratch.holdNext = true;
})()`;

(async () => {
    const rows = [];
    for (const kind of ['command', 'unsent', 'leave']) {
        const world = new H.World({ network: WAN, controls: H.SMALL_MATCH_CONTROLS });
        const { host, guests } = await H.startHostedMatch(world, { guests: 2, teams: [0, 1, 2] });
        await H.playFor(world, [host, ...guests], 2000, { seed: 31 });
        const g = guests[0], gp = g.eval('myPeerId');
        g.eval(HOLD);
        host.eval(`hostSendFullMatchSync(connections.find(c => c.peer === ${JSON.stringify(gp)}), 'playing')`);
        assert.ok(await world.runUntil(() => g.eval('!!__scratch.holding'), 5000), 'the reload is decoding');
        if (kind === 'command' || kind === 'unsent') {
            const before = new Set(world.issued.keys());
            g.eval(`(() => { const u = units.find(u => u.owner === localPlayerId && !u.dead); queueAction({ action: 'move', unitIds: [u.id], targetX: u.x + 48, targetY: u.y + 16 }); })()`);
            const netId = [...world.issued].find(([id, i]) => !before.has(id) && i.by === g.name)?.[0];
            assert.ok(netId, 'queued while decoding');
            // (unsent: the decode finishes before the next frame sends it.)
            if (kind === 'command') await world.run(300);
            else assert.ok(g.eval(`Object.values(localInputBuffer).some(l => l.some(a => a.netId === ${JSON.stringify(netId)})) && lockstepHighestSentLocalTick < Math.max(...Object.keys(localInputBuffer).map(Number))`), 'not sent yet');
            g.eval('__scratch.release()');
            const all = [host, ...guests];
            assert.ok(await world.runUntil(() => all.every(i => i.executedActions.has(netId)), 15000),
                'the command ran on every peer: ' + JSON.stringify(all.map(i => [i.name, i.executedActions.has(netId)])));
            const from = Math.max(...all.map(i => i.eval('currentTick'))) + 5;
            await H.playFor(world, all, 3000, { seed: 32 });
            await world.run(1500);
            H.checkHealthy(world, all, { minCompared: 10, fromTick: from, label: 'command during a reload' });
            rows.push(kind === 'unsent' ? 'a command not yet sent when the reload finished ran on every peer (its id kept)' : 'a command queued (and sent) while the reload decoded ran on every peer');
        } else {
            g.eval(`_returnToMainMenuWithStatus('left during the load')`);
            assert.equal(g.eval('gameStarted'), false);
            g.eval('__scratch.release()');
            await world.run(2000);
            assert.equal(g.eval('gameStarted'), false, 'the old load does not start the match again');
            assert.equal(g.eval('isMultiplayer'), false);
            assert.deepEqual(g.errors.map(e => String(e.message || e).slice(0, 200)), [], 'no errors');
            rows.push('leaving while the reload decoded: the match stays left');
        }
    }
    console.log('PASS multiplayer-reload-input\n  ' + rows.join('\n  '));
})().catch(e => { console.error(e); process.exit(1); });
