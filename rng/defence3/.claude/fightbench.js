// Browser benchmark harness for fights and workers. Load from the console:
//   await (0,eval)(await (await fetch('/rng/defence3/.claude/fightbench.js')).text());
//   await BENCH.runAll()            // or BENCH.run('fight3')
(() => {
const COMBAT = ['norm', 'fast', 'tank', 'boss', 'flying', 'mole', 'poison_resistant', 'fire_resistant',
    'water_resistant', 'ice_resistant', 'laser_resistant', 'snake'];
const TOWERS = ['pistol', 'smg', 'water', 'poison', 'fire', 'sand_gun', 'ice', 'sniper', 'elements', 'laser'];
const BARRACKS = ['barrack_norm', 'barrack_fast', 'barrack_tank', 'barrack_flying', 'barrack_snake', 'barrack_fire_resistant'];
const sleep = ms => new Promise(r => setTimeout(r, ms));
const stat = a => {
    if (!a.length) return null;
    const b = [...a].sort((x, y) => x - y);
    return { mean: +(a.reduce((x, y) => x + y, 0) / a.length).toFixed(2), p50: +b[b.length >> 1].toFixed(2),
        p95: +b[Math.floor(b.length * .95)].toFixed(2), max: +b[b.length - 1].toFixed(1) };
};

async function newGame(size = 80) {
    if (typeof gameStarted !== 'undefined' && gameStarted) { location.reload(); throw new Error('reloading: rerun after load'); }
    const set = (id, v) => { const e = document.getElementById(id); if (e) { e.value = String(v); e.dispatchEvent(new Event('change')); } };
    set('cfg-mapsize', size); set('cfg-map-type', 'arena'); set('cfg-max-pop', 5000);
    set('cfg-starting-energy', 1e9); set('cfg-starting-astar', 1e9);
    // Solo games seed from Date.now(); pin it so maps and runs reproduce.
    const realNow = Date.now;
    Date.now = () => 1700000000000;
    try { [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Play Solo').click(); }
    finally { Date.now = realNow; }
    await sleep(800);
    stopHiddenPump();
}

// A hidden page (e.g. a background preview) runs ticks from an interval;
// benchmarks drive ticks themselves.
function stopHiddenPump() {
    if (typeof _backgroundTickInterval !== 'undefined' && _backgroundTickInterval) { clearInterval(_backgroundTickInterval); _backgroundTickInterval = null; }
    if (typeof refreshBackgroundTickMode === 'function' && !window.__origRefreshBackgroundTickMode) {
        window.__origRefreshBackgroundTickMode = refreshBackgroundTickMode;
        refreshBackgroundTickMode = () => {};
    }
}

function clearArena() {
    for (let y = 1; y < GRID_H - 1; y++) for (let x = 1; x < GRID_W - 1; x++) {
        const c = grid[y][x];
        if (c.type === TYPE_WALL && !c.item && !getTowerAtTile(x, y) && !getGoldMineAt(x, y) && !getAstarMineAt(x, y)) c.type = TYPE_FLOOR;
    }
    _bumpPathTopologyVersion();
    recalculateAdjacency();
}

function refill() {
    for (let pid = 0; pid < players.length; pid++) {
        if ((players[pid].energy || 0) < 1e8) _setPlayerResourceValue(pid, 'energy', 1e9);
        if ((players[pid].astar || 0) < 1e8) _setPlayerResourceValue(pid, 'astar', 1e9);
    }
}

function workerDefaults(u) {
    const map = { builder_unit: 'builder', healer_unit: 'healer', researcher_unit: 'researcher', salvager_unit: 'salvager' };
    if (getResourceTypeByCollectorUnit(u.unitType)) u.workerType = u.unitType;
    else if (map[u.unitType]) u.workerType = map[u.unitType];
    else return;
    u.workerState = 'IDLE'; u.carryingValue = 0; _clearWorkerTarget(u);
}

function spawnUnit(type, owner, gx, gy, level = 1) {
    const u = new Unit(type, owner, gx * TILE + 16, gy * TILE + 16);
    workerDefaults(u);
    applyUnitLevelScaling(u, level);
    u.energy = u.preComputed.maxEnergy;
    units.push(u); players[owner].popCount++;
    updateUnitSpatial(u);
    return u;
}

function blob(owner, cx, cy, n, types, width = 16) {
    const out = [];
    for (let i = 0; i < n; i++) {
        const gx = Math.max(1, Math.min(GRID_W - 2, cx - (width >> 1) + i % width));
        const gy = Math.max(1, Math.min(GRID_H - 2, cy - (Math.ceil(n / width) >> 1) + Math.floor(i / width)));
        out.push(spawnUnit(types[i % types.length], owner, gx, gy));
    }
    return out;
}

function tileFree(gx, gy) {
    const c = grid[gy] && grid[gy][gx];
    return c && c.type !== TYPE_WALL && !c.item && !getGoldMineAt(gx, gy) && !getAstarMineAt(gx, gy);
}

function place(key, owner, gx, gy, { built = true, level = 1 } = {}) {
    if (!tileFree(gx, gy)) return null;
    if (!placeBuilding(gx, gy, key, owner, { silent: true, ignorePlacementRules: true, buildEnabled: true, autoUpgradeEnabled: true })) return null;
    const item = getTileEntityRef(gx, gy);
    if (!item || !built) return item;
    const lvl = Math.max(1, clampThingLevel(level));
    const stacks = getRequiredStacksForLevel(lvl);
    Object.assign(item, { stacks, effectiveStacks: stacks, level: lvl, effectiveLevel: lvl, potentialEffectiveLevel: lvl,
        underConstruction: false, isUpgrading: false });
    if (item instanceof Tower) item.updateStats();
    else {
        const stats = calculateItemStats(item.type === 'barrack' ? `barrack_${item.unitType}` : key, lvl, owner);
        if (Number.isFinite(stats.maxEnergy)) { item.maxEnergy = Math.max(1, Math.floor(stats.maxEnergy)); item.energy = item.maxEnergy; }
        if (Number.isFinite(stats.damage)) item.damage = stats.damage;
        if (item.spawnCooldown !== undefined) {
            const buildingKey = item.type === 'barrack' ? `barrack_${item.unitType}` : item.type;
            item.spawnCooldown = Math.round(getBarrackSpawnCooldown(getSpawnerFallbackUnitType(item), lvl, owner, buildingKey) * TICK_RATE);
        }
    }
    updateItemTextCache(item);
    return item;
}

function block(owner, keys, x0, y0, cols, rows, spacing = 2, opts = {}) {
    const out = [];
    let i = 0;
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
        const b = place(keys[i++ % keys.length], owner, x0 + c * spacing, y0 + r * spacing, opts);
        if (b) out.push(b);
    }
    return out;
}

// Mirror runOneTick's periodic state check (whichever version is loaded).
function lockstepHash(t) {
    if (typeof computeLockstepStateHashFast === 'function') {
        if (LOCKSTEP_DEBUG_HASH_DETAILS) computeLockstepStateDigest(t);
        return computeLockstepStateHashFast(t);
    }
    return hashStringLockstep(stableSerializeForLockstep(computeLockstepStateDigest(t)));
}

const alive = owner => units.filter(u => !u.dead && u.owner === owner && !u.workerType);
function centroid(list) {
    if (!list.length) return null;
    let x = 0, y = 0;
    for (const u of list) { x += u.x; y += u.y; }
    return { x: x / list.length, y: y / list.length };
}
// Deterministic jitter so repeated commands land on changing tiles.
const jitter = (t, k) => (((t * 73856093) ^ (k * 19349663)) >>> 0) % 5 - 2;

function attackMoveSpam(tick, teams, period = 5) {
    if (tick % period) return [];
    const acts = [];
    for (const [pid, enemyPids] of teams) {
        const mine = alive(pid);
        if (!mine.length) continue;
        let target = null;
        for (const e of enemyPids) { const c = centroid(alive(e)); if (c) { target = c; break; } }
        if (!target) continue;
        acts.push([pid, { action: 'attackMove', unitIds: mine.map(u => u.id),
            targetX: target.x + jitter(tick, pid) * TILE, targetY: target.y + jitter(tick, pid + 7) * TILE }]);
    }
    return acts;
}

// Deterministic harness randomness (never the game's rng).
let rngState = 1;
function rngSeed(v) { rngState = (v >>> 0) || 1; }
function rand() { rngState = (Math.imul(rngState, 1664525) + 1013904223) >>> 0; return rngState / 4294967296; }
function pick(list) { return list[Math.floor(rand() * list.length)]; }

// Split a subset over several points by proximity with equal shares, like the
// ctrl multi-point UI.
function nearestSplit(list, points) {
    const n = list.length, k = points.length, cap = Math.ceil(n / k), load = new Array(k).fill(0), out = points.map(() => []);
    const pairs = [];
    list.forEach((u, i) => points.forEach((p, j) => pairs.push({ i, j, d: (u.x - p.x) ** 2 + (u.y - p.y) ** 2 })));
    pairs.sort((a, b) => (a.d - b.d) || (a.i - b.i) || (a.j - b.j));
    const done = new Array(n).fill(false);
    for (const q of pairs) { if (done[q.i] || load[q.j] >= cap) continue; done[q.i] = true; load[q.j]++; out[q.j].push(list[q.i]); }
    return out;
}

const WORKER_BUILDINGS = ['builder_spawner', 'healer_spawner', 'research', 'spawner', 'astar_spawner'];
const FLOOR_ITEMS = ['lava', 'poison_puddle', 'ice_patch', 'water_puddle', 'sand', 'mine', 'farm'];

function randomBase(pid, cx, cy, spread) {
    const at = () => ({ gx: Math.max(1, Math.min(GRID_W - 2, Math.round(cx + (rand() - .5) * spread))),
        gy: Math.max(1, Math.min(GRID_H - 2, Math.round(cy + (rand() - .5) * spread))) });
    const placeSome = (keys, n, opts) => { const out = []; for (let i = 0, tries = 0; i < n && tries < n * 20; tries++) { const p = at(); const b = place(pick(keys), pid, p.gx, p.gy, opts); if (b) { out.push(b); i++; } } return out; };
    const barracks = placeSome(BARRACKS, 6);
    placeSome(WORKER_BUILDINGS, 8);
    placeSome(['house'], 12);
    placeSome(TOWERS, 25);
    placeSome(FLOOR_ITEMS, 10);
    placeSome(TOWERS.concat(['farm', 'house']), 20, { built: false });
    const unitsAt = (type, n) => { for (let i = 0; i < n; i++) { const p = at(); spawnUnit(type, pid, p.gx, p.gy); } };
    for (let i = 0; i < 150; i++) unitsAt(pick(COMBAT), 1);
    unitsAt('builder_unit', 30); unitsAt('healer_unit', 20); unitsAt('researcher_unit', 15);
    unitsAt('collector', 30); unitsAt('astar_collector', 15);
    for (const u of units) if (u.owner === pid && u.unitType !== 'king' && !u.workerType && rand() < .3) u.energy *= .5;
    return barracks;
}

const SCENARIOS = {
    // Four teams with random mixes of every unit, tower, worker and building.
    // Every few ticks each team orders random subsets to several individual
    // points (split by proximity) and moves random rally points.
    chaos: {
        ticks: 300, size: 120, focus: { gx: 60, gy: 60 },
        setup() {
            const W = GRID_W, H = GRID_H, m = Math.round(W * .22);
            this.bases = [{ x: m, y: m }, { x: W - m, y: m }, { x: m, y: H - m }, { x: W - m, y: H - m }];
            this.barracks = this.bases.map((b, pid) => randomBase(pid, b.x, b.y, Math.round(W * .3)));
        },
        tick(t) {
            const acts = [];
            if (t % 4) return acts;
            for (let pid = 0; pid < 4; pid++) {
                const mine = alive(pid);
                for (let s = 0; s < 2 && mine.length; s++) {
                    const subset = mine.filter(() => rand() < .35);
                    if (!subset.length) continue;
                    const k = 1 + Math.floor(rand() * 4);
                    const points = Array.from({ length: k }, () => {
                        const base = rand() < .5 ? this.bases[(pid + 1 + Math.floor(rand() * 3)) % 4] : { x: GRID_W / 2, y: GRID_H / 2 };
                        return { x: (base.x + (rand() - .5) * 20) * TILE, y: (base.y + (rand() - .5) * 20) * TILE };
                    });
                    const action = rand() < .7 ? 'attackMove' : 'move';
                    nearestSplit(subset, points).forEach((group, j) => {
                        if (group.length) acts.push([pid, { action, unitIds: group.map(u => u.id), targetX: points[j].x, targetY: points[j].y }]);
                    });
                }
                for (const b of this.barracks[pid]) {
                    if (t % 20 === 0) acts.push([pid, { action: 'queueUnit', gx: b.gx, gy: b.gy, count: 5 }]);
                    if (rand() < .15) acts.push([pid, { action: 'setRally', gx: b.gx, gy: b.gy,
                        targetX: (GRID_W / 2 + (rand() - .5) * 40) * TILE, targetY: (GRID_H / 2 + (rand() - .5) * 40) * TILE }]);
                }
            }
            return acts;
        }
    },
    // Four teams with various sized groups scattered over the map (walls kept).
    // Team 0 is fully selected and sent with ctrl to 4 far points (issued as
    // successive ctrl clicks like the UI); the others criss-cross the map.
    selectedRally: {
        ticks: 400, size: 120, walls: true, focus: { gx: 60, gy: 60 },
        setup() {
            const W = GRID_W, H = GRID_H;
            const spots = [[.15, .15], [.5, .12], [.85, .15], [.12, .5], [.88, .5], [.15, .85], [.5, .88], [.85, .85], [.35, .35], [.65, .65], [.35, .65], [.65, .35]];
            const sizes = [80, 10, 40, 5, 60, 25, 15, 100, 30, 8, 50, 20];
            spots.forEach(([fx, fy], i) => blob(i % 4, Math.round(W * fx), Math.round(H * fy), sizes[i], COMBAT, 10));
            selectedUnits = alive(0);
        },
        tick(t) {
            const acts = [];
            const pts = [[.1, .9], [.9, .9], [.9, .1], [.5, .5]].map(([fx, fy]) => ({ x: fx * GRID_W * TILE, y: fy * GRID_H * TILE }));
            if (t < 4 || t === 200 || t === 201) {
                const k = t < 4 ? t + 1 : t - 198;
                const use = (t >= 200 ? pts.slice().reverse() : pts).slice(0, k);
                nearestSplit(alive(0), use).forEach((g, j) => g.length && acts.push([0, { action: 'move', unitIds: g.map(u => u.id), targetX: use[j].x, targetY: use[j].y }]));
            }
            if (t % 150 === 0) for (let pid = 1; pid < 4; pid++) {
                const mine = alive(pid), c = centroid(mine);
                if (!c) continue;
                acts.push([pid, { action: rand() < .5 ? 'move' : 'attackMove', unitIds: mine.map(u => u.id),
                    targetX: GRID_W * TILE - c.x, targetY: GRID_H * TILE - c.y }]);
            }
            return acts;
        }
    },
    // Three armies of 200 mixed units, re-issuing attack-move 4x a second.
    fight3: {
        ticks: 400, focus: { gx: 40, gy: 40 },
        setup() {
            blob(0, 14, 40, 200, COMBAT); blob(1, 64, 18, 200, COMBAT); blob(2, 64, 62, 200, COMBAT);
        },
        tick: t => attackMoveSpam(t, [[0, [1, 2]], [1, [2, 0]], [2, [0, 1]]])
    },
    // 250 mixed units assault a 60-tower block.
    towersVsUnits: {
        ticks: 400, focus: { gx: 50, gy: 40 },
        setup() {
            block(1, TOWERS, 50, 28, 6, 10, 2);
            blob(0, 14, 40, 250, COMBAT);
        },
        tick: t => attackMoveSpam(t, [[0, [1]]]).concat(t % 5 ? [] : [[0, { action: 'attackMove',
            unitIds: alive(0).map(u => u.id), targetX: (56 + jitter(t, 3)) * TILE, targetY: (40 + jitter(t, 4)) * TILE }]])
    },
    // Two tower blocks in range of each other, with floor items and held units.
    towersVsTowers: {
        ticks: 300, focus: { gx: 40, gy: 40 },
        setup() {
            block(0, TOWERS, 26, 28, 5, 12, 2); block(1, TOWERS, 46, 28, 5, 12, 2);
            block(0, ['lava', 'poison_puddle', 'ice_patch', 'water_puddle', 'sand', 'mine'], 37, 28, 1, 12, 2);
            block(1, ['lava', 'poison_puddle', 'ice_patch', 'water_puddle', 'sand', 'mine'], 43, 28, 1, 12, 2);
            const held = blob(0, 20, 40, 100, COMBAT, 8).concat(blob(1, 60, 40, 100, COMBAT, 8));
            processActions([{ action: 'hold', unitIds: held.filter(u => u.owner === 0).map(u => u.id) }], 0);
            processActions([{ action: 'hold', unitIds: held.filter(u => u.owner === 1).map(u => u.id) }], 1);
        },
        tick: () => []
    },
    // Barracks with full queues, rally points spammed 4x a second, and
    // armies fighting in the middle.
    rallySpam: {
        ticks: 400, focus: { gx: 40, gy: 40 },
        setup() {
            this.b = [block(0, BARRACKS, 6, 30, 2, 3, 3), block(1, BARRACKS, 70, 8, 2, 3, 3), block(2, BARRACKS, 70, 60, 2, 3, 3)];
            // Houses raise the pop cap so the queues actually spawn.
            block(0, ['house'], 2, 50, 3, 10, 1); block(1, ['house'], 74, 20, 3, 10, 1); block(2, ['house'], 74, 44, 3, 10, 1);
            blob(0, 20, 40, 120, COMBAT); blob(1, 60, 20, 120, COMBAT); blob(2, 60, 60, 120, COMBAT);
        },
        tick(t) {
            const acts = attackMoveSpam(t, [[0, [1, 2]], [1, [2, 0]], [2, [0, 1]]]);
            this.b.forEach((list, pid) => {
                for (const b of list) {
                    if (t % 20 === 0) acts.push([pid, { action: 'queueUnit', gx: b.gx, gy: b.gy, count: 20 }]);
                    if (t % 5 === 0) acts.push([pid, { action: 'setRally', gx: b.gx, gy: b.gy,
                        targetX: (40 + jitter(t, b.gx) * 2) * TILE + 16, targetY: (40 + jitter(t, b.gy) * 2) * TILE + 16 }]);
                }
            });
            return acts;
        }
    },
    // 200 + 100 builders, 20 builder buildings, 450 construction sites.
    builders: {
        ticks: 400, focus: { gx: 40, gy: 40 },
        setup() {
            block(0, ['builder_spawner'], 10, 10, 5, 2, 3); block(1, ['builder_spawner'], 55, 60, 5, 2, 3);
            blob(0, 20, 20, 200, ['builder_unit']); blob(1, 60, 64, 100, ['builder_unit']);
            block(0, TOWERS.concat(['farm', 'house', 'lava', 'spawner']), 8, 26, 20, 15, 2, { built: false });
            block(1, TOWERS.concat(['farm', 'house']), 44, 40, 15, 10, 2, { built: false });
        },
        tick: () => []
    },
    // Healers restoring 400 damaged units, barracks queueing more.
    healers: {
        ticks: 400, focus: { gx: 40, gy: 40 },
        setup() {
            block(0, ['healer_spawner'], 10, 10, 5, 1, 3); block(1, ['healer_spawner'], 60, 66, 5, 1, 3);
            blob(0, 20, 16, 100, ['healer_unit']); blob(1, 60, 62, 80, ['healer_unit']);
            for (const u of blob(0, 30, 40, 250, COMBAT).concat(blob(1, 55, 40, 150, COMBAT))) u.energy = Math.max(1, u.energy * .3);
            this.b = [block(0, BARRACKS, 6, 30, 2, 2, 3), block(1, BARRACKS, 70, 30, 2, 2, 3)];
            block(0, ['house'], 2, 50, 3, 10, 1); block(1, ['house'], 74, 44, 3, 10, 1);
        },
        tick(t) {
            const acts = [];
            if (t % 20 === 0) this.b.forEach((list, pid) => list.forEach(b => acts.push([pid, { action: 'queueUnit', gx: b.gx, gy: b.gy, count: 20 }])));
            return acts;
        }
    },
    // Researchers working through long research queues.
    researchers: {
        ticks: 400, focus: { gx: 20, gy: 20 },
        setup() {
            this.labs = [block(0, ['research'], 10, 10, 5, 1, 3), block(1, ['research'], 55, 66, 5, 1, 3).concat(block(1, ['research'], 56, 58, 5, 1, 3))];
            blob(0, 20, 20, 150, ['researcher_unit']); blob(1, 60, 60, 80, ['researcher_unit']);
            ensureResearchThingsReady();
            this.stats = [];
            for (const thing of RESEARCH_THINGS) for (const s of (thing.stats || [])) this.stats.push([thing.kind, thing.key, s.statKey || s.key]);
        },
        tick(t) {
            const acts = [];
            if (t % 20) return acts;
            this.labs.forEach((list, pid) => {
                if (!list.length) return;
                for (let i = 0; i < 6 && this.stats.length; i++) {
                    const [kind, key, statKey] = this.stats[(t / 20 * 6 + i + pid * 3) % this.stats.length];
                    acts.push([pid, { action: 'queueResearch', gx: list[0].gx, gy: list[0].gy, kind, key, statKey, count: 2 }]);
                }
            });
            return acts;
        }
    },
    // Energy and A* collectors mining with spawners near the mines.
    miners: {
        ticks: 400, focus: { gx: 40, gy: 40 },
        setup() {
            const mines = goldMines.slice(0, 400), stars = astarMines.slice(0, 400);
            const near = (list, i) => { const m = list[i % Math.max(1, list.length)]; return m ? { gx: m.gx, gy: m.gy } : { gx: 40, gy: 40 }; };
            // Spawners next to mines, and their collectors right beside them.
            const drop = (key, unitType, pid, list, n, perSpawner) => {
                let placed = 0;
                for (let i = 0; placed < n && i < 400; i++) {
                    const m = near(list, i * 17 + pid * 5);
                    for (const [dx, dy] of [[2, 0], [0, 2], [-2, 0], [0, -2], [3, 1]]) {
                        const s = place(key, pid, m.gx + dx, m.gy + dy);
                        if (!s) continue;
                        placed++;
                        const cx = Math.max(6, Math.min(GRID_W - 7, s.gx)), cy = Math.max(3, Math.min(GRID_H - 4, s.gy));
                        blob(pid, cx, cy, perSpawner, [unitType], 5);
                        break;
                    }
                }
            };
            drop('spawner', 'collector', 0, mines, 10, 15); drop('astar_spawner', 'astar_collector', 0, stars, 5, 20);
            drop('spawner', 'collector', 1, mines, 8, 12); drop('astar_spawner', 'astar_collector', 1, stars, 4, 15);
        },
        tick: () => []
    }
};

async function measureRender(focus, frames = 30) {
    const out = {};
    const prevMode = renderDimensionMode;
    for (const mode of ['2d', '3d']) {
        setRenderDimensionMode(mode);
        for (const zoom of [1, 0.5]) {
            camera.zoom = zoom;
            camera.x = focus.gx * TILE - viewW / zoom / 2; camera.y = focus.gy * TILE - viewH / zoom / 2;
            for (let i = 0; i < 8; i++) renderFrame(performance.now());
            const t = [];
            for (let i = 0; i < frames; i++) { const s = performance.now(); renderFrame(performance.now()); t.push(performance.now() - s); }
            out[`${mode}@${zoom}`] = stat(t);
            await sleep(0);
        }
    }
    setRenderDimensionMode(prevMode);
    return out;
}

// Every research stat at the given level for every player (vision, speed,
// worker search distance, ranges, ...), with stats and units refreshed.
function applyResearch(level) {
    ensureResearchThingsReady();
    for (let pid = 0; pid < players.length; pid++) {
        const levels = ensurePlayerResearchLevels(pid);
        for (const thing of RESEARCH_THINGS) for (const st of thing.stats || []) {
            if (st.statKey === 'maxLevel') continue;
            levels[makeResearchLevelId(thing.kind, thing.key, st.statKey)] = level;
        }
    }
    rebuildPrecomputedStatsMapPlayer();
    for (const u of units) applyUnitLevelScaling(u, Math.max(1, u.unitLevel || 1));
}

async function run(name, opts = {}) {
    const render = opts.render !== false;
    const sc = SCENARIOS[name];
    await newGame(opts.size || sc.size || 80);
    if (!sc.walls) clearArena();
    refill();
    rngSeed(opts.seed || 12345);
    sc.setup(opts);
    if (opts.research) applyResearch(opts.research === true ? MAX_RESEARCH_LEVEL : opts.research);
    const sim = [], cmd = [];
    const counts = () => [0, 1, 2, 3].map(p => units.filter(u => !u.dead && u.owner === p).length);
    const startCounts = counts();
    let renderStats = null;
    const mp = !!opts.mp;
    for (let t = 0; t < sc.ticks; t++) {
        gameOver = false;
        refill();
        const acts = sc.tick(t);
        if (mp) isMultiplayer = true;
        const s = performance.now();
        for (const [pid, a] of acts) processActions([a], pid);
        const mid = performance.now();
        gameTick();
        // Lockstep peers also hash state every check interval.
        if (mp && t % LOCKSTEP_STATE_CHECK_INTERVAL === 0) lockstepHash(t);
        const e = performance.now();
        if (mp) isMultiplayer = false;
        cmd.push(mid - s); sim.push(e - s);
        if (render && t === Math.floor(sc.ticks / 2)) renderStats = await measureRender(sc.focus);
        if (t % 50 === 0) await sleep(0);
    }
    return { name, mp: !!opts.mp, sim: stat(sim), commands: stat(cmd), units: { start: startCounts, end: counts() },
        towers: towers.length, render: renderStats };
}

async function runAll(names = Object.keys(SCENARIOS), opts) {
    // Each scenario needs a fresh game; the page reloads between them, so
    // continue from sessionStorage when rerun after a reload.
    const results = JSON.parse(sessionStorage.getItem('benchResults') || '{}');
    for (const n of names) {
        if (results[n]) continue;
        results[n] = await run(n, opts);
        sessionStorage.setItem('benchResults', JSON.stringify(results));
        location.reload();
        return { pending: names.filter(x => !results[x]), done: Object.keys(results) };
    }
    return results;
}

// Wrap every sizeable game function (and Unit/Tower methods) and report
// self/inclusive time. Overhead inflates tiny functions; compare relatively.
function installProfiler(minLength = 300) {
    const stats = new Map(), stack = [];
    const skip = new Set(['gameTick', 'simulationFrame', 'processVisibleSimulationFrame', 'processRenderFrame', 'runOneTick']);
    const wrap = (obj, name, label) => {
        const f = obj[name];
        if (typeof f !== 'function' || f.__o || /^class\s/.test(Function.prototype.toString.call(f))) return;
        const w = function (...a) {
            const t = performance.now(); stack.push(0);
            try { return f.apply(this, a); } finally {
                const el = performance.now() - t, ch = stack.pop();
                if (stack.length) stack[stack.length - 1] += el;
                let s = stats.get(label); if (!s) stats.set(label, s = { n: 0, incl: 0, self: 0 });
                s.n++; s.incl += el; s.self += el - ch;
            }
        };
        w.__o = f; obj[name] = w;
    };
    for (const n of Object.keys(window)) {
        if (skip.has(n) || n.startsWith('__') || /^[A-Z]/.test(n)) continue;
        let f; try { f = window[n]; } catch (e) { continue; }
        if (typeof f !== 'function') continue;
        const src = Function.prototype.toString.call(f);
        if (src.includes('[native code]') || src.length < minLength) continue;
        wrap(window, n, n);
    }
    for (const C of [Unit, Tower, typeof Barrack !== 'undefined' ? Barrack : null, typeof Projectile !== 'undefined' ? Projectile : null].filter(Boolean))
        for (const m of Object.getOwnPropertyNames(C.prototype)) if (m !== 'constructor') wrap(C.prototype, m, C.name + '.' + m);
    return {
        stats,
        report(k = 30) { return [...stats].sort((a, b) => b[1].self - a[1].self).slice(0, k)
            .map(([n, s]) => `${n}: self ${s.self.toFixed(0)} incl ${s.incl.toFixed(0)} n ${s.n}`).join('\n'); }
    };
}

async function profile(name, opts = {}) {
    const sc = SCENARIOS[name];
    await newGame(opts.size || sc.size || 80); if (!sc.walls) clearArena(); refill(); rngSeed(opts.seed || 12345); sc.setup(opts);
    if (opts.research) applyResearch(opts.research === true ? MAX_RESEARCH_LEVEL : opts.research);
    const ticks = opts.ticks || sc.ticks;
    // Render-only profiling: simulate first, then profile frames.
    const renderOnly = opts.render === 'only';
    let prof = renderOnly ? null : installProfiler(opts.minLength);
    for (let t = 0; t < ticks; t++) {
        gameOver = false; refill();
        for (const [pid, a] of sc.tick(t)) processActions([a], pid);
        gameTick();
        if (opts.render === true && t % 4 === 0) renderFrame(performance.now());
    }
    if (renderOnly) {
        if (opts.mode) setRenderDimensionMode(opts.mode);
        camera.zoom = opts.zoom || 1;
        camera.x = sc.focus.gx * TILE - viewW / camera.zoom / 2; camera.y = sc.focus.gy * TILE - viewH / camera.zoom / 2;
        for (let i = 0; i < 10; i++) renderFrame(performance.now());
        prof = installProfiler(opts.minLength);
        for (let i = 0; i < (opts.frames || 60); i++) renderFrame(performance.now());
    }
    return prof.report(opts.top || 35);
}

// Low-overhead split of a tick: wraps only a few coarse phases.
async function phases(name, opts = {}) {
    const sc = SCENARIOS[name];
    await newGame(opts.size || sc.size || 80); if (!sc.walls) clearArena(); refill(); rngSeed(opts.seed || 12345); sc.setup(opts);
    if (opts.research) applyResearch(opts.research === true ? MAX_RESEARCH_LEVEL : opts.research);
    const totals = {}, targets = [
        [window, 'processActions'], [window, 'updateVisibility'], [window, 'recalculateUnitEffectiveStats'],
        [window, 'recalculateThingPrecomputedStats'], [window, 'updateAudioReactiveState'], [window, 'updateWorkerAI'],
        [Unit.prototype, 'update'], [Unit.prototype, 'followPath'], [Unit.prototype, 'doAttackMoving'], [Unit.prototype, 'doAttacking'],
        [Unit.prototype, 'doIdle'], [Unit.prototype, 'doMoving'], [Tower.prototype, 'update'],
        [typeof Projectile !== 'undefined' ? Projectile.prototype : {}, 'update'], [window, 'gameTick']
    ].concat((opts.extra || []).map(n => n.includes('.') ? [(0, eval)(n.split('.')[0]).prototype, n.split('.')[1]] : [window, n]));
    const depth = new Map();
    for (const [obj, n] of targets) {
        const f = obj[n];
        if (typeof f !== 'function') continue;
        const label = (obj === window ? '' : (obj.constructor && obj.constructor.name) + '.') + n;
        obj[n] = function (...a) {
            // Count only the outermost call of each phase (no recursion double count).
            const d = depth.get(label) || 0; depth.set(label, d + 1);
            const t = performance.now();
            try { return f.apply(this, a); } finally {
                depth.set(label, d);
                if (!d) totals[label] = (totals[label] || 0) + performance.now() - t;
            }
        };
        obj[n].__o = f;
    }
    const ticks = opts.ticks || sc.ticks;
    for (let t = 0; t < ticks; t++) {
        gameOver = false; refill();
        const acts = sc.tick(t);
        if (opts.mp) isMultiplayer = true;
        for (const [pid, a] of acts) processActions([a], pid);
        gameTick();
        if (opts.mp && t % LOCKSTEP_STATE_CHECK_INTERVAL === 0) {
            const d0 = performance.now();
            lockstepHash(t);
            totals.digest = (totals.digest || 0) + performance.now() - d0;
        }
        if (opts.mp) isMultiplayer = false;
    }
    for (const [obj, n] of targets) if (obj[n] && obj[n].__o) obj[n] = obj[n].__o;
    const out = {};
    for (const [k, v] of Object.entries(totals).sort((a, b) => b[1] - a[1])) out[k] = +(v / ticks).toFixed(3);
    return out; // ms per tick
}

// Before/after suite across page loads: results persist in localStorage.
// Call BENCH.suite(['base', 'new']) repeatedly (each call runs one scenario
// and reloads to the next page) until it returns the finished table.
const SUITE_PAGES = { base: '/.bench_base/rng/defence3/index.html', new: '/rng/defence3/index.html' };
async function suite(versions = ['base', 'new'], names = Object.keys(SCENARIOS).filter(n => !/short/.test(n)), opts = { mp: true }) {
    const store = JSON.parse(localStorage.getItem('benchSuite') || '{}');
    for (const n of names) for (const v of versions) {
        const key = v + ':' + n;
        if (store[key]) continue;
        if (!location.pathname.startsWith(SUITE_PAGES[v].replace('index.html', ''))) { location.href = SUITE_PAGES[v]; return { next: key }; }
        store[key] = await run(n, opts);
        localStorage.setItem('benchSuite', JSON.stringify(store));
        location.reload();
        return { done: key };
    }
    const table = {};
    for (const n of names) {
        const row = {};
        for (const v of versions) {
            const r = store[v + ':' + n];
            row[v] = { simMean: r.sim.mean, simP95: r.sim.p95, cmdP95: r.commands.p95,
                r2d: r.render && r.render['2d@1'].mean, r2dOut: r.render && r.render['2d@0.5'].mean,
                r3d: r.render && r.render['3d@1'].mean, r3dOut: r.render && r.render['3d@0.5'].mean };
        }
        table[n] = row;
    }
    return { table };
}

// Simulate a scenario, then time frames while the simulation keeps running.
async function renderProbe(name, ticks = 200, opts = {}) {
    SCENARIOS.__probe = { ...SCENARIOS[name], ticks };
    await run('__probe', { ...opts, render: false });
    const cnt = {}, orig = [];
    for (const n of ['get3DExact2DTexture', 'build3DFrameData', 'push3DRenderObject']) {
        const f = window[n]; if (!f) continue; orig.push([n, f]);
        window[n] = function (...a) { const t = performance.now(); try { return f.apply(this, a); } finally { cnt[n] = (cnt[n] || 0) + performance.now() - t; } };
    }
    const res = { units: units.length, towers: towers.length };
    const focus = opts.focus || SCENARIOS[name].focus;
    for (const [mode, zoom] of opts.views || [['3d', 1], ['2d', 1], ['3d', 0.5], ['2d', 0.5], ['3d', 0.3], ['2d', 0.3]]) {
        setRenderDimensionMode(mode); camera.zoom = zoom;
        camera.x = focus.gx * TILE - viewW / zoom / 2; camera.y = focus.gy * TILE - viewH / zoom / 2;
        for (let i = 0; i < 10; i++) { gameOver = false; gameTick(); renderFrame(performance.now()); }
        for (const k in cnt) delete cnt[k];
        for (let i = 0; i < 30; i++) { gameOver = false; gameTick(); const a = performance.now(); renderFrame(performance.now()); cnt.frame = (cnt.frame || 0) + performance.now() - a; }
        const o = { objects: build3DFrameData(mode === '2d').objects.length };
        for (const k in cnt) o[k] = +(cnt[k] / 30).toFixed(2);
        res[mode + '@' + zoom] = o;
    }
    for (const [n, f] of orig) window[n] = f;
    return res;
}

// Sampling profile (JS Self-Profiling API; needs the Document-Policy:
// js-profiling header from .smoke-server.cjs). fn runs the workload.
// Returns top self and inclusive functions (file:line) by sample share.
async function sample(fn, { interval = 1, top = 30, under = null } = {}) {
    const prof = new Profiler({ sampleInterval: interval, maxBufferSize: 1e6 });
    await fn();
    const trace = await prof.stop();
    const name = i => { const f = trace.frames[i]; return (f.name || '(anon)') + ' ' + String(f.resourceId !== undefined ? trace.resources[f.resourceId] : '').split('/').pop() + ':' + (f.line || 0); };
    const self = new Map(), incl = new Map();
    let total = 0;
    for (const smp of trace.samples) {
        if (smp.stackId === undefined) continue;
        total++;
        let id = smp.stackId, first = true;
        const seen = new Set();
        if (under) {
            let hit = false;
            for (let k = id; k !== undefined; k = trace.stacks[k].parentId) if (trace.frames[trace.stacks[k].frameId].name === under) { hit = true; break; }
            if (!hit) { total--; continue; }
        }
        while (id !== undefined) {
            const st = trace.stacks[id], n = name(st.frameId);
            if (first) { self.set(n, (self.get(n) || 0) + 1); first = false; }
            if (!seen.has(n)) { seen.add(n); incl.set(n, (incl.get(n) || 0) + 1); }
            id = st.parentId;
        }
    }
    const fmt = m => [...m].sort((a, b) => b[1] - a[1]).slice(0, top).map(([k, v]) => (100 * v / total).toFixed(1) + '% ' + k).join(String.fromCharCode(10));
    return ['samples ' + total, '-- self', fmt(self), '-- inclusive', fmt(incl)].join(String.fromCharCode(10));
}

// Let the real game loop run for ms (after prepare), recording frame
// intervals; with profile=true also returns a sampling profile.
async function live(ms = 4000, { profile = false, top = 40, view = null } = {}) {
    if (view) {
        setRenderDimensionMode(view.mode || '3d'); camera.zoom = view.zoom || 0.35;
        camera.x = (view.gx || GRID_W / 2) * TILE - viewW / camera.zoom / 2; camera.y = (view.gy || GRID_H / 2) * TILE - viewH / camera.zoom / 2;
    }
    const frames = [];
    let last = performance.now(), stop = false;
    const loop = t => { frames.push(t - last); last = t; if (!stop) requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
    const work = () => new Promise(r => setTimeout(r, ms));
    const report = profile ? await sample(work, { top }) : (await work(), null);
    stop = true;
    frames.shift();
    const st = stat(frames);
    return { fps: +(1000 / st.mean).toFixed(1), frameMs: st, over25: frames.filter(f => f > 25).length, frames: frames.length, gameTime, profile: report };
}

// Drive frames synchronously (works while the page is hidden): a tick
// every third frame (60 FPS / 20 TPS) and a render every frame. Returns
// per-frame cost (tick + render) and optionally a sampling profile.
async function frames(n = 240, { profile = false, top = 40, view = null } = {}) {
    if (view) {
        setRenderDimensionMode(view.mode || '3d'); camera.zoom = view.zoom || 0.35;
        camera.x = (view.gx || GRID_W / 2) * TILE - viewW / camera.zoom / 2; camera.y = (view.gy || GRID_H / 2) * TILE - viewH / camera.zoom / 2;
    }
    const cost = [], sim = [], ren = [];
    let ts = performance.now();
    const work = async () => {
        for (let i = 0; i < n; i++) {
            ts += 1000 / 60;
            const a = performance.now();
            if (i % 3 === 0) { gameOver = false; gameTick(); }
            const b = performance.now();
            tickAlpha = (i % 3) / 3;
            renderFrame(ts);
            const c = performance.now();
            cost.push(c - a); sim.push(b - a); ren.push(c - b);
            if (i % 30 === 29) await sleep(0);
        }
    };
    const report = profile ? await sample(work, { top, under: profile === true ? null : profile }) : (await work(), null);
    return { frame: stat(cost), tick: stat(sim.filter((_, i) => i % 3 === 0)), render: stat(ren), over16: cost.filter(f => f > 16.7).length, n, profile: report };
}

// Run a scenario for `ticks` and return state hashes every `every` ticks,
// to compare gameplay between builds (same seed and map settings).
async function hashes(name, ticks = 300, every = 50, opts = {}) {
    const sc = SCENARIOS[name];
    await newGame(opts.size || sc.size || 80);
    if (!sc.walls) clearArena();
    refill(); rngSeed(opts.seed || 12345); sc.setup(opts);
    const out = [];
    for (let t = 0; t < ticks; t++) {
        gameOver = false; refill();
        for (const [pid, a] of sc.tick(t)) processActions([a], pid);
        gameTick();
        if ((t + 1) % every === 0) out.push(computeLockstepStateHashFast(t));
    }
    return { out, units: units.filter(u => !u.dead).length };
}

// Exclusive (self) time per wrapped function, ms per tick, over n ticks of a
// prepared scenario. Wrapper overhead is charged to callers; compare builds
// with the same list rather than reading absolute values.
function selfTimes(name, from, n, fns = [], methods = []) {
    const stack = [], self = {}, cnt = {}, orig = [];
    const wrap = (obj, key, label) => {
        const f = obj[key];
        if (typeof f !== 'function') return;
        orig.push([obj, key, f]);
        obj[key] = function (...a) {
            const t = performance.now(); stack.push(0);
            try { return f.apply(this, a); } finally {
                const el = performance.now() - t, ch = stack.pop();
                if (stack.length) stack[stack.length - 1] += el;
                self[label] = (self[label] || 0) + el - ch; cnt[label] = (cnt[label] || 0) + 1;
            }
        };
    };
    for (const m of methods) { const [cls, key] = m.split('.'); wrap((0, eval)(cls).prototype, key, m); }
    for (const f of fns) wrap(window, f, f);
    const t0 = performance.now();
    continueTicks(name, from, n);
    const total = (performance.now() - t0) / n;
    for (const [o, k, f] of orig) o[k] = f;
    const out = { total: +total.toFixed(2) };
    for (const k of Object.keys(self).sort((a, b) => self[b] - self[a])) out[k] = +(self[k] / n).toFixed(3) + '/' + Math.round(cnt[k] / n);
    return out;
}

// Set a scenario up and run it for `ticks` without measuring.
async function prepare(name, ticks, opts = {}) {
    SCENARIOS.__prep = { ...SCENARIOS[name], ticks };
    return run('__prep', { ...opts, render: false });
}

// Continue the currently running scenario (after prepare) for n ticks.
function continueTicks(name, from, n, render = false) {
    const sc = SCENARIOS[name];
    for (let t = from; t < from + n; t++) {
        gameOver = false; refill();
        for (const [pid, a] of sc.tick.call(SCENARIOS.__prep, t)) processActions([a], pid);
        gameTick();
        if (render) renderFrame(performance.now());
    }
}

window.BENCH = { SCENARIOS, run, sample, live, frames, hashes, selfTimes, prepare, continueTicks, runAll, profile, phases, suite, renderProbe, clearSuite() { localStorage.removeItem('benchSuite'); }, measureRender, place, spawnUnit, blob, block,
    reset() { sessionStorage.removeItem('benchResults'); } };
return 'BENCH ready';
})();
