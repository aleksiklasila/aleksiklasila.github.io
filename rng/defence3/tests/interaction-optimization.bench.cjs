// Run serially, with browser stress matches closed, for paired timings.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {execFileSync}=require('node:child_process');
const root=path.resolve(__dirname,'..');
const baseline=execFileSync('git',['rev-parse',process.env.DEFENCE_BENCH_BASELINE||'HEAD'],{cwd:root,encoding:'utf8'}).trim();
const results=[];
for(const scenario of ['lasers','combat','rally'])for(const multiplayer of [false,true]) {
    for(let repeat=0;repeat<(scenario==='lasers'?3:1);repeat++) {
        const pair=[];
        for(const old of repeat%2?[false,true]:[true,false]) {
            const args=[path.join(__dirname,'large-battle.bench.cjs'),scenario,...(multiplayer?['--multiplayer']:[]),...(old?['--baseline']:[])];
            const output=execFileSync(process.execPath,args,{cwd:root,encoding:'utf8',maxBuffer:8e6,env:{...process.env,DEFENCE_BENCH_BASELINE:baseline}});
            const row={repeat,...JSON.parse(output.trim().split('\n').at(-1))};
            pair.push(row);results.push(row);
            console.log(JSON.stringify({scenario,multiplayer,repeat,baseline:old,mean:row.mean,p95:row.p95,state:row.state,lockstep:row.lockstep}));
        }
        assert.equal(pair[0].state,pair[1].state,'full gameplay replay: '+scenario);
        assert.equal(pair[0].lockstep,pair[1].lockstep,'lockstep state: '+scenario);
    }
}
const input=JSON.parse(execFileSync(process.execPath,[path.join(__dirname,'input-scale.bench.cjs')],{cwd:root,encoding:'utf8',env:{...process.env,DEFENCE_BENCH_BASELINE:baseline}}));
fs.writeFileSync(path.join(__dirname,'interaction-optimization-results.json'),JSON.stringify({baseline,node:process.version,cpu:require('node:os').cpus()[0].model,simulation:results,input},null,2)+'\n');
console.log('PASS: all paired gameplay digests and lockstep hashes match; results saved.');
