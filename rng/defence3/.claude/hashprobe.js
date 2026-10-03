// tickbench AFTER probe: the state hash's static part (_snapTickHashStatic)
// timed over ten slices as it is, then with the entities grouped by class
// and each class hashed by a copy of _snapStaticCore of its own (monomorphic
// property reads); region sums compared.
(() => {
    const now = __scratch.realNow, t0 = currentTick;
    // (Order-free, as the tick hash's sum: the regions' first-touch order may differ.)
    const sums = () => { const R = _snapRS; let h = R.n | 0; for (let k = 0; k < R.n; k++) h = (h + Math.imul(R.list[k] * 7 + 1, 2654435761) ^ R.acc[R.list[k]]) | 0; return h; };
    const run = (fn, reps) => {
        let ms = 0, chk = 0;
        for (let rep = 0; rep < reps; rep++) for (let k = 0; k < 10; k++) {
            const t = t0 + k, slice = t % SNAP_HASH_SLICES, regions = _snapRegionsBegin(), pairs = [];
            const a = now(); fn(t, slice, false, regions, (c, h) => pairs.push(c, h)); ms += now() - a;
            if (rep === 0) chk = (chk + sums() + pairs.length + pairs[pairs.length - 1]) | 0;
        }
        return { ms: Math.round(ms / reps * 100) / 100, chk };
    };
    const orig = run(_snapTickHashStatic, 3);
    // Per class: copies of the core hasher (own feedback each).
    const coreSrc = _snapStaticCore.toString().replace(/^function\s+_snapStaticCore/, 'return function');
    const cls = e => e instanceof Tower ? 1 : e instanceof Barrack ? 2 : isSpawnerEntity(e) ? 3 : 4;
    const cores = [0, 1, 2, 3, 4].map(() => new Function(coreSrc)());
    const byClass = new Map();
    const listsOf = (slices, k) => {
        let L = byClass.get(slices[k]);
        if (!L) { L = [[], [], [], [], []]; for (const en of slices[k].values()) L[en[1] === 'm' ? 0 : cls(en[0])].push(en); byClass.set(slices[k], L); }
        return L;
    };
    const variant = (t, slice, allSlices, regions, push) => {
        _snapStaticSlices();
        const slices = _snapStaticSliceCache.slices;
        const round = Math.floor(t / SNAP_HASH_SLICES) % SNAP_HASH_GRID_ROUNDS;
        for (let k = 0; k < SNAP_HASH_GRID_ROUNDS; k++) {
            const L = listsOf(slices, slice + SNAP_HASH_SLICES * k);
            if (k === round) {
                for (const list of L) for (const en of list) { let h = _snapHashers[en[1]](en[0], en[2], _snapF64, _snapI32, _snapHV, _snapHPath); h = Math.imul(h ^ (h >>> 15), 2246822519) >>> 0; _snapRegionAdd(regions, en[3], h); }
            } else for (let c = 0; c < 5; c++) {
                const f = cores[c], list = L[c];
                for (let i = 0; i < list.length; i++) { const en = list[i]; let h = f(en[0], en[1], en[2]); h = Math.imul(h ^ (h >>> 15), 2246822519) >>> 0; _snapRegionAdd(regions, en[3], h); }
            }
        }
        // (The rest as the original: drops, reservations, grid rows.)
        const rt = SNAP_REGION_TILES;
        for (let i = 0; i < droppedItems.length; i++) { const e = droppedItems[i]; const r = Math.floor(e.gy / rt) * 1024 + Math.floor(e.gx / rt); if ((r % SNAP_HASH_SLICES) !== slice) continue; _snapRegionAdd(regions, r, _snapHashEntity('d', e, (Math.imul(e.gx, 4099) + e.gy) ^ 0x88)); }
        _snapForReservations(slice, (slot, u, r) => _snapRegionAdd(regions, r, _snapReservationHash(slot, u)));
        let h = 2166136261 | 0;
        const gstep = SNAP_HASH_SLICES * SNAP_HASH_GRID_ROUNDS, g0 = slice + SNAP_HASH_SLICES * (Math.floor(t / SNAP_HASH_SLICES) % SNAP_HASH_GRID_ROUNDS);
        for (let gy = g0; gy < GRID_H; gy += gstep) { const row = grid[gy]; if (!row) continue; for (let gx = 0; gx < GRID_W; gx++) { const c = row[gx]; h = Math.imul(Math.imul(h ^ c.type, 16777619) ^ c.owner, 16777619); } }
        push(SNAP_PART_GRID * SNAP_CODE_SHIFT, h >>> 0);
    };
    variant(t0, t0 % 10, false, _snapRegionsBegin(), () => { });
    const v = run(variant, 3);
    // Parts of the original alone.
    const parts = {};
    const time = (name, f) => { const a = now(); for (let k = 0; k < 10; k++) f(t0 + k, (t0 + k) % 10); parts[name] = Math.round((now() - a) * 100) / 100; };
    time('reservations', (t, s) => _snapForReservations(s, () => { }));
    time('drops', () => { for (let i = 0; i < droppedItems.length; i++) droppedItems[i].gx; });
    const counts = [0, 0, 0, 0, 0];
    for (const m of _snapStaticSliceCache.slices) for (const en of m.values()) counts[en[1] === 'm' ? 0 : cls(en[0])]++;
    return JSON.stringify({ orig, variant: v, parts, counts, drops: droppedItems.length });
})()
