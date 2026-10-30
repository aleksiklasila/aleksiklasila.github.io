// The destination fields' sweep (flownav.js navFieldsSweepStep, wasm/src/nfs.rs
// k_nav_sweep_mark / k_nav_sweep_drop over the pools' key tables) keeps and
// drops the same fields as the reference (a Map by key, one base-tick share
// at a time), across cycle boundaries, and the key table answers every kept
// key afterwards (deletions by backward shift).
//   node tests/nav-field-sweep.test.cjs
'use strict';
const assert = require('node:assert/strict');
const H = require('./net-harness.cjs');
const world = new H.World({ controls: { ...H.SMALL_MATCH_CONTROLS, 'cfg-mapsize': '40' } });
const inst = world.spawn('navsweep', { simWorker: false });
inst.eval('startSoloGame(); gameTick();');
const out = JSON.parse(inst.eval(`JSON.stringify((() => {
    const res = [];
    const keepPools = _navFields.pools.slice(), keepCycle = _navFields.seenCycle, keepS = _simUnitState, keepMap = _unitSlotMapEnsure, keepPh = simStepPhases;
    try {
        for (const n of [0, 1, 127, 129, 1027]) for (const dk of [1, 4, 20, 127, 128]) for (const offset of [0, 7, 119, 127]) {
            const step = NAV_FIELD_SWEEP_TICKS, ns = n + 13, C = {};
            C.live = simSharedArray(Uint8Array, ns); C.dead = simSharedArray(Uint8Array, ns); C.rkF = simSharedArray(Uint8Array, ns);
            C.rtEnd = simSharedArray(Int32Array, ns); C.nvPK = simSharedArray(Int32Array, ns); C.nvProf = simSharedArray(Int8Array, ns);
            const slots = simSharedArray(Int32Array, Math.max(1, n));
            for (let i = 0; i < n; i++) slots[i] = (i * 37) % ns;
            for (let s = 0; s < ns; s++) { C.live[s] = s % 5 ? 1 : 0; C.dead[s] = s % 17 === 0 ? 1 : 0; C.rtEnd[s] = s % 19; C.nvProf[s] = s % 3; C.nvPK[s] = s % 11 === 0 ? -1 : ((s % 3) * 16777216 + s % 19) * 2 + (s & 1); C.rkF[s] = s % 4 ? 1 : 0; }
            const pool = () => {
                const F = { cap: 60, ht: null, meta: simSharedArray(Int32Array, 60 * NAV_FIELD_META), seen: simSharedArray(Int32Array, 60), pool: true, free: [], pending: [], rowSrc: new Map(), rowKeyOf: null };
                F.meta.fill(0); F.seen.fill(0); _navHtFit(F);
                let s = 0;
                for (let p = 0; p < 3; p++) for (let d = 0; d < 20; d++) { F.meta[s * NAV_FIELD_META] = p; F.meta[s * NAV_FIELD_META + 1] = d; _navHtPut(F, p * 16777216 + d, s); s++; }
                return F;
            };
            const pools = [pool(), pool()];
            const ref = pools.map(F => { const m = new Map(); for (let s = 0; s < 60; s++) m.set(F.meta[s * NAV_FIELD_META] * 16777216 + F.meta[s * NAV_FIELD_META + 1], s); return { byKey: m, seen: new Int32Array(60) }; });
            const phases = Array.from({ length: dk }, (_, i) => (offset + i) % step);
            let cycle = 0;
            for (const k of phases) {
                const mark = cycle + 1;
                for (let i = k; i < n; i += step) {
                    const s = slots[i];
                    if (!C.live[s] || C.dead[s]) continue;
                    if (C.rtEnd[s] >= 0 && C.rkF[s] === 1) { const p = ref[1], sl = p.byKey.get(C.nvProf[s] * 16777216 + C.rtEnd[s]); if (sl !== undefined) p.seen[sl] = mark; }
                    const pk = C.nvPK[s];
                    if (pk >= 0) { const p = ref[pk & 1], sl = p.byKey.get(pk >> 1); if (sl !== undefined) p.seen[sl] = mark; }
                }
                if (k === step - 1) { for (const p of ref) for (const [key, s] of p.byKey) if (p.seen[s] < mark) p.byKey.delete(key); cycle++; }
            }
            _navFields.pools[0] = pools[0]; _navFields.pools[1] = pools[1]; _navFields.seenCycle = 0;
            _simUnitState = { columns: C }; unitsSetView({ length: n }); _unitSlotMapEnsure = () => slots; simStepPhases = () => phases;
            navFieldsSweepStep();
            let bad = _navFields.seenCycle !== cycle ? 'cycle' : '';
            for (let w = 0; w < 2 && !bad; w++) {
                const F = pools[w], R = ref[w];
                for (let s = 0; s < 60 && !bad; s++) {
                    const key = (Math.floor(s / 20)) * 16777216 + s % 20, live = F.meta[s * NAV_FIELD_META] >= 0;
                    if (live !== R.byKey.has(key)) bad = 'live ' + w + ' ' + s;
                    else if (_navHtSlot(F, key) !== (live ? s : -1)) bad = 'table ' + w + ' ' + s;
                    else if (F.seen[s] !== R.seen[s]) bad = 'seen ' + w + ' ' + s;
                }
            }
            res.push(bad ? n + '/' + dk + '/' + offset + ': ' + bad : '');
        }
    } finally {
        _navFields.pools[0] = keepPools[0]; _navFields.pools[1] = keepPools[1]; _navFields.seenCycle = keepCycle;
        _simUnitState = keepS; unitsSetView(null); _unitSlotMapEnsure = keepMap; simStepPhases = keepPh;
    }
    return res.filter(Boolean);
})())`));
assert.deepEqual(out, []);
console.log('PASS: navigation field sweep matches base-tick shares and expiry across cycle boundaries; key tables follow');
