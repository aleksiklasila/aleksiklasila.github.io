'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const c=vm.createContext({self:{},console:{warn(){}},importScripts(){},Defence3Renderer3D:function(){},
    OffscreenCanvas:class {getContext(){return null;}}});
vm.runInContext(fs.readFileSync(path.join(__dirname,'../src/audio_visual/renderer3d-lod-worker.js'),'utf8'),c);
const Baker=vm.runInContext('GpuSnapshots',c),b=Object.create(Baker.prototype);
// Half a tiny frame is opaque paint, half transparent. Its 1px capture must
// preserve that area and ownership contribution rather than one hit sample.
Object.assign(b,{sizes:[1],sampleScales:[4],renderSizes:[4],sheetWidth:4,pixels:[new Uint8Array(64),new Uint8Array(64)]});
for(let i=0;i<8;i++) {b.pixels[0].set([120,80,40,255],i*4);b.pixels[1].set([80,60,30,255],i*4);}
const image=b.unpack([1,0,0,1],0,0).levels[0];
assert.deepEqual([...image.color],[60,40,20,128]);
assert.deepEqual([...image.mask],[20,10,5,128]);
// The frame is identical across LODs, but perspective convergence changes
// with target size; each mip must represent its own camera distance.
Object.assign(b,{sx:1,sy:1,data:{positions:[-1,0,-1,1,2,1],details:new Float32Array(8),normals:new Float32Array(6)}});
const near=b.projection(.2,.65,32,1200),far=b.projection(.2,.65,4,1200);
assert.deepEqual([...near.meta],[...far.meta]);
assert.ok(Math.abs(near.vp[7]/far.vp[7]-8)<1e-5);
assert.ok(near.vp[7]<0,'capture has perspective depth, not an orthographic camera');
console.log('PASS: tiny captures conserve painted coverage and sample each LOD at its target distance.');
