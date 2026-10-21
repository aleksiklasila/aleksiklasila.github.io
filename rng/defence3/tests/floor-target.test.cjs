// Units treat hostile floor items like turrets: attack-moving units and
// idle units near them attack them (and destroy them) instead of walking
// over them unharmed-but-dying.
//   node tests/floor-target.test.cjs [dk]
'use strict';
const assert = require('node:assert/strict');
const H = require('./net-harness.cjs');
const dk = Number(process.argv[2] || 1);
const world = new H.World({ controls: { ...H.SMALL_MATCH_CONTROLS, 'cfg-mapsize': '80', 'cfg-map-type': 'arena', 'cfg-full-vis': 'full' } });
const inst = world.spawn('floor', { simWorker: false });
inst.eval('startSoloGame();');
const r = JSON.parse(inst.eval(`JSON.stringify((() => {
    for (const u of units) if (!u.isKing) u.dead = true;
    gameTick(); currentTick++;
    // Enemy traps (owner 1): a column of lava and one of poison at x 40..41.
    const traps = [];
    for (let y = 30; y < 50; y++) for (const [x, type] of [[40, 'lava'], [41, 'poison_puddle']]) {
        placeBuilding(x, y, type, 1, { silent: true, ignorePlacementRules: true });
        const it = grid[y][x].item; if (it) { it.energy = it.maxEnergy; markConstructionComplete(it); if (it.updateStats) it.updateStats(); traps.push(it); }
    }
    // Owner 0: a group attack-moving across, and idle units beside the traps.
    const spawn = (x, y) => { const u = new Unit('norm', 0, x * TILE + 16, y * TILE + 16); units.push(u); players[0].popCount++; updateUnitSpatial(u); return u; };
    const movers = []; for (let i = 0; i < 40; i++) movers.push(spawn(28 + (i % 4), 32 + Math.floor(i / 4) * 1.5));
    const idle = []; for (let i = 0; i < 6; i++) idle.push(spawn(39, 34 + i * 2));
    simDk = ${dk};
    processAction(sanitizeAction({ action: 'attackMove', unitIds: movers.map(u => u.id), targetX: 60 * TILE, targetY: 40 * TILE }), 0);
    const e0 = traps.reduce((s, t) => s + t.energy, 0);
    let attacksOnTraps = 0, firstHitSec = -1;
    for (let t = 0; t < Math.round(30 * 20 / simDk); t++) {
        gameTick(); currentTick++;
        let on = 0; for (const u of movers.concat(idle)) if (!u.dead && u.targetBuilding && traps.includes(u.targetBuilding)) on++;
        attacksOnTraps = Math.max(attacksOnTraps, on);
        const e = traps.reduce((s, t) => s + Math.max(0, t.energy), 0);
        if (firstHitSec < 0 && e < e0) firstHitSec = (t + 1) * simDk / 20;
    }
    const left = traps.filter(t => t.energy > 0 && grid[t.gy][t.gx].item === t).length;
    return { traps: traps.length, left, attacksOnTraps, firstHitSec, energy0: e0, energy1: traps.reduce((s, t) => s + Math.max(0, t.energy), 0),
        moversAlive: movers.filter(u => !u.dead).length, idleAlive: idle.filter(u => !u.dead).length };
})())`));
console.log(JSON.stringify(r));
assert.deepEqual(inst.errors.map(String), []);
assert.ok(r.firstHitSec > 0, 'units damage hostile floor items');
assert.ok(r.left < r.traps, 'hostile floor items get destroyed');
console.log('ok');
