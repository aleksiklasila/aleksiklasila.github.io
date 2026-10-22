'use strict';
const assert=require('node:assert/strict'),H=require('./net-harness.cjs');
const world=new H.World({controls:{...H.SMALL_MATCH_CONTROLS,'cfg-mapsize':'80'}});
const i=world.spawn('occupancy-shapes',{simWorker:false,url:'http://localhost/rng/defence3/'+(process.argv.includes('--wasm32')?'?wasm64=0':'')});
i.eval(`SIM_OCCUPANCY_ENABLED=true;startingResourcesConfig=normalizeStartingResourcesConfig({spawnCounts:{},researchLevels:{}});applyMainMenuControlsToRuntimeState();startSoloGame();occupancyEnsure();`);
if(process.argv.includes('--wasm32'))assert.equal(i.eval('SIM_WASM64'),false,'exercise the WASM32 build');
const result=i.eval(`(()=>{
 const O=_occ,A=_occupancyAddresses(),C=O.cell,fold=(x,y)=>y*O.w+x;
 // Larger jobs here permit long sweeps that test rotation/swizzle wrap.
 // Production keeps its smaller checkerboard jobs and halo limit.
 O.config[7]=64;
 const disk=(x,y,r)=>{const a=[];for(let dy=1-r;dy<r;dy++)for(let dx=1-r;dx<r;dx++)if(dx*dx+dy*dy<r*r)a.push([x+dx,y+dy]);return a;};
 const spawn=(s,x,y,r,px=0,py=0)=>_simWasmX.occ_spawn(...A,O.w,O.h,O.stride,C,O.planes,s,x*C+px,y*C+py,r,0,0);
 const verify=(expected,label)=>{
  let n=0;for(let y=0;y<O.h;y++)for(let w=0;w<O.stride;w++){
   let bits=O.bits[y*O.stride+w]>>>0;while(bits){const bit=31-Math.clz32(bits&-bits),x=w*32+bit;
    if(!expected.has(fold(x,y)))throw Error(label+': unexpected bit '+x+','+y);n++;bits=(bits&(bits-1))>>>0;}
  }
  if(n!==expected.size)throw Error(label+': missing bits '+n+' / '+expected.size);
 };
 // (The kernel's swept move itself: occupancyMovePosition sends a move beyond a step's reach (24 tiles) as a jump, which ignores obstacles.)
 const moveOne=(s,x,y)=>{for(let i=0;i<_occNames.length;i++)_simWasmArgI[512+i]=_simWEnc(_simParReg[_occNames[i]].byteOffset);
  _simWasmArgI[512+28]=_simWEnc(O.stats.byteOffset);_simWasmArgI[512+33]=_simWEnc(O.config.byteOffset);
  const pos=_simWasmX.occ_move_one(_simWasmArgsW,s,x,y),c=_simUnitState.columns;c.x[s]=Number(BigInt.asIntN(32,pos));c.y[s]=Number(BigInt.asIntN(32,pos>>32n));};
 let cases=0;
 for(let r=1;r<=10;r++)for(const cx of [r-1,30,31,32,33,63,64,O.w-r])for(const [dx,dy]of [[1,0],[-1,0],[1,1],[-2,3],[8,-5],[80,0],[-80,0],[0,300]])for(const phase of [[0,0,0,0],[C-1,0,-3,0],[C>>1,C-1,7,-2],[C-1,C>>1,-5,3]]){
  O.bits.fill(0);O.active.fill(0);const cy=32;
  if(!spawn(0,cx,cy,r,phase[0],phase[1]))throw Error('legal spawn rejected r='+r);
  const own=new Set(disk(cx,cy,r).map(([x,y])=>fold(x,y))),obstacle=new Set();
  const bx=dy>100?cx:cx+(dx>32?64:dx< -32?-64:r+3),by=dy>100?cy+256:cy+1;
  if(bx>=2 && bx+3<O.w && spawn(1,bx,by,3))for(const [x,y]of disk(bx,by,3))obstacle.add(fold(x,y));
  const free=(x,y)=>disk(Math.trunc(x/C),Math.trunc(y/C),r).every(([a,b])=>a>=0&&b>=0&&a<O.w&&b<O.h&&(!obstacle.has(fold(a,b)))) && x>=0&&y>=0;
  const ox=cx*C+phase[0],oy=cy*C+phase[1],nx=ox+dx*C+phase[2],ny=oy+dy*C+phase[3];
  const sweep=(nx,ny)=>{let x=ox,y=oy;const n=Math.max(1,Math.ceil(Math.max(Math.abs(nx-ox),Math.abs(ny-oy))/C));
   for(let k=1;k<=n;k++){const tx=ox+Math.trunc((nx-ox)*k/n),ty=oy+Math.trunc((ny-oy)*k/n);if(!free(tx,ty))break;x=tx;y=ty;}return [x,y];};
  let [x,y]=sweep(nx,ny);if(x===ox&&y===oy){[x,y]=sweep(nx,oy);if(x===ox&&y===oy)[x,y]=sweep(ox,ny);}
  moveOne(0,nx,ny);
  if(O.x[0]!==x||O.y[0]!==y)throw Error('movement mismatch r='+r+' cx='+cx+' delta='+dx+','+dy+' actual='+O.x[0]+','+O.y[0]+' expected='+x+','+y);
  const expected=new Set(obstacle);for(const [a,b]of disk(Math.trunc(x/C),Math.trunc(y/C),r))expected.add(fold(a,b));
  verify(expected,'r='+r+' cx='+cx);
  _simWasmX.occ_release(...A,O.w,O.h,O.stride,C,O.planes,0);verify(obstacle,'release');cases++;
 }
 return cases;
})()`);
assert.equal(result,2560);assert.deepEqual(i.errors.map(String),[]);
console.log('PASS: '+result+' specialized-radius, word-seam, map-edge, swept move, own-mask and release cases.');
