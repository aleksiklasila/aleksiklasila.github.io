'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const events=[];
const gl=new Proxy({}, {get(_,name){
    if(/^[A-Z_0-9]+$/.test(name))return name;
    return (...args)=>{
        events.push({name,args});
        if(name==='getParameter')return 4;
        if(name==='getError')return 0;
        if(name==='readPixels')args.at(-1).fill(255);
        if(name.startsWith('create'))return {};
    };
}});
const renderer={createFigureProgram(){this.figureProgram={};this.figureUniforms={};}};
const D={columnFlying:()=>false,columnRig:()=>0,columnView:()=>[0,.65]};
const worker=fs.readFileSync(path.join(__dirname,'../src/audio_visual/renderer3d-lod-worker.js'),'utf8');
const Baker=vm.runInNewContext(worker.slice(worker.indexOf('class GpuSnapshots'),worker.indexOf('\nlet gpu;'))+'\nGpuSnapshots;',{
    renderer,Defence3Renderer3D:D,OffscreenCanvas:class{getContext(){return gl;}}
});
const baker=new Baker(),style={scaleX:1,scaleY:1,unit:true,color:'#ff8800',ownerColor:'#4488ff'};
const data={positions:new Float32Array([-.5,0,0,.5,0,0,0,1,0]),normals:new Float32Array([0,0,1,0,0,1,0,0,1]),
    uvs:new Float32Array(6),details:new Float32Array(12),indices:new Uint32Array([0,1,2])};
const panel={width:96,height:96};
baker.prepare(data,style,panel);
assert.ok(events.some(e=>e.name==='vertexAttrib3f'&&e.args[0]===7&&e.args.slice(1).every((v,i)=>v===[68/255,136/255,1][i])),'team color goes into the shared model shader');
assert.equal(events.filter(e=>e.name==='texImage2D').length,1,'only the final colored panel is uploaded');
const images=baker.bakeBatch(81,null,style);
assert.equal(events.filter(e=>e.name==='readPixels').length,1,'one final-color capture replaces white and black renders');
assert.equal(events.filter(e=>e.name==='drawElements').length,80*6);
assert.equal(images.length,80);
for(const image of images)for(const level of image.levels){
    assert.equal(level.mask,undefined);
    assert.deepEqual([...level.color.slice(0,4)],[255,255,255,255]);
}
console.log('PASS: shared GPU shader bakes the requested team color in one pass without ownership masks.');
