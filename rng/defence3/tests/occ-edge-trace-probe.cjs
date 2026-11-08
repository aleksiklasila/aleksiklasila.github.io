'use strict';
// The occupancy movement (kernel 89) in real Edge on an idle scene: the
// worker's ?simtrace=1 rows over SECS seconds, per tick the kernel's wall
// (kp:89), its tail wait, its longest chunk, the jobs' summed time (cpu:89)
// and the jobs over 2 ms with their blocks' unit counts (slow:89): whether a
// slow job is a dense block (many units) or a stalled thread (few).
//   node tests/occ-edge-trace-probe.cjs [scene under tests/] [secs=40]   (HEADED=1, URLQ=..., OUT=file.json)
const fs = require('node:fs');
const path = require('node:path');
const { loadPlaywright, startServer, sleep } = require('./perf-fuzz/env.cjs');
const fixture = process.argv[2] || 'scenes/chaos-1m-250k.gz';
const secs = Number(process.argv[3]) || 40;
const out = process.env.OUT ? path.resolve(process.env.OUT) : '';
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * p))] : 0; };
(async () => {
    const { server, base } = await startServer();
    let browser;
    try {
        browser = await loadPlaywright().chromium.launch({ channel: 'msedge', headless: !process.env.HEADED });
        const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
        const errors = [];
        page.on('pageerror', e => errors.push(e.message));
        await page.goto(base + '/index.html?simtrace=1' + (process.env.URLQ ? '&' + process.env.URLQ : ''), { waitUntil: 'load', timeout: 120000 });
        await page.evaluate(async f => { await restoreSoloGameSnapshot(await readSoloGameSnapshotFile(await (await fetch('tests/' + f)).blob())); }, fixture);
        await page.waitForFunction(() => typeof simClientStats === 'function' && simClientStats().appliedTick >= 5, {}, { timeout: 600000 });
        await sleep(8000);
        await page.evaluate(() => { window.__simTrace = []; });
        await sleep(secs * 1000);
        const trace = await page.evaluate(() => window.__simTrace || []);
        const rows = trace.filter(r => r.ph && r.ph['kp:89']);
        const r1 = x => Math.round(x * 10) / 10;
        const col = k => rows.map(r => r.ph[k] || 0);
        // The page has no simulation units in worker mode; its units.length
        // reports zero. Read the actual population from the simulation worker.
        const worker = page.workers().find(w => /sim_worker\.js/.test(w.url()));
        const population = worker ? await worker.evaluate(() => units.length) : null;
        console.log('ticks', rows.length, 'units', population);
        for (const k of ['kp:89', 'tail:89', 'chunkMax:89', 'cpu:89', 'n:89', 'kp:8', 'simMoveRun']) { const v = col(k); console.log(k.padEnd(12), 'p50', r1(pct(v, .5)), 'p95', r1(pct(v, .95)), 'max', r1(pct(v, 1))); }
        const totals = rows.map(r => r.total); console.log('tick total'.padEnd(12), 'p50', r1(pct(totals, .5)), 'p95', r1(pct(totals, .95)), 'max', r1(pct(totals, 1)));
        const slow = rows.flatMap(r => r.ph['slow:89'] || []);
        slow.sort((a, b) => b[0] - a[0]);
        console.log('jobs over 2 ms', slow.length, 'in', rows.length, 'ticks; slowest [ms, units]', JSON.stringify(slow.slice(0, 25)));
        const byU = [[0, 32], [33, 128], [129, 512], [513, 1e9]].map(([a, b]) => [a + '-' + b, slow.filter(s => s[1] >= a && s[1] <= b).length]);
        console.log('slow jobs by units', JSON.stringify(byU));
        console.log('errors', JSON.stringify(errors.slice(0, 3)));
        if (out) fs.writeFileSync(out, JSON.stringify(rows));
    } finally {
        if (browser) await browser.close();
        server.close();
    }
    process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
