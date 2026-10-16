"use strict";

// ============================================================
// DETERMINISTIC MATH
// Lockstep peers may run different browsers. JavaScript fixes the result of
// + - * / exactly (IEEE 754, no fused operations), but not of Math.pow,
// hypot, exp, log, sin, cos or atan2, which can differ in the last bit
// between engines. Simulation code (and map generation from the seed) uses
// these helpers, built only from exact operations, so every peer computes
// identical values.
// Math.sqrt: ECMAScript lets it be approximated too (sec-math.sqrt), though
// IEEE 754 makes it correctly rounded and every engine known computes it so
// (the CPU's square root). The simulation relies on that, so it is checked
// when this file loads (_detSqrtCheck, a fixed set of values against an
// exact test); an engine that answers otherwise gets a correctly rounded
// square root in its place (slower, the same as everyone's). The Rust
// kernels' sqrt is IEEE 754's by the wasm specification.
// ============================================================
const _detView = new DataView(new ArrayBuffer(8));
const _DET_LN2_HI = 6.93147180369123816490e-01;
const _DET_LN2_LO = 1.90821492927058770002e-10;
const _DET_LN2 = 0.6931471805599453;

// ---- Math.sqrt, correctly rounded ----
// A finite positive double as m * 2^e (m a BigInt).
function _detBigOf(v) {
    _detView.setFloat64(0, v);
    const hi = _detView.getUint32(0), lo = _detView.getUint32(4), be = (hi >>> 20) & 0x7ff;
    let m = (BigInt(hi & 0xfffff) << 32n) | BigInt(lo);
    if (be) m |= 1n << 52n;
    return { m, e: (be ? be : 1) - 1075 };
}
// The next double up / down from a finite positive one.
function _detNextUp(v) { _detView.setFloat64(0, v); const b = _detView.getBigUint64(0) + 1n; _detView.setBigUint64(0, b); return _detView.getFloat64(0); }
function _detNextDown(v) { _detView.setFloat64(0, v); const b = _detView.getBigUint64(0) - 1n; _detView.setBigUint64(0, b); return _detView.getFloat64(0); }
// -1: r is below the correctly rounded square root of x, 1: above, 0: it is
// (x, r finite and positive). Exact: the midpoints next to r squared against
// x (a square root of a double is never exactly at a midpoint).
function _detSqrtCmp(x, r) {
    const X = _detBigOf(x);
    const mid = other => {
        const a = _detBigOf(r), b = _detBigOf(other), e = Math.min(a.e, b.e);
        return { m: (a.m << BigInt(a.e - e)) + (b.m << BigInt(b.e - e)), e: e - 1 };
    };
    // (q * 2^qe)^2 against x: compared at the lower exponent.
    const cmpSq = q => {
        const m2 = q.m * q.m, e2 = 2 * q.e, e = Math.min(e2, X.e);
        const a = m2 << BigInt(e2 - e), b = X.m << BigInt(X.e - e);
        return a < b ? -1 : a > b ? 1 : 0;
    };
    if (cmpSq(mid(_detNextUp(r))) <= 0) return -1;
    if (r > Number.MIN_VALUE && cmpSq(mid(_detNextDown(r))) >= 0) return 1;
    return 0;
}
const _detSqrtNative = Math.sqrt;
function _detSqrtSoft(x) {
    // (Special values: specified exactly.)
    if (!(x > 0) || x === Infinity) return _detSqrtNative(x);
    let r = _detSqrtNative(x);
    if (!(r > 0) || r === Infinity) r = 1;
    let c = _detSqrtCmp(x, r);
    if (c !== 0) { r = 0.5 * (r + x / r); c = _detSqrtCmp(x, r); }
    for (let k = 0; c !== 0 && k < 64; k++) { r = c < 0 ? _detNextUp(r) : _detNextDown(r); c = _detSqrtCmp(x, r); }
    return r;
}
// Whether this engine's Math.sqrt is correctly rounded on a fixed set of
// values (squares and their neighbours, every binade, subnormals); if not,
// Math.sqrt is replaced (DET_SQRT_NATIVE false).
let DET_SQRT_NATIVE = true;
function _detSqrtCheck(sqrt = Math.sqrt) {
    let s = 0x2545f491;
    const rnd = () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return (s >>> 0) / 4294967296; };
    const values = [5e-324, 1e-310, 2.2250738585072014e-308, 1e-300, 0.1, 0.5, 2, 3, 5, 10, 1e10 + 1, 4503599627370495, 9007199254740991, 1e300, 1.7976931348623157e308];
    for (let k = 1; k <= 64; k++) values.push(k * k, k * k + 1, k * k - 1, (k + 0.5) * (k + 0.5));
    for (let k = 0; k < 400; k++) values.push(_detLdexp(1 + rnd(), Math.floor(rnd() * 2000) - 1000));
    for (const x of values) {
        if (!(x > 0)) continue;
        const r = sqrt(x);
        if (!(r > 0) || r === Infinity || _detSqrtCmp(x, r) !== 0) return false;
    }
    return true;
}
try {
    if (!_detSqrtCheck()) {
        DET_SQRT_NATIVE = false;
        Math.sqrt = _detSqrtSoft;
        if (typeof console !== 'undefined') console.warn('[defence3] this engine\'s Math.sqrt is not correctly rounded: a correctly rounded one is used (lockstep with other browsers)');
    }
} catch (err) { }

function detHypot(x, y) {
    return Math.sqrt(x * x + y * y);
}

// x * 2^k, exactly (up to overflow/underflow).
function _detLdexp(v, k) {
    while (k > 1023) { v *= 8.98846567431158e307; k -= 1023; }
    while (k < -1022) { v *= 2.2250738585072014e-308; k += 1022; }
    _detView.setUint32(0, (k + 1023) << 20);
    _detView.setUint32(4, 0);
    return v * _detView.getFloat64(0);
}

function detLog(x) {
    x = +x;
    if (!(x > 0)) return x === 0 ? -Infinity : NaN;
    if (x === Infinity) return Infinity;
    let e = 0;
    if (x < 2.2250738585072014e-308) { x *= 18014398509481984; e = -54; }
    // x = m * 2^e with m in [sqrt(1/2), sqrt(2)).
    _detView.setFloat64(0, x);
    let hi = _detView.getUint32(0);
    e += ((hi >>> 20) & 0x7ff) - 1023;
    _detView.setUint32(0, (hi & 0x800fffff) | (1023 << 20));
    let m = _detView.getFloat64(0);
    if (m > Math.SQRT2) { m *= 0.5; e += 1; }
    // log(m) = 2 atanh(s), s = (m - 1) / (m + 1), |s| < 0.172.
    let s = (m - 1) / (m + 1);
    let s2 = s * s;
    let term = s;
    let sum = s;
    for (let k = 3; k <= 41; k += 2) {
        term *= s2;
        sum += term / k;
    }
    return (e * _DET_LN2_HI) + (2 * sum + e * _DET_LN2_LO);
}

function detExp(y) {
    y = +y;
    if (y !== y) return NaN;
    if (y > 709.782712893384) return Infinity;
    if (y < -745.1332191019411) return 0;
    let k = Math.round(y / _DET_LN2);
    let r = (y - k * _DET_LN2_HI) - k * _DET_LN2_LO;
    let term = 1;
    let sum = 1;
    for (let i = 1; i <= 20; i++) {
        term *= r / i;
        sum += term;
    }
    return _detLdexp(sum, k);
}

function detPow(base, exponent) {
    let b = +base, e = +exponent;
    if (e === 0) return 1;
    if (b !== b || e !== e) return NaN;
    if (Number.isInteger(e) && Math.abs(e) <= 4096) {
        // Square-and-multiply: a fixed sequence of exact multiplications.
        let n = Math.abs(e);
        let result = 1;
        let p = b;
        while (n > 0) {
            if (n % 2 === 1) result *= p;
            p *= p;
            n = Math.floor(n / 2);
        }
        return e < 0 ? 1 / result : result;
    }
    if (b === 1) return 1;
    if (b === 0) return e > 0 ? 0 : Infinity;
    if (b < 0) return NaN;
    if (b === Infinity) return e > 0 ? Infinity : 0;
    return detExp(e * detLog(b));
}

// floor(log2(n)) for n >= 1.
function detFloorLog2(n) {
    let v = Math.floor(Math.max(1, Number(n) || 1));
    // (Infinity never halves: past every finite value's 1023. A huge
    // adjacency group, stacks x members x area multipliers, overflows to it;
    // the loop never ended and a 200k-a-side start hung.)
    if (v === Infinity) return 1024;
    let k = 0;
    while (v >= 2) { v = Math.floor(v / 2); k++; }
    return k;
}

// ---- sin, cos, atan2 from + - * / alone (fdlibm's kernels) ----
// Map generation from the seed placed spawns and bodies with Math's
// trigonometry: one engine's last bit moved an island spawn from (20,47) to
// (19,47) (multiplayer sends the host's map; these keep a seed's map the
// same on every engine all the same). About as exact as Math's.
const _DET_PIO2_1 = 1.57079632673412561417e+00, _DET_PIO2_1T = 6.07710050650619224932e-11;
const _DET_PIO2_2 = 6.07710050630396597660e-11, _DET_PIO2_2T = 2.02226624879595063154e-21;
const _DET_INVPIO2 = 6.36619772367581382433e-01;
function _detKSin(x, y, iy) {
    const z = x * x, w = z * z;
    const r = 8.33333333332248946124e-03 + z * (-1.98412698298579493134e-04 + z * 2.75573137070700676789e-06) + z * w * (-2.50507602534068634195e-08 + z * 1.58969099521155010221e-10);
    const v = z * x;
    if (!iy) return x + v * (-1.66666666666666324348e-01 + z * r);
    return x - ((z * (0.5 * y - v * r) - y) - v * -1.66666666666666324348e-01);
}
function _detKCos(x, y) {
    const z = x * x, w = z * z;
    const r = z * (4.16666666666666019037e-02 + z * (-1.38888888888741095749e-03 + z * 2.48015872894767294178e-05))
        + w * w * (-2.75573143513906633035e-07 + z * (2.08757232129817482790e-09 + z * -1.13596475577881948265e-11));
    const hz = 0.5 * z, a = 1 - hz;
    return a + (((1 - a) - hz) + (z * r - x * y));
}
// x reduced by a multiple n of pi/2: [n, y0, y1] (y0 + y1 the rest).
const _detRem = [0, 0, 0];
function _detRemPio2(x) {
    const fn = Math.round(x * _DET_INVPIO2);
    let r = x - fn * _DET_PIO2_1, w = fn * _DET_PIO2_1T;
    const t = r;
    w = fn * _DET_PIO2_2;
    r = t - w;
    w = fn * _DET_PIO2_2T - ((t - r) - w);
    const y0 = r - w;
    _detRem[0] = fn; _detRem[1] = y0; _detRem[2] = (r - y0) - w;
    return _detRem;
}
function detSin(x) {
    x = +x;
    if (!Number.isFinite(x)) return NaN;
    if (Math.abs(x) <= 0.7853981633974483) return _detKSin(x, 0, 0);
    const R = _detRemPio2(x), q = ((R[0] % 4) + 4) % 4;
    return q === 0 ? _detKSin(R[1], R[2], 1) : q === 1 ? _detKCos(R[1], R[2]) : q === 2 ? -_detKSin(R[1], R[2], 1) : -_detKCos(R[1], R[2]);
}
function detCos(x) {
    x = +x;
    if (!Number.isFinite(x)) return NaN;
    if (Math.abs(x) <= 0.7853981633974483) return _detKCos(x, 0);
    const R = _detRemPio2(x), q = ((R[0] % 4) + 4) % 4;
    return q === 0 ? _detKCos(R[1], R[2]) : q === 1 ? -_detKSin(R[1], R[2], 1) : q === 2 ? -_detKCos(R[1], R[2]) : _detKSin(R[1], R[2], 1);
}
const _DET_ATANHI = [4.63647609000806093515e-01, 7.85398163397448278999e-01, 9.82793723247329054082e-01, 1.57079632679489655800e+00];
const _DET_ATANLO = [2.26987774529616870924e-17, 3.06161699786838301793e-17, 1.39033110312309984516e-17, 6.12323399573676603587e-17];
const _DET_AT = [3.33333333333329318027e-01, -1.99999999998764832476e-01, 1.42857142725034663711e-01, -1.11111104054623557880e-01, 9.09088713343650656196e-02,
    -7.69187620504482999495e-02, 6.66107313738753120669e-02, -5.83357013379057348645e-02, 4.97687799461593236017e-02, -3.65315727442169155270e-02, 1.62858201153657823623e-02];
function detAtan(x) {
    x = +x;
    if (x !== x) return NaN;
    const neg = x < 0;
    let a = neg ? -x : x;
    if (a >= 7.378697629483821e19) return neg ? -(_DET_ATANHI[3] + _DET_ATANLO[3]) : _DET_ATANHI[3] + _DET_ATANLO[3];
    let id = -1;
    if (a < 0.4375) {
        if (a < 3.725290298461914e-9) return x;
        a = x;
    } else if (a < 1.1875) {
        if (a < 0.6875) { id = 0; a = (2 * a - 1) / (2 + a); } else { id = 1; a = (a - 1) / (a + 1); }
    } else if (a < 2.4375) { id = 2; a = (a - 1.5) / (1 + 1.5 * a); } else { id = 3; a = -1 / a; }
    const T = _DET_AT, z = a * a, w = z * z;
    const s1 = z * (T[0] + w * (T[2] + w * (T[4] + w * (T[6] + w * (T[8] + w * T[10])))));
    const s2 = w * (T[1] + w * (T[3] + w * (T[5] + w * (T[7] + w * T[9]))));
    if (id < 0) return a - a * (s1 + s2);
    const r = _DET_ATANHI[id] - ((a * (s1 + s2) - _DET_ATANLO[id]) - a);
    return neg ? -r : r;
}
function detAtan2(y, x) {
    y = +y; x = +x;
    if (x !== x || y !== y) return NaN;
    const PI = 3.1415926535897931160e+00, PI_LO = 1.2246467991473531772e-16, PIO2 = 1.57079632679489655800e+00;
    const yNeg = y < 0 || Object.is(y, -0), xNeg = x < 0 || Object.is(x, -0);
    if (y === 0) return xNeg ? (yNeg ? -PI : PI) : y;
    if (x === 0) return yNeg ? -PIO2 : PIO2;
    if (x === Infinity) return y === Infinity ? 0.7853981633974483 : y === -Infinity ? -0.7853981633974483 : yNeg ? -0 : 0;
    if (x === -Infinity) return y === Infinity ? 2.356194490192345 : y === -Infinity ? -2.356194490192345 : yNeg ? -PI : PI;
    if (y === Infinity || y === -Infinity) return yNeg ? -PIO2 : PIO2;
    const q = Math.abs(y / x);
    let z;
    if (q > 1.152921504606847e18) z = PIO2 + 0.5 * PI_LO;
    else if (xNeg && q < 8.673617379884035e-19) z = 0;
    else z = detAtan(q);
    if (!xNeg) return yNeg ? -z : z;
    return yNeg ? (z - PI_LO) - PI : PI - (z - PI_LO);
}

let activeFormatBigNumberSuffixStart = null;

function formatBigNumber(n, d = 1, suffixStart = undefined) {
    if (n == null) return "...";
    if (typeof n === 'string') return n;
    if (!Number.isFinite(n)) return '' + n;

    let decimals = Math.max(1, Math.floor(Number.isFinite(d) ? d : 1));
    let sign = n < 0 ? '-' : '';
    let abs = Math.abs(n);
    let suffixThresholdRaw = (suffixStart === undefined)
        ? activeFormatBigNumberSuffixStart
        : suffixStart;
    let suffixThreshold = Number(suffixThresholdRaw);
    if (!Number.isFinite(suffixThreshold) || suffixThreshold <= 0) suffixThreshold = 1000000;
    if (abs < suffixThreshold) return sign + abs.toFixed(decimals);

    const suffixes = ['', 'K', 'M', 'B', 'T', 'Qa', 'Qi', 'Sx', 'Sp', 'Oc', 'No', 'Dc'];
    let tier = Math.floor(Math.log10(abs) / 3);

    if (tier >= suffixes.length) {
        let e = Math.floor(Math.log10(abs));
        return sign + 'e' + e;
    }

    let scaled = abs / Math.pow(1000, tier);

    // Handle boundary rollover (e.g. 999.995K -> 1.00M)
    let rounded = Number(scaled.toFixed(decimals));
    if (rounded >= 1000 && tier < suffixes.length - 1) {
        tier++;
        scaled = rounded / 1000;
        rounded = Number(scaled.toFixed(decimals));
    }

    let text = rounded.toFixed(decimals);
    return sign + text + suffixes[tier];
}

// At most ~4 characters for tight UI: "4.5", "828", "9.9K", "145K", "2.0M".
// Decimals only while they fit; fractions under 10 keep one decimal.
function formatCompactNumber(n) {
    if (n == null || !Number.isFinite(Number(n))) return '' + n;
    n = Number(n);
    let sign = n < 0 ? '-' : '';
    let abs = Math.abs(n);
    if (Number.isInteger(abs) && abs < 10) return sign + abs;
    if (Number(abs.toFixed(1)) < 10) return sign + abs.toFixed(1);
    if (Math.round(abs) < 1000) return sign + Math.round(abs);
    const suffixes = ['', 'K', 'M', 'B', 'T', 'Qa', 'Qi', 'Sx', 'Sp', 'Oc', 'No', 'Dc'];
    let tier = Math.max(1, Math.min(suffixes.length - 1, Math.floor(Math.log10(abs) / 3)));
    let scaled = abs / Math.pow(1000, tier);
    // Rounding up to the next tier (999.6K -> 1.0M).
    if (Math.round(scaled) >= 1000 && tier < suffixes.length - 1) { tier++; scaled /= 1000; }
    let text = Number(scaled.toFixed(1)) < 100 ? scaled.toFixed(1) : String(Math.round(scaled));
    return sign + text + suffixes[tier];
}

function _escapeHtml(text) {
    return String(text === undefined || text === null ? '' : text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function cloneJsValue(value) {
    if (Array.isArray(value)) return value.map(v => cloneJsValue(v));
    if (typeof value === 'function') return value;
    if (value && typeof value === 'object') {
        let out = {};
        for (let k in value) out[k] = cloneJsValue(value[k]);
        return out;
    }
    return value;
}

function replaceObjectContents(target, source) {
    if (!target || typeof target !== 'object') return;
    if (!source || typeof source !== 'object' || Array.isArray(source)) return;
    for (let k of Object.keys(target)) delete target[k];
    for (let k of Object.keys(source)) target[k] = cloneJsValue(source[k]);
}

function replaceArrayContents(target, source) {
    if (!Array.isArray(target) || !Array.isArray(source)) return;
    target.length = 0;
    for (let item of source) target.push(cloneJsValue(item));
}

function stringifyJsLike(value, depth = 0) {
    const pad = '  '.repeat(depth);
    const nextPad = '  '.repeat(depth + 1);

    if (typeof value === 'function') return value.toString();
    if (value === null) return 'null';
    if (Number.isNaN(value)) return 'NaN';
    if (value === Infinity) return 'Infinity';
    if (value === -Infinity) return '-Infinity';

    let t = typeof value;
    if (t === 'number' || t === 'boolean' || t === 'bigint') return String(value);
    if (t === 'string') return JSON.stringify(value);
    if (t === 'undefined') return 'undefined';

    if (Array.isArray(value)) {
        if (value.length <= 0) return '[]';
        let parts = value.map(v => `${nextPad}${stringifyJsLike(v, depth + 1)}`);
        return `[\n${parts.join(',\n')}\n${pad}]`;
    }

    if (value && t === 'object') {
        let keys = Object.keys(value);
        if (keys.length <= 0) return '{}';
        let parts = keys.map(k => `${nextPad}${JSON.stringify(k)}: ${stringifyJsLike(value[k], depth + 1)}`);
        return `{\n${parts.join(',\n')}\n${pad}}`;
    }

    return 'null';
}


function encodeFunctionsForTransport(value) {
    if (typeof value === 'number' && !Number.isFinite(value)) {
        if (Number.isNaN(value)) return { __specialNumber__: 'NaN' };
        if (value === Infinity) return { __specialNumber__: 'Infinity' };
        if (value === -Infinity) return { __specialNumber__: '-Infinity' };
    }
    if (typeof value === 'function') return { __fn__: value.toString() };
    if (Array.isArray(value)) return value.map(v => encodeFunctionsForTransport(v));
    if (value && typeof value === 'object') {
        let out = {};
        for (let k in value) out[k] = encodeFunctionsForTransport(value[k]);
        return out;
    }
    return value;
}

function decodeFunctionsFromTransport(value) {
    if (Array.isArray(value)) return value.map(v => decodeFunctionsFromTransport(v));
    if (value && typeof value === 'object') {
        if (Object.keys(value).length === 1 && typeof value.__specialNumber__ === 'string') {
            if (value.__specialNumber__ === 'NaN') return NaN;
            if (value.__specialNumber__ === 'Infinity') return Infinity;
            if (value.__specialNumber__ === '-Infinity') return -Infinity;
        }
        if (Object.keys(value).length === 1 && typeof value.__fn__ === 'string') {
            let fn = (new Function('"use strict"; return (' + value.__fn__ + ');'))();
            if (typeof fn !== 'function') throw new Error('Invalid function in transported config.');
            return fn;
        }
        let out = {};
        for (let k in value) out[k] = decodeFunctionsFromTransport(value[k]);
        return out;
    }
    return value;
}