'use strict';
// What counts as a slowdown, and the report. Windows are the probe's summaries
// (probe.js P.win). A trial is judged against a reference: the median of the
// calm windows just before recent trials, so a slow drift of the match (units
// grow, armies meet) moves the reference and does not flag everything.
const { median, quantile, mean, round } = require('./env.cjs');

const DEFAULT_THRESHOLDS = {
    tpsDrop: 0.15, tpsAbs: 1,           // tick rate: 15 % and at least 1 TPS below the reference
    fpsDrop: 0.25, fpsAbs: 8,           // frame rate: 25 % and at least 8 FPS below
    gapMs: 200, gapRel: 3,              // longest wait between tick results (and x the reference's p95)
    frameMs: 200, frameRel: 3,          // longest frame (and x the reference's p99)
    longMs: 150,                        // longest main-thread task
    handlerMs: 100,                     // longest input handler
    simRel: 1.3, simAbs: 25,            // worker ms per tick: 30 % over the reference and over 25 ms (half the 50 ms tick budget)
    simMaxMs: 60,                       // the worker's slowest tick (the budget is 50 ms)
    wasmGrowMB: 128, privGrowMB: 600,   // growth in one trial that is still there when the match has recovered (leak hunts are the better judge)
    recoverRel: 0.9,                    // TPS back to this share of the reference
};

// Reference values from a list of calm windows.
function makeRef(windows) {
    const pick = f => median(windows.map(f).filter(v => Number.isFinite(v)));
    return {
        n: windows.length,
        tps: pick(w => w.tps), fps: pick(w => w.fps),
        frameP95: pick(w => w.frame.p95), frameP99: pick(w => w.frame.p99), frameMax: pick(w => w.frame.max),
        gapP95: pick(w => w.tick.gapP95), gapMax: pick(w => w.tick.gapMax),
        sim: pick(w => w.sim.mean), simP95: pick(w => w.sim.p95), work: pick(w => w.work.mean),
    };
}

// One window against the reference: the components of its score (>= 1 flags).
function judge(ref, w, T) {
    const c = {}, why = [];
    const dTps = ref.tps > 0 ? (ref.tps - w.tps) / ref.tps : 0, dFps = ref.fps > 0 ? (ref.fps - w.fps) / ref.fps : 0;
    c.tps = ref.tps - w.tps >= T.tpsAbs ? dTps / T.tpsDrop : 0;
    c.fps = ref.fps - w.fps >= T.fpsAbs ? dFps / T.fpsDrop : 0;
    c.gap = w.tick.gapMax / Math.max(T.gapMs, T.gapRel * (ref.gapP95 || 0));
    c.frame = w.frame.max / Math.max(T.frameMs, T.frameRel * (ref.frameP99 || 0));
    c.long = w.long.max / T.longMs;
    c.handler = w.input.handlerMax / T.handlerMs;
    c.sim = w.sim.mean / Math.max(ref.sim * T.simRel, T.simAbs);
    c.simMax = w.sim.max / T.simMaxMs;
    let score = 0, top = '';
    for (const [k, v] of Object.entries(c)) { if (v > score) { score = v; top = k; } if (v >= 1) why.push(k); }
    return { dTps: round(dTps, 3), dFps: round(dFps, 3), simRatio: ref.sim > 0 ? round(w.sim.mean / ref.sim, 2) : null, c, score: round(score, 2), top, why };
}

// A trial's verdict from its windows (during = action and settling, tail = the state it left behind).
function judgeTrial(ref, t, T) {
    const during = judge(ref, t.during, T), tail = judge(ref, t.tail, T);
    const flags = new Set();
    for (const w of during.why) flags.add(w + '@during');
    for (const w of tail.why) flags.add(w + '@tail');
    let score = Math.max(during.score, tail.score);
    if (t.recovery && !t.recovery.ok) { flags.add('persistent'); score = Math.max(score, 1 + (t.recovery.deficit || 0) / T.tpsDrop); }
    const m = t.mem || {};
    if (m.wasmMemGrowMB >= T.wasmGrowMB) { flags.add('wasm-grow'); score = Math.max(score, m.wasmMemGrowMB / T.wasmGrowMB); }
    if (m.privGrowMB >= T.privGrowMB) { flags.add('mem-grow'); score = Math.max(score, m.privGrowMB / T.privGrowMB); }
    return { during, tail, flags: [...flags], score: round(score, 2) };
}

// ---- aggregation ----
const finite = a => a.filter(v => Number.isFinite(v));
function groupStats(trials, keyOf) {
    const by = new Map();
    for (const t of trials) { if (t.skipped) continue; const k = keyOf(t); if (k === null || k === undefined) continue; (by.get(k) || by.set(k, []).get(k)).push(t); }
    const rows = [];
    for (const [key, list] of by) {
        const tail = list.map(t => t.verdict && t.verdict.tail), dur = list.map(t => t.verdict && t.verdict.during);
        const worst = f => Math.max(0, ...finite(list.map(f)));
        rows.push({
            key, n: list.length, flagged: list.filter(t => t.verdict && t.verdict.flags.length).length, persistent: list.filter(t => t.recovery && !t.recovery.ok).length,
            dTpsMed: round(median(finite(tail.map(v => v && v.dTps))), 3), dTpsP90: round(quantile(finite(tail.map(v => v && v.dTps)), 0.9), 3), dTpsWorst: round(worst(t => t.verdict && t.verdict.tail.dTps), 3),
            dFpsMed: round(median(finite(tail.map(v => v && v.dFps))), 3), dFpsP90: round(quantile(finite(tail.map(v => v && v.dFps)), 0.9), 3), dFpsWorst: round(worst(t => t.verdict && t.verdict.tail.dFps), 3),
            gapWorst: round(worst(t => Math.max(t.during.tick.gapMax, t.tail.tick.gapMax)), 0), frameWorst: round(worst(t => Math.max(t.during.frame.max, t.tail.frame.max)), 0),
            longWorst: round(worst(t => Math.max(t.during.long.max, t.tail.long.max)), 0), handlerWorst: round(worst(t => Math.max(t.during.input.handlerMax, t.tail.input.handlerMax)), 0),
            simRatioMed: round(median(finite(tail.map(v => v && v.simRatio))), 2),
            scoreMean: round(mean(finite(list.map(t => t.verdict && t.verdict.score))), 2), scoreMax: round(worst(t => t.verdict && t.verdict.score), 2),
            firstUseScore: round(Math.max(0, ...finite(list.filter(t => t.firstUse).map(t => t.verdict && t.verdict.score))), 2),
            recoverMsMed: round(median(finite(list.map(t => t.recovery && t.recovery.ms))), 0),
        });
    }
    return rows.sort((a, b) => b.scoreMean - a.scoreMean || b.scoreMax - a.scoreMax);
}

// Least squares of y over x (x in minutes): slope per minute and r^2.
function fit(points) {
    const n = points.length; if (n < 4) return null;
    const mx = mean(points.map(p => p[0])), my = mean(points.map(p => p[1]));
    let sxx = 0, sxy = 0, syy = 0;
    for (const [x, y] of points) { sxx += (x - mx) ** 2; sxy += (x - mx) * (y - my); syy += (y - my) ** 2; }
    if (sxx === 0) return null;
    return { slope: sxy / sxx, r2: syy === 0 ? 0 : (sxy * sxy) / (sxx * syy) };
}

// Theil-Sen: the median of the slopes between pairs of points (units per x), and the share of pairs that rise.
// A sawtooth (garbage collection), a step (one-time growth) or a few wild samples do not move it; a steady climb does.
function senSlope(points) {
    if (points.length < 6) return null;
    const stride = Math.max(1, Math.ceil(points.length / 160)), p = points.filter((_, i) => i % stride === 0), slopes = [];
    let up = 0, n = 0;
    for (let i = 0; i < p.length; i++) for (let j = i + 1; j < p.length; j++) { const dx = p[j][0] - p[i][0]; if (dx <= 0) continue; const s = (p[j][1] - p[i][1]) / dx; slopes.push(s); n++; if (s > 0) up++; }
    return n ? { slope: median(slopes), rise: up / n } : null;
}

const MEM_SERIES = [
    // [label, getter, unit, rising threshold per minute]
    ['wasm heap memory', s => s.wasmMem, 'MB', 4], ['wasm heap live', s => s.wasmLive, 'MB', 4], ['wasm heap free', s => s.wasmFree, 'MB', 8],
    ['page JS heap', s => s.jsPage, 'MB', 3], ['sim worker JS heap', s => s.jsSim, 'MB', 3], ['presentation worker JS', s => s.jsPres, 'MB', 3], ['all workers JS (used)', s => s.jsWorkers, 'MB', 5],
    ['browser private (all)', s => s.priv, 'MB', 8], ['renderer private (sum)', s => s.privRenderer, 'MB', 8], ['gpu process private', s => s.privGpu, 'MB', 8], ['GPU dedicated', s => s.gpuDed, 'MB', 8],
    ['handles', s => s.handles, '', 20], ['DOM nodes', s => s.nodes, '', 150], ['JS event listeners', s => s.listeners, '', 60], ['ArrayBuffers', s => s.arrayBuffers, '', 25],
    ['GL textures', s => s.glTextures, '', 0.15], ['GL buffers', s => s.glBuffers, '', 0.3], ['GL framebuffers', s => s.glFramebuffers, '', 0.05], ['GL programs', s => s.glPrograms, '', 0.05],
];

function trends(samples, opts = {}) {
    const rows = [];
    const bySession = new Map();
    for (const s of samples) (bySession.get(s.session) || bySession.set(s.session, []).get(s.session)).push(s);
    for (const [session, list] of bySession) {
        const warm = (opts.warmMin || 3) * 60;
        const body = list.filter(s => s.st >= warm);
        const spanMin = body.length > 1 ? (body[body.length - 1].st - body[0].st) / 60 : 0;
        for (const [label, get, unit, thr] of MEM_SERIES) {
            const pts = body.map(s => [s.st / 60, get(s)]).filter(p => Number.isFinite(p[1]));
            if (pts.length < 6) continue;
            const f = fit(pts), s = senSlope(pts), vals = pts.map(p => p[1]);
            const rising = !!s && spanMin >= (opts.minSpanMin || 6) && s.slope >= thr && s.rise >= 0.65;
            rows.push({ session, label, unit, first: round(vals[0], 1), last: round(vals[vals.length - 1], 1), min: round(Math.min(...vals), 1), max: round(Math.max(...vals), 1), slope: s ? round(s.slope, 2) : null, rise: s ? round(s.rise, 2) : null, r2: f ? round(f.r2, 2) : null, spanMin: round(spanMin, 1), rising });
        }
    }
    return rows;
}

// ---- report ----
const pct = v => { if (!Number.isFinite(v)) return ''; const p = Math.round(v * 100); return p === 0 ? '0%' : (p > 0 ? '-' : '+') + Math.abs(p) + '%'; };
const md = (head, rows) => ['| ' + head.join(' | ') + ' |', '|' + head.map(() => '---').join('|') + '|', ...rows.map(r => '| ' + r.join(' | ') + ' |')].join('\n');
const fmtT = s => { s = Math.round(s); const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60); return (h ? h + 'h ' : '') + m + 'm ' + (s % 60) + 's'; };

function buildReport({ run, trials, samples, errors, stalls, checkpoints }) {
    const out = [];
    const T = run.thresholds || DEFAULT_THRESHOLDS;
    const real = trials.filter(t => !t.skipped && !t.repeatOf && t.verdict && t.kind !== 'leak');
    const leaks = trials.filter(t => t.kind === 'leak' && !t.skipped && t.delta);
    const dur = samples.length ? samples[samples.length - 1].t - samples[0].t : 0;
    out.push(`# Perf fuzz report`, '', `- fixture \`${run.fixture}\`, ${run.sessions || 1} session(s), ${fmtT(dur)} of samples, ${real.length} trials (${trials.length - real.length} skipped: nothing to act on), seed ${run.seed}`);
    out.push(`- edge ${run.edge || '?'}, gpu ${run.gpu || '?'}, wasm64 ${run.wasm64}, view ${run.viewport}, commit ${run.commit || '?'}${run.plant ? ', PLANTED slowdown ' + run.plant : ''}`);
    for (const w of run.warnings || []) out.push(`- **WARNING** ${w}`);
    const flagged = real.filter(t => t.verdict.flags.length);
    out.push(`- ${flagged.length} flagged trials (${real.length ? Math.round(flagged.length / real.length * 100) : 0}%), ${real.filter(t => t.recovery && !t.recovery.ok).length} left a persistent slowdown, ${stalls.length} stalls, ${errors.length} distinct page errors`);

    // the short version first
    {
        const confirmed = flagged.filter(t => t.confirmed === true), notRep = flagged.filter(t => t.confirmed === false);
        const rising = trends(samples).filter(r => r.rising), leakSus = leaks.filter(t => t.verdict.flags.length);
        out.push('', '## In short', '');
        // (Single actions and scenarios first: a combination collects the spikes of all its parts.)
        const bySc = (a, b) => b.verdict.score - a.verdict.score;
        const worstSeen = [...flagged.filter(t => t.kind !== 'combo').sort(bySc).slice(0, 5), ...flagged.filter(t => t.kind === 'combo').sort(bySc).slice(0, 2)];
        if (!worstSeen.length) out.push('- No trial crossed a threshold.');
        for (const t of worstSeen) {
            const w = x => Math.max(t.during[x.a][x.b], t.tail[x.a][x.b]), P = t.profile && t.profile.page;
            const cause = P ? (P.tasks && P.tasks[0] ? `its longest task: ${P.tasks[0].total.slice(0, 2).map(f => f.name).join(' > ')}${P.tasks[0].self[0] ? ', self time in ' + P.tasks[0].self[0].name + (P.tasks[0].self[0].via ? ' (from ' + P.tasks[0].self[0].via + ')' : '') : ''}` : P.excess[0] ? `most added: ${P.excess[0].name}${P.excess[0].via ? ' (from ' + P.excess[0].via + ')' : ''}` : 'nothing stands out in the repeat') : 'no profile taken';
            out.push(`- **${t.name}** [${t.verdict.flags.slice(0, 4).join(', ')}] score ${t.verdict.score}${t.confirmed === true ? ', reproduced' : t.confirmed === false ? ', not reproduced' : ''}: gap ${Math.round(w({ a: 'tick', b: 'gapMax' }))} ms, frame ${Math.round(w({ a: 'frame', b: 'max' }))} ms, task ${w({ a: 'long', b: 'max' })} ms; ${cause}`);
        }
        out.push(`- ${flagged.length} flagged trials, ${confirmed.length} reproduced on repeat, ${notRep.length} not reproduced (often first-use work or noise); ${real.filter(t => t.firstUse && t.verdict.score >= 1).length} flagged on the first use of an action.`);
        out.push(rising.length ? `- **Rising** over time: ${rising.map(r => `${r.label} (${r.slope >= 0 ? '+' : ''}${r.slope} ${r.unit ? r.unit + '/min' : 'per min'}, session ${r.session})`).join('; ')}.` : '- Nothing rises steadily over time (memory, handles, DOM, GL objects).');
        if (leaks.length) out.push(leakSus.length ? `- **Leak suspects**: ${leakSus.map(t => t.name.replace(/^leak:/, '') + ' (' + t.verdict.flags.join(', ') + ')').join('; ')}.` : `- ${leaks.length} leak hunts: nothing is held after garbage collection.`);
    }
    // time series
    const tps = samples.map(s => s.tps).filter(Number.isFinite), fps = samples.map(s => s.fps).filter(Number.isFinite);
    const peerTps = samples.flatMap(s => (s.peers || []).map(p => p.tps)).filter(Number.isFinite), peerFps = samples.flatMap(s => (s.peers || []).map(p => p.fps)).filter(Number.isFinite);
    const share = (a, f) => a.length ? Math.round(a.filter(f).length / a.length * 100) + '%' : '';
    out.push('', '## Frame and tick rate over the whole run (2 s samples)', '',
        md(['', 'p5', 'p50', 'p95', 'min', 'below target'], [
            ['TPS', ...[quantile(tps, .05), median(tps), quantile(tps, .95), Math.min(...tps)].map(v => round(v, 1)), `<19: ${share(tps, v => v < 19)}, <15: ${share(tps, v => v < 15)}`],
            ['FPS', ...[quantile(fps, .05), median(fps), quantile(fps, .95), Math.min(...fps)].map(v => round(v, 1)), `<60: ${share(fps, v => v < 60)}, <30: ${share(fps, v => v < 30)}`],
            ...(peerTps.length ? [['TPS of the other players', ...[quantile(peerTps, .05), median(peerTps), quantile(peerTps, .95), Math.min(...peerTps)].map(v => round(v, 1)), `<19: ${share(peerTps, v => v < 19)}, <15: ${share(peerTps, v => v < 15)}`],
                ['FPS of the other players', ...[quantile(peerFps, .05), median(peerFps), quantile(peerFps, .95), Math.min(...peerFps)].map(v => round(v, 1)), `<60: ${share(peerFps, v => v < 60)}, <30: ${share(peerFps, v => v < 30)}`]] : [])]));

    // actions
    const head = ['action', 'n', 'flag', 'persist', 'TPS med', 'TPS p90', 'TPS worst', 'FPS med', 'FPS p90', 'FPS worst', 'gap ms', 'frame ms', 'task ms', 'handler ms', 'sim x', 'score', 'max', 'recover ms'];
    const row = r => [r.key, r.n, r.flagged, r.persistent, pct(r.dTpsMed), pct(r.dTpsP90), pct(r.dTpsWorst), pct(r.dFpsMed), pct(r.dFpsP90), pct(r.dFpsWorst), r.gapWorst, r.frameWorst, r.longWorst, r.handlerWorst, r.simRatioMed, r.scoreMean, r.scoreMax, r.recoverMsMed];
    out.push('', '## What each action does to TPS / FPS', '', 'Drops are of the tail window (the state the action leaves, `+` is a gain) against the reference taken just before; gap/frame/task/handler are the worst single values seen (ms). Sorted by mean score; a score of 1 is the flag threshold.', '',
        md(head, groupStats(real, t => t.name).map(row)));
    const cats = groupStats(real, t => t.cat);
    out.push('', '## By category', '', md(head.map((h, i) => i === 0 ? 'category' : h), cats.map(row)));

    // what one player's actions do to the others (multiplayer)
    if (real.some(t => t.peers && t.peers.length)) {
        const flat = []; for (const t of real) for (const p of t.peers || []) flat.push({ ...t, verdict: p.verdict, during: p.during, tail: p.tail, base: p.base, name: t.name, ref: p.verdict && t.ref });
        out.push('', "## What one player's actions do to the other players (their own calm window before each trial is the reference)", '', md(head, groupStats(flat, t => t.name).map(row)));
    }
    // contexts
    const ctxRows = [];
    const dim = (label, f) => { for (const r of groupStats(real.filter(t => t.kind !== 'scenario' || true), f)) ctxRows.push({ ...r, key: label + ' ' + r.key }); };
    dim('view', t => t.ctx && t.ctx.view); dim('zoom', t => t.ctx && t.ctx.zoomClass); dim('selection', t => t.ctx && t.ctx.selClass);
    out.push('', '## Does the context matter? (trials grouped by the state they started in)', '', md(head.map((h, i) => i === 0 ? 'context' : h), ctxRows.map(row)));

    const costs = stateCosts(real);
    out.push('', '## What holding a state costs (the calm window before each trial, medians)', '', "Not an action's effect: the match as it runs with that view, zoom, selection or popup, against the idle reference.", '',
        md(['state', 'n', 'FPS', 'TPS', 'frame p95 ms', 'render work ms', 'sim ms', 'tick gap p95', 'FPS vs idle'], costs.map(r => [r.key, r.n, r.fps, r.tps, r.frameP95, r.work, r.sim, r.gap, pct(r.vsIdleFps)])));
    const sets = settingsTable(real).filter(r => r.spread >= 0.1).slice(0, 12);
    if (sets.length) out.push('', "## Settings seen with different frame rates (spread of the median FPS between the setting's values)", '', md(['setting', 'spread', 'values: n, FPS, TPS, frame p95'], sets.map(r => [r.key, Math.round(r.spread * 100) + '%', r.per.map(p => `${p.v}: ${p.n}, ${round(p.fps, 1)}, ${round(p.tps, 1)}, ${round(p.p95, 1)}`).join(' | ')])));

    // worst trials
    const worst = real.slice().sort((a, b) => b.verdict.score - a.verdict.score).slice(0, 25).filter(t => t.verdict.score >= 1);
    out.push('', `## Worst trials (score >= 1, ${worst.length} shown)`, '');
    for (const t of worst) {
        out.push(`- **#${t.id} ${t.name}** score ${t.verdict.score} [${t.verdict.flags.join(', ')}]${t.confirmed === true ? ' (confirmed on repeat)' : t.confirmed === false ? ' (not reproduced)' : ''} - session ${t.session}, ${fmtT(t.at)} in, view ${t.ctx.view}, zoom x${t.ctx.zoomRel}, selected ${t.ctx.sel}, units ${t.ctx.units}`);
        out.push(`  - steps: ${t.steps.map(s => s.name + (s.note ? ' (' + s.note + ')' : '') + (s.ms ? ' ' + s.ms + 'ms' : '')).join(' > ')}`);
        out.push(`  - ref tps ${round(t.ref.tps, 1)} fps ${round(t.ref.fps, 1)} sim ${round(t.ref.sim, 1)} ms | tail tps ${t.tail.tps} fps ${t.tail.fps} sim ${t.tail.sim.mean} ms gap ${t.tail.tick.gapMax} frame ${t.tail.frame.max} task ${t.tail.long.max} handler ${t.tail.input.handlerMax} | during gap ${t.during.tick.gapMax} frame ${t.during.frame.max} task ${t.during.long.max} handler ${t.during.input.handlerMax}${t.recovery && !t.recovery.ok ? ' | NOT RECOVERED after ' + Math.round(t.recovery.ms / 1000) + ' s' : ''}`);
        if (t.profile && t.profile.page) {
            const P = t.profile, fn = f => `${f.name} +${f.ms}ms${f.via ? ' (from ' + f.via + ')' : ''}`;
            out.push(`  - profile of the repeat (${P.dir}): page busy ${P.page.totals.busyMs} ms of ${P.page.totals.spanMs} (idle control ${P.page.controlTotals.busyMs}), gc ${P.page.totals.gcMs} ms`);
            out.push(`    - page, beyond the idle control: ${P.page.excess.slice(0, 6).map(fn).join('; ') || '(nothing above 2 ms)'}`);
            out.push(`    - page, most self time: ${P.page.top.slice(0, 4).map(f => `${f.name} ${f.ms}ms${f.via ? ' (from ' + f.via + ')' : ''}`).join('; ')}`);
            for (const k of (P.page.tasks || [])) out.push(`    - a ${k.ms} ms main-thread task: self ${k.self.slice(0, 4).map(f => `${f.name} ${f.ms}ms`).join('; ')} | inclusive ${k.total.slice(0, 5).map(f => `${f.name} ${f.ms}ms`).join('; ')}`);
            for (const w of (P.workers || []).slice(0, 4)) out.push(`    - ${w.name}: busy ${w.busyMs} ms (control ${w.ctlBusyMs}); beyond control: ${w.excess.slice(0, 4).map(fn).join('; ') || '-'}`);
            if (P.helpers) out.push(`    - ${P.helpers.n} helper threads: busy ${P.helpers.busyMs} ms in total (control ${P.helpers.ctlBusyMs})`);
        }
    }
    // first uses
    const first = real.filter(t => t.firstUse && t.verdict.score >= 1).sort((a, b) => b.verdict.score - a.verdict.score).slice(0, 10);
    if (first.length) { out.push('', '## First-use spikes (the first time an action ran in a session: one-time work belongs in the loading phase)', ''); for (const t of first) out.push(`- ${t.name} (new in the session: ${(t.firstUseOf || [t.name]).join(', ')}) score ${t.verdict.score} [${t.verdict.flags.join(', ')}] gap ${Math.max(t.during.tick.gapMax, t.tail.tick.gapMax)} frame ${Math.max(t.during.frame.max, t.tail.frame.max)} task ${Math.max(t.during.long.max, t.tail.long.max)}`); }

    // idle checkpoints
    if (checkpoints.length) {
        out.push('', '## Idle checkpoints (no input; the trend of the match itself)', '', md(['at', 'session', 'units', 'TPS', 'FPS', 'sim ms', 'ms/1k units', 'wasm live MB', 'private MB'],
            checkpoints.map(k => [fmtT(k.at), k.session, k.units, k.win.tps, k.win.fps, k.win.sim.mean, k.units > 0 ? round(k.win.sim.mean / (k.units / 1000), 2) : '', k.wasmLive ?? '', k.priv ?? ''])));
    }

    if (leaks.length) {
        const f = v => v === undefined || v === null ? '' : v;
        out.push('', '## Leak hunts (one action repeated after a warm-up round; what the garbage collector left, after the repeats)', '', 'Growth of what is still held once the page and every worker have collected garbage and the panels have stopped updating. A hunt is flagged when a count grows by about one per repeat or a size grows by tens of MB in a first measured round and again in a second one.', '',
            md(['action', 'player', 'reps', 'DOM nodes', 'listeners', 'ArrayBuffers', 'GL objects', 'page JS MB', 'workers JS MB', 'wasm live MB', 'wasm mem MB', 'private MB', 'GPU proc MB', 'flags'],
                leaks.sort((a, b) => b.verdict.flags.length - a.verdict.flags.length).map(t => [t.name.replace(/^leak:/, ''), t.player || '', t.done, f(t.delta.nodes), f(t.delta.listeners), f(t.delta.arrayBuffers), f(t.delta.glObjects), f(t.delta.jsPage), f(t.delta.jsWorkers), f(t.delta.wasmLive), f(t.delta.wasmMem), f(t.delta.priv), f(t.delta.privGpu), (t.verdict.flags.length ? '**' + t.verdict.flags.join(', ') + '**' : '') + (t.unconfirmed && t.unconfirmed.length ? ' (not again in a second round: ' + t.unconfirmed.join(', ') + ')' : '')])));
    }
    // memory
    const tr = trends(samples);
    out.push('', '## Memory and resource trends (per session, after 3 minutes of warm-up)', '', 'Slope per minute is the median of the slopes between pairs of samples (Theil-Sen: a sawtooth, a step or a few wild samples do not move it), `rises` the share of pairs that go up; `rising` marks a steady climb (at least 65 % of pairs up) above the metric\'s threshold: look at those first.', '',
        md(['session', 'metric', 'first', 'last', 'min', 'max', 'slope/min', 'rises', 'span min', ''], tr.map(r => [r.session, r.label + (r.unit ? ' (' + r.unit + ')' : ''), r.first, r.last, r.min, r.max, r.slope, r.rise, r.spanMin, r.rising ? '**rising**' : ''])));

    if (stalls.length) {
        out.push('', '## Incidents (a page that died, a wait for ticks, a desync)', '');
        for (const s of stalls) {
            const who = s.player ? ' [' + s.player + ']' : '', where = `session ${s.session} at ${fmtT(s.at)}`;
            if (s.kind === 'crash' || s.crash) out.push(`- **PAGE CRASH**${who} ${where} during ${s.last}; ${JSON.stringify(s.sample || {})}`);
            else if (s.kind === 'desync') out.push(`- **DESYNC**${who} ${where}: ${s.count} so far; last steps: ${s.last}`);
            else if (s.kind === 'mismatch') out.push(`- **TICK HASH MISMATCH** ${where}: ${s.mismatched} of ${s.compared} compared ticks differ, first at tick ${s.firstBad}; last steps: ${s.last}`);
            else if (s.kind === 'memory') out.push(`- **MACHINE OUT OF MEMORY** ${where}: ${s.availMB} MB available, browser private ${s.priv} MB (the session was ended)`);
            else if (s.kind === 'hang') out.push(`- **PAGE NOT ANSWERING** ${where}: about ${Math.round(s.ms / 1000)} s; last steps: ${s.last}`);
            else if (s.kind === 'stop') out.push(`- **FATAL LOCKSTEP STOP**${who} ${where}; last steps: ${s.last}`);
            else out.push(`- stall ${where}: ${Math.round(s.ms)} ms without a tick; last steps: ${s.last}; ${s.resolved ? 'recovered' : 'NOT recovered (session restarted)'}`);
        }
    }
    if (errors.length) { out.push('', '## Page errors', ''); for (const e of errors.slice(0, 30)) out.push(`- x${e.count} \`${e.text.slice(0, 200)}\` first after: ${e.after || '?'}`); }
    return out.join('\n') + '\n';
}

// The match's own cost by state, from the calm windows taken before each trial (what holding that state costs, not what an action added).
function stateCosts(trials) {
    const by = new Map();
    const add = (key, t) => { (by.get(key) || by.set(key, []).get(key)).push(t); };
    for (const t of trials) {
        if (!t.base || !t.ctx) continue;
        add('view ' + t.ctx.view, t); add('zoom ' + t.ctx.zoomClass, t); add('selection ' + t.ctx.selClass, t);
        if (t.ctx.popups) add('a popup open', t);
    }
    const rows = [];
    for (const [key, list] of by) {
        if (list.length < 3) continue;
        const m = f => median(list.map(f).filter(Number.isFinite));
        rows.push({ key, n: list.length, fps: round(m(t => t.base.fps), 1), tps: round(m(t => t.base.tps), 1), frameP95: round(m(t => t.base.frame.p95), 1), work: round(m(t => t.base.work.mean), 2), sim: round(m(t => t.base.sim.mean), 1), gap: round(m(t => t.base.tick.gapP95), 0), vsIdleFps: round(m(t => t.vsIdle && t.vsIdle.dFps), 3) });
    }
    return rows.sort((a, b) => a.key.localeCompare(b.key));
}
// Each setting's values against the calm windows seen with them (settings trials move them at random): which one costs frames.
function settingsTable(trials) {
    const keys = new Set();
    for (const t of trials) if (t.ctx && t.ctx.settings) for (const k of Object.keys(t.ctx.settings)) keys.add(k);
    const rows = [];
    for (const k of keys) {
        const by = new Map();
        for (const t of trials) { if (!t.base || !t.ctx || !t.ctx.settings || t.ctx.prelude) continue; const v = String(t.ctx.settings[k]); (by.get(v) || by.set(v, []).get(v)).push(t); }
        const vals = [...by].filter(([, l]) => l.length >= 3);
        if (vals.length < 2) continue;
        const per = vals.map(([v, l]) => ({ v, n: l.length, fps: median(l.map(t => t.base.fps)), tps: median(l.map(t => t.base.tps)), p95: median(l.map(t => t.base.frame.p95)) }));
        const hi = Math.max(...per.map(p => p.fps)), lo = Math.min(...per.map(p => p.fps));
        rows.push({ key: k, spread: hi > 0 ? round((hi - lo) / hi, 3) : 0, per });
    }
    return rows.sort((a, b) => b.spread - a.spread);
}

module.exports = { stateCosts, settingsTable, DEFAULT_THRESHOLDS, makeRef, judge, judgeTrial, groupStats, trends, buildReport, fit, fmtT };
