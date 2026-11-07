'use strict';
// The full validation set, serially: wasm build, every tests/**/*.test.cjs in
// SIM_WORKER=0 and 1, soaks/extremes/helper determinism, UI + multiplayer GUI
// fuzzers, perf fuzz (large scene + multiplayer), every benchmark, chaos
// profiles, browser/Edge probes and all balance scenarios. (run-all.cjs is the
// quick parallel pass over the .test.cjs files only.)
//
//   node tests/run-full.cjs [--functional] [--only=regex] [--skip=regex] [--list] [--headed]
//                           [--resume=<run dir>] [--rerun=regex] [--fuzz-minutes=60] [--mp-fuzz-minutes=30]
//
// Output: tests/test-runs/full/<stamp>/ — status.json (live), summary.md,
// results.jsonl, run.log, logs/<n>-<job>.log, manifest.json (commands + source
// hashes), artifacts/<job>/ (top-level tests/ outputs a job wrote).
// Stop: create an empty file STOP in the run dir (kills the current job tree).
// --resume=<dir>: reuse that run dir and skip the jobs that PASSed there
// (--rerun=regex: those jobs run again even so).
// --functional: only the jobs that can fail on a bug (tests in both modes,
// soaks/extremes, fuzzers, behaviour-checking browser tests); no benchmarks,
// profiles, tickbench, balance or timing/latency/FPS probes.
// --only/--skip match job names (see --list). Failures never stop the run.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto'), os = require('node:os');
const { spawn, spawnSync } = require('node:child_process');

const arg = (k, d) => { const a = process.argv.find(x => x.startsWith('--' + k + '=')); return a ? a.slice(k.length + 3) : d; };
const flag = k => process.argv.includes('--' + k);
const root = path.resolve(__dirname, '..');
process.chdir(root);
const resume = arg('resume', '');
const out = resume ? path.resolve(resume) : path.join(__dirname, 'test-runs', 'full', new Date().toISOString().replace(/[:.]/g, '-'));
const logs = path.join(out, 'logs');
const artifact = name => path.join(out, name);
const relative = p => path.relative(root, p).split(path.sep).join('/');
const fuzzMinutes = +arg('fuzz-minutes', 60), mpFuzzMinutes = +arg('mp-fuzz-minutes', 30);
const helpers = String(Math.max(1, Math.min(11, os.cpus().length - 1)));

// ---- Playwright: wherever it is installed (not a repo dependency) ----
function findPlaywright() {
    const dirs = [process.env.PLAYWRIGHT_DIR, ...String(process.env.NODE_PATH || '').split(path.delimiter)];
    try { dirs.push(path.dirname(path.dirname(require.resolve('playwright/package.json')))); } catch { }
    try { dirs.push(spawnSync('npm', ['root', '-g'], { shell: true, encoding: 'utf8' }).stdout.trim()); } catch { }
    const codex = path.join(os.homedir(), 'AppData/Local/OpenAI/Codex/runtimes/cua_node');
    try { for (const d of fs.readdirSync(codex)) dirs.push(path.join(codex, d, 'bin/node_modules')); } catch { }
    dirs.push('Z:/data/Antigravity/resources/app/node_modules');
    return dirs.filter(Boolean).find(d => fs.existsSync(path.join(d, 'playwright', 'package.json'))) || '';
}

// ---- jobs ----
function walk(dir) {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory()
        ? (['test-runs', 'node_modules'].includes(e.name) ? [] : walk(path.join(dir, e.name)))
        : [path.join(dir, e.name)]);
}
const files = walk(__dirname);
const jobs = [];
const add = (name, file, args = [], env = {}, timeout = 3600) => jobs.push({ name, file, args, env, timeout });
const scenarioCount = (() => { try { return JSON.parse(fs.readFileSync('tests/scenarios/manifest.json', 'utf8')).scenarios.length; } catch { return 0; } })();
const chaosBig = ['--units=1000000', '--structures=250000', '--warmup=20', '--helpers=' + helpers, '--dk=1'];

add('wasm-build', 'wasm/build.cjs', ['--wasm32'], {}, 1800);
// First timing: the large mixed chaos workload, alone.
add('chaos-million', 'tests/chaos-spikes.bench.cjs', [...chaosBig, '--ticks=240', '--kernels', '--system-metrics', '--memory-stats', '--out=' + artifact('chaos-million.json')], {}, 7200);
for (const mode of ['0', '1']) for (const file of files.filter(f => f.endsWith('.test.cjs')).sort())
    add('regression-' + mode + '-' + relative(file).replace(/^tests\//, '').replace(/[/.]/g, '-').replace(/-test-cjs$/, ''), relative(file), [], { SIM_WORKER: mode }, mode === '1' ? 3600 : 1800);
for (const mode of ['0', '1']) {
    add('chaos-helpers-' + mode, 'tests/multiplayer-chaos-determinism.test.cjs', [], { SIM_WORKER: mode, CHAOS_HOST_HELPERS: '4' }, 5400);
    add('soak-300-' + mode, 'tests/multiplayer-soak.test.cjs', ['300'], { SIM_WORKER: mode }, 7200);
    add('extremes-gc-' + mode, 'tests/multiplayer-extremes.test.cjs', [], { SIM_WORKER: mode, EXT_GC: '3' }, 5400);
    add('extremes-dk4-' + mode, 'tests/multiplayer-extremes.test.cjs', [], { SIM_WORKER: mode, EXT_DK: '4' }, 5400);
}
for (const name of ['crowd-scenarios', 'entity-storage-census', 'multiplayer-checkerboard-chaos']) add(name, 'tests/' + name + '.cjs', [], {}, 7200);
add('ui-fuzz', 'tests/ui-fuzz.cjs', [], { HEADED: '0', OUT: artifact('ui-fuzz.json') });
add('browser-mp-gui-fuzz', 'tests/browser-mp-gui-fuzz.cjs');
add('browser-mp-join-stall', 'tests/browser-mp-join-stall.cjs');
add('perf-fuzz-large', 'tests/perf-fuzz.cjs', ['scenes/chaos-1m-250k.gz', '--minutes=' + fuzzMinutes, '--headless', '--seed=20261103', '--out=' + artifact('perf-fuzz-large')], {}, fuzzMinutes * 60 + 3600);
add('perf-fuzz-multiplayer', 'tests/perf-fuzz.cjs', ['50000-200.json', '--mp=2', '--minutes=' + mpFuzzMinutes, '--headless', '--seed=20261104', '--out=' + artifact('perf-fuzz-multiplayer')], {}, mpFuzzMinutes * 60 + 3600);
for (const file of files.filter(f => /(?:\.bench|-bench)\.cjs$/.test(f)).sort()) {
    const rel = relative(file), name = path.basename(file, '.cjs');
    if (name === 'chaos-spikes.bench') continue; // run above, profiled below
    const args = name === 'chaos-tps-matrix.bench' ? ['--repeats=2', '--ticks=140', '--warmup=20', '--hash', '--out=' + artifact('chaos-matrix')] : [];
    const source = fs.readFileSync(file, 'utf8');
    if (!args.length && (/\b(?:opt|option)\(['"]out['"]/.test(source) || source.includes("startsWith('--out=')"))) args.push('--out=' + artifact(name + '.json'));
    if (name === 'scenarios.bench') args.push('--out', artifact('scenarios'));
    add('benchmark-' + name, rel, args, { OUT: artifact(name + '.json') },
        name === 'scenarios.bench' ? Math.max(21600, scenarioCount * 180) : name === 'chaos-tps-matrix.bench' ? 21600 : 7200);
}
add('chaos-profile', 'tests/chaos-spikes.bench.cjs', [...chaosBig, '--ticks=100', '--kernels', '--system-metrics', '--profile', '--helper-profile', '--timeline', '--profile-start=19', '--out=' + artifact('chaos-profile.json')], {}, 7200);
add('chaos-neighbor-slices', 'tests/chaos-spike-profile.cjs', [artifact('chaos-profile.json')]);
add('chaos-allocation-profile', 'tests/chaos-spikes.bench.cjs', [...chaosBig, '--ticks=100', '--allocation-profile', '--out=' + artifact('chaos-allocations.json')], {}, 7200);
add('chaos-allocation-analysis', 'tests/chaos-allocation-profile.cjs', [artifact('chaos-allocations.json')]);
for (const [name, env] of [['base', {}], ['active', { ACTIVE: '1' }], ['battle', { BATTLE: 'mix' }], ['towers', { TOWERS: '8000' }], ['siege', { TOWERS: '8000', BATTLE: 'mix' }]])
    add('tickbench-' + name, '.claude/tickbench.cjs', ['8'], { DATA: 'tests/100000-1000.json', HELPERS: helpers, MEMSTAT: 'gc', GCSTAT: '1', KCPU: '1', KTIME: '1', ...env }, 5400);
for (const name of ['render-scale-profile', 'ui-longtask-survey', 'page-stall-tps-probe', 'motion-jitter-probe', 'view-switch-spike', 'select-all-spike-probe', 'lod-startup-browser', 'lod-strip-browser', 'pop-limit-menu.browser', 'camera-steady-trace', 'fx-ab-probe'])
    add('browser-' + name, 'tests/' + name + '.cjs', [], { OUT: artifact('browser-' + name + '.json') }, 5400);
add('edge-chaos-scene', '.claude/scene_tps_probe.cjs', ['scenes/chaos-1m-250k.gz', '60'], { QUERY: 'simtrace=1', PAGEEVAL: 'JSON.stringify(window.__simTrace)' }, 3600);
for (const name of ['click_latency_probe', 'latency_probe', 'order_marker_probe', 'panel_scroll_probe', 'place_tps_probe'])
    add('browser-' + name, '.claude/' + name + '.cjs', [], { OUT: artifact(name + '.json') }, 5400);
add('balance-all-scenarios', 'tests/balance/run-fights.cjs', ['--seconds', '60', '--scenarios', '*', '--jobs', '1', '--out', artifact('balance')], {}, 43200);

let selected = jobs.map((j, i) => ({ ...j, index: i }));
// --functional: what can fail on a bug only; no measurements (benchmarks,
// profiles, tickbench, balance, the timing/latency/FPS probes).
const MEASURE = /^(benchmark-|balance-|tickbench-|chaos-(million|profile|neighbor|allocation)|edge-chaos-scene$|browser-(render-scale-profile|page-stall-tps-probe|motion-jitter-probe|view-switch-spike|select-all-spike-probe|camera-steady-trace|fx-ab-probe|click_latency_probe|latency_probe|order_marker_probe|panel_scroll_probe|place_tps_probe)$)/;
if (flag('functional')) selected = selected.filter(j => !MEASURE.test(j.name));
const only = arg('only', ''), skip = arg('skip', '');
if (only) selected = selected.filter(j => new RegExp(only).test(j.name));
if (skip) selected = selected.filter(j => !new RegExp(skip).test(j.name));
const rows = [];
if (resume) {
    try { for (const l of fs.readFileSync(artifact('results.jsonl'), 'utf8').split('\n')) if (l.trim()) rows.push(JSON.parse(l)); } catch { }
    // (The latest row per job wins.)
    const passed = new Set(); for (const r of rows) r.result === 'PASS' ? passed.add(r.name) : passed.delete(r.name);
    const rerun = arg('rerun', '');
    selected = selected.filter(j => !passed.has(j.name) || (rerun && new RegExp(rerun).test(j.name)));
}
if (flag('list')) { for (const j of selected) console.log(j.name + '  ' + j.file + ' ' + j.args.join(' ') + ' ' + JSON.stringify(j.env)); console.log(selected.length + ' jobs'); process.exit(0); }
fs.mkdirSync(logs, { recursive: true });
try { fs.unlinkSync(artifact('STOP')); } catch { }

// ---- environment ----
const playwright = findPlaywright();
const base = { ...process.env };
for (const key of ['SIM_WORKER', 'CHAOS_HOST_HELPERS', 'CHAOS_MAPS', 'CHAOS_SIM_EVAL', 'DEFENCE_TEST_SOURCE_OVERRIDES', 'WASM32_OVERRIDE', 'WASM64_OVERRIDE', 'PRE', 'ROWX', 'SUBPHASES', 'HEADED', 'WPROF', 'WEVAL', 'WEVAL_START', 'PAGEEVAL', 'QUERY', 'OUT', 'NODE_OPTIONS'])
    delete base[key];
if (playwright) { base.PLAYWRIGHT_DIR = playwright; base.NODE_PATH = [playwright, process.env.NODE_PATH].filter(Boolean).join(path.delimiter); }
// (Inherited by the processes each suite spawns too.)
if (!flag('headed')) base.NODE_OPTIONS = '--require "' + path.join(__dirname, 'run-full-headless.cjs').replace(/\\/g, '/') + '"';

const hashes = {};
for (const file of [...walk(path.join(root, 'src')), ...walk(path.join(root, 'wasm', 'src'))].filter(f => /\.(js|rs)$/.test(f)))
    hashes[relative(file)] = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
let commit = ''; try { commit = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim(); } catch { }
fs.writeFileSync(artifact('manifest.json'), JSON.stringify({ created: new Date().toISOString(), root, commit, node: process.version, playwright, headless: !flag('headed'), helpers, jobs: selected, sourceHashes: hashes }, null, 2));

const state = { pid: process.pid, started: new Date().toISOString(), status: 'running', total: selected.length, completed: 0, passed: 0, failed: 0, timedOut: 0, current: null };
function save() {
    state.updated = new Date().toISOString();
    fs.writeFileSync(artifact('status.json'), JSON.stringify(state, null, 2));
    const bad = rows.filter(r => r.result !== 'PASS');
    fs.writeFileSync(artifact('summary.md'), '# Full validation\n\n' + state.status + ' — ' + state.completed + '/' + state.total + ' completed; ' + state.passed + ' passed, ' + state.failed + ' failed, ' + state.timedOut + ' timed out.\n\nCurrent: ' + (state.current ? state.current.name : 'none') +
        '\n\n## Not passed\n\n' + (bad.length ? bad.map(r => '- ' + r.name + ' — ' + r.result + ' ([log](logs/' + r.log + '))').join('\n') : 'none') +
        '\n\n## All\n\n| Job | Result | Seconds | Log |\n|---|---|---:|---|\n' + rows.map(r => '| ' + r.name + ' | ' + r.result + ' | ' + (r.elapsedMs / 1000).toFixed(1) + ' | [log](logs/' + r.log + ') |').join('\n') + '\n');
}
function log(s) { const line = new Date().toISOString() + ' ' + s; fs.appendFileSync(artifact('run.log'), line + '\n'); console.log(line); }
function killTree(pid) { if (!pid) return; if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); else try { process.kill(-pid, 'SIGKILL'); } catch { } }
function archiveOutputs(start, name) {
    const dest = artifact('artifacts/' + name);
    for (const e of fs.readdirSync(__dirname, { withFileTypes: true })) {
        if (!e.isFile() || !/\.(json|csv|html|log|png)$/.test(e.name)) continue;
        const f = path.join(__dirname, e.name);
        if (fs.statSync(f).mtimeMs >= start) { fs.mkdirSync(dest, { recursive: true }); fs.copyFileSync(f, path.join(dest, e.name)); }
    }
}
async function run(job, n) {
    const start = Date.now(), logName = String(job.index + 1).padStart(4, '0') + '-' + job.name + '.log', fd = fs.openSync(path.join(logs, logName), 'w');
    let timedOut = false, stopped = false, error = null;
    const missing = !fs.existsSync(path.join(root, job.file));
    if (missing) fs.writeSync(fd, 'missing job file: ' + job.file + '\n');
    const child = missing ? null : spawn(process.execPath, ['--max-old-space-size=8192', '--expose-gc', job.file, ...job.args], { cwd: root, env: { ...base, ...job.env }, windowsHide: true, stdio: ['ignore', fd, fd], detached: process.platform !== 'win32' });
    state.current = { name: job.name, n: n + 1, pid: child && child.pid, started: new Date(start).toISOString(), timeoutSeconds: job.timeout, log: logName }; save();
    log('START ' + (n + 1) + '/' + selected.length + ' ' + job.name);
    let code = 127;
    if (child) {
        const timer = setTimeout(() => { timedOut = true; killTree(child.pid); }, job.timeout * 1000);
        const heartbeat = setInterval(() => { save(); if (fs.existsSync(artifact('STOP')) && !stopped) { stopped = true; killTree(child.pid); } }, 10000);
        code = await new Promise(resolve => { child.on('error', e => { error = String(e); }); child.on('close', resolve); });
        clearTimeout(timer); clearInterval(heartbeat);
    }
    fs.closeSync(fd);
    const row = { name: job.name, file: job.file, args: job.args, env: job.env, exitCode: code, result: stopped ? 'STOPPED' : timedOut ? 'TIMEOUT' : code === 0 ? 'PASS' : 'FAIL', error, elapsedMs: Date.now() - start, log: logName };
    try { archiveOutputs(start, job.name); } catch (e) { row.artifactError = String(e); }
    rows.push(row); fs.appendFileSync(artifact('results.jsonl'), JSON.stringify(row) + '\n');
    state.completed++; if (row.result === 'PASS') state.passed++; else state.failed++; if (timedOut) state.timedOut++;
    state.current = null; save();
    log('DONE ' + job.name + ' ' + row.result + ' exit=' + code + ' ' + ((Date.now() - start) / 1000).toFixed(1) + 's');
    return stopped;
}
(async () => {
    save();
    log('RUNNER PID ' + process.pid + '; ' + selected.length + ' serial jobs; out ' + out + '; playwright ' + (playwright || 'NOT FOUND'));
    for (let i = 0; i < selected.length; i++) {
        if (fs.existsSync(artifact('STOP')) || await run(selected[i], i)) { state.status = 'stopped'; save(); return; }
    }
    state.status = state.failed ? 'complete-with-failures' : 'complete'; save();
    log('ALL DONE ' + state.passed + '/' + state.total + ' passed' + (state.failed ? '; not passed: ' + rows.filter(r => r.result !== 'PASS').map(r => r.name).join(', ') : ''));
})().catch(e => { state.status = 'runner-failed'; state.error = String(e.stack || e); save(); log(state.error); process.exitCode = 1; });
