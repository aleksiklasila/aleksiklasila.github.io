// Page probe (scene_tps_probe.cjs PAGEEVAL=@tests/probes/present-phases.js):
// the presentation worker's frames so far (sim_client.js presentationSums):
// how many, mean build ms and its phases (motion copy, ranges (fill, ghosts,
// marks), the id order, the rest (buckets, marks' copy, tables)), the largest.
(() => {
    const c = typeof _simClient !== 'undefined' ? _simClient : null, S = c && c.presentationSums;
    if (!S || !S[0]) return { frames: 0 };
    const m = i => +(S[i] / S[0]).toFixed(2);
    return { frames: S[0], buildMs: m(1), copy: m(2), ranges: m(3), order: m(4), rest: m(5), maxMs: +S[6].toFixed(1) };
})()
