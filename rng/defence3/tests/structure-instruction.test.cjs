// The combat brain's structure instruction (cmMode 16, wasm/src/k.rs k_combat_brain, mv.rs move_struct / resume_order):
// idle and attack-moving combat units take a hostile structure without Unit.update. In range they stand and fire (the
// kernel's attack listed with a target of -(tile + 2), applied by unitHitsResolve); out of range they walk to it by the
// atlas; when it falls the order's movement is theirs again (an attack-mover goes on to its route's end, an idle unit parks).
//   node tests/structure-instruction.test.cjs
'use strict';
const assert = require('node:assert/strict');
const H = require('./net-harness.cjs');
const world = new H.World({ controls: { ...H.SMALL_MATCH_CONTROLS, 'cfg-mapsize': '120', 'cfg-map-type': 'arena', 'cfg-full-vis': 'full' } });
const inst = world.spawn('structinst', { simWorker: false });
inst.eval('startSoloGame();');
const r = JSON.parse(inst.eval(`JSON.stringify((() => {
    gameTick();
    const free = (gx, gy) => { const c = grid[gy][gx]; return c.type === TYPE_FLOOR && !c.item && !getTileEntityRef(gx, gy); };
    const place = (gx, gy, type, owner, energy) => {
        while (!free(gx, gy)) gx--;
        placeBuilding(gx, gy, type, owner, { ignorePlacementRules: true, silent: true });
        const b = getTileEntityRef(gx, gy) || grid[gy][gx].item;
        b.underConstruction = false; b.energy = energy > 0 ? energy : b.maxEnergy;
        return b;
    };
    const mk = (gx, gy, type = 'norm', owner = 0) => {
        const u = new Unit(type, owner, gx * TILE + 16, gy * TILE + 16);
        configureWorkerUnitFromType(u); applyUnitLevelScaling(u, 1); u.energy = u.maxEnergy;
        units.push(u); unitSlotMapPushed(u); players[owner].popCount++;
        return u;
    };
    const out = {};
    // ---- A: idle units beside a hostile barrack: they fire, the barrack falls, they park again.
    const bA = place(40, 40, 'barrack_norm', 1, 400);
    const idle = [];
    for (let i = 0; i < 6; i++) idle.push(mk(38 + (i % 3), 39 + Math.floor(i / 3)));
    const idleIds = new Set(idle.map(u => u.id));
    let calls = 0;
    const f = Unit.prototype.update;
    Unit.prototype.update = function () { if (idleIds.has(this.id)) calls++; return f.apply(this, arguments); };
    for (let t = 0; t < 30; t++) gameTick();
    out.aCallsAfterSettle = calls;
    calls = 0;
    const e0 = bA.energy;
    let sawInstruction = 0, sawAttackingState = 0, dmgAt = -1;
    for (let t = 0; t < 400 && bA.energy > 0; t++) {
        gameTick();
        if (dmgAt < 0 && bA.energy < e0) dmgAt = t;
        for (const u of idle) if (!u.dead) { if (u._us.cmMode[u._si] & 16) sawInstruction++; if (u.commandState === CMD_ATTACKING) sawAttackingState++; }
    }
    out.aDestroyed = !(bA.energy > 0);
    out.aEnergy = [e0, bA.energy];
    out.aDmgAt = dmgAt;
    out.aInstruction = sawInstruction;
    out.aAttackingState = sawAttackingState;
    out.aCalls = calls;
    for (let t = 0; t < 12; t++) gameTick();
    out.aAfter = idle.filter(u => !u.dead).map(u => [u.commandState, u._us.cmMode[u._si], u._us.mvOn[u._si]]);
    // ---- B: idle units within sight of a hostile barrack but out of their attack range (another area): they walk to it, fire, destroy it.
    const bB = place(90, 90, 'barrack_norm', 1, 300);
    const probe = mk(10, 10, 'tank'), aggro = Math.max(TILE, probe.preComputed.visionRange * TILE);
    const kk = _getUnitAttackRangeArea(probe); probe.dead = true; probe.energy = 0;
    // (A spot in sight, out of attack range: another area, within the aggro range.)
    let spot = null;
    for (let dy = -9; dy <= 9 && !spot; dy++) for (let dx = -9; dx <= 9 && !spot; dx++) {
        const gx = 90 + dx, gy = 90 + dy;
        if (gx < 1 || gy < 1 || gx > 118 || gy > 118 || !free(gx, gy)) continue;
        const px = gx * TILE + 16, py = gy * TILE + 16, d = Math.hypot(px - bB.x, py - bB.y);
        if (d > 2.5 * TILE && d < aggro && !isWorldTargetWithinAreaRange(px, py, bB.x, bB.y, 0)) spot = [gx, gy];
    }
    out.bSpot = spot; out.bAggro = aggro; out.bK = kk;
    const far = [];
    if (spot) for (let i = 0; i < 4; i++) { const u = mk(spot[0], spot[1], 'tank'); u._us.mvRangeK[u._si] = 0; far.push(u); }
    const dist = () => far.length ? far.filter(u => !u.dead).map(u => Math.hypot(u.x - bB.x, u.y - bB.y))[0] : 0;
    const d0 = dist();
    const eB0 = bB.energy;
    let inRange = false;
    for (let t = 0; t < 600 && bB.energy > 0; t++) { gameTick(); if (far.some(u => !u.dead && u._us.cmMode[u._si] === 21)) inRange = true; }
    out.bDist = [d0, dist()];
    out.bDestroyed = !(bB.energy > 0);
    out.bEnergy = [eB0, bB.energy];
    out.bInRange = inRange;
    // ---- C: an attack-move past a barrack: stops for it, then goes on.
    const bC = place(60, 20, 'barrack_norm', 1, 300);
    const am = [];
    for (let i = 0; i < 4; i++) am.push(mk(40 + i, 20));
    processActions([{ action: 'attackMove', unitIds: am.map(u => u.id), targetX: 100 * TILE + 16, targetY: 20 * TILE + 16 }], 0);
    const xs0 = am.map(u => u.x);
    let stopped = false;
    for (let t = 0; t < 900; t++) { gameTick(); if (!stopped && am.some(u => !u.dead && u.x > bC.x - 6 * TILE && u.commandState !== CMD_ATTACKING && u._us.cmMode[u._si] & 16)) stopped = true; if (!(bC.energy > 0)) break; }
    out.cDestroyed = !(bC.energy > 0);
    out.cStopped = stopped;
    const xsMid = am.map(u => u.x);
    for (let t = 0; t < 400; t++) gameTick();
    out.cProgress = am.filter(u => !u.dead).map(u => Math.round((u.x - xsMid[am.indexOf(u)]) / TILE));
    out.cCommand = am.filter(u => !u.dead).map(u => u.commandState);
    Unit.prototype.update = f;
    return out;
})())`));
console.log(JSON.stringify(r));
assert.ok(r.aDestroyed, 'idle units destroyed the barrack beside them: ' + JSON.stringify(r.aEnergy));
assert.ok(r.aDmgAt >= 0 && r.aDmgAt < 40, 'they fired within the brain period: ' + r.aDmgAt);
assert.ok(r.aInstruction > 0, 'by a structure instruction');
assert.equal(r.aAttackingState, 0, 'their command stayed idle (no ATTACKING state)');
assert.ok(r.aCalls <= 12, 'without Unit.update: ' + r.aCalls);
assert.ok(r.aAfter.every(a => a[0] === 0 && a[1] === 0), 'idle again, no instruction left: ' + JSON.stringify(r.aAfter));
assert.ok(!r.bSpot || (r.bDestroyed && r.bDist[1] < r.bDist[0]), 'units walked to a barrack out of their range and destroyed it: ' + JSON.stringify(r.bEnergy) + ' ' + JSON.stringify(r.bDist));
assert.ok(r.cDestroyed, 'an attack-mover destroyed the barrack on its way');
assert.ok(r.cProgress.every(p => p >= 8), 'and went on toward its destination: ' + JSON.stringify(r.cProgress));
assert.deepEqual(inst.errors, []);
console.log('PASS: structure instruction (stand and fire, walk to it, the order resumed)');
process.exit(0);
