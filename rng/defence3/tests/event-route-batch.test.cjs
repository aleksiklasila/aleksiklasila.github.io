'use strict';
// Native pure route preparation and ordered fast commit versus the scalar
// public handler, including retry/request state, digests and path fallbacks.
const assert=require('node:assert/strict'),H=require('./net-harness.cjs');
const helpers=Number(process.argv.find(a=>a.startsWith('--helpers='))?.slice(10)||0);
if(helpers)globalThis.self={crossOriginIsolated:true};
const controls={...H.SMALL_MATCH_CONTROLS,'cfg-mapsize':'128','cfg-map-type':'crossroads','cfg-max-pop':'20000'};
const world=new H.World({controls}),i=world.spawn('event-routes',{controls,simWorker:process.env.SIM_WORKER==='1'});
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
  cols:['nvPK','mvOn','mvCD','mvPF','rkF'].map(k=>u._us[k][u._si]),
  requests:_navSub.req.slice(),entries:[..._navSub.map],due:u._us.ppDue[u._si],pending:pendingPathWaiting()});
 for(let round=0;round<4;round++){
  gameTime=100+round*20;
  for(let j=0;j<n;j++){
   const u=actors[j],profile=navProfileOf(u),x=rnd(GRID_W),y=rnd(GRID_H);
   const node={x,y,nav:profile+1,ready:0,...(j%3===0?{w:1}:{})};
   u.path=j%7===0?[{x:3,y:4},node]:[node];u.pathIndex=j%11===0?1:0;
   u.commandState=j%3===0?CMD_ATTACK_MOVING:CMD_MOVING;u.pathIsFallbackAstar=j%3===0?true:undefined;
   u._pendingPathTarget=j%4===0?{gx:rnd(GRID_W),gy:rnd(GRID_H),cmd:u.commandState,src:'player_commands',ver:3,at:7,sub:2}:null;
   u._astarBudgetRetryTick=j%3===0?75:undefined;u._routeKey=NAV_ROUTE_KEY;
   if(j%5===0)C.jr__path.clear(u._si); // a native-written route with no JS view
   if(j%17===0){const t=_nav[profile].partL.findIndex(v=>v===65535);if(t>=0){C.x[u._si]=(t%GRID_W)*TILE*8+128;C.y[u._si]=Math.floor(t/GRID_W)*TILE*8+128;}}
   E[j]=u._si*8+2;
  }
  const P=_simParams;P[0]=n;P[1]=64;P[2]=TILE*8;
  simParallelRun(SIM_KERNEL_EVENT_ROUTES,Math.ceil(n/64));
  for(let j=0;j<n;j++){
   const u=actors[j],s=u._si,key=_unitEvSort.routes[j*2],comp=_unitEvSort.routes[j*2+1];
   if(C.pathIndex[s]!==0){if(key!==-1)throw Error('path index guard '+j);continue;}
   if(key!==C.nvPK[s])throw Error('prepared key '+j);
   const profile=navProfileOf(u),tile=Math.floor(u.y/TILE)*GRID_W+Math.floor(u.x/TILE);
   if(comp===-2)walls++;else if(comp!==_navUnitComp(profile,tile))throw Error('prepared component '+j);
   const missingView=!C.jr__path.get(s);
   const initial={path:u.path,index:u.pathIndex,pending:u._pendingPathTarget&&{...u._pendingPathTarget},fallback:u.pathIsFallbackAstar,
    retry:u._astarBudgetRetryTick,key:u._routeKey,on:C.mvOn[s],cd:C.mvCD[s],h:C.hObj[s]};
   const reset=()=>{u.path=initial.path;u.pathIndex=initial.index;u._pendingPathTarget=initial.pending&&{...initial.pending};u.pathIsFallbackAstar=initial.fallback;
    u._astarBudgetRetryTick=initial.retry;u._routeKey=initial.key;C.mvOn[s]=initial.on;C.mvCD[s]=initial.cd;C.hObj[s]=initial.h;
    if(missingView)C.jr__path.clear(s);
    _navSubReset();C.ppDue.fill(-1);_ppHeads().fill(-1);_ppCount=0;};
   reset();_unitNoWay(u);const expected=JSON.stringify(capture(u));
   reset();const used=_unitNoWayCommit(u,C,s,key,comp,_simHTerm(_UH_PFA,true));
   if(!used)_unitNoWay(u);else fast++;
   const actual=JSON.stringify(capture(u));
   if(actual!==expected)throw Error('commit '+j+' round '+round+'\\n'+actual+'\\n'+expected);
   cases++;
  }
 }
 return {cases,fast,walls};
})())`));
assert.ok(result.fast>500);assert.ok(result.cases>1000);assert.deepEqual(i.errors.map(String),[]);
console.log(JSON.stringify({helpers,...result}));
for(const w of require('./real-sim-helper.cjs').instances||[])w.terminate();
