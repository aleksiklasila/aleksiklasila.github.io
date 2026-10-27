'use strict';
const assert=require('node:assert/strict');
globalThis.self={crossOriginIsolated:true};
const H=require('./net-harness.cjs');
const controls={...H.SMALL_MATCH_CONTROLS,'cfg-mapsize':'128','cfg-map-type':'arena','cfg-gold-count':'0','cfg-astar-mine-count':'0','cfg-max-pop':'20000','cfg-full-vis':'full'};
const setup=`startSoloGame();simDk=4;SIM_TOWER_VERIFY=${!process.argv.includes('--fast-idle')};
 {let seed=991;const rnd=()=>{seed=Math.imul(seed,1664525)+1013904223|0;return(seed>>>0)/4294967296;};
 const types=Object.keys(BASE_UNIT_STATS);
 for(let j=0;j<3000;j++){const u=new Unit(types[j%types.length],j%2,(4+Math.floor(rnd()*120))*TILE+16,(4+Math.floor(rnd()*120))*TILE+16);if(u.dead)continue;units.push(u);players[u.owner].popCount++;updateUnitSpatial(u);if(j%7===0)u.burning=15;if(j%11===0){u.watched=20;u.watchedByTeam=j%2;}}
 const keys=['pistol','smg','sniper','fire','water','poison','ice','elements','sand_gun','watch_tower'];
 for(let gy=5,j=0;gy<123;gy+=4)for(let gx=5;gx<123;gx+=4,j++)if(placeBuilding(gx,gy,keys[j%keys.length],j%2,{silent:true,ignorePlacementRules:true})){const t=getTileEntityRef(gx,gy);markConstructionComplete(t);t.energy=t.maxEnergy;}
 recalculateAdjacency(true);}
 if(typeof _simWasmX.k_tower_scan!=='function')throw Error('Rebuild WASM before the tower determinism test');`;
const peers=[];
for(const helpers of [0,3]){
 const world=new H.World({controls}),i=world.spawn('tower-'+helpers,{controls,simWorker:false});
 if(helpers){i.scratch.Worker=require('./real-sim-helper.cjs');i.eval(`Worker=__scratch.Worker;navigator.hardwareConcurrency=16;simParallelInit('',${helpers});`);}
 i.eval(setup);peers.push(i);
}
let used=0;
for(let tick=0;tick<32;tick++){
 const hashes=peers.map(i=>{i.eval('gameTick();currentTick++');return i.eval('__exactStateHash()');});
 assert.equal(hashes[0],hashes[1],'same implementation, zero versus three helpers at step '+tick);
 used+=peers[0].eval('_towerAcq.lastUsed');
 for(const i of peers)assert.deepEqual(i.errors.map(String),[]);
}
assert.ok(used>100,'the deterministic replay must actually consume SIMD tower queries');
console.log('PASS: 32 mixed combat steps with SIMD towers stay deterministic with zero versus three helpers'+(process.argv.includes('--fast-idle')?' (native idle completion)':' (scalar query verification)'));process.exit(0);
