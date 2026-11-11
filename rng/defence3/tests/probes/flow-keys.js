// Step probe (chaos-spikes.bench.cjs --step-eval=@tests/probes/flow-keys.js):
// the flow looks posted this step (fl.pend, 8 words a key: id, tile, dest,
// field, kind|profile, build version, local wall version, field generation)
// and how much of them repeat: distinct full keys, distinct keys without
// each version word, and full keys seen the step before.
(() => {
    const L = typeof _flowLooks !== 'undefined' ? _flowLooks : null, R = _simParReg;
    if (!L || !L.posted || !R['fl.pend'] || !R['fl.cnt']) return null;
    const P = R['fl.pend'], C = R['fl.cnt'], PER = typeof SIM_FLOW_PER === 'number' ? SIM_FLOW_PER : 8192;
    const full = new Set(), noVer = new Set(), noWall = new Set(), tileDest = new Set(), vers = new Set(), walls = new Set(), dests = new Set();
    let n = 0;
    for (let j = 0; j < L.jobs; j++) for (let i = 0; i < C[j]; i++) {
        const o = (j * PER + i) * 8, tl = P[o + 1], dk = P[o + 2], kp = P[o + 4], ver = P[o + 5], lwv = P[o + 6];
        n++;
        full.add(tl + ',' + dk + ',' + kp + ',' + ver + ',' + lwv);
        noVer.add(tl + ',' + dk + ',' + kp + ',' + lwv);
        noWall.add(tl + ',' + dk + ',' + kp + ',' + ver);
        tileDest.add(tl + ',' + dk);
        vers.add(ver); walls.add(lwv); dests.add(dk);
    }
    const prev = globalThis.__flowPrevKeys || new Set();
    let again = 0; for (const k of full) if (prev.has(k)) again++;
    globalThis.__flowPrevKeys = full;
    return { n, full: full.size, noVer: noVer.size, noWall: noWall.size, tileDest: tileDest.size, vers: vers.size, walls: walls.size, dests: dests.size, seenLastStep: again };
})()
