const assert = require('node:assert/strict');
const H = require('./net-harness.cjs');
const game = new H.World().spawn('resource-abundance');
const run = code => game.eval(code);
const read = code => JSON.parse(run('JSON.stringify(' + code + ')'));
run("document.getElementById('starting-resources-popup').classList.add('hidden');");
const choose = (gold, astar, size, density = 10) => run(
    "document.getElementById('cfg-mapsize').value='" + size + "';" +
    "document.getElementById('cfg-gold-abundance').value='" + gold + "';" +
    "document.getElementById('cfg-astar-abundance').value='" + astar + "';" +
    "document.getElementById('cfg-mine-density').value='" + density + "';" +
    "refreshResourceAbundanceMenu(true); readConfigFromMenu();"
);
assert.equal(run("document.getElementById('cfg-mine-density').value"), '10');
const presets = read('RESOURCE_ABUNDANCE_PRESETS');
assert.deepEqual(presets.slice(0, 11).map(p => p.name), ['0','1K','2K','4K','8K','16K','32K','64K','128K','256K','512K']);
assert.equal(presets.at(-1).value, '1000000000000000000');
assert.deepEqual(read("document.getElementById('cfg-mine-density').options.map(o=>Number(o.value))"), Array.from({length:20}, (_,i)=>i*5));
for (const id of ['cfg-gold-abundance', 'cfg-astar-abundance']) {
    assert.deepEqual(read("document.getElementById('" + id + "').options.filter(o=>o.value!=='custom').map(o=>o.value)"), presets.map(p=>p.value));
}
for (const preset of presets.slice(1)) {
    const derived = read("deriveResourceAbundance('" + preset.value + "', 60)");
    assert.equal(derived.count, 180, 'reserve steps do not change mine count');
    assert.equal(derived.min, Number(preset.value));
    assert.equal(derived.max, derived.min);
}
assert.deepEqual(read("deriveResourceAbundance('0', 2000)"), { count:0, min:0, max:0, total:0 });
assert.equal(read("deriveResourceAbundance('1000000000000000000', 1000)").total, 5e22);
assert.equal(read("deriveResourceAbundance('8000000', 120)").count, 720);
assert.equal(read("deriveResourceAbundance('8000000', 120)").min, 8e6);
assert.equal(run('normalizeResourceMineDensity(-5)'), 0);
assert.equal(run('normalizeResourceMineDensity(100)'), 95);
assert.equal(run("normalizeResourceMineDensity('bad')"), 10);

for (const density of [0, 5, 10, 50, 95]) {
    choose(4000, 16000, 40, density);
    assert.equal(run('GOLD_MINE_COUNT + ASTAR_MINE_COUNT'), 1600 * density / 100);
    assert.equal(run('RESOURCE_MINE_DENSITY'), density);
    assert.equal(run('GOLD_MINE_MIN'), 4000);
    assert.equal(run('ASTAR_MINE_MIN'), 16000);
    run("MAP_TYPE='random'; rng=mulberry32(456); resetWorldState(); generateAreas(); generateResourceMinesMixed();");
    const generated = run('goldMines.length + astarMines.length');
    if (density <= 50) assert.equal(generated, 1600 * density / 100);
    else assert.ok(generated > 800 && generated <= 1600 * density / 100);
    assert.equal(run('new Set([...goldMines,...astarMines].map(m=>m.gx+"," +m.gy)).size'), generated);
    assert.equal(run('goldMines.every(m=>m.gold===4000 && m.maxGold===4000)'), true);
    assert.equal(run('astarMines.every(m=>m.astar===16000 && m.maxAstar===16000)'), true);
}
choose(8000000, 8000000, 60);
run("document.getElementById('cfg-astar-abundance').value='0'; refreshResourceAbundanceMenu(true); readConfigFromMenu();");
assert.equal(run('GOLD_MINE_COUNT'), 180, 'disabling stars does not change energy mine count');
assert.equal(run('ASTAR_MINE_COUNT'), 0);
run("document.getElementById('cfg-astar-abundance').value='2000'; refreshResourceAbundanceMenu(true); readConfigFromMenu();");
assert.equal(run('GOLD_MINE_COUNT'), 180);
assert.equal(run('ASTAR_MINE_COUNT'), 180);
assert.equal(run('GOLD_MINE_MIN'), 8e6);

choose(4000, 16000, 60);
run("document.getElementById('cfg-mapsize').value='120'; refreshResourceAbundanceMenu(); readConfigFromMenu();");
assert.equal(run('GOLD_MINE_COUNT'), 720);
assert.equal(run('GOLD_MINE_MIN'), 4000);
assert.equal(run('ASTAR_MINE_MIN'), 16000);
assert.equal(run("document.getElementById('cfg-gold-abundance').options.find(o=>o.value==='4000').textContent"), '4K');

run("document.getElementById('cfg-gold-count').value='37'; document.getElementById('cfg-gold-min').value='200'; document.getElementById('cfg-gold-max').value='500'; readConfigFromMenu();");
assert.equal(run("document.getElementById('cfg-gold-abundance').value"), 'custom');
assert.deepEqual(read('[GOLD_MINE_COUNT,GOLD_MINE_MIN,GOLD_MINE_MAX]'), [37,200,500]);
assert.equal(run("document.getElementById('cfg-gold-abundance').options.find(o=>o.value==='custom').textContent"), 'Custom (≈350)');

choose(8000000, 64000, 80, 35);
run('__scratch.saved = createMainMenuSettingsSnapshot();');
choose(0, 0, 20, 0);
run('applyMainMenuSettingsSnapshot(__scratch.saved);');
assert.deepEqual(read("[document.getElementById('cfg-gold-abundance').value,document.getElementById('cfg-astar-abundance').value,GRID_W,RESOURCE_MINE_DENSITY]"), ['8000000','64000',80,35]);
run('saveUiSettingsToStorage();');
choose(1000, 1000, 40, 0);
run('loadUiSettingsFromStorage(); refreshResourceAbundanceMenu(); readConfigFromMenu();');
assert.equal(run('RESOURCE_MINE_DENSITY'), 0, 'browser storage does not restore map density');
assert.equal(run('GOLD_MINE_MIN'), 1000, 'browser storage does not restore map reserves');
choose(4000, 4000, 60);
run("initResourceAbundanceMenu(); document.getElementById('cfg-mine-density').value='25'; document.getElementById('cfg-mine-density').dispatchEvent(new Event('change')); readConfigFromMenu();");
assert.equal(run('GOLD_MINE_COUNT + ASTAR_MINE_COUNT'), 900);
assert.equal(run('GOLD_MINE_MIN'), 4000);

for (const type of ['arena','island','islands','solar_system','crossroads','random']) {
    choose(8000, 32000, 40, 95);
    run("MAP_TYPE='" + type + "'; rng=mulberry32(456); resetWorldState(); generateAreas(); generateResourceMinesMixed(pickPlayerSpawns(2));");
    assert.ok(run('goldMines.length > 0 && astarMines.length > 0'), type);
    assert.equal(run('goldMines.every(m=>m.gold===8000 && m.maxGold===8000)'), true, type);
    assert.equal(run('astarMines.every(m=>m.astar===32000 && m.maxAstar===32000)'), true, type);
}
// Crowded layouts retain the selected amount per mine, without redistributing totals.
choose(8000, 32000, 20);
run("MAP_TYPE='random'; rng=mulberry32(1); resetWorldState(); generateAreas(); for(let y=0;y<GRID_H;y++) for(let x=0;x<GRID_W;x++) grid[y][x].type=TYPE_WALL; grid[5][5].type=TYPE_FLOOR; grid[5][6].type=TYPE_FLOOR; generateResourceMinesMixed();");
assert.equal(run('goldMines.length'), 1);
assert.equal(run('astarMines.length'), 1);
assert.equal(run('goldMines[0].gold'), 8000);
assert.equal(run('astarMines[0].astar'), 32000);
choose(0, 0, 20);
run('generateResourceMinesMixed();');
assert.equal(run('goldMines.length + astarMines.length'), 0);
assert.deepEqual(game.errors, []);
console.log('PASS: absolute reserve steps, independent density and map scaling, zero, exact per-mine amounts across all layouts, custom configs, explicit settings round trips and no automatic map restoration.');
