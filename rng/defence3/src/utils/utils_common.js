"use strict";

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