'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../src/audio_visual/renderer3d-lod-worker.js'),'utf8');
const Snapshots=vm.runInNewContext(source.slice(source.indexOf('class GpuSnapshots'),source.indexOf('\nlet gpu;'))+'\nGpuSnapshots;');
const bake=Object.create(Snapshots.prototype);
bake.sizes=[2];bake.sampleScales=[1];bake.renderSizes=[2];bake.sheetWidth=4;
// A dark material beside a final blue owner-colored edge, including coverage.
// Filtering must preserve the actual rendered pixels, with no tint reconstruction.
bake.pixels=new Uint8Array(32);
for(let y=0;y<2;y++)bake.pixels.set([100,50,0,255,40,80,160,255],y*16);
const level=bake.unpack([1,0,0,1],0,0).levels[0];
for(let channel=0;channel<3;channel++) {
    const filtered=(level.color[channel]+level.color[4+channel])/2;
    assert.equal(filtered,[70,65,80][channel]);
}
assert.deepEqual([...level.color.slice(0,4)],[100,50,0,255],'material is unchanged');
assert.deepEqual([...level.color.slice(4,8)],[40,80,160,255],'owner color is already final');
assert.equal(level.mask,undefined,'no ownership mask exists');
// Static models use the same square projection as every animation frame.
bake.data={positions:new Float32Array([-.5,0,-.5,.5,0,-.5,-.5,.1,.5,.5,.1,.5]),details:new Float32Array(16),normals:new Float32Array(12)};
bake.sx=bake.sy=1;
const rectangle=bake.projection(0,.04);
assert.equal(rectangle.meta.length,4,'one shared projection format');
for(let i=0;i<bake.data.positions.length;i+=3) {
    const p=bake.data.positions,m=rectangle.vp;
    const x=m[0]*p[i]+m[4]*p[i+1]+m[8]*p[i+2]+m[12];
    const y=m[1]*p[i]+m[5]*p[i+1]+m[9]*p[i+2]+m[13];
    assert.ok(Math.abs(x)<1&&Math.abs(y)<1,'capture retains the complete model');
}
console.log('PASS: filtering preserves dark material and exact player tint at mixed edges.');
