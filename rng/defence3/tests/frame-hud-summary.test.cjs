'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const src=fs.readFileSync(path.join(__dirname,'../src/audio_visual/hud.js'),'utf8');
const c=vm.createContext({_pageFrameStrings:['','norm','builder','IDLE','WORK','tower','house'],CMD_IDLE:0,_prettyUnitTypeLabel:x=>x,getBuildingDisplayName:x=>x,grid:[[]],_tileEntityVersion:1});
vm.runInContext(src.slice(src.indexOf('let _frameUnitSummaries'),src.indexOf('function _getInfoPanelBuildingTypeKey')),c);
const n=10000,F={n,count:n,order:Int32Array.from({length:n},(_,i)=>i)};
for(const k of ['owner','energy','flags','type','wtype','wstate','cmd'])F[k]=new Int32Array(n);
const expected=new Map();
for(let i=0;i<n;i++){
    F.owner[i]=i%3;F.energy[i]=i%17?100:0;F.type[i]=i%2+1;F.flags[i]=i%13?0:8;F.wtype[i]=i%2;F.wstate[i]=i%7?4:3;F.cmd[i]=i%5?1:0;
    if(F.owner[i]!==1||F.energy[i]<=0)continue;
    const key=c._pageFrameStrings[F.type[i]],a=expected.get(key)||{total:0,idle:0};a.total++;
    if(F.flags[i]&8||(F.wtype[i]?c._pageFrameStrings[F.wstate[i]]==='IDLE':F.cmd[i]===0))a.idle++;
    expected.set(key,a);
}
c.simClientCurrentUnitVis=()=>F;const groups=c.getFrameUnitSummary(1);
for(const [key,a] of expected){assert.equal(groups.get(key).total,a.total);assert.equal(groups.get(key).idle,a.idle);}
const B={n:8};for(const k of ['kind','alive','owner','energy','flags','gx','gy','type','utype','qlen'])B[k]=new Int32Array(8);
B.alive.fill(1);B.energy.fill(100);B.type.fill(5);B.kind.set([0,1,2,3,4,0,0,0]);B.utype[1]=1;
B.energy[5]=0;B.flags[5]=1;B.flags[6]=2;B.qlen[7]=2;
c._pageTables={s:B};c._pageStructViews=Array.from({length:8},()=>({}));
c.grid[0][0]={owner:0,item:c._pageStructViews[3]};
let summary=c.getFrameBuildingSummary(0);
assert.equal(summary.total,7);assert.equal(summary.idle,4);assert.equal(summary.stats.get('barrack_norm').total,1);
assert.equal(c.getFrameBuildingSummary(0),summary,'frame shares counts between HUD and bottom bar');
c.grid[0][0].owner=1;c._tileEntityVersion++;
summary=c.getFrameBuildingSummary(0);assert.equal(summary.total,6,'floor ownership changes invalidate counts');
console.log('PASS: packed HUD counts match owner, death, worker activity, hold, construction, queues and floor ownership.');
