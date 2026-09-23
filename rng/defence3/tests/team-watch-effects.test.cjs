const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const read = (relativePath) => fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');
const renderer = read('src/audio_visual/renderer.js');
const unit = read('src/things/unit.js');
const tower = read('src/things/tower.js');
const dataStatic = read('src/data/data_static.js');
const dataDynamic = read('src/data/data_dynamic.js');
const main = read('src/main.js');

const statusStart = renderer.indexOf('function ensureStatusState(');
const statusEnd = renderer.indexOf('function ensureLevelTextCanvas(', statusStart);
assert.ok(statusStart >= 0 && statusEnd > statusStart, 'status-effect implementation should be extractable');

const context = {
    BASE_UNIT_STATS: { scout: { watchDuration: 5 } },
    localPlayerId: 0,
    clampThingLevel: value => Math.max(1, Math.floor(Number(value) || 1)),
    getUnitStatForOwner: (_owner, type, level, stat) => type === 'scout' && stat === 'watchDuration' ? 4 + level : NaN,
    getBuildingStatForOwner: (_owner, type, level, stat) => type === 'watch_tower' && stat === 'watchDuration' ? 4 + level : NaN,
    secondsToTicks: seconds => Math.round(seconds * 10),
    recordDamageVisual: () => {},
};
vm.createContext(context);
vm.runInContext(renderer.slice(statusStart, statusEnd), context);

const target = { energy: 10 };
context.applyStatusEffect(target, 'watch', 1, 0, 2, 'watch_tower');
assert.equal(target.watched, 50);
assert.equal(target.watchedByTeam, 2);

target.watched = 40;
context.applyStatusEffect(target, 'watch', 1, 0, 2, 'watch_tower');
assert.equal(target.watched, 50, 'same team should extend to the longer duration');
assert.equal(target.watchedByTeam, 2);

target.watched = 49;
context.applyStatusEffect(target, 'watch', 3, 0, 1, 'scout');
assert.equal(target.watched, 70, 'another team should replace the previous duration');
assert.equal(target.watchedByTeam, 1, 'another team should take exclusive ownership of reveal');

target.watched = 1;
context.tickStatusEffects(target);
assert.equal(target.watched, 0);
assert.equal(target.watchedByTeam, -1, 'expired reveal should clear its team');

assert.match(renderer, /watchedByTeam\)\) === targetId/);
assert.match(unit, /this\.unitType === 'scout'\) applyStatusEffect\(target, 'watch'/);
assert.match(unit, /this\.unitType === 'scout'\) applyStatusEffect\(tb, 'watch'/);
assert.match(tower, /u\.watchedByTeam === this\.owner/);
assert.match(dataStatic, /scout: \{[^\n]*watchDuration: 5/);
assert.match(dataStatic, /scout: \['energy'[^\n]*'watchDuration'/);
assert.match(dataDynamic, /let watchDuration = unitType === 'scout'/);
assert.match(main, /watchedByTeam:/, 'team watch ownership should be covered by the lockstep digest');

console.log('PASS: watch effects are team-exclusive, replaceable, deterministic, and granted by scouts.');
