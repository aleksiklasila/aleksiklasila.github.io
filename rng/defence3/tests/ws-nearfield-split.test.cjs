'use strict';
// The collectors' near fields (k.rs k_ws_nearfield): the two-stage form the
// search tier runs (mode 1 rows, mode 2 columns, many jobs a pair) gives
// every tile the same value as the one-job form (a 2D raster transform):
// a match's real groups, their owners' fields compared tile by tile.
//   node tests/ws-nearfield-split.test.cjs
const assert = require('node:assert/strict');
const H = require('./net-harness.cjs');
const CONTROLS = { ...H.SMALL_MATCH_CONTROLS, 'cfg-mapsize': '64' };
(async () => {
    const world = new H.World({ controls: CONTROLS });
    const host = world.spawn('host', { controls: CONTROLS, simWorker: false });
    host.eval('startSoloGame();');
    await world.run(4000);
    const r = JSON.parse(host.eval(`(() => {
        // (Extra spawners of the host's, so a field has many sources.)
        let placed = 0;
        for (let gy = 4; gy < GRID_H - 4 && placed < 12; gy += 9) for (let gx = 4; gx < GRID_W - 4 && placed < 12; gx += 11) {
            const c = grid[gy] && grid[gy][gx];
            if (!c || c.type !== 0 || c.item || getTileEntityRef(gx, gy)) continue;
            if (placeBuilding(gx, gy, 'spawner', 0, { ignorePlacementRules: true, silent: true })) { const b = getTileEntityRef(gx, gy); if (b && b.underConstruction) markConstructionComplete(b); placed++; }
        }
        const out = [];
        for (let k = 0; k < RESOURCE_TYPE_LIST.length && k < 2; k++) {
            const G = _wsCollectorGroup(RESOURCE_TYPE_LIST[k]);
            if (!G.arrays.nf || !G.nfList || !G.nfList.length) continue;
            const pairs = G.nfList.map(o => G.id * 16 + o), tiles = GRID_W * GRID_H, P = new Float64Array(64), K = SIM_KERNELS[SIM_KERNEL_WS_NEARFIELD];
            P[0] = pairs.length; P[1] = GRID_W; P[2] = GRID_H; P[63] = _wsPostEpoch + 1;
            pairs.forEach((p, i) => { P[3 + i] = p; });
            P[62] = 0;
            for (let c = 0; c < pairs.length; c++) K(_simParReg, P, c);
            const one = G.arrays.nf.slice(0, pairs.length * tiles);
            G.arrays.nf.fill(12345, 0, pairs.length * tiles);
            const rowJobs = Math.min(64, GRID_H), colJobs = Math.ceil(GRID_W / WS_NF_COLS), per = Math.max(rowJobs, colJobs);
            P[61] = Math.ceil(GRID_H / rowJobs); P[60] = WS_NF_COLS; P[59] = per;
            for (const mode of [1, 2]) { P[62] = mode; for (let c = 0; c < pairs.length * per; c++) K(_simParReg, P, c); }
            const two = G.arrays.nf.slice(0, pairs.length * tiles);
            let diff = 0, reached = 0, first = -1;
            for (let i = 0; i < one.length; i++) { if (one[i] !== two[i]) { diff++; if (first < 0) first = i; } if (one[i] !== 0xFFFFFFFF) reached++; }
            out.push({ group: G.id, pairs: pairs.length, tiles: one.length, reached, diff, first, a: first >= 0 ? one[first] : null, b: first >= 0 ? two[first] : null });
        }
        return JSON.stringify({ placed, groups: out });
    })()`));
    console.log(JSON.stringify(r));
    assert.ok(r.groups.length > 0, 'a group with near fields');
    for (const g of r.groups) {
        assert.ok(g.reached > 0, 'its fields reach tiles');
        assert.equal(g.diff, 0, 'the same field, tile by tile (group ' + g.group + ')');
    }
    console.log('ok: near fields in two stages = in one');
    process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
