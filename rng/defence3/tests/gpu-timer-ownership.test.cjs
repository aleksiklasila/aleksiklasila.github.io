'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../src/audio_visual/renderer3d.js'),'utf8');
const methods=source.slice(source.indexOf('        gpuTimerBegin() {'),source.indexOf('        resizeForSnapshot('));
const C=vm.runInNewContext('(class Timer {'+methods+'})');
const ext={TIME_ELAPSED_EXT:1,GPU_DISJOINT_EXT:2};let current=null,created=0,ended=0;
const gl={CURRENT_QUERY:3,QUERY_RESULT_AVAILABLE:4,QUERY_RESULT:5,getExtension:()=>ext,getQuery:()=>current,
    createQuery:()=>({id:++created,valid:false}),isQuery:q=>q.valid,getParameter:()=>false,
    beginQuery:(_,q)=>{assert.equal(current,null,'nested timer');q.valid=true;current=q;},
    endQuery:()=>{assert.ok(current);current=null;ended++;},deleteQuery:q=>{q.valid=false;},
    getQueryParameter:(q,key)=>{assert.ok(q.valid,'invalid timer result');return key===4?true:2000000;}};
const t=new C();t.gl=gl;
const foreign={valid:true};current=foreign;t.gpuTimerBegin();t.gpuTimerEnd();
assert.equal(current,foreign);assert.equal(created,0);assert.equal(ended,0);
current=null;t.gpuTimerBegin();const owned=current;t.gpuTimerBegin();
assert.equal(current,owned);assert.equal(created,1);t.gpuTimerEnd();assert.equal(ended,1);
t.gpuQueries.unshift({valid:false});t.gpuTimerBegin();assert.equal(t.gpuFrameMs,2);t.gpuTimerEnd();
t.gpuTimerBegin();current=foreign;t.gpuTimerEnd();assert.equal(current,foreign);assert.equal(ended,2);
console.log('PASS renderer GPU timers preserve query ownership and ignore invalid pending results');
