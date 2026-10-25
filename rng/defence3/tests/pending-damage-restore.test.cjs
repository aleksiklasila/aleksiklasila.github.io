// Damage dealt but not reported yet (a unit's over-time sum, unit.stAcc,
// and its laser sum with the beam, unit.lzAcc / lzBeam: their reports pay
// the shrines and start retaliations) is state (audit 2026-10-15,
// MULTIPLAYER_AUDIT_2026-10-15.md 7): a repair's cache flush dropped it on
// every peer, so a repaired match went on unlike an uninterrupted one. Now
// the flush keeps it, and snapshots (whole and partial) carry it.
//   node tests/pending-damage-restore.test.cjs
'use strict';
const assert = require('node:assert/strict');
const H = require('./net-harness.cjs');

(async () => {
    const world = new H.World({ controls: { ...H.SMALL_MATCH_CONTROLS, 'cfg-mapsize': '40' } });
    const inst = world.spawn('pending', { simWorker: false });
    inst.eval('startSoloGame();');
    await world.run(1500);
    const r = JSON.parse(inst.eval(`JSON.stringify((() => {
        const u = units.find(u => !u.dead && u._us), id = u.id;
        u._dotPending = 7; u._laserPending = 9; u._laserBeam = 2;
        const out = { columns: [u._us.stAc[u._us.stIx[u._si]], u._us.lzAcc[u._si], u._us.lzBeam[u._si]] };
        snapFlushHistoryCaches();
        out.flushed = [u._dotPending, u._laserPending, u._laserBeam];
        // A whole snapshot and its restore.
        const text = JSON.stringify(snapEncodeState());
        u._dotPending = 0; u._laserPending = 0; u._laserBeam = 0;
        snapDecodeState(JSON.parse(text));
        const v = units.find(x => x.id === id);
        out.restored = [v._dotPending, v._laserPending, v._laserBeam];
        // A detached unit keeps them too.
        return out;
    })())`));
    console.log(JSON.stringify(r));
    assert.deepEqual(r.columns, [7, 9, 2], 'in the unit\'s columns');
    assert.deepEqual(r.flushed, [7, 9, 2], 'a repair\'s flush keeps them');
    assert.deepEqual(r.restored, [7, 9, 2], 'a snapshot carries them');
    await world.run(500);
    assert.deepEqual(inst.errors.map(e => String(e.message || e).slice(0, 200)), [], 'ticks run');
    console.log('PASS pending-damage-restore');
})().catch(e => { console.error(e); process.exit(1); });
