'use strict';
// Worker flow in a scene's crowds: per worker type, state changes (legs done) and how many walking workers are stuck
// (moved < STUCK_PX over a window while in a walking state), plus heading flips (facing jitter) per walking step.
// node --max-old-space-size=8000 tests/worker-crowd-probe.cjs <scene.gz> [dk=1] [ticks=600] [warm=40] [helpers=0]
// Env: TRACE=<unit id> prints that unit's position / state each step; RALLY=unitId:gx:gy orders it (rally / move).
const path = require('node:path'), fs = require('node:fs');
globalThis.self = { crossOriginIsolated: true };
const T = __dirname;
const H = require(path.join(T, 'net-harness.cjs'));
const [sceneArg, dkArg, ticksArg, warmArg, helpersArg] = process.argv.slice(2);
const dk = Number(dkArg) || 1, TICKS = Number(ticksArg) || 600, WARM = Number(warmArg) || 40, HELPERS = Number(helpersArg) || 0;
(async () => {
    const controls = { ...H.SMALL_MATCH_CONTROLS };
    const world = new H.World({ controls, hashEvery: 1e9 });
    const host = world.spawn('host', { controls, simWorker: false });
    host.scratch.records = JSON.parse(require('node:zlib').gunzipSync(fs.readFileSync(path.resolve(sceneArg))));
    host.scratch.scene = host.eval('(() => { const r = soloSceneReader(); for (const a of __scratch.records) r.line(JSON.stringify(a)); return r.finish(); })()');
    host.scratch.records = null;
    host.eval('document.getElementById("starting-resources-popup").classList.add("hidden")');
    let done = false, error;
    host.eval('restoreSoloGameSnapshot(__scratch.scene)').then(() => done = true, e => { done = true; error = e; });
    while (!done) await world.run(20);
    if (error) throw error;
    if (HELPERS > 0) { host.scratch.Worker = require(path.join(T, 'real-sim-helper.cjs')); host.eval(`Worker = __scratch.Worker; navigator.hardwareConcurrency = 32; simParallelInit('', ${HELPERS})`); }
    host.eval('simDk=' + dk + ';netStepTicks=()=>' + dk);
    const g0 = Number(host.eval('gameTime'));
    while (Number(host.eval('gameTime')) < g0 + WARM) host.eval('gameTick()');
    if (process.env.EVAL) console.log(host.eval(process.env.EVAL));
    const showMap = () => {
        const [x0, y0, x1, y1] = process.env.MAP.split(',').map(Number);
        console.log(host.eval(`(() => { const c = _simUnitState.columns, own = _simUnitState.owners, n = own.length, k8 = c.x instanceof Int32Array ? 0.125 : 1; const cnt = new Map(), types = new Map();
            for (let s = 0; s < n; s++) { const u = own.at(s); if (!u || c.dead[s]) continue; const gx = Math.floor(c.x[s] * k8 / TILE), gy = Math.floor(c.y[s] * k8 / TILE), k = gy * GRID_W + gx; cnt.set(k, (cnt.get(k) || 0) + 1); }
            const lines = [], legend = new Map(); let next = 65;
            for (let gy = ${y0}; gy <= ${y1}; gy++) { let l = String(gy).padStart(3) + ' '; for (let gx = ${x0}; gx <= ${x1}; gx++) { const cell = grid[gy] && grid[gy][gx], b = cell ? cellItemGet(cell) : null; let ch = '.';
                if (b && b.type) { let t = b.type; if (!legend.has(t)) legend.set(t, String.fromCharCode(next++)); ch = legend.get(t); } const WG = simMoveWallGrid(); if (WG[gy * GRID_W + gx]) ch = ch === '.' ? '#' : ch; else if (ch !== '.') ch = ch.toLowerCase();
                const m = cnt.get(gy * GRID_W + gx) || 0; l += ch + (m ? (m > 9 ? '+' : String(m)) : ' '); } lines.push(l); }
            let hdr = '    '; for (let gx = ${x0}; gx <= ${x1}; gx++) hdr += String(gx % 100).padStart(2, '0'); lines.unshift(hdr);
            lines.push([...legend].map(([t, ch]) => ch + '=' + t).join(' ')); return lines.join('\\n'); })()`));
    }
    if (process.env.RALLY) {
        const [id, gx, gy] = process.env.RALLY.split(':').map(Number);
        console.log('rally', host.eval(`(() => { let u = null; for (let s = 0; s < _simUnitState.owners.length; s++) { const v = _simUnitState.owners.at(s); if (v && v.id === ${id}) u = v; } if (!u) return "no unit"; const o = u.owner; processAction(sanitizeAction({ action: 'move', unitIds: [${id}], targetX: ${gx} * TILE + TILE / 2, targetY: ${gy} * TILE + TILE / 2 }), o); return 'ok ' + u.type + ' owner ' + o; })()`));
    }
    // ASSIGN=id:gx:gy[,id:gx:gy...]: the player's build assignment (a right click on a site), each unit's legs logged.
    if (process.env.ASSIGN) {
        host.scratch.ASG = process.env.ASSIGN.split(',').map(t => t.split(':').map(Number));
        console.log(host.eval(`(() => { const own = _simUnitState.owners, out = []; for (const [id, gx, gy] of __scratch.ASG) { let u = null; for (let s = 0; s < own.length; s++) { const v = own.at(s); if (v && v.id === id) u = v; }
            if (!u) { out.push(id + ' none'); continue; } const before = u.workerState; processAction(sanitizeAction({ action: 'workerAssign', unitIds: [id], targetGx: gx, targetGy: gy, targetType: 'build' }), u.owner);
            out.push(id + ' ' + before + ' -> ' + u.workerState + ' at ' + (u.x / TILE).toFixed(1) + ',' + (u.y / TILE).toFixed(1)); } return out.join('; '); })()`));
    }
    host.eval(`__scratch.st = { prev: null, legs: {}, walkSteps: {}, stuck: {}, flips: {}, fby: {}, n: {}, steps: 0, hist: new Map() }`);
    const STUCK_W = Math.max(2, Math.round(Number(process.env.STUCK_W || 60) / dk));
    host.scratch.STUCK_W = STUCK_W; host.scratch.TRACE = Number(process.env.TRACE || -1);
    // DBGS=1 with TRACE (a --features=dbgc build with mv.rs's per-slot dbgs! counters): the traced unit's counters each step.
    if (process.env.DBGS && process.env.TRACE) { host.scratch.DBGS = 1; host.eval('(() => { const own = _simUnitState.owners; for (let s = 0; s < own.length; s++) { const u = own.at(s); if (u && u.id === ' + Number(process.env.TRACE) + ') new Uint32Array(_simWasmMem.buffer, _simWasmArgs + 1699 * 4, 1)[0] = s + 1; } })()'); }
    const steps = Math.max(1, Math.round(TICKS / dk));
    const t0 = Date.now();
    for (let i = 0; i < steps; i++) {
        host.eval('gameTick()');
        host.eval(`(() => { const c = _simUnitState.columns, own = _simUnitState.owners, n = own.length, S = __scratch.st, k8 = c.x instanceof Int32Array ? 0.125 : 1, W = __scratch.STUCK_W;
            S.steps++;
            for (let s = 0; s < n; s++) {
                const u = own.at(s); if (!u || c.dead[s] || (!c.isWk[s] && u.id !== __scratch.TRACE)) continue;
                const tn = _simUnitTypeNames[c.upT[s]], ws = c.wkS[s] & 31, x = c.x[s] * k8, y = c.y[s] * k8, id = u.id;
                let h = S.hist.get(id); if (!h) S.hist.set(id, h = { ws, xs: [], ys: [], ang: null, ad: 0, tn, since: S.steps });
                if (h.ws !== ws) { S.legs[tn] = (S.legs[tn] || 0) + 1; if (__scratch.ASG && __scratch.ASG.some(e => e[0] === id)) (S.asg || (S.asg = [])).push(id + " step " + S.steps + " " + SIM_WS_NAMES[h.ws] + " -> " + SIM_WS_NAMES[ws] + " at " + (x / TILE).toFixed(1) + "," + (y / TILE).toFixed(1)); h.ws = ws; h.since = S.steps; h.xs.length = 0; h.ys.length = 0; }
                h.xs.push(x); h.ys.push(y); if (h.xs.length > W) { h.xs.shift(); h.ys.shift(); }
                // (On its way: a walking state and moving (mvOn 1); one standing at its work (parked, a researcher in place) is not.)
                const walking = (ws === 2 || ws === 3 || ws === 4 || ws === 5 || ws === 6 || ws === 7 || ws === 9 || ws === 11 || ws === 13) && c.mvOn[s] === 1;
                const fa = c.facing ? c.facing[s] : (u.angle != null ? u.angle : null);
                if (walking) {
                    S.walkSteps[tn] = (S.walkSteps[tn] || 0) + 1;
                    if (h.xs.length >= W) { const d = Math.hypot(x - h.xs[0], y - h.ys[0]); if (d < 24) S.stuck[tn] = (S.stuck[tn] || 0) + 1; }
                    const L = h.xs.length; if (L >= 3) { const ax = h.xs[L - 1] - h.xs[L - 2], ay = h.ys[L - 1] - h.ys[L - 2], bx = h.xs[L - 2] - h.xs[L - 3], by = h.ys[L - 2] - h.ys[L - 3]; if (Math.hypot(ax, ay) > 0.05 && Math.hypot(bx, by) > 0.05 && ax * bx + ay * by < -0.2 * Math.hypot(ax, ay) * Math.hypot(bx, by)) { S.flips[tn] = (S.flips[tn] || 0) + 1; h.fl = (h.fl || 0) + 1; const kk = tn + ":" + SIM_WS_NAMES[ws]; S.fby[kk] = (S.fby[kk] || 0) + 1; } }
                }
                if (id === __scratch.TRACE) { (S.tr || (S.tr = [])).push(['trace', S.steps, tn, SIM_WS_NAMES[ws], (x / TILE).toFixed(2), (y / TILE).toFixed(2), 'px', x.toFixed(2), y.toFixed(2), 'v', c.vx[s].toFixed(2), c.vy[s].toFixed(2), 'mvOn', c.mvOn[s], 'out', c.mvOut ? c.mvOut[s] : '-', 'dest', c.mvDest[s] % GRID_W, (c.mvDest[s] / GRID_W) | 0, 'wkT', c.wkT[s] % GRID_W, (c.wkT[s] / GRID_W) | 0, 'cool', c.workerTransferCooldown[s], 'pk', c.nvPK ? c.nvPK[s] : '-', 'pidx', c.pathIndex[s], ...(__scratch.DBGS ? ['dbgs', Array.from(new Uint32Array(_simWasmMem.buffer, _simWasmArgs + 1700 * 4, 28)).join(',')] : [])].join(' ')); if (__scratch.DBGS) { new Uint32Array(_simWasmMem.buffer, _simWasmArgs + 1700 * 4, 28).fill(0); new Uint32Array(_simWasmMem.buffer, _simWasmArgs + 1699 * 4, 1)[0] = s + 1; } }
            }
        })()`);
        // The 3D facing (pres_fill.rs p_facing) as a model on the simulation's velocities, every live unit. Models:
        // 0 the old rule; 1 turning only while the smoothed velocity is at least half the current's; 2 that gate on a
        // second smoothing of FACE_VEL a frame whatever the step (the gate's at long steps). A wiggle: a turn of more
        // than 0.05 rad the other way from the last frame's. Lag: |facing - heading| of steady movers (moved more than
        // half a px a tick, the last three frames' moves within ~25 degrees).
        host.eval(`(() => { const c = _simUnitState.columns, own = _simUnitState.owners, n = own.length, S = __scratch.st, dk = simDk, k8 = c.x instanceof Int32Array ? 0.125 : 1;
            const kv = 1 - Math.pow(0.7, dk), kt = 1 - Math.pow(0.7, dk), min2 = 0.04, dead = 0.04, TAU = Math.PI * 2, M = 5, REV = ${Number(process.env.REV || 1.75)}, HOLD = ${Number(process.env.HOLD || 2)}, SAME = 0.6, WIG = ${Number(process.env.WIG || 0.05)};
            const F = S.face || (S.face = new Map()), W = S.wig || (S.wig = { w: [0, 0, 0, 0, 0], abs: [0, 0, 0, 0, 0], lag: [0, 0, 0, 0, 0], ln: 0, n: 0 });
            for (let s = 0; s < n; s++) {
                const u = own.at(s); if (!u || c.dead[s] || !(c.energy[s] > 0)) continue;
                let f = F.get(u.id); const cvx = c.vx[s], cvy = c.vy[s], x = c.x[s] * k8, y = c.y[s] * k8;
                if (!f) { const a0 = Math.atan2(cvx, cvy); F.set(u.id, f = { vx: cvx, vy: cvy, gx: cvx, gy: cvy, a: [a0, a0, a0, a0, a0], t: [0, 0, 0, 0, 0], pw: [0, 0, 0, 0, 0], pn: [0, 0, 0, 0, 0], px: x, py: y, mv: [] }); continue; }
                const sx = f.vx + (cvx - f.vx) * kv, sy = f.vy + (cvy - f.vy) * kv, snap = (cvx - sx) ** 2 + (cvy - sy) ** 2 < 1e-6;
                const vx = snap ? cvx : sx, vy = snap ? cvy : sy; f.vx = vx; f.vy = vy;
                f.gx += (cvx - f.gx) * 0.3; f.gy += (cvy - f.gy) * 0.3;
                const mx = x - f.px, my = y - f.py; f.px = x; f.py = y; f.mv.push([mx, my]); if (f.mv.length > 3) f.mv.shift();
                const steady = f.mv.length === 3 && f.mv.every(([p, q]) => Math.hypot(p, q) > 0.5 * dk && (p * mx + q * my) > 0.9 * Math.hypot(p, q) * Math.hypot(mx, my));
                W.n++; if (steady) W.ln++;
                const cv2 = cvx * cvx + cvy * cvy;
                for (let m = 0; m < M; m++) {
                    const fast = vx * vx + vy * vy > min2, coherent = m === 0 || m === 3 || (m === 2 ? (f.gx * f.gx + f.gy * f.gy) * 4 > cv2 : (vx * vx + vy * vy) * 4 > cv2);
                    const want = Math.atan2(vx, vy); let dd = want - f.a[m]; dd -= Math.round(dd / TAU) * TAU;
                    let hold = false; if (m >= 3 && fast && coherent && Math.abs(dd) > REV) { let e = want - f.pw[m]; e -= Math.round(e / TAU) * TAU; if (f.pn[m] > 0 && Math.abs(e) < SAME) f.pn[m]++; else { f.pw[m] = want; f.pn[m] = 1; } hold = f.pn[m] < HOLD; } else if (m >= 3) f.pn[m] = 0;
                    const turn = fast && coherent && !hold && Math.abs(dd) > dead ? dd * kt : 0;
                    f.a[m] += turn;
                    if (Math.abs(turn) > WIG && Math.abs(f.t[m]) > WIG && Math.sign(turn) !== Math.sign(f.t[m])) { W.w[m]++; if (m === 0) { const kk = _simUnitTypeNames[c.upT[s]] + ":on" + c.mvOn[s] + ":cm" + (c.cmMode ? c.cmMode[s] : "-"); (W.by || (W.by = {}))[kk] = (W.by[kk] || 0) + 1; } }
                    W.abs[m] += Math.abs(turn); f.t[m] = turn;
                    if (steady) { let e = Math.atan2(mx, my) - f.a[m]; e -= Math.round(e / TAU) * TAU; W.lag[m] += Math.abs(e); }
                }
            }
        })()`);
    }
    {
        const W = JSON.parse(host.eval('JSON.stringify(__scratch.st.wig || {})'));
        if (W.by && process.env.WBY) console.log(Object.entries(W.by).sort((p, q) => q[1] - p[1]).slice(0, 12).map(e => e.join(' ')).join(String.fromCharCode(10)));
        if (W.n) for (let m = 0; m < 5; m++) console.log(`facing model ${['old', 'coherent', 'coherent/frame', 'reversal hold', 'coherent + reversal hold'][m]}: wiggles per 1000 unit-frames ${(W.w[m] / W.n * 1000).toFixed(2)}, turning rad a unit-frame ${(W.abs[m] / W.n).toFixed(4)}, steady movers' lag ${(W.lag[m] / Math.max(1, W.ln)).toFixed(3)} rad (${W.ln} samples)`);
    }
    if (process.env.FLIPS) console.log(host.eval(`(() => { const S = __scratch.st; const a = [...S.hist.entries()].filter(e => e[1].fl).sort((p, q) => q[1].fl - p[1].fl).slice(0, ${process.env.FLIPS}); return JSON.stringify(S.fby) + String.fromCharCode(10) + a.map(([id, h]) => id + " " + h.tn + " flips " + h.fl + " " + SIM_WS_NAMES[h.ws] + " at " + (h.xs[h.xs.length - 1] / TILE).toFixed(2) + "," + (h.ys[h.ys.length - 1] / TILE).toFixed(2)).join(String.fromCharCode(10)); })()`));
    if (process.env.ASSIGN) console.log(host.eval("(__scratch.st.asg || []).join(String.fromCharCode(10))"));
    if (process.env.MAPEND) showMap();
    if (process.env.NEAR) console.log(host.eval(`(() => { const c = _simUnitState.columns, own = _simUnitState.owners, n = own.length, k8 = c.x instanceof Int32Array ? 0.125 : 1, out = []; let mx = NaN, my = NaN; for (let s = 0; s < n; s++) { const u = own.at(s); if (u && u.id === ${process.env.NEAR}) { mx = c.x[s] * k8; my = c.y[s] * k8; } }
        for (let s = 0; s < n; s++) { const u = own.at(s); if (!u || c.dead[s]) continue; const x = c.x[s] * k8, y = c.y[s] * k8, d = Math.hypot(x - mx, y - my); if (d > 56) continue;
            out.push([u.id, _simUnitTypeNames[c.upT[s]], SIM_WS_NAMES[c.wkS[s] & 31], (x / TILE).toFixed(2), (y / TILE).toFixed(2), "d", d.toFixed(1), "r", c.r[s].toFixed(1), "on", c.mvOn[s], "wk", c.mvWk ? c.mvWk[s] : "-", "dest", c.mvDest[s] % GRID_W, (c.mvDest[s] / GRID_W) | 0, "tgt", c.wkT[s] % GRID_W, (c.wkT[s] / GRID_W) | 0, "cool", c.workerTransferCooldown[s]].join(" ")); }
        return out.join(String.fromCharCode(10)); })()`));
    if (process.env.TRACE) console.log(host.eval("(__scratch.st.tr || []).join(String.fromCharCode(10))"));
    if (process.env.LIST) console.log(host.eval(`(() => { const c = _simUnitState.columns, own = _simUnitState.owners, n = own.length, S = __scratch.st, k8 = c.x instanceof Int32Array ? 0.125 : 1, out = [];
        for (let s = 0; s < n; s++) { const u = own.at(s); if (!u || c.dead[s] || !c.isWk[s]) continue; const h = S.hist.get(u.id); if (!h || h.xs.length < __scratch.STUCK_W) continue;
            const ws = c.wkS[s] & 31; if (!(ws === 2 || ws === 3 || ws === 4 || ws === 5 || ws === 6 || ws === 7 || ws === 9 || ws === 11 || ws === 13) || c.mvOn[s] !== 1) continue;
            const x = c.x[s] * k8, y = c.y[s] * k8, d = Math.hypot(x - h.xs[0], y - h.ys[0]); if (d >= 24) continue;
            const wt = c.wkT[s], tx = wt % GRID_W, ty = (wt / GRID_W) | 0, b = grid[ty] && grid[ty][tx];
            out.push([u.id, h.tn, SIM_WS_NAMES[ws], 'at', (x / TILE).toFixed(2), (y / TILE).toFixed(2), 'tgt', tx, ty, b && b.type, 'owner', c.owner[s], 'mvOn', c.mvOn[s], 'since', S.steps - h.since, 'dest', c.mvDest[s] % GRID_W, (c.mvDest[s] / GRID_W) | 0].join(' ')); }
        return out.slice(0, Number(${JSON.stringify(process.env.LIST)})).join('\\n'); })()`));
    const S = JSON.parse(host.eval(`JSON.stringify((() => { const S = __scratch.st; const by = {}; for (const h of S.hist.values()) { by[h.tn] = (by[h.tn] || 0) + 1; } return { legs: S.legs, walk: S.walkSteps, stuck: S.stuck, flips: S.flips, count: by, steps: S.steps }; })())`));
    console.log(`dk ${dk}, ${S.steps} steps (${TICKS} base ticks), ${((Date.now() - t0) / S.steps).toFixed(1)} ms/step, stuck window ${STUCK_W} steps (<24 px)`);
    console.log('type'.padEnd(22), 'count', 'legs/unit/1000t', 'walk%', 'stuck%ofwalk', 'flips/1000walk');
    for (const tn of Object.keys(S.count).sort()) {
        const n = S.count[tn], w = S.walk[tn] || 0;
        console.log(tn.padEnd(22), String(n).padStart(5), ((S.legs[tn] || 0) / n / TICKS * 1000).toFixed(2).padStart(15), (w / n / S.steps * 100).toFixed(1).padStart(6), ((S.stuck[tn] || 0) / Math.max(1, w) * 100).toFixed(1).padStart(12), ((S.flips[tn] || 0) / Math.max(1, w) * 1000).toFixed(1).padStart(14));
    }
    process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
