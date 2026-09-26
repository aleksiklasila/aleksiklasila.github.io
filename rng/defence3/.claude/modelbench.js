// Model preview helpers (browser console / preview), full visibility:
//   await (0,eval)(await (await fetch('/rng/defence3/.claude/modelbench.js')).text());
//   await MB.setup()                 // 40x40 arena, huge energy
//   MB.lineup()                      // every unit type (row) and building type (rows below)
//   MB.mass('house', 100)            // n of one building (or unit type) on a grid
//   await MB.shot('name', { zoom: 2.4, gx: 12, gy: 12, mode: '3d', frames: 3 })
// Shots POST the canvas to http://127.0.0.1:8124/save?name=... (a local
// server that writes the PNG). MB.ticks(n) advances the game.
(() => {
const sleep = ms => new Promise(r => setTimeout(r, ms));
const UNIT_TYPES = ['norm', 'fast', 'tank', 'boss', 'king', 'flying', 'scout', 'mole', 'snake', 'poison_resistant', 'fire_resistant',
    'water_resistant', 'ice_resistant', 'laser_resistant', 'builder_unit', 'collector', 'astar_collector', 'salvager_unit',
    'healer_unit', 'researcher_unit'];
function buildingKeys() {
    return Object.keys(BASE_CARD_TYPES).filter(k => k !== 'area_upgrader');
}
const MB = {
    UNIT_TYPES,
    async setup({ size = 40 } = {}) {
        const set = (id, v) => { const e = document.getElementById(id); if (e) { e.value = String(v); e.dispatchEvent(new Event('change')); } };
        set('cfg-mapsize', size); set('cfg-map-type', 'arena'); set('cfg-full-vis', 'full'); set('cfg-max-pop', 5000);
        set('cfg-starting-energy', 1e9); set('cfg-starting-astar', 1e9);
        startingResourcesConfig = { researchLevels: {}, spawnCounts: {} };
        [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Play Solo').click();
        await sleep(1200);
        if (typeof netStopBackgroundTicker === 'function') netStopBackgroundTicker();
        _backgroundTickInterval = null;
        refreshBackgroundTickMode = () => {};
        fullVisibility = true;
        for (let y = 1; y < GRID_H - 1; y++) for (let x = 1; x < GRID_W - 1; x++) {
            const c = grid[y][x];
            if (c.type === TYPE_WALL && !c.item && !getTowerAtTile(x, y) && !getGoldMineAt(x, y) && !getAstarMineAt(x, y)) c.type = TYPE_FLOOR;
        }
        _bumpPathTopologyVersion(); recalculateAdjacency();
        _markCombinedBgFullDirty && _markCombinedBgFullDirty();
        return { w: GRID_W, h: GRID_H };
    },
    place(key, owner, gx, gy) {
        const c = grid[gy] && grid[gy][gx];
        if (!c || c.item || getTowerAtTile(gx, gy) || getGoldMineAt(gx, gy) || getAstarMineAt(gx, gy)) return null;
        if (!placeBuilding(gx, gy, key, owner, { silent: true, ignorePlacementRules: true, buildEnabled: true, autoUpgradeEnabled: true })) return null;
        const item = getTileEntityRef(gx, gy);
        if (!item) return null;
        Object.assign(item, { underConstruction: false, isUpgrading: false });
        if (item instanceof Tower) item.updateStats();
        if (item.maxEnergy) item.energy = item.maxEnergy;
        updateItemTextCache(item);
        return item;
    },
    unit(type, owner, x, y) {
        const u = new Unit(type, owner, x * TILE, y * TILE);
        applyUnitLevelScaling(u, 1); u.energy = u.preComputed.maxEnergy;
        units.push(u); players[owner].popCount++; updateUnitSpatial(u);
        return u;
    },
    lineup({ gx = 4, gy = 4 } = {}) {
        UNIT_TYPES.forEach((t, i) => { if (BASE_UNIT_STATS[t]) MB.unit(t, 0, gx + .5 + (i % 10) * 1.6, gy + .5 + Math.floor(i / 10) * 1.6); });
        const keys = buildingKeys().filter(k => !['sand', 'lava', 'poison_puddle', 'ice_patch', 'water_puddle', 'mine'].includes(k));
        const placed = [];
        let slot = 0;
        for (const k of keys) {
            for (let tries = 0; tries < 40; tries++, slot++) {
                if (MB.place(k, 0, gx + (slot % 12), gy + 5 + Math.floor(slot / 12))) { placed.push(k); slot++; break; }
            }
        }
        if (typeof recalculateLaserConnections === 'function') recalculateLaserConnections();
        return { units: UNIT_TYPES.length, buildings: placed.length, missing: keys.filter(k => !placed.includes(k)) };
    },
    // n of one building key or unit type on a grid starting at (gx, gy).
    mass(key, n = 100, { gx = 3, gy = 3, cols = 12, spacing = 1, owner = 0 } = {}) {
        let made = 0;
        const isUnit = !!BASE_UNIT_STATS[key] && !BASE_CARD_TYPES[key];
        for (let i = 0; made < n && i < n * 4; i++) {
            const x = gx + (i % cols) * spacing, y = gy + Math.floor(i / cols) * spacing;
            if (isUnit) { MB.unit(key, owner, x + .5, y + .5); made++; }
            else if (MB.place(key, owner, x, y)) made++;
        }
        return made;
    },
    ticks(n = 1) { for (let i = 0; i < n; i++) { gameOver = false; gameTick(); } },
    view({ zoom = 2.4, gx = 10, gy = 10, mode = '3d', alpha = .5 } = {}) {
        setRenderDimensionMode(mode);
        camera.zoom = zoom; if (camera.targetZoom !== undefined) camera.targetZoom = zoom;
        camera.x = gx * TILE - viewW / zoom / 2; camera.y = gy * TILE - viewH / zoom / 2;
        _tickAccumulator = TICK_MS * alpha;
        renderFrame(performance.now());
    },
    // pitch/yaw (radians) override the orbit for this shot only.
    async shot(name, opts = {}) {
        const r = renderer3dInstance, saved = r ? [r.orbitPitch, r.orbitYaw] : null;
        if (r && opts.pitch !== undefined) r.orbitPitch = opts.pitch;
        if (r && opts.yaw !== undefined) r.orbitYaw = opts.yaw;
        try { return await MB._shot(name, opts); } finally { if (r) [r.orbitPitch, r.orbitYaw] = saved; }
    },
    async _shot(name, opts) {
        for (let i = 0; i < (opts.frames || 3); i++) MB.view(opts);
        const t = performance.now();
        MB.view(opts);
        const ms = performance.now() - t;
        const data = renderer3dInstance.canvas.toDataURL('image/png');
        await fetch('http://127.0.0.1:8124/save?name=' + name, { method: 'POST', body: data });
        return { name, frameMs: Math.round(ms * 100) / 100 };
    }
};
window.MB = MB;
return 'MB ready';
})();

// Stress: `n` of each key (buildings and unit types) in blocks; producing
// buildings get a queue. Returns mean/p95 CPU ms of renderFrame over frames.
(() => {
window.MB.stress = async function ({ keys = ['barrack_norm', 'barrack_tank', 'spawner', 'cloud_0a', 'farm', 'astar_farm', 'healer_unit', 'scout', 'flying', 'collector'], n = 100, frames = 120, mode = '3d', zoom = 0.9, ticks = true } = {}) {
    let bx = 2, by = 2, placed = {};
    for (const key of keys) {
        placed[key] = MB.mass(key, n, { gx: bx, gy: by, cols: 10 });
        bx += 11; if (bx > GRID_W - 12) { bx = 2; by += 11; }
    }
    for (const b of [...barracks, ...collectorSpawners]) {
        if (b.type === 'research') continue;
        b.spawnQueue = [{ unitType: getSpawnerFallbackUnitType(b), level: 1, energyRequired: 1e7, energyPaid: 0 }];
        b.spawnCooldown = 100; b.spawnTimer = (b.gx * 13 + b.gy * 7) % 100;
    }
    const times = [];
    for (let i = 0; i < frames; i++) {
        if (ticks && i % 6 === 0) MB.ticks(1);
        const t = performance.now();
        MB.view({ zoom, gx: GRID_W / 2, gy: GRID_H / 2, mode, alpha: (i % 6) / 6 });
        times.push(performance.now() - t);
    }
    times.sort((a, b) => a - b);
    const r2 = v => Math.round(v * 100) / 100;
    return { placed, mean: r2(times.reduce((a, b) => a + b, 0) / times.length), p50: r2(times[times.length >> 1]), p95: r2(times[Math.floor(times.length * .95)]), max: r2(times[times.length - 1]) };
};
})();
