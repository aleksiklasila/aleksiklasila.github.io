'use strict';
const assert=require('node:assert/strict'),H=require('./net-harness.cjs');
globalThis.self={crossOriginIsolated:true};
for(const helpers of [0,3]){
 const world=new H.World({controls:{...H.SMALL_MATCH_CONTROLS,'cfg-mapsize':'120','cfg-map-type':'arena'}}),i=world.spawn('nav-interleave',{simWorker:false});
 if(helpers){i.scratch.Worker=require('./real-sim-helper.cjs');i.eval(`Worker=__scratch.Worker;navigator.hardwareConcurrency=16;simParallelInit('',${helpers});`);}
 i.eval('startSoloGame();');
 const result=JSON.parse(i.eval(`JSON.stringify((()=>{
  const W=GRID_W,H=GRID_H,wall=new Uint8Array(W*H),other=new Uint8Array(W*H);
  for(let y=3;y<H-3;y++)for(let x=3;x<W-3;x++){
   if(x%13===0&&y%11!==0)wall[y*W+x]=1;
   if(y%17===0&&x%9!==0)other[y*W+x]=1;
  }
  const interrupt=()=>navBuild(NAV_PROFILE_AIR,other,false,W,H);
  const b=navBuildStart(NAV_PROFILE_GROUND,wall,true,W,H);
  interrupt();navBuildNodesBackground(b);
  interrupt();navBuildCollect();navBuildNodesFinish(b);
  interrupt();navBuildLocalBackground(b);
  interrupt();navBuildCollect();navBuildGraphAlloc(b);
  interrupt();navBuildGraphBackground(b);
  interrupt();navBuildCollect();navBuildGraphFinish(b);navBuildPartsFinish(b);
  const A=navAtlasStart(b,true);
  interrupt();navBuildCollect();navAtlasTables(A,true);
  interrupt();navBuildCollect();b.atlas=navAtlasFinish(A);
  const ref=navBuild(NAV_PROFILE_GROUND,wall,true,W,H),checks={};
  for(const key of ['wall','cost','nodeBase','nodeTile','nodePair','fields','adjStart','adjA','adjC','partL','partBase','nodePart','partComp','partCluster','compStart','compParts']){
   const a=b[key],r=ref[key];checks[key]=a.length===r.length&&a.every((v,j)=>v===r[j]);
  }
  for(const key of ['bm','bc','cb','co','ct','cn','anc','cip','cin','rco','rc','dn','didx','clearPrefix']){
   const a=b.atlas[key],r=ref.atlas[key];checks['atlas.'+key]=a.length===r.length&&a.every((v,j)=>v===r[j]);
  }
  return checks;
 })())`));
 assert.ok(Object.values(result).every(Boolean),JSON.stringify({helpers,result}));
 assert.deepEqual(i.errors.map(String),[]);
 console.log('PASS:',helpers,'helpers, interleaved profiles preserve',Object.keys(result).length,'navigation/atlas arrays');
 if(helpers)i.eval('for(const w of _simPool.helpers)w.terminate()');
}
process.exit(0);
