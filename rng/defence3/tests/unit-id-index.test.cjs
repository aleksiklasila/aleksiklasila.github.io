'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../src/main.js'),'utf8');
const ctx=vm.createContext({});
vm.runInContext('var _simUnitState=null,units=[];'+source.match(/^class UnitIdIndex \{[\s\S]*?^\}/m)[0]+';this.Index=UnitIdIndex;',ctx);
let seed=17;
const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed;};

// Units without slots (the page's views, hand-made units): the Map.
{
    const index=new ctx.Index(),reference=new Map();
    const ids=[-2147483648,-1025,-1,0,1,1023,1024,1025,2147483647,2**32+1,2**40,Number.MAX_SAFE_INTEGER];
    for(let n=0;n<50000;n++) {
        const id=n%3?random()%30000:ids[random()%ids.length];
        if(n%4) {const unit={id,n};reference.set(id,unit);assert.equal(index.set(id,unit),index);}
        else assert.equal(index.delete(id),reference.delete(id));
        assert.equal(index.size,reference.size);
        assert.equal(index.get(id),reference.get(id));
    }
    for(const [id,unit] of reference)assert.equal(index.get(id),unit);
    for(const bad of ['1',null,undefined,NaN,Infinity,1.5])assert.equal(index.get(bad),undefined);
    for(const id of reference.keys())assert.equal(index.delete(id),true);
    assert.equal(index.size,0);assert.equal(index.loose.size,0);
}

// Slotted units: the hash table of slots, ids from the id column, slots
// reused by later units, deaths (backward-shift deletes), a relayout.
{
    const cap=4096,columns={id:new Int32Array(cap)},S={cap,columns,owners:new Array(cap).fill(null)};
    ctx._simUnitState=S;
    const index=new ctx.Index(),reference=new Map(),free=[];
    for(let s=cap-1;s>=0;s--)free.push(s);
    let nextId=1;
    const live=[];
    for(let n=0;n<200000;n++) {
        if(live.length<3000&&(n%3||live.length<10)) {
            const s=free.pop(),id=nextId++,u={id,_us:columns,_si:s};
            columns.id[s]=id;S.owners[s]=u;index.set(id,u);reference.set(id,u);live.push(u);
        } else {
            const k=random()%live.length,u=live[k];live[k]=live[live.length-1];live.pop();
            assert.equal(index.delete(u.id),true);reference.delete(u.id);
            S.owners[u._si]=null;free.push(u._si);
        }
        if(n%997===0)for(const [id,u] of reference)assert.equal(index.get(id),u,'id '+id+' at '+n);
        assert.equal(index.size,reference.size);
    }
    for(const [id,u] of reference)assert.equal(index.get(id),u);
    for(let id=nextId;id<nextId+100;id++)assert.equal(index.get(id),undefined);
    assert.equal(index.used,reference.size);
    // A relayout: every unit in another slot; the table made again from the list.
    const S2={cap,columns:{id:new Int32Array(cap)},owners:new Array(cap).fill(null)};
    ctx.units=[];let s=0;
    for(const u of reference.values()){u._us=S2.columns;u._si=s;S2.columns.id[s]=u.id;S2.owners[s]=u;s++;ctx.units.push(u);}
    ctx._simUnitState=S2;index.stale=true;
    for(const [id,u] of reference)assert.equal(index.get(id),u);
    assert.equal(index.used,reference.size);
}
console.log('PASS: unit ids: the slot table and the Map match a reference through inserts, deaths, slot reuse, sparse/large ids and a relayout');
