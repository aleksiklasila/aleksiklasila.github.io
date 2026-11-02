// Equal wall/cost profiles share immutable geometry, while their versions,
// live walls and subsequent replacements remain independent.
'use strict';
const assert=require('node:assert/strict'),H=require('./net-harness.cjs');
const world=new H.World({controls:{...H.SMALL_MATCH_CONTROLS,'cfg-mapsize':'64'}});
const inst=world.spawn('shared-nav',{simWorker:false});
inst.eval(`NAV_SHARE_BUILDS = true; startSoloGame(); navReset();
    const testWall=simHeapArrayAuto(Uint8Array,GRID_W*GRID_H);
    testWall[GRID_W*12+12]=1;
    navWallTable=p=>testWall;
    // (Ground and builders: equal walls here; the air its own.)
    const groundNav=navEnsure(0), builderNav=navEnsure(2), airNav=navEnsure(1);
    const collectNav=builderNav;
    __scratch.shared=groundNav!==builderNav&&groundNav.fields===builderNav.fields&&groundNav.atlas===builderNav.atlas&&groundNav.wall===builderNav.wall;
    __scratch.independent=groundNav.profile===0&&builderNav.profile===2&&groundNav.version!==builderNav.version&&groundNav.seq===1&&builderNav.seq===1;
    __scratch.distinct=groundNav.fields!==airNav.fields;
    testWall[GRID_W*14+12]=1;
    __scratch.immutable=groundNav.wall[GRID_W*14+12]===0&&collectNav.wall[GRID_W*14+12]===0;
    _nav[2]=null;const replacementNav=navEnsure(2);
    __scratch.replaced=replacementNav.fields!==groundNav.fields&&replacementNav.wall[GRID_W*14+12]===1&&groundNav.wall[GRID_W*14+12]===0&&replacementNav.seq===2;
    const refNav=navBuild(2,testWall,true,GRID_W,GRID_H);
    __scratch.exact=['fields','nodeTile','nodePair','partL','partBase','partComp','adjA','adjC','cost'].every(k=>replacementNav[k].length===refNav[k].length&&replacementNav[k].every((v,i)=>v===refNav[k][i]));
    const sharedJob=_navJob={profile:0,start:gameTime,step:0,b:null};
    for(;sharedJob.step<=NAV_STEP_LOCAL;sharedJob.step++)_navJobStep(sharedJob,sharedJob.step);
    __scratch.sharedJob=sharedJob.shared&&sharedJob.b.fields===replacementNav.fields;
    const jobSnapshot=navSnapshotState();
    for(;sharedJob.step<=NAV_STEP_INSTALL;sharedJob.step++)_navJobStep(sharedJob,sharedJob.step);
    __scratch.installed=_nav[0].fields===replacementNav.fields&&_nav[0].seq===2;
    navRestoreState(jobSnapshot);
    const restoredJob=_navJob;
    for(;restoredJob.step<=NAV_STEP_INSTALL;restoredJob.step++)_navJobStep(restoredJob,restoredJob.step);
    __scratch.restored=_nav[0].seq===2&&_nav[0].fields.every((v,i)=>v===refNav.fields[i]);
`);
for(const k of ['shared','independent','distinct','immutable','replaced','exact','sharedJob','installed','restored'])assert.equal(inst.scratch[k],true,k);
assert.deepEqual(inst.errors.map(String),[]);
console.log('PASS: navigation shares equal geometry, with independent profile versions and replacements');
