// Serial paired measurements. Run after regression workers have exited.
// node tests/shared-state.bench.cjs [--quick]
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const root = path.join(__dirname, '..');
const baseline = process.env.DEFENCE_TEST_BASELINE || execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
const quick = process.argv.includes('--quick');
const cases = [
    {fixture:'10000.json',ticks:40},
    {fixture:'50000-200.json',ticks:20},
    {fixture:'10000-160.json',ticks:60,moving:true}
];
const results = [];
for (let repeat=0;repeat<(quick?1:2);repeat++) for(const c of cases) {
    const pair=[];
    for(const mode of (repeat&1?['helpers7','columns','baseline']:['baseline','columns','helpers7'])) {
        const env={...process.env}; delete env.DEFENCE_TEST_BASELINE;
        if(mode==='baseline') env.DEFENCE_TEST_BASELINE=baseline;
        const args=[path.join(__dirname,'unit-scale.bench.cjs'),c.fixture,String(c.ticks)];
        if(c.moving) args.push('--moving');
        if(mode!=='baseline') args.push('--helpers='+(mode==='columns'?0:7));
        const output=execFileSync(process.execPath,args,{cwd:root,env,encoding:'utf8',maxBuffer:8e6,timeout:600000});
        const row={repeat,mode,...JSON.parse(output.trim().split('\n').at(-1))};
        pair.push(row);results.push(row);console.log(JSON.stringify(row));
        fs.writeFileSync(path.join(__dirname,'shared-state-results.json'),JSON.stringify({baseline,node:process.version,cpu:os.cpus()[0].model,results},null,2)+'\n');
    }
    for(const row of pair.slice(1)) {
        assert.equal(row.hash,pair[0].hash,c.fixture+' lockstep '+row.mode);
        assert.equal(row.exact,pair[0].exact,c.fixture+' exact state '+row.mode);
    }
}
