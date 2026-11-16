// DUMP script for .claude/scene_tps_probe.cjs (function body, page side): the
// simtrace rows as simtrace-dump.js prints them (SIMTRACE line), then the
// presentation's sums on a PRES line: frames shown, their build ms (sum,
// largest), the page's presentationSums phases, the last frame's pace and
// threads (presentation_worker.js phases 4, 5).
const T = window.__simTrace || [];
const rows = T.map(r => {
    const ph = {};
    for (const [k, v] of Object.entries(r.ph || {})) if (typeof v === 'number' ? v >= 0.3 : v != null) ph[k] = typeof v === 'number' ? Math.round(v * 100) / 100 : v;
    return { tick: r.tick, dk: r.dk, total: Math.round(r.total * 100) / 100, gap: Math.round((r.gap || 0) * 10) / 10, late: Math.round((r.late || 0) * 10) / 10, ph };
});
let pres = null;
try {
    const c = typeof _simClient !== 'undefined' ? _simClient : null, S = c && c.presentationSums, P = c && c.presentationPhases;
    if (S) pres = { frames: S[0], buildMs: Math.round(S[1]), buildMean: Math.round(S[1] / Math.max(1, S[0]) * 100) / 100, buildMax: Math.round(S[6] * 10) / 10,
        phaseMean: [2, 3, 4, 5].map(i => Math.round(S[i] / Math.max(1, S[0]) * 100) / 100), pace: P ? P[5] : null, threads: P ? P[4] : null, tick: c.presentationTick };
} catch (e) { pres = { error: String(e) }; }
return 'SIMTRACE ' + JSON.stringify(rows) + '\nPRES ' + JSON.stringify(pres);
