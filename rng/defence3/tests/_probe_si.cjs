'use strict';
const H = require('./net-harness.cjs');
(async () => {
    const c = { size: 20, map: 'arena', teams: 8, count: 3, type: 'norm', mines: 0 };
    const controls = { ...H.SMALL_MATCH_CONTROLS, 'cfg-mapsize': String(c.size), 'cfg-map-type': c.map, 'cfg-gold-count': '0', 'cfg-astar-mine-count': '0', 'cfg-max-pop': '100000', 'cfg-starting-energy': '1000000000', 'cfg-starting-astar': '1000000000', 'cfg-full-vis': 'history' };
    const world = new H.World({ controls, network: { latencyMs: 40, jitterMs: 12 }, hashEvery: 1, exactHashes: true });
    const spawnCounts = { 'unit:king': { 1: 1 }, 'unit:norm': { 1: 3 }, 'building:house': { 8: 1 }, 'building:spawner': { 1: 1 } };
    try { await H.startHostedMatch(world, { guests: 7, teams: [0, 1, 2, 3, 4, 5, 6, 7], maxMs: 60000, hostSetup: 'startingResourcesConfig=' + JSON.stringify({ researchLevels: {}, spawnCounts }) }); console.log('started'); }
    catch (e) { console.log(String(e).slice(0, 300)); }
    for (const i of world.instances) console.log(i.name, 'errors', JSON.stringify(i.errors.map(e => String(e.stack || e).slice(0, 400))).slice(0, 1200), 'warn', JSON.stringify(i.warnings.slice(-4).map(w => w.a.map(x => typeof x === 'object' ? JSON.stringify(x).slice(0, 200) : String(x)).join(' '))).slice(0, 800));
    process.exit(0);
})();
