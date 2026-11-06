'use strict';
// setToggleMany (main.js: a selection's building flag in one command, its
// tile keys; wasm/src/ord.rs k_struct_flags): every owned building of the
// selection takes the flag, the other player's and empty tiles nothing; auto-
// upgrade off stops an upgrade; the salvage mark only where the class has one.
// Usage: node tests/toggle-many.test.cjs
const assert = require('node:assert/strict'), H = require('./net-harness.cjs'), chaos = require('./chaos-spikes-scenario.cjs');
globalThis.self = { crossOriginIsolated: true };
const controls = { ...H.SMALL_MATCH_CONTROLS, 'cfg-mapsize': '192', 'cfg-map-type': 'arena', 'cfg-gold-count': '200', 'cfg-astar-mine-count': '200', 'cfg-max-pop': '20000', 'cfg-starting-energy': '1000000000000', 'cfg-starting-astar': '1000000000000' };
const world = new H.World({ controls }), i = world.spawn('toggles', { controls, simWorker: false });
i.eval(`MAX_THING_LEVEL=20;MAX_RESEARCH_LEVEL=10;startingResourcesConfig=normalizeStartingResourcesConfig({spawnCounts:{'unit:king':{1:1},'unit:builder_unit':{10:60}},researchLevels:{}});applyMainMenuControlsToRuntimeState();startSoloGame();`);
const setup = JSON.parse(i.eval('JSON.stringify(' + chaos.setup({ mode: 'mega', layout: 'mixed', buildings: 50, level: 6, towerSites: 30, collectorBuildings: 20, structures: 4000 }) + ')'));
assert.deepEqual(setup.errors, []);
const r = JSON.parse(i.eval(`(() => {
    const all = [...towers, ...barracks, ...collectorSpawners].filter(b => b && b.energy > 0);
    const mine = all.filter(b => b.owner === 0), theirs = all.filter(b => b.owner === 1);
    const keys = [...mine, ...theirs.slice(0, 50)].map(b => b.gy * GRID_W + b.gx).concat([5, 6, 7]).sort((x, y) => x - y);
    const tkz = actionIdsEncode(keys), out = {};
    const run = (toggle, enabled) => processActions([{ action: 'setToggleMany', toggle, enabled, tkz }], 0);
    for (const [toggle, field] of [['autoUpgrade', 'autoUpgradeEnabled'], ['autoStack', 'autoStackEnabled'], ['build', 'buildEnabled']]) {
        const before = theirs.slice(0, 50).map(b => b[field]);
        run(toggle, false);
        const offMine = mine.filter(b => b[field] !== false).length;
        run(toggle, true);
        const onMine = mine.filter(b => b[field] !== true).length;
        out[toggle] = { mine: mine.length, offWrong: offMine, onWrong: onMine, theirsChanged: theirs.slice(0, 50).filter((b, k) => b[field] !== before[k]).length };
    }
    const sp = mine.filter(b => 'queueEnabled' in b);
    run('queue', false); out.queue = { n: sp.length, wrong: sp.filter(b => b.queueEnabled !== false).length }; run('queue', true);
    const up = mine.filter(b => b.isUpgrading === true).length;
    run('autoUpgrade', false); out.upgradingAfterOff = mine.filter(b => b.isUpgrading === true).length; out.upgradingBefore = up;
    return JSON.stringify(out); })()`));
for (const k of ['autoUpgrade', 'autoStack', 'build']) {
    assert.ok(r[k].mine > 0, k + ': buildings selected');
    assert.equal(r[k].offWrong, 0, k + ' off on every owned building ' + JSON.stringify(r));
    assert.equal(r[k].onWrong, 0, k + ' on on every owned building ' + JSON.stringify(r));
    assert.equal(r[k].theirsChanged, 0, k + ': the other player\'s buildings untouched');
}
assert.equal(r.queue.wrong, 0, 'queue off on every owned producer');
assert.equal(r.upgradingAfterOff, 0, 'auto-upgrade off stops upgrades');
assert.deepEqual(i.errors.map(String), []);
console.log('PASS: setToggleMany', JSON.stringify(r));
