// The unit storage schema against every Rust kernel of wasm/src/k.rs run
// through _simRust: each kernel's argument list (a _simWK([...]) of binding
// names, sim_parallel.js / flownav.js) gives array i's name, and the kernel
// reads array i as k.p::<T>(i): a unit column's element type must be the one
// its JS column is allocated with (an Int32 column read as u16, or a Uint16
// one as i32, reads garbage, silently). storage-abi.test.cjs does the same
// for the movement kernel (mv.rs).
//   node tests/kernel-abi.test.cjs
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');
const ctx = vm.createContext({ console, FinalizationRegistry, SIM_SPATIAL_DEFAULTS: {} });
vm.runInContext(read('src/sim/sim_unit_state.js') + '\n;globalThis.__schema = SIM_UNIT_SCHEMA;', ctx);
const types = Object.fromEntries(Object.entries(ctx.__schema).map(([k, e]) => [k, e.Type.name]));
types.sepKey = 'Uint32Array'; types.sepLayer = 'Uint8Array'; types.mvNodes = 'Int32Array';
const rustToArray = { Q8: 'Int32Array', I8I32: 'Int8Array', U8I32: 'Uint8Array', F32: 'Float32Array', I32Number: 'Int32Array',
    f32: 'Float32Array', f64: 'Float64Array', i32: 'Int32Array', u32: 'Uint32Array', i16: 'Int16Array', u16: 'Uint16Array',
    i8: 'Int8Array', u8: 'Uint8Array', U16I32: 'Uint16Array', I16I32: 'Int16Array', u64: 'BigUint64Array', i64: 'BigInt64Array' };

// The JS argument lists: `const _x = _simWK([...])` and arrays of them.
const js = ['src/sim/sim_parallel.js', 'src/game/flownav.js', 'src/sim/sim_frame.js', 'src/things/unit.js', 'src/game/chunk.js', 'src/main.js']
    .filter(f => fs.existsSync(path.join(root, f))).map(read).join('\n');
const lists = {};
const evalList = src => vm.runInNewContext('[' + src + ']');
for (const m of js.matchAll(/(?:const|let) (_[A-Za-z0-9]+)\s*=\s*_simWK\(\[([\s\S]*?)\]\)/g)) {
    try { lists[m[1]] = [evalList(m[2]).map(n => String(n).replace(/^\?/, ''))]; } catch { }
}
for (const m of js.matchAll(/(?:const|let) (_[A-Za-z0-9]+)\s*=\s*\[\s*_simWK\(\[([\s\S]*?)\]\)\s*,\s*_simWK\(\[([\s\S]*?)\]\)\s*\]/g)) {
    try { lists[m[1]] = [evalList(m[2]), evalList(m[3])].map(l => l.map(n => String(n).replace(/^\?/, ''))); } catch { }
}
// Which list each Rust kernel gets.
const calls = [];
for (const m of js.matchAll(/_simRust\((_[A-Za-z0-9]+)(?:\[[^\]]*\])?\s*,\s*[^,]+,\s*[^,]+,\s*'([a-z_0-9]+)'/g)) calls.push([m[1], m[2]]);

const rs = read('wasm/src/k.rs');
const fnBody = name => {
    const at = rs.indexOf('pub unsafe extern "C" fn ' + name + '(');
    if (at < 0) return null;
    const m = /\r?\n\}\r?\n/.exec(rs.slice(at));
    return rs.slice(at, m ? at + m.index : rs.length);
};
const bad = [], unmatched = [];
let checked = 0, kernels = 0;
for (const [list, fn] of calls) {
    const L = lists[list];
    const body = fnBody(fn);
    if (!L || !body) { unmatched.push(list + ' -> ' + fn); continue; }
    kernels++;
    for (const m of body.matchAll(/k\.p::<([A-Za-z0-9]+)>\((\d+)\)/g)) {
        const [, t, iS] = m, i = +iS;
        for (const names of L) {
            const nm = names[i];
            if (!nm || !nm.startsWith('unit.')) continue;
            const col = nm.slice(5), want = types[col];
            if (!want) { bad.push(`${fn} arg ${i} (${list}): ${nm}: no such column`); continue; }
            if (rustToArray[t] !== want) bad.push(`${fn} arg ${i} (${list}): ${nm} read as ${t}, column ${want}`);
            checked++;
        }
    }
}
assert.equal(bad.length, 0, 'kernel ABI mismatches:\n  ' + bad.join('\n  '));
assert.ok(kernels >= 30 && checked >= 150, `coverage: ${kernels} kernels, ${checked} unit column reads (unmatched: ${unmatched.join(', ')})`);
console.log(`PASS: kernel ABI (${kernels} kernels, ${checked} unit column reads match their JS types${unmatched.length ? '; not parsed: ' + unmatched.join(', ') : ''})`);
