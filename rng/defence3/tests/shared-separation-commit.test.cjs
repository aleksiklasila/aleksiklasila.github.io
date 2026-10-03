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
    // (Positions quantized, as every unit's is between ticks.)
    for(let i=0;i<n;i++) samples.push(new Unit(i%4===0?'flying':'norm',i%2,_quantizeUnitWorldCoord((4+rand()*12)*TILE),_quantizeUnitWorldCoord((4+rand()*12)*TILE)));
    const slots=_simUnitState.owners.length; _sepGrow(slots);
    for(const key of ['px','py','ov','nextX','nextY']) _sepShared(S,key,Float64Array,slots);
    _sepShared(S,'hit',Uint32Array,slots); _sepShared(S,'fast',Uint8Array,slots);
    // (The kernel's lists of units left to the scalar commit.)
    _sepShared(S,'ex',Int32Array,slots); _sepShared(S,'exc',Int32Array,Math.ceil(slots/512)+1);
    S.hit.fill(0,0,slots);
    for(let i=0;i<n;i++) {
        const s=samples[i]._si;
        S.px[s]=Math.round((rand()-.5)*UNIT_SEPARATION_Q*30);
        S.py[s]=Math.round((rand()-.5)*UNIT_SEPARATION_Q*30);
        S.ov[s]=rand()*32; S.hit[s]=1+(i%100);
        if(i%11===0) S.px[s]=S.py[s]=0;
    }
    _simParams[0]=slots; _simParams[1]=512; _simParams[2]=TILE; _simParams[3]=UNIT_POSITION_QUANTIZATION;
    _simParams[4]=UNIT_SEPARATION_CONTACTS; _simParams[5]=UNIT_SEPARATION_Q; _simParams[6]=gameTime; _simParams[7]=UNIT_SEPARATION_PATH_RETRY_TICKS;
    _simParams[8]=GRID_W; _simParams[9]=GRID_H;
    // (Gain 1, the whole push now, no index updates: the plain commit.)
    _simParams[10]=1; _simParams[11]=1; _simParams[12]=0; simMoveWallGrid();
    // The kernel commits pushes that cannot meet a blocked tile itself (the
    // unit's columns): the oracle starts from the positions before.
    // (The kernel clears the sums as it reads them: the oracle's copy.)
    const before=samples.map(u=>[u.x,u.y]), sums=samples.map(u=>[S.px[u._si],S.py[u._si],S.ov[u._si],S.hit[u._si]]);
    simParallelRun(SIM_KERNEL_SEPARATION_FINISH,Math.ceil(slots/512));
    const after=samples.map(u=>[u.x,u.y]);
    let accepted=0, different=0, rejected=n;
    for(let i=0;i<n;i++) {
        const u=samples[i], s=u._si; u.x=before[i][0]; u.y=before[i][1]; const gx=Math.floor(u.x/TILE), gy=Math.floor(u.y/TILE);
        if(!S.fast[s] || (!u.isFlying && grid[gy][gx].type===TYPE_WALL)) continue;
        accepted++; rejected--;
        const [spx,spy,sov,k]=sums[i], scale=k<=UNIT_SEPARATION_CONTACTS?1:Math.sqrt(UNIT_SEPARATION_CONTACTS/k);
        const dx=spx*scale/UNIT_SEPARATION_Q, dy=spy*scale/UNIT_SEPARATION_Q;
        if(dx!==0||dy!==0) applyUnitSeparation(u,dx,dy,sov);
        pushUnitOutOfBlockedTile(u);
        u.x=_quantizeUnitWorldCoord(u.x); u.y=_quantizeUnitWorldCoord(u.y);
        if(u.x!==after[i][0]||u.y!==after[i][1]) different++;
    }
    return {accepted,rejected,different};
})())`));
assert.equal(result.different,0);
// (Pushes across tiles over open ground are committed by the kernel too:
// here nearly all; the rest go through the scalar commit.)
assert.ok(result.accepted>10000);
assert.deepEqual(inst.errors.map(String),[]);
console.log('PASS: parallel collision correction agrees exactly with swept scalar collision/quantization:',result);
