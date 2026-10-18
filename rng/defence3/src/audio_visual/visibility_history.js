// Local fog presentation only. Gameplay always reads the immediate raw grid.
// Last-seen records are frozen only when something leaves the displayed area.
let teamVisibilityHistory = false;
let visibilityHistoryState = null;
const HISTORY_LIGHT_FLOOR = .14;

function getRenderGameTime() { return gameTime; }
function getTeamLightingGrid() { return visibilityGrid; }
// (canvas: the canvas renderer's (renderer2d.js draw, no WebGL2): with
// remembered structures as columns, the view as lists and cells.)
function getLiveRenderView(canvas = false) {
    if (teamVisibilityHistory && !fullVisibility && visibilityHistoryState && visibilityHistoryState.view) {
        // (Units are the live list, never a remembered one: a frame replaces
        // the list between ticks, and a view kept with the old one drew its
        // units another way until the next tick: groups blinked.)
        const v = visibilityHistoryState.view;
        v.units = units;
        if (canvas && v.historyColumns) return _historyColumnsCanvasView(visibilityHistoryState);
        return v;
    }
    return { grid, units, towers, barracks, collectorSpawners, goldMines, astarMines, droppedItems, projectiles, particles, visibilityGrid };
}

// The fog made by the presentation reader (sim_client.js 'fogBind'): its
// light and fog grids, shared; this page only follows their version.
let visibilityPresentationFog = null;
function _presentationFogState(playerId) {
    const P = visibilityPresentationFog;
    if (!P || P.player !== playerId || P.width !== GRID_W || P.height !== GRID_H || !P.head) return null;
    if (!P.rows) {
        const rows = flat => { const r = Array.from({ length: GRID_H }, (_, y) => flat.subarray(y * GRID_W, (y + 1) * GRID_W)); r._flat = flat; return r; };
        P.rows = { light: rows(P.light), fog: rows(P.fog) };
    }
    return P;
}
function updateVisualVisibility(playerId, raw) {
    if (fullVisibility) {
        if (visibilityHistoryState) visibilityVersion++;
        visibilityHistoryState = null;
        return raw;
    }
    // Made off this thread: the grids as they are, a new version as the
    // reader moves on; the remembered structures (history) as before.
    const P = _presentationFogState(playerId);
    if (P) {
        let h = visibilityHistoryState;
        if (!h || h.presentation !== P || h.sourceGrid !== grid) {
            h = visibilityHistoryState = { sourceGrid: grid, player: playerId, width: GRID_W, height: GRID_H, tick: gameTime,
                light: P.rows.light, fog: P.rows.fog, explored: P.explored, presentation: P, version: -1 };
        }
        const v = Atomics.load(P.head, 0);
        if (v !== h.version) { h.version = v; visibilityVersion++; }
        h.historyMode = teamVisibilityHistory;
        h.tick = gameTime;
        if (teamVisibilityHistory) updateLocalVisibilityHistory(h);
        return h.light;
    }
    const now = gameTime, holdTicks = Math.max(1, TICK_RATE);
    let h = visibilityHistoryState;
    const reset = !h || h.sourceGrid !== grid || h.player !== playerId
        || h.width !== GRID_W || h.height !== GRID_H;
    if (reset) {
        // (Rows over one flat buffer: the GPU takes the grid as it is.)
        const rows = () => { const flat = new Float32Array(GRID_W * GRID_H), r = Array.from({ length: GRID_H }, (_, y) => flat.subarray(y * GRID_W, (y + 1) * GRID_W)); r._flat = flat; return r; };
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
    // A dark tile that was already dark keeps light 0 and the same fog (it
    // can only become explored while lit), unless the fog mode changed.
    const full = reset || h.historyMode !== teamVisibilityHistory;
    h.historyMode = teamVisibilityHistory;
    if (full) changed = true;
    for (let y = 0; y < GRID_H; y++) {
        const source = raw[y], light = h.light[y], fog = h.fog[y];
        for (let x = 0; x < GRID_W; x++) {
            const target = source[x], current = light[x];
            if (target === 0 && current === 0 && !full) continue;
            const i = y * GRID_W + x;
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

const HISTORY_RENDER_FIELDS = ('id owner type unitType gx gy x y vx vy energy maxEnergy gold maxGold astar maxAstar amount value '
    + 'r color vis dead teleportHideTicks isSnake isFlying isWorker unitLevel baseLevel level effectiveLevel '
    + 'potentialEffectiveLevel stackCount stacks manualStacks stackingWorkDone stackingWorkRequired '
    + 'workerType workerState workerTransferCooldown carryingValue researcherHasMaterial attackFlash attackStyle '
    + 'burning poisoned frozen wet watched watchedByTeam underConstruction isUpgrading markedForSalvage '
    + 'angle laserState spawnTimer spawnCooldown _levelTextLabel _energyBlockedUntil').split(' ');
// What is remembered where it was last seen: structures, mines, floor
// items. Units are shown while seen only (the live list: the renderer draws
// them from the frame's columns, hidden where nothing sees): remembering
// 200k units each tick cost most of a frame.
const HISTORY_LISTS = ['towers', 'barracks', 'collectorSpawners', 'goldMines', 'astarMines', 'droppedItems'];
// (Structures change slowly: their memory is brought up to date this often.)
const HISTORY_STRUCTURE_TICKS = 4;

function freezeHistoryRecord(record) {
    const source = record.source;
    // (A unit view reads the frame: its ghost is a plain unit.)
    const copy = Object.create(source._frameView ? Object.getPrototypeOf(Object.getPrototypeOf(source)) : Object.getPrototypeOf(source));
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

// Beside a simulation worker (the page's structures are its table,
// sim_frame_world.js _pageTables.s): structures are remembered as columns
// (historyStructureFrame); only dropped items as records here.
function _historyColumnsMode() {
    return typeof _pageTables !== 'undefined' && typeof _pageStructViews !== 'undefined'
        && typeof simClientActive === 'function' && simClientActive();
}
// (A view's rows where it has no cells: renderer.js reads cells of a
// remembered view only through its structure frame's sources.)
const HISTORY_NO_CELLS_ROW = [], HISTORY_NO_LIST = Object.freeze([]);

function updateLocalVisibilityHistory(h) {
    const columns = _historyColumnsMode();
    if (h.memories && !!h.view.historyColumns !== columns) { h.memories = null; h.view = null; h.cols = null; }
    if (columns) { _updateHistoryColumnsView(h); return; }
    const first = !h.memories;
    if (first) {
        h.memories = Object.fromEntries(HISTORY_LISTS.concat('floorItems').map(name => [name, new Map()]));
        h.view = { grid: grid.map(row => row.map(cell => ({ type: cell.type, owner: cell.owner, item: null }))) };
        for (const name of HISTORY_LISTS) h.view[name] = [];
    }
    // Units: the live ones (seen ones only are drawn).
    h.view.units = units;
    h.view.visibilityGrid = h.fog;
    // (Every HISTORY_STRUCTURE_TICKS of game time: a multiple of them passed
    // since the last look, steps of several base ticks too.)
    const due = Math.floor(gameTime / HISTORY_STRUCTURE_TICKS) !== Math.floor((Number.isFinite(h._structAt) ? h._structAt : -1) / HISTORY_STRUCTURE_TICKS);
    if (!first && h.view.units === units && !due) {
        const visibleNow = (x, y) => !!(h.light[y] && h.light[y][x] > 0);
        h.view.projectiles = projectiles.filter(e => visibleNow(Math.floor(e.x / TILE), Math.floor(e.y / TILE)));
        h.view.particles = particles.filter(e => visibleNow(Math.floor(e.x / TILE), Math.floor(e.y / TILE)));
        return;
    }
    h._structAt = gameTime;
    const generation = h.generation = (h.generation || 0) + 1;
    const visible = (x, y) => !!(h.light[y] && h.light[y][x] > 0);
    const live = { towers, barracks, collectorSpawners, goldMines, astarMines, droppedItems };
    for (const name of HISTORY_LISTS) _historyObserveList(h, name, live[name], generation, visible);
    const memory = h.memories.floorItems;
    const observeFloor = (e, gx, gy) => {
        if (!e || e.energy <= 0 || !visible(gx, gy)) return;
        _historyObserve(memory, e, gx, gy, gy * GRID_W + gx, generation);
        const cell = h.view.grid[gy][gx], liveCell = grid[gy][gx];
        cell.type = liveCell.type; cell.owner = liveCell.owner; cell.item = e;
    };
    if (typeof _activeTileEntities !== 'undefined') {
        // Most indexed entities are mines; only cell items are floor items.
        for (const e of _getVisibilityFloorItemCandidates()) {
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
function _historyObserve(memory, source, gx, gy, key, generation) {
    let record = memory.get(key);
    if (!record) { record = {}; memory.set(key, record); }
    record.source = source; record.snapshot = null; record.generation = generation;
    record.x = source.x; record.y = source.y; record.gx = gx; record.gy = gy;
    record.energy = source.energy; record.gold = source.gold; record.astar = source.astar;
    record.tick = gameTime;
    return record;
}
// One remembered list (h.view[name]): the live ones seen now, then the
// frozen copies of those seen before and not now.
function _historyObserveList(h, name, list, generation, visible) {
    const memory = h.memories[name], shown = h.view[name];
    shown.length = 0;
    // Resource frame views share the structure schema and report energy=0;
    // that is not a health/death flag. Keep depleted mines visible too.
    const hasHealth = name !== 'goldMines' && name !== 'astarMines' && name !== 'droppedItems';
    for (const e of list) {
        if (!e || e.dead || (hasHealth && e.energy <= 0)) continue;
        const gx = Number.isFinite(e.x) ? Math.floor(e.x / TILE) : e.gx;
        const gy = Number.isFinite(e.y) ? Math.floor(e.y / TILE) : e.gy;
        if (!visible(gx, gy)) continue;
        _historyObserve(memory, e, gx, gy, e.id != null ? e.id : gy * GRID_W + gx, generation);
        shown.push(e);
    }
    for (const [key, record] of memory) {
        if (record.generation === generation) continue;
        if (visible(record.gx, record.gy)) { memory.delete(key); continue; }
        shown.push(record.snapshot || freezeHistoryRecord(record));
    }
}

// ---- Remembered structures as columns (beside a simulation worker) ----
// Over the page's structure table (_pageTables.s), slot by slot, in its own
// column types: a slot seen live is the table's row (the glyphs' shader and
// the detail split hide it where nothing sees now, as with Team); one seen
// before and not now is its row as last seen, marked a ghost
// (HISTORY_GHOST_FLAG), its source a frozen copy (freezeHistoryRecord); one
// whose slot went to another structure while it was out of sight is kept
// past the table's slots. Typed passes over the slots when the table or the
// light changed; the frame's ver changes only when a row did, its rev when
// slots were taken over or ghosts came or went (renderer.js
// _structureDetailCandidates). (Every structure's view walked each
// HISTORY_STRUCTURE_TICKS into lists, and a frame of columns made from those
// lists each tick, was ~290 ms a second on the page at 200k units a team:
// frames of 60-120 ms.)
const HISTORY_COLUMNS = ['x', 'y', 'energy', 'angle', 'vision', 'amount', 'serial', 'flags', 'kind', 'gx', 'gy', 'owner', 'type', 'utype', 'alive'];
// (renderer.js STRUCT_FRAME_GHOST, renderer3d.js STRUCT_GHOST_FLAG.)
const HISTORY_GHOST_FLAG = 4194304;

function _updateHistoryColumnsView(h) {
    if (!h.view) {
        h.memories = { droppedItems: new Map() };
        h.view = { historyColumns: true, grid: Array(GRID_H).fill(HISTORY_NO_CELLS_ROW), droppedItems: [] };
        for (const name of ['towers', 'barracks', 'collectorSpawners', 'goldMines', 'astarMines']) h.view[name] = HISTORY_NO_LIST;
    }
    const v = h.view;
    v.units = units; v.visibilityGrid = h.fog;
    // (The live ones: effects are drawn only where something sees now,
    // effects3d.js _fxVisible.)
    v.projectiles = projectiles; v.particles = particles;
    if (h.dropsTick === undefined || gameTime < h.dropsTick || gameTime - h.dropsTick >= HISTORY_STRUCTURE_TICKS) {
        h.dropsTick = gameTime;
        const generation = h.generation = (h.generation || 0) + 1;
        _historyObserveList(h, 'droppedItems', droppedItems, generation, (x, y) => !!(h.light[y] && h.light[y][x] > 0));
    }
}
function _historyColumnsAlloc(types, cap, old) {
    const out = {};
    for (const k of HISTORY_COLUMNS) {
        const a = new types[k].constructor(cap);
        if (old) a.set(old[k].length > cap ? old[k].subarray(0, cap) : old[k]);
        out[k] = a;
    }
    return out;
}
function _historyColumnsGrowFrame(C, types, need) {
    const cap = Math.max(1024, Math.ceil(need * 1.25));
    const H = C.H || (C.H = { n: 0, cap: 0, history: true, ver: 0, rev: {}, sources: [], dirty: null });
    Object.assign(H, _historyColumnsAlloc(types, cap, H.cap ? H : null));
    H.cap = cap; H.ver++; H.rev = {}; H.dirty = null;
}
// The frame's rows changed, by block of 256 and column, as the units'
// (renderer3d.js _columnStoreUploadChanged): the GPU takes only the blocks
// changed since the version it holds; a new stream, the whole columns. (A
// pass of new light changes a few rows: the whole frame each time was
// ~2.4 MB a tick in a battle at 60k structures.)
const HISTORY_GPU_COLUMNS = ['x', 'y', 'energy', 'owner', 'flags', 'alive', 'kind', 'angle', 'type', 'utype', 'vision', 'amount'];
function _historyDirty(F) {
    const nb = Math.ceil(F.cap / 256);
    if (!F.dirty || F.dirty.nb !== nb) F.dirty = { stream: {}, seq: F.ver, block: 256, nb, stamps: new Int32Array(HISTORY_GPU_COLUMNS.length * nb), cols: HISTORY_GPU_COLUMNS };
    return F.dirty;
}
// Slot s, seen before, out of sight now: a ghost. Its frame row is the row
// last seen until a new table is copied over the rows; it is saved into the
// frozen columns (G) before that (_historySaveRows), and only then: going
// out of sight and back in a pass of new light are the ghost bit alone.
// (15 columns copied for each, an area of 10k structures going dark at once
// and back was ~40 + 25 ms.) Its source, a frozen copy of the view seen, is
// made later (_historySnapshots).
function _historyFreezeSlot(C, s, views) {
    C.state[s] = 2; C.gsaved[s] = 0; C.unsaved.push(s);
    const v = views[s];
    if (v && !v.dead && v._serial === C.ser[s]) C.seen[s] = v;
    C.snap[s] = null;
    C.pending.push(s);
}
// The rows of the ghosts not saved yet, from the frame's rows, column by
// column (before a new table is copied over those).
function _historySaveRows(C) {
    const U = C.unsaved, st = C.state, saved = C.gsaved, H = C.H, G = C.G;
    let m = 0;
    for (let i = 0; i < U.length; i++) { const s = U[i]; if (st[s] === 2 && !saved[s]) { saved[s] = 1; U[m++] = s; } }
    if (m) for (const k of HISTORY_COLUMNS) { const g = G[k], f = H[k]; for (let i = 0; i < m; i++) { const s = U[i]; g[s] = f[s]; } }
    U.length = 0;
}
function _historySaveRow(C, s) {
    if (C.gsaved[s]) return;
    for (const k of HISTORY_COLUMNS) C.G[k][s] = C.H[k][s];
    C.gsaved[s] = 1;
}
// A ghost's source: a frozen copy of the view it was seen as, with the
// frozen row's place, energy and resources (R row k).
function _historyGhostSource(view, R, k) {
    const kind = R.kind[k];
    return freezeHistoryRecord({ source: view, x: R.x[k], y: R.y[k], gx: R.gx[k], gy: R.gy[k],
        energy: kind >= 4 ? undefined : R.energy[k], gold: kind === 4 ? R.amount[k] : undefined, astar: kind === 5 ? R.amount[k] : undefined,
        tick: gameTime });
}
// Up to HISTORY_SNAPSHOTS_PER_PASS ghosts' sources a pass, oldest first. (A
// copy reads ~60 fields through the view's accessors, ~20 us: an area of a
// big base going dark at once froze 10k structures, 250 ms in one pass.
// Until its source is made a ghost is drawn as its glyph, not in detail.)
let HISTORY_SNAPSHOTS_PER_PASS = 150;
function _historySnapshots(C, S, n) {
    let budget = HISTORY_SNAPSHOTS_PER_PASS;
    const P = C.pending, st = C.state;
    while (C.pendingAt < P.length && budget > 0) {
        const s = P[C.pendingAt++];
        if (st[s] !== 2 || C.snap[s] || !C.seen[s]) continue;
        C.snap[s] = S[s] = _historyGhostSource(C.seen[s], C.gsaved[s] ? C.G : C.H, s);
        C.seen[s] = null; budget--;
    }
    if (C.pendingAt === P.length) { P.length = 0; C.pendingAt = 0; }
    const D = C.D;
    for (let k = 0; k < D.n && budget > 0; k++) {
        if (D.snap[k] || !D.seen[k]) continue;
        D.snap[k] = _historyGhostSource(D.seen[k], D.c, k); D.seen[k] = null; budget--;
        if (S.length > n + k) S[n + k] = D.snap[k];
    }
}
// A ghost frozen at slot s kept past the slots (its slot is another's).
function _historyDetach(C, s) {
    _historySaveRow(C, s);
    const D = C.D;
    if (D.n >= D.cap) { D.cap = Math.max(256, D.cap * 2); D.c = _historyColumnsAlloc(C.G, D.cap, D.c); }
    for (const k of HISTORY_COLUMNS) D.c[k][D.n] = C.G[k][s];
    D.seen[D.n] = C.snap[s] ? null : C.seen[s];
    D.snap[D.n++] = C.snap[s];
    C.snap[s] = null; C.seen[s] = null;
}
function _historyDetachedRemove(D, k) {
    const last = --D.n;
    if (k !== last) { for (const key of HISTORY_COLUMNS) D.c[key][k] = D.c[key][last]; D.snap[k] = D.snap[last]; D.seen[k] = D.seen[last]; }
    D.snap[last] = null; D.seen[last] = null;
}
// The table's live slots by their tiles' rows (a counting pass), with their
// tiles (oti): the light is read row by row (a row is 4 KB). (In slot order,
// all over a grid of 4 MB, each read was a cache miss: ~1 ms a pass at 60k
// structures.) Made when the table's membership changed.
function _historySlotOrder(C, T, n, W, Hh) {
    if (!C.ti || C.ti.length < C.cap) { C.ti = new Int32Array(C.cap); C.ord = new Int32Array(C.cap); C.oti = new Int32Array(C.cap); C.cand = new Int32Array(C.cap); }
    if (!C.at || C.at.length < Hh + 1) C.at = new Int32Array(Hh + 1);
    const ti = C.ti, ord = C.ord, oti = C.oti, at = C.at, alive = T.alive, kind = T.kind, tgx = T.gx, tgy = T.gy;
    at.fill(0, 0, Hh + 1);
    let m = 0;
    for (let s = 0; s < n; s++) {
        const gx = tgx[s], gy = tgy[s];
        if (alive[s] === 0 || kind[s] === 6 || gx < 0 || gy < 0 || gx >= W || gy >= Hh) { ti[s] = -1; continue; }
        ti[s] = gy * W + gx; at[gy + 1]++; m++;
    }
    for (let y = 0; y < Hh; y++) at[y + 1] += at[y];
    for (let s = 0; s < n; s++) { const t = ti[s]; if (t >= 0) { const o = at[tgy[s]]++; ord[o] = s; oti[o] = t; } }
    C.ordN = m;
}
// The places in tile order whose slot may change state (seen for the
// first time, out of sight, in sight again) or is a ghost: into out, their
// count. (On its own: a tight loop over every live slot each pass.)
function _historyLightScan(ord, oti, m, st, L, out) {
    let k = 0;
    for (let i = 0; i < m; i++) {
        const state = st[ord[i]];
        if (state === 0 ? L[oti[i]] > 0 : state === 2 || !(L[oti[i]] > 0)) out[k++] = i;
    }
    return k;
}
// (Dense: a store far past an empty array's end makes it a dictionary, ~0.2
// us an access: rebuilding the sources of 60k slots took ~15 ms.)
function _historyDenseArray(old, cap) {
    const a = new Array(cap).fill(null);
    if (old) for (let i = 0; i < old.length && i < cap; i++) a[i] = old[i];
    return a;
}
// (More ghosts than this seen again in a pass of new light, whose rows were
// saved: all the rows written again, and uploaded whole.)
const HISTORY_RESTORES_PATCHED = 2048;
// The remembered structures' frame (Team + history beside a simulation
// worker), up to date with the page's table and the light; null without.
function historyStructureFrame(h) {
    const T = typeof _pageTables !== 'undefined' ? _pageTables.s : null, L = h && h.light && h.light._flat;
    if (!T || !L || !h.view || !h.view.historyColumns) return null;
    const C = h.cols || (h.cols = { T: null, vis: NaN, views: null, n: 0, cap: 0, state: null, ser: null, gsaved: null, G: null, ghosts: null,
        dead: null, deadN: 0, snap: [], seen: [], pending: [], pendingAt: 0, unsaved: [], D: { n: 0, cap: 0, c: null, snap: [], seen: [] }, H: null });
    if (C.T === T && C.vis === visibilityVersion && C.views === _pageStructViews) return C.H;
    const views = _pageStructViews;
    const n = T.n, W = h.width;
    if (C.cap < n) {
        const cap = Math.max(1024, Math.ceil(n * 1.25)), st = new Uint8Array(cap), se = new Int32Array(cap), sv = new Uint8Array(cap);
        if (C.state) { st.set(C.state); se.set(C.ser); sv.set(C.gsaved); }
        C.state = st; C.ser = se; C.gsaved = sv; C.G = _historyColumnsAlloc(T, cap, C.G); C.cap = cap;
        C.ghosts = new Int32Array(cap); C.dead = new Int32Array(cap); C.flip = new Int32Array(cap); C.restore = new Int32Array(cap);
        C.snap = _historyDenseArray(C.snap, cap); C.seen = _historyDenseArray(C.seen, cap); C.ti = null;
    }
    if (!C.H || C.H.cap < n + C.D.n) _historyColumnsGrowFrame(C, T, n + C.D.n);
    const H = C.H, G = C.G, st = C.state, ser = C.ser, saved = C.gsaved, ghosts = C.ghosts, dead = C.dead, D = C.D;
    // (Slots taken over in the table: its membership version, sim_client.js.)
    const mver = typeof _simClient !== 'undefined' && _simClient ? _simClient.structMver : T;
    const table = C.T !== T;
    let changed = table, member = n !== C.n || mver !== C.mver || !C.ti, gn = 0, fn = 0, rn = 0;
    C.mver = mver;
    // (New tables of a resync: what was remembered by slot is kept past
    // the slots, the slots start over.)
    if (C.views !== views || n < C.n) {
        for (let s = 0; s < C.n; s++) {
            if (st[s] === 1) _historyFreezeSlot(C, s, views);
            if (st[s] !== 0) _historyDetach(C, s);
            st[s] = 0;
        }
        C.views = views; C.deadN = 0; changed = member = true;
    }
    if (member) {
        changed = true;
        _historySlotOrder(C, T, n, W, h.height);
        // (In place: a new array of 60k sources each time was garbage.)
        const sources = H.sources, snap = C.snap, old = Math.min(sources.length, n);
        sources.length = old;
        for (let s = 0; s < old; s++) { const v = st[s] === 2 ? snap[s] : views[s] || null; if (sources[s] !== v) sources[s] = v; }
        for (let s = old; s < n; s++) sources.push(st[s] === 2 ? snap[s] : views[s] || null);
    }
    const S = H.sources;
    const tAlive = T.alive, tKind = T.kind, tEnergy = T.energy, tSerial = T.serial;
    // A new table: the remembered ones that left their slots (destroyed, or
    // the slot another's now): forgotten where their tile is seen, else
    // ghosts (past the slots if the slot is another's); the ghosts of
    // emptied slots listed (their tiles are looked at each pass).
    if (table) {
        let dn = 0;
        for (let s = 0; s < n; s++) {
            const state = st[s];
            if (state === 0) continue;
            const kind = tKind[s], present = tAlive[s] !== 0 && kind !== 6 && (kind >= 4 || tEnergy[s] > 0);
            if (present && tSerial[s] === ser[s]) continue;
            const R = state === 1 || !saved[s] ? H : G;
            if (L[R.gy[s] * W + R.gx[s]] > 0) { C.snap[s] = C.seen[s] = null; st[s] = 0; S[s] = views[s] || null; member = changed = true; continue; }
            if (state === 1) { _historyFreezeSlot(C, s, views); S[s] = null; changed = true; }
            if (tAlive[s] !== 0 && tSerial[s] !== ser[s]) { _historyDetach(C, s); st[s] = 0; S[s] = views[s] || null; member = changed = true; }
            else dead[dn++] = s;
        }
        C.deadN = dn;
    } else {
        // (The emptied slots' ghosts whose tiles are seen now: forgotten.)
        for (let i = 0; i < C.deadN; i++) {
            const s = dead[i];
            if (st[s] === 2 && L[G.gy[s] * W + G.gx[s]] > 0) { C.snap[s] = null; st[s] = 0; S[s] = views[s] || null; member = changed = true; }
        }
    }
    for (let i = 0; i < C.deadN; i++) if (st[dead[i]] === 2) ghosts[gn++] = dead[i];
    // What is seen now, in tile order: seen for the first time (its row is
    // the table's already), out of sight (a ghost: the ghost bit), in sight
    // again (the ghost bit off; or a saved row, the table's row again).
    const ord = C.ord, oti = C.oti, cand = C.cand, flip = C.flip, restore = C.restore;
    for (let j = 0, m = _historyLightScan(ord, oti, C.ordN, st, L, cand); j < m; j++) {
        const i = cand[j], s = ord[i], state = st[s], seen = L[oti[i]] > 0, kind = tKind[s];
        if (tAlive[s] === 0 || (kind < 4 && !(tEnergy[s] > 0)) || state !== 0 && tSerial[s] !== ser[s]) continue;
        if (state === 0) { st[s] = 1; ser[s] = tSerial[s]; C.seen[s] = views[s] || null; }
        else if (state === 1) { _historyFreezeSlot(C, s, views); S[s] = null; ghosts[gn++] = s; flip[fn++] = s; changed = true; }
        else if (seen) { st[s] = 1; C.snap[s] = null; C.seen[s] = S[s] = views[s] || null; if (saved[s]) restore[rn++] = s; else flip[fn++] = s; changed = true; }
        else ghosts[gn++] = s;
    }
    for (let k = 0; k < D.n;) {
        if (L[D.c.gy[k] * W + D.c.gx[k]] > 0) { _historyDetachedRemove(D, k); changed = member = true; }
        else k++;
    }
    _historySnapshots(C, S, n);
    if (changed) {
        if (H.cap < n + D.n) _historyColumnsGrowFrame(C, T, n + D.n);
        const F = C.H, cols = HISTORY_COLUMNS.length, flags = F.flags, alive = F.alive, M = _historyDirty(F), seq = F.ver + 1;
        if (table || member || rn > HISTORY_RESTORES_PATCHED) {
            // Every row: the table's, the ghosts' as remembered (saved first:
            // a new table goes over the rows), those past the slots; the GPU
            // takes them whole (a new stream).
            _historySaveRows(C);
            for (const k of HISTORY_COLUMNS) {
                const f = F[k], g = G[k];
                f.set(T[k].subarray(0, n));
                for (let i = 0; i < gn; i++) { const s = ghosts[i]; f[s] = g[s]; }
            }
            for (let i = 0; i < gn; i++) { const s = ghosts[i]; flags[s] |= HISTORY_GHOST_FLAG; alive[s] = 1; }
            if (D.n) for (const k of HISTORY_COLUMNS) { const f = F[k], d = D.c[k]; for (let j = 0; j < D.n; j++) f[n + j] = d[j]; }
            for (let j = 0; j < D.n; j++) { flags[n + j] |= HISTORY_GHOST_FLAG; alive[n + j] = 1; }
            S.length = n;
            for (let k = 0; k < D.n; k++) S.push(D.snap[k]);
            M.stream = {};
        } else {
            // Only the rows that changed, their blocks marked: the ghost bit
            // (its column's blocks), the saved rows seen again (all columns).
            const ST = M.stamps, nc = M.cols.length, nb = M.nb, fb = M.cols.indexOf('flags') * nb, tf = T.flags;
            for (let i = 0; i < fn; i++) {
                const s = flip[i];
                flags[s] = st[s] === 2 ? flags[s] | HISTORY_GHOST_FLAG : tf[s];
                ST[fb + (s >> 8)] = seq;
            }
            if (rn) {
                for (const k of HISTORY_COLUMNS) { const f = F[k], t = T[k]; for (let i = 0; i < rn; i++) { const s = restore[i]; f[s] = t[s]; } }
                for (let i = 0, last = -1; i < rn; i++) {
                    const b = restore[i] >> 8;
                    if (b !== last) { for (let c = 0; c < nc; c++) ST[c * nb + b] = seq; last = b; }
                }
            }
        }
        F.n = n + D.n;
        F.ver = M.seq = seq;
        if (member) F.rev = {};
    }
    C.T = T; C.vis = visibilityVersion; C.n = n;
    return C.H;
}
// The remembered view as lists and cells, for the canvas renderer (no
// WebGL2, renderer2d.js draw): made when the frame or the light changed.
function _historyColumnsCanvasView(h) {
    const H = historyStructureFrame(h), key = H ? H.ver + '|' + visibilityVersion : 'none|' + visibilityVersion;
    if (h.canvasView && h.canvasKey === key && h.canvasView.units === units) return h.canvasView;
    if (!h.canvasCells || h.canvasCells.length !== GRID_H) {
        h.canvasCells = grid.map(row => row.map(cell => ({ type: cell.type, owner: cell.owner, item: null })));
        h.canvasItems = [];
    }
    for (const cell of h.canvasItems) cell.item = null;
    h.canvasItems.length = 0;
    const lists = [[], [], [], [], [], []], seen = (x, y) => !!(h.light[y] && h.light[y][x] > 0);
    if (H) for (let s = 0; s < H.n; s++) {
        const e = H.sources[s], k = H.kind[s], gx = H.gx[s], gy = H.gy[s];
        if (!e || !H.alive[s] || k > 5 || !(H.flags[s] & HISTORY_GHOST_FLAG) && !seen(gx, gy)) continue;
        if (k !== 3) lists[k].push(e);
        const cell = k >= 1 && k <= 3 && h.canvasCells[gy] && h.canvasCells[gy][gx];
        if (cell) { cell.item = e; if (!e._historyGhost) { cell.owner = grid[gy][gx].owner; cell.type = grid[gy][gx].type; } h.canvasItems.push(cell); }
    }
    const visibleNow = e => seen(Math.floor(e.x / TILE), Math.floor(e.y / TILE));
    h.canvasKey = key;
    return h.canvasView = { grid: h.canvasCells, units, towers: lists[0], barracks: lists[1], collectorSpawners: lists[2],
        goldMines: lists[4], astarMines: lists[5], droppedItems: h.view.droppedItems,
        projectiles: projectiles.filter(visibleNow), particles: particles.filter(visibleNow), visibilityGrid: h.fog };
}

function getRenderVisibilityGrid() {
    return !fullVisibility && visibilityHistoryState ? visibilityHistoryState.fog : visibilityGrid;
}
