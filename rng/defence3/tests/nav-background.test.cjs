// The navigation rebuild's background stages (simParallelBackground: the
// helpers take the local fields and the parts between the tick's other
// jobs) install exactly the build a synchronous navBuild makes from the same
// walls, with real helper threads (and none), across several rebuilds.
// Usage: node tests/nav-background.test.cjs
'use strict';
globalThis.self = { crossOriginIsolated: true };
const assert = require('node:assert/strict');
const H = require('./net-harness.cjs');

const same = (a, b) => a.length === b.length && Buffer.compare(Buffer.from(a.buffer, a.byteOffset, a.byteLength), Buffer.from(b.buffer, b.byteOffset, b.byteLength)) === 0;

(async () => {
    const rows = [];
    for (const helpers of [3, 0]) {
        const world = new H.World({ controls: { ...H.SMALL_MATCH_CONTROLS, 'cfg-mapsize': '120', 'cfg-map-type': 'crossroads' } });
        const inst = world.spawn('solo' + helpers, { simWorker: false });
        inst.eval('startSoloGame(); navEnsure(NAV_PROFILE_GROUND);');
        if (helpers) {
            inst.scratch.Worker = require('./real-sim-helper.cjs');
            assert.equal(inst.eval(`Worker = __scratch.Worker; navigator.hardwareConcurrency = 32; simParallelInit('', ${helpers})`), helpers);
        }
        let builds = 0;
        for (let round = 0; round < 3; round++) {
            // Walls placed and removed (the live wall table, as the game does).
            inst.eval(`(() => { let seed = ${round + 1} * 7919;
                const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
                for (let i = 0; i < 60; i++) { const x = 2 + Math.floor(rnd() * (GRID_W - 4)), y = 2 + Math.floor(rnd() * (GRID_H - 4)), c = grid[y][x];
                    if (c.item || getTileEntityRef(x, y)) continue;
                    c.type = c.type === TYPE_WALL ? TYPE_FLOOR : TYPE_WALL; simMoveTileTypeChanged(x, y); } })()`);
            const v0 = inst.eval('_navVersion');
            for (let t = 0; t < NAV_TICKS() && inst.eval('_navVersion') === v0; t++) inst.eval('gameTick()');
            assert.ok(inst.eval('_navVersion') > v0, `round ${round}: a new build installed`);
            builds++;
            // The reference: a synchronous build from the installed build's walls.
            const ok = inst.eval(`(() => { const nav = _nav[NAV_PROFILE_GROUND];
                const ref = navBuild(NAV_PROFILE_GROUND, nav.wall, true, nav.W, nav.H);
                const eq = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
                return JSON.stringify({ k: nav.nodeTile.length, np: nav.np, ncomp: nav.ncomp, fields: eq(nav.fields, ref.fields), parts: nav.np === ref.np && eq(nav.partL, ref.partL) && eq(nav.partBase, ref.partBase) && eq(nav.nodePart, ref.nodePart) && eq(nav.partComp, ref.partComp) && eq(nav.compParts, ref.compParts), nodes: eq(nav.nodeTile, ref.nodeTile) && eq(nav.nodeBase, ref.nodeBase) && eq(nav.nodePair, ref.nodePair), cost: eq(nav.cost, ref.cost) }); })()`);
            const r = JSON.parse(ok);
            assert.ok(r.fields && r.parts && r.nodes && r.cost, `helpers ${helpers} round ${round}: background build differs from the synchronous one ${ok}`);
        }
        assert.deepEqual(inst.errors.map(String), []);
        rows.push(`${helpers} helpers: ${builds} rebuilds equal`);
        if (helpers) inst.eval('for (const w of _simPool.helpers) w.terminate()');
    }
    console.log('PASS: navigation background build ' + rows.join(', '));
    process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
function NAV_TICKS() { return 200; }
