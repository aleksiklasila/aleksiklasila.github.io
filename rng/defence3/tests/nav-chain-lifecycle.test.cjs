'use strict';
// Fixed-arena overflow, reuse, empty geometry and restores at both chain
// boundaries. Completion timing/helper count must not choose an install step.
globalThis.self = {crossOriginIsolated:true};
const assert = require('node:assert/strict'), H = require('./net-harness.cjs');
for (const helpers of [0, 3]) {
    const world = new H.World({controls:{...H.SMALL_MATCH_CONTROLS,'cfg-mapsize':'80','cfg-map-type':'arena'}});
    const inst = world.spawn('nav-chain-'+helpers,{simWorker:false});
    inst.eval('startSoloGame();');
    if (helpers) {
        inst.scratch.Worker = require('./real-sim-helper.cjs');
        inst.eval(`Worker=__scratch.Worker;navigator.hardwareConcurrency=16;simParallelInit('',${helpers});`);
    }
    const results = JSON.parse(inst.eval(`JSON.stringify((()=>{
        const check = (v,m) => {if(!v)throw Error(m);};
        const W=GRID_W,H=GRID_H,wall=new Uint8Array(W*H);
        // A cap that fits the initial arrays but not the local fields.
        let b=navBuildStart(0,wall,true,W,H,false);
        const stop=b.hdr[NAVH.TOP]+128;
        b.arena.fill(0xa5,stop);b.hdr[NAVH.CAP]=stop;
        navBuildChain(b);navBuildCollect();
        check(b.hdr[NAVH.FULL]===1,'arena overflow not reported');
        check(b.arena.subarray(stop).every(v=>v===0xa5),'overflow wrote beyond capacity');
        let dropped=false;try{navBuildFinish(b);}catch(e){dropped=e===_NAV_SLOT_FULL;}
        check(dropped,'incomplete build installed');
        _navOwned.delete(b.arena);simHeapFreeAuto(b.arena);
        // Reuse exactly the same arena address with different offsets/counts.
        const arena=simHeapArrayAuto(Uint8Array,_navAirBytes(W,H)*3,false),slot={a:arena,off:0};
        const take=_navSlotTake;_navSlotTake=()=>slot;
        try {
            for(const blocked of [false,true,false]) {
                wall.fill(blocked?1:0);
                b=navBuildStart(0,wall,true,W,H);navBuildChain(b);navBuildCollect();
                const nav=navBuildFinish(b);
                check(blocked ? nav.np===0&&nav.k===0&&nav.atlas===null : nav.np>0&&nav.k>0&&!!nav.atlas,'stale arena header');
            }
        } finally {_navSlotTake=take;simHeapFreeAuto(arena);}
        for(const p of _navProfilesInUse())navEnsure(p);
        _navLastJobProfile=NAV_PROFILE_BUILD;_navDiff[0]=1;
        simHeapPlayMark();
        for(let n=0;n<5;n++){gameTime++;navTick();}
        check(!_navJob&&simHeapPlayStats().n===0,'reserved rebuild allocated during play');
        const out=[];
        for(const dk of [1,4,20])for(const boundary of [1,2]) {
            simDk=dk;
            while(_navJob) {gameTime+=dk;navTick();}
            // A real wall change, on both profiles, with ground selected first.
            const x=8,y=8,c=grid[y][x];c.type=c.type===TYPE_WALL?TYPE_FLOOR:TYPE_WALL;simMoveTileTypeChanged(x,y);
            _navLastJobProfile=NAV_PROFILE_BUILD;
            for(let n=0;n<20;n++) {gameTime+=dk;navTick();if(_navJob&&_navJob.si===boundary)break;}
            check(_navJob&&_navJob.si===boundary,'missing snapshot boundary');
            const state=navSnapshotState(),time=gameTime,seq=_nav[0].seq;
            const finish=()=>{let steps=0;while(_nav[0].seq===seq&&steps<12){gameTime+=dk;navTick();steps++;}return steps;};
            const steps=finish(),expected=_nav[0],copy=a=>Array.from(a);
            const geometry=JSON.stringify([copy(expected.nodeTile),copy(expected.partComp),copy(expected.atlas.rc)]);
            gameTime=time;navRestoreState(state);
            // Restore again while the reconstructed chain is still pending:
            // its arena must not be reused until that chain is collected.
            navRestoreState(state);
            check(finish()===steps,'restore changed install step');
            const actual=_nav[0];
            check(JSON.stringify([copy(actual.nodeTile),copy(actual.partComp),copy(actual.atlas.rc)])===geometry,'restore changed geometry');
            out.push({dk,boundary,steps});
        }
        // An atlas-only window avoids field staging, but the first fallback
        // request in that window must still be made over the new geometry.
        const next=navBuild(0,_nav[0].wall,true,W,H);
        _navNextStage(next);check(_navNext.empty,'unused field window did work');
        NAV_ATLAS=false;
        const dest=_nav[0].wall.findIndex(v=>v===0),fid=navFieldRequest(0,dest);
        check(fid>=0&&!_navNext.empty,'first fallback did not expand window');
        _navFieldsStart();_navFieldsCommit();
        _navNextInstall(next);
        check(_navFields.pools[0].meta[fid*NAV_FIELD_META+7]===1,'fallback field not ready at install');
        NAV_ATLAS=true;
        return out;
    })())`));
    assert.deepEqual(inst.errors.map(String),[]);
    for (const r of results) assert.equal(r.steps,r.boundary===2?1:(r.dk>=3?2:3));
    console.log('PASS:',helpers,'helpers, overflow/reuse/empty builds and restores',JSON.stringify(results));
    if (helpers) inst.eval('for(const w of _simPool.helpers)w.terminate()');
}
process.exit(0);
