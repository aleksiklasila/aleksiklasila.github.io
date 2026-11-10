'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../src/utils/utils_networking.js'), 'utf8');
function setup(worker) {
    const timers = [], overlay = {style:{}}, text = {};
    const c = vm.createContext({gameStarted:true, gameOver:false, currentTick:0, _matchLoadGen:1,
        _simClient:worker ? {active:true, epoch:1, appliedTick:-1, startTick:0} : null,
        ready:true, now:0, isMultiplayer:false, netResetSimulationPace(){},
        performance:{now:()=>c.now}, simClientWorldReady:()=>c.ready,
        ensureMatchLoadOverlayElement:()=>overlay, document:{getElementById:()=>text},
        _updateMatchLoadOverlayPlayers(){}, setTimeout:fn=>timers.push(fn)});
    vm.runInContext(source.slice(source.indexOf('const MATCH_INIT_WORK_SAMPLES ='), source.indexOf('// Host: its own row')), c);
    vm.runInContext(source.slice(source.indexOf('let _matchFirstTickWait ='), source.indexOf('// ============================================================', source.indexOf('let _matchFirstTickWait ='))), c);
    c.setMatchLoadOverlay(false);
    const step = (ms, gap=ms) => {
        const t = c.currentTick;
        assert.ok(c.matchInitializationCanRunTick(t));
        c.now += gap;
        if(worker) c._simClient.appliedTick = t;
        c.matchInitializationNoteTick(c.now, ms);
        c.currentTick++;
        timers.shift()();
    };
    return {c, timers, overlay, step};
}
for (const worker of [false,true]) {
    const {c,overlay,step} = setup(worker);
    assert.equal(overlay.style.display,'flex');
    // A large declining startup tail, followed by steady but slow work.
    for (const ms of [1500,1000,800,600,400,300,200,100]) step(ms);
    assert.equal(overlay.style.display,'flex', 'fixed tick count does not release');
    for(let i=0;i<8 && c.matchInitializationBlocksInput();i++) step(100, 2000);
    assert.equal(overlay.style.display,'none','network/wall-clock gaps do not determine work readiness');
    assert.equal(c.matchInitializationBlocksInput(),false);
}
{
    const {c,timers,overlay} = setup(true);
    c._matchLoadGen++;
    overlay.style.display='new-match';
    timers.shift()();
    assert.equal(overlay.style.display,'new-match');
}
{
    const {c} = setup(true);
    c.matchInitializationReset();
    c._simClient.appliedTick = 0;
    c.matchInitializationNoteTick(100, 80);
    c.currentTick = 1;
    c.setMatchLoadOverlay(false);
    assert.equal(c.matchInitializationCanRunTick(1), true, 'completion before ALL_READY is retained');
}
{
    const {c,step} = setup(false);
    c.isMultiplayer=true; c.isHost=true; c.myPeerId='host'; c.matchStartSessionId='match';
    c.getActiveMatchPeerIds=()=>['host','guest'];
    const sent=[]; const conn={peer:'guest',send:m=>sent.push(m)}; c.connections=[conn];
    for(let t=0;t<8;t++) {
        step(100);
        assert.equal(c.matchInitializationCanRunTick(t+1),false,'host waits for completion, not input sent ahead');
        c._matchInitializationMessage(conn,{type:'START_SIM_STATUS',startSessionId:'old',tick:t,ready:true});
        c._matchInitializationPoll(c.now);
        assert.equal(c.matchInitializationCanRunTick(t+1),false,'old session cannot advance');
        c._matchInitializationMessage(conn,{type:'START_SIM_STATUS',startSessionId:'match',tick:t,ready:t===7});
        c._matchInitializationPoll(c.now);
        assert.equal(c.matchInitializationCanRunTick(t+1),true);
    }
    assert.equal(sent.length,1);
    assert.equal(sent[0].tick,8);
    c._matchInitializationMessage(conn,{type:'START_SIM_STATUS',startSessionId:'match',tick:7,ready:true});
    assert.equal(sent.length,2,'retry repairs lost release');
}
{
    const {c,step} = setup(false);
    const worker = fs.readFileSync(require('node:path').join(__dirname,'../src/things/worker.js'),'utf8');
    c.localDefeated=false;
    let calls=0; c._queueLocalAction=()=>++calls;
    vm.runInContext(worker.slice(worker.indexOf('function queueAction(action)'),worker.indexOf("// The host's administrative commands")),c);
    c.queueAction({action:'move'}); assert.equal(calls,0);
    for(let i=0;i<8;i++)step(10);
    c.queueAction({action:'move'}); assert.equal(calls,1);
}
console.log('PASS loading work convergence, worker/page completion, per-tick barrier, stale session, release retry and input gate');
