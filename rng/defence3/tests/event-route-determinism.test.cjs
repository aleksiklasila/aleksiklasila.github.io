'use strict';
const assert=require('node:assert/strict');
globalThis.self={crossOriginIsolated:true};
const H=require('./net-harness.cjs');
const controls={...H.SMALL_MATCH_CONTROLS,'cfg-mapsize':'128','cfg-map-type':'arena','cfg-gold-count':'0','cfg-astar-mine-count':'0','cfg-max-pop':'20000'};
const runs=[];
for(const [batch,helpers] of [[true,0],[true,3]]){
 const world=new H.World({controls}),i=world.spawn('routes-'+batch+'-'+helpers,{controls,simWorker:false});
 if(helpers){i.scratch.Worker=require('./real-sim-helper.cjs');i.eval(`Worker=__scratch.Worker;navigator.hardwareConcurrency=16;simParallelInit('',${helpers});`);}
 i.eval(`startSoloGame();simDk=20;netStepTicks=()=>20;
  for(let y=0;y<GRID_H;y++){cellType[(grid[y][64]) - 1]=TYPE_WALL;simMoveTileTypeChanged(64,y);}
  navEnsure(NAV_PROFILE_GROUND);navEnsure(NAV_PROFILE_AIR);__scratch.actors=[];__scratch.fast=0;
  {const f=pendingPathNoWayEvents;pendingPathNoWayEvents=function(E,j){const n0=[];for(let k=0;k<j;k++)if(E[k]>=0&&(E[k]&7)===UNIT_EV_NOWAY)n0.push(k);const r=f.apply(this,arguments);for(const k of n0)if(E[k]===-1)__scratch.fast++;return r;};}
  for(let j=0;j<2400;j++){
   const u=new Unit(j%9===0?'flying':'norm',j%2,(5+(j%50))*TILE+16,(5+Math.floor(j/50)*2)*TILE+16);
   if(u.dead)continue;units.push(u);updateUnitSpatial(u);__scratch.actors.push(u);
  }
  __scratch.order=()=>{for(const u of __scratch.actors){if(u.dead)continue;
   const p=navProfileOf(u);u.targetPos={x:110*TILE+16,y:90*TILE+16};u.commandState=CMD_MOVING;
   u.path=[navNode(p,110,90)];u.pathIndex=0;u._pendingPathTarget=null;u.pathIsFallbackAstar=false;
   simMoveTryArm(u);
  }};__scratch.order();`);
 const hashes=[];
 for(let step=0;step<36;step++){
  if(step===12||step===24)i.eval('__scratch.order()');
  i.eval('gameTick();currentTick++');hashes.push(i.eval('__exactStateHash()'));
 }
 const fast=i.eval('__scratch.fast');
 assert.deepEqual(i.errors.map(String),[]);runs.push({batch,helpers,fast,hashes});
}
assert.deepEqual(runs[1].hashes,runs[0].hashes,'zero/three helpers agree');
assert.ok(runs[0].fast>100,'no-way events taken by the kernel: '+runs[0].fast);
console.log(JSON.stringify(runs.map(({hashes,...r})=>({...r,steps:hashes.length}))));
for(const w of require('./real-sim-helper.cjs').instances||[])w.terminate();
