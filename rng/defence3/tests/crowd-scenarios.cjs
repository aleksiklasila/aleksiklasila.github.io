// Crowd movement scenarios (CROWD_SEPARATION_IMPROVEMENTS.md): the same
// elapsed game time at several step sizes (simDk 1 = 20 TPS ... 20 = 1 TPS),
// metrics at simulation endpoints. A measurement tool, not a pass/fail test:
//   node tests/crowd-scenarios.cjs [scenario,...|all] [dk,...] [seed,...]
// Scenarios:
//   idle    a dense resting crowd, no orders: travel px/s per unit (agitation)
//   rest    a crowd rallied 10 tiles, then resting: travel px/s after settling
//   march   a blob ordered 45 tiles across open ground: progress vs ideal,
//           rear cohort speed, units that gave up short of the goal
//   through a moving group through a resting one: arrival time, displacement
//   rerally the same rally point given every 0.25 s: footprint, overlap
// Output: one JSON line per scenario and step size (OUT=file appends them).
'use strict';
const fs = require('node:fs');
const H = require('./net-harness.cjs');
const want = (process.argv[2] || 'all').split(','), dks = (process.argv[3] || '1,4,20').split(',').map(Number), seeds = (process.argv[4] || '17').split(',').map(Number);
const ALL = ['idle', 'rest', 'march', 'through', 'rerally', 'life'];
const list = want.includes('all') ? ALL : want;

// (Shared in-VM helpers: a fresh arena without the start units, crowds,
// per-sample metrics.)
const PRELUDE = `
    for (const u of units) u.dead = true;
    gameTick(); currentTick++;
    let seed = SEED;
    const rnd = () => { seed = seed * 16807 % 2147483647; return seed / 2147483647; };
    const spawn = (type, owner, x, y) => { const u = new Unit(type, owner, x, y); units.push(u); updateUnitSpatial(u); return u; };
    // A blob of n units around (cx, cy) tiles, packed at about 'pack' of
    // their contact distance (1 = touching).
    const blob = (n, cx, cy, pack, types) => {
        const out = [], r = 10 * pack, cols = Math.ceil(Math.sqrt(n));
        for (let i = 0; i < n; i++) {
            const gx = i % cols - cols / 2, gy = Math.floor(i / cols) - cols / 2;
            const x = cx * TILE + 16 + (gx + (Math.floor(i / cols) & 1) * 0.5) * 2 * r + (rnd() - .5) * 2, y = cy * TILE + 16 + gy * 2 * r * 0.87 + (rnd() - .5) * 2;
            out.push(spawn(types[i % types.length], 0, x, y));
        }
        return out;
    };
    const step = () => { gameTick(); currentTick++; };
    const ticksFor = sec => Math.round(sec * 20 / simDk);
    const pos = list => list.map(u => [u.x, u.y]);
    const travel = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += Math.hypot(b[i][0] - a[i][0], b[i][1] - a[i][1]); return s; };
    const overlapOf = list => { let o = 0, n = 0, deep = 0;
        for (let i = 0; i < list.length; i++) for (let j = 0; j < i; j++) { const a = list[i], b = list[j];
            const w = a.getCollisionRadius() + b.getCollisionRadius(), d = Math.hypot(a.x - b.x, a.y - b.y);
            if (d < w) { o += (w - d) / w; n++; if (d < w * .5) deep++; } }
        return { pen: n ? o / n : 0, pairs: n, deep }; };
    const footprint = list => { let mx = 0, my = 0; for (const u of list) { mx += u.x; my += u.y; } mx /= list.length; my /= list.length;
        let r = 0; for (const u of list) r += Math.hypot(u.x - mx, u.y - my); return { cx: mx, cy: my, r: r / list.length }; };
    // (Movement speed: the unit's stat row, as the kernel reads it; the mvSpd column is gone.)
    const spd = u => { const r = u._us.statRow[u._si]; return r >= 0 ? _effRowCols.rSpd[r] : u.preComputed.speed * _getUnitAstarSpeedMultiplier(u); };
    const r3 = v => Math.round(v * 1000) / 1000;
`;

const SCEN = {
    // Resting dense crowd: how much it keeps moving on its own.
    idle: `
        const crowd = blob(225, 30, 30, 0.85, ['norm', 'fast', 'tank']);
        simDk = DK;
        for (let t = 0; t < ticksFor(8); t++) step();
        let p0 = pos(crowd), tr = 0, moving = 0, samples = 0;
        for (let t = 0; t < ticksFor(20); t++) { step(); const p1 = pos(crowd); for (let i = 0; i < crowd.length; i++) { const d = Math.hypot(p1[i][0] - p0[i][0], p1[i][1] - p0[i][1]); tr += d; if (d > 0.01) moving++; samples++; } p0 = p1; }
        const o = overlapOf(crowd);
        return { travelPxPerSec: r3(tr / crowd.length / 20), movingFrac: r3(moving / samples), pen: r3(o.pen), deep: o.deep, footprint: r3(footprint(crowd).r) };`,
    // Rallied, then resting.
    rest: `
        const crowd = blob(225, 20, 30, 1.3, ['norm', 'fast', 'tank']);
        simDk = DK;
        processAction({ action: 'move', unitIds: crowd.map(u => u.id), targetX: 30 * TILE + 16, targetY: 30 * TILE + 16 }, 0);
        for (let t = 0; t < ticksFor(20); t++) step();
        let p0 = pos(crowd), tr = 0, moving = 0, samples = 0;
        for (let t = 0; t < ticksFor(20); t++) { step(); const p1 = pos(crowd); for (let i = 0; i < crowd.length; i++) { const d = Math.hypot(p1[i][0] - p0[i][0], p1[i][1] - p0[i][1]); tr += d; if (d > 0.01) moving++; samples++; } p0 = p1; }
        const o = overlapOf(crowd), f = footprint(crowd);
        return { travelPxPerSec: r3(tr / crowd.length / 20), movingFrac: r3(moving / samples), pen: r3(o.pen), deep: o.deep, footprint: r3(f.r), stillMoving: crowd.filter(u => u.commandState !== CMD_IDLE).length };`,
    // A long march: everyone the same way.
    march: `
        const crowd = blob(300, 8, 30, 1.0, ['norm', 'fast', 'tank']);
        simDk = DK;
        const gx = 53, gy = 30, goal = gx * TILE + 16;
        processAction({ action: 'move', unitIds: crowd.map(u => u.id), targetX: goal, targetY: gy * TILE + 16 }, 0);
        const x0 = crowd.map(u => u.x), sp = crowd.map(spd);
        const T = ticksFor(70);
        let t90 = -1, rearSpeed = 0, rearN = 0, midSpeed = 0, midN = 0, gaveUp = 0;
        for (let t = 0; t < T; t++) {
            const before = crowd.map(u => u.x);
            step();
            const sec = (t + 1) * simDk / 20;
            if (sec >= 2 && sec <= 10) {
                // (Cohorts by how far each has got.)
                const order = crowd.map((u, i) => i).sort((a, b) => (crowd[a].x - x0[a]) - (crowd[b].x - x0[b]));
                for (let k = 0; k < order.length; k++) { const i = order[k], v = (crowd[i].x - before[i]) / (simDk * sp[i]);
                    if (k < order.length * .2) { rearSpeed += v; rearN++; } else if (k > order.length * .4 && k < order.length * .6) { midSpeed += v; midN++; } }
            }
            const near = crowd.filter(u => Math.abs(u.x - goal) < 6 * TILE).length;
            if (t90 < 0 && near >= crowd.length * .9) t90 = sec;
        }
        for (const u of crowd) if (u.commandState === CMD_IDLE && Math.abs(u.x - goal) > 8 * TILE) gaveUp++;
        const ds = crowd.map(u => Math.hypot(u.x - goal, u.y - (gy * TILE + 16)) / TILE).sort((x, y) => x - y);
        // Ideal: the slowest type's time for 45 tiles less the blob's half width.
        const ideal = (40 * TILE) / (Math.min(...sp) * 20);
        const o = overlapOf(crowd);
        return { endP50: r3(ds[150]), endP90: r3(ds[270]), packedTiles: r3(Math.sqrt(300 / 0.9069) * 10.5 / TILE), t90: r3(t90), ideal: r3(ideal), rearRel: r3(rearSpeed / Math.max(1, rearN)), midRel: r3(midSpeed / Math.max(1, midN)), gaveUp, pen: r3(o.pen), deep: o.deep };`,
    // A group through a resting crowd.
    through: `
        const rest = blob(200, 30, 30, 1.0, ['norm', 'tank']);
        const movers = blob(64, 14, 30, 1.0, ['fast', 'norm']);
        simDk = DK;
        for (let t = 0; t < ticksFor(2); t++) step();
        const r0 = pos(rest), goal = 46 * TILE + 16;
        processAction({ action: 'move', unitIds: movers.map(u => u.id), targetX: goal, targetY: 30 * TILE + 16 }, 0);
        let t90 = -1;
        for (let t = 0; t < ticksFor(40); t++) { step(); const near = movers.filter(u => Math.abs(u.x - goal) < 5 * TILE && Math.abs(u.y - (30 * TILE + 16)) < 8 * TILE).length; if (t90 < 0 && near >= movers.length * .9) { t90 = (t + 1) * simDk / 20; } }
        const disp = travel(r0, pos(rest)) / rest.length;
        const stuck = movers.filter(u => u.x < 38 * TILE).length;
        return { t90: r3(t90), restDisp: r3(disp), stuck, pen: r3(overlapOf(rest.concat(movers)).pen) };`,
    // A block at rest, ordered to one point, moving, arriving, resting
    // (BLOCK=WxH, default 30x30; 30x300 is the big one, MAP=200 for it).
    life: `
        const [BW, BH] = (BLOCKSPEC).split('x').map(Number), n = BW * BH, types = ['norm', 'fast', 'tank'];
        const crowd = [], sp = 21;
        for (let i = 0; i < n; i++) { const gx = i % BW, gy = Math.floor(i / BW);
            crowd.push(spawn(types[i % 3], 0, 3 * TILE + gx * sp + (rnd() - .5) * 2, (MAPN / 2) * TILE - BH * sp / 2 + gy * sp + (rnd() - .5) * 2)); }
        simDk = DK;
        // (Overlap by a grid of 32 px cells: pairs in the same or a
        // neighbouring cell.)
        const ovl = list => { const cells = new Map(); for (let i = 0; i < list.length; i++) { const u = list[i], k = (Math.floor(u.y / 32) << 16) | Math.floor(u.x / 32); let a = cells.get(k); if (!a) cells.set(k, a = []); a.push(i); }
            let o = 0, np = 0, deep = 0;
            for (let i = 0; i < list.length; i++) { const a = list[i], cx = Math.floor(a.x / 32), cy = Math.floor(a.y / 32);
                for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const c = cells.get(((cy + dy) << 16) | (cx + dx)); if (!c) continue;
                    for (const j of c) { if (j >= i) continue; const b = list[j], w = a.getCollisionRadius() + b.getCollisionRadius(), d = Math.hypot(a.x - b.x, a.y - b.y);
                        if (d < w) { o += (w - d) / w; np++; if (d < w * .5) deep++; } } } }
            return { pen: np ? o / np : 0, pairsPerUnit: np / list.length, deepPerUnit: deep / list.length }; };
        const restPhase = sec => { let p0 = pos(crowd), tr = 0, mv = 0, k = 0;
            for (let t = 0; t < ticksFor(sec); t++) { step(); const p1 = pos(crowd); for (let i = 0; i < n; i++) { const d = Math.hypot(p1[i][0] - p0[i][0], p1[i][1] - p0[i][1]); tr += d; if (d > .01) mv++; k++; } p0 = p1; }
            const o = ovl(crowd); return { travelPxPerSec: r3(tr / n / sec), movingFrac: r3(mv / k), pen: r3(o.pen), deepPerUnit: r3(o.deepPerUnit), footprint: r3(footprint(crowd).r) }; };
        const before = restPhase(5);
        const gx = MAPN - 12, gy = MAPN / 2, goalX = gx * TILE + 16, goalY = gy * TILE + 16;
        processAction({ action: 'move', unitIds: crowd.map(u => u.id), targetX: goalX, targetY: goalY }, 0);
        // (Arrived: within a packed disc's radius (x1.5) of the goal.)
        const R = 1.5 * Math.sqrt(n) * 11, dist0 = crowd.map(u => Math.hypot(u.x - goalX, u.y - goalY));
        let t50 = -1, t90 = -1, t95 = -1, firstMove = -1, maxSec = 240, tick = 0;
        while (tick * simDk / 20 < maxSec) {
            step(); tick++;
            const sec = tick * simDk / 20;
            let arrived = 0, moved = 0;
            for (let i = 0; i < n; i++) { const d = Math.hypot(crowd[i].x - goalX, crowd[i].y - goalY); if (d < R) arrived++; if (dist0[i] - d > 16) moved++; }
            if (firstMove < 0 && moved >= n * .9) firstMove = sec;
            if (t50 < 0 && arrived >= n * .5) t50 = sec;
            if (t90 < 0 && arrived >= n * .9) t90 = sec;
            if (t95 < 0 && arrived >= n * .95) { t95 = sec; break; }
        }
        const spd0 = Math.min(...crowd.map(spd)), ideal = (goalX - 3 * TILE - BW * sp - R) / (spd0 * 20);
        const after = restPhase(20);
        const ds = crowd.map(u => Math.hypot(u.x - goalX, u.y - goalY) / TILE).sort((x, y) => x - y), fp = footprint(crowd);
        const ends = { p50: r3(ds[n >> 1]), p90: r3(ds[Math.floor(n * .9)]), max: r3(ds[n - 1]), centroidOff: r3(Math.hypot(fp.cx - goalX, fp.cy - goalY) / TILE), packedTiles: r3(Math.sqrt(n / 0.9069) * 10.5 / TILE) };
        const idle = crowd.filter(u => u.commandState === CMD_IDLE).length;
        // (The packed footprint: n discs of radius ~10.5, hexagonal.)
        const far = process.env.FARDBG ? crowd.filter(u => Math.hypot(u.x - goalX, u.y - goalY) > 40 * TILE).map(u => ({ id: u.id, type: u.unitType, x: Math.round(u.x), y: Math.round(u.y), cmd: u.commandState, on: u._us.mvOn[u._si], path: u.path ? u.path.length + "@" + u.pathIndex : null, nld: u._us.mvNavLD[u._si], rk: u._routeKey, ppt: !!u._pendingPathTarget, tp: !!u.targetPos, end: u._us.rtEnd[u._si], hold: !!u.holdPosition })) : undefined;
        return { far, n, ends, before, t90start: r3(firstMove), t50: r3(t50), t90: r3(t90), t95: r3(t95), idealSlowest: r3(ideal), after, idle, packedR: r3(Math.sqrt(n / 0.9069) * 10.5 * 0.667) };`,
    rerally: `
        const crowd = blob(120, 30, 30, 1.2, ['norm', 'fast', 'tank']);
        simDk = DK;
        const cx = 30 * TILE + 16, cy = 30 * TILE + 16;
        let early = 0, late = 0, pen = 0, deep = 0, n = 0;
        for (let t = 0; t < ticksFor(60); t++) {
            if (t % Math.max(1, Math.round(5 / simDk)) === 0) processAction({ action: 'move', unitIds: crowd.map(u => u.id), targetX: cx, targetY: cy }, 0);
            step();
            const sec = (t + 1) * simDk / 20;
            if (sec > 15 && sec <= 20) { early += footprint(crowd).r; }
            if (sec > 55) { late += footprint(crowd).r; const o = overlapOf(crowd); pen += o.pen; deep += o.deep; n++; }
        }
        return { earlyR: r3(early / Math.max(1, ticksFor(5))), lateR: r3(late / n), pen: r3(pen / n), deepPerSample: r3(deep / n) };`,
};

const rows = [];
for (const name of list) for (const dk of dks) for (const seed of seeds) {
    const mapn = name === 'life' ? Number(process.env.MAP || 120) : 60;
    const world = new H.World({ controls: { ...H.SMALL_MATCH_CONTROLS, 'cfg-mapsize': String(mapn), 'cfg-map-type': 'arena' } });
    const inst = world.spawn(name + dk, { simWorker: false });
    inst.eval('startSoloGame();');
    // (Tunables to try: TUNE='UNIT_SEPARATION_RELAX_TICKS=6;...'.)
    if (process.env.TUNE) inst.eval(process.env.TUNE);
    const t0 = Date.now();
    const code = `JSON.stringify((() => { ${PRELUDE.replace('SEED', seed)} ${SCEN[name].replace(/DK/g, dk).replace(/MAPN/g, mapn).replace('BLOCKSPEC', JSON.stringify(process.env.BLOCK || '30x30'))} })())`;
    const r = JSON.parse(inst.eval(code));
    const row = { scenario: name, tps: 20 / dk, seed, ...r, ms: Date.now() - t0, errors: inst.errors.length };
    rows.push(row);
    console.log(JSON.stringify(row));
    if (process.env.OUT) fs.appendFileSync(process.env.OUT, JSON.stringify({ label: process.env.LABEL || '', ...row }) + '\n');
}
