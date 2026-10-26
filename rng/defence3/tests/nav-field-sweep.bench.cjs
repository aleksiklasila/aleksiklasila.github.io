// Isolate the cache behavior of the million-unit navigation housekeeping pass.
'use strict';
const fs=require('node:fs'),vm=require('node:vm'),{performance}=require('node:perf_hooks');
const file=process.argv[2]||'src/game/flownav.js',source=fs.readFileSync(file,'utf8');
const n=1000000,columns={};
for(const key of ['live','dead','rtEnd','nvProf','nvPK','rkF'])columns[key]=new Int32Array(n);
for(let s=0;s<n;s++){columns.live[s]=1;columns.rtEnd[s]=s%500;columns.nvProf[s]=s%3;columns.nvPK[s]=((s%3)*16777216+s%500)*2+(s&1);columns.rkF[s]=s%4?1:0;}
const slots=Int32Array.from({length:n},(_,i)=>i),pool=()=>({byKey:new Map(Array.from({length:1500},(_,i)=>[(i%3)*16777216+i%500,i])),seen:new Int32Array(1500)});
const context=vm.createContext({_simUnitState:{columns},_unitSlotMapEnsure:()=>slots,units:{length:n},NAV_FIELD_SWEEP_TICKS:128,_navFields:{pools:[pool(),pool()],seenCycle:0},simStepPhases:()=>Array.from({length:20},(_,i)=>30+i)});
vm.runInContext(source.slice(source.indexOf('function navFieldsSweepStep()'),source.indexOf('// Every field again')),context);
const run=vm.runInContext('()=>navFieldsSweepStep()',context),samples=[];
for(let i=0;i<130;i++){const a=performance.now();run();if(i>=30)samples.push(performance.now()-a);}
samples.sort((a,b)=>a-b);console.log(JSON.stringify({file,units:n,dk:20,mean:samples.reduce((a,b)=>a+b,0)/samples.length,p50:samples[50],p95:samples[95],max:samples.at(-1)}));
