#!/usr/bin/env node
// Architecture extractor: scans the game's sources and writes
//   architecture.json  the intermediate file (threads, message channels,
//                      tier lanes with their cadence, kernels, cadence
//                      constants, findings), meant to be read by LLMs
//   architecture.html  a static page with the same JSON embedded; its own
//                      script draws the SVG diagrams from that JSON
//
// Usage (from the repo root or anywhere):
//   node tests/architecture-viz/extract.cjs
//
// The lane and thread facts that are not derivable from a single constant
// (which call posts a job, at which phase) are declared in MANIFEST below;
// their numbers are still read from the source, and a manifest entry whose
// constant or file has gone is reported in `findings`.

'use strict';
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const OUT_DIR = __dirname;
const TEMPLATE = path.join(__dirname, 'viewer.html');

const rel = p => path.relative(ROOT, p).split(path.sep).join('/');
const read = p => fs.readFileSync(p, 'utf8');

function walk(dir, exts, out = []) {
    for (const name of fs.readdirSync(dir)) {
        if (name === 'node_modules' || name === 'target' || name.startsWith('target') || name === '.git') continue;
        const full = path.join(dir, name);
        const st = fs.statSync(full);
        if (st.isDirectory()) walk(full, exts, out);
        else if (exts.some(e => name.endsWith(e))) out.push(full);
    }
    return out;
}

const jsFiles = walk(path.join(ROOT, 'src'), ['.js']);
const rsFiles = walk(path.join(ROOT, 'wasm', 'src'), ['.rs']);
const fileText = new Map();
for (const f of [...jsFiles, ...rsFiles]) fileText.set(rel(f), read(f).split(/\r?\n/));

// ---------- constants ----------
// name -> { value, file, line } for `const|let|var NAME = number` declarations
// (several per line allowed). The first declaration wins.
const constants = new Map();
for (const [file, lines] of fileText) {
    if (!file.endsWith('.js')) continue;
    lines.forEach((line, i) => {
        if (!/^\s*(const|let|var)\s/.test(line)) return;
        const re = /\b([A-Z][A-Z0-9_]*)\s*=\s*(-?\d+(?:\.\d+)?)(?![\w.])/g;
        let m;
        while ((m = re.exec(line))) {
            if (!constants.has(m[1])) constants.set(m[1], { value: Number(m[2]), file, line: i + 1 });
        }
    });
}
const constValue = name => (constants.has(name) ? constants.get(name).value : null);
const constRef = name => (constants.has(name) ? { name, value: constants.get(name).value, file: constants.get(name).file, line: constants.get(name).line } : { name, value: null, file: null, line: null });

// ---------- meta ----------
let commit = null;
try { commit = execSync('git rev-parse --short HEAD', { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch { }
const TICK_RATE = constValue('TICK_RATE') ?? 20;
// TICK_RATE is set in data_static.js as `let TICK_RATE = 20`; the scan above
// catches it as a let declaration, so this is the fallback only.
const TICK_MS = 1000 / TICK_RATE;

// ---------- lanes ----------
// Lane ids come from `const SIM_LANE_X = n` in sim_parallel.js.
const laneIds = new Map();
{
    const lines = fileText.get('src/sim/sim_parallel.js') || [];
    for (const line of lines) {
        const re = /\bSIM_LANE_([A-Z0-9_]+)\s*=\s*(\d+)/g;
        let m;
        while ((m = re.exec(line))) laneIds.set(m[1], Number(m[2]));
    }
}
// The nominal rate each tier lane is named for (sim_parallel.js comment:
// "lanes 2-5 ... 10, 5, 1, 0.5 per second"); null for the lanes without one.
const NOMINAL_HZ = { T10: 10, T5: 5, T1: 1, T05: 0.5 };

// Each event is one periodic (or on-demand) action of a lane. `phase` is the
// base tick modulo `period` at which it fires: it fires at tick t when
// t mod period === phase (for a step of deltatick dk: when one of its base
// ticks does). A phase may be a constant name with an optional +/- offset,
// resolved from the source. `period` is a constant name when the source gates
// the action with one. `on_demand` lanes have no periodic events.
const MANIFEST = {
    lanes: [
        {
            lane: 'TICK', label: 'tick kernels', thread: 'sim_worker',
            notes: 'The tick\'s own kernels on the simulation thread with the helpers (lane 0 is taken first).',
            events: [{ name: 'tick run', kind: 'run', period: 1, phase: 0, file: 'src/sim/sim_parallel.js' }]
        },
        {
            lane: 'IX', label: 'unit index', thread: 'sim_worker',
            notes: 'Next tick\'s unit index, built after a tick\'s end (spatialIndexPrebuild), waited for at the next tick.',
            events: [{ name: 'index prebuild', kind: 'run', period: 1, phase: 0, file: 'src/game/chunk.js' }]
        },
        {
            lane: 'HASH', label: 'state hash slices', thread: 'sim_worker',
            notes: 'Rolling state hash, one slice per tick (SNAP_HASH_EVERY).',
            events: [{ name: 'hash slice', kind: 'run', period: 'SNAP_HASH_EVERY', phase: 0, file: 'src/utils/utils_snapshot.js' }]
        },
        {
            lane: 'TRAFFIC', label: 'traffic solve', thread: 'sim_worker',
            notes: 'Crowd traffic solve posted after each step\'s movement; its result is published two base ticks later (pending = gameTime + 2).',
            events: [{ name: 'traffic post', kind: 'run', period: 1, phase: 0, file: 'src/sim/sim_traffic.js', latency_ticks: 2 }]
        },
        {
            lane: 'T10', label: 'acquisition (enemy search)', thread: 'sim_worker', nominal_lane: 'T10',
            notes: 'Enemy search; snapshot+scan posted at phase 2, commit at phase 0. Gate: SIM_ACQUIRE_TICKS.',
            events: [
                { name: 'acq post (snap+scan)', kind: 'post', period: 'SIM_ACQUIRE_TICKS', phase: 2, file: 'src/things/unit.js' },
                { name: 'acq commit', kind: 'commit', period: 'SIM_ACQUIRE_TICKS', phase: 0, file: 'src/things/unit.js' }
            ]
        },
        {
            lane: 'T5', label: 'units\' cover (visibility)', thread: 'sim_worker', nominal_lane: 'T5',
            notes: 'Renderer-side cover sweep over the units, posted at VIS_COVER_UNITS_PHASE. Lane shared with the adjacency flood.',
            events: [{ name: 'cover units post', kind: 'post', period: 'VIS_COVER_UNITS_TICKS', phase: 'VIS_COVER_UNITS_PHASE', file: 'src/audio_visual/renderer.js' }]
        },
        {
            lane: 'T5', label: 'adjacency flood', thread: 'sim_worker', nominal_lane: 'T5',
            notes: 'Adjacency groups recalculated in batches: simStepCrosses(-3, ADJACENCY_BATCH_TICKS), i.e. at t mod 8 === 3.',
            events: [{ name: 'adjacency post', kind: 'post', period: 'ADJACENCY_BATCH_TICKS', phase: 3, file: 'src/things/things_utils.js' }]
        },
        {
            lane: 'T1', label: 'worker search tier', thread: 'sim_worker', nominal_lane: 'T1',
            notes: 'Workers\' searches: post at WS_POST_PHASE, order at phase +1, commit at phase +2 (WS_TICKS cycle).',
            events: [
                { name: 'ws post (scan)', kind: 'post', period: 'WS_TICKS', phase: 'WS_POST_PHASE', file: 'src/things/worker.js' },
                { name: 'ws order', kind: 'run', period: 'WS_TICKS', phase: 'WS_POST_PHASE+1', file: 'src/things/worker.js' },
                { name: 'ws commit', kind: 'commit', period: 'WS_TICKS', phase: 'WS_POST_PHASE+2', file: 'src/things/worker.js' }
            ]
        },
        {
            lane: 'T05', label: 'healer candidates', thread: 'sim_worker', nominal_lane: 'T05',
            notes: 'Healer candidate scan, a round over HEALER_CANDIDATE_CACHE_TICKS, posted at the round\'s phase 0.',
            events: [{ name: 'heal cand post', kind: 'post', period: 'HEALER_CANDIDATE_CACHE_TICKS', phase: 0, file: 'src/things/worker.js' }]
        },
        {
            lane: 'NAV', label: 'navigation fields', thread: 'sim_worker', on_demand: true,
            notes: 'Destination fields asked for in a tick, made by the next tick\'s flush.',
            events: []
        },
        {
            lane: 'LONG', label: 'navigation build', thread: 'sim_worker', on_demand: true,
            notes: 'Navigation build (flownav.js _navBuildLane), spread over NAV_BUILD_TICKS.',
            events: []
        },
        {
            lane: 'NAVX', label: 'navigation install', thread: 'sim_worker', on_demand: true,
            notes: 'Every live field remade over a new navigation build, before it is installed.',
            events: []
        },
        {
            lane: 'BUILD', label: 'area boxes / path regions', thread: 'sim_worker', on_demand: true,
            notes: 'Tables made once in a while and taken when done.',
            events: []
        },
        {
            lane: 'GROW', label: 'wasm heap growth', thread: 'sim_worker', on_demand: true,
            notes: 'Wasm memory grown ahead of need (sim_wasm.js _simHeapGrowAhead).',
            events: []
        }
    ],
    // files: the sources whose postMessage calls and message handlers belong
    // to the thread (the page's side of a channel lives in several files).
    threads: [
        { id: 'page', file: 'src/main.js', files: ['src/main.js', 'src/sim/sim_client.js', 'src/sim/sim_presentation.js', 'src/audio_visual/renderer.js'], role: 'Page (main thread): lockstep, network, input, rendering, UI. Runs the requestAnimationFrame loops (simulationFrame, _rafLoopFrame).' },
        { id: 'sim_worker', file: 'src/sim/sim_worker.js', files: ['src/sim/sim_worker.js', 'src/sim/sim_parallel.js'], role: 'Simulation authority: runs the ticks (game scripts in a worker with a stand-in DOM). Starts the helpers and feeds them lane jobs (sim_parallel.js).' },
        { id: 'sim_helper', file: 'src/sim/sim_helper.js', files: ['src/sim/sim_helper.js'], role: 'Helper of the simulation worker: takes chunks of lane jobs and parallel kernels.' },
        { id: 'presentation_worker', file: 'src/sim/presentation_worker.js', files: ['src/sim/presentation_worker.js'], role: 'Presentation reader: draws unit positions from the newest tick snapshot; never a simulation barrier.' },
        { id: 'present_helper', file: 'src/sim/presentation_worker.js', files: ['src/sim/presentation_worker.js'], role: 'Helper of the presentation worker (same file, name present-helper); count = min(3, cores/4 - 1).' },
        { id: 'assign_worker', file: 'src/sim/assign_worker.js', files: ['src/sim/assign_worker.js'], role: 'Multi-point order split (assign_nearest.js), off the main thread.' },
        { id: 'net_background', file: 'src/utils/utils_net_quality.js', files: ['src/utils/utils_net_quality.js'], role: 'Network quality background worker (timers while the page is hidden).' }
    ],
    // Who starts whom. `via` is the file holding the `new Worker(` call; it is
    // checked against the scan (a finding when the call is gone).
    spawns: [
        { from: 'page', to: 'sim_worker', via: 'src/sim/sim_client.js' },
        { from: 'sim_worker', to: 'sim_helper', via: 'src/sim/sim_parallel.js' },
        { from: 'page', to: 'presentation_worker', via: 'src/sim/sim_presentation.js' },
        { from: 'presentation_worker', to: 'present_helper', via: 'src/sim/presentation_worker.js' },
        { from: 'page', to: 'assign_worker', via: 'src/main.js' },
        { from: 'page', to: 'net_background', via: 'src/utils/utils_net_quality.js' }
    ],
    // Presentation cadence facts not tied to a constant (browser frames).
    presentation: {
        frame_driver: 'requestAnimationFrame (renderer.js simulationFrame, _rafLoopFrame)',
        snapshot_per_tick: { file: 'src/sim/sim_presentation.js', fn: 'simPresentTickEnd', snaps_constant: 'SIM_PRESENT_SNAPS' },
        target_fps_illustrative: 60
    }
};

// ---------- threads and spawn edges ----------
const spawnSites = [];
for (const [file, lines] of fileText) {
    if (!file.endsWith('.js')) continue;
    lines.forEach((line, i) => {
        const m = /new Worker\(\s*([^,)]+)/.exec(line);
        if (m) spawnSites.push({ from: file, line: i + 1, target: m[1].trim().slice(0, 80) });
    });
}
const threads = MANIFEST.threads.map(t => ({
    id: t.id,
    file: t.file,
    files: t.files,
    role: t.role,
    file_found: fileText.has(t.file)
}));
const spawns = MANIFEST.spawns.map(s => {
    const site = spawnSites.find(x => x.from === s.via) || null;
    return { from: s.from, to: s.to, via: s.via, line: site ? site.line : null, label: s.label || s.to, found: !!site };
});

// ---------- message channels ----------
// Types a worker file posts (postMessage({ type: 'x' ...})) and the types it
// compares against (`.type === 'x'`, `case 'x'`). A channel from A to B is
// drawn for a type A posts and B compares. Generic types are dropped: they
// are used by every channel.
const GENERIC = new Set(['error', 'ready', 'loaded', 'started', 'reply', 'result', 'done']);
const sends = new Map(), receives = new Map();
for (const t of threads) {
    const s = new Set(), r = new Set();
    for (const file of t.files) for (const line of fileText.get(file) || []) {
        for (const m of line.matchAll(/postMessage\(\s*\{\s*type:\s*'([^']+)'/g)) s.add(m[1]);
        for (const m of line.matchAll(/\.type\s*===?\s*'([^']+)'/g)) r.add(m[1]);
        for (const m of line.matchAll(/\bcase\s+'([^']+)'\s*:/g)) r.add(m[1]);
    }
    sends.set(t.id, s); receives.set(t.id, r);
}
const channels = [];
for (const a of threads) for (const b of threads) {
    if (a.id === b.id) continue;
    // Threads running the same file (a worker and its helpers) share its
    // handlers; their traffic is the spawn, not a channel.
    if (a.files.some(f => b.files.includes(f))) continue;
    const sa = sends.get(a.id), rb = receives.get(b.id);
    const types = [...sa].filter(t => rb.has(t) && !GENERIC.has(t));
    if (types.length) channels.push({ from: a.id, to: b.id, types: types.sort() });
}

// ---------- cadence constants ----------
const CADENCE_RE = /(TICKS|TICK_INTERVAL|PHASE|SNAPS|IN_FLIGHT|LEAD_TICKS|_EVERY|PERIOD|WINDOW_TICKS|TTL_TICKS)$/;
const cadences = [...constants.entries()]
    .filter(([name]) => CADENCE_RE.test(name) || name === 'TICK_RATE' || name === 'SIM_DK_MAX')
    .map(([name, c]) => ({
        name, value: c.value, file: c.file, line: c.line,
        // Per-second rate of a period-in-ticks at the default TICK_RATE.
        ms_at_default_rate: name.endsWith('TICKS') ? Math.round(c.value * TICK_MS) : null
    }))
    .sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);

// ---------- lanes resolved ----------
const lanes = MANIFEST.lanes.map(L => {
    const id = laneIds.has(L.lane) ? laneIds.get(L.lane) : null;
    const events = L.events.map(ev => {
        const period = typeof ev.period === 'number' ? ev.period : (ev.period ? constRef(ev.period) : null);
        const periodValue = typeof period === 'number' ? period : (period && period.value);
        const periodOut = typeof period === 'number' ? { name: null, value: period } : period;
        return {
            name: ev.name,
            kind: ev.kind,
            period: periodOut,
            phase: resolvePhase(ev.phase, periodValue || 0),
            phase_source: typeof ev.phase === 'string' ? ev.phase : null,
            latency_ticks: ev.latency_ticks || 0,
            file: ev.file,
            period_value: periodValue ?? null
        };
    });
    const act = events.find(e => e.period_value);
    const actualPeriod = act ? act.period_value : null;
    const actualHz = actualPeriod ? Math.round((TICK_RATE / actualPeriod) * 100) / 100 : null;
    const nominalHz = L.nominal_lane ? NOMINAL_HZ[L.nominal_lane] : null;
    return {
        lane: L.lane,
        id,
        label: L.label,
        thread: L.thread,
        on_demand: !!L.on_demand,
        nominal_hz: nominalHz,
        actual_period_ticks: actualPeriod,
        actual_hz: actualHz,
        events,
        notes: L.notes
    };
});

// A phase given as a number, or as "NAME", "NAME+k" or "NAME-k" (NAME a
// constant), reduced modulo the event's period (null: no period, so the
// phase is kept as written).
function resolvePhase(p, period) {
    let v = 0;
    if (typeof p === 'number') v = p;
    else if (typeof p === 'string') {
        const m = /^([A-Z_][A-Z0-9_]*)\s*([+-]\s*\d+)?$/.exec(p);
        if (m) {
            const base = constValue(m[1]);
            const off = m[2] ? Number(m[2].replace(/\s+/g, '')) : 0;
            v = base === null ? 0 : base + off;
        }
    }
    return period ? ((v % period) + period) % period : v;
}

// ---------- kernels ----------
const kernelIds = new Map();
for (const [file, lines] of fileText) {
    if (!file.endsWith('.js')) continue;
    lines.forEach((line, i) => {
        if (!/SIM_KERNEL_[A-Z0-9_]+\s*=\s*\d+/.test(line)) return;
        const re = /\bSIM_KERNEL_([A-Z0-9_]+)\s*=\s*(\d+)/g;
        let m;
        while ((m = re.exec(line))) if (!kernelIds.has(m[1])) kernelIds.set(m[1], { id: Number(m[2]), file, line: i + 1 });
    });
}
const rustExports = new Map();
for (const [file, lines] of fileText) {
    if (!file.endsWith('.rs')) continue;
    for (const line of lines) {
        const m = /pub\s+(?:unsafe\s+)?extern\s+"C"\s+fn\s+(\w+)/.exec(line);
        if (m) rustExports.set(m[1], { file, name: m[1] });
    }
}
// A kernel's Rust twin: named in its JS definition's comment ("(Rust: x ...)")
// within the next few lines, or an export with the same name (sep_pack).
const kernelBodies = new Map();
for (const [file, lines] of fileText) {
    if (!file.endsWith('.js')) continue;
    lines.forEach((line, i) => {
        const m = /SIM_KERNELS\[SIM_KERNEL_([A-Z0-9_]+)\]\s*=/.exec(line);
        if (m && !kernelBodies.has(m[1])) kernelBodies.set(m[1], { file, line: i });
    });
}
function rustTwinOf(name) {
    const body = kernelBodies.get(name);
    if (body) {
        const lines = fileText.get(body.file);
        for (let i = body.line; i < Math.min(lines.length, body.line + 6); i++) {
            const m = /Rust:\s*([a-z][a-z0-9_]*)/.exec(lines[i] || '');
            if (m && rustExports.has(m[1])) return rustExports.get(m[1]);
            if (m && rustExports.has('k_' + m[1])) return rustExports.get('k_' + m[1]);
        }
    }
    return rustExports.get(name.toLowerCase()) || null;
}
const kernelRefs = new Map();
for (const name of kernelIds.keys()) kernelRefs.set(name, { fg: 0, bg: 0, ref: 0, files: new Set() });
for (const [file, lines] of fileText) {
    if (!file.endsWith('.js')) continue;
    lines.forEach(line => {
        for (const m of line.matchAll(/\bSIM_KERNEL_([A-Z0-9_]+)\b/g)) {
            const k = kernelRefs.get(m[1]);
            if (!k) continue;
            if (/SIM_KERNEL_[A-Z0-9_]+\s*=\s*\d+/.test(line) || /SIM_KERNELS\[/.test(line)) { k.def = true; continue; }
            if (/simParallelRun\(/.test(line)) k.fg++;
            else if (/simParallelBackground/.test(line) || /\[\s*SIM_KERNEL_/.test(line)) k.bg++;
            else k.ref++;
            k.files.add(file);
        }
    });
}
const kernels = [...kernelIds.entries()].map(([name, d]) => {
    const r = kernelRefs.get(name);
    const rust = rustTwinOf(name);
    return {
        name: `SIM_KERNEL_${name}`,
        id: d.id,
        defined_at: `${d.file}:${d.line}`,
        js_sites: { foreground_run: r.fg, background_lane: r.bg, other: r.ref },
        files: [...r.files].sort(),
        rust_export: rust ? rust.name : null,
        rust_file: rust ? rust.file : null
    };
}).sort((a, b) => a.id - b.id);

// ---------- findings ----------
const findings = [];
for (const L of lanes) {
    if (L.on_demand || L.nominal_hz === null || L.actual_hz === null) continue;
    if (Math.abs(L.nominal_hz - L.actual_hz) > 1e-9) {
        findings.push({
            kind: 'nominal-vs-actual-rate',
            lane: L.lane,
            text: `${L.label}: lane ${L.lane} is named for ${L.nominal_hz}/s but its gate runs it at ${L.actual_hz}/s (period ${L.actual_period_ticks} ticks at TICK_RATE ${TICK_RATE}).`
        });
    }
}
for (const L of lanes) for (const ev of L.events) {
    if (ev.period && ev.period.name && ev.period.value === null) findings.push({ kind: 'missing-constant', lane: L.lane, text: `${ev.name}: constant ${ev.period.name} not found in the source.` });
}
for (const t of threads) for (const f of t.files) if (!fileText.has(f)) findings.push({ kind: 'missing-file', text: `thread ${t.id}: ${f} not found.` });
for (const s of spawns) if (!s.found) findings.push({ kind: 'missing-spawn', text: `${s.from} -> ${s.to}: no new Worker( call in ${s.via}.` });
const unmatchedRust = kernels.filter(k => !k.rust_export).map(k => k.name);
if (unmatchedRust.length) findings.push({ kind: 'kernel-without-rust-twin', text: `${unmatchedRust.length} of ${kernels.length} JS kernels have no Rust twin found (by a "Rust:" note in their definition or an export of the same name). Either they have no Rust twin or the twin is not named in the way this scan looks for: ${unmatchedRust.slice(0, 10).join(', ')}${unmatchedRust.length > 10 ? ', ...' : ''}.` });

const data = {
    schema: 'defence3-architecture/1',
    generated_by: 'tests/architecture-viz/extract.cjs',
    source: { commit, js_files: jsFiles.length, rust_files: rsFiles.length },
    units: { time: 'base ticks; one base tick = TICK_MS of game time', tick_rate_hz: TICK_RATE, tick_ms: TICK_MS },
    constants: { TICK_RATE: constRef('TICK_RATE'), SIM_DK_MAX: constRef('SIM_DK_MAX'), SIM_CLIENT_MAX_IN_FLIGHT: constRef('SIM_CLIENT_MAX_IN_FLIGHT'), SIM_CLIENT_LEAD_TICKS: constRef('SIM_CLIENT_LEAD_TICKS'), SIM_PRESENT_SNAPS: constRef('SIM_PRESENT_SNAPS') },
    deltatick: {
        meaning: 'simDk = base ticks per simulation step. A periodic event of period P at phase φ fires in a step when some base tick of the step satisfies (t + φ) mod P == 0 (simStepCrosses).',
        step_for_ms: 'ceil(ms / TICK_MS - 0.1), 1 when <= 1, at most SIM_DK_MAX'
    },
    threads,
    spawns,
    message_channels: channels,
    presentation: MANIFEST.presentation,
    helpers: { sim_helpers: 'spawned by sim_parallel.js (simParallelBackgroundHelper spawn)', presentation_helpers: 'min(3, cores >> 2 - 1)' },
    lanes,
    lane_ids: Object.fromEntries(laneIds),
    cadences,
    kernels,
    findings
};

// ---------- write ----------
const jsonText = JSON.stringify(data, null, 2) + '\n';
fs.writeFileSync(path.join(OUT_DIR, 'architecture.json'), jsonText);

const template = read(TEMPLATE);
const PLACEHOLDER = '/*__ARCH_JSON__*/null';
if (!template.includes(PLACEHOLDER)) throw new Error(`viewer.html is missing the ${PLACEHOLDER} placeholder`);
// Embedded as a JS literal; "</" is escaped so the data cannot close the script tag.
const embedded = JSON.stringify(data).replace(/<\//g, '<\\/');
fs.writeFileSync(path.join(OUT_DIR, 'architecture.html'), template.replace(PLACEHOLDER, () => embedded));

console.log(`wrote ${rel(path.join(OUT_DIR, 'architecture.json'))} (${jsonText.length} bytes)`);
console.log(`wrote ${rel(path.join(OUT_DIR, 'architecture.html'))}`);
console.log(`lanes ${lanes.length}, threads ${threads.length}, channels ${channels.length}, kernels ${kernels.length}, cadence constants ${cadences.length}, findings ${findings.length}`);
for (const f of findings) console.log(`  [${f.kind}] ${f.text}`);
