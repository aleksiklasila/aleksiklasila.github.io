'use strict';
const assert=require('node:assert/strict'),{execFileSync}=require('node:child_process');
const run=(scenario,ticks)=>JSON.parse(execFileSync(process.execPath,['tests/crowd-traffic.bench.cjs','--scenario='+scenario,'--ticks='+ticks],{encoding:'utf8',maxBuffer:4e6}));
for(const scenario of ['plug','counter','wall']){
 const r=run(scenario,scenario==='wall'?160:80),s=r.samples.at(-1);
 assert(r.audit.ok,scenario+' exclusive bitmap remains consistent');
 assert.equal(r.wallViolations,0,scenario+' terrain remains solid');
 assert(r.maxSpeedRatio<1.01,scenario+' no extra speed from yielding');
 if(scenario!=='wall'){
  assert(s.moving/s.demand>.95,scenario+' most ordered units move');
  assert(s.flowing/s.demand>.85,scenario+' most ordered units reach half stat speed');
  assert.equal(s.yielded,768,scenario+' passive/counterflow plug responds');
 }else assert(r.maxX<90*32,'closed wall cannot be pushed through');
 console.log('PASS '+scenario+': moving '+(100*s.moving/s.demand).toFixed(1)+'%, half speed '+(100*s.flowing/s.demand).toFixed(1)+'%, strict occupancy and terrain');
}
