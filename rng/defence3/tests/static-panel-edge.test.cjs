'use strict';
// The simulation worker's page paths in real Edge (the other tests run the
// in-page simulation, which keeps the old ones): the packer thread's box
// selection (2D and 3D) and order ids, the static research block and player
// status, and that refreshes make no elements.
//   node tests/static-panel-edge.test.cjs [scene.gz]     (HEADED=1 to watch)
const assert = require('node:assert/strict');
const { loadPlaywright, startServer, sleep } = require('./perf-fuzz/env.cjs');
const fixture = process.argv[2] || 'defence3-scene-2026-10-31T13-31-34-674Z.gz';
const results = [];
const check = (name, fn) => results.push(Promise.resolve().then(fn).then(() => { console.log('ok  ', name); return true; }, e => { console.log('FAIL', name, '\n     ', e.message); return false; }));
(async () => {
    const { server, base } = await startServer();
    let browser;
    try {
        browser = await loadPlaywright().chromium.launch({ channel: 'msedge', headless: !process.env.HEADED });
        const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
        const errors = [];
        page.on('pageerror', e => errors.push(e.message));
        await page.goto(base + '/index.html', { waitUntil: 'load', timeout: 120000 });
        await page.evaluate(async f => { await restoreSoloGameSnapshot(await readSoloGameSnapshotFile(await (await fetch('tests/' + f)).blob())); }, fixture);
        await page.waitForFunction(() => typeof simClientStats === 'function' && simClientStats().appliedTick >= 5 && _ipk.state === 2 && infoPanelStaticActive(), {}, { timeout: 300000 });
        await sleep(1500);
        const canvas = await page.evaluate(() => { const r = document.querySelector('canvas').getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; });
        await page.mouse.move(canvas.x + canvas.w / 2, canvas.y + canvas.h / 2);
        for (let i = 0; i < 12; i++) { await page.mouse.wheel(0, 400); await sleep(30); }
        await sleep(1000);

        // Box selection through the packer, against a page-side reference made
        // from the same frame columns, structure views and projection (the
        // packer's rule: ground point, top point, or the line between them).
        const boxCase = async mode => page.evaluate(async mode => {
            if (renderDimensionMode !== mode) setRenderDimensionMode(mode);
            await new Promise(r => setTimeout(r, 400));
            selectedUnits = []; selectedEntities = [];
            const me = localPlayerId, W = renderer3dInstance ? renderer3dInstance.cssWidth : 0, H = renderer3dInstance ? renderer3dInstance.cssHeight : 0;
            let screen = null, world = null;
            if (mode === '3d') screen = { sx: W * 0.1, sy: H * 0.1, ex: W * 0.8, ey: H * 0.85 };
            else world = { sx: GRID_W * TILE * 0.15, sy: GRID_H * TILE * 0.15, ex: GRID_W * TILE * 0.85, ey: GRID_H * TILE * 0.85 };
            // (The reference at the same moment: the packer gets this frame and alpha.)
            const F = simClientCurrentUnitVis(), alpha = tickAlpha, it = 1 / TILE;
            let VP = null, pad = 0;
            if (mode === '3d') { renderer3dInstance.buildViewProjection(get3DProjectionSnapshot()); VP = Array.from(renderer3dInstance.tmpViewProjection); pad = renderer3dInstance.viewPad || 0; }
            const proj = (wx, lift, wz) => { const cw = VP[3] * wx + VP[7] * lift + VP[11] * wz + VP[15]; if (!(cw > 0)) return null;
                return [((VP[0] * wx + VP[4] * lift + VP[8] * wz + VP[12]) / cw * 0.5 + 0.5) * W - pad, (1 - ((VP[1] * wx + VP[5] * lift + VP[9] * wz + VP[13]) / cw * 0.5 + 0.5)) * H - pad]; };
            const R = screen ? [Math.min(screen.sx, screen.ex), Math.min(screen.sy, screen.ey), Math.max(screen.sx, screen.ex), Math.max(screen.sy, screen.ey)] : [world.sx, world.sy, world.ex, world.ey];
            const inBox = p => p && p[0] >= R[0] && p[0] <= R[2] && p[1] >= R[1] && p[1] <= R[3];
            const hit = (wx, wz, lift, top) => { const a = proj(wx, lift, wz), b = proj(wx, top, wz); if (inBox(a) || inBox(b)) return true;
                if (!a || !b) return false; for (let k = 1; k < 32; k++) if (inBox([a[0] + (b[0] - a[0]) * k / 32, a[1] + (b[1] - a[1]) * k / 32])) return true; return false; };
            const refUnits = new Set(), refStructs = new Set();
            for (let s = 0; s < F.x.length; s++) {
                if (F.owner[s] !== me || F.id[s] < 0) continue;
                const x = F.px[s] + (F.x[s] - F.px[s]) * alpha, y = F.py[s] + (F.y[s] - F.py[s]) * alpha;
                if (mode === '2d' ? inBox([x, y]) : hit(x * it, y * it, 0.28, 0.9)) refUnits.add(F.id[s]);
            }
            const LIFT = [0.18, 0.12, 0.14, 0.08], TOP = [0.9, 0.7, 0.7, 0.2];
            for (const v of _pageStructViews) {
                if (!v || v.dead || v._kind > 3 || v.owner !== me || (v._kind <= 2 && !(v.energy > 0))) continue;
                if (mode === '2d' ? inBox([v.x, v.y]) : hit(v.x * it, v.y * it, LIFT[v._kind], TOP[v._kind])) refStructs.add(v);
            }
            if (!infoPackBoxSelect(screen, false, world)) return { error: 'packer did not take the box' };
            const t0 = performance.now();
            while (_ipkBox.pending && performance.now() - t0 < 5000) await new Promise(r => setTimeout(r, 10));
            const gotUnits = new Set(selectedUnits.map(u => u.id)), gotStructs = new Set(selectedEntities.filter(e => !(e._kind >= 4)));
            const diff = (a, b) => [...a].filter(x => !b.has(x)).length;
            return { mode, ref: refUnits.size, got: gotUnits.size, missing: diff(refUnits, gotUnits), extra: diff(gotUnits, refUnits),
                refS: refStructs.size, gotS: gotStructs.size, missingS: diff(refStructs, gotStructs), extraS: diff(gotStructs, refStructs),
                foreign: selectedUnits.filter(u => u.owner !== me).length + selectedEntities.filter(e => !(e._kind >= 4) && e.owner !== me).length, pending: _ipkBox.pending };
        }, mode);
        for (const mode of ['2d', '3d']) {
            const r = await boxCase(mode);
            check(`packer box selection ${mode} matches the reference ${JSON.stringify(r)}`, () => {
                assert.ok(!r.error, r.error); assert.equal(r.pending, false);
                assert.ok(r.ref > 20 && r.refS > 5, 'the box holds units and structures');
                assert.equal(r.foreign, 0, 'only the player\'s own things');
                // (Units move between the reference and the packer's pass: a few may differ.)
                assert.ok(r.missing + r.extra <= Math.max(2, r.ref * 0.02), 'units: ' + (r.missing + r.extra) + ' differ');
                assert.equal(r.missingS + r.extraS, 0, 'structures differ');
            });
        }

        // Order ids: the packer's lists and wire strings for the selection.
        await page.evaluate(() => { _infoPanelNextRefreshAt = 0; updateInfoPanel(); });
        await page.waitForFunction(() => infoPackSelectionIds(0) !== null, {}, { timeout: 5000 }).catch(() => { });
        const ids = await page.evaluate(() => {
            const all = infoPackSelectionIds(0), combat = infoPackSelectionIds(1), workers = infoPackSelectionIds(2);
            if (!all) return { error: 'no ids for the selection' };
            const sel = selectedUnits.filter(u => !u.dead), want = sel.map(u => u.id).sort((a, b) => a - b), wantW = sel.filter(u => u.workerType).map(u => u.id).sort((a, b) => a - b);
            const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
            const sorted = a => Array.from(a).sort((x, y) => x - y);
            let wireOk = true, pieces = 0;
            for (const list of [all, combat, workers]) for (let k = 0; k * ACTION_MAX_UNIT_IDS < list.length; k++) {
                const z = infoPackIdsWire(list, k); pieces++;
                if (!z || !same(actionIdsDecode(z), list.slice(k * ACTION_MAX_UNIT_IDS, (k + 1) * ACTION_MAX_UNIT_IDS))) wireOk = false;
            }
            return { n: all.length, all: same(sorted(all), want), workers: same(sorted(workers), wantW), split: combat.length + workers.length === all.length, wireOk, pieces };
        });
        check(`packer order ids and wire strings ${JSON.stringify(ids)}`, () => {
            assert.ok(!ids.error, ids.error); assert.ok(ids.n > 0);
            assert.ok(ids.all, 'all ids = the selection'); assert.ok(ids.workers, 'worker ids = the selected workers'); assert.ok(ids.split, 'combat + workers = all'); assert.ok(ids.wireOk, 'wire strings decode to the ids');
        });
        // A right click uses the made wire strings (worker.js _queueLocalAction).
        // (Orders of 64 ids or more go as wire strings: none encoded on the click.)
        await page.evaluate(() => { window.__ord = { orders: 0, encoded: 0 }; const q = queueAction, e = actionIdsEncode; window.__ordQ = [q, e];
            queueAction = function (a) { if (a && Array.isArray(a.unitIds) && a.unitIds.length >= 64) __ord.orders++; return q.apply(this, arguments); };
            // (Unit orders only: a structure selection's rally split encodes its tile keys, assign_nearest.js, on a worker past RALLY_ASYNC_MIN.)
            actionIdsEncode = function (ids) { const at = new Error().stack; if (ids && ids.length >= 64 && /_queueLocalAction/.test(at)) { __ord.encoded++; __ord.at = at.split('\n').slice(2, 6).map(s => s.trim()).join(' < '); } return e.apply(this, arguments); }; });
        await page.mouse.click(canvas.x + canvas.w * 0.45, canvas.y + canvas.h * 0.5, { button: 'right' });
        await sleep(500);
        const order = await page.evaluate(() => { queueAction = window.__ordQ[0]; actionIdsEncode = window.__ordQ[1]; return __ord; });
        check(`a move order takes the packer's wire strings ${JSON.stringify(order)}`, () => { assert.ok(order.orders > 0, 'an order went'); assert.equal(order.encoded, 0, 'ids encoded on the click'); });

        // The research block: the player's labs selected, the queue opened.
        await page.evaluate(async () => {
            selectInfoPanelPlayerRoster('buildings', 'research', 'all', localPlayerId);
            await new Promise(r => setTimeout(r, 600)); updateInfoPanel();
        });
        await sleep(400);
        // (Real clicks: the queue toggle, then the second thing button.)
        if (!await page.evaluate(() => isResearchQueuePanelOpen(localPlayerId, 'group:' + localPlayerId))) await page.locator('.ips-research .ipr .info-research-queue-toggle').click();
        await sleep(400);
        await page.locator('.ips-research .ipr .info-research-thing-btn').nth(1).click();
        await sleep(400);
        const research = await page.evaluate(async () => {
            const wait = ms => new Promise(r => setTimeout(r, ms));
            updateInfoPanel(); await wait(200);
            const host = document.querySelector('.ips-research .ipr');
            if (!host || host.closest('[hidden]')) return { error: 'no research block shown' };
            const q = getPlayerResearchQueue(localPlayerId), task = getPlayerResearchTask(localPlayerId), n = q.length + (task ? 1 : 0);
            const rows = [...host.querySelectorAll('.ipr-row')].filter(r => !r.hidden);
            const first = task || q[0], idOf = t => `${t.kind}:${t.key}:${t.statKey}`;
            // (Read now: the pool's rows are reused once the list scrolls.)
            const firstOk = !n || (rows[0] && rows[0].dataset.researchId.startsWith(idOf(first)));
            const scroll = host.querySelector('.ipr-scroll');
            scroll.scrollTop = scroll.scrollHeight; scroll.dispatchEvent(new Event('scroll'));
            await wait(100);
            const shown = [...host.querySelectorAll('.ipr-row')].filter(r => !r.hidden).sort((a, b) => parseFloat(a.style.top) - parseFloat(b.style.top));
            const last = shown[shown.length - 1], lastTask = n ? (q.length ? q[q.length - 1] : task) : null;
            // Thing buttons: the one clicked picked, its stats' rows shown.
            const btn = host.querySelectorAll('.info-research-thing-btn')[1];
            const thing = RESEARCH_THINGS_BY_ID[btn.dataset.thingId], statRows = [...host.querySelectorAll('.ipr-stat')].filter(r => !r.hidden).length;
            return { n, rows: rows.length, firstOk, lastOk: !n || (last && last.dataset.researchId.startsWith(idOf(lastTask))),
                labs: host.querySelector('.ipr-labs').textContent, picked: btn.classList.contains('info-thing-btn-selected'), statRows, thingStats: new Set(thing.stats.map(getResearchMultiStatGroupKey)).size,
                sliders: [...host.querySelectorAll('.ipr-stat:not([hidden]) .count-slider')].every(i => JSON.parse(i.dataset.countSpec).type === 'research') };
        });
        check(`static research block ${JSON.stringify(research)}`, () => {
            assert.ok(!research.error, research.error);
            assert.ok(research.n > 0, 'the scene has a research queue');
            assert.equal(research.rows, Math.min(research.n, 9), 'the pool rows of the list\'s view');
            assert.ok(research.firstOk, 'first row = the first task'); assert.ok(research.lastOk, 'scrolled to the end: last row = the last task');
            assert.ok(Number(research.labs) > 0); assert.ok(research.picked);
            assert.equal(research.statRows, research.thingStats, 'a stat row per stat group of the thing'); assert.ok(research.sliders);
        });
        // No elements made by refreshes (values only) with the selection held.
        const quiet = await page.evaluate(async () => {
            const panel = document.getElementById('info-panel');
            let added = 0;
            const mo = new MutationObserver(list => { for (const m of list) added += m.addedNodes.length ? [...m.addedNodes].filter(n => n.nodeType === 1).length : 0; });
            mo.observe(panel, { childList: true, subtree: true });
            for (let i = 0; i < 20; i++) { _infoPanelNextRefreshAt = 0; updateInfoPanel(); await new Promise(r => setTimeout(r, 50)); }
            mo.disconnect();
            return added;
        });
        check(`research refreshes make no elements (${quiet})`, () => assert.equal(quiet, 0));

        // The player status: nothing selected.
        const status = await page.evaluate(async () => {
            selectedUnits = []; selectedEntities = [];
            for (const k of ['energyDelta', 'astarDelta', 'units', 'buildings']) infoPanelSectionCollapsed[k] = false;
            updateInfoPanel();
            await new Promise(r => setTimeout(r, 300)); updateInfoPanel();
            const host = document.querySelector('.ips-status');
            if (!host || host.hidden) return { error: 'status hidden' };
            const fu = getFrameUnitSummary(localPlayerId), fb = getFrameBuildingSummary(localPlayerId);
            const shown = sel => [...host.querySelectorAll(`.ipst-body[data-k="${sel}"] > .ipst-r`)].filter(r => !r.hidden);
            const units = shown('units'), buildings = shown('buildings');
            const want = [...fu.values()].filter(g => g.total > 0).length, wantB = [...fb.groups.values()].filter(g => g.total > 0).length;
            const text = units.map(r => r.querySelector('.info-value').textContent);
            const panel = document.getElementById('info-panel');
            let added = 0;
            const mo = new MutationObserver(list => { for (const m of list) added += [...m.addedNodes].filter(n => n.nodeType === 1).length; });
            mo.observe(panel, { childList: true, subtree: true });
            for (let i = 0; i < 20; i++) { _infoPanelNextRefreshAt = 0; updateInfoPanel(); await new Promise(r => setTimeout(r, 50)); }
            mo.disconnect();
            return { units: units.length, want, buildings: buildings.length, wantB, textOk: text.every(t => /^\d+ \/ \d+$/.test(t)), energy: !!host.querySelector('.ipst-t[data-k="energyDelta"] .ipst-v').textContent, added };
        });
        check(`static player status ${JSON.stringify(status)}`, () => {
            assert.ok(!status.error, status.error);
            assert.equal(status.units, status.want, 'a roster row per unit type the player has'); assert.equal(status.buildings, status.wantB, 'a roster row per building type');
            assert.ok(status.textOk); assert.ok(status.energy); assert.equal(status.added, 0, 'refreshes make no elements');
        });
        // The packer's counts by type (bottom bar, player status) against the page's own pass over the same columns.
        const sums = await page.evaluate(async () => {
            const v0 = _ipkSum.version, t0 = performance.now();
            while (_ipkSum.version === v0 && performance.now() - t0 < 2000) await new Promise(r => setTimeout(r, 10));
            const me = localPlayerId, U = infoPackUnitSummary(me), B = infoPackBuildingSummary(me);
            if (!U || !B) return { error: 'no packer counts' };
            const F = simClientCurrentUnitVis(), T = _pageTables.s;
            let units = 0, unitsP = 0, structs = 0, structsP = 0, typesOk = true;
            for (let s = 0; s < F.x.length; s++) if (F.id[s] >= 0 && F.owner[s] === me && F.energy[s] > 0) units++;
            for (const g of U.values()) unitsP += g.total;
            for (let s = 0; s < Math.min(T.n, T.cap); s++) if (T.alive[s] === 1 && T.kind[s] <= 3 && T.owner[s] === me && (T.energy[s] > 0 || (T.flags[s] & 1))) structs++;
            structsP = B.total;
            for (const [k, g] of U) if (!BASE_UNIT_STATS[k] || g.idle > g.total) typesOk = false;
            return { units, unitsP, structs, structsP, typesOk, groups: B.groups.size };
        });
        check(`packer counts by type ${JSON.stringify(sums)}`, () => {
            assert.ok(!sums.error, sums.error); assert.ok(sums.typesOk, 'unit types known, idle <= total');
            assert.ok(Math.abs(sums.units - sums.unitsP) <= Math.max(3, sums.units * 0.03), 'units counted');
            assert.ok(Math.abs(sums.structs - sums.structsP) <= Math.max(3, sums.structs * 0.03), 'structures counted');
        });
        check(`no page errors ${JSON.stringify(errors.slice(0, 3))}`, () => assert.equal(errors.length, 0));
        const done = await Promise.all(results);
        const failed = done.filter(ok => !ok).length;
        console.log(failed ? `${failed} of ${done.length} failed` : `all ${done.length} passed`);
        process.exitCode = failed ? 1 : 0;
    } finally { if (browser) await browser.close(); server.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
