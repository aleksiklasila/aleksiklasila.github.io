// A research queue's move, removal or insertion remakes only the touched
// stats' tasks (rebasePlayerResearchQueueState(playerId, only)): after any
// mix of them, and of completions on the way, the queue equals what a full
// rebase of it gives (every task's level, cost, work and progress).
const assert = require('node:assert/strict');
const H = require('./net-harness.cjs');

const world = new H.World({ seed: 9 });
const solo = world.spawn('solo', { simWorker: false });
solo.eval('startSoloGame();');
const read = expr => JSON.parse(solo.eval('JSON.stringify(' + expr + ')'));
solo.eval('for (let i = 0; i < 3; i++) runOneTick();');
const labs = read(`(() => {
    MAX_RESEARCH_LEVEL = 30;
    const free = (gx, gy) => { const c = grid[gy][gx]; return c.type === TYPE_FLOOR && !c.item && !getTileEntityRef(gx, gy) && !getGoldMineAt(gx, gy); };
    let n = 0;
    for (let gy = 4; gy < GRID_H - 4 && n < 20; gy += 2) for (let gx = 4; gx < GRID_W - 4 && n < 20; gx += 2) {
        if (!free(gx, gy) || !placeBuilding(gx, gy, 'research', 0, { ignorePlacementRules: true, silent: true, autoUpgradeEnabled: false, buildEnabled: true })) continue;
        const e = getTileEntityRef(gx, gy) || grid[gy][gx].item; e.underConstruction = false; n++;
        __scratch.lab = e;
    }
    return n;
})()`);
assert.ok(labs >= 10, 'labs ' + labs);

// Deterministic pseudo-random operations.
let seed = 12345;
const rnd = n => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return seed % n; };
const stats = read(`(() => {
    const out = [];
    for (const key of Object.keys(PRECOMPUTED_STATS_MAP.unit).slice(0, 4)) for (const statKey of ['attackDamage', 'maxEnergy']) if (getResearchStatEntry('unit', key, statKey)) out.push(['unit', key, statKey]);
    for (const key of Object.keys(PRECOMPUTED_STATS_MAP.building).slice(0, 4)) for (const statKey of ['maxEnergy', 'damage']) if (getResearchStatEntry('building', key, statKey)) out.push(['building', key, statKey]);
    return out;
})()`);
assert.ok(stats.length >= 8, 'stats ' + stats.length);
const lab = read('[__scratch.lab.gx, __scratch.lab.gy]');
const queueJson = `JSON.stringify([players[0].researchTask, players[0].researchQueue])`;
let ops = 0, mismatches = [];
const counts = {};
for (let step = 0; step < 600; step++) {
    const [kind, key, statKey] = stats[rnd(stats.length)];
    const len = read('getPlayerResearchQueueTotalLength(0)');
    let a;
    switch (rnd(len < 40 ? 3 : 7)) {
        case 0: a = { action: 'queueResearch', gx: lab[0], gy: lab[1], kind, key, statKey, count: 1 + rnd(4) }; break;
        case 1: a = { action: 'queueResearch', gx: lab[0], gy: lab[1], kind, key, statKey, count: 1 + rnd(3), insertAt: rnd(len + 1) }; break;
        case 2: a = { action: 'moveResearch', from: rnd(len + 1), to: rnd(len + 1) }; break;
        case 3: a = { action: 'reorderResearch', gx: lab[0], gy: lab[1], fromIndex: rnd(len) - 1, toIndex: rnd(len) - 1, fromActive: rnd(6) === 0, toActive: rnd(6) === 0 }; break;
        case 4: a = { action: 'dequeueResearch', gx: lab[0], gy: lab[1], kind, key, statKey, count: 1 + rnd(3) }; break;
        case 5: a = { action: 'dequeueResearch', gx: lab[0], gy: lab[1], count: 1 + rnd(3) }; break;
        default: a = { action: 'moveResearch', from: 0, to: rnd(len + 1) }; break;
    }
    counts[a.action + (a.insertAt !== undefined ? ':insertAt' : '')] = (counts[a.action + (a.insertAt !== undefined ? ':insertAt' : '')] || 0) + 1;
    solo.eval(`_processRawAction(${JSON.stringify(a)}, 0);`);
    ops++;
    // Research done on the way (completions shift the levels; some progress
    // kept with its level).
    if (rnd(4) === 0) solo.eval(`{ const p = players[0]; if (p.researchTask) { p.researchTask.workDone = p.researchTask.workRequired; completeActiveResearchTaskForPlayer(0, p.researchTask); } if (p.researchTask) p.researchTask.workDone = Math.floor((Number(p.researchTask.workRequired) || 0) / 2); runOneTick(); }`);
    const r = read(`(() => { const before = ${queueJson}; rebasePlayerResearchQueueState(0); const after = ${queueJson}; return before === after ? null : [before.slice(0, 400), after.slice(0, 400)]; })()`);
    if (r) mismatches.push([step, a, r]);
}
assert.deepEqual(mismatches.slice(0, 2), [], 'the partial rebase differs from a full one');
assert.deepEqual(solo.errors, []);
const done = read('Object.values(players[0].researchLevels || {}).reduce((s, v) => s + (Number(v) || 0), 0)');
console.log(`PASS: ${ops} queue operations (${JSON.stringify(counts)}), ${done} levels researched: the partial rebase equals a full one after each`);
process.exit(0);
