'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../src/audio_visual/renderer3d.js'),'utf8');
const method=source.slice(source.indexOf('        drawUnitClaims('),source.indexOf('        disposeFrameColumns()'));
const policy={claimCellPx:2,claimMinUnits:1,claimMaxPx:8,claimSum:false};
const Claims=vm.runInNewContext('(class Claims {'+method+'})',{Defence3Renderer3D:policy});
for(const float of [false,true]) {
    const scene={},drawTargets=[];
    let attachments=0;
    const state={_fb:scene,_viewport:[0,0,100,80],_clear:[.1,.2,.3,1],_depthMask:true,_blend:[1,0,1,0],
        getExtension:()=>float?{}:null,createTexture:()=>({}),createFramebuffer:()=>({}),isEnabled:()=>false,
        bindFramebuffer:(_target,fb)=>{state._fb=fb;},
        viewport:(...v)=>{state._viewport=v;},framebufferTexture2D:()=>attachments++,
        drawArrays:()=>drawTargets.push(state._fb)};
    // Ignore unrelated uniforms and blend commands; observe the framebuffer
    // contract at allocation, ordinary reuse, and a viewport resize.
    const gl=new Proxy(state,{get:(s,key)=>key in s?s[key]:/^[A-Z_0-9]+$/.test(key)?key:()=>{}});
    const r=new Claims();Object.assign(r,{gl,ensureClaimProgram:()=>true,columnPixelScale:()=>1,
        columnProgram:{},columnVisibilityTexture:{},claimUniforms:{},sceneTargetSize:{height:80},cssHeight:80});
    const C={tile:32,alpha:1,lightNorm:1,fullVisibility:true},snapshot={camera:{visibleWidth:100},viewportWidth:100};
    for(const [w,h] of [[100,80],[100,80],[120,90]]) {
        gl.viewport(0,0,w,h);
        const start=drawTargets.length;
        const claim=r.drawUnitClaims(C,snapshot,{n:10});
        assert.equal(state._fb,scene,'sprite pass resumes on the scene framebuffer');
        assert.deepEqual(state._viewport,[0,0,w,h],'scene viewport restored');
        assert.equal(claim.w,w/2);assert.equal(claim.h,h/2);
        assert.equal(drawTargets.length-start,float?2:1);
        assert.ok(drawTargets.slice(start).every(fb=>fb===claim.fb),'claim draws use their own target');
    }
    assert.equal(attachments,4,'allocate initially and on resize, reuse otherwise');
}
console.log('PASS claim framebuffer restored on first use, reuse and resize (R8 and floating sum)');
