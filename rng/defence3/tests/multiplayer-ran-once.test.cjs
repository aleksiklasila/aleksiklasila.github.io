// A command runs once (audit 2026-10-15, MULTIPLAYER_AUDIT_2026-10-15.md
// 16): a guest's salvage mark (a toggle) ran in its tick; the guest's match
// is then reloaded, and while it joins a delayed copy of that tick's packet
// reaches the host. The host must not carry it on (it unmarked the building
// again on every peer). And a command the guest queues after its reload (its
// count of commands starts again) still runs.
//   node tests/multiplayer-ran-once.test.cjs
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
    const world = new H.World({ network: WAN, controls: H.SMALL_MATCH_CONTROLS });
    const { host, guests } = await H.startHostedMatch(world, { guests: 1, teams: [0, 1] });
    const g = guests[0], gp = g.eval('myPeerId'), all = [host, g];
    await H.playFor(world, all, 1500, { seed: 41 });
    // (The host keeps every packet of the guest's that holds a salvage mark.)
    host.eval(`(() => { __scratch.marks = []; const f = _hostAcceptTickPacket; _hostAcceptTickPacket = function (conn, p) {
        if (p && Array.isArray(p.actions) && p.actions.some(a => a && a.action === 'markSalvage')) __scratch.marks.push(JSON.parse(JSON.stringify(p)));
        return f.apply(this, arguments); }; })()`);
    const site = JSON.parse(g.eval(`JSON.stringify((() => { const b = [...barracks, ...towers, ...collectorSpawners].find(b => b.owner === localPlayerId && !b.underConstruction); return b ? { gx: b.gx, gy: b.gy } : null; })())`));
    assert.ok(site, 'the guest has a building');
    const marked = i => i.eval(`!!getTileEntityRef(${site.gx}, ${site.gy}).markedForSalvage`);
    const before = new Set(world.issued.keys());
    g.eval(`queueAction({ action: 'markSalvage', gx: ${site.gx}, gy: ${site.gy} })`);
    const netId = [...world.issued].find(([id, i]) => !before.has(id) && i.by === g.name)?.[0];
    assert.ok(netId, 'the mark was queued');
    assert.ok(await world.runUntil(() => all.every(i => i.executedActions.has(netId)), 10000), 'the mark ran');
    await world.run(300);
    assert.deepEqual(all.map(marked), [true, true], 'marked on every peer');
    assert.ok(host.eval('__scratch.marks.length') >= 1, "the host kept the guest's packet");
    // The reload, held while it decodes; then the delayed copy.
    g.eval(HOLD);
    host.eval(`hostSendFullMatchSync(connections.find(c => c.peer === ${JSON.stringify(gp)}), 'playing')`);
    assert.ok(await world.runUntil(() => g.eval('!!__scratch.holding'), 5000), 'the reload is decoding');
    assert.ok(host.eval(`resyncHostIsJoining(${JSON.stringify(gp)})`), 'the guest is joining');
    host.eval(`_hostAcceptTickPacket(connections.find(c => c.peer === ${JSON.stringify(gp)}), __scratch.marks[0])`);
    assert.equal(host.eval(`(lockstepHostCarryByPeer[${JSON.stringify(gp)}] || []).length`), 0, 'the copy is not carried');
    assert.ok(host.eval('netCounters.ranCommandsDropped | 0') >= 1, 'dropped as run');
    g.eval('__scratch.release()');
    assert.ok(await world.runUntil(() => g.eval('!resyncGuest || !resyncGuest.awaitingLive'), 15000), 'the guest is live again');
    await world.run(1500);
    assert.deepEqual(all.map(marked), [true, true], 'still marked on every peer (the copy did not run)');
    // A command after the reload (its count started again): it runs.
    const before2 = new Set(world.issued.keys());
    g.eval(`queueAction({ action: 'markSalvage', gx: ${site.gx}, gy: ${site.gy} })`);
    const netId2 = [...world.issued].find(([id, i]) => !before2.has(id) && i.by === g.name)?.[0];
    assert.ok(netId2 && netId2 !== netId, 'a new id: ' + netId2 + ' (was ' + netId + ')');
    assert.ok(await world.runUntil(() => all.every(i => i.executedActions.has(netId2)), 10000), 'the new command ran');
    await world.run(300);
    assert.deepEqual(all.map(marked), [false, false], 'unmarked by the new command on every peer');
    const from = Math.max(...all.map(i => i.eval('currentTick'))) + 5;
    await H.playFor(world, all, 2500, { seed: 42 });
    await world.run(1500);
    H.checkHealthy(world, all, { minCompared: 10, fromTick: from, label: 'after the reload' });
    console.log('PASS multiplayer-ran-once');
})().catch(e => { console.error(e); process.exit(1); });
