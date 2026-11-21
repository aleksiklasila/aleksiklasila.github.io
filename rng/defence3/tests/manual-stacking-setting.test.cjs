// The Manual stacking setting (menu, Resources & Research; data_static.js
// MANUAL_STACKING_ENABLED): off by default; off, every build order is L1 in
// the simulation whatever its count (a new structure one stack, one standing
// there nothing more), the build level slider hidden; on, orders stack up to
// their count. Both peers of a match take the host's setting and agree.
//   node tests/manual-stacking-setting.test.cjs
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const H = require('./net-harness.cjs');

// The menu's default: unchecked; the game's: off.
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const input = html.match(/<input id="cfg-manual-stacking"[^>]*>/);
assert.ok(input, 'the menu has the Manual stacking checkbox');
assert.ok(!/\bchecked\b/.test(input[0]), 'unchecked by default');
assert.match(fs.readFileSync(path.join(__dirname, '..', 'src', 'data', 'data_static.js'), 'utf8'), /let MANUAL_STACKING_ENABLED = false;/);

const run = (on) => {
    const world = new H.World({ controls: { ...H.SMALL_MATCH_CONTROLS, 'cfg-mapsize': '64', 'cfg-map-type': 'arena', 'cfg-manual-stacking': on } });
    const inst = world.spawn('ms' + (on ? 1 : 0), { simWorker: false });
    inst.eval('startSoloGame();');
    return JSON.parse(inst.eval(`JSON.stringify((() => {
        const P = localPlayerId;
        let at = null;
        for (let gy = 1; gy < GRID_H - 1 && !at; gy++) for (let gx = 1; gx < GRID_W - 2; gx++) {
            const ok = (x) => { const c = grid[gy][x]; return c && cellType[(c) - 1] === TYPE_FLOOR && !cellItemGet(c) && !getTileEntityRef(x, gy) && !getGoldMineAt(x, gy) && canBuildAt(x, gy, P); };
            if (ok(gx) && ok(gx + 1)) { at = [gx, gy]; break; }
        }
        const place = (gx, count) => processAction({ action: 'place', gx, gy: at[1], itemType: 'house', autoUpgradeEnabled: true, buildEnabled: true, count }, P);
        place(at[0], 512);
        const a = cellItemGet(grid[at[1]][at[0]]);
        const newStacks = getThingManualStacks(a);
        place(at[0] + 1, 1);
        const b = cellItemGet(grid[at[1]][at[0] + 1]);
        place(at[0] + 1, 64);
        updatePurchaseMultiplierBars();
        buildPurchaseMultiplier = 256;
        return { on: MANUAL_STACKING_ENABLED, newStacks, stackedUp: getThingManualStacks(b), barHidden: !!document.getElementById('build-multiplier-bar').hidden,
            clientCount: buildStackCount(), cfg: createEditableRuntimeConfigSnapshot().config.MANUAL_STACKING_ENABLED };
    })())`));
};
const off = run(false), on = run(true);
console.log(JSON.stringify({ off, on }));
assert.deepEqual(off, { on: false, newStacks: 1, stackedUp: 1, barHidden: true, clientCount: 1, cfg: false }, 'off: L1 only, slider hidden');
assert.deepEqual(on, { on: true, newStacks: 512, stackedUp: 64, barHidden: false, clientCount: 256, cfg: true }, 'on: stacks up to the order');

// On, through the action path (queueAction: its count was clamped to 100,
// an L17 order 65536 stacks) into the sim worker, and the page's row (its
// stacks columns were 16-bit): an L6 starting house ordered at L10, L17,
// then L12 (kept at L17).
const viaWorker = (async () => {
    const world = new H.World({ controls: { ...H.SMALL_MATCH_CONTROLS, 'cfg-mapsize': '32', 'cfg-map-type': 'arena', 'cfg-manual-stacking': true } });
    world.simWorker = true;
    const inst = world.spawn('msw', {});
    inst.eval('startSoloGame();');
    const FIND = '(()=>{for(let gy=0;gy<GRID_H;gy++)for(let gx=0;gx<GRID_W;gx++){const e=getTileEntityRef(gx,gy)||(grid[gy][gx]&&cellItemGet(grid[gy][gx]));if(e&&e.type==="house"&&e.owner===localPlayerId)return e;}})()';
    await world.run(1500);
    const at = JSON.parse(inst.eval(`JSON.stringify((e => [e.gx, e.gy, e.level])(${FIND}))`));
    const seen = [];
    for (const c of [512, 65536, 2048]) {
        inst.eval(`queueAction({ action: 'place', gx: ${at[0]}, gy: ${at[1]}, itemType: 'house', autoUpgradeEnabled: true, buildEnabled: true, count: ${c} })`);
        await world.run(600);
        seen.push([inst.evalSim(`(${FIND}).manualStacks`), inst.eval(`(${FIND}).manualStacks`), inst.eval(`getLevelLabelText(${FIND})`)]);
    }
    console.log('worker', JSON.stringify(at), JSON.stringify(seen));
    assert.equal(at[2], 6, 'the starting house is L6');
    assert.deepEqual(seen.map(s => s[0]), [512, 65536, 65536], 'sim: stacks up to L10, L17, kept at L17');
    assert.deepEqual(seen.map(s => s[1]), [512, 65536, 65536], 'page row: the same');
    assert.match(seen[1][2], /^L6->L17/, 'label shows the L17 target');
});

// A hosted match: the guest takes the host's setting (off), whatever its own menu says.
// (A guest whose own menu says on: page and worker modes.)
(async () => {
    await viaWorker();
    for (const mode of ['page', 'worker']) {
        const world = new H.World({ controls: { ...H.SMALL_MATCH_CONTROLS, 'cfg-manual-stacking': false } });
        world.simWorker = mode === 'worker';
        const spawn = world.spawn.bind(world);
        world.spawn = (name, opts) => { const i = spawn(name, opts); if (name !== 'host') { i.eval("document.getElementById('cfg-manual-stacking').checked = true; MANUAL_STACKING_ENABLED = true;"); } return i; };
        const { host, guests } = await H.startHostedMatch(world, { guests: 1 });
        const g = guests[0];
        const read = inst => inst.evalSim('MANUAL_STACKING_ENABLED');
        const vals = [read(host), read(g), host.eval('MANUAL_STACKING_ENABLED'), g.eval('MANUAL_STACKING_ENABLED'), g.eval('buildStackCount()')];
        console.log('hosted ' + mode, JSON.stringify(vals));
        assert.deepEqual(vals, [false, false, false, false, 1], mode + ': every peer (and its simulation) takes the host\'s off');
    }
    console.log('PASS: manual stacking setting (off by default; off: L1 builds, no slider; on: stack up to the order; peers agree)');
    process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
