'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync(require('node:path').join(__dirname,'../src/utils/utils_networking.js'),'utf8');
const start=source.indexOf('let _soloStartPreparation=null;'),end=source.indexOf('// The load popup',start);
let release,starts=0,loads=0;
const pending=new Promise(resolve=>{release=resolve;});
const c=vm.createContext({Date,readConfigFromMenu(){},prepareRendererLodAssets(){loads++;return pending;},initAudio(){},startGame(){starts++;},setMatchLoadOverlay(){}});
vm.runInContext(source.slice(start,end),c);
(async()=>{
    const first=c.startSoloGame(),second=c.startSoloGame();
    assert.equal(starts,0,'a match cannot start with unfinished model views');
    assert.equal(loads,1,'repeated clicks share the same preparation');
    assert.equal(first,second);
    release();await first;
    assert.equal(starts,1,'the match starts only after all views are uploaded');
    c.prepareRendererLodAssets=()=>null;
    c.startSoloGame();assert.equal(starts,2,'canvas fallback keeps synchronous startup');
    console.log('PASS: match startup waits for LOD preparation and repeated clicks do not start duplicate matches.');
})().catch(e=>{console.error(e);process.exitCode=1;});
