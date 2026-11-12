'use strict';
// The occupancy movement's schedule (kernel 89, one job per spatial block in
// four colour phases): a solo scene restored with real helpers, WARM ticks,
// then TICKS ticks with every job's measured time (par.ctrace, trace-only).
// Per tick: the phases' measured walls, and three schedules simulated from
// the same job times on THREADS threads:
//   barrier  - each phase's list claimed in order, the next phase after the
//              last job (what runs now);
//   inorder  - one list of all phases, claimed in order, a job starting once
//              its lower-phase neighbours finished (the claimer waits);
//   ready    - the same dependencies, a free thread takes the first listed
//              job whose neighbours are done (a ready queue).
// Also: the heaviest job, the work sum / threads (the floor) and the longest
// dependency chain (the other floor).
// PROF=prefix: helper CPU profiles of the measured ticks.
// Usage: node --max-old-space-size=14000 tests/occ-sched-probe.cjs [scene.gz] [helpers] [ticks] [out.json]
const path = require('node:path'), fs = require('node:fs');
globalThis.self = { crossOriginIsolated: true };
const H = require('./net-harness.cjs');
const scene = path.resolve(process.argv[2] || path.join(__dirname, 'scenes/chaos-1m-250k.gz'));
const helpers = process.argv[3] !== undefined ? Number(process.argv[3]) : 11, N = Number(process.argv[4]) || 30, WARM = Number(process.env.WARM) || 15;
const out = process.argv[5] || '';
(async () => {
    const controls = { ...H.SMALL_MATCH_CONTROLS };
    const world = new H.World({ controls, hashEvery: 1e9 });
    const host = world.spawn('host', { controls, simWorker: false });
    host.scratch.records = JSON.parse(require('node:zlib').gunzipSync(fs.readFileSync(scene)));
    host.scratch.scene = host.eval('(() => { const r = soloSceneReader(); for (const a of __scratch.records) r.line(JSON.stringify(a)); return r.finish(); })()');
    host.scratch.records = null;
    host.eval('document.getElementById("starting-resources-popup").classList.add("hidden")');
    let done = false, error;
    host.eval('restoreSoloGameSnapshot(__scratch.scene)').then(() => done = true, e => { done = true; error = e; });
    while (!done) await world.run(20);
    if (error) throw error;
    host.scratch.scene = null;
    host.scratch.Worker = require('./real-sim-helper.cjs');
    host.eval(`Worker = __scratch.Worker; navigator.hardwareConcurrency = 32; simParallelInit('', ${helpers})`);
    // DK=n: n base ticks a step (as play at low TPS).
    if (process.env.DK) host.eval('simDk=' + Number(process.env.DK) + ';netStepTicks=()=>' + Number(process.env.DK));
    for (let i = 0; i < WARM; i++) host.eval('gameTick()');
    host.eval(`{ __scratch.ct = simHeapArray(Float64Array, 32768); simParallelBind('par.ctrace', __scratch.ct); __scratch.rec = [];
        const pr = simParallelRun; simParallelRun = function (kk, n) {
            if (kk !== SIM_KERNEL_MOVE_OCCUPANCY) return pr.apply(this, arguments);
            const T = __scratch.ct; T.fill(-1, 0, n * 2);
            const a = performance.now(); try { return pr.apply(this, arguments); } finally {
                const wall = performance.now() - a, J = _occ.jobs, F = _occ.offsets, ph = _simParams[4], at = 8 + J[ph], r = { ph, wall, b: [], d: [], s: [], u: [] };
                for (let c = 0; c < n; c++) { const j = J[at + c]; r.b.push(j); r.d.push(T[c * 2 + 1]); r.s.push(T[c * 2]); r.u.push(F[j + 1] - F[j]); }
                __scratch.rec.push(r);
            } };
    }`);
    // PROF=prefix: the helpers' CPU profiles over the measured ticks (prefix.helperN.cpuprofile).
    const profHelpers = process.env.PROF ? (require('./real-sim-helper.cjs').instances || []) : [];
    if (profHelpers.length) await Promise.all(profHelpers.map(w => w.benchProfile('start', 200)));
    const ticks = [];
    for (let i = 0; i < N; i++) {
        host.eval('_simParTrace = {}; __scratch.rec = []');
        const a = performance.now(); host.eval('gameTick()'); const ms = performance.now() - a;
        ticks.push({ ms, phases: JSON.parse(host.eval('JSON.stringify(__scratch.rec)')) });
    }
    if (profHelpers.length) await Promise.all(profHelpers.map(async (w, i) => { const r = await w.benchProfile('stop'); fs.writeFileSync(process.env.PROF + '.helper' + i + '.cpuprofile', JSON.stringify(r.profile)); }));
    const bw = host.eval('_occ.config[5]'), bh = host.eval('_occ.config[6]');
    host.eval('_simParTrace = null');
    const threads = helpers + 1;
    const sim = (t) => {
        // Jobs in list order (phase, then heaviest first), their deps: listed lower-phase neighbours.
        const jobs = [], at = new Map();
        for (const p of t.phases) for (let i = 0; i < p.b.length; i++) { at.set(p.b[i], jobs.length); jobs.push({ b: p.b[i], ph: p.ph, d: Math.max(0, p.d[i]), u: p.u[i] }); }
        for (const j of jobs) {
            j.dep = []; const bx = j.b % bw, by = (j.b / bw) | 0;
            for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
                if (!dx && !dy) continue; const x = bx + dx, y = by + dy; if (x < 0 || y < 0 || x >= bw || y >= bh) continue;
                const k = at.get(y * bw + x); if (k !== undefined && jobs[k].ph < j.ph) j.dep.push(k);
            }
        }
        // barrier
        let barrier = 0;
        for (let ph = 0; ph < 4; ph++) { const free = new Array(threads).fill(0); for (const j of jobs) if (j.ph === ph) { let m = 0; for (let k = 1; k < threads; k++) if (free[k] < free[m]) m = k; free[m] += j.d; } barrier += Math.max(...free); }
        // inorder
        const fin = new Array(jobs.length).fill(0);
        { const free = new Array(threads).fill(0); for (let i = 0; i < jobs.length; i++) { let m = 0; for (let k = 1; k < threads; k++) if (free[k] < free[m]) m = k; let st = free[m]; for (const k of jobs[i].dep) st = Math.max(st, fin[k]); fin[i] = st + jobs[i].d; free[m] = fin[i]; } }
        const inorder = Math.max(0, ...fin);
        // ready
        const fr = new Array(jobs.length).fill(-1); let ready = 0;
        { const free = new Array(threads).fill(0), taken = new Array(jobs.length).fill(false); let left = jobs.length, first = 0;
          while (left) { let m = 0; for (let k = 1; k < threads; k++) if (free[k] < free[m]) m = k; const now = free[m];
            let pick = -1, soonest = Infinity;
            while (first < jobs.length && taken[first]) first++;
            for (let i = first; i < jobs.length; i++) { if (taken[i]) continue; let ok = true, rt = 0; for (const k of jobs[i].dep) { if (fr[k] < 0) { ok = false; break; } rt = Math.max(rt, fr[k]); } if (!ok) continue; if (rt <= now) { pick = i; break; } if (rt < soonest) soonest = rt; }
            if (pick < 0) { free[m] = soonest === Infinity ? Math.min(...free.filter(v => v > now)) : soonest; continue; }
            taken[pick] = true; left--; fr[pick] = now + jobs[pick].d; free[m] = fr[pick]; }
          ready = Math.max(0, ...fr); }
        // floors
        const work = jobs.reduce((s, j) => s + j.d, 0), cp = new Array(jobs.length).fill(0);
        for (let i = 0; i < jobs.length; i++) { let st = 0; for (const k of jobs[i].dep) st = Math.max(st, cp[k]); cp[i] = st + jobs[i].d; }
        const units = jobs.reduce((s, j) => s + j.u, 0), heavy = jobs.reduce((a, j) => j.d > a.d ? j : a, { d: 0 });
        return { measured: t.phases.reduce((s, p) => s + p.wall, 0), barrier, inorder, ready, floorWork: work / threads, chain: Math.max(0, ...cp), heavy: heavy.d, heavyUnits: heavy.u, jobs: jobs.length, units, usPerUnit: work * 1000 / Math.max(1, units) };
    };
    const rows = ticks.map(sim), r1 = x => Math.round(x * 10) / 10;
    console.log('blocks', bw, 'x', bh, 'threads', threads);
    console.log('tick  measured barrier inorder ready  work/T chain heavy(units) jobs us/unit');
    rows.forEach((r, i) => console.log(String(i).padStart(4), ...[r.measured, r.barrier, r.inorder, r.ready, r.floorWork, r.chain].map(v => String(r1(v)).padStart(7)), String(r1(r.heavy)).padStart(6) + '(' + r.heavyUnits + ')', r.jobs, r1(r.usPerUnit)));
    const q = (k, p) => { const v = rows.map(r => r[k]).sort((a, b) => a - b); return r1(v[Math.min(v.length - 1, Math.floor(p * v.length))]); };
    for (const k of ['measured', 'barrier', 'inorder', 'ready', 'floorWork', 'chain', 'heavy']) console.log(k.padEnd(10), 'p50', q(k, .5), 'p95', q(k, .95), 'max', q(k, 1));
    // The heaviest jobs' units against time (does a job cost by its units?).
    const all = ticks.flatMap(t => t.phases.flatMap(p => p.d.map((d, i) => [d, p.u[i]]))).sort((a, b) => b[0] - a[0]);
    console.log('heaviest jobs [ms, units]', JSON.stringify(all.slice(0, 12).map(([d, u]) => [r1(d), u])));
    if (out) fs.writeFileSync(out, JSON.stringify({ bw, bh, threads, ticks }));
    process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
