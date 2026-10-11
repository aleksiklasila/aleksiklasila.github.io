const assert = require('node:assert/strict');
const H = require('./net-harness.cjs');

(async () => {
    const world = new H.World({ simWorker: true, controls: H.SMALL_MATCH_CONTROLS });
    const { host, guests } = await H.startHostedMatch(world, {
        guests: 1,
        hostSetup: `
            document.getElementById('cfg-mine-density').value = '35';
            document.getElementById('cfg-gold-abundance').value = '1000000';
            document.getElementById('cfg-astar-abundance').value = '8000000';
            refreshResourceAbundanceMenu(true);
        `
    });
    for (const peer of [host, ...guests]) {
        assert.equal(peer.eval('RESOURCE_MINE_DENSITY'), 35, 'host density reaches every page');
        assert.equal(peer.evalSim('RESOURCE_MINE_DENSITY'), 35, 'density reaches simulation workers');
        assert.equal(peer.evalSim('GOLD_MINE_COUNT + ASTAR_MINE_COUNT'), 140);
        assert.equal(peer.evalSim('GOLD_MINE_MIN'), 1e6);
        assert.equal(peer.evalSim('ASTAR_MINE_MIN'), 8e6);
        assert.equal(peer.eval("document.getElementById('cfg-mine-density').value"), '35');
        assert.deepEqual(peer.errors, []);
    }
    assert.equal(host.eval('buildRuntimeConfigHashForSnapshot()'), guests[0].eval('buildRuntimeConfigHashForSnapshot()'));
    console.log('PASS: mine density, reserve tiers and config hashes agree across host, guest and simulation workers.');
})().catch(error => { console.error(error); process.exitCode = 1; });
