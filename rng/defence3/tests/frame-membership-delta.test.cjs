'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../src/sim/sim_client.js'),'utf8');
let freezes=0,touches=0;
class View {
    constructor(id,s){this.id=id;this._s=s;this.dead=false;}
    _freeze(){freezes++;this.lastX=c._pageFrame.x[this._s];this._s=-1;}
}
const c=vm.createContext({PageUnit:View,_pageSlotViews:[],_pageUnitsById:new Map()});
vm.runInContext(source.slice(source.indexOf('function _simClientUpdateStableSlots('),source.indexOf('function _simClientApplyFrame(')),c);
const n=100000,old={n,id:Int32Array.from({length:n},(_,i)=>i),x:Float32Array.from({length:n},(_,i)=>i*3)};
for(let s=0;s<n;s++){const v=new View(s,s);Object.defineProperty(v,'_stamp',{set(){touches++;}});c._pageSlotViews[s]=v;c._pageUnitsById.set(s,v);}
c._pageFrame=old;
const retained=c._pageSlotViews[50],retired=c._pageSlotViews[7];
const next={n,count:n-1,id:old.id.slice(),order:Int32Array.from({length:n-1},(_,i)=>i<7?i:i+1)};next.id[7]=-1;
const result=c._simClientUpdateStableSlots(next,old);
assert.equal(result.length,n-1);assert.equal(result[49],retained);
assert.equal(retired.dead,true);assert.equal(retired.lastX,21);assert.equal(freezes,1);assert.equal(touches,0);
assert.equal(c._pageUnitsById.has(7),false);
c._pageFrame={...next,x:old.x};
const reuse={n,count:n,id:next.id.slice(),order:Int32Array.from({length:n},(_,i)=>n-1-i)};reuse.id[7]=n+1;
const reused=c._simClientUpdateStableSlots(reuse,next);
assert.equal(reused[n-8].id,n+1);assert.equal(c._pageUnitsById.get(50),retained);
const remap={...reuse,id:reuse.id.slice()};[remap.id[49],remap.id[50]]=[remap.id[50],remap.id[49]];
assert.equal(c._simClientUpdateStableSlots(remap,reuse),null,'restores that remap existing IDs use the general identity-preserving path');
assert.equal(retained.dead,false,'fallback detection mutates nothing');
console.log('PASS 100k-slot death, frozen final position, slot reuse, ordering and restore fallback without survivor writes');
