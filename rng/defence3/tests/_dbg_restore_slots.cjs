// Debug: after a full restore on one guest, do slots hold each unit once?
const C = require('./multiplayer-chaos-determinism.test.cjs');
const CHECK = `(() => { const S = _simUnitState; if (!S) return 'no state'; const L = S.columns.live, ID = S.columns.id; let live = 0, ids = new Map(), dup = 0, ownerNull = 0, notInList = 0;
  const inList = new Set(units);
  for (let s = 0; s < S.owners.length; s++) { if (!L[s]) continue; live++; const id = ID[s]; if (ids.has(id)) dup++; else ids.set(id, s); if (!S.owners[s]) ownerNull++; else if (!inList.has(S.owners[s])) notInList++; }
  return JSON.stringify({ tick: currentTick, units: units.length, slots: S.owners.length, live, dup, ownerNull, notInList }); })()`;
(async () => {
    const { world, host, guests, all } = await C.setupChaosWorld(process.argv[2] || 'crossroads', 7, { exactHashes: true });
    let s = 7; const rand = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
    for (let k = 0; k < 20; k++) { for (const i of all) if (rand() < 0.7) i.eval(C.CHAOS_COMMAND + '(' + rand() + ')'); await world.run(200); }
    const g = guests[0];
    const gid = JSON.stringify(g.eval('myPeerId'));
    const shared = {}; for (const i of all) i.scratch.shared = shared;
    const T = Math.max(...all.map(i => i.eval('currentTick'))) + 30;
    world.atTick(T - 1, `(() => { snapFlushHistoryCaches(); if (!isHost && myPeerId !== ${gid}) return;
        if (__scratch.shared.text === undefined) __scratch.shared.text = JSON.stringify(snapEncodeState());
        if (!isHost) { snapDecodeState(JSON.parse(__scratch.shared.text)); __scratch.shared.after = ${CHECK}; } })()`);
    for (const k of [1, 5, 20]) world.atTick(T + k, `(() => { if (isHost || myPeerId === ${gid}) (__scratch.shared['t' + ${k}] ||= {})[isHost ? 'h' : 'g'] = ${CHECK}; })()`);
    await world.runUntil(() => all.every(i => i.eval('currentTick') > T + 22), 60000, 20);
    console.log('after decode', shared.after);
    for (const k of [1, 5, 20]) console.log(k, JSON.stringify(shared['t' + k]));
    process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
