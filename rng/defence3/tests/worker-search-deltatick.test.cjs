// The work site grid is never written while a worker search reads it, at
// any step size (audit 2026-10-30, A). A step of more base ticks than the
// search cycle (WS_TICKS) ran the grid's steps of its earlier base ticks
// before the cycle's order joined the search posted last step: with fast
// helpers the search had read the old grid, with slow ones (or none: it runs
// at the wait) the new one. Real match ticks, workers searching, step sizes
// 1..20 and transitions (1 -> 20 -> 1, 3 -> 8 -> 5, ...) over every phase
// offset; also with real helpers (--helpers=N).
'use strict';
const assert = require('node:assert/strict'), H = require('./net-harness.cjs');
const helpers = Number(process.argv.find(a => a.startsWith('--helpers='))?.slice(10) || 0);
if (helpers) globalThis.self = { crossOriginIsolated: true };
const controls = { ...H.SMALL_MATCH_CONTROLS, 'cfg-mapsize': '128', 'cfg-map-type': 'arena' };
const world = new H.World({ controls }), i = world.spawn('ws-deltatick', { controls, simWorker: false });
if (helpers) { i.scratch.Worker = require('./real-sim-helper.cjs'); i.eval(`Worker=__scratch.Worker;navigator.hardwareConcurrency=16;simParallelInit('',${helpers});`); }
const result = JSON.parse(i.eval(`JSON.stringify((()=>{
 startSoloGame();
 // (Grid writes while the lane holds a search: the violation.)
 let writes=0, bad=0, posts=0, joins=0, badAt=null;
 const step=_wswStep, post=_wsPost;
 _wswStep=function(){ writes++; if(_wsPosted&&simParallelBackgroundPending(WS_LANE)){ bad++; if(!badAt) badAt={gameTime,simDk}; } return step.apply(this,arguments); };
 _wsPost=function(){ const r=post.apply(this,arguments); if(_wsPosted) posts++; return r; };
 // Workers with nothing to do search again and again.
 for(let k=0;k<200;k++){ const gx=30+(k%20)*2, gy=30+Math.floor(k/20)*2; if(grid[gy][gx].type===TYPE_WALL) continue; for(const t of ['builder_unit','energy_collector','researcher']){ const u=new Unit(t,k&1,gx*TILE+16,gy*TILE+16); units.push(u); unitSlotMapPushed(u); } }
 const seq=[1,1,1,20,1,1,3,8,5,2,7,4,19,1,8,8,3,20,20,1,5,9,6,13,2,1,11,4];
 let ticks=0;
 for(let rep=0;rep<6;rep++) for(const dk of seq){ simDk=dk; gameTick(); currentTick++; ticks++; }
 return {writes,bad,posts,ticks,badAt,gameTime};
})())`));
assert.ok(result.posts > 5, 'searches were posted: ' + JSON.stringify(result));
assert.ok(result.writes > 50, 'grid steps ran');
assert.equal(result.bad, 0, 'grid written while a search was in flight: ' + JSON.stringify(result));
console.log('PASS: no work site grid write during a search across step sizes ' + JSON.stringify({ helpers, ...result }));
for (const w of require('./real-sim-helper.cjs').instances || []) w.terminate();
process.exit(0);
