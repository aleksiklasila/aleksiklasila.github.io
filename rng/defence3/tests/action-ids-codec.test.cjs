// Orders' unit ids on the wire (main.js actionIdsEncode / actionIdsDecode):
// the same ids in the same order after a round trip, compact for big
// armies, and malformed or oversized input (another player's machine)
// decodes to a bounded list without throwing.
//   node tests/action-ids-codec.test.cjs
'use strict';
const assert = require('node:assert/strict');
const H = require('./net-harness.cjs');
const world = new H.World({ controls: H.SMALL_MATCH_CONTROLS });
const a = world.spawn('codec', { simWorker: false });
const r = JSON.parse(a.eval(`JSON.stringify((() => {
    let s = 99; const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
    const cases = [];
    cases.push([]);
    cases.push([0]);
    cases.push([5, 4, 3, 2, 1, 0]);
    cases.push(Array.from({ length: 20000 }, (_, i) => 100000 + i));                 // one run
    cases.push(Array.from({ length: 20000 }, () => Math.floor(rnd() * 900000)));       // scattered
    cases.push(Array.from({ length: 5000 }, (_, i) => i * 3 + (i % 7 === 0 ? 1 : 0)));  // gaps
    { const a = []; let id = 7; for (let k = 0; k < 2000; k++) { const n = 1 + Math.floor(rnd() * 20); for (let j = 0; j < n; j++) a.push(id + j); id += n + Math.floor(rnd() * 50); } cases.push(a); }
    cases.push([0x7fffffff, 0, 0x7fffffff - 1]);
    const out = [];
    for (const ids of cases) {
        const z = actionIdsEncode(ids);
        const back = actionIdsDecode(z, 1e9);
        out.push({ n: ids.length, same: JSON.stringify(back) === JSON.stringify(ids), bytes: z.length, json: JSON.stringify(ids).length });
    }
    // Not encoded: anything but plain non-negative integers.
    const rejected = [[1.5], [-1], ['3'], [1, null]].map(x => actionIdsEncode(x));
    // Hostile strings: bounded, never throw.
    const hostile = ['', '!!!', '_'.repeat(5000), 'A' + '_'.repeat(9), 'gA'.repeat(100000), 'A__________A', '\\u00ff\\u0100'];
    const hostileOut = hostile.map(h => { try { return actionIdsDecode(h).length; } catch (e) { return 'threw ' + e.message; } });
    const bigRun = actionIdsDecode('B' + '_'.repeat(6) + 'B', 100).length;
    // Through the sanitizer, as every peer processes it.
    const ids = Array.from({ length: 300 }, (_, i) => 1000 + (i * 7) % 300);
    const san = sanitizeAction({ action: 'move', uidz: actionIdsEncode(ids), targetX: 10, targetY: 10 });
    return { out, rejected, hostileOut, bigRun, sanitized: JSON.stringify(san.unitIds) === JSON.stringify(ids), noUidz: !('uidz' in san) };
})())`));
for (const c of r.out) assert.ok(c.same, 'round trip of ' + c.n + ' ids');
assert.deepEqual(r.rejected, [null, null, null, null], 'only plain non-negative integer ids are encoded');
for (const n of r.hostileOut) assert.equal(typeof n, 'number', 'hostile input decodes without throwing: ' + n);
assert.ok(r.hostileOut.every(n => n <= 20000), 'decoded lists are bounded');
assert.ok(r.bigRun <= 100, 'a huge run is cut at the bound');
assert.ok(r.sanitized && r.noUidz, 'the sanitizer turns uidz into the id list');
const run = r.out[3], scattered = r.out[4];
assert.ok(run.bytes < 20, 'a run of 20000 ids takes a few bytes: ' + run.bytes);
assert.ok(scattered.bytes < scattered.json * 0.7, 'scattered ids smaller than JSON: ' + scattered.bytes + ' vs ' + scattered.json);
console.log('PASS: action ids codec', JSON.stringify(r.out.map(c => [c.n, c.bytes, c.json])));
process.exit(0);
