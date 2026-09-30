'use strict';
const assert = require('node:assert/strict');
const H = require('./net-harness.cjs');
const world = new H.World({controls:H.SMALL_MATCH_CONTROLS});
const inst = world.spawn('oracle',{simWorker:false});
inst.eval('startSoloGame()');
const result = JSON.parse(inst.eval(`JSON.stringify((() => {
    // Inputs and outputs are addressed by unit state slot.
    const n=12000, S=_sep;
    let seed=7; const rand=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0; return seed/4294967296;};
    const samples=[];
    for(let i=0;i<n;i++) samples.push(new Unit(i%4===0?'flying':'norm',i%2,(4+rand()*12)*TILE,(4+rand()*12)*TILE));
    const slots=_simUnitState.owners.length; _sepGrow(slots);
    for(const key of ['px','py','ov','nextX','nextY']) _sepShared(S,key,Float64Array,slots);
    _sepShared(S,'hit',Uint32Array,slots); _sepShared(S,'fast',Uint8Array,slots);
    S.hit.fill(0,0,slots);
    for(let i=0;i<n;i++) {
        const s=samples[i]._si;
        S.px[s]=Math.round((rand()-.5)*UNIT_SEPARATION_Q*30);
        S.py[s]=Math.round((rand()-.5)*UNIT_SEPARATION_Q*30);
        S.ov[s]=rand()*32; S.hit[s]=1+(i%100);
        if(i%11===0) S.px[s]=S.py[s]=0;
    }
    _simParams[0]=slots; _simParams[1]=512; _simParams[2]=TILE; _simParams[3]=UNIT_POSITION_QUANTIZATION;
    _simParams[4]=UNIT_SEPARATION_CONTACTS; _simParams[5]=UNIT_SEPARATION_Q;
    simParallelRun(SIM_KERNEL_SEPARATION_FINISH,Math.ceil(slots/512));
    let accepted=0, different=0, rejected=n;
    for(let i=0;i<n;i++) {
        const u=samples[i], s=u._si, gx=Math.floor(u.x/TILE), gy=Math.floor(u.y/TILE);
        if(!S.fast[s] || (!u.isFlying && grid[gy][gx].type===TYPE_WALL)) continue;
        accepted++; rejected--;
        const k=S.hit[s], scale=k<=UNIT_SEPARATION_CONTACTS?1:Math.sqrt(UNIT_SEPARATION_CONTACTS/k);
        const dx=S.px[s]*scale/UNIT_SEPARATION_Q, dy=S.py[s]*scale/UNIT_SEPARATION_Q;
        if(dx!==0||dy!==0) applyUnitSeparation(u,dx,dy,S.ov[s]);
        pushUnitOutOfBlockedTile(u);
        u.x=_quantizeUnitWorldCoord(u.x); u.y=_quantizeUnitWorldCoord(u.y);
        if(u.x!==S.nextX[s]||u.y!==S.nextY[s]) different++;
    }
    return {accepted,rejected,different};
})())`));
assert.equal(result.different,0);
assert.ok(result.accepted>5000);
assert.ok(result.rejected>100);
assert.deepEqual(inst.errors.map(String),[]);
console.log('PASS: parallel collision correction agrees exactly with swept scalar collision/quantization:',result);
