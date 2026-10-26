'use strict';
// Perf fuzzer: random player behaviour (UI and in-game) against a big match in
// real Edge, run for as long as you like, measuring what each action does to
// the frame rate, the tick rate, the wasm heap and the machine's memory.
//
//   node tests/perf-fuzz.cjs [fixture] [options]        run (Ctrl+C or a STOP file in the output folder ends it cleanly)
//   node tests/perf-fuzz.cjs report <run folder>        rebuild the report of a run
//
// Fixture: a menu-settings file from tests/ (default 100000-1000.json) or a
// scene (scenes/mixed-200k.gz, 4M-1K-closeup-fight.gz). Options (--name=value,
// or the env var NAME): see tests/perf-fuzz/README.md. Needs playwright
// (NODE_PATH or PLAYWRIGHT_DIR) and Microsoft Edge. Run it alone: it measures.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const os = require('node:os');
const { root, sleep, makeOpts, startServer, makeRng, withTimeout, round } = require('./perf-fuzz/env.cjs');
const { startOsSampler } = require('./perf-fuzz/os-sampler.cjs');
const { Session, SessionDead } = require('./perf-fuzz/session.cjs');
const { actions, scenarios, leakSafe } = require('./perf-fuzz/actions.cjs');
const { DEFAULT_THRESHOLDS, buildReport, fmtT } = require('./perf-fuzz/analyze.cjs');

const { opt, num, bool, list, positional } = makeOpts(process.argv.slice(2));
const command = positional[0] === 'report' ? 'report' : 'run';

// ---------------- report command ----------------
function readJsonl(file) { try { return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return []; } }
function reportOf(dir) {
    const run = (() => { try { return JSON.parse(fs.readFileSync(path.join(dir, 'run.json'), 'utf8')); } catch { return {}; } })();
    const trials = readJsonl(path.join(dir, 'trials.jsonl')), samples = readJsonl(path.join(dir, 'samples.jsonl'));
    const profiles = new Map(readJsonl(path.join(dir, 'profiles.jsonl')).map(p => [p.trial, p]));
    for (const t of trials) { const p = profiles.get(t.id); if (p) { t.profile = p.summary; t.confirmed = p.confirmed; } }
    const errors = readJsonl(path.join(dir, 'errors.jsonl')), stalls = [...readJsonl(path.join(dir, 'stalls.jsonl')), ...readJsonl(path.join(dir, 'incidents.jsonl'))], checkpoints = readJsonl(path.join(dir, 'checkpoints.jsonl'));
    return buildReport({ run, trials, samples, errors, stalls, checkpoints });
}
if (command === 'report') {
    const dir = path.resolve(positional[1] || '');
    if (!positional[1] || !fs.existsSync(dir)) { console.error('usage: node tests/perf-fuzz.cjs report <run folder>'); process.exit(2); }
    const text = reportOf(dir);
    fs.writeFileSync(path.join(dir, 'report.md'), text);
    console.log(text);
    process.exit(0);
}

// ---------------- configuration ----------------
const T0 = Date.now();
const stamp = new Date(T0).toISOString().replace(/[:.]/g, '-').slice(0, 19);
const fixture = positional[0] || opt('fixture', '100000-1000.json');
const [vw, vh] = String(opt('viewport', '1600x900')).split('x').map(Number);
const thresholds = { ...DEFAULT_THRESHOLDS };
for (const [flag, key] of [['tps-drop', 'tpsDrop'], ['tps-abs', 'tpsAbs'], ['fps-drop', 'fpsDrop'], ['fps-abs', 'fpsAbs'], ['gap-ms', 'gapMs'], ['frame-ms', 'frameMs'], ['long-ms', 'longMs'], ['handler-ms', 'handlerMs'], ['sim-rel', 'simRel'], ['sim-abs', 'simAbs'], ['sim-max-ms', 'simMaxMs'], ['wasm-grow-mb', 'wasmGrowMB'], ['priv-grow-mb', 'privGrowMB'], ['recover-rel', 'recoverRel']]) thresholds[key] = num(flag, thresholds[key]);
const cfg = {
    fixture, t0: T0,
    outDir: path.resolve(opt('out', path.join(root, 'tests', 'test-runs', `perf-fuzz-${stamp}`))),
    minutes: num('minutes', num('hours', 0) * 60), sessionMin: num('session-min', 25), seed: num('seed', Math.floor(Math.random() * 1e6) + 1),
    headed: !bool('headless', false), viewport: { width: vw || 1600, height: vh || 900 },
    visRotation: (list('vis', []).length ? list('vis', []) : [null]),
    // (Every player of a multiplayer run is a full simulation with its own helper threads on this one machine: they share the cores.)
    query: [opt('query', ''), bool('wasm64', false) ? 'wasm64=1' : '', num('mp', 1) > 1 && !/simhelpers/.test(opt('query', '')) ? 'simhelpers=' + num('mp-helpers', Math.max(2, Math.floor((os.cpus().length / 2 - 1) / num('mp', 1)))) : ''].filter(Boolean).join('&'),
    browserArgs: list('browser-args', []), plant: list('plant', []),
    mp: Math.max(1, Math.floor(num('mp', 1))), mpDelayMs: num('mp-delay', 25), mpDrive: opt('mp-drive', 'alternate'),
    loadTimeoutMs: num('load-timeout-min', 15) * 60000, warmMs: num('warm-s', 15) * 1000,
    sampleMs: num('sample-ms', 2000), osEvery: 2, wasmEvery: 1, workerEvery: 4, gpuEvery: 10, stallMs: num('stall-s', 15) * 1000,
    baseMs: num('base-s', 3) * 1000, recoverMs: num('recover-s', 20) * 1000, checkpointMs: num('checkpoint-s', 8) * 1000, checkpointEveryMin: num('checkpoint-min', 6),
    trialGapMs: num('gap-ms-between', 300), trialTimeoutMs: num('trial-timeout-min', 6) * 60000,
    scenarioShare: num('scenario-share', 0.2), comboShare: num('combo-share', 0.2), leakShare: num('leak-share', 0.06), leakReps: num('leak-reps', 12),
    leakThresholds: { listeners: num('leak-listeners', 30), nodes: num('leak-nodes', 400), jsMB: num('leak-js-mb', 15), wasmMB: num('leak-wasm-mb', 8), privMB: num('leak-priv-mb', 250) },
    only: list('only', []), actionNames: list('actions', []), skip: list('skip', []),
    profile: bool('profile', true), profileScore: num('profile-score', 1.5), maxProfiles: num('max-profiles', 12),
    memLimitMB: num('mem-limit-mb', 12000), minAvailMB: num('min-avail-mb', 300), reportEveryMin: num('report-every-min', 10), quiet: bool('quiet', false), replay: opt('replay', ''),
    thresholds,
};
fs.mkdirSync(cfg.outDir, { recursive: true });
const logFile = path.join(cfg.outDir, 'run.log');
const stopFile = path.join(cfg.outDir, 'STOP');
const log = msg => { const s = `[${fmtT((Date.now() - T0) / 1000)}] ${msg}`; if (!cfg.quiet || /FLAG|STALL|ERROR|session|checkpoint|report|!!/.test(msg)) console.log(s); try { fs.appendFileSync(logFile, s + '\n'); } catch { } };

// ---------------- output ----------------
const files = {};
const append = (name, obj) => { try { fs.appendFileSync(path.join(cfg.outDir, name), JSON.stringify(obj) + '\n'); } catch { } };
const mem = { trials: [], samples: [], checkpoints: [], stalls: [] };
const out = {
    trial: r => { mem.trials.push(r); append('trials.jsonl', r); },
    sample: r => { mem.samples.push(r); append('samples.jsonl', r); },
    checkpoint: r => { mem.checkpoints.push(r); append('checkpoints.jsonl', r); },
    incident: r => { mem.stalls.push(r); append('incidents.jsonl', r); },
};
const errorTable = new Map();
const flushErrors = sessions => {
    for (const s of sessions) for (const e of s.errors.values()) errorTable.set(s.index + e.text, { ...e });
    try { fs.writeFileSync(path.join(cfg.outDir, 'errors.jsonl'), [...errorTable.values()].map(e => JSON.stringify(e)).join('\n') + '\n'); } catch { }
};
let commit = '?';
try { commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(); try { if (execFileSync('git', ['status', '--porcelain', '--', 'src'], { cwd: root, encoding: 'utf8' }).trim()) commit += '+dirty'; } catch { } } catch { }
const runInfo = { fixture, seed: cfg.seed, startedAt: new Date(T0).toISOString(), commit, node: process.version, host: os.hostname(), cpus: os.cpus().length, totalMemMB: Math.round(os.totalmem() / 1048576), viewport: `${cfg.viewport.width}x${cfg.viewport.height}`, headed: cfg.headed,
    thresholds, plant: cfg.plant.join(','), mp: cfg.mp, sessions: 0, wasm64: null, edge: null, gpu: null, argv: process.argv.slice(2), options: { ...cfg, thresholds: undefined, outDir: undefined } };
const writeRun = () => { try { fs.writeFileSync(path.join(cfg.outDir, 'run.json'), JSON.stringify(runInfo, null, 1)); } catch { } };
writeRun();
let sessionsSeen = [];
const writeReport = () => {
    try {
        flushErrors(sessionsSeen);
        const text = buildReport({ run: runInfo, trials: mem.trials, samples: mem.samples, errors: [...errorTable.values()], stalls: mem.stalls, checkpoints: mem.checkpoints });
        fs.writeFileSync(path.join(cfg.outDir, 'report.md'), text); return text;
    } catch (e) { log('report failed: ' + e.message); return ''; }
};

// ---------------- planner ----------------
function makePlanner(rng) {
    const allowed = a => (!cfg.only.length || cfg.only.includes(a.cat)) && (!cfg.actionNames.length || cfg.actionNames.includes(a.name)) && !cfg.skip.includes(a.cat) && !cfg.skip.includes(a.name);
    const singles = actions.filter(allowed), scn = scenarios.filter(a => allowed(a) && a.steps.every(s => actions.some(x => x.name === s)));
    const runs = new Map();
    const weight = a => a.weight * ((runs.get(a.name) || 0) < 3 ? 3 : 1);
    const maxTail = names => Math.max(...names.map(n => (actions.find(a => a.name === n) || {}).tailMs || 3500));
    if (cfg.replay) {
        const file = fs.existsSync(path.join(cfg.replay, 'trials.jsonl')) ? path.join(cfg.replay, 'trials.jsonl') : cfg.replay;
        const queue = readJsonl(file).filter(t => !t.skipped && !t.repeatOf && t.steps && t.steps.length).map(t => ({ kind: t.kind, name: t.name, cat: t.cat, steps: t.steps.map(s => s.name), seed: t.seed }));
        let i = 0; log(`replaying ${queue.length} trials from ${file}`);
        return { next: () => queue[i++ % queue.length], runs };
    }
    return {
        runs,
        next() {
            const r = rng.next(); let p;
            const leakable = singles.filter(a => leakSafe.includes(a.name));
            if (cfg.leakShare > 0 && leakable.length && rng.next() < cfg.leakShare) { const a = rng.weighted(leakable, weight); p = { kind: 'leak', name: 'leak:' + a.name, cat: 'leak', steps: [a.name] }; }
            else if (r < cfg.scenarioShare && scn.length) { const a = rng.weighted(scn, weight); p = { kind: 'scenario', name: a.name, cat: 'scenario', steps: a.steps, tailMs: a.tailMs }; }
            else if (r < cfg.scenarioShare + cfg.comboShare && singles.length > 1) {
                const k = rng.int(2, 4), picked = []; for (let i = 0; i < k; i++) picked.push(rng.weighted(singles, weight).name);
                p = { kind: 'combo', name: 'combo:' + picked.join('+'), cat: 'combo', steps: picked, tailMs: maxTail(picked) };
            } else { const a = rng.weighted(singles, weight); p = { kind: 'single', name: a.name, cat: a.cat, steps: [a.name], tailMs: a.tailMs }; }
            p.seed = rng.int(1, 2 ** 30); runs.set(p.name, (runs.get(p.name) || 0) + 1); return p;
        },
    };
}

// ---------------- the run ----------------
const fx = v => v === undefined || v === null || !Number.isFinite(v) ? '?' : String(round(v, 1));
function trialLine(rec) {
    if (rec.skipped) return `   #${rec.id} ${rec.name} skipped (${rec.skipped})`;
    if (rec.kind === 'leak') return `${rec.verdict.flags.length ? '!!' : '  '} #${rec.id} ${rec.name} x${rec.done}: ${Object.entries(rec.delta).filter(([k]) => /^(nodes|listeners|arrayBuffers|glObjects|jsPage|jsWorkers|wasmLive|wasmMem|priv)$/.test(k)).map(([k, v]) => k + (v >= 0 ? '+' : '') + v).join(' ')}${rec.verdict.flags.length ? ' | LEAK? ' + rec.verdict.flags.join(', ') : ''}`;
    const t = rec.tail, d = rec.during, r = rec.ref, v = rec.verdict, mx = (a, b) => Math.max(a, b);
    return `${v.flags.length ? '!!' : '  '} #${rec.id}${rec.player && rec.player !== 'player' ? ' [' + rec.player + ']' : ''} ${rec.name.slice(0, 40).padEnd(26)} tps ${fx(r.tps)}>${fx(t.tps)} fps ${Math.round(r.fps)}>${Math.round(t.fps)} gap ${Math.round(mx(d.tick.gapMax, t.tick.gapMax))} frame ${Math.round(mx(d.frame.max, t.frame.max))} task ${mx(d.long.max, t.long.max)} hnd ${mx(d.input.handlerMax, t.input.handlerMax)} | ${rec.ctx.view} x${rec.ctx.zoomRel} sel ${rec.ctx.sel} units ${rec.ctx.units} | score ${v.score}${v.flags.length ? ' [' + v.flags.join(',') + ']' : ''}${rec.recovery && !rec.recovery.ok ? ' NOT-RECOVERED' : ''}${rec.firstUse ? ' (first use of ' + (rec.firstUseOf || []).join(', ') + ')' : ''}`;
}

let stopRequested = false;
process.on('SIGINT', () => { if (stopRequested) process.exit(130); stopRequested = true; log('stop requested: finishing the current trial (Ctrl+C again to quit at once)'); });
process.on('SIGTERM', () => { stopRequested = true; });
// (A trial that timed out keeps running in the background until its browser closes: its late errors are not a crash of the fuzzer.)
process.on('unhandledRejection', e => { try { log('late error (ignored): ' + String(e && e.message || e).split('\n')[0].slice(0, 160)); } catch { } });
const shouldStop = () => stopRequested || fs.existsSync(stopFile) || (cfg.minutes > 0 && Date.now() - T0 >= cfg.minutes * 60000);

(async () => {
    const { server, base } = await startServer();
    const osSampler = startOsSampler();
    log(`perf fuzz: ${fixture}, seed ${cfg.seed}, ${cfg.minutes ? cfg.minutes + ' min' : 'until stopped'}, sessions of ${cfg.sessionMin} min, ${cfg.headed ? 'headed' : 'headless'} Edge`);
    log(`output: ${cfg.outDir}   (create a file named STOP there, or press Ctrl+C, to end after the current trial; report.md is rewritten every ${cfg.reportEveryMin} min)`);
    if (cfg.plant.length) log('PLANTED slowdowns (self-test): ' + cfg.plant.join(', '));
    const masterRng = makeRng(cfg.seed), planner = makePlanner(masterRng);
    let failures = 0, lastReport = Date.now();
    for (let idx = 0; !shouldStop(); idx++) {
        const S = new Session({ cfg, index: idx, base, os: osSampler, out, log, seed: cfg.seed + idx });
        sessionsSeen.push(S);
        try { await S.open(); failures = 0; }
        catch (e) {
            log(`ERROR: session ${idx} failed to start: ${String(e.message).split('\n')[0]}`); await S.close().catch(() => { });
            if (++failures >= 3) { log('ERROR: three sessions in a row failed to start: giving up'); break; }
            await sleep(10000); continue;
        }
        if (S.startWarning) (runInfo.warnings = runInfo.warnings || []).push(`session ${idx}: ${S.startWarning}`);
        runInfo.sessions = idx + 1; runInfo.edge = S.edgeVersion; runInfo.gpu = S.info.gpu; runInfo.wasm64 = S.info.wasm64; runInfo.units = S.info.units; writeRun();
        const sessionEnd = Date.now() + cfg.sessionMin * 60000;
        let lastCheckpoint = Date.now(), profiles = 0, endReason = 'time'; const profiled = new Set();
        const k0 = await S.checkpoint().catch(() => null); void k0;
        while (!shouldStop()) {
            if (Date.now() >= sessionEnd) { endReason = 'session time'; break; }
            if (S.dead) { endReason = 'browser lost'; break; }
            try {
                if (Date.now() - lastCheckpoint > cfg.checkpointEveryMin * 60000) { await S.checkpoint(); lastCheckpoint = Date.now(); }
                const planned = planner.next();
                const rec = await withTimeout(S.runTrial(planned), cfg.trialTimeoutMs, 'trial ' + planned.name);
                out.trial(rec); log(trialLine(rec));
                if (rec.skipped) { await sleep(500); continue; }
                const flagged = rec.verdict.flags.length > 0 && rec.kind !== 'leak';
                // (One profile per kind of finding: the scenario or first action and the dominant flag, per session.)
                const profKey = (rec.kind === 'scenario' ? rec.name : rec.steps[0] && rec.steps[0].name) + '|' + String(rec.verdict.flags[0] || '').replace(/@.*/, '');
                if (cfg.profile && flagged && rec.verdict.score >= cfg.profileScore && profiles < cfg.maxProfiles && !profiled.has(profKey) && !rec.verdict.flags.every(f => /^(wasm-grow|mem-grow)$/.test(f))) {
                    profiled.add(profKey); profiles++;
                    log(`FLAG ${rec.name} (score ${rec.verdict.score}): repeating it with CPU profiles on the page and every worker`);
                    const dir = path.join(cfg.outDir, 'profiles');
                    const r = await withTimeout(S.profileRepeat(rec, dir), cfg.trialTimeoutMs * 2, 'profile repeat');
                    if (r.again) { r.again.repeatOf = rec.id; out.trial(r.again); log('   repeat: ' + trialLine(r.again).trim()); }
                    rec.confirmed = r.again && !r.again.skipped && r.again.verdict ? r.again.verdict.score >= 1 : null; rec.profile = r.summary;
                    append('profiles.jsonl', { trial: rec.id, name: rec.name, confirmed: rec.confirmed, againScore: r.again && r.again.verdict ? r.again.verdict.score : null, summary: r.summary });
                    log(`   ${rec.confirmed === true ? 'reproduced' : rec.confirmed === false ? 'not reproduced' : 'repeat skipped'}`);
                    if (r.summary.page) {
                        log(`   page busy ${r.summary.page.totals.busyMs} ms (idle control ${r.summary.page.controlTotals.busyMs}); beyond the control: ${r.summary.page.excess.slice(0, 4).map(f => `${f.name} +${f.ms}ms`).join('; ') || '-'}`);
                        for (const k of (r.summary.page.tasks || [])) log(`   a ${k.ms} ms task: ${k.total.slice(0, 4).map(f => `${f.name} ${f.ms}ms`).join('; ')}`);
                        for (const w of r.summary.workers.slice(0, 3)) log(`   ${w.name}: busy ${w.busyMs} ms (control ${w.ctlBusyMs}); beyond: ${w.excess.slice(0, 3).map(f => `${f.name} +${f.ms}ms`).join('; ') || '-'}`);
                    }
                }
                const o = S.lastOs && S.lastOs.edge;
                if (cfg.minAvailMB && S.lastOs && S.lastOs.availMB !== null && S.lastOs.availMB < cfg.minAvailMB && (S.lowAvail = (S.lowAvail || 0) + 1) >= 2) { endReason = `the machine is out of memory (${S.lastOs.availMB} MB available)`; log(`ERROR: ${endReason}: ending the session`); S.incident({ kind: 'memory', availMB: S.lastOs.availMB, priv: o && o.privMB }); break; }
                if (S.lastOs && S.lastOs.availMB >= cfg.minAvailMB) S.lowAvail = 0;
                if (cfg.memLimitMB && o && o.privMB > cfg.memLimitMB) { endReason = `browser private memory ${o.privMB} MB over the limit`; log(`ERROR: ${endReason}`); break; }
                if (Date.now() - lastReport > cfg.reportEveryMin * 60000) { lastReport = Date.now(); writeReport(); log('report.md updated'); }
                await sleep(cfg.trialGapMs);
            } catch (e) {
                if (e.dead) { endReason = e.message; break; }
                if (e.timeout) { endReason = 'trial timed out (' + e.message.slice(0, 80) + ')'; S.incident({ kind: 'stall', ms: cfg.trialTimeoutMs, resolved: false }); break; }
                log('ERROR: trial failed: ' + String(e.stack || e.message).split('\n').slice(0, 3).join(' | '));
                await S.releaseAll().catch(() => { }); await sleep(1000);
                if (++failures > 20) { endReason = 'too many trial failures'; break; }
            }
        }
        log(`session ${idx} ends (${endReason}) after ${S.trialN} trials, ${S.stats.flagged} flagged`);
        flushErrors(sessionsSeen);
        await S.close();
        if (/browser lost|match ended|army gone/.test(endReason)) await sleep(2000);
    }
    const text = writeReport();
    osSampler.close(); server.close();
    log('done. report: ' + path.join(cfg.outDir, 'report.md'));
    const head = text.split('\n## ')[0]; console.log('\n' + head);
    process.exit(0);
})().catch(e => { console.error(e); try { writeReport(); } catch { } process.exit(1); });
