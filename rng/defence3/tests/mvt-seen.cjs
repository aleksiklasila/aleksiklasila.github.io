'use strict';
// The mover table's differences a run met (MVT=3: sim_occupancy.js collects
// one of each kind an instance, net-harness.cjs prints them as "[mvt] {json}"
// lines when the process ends): grouped by what differs, with the first
// case's columns. Finding the writers of a row's columns that set no mark.
// Usage: MVT=3 node tests/<some test>.cjs > log 2>&1; node tests/mvt-seen.cjs log
const L = require('node:fs').readFileSync(process.argv[2], 'utf8').split(/\r?\n/).filter(l => l.startsWith('[mvt] ')).map(l => JSON.parse(l.slice(6)));
const m = {};
for (const r of L) { const k = r.differs.map(d => d.replace(/ \(row.*/, '')).join(' + '); (m[k] || (m[k] = [])).push(r); }
if (!L.length) console.log('no differences');
for (const k in m) { const r = m[k][0]; console.log(m[k].length + 'x', k, '| tick', r.tick, r.unit, 'slots', r.slots, '\n    columns', JSON.stringify(r.columns), '\n    row', r.differs.join('; ')); }
