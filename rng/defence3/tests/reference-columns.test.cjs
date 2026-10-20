'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs');
const source=fs.readFileSync(require('node:path').join(__dirname,'../src/sim/sim_unit_state.js'),'utf8');
const code=source.slice(source.indexOf('class SimRefColumn {'),source.indexOf('function _simUnitNextCap'));
const {SimRefColumn,SimSharedColumn,grow,copy}=new Function(code+';return {SimRefColumn,SimSharedColumn,grow:_simRefGrow,copy:_simRefCopy};')();
for(const def of [undefined,null,false,'',-0]){
    const c=new SimRefColumn(30000,def),a=new Array(30000).fill(def),object={value:1};
    const values=[def,undefined,null,false,true,'text',object,NaN,0,-0,17];
    let seed=17;
    for(let k=0;k<100000;k++){
        seed=(Math.imul(seed,1664525)+1013904223)>>>0;const s=seed%a.length,v=values[k%values.length];
        assert.ok(Object.is(c.get(s),a[s]));assert.ok(Object.is(c.set(s,v),a[s]));a[s]=v;
    }
    for(let s=0;s<a.length;s++)assert.ok(Object.is(c.get(s),a[s]));
    const b=copy(c,4096,[0,1020,2048]);
    for(let s=0;s<2048;s++)assert.ok(Object.is(b.get(s),a[s+1020]));
    assert.equal(grow(c,40000),c);assert.equal(c.length,40000);assert.ok(Object.is(c.get(39999),def));
    for(let s=0;s<40000;s++)c.clear(s);
    assert.equal(c.pages.filter(Boolean).length,0);
}
console.log('PASS: paged reference defaults, values, page release, growth and compaction match dense arrays');

for (const def of [undefined,null,false,'']) {
 const c=new SimSharedColumn(70000,def);
 for(let i=0;i<66000;i++)c.set(i,i);
 assert.equal(c.data.BYTES_PER_ELEMENT,4);
 const b=copy(c,70000,[0,1000,65000]);
 for(let i=0;i<65000;i++)assert.equal(b.get(i),i+1000);
 assert.equal(b.pool,c.pool);
 c.set(0,-0);assert.ok(Object.is(c.get(0),-0));c.set(1,NaN);assert.ok(Number.isNaN(c.get(1)));
 c.reserve(80000);assert.ok(Object.is(c.get(79999),def));c.clear(0);assert.ok(Object.is(c.get(0),def));
}
console.log('PASS: shared reference handles widen, preserve identity, grow and compact');
