// Snapshot restore, which every resync and (re)join relies on:
// - restoring the same snapshot on peers whose previous state differs (some
//   diverged, some a few ticks behind) gives bit-identical futures;
// - restore keeps unit objects on one hidden class (no slow property mode);
// - snapshots stay compact, and the gzip transport works end to end.
const assert = require('node:assert/strict');
const H = require('./net-harness.cjs');
const C = require('./multiplayer-chaos-determinism.test.cjs');

(async () => {
    const rows = [];
    const { world, host, guests, all } = await C.setupChaosWorld('crossroads', 9090, { exactHashes: true });
    let s = 17;
    const rand = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
    for (let round = 0; round < 6; round++) {
        for (let k = 0; k < 20; k++) { for (const i of all) if (rand() < 0.7) i.eval(C.CHAOS_COMMAND + '(' + rand() + ')'); await world.run(200); }
        // Make pre-states differ: one peer diverged, one runs ahead, one
        // just ran the UI, before all restore the host's snapshot.
        guests[0].eval(`(() => { const u = units.find(u => !u.dead); if (u) { u.x += 9; u.workerTarget = null; } })()`);
        host.eval(`(() => { for (let n = 0; n < 3; n++) { lockstepBundleByTick[currentTick] = { tick: currentTick, packets: [], combinedChecksum: '' }; runOneTick(); } })()`);
        const text = host.eval('JSON.stringify(buildHostAuthoritativeStateSnapshot({ includeConfig: false, includeStaticMapState: false, includeGridTypes: true }))');
        const shapes = all.map(i => i.eval('new Set(units.filter(u => !u.dead).map(u => Object.keys(u).join(","))).size'));
        const futures = all.map(i => {
            i.scratch.snapText = text;
            return i.eval(`(() => {
                applyAuthoritativeStateSnapshot(JSON.parse(__scratch.snapText));
                const out = [__exactStateHash()];
                for (let n = 0; n < 12; n++) { lockstepBundleByTick[currentTick] = { tick: currentTick, packets: [], combinedChecksum: '' }; runOneTick(); out.push(__exactStateHash()); }
                return JSON.stringify(out);
            })()`);
        });
        assert.ok(futures.every(f => f === futures[0]), `round ${round}: restored peers evolve differently`);
        const shapesAfter = all.map(i => i.eval('new Set(units.filter(u => !u.dead).map(u => Object.keys(u).join(","))).size'));
        for (let i = 0; i < all.length; i++) assert.ok(shapesAfter[i] <= Math.max(1, shapes[i]), `round ${round}: restore added unit shapes (${shapes[i]} -> ${shapesAfter[i]})`);
        const perThing = text.length / Math.max(1, host.eval('units.length + towers.length + barracks.length + collectorSpawners.length'));
        assert.ok(perThing < 2500, 'snapshot bytes per entity: ' + Math.round(perThing));
        if (round === 5) rows.push(`6 restores from differing pre-states evolve bit-identically for 12 ticks; ${Math.round(text.length / 1024)} KB (${Math.round(perThing)} B/entity); unit shapes ${shapes.join('/')} -> ${shapesAfter.join('/')}`);
    }

    // Real gzip transport: a forced divergence is patched through it, first
    // with a delta, then with a full patch; nobody pauses.
    {
        const w = new H.World({ network: { latencyMs: 60, jitterMs: 10 }, controls: H.SMALL_MATCH_CONTROLS, compressSnapshots: true });
        const m = await H.startHostedMatch(w, { guests: 1 });
        const pair = [m.host, m.guests[0]];
        // Force compression even for this small match.
        for (const i of pair) i.eval('NET_SNAPSHOT_COMPRESS_MIN_BYTES = 0');
        const g = m.guests[0];
        g.scratch.kinds = [];
        g.eval(`(() => { const orig = _handleConnectionMessage; _handleConnectionMessage = (c, d) => { if (d && d.type === 'RESYNC_PATCH') __scratch.kinds.push((d.full ? 'full:' : 'delta:') + (d.payload.z ? 'z' : 'json')); return orig(c, d); }; })()`);
        await H.playFor(w, pair, 4000, { seed: 2 });
        const snapshots0 = g.snapshotsApplied;
        g.eval(`(() => { const u = units.find(u => !u.dead); u.x += 13; })()`);
        let ok = await w.runUntil(() => g.patchesApplied >= 1, 15000, 20);
        assert.ok(ok, 'delta patch arrived over the compressed transport');
        g.eval(`resyncGuest.forceFull = true`);
        g.eval(`(() => { const u = units.find(u => !u.dead); u.energy = Math.max(1, u.energy - 5); })()`);
        ok = await w.runUntil(() => g.fullPatchesApplied >= 1, 15000, 20);
        assert.ok(ok, 'full patch arrived over the compressed transport');
        assert.deepEqual(g.scratch.kinds.slice(0, 2), ['delta:z', 'full:z']);
        const bytes = g.eval('netCounters.snapshotBytes');
        const json = m.host.eval('JSON.stringify(snapEncodeState()).length');
        assert.ok(bytes > 0 && bytes < json / 3, `compressed ${bytes} of ${json}`);
        assert.equal(g.snapshotsApplied, snapshots0, 'no match-wide resync');
        assert.equal(m.host.patchesApplied + m.host.snapshotsApplied, 1, 'host restored nothing after the start');
        const from = g.lastSnapshotTick || 0;
        await H.playFor(w, pair, 4000, { seed: 3 });
        await w.run(2000);
        H.checkHealthy(w, pair, { minCompared: 10, fromTick: from, label: 'gzip' });
        rows.push(`gzip transport: delta then full patch (${Math.round(json / 1024)} KB -> ${Math.round(bytes / 1024)} KB), no pause`);
    }

    // A guest on a browser without DecompressionStream is sent plain JSON,
    // at the start and in patches, while others still get gzip.
    {
        const w = new H.World({ network: { latencyMs: 60, jitterMs: 10 }, controls: H.SMALL_MATCH_CONTROLS, compressSnapshots: true });
        const m = await H.startHostedMatch(w, {
            guests: 2, teams: [0, 1, 2], guestOptions: [{}, { noDecompression: true }],
            hostSetup: 'NET_SNAPSHOT_COMPRESS_MIN_BYTES = 0'
        });
        const all = [m.host, ...m.guests];
        assert.equal(m.guests[1].eval('typeof DecompressionStream'), 'undefined');
        assert.equal(m.guests[0].eval('typeof DecompressionStream'), 'function');
        await H.playFor(w, all, 4000, { seed: 4 });
        const kinds = [];
        for (const g of m.guests) g.scratch.kinds = kinds;
        for (const g of m.guests) g.eval(`(() => { const orig = _handleConnectionMessage; _handleConnectionMessage = (c, d) => { if (d && d.type === 'RESYNC_PATCH') __scratch.kinds.push(myPeerId + ':' + (d.payload.z ? 'z' : 'json')); return orig(c, d); }; })()`);
        for (const g of m.guests) g.eval(`(() => { const u = units.find(u => !u.dead); u.x += 13; })()`);
        const ok = await w.runUntil(() => m.guests.every(g => g.patchesApplied >= 1), 15000, 20);
        assert.ok(ok, 'mixed-browser patches applied');
        const byPeer = Object.fromEntries(kinds.map(k => k.split(':')));
        assert.equal(byPeer[m.guests[0].eval('myPeerId')], 'z', 'modern guest gets gzip');
        assert.equal(byPeer[m.guests[1].eval('myPeerId')], 'json', 'older browser gets JSON');
        const from = Math.max(...m.guests.map(g => g.lastSnapshotTick || 0));
        await H.playFor(w, all, 4000, { seed: 5 });
        await w.run(2000);
        H.checkHealthy(w, all, { minCompared: 10, fromTick: from, label: 'mixed browsers' });
        rows.push('guest without DecompressionStream gets JSON (start and patches); others gzip');
    }

    console.log('PASS: snapshots\n  ' + rows.join('\n  '));
})().catch(err => { console.error(err); process.exit(1); });
