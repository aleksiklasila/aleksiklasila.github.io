// The adjacency's dirty tiles (_AdjDirtySet, data_state.js) against a Set
// and a sort, as _runAdjacencyRecalculation took them before: random adds,
// deletes and takes (every flag, as the post kernel takes them); the tiles taken (ascending), the size, membership,
// iteration (ascending) and the state hash's order-free sum agree.
// Usage: node tests/adjacency-dirty-set.test.cjs
const fs = require('fs'), vm = require('vm'), path = require('path'), assert = require('node:assert/strict');
const src = fs.readFileSync(path.join(__dirname, '../src/data/data_state.js'), 'utf8');
const start = src.indexOf('class _AdjDirtySet'), end = src.indexOf('let _adjacencyDirtyTiles');
assert.ok(start >= 0 && end > start, 'class found');
const ctx = { GRID_W: 300, GRID_H: 200, Math, Uint8Array };
vm.createContext(ctx);
vm.runInContext(src.slice(start, end) + '\nthis._AdjDirtySet = _AdjDirtySet;', ctx);
const sumOf = it => { let d = 0; for (const k of it) d = (d + Math.imul((k | 0) + 1, 2654435761)) | 0; return d; };
let s = 99;
const rnd = n => { s = (s * 16807) % 2147483647; return s % n; };
const D = new ctx._AdjDirtySet(), R = new Set();
let takes = 0;
for (let step = 0; step < 200000; step++) {
    const op = rnd(100), N = ctx.GRID_W * ctx.GRID_H;
    if (op < 60) { const k = rnd(N); D.add(k); R.add(k); }
    else if (op < 75) { const k = rnd(N); assert.equal(D.delete(k), R.delete(k)); }
    // (A post: the kernel takes every flag, ascending, and clears them; the counts follow: takenAll.)
    else if (op < 76) { assert.deepEqual(Array.from(D), Array.from(R).sort((a, b) => a - b), 'taken ascending'); D.flag.fill(0); D.blk.fill(0); D.takenAll(); R.clear(); takes++; }
    else if (op < 77 && rnd(50) === 0) { D.clear(); R.clear(); }
    else { const k = rnd(N); assert.equal(D.has(k), R.has(k)); }
    assert.equal(D.size, R.size);
    if (step % 997 === 0) { assert.deepEqual(Array.from(D), Array.from(R).sort((a, b) => a - b), 'iteration ascending'); assert.equal(D.sum, sumOf(R), 'hash sum'); }
}
assert.equal(D.sum, sumOf(R));
// Keys past the first size (a bigger map) grow it.
D.add(ctx.GRID_W * ctx.GRID_H + 5); assert.ok(D.has(ctx.GRID_W * ctx.GRID_H + 5));
console.log('PASS: adjacency dirty set (' + takes + ' takes)');
