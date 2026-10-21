'use strict';
const fs=require('node:fs'),{performance}=require('node:perf_hooks');
const arg=(k,d)=>process.argv.find(a=>a.startsWith('--'+k+'='))?.slice(k.length+3)??d;
const H=require('./net-harness.cjs'),mode=Number(arg('mode',3)),dk=Number(arg('dk',20)),ticks=Number(arg('ticks',80));
const world=new H.World({controls:{...H.SMALL_MATCH_CONTROLS,'cfg-mapsize':'200','cfg-map-type':'arena',
 'cfg-max-pop':'20000','cfg-starting-energy':'900000000','cfg-starting-astar':'900000000'}});
const i=world.spawn('traffic',{simWorker:false,url:'http://localhost/?wasm64=0'});i.scratch.now=()=>performance.now();
const r=i.eval(`(()=>{
 SIM_TRAFFIC_MODE=${mode};performance.now=__scratch.now;
 SIM_TRAFFIC_PASSES=${Number(arg('passes',2))};SIM_TRAFFIC_RESPONSE=${Number(arg('response',1))};SIM_TRAFFIC_LOCAL=${Number(arg('local',1))};
 startingResourcesConfig=normalizeStartingResourcesConfig({spawnCounts:{},researchLevels:{}});
 applyMainMenuControlsToRuntimeState();startSoloGame();
 const us=[],plug=[];
 for(let y=0;y<40;y++)for(let x=0;x<80;x++){
  const u=new Unit('norm',0,(10+x*.4)*TILE,(80+y*.4)*TILE);units.push(u);us.push(u);players[0].popCount++;
 }
 ${arg('scenario','plug')==='open'?'':`for(let y=0;y<32;y++)for(let x=0;x<24;x++){
  const u=new Unit('norm',0,(70+x*.4)*TILE,(82+y*.4)*TILE);units.push(u);plug.push(u);players[0].popCount++;
 }`}
 ${arg('scenario','plug')==='wall'?'for(let y=0;y<GRID_H;y++){grid[y][90].type=TYPE_WALL;simMoveTileTypeChanged(90,y);}':''}
 for(let t=0;t<NAV_BUILD_TICKS+5;t++)gameTick();
 processAction({action:'move',unitIds:us.map(u=>u.id),targetX:190*TILE,targetY:88*TILE},0);simDk=${dk};
 ${arg('scenario','plug')==='counter'?'processAction({action:"move",unitIds:plug.map(u=>u.id),targetX:10*TILE,targetY:88*TILE},0);':''}
 const starts=us.map(u=>[u.x,u.y]),ps=plug.map(u=>[u.x,u.y]),samples=[];let ms=0,maxSpeedRatio=0,wallViolations=0;
 for(let t=0;t<${ticks};t++){
  const a=performance.now();gameTick();currentTick++;ms+=performance.now()-a;
  for(const u of us){const ratio=Math.hypot(u.x-u.prevX,u.y-u.prevY)/(simUnitStatValue(u._us,u._si,0)*simDk);maxSpeedRatio=Math.max(maxSpeedRatio,ratio);
   if(grid[Math.floor(u.y/TILE)]?.[Math.floor(u.x/TILE)]?.type===TYPE_WALL)wallViolations++;
  }
  if((t+1)%10===0){let demand=0,flowing=0,moving=0,speedSum=0,progress=0;
   for(let k=0;k<us.length;k++){
    const u=us[k],s=u._si;
    progress+=Math.hypot(190*TILE-starts[k][0],88*TILE-starts[k][1])-Math.hypot(190*TILE-u.x,88*TILE-u.y);
    if(u.commandState!==CMD_MOVING||Math.hypot(190*TILE-u.x,88*TILE-u.y)<12*TILE)continue;
    const ratio=Math.hypot(u.x-u.prevX,u.y-u.prevY)/(simUnitStatValue(u._us,s,0)*simDk);
    demand++;speedSum+=ratio;if(ratio>=.5)flowing++;if(ratio>=.1)moving++;
   }
   samples.push({tick:t+1,demand,flowing,moving,meanSpeed:speedSum/Math.max(1,demand),progress,
    yielded:plug.filter((u,k)=>Math.hypot(u.x-ps[k][0],u.y-ps[k][1])>TILE).length});
  }
 }
 return {mode:SIM_TRAFFIC_MODE,msPerTick:ms/${ticks},maxSpeedRatio,wallViolations,maxX:Math.max(...us.map(u=>u.x)),samples,audit:occupancyAudit(),traffic:_traffic?{publications:_traffic.config[5],bytes:Object.values(_traffic).filter(ArrayBuffer.isView).reduce((s,a)=>s+a.byteLength,0)}:null};
})()`);
console.log(JSON.stringify(r,null,2));if(arg('out',null))fs.writeFileSync(arg('out'),JSON.stringify(r,null,2));
if(!r.audit.ok||i.errors.length)throw Error(JSON.stringify(i.errors));
