"use strict";

// ============================================================
// FRAME EFFECTS (3D view and the GPU 2D view)
// ============================================================
// Turns the visual combat records (particle.js), projectiles, particles,
// laser fences and building/unit activity into effect instances in the
// renderer's FxBatch. Everything is a pure function of the records, the live
// entities and the render clock: no per-effect state or allocation.
// Heights are in tiles. The 2D view draws the same instances in an oblique
// projection (height lifts a shape up the screen), with resting heights
// flattened so only arcs and hops stand out.

const _fxRgbCache = new Map();
function _fxRgb(color) {
    let rgb = _fxRgbCache.get(color);
    if (rgb) return rgb;
    let hex = String(color || '#fff').trim().replace('#', '');
    if (hex.length === 3) hex = hex.replace(/./g, ch => ch + ch);
    let n = /^[0-9a-f]{6}$/i.test(hex) ? parseInt(hex, 16) : 0xffffff;
    rgb = [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255];
    if (typeof color === 'string' && !/^#/.test(color)) {
        // Named colors used by legacy particles.
        let named = { orange: [1, .55, .1], red: [1, .2, .2], white: [1, 1, 1] }[color];
        if (named) rgb = named;
    }
    if (_fxRgbCache.size > 512) _fxRgbCache.clear();
    _fxRgbCache.set(color, rgb);
    return rgb;
}

// Base durations in ticks at 20 ticks per second.
const _FX_DURATION = [0, 7, 6, 12, 16, 7, 9, 12, 11, 10, 6, 9, 9];
const _FX_ELEMENT = {
    1: { main: '#ff6a1a', glow: '#ffd27a' },
    2: { main: '#3aa8ff', glow: '#bfe6ff' },
    3: { main: '#b8f4ff', glow: '#ffffff' },
    4: { main: '#5de04a', glow: '#c6ff9a' }
};
const _FX_SHOT_COLOR = {
    0: '#fff4c8', 1: '#ff7a1a', 2: '#3aa8ff', 3: '#c8f6ff', 4: '#5de04a', 5: '#ff3030', 6: '#ffd76a', 7: '#bfc4ff',
    8: '#ffffff', 9: '#d9a86a', 10: '#ffffff', 11: '#ffe14a'
};
// Arc height per tile of flight and its cap: lobbed fire/water/poison, flat
// fast bullets. Style ids match COMBAT_FX_STYLE.
const _FX_ARC = { 0: [.05, .3], 1: [.2, 1.1], 2: [.26, 1.3], 3: [.07, .35], 4: [.19, 1], 6: [.05, .3], 7: [0, 0],
    8: [0, 0], 9: [.1, .5], 10: [.15, .8], 11: [0, 0] };

const _fx = {
    batch: null, flat: false, detail: true, now: 0, tickScale: 1, rest: 1,
    minX: 0, minZ: 0, maxX: 0, maxZ: 0, vis: null, full: false, lastNow: -Infinity
};
let _FXM = null, _FXP = null;

function _fxVisible(tx, tz) {
    if (tx < _fx.minX || tx > _fx.maxX || tz < _fx.minZ || tz > _fx.maxZ) return false;
    if (_fx.full) return true;
    let row = _fx.vis[Math.floor(tz)];
    return !!(row && row[Math.floor(tx)] > 0);
}

// Hash of an effect's seed into [0, 1).
function _fxHash(seed, k) {
    let h = Math.imul((seed | 0) * 374761393 + k * 668265263, 1274126177);
    return ((h ^ (h >>> 13)) >>> 0) / 4294967296;
}

function _fxPush(mesh, x, y, z, yaw, sx, sy, sz, pitch, rgb, alpha, pattern, param, roll, additive) {
    _fx.batch.push(mesh, x, y, z, yaw, sx, sy, sz, pitch, rgb[0], rgb[1], rgb[2], alpha, pattern, param, roll, additive);
}

function _fxOrb(x, y, z, size, color, alpha, additive = 1) {
    _fxPush(_FXM.ORB, x, y, z, 0, size, size, size, 0, _fxRgb(color), alpha, _FXP.GLOW_SOLID, 0, 0, additive);
}

function _fxDecal(x, y, z, yaw, size, color, alpha, pattern, param, additive = 1, pitch = 0, roll = 0) {
    _fxPush(_FXM.DECAL, x, y, z, yaw, size, 1, size, pitch, _fxRgb(color), alpha, pattern, param, roll, additive);
}

function _fxBox(x, y, z, yaw, sx, sy, sz, pitch, color, alpha, pattern = 0, roll = 0, additive = 0) {
    _fxPush(_FXM.BOX, x, y, z, yaw, sx, sy, sz, pitch, _fxRgb(color), alpha, pattern, 0, roll, additive);
}

// A beam as a box from (ax, ay, az) to (bx, by, bz).
function _fxBeam(ax, ay, az, bx, by, bz, width, color, alpha, additive = 1) {
    let dx = bx - ax, dy = by - ay, dz = bz - az;
    let flatLen = Math.hypot(dx, dz), len = Math.hypot(flatLen, dy);
    if (len < .001) return;
    _fxPush(_FXM.BOX, (ax + bx) * .5, (ay + by) * .5, (az + bz) * .5, Math.atan2(dx, dz), width, width, len,
        -Math.atan2(dy, flatLen), _fxRgb(color), alpha, _FXP.GLOW_SOLID, 0, 0, additive);
}

// A spike pointing along its flight: yaw and elevation.
function _fxSpike(x, y, z, yaw, elevation, width, length, color, alpha, pattern = 1, additive = 0) {
    _fxPush(_FXM.SPIKE, x, y, z, yaw, width, length, width, Math.PI * .5 - elevation, _fxRgb(color), alpha, pattern, 0, 0, additive);
}

// Point on a lobbed path from (x0, h0, z0) to (x1, h1, z1) with apex lift.
function _fxArcY(h0, h1, apex, t) {
    return h0 + (h1 - h0) * t + 4 * apex * t * (1 - t);
}

function _fxShadow(x, z, size, alpha) {
    _fxPush(_FXM.DECAL, x, .012, z, 0, size, 1, size, 0, _fxRgb('#000'), alpha, _FXP.SHADOW, 0, 0, 0);
}

function _fxEnvelope(q, fadeIn, fadeOut) {
    let a = q < fadeIn ? q / fadeIn : 1;
    if (q > 1 - fadeOut) a *= (1 - q) / fadeOut;
    return Math.max(0, a);
}

// ---- Recorded attacks, shots and hits ---------------------------------

function _fxEvent(kind, x0, z0, x1, z1, style, seed, q) {
    const rest = _fx.rest, detail = _fx.detail;
    let dx = x1 - x0, dz = z1 - z0, dist = Math.hypot(dx, dz) || .001;
    let yaw = Math.atan2(dx, dz), nx = dx / dist, nz = dz / dist;
    let fade = 1 - q;
    switch (kind) {
        case 1: case 12: { // SLASH, CLEAVE (king)
            let king = kind === 12, size = king ? 1.05 : .78;
            let color = king ? '#ffd84a' : '#eef6ff';
            let side = _fxHash(seed, 1) < .5 ? -1 : 1;
            _fxDecal(x1 - nx * .2 * size, .32 * rest, z1 - nz * .2 * size, yaw, size, color, .95 * _fxEnvelope(q, .1, .45),
                _FXP.CRESCENT, Math.min(1, q * 2.4), 1, 0, side * .55);
            if (king) _fxDecal(x1, .02, z1, 0, .5 + q * .7, '#ffd84a', .7 * fade, _FXP.RING, .8, 1);
            if (detail) for (let k = 0; k < 2; k++) {
                let a = yaw + (k ? 1.9 : -1.9) + _fxHash(seed, k + 2) * .6;
                let r = .08 + q * .32;
                _fxOrb(x1 + Math.sin(a) * r, (.32 * rest) + Math.sin(q * Math.PI) * .18, z1 + Math.cos(a) * r, .05 * fade + .02, '#ffe7a0', fade);
            }
            break;
        }
        case 2: // DUAL (fast): quick crossed cuts
            _fxDecal(x1, .3 * rest, z1, yaw, .62, '#f4f4ff', .95 * _fxEnvelope(q, .08, .4), _FXP.CROSS, Math.min(1, q * 1.8), 1);
            break;
        case 3: { // SMASH (tank, boss): shockwave and flying rubble
            let boss = style === 13, size = boss ? 1.7 : 1.15;
            _fxDecal(x1, .015, z1, 0, size * (.35 + q * .75), '#d8c8a8', .85 * fade, _FXP.RING, .82, 0);
            if (q < .3) _fxOrb(x1, .12 * rest, z1, .18 + q, '#fff1c8', (1 - q / .3) * .8);
            if (detail) for (let k = 0; k < (boss ? 6 : 4); k++) {
                let a = _fxHash(seed, k) * Math.PI * 2, r = q * (.35 + _fxHash(seed, k + 9) * .3);
                let hop = (.22 + _fxHash(seed, k + 20) * .25) * Math.sin(Math.min(1, q * 1.2) * Math.PI);
                _fxBox(x1 + Math.sin(a) * r, .03 + hop, z1 + Math.cos(a) * r, a, .07, .06, .08, q * 6, boss ? '#6d6258' : '#8a7a66', Math.min(1, fade * 2), 0, q * 9);
            }
            break;
        }
        case 4: { // CAST: a rune on the target, then the element erupts there
            let el = _FX_ELEMENT[style] || _FX_ELEMENT[1];
            let rune = _fxEnvelope(q, .18, .3);
            _fxDecal(x1, .025, z1, 0, .55 + Math.min(1, q * 4) * .45, el.main, .9 * rune, _FXP.RUNE, q * 3.2 + seed, 1);
            if (q < .3) {
                // A mote from the staff marks who cast it.
                let t = q / .3;
                _fxOrb(x0 + dx * t, (.78 * (1 - t) + .45 * t) * rest + Math.sin(t * Math.PI) * .12, z0 + dz * t, .09, el.glow, 1);
            }
            if (q > .2) {
                let e = (q - .2) / .8, rise = Math.sin(e * Math.PI);
                if (style === 1) { // fire: flame tongues
                    for (let k = 0; k < (detail ? 3 : 1); k++) {
                        let a = k * 2.1 + seed, r = k ? .13 : 0;
                        _fxSpike(x1 + Math.sin(a) * r, 0, z1 + Math.cos(a) * r, a, Math.PI * .5, .16 - k * .03, (.5 - k * .1) * rise + .02, k ? '#ffb347' : '#ff6a1a', Math.min(1, rise * 1.6), 1, 1);
                    }
                    _fxDecal(x1, .02, z1, 0, .7, '#ff8a2a', .6 * rise, _FXP.GLOW, 0, 1);
                } else if (style === 2) { // water: splash and droplets
                    _fxDecal(x1, .02, z1, 0, .4 + e * .6, '#8fd0ff', .9 * (1 - e), _FXP.RING, .8, 1);
                    _fxSpike(x1, 0, z1, 0, Math.PI * .5, .13, .45 * rise, '#3aa8ff', .8 * rise, 1, 0);
                    if (detail) for (let k = 0; k < 4; k++) {
                        let a = k * 1.57 + seed, r = .1 + e * .25;
                        _fxOrb(x1 + Math.sin(a) * r, .05 + Math.sin(e * Math.PI) * (.28 + k * .03), z1 + Math.cos(a) * r, .06, '#bfe6ff', 1 - e, 0);
                    }
                } else if (style === 3) { // ice: spikes jut from the ground
                    let grow = Math.min(1, e * 4) * (e > .8 ? (1 - e) / .2 : 1);
                    for (let k = 0; k < (detail ? 5 : 2); k++) {
                        let a = k * 1.2566 + seed;
                        _fxSpike(x1 + Math.sin(a) * .1, 0, z1 + Math.cos(a) * .1, a, Math.PI * .5 - .5, .09, .36 * grow + .01, '#c8f6ff', .95, 1, 0);
                    }
                    _fxSpike(x1, 0, z1, 0, Math.PI * .5, .11, .46 * grow + .01, '#eaffff', .95, 1, 0);
                } else { // poison: bubbling cloud and a splat
                    _fxDecal(x1, .018, z1, seed, .75, '#3fa83a', .55 * (1 - e * .6), _FXP.SPLAT, e, 0);
                    for (let k = 0; k < (detail ? 4 : 1); k++) {
                        let a = k * 1.7 + seed, local = (e * 1.4 + k * .23) % 1;
                        _fxOrb(x1 + Math.sin(a) * .16, .05 + local * .45, z1 + Math.cos(a) * .16, .05 + local * .1, k & 1 ? '#8cff6a' : '#5de04a', (1 - local) * .85, 0);
                    }
                }
            }
            break;
        }
        case 5: { // BEAM (laser caster): a raised beam from the staff tip
            let width = .09 * (1 - q) + .015;
            let ay = .82 * rest, by = .38 * rest;
            _fxBeam(x0 + nx * .12, ay, z0 + nz * .12, x1, by, z1, width, '#e040ff', .9 * fade);
            _fxBeam(x0 + nx * .12, ay, z0 + nz * .12, x1, by, z1, width * .4, '#ffffff', fade);
            _fxOrb(x1, by, z1, .18 + .1 * Math.sin(q * 20), '#f08cff', fade);
            _fxDecal(x1, .02, z1, 0, .45 + q * .4, '#e040ff', .7 * fade, _FXP.RING, .75, 1);
            break;
        }
        case 6: { // SWOOP (flying): raking talons and loose feathers
            _fxDecal(x1, .34 * rest, z1, yaw, .66, '#fff2a0', .95 * _fxEnvelope(q, .05, .45), _FXP.CLAWS, Math.min(1, q * 2.6), 1);
            if (detail) for (let k = 0; k < 3; k++) {
                let a = seed + k * 2.2, drift = q * .35;
                _fxBox(x1 + Math.sin(a) * drift, (.55 - q * .45) * rest + .04, z1 + Math.cos(a) * drift, a + q * 4, .1, .012, .05, Math.sin(q * 9 + k) * .6, '#e8d98a', fade, 0, q * 3);
            }
            break;
        }
        case 7: { // SCOUT: the rider's javelin, then a watching mark
            if (q < .45) {
                let t = q / .45, apex = Math.min(.5, dist * .12);
                let y = _fxArcY(.62 * rest, .32 * rest, apex, t);
                let slope = ((.32 - .62) * rest + 4 * apex * (1 - 2 * t)) / dist;
                _fxSpike(x0 + dx * t, y, z0 + dz * t, yaw, Math.atan(slope), .035, .42, '#d8b47a', 1, 0, 0);
                _fxShadow(x0 + dx * t, z0 + dz * t, .2, .3);
            } else {
                let e = (q - .45) / .55;
                _fxDecal(x1, .02, z1, 0, .5 + e * .5, '#9cf', .9 * (1 - e), _FXP.RING, .85, 1);
                _fxOrb(x1, .7 * rest + .1, z1, .08, '#cfe8ff', (1 - e) * (Math.sin(e * 18) > -.4 ? 1 : .3));
            }
            break;
        }
        case 8: { // SPIT (snake engine): venom glob, splat and steam
            if (q < .4) {
                let t = q / .4, apex = .28;
                let y = _fxArcY(.45 * rest, .3 * rest, apex, t);
                _fxOrb(x0 + dx * t, y, z0 + dz * t, .15, '#7dff3a', 1, 0);
                if (detail) _fxOrb(x0 + dx * (t - .12), _fxArcY(.45 * rest, .3 * rest, apex, Math.max(0, t - .12)), z0 + dz * (t - .12), .08, '#b6ff7a', .7, 1);
                _fxShadow(x0 + dx * t, z0 + dz * t, .22, .3);
            } else {
                let e = (q - .4) / .6;
                _fxDecal(x1, .018, z1, seed, .5 + e * .3, '#58d63a', .8 * (1 - e), _FXP.SPLAT, e, 0);
            }
            if (detail && !_fx.flat) for (let k = 0; k < 2; k++) {
                let local = Math.min(1, q * 1.4 + k * .3);
                _fxOrb(x0 - nx * .05, .62 + local * .5, z0 - nz * .05, .07 + local * .12, '#e3e9ee', .45 * (1 - local), 0);
            }
            break;
        }
        case 9: { // DIG (mole): dirt thrown up from the target's feet
            _fxDecal(x1, .015, z1, 0, .35 + q * .45, '#8a6a44', .7 * fade, _FXP.RING, .8, 0);
            for (let k = 0; k < (detail ? 4 : 2); k++) {
                let a = _fxHash(seed, k) * 6.283, r = q * (.2 + _fxHash(seed, k + 5) * .2);
                _fxBox(x1 + Math.sin(a) * r, .03 + Math.sin(q * Math.PI) * (.2 + k * .04), z1 + Math.cos(a) * r, a, .07, .06, .07, q * 5, '#6b4a2a', Math.min(1, fade * 2), 0, q * 7);
            }
            break;
        }
        case 10: { // MUZZLE (tower): flash at the barrel and a smoke puff
            let color = _FX_SHOT_COLOR[style] || '#fff4c8';
            let tipX = x0 + nx * .42, tipZ = z0 + nz * .42, tipY = .78 * rest;
            let big = style === 8 ? 1.6 : style === 1 ? 1.3 : 1;
            if (q < .5) _fxOrb(tipX, tipY, tipZ, (.2 + .1 * big) * (1 - q * 2) + .04, color, 1);
            if (style === 8 && q < .4) _fxBeam(tipX, tipY, tipZ, tipX + nx * .9, tipY - .05, tipZ + nz * .9, .025, '#ffffff', 1 - q / .4);
            if (detail && !_fx.flat) _fxOrb(tipX, tipY + q * .45, tipZ, .08 + q * .16, '#b8bec4', .4 * (1 - q), 0);
            break;
        }
        case 11: { // IMPACT: the shot's own kind of hit
            let hy = .3 * rest;
            if (style === 1) {
                _fxOrb(x1, hy, z1, .2 + q * .45, q < .5 ? '#ffd27a' : '#ff6a1a', fade * .95);
                _fxDecal(x1, .02, z1, 0, .5 + q * .8, '#ff7a1a', .8 * fade, _FXP.RING, .8, 1);
                _fxDecal(x1, .015, z1, seed, .7, '#2a1a10', .45 * fade, _FXP.SPLAT, 0, 0);
            } else if (style === 2) {
                _fxDecal(x1, .02, z1, 0, .35 + q * .6, '#8fd0ff', .9 * fade, _FXP.RING, .8, 1);
                if (detail) for (let k = 0; k < 3; k++) {
                    let a = k * 2.1 + seed;
                    _fxOrb(x1 + Math.sin(a) * q * .3, hy * .5 + Math.sin(q * Math.PI) * .25, z1 + Math.cos(a) * q * .3, .05, '#bfe6ff', fade, 0);
                }
            } else if (style === 3) {
                _fxDecal(x1, .02, z1, 0, .4 + q * .4, '#ffffff', .8 * fade, _FXP.RING, .8, 1);
                for (let k = 0; k < (detail ? 4 : 2); k++) {
                    let a = k * 1.57 + seed;
                    _fxSpike(x1 + Math.sin(a) * q * .25, hy * .6, z1 + Math.cos(a) * q * .25, a, .4, .05, .16, '#c8f6ff', fade, 1, 0);
                }
            } else if (style === 4) {
                _fxDecal(x1, .018, z1, seed, .55 + q * .25, '#4cc83c', .7 * fade, _FXP.SPLAT, q, 0);
            } else if (style === 9) {
                _fxDecal(x1, .015, z1, 0, .4 + q * .7, '#c99a66', .75 * fade, _FXP.RING, .75, 0);
                _fxDecal(x1, .02, z1, 0, .6, '#e0b98a', .4 * fade, _FXP.GLOW, 0, 0);
            } else if (style === 10) {
                const cycle = ['#ff6a1a', '#3aa8ff', '#5de04a', '#b8f4ff'];
                for (let k = 0; k < 3; k++) {
                    let local = Math.max(0, Math.min(1, q * 1.5 - k * .2));
                    if (local > 0 && local < 1) _fxDecal(x1, .02 + k * .002, z1, 0, .3 + local * .7, cycle[(k + seed) & 3], .8 * (1 - local), _FXP.RING, .82, 1);
                }
            } else if (style === 11) {
                _fxDecal(x1, .02, z1, 0, .4 + q * .5, '#ffe14a', .8 * fade, _FXP.RING, .85, 1);
            } else if (style === 8) {
                _fxDecal(x1, hy, z1, seed, .5, '#ffffff', fade, _FXP.CROSS, 1, 1);
                _fxOrb(x1, hy, z1, .22 * fade + .03, '#ffffff', fade);
            } else {
                _fxOrb(x1, hy, z1, .12 * fade + .03, _FX_SHOT_COLOR[style] || '#fff4c8', fade);
                _fxDecal(x1, .02, z1, 0, .25 + q * .35, '#fff4c8', .6 * fade, _FXP.RING, .8, 1);
            }
            break;
        }
    }
}

function _pushCombatRecordFx() {
    if (typeof combatFxData === 'undefined') return;
    const data = combatFxData, stride = COMBAT_FX_STRIDE, now = _fx.now, tickScale = _fx.tickScale;
    for (let o = 0, end = COMBAT_FX_CAPACITY * stride; o < end; o += stride) {
        let kind = data[o];
        if (!kind) continue;
        let age = now - data[o + 5];
        let duration = (_FX_DURATION[kind] || 8) * tickScale;
        if (age >= duration) { data[o] = 0; continue; }
        if (age < 0) continue;
        let x1 = data[o + 3] / TILE, z1 = data[o + 4] / TILE;
        let x0 = data[o + 1] / TILE, z0 = data[o + 2] / TILE;
        if (!_fxVisible(x1, z1) && !_fxVisible(x0, z0)) continue;
        _fxEvent(kind, x0, z0, x1, z1, data[o + 6], data[o + 7], age / duration);
    }
}

// ---- Projectiles --------------------------------------------------------

const _fxProjectileStyle = new Map();
function _fxStyleOf(type) {
    let style = _fxProjectileStyle.get(type);
    if (style === undefined) {
        style = (typeof COMBAT_FX_STYLE !== 'undefined' && COMBAT_FX_STYLE[type]) || 0;
        _fxProjectileStyle.set(type, style);
    }
    return style;
}

function _pushProjectileFx(p, px, pz) {
    const rest = _fx.rest;
    let style = _fxStyleOf(p.type);
    let sx = p.startX / TILE, sz = p.startY / TILE;
    let aim = (Number(p.aimDist) || 160) / TILE;
    let traveled = Math.hypot(px - sx, pz - sz);
    let t = Math.max(0, Math.min(1, traveled / Math.max(.05, aim)));
    let arc = _FX_ARC[style] || _FX_ARC[0];
    let apex = Math.min(arc[1], arc[0] * aim);
    let h0 = .76 * rest, h1 = .3 * rest;
    let y = _fxArcY(h0, h1, apex, t);
    let slope = ((h1 - h0) + 4 * apex * (1 - 2 * t)) / Math.max(.05, aim);
    let elevation = Math.atan(slope);
    let vx = Number(p.vx) || 0, vz = Number(p.vy) || 1;
    let yaw = Math.atan2(vx, vz);
    let speed = Math.hypot(vx, vz) || 1, ux = vx / speed, uz = vz / speed;
    let color = _FX_SHOT_COLOR[style] || (BASE_CARD_TYPES[p.type] || {}).color || '#fff';
    if (apex > .02 || !_fx.flat) _fxShadow(px, pz, .2, .28);
    // A point `back` tiles behind along the same arc.
    let trail = (back) => {
        let tt = Math.max(0, t - back / Math.max(.05, aim));
        return [px - ux * back, _fxArcY(h0, h1, apex, tt), pz - uz * back];
    };
    switch (style) {
        case 1: { // fireball
            _fxOrb(px, y, pz, .2, '#ff7a1a', 1, 0);
            _fxOrb(px, y, pz, .34, '#ffb347', .5);
            if (_fx.detail) for (let k = 1; k <= 2; k++) { let q = trail(k * .16); _fxOrb(q[0], q[1], q[2], .13 - k * .03, '#ffd27a', .7 - k * .2); }
            break;
        }
        case 2: case 4: { // water / poison globs
            let main = style === 2 ? '#3aa8ff' : '#5de04a', light = style === 2 ? '#bfe6ff' : '#b6ff7a';
            _fxOrb(px, y, pz, .18, main, 1, 0);
            if (_fx.detail) for (let k = 1; k <= 2; k++) { let q = trail(k * .14); _fxOrb(q[0], q[1], q[2], .08 - k * .015, light, .8 - k * .25, 0); }
            break;
        }
        case 3: // ice shard pointing along its flight
            _fxSpike(px - ux * .15, y, pz - uz * .15, yaw, elevation, .11, .34, '#c8f6ff', 1, 1, 0);
            _fxOrb(px, y, pz, .16, '#eaffff', .35);
            break;
        case 7: case 8: { // tracers
            let len = style === 8 ? .55 : .26, width = style === 8 ? .035 : .04;
            _fxBeam(px - ux * len, y, pz - uz * len, px, y, pz, width, color, 1, 0);
            let tailLen = style === 8 ? 1.1 : .45, q = trail(tailLen);
            _fxBeam(q[0], q[1], q[2], px - ux * len, y, pz - uz * len, width * .6, color, .45);
            break;
        }
        case 9: // sand: a small cluster of grains
            for (let k = -1; k <= 1; k++) {
                let side = k * .07;
                _fxBox(px - uz * side - ux * Math.abs(k) * .05, y + (k & 1) * .03, pz + ux * side - uz * Math.abs(k) * .05, yaw + k, .06, .05, .06, 0, '#d9a86a', 1);
            }
            break;
        case 10: { // elements: color-cycling orb
            const cycle = ['#ff6a1a', '#3aa8ff', '#5de04a', '#b8f4ff'];
            let c = cycle[Math.floor(_fx.now / (3 * _fx.tickScale)) & 3];
            _fxOrb(px, y, pz, .17, c, 1, 0);
            _fxOrb(px, y, pz, .3, '#ffffff', .3);
            break;
        }
        case 11: // watcher's eye
            _fxOrb(px, y, pz, .12, '#ffe14a', 1, 0);
            _fxOrb(px, y, pz, .26, '#ffe14a', .4);
            break;
        default: // pistol and others: a bullet with a short glow
            _fxBox(px, y, pz, yaw, .06, .06, .16, -elevation, color, 1, 1);
            _fxOrb(px, y, pz, .13, color, .35);
            break;
    }
}

// ---- Particles (debris that hops and bounces) -------------------------

function _pushParticleFx(p, px, pz) {
    let life = Number(p.life) || 0;
    let alpha = Math.max(0.1, Math.min(1, life / 35));
    let hop = Number(p.hop) || .2;
    let y = .03 + hop * Math.abs(Math.sin(life * .22)) * Math.min(1, life / 12);
    _fxBox(px, y, pz, life * .3, .065, .065, .065, life * .2, p.color || '#fff', alpha, 1);
}

// ---- Laser fences -------------------------------------------------------

function _pushLaserFenceFx(t) {
    if (t.type !== 'laser' || !t.connectedLasers || !t.connectedLasers.length || t.underConstruction) return;
    let y = _fx.flat ? 0 : .62;
    for (let other of t.connectedLasers) {
        if (!(t.gx < other.gx || (t.gx === other.gx && t.gy < other.gy))) continue;
        let ax = t.x / TILE, az = t.y / TILE, bx = other.x / TILE, bz = other.y / TILE;
        if (!_fxVisible(ax, az) && !_fxVisible(bx, bz)) continue;
        if (t.laserState === 1) {
            let flicker = .8 + .2 * Math.sin(_fx.now * 2.3 + t.gx);
            _fxBeam(ax, y, az, bx, y, bz, .13 * flicker, '#ff2a2a', .85);
            _fxBeam(ax, y, az, bx, y, bz, .045, '#ffffff', .95);
        } else {
            _fxBeam(ax, y, az, bx, y, bz, .035, '#ff3a3a', .28);
        }
    }
}

// ---- Buildings at work (3D only) ---------------------------------------

// A production wheel turning on the side wall while a queue runs; the
// research lab's instruments orbit its roof; houses breathe smoke. `roof`
// is the height of the rendered roof.
function pushStructureActivityFx(entity, x, z, roof, ownerColor) {
    if (!_fx.batch || _fx.flat || !_fx.detail || entity.underConstruction) return;
    let now = _fx.now / _fx.tickScale, seed = (entity.gx * 7 + entity.gy * 13) | 0;
    let type = entity.type;
    if (type === 'house') {
        for (let k = 0; k < 2; k++) {
            let local = ((now / 46 + _fxHash(seed, 0) + k * .5) % 1);
            _fxOrb(x + .2 + local * .12, roof + .02 + local * .55, z - .18, .07 + local * .14, '#cfd6dc', .38 * (1 - local) * Math.min(1, local * 6), 0);
        }
        return;
    }
    if (type === 'research') {
        if (!entity.researchTask) return;
        for (let k = 0; k < 2; k++) {
            let a = now * .09 + k * Math.PI;
            _fxOrb(x + Math.sin(a) * .56, roof - .04 + Math.sin(a * 2) * .05, z + Math.cos(a) * .56, .1, k ? '#c76cff' : '#55bfff', .95, 1);
        }
        return;
    }
    let queued = entity.spawnQueue && entity.spawnQueue.length > 0;
    if (!queued) return;
    let progress = entity.spawnCooldown > 0 ? Math.max(0, Math.min(1, entity.spawnTimer / entity.spawnCooldown)) : 0;
    let spin = now * (.12 + progress * .25) + seed;
    let rgb = ownerColor || '#9aa';
    if (roof < .35) {
        // Low floor buildings: a small rotor on a roof corner, clear of the display.
        let rx = x + .32, rz = z + .32, ry = roof + .06;
        for (let k = 0; k < 2; k++) _fxBox(rx, ry, rz, spin + k * Math.PI * .5, .26, .025, .04, 0, rgb, 1);
        _fxOrb(rx, ry + .01, rz, .06, '#ffd24a', .9, 0);
    } else {
        // A cross of spokes on the +x wall, turning faster as the unit nears completion.
        let wy = roof * .55, wx = x + .5;
        for (let k = 0; k < 2; k++) _fxBox(wx, wy, z, Math.PI * .5, .38, .05, .035, 0, rgb, 1, 0, spin + k * Math.PI * .5);
        _fxOrb(wx + .02, wy, z, .08, '#ffd24a', .9, 0);
    }
    if (type === 'healer_spawner') _fxDecal(x, .02, z, 0, 1.1 + .1 * Math.sin(now * .2), '#62ffb0', .35, _FXP.RING, .9, 1);
}

// Steam from a moving snake engine's stack, dust behind heavy walkers.
function pushUnitMotionFx(u, x, z, footprint, scaleY) {
    if (!_fx.batch || _fx.flat || !_fx.detail) return;
    let moving = Math.hypot(u.x - u.prevX, u.y - u.prevY) > .01;
    if (!moving) return;
    let now = _fx.now / _fx.tickScale;
    let vx = Number(u.vx) || 0, vz = Number(u.vy) || 0, speed = Math.hypot(vx, vz) || 1;
    let fx = vx / speed, fz = vz / speed;
    if (u.isSnake) {
        for (let k = 0; k < 2; k++) {
            let local = (now / 14 + k * .5 + u.id * .37) % 1;
            _fxOrb(x + fx * footprint * .38 - fx * local * .3, scaleY * .86 + local * .5, z + fz * footprint * .38 - fz * local * .3, .06 + local * .13, '#e3e9ee', .5 * (1 - local), 0);
        }
    } else if (u.unitType === 'tank' || u.unitType === 'boss' || u.unitType === 'king') {
        let local = (now / 10 + u.id * .29) % 1;
        _fxOrb(x - fx * (.2 + local * .2), .04 + local * .12, z - fz * (.2 + local * .2), .07 + local * .12, '#b9ab92', .35 * (1 - local), 0);
    }
}

// Small contact accents for workers at a job (sparks, restorative motes).
function pushWorkerActivityFx(u, mode, x, z, footprint, phase) {
    if (!_fx.batch || _fx.flat || !_fx.detail || mode < 2 || mode === 3) return;
    let palette = { 2: ['#ffb52e', '#fff1a8'], 4: ['#ff7043', '#d7e0e8'], 5: ['#62ffb0', '#eafff4'], 6: ['#55bfff', '#c76cff'] }[mode];
    if (!palette) return;
    for (let i = 0; i < 2; i++) {
        let p = phase + i * Math.PI;
        let burst = mode === 2 || mode === 4;
        let radius = mode === 5 ? .38 : mode === 6 ? .32 : .24;
        let ox = burst ? Math.cos(p * .63) * .2 : Math.cos(p) * radius;
        let oz = burst ? .26 + Math.sin(p * .71) * .16 : Math.sin(p) * radius;
        let oy = burst ? .18 + ((phase * .18 + i / 2) % 1) * .42 : .28 + Math.sin(p * 2) * .16 + i * .035;
        _fxOrb(x + ox * footprint, oy * Math.max(.7, footprint), z + oz * footprint, burst ? .05 : .065, palette[i], .72 + .2 * Math.sin(p), 1);
    }
}

// ---- Frame entry points --------------------------------------------------

function beginFrameEffects(batch, flat2d, bounds, visibility, pixelsPerTile) {
    _FXM = window.Defence3Renderer3D.FX_MESH;
    _FXP = window.Defence3Renderer3D.FX_PATTERN;
    batch.reset();
    _fx.batch = batch;
    _fx.flat = !!flat2d;
    _fx.rest = flat2d ? .15 : 1;
    // Zoomed far out, secondary pieces (debris, trails, smoke) are subpixel.
    _fx.detail = !(pixelsPerTile < 14);
    _fx.tickScale = Math.max(.25, (typeof TICK_RATE === 'number' ? TICK_RATE : 20) / 20);
    let now = gameTime + (typeof tickAlpha === 'number' ? tickAlpha : 0);
    // A new game or a rewind leaves records in the future: drop them.
    if (now < _fx.lastNow - 2 && typeof clearCombatFx === 'function') clearCombatFx();
    _fx.lastNow = now;
    _fx.now = now;
    _fx.minX = bounds.minGx - 2; _fx.minZ = bounds.minGy - 2;
    _fx.maxX = bounds.maxGx + 3; _fx.maxZ = bounds.maxGy + 3;
    _fx.vis = visibility;
    _fx.full = !!fullVisibility;
}

function buildFrameEffects(projectiles, particles, towers) {
    if (!_fx.batch) return;
    _pushCombatRecordFx();
    const alpha = typeof tickAlpha === 'number' ? tickAlpha : 0;
    for (let p of projectiles) {
        let px = (Number.isFinite(p.prevX) ? p.prevX + (p.x - p.prevX) * alpha : p.x) / TILE;
        let pz = (Number.isFinite(p.prevY) ? p.prevY + (p.y - p.prevY) * alpha : p.y) / TILE;
        if (_fxVisible(px, pz)) _pushProjectileFx(p, px, pz);
    }
    for (let p of particles) {
        let px = (Number.isFinite(p.prevX) ? p.prevX + (p.x - p.prevX) * alpha : p.x) / TILE;
        let pz = (Number.isFinite(p.prevY) ? p.prevY + (p.y - p.prevY) * alpha : p.y) / TILE;
        if (_fxVisible(px, pz)) _pushParticleFx(p, px, pz);
    }
    for (let t of towers) if (t.type === 'laser') _pushLaserFenceFx(t);
}

function endFrameEffects() {
    _fx.batch = null;
}
