'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
let clock=0;
const jobs=[], uploads=[], state={};let fullMipRebuilds=0;
const gl=new Proxy({}, {get(_,name) {
    if(/^[A-Z_0-9]+$/.test(name))return name;
    return (...args)=>{
        if(name==='pixelStorei')state[args[0]]=args[1];
        if(name==='texImage2D'||name==='texSubImage2D'||name==='texSubImage3D'||name==='texStorage3D'||name==='copyTexSubImage3D')uploads.push({name,args,state:{...state}});
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
R.bakeColumnModel=(g,data,style,yaw,panel,pitch)=>{jobs.push([style.modelKey,yaw,pitch]);return [1,0,0,1];};
// Simulate texture state left by another pass.
state.UNPACK_FLIP_Y_WEBGL=true;state.UNPACK_PREMULTIPLY_ALPHA_WEBGL=true;
const A=R.prepareColumnAtlas();
assert.equal(A.next,1,'cold preparation is bounded to one job when the time budget expires');
R.prepareColumnAtlas();assert.equal(A.next,1,'render-time atlas reads never advance preparation');
R.advanceColumnAtlas(A);assert.deepEqual(jobs,['gold','gold','astar','astar'],'flat and native model panels precede directional bakes');
for(const panel of A.sources) {assert.equal(panel.width,96);assert.equal(panel._ownerMask,undefined,'panels contain final colors without ownership masks');}
for(let i=2;i<162;i++) {assert.equal(R.prepareColumnAtlas(),A);R.advanceColumnAtlas(A);assert.equal(A.next,i+1);}
assert.equal(A.prepare,null);assert.equal(A.sources,null);
assert.equal(jobs.length,164);
assert.deepEqual([...new Set(jobs.slice(4).map(j=>Number(j[2].toFixed(2))))],[.08,.35,.65,1.05,1.57],'low, tilted, middle and high camera angles are cached');
R.prepareColumnAtlas();assert.equal(jobs.length,164,'zoom/camera reuse never rebakes the catalog');
for(const upload of uploads)if(upload.args.includes('FLOAT')) {
    assert.equal(upload.state.UNPACK_FLIP_Y_WEBGL,false,'lookup rows are never flipped');
    assert.equal(upload.state.UNPACK_PREMULTIPLY_ALPHA_WEBGL,false,'numeric style data must never be premultiplied');
}
assert.ok(uploads.some(u=>u.name==='texSubImage3D'&&u.args.includes('UNSIGNED_BYTE')&&u.state.UNPACK_PREMULTIPLY_ALPHA_WEBGL),'sprite filtering uses premultiplied colors');
assert.equal(fullMipRebuilds,0,'preparing one miniature never rebuilds both whole atlases');
assert.deepEqual([...new Set(uploads.filter(u=>u.name==='texSubImage3D'&&u.args.includes('UNSIGNED_BYTE')).map(u=>u.args[1]))],[0,1,2,3,4,5]);
// A GPU bake has already multiplied material RGB by MSAA coverage. Unlike
// canvas uploads, these bytes must survive texSubImage2D without conversion.
const R2=Object.create(c.window.Defence3Renderer3D.prototype);R2.gl=gl;
const B=R2.prepareColumnAtlas();R2.advanceColumnAtlas(B);
const levels=Array.from({length:6},(_,level)=>({size:32>>level,color:new Uint8Array((32>>level)**2*4)}));
for(const level of levels){level.color.set([100,50,25,128]);}
B.worker={};B.prepared={images:Array(80).fill({meta:[1,0,0,1],levels})};
const beforeUpload=uploads.length;R2.advanceColumnAtlas(B);
const bakedUploads=uploads.slice(beforeUpload).filter(u=>u.name==='texSubImage3D'&&u.args.includes('UNSIGNED_BYTE'));
assert.equal(bakedUploads.length,6,'only final color uploads each of six prepared mips');
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

// Colors are deduplicated, but every owner retains the correct layer mapping.
const D=c.window.Defence3Renderer3D;
const colorFor=i=>i<0?'#c8ced8':i===0?'#f00':i===1?'#FF0000':'#00f';
const palette=D.columnPalette(colorFor,[0,1,2]);
assert.deepEqual([...palette.colors],['#c8ced8','#ff0000','#0000ff']);
assert.deepEqual([...palette.layers].slice(0,4),[0,1,1,2]);
assert.notEqual(palette.key,D.columnPalette(i=>i===0?'#00f':colorFor(i),[0,1,2]).key);
// A palette change copies completed layers and bakes only new colors.
c.activeTeamIds=[0,1];c.get3DRenderOwnerColor=i=>i<0?'#c8ced8':i===0?'#f00':'#00f';
const beforeReuse=jobs.length,copyStart=uploads.length;
const changed=R.prepareColumnAtlas();
while(changed.prepare)R.advanceColumnAtlas(changed,100);
assert.equal(changed.reusedLayers.size,1);
assert.equal(jobs.length,beforeReuse,'neutral resources are baked once, regardless of team count');
assert.equal(uploads.slice(copyStart).filter(u=>u.name==='copyTexSubImage3D').length,12,'both atlas mip chains reuse the existing neutral layer');
assert.equal(changed.mask,undefined);assert.equal(changed.animation.mask,undefined);
assert.ok(uploads.some(u=>u.name==='texStorage3D'&&u.args[2]==='RGBA8'&&u.args[5]===3));
const remap={...catalog,lookup:new Float32Array(catalog.lookup)};
c.getColumnLodCatalog=()=>remap;
assert.equal(R.prepareColumnAtlas(),changed,'string remaps reuse all completed color layers');

// Owned styles actually bake every deduplicated color; neutral styles do not.
const rims=[],captures=[];
const ownedCatalog={...catalog,styles:[{...catalog.styles[0],neutral:false,drawOwnerRim(g,color){rims.push(color);}},catalog.styles[1]]};
c.getColumnLodCatalog=()=>ownedCatalog;
const R3=Object.create(D.prototype);R3.gl=gl;
R3.bakeColumnModel=(g,data,style)=>{captures.push([style.modelKey,style.ownerColor]);return [1,0,0,1];};
const ownedAtlas=R3.prepareColumnAtlas();
while(ownedAtlas.prepare)R3.advanceColumnAtlas(ownedAtlas,100);
for(const color of ownedAtlas.palette.colors)assert.equal(captures.filter(([type,c])=>type==='gold_mine_active'&&c===color).length,80);
assert.equal(captures.filter(([type])=>type==='astar_mine_active').length,80);
assert.deepEqual([...new Set(rims)],['#c8ced8','#ff0000','#0000ff']);
assert.equal(R3.prepareColumnAtlas(),ownedAtlas,'completed palette is stable across render reads');
// Changing one team color must reuse the other two completed layers.
c.get3DRenderOwnerColor=i=>i<0?'#c8ced8':i===0?'#f00':'#0f0';
const count=captures.length,newAtlas=R3.prepareColumnAtlas();
while(newAtlas.prepare)R3.advanceColumnAtlas(newAtlas,100);
assert.equal(newAtlas.reusedLayers.size,2);
assert.equal(captures.length-count,80);
assert.ok(captures.slice(count).every(([,color])=>color==='#00ff00'));
