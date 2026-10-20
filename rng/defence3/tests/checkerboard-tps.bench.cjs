// Real main-thread simulation, no rendering/transport. Run serially.
// node --max-old-space-size=12000 tests/checkerboard-tps.bench.cjs --units=4000000 --map=1000 --ticks=20 --warmup=5 --profile
// Smaller --units keeps the same local density, spreading blocks over the map.
// At 4M use a memory64-capable runtime (Node 24+); Node 22 hits the 4 GiB heap ceiling.
'use strict';
const fs = require('node:fs'), path = require('node:path');
const { performance } = require('node:perf_hooks');
const assert = require('node:assert/strict');
const number = (key, fallback) => Number(process.argv.find(a => a.startsWith('--' + key + '='))?.split('=')[1] ?? fallback);
const count = number('units', 4000000), map = number('map', 1000);
const ticks = number('ticks', 20), warmup = number('warmup', 5), group = number('group', 32);
const helpers = number('helpers', 7), dk = number('dk', 1);
const contactBudget=number('contact-budget',8);
const sharedStats=number('shared-stats',1)!==0;
const statLayout=process.argv.find(a=>a.startsWith('--stat-layout='))?.slice(14)||'soa';
const referenceStorage=process.argv.includes('--reference-storage');
const referenceKernel=process.argv.includes('--reference-kernel');
const referenceCollect=process.argv.includes('--reference-collect');
const kernelFile=process.argv.find(a=>a.startsWith('--wasm64='))?.slice(9);
const shareNavigation=!process.argv.includes('--no-nav-sharing');
const traceCapacity=Math.ceil(1280000/(helpers+1));
const contactTrace=process.argv.includes('--contact-trace') ? {
    capacity: traceCapacity, thread: 0, control: new SharedArrayBuffer(128 * 4),
    events: new SharedArrayBuffer((helpers + 1) * traceCapacity * 6 * 8)
} : null;
const out=process.argv.find(a=>a.startsWith('--out='))?.slice(6) || path.join(__dirname,'test-runs/checkerboard-tps/latest.json');
for (const v of [count, map, ticks, group, dk]) assert.ok(Number.isInteger(v) && v > 0);
assert.ok(Number.isInteger(warmup) && warmup >= 0);
if (helpers) globalThis.self = { crossOriginIsolated: true };
const cachedLayout=process.argv.includes('--cached-layout');
if(cachedLayout){
 const base='tests/test-runs/collision-tps-20261020/';
 process.env.DEFENCE_TEST_SOURCE_OVERRIDES=JSON.stringify(Object.fromEntries([
 ['src/sim/sim_unit_state.js','cached-unit-state.js'],['src/things/unit.js','cached-unit.js'],
 ['src/sim/sim_parallel.js','cached-parallel.js'],['src/things/things_utils.js','cached-things-utils.js'],
 ['src/data/data_dynamic.js','cached-data-dynamic.js'],['src/data/data_state.js','cached-data-state.js'],
 ['src/sim/sim_wasm_bin.js','cached-wasm32.js'],['src/sim/sim_wasm64_bin.js','cached-wasm64.js']
 ].map(([a,b])=>[a,base+b])));
}
if(process.argv.includes('--cached-structures')) {
 const base='tests/test-runs/structure-stats-20261020/';
 process.env.DEFENCE_TEST_SOURCE_OVERRIDES=JSON.stringify(Object.fromEntries([
 ['src/data/data_state.js','baseline-data-state.js'],['src/data/data_dynamic.js','baseline-data-dynamic.js'],
 ['src/things/things_utils.js','baseline-things-utils.js'],['src/things/tower.js','baseline-tower.js'],['src/things/barrack.js','baseline-barrack.js']
 ].map(([a,b])=>[a,base+b])));
}
const H = require('./net-harness.cjs');
const controls = { ...H.SMALL_MATCH_CONTROLS, 'cfg-mapsize': String(map), 'cfg-map-type': 'arena',
    'cfg-gold-count': '0', 'cfg-astar-mine-count': '0', 'cfg-full-vis': 'full',
    'cfg-max-pop': String(Math.ceil(count/2)), 'cfg-starting-energy': '1000000000000000', 'cfg-starting-astar': '1000000000000000' };
const world = new H.World({ controls });
const inst = world.spawn('checkerboard', { controls, simWorker: false });
inst.eval('UNIT_SEPARATION_PAIR_BUDGET='+contactBudget+';if(typeof SIM_SHARED_HOT_STATS!=="undefined")SIM_SHARED_HOT_STATS='+sharedStats);
inst.eval('if(typeof SIM_THING_STATS_LAYOUT!=="undefined")SIM_THING_STATS_LAYOUT='+JSON.stringify(statLayout));
inst.scratch.now = () => performance.now();
const setupStart = performance.now();
let referenceKernelHash=null;
const heapStats=()=>{const stats=inst.eval('simHeapStats()');if(referenceKernelHash)stats.hash=referenceKernelHash;return stats;};
fs.mkdirSync(path.dirname(path.resolve(out)),{recursive:true});
fs.writeFileSync(out+'.jsonl','');
if(referenceKernel||kernelFile) {
    const ctx={};require('node:vm').runInNewContext(fs.readFileSync(kernelFile||path.join(__dirname,'fixtures/checkerboard-kernels/wasm64.js'),'utf8')+';this.bin=SIM_WASM64_BIN;this.hash=SIM_WASM64_HASH;',ctx);
    referenceKernelHash=ctx.hash;
    inst.scratch.referenceKernel=Buffer.from(ctx.bin,'base64');
    inst.eval('_simWasm64Bytes=()=>__scratch.referenceKernel');
}
if(!shareNavigation)inst.eval('_navShareBuild=()=>null');
// Match production startup: helpers exist before bulk entity creation.
if (helpers) {
    inst.scratch.Worker = require('./real-sim-helper.cjs');
    if (contactTrace) { inst.scratch.Worker.contactTrace = contactTrace; inst.scratch.Worker.traceThread = 0; }
    inst.eval(`Worker=__scratch.Worker; navigator.hardwareConcurrency=32; simParallelInit('',${helpers});`);
}
// Reproduce the original storage policies without a checkout or changing
// simulation behavior. Use the original WASM build for a kernel baseline.
if(referenceStorage)inst.eval(`UnitIdIndex=Map; simReserveCap=(n,min=1024)=>Math.max(min,Math.ceil(n*1.125/4096)*4096);`);
if(referenceCollect)inst.eval(`simUnitStateCollect=function(all=false){
    const S=_simUnitState;if(!S)return;const owners=S.owners;
    if(S.unitsRef!==units){S.unitsRef=units;if(++S.epoch===0xffffffff){S.stamp.fill(0);S.epoch=1;}
        for(let i=0;i<units.length;i++){const u=units[i];if(u&&u._us===S.columns)S.stamp[u._si]=S.epoch;}
        for(let s=0;s<owners.length;s++)if(owners[s]&&S.stamp[s]!==S.epoch)simUnitStateDetach(S,s);return;}
    const step=all?1:SIM_UNIT_COLLECT_SLICES,DEAD=S.columns.dead;
    for(let s=all?0:gameTime%step;s<owners.length;s+=step){if(DEAD[s]!==1)continue;const u=owners[s];
        if(u&&u._us===S.columns&&u._si===s)simUnitStateDetach(S,s);else if(u&&u.dead)simUnitStateDetach(S,s);}
};`);
inst.eval(`startingResourcesConfig = normalizeStartingResourcesConfig({spawnCounts:{},researchLevels:{}});
    applyMainMenuControlsToRuntimeState(); startSoloGame();
    // Keep the starting kings/buildings for ordinary victory/population rules.
    // Every occupied block: two small hostile groups and two hostile towers.
    // Block centres are distributed row-major over the whole map.
    {
        const initial = units.length, groups = Math.ceil((${count} - initial) / ${group * 2});
        const side = Math.ceil(Math.sqrt(groups)), step = (GRID_W - 8) / side;
        if (step < 3) throw Error('Too many groups for map; increase --group or --map');
        const types = ['pistol','smg','sniper','water','poison'];
        simUnitStateReserve(Math.max(0, ${count} - initial));
        let added = initial;
        for (let b=0; b<groups; b++) {
            const gx = 3 + Math.floor((b % side) * step), gy = 3 + Math.floor(Math.floor(b / side) * step);
            for (let owner=0; owner<2; owner++) {
                const tx = gx + owner * 2, ty = gy;
                if (!getTileEntityRef(tx, ty)) placeBuilding(tx,ty,types[b % types.length],owner,
                    {silent:true,ignorePlacementRules:true});
                const tower = getTileEntityRef(tx,ty);
                if (tower) { tower.energy=tower.maxEnergy; markConstructionComplete(tower); tower.updateStats(); }
                for (let j=0; j<${group} && added<${count}; j++,added++) {
                    const x=(gx + owner*2 + .25 + (j%8)*.18)*TILE;
                    const y=(gy + 1.25 + Math.floor(j/8)*.18)*TILE;
                    const u=new Unit('norm',owner,x,y);
                    units.push(u); players[owner].popCount++; updateUnitSpatial(u);
                }
            }
        }
        recalculateAdjacency(); simDk=${dk};
        __scratch.initial={units:units.length,towers:towers.length,groups,map:[GRID_W,GRID_H]};
    }`);
// Coarse phases only: avoid wrapping individual units or candidate queries.
inst.eval(`__scratch.phases={}; __scratch.phaseSelf={}; __scratch.phaseStack=[]; __scratch.measuring=false;
    for (const name of ['spatialIndexRebuild','navTick','navFieldsFlush','recalculateUnitEffectiveStats',
        'recalculateThingPrecomputedStats','updateAllPlayerVisibility','towersTick','projectilesBegin',
        'statusPrepassRun','separationStart','unitPassBegin','simMoveRun','combatScanRun',
        '_forEachUnitInTickOrder','unitHitsResolve','visCoverHoldEnd','unitRetirePrepare',
        'simParallelRun','simParallelBackgroundWait','_simMoveSepListed','_simMoveChargeSteps',
        'simUnitStateCollect','runUnitSeparationPass','spawnerStructuresTick','processGlobalSpawnerQueue']) {
        const original=eval(name);
        const wrapped=function(){
            if(!__scratch.measuring)return original.apply(this,arguments);
            const stack=__scratch.phaseStack, frame={start:__scratch.now(),child:0};stack.push(frame);
            try{return original.apply(this,arguments);}
            finally{
                const dt=__scratch.now()-frame.start;stack.pop();
                const label=name==='simParallelRun'?name+':'+arguments[0]:name;
                __scratch.phases[label]=(__scratch.phases[label]||0)+dt;
                __scratch.phaseSelf[label]=(__scratch.phaseSelf[label]||0)+dt-frame.child;
                if(stack.length)stack[stack.length-1].child+=dt;
            }
        };
        eval(name+'=wrapped');
    }`);
const bindings=()=>inst.eval('Object.entries(_simParReg).filter(([k,v])=>ArrayBuffer.isView(v)).map(([name,v])=>({name,type:v.constructor.name,bytes:v.byteLength})).sort((a,b)=>b.bytes-a.bytes)');
const setup={ ...inst.scratch.initial, ms: performance.now()-setupStart, heap:heapStats(), memory:process.memoryUsage() };
if (contactTrace) {
    inst.scratch.contactTrace=contactTrace;
    if(process.argv.includes('--capture-contacts')) inst.scratch.captureContact=sample=>fs.writeFileSync(out+'.chunk-'+sample.tick+'.json',JSON.stringify(sample));
    inst.eval(fs.readFileSync(path.join(__dirname,'contact-trace.js'),'utf8'));
}
console.error('setup', JSON.stringify(setup));
async function main() {
    const warmupMs=[];
    for(let t=0;t<warmup;t++) {const start=performance.now();inst.eval('gameTick();currentTick++');warmupMs.push(performance.now()-start);console.error('warmup',t+1,warmupMs.at(-1).toFixed(1));}
    const session = new (require('node:inspector').Session)();
    const post=(method,params={})=>new Promise((resolve,reject)=>session.post(method,params,(e,r)=>e?reject(e):resolve(r)));
    if(process.argv.includes('--profile')) {session.connect();await post('Profiler.enable');await post('Profiler.start');}
    let pmc=null;
    if(process.argv.includes('--wpr')){
        const result=cp.spawnSync('wpr',['-start','tests/memory-traffic.wprp!Traffic','-filemode','-recordtempto',path.dirname(path.resolve(out))],{encoding:'utf8',windowsHide:true});
        pmc={status:result.status,output:(result.stdout||'')+(result.stderr||'')};
        if(result.status!==0)throw Error('Hardware counters unavailable: '+pmc.output);
    }
    inst.scratch.measuring=true;
    if(contactTrace) Atomics.store(new Int32Array(contactTrace.control),0,1);
    const samples=[], timeline=[], resourcesBefore=process.resourceUsage(), measuredStart=Date.now();
    for(let t=0;t<ticks;t++) {
        if(contactTrace) Atomics.store(new Int32Array(contactTrace.control),1,t+1);
        const a=performance.now();inst.eval('gameTick();currentTick++');const ms=performance.now()-a;samples.push(ms);
        const row={at:Date.now(),tick:t+1,ms,units:inst.eval('units.length'),memory:process.memoryUsage(),resourceUsage:process.resourceUsage(),freeBytes:require('node:os').freemem(),heap:heapStats()};
        timeline.push(row);console.error('tick',t+1,ms.toFixed(1));
        fs.appendFileSync(out+'.jsonl',JSON.stringify(row)+'\n');
    }
    const measuredEnd=Date.now(), resourcesAfter=process.resourceUsage();
    if(contactTrace) Atomics.store(new Int32Array(contactTrace.control),0,0);
    const writeContactTrace=()=>{ if(contactTrace) {
        const ctl=new Int32Array(contactTrace.control), logs=new Float64Array(contactTrace.events), threads=[],truncatedThreads=[];
        for(let i=0;i<=helpers;i++) {
            let n=Atomics.load(ctl,16+i);if(n<0){truncatedThreads.push(i);n=contactTrace.capacity;}
            threads.push(Array.from(logs.subarray(i*contactTrace.capacity*6,i*contactTrace.capacity*6+n*6)));
        }
        const names=['../src/sim/sim_parallel.js','../src/game/flownav.js'].flatMap(f=>[...fs.readFileSync(path.join(__dirname,f),'utf8').matchAll(/\b(SIM_KERNEL_[A-Z0-9_]+)\s*=\s*\d+/g)].map(m=>m[1]));
        fs.writeFileSync(out+'.trace.json',JSON.stringify({columns:['kind','start','end','kernelOrLane','chunkOrStage','tickAtStart'],kinds:['kernel','backgroundWait','stageWait','foregroundRun','atomicWait'],truncatedThreads,threads,kernels:inst.eval('Object.fromEntries(['+names.map(n=>'['+JSON.stringify(n)+','+n+']').join(',')+'])')}));
    }};
    if(pmc){const result=cp.spawnSync('wpr',['-stop',out+'.etl'],{encoding:'utf8',windowsHide:true});pmc.stopStatus=result.status;if(result.status!==0)throw Error(result.stdout+result.stderr);}
    let top;
    if(process.argv.includes('--profile')) {
        const {profile}=await post('Profiler.stop');session.disconnect();fs.writeFileSync(out+'.cpuprofile',JSON.stringify(profile));
        const totals=new Map();for(let i=0;i<profile.samples.length;i++)totals.set(profile.samples[i],(totals.get(profile.samples[i])||0)+profile.timeDeltas[i]);
        top=profile.nodes.filter(n=>!['post','dispatch','(root)','(idle)','(program)'].includes(n.callFrame.functionName))
            .map(n=>({name:n.callFrame.functionName,line:n.callFrame.lineNumber,selfMs:(totals.get(n.id)||0)/1000})).sort((a,b)=>b.selfMs-a.selfMs).slice(0,25);
    }
    writeContactTrace();
    assert.deepEqual(inst.errors.map(String),[]);
    assert.equal(inst.eval('gameOver'),false);
    samples.sort((a,b)=>a-b);
    const mean=samples.reduce((a,b)=>a+b,0)/ticks;
    const result={node:process.version,cpu:require('node:os').cpus()[0].model,initial:inst.scratch.initial,
        final:inst.eval('(()=>{const parts={};const hash=computeLockstepStateHashFast(gameTime,parts);return {units:units.length,towers:towers.length,tick:gameTime,hash,parts};})()'),
        ticks,warmup,warmupMs,measuredStart,measuredEnd,pmc,group,helpers,dk,contactBudget,sharedStats,cachedLayout,statLayout,referenceStorage,referenceKernel,referenceCollect,kernelFile,shareNavigation,tickMs:{mean,p50:samples[ticks>>1],p95:samples[Math.min(ticks-1,Math.floor(ticks*.95))]},
        tps:1000/mean,setup,timeline,phases:Object.fromEntries(Object.entries(inst.scratch.phases).map(([k,v])=>[k,v/ticks]).sort((a,b)=>b[1]-a[1])),
        phaseSelf:Object.fromEntries(Object.entries(inst.scratch.phaseSelf).map(([k,v])=>[k,v/ticks]).sort((a,b)=>b[1]-a[1])),top,bindings:bindings(),
        resourceUsage:{before:resourcesBefore,after:resourcesAfter},statStorage:inst.eval('SIM_UNIT_SCHEMA.mvSpd ? "instance-cache" : "shared-row-only"'),referenceColumns:inst.eval('Object.entries(_simUnitState.columns).filter(([k,v])=>v instanceof SimRefColumn).map(([name,v])=>({name,slots:v.length,bytes:v.data?v.data.byteLength:undefined,unique:v.pool?v.pool.values.length:undefined,pages:v.pages.filter(Boolean).length,values:v.pages.reduce((n,p)=>n+(p?p.used:0),0)}))'),memory:process.memoryUsage()};
    fs.writeFileSync(out,JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));
}
main().then(()=>process.exit(0),e=>{
    console.error(e);console.error(inst.errors.map(String));
    console.error(inst.eval('JSON.stringify({heap:simHeapStats(),bad:Object.keys(_simParReg).filter(k=>_simParReg[k]&&_simParWPtr[k]<0).map(k=>({name:k,length:_simParReg[k].length}))})'));
    process.exitCode=1;setTimeout(()=>process.exit(1),250);
});
