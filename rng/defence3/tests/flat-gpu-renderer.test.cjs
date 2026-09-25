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
        if(name==='getParameter'&&args[0]==='MAX_ARRAY_TEXTURE_LAYERS')return 1024;
        return {};
    };
}});
r.topTextureCache=new Map();r.textureFrame=1;
const count=name=>calls.filter(c=>c[0]===name).length;
// 96px panels live in one texture array; each layer upload copies 7 mips.
const panel=(extra={})=>({width:96,height:96,_textureVersion:1,_flatWorldSize:1.5,_flatOffsetZ:-.25,...extra});
const texture=panel();
const object={modelKey:'unit_norm',x:10,z:8,scaleX:.5,scaleZ:.5,alpha:1,lightLevel:.8,
    topTextureKey:'2d:unit',topTextureCanvas:texture};
r.drawFlatSprites(Array.from({length:1500},()=>({...object})));
assert.equal(count('drawArraysInstanced'),1,'1500 shared sprites in one GPU draw');
assert.equal(calls.find(c=>c[0]==='drawArraysInstanced')[4],1500);
assert.equal(count('bufferSubData'),1,'instance data uploaded once per frame');
assert.deepEqual(Array.from(r.flatData.slice(0,4)),[10,7.75,1.5,1.5],'capture footprint and label offset survive');
assert.equal(count('copyTexSubImage3D'),7,'one layer (all mips) for a shared panel');
const buffer=r.flatData;
r.textureFrame++;
r.drawFlatSprites([object]);
assert.equal(r.flatData,buffer,'instance allocation reused');
assert.equal(count('copyTexSubImage3D'),7,'stable texture never reuploaded');
texture._textureVersion++;
r.drawFlatSprites([object]);
assert.equal(count('copyTexSubImage3D'),14,'changed pixels uploaded into the same layer');
assert.equal(count('texImage2D')+count('readPixels')+count('drawImage')+count('getImageData'),0,'panel uploads stay on the GPU');

// Distinct panels, interleaved with plain sprites, still share one draw.
calls.length=0;r.textureFrame++;
const mixed=[];
for(let i=0;i<200;i++) {
    mixed.push({...object,topTextureCanvas:panel(),topTextureKey:'2d:'+i});
    mixed.push({modelKey:'particle',x:i,z:1,scaleX:.06,scaleZ:.06,alpha:.5,lightLevel:1,tint:'#ff0000',topTextureCanvas:null});
}
r.drawFlatSprites(mixed);
assert.equal(count('drawArraysInstanced'),1,'200 distinct panels and 200 particles in one draw');
assert.equal(count('copyTexSubImage3D'),200*7);
assert.deepEqual(Array.from(r.flatData.slice(10,20),v=>+v.toFixed(5)+0),[0,1,.06,.06,1,0,0,.5,0,-2],'plain sprites use their tint, untextured layer');
assert.equal(r.flatData[9],r.flatAtlas.sources.indexOf(mixed[0].topTextureCanvas),'panel instance addresses its layer');

// Other textures keep painter order between runs.
const big={width:128,height:128,_textureVersion:1};
const other={...object,topTextureCanvas:big,topTextureKey:'big'};
const alternate={...object,topTextureCanvas:{...big},topTextureKey:'big2'};
calls.length=0;r.textureFrame++;
r.drawFlatSprites([other,alternate,other,object]);
assert.equal(count('drawArraysInstanced'),4,'overlapping transparency retains painter order');
calls.length=0;r.textureFrame++;
r.drawFlatSprites([other,alternate,other,object]);
assert.equal(count('texImage2D'),0,'textures outside the array are cached too');

// A full array evicts layers unused for a few frames, else grows.
const atlas=r.flatAtlas;
const before=atlas.capacity;
for(let frame=0;frame<3;frame++) {
    r.textureFrame++;
    r.drawFlatSprites(Array.from({length:before+10},(_,i)=>({...object,topTextureCanvas:panel(),topTextureKey:'grow'+frame+':'+i})));
}
assert.ok(atlas.capacity>before,'visible set larger than the array grows it');
const grownCapacity=atlas.capacity;
r.textureFrame+=5;
r.drawFlatSprites(Array.from({length:50},(_,i)=>({...object,topTextureCanvas:panel(),topTextureKey:'late'+i})));
assert.equal(atlas.capacity,grownCapacity,'stale layers are reused before growing again');

r.enabled=r.supported=true;r.overlayDepthCache=new Map();
for(const method of ['resize','drawBackground','drawGroundOverlays','resolveScene','presentSceneToCanvas'])r[method]=()=>calls.push([method]);
for(const method of ['requestModel','drawShadows','drawTexturedCubeInstances'])r[method]=()=>{throw Error('2D must never draw models/shadows');};
calls.length=0;
r.render({...snapshot,objects:[object],overlays:{}});
assert.ok(calls.some(c=>c[0]==='drawBackground'));
assert.ok(calls.some(c=>c[0]==='presentSceneToCanvas'));
assert.equal(calls.filter(c=>c[0]==='readPixels'||c[0]==='drawImage').length,0,'frame stays on GPU');

const source=read('src/audio_visual/renderer.js');
let clears=0;
const overlay=vm.createContext({overlayCanvas:{},overlayCtx:{setTransform(){},clearRect(){clears++;}},
    renderer3dInstance:{drawOverlay(){}},window:{devicePixelRatio:1},viewW:800,viewH:600,isBoxSelecting:false,selectionBoxScreen:null});
const overlayStart=source.indexOf('function drawInteractionOverlay(');
vm.runInContext(source.slice(overlayStart,source.indexOf('\nfunction ',overlayStart+1)),overlay);
for(let i=0;i<100;i++) overlay.drawInteractionOverlay({overlays:{groundLinesRendered:true,lines:[{}]}});
assert.equal(clears,1,'empty canvas overlays do not clear every frame for GPU lines');
overlay.drawInteractionOverlay({overlays:{markers:[{}]}});
overlay.drawInteractionOverlay({overlays:{}});
overlay.drawInteractionOverlay({overlays:{}});
assert.equal(clears,3,'disappearing content clears exactly once');
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
console.log('PASS: flat projection/input mapping; 1500 sprites and 400 distinct panels/particles in one GPU draw; layer reuse, GPU-only uploads, painter order, direct GPU presentation and Canvas fallback.');
