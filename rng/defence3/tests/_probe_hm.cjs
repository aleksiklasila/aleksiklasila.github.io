// Probe: host-migration case B, per-tick unit-1 columns on the reloaded host vs a guest.
const H = require('./net-harness.cjs');
const WAN = { latencyMs: 60, jitterMs: 10 };
const settled = insts => insts.every(i => i.eval('gameStarted') && !i.eval('lockstepResyncPauseActive') && !i.eval('hostMigration'));
const UID = Number(process.env.UID || 1);
const REC = `(() => { const o = {}; for (const u of units) { if (!u.workerType || u.dead || !u._us) continue; const c = u._us, s = u._si, P = 'u' + u.id + '.';
  const sideN = (typeof SIM_UNIT_WK_SIDE !== 'undefined') ? new Set(SIM_UNIT_WK_SIDE.map(x => x[0])) : new Set();
  const w = c.wkIx ? c.wkIx[s] : 0;
  for (const k of Object.keys(c)) { const a = c[k]; if (!a || typeof a.length !== 'number' || !ArrayBuffer.isView(a)) continue; if (k === 'wkIx' || ${JSON.stringify((process.env.IGN || '').split(','))}.includes(k)) continue; const i = sideN.has(k) ? w : s; if (sideN.has(k) && !(w > 0)) continue; const v = a[i]; o[P + k] = typeof v === 'number' && v !== v ? 'NaN' : String(v); } o[P + 'ws'] = u.workerState; }
  if (typeof _wsw !== 'undefined' && _wsw) for (const k of ['flags','own','area','resv','cnt','oc']) { const a = _wsw[k]; let h = 0; for (let i = 0; i < a.length; i++) if (a[i]) h = (Math.imul(h ^ i, 16777619) + Math.imul(a[i], 2654435761)) | 0; o['W_' + k] = h; } else o.W = 'null';
  { const dig = a => { let h = 0; if (!a) return 'null'; for (let i = 0; i < a.length; i++) if (a[i]) h = (Math.imul(h ^ i, 16777619) + Math.imul(a[i] | 0, 2654435761)) | 0; return h; }; o.cellArea = dig(typeof cellArea !== 'undefined' ? cellArea : null); o.areaIdGrid = dig(typeof areaIdGrid !== 'undefined' ? areaIdGrid : null); o.nAreas = areas.length; o.dims = [GRID_W, GRID_H, cellArea.length, grid.length, grid[0].length].join(); if (currentTick === 111) { o.ar = areas.slice(0, 8).map(a => a && (a.id + ':' + a.cells.length + ':' + a.cells[0].x + ',' + a.cells[0].y)).join(' '); o.ca = Array.from(cellArea.slice(0, 40)).join(','); o.gca = grid[0].slice(0, 40).map(c => c.areaId).join(','); } if (_wsw && currentTick === 111) { const d = []; for (let t = 0; t < _wsw.area.length; t++) if (_wsw.area[t] !== -1) d.push(t + ':' + _wsw.area[t] + ':' + cellArea[t] + ':' + areaIdGrid[t]); o.wa = d.join(' '); } }
  o.G = [typeof _wsCommitTick !== 'undefined' ? _wsCommitTick : '-', typeof _wsStepTick !== 'undefined' ? _wsStepTick : '-', typeof _wsPostEpoch !== 'undefined' ? _wsPostEpoch : '-', typeof _wsGroups !== 'undefined' ? _wsGroups.size : '-', gameTime].join();
  for (const k of ['code','own','uc','val','tim','brain','rtab','stab','rrow','ctab','cnt','rcnt']) { const a = _ST[k]; if (!a) continue; let h = 0; for (let i = 0; i < a.length; i++) { const v = a[i]; if (v) h = (Math.imul(h ^ i, 16777619) + Math.imul(typeof v === 'number' && (v|0) !== v ? Math.round(v * 1e6) : v, 2654435761)) | 0; } o['ST_' + k] = h; } o.res = typeof workerReservedTiles !== 'undefined' ? workerReservedTiles.reduce((n, x, i) => x ? n + i + ':' + x.id + ',' : n, '') : '-';
  return JSON.stringify(o); })()`;
(async () => {
    const world = new H.World({ network: WAN, controls: H.SMALL_MATCH_CONTROLS, compressSnapshots: true });
    const { host, guests } = await H.startHostedMatch(world, { guests: 3, teams: [0, 1, 0, 1], hostSetup: 'NET_SNAPSHOT_COMPRESS_MIN_BYTES = 0' });
    await H.playFor(world, [host, ...guests], 5000, { seed: 111 });
    const oldHostId = host.eval('myPeerId');
    world.kill(host);
    await world.runUntil(() => settled(guests) && guests.some(g => g.eval('isHost')), 10000, 50);
    await world.run(1500);
    for (const g of guests) g.evalSim("(() => { const o = snapFlushHistoryCaches; snapFlushHistoryCaches = function () { (__scratch.fl || (__scratch.fl = [])).push(currentTick + '/' + gameTime); return o.apply(this, arguments); }; })()");
    const back = world.spawn('host-reloaded', { storage: host.storage, session: host.session, url: `http://localhost/rng/defence3/index.html?game=${oldHostId}&room=${oldHostId}` });
    back.eval(`loadOrCreateLocalIdentity(); joinGame(${JSON.stringify(oldHostId)})`);
    const all = [back, ...guests];
    const now = Math.max(...guests.map(g => g.eval('currentTick')));
    for (let t = now; t < now + 400; t++) world.atTick(t, `(__scratch.rec || (__scratch.rec = {}))[currentTick] = ${REC}`);
    await world.runUntil(() => back.eval('gameStarted') && settled(all) && back.eval('currentTick') > 0, 20000);
    const from = back.eval('currentTick');
    console.log('joined at', from, 'lastSnapshotTick', back.lastSnapshotTick);
    await H.playFor(world, all, 8000, { seed: 112 });
    await world.run(2000);
    const A = back.evalSim('__scratch.rec') || back.eval('__scratch.rec') || {}, B = guests[0].evalSim('__scratch.rec') || guests[0].eval('__scratch.rec') || {};
    let shown = 0;
    for (const t of Object.keys(A).map(Number).sort((x, y) => x - y)) {
        if (!B[t] || A[t] === B[t]) continue;
        if (A[t] === 'none' || B[t] === 'none') { console.log('T', t, A[t].slice(0, 40), B[t].slice(0, 40)); continue; }
        const a = JSON.parse(A[t]), b = JSON.parse(B[t]), d = [];
        for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) if (a[k] !== b[k] && !(process.env.IGN || '').split(',').includes(k)) d.push(k + ' ' + a[k] + ' / ' + b[k]);
        if (!d.length) continue; console.log('T', t, d.join(' | '));
        if (++shown > Number(process.env.SHOW || 3)) break;
    }
    const ex = i => new Map([...i.executedActions].map(([k, v]) => [k, v.tick]));
    const EA = ex(back), EB = ex(guests[0]);
    for (const [k, t] of EB) if (t >= from - 5 && t < from + 120 && EA.get(k) !== t) console.log('ACT', k, 'guest tick', t, 'back tick', EA.get(k), JSON.stringify(world.issued.get(k)).slice(0, 200));
    for (const [k, t] of EA) if (!EB.has(k)) console.log('ACT only back', k, t);
    for (const i of all) console.log('FLUSH', i.name, JSON.stringify(i.evalSim('__scratch.fl') || i.eval('__scratch.fl') || []));
    console.log('compared', Object.keys(A).length, Object.keys(B).length);
    process.exit(0);
})();
