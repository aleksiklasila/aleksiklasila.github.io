'use strict';
// The collectors' near fields (k.rs k_ws_nearfield): the fields the search
// tier keeps (updated at each post for the spawners gone and come: mode 3,
// made whole by modes 1 and 2 only when it cannot) equal the one-job whole
// field (mode 0) tile by tile, over rounds of spawners placed and destroyed;
// and the two-stage whole form (modes 1, 2) equals the one-job form.
//   node tests/ws-nearfield-split.test.cjs
const assert = require('node:assert/strict');
const H = require('./net-harness.cjs');
const CONTROLS = { ...H.SMALL_MATCH_CONTROLS, 'cfg-mapsize': '64' };
(async () => {
    const world = new H.World({ controls: CONTROLS });
    const host = world.spawn('host', { controls: CONTROLS, simWorker: false });
    host.eval('startSoloGame();');
    await world.run(4000);
    host.eval(`__scratch.rng = 12345; __scratch.rand = n => { __scratch.rng = (Math.imul(__scratch.rng, 1103515245) + 12345) >>> 0; return __scratch.rng % n; };
    // Every group's fields against the whole form, made now from the arrays of the last post.
    __scratch.compare = () => {
        simParallelBackgroundWait(WS_LANE);
        const out = [];
        for (const G of _wsGroupById) {
            if (!G || !G.arrays.nf || !G.nfList || !G.nfList.length) continue;
            const pairs = G.nfList.map(o => G.id * 16 + o), tiles = GRID_W * GRID_H, P = new Float64Array(64), K = SIM_KERNELS[SIM_KERNEL_WS_NEARFIELD];
            const live = G.arrays.nf.slice(0, pairs.length * tiles);
            P[0] = pairs.length; P[1] = GRID_W; P[2] = GRID_H; P[63] = _wsPostEpoch;
            pairs.forEach((p, i) => { P[3 + i] = p; });
            P[62] = 0;
            for (let c = 0; c < pairs.length; c++) K(_simParReg, P, c);
            const one = G.arrays.nf.slice(0, pairs.length * tiles);
            // (The two-stage whole form, every field flagged to be made whole.)
            const NFA = G.arrays.nfa, keep = [];
            for (let s = 0; s < 16; s++) { keep.push(NFA[s * WS_NFA_W + 2]); NFA[s * WS_NFA_W + 2] = 1; }
            G.arrays.nf.fill(12345, 0, pairs.length * tiles);
            const rowJobs = Math.min(64, GRID_H), colJobs = Math.ceil(GRID_W / WS_NF_COLS), per = Math.max(rowJobs, colJobs);
            P[61] = Math.ceil(GRID_H / rowJobs); P[60] = WS_NF_COLS; P[59] = per;
            for (const mode of [1, 2]) { P[62] = mode; for (let c = 0; c < pairs.length * per; c++) K(_simParReg, P, c); }
            const two = G.arrays.nf.slice(0, pairs.length * tiles);
            for (let s = 0; s < 16; s++) NFA[s * WS_NFA_W + 2] = keep[s];
            G.arrays.nf.set(live);
            let diffLive = 0, diffTwo = 0, reached = 0, first = -1;
            for (let i = 0; i < one.length; i++) {
                if (one[i] !== live[i]) { diffLive++; if (first < 0) first = i; }
                if (one[i] !== two[i]) diffTwo++;
                if (one[i] !== 0xFFFFFFFF) reached++;
            }
            out.push({ group: G.id, pairs: pairs.length, reached, diffLive, diffTwo, first, a: first >= 0 ? one[first] : null, b: first >= 0 ? live[first] : null, full: keep.slice(0, pairs.length) });
        }
        return out;
    };
    __scratch.spawners = () => { const L = []; for (let gy = 0; gy < GRID_H; gy++) for (let gx = 0; gx < GRID_W; gx++) { const t = getTileEntityRef(gx, gy); if (t && t.type === 'spawner' && t.gx === gx && t.gy === gy && !t.dead) L.push(t); } return L; };
    __scratch.place = (n) => {
        let placed = 0;
        for (let tries = 0; tries < 4000 && placed < n; tries++) {
            const gx = 2 + __scratch.rand(GRID_W - 4), gy = 2 + __scratch.rand(GRID_H - 4), c = grid[gy] && grid[gy][gx];
            if (!c || cellType[(c) - 1] !== 0 || cellItemGet(c) || getTileEntityRef(gx, gy)) continue;
            if (placeBuilding(gx, gy, 'spawner', __scratch.rand(2), { ignorePlacementRules: true, silent: true })) { const b = getTileEntityRef(gx, gy); if (b && b.underConstruction) markConstructionComplete(b); placed++; }
        }
        return placed;
    };`);
    host.eval('__scratch.place(12)');
    await world.run(1500);
    const rounds = [];
    for (let r = 0; r < 8; r++) {
        // (Some placed, some destroyed, now and then many at once: the whole form then.)
        const ch = JSON.parse(host.eval(`(() => {
            const many = ${r} === 5, placed = __scratch.place(many ? 20 : 1 + __scratch.rand(3));
            const L = __scratch.spawners(); let gone = 0;
            for (let k = 0; k < (many ? 10 : 1 + __scratch.rand(2)) && L.length > 2; k++) { const i = __scratch.rand(L.length); destroyBuilding(L[i]); L.splice(i, 1); gone++; }
            return JSON.stringify({ placed, gone });
        })()`));
        await world.run(1200);
        const g = JSON.parse(host.eval('JSON.stringify(__scratch.compare())'));
        rounds.push({ ...ch, groups: g });
    }
    console.log(JSON.stringify(rounds.map(r => ({ placed: r.placed, gone: r.gone, g: r.groups.map(x => [x.group, x.pairs, x.reached, x.diffLive, x.diffTwo, x.full.join('')]) }))));
    assert.ok(rounds.some(r => r.groups.length > 0), 'a group with near fields');
    let incremental = 0;
    for (const r of rounds) for (const g of r.groups) {
        assert.ok(g.reached > 0, 'its fields reach tiles');
        assert.equal(g.diffTwo, 0, 'two stages = one (group ' + g.group + ')');
        assert.equal(g.diffLive, 0, 'the kept field = made whole (group ' + g.group + ', first ' + g.first + ': ' + g.a + ' vs ' + g.b + ')');
        incremental += g.full.filter(f => f === 0).length;
    }
    assert.ok(incremental > 0, 'some fields were updated, not made whole');
    console.log('ok: kept near fields = made whole; two stages = one');
    process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
