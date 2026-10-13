'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
let clock=0;
const jobs=[], uploads=[], state={};let fullMipRebuilds=0;
const gl=new Proxy({}, {get(_,name) {
    if(/^[A-Z_0-9]+$/.test(name))return name;
    return (...args)=>{
        if(name==='pixelStorei')state[args[0]]=args[1];
        if(name==='texImage2D'||name==='texSubImage2D')uploads.push({name,args,state:{...state}});
        if(name==='createTexture')return {};
        if(name==='generateMipmap')fullMipRebuilds++;
    };
}});
const ctx={clearRect(){},strokeRect(){},drawImage(){},scale(){}};
const catalog={width:2,stride:81,lookup:new Float32Array(64),styles:['gold','astar'].map(type=>({
    modelKey:type+'_mine_active',color:'#aaa',neutral:true,scaleX:1,scaleY:1,draw(){jobs.push(type);}
}))};
const c=vm.createContext({window:{},console,performance:{now:()=>clock+=2},
    document:{createElement:()=>({width:0,height:0,getContext:()=>ctx})},getColumnLodCatalog:()=>catalog});
vm.runInContext(fs.readFileSync(path.join(__dirname,'../src/audio_visual/renderer3d.js'),'utf8'),c);
const R=Object.create(c.window.Defence3Renderer3D.prototype);R.gl=gl;
R.bakeColumnModel=(g,m,data,style,yaw,panel,pitch)=>{jobs.push([style.modelKey,yaw,pitch]);return [1,0,0,1];};
// Simulate texture state left by another pass.
state.UNPACK_FLIP_Y_WEBGL=true;state.UNPACK_PREMULTIPLY_ALPHA_WEBGL=true;
const A=R.prepareColumnAtlas();
assert.equal(A.next,1,'cold preparation is bounded to one job when the time budget expires');
R.prepareColumnAtlas();assert.equal(A.next,1,'render-time atlas reads never advance preparation');
R.advanceColumnAtlas(A);assert.deepEqual(jobs,['gold','gold','astar','astar'],'flat and native model panels precede directional bakes');
for(const panel of A.sources) {assert.equal(panel.width,96);assert.equal(panel._ownerMask.width,96,'ownership and material use the live panel resolution');}
for(let i=2;i<162;i++) {assert.equal(R.prepareColumnAtlas(),A);R.advanceColumnAtlas(A);assert.equal(A.next,i+1);}
assert.equal(A.prepare,null);assert.equal(A.sources,null);
assert.equal(jobs.length,164);
assert.deepEqual([...new Set(jobs.slice(4).map(j=>Number(j[2].toFixed(2))))],[.08,.35,.65,1.05,1.57],'low, tilted, middle and high camera angles are cached');
R.prepareColumnAtlas();assert.equal(jobs.length,164,'zoom/camera reuse never rebakes the catalog');
for(const upload of uploads)if(upload.args.includes('FLOAT')) {
    assert.equal(upload.state.UNPACK_FLIP_Y_WEBGL,false,'lookup rows are never flipped');
    assert.equal(upload.state.UNPACK_PREMULTIPLY_ALPHA_WEBGL,false,'numeric style data must never be premultiplied');
}
assert.ok(uploads.some(u=>u.name==='texSubImage2D'&&u.args.includes('UNSIGNED_BYTE')&&u.state.UNPACK_PREMULTIPLY_ALPHA_WEBGL),'sprite filtering uses premultiplied colors');
assert.equal(fullMipRebuilds,0,'preparing one miniature never rebuilds both whole atlases');
assert.deepEqual([...new Set(uploads.filter(u=>u.name==='texSubImage2D'&&u.args.includes('UNSIGNED_BYTE')).map(u=>u.args[1]))],[0,1,2,3,4,5]);
// A GPU bake has already multiplied material RGB by MSAA coverage. Unlike
// canvas uploads, these bytes must survive texSubImage2D without conversion.
const R2=Object.create(c.window.Defence3Renderer3D.prototype);R2.gl=gl;
const B=R2.prepareColumnAtlas();R2.advanceColumnAtlas(B);
const levels=Array.from({length:6},(_,level)=>({size:32>>level,color:new Uint8Array((32>>level)**2*4),mask:new Uint8Array((32>>level)**2*4)}));
for(const level of levels){level.color.set([100,50,25,128]);level.mask.set([20,10,5,128]);}
B.worker={};B.prepared={images:Array(80).fill({meta:[1,0,0,1],levels})};
const beforeUpload=uploads.length;R2.advanceColumnAtlas(B);
const bakedUploads=uploads.slice(beforeUpload).filter(u=>u.name==='texSubImage2D'&&u.args.includes('UNSIGNED_BYTE'));
assert.equal(bakedUploads.length,12,'color and ownership upload each of six prepared mips');
for(const upload of bakedUploads) {
    assert.equal(upload.state.UNPACK_PREMULTIPLY_ALPHA_WEBGL,false,'premultiplied worker pixels must not be multiplied by coverage again');
    assert.equal(upload.state.UNPACK_FLIP_Y_WEBGL,false);
}
assert.deepEqual([...bakedUploads[0].args.at(-1).slice(0,4)],[100,50,25,128]);
const sizes=[128,32,64,32,128,64,32],packed=c.window.Defence3Renderer3D.packColumnSnapshots(sizes);
for(let i=0;i<sizes.length;i++) {
    const a=packed.rects[i];assert.equal(a.size,sizes[i]);assert.ok(a.x+a.size<=packed.pixels&&a.y+a.size<=packed.pixels);
    const block=Math.floor((a.code-1)/3),decoded=32*2**((a.code-1)%3);
    assert.equal(decoded,a.size);assert.equal((block%(packed.pixels/32))*32,a.x);assert.equal(Math.floor(block/(packed.pixels/32))*32,a.y);
    for(let j=0;j<i;j++){const b=packed.rects[j];assert.ok(a.x+a.size<=b.x||b.x+b.size<=a.x||a.y+a.size<=b.y||b.y+b.size<=a.y,'packed snapshots never overlap');}
}
console.log('PASS: bounded atlas preparation, panel priority, numeric upload state, premultiplied sprites, cache reuse.');
