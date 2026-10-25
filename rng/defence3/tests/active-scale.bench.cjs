// Run alone: paired end-to-end timings and exact hashes for active armies.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const assert = require('node:assert/strict');
// The baseline revision timed beside the working tree: DEFENCE_TEST_BASELINE (its hashes must then equal the current ones),
// else the last commit (timings only: the working tree may change behaviour on purpose). The current runs (0, 7, 11 helpers)
// always agree exactly with each other.
const baselineNamed = !!process.env.DEFENCE_TEST_BASELINE;
const baseline = process.env.DEFENCE_TEST_BASELINE || execFileSync('git', ['rev-parse', '--short', 'HEAD'], {cwd: __dirname, encoding: 'utf8'}).trim();
const results = [];
const cases = process.argv.includes('--quick')
    ? [{fixture:'10000.json',ticks:40,scenario:'moving'}]
    : [{fixture:'50000-200.json',ticks:40,scenario:'moving'}, {fixture:'10000.json',ticks:60,scenario:'combat'}];
for (const c of cases) {
    const pair = [];
    for (const [revision, helpers] of [['baseline',7], ['current',0], ['current',7], ['current',11]]) {
        const env = {...process.env}; delete env.DEFENCE_TEST_BASELINE;
        if (revision === 'baseline') env.DEFENCE_TEST_BASELINE = baseline;
        const output = execFileSync(process.execPath, [path.join(__dirname,'unit-scale.bench.cjs'), c.fixture,
            String(c.ticks), '--helpers='+helpers, '--'+c.scenario], {env, encoding:'utf8', timeout:600000, maxBuffer:8e6});
        const row = {revision, ...JSON.parse(output.trim().split('\n').at(-1))};
        results.push(row); pair.push(row); console.log(JSON.stringify(row));
        fs.writeFileSync(path.join(__dirname,'active-scale-results.json'), JSON.stringify({baseline, node:process.version,
            cpu:os.cpus()[0].model, results},null,2)+'\n');
        assert.equal(row.gameOver, false, 'fixture ended early');
    }
    const ref = baselineNamed ? pair[0] : pair[1];
    for (const row of pair.slice(baselineNamed ? 1 : 2)) {
        assert.equal(row.hash,ref.hash,c.scenario+' lockstep');
        assert.equal(row.exact,ref.exact,c.scenario+' exact fingerprint');
        assert.deepEqual(row.populations,ref.populations,c.scenario+' activity counts');
    }
}
