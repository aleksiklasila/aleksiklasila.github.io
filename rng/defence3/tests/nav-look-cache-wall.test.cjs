'use strict';
// Re-run the identical movement intention with a warm and an empty shared
// cache after editing a wall outside the source's 3x3 version neighborhood.
const assert=require('node:assert/strict'),H=require('./net-harness.cjs');const w=new H.World({controls:{...H.SMALL_MATCH_CONTROLS,'cfg-mapsize':'128','cfg-map-type':'arena','cfg-starting-energy':'900000000','cfg-starting-astar':'900000000'}}),i=w.spawn('cache-wall',{simWorker:false});
const r=i.eval(`(()=>{
 startingResourcesConfig=normalizeStartingResourcesConfig({spawnCounts:{},researchLevels:{}});applyMainMenuControlsToRuntimeState();startSoloGame();
 const wall=(x,y,on)=>{grid[y][x].type=on?TYPE_WALL:TYPE_FLOOR;simMoveTileTypeChanged(x,y);};
 for(let y=16;y<112;y++)for(let x=16;x<112;x++)wall(x,y,false);
 wall(70,57,true);
 const u=new Unit('tank',0,24*TILE+16,56*TILE+16);units.push(u);unitByIdAdded(u);players[0].popCount++;for(let t=0;t<NAV_BUILD_TICKS+4;t++)gameTick();
 processAction({action:'move',unitIds:[u.id],targetX:110*TILE+16,targetY:56*TILE+16},0);
 gameTick();const primed=Array.from(u._us.mvNav.subarray(u._si*8,u._si*8+8));
 occupancyTeleport(u,24*TILE*8+128,56*TILE*8+128);updateUnitSpatial(u);
 u._us.mvNav[u._si*8]=-1;u._us.mvCD[u._si]=-1;u._us.mvCT[u._si]=-1;
 const far=primed[7]>>1;wall(far%GRID_W,Math.floor(far/GRID_W),true);
 const run=simParallelRun;let comparison=null;
 simParallelRun=function(k,n){if(k!==SIM_KERNEL_MOVE)return run.apply(this,arguments);
  // Restore only unit columns between the two intention passes: the shared
  // route cache is the sole input deliberately changed for the second pass.
  const c=_simUnitState.columns,copy=Object.fromEntries(Object.entries(c).filter(([k,v])=>ArrayBuffer.isView(v)).map(([k,v])=>[k,v.slice()]));
  run.apply(this,arguments);const warm=Array.from(c.mvNav.subarray(u._si*8,u._si*8+8)),pos=[u.x,u.y];
  for(const k in copy)c[k].set(copy[k]);simMoveLookCacheClear();run.apply(this,arguments);
  comparison={primed,warm,cold:Array.from(c.mvNav.subarray(u._si*8,u._si*8+8)),warmPos:pos,coldPos:[u.x,u.y]};
 };
 gameTick();simParallelRun=run;return comparison;
})()`);
assert.equal(r.warm[3],r.primed[3],'remote edit leaves the source neighborhood version unchanged');
assert.notEqual(r.warm[7],r.primed[7],'shared look must stop before the newly blocked remote tile');
assert.deepEqual(r.warm,r.cold,'cached and uncached intentions must use the same route after a remote wall edit');
assert.deepEqual(r.warmPos,r.coldPos,'cache warmth must not change the intended position');
assert.deepEqual(i.errors.map(String),[]);
console.log('PASS: shared route look invalidates for remote wall edits, independently of cache warmth');




