'use strict';
const assert=require('node:assert/strict'),H=require('./net-harness.cjs');
async function settle(world,promise){let done=false,error;promise.then(()=>done=true,e=>{done=true;error=e;});assert(await world.runUntil(()=>done,30000,10));if(error)throw error;}
function fixture(settings,health,house,towerHealth,kind){
 const towers=kind==='towers'?[[35,34],[35,36],[36,35]]:[],walls=new Set(towers.map(([x,y])=>y*80+x));
 const areas=[],terrain=[],ids=new Int32Array(6400);
 for(let by=0;by<80;by+=3)for(let bx=0;bx<80;bx+=3)for(const type of [0,1]){
  const cells=[];for(let y=by;y<Math.min(80,by+3);y++)for(let x=bx;x<Math.min(80,bx+3);x++)if(Number(walls.has(y*80+x))===type)cells.push({x,y});
  if(!cells.length)continue;for(const c of cells)ids[c.y*80+c.x]=areas.length;
  areas.push({id:areas.length,type,cells,multiplierLevel:0,minGx:bx,minGy:by,maxGx:Math.min(79,bx+2),maxGy:Math.min(79,by+2)});
 }
 for(let y=0;y<80;y++){const row=[];for(let x=0;x<80;x++)row.push(Number(walls.has(y*80+x)),walls.has(y*80+x)?1:-1,ids[y*80+x],1);terrain.push(row);}
 const units=[];for(let owner=0;owner<(kind==='units'?2:1);owner++)for(let i=0;i<100;i++)units.push(['norm',owner,(owner?55:5)+i%10+.5,30+Math.floor(i/10)+.5,health,1,1,['attackMove',35,35],false]);
 const buildings=[['house',0,2,2,1,house,false,null,null,false,false],['house',1,77,77,1,house,false,null,null,false,false],...towers.map(([x,y])=>['pistol',1,x,y,1,towerHealth,false,null,null,false,false])];
 const header={kind:'defence3-scene',version:1,settings,seed:123,width:80,height:80,teams:[0,1],teamColors:{0:'#4488ff',1:'#ff4444'},player:0,camera:{x:35,y:35,zoom:1},players:[0,1].map(()=>({energy:1e12,astar:1e12,researchLevels:{}}))};
 return {header,records:[{terrain},{areas},{buildings},{units}]};
}
async function main(){
 const world=new H.World({controls:{...H.SMALL_MATCH_CONTROLS,'cfg-mapsize':'80','cfg-full-vis':'full'}});
 const source=world.spawn('order-fixture',{simWorker:false});source.eval('startSoloGame()');
 const settings=source.eval('({...createMainMenuSettingsSnapshot(),editableConfig:serializeEditableRuntimeConfigForTransport()})');
 const health=source.eval('getUnitStatForOwner(0,"norm",1,"energy")'),house=source.eval('calculateItemStats("house",1,0).maxEnergy'),towerHealth=source.eval('calculateItemStats("pistol",1,0).maxEnergy');
 for(const kind of ['units','towers'])for(const worker of [false,true]){
  world.simWorker=worker;
  const target=world.spawn('orders-'+kind+'-'+worker,{simWorker:worker});target.scratch.scene=fixture(settings,health,house,towerHealth,kind);
  target.eval('startMainThreadLoops=()=>{};document.getElementById("starting-resources-popup").classList.add("hidden")');
  await settle(world,target.eval('restoreSoloGameSnapshot(__scratch.scene)'));
  // Keep running through initial approach and combat: merely moving a few
  // pixels before cancelling the order allowed the original stall to pass.
  for(let i=0;i<1200;i++)target.evalSim('runOneTick()');
  const state=target.evalSim('({alive:units.filter(u=>!u.dead&&u.energy>0).length,teams:[...new Set(units.filter(u=>!u.dead&&u.energy>0).map(u=>u.owner))],towers:towers.filter(t=>t.owner===1&&t.type==="pistol"&&t.energy>0).length})');
  if(kind==='units')assert(state.teams.length<=1,'Opposing armies must engage instead of both becoming idle short of their destination');
  else assert(state.alive===0||state.towers===0,'Units must engage the towers without another click');
  assert.deepEqual(target.errors,[]);
  console.log(`PASS imported ${kind} engagement (${worker?'worker':'page'}): ${state.alive} units, ${state.towers} enemy turrets remain`);
 }
}
main().catch(e=>{console.error(e);process.exitCode=1;});
