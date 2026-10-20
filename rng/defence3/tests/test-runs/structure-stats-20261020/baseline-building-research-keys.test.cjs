// A building research reaches only its own key's buildings
// (data_dynamic.js buildingResearchSweep: players[o].bResKey and
// bResMaxKey). After one sweep rotation (TICK_RATE ticks) every building's
// stats equal a full refresh from the tables (barracks and spawners, cell
// items too, by their own lists only), and the sweep refreshed no
// building whose key had no research since its last turn.
const assert = require('node:assert/strict');
const H = require('./net-harness.cjs');

const world = new H.World({ seed: 11 });
const solo = world.spawn('solo', { simWorker: false });
solo.eval('startSoloGame();');
const read = expr => JSON.parse(solo.eval('JSON.stringify(' + expr + ')'));
const tick = n => solo.eval('for (let i = 0; i < ' + n + '; i++) runOneTick();');
tick(3);

// Towers, barracks, worker buildings and floor items of player 0, built.
const placed = read(`(() => {
    const keys = [...BUILD_CATEGORIES.towers, ...BUILD_CATEGORIES.barracks, 'research', 'builder_spawner', 'salvager', 'lava', 'poison_puddle', 'ice_patch', 'house', 'farm']
        .filter(k => BASE_CARD_TYPES[k] && k !== 'watch_tower');
    const free = (gx, gy) => { const c = grid[gy][gx]; return c.type === TYPE_FLOOR && !c.item && !getTileEntityRef(gx, gy) && !getGoldMineAt(gx, gy); };
    let n = 0, i = 0;
    for (let gy = 4; gy < GRID_H - 4 && n < keys.length * 3; gy += 3) for (let gx = 4; gx < GRID_W - 4 && n < keys.length * 3; gx += 3) {
        if (!free(gx, gy)) continue;
        const key = keys[i++ % keys.length];
        if (!placeBuilding(gx, gy, key, 0, { ignorePlacementRules: true, silent: true, autoUpgradeEnabled: false, buildEnabled: true })) continue;
        const e = getTileEntityRef(gx, gy) || grid[gy][gx].item;
        if (!e) continue;
        e.underConstruction = false; e.isUpgrading = false; e.level = e.effectiveLevel = 3; e.stacks = e.effectiveStacks = getRequiredStacksForLevel(3);
        n++;
    }
    return n;
})()`);
assert.ok(placed > 30, 'placed ' + placed);

// Each building's stats as the tables give them (kind as the sweep's).
solo.eval(`
__scratch.bk = () => {
    const out = [];
    for (const t of towers) if (t && t.owner === 0) out.push([t, 0, t.type]);
    for (const b of barracks) if (b && b.owner === 0) out.push([b, 1, 'barrack_' + b.unitType]);
    for (const s of collectorSpawners) if (s && s.owner === 0) out.push([s, 1, s.type]);
    for (const it of getCellItemsRowMajor()) { const c = grid[it.gy][it.gx]; if (c && c.item === it && c.owner === 0 && !_isProducerStructure(it)) out.push([it, 2, it.type]); }
    return out;
};
__scratch.stats = (e, kind) => JSON.stringify(kind === 0 ? [e.currentStats, e.maxEnergy] : kind === 1 ? [e.preComputedEffective, e.preComputedBase, e.maxEnergy] : [e.maxEnergy, e.damage]);
__scratch.applied = [];
const real = _buildingResearchApply;
_buildingResearchApply = function (e, statKey, kind) { __scratch.applied.push(e); return real(e, statKey, kind); };
`);
// Everything current first (a full rotation of the sweep after a research
// of each key), then research one key at a time.
const keysOf = read(`[...new Set(__scratch.bk().map(r => _normalizePlayerPrecomputedBuildingKey(r[2])))]`);
assert.ok(keysOf.length >= 8, 'keys ' + keysOf.join());
for (const k of keysOf) solo.eval(`applyResearchCompletion(0, { kind: 'building', key: ${JSON.stringify(k)}, statKey: 'maxEnergy' });`);
tick(read('TICK_RATE') + 1);

const statsByKey = keysOf.map(k => [k, read(`PRECOMPUTED_BUILDING_STAT_KEYS.filter(s => _buildingStatHasValues(${JSON.stringify(k)}, s))`)]);
let rounds = 0, refreshed = 0, skipped = 0;
for (const [k, stats] of statsByKey) {
    for (const statKey of [...stats.slice(0, 3), 'maxLevel']) {
        solo.eval('__scratch.applied.length = 0; __scratch.v0 = players[0].bResVer;');
        solo.eval(`applyResearchCompletion(0, { kind: 'building', key: ${JSON.stringify(k)}, statKey: ${JSON.stringify(statKey)} });`);
        tick(read('TICK_RATE'));
        // Only buildings of the key were refreshed (or of a key the players' own
        // research labs finished meanwhile), and every building
        // holds what a refresh from the tables gives.
        const r = read(`(() => {
            const all = __scratch.bk(), want = ${JSON.stringify(k)};
            __scratch.wrong = __scratch.applied.filter(e => { const row = all.find(r => r[0] === e); if (!row) return false; const rk = _normalizePlayerPrecomputedBuildingKey(row[2]); return rk !== want && (players[0].bResKey[rk] | 0) <= __scratch.v0; }); const wrongKey = __scratch.wrong.length;
            const ofKey = all.filter(r => _normalizePlayerPrecomputedBuildingKey(r[2]) === want).length;
            const stale = [];
            for (const [e, kind, raw] of all) {
                const before = __scratch.stats(e, kind);
                const energy = e.energy;
                _buildingResearchApply(e, '', kind);
                if (__scratch.stats(e, kind) !== before) stale.push(raw + '@' + e.gx + ',' + e.gy);
                e.energy = energy;
            }
            return { wrongKey, ofKey, applied: __scratch.applied.length - all.length, stale, behind: all.filter(r => (r[0]._bResVer | 0) !== players[0].bResVer).length };
        })()`);
        assert.equal(r.wrongKey, 0, `${k}.${statKey}: refreshed buildings of other keys: ` + read('__scratch.wrong.slice(0, 4).map(e => [e.type, e.unitType, e.constructor.name, e._bResVer, towers.includes(e), barracks.includes(e), collectorSpawners.includes(e)])') + ' v0 ' + read('[__scratch.v0, players[0].bResVer, players[0].bResKey]'));
        assert.deepEqual(r.stale, [], `${k}.${statKey}: stale after a rotation`);
        assert.equal(r.behind, 0, `${k}.${statKey}: buildings behind the owner's version`);
        refreshed += r.ofKey; skipped += read('__scratch.bk().length') - r.ofKey;
        rounds++;
    }
}
assert.deepEqual(solo.errors, []);
console.log(`PASS: a building research refreshes only its key's buildings (${rounds} researches over ${keysOf.length} keys; ${refreshed} refreshes, ${skipped} skipped), every building equal to its tables after a rotation`);
process.exit(0);
