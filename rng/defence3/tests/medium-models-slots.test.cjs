// The units' middle-distance models drawn from the frame's columns on the GPU
// (renderer3d.js _cmUnitSlots + the slot figure program): per group the
// slots of its units, the group's uniforms (style, panel layer per owner,
// status layer) and the frame's (tile, light, colours). Here: the same mask
// and the same records per group as packing every unit anew each tick (the
// reference: the earlier code), the records rebuilt from the slots and
// uniforms as the slot program's fetchSlot() makes them, through random
// ticks (moving and turning units, modes changing, deaths, slots reused,
// promotions, fog, another frame size, other colours). The shader itself
// was compared in Edge against the records, pixel for pixel (a fixed clock;
// <= 10 pixels of 1.07M differ: the GPU's sines), see TPS_400K_PER_TEAM_PLAN.md.
//   node tests/medium-models-slots.test.cjs
'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const c = vm.createContext({ window: {}, console, AREA_UNIT_TILE_EQUIVALENT: 5 });
// (R3D_FILE: another renderer3d.js.)
vm.runInContext(process.env.R3D_FILE ? fs.readFileSync(process.env.R3D_FILE, 'utf8') : read('src/audio_visual/renderer3d.js'), c);
const K = c.window.Defence3Renderer3D;
const R = Object.create(K.prototype);
R.gl = { createBuffer: () => ({}), bindVertexArray() { } }; R.getFigureMesh = () => ({});
const layers = new Map();
R.getFlatAtlas = () => ({ layerFor: p => { if (!layers.has(p)) layers.set(p, layers.size + 3); return layers.get(p); } });
R.drawTexturedInstanceRange = () => { };
K.PersistentInstances.prototype.upload = function () { return {}; };
// (No GPU here: the slot program and the column textures stand in.)
R.ensureFigureSlotProgram = () => ({});
R.ensureColumnProgram = () => { };
R._columnStoreUpload = () => { };
R._cmSlotTextures = () => ({});
R._cmDrawSlotGroups = () => { };
c._detailViewKey = () => String(c.view || 0);
c._detailScore = (x, z, size, flat, retained, minPixels) => ((Math.floor(x * 3) + Math.floor(z * 5)) % 5 !== 0 && size * 40 > minPixels) ? 10 : 0;
c._structureDetailCandidates = () => [];
let seed = 4242;
const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
const TAU = Math.PI * 2;
const styles = [
    { modelKey: 'unit_norm', weaponType: 'sword', scaleX: 1, scaleY: 1.45, color: '#fff' },
    { modelKey: 'unit_flying', weaponType: 'sword', scaleX: .9, scaleY: 1.2, color: '#dd0', isFlying: true, isWorker: true },
    { modelKey: 'unit_tank', weaponType: 'sword', scaleX: 1.2, scaleY: 1, color: '#555', drawOwnerRim: true, statusTextureCanvas: { status: 1 } },
    { modelKey: 'unit_snake', weaponType: 'sword', scaleX: .7, scaleY: .3, color: '#3a3', snake: true },
    { modelKey: 'unit_rider', weaponType: 'sword', scaleX: 1.1, scaleY: .8, color: '#a63', mounted: true }];
const width = 6, stride = 9, lookup = new Float32Array(8 * width * 4);
for (let code = 1; code <= styles.length; code++) lookup[(7 * width + code) * 4] = (code - 1) * stride + 1;
const panels = styles.map((_, i) => ({ panel: i }));
const A = { catalog: { width, stride, lookup, styles }, panels, ownerPanels: new Map(), revision: 1 };
function frame(n) {
    const F = { n, cap: n };
    for (const k of ['x', 'y', 'px', 'py', 'r', 'id', 'energy', 'flags', 'type', 'owner', 'facing', 'mode', 'vision', 'prate', 'amount', 'phase']) F[k] = new Float32Array(n);
    for (let s = 0; s < n; s++) {
        F.id[s] = s; F.x[s] = F.px[s] = 3200 + rnd() * 3200; F.y[s] = F.py[s] = 3200 + rnd() * 3200; F.r[s] = 6 + rnd() * 6; F.energy[s] = 50;
        F.type[s] = 1 + Math.floor(rnd() * styles.length); F.owner[s] = Math.floor(rnd() * 3); F.facing[s] = rnd() * TAU; F.mode[s] = Math.floor(rnd() * 3);
        F.vision[s] = rnd() < .2 ? 0 : 1 + rnd() * 3; F.prate[s] = rnd(); F.amount[s] = rnd(); F.phase[s] = rnd() * TAU;
    }
    return F;
}
const hexToRgb = h => { const m = /^#(..)(..)(..)$/.exec(h.length === 4 ? '#' + h[1] + h[1] + h[2] + h[2] + h[3] + h[3] : h); return m ? [1, 2, 3].map(i => parseInt(m[i], 16) / 255) : [.78, .81, .85]; };
const rec = d => Array.from(Float32Array.from(d)).join(',');
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
        const mode = F.mode[s], key = styleIndex * 32 + (mode & 31);
        const d = new Array(28), flying = style.isFlying, sx = size * style.scaleX;
        let sy = size * style.scaleY;
        if (!style.mounted) sy = style.snake ? Math.max(.24, sy) : Math.max(.48 * style.scaleX, sy);
        if (!(style.preserveModelHeight || style.isFlying || style.mounted) && F.vision[s] > 0) sy *= Math.max(.18, F.vision[s] * 5 / 5);
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
        (out.get(key) || out.set(key, []).get(key)).push(rec(d));
        want[s] = 255;
    }
    for (const list of out.values()) list.sort();
    assert.deepEqual(Array.from(mask), Array.from(want), 'the same mask');
    return out;
}
// A slot's record as the slot program's fetchSlot() makes it from the
// columns and the uniforms (_cmSlotUniforms: the group's, cmSlotFrame).
function slotRecords(S, F) {
    const out = new Map(), P = R.cmSlotFrame;
    for (const [key, G] of S.sgroupByKey) {
        if (!G.n) continue;
        const st = G.style, list = [];
        const flagsU = (st.isFlying ? 1 : 0) | (st.mounted ? 2 : 0) | (st.snake ? 4 : 0) | (st.preserveModelHeight || st.isFlying || st.mounted || G.figure === 'portal' ? 8 : 0) | (st.isWorker ? 16 : 0);
        const tint = hexToRgb(st.color || '#aaa');
        for (let i = 0; i < G.n; i++) {
            const s = G.slots[i], wx = F.x[s], wy = F.y[s], x = wx / P.tile, z = wy / P.tile;
            const size = Math.min(Math.max(F.r[s] * 2.2 / P.tile, .28), .9);
            let sx = size * st.scaleX, sy = size * st.scaleY;
            const flying = (flagsU & 1) !== 0;
            if ((flagsU & 2) === 0) sy = (flagsU & 4) !== 0 ? Math.max(.24, sy) : Math.max(.48 * st.scaleX, sy);
            if ((flagsU & 8) === 0 && F.vision[s] > 0) sy *= Math.max(.18, F.vision[s] * 5 / 5);
            const co = Math.cos(F.facing[s]), sn = Math.sin(F.facing[s]), id = F.id[s], owner = F.owner[s];
            const ownerIdx = Math.min(Math.max(owner + 1, 0), 8);
            const remembered = (F.flags[s] & 65536) !== 0;
            const lit = remembered ? .14 : (P.full || owner === P.player) ? 1 : Math.min(1, P.vis[Math.floor(z)][Math.floor(x)] / P.lightNorm);
            const d = [co * sx, 0, -sn * sx, (F.px[s] - wx) / P.tile,
                flying ? (id * 1.7) % TAU : 0, sy, flying ? 1 : 0, (F.py[s] - wy) / P.tile,
                sn * sx, 0, co * sx, F.prate[s],
                x, .012 + (((id * 1103515245) >>> 0) % 7) * .003 + (flying ? ((flagsU & 16) !== 0 ? .36 : .30) : 0), z, 1,
                P.colors[ownerIdx * 3], P.colors[ownerIdx * 3 + 1], P.colors[ownerIdx * 3 + 2], 1,
                F.amount[s], F.phase[s], tint[0], tint[1], tint[2],
                remembered ? -1 - lit : lit, G.layers[ownerIdx], G.statusLayer];
            assert.notEqual(G.layers[ownerIdx], -2, 'a layer for every owner drawn');
            list.push(rec(d));
        }
        out.set(key, list.sort());
    }
    return out;
}
let F = frame(260);
const grid = Array.from({ length: 300 }, () => new Float32Array(300).fill(4));
const C = { units: F, unitCandidates: [], detailMask: new Uint8Array(F.cap), detailMaskVersion: 1, colors: ['#888', '#08f', '#f00', '#0c0', '#ff0', '#0ff', '#f0f', '#fff', '#000'], fullVisibility: false,
    visibility: grid, lightNorm: 6, player: 0, tile: 32, alpha: .5, visibilityVersion: 1 };
let checks = 0;
for (let tick = 0; tick < 60; tick++) {
    if (tick === 40) F = frame(330);
    const G = { ...F };
    for (const k of Object.keys(F)) if (F[k] instanceof Float32Array) G[k] = F[k].slice();
    for (let s = 0; s < G.n; s++) {
        G.px[s] = G.x[s]; G.py[s] = G.y[s];
        G.x[s] += (rnd() - .5) * 60; G.y[s] += (rnd() - .5) * 60;
        if (rnd() < .3) G.facing[s] = rnd() * TAU;
        if (rnd() < .08) G.mode[s] = Math.floor(rnd() * 3);
        if (rnd() < .03) G.energy[s] = G.energy[s] > 0 ? 0 : 40;
        if (rnd() < .02) { G.id[s] = 1000 + tick * 1000 + s; G.type[s] = 1 + Math.floor(rnd() * styles.length); G.owner[s] = Math.floor(rnd() * 3); }
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
    if (tick === 20) C.fullVisibility = true;
    if (tick === 30) C.fullVisibility = false;
    if (tick === 50) C.colors = C.colors.map((x, i) => i % 2 ? '#f80' : x);
    const S = R.drawColumnModels(C, { worldWidth: 300 }, A);
    assert.equal(S.slotMode, true, 'drawn by slot');
    // (No records: the units' groups are slots.)
    assert.equal([...S.groups.values()].filter(G => G.units && G.storage.count).length, 0, 'no unit records');
    R.cmSlotFrame.vis = C.visibility;
    const want = reference(C, F, S.masks[1]);
    assert.deepEqual(slotRecords(S, F), want, 'tick ' + tick + ': the same records per group');
    checks += [...want.values()].reduce((a, l) => a + l.length, 0);
}
// Switching to records (Defence3Renderer3D.slotModels = false) and back:
// every group starts over, nothing of the other way is drawn.
K.slotModels = false;
let S = R.drawColumnModels(C, { worldWidth: 300 }, A);
assert.equal(S.slotMode, false);
assert.equal(S.sgroups.filter(G => G.n).length, 0, 'no slot groups drawn with records');
assert.ok([...S.groups.values()].some(G => G.units && G.storage.count), 'records made');
K.slotModels = true;
S = R.drawColumnModels(C, { worldWidth: 300 }, A);
assert.equal(S.slotMode, true);
assert.equal([...S.groups.values()].filter(G => G.units && G.storage.count).length, 0, 'no unit records after switching back');
console.log('PASS medium-models-slots: ' + checks + ' records matched over 60 ticks');
