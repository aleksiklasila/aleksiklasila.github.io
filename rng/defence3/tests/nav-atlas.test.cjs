// The routing atlas (NAVIGATION_OPTIMIZATION.md, flownav.js navAtlasBuild,
// wasm/src/atlas.rs): any destination by lookups. From random open tiles to
// random reachable ones on several map types (walls, islands, rooms),
// stepping navStep on the atlas id: every walk arrives (no loop, no dead end),
// within a bounded detour of the shortest way (breadth first), and no field
// or row is made for any destination.
// node tests/nav-atlas.test.cjs [--pairs=400]
const assert = require('node:assert/strict');
const H = require('./net-harness.cjs');

const pairs = Number((process.argv.find(a => a.startsWith('--pairs=')) || '=400').split('=')[1]);
// (Terrain carved into the grid before the build: the map types make few
// walls of their own.) blobs: random 3x3 rocks; rooms: a grid of walled rooms
// with a door or two each; walls: long walls with one gap; spiral; open.
const maps = [['blobs', 128], ['rooms', 128], ['walls', 160], ['spiral', 96], ['open', 100], ['rooms', 520]];

// Walls carved into the grid (page context), the ground navigation built again.
function carve(type) {
    const W = GRID_W, H = GRID_H;
    let seed = 7;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const set = (x, y) => { if (x > 0 && y > 0 && x < W - 1 && y < H - 1 && !getTileEntityRef(x, y)) grid[y][x].type = TYPE_WALL; };
    if (type === 'blobs') for (let i = 0; i < W * H / 40; i++) { const x = Math.floor(rnd() * W), y = Math.floor(rnd() * H); for (let dy = 0; dy < 3; dy++) for (let dx = 0; dx < 3; dx++) set(x + dx, y + dy); }
    if (type === 'rooms') {
        const R = 12;
        for (let y = 0; y < H; y += R) for (let x = 0; x < W; x++) set(x, y);
        for (let x = 0; x < W; x += R) for (let y = 0; y < H; y++) set(x, y);
        for (let y = 0; y < H; y += R) for (let x = 0; x < W; x += R) {
            if (rnd() < 0.8) { const d = x + 1 + Math.floor(rnd() * (R - 2)); if (grid[y]) grid[y][Math.min(W - 1, d)].type = 0; }
            if (rnd() < 0.8) { const d = y + 1 + Math.floor(rnd() * (R - 2)); if (grid[Math.min(H - 1, d)]) grid[Math.min(H - 1, d)][x].type = 0; }
        }
    }
    if (type === 'walls') for (let x = 10; x < W - 5; x += 14) { const gap = 2 + Math.floor(rnd() * (H - 4)); for (let y = 1; y < H - 1; y++) if (Math.abs(y - gap) > 1) set(x, y); }
    if (type === 'spiral') { let x0 = 2, y0 = 2, x1 = W - 3, y1 = H - 3, k = 0; while (x1 - x0 > 4 && y1 - y0 > 4) { for (let x = x0; x <= x1; x++) set(x, y0); for (let y = y0; y <= y1; y++) set(x1, y); for (let x = x0; x <= x1; x++) set(x, y1); for (let y = y0 + 3; y <= y1; y++) set(x0, y); x0 += 3; y0 += 3; x1 -= 3; y1 -= 3; k++; } }
    _simMoveWallDirty = true;
    navReset();
    navEnsure(NAV_PROFILE_GROUND);
    return grid.flat().filter(c => c.type === TYPE_WALL).length;
}

(async () => {
    for (const [type, size] of maps) {
        const controls = { ...H.SMALL_MATCH_CONTROLS, 'cfg-mapsize': String(size), 'cfg-map-type': 'arena' };
        const world = new H.World({ controls, simWorker: false });
        const inst = world.spawn('solo', { controls, simWorker: false });
        inst.eval(`startingResourcesConfig = ${JSON.stringify({ spawnCounts: { 'unit:king': { 1: 1 } }, researchLevels: {} })}; startSoloGame();`);
        await world.run(1200);
        const t0 = Date.now();
        const built = inst.eval(`(${carve.toString()})('${type}')`);
        const buildMs = Date.now() - t0;
        const r = JSON.parse(inst.eval(`JSON.stringify((() => {
            const nav = navEnsure(NAV_PROFILE_GROUND), W = GRID_W, H = GRID_H, wall = nav.wall, A = nav.atlas;
            if (!A) return { err: 'no atlas' };
            const fields0 = _navFields.pools.map(F => F.byKey.size);
            let seed = 99;
            const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
            const open = [];
            for (let t = 0; t < W * H; t++) if (!wall[t]) open.push(t);
            const bfs = (from, to) => {
                const d = new Int32Array(W * H).fill(-1), q = new Int32Array(W * H);
                let h = 0, e = 0; d[from] = 0; q[e++] = from;
                while (h < e) {
                    const t = q[h++]; if (t === to) return d[t];
                    const x = t % W, y = (t - x) / W;
                    for (const n of [x + 1 < W ? t + 1 : -1, x > 0 ? t - 1 : -1, y + 1 < H ? t + W : -1, y > 0 ? t - W : -1])
                        if (n >= 0 && !wall[n] && d[n] < 0) { d[n] = d[t] + 1; q[e++] = n; }
                }
                return -1;
            };
            let walks = 0, arrived = 0, loops = 0, stuck = 0, worst = 1, sum = 0, unreachable = 0, bad = [];
            for (let i = 0; i < ${pairs}; i++) {
                const s = open[Math.floor(rnd() * open.length)], d = open[Math.floor(rnd() * open.length)];
                if (s === d) continue;
                if (!navReachable(NAV_PROFILE_GROUND, s, d)) { unreachable++; continue; }
                walks++;
                const best = bfs(s, d);
                const seen = new Set([s]);
                let t = s, n = 0;
                for (; t !== d && n < 8 * (best + 50); n++) {
                    const nx = navStep(NAV_PROFILE_GROUND, t, d, NAV_ATLAS_FID);
                    if (nx < 0 || wall[nx]) { stuck++; if (bad.length < 3) bad.push({ s, d, t, nx, why: 'stuck' }); break; }
                    const dx = Math.abs(nx % W - t % W), dy = Math.abs(Math.floor(nx / W) - Math.floor(t / W));
                    if (dx + dy !== 1) { stuck++; if (bad.length < 3) bad.push({ s, d, t, nx, why: 'jump' }); break; }
                    if (seen.has(nx)) { loops++; if (bad.length < 3) bad.push({ s, d, t, nx, why: 'loop' }); break; }
                    seen.add(nx); t = nx;
                }
                if (t === d) { arrived++; const q = n / Math.max(1, best); sum += q; if (q > worst) worst = q; }
            }
            return { W, open: open.length, parts: nav.np, levels: A.L, nodes: A.nodes, poolEntries: A.poolEntries, walks, arrived, loops, stuck, unreachable,
                meanDetour: +(sum / Math.max(1, arrived)).toFixed(3), worstDetour: +worst.toFixed(3), bad,
                fieldsMade: _navFields.pools.map((F, i) => F.byKey.size - fields0[i]) };
        })())`));
        console.log(`${type} ${size} (${built} walls, atlas+build ${buildMs} ms): ` + JSON.stringify(r));
        assert.ok(!r.err, r.err);
        assert.equal(r.loops, 0, type + ': no walk loops');
        assert.equal(r.stuck, 0, type + ': no walk is stuck: ' + JSON.stringify(r.bad));
        assert.equal(r.arrived, r.walks, type + ': every walk arrives');
        assert.ok(r.meanDetour < 1.35, type + ': mean detour ' + r.meanDetour);
        assert.ok(r.worstDetour < 3, type + ': worst detour ' + r.worstDetour);
        assert.deepEqual(r.fieldsMade, [0, 0], type + ': no destination fields');
        assert.deepEqual(inst.errors.map(e => String(e.stack || e).slice(0, 300)), [], type + ': no errors');
        world.instances.forEach(i => { try { i.kill({ silent: true }); } catch { } });
    }
    console.log('PASS: the atlas reaches every reachable destination without fields, loops or dead ends.');
    process.exit(0);
})().catch(err => { console.error(err); process.exit(1); });
