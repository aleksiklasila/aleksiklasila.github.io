'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../src/main.js'),'utf8');
const ctx=vm.createContext({});
vm.runInContext(source.match(/^class UnitIdIndex \{[\s\S]*?^\}/m)[0]+';this.Index=UnitIdIndex;',ctx);
const index=new ctx.Index(),reference=new Map();
let seed=17;
const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed;};
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
assert.equal(index.size,0);assert.equal(index.pages.size,0);
console.log('PASS: paged unit IDs match Map through inserts, replacements, deaths, sparse/large IDs and full page release');
