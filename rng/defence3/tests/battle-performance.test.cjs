const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const renderer = read('src/audio_visual/renderer.js');
const worker = read('src/things/worker.js');
function functionSource(source, name) {
    const start = source.indexOf(`function ${name}(`);
    const end = source.indexOf('\nfunction ', start + 1);
    return source.slice(start, end < 0 ? undefined : end);
}

// Compare indexed occupancy against the original exhaustive fallback, including
// reservation changes between searches within the same simulation tick.
let visits = 0;
const allUnits = [];
const wc = vm.createContext({
    TILE: 32, GRID_W: 80, GRID_H: 64, RESOURCE_COLLECTOR_UNIT_KEYS: ['collector', 'astar_collector'],
    units: { *[Symbol.iterator]() { for (const u of allUnits) { visits++; yield u; } } }
});
vm.runInContext(worker, wc);
const referencePick = vm.runInContext('(' + functionSource(worker, '_pickDistributedWorkerCandidate')
    .replace('_canAssignWorkerTargetExclusive(u, c.target, targetType, conflictCache)', '_canAssignWorkerTargetExclusive(u, c.target, targetType)') + ')', wc);
const candidates = Array.from({ length: 600 }, (_, i) => ({
    target: { gx: i % 80, gy: Math.floor(i / 80), id: i, x: i % 80 * 32, y: Math.floor(i / 80) * 32 },
    targetType: i % 3 ? null : 'queue', dist: (i * 23) % 700
}));
for (let i = 0; i < 1200; i++) allUnits.push({
    id: i + 2, owner: i % 3, workerType: ['builder', 'healer', 'researcher'][Math.floor(i / 3) % 3],
    dead: i % 19 === 0, workerTarget: i % 7 === 0 ? null : candidates[i % candidates.length].target
});
const searching = { id: 1, owner: 0, workerType: 'builder' };
visits = 0;
const expected = referencePick(searching, candidates);
const oldVisits = visits;
visits = 0;
assert.equal(wc._pickDistributedWorkerCandidate(searching, candidates), expected);
assert.equal(visits, 1200, 'only one unit-list traversal per candidate search');
assert.ok(oldVisits > 1200 * 100, 'fixture exercises the original nested scans');
for (let i = 0; i < 40; i++) {
    searching.owner = i % 3;
    searching.workerType = ['builder', 'healer', 'researcher'][i % 3];
    searching.workerTarget = i % 2 ? candidates[i].target : null;
    searching.workerTargetType = candidates[i].targetType;
    allUnits[i].dead = !allUnits[i].dead;
    allUnits[i + 1].workerTarget = candidates[599 - i].target;
    wc._invalidateWorkerTargetLoadCache();
    // Some slots are reserved, including dead, same-team and opposing workers.
    wc.reserving = allUnits[i + 2]; wc.reservedTarget = candidates[i + 5].target;
    vm.runInContext('workerReservedTiles[_getWorkerReservationSlotIndex(reservedTarget, reserving.workerType)] = reserving;', wc);
    assert.equal(wc._pickDistributedWorkerCandidate(searching, candidates), referencePick(searching, candidates));
}

// Use an independent, deliberately redundant tile union as the reference.
// Float32 propagation and source collection run unchanged in both versions.
const visibility = functionSource(renderer, 'computeVisibilityGridForPlayer');
const unionStart = visibility.indexOf('    // The range caches');
const unionEnd = visibility.indexOf('    for (let y = 0; y < GRID_H; y++) {', unionStart);
assert.ok(unionStart >= 0 && unionEnd > unionStart);
const referenceVisibility = visibility.slice(0, unionStart) + `
    for (const [areaId, range] of areaRangeBySourceArea) {
        for (const cell of getGridCellsWithinAreaDistance(areaId, Math.floor(Math.max(0, Number(range) || 0)))) {
            if (cell) includedTiles[cell.y][cell.x] = 1;
        }
    }
` + visibility.slice(unionEnd);
const areas = Array.from({ length: 64 }, () => []);
for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) areas[Math.floor(y / 8) * 8 + Math.floor(x / 8)].push({ x, y });
const world = {
    TILE: 32, GRID_W: 64, GRID_H: 64, AREA_UNIT_TILE_EQUIVALENT: 4,
    units: [], towers: [], barracks: [], collectorSpawners: [], gridCellsByArea: areas,
    grid: Array.from({ length: 64 }, () => Array.from({ length: 64 }, () => ({}))),
    getEntityEffectiveVisibilityRangeArea: b => b.range ?? b.currentStats?.visionRange ?? b.preComputed?.visionRangeArea ?? .6,
    getAreaIdAtTile(x, y) { return x < 0 || y < 0 || x >= 64 || y >= 64 ? -1 : Math.floor(y / 8) * 8 + Math.floor(x / 8); },
    getAreaIdAtWorld(x, y) { return x < 0 || y < 0 || x >= 2048 || y >= 2048 ? -1 : Math.floor(y / 256) * 8 + Math.floor(x / 256); },
    getAreaIdsWithinDistance(area, range) {
        return areas.map((_, i) => i).filter(i => Math.abs(i % 8 - area % 8) + Math.abs(Math.floor(i / 8) - Math.floor(area / 8)) <= range);
    },
    getGridCellsWithinAreaDistance(area, range) { return this.getAreaIdsWithinDistance(area, range).flatMap(i => areas[i]); }
};
// Global calls do not bind the context as `this` in every VM configuration.
world.getGridCellsWithinAreaDistance = (area, range) => world.getAreaIdsWithinDistance(area, range).flatMap(i => areas[i]);
for (let i = 0; i < 1200; i++) world.units.push({
    owner: i % 3, x: (i * 113) % 2048, y: (i * 73) % 2048,
    watched: i % 2, watchedByTeam: (i + 1) % 3, preComputed: { visionRangeArea: 2 + i % 3 * .5 }
});
world.towers = world.units.slice(0, 200).map(u => ({ ...u, energy: 10, currentStats: { visionRange: 2 } }));
world.barracks = world.units.slice(200, 400).map(u => ({ ...u, energy: 10, range: 1.5 }));
world.collectorSpawners = world.units.slice(400, 600).map(u => ({ ...u, energy: 10, range: 2 }));
for (let i = 0; i < 64; i++) world.grid[i][i] = { owner: i % 3, item: { gx:i, gy:i, energy: 10, watched: i % 2, watchedByTeam: (i + 1) % 3 } };
const vc = vm.createContext({ ...world }), refVc = vm.createContext({ ...world });
const sourceAreas = functionSource(read('src/data/data_state.js'), 'addVisibilitySourceAreas');
vm.runInContext(sourceAreas, vc);
vm.runInContext(sourceAreas, refVc);
// Reverse index order, include stale entries and non-floor entities. The
// exhaustive reference must still agree bit-for-bit for every player.
vc._activeTileEntities = new Set(world.grid.map((row,i) => row[i].item).reverse());
vc._activeTileEntities.add({gx:0,gy:0,energy:100});
vc._activeTileEntities.add({gx:12,gy:13,energy:100});
vm.runInContext('let visibilityIncludedTilesScratch = [];\n' + visibility, vc);
vm.runInContext('let visibilityIncludedTilesScratch = [];\n' + referenceVisibility, refVc);
const grid = () => Array.from({ length: 64 }, () => new Float32Array(64));
for (let step = 0; step < 18; step++) {
    const a = grid(), b = grid();
    vc.computeVisibilityGridForPlayer(step % 3, a);
    refVc.computeVisibilityGridForPlayer(step % 3, b);
    assert.deepEqual(a, b, 'area deduplication must preserve every Float32 visibility value');
    world.units[step].dead = true;
    world.units[step + 20].x += 64;
    world.units[step + 40].watched = 0;
    world.towers[step].underConstruction = true;
    world.grid[step][step].item.underConstruction = true;
    world.grid[step + 20][step + 20].owner = step % 3;
}

// A visible set above 1024 must settle, rather than continuously rasterize.
let rasterizations = 0;
const tc = vm.createContext({
    RENDERER3D_TOP_TEXTURE_SIZE: 96, TILE: 32, gameTime: 5,
    shouldShowBuildingLevels: () => false, shouldShowUnitLevels: () => false,
    get3DUnitStatusGlyph: () => null, performance: { now: () => 0 },
    document: { createElement() { return { getContext() { return { setTransform() {}, clearRect() {}, save() {}, restore() {} }; } }; } }
});
vm.runInContext(renderer.slice(renderer.indexOf('const renderer3dExact2DTextureCache'), renderer.indexOf('function get3DExact2DFloorTexture')), tc);
const panels = Array.from({ length: 1500 }, (_, i) => ({
    x: 32, y: 32, r: 8, owner: 0, unitType: 'norm', color: '#' + i.toString(16).padStart(6, '0'),
    energy: 10, preComputed: { maxEnergy: 10 }, attackFlash: 0,
    attackTarget: { x: 40, y: 40 }, draw() { rasterizations++; }
}));
const renderPanels = visiblePanels => {
    tc.begin3DTextureFrame();
    vm.runInContext('renderer3dExactUnitTextureBuildsRemaining = 2000; renderer3dExactUnitTextureTimeRemaining = 1000;', tc);
    return visiblePanels.map(p => tc.get3DExact2DTexture(p, true));
};
const firstFrame = renderPanels(panels);
for (let frame = 0; frame < 5; frame++) {
    for (const p of panels) p.attackTarget.x += 8;
    assert.deepEqual(renderPanels(panels), firstFrame);
}
assert.equal(rasterizations, 1500, 'no repeated rasterization for the visible set, even with moving remembered targets');
panels[0].attackFlash = 8;
const attackFrame = renderPanels(panels);
assert.notEqual(attackFrame[0], firstFrame[0], 'active attack still updates the displayed panel');
panels[0].attackTarget.x += 16;
assert.notEqual(renderPanels(panels)[0], attackFrame[0], 'active attack direction still invalidates the panel');
for (let frame = 0; frame < 4; frame++) renderPanels(panels.slice(0, 10));
assert.equal(vm.runInContext('renderer3dExact2DTextureCache.size', tc), 1024, 'inactive panels return to the normal cache budget');
console.log(`PASS: worker search visits ${oldVisits} -> 1200; 18 visibility comparisons; 1500 stable panels rasterize once across 6 frames.`);
