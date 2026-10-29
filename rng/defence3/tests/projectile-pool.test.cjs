// The projectile pool (projectile.js, wasm/src/proj.rs): towers of every
// type shoot at units and structures through whole ticks; shots fly, hit
// (unit damage and statuses through k_hits, the fire blast, structures and
// floor targets through k_proj_struct_hits), free their slots; the pool's
// hash is a sum over its shots (the same for another slot layout) and a
// snapshot restores it.
'use strict';
const assert = require('node:assert/strict'), H = require('./net-harness.cjs');
const controls = { ...H.SMALL_MATCH_CONTROLS, 'cfg-mapsize': '128', 'cfg-map-type': 'arena', 'cfg-gold-count': '0', 'cfg-astar-mine-count': '0', 'cfg-max-pop': '20000', 'cfg-full-vis': 'full' };
const world = new H.World({ controls }), i = world.spawn('projectile-pool', { controls, simWorker: false });
const result = JSON.parse(i.eval(`JSON.stringify((()=>{
 startSoloGame();gameTime=100;
 let seed=91;const rnd=()=>{seed=Math.imul(seed,1664525)+1013904223|0;return(seed>>>0)/4294967296;};
 const keys=['pistol','smg','sniper','fire','water','poison','ice','elements','sand_gun','watch_tower'];
 for(let gy=10,j=0;gy<118;gy+=6)for(let gx=10;gx<60;gx+=6,j++){
  if(!placeBuilding(gx,gy,keys[j%keys.length],0,{silent:true,ignorePlacementRules:true}))continue;
  const t=getTileEntityRef(gx,gy);markConstructionComplete(t);t.energy=t.maxEnergy;t._cdUntil=gameTime-1;structTableRefresh(t);
 }
 // Enemy structures and floor items in reach of some towers.
 const enemy=[];
 for(let gy=12;gy<118;gy+=12)for(let gx=62;gx<70;gx+=4){
  if(!placeBuilding(gx,gy,gx===62?'pistol':'lava',1,{silent:true,ignorePlacementRules:true}))continue;
  const t=getTileEntityRef(gx,gy);markConstructionComplete(t);t.energy=t.maxEnergy;structTableRefresh(t);enemy.push(t);
 }
 const types=Object.keys(BASE_UNIT_STATS);
 for(let j=0;j<1500;j++){
  const u=new Unit(types[j%types.length],1,(20+Math.floor(rnd()*50))*TILE+16,(8+Math.floor(rnd()*112))*TILE+16);
  if(u.dead)continue;units.push(u);updateUnitSpatial(u);
 }
 recalculateAdjacency(true);
 const unitEnergy0=units.reduce((s,u)=>s+u.energy,0),structEnergy0=enemy.reduce((s,b)=>s+b.energy,0);
 let maxShots=0,fired=0,burning=0,wet=0,frozen=0,poisoned=0,sandy=0,watched=0;
 for(let k=0;k<120;k++){
  gameTick();
  maxShots=Math.max(maxShots,projCount());
  for(const u of units){if(u.dead)continue;if(u.burning>0)burning++;if(u.wet>0)wet++;if(u.frozen>0)frozen++;if(u.poisoned>0)poisoned++;if(u.sandy>0)sandy++;if(u.watched>0)watched++;}
 }
 const unitEnergy1=units.reduce((s,u)=>s+(u.dead?0:u.energy),0),struct1=enemy.reduce((s,b)=>s+Math.max(0,b.energy),0);
 // Hash: the same shots in other slots hash the same; a snapshot restores them.
 const n=projCount(),h0=projHash(),recs=projSnapshotRecords();
 projSnapshotLoad(recs.slice().reverse());
 const h1=projHash();
 projSnapshotLoad(recs);
 const h2=projHash();
 // Then without units: the towers' shots at the enemy structures and floor items.
 const fired1=_pj.hdr[2];for(const u of units)u.dead=true;
 // (The kings fell too: the match kept going.)
 for(let k=0;k<200;k++){gameOver=false;gameTick();}
 fired=_pj.hdr[2];const firedNoUnits=fired-fired1;
 const structEnergy1=enemy.reduce((s,b)=>s+(getTileEntityRef(b.gx,b.gy)===b?Math.max(0,b.energy):0),0);
 // Free slots + flying = capacity.
 const H=_pj.hdr,leak=H[0]+H[1]-_pj.cap;
 return{maxShots,fired,firedNoUnits,n,h0,h1,h2,leak,unitLoss:unitEnergy0-unitEnergy1,structLoss:structEnergy0-structEnergy1,structLossWithUnits:structEnergy0-struct1,burning,wet,frozen,poisoned,sandy,watched,dead:units.filter(u=>u.dead).length,
  enemyLeft:enemy.filter(b=>getTileEntityRef(b.gx,b.gy)===b).length,enemy:enemy.length};
})())`));
console.log(JSON.stringify(result));
assert.deepEqual(i.errors.map(String), []);
assert.ok(result.fired > 250 && result.maxShots > 20, 'towers fire into the pool');
assert.equal(result.leak, 0, 'every slot is in flight or free');
assert.ok(result.unitLoss > 0, 'shots damage units');
assert.ok(result.structLoss > 0, 'shots damage enemy structures');
assert.ok(result.burning > 0 && result.wet > 0 && result.frozen > 0 && result.poisoned > 0 && result.sandy > 0 && result.watched > 0, 'statuses from shots');
assert.equal(result.h0, result.h1, 'the hash does not depend on slots');
assert.equal(result.h0, result.h2);
assert.ok(result.n > 3, 'shots in flight for the hash check');
console.log('PASS: projectile pool: shots fly, hit units and structures, statuses, slot-free hash and restore');
process.exit(0);
