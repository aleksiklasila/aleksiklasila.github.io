// Local fog presentation only. Gameplay always reads the immediate raw grid.
// Last-seen records are frozen only when something leaves the displayed area.
let teamVisibilityHistory = false;
let visibilityHistoryState = null;
const HISTORY_LIGHT_FLOOR = .14;

function getRenderGameTime() { return gameTime; }
function getTeamLightingGrid() { return visibilityGrid; }
function getLiveRenderView() {
    if (teamVisibilityHistory && !fullVisibility && visibilityHistoryState && visibilityHistoryState.view) return visibilityHistoryState.view;
    return { grid, units, towers, barracks, collectorSpawners, goldMines, astarMines, droppedItems, projectiles, particles, visibilityGrid };
}

function updateVisualVisibility(playerId, raw) {
    if (fullVisibility) {
        if (visibilityHistoryState) visibilityVersion++;
        visibilityHistoryState = null;
        return raw;
    }
    const now = gameTime, holdTicks = Math.max(1, TICK_RATE);
    let h = visibilityHistoryState;
    const reset = !h || h.sourceGrid !== grid || h.player !== playerId
        || h.width !== GRID_W || h.height !== GRID_H;
    if (reset) {
        const rows = () => Array.from({ length: GRID_H }, () => new Float32Array(GRID_W));
        h = visibilityHistoryState = { sourceGrid: grid, player: playerId, width: GRID_W, height: GRID_H,
            tick: now, light: rows(), fog: rows(), explored: new Uint8Array(GRID_W * GRID_H),
            holdUntil: new Int32Array(GRID_W * GRID_H).fill(-1) };
    }
    // A resync may rewind simulation ticks. Rebase local expiry times without
    // throwing away the player's explored terrain or last-seen objects.
    if (now < h.tick) {
        const rewind = h.tick - now;
        for (let i = 0; i < h.holdUntil.length; i++) h.holdUntil[i] -= rewind;
        h.tick = now;
    }
    const dt = Math.min(2, Math.max(0, now - h.tick)) / holdTicks;
    const rise = VISIBILITY_LIGHT_MAX_CHANGE_PER_SECOND * dt;
    const fall = VISIBILITY_FADE_MAX_CHANGE_PER_SECOND * dt;
    let changed = reset;
    for (let y = 0; y < GRID_H; y++) {
        const source = raw[y], light = h.light[y], fog = h.fog[y];
        for (let x = 0; x < GRID_W; x++) {
            const i = y * GRID_W + x, target = source[x], current = light[x];
            if (target > 0) {
                h.holdUntil[i] = now + holdTicks;
                h.explored[i] = 1;
            }
            let next = target;
            if (!reset) {
                if (target === 0 && now <= h.holdUntil[i]) next = current;
                else next = current + Math.max(-fall, Math.min(rise, target - current));
            }
            light[x] = next;
            next = light[x]; // Use the stored Float32 value for stable comparisons.
            let fogLight = next;
            if (teamVisibilityHistory && h.explored[i]) {
                const dark = 1 - Math.min(1, next / VISIBILITY_LIGHT_NORMALIZATION_RANGE);
                fogLight += VISIBILITY_LIGHT_NORMALIZATION_RANGE * HISTORY_LIGHT_FLOOR * dark * dark * dark;
            }
            const oldFog = fog[x];
            fog[x] = fogLight;
            if (fog[x] !== oldFog || next !== current) changed = true;
        }
    }
    h.tick = now;
    if (teamVisibilityHistory) updateLocalVisibilityHistory(h);
    if (changed) visibilityVersion++;
    return h.light;
}

const HISTORY_RENDER_FIELDS = ('id owner type unitType gx gy x y vx vy energy maxEnergy gold astar amount value '
    + 'r color vis dead teleportHideTicks isSnake isFlying isWorker unitLevel baseLevel level effectiveLevel '
    + 'potentialEffectiveLevel stackCount stacks manualStacks stackingWorkDone stackingWorkRequired '
    + 'workerType workerState workerTransferCooldown carryingValue researcherHasMaterial attackFlash attackStyle '
    + 'burning poisoned frozen wet watched watchedByTeam underConstruction isUpgrading markedForSalvage '
    + 'angle laserState spawnTimer spawnCooldown _levelTextLabel _energyBlockedUntil').split(' ');
const HISTORY_LISTS = ['units', 'towers', 'barracks', 'collectorSpawners', 'goldMines', 'astarMines', 'droppedItems'];

function freezeHistoryRecord(record) {
    const source = record.source;
    const copy = Object.create(Object.getPrototypeOf(source));
    for (const key of HISTORY_RENDER_FIELDS) copy[key] = source[key];
    // Only small rendering data is copied, once on disappearance. No paths,
    // targets, spatial buckets, canvases or recursively reachable world state.
    for (const key of ['preComputed', 'preComputedEffective', 'baseStats', 'currentStats', 'researchTask']) {
        const stats = source[key];
        if (!stats) continue;
        const saved = copy[key] = {};
        for (const field of Object.keys(stats)) {
            const value = stats[field];
            if (value === null || (typeof value !== 'object' && typeof value !== 'function')) saved[field] = value;
        }
    }
    copy.spawnQueue = source.spawnQueue ? source.spawnQueue.slice() : [];
    // Cached labels are shared sprites; retaining a reference needs no raster copy.
    copy.textCanvas = source.textCanvas;
    copy._textCanvasScale = source._textCanvasScale;
    copy.snakeHistory = source.snakeHistory ? source.snakeHistory.map(p => ({ x: p.x, y: p.y })) : [];
    copy.connectedLasers = [];
    copy.path = copy.targetUnit = copy.targetBuilding = copy.attackTarget = copy.workerTarget = null;
    copy.x = copy.prevX = record.x; copy.y = copy.prevY = record.y;
    copy.gx = record.gx; copy.gy = record.gy;
    copy.energy = record.energy; copy.gold = record.gold; copy.astar = record.astar;
    copy.dead = false; copy._historyGhost = true; copy._historyTick = record.tick;
    record.snapshot = copy;
    record.source = null;
    return copy;
}

function updateLocalVisibilityHistory(h) {
    if (!h.memories) {
        h.memories = Object.fromEntries(HISTORY_LISTS.concat('floorItems').map(name => [name, new Map()]));
        h.view = { grid: grid.map(row => row.map(cell => ({ type: cell.type, owner: cell.owner, item: null }))) };
        for (const name of HISTORY_LISTS) h.view[name] = [];
    }
    const generation = h.generation = (h.generation || 0) + 1;
    const visible = (x, y) => !!(h.light[y] && h.light[y][x] > 0);
    const observe = (memory, source, gx, gy, key) => {
        let record = memory.get(key);
        if (!record) { record = {}; memory.set(key, record); }
        record.source = source; record.snapshot = null; record.generation = generation;
        record.x = source.x; record.y = source.y; record.gx = gx; record.gy = gy;
        record.energy = source.energy; record.gold = source.gold; record.astar = source.astar;
        record.tick = gameTime;
        return record;
    };
    const live = { units, towers, barracks, collectorSpawners, goldMines, astarMines, droppedItems };
    for (const name of HISTORY_LISTS) {
        const memory = h.memories[name], shown = h.view[name];
        shown.length = 0;
        for (const e of live[name]) {
            if (!e || e.dead || e.energy <= 0) continue;
            const gx = Number.isFinite(e.x) ? Math.floor(e.x / TILE) : e.gx;
            const gy = Number.isFinite(e.y) ? Math.floor(e.y / TILE) : e.gy;
            if (!visible(gx, gy)) continue;
            observe(memory, e, gx, gy, e.id != null ? e.id : gy * GRID_W + gx);
            shown.push(e);
        }
        for (const [key, record] of memory) {
            if (record.generation === generation) continue;
            if (visible(record.gx, record.gy)) { memory.delete(key); continue; }
            shown.push(record.snapshot || freezeHistoryRecord(record));
        }
    }
    const memory = h.memories.floorItems;
    const observeFloor = (e, gx, gy) => {
        if (!e || e.energy <= 0 || !visible(gx, gy)) return;
        observe(memory, e, gx, gy, gy * GRID_W + gx);
        const cell = h.view.grid[gy][gx], liveCell = grid[gy][gx];
        cell.type = liveCell.type; cell.owner = liveCell.owner; cell.item = e;
    };
    if (typeof _activeTileEntities !== 'undefined') {
        for (const e of _activeTileEntities) {
            const cell = grid[e.gy] && grid[e.gy][e.gx];
            if (cell && cell.item === e) observeFloor(e, e.gx, e.gy);
        }
    } else {
        for (let y = 0; y < GRID_H; y++) for (let x = 0; x < GRID_W; x++) observeFloor(grid[y][x].item, x, y);
    }
    for (const [key, record] of memory) {
        if (record.generation === generation) continue;
        const cell = h.view.grid[record.gy][record.gx];
        if (visible(record.gx, record.gy)) { memory.delete(key); cell.item = null; }
        else cell.item = record.snapshot || freezeHistoryRecord(record);
    }
    h.view.visibilityGrid = h.fog;
    h.view.projectiles = projectiles.filter(e => visible(Math.floor(e.x / TILE), Math.floor(e.y / TILE)));
    h.view.particles = particles.filter(e => visible(Math.floor(e.x / TILE), Math.floor(e.y / TILE)));
}

function getRenderVisibilityGrid() {
    return !fullVisibility && visibilityHistoryState ? visibilityHistoryState.fog : visibilityGrid;
}
