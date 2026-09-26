// Snapshot, delta and rolling-hash costs at scale: a 2-player match with
// thousands of units and buildings. Times every resync step on host and guest.
//
// Usage: node tests/snapshot-scale.bench.cjs [unitsPerTeam] [buildingsPerTeam] [--profile]
'use strict';
const zlib = require('node:zlib');
const SW = require('./scale-world.cjs');

const UNITS = Number(process.argv[2]) || 1500;
const BUILDINGS = Number(process.argv[3]) || 1500;
const PROFILE = process.argv.includes('--profile');

(async () => {
    const { world, host, guest, setup } = await SW.buildScaleWorld({ unitsPerTeam: UNITS, buildingsPerTeam: BUILDINGS });
    console.log('setup', setup, 'tick', host.eval('currentTick'), guest.eval('currentTick'));
    console.log('entities', host.eval('JSON.stringify({ units: units.length, towers: towers.length, barracks: barracks.length, spawners: collectorSpawners.length, floor: _snapFloorItems().length, drops: droppedItems.length, projectiles: projectiles.length })'));
    const row = (label, ms, extra = '') => console.log(label.padEnd(44), (ms.toFixed(3) + ' ms').padStart(12), extra);
    const t = (inst, code, n) => SW.time(inst, code, n);
    const tick = host.eval('currentTick');

    // Rolling hash: one slice per tick (what every peer pays every tick).
    t(host, `snapTickHash(${tick})`, 3);
    let sliceMs = 0;
    for (let k = 0; k < 10; k++) sliceMs += t(host, `snapTickHash(${tick + k})`, 3).ms;
    row('rolling hash, one tick (avg of 10 slices)', sliceMs / 10);
    row('rolling hash, all slices at once', t(host, `snapTickHash(${tick}, true)`, 3).ms);
    row('old periodic state hash (every 10 ticks)', t(host, `computeLockstepStateHashFast(currentTick)`, 3).ms);

    // Full snapshot.
    t(host, `(__scratch.S = snapEncodeState(), 0)`, 1);
    const enc = await SW.profiled('full encode x5', () => t(host, `(__scratch.S = snapEncodeState(), 0)`, 5), PROFILE);
    row('full: encode', enc.ms);
    const str = t(host, `(__scratch.text = JSON.stringify(__scratch.S)).length`, 3);
    row('full: stringify', str.ms, `${Math.round(str.out / 1024)} KB raw`);
    let z0 = process.hrtime.bigint();
    const gz = zlib.gzipSync(host.scratch.text);
    row('full: gzip (node, for size)', Number(process.hrtime.bigint() - z0) / 1e6, `${Math.round(gz.length / 1024)} KB gzip`);

    // Delta: the guest diverges in one spot; both record a hash rotation.
    const at = host.eval('currentTick');
    guest.eval(`(() => { const us = units.filter(u => !u.dead); for (let i = 0; i < 4; i++) { const u = us[(i * 613) % us.length]; u.x += 7; u.energy = Math.max(1, u.energy - 3); } })()`);
    const hostRot = JSON.parse(host.eval(`JSON.stringify(Array.from({ length: 10 }, (_, k) => snapTickHash(${at} + k)))`));
    const guestRot = JSON.parse(guest.eval(`JSON.stringify(Array.from({ length: 10 }, (_, k) => snapTickHash(${at} + k)))`));
    host.scratch.hostRot = hostRot; host.scratch.guestRot = guestRot;
    const diff = t(host, `(() => { const c = new Set(); for (let k = 0; k < 10; k++) for (const x of snapDiffTickHash(__scratch.hostRot[k], __scratch.guestRot[k])) c.add(x); __scratch.codes = [...c]; return c.size; })()`, 3);
    row('host: diff one rotation of bucket hashes', diff.ms, `${diff.out} codes`);
    const denc = await SW.profiled('delta encode x5', () => t(host, `(__scratch.D = snapEncodeState({ buckets: snapBucketsFromCodes(__scratch.codes) }), Object.values(__scratch.D.lists).reduce((n, r) => n + r.length, 0))`, 5), PROFILE);
    row('host: delta encode', denc.ms, `${denc.out} rows`);
    const dstr = t(host, `(__scratch.dtext = JSON.stringify(__scratch.D)).length`, 3);
    row('host: delta stringify', dstr.ms, `${Math.round(dstr.out / 1024)} KB raw, ${Math.round(zlib.gzipSync(host.scratch.dtext).length / 1024)} KB gzip`);
    console.log('   delta parts (bytes):', host.eval('JSON.stringify(Object.fromEntries(Object.entries(__scratch.D).map(([k, v]) => [k, JSON.stringify(v).length])))'));
    guest.scratch.dtext = host.scratch.dtext;
    const dapply = await SW.profiled('delta apply', () => t(guest, `(__scratch.r = snapDecodeState(JSON.parse(__scratch.dtext)), __scratch.r.missingRefs)`, 1), PROFILE);
    row('guest: delta parse + apply', dapply.ms, `missing refs ${dapply.out}`);
    const same = guest.eval('JSON.stringify(snapTickHash(currentTick, true).pairs)') === host.eval('JSON.stringify(snapTickHash(currentTick, true).pairs)');
    console.log('   guest equals host after delta:', same);
    // Again, now that everything is compiled (the same patch applies as a no-op).
    const dapply2 = await SW.profiled('delta apply (warm)', () => t(guest, `(__scratch.r = snapDecodeState(JSON.parse(__scratch.dtext)), __scratch.r.missingRefs)`, 3), PROFILE);
    row('guest: delta parse + apply, warm', dapply2.ms);
    row('guest: delta parse only', t(guest, `(JSON.parse(__scratch.dtext), 0)`, 3).ms);

    // Full apply on the guest.
    guest.scratch.text = host.scratch.text;
    const fapply = await SW.profiled('full apply', () => t(guest, `(__scratch.r = snapDecodeState(JSON.parse(__scratch.text)), __scratch.r.missingRefs)`, 1), PROFILE);
    row('guest: full parse + apply', fapply.ms, `missing refs ${fapply.out}`);
    const same2 = guest.eval('JSON.stringify(snapTickHash(currentTick, true).pairs)') === host.eval('JSON.stringify(snapTickHash(currentTick, true).pairs)');
    console.log('   guest equals host after full:', same2);

    row('reference: one simulation tick', t(host, `(lockstepBundleByTick[currentTick] = { tick: currentTick, packets: [], combinedChecksum: '' }, lockstepCommittedByTick[currentTick] = true, runOneTick(), 0)`, 3).ms);
    for (const i of [host, guest]) if (i.errors.length) console.log(i.name, 'errors', i.errors.slice(0, 3).map(e => String(e.stack || e).slice(0, 400)));
    process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
