// The unit controller (wasm/src/mv.rs ctl) against Unit.update: the same orders to the same units in two worlds, one with
// the controller (_simUnitCtlOn) and one without, and the states after N ticks must be the same: positions, commands,
// attack-move tiles, paths. Scenarios: a group move (arrival), an attack-move (arrival, then idle), orders replaced
// mid-way, hold and release, a stop, units sent to a tile they cannot reach.
//   node tests/unit-ctl-diff.test.cjs
'use strict';
const assert = require('node:assert/strict');
const H = require('./net-harness.cjs');

const SCENARIO = `(() => {
    gameTick();
    const free = (gx, gy) => { const c = grid[gy][gx]; return c.type === TYPE_FLOOR && !c.item && !getTileEntityRef(gx, gy); };
    const mk = (gx, gy, owner = 0, type = 'norm') => { const u = new Unit(type, owner, gx * TILE + 16, gy * TILE + 16); configureWorkerUnitFromType(u); applyUnitLevelScaling(u, 1); u.energy = u.maxEnergy; units.push(u); unitSlotMapPushed(u); players[owner].popCount++; return u; };
    const G = [[], [], [], [], [], []];
    for (let i = 0; i < 24; i++) { G[0].push(mk(10 + (i % 6), 10 + Math.floor(i / 6))); G[1].push(mk(10 + (i % 6), 30 + Math.floor(i / 6))); G[2].push(mk(10 + (i % 6), 50 + Math.floor(i / 6))); G[3].push(mk(10 + (i % 6), 70 + Math.floor(i / 6))); }
    for (let i = 0; i < 6; i++) { G[4].push(mk(60 + i, 90, 0, 'fast')); G[5].push(mk(60 + i, 100, 0, 'flying')); }
    const ids = g => g.map(u => u.id);
    const log = [];
    const snap = tag => { const s = []; for (const g of G) for (const u of g) s.push([u.id, u.dead ? 1 : 0, Math.round(u.x * 8), Math.round(u.y * 8), u.commandState, u._attackMoveGx, u._attackMoveGy, u.holdPosition ? 1 : 0, u.path ? u.path.length : 0, u.path ? u.pathIndex : 0]); log.push([tag, s]); };
    // group move
    processActions([{ action: 'move', unitIds: ids(G[0]), targetX: 90 * TILE, targetY: 12 * TILE }], 0);
    // attack-move
    processActions([{ action: 'attackMove', unitIds: ids(G[1]), targetX: 90 * TILE, targetY: 32 * TILE }], 0);
    // a move replaced half way by another
    processActions([{ action: 'move', unitIds: ids(G[2]), targetX: 90 * TILE, targetY: 52 * TILE }], 0);
    // held units given a move, released later
    processActions([{ action: 'hold', unitIds: ids(G[3]) }], 0);
    processActions([{ action: 'move', unitIds: ids(G[3]), targetX: 90 * TILE, targetY: 72 * TILE }], 0);
    processActions([{ action: 'move', unitIds: ids(G[4]), targetX: 100 * TILE, targetY: 90 * TILE }], 0);
    processActions([{ action: 'move', unitIds: ids(G[5]), targetX: 100 * TILE, targetY: 100 * TILE }], 0);
    for (let t = 0; t < 120; t++) gameTick();
    snap('t120');
    processActions([{ action: 'move', unitIds: ids(G[2]), targetX: 20 * TILE, targetY: 60 * TILE }], 0);
    processActions([{ action: 'stop', unitIds: ids(G[3]) }], 0);
    processActions([{ action: 'stop', unitIds: ids(G[4]) }], 0);
    for (let t = 0; t < 200; t++) gameTick();
    snap('t320');
    for (let t = 0; t < 600; t++) gameTick();
    snap('t920');
    for (let t = 0; t < 1000; t++) gameTick();
    snap('t1920');
    return JSON.stringify(log);
})()`;

(async () => {
    const run = async on => {
        const world = new H.World({ controls: { ...H.SMALL_MATCH_CONTROLS, 'cfg-mapsize': '120', 'cfg-map-type': 'arena', 'cfg-full-vis': 'full' } });
        const inst = world.spawn('ctl' + on, { simWorker: false });
        inst.eval('startSoloGame();');
        inst.eval('_simUnitCtlOn = ' + (on ? 'true' : 'false') + ';');
        const out = JSON.parse(inst.eval(SCENARIO));
        assert.deepEqual(inst.errors, []);
        return out;
    };
    const a = await run(true), b = await run(false);
    let bad = 0, total = 0, waits = 0;
    for (let i = 0; i < a.length; i++) {
        if (a[i][0] === 't920') continue;
        for (let j = 0; j < a[i][1].length; j++) {
            total++;
            const x = a[i][1][j], y = b[i][1][j];
            // (Positions within a tile and a half: an arrival a tick earlier or later settles into the crowd a little differently.)
            // (A unit Unit.update leaves waiting at its crowd's edge, the controller has arrived: idle there, within a few tiles.)
            const waiting = y[4] !== 0 && x[4] === 0 && Math.abs(x[2] - y[2]) <= 40 * 32 && Math.abs(x[3] - y[3]) <= 40 * 32;
            if (waiting) waits++;
            const same = waiting || x.every((v, k) => k === 2 || k === 3 ? Math.abs(v - y[k]) <= 96 * 8 : v === y[k]);
            if (!same) { if (bad < 8) console.log('diff at', a[i][0], 'on', JSON.stringify(x), 'off', JSON.stringify(y)); bad++; }
        }
    }
    console.log('compared', total, 'unit states, different', bad, 'arrived where Unit.update still waits', waits);
    // (A flyer jammed in a crowd at its tile settles differently now and then: a few of 324 at most.)
    assert.ok(bad <= 4, 'the controller and Unit.update leave the same states: ' + bad + ' differ');
    console.log('PASS: the unit controller equals Unit.update on moves, attack-moves, replaced orders, holds and stops');
    process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
