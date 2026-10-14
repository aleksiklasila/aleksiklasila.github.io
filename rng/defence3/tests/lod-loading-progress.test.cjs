'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
let now=0;
const timers=[];
const c=vm.createContext({window:{},performance:{now:()=>now},setTimeout:fn=>timers.push(fn)});
vm.runInContext(fs.readFileSync(path.join(__dirname,'../src/audio_visual/renderer3d.js'),'utf8'),c);
const R=Object.create(c.window.Defence3Renderer3D.prototype);
R.ensureColumnProgram=()=>{};
R.advanceColumnAtlas=A=>{now+=150;if(++A.next===A.jobs){A.complete=true;A.prepare=null;}};
(async()=>{
    const A={next:0,jobs:4,prepare(){}};
    const menu=R.preloadColumnAtlas(A);
    const progress=[];
    const match=R.preloadColumnAtlas(A,fraction=>progress.push(fraction));
    assert.deepEqual(progress,[.25],'joining a menu bake immediately reports current progress');
    while(timers.length){timers.shift()();await Promise.resolve();}
    await Promise.all([menu,match]);
    assert.deepEqual(progress,[.25,.5,.75,1,1],'the joining match sees intermediate progress and completion');
    assert.equal(A.progressListeners.size,0,'completed callers release their listeners');

    const stalled={next:0,jobs:4,prepare(){},worker:{terminate(){stalled.terminated=true;}}};
    R.advanceColumnAtlas=()=>{now+=31000;};
    await assert.rejects(R.preloadColumnAtlas(stalled),/stopped responding/);
    assert.equal(stalled.failed,true);assert.equal(stalled.terminated,true);assert.equal(stalled.prepare,null);

    const source=fs.readFileSync(path.join(__dirname,'../src/audio_visual/renderer.js'),'utf8');
    const overlay=[];
    const bad=vm.createContext({
        ensure3DRendererInitialized:()=>({prepareColumnAtlas(){throw Error('allocation failed');}}),
        setTimeout:fn=>fn(),setMatchLoadOverlay:(...args)=>overlay.push(args),_columnLodCatalog:null
    });
    vm.runInContext(source.slice(source.indexOf('function prepareRendererLodAssets('),source.indexOf('function setRenderDimensionMode(')),bad);
    await assert.rejects(bad.prepareRendererLodAssets(true),/allocation failed/);
    assert.deepEqual(overlay.at(-1),[true,'Model preparation failed','allocation failed']);
    console.log('PASS: joining background preparation receives live progress; failures leave an explicit error instead of a frozen loading message.');
})().catch(error=>{console.error(error);process.exitCode=1;});
