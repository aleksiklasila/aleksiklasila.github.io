const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
function functionSource(source, name) {
    const start = source.indexOf(`function ${name}(`);
    assert.ok(start >= 0, name);
    let depth = 0, i = source.indexOf('{', start);
    for (; i < source.length; i++) {
        if (source[i] === '{') depth++;
        else if (source[i] === '}' && --depth === 0) break;
    }
    return source.slice(start, i + 1) + '\n';
}

// 8x4 map: areas are 2x2 tile blocks (ids by block), distance = block steps.
const W = 8, H = 4, TILE = 32;
const areaOf = (x, y) => (x < 0 || y < 0 || x >= W || y >= H) ? -1 : Math.floor(y / 2) * 4 + Math.floor(x / 2);
const cellsByArea = Array.from({ length: 8 }, () => []);
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) cellsByArea[areaOf(x, y)].push({ x, y });
const blockDistance = (a, b) => Math.abs(a % 4 - b % 4) + Math.abs(Math.floor(a / 4) - Math.floor(b / 4));
const grid = Array.from({ length: H }, () => Array.from({ length: W }, () => ({ item: null, owner: -1 })));
const tileTowers = new Map();
const ctx = vm.createContext({
    TILE, GRID_W: W, GRID_H: H, grid, gridCellsByArea: cellsByArea, towers: [], barracks: [], collectorSpawners: [],
    getAreaIdAtTile: areaOf,
    isAreaWithinDistance: (a, b, max) => blockDistance(a, b) <= max,
    getAreaIdsWithinDistance: (a, max) => cellsByArea.map((_, i) => i).filter(i => blockDistance(a, i) <= max),
    getGridCellsWithinAreaDistance: (a, max) => cellsByArea.filter((_, i) => blockDistance(a, i) <= max).flat(),
    getTowerAtTile: (x, y) => tileTowers.get(y * W + x) || null,
    isGameplayTargetVisibleToPlayer: () => true,
    // Live structures by area, as the tile entity index provides them.
    getStructuresByArea: () => {
        const byArea = [];
        const add = e => (byArea[areaOf(e.gx, e.gy)] ||= []).push(e);
        for (const row of grid) for (const c of row) if (c.item) add(c.item);
        for (const t of tileTowers.values()) add(t);
        return byArea;
    },
    gameTime: 0, areaIdsWithinDistance: [], areaDistanceMatrix: new Array(8),
});
const state = read('src/data/data_state.js');
vm.runInContext(functionSource(state, 'getAreaIdAtWorld')
    + state.slice(state.indexOf('const _EMPTY_SOURCE_AREAS'), state.indexOf('function getAreaDistance(')), ctx);

// The +-0.3 tile window: a unit 0.2 tiles from the block edge ranges from both
// blocks, exactly the areas visibility and the range overlay stamp.
assert.deepEqual([...ctx.getSourceAreaIdsAtWorld(1.9 * TILE, 0.5 * TILE)], [0, 1]);
assert.deepEqual([...ctx.getSourceAreaIdsAtWorld(1.5 * TILE, 0.5 * TILE)], [0], 'inside the window only one block');
assert.equal(ctx.getSourceAreaIdsAtWorld(1.5 * TILE, 0.5 * TILE), ctx.getSourceAreaIdsAtWorld(1.4 * TILE, 1.5 * TILE), 'single-area lists are shared');
assert.deepEqual([...ctx.getSourceAreaIdsAtWorld(1.9 * TILE, 1.9 * TILE)], [0, 1, 4, 5], 'corner windows cover four blocks');
assert.equal(ctx.isWorldTargetWithinAreaRange(1.9 * TILE, 0.5 * TILE, 2.5 * TILE, 0.5 * TILE, 0), true, 'padded neighbour is in range');
assert.equal(ctx.isWorldTargetWithinAreaRange(1.5 * TILE, 0.5 * TILE, 2.5 * TILE, 0.5 * TILE, 0), false);
assert.deepEqual([...ctx.getAreaIdsWithinDistanceOfSources([0, 1], 0)], [0, 1]);
assert.deepEqual([...ctx.getAreaIdsWithinDistanceOfSources([1, 0], 1)], [0, 1, 2, 5, 4], 'union keeps first-source order, each area once');

// Unit structure priority within attack range.
vm.runInContext(read('src/things/unit.js'), ctx);
const Unit = vm.runInContext('Unit', ctx);
const place = (x, y, props) => {
    const item = { gx: x, gy: y, x: x * TILE + 16, y: y * TILE + 16, energy: 10, owner: 1, ...props };
    if (props.tower) tileTowers.set(y * W + x, item);
    else { grid[y][x].item = item; grid[y][x].owner = item.owner; }
    return item;
};
const unit = Object.assign(Object.create(Unit.prototype), { id: 1, owner: 0, x: 1.9 * TILE, y: 0.5 * TILE,
    preComputed: { attackRangeArea: 0.1 }, path: null, pathIndex: 0 });
const farm = place(0, 1, { type: 'farm' });
assert.equal(ctx._findHostileStructureInAttackRange(unit), farm, 'any hostile building in reach');
const lavaOff = place(1, 1, { type: 'lava' });
assert.equal(ctx._findHostileStructureInAttackRange(unit), lavaOff, 'traps before other buildings');
const lavaOn = place(3, 1, { type: 'poison_puddle' });
assert.equal(ctx._findHostileStructureInAttackRange(unit), lavaOff, 'nearest trap when no route');
unit.path = [{ x: 1, y: 0 }, { x: 2, y: 0 }, { x: 3, y: 0 }, { x: 3, y: 1 }];
unit.pathIndex = 1;
assert.equal(ctx._findHostileStructureInAttackRange(unit), lavaOn, 'traps on the route first (padding reaches block 1)');
const turret = place(3, 0, { type: 'pistol', tower: true });
assert.equal(ctx._findHostileStructureInAttackRange(unit), turret, 'turrets first');
turret.energy = 0;
place(3, 0, { type: 'cloud_0a', tower: true });
assert.equal(ctx._findHostileStructureInAttackRange(unit), lavaOn, 'portals are not turrets');
place(0, 0, { type: 'lava', owner: 0 });
unit.x = 0.5 * TILE;
unit.path = null;
assert.equal(ctx._findHostileStructureInAttackRange(unit), lavaOff, 'own structures are ignored; out-of-window blocks are not in reach');

// Projectiles hit the floor item they were aimed at, and floor items never
// intercept shots aimed elsewhere.
const pc = vm.createContext({ TILE, towers: [], barracks: [], collectorSpawners: [], forEachUnitInRange: () => false,
    getFloorItemAtTile: (x, y) => grid[y] && grid[y][x] && grid[y][x].item, createExplosion() {}, playSound() {},
    pushHostileDamageAlert() {}, recordDamageVisual() {}, applyStatusEffect() {}, isEffectImmune: () => false,
    destroyed: [], destroyBuilding(b) { pc.destroyed.push(b); } });
vm.runInContext(read('src/things/projectile.js') + '\nthis.Projectile = Projectile;', pc);
const shot = new pc.Projectile(0.5 * TILE, 1.5 * TILE, lavaOn, 'pistol', 25, 1, { owner: 0, gx: 0, gy: 1 }, 999);
let flying = 0;
while (shot.update()) flying++;
assert.ok(lavaOn.energy <= 0 && pc.destroyed.includes(lavaOn), 'aimed floor target is hit and destroyed');
assert.equal(lavaOff.energy, 10, 'the trap it flew over was not hit');
const miss = new pc.Projectile(0.5 * TILE, 1.5 * TILE, { x: 7 * TILE, y: 1.5 * TILE }, 'pistol', 25, 1, { owner: 0, gx: 0, gy: 1 }, 7 * TILE);
while (miss.update());
assert.equal(lavaOff.energy, 10, 'shots at other targets pass over floor items');
console.log(`PASS: +-0.3 tile source windows, structure threat order (turret > route trap > trap > building), floor-target projectiles (${flying} ticks).`);
