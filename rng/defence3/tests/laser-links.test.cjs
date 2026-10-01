// Indexed laser links (things_utils.js recalculateLaserConnections) equal the
// original all-pairs computation, partner order included, on random layouts:
// mixed owners, other tower types in between, walls, levels 0..12 and
// missing levels.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const src = fs.readFileSync(path.join(__dirname, '../src/things/things_utils.js'), 'utf8');
const start = src.indexOf('const _laserLines = new Map();');
const end = src.indexOf('function _isOperationalAdjacencyEntity');
assert.ok(start >= 0 && end > start, 'laser link source found');

function reference(towers, grid, TYPE_WALL) {
    towers.forEach(t => { if (t.type === 'laser') { t.connectedLasers = []; t._laserLinkLevel = t.effectiveLevel; } });
    for (let i = 0; i < towers.length; i++) {
        let t1 = towers[i]; if (t1.type !== 'laser') continue;
        for (let j = i + 1; j < towers.length; j++) {
            let t2 = towers[j]; if (t2.type !== 'laser' || t2.owner !== t1.owner) continue;
            let aX = t1.gx === t2.gx, aY = t1.gy === t2.gy;
            if (!aX && !aY) continue;
            let blocked = false, dist;
            if (aX) { dist = Math.abs(t1.gy - t2.gy); let mn = Math.min(t1.gy, t2.gy), mx = Math.max(t1.gy, t2.gy); for (let y = mn + 1; y < mx; y++) if (grid[y][t1.gx].type === TYPE_WALL) blocked = true; }
            else { dist = Math.abs(t1.gx - t2.gx); let mn = Math.min(t1.gx, t2.gx), mx = Math.max(t1.gx, t2.gx); for (let x = mn + 1; x < mx; x++) if (grid[t1.gy][x].type === TYPE_WALL) blocked = true; }
            let gap = dist - 1, limit = Math.min(t1.effectiveLevel, t2.effectiveLevel);
            if (gap > limit || gap < 1) blocked = true;
            if (!blocked) { t1.connectedLasers.push(t2); t2.connectedLasers.push(t1); }
        }
    }
}

let seed = 12345;
const rand = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
let links = 0;
for (let round = 0; round < 300; round++) {
    const W = 8 + Math.floor(rand() * 40), H = 8 + Math.floor(rand() * 40);
    const grid = Array.from({ length: H }, () => Array.from({ length: W }, () => ({ type: rand() < 0.08 ? 1 : 0 })));
    const used = new Set(), make = () => {
        const n = Math.floor(rand() * 120), out = [];
        for (let k = 0; k < n; k++) {
            const gx = Math.floor(rand() * W), gy = Math.floor(rand() * H), key = gy * W + gx;
            if (used.has(key)) continue;
            used.add(key);
            const r = rand();
            out.push({ id: k, gx, gy, owner: Math.floor(rand() * 3), type: r < 0.7 ? 'laser' : 'basic',
                effectiveLevel: rand() < 0.05 ? undefined : Math.floor(rand() * 13) });
        }
        return out;
    };
    const towers = make();
    const copy = towers.map(t => ({ ...t }));
    const ctx = vm.createContext({ towers, grid, TYPE_WALL: 1, Map });
    vm.runInContext(src.slice(start, end) + '\nrecalculateLaserConnections();', ctx);
    reference(copy, grid, 1);
    for (let i = 0; i < towers.length; i++) {
        if (towers[i].type !== 'laser') { assert.equal(towers[i].connectedLasers, undefined); continue; }
        assert.deepEqual(Array.from(towers[i].connectedLasers, t => t.id), copy[i].connectedLasers.map(t => t.id), `round ${round} tower ${i}`);
        assert.equal(towers[i]._laserLinkLevel, copy[i]._laserLinkLevel);
        links += towers[i].connectedLasers.length;
    }
}
assert.ok(links > 1000, 'layouts produce links: ' + links);
console.log('PASS: indexed laser links equal all-pairs links (' + links / 2 + ' links over 300 layouts)');
