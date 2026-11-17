"use strict";
// An order's unit ids on the wire (`uidz`), and a rally's tile keys (`tkz`):
// per id its difference from the previous one (zigzag, times two, plus one
// when a run follows) and then, if so, how many more ids follow it one by
// one, as base-64 varints. The same ids in the same order; a big army's order
// was ~7 bytes an id (2-3 MB for 400k units, sent to every player). Loaded by
// the page, the simulation worker (the page's scripts) and assign_worker.js.
const _UIDZ_ABC = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const _UIDZ_VAL = (() => { const t = new Int8Array(128).fill(-1); for (let i = 0; i < 64; i++) t[_UIDZ_ABC.charCodeAt(i)] = i; return t; })();
// (Only plain non-negative integer ids, an array or a typed array; anything
// else stays a list: null.)
// (The alphabet's character codes; the encoder's character buffer, reused: an order of 170k ids was ~10 ms of the
// page's thread with a charCodeAt and a division a digit.)
// The characters are ASCII bytes, made into the string at once (TextDecoder: ~10x String.fromCharCode in pieces).
const _UIDZ_CODE = (() => { const t = new Uint8Array(64); for (let i = 0; i < 64; i++) t[i] = _UIDZ_ABC.charCodeAt(i); return t; })();
let _uidzBuf = new Uint8Array(65536), _uidzDec = null;
function actionIdsEncode(ids) {
    if (!Array.isArray(ids) && !ArrayBuffer.isView(ids)) return null;
    const n = ids.length;
    for (let i = 0; i < n; i++) { const v = ids[i]; if (!(Number.isInteger(v) && v >= 0 && v <= 0x7fffffff)) return null; }
    // (At most 7 + 7 characters an id: a difference below 2^33 zigzagged and flagged, a run below 2^31.)
    if (_uidzBuf.length < n * 14 + 16) _uidzBuf = new Uint8Array(n * 14 + 16);
    const buf = _uidzBuf, C = _UIDZ_CODE;
    let at = 0, prev = 0;
    for (let i = 0; i < n;) {
        const id = ids[i], d = id - prev;
        let run = 0;
        while (i + 1 + run < n && ids[i + 1 + run] === id + 1 + run) run++;
        // (The difference zigzagged with the run flag: up to 2^33, past int32: floating point; the run below 2^31.)
        let v = (d >= 0 ? d * 2 : -d * 2 - 1) * 2 + (run > 0 ? 1 : 0);
        if (v < 2147483648) { while (v >= 32) { buf[at++] = C[32 | (v & 31)]; v >>>= 5; } }
        else while (v >= 32) { buf[at++] = C[32 | (v % 32)]; v = Math.floor(v / 32); }
        buf[at++] = C[v];
        if (run > 0) {
            let r = run - 1;
            while (r >= 32) { buf[at++] = C[32 | (r & 31)]; r >>>= 5; }
            buf[at++] = C[r];
        }
        prev = id + run;
        i += 1 + run;
    }
    if (!at) return '';
    if (_uidzDec === null) _uidzDec = new TextDecoder('latin1');
    return _uidzDec.decode(buf.subarray(0, at));
}
// Each id of actionIdsEncode's string to fn(id), at most `max` of them (others'
// actions: malformed or oversized input gives at most that many); returns how
// many. No list made.
function actionIdsForEach(s, max, fn) {
    if (typeof s !== 'string') return 0;
    let pos = 0, prev = 0, n = 0;
    const len = s.length;
    while (pos < len && n < max) {
        // (Two varints inline: the difference with its run flag, then the run.)
        let zf = 0, mul = 1, ok = false;
        for (let k = 0; k < 8 && pos < len; k++) {
            const c = s.charCodeAt(pos++), x = c < 128 ? _UIDZ_VAL[c] : -1;
            if (x < 0) break;
            zf += (x & 31) * mul;
            if (!(x & 32)) { ok = true; break; }
            mul *= 32;
        }
        if (!ok) break;
        let run = 0;
        if (zf % 2) {
            let v = 0; mul = 1; ok = false;
            for (let k = 0; k < 8 && pos < len; k++) {
                const c = s.charCodeAt(pos++), x = c < 128 ? _UIDZ_VAL[c] : -1;
                if (x < 0) break;
                v += (x & 31) * mul;
                if (!(x & 32)) { ok = true; break; }
                mul *= 32;
            }
            if (!ok) break;
            run = v + 1;
        }
        const z = Math.floor(zf / 2), id = prev + (z % 2 === 0 ? z / 2 : -(z + 1) / 2);
        if (!(id >= 0 && id <= 0x7fffffff)) break;
        fn(id); n++;
        for (let r = 1; r <= run && n < max; r++) { fn(id + r); n++; }
        prev = id + run;
    }
    return n;
}
// How many ids actionIdsDecode(s, max) gives, without the list (an order's
// cost: a run of ids is a few characters).
let _idsCountN = 0;
function _idsCountOne() { _idsCountN++; }
function actionIdsCount(s, max = (typeof ACTION_MAX_UNIT_IDS === 'number' ? ACTION_MAX_UNIT_IDS : 20000)) {
    return actionIdsForEach(s, max, _idsCountOne);
}
function actionIdsDecode(s, max = (typeof ACTION_MAX_UNIT_IDS === 'number' ? ACTION_MAX_UNIT_IDS : 20000)) {
    const out = [];
    actionIdsForEach(s, max, id => { out.push(id); });
    return out;
}
