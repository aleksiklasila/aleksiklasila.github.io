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
const chunkSize = number('chunk-size', 1);
const occupancy=!process.argv.includes('--no-occupancy'),occupancyPlanes=number('occ-planes',1);
const packed=process.argv.includes('--packed')||(occupancy&&!process.argv.includes('--no-packed'));
const movementProfile=process.argv.includes('--movement-profile');
const contactBudget=number('contact-budget',8);
const acquisitionSamples=number('acq-samples',0);
const areaTargets=!process.argv.includes('--exact-targets');
const memoryInventory=process.argv.includes('--memory-inventory');
const denseJsCache=process.argv.includes('--dense-js-cache');
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
for (const v of [count, map, ticks, group, dk, chunkSize]) assert.ok(Number.isInteger(v) && v > 0);
assert.ok(Number.isInteger(warmup) && warmup >= 0);
assert.ok(Number.isInteger(acquisitionSamples)&&acquisitionSamples>=0&&acquisitionSamples<=256&&acquisitionSamples%4===0,'acq-samples must be 0 or a multiple of four through 256');
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
// Preserve production's tile-sized index. Each run gets a source fixture
// before the VM is created; CHUNK_SIZE is a lexical constant in that VM.
if(chunkSize!==1){
    const fixture=path.resolve(out+'.data-static.js');
    fs.mkdirSync(path.dirname(fixture),{recursive:true});
    const source=fs.readFileSync(path.join(__dirname,'../src/data/data_static.js'),'utf8');
    assert.match(source,/const CHUNK_SIZE = 1;/);
    fs.writeFileSync(fixture,source.replace('const CHUNK_SIZE = 1;',`const CHUNK_SIZE = ${chunkSize};`));
    const overrides=JSON.parse(process.env.DEFENCE_TEST_SOURCE_OVERRIDES||'{}');
    overrides['src/data/data_static.js']=fixture;
    process.env.DEFENCE_TEST_SOURCE_OVERRIDES=JSON.stringify(overrides);
}
if(denseJsCache){
    const overrides=JSON.parse(process.env.DEFENCE_TEST_SOURCE_OVERRIDES||'{}');
    for(const [name,file]of [['src/sim/sim_unit_state.js','baseline-state.js'],['src/things/unit.js','baseline-unit.js']])
        overrides[name]='tests/test-runs/memory-4m-20261021/'+file;
    process.env.DEFENCE_TEST_SOURCE_OVERRIDES=JSON.stringify(overrides);
}
const H = require('./net-harness.cjs');
const controls = { ...H.SMALL_MATCH_CONTROLS, 'cfg-mapsize': String(map), 'cfg-map-type': 'arena',
    'cfg-gold-count': '0', 'cfg-astar-mine-count': '0', 'cfg-full-vis': 'full',
    'cfg-max-pop': String(Math.ceil(count/2)), 'cfg-starting-energy': '1000000000000000', 'cfg-starting-astar': '1000000000000000' };
const world = new H.World({ controls });
const inst = world.spawn('checkerboard', { controls, simWorker: false });
inst.eval('SIM_OCCUPANCY_ENABLED='+occupancy+';SIM_OCCUPANCY_PLANES='+occupancyPlanes);
inst.eval('UNIT_SEPARATION_PAIR_BUDGET='+contactBudget+';if(typeof SIM_SHARED_HOT_STATS!=="undefined")SIM_SHARED_HOT_STATS='+sharedStats);
inst.eval('SIM_ACQ_SAMPLE_BUDGET='+acquisitionSamples);
inst.eval('SIM_ACQ_AREA_TARGETS='+areaTargets);
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
        const initial = units.length, groups = Math.ceil((${count} - initial) / ${group * 2}) + (${packed}?128:0);
        const side = Math.ceil(Math.sqrt(groups)), step = (GRID_W - 8) / side;
        if (step < 3) throw Error('Too many groups for map; increase --group or --map');
        const types = ['pistol','smg','sniper','water','poison'];
        simUnitStateReserve(Math.max(0, ${count} - initial));
        let added = initial;
        const reserved=units.map(u=>[u.x,u.y,Math.max(16,u.r+8)]);
        for (let b=0; b<groups && added<${count}; b++) {
            const gx = 3 + Math.floor((b % side) * step), gy = 3 + Math.floor(Math.floor(b / side) * step);
            for (let owner=0; owner<2; owner++) {
                const tx = gx + owner * 2, ty = gy;
                if (!getTileEntityRef(tx, ty)) placeBuilding(tx,ty,types[b % types.length],owner,
                    {silent:true,ignorePlacementRules:true});
                const tower = getTileEntityRef(tx,ty);
                if (tower) { tower.energy=tower.maxEnergy; markConstructionComplete(tower); tower.updateStats(); }
                for (let j=0; j<${group} && added<${count}; j++) {
                    const x=${packed}?(gx*TILE+8+(j%8)*16):(gx + owner*2 + .25 + (j%8)*.18)*TILE;
                    const y=${packed}?(gy*TILE+8+(owner*4+Math.floor(j/8))*16):(gy + 1.25 + Math.floor(j/8)*.18)*TILE;
                    if(${packed} && reserved.some(v=>Math.abs(x-v[0])<v[2] && Math.abs(y-v[1])<v[2]))continue;
                    const u=new Unit('norm',owner,x,y);
                    if(u.dead)throw Error('Occupancy rejected benchmark spawn at '+x+','+y);
                    units.push(u); players[owner].popCount++; updateUnitSpatial(u);
                    added++;
                }
            }
        }
        recalculateAdjacency(); simDk=${dk};
        __scratch.initial={units:units.length,towers:towers.length,groups,map:[GRID_W,GRID_H]};
    }`);
// Coarse phases only: avoid wrapping individual units or candidate queries.
inst.eval(`__scratch.phases={}; __scratch.phaseSelf={}; __scratch.phaseStack=[]; __scratch.measuring=false;
    for (const name of ['spatialIndexRebuild','navTick','navFieldsFlush','recalculateUnitEffectiveLevel',
        'updateAllPlayerVisibility','towersTick','projectilesBegin',
        'statusPrepassRun','separationStart','unitPassBegin','simMoveRun','combatScanRun',
        '_forEachUnitInTickOrder','unitHitsResolve','visCoverHoldEnd','unitRetirePrepare',
        'simParallelRun','simParallelBackgroundWait','_simMoveSepListed','_simMoveChargeSteps',
        'simUnitStateCollect','runUnitSeparationPass','occupancyPrepareMovement','spawnerStructuresTick','processGlobalSpawnerQueue',
        '_simMoveBuildHostile','_simMoveWalls','_simMoveAreaBoxes','_simAreaCsr','_simMoveEnsureAreaBox']) {
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
    const profileWorkers=movementProfile && helpers ? require('./real-sim-helper.cjs').instances||[] : [];
    if(movementProfile){inst.eval('new Uint32Array(_simWasmMem.buffer,_simWasmArgs+1536*4,64).fill(0)');await Promise.all(profileWorkers.map(w=>w.benchProfile('start')));}
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
        const row={at:Date.now(),tick:t+1,ms,units:inst.eval('units.length'),memory:process.memoryUsage(),resourceUsage:process.resourceUsage(),freeBytes:require('node:os').freemem(),heap:heapStats(),occupancy:occupancy?inst.eval('occupancyStats()'):null};
        timeline.push(row);console.error('tick',t+1,ms.toFixed(1));
        fs.appendFileSync(out+'.jsonl',JSON.stringify(row)+'\n');
    }
    const measuredEnd=Date.now(), resourcesAfter=process.resourceUsage();
    const inventory=memoryInventory?inst.eval(`(()=>{
        const buffers=new Map(),regions=new Map(),S=_simUnitState;
        const add=(name,a)=>{
            if(!a||!ArrayBuffer.isView(a))return;
            const heap=simHeapHas(a),id=heap?'wasm':buffers.has(a.buffer)?buffers.get(a.buffer):'external'+buffers.size;
            if(!heap&&!buffers.has(a.buffer))buffers.set(a.buffer,id);
            const key=id+':'+a.byteOffset+':'+a.byteLength;
            if(regions.has(key)){regions.get(key).names.push(name);return;}
            regions.set(key,{names:[name],heap,buffer:id,offset:a.byteOffset,bytes:a.byteLength,type:a.constructor.name});
        };
        for(const [name,a]of Object.entries(_simParReg))add(name,a);
        for(const [name,a]of Object.entries(S.columns))add('columns.'+name,a);
        const jsFields=[];
        for(const [name,kind,def]of SIM_UNIT_JS_FIELDS){
            if(kind==='r')continue;
            const a=S.columns[_simJsName(name,kind)],value=_simJsDefault(kind,def);let populated=0;
            const sparse=typeof SimSparseIntColumn!=='undefined'&&a instanceof SimSparseIntColumn;
            if(sparse)populated=a.populated;
            else for(let s=0;s<S.owners.length;s++)if(!Object.is(a[s],value))populated++;
            jsFields.push({name,kind,bytes:a.byteLength,populated,slots:S.owners.length,sparse,pages:sparse?a.activePages:undefined});
        }
        return {cap:S.cap,slots:S.owners.length,bytesPerSlot:_simUnitBytesPerSlot(),heap:simHeapStats(),jsFields,
            regions:[...regions.values()].sort((a,b)=>b.bytes-a.bytes)};
    })()`):null;
    let movementCounters=null;
    if(movementProfile){
        const results=await Promise.all(profileWorkers.map(w=>w.benchProfile('stop')));
        movementCounters=[inst.eval('Array.from(new Uint32Array(_simWasmMem.buffer,_simWasmArgs+1536*4,64))'),...results.map(r=>r.counters)];
        results.forEach((r,j)=>fs.writeFileSync(out+'.worker-'+(j+1)+'.cpuprofile',JSON.stringify(r.profile)));
    }
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
    const occupancyAuditResult=occupancy?inst.eval('occupancyAudit()'):null;
    let occupancyProbes=null;
    if(process.argv.includes('--occupancy-probes')){
        inst.scratch.probeNow=()=>performance.now();
        occupancyProbes=inst.eval(`(()=>{
            const O=_occ,copies=8,a=simHeapArray(Uint32Array,O.bits.length*copies);
            for(let k=0;k<copies;k++)a.set(O.bits,k*O.bits.length);
            const args=_occupancyAddresses();args[0]=_simWEnc(a.byteOffset);const results=[];
            for(const v of [0,1])for(const c of [1,8])_simWasmX.occ_probe_bench(...args,O.w,O.h,O.stride,O.cell,O.planes,_simUnitState.owners.length,8,c,v);
            for(const [v,c] of [[0,1],[1,1],[0,8],[1,8],[1,8],[0,8],[1,1],[0,1]]){const start=__scratch.probeNow();const checksum=_simWasmX.occ_probe_bench(...args,O.w,O.h,O.stride,O.cell,O.planes,_simUnitState.owners.length,8,c,v);
                results.push({variant:v,copies:c,workingSetMiB:c*O.bits.byteLength/1048576,ms:__scratch.probeNow()-start,checksum});}
            simHeapFree(a);return results;
        })()`);
        assert.ok(occupancyProbes.every(r=>r.checksum===occupancyProbes[0].checksum),'Full-footprint and fringe queries must give identical answers');
    }
    if(occupancy)assert.ok(occupancyAuditResult.ok,'Occupancy bitmap lost or duplicated footprint cells: '+JSON.stringify(occupancyAuditResult));
    assert.deepEqual(inst.errors.map(String),[]);
    assert.equal(inst.eval('gameOver'),false);
    samples.sort((a,b)=>a-b);
    const mean=samples.reduce((a,b)=>a+b,0)/ticks;
    const result={node:process.version,cpu:require('node:os').cpus()[0].model,initial:inst.scratch.initial,
        final:inst.eval('(()=>{const parts={};const hash=computeLockstepStateHashFast(gameTime,parts);return {units:units.length,towers:towers.length,tick:gameTime,hash,parts};})()'),
        ticks,warmup,warmupMs,measuredStart,measuredEnd,pmc,group,helpers,dk,chunkSize,occupancy,occupancyPlanes,occupancyAuditResult,occupancyProbes,packed,movementCounters,contactBudget,acquisitionSamples,areaTargets,denseJsCache,sharedStats,cachedLayout,statLayout,referenceStorage,referenceKernel,referenceCollect,kernelFile,shareNavigation,tickMs:{mean,p50:samples[ticks>>1],p95:samples[Math.min(ticks-1,Math.floor(ticks*.95))]},
        tps:1000/mean,setup,timeline,phases:Object.fromEntries(Object.entries(inst.scratch.phases).map(([k,v])=>[k,v/ticks]).sort((a,b)=>b[1]-a[1])),
        phaseSelf:Object.fromEntries(Object.entries(inst.scratch.phaseSelf).map(([k,v])=>[k,v/ticks]).sort((a,b)=>b[1]-a[1])),top,bindings:bindings(),
        resourceUsage:{before:resourcesBefore,after:resourcesAfter},inventory,statStorage:inst.eval('SIM_UNIT_SCHEMA.mvSpd ? "instance-cache" : "shared-row-only"'),referenceColumns:inst.eval('Object.entries(_simUnitState.columns).filter(([k,v])=>v instanceof SimRefColumn).map(([name,v])=>({name,slots:v.length,bytes:v.data?v.data.byteLength:undefined,unique:v.pool?v.pool.values.length:undefined,pages:v.pages.filter(Boolean).length,values:v.pages.reduce((n,p)=>n+(p?p.used:0),0)}))'),memory:process.memoryUsage()};
    fs.writeFileSync(out,JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));
}
main().then(()=>process.exit(0),e=>{
    console.error(e);console.error(inst.errors.map(String));
    console.error(inst.eval('JSON.stringify({heap:simHeapStats(),bad:Object.keys(_simParReg).filter(k=>_simParReg[k]&&_simParWPtr[k]<0).map(k=>({name:k,length:_simParReg[k].length}))})'));
    process.exitCode=1;setTimeout(()=>process.exit(1),250);
});
