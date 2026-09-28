// The simulation worker's per-tick change stream (src/sim/sim_delta.js) keeps
// the page's copy of the world exact: a copy started from the authority's
// start snapshot and fed only the encoded changes (through structuredClone,
// as across the worker boundary) hashes the same as the authority after
// every tick, through spawning, movement, combat, deaths, building and
// worker activity.
const assert = require('node:assert/strict');
const H = require('./net-harness.cjs');

const TICKS = Number(process.env.SIM_DELTA_TICKS) || 400;
const SKIP = new Set(['prevX', 'prevY', '_spatialMember', '_spatialKey', '_spatialAreaId', '_spatialAreaOwner', '_spatialUnitTypeIdx', '_spatialLastVisScaled', '_damageFlashStart', '_damageFlashUntil', '_damageFlashStrength', '_damageFlashColor', '_ambientSoundTicks', 'textCtx', 'textCanvas', '_textCanvasScale', '_levelTextLabel', '_historyGhost', '_historyTick', '_droppedIndex', '_areaBucketId', '_laserLinkLevel']);

(async () => {
    const controls = { ...H.SMALL_MATCH_CONTROLS, 'cfg-mapsize': '40', 'cfg-map-type': 'arena', 'cfg-max-pop': '5000',
        'cfg-starting-energy': '100000000', 'cfg-starting-astar': '100000000', 'cfg-full-vis': 'team' };
    const world = new H.World({ controls });
    const spawnCounts = {
        'unit:norm': { 1: 60, 3: 20 }, 'unit:snake': { 2: 20 }, 'unit:water_resistant': { 1: 40 }, 'unit:ice_resistant': { 1: 40 },
        'unit:builder_unit': { 1: 20 }, 'unit:collector': { 1: 20 }, 'unit:healer_unit': { 1: 6 }, 'unit:flying': { 1: 10 },
        'building:pistol': { 1: 6 }, 'building:fire': { 2: 3 }, 'building:barrack_norm': { 1: 2 }, 'building:house': { 3: 2 },
        'building:builder_spawner': { 1: 1 }, 'building:lava': { 1: 4 }
    };
    let setup = `startingResourcesConfig = ${JSON.stringify({ spawnCounts, researchLevels: {} })};`;
    // SIM_DELTA_1500=1: tests/1500.json instead (about 3,000 units).
    if (process.env.SIM_DELTA_1500) {
        const data = require('./1500.json');
        for (const [k, v] of Object.entries(data.lobby.numbers)) controls[k] = String(v);
        for (const [k, v] of Object.entries(data.lobby.selects)) controls[k] = String(v);
        world.controls = controls;
        setup = `MAX_THING_LEVEL = ${data.lobby.numbers['cfg-max-thing-level'] || 20}; MAX_RESEARCH_LEVEL = ${data.lobby.numbers['cfg-max-research-level'] || 10};
            startingResourcesConfig = normalizeStartingResourcesConfig(${JSON.stringify(data.startingResources)}); applyMainMenuControlsToRuntimeState();
            applyEditableRuntimeConfigObject(${JSON.stringify(data.editableConfig)}, { fromTransport: true });`;
    }
    const A = world.spawn('authority', { controls });
    A.eval(setup + ' startSoloGame();');
    await world.run(800);
    const R = world.spawn('replica', { controls });
    R.eval(setup + ' startSoloGame();');
    await world.run(200);
    // The copy never simulates.
    R.eval('pumpSimulationTicks = (now, accumulator) => accumulator;');

    // Start: the copy restores the authority's start snapshot; the encoder's
    // baseline is the same state.
    const hashOf = inst => inst.eval('__exactStateHash() + "/" + computeLockstepStateHashFast(currentTick) + "/" + JSON.stringify(snapTickHash(currentTick, true))');
    const partsOf = inst => JSON.parse(inst.eval('(() => { const p = {}; computeLockstepStateHashFast(currentTick, p); return JSON.stringify(p); })()'));
    const diffParts = () => { const a = partsOf(A), r = partsOf(R); return Object.keys(a).filter(k => a[k] !== r[k]); };
    A.eval(`(() => {
        __scratch.start = JSON.stringify(buildHostAuthoritativeStateSnapshot({ includeConfig: true, includeStaticMapState: true, includeGridTypes: true }));
        // Both sides restore the same text, as every peer does at a match start.
        applyAuthoritativeStateSnapshot(JSON.parse(__scratch.start));
        simDeltaEncoderReset();
        simDeltaAlwaysFull = ${process.env.SIM_DELTA_ALWAYS_FULL === '1'};
        __scratch.deltas = [];
        const f = runOneTick; runOneTick = function () { const r = f.apply(this, arguments);
            const t0 = __scratch.realNow(); const d = simDeltaEncode(); if (typeof simUnitVisEncode === "function") d.vis = simUnitVisEncode(); const ms = __scratch.realNow() - t0;
            __scratch.deltas.push({ tick: currentTick, d, ms, hash: __exactStateHash() + '/' + computeLockstepStateHashFast(currentTick) + '/' + JSON.stringify(snapTickHash(currentTick, true)) });
            return r; };
    })()`);
    const { performance: realPerf } = require('node:perf_hooks');
    A.scratch.realNow = R.scratch.realNow = () => realPerf.now();
    R.scratch.start = A.scratch.start;
    R.eval('applyAuthoritativeStateSnapshot(JSON.parse(__scratch.start)); __scratch.applyMs = [];');
    const pv = inst => inst.eval('JSON.stringify([players.map(p => [p.money, p.energy, p.astar, p.popCount]), _computeLockstepPopCaps(), playerPopCaps])');
    assert.equal(hashOf(R), hashOf(A), 'the copy starts identical; differing parts: ' + diffParts().join(', ') + ' A=' + pv(A) + ' R=' + pv(R));

    // Orders during the run: moves, attack-moves into the enemy, production.
    let issued = 0, compared = 0, rows = 0, encMs = [], appMs = [];
    const orders = process.env.SIM_DELTA_1500 ? [
        `(() => { const mine = units.filter(u => !u.dead && u.owner === 0 && !u.workerType); for (let i = 0; i < 10; i++) queueAction({ action: 'move', unitIds: mine.filter((u, k) => k % 10 === i).map(u => u.id), targetX: (0.15 + 0.7 * ((i * 7) % 10) / 9) * GRID_W * TILE, targetY: (0.15 + 0.7 * ((i * 3) % 10) / 9) * GRID_H * TILE }); })()`
    ] : [
        `(() => { const mine = units.filter(u => !u.dead && u.owner === 0 && !u.workerType); queueAction({ action: 'attackMove', unitIds: mine.map(u => u.id), targetX: GRID_W * TILE * .8, targetY: GRID_H * TILE * .5 }); })()`,
        `(() => { const b = barracks.find(b => b.owner === 0); if (b) queueAction({ action: 'queueUnit', gx: b.gx, gy: b.gy, count: 10 }); })()`,
        `(() => { const mine = units.filter(u => !u.dead && u.owner === 0 && u.unitType === 'water_resistant'); [[.2,.2],[.5,.8],[.8,.3]].forEach(([fx, fy], i) => queueAction({ action: 'move', unitIds: mine.filter((u, k) => k % 3 === i).map(u => u.id), targetX: fx * GRID_W * TILE, targetY: fy * GRID_H * TILE })); })()`,
        `(() => { for (let i = 0; i < 4; i++) queueAction({ action: 'place', gx: 3 + i, gy: 3, itemType: 'smg', count: 1, autoUpgradeEnabled: true, buildEnabled: true }); })()`
    ];
    while (A.eval('currentTick') < TICKS) {
        if (issued < orders.length && A.eval('currentTick') > 20 + issued * 60) A.eval(orders[issued++]);
        await world.run(50);
        let batch = A.scratch.deltas.splice(0);
        for (const item of batch) {
            R.scratch.delta = structuredClone(item.d);
            const t0 = realPerf.now();
            R.eval('simDeltaApply(__scratch.delta)');
            appMs.push(realPerf.now() - t0); encMs.push(item.ms); rows += item.d.rows;
            // Units' other fields reach the copy by full ticks at the latest:
            // it is exact on those (and positions and the like on every tick).
            if (!item.d.full) continue;
            const mine = hashOf(R);
            if (mine !== item.hash) {
                const a = JSON.parse(item.hash.split('/').slice(2).join('/')), r = JSON.parse(mine.split('/').slice(2).join('/'));
                R.scratch.ha = a; R.scratch.hr = r;
                const codes = R.eval('JSON.stringify(snapDescribeCodes(snapDiffTickHash(__scratch.hr, __scratch.ha), 8))');
                // Field-level: units and drops of both worlds, compared a few levels deep.
                const fieldDiff = (() => {
                    const out = [];
                    const norm = (v, d) => { if (v === null || typeof v !== 'object') return v; if (v.id !== undefined && typeof v.update === 'function') return 'unit#' + v.id;
                        if (v.gx !== undefined && v.gy !== undefined && d > 0 && typeof v.update === 'function') return 'b@' + v.gx + ',' + v.gy;
                        if (d > 2) return '…'; if (Array.isArray(v)) return v.map(x => norm(x, d + 1)); const o = {}; for (const k of Object.keys(v)) o[k] = norm(v[k], d + 1); return o; };
                    const au = new Map(A.eval('units').map(u => [u.id, u])), ru = new Map(R.eval('units').map(u => [u.id, u]));
                    for (const [id, a] of au) { const r = ru.get(id); if (!r) { out.push('missing unit ' + id); continue; }
                        for (const k of new Set([...Object.keys(a), ...Object.keys(r)])) { if (['prevX', 'prevY', '_spatialMember', '_spatialKey', '_spatialAreaId', '_spatialAreaOwner', '_spatialUnitTypeIdx', '_spatialLastVisScaled'].includes(k)) continue;
                            let av = a[k], rv = r[k];
                            // Paths: only from the current step on (earlier steps are never read).
                            if (k === 'path' && Array.isArray(av) && Array.isArray(rv)) { av = av.slice(a.pathIndex); rv = rv.slice(r.pathIndex); }
                            const x = JSON.stringify(norm(av, 0)), y = JSON.stringify(norm(rv, 0)); if (x !== y) out.push(`unit ${id}.${k}: ${String(x).slice(0, 120)} vs ${String(y).slice(0, 120)}`); } if (out.length > 12) break; }
                    // Buildings of every list, by tile.
                    for (const list of ['t', 'b', 's', 'f']) {
                        const am = new Map(A.eval(`_snapListEntities('${list}')`).map(e => [e.gx + ',' + e.gy, e])), rm = new Map(R.eval(`_snapListEntities('${list}')`).map(e => [e.gx + ',' + e.gy, e]));
                        for (const [key, a] of am) { const r = rm.get(key); if (!r) { out.push(`missing ${list} ${key}`); continue; }
                            for (const k of new Set([...Object.keys(a), ...Object.keys(r)])) { if (['textCtx', 'textCanvas', '_textCanvasScale', '_levelTextLabel'].includes(k)) continue;
                                const x = JSON.stringify(norm(a[k], 1)), y = JSON.stringify(norm(r[k], 1)); if (x !== y) out.unshift(`${list} ${key}.${k}: ${String(x).slice(0, 100)} vs ${String(y).slice(0, 100)}`); } }
                    }
                    const ad = A.eval('droppedItems'), rd = R.eval('droppedItems');
                    if (ad.length !== rd.length) out.push(`drops ${ad.length} vs ${rd.length}`);
                    return out.slice(0, 14).join(' | ');
                })();
                // The first differing region, by contribution.
                const regionParts = inst => JSON.parse(inst.eval(`(() => { const codes = snapDiffTickHash(__scratch.hr, __scratch.ha); const r0 = codes.find(c => Math.floor(c / SNAP_CODE_SHIFT) === 0);
                    if (r0 === undefined) return '{}'; const out = { region: r0, units: {}, drops: {}, res: {} }; const ts = TILE * SNAP_REGION_TILES, rt = SNAP_REGION_TILES;
                    for (const u of units) { if (Math.floor(u.y / ts) * 1024 + Math.floor(u.x / ts) !== r0) continue; out.units[u.id] = _snapHashers.u(u, Math.imul(u.id, 7919) ^ 0x11, _snapF64, _snapI32, _snapHV, _snapHPath); }
                    for (const e of droppedItems) if (Math.floor(e.gy / rt) * 1024 + Math.floor(e.gx / rt) === r0) out.drops[e.gx + ',' + e.gy] = _snapHashEntity('d', e, (Math.imul(e.gx, 4099) + e.gy) ^ 0x88);
                    _snapForReservations(-1, (slot, u, r) => { if (r === r0) out.res[slot] = [u.id, _snapReservationHash(slot, u)]; });
                    return JSON.stringify(out); })()`));
                R.scratch.ha = a; R.scratch.hr = r; A.scratch.ha = a; A.scratch.hr = r;
                const pa = regionParts(A), pr = regionParts(R), partDiff = [];
                for (const kind of ['units', 'drops', 'res']) for (const k of new Set([...Object.keys(pa[kind] || {}), ...Object.keys(pr[kind] || {})]))
                    if (JSON.stringify((pa[kind] || {})[k]) !== JSON.stringify((pr[kind] || {})[k])) partDiff.push(`${kind} ${k}: ${JSON.stringify((pa[kind] || {})[k])} vs ${JSON.stringify((pr[kind] || {})[k])}`);
                const unitFieldDiff = partDiff.filter(d => d.startsWith('units ')).map(d => parseInt(d.split(' ')[1], 10)).map(id => {
                    const a = A.eval('units').find(u => u.id === id), r = R.eval('units').find(u => u.id === id); if (!a || !r) return id + ' missing';
                    const out = [];
                    for (const k of Object.keys(a)) { if (SKIP.has(k)) continue; let av = a[k], rv = r[k]; if (k === 'path' && Array.isArray(av) && Array.isArray(rv)) { av = av.slice(a.pathIndex); rv = rv.slice(r.pathIndex); }
                        const norm2 = v => v && typeof v === 'object' ? (v.id !== undefined ? 'u' + v.id : v.gx !== undefined ? 'b' + v.gx + ',' + v.gy : JSON.stringify(v).slice(0, 60)) : v;
                        if (JSON.stringify(Array.isArray(av) ? av.map(norm2) : norm2(av)) !== JSON.stringify(Array.isArray(rv) ? rv.map(norm2) : norm2(rv))) out.push(`${k}: ${JSON.stringify(Array.isArray(av) ? av.map(norm2) : norm2(av)).slice(0, 90)} vs ${JSON.stringify(Array.isArray(rv) ? rv.map(norm2) : norm2(rv)).slice(0, 90)}`); }
                    // Nested plain objects in full, key by key.
                    for (const k of Object.keys(a)) { if (SKIP.has(k)) continue; const av = a[k], rv = r[k];
                        if (!av || !rv || typeof av !== 'object' || typeof rv !== 'object' || Array.isArray(av) || av.id !== undefined || av.gx !== undefined) continue;
                        for (const kk of new Set([...Object.keys(av), ...Object.keys(rv)])) { const x = JSON.stringify(av[kk]), y = JSON.stringify(rv[kk]); if (x !== y) out.push(`${k}.${kk}: ${String(x).slice(0, 60)} vs ${String(y).slice(0, 60)}`); } }
                    // The hashed fields one by one.
                    for (const k of A.eval('SNAP_HASH_FIELDS.u')) { const ha = A.eval('(o) => 0'); }
                    A.scratch.hu = a; R.scratch.hu = r;
                    const per = inst => JSON.parse(inst.eval(`JSON.stringify(SNAP_HASH_FIELDS.u.map(k => { const f = _snapMakeFieldHasher([k]); return f(__scratch.hu, 0, _snapF64, _snapI32, _snapHV, _snapHPath); }))`));
                    const fa = per(A), fr = per(R), names = A.eval('SNAP_HASH_FIELDS.u');
                    names.forEach((k, i) => { if (fa[i] !== fr[i]) out.push('HASHED ' + k + ': ' + JSON.stringify(a[k] && typeof a[k] === 'object' ? Object.entries(a[k]).slice(0, 8) : a[k]).slice(0, 200) + ' vs ' + JSON.stringify(r[k] && typeof r[k] === 'object' ? Object.entries(r[k]).slice(0, 8) : r[k]).slice(0, 200)); });
                    return id + ' {' + out.join('; ') + '}';
                });
                const refInfo = inst => inst.eval(`(() => { const u = units.find(x => x.id === 467); const t = u && u.targetUnit; if (!t) return 'no target';
                    const listed = units.find(x => x.id === t.id); return JSON.stringify({ target: t.id, isUnit: t instanceof Unit, sameAsListed: listed === t, listedExists: !!listed, dead: !!t.dead }); })()`);
                assert.fail(`tick ${item.tick}: refs A=${refInfo(A)} R=${refInfo(R)} ;; unit fields: ${unitFieldDiff.join(' | ')} ;; region parts: ${partDiff.slice(0, 10).join(' | ')} ;; fields: ${fieldDiff} ;; exact ${mine.split('/')[0]} vs ${item.hash.split('/')[0]}, lockstep ${mine.split('/')[1]} vs ${item.hash.split('/')[1]}; differing: ${codes}`);
            }
            compared++;
        }
    }
    for (const inst of [A, R]) assert.deepEqual(inst.errors.map(e => String(e.stack || e).slice(0, 400)), [], inst.name + ' threw');
    const stats = a => { a.sort((x, y) => x - y); return `mean ${(a.reduce((s, v) => s + v, 0) / a.length).toFixed(2)} ms, p95 ${a[Math.floor(a.length * .95)].toFixed(2)} ms`; };
    console.log(`PASS: copy identical to the authority on all ${compared} full ticks of ${encMs.length} (${A.eval('units.length')} units at the end, ${(rows / encMs.length).toFixed(1)} rows/tick); encode ${stats(encMs)}, apply ${stats(appMs)}.`);
})().catch(err => { console.error(err); process.exitCode = 1; });
