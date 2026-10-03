// Summary of a tickbench output: tick stats, ticks over 50 ms (whole
// tick), steady means of the phases (ticks >= FROM, default 80), and the
// phases of the heaviest ticks.  node .claude/rsum.cjs file [from]
const s = require('fs').readFileSync(process.argv[2], 'utf8'), j = JSON.parse(s.slice(s.indexOf('{"ticks"')));
const from = Number(process.argv[3]) || 80;
const byTick = Object.fromEntries(j.heaviest || []);
console.log({ ticks: j.ticks, mean: j.meanMs, p50: j.p50, p95: j.p95, max: j.max, desyncs: j.desyncs, patches: j.patches });
const ph = j.phases || {}, agg = {}; let n = 0, over = 0, tot = 0;
for (const [t, r] of Object.entries(ph)) { const w = (r.gameTick || 0) + (r.processActions || 0) + (r.resyncAfterTick || 0); tot++; if (w > 50) over++; if (t < from) continue; n++; for (const [k, v] of Object.entries(r)) agg[k] = (agg[k] || 0) + v; }
console.log('ticks with gameTick+actions+resync > 50:', over, 'of', tot);
console.log('steady (t >= ' + from + '):', Object.entries(agg).sort((a, b) => b[1] - a[1]).slice(0, 16).map(([k, v]) => k + ':' + (v / n).toFixed(1)).join(' '));
for (const [t, ms] of (j.heaviest || []).slice(0, 6)) { const r = ph[t] || {}; console.log(t, ms, Object.entries(r).filter(([k]) => k !== 'gameTick').sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, v]) => k + ':' + v.toFixed(1)).join(' ')); }
if (j.ktime) console.log('ktime', JSON.stringify(j.ktime));
