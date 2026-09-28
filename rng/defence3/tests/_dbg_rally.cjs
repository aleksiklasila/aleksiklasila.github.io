const H = require('./net-harness.cjs');
(async () => {
    const world = new H.World({ network: { latencyMs: 20, jitterMs: 2 }, controls: { ...H.SMALL_MATCH_CONTROLS, 'cfg-mapsize': '30', 'cfg-full-vis': 'all' }, hashEvery: 100000 });
    const { host } = await H.startHostedMatch(world, { guests: 1, maxMs: 60000 });
    host.eval(`(() => { const k = units.find(u => u.owner === 0 && u.isKing); __scratch.k = k.id; __scratch.trace = [];
        const o = runOneTick; runOneTick = function () { const r = o.apply(this, arguments); const k = units.find(u => u.id === __scratch.k); if (k) __scratch.trace.push([currentTick, +k.x.toFixed(2), +k.y.toFixed(2), k.pathIndex, k.path ? k.path.length : 0, k.commandState]); return r; }; })()`);
    for (let i = 0; i < 8; i++) {
        host.eval(`(() => { const k = units.find(u => u.id === __scratch.k); queueAction({ action: 'move', unitIds: [k.id], targetX: k.x + ${(i % 3) * 7 - 7}, targetY: k.y - 90 }); })()`);
        await world.run(350);
    }
    await world.run(1000);
    const tr = JSON.parse(host.eval('JSON.stringify(__scratch.trace)'));
    let prev = null;
    for (const r of tr) { const d = prev ? [+(r[1] - prev[1]).toFixed(2), +(r[2] - prev[2]).toFixed(2)] : [0, 0]; console.log(r.join(' '), ' d', d.join(',')); prev = r; }
    process.exit(0);
})();
