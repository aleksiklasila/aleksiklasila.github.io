'use strict';
const assert=require('node:assert/strict');
globalThis.self={crossOriginIsolated:true};
const H=require('./net-harness.cjs'),RealWorker=require('./real-sim-helper.cjs');
const controls={...H.SMALL_MATCH_CONTROLS,'cfg-mapsize':'80','cfg-max-pop':'10000','cfg-starting-energy':'900000000','cfg-starting-astar':'900000000'};
const workers=[];
class Worker extends RealWorker {constructor(){super();workers.push(this);}}
async function run(helpers,planes){
 const world=new H.World({controls:{...controls,'cfg-mapsize':helpers&&planes===1?'82':'80'}}),i=world.spawn('occupancy',{simWorker:false});
 i.eval(`SIM_OCCUPANCY_ENABLED=true;SIM_OCCUPANCY_PLANES=${planes};startingResourcesConfig=normalizeStartingResourcesConfig({spawnCounts:{},researchLevels:{}});applyMainMenuControlsToRuntimeState();startSoloGame();`);
 if(helpers){i.scratch.Worker=Worker;i.eval(`Worker=__scratch.Worker;navigator.hardwareConcurrency=16;simParallelInit('',${helpers});`);}
 i.eval(`{
  const a=new Unit('norm',0,20*TILE,20*TILE);units.push(a);players[0].popCount++;
  const b=new Unit('flying',1,20*TILE,20*TILE);units.push(b);players[1].popCount++;
  __scratch.layers={a:[a.x,a.y],b:[b.x,b.y]};
  for(let k=0;k<1800;k++){
   const u=new Unit('norm',k&1,(3+(k%60)*.5)*TILE,(3+Math.floor(k/60)*.5)*TILE);
   if(u.dead)throw Error('Unexpected spawn rejection');units.push(u);players[u.owner].popCount++;
  }
  spatialIndexRebuild();
  occupancyPrepareMovement();
  {const O=_occ,C=O.config;let total=0;
   for(let by=0;by<C[6];by++)for(let bx=0;bx<C[5];bx++){
    if(O.offsets[by*C[5]+bx]!==total)throw Error('SIMD job prefix differs from reference');
    for(let y=by*C[7];y<Math.min(CHUNKS_H,(by+1)*C[7]);y++)for(let x=bx*C[7];x<Math.min(CHUNKS_W,(bx+1)*C[7]);x++){
     const k=y*CHUNKS_W+x;if(_sxStamp[k]===_sxEpoch)total+=_sxCount[k];}
   }if(O.offsets[C[5]*C[6]]!==total)throw Error('SIMD job prefix total differs');
  }
 }`);
 const layer=i.scratch.layers;
 if(planes===1)assert.notDeepEqual(layer.a,layer.b,'shared plane blocks flyers on ground units');
 else assert.deepEqual(layer.a,layer.b,'separate plane allows flyers on ground units');
 // Coordinate writes update occupancy immediately, before unitPassEnd.
 for(let t=0;t<12;t++){
  i.eval(`spatialIndexRebuild();unitPassBegin();
    for(const u of units){if(u.dead)continue;u.x+=(${t}%2?1:-1)*TILE*.4;u.y+=(${t}%3?1:-1)*TILE*.3;}
    if(!occupancyAudit().ok)throw Error('Occupancy must already be correct before pass end');
    unitPassEnd();currentTick++;
  `);
  assert.equal(i.eval('occupancyAudit().ok'),true,'bitmap count at movement '+t);
 }
 const oracle=JSON.parse(i.eval(`JSON.stringify((()=>{
  const seen=new Set(),O=_occ;let overlaps=0,active=0;
  for(let s=0;s<O.cap;s++){if(!_occActive(O,s))continue;active++;
   const x=Math.floor(O.rec[s*4]/O.cell),y=Math.floor(O.rec[s*4+1]/O.cell),r=_occRadius(O,s),l=_occLayer(O,s);
   for(let dy=-r;dy<=r;dy++){const half=O.mask[r*65+dy+32];if(half<0)continue;
    for(let dx=-half;dx<=half;dx++){const key=(l*O.h+y+dy)*O.w+x+dx;if(seen.has(key))overlaps++;seen.add(key);}
   }
  }return {overlaps,active,bits:seen.size,audit:occupancyAudit(),stats:occupancyStats(),sepCap:_sep.cap};
 })())`));
 assert.equal(oracle.overlaps,0,'exclusive footprints');assert.equal(oracle.bits,oracle.audit.actualBits);
 assert.ok(oracle.stats.visited>1500,'phased kernel visits the active units');
 assert.ok(oracle.stats.attempted>1000,'coordinate writes immediately check occupancy');
 assert.ok(oracle.stats.moved>0,'some movement is accepted');
 assert.ok(oracle.stats.blockedOrClipped>0,'occupied destinations block or clip movement');
 assert.equal(oracle.sepCap,0,'pair-separation buffers never allocated');
 // Exercise the production movement dispatch too, with real helpers.
 for(let t=0;t<6;t++){
  i.eval('gameTick();currentTick++;');
  assert.equal(i.eval('occupancyAudit().ok'),true,'fused movement preserves footprint positions');
 }
 // Removal releases cells, including units killed between movement passes.
 i.eval('for(const u of units.slice(-100)){occupancyRelease(u);removeUnitSpatial(u);u.dead=true;}');
 assert.equal(i.eval('occupancyAudit().ok'),true,'removal releases exactly one footprint');
 assert.deepEqual(i.errors.map(String),[]);
 console.log(JSON.stringify({helpers,planes,...oracle}));
}
(async()=>{try{for(const config of [[0,1],[7,1],[7,3]])await run(...config);console.log('PASS: occupied spawns relocate, collision planes, phased motion, no overlapping footprints, removal, no separation buffers.');}
finally{await Promise.all(workers.map(w=>w.terminate()));}})().catch(e=>{console.error(e);process.exitCode=1;});
