// Debug: who invalidates the prebuilt unit index between ticks.
const H = require('./net-harness.cjs');
(async () => {
    const world = new H.World({ controls: { ...H.SMALL_MATCH_CONTROLS, 'cfg-mapsize': '60' } });
    const { host, guests } = await H.startHostedMatch(world, { guests: 1, maxMs: 30000 });
    for (const p of [host, ...guests]) p.eval(`SPATIAL_PARALLEL_MIN_UNITS = 0; __scratch.inv = {}; __scratch.taken = 0; __scratch.dropped = 0;
        { const f = spatialIndexInvalidate; spatialIndexInvalidate = function () { if (_sxPre) { const k = (new Error().stack || '').split(String.fromCharCode(10)).slice(2, 6).map(l => l.trim().split(' ')[1]).join(' < '); __scratch.inv[k] = (__scratch.inv[k] || 0) + 1; } return f.apply(this, arguments); }; }
        { const g = _spatialIndexCollect; _spatialIndexCollect = function () { const r = g.apply(this, arguments); if (_sxTaken) __scratch.taken++; else __scratch.dropped++; return r; }; }`);
    for (let k = 0; k < 20; k++) { for (const p of [host, ...guests]) p.eval(H.issueRandomCommand ? '0' : '0'); await world.run(250); }
    for (const p of [host, ...guests]) console.log(p.name, p.eval('JSON.stringify({ taken: __scratch.taken, dropped: __scratch.dropped, inv: __scratch.inv })'));
    process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
