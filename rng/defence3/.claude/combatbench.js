// Engagement checks: do idle / ordered units fight enemies next to them?
//   await (0,eval)(await (await fetch('/rng/defence3/.claude/combatbench.js')).text());
//   await CB.setup()        // 40x40 arena (areas intact), no starting units
//   CB.all()                // every scenario; per side: damage dealt, first hit tick
// Uses the page's own simulation (gameTick). Positions are chosen from the
// area layout, so area borders are exercised explicitly.
(() => {
const sleep = ms => new Promise(r => setTimeout(r, ms));
function spawn(type, owner, wx, wy) {
    const u = new Unit(type, owner, wx, wy);
    applyUnitLevelScaling(u, 1); u.energy = u.preComputed.maxEnergy;
    units.push(u); players[owner].popCount++; updateUnitSpatial(u);
    return u;
}
function clearUnits() {
    for (const u of units) u.dead = true;
    for (let i = 0; i < 3; i++) gameTick();
}
function floor(gx, gy) { const c = grid[gy] && grid[gy][gx]; return c && c.type !== TYPE_WALL && !c.item && !getGoldMineAt(gx, gy) && !getAstarMineAt(gx, gy); }
// Horizontal pairs of floor tiles in adjacent areas, away from the map edge.
function borders(limit = 40) {
    const out = [];
    for (let gy = 4; gy < GRID_H - 4 && out.length < limit; gy++) for (let gx = 4; gx < GRID_W - 5 && out.length < limit; gx++) {
        const a = getAreaIdAtTile(gx, gy), b = getAreaIdAtTile(gx + 1, gy);
        if (a < 0 || b < 0 || a === b || !floor(gx, gy) || !floor(gx + 1, gy)) continue;
        if (getAreaDistance(a, b) !== 1) continue;
        // Keep a little room on both sides.
        if (getAreaIdAtTile(gx - 1, gy) !== a || getAreaIdAtTile(gx + 2, gy) !== b) continue;
        out.push({ gx, gy, a, b });
    }
    return out;
}
function run(setupFn, ticks = 400) {
    clearUnits();
    const made = setupFn();
    const start = gameTime;
    const hp0 = new Map(made.map(u => [u, u.energy]));
    let firstHit = [null, null];
    for (let t = 0; t < ticks; t++) {
        gameOver = false;
        _setPlayerResourceValue(0, 'astar', 1e9); _setPlayerResourceValue(1, 'astar', 1e9);
        gameTick();
        for (const u of made) {
            if (firstHit[u.owner] === null && (u.dead || u.energy < hp0.get(u))) firstHit[u.owner] = gameTime - start;
        }
        if (made.filter(u => !u.dead && u.owner === 0).length === 0 || made.filter(u => !u.dead && u.owner === 1).length === 0) break;
    }
    const side = o => {
        const own = made.filter(u => u.owner === o);
        return { alive: own.filter(u => !u.dead).length, of: own.length, dmgTaken: Math.round(own.reduce((s, u) => s + hp0.get(u) - Math.max(0, u.dead ? 0 : u.energy), 0)),
            firstHitAt: firstHit[o], states: own.filter(u => !u.dead).map(u => `${u.unitType}:${u.commandState}${u.targetUnit ? '>' + u.targetUnit.unitType : ''}`).join(' ') };
    };
    return { ticks: gameTime - start, p0: side(0), p1: side(1) };
}
const CB = {
    borders, spawn, run,
    // Cells of the largest area, sorted by distance from its first cell.
    areaCells() {
        let best = null, bestCells = null;
        for (const a of areas) {
            if (!a.cells || a.minGx < 2 || a.minGy < 2 || a.maxGx > GRID_W - 3 || a.maxGy > GRID_H - 3) continue;
            const cells = a.cells.filter(c => floor(c.x, c.y));
            if (!best || cells.length > bestCells.length) { best = a; bestCells = cells; }
        }
        const c0 = bestCells[0];
        return bestCells.sort((p, q) => (Math.abs(p.x - c0.x) + Math.abs(p.y - c0.y)) - (Math.abs(q.x - c0.x) + Math.abs(q.y - c0.y)));
    },
    async setup({ size = 40 } = {}) {
        const set = (id, v) => { const e = document.getElementById(id); if (e) { e.value = String(v); e.dispatchEvent(new Event('change')); } };
        set('cfg-mapsize', size); set('cfg-map-type', 'arena'); set('cfg-full-vis', 'team'); set('cfg-max-pop', 5000);
        set('cfg-starting-energy', 1e9); set('cfg-starting-astar', 1e9);
        startingResourcesConfig = { researchLevels: {}, spawnCounts: {} };
        [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Play Solo').click();
        await sleep(1200);
        if (typeof netStopBackgroundTicker === 'function') netStopBackgroundTicker();
        _backgroundTickInterval = null;
        refreshBackgroundTickMode = () => {};
        // Remove the bases (and their king) so only the scenario's units act.
        for (const list of [towers, barracks, collectorSpawners]) for (const b of list.slice()) destroyBuilding(b);
        for (const it of getCellItemsRowMajor().slice()) destroyBuilding(it);
        clearUnits();
        return { areas: areas.length, borders: borders().length };
    },
    scenarios() {
        const bs = borders();
        const B = (i) => bs[i % bs.length];
        const at = (gx, gy, fx = .5, fy = .5) => [(gx + fx) * TILE, (gy + fy) * TILE];
        return {
            // Same area, 1v1, a few pixels apart.
            sameArea1v1: () => { const b = B(0); return [spawn('norm', 0, ...at(b.gx - 1, b.gy)), spawn('norm', 1, ...at(b.gx, b.gy))]; },
            // Across an area border, touching.
            border1v1: () => { const b = B(1); return [spawn('norm', 0, ...at(b.gx, b.gy, .6)), spawn('norm', 1, ...at(b.gx + 1, b.gy, .5))]; },
            borderTank1v1: () => { const b = B(2); return [spawn('tank', 0, ...at(b.gx, b.gy, .6)), spawn('boss', 1, ...at(b.gx + 1, b.gy, .6))]; },
            // The reported case: one laser caster against a king group.
            laserVsKingGroup: () => { const b = B(3); return [spawn('laser_resistant', 0, ...at(b.gx, b.gy, .5)),
                spawn('king', 1, ...at(b.gx + 1, b.gy, .6)), spawn('norm', 1, ...at(b.gx + 1, b.gy + 1, .6)), spawn('fire_resistant', 1, ...at(b.gx + 2, b.gy, .5))]; },
            oneVsFew: () => { const b = B(4); return [spawn('norm', 0, ...at(b.gx, b.gy)), ...[0, 1, 2].map(k => spawn('norm', 1, ...at(b.gx + 1 + (k & 1), b.gy - 1 + k)))]; },
            // Visible across a border: a king (vision 1 area) sees a soldier in
            // the next area; its attack range is its own area only.
            borderKingSeesNorm: () => { const b = B(6); return [spawn('king', 0, ...at(b.gx - 1, b.gy, .5)), spawn('norm', 1, ...at(b.gx + 1, b.gy, .4))]; },
            borderKingOrdered: () => { const b = B(7); const made = [spawn('laser_resistant', 0, ...at(b.gx - 1, b.gy, .5)), spawn('king', 1, ...at(b.gx + 1, b.gy, .3))];
                processActions([{ action: 'attack', unitIds: [made[0].id], targetId: made[1].id, targetX: made[1].x, targetY: made[1].y }], 0); return made; },
            flyerSeesGround: () => { const b = B(8); return [spawn('flying', 0, ...at(b.gx - 1, b.gy, .5)), spawn('tank', 1, ...at(b.gx + 1, b.gy, .3))]; },
            // Inside one area (the reported case was not at a border).
            laserVsKingSameArea: () => { const c = CB.areaCells(); return [spawn('laser_resistant', 0, ...at(c[0].x, c[0].y)),
                spawn('king', 1, ...at(c[3].x, c[3].y)), spawn('norm', 1, ...at(c[4].x, c[4].y)), spawn('fire_resistant', 1, ...at(c[5].x, c[5].y))]; },
            laserVsKingOrdered: () => { const c = CB.areaCells(); const made = [spawn('laser_resistant', 0, ...at(c[0].x, c[0].y)),
                spawn('king', 1, ...at(c[3].x, c[3].y)), spawn('norm', 1, ...at(c[4].x, c[4].y)), spawn('fire_resistant', 1, ...at(c[5].x, c[5].y))];
                processActions([{ action: 'attack', unitIds: [made[0].id], targetId: made[1].id, targetX: made[1].x, targetY: made[1].y }], 0); return made; },
            sameArea1vFew: () => { const c = CB.areaCells(); return [spawn('laser_resistant', 0, ...at(c[0].x, c[0].y)), ...[4, 5, 6].map(k => spawn('norm', 1, ...at(c[k].x, c[k].y)))]; },
            mixed10v10: () => {
                const b = B(5), made = [], types = ['norm', 'fast', 'tank', 'fire_resistant', 'laser_resistant', 'mole', 'flying', 'boss', 'ice_resistant', 'king'];
                types.forEach((t, k) => { made.push(spawn(t, 0, ...at(b.gx - 2 + (k % 3), b.gy - 2 + Math.floor(k / 3), .3, .4))); made.push(spawn(t, 1, ...at(b.gx + 1 + (k % 3), b.gy - 2 + Math.floor(k / 3), .7, .6))); });
                return made;
            }
        };
    },
    all(ticks = 400) {
        const out = {};
        for (const [name, fn] of Object.entries(CB.scenarios())) out[name] = run(fn, ticks);
        return out;
    }
};
window.CB = CB;
return 'CB ready';
})();
