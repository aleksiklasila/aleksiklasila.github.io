'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const c=vm.createContext({self:{},console:{warn(){}},importScripts(){},Defence3Renderer3D:function(){},
    OffscreenCanvas:class {getContext(){return null;}}});
vm.runInContext(fs.readFileSync(path.join(__dirname,'../src/audio_visual/renderer3d-lod-worker.js'),'utf8'),c);
const Baker=vm.runInContext('GpuSnapshots',c),b=Object.create(Baker.prototype);
// Half a tiny frame is opaque paint, half transparent. Match RGBA8 resolve,
// preserving coverage once and retaining the final rendered color.
Object.assign(b,{sizes:[1],sampleScales:[4],renderSizes:[4],sheetWidth:4,pixels:new Uint8Array(64)});
for(let i=0;i<8;i++)b.pixels.set([120,80,40,255],i*4);
assert.deepEqual([...b.unpack([1,0,0,1],0,0).levels[0].color],[60,40,20,128]);
// Saturated samples mix in the same space as live framebuffer samples.
for(let i=0;i<16;i++)b.pixels.set(i<8?[255,0,0,255]:[0,0,255,255],i*4);
assert.deepEqual([...b.unpack([1,0,0,1],0,0).levels[0].color],[128,0,128,255]);
// Resolved MSAA pixels already contain coverage; do not premultiply again.
for(let i=0;i<16;i++)b.pixels.set([100,50,25,128],i*4);
assert.deepEqual([...b.unpack([1,0,0,1],0,0).levels[0].color],[100,50,25,128]);
b.pixels.fill(0);
assert.deepEqual([...b.unpack([1,0,0,1],0,0).levels[0].color],[0,0,0,0]);
assert.equal('mask' in b.unpack([1,0,0,1],0,0).levels[0],false);
// The frame is identical across LODs, but perspective convergence changes
// with target size; each mip must represent its own camera distance.
Object.assign(b,{sx:1,sy:1,data:{positions:[-1,0,-1,1,2,1],details:new Float32Array(8),normals:new Float32Array(6)}});
const near=b.projection(.2,.65,32,1200),far=b.projection(.2,.65,4,1200);
assert.deepEqual([...near.meta],[...far.meta]);
assert.ok(Math.abs(near.vp[7]/far.vp[7]-8)<1e-5);
assert.ok(near.vp[7]<0,'capture has perspective depth, not an orthographic camera');
console.log('PASS: tiny captures conserve painted coverage and sample each LOD at its target distance.');
