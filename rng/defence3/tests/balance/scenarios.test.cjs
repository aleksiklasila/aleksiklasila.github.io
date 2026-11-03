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
    assert.equal(new Set(manifest.scenarios.filter(s=>s.kind==='fight'&&s.balanceMode!=='equal-energy').map(s=>s.focal+':'+s.research)).size,manifest.catalog.length*manifest.researchLevels.length);
    assert.equal(manifest.mapSize,Math.max(...require('../menu-limits.cjs').choices('cfg-mapsize')));
    for(const focal of manifest.catalog) for(const research of manifest.researchLevels) {
        const parts=manifest.scenarios.filter(s=>s.balanceMode==='equal-numbers'&&s.focal===focal.id&&s.research===research);
        const opponents=manifest.catalog.filter(t=>focal.role==='crossing'?t.kind==='unit':t.role==='army');
        assert.equal(parts.reduce((n,s)=>n+s.arenas.length,0),manifest.levels.length*opponents.length,'all matchups retained across legal map parts');
        for(const part of parts) for(const arena of part.arenas) assert.ok(arena.bounds.every(n=>n>=0&&n<manifest.mapSize),'arena fits current maximum map');
        const energy=manifest.scenarios.filter(s=>s.balanceMode==='equal-energy'&&s.focal===focal.id&&s.research===research);
        assert.ok(energy.length,'equal-energy parts exist');
        const expected=manifest.levels.flatMap(level=>opponents.map(t=>level+':'+t.id)).sort();
        for(const set of [parts,energy]) {
            assert.deepEqual(set.flatMap(s=>s.arenas.map(a=>a.level+':'+a.opponent)).sort(),expected,
                'every matchup retained exactly once across parts');
        }
    }
    const menu=require('../menu-limits.cjs');
    for(const part of manifest.scenarios.filter(s=>s.kind==='fight')){
        const units=[0,0],buildings=[1,1];
        for(const a of part.arenas)for(let owner=0;owner<2;owner++){
            const thing=manifest.catalog.find(t=>t.id===(owner?a.opponent:a.focal));
            (thing.kind==='unit'?units:buildings)[owner]+=a.counts[owner];
            assert.ok(a.bounds.every(n=>n>=0&&n<manifest.mapSize),'arena fits current maximum map');
        }
        const budget=menu.budget(menu.pick('cfg-max-pop',Math.max(8,...units)),2,manifest.mapSize);
        assert.ok(units.every(n=>n<=budget.population)&&buildings.every(n=>n<=budget.buildings),'fixture fits menu-derived capacities: '+part.name);
    }
    for(const scenario of manifest.scenarios) assert.ok(fs.statSync(path.join(ROOT,scenario.file)).size>0,scenario.file);
    // Worker exports are generated separately from fights. Catch stale large
    // maps here, before a benchmark happens to select and reject one.
    if(process.argv[2]!=='--sample') for(const scenario of manifest.scenarios.filter(s=>s.kind==='work')) {
        const records=JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(ROOT,scenario.file))));
        assert.equal(records[0].width,manifest.mapSize,scenario.name+' width');
        assert.equal(records[0].height,manifest.mapSize,scenario.name+' height');
        assert.equal(scenario.groups.length,manifest.levels.length*10,'all worker groups retained');
        for(const record of records) for(const key of ['units','buildings','mines']) for(const e of record[key]||[]) {
            const xy=key==='mines'?1:2;
            assert.ok(e[xy]>=0&&e[xy]<manifest.mapSize&&e[xy+1]>=0&&e[xy+1]<manifest.mapSize,
                scenario.name+' '+key+' coordinates fit');
        }
    }
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
        const menuLimits=require('../menu-limits.cjs').scene(records,inst);
        inst.scratch.file=new Blob([JSON.stringify(records)]);
        inst.scratch.scene=await inst.eval('readSoloGameSnapshotFile(__scratch.file)');
        inst.eval('startMainThreadLoops=()=>{}; document.getElementById("starting-resources-popup").classList.add("hidden")');
        await settle(world,inst.eval('restoreSoloGameSnapshot(__scratch.scene)'));
        const counts=JSON.parse(inst.eval('JSON.stringify({units:units.length,towers:towers.length,items:getCellItemsRowMajor().length,width:GRID_W,height:GRID_H,over:gameOver})'));
        assert.equal(counts.width,menuLimits.map); assert.equal(counts.height,menuLimits.map);
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
                assert.equal(runs[i]===1,x>=manifest.mapSize||y>=manifest.mapSize||turretTiles.has(x+','+y),'only actual turret tiles and the sealed historical-map border may be walls');
            y++;
        }
        assert.ok(inst.eval('units.every(u=>'+JSON.stringify(scenario.levels)+'.includes(u.baseLevel))'));
        if(baseName==='building_laser_R0') assert.ok(inst.eval('_laserMapBuild(); towers.every(t=>laserPartnersOf(t).length>0)'),'every laser has a live link');
        if(baseName==='building_poison_R5') {
            assert.ok(inst.eval('towers.every(t=>!t.underConstruction)'));
            assert.equal(inst.eval('getPlayerResearchLevel(0,"building","poison","damage")'),5);
        }
        if(baseName.startsWith('building_poison_')) assert.ok(inst.eval(`(() => {
            let checked=0;
            for(const t of towers.filter(t=>t.type==='poison' && t.owner===0)) {
                const other=towers.find(o=>o.owner===1 && o.gx===t.gx+1 && o.gy===t.gy);
                if(other && isWorldTargetWithinAreaRange(t.x,t.y,other.x,other.y,Math.floor(t.currentStats.attackRangeArea))) checked++;
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
