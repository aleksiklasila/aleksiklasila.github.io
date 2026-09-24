const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const read = p => fs.readFileSync(path.join(__dirname,'..',p),'utf8');
const c = vm.createContext({window:{},console});
vm.runInContext(read('src/audio_visual/renderer3d.js'),c);
const r = Object.create(c.window.Defence3Renderer3D.prototype);
r.tmpViewProjection = new Float32Array(16);
r.tmpInverseViewProjection = new Float32Array(16);
r.cssWidth=1200;r.cssHeight=800;
const snapshot={flat2d:true,viewportWidth:1200,viewportHeight:800,
    camera:{centerX:30,centerZ:20,visibleWidth:60,visibleHeight:40}};
r.buildViewProjection(snapshot);
for(const [x,z,sx,sy] of [[0,0,0,0],[60,40,1200,800],[30,20,600,400],[10,5,200,100]]) {
    const p=r.projectWorldToScreen(x,0,z);
    assert.ok(Math.abs(p.x-sx)<.001 && Math.abs(p.y-sy)<.001,'projection agrees with 2D input coordinates');
}
const calls=[];
r.gl=new Proxy({}, {get(_,name){
    if(/^[A-Z_0-9]+$/.test(name))return name;
    return (...args)=>{calls.push([name,...args]);
        if(name==='getShaderParameter'||name==='getProgramParameter')return true;
        return {};
    };
}});
r.topTextureCache=new Map();r.textureFrame=1;
const texture={width:128,height:128,_textureVersion:1,_flatWorldSize:1.5,_flatOffsetZ:-.25};
const object={modelKey:'unit_norm',x:10,z:8,scaleX:.5,scaleZ:.5,alpha:1,lightLevel:.8,
    topTextureKey:'2d:unit',topTextureCanvas:texture};
r.drawFlatSprites(Array.from({length:1500},()=>({...object})));
assert.equal(calls.filter(c=>c[0]==='drawArraysInstanced').length,1,'1500 shared sprites in one GPU draw');
assert.equal(calls.find(c=>c[0]==='drawArraysInstanced')[4],1500);
assert.deepEqual(Array.from(r.flatData.slice(0,4)),[10,7.75,1.5,1.5],'capture footprint and label offset survive');
assert.equal(calls.filter(c=>c[0]==='texImage2D').length,1);
const buffer=r.flatData;
r.textureFrame++;
r.drawFlatSprites([object]);
assert.equal(r.flatData,buffer,'instance allocation reused');
assert.equal(calls.filter(c=>c[0]==='texImage2D').length,1,'stable texture never reuploaded');
texture._textureVersion++;
r.drawFlatSprites([object]);
assert.equal(calls.filter(c=>c[0]==='texSubImage2D').length,1,'changed pixels uploaded');
const alternate={...object,topTextureKey:'2d:other',topTextureCanvas:{...texture}};
calls.length=0;
r.drawFlatSprites([object,alternate,object]);
assert.equal(calls.filter(c=>c[0]==='drawArraysInstanced').length,3,'overlapping transparency retains painter order');
assert.equal(calls.filter(c=>c[0]==='readPixels'||c[0]==='drawImage').length,0);

r.enabled=r.supported=true;r.overlayDepthCache=new Map();
for(const method of ['resize','drawBackground','drawGroundOverlays','resolveScene','presentSceneToCanvas'])r[method]=()=>calls.push([method]);
for(const method of ['requestModel','drawShadows','drawTexturedCubeInstances'])r[method]=()=>{throw Error('2D must never draw models/shadows');};
calls.length=0;
r.render({...snapshot,objects:[object],overlays:{}});
assert.ok(calls.some(c=>c[0]==='drawBackground'));
assert.ok(calls.some(c=>c[0]==='presentSceneToCanvas'));
assert.equal(calls.filter(c=>c[0]==='readPixels'||c[0]==='drawImage').length,0,'frame stays on GPU');

const source=read('src/audio_visual/renderer.js');
const begin=source.indexOf('function processRenderFrame('),end=source.indexOf('\nfunction ',begin+1);
let worldDraws=0,mode='2d',received;
const pipeline=vm.createContext({ctx:{setTransform(){}},canvas:{},bgCtx:{},minimapCtx:{},window:{devicePixelRatio:1},
    renderDimensionMode:mode,_tickAccumulator:0,TICK_MS:50,tickAlpha:0,
    _fpsFrameCount:0,_fpsLastTime:0,_buildMenuRefreshCounter:0,_minimapRefreshCounter:0,_backgroundCacheRefreshCounter:0,
    updateVisibilityHistory(){},updateCamera(){},ensure3DRendererInitialized:()=>({render(s){received=s;}}),
    build3DFrameData:flat2d=>({flat2d}),draw(){worldDraws++;},drawMinimap(){},drawInteractionOverlay(){},
    flushTickUiRequests(){},updateHUD(){},updateControlGroupBar(){}});
vm.runInContext(source.slice(begin,end),pipeline);
pipeline.processRenderFrame(0);
assert.equal(received.flat2d,true);assert.equal(worldDraws,0,'2D bypasses Canvas world drawing');
pipeline.renderDimensionMode='3d';pipeline.processRenderFrame(1);
assert.equal(received.flat2d,false,'3D retains models');
pipeline.ensure3DRendererInitialized=()=>null;pipeline.processRenderFrame(2);
assert.equal(worldDraws,1,'unsupported WebGL retains fallback');
console.log('PASS: flat projection/input mapping; 1500 sprites in one GPU draw; texture reuse, painter order, direct GPU presentation and Canvas fallback.');
