'use strict';
// One browser, one match: launches Edge, starts the match (solo, or a host
// and guests in their own windows), samples it (FPS, TPS, wasm heap, JS
// heaps, processes, GPU objects...) every few seconds, and runs trials: an
// action (or a chain) measured against what came before, then the way back
// to a calm state. The loop and the report are in ../perf-fuzz.cjs.
//
// A Player is one page of the match: its own window, probe, geometry and
// reference windows. A solo session has one; with --mp=N the host and N-1
// guests share one browser (the PeerJS stand-in of tests/browser-fake-peer.js
// carries the lockstep traffic). Trials drive one player at a time (they take
// turns) and measure all of them: one player's click is every player's tick.
const fs = require('node:fs');
const path = require('node:path');
const { sleep, loadPlaywright, makeRng, withTimeout, round } = require('./env.cjs');
const { freePort, connectBrowserCdp, workerProbe } = require('./cdp.cjs');
const { makeRef, judgeTrial } = require('./analyze.cjs');
const { byName, selTotal } = require('./actions.cjs');
const { selfTimes, top, excess, totals, stretch } = require('./profile.cjs');

const PROBE_SRC = fs.readFileSync(path.join(__dirname, 'probe.js'), 'utf8');
const INIT_PATH = path.join(__dirname, 'init.js');
const FAKE_PEER_PATH = path.join(__dirname, '..', 'browser-fake-peer.js');

class SessionDead extends Error { constructor(why) { super('session lost: ' + why); this.dead = true; } }

// What the simulation worker knows that the page does not: its wasm heap.
const WORKER_EXPR = '(() => { const h = simHeapStats(); return { heap: h, tick: currentTick, units: units.length, top: _simHeap.top }; })()';

const START_SOLO = async ({ fixture, vis }) => {
    if (/\.gz$/.test(fixture)) {
        await restoreSoloGameSnapshot(await readSoloGameSnapshotFile(await (await fetch('tests/' + fixture)).blob()));
        return { scene: true };
    }
    const data = await (await fetch('tests/' + fixture)).json();
    applyMainMenuSettingsSnapshot(data);
    if (vis) { const el = document.getElementById('cfg-full-vis'); if (el) el.value = vis; }
    // (The same match every time: the start seed comes from the clock.)
    const now = Date.now; Date.now = () => 1790000000000;
    try { startSoloGame(); } finally { Date.now = now; }
    return { scene: false };
};
const HOST_LOBBY = async ({ fixture, vis }) => {
    const data = await (await fetch('tests/' + fixture)).json();
    applyMainMenuSettingsSnapshot(data);
    if (vis) { const el = document.getElementById('cfg-full-vis'); if (el) el.value = vis; }
    loadOrCreateLocalIdentity(); hostOnlineGame();
};

const selClassOf = n => n <= 0 ? '0' : n < 100 ? '1-99' : n < 10000 ? '100-9999' : n < 100000 ? '10k-99k' : '100k+';
const zoomClassOf = z => z < 1.5 ? 'min' : z < 6 ? 'mid' : 'close';

// One page of the match.
class Player {
    constructor(S, page, name, index) {
        Object.assign(this, { S, page, name, index });
        this.dead = false; this.geom = null; this.viewport = { ...S.cfg.viewport }; this.idle = []; this.lowStreak = 0; this.lastWasm = null; this.lastPerf = null; this.perfCdp = null; this.lastSampleAt = null;
        this.netBase = null; this.lastNet = null;
    }
    async init() { this.perfCdp = await this.S.context.newCDPSession(this.page); await this.perfCdp.send('Performance.enable').catch(() => { }); }
    async ev(fn, arg, ms = 15000) {
        if (this.dead || this.S.dead) throw new SessionDead(this.name + ' page closed');
        try { return await withTimeout(this.page.evaluate(fn, arg), ms, this.name + ' page.evaluate'); }
        catch (e) { if (/closed|crash|Target page|disconnected/i.test(e.message)) { this.dead = true; throw new SessionDead(e.message.split('\n')[0]); } throw e; }
    }
    now() { return this.ev(() => __pf.now()); }
    win(t0, t1) { return this.ev(([a, b]) => __pf.win(a, b), [t0, t1]); }
    state() { return this.ev(() => __pf.state()); }
    controls(o) { return this.ev(([seed, opts]) => __pf.controls(seed, opts), [Math.floor(Math.random() * 2 ** 31), o || {}]); }
    async refreshGeom(seed) { this.geom = await this.ev(s => __pf.geom(s), seed || Math.floor(Math.random() * 2 ** 31), 20000); return this.geom; }
    async memQuick() {
        const m = { at: Date.now() };
        try {
            const r = JSON.parse(await this.ev(e => simClientRequest('debugEval', { expr: e }), WORKER_EXPR, 8000));
            m.wasmMem = r.heap.memoryMB; m.wasmLive = r.heap.liveMB; m.wasmPeak = r.heap.peakMB; m.wasmFree = r.heap.freeMB; m.arrays = r.heap.arrays; m.pendingFrees = r.heap.pendingFrees; m.workerTick = r.tick; m.workerUnits = r.units;
        } catch (e) { if (e.dead) throw e; }
        try { m.jsPage = await this.ev(() => performance.memory ? performance.memory.usedJSHeapSize / 1048576 : null); } catch (e) { if (e.dead) throw e; }
        return m;
    }
    async perfMetrics() {
        try { const r = await this.perfCdp.send('Performance.getMetrics'); const o = {}; for (const x of r.metrics) o[x.name] = x.value; return o; } catch { return null; }
    }
    idleRef() { return makeRef(this.idle.slice(-12)); }
    // A calm window joins the reference; a lasting new level (4 low ones in a row) replaces it.
    learn(base, ref) {
        const low = ref.tps > 0 && base.tps < ref.tps * 0.85;
        this.lowStreak = low ? this.lowStreak + 1 : 0;
        if (!low) this.idle.push(base);
        else if (this.lowStreak >= 4) { this.idle = this.idle.slice(-3); this.idle.push(base); this.lowStreak = 0; this.S.log(`${this.name}: reference level changed: tps ${round(ref.tps, 1)} -> ${base.tps}`); }
        if (this.idle.length > 40) this.idle.splice(0, this.idle.length - 40);
    }
}

class Session {
    constructor({ cfg, index, base, os, out, log, seed }) {
        Object.assign(this, { cfg, index, baseUrl: base, os, out, log, seed });
        this.trialN = 0; this.seen = new Set(); this.heldKeys = new Set(); this.heldButtons = new Set();
        this.errors = new Map(); this.lastStep = ''; this.incidents = []; this.checkpoints = [];
        this.t0 = cfg.t0 || Date.now(); this.s0 = Date.now(); this.lastOs = null; this.lastWorkers = null; this.lastSample = null;
        this.stalled = false; this.hung = 0; this.dead = false; this.state0 = null; this.players = []; this.cur = null; this.turn = 0;
        this.stats = { trials: 0, flagged: 0 };
    }
    // The player being driven now: the session's page-shaped methods are its.
    get page() { return this.cur.page; }
    get geom() { return this.cur.geom; }
    ev(...a) { return this.cur.ev(...a); }
    pageNow() { return this.cur.now(); }
    win(a, b) { return this.cur.win(a, b); }
    state() { return this.cur.state(); }
    controls(o) { return this.cur.controls(o); }
    refreshGeom(seed) { return this.cur.refreshGeom(seed); }
    memQuick() { return this.cur.memQuick(); }
    perfMetrics() { return this.cur.perfMetrics(); }
    idleRef() { return this.cur.idleRef(); }
    incident(r) { const rec = { session: this.index, at: round((Date.now() - this.t0) / 1000, 1), last: this.lastStep, ...r }; this.incidents.push(rec); this.out.incident(rec); return rec; }

    // ---- launch ----
    async open() {
        const { cfg } = this, mp = cfg.mp > 1;
        const pw = loadPlaywright();
        this.tag = 'pffuzz' + Date.now().toString(36) + this.index;
        const port = await freePort();
        const args = ['--enable-precise-memory-info', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
            '--disable-features=CalculateNativeWinOcclusion', `--remote-debugging-port=${port}`, `--perf-fuzz-tag=${this.tag}`, ...cfg.browserArgs];
        this.browser = await pw.chromium.launch({ channel: 'msedge', headless: !cfg.headed, args });
        this.browser.on('disconnected', () => { this.dead = true; });
        this.context = await this.browser.newContext({ viewport: cfg.viewport, deviceScaleFactor: 1 });
        await this.context.addInitScript({ path: INIT_PATH });
        if (mp) await this.context.addInitScript({ path: FAKE_PEER_PATH });
        this.cdp = await connectBrowserCdp(port);
        this.workers = workerProbe(this.cdp);
        this.edgeVersion = this.cdp.version;
        this.context.on('page', p => { if (!this.players.some(pl => pl.page === p) && !this.opening) p.close().catch(() => { }); });
        const vis = cfg.visRotation[this.index % cfg.visRotation.length];
        this.vis = vis;
        const url = `${this.baseUrl}/index.html${cfg.query ? '?' + cfg.query : ''}`;
        this.log(`session ${this.index}: starting ${cfg.fixture} (visibility ${vis || 'fixture'}${mp ? ', ' + cfg.mp + ' players, ' + cfg.mpDelayMs + ' ms one way' : ''}) in Edge ${this.edgeVersion}`);
        const started = Date.now();
        this.opening = true;
        const newPlayer = async (name, u) => {
            const page = await this.context.newPage(), pl = new Player(this, page, name, this.players.length);
            this.players.push(pl);
            page.on('pageerror', e => this.noteError(name + ' pageerror: ' + String(e.message).slice(0, 300)));
            page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource|Permissions policy|favicon/.test(m.text())) this.noteError(name + ': ' + m.text().slice(0, 300)); });
            page.on('crash', () => { pl.dead = true; this.dead = true; this.crashed(pl); });
            page.on('close', () => { pl.dead = true; this.dead = true; });
            page.on('dialog', d => d.dismiss().catch(() => { }));
            page.on('download', d => d.cancel().catch(() => { }));
            await page.goto(u, { waitUntil: 'load', timeout: 120000 });
            await pl.init();
            return pl;
        };
        const host = await newPlayer(mp ? 'host' : 'player', url);
        await sleep(1000);
        if (!mp) {
            await host.page.evaluate(START_SOLO, { fixture: cfg.fixture, vis });
        } else {
            if (/\.gz$/.test(cfg.fixture)) throw new Error('--mp needs a menu-settings fixture, not a scene');
            await host.page.evaluate(d => { window.__fakePeerDelayMs = d; }, cfg.mpDelayMs);
            await host.page.evaluate(HOST_LOBBY, { fixture: cfg.fixture, vis });
            await host.page.waitForFunction(() => !!myPeerId, {}, { timeout: 30000 });
            const hostId = await host.page.evaluate(() => myPeerId);
            for (let i = 1; i < cfg.mp; i++) {
                const g = await newPlayer('guest' + i, `${this.baseUrl}/index.html?game=${hostId}&room=${hostId}${cfg.query ? '&' + cfg.query : ''}`);
                await g.page.evaluate(d => { window.__fakePeerDelayMs = d; }, cfg.mpDelayMs);
                await g.page.evaluate(id => { loadOrCreateLocalIdentity(); joinGame(id); }, hostId);
            }
            await host.page.waitForFunction(n => lobbyPlayers.length >= n && connections.length >= n - 1, cfg.mp, { timeout: 60000 });
            for (let i = 0; i < this.players.length; i++) {
                await this.players[i].page.evaluate(i => {
                    const me = lobbyPlayers.find(p => p.peerId === myPeerId); if (!me) return;
                    me.color = TEAM_PRESET_COLORS[i];
                    if (isHost) broadcastLobbyState(true); else connections[0].send({ type: 'LOBBY_UPDATE_SELF', name: me.name, color: me.color });
                }, i);
            }
            await sleep(1500);
            await host.page.evaluate(() => startHostedGame());
        }
        for (const p of this.players) await p.page.waitForFunction(mpMode => typeof simClientStats === 'function' && simClientStats().appliedTick >= (mpMode ? 30 : 5) && typeof gameStarted !== 'undefined' && gameStarted && (!mpMode || !matchStartWaitingForReady), mp, { timeout: cfg.loadTimeoutMs });
        this.opening = false;
        this.loadS = round((Date.now() - started) / 1000, 1);
        for (const p of this.players) await p.page.evaluate(PROBE_SRC);
        if (cfg.plant.length) for (const spec of cfg.plant) this.log(`planted slowdown ${spec}: ${await host.page.evaluate(s => __pf.plant(s), spec)}`);
        this.info = await host.page.evaluate(() => {
            let gpu = null; try { const c = document.createElement('canvas'), gl = c.getContext('webgl2'), e = gl.getExtension('WEBGL_debug_renderer_info'); gpu = e ? gl.getParameter(e.UNMASKED_RENDERER_WEBGL) : null; } catch { }
            return { gpu, units: units.length, towers: towers.length, barracks: barracks.length, map: GRID_W, helpers: simClientStats().helpers, wasm64: null, crossOriginIsolated, vis: document.visibilityState };
        });
        try { this.info.wasm64 = JSON.parse(await host.page.evaluate(() => simClientRequest('debugEval', { expr: 'simHeapStats().wasm64' }))); } catch { }
        this.cur = host;
        this.log(`session ${this.index}: running after ${this.loadS} s; ${this.info.units} units, ${this.info.barracks} barracks, ${this.info.towers} towers, map ${this.info.map}, ${this.info.helpers} helpers, gpu ${this.info.gpu}, visibility ${this.info.vis}`);
        await this.workers.refresh();
        // Warm up (JIT, the first frames) and take the reference windows.
        await sleep(cfg.warmMs);
        for (let i = 0; i < 5; i++) { await sleep(1200); await Promise.all(this.players.map(async p => { const now = await p.now(); p.idle.push(await p.win(now - 3000, now)); })); }
        if (mp) for (const p of this.players) p.netBase = (await p.state()).net;
        // A match that starts out far under its tick rate says more about the machine than about any action.
        const slow = this.players.filter(p => p.idleRef().tps < 0.6 * 20);
        if (slow.length) { this.startWarning = `the idle match runs at ${slow.map(p => p.name + ' ' + round(p.idleRef().tps, 1)).join(', ')} TPS (20 expected): the machine is overloaded or the match is too big for it; every number here is relative to that`; this.log('WARNING: ' + this.startWarning); }
        this.startSampler();
        return this;
    }

    crashed(pl) {
        const s = this.lastSample, c = this.incident({ kind: 'crash', ms: 0, resolved: false, player: pl.name, sample: s && { freeMB: s.freeMB, priv: s.priv, privRenderer: s.privRenderer, privGpu: s.privGpu, wasmMem: s.wasmMem, jsPage: s.jsPage, units: s.units } });
        this.log(`ERROR: PAGE CRASHED (${pl.name}) during ${this.lastStep} ${JSON.stringify(c.sample || {})}`);
    }

    async close() {
        this.stopSampler();
        try { await withTimeout(this.browser.close(), 15000, 'browser close'); } catch { }
        try { this.cdp && this.cdp.close(); } catch { }
    }

    noteError(text) {
        const e = this.errors.get(text) || { text, count: 0, after: this.lastStep, session: this.index };
        e.count++; this.errors.set(text, e);
        if (e.count === 1) this.log('PAGE ERROR: ' + text.slice(0, 200));
    }

    // ---- continuous sampling ----
    startSampler() {
        this.samplerOn = true; let n = 0;
        const loop = async () => {
            while (this.samplerOn && !this.dead) {
                const t = Date.now();
                try { await this.sampleOnce(n++); if (this.hung) { if (this.hung >= 2) this.incident({ kind: 'hang', ms: this.hung * 12000, resolved: true }); this.hung = 0; } }
                catch (e) {
                    if (e.dead) return;
                    if (!e.timeout) this.log('sampler: ' + e.message.slice(0, 120));
                    else if (++this.hung === 2) this.log(`STALL: the page has not answered for ${this.hung * 12} s (last steps: ${this.lastStep})`);
                }
                await sleep(Math.max(100, this.cfg.sampleMs - (Date.now() - t)));
            }
        };
        this.samplerDone = loop();
    }
    stopSampler() { this.samplerOn = false; }

    // The numbers of one page for a sample row (the first player is the row, the others its peers).
    async playerSample(p, n) {
        const now = await withTimeout(p.now(), 12000, p.name + ' now'), prev = p.lastSampleAt;
        p.lastSampleAt = now;
        if (prev === null) return null;
        const w = await p.win(prev, now), s = await p.state();
        if (n % this.cfg.wasmEvery === 0) p.lastWasm = await p.memQuick();
        const m = p.lastWasm || {};
        const r = { fps: w.fps, tps: w.tps, frameP95: w.frame.p95, frameMax: w.frame.max, gapMax: w.tick.gapMax, simMean: w.sim.mean, simMax: w.sim.max, workMean: w.work.mean, longMax: w.long.max, handlerMax: w.input.handlerMax,
            tick: s.tick, units: s.units, sel: selTotal(s), view: s.view, zoomRel: s.zoomRel, visible: s.vis === 'visible', jsPage: s.mem ? round(s.mem.used / 1048576, 1) : null, nodes: s.nodes, panelNodes: s.panelNodes,
            wasmMem: m.wasmMem, wasmLive: m.wasmLive, wasmPeak: m.wasmPeak, wasmFree: m.wasmFree, wasmArrays: m.arrays, wasmPending: m.pendingFrees };
        if (s.gl) { r.glTextures = s.gl.textures; r.glBuffers = s.gl.buffers; r.glFramebuffers = s.gl.framebuffers; r.glRenderbuffers = s.gl.renderbuffers; r.glPrograms = s.gl.programs; r.glVaos = s.gl.vaos; }
        const pm = await p.perfMetrics();
        if (pm) {
            const p0 = p.lastPerf; p.lastPerf = pm;
            r.listeners = pm.JSEventListeners; r.arrayBuffers = pm.ArrayBufferContents; r.layoutObjects = pm.LayoutObjects; r.workerScopes = pm.WorkerGlobalScopes;
            // (Durations are running totals: what each interval spent in the page's main thread.)
            if (p0) { r.layoutMs = round((pm.LayoutDuration - p0.LayoutDuration) * 1000, 0); r.styleMs = round((pm.RecalcStyleDuration - p0.RecalcStyleDuration) * 1000, 0); r.scriptMs = round((pm.ScriptDuration - p0.ScriptDuration) * 1000, 0); r.taskMs = round((pm.TaskDuration - p0.TaskDuration) * 1000, 0); }
        }
        if (s.net) { r.desyncs = s.net.desyncs - (p.netBase ? p.netBase.desyncs : 0); r.resyncs = (s.net.patches + s.net.full + s.net.hard) - (p.netBase ? p.netBase.patches + p.netBase.full + p.netBase.hard : 0); r.fatalStop = s.net.stop || undefined; p.lastNet = s.net; }
        return { r, w, s };
    }

    async sampleOnce(n) {
        const cfg = this.cfg, first = this.players[0];
        const main = await this.playerSample(first, n);
        const peers = [];
        for (const p of this.players.slice(1)) { const x = await this.playerSample(p, n); if (x) peers.push({ name: p.name, ...x.r }); }
        if (!main) return;
        const { r, w } = main;
        const elapsed = (Date.now() - this.t0) / 1000, sessionT = (Date.now() - this.s0) / 1000;
        const row = { session: this.index, t: round(elapsed, 1), st: round(sessionT, 1), trial: this.trialN, active: this.cur ? this.cur.index : 0, ...r };
        if (n % cfg.workerEvery === 0) { try { this.lastWorkers = await this.workers.heap(); } catch { } }
        const wk = this.lastWorkers;
        if (wk) {
            let used = 0, backing = 0; for (const g of Object.values(wk)) { used += g.usedMB; backing += g.backingMB; }
            row.jsWorkers = round(used, 1); row.backingWorkers = round(backing, 1);
            if (wk.sim_worker) row.jsSim = wk.sim_worker.usedMB; if (wk.presentation_worker) row.jsPres = wk.presentation_worker.usedMB;
            const h = wk.sim_helper; if (h) { row.jsHelpers = h.usedMB; row.helpers = h.n; }
        }
        if (n % cfg.osEvery === 0 && this.os.available) {
            const o = await this.os.sample(this.tag, { gpu: n % cfg.gpuEvery === 0 });
            if (o && !o.error) this.lastOs = o;
        }
        const o = this.lastOs;
        if (o) {
            row.freeMB = o.freeMB; row.availMB = o.availMB; row.freeVirtMB = o.freeVirtMB; row.sysCpu = o.sysCpu;
            if (o.edge) { row.priv = o.edge.privMB; row.ws = o.edge.wsMB; row.handles = o.edge.handles; row.cores = o.edge.cores; row.privRenderer = o.edge.byType.renderer; row.privGpu = o.edge.byType['gpu-process']; if (o.edge.gpuDedicatedMB !== undefined) row.gpuDed = o.edge.gpuDedicatedMB; row.procs = o.edge.n; }
        }
        if (peers.length) row.peers = peers;
        // Stall watch: no tick result for a long time (a hung page times out above instead).
        if (w.tick.n === 0 && w.tick.trail >= cfg.stallMs) {
            if (!this.stalled) { this.stalled = true; this.stallAt = Date.now(); this.log(`STALL: no tick result for ${Math.round(w.tick.trail)} ms (last steps: ${this.lastStep})`); }
        } else if (this.stalled && w.tick.n > 0) {
            const ms = Date.now() - this.stallAt; this.stalled = false;
            this.incident({ kind: 'stall', ms, resolved: true });
        }
        // Lockstep health: a desync or a fatal stop is a finding at once.
        for (const x of [{ name: first.name, r }, ...peers.map(p => ({ name: p.name, r: p }))]) {
            if (x.r.fatalStop && !this['stop-' + x.name]) { this['stop-' + x.name] = true; this.log(`ERROR: ${x.name} reports a fatal lockstep stop (last steps: ${this.lastStep})`); this.incident({ kind: 'stop', player: x.name }); }
            if (x.r.desyncs > (this['desyncs-' + x.name] || 0)) { this['desyncs-' + x.name] = x.r.desyncs; this.log(`ERROR: DESYNC on ${x.name} (${x.r.desyncs} so far; last steps: ${this.lastStep})`); this.incident({ kind: 'desync', player: x.name, count: x.r.desyncs }); }
        }
        row.stalled = this.stalled || undefined;
        this.lastSample = row;
        this.out.sample(row);
    }

    // The tick hashes the players recorded, compared (MP only): a mismatch is a determinism bug.
    async hashCheck() {
        if (this.players.length < 2) return null;
        const per = await Promise.all(this.players.map(p => p.ev(() => {
            const out = {}, t = currentTick;
            for (let k = Math.max(1, t - 300); k < t; k++) { const h = typeof snapGetTickHash === 'function' ? snapGetTickHash(k) : null; if (h) out[k] = h.sum; }
            return out;
        }).catch(() => ({}))));
        let compared = 0, mismatched = 0, firstBad = null;
        for (const k of Object.keys(per[0])) for (let i = 1; i < per.length; i++) if (per[i][k] !== undefined) { compared++; if (per[i][k] !== per[0][k]) { mismatched++; if (firstBad === null) firstBad = Number(k); } }
        if (mismatched) { this.log(`ERROR: HASH MISMATCH between players: ${mismatched} of ${compared} ticks, first at tick ${firstBad} (last steps: ${this.lastStep})`); this.incident({ kind: 'mismatch', compared, mismatched, firstBad }); }
        return { compared, mismatched };
    }

    // ---- input (always the active player's page) ----
    makeCtx(rng) {
        const S = this, page = this.page;
        const vp = () => S.cur.viewport || S.cfg.viewport;
        const clampX = x => Math.max(1, Math.min(vp().width - 2, x)), clampY = y => Math.max(1, Math.min(vp().height - 2, y));
        const c = {
            rng, S, page, geom: this.geom, state0: this.state0,
            async refreshGeom() { c.geom = await S.refreshGeom(rng.int(1, 2 ** 30)); return c.geom; },
            state: () => S.state(), controls: o => S.controls(o),
            mouse: (x, y, steps = 1) => page.mouse.move(clampX(x), clampY(y), { steps }),
            keyDown: async k => { if (!S.heldKeys.has(k)) { S.heldKeys.add(k); await page.keyboard.down(k); } },
            keyUp: async k => { if (S.heldKeys.delete(k)) await page.keyboard.up(k); },
            async key(k, o = {}) { const mods = o.mods || []; for (const m of mods) await c.keyDown(m); try { await page.keyboard.press(k); } finally { for (const m of mods.slice().reverse()) await c.keyUp(m); } },
            async click(x, y, o = {}) {
                const mods = o.mods || [], button = o.button || 'left';
                for (const m of mods) await c.keyDown(m);
                try { await page.mouse.move(clampX(x), clampY(y)); await page.mouse.down({ button }); S.heldButtons.add(button); await sleep(o.hold || 12); await page.mouse.up({ button }); S.heldButtons.delete(button); }
                finally { for (const m of mods.slice().reverse()) await c.keyUp(m); }
            },
            async drag(x0, y0, x1, y1, o = {}) {
                const mods = o.mods || [], button = o.button || 'left';
                for (const m of mods) await c.keyDown(m);
                try {
                    await page.mouse.move(clampX(x0), clampY(y0)); await page.mouse.down({ button }); S.heldButtons.add(button); await sleep(15);
                    await page.mouse.move(clampX(x1), clampY(y1), { steps: o.steps || 6 }); await sleep(o.hold || 15);
                    await page.mouse.up({ button }); S.heldButtons.delete(button);
                } finally { for (const m of mods.slice().reverse()) await c.keyUp(m); }
            },
            wheel: dy => page.mouse.wheel(0, dy),
            setSelect: (x, y, v) => S.ev(([a, b, c2]) => __pf.setSelect(a, b, c2), [x, y, v]),
            setRange: (x, y, f) => S.ev(([a, b, c2]) => __pf.setRange(a, b, c2), [x, y, f]),
        };
        return c;
    }
    async releaseAll() {
        for (const k of [...this.heldKeys]) { this.heldKeys.delete(k); await this.page.keyboard.up(k).catch(() => { }); }
        for (const b of [...this.heldButtons]) { this.heldButtons.delete(b); await this.page.mouse.up({ button: b }).catch(() => { }); }
    }
    // Back to a quiet state: nothing held, no popup, menu, build ghost or selection, the mouse parked over a panel.
    async neutralize() {
        await this.releaseAll();
        let s = null;
        for (let i = 0; i < 5; i++) {
            await this.page.keyboard.press('Escape'); await sleep(120);
            s = await this.state();
            if (!s.popups.length && !s.menu && !s.build && !s.attackMove && selTotal(s) === 0) break;
        }
        // (The minimap, if a click folded it away: the map's own controls are part of the setup.)
        const park = await this.ev(() => { const r = document.getElementById('right-panel'); const b = r && r.getBoundingClientRect(); return b && b.width ? [b.left + b.width / 2, b.bottom - 20] : [innerWidth - 20, innerHeight - 20]; });
        await this.page.mouse.move(park[0], park[1]);
        return s;
    }
    // Controls the fuzzer's own clicks may have folded away for good (the minimap): put back.
    async restoreLayout() {
        const g = await this.refreshGeom();
        if (!g.minimap) { const b = (await this.controls({ ids: ['btn-minimap'] }))[0]; if (b) { await this.page.mouse.click(b.x, b.y); await sleep(300); } }
    }
    // Stop everything on the field (the second chance when a trial's slowdown may be only the armies still moving).
    async calm() {
        const c = this.makeCtx(makeRng(7));
        await this.ev(() => __pf.cam('min', 'map')); await sleep(300);
        await c.refreshGeom(); const r = c.geom.rect;
        await c.drag(r.left + 10, r.top + 48, r.right - 10, r.bottom - 10, { steps: 6 }); await sleep(300);
        await c.key('x'); await sleep(200); await this.neutralize();
    }

    // Wait for the match to be as fast as before on every page (or give up): { ok, ms, needCalm, deficit }.
    async recover(ref) {
        const T = this.cfg.thresholds, t0 = Date.now(), res = { ok: false, ms: 0, needCalm: false, deficit: 0 };
        const good = w => !w.visible || (w.tps >= ref.tps * T.recoverRel - 0.3 && w.fps >= ref.fps * 0.75 - 2);
        const wait = async limit => {
            let last = null;
            while (Date.now() - t0 < limit) {
                await sleep(700);
                const all = await Promise.all(this.players.map(async p => { const now = await p.now(); return p.win(now - 2200, now); }));
                last = all[this.cur.index];
                // (A peer is judged by its own calm level: its last reference.)
                if (all.every((w, i) => i === this.cur.index ? good(w) : (!w.visible || w.tps >= this.players[i].idleRef().tps * T.recoverRel - 0.3))) return { ok: true, last };
            }
            return { ok: false, last };
        };
        await this.neutralize();
        let r = await wait(this.cfg.recoverMs);
        if (!r.ok) {
            res.needCalm = true; await this.calm();
            r = await wait(this.cfg.recoverMs * 2);
        }
        res.ok = r.ok; res.ms = Date.now() - t0;
        if (!r.ok && r.last) { res.deficit = round(Math.max(0, (ref.tps - r.last.tps) / Math.max(1, ref.tps)), 3); res.last = { tps: r.last.tps, fps: r.last.fps }; }
        return res;
    }

    // ---- one trial ----
    async runTrial(planned, opts = {}) {
        if (planned.kind === 'leak') return this.leakTrial(planned);
        const cfg = this.cfg, T = cfg.thresholds, id = ++this.trialN;
        // Who plays this trial: the players take turns (the others watch).
        this.cur = this.players[cfg.mp > 1 ? (cfg.mpDrive === 'host' ? 0 : (this.turn++ % this.players.length)) : 0];
        const rec = { id, session: this.index, at: round((Date.now() - this.t0) / 1000, 1), kind: planned.kind, name: planned.name, cat: planned.cat, seed: planned.seed, steps: [], player: this.cur.name };
        const stepsOf = planned.steps.map(n => byName.get(n)).filter(Boolean);
        if (!stepsOf.length) { rec.skipped = 'unknown steps'; return rec; }
        this.lastStep = planned.name;
        const rng = makeRng(planned.seed);
        // 0. where we stand
        await this.refreshGeom(rng.int(1, 2 ** 30));
        this.state0 = await this.state();
        if (this.state0.over || !this.state0.started) throw new SessionDead('match ended');
        if (this.state0.vis !== 'visible') { rec.skipped = 'page hidden'; await sleep(3000); return rec; }
        const own = this.geom.own.total;
        if (own < 50 && this.info.units > 500) { rec.skipped = 'army gone'; this.armyGone = (this.armyGone || 0) + 1; if (this.armyGone >= 3) throw new SessionDead('army gone'); return rec; }
        this.armyGone = 0;
        const first = stepsOf[0], c = this.makeCtx(rng);
        c.state0 = this.state0;
        // 1. prelude (unmeasured), then the baseline window
        let hasPrelude = false;
        if (first.prelude) {
            hasPrelude = true;
            try { await withTimeout(first.prelude(c), 60000, first.name + ' prelude'); } catch (e) { if (e.dead) throw e; rec.preludeError = String(e.message).slice(0, 160); }
            const s1 = await this.state(); await sleep(selTotal(s1) > 1000 ? 2500 : 1000);
        }
        const st = await this.state();
        rec.ctx = { view: st.view, zoomRel: st.zoomRel, zoomClass: zoomClassOf(st.zoomRel), sel: selTotal(st), selClass: selClassOf(selTotal(st)), units: st.units, popups: st.popups.length, prelude: hasPrelude, settings: st.settings };
        const idleRef = this.idleRef();
        // Every page's clock is its own: the marks are taken per page.
        const marks = async () => Promise.all(this.players.map(p => p.now()));
        const t = await marks();
        const bases = await Promise.all(this.players.map((p, i) => p.win(t[i] - cfg.baseMs, t[i])));
        const base = bases[this.cur.index];
        const ref = hasPrelude ? makeRef([base]) : idleRef;
        rec.base = base; rec.ref = ref; rec.vsIdle = { dTps: idleRef.tps > 0 ? round((idleRef.tps - base.tps) / idleRef.tps, 3) : 0, dFps: idleRef.fps > 0 ? round((idleRef.fps - base.fps) / idleRef.fps, 3) : 0 };
        const mem0 = await this.memQuick(), os0 = this.lastOs && this.lastOs.edge, perf0 = await this.perfMetrics();
        // (First use: an action this session has not run before, alone or inside a chain: one-time work shows here.)
        const fresh = planned.steps.filter(n => !this.seen.has(n));
        rec.firstUse = fresh.length > 0; if (fresh.length) rec.firstUseOf = fresh;
        for (const n of planned.steps) this.seen.add(n);
        // 2. the measured steps
        const errBefore = this.totalErrors();
        const P = opts.profile ? await this.profStart() : null;
        const tStart = await marks(), w0 = Date.now();
        let any = false;
        for (let i = 0; i < stepsOf.length; i++) {
            const step = stepsOf[i], sc = this.makeCtx(makeRng(planned.seed + 7919 * (i + 1))); sc.geom = this.geom; sc.state0 = this.state0;
            this.lastStep = planned.name + ' > ' + step.name;
            const s0 = Date.now(), r = { name: step.name };
            try {
                if (i > 0 && step.prelude && planned.steps.length > 1) await withTimeout(step.prelude(sc), 60000, step.name + ' prelude');
                const res = (await withTimeout(step.run(sc), 90000, step.name)) || {};
                r.note = res.note; r.skipped = res.skipped; if (!res.skipped) any = true;
            } catch (e) { if (e.dead) throw e; r.error = String(e.message).slice(0, 200); if (/closed|crash/i.test(e.message)) throw new SessionDead(e.message.split('\n')[0]); any = true; }
            r.ms = Date.now() - s0; rec.steps.push(r);
            if (i + 1 < stepsOf.length) { await sleep(rng.int(80, 400)); await this.refreshGeom(rng.int(1, 2 ** 30)); }
        }
        await this.releaseAll();
        if (!any) { if (P) await this.profStop(P).catch(() => { }); rec.skipped = rec.steps.map(s => s.skipped).filter(Boolean)[0] || 'nothing done'; await this.neutralize(); return rec; }
        const tEnd = await marks(); rec.actMs = Date.now() - w0;
        // 3. settle, the window that holds the action, then the tail (the state it left)
        const settle = Math.max(...stepsOf.map(s => s.settleMs || 800)), tail = planned.tailMs || Math.max(...stepsOf.map(s => s.tailMs || 3500));
        await sleep(settle);
        const duringAll = await Promise.all(this.players.map((p, i) => p.win(tStart[i], tEnd[i] + settle)));
        await sleep(tail);
        const tNow = await marks();
        const tailAll = await Promise.all(this.players.map((p, i) => p.win(tEnd[i] + settle, tNow[i])));
        rec.during = duringAll[this.cur.index]; rec.tail = tailAll[this.cur.index];
        if (P) { const wallEnd = Date.now(); const tasks = await this.ev(([a, b]) => __pf.tasks(a, b, 100, 3), [tStart[this.cur.index], tNow[this.cur.index]]); rec.prof = await this.profStop(P); rec.prof.act0 = w0 - P.wall; rec.prof.end = wallEnd - P.wall; rec.prof.tasks = tasks; }
        const st1 = await this.state();
        rec.ctx.selAfter = selTotal(st1); rec.ctx.viewAfter = st1.view; rec.ctx.nodes = st1.nodes; rec.ctx.panelNodes = st1.panelNodes;
        const perf1 = await this.perfMetrics();
        if (perf0 && perf1) rec.perf = { layoutMs: round((perf1.LayoutDuration - perf0.LayoutDuration) * 1000, 0), styleMs: round((perf1.RecalcStyleDuration - perf0.RecalcStyleDuration) * 1000, 0), scriptMs: round((perf1.ScriptDuration - perf0.ScriptDuration) * 1000, 0), taskMs: round((perf1.TaskDuration - perf0.TaskDuration) * 1000, 0), layoutCount: perf1.LayoutCount - perf0.LayoutCount, styleCount: perf1.RecalcStyleCount - perf0.RecalcStyleCount, nodesDelta: perf1.Nodes - perf0.Nodes, listenersDelta: perf1.JSEventListeners - perf0.JSEventListeners };
        // 4. the way back
        rec.recovery = await this.recover(idleRef);
        const mem1 = await this.memQuick();
        const os1 = this.os.available ? await this.os.sample(this.tag, {}) : null;
        if (os1 && !os1.error) this.lastOs = os1;
        rec.mem = { wasmMem0: mem0.wasmMem, wasmMem1: mem1.wasmMem, wasmLive0: mem0.wasmLive, wasmLive1: mem1.wasmLive, js0: round(mem0.jsPage, 1), js1: round(mem1.jsPage, 1),
            wasmMemGrowMB: Number.isFinite(mem1.wasmMem - mem0.wasmMem) ? mem1.wasmMem - mem0.wasmMem : 0, wasmLiveGrowMB: Number.isFinite(mem1.wasmLive - mem0.wasmLive) ? mem1.wasmLive - mem0.wasmLive : 0,
            priv0: os0 && os0.privMB, priv1: os1 && os1.edge ? os1.edge.privMB : null };
        rec.mem.privGrowMB = Number.isFinite(rec.mem.priv1 - rec.mem.priv0) ? round(rec.mem.priv1 - rec.mem.priv0, 0) : 0;
        rec.errors = this.totalErrors() - errBefore;
        // 5. the verdict (the other players are judged against their own calm window of this trial), and what the reference learns
        rec.verdict = judgeTrial(ref, rec, T);
        if (this.players.length > 1) {
            rec.peers = [];
            for (let i = 0; i < this.players.length; i++) {
                if (i === this.cur.index) continue;
                const pr = { name: this.players[i].name, base: bases[i], during: duringAll[i], tail: tailAll[i] };
                pr.verdict = judgeTrial(makeRef([bases[i]]), { during: pr.during, tail: pr.tail, recovery: null, mem: null }, T);
                rec.peers.push(pr);
                for (const f of pr.verdict.flags) rec.verdict.flags.push(pr.name + ':' + f);
                rec.verdict.score = Math.max(rec.verdict.score, pr.verdict.score);
            }
        }
        if (!hasPrelude) this.cur.learn(base, ref);
        this.stats.trials++; if (rec.verdict.flags.length) this.stats.flagged++;
        return rec;
    }
    // ---- leak hunt: one action over and over; what is still held after the garbage is collected ----
    async leakSnap() {
        const p = this.cur;
        // (The panels stream their content in slices: the counts are taken once they stand still.)
        for (let i = 0, last = null; i < 6; i++) { const s = await this.state(), pm = await this.perfMetrics(), key = [s.nodes, pm && pm.JSEventListeners]; if (last && Math.abs(key[0] - last[0]) <= 2 && Math.abs((key[1] || 0) - (last[1] || 0)) <= 2) break; last = key; await sleep(1500); }
        await p.perfCdp.send('HeapProfiler.collectGarbage').catch(() => { });
        await this.workers.gc();
        await sleep(400);
        const s = await this.state(), pm = await this.perfMetrics(), m = await this.memQuick();
        let wk = {}; try { wk = await this.workers.heap(); } catch { }
        let workersJs = 0, backing = 0; for (const g of Object.values(wk)) { workersJs += g.usedMB; backing += g.backingMB; }
        const os = this.os.available ? await this.os.sample(this.tag, {}) : null; if (os && !os.error) this.lastOs = os;
        const gl = s.gl || {};
        return { jsPage: round(s.mem ? s.mem.used / 1048576 : NaN, 1), jsWorkers: round(workersJs, 1), backing: round(backing, 1), wasmLive: m.wasmLive, wasmMem: m.wasmMem, wasmArrays: m.arrays, nodes: s.nodes, units: s.units,
            listeners: pm ? pm.JSEventListeners : null, arrayBuffers: pm ? pm.ArrayBufferContents : null, workerScopes: pm ? pm.WorkerGlobalScopes : null,
            glObjects: (gl.textures || 0) + (gl.buffers || 0) + (gl.framebuffers || 0) + (gl.renderbuffers || 0) + (gl.programs || 0) + (gl.vaos || 0), glTextures: gl.textures, glBuffers: gl.buffers,
            priv: os && os.edge ? os.edge.privMB : null, privRenderer: os && os.edge ? os.edge.byType.renderer : null, privGpu: os && os.edge ? os.edge.byType['gpu-process'] : null };
    }
    async leakTrial(planned) {
        const cfg = this.cfg, id = ++this.trialN, K = cfg.leakReps;
        this.cur = this.players[cfg.mp > 1 ? (cfg.mpDrive === 'host' ? 0 : (this.turn++ % this.players.length)) : 0];
        const rec = { id, session: this.index, at: round((Date.now() - this.t0) / 1000, 1), kind: 'leak', name: planned.name, cat: 'leak', seed: planned.seed, steps: [], player: this.cur.name, reps: K };
        const step = byName.get(planned.steps[0]);
        if (!step) { rec.skipped = 'unknown action'; return rec; }
        rec.steps.push({ name: step.name });
        this.lastStep = planned.name;
        const rng = makeRng(planned.seed);
        const one = async i => {
            await this.refreshGeom(rng.int(1, 2 ** 30)); this.state0 = await this.state();
            if (this.state0.over || !this.state0.started) throw new SessionDead('match ended');
            const c = this.makeCtx(makeRng(planned.seed + 31 * i)); c.state0 = this.state0;
            try { if (step.prelude) await withTimeout(step.prelude(c), 60000, step.name + ' prelude'); const r = (await withTimeout(step.run(c), 90000, step.name)) || {}; if (r.skipped) return false; }
            catch (e) { if (e.dead) throw e; if (/closed|crash/i.test(e.message)) throw new SessionDead(e.message.split('\n')[0]); return false; }
            await this.releaseAll(); await sleep(rng.int(120, 350));
            if (i % 4 === 3) await this.neutralize();
            return true;
        };
        const round_ = async () => { let done = 0; for (let i = 0; i < K; i++) { if (await one(i)) done++; } await this.neutralize(); await sleep(2500); return done; };
        await this.neutralize();
        const warm = await round_();
        if (!warm) { rec.skipped = 'nothing to act on'; return rec; }
        const a = await this.leakSnap(), t0 = Date.now();
        const done = await round_();
        const b = await this.leakSnap();
        rec.ms = Date.now() - t0; rec.done = done; rec.before = a; rec.after = b;
        const L = cfg.leakThresholds;
        const diff = (x, y) => { const d = {}; for (const k of Object.keys(x)) if (Number.isFinite(x[k]) && Number.isFinite(y[k])) d[k] = round(y[k] - x[k], 1); return d; };
        // What grew by more than its limit (units: a growth of the world explains the wasm heap).
        const grown = (d, x) => {
            const out = [], grew = (k, lim) => { if (d[k] >= lim) out.push(k); };
            grew('glObjects', Math.max(2, done)); grew('listeners', L.listeners); grew('nodes', L.nodes); grew('arrayBuffers', Math.max(40, done * 4)); grew('jsPage', L.jsMB); grew('jsWorkers', L.jsMB);
            grew('wasmMem', L.wasmMB * 2); grew('workerScopes', 1); grew('priv', L.privMB); grew('privGpu', L.privMB);
            if (Math.abs(d.units || 0) <= 0.05 * (x.units || 1)) grew('wasmLive', L.wasmMB);
            return out;
        };
        const d = rec.delta = diff(a, b);
        let suspects = grown(d, a);
        // A suspect has to grow in a second measured round as well (a panel finishing its slices, a cache filling up, garbage the collector left, do not).
        if (suspects.length) {
            await round_();
            const c = await this.leakSnap(), d2 = rec.delta2 = diff(b, c); rec.afterSecond = c;
            const again = new Set(grown(d2, b)); rec.unconfirmed = suspects.filter(k => !again.has(k)); suspects = suspects.filter(k => again.has(k));
        }
        const flags = suspects.map(k => k + '+' + d[k] + (rec.delta2 ? ' (+' + rec.delta2[k] + ' again)' : ''));
        rec.verdict = { flags, score: flags.length ? 1 : 0, tail: { dTps: 0, dFps: 0, simRatio: 1 }, during: { dTps: 0, dFps: 0 } };
        this.stats.trials++; if (flags.length) this.stats.flagged++;
        return rec;
    }
    totalErrors() { let n = 0; for (const e of this.errors.values()) n += e.count; return n; }

    // Idle checkpoint: nothing happens for a while; the match's own trend (and the standard view).
    async checkpoint() {
        for (const p of this.players) {
            this.cur = p;
            await this.neutralize(); await this.restoreLayout();
            await p.ev(() => { setRenderDimensionMode('2d'); return __pf.cam('min', 'map'); });
        }
        this.cur = this.players[0];
        await sleep(4000);
        const t = await Promise.all(this.players.map(p => p.now())); await sleep(this.cfg.checkpointMs);
        const wins = await Promise.all(this.players.map(async (p, i) => p.win(t[i], await p.now())));
        const win = wins[0], m = await this.memQuick(), s = await this.state();
        this.players.forEach((p, i) => p.idle.push(wins[i]));
        const k = { session: this.index, at: round((Date.now() - this.t0) / 1000, 1), units: s.units, win: { tps: win.tps, fps: win.fps, sim: win.sim, frame: win.frame }, wasmLive: m.wasmLive, wasmMem: m.wasmMem, priv: this.lastOs && this.lastOs.edge ? this.lastOs.edge.privMB : null,
            peers: wins.slice(1).map((w, i) => ({ name: this.players[i + 1].name, tps: w.tps, fps: w.fps })) };
        this.checkpoints.push(k); this.out.checkpoint(k);
        const hc = await this.hashCheck(); if (hc) k.hashes = hc;
        this.log(`checkpoint: tps ${win.tps} fps ${win.fps} sim ${win.sim.mean} ms, ${s.units} units, wasm live ${m.wasmLive} MB, private ${k.priv} MB${k.peers.length ? '; peers ' + k.peers.map(p => `${p.name} tps ${p.tps} fps ${p.fps}`).join(', ') : ''}${hc ? `; ${hc.compared} tick hashes compared, ${hc.mismatched} differ` : ''}`);
        return k;
    }

    // ---- CPU profilers on the page and every worker ----
    async profStart() {
        const page = await this.context.newCDPSession(this.page);
        await page.send('Profiler.enable'); await page.send('Profiler.setSamplingInterval', { interval: 500 }); await page.send('Profiler.start');
        await this.workers.profileStart(1000);
        // (Page time of one moment and the profile's own time of it: a long task's time in the page finds its samples.)
        const wall = Date.now(), pn = await this.cur.now(), wall1 = Date.now();
        return { page, wall, pageNow0: pn, offsetMs: wall1 - wall };
    }
    async profStop(P) {
        const pageProf = (await P.page.send('Profiler.stop')).profile; await P.page.detach().catch(() => { });
        const workers = await this.workers.profileStop();
        return { page: pageProf, workers, wall: P.wall, pageNow0: P.pageNow0, offsetMs: P.offsetMs };
    }

    // ---- confirm and profile a flagged trial: a control profile of an idle stretch as long as the slow one, then the same steps again
    // with the profilers on; what the page and each worker spent beyond the control is what the action added ----
    async profileRepeat(rec, dir) {
        fs.mkdirSync(dir, { recursive: true });
        const named = byName.get(rec.name);
        const planned = { kind: rec.kind, name: rec.name, cat: rec.cat, seed: rec.seed, steps: named && named.scenario ? named.steps : rec.steps.map(s => s.name), tailMs: named ? named.tailMs : undefined };
        // (The same player again: turn back one.)
        if (this.cfg.mp > 1 && this.cfg.mpDrive !== 'host') this.turn = this.players.findIndex(p => p.name === rec.player);
        await this.neutralize(); await sleep(1500);
        const lenMs = Math.round((rec.during.ms || 0) + (rec.tail.ms || 0));
        const c0 = await this.profStart(); await sleep(lenMs); const ctl = await this.profStop(c0);
        const t0 = Date.now(), again = await this.runTrial(planned, { profile: true });
        const R = again.prof; delete again.prof;
        const summary = { dir, repeatMs: Date.now() - t0, controlMs: lenMs, workers: [] };
        if (!R) return { again, summary };
        const win = { fromMs: R.act0, toMs: R.end }, ctlWin = { fromMs: 0, toMs: R.end - R.act0 };
        const pAct = selfTimes(R.page, win), pCtl = selfTimes(ctl.page, ctlWin);
        summary.page = { totals: totals(pAct), controlTotals: totals(pCtl), top: top(pAct, 10), excess: excess(pAct, pCtl, 10) };
        // The long tasks of the repeat, one by one: what each was made of.
        summary.page.tasks = (R.tasks || []).map(([start, dur]) => { const m = R.offsetMs + (start - R.pageNow0); return { ms: Math.round(dur), ...stretch(R.page, m - 3, m + dur + 3, 6) }; });
        const tag = `t${rec.id}-${rec.name.replace(/[^a-z0-9]+/gi, '_')}`;
        fs.writeFileSync(path.join(dir, tag + '-page.cpuprofile'), JSON.stringify(R.page));
        const rows = [], ctlBy = new Map(ctl.workers.map(w => [w.name, w]));
        for (const w of R.workers) {
            const st = selfTimes(w.profile, win), cw = ctlBy.get(w.name), cst = cw ? selfTimes(cw.profile, ctlWin) : { map: new Map(), spanMs: 0, busyMs: 0, gcMs: 0, idleMs: 0 };
            rows.push({ name: w.name, busyMs: Math.round(st.busyMs), ctlBusyMs: Math.round(cst.busyMs * (cst.spanMs ? st.spanMs / cst.spanMs : 1)), gcMs: Math.round(st.gcMs), top: top(st, 6), excess: excess(st, cst, 6), profile: w.profile });
        }
        // Helpers are many and alike: the busiest two are kept, the rest summed.
        const helpers = rows.filter(r => /^sim_helper/.test(r.name)).sort((a, b) => b.busyMs - a.busyMs), others = rows.filter(r => !/^sim_helper/.test(r.name));
        const keep = [...others, ...helpers.slice(0, 2)];
        for (const r of keep) { fs.writeFileSync(path.join(dir, `${tag}-${r.name}.cpuprofile`), JSON.stringify(r.profile)); }
        summary.workers = keep.map(({ profile, ...r }) => r).sort((a, b) => (b.busyMs - b.ctlBusyMs) - (a.busyMs - a.ctlBusyMs));
        if (helpers.length) summary.helpers = { n: helpers.length, busyMs: helpers.reduce((x, r) => x + r.busyMs, 0), ctlBusyMs: helpers.reduce((x, r) => x + r.ctlBusyMs, 0) };
        return { again, summary };
    }
}

module.exports = { Session, SessionDead, Player, selClassOf, zoomClassOf };
