// The perf fuzzer's judgement (tests/perf-fuzz/): what counts as a slowdown, the
// window summaries of its page probe (fed frames and tick results by hand), the
// trend fit, the CPU profile summaries and the option parser. No browser.
//   node tests/perf-fuzz-analysis.test.cjs
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { makeOpts, makeRng } = require('./perf-fuzz/env.cjs');
const { DEFAULT_THRESHOLDS: T, makeRef, judge, judgeTrial, groupStats, trends, fit } = require('./perf-fuzz/analyze.cjs');
const { selfTimes, top, excess, stretch } = require('./perf-fuzz/profile.cjs');

// ---- windows and judgement ----
const win = (o = {}) => ({ ms: 3000, fps: 100, frame: { p50: 8, p95: 10, p99: 12, max: 20, over33: 0, over50: 0, over100: 0, over250: 0 }, work: { n: 300, mean: 4, p95: 5, max: 6 }, tps: 20, tick: { n: 60, gapP50: 50, gapP95: 65, gapMax: 80, trail: 10 },
    sim: { mean: 8, p95: 12, max: 15 }, late: { mean: 5, p95: 8, max: 10 }, pres: { n: 60, gapP95: 60, gapMax: 80, buildMs: 3 }, long: { n: 0, ms: 0, max: 0 }, input: { n: 0, handlerMax: 0, delayMax: 0, worst: [] }, visible: true, ...o });
const calm = makeRef([win(), win({ tps: 19.9, fps: 98 }), win({ tps: 20.1, fps: 102 })]);
assert.ok(Math.abs(calm.tps - 20) < 0.2 && Math.abs(calm.fps - 100) < 3, 'reference is the median of the calm windows');
const flags = w => judge(calm, w, T).why;
assert.deepEqual(flags(win()), [], 'a calm window flags nothing');
assert.deepEqual(flags(win({ tps: 19, fps: 95 })), [], 'a 5 % wobble flags nothing');
assert.ok(flags(win({ tps: 14 })).includes('tps'), '30 % less TPS flags');
assert.ok(!flags(win({ tps: 17.5 })).includes('tps'), '12 % less is below the threshold');
assert.ok(flags(win({ fps: 60 })).includes('fps'), '40 FPS less flags');
assert.ok(!flags(win({ fps: 85 })).includes('fps'), '15 % less FPS is not enough');
assert.ok(flags(win({ tick: { n: 60, gapP50: 50, gapP95: 65, gapMax: 450, trail: 10 } })).includes('gap'), 'a 450 ms wait for ticks flags');
assert.ok(!flags(win({ tick: { n: 60, gapP50: 50, gapP95: 65, gapMax: 150, trail: 10 } })).includes('gap'), '150 ms does not');
assert.ok(flags(win({ frame: { ...win().frame, max: 300 } })).includes('frame'), 'a 300 ms frame flags');
assert.ok(flags(win({ long: { n: 1, ms: 200, max: 200 } })).includes('long'), 'a 200 ms task flags');
assert.ok(flags(win({ input: { n: 1, handlerMax: 130, delayMax: 0, worst: [] } })).includes('handler'), 'a 130 ms input handler flags');
assert.ok(flags(win({ sim: { mean: 30, p95: 40, max: 45 } })).includes('sim'), 'worker ms per tick over half the budget flags');
assert.ok(!flags(win({ sim: { mean: 14, p95: 18, max: 25 } })).includes('sim'), 'a worker that is 75 % slower but far under budget does not');
assert.ok(flags(win({ sim: { mean: 12, p95: 40, max: 75 } })).includes('simMax'), 'a 75 ms tick flags');
assert.ok(judge(calm, win({ tps: 10 }), T).score > judge(calm, win({ tps: 15 }), T).score, 'a bigger drop scores higher');
// A reference that is itself slow: the same absolute numbers are not a drop.
const slow = makeRef([win({ tps: 12, fps: 40 }), win({ tps: 12, fps: 41 }), win({ tps: 11.9, fps: 40 })]);
assert.deepEqual(judge(slow, win({ tps: 12, fps: 40 }), T).why, [], 'judged against its own reference');

// ---- a trial's verdict ----
const trial = (o = {}) => ({ during: win(), tail: win(), recovery: { ok: true, ms: 900, deficit: 0 }, mem: { wasmMemGrowMB: 0, privGrowMB: 0 }, ...o });
assert.deepEqual(judgeTrial(calm, trial(), T).flags, []);
assert.ok(judgeTrial(calm, trial({ tail: win({ tps: 12 }) }), T).flags.includes('tps@tail'));
assert.ok(judgeTrial(calm, trial({ during: win({ long: { n: 1, ms: 400, max: 400 } }) }), T).flags.includes('long@during'));
assert.ok(judgeTrial(calm, trial({ recovery: { ok: false, ms: 60000, deficit: 0.4 } }), T).flags.includes('persistent'), 'no recovery is a flag');
assert.ok(judgeTrial(calm, trial({ mem: { wasmMemGrowMB: 200, privGrowMB: 0 } }), T).flags.includes('wasm-grow'));
assert.ok(judgeTrial(calm, trial({ mem: { wasmMemGrowMB: 0, privGrowMB: 600 } }), T).flags.includes('mem-grow'));

// ---- grouping ----
const mk = (name, tpsDrop, score) => ({ name, cat: 'x', verdict: { flags: score >= 1 ? ['tps@tail'] : [], score, tail: { dTps: tpsDrop, dFps: 0, simRatio: 1 }, during: { dTps: 0, dFps: 0 } }, during: win(), tail: win(), recovery: { ok: true, ms: 900 }, firstUse: false });
const rows = groupStats([mk('a', 0.3, 2), mk('a', 0.1, 0.6), mk('a', 0.2, 1.4), mk('b', 0, 0.2), { name: 'c', skipped: 'no army' }], t => t.name);
assert.equal(rows.length, 2, 'skipped trials are not counted');
assert.equal(rows[0].key, 'a'); assert.equal(rows[0].n, 3); assert.equal(rows[0].flagged, 2); assert.equal(rows[0].dTpsMed, 0.2); assert.equal(rows[0].scoreMax, 2);

// ---- trends ----
const pts = Array.from({ length: 20 }, (_, i) => [i, 10 + 3 * i]);
const f = fit(pts); assert.ok(Math.abs(f.slope - 3) < 1e-9 && f.r2 > 0.999);
const samples = Array.from({ length: 160 }, (_, i) => ({ session: 0, st: i * 5, t: i * 5, wasmLive: 100 + i * 0.5, jsPage: 120 + (i % 7), privRenderer: 900, nodes: 3000 }));
const tr = trends(samples), byLabel = Object.fromEntries(tr.map(r => [r.label, r]));
assert.ok(byLabel['wasm heap live'].rising, 'a steady climb of 6 MB a minute is rising');
assert.ok(!byLabel['page JS heap'].rising, 'a sawtooth is not');
assert.ok(!byLabel['renderer private (sum)'].rising, 'a flat line is not');
assert.deepEqual(trends(samples.slice(0, 30)), [], 'nothing is said about the first minutes (warm-up)');
{
    // A noisy climb is found; a one-time step and a few wild samples are not.
    const rnd = makeRng(3);
    const noisy = Array.from({ length: 200 }, (_, i) => ({ session: 0, st: i * 6, t: i * 6, priv: 4000 + i * 1.4 + rnd.range(-60, 60), handles: 4300 + (i > 100 ? 400 : 0), nodes: 3000 + (i % 40 === 0 ? 20000 : 0) }));
    const by = Object.fromEntries(trends(noisy).map(r => [r.label, r]));
    assert.ok(by['browser private (all)'].rising, 'a 14 MB a minute climb under 60 MB of noise is rising: ' + JSON.stringify(by['browser private (all)']));
    assert.ok(!by['handles'].rising, 'a step is not a climb');
    assert.ok(!by['DOM nodes'].rising, 'spikes are not a climb');
}

// ---- CPU profile summaries ----
// root > frame > (work 6 ms, getParameter 3 ms under drawClaims, idle 1 ms): 5 ms after the first.
const fn = (id, name, url, children = []) => ({ id, callFrame: { functionName: name, url, lineNumber: 9 }, children });
const profile = {
    nodes: [fn(1, '(root)', ''), fn(2, 'frame', 'http://x/main.js', [3, 4, 6]), fn(3, 'work', 'http://x/main.js'), fn(4, 'drawClaims', 'http://x/r.js', [5]), fn(5, 'getParameter', ''), fn(6, '(idle)', '')],
    samples: [3, 3, 3, 3, 3, 3, 5, 5, 5, 6, 3], timeDeltas: Array(11).fill(1000),
};
const st = selfTimes(profile);
assert.equal(Math.round(st.map.get('work main.js:10')), 7); assert.equal(Math.round(st.idleMs), 1);
const t1 = top(st, 5); assert.equal(t1[0].name, 'work main.js:10'); assert.equal(t1[1].name, 'getParameter (native):10'); assert.equal(t1[1].via, 'drawClaims r.js:10', 'a native function says who called it');
const idleProfile = { ...profile, samples: [6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6] };
const ex = excess(st, selfTimes(idleProfile), 5);
assert.deepEqual(ex.map(r => r.name), ['work main.js:10', 'getParameter (native):10'], 'what the slow stretch spent that the idle one did not');
const part = selfTimes(profile, { fromMs: 7, toMs: 9 }); assert.ok(part.spanMs <= 3.1 && part.map.has('getParameter (native):10') && !part.map.has('work main.js:10'), 'a stretch of the profile');
const sr = stretch(profile, 1, 9, 4); assert.equal(sr.total[0].name, 'frame main.js:10', 'inclusive time of a long task is topped by its root function'); assert.equal(sr.self[0].name, 'work main.js:10');

// ---- the page probe's windows (the probe run on stubs, fed by hand) ----
function loadProbe() {
    let clock = 0; const rafs = [], hooks = {};
    const sandbox = { performance: { now: () => clock, memory: null }, PerformanceObserver: class { observe() { } }, requestAnimationFrame: cb => rafs.push(cb),
        document: { visibilityState: 'visible', getElementById: () => null, querySelectorAll: () => [], getElementsByTagName: () => ({ length: 0 }), hasFocus: () => true }, Float64Array, Float32Array, Math, Number, Set, Map, Promise, RegExp, Error, Array, Object, Date };
    sandbox.window = sandbox;
    sandbox._simClient = { epoch: 1 };
    sandbox._simClientApplyTick = () => { };
    sandbox._simClientOnMessage = () => { };
    sandbox.processRenderFrame = () => { };
    vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(path.join(__dirname, 'perf-fuzz', 'probe.js'), 'utf8'), sandbox);
    return { P: sandbox.__pf, setClock: v => { clock = v; }, frame: ts => { const cb = rafs.pop(); cb(ts); }, tick: (t, tick, simMs, lateMs) => { clock = t; sandbox._simClientApplyTick({ epoch: 1, tick, simMs, lateMs }); }, sandbox };
}
{
    const h = loadProbe();
    // 120 FPS for 3 s, 20 TPS (50 ms) with one 300 ms stall at 1.5 s, simMs 8.
    const dtF = 1000 / 120; let ts = 0;
    h.frame(0);
    for (let i = 1; i <= 360; i++) { ts = i * dtF; h.frame(ts); }
    let tickNo = 0, t = 0;
    while (t < 3000) { t += (t >= 1500 && t < 1550) ? 300 : 50; tickNo++; h.tick(t, tickNo, 8, 4); }
    h.setClock(3010);
    const w = h.P.win(0, 3000);
    assert.ok(Math.abs(w.fps - 120) < 3, 'fps ' + w.fps);
    assert.ok(w.frame.max < 12, 'regular frames: no spike');
    assert.ok(w.tick.gapMax >= 299 && w.tick.gapMax <= 301, 'the 300 ms wait shows as the longest gap: ' + w.tick.gapMax);
    assert.ok(w.tps > 16 && w.tps < 19.6, 'a stall costs TPS: ' + w.tps);
    assert.equal(w.sim.mean, 8); assert.equal(w.late.mean, 4);
    // A window with nothing in it at its end: the wait since the last result counts.
    const w2 = h.P.win(2000, 3500);
    assert.ok(w2.tick.trail >= 400 && w2.tick.gapMax >= 400, 'a window that ends in a stall: trail ' + w2.tick.trail);
    assert.ok(w2.frame.max >= 400 && w2.fps < 90, 'frames missing at the end of the window count too: ' + JSON.stringify(w2.frame));
    // No ticks at all.
    const w3 = h.P.win(5000, 8000); assert.equal(w3.tps, 0); assert.equal(w3.tick.n, 0); assert.equal(w3.tick.trail, 3000);
}

// ---- options, generator ----
{
    const o = makeOpts(['100000-1000.json', '--minutes=5', '--vis=full,team', '--headless', '--no-thing=0']);
    assert.equal(o.positional[0], '100000-1000.json'); assert.equal(o.num('minutes', 0), 5); assert.deepEqual(o.list('vis', []), ['full', 'team']);
    assert.equal(o.bool('headless', false), true); assert.equal(o.bool('missing', true), true); assert.equal(o.num('absent', 7), 7);
    process.env.SESSION_MIN = '30'; assert.equal(makeOpts([]).num('session-min', 25), 30, 'the env var of the same name'); delete process.env.SESSION_MIN;
    const a = makeRng(5), b = makeRng(5); assert.deepEqual([a.int(0, 99), a.int(0, 99), a.next()], [b.int(0, 99), b.int(0, 99), b.next()], 'same seed, same trial');
    const r = makeRng(9), seen = new Set(); for (let i = 0; i < 300; i++) seen.add(r.weighted(['x', 'y', 'z'], v => v === 'y' ? 0 : 1)); assert.ok(seen.has('x') && seen.has('z') && !seen.has('y'), 'a weight of 0 never comes up');
}
console.log('perf-fuzz analysis ok');
