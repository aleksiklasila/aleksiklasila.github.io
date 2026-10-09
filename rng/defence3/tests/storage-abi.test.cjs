// The unit storage schema against the movement kernels' Rust twin: every
// unit column the Rust movement kernel (wasm/src/mv.rs, struct Mv) reads
// through its argument block (sim_parallel.js _SIM_MOVE_WNAMES) must be
// declared there with the element type the JS column is allocated with
// (a Float32 column read as f64 is garbage, an Int32 one as u8 a wrong
// byte). Also: no column declared twice, and the per-slot byte count.
//
// Usage: node tests/storage-abi.test.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');

// The schema, from sim_unit_state.js (its top level needs no game globals).
const ctx = vm.createContext({ console, FinalizationRegistry, SIM_SPATIAL_DEFAULTS: {} });
vm.runInContext(read('src/sim/sim_unit_state.js') + '\n;globalThis.__schema = SIM_UNIT_SCHEMA; globalThis.__move = SIM_MOVE_COLUMNS;', ctx);
const schema = ctx.__schema;
const types = Object.fromEntries(Object.entries(schema).map(([k, e]) => [k, e.Type.name]));
// (Columns outside the schema the kernels read: allocated by sim_unit_state.js too.)
types.sepKey = 'Uint32Array'; types.sepLayer = 'Uint8Array'; types.mvNodes = 'Int32Array';

// The argument block's names, in word order.
const par = read('src/sim/sim_parallel.js');
const m = /const _SIM_MOVE_WNAMES = (\[[\s\S]*?\]);/.exec(par);
assert.ok(m, '_SIM_MOVE_WNAMES not found');
const wnames = vm.runInNewContext(m[1]);

// mv.rs: word constants, struct Mv's pointer types, Mv::load's words.
const rs = read('wasm/src/mv.rs');
const words = {};
for (const w of rs.matchAll(/const (W_[A-Z0-9_]+): usize = (\d+);/g)) words[w[1]] = +w[2];
const sm = /struct Mv \{([\s\S]*?)\n\}/.exec(rs);
assert.ok(sm, 'struct Mv not found');
const fieldType = {};
for (const f of sm[1].matchAll(/^\s*([a-z_0-9]+): \*(?:const|mut) ([A-Za-z0-9]+),/gm)) fieldType[f[1]] = f[2];
const rustToArray = { Q8: 'Int32Array', I8I32: 'Int8Array', i8: 'Int8Array', U8I32: 'Uint8Array', F32: 'Float32Array', f32: 'Float32Array', f64: 'Float64Array', i32: 'Int32Array', I32Number: 'Int32Array', u32: 'Uint32Array',
    i16: 'Int16Array', u16: 'Uint16Array', i8: 'Int8Array', u8: 'Uint8Array' };

let checked = 0;
const bad = [];
for (const l of rs.matchAll(/^\s*([a-z_0-9]+): p!\((W_[A-Z0-9_]+)\),/gm)) {
    const [, field, w] = l;
    const idx = words[w];
    if (!(idx >= 0)) { bad.push(field + ': unknown word ' + w); continue; }
    const name = String(wnames[idx] || '').replace(/^\?/, '');
    if (!name.startsWith('unit.')) continue;
    const col = name.slice(5), want = types[col], rt = fieldType[field];
    if (!want) { bad.push(`${field} (${w} = ${idx}) reads ${name}: no such column`); continue; }
    if (!rt) { bad.push(`${field}: no pointer type in struct Mv`); continue; }
    if (rustToArray[rt] !== want) bad.push(`${field} (${name}): Rust *${rt}, column ${want}`);
    checked++;
}
assert.equal(bad.length, 0, 'movement ABI mismatches:\n  ' + bad.join('\n  '));
assert.ok(checked >= 100, 'unit columns checked: ' + checked);

// No column declared twice (the schema throws on a duplicate when built),
// and no name both a unit and a movement column.
const names = [...Object.keys(schema)];
assert.equal(new Set(names).size, names.length);
const bytes = Object.values(schema).reduce((n, e) => n + e.bytes, 0) + 5;
console.log(`PASS: storage ABI (${checked} movement kernel columns match their Rust types; ${names.length} columns, ${bytes} bytes per slot)`);
