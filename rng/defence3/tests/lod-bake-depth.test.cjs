'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const context=vm.createContext({window:{},console});
vm.runInContext(fs.readFileSync(require('node:path').join(__dirname,'../src/audio_visual/renderer3d.js'),'utf8'),context);
const renderer=Object.create(context.window.Defence3Renderer3D.prototype);
function canvasContext() {
    return {createImageData:(w,h)=>({data:new Uint8ClampedArray(w*h*4)}),putImageData(image){this.image=image.data;}};
}
// Two intersecting faces have identical average depth. Each must win on
// its own side of the intersection, irrespective of triangle submission.
const positions=[-.4,0,-.4, .4,0,.4, 0,1,0, -.4,0,.4, .4,0,-.4, 0,1,0];
const details=[9,0,0,0,9,0,0,0,9,0,0,0,8,0,0,0,8,0,0,0,8,0,0,0];
const data={positions,details,uvs:[0,0,1,0,.5,1,0,0,1,0,.5,1],normals:Array(6).fill([0,0,1]).flat(),indices:[0,1,2,3,4,5]};
const style={modelKey:'tower_fire',color:'#f80',scaleX:1,scaleY:1};
const a=canvasContext(),am=canvasContext(),b=canvasContext(),bm=canvasContext();
renderer.bakeColumnModel(a,am,data,style,0,null,0);
renderer.bakeColumnModel(b,bm,{...data,indices:[3,4,5,0,1,2]},style,0,null,0);
assert.deepEqual(a.image,b.image,'intersecting surfaces are independent of painter order');
const left=(32*64+24)*4,right=(32*64+40)*4;
assert.ok(a.image[left+1]>.5*a.image[left],'gold face wins on the left');
assert.ok(a.image[right]>2*a.image[right+1],'red face wins on the right');
assert.equal(a.image[left+3],255);
console.log('PASS: distant model intersections use per-pixel depth, independent of triangle order.');
