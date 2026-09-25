"use strict";

// ============================================================
// DETERMINISTIC MATH
// Lockstep peers may run different browsers. JavaScript fixes the result of
// + - * / and Math.sqrt exactly (IEEE 754, no fused operations), but not of
// Math.pow, hypot, exp, log, sin, cos or atan2, which can differ in the last
// bit between engines. Simulation code uses these helpers, built only from
// exact operations, so every peer computes identical values.
// ============================================================
const _detView = new DataView(new ArrayBuffer(8));
const _DET_LN2_HI = 6.93147180369123816490e-01;
const _DET_LN2_LO = 1.90821492927058770002e-10;
const _DET_LN2 = 0.6931471805599453;

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
    let k = 0;
    while (v >= 2) { v = Math.floor(v / 2); k++; }
    return k;
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