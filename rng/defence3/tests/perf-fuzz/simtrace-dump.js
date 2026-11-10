// DUMP script for .claude/scene_tps_probe.cjs (function body, page side): the
// simulation worker's per-step trace rows (?simtrace=1: tick, total, gap,
// late, phases) as one JSON line, phases under 0.3 ms dropped, prefixed
// SIMTRACE so tests/simtrace-spikes.cjs can find it in the probe's output.
const T = window.__simTrace || [];
return 'SIMTRACE ' + JSON.stringify(T.map(r => {
    const ph = {};
    for (const [k, v] of Object.entries(r.ph || {})) if (typeof v === 'number' ? v >= 0.3 : v != null) ph[k] = typeof v === 'number' ? Math.round(v * 100) / 100 : v;
    return { tick: r.tick, dk: r.dk, total: Math.round(r.total * 100) / 100, gap: Math.round((r.gap || 0) * 10) / 10, late: Math.round((r.late || 0) * 10) / 10, ph };
}));
