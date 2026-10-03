// Path region labels kept as walls change (pathfinding.js
// pathRegionsTileChanged: opened tiles join regions, closed ones split only
// after a fresh build) give the same partition of tiles as a fresh build,
// after every change of a random sequence (towers placed in open ground,
// corridors cut and reopened, rooms sealed).
//   node tests/path-regions-incremental.test.cjs
'use strict';
const assert = require('node:assert/strict');
const H = require('./net-harness.cjs');
for (const [map, seed] of [['arena', 3], ['islands', 7], ['crossroads', 11]]) {
    const world = new H.World({ controls: { ...H.SMALL_MATCH_CONTROLS, 'cfg-mapsize': '60', 'cfg-map-type': map } });
    const inst = world.spawn('regions' + map, { simWorker: false });
    inst.eval('startSoloGame();');
    const r = JSON.parse(inst.eval(`JSON.stringify((() => {
        gameTick();
        let s = ${seed};
        const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
        const same = (a, b) => {
            if (a.length !== b.length) return 'length';
            const ab = new Map(), ba = new Map();
            for (let i = 0; i < a.length; i++) {
                if ((a[i] < 0) !== (b[i] < 0)) return 'walkable ' + i;
                if (a[i] < 0) continue;
                const x = ab.get(a[i]), y = ba.get(b[i]);
                if (x === undefined) ab.set(a[i], b[i]); else if (x !== b[i]) return 'split ' + i;
                if (y === undefined) ba.set(b[i], a[i]); else if (y !== a[i]) return 'merge ' + i;
            }
            return '';
        };
        const fresh = () => { const keep = _pathRegions.byOwner; _pathRegions.byOwner = new Map(); const L = getPathRegions(null).slice(); _pathRegions.byOwner = keep; return L; };
        let changes = 0, rebuilds = 0, bad = '';
        // (Changes near a few spots, so walls meet and corridors close.)
        const spots = Array.from({ length: 4 }, () => [4 + Math.floor(rnd() * (GRID_W - 8)), 4 + Math.floor(rnd() * (GRID_H - 8))]);
        getPathRegions(null);
        for (let k = 0; k < 1500 && !bad; k++) {
            const sp = spots[k % spots.length], gx = Math.max(1, Math.min(GRID_W - 2, sp[0] + Math.floor(rnd() * 9) - 4)), gy = Math.max(1, Math.min(GRID_H - 2, sp[1] + Math.floor(rnd() * 9) - 4));
            const c = grid[gy][gx];
            if (c.item || getTileEntityRef(gx, gy)) continue;
            c.type = c.type === TYPE_WALL ? TYPE_FLOOR : TYPE_WALL;
            simMoveTileTypeChanged(gx, gy);
            changes++;
            const E = _pathRegions.byOwner.get(-1);
            if (!E || E.dirty) rebuilds++;
            const kept = getPathRegions(null);
            const why = same(kept, fresh());
            if (why) bad = 'change ' + k + ' at ' + gx + ',' + gy + ': ' + why;
        }
        return { changes, rebuilds, bad };
    })())`));
    assert.equal(r.bad, '', map);
    assert.ok(r.changes > 500, map + ' changes ' + r.changes);
    console.log(map, r.changes, 'wall changes,', r.rebuilds, 'full rebuilds, partitions equal');
}
console.log('PASS: path regions kept incrementally');
