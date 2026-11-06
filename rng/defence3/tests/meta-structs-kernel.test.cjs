'use strict';
// The structure metadata rows (presentation table) by the kernel
// (wasm/src/nfs.rs k_meta_structs, the metadata cycle) are the rows
// _simWriteStructure (the tick's changed tiles) writes,
// column by column, through a chaos scene's structures (towers, barracks,
// spawners, walls, sites; orders and toggles between).
// Usage: node tests/meta-structs-kernel.test.cjs
const assert = require('node:assert/strict'), H = require('./net-harness.cjs'), chaos = require('./chaos-spikes-scenario.cjs'), fs = require('node:fs'), path = require('node:path');
globalThis.self = { crossOriginIsolated: true };
const controls = { ...H.SMALL_MATCH_CONTROLS, 'cfg-mapsize': '192', 'cfg-map-type': 'arena', 'cfg-gold-count': '200', 'cfg-astar-mine-count': '200', 'cfg-max-pop': '20000', 'cfg-starting-energy': '1000000000000', 'cfg-starting-astar': '1000000000000' };
const world = new H.World({ controls }), i = world.spawn('meta', { controls, simWorker: false });
i.eval(`MAX_THING_LEVEL=20;MAX_RESEARCH_LEVEL=10;startingResourcesConfig=normalizeStartingResourcesConfig({spawnCounts:{'unit:king':{1:1},'unit:norm':{12:1000},'unit:builder_unit':{10:60}},researchLevels:{}});applyMainMenuControlsToRuntimeState();startSoloGame();simDk=20;netStepTicks=()=>20;`);
const setup = JSON.parse(i.eval('JSON.stringify(' + chaos.setup({ mode: 'mega', layout: 'mixed', buildings: 50, level: 6, towerSites: 30, collectorBuildings: 20, structures: 4000 }) + ')'));
assert.deepEqual(setup.errors, []);
i.eval('__scratch.ref = (function () {' + fs.readFileSync(path.join(__dirname, '_meta_structs_reference.js'), 'utf8') + ';return _simWriteStructure; })();');
// (Lasers in rows and columns: their links.)
i.eval(`(() => { const free = (gx, gy) => { const c = grid[gy] && grid[gy][gx]; return c && c.type === TYPE_FLOOR && !c.item && !getTileEntityRef(gx, gy) && !getGoldMineAt(gx, gy); };
    const built = (e, lvl) => { e.underConstruction = false; structureWallSync(e); e.buildProgress = 1; e.stacks = e.effectiveStacks = getRequiredStacksForLevel(lvl); e.level = e.effectiveLevel = e.potentialEffectiveLevel = lvl; e.updateStats(); e.energy = e.maxEnergy; };
    for (let k = 0; k < 160; k++) { const line = k % 8, along = 10 + Math.floor(k / 8) * 4, gx = line < 4 ? along : 20 + line * 9, gy = line < 4 ? 20 + line * 9 : along;
        if (!free(gx, gy) || !placeBuilding(gx, gy, 'laser', k % 3 === 0 ? 1 : 0, { ignorePlacementRules: true, silent: true })) continue;
        const e = getTileEntityRef(gx, gy); if (e) built(e, 3 + (k % 5)); }
    recalculateLaserConnections(); laserBeamsTick(); })()`);
i.eval(`__scratch.actions=[];queueAction=a=>__scratch.actions.push(a);
_simPresentation = { worker: { postMessage() {}, terminate() {} }, epoch: 0, generation: 1, timer: 0, job: null, meta: null, projectileJob: null, projectileAt: 0,
    structures: null, cells: null, columns: null, sourceBuffer: null, strings: 0, revision: 0 };
simPresentationBind();
__scratch.cycle = () => { const g = simPresentationMetadata(); while (!g.next().done); };
__scratch.js = () => { const p = _simPresentation, F = p.structures, G = _simStructTableNew(F.cap), lists = _simStructLists();
    G.order.set(F.order); for (let kind = 0; kind < lists.length; kind++) for (const e of lists[kind]) if (e && e._sslot !== undefined) __scratch.ref(G, e._sslot, e, kind, gameTime);
    return G; };
__scratch.rows = (F = _simPresentation.structures) => { const p = _simPresentation, out = {}, n = p.structCount, ord = Array.from(F.order.subarray(0, n)).sort((a, b) => a - b);
    for (const k of [...SIM_STRUCT_SPEC.f32, ...SIM_STRUCT_SPEC.i32, ...SIM_STRUCT_SPEC.i16, ...SIM_STRUCT_SPEC.u8]) out[k] = ord.map(s => F[k][s]);
    out.slots = ord; return out; };
{ const run0 = _simMetaStructsRun; _simMetaStructsRun = (...a) => { if (a[4]) __scratch.chg = Array.from(a[4].subarray(0, a[5])); return run0(...a); }; }
__scratch.cycle();
__scratch.diff = (a, b, only) => { const bad = [], want = only ? new Set(only) : null;
    for (const k in a) { if (k === 'slots' || k === 'label') continue; for (let j = 0; j < a[k].length; j++) { if (want && !want.has(a.slots[j])) continue; const x = a[k][j], y = b[k][j];
        if (!(x === y || (x !== x && y !== y))) { const e = _simStructSlots.owner[a.slots[j]]; bad.push([k, a.slots[j], x, y, e && e.constructor.name, e && e.type]); break; } } }
    for (let j = 0; j < b.slots.length; j++) { if (want && !want.has(b.slots[j])) continue; const s = b.slots[j], e = _simStructSlots.owner[s];
        if (!e || b.kind[j] > 3) continue; const x = getLevelLabelText(e), y = simLabelText(b.label[j]); if (x !== y) { bad.push(['label', s, x, y, e.constructor.name, e.type]); break; } }
    return bad; };`);
let checked = 0, changed = 0, links = 0;
for (let step = 0; step < 30; step++) {
    if (step % 10 === 0) for (let owner = 0; owner < 2; owner++) i.eval(`localPlayerId=${owner};${chaos.burst({ mode: 'mega' }, step / 10)};processActions(__scratch.actions.splice(0),${owner});`);
    i.eval('gameTick();currentTick++');
    // (The tick's changed tiles: their rows by the kernel's list mode.)
    const c = JSON.parse(i.eval(`(() => { __scratch.chg = null; _simPresentStructureChanges(_simPresentation); const ch = __scratch.chg || [];
        const b = __scratch.rows(), a = __scratch.rows(__scratch.js()); return JSON.stringify({ n: ch.length, bad: a.slots.join() === b.slots.join() ? __scratch.diff(a, b, ch).slice(0, 10) : [['slots']] }); })()`));
    assert.deepEqual(c.bad, [], 'step ' + step + ': changed rows differ ' + JSON.stringify(c));
    changed += c.n;
    if (step % 5 !== 4) continue;
    const r = JSON.parse(i.eval(`(() => { __scratch.cycle(); const b = __scratch.rows(), a = __scratch.rows(__scratch.js());
        const bad = []; if (a.slots.join() !== b.slots.join()) bad.push(['slots', a.slots.length, b.slots.length]);
        else { bad.push(...__scratch.diff(a, b, null)); }
        return JSON.stringify({ n: a.slots.length, links: b.l0.filter(x => x >= 0).length, bad: bad.slice(0, 20) }); })()`));
    assert.deepEqual(r.bad, [], 'step ' + step + ': kernel rows differ from _simWriteStructure ' + JSON.stringify(r));
    checked = Math.max(checked, r.n); links = Math.max(links, r.links);
}
assert.ok(checked > 1000, 'structures checked ' + checked);
assert.ok(changed > 0, 'changed tiles written ' + changed);
assert.ok(links > 0, 'laser links written ' + links);
assert.deepEqual(i.errors.map(String), []);
console.log('PASS: k_meta_structs rows equal _simWriteStructure rows (' + checked + ' structures, ' + changed + ' changed rows, ' + links + ' laser links)');
