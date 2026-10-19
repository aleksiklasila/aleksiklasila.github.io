'use strict';
// Portable Offline scenes, loaded through the game's actual file reader/restorer.
// --load-only never advances simulation. Benchmarks deliberately exclude rendering.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {fork}=require('node:child_process'),{performance}=require('node:perf_hooks');
const ROOT=path.join(__dirname,'scenarios');
function options(args) {
    const o={seconds:60,scenarios:'*',jobs:1,loadOnly:false,out:path.join(__dirname,'balance/reports/scenario-benchmark')};
    for(let i=0;i<args.length;i++) {
        const a=args[i];
        if(a==='--load-only')o.loadOnly=true;
        else if(a==='--help') {console.log('node tests/scenarios.bench.cjs [--seconds 60] [--scenarios "fight-*,work-*"] [--jobs 1] [--out DIR] [--load-only]\nDefault: all scenarios, normal adaptive simulation, wall-clock duration after loading. Load-only restores every selected scene without running any ticks. Headless simulation only; no renderer. Use jobs=1 for comparable timings.');return null;}
        else if(['--seconds','--scenarios','--jobs','--out'].includes(a)) {
            if(!args[i+1])throw Error('Missing value '+a);
            const v=args[++i];o[a.slice(2)]=['--seconds','--jobs'].includes(a)?Number(v):v;
        } else throw Error('Unknown option '+a);
    }
    if(!(o.seconds>0)||!Number.isInteger(o.jobs)||o.jobs<1)throw Error('Invalid duration/jobs');
    o.out=path.resolve(o.out);return o;
}
async function run(job) {
    const H=require('./net-harness.cjs'),start=performance.now();
    const world=new H.World(),inst=world.spawn(job.scenario.name,{simWorker:false});
    inst.scratch.file=new Blob([fs.readFileSync(path.join(ROOT,job.scenario.file))]);
    inst.scratch.scene=await inst.eval('readSoloGameSnapshotFile(__scratch.file)');
    const rows=key=>inst.scratch.scene.records.reduce((n,r)=>n+(r[key]?.length||0),0);
    const expected={units:rows('units'),buildings:rows('buildings')};
    inst.eval('startMainThreadLoops=()=>{}; document.getElementById("starting-resources-popup").classList.add("hidden")');
    await inst.eval('restoreSoloGameSnapshot(__scratch.scene)');
    const state=inst.eval('({width:GRID_W,height:GRID_H,units:units.length,buildings:new Set([...towers,...barracks,...collectorSpawners,...getCellItemsRowMajor()]).size,gameOver})');
    if(state.units!==expected.units||state.buildings!==expected.buildings||state.gameOver)throw Error('Loaded state differs: '+JSON.stringify({expected,state}));
    if(inst.errors.length)throw Error(inst.errors.map(String).join('\n'));
    const result={name:job.scenario.name,kind:job.scenario.kind,status:'passed',mode:job.options.loadOnly?'load-only':'benchmark',loadMs:performance.now()-start,state};
    if(job.options.loadOnly)return result;
    inst.scratch.now=()=>performance.now();
    inst.eval('performance.now=__scratch.now; netResetSimulationPace(); __scratch.startTime=gameTime');
    const began=performance.now(),samples=[],dkHistogram={};let next=began,lastNotice=began;
    while(performance.now()-began<job.options.seconds*1000) {
        const delay=next-performance.now();if(delay>0)await new Promise(r=>setTimeout(r,delay));
        if(performance.now()-began>=job.options.seconds*1000)break;
        const t=performance.now();inst.eval('netHostUpdateSimulationPace(performance.now()); runOneTick()');samples.push(performance.now()-t);
        const dk=inst.eval('simDk');dkHistogram[dk]=(dkHistogram[dk]||0)+1;
        next+=inst.eval('netSimulationTickMs()');
        if(inst.errors.length)throw Error(inst.errors.map(String).join('\n'));
        if(performance.now()-lastNotice>15000){process.send?.({progress:job.scenario.name+' '+Math.round((performance.now()-began)/1000)+' wall seconds'});lastNotice=performance.now();}
        if(inst.eval('gameOver')){result.matchEnded=true;break;}
        await new Promise(r=>setImmediate(r));
    }
    const elapsed=(performance.now()-began)/1000; samples.sort((a,b)=>a-b);
    return {...result,wallSeconds:elapsed,gameSeconds:inst.eval('(gameTime-__scratch.startTime)/TICK_RATE'),ticks:samples.length,tps:samples.length/elapsed,dkHistogram,
        tickMs:{mean:samples.reduce((a,b)=>a+b,0)/Math.max(1,samples.length),p50:samples[Math.floor(samples.length*.5)],p95:samples[Math.floor(samples.length*.95)],p99:samples[Math.floor(samples.length*.99)],max:samples.at(-1)},memory:process.memoryUsage()};
}
async function main(args) {
    const o=options(args);if(!o)return;
    const manifest=JSON.parse(fs.readFileSync(path.join(ROOT,'manifest.json')));
    const patterns=o.scenarios.split(',').map(s=>new RegExp('^'+path.basename(s).replace(/\.json\.gz$/,'').split('*').map(x=>x.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('.*')+'$'));
    const selected=manifest.scenarios.filter(s=>patterns.some(p=>p.test(s.name))).sort((a,b)=>(a.kind==='work'?-1:0)-(b.kind==='work'?-1:0));
    if(!selected.length)throw Error('No scenarios matched');
    fs.mkdirSync(o.out,{recursive:true});
    const results=[],metadata={createdAt:new Date().toISOString(),options:o,node:process.version,cpu:os.cpus()[0].model,backend:'headless page simulation; rendering excluded',selected:selected.length};
    function save(){fs.writeFileSync(path.join(o.out,'results.json'),JSON.stringify({...metadata,results},null,2));fs.writeFileSync(path.join(o.out,'report.md'),`# Scenario ${o.loadOnly?'load checks':'benchmarks'}\n\n${results.length}/${selected.length} completed; ${results.filter(r=>r.status==='failed').length} failed.\n\n| Scenario | Status | Load seconds | TPS | Error |\n|---|---|---:|---:|---|\n`+results.map(r=>`| ${r.name} | ${r.status} | ${((r.loadMs||0)/1000).toFixed(2)} | ${r.tps?.toFixed(2)||'—'} | ${(r.error||'').split('\n')[0].replaceAll('|','/')} |`).join('\n')+'\n');}
    let cursor=0;
    console.log(`${o.loadOnly?'Loading only':'Benchmarking'} ${selected.length} scenarios; jobs=${o.jobs}`);
    await Promise.all(Array.from({length:Math.min(o.jobs,selected.length)},async()=>{
        for(;;){const scenario=selected[cursor++];if(!scenario)break;
            const result=await new Promise(resolve=>{
                const child=fork(__filename,['--child'],{execArgv:['--max-old-space-size=6144'],stdio:['ignore','inherit','inherit','ipc']});let answer;
                const finish=r=>{if(answer)return;answer=r;clearTimeout(timeout);resolve(r);};
                const timeout=setTimeout(()=>{child.kill();finish({name:scenario.name,status:'failed',error:'Scenario process timed out'});},Math.max(300000,(o.seconds+300)*1000));
                child.on('message',m=>{if(m.progress)console.log(m.progress);if(m.result)finish(m.result);if(m.error)finish({name:scenario.name,status:'failed',error:m.error});});
                child.on('error',e=>finish({name:scenario.name,status:'failed',error:e.stack}));
                child.on('exit',code=>{if(!answer)finish({name:scenario.name,status:'failed',error:'Process exited '+code});});
                child.send({scenario,options:o});
            });
            results.push(result);save();console.log(`${results.length}/${selected.length} ${result.status}: ${result.name}${result.error?' — '+result.error.split('\n')[0]:''}`);
        }
    }));
    console.log('Report: '+path.join(o.out,'report.md'));if(results.some(r=>r.status==='failed'))process.exitCode=1;
}
if(require.main===module) {
    if(process.argv.includes('--child'))process.once('message',job=>run(job).then(result=>process.send({result},()=>process.exit(0)),e=>process.send({error:e.stack},()=>process.exit(1))));
    else main(process.argv.slice(2)).catch(e=>{console.error(e);process.exitCode=1;});
}
module.exports={options,run};
