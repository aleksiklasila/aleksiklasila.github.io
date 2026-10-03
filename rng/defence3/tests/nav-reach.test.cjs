// Flow navigation reach (flownav.js parts, rows and substitutes):
//  A. a cluster split by a wall: a unit on one side reaches a tile on the
//     other that is only reachable by leaving the cluster and coming back;
//  B. a destination walled in: units outside go to the closest tile they can
//     reach and wait there with their order kept (not idle); one wall opened
//     (a new build), they go on to the destination itself;
//  C. a unit walled in, sent outside: the closest tile inside the ring.
// Nothing searches on the simulation thread (no A*, no group routes).
//   node tests/nav-reach.test.cjs
'use strict';
const assert = require('node:assert/strict');
const H = require('./net-harness.cjs');
const world = new H.World({ controls: { ...H.SMALL_MATCH_CONTROLS, 'cfg-mapsize': '96', 'cfg-map-type': 'arena' } });
const inst = world.spawn('navreach', { simWorker: false });
inst.eval('startSoloGame();');
const r = JSON.parse(inst.eval(`JSON.stringify((() => {
    const out = {};
    // (Searches counted: none may run.)
    let searches = 0;
    { const fA = findPathAStar; findPathAStar = function () { searches++; return fA.apply(this, arguments); }; const fG = GroupRoute.prototype.advance; GroupRoute.prototype.advance = function () { searches++; return fG.apply(this, arguments); }; }
    // An open area in the map's middle (walls cleared, nothing on it).
    const x0 = 24, y0 = 24, x1 = 72, y1 = 72;
    const setWall = (x, y, on) => { const c = grid[y][x]; if (c.item || getTileEntityRef(x, y)) return false; c.type = on ? TYPE_WALL : TYPE_FLOOR; simMoveTileTypeChanged(x, y); return true; };
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) setWall(x, y, false);
    // (The match's own units and buildings are at its corners, out of the way.)
    // A: a wall across cluster (2, 2) (tiles 32..47 with 16-tile clusters)
    // from its top border down to row 45, leaving the way round below
    // through cluster (2, 3): x = 40, y = 32..45. (Cluster split: tiles
    // west and east of the wall connect only through row 46-47 ... and the
    // wall continues down to y = 50 so the way leaves the cluster.)
    for (let y = 30; y <= 50; y++) setWall(40, y, true);
    // B: a ring around (60, 34)..(66, 40), and a destination inside.
    for (let y = 33; y <= 41; y++) for (let x = 59; x <= 67; x++) if (y === 33 || y === 41 || x === 59 || x === 67) setWall(x, y, true);
    // (The navigation for these walls: a rebuild over NAV_BUILD_TICKS.)
    for (let i = 0; i < NAV_BUILD_TICKS + 4; i++) gameTick();
    out.build = _nav[NAV_PROFILE_GROUND].np + ' parts, ' + _nav[NAV_PROFILE_GROUND].ncomp + ' components';
    const spawn = (gx, gy, owner = 0) => { const u = new Unit('norm', owner, gx * TILE + 16, gy * TILE + 16); units.push(u); unitByIdAdded(u); updateUnitSpatial(u); return u; };
    // (Orders find units by the id map of the tick: a tick between spawning and ordering.)
    const order = (us, gx, gy) => { gameTick(); processAction({ action: 'move', unitIds: us.map(u => u.id), targetX: gx * TILE + 16, targetY: gy * TILE + 16 }, 0); };
    const tileOf = u => [Math.floor(u.x / TILE), Math.floor(u.y / TILE)];
    const run = (n, stop) => { for (let i = 0; i < n; i++) { gameTick(); if (stop && stop()) return i + 1; } return -1; };
    // A.
    const a = spawn(38, 36);
    order([a], 42, 36);
    out.aTicks = run(600, () => { const [x, y] = tileOf(a); return x === 42 && y === 36; });
    out.aTile = tileOf(a); out.aCmd = a.commandState;
    // B: three units west of the ring sent inside it.
    const bs = [spawn(50, 37), spawn(50, 38), spawn(51, 36)];
    order(bs, 63, 37);
    run(400);
    out.bTiles = bs.map(tileOf);
    out.bCmd = bs.map(u => u.commandState);
    out.bPending = bs.map(u => !!u._pendingPathTarget);
    // (The ring's outside tiles nearest the destination: 5 tiles from it, N, W, E, S.)
    out.bDist = bs.map(u => { const [x, y] = tileOf(u); return Math.max(Math.abs(x - 63), Math.abs(y - 37)); });
    // Opened: the ring's west wall at (59, 37).
    setWall(59, 37, false);
    out.bTicks = run(NAV_BUILD_TICKS + 900, () => bs.every(u => { const [x, y] = tileOf(u); return Math.abs(x - 63) <= 1 && Math.abs(y - 37) <= 1; }));
    out.bAfter = bs.map(tileOf);
    out.bCmdAfter = bs.map(u => u.commandState);
    // C: a unit in a closed ring sent out of it.
    for (let y = 52; y <= 58; y++) for (let x = 30; x <= 36; x++) if (y === 52 || y === 58 || x === 30 || x === 36) setWall(x, y, true);
    run(NAV_BUILD_TICKS + 4);
    const c = spawn(33, 55);
    order([c], 45, 55);
    run(300);
    out.cTile = tileOf(c); out.cCmd = c.commandState; out.cPending = !!c._pendingPathTarget;
    out.searches = searches;
    return out;
})())`));
console.log(JSON.stringify(r));
assert.ok(r.aTicks > 0, 'A: the unit reached the tile behind the wall: ' + JSON.stringify(r.aTile));
// B: just outside the ring, as near the destination as it gets, still ordered.
r.bDist.forEach((d, i) => assert.ok(d >= 5 && d <= 6, 'B: unit ' + i + ' at the closest reachable tiles, at ' + JSON.stringify(r.bTiles[i])));
r.bCmd.forEach((c, i) => assert.equal(c, 1, 'B: unit ' + i + ' keeps its move order (not idle)'));
r.bPending.forEach((p, i) => assert.ok(p, 'B: unit ' + i + ' keeps its target'));
assert.ok(r.bTicks > 0, 'B: after the wall opened, the units reached the destination: ' + JSON.stringify(r.bAfter));
// C: inside the ring (31..35, 53..57), on its east side, still ordered.
assert.ok(r.cTile[0] >= 34 && r.cTile[0] <= 35 && r.cTile[1] >= 53 && r.cTile[1] <= 57, 'C: the walled-in unit at the ring side nearest the target: ' + JSON.stringify(r.cTile));
assert.equal(r.cCmd, 1, 'C: keeps its move order');
assert.equal(r.searches, 0, 'no path search (A*, group route) ran');
console.log('PASS: flow navigation reach (' + r.build + '; A in ' + r.aTicks + ' ticks, B on after opening in ' + r.bTicks + ')');
process.exit(0);
