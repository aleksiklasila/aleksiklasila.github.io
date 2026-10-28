'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const main = fs.readFileSync('src/main.js', 'utf8');
const pending = [], sent = [], errors = [];
let reads = 0, maxReads = 0, maxCommits = 0;
const ctx = vm.createContext({ Float32Array, Int32Array, Uint8Array, Number, Array, Math,
    TILE: 32, _matchLoadGen: 1, multiRallyPoints: [], ACTION_MAX_RALLY_COORDS: 5000,
    setTimeout: fn => pending.push(fn), queueAction: a => sent.push(a),
    reportRuntimeError: (name, err) => errors.push(String(err)),
    Worker: class {
        constructor() {
            const self = { postMessage: m => pending.push(() => this.onmessage({ data: m })) };
            this.ctx = vm.createContext({ self, Float32Array, Int32Array, Uint8Array, console,
                importScripts: () => vm.runInContext(fs.readFileSync('src/utils/assign_nearest.js', 'utf8'), this.ctx) });
            vm.runInContext(fs.readFileSync('src/sim/assign_worker.js', 'utf8'), this.ctx);
        }
        postMessage(m) { pending.push(() => this.ctx.self.onmessage({ data: m })); }
        terminate() {}
    }
});
vm.runInContext(main.slice(main.indexOf('    const RALLY_PREP_SLICE'), main.indexOf('    function _findResearchRallyTargetNear')), ctx);
ctx.list = Array.from({ length: 5001 }, (_, i) => ({ gx: i % 100, gy: Math.floor(i / 100),
    get x() { reads++; return this.gx * 32 + 16; }, y: Math.floor(i / 100) * 32 + 16 }));
ctx.small = [{ gx: 9, gy: 9, x: 304, y: 304 }];
vm.runInContext('applyRallyTargets(list, 100, 200, false); applyRallyTargets(list, 500, 600, true); applyRallyTargets(small, 900, 800, false);', ctx);
assert.equal(reads, 0, 'input handler does not walk large selections');
function drain() {
    let tasks = 0;
    while (pending.length) {
        const n = sent.length; reads = 0;
        pending.shift()();
        maxReads = Math.max(maxReads, reads); maxCommits = Math.max(maxCommits, sent.length - n);
        assert.ok(++tasks < 1000, 'jobs finish');
    }
}
drain();
assert.deepEqual(errors, []);
assert.ok(maxReads <= 4096, 'at most 2048 buildings read per packing task (two x reads each)');
assert.equal(maxCommits, 1, 'at most one commit per task');
assert.ok(sent.every(a => a.coords.length <= 1024), 'bounded command chunks');
assert.equal(sent.reduce((n, a) => n + a.coords.length / 2, 0), 10003, 'all clicks delivered');
assert.equal(sent.at(-1).targetX, 900, 'later small click cannot be overwritten by older helper result');
const multi = sent.slice(10, -1);
const assigned = new Map();
for (const a of multi) for (let i = 0; i < a.coords.length; i += 2) {
    const key = a.coords[i + 1] * 100 + a.coords[i];
    assert.ok(!assigned.has(key), 'building assigned once'); assigned.set(key, a.targetX);
}
assert.equal(assigned.size, 5001);
vm.runInContext(fs.readFileSync('src/utils/assign_nearest.js', 'utf8'), ctx);
const expected = vm.runInContext('assignNearestXY(Float32Array.from(list, e => e.x), Float32Array.from(list, e => e.y), new Uint8Array(list.length).fill(1), [{x:100,y:200},{x:500,y:600}])', ctx);
for (let i = 0; i < expected.length; i++) assert.equal(assigned.get(i), expected[i] ? 500 : 100, 'helper preserves assignment semantics');
assert.deepEqual(multi.reduce((n, a) => { n[a.targetX] = (n[a.targetX] || 0) + a.coords.length / 2; return n; }, {}), { 100: 2500, 500: 2501 });
const before = sent.length;
vm.runInContext('applyRallyTargets(list, 10, 20, false); _matchLoadGen++;', ctx);
drain();
assert.equal(sent.length, before, 'old match jobs are discarded');
console.log('PASS: rally helper assignment, bounded preparation/commits, click ordering and stale-match cancellation');
