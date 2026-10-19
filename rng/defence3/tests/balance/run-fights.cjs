'use strict';
const fs=require('node:fs'),path=require('node:path'),zlib=require('node:zlib'),os=require('node:os');
const {fork,spawn}=require('node:child_process');
const {performance}=require('node:perf_hooks');
const ROOT=path.resolve(__dirname,'../scenarios');
function options(argv) {
    const o={seconds:60,scenarios:['fight-2-teams-*'],out:path.join(__dirname,'reports'),jobs:1,resume:false,timeBasis:'wall',stop:false};
    for(let i=0;i<argv.length;i++) {
        const a=argv[i];
        if(a==='--resume') o.resume=true;
        else if(a==='--regenerate') o.regenerate=true;
        else if(a==='--stop') o.stop=true;
        else if(a==='--help') {console.log('node tests/balance/run-fights.cjs --seconds 60 --scenarios "fight-2-teams-*" --jobs 1 --out tests/balance/reports [--resume] [--time-basis wall|simulation]\nScenario filters may be comma-separated names/globs or absolute filenames. Timing starts after loading. Default: 60 wall-clock seconds, normal base ticks.');process.exit(0);}
        else if(['--seconds','--jobs','--out','--scenarios','--time-basis'].includes(a)) {
            if(!argv[i+1]) throw new Error('Missing value: '+a);
            const v=argv[++i];
            if(a==='--seconds'||a==='--jobs') o[a.slice(2)]=Number(v);
            else if(a==='--scenarios') o.scenarios=v.split(',');
            else if(a==='--time-basis') o.timeBasis=v;
            else o.out=path.resolve(v);
        } else throw new Error('Unknown argument '+a);
    }
    if(!(o.seconds>0) || !Number.isInteger(o.jobs) || o.jobs<1 || !['simulation','wall'].includes(o.timeBasis)) throw new Error('Invalid duration, jobs, or time basis');
    return o;
}
// Runs inside the real game's scope. Instrumentation observes events only.
function installProbe() {
    const scenario=__scratch.scenario;
    const byObject=new WeakMap(), byId=new Map();
    const groups=scenario.arenas.map(a=>({arena:a,sides:[[],[]],crossAttacks:0,leftBounds:0,astar:[0,0]}));
    function locate(x,y) {
        const l=scenario.layout, col=Math.floor((x-l.originX)/l.pitch), row=Math.floor((y-l.originY)/l.pitch);
        const i=row*l.columns+col, g=groups[i];
        if(col<0||col>=l.columns||!g) return null;
        const b=g.arena.bounds;
        return x>=b[0] && x<b[2]+1 && y>=b[1] && y<b[3]+1 ? g:null;
    }
    function add(e,x,y) {
        const g=locate(x,y); if(!g) return;
        const data={e,initial:e.energy,max:e.maxEnergy||e.energy,owner:e.owner,g,left:false,upkeep:0,tileX:Math.floor(x),tileY:Math.floor(y),
            initialEffectiveLevel:e instanceof Unit?getUnitEffectiveLevel(e):getThingEffectiveLevel(e,getThingBaseLevel(e))};
        byObject.set(e,data); if(e instanceof Unit) byId.set(e.id,data);
        g.sides[e.owner].push(data);
    }
    for(const u of units) add(u,u.x/TILE,u.y/TILE);
    for(const e of [...towers,...barracks,...collectorSpawners,...getCellItemsRowMajor()]) add(e,e.gx,e.gy);
    for(const g of groups) g.astarEstimate=[0,0];
    const teams=[{astar:0,unattributedAstar:0,astarNodes:0,upkeepEnergy:0,energyBySource:{}},{astar:0,unattributedAstar:0,astarNodes:0,upkeepEnergy:0,energyBySource:{}}];
    const astar=_recordAstarUsage;
    _recordAstarUsage=function(owner,used,unit,source) {
        if(teams[owner]) teams[owner].astar+=Math.max(0,Number(used)||0);
        const d=unit && byObject.get(unit); if(d) d.g.astar[owner]+=Math.max(0,Number(used)||0);
        else if(teams[owner]) teams[owner].unattributedAstar+=Math.max(0,Number(used)||0);
        if(d&&source!=='movement') d.g.astarEstimate[owner]+=Math.max(0,Number(used)||0);
        return astar.apply(this,arguments);
    };
    const nodeBudget=_tryConsumeAstarNodeBudget;
    _tryConsumeAstarNodeBudget=function(owner,count=1) {
        const ok=nodeBudget.apply(this,arguments);
        if(ok&&teams[owner]) teams[owner].astarNodes+=count;
        return ok;
    };
    const energy=recordEnergyDelta;
    recordEnergyDelta=function(owner,source,delta) {
        if(teams[owner]) teams[owner].energyBySource[source]=(teams[owner].energyBySource[source]||0)+delta;
        return energy.apply(this,arguments);
    };
    const upkeep=_upKeepSecond;
    _upKeepSecond=function() {
        const totals=upkeep.apply(this,arguments);
        for(let pid=0;pid<2;pid++) teams[pid].upkeepEnergy+=totals[pid]?.total||0;
        for(const g of groups) for(const side of g.sides) for(const d of side) {
            const e=d.e;if(e.dead||!(e.energy>0)||e.underConstruction)continue;
            const rate=e instanceof Unit ? getUnitStatForOwner(e.owner,e.unitType,getUnitEffectiveLevel(e),'upKeep') : getBuildingStatForOwner(e.owner,getEntityStatsCalcType(e),getThingBaseLevel(e),'upKeep');
            d.upkeep+=Math.max(0,Math.floor((Number(rate)||0)*UPKEEP_FIXED_SCALE))/UPKEEP_FIXED_SCALE;
        }
        return totals;
    };
    for(const method of ['_performAttackOnUnit','_performAttackOnBuilding']) {
        const original=Unit.prototype[method];
        Unit.prototype[method]=function(target) {
            const a=byObject.get(this),b=byObject.get(target);
            if(a&&b&&a.g!==b.g) {a.g.crossAttacks++;b.g.crossAttacks++;}
            return original.apply(this,arguments);
        };
    }
    const start=gameTime;
    __scratch.probe={teams,start,groups,sample() {
        for(const g of groups) for(const side of g.sides) for(const d of side) {
            const e=d.e;
            if(e.dead || !(e.energy>0)) continue;
            if(e instanceof Unit) {
                const tx=Math.floor(e.x/TILE),ty=Math.floor(e.y/TILE);
                g.astarEstimate[e.owner]+=Math.max(Math.abs(tx-d.tileX),Math.abs(ty-d.tileY))*_resolveUnitAstarTileCost(e);
                d.tileX=tx;d.tileY=ty;
            }
            if(e instanceof Unit && !d.left) {
                const b=g.arena.bounds,x=e.x/TILE,y=e.y/TILE;
                if(x<b[0]-8||x>b[2]+8||y<b[1]-8||y>b[3]+8) {d.left=true;g.leftBounds++;}
            }
        }
    },result() {
        const histogram=(side,end)=>{const h={};for(const d of side){if(end&&(d.e.dead||!(d.e.energy>0)))continue;const level=end?(d.e instanceof Unit?getUnitEffectiveLevel(d.e):getThingEffectiveLevel(d.e,getThingBaseLevel(d.e))):d.initialEffectiveLevel;h[level]=(h[level]||0)+1;}return h;};
        return {simulationSeconds:(gameTime-start)/TICK_RATE,gameOver,localDefeated,teams,
            upkeepAccounting:'native-second-boundary-quantized-rates',
            arenas:groups.map(g=>({...g.arena,crossAttacks:g.crossAttacks,leftBounds:g.leftBounds,astar:g.astar,astarEstimate:g.astarEstimate,
                sides:g.sides.map(side=>({initial:side.length,alive:side.filter(d=>!d.e.dead&&d.e.energy>0).length,
                    hpInitial:side.reduce((s,d)=>s+d.initial,0),hpRemaining:side.reduce((s,d)=>s+(!d.e.dead?Math.max(0,d.e.energy):0),0),
                    upkeepEnergyExposure:side.reduce((s,d)=>s+d.upkeep,0),effectiveLevelsStart:histogram(side,false),effectiveLevelsEnd:histogram(side,true)}))}))};
    }};
}
async function worker(job) {
    if(fs.existsSync(path.join(job.options.out,'.stop'))) throw new Error('Run stopped by request');
    const H=require('../net-harness.cjs');
    const t0=performance.now();
    const records=JSON.parse(zlib.gunzipSync(fs.readFileSync(job.file)));
    const world=new H.World(), inst=world.spawn(job.scenario.name,{simWorker:false});
    inst.scratch.scene={header:records[0],records:records.slice(1,-1)};
    inst.scratch.scenario=job.scenario;
    inst.eval('startMainThreadLoops=()=>{}; document.getElementById("starting-resources-popup").classList.add("hidden");');
    // startGame is synchronous here; applySoloScene is reached before the await
    // in restore's optional worker branch, with page simulation selected.
    await inst.eval('restoreSoloGameSnapshot(__scratch.scene)');
    // Feed real work timings to the game's existing adaptive pace controller.
    inst.scratch.realNow=()=>performance.now();
    inst.eval('performance.now=__scratch.realNow; netResetSimulationPace();');
    inst.eval('('+installProbe.toString()+')()');
    const loadMs=performance.now()-t0, began=performance.now();
    let ticks=0,lastNotice=began,nextDue=began,gameSeconds=0;
    const dkHistogram={};
    while(job.options.timeBasis==='wall' ? performance.now()-began<job.options.seconds*1000 : gameSeconds<job.options.seconds) {
        if(fs.existsSync(path.join(job.options.out,'.stop'))) throw new Error('Run stopped by request');
        const delay=nextDue-performance.now();
        if(delay>0) await new Promise(resolve=>setTimeout(resolve,delay));
        if(job.options.timeBasis==='wall' && performance.now()-began>=job.options.seconds*1000) break;
        const t=performance.now();
        inst.eval('netHostUpdateSimulationPace(performance.now()); runOneTick(); __scratch.probe.sample()'); ticks++;
        const dk=inst.eval('simDk');dkHistogram[dk]=(dkHistogram[dk]||0)+1;
        gameSeconds=inst.eval('(gameTime-__scratch.probe.start)/TICK_RATE');
        nextDue+=inst.eval('netSimulationTickMs()');
        if(inst.errors.length) throw new Error(inst.errors.map(String).join('\n'));
        if(inst.eval('gameOver')) throw new Error('Unexpected match end at tick '+ticks);
        if(performance.now()-lastNotice>15000) {process.send?.({progress:{name:job.scenario.name,ticks,seconds:inst.eval('(gameTime-__scratch.probe.start)/TICK_RATE'),elapsed:(performance.now()-began)/1000}});lastNotice=performance.now();}
        if(ticks%10===0) await new Promise(resolve=>setImmediate(resolve));
        job.tickMs.push(performance.now()-t);
    }
    const result=inst.eval('__scratch.probe.result()');
    const sorted=job.tickMs.sort((a,b)=>a-b);
    return {...result,name:job.scenario.name,fingerprint:job.fingerprint,requestedSeconds:job.options.seconds,timeBasis:job.options.timeBasis,
        stepping:'game-adaptive-delta-ticks',backend:'headless page simulation; rendering excluded',dkHistogram,
        loadMs,wallSeconds:(performance.now()-began)/1000,ticks,tickMs:{mean:sorted.reduce((a,b)=>a+b,0)/ticks,p95:sorted[Math.min(sorted.length-1,Math.floor(sorted.length*.95))],max:sorted.at(-1)},errors:inst.errors};
}
function buildReport(manifest,results,out) { return require("./fight-report.cjs").buildReport(manifest,results,out); }

async function main() {
    const o=options(process.argv.slice(2));
    fs.mkdirSync(o.out,{recursive:true});
    if(o.stop) {fs.writeFileSync(path.join(o.out,'.stop'),'stop requested\n');console.log('Stop requested; active scenarios stop at their next tick boundary.');return;}
    if(fs.existsSync(path.join(o.out,'.stop'))) fs.unlinkSync(path.join(o.out,'.stop'));
    if(o.regenerate)for(const generator of ['generate-scenarios.cjs','generate-energy-scenarios.cjs']) {
        if(fs.existsSync(path.join(o.out,'.stop')))return;
        const save=line=>fs.writeFileSync(path.join(o.out,'progress.json'),JSON.stringify({status:'regenerating',updatedAt:new Date().toISOString(),generator,lastProgress:line,report:'report.html'},null,2));
        save('Starting');
        await new Promise((resolve,reject)=>{
            const child=spawn(process.execPath,[path.join(__dirname,generator)],{stdio:['ignore','pipe','inherit']});
            child.stdout.on('data',chunk=>{process.stdout.write(chunk);save(chunk.toString().trim());});
            child.on('error',reject);child.on('exit',code=>code===0?resolve():reject(new Error(generator+' exited '+code)));
        });
    }
    if(fs.existsSync(path.join(o.out,'.stop')))return;
    const manifest=JSON.parse(fs.readFileSync(path.join(ROOT,'manifest.json')));
    const hash=require('node:crypto').createHash('sha256');
    const H=require('../net-harness.cjs'); for(const file of H.SOURCE_FILES) hash.update(fs.readFileSync(path.join(__dirname,'../..',file)));
    hash.update(installProbe.toString()); hash.update(worker.toString()); const sourceHash=hash.digest('hex');
    const patterns=o.scenarios.map(s=>new RegExp('^'+path.basename(s).replace(/\.json\.gz$/,'').split('*').map(x=>x.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('.*')+'$'));
    const selected=manifest.scenarios.filter(s=>s.kind!=='work'&&patterns.some(p=>p.test(s.name)));
    // Compare the two budgets close together instead of waiting for the entire
    // equal-number sweep before producing any equal-energy measurements.
    selected.sort((a,b)=>a.research-b.research||manifest.catalog.findIndex(t=>t.id===a.focal)-manifest.catalog.findIndex(t=>t.id===b.focal)||Number(a.balanceMode==='equal-energy')-Number(b.balanceMode==='equal-energy'));
    if(!selected.length) throw new Error('No fight scenarios matched');
    let cursor=0,done=0;const results=[],failures=[],active={};
    const startedAt=new Date().toISOString();
    function progress(status='running') {
        const file=path.join(o.out,'progress.json'),temp=file+'.tmp';
        fs.writeFileSync(temp,JSON.stringify({status,startedAt,updatedAt:new Date().toISOString(),total:selected.length,completed:done,failed:failures.length,active,failures,report:'report.html'},null,2));
        fs.renameSync(temp,file);
    }
    progress();
    console.log(`Running ${selected.length} scenarios, ${o.seconds} ${o.timeBasis} seconds each, jobs=${o.jobs}; free RAM ${(os.freemem()/2**30).toFixed(1)} GiB`);
    await Promise.all(Array.from({length:Math.min(o.jobs,selected.length)},async()=>{
        for(;;) {
            const scenario=selected[cursor++];if(!scenario) break;
            const file=path.resolve(ROOT,scenario.file),output=path.join(o.out,scenario.name+'.json');
            if(fs.existsSync(path.join(o.out,'.stop'))) {progress('stopped');return;}
            active[scenario.name]={phase:'loading'};progress();
            const stat=fs.statSync(file),fingerprint=[sourceHash,stat.size,stat.mtimeMs,o.seconds,o.timeBasis].join(':');
            let result;
            if(o.resume&&fs.existsSync(output)) {const old=JSON.parse(fs.readFileSync(output));if(old.fingerprint===fingerprint) result=old;}
            try { if(!result) result=await new Promise((resolve,reject)=>{
                const child=fork(__filename,['--child'],{execArgv:['--max-old-space-size=6144'],stdio:['ignore','inherit','inherit','ipc']});
                let answer=false;
                child.on('message',m=>{if(m.progress) {active[scenario.name]={phase:'measuring',...m.progress};progress();console.log(`${m.progress.name}: ${m.progress.seconds.toFixed(1)} sim s / ${m.progress.elapsed.toFixed(1)} wall s`);}if(m.result){answer=true;resolve(m.result);child.disconnect();}if(m.error)reject(new Error(m.error));});
                child.on('error',reject);child.on('exit',code=>{if(!answer)reject(new Error('Scenario process exited '+code));});
                child.send({file,scenario,options:o,fingerprint,tickMs:[]});
            }); } catch(error) {
                delete active[scenario.name];
                if(fs.existsSync(path.join(o.out,'.stop'))) {progress('stopped');return;}
                failures.push({name:scenario.name,error:error.stack});progress();console.error('Failed '+scenario.name+': '+error.message);continue;
            }
            fs.writeFileSync(output,JSON.stringify(result,null,2));results.push(result);done++;
            buildReport(manifest,results,o.out);
            delete active[scenario.name];progress();
            console.log(`Completed ${done}/${selected.length}: ${scenario.name} (${result.wallSeconds.toFixed(1)}s wall)`);
        }
    }));
    progress(fs.existsSync(path.join(o.out,'.stop'))?'stopped':failures.length?'completed-with-errors':'completed');
    console.log('Report: '+path.join(o.out,'report.md'));
}
if(process.argv.includes('--child')) process.once('message',job=>worker(job).then(result=>{process.send({result},()=>process.exit(0));},e=>{process.send({error:e.stack},()=>process.exit(1));}));
else if(require.main===module) main().catch(e=>{console.error(e);process.exitCode=1;});
module.exports={buildReport,options};
