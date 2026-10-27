'use strict';
const assert = require('node:assert/strict'), H = require('./net-harness.cjs');
const world = new H.World({ controls: H.SMALL_MATCH_CONTROLS });
const inst = world.spawn('stat-rebuild-snapshot', { simWorker: false });
for (const mode of ['owner', 'all', 'thing']) {
const result = inst.eval(`(() => {
    startSoloGame();
    const u = new Unit('norm', 0, 12 * TILE, 12 * TILE);
    units.push(u); unitSlotMapPushed(u); updateUnitSpatial(u);
    const read = () => ({ speed: u.preComputed.speed, native: _effHot[u._us.statRow[u._si] * EFF_HOT_WIDTH] });
    const before = read();
    const levels = ensurePlayerResearchLevels(0), key = makeResearchLevelId('unit', 'norm', 'speed');
    levels[key] = Math.min(MAX_RESEARCH_LEVEL, (levels[key] || 0) + 3);
    if (${JSON.stringify(mode)} === 'thing') rebuildPrecomputedStatsMapPlayerThingStat(0, 'unit', 'norm');
    else rebuildPrecomputedStatsMapPlayer(${mode === 'all' ? 'null' : '0'});
    const rebuilt = read(), id = u.id;
    snapFlushHistoryCaches();
    const flushed = read();
    const S = JSON.parse(JSON.stringify(snapEncodeState()));
    snapDecodeState(S);
    const restoredUnit = units.find(v => v.id === id);
    const restored = { speed: restoredUnit.preComputed.speed, native: _effHot[restoredUnit._us.statRow[restoredUnit._si] * EFF_HOT_WIDTH] };
    return { before, rebuilt, flushed, restored };
})()`);
assert.notEqual(result.rebuilt.speed, result.before.speed, 'research changed speed');
assert.equal(result.rebuilt.native, result.rebuilt.speed, 'bulk rebuild publishes native speed with its JS stat');
assert.deepEqual(result.flushed, result.rebuilt, 'flushing does not change stats');
assert.deepEqual(result.restored, result.flushed, 'restoring cannot change movement speed');
assert.deepEqual(inst.errors.map(String), []);
console.log('PASS: ' + mode + ' stat rebuild publishes native rows and survives snapshot restore', result);
}
