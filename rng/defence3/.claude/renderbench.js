// 3D/2D render benchmark. Load from the console (or the preview):
//   await (0,eval)(await (await fetch('/rng/defence3/.claude/renderbench.js')).text());
//   await RB.setup()                 // new 120x120 game, 500 units per team, turrets
//   await RB.matrix()                // every scenario x view, returns a table
//   await RB.probe({ scenario: 'move', mode: '3d', zoom: 0.35 })
//   await RB.suite({ detail: false })  // move/select/fight x 3D/2D, CPU ms per frame
//   await RB.sections()               // build3DFrameData section times (fight)
//   await RB.throughput()             // one scene rendered back to back (CPU+GPU)
//   await RB.gpu()                    // GPU timer queries per pass (noisy: clocks)
//   await RB.rendererAB({ baseUrl })  // same-state pixels: this renderer3d.js vs
//                                     // another copy (saves via POST /__save/)
// Ticks run between frames (untimed), one tick every `framesPerTick` frames
// with tickAlpha advancing like the real loop. `cpu` is renderFrame's time,
// `synced` adds gl.finish(). Single-player runs are not deterministic, so
// compare versions over several interleaved page loads.
(() => {
const COMBAT = ['norm', 'fast', 'tank', 'boss', 'flying', 'mole', 'poison_resistant', 'fire_resistant',
    'water_resistant', 'ice_resistant', 'laser_resistant', 'snake'];
const TOWERS = ['pistol', 'smg', 'water', 'poison', 'fire', 'sand_gun', 'ice', 'sniper', 'elements', 'laser'];
const sleep = ms => new Promise(r => setTimeout(r, ms));
const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
const pct = (a, p) => { if (!a.length) return 0; const b = [...a].sort((x, y) => x - y); return b[Math.min(b.length - 1, Math.floor(b.length * p))]; };
const r2 = v => Math.round(v * 100) / 100;

let rngState = 1;
const rand = () => { rngState = (Math.imul(rngState, 1664525) + 1013904223) >>> 0; return rngState / 4294967296; };

async function newGame(size) {
    const set = (id, v) => { const e = document.getElementById(id); if (e) { e.value = String(v); e.dispatchEvent(new Event('change')); } };
    set('cfg-mapsize', size); set('cfg-map-type', 'arena'); set('cfg-max-pop', 5000);
    set('cfg-starting-energy', 1e9); set('cfg-starting-astar', 1e9);
    const realNow = Date.now;
    Date.now = () => 1700000000000;
    try { [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Play Solo').click(); }
    finally { Date.now = realNow; }
    await sleep(800);
    if (typeof _backgroundTickInterval !== 'undefined' && _backgroundTickInterval) { clearInterval(_backgroundTickInterval); _backgroundTickInterval = null; }
    if (typeof refreshBackgroundTickMode === 'function') refreshBackgroundTickMode = () => {};
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

function spawnUnit(type, owner, gx, gy) {
    const u = new Unit(type, owner, gx * TILE + 16, gy * TILE + 16);
    applyUnitLevelScaling(u, 1);
    u.energy = u.preComputed.maxEnergy;
    units.push(u); players[owner].popCount++;
    updateUnitSpatial(u);
    return u;
}

function tileFree(gx, gy) {
    const c = grid[gy] && grid[gy][gx];
    return c && c.type !== TYPE_WALL && !c.item && !getGoldMineAt(gx, gy) && !getAstarMineAt(gx, gy);
}

function place(key, owner, gx, gy) {
    if (!tileFree(gx, gy)) return null;
    if (!placeBuilding(gx, gy, key, owner, { silent: true, ignorePlacementRules: true, buildEnabled: true, autoUpgradeEnabled: true })) return null;
    const item = getTileEntityRef(gx, gy);
    if (!item) return null;
    Object.assign(item, { underConstruction: false, isUpgrading: false });
    if (item instanceof Tower) item.updateStats();
    if (item.maxEnergy) item.energy = item.maxEnergy;
    updateItemTextCache(item);
    return item;
}

const alive = owner => units.filter(u => !u.dead && u.owner === owner && !u.workerType);

function nearestSplit(list, points) {
    const cap = Math.ceil(list.length / points.length), load = points.map(() => 0), out = points.map(() => []);
    const pairs = [];
    list.forEach((u, i) => points.forEach((p, j) => pairs.push({ i, j, d: (u.x - p.x) ** 2 + (u.y - p.y) ** 2 })));
    pairs.sort((a, b) => (a.d - b.d) || (a.i - b.i) || (a.j - b.j));
    const done = new Array(list.length).fill(false);
    for (const q of pairs) { if (done[q.i] || load[q.j] >= cap) continue; done[q.i] = true; load[q.j]++; out[q.j].push(list[q.i]); }
    return out;
}

const ctx = {};
const basesFor = () => [{ x: Math.round(GRID_W * .3), y: Math.round(GRID_H * .5) }, { x: Math.round(GRID_W * .7), y: Math.round(GRID_H * .5) }];

// Two teams, 500 combat units each around their base, 40 turrets and a few
// barracks per team. The snapshot is restored before every scenario.
async function setup({ size = 120, perTeam = 500, turrets = 40 } = {}) {
    if (typeof gameStarted !== 'undefined' && gameStarted) throw new Error('reload the page first');
    await newGame(size);
    clearArena();
    rngState = 7;
    const bases = basesFor();
    for (let pid = 0; pid < 2; pid++) {
        const b = bases[pid];
        let placed = 0;
        for (let tries = 0; placed < turrets && tries < 2000; tries++) {
            const gx = Math.round(b.x + (rand() - .5) * 24), gy = Math.round(b.y + (rand() - .5) * 40);
            if (place(TOWERS[placed % TOWERS.length], pid, gx, gy)) placed++;
        }
        for (let i = 0; i < 6; i++) place('barrack_norm', pid, b.x + (pid ? 10 : -10), b.y - 10 + i * 4);
        const width = 25;
        for (let i = 0; i < perTeam; i++) {
            const gx = b.x - (width >> 1) + i % width, gy = b.y - 10 + Math.floor(i / width);
            spawnUnit(COMBAT[i % COMBAT.length], pid, Math.max(1, Math.min(GRID_W - 2, gx)), Math.max(1, Math.min(GRID_H - 2, gy)));
        }
    }
    for (let i = 0; i < 5; i++) { refill(); gameTick(); }
    return { units: units.length, towers: towers.length, barracks: barracks.length };
}

// Commands per scenario, issued on the given tick of the scenario.
const SCENARIOS = {
    idle: { tick() { return []; } },
    // Team 0 to four rally points, team 1 to three (split like ctrl-clicks).
    move: {
        tick(t) {
            if (t % 120) return [];
            const flip = (t / 120) & 1;
            const pts = pid => (pid === 0
                ? [[.2, .15], [.2, .85], [.45, .3], [.45, .7]]
                : [[.8, .2], [.8, .8], [.55, .5]]).map(([fx, fy]) => ({ x: (flip ? 1 - fx : fx) * GRID_W * TILE, y: fy * GRID_H * TILE }));
            const acts = [];
            for (let pid = 0; pid < 2; pid++) {
                const p = pts(pid);
                nearestSplit(alive(pid), p).forEach((g, j) => g.length && acts.push([pid, { action: 'move', unitIds: g.map(u => u.id), targetX: p[j].x, targetY: p[j].y }]));
            }
            return acts;
        }
    },
    // Both armies attack-move into the other base: turrets fire, units fight.
    fight: {
        tick(t) {
            if (t % 60) return [];
            return [0, 1].map(pid => [pid, { action: 'attackMove', unitIds: alive(pid).map(u => u.id),
                targetX: basesFor()[1 - pid].x * TILE, targetY: basesFor()[1 - pid].y * TILE }]);
        }
    }
};

function issue(acts) {
    const byPid = new Map();
    for (const [pid, a] of acts) { if (!byPid.has(pid)) byPid.set(pid, []); byPid.get(pid).push(a); }
    for (const [pid, list] of byPid) processActions(list, pid);
}

// Overlay configurations (selection outlines, range areas).
const OVERLAYS = {
    none() { selectedUnits = []; selectedEntities = []; renderRangeMode = RENDER_RANGE_NONE; },
    select() { selectedUnits = alive(0); selectedEntities = []; renderRangeMode = RENDER_RANGE_NONE; selectionOutlineSeeThrough = false; },
    selectThrough() { OVERLAYS.select(); selectionOutlineSeeThrough = true; },
    rangesAll() { selectedUnits = []; selectedEntities = []; renderRangeMode = RENDER_RANGE_ALL; renderRangeAllTeam = true; renderRangeSeeThrough = false; },
    rangesThrough() { OVERLAYS.rangesAll(); renderRangeSeeThrough = true; },
    selectRanges() { OVERLAYS.select(); renderRangeMode = RENDER_RANGE_ALL; renderRangeAllTeam = false; },
    selectTowers() { selectedUnits = []; selectedEntities = towers.filter(t => t.owner === 0); renderRangeMode = RENDER_RANGE_ALL; renderRangeAllTeam = false; }
};

const WRAP = ['build3DFrameData', 'build3DOverlayData', 'get3DExact2DTexture', 'getSelectionContours', 'getRenderRangeBoundary', 'clipRangeBoundaryToBounds',
    'push3DRenderObject', 'drawMinimap', 'drawInteractionOverlay', 'updateHUD', 'updateControlGroupBar', 'flushTickUiRequests', 'updateInfoPanel',
    'rebuildVisibilityMaskCacheIfNeeded', 'commitStaticCaches',
    'r3.render', 'r3.drawShadows', 'r3.drawTexturedCubeInstances', 'r3.drawCubeInstances', 'r3.drawObject', 'r3.drawGroundOverlays',
    'r3.drawBackground', 'r3.resolveScene', 'r3.captureOverlayDepthFrame', 'r3.presentSceneToCanvas', 'r3.drawFlatBatch', 'r3.drawOverlay'];
const GL_COUNT = ['drawElements', 'drawArrays', 'drawElementsInstanced', 'drawArraysInstanced', 'useProgram', 'bufferSubData', 'bufferData',
    'texImage2D', 'texSubImage2D', 'texImage3D', 'texSubImage3D', 'generateMipmap', 'readPixels', 'blitFramebuffer', 'uniformMatrix4fv'];

// Measures `frames` frames after `warm` untimed ones. Every frame measures
// renderFrame's CPU time and, after a 1px readback, time until the GPU drained.
async function probe({ scenario = 'idle', overlay = 'none', mode = '3d', zoom = 0.35, focus = null, frames = 90, warm = 30,
    framesPerTick = 3, detail = true, startTick = 0, wrap = WRAP } = {}) {
    const r3 = ensure3DRendererInitialized(), gl = r3 && r3.gl;
    const sc = SCENARIOS[scenario];
    focus = focus || { gx: GRID_W / 2, gy: GRID_H / 2 };
    setRenderDimensionMode(mode);
    camera.zoom = zoom;
    camera.x = focus.gx * TILE - viewW / zoom / 2; camera.y = focus.gy * TILE - viewH / zoom / 2;
    if (typeof camera.targetZoom !== 'undefined') camera.targetZoom = zoom;
    const times = {}, counts = {}, unwrap = [];
    if (detail) {
        for (const n of wrap) {
            const [obj, key] = n.startsWith('r3.') ? [r3, n.slice(3)] : [window, n];
            const f = obj[key]; if (typeof f !== 'function') continue;
            let depth = 0;
            obj[key] = function (...a) { const t = performance.now(); depth++; try { return f.apply(this, a); } finally { if (--depth === 0) times[n] = (times[n] || 0) + performance.now() - t; } };
            unwrap.push([obj, key, f]);
        }
        for (const n of GL_COUNT) {
            const f = gl[n]; if (!f) continue;
            gl[n] = function (...a) { counts[n] = (counts[n] || 0) + 1; return f.apply(this, a); };
            unwrap.push([gl, n, f]);
        }
    }
    const px = new Uint8Array(4);
    let t = startTick, sub = 0;
    const cpu = [], synced = [];
    let objectsSum = 0;
    try {
        for (let i = 0; i < warm + frames; i++) {
            if (i === warm) { for (const k in times) delete times[k]; for (const k in counts) delete counts[k]; }
            if (sub === 0) { gameOver = false; refill(); issue(sc.tick(t)); gameTick(); t++; }
            // updateCamera derives tickAlpha from the accumulator.
            _tickAccumulator = TICK_MS * (sub / framesPerTick);
            sub = (sub + 1) % framesPerTick;
            gl.finish();
            const a = performance.now();
            renderFrame(performance.now());
            const b = performance.now();
            gl.finish();
            const c = performance.now();
            if (i >= warm) { cpu.push(b - a); synced.push(c - a); objectsSum += (r3.pickObjects || []).length; }
        }
    } finally {
        for (const [obj, key, f] of unwrap) obj[key] = f;
    }
    const out = { scenario, overlay, mode, zoom, cpu: r2(mean(cpu)), synced: r2(mean(synced)), p95: r2(pct(synced, .95)),
        picks: Math.round(objectsSum / frames), projectiles: projectiles.length, particles: particles.length, units: units.filter(u => !u.dead).length };
    for (const k in times) out['ms:' + k] = r2(times[k] / frames);
    for (const k in counts) out['gl:' + k] = r2(counts[k] / frames);
    await sleep(0);
    return out;
}

// Runs each scenario from a fresh copy of the start state (the page reloads
// are avoided by driving scenarios in sequence: idle, move, fight).
async function matrix({ views = [['3d', 0.35], ['3d', 0.7], ['2d', 0.35]], overlays = ['none', 'select', 'rangesAll'],
    scenarios = ['idle', 'move', 'fight'], frames = 60, detail = true } = {}) {
    const rows = [];
    let t = 0;
    for (const scenario of scenarios) {
        // Advance the scenario before measuring so its motion is under way.
        for (let i = 0; i < (scenario === 'fight' ? 140 : 20); i++) { gameOver = false; refill(); issue(SCENARIOS[scenario].tick(i)); gameTick(); }
        for (const overlay of overlays) {
            OVERLAYS[overlay]();
            for (const [mode, zoom] of views) {
                const r = await probe({ scenario, overlay, mode, zoom, frames, detail, startTick: 1 + t });
                t += 1000;
                rows.push(r);
                console.log(JSON.stringify(r));
            }
        }
        OVERLAYS.none();
    }
    return rows;
}


// Sampling profile of renderFrame only (ticks untimed), spread over several
// calls: sampleStart(opts), sampleRun(frames) repeatedly, then sampleStop().
let prof = null, profOpts = null, profTick = 5000, profFrame = 0;
function sampleStart({ scenario = 'move', overlay = 'select', mode = '3d', zoom = 0.35, framesPerTick = 5 } = {}) {
    OVERLAYS[overlay]();
    setRenderDimensionMode(mode); camera.zoom = zoom;
    camera.x = GRID_W / 2 * TILE - viewW / zoom / 2; camera.y = GRID_H / 2 * TILE - viewH / zoom / 2;
    profOpts = { scenario, framesPerTick }; profFrame = 0;
    prof = new Profiler({ sampleInterval: 1, maxBufferSize: 1e7 });
}
function sampleRun(frames = 1000) {
    const sc = SCENARIOS[profOpts.scenario], fpt = profOpts.framesPerTick;
    const t0 = performance.now();
    for (let i = 0; i < frames; i++, profFrame++) {
        if (profFrame % fpt === 0) { gameOver = false; refill(); issue(sc.tick(profTick)); gameTick(); profTick++; }
        _tickAccumulator = TICK_MS * ((profFrame % fpt) / fpt);
        renderFrame(performance.now());
    }
    return performance.now() - t0;
}
async function sampleStop({ top = 40, under = 'processRenderFrame' } = {}) {
    const trace = await prof.stop();
    prof = null;
    const name = i => { const f = trace.frames[i]; return (f.name || '(anon)') + ' ' + String(f.resourceId !== undefined ? trace.resources[f.resourceId] : '').split('/').pop().replace(/\?v=[^:]*/, '') + ':' + (f.line || 0); };
    const self = new Map(), incl = new Map();
    let total = 0;
    for (const smp of trace.samples) {
        if (smp.stackId === undefined) continue;
        let hit = false;
        for (let k = smp.stackId; k !== undefined; k = trace.stacks[k].parentId) if (trace.frames[trace.stacks[k].frameId].name === under) { hit = true; break; }
        if (!hit) continue;
        total++;
        let id = smp.stackId, first = true;
        const seen = new Set();
        while (id !== undefined) {
            const st = trace.stacks[id], n = name(st.frameId);
            if (first) { self.set(n, (self.get(n) || 0) + 1); first = false; }
            if (!seen.has(n)) { seen.add(n); incl.set(n, (incl.get(n) || 0) + 1); }
            id = st.parentId;
        }
    }
    const fmt = m => [...m].sort((a, b) => b[1] - a[1]).slice(0, top).map(([k, v]) => (100 * v / total).toFixed(1) + '% ' + k).join('\n');
    return ['samples ' + total + ' over ' + profFrame + ' frames', '-- self', fmt(self), '-- inclusive', fmt(incl)].join('\n');
}

// GPU time per frame (EXT_disjoint_timer_query_webgl2) of the renderer's
// passes and of whole r3.render, measured on alternate frames (queries
// cannot nest).
async function gpu({ scenario = 'move', overlay = 'none', mode = '3d', zoom = 0.35, frames = 60, framesPerTick = 3, startTick = 40000,
    parts = ['drawBackground', 'drawShadows', 'drawTexturedCubeInstances', 'drawCubeInstances', 'drawGroundOverlays', 'resolveScene', 'presentSceneToCanvas', 'drawFlatBatch'] } = {}) {
    const r3 = ensure3DRendererInitialized(), gl = r3.gl, ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
    if (!ext) return null;
    OVERLAYS[overlay]();
    setRenderDimensionMode(mode); camera.zoom = zoom;
    camera.x = GRID_W / 2 * TILE - viewW / zoom / 2; camera.y = GRID_H / 2 * TILE - viewH / zoom / 2;
    const pending = [], sums = {}, unwrap = [];
    let active = false, whole = false;
    const wrapQ = (name, key) => {
        const f = r3[key]; if (typeof f !== 'function') return;
        r3[key] = function (...a) {
            if (active || (whole !== (name === 'render'))) return f.apply(this, a);
            const q = gl.createQuery(); active = true; gl.beginQuery(ext.TIME_ELAPSED_EXT, q);
            try { return f.apply(this, a); } finally { gl.endQuery(ext.TIME_ELAPSED_EXT); active = false; pending.push([name, q]); }
        };
        unwrap.push([key, f]);
    };
    wrapQ('render', 'render');
    for (const p of parts) wrapQ(p, p);
    const sc = SCENARIOS[scenario];
    let t = startTick;
    try {
        for (let i = 0; i < frames * 2 + 10; i++) {
            if (i % framesPerTick === 0) { gameOver = false; refill(); issue(sc.tick(t)); gameTick(); t++; }
            _tickAccumulator = TICK_MS * ((i % framesPerTick) / framesPerTick);
            whole = (i & 1) === 1;
            if (i === 10) pending.length = 0;
            renderFrame(performance.now());
            gl.finish();
        }
    } finally { for (const [k, f] of unwrap) r3[k] = f; }
    await sleep(50);
    const n = {};
    for (const [name, q] of pending) {
        if (gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE) && !gl.getParameter(ext.GPU_DISJOINT_EXT)) {
            sums[name] = (sums[name] || 0) + gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6; n[name] = (n[name] || 0) + 1;
        }
        gl.deleteQuery(q);
    }
    const out = { mode, zoom, overlay };
    for (const k in sums) out[k] = r2(sums[k] / frames);
    return out;
}

// A compact A/B suite: CPU+GPU-synced frame times and GPU pass times for
// the move scenario (with and without selection) and a fight, 3D and 2D.
async function suite({ frames = 60, views = [['3d', 0.35], ['3d', 1], ['2d', 0.35]], detail = true } = {}) {
    const rows = [];
    const keep = r => { const o = {}; for (const k of ['scenario', 'overlay', 'mode', 'zoom', 'cpu', 'synced', 'p95']) o[k] = r[k];
        for (const k in r) if (k.startsWith('ms:') && r[k] >= 0.05) o[k.slice(3)] = r[k]; return o; };
    for (let i = 0; i < 20; i++) { gameOver = false; refill(); issue(SCENARIOS.move.tick(i)); gameTick(); }
    for (const overlay of ['none', 'select']) {
        OVERLAYS[overlay]();
        for (const [mode, zoom] of views) rows.push(keep(await probe({ scenario: 'move', overlay, mode, zoom, frames, detail, startTick: 1000 + rows.length * 200 })));
    }
    OVERLAYS.none();
    for (let i = 0; i < 140; i++) { gameOver = false; refill(); issue(SCENARIOS.fight.tick(i)); gameTick(); }
    for (const [mode, zoom] of views) rows.push(keep(await probe({ scenario: 'fight', overlay: 'none', mode, zoom, frames, detail, startTick: 140 })));
    return rows;
}

// Renders one captured scene K times back to back and drains the GPU:
// wall time per frame approximates max(CPU submit, GPU) with clocks up.
// Also reports r3.render CPU time alone (no drain between frames).
async function throughput({ scenario = 'move', overlay = 'none', mode = '3d', zoom = 0.35, K = 150, reps = 3 } = {}) {
    const r3 = ensure3DRendererInitialized(), gl = r3.gl, px = new Uint8Array(4);
    OVERLAYS[overlay]();
    setRenderDimensionMode(mode); camera.zoom = zoom;
    camera.x = GRID_W / 2 * TILE - viewW / zoom / 2; camera.y = GRID_H / 2 * TILE - viewH / zoom / 2;
    for (let i = 0; i < 5; i++) renderFrame(performance.now());
    const snap = build3DFrameData(mode === '2d');
    const walls = [];
    for (let rep = 0; rep < reps; rep++) {
        for (let i = 0; i < 20; i++) r3.render(snap);
        gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
        const a = performance.now();
        for (let i = 0; i < K; i++) r3.render(snap);
        gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
        walls.push((performance.now() - a) / K);
        await sleep(0);
    }
    return { mode, zoom, overlay, objects: snap.objects.length, perFrame: r2(Math.min(...walls)), all: walls.map(r2) };
}

// Deterministic frame capture for before/after comparisons: an exact hash
// of the presented pixels plus a coarse grid of block-average colors.
function pixels({ mode = '3d', zoom = 0.35, overlay = 'none', gx = null, gy = null, blocks = [48, 32] } = {}) {
    const r3 = ensure3DRendererInitialized(), gl = r3.gl;
    OVERLAYS[overlay]();
    setRenderDimensionMode(mode); camera.zoom = zoom;
    camera.x = (gx ?? GRID_W / 2) * TILE - viewW / zoom / 2; camera.y = (gy ?? GRID_H / 2) * TILE - viewH / zoom / 2;
    _tickAccumulator = TICK_MS * 0.5;
    for (let i = 0; i < 3; i++) renderFrame(performance.now());
    const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight, buf = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    let hash = 2166136261;
    for (let i = 0; i < buf.length; i++) hash = Math.imul(hash ^ buf[i], 16777619);
    const [bx, by] = blocks, grid = [];
    for (let j = 0; j < by; j++) for (let i = 0; i < bx; i++) {
        let r = 0, g = 0, b = 0, n = 0;
        for (let y = Math.floor(j * h / by); y < Math.floor((j + 1) * h / by); y += 2) for (let x = Math.floor(i * w / bx); x < Math.floor((i + 1) * w / bx); x += 2) {
            const o = (y * w + x) * 4; r += buf[o]; g += buf[o + 1]; b += buf[o + 2]; n++;
        }
        grid.push(Math.round(r / n), Math.round(g / n), Math.round(b / n));
    }
    const out = { mode, zoom, overlay, w, h, hash: (hash >>> 0).toString(16), grid: grid.join(',') };
    if (pixels.png) out.png = r3.canvas.toDataURL('image/png');
    return out;
}

async function save(name, data) {
    await fetch('/__save/' + name, { method: 'POST', body: JSON.stringify(data) });
}

// Pixel captures of a deterministic game at fixed states and views.
async function captureSet(name = 'pixels') {
    const views = [['3d', 0.35, 'none'], ['3d', 1, 'select'], ['3d', 0.6, 'rangesAll'], ['3d', 0.6, 'selectThrough'], ['2d', 0.35, 'select'], ['2d', 1, 'none']];
    const out = [];
    for (let i = 0; i < 30; i++) { gameOver = false; refill(); issue(SCENARIOS.move.tick(i)); gameTick(); }
    const stateHash = () => { let h = 2166136261; for (const u of units) for (const v of [u.x, u.y, u.energy, u.dead ? 1 : 0]) h = Math.imul(h ^ Math.round((v || 0) * 100), 16777619); return (h >>> 0).toString(16) + ':' + projectiles.length + ':' + particles.length; };
    out.push({ state: 'sim-move', hash: stateHash() });
    for (const [mode, zoom, overlay] of views) out.push({ state: 'move', ...pixels({ mode, zoom, overlay }) });
    OVERLAYS.none();
    for (let i = 0; i < 140; i++) { gameOver = false; refill(); issue(SCENARIOS.fight.tick(i)); gameTick(); }
    out.push({ state: 'sim-fight', hash: stateHash() });
    for (const [mode, zoom, overlay] of views) out.push({ state: 'fight', ...pixels({ mode, zoom, overlay }) });
    OVERLAYS.none();
    for (const o of out) if (o.png) { await save(`${name}-${o.state}-${o.mode}-${o.zoom}-${o.overlay}-png`, o.png); delete o.png; }
    await save(name, out);
    return out.map(o => [o.state, o.mode, o.zoom, o.overlay, o.hash].join(' '));
}

// Same-state visual A/B of renderer3d.js: the page's renderer and a baseline
// copy (evaluated into the page) draw identical game states. Order per
// state: warm-up, current, baseline, current again (the noise floor).
async function swapRenderer(source) {
    const old = renderer3dInstance;
    if (old && old.canvas) old.canvas.remove();
    (0, eval)(source);
    (0, eval)('renderer3dInstance = null');
    ensure3DRendererInitialized();
    renderer3dInstance.resize(viewW, viewH);
}
async function rendererAB({ name = 'ab', baseUrl = '/__base/rng/defence3/src/audio_visual/renderer3d.js',
    views = [['3d', 0.35, 'none'], ['3d', 1, 'select'], ['3d', 0.6, 'rangesAll'], ['3d', 0.6, 'selectThrough'], ['2d', 0.35, 'select'], ['2d', 1, 'none']],
    png = [] } = {}) {
    const newSrc = await (await fetch('/rng/defence3/src/audio_visual/renderer3d.js?ab=' + Math.random())).text();
    const baseSrc = await (await fetch(baseUrl)).text();
    const out = [];
    const pass = async (label, state) => {
        for (const [mode, zoom, overlay] of views) {
            const want = png.some(([m, z, o]) => m === mode && z === zoom && o === overlay);
            pixels.png = want;
            const r = pixels({ mode, zoom, overlay });
            if (r.png) { await save(`${name}-${state}-${label}-${mode}-${zoom}-${overlay}-png`, r.png); delete r.png; }
            out.push({ state, label, ...r });
        }
        pixels.png = false;
    };
    const states = [['move', 30, SCENARIOS.move], ['fight', 140, SCENARIOS.fight]];
    for (const [state, ticks, sc] of states) {
        for (let i = 0; i < ticks; i++) { gameOver = false; refill(); issue(sc.tick(i)); gameTick(); }
        for (const [mode, zoom, overlay] of views) pixels({ mode, zoom, overlay });
        await pass('new', state);
        await swapRenderer(baseSrc);
        for (const [mode, zoom, overlay] of views) pixels({ mode, zoom, overlay });
        await pass('base', state);
        await swapRenderer(newSrc);
        for (const [mode, zoom, overlay] of views) pixels({ mode, zoom, overlay });
        await pass('new2', state);
        OVERLAYS.none();
    }
    await save(name, out);
    return out.map(o => [o.state, o.label, o.mode, o.zoom, o.overlay, o.hash].join(' '));
}

// Time build3DFrameData's sections (injected timers, other code untouched)
// and the unit loop's cached vs rebuilt paths.
async function sections({ scenario = 'fight', mode = '3d', zoom = 0.35, frames = 90, overlay = 'none', startTick = 20000 } = {}) {
    const src = (await (await fetch('/rng/defence3/src/audio_visual/renderer.js?s=' + Math.random())).text()).replace(/\r\n/g, '\n');
    const start = src.indexOf('function build3DFrameData');
    let fn = src.slice(start, src.indexOf('\nfunction drawInteractionOverlay', start));
    const marks = [
        ['    let overlays = build3DOverlayData(bounds, alpha);', 'pre'], ['    let soundGrid = audioSpatialGrid;', 'overlay'],
        ['    for (let m of goldMines) {', 'occupied'], ['    let pushCellItem = (x, y, cell) => {', 'mines'],
        ['    for (let t of towers) {', 'items'], ['    for (let s of collectorSpawners) {', 'towers'],
        ['    for (let d of droppedItems) {', 'spawnersBarracks'], ['    if (flat2d) drainFlatObjects();\n    for (let u of units) {', 'dropped'],
        ['    // Shots, debris, attacks and laser fences: GPU effect instances.', 'units'],
        ['    for (let [key, state] of renderer3dOverlapFadeState) {', 'effects'], ['    return {\n        flat2d,', 'fade']];
    fn = fn.replace('{', '{ let __t = performance.now(), __n; const __T = (k) => { __n = performance.now(); (window.__SEC[k] = (window.__SEC[k]||0) + __n - __t); __t = __n; };');
    for (const [m, k] of marks) { if (!fn.includes(m)) throw new Error('missing ' + k); fn = fn.replace(m, `__T('${k}');\n` + m); }
    fn = fn.replace('            let activity = getUnit3DActivity(u);', '            window.__SEC.rebuilds = (window.__SEC.rebuilds || 0) + 1;\n            let activity = getUnit3DActivity(u);');
    window.__SEC = {};
    const orig = build3DFrameData;
    OVERLAYS[overlay]();
    (0, eval)(fn);
    let r;
    try { r = await probe({ scenario, overlay, mode, zoom, frames, warm: 0, wrap: ['build3DFrameData', 'r3.render'], startTick }); }
    finally { window.build3DFrameData = orig; OVERLAYS.none(); }
    const out = { cpu: r.cpu, build: r['ms:build3DFrameData'], render: r['ms:r3.render'], particles: r.particles, units: r.units };
    for (const k in __SEC) out[k] = r2(__SEC[k] / frames);
    return out;
}

function table(rows, keys = ['scenario', 'overlay', 'mode', 'zoom', 'cpu', 'synced', 'p95', 'picks']) {
    return rows.map(r => keys.map(k => r[k]).join('\t')).join('\n');
}

window.RB = { setup, sections, rendererAB, swapRenderer, save, captureSet, pixels, throughput, suite, gpu, sampleStart, sampleRun, sampleStop, probe, matrix, table, SCENARIOS, OVERLAYS, issue, alive, refill };
return 'RB ready';
})();
