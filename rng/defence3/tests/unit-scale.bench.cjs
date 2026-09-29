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
const combat = process.argv.includes('--combat');
const phases = process.argv.includes('--phases');
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
    inst.eval(`Worker = __scratch.RealWorker; navigator.hardwareConcurrency = ${require('node:os').availableParallelism()}; simParallelInit('', ${helpers});`);
}
const inspector = require('node:inspector');
const session = new inspector.Session();
if (process.argv.includes('--profile')) { session.connect(); session.post('Profiler.enable'); session.post('Profiler.start'); }
const result = JSON.parse(inst.eval(`JSON.stringify((() => {
    const times = [], frames = [], sep = [], phaseTimes = {}, populations = [];
    let measuring = false;
    if (${phases}) for (const name of ['recalculateUnitEffectiveStats', 'recalculateThingPrecomputedStats',
        'updateAllPlayerVisibility', '_buildDeterministicUnitUpdateOrderForTick', '_resolveDeferredPathsByGroup',
        'simUnitStateCollect', 'updateUnitSpatial', 'simParallelRun']) {
        const original = eval(name);
        const wrapped = function (...args) {
            if (!measuring) return original.apply(this, args);
            const a = __scratch.now();
            try { return original.apply(this, args); }
            finally { const key = name === 'simParallelRun' ? name + ':' + args[0] : name;
                phaseTimes[key] = (phaseTimes[key] || 0) + __scratch.now() - a; }
        };
        eval(name + ' = wrapped');
    }
    const runSep = runUnitSeparationPass;
    let sepMs = 0;
    runUnitSeparationPass = function () { const a = __scratch.now(); const r = runSep(); sepMs += __scratch.now() - a; return r; };
    for (let t = 0; t < ${ticks + 20}; t++) {
        sepMs = 0;
        measuring = t >= 20;
        const a = __scratch.now();
        if (${moving} && t === 20) for (const owner of activeTeamIds) {
            const mine = units.filter(u => !u.dead && u.owner === owner && !u.workerType);
            for (let g=0;g<4;g++) processActions([{action:'attackMove', unitIds:mine.filter((u,i)=>i%4===g).map(u=>u.id),
                targetX: GRID_W*TILE*(.35+g*.1), targetY: GRID_H*TILE*.5}],owner);
        }
        if (${combat} && t === 20) {
            const groups = activeTeamIds.map(owner => units.filter(u => !u.dead && !u.workerType && !u.isKing && u.owner === owner));
            const width = Math.ceil(Math.sqrt(groups.reduce((n,g)=>n+g.length,0)));
            let at = 0;
            for (let i = 0, end = Math.max(...groups.map(g=>g.length)); i < end; i++) for (let g = 0; g < groups.length; g++) {
                const u = groups[g][i]; if (!u) continue;
                const enemies = groups[(g + 1) % groups.length];
                u.x = GRID_W*TILE*(.1 + .8*(at%width)/width);
                u.y = GRID_H*TILE*(.1 + .8*Math.floor(at/width)/width); at++;
                u.path = null; u.pathIndex = 0; u._pendingPathTarget = null;
                u.targetUnit = enemies[i % enemies.length]; u.targetBuilding = null;
                u.commandState = CMD_ATTACKING; u.attackTimer = 0; u.forcedAttackTarget = true;
                updateUnitSpatial(u);
            }
        }
        gameTick(); const b = __scratch.now();
        const f = simFrameEncode(); const c = __scratch.now(); simFrameReturn(f.buf);
        if (t >= 20) { times.push(b-a); frames.push(c-b); sep.push(sepMs); }
        if (t >= 20 && (t === 20 || t === ${ticks + 19} || (t % 20) === 0)) {
            let moved = 0, attacking = 0, workers = 0, pending = 0;
            for (const u of units) { if (u.dead) continue;
                if (u.x !== u.prevX || u.y !== u.prevY) moved++;
                if (u.commandState === CMD_ATTACKING) attacking++;
                if (u.workerState && u.workerState !== 'IDLE') workers++;
                if (u._pendingPathTarget) pending++;
            }
            populations.push({tick: gameTime, moved, attacking, working: workers, pending});
        }
    }
    const stats = a => { a.sort((x,y)=>x-y); return {mean: a.reduce((x,y)=>x+y,0)/a.length, median:a[a.length>>1], p95:a[Math.floor(a.length*.95)], p99:a[Math.floor(a.length*.99)]}; };
    return {units: units.length, actualHelpers: simParallelHelpers(), gameOver, buildings:new Set([...towers,...barracks,...collectorSpawners,...getCellItemsRowMajor()]).size,
        map:[GRID_W,GRID_H], tick:gameTime, hash:computeLockstepStateHashFast(gameTime), exact:__exactStateHash(),
        tickMs:stats(times), frameMs:stats(frames), separationMs:stats(sep), populations,
        phaseMs: Object.fromEntries(Object.entries(phaseTimes).map(([k,v])=>[k,v/${ticks}]))};
})())`));
assert.deepEqual(inst.errors.map(String), []);
if (process.argv.includes('--profile')) session.post('Profiler.stop', (err, { profile }) => {
    if (err) throw err;
    fs.writeFileSync(path.join(__dirname, 'unit-scale.cpuprofile'), JSON.stringify(profile)); session.disconnect();
});
console.log(JSON.stringify({fixture, ticks, helpers, moving, combat, instrumented: phases, ...result}));
process.exit(0);
