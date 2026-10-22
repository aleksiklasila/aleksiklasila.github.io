// The units' middle-distance models kept from tick to tick (renderer3d.js
// _cmUnits: a record written whole when a unit joins a group, its moving
// parts each tick, swap-removed when it leaves) hold exactly what packing
// every unit anew each tick held (the reference below: the earlier code), per
// group as a set of records, with the same masks, through random ticks:
// moving and turning units, animation modes changing (another group), units
// dying, slots taken by other units, units promoted to full detail and back,
// fog, candidates coming and going, a frame of another size, other colours.
//   node tests/medium-models-incremental.test.cjs
'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const c = vm.createContext({ window: {}, console, AREA_UNIT_TILE_EQUIVALENT: 5 });
vm.runInContext(read('src/audio_visual/renderer3d.js'), c);
const R = Object.create(c.window.Defence3Renderer3D.prototype);
R.gl = {}; R.getFigureMesh = () => ({});
const layers = new Map();
R.getFlatAtlas = () => ({ layerFor: p => { if (!layers.has(p)) layers.set(p, layers.size + 3); return layers.get(p); } });
R.drawTexturedInstanceRange = () => { };
c.window.Defence3Renderer3D.PersistentInstances.prototype.upload = function () { return {}; };
c._detailViewKey = () => String(c.view || 0);
// (A score from the position: units cross the threshold as they move.)
c._detailScore = (x, z, size, flat, retained, minPixels) => ((Math.floor(x * 3) + Math.floor(z * 5)) % 5 !== 0 && size * 40 > minPixels) ? 10 : 0;
c._structureDetailCandidates = () => [];
// (The catalog entry's model height: renderer.js, loaded with it in the page.)
vm.runInContext(read('src/audio_visual/renderer.js').match(/function _cmBaseHeight[\s\S]*?\r?\n}\r?\n/)[0], c);
let seed = 12345;
const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
const TAU = Math.PI * 2;
// A catalog of three unit types (row 7), one flying, one with an owner rim
// and a status picture (the heights are the types' baked sight scale).
const styles = [
    { modelKey: 'unit_norm', weaponType: 'sword', scaleX: 1, scaleY: 1.45, bakeHeight: 2.4, color: '#fff' },
    { modelKey: 'unit_flying', weaponType: 'sword', scaleX: .9, scaleY: 1.2, color: '#dd0', isFlying: true },
    { modelKey: 'unit_tank', weaponType: 'sword', scaleX: 1.2, scaleY: 1, bakeHeight: 1.7, color: '#555', drawOwnerRim: true, statusTextureCanvas: { status: 1 } }];
const width = 4, stride = 9, lookup = new Float32Array(8 * width * 4);
for (let code = 1; code <= 3; code++) lookup[(7 * width + code) * 4] = (code - 1) * stride + 1;
const panels = styles.map((_, i) => ({ panel: i }));
const ownerPanels = new Map();
const A = { catalog: { width, stride, lookup, styles }, panels, ownerPanels, revision: 1 };
function frame(n) {
    const F = { n, cap: n };
    for (const k of ['x', 'y', 'px', 'py', 'r', 'id', 'energy', 'flags', 'type', 'owner', 'facing', 'mode', 'vision', 'prate', 'amount', 'phase']) F[k] = new Float32Array(n);
    for (let s = 0; s < n; s++) {
        F.id[s] = s; F.x[s] = F.px[s] = 3200 + rnd() * 3200; F.y[s] = F.py[s] = 3200 + rnd() * 3200; F.r[s] = 6 + rnd() * 6; F.energy[s] = 50;
        F.type[s] = 1 + Math.floor(rnd() * 3); F.owner[s] = Math.floor(rnd() * 3); F.facing[s] = rnd() * TAU; F.mode[s] = Math.floor(rnd() * 3);
        F.vision[s] = rnd() < .2 ? 0 : 1 + rnd() * 3; F.prate[s] = rnd(); F.amount[s] = rnd(); F.phase[s] = rnd() * TAU;
    }
    return F;
}
const hexToRgb = h => { const m = /^#(..)(..)(..)$/.exec(h.length === 4 ? '#' + h[1] + h[1] + h[2] + h[2] + h[3] + h[3] : h); return m ? [1, 2, 3].map(i => parseInt(m[i], 16) / 255) : [.78, .81, .85]; };
// The reference: every candidate packed anew (the earlier drawColumnModels).
function reference(C, F, mask) {
    const out = new Map(), want = new Uint8Array(F.cap);
    want.set(C.detailMask);
    const colors = C.colors.map(hexToRgb);
    for (const u of C.unitCandidates) {
        const s = u._s;
        if (!(s >= 0) || want[s] || F.id[s] < 0 || F.energy[s] <= 0 || (F.flags[s] & 66560) !== 0) continue;
        const x = F.x[s] / C.tile, z = F.y[s] / C.tile;
        if (!C.fullVisibility && !(F.flags[s] & 65536) && F.owner[s] !== C.player && !(C.visibility[Math.floor(z)]?.[Math.floor(x)] > 0)) continue;
        const size = Math.max(.28, Math.min(.9, F.r[s] * 2.2 / C.tile));
        let sd = F.id[s] ^ 0x9e3779b9;
        sd = Math.imul(sd ^ (sd >>> 16), 0x7feb352d); sd = Math.imul(sd ^ (sd >>> 15), 0x846ca68b);
        const fraction = ((sd ^ (sd >>> 16)) >>> 0) / 4294967296;
        if (!(c._detailScore(x, z, size, false, false, 12 / (.8 + .4 * fraction)) > 0)) continue;
        const code = F.type[s], styleIndex = (lookup[(7 * width + code) * 4] - 1) / stride, style = styles[styleIndex];
        const mode = F.mode[s], key = (styleIndex * 64 + (mode & 31)) * 2;
        const d = new Float32Array(28), flying = style.isFlying, sx = size * style.scaleX;
        let sy = size * style.scaleY;
        if (!style.mounted) sy = style.snake ? Math.max(.24, sy) : Math.max(.48 * style.scaleX, sy);
        if (!(style.preserveModelHeight || style.isFlying || style.mounted)) sy *= style.bakeHeight || 1;
        const f = F.facing[s], co = Math.cos(f), sn = Math.sin(f);
        d[0] = co * sx; d[1] = 0; d[2] = -sn * sx; d[3] = (F.px[s] - F.x[s]) / C.tile;
        d[4] = flying ? (F.id[s] * 1.7) % TAU : 0; d[5] = sy; d[6] = flying ? 1 : 0; d[7] = (F.py[s] - F.y[s]) / C.tile;
        d[8] = sn * sx; d[9] = 0; d[10] = co * sx; d[11] = F.prate[s];
        d[12] = x; d[13] = .012 + (((F.id[s] * 1103515245) >>> 0) % 7) * .003 + (flying ? (style.isWorker ? .36 : .30) : 0); d[14] = z; d[15] = 1;
        const owner = colors[Math.max(0, Math.min(8, F.owner[s] + 1))], tint = hexToRgb(style.color);
        d[16] = owner[0]; d[17] = owner[1]; d[18] = owner[2]; d[19] = 1;
        d[20] = F.amount[s]; d[21] = F.phase[s]; d[22] = tint[0]; d[23] = tint[1]; d[24] = tint[2];
        const remembered = (F.flags[s] & 65536) !== 0;
        const light = remembered ? .14 : C.fullVisibility || F.owner[s] === C.player ? 1 : Math.min(1, C.visibility[Math.floor(z)][Math.floor(x)] / C.lightNorm);
        d[25] = remembered ? -1 - light : light;
        d[26] = R.getFlatAtlas().layerFor(R.columnModelPanel(A, styleIndex, C.colors[Math.max(0, Math.min(8, F.owner[s] + 1))]));
        d[27] = style.statusTextureCanvas ? R.getFlatAtlas().layerFor(style.statusTextureCanvas) : -1;
        (out.get(-1 - key) || out.set(-1 - key, []).get(-1 - key)).push(Array.from(d).join(','));
        want[s] = 255;
    }
    for (const list of out.values()) list.sort();
    assert.deepEqual(Array.from(mask), Array.from(want), 'the same mask');
    return out;
}
function kept(S) {
    const out = new Map();
    for (const [k, G] of S.groups) {
        if (!G.units || !G.storage.count) continue;
        const list = [];
        for (let i = 0; i < G.storage.count; i++) list.push(Array.from(G.storage.data.subarray(i * 28, i * 28 + 28)).join(','));
        out.set(k, list.sort());
    }
    return out;
}
let F = frame(240);
const grid = Array.from({ length: 300 }, () => new Float32Array(300).fill(4));
const C = { units: F, unitCandidates: [], detailMask: new Uint8Array(F.cap), detailMaskVersion: 1, colors: Array(9).fill('#08f'), fullVisibility: false,
    visibility: grid, lightNorm: 6, player: 0, tile: 32, alpha: .5, visibilityVersion: 1 };
let checks = 0;
for (let tick = 0; tick < 60; tick++) {
    // The next tick's frame: units move and turn, some change mode, die,
    // come back as other units, are promoted, the fog moves.
    if (tick === 40) F = frame(300); // (Another frame size: the records start over.)
    const G = { ...F };
    for (const k of Object.keys(F)) if (F[k] instanceof Float32Array) G[k] = F[k].slice();
    for (let s = 0; s < G.n; s++) {
        G.px[s] = G.x[s]; G.py[s] = G.y[s];
        G.x[s] += (rnd() - .5) * 60; G.y[s] += (rnd() - .5) * 60;
        if (rnd() < .3) G.facing[s] = rnd() * TAU;
        if (rnd() < .08) G.mode[s] = Math.floor(rnd() * 3);
        if (rnd() < .03) G.energy[s] = G.energy[s] > 0 ? 0 : 40;
        if (rnd() < .02) { G.id[s] = 1000 + tick * 1000 + s; G.type[s] = 1 + Math.floor(rnd() * 3); G.owner[s] = Math.floor(rnd() * 3); }
        if (rnd() < .02) G.flags[s] = G.flags[s] ? 0 : (rnd() < .5 ? 65536 : 1024);
        G.phase[s] = rnd() * TAU; G.amount[s] = rnd();
    }
    F = G; C.units = F;
    C.detailMask = new Uint8Array(F.cap);
    for (let s = 0; s < F.n; s++) if (rnd() < .1) C.detailMask[s] = 255;
    C.detailMaskVersion++;
    C.unitCandidates = [];
    for (let s = 0; s < F.n; s++) if (rnd() < .85) C.unitCandidates.push({ _s: s });
    for (let y = 0; y < 300; y++) for (let x = 0; x < 300; x++) if (rnd() < .002) grid[y][x] = grid[y][x] ? 0 : 3 + rnd() * 3;
    C.visibilityVersion++;
    if (tick === 50) C.colors = Array(9).fill('#f80');
    const S = R.drawColumnModels(C, { worldWidth: 300 }, A);
    const want = reference(C, F, S.masks[1]);
    assert.deepEqual(kept(S), want, 'tick ' + tick + ': the same records per group');
    checks += [...want.values()].reduce((a, l) => a + l.length, 0);
}
console.log('PASS medium-models-incremental: ' + checks + ' records matched over 60 ticks');
