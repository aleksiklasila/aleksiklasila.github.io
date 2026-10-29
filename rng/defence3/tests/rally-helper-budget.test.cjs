'use strict';
// The page's rally orders (main.js applyRallyTargets): a big selection's split
// and encoding on assign_worker.js, one setRallyMany a point with all of its
// buildings' tile keys (tkz), queued as soon as the worker answers (no pacing);
// clicks keep their order (a later small one after an earlier big one), the
// split is assign_nearest.js's, and an old match's answers are dropped.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const main = fs.readFileSync('src/main.js', 'utf8');
const libs = ['src/utils/assign_nearest.js', 'src/utils/id_codec.js'].map(f => fs.readFileSync(f, 'utf8')).join('\n');
const pending = [], sent = [], errors = [];
const ctx = vm.createContext({ Float32Array, Int32Array, Uint8Array, Number, Array, Math, Map, Object, String, ArrayBuffer,
    TILE: 32, GRID_W: 100, GRID_H: 100, _matchLoadGen: 1, gameOver: false, multiRallyPoints: [], _rallyCoverOpen: null,
    queueAction: a => sent.push({ ...a, keys: a._keys }),
    reportRuntimeError: (name, err) => errors.push(String(err)),
    Worker: class {
        constructor() {
            const self = { postMessage: m => pending.push(() => this.onmessage({ data: m })) };
            this.ctx = vm.createContext({ self, Float32Array, Int32Array, Uint8Array, Number, Math, String, ArrayBuffer, console,
                importScripts: () => vm.runInContext(libs, this.ctx) });
            vm.runInContext(fs.readFileSync('src/sim/assign_worker.js', 'utf8'), this.ctx);
        }
        postMessage(m) { pending.push(() => this.ctx.self.onmessage({ data: structuredClone(m) })); }
        terminate() {}
    }
});
vm.runInContext(libs, ctx);
vm.runInContext(main.slice(main.indexOf('    // A rally order: which point each building goes to'), main.indexOf('    function _findResearchRallyTargetNear')), ctx);
ctx.list = Array.from({ length: 5001 }, (_, i) => ({ gx: i % 100, gy: Math.floor(i / 100), x: (i % 100) * 32 + 16, y: Math.floor(i / 100) * 32 + 16 }));
ctx.small = [{ gx: 9, gy: 9, x: 304, y: 304 }];
vm.runInContext('applyRallyTargets(list, 100, 200, false); applyRallyTargets(list, 500, 600, true); applyRallyTargets(small, 900, 800, false);', ctx);
assert.equal(sent.length, 0, 'big selections go to the worker; a small click waits behind them');
let tasks = 0;
while (pending.length) { pending.shift()(); assert.ok(++tasks < 20, 'one task a click'); }
assert.deepEqual(errors, []);
assert.equal(tasks, 6, 'a message to the worker and its answer a click, nothing paced');
const keysOf = a => Array.from(vm.runInContext(`actionIdsDecode(${JSON.stringify(a.tkz)}, 1e9)`, ctx));
assert.deepEqual(Array.from(sent, a => a.targetX), [100, 100, 500, 900], 'one action a point, in click order');
assert.ok(sent.every(a => a.action === 'setRallyMany' && typeof a.tkz === 'string' && !a.coords), 'tile keys, no coordinate lists');
for (const a of sent) {
    const k = keysOf(a);
    assert.deepEqual(k, Array.from(a.keys), 'the wire keys are the page\'s');
    assert.ok(k.every((v, i) => !i || k[i - 1] < v), 'ascending');
}
assert.equal(keysOf(sent[0]).length, 5001, 'the first click: every building to its one point');
const expected = vm.runInContext('assignNearestXY(Float32Array.from(list, e => e.x), Float32Array.from(list, e => e.y), new Uint8Array(list.length).fill(1), [{x:100,y:200},{x:500,y:600}])', ctx);
const assigned = new Map();
for (const a of sent.slice(1, 3)) for (const k of keysOf(a)) { assert.ok(!assigned.has(k), 'building assigned once'); assigned.set(k, a.targetX); }
assert.equal(assigned.size, 5001);
for (let i = 0; i < expected.length; i++) assert.equal(assigned.get(i), expected[i] ? 500 : 100, 'the worker keeps the nearest split');
assert.deepEqual(keysOf(sent[3]), [909], 'the later small click goes after them');
// (Wire size: ~1-2 bytes a building.)
assert.ok(sent[0].tkz.length < 5001 * 2, 'compact: ' + sent[0].tkz.length + ' characters for 5001 buildings');
const before = sent.length;
vm.runInContext('applyRallyTargets(list, 10, 20, false); _matchLoadGen++;', ctx);
while (pending.length) pending.shift()();
assert.equal(sent.length, before, 'old match answers are dropped');
// (A small selection with nothing waiting: at once, on the page.)
vm.runInContext('applyRallyTargets(small, 70, 80, false);', ctx);
assert.equal(sent.length, before + 1, 'a small click with nothing waiting is queued at once');
console.log('PASS: rally split on the worker, one tile-key action a point at once, click order, stale-match drop');
