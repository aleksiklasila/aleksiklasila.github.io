'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm'), path = require('node:path');
const menu = require('./menu-limits.cjs');
const source = fs.readFileSync(path.join(__dirname, '../src/data/data_static.js'), 'utf8');
const c = vm.createContext({});
vm.runInContext(source.slice(0, source.indexOf('let TICK_RATE')), c);
let combinations = 0;
for (const teams of [2, 3, 4, 8]) for (const side of menu.choices('cfg-mapsize')) for (const selected of menu.choices('cfg-max-pop')) {
    const result = vm.runInContext(`(() => {
        const tiles=${side ** 2}, teams=${teams}, pop=memoryBudgetPop(${selected},teams,tiles), buildings=memoryBudgetBuildings(pop,teams,tiles);
        const fixed=MEMORY_BASE_BYTES+memoryBudgetMapBytes(teams,tiles), units=memoryBudgetUnits(pop,teams,tiles)*MEMORY_UNIT_BYTES;
        return {pop,buildings,units,mines:memoryBudgetMines(pop,teams,tiles),mineBytes:MEMORY_MINE_BYTES,buildingBytes:buildings*teams*MEMORY_STRUCT_BYTES,remaining:MEMORY_BUDGET_BYTES-fixed-units};
    })()`, c);
    assert.ok(result.pop <= selected, 'selection is an upper bound');
    assert.ok(result.pop * teams <= side ** 2 * 8, 'applied population fits reserved map capacity');
    assert.ok(menu.choices('cfg-max-pop').includes(result.pop), 'adjusted population is a menu choice');
    assert.ok(result.buildings >= Math.min(64, 2 ** Math.floor(Math.log2(side ** 2 / teams))), 'buildings retain capacity');
    assert.ok(result.buildingBytes * 2 <= result.remaining, 'at least as much headroom as building memory remains for gameplay');
    assert.ok(result.buildingBytes + result.mines * result.mineBytes * 2 <= result.remaining, 'neutral resources also leave gameplay headroom');
    combinations++;
}
// Exercise real startup, not just the estimate: eight teams, highest menu
// selection, normal derived building limit and full unit reservation.
const H = require('./net-harness.cjs');
const side = Number(process.env.BUDGET_MAP || 256);
assert.ok(menu.choices('cfg-mapsize').includes(side));
const inst = new H.World({ controls: menu.controls({ 'cfg-map-type':'arena', 'cfg-mapsize': String(side), 'cfg-max-pop': '1048576' }) }).spawn('eight-team-budget', { simWorker: false });
const r = inst.eval(`(() => {
    applyMainMenuControlsToRuntimeState();activeTeamIds=[0,1,2,3,4,5,6,7];
    startingResourcesConfig=normalizeStartingResourcesConfig({spawnCounts:{'unit:king':{1:1}},researchLevels:{}});
    try{startGame();}catch(e){throw Error(e.message+' '+JSON.stringify({heap:simHeapStats(),pop:getConfiguredMaxPop(),mines:[goldMines.length,astarMines.length]}));}
    const cap=_simUnitState.cap, buildings=getPlayerStructureLimit(), rows=[..._sTables.values()].map(t=>t.cap);
    if(_simUnitState.wk.cap<getConfiguredMaxPop()*activeTeamIds.length||_simUnitState.st.cap<getConfiguredMaxPop()*activeTeamIds.length)throw Error('Worker/status records do not cover the allowed population');
    if([...SIM_UNIT_WK_SIDE,...SIM_UNIT_ST_SIDE].some(([key])=>!simHeapHas(_simUnitState.columns[key]))||!simHeapHas(_wai.out)||!simHeapHas(_wai.ai)||!simHeapHas(_wai.a64))throw Error('A reserved worker/status/AI buffer is outside the heap');
    const owned=Object.entries(_structClasses()).filter(([name])=>name!=='GoldMine'&&name!=='AstarMine');
    if(owned.some(([,C])=>_sTableOf(C).cap<buildings*activeTeamIds.length))throw Error('A legal single-class building mix exceeds its reservation');
    for(let k=0;k<20;k++)gameTick();
    return {pop:getConfiguredMaxPop(),cap,after:_simUnitState.cap,buildings,memory:structMemoryLimitPerPlayer(),
        mines:goldMines.length+astarMines.length,mineLimit:memoryBudgetMines(getConfiguredMaxPop(),8,GRID_W*GRID_H),
        rows,afterRows:[..._sTables.values()].map(t=>t.cap),outside:_simUnitColumnsOutside(_simUnitState),heap:simHeapStats()};
})()`);
assert.ok(r.pop < 1048576);
assert.ok(r.cap >= r.pop * 8, 'all permitted units reserved at startup');
assert.equal(r.after, r.cap, 'unit columns do not grow during play');
assert.ok(r.buildings <= r.memory, 'building limit fits reserved pool');
assert.deepEqual(r.afterRows, r.rows, 'structure tables do not grow during play');
assert.equal(r.outside, false);
assert.ok(r.mines <= r.mineLimit, 'neutral resources fit their shared allowance');
assert.deepEqual(inst.errors.map(String), []);
console.log('PASS menu memory budget', combinations, 'combinations; eight-team startup', JSON.stringify(r));
