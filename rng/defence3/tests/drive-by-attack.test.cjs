const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'src/things/unit.js'), 'utf8');
let candidates = [];
const attacks = [];
const context = {
    TILE: 32,
    GRID_W: 1, GRID_H: 1, grid: [[{}]],
    towers: [], barracks: [], collectorSpawners: [],
    gameTime: 1, pathTopologyVersion: 1, localPlayerId: 0,
    getRawVisibilityGridForPlayer: () => [[1]],
    getAreaIdAtWorld: () => 0,
    getAreaDistance: () => 0,
    isGameplayTargetVisibleToPlayer: (_owner, gx) => gx !== 9,
    forEachUnitInAreaRange: (_x, _y, _range, visit, opts) => {
        assert.equal(opts.areaOnly, true, 'the scan must use the same area-based attack range as combat');
        for (const unit of candidates) if (!unit.dead && unit.owner !== opts.enemyOfPlayer) visit(unit);
    }
};
vm.createContext(context);
vm.runInContext(source, context);
const Unit = vm.runInContext('Unit', context);
const moving = vm.runInContext('CMD_MOVING', context);

function makeUnit(type = 'norm') {
    const unit = Object.create(Unit.prototype);
    Object.assign(unit, {
        id: 1, owner: 0, x: 0, y: 0, unitType: type, commandState: moving,
        workerState: null, preComputed: { attackDamage: 5, attackRangeArea: 1 },
        attackTimer: 0, path: [{ x: 1, y: 0 }], pathIndex: 0,
        _performAttackOnUnit(target) { attacks.push(target.id); this.attackTimer = 5; }
    });
    return unit;
}

const unit = makeUnit();
candidates = [
    { id: 4, owner: 1, x: 6, y: 0 },
    { id: 3, owner: 1, x: 6, y: 0 },
    { id: 2, owner: 1, x: 2, y: 0, gx: 9 },
    { id: 5, owner: 0, x: 1, y: 0 }
];
unit.tryDriveByAttack();
assert.deepEqual(attacks, [3], 'equal-distance targets resolve by stable unit id');
assert.equal(unit.commandState, moving);
assert.equal(unit.pathIndex, 0);
const peer = makeUnit();
candidates.reverse();
peer.tryDriveByAttack();
assert.deepEqual(attacks, [3, 3], 'peer bucket order must not change the target');
unit.tryDriveByAttack();
assert.deepEqual(attacks, [3, 3], 'attack cooldown prevents repeated hits');

let followedSpeed = 0;
unit.followPath = speed => { followedSpeed = speed; return false; };
unit.doMoving(4);
assert.equal(followedSpeed, 4, 'the original path continues at full speed');
assert.equal(unit.commandState, moving);
assert.equal(unit.pathIndex, 0);

const scout = makeUnit('scout');
scout.tryDriveByAttack();
scout.followPath = speed => { followedSpeed = speed; return false; };
scout.doMoving(4);
assert.equal(followedSpeed, 4, 'scouts also continue at full speed');

const worker = makeUnit();
worker.workerState = 'MANUAL_MOVE';
worker.tryDriveByAttack();
assert.deepEqual(attacks, [3, 3, 3], 'working units do not attack');

const holding = vm.runInContext('CMD_HOLDING', context);
const sentry = makeUnit();
sentry.commandState = holding;
sentry.preComputed.attackRange = 32;
const heldPath = sentry.path;
sentry.doHolding();
assert.deepEqual(attacks, [3, 3, 3, 3], 'holding units attack visible enemies in range');
assert.equal(sentry.commandState, holding);
assert.equal(sentry.path, heldPath, 'hold attacks never replace the movement order');
assert.equal(vm.runInContext('canUnitAutoRetaliate', context)(sentry), false,
    'damage cannot make a holding unit chase its attacker');

candidates = [];
const tower = { owner: 1, energy: 10, x: 4, y: 0, gx: 0, gy: 0 };
context.towers.push(tower);
sentry.attackTimer = 0;
sentry._performAttackOnBuilding = target => { assert.equal(target, tower); attacks.push('tower'); };
sentry.doHolding();
assert.equal(attacks.at(-1), 'tower', 'holding units attack hostile structures in range');
assert.equal(sentry.commandState, holding);

console.log('PASS: travelling and holding attacks respect range, cooldowns, fixed positions, and deterministic targets.');
