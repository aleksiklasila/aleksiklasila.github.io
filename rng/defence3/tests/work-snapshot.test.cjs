'use strict';
const assert=require('node:assert/strict');
const H=require('./net-harness.cjs');
async function settle(world,promise) {
    let done=false,error,value;promise.then(v=>{value=v;done=true;},e=>{error=e;done=true;});
    assert.ok(await world.runUntil(()=>done,30000,10),'snapshot operation completes');if(error)throw error;return value;
}
async function main() {
    const world=new H.World({controls:H.SMALL_MATCH_CONTROLS});
    const source=world.spawn('work-source',{simWorker:false});source.eval('startSoloGame()');
    const coordinates=JSON.parse(source.eval(`JSON.stringify((()=>{
        const found={};
        for(const type of ['barrack_norm','research','house']) {
            let made=false;
            for(let y=2;y<GRID_H-2&&!made;y++)for(let x=2;x<GRID_W-2&&!made;x++) {
                if(grid[y][x].type!==TYPE_FLOOR||getTileEntityRef(x,y)||grid[y][x].item)continue;
                if(!placeBuilding(x,y,type,0,{silent:true,ignorePlacementRules:true,autoUpgradeEnabled:false}))continue;
                const e=getTileEntityRef(x,y)||grid[y][x].item;e.underConstruction=false;e.level=e.effectiveLevel=1;e.stacks=e.manualStacks=e.effectiveStacks=1;
                if(e.updateStats)e.updateStats();e.energy=e.maxEnergy;
                found[type]=[x,y];
                if(type==='barrack_norm'){e.spawnQueue=[getQueuedSpawnInfo({unitType:'norm',level:1,energyPaid:7},'norm',1,0)];e.autoResearchEnabled=false;spawnerProductionChanged(e);}
                if(type==='house')e.markedForSalvage=true;
                made=true;
            }
            if(!made)throw Error('No space for '+type);
        }
        const p=ensurePlayerResearchQueueState(0);p.researchTask=null;p.researchQueue=[makeResearchTask(0,'unit','norm','atk',0)];tryAdvancePlayerResearchTask(0);
        return found;
    })())`));
    const parts=await settle(world,source.eval('captureSoloGameSnapshotParts()'));
    for(const worker of [false,true]) {
        world.simWorker=worker;
        const target=world.spawn('work-import-'+worker,{simWorker:worker});target.scratch.parts=parts;target.scratch.coords=coordinates;
        target.eval('startMainThreadLoops=()=>{};document.getElementById("starting-resources-popup").classList.add("hidden")');
        await settle(world,target.eval('restoreSoloGameSnapshot(parseSoloGameSnapshotParts(__scratch.parts))'));
        target.scratch.coords=coordinates;
        const state=JSON.parse(target.evalSim(`JSON.stringify((()=>{
            const b=barracks.find(e=>e.owner===0&&e.unitType==='norm'&&e.gx===${coordinates.barrack_norm[0]}&&e.gy===${coordinates.barrack_norm[1]});
            const house=getTileEntityRef(${coordinates.house[0]},${coordinates.house[1]})||grid[${coordinates.house[1]}][${coordinates.house[0]}].item;
            return {queue:b.spawnQueue.map(q=>[q.unitType,q.level,q.energyPaid]),marked:house.markedForSalvage,task:getPlayerResearchTask(0)?.statKey};
        })())`));
        assert.deepEqual(state,{queue:[['norm',1,7]],marked:true,task:'atk'});
        assert.deepEqual(target.errors,[]);
        console.log('PASS portable work orders: production, salvage and research ('+(worker?'worker':'page')+')');
    }
}
main().catch(e=>{console.error(e);process.exitCode=1;});
