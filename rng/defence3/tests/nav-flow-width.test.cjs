'use strict';
const assert=require('node:assert/strict'),H=require('./net-harness.cjs');
for(const dk of [1,20]){
 const world=new H.World({controls:{...H.SMALL_MATCH_CONTROLS,'cfg-mapsize':'128','cfg-map-type':'arena',
  'cfg-starting-energy':'900000000','cfg-starting-astar':'900000000'}});
 const i=world.spawn('wide-flow',{simWorker:false,url:'http://localhost/?wasm64=0'});
 const r=i.eval(`(()=>{
  startingResourcesConfig=normalizeStartingResourcesConfig({spawnCounts:{},researchLevels:{}});
  applyMainMenuControlsToRuntimeState();startSoloGame();
  const crowd=[];
  for(let y=0;y<16;y++)for(let x=0;x<40;x++){
   const u=new Unit('norm',0,(12+x*.5)*TILE,(56+y*.5)*TILE);units.push(u);crowd.push(u);players[0].popCount++;
  }
  for(let t=0;t<NAV_BUILD_TICKS+5;t++)gameTick();
  simDk=${dk};const dest=60*GRID_W+110;
  processAction({action:'move',unitIds:crowd.map(u=>u.id),targetX:110*TILE+16,targetY:60*TILE+16},0);
  const starts=crowd.map(u=>u.x);
  let direct=0;
  for(let t=0;t<${dk===1?600:120};t++){
   gameTick();currentTick++;
   if(t===10)direct=crowd.filter(u=>(u._us.mvNav[u._si*SIM_NAV_STRIDE+7]>>1)===dest).length;
  }
  const advance=crowd.reduce((v,u,k)=>v+u.x-starts[k],0)/crowd.length;
  // The coarse certificate must refuse a rectangle containing a wall block.
  const A=_nav[NAV_PROFILE_GROUND].atlas,P=A.clearPrefix,stride=A.bw+1;
  let prefixOK=true;
  for(let by=0;by<Math.ceil(GRID_H/8);by++)for(let bx=0;bx<A.bw;bx++){
   const k=(by*A.bw+bx)*2,value=P[(by+1)*stride+bx+1]-P[by*stride+bx+1]-P[(by+1)*stride+bx]+P[by*stride+bx];
   if(value!==((A.bm[k]|A.bm[k+1])!==0?1:0))prefixOK=false;
  }
  return {advance,direct,prefixOK,audit:occupancyAudit()};
 })()`);
 console.log({dk,...r});assert.ok(r.prefixOK,'clear-region prefix matches every wall block');
  assert.ok(r.direct>500,'a wide crowd bypasses representative cluster portals');
 assert.ok(r.advance>1500,'sustained forward progress through shared routing');
 assert.ok(r.audit.ok,'all footprints remain exclusive and synchronized');assert.deepEqual(i.errors.map(String),[]);
}
console.log('PASS: wide flow, coarse-step throughput, clear-region certificate and exclusive occupation.');
