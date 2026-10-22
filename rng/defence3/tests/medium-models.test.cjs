'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const read=f=>fs.readFileSync(path.join(__dirname,'..',f),'utf8');
const c=vm.createContext({window:{},console,AREA_UNIT_TILE_EQUIVALENT:5});
vm.runInContext(read('src/audio_visual/renderer3d.js').replace('window.figureLodLevel = figureLodLevel','window.figureLodLevel = figureLodLevel; window.figureData = createFigureData'),c);
for(const kind of ['figure:sword','worker:hammer','mage:fire_staff','mage:water_staff','mage:ice_staff','mage:poison_staff','mage:laser_staff','tower','tower:fire','tower:sniper','tower:watch','tower:elements','portal','item:house','item','barrack:castle','barrack:arcane','workshop:builder_spawner','workshop:research']) {
    const full=c.window.figureData(kind,0);
    const height=data=>Math.max(...Array.from(data.positions).filter((_,i)=>i%3===1));
    for(const level of [1,2]) {
        const reduced=c.window.figureData(kind,level);
        assert.equal(height(reduced),height(full),`${kind} keeps its skyline at level ${level}`);
        for(const surface of [1,3,7,12,14]) {
            const vertices=data=>{let count=0;for(let i=0;i<data.details.length;i+=4)if(data.details[i]===surface)count++;return count;};
            // Cylindrical openings retain their surface with fewer segments.
            assert.ok(vertices(reduced)>=vertices(full)*.60,`${kind} retains eyes/dark openings at level ${level}`);
        }
    }
    if(kind.startsWith('mage:')) {
        for(let i=0;i<full.positions.length/3;i++)if(full.details[i*4+1]===-1&&full.positions[i*3+1]>1) {
            assert.equal(full.details[i*4],5,'only the plain wooden shaft remains above the staff hand');
        }
    }
}
const R=Object.create(c.window.Defence3Renderer3D.prototype),draws=[];
R.gl={};R.getFigureMesh=()=>({});R.getFlatAtlas=()=>({layerFor:()=>0});
R.drawTexturedInstanceRange=d=>draws.push(d);
c.window.Defence3Renderer3D.PersistentInstances.prototype.upload=function(){return {};};
c._detailViewKey=()=>String(c.view||0);c._detailScore=()=>10;c._detailPick=(scores)=>Array.from(scores,(_,i)=>i).filter(i=>scores[i]>0);
c._structureDetailCandidates=()=>[];
vm.runInContext(read('src/audio_visual/renderer.js').match(/function _cmBaseHeight[\s\S]*?\r?\n}\r?\n/)[0],c);
const n=7,F={n,cap:n};
for(const key of ['x','y','px','py','r','id','energy','flags','type','owner','facing','mode','vision','prate','amount','phase'])F[key]=new Float32Array(n);
F.x.fill(16000);F.y.fill(16000);F.px.fill(15996);F.py.fill(16000);F.r.fill(8);F.energy.fill(100);F.type.fill(1);F.vision.fill(3);F.amount.fill(1);
F.id.set([0,1,2,3,4,5,6]);F.energy[2]=0;F.flags[3]=65536;F.flags[4]=1024;
const lookup=new Float32Array(64);lookup[60]=1;
const A={catalog:{width:2,lookup,styles:[{modelKey:'unit_norm',weaponType:'sword',scaleX:1,scaleY:1.45,bakeHeight:3,color:'#fff'}]},panels:[{}]};
const C={units:F,unitCandidates:Array.from({length:n},(_,s)=>({_s:s})),detailMask:new Uint8Array(n),detailMaskVersion:1,colors:Array(9).fill('#08f'),fullVisibility:true,tile:32,alpha:.25};
C.detailMask[0]=255;
const S=R.drawColumnModels(C,{worldWidth:1000},A);
assert.equal(S.count,3,'only unselected, live, visible units enter the middle layer');
assert.deepEqual(Array.from(S.masks[1]),[255,255,0,0,0,255,255]);
const record=draws[0],data=Array.from(S.groups.values())[0].storage.data;
assert.equal(record.count,3);
assert.ok(Math.abs(data[5]-.55*1.45*3)<1e-6,'height matches the close model, including its baked sight scale');
assert.equal(data[3],-4/32,'GPU retains interpolation offset');
assert.equal(data[19],1,'middle models are opaque');
const version=S.version;R.drawColumnModels(C,{worldWidth:1000},A);assert.equal(S.version,version,'camera-only stable frames reuse instance storage');
C.detailMask[1]=255;C.detailMaskVersion++;R.drawColumnModels(C,{worldWidth:1000},A);
assert.equal(S.count,2,'promotion to full detail removes exactly one middle instance');
assert.equal(S.masks[1][1],255,'promotion never opens a hole in the far mask');
F.energy[5]=0;c.view=1;R.drawColumnModels(C,{worldWidth:1000},A);assert.equal(S.count,1,'retirement cannot retain a stale middle model');
// Workshops keep their fixed height and the actual timber sign in the middle
// pass. Losing either makes a whole row flash to short player-colored boards.
const B={n:1,cap:1};
for(const key of ['x','y','gx','gy','alive','energy','kind','type','utype','vision','flags','owner','amount','angle'])B[key]=new Float32Array(1);
B.x[0]=B.y[0]=32;B.kind[0]=2;B.alive[0]=1;B.energy[0]=100;B.vision[0]=.6;
const sign={timber:true};R.getFlatAtlas=()=>({layerFor:canvas=>canvas===sign?7:0});
c._structureDetailCandidates=()=>[0];
const lookupB=new Float32Array(32);lookupB[8]=1;
const AB={catalog:{width:1,stride:25,lookup:lookupB,styles:[{modelKey:'spawner_builder_spawner',color:'#354',scaleX:.95/.94,scaleY:.62/.94,preserveModelHeight:true,statusTextureCanvas:sign}]},panels:[{}]};
const CB={structures:B,detailMaskS:new Uint8Array(1),detailMaskVersionS:1,colors:Array(9).fill('#08f'),fullVisibility:true,tile:32,alpha:1};
const SB=R.drawColumnModels(CB,{worldWidth:100},AB),db=Array.from(SB.groups.values())[0].storage.data;
assert.ok(Math.abs(db[5]-.62)<1e-6,'workshop height does not shrink with vision');
assert.equal(db[27],7,'middle workshop displays the timber sign instead of bare owner color');
console.log('PASS: dark landmarks, opaque middle models, matching scale, disjoint masks, interpolation and buffer reuse.');
