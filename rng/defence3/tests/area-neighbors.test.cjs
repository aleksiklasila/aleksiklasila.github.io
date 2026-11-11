'use strict';
// rebuildAreaDistanceCachesFromAreas (data_state.js): each area's neighbours
// (sorted, unique, both directions, right and down meetings of tiles) as a
// Set per area made them, on random area maps with holes (-1), areas
// without a record and areas of one tile.
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const src = fs.readFileSync(path.join(__dirname, '../src/data/data_state.js'), 'utf8');
const body = src.slice(src.indexOf('function resetAreaDistanceCaches()'), src.indexOf('// ---- range queries over the area graph'));
const bin = fs.readFileSync(path.join(__dirname, '../src/sim/sim_wasm_bin.js'), 'utf8');
const bytes = vm.runInNewContext(bin + '; SIM_WASM_BIN');
const module32 = new WebAssembly.Module(Buffer.from(bytes, 'base64'));
let seed = 7; const rnd = () => (seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296;
for (let trial = 0; trial < 40; trial++) {
    const W = 3 + Math.floor(rnd() * 40), H = 3 + Math.floor(rnd() * 40), N = 1 + Math.floor(rnd() * 60);
    const ids = []; for (let y = 0; y < H; y++) { const r = []; for (let x = 0; x < W; x++) r.push(rnd() < 0.1 ? -1 : (rnd() < 0.7 && x ? r[x - 1] : Math.floor(rnd() * N))); ids.push(r); }
    const memory = new WebAssembly.Memory({ initial: 256, maximum: 65536, shared: true });
    const exports = new WebAssembly.Instance(module32, { env: { memory } }).exports;
    let top = Math.ceil(Number(exports.__heap_base.value) / 64) * 64;
    const args = top; top += 8192;
    const alloc = (T, n) => { const at = top; top += Math.ceil(Math.max(1, n) * T.BYTES_PER_ELEMENT / 64) * 64; return new T(memory.buffer, at, n); };
    const cellArea = alloc(Int32Array, W * H); cellArea.set(ids.flat());
    const areas = []; for (let a = 0; a < N; a++) if (rnd() < 0.9 || a === N - 1) areas.push({ id: a, cells: [] });
    const c = vm.createContext({ GRID_W: W, GRID_H: H, cellArea, areas, areaNeighborIds: [], areaIdGrid: [], gridCellsByArea: [], spatialUnitsByArea: [], _areaById: [], _mapAreas: null,
        _mapArray: alloc, simWasmInit: () => false,
        _mapKernel(name, arrays, params) {
            const I = new Int32Array(memory.buffer, args, 1024);
            arrays.forEach((a, i) => { I[512 + i] = a.byteOffset; });
            new Float64Array(memory.buffer, args + 4096, 512).set(params);
            exports[name](args, 0);
        }
    });
    vm.runInContext(body, c);
    vm.runInContext('rebuildAreaDistanceCachesFromAreas()', c);
    const got = vm.runInContext('areaNeighborIds', c);
    const has = new Set(areas.map(a => a.id)), want = [];
    const sets = Array.from({ length: N }, () => new Set());
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const a = ids[y][x]; if (a < 0) continue;
        for (const b of [x + 1 < W ? ids[y][x + 1] : -1, y + 1 < H ? ids[y + 1][x] : -1]) if (b >= 0 && b !== a) { sets[a].add(b); sets[b].add(a); }
    }
    for (let a = 0; a < N; a++) want.push(has.has(a) ? [...sets[a]].sort((p, q) => p - q) : []);
    assert.equal(got.length, N);
    for (let a = 0; a < N; a++) assert.deepEqual(Array.from(got[a]), want[a], `trial ${trial} area ${a}`);
}
console.log('PASS area neighbours: sorted, unique, both directions, as the Set per area made them (40 random maps)');
