// Mixed workload used by chaos-spikes.bench.cjs. Originally developed for
// .claude/tickbench.cjs (CHAOS=queue|mixed), evaluated in
// every peer at the same tick (setup) and as each peer's player's commands
// (bursts): lots of different things happening at once, to find tick spikes
// and slow paths no single-purpose bench shows.
//
// CHAOS=queue (tests/chaos-queue-600.json): per team CHAOS_BUILDINGS (5000)
//   barracks and worker buildings on a lattice over the team's half, a
//   healer building every 10th, labs among them; collector buildings (energy
//   and astar) beside the mines with their collectors at work; every
//   building leveled up (CHAOS_LEVEL, 6) and its queue full (barracks 20,
//   worker buildings 10: the game's caps); the healers spread over the
//   buildings; researchers (level 9) with the research stats raised and the
//   research queue full of cheap and dear stats; 30 rally points over the
//   map; tower sites under construction for the builders, some marked for
//   salvage.
// CHAOS=mixed (tests/chaos-mixed-600.json): the same with the buildings in
//   each team's outer third, and the armies (30k a team) in thick lines
//   across the middle third, between rows of towers and floor traps,
//   attack-moving into each other.
// Bursts (CHAOS_BURSTS, default 20, CHAOS_GAP ms apart, default 1000): each
// peer tops queues up (at most ~200 actions a packet), moves rally points,
// queues research, places towers for the builders, and in mixed sends the
// armies' orders by turns.
'use strict';

// (Evaluated in the game's context: game globals only, no closures.)
function chaosSetup(o) {
    let seed = 777;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    const W = GRID_W, H = GRID_H, np = players.length;
    const st = { buildings: [0, 0], collectorBuildings: [0, 0], queued: 0, research: 0, rallies: 0, towerSites: [0, 0], salvage: 0, army: [0, 0], traps: 0, armyTowers: 0, healersPlaced: 0, errors: [] };
    const free = (gx, gy) => { if (gx < 2 || gy < 2 || gx >= W - 2 || gy >= H - 2) return false; const c = grid[gy][gx]; return c.type === TYPE_FLOOR && !c.item && !getTileEntityRef(gx, gy) && !getGoldMineAt(gx, gy); };
    const entityAt = (gx, gy) => getTileEntityRef(gx, gy) || (grid[gy][gx] && grid[gy][gx].item) || null;
    // As main.js completeStarterBuilding: built, at a level, full.
    const complete = (item, key, owner, lvl) => {
        const stacks = getRequiredStacksForLevel(lvl);
        item.stacks = stacks; item.effectiveStacks = stacks; item.level = lvl; item.effectiveLevel = lvl; item.potentialEffectiveLevel = lvl;
        item.underConstruction = false; if (typeof structureWallSync === 'function') structureWallSync(item); item.isUpgrading = false; upkeepThingDirty(item);
        if (item instanceof Tower) item.updateStats();
        else {
            const calcType = item.type === 'barrack' ? 'barrack_' + item.unitType : key, s = calculateItemStats(calcType, lvl, owner);
            if (Number.isFinite(s.maxEnergy)) { item.maxEnergy = Math.max(1, Math.floor(s.maxEnergy)); item.energy = item.maxEnergy; }
            if (Number.isFinite(s.damage)) item.damage = s.damage;
            if (item.spawnCooldown !== undefined) item.spawnCooldown = Math.round(getBarrackSpawnCooldown(getSpawnerFallbackUnitType(item), lvl, owner, item.type === 'barrack' ? 'barrack_' + item.unitType : item.type) * TICK_RATE);
        }
        updateItemTextCache(item);
        if (typeof visCoverOnBuildingChanged === 'function') visCoverOnBuildingChanged(item);
    };
    const place = (gx, gy, key, p, built = true, lvl = o.level) => {
        if (!free(gx, gy)) return null;
        if (!placeBuilding(gx, gy, key, p, { ignorePlacementRules: true, silent: true, autoUpgradeEnabled: true, buildEnabled: true })) return null;
        const e = entityAt(gx, gy);
        if (e && built) complete(e, key, p, lvl);
        return e;
    };
    const freeNear = (gx, gy, r) => { for (let d = 1; d <= r; d++) for (let dy = -d; dy <= d; dy++) for (let dx = -d; dx <= d; dx++) { if (Math.max(Math.abs(dx), Math.abs(dy)) !== d) continue; if (free(gx + dx, gy + dy)) return { gx: gx + dx, gy: gy + dy }; } return null; };
    const put = (u, gx, gy) => { const t = findNearestWalkable(Math.max(1, Math.min(W - 2, gx)), Math.max(1, Math.min(H - 2, gy))); u.x = u.prevX = t.x * TILE + 16; u.y = u.prevY = t.y * TILE + 16; updateUnitSpatial(u); u._workerNextIdleRetargetTick = gameTime; u._idleFailVer = -1; };
    // Each team's band of rows for its buildings (queue: its half; mixed and
    // mega: its outer third, the armies between).
    const battle = o.mode === 'mixed' || o.mode === 'mega';
    const band = p => battle ? (p === 0 ? [4, Math.floor(H / 3) - 4] : [Math.floor(2 * H / 3) + 4, H - 4]) : (p === 0 ? [4, Math.floor(H / 2) - 3] : [Math.floor(H / 2) + 3, H - 4]);
    const barrackKeys = BUILD_CATEGORIES.barracks.filter(k => BASE_CARD_TYPES[k]);
    const workerKeys = ['builder_spawner', 'salvager', 'research', 'builder_spawner', 'research'].filter(k => BASE_CARD_TYPES[k]);
    const towerKeys = BUILD_CATEGORIES.towers.filter(k => k !== 'watch_tower' && BASE_CARD_TYPES[k]);
    const trapKeys = ['lava', 'poison_puddle', 'ice_patch', 'water_puddle', 'sand', 'mine'].filter(k => BASE_CARD_TYPES[k]);
    const built = [[], []];
    for (let p = 0; p < Math.min(2, np); p++) {
        // Collector buildings by the mines of the team's band, the collectors at them.
        const [y0, y1] = band(p);
        const mine = units.filter(u => !u.dead && u.owner === p);
        for (const cfg of RESOURCE_TYPE_LIST) {
            const mines = (_getResourceCollectorMineArray(cfg) || []).filter(m => m && m.gy >= y0 && m.gy < y1);
            const cols = mine.filter(u => u.workerType === cfg.collectorUnitKey);
            let ci = 0;
            for (let i = 0; i < mines.length && st.collectorBuildings[p] < o.collectorBuildings; i += 3) {
                const at = freeNear(mines[i].gx, mines[i].gy, 3);
                if (!at) continue;
                const e = place(at.gx, at.gy, cfg.collectorBuildingKey, p);
                if (!e) continue;
                st.collectorBuildings[p]++; built[p].push(e);
                for (let k = 0; k < 4 && ci < cols.length; k++) put(cols[ci++], mines[(i + k) % mines.length].gx, mines[(i + k) % mines.length].gy);
            }
        }
        // The lattice: every 3rd tile, a healer building every 10th.
        let k = 0;
        for (let gy = y0 + 1; gy < y1 && st.buildings[p] < o.buildings; gy += 3) for (let gx = 4 + (gy % 2); gx < W - 4 && st.buildings[p] < o.buildings; gx += 3) {
            if (rnd() < 0.08) continue;
            const key = k % 10 === 9 ? 'healer_spawner' : k % 10 >= 7 ? workerKeys[(k / 10 | 0) % workerKeys.length] : barrackKeys[(k * 7 + (k / 10 | 0)) % barrackKeys.length];
            const e = place(gx, gy, key, p);
            if (!e) continue;
            k++; st.buildings[p]++; built[p].push(e);
        }
    }
    // mega: every other kind of building too: farms beside the collector
    // buildings, area upgraders, watch towers, the cloud portal pairs; and
    // some boosts on.
    if (o.mode === 'mega') {
        st.extra = { farms: 0, upgraders: 0, watch: 0, clouds: 0, boosts: 0 };
        for (let p = 0; p < Math.min(2, np); p++) {
            const [y0, y1] = band(p);
            for (const b of built[p]) {
                const cfg = RESOURCE_TYPE_LIST.find(c => c.collectorBuildingKey === b.type);
                if (!cfg || st.extra.farms >= 400 * (p + 1)) continue;
                const at = freeNear(b.gx, b.gy, 3);
                if (at && place(at.gx, at.gy, cfg.farmKey, p)) { st.extra.farms++; built[p].push(entityAt(at.gx, at.gy)); }
            }
            for (let i = 0; i < 300; i++) {
                const gx = 4 + Math.floor(rnd() * (W - 8)), gy = y0 + Math.floor(rnd() * (y1 - y0));
                if (BASE_CARD_TYPES.watch_tower && place(gx, gy, 'watch_tower', p)) st.extra.watch++;
            }
            // Area upgrades: small areas of the band filled with houses (an
            // upgrader needs every cell built), then 1-3 levels up.
            for (let a = 0, areasDone = 0; a < areas.length && areasDone < 80; a++) {
                const cells = gridCellsByArea[a];
                if (!Array.isArray(cells) || cells.length < 2 || cells.length > 12 || !cells.every(c => c.y >= y0 && c.y < y1)) continue;
                if (!cells.every(c => entityAt(c.x, c.y) || free(c.x, c.y))) continue;
                for (const c of cells) if (!entityAt(c.x, c.y)) place(c.x, c.y, 'house', p);
                if (!cells.every(c => entityAt(c.x, c.y))) continue;
                areasDone++;
                (st.upgradeAreas || (st.upgradeAreas = [[], []]))[p].push(cells[0].x, cells[0].y);
                for (let l = 0; l <= a % 3; l++) if (placeBuilding(cells[0].x, cells[0].y, 'area_upgrader', p, { silent: true })) st.extra.upgraders++;
            }
            for (let c = 0; c < 4; c++) for (const end of ['a', 'b']) {
                const key = 'cloud_' + c + end;
                if (!BASE_CARD_TYPES[key]) continue;
                for (let tries = 0; tries < 50; tries++) {
                    const gx = end === 'a' ? 10 + Math.floor(rnd() * (W / 3)) : W - 10 - Math.floor(rnd() * (W / 3)), gy = y0 + Math.floor(rnd() * (y1 - y0));
                    if (place(gx, gy, key, p)) { st.extra.clouds++; break; }
                }
            }
            for (const [kind, key] of [['unit', 'norm'], ['unit', 'tank'], ['unit', 'healer_unit'], ['building', 'barrack_fast'], ['building', 'pistol'], ['building', 'healer_spawner']]) {
                processAction(sanitizeAction({ action: 'setBoost', kind, key, res: 'energy', steps: 1 + (st.extra.boosts % 3) }), p); st.extra.boosts++;
            }
        }
        if (typeof recalculateLaserConnections === 'function') recalculateLaserConnections();
    }
    // Research: the labs' and researchers' stats raised, the researchers at level 9 by the labs.
    const things = Object.values(RESEARCH_THINGS_BY_ID || {}).filter(t => t && t.stats && t.stats.length);
    for (let p = 0; p < Math.min(2, np); p++) {
        const levels = ensurePlayerResearchLevels(p);
        for (const t of things) if (/research/.test(String(t.key)) || /research/.test(String(t.kind))) for (const s of t.stats) levels[makeResearchLevelId(t.kind, t.key, s.statKey)] = Math.min(MAX_RESEARCH_LEVEL, 7);
    }
    rebuildPrecomputedStatsMapPlayer();
    for (let p = 0; p < Math.min(2, np); p++) {
        const labs = built[p].filter(b => b.type === 'research'), healerHomes = built[p].filter(b => b.type === 'healer_spawner' || b.type === 'barrack');
        const mine = units.filter(u => !u.dead && u.owner === p);
        mine.filter(u => u.workerType === 'researcher').forEach((u, i) => { if (labs.length) { const s = labs[i % labs.length]; put(u, s.gx + 1, s.gy); s.autoResearchEnabled = true; } });
        mine.filter(u => u.workerType === 'healer').forEach((u, i) => { if (healerHomes.length) { const b = healerHomes[(i * 7) % healerHomes.length]; put(u, b.gx + 1 + (i % 3), b.gy + ((i >> 2) % 3) - 1); st.healersPlaced++; } });
        // Research queue: as many as the labs allow, stats by turns (cheap
        // and dear: every thing and stat over the list).
        for (let i = 0; i < labs.length && i < 400; i++) {
            const t = things[(i * 13 + p) % things.length], s = t.stats[(i * 5) % t.stats.length], lab = labs[i];
            processAction(sanitizeAction({ action: 'queueResearch', gx: lab.gx, gy: lab.gy, kind: t.kind, key: t.key, statKey: s.statKey, count: 1 + (i % 4) }), p);
            st.research++;
        }
        // Queues full.
        for (const b of built[p]) {
            if (b.type === 'barrack') { processAction(sanitizeAction({ action: 'queueUnit', gx: b.gx, gy: b.gy, count: 20 }), p); st.queued++; }
            else if (b.type !== 'research') { processAction(sanitizeAction({ action: 'queueWorker', gx: b.gx, gy: b.gy, count: 10 }), p); st.queued++; }
        }
        // 30 rally points over the map (all teams' together), by turns.
        const pts = [];
        for (let r = 0; r < 30; r++) { const t = findNearestWalkable(Math.floor(W * (0.05 + 0.9 * rnd())), Math.floor(H * (0.05 + 0.9 * rnd()))); pts.push([t.x * TILE + 16, t.y * TILE + 16]); }
        const byPt = pts.map(() => []);
        built[p].forEach((b, i) => byPt[(i * 31 + (b.gx >> 3)) % pts.length].push(b.gx, b.gy));
        byPt.forEach((c, j) => { for (let q = 0; q < c.length; q += 2 * ACTION_MAX_RALLY_COORDS) { processAction(sanitizeAction({ action: 'setRallyMany', coords: c.slice(q, q + 2 * ACTION_MAX_RALLY_COORDS), targetX: pts[j][0], targetY: pts[j][1], targetUnitId: null }), p); st.rallies++; } });
        // Builders' work: tower sites under construction around the band;
        // salvagers': built towers marked for salvage.
        const [y0, y1] = band(p);
        const builders = mine.filter(u => u.workerType === 'builder'), salvagers = mine.filter(u => u.workerType === 'salvager');
        for (let i = 0; i < o.towerSites; i++) {
            const gx = 4 + Math.floor(rnd() * (W - 8)), gy = y0 + Math.floor(rnd() * (y1 - y0));
            const e = place(gx, gy, towerKeys[i % towerKeys.length], p, false);
            if (!e) continue;
            st.towerSites[p]++;
            if (builders.length) put(builders[i % builders.length], gx + 1, gy);
        }
        for (let i = 0; i < salvagers.length; i++) {
            const at = freeNear(Math.floor(salvagers[i].x / TILE), Math.floor(salvagers[i].y / TILE), 5);
            if (!at) continue;
            const e = place(at.gx, at.gy, 'pistol', p);
            if (e) { e.markedForSalvage = true; st.salvage++; }
        }
    }
    // Mixed: the armies in thick lines across the middle third (teams in
    // blocks of 4 rows, facing each other 6 rows apart), a row of towers and
    // a row of traps between every pair; then attack-move across.
    if (battle) {
        const teams = [0, 1].map(p => units.filter(u => !u.dead && u.owner === p && !u.workerType));
        // (mega: 15% of each army as raiding blocks in front of its own
        // buildings, attack-moving into the enemy's building band at points
        // spread across the map; the lines take the rest.)
        if (o.mode === 'mega') {
            st.raid = [0, 0];
            for (let p = 0; p < 2; p++) {
                const n = Math.floor(teams[p].length * 0.15), raid = teams[p].splice(0, n);
                const [by0, by1] = band(p), gy = p === 0 ? by1 + 1 : by0 - 31, groups = Math.max(1, Math.ceil(n / 900));
                for (let g = 0; g < groups; g++) {
                    const gx = 6 + Math.floor((W - 40) * (g + 0.5) / groups), ids = [];
                    for (let k = 0; k < 900; k++) { const u = raid[g * 900 + k]; if (!u) break; put(u, gx + (k % 30), gy + Math.floor(k / 30)); ids.push(u.id); }
                    const [ey0, ey1] = band(1 - p), tx = 6 + Math.floor((W - 12) * (((g * 7) % groups) + 0.5) / groups);
                    for (let q = 0; q < ids.length; q += 5000) processAction(sanitizeAction({ action: 'attackMove', unitIds: ids.slice(q, q + 5000), targetX: tx * TILE, targetY: Math.floor((ey0 + ey1) / 2) * TILE }), p);
                    st.raid[p] += ids.length;
                }
            }
        }
        const y0 = Math.floor(H / 3) + 2, y1 = Math.floor(2 * H / 3) - 2, next = [0, 0];
        let y = y0, pair = 0;
        while (y + 16 < y1 && (next[0] < teams[0].length || next[1] < teams[1].length)) {
            for (let p = 0; p < 2; p++) {
                const ys = y + p * 10;
                for (let r = 0; r < 4; r++) for (let gx = 6; gx < W - 6; gx++) { const u = teams[p][next[p]]; if (!u) break; if (grid[ys + r][gx].type === TYPE_WALL) continue; next[p]++; put(u, gx, ys + r); }
            }
            // Between the blocks: towers of both teams, then traps.
            for (let gx = 6 + (pair & 1); gx < W - 6; gx += 4) { if (place(gx, y + 5, towerKeys[(gx >> 2) % towerKeys.length], gx & 4 ? 1 : 0)) st.armyTowers++; }
            for (let gx = 7; gx < W - 6; gx += 3) { if (place(gx, y + 7, trapKeys[(gx / 3 | 0) % trapKeys.length], (gx / 3 | 0) & 1)) st.traps++; }
            y += 18; pair++;
        }
        for (let p = 0; p < 2; p++) {
            st.army[p] = next[p];
            const ids = teams[p].slice(0, next[p]).map(u => u.id);
            for (let k = 0; k < ids.length; k += 5000) processAction(sanitizeAction({ action: 'attackMove', unitIds: ids.slice(k, k + 5000), targetX: (W / 2) * TILE, targetY: (p ? 0.36 : 0.64) * H * TILE }), p);
        }
        if (typeof recalculateLaserConnections === 'function') recalculateLaserConnections();
    }
    recalculateAdjacency(true);
    st.units = units.length; st.barracks = barracks.length; st.spawners = collectorSpawners.length; st.towers = towers.length;
    st.researchQueued = [0, 1].map(p => getPlayerResearchQueueTotalLength(p));
    // (The upgraded areas, for the bursts' further upgrades: the same on
    // every peer.)
    if (st.upgradeAreas) __scratch.chaosUpgradeAreas = st.upgradeAreas;
    return st;
}

// One burst of the local player's commands (k: the burst's number).
function chaosBurst(o, k) {
    let seed = 4242 + k * 7919 + localPlayerId * 104729;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    const me = localPlayerId, W = GRID_W, H = GRID_H, out = { queue: 0, rally: 0, research: 0, place: 0, orders: 0 };
    const mineB = [...barracks, ...collectorSpawners].filter(b => b.owner === me && b.energy > 0 && !b.underConstruction);
    // Queues topped up: 150 buildings a burst, by turns over all of them.
    for (let i = 0; i < 150 && mineB.length; i++) {
        const b = mineB[(k * 150 + i) % mineB.length];
        if (b instanceof Barrack) { if (b.spawnQueue.length < 20) { queueAction({ action: 'queueUnit', gx: b.gx, gy: b.gy, count: 20 - b.spawnQueue.length }); out.queue++; } }
        else if (b.type !== 'research') { if (b.spawnQueue && b.spawnQueue.length < 10) { queueAction({ action: 'queueWorker', gx: b.gx, gy: b.gy, count: 10 - b.spawnQueue.length }); out.queue++; } }
    }
    // Every 3rd burst: the rally points moved (30 points, all buildings).
    if (k % 3 === 0) {
        const pts = [];
        for (let r = 0; r < 30; r++) { const t = findNearestWalkable(Math.floor(W * (0.05 + 0.9 * rnd())), Math.floor(H * (0.05 + 0.9 * rnd()))); pts.push([t.x * TILE + 16, t.y * TILE + 16]); }
        const byPt = pts.map(() => []);
        mineB.forEach((b, i) => byPt[(i + k) % pts.length].push(b.gx, b.gy));
        byPt.forEach((c, j) => { for (let q = 0; q < c.length; q += 2 * ACTION_MAX_RALLY_COORDS) { queueAction({ action: 'setRallyMany', coords: c.slice(q, q + 2 * ACTION_MAX_RALLY_COORDS), targetX: pts[j][0], targetY: pts[j][1], targetUnitId: null }); out.rally++; } });
    }
    // Research: 20 stats queued at labs (cheap and dear, by turns).
    const things = Object.values(RESEARCH_THINGS_BY_ID || {}).filter(t => t && t.stats && t.stats.length);
    const labs = mineB.filter(b => b.type === 'research');
    for (let i = 0; i < 20 && labs.length && things.length; i++) {
        const t = things[Math.floor(rnd() * things.length)], s = t.stats[Math.floor(rnd() * t.stats.length)], lab = labs[i % labs.length];
        queueAction({ action: 'queueResearch', gx: lab.gx, gy: lab.gy, kind: t.kind, key: t.key, statKey: s.statKey, count: 1 + (i % 3) });
        out.research++;
    }
    // New buildings for the builders: 20 towers near the player's buildings.
    const towerKeys = BUILD_CATEGORIES.towers.filter(x => x !== 'watch_tower');
    for (let i = 0; i < 20 && mineB.length; i++) {
        const b = mineB[Math.floor(rnd() * mineB.length)], gx = b.gx + Math.floor(rnd() * 7) - 3, gy = b.gy + Math.floor(rnd() * 7) - 3;
        if (gx < 2 || gy < 2 || gx >= W - 2 || gy >= H - 2 || grid[gy][gx].type !== TYPE_FLOOR || grid[gy][gx].item || getTileEntityRef(gx, gy)) continue;
        queueAction({ action: 'place', gx, gy, itemType: towerKeys[(k + i) % towerKeys.length], count: 1 }); out.place++;
    }
    // Mixed and mega: the army ordered by turns (attack-move across, then
    // move to a point, then attack-move back), a quarter of it each burst;
    // mega's every fourth burst sends that quarter raiding the enemy's
    // buildings instead.
    if (o.mode === 'mixed' || o.mode === 'mega') {
        const army = units.filter(u => !u.dead && u.owner === me && !u.workerType && u.commandState !== undefined);
        const q = k & 3, part = army.filter((u, i) => (i & 3) === q).map(u => u.id);
        const raid = o.mode === 'mega' && (k & 3) === 2;
        const tx = W * (0.1 + 0.8 * rnd()) * TILE, ty = raid ? H * (me ? 1 / 6 : 5 / 6) * TILE : H * (me ? 0.36 : 0.64) * TILE;
        if (part.length) { queueAction({ action: (k & 1) && !raid ? 'move' : 'attackMove', unitIds: part, targetX: tx, targetY: ty }); out.orders++; }
    }
    // mega: every other kind of command, a little of each a burst.
    if (o.mode === 'mega') {
        Object.assign(out, { towerTarget: 0, boost: 0, unitCmds: 0, kill: 0, toggles: 0, research: out.research });
        const foeUnits = units.filter((u, i) => (i & 63) === (k & 63) && !u.dead && u.owner !== me);
        const foeB = [...towers, ...barracks].filter((b, i) => (i & 15) === (k & 15) && b.owner !== me && b.energy > 0);
        // Towers' targets (an enemy unit, an enemy building, none, by turns).
        const myTowers = towers.filter(t => t.owner === me && t.energy > 0 && !t.underConstruction);
        if (myTowers.length) {
            const off = (k * 1013) % myTowers.length, coords = [];
            for (let i = 0; i < Math.min(2000, myTowers.length); i++) { const t = myTowers[(off + i) % myTowers.length]; coords.push({ gx: t.gx, gy: t.gy }); }
            const pick = k % 3;
            let target = null;
            if (pick === 0 && foeUnits.length) target = { type: 'unit', id: foeUnits[Math.floor(rnd() * foeUnits.length)].id };
            else if (pick === 1 && foeB.length) { const b = foeB[Math.floor(rnd() * foeB.length)]; target = { type: b instanceof Tower ? 'tower' : 'barrack', gx: b.gx, gy: b.gy }; }
            queueAction({ action: 'towerTarget', towerCoords: coords, target }); out.towerTarget++;
        }
        // A boost changed.
        const bkeys = [['unit', 'norm'], ['unit', 'fast'], ['unit', 'mole'], ['unit', 'collector'], ['building', 'barrack_tank'], ['building', 'sniper'], ['building', 'research']];
        { const [kind, key] = bkeys[k % bkeys.length]; queueAction({ action: 'setBoost', kind, key, res: k % 4 === 3 && kind === 'unit' ? 'astar' : 'energy', steps: k % 5 }); out.boost++; }
        // Small groups: hold, stop, attack a unit, attack a building, killed.
        const army = units.filter((u, i) => (i & 31) === (k & 31) && !u.dead && u.owner === me && !u.workerType && !u.isKing);
        const slice = (j, n) => army.slice(j * n, (j + 1) * n).map(u => u.id);
        if (army.length > 100) {
            queueAction({ action: 'hold', unitIds: slice(0, 200) }); queueAction({ action: 'stop', unitIds: slice(1, 200) });
            if (foeUnits.length) { const f = foeUnits[Math.floor(rnd() * foeUnits.length)]; queueAction({ action: 'attack', unitIds: slice(2, 300), targetId: f.id, targetX: f.x, targetY: f.y }); }
            if (foeB.length) { const b = foeB[Math.floor(rnd() * foeB.length)]; queueAction({ action: 'attackBuilding', unitIds: slice(3, 300), targetGx: b.gx, targetGy: b.gy }); }
            queueAction({ action: 'killUnit', unitIds: slice(4, 40) }); out.kill += 40; out.unitCmds += 4;
        }
        // Buildings' switches: salvage marks, auto-upgrade and stacking,
        // production on and off, queues shortened.
        const mineB = [...barracks, ...collectorSpawners, ...towers].filter((b, i) => (i % 97) === (k % 97) && b.owner === me);
        for (let i = 0; i < mineB.length && i < 40; i++) {
            const b = mineB[i], on = ((k >> 1) + i) & 1;
            if (i % 5 === 0) queueAction({ action: 'markSalvage', gx: b.gx, gy: b.gy });
            else if (i % 5 === 1) queueAction({ action: 'setAutoUpgrade', gx: b.gx, gy: b.gy, enabled: !!on });
            else if (i % 5 === 2) queueAction({ action: 'setAutoStack', gx: b.gx, gy: b.gy, enabled: !!on });
            else if (i % 5 === 3 && b.spawnQueue) queueAction({ action: 'setQueueEnabled', gx: b.gx, gy: b.gy, enabled: !!on });
            else if (b instanceof Barrack) queueAction({ action: 'dequeueUnit', gx: b.gx, gy: b.gy, count: 2 });
            out.toggles++;
        }
        // An upgraded area one level more (an upgrader's place order).
        const ua = ((__scratch.chaosUpgradeAreas || [])[me]) || [];
        if (ua.length) { const j = (k % (ua.length / 2)) * 2; queueAction({ action: 'place', gx: ua[j], gy: ua[j + 1], itemType: 'area_upgrader', count: 1 }); out.areaUp = 1; }
        // The research queue reordered and shortened.
        const lab = collectorSpawners.find(s => s.owner === me && s.type === 'research' && s.energy > 0);
        if (lab) {
            queueAction({ action: 'moveResearch', gx: lab.gx, gy: lab.gy, from: 1 + (k % 50), to: 1 });
            queueAction({ action: 'dequeueResearch', gx: lab.gx, gy: lab.gy, count: 3 });
            out.research += 2;
        }
    }
    return out;
}

module.exports = {
    setup: o => `(${chaosSetup.toString()})(${JSON.stringify(o)})`,
    burst: (o, k) => `(${chaosBurst.toString()})(${JSON.stringify(o)}, ${k})`,
};
