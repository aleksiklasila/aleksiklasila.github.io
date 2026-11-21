'use strict';
// occ.rs occ_find (a spawn's footprint place: the free place nearest by rings of cells) by its whole-window search
// equals the place-by-place search, on random bitmaps of every density, radii 1..32, near the map's edges and
// corners, off-cell positions, both planes, search 1..32.
//   node tests/occ-find-window.test.cjs
const assert = require('node:assert/strict'), H = require('./net-harness.cjs');
const world = new H.World({ controls: { ...H.SMALL_MATCH_CONTROLS, 'cfg-mapsize': '80' } });
const i = world.spawn('occ-find-window', { simWorker: false });
i.eval(`SIM_OCCUPANCY_ENABLED=true;startingResourcesConfig=normalizeStartingResourcesConfig({spawnCounts:{},researchLevels:{}});applyMainMenuControlsToRuntimeState();startSoloGame();occupancyEnsure();`);
const r = JSON.parse(i.eval(`JSON.stringify((()=>{
 const O=_occ,C=O.cell,M=SIM_OCCUPANCY_MARGIN_ROWS,plane=O.stride*(O.h+2*M);
 const out=simHeapArray(Int32Array,2),A=_occupancyAddresses();
 let seed=12345;const rnd=n=>{seed=Math.imul(seed,1664525)+1013904223|0;return Math.floor((seed>>>0)/4294967296*n);};
 let cases=0,found=0,none=0,bad=[];
 for(let round=0;round<60;round++){
  // (Random cells in the map, by density; the margins kept.)
  const dens=[0,0.02,0.1,0.3,0.6,0.85,0.97][round%7];
  for(let l=0;l<O.planes;l++)for(let y=0;y<O.h;y++)for(let x=0;x<O.w;x++){
   const p=l*plane+(M+y)*O.stride+(x>>5),b=1<<(x&31);
   if((seed=Math.imul(seed,1664525)+1013904223|0)>>>0<dens*4294967296)O.bits[p]|=b;else O.bits[p]&=~b;
  }
  for(let k=0;k<120;k++){
   const edge=k%4===0;
   const cx=edge?[0,1,2,O.w-1,O.w-2,O.w-3][rnd(6)]:rnd(O.w),cy=edge?[0,1,O.h-1,O.h-2,rnd(O.h)][rnd(5)]:rnd(O.h);
   const x=cx*C+rnd(C),y=cy*C+rnd(C),rad=[1,1,2,2,3,4,6,10,11,16,32][rnd(11)],layer=rnd(O.planes),search=[32,32,32,1,5,17][rnd(6)];
   _simWasmX.occ_find_cmp(A[0],A[1],O.w,O.h,O.stride,C,O.planes,x,y,rad,layer,search,_simWEnc(out.byteOffset));
   cases++;if(out[0]<0)none++;else found++;
   if(out[0]!==out[1]&&bad.length<10)bad.push({x,y,rad,layer,search,dens,win:out[0],rings:out[1]});
  }
 }
 return {cases,found,none,bad};
})())`));
console.log(JSON.stringify(r));
assert.deepEqual(r.bad, []);
assert.ok(r.found > 1000 && r.none > 300, 'both outcomes covered');
console.log('PASS occ_find window search equals the place-by-place search (' + r.cases + ' cases)');
