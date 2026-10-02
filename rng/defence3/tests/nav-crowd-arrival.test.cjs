'use strict';
const assert = require('node:assert/strict');
const H = require('./net-harness.cjs');
const world = new H.World({ controls: H.SMALL_MATCH_CONTROLS });
const inst = world.spawn('arrival', { simWorker: false });
inst.eval('startSoloGame();');
// Isolate arrival from map topology: navigation is still preparing a
// route. A slow tick must not turn that wait into successful arrival.
inst.eval('_navFlowLook = () => -1;');
for (const cmd of [1, 2]) {
    const r = JSON.parse(inst.eval(`JSON.stringify((() => {
        const u = new Unit('norm', 0, 10 * TILE + 16, 10 * TILE + 16);
        units.push(u); updateUnitSpatial(u);
        const nd = { x: 16, y: 10, nav: NAV_PROFILE_GROUND + 1, w: 1, ready: 0 };
        u.path = [nd]; u.pathIndex = 0; u.commandState = ${cmd};
        u._navLastD = 6 * TILE;
        u._us.cwTick[u._si] = gameTime; u._us.cwNear[u._si] = 0;
        const arrivedAlone = u._followNavNode(nd, 1);
        u.path = [nd]; u.pathIndex = 0; u._us.mvCD[u._si] = -1;
        u._navLastD = detHypot(nd.x * TILE + 16 - u.x, nd.y * TILE + 16 - u.y);
        u._us.cwNear[u._si] = 1;
        const arrivedInCrowd = u._followNavNode(nd, 1);
        return { arrivedAlone, arrivedInCrowd };
    })())`));
    assert.equal(r.arrivedAlone, false, 'slow progress alone must not finish move/attack-move');
    assert.equal(r.arrivedInCrowd, true, 'actual crowd can settle near destination');
}
assert.deepEqual(inst.errors.map(String), []);
console.log('PASS: move and attack-move require a friendly crowd before arriving short.');
