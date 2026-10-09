(() => {
    const now = __scratch.realNow || (() => Date.now());
    const c = _snapStaticSlices();
    const kinds = {}, tf = {}, tc = {};
    let n = 0;
    for (const m of c) for (const en of m.values()) {
        const e = en[0], k = en[1] + ':' + (e.constructor && e.constructor.name) + ':' + (e.type || '');
        kinds[k] = (kinds[k] || 0) + 1; n++;
        let t0 = now();
        for (let r = 0; r < 4; r++) _snapHashers[en[1]](e, en[2], _snapF64, _snapI32, _snapHV, _snapHPath);
        tf[k] = (tf[k] || 0) + (now() - t0) / 4;
        t0 = now();
        for (let r = 0; r < 4; r++) _snapStaticCore(e, en[1], en[2]);
        tc[k] = (tc[k] || 0) + (now() - t0) / 4;
    }
    const r3 = v => Math.round(v * 1000) / 1000;
    const per = {};
    for (const k in kinds) per[k] = [kinds[k], r3(tf[k]), r3(tc[k])];
    const h = snapGetTickHash(currentTick - 1) || snapGetTickHash(currentTick - 2);
    let t0 = now(); const hh = snapTickHash(currentTick); const tAll = now() - t0;
    let res = 0; if (workerReservedTiles) for (let i = 0; i < workerReservedTiles.length; i++) if (workerReservedTiles[i]) res++;
    return JSON.stringify({ staticN: n, per, pairsLast: h ? h.pairs.length / 2 : -1, pairsNow: hh.pairs.length / 2, tHash: r3(tAll),
        reservations: res, resTable: workerReservedTiles ? workerReservedTiles.length : 0, drops: droppedItems.length, projectiles: projectiles.length,
        grid: GRID_W + 'x' + GRID_H, regionTiles: SNAP_REGION_TILES, players: players.length });
})()
