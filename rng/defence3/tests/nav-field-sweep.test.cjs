'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../src/game/flownav.js'),'utf8');
const sweep=source.slice(source.indexOf('function navFieldsSweepStep()'),source.indexOf('// Every field again'));
// Compare field retention to one base-tick share at a time, including a
// wrap that expires fields before marking the next cycle's shares.
for(const n of [0,1,127,129,1027])for(const dk of [1,4,20,127,128])for(const offset of [0,7,119,127]){
 const step=128,C={};
 for(const name of ['live','dead','rtEnd','nvProf','nvPK','rkF'])C[name]=new Int32Array(n+13);
 const slots=Int32Array.from({length:n},(_,i)=>(i*37)%(n+13));
 for(let s=0;s<n+13;s++){C.live[s]=s%5?1:0;C.dead[s]=s%17===0?1:0;C.rtEnd[s]=s%19;C.nvProf[s]=s%3;C.nvPK[s]=s%11===0?-1:((s%3)*16777216+s%19)*2+(s&1);C.rkF[s]=s%4?1:0;}
 const pool=()=>{const byKey=new Map();for(let p=0;p<3;p++)for(let d=0;d<20;d++)byKey.set(p*16777216+d,byKey.size);return{byKey,seen:new Int32Array(byKey.size),pool:true,meta:new Int32Array(byKey.size*8),free:[],pending:[]};};
 const pools=[pool(),pool()],expected=pools.map(p=>({byKey:new Map(p.byKey),seen:p.seen.slice()}));
 const phases=Array.from({length:dk},(_,i)=>(offset+i)%step);
 let cycle=0;
 for(const k of phases){const mark=cycle+1;for(let i=k;i<n;i+=step){const s=slots[i];if(!C.live[s]||C.dead[s])continue;
  if(C.rtEnd[s]>=0&&C.rkF[s]===1){const p=expected[1],slt=p.byKey.get(C.nvProf[s]*16777216+C.rtEnd[s]);if(slt!==undefined)p.seen[slt]=mark;}
  const pk=C.nvPK[s];if(pk>=0){const p=expected[pk&1],slt=p.byKey.get(pk>>1);if(slt!==undefined)p.seen[slt]=mark;}
 }if(k===step-1){for(const p of expected)for(const [key,s]of p.byKey)if(p.seen[s]<mark)p.byKey.delete(key);cycle++;}}
 const ctx=vm.createContext({NAV_FIELD_SWEEP_TICKS:step,NAV_FIELD_META:8,simStepPhases:()=>phases,_navFields:{pools,seenCycle:0},_navNext:{nav:null},_simUnitState:{columns:C},_unitSlotMapEnsure:()=>slots,units:{length:n}});
 vm.runInContext(sweep+';navFieldsSweepStep()',ctx);
 assert.equal(ctx._navFields.seenCycle,cycle);
 for(let w=0;w<2;w++){assert.deepEqual([...pools[w].byKey],[...expected[w].byKey]);assert.deepEqual(pools[w].seen,expected[w].seen);}
}
console.log('Navigation field sweep matches base-tick shares and expiry across cycle boundaries.');
