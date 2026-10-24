// Building sites and drive-by fire at structures (rules revision 37):
//  A. Units on a move order fire at hostile structures they pass (a trap, a
//     tower) without stopping: the combat brain's fire-only structure word
//     (k.rs k_combat_brain, cmMode 16|4; mv.rs move_struct fires and leaves
//     the unit its own move). Enemy units still come first.
//  B. A tower under construction is no wall: units walk over its tile (the
//     movement kernel's walls, the navigation); built, its tile is a wall
//     and units standing there are pushed off (unit.js _simWallPushOut).
//   node tests/construction-walk-driveby.test.cjs
'use strict';
const assert = require('node:assert/strict');
const H = require('./net-harness.cjs');
const world = new H.World({ controls: { ...H.SMALL_MATCH_CONTROLS, 'cfg-mapsize': '120', 'cfg-map-type': 'arena', 'cfg-full-vis': 'full' } });
const inst = world.spawn('sitedrive', { simWorker: false });
inst.eval('startSoloGame();');
const r = JSON.parse(inst.eval(`JSON.stringify((() => {
    gameTick();
    const free = (gx, gy) => { const c = grid[gy][gx]; return c.type === TYPE_FLOOR && !c.item && !getTileEntityRef(gx, gy); };
    const place = (gx, gy, type, owner, built = true) => {
        if (!free(gx, gy)) return null;
        placeBuilding(gx, gy, type, owner, { ignorePlacementRules: true, silent: true });
        const b = getTileEntityRef(gx, gy) || grid[gy][gx].item;
        if (b && built) markConstructionComplete(b);
        if (b && built) b.energy = b.maxEnergy;
        return b;
    };
    const mk = (gx, gy, type = 'norm', owner = 0) => {
        const u = new Unit(type, owner, gx * TILE + 16, gy * TILE + 16);
        configureWorkerUnitFromType(u); applyUnitLevelScaling(u, 1); u.energy = u.maxEnergy;
        units.push(u); unitSlotMapPushed(u); players[owner].popCount++;
        return u;
    };
    // Clear a corridor (rows 58..62) of anything the map put there.
    const out = {};
    const towerKey = BUILD_CATEGORIES.towers.find(k => BASE_CARD_TYPES[k] && !k.startsWith('cloud') && k !== 'laser' && k !== 'watch_tower');
    out.towerKey = towerKey;
    // ---- A: a move order past a hostile trap and a hostile tower beside the path.
    const trapKey = ['lava', 'poison_puddle', 'ice_patch', 'sand'].find(k => BASE_CARD_TYPES[k]);
    const trap = place(50, 58, trapKey, 1), tower = place(70, 58, towerKey, 1);
    out.trapKey = trapKey; out.have = [!!trap, !!tower];
    const movers = [];
    for (let i = 0; i < 8; i++) movers.push(mk(20 + (i % 4), 60 + Math.floor(i / 4), 'norm'));
    const e0 = [trap ? trap.energy : 0, tower ? tower.energy : 0];
    processActions([{ action: 'move', unitIds: movers.map(u => u.id), targetX: 100 * TILE + 16, targetY: 61 * TILE + 16 }], 0);
    let fireOnly = 0, stoodNear = 0;
    for (let t = 0; t < 1400; t++) {
        gameTick();
        for (const u of movers) if (!u.dead) {
            const cm = u._us.cmMode[u._si];
            if ((cm & 23) === 20) fireOnly++;
            if ((cm & 3) === 1) stoodNear++;
        }
    }
    out.aEnergy = [e0, [trap ? trap.energy : 0, tower ? tower.energy : 0]];
    out.aFireOnly = fireOnly; out.aStood = stoodNear;
    out.aX = movers.filter(u => !u.dead).map(u => Math.round(u.x / TILE));
    out.aCmd = movers.filter(u => !u.dead).map(u => u.commandState);
    // ---- B: a tower site in the one-tile gap of a wall line of built towers
    // (owner 0: nothing fights) across a free column: units walk through it.
    let col = -1, top = -1;
    for (let gx = 30; gx < 90 && col < 0; gx++) for (let gy = 70; gy + 22 < 115 && col < 0; gy++) {
        let ok = true;
        for (let k = -6; k <= 22 && ok; k++) for (let dx = -10; dx <= 10 && ok; dx++) ok = free(gx + dx, gy + Math.max(0, Math.min(20, k)));
        if (ok) { col = gx; top = gy; }
    }
    out.bCol = [col, top];
    const gap = top + 10;
    for (let gy = top; gy <= top + 20; gy++) if (gy !== gap) place(col, gy, towerKey, 0);
    const site = place(col, gap, towerKey, 0, false);
    out.bSite = !!site;
    out.siteWall = [grid[gap][col].type === TYPE_WALL, simMoveWallGrid()[gap * GRID_W + col]];
    const walkers = [];
    for (let i = 0; i < 4; i++) walkers.push(mk(col - 8, gap - 2 + i, 'norm'));
    processActions([{ action: 'move', unitIds: walkers.map(u => u.id), targetX: (col + 8) * TILE + 16, targetY: gap * TILE + 16 }], 0);
    let maxY = 0;
    for (let t = 0; t < 500; t++) { gameTick(); for (const u of walkers) maxY = Math.max(maxY, Math.abs(Math.floor(u.y / TILE) - gap)); }
    out.bX = walkers.filter(u => !u.dead).map(u => Math.round(u.x / TILE) - col);
    // (Through the gap: none went around the line's ends, 10 tiles off.)
    out.bMaxOff = maxY;
    // Units standing on the site when it is built: pushed off it.
    const standers = [];
    for (let i = 0; i < 3; i++) standers.push(mk(col, gap, 'norm'));
    for (let t = 0; t < 5; t++) gameTick();
    markConstructionComplete(site);
    for (let t = 0; t < 5; t++) gameTick();
    out.bBuiltWall = [grid[gap][col].type === TYPE_WALL, simMoveWallGrid()[gap * GRID_W + col]];
    out.bStanders = standers.map(u => [Math.floor(u.x / TILE) - col, Math.floor(u.y / TILE) - gap]);
    return out;
})())`));
console.log(JSON.stringify(r));
assert.ok(r.have[0] && r.have[1], 'trap and tower placed');
assert.ok(r.aEnergy[1][0] < r.aEnergy[0][0], 'movers damaged the hostile trap on their way: ' + JSON.stringify(r.aEnergy));
assert.ok(r.aEnergy[1][1] < r.aEnergy[0][1], 'movers damaged the hostile tower on their way: ' + JSON.stringify(r.aEnergy));
assert.ok(r.aFireOnly > 0, 'by the fire-only structure word');
assert.ok(r.aX.every(x => x >= 90), 'and kept going to their destination: ' + JSON.stringify(r.aX));
assert.deepEqual(r.siteWall, [false, 0], 'a tower site is no wall');
assert.ok(r.bSite, 'the site was placed: ' + JSON.stringify(r.bCol));
assert.ok(r.bX.every(x => x >= 5) && r.bMaxOff < 8, 'units walked through the site in the wall line: ' + JSON.stringify([r.bX, r.bMaxOff]));
assert.deepEqual(r.bBuiltWall, [true, 1], 'built, its tile is a wall');
assert.ok(r.bStanders.every(([x, y]) => !(x === 0 && y === 0)), 'units on it were pushed off: ' + JSON.stringify(r.bStanders));
assert.deepEqual(inst.errors, []);
console.log('PASS: construction sites walkable, walls when built; drive-by fire at structures');
process.exit(0);
