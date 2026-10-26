// Compare every batched SIMD answer with the scalar object query at the
// same instant, with resistance/status variation and equal-distance ties.
'use strict';
const assert=require('node:assert/strict'),H=require('./net-harness.cjs');
const helpers=Number(process.argv.find(a=>a.startsWith('--helpers='))?.slice(10)||0);
if(helpers)globalThis.self={crossOriginIsolated:true};
const controls={...H.SMALL_MATCH_CONTROLS,'cfg-mapsize':'128','cfg-map-type':'arena','cfg-gold-count':'0','cfg-astar-mine-count':'0','cfg-max-pop':'20000','cfg-full-vis':'full'};
const world=new H.World({controls}),i=world.spawn('tower-simd',{controls,simWorker:false});
if(helpers){i.scratch.Worker=require('./real-sim-helper.cjs');i.eval(`Worker=__scratch.Worker;navigator.hardwareConcurrency=16;simParallelInit('',${helpers});`);}
const result=JSON.parse(i.eval(`JSON.stringify((()=>{
 startSoloGame();gameTime=100;
 if(typeof _simWasmX.k_tower_scan!=='function')throw Error('Rebuild both WASM variants before this test');
 let seed=77;const rnd=()=>{seed=Math.imul(seed,1664525)+1013904223|0;return(seed>>>0)/4294967296;};
 const types=Object.keys(BASE_UNIT_STATS);
 for(let j=0;j<4000;j++){
  const u=new Unit(types[j%types.length],j%3===0?1:0,(4+Math.floor(rnd()*120))*TILE+16,(4+Math.floor(rnd()*120))*TILE+16);
  if(u.dead)continue;units.push(u);updateUnitSpatial(u);
  if(j%7===0)u.burning=15;if(j%11===0)u.poisoned=10;if(j%13===0)u.wet=8;
  if(j%17===0)u.frozen=9;if(j%19===0)u.sandy=12;if(j%23===0){u.watched=10;u.watchedByTeam=j%2;}
  if(j%101===0)u.dead=true;
 }
 const keys=['pistol','smg','sniper','fire','water','poison','ice','elements','sand_gun','watch_tower'];
 for(let gy=5,j=0;gy<123;gy+=3)for(let gx=5;gx<123;gx+=3,j++){
  if(!placeBuilding(gx,gy,keys[j%keys.length],j%2,{silent:true,ignorePlacementRules:true}))continue;
  const t=getTileEntityRef(gx,gy);markConstructionComplete(t);t.energy=t.maxEnergy;t._cdUntil=gameTime-1;structTableRefresh(t);
 }
 spatialIndexRebuild();SIM_TOWER_WASM=true;SIM_TOWER_VERIFY=true;
 let checks=0,targets=0;
 for(let round=0;round<3;round++){
  for(const t of towers){t._cdUntil=gameTime-1;structTableRefresh(t);}
  _towerAcqPrepare(towers.slice().sort((a,b)=>a.gy-b.gy||a.gx-b.gx));
  if(!_towerAcq.ready)throw Error('SIMD batch did not run');
  checks+=_towerAcq.list.length;targets+=Array.from(_towerAcq.arrays.out.subarray(0,_towerAcq.list.length)).filter(s=>s>=0).length;
  for(const t of _towerAcq.list)t.shoot();
  _towerAcq.ready=false;
  // Change eligibility and statuses without changing positions/index order.
  for(let j=0;j<units.length;j+=29){const u=units[j];if(!u.dead){u.burning=round?0:20;u.wet=round?10:0;}}
 }
 const u=units.find(u=>!u.dead);u.fireResistant=!u.fireResistant;
 _towerAcqPrepare(towers);const fallback=!_towerAcq.ready;
 return{checks,targets,fallback,bytes:Object.values(_towerAcq.arrays).reduce((n,a)=>n+a.byteLength,0)};
})())`));
assert.ok(result.checks>3000&&result.targets>100);assert.ok(result.fallback);
assert.deepEqual(i.errors.map(String),[]);console.log('PASS: SIMD tower targets agree with scalar live queries',JSON.stringify(result));process.exit(0);
