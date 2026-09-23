// Local presentation memory. Never serialized into, or read by, lockstep.
let teamVisibilityHistory = false;
let visibilityHistoryState = null;
const historyListNames = ['units', 'towers', 'barracks', 'collectorSpawners', 'goldMines', 'astarMines', 'droppedItems'];
// At gamma 1.8, .14 retains ~24% ground brightness (was ~47% at .30).
const HISTORY_LIGHT_FLOOR = .14;

function getRenderGameTime() { return gameTime; }
function getTeamLightingGrid() { return visibilityGrid; }
function getLiveRenderView() {
    return { grid, units, towers, barracks, collectorSpawners, goldMines, astarMines, droppedItems, projectiles, particles, visibilityGrid };
}

function cloneHistoryThing(source, seen = new Map(), depth = 0, reuse = null) {
    if (!source || typeof source !== 'object') return source;
    // Canvas/Path2D sprites are immutable cache assets, not gameplay state.
    let proto = Object.getPrototypeOf(source);
    if (proto && proto.constructor && proto.constructor.name !== 'Object' && !Array.isArray(source) && depth > 0) return source;
    if (seen.has(source)) return seen.get(source);
    let copy = reuse && Object.getPrototypeOf(reuse) === proto ? reuse : Array.isArray(source) ? [] : Object.create(proto);
    seen.set(source, copy);
    for (let key of Object.keys(source)) {
        let value = source[key];
        // Entity links must not lead from memory back into the live world.
        if (['targetUnit', 'targetBuilding', 'attackTarget', 'workerTarget', 'preferredTarget', 'rallyTargetUnit', '_spatialChunk', 'path'].includes(key)) { copy[key] = null; continue; }
        if (key === 'connectedLasers') { copy[key] = []; continue; }
        copy[key] = value && typeof value === 'object' && depth < 3 ? cloneHistoryThing(value, seen, depth + 1, copy[key]) : value;
    }
    if (Array.isArray(source)) copy.length = source.length;
    return copy;
}

function getHistoryTile(e) {
    let x = Number.isFinite(e.x) ? Math.floor(e.x / TILE) : e.gx;
    let y = Number.isFinite(e.y) ? Math.floor(e.y / TILE) : e.gy;
    return { x, y, key: y * GRID_W + x };
}

function updateVisibilityHistory() {
    if (!teamVisibilityHistory || fullVisibility || !grid.length) return;
    let h = visibilityHistoryState;
    if (!h || h.sourceGrid !== grid || h.player !== localPlayerId || gameTime < h.tick) {
        h = visibilityHistoryState = { sourceGrid: grid, player: localPlayerId, tick: -1, version: -1,
            explored: new Uint8Array(GRID_W * GRID_H), cells: grid.map(row => row.map(() => null)),
            light: grid.map(() => new Float32Array(GRID_W)), lists: {}, view: { grid: grid.map(row => row.slice()) }, background: null, minimap: null };
        for (let name of historyListNames) h.lists[name] = new Map();
    }
    if (h.version === visibilityVersion) return;
    let raw = getRawVisibilityGridForPlayer(localPlayerId);
    h.raw = raw; h.tick = gameTime; h.version = visibilityVersion;
    const visible = (x, y) => !!(raw[y] && raw[y][x] > 0);
    for (let y = 0; y < GRID_H; y++) for (let x = 0; x < GRID_W; x++) {
        if (visible(x, y)) {
            h.explored[y * GRID_W + x] = 1;
            let cell = grid[y][x];
            let saved = h.cells[y][x] || (h.cells[y][x] = {});
            let item = cell.item ? cloneHistoryThing(cell.item, new Map(), 0, saved.item) : null;
            Object.assign(saved, cell, { item });
            if (item) { item._historyTick = gameTime; item._historyGhost = true; }
        }
        let current = (visibilityGrid[y] && visibilityGrid[y][x]) || 0;
        let normalized = Math.max(0, Math.min(1, current / VISIBILITY_LIGHT_NORMALIZATION_RANGE));
        // Lift only the dark tail, without the flat plateau/hard slope change
        // of max(light, floor). Physical shadow gradients use the team field.
        h.light[y][x] = h.explored[y * GRID_W + x]
            ? current + VISIBILITY_LIGHT_NORMALIZATION_RANGE * HISTORY_LIGHT_FLOOR * Math.pow(1 - normalized, 3)
            : current;
        h.view.grid[y][x] = visible(x, y) ? grid[y][x] : h.cells[y][x] || grid[y][x];
    }
    let live = { units, towers, barracks, collectorSpawners, goldMines, astarMines, droppedItems };
    let view = h.view;
    view.visibilityGrid = h.light;
    for (let name of historyListNames) {
        let memory = h.lists[name];
        // Clear by last-seen position, not live position: an unseen death or
        // movement must not reveal itself. Seeing the old tile clears ghosts.
        let refreshed = new Set();
        let shown = [];
        for (let e of live[name]) {
            let p = getHistoryTile(e);
            if (!visible(p.x, p.y) || e.dead || e.energy <= 0) continue;
            let key = e.id != null ? 'id:' + e.id : 'tile:' + p.key;
            let copy = cloneHistoryThing(e, new Map(), 0, memory.get(key));
            copy.prevX = copy.x; copy.prevY = copy.y;
            copy._historyTick = gameTime; copy._historyGhost = true;
            // Scalar identities avoid retaining dead simulation objects and
            // their target/path graphs, while preventing trails of copies.
            memory.set(key, copy); refreshed.add(key); shown.push(e);
        }
        for (let [key, e] of memory) {
            if (refreshed.has(key)) continue;
            let p = getHistoryTile(e);
            if (visible(p.x, p.y)) memory.delete(key);
            else shown.push(e);
        }
        view[name] = shown;
    }
    // Effects are ephemeral: hidden live projectiles/particles cannot leak
    // through explored terrain just because its presentation light is nonzero.
    view.projectiles = projectiles.filter(e => { let p = getHistoryTile(e); return visible(p.x, p.y); });
    view.particles = particles.filter(e => { let p = getHistoryTile(e); return visible(p.x, p.y); });
    h.view = view;
}

function getHistoryRenderView() {
    return teamVisibilityHistory && !fullVisibility && visibilityHistoryState ? visibilityHistoryState.view : null;
}

function getRenderVisibilityGrid() {
    let view = getHistoryRenderView();
    return view ? view.visibilityGrid : visibilityGrid;
}

function getHistoryAudioGrid(source, key) {
    let h = teamVisibilityHistory && !fullVisibility && visibilityHistoryState;
    if (!h || !source) return source;
    if (!h.audio) h.audio = new Map();
    let cached = h.audio.get(key);
    if (!cached) { cached = { version: -1, rows: grid.map(() => new Float32Array(GRID_W)) }; h.audio.set(key, cached); }
    if (cached.version !== h.version) {
        for (let y = 0; y < GRID_H; y++) for (let x = 0; x < GRID_W; x++) {
            cached.rows[y][x] = h.raw[y] && h.raw[y][x] > 0 && source[y] ? source[y][x] || 0 : 0;
        }
        cached.version = h.version;
    }
    return cached.rows;
}

function getHistoryBackground(source, minimap = false) {
    let h = teamVisibilityHistory && !fullVisibility && visibilityHistoryState;
    if (!h || !source) return source;
    let key = minimap ? 'minimap' : 'background';
    let cache = h[key];
    // Stable dimensions across zoom/mipmap and 2D/3D switches. Reallocating
    // when the source mip changes would erase off-screen explored terrain.
    let pixelsPerTile = Math.max(1, Math.min(TILE, Math.floor(2048 / Math.max(GRID_W, GRID_H))));
    let width = minimap ? source.width : GRID_W * pixelsPerTile;
    let height = minimap ? source.height : GRID_H * pixelsPerTile;
    if (!cache || cache.canvas.width !== width || cache.canvas.height !== height) {
        let canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
        cache = h[key] = { canvas, ctx: canvas.getContext('2d'), version: -1 };
        cache.ctx.fillStyle = '#000'; cache.ctx.fillRect(0, 0, width, height);
    }
    if (cache.version === h.version) return cache.canvas;
    // Copy visible horizontal runs only. Cost is bounded by map rows/edges,
    // independent of zoom, unit count, and the size of a newly hidden area.
    for (let y = 0; y < GRID_H; y++) {
        let start = -1;
        for (let x = 0; x <= GRID_W; x++) {
            let visible = x < GRID_W && h.raw[y] && h.raw[y][x] > 0;
            if (visible && start < 0) start = x;
            if (!visible && start >= 0) {
                let left = Math.round(start * width / GRID_W), right = Math.round(x * width / GRID_W);
                let top = Math.round(y * height / GRID_H), bottom = Math.round((y + 1) * height / GRID_H);
                cache.ctx.drawImage(source, start * source.width / GRID_W, y * source.height / GRID_H,
                    (x - start) * source.width / GRID_W, source.height / GRID_H,
                    left, top, right - left, bottom - top);
                start = -1;
            }
        }
    }
    cache.version = h.version;
    return cache.canvas;
}
