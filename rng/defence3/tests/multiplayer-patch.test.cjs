// Per-guest repair on big chaotic matches (every unit type, buildings of all
// kinds, mines, projectiles, research, salvage, rallies...):
// - a full snapshot restored on one guest only, the host untouched, leaves
//   the guest's future identical to the host's, field by field;
// - divergences of different sizes are each repaired by exactly one delta
//   patch, only on the diverged guest, and the exact state agrees after;
// - a forced full patch does the same.
//
// Usage: node tests/multiplayer-patch.test.cjs [map,map,...]
const assert = require('node:assert/strict');
const C = require('./multiplayer-chaos-determinism.test.cjs');

// Every field of every entity as the codec sees it, keyed by entity: a
// failed comparison names the fields.
const FULL_VALUES = `(() => {
    const S = snapEncodeState();
    const out = {};
    for (const list of Object.keys(S.lists)) for (const row of S.lists[list]) {
        const tpl = S.tpls[row[1]];
        const keys = _snapGetShape(S.shapes[tpl[0]]).cols;
        const v = tpl[1].slice();
        for (let j = 2; j < row.length; j += 2) v[row[j]] = row[j + 1];
        const o = {};
        const deref = (x, d) => { if (typeof x === 'string' && x.startsWith('~o') && d < 3) { const e = S.pool[+x.slice(2)]; return JSON.stringify(e, (k, y) => typeof y === 'string' && y.startsWith('~o') ? deref(y, d + 1) : y); } return x; };
        keys.forEach((k, i) => { o[k] = deref(v[i], 0); });
        out[list + row[0]] = o;
    }
    out.G = { g: JSON.stringify(S.g) };
    return JSON.stringify(out);
})()`;

function describeDiff(hostText, guestText) {
    const a = JSON.parse(hostText), b = JSON.parse(guestText);
    const diffs = [];
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
        if (!a[k] || !b[k]) { diffs.push(k + ' only on ' + (a[k] ? 'host' : 'guest')); continue; }
        for (const f of Object.keys(a[k])) if (JSON.stringify(a[k][f]) !== JSON.stringify(b[k][f])) diffs.push(k + '.' + f + ' host=' + JSON.stringify(a[k][f]).slice(0, 120) + ' guest=' + JSON.stringify(b[k][f]).slice(0, 120));
    }
    return diffs.length + ' fields: ' + diffs.slice(0, 8).join(' | ');
}

async function mapCase(mapType, seed) {
    const rows = [];
    const { world, host, guests, all } = await C.setupChaosWorld(mapType, seed, { exactHashes: true });
    let s = seed;
    const rand = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
    const play = async n => { for (let k = 0; k < n; k++) { for (const i of all) if (rand() < 0.7) i.eval(C.CHAOS_COMMAND + '(' + rand() + ')'); await world.run(200); } };
    const shared = { rec: {} };
    for (const i of all) i.scratch.shared = shared;
    const WINDOW = 40;
    // What the host found differing in each request, for failure messages.
    host.scratch.requests = [];
    host.eval(`(() => { const orig = resyncHostHandleRequest; resyncHostHandleRequest = function (conn, data) {
        const codes = new Set(); for (const r of (data && data.rotation) || []) { const mine = snapGetTickHash(r.tick); if (mine) for (const c of snapDiffTickHash(mine, r)) codes.add(c); }
        const ticks = ((data && data.rotation) || []).map(r => r.tick);
        __scratch.requests.push({ tick: data.tick, hostTick: currentTick, ticks: ticks[0] + '..' + ticks[ticks.length - 1], codes: [...codes].map(c => Math.floor(c / SNAP_CODE_SHIFT) + ':' + (c % SNAP_CODE_SHIFT)).join(' ') });
        return orig.apply(this, arguments); }; })()`);

    // A. Full restore on one guest, host untouched.
    for (let round = 0; round < 2; round++) {
        await play(20);
        const g = guests[round % guests.length];
        const gid = JSON.stringify(g.eval('myPeerId'));
        const T = Math.max(...all.map(i => i.eval('currentTick'))) + 30;
        shared.rec = {};
        // Every peer drops its history caches at T, as the protocol does.
        world.atTick(T - 1, `(() => { snapFlushHistoryCaches(); if (isHost) __scratch.shared.text = JSON.stringify(snapEncodeState());
            else if (myPeerId === ${gid}) snapDecodeState(JSON.parse(__scratch.shared.text)); })()`);
        for (const k of [0, 1, 10, 25, WINDOW]) world.atTick(T + k, `(() => { if (isHost || myPeerId === ${gid}) (__scratch.shared.rec[currentTick] ||= {})[isHost ? 'h' : 'g'] = ${FULL_VALUES}; })()`);
        await world.runUntil(() => all.every(i => i.eval('currentTick') > T + WINDOW + 2), 60000, 20);
        for (const t of Object.keys(shared.rec).map(Number).sort((a, b) => a - b)) {
            const r = shared.rec[t];
            assert.ok(r.h && r.g, `${mapType}: values recorded at ${t}`);
            assert.ok(r.h === r.g, `${mapType}: restored guest differs from host ${t - T} ticks after the restore: ` + (r.h === r.g ? '' : describeDiff(r.h, r.g)));
        }
        const cmp = world.compareHashes([host, g], T, 'tickExact');
        assert.equal(cmp.mismatches.length, 0, `${mapType}: exact hashes after restore ` + JSON.stringify(cmp.mismatches.slice(0, 3)));
        assert.ok(cmp.compared >= WINDOW);
        rows.push(`full restore on ${g.name} only: identical to the host for ${WINDOW} ticks (${Math.round(shared.text.length / 1024)} KB, ${host.eval('units.length')} units)`);
    }

    // B. Divergences of different sizes through the real protocol.
    const sizes = [1, 6, 40];
    for (let c = 0; c < sizes.length; c++) {
        await play(10);
        const g = guests[c % guests.length];
        const before = all.map(i => i.patchesApplied + i.snapshotsApplied);
        const fulls0 = g.fullPatchesApplied;
        const stalls = all.map(i => i.eval('netCounters.stallMs'));
        g.eval(`(() => { const us = units.filter(u => !u.dead); for (let i = 0; i < ${sizes[c]} && us.length; i++) { const u = us[(i * 37 + ${c}) % us.length]; u.x += 3 + (i % 5); u.energy = Math.max(1, u.energy - 1); u.attackTimer = (u.attackTimer || 0) + 2; }
            if (${sizes[c]} > 5) { const t = towers[${c} % Math.max(1, towers.length)]; if (t) t.cd = (t.cd || 0) + 2; players[1].energy += 13; } })()`);
        const t0 = world.now;
        const ok = await world.runUntil(() => g.patchesApplied + g.snapshotsApplied > before[all.indexOf(g)] && g.eval('resyncGuest.T < 0'), 20000, 20);
        assert.ok(ok, `${mapType}: divergence of ${sizes[c]} units patched`);
        const ms = world.now - t0;
        await play(15);
        await world.run(1000);
        const from = g.lastSnapshotTick;
        const after = all.map(i => i.patchesApplied + i.snapshotsApplied);
        // A second patch may follow when the divergence spread while the
        // first was on its way; never a full one.
        const fulls = g.fullPatchesApplied;
        for (let k = 0; k < all.length; k++) assert.ok(all[k] === g ? (after[k] - before[k] >= 1 && after[k] - before[k] <= 2 && fulls === fulls0) : after[k] === before[k], `${mapType}: repairs on ${all[k].name} for a ${sizes[c]}-unit divergence: ` + JSON.stringify(host.scratch.requests.slice(-3)) + JSON.stringify(g.warnings.slice(-6).map(w => JSON.stringify(w.a).slice(0, 700))));
        const stalled = all.map((i, k) => Math.round(i.eval('netCounters.stallMs') - stalls[k]));
        for (let k = 0; k < all.length; k++) if (all[k] !== g) assert.ok(stalled[k] < 150, `${mapType}: ${all[k].name} waited ${stalled[k]}ms for someone else's patch`);
        const cmp = world.compareHashes(all, from, 'tickExact');
        assert.equal(cmp.mismatches.length, 0, `${mapType}: exact state after the patch ` + JSON.stringify(cmp.mismatches.slice(0, 3)));
        const info = g.eval('JSON.stringify({ bytes: netCounters.snapshotBytes, apply: netCounters.snapshotApplyMs, stall: netCounters.patchStallMs, changed: resyncGuest.lastChanged.length })');
        rows.push(`${sizes[c]}-unit divergence on ${g.name}: ${after[all.indexOf(g)] - before[all.indexOf(g)]} patch(es), first after ${Math.round(ms)}ms ${info}; exact state equal for ${cmp.compared} ticks`);
    }

    // C. A forced full patch.
    {
        await play(10);
        const g = guests[0];
        const before = g.fullPatchesApplied;
        g.eval('resyncGuest.forceFull = true');
        g.eval(`(() => { const u = units.find(u => !u.dead); u.x += 5; })()`);
        const ok = await world.runUntil(() => g.fullPatchesApplied > before && g.eval('resyncGuest.T < 0'), 20000, 20);
        assert.ok(ok, `${mapType}: full patch applied`);
        const from = g.lastSnapshotTick;
        await play(15);
        await world.run(1000);
        const cmp = world.compareHashes(all, from, 'tickExact');
        assert.equal(cmp.mismatches.length, 0, `${mapType}: exact state after the full patch ` + JSON.stringify(cmp.mismatches.slice(0, 3)));
        for (const i of all) assert.equal(i.snapshotsApplied, 1, `${mapType}: no match-wide resync on ${i.name}`);
        rows.push(`forced full patch: ${Math.round(g.eval('netCounters.snapshotBytes') / 1024)} KB, exact state equal for ${cmp.compared} ticks`);
    }
    // D. Live joins: a spectator, then a player reloading its page. Each
    // loads the match alone at an agreed tick and must then agree exactly,
    // with no repair, for a long while.
    {
        const hostId = host.eval('myPeerId');
        const spec = world.spawn('spectator', { url: `http://localhost/rng/defence3/index.html?game=${hostId}` });
        spec.eval(`loadOrCreateLocalIdentity(); joinGame(${JSON.stringify(hostId)})`);
        assert.ok(await world.runUntil(() => spec.eval('remoteMatchRunning'), 10000), `${mapType}: spectator sees the match`);
        spec.eval('requestSpectateCurrentMatch()');
        assert.ok(await world.runUntil(() => spec.eval('gameStarted && !lockstepResyncPauseActive'), 20000), `${mapType}: spectating`);
        const g = guests[guests.length - 1];
        const storage = g.storage;
        world.kill(g);
        await world.run(800);
        const fresh = world.spawn(g.name + '-reloaded', { storage, url: `http://localhost/rng/defence3/index.html?game=${hostId}` });
        fresh.eval('loadOrCreateLocalIdentity()');
        fresh.eval(`joinGame(${JSON.stringify(hostId)})`);
        assert.ok(await world.runUntil(() => fresh.eval('gameStarted && !resyncGuest.joining && !resyncGuest.awaitingLive'), 30000), `${mapType}: reloaded player back`);
        const live = [...all.filter(i => i !== g), spec, fresh];
        const from = Math.max(spec.lastSnapshotTick, fresh.lastSnapshotTick);
        const t0 = host.eval('currentTick');
        while (host.eval('currentTick') < t0 + 400) {
            for (const i of live) if (i !== spec && rand() < 0.7) i.eval(C.CHAOS_COMMAND + '(' + rand() + ')');
            await world.run(200);
        }
        await world.run(1000);
        const cmp = world.compareHashes(live, from, 'tickExact');
        assert.equal(cmp.mismatches.length, 0, `${mapType}: live joiners disagree ` + JSON.stringify(cmp.mismatches.slice(0, 3)));
        for (const i of [spec, fresh]) assert.equal(i.patchesApplied, 0, `${mapType}: ${i.name} needed a patch: ` + JSON.stringify(host.scratch.requests.slice(-2)));
        for (const i of live) assert.deepEqual(i.errors.map(e => String(e && e.stack || e).slice(0, 400)), [], mapType + ' ' + i.name + ' threw');
        rows.push(`live joins (spectator, reloaded player): exact state for ${cmp.compared} tick fingerprints, no repair`);
        return rows.map(r => mapType + ': ' + r);
    }
}

(async () => {
    const maps = (process.argv[2] || process.env.PATCH_MAPS || 'crossroads,islands,solar_system').split(',');
    const rows = [];
    for (let k = 0; k < maps.length; k++) rows.push(...await mapCase(maps[k], 5150 + k * 31));
    console.log('PASS: per-guest patches\n  ' + rows.join('\n  '));
    process.exit(0);
})().catch(err => { console.error(err); process.exit(1); });
