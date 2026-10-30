// Every kind of state a determinism bug could leave different on one peer,
// in the middle of a busy four-player match: units (position, energy,
// orders, path, target, worker cargo, membership), buildings (energy,
// level, timers, membership), grid cells, the worker reservation table,
// list order, players (resources, research), globals (random state, unit
// ids, adjacency, areas), mines, dropped items and projectiles. Each one is
// detected and repaired on that guest alone, without a match-wide resync,
// and afterwards every peer holds exactly the same state (every region
// hashed at once, and the bit-exact fingerprint on every tick).
//
// Usage: node tests/multiplayer-corruption-fuzz.test.cjs [kind,kind,...]
const assert = require('node:assert/strict');
const C = require('./multiplayer-chaos-determinism.test.cjs');
// (DIVTRACE: the codec's fields of every entity, for a failed comparison.)
const FULL_VALUES = `(() => {
    const S = snapEncodeState();
    const out = {};
    for (const list of Object.keys(S.lists)) for (const row of S.lists[list]) {
        const tpl = S.tpls[row[1]];
        const keys = _snapGetShape(S.shapes[tpl[0]]).cols;
        const v = tpl[1].slice();
        for (let j = 2; j < row.length; j += 2) v[row[j]] = row[j + 1];
        const o = {};
        const deref = (x, d) => { if (typeof x === 'string' && x.startsWith('~o') && d < 3) { const e = S.pool[+x.slice(2)]; return JSON.stringify(e, (k, y) => typeof y === 'string' && y.startsWith('~o') ? deref(y, d + 1) : y); } return x; };
        keys.forEach((k, i) => { o[k] = deref(v[i], 0); });
        out[list + row[0]] = o;
    }
    out.G = { g: JSON.stringify(S.g) };
    return JSON.stringify(out);
})()`;

function describeDiff(hostText, guestText) {
    const a = JSON.parse(hostText), b = JSON.parse(guestText);
    const diffs = [];
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
        if (!a[k] || !b[k]) { diffs.push(k + ' only on ' + (a[k] ? 'host' : 'guest')); continue; }
        for (const f of Object.keys(a[k])) if (JSON.stringify(a[k][f]) !== JSON.stringify(b[k][f])) { let x = a[k][f], y = b[k][f]; if (typeof x === 'string' && typeof y === 'string' && x[0] === '{') { try { x = JSON.parse(x); y = JSON.parse(y); } catch { } } let d = ''; if (x && y && typeof x === 'object' && typeof y === 'object') { for (const q of new Set([...Object.keys(x), ...Object.keys(y)])) if (JSON.stringify(x[q]) !== JSON.stringify(y[q])) d += ' ' + q + ':' + JSON.stringify(x[q]).slice(0, 80) + '/' + JSON.stringify(y[q]).slice(0, 80); } diffs.push(k + '.' + f + (d ? ' differs in' + d : ' host=' + JSON.stringify(x).slice(0, 120) + ' guest=' + JSON.stringify(y).slice(0, 120))); }
    }
    return diffs.length + ' fields: ' + diffs.slice(0, 8).join(' | ');
}



// Each returns a short description of what it changed, or '' when there
// was nothing to change (then it is skipped).
const KINDS = {
    unitMove: `(() => { const u = units.find(u => !u.dead && !u.isKing); if (!u) return ''; u.x += 9; return 'u' + u.id + ' moved'; })()`,
    unitEnergy: `(() => { const u = units.filter(u => !u.dead)[7]; if (!u) return ''; u.energy = Math.max(1, u.energy - 3); return 'u' + u.id + ' energy'; })()`,
    unitOrders: `(() => { const u = units.filter(u => !u.dead && !u.workerState)[3]; if (!u) return ''; u.commandState = CMD_HOLDING; u.holdPosition = true; return 'u' + u.id + ' holds'; })()`,
    unitPath: `(() => { const u = units.find(u => !u.dead && u.path && u.path.length > 2); if (!u) return ''; u.path = null; u.pathIndex = 0; return 'u' + u.id + ' path dropped'; })()`,
    unitTarget: `(() => { const u = units.find(u => !u.dead && !u.workerState && !u.targetUnit); const e = u && units.find(e => !e.dead && e.owner !== u.owner); if (!e) return ''; u.targetUnit = e; u.commandState = CMD_ATTACKING; return 'u' + u.id + ' attacks u' + e.id; })()`,
    workerCargo: `(() => { const u = units.find(u => !u.dead && u.workerState); if (!u) return ''; u.carryingValue = (u.carryingValue || 0) + 3; return 'u' + u.id + ' cargo'; })()`,
    // A unit's effective stacks and level a step apart, as a neighbour seen
    // elsewhere leaves them (4 -> 6 stacks, level 2 -> 3, the level held by
    // its hysteresis): the same bit of both floats flips, which the state
    // hash's sum of (key ^ value) * M terms did not see (their keys differ
    // there), while the upkeep of the level differed every second.
    unitStacksLevel: `(() => { const f = new Float32Array(1), b = new Uint32Array(f.buffer); const flip = v => { f[0] = v; b[0] ^= 1 << 22; return f[0]; };
        const bit = v => { f[0] = v; return b[0] & (1 << 22); };
        // (Both values with that bit alike: it flips the same way in both.)
        const u = units.find(u => !u.dead && !u.isKing && !u.workerState && u._us && u.effectiveLevel >= 2 && u.effectiveLevel === Math.floor(u.effectiveLevel) && u.effectiveStacks >= 2 && bit(u.effectiveStacks) === bit(u.effectiveLevel));
        if (!u) return ''; const c = u._us, s = u._si, was = [u.effectiveStacks, u.effectiveLevel];
        c.effectiveStacks[s] = flip(c.effectiveStacks[s]); c._lastAppliedEffectiveLevel[s] = flip(c._lastAppliedEffectiveLevel[s]); u.effectiveLevel = flip(u.effectiveLevel);
        return 'u' + u.id + ' stacks ' + was[0] + ' -> ' + u.effectiveStacks + ', level ' + was[1] + ' -> ' + u.effectiveLevel; })()`,
    unitGone: `(() => { const i = units.findIndex(u => !u.dead && !u.isKing && !u.workerState); if (i < 0) return ''; const u = units[i]; removeUnitSpatial(u); units.splice(i, 1); return 'u' + u.id + ' gone'; })()`,
    unitExtra: `(() => { const k = units.find(u => !u.dead && u.isKing); if (!k) return ''; const u = new Unit('norm', k.owner, k.x + 20, k.y); units.push(u); updateUnitSpatial(u); return 'extra u' + u.id; })()`,
    buildingEnergy: `(() => { const b = [...towers, ...barracks, ...collectorSpawners].find(b => b.energy > 10); if (!b) return ''; b.energy -= 5; return b.type + ' energy'; })()`,
    buildingLevel: `(() => { const b = barracks.find(b => b.level < 5); if (!b) return ''; b.level += 1; return 'barrack level'; })()`,
    buildingTimer: `(() => { const b = [...barracks, ...collectorSpawners].find(b => Number.isFinite(b.spawnTimer)); if (!b) return ''; b.spawnTimer += 7; return b.type + ' timer'; })()`,
    towerGone: `(() => { const i = towers.findIndex(t => t.energy > 0 && !t.underConstruction); if (i < 0) return ''; const t = towers[i]; towers.splice(i, 1); clearTileEntity(t.gx, t.gy, t); recalculateLaserConnections(); return 'tower gone at ' + t.gx + ',' + t.gy; })()`,
    cellOwner: `(() => { const s = collectorSpawners.find(s => s.owner >= 0); if (!s) return ''; grid[s.gy][s.gx].owner = -1; return 'cell owner at ' + s.gx + ',' + s.gy; })()`,
    cellType: `(() => { for (let gy = 2; gy < GRID_H; gy += 3) for (let gx = 2; gx < GRID_W; gx += 3) { const c = grid[gy][gx]; if (!c.item && !getTileEntityRef(gx, gy) && c.type !== TYPE_WALL) { c.type = TYPE_WALL; return 'wall at ' + gx + ',' + gy; } } return ''; })()`,
    // (Through workerReservedSet, as every write of the game's: it keeps the
    // per-region counts the tick hash uses to skip empty regions.)
    reservation: `(() => { const w = units.find(u => !u.dead && u.workerType); if (!w) return ''; for (let s = 5; s < workerReservedTiles.length; s += 97) if (!workerReservedTiles[s]) { workerReservedSet(s, w); return 'reservation ' + s + ' -> u' + w.id; } return ''; })()`,
    reservationDrop: `(() => { const s = workerReservedTiles.findIndex(u => u); if (s < 0) return ''; workerReservedSet(s, null); return 'reservation ' + s + ' dropped'; })()`,
    towerOrder: `(() => { if (towers.length < 4) return ''; const a = towers[1]; towers[1] = towers[towers.length - 2]; towers[towers.length - 2] = a; return 'tower order'; })()`,
    playerEnergy: `(addPlayerResource(1, 'energy', -321), 'player energy')`,
    playerResearch: `(() => { const t = RESEARCH_THINGS.find(t => t.kind === 'unit' && t.key === 'norm'); if (!t) return ''; applyResearchCompletion(2, { kind: t.kind, key: t.key, statKey: t.stats[0].statKey }); return 'research ' + t.stats[0].statKey; })()`,
    rng: `(rng(), rng(), 'random state')`,
    unitIds: `(nextUnitId += 3, 'unit ids')`,
    adjacency: `(_adjacencyNeedsRecalc = true, _adjacencyDirtyAll = true, 'adjacency pass')`,
    area: `(() => { const a = (areas || []).find(a => a && a.cells && a.cells.length > 0); if (!a) return ''; a.multiplierLevel = (a.multiplierLevel || 0) + 1; return 'area level'; })()`,
    mine: `(() => { const m = goldMines.find(m => m.gold > 100) || astarMines.find(m => m.astar > 100); if (!m) return ''; if (m.gold > 100) m.gold -= 50; else m.astar -= 50; return 'mine'; })()`,
    drop: `(() => { const d = droppedItems[0]; if (!d) return ''; d.value += 5; return 'dropped item'; })()`,
    projectile: `(() => { if (!projCount()) return ''; _pj.a.x[_pj.live[0]] += 13; return 'projectile'; })()`
};

// The unit count planes against a recount from the units (DIVTRACE).
const COUNT_PLANES = `(() => {
    const sum = a => { let t = 0; for (let i = 0; i < a.length; i++) t += a[i]; return t; };
    const re = new Int32Array(spatialTypeCounts.length);
    for (const u of units) {
        if (u.dead || u._spatialKey === undefined) continue;
        const k = spatialTypeBlockOf(u._spatialKey) * spatialTypeStridePerBlock + u._spatialOwner * spatialUnitsComplexUnitTypeCount + u._spatialUnitTypeIdx;
        if (k >= 0 && k < re.length) re[k]++;
    }
    let off = 0; for (let i = 0; i < re.length; i++) if (re[i] !== spatialTypeCounts[i]) off++;
    return JSON.stringify({ units: units.length, types: sum(spatialTypeCounts), complex: sum(spatialUnitsComplex), blocks: sum(spatialBlockCounts), typeCellsOff: off });
})()`;

// Kinds whose effect spreads to a whole team at once (a patch of much of
// the map or a full one is fine for these).
// (unitExtra: a unit that should not be there raises its neighbours'
// effective levels (and so their upkeep) while its patch is on the way.)
const BROAD = new Set(['unitExtra', 'playerResearch', 'adjacency', 'unitIds', 'rng']);

(async () => {
    const pick = process.argv[2] ? process.argv[2].split(',') : Object.keys(KINDS);
    const { world, host, guests, all } = await C.setupChaosWorld('crossroads', 9091, { teams: [0, 1, 2, 3], exactHashes: true, network: { latencyMs: 60, jitterMs: 15 } });
    // SNAP_KERNEL_MIN=0: the large-world hash path (column hashes from the
    // kernels, object fields by rotation) on this small world.
    if (process.env.SNAP_KERNEL_MIN) for (const i of all) i.evalSim('SNAP_HASH_KERNEL_MIN_UNITS = ' + Number(process.env.SNAP_KERNEL_MIN));
    host.eval("(() => { const orig = resyncHostHandleRequest; resyncHostHandleRequest = function (conn, data) { try { const codes = new Set(); for (const r of (data && data.rotation) || []) { const mine = r && r.pairs ? snapGetTickHash(r.tick) : null; if (mine) for (const c of snapDiffTickHash(mine, r)) codes.add(c); } (__scratch.req || (__scratch.req = [])).push([String(conn.peer), data.tick, data.from, snapDescribeCodes(codes).slice(0, 12).join('; ')]); } catch (e) { (__scratch.req || (__scratch.req = [])).push(['err', String(e)]); } return orig.apply(this, arguments); }; })()");
    for (let t = 1700; t < 2200; t++) world.atTick(t, "(__scratch.rg || (__scratch.rg = {}))[currentTick] = (() => { const o = {}; for (let gy = 8; gy < 12; gy++) for (let gx = 20; gx < 24; gx++) { const e = getTileEntityRef(gx, gy); if (!e) continue; const f = {}; for (const k of SNAP_HASH_FIELDS[e.gold !== undefined || e.astar !== undefined ? 'm' : 'b']) { const v = e[k]; f[k] = v && typeof v === 'object' ? JSON.stringify(v).slice(0, 300) : v; } o[gx + ',' + gy] = f; } const r = 2 * 1024 + 5; for (let gy = 8; gy < 12; gy++) for (let gx = 20; gx < 24; gx++) { const t = gy * GRID_W + gx; if (_ST.code[t]) o['T' + gx + ',' + gy] = [_ST.code[t], _ST.own[t], _ST.uc[t], _ST.val[t], _ST.tim[t], 'en=' + getTileEntityRef(gx, gy).energy].join(); } o.mineSum = (typeof _ST !== 'undefined' && _ST.mineSum) ? _ST.mineSum[2 * _ST.rw + 5] : null; o.res = typeof _workerReservedSums === 'function' && _workerReservedSums() ? [_workerReservedCounts()[2 * Math.ceil(GRID_W / SNAP_REGION_TILES) + 5], _workerReservedSums()[2 * Math.ceil(GRID_W / SNAP_REGION_TILES) + 5]] : null; return JSON.stringify(o); })()");
    let s = 4242;
    const rand = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
    const play = async ms => { const end = world.now + ms; while (world.now < end) { for (const i of all) if (rand() < 0.5) i.eval(C.CHAOS_COMMAND + '(' + rand() + ')'); await world.run(200); } };
    const idle = i => i.eval('isHost ? resyncHostPending.size === 0 : (resyncGuest.T < 0 && !resyncGuest.outstanding)');
    const repairs = i => i.patchesApplied + i.snapshotsApplied;
    // (SHIFT_MS: the corruptions land elsewhere in the hash rotations and the
    // stat refresh cycles; a repair must not depend on where.)
    await play(4000 + (Number(process.env.SHIFT_MS) || 0));

    // The whole state, every region at once, on every peer after one tick.
    const wholeState = async () => {
        for (const i of all) i.scratch.full = undefined;
        const at = world.atNextSafeTick(`__scratch.full = snapTickHash(currentTick, true).sum`, 20);
        await world.runUntil(() => all.every(i => i.eval('currentTick') > at + 1), 10000, 20);
        return all.map(i => i.scratch.full);
    };
    const same = sums => sums.every(x => x === sums[0] && x !== undefined);
    const rows = []; const rowsPush = r => { console.log("ROW", r); rows.push(r); };
    let k = 0;
    if (process.env.WATCH) { const [wx, wy] = process.env.WATCH.split(',').map(Number); const code = "(__scratch.w || (__scratch.w = {}))[currentTick] = (e => e ? [e.constructor.name, e.type, e.owner, e.energy, e.underConstruction, e.level, e.isUpgrading, e.isStacking, e.stacks, e.markedForSalvage].join() : 'none')(getTileEntityRef(WX, WY))".replace('WX', wx).replace('WY', wy); for (let t = 600; t < 1000; t++) world.atTick(t, code); }
    for (const kind of pick) {
        const victim = guests[k++ % guests.length];
        const before = all.map(repairs);
        const fullBefore = victim.fullPatchesApplied;
        const what = victim.evalSim(KINDS[kind]);
        if (!what) { rowsPush(`${kind}: nothing to change, skipped`); continue; }
        const t0 = world.now;
        // Keep playing until the victim is patched and nothing is in flight
        // (or long enough that it would have been).
        let patchedAt = 0;
        // (A building's level and an area's are in the full rounds: each region
        // once in SNAP_HASH_SLICES * SNAP_HASH_GRID_ROUNDS ticks, 20 s. The
        // others are found within a rotation or two.)
        const noticeMs = kind === 'buildingLevel' || kind === 'area' ? 24000 : 6000;
        while (world.now - t0 < noticeMs) {
            await play(400);
            if (repairs(victim) > before[all.indexOf(victim)] && all.every(idle)) { patchedAt = world.now; break; }
        }
        if (!patchedAt) {
            // Nothing noticed: then the next ticks overwrote it the same way
            // on every peer. An unnoticed difference would be the failure.
            await world.runUntil(() => all.every(idle), 10000, 20);
            const sums = await wholeState();
            assert.ok(same(sums), `${kind} (${what}) on ${victim.name}: never patched, and the state differs: ${sums}`);
            assert.equal(repairs(victim), before[all.indexOf(victim)], `${kind}: a late repair`);
            rowsPush(`${kind} (${what}) on ${victim.name}: overwritten by the next ticks alike on every peer, no patch needed`);
            continue;
        }
        // The first repair came. What the corruption did meanwhile may reach
        // further (a neighbour's effective level, a status a projectile gave
        // a building, a player's upkeep) and sit in fields of slower hash
        // rounds (a structure's statuses: each region once in 20 s): the
        // peers must end up equal, the victim alone repaired, in a few
        // patches, within the slowest round's time.
        const CONVERGE_MS = 26000;
        let sums = null, equalAt = 0;
        const until = world.now + CONVERGE_MS;
        await play(1500);
        for (;;) {
            if (all.every(idle)) { sums = await wholeState(); if (same(sums)) { equalAt = world.now; break; } }
            if (world.now >= until) break;
            await play(800);
        }
        const patches = repairs(victim) - before[all.indexOf(victim)];
        const full = victim.fullPatchesApplied - fullBefore;
        all.forEach((i, j) => { if (i !== victim && repairs(i) !== before[j]) { console.log('OTHER', i.name, 'patchTicks', JSON.stringify((i.patchTicks||[]).slice(-6)), 'victim', victim.name, 'kindAt', t0); console.log('WARN', i.name, JSON.stringify(i.warnings.slice(-12).map(w => w.a.map(x => typeof x === 'object' ? JSON.stringify(x).slice(0, 300) : String(x)).join(' '))).slice(0, 4000)); const pt=(i.patchTicks||[0]); console.log('REQ', JSON.stringify(host.eval('__scratch.req').slice(-14)).slice(0, 6000)); { const A = JSON.parse(host.evalSim("(() => { const o = {}; for (let gy = 8; gy < 12; gy++) for (let gx = 20; gx < 24; gx++) { const e = getTileEntityRef(gx, gy); if (!e) continue; const f = {}; for (const k of SNAP_HASH_FIELDS.b) { const v = e[k]; f[k] = v && typeof v === 'object' ? JSON.stringify(v).slice(0, 200) : v; } o[gx + ',' + gy] = f; } return JSON.stringify(o); })()")), B = JSON.parse(i.evalSim("(() => { const o = {}; for (let gy = 8; gy < 12; gy++) for (let gx = 20; gx < 24; gx++) { const e = getTileEntityRef(gx, gy); if (!e) continue; const f = {}; for (const k of SNAP_HASH_FIELDS.b) { const v = e[k]; f[k] = v && typeof v === 'object' ? JSON.stringify(v).slice(0, 200) : v; } o[gx + ',' + gy] = f; } return JSON.stringify(o); })()")); for (const k of new Set([...Object.keys(A), ...Object.keys(B)])) { if (!A[k] || !B[k]) { console.log('SDIFF', k, 'only', !!A[k], !!B[k]); continue; } for (const f of Object.keys(A[k])) if (JSON.stringify(A[k][f]) !== JSON.stringify(B[k][f])) console.log('SDIFF', k, f, JSON.stringify(A[k][f]), JSON.stringify(B[k][f])); } } console.log('CACHE host', host.evalSim("(() => { _snapStaticSlices(); const out = []; const S = _snapStaticSliceCache.slices; for (let k = 0; k < S.length; k++) for (const [t, en] of S[k]) { const gx = t % GRID_W, gy = (t - gx) / GRID_W; const cur = getTileEntityRef(gx, gy); if (cur !== en[0]) out.push([gx, gy, k, en[0] && en[0].type, en[0] && en[0].level, cur && cur.type, cur && cur.level, en[0] && en[0]._stRow, cur && cur._stRow].join()); if (gx >= 20 && gx < 24 && gy >= 8 && gy < 12) out.push('R ' + [gx, gy, k, en[1], en[2], en[3], _snapHashEntity(en[1], en[0], en[2])].join()); } return JSON.stringify(out); })()")); console.log('CACHE g', i.evalSim("(() => { _snapStaticSlices(); const out = []; const S = _snapStaticSliceCache.slices; for (let k = 0; k < S.length; k++) for (const [t, en] of S[k]) { const gx = t % GRID_W, gy = (t - gx) / GRID_W; const cur = getTileEntityRef(gx, gy); if (cur !== en[0]) out.push([gx, gy, k, en[0] && en[0].type, en[0] && en[0].level, cur && cur.type, cur && cur.level, en[0] && en[0]._stRow, cur && cur._stRow].join()); if (gx >= 20 && gx < 24 && gy >= 8 && gy < 12) out.push('R ' + [gx, gy, k, en[1], en[2], en[3], _snapHashEntity(en[1], en[0], en[2])].join()); } return JSON.stringify(out); })()")); { const A = host.evalSim('__scratch.rg') || host.eval('__scratch.rg') || {}, B = i.evalSim('__scratch.rg') || i.eval('__scratch.rg') || {}; console.log('NREC', Object.keys(A).length, Object.keys(B).length, String(A[2050]).slice(0, 600)); let shown = 0; for (let t = 1700; t < 2200 && shown < 400; t++) { if (!A[t] || !B[t] || A[t] === B[t]) continue; const a = JSON.parse(A[t]), b = JSON.parse(B[t]); const d = []; for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) { if (JSON.stringify(a[k]) === JSON.stringify(b[k])) continue; if (a[k] && b[k] && typeof a[k] === 'object') { for (const f of Object.keys(a[k])) if (JSON.stringify(a[k][f]) !== JSON.stringify(b[k][f])) d.push(k + '.' + f + ' ' + JSON.stringify(a[k][f]).slice(0,200) + ' / ' + JSON.stringify(b[k][f]).slice(0,200)); } else d.push(k + ' ' + JSON.stringify(a[k]) + ' / ' + JSON.stringify(b[k])); } shown++; console.log('TDIFF', t, d.join(' | ')); } } console.log('DIV', JSON.stringify(require('./net-harness.cjs').divergenceReport(host, i, (pt[pt.length-2]||0)+1), null, 1)); } });
        all.forEach((i, j) => { if (i !== victim) assert.equal(repairs(i), before[j], `${kind}: ${i.name} was repaired too`); });
        if (victim.snapshotsApplied !== 1 && process.env.WATCH) { const W = all.map(i => i.evalSim('__scratch.w || {}')); let shown = 0; for (let t = 600; t < 1000 && shown < 40; t++) { const v = W.map(w => w[t]); if (v.every(x => x === v[0])) continue; shown++; console.log('W', t, all.map((i, j) => i.name + '=' + v[j]).join(' | ')); } }
        if (victim.snapshotsApplied !== 1) for (const i of all) console.log('WARN', i.name, JSON.stringify(i.warnings.slice(-12).map(w => w.a.map(x => typeof x === 'object' ? JSON.stringify(x).slice(0, 300) : String(x)).join(' '))).slice(0, 3000));
        assert.equal(victim.snapshotsApplied, 1, `${kind}: match-wide resync`);
        if (process.env.DIVTRACE && !equalAt) { const h = host.evalSim(FULL_VALUES), v = victim.evalSim(FULL_VALUES); console.error('FIELDS', describeDiff(h, v)); }
        // (Derived count planes: kept by changes, so a repair must leave them as a recount gives.)
        if (process.env.DIVTRACE && !equalAt) console.error('COUNTS host', host.evalSim(COUNT_PLANES), 'victim', victim.evalSim(COUNT_PLANES));
        if (process.env.DIVTRACE && !equalAt) console.error('DIVTRACE', kind, JSON.stringify(require('./net-harness.cjs').divergenceReport(host, victim, (victim.patchTicks || [0]).slice(-1)[0] + 1), null, 1));
        assert.ok(equalAt, `${kind} (${what}) on ${victim.name}: state differs ${Math.round(world.now - patchedAt)} ms after the first patch (${patches} patches): ${sums}`);
        if (!BROAD.has(kind)) assert.ok(patches <= 3 && full === 0, `${kind} (${what}): ${patches} patches, ${full} full`);
        else assert.ok(patches <= 4, `${kind} (${what}): ${patches} patches`);
        rowsPush(`${kind} (${what}) on ${victim.name}: ${patches} patch${patches > 1 ? 'es' : ''}${full ? ` (${full} full)` : ''}, the first after ${Math.round(patchedAt - t0)} ms, whole state equal ${Math.round(equalAt - patchedAt)} ms later`);
    }

    // Everything settled: the fingerprints agree on every tick since the
    // last repair, and the whole state once more.
    await play(3000);
    await world.run(2000);
    for (const i of all) assert.deepEqual(i.errors.map(e => String(e && e.stack || e).slice(0, 500)), [], i.name + ' threw');
    for (const i of all) assert.equal(i.eval('runtimeErrorCount'), 0, i.name + ' runtime errors');
    const sums = await wholeState();
    assert.ok(same(sums), 'whole state equal at the end: ' + sums);
    const lastRepair = Math.max(...all.map(i => i.lastSnapshotTick || 0));
    const cmp = world.compareHashes(all, lastRepair, 'tickExact');
    assert.equal(cmp.mismatches.length, 0, 'bit-exact after the last repair: ' + JSON.stringify(cmp.mismatches.slice(0, 3)));
    assert.ok(cmp.compared > 100, 'compared ' + cmp.compared);
    console.log('PASS: corruption fuzz\n  ' + rows.join('\n  ') + `\n  whole state equal on all ${all.length} peers afterwards; ${cmp.compared} exact fingerprints since the last repair`);
    process.exit(0);
})().catch(err => { console.error(err); process.exit(1); });
