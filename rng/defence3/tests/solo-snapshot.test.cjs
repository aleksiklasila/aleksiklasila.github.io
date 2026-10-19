'use strict';
const assert = require('node:assert/strict');
const H = require('./net-harness.cjs');
async function settle(world, promise) {
    let done = false, value, error;
    promise.then(v => { value = v; done = true; }, e => { error = e; done = true; });
    assert.ok(await world.runUntil(() => done, 30000, 10), 'operation finished');
    if (error) throw error;
    return value;
}
(async () => {
    for (const worker of [false,true]) {
        const world = new H.World({ controls: H.SMALL_MATCH_CONTROLS }); world.simWorker = worker;
        const source = world.spawn('source'); await world.run(200); source.eval('startSoloGame()'); await world.run(1200);
        source.evalSim(`(() => {
            players[0].energy = 123456; players[0].astar = 654321;
            const u = units.find(u => !u.dead && u.owner === 0 && !u.workerState);
            u.energy = 37;
            _issueGroupMoveOrder({unitIds:[u.id],distinct:true,targetX:10*TILE+16,targetY:10*TILE+16},0,CMD_ATTACK_MOVING);
            const b = barracks[0]; if (b) { b.rallyX=10*TILE+16; b.rallyY=11*TILE+16; }
            for (const type of ['barrack_tank','pistol','house']) {
                let found=false;
                for(let y=2;y<GRID_H-2&&!found;y++)for(let x=2;x<GRID_W-2&&!found;x++) {
                    if(getTileEntityRef(x,y)||grid[y][x].item||grid[y][x].type!==TYPE_FLOOR)continue;
                    placeBuilding(x,y,type,1,{silent:true,ignorePlacementRules:true,autoUpgradeEnabled:false});
                    const e=getTileEntityRef(x,y)||grid[y][x].item;
                    e.manualStacks=e.stacks=4;e.underConstruction=type==='house';e.energy=83;found=true;
                }
            }
            units.push(new Unit('builder_unit',0,12*TILE+16,12*TILE+16)); configureWorkerUnitFromType(units[units.length-1]);
            // Real 4M-1K export: crowd movement put a researcher 2.5 pixels
            // beyond the top edge. Such live positions must remain loadable.
            for (const [x,y] of [[15*TILE,-2.5],[-2.5,15*TILE],[GRID_W*TILE+2.5,15*TILE],[15*TILE,GRID_H*TILE+2.5]]) {
                const edge=new Unit('researcher_unit',0,x,y);
                configureWorkerUnitFromType(edge);edge.holdPosition=true;
                units.push(edge);unitSlotMapPushed(edge);
            }
            if (b) { b.rallyX=-2.5; b.rallyY=11*TILE+16; }
        })()`);
        const parts = await settle(world,source.eval('captureSoloGameSnapshotParts()'));
        source.scratch.parts = parts;
        const scene = source.eval('parseSoloGameSnapshotParts(__scratch.parts)');
        source.scratch.file = await source.eval('compressSoloGameSnapshot(__scratch.parts)');
        assert.equal(new Uint8Array(await source.scratch.file.slice(0,2).arrayBuffer())[0],0x1f);
        const zipped = await source.eval('readSoloGameSnapshotFile(__scratch.file)');
        assert.equal(JSON.stringify(zipped),JSON.stringify(scene),'gzip round trip');
        source.scratch.file = new Blob(parts);
        assert.equal(JSON.stringify(await source.eval('readSoloGameSnapshotFile(__scratch.file)')),JSON.stringify(scene),'plain scene remains supported');
        const json = source.eval('soloGameSnapshotJsonParts(__scratch.parts)').join('');
        for (const text of [json, JSON.stringify(JSON.parse(json),null,2),JSON.stringify(JSON.parse(json))]) {
            source.scratch.file = new Blob([text]);
            assert.equal(JSON.stringify(await source.eval('readSoloGameSnapshotFile(__scratch.file)')),JSON.stringify(scene),'editable JSON scene');
        }
        for (const text of [json.slice(0,-3),json.trim()+'{}',json.trim().slice(0,-1)+',]']) {
            source.scratch.file = new Blob([text]);
            await assert.rejects(source.eval('readSoloGameSnapshotFile(__scratch.file)'));
        }
        source.scratch.file = new Blob([new Uint8Array([0x1f,0x8b,0,0])]);
        await assert.rejects(source.eval('readSoloGameSnapshotFile(__scratch.file)'));
        assert.equal(scene.header.kind,'defence3-scene');
        assert.equal(scene.header.players[0].energy,123456);
        assert.ok(scene.records.some(r=>r.units?.some(u=>u[7]?.[0]==='attackMove')));
        assert.ok(!parts.some(p=>p.includes('pendingPathTarget')||p.includes('SIM_RULES_REVISION')));
        const a = world.spawn('import-a'), b = world.spawn('import-b'); await world.run(200);
        for (const inst of [a,b]) {
            inst.scratch.parts=parts; inst.eval('startMainThreadLoops=()=>{}; document.getElementById("starting-resources-popup").classList.add("hidden");');
            await settle(world,inst.eval('restoreSoloGameSnapshot(parseSoloGameSnapshotParts(__scratch.parts))'));
        }
        await world.run(50);
        const state = inst=>inst.evalSim(`JSON.stringify({units:units.map(u=>[u.unitType,u.owner,u.x,u.y,u.energy,u.baseLevel,u.stackCount,getUnitOrderDestinationCode(u)]),
            buildings:barracks.map(b=>[b.gx,b.gy,b.rallyX,b.rallyY]),resources:players.map(p=>[p.energy,p.astar]),hash:snapTickHash(currentTick,true)})`);
        assert.equal(state(a),state(b),'independent imports are repeatable');
        assert.equal(a.eval('simClientActive()'),worker);
        assert.equal(a.evalSim('players[0].energy'),123456);
        const rows = scene.records.flatMap(r=>r.units||[]);
        assert.equal(a.evalSim('units.length'),rows.length);
        const restored = JSON.parse(a.evalSim('JSON.stringify(units.map(u=>[u.unitType,u.owner,u.x/TILE,u.y/TILE,u.energy]))'));
        assert.deepEqual(restored,rows.map(r=>r.slice(0,5)),'positions/types/owners/health survive');
        a.scratch.context={settings:scene.header.settings,player:0,camera:scene.header.camera,teamColors:scene.header.teamColors};
        const reexport=JSON.parse(a.evalSim('JSON.stringify(buildSoloGameSnapshotParts(__scratch.context))'));
        const records=reexport.map(s=>JSON.parse(s));
        for(const key of ['buildings','mines','terrain']) assert.deepEqual(records.flatMap(r=>r[key]||[]),scene.records.flatMap(r=>r[key]||[]),key+' survives import');
        for(let t=0;t<10;t++) {
            for(const inst of [a,b]) inst.evalSim(worker ? '_simTick({tick:currentTick,actions:[],teams:activeTeamIds,dk:1})' : 'runOneTick()');
            assert.equal(state(a),state(b),'same continuation '+t);
        }
        const menu=world.spawn('invalid'); menu.scratch.parts=parts.slice(0,-1);
        assert.throws(()=>menu.eval('parseSoloGameSnapshotParts(__scratch.parts)'),/incomplete/);
        assert.throws(()=>menu.eval(`parseSoloGameSnapshotParts(['{"version":4}'])`),/settings export/);
        for(const inst of [source,a,b]) assert.deepEqual(inst.errors,[],inst.name+' errors');
        console.log('PASS portable scene '+(worker?'worker':'page')+': locations, orders, resources, repeated imports and continuation');
    }
})().catch(e=>{console.error(e);process.exitCode=1;});



