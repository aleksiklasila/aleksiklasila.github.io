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
// (Two-argument length without Math.hypot: its argument list was ~37 MB a minute of the page's garbage in a battle.)
function _fxLen(a, b) { return Math.sqrt(a * a + b * b); }
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
    limit:10000, cells:new Set(), cellSize:1, ppt: 32,
    minX: 0, minZ: 0, maxX: 0, maxZ: 0, vis: null, full: false, lastNow: -Infinity, volleys: false
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
    if (_fx.batch.total >= _fx.limit) return;
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
    let flatLen = _fxLen(dx, dz), len = _fxLen(flatLen, dy);
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

// ---- Recorded attacks, shots and hits ---------------------------------

// Near records are drawn on the GPU (renderer3d.js drawFxNear, fxNearVertexGlsl: the shapes of a blow, a cast, a
// shot's muzzle, flight and hit, built there from an entry): the page lists them, an entry each of 8 floats (x0, z0,
// x1, z1 in tiles, its ends as drawn; kind, style, seed, q its phase); a volley's shots as entries of their own
// (_fxNearVolley). Sized once for the ring's every record a volley's most (_pushCombatRecordFx).
const _fxNear = { data: null, rows: 0, n: 0, rest: 1, detail: true, cycle: 0, perspective: false };
function _fxNearPut(N, kind, x0, z0, x1, z1, style, seed, q) {
    const D = N.data, o = N.n * 8;
    D[o] = x0; D[o + 1] = z0; D[o + 2] = x1; D[o + 3] = z1; D[o + 4] = kind; D[o + 5] = style; D[o + 6] = seed; D[o + 7] = q;
    N.n++;
}
// A unit's drawn position by id (pixels, into out): the worker's frames, or
// the unit itself in this thread; false when it is not drawn.
const _fxAt = [0, 0];
function _fxDrawnAt(id, out) {
    const alpha = typeof tickAlpha === 'number' ? tickAlpha : 0;
    if (typeof simClientActive === 'function' && simClientActive()) return typeof pageUnitDrawnAt === 'function' && pageUnitDrawnAt(id, alpha, out);
    const u = typeof getUnitById === 'function' ? getUnitById(id) : null;
    if (!u || u.dead) return false;
    out[0] = Number.isFinite(u.prevX) ? u.prevX + (u.x - u.prevX) * alpha : u.x;
    out[1] = Number.isFinite(u.prevY) ? u.prevY + (u.y - u.prevY) * alpha : u.y;
    return true;
}

// A tower's volley (a muzzle record with src -shots: tower.js _towerShotFx):
// its shots _FX_VOLLEY_GAP ticks apart, each from the muzzle to its target
// (as drawn, by dst id) at a projectile's speed (8 px a tick), then its
// impact. Drawn from the record alone, on the effects' clock: beside the
// worker the simulation's projectiles are not drawn (_fx.volleys), its
// impact records neither. Each shot: its muzzle flash (kind 10), its flight
// (13, q its fraction; where it is lit) or its hit (11), entries of the near list.
const _FX_VOLLEY_GAP = 6, _FX_VOLLEY_MAX = 4, _FX_PROJ_SPEED = 8, _FX_IMPACT_TICKS = 9;
function _fxVolleyTicks(n, distPx) { return (Math.min(_FX_VOLLEY_MAX, n) - 1) * _FX_VOLLEY_GAP + distPx / _FX_PROJ_SPEED + _FX_IMPACT_TICKS; }
function _fxNearVolley(N, n, x0, z0, x1, z1, style, seed, age) {
    const ts = _fx.tickScale, muzzle = _FX_DURATION[10] * ts, impact = _FX_IMPACT_TICKS * ts;
    n = Math.min(_FX_VOLLEY_MAX, n);
    const dx = x1 - x0, dz = z1 - z0, dist = _fxLen(dx, dz) || .001, flight = dist * TILE / _FX_PROJ_SPEED;
    for (let i = 0; i < n; i++) {
        const t = age - i * _FX_VOLLEY_GAP * ts;
        if (t < 0) break;
        if (t < muzzle) _fxNearPut(N, 10, x0, z0, x1, z1, style, seed + i, t / muzzle);
        if (t < flight) { const q = t / flight; if (_fxVisible(x0 + dx * q, z0 + dz * q)) _fxNearPut(N, 13, x0, z0, x1, z1, style, seed + i, q); }
        else if (t < flight + impact) _fxNearPut(N, 11, x0, z0, x1, z1, style, seed + i, (t - flight) / impact);
    }
}

// (The ring's records that may still be live: from _fxTail (the oldest not yet known dead) to the head, in the order
// written; the tail moves past dead and expired ones. A pass over every slot of the ring each frame was most of this
// function's time (~20 ms/s of the page in a battle, perf fuzz 2026-11-18). When more were written since the last
// frame than the ring holds, the whole ring.)
let _fxTail = 0, _fxTailSerial = 0, _fxBand = 1 << 30;
// (Far away (under _FX_FAR_PPT pixels a tile at its target) a record is drawn on the GPU from the ring itself:
// renderer3d.js drawFxFar, which gets the records written since its last frame and animates each by its age. The
// page reads only the near ones, and none when nothing in view is that near: a pass over every live record each
// frame was ~2.2 ms a frame zoomed out over a 140k battle (2026-11-23).)
const _fxFarState = { data: null, ids: null, cap: 0, head: 0, serial: 0, clears: 0, now: 0, ts: 1, volleys: false, flat: false, rest: 1,
    ppt: 32, full: false, vis: null, visVersion: 0, tile: 32, minX: 0, minZ: 0, maxX: 0, maxZ: 0 };
function _fxMaxPixelsPerTile() {
    const r = _fx.renderer;
    if (_fx.flat || !r) return _fx.ppt;
    // (Depth is linear in position: its least over the view's box is at a corner.)
    let m = 0;
    for (const x of [_fx.minX, _fx.maxX]) for (const z of [_fx.minZ, _fx.maxZ]) m = Math.max(m, r.pixelsPerWorldAt(x, .3, z));
    return m;
}
function _pushCombatRecordFx() {
    if (typeof combatFxData === 'undefined') return;
    const data = combatFxData, stride = COMBAT_FX_STRIDE, now = _fx.now, tickScale = _fx.tickScale;
    const ids = typeof combatFxIds !== 'undefined' ? combatFxIds : null, P = _fxAt, volleys = _fx.volleys;
    const CAP = COMBAT_FX_CAPACITY, head = combatFxHead, serial = combatFxSerial | 0;
    const S = _fxFarState;
    S.data = data; S.ids = ids; S.cap = CAP; S.head = head; S.serial = serial; S.clears = typeof combatFxClears === 'number' ? combatFxClears : 0;
    S.now = now; S.ts = tickScale; S.volleys = volleys; S.flat = _fx.flat; S.rest = _fx.rest; S.ppt = _fx.ppt; S.full = _fx.full;
    S.vis = _fx.vis; S.visVersion = typeof visibilityVersion === 'number' ? visibilityVersion : 0; S.tile = TILE;
    S.minX = _fx.minX; S.minZ = _fx.minZ; S.maxX = _fx.maxX; S.maxZ = _fx.maxZ;
    _fx.batch.far = S;
    // (The near ones: entries for the GPU, renderer3d.js drawFxNear.)
    const N = _fxNear;
    if (!N.data) { N.data = new Float32Array(CAP * _FX_VOLLEY_MAX * 2 * 8); N.rows = Math.ceil(CAP * _FX_VOLLEY_MAX * 2 * 2 / 2048); }
    N.n = 0; N.rest = _fx.rest; N.detail = _fx.detail; N.cycle = Math.floor(now / (3 * tickScale)) & 3; N.perspective = !!_fx.renderer;
    _fx.batch.near = N;
    if (!(_fxMaxPixelsPerTile() >= _FX_FAR_PPT)) return;
    // (Near at its target, as _fxPixelsPerTileAt and the GPU tell it: its depth along the view at most the
    // projection's scale over _FX_FAR_PPT; the flat view (one scale) all near here.)
    const R = _fx.renderer, eye = R && R.lodEye, fw = R && R.lodForward, perspective = !!(eye && fw && R.lodProjectionScale);
    const ex = perspective ? eye[0] : 0, ey = perspective ? eye[1] - .3 : 0, ez = perspective ? eye[2] : 0, fx = perspective ? fw[0] : 0, fy = perspective ? fw[1] : 0, fz = perspective ? fw[2] : 0;
    const nearDepth = perspective ? R.lodProjectionScale / _FX_FAR_PPT : Infinity;
    const written = (serial - _fxTailSerial) | 0;
    _fxTailSerial = serial;
    // (_fxBand: records from the tail to the head at the last frame's end; with those written since, the ring's size
    // or more: the head may have passed the tail, the whole ring.)
    // (The band read in the slots' order, as the whole ring was (the batch's order, and which records a full batch
    // leaves out): [start, head) or, wrapped, [0, head) then [start, CAP). The next tail: the kept record nearest the
    // start in the order written, minPos.)
    const start = (written < 0 || _fxBand + written >= CAP) ? head : _fxTail;
    const full = start === head && (written < 0 || _fxBand + written >= CAP);
    const wrapped = full || start > head;
    let minPos = CAP;
    for (let seg = 0; seg < (wrapped ? 2 : 1); seg++) {
    const qa = wrapped ? (seg === 0 ? 0 : start) : start, qb = wrapped ? (seg === 0 ? head : CAP) : head;
    for (let q = qa; q < qb; q++) {
        const o = q * stride, r = q * 2;
        let kind = data[o];
        if (!kind) continue;
        let age = now - data[o + 5];
        // (A volley's time: its shots' flights; a projectile's impact record
        // beside the worker: drawn by its volley.)
        const volley = kind === 10 && volleys && ids !== null && ids[r] < 0 ? -ids[r] : 0;
        if (kind === 11 && volleys) { data[o] = 0; continue; }
        let duration = volley ? _fxVolleyTicks(volley, _fxLen(data[o + 3] - data[o + 1], data[o + 4] - data[o + 2])) * tickScale : (_FX_DURATION[kind] || 8) * tickScale;
        if (age >= duration) { data[o] = 0; continue; }
        { const pos = q >= start ? q - start : q + CAP - start; if (pos < minPos) minPos = pos; }
        if (age < 0) continue;
        let x1 = data[o + 3] / TILE, z1 = data[o + 4] / TILE;
        let x0 = data[o + 1] / TILE, z0 = data[o + 2] / TILE;
        // (Far away: the GPU's, drawFxFar.)
        if ((x1 - ex) * fx - ey * fy + (z1 - ez) * fz > nearDepth) continue;
        if (!_fxVisible(x1, z1) && !_fxVisible(x0, z0)) continue;
        // (A unit's attack between its units as drawn: a beam's ends stay on
        // the caster and its target as they move; where they stood once gone.)
        if (ids !== null) {
            const a = ids[r], b = ids[r + 1];
            if (a > 0 && _fxDrawnAt(a, P)) { x0 = P[0] / TILE; z0 = P[1] / TILE; }
            if (b > 0 && _fxDrawnAt(b, P)) { x1 = P[0] / TILE; z1 = P[1] / TILE; }
        }
        if (volley) { _fxNearVolley(N, volley, x0, z0, x1, z1, data[o + 6], data[o + 7], age); continue; }
        _fxNearPut(N, kind, x0, z0, x1, z1, data[o + 6], data[o + 7], age / duration);
    }
    }
    // (None kept: none left before the head.)
    _fxTail = minPos < CAP ? (start + minPos) % CAP : head;
    _fxBand = (head - _fxTail + CAP) % CAP;
}

// ---- Far away: every effect as a dot or a line ---------------------------
// Under _FX_FAR_PPT pixels a tile an effect's pieces are smaller than a pixel:
// each one is drawn instead as what it is from afar, its colour where it is
// (a shot's dot along its flight, a beam's line, a hit's flash at its
// target), at least _FX_FAR_MIN_PX on screen: the same timing and colours as
// close up, without its detail. Recorded effects are drawn so on the GPU
// (renderer3d.js drawFxFar, from FX_FAR below); _fxFarDot is the in-page
// simulation's projectiles'.
// (Full effects down to _FX_FAR_PPT pixels a tile; under it dots of at least
// _FX_FAR_MIN_PX, their own colour, not additive: many overlapping
// additive dots summed to white blobs over the coloured shots.)
const _FX_FAR_PPT = 6, _FX_FAR_MIN_PX = 1.5;
function _fxPixelsPerTileAt(x, z) {
    const r = _fx.renderer;
    return _fx.flat || !r ? _fx.ppt : r.pixelsPerWorldAt(x, .3, z);
}
// What the GPU's far effects read: an event's colour from afar by kind (null: by its style, as a shot's; kind 3
// with style 13 the boss's dust; kind 4 its element's), the shots' colours by style, the elements' main and glow
// colours, the base durations, the volleys' timing.
const FX_FAR = {
    ppt: _FX_FAR_PPT, minPx: _FX_FAR_MIN_PX, kindColor: [null, '#eef6ff', '#f4f4ff', '#fff1c8', null, '#e040ff', '#fff2a0', '#9cf', '#7dff3a', '#c99a66', null, null, '#ffd84a'],
    bossDust: '#d8c8a8', beamHit: '#f08cff', shotColor: _FX_SHOT_COLOR, shotDefault: '#fff4c8', element: _FX_ELEMENT, duration: _FX_DURATION,
    volleyGap: _FX_VOLLEY_GAP, volleyMax: _FX_VOLLEY_MAX, projSpeed: _FX_PROJ_SPEED, impactTicks: _FX_IMPACT_TICKS, rgb: _fxRgb, arc: _FX_ARC,
};
function _fxFarDot(x, z, d, color, alpha, ppt) {
    if (!(alpha > .02) || !_fxVisible(x, z)) return;
    _fxOrb(x, .3 * _fx.rest, z, Math.max(d, _FX_FAR_MIN_PX / Math.max(.05, ppt)), color, Math.min(1, alpha), 0);
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
    let traveled = _fxLen(px - sx, pz - sz);
    let t = Math.max(0, Math.min(1, traveled / Math.max(.05, aim)));
    let arc = _FX_ARC[style] || _FX_ARC[0];
    let apex = Math.min(arc[1], arc[0] * aim);
    let h0 = .76 * rest, h1 = .3 * rest;
    let y = _fxArcY(h0, h1, apex, t);
    let slope = ((h1 - h0) + 4 * apex * (1 - 2 * t)) / Math.max(.05, aim);
    let elevation = Math.atan(slope);
    let vx = Number(p.vx) || 0, vz = Number(p.vy) || 1;
    let yaw = Math.atan2(vx, vz);
    let speed = _fxLen(vx, vz) || 1, ux = vx / speed, uz = vz / speed;
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
            if (_fxDetailAt(px, pz)) for (let k = 1; k <= 2; k++) { let q = trail(k * .16); _fxOrb(q[0], q[1], q[2], .13 - k * .03, '#ffd27a', .7 - k * .2); }
            break;
        }
        case 2: case 4: { // water / poison globs
            let main = style === 2 ? '#3aa8ff' : '#5de04a', light = style === 2 ? '#bfe6ff' : '#b6ff7a';
            _fxOrb(px, y, pz, .18, main, 1, 0);
            if (_fxDetailAt(px, pz)) for (let k = 1; k <= 2; k++) { let q = trail(k * .14); _fxOrb(q[0], q[1], q[2], .08 - k * .015, light, .8 - k * .25, 0); }
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

// Houses breathe smoke. `roof` is the height of the rendered roof.
function pushStructureActivityFx(entity, x, z, roof, ownerColor) {
    if (!_fx.batch || _fx.flat || entity.underConstruction || !_fxDetailAt(x, z)) return;
    let now = _fx.now / _fx.tickScale, seed = (entity.gx * 7 + entity.gy * 13) | 0;
    let type = entity.type;
    if (type === 'house') {
        for (let k = 0; k < 2; k++) {
            let local = ((now / 46 + _fxHash(seed, 0) + k * .5) % 1);
            _fxOrb(x + .2 + local * .12, roof + .02 + local * .55, z - .18, .07 + local * .14, '#cfd6dc', .38 * (1 - local) * Math.min(1, local * 6), 0);
        }
        return;
    }
    // Production is shown by the unit miniature on the workshop deck.
}

// Steam from a moving snake engine's stack, dust behind heavy walkers.
function pushUnitMotionFx(u, x, z, footprint, scaleY) {
    if (!_fx.batch || _fx.flat || !_fxDetailAt(x, z)) return;
    let moving = _fxLen(u.x - u.prevX, u.y - u.prevY) > .01;
    if (!moving) return;
    let now = _fx.now / _fx.tickScale;
    let vx = Number(u.vx) || 0, vz = Number(u.vy) || 0, speed = _fxLen(vx, vz) || 1;
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

// ---- Frame entry points --------------------------------------------------

// Whether secondary pieces (debris, trails, smoke) at (x, z) are big enough
// on screen to draw. In 3D this is per position, so a far corner of a tilted
// view drops them even when zoomed in; the flat view uses the zoom.
function _fxDetailAt(x, z) {
    let r = _fx.renderer;
    if (_fx.flat || !r) return _fx.detail;
    return !(r.pixelsPerWorldAt(x, .3, z) < 14);
}

function beginFrameEffects(batch, flat2d, bounds, visibility, pixelsPerTile, renderer = null) {
    _FXM = window.Defence3Renderer3D.FX_MESH;
    _FXP = window.Defence3Renderer3D.FX_PATTERN;
    batch.reset();
    batch.far = null;
    _fx.batch = batch;
    _fx.flat = !!flat2d;
    _fx.rest = flat2d ? .15 : 1;
    // Zoomed far out, secondary pieces (debris, trails, smoke) are subpixel.
    if(!flat2d && renderer && renderer.lodPixelsPerWorld>0) pixelsPerTile=renderer.lodPixelsPerWorld;
    _fx.detail = !(pixelsPerTile < 14);
    // (Far away an effect is one dot (_fxFarDot): more of them fit.)
    _fx.limit = pixelsPerTile < 14 ? 8192 : pixelsPerTile < 32 ? 4096 : 6000;
    _fx.cellSize=Math.max(1,3/Math.max(.1,pixelsPerTile));_fx.cells.clear();
    _fx.ppt = pixelsPerTile;
    _fx.renderer = !flat2d && renderer && typeof renderer.pixelsPerWorldAt === 'function' ? renderer : null;
    _fx.tickScale = Math.max(.25, (typeof TICK_RATE === 'number' ? TICK_RATE : 20) / 20);
    // (On the drawn units' clock beside the worker: see simClientDrawnGameTime.)
    const drawn = typeof simClientDrawnGameTime === 'function' ? simClientDrawnGameTime(typeof tickAlpha === 'number' ? tickAlpha : 0) : NaN;
    let now = Number.isFinite(drawn) ? drawn : gameTime + (typeof tickAlpha === 'number' ? tickAlpha : 0);
    // A new game or a rewind leaves records in the future: drop them.
    if (now < _fx.lastNow - 2 && typeof clearCombatFx === 'function') clearCombatFx();
    _fx.lastNow = now;
    _fx.now = now;
    if (typeof simClientNoteView === 'function') simClientNoteView(bounds.minGx, bounds.minGy, bounds.maxGx, bounds.maxGy);
    _fx.minX = bounds.minGx - 2; _fx.minZ = bounds.minGy - 2;
    _fx.maxX = bounds.maxGx + 3; _fx.maxZ = bounds.maxGy + 3;
    _fx.vis = visibility;
    _fx.full = !!fullVisibility;
}

function buildFrameEffects(projectiles, particles, towers) {
    if (!_fx.batch) return;
    // (Beside the worker towers' shots are drawn from their volleys' records.)
    _fx.volleys = typeof simClientActive === 'function' && simClientActive();
    _pushCombatRecordFx();
    const alpha = typeof tickAlpha === 'number' ? tickAlpha : 0;
    const step = _fx.detail ? 1 : Math.max(1, Math.ceil((projectiles.length + particles.length) / 2000));
    for (let i = 0; !_fx.volleys && i < projectiles.length && _fx.batch.total < _fx.limit; i += step) {
        const p = projectiles[i];
        let px = (Number.isFinite(p.prevX) ? p.prevX + (p.x - p.prevX) * alpha : p.x) / TILE;
        let pz = (Number.isFinite(p.prevY) ? p.prevY + (p.y - p.prevY) * alpha : p.y) / TILE;
        if (!_fxVisible(px, pz)) continue;
        const ppt = _fxPixelsPerTileAt(px, pz);
        if (ppt < _FX_FAR_PPT) _fxFarDot(px, pz, .15, _FX_SHOT_COLOR[_fxStyleOf(p.type)] || '#fff4c8', 1, ppt);
        else _pushProjectileFx(p, px, pz);
    }
    for (let i = 0; i < particles.length && _fx.batch.total < _fx.limit; i += step) {
        const p = particles[i];
        let px = (Number.isFinite(p.prevX) ? p.prevX + (p.x - p.prevX) * alpha : p.x) / TILE;
        let pz = (Number.isFinite(p.prevY) ? p.prevY + (p.y - p.prevY) * alpha : p.y) / TILE;
        if (_fxVisible(px, pz)) _pushParticleFx(p, px, pz);
    }
    for (let i = 0; i < towers.length && _fx.batch.total < _fx.limit; i++) {
        const t = towers[i];
        if (t.type === 'laser') _pushLaserFenceFx(t);
    }
}

function endFrameEffects() {
    _fx.batch = null;
}
