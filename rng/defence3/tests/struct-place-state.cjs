'use strict';
// The state placements leave (shared by tests/struct-place-kernel.test.cjs and its reference capture): a solo match,
// placements of every structure class through the place action (rules on: visible tiles, a wall, an occupied tile, a
// second cloud of a type, the structure limit; rules off: the starter / snapshot path; manual stacks), then every
// placed structure's row (all its table's columns), the tile table's entries, the cells, the per-owner counts, the list
// versions moved, and the state hash; then 60 ticks played and the hash again.
//   node tests/struct-place-state.cjs > out.json
const H = require('./net-harness.cjs');

function run() {
    const world = new H.World({ controls: { ...H.SMALL_MATCH_CONTROLS, 'cfg-mapsize': '60', 'cfg-map-type': 'arena' } });
    const inst = world.spawn('sp', { simWorker: false });
    inst.eval('startSoloGame();');
    return JSON.parse(inst.eval(`JSON.stringify((() => {
        const me = localPlayerId, out = { tries: [] };
        const keys = ['pistol', 'laser', 'sniper', 'cloud_0a', 'cloud_0a', 'barrack_norm', 'barrack_tank', 'spawner', 'astar_spawner', 'salvager', 'builder_spawner', 'healer_spawner', 'research', 'sand', 'house', 'water_puddle'];
        // (Tiles near this player's king: visible ones first.)
        const k = units.find(u => u && u.isKing && u.owner === me);
        const kx = Math.floor(k.x / TILE), ky = Math.floor(k.y / TILE), tiles = [];
        for (let r = 2; r < 14 && tiles.length < 400; r++) for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
            if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
            const gx = kx + dx, gy = ky + dy;
            if (gx > 1 && gy > 1 && gx < GRID_W - 2 && gy < GRID_H - 2) tiles.push([gx, gy]);
        }
        const v0 = { towers: towersVersion, barracks: barracksVersion, spawners: collectorSpawnersVersion, clouds: cloudTowersVersion, lasers: laserTowersVersion };
        let ti = 0;
        const place = (gx, gy, itemType, o = {}) => { const before = getTileEntityRef(gx, gy); processAction(sanitizeAction({ action: 'place', gx, gy, itemType, count: o.count || 1, buildEnabled: o.build !== false, autoUpgradeEnabled: !!o.auto }, true), o.pid ?? me); const e = getTileEntityRef(gx, gy); out.tries.push([gx, gy, itemType, !!e && e !== before]); return e; };
        for (let i = 0; i < keys.length * 3; i++) { const [gx, gy] = tiles[ti++]; place(gx, gy, keys[i % keys.length], { auto: i % 2 === 0, build: i % 5 !== 0 }); }
        // (Refused: a wall, an occupied tile (another type), out of sight.)
        let wall = null; for (let gy = 1; gy < GRID_H - 1 && !wall; gy++) for (let gx = 1; gx < GRID_W - 1; gx++) if (cellType[gy * GRID_W + gx] === TYPE_WALL) { wall = [gx, gy]; break; }
        if (wall) place(wall[0], wall[1], 'pistol');
        place(tiles[0][0], tiles[0][1], 'sniper');
        place(tiles[1][0], tiles[1][1], tiles.length ? 'laser' : 'pistol');
        place(GRID_W - 3, GRID_H - 3, 'pistol');
        // (The same type again where it stands: nothing, manual stacking off.)
        place(tiles[2][0], tiles[2][1], keys[2]);
        // Rules off (starter buildings, snapshot decode): placeBuilding itself.
        for (let i = 0; i < 6; i++) { const [gx, gy] = tiles[ti++]; placeBuilding(gx, gy, keys[(i * 5) % keys.length], me, { silent: true, ignorePlacementRules: true, autoUpgradeEnabled: true, buildEnabled: true, stacks: 1 + (i % 3) }); out.tries.push([gx, gy, 'raw:' + keys[(i * 5) % keys.length], !!getTileEntityRef(gx, gy)]); }
        // (Contested, solo: another player's structure in an area, no placement elsewhere in it; a tile of an area with
        // none of theirs still placed.)
        { const [cx, cy] = tiles[ti++], c = cy * GRID_W + cx, M = _mapAreas, ar = cellArea[c];
          placeBuilding(cx, cy, 'pistol', 1, { silent: true, ignorePlacementRules: true });
          let other = -1; for (let j = M.off[ar]; j < M.off[ar + 1]; j++) { const q = M.tiles[j]; if (q !== c && !_ST.ctab[q] && cellType[q] !== TYPE_WALL && isTileActuallyVisibleToPlayer(me, q % GRID_W, Math.floor(q / GRID_W))) { other = q; break; } }
          out.contested = other >= 0 ? !!place(other % GRID_W, Math.floor(other / GRID_W), 'sniper') : null; }
        // Every structure placed: its row, its tile's entries, its cell.
        const rows = [];
        for (const [gx, gy] of tiles.slice(0, ti)) {
            const e = getTileEntityRef(gx, gy); if (!e) continue;
            const T = _sTables.get(e.constructor), r = e._sr, t = gy * GRID_W + gx, row = { at: [gx, gy], cls: e.constructor.name };
            for (const f of T.fields) { const a = T[f.col]; let v = f.shared ? a.get(r) : a[r]; if (f.kind === 'r') v = v === null ? 'null' : v === undefined ? 'undef' : typeof v === 'object' ? 'obj' : v; row[f.name] = typeof v === 'number' && v !== v ? 'NaN' : v; }
            for (const name of T.derived) row['$' + name] = T.unique[name].has(r);
            row.tile = [_ST.code[t], _ST.own[t], _ST.uc[t], _ST.val[t], _ST.tim[t], _ST.brain[t], _ST.rtab[t], _ST.stab[t], _ST.ctab[t], _ST.cnt[t]];
            row.cell = [cellType[t], cellOwner[t]];
            row.view = { type: e.type, owner: e.owner, uc: e.underConstruction, energy: e.energy, maxEnergy: e.maxEnergy, level: e.level, stacks: e.stacks, manual: e.manualStacks, angle: e.angle, x: e.x, y: e.y };
            rows.push(row);
        }
        out.rows = rows;
        out.counts = [Array.from(structCountByOwner.slice(0, 4)), Array.from(structCellCountByOwner.slice(0, 4)), Array.from(structLabCount.slice(0, 4)), Array.from(structLabBuilt.slice(0, 4))];
        out.lists = [towers.length, barracks.length, collectorSpawners.length];
        out.moved = { towers: towersVersion !== v0.towers, barracks: barracksVersion !== v0.barracks, spawners: collectorSpawnersVersion !== v0.spawners, clouds: cloudTowersVersion !== v0.clouds, lasers: laserTowersVersion !== v0.lasers };
        out.adj = [_adjacencyDirtyTiles.n, _adjacencyDirtyTiles.sum, _adjacencyDirtyTiles.min];
        out.work = workerWorkVersionsChecksum();
        out.hash0 = snapTickHash(currentTick, true);
        for (let i = 0; i < 60; i++) { gameTick(); currentTick++; }
        out.hash60 = snapTickHash(currentTick, true);
        out.built = towers.filter(t => t.owner === me && !t.underConstruction).length;
        return out;
    })())`));
}
module.exports = { run };
if (require.main === module) process.stdout.write(JSON.stringify(run()));
