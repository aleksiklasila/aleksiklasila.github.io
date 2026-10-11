const assert = require('node:assert/strict');
const H = require('./net-harness.cjs');
const game = new H.World().spawn('order-markers');
const run = code => game.eval(code);
const markers = () => JSON.parse(run('JSON.stringify(getOrderMarkers())'));
const points = () => markers().map(m => [m.x * 32, m.z * 32, m.color]);
run(`
    localPlayerId = 0; currentTick = 10; gameTime = 10;
    __scratch.a = { id: 1, owner: 0, unitType: 'norm', unitLevel: 1, commandState: CMD_MOVING, path: [{ x: 3, y: 4 }] };
    __scratch.b = { id: 2, owner: 0, unitType: 'norm', unitLevel: 2, commandState: CMD_ATTACK_MOVING, path: [{ x: 7, y: 8 }] };
    __scratch.barrack = { owner: 0, type: 'barrack', unitType: 'norm', gx: 1, gy: 1, energy: 100, rallyX: 200, rallyY: 240 };
    selectedUnits = [__scratch.a, __scratch.b]; selectedEntities = [__scratch.barrack]; activeSubGroups = {};
`);
assert.deepEqual(points(), [[200,240,'#9aa'],[112,144,'#4f4'],[240,272,'#f66']]);
run("noteOrderMarker({action:'move', unitIds:[1,2], targetX:400, targetY:432}, 12);");
assert.deepEqual(points(), [[200,240,'#9aa'],[400,432,'#4f4']], 'new order replaces all affected old destinations, deduplicated');
run("noteOrderMarker({action:'move', unitIds:[1], targetX:500, targetY:532}, 12);");
assert.deepEqual(points(), [[200,240,'#9aa'],[500,532,'#4f4'],[400,432,'#4f4']], 'partial replacement preserves other units orders');
run('selectedUnits = [__scratch.b]; selectedEntities = [];');
assert.deepEqual(points(), [[400,432,'#4f4']], 'deselected units and buildings leave no historical markers');
run('selectedUnits = [];');
assert.deepEqual(markers(), []);
run('selectedUnits = [__scratch.a]; __scratch.a.path = [{x:15,y:16}]; currentTick = 13; gameTime++;');
assert.deepEqual(points(), [[496,528,'#4f4']], 'acknowledged command uses its actual path destination');
run('currentTick = 500; gameTime = 500;');
assert.deepEqual(points(), [[496,528,'#4f4']], 'active destination persists beyond four seconds');
run('__scratch.a.commandState = CMD_IDLE; __scratch.a.path = null; gameTime++;');
assert.deepEqual(markers(), [], 'completed orders disappear');
run('selectedUnits = [__scratch.b];');
assert.deepEqual(points(), [[240,272,'#f66']], 'reselection restores the units own current destination');
run("noteOrderMarker({action:'stop',unitIds:[2]}, 502);");
assert.deepEqual(markers(), [], 'stop suppresses the previous destination immediately');
run('resetOrderMarkers(); activeSubGroups[getUnitGroupKey(__scratch.b)] = false;');
assert.deepEqual(markers(), [], 'inactive subgroups do not contribute markers');
run('activeSubGroups = {}; selectedUnits = []; selectedEntities = [__scratch.barrack];');
run("noteOrderMarker({action:'setRallyMany',coords:[1,1],targetX:600,targetY:640}, 502);");
assert.deepEqual(points(), [[600,640,'#9aa']], 'rally replacement never shows both old and new targets');
run('__scratch.barrack.rallyX = 600; __scratch.barrack.rallyY = 640; currentTick = 503; gameTime++;');
assert.deepEqual(points(), [[600,640,'#9aa']]);
run(`
    __scratch.lookup = getUnitById; __scratch.visible = isTileVisibleToPlayer;
    __scratch.target = { id: 42, owner: 1, x: 700, y: 720 };
    getUnitById = id => id === 42 ? __scratch.target : null;
    isTileVisibleToPlayer = () => true;
    __scratch.barrack.rallyTargetUnitId = 42;
    Object.defineProperty(__scratch.barrack, 'rallyX', { get: () => 600, set: () => { throw new Error('render mutated rally'); }, configurable: true });
    gameTime++;
`);
assert.deepEqual(points(), [[700,720,'#9aa']], 'rally follows a visible moving target without mutating the structure');
run('__scratch.target.x = 740; gameTime++;');
assert.deepEqual(points(), [[740,720,'#9aa']]);
run('isTileVisibleToPlayer = () => false; __scratch.target.x = 900; gameTime++;');
assert.deepEqual(points(), [[740,720,'#9aa']], 'hidden target keeps its last visible position');
run('getUnitById = __scratch.lookup; isTileVisibleToPlayer = __scratch.visible;');
run('activeSubGroups[getEntityGroupKey(__scratch.barrack)] = false;');
assert.deepEqual(markers(), [], 'building subgroup toggles update immediately');

// Compact frames carry destinations even when a unit has no detail record,
// including destinations found only after the first 300 selected units.
run(`
    resetOrderMarkers(); activeSubGroups = {}; selectedEntities = [];
    __scratch.F = simFrameViews(new ArrayBuffer(512 * SIM_FRAME_SLOT_BYTES), 512);
    __scratch.F.n = __scratch.F.count = 400; __scratch.F.mver = 1;
    _pageFrame = __scratch.F; _pageFrameSerial++;
    simClientCurrentUnitVis = () => __scratch.F;
    selectedUnits = [];
    for (let i = 0; i < 400; i++) {
        __scratch.F.id[i] = i + 100; __scratch.F.owner[i] = 0; __scratch.F.energy[i] = 100; __scratch.F.order[i] = i;
        __scratch.F.cmd[i] = CMD_MOVING; __scratch.F.orderDest[i] = 4 * GRID_W + 4;
        __scratch.F.orderTick[i] = 502;
        selectedUnits.push(new PageUnit(i + 100, i));
    }
    __scratch.F.orderDest[399] = -(8 * GRID_W + 8);
`);
assert.deepEqual(points(), [[112,144,'#4f4'],[240,272,'#f66']], 'large selections show all distinct active destinations without details');
run("noteOrderMarker({action:'move',unitIds:[499],targetX:800,targetY:816}, 510);");
run('currentTick = 520; gameTime++; _pageFrameSerial++;');
assert.deepEqual(points(), [[112,144,'#4f4'],[800,816,'#4f4']], 'pending feedback waits for displayed metadata, not an ahead-of-display simulation tick');
run('__scratch.F.orderDest[399] = 25 * GRID_W + 26; __scratch.F.orderTick[399] = 510; _pageFrameSerial++;');
assert.deepEqual(points(), [[112,144,'#4f4'],[816,816,'#4f4']]);
assert.deepEqual(game.errors, []);
console.log('PASS: active markers, immediate replacement, deselection/reselection, completion, stop, subgroup toggles, and large worker selections.');
