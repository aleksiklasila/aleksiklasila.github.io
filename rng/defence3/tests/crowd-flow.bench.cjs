'use strict';
// Real movement/navigation/occupation, with one destination and no combat.
// --baseline loads the pre-change WASM saved beside the measurement report.
const assert = require('node:assert/strict');
if (process.argv.includes('--baseline')) process.env.DEFENCE_TEST_SOURCE_OVERRIDES = JSON.stringify({
    'src/sim/sim_wasm_bin.js': 'tests/test-runs/crowd-flow-20261021/baseline-wasm.js'
});
const H = require('./net-harness.cjs');
const {performance} = require('node:perf_hooks');
const size=Number(process.env.FLOW_MAP||1000),cols=Number(process.env.FLOW_COLS||400),rows=Number(process.env.FLOW_ROWS||200);
const spacing=Number(process.env.FLOW_SPACING||1),dk=Number(process.env.FLOW_DK||1);
const world = new H.World({controls:{...H.SMALL_MATCH_CONTROLS,'cfg-mapsize':String(size),
    'cfg-map-type':'arena','cfg-max-pop':'20000','cfg-starting-energy':'900000000','cfg-starting-astar':'900000000'}});
const inst = world.spawn('flow',{simWorker:false,url:'http://localhost/?wasm64=0'});
const ticks = Number(process.env.FLOW_TICKS || 600);
inst.scratch.now=()=>performance.now();
const result = inst.eval(`(() => {
 performance.now=__scratch.now;
 startingResourcesConfig=normalizeStartingResourcesConfig({spawnCounts:{},researchLevels:{}});
 applyMainMenuControlsToRuntimeState();startSoloGame();
 for(let y=1;y<GRID_H-1;y++)for(let x=1;x<GRID_W-1;x++){
  grid[y][x].type=TYPE_FLOOR;simMoveTileTypeChanged(x,y);
 }
 const us=[];
 for(let y=0;y<${rows};y++)for(let x=0;x<${cols};x++){
  const u=new Unit('norm',0,(4+x*${spacing})*TILE,(GRID_H/2-${rows*spacing/2}+y*${spacing})*TILE);units.push(u);us.push(u);players[0].popCount++;
 }
 for(let t=0;t<NAV_BUILD_TICKS+5;t++)gameTick();
 simDk=${dk};
 processAction({action:'move',unitIds:us.map(u=>u.id),targetX:(GRID_W-10)*TILE+16,targetY:GRID_H/2*TILE+16},0);
 const starts=us.map(u=>u.x);const samples=[];let ms=0;
 for(let t=0;t<${ticks};t++){
  const a=performance.now();gameTick();ms+=performance.now()-a;
  if((t+1)%100===0)samples.push({tick:t+1,advance:us.reduce((v,u,k)=>v+u.x-starts[k],0)/us.length,
   moving:us.filter(u=>Math.hypot(u.x-u.prevX,u.y-u.prevY)>.5).length,
   crossed:us.filter(u=>u.x>GRID_W/2*TILE).length});
 }
 return {units:us.length,msPerTick:ms/${ticks},samples,audit:occupancyAudit(),stats:occupancyStats()};
})()`);
console.log(JSON.stringify(result,null,2));
assert.ok(result.audit.ok,'exclusive footprint accounting remains exact');
assert.deepEqual(inst.errors.map(String),[]);
if(!process.argv.includes('--baseline') && ticks>=600) assert.ok(result.samples.at(-1).advance>600,'crowd makes sustained progress');
