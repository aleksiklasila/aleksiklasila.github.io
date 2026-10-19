'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const H = require('../net-harness.cjs');
const ROOT=path.resolve(__dirname,'../scenarios');
async function settle(world, promise) {
    let done=false, error;
    promise.then(()=>{done=true;},e=>{error=e;done=true;});
    assert.ok(await world.runUntil(()=>done,30000,10),'import completes');
    if(error) throw error;
}
async function main() {
    const manifest=JSON.parse(fs.readFileSync(path.join(ROOT,'manifest.json')));
    assert.equal(manifest.scenarios.filter(s=>s.kind==='fight'&&s.balanceMode!=='equal-energy').length,manifest.catalog.length*manifest.researchLevels.length);
    for(const scenario of manifest.scenarios) assert.ok(fs.statSync(path.join(ROOT,scenario.file)).size>0,scenario.file);
    const samples=['unit_fast_R0','unit_poison_resistant_R10','building_poison_R5',
        'building_laser_R0','building_mine_R10','building_poison_R0'].map(n=>'fight-2-teams-'+n);
    if(process.argv[2]!=='--sample') {
        for(const name of samples) require('node:child_process').execFileSync(process.execPath,[__filename,'--sample',name],{stdio:'inherit'});
        return;
    }
    for(const name of samples.filter(n=>n===process.argv[3])) {
        const baseName=name.replace(/^fight-2-teams-/,'');
        const scenario=manifest.scenarios.find(s=>s.name===name);
        assert.ok(scenario,name);
        const compressed=fs.readFileSync(path.join(ROOT,scenario.file));
        const records=JSON.parse(zlib.gunzipSync(compressed));
        const world=new H.World();
        const inst=world.spawn(name,{simWorker:false});
        inst.scratch.file=new Blob([compressed]);
        inst.scratch.scene=await inst.eval('readSoloGameSnapshotFile(__scratch.file)');
        inst.eval('startMainThreadLoops=()=>{}; document.getElementById("starting-resources-popup").classList.add("hidden")');
        await settle(world,inst.eval('restoreSoloGameSnapshot(__scratch.scene)'));
        const counts=JSON.parse(inst.eval('JSON.stringify({units:units.length,towers:towers.length,items:getCellItemsRowMajor().length,width:GRID_W,height:GRID_H,over:gameOver})'));
        assert.equal(counts.width,manifest.mapSize); assert.equal(counts.height,manifest.mapSize);
        const rows=key=>records.flatMap(r=>r[key]||[]);
        assert.equal(counts.units,rows('units').length);
        assert.equal(counts.towers+counts.items,rows('buildings').length);
        assert.equal(counts.over,false);
        assert.equal(rows('units').length+rows('buildings').length,scenario.arenas.reduce((n,a)=>n+a.counts[0]+a.counts[1],0)+scenario.anchors.length);
        assert.ok(rows('units').every(u=>Number.isFinite(u[4]) && u[4]>0));
        assert.ok(rows('buildings').every(b=>Number.isFinite(b[5]) && b[5]>0 && !b[6]));
        for(const u of rows('units')) {
            const arena=scenario.arenas.find(a=>u[2]>=a.bounds[0] && u[2]<=a.bounds[2]+1 && u[3]>=a.bounds[1] && u[3]<=a.bounds[3]+1);
            assert.ok(arena,'unit belongs to a pair');
            if(arena.mode==='combat') {
                assert.deepEqual(u[7],['attackMove',...arena.rallyTargets[u[1]]]);
            }
        }
        const turretTiles=new Set(rows('buildings').filter(b=>manifest.catalog.find(t=>t.key===b[0] && t.kind==='building')?.role==='army' || b[0]==='laser').map(b=>b[2]+','+b[3]));
        let y=0;
        for(const runs of rows('terrain')) {
            let x=0;
            for(let i=0;i<runs.length;i+=4) for(let j=0;j<runs[i+3];j++,x++)
                assert.equal(runs[i]===1,turretTiles.has(x+','+y),'only actual turret tiles may be walls');
            y++;
        }
        assert.ok(inst.eval('units.every(u=>'+JSON.stringify(scenario.levels)+'.includes(u.baseLevel))'));
        if(baseName==='building_laser_R0') assert.ok(inst.eval('ensureLaserConnections(); towers.every(t=>t.connectedLasers && t.connectedLasers.length>0)'),'every laser has a live link');
        if(baseName==='building_poison_R5') {
            assert.ok(inst.eval('towers.every(t=>!t.underConstruction)'));
            assert.equal(inst.eval('getPlayerResearchLevel(0,"building","poison","damage")'),5);
        }
        if(baseName.startsWith('building_poison_')) assert.ok(inst.eval(`(() => {
            let checked=0;
            for(const t of towers.filter(t=>t.type==='poison' && t.owner===0)) {
                const other=towers.find(o=>o.owner===1 && o.gx===t.gx+1 && o.gy===t.gy);
                if(other && _isTargetWithinTowerAttackAreaRange(t,other)) checked++;
            }
            return checked>0;
        })()`),'adjacent turret fronts are in actual attack range');
        for(const arena of scenario.arenas.filter(a=>a.counts[0]===98)) {
            const bs=rows('buildings').filter(b=>b[2]>=arena.bounds[0] && b[2]<=arena.bounds[2] && b[3]>=arena.bounds[1] && b[3]<=arena.bounds[3]);
            assert.equal(bs.length,196);
            const parity=bs[0][1]^(bs[0][2]+bs[0][3])%2;
            assert.ok(bs.every(b=>(b[1]^(b[2]+b[3])%2)===parity),'turret teams alternate on every tile');
            assert.equal(new Set(bs.map(b=>b[2])).size,14); assert.equal(new Set(bs.map(b=>b[3])).size,14);
        }
        for(let tick=0;tick<3;tick++) inst.eval('runOneTick()');
        assert.equal(inst.eval('gameOver'),false,'match stays active after the defeat checks run');
        assert.equal(inst.eval('localDefeated'),false,'unit armies are not defeated for lacking a base');
        assert.deepEqual(inst.errors,[],name+' runtime errors');
        console.log('PASS offline import and live ticks: '+name);
    }
}
if(require.main===module) main().catch(e=>{console.error(e);process.exitCode=1;});
