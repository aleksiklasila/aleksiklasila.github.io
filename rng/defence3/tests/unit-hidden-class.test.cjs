// Units must keep one property layout (hidden class). Fields added on first
// use in varying orders made every unit property read in the tick loops
// megamorphic and roughly halved simulation speed with thousands of units.
// New lazily set unit fields belong in the Unit constructor's list.
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const bench = path.join(__dirname, 'large-battle.bench.cjs');
const results = [];
for (const scenario of ['working', 'combat']) {
    const out = execFileSync(process.execPath, [bench, scenario], { encoding: 'utf8', env: { ...process.env, BENCH_TICKS: '80' }, maxBuffer: 8e6 });
    const result = JSON.parse(out.trim().split('\n').at(-1));
    assert.equal(result.unitShapes, 1, `${scenario}: ${result.unitShapes} unit property layouts after 80 ticks`);
    results.push(`${scenario} ${result.units} units`);
}
console.log(`PASS: one unit property layout (${results.join(', ')}) after worker, combat and pathing ticks.`);
