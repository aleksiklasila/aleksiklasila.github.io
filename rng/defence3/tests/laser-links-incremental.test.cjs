// Laser links worked out incrementally (things_utils.js
// _laserLinksIncremental: the lines through the rows and columns a change
// touched) equal the full recompute, and the beam map kept from the tile
// journal and link changes (tower.js laserBeamsTick) equals one made anew:
// lasers of both players placed, built, levelled, destroyed, other towers
// and floor items put down and removed on their beams, every tick.
//   node tests/laser-links-incremental.test.cjs
'use strict';
const assert = require('node:assert/strict');
const H = require('./net-harness.cjs');
const world = new H.World({ controls: { ...H.SMALL_MATCH_CONTROLS, 'cfg-mapsize': '120', 'cfg-map-type': 'arena' } });
const inst = world.spawn('lzinc', { simWorker: false });
inst.eval('startSoloGame();');
const r = JSON.parse(inst.eval(`JSON.stringify((() => {
    let s = 7;
    const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
    const free = (gx, gy) => { const c = grid[gy] && grid[gy][gx]; return c && c.type === TYPE_FLOOR && !c.item && !getTileEntityRef(gx, gy) && !getGoldMineAt(gx, gy); };
    // (Built as construction ends: a tower's tile a wall from then, structureWallSync.)
    const built = (e, lvl) => { e.underConstruction = false; structureWallSync(e); e.buildProgress = 1; e.stacks = e.effectiveStacks = getRequiredStacksForLevel(lvl); e.level = e.effectiveLevel = e.potentialEffectiveLevel = lvl; e.updateStats(); e.energy = e.maxEnergy; };
    const sig = () => _laserTowerList().map(t => t.gx + ',' + t.gy + ':' + (t.connectedLasers || []).map(o => o.gx + ',' + o.gy).join(' ')).join('|');
    // (The beam map: heap tables (tower.js _laserEnsure; laser.rs), each live
    // beam its two lasers' tiles, owner and damage; order-free, as the beams'
    // places differ between kept and remade maps. The structures on a beam's
    // tiles are the tile effects' pass's, each tick.)
    const mapSig = () => { const M = _laserMap, out = []; for (let b = 0, n = M.hdr[1]; b < n; b++) if (M.blive[b]) out.push(Math.min(M.ba[b], M.bb[b]) + '-' + Math.max(M.ba[b], M.bb[b]) + ':' + M.bown[b] + ':' + M.bdmg[b].toFixed(4)); return out.sort().join('|'); };
    const beamCount = () => { const M = _laserMap; let n = 0; for (let b = 0, e = M.hdr[1]; b < e; b++) if (M.blive[b]) n++; return n; };
    // Rows and columns of lasers, with gaps for other things.
    const lasers = [];
    for (let k = 0; k < 160; k++) {
        const line = k % 8, along = 10 + Math.floor(k / 8) * 4, gx = line < 4 ? along : 20 + line * 9, gy = line < 4 ? 20 + line * 9 : along;
        if (!free(gx, gy) || !placeBuilding(gx, gy, 'laser', k % 3 === 0 ? 1 : 0, { ignorePlacementRules: true, silent: true })) continue;
        const t = getTileEntityRef(gx, gy); if (t) { built(t, 3 + (k % 5)); lasers.push(t); }
    }
    recalculateLaserConnections(); laserBeamsTick();
    let bad = '', checks = 0, beamsSeen = 0, changes = 0;
    for (let tick = 0; tick < 150 && !bad; tick++) {
        // Changes: a laser destroyed or placed, a level changed, another
        // tower or a trap on a line, one removed.
        for (let c = 0; c < 4; c++) {
            const roll = rnd(), L = _laserTowerList();
            if (roll < 0.25 && L.length) { destroyBuilding(L[Math.floor(rnd() * L.length)]); changes++; }
            else if (roll < 0.5) { const gx = 8 + Math.floor(rnd() * 100), gy = [20, 29, 38, 47][Math.floor(rnd() * 4)]; if (free(gx, gy) && placeBuilding(gx, gy, 'laser', rnd() < 0.5 ? 0 : 1, { ignorePlacementRules: true, silent: true })) { const t = getTileEntityRef(gx, gy); if (t && rnd() < 0.7) built(t, 2 + Math.floor(rnd() * 8)); changes++; } }
            else if (roll < 0.7 && L.length) { const t = L[Math.floor(rnd() * L.length)]; built(t, 1 + Math.floor(rnd() * 10)); t.laserCheck(); changes++; }
            else if (roll < 0.85) { const gx = 8 + Math.floor(rnd() * 100), gy = [20, 29, 38, 47][Math.floor(rnd() * 4)]; if (free(gx, gy) && placeBuilding(gx, gy, rnd() < 0.5 ? 'pistol' : 'lava', 1, { ignorePlacementRules: true, silent: true })) changes++; }
            else { const T = towers.filter(t => t.type !== 'laser'); if (T.length) { destroyBuilding(T[Math.floor(rnd() * T.length)]); changes++; } }
        }
        gameTick();
        // The incremental links (made in the tick) against the full recompute.
        ensureLaserConnections(); laserBeamsTick();
        const inc = sig(), incMap = mapSig();
        recalculateLaserConnections(); _laserMap.stale = true; laserBeamsTick();
        const full = sig(), fullMap = mapSig();
        checks++; beamsSeen += beamCount();
        if (inc !== full) bad = 'tick ' + tick + ': links differ';
        else if (incMap !== fullMap) bad = 'tick ' + tick + ': beam map differs';
    }
    return { bad, checks, changes, lasers: _laserTowerList().length, beamsSeen };
})())`));
console.log(JSON.stringify(r));
assert.equal(r.bad, '', r.bad);
assert.ok(r.beamsSeen > 100, 'beams formed: ' + r.beamsSeen);
console.log('PASS: incremental laser links and the kept beam map equal a full recompute (' + r.checks + ' ticks, ' + r.changes + ' changes)');
process.exit(0);
