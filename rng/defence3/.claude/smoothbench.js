// Camera smoothness benchmark on the REAL frame loop (rAF + fill-in frames).
// Load from the console (or the preview):
//   await (0,eval)(await (await fetch('/rng/defence3/.claude/smoothbench.js')).text());
//   await SB.setup()                        // 2 teams: 200 ice res, 200 water res, 200 snakes,
//                                           // 200 builders each + ~150 buildings each
//   await SB.run({ mode: '2d', zoom: 0.5, seconds: 8, pan: true, zoomWheel: false })
// While it runs, units get new rally points every 3 s and the camera pans with
// held keys (and optionally zooms with wheel events). Each rendered frame
// records when it started/ended and where the camera was. Reported:
//   interval p50/p95/p99/max: time between frame ends (what the display gets)
//   hitch%: frame gaps longer than 1.5 target intervals
//   judderPx: RMS screen-pixel error of each frame's camera position against
//             constant-velocity motion at the frame's end time (0 = perfect)
//   work: ms spent in the render frame; tick: ms per game tick
(() => {
const sleep = ms => new Promise(r => setTimeout(r, ms));
const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
const pct = (a, p) => { if (!a.length) return 0; const b = [...a].sort((x, y) => x - y); return b[Math.min(b.length - 1, Math.floor(b.length * p))]; };
const r2 = v => Math.round(v * 100) / 100;
let rngState = 11;
const rand = () => { rngState = (Math.imul(rngState, 1664525) + 1013904223) >>> 0; return rngState / 4294967296; };

async function newGame(size) {
    const set = (id, v) => { const e = document.getElementById(id); if (e) { e.value = String(v); e.dispatchEvent(new Event('change')); } };
    set('cfg-mapsize', size); set('cfg-map-type', 'arena'); set('cfg-max-pop', 5000);
    set('cfg-starting-energy', 1e9); set('cfg-starting-astar', 1e9);
    [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Play Solo').click();
    await sleep(800);
}
function clearArena() {
    for (let y = 1; y < GRID_H - 1; y++) for (let x = 1; x < GRID_W - 1; x++) {
        const c = grid[y][x];
        if (c.type === TYPE_WALL && !c.item && !getTowerAtTile(x, y) && !getGoldMineAt(x, y) && !getAstarMineAt(x, y)) c.type = TYPE_FLOOR;
    }
    _bumpPathTopologyVersion();
    recalculateAdjacency();
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
function spawnUnit(type, owner, gx, gy) {
    const u = new Unit(type, owner, gx * TILE + 16, gy * TILE + 16);
    applyUnitLevelScaling(u, 1);
    u.energy = u.preComputed.maxEnergy;
    units.push(u); players[owner].popCount++;
    updateUnitSpatial(u);
    return u;
}
const BUILDINGS = ['pistol', 'smg', 'water', 'poison', 'fire', 'sand_gun', 'ice', 'sniper', 'laser', 'house', 'house', 'barrack_norm',
    'barrack_snake', 'farm', 'builder_spawner'];
const UNITS = ['ice_resistant', 'water_resistant', 'snake', 'builder_unit'];
const combat = owner => units.filter(u => !u.dead && u.owner === owner && !u.workerType);

async function setup({ size = 120, perType = 200, buildings = 150 } = {}) {
    if (gameStarted) throw new Error('reload the page first');
    await newGame(size);
    clearArena();
    const keys = BUILDINGS.filter(k => BASE_CARD_TYPES[k]);
    for (let pid = 0; pid < 2; pid++) {
        const bx = Math.round(GRID_W * (pid ? .72 : .28)), by = Math.round(GRID_H * .5);
        let placed = 0;
        for (let tries = 0; placed < buildings && tries < 20000; tries++) {
            const gx = Math.round(bx + (rand() - .5) * 30), gy = Math.round(by + (rand() - .5) * 70);
            if (place(keys[placed % keys.length], pid, gx, gy)) placed++;
        }
        let n = 0;
        for (const type of UNITS) for (let i = 0; i < perType; i++, n++) {
            const gx = bx - 15 + n % 30, gy = by - 20 + Math.floor(n / 30);
            if (tileFree(gx, gy)) spawnUnit(type, pid, gx, gy); else spawnUnit(type, pid, bx, by);
        }
    }
    selectedUnits = []; selectedEntities = [];
    return { units: units.length, buildings: getCellItemsRowMajor().length, towers: towers.length };
}

function rally() {
    for (let pid = 0; pid < 2; pid++) {
        const list = combat(pid);
        const groups = 4;
        for (let g = 0; g < groups; g++) {
            const ids = list.filter((u, i) => i % groups === g).map(u => u.id);
            const x = (0.1 + rand() * 0.8) * GRID_W * TILE, y = (0.1 + rand() * 0.8) * GRID_H * TILE;
            processActions([{ action: 'move', unitIds: ids, targetX: x, targetY: y }], pid);
        }
    }
}

// Real loop run. Frame telemetry comes from wrapping processRenderFrame.
async function run({ mode = '2d', zoom = 0.5, seconds = 8, segMs = 250, pan = true, zoomWheel = false, rallyEvery = 3000, boost = null, target = null, pacing = null } = {}) {
    setRenderDimensionMode(mode);
    if (target && typeof setFpsTargetSetting === 'function') setFpsTargetSetting(target);
    
    camera.zoom = zoom;
    camera.x = GRID_W * TILE * .5 - viewW / zoom / 2; camera.y = GRID_H * TILE * .5 - viewH / zoom / 2;
    clampCamera();
    await sleep(500);
    const frames = [], ticks = [];
    const origRender = window.processRenderFrame;
    window.processRenderFrame = function (ts) {
        const a = performance.now();
        try { return origRender.apply(this, arguments); }
        finally { frames.push({ a, b: performance.now(), t: ts, x: camera.x, y: camera.y, z: camera.zoom }); }
    };
    // Simulation work: every sim task (a whole tick, or a slice of one).
    const origSim = window.processVisibleSimulationFrame, tick0 = currentTick;
    window.processVisibleSimulationFrame = function () {
        const a = performance.now();
        try { return origSim.apply(this, arguments); } finally { ticks.push(performance.now() - a); }
    };
    const rafs = [];
    let logging = true;
    const logRaf = ts => { rafs.push(ts); if (logging) requestAnimationFrame(logRaf); };
    requestAnimationFrame(logRaf);
    const dirs = [['d'], ['s'], ['a'], ['w']];
    const t0 = performance.now();
    let lastRally = -1e9, seg = -1, wheelAt = 0, wheelDir = 1;
    const area = document.getElementById('game-area');
    try {
        while (performance.now() - t0 < seconds * 1000) {
            const el = performance.now() - t0;
            if (el - lastRally >= rallyEvery) { rally(); lastRally = el; }
            if (pan) {
                const s = Math.floor(el / segMs) % dirs.length;
                if (s !== seg) { for (const k of ['w', 'a', 's', 'd']) keysDown[k] = false; for (const k of dirs[s]) keysDown[k] = true; seg = s; }
            }
            if (zoomWheel && el - wheelAt > 140) {
                wheelAt = el;
                if (camera.zoom > zoom * 1.6) wheelDir = 1; else if (camera.zoom < zoom / 1.6) wheelDir = -1;
                const r = area.getBoundingClientRect();
                area.dispatchEvent(new WheelEvent('wheel', { deltaY: 100 * wheelDir, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, bubbles: true, cancelable: true }));
            }
            for (const u of units) if (!u.dead && u.energy < (u.preComputed?.maxEnergy || 0)) u.energy = u.preComputed.maxEnergy;
            await sleep(20);
        }
    } finally {
        for (const k of ['w', 'a', 's', 'd']) keysDown[k] = false;
        logging = false;
        window.processRenderFrame = origRender; window.processVisibleSimulationFrame = origSim;
    }
    const clamped = frames.filter(f => f.x <= 0.5 || f.y <= 0.5 || f.x >= WORLD_W - viewW / f.z - 0.5 || f.y >= WORLD_H - viewH / f.z - 0.5).length;
    const nTicks = currentTick - tick0;
    return { ...analyze(frames, ticks, rafs, { mode, zoom, pan, zoomWheel }), clampedFrames: clamped, simMsPerTick: r2(ticks.reduce((x, y) => x + y, 0) / Math.max(1, nTicks)), tps: r2(nTicks / seconds), pace: typeof getPacedFrameRate === 'function' ? getPacedFrameRate() : null };
}

// What a display refreshing at `hz` shows: at each vsync (phase from the rAF
// timestamps) the newest frame finished before it. Judder is the RMS screen-px
// error of those camera positions against a straight line over each pan
// segment; repeat% is the share of vsyncs that got no new frame.
function displayed(frames, rafs, hz) {
    const period = 1000 / hz;
    const phase = rafs.length ? rafs[0] : frames[0].b;
    const out = [];
    let fi = 0, last = null, repeats = 0, n = 0;
    const start = frames[0].b, end = frames[frames.length - 1].b;
    for (let v = phase + Math.ceil((start - phase) / period) * period; v <= end; v += period) {
        while (fi < frames.length && frames[fi].b <= v) fi++;
        const f = frames[fi - 1];
        if (!f) continue;
        n++;
        if (f === last) repeats++;
        last = f;
        out.push({ v, x: f.x, y: f.y, z: f.z });
    }
    return { out, repeatPct: 100 * repeats / Math.max(1, n) };
}

function judder(samples) {
    // Segments: constant zoom and constant movement direction.
    const res = [];
    let seg = [];
    const flush = () => {
        if (seg.length >= 10) {
            for (const axis of ['x', 'y']) {
                const n = seg.length, ts = seg.map(f => f.v), vs = seg.map(f => f[axis]);
                const mt = mean(ts), mv = mean(vs);
                let num = 0, den = 0; for (let i = 0; i < n; i++) { num += (ts[i] - mt) * (vs[i] - mv); den += (ts[i] - mt) ** 2; }
                const k = den ? num / den : 0;
                if (Math.abs(k) < 1e-3) continue;
                // Skip the ease-in/out: only the middle 80% of the segment.
                for (let i = Math.floor(n * .1); i < Math.ceil(n * .9); i++) res.push(((vs[i] - mv) - k * (ts[i] - mt)) * seg[i].z);
            }
        }
        seg = [];
    };
    let dir = null;
    for (const f of samples) {
        const p = seg[seg.length - 1];
        if (p) {
            const d = [Math.sign(Math.round(f.x - p.x)), Math.sign(Math.round(f.y - p.y))];
            if (f.z !== p.z) { flush(); dir = null; }
            else if (d[0] || d[1]) {
                if (dir && (d[0] !== dir[0] || d[1] !== dir[1])) { flush(); dir = d; }
                else dir = dir || d;
            }
        }
        seg.push(f);
    }
    flush();
    return Math.sqrt(mean(res.map(v => v * v)));
}

function analyze(frames, ticks, rafs, info) {
    const iv = [], work = [];
    for (let i = 1; i < frames.length; i++) iv.push(frames[i].b - frames[i - 1].b);
    for (const f of frames) work.push(f.b - f.a);
    const d60 = displayed(frames, rafs, 60), d120 = displayed(frames, rafs, 120);
    let rafMed = 0;
    if (rafs.length > 2) { const d = []; for (let i = 1; i < rafs.length; i++) d.push(rafs[i] - rafs[i - 1]); rafMed = pct(d, .5); }
    return {
        ...info, frames: frames.length, fps: r2(1000 * (frames.length - 1) / ((frames.at(-1)?.b || 0) - (frames[0]?.b || 0))), rafMs: r2(rafMed),
        p50: r2(pct(iv, .5)), p95: r2(pct(iv, .95)), p99: r2(pct(iv, .99)), max: r2(Math.max(0, ...iv)),
        judder60: r2(judder(d60.out)), repeat60: r2(d60.repeatPct), judder120: r2(judder(d120.out)), repeat120: r2(d120.repeatPct),
        work: r2(mean(work)), workP95: r2(pct(work, .95)), simTaskP95: r2(pct(ticks, .95)), simTaskMax: r2(Math.max(0, ...ticks)),
        units: units.filter(u => !u.dead).length
    };
}

// Sampling profile (JS Self-Profiling; the smoke server sends the header).
// what: 'tick' runs n game ticks back to back (rally every 60); 'render'
// draws n frames at the given mode/zoom with a tick every 6 frames.
async function profile({ what = 'tick', n = 200, mode = '3d', zoom = 0.5, top = 45, under = null } = {}) {
    setRenderDimensionMode(mode);
    camera.zoom = zoom;
    camera.x = GRID_W * TILE * .5 - viewW / zoom / 2; camera.y = GRID_H * TILE * .5 - viewH / zoom / 2;
    const prof = new Profiler({ sampleInterval: 1, maxBufferSize: 1e7 });
    const t0 = performance.now();
    for (let i = 0; i < n; i++) {
        if (what === 'tick') { if (i % 60 === 0) rally(); gameTick(); }
        else { if (i % 6 === 0) gameTick(); _tickAccumulator = TICK_MS * (i % 6) / 6; renderFrame(performance.now()); }
        if (i % 20 === 19) await sleep(0);
    }
    const ms = performance.now() - t0;
    const trace = await prof.stop();
    under = under || (what === 'tick' ? 'gameTick' : 'processRenderFrame');
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
            const st = trace.stacks[id], nm = name(st.frameId);
            if (first) { self.set(nm, (self.get(nm) || 0) + 1); first = false; }
            if (!seen.has(nm)) { seen.add(nm); incl.set(nm, (incl.get(nm) || 0) + 1); }
            id = st.parentId;
        }
    }
    const fmt = m => [...m].sort((a, b) => b[1] - a[1]).slice(0, top).map(([k, v]) => (100 * v / total).toFixed(1) + '% ' + k).join('\n');
    return [`${what} x${n}: ${r2(ms / n)} ms each, samples ${total}`, '-- self', fmt(self), '-- inclusive', fmt(incl)].join('\n');
}

// Spike finder on the real loop: wraps the main per-frame and per-tick
// functions, then lists the slowest frames and simulation tasks with where
// their time went (and the tick's gameTime % TICK_RATE).
const SPIKE_WRAP = ['processRenderFrame', 'processVisibleSimulationFrame', 'runOneTick', 'gameTick', 'sampleGameStats',
    'updateAllPlayerVisibility', 'updateVisibility', 'recomputePlayerPopCaps', 'recalculateUnitEffectiveStats', 'recalculateThingPrecomputedStats',
    'build3DFrameData', 'drawMinimap', 'drawInteractionOverlay', 'flushTickUiRequests', 'updateHUD', 'updateControlGroupBar', 'updateBuildMenu',
    'updateInfoPanel', 'updateBottomBar', 'commitStaticCaches', 'updateCamera', 'refreshResourcePenaltyPopupContent', 'requestResearchPopupRefresh',
    '_runAdjacencyRecalculation', 'processGlobalSpawnerQueue', 'r3.render'];
// In a real game: `await SB.spikes({ keepCamera: true, pan: false })`, then
// pan by hand for `seconds`. `gaps` lists browser-frame gaps over 1.6x the
// usual one (at: ms from start) - stalls there with no slow event are
// outside JavaScript (GPU, layout, garbage collection).
async function spikes({ mode = '3d', zoom = 0.5, seconds = 8, pan = true, top = 12, keepCamera = false } = {}) {
    if (!keepCamera) {
        setRenderDimensionMode(mode);
        camera.zoom = zoom;
        camera.x = GRID_W * TILE * .5 - viewW / zoom / 2; camera.y = GRID_H * TILE * .5 - viewH / zoom / 2;
        await sleep(500);
    }
    const rafs = [];
    let logging = true;
    const logRaf = ts => { rafs.push(ts); if (logging) requestAnimationFrame(logRaf); };
    requestAnimationFrame(logRaf);
    const r3 = renderer3dInstance;
    const cur = { stack: [] }, events = [], unwrap = [];
    for (const n of SPIKE_WRAP) {
        const [obj, key] = n.startsWith('r3.') ? [r3, n.slice(3)] : [window, n];
        const f = obj && obj[key]; if (typeof f !== 'function') continue;
        obj[key] = function (...a) {
            const t = performance.now();
            const outer = cur.stack.length === 0;
            if (outer) cur.ev = { kind: n, t, parts: {}, gt: typeof gameTime === 'number' ? gameTime % TICK_RATE : -1 };
            cur.stack.push(n);
            try { return f.apply(this, a); }
            finally {
                cur.stack.pop();
                const d = performance.now() - t;
                if (outer) { cur.ev.ms = d; events.push(cur.ev); cur.ev = null; }
                else if (cur.ev) cur.ev.parts[n] = (cur.ev.parts[n] || 0) + d;
            }
        };
        unwrap.push([obj, key, f]);
    }
    const t0 = performance.now();
    const dirs = ['d', 's', 'a', 'w'];
    try {
        while (performance.now() - t0 < seconds * 1000) {
            if (pan) { const s = Math.floor((performance.now() - t0) / 250) % 4; for (const k of dirs) keysDown[k] = k === dirs[s]; }
            await sleep(20);
        }
    } finally {
        logging = false;
        if (pan) for (const k of dirs) keysDown[k] = false;
        for (const [obj, key, f] of unwrap) obj[key] = f;
    }
    const d = []; for (let i = 1; i < rafs.length; i++) d.push(rafs[i] - rafs[i - 1]);
    const med = pct(d, .5);
    const gaps = [];
    for (let i = 1; i < rafs.length; i++) if (d[i - 1] > med * 1.6) gaps.push([r2(rafs[i - 1] - t0), r2(d[i - 1])]);
    const byKind = {};
    for (const e of events) (byKind[e.kind] ||= []).push(e.ms);
    const summary = Object.fromEntries(Object.entries(byKind).map(([k, v]) => [k, { n: v.length, p50: r2(pct(v, .5)), p95: r2(pct(v, .95)), max: r2(Math.max(...v)) }]));
    const worst = events.slice().sort((a, b) => b.ms - a.ms).slice(0, top).map(e => ({ at: r2(e.t - t0), kind: e.kind, ms: r2(e.ms), gt: e.gt,
        parts: Object.fromEntries(Object.entries(e.parts).filter(([, v]) => v > 0.5).sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, r2(v)])) }));
    return { frameMs: r2(med), gapCount: gaps.length, gaps: gaps.slice(0, 60), summary, worst };
}

window.SB = { setup, run, rally, analyze, profile, spikes };
})();
