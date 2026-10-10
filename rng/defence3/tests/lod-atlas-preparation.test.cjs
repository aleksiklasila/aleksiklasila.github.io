'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
let clock=0;
const jobs=[], uploads=[], state={};
const gl=new Proxy({}, {get(_,name) {
    if(/^[A-Z_0-9]+$/.test(name))return name;
    return (...args)=>{
        if(name==='pixelStorei')state[args[0]]=args[1];
        if(name==='texImage2D'||name==='texSubImage2D')uploads.push({name,args,state:{...state}});
        if(name==='createTexture')return {};
    };
}});
const ctx={clearRect(){},strokeRect(){},drawImage(){}};
const catalog={width:2,lookup:new Float32Array(64),styles:['gold','astar'].map(type=>({
    modelKey:type+'_mine_active',color:'#aaa',neutral:true,scaleX:1,scaleY:1,draw(){jobs.push(type);}
}))};
const c=vm.createContext({window:{},console,performance:{now:()=>clock+=2},
    document:{createElement:()=>({width:0,height:0,getContext:()=>ctx})},getColumnLodCatalog:()=>catalog});
vm.runInContext(fs.readFileSync(path.join(__dirname,'../src/audio_visual/renderer3d.js'),'utf8'),c);
const R=Object.create(c.window.Defence3Renderer3D.prototype);R.gl=gl;
R.bakeColumnModel=(g,m,data,style,yaw)=>{jobs.push([style.modelKey,yaw]);return [1,0,0,1];};
// Simulate texture state left by another pass.
state.UNPACK_FLIP_Y_WEBGL=true;state.UNPACK_PREMULTIPLY_ALPHA_WEBGL=true;
const A=R.prepareColumnAtlas();
assert.equal(A.next,1,'cold preparation is bounded to one job when the time budget expires');
R.prepareColumnAtlas();assert.deepEqual(jobs,['gold','astar'],'all canonical panels precede directional bakes');
for(let i=2;i<18;i++) {assert.equal(R.prepareColumnAtlas(),A);assert.equal(A.next,i+1);}
assert.equal(A.prepare,null);assert.equal(A.sources,null);
assert.equal(jobs.length,18);
R.prepareColumnAtlas();assert.equal(jobs.length,18,'zoom/camera reuse never rebakes the catalog');
for(const upload of uploads)if(upload.args.includes('FLOAT')) {
    assert.equal(upload.state.UNPACK_FLIP_Y_WEBGL,false,'lookup rows are never flipped');
    assert.equal(upload.state.UNPACK_PREMULTIPLY_ALPHA_WEBGL,false,'numeric style data must never be premultiplied');
}
assert.ok(uploads.some(u=>u.name==='texSubImage2D'&&u.args.includes('UNSIGNED_BYTE')&&u.state.UNPACK_PREMULTIPLY_ALPHA_WEBGL),'sprite filtering uses premultiplied colors');
console.log('PASS: bounded atlas preparation, panel priority, numeric upload state, premultiplied sprites, cache reuse.');
