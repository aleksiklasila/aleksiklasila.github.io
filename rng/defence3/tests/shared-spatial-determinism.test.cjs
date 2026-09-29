// Active simulation equality across hardware counts and a mid-run full restore.
'use strict';
const assert = require('node:assert/strict');
globalThis.self = {crossOriginIsolated:true};
const H = require('./net-harness.cjs');
const RealWorker = require('./real-sim-helper.cjs');
const workers=[];
class Worker extends RealWorker { constructor(...args) { super(...args); workers.push(this); } }
(async () => {
    const controls={...H.SMALL_MATCH_CONTROLS,'cfg-mapsize':'60','cfg-max-pop':'10000','cfg-starting-energy':'900000000','cfg-starting-astar':'900000000'};
    const world=new H.World({controls});
    const host=world.spawn('serial',{simWorker:false}), peer=world.spawn('parallel',{simWorker:false});
    peer.eval('startSoloGame()');
    host.eval(`startSoloGame(); isMultiplayer=true; gameStarted=true;
        for(let i=0;i<4200;i++) {
            const u=new Unit(i%7===0?'flying':'norm',i&1,(10+(i%70)*.5)*TILE,(10+Math.floor(i/70)*.5)*TILE);
            units.push(u); players[u.owner].popCount++;
        }
        for(const owner of activeTeamIds) processActions([{action:'attackMove',unitIds:units.filter(u=>u.owner===owner&&!u.isKing&&!u.workerType).map(u=>u.id),targetX:GRID_W*TILE*.6,targetY:GRID_H*TILE*.5}],owner);`);
    const restore=()=>{
        // The resync protocol drops outcome-affecting history caches on every
        // peer at the agreed tick; restoring peers do this inside apply.
        host.eval('snapFlushHistoryCaches()');
        peer.scratch.state=host.eval('JSON.stringify(buildHostAuthoritativeStateSnapshot({includeConfig:true,includeStaticMapState:true,includeGridTypes:true}))');
        peer.eval('applyAuthoritativeStateSnapshot(JSON.parse(__scratch.state)); isMultiplayer=true; gameStarted=true;');
    };
    restore();
    peer.scratch.Worker=Worker;
    peer.eval('Worker=__scratch.Worker; navigator.hardwareConcurrency=16; simParallelInit("",7);');
    try {
        for(let tick=0;tick<30;tick++) {
            if(tick===15) restore();
            for(const inst of [host,peer]) inst.eval('gameTick()');
            const ph=peer.eval('computeLockstepStateHashFast(gameTime)'),hh=host.eval('computeLockstepStateHashFast(gameTime)');
            if(ph!==hh) {
                const expr='JSON.stringify(units.map(u=>Object.fromEntries(simUnitStateKeys(u).filter(k=>!SNAP_SKIP_KEYS.has(k)&&(u[k]===null||["number","string","boolean"].includes(typeof u[k]))).map(k=>[k,u[k]]))))';
                const a=JSON.parse(host.eval(expr)), b=new Map(JSON.parse(peer.eval(expr)).map(u=>[u.id,u]));
                console.error(a.flatMap(u=>Object.keys(u).filter(k=>u[k]!==b.get(u.id)?.[k]).map(k=>[u.id,k,u[k],b.get(u.id)?.[k]])).slice(0,12));
                console.error([host,peer].map(i=>i.eval('JSON.stringify((()=>{const p={};computeLockstepStateHashFast(gameTime,p);return p})())')));
            }
            assert.equal(ph,hh, 'lockstep tick '+tick);
            assert.equal(peer.eval('__exactStateHash()'),host.eval('__exactStateHash()'), 'exact tick '+tick);
            await new Promise(resolve=>setImmediate(resolve));
        }
        for(const inst of [host,peer]) assert.deepEqual(inst.errors.map(String),[]);
        console.log('PASS: 4,200 active units: 0 vs 7 real helpers agree every tick, including a mid-run snapshot restore.');
    } finally { await Promise.all(workers.map(w=>w.terminate())); }
})().catch(e=>{console.error(e);process.exitCode=1;});
