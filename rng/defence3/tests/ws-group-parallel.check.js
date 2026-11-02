// PRE for tests/chaos-spikes.bench.cjs (needs --helpers): every collectors'
// group built on the helpers (SIM_KERNEL_WS_GROUP) and serially, their output
// arrays compared element by element. Prints "WSG <json>".
//   PRE="$(cat tests/ws-group-parallel.check.js)" node tests/chaos-spikes.bench.cjs --units=100000 --structures=30000 --helpers=4 --ticks=2
(() => {
    const names = ['sx', 'sy', 'st', 'so', 'sready', 'tile', 'qgx', 'qgy', 'qo', 'qid', 'qx', 'qy', 'qready'];
    const res = [];
    for (let k = 0; k < RESOURCE_TYPE_LIST.length && k < 8; k++) {
        const cfg = RESOURCE_TYPE_LIST[k], G1 = { id: 50 + k, key: 'chk1', arrays: {}, n: 0 }, G2 = { id: 60 + k, key: 'chk2', arrays: {}, n: 0 };
        const pool = _simPool;
        // (Twice: the first binds its arrays, which the helpers then take up; the second runs on them.)
        _wsGroupBuild(G1, cfg); _wsGroupBuild(G1, cfg);
        _simPool = null;
        try { _wsGroupBuild(G2, cfg); } finally { _simPool = pool; }
        const cand = _wsCandidates().n;
        let diff = 0, first = null;
        if (G1.n !== G2.n || G1.np !== G2.np) diff++;
        for (const nm of names) {
            const a = G1.arrays[nm], b = G2.arrays[nm], len = nm[0] === 'q' ? G2.np : G2.n;
            for (let i = 0; i < len; i++) if (!Object.is(a[i], b[i])) { diff++; if (!first) first = nm + '[' + i + '] ' + a[i] + ' vs ' + b[i]; }
        }
        res.push({ type: cfg.collectorUnitKey, candidates: cand, sites: G2.n, spawners: G2.np, parallelSites: G1.n, parallelSpawners: G1.np, diff, first });
    }
    return 'WSG ' + JSON.stringify(res);
})();
