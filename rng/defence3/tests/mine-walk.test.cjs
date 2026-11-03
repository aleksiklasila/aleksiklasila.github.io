// Mines are walls for everyone, builders and salvagers included (they walk over
// any player's buildings, a mine belongs to no player). Once a mine is
// removed (emptied: worker.js _waiMineGone) its tile is floor again, walkable
// for ground, flying and builder/salvager units, like a removed building.
//   node tests/mine-walk.test.cjs
'use strict';
const assert = require('node:assert/strict');
const H = require('./net-harness.cjs');
const world = new H.World({ controls: { ...H.SMALL_MATCH_CONTROLS, 'cfg-mapsize': '120', 'cfg-map-type': 'arena', 'cfg-full-vis': 'full' } });
const inst = world.spawn('minewalk', { simWorker: false });
inst.eval('startSoloGame();');
const r = JSON.parse(inst.eval(`JSON.stringify((() => {
    gameTick();
    const kinds = { ground: { owner: 0, workerType: null, isFlying: false }, builder: { owner: 0, workerType: 'builder', isFlying: false },
        salvager: { owner: 1, workerType: 'salvager', isFlying: false }, flying: { owner: 0, workerType: null, isFlying: true } };
    const probe = (gx, gy) => {
        const o = {};
        for (const k in kinds) o[k] = canUnitOccupyTile(kinds[k], gx, gy);
        o.classWall = _navClassWalls(NAV_PROFILE_BUILD)[gy * GRID_W + gx];
        o.groundWall = simMoveWallGrid()[gy * GRID_W + gx];
        return o;
    };
    const out = { mines: [goldMines.length, astarMines.length] };
    for (const [name, list, cfg] of [['gold', goldMines, RESOURCE_TYPE_LIST[0]], ['astar', astarMines, RESOURCE_TYPE_LIST[1]]]) {
        const m = list[0];
        if (!m) continue;
        const gx = m.gx, gy = m.gy;
        out[name + 'Before'] = probe(gx, gy);
        _waiMineGone(gy * GRID_W + gx, cfg);
        gameTick();
        out[name + 'After'] = probe(gx, gy);
        out[name + 'Entity'] = !!getTileEntityRef(gx, gy);
    }
    // A building of another player: builders pass it, ground units do not.
    const b = barracks[0];
    if (b) out.building = probe(b.gx, b.gy);
    return out;
})())`));
console.log(JSON.stringify(r));
assert(r.mines[0] + r.mines[1] > 0, 'the map has mines');
for (const name of ['gold', 'astar']) {
    const before = r[name + 'Before'], after = r[name + 'After'];
    if (!before) continue;
    assert.deepEqual([before.ground, before.builder, before.salvager, before.classWall, before.groundWall], [false, false, false, 1, 1], name + ' mine blocks ground, builders and salvagers');
    assert.equal(before.flying, true, name + ' mine does not block flyers');
    assert.deepEqual([after.ground, after.builder, after.salvager, after.flying, after.classWall, after.groundWall], [true, true, true, true, 0, 0], name + ' tile open to all once the mine is removed');
    assert.equal(r[name + 'Entity'], false);
}
if (r.building) assert.equal(r.building.builder && r.building.salvager, true, 'builders pass any building');
console.log('PASS: mines block builders until removed; removed mine tiles are open to all');
process.exit(0);
