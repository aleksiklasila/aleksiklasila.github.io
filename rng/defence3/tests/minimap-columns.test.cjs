'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname,'../src/audio_visual/renderer.js'),'utf8');
const c = vm.createContext({});
vm.runInContext(source.slice(source.indexOf('function paintMinimapUnitColumns('),source.indexOf('function drawMinimap()')),c);
const n=10000,F={count:n,order:Uint32Array.from({length:n},(_,i)=>n-i-1)};
for(const field of ['x','y','energy','owner']) F[field]=new Float32Array(n);
let seed=37;
const random=()=>((seed=Math.imul(seed,1664525)+1013904223|0)>>>0)/4294967296;
for(let i=0;i<n;i++) {F.x[i]=(random()*110-5)*32;F.y[i]=(random()*110-5)*32;F.owner[i]=i%9-1;F.energy[i]=i%11?1:0;}
const palette=Uint8Array.from({length:36},(_,i)=>i%4===3?255:(i*73)%256);
const vis=Array.from({length:100},()=>Uint8Array.from({length:100},()=>random()>.4?1:0));
for(const full of [false,true]) for(const size of [16,160]) {
    const scale=size/100, expected=new Uint8Array(size*size*4),actual=new Uint8Array(expected.length);
    for(const s of F.order) {
        if(F.energy[s]<=0)continue;
        const ux=F.x[s],uy=F.y[s];
        if(!full && !vis[Math.floor(uy/32)]?.[Math.floor(ux/32)])continue;
        const x=Math.floor(ux/32*scale),y=Math.floor(uy/32*scale);
        if(x<0||y<0||x>=size||y>=size)continue;
        expected.set(palette.subarray((F.owner[s]+1)*4,(F.owner[s]+2)*4),(y*size+x)*4);
    }
    c.paintMinimapUnitColumns(F,new Uint32Array(actual.buffer),size,32,scale,full,vis,new Uint32Array(palette.buffer));
    assert.deepEqual(actual,expected,'packed pixels preserve visibility, owner colours, overlap order, death and clipping');
}
console.log('PASS: packed minimap matches reference pixels in full/team visibility at both scales.');
