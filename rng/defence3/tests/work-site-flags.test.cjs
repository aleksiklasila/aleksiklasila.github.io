// The work site grid from the structure tables (wsw.rs k_wsw_set) equals the
// JavaScript's flags before the kernel (tests/work-site-reference.js, from git
// HEAD): every structure of a match with structures in every state (under
// construction with building on and off, damaged, upgrading, stacking and
// stack candidates, due an upgrade or not, marked for salvage, queues paid
// and not, queues off, research buildings with auto research on and off),
// their owner, area and reservation bits, and the per-owner counts.
//   node tests/work-site-flags.test.cjs
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const H = require('./net-harness.cjs');
const world = new H.World({ controls: { ...H.SMALL_MATCH_CONTROLS, 'cfg-mapsize': '200', 'cfg-map-type': 'arena' } });
const inst = world.spawn('wswflags', { simWorker: false });
inst.eval('startSoloGame();');
const REF = fs.readFileSync(path.join(__dirname, 'work-site-reference.js'), 'utf8');
const r = JSON.parse(inst.eval(REF + `;JSON.stringify((() => {
    let seed = 7;
    const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
    const keys = ['barrack_norm', 'barrack_tank', 'pistol', 'sniper', 'farm', 'spawner', 'healer_spawner', 'builder_spawner', 'research', 'salvager', 'lava', 'sand'];
    const placed = [];
    for (let gy = 10; gy < 190; gy += 2) for (let gx = 10; gx < 190; gx += 2) {
        const c = grid[gy] && grid[gy][gx];
        if (!c || c.type !== TYPE_FLOOR || c.item || getTileEntityRef(gx, gy) || getGoldMineAt(gx, gy)) continue;
        const key = keys[Math.floor(rnd() * keys.length)], p = rnd() < 0.5 ? 0 : 1;
        if (!placeBuilding(gx, gy, key, p, { ignorePlacementRules: true, silent: true })) continue;
        const e = getTileEntityRef(gx, gy) || c.item;
        if (!e) continue;
        const k = rnd();
        if (k < 0.75) {
            e.underConstruction = false; if (typeof structureWallSync === 'function') structureWallSync(e); e.buildProgress = 1; e.isUpgrading = false;
            const lvl = 1 + Math.floor(rnd() * 3);
            e.stacks = e.effectiveStacks = getRequiredStacksForLevel(lvl); e.level = lvl; e.effectiveLevel = lvl + (rnd() < 0.3 ? 1 : 0);
            if (rnd() < 0.3) e.manualStacks = e.stacks + 1 + Math.floor(rnd() * 3);
            if (e instanceof Tower) e.updateStats();
            e.energy = rnd() < 0.3 ? Math.max(1, Math.floor(e.maxEnergy * rnd())) : e.maxEnergy;
            if (rnd() < 0.1) e.isStacking = true;
            if (rnd() < 0.1) e.autoUpgradeEnabled = false;
            if (rnd() < 0.1) e.autoStackEnabled = false;
            if (rnd() < 0.1) e.markedForSalvage = true;
            if (hasSpawnQueue(e) && rnd() < 0.6) {
                spawnQueuePush(e, 1 + Math.floor(rnd() * 4));
                if (rnd() < 0.4) spawnQueuePay(e, 1e9);
                if (rnd() < 0.15) e.queueEnabled = false;
            }
            if (e.type === 'research' && rnd() < 0.4) e.autoResearchEnabled = false;
        } else if (rnd() < 0.3) e.buildEnabled = false;
        placed.push(e);
    }
    // Reservations: some by living units, some by units that died.
    const ws = units.filter(u => !u.dead).slice(0, 40);
    for (let i = 0; i < placed.length && i < ws.length * 3; i += 3) workerReservedSet((placed[i].gy * GRID_W + placed[i].gx) * _WORKER_TARGET_LOAD_TYPE_COUNT + (i % 4), ws[i / 3 | 0]);
    for (let t = 0; t < 30; t++) gameTick();
    for (let i = 0; i < 6 && i < ws.length; i++) { ws[i].energy = 0; ws[i].dead = true; }
    for (let t = 0; t < 3; t++) gameTick();
    // The grid made again from every structure (the kernel), against the reference.
    _wsw = null; _wswStep(0, false);
    const W = _wsw;
    let checked = 0, bad = 0, first = '';
    const oc = new Int32Array(WSW_MAXOWN * 8);
    for (const e of _activeTileEntities) {
        const t = e.gy * GRID_W + e.gx, x = _ownedStructureAtTile(t);
        const f = x ? _refWswFlagsOf(x, x.owner | 0) : 0, o = x ? x.owner | 0 : -1;
        const area = f ? getAreaIdAtTile(e.gx, e.gy) : -1, rv = f ? _refWswResvOf(W, t) : W.resv[t];
        if (f) for (let i = 0; i < WSW_NBITS; i++) if ((f >> i) & 1 && o >= 0 && o < WSW_MAXOWN) oc[o * 8 + i]++;
        checked++;
        const got = [W.flags[t], f || o !== -1 ? W.own[t] : o, W.area[t], W.resv[t]], want = [f, o, area, rv];
        if (got.join() !== want.join()) { bad++; if (!first) first = (e.type || '') + ' @' + t + ' got ' + got + ' want ' + want; }
    }
    return { checked, bad, first, ocOk: Array.from(oc).join() === Array.from(W.oc).join(), placed: placed.length, flagged: Array.from(W.oc).reduce((a, b) => a + b, 0) };
})())`));
assert.deepEqual(inst.errors.map(String), []);
console.log(JSON.stringify(r));
assert.ok(r.checked > 1000, 'structures checked: ' + r.checked);
assert.ok(r.flagged > 100, 'some flagged: ' + r.flagged);
assert.equal(r.bad, 0, 'first mismatch: ' + r.first);
assert.ok(r.ocOk, 'per-owner counts');
console.log('PASS: work site grid from the tables equals the JavaScript flags (' + r.checked + ' structures)');
