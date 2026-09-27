// A negative stockpile scales a player's stats. Its multiplier changes on every
// upkeep payment (once a second), and each change used to rebuild the player's
// whole stat table: ~20 ms, a visible hitch every second. The incremental
// rebuild must leave exactly what a full rebuild produces, for any stockpile
// value and with research applied, and stay cheap.
const assert = require('node:assert/strict');
const H = require('./net-harness.cjs');

(async () => {
    const world = new H.World({ seed: 5 });
    const { host } = await H.startHostedMatch(world, { guests: 1, controls: H.SMALL_MATCH_CONTROLS });
    const result = JSON.parse(host.eval(`(() => {
        const pid = localPlayerId;
        const p = players[pid];
        // Research on a scaled stat, an exempt stat and a building stat.
        p.researchLevels = p.researchLevels || {};
        p.researchLevels[makeResearchLevelId('unit', 'norm', 'atk')] = 3;
        p.researchLevels[makeResearchLevelId('unit', 'fast', 'energy')] = 2;
        p.researchLevels[makeResearchLevelId('building', 'pistol', 'damage')] = 4;
        rebuildPrecomputedStatsMapPlayer(pid);
        const out = { checked: 0, mismatches: [], incrementalMs: 0, fullMs: 0 };
        const max = Math.max(1, Number(p.resourceMaxValues.energy) || 1);
        for (const value of [-1, -0.3 * max, -1.7 * max, -4.2 * max, 250, -0.9 * max]) {
            _setPlayerResourceValue(pid, 'energy', value);
            let t = performance.now();
            flushPendingResourceStatRebuilds();
            out.incrementalMs = Math.max(out.incrementalMs, performance.now() - t);
            const incremental = JSON.stringify(PRECOMPUTED_STATS_MAP_PLAYER[pid]);
            t = performance.now();
            rebuildPrecomputedStatsMapPlayer(pid);
            out.fullMs = Math.max(out.fullMs, performance.now() - t);
            const full = JSON.stringify(PRECOMPUTED_STATS_MAP_PLAYER[pid]);
            out.checked++;
            if (incremental !== full) out.mismatches.push(value);
        }
        out.multiplier = PLAYER_RESOURCE_STAT_MULTIPLIERS[pid].energy;
        return JSON.stringify(out);
    })()`));
    assert.equal(result.checked, 6);
    assert.deepEqual(result.mismatches, [], 'incremental penalty rebuild equals a full rebuild');
    assert.ok(result.multiplier > 1, 'the last value is penalised');
    console.log(`PASS: resource penalty rebuild matches a full stat rebuild at ${result.checked} stockpile values (worst ${result.incrementalMs.toFixed(2)} ms vs full ${result.fullMs.toFixed(2)} ms).`);
    process.exit(0);
})().catch(err => { console.error(err); process.exit(1); });
