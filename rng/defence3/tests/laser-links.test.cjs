// Laser links by the kernels (laser.rs k_laser_scan / k_laser_build, tower.js
// laserBeamsTick) equal the original all-pairs computation, partners in tile
// order (gy * GRID_W + gx: the same on every peer whatever the towers' or the
// rows' order), on random layouts in a real match: mixed owners, other tower
// types in between, walls, levels 0..12 and missing levels.
//   node tests/laser-links.test.cjs
'use strict';
const assert = require('node:assert/strict');
const H = require('./net-harness.cjs');

const world = new H.World({ controls: { ...H.SMALL_MATCH_CONTROLS, 'cfg-mapsize': '60', 'cfg-map-type': 'arena' } });
const inst = world.spawn('laserlinks', { simWorker: false });
inst.eval('startSoloGame();');
const r = JSON.parse(inst.eval(`JSON.stringify((() => {
    let seed = 12345;
    const rand = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    // The original computation: every pair of one owner's lasers in a row or
    // column, no wall strictly between, 1 <= gap <= the smaller level (a
    // missing effective level: its level, else 1).
    const reference = (lasers) => {
        const out = new Map(lasers.map(t => [t, []]));
        for (let i = 0; i < lasers.length; i++) for (let j = i + 1; j < lasers.length; j++) {
            const a = lasers[i], b = lasers[j];
            if (a.owner !== b.owner || (a.gx !== b.gx && a.gy !== b.gy)) continue;
            const col = a.gx === b.gx, lo = col ? Math.min(a.gy, b.gy) : Math.min(a.gx, b.gx), hi = col ? Math.max(a.gy, b.gy) : Math.max(a.gx, b.gx);
            let blocked = false;
            for (let c = lo + 1; c < hi && !blocked; c++) if ((col ? grid[c][a.gx] : grid[a.gy][c]).type === TYPE_WALL) blocked = true;
            const lv = e => e.effectiveLevel !== undefined ? e.effectiveLevel : e.level !== undefined ? Math.max(1, e.level) : 1;
            const gap = hi - lo - 1, limit = Math.min(lv(a), lv(b));
            if (blocked || gap < 1 || gap > limit) continue;
            out.get(a).push(b); out.get(b).push(a);
        }
        for (const l of out.values()) l.sort((x, y) => (x.gy * GRID_W + x.gx) - (y.gy * GRID_W + y.gx));
        return out;
    };
    let links = 0, bad = 0, first = '', rounds = 0, lasersSeen = 0;
    const walls = [];
    for (let round = 0; round < 60; round++) {
        for (const t of towers.slice()) destroyBuilding(t);
        for (const t of walls) if (grid[(t / GRID_W) | 0][t % GRID_W].type === TYPE_WALL && !getTileEntityRef(t % GRID_W, (t / GRID_W) | 0)) { grid[(t / GRID_W) | 0][t % GRID_W].type = TYPE_FLOOR; simMoveTileTypeChanged(t % GRID_W, (t / GRID_W) | 0); }
        walls.length = 0;
        const x0 = 5, y0 = 5, W = 20 + Math.floor(rand() * 25), Hh = 20 + Math.floor(rand() * 25);
        for (let k = 0, n = Math.floor(rand() * 160); k < n; k++) {
            const gx = x0 + Math.floor(rand() * W), gy = y0 + Math.floor(rand() * Hh), c = grid[gy] && grid[gy][gx];
            if (!c || c.type !== TYPE_FLOOR || c.item || getTileEntityRef(gx, gy)) continue;
            if (rand() < 0.1) { c.type = TYPE_WALL; simMoveTileTypeChanged(gx, gy); walls.push(gy * GRID_W + gx); continue; }
            const key = rand() < 0.7 ? 'laser' : 'pistol', owner = Math.floor(rand() * 2);
            if (!placeBuilding(gx, gy, key, owner, { ignorePlacementRules: true, silent: true })) continue;
            const e = getTileEntityRef(gx, gy);
            if (!e) continue;
            e.underConstruction = false; if (typeof structureWallSync === 'function') structureWallSync(e);
            e.effectiveLevel = rand() < 0.05 ? undefined : Math.floor(rand() * 13);
        }
        const compare = (phase) => {
            laserBeamsTick();
            const lasers = towers.filter(t => t.type === 'laser');
            const want = reference(lasers);
            for (const t of lasers) {
                const got = laserPartnersOf(t).map(o => o.gy * GRID_W + o.gx).join(), exp = want.get(t).map(o => o.gy * GRID_W + o.gx).join();
                if (got !== exp) { bad++; if (!first) first = 'round ' + round + ' ' + phase + ' laser ' + t.gx + ',' + t.gy + ' lvl ' + t.effectiveLevel + ': kernel [' + got + '] reference [' + exp + ']'; }
                links += want.get(t).length;
            }
            return lasers;
        };
        const lasers = compare('placed');
        // Walls alone (no laser changes): set and cleared on the lasers' lines.
        for (let k = 0; k < 12; k++) {
            const t = lasers.length ? lasers[Math.floor(rand() * lasers.length)] : null;
            if (!t) break;
            const d = Math.floor(rand() * 4), dist = 1 + Math.floor(rand() * 6), gx = t.gx + [1, -1, 0, 0][d] * dist, gy = t.gy + [0, 0, 1, -1][d] * dist, c = grid[gy] && grid[gy][gx];
            if (!c || c.item || getTileEntityRef(gx, gy)) continue;
            c.type = c.type === TYPE_WALL ? TYPE_FLOOR : TYPE_WALL; simMoveTileTypeChanged(gx, gy);
            if (c.type === TYPE_WALL) walls.push(gy * GRID_W + gx);
        }
        compare('walls');
        lasersSeen += lasers.length; rounds++;
    }
    return { rounds, lasers: lasersSeen, links: links / 2, bad, first };
})())`));
console.log(JSON.stringify(r));
assert.equal(r.bad, 0, 'kernel links equal all-pairs links: ' + r.first);
assert.ok(r.links > 300, 'layouts produce links: ' + r.links);
console.log('PASS: kernel laser links equal all-pairs links (' + r.links + ' links, ' + r.lasers + ' lasers over ' + r.rounds + ' layouts)');
process.exit(0);
