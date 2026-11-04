'use strict';
const assert = require('node:assert/strict'), H = require('./net-harness.cjs');
const world = new H.World({ controls: { ...H.SMALL_MATCH_CONTROLS, 'cfg-mapsize':'192', 'cfg-map-type':'arena' } });
const inst = world.spawn('action-clean-native', { simWorker:false });
inst.eval('startSoloGame();');
const result = inst.eval(`(() => {
    if(typeof _simWasmX.k_uid_clean!=='function')throw Error('missing native cleaner');
    // Sanitization concerns list membership, including dead units not yet
    // retired. No occupancy/spawning limits are needed for these table rows.
    const count=ACTION_MAX_UNIT_IDS+300, made=[];
    for(let j=0;j<count;j++){
        const u=Object.create(Unit.prototype);
        simUnitStateAllocate(u,320,320);u.id=nextUnitId++;u.owner=j%2;
        units.push(u);made.push(u);
    }
    const oracle=ids=>{const out=[],seen=new Set(),map=_unitByIdMap();for(const id of ids){
        if(typeof id!=='number'||!Number.isInteger(id)||seen.has(id)||map.get(id)===undefined)continue;
        seen.add(id);out.push(id);if(out.length===ACTION_MAX_UNIT_IDS)break;
    }return out;};
    let seed=7,cases=0,native=0;
    const run=simRustDirect;simRustDirect=function(fn){if(fn==='k_uid_clean')native++;return run.apply(this,arguments);};
    const check=ids=>{const want=oracle(ids),actual=_actionCleanIds(ids);if(want.length!==actual.length||want.some((id,j)=>id!==actual[j]))throw Error('cleaner mismatch case '+cases);cases++;};
    const ids=made.map(u=>u.id);
    check(ids);check(ids.slice().reverse());check([...ids,...ids]);
    check([...new Array(ACTION_MAX_UNIT_IDS).fill(-123),...ids]);
    check([...ids.slice(0,12000),...ids.slice(0,12000),...ids.slice(12000)]);
    for(let t=0;t<16;t++){
        const a=[];for(let j=0;j<1200;j++){seed=(Math.imul(seed,1664525)+1013904223)|0;
            const n=(seed>>>0)%made.length;a.push(j%9===0?made[n].id+4294967296:made[n].id);
            if(j%7===0)a.push(NaN,Infinity,null,'1',1.5,{},-1,2147483648,undefined);
        }check(a);
    }
    made[15].dead=true;check([made[15].id,...ids]);
    // Stamp rollover must not retain duplicate marks from an earlier call.
    _actionIdStampNow=0x7ffffffe;check(ids.slice(0,800));check(ids.slice(0,800));
    const loose={id:900000001,owner:0};units.push(loose);check([loose.id,...ids]);
    unitRemoved(loose);
    const u=made[30],old=u.id;unitRemoved(u);simUnitStateDetach(_simUnitState,u._si);
    check([old,...ids]);
    return {cases,native};
})()`);
assert.ok(result.native >= 19);
assert.ok(result.cases >= 20);
assert.deepEqual(inst.errors.map(String), []);
console.log('PASS: native/scalar action ID cleaning, malformed/duplicate/capped IDs, loose/dead/removed units and stamp rollover', result);
