// Headless real gameTick benchmark. No rendering, audio or network transport.
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const { execFileSync } = require('node:child_process');
const referenceRef=process.env.DEFENCE_BENCH_BASELINE || 'HEAD';
if (process.argv.includes('--compare') || process.argv.includes('--compare-extra')) {
    const extra=process.argv.includes('--compare-extra');
    const cases=extra ? [{scenario:'siege'}, {scenario:'combat',multiplayer:true}, {scenario:'rally',multiplayer:true}]
        : ['idle','moving','combat','working','rally','crowded'].map(scenario=>({scenario}));
    const results=[];
    for(let repeat=0;repeat<(extra?1:2);repeat++) for(const {scenario,multiplayer} of cases) {
        const pair=[];
        for(const baseline of (repeat%2 ? [false,true] : [true,false])) {
            const args=[__filename,scenario,...(baseline?['--baseline']:[]),...(multiplayer?['--multiplayer']:[])];
            const output=execFileSync(process.execPath,args,{encoding:'utf8',maxBuffer:8e6});
            const result=JSON.parse(output.trim().split('\n').at(-1));
            console.log(JSON.stringify({repeat,...result}));
            pair.push(result); results.push({repeat,...result});
        }
        require('node:assert/strict').equal(pair[0].state,pair[1].state,scenario+' gameplay replay');
        require('node:assert/strict').equal(pair[0].lockstep,pair[1].lockstep,scenario+' lockstep hash');
    }
    fs.writeFileSync(path.join(__dirname,extra?'large-battle-extra-results.json':'large-battle-results.json'),JSON.stringify({
        node:process.version,cpu:require('node:os').cpus()[0].model,
        baseline:execFileSync('git',['rev-parse',referenceRef],{cwd:root,encoding:'utf8'}).trim(),results
    },null,2)+'\n');
    process.exit(0);
}
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const files = Array.from(html.matchAll(/<script src="\.\/(src\/[^"?]+)(?:\?[^" ]*)?"/g), m => m[1]).filter(f => !f.endsWith('bootstrap.js'));
const baseline = process.argv.includes('--baseline');
const prefix = baseline ? execFileSync('git', ['rev-parse', '--show-prefix'], {cwd:root, encoding:'utf8'}).trim() : '';
const source = files.map(f => baseline ? execFileSync('git', ['show', referenceRef+':'+prefix+f], {cwd:root, encoding:'utf8', maxBuffer:8e6}) : fs.readFileSync(path.join(root, f), 'utf8')).join('\n');
const noop = () => {};
const element = { style: {}, classList: { add: noop, remove: noop, contains: () => false }, addEventListener: noop, getContext: () => null };
const document = { getElementById: () => null, createElement: () => element, addEventListener: noop, querySelectorAll: () => [] };
const window = { innerWidth: 1280, innerHeight: 720, addEventListener: noop, matchMedia: () => ({matches:false}), location: {search:''} };
const setup = `
playSound = startLaserSound = stopLaserSound = updateAudioReactiveState = updateItemTextCache = () => {};
Tower.prototype.updateTextCache = () => {};
isMultiplayer = multiplayer; gameStarted = multiplayer;
let productionTotal=0, productionMax=0;
const originalProduction = processGlobalSpawnerQueue;
processGlobalSpawnerQueue = () => { const start=performance.now(); originalProduction(); const elapsed=performance.now()-start;
  if(gameTime>40) {productionTotal+=elapsed;productionMax=Math.max(productionMax,elapsed);} };
GRID_W = GRID_H = 128; WORLD_W = GRID_W * TILE; WORLD_H = GRID_H * TILE;
CONFIG_MAX_POP = 10000; rng = mulberry32(12345); visualRng = mulberry32(67890);
players = Array.from({length:2}, () => ({energy:1e9, astar:1e9, popCount:0, researchLevels:{}, researchMultipliers:{}, researchQueue:[], researchTask:null}));
activeTeamIds = [0,1];
rebuildPrecomputedStatsMap(); initGrid(); initTileEntityLookup(); generateAreas(); initSpatialHash();
rebuildPrecomputedStatsMapPlayer();
const types = ['norm','fast','tank','flying','mole','snake','collector','astar_collector','salvager_unit','builder_unit','healer_unit','researcher_unit'];
for (let owner=0; owner<2; owner++) {
  const gx=owner?120:32, gy=100, stacks=getRequiredStacksForLevel(20);
  const stats=calculateItemStats('house',20,owner);
  const house={type:'house',owner,gx,gy,x:gx*TILE+16,y:gy*TILE+16,stacks,manualStacks:stacks,level:20,
    energy:stats.maxEnergy,maxEnergy:stats.maxEnergy,preComputed:stats};
  grid[gy][gx].item=house; grid[gy][gx].owner=owner; setTileEntity(gx,gy,'house',house);
  for (let i=0; i<500; i++) {
    const gx = 4 + i%25 + owner*90, gy = 4 + Math.floor(i/25)*3;
    let b;
    if (i%4===0) { b = new Tower(gx,gy,['pistol','smg','water','poison','sniper'][Math.floor(i/4)%5],owner); towers.push(b); grid[gy][gx].type = TYPE_WALL; }
    else if (i%4===1) { b = new Barrack(gx,gy,owner,'norm'); barracks.push(b); }
    else { const C = [CollectorSpawner, BuilderSpawner, HealerSpawner, ResearchSpawner, AstarSpawner, SalvagerSpawner][Math.floor(i/4)%6]; b = new C(gx,gy,owner); collectorSpawners.push(b); }
    setTileEntity(gx,gy,b.type,b);
    grid[gy][gx].owner = owner;
    if (!(b instanceof Tower)) grid[gy][gx].item = b;
    b.underConstruction=false;
    if (scenario==='working' && i%5===0) { b.underConstruction=true; b.buildProgress=0; b.energy=1; }
    if (scenario==='working' && i%19===0 && !b.underConstruction) b.markedForSalvage=true;
  }
  for (let i=0; i<1500; i++) {
    const type = types[i%types.length];
    const x = (scenario==='siege' ? (owner?4:90) : scenario==='combat' || scenario==='crowded' ? 52+owner*10 : 8+owner*75) + rng()*(scenario==='crowded'?6:25);
    const y = 8+rng()*(scenario==='crowded'?20:100);
    const u = new Unit(BASE_UNIT_STATS[type] ? type : 'norm',owner,x*TILE,y*TILE);
    configureWorkerUnitFromType(u);
    units.push(u); players[owner].popCount++;
  }
}
generateResourceMinesMixed(); recalculateAdjacency();
if(scenario==='working') for(let owner=0;owner<2;owner++) {
 const lab=collectorSpawners.find(b=>b.owner===owner && b.type==='research' && !b.underConstruction);
 if(lab) processActions([{action:'queueResearch',gx:lab.gx,gy:lab.gy,kind:'unit',key:'norm',statKey:'atk',count:5}],owner);
}
const command = () => {
  if (scenario==='moving' || scenario==='combat') for(let owner=0; owner<2; owner++) {
    const owned = units.filter(u=>u.owner===owner);
    for(let group=0;group<5;group++) processActions([{action:scenario==='combat'?'attackMove':'move',
      unitIds:owned.filter((u,i)=>i%5===group).map(u=>u.id), targetX:(48+group*8)*TILE, targetY:(gameTime%80===0?40:85)*TILE}],owner);
  }
  if (scenario==='rally') for(const b of [...barracks,...collectorSpawners]) {
    processActions([{action:'setRally',gx:b.gx,gy:b.gy,targetX:64*TILE,targetY:(gameTime%80===0?40:85)*TILE}],b.owner);
    if (b.spawnQueue.length===0) b.spawnQueue.push({unitType:getSpawnerFallbackUnitType(b),level:1,energyRequired:1,energyPaid:1});
  }
};
return { tick: () => {if(gameTime%40===0) command(); gameTick();}, summary: () => ({units:units.length, buildings:new Set([...towers,...barracks,...collectorSpawners,...getCellItemsRowMajor()]).size, tick:gameTime,
 lockstep:computeLockstepStateHashFast(gameTime),
 workers:units.reduce((out,u)=>{if(u.workerState) out[u.workerState]=(out[u.workerState]||0)+1;return out;},{}),
 state:JSON.stringify({units:units.map(u=>[u.id,u.x,u.y,u.energy,u.commandState,u.workerState,u.workerTarget?.id,u.workerTarget?.gx,u.workerTarget?.gy,u.path,u.pathIndex,u._pendingPathTarget,u.carryingValue]),
 buildings:[...towers,...barracks,...collectorSpawners].map(b=>[b.type,b.gx,b.gy,b.owner,b.energy,b.underConstruction,b.spawnQueue,b.researchTask]),players})}),
 profile: () => ({productionTotal,productionMax}),
 // Distinct property orders among live units: 1 means one hidden class.
 unitShapes: () => new Set(units.filter(u=>!u.dead).map(u=>Object.keys(u).join(','))).size };
`;
const scenario = process.argv[2] || 'idle';
const multiplayer=process.argv.includes('--multiplayer');
const game = new Function('window','document','localStorage','scenario','multiplayer', source + '\n' + setup)(window,document,{getItem:()=>null,setItem:noop},scenario,multiplayer);
const samples = [], commandSamples=[];
const totalTicks = Number(process.env.BENCH_TICKS) || 160;
for (let i=0;i<totalTicks;i++) { const start=performance.now(); game.tick(); const ms=performance.now()-start; if(i>=40) {samples.push(ms); if(i%40===0) commandSamples.push(ms);} }
samples.sort((a,b)=>a-b);
const summary=game.summary(); summary.state=require('node:crypto').createHash('sha256').update(summary.state).digest('hex');
console.log(JSON.stringify({scenario, baseline, multiplayer, ...summary, ...game.profile(), unitShapes:game.unitShapes(), mean:samples.reduce((a,b)=>a+b,0)/samples.length, median:samples[Math.floor(samples.length*.5)], p95:samples[Math.floor(samples.length*.95)],max:samples.at(-1),commandMean:commandSamples.reduce((a,b)=>a+b,0)/commandSamples.length}));
