// Probe: a peer that only flushes at a join tick vs one that restores the
// join's snapshot must continue alike (workers, structures, reservations).
//   node tests/_probe_rj.cjs [warmTicks] [runTicks]
const H = require('./net-harness.cjs');
const WARM = Number(process.argv[2]) || 300, RUN = Number(process.argv[3]) || 200;
const world = new H.World({ controls: { ...H.SMALL_MATCH_CONTROLS } });
const a = world.spawn('rj', { simWorker: false });
const C = require('./multiplayer-chaos-determinism.test.cjs');
a.set('startingResourcesConfig', C.startingResources(Number(process.env.SEED) || 7));
a.eval('startSoloGame();');
const step = `(() => { pathfindBudget = 0; gameTick(); currentTick++; })()`;
let rs = Number(process.env.SEED) || 7; const rnd = () => (rs = (rs * 16807) % 2147483647) / 2147483647;
for (let k = 0; k < WARM; k++) { if (rnd() < 0.3) a.eval(C.CHAOS_COMMAND + '(' + rnd() + ')'); a.eval(step); }
a.eval(`__scratch.S = JSON.stringify(buildHostAuthoritativeStateSnapshot({ includeConfig: false, includeStaticMapState: true, includeGridTypes: true }))`);
console.log('T', a.eval('currentTick'), 'units', a.eval('units.length'), 'workers', a.eval('units.filter(u => u.workerType).length'));
const fp = `JSON.stringify({ h: computeLockstepStateHashFast(currentTick - 1), w: units.filter(u => u.workerType && !u.dead).map(u => u.id + ':' + u.workerState + ':' + Math.round(u.x) + ',' + Math.round(u.y) + ':' + (u._us ? u._us.wsKind[u._si] : '')).join(' '), r: workerReservedTiles.reduce((n, x, i) => x ? n + i + ':' + x.id + ',' : n, ''), p: players.map(p => p && [p.energy, p.astar].join('/')).join(' ') })`;
const run = () => { const out = []; for (let k = 0; k < RUN; k++) { a.eval(step); out.push(a.eval(fp)); } return out; };
const T = a.eval('currentTick'), gt = a.eval('gameTime');
// X: the peers that keep their state (a flush at the join tick).
a.eval('snapFlushHistoryCaches()');
const X = run();
// Y: the joiner (restored from the snapshot, then the flush).
a.eval(`(() => { applyAuthoritativeStateSnapshot(JSON.parse(__scratch.S)); snapFlushHistoryCaches(); })()`);
console.log('restored at', a.eval('currentTick'), T, a.eval('gameTime'), gt);
const Y = run();
let first = -1;
for (let k = 0; k < RUN; k++) if (X[k] !== Y[k]) { first = k; break; }
if (first < 0) { console.log('SAME for', RUN, 'ticks'); process.exit(0); }
const x = JSON.parse(X[first]), y = JSON.parse(Y[first]);
console.log('first difference', first, 'ticks after T');
for (const k of Object.keys(x)) if (x[k] !== y[k]) console.log(' ', k, '\n    keep   ', String(x[k]).slice(0, 900), '\n    restore', String(y[k]).slice(0, 900));
process.exit(0);
