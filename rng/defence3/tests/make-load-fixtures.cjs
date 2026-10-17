'use strict';
// Import these through the real game's Import Settings button.
const fs = require('node:fs'), path = require('node:path');
const { balancedFixture } = require('./load-fixtures.cjs');

function settingsFor(units) {
    const spec = balancedFixture({ units, statics: 200000, map: 1000 });
    return {
        version: 4,
        description: `${units.toLocaleString('en-US')} total units, 200,000 total buildings/items, two teams, 1000x1000. One king and one of each portal endpoint per team. Other types evenly distributed.`,
        loadTest: { ...spec, spawnCounts: undefined },
        lobby: {
            numbers: { 'cfg-max-pop': units / 2, 'cfg-starting-energy': 1000000000000,
                'cfg-starting-astar': 1000000000000, 'cfg-gold-count': 0, 'cfg-astar-mine-count': 0,
                'cfg-tick-rate': 20, 'cfg-pipeline-delay': 2 },
            selects: { 'cfg-mapsize': '1000', 'cfg-map-type': 'arena', 'cfg-full-vis': 'full', 'cfg-gamemode': 'destroy' },
            checks: { 'cfg-net-auto': true, 'cfg-exact-lockstep': false }
        },
        startingResources: { researchLevels: {}, spawnCounts: spec.spawnCounts }
    };
}
if (require.main === module) for (const millions of [2, 4, 8]) {
    const file = path.join(__dirname, `load-${millions}m-200k-1000.json`);
    fs.writeFileSync(file, JSON.stringify(settingsFor(millions * 1000000), null, 2) + '\n');
    console.log(file);
}
module.exports = { settingsFor };
