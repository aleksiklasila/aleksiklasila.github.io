// Math that other engines may compute otherwise (multiplayer audit
// 2026-10-16: portability):
// - Math.sqrt: ECMAScript lets it be approximated. utils_common.js checks it
//   at load against an exact test and, where it is off, puts a correctly
//   rounded one in its place (DET_SQRT_NATIVE false): one unit in the last
//   place off for half the inputs, and one far off, both corrected to V8's
//   (correctly rounded) values; V8's own is kept.
// - detSin, detCos, detAtan2 (built from + - * / alone): the same bits under
//   another engine's trigonometry, and close to Math's.
// - A map generated from the seed (every map type) is the same under another
//   engine's Math (trigonometry and square root): an island spawn moved from
//   (20,47) to (19,47) with Math.cos/sin.
//   node tests/math-portability.test.cjs
'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const H = require('./net-harness.cjs');
const src = fs.readFileSync(path.join(__dirname, '..', 'src/utils/utils_common.js'), 'utf8');
const view = new DataView(new ArrayBuffer(8));
const ulpUp = (r, k = 1) => { view.setFloat64(0, r); view.setBigUint64(0, view.getBigUint64(0) + BigInt(k)); return view.getFloat64(0); };
// The file in a context of its own, with this Math.
function load(MathImpl) {
    const c = vm.createContext({ console: { warn() { } }, Math: MathImpl, DataView, ArrayBuffer, BigInt, Number, Object, Infinity, NaN });
    vm.runInContext(src + '\nthis.T = { native: DET_SQRT_NATIVE, sqrt: x => Math.sqrt(x), detSin, detCos, detAtan2, check: _detSqrtCheck };', c);
    return c.T;
}
const foreign = (sqrtOff) => {
    const m = Object.create(Math);
    const nudge = v => (Number.isFinite(v) && v !== 0 && !Number.isInteger(v)) ? v * (1 + 1e-9) : v;
    for (const k of ['sin', 'cos', 'tan', 'atan', 'atan2', 'pow', 'exp', 'log', 'hypot']) { const f = Math[k]; m[k] = (...a) => nudge(f(...a)); }
    if (sqrtOff) m.sqrt = sqrtOff;
    return m;
};
let seed = 7;
const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
const rows = [];

// Square roots.
{
    const own = load(Math);
    assert.equal(own.native, true, "V8's square root is correctly rounded");
    const halfOff = x => { const r = Math.sqrt(x); if (!(r > 0) || r === Infinity) return r; view.setFloat64(0, x); return (Math.imul(view.getUint32(4), 2654435761) >>> 31) ? ulpUp(r) : r; };
    const farOff = x => { const r = Math.sqrt(x); return r > 0 && r < Infinity ? r * (1 + 3e-10) : r; };
    for (const [label, f] of [['one unit off', halfOff], ['far off', farOff]]) {
        const T = load(foreign(f));
        assert.equal(T.native, false, label + ': found at load');
        let n = 0;
        for (let k = 0; k < 20000; k++) {
            const x = (1 + rnd()) * Math.pow(2, Math.floor(rnd() * 400) - 200);
            assert.equal(T.sqrt(x), Math.sqrt(x), label + ': sqrt(' + x + ')');
            n++;
        }
        for (const x of [0, -0, -1, NaN, Infinity, 5e-324, 1e-310, 4, 2, 1.7976931348623157e308]) assert.ok(Object.is(T.sqrt(x), Math.sqrt(x)), label + ': special ' + x);
        rows.push(`square root ${label}: found at load, replaced, ${n} values correctly rounded`);
    }
}

// Trigonometry from exact operations.
{
    const own = load(Math), other = load(foreign(null));
    let worst = 0, n = 0;
    for (let k = 0; k < 30000; k++) {
        const x = (rnd() - .5) * (k < 20000 ? 20 : 20000), y = (rnd() - .5) * 50;
        for (const [a, b, ref] of [[own.detSin(x), other.detSin(x), Math.sin(x)], [own.detCos(x), other.detCos(x), Math.cos(x)], [own.detAtan2(y, x), other.detAtan2(y, x), Math.atan2(y, x)]]) {
            assert.ok(Object.is(a, b), 'the same bits under other trigonometry');
            worst = Math.max(worst, Math.abs(a - ref) / Math.max(1, Math.abs(ref)));
            n++;
        }
    }
    assert.ok(worst < 1e-15, 'close to Math: ' + worst);
    for (const [y, x] of [[0, 1], [-0, 1], [0, -1], [-0, -1], [1, 0], [-1, 0], [0, 0], [-0, -0], [Infinity, Infinity], [-Infinity, -Infinity], [1, Infinity], [1, -Infinity], [-1, -Infinity], [Infinity, 1], [NaN, 1]])
        assert.ok(Object.is(own.detAtan2(y, x), Math.atan2(y, x)), `atan2(${y}, ${x})`);
    rows.push(`detSin/detCos/detAtan2: ${n} values, the same bits under another Math, within ${worst.toExponential(1)} of V8's`);
}

// Maps from the seed under another engine's Math.
(async () => {
    for (const [type, size] of [['island', 60], ['island', 61], ['islands', 60], ['solar_system', 80], ['crossroads', 60], ['arena', 40]]) {
        const world = new H.World({ controls: { ...H.SMALL_MATCH_CONTROLS, 'cfg-map-type': type, 'cfg-mapsize': String(size) } });
        const make = (name, foreignMath) => {
            const inst = world.spawn(name, { foreignMath });
            inst.eval('readConfigFromMenu(); isMultiplayer = false; gameSeed = 424242; localPlayerId = 0; startGame();');
            return inst.eval(`JSON.stringify({ grid: grid.map(r => r.map(c => c.type).join('')).join('|'), exact: __exactStateHash(),
                units: units.map(u => [u.unitType, u.owner, u.x, u.y]).sort().join(';'), sqrt: DET_SQRT_NATIVE })`);
        };
        const a = JSON.parse(make('v8', false)), b = JSON.parse(make('other', true));
        assert.equal(b.sqrt, false, 'the other square root replaced');
        assert.equal(b.grid, a.grid, `${type} ${size}: the same terrain`);
        assert.equal(b.units, a.units, `${type} ${size}: the same spawns`);
        assert.equal(b.exact, a.exact, `${type} ${size}: the same world`);
        rows.push(`${type} ${size}x${size}: the same map, spawns and world under another Math`);
    }
    // The tests' exact fingerprint (net-harness.cjs __exactStateHash) sees a
    // path's waypoints, not only its length.
    {
        const world = new H.World({ controls: H.SMALL_MATCH_CONTROLS });
        const inst = world.spawn('fp');
        inst.eval('readConfigFromMenu(); isMultiplayer = false; gameSeed = 5; localPlayerId = 0; startGame();');
        const r = JSON.parse(inst.eval(`JSON.stringify((() => { const u = units.find(u => !u.dead); u.path = [{ x: 3, y: 4 }, { x: 5, y: 6 }]; u.pathIndex = 0;
            const a = __exactStateHash(); u.path[1] = { x: 5, y: 7 }; const b = __exactStateHash(); return [a, b, u.path.length]; })())`));
        assert.equal(r[2], 2);
        assert.notEqual(r[1], r[0], 'a moved waypoint changes the fingerprint');
        rows.push("the exact fingerprint sees a path's waypoints");
    }
    console.log('PASS math-portability\n  ' + rows.join('\n  '));
})().catch(e => { console.error(e); process.exit(1); });
