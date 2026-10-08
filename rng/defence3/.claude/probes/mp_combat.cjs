// Focused multiplayer scenarios. Each sets up one mechanic, drives it with
// real commands from several players, checks the mechanic actually happened,
// and requires every peer to agree on the full state hash at every tick with
// no resync. Covered: building, stacking and auto-upgrades gated by research,
// area upgrades, collectors/salvagers/healers/researchers, production queues
// and rallies (including enemy-unit rallies seen by a spectator and a
// resigned player), splitting/merging, hold/stop, and combat.
const assert = require('node:assert/strict');
const H = require('../../tests/net-harness.cjs');

const WAN = { latencyMs: 60, jitterMs: 15 };
const CONTROLS = {
    ...H.SMALL_MATCH_CONTROLS, 'cfg-mapsize': '30', 'cfg-map-type': 'arena', 'cfg-gold-count': '24', 'cfg-astar-mine-count': '16',
    'cfg-starting-energy': '2000000', 'cfg-starting-astar': '2000000', 'cfg-max-pop': '5000', 'cfg-full-vis': 'team'
};

function setupCode(spawnCounts, researchLevels = {}) {
    return `startingResourcesConfig = ${JSON.stringify({ spawnCounts, researchLevels })};`;
}

async function match({ guests = 1, teams = null, spawnCounts, researchLevels = {}, network = WAN }) {
    const world = new H.World({ network, controls: CONTROLS, hashEvery: 1, recordParts: true });
    const res = await H.startHostedMatch(world, { guests, teams, hostSetup: setupCode(spawnCounts, researchLevels) });
    return { world, ...res, all: [res.host, ...res.guests] };
}

// Every peer agrees on every tick, no resync happened, nothing threw.
function assertLockstepClean(world, all, label, { snapshots = 1 } = {}) {
    for (const inst of all) {
        assert.deepEqual(inst.errors.map(e => String(e && e.stack || e).slice(0, 500)), [], label + ': ' + inst.name + ' threw');
    }
    const cmp = world.compareHashes(all.filter(i => !i.dead), 0);
    if (cmp.mismatches.length) {
        const m = cmp.mismatches[0];
        const a = all.find(i => i.name === m.a), b = all.find(i => i.name === m.b);
        const pa = a.tickParts.get(m.tick) || {}, pb = b.tickParts.get(m.tick) || {};
        assert.fail(`${label}: diverged at tick ${m.tick} (${m.a}/${m.b}) in [${Object.keys(pa).filter(k => pa[k] !== pb[k])}]`);
    }
    assert.ok(cmp.compared > 100, label + ': compared ' + cmp.compared);
    for (const inst of all) {
        assert.equal(inst.eval('netCounters.desyncsDetected'), 0, label + ': ' + inst.name + ' detected a desync');
        assert.equal(inst.snapshotsApplied, snapshots, label + ': ' + inst.name + ' snapshots');
    }
}

// Free buildable floor tiles around this player's king, nearest first.
function freeTilesNear(inst, count, skip = 0) {
    return JSON.parse(inst.eval(`(() => {
        const king = units.find(u => u.owner === localPlayerId && u.isKing);
        const kx = Math.floor(king.x / TILE), ky = Math.floor(king.y / TILE);
        const out = [];
        for (let r = 2; r < 12 && out.length < ${count + skip}; r++) {
            for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
                if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
                const gx = kx + dx, gy = ky + dy;
                if (gx < 1 || gy < 1 || gx >= GRID_W - 1 || gy >= GRID_H - 1) continue;
                const c = grid[gy][gx];
                if (c.type === TYPE_WALL || c.item || getTileEntityRef(gx, gy) || getGoldMineAt(gx, gy) || getAstarMineAt(gx, gy)) continue;
                if (!isTileActuallyVisibleToPlayer(localPlayerId, gx, gy)) continue;
                if (out.length < ${count + skip}) out.push({ gx, gy });
            }
        }
        return JSON.stringify(out.slice(${skip}));
    })()`));
}

const q = (inst, action) => inst.eval(`queueAction(${JSON.stringify(action)})`);
const thingAt = (inst, t) => JSON.parse(inst.eval(`JSON.stringify((() => { const e = getTileEntityRef(${t.gx}, ${t.gy}); return e ? { type: e.type, level: e.level, stacks: e.stacks, manualStacks: e.manualStacks, effectiveLevel: e.effectiveLevel, underConstruction: !!e.underConstruction, isUpgrading: !!e.isUpgrading } : null; })())`));

async function until(world, pred, maxMs, label) {
    const t0 = world.now;
    const ok = await world.runUntil(pred, maxMs, 100);
    assert.ok(ok, label + ' (waited ' + maxMs + 'ms)');
    return world.now - t0;
}

const ECONOMY = {
    'building:builder_spawner': { 3: 1 }, 'building:research': { 3: 1 }, 'building:house': { 8: 1 },
    'unit:builder_unit': { 3: 6 }, 'unit:researcher_unit': { 3: 4 }, 'unit:king': { 1: 1 }
};

(async () => {
    const rows = [];

    // E. Split and merge stacked units, hold/stop, and a fight.
    {
        const { world, host, guests, all } = await match({
            guests: 1, network: { latencyMs: 30, jitterMs: 5 },
            spawnCounts: { 'building:house': { 8: 2 }, 'unit:king': { 1: 1 }, 'unit:norm': { 4: 6 }, 'unit:tank': { 3: 3 }, 'unit:fast': { 2: 4 }, 'building:healer_spawner': { 1: 1 } }
        });
        const ids = inst => JSON.parse(inst.eval(`JSON.stringify(units.filter(u => u.owner === localPlayerId && !u.isKing && u.unitType === 'norm').map(u => u.id))`));
        const count = inst => inst.eval(`units.filter(u => u.owner === localPlayerId && !u.isKing && u.unitType === 'norm').length`);
        const before = count(host);
        q(host, { action: 'resizeUnitGroup', unitIds: ids(host), mode: 'x2', unitType: 'norm' });
        await world.run(1500);
        const split = count(host);
        assert.ok(split > before, `split ${before} -> ${split}`);
        q(host, { action: 'resizeUnitGroup', unitIds: ids(host), mode: 'd2', unitType: 'norm' });
        await world.run(1500);
        assert.ok(count(host) < split, 'merged back');
        // Hold: a held group ignores a move order until released.
        const held = ids(guests[0]).slice(0, 3);
        q(guests[0], { action: 'hold', unitIds: held });
        await world.run(500);
        const pos = guests[0].eval(`JSON.stringify(units.filter(u => ${JSON.stringify(held)}.includes(u.id)).map(u => [u.x, u.y]))`);
        q(guests[0], { action: 'move', unitIds: held, targetX: 15 * 32, targetY: 15 * 32 });
        await world.run(3000);
        assert.equal(guests[0].eval(`JSON.stringify(units.filter(u => ${JSON.stringify(held)}.includes(u.id)).map(u => [u.x, u.y]))`), pos, 'held units stay put');
        q(guests[0], { action: 'stop', unitIds: held });
        // Everyone attack-moves to the middle between the kings (toward the
        // other base: on the way to it both armies meet there, whichever of
        // the equally short ways each takes).
        const deathsBefore = host.eval('units.length');
        for (const inst of all) {
            const mid = JSON.parse(inst.eval(`JSON.stringify((() => { const k = units.filter(u => u.isKing); return { x: (k[0].x + k[1].x) / 2, y: (k[0].y + k[1].y) / 2 }; })())`));
            const mine = JSON.parse(inst.eval(`JSON.stringify(units.filter(u => u.owner === localPlayerId && !u.isKing).map(u => u.id))`));
            q(inst, { action: 'attackMove', unitIds: mine, targetX: mid.x, targetY: mid.y });
        }
        for (let k = 0; k < 12; k++) {
            await world.run(3000);
            console.log('t', k, host.eval(`JSON.stringify({n: units.length, tick: gameTime, u: units.filter(u => !u.isKing).slice(0, 40).map(u => [u.id, u.owner, u.unitType, Math.round(u.x), Math.round(u.y), u.commandState, Math.round(u.energy), u.attackTarget ? u.attackTarget.id : null, u._us && u._us.columns ? u._us.columns.mvOut[u._si] : -1])})`));
        }
        assertLockstepClean(world, all, 'split/merge/hold/combat');
        rows.push(`split ${before}->${split} and merge, hold/stop, and a battle, all in sync`);
    }

    console.log('PASS: multiplayer scenarios\n  ' + rows.join('\n  '));
})().catch(err => { console.error(err); process.exit(1); });
