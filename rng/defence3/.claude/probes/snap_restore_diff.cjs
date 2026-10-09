// multiplayer-snapshot.test.cjs round 0, reporting at which tick after the
// restore the peers' exact hashes part and which unit fields differ then.
const H = require('../../tests/net-harness.cjs');
const C = require('../../tests/multiplayer-chaos-determinism.test.cjs');
(async () => {
    const { world, host, guests, all } = await C.setupChaosWorld('crossroads', 9090, { exactHashes: true });
    let s = 17;
    const rand = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
    for (let k = 0; k < 20; k++) { for (const i of all) if (rand() < 0.7) i.eval(C.CHAOS_COMMAND + '(' + rand() + ')'); await world.run(200); }
    guests[0].evalSim(`(() => { const u = units.find(u => !u.dead); if (u) { u.x += 9; u.workerTarget = null; } })()`);
    host.eval(`(() => { for (let n = 0; n < 3; n++) { lockstepBundleByTick[currentTick] = { tick: currentTick, packets: [], combinedChecksum: '' }; runOneTick(); } })()`);
    const text = host.eval('JSON.stringify(buildHostAuthoritativeStateSnapshot({ includeConfig: false, includeStaticMapState: false, includeGridTypes: true }))');
    const dump = `(() => { const F = ['x','y','energy','commandState','workerState','workerTarget','targetUnit','targetPos','holdPosition','carryingValue','path','pathIndex','_pendingPathTarget','forcedAttackTarget','_attackMoveGx','watchedByTeam','_workerReservedTileIndex','builderHasMaterial'];
        const enc = v => v && typeof v === 'object' ? (v.id !== undefined ? 'u' + v.id : v.gx !== undefined ? 't' + v.gx + ',' + v.gy : Array.isArray(v) ? 'p' + v.length : 'o' + (v.x | 0) + ',' + (v.y | 0)) : String(v);
        return units.map(u => u.id + ':' + F.map(f => enc(u[f])).join('|')); })()`;
    const res = all.map(i => {
        i.scratch.snapText = text;
        return JSON.parse(i.eval(`(() => {
            applyAuthoritativeStateSnapshot(JSON.parse(__scratch.snapText));
            const out = [[__exactStateHash(), ${dump}]];
            for (let n = 0; n < 12; n++) { lockstepBundleByTick[currentTick] = { tick: currentTick, packets: [], combinedChecksum: '' }; runOneTick(); out.push([__exactStateHash(), ${dump}]); }
            return JSON.stringify(out);
        })()`));
    });
    for (let t = 0; t < res[0].length; t++) {
        const same = res.every(r => r[t][0] === res[0][t][0]);
        if (same) continue;
        console.log('first differing step', t);
        for (let p = 1; p < res.length; p++) {
            const a = res[0][t][1], b = res[p][t][1];
            const diffs = [];
            for (let k = 0; k < Math.max(a.length, b.length) && diffs.length < 5; k++) if (a[k] !== b[k]) diffs.push([a[k], b[k]]);
            console.log('peer', p, 'units', a.length, b.length, JSON.stringify(diffs));
        }
        break;
    }
    process.exit(0);
})();
