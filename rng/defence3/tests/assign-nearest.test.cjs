// The ctrl multi-point split (src/utils/assign_nearest.js assignNearestXY):
// every thing assigned, no point over its equal share, two separated groups
// each sent to the point beside it, things without a position spread over
// the points with room; a million things and ten points well under a second.
//   node tests/assign-nearest.test.cjs
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
// (In this realm: a vm context's typed arrays and Math cost ten times as much.)
const assign = new Function(fs.readFileSync(path.join(__dirname, '..', 'src/utils/assign_nearest.js'), 'utf8') + '\nreturn assignNearestXY;')();
const rnd = (s => () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296)(7);
// Two groups, two points beside them.
{
    const n = 1000, xs = new Float32Array(n), ys = new Float32Array(n), has = new Uint8Array(n).fill(1);
    for (let i = 0; i < n; i++) { const left = i < n / 2; xs[i] = (left ? 100 : 9000) + rnd() * 300; ys[i] = 500 + rnd() * 300; }
    const pick = assign(xs, ys, has, [{ x: 9100, y: 600 }, { x: 150, y: 650 }]);
    for (let i = 0; i < n; i++) assert.equal(pick[i], i < n / 2 ? 1 : 0, 'group ' + i);
}
// Shares and coverage, with some things without a position.
{
    const n = 100003, k = 7, xs = new Float32Array(n), ys = new Float32Array(n), has = new Uint8Array(n);
    for (let i = 0; i < n; i++) { xs[i] = rnd() * 32000; ys[i] = rnd() * 32000; has[i] = i % 50 ? 1 : 0; }
    const pts = Array.from({ length: k }, () => ({ x: rnd() * 32000, y: rnd() * 32000 }));
    pts[3] = null;
    const pick = assign(xs, ys, has, pts), load = new Array(k).fill(0);
    for (let i = 0; i < n; i++) { assert.ok(pick[i] >= 0 && pick[i] < k); load[pick[i]]++; }
    const cap = Math.ceil(n / k);
    for (const l of load) assert.ok(l <= cap, 'share ' + l + ' > ' + cap);
    assert.equal(load.reduce((a, b) => a + b, 0), n);
}
// Speed.
{
    const n = 1000000, xs = new Float32Array(n), ys = new Float32Array(n), has = new Uint8Array(n).fill(1);
    for (let i = 0; i < n; i++) { xs[i] = rnd() * 32000; ys[i] = rnd() * 32000; }
    const pts = Array.from({ length: 10 }, () => ({ x: rnd() * 32000, y: rnd() * 32000 }));
    const t0 = performance.now();
    assign(xs, ys, has, pts);
    const ms = performance.now() - t0;
    assert.ok(ms < 1000, 'a million things, ten points: ' + ms + ' ms');
    console.log('1M x 10: ' + Math.round(ms) + ' ms');
}
console.log('PASS: multi-point split: shares, nearest groups, positionless things, speed');
