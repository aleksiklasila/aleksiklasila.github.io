'use strict';
const assert=require('node:assert/strict'),H=require('./net-harness.cjs');
const world=new H.World({controls:H.SMALL_MATCH_CONTROLS}),inst=world.spawn('journal',{simWorker:false});
const result=inst.eval(`(() => {
    _teLog=new Uint32Array(0);_teLogBase=0;_teLogEnd=0;tileEntityIndexesReset();
    const fast={epoch:-1,pos:0},lagging={epoch:-1,pos:0},expired={epoch:-1,pos:0};
    for(const c of[fast,lagging,expired])if(tileEntityChangesSince(c)!==null)throw Error('Initial epoch');
    let checks=0;
    // Frequent readers must cross multiple wraps without a full rebuild.
    // Readers beyond capacity expire; the oldest retained cursor still gets
    // the exact distinct sorted suffix.
    for(let base=0;base<TE_LOG_CAP*3;base+=997){
        const n=Math.min(997,TE_LOG_CAP*3-base),expected=new Set();
        for(let j=0;j<n;j++){
            const t=((base+j)*17)%4096;expected.add(t);
            noteTileEntityChanged(t%GRID_W,Math.floor(t/GRID_W));
        }
        const want=[...expected].sort((a,b)=>a-b),got=tileEntityChangesSince(fast);
        if(got===null||got.length!==want.length||got.some((t,i)=>t!==want[i]))throw Error('Frequent reader lost changes at '+base);
        if(tileEntityChangesSince(fast).length!==0)throw Error('No-op reader');
        if(base===TE_LOG_CAP-TE_LOG_CAP%997){
            const suffix=tileEntityChangesSince(lagging);
            // This reader is now farther behind than the retained capacity.
            if(suffix!==null)throw Error('Expired reader must rebuild');
        }
        checks++;
    }
    if(tileEntityChangesSince(expired)!==null)throw Error('Old reader must rebuild');
    const boundary={epoch:_tileEntityEpoch,pos:_teLogEnd-TE_LOG_CAP};
    const retained=tileEntityChangesSince(boundary);
    if(retained===null||retained.length!==4096||retained.some((t,i)=>t!==i))throw Error('Full retained suffix was lost');
    tileEntityIndexesReset();
    if(tileEntityChangesSince(fast)!==null)throw Error('Epoch reset must rebuild');
    return {checks,bytes:_teLog.byteLength,end:_teLogEnd};
})()`);
assert.equal(result.bytes,262144*4);assert.equal(result.end,262144*3);assert.ok(result.checks>700);
console.log('PASS: current readers survive three journal wraps; expired readers and epoch resets rebuild',result);
