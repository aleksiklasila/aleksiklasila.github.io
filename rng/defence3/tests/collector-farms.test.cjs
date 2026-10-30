// Collectors and farms in a match (the worker kernel, wasm/src/wai.rs: the
// state machine that was worker.js updateWorkerAI): an idle collector finds
// its owner's built farm of its resource near it, and not an enemy's, an
// unfinished one or one out of its reach; it gathers there and goes back; a
// group order to a farm sends the first collector to it and the others to
// distinct farms nearby, never another player's collector; collectors still
// find mines; both resources. The same orders give the same targets on two
// runs, one of them with the other player as the local one (sounds only).
// The Ctrl-click split of a multi-target order (main.js
// applyWorkerAssignTargets, the page's) is checked as a library at the end.
//   node tests/collector-farms.test.cjs
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const H = require('./net-harness.cjs');

function match(name, localAs = 0) {
    const world = new H.World({ controls: { ...H.SMALL_MATCH_CONTROLS, 'cfg-mapsize': '80', 'cfg-map-type': 'arena' } });
    const inst = world.spawn(name, { simWorker: false });
    inst.eval('startSoloGame(); gameTick(); currentTick++;');
    if (localAs) inst.eval('localPlayerId = ' + localAs + ';');
    // Helpers in the instance: an open block of tiles, a built structure, a collector.
    inst.eval(`
        __scratch.free = (gx, gy) => { const c = grid[gy] && grid[gy][gx]; return !!c && c.type === TYPE_FLOOR && !c.item && !getTileEntityRef(gx, gy) && !getGoldMineAt(gx, gy) && !getAstarMineAt(gx, gy); };
        __scratch.block = (w, h) => {
            for (let gy = 4; gy < GRID_H - h - 4; gy++) for (let gx = 4; gx < GRID_W - w - 4; gx++) {
                let ok = true;
                for (let y = gy - 1; y <= gy + h && ok; y++) for (let x = gx - 1; x <= gx + w && ok; x++) if (!__scratch.free(x, y)) ok = false;
                if (ok) return [gx, gy];
            }
            return null;
        };
        __scratch.place = (gx, gy, key, owner, built = true) => {
            if (!placeBuilding(gx, gy, key, owner, { ignorePlacementRules: true, silent: true })) return null;
            const e = getTileEntityRef(gx, gy);
            if (e && built) { markConstructionComplete(e); e.energy = e.maxEnergy; }
            return e;
        };
        __scratch.collector = (type, owner, gx, gy) => {
            const u = new Unit(type, owner, gx * TILE + 16, gy * TILE + 16);
            configureWorkerUnitFromType(u);
            applyUnitLevelScaling(u, 1);
            u.energy = u.maxEnergy;
            units.push(u); unitSlotMapPushed(u);
            players[owner].popCount++;
            return u;
        };
        __scratch.tick = n => { for (let i = 0; i < n; i++) { gameTick(); currentTick++; } };
        __scratch.tgt = u => { const t = u.workerTarget; return t ? [t.gx, t.gy, u.workerTargetType || ''] : null; };
    `);
    return inst;
}
const q = (inst, code) => JSON.parse(inst.eval(`JSON.stringify((() => { ${code} })())`));

for (const [res, farmKey, unitKey] of [['energy', 'farm', 'collector'], ['astar', 'astar_farm', 'astar_collector']]) {
    // Discovery: only the own, built, reachable farm.
    {
        const inst = match('farms-' + res);
        const r = q(inst, `
            const B = __scratch.block(26, 5);
            if (!B) return { err: 'no room' };
            const [x0, y0] = B, S = __scratch;
            // (The resource's mines emptied: farms are the only work here.)
            for (const m of ('${res}' === 'energy' ? goldMines : astarMines)) if (m) m['${res}' === 'energy' ? 'gold' : 'astar'] = 0;
            S.place(x0 + 3, y0 + 2, '${farmKey}', 1);            // an enemy's
            S.place(x0 + 4, y0 + 2, '${farmKey}', 0, false);     // unfinished
            S.place(x0 + 25, y0 + 2, '${farmKey}', 0);           // far
            const u = S.collector('${unitKey}', 0, x0 + 1, y0 + 2);
            S.tick(60);
            const before = S.tgt(u);
            const valid = S.place(x0 + 5, y0 + 2, '${farmKey}', 0);
            let found = null, carried = 0, states = new Set();
            for (let t = 0; t < 400; t++) {
                S.tick(1);
                states.add(u.workerState);
                const g = S.tgt(u);
                if (g && g[0] === valid.gx && g[1] === valid.gy && !found) found = t;
                carried = Math.max(carried, Number(u.carryingValue) || 0);
            }
            return { before, valid: [valid.gx, valid.gy], found, carried, states: [...states].sort() };
        `);
        assert.ok(!r.err, r.err);
        assert.equal(r.before, null, res + ': ignore enemy, unfinished and distant farms: ' + JSON.stringify(r.before));
        assert.ok(r.found !== null, res + ': discover the farm without an order: ' + JSON.stringify(r));
        assert.ok(r.carried > 0, res + ': the farm produces a load');
        assert.ok(r.states.includes('RETURNING'), res + ': goes back with it: ' + r.states);
        console.log(res, 'discovery: found at tick', r.found, 'carried', r.carried, 'states', r.states.join(','));
    }

    // Group orders, the same on two runs (the second with the other player local).
    const replay = localAs => {
        const inst = match('group-' + res + localAs, localAs);
        const r = q(inst, `
            const B = __scratch.block(12, 6);
            if (!B) return { err: 'no room' };
            const [x0, y0] = B, S = __scratch;
            const clicked = S.place(x0 + 8, y0 + 2, '${farmKey}', 0);
            S.place(x0 + 9, y0 + 2, '${farmKey}', 0); S.place(x0 + 10, y0 + 2, '${farmKey}', 0);
            const mine = [S.collector('${unitKey}', 0, x0 + 1, y0 + 4), S.collector('${unitKey}', 0, x0 + 2, y0 + 4), S.collector('${unitKey}', 0, x0 + 3, y0 + 4)];
            const enemy = S.collector('${unitKey}', 1, x0 + 1, y0 + 5);
            S.tick(2);
            processActions([{ action: 'workerAssign', unitIds: [...mine, enemy].map(u => u.id), targetType: '${farmKey}', targetGx: clicked.gx, targetGy: clicked.gy }], 0);
            const first = S.tgt(mine[0]), enemyAfter = S.tgt(enemy);
            const moved = mine.slice(1).map(u => u.workerState);
            S.tick(300);
            return { clicked: [clicked.gx, clicked.gy], first, enemyAfter, moved, targets: mine.map(u => S.tgt(u)), states: mine.map(u => u.workerState) };
        `);
        assert.ok(!r.err, r.err);
        assert.deepEqual(r.first && r.first.slice(0, 2), r.clicked, res + ': the first collector takes the clicked farm');
        assert.equal(r.enemyAfter, null, res + ": orders cannot assign another player's collector");
        for (const s of r.moved) assert.equal(s, 'MANUAL_MOVE', res + ': the others move to the clicked area');
        const tiles = r.targets.filter(Boolean).map(t => t[0] + ',' + t[1]);
        assert.equal(tiles.length, 3, res + ': every collector has a farm: ' + JSON.stringify(r.targets));
        assert.equal(new Set(tiles).size, 3, res + ': collectors reserve distinct farms: ' + tiles);
        return JSON.stringify(r);
    };
    assert.equal(replay(0), replay(1), res + ': the same orders give the same targets whoever is local');
    console.log(res, 'group order: distinct farms, same on both runs');
}

// Mines are still found.
{
    const inst = match('mine');
    const r = q(inst, `
        const m = goldMines.find(g => g && g.gold > 0 && __scratch.free(g.gx + 1, g.gy));
        if (!m) return { err: 'no mine' };
        const u = __scratch.collector('collector', 0, m.gx + 1, m.gy);
        let got = null;
        for (let t = 0; t < 200 && !got; t++) { __scratch.tick(1); const g = __scratch.tgt(u); if (g && g[2] === 'mine') got = g; }
        return { got };
    `);
    assert.ok(!r.err, r.err);
    assert.ok(r.got, 'mine auto-discovery still works');
    console.log('mine discovery:', JSON.stringify(r.got));
}

// The Ctrl-click split (main.js applyWorkerAssignTargets: the page's, before
// any action is sent): each gather target type kept, nearest workers first.
{
    const main = fs.readFileSync(path.join(__dirname, '../src/main.js'), 'utf8');
    const c = vm.createContext({ TILE: 32, Math, RESOURCE_TYPE_LIST: [{ mineTileType: 'mine', farmKey: 'farm' }, { mineTileType: 'astar_mine', farmKey: 'astar_farm' }] });
    vm.runInContext(main.slice(main.indexOf('function _isCollectorGatherTargetType('), main.indexOf('function _getResourceCollectorConfigForSpawnerType(')), c);
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/utils/assign_nearest.js'), 'utf8'), c);
    const helperStart = main.indexOf('    function _assignToNearestPoints('), helperEnd = main.indexOf('    function applyRallyTargets(', helperStart);
    const start = main.indexOf('    function applyWorkerAssignTargets('), end = main.indexOf('    function screenToWorldClamped(', start);
    vm.runInContext(main.slice(helperStart, helperEnd).replace('let _entityWorldXY', 'var _entityWorldXY'), c);
    vm.runInContext(main.slice(start, end), c);
    Object.assign(c, { multiCollectorAssignTargets: [], multiBuilderAssignTargets: [], multiResearcherAssignTargets: [], multiHealerAssignTargets: [] });
    const actions = [];
    c.queueAction = a => actions.push(a);
    const w = (id, gx, gy) => ({ id, owner: 0, workerType: 'collector', unitType: 'collector', x: gx * 32 + 16, y: gy * 32 + 16 });
    const group = [w(1, 2, 4), w(2, 3, 4)];
    c.applyWorkerAssignTargets(group, 'mine', 4, 4, false);
    actions.length = 0;
    c.applyWorkerAssignTargets(group, 'farm', 5, 4, true);
    assert.deepEqual(actions.map(a => a.targetType), ['mine', 'farm'], 'Ctrl-click retains each gather target type');
    const near = w(3, 5, 4), far = w(4, 30, 30);
    c.multiCollectorAssignTargets.length = 0;
    c.applyWorkerAssignTargets([far, near], 'mine', 29, 30, false);
    actions.length = 0;
    c.applyWorkerAssignTargets([far, near], 'farm', 5, 4, true);
    assert.equal(JSON.stringify(actions.map(a => [a.targetType, a.unitIds])), JSON.stringify([['mine', [far.id]], ['farm', [near.id]]]), 'nearest workers take each target');
}

console.log('PASS: farm discovery, group orders, collection, mines and deterministic replay (worker kernel); Ctrl-click split.');
