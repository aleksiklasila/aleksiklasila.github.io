// The streaming lockstep checksum (main.js hashStableLockstep) gives the
// same value as hashing the stable serialization's string, for random
// payloads: actions with id lists, nested objects, negative / huge /
// fractional / non-finite numbers, -0, strings with escapes, booleans,
// nulls, undefined fields, empty arrays and objects, typed arrays.
//   node tests/lockstep-hash-stream.test.cjs
'use strict';
const assert = require('node:assert/strict');
const H = require('./net-harness.cjs');
const world = new H.World({ controls: { ...H.SMALL_MATCH_CONTROLS, 'cfg-mapsize': '40' } });
const inst = world.spawn('lshash', { simWorker: false });
const r = JSON.parse(inst.eval(`JSON.stringify((() => {
    let s = 77;
    const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
    const num = () => { const k = Math.floor(rnd() * 12); return [0, -0, 1, -1, 123456789, 4294967295, 4294967296, -9007199254740991, 1e21, 1.5e22, 0.1, -2.75, NaN, Infinity][k] ?? Math.floor(rnd() * 1e6); };
    const str = () => ['move', 'a"b', 'x\\\\y', 'tab\\t', 'ünï', '', '\\u2028'][Math.floor(rnd() * 7)];
    const val = d => {
        const k = Math.floor(rnd() * (d > 3 ? 4 : 8));
        if (k === 0) return num(); if (k === 1) return str(); if (k === 2) return rnd() < 0.5; if (k === 3) return rnd() < 0.5 ? null : undefined;
        if (k === 4) { const a = []; for (let i = Math.floor(rnd() * 5); i > 0; i--) a.push(val(d + 1)); return a; }
        if (k === 5) { const o = {}; for (let i = Math.floor(rnd() * 5); i > 0; i--) o[str() + i] = val(d + 1); return o; }
        if (k === 6) return Float64Array.from([1.5, -0, 3]);
        const ids = []; for (let i = Math.floor(rnd() * 3000); i > 0; i--) ids.push(Math.floor(rnd() * 300000));
        return { action: 'move', unitIds: ids, targetX: rnd() * 30000, targetY: Math.floor(rnd() * 30000), teamId: 1, netId: 'p1:' + Math.floor(rnd() * 99) };
    };
    let n = 0, bad = null;
    for (let i = 0; i < 3000 && !bad; i++) {
        const v = val(0), a = hashStringLockstep(stableSerializeForLockstep(v)), b = hashStableLockstep(v);
        n++;
        if (a !== b) bad = { i, a, b, v: stableSerializeForLockstep(v).slice(0, 200) };
    }
    // The packet and bundle checksums as written before (the strings).
    const acts = [val(0), val(0), { action: 'stop', unitIds: [1, 2, 3] }];
    const pk = computeTickPacketChecksum(12, 'peerA', 1, acts) === hashStringLockstep(stableSerializeForLockstep({ tick: 12, peerId: 'peerA', teamId: 1, actions: acts }));
    return { n, bad, pk };
})())`));
assert.equal(r.bad, null, JSON.stringify(r.bad));
assert.ok(r.pk, 'packet checksum as before');
console.log('PASS: streaming lockstep checksum equals the string hash (' + r.n + ' payloads)');
process.exit(0);
