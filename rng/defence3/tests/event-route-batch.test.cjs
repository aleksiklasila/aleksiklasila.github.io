'use strict';
// The no-way events in the pending wheel's kernel (pp.rs k_pp_due mode 3, pathfinding.js pendingPathNoWayEvents) versus
// the scalar handler (unit.js _unitNoWay), one event at a time: pending target, path, route, fallback, retry, digest,
// the movement columns, the substitutes asked, the wheel.
const assert=require('node:assert/strict'),H=require('./net-harness.cjs');
const helpers=Number(process.argv.find(a=>a.startsWith('--helpers='))?.slice(10)||0);
if(helpers)globalThis.self={crossOriginIsolated:true};
const controls={...H.SMALL_MATCH_CONTROLS,'cfg-mapsize':'128','cfg-map-type':'crossroads','cfg-max-pop':'20000'};
const world=new H.World({controls}),i=world.spawn('event-routes',{controls,simWorker:false});
if(helpers){i.scratch.Worker=require('./real-sim-helper.cjs');i.eval(`Worker=__scratch.Worker;navigator.hardwareConcurrency=16;simParallelInit('',${helpers});`);}
const result=JSON.parse(i.eval(`JSON.stringify((()=>{
 startSoloGame();navEnsure(NAV_PROFILE_GROUND);navEnsure(NAV_PROFILE_AIR);
 const n=400,actors=[];let seed=91591;
 const rnd=n=>{seed=Math.imul(seed,1664525)+1013904223|0;return Math.floor((seed>>>0)/4294967296*n);};
 for(let j=0;actors.length<n&&j<3000;j++){
  const u=new Unit(j%2?'flying':'norm',j%2,(4+(j%60)*2)*TILE+16,(4+Math.floor(j/60)*2)*TILE+16);
  if(u.dead)continue;units.push(u);actors.push(u);
 }
 if(actors.length!==n)throw Error('fixture population');
 _unitEventSortReserve(n);const E=_unitEvSort.ent,C=_simUnitState.columns;
 let cases=0,fast=0,walls=0;
 const capture=u=>({pending:u._pendingPathTarget&&{...u._pendingPathTarget},path:u.path,index:u.pathIndex,
  fallback:u.pathIsFallbackAstar,key:u._routeKey,retry:u._astarBudgetRetryTick,h:u._us.hObj[u._si],
  cols:['nvPK','mvOn','mvSteer','mvPF','rkF'].map(k=>u._us[k][k==='mvSteer'?u._si*8:u._si]),
  requests:Array.from(_navSub.list.subarray(0,_navSub.n*3)),entries:_navSub.used,due:u._us.ppDue[u._si],pending:pendingPathWaiting()});
 for(let round=0;round<4;round++){
  gameTime=100+round*20;
  for(let j=0;j<n;j++){
   const u=actors[j],profile=navProfileOf(u),x=rnd(GRID_W),y=rnd(GRID_H);
   const node={x,y,nav:profile+1,ready:0,...(j%3===0?{w:1}:{})};
   u.path=j%7===0?[{x:3,y:4},node]:[node];u.pathIndex=j%11===0?1:0;
   u.commandState=j%3===0?CMD_ATTACK_MOVING:CMD_MOVING;u.pathIsFallbackAstar=j%3===0?true:undefined;
   u._pendingPathTarget=j%4===0?{gx:rnd(GRID_W),gy:rnd(GRID_H),cmd:u.commandState,src:'player_commands',ver:3,at:7,sub:2}:null;
   u._astarBudgetRetryTick=j%3===0?75:undefined;u._routeKey=NAV_ROUTE_KEY;
   if(j%17===0){const t=_nav[profile].partL.findIndex(v=>v===65535);if(t>=0){C.x[u._si]=(t%GRID_W)*TILE*8+128;C.y[u._si]=Math.floor(t/GRID_W)*TILE*8+128;}}
   E[j]=u._si*8+2;
  }
  const E1=simHeapArray(Int32Array,4);
  for(let j=0;j<n;j++){
   const u=actors[j],s=u._si,profile=navProfileOf(u),tile=Math.floor(u.y/TILE)*GRID_W+Math.floor(u.x/TILE);
   if(_nav[profile].partL[tile]===65535)walls++;
   const initial={path:u.path,index:u.pathIndex,pending:u._pendingPathTarget&&{...u._pendingPathTarget},fallback:u.pathIsFallbackAstar,
    retry:u._astarBudgetRetryTick,key:u._routeKey,on:C.mvOn[s],cd:C.mvSteer[s*8],h:C.hObj[s]};
   const reset=()=>{u.path=initial.path;u.pathIndex=initial.index;u._pendingPathTarget=initial.pending&&{...initial.pending};u.pathIsFallbackAstar=initial.fallback;
    u._astarBudgetRetryTick=initial.retry;u._routeKey=initial.key;C.mvOn[s]=initial.on;C.mvSteer[s*8]=initial.cd;C.hObj[s]=initial.h;
    _navSubReset();C.ppDue.fill(-1);_ppHeads().fill(-1);_ppCount=0;};
   reset();_unitNoWay(u);const expected=JSON.stringify(capture(u));
   reset();E1[0]=s*8+UNIT_EV_NOWAY;pendingPathNoWayEvents(E1,1);if(E1[0]===-1)fast++;
   const actual=JSON.stringify(capture(u));
   if(actual!==expected)throw Error('commit '+j+' round '+round+'\\n'+actual+'\\n'+expected);
   cases++;
  }
 }
 return {cases,fast,walls};
})())`));
assert.equal(result.fast,result.cases,'every event taken by the kernel');assert.ok(result.walls>0,'walled-in units among them');assert.ok(result.cases>1000);assert.deepEqual(i.errors.map(String),[]);
console.log(JSON.stringify({helpers,...result}));
for(const w of require('./real-sim-helper.cjs').instances||[])w.terminate();
