'use strict';
// Startup smoke check on a crowded scenario, without UI clicks. Sustained
// engagement is covered by tests/scene-orders.test.cjs; initial motion alone
// does not prove the armies continue fighting.
const fs=require('node:fs'),zlib=require('node:zlib'),H=require('../net-harness.cjs');
async function main(){
 const file=process.argv[2]||'tests/scenarios/equal_numbers/fight-2-teams-unit_norm_R0.json.gz';
 const records=JSON.parse(zlib.gunzipSync(fs.readFileSync(file))),world=new H.World(),g=world.spawn('scene-movement',{simWorker:false});
 g.scratch.scene={header:records[0],records:records.slice(1,-1)};
 g.eval('startMainThreadLoops=()=>{};document.getElementById("starting-resources-popup").classList.add("hidden")');
 await g.eval('restoreSoloGameSnapshot(__scratch.scene)');
 g.eval('__scratch.starts=new Map(units.filter(u=>u.owner===0&&u.unitType==="norm").map(u=>[u.id,[u.x,u.y]]))');
 console.log('Loaded; checking 60 native ticks');
 for(let i=0;i<60;i++)g.eval('runOneTick()');
 const result=g.eval(`(()=>{let alive=0,moved=0,stationary=0,orders={};for(const u of units){const p=__scratch.starts.get(u.id);if(!p||u.dead||u.energy<=0)continue;alive++;if(Math.hypot(u.x-p[0],u.y-p[1])>8)moved++;else stationary++;orders[u.commandState]=(orders[u.commandState]||0)+1;}return{alive,moved,stationary,orders,errors:__scratch.errors};})()`);
 console.log(JSON.stringify(result));if(g.errors.length)throw Error(g.errors.map(String).join('\n'));
 if(!result.alive||result.moved<result.alive*.9)throw Error('Restored armies did not start moving without reissuing orders');
}
main().catch(e=>{console.error(e);process.exitCode=1;});
