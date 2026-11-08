'use strict';
// Which unit columns free slots hold away from their defaults (simSlotDefaults)
// after play: what a unit taking a free slot must write itself, beyond its
// own values (the slot-zero kernel resets released slots; kernels may write
// slots after that). A solo scene restored with real helpers, TICKS ticks,
// then every free slot (not live, no handle, below owners.length) by column.
// Usage: node --max-old-space-size=14000 tests/free-slot-leftovers-probe.cjs [scene.gz] [helpers] [ticks]
const path = require('node:path');
globalThis.self = { crossOriginIsolated: true };
const H = require('./net-harness.cjs');
const scene = path.resolve(process.argv[2] || path.join(__dirname, 'scenes/mixed-200k.gz'));
const helpers = process.argv[3] !== undefined ? Number(process.argv[3]) : 11, ticks = Number(process.argv[4]) || 40;
(async () => {
    const controls = { ...H.SMALL_MATCH_CONTROLS };
    const world = new H.World({ controls, hashEvery: 1e9 });
    const host = world.spawn('host', { controls, simWorker: false });
    host.scratch.records = JSON.parse(require('node:zlib').gunzipSync(require('node:fs').readFileSync(scene)));
    host.scratch.scene = host.eval('(() => { const r = soloSceneReader(); for (const a of __scratch.records) r.line(JSON.stringify(a)); return r.finish(); })()');
    host.scratch.records = null;
    host.eval('document.getElementById("starting-resources-popup").classList.add("hidden")');
    let done = false, error;
    host.eval('restoreSoloGameSnapshot(__scratch.scene)').then(() => done = true, e => { done = true; error = e; });
    while (!done) await world.run(20);
    if (error) throw error;
    host.scratch.scene = null;
    host.scratch.Worker = require('./real-sim-helper.cjs');
    host.eval(`Worker = __scratch.Worker; navigator.hardwareConcurrency = 32; simParallelInit('', ${helpers})`);
    const scan = () => host.eval(`JSON.stringify((() => {
        const S = _simUnitState, C = S.columns, D = simSlotDefaults(), n = S.owners.length, out = {};
        const pend = new Set(); for (let i = 0; i < S.freeCount; i++) pend.add(S.freeLater[i]);
        const free = []; for (let s = 0; s < n; s++) if (!C.live[s] && !(C.hnd[s] > 0) && !pend.has(s)) free.push(s);
        const cols = SIM_UNIT_COLUMNS.map(k => [k, 1]).concat(SIM_MOVE_COLUMNS.map(c => [c[0], c[2]]));
        for (const [k, per] of cols) {
            const a = C[k]; if (!a || !ArrayBuffer.isView(a)) continue;
            const d = D[k] === undefined ? 0 : D[k];
            const want = a instanceof Float32Array ? Math.fround(d) : a instanceof Float64Array ? d : (a instanceof Uint8Array || a instanceof Uint16Array || a instanceof Uint32Array) ? (d >>> 0) & (a instanceof Uint8Array ? 255 : a instanceof Uint16Array ? 65535 : 0xFFFFFFFF) : d | 0;
            let bad = 0, ever = 0, ex = null;
            for (const s of free) {
                let off = false;
                for (let j = 0; j < per; j++) { const v = a[s * per + j], w = j === 0 ? want : 0; if (!(Object.is(v, w) || (v !== v && w !== w) || v === w)) { off = true; if (!ex) ex = [s, j, v, w]; break; } }
                if (off) { bad++; if (S.sl.ever && ((S.sl.ever[s >>> 5] >>> (s & 31)) & 1)) ever++; }
            }
            if (bad) out[k] = { bad, ever, ex };
        }
        return { free: free.length, n, cols: out };
    })())`);
    console.log('after restore', scan());
    for (let i = 0; i < ticks; i++) host.eval('gameTick()');
    console.log('after ' + ticks + ' ticks', scan());
    process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
