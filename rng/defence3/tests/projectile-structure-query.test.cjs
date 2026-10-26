'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
class Tower{}class Barrack{}class Spawner{}
const W=128,H=96,lists=[[],[],[]];let reads=0,seed=712;
const rnd=()=>{seed=Math.imul(seed,1664525)+1013904223|0;return(seed>>>0)/4294967296;};
const raw=Array.from({length:H},()=>[]),refs=raw.map(row=>new Proxy(row,{get(a,k){if(/^\d+$/.test(String(k)))reads++;return a[k];}}));
for(let i=0;i<5000;i++){
 const gx=Math.floor(rnd()*W),gy=Math.floor(rnd()*H);if(raw[gy][gx])continue;
 const kind=i%3,b=Object.assign(new [Tower,Barrack,Spawner][kind],{gx,gy,x:gx*32+16,y:gy*32+16,owner:i%2,energy:i%11?100:0});
 raw[gy][gx]=b;lists[kind].push(b);
}
const c=vm.createContext({Tower,Barrack,TILE:32,GRID_W:W,GRID_H:H,tileEntityRef:refs,towers:lists[0],barracks:lists[1],collectorSpawners:lists[2],isSpawnerEntity:b=>b instanceof Spawner,detHypot:(x,y)=>Math.sqrt(x*x+y*y),simDk:1});
vm.runInContext(fs.readFileSync(path.join(__dirname,'../src/things/projectile.js'),'utf8'),c);
const reference=p=>{
 let best=null,rank=Infinity;
 for(let kind=0;kind<3;kind++)for(const b of lists[kind]){
  if(b.owner===p.sourceOwner||b.energy<=0)continue;
  const r=kind*W*H+b.gy*W+b.gx;
  if(r<rank&&Math.sqrt((b.x-p.x)**2+(b.y-p.y)**2)<=18){best=b;rank=r;}
 }
 return best;
};
c.projectilesBegin();let maxReads=0;
for(let i=0;i<6000;i++){
 let p={x:rnd()*W*32,y:rnd()*H*32,sourceOwner:i%2};
 if(i<1000){const b=lists[i%3][i%lists[i%3].length];p={x:b.x+[0,18,-18,18+1e-10,-18-1e-10][i%5],y:b.y,sourceOwner:1-b.owner};}
 reads=0;assert.equal(c._projectileBuildingHit(p),reference(p));maxReads=Math.max(maxReads,reads);
}
assert.ok(maxReads<=9,'at most nine tile references per projectile');
// Outside the projectile phase the exhaustive path remains available.
c.projectilesEnd();
for(let i=0;i<50;i++){const p={x:rnd()*W*32,y:rnd()*H*32,sourceOwner:i%2};assert.equal(c._projectileBuildingHit(p),reference(p));}
console.log('PASS: projectile structure hits match exhaustive kind/tile priority over 6050 dense/boundary queries; max tile reads '+maxReads);
