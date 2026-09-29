'use strict';
const assert = require('node:assert/strict');
const H = require('./net-harness.cjs');
const world = new H.World({controls:H.SMALL_MATCH_CONTROLS});
const inst = world.spawn('oracle',{simWorker:false});
inst.eval('startSoloGame()');
const result = JSON.parse(inst.eval(`JSON.stringify((() => {
    const n=12000, S=_sep; _sepGrow(n);
    const input=_sepShared(S,'inputSlots',Int32Array,n);
    for(const key of ['px','py','ov','nextX','nextY']) _sepShared(S,key,Float64Array,n);
    _sepShared(S,'hit',Uint32Array,n); _sepShared(S,'fast',Uint8Array,n);
    let seed=7; const rand=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0; return seed/4294967296;};
    const samples=[];
    for(let i=0;i<n;i++) {
        const u=new Unit(i%4===0?'flying':'norm',i%2,(4+rand()*12)*TILE,(4+rand()*12)*TILE);
        input[i]=u._si; samples.push(u);
        S.px[i]=Math.round((rand()-.5)*UNIT_SEPARATION_Q*30);
        S.py[i]=Math.round((rand()-.5)*UNIT_SEPARATION_Q*30);
        S.ov[i]=rand()*32; S.hit[i]=1+(i%100);
        if(i%11===0) S.px[i]=S.py[i]=0;
    }
    _simParams[0]=n; _simParams[1]=512; _simParams[2]=TILE; _simParams[3]=UNIT_POSITION_QUANTIZATION;
    _simParams[4]=UNIT_SEPARATION_CONTACTS; _simParams[5]=UNIT_SEPARATION_Q;
    simParallelRun(SIM_KERNEL_SEPARATION_FINISH,Math.ceil(n/512));
    let accepted=0, different=0, rejected=n;
    for(let i=0;i<n;i++) {
        const u=samples[i], gx=Math.floor(u.x/TILE), gy=Math.floor(u.y/TILE);
        if(!S.fast[i] || (!u.isFlying && grid[gy][gx].type===TYPE_WALL)) continue;
        accepted++; rejected--;
        const k=S.hit[i], scale=k<=UNIT_SEPARATION_CONTACTS?1:Math.sqrt(UNIT_SEPARATION_CONTACTS/k);
        const dx=S.px[i]*scale/UNIT_SEPARATION_Q, dy=S.py[i]*scale/UNIT_SEPARATION_Q;
        if(dx!==0||dy!==0) applyUnitSeparation(u,dx,dy,S.ov[i]);
        pushUnitOutOfBlockedTile(u);
        u.x=_quantizeUnitWorldCoord(u.x); u.y=_quantizeUnitWorldCoord(u.y);
        if(u.x!==S.nextX[i]||u.y!==S.nextY[i]) different++;
    }
    return {accepted,rejected,different};
})())`));
assert.equal(result.different,0);
assert.ok(result.accepted>5000);
assert.ok(result.rejected>100);
assert.deepEqual(inst.errors.map(String),[]);
console.log('PASS: parallel collision correction agrees exactly with swept scalar collision/quantization:',result);
