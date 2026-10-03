// An owner's path regions with live cloud portals (pathfinding.js
// _pathRegionsOwner: the plain labels joined through the portals) give the
// same partition of tiles as a flood of the map that walks the owner's
// portal tiles and joins each pair, as walls and portals change (portals
// placed in open ground and in sealed rooms, built, destroyed; walls cut).
//   node tests/path-regions-portals.test.cjs
'use strict';
const assert = require('node:assert/strict');
const H = require('./net-harness.cjs');
for (const [map, seed] of [['arena', 5], ['islands', 9], ['crossroads', 13]]) {
    const world = new H.World({ controls: { ...H.SMALL_MATCH_CONTROLS, 'cfg-mapsize': '60', 'cfg-map-type': map } });
    const inst = world.spawn('portals' + map, { simWorker: false });
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
        // (The reference: a flood over the owner's walkable tiles, then the
        // pairs joined.)
        const fresh = owner => {
            const w = GRID_W, h = GRID_H, n = w * h, labels = new Int32Array(n).fill(-1), walk = new Uint8Array(n);
            for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (grid[y][x].type !== TYPE_WALL || _getCloudTowerFast(x, y, owner)) walk[y * w + x] = 1;
            const q = new Int32Array(n); let next = 0;
            for (let i = 0; i < n; i++) {
                if (!walk[i] || labels[i] >= 0) continue;
                const id = next++; let head = 0, tail = 0; labels[i] = id; q[tail++] = i;
                while (head < tail) { const k = q[head++], x = k % w, y = (k / w) | 0;
                    for (const m of [x > 0 ? k - 1 : -1, x < w - 1 ? k + 1 : -1, y > 0 ? k - w : -1, y < h - 1 ? k + w : -1]) if (m >= 0 && walk[m] && labels[m] < 0) { labels[m] = id; q[tail++] = m; } }
            }
            const parent = Array.from({ length: next }, (_, i) => i), find = a => { while (parent[a] !== a) a = parent[a] = parent[parent[a]]; return a; };
            for (const [tk, t] of _cloudTileCache) {
                if (t.owner !== owner || !(t.energy > 0 && !t.underConstruction)) continue;
                const p = getPairedCloudTower(t, owner); if (!p) continue;
                const a = labels[tk], b = labels[p.gy * w + p.gx]; if (a < 0 || b < 0) continue;
                const ra = find(a), rb = find(b); if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
            }
            for (let i = 0; i < n; i++) if (labels[i] >= 0) labels[i] = find(labels[i]);
            return labels;
        };
        const free = (gx, gy) => { const c = grid[gy] && grid[gy][gx]; return c && c.type !== TYPE_WALL && !c.item && !getTileEntityRef(gx, gy); };
        const spot = () => [2 + Math.floor(rnd() * (GRID_W - 4)), 2 + Math.floor(rnd() * (GRID_H - 4))];
        let checks = 0, portals = 0, bad = '';
        const check = why => {
            for (const owner of [0, 1]) {
                const kept = getPathRegions(owner), d = same(kept, fresh(owner));
                checks++;
                if (d && !bad) bad = why + ' owner ' + owner + ': ' + d;
            }
        };
        check('start');
        for (let k = 0; k < 160 && !bad; k++) {
            const op = rnd();
            if (op < 0.35) {
                // A pair of portals somewhere (one end walled in, sometimes).
                const pair = Math.floor(rnd() * 3), owner = rnd() < 0.7 ? 0 : 1;
                for (const end of ['a', 'b']) {
                    const [gx, gy] = spot();
                    if (!free(gx, gy)) continue;
                    if (placeBuilding(gx, gy, 'cloud_' + pair + end, owner, { ignorePlacementRules: true, silent: true })) {
                        portals++;
                        const t = getTileEntityRef(gx, gy); if (t && rnd() < 0.8) { t.underConstruction = false; t.energy = Math.max(1, t.energy || 200); }
                        if (rnd() < 0.3) for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) { const c = grid[gy + dy] && grid[gy + dy][gx + dx]; if (c && free(gx + dx, gy + dy)) { c.type = TYPE_WALL; simMoveTileTypeChanged(gx + dx, gy + dy); } }
                    }
                }
                _bumpPathTopologyVersion();
            } else if (op < 0.5) {
                // A portal destroyed (or finished).
                const clouds = towers.filter(t => t.baseStats && t.baseStats.isCloud);
                if (clouds.length) { const t = clouds[Math.floor(rnd() * clouds.length)]; if (t.underConstruction) t.underConstruction = false; else t.energy = 0; _bumpPathTopologyVersion(); }
            } else {
                // A wall changed.
                const [gx, gy] = spot(), c = grid[gy][gx];
                if (c.item || getTileEntityRef(gx, gy)) continue;
                c.type = c.type === TYPE_WALL ? TYPE_FLOOR : TYPE_WALL;
                simMoveTileTypeChanged(gx, gy);
            }
            check('change ' + k);
        }
        return { checks, portals, bad, rebuilds: _pathRegions.rebuilds };
    })())`));
    assert.equal(r.bad, '', map);
    assert.ok(r.portals > 10, map + ' portals ' + r.portals);
    console.log(map, r.checks, 'checks,', r.portals, 'portals,', r.rebuilds, 'plain rebuilds, partitions equal');
}
console.log('PASS: path regions with portals');
