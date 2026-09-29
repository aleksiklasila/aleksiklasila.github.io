// Real simulation + unit frame cost with a settings fixture. No rendering/network.
// node tests/unit-scale.bench.cjs 10000.json [ticks=80] [--profile]
// Add --helpers=0/1/7 for real shared-memory workers, --moving for group orders,
// or --map=1000 to override map dimensions. DEFENCE_TEST_BASELINE=HEAD loads
// historical gameplay sources (use no --helpers with a historical baseline).
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const helperArg = process.argv.find(a => a.startsWith('--helpers='));
const helpers = helperArg ? Number(helperArg.split('=')[1]) : null;
if (helpers !== null) globalThis.self = { crossOriginIsolated: true };
const H = require('./net-harness.cjs');
const fixture = process.argv[2] || '10000.json';
const ticks = Number(process.argv[3]) || 80;
const moving = process.argv.includes('--moving');
const data = JSON.parse(fs.readFileSync(path.resolve(__dirname, fixture), 'utf8'));
const controls = { ...H.SMALL_MATCH_CONTROLS };
for (const group of ['numbers', 'selects', 'checkboxes'])
    for (const [k, v] of Object.entries(data.lobby[group] || {})) controls[k] = typeof v === 'boolean' ? v : String(v);
const mapArg = process.argv.find(a => a.startsWith('--map='));
if (mapArg) controls['cfg-mapsize'] = mapArg.split('=')[1];
const world = new H.World({ controls });
const inst = world.spawn('bench', { controls, simWorker: false });
inst.eval(`MAX_THING_LEVEL = ${data.lobby.numbers['cfg-max-thing-level'] || 20};
    MAX_RESEARCH_LEVEL = ${data.lobby.numbers['cfg-max-research-level'] || 10};
    startingResourcesConfig = normalizeStartingResourcesConfig(${JSON.stringify(data.startingResources)});
    applyMainMenuControlsToRuntimeState();
    applyEditableRuntimeConfigObject(${JSON.stringify(data.editableConfig)}, { fromTransport: true });
    startSoloGame(); isMultiplayer = true; gameStarted = true;`);
inst.scratch.now = () => performance.now();
if (helpers !== null) {
    inst.scratch.RealWorker = require('./real-sim-helper.cjs');
    inst.eval(`Worker = __scratch.RealWorker; navigator.hardwareConcurrency = 16; simParallelInit('', ${helpers});`);
}
const inspector = require('node:inspector');
const session = new inspector.Session();
if (process.argv.includes('--profile')) { session.connect(); session.post('Profiler.enable'); session.post('Profiler.start'); }
const result = JSON.parse(inst.eval(`JSON.stringify((() => {
    const times = [], frames = [], sep = [];
    const runSep = runUnitSeparationPass;
    let sepMs = 0;
    runUnitSeparationPass = function () { const a = __scratch.now(); const r = runSep(); sepMs += __scratch.now() - a; return r; };
    for (let t = 0; t < ${ticks + 20}; t++) {
        sepMs = 0;
        const a = __scratch.now();
        if (${moving} && t === 20) for (const owner of activeTeamIds) {
            const mine = units.filter(u => !u.dead && u.owner === owner && !u.workerType);
            for (let g=0;g<4;g++) processActions([{action:'attackMove', unitIds:mine.filter((u,i)=>i%4===g).map(u=>u.id),
                targetX: GRID_W*TILE*(.35+g*.1), targetY: GRID_H*TILE*.5}],owner);
        }
        gameTick(); const b = __scratch.now();
        const f = simFrameEncode(); const c = __scratch.now(); simFrameReturn(f.buf);
        if (t >= 20) { times.push(b-a); frames.push(c-b); sep.push(sepMs); }
    }
    const stats = a => { a.sort((x,y)=>x-y); return {mean: a.reduce((x,y)=>x+y,0)/a.length, median:a[a.length>>1], p95:a[Math.floor(a.length*.95)]}; };
    return {units: units.length, buildings:new Set([...towers,...barracks,...collectorSpawners,...getCellItemsRowMajor()]).size,
        map:[GRID_W,GRID_H], tick:gameTime, hash:computeLockstepStateHashFast(gameTime), exact:__exactStateHash(),
        tickMs:stats(times), frameMs:stats(frames), separationMs:stats(sep)};
})())`));
assert.deepEqual(inst.errors.map(String), []);
if (process.argv.includes('--profile')) session.post('Profiler.stop', (err, { profile }) => {
    if (err) throw err;
    fs.writeFileSync(path.join(__dirname, 'unit-scale.cpuprofile'), JSON.stringify(profile)); session.disconnect();
});
console.log(JSON.stringify({fixture, ticks, helpers, moving, ...result}));
process.exit(0);
