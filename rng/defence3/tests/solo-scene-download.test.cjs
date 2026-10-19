'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
(async()=>{
    const button={disabled:false,textContent:'Export Snapshot'},messages=[],downloads=[],timers=[];
    let blob,removed=false,fail=false;
    const c=vm.createContext({Blob,Response,CompressionStream,DecompressionStream,TextDecoder,Date,
        console:{error(){}},URL:{createObjectURL:b=>(blob=b,'blob:test'),revokeObjectURL(){}},
        setTimeout:(fn,ms)=>timers.push(ms),showUiBanner:(...args)=>messages.push(args),
        document:{getElementById:()=>button,body:{appendChild(){}},createElement:()=>({click(){downloads.push([this.href,this.download]);},remove(){removed=true;}})}});
    vm.runInContext(fs.readFileSync(path.join(__dirname,'../src/utils/utils_file_io.js'),'utf8'),c);
    vm.runInContext(fs.readFileSync(path.join(__dirname,'../src/utils/utils_solo_snapshot.js'),'utf8'),c);
    c.captureSoloGameSnapshotParts=async()=>{if(fail)throw Error('test failure');return ['{"scene":"download test"}\n'];};
    const pending=c.downloadSoloGameSnapshot();assert.equal(button.disabled,true);
    await pending;
    assert.equal(button.disabled,false);assert.equal(button.textContent,'Export Snapshot');
    assert.equal(downloads.length,1);assert.match(downloads[0][1],/\.gz$/);
    assert.equal(removed,true);assert.ok(timers[0]>=60000,'large downloads keep their URL alive');
    assert.equal(blob.type,'application/gzip');
    assert.deepEqual(await new Response(blob.stream().pipeThrough(new DecompressionStream('gzip'))).json(),[{scene:'download test'}]);
    await c.downloadSoloGameSnapshot(false);
    assert.match(downloads[1][1],/\.json$/);assert.equal(blob.type,'application/json');
    assert.deepEqual(JSON.parse(await blob.text()),[{scene:'download test'}]);
    fail=true;await c.downloadSoloGameSnapshot();
    assert.equal(downloads.length,2);assert.equal(button.disabled,false);assert.match(messages.at(-1)[0],/test failure/);
    console.log('PASS snapshot download: JSON/gzip, download click, button reset, persistent error');
})().catch(e=>{console.error(e);process.exitCode=1;});
