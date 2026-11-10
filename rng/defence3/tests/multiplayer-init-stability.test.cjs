'use strict';
const assert = require('node:assert/strict');
const H = require('./net-harness.cjs');
(async () => {
    for (const simWorker of [false,true]) {
        const world = new H.World({network:{latencyMs:50,jitterMs:10},controls:H.SMALL_MATCH_CONTROLS,simWorker});
        const {host,guests} = await H.startHostedMatch(world,{guests:1,waitForInitialization:false});
        const all=[host,...guests], guest=guests[0];
        for(const p of all)p.evalSim('checkWinCondition = function () {};');
        // Simulate a startup job that is not settled yet. Input packets
        // continue arriving, but a completed tick is required for progress.
        guest.eval('__scratch.settled = matchInitializationWorkSettled; matchInitializationWorkSettled = () => false;');
        await world.run(1500);
        assert.ok(all.every(p=>p.eval('matchInitializationBlocksInput()')), 'unfinished guest keeps loading visible everywhere');
        assert.equal(host.eval('netStepTicks()'),1,'no delta ticks during initialization');
        guest.eval('matchInitializationWorkSettled = __scratch.settled');
        assert.ok(await world.runUntil(()=>all.every(p=>p.eval('_matchInit.released && !matchInitializationBlocksInput()')),30000),'all peers released');
        assert.equal(host.eval('_matchInit.releaseTick'),guest.eval('_matchInit.releaseTick'),'same release boundary');
        const from=host.eval('currentTick')+2;
        await H.playFor(world,all,3000,{seed:71});
        await world.run(500);
        H.checkHealthy(world,all,{minCompared:10,fromTick:from,label:'initialization'});
        console.log('PASS lockstep initialization, slow peer, release and gameplay hashes; worker='+simWorker);
    }
    process.exit(0);
})().catch(e=>{console.error(e);process.exit(1)});
