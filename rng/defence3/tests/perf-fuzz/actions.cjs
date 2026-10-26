'use strict';
// The perf fuzzer's actions: what a player does with the mouse and keyboard
// (real input through the browser, never calls into the game), plus the
// scenarios that chain them. An action is
//   { name, cat, weight, tailMs, prelude?(c), run(c) -> { note?, skipped? } }
// prelude: unmeasured setup so the action means something (a selection for an
// order, the camera on the base for a rally); run: the measured part. The
// context `c` (built in perf-fuzz.cjs) holds the page, a seeded generator
// (c.rng), the geometry the probe last saw (c.geom) and the input helpers.
const { sleep } = require('./env.cjs');

// ---- input helpers (c.* are bound to the page; these only compose) ----
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
// The part of the game area a click lands on the map (the HUD bar covers the top).
const field = c => { const r = c.geom.rect; return { l: r.left + 10, t: r.top + 48, r: r.right - 10, b: r.bottom - 10 }; };
const randomGround = c => { const f = field(c), rng = c.rng; return [Math.round(rng.range(f.l, f.r)), Math.round(rng.range(f.t, f.b))]; };
const near = (c, p, spread) => { const f = field(c); return [Math.round(clamp(p[0] + c.rng.range(-spread, spread), f.l, f.r)), Math.round(clamp(p[1] + c.rng.range(-spread, spread), f.t, f.b))]; };
const minimapPoint = (c, wx, wy) => { const m = c.geom.minimap; if (!m) return null; const w = c.geom.world; return [Math.round(m.left + clamp(wx / w.w, 0.01, 0.99) * m.width), Math.round(m.top + clamp(wy / w.h, 0.01, 0.99) * m.height)]; };
const worldRandom = c => [c.rng.range(0.03, 0.97) * c.geom.world.w, c.rng.range(0.03, 0.97) * c.geom.world.h];
const pickPt = (c, list) => list && list.length ? c.rng.pick(list) : null;
// A range input is set as a player does: a click on its track at that share of the way.
const slide = async (c, x, frac) => c.click(Math.round(x.x - x.w / 2 + 6 + (x.w - 12) * frac), x.y);
const selTotal = s => (s.sel && s.sel[0] > 0 ? s.sel[0] : 0) + (s.sel && s.sel[1] > 0 ? s.sel[1] : 0);

// Make sure what an action needs is on screen: the camera moves to `where`
// (keeping the zoom unless asked), not a player action but setup.
async function show(c, where, zoom) {
    const g = c.geom, at = where === 'army' ? g.army : where === 'base' ? g.structs.base : where === 'enemy' ? (g.enemy || g.structs.enemyBase) : where === 'enemyBase' ? g.structs.enemyBase : null;
    if (!at) return false;
    const rel = zoom !== undefined ? zoom : (c.state0 ? c.state0.zoomRel : 1);
    await c.page.evaluate(([z, a]) => __pf.cam(z, a), [rel || 1, at]);
    await sleep(250);
    await c.refreshGeom();
    return true;
}

// A box over screen points (the bbox of `pts`, grown), or over `frac` of a bbox from a random corner.
async function boxFraction(c, bbox, frac, opts = {}) {
    const f = field(c);
    let [x0, y0, x1, y1] = bbox;
    x0 = clamp(x0 - 6, f.l, f.r); y0 = clamp(y0 - 6, f.t, f.b); x1 = clamp(x1 + 6, f.l, f.r); y1 = clamp(y1 + 6, f.t, f.b);
    if (x1 - x0 < 12) { x0 = clamp(x0 - 20, f.l, f.r); x1 = clamp(x1 + 20, f.l, f.r); }
    if (y1 - y0 < 12) { y0 = clamp(y0 - 20, f.t, f.b); y1 = clamp(y1 + 20, f.t, f.b); }
    const k = Math.sqrt(clamp(frac, 0.001, 1)), w = (x1 - x0) * k, h = (y1 - y0) * k;
    const bx = x0 + c.rng.range(0, (x1 - x0) - w), by = y0 + c.rng.range(0, (y1 - y0) - h);
    await c.drag(bx, by, bx + w, by + h, { steps: opts.steps || 6, mods: opts.mods });
    return [Math.round(bx), Math.round(by), Math.round(bx + w), Math.round(by + h)];
}
const wholeField = c => { const f = field(c); return [f.l, f.t, f.r, f.b]; };

const FRACS = [0.02, 0.08, 0.2, 0.5, 0.8, 1];
async function selectArmy(c, frac, mods) {
    const g = c.geom;
    if (g.own.vis < 1 && g.army) await show(c, 'army');
    const bbox = c.geom.own.bbox || wholeField(c);
    return boxFraction(c, bbox, frac, { mods });
}
async function selectBase(c, frac) {
    if (c.geom.structs.own.length < 3 && c.geom.structs.base) await show(c, 'base', 1.5);
    const pts = c.geom.structs.own;
    if (!pts.length) return null;
    const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
    return boxFraction(c, [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)], frac);
}
const needArmy = async c => { const s = await c.state(); if (selTotal(s) < 20) { await selectArmy(c, c.rng.pick([0.2, 0.5, 1, 1])); await sleep(300); } };

// ---- the catalog ----
const A = [];
const add = a => { A.push(Object.assign({ weight: 1, tailMs: 3500, settleMs: 800 }, a)); };

// -- selection --
add({ name: 'select.boxArmy', cat: 'selection', weight: 7, tailMs: 4500, run: async c => { const f = c.rng.pick(FRACS); const m = c.rng.chance(0.25) ? ['Shift'] : undefined; await selectArmy(c, f, m); return { note: `frac ${f}${m ? ' +shift' : ''}` }; } });
add({ name: 'select.boxAll', cat: 'selection', weight: 5, tailMs: 5000, run: async c => { if (c.rng.chance(0.5)) await c.page.evaluate(() => __pf.cam('min', 'map')); await sleep(200); await c.refreshGeom(); await c.drag(...wholeField(c), { steps: 8 }); return { note: 'whole field' }; } });
add({ name: 'select.boxBase', cat: 'selection', weight: 4, tailMs: 4000, run: async c => { const f = c.rng.pick([0.2, 0.6, 1]); const b = await selectBase(c, f); return b ? { note: `frac ${f}` } : { skipped: 'no own structures on screen' }; } });
add({ name: 'select.boxShiftGrow', cat: 'selection', weight: 3, tailMs: 4500, run: async c => { const n = c.rng.int(3, 8); for (let i = 0; i < n; i++) { await selectArmy(c, c.rng.pick([0.05, 0.1, 0.3]), ['Shift']); await sleep(c.rng.int(30, 160)); } return { note: `${n} shift boxes` }; } });
add({ name: 'select.thrash', cat: 'selection', weight: 4, tailMs: 4000, run: async c => {
    const n = c.rng.int(8, 24), rate = c.rng.pick([3, 5, 8]); const t0 = Date.now();
    for (let i = 0; i < n; i++) { await selectArmy(c, [1, 0.1, 0.9][i % 3]); const wait = t0 + (i + 1) * 1000 / rate - Date.now(); if (wait > 0) await sleep(wait); }
    return { note: `${n} boxes at ${rate}/s` };
} });
add({ name: 'select.clickUnit', cat: 'selection', weight: 3, tailMs: 2500, run: async c => { const p = pickPt(c, c.geom.own.pts); if (!p) return { skipped: 'no own unit on screen' }; const mods = c.rng.pick([undefined, undefined, ['Control'], ['Shift']]); await c.click(p[0], p[1], { mods }); return { note: mods ? mods[0] : 'plain' }; } });
add({ name: 'select.clickStruct', cat: 'selection', weight: 3, tailMs: 2500, run: async c => { const p = pickPt(c, c.geom.structs.own); if (!p) return { skipped: 'no own structure on screen' }; const mods = c.rng.pick([undefined, undefined, ['Control'], ['Shift']]); await c.click(p[0], p[1], { mods }); return { note: mods ? mods[0] : 'plain' }; } });
add({ name: 'select.panelAll', cat: 'selection', weight: 5, tailMs: 5000, run: async c => {
    const list = await c.controls({ region: '^right-panel$', re: 'info-player-status-select-btn' });
    if (!list.length) return { skipped: 'no info panel select buttons' };
    const x = c.rng.pick(list); await c.click(x.x, x.y); return { note: x.label.slice(-24) };
} });
add({ name: 'select.bottomBar', cat: 'selection', weight: 5, tailMs: 5000, run: async c => {
    const tiles = await c.controls({ region: '^bottom-bar$', re: 'bb-thing|bb-tile|bb-unit|bb-struct' });
    if (!tiles.length) return { skipped: 'no bottom bar tiles' };
    const t = c.rng.pick(tiles); await c.click(t.x, t.y); await sleep(250);
    const btns = await c.controls({ region: '^bbmenu$', re: 'select' });
    if (!btns.length) return { note: 'tile menu without select' };
    const want = c.rng.pick(['all', 'all', 'idle', 'one']), b = btns.find(x => x.label.toLowerCase().includes(want)) || btns[0];
    await c.click(b.x, b.y); return { note: want };
} });
add({ name: 'group.assignRecall', cat: 'selection', weight: 4, tailMs: 4000, run: async c => {
    const k = c.rng.int(2, 6); const slots = c.rng.shuffle([1, 2, 3, 4, 5, 6, 7, 8, 9]).slice(0, k);
    for (const s of slots) { await selectArmy(c, c.rng.pick([0.05, 0.3, 1])); await c.key(String(s), { mods: ['Control'] }); await sleep(60); }
    for (let i = 0; i < k * 2; i++) { await c.key(String(c.rng.pick(slots))); await sleep(c.rng.int(40, 220)); }
    return { note: `${k} groups` };
} });

// -- orders --
const groundTarget = c => {
    const r = c.rng.next(), g = c.geom;
    if (r < 0.4) return randomGround(c);
    if (r < 0.7 && g.foe.pts.length) return near(c, c.rng.pick(g.foe.pts), 25);
    if (r < 0.85 && g.own.pts.length) return near(c, c.rng.pick(g.own.pts), 80);
    return randomGround(c);
};
add({ name: 'order.move', cat: 'orders', weight: 8, tailMs: 5000, prelude: needArmy, run: async c => { const p = groundTarget(c); await c.click(p[0], p[1], { button: 'right' }); return { note: 'right click' }; } });
add({ name: 'order.chain', cat: 'orders', weight: 6, tailMs: 5000, prelude: needArmy, run: async c => {
    const n = c.rng.int(3, 14), mod = c.rng.pick(['Shift', 'Control']);
    await c.keyDown(mod);
    for (let i = 0; i < n; i++) { const p = groundTarget(c); await c.click(p[0], p[1], { button: 'right' }); await sleep(c.rng.int(30, 140)); }
    await c.keyUp(mod); return { note: `${n} ${mod}+right clicks` };
} });
add({ name: 'order.rapid', cat: 'orders', weight: 5, tailMs: 5000, prelude: needArmy, run: async c => {
    const n = c.rng.int(8, 40), gap = c.rng.pick([40, 80, 120]);
    for (let i = 0; i < n; i++) { const p = randomGround(c); await c.click(p[0], p[1], { button: 'right' }); await sleep(gap); }
    return { note: `${n} clicks, ${gap} ms apart` };
} });
add({ name: 'order.attackMove', cat: 'orders', weight: 5, tailMs: 5000, prelude: needArmy, run: async c => {
    const k = c.rng.int(1, 3);
    for (let i = 0; i < k; i++) { await c.key('z'); const p = groundTarget(c); await c.click(p[0], p[1], { button: 'right' }); await sleep(c.rng.int(40, 200)); }
    return { note: `${k} attack moves` };
} });
add({ name: 'order.attackTarget', cat: 'orders', weight: 3, tailMs: 5000, prelude: needArmy, run: async c => { const p = pickPt(c, c.geom.foe.pts) || pickPt(c, c.geom.structs.foe); if (!p) return { skipped: 'no enemy on screen' }; await c.click(p[0], p[1], { button: 'right' }); return { note: 'on enemy' }; } });
add({ name: 'order.stopHold', cat: 'orders', weight: 3, tailMs: 3500, prelude: needArmy, run: async c => { const k = c.rng.pick(['x', 'c']); await c.key(k); return { note: k === 'x' ? 'stop' : 'hold' }; } });
add({ name: 'order.minimap', cat: 'orders', weight: 5, tailMs: 5000, prelude: needArmy, run: async c => {
    const n = c.rng.int(1, 6), mod = c.rng.chance(0.4) ? 'Shift' : null;
    if (mod) await c.keyDown(mod);
    for (let i = 0; i < n; i++) { const w = c.rng.chance(0.4) && c.geom.structs.enemyBase ? c.geom.structs.enemyBase : worldRandom(c); const p = minimapPoint(c, w[0], w[1]); if (!p) break; await c.click(p[0], p[1], { button: 'right' }); await sleep(c.rng.int(40, 200)); }
    if (mod) await c.keyUp(mod); return { note: `${n} minimap orders${mod ? ' +shift' : ''}` };
} });
add({ name: 'order.resize', cat: 'orders', weight: 2, tailMs: 4000, prelude: needArmy, run: async c => { const n = c.rng.int(1, 4); for (let i = 0; i < n; i++) { await c.key(c.rng.pick(['q', 'e'])); await sleep(c.rng.int(60, 300)); } return { note: `${n} q/e` }; } });
add({ name: 'rally.base', cat: 'orders', weight: 6, tailMs: 5000,
    prelude: async c => { const b = await selectBase(c, c.rng.pick([0.4, 1])); if (!b) { await show(c, 'base', 1); await selectBase(c, 1); } },
    run: async c => {
        const n = c.rng.chance(0.5) ? 1 : c.rng.int(2, 12), mod = n > 1 ? c.rng.pick(['Shift', 'Control']) : null;
        if (mod) await c.keyDown(mod);
        for (let i = 0; i < n; i++) { const p = groundTarget(c); await c.click(p[0], p[1], { button: 'right' }); await sleep(c.rng.int(30, 140)); }
        if (mod) await c.keyUp(mod);
        return { note: `${n} rally clicks` };
    } });
add({ name: 'rally.all', cat: 'orders', weight: 6, tailMs: 6000,
    prelude: async c => { await c.page.evaluate(() => __pf.cam('min', 'map')); await sleep(300); await c.refreshGeom(); await c.drag(...wholeField(c), { steps: 8 }); await sleep(400); },
    run: async c => {
        const n = c.rng.chance(0.4) ? 1 : c.rng.int(2, 10), mod = n > 1 ? c.rng.pick(['Shift', 'Control']) : null;
        if (mod) await c.keyDown(mod);
        for (let i = 0; i < n; i++) { const p = groundTarget(c); await c.click(p[0], p[1], { button: 'right' }); await sleep(c.rng.int(30, 140)); }
        if (mod) await c.keyUp(mod);
        return { note: `${n} clicks with everything selected` };
    } });
add({ name: 'queue.units', cat: 'economy', weight: 5, tailMs: 5000,
    prelude: async c => { await c.key('Escape'); await sleep(100); if (c.geom.structs.own.filter(p => p[2] === 'b').length < 3 && c.geom.structs.base) await show(c, 'base', 1.5); },
    run: async c => {
        const pts = c.geom.structs.own.filter(p => p[2] === 'b'); if (!pts.length) return { skipped: 'no own barracks on screen' };
        const n = c.rng.int(5, 40), gap = c.rng.pick([30, 70, 140]);
        for (let i = 0; i < n; i++) { const p = c.rng.pick(pts); await c.click(p[0], p[1], { button: 'right' }); await sleep(gap); }
        return { note: `${n} queue clicks, ${gap} ms apart` };
    } });
const pickBuildItem = async c => {
    const tabs = await c.controls({ region: '^build-bar$', re: 'build-tab' }); if (tabs.length && c.rng.chance(0.5)) { const t = c.rng.pick(tabs); await c.click(t.x, t.y); await sleep(150); }
    const items = await c.controls({ region: '^build-bar$', re: 'build-item' }); if (!items.length) return null;
    const it = c.rng.pick(items); await c.click(it.x, it.y); await sleep(120); return it;
};
add({ name: 'build.place', cat: 'economy', weight: 5, tailMs: 4000,
    prelude: async c => { await c.key('Escape'); if (c.geom.structs.own.length < 3 && c.geom.structs.base) await show(c, 'base', 2); },
    run: async c => {
        const it = await pickBuildItem(c); if (!it) return { skipped: 'no build items' };
        const base = pickPt(c, c.geom.structs.own) || randomGround(c), n = c.rng.int(1, 8);
        for (let i = 0; i < n; i++) { const p = near(c, base, 160); await c.mouse(p[0], p[1], 3); await c.click(p[0], p[1]); await sleep(c.rng.int(40, 200)); }
        await c.key('Escape'); return { note: `${n} placements` };
    } });
add({ name: 'build.dragLine', cat: 'economy', weight: 4, tailMs: 5000,
    prelude: async c => { await c.key('Escape'); if (c.geom.structs.own.length < 3 && c.geom.structs.base) await show(c, 'base', 2); },
    run: async c => {
        const it = await pickBuildItem(c); if (!it) return { skipped: 'no build items' };
        const a = near(c, pickPt(c, c.geom.structs.own) || randomGround(c), 100), ang = c.rng.range(0, Math.PI * 2), len = c.rng.pick([150, 400, 900]);
        const b = near(c, [a[0] + Math.cos(ang) * len, a[1] + Math.sin(ang) * len], 0);
        await c.drag(a[0], a[1], b[0], b[1], { steps: c.rng.pick([10, 30, 80]), mods: ['Shift'] }); await c.key('Escape');
        return { note: `${len}px shift drag` };
    } });
// Salvaging a selected group of buildings (the info panel's own button): thousands of structures going at once.
add({ name: 'panel.salvage', cat: 'economy', weight: 1.5, tailMs: 6000,
    prelude: async c => { await selectBase(c, c.rng.pick([0.1, 0.3, 1])); },
    run: async c => {
        const list = await c.controls({ region: '^right-panel$', re: 'info-salvage', noSkip: true, max: 12 });
        if (!list.length) return { skipped: 'no salvage button in the info panel' };
        const x = c.rng.pick(list); await c.click(x.x, x.y); return { note: x.label.slice(0, 30) };
    } });
add({ name: 'bar.boost', cat: 'economy', weight: 3, tailMs: 3500, run: async c => {
    const slots = await c.controls({ region: '^bottom-bar$', re: 'bb-boost', max: 30 });
    if (!slots.length) return { skipped: 'no boost slots' };
    const a = c.rng.pick(slots), b = c.rng.pick(slots); await c.drag(a.x, a.y, b.x, b.y, { steps: 6 }); return { note: 'boost drag' };
} });

// -- camera / view --
add({ name: 'cam.pan', cat: 'camera', weight: 6, tailMs: 3000, run: async c => {
    const keys = c.rng.pick([['w'], ['a'], ['s'], ['d'], ['w', 'a'], ['s', 'd'], ['ArrowUp'], ['ArrowLeft', 'ArrowDown'], ['w', 'd']]), ms = c.rng.int(300, 2800);
    for (const k of keys) await c.keyDown(k); await sleep(ms); for (const k of keys) await c.keyUp(k); return { note: `${keys.join('+')} ${ms} ms` };
} });
add({ name: 'cam.zoom', cat: 'camera', weight: 7, tailMs: 3500, run: async c => {
    const f = field(c), x = c.rng.range(f.l, f.r), y = c.rng.range(f.t, f.b), dir = c.rng.pick([-1, 1]), n = c.rng.int(4, 30), gap = c.rng.pick([12, 30, 60]), sweep = c.rng.chance(0.3);
    await c.mouse(x, y, 2);
    for (let i = 0; i < n; i++) { await c.wheel(dir * (sweep && i >= n / 2 ? -1 : 1) * 100); await sleep(gap); }
    return { note: `${n} wheel ticks ${dir < 0 ? 'in' : 'out'}${sweep ? ' and back' : ''}` };
} });
add({ name: 'cam.zoomLimits', cat: 'camera', weight: 3, tailMs: 4000, run: async c => {
    const f = field(c); await c.mouse((f.l + f.r) / 2, (f.t + f.b) / 2, 2);
    for (let i = 0; i < 30; i++) { await c.wheel(100); await sleep(20); }
    await sleep(500); await c.refreshGeom();
    for (let i = 0; i < 30; i++) { await c.wheel(-100); await sleep(20); }
    return { note: 'out to the limit then in' };
} });
add({ name: 'cam.minimap', cat: 'camera', weight: 5, tailMs: 3000, run: async c => {
    const m = c.geom.minimap; if (!m) return { skipped: 'no minimap' };
    const a = [m.left + c.rng.range(0.05, 0.95) * m.width, m.top + c.rng.range(0.05, 0.95) * m.height];
    if (c.rng.chance(0.5)) { await c.click(a[0], a[1]); return { note: 'click' }; }
    const b = [m.left + c.rng.range(0.05, 0.95) * m.width, m.top + c.rng.range(0.05, 0.95) * m.height];
    await c.drag(a[0], a[1], b[0], b[1], { steps: c.rng.int(6, 30) }); return { note: 'drag' };
} });
add({ name: 'view.switch', cat: 'view', weight: 6, tailMs: 5000, settleMs: 1500, run: async c => {
    const how = c.rng.pick(['2d', '2.5d', '3d', '3.5d', 'spaceLong', 'spaceTap']);
    if (how === 'spaceLong') { await c.keyDown(' '); await sleep(520); await c.keyUp(' '); }
    else if (how === 'spaceTap') { await c.keyDown(' '); await sleep(80); await c.keyUp(' '); }
    else { const id = { '2d': 'btn-view-2d', '2.5d': 'btn-view-2d5', '3d': 'btn-view-3d', '3.5d': 'btn-view-3d5' }[how]; const b = (await c.controls({ ids: [id] }))[0]; if (!b) return { skipped: 'no view button' }; await c.click(b.x, b.y); }
    return { note: how };
} });
add({ name: 'view.resize', cat: 'view', weight: 2, tailMs: 4000, settleMs: 1500, run: async c => {
    const [w, h] = c.rng.pick([[1280, 720], [1920, 1080], [1024, 768], [1600, 900], [1366, 768], [2200, 1000], [900, 700]]);
    await c.page.setViewportSize({ width: w, height: h }); c.S.cur.viewport = { width: w, height: h };
    return { note: `${w}x${h}` };
} });
add({ name: 'view.orbit', cat: 'view', weight: 4, tailMs: 4000,
    prelude: async c => { const s = await c.state(); if (!/^3/.test(s.view)) { const b = (await c.controls({ ids: ['btn-view-3d'] }))[0]; if (b) { await c.click(b.x, b.y); await sleep(2500); } } },
    run: async c => {
        const f = field(c), cx = (f.l + f.r) / 2, cy = (f.t + f.b) / 2, n = c.rng.int(1, 4);
        for (let i = 0; i < n; i++) { await c.drag(cx, cy, cx + c.rng.range(-400, 400), cy + c.rng.range(-200, 200), { button: 'middle', steps: c.rng.int(8, 30) }); await sleep(80); }
        return { note: `${n} middle drags` };
    } });

// -- UI --
add({ name: 'ui.settings', cat: 'ui', weight: 6, tailMs: 4000, settleMs: 1200, run: async c => {
    const open = (await c.controls({ ids: ['btn-help'] }))[0]; if (!open) return { skipped: 'no settings button' };
    await c.click(open.x, open.y); await sleep(350);
    const n = c.rng.int(1, 4); const notes = [];
    for (let i = 0; i < n; i++) {
        const list = (await c.controls({ region: '^popup:help-popup' })).filter(x => !/btn-help-close|help-close/.test(x.id) && (x.tag === 'select' || x.type === 'checkbox' || x.type === 'range' || x.tag === 'button'));
        if (!list.length) break;
        const x = c.rng.pick(list);
        if (x.tag === 'select' && x.options && x.options.length) { const v = c.rng.pick(x.options); await c.setSelect(x.x, x.y, v); notes.push(`${x.id}=${v}`); }
        else if (x.type === 'range') { await slide(c, x, c.rng.next()); notes.push((x.id || 'range') + ' slider'); }
        else { await c.click(x.x, x.y); notes.push(x.id || x.label.slice(0, 16)); }
        await sleep(c.rng.int(100, 500));
    }
    await c.key('Escape'); return { note: notes.join(' ') };
} });
add({ name: 'ui.generic', cat: 'ui', weight: 9, tailMs: 3000, run: async c => {
    const depth = c.rng.int(1, 3), notes = [];
    for (let d = 0; d < depth; d++) {
        const list = await c.controls({ max: 40 }); if (!list.length) break;
        // Menus first when one is open, else anything.
        const open = list.filter(x => /^(popup|bbmenu)/.test(x.region)), pool = open.length && c.rng.chance(0.8) ? open : list;
        const x = c.rng.pick(pool);
        if (x.tag === 'select' && x.options && x.options.length) { const v = c.rng.pick(x.options); await c.setSelect(x.x, x.y, v); notes.push(`${x.id || x.label.slice(0, 18)}=${v}`); }
        else if (x.type === 'range') { await slide(c, x, c.rng.next()); notes.push((x.id || 'range') + ' slider'); }
        else { const mods = c.rng.chance(0.12) ? [c.rng.pick(['Shift', 'Control'])] : undefined; await c.click(x.x, x.y, { button: c.rng.chance(0.1) ? 'right' : 'left', mods }); notes.push(x.region + ':' + (x.id || x.label.slice(0, 22))); }
        await sleep(c.rng.int(60, 350));
    }
    return { note: notes.join(' > ') };
} });
add({ name: 'ui.hover', cat: 'ui', weight: 4, tailMs: 2500, run: async c => {
    const ctl = await c.controls({ max: 25 }), pts = [...c.geom.own.pts, ...c.geom.foe.pts, ...c.geom.structs.own, ...c.geom.structs.foe, ...ctl.map(x => [x.x, x.y])];
    if (!pts.length) return { skipped: 'nothing to hover' };
    const n = c.rng.int(4, 10);
    for (let i = 0; i < n; i++) { const p = c.rng.pick(pts); await c.mouse(p[0], p[1], 12); await sleep(c.rng.int(150, 900)); }
    return { note: `${n} hovers` };
} });
add({ name: 'ui.mouseStorm', cat: 'ui', weight: 3, tailMs: 3000, run: async c => {
    const withBuild = c.rng.chance(0.35); if (withBuild) await pickBuildItem(c);
    const n = c.rng.int(60, 240); let p = randomGround(c);
    for (let i = 0; i < n; i++) { p = near(c, p, 90); await c.mouse(p[0], p[1], 1); if (i % 8 === 0) await sleep(4); }
    if (withBuild) await c.key('Escape'); return { note: `${n} moves${withBuild ? ' with a build ghost' : ''}` };
} });
const KEYS = ['z', 'x', 'c', 'f', 'q', 'e', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'r', 't', 'y', 'u', 'i', 'o', 'p', 'Tab', 'Enter', 'h', 'b', 'm', 'g', 'v', 'n', 'j', 'k', 'l', 'a', 's', 'd', 'w'];
add({ name: 'ui.keys', cat: 'ui', weight: 4, tailMs: 3000, run: async c => {
    const n = c.rng.int(4, 16), seq = [];
    for (let i = 0; i < n; i++) { const k = c.rng.pick(KEYS), mods = c.rng.chance(0.25) ? [c.rng.pick(['Shift', 'Control'])] : undefined; await c.key(k, { mods }); seq.push((mods ? mods[0][0] + '+' : '') + k); await sleep(c.rng.int(30, 250)); }
    return { note: seq.join(' ') };
} });
add({ name: 'ui.panel', cat: 'ui', weight: 5, tailMs: 3500, run: async c => {
    const n = c.rng.int(1, 5), notes = [];
    for (let i = 0; i < n; i++) {
        const list = await c.controls({ region: '^(right-panel|control-group-bar)$', max: 30 }); if (!list.length) break;
        const x = c.rng.pick(list); await c.click(x.x, x.y); notes.push((x.id || x.label).slice(0, 26)); await sleep(c.rng.int(80, 400));
    }
    if (c.rng.chance(0.5)) { const r = (await c.controls({ region: '^right-panel$', max: 3 }))[0]; if (r) { await c.mouse(r.x, r.y, 2); for (let i = 0; i < c.rng.int(3, 12); i++) { await c.wheel(c.rng.pick([-1, 1]) * 120); await sleep(30); } notes.push('wheel'); } }
    return { note: notes.join(' > ') };
} });
add({ name: 'ui.bottomBar', cat: 'ui', weight: 5, tailMs: 3500, run: async c => {
    const n = c.rng.int(1, 4), notes = [];
    for (let i = 0; i < n; i++) {
        const list = await c.controls({ region: '^(bottom-bar|bbmenu)$', max: 30 }); if (!list.length) break;
        const x = c.rng.pick(list); await c.click(x.x, x.y, { button: c.rng.chance(0.15) ? 'right' : 'left', mods: c.rng.chance(0.2) ? [c.rng.pick(['Shift', 'Control'])] : undefined }); notes.push((x.id || x.label).slice(0, 26)); await sleep(c.rng.int(80, 400));
    }
    return { note: notes.join(' > ') };
} });
add({ name: 'ui.popups', cat: 'ui', weight: 4, tailMs: 3500, settleMs: 1200, run: async c => {
    // Every popup/panel opener: the ones that open something are followed by a few clicks inside, then closed.
    const ids = ['btn-help', 'jukebox-open', 'btn-minimap', 'btn-default-build', 'btn-default-auto-upgrade', 'btn-help'];
    const notes = [];
    for (let i = 0; i < c.rng.int(1, 3); i++) {
        let x = (await c.controls({ ids: [c.rng.pick(ids)] }))[0];
        if (!x) x = c.rng.pick(await c.controls({ region: '^(hud|left-panel)$', max: 12 }));
        if (!x) break; await c.click(x.x, x.y); await sleep(400); notes.push(x.id || x.label.slice(0, 20));
        const inside = await c.controls({ region: '^popup', max: 20 }); if (inside.length) { const y = c.rng.pick(inside); await c.click(y.x, y.y); await sleep(250); }
        await c.key('Escape'); await sleep(150);
    }
    return { note: notes.join(', ') };
} });

// ---- scenarios: the known pain points as chained steps ----
// Each step is an action name; the scenario runs them back to back as ONE
// measured trial (preludes of later steps are skipped: the chain is the point).
const SCN = [
    { name: 'scn.bigSelectRally', weight: 5, steps: ['select.boxAll', 'order.chain', 'rally.all'], tailMs: 7000, note: 'everything selected, orders and rally chains' },
    { name: 'scn.selectMoveThrash', weight: 4, steps: ['select.boxArmy', 'order.move', 'select.boxArmy', 'order.move', 'select.boxAll', 'order.move'], tailMs: 6000, note: 'select, send, reselect' },
    { name: 'scn.groupsAndPan', weight: 3, steps: ['group.assignRecall', 'cam.pan', 'cam.zoom', 'group.assignRecall'], tailMs: 5000, note: 'control groups while moving the camera' },
    { name: 'scn.viewTour', weight: 3, steps: ['view.switch', 'cam.zoom', 'view.orbit', 'cam.pan', 'view.switch'], tailMs: 6000, note: 'view switches with zoom and orbit' },
    { name: 'scn.uiTour', weight: 3, steps: ['ui.popups', 'ui.settings', 'ui.generic', 'ui.generic', 'ui.panel', 'ui.bottomBar'], tailMs: 5000, note: 'menus and panels in sequence' },
    { name: 'scn.economyStorm', weight: 3, steps: ['build.dragLine', 'queue.units', 'build.place', 'queue.units'], tailMs: 6000, note: 'build lines and queue storms' },
    { name: 'scn.marchToBattle', weight: 3, steps: ['select.boxAll', 'order.attackMove', 'cam.minimap', 'order.minimap'], tailMs: 8000, note: 'whole army into the enemy' },
    { name: 'scn.holdBigSelection', weight: 2, steps: ['select.boxAll', 'cam.pan', 'cam.zoom', 'ui.hover', 'cam.pan'], tailMs: 12000, note: 'a big selection held while the player looks around' },
];

const byName = new Map(A.map(a => [a.name, a]));
const scenarioAction = s => ({ name: s.name, cat: 'scenario', weight: s.weight, tailMs: s.tailMs, settleMs: 1000, scenario: true, steps: s.steps, note: s.note });

// What a leak hunt may repeat: the actions that do not change the world for good (no new units, no new buildings, no salvage).
const LEAK_SAFE = A.filter(a => !/^(queue\.|build\.|panel\.salvage|rally\.|scn\.)/.test(a.name)).map(a => a.name);

module.exports = { leakSafe: LEAK_SAFE, actions: A, scenarios: SCN.map(scenarioAction), byName, selTotal };
