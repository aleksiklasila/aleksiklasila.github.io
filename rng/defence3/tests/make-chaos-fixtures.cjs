// Lobby files for the chaos scenarios (.claude/tickbench.cjs CHAOS=...):
//   tests/chaos-queue-600.json: per team 5000 healers, a few thousand
//     collectors (energy and astar), builders, researchers, salvagers, a
//     small army; houses for a 200k pop cap; a 600x600 arena. The
//     buildings (barracks, worker buildings, labs) are placed by the
//     CHAOS setup, in patterns of its own.
//   tests/chaos-mixed-600.json: the same plus 30k combat units per team
//     (CHAOS=mixed puts them in thick lines between towers and traps).
//   node tests/make-chaos-fixtures.cjs
'use strict';
const fs = require('node:fs'), path = require('node:path');
const base = require('./100000-1000.json');
const workers = {
    'unit:healer_unit': { 6: 5000 },
    'unit:collector': { 5: 1500 },
    'unit:astar_collector': { 5: 1500 },
    'unit:builder_unit': { 5: 2000 },
    'unit:researcher_unit': { 9: 600 },
    'unit:salvager_unit': { 4: 300 },
    'unit:king': { 1: 1 },
    // (~110 pop each at level 10: ~220k, over the 200k cap.)
    'building:house': { 10: 2000 },
};
const army = {
    'unit:norm': { 4: 6000 }, 'unit:fast': { 4: 4000 }, 'unit:tank': { 4: 4000 }, 'unit:scout': { 4: 3000 },
    'unit:fire_resistant': { 4: 3000 }, 'unit:water_resistant': { 4: 3000 }, 'unit:ice_resistant': { 4: 2500 },
    'unit:laser_resistant': { 4: 2500 }, 'unit:flying': { 4: 2000 },
};
function make(file, counts, extra = {}, mapSize = '600') {
    const d = JSON.parse(JSON.stringify(base));
    d.createdAt = new Date(0).toISOString();
    Object.assign(d.lobby.numbers, { 'cfg-max-pop': 200000, 'cfg-gold-count': 2500, 'cfg-astar-mine-count': 2500 }, extra);
    d.lobby.selects['cfg-mapsize'] = mapSize;
    d.lobby.selects['cfg-map-type'] = 'arena';
    d.startingResources = { researchLevels: {}, spawnCounts: counts };
    fs.writeFileSync(path.join(__dirname, file), JSON.stringify(d, null, 1));
    let n = 0;
    for (const [k, v] of Object.entries(counts)) if (k.startsWith('unit:')) for (const c of Object.values(v)) n += c;
    console.log(file, 'units per team', n);
}
make('chaos-queue-600.json', { ...workers, 'unit:norm': { 4: 2000 } });
make('chaos-mixed-600.json', { ...workers, ...army });
// The larger one (CHAOS=mega): a 1000x1000 map, the workers half again, the
// army ~70k a team (lines across the middle, raiding blocks into the bases).
const big = (m, k) => Object.fromEntries(Object.entries(m).map(([id, lv]) => [id, Object.fromEntries(Object.entries(lv).map(([l, n]) => [l, id === 'unit:king' ? n : Math.round(n * k)]))]));
// (Every combat unit type: the rarer ones too.)
const armyRest = { 'unit:boss': { 4: 600 }, 'unit:mole': { 4: 2500 }, 'unit:snake': { 3: 400 }, 'unit:poison_resistant': { 4: 2500 } };
make('chaos-mega-1000.json', { ...big(workers, 1.5), 'building:house': { 10: 2500 }, ...big(army, 2.3), ...armyRest }, { 'cfg-gold-count': 5000, 'cfg-astar-mine-count': 5000, 'cfg-max-pop': 250000 }, '1000');
// MEGA_SCALE=k (env): the mega lobby with every count k times (k=2: ~340k
// units at the start; k=0.5 for two peers in one process), as
// tests/chaos-mega<k>x-1000.json.
for (const k of (process.env.MEGA_SCALE || '').split(',').map(Number).filter(v => v > 0 && v !== 1)) {
    make('chaos-mega' + k + 'x-1000.json', { ...big(workers, 1.5 * k), 'building:house': { 10: Math.round(2500 * k) }, ...big(army, 2.3 * k), ...big(armyRest, k) },
        { 'cfg-gold-count': 5000, 'cfg-astar-mine-count': 5000, 'cfg-max-pop': Math.round(250000 * k) }, '1000');
}
