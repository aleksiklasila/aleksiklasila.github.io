'use strict';
const assert = require('node:assert/strict'), H = require('./net-harness.cjs');
const world = new H.World({controls:{...H.SMALL_MATCH_CONTROLS,'cfg-mapsize':'192','cfg-map-type':'arena'}});
const inst = world.spawn('action-arrival-native',{simWorker:false});
inst.eval('startSoloGame();');
const result = inst.eval(`(() => {
    if(typeof _simWasmX.k_uid_arrival!=='function')throw Error('missing native arrival kernel');
    const made=[];
    for(let j=0;j<ACTION_MAX_UNIT_IDS+500;j++){
        const u=Object.create(Unit.prototype);simUnitStateAllocate(u,320,320);
        u.id=nextUnitId++;u.owner=j%3;units.push(u);made.push(u);
    }
    made[15].dead=true;
    const removed=made[30],gone=removed.id;unitRemoved(removed);simUnitStateDetach(_simUnitState,removed._si);
    const replacement=Object.create(Unit.prototype);simUnitStateAllocate(replacement,320,320);
    replacement.id=nextUnitId++;replacement.owner=0;units.push(replacement);made.push(replacement);
    const loose={id:900000001,owner:0};
    const map=_unitByIdMap(),c=_orderCols();orderQueueReserve();
    const all=made.map(u=>u.id),valid=made.filter(u=>u!==removed),initial=new Map();
    let native=0,cases=0,seed=17;
    const direct=simRustDirect;simRustDirect=function(name){if(name==='k_uid_arrival')native++;return direct.apply(this,arguments);};
    const check=(ids,p,seq,waits,wire=false)=>{
        _actLive=new Map([[0,{live:20000}],[1,{live:20000}],[2,{live:20000}]]);_actMarked=false;
        initial.clear();
        for(let j=0;j<valid.length;j++){const u=valid[j],mark=j%7;c.actMk[u._si]=mark;initial.set(u.id,mark);}
        const marks=new Map(initial),lives=new Map([..._actLive].map(([s,v])=>[s,v.live]));
        const raw=wire?{uidz:actionIdsEncode(ids)}:{unitIds:ids},input=wire?actionIdsDecode(raw.uidz):ids,mark=seq+1;
        let live=0,marked=false;
        // An independent model of the supersession records, indexed by ID.
        for(const id of input){
            const u=map.get(id);
            if(!u||u._us!==c||u._si<0||c.owner[u._si]!==p)continue;
            const old=marks.get(id);
            if(old===mark)continue;
            if(old>0&&lives.has(old-1))lives.set(old-1,lives.get(old-1)-1);
            marks.set(id,mark|0);live++;marked=true;
        }
        if(waits)lives.set(seq,live);
        simHeapPlayMark(true);_actionRecordArrival(raw,p,seq,waits);
        const allocations=simHeapPlayStats();
        if(allocations.n||allocations.grownMB)throw Error('arrival allocated WASM memory');
        for(const u of valid)if(c.actMk[u._si]!==marks.get(u.id))throw Error('mark mismatch '+u.id+' case '+cases);
        if(_actMarked!==marked)throw Error('marked flag mismatch');
        if(JSON.stringify([..._actLive].map(([s,v])=>[s,v.live]))!==JSON.stringify([...lives]))throw Error('waiting live counts mismatch case '+cases);
        cases++;
    };
    check(all,0,20,true);check(all.slice().reverse(),1,21,false);
    check([...all,...all,...all.slice(0,800)],2,22,true);
    check([...all.slice(0,10000),...all.slice(0,10000),...all.slice(10000)],0,23,true);
    units.push(loose);check([...all,loose.id,gone,replacement.id],0,24,true);unitRemoved(loose);
    check(all.slice(0,800),1,25,true,true);
    check(all.slice(0,800),0,2,true); // Some slots already have this mark.
    check(all,8,26,true); // No matching owner.
    for(let t=0;t<12;t++){
        const ids=[];for(let j=0;j<2400;j++){
            seed=(Math.imul(seed,1664525)+1013904223)|0;ids.push(all[(seed>>>0)%all.length]);
            if(j%9===0)ids.push(NaN,Infinity,null,'1',1.5,-1,2147483648,gone,loose.id,undefined);
        }check(ids,t%3,30+t,!!(t&1));
    }
    check(all.slice(0,200),0,50,true); // Scalar small-list fallback.
    check(all.slice(0,800),0,2147483647,true); // Existing signed-column rollover behavior.
    check(all.slice(0,800),'0',51,true); // Do not coerce a player ID.
    // A tool can attach columns to an object after it entered the loose
    // ID map. Preserve the scalar lookup until that index is rebuilt.
    units.push(loose);simUnitStateAllocate(loose,320,320);c.id[loose._si]=loose.id;c.owner[loose._si]=0;valid.push(loose);
    check([...all.slice(0,800),loose.id],0,52,true);
    unitRemoved(loose);simUnitStateDetach(_simUnitState,loose._si);valid.pop();
    // Worst-case output: a different previous mark for every input. Guard
    // both sides of each scratch view and verify one run per changed unit.
    const n=700,Q=orderQueueReserve(),out=simSharedArray(Int32Array,n+2),runs=simSharedArray(Int32Array,n+2);
    out.fill(-777);runs.fill(-888);
    for(let j=0;j<n;j++){const u=valid[j];Q.ids[j]=u.id;c.actMk[u._si]=j+1;c.owner[u._si]=0;}
    simRustDirect('k_uid_arrival',[Q.ids,map.t,c.id,c.live,c.owner,c.actMk,out.subarray(1,n+1),runs.subarray(1,n+1),Q.cnt],new Float64Array([n,map.mask,2000,0]));
    if(Q.cnt[0]!==n||Q.cnt[1]!==n||out[0]!==-777||out[n+1]!==-777||runs[0]!==-888||runs[n+1]!==-888)throw Error('output counts/guards');
    for(let j=0;j<n;j++)if(out[j+1]!==j+1||runs[j+1]!==1)throw Error('output run mismatch');
    return {cases,native};
})()`);
assert.ok(result.native>=20);
assert.ok(result.cases>=24);
assert.deepEqual(inst.errors.map(String),[]);
console.log('PASS: native arrival marks/counts, chunked duplicates, raw IDs, ownership, dead/removed/reused/loose slots, wire IDs, fallbacks and scratch guards',result);
