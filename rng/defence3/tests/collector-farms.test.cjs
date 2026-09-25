const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const main = read('src/main.js');
function mainFunction(name) {
    const start = main.indexOf(`function ${name}(`);
    const end = main.indexOf('\nfunction ', start + 1);
    return main.slice(start, end < 0 ? undefined : end);
}

function world(resource, localPlayerId = 0) {
    const cfg = resource === 'energy'
        ? { key: 'energy', stockpileKey: 'energy', collectorUnitKey: 'collector', collectorBuildingKey: 'collector', farmKey: 'farm', mineTileType: 'mine', mineStatKey: 'gold', mineArrayKey: 'goldMines' }
        : { key: 'astar', stockpileKey: 'astar', collectorUnitKey: 'astar_collector', collectorBuildingKey: 'astar_collector', farmKey: 'astar_farm', mineTileType: 'astar_mine', mineStatKey: 'astar', mineArrayKey: 'astarMines' };
    const c = vm.createContext({
        TILE: 32, GRID_W: 32, GRID_H: 16, TICK_RATE: 30, WORKER_AI_TICK_DELAY: 1,
        CMD_IDLE: 0, CMD_MOVING: 1, CMD_HOLDING: 2, gameTime: 100, localPlayerId,
        RESOURCE_COLLECTOR_UNIT_KEYS: ['collector', 'astar_collector'], RESOURCE_TYPE_LIST: [cfg],
        grid: Array.from({ length: 16 }, () => Array.from({ length: 32 }, () => ({ item: null }))),
        units: [], collectorSpawners: [], goldMines: [], astarMines: [], droppedItems: [],
        getResourceTypeByCollectorUnit: type => type === cfg.collectorUnitKey ? cfg : null,
        getResourceMineAt: (_key, gx, gy) => [...c.goldMines, ...c.astarMines].find(m => m.gx === gx && m.gy === gy),
        secondsToTicks: s => s * 30,
        _canUsePathfindRequestBudget: () => true, _consumePathfindRequestBudget: () => {},
        _findPathForUnitTagged: (_tag, _u, sx, sy, gx, gy) => [{ x: sx, y: sy }, { x: gx, y: gy }],
        _lastPathfindAbortedByBudget: false,
        getThingBaseLevel: () => 1, stackCountToLevel: () => 1,
        getBuildingStatForOwner: () => 2, playSound: () => {},
        BASE_UNIT_STATS: { [cfg.collectorUnitKey]: { transferCooldown: 1 } },
        getUnitEffectiveLevel: () => 1,
    });
    vm.runInContext(read('src/things/worker.js'), c);
    for (const name of ['_isCollectorGatherTargetType', '_getGatherTargetAtForCollectorWorkerType', '_isValidGatherTargetForCollectorWorkerType', 'processActions']) {
        vm.runInContext(mainFunction(name), c);
    }
    // Isolate pathfinding and stat configuration; run real targeting, reservations,
    // command processing, manual-move completion and collection state transitions.
    c._getWorkerAutoSearchDistancePx = () => 128;
    c._findClosestSpawner = () => null;
    c._workerReturnPath = u => { u.workerState = 'RETURNING'; };
    c._isWorkerWithinTileInteractionRange = (u, t) => Math.hypot(u.x - t.x, u.y - t.y) <= 32;
    c.getResourceTypeConfig = () => cfg;
    const farm = (gx, gy = 4, extra = {}) => {
        const f = { type: cfg.farmKey, owner: 0, energy: 100, gx, gy, x: gx * 32 + 16, y: gy * 32 + 16, ...extra };
        c.grid[gy][gx].item = f;
        return f;
    };
    const unit = (id, gx = 2, owner = 0) => {
        const u = { id, owner, workerType: cfg.collectorUnitKey, unitType: cfg.collectorUnitKey,
            workerState: 'IDLE', commandState: 0, workerTarget: null, workerTargetType: null,
            x: gx * 32 + 16, y: 144, carryingValue: 0, preComputed: { gatherPerTrip: 3 } };
        c.units.push(u);
        return u;
    };
    const assign = (units, target) => c.processActions([{ action: 'workerAssign', unitIds: units.map(u => u.id),
        targetType: target.type, targetGx: target.gx, targetGy: target.gy }], 0);
    return { c, cfg, farm, unit, assign };
}

for (const resource of ['energy', 'astar']) {
    {
        const { c, farm, unit } = world(resource);
        farm(2, 4, { owner: 1 });
        farm(3, 4, { underConstruction: true });
        farm(4, 4, { energy: 0 });
        farm(5, 4, { type: 'unrelated' });
        farm(20);
        const u = unit(1);
        c.updateWorkerAI(u);
        assert.equal(u.workerTarget, null, 'ignore enemy, unfinished, dead, wrong-type and distant farms');
        const valid = farm(4);
        c.updateWorkerAI(u);
        assert.equal(u.workerTarget, valid, 'discover floor farms without a manual command or mines');
        u.x = valid.x; u.y = valid.y; u.path = null;
        c.updateWorkerAI(u);
        assert.equal(u.carryingValue, 6, 'automatically discovered farm produces resources');
        assert.equal(u.workerState, 'RETURNING');
    }

    const replay = localPlayerId => {
        const { c, farm, unit, assign } = world(resource, localPlayerId);
        const clicked = farm(20);
        farm(21); farm(22);
        const selected = [unit(1), unit(2), unit(3)];
        const enemy = unit(4, 2, 1);
        assign([...selected, enemy], clicked);
        assert.equal(selected[0].workerTarget, clicked);
        assert.equal(enemy.workerTarget, null, 'commands cannot assign another player\'s collector');
        for (const u of selected.slice(1)) {
            assert.equal(u.workerState, 'MANUAL_MOVE', 'all additional collectors move to the clicked area');
            assert.equal(u.targetPos.x, clicked.x);
            // Normal unit movement clears targetPos/path when the destination is reached.
            u.x = clicked.x; u.y = clicked.y; u.targetPos = null; u.path = null;
            c.updateWorkerAI(u);
            c.updateWorkerAI(u);
            assert.equal(u.workerState, 'MOVING_TO');
        }
        assert.equal(new Set(selected.map(u => u.workerTarget)).size, 3, 'collectors reserve distinct nearby farms');
        return JSON.stringify(selected.map(u => ({ id: u.id, state: u.workerState, target: u.workerTarget.gx, path: u.path })));
    };
    assert.equal(replay(0), replay(1), 'same commands produce identical targets and paths on both peers');
}

{
    const { c, unit, farm, assign } = world('energy');
    const mine = { type: 'mine', gx: 4, gy: 4, x: 144, y: 144, gold: 100 };
    c.goldMines.push(mine);
    const u = unit(1);
    c.updateWorkerAI(u);
    assert.equal(u.workerTarget, mine, 'mine auto-discovery still works');
    const f = farm(5);
    assign([u], f);
    assert.equal(u.workerTarget, f, 'single collectors can switch from a mine to a farm');

    const start = main.indexOf('    function applyWorkerAssignTargets(');
    const end = main.indexOf('    function screenToWorldClamped(', start);
    const helperStart = main.indexOf('    function _assignToNearestPoints(');
    const helperEnd = main.indexOf('    function applyRallyTargets(', helperStart);
    vm.runInContext(main.slice(helperStart, helperEnd).replace('let _entityWorldXY', 'var _entityWorldXY'), c);
    vm.runInContext(main.slice(start, end), c);
    Object.assign(c, { multiCollectorAssignTargets: [], multiBuilderAssignTargets: [], multiResearcherAssignTargets: [], multiHealerAssignTargets: [] });
    const actions = [];
    c.queueAction = a => actions.push(a);
    const group = [u, unit(2)];
    c.applyWorkerAssignTargets(group, 'mine', 4, 4, false);
    actions.length = 0;
    c.applyWorkerAssignTargets(group, 'farm', 5, 4, true);
    assert.deepEqual(actions.map(a => a.targetType), ['mine', 'farm'], 'Ctrl-click retains each gather target type');
    // Ctrl multi-targets go to the nearest worker, keeping equal shares.
    const near = unit(3), far = unit(4);
    near.x = 5 * 32 + 16; near.y = 4 * 32 + 16; far.x = 30 * 32 + 16; far.y = 30 * 32 + 16;
    c.multiCollectorAssignTargets.length = 0;
    c.applyWorkerAssignTargets([far, near], 'mine', 29, 30, false);
    actions.length = 0;
    c.applyWorkerAssignTargets([far, near], 'farm', 5, 4, true);
    assert.equal(JSON.stringify(actions.map(a => [a.targetType, a.unitIds])), JSON.stringify([['mine', [far.id]], ['farm', [near.id]]]), 'nearest workers take each target');
}

console.log('PASS: farm discovery, group orders, collection, mixed targets and deterministic peer replay.');
