'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../src/utils/utils_networking.js'), 'utf8');
function setup(worker) {
    const timers = [], overlay = {style:{}}, text = {};
    const c = vm.createContext({gameStarted:true, gameOver:false, gameTime:0, currentTick:0, MATCH_START_LOADING_STEPS:4, _matchLoadGen:1,
        _simClient:worker ? {active:true, epoch:1, appliedTick:-1, startTick:0} : null,
        ready:true, simClientWorldReady:()=>c.ready,
        ensureMatchLoadOverlayElement:()=>overlay, document:{getElementById:()=>text},
        _updateMatchLoadOverlayPlayers(){}, setTimeout:fn=>timers.push(fn)});
    vm.runInContext(source.slice(source.indexOf('function setMatchLoadOverlay('), source.indexOf('// Host: its own row')), c);
    vm.runInContext(source.slice(source.indexOf('let _matchFirstTickWait ='), source.indexOf('// ============================================================', source.indexOf('let _matchFirstTickWait ='))), c);
    return {c, timers, overlay};
}
for (const worker of [false, true]) {
    const {c,timers,overlay} = setup(worker);
    // Multiplayer countdown ending and solo startup use the same close path.
    c.setMatchLoadOverlay(false);
    assert.equal(overlay.style.display, 'flex');
    timers.shift()();
    assert.equal(overlay.style.display, 'flex', 'dispatching is not completion');
    if (worker) c._simClient.appliedTick = 0; else {c.gameTime = 1; c.currentTick = 1;}
    timers.shift()();
    assert.equal(overlay.style.display, 'flex', 'lazy startup work spans multiple ticks');
    if (worker) c._simClient.appliedTick = 3; else {c.gameTime = 4; c.currentTick = 4;}
    timers.shift()();
    assert.equal(overlay.style.display, 'none', 'first completed tick releases loading');
    assert.equal(timers.length, 0);
}
{
    const {c,timers,overlay} = setup(true);
    c.ready = false;
    c.setMatchLoadOverlay(false);
    c._matchLoadGen++;
    overlay.style.display = 'new-match';
    timers.shift()();
    assert.equal(overlay.style.display, 'new-match', 'old wait cannot close a new match overlay');
}
{
    const {c,timers,overlay} = setup(false);
    c.gameStarted = false;
    c.setMatchLoadOverlay(false);
    assert.equal(overlay.style.display, 'none');
    assert.equal(timers.length, 0);
}
console.log('PASS: worker/page first-tick loading, countdown close, cancellation and menu exit');
