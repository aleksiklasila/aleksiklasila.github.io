'use strict';
// The presentation frame's id order (presentation_worker.js frameIdOrder)
// must keep every slot number, also past 2^21: at 4M units a fixed 21-bit
// slot field turned the second team's high slots into other units' slots,
// so the page's unit list and the camera's buckets lost them (enemy units
// drawn only as glyphs in 3D, never as models).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '../src/sim');
const c = vm.createContext({ console, performance, setTimeout() {}, postMessage() {} });
c.self = c;
c.importScripts = (...files) => { for (const f of files) vm.runInContext(fs.readFileSync(path.join(root, f.split('?')[0]), 'utf8'), c); };
vm.runInContext(fs.readFileSync(path.join(root, 'presentation_worker.js'), 'utf8'), c);
for (const cap of [64, 2097152 + 64, 4200000, 8400000]) {
    const slots = [0, 1, 5, 63, cap >> 1, cap - 3, cap - 1].filter((s, i, a) => s < cap && a.indexOf(s) === i);
    const FID = new Int32Array(cap).fill(-1), FORD = new Int32Array(cap);
    // ids in an order unrelated to the slots (the slot reuse case), up to a
    // few million as a long match makes them.
    slots.forEach((s, i) => { FID[s] = 3000000 + ((i * 7919) % 101) * 37 + i; FORD[i] = s; });
    c.frameIdOrder(FORD, FID, slots.length, cap);
    const got = Array.from(FORD.subarray(0, slots.length));
    const want = slots.slice().sort((a, b) => FID[a] - FID[b]);
    assert.deepEqual(got, want, `cap ${cap}: every slot kept, in id order`);
}
console.log('PASS: frame id order keeps slots past 2^21 (4M and 8M frames)');
