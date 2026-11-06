'use strict';
// findNearestWalkable by the kernel (wasm/src/tch.rs k_nearest_walk) answers
// as the JavaScript ring search did (kept here as the reference, over
// pathfinding.js isWalkableTileFor): for no unit, ground units, flyers,
// builders, collectors (mines) and cloud towers' owners, from walls,
// structures, mines and open ground, with and without a "from" tile, through
// a chaos scene's walls and buildings.
// Usage: node tests/nearest-walkable-kernel.test.cjs
const assert = require('node:assert/strict'), H = require('./net-harness.cjs'), chaos = require('./chaos-spikes-scenario.cjs');
globalThis.self = { crossOriginIsolated: true };
const controls = { ...H.SMALL_MATCH_CONTROLS, 'cfg-mapsize': '192', 'cfg-map-type': 'islands', 'cfg-gold-count': '200', 'cfg-astar-mine-count': '200', 'cfg-max-pop': '20000', 'cfg-starting-energy': '1000000000000', 'cfg-starting-astar': '1000000000000' };
const world = new H.World({ controls }), i = world.spawn('nw', { controls, simWorker: false });
i.eval(`MAX_THING_LEVEL=20;MAX_RESEARCH_LEVEL=10;startingResourcesConfig=normalizeStartingResourcesConfig({spawnCounts:{'unit:king':{1:1},'unit:norm':{6:300},'unit:builder_unit':{4:30},'unit:collector':{2:30},'unit:flying':{1:20}},researchLevels:{}});applyMainMenuControlsToRuntimeState();startSoloGame();simDk=20;netStepTicks=()=>20;`);
const setup = JSON.parse(i.eval('JSON.stringify(' + chaos.setup({ mode: 'mega', layout: 'mixed', buildings: 50, level: 6, towerSites: 30, collectorBuildings: 20, structures: 3000 }) + ')'));
assert.deepEqual(setup.errors, []);
for (let k = 0; k < 20; k++) i.eval('gameTick();currentTick++');
const r = JSON.parse(i.eval(`(() => {
    // The JavaScript ring search (unit.js before the kernel), uncached.
    const ref = (gx, gy, fromGx, fromGy, unit) => {
        if (isWalkableTileFor(unit, gx, gy)) return [gx, gy];
        const hasFrom = Number.isFinite(fromGx) && Number.isFinite(fromGy), maxR = Math.max(GRID_W, GRID_H);
        for (let r = 1; r <= maxR; r++) {
            const tiles = [];
            for (let x = gx - r; x <= gx + r; x++) { if (isWalkableTileFor(unit, x, gy - r)) tiles.push(x, gy - r); if (isWalkableTileFor(unit, x, gy + r)) tiles.push(x, gy + r); }
            for (let y = gy - r + 1; y <= gy + r - 1; y++) { if (isWalkableTileFor(unit, gx - r, y)) tiles.push(gx - r, y); if (isWalkableTileFor(unit, gx + r, y)) tiles.push(gx + r, y); }
            if (!tiles.length) continue;
            if (!hasFrom) return [tiles[0], tiles[1]];
            let bx = tiles[0], by = tiles[1], bd = detHypot(bx - fromGx, by - fromGy);
            for (let j = 2; j < tiles.length; j += 2) { const x = tiles[j], y = tiles[j + 1], d = detHypot(x - fromGx, y - fromGy); if (d < bd || (d === bd && (y < by || (y === by && x < bx)))) { bx = x; by = y; bd = d; } }
            return [bx, by];
        }
        return [Math.max(0, Math.min(GRID_W - 1, gx)), Math.max(0, Math.min(GRID_H - 1, gy))];
    };
    let s = 11; const rnd = n => { s = (s * 16807) % 2147483647; return s % n; };
    // (A builder, a salvager: made if the scene has none.)
    for (const ty of ['builder_unit', 'salvager_unit']) if (!units.some(u => !u.dead && u.unitType === ty)) { const t = findNearestWalkable(GRID_W >> 1, GRID_H >> 1); const u = new Unit(ty, 0, t.x * TILE + 16, t.y * TILE + 16); configureWorkerUnitFromType(u); units.push(u); updateUnitSpatial(u); }
    const pick = f => { const L = units.filter(f); return L.length ? L[rnd(L.length)] : null; };
    const kinds = [() => null, () => pick(u => !u.dead && !u.workerType && !u.isFlying), () => pick(u => !u.dead && u.isFlying),
        () => pick(u => !u.dead && (u.workerType === 'builder' || u.workerType === 'salvager')), () => pick(u => !u.dead && isResourceCollectorWorkerType(u.workerType))];
    // Targets: structures' and mines' tiles, walls, anywhere.
    const targets = [];
    for (const L of [towers, barracks, collectorSpawners, goldMines, astarMines]) for (let j = 0; j < Math.min(60, L.length); j++) { const e = L[rnd(L.length)]; if (e) targets.push([e.gx, e.gy]); }
    for (let j = 0; j < 400; j++) targets.push([rnd(GRID_W), rnd(GRID_H)]);
    let n = 0, moved = 0; const bad = [], seen = new Set();
    for (const [gx, gy] of targets) for (let kk = 0; kk < kinds.length; kk++) {
        const u = kinds[kk]();
        if (kk && !u) continue;
        seen.add(kk);
        for (const from of [null, [rnd(GRID_W), rnd(GRID_H)]]) {
            const a = ref(gx, gy, from ? from[0] : undefined, from ? from[1] : undefined, u), b = findNearestWalkable(gx, gy, from ? from[0] : undefined, from ? from[1] : undefined, u);
            n++; if (a[0] !== gx || a[1] !== gy) moved++;
            if (a[0] !== b.x || a[1] !== b.y) bad.push([kk, gx, gy, from, a, [b.x, b.y], u && u.workerType]);
        }
    }
    return JSON.stringify({ n, moved, kinds: [...seen], bad: bad.slice(0, 10), nbad: bad.length }); })()`));
assert.deepEqual(r.bad, [], 'kernel answers differ from the ring search ' + JSON.stringify(r));
assert.ok(r.n > 2000 && r.moved > 200 && r.kinds.length === 5, JSON.stringify(r));
assert.deepEqual(i.errors.map(String), []);
console.log('PASS: k_nearest_walk equals the JavaScript ring search (' + r.n + ' queries, ' + r.moved + ' moved off their tile)');
