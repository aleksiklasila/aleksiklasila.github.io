// main.js _sortedForDeterministicOrder (cached, numeric keys, removals kept)
// gives exactly list.slice().sort(_compareThingsDeterministic) for building
// lists: ids or none, owners, type strings (unitType first), tiles, nulls;
// through removals, additions and reorders.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const src = fs.readFileSync(path.join(__dirname, '../src/main.js'), 'utf8');
const ctx = vm.createContext({ TILE: 32, Map, Set });
vm.runInContext(src.slice(src.indexOf('function _stableNumberOr'), src.indexOf('// Units update in a fresh deterministic order each tick')), ctx);
const sorted = vm.runInContext('_sortedForDeterministicOrder', ctx), cmp = vm.runInContext('_compareThingsDeterministic', ctx);
let seed = 7;
const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
const types = ['laser', 'fire', 'ice', 'barrack', 'spawner', 'Zeta', 'a', ''];
const make = k => ({ id: rnd() < 0.3 ? Math.floor(rnd() * 50) : undefined, owner: Math.floor(rnd() * 3), type: types[Math.floor(rnd() * types.length)],
    unitType: rnd() < 0.2 ? types[Math.floor(rnd() * types.length)] : undefined, gx: Math.floor(rnd() * 30), gy: Math.floor(rnd() * 30), k });
let checks = 0;
for (let round = 0; round < 200; round++) {
    let list = Array.from({ length: Math.floor(rnd() * 300) }, (_, k) => make(k));
    if (rnd() < 0.2) list.splice(Math.floor(rnd() * list.length), 0, null);
    for (let step = 0; step < 6; step++) {
        const got = sorted(round % 3, list), want = list.slice().sort(cmp);
        assert.deepEqual(Array.from(got, e => e && e.k), want.map(e => e && e.k), `round ${round} step ${step}`);
        checks++;
        const r = rnd();
        if (r < 0.4) list = list.filter(() => rnd() > 0.1);                       // removals
        else if (r < 0.6) list.push(make(1000 + step));                          // an addition
        else if (r < 0.7) list = list.slice().reverse();                         // a reorder
    }
}
console.log('PASS: cached deterministic building order equals the comparator sort (' + checks + ' checks)');
