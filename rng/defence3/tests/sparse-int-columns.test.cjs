'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../src/sim/sim_unit_state.js'),'utf8');
const code=source.slice(source.indexOf('class SimSparseIntColumn {'),source.indexOf('const _simJsName ='));
const {Column,grow,copy}=new Function(code+';return {Column:SimSparseIntColumn,grow:_simSparseIntGrow,copy:_simSparseIntCopy};')();
for(const def of [0,-1]){
    const c=new Column(4099,def),dense=new Int32Array(4099).fill(def);
    assert.equal(c.activePages,0);
    for(const s of [0,1023,1024,2047,2048,4098]){
        for(const value of [NaN,Infinity,undefined,4294967295,17.8,-42,def]){
            c.set(s,value);dense[s]=value;assert.equal(c.get(s),dense[s]);
        }
    }
    let seed=17;
    for(let i=0;i<20000;i++){
        seed=(Math.imul(seed,1664525)+1013904223)>>>0;const s=seed%dense.length,v=i%7?seed:def;
        c.set(s,v);dense[s]=v;
    }
    assert.equal(c.populated,dense.filter(v=>v!==def).length);
    const g=grow(c,9000,def,4099);
    const b=copy(c,5000,def,[0,1019,2051,3000,0,1000]);
    for(let i=0;i<9000;i++)assert.equal(g.get(i),i<dense.length?dense[i]:def);
    for(let i=0;i<5000;i++)assert.equal(b.get(i),i<2051?dense[i+1019]:i>=3000&&i<4000?dense[i-3000]:def);
    for(let i=0;i<4099;i++)c.clear(i);
    assert.equal(c.activePages,0);assert.equal(c.populated,0);
}
console.log('PASS: sparse integer defaults, coercion, page release, growth and compaction');
