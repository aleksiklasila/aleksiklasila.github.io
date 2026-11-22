'use strict';
// Player actions in a real multiplayer match (Edge tabs, simulation workers,
// the real GUI; the network tests/browser-fake-peer.js with a one-way delay):
// each action is done with the mouse on each player in turn, and checked for
// what the player sees (the control follows at once and stays) and what the
// match does (every peer applies it, the same).
//   node tests/browser-mp-actions.cjs [fixture] [--delay=40] [--only=research] [--headed]
// Writes tests/browser-mp-actions-results.json.
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const fixture = args.find(a => !a.startsWith('--')) || '10000-160.json';
const opt = k => { const a = args.find(x => x.startsWith('--' + k + '=')); return a ? a.slice(k.length + 3) : null; };
const DELAY = Number(opt('delay') ?? 40), ONLY = opt('only'), HEADED = args.includes('--headed') || process.env.HEADED === '1';

const server = http.createServer((req, res) => {
    const file = path.resolve(root, '.' + decodeURIComponent(new URL(req.url, 'http://localhost').pathname));
    if (!file.startsWith(root + path.sep)) return res.writeHead(403).end();
    fs.readFile(file, (error, data) => {
        if (error) return res.writeHead(404).end();
        res.writeHead(200, { 'Content-Type': ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.wasm': 'application/wasm' })[path.extname(file)] || 'application/octet-stream',
            'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' }).end(data);
    });
});

const results = [];
const fail = (name, page, msg, extra) => { results.push({ name, page, ok: false, msg, ...extra }); console.log('FAIL', name, page, msg, extra ? JSON.stringify(extra).slice(0, 600) : ''); };
const pass = (name, page, extra) => { results.push({ name, page, ok: true, ...extra }); console.log('ok  ', name, page, extra ? JSON.stringify(extra).slice(0, 300) : ''); };

(async () => {
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const browser = await chromium.launch({ channel: 'msedge', headless: !HEADED, args: ['--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'] });
    const context = await browser.newContext({ viewport: { width: 1400, height: 860 } });
    await context.addInitScript(`window.__fakePeerDelayMs = ${DELAY};`);
    await context.addInitScript({ path: path.join(__dirname, 'browser-fake-peer.js') });
    const pages = [], errors = [];
    const open = async (name, url) => {
        const page = await context.newPage();
        page.on('pageerror', e => errors.push(name + ': ' + e.message.slice(0, 300)));
        page.on('console', m => { if (m.type() === 'error' && !/favicon|404/.test(m.text())) errors.push(name + ' console: ' + m.text().slice(0, 300)); });
        page.on('dialog', d => d.dismiss().catch(() => { }));
        await page.goto(url);
        page.__name = name;
        pages.push(page);
        return page;
    };
    const host = await open('host', base + '/index.html');
    await host.evaluate(async fixture => {
        const data = await (await fetch('tests/' + fixture)).json();
        applyMainMenuSettingsSnapshot(data);
        loadOrCreateLocalIdentity(); hostOnlineGame();
    }, fixture);
    await host.waitForFunction(() => !!myPeerId, {}, { timeout: 20000 });
    const hostId = await host.evaluate(() => myPeerId);
    const guest = await open('guest', `${base}/index.html?game=${hostId}&room=${hostId}`);
    await guest.evaluate(hostId => { loadOrCreateLocalIdentity(); joinGame(hostId); }, hostId);
    await host.waitForFunction(() => lobbyPlayers.length >= 2 && connections.length >= 1, {}, { timeout: 30000 });
    for (let i = 0; i < pages.length; i++) {
        await pages[i].evaluate(i => {
            const me = lobbyPlayers.find(p => p.peerId === myPeerId);
            if (!me) return;
            me.color = TEAM_PRESET_COLORS[i];
            if (isHost) broadcastLobbyState(true); else connections[0].send({ type: 'LOBBY_UPDATE_SELF', name: me.name, color: me.color });
        }, i);
    }
    await host.waitForTimeout(1500);
    await host.evaluate(() => startHostedGame());
    for (const p of pages) await p.waitForFunction(() => gameStarted && !matchStartWaitingForReady && currentTick > 30, {}, { timeout: 180000 });
    console.log('match running', JSON.stringify(await Promise.all(pages.map(p => p.evaluate(() => ({ me: localPlayerId, tick: currentTick, mp: isMultiplayer, host: isHost, worker: typeof _simClient !== 'undefined' && !!_simClient }))))));

    const other = p => pages.find(x => x !== p);
    const both = (fn, arg) => Promise.all(pages.map(p => p.evaluate(fn, arg)));
    // A peer's view of player `owner`'s research depth for a stat.
    const depthOn = (p, owner, s) => p.evaluate(([o, s]) => ({ tick: currentTick, depth: getResearchQueuedDepthForPlayer(o, s.kind, s.key, s.statKey), level: getPlayerResearchLevel(o, s.kind, s.key, s.statKey), total: getPlayerResearchQueueTotalLength(o) }), [owner, s]);
    // (How each page holds the research queues: a heap queue (_rq, accessors) or the frames' plain arrays.)
    const rqForm = p => p.evaluate(() => players.map((q, i) => { const d = q && Object.getOwnPropertyDescriptor(q, 'researchQueue'); return { i, rq: !!(q && q._rq), accessor: !!(d && d.get), len: q && Array.isArray(q.researchQueue) ? q.researchQueue.length : -1, task: !!(q && q.researchTask) }; }));
    console.log('queue forms', JSON.stringify(await Promise.all(pages.map(rqForm))));

    // ---- research: the info panel's stat slider ----
    const researchSlider = async page => {
        const name = 'research-slider';
        const me = await page.evaluate(() => localPlayerId);
        const lab = await page.evaluate(() => {
            const r = collectorSpawners.find(s => s && s.type === 'research' && s.owner === localPlayerId && s.energy > 0 && !s.underConstruction);
            if (!r) return null;
            selectedUnits = []; selectedEntities = [r]; activeSubGroups = {};
            updateInfoPanel();
            return { gx: r.gx, gy: r.gy };
        });
        if (!lab) return fail(name, page.__name, 'no research lab of this player');
        await page.waitForTimeout(300);
        // The first visible thing button, pressed if it is not picked.
        const thing = page.locator('.info-research-thing-btn:visible').first();
        if (!(await thing.count())) return fail(name, page.__name, 'no thing buttons');
        if (!(await thing.evaluate(b => b.classList.contains('info-thing-btn-selected')))) await thing.click();
        await page.waitForTimeout(300);
        const row = page.locator('.ipr-stat:visible').first();
        const slider = row.locator('input.count-slider');
        const spec = JSON.parse(await slider.getAttribute('data-count-spec'));
        const stat = spec.stats[0];
        const before = await depthOn(page, me, stat);
        const v0 = Number(await slider.inputValue());
        const target = Math.min(10, v0 + 3);
        const box = await slider.boundingBox();
        const x = box.x + 2 + (box.width - 4) * target / 10, y = box.y + box.height / 2;
        const t0 = Date.now();
        await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.up();
        // Sampled: what the slider shows, the page's depth, the other peer's.
        const trace = [];
        for (let i = 0; i < 40; i++) {
            const s = await slider.evaluate(i => ({ v: Number(i.value), attr: Number(i.getAttribute('value')), out: i.parentElement.querySelector('output').textContent, dis: i.disabled }));
            const d = await depthOn(page, me, stat), o = await depthOn(other(page), me, stat);
            trace.push({ ms: Date.now() - t0, ...s, d: d.level + d.depth, dt: d.tick, od: o.level + o.depth, ot: o.tick });
            await page.waitForTimeout(100);
        }
        const want = target;
        const end = trace[trace.length - 1];
        const shownWrong = trace.filter(t => t.v !== target);
        const extra = { stat: stat.kind + ':' + stat.key + ':' + stat.statKey, before, target, want, end, firstSamples: trace.slice(0, 6), wrong: shownWrong.length };
        if (end.d !== want || end.od !== want) return fail(name, page.__name, `level+queued here ${end.d} there ${end.od}, want ${want}`, { ...extra, trace });
        if (shownWrong.length) return fail(name, page.__name, `slider not at ${target} in ${shownWrong.length}/${trace.length} samples`, { ...extra, trace });
        pass(name, page.__name, extra);
    };

    if (ONLY === 'explore') {
        console.log(JSON.stringify(await host.evaluate(() => {
            const all = [...barracks, ...collectorSpawners, ...towers].filter(e => e && e.owner === localPlayerId);
            const types = {};
            for (const e of all) { const t = e.type || e.constructor.name; if (!types[t]) types[t] = { n: 0, keys: Object.keys(e).filter(k => typeof e[k] !== 'function' && typeof e[k] !== 'object').slice(0, 80) }; types[t].n++; }
            const u = units.find(u => u && u.owner === localPlayerId && !u.dead && !u.workerType);
            return { types, unitKeys: u ? Object.keys(u).slice(0, 80) : null, nUnits: units.length };
        }), null, 0));
    }
    for (const page of pages) {
        if (!ONLY || ONLY === 'research') await researchSlider(page);
    }

    // ---- every info panel control of every kind of own structure ----
    // The commands a page gives, recorded (queueAction wrapped).
    for (const p of pages) await p.evaluate(() => {
        if (window.__acts) return;
        window.__acts = [];
        const q = queueAction;
        queueAction = function (a) { try { window.__acts.push(JSON.parse(JSON.stringify(a, (k, v) => typeof v === 'string' && v.length > 200 ? v.slice(0, 200) : v))); } catch { } return q.apply(this, arguments); };
    });
    // What a command can change, as the page shows it: a structure's flags,
    // levels, queue, rally; its owner's research queue, levels and boosts.
    const digestFn = ([gx, gy, owner, ids]) => {
        if (ids) {
            const byId = new Map(); for (const u of units) if (u && !u.dead && ids.includes(u.id)) byId.set(u.id, u);
            const s = ids.map(id => { const u = byId.get(id); return u ? (u.holdPosition ? 'H' : 'h') + (u.commandState | 0) : 'x'; }).join('');
            const tick = typeof _simClient !== 'undefined' && _simClient && Number.isFinite(_simClient.appliedTick) ? _simClient.appliedTick : currentTick;
            return { tick, s, rq: '', rqn: 0, lv: 0, boosts: '', drain: 0 };
        }
        const e = typeof getTileEntityRef === 'function' ? getTileEntityRef(gx, gy) : null;
        const s = e ? ['type', 'level', 'stacks', 'manualStacks', 'markedForSalvage', 'autoUpgradeEnabled', 'autoStackEnabled', 'buildEnabled', 'queueEnabled', 'autoResearchEnabled', 'rallyX', 'rallyY', 'underConstruction']
            .map(k => k + '=' + (typeof e[k] === 'number' ? Math.round(e[k] * 100) / 100 : e[k])).join(',') + ',q=' + (e.spawnQueue ? e.spawnQueue.length : '-') : 'none';
        const p = players[owner];
        const rq = [getPlayerResearchTask(owner), ...getPlayerResearchQueue(owner)].filter(Boolean).map(t => t.key + '.' + t.statKey).join('|');
        const tick = typeof _simClient !== 'undefined' && _simClient && Number.isFinite(_simClient.appliedTick) ? _simClient.appliedTick : currentTick;
        return { tick, s, rq, rqn: getPlayerResearchQueueTotalLength(owner), lv: JSON.stringify(p && p.researchLevels || {}).length, boosts: JSON.stringify(p && p.boosts || {}), drain: p && p.shrineDrain };
    };
    // Both pages' digests at one tick (polled until their ticks meet).
    // (Each page sampled on its own, until a tick both sampled: the pages
    // apply their frames apart, a pair taken together was a tick off.)
    const digestBoth = async (gx, gy, owner, ids = null) => {
        const seen = pages.map(() => new Map());
        let found = null;
        const t0 = Date.now();
        await Promise.all(pages.map(async (p, k) => {
            while (!found && Date.now() - t0 < 3000) {
                const d = await p.evaluate(digestFn, [gx, gy, owner, ids]);
                seen[k].set(d.tick, d);
                const other = seen[1 - k].get(d.tick);
                if (other && !found) found = k === 0 ? [d, other] : [other, d];
                await p.waitForTimeout(3);
            }
        }));
        return found || [[...seen[0].values()].pop(), [...seen[1].values()].pop()];
    };
    const SKIPC = /resign|leave|quit|surrender|forfeit|kill|delete|destroy|menu|fullscreen|spectat|exit|disconnect|salvage|sell|info-stat-matrix-btn|info-subgroup-research-btn|help/i;
    const panelControls = page => page.evaluate(SKIPSRC => {
        const skip = new RegExp(SKIPSRC, 'i'), out = [];
        const vis = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && !el.disabled && getComputedStyle(el).visibility !== 'hidden'; };
        document.querySelectorAll('#info-panel button, #info-panel input, #info-panel select, #info-panel [data-b], #info-panel .info-research-queue-toggle').forEach((el, i) => {
            if (!vis(el)) return;
            const label = ((el.dataset.b ? 'pill:' + el.dataset.b + ' ' : '') + (el.className || '') + ' ' + (el.textContent || '').trim().slice(0, 30) + ' ' + (el.title || '') + ' ' + (el.getAttribute('aria-label') || '')).replace(/\s+/g, ' ').trim();
            if (skip.test(label)) return;
            if (!el.dataset.mpa) el.dataset.mpa = 'c' + i + '_' + Math.random().toString(36).slice(2, 6);
            out.push({ sel: `[data-mpa="${el.dataset.mpa}"]`, label, tag: el.tagName.toLowerCase(), type: el.type || '', spec: el.dataset.countSpec ? JSON.parse(el.dataset.countSpec).type : '' });
        });
        return out;
    }, SKIPC.source);
    const controlState = (page, sel) => page.evaluate(sel => {
        const el = document.querySelector(sel);
        if (!el) return null;
        if (el.type === 'range') return 'v=' + el.value + ' out=' + (el.parentElement.querySelector('output') || {}).textContent;
        if (el.type === 'checkbox') return 'c=' + el.checked;
        return (el.className || '') + '|' + (el.textContent || '').trim().slice(0, 40) + '|' + (el.getAttribute('aria-pressed') || '') + '|' + (el.title || '').slice(0, 60);
    }, sel);

    const selectPick = pick => {
        if (pick.kind === 'units') { const set = new Set(pick.ids), us = units.filter(u => u && !u.dead && set.has(u.id)); if (selectedUnits.length !== us.length || selectedEntities.length || selectedUnits.some((u, i) => u !== us[i])) { selectedEntities = []; selectedUnits = us; activeSubGroups = {}; updateInfoPanel(); } return; }
        const e = getTileEntityRef(pick.gx, pick.gy); if (selectedEntities[0] !== e || selectedUnits.length) { selectedUnits = []; selectedEntities = [e]; activeSubGroups = {}; updateInfoPanel(); }
    };
    const sweep = async page => {
        const me = await page.evaluate(() => localPlayerId);
        const picks = await page.evaluate(() => {
            const seen = new Map();
            for (const e of [...collectorSpawners, ...barracks, ...towers]) {
                if (!e || e.owner !== localPlayerId || e.underConstruction || !(e.energy > 0)) continue;
                const t = e.type; if (!seen.has(t)) seen.set(t, { type: t, gx: e.gx, gy: e.gy });
            }
            const out = [...seen.values()].map(x => ({ kind: 'struct', ...x }));
            const ut = new Map();
            for (const u of units) if (u && !u.dead && u.owner === localPlayerId && !u.workerType && !u.isKing) { const l = ut.get(u.unitType) || []; if (l.length < 12) l.push(u.id); ut.set(u.unitType, l); }
            for (const [t, ids] of ut) out.push({ kind: 'units', type: t, ids, gx: -1, gy: -1 });
            return out;
        });
        for (const pick of picks) {
            await page.evaluate(selectPick, pick);
            await page.waitForTimeout(350);
            const controls = await panelControls(page);
            for (const c of controls) {
                const name = `panel:${pick.type}:${c.label.slice(0, 50)}`;
                const el = page.locator(c.sel);
                // (One structure: the same selection again (Escape after each control let it go), the panel as it was.)
                await page.evaluate(selectPick, pick);
                await page.waitForTimeout(120);
                if (!(await el.count()) || !(await el.isVisible().catch(() => false))) { results.push({ name, page: page.__name, ok: true, skipped: 'not shown' }); continue; }
                const before = await digestBoth(pick.gx, pick.gy, me, pick.ids || null);
                await page.evaluate(() => { window.__acts.length = 0; });
                let clickedValue = null;
                try {
                    if (c.type === 'range') {
                        const v0 = Number(await el.inputValue()), max = Number(await el.getAttribute('max')), min = Number(await el.getAttribute('min'));
                        const floor = Number(await el.getAttribute('data-floor')) || min;
                        clickedValue = v0 + 2 <= max ? v0 + 2 : Math.max(floor, v0 - 2);
                        if (clickedValue === v0) continue;
                        const box = await el.boundingBox();
                        await page.mouse.click(box.x + 2 + (box.width - 4) * (clickedValue - min) / Math.max(1, max - min), box.y + box.height / 2);
                    } else if (c.tag === 'select') {
                        continue; // (Selects: local view settings here.)
                    } else await el.click({ timeout: 1000 });
                } catch (e) { fail(name, page.__name, 'could not operate: ' + String(e.message).slice(0, 120)); continue; }
                const s1 = await controlState(page, c.sel);
                await page.waitForTimeout(150);
                const acts = await page.evaluate(() => window.__acts.slice());
                const samples = [];
                for (const ms of [150, 450, 900, 1500]) { await page.waitForTimeout(ms - (samples.length ? [150, 450, 900, 1500][samples.length - 1] : 0)); samples.push(await controlState(page, c.sel)); }
                const after = await digestBoth(pick.gx, pick.gy, me, pick.ids || null);
                await page.keyboard.press('Escape');
                const info = { acts: acts.map(a => a.action), clicked: clickedValue, s1, samples, before: before[0], after: after.map(d => ({ tick: d.tick, s: d.s, rq: d.rq.slice(0, 120), rqn: d.rqn, boosts: d.boosts, drain: d.drain })) };
                const pagesAgree = after[0].tick === after[1].tick && JSON.stringify({ ...after[0], tick: 0, lv: 0 }) === JSON.stringify({ ...after[1], tick: 0, lv: 0 });
                if (!pagesAgree) { fail(name, page.__name, 'host and guest pages show different state', info); continue; }
                if (!acts.length) { results.push({ name, page: page.__name, ok: true, local: true }); continue; }
                const changed = JSON.stringify({ ...before[0], tick: 0, lv: 0 }) !== JSON.stringify({ ...after[0], tick: 0, lv: 0 });
                if (c.type === 'range') {
                    const want = 'v=' + clickedValue;
                    const bad = [s1, ...samples].filter(s => !s || !s.startsWith(want + ' '));
                    if (bad.length) { fail(name, page.__name, `slider did not stay at ${clickedValue}`, info); continue; }
                } else {
                    // (A toggle's look right after the press stays: it did not flip back.)
                    // (Its look at the press is what it keeps: no late change, no flip back.)
                    if (samples.some(s => s !== s1)) { fail(name, page.__name, 'control look changed after the press', info); continue; }
                }
                if (!changed) { fail(name, page.__name, 'command given, nothing changed on either page', info); continue; }
                pass(name, page.__name, { acts: info.acts });
            }
        }
    };
    if (!ONLY || ONLY === 'sweep') for (const page of pages) await sweep(page);
    if (ONLY === 'rally2') for (const page of pages) {
        const b = await page.evaluate(() => { const b = barracks.find(b => b && b.owner === localPlayerId && !b.underConstruction); return { gx: b.gx, gy: b.gy }; });
        const look = () => both(([gx, gy]) => { const e = getTileEntityRef(gx, gy); return e ? [currentTick, e.rallyX, e.rallyY, e.spawnQueue.length, e.queueEnabled, e._s, e.constructor.name] : null; }, [b.gx, b.gy]);
        console.log(page.__name, 'start', JSON.stringify(await look()));
        await page.evaluate(({ gx, gy }) => queueAction({ action: 'spawnCounts', worker: false, tkz: actionIdsEncode([gy * GRID_W + gx]), counts: [3] }), b);
        await page.waitForTimeout(1500);
        console.log(page.__name, 'queued', JSON.stringify(await look()));
        for (const [dx, dy] of [[3, 2], [-4, 1]]) {
            await page.evaluate(({ gx, gy, dx, dy }) => queueAction({ action: 'setRally', gx, gy, targetX: (gx + dx) * TILE + 16, targetY: (gy + dy) * TILE + 16 }), { ...b, dx, dy });
            await page.waitForTimeout(1500);
            console.log(page.__name, 'rally', dx, dy, JSON.stringify(await look()));
        }
    }
    // ---- what the HUD reads, per player, on both pages at one tick: the same (the host page made the world before its worker took over) ----
    const hudState = () => {
        const tick = typeof _simClient !== 'undefined' && _simClient && Number.isFinite(_simClient.appliedTick) ? _simClient.appliedTick : currentTick;
        const r = { tick, p: [] }, f = (fn, ...a) => { try { return typeof globalThis[fn] === 'function' ? globalThis[fn](...a) : '-'; } catch (e) { return 'ERR ' + String(e).slice(0, 60); } };
        const stats = RESEARCH_THINGS.slice(0, 12).flatMap(t => (t.stats || []).slice(0, 2).map(s => [t.kind, t.key, s.statKey]));
        for (let o = 0; o < players.length; o++) {
            const p = players[o] || {};
            const up = f('getPlayerUpKeepBreakdown', o);
            const uc = {}, sc = {};
            for (const u of units) if (u && !u.dead && u.owner === o) uc[u.unitType] = (uc[u.unitType] || 0) + 1;
            for (const e of [...towers, ...barracks, ...collectorSpawners]) if (e && !e.dead && e.owner === o) { const k = e.type + (e.underConstruction ? '~' : ''); sc[k] = (sc[k] || 0) + 1; }
            r.p.push({ o, energy: Math.round(Number(p.energy) || 0), astar: Math.round(Number(p.astar) || 0), rqn: f('getPlayerResearchQueueTotalLength', o), cap: f('getResearchQueueCapacityForPlayer', o),
                lv: stats.map(s => f('getPlayerResearchLevel', o, ...s) + '/' + f('getResearchQueuedDepthForPlayer', o, ...s)).join(','),
                boosts: JSON.stringify(p.boosts || {}), drain: f('getPlayerShrineDrainMode', o), up: up && typeof up === 'object' ? Math.round((Number(up.total) || 0) * 100) : up,
                labs: f('getOwnedActiveResearchLabs', o) && f('getOwnedActiveResearchLabs', o).length, uc: JSON.stringify(uc), sc: JSON.stringify(sc) });
        }
        return r;
    };
    const hudCompare = async label => {
        const seen = pages.map(() => new Map()); let found = null; const t0 = Date.now();
        await Promise.all(pages.map(async (p, k) => { while (!found && Date.now() - t0 < 5000) { const d = await p.evaluate(hudState); seen[k].set(d.tick, d); const o = seen[1 - k].get(d.tick); if (o && !found) found = k === 0 ? [d, o] : [o, d]; await p.waitForTimeout(5); } }));
        if (!found) return fail('hud-state ' + label, 'both', 'no common tick');
        const diff = [];
        for (let o = 0; o < found[0].p.length; o++) for (const k in found[0].p[o]) if (JSON.stringify(found[0].p[o][k]) !== JSON.stringify(found[1].p[o][k])) diff.push({ o, k, host: String(found[0].p[o][k]).slice(0, 200), guest: String(found[1].p[o][k]).slice(0, 200) });
        if (diff.length) fail('hud-state ' + label, 'both', 'pages differ at tick ' + found[0].tick, { diff: diff.slice(0, 8) });
        else pass('hud-state ' + label, 'both', { tick: found[0].tick });
    };
    if (!ONLY || ONLY === 'hud') await hudCompare(ONLY === 'hud' ? 'start' : 'end');
    if (ONLY === 'hud') { await host.waitForTimeout(20000); await hudCompare('later'); }
    if (ONLY === 'inv') console.log('inv', JSON.stringify(await host.evaluate(() => {
        const types = {}; for (const u of units) if (u && !u.dead) { const k = u.owner + ':' + u.unitType + ':' + (u.workerType || ''); types[k] = (types[k] || 0) + 1; }
        const vis = goldMines.filter(m => m && isTileActuallyVisibleToPlayer(localPlayerId, m.gx, m.gy)).length;
        const base = o => { const k = units.find(u => u && u.isKing && u.owner === o); return k ? [Math.round(k.x / TILE), Math.round(k.y / TILE)] : null; };
        return { types, goldMines: goldMines.length, visibleMines: vis, kings: [base(0), base(1)], grid: [GRID_W, GRID_H] };
    })));
    if (ONLY === 'cloudpill') {
        console.log(JSON.stringify(await host.evaluate(() => new Promise(r => {
            const c = towers.find(t => t && t.owner === localPlayerId && t.type === 'cloud_0a');
            selectedUnits = []; selectedEntities = [c]; updateInfoPanel();
            setTimeout(() => {
                const p = [...document.querySelectorAll('#info-panel [data-b="stack"]')].find(e => e.offsetParent);
                const ref = p && p.dataset.coords;
                r({ cloud: [c.gx, c.gy, c.type, getEntityGroupKey(c)], ref, coords: ref ? infoCoordText(ref) : null, sel: selectedEntities.length, members: selectedEntities.map(e => getEntityGroupKey(e)) });
            }, 500);
        }))));
    }
    if (ONLY === 'pills') {
        console.log(JSON.stringify(await host.evaluate(() => {
            const b = barracks.find(b => b && b.owner === localPlayerId && !b.underConstruction);
            selectedUnits = []; selectedEntities = [b]; updateInfoPanel();
            return new Promise(r => setTimeout(() => r([...document.querySelectorAll('#info-panel [data-b]')].map(el => { const rc = el.getBoundingClientRect(); return [el.dataset.b, el.className, el.textContent, el.hidden, rc.width, rc.height, el.closest('[hidden]') ? el.closest('[hidden]').className.slice(0, 40) : '', getComputedStyle(el).visibility]; }).filter(x => !x[3] || x[0] === 'queue')), 500));
        }), null, 0));
    }
    if (ONLY === 'pilltrace') for (const page of [host]) {
        for (const what of ['hold', 'stack']) {
            await page.evaluate(what => {
                if (what === 'hold') { const us = units.filter(u => u && !u.dead && u.owner === localPlayerId && !u.workerType && !u.isKing).slice(0, 8); selectedEntities = []; selectedUnits = us; }
                else { const e = towers.find(t => t && t.owner === localPlayerId && !t.underConstruction); selectedUnits = []; selectedEntities = [e]; }
                updateInfoPanel();
            }, what);
            await page.waitForTimeout(400);
            const pill = page.locator(`#info-panel [data-b="${what}"]:visible`).first();
            await page.evaluate(what => {
                const el = [...document.querySelectorAll(`#info-panel [data-b="${what}"]`)].find(e => e.offsetParent);
                const T = window.__pt = []; const t0 = performance.now();
                const orig = window.updateInfoPanel;
                const snap = tag => T.push([Math.round(performance.now() - t0), tag, el.textContent, el.dataset.enabled || el.dataset.hold, JSON.stringify([..._infoToggleShown.entries()]).slice(0, 160), currentTick]);
                const iv = setInterval(() => snap('iv'), 10);
                el.addEventListener('mousedown', () => snap('down'), true);
                if (!window.__itpWrapped) {
                    window.__itpWrapped = true;
                    const f = window.infoTogglePressed;
                    window.infoTogglePressed = function (e) {
                        let r, err = null; const pre = JSON.stringify(Object.assign({}, e.dataset)) + ' map=' + _infoToggleShown.size;
                        try { r = f.apply(this, arguments); } catch (x) { err = String(x); }
                        window.__pt && window.__pt.push([0, 'itp ' + pre + ' ' + new Error().stack.split(String.fromCharCode(10)).slice(2, 5).join(' / '), e.className, JSON.stringify(Object.assign({}, e.dataset)), err, JSON.stringify([..._infoToggleShown.entries()]).slice(0, 200)]);
                        return r;
                    };
                }
                setTimeout(() => clearInterval(iv), 1500);
            }, what);
            await page.evaluate(() => { window.__acts.length = 0; });
            await pill.click();
            await page.waitForTimeout(1600);
            console.log('acts', JSON.stringify(await page.evaluate(() => window.__acts.map(a => [a.action, a.toggle, a.enabled, a.unitIds && a.unitIds.length]))));
            const T = await page.evaluate(() => window.__pt);
            let last = '';
            console.log('--', what);
            for (const r of T) { const k = r.slice(1, 5).join(' '); if (k !== last || String(r[1]).startsWith('itp')) { console.log(JSON.stringify(r)); last = k; } }
        }
    }

    // ---- map actions: rally, move, hold/stop keys, building placement ----
    // (2D view, the camera on a world point: its screen point.)
    const screenAt = (page, wx, wy) => page.evaluate(([wx, wy]) => {
        if (typeof setRenderDimensionMode === 'function' && renderDimensionMode !== '2d') setRenderDimensionMode('2d');
        camera.zoom = 1; camera.x = wx - viewW / 2; camera.y = wy - viewH / 2; if (typeof clampCamera === 'function') clampCamera();
        const r = document.getElementById('game-area').getBoundingClientRect();
        return { x: (wx - camera.x) * camera.zoom + r.left, y: (wy - camera.y) * camera.zoom + r.top };
    }, [wx, wy]);
    const mapActions = async page => {
        const me = await page.evaluate(() => localPlayerId);
        await page.keyboard.press('Escape');
        // A free, visible tile near this player's lab: the target of everything.
        const spot = await page.evaluate(() => {
            const lab = collectorSpawners.find(s => s && s.owner === localPlayerId && s.type === 'research');
            for (let r = 3; r < 14; r++) for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
                const gx = lab.gx + dx, gy = lab.gy + dy;
                if (gx < 1 || gy < 1 || gx >= GRID_W - 1 || gy >= GRID_H - 1) continue;
                if (canBuildAt(gx, gy, localPlayerId) && isTileActuallyVisibleToPlayer(localPlayerId, gx, gy) && !getTileEntityRef(gx, gy)) return { gx, gy, x: gx * TILE + TILE / 2, y: gy * TILE + TILE / 2 };
            }
            return null;
        });
        if (!spot) return fail('map', page.__name, 'no free tile near the lab');
        // Rally: a barrack selected, right click on the ground.
        {
            const b = await page.evaluate(() => { const b = barracks.find(b => b && b.owner === localPlayerId && !b.underConstruction); if (!b) return null; selectedUnits = []; selectedEntities = [b]; updateInfoPanel(); return { gx: b.gx, gy: b.gy }; });
            if (!b) fail('rally', page.__name, 'no barrack');
            else {
                const s = await screenAt(page, spot.x, spot.y);
                await page.mouse.click(s.x, s.y, { button: 'right' });
                await page.waitForTimeout(1500);
                const r = await both(([gx, gy]) => { const e = getTileEntityRef(gx, gy); return e ? [e.rallyX, e.rallyY] : null; }, [b.gx, b.gy]);
                const near = v => v && Math.abs(v[0] - spot.x) <= 40 && Math.abs(v[1] - spot.y) <= 40;
                if (!near(r[0]) || !near(r[1])) fail('rally', page.__name, 'rally not at the click', { spot, host: r[0], guest: r[1] });
                else pass('rally', page.__name, { rally: r[0] });
            }
        }
        // Move: a group of own fighters, right click on the ground; then hold (c) and stop (x).
        {
            const ids = await page.evaluate(() => { const ok = u => u && !u.dead && u.owner === localPlayerId && !u.workerType && !u.isKing; let us = units.filter(u => ok(u) && (u.unitType === 'norm' || u.unitType === 'fast') && !u.targetUnit).slice(0, 8); if (us.length < 4) us = units.filter(ok).slice(0, 8); selectedEntities = []; selectedUnits = us; updateInfoPanel(); return us.map(u => u.id); });
            if (!ids.length) fail('move', page.__name, 'no units');
            else {
                const dist = () => both(([ids, x, y]) => { const set = new Set(ids); let d = 0, n = 0; for (const u of units) if (u && !u.dead && set.has(u.id)) { d += Math.hypot(u.x - x, u.y - y); n++; } return n ? d / n : -1; }, [ids, spot.x, spot.y]);
                const hold = () => both(ids => { const set = new Set(ids); let h = 0; for (const u of units) if (u && !u.dead && set.has(u.id) && u.holdPosition) h++; return h; }, ids);
                const s = await screenAt(page, spot.x, spot.y);
                await page.mouse.move(s.x, s.y);
                // (Free first: earlier stages may have left them held.)
                await page.keyboard.press('x');
                await page.waitForTimeout(1200);
                const d0 = await dist();
                await page.mouse.click(s.x, s.y, { button: 'right' });
                await page.waitForTimeout(4000);
                const d1 = await dist();
                if (!(d1[0] < d0[0] - 20 && d1[1] < d0[1] - 20)) fail('move', page.__name, 'units did not go to the click', { d0, d1 });
                else pass('move', page.__name, { d0, d1 });
                // Held, a move order waits (hold only stops moving); released, they go.
                const far = await page.evaluate(([x, y]) => ({ x: Math.max(TILE, Math.min(GRID_W * TILE - TILE, x + 6 * TILE)), y }), [spot.x, spot.y]);
                const distTo = p => both(([ids, x, y]) => { const set = new Set(ids); let d = 0, n = 0; for (const u of units) if (u && !u.dead && set.has(u.id)) { d += Math.hypot(u.x - x, u.y - y); n++; } return n ? d / n : -1; }, [ids, p.x, p.y]);
                await page.keyboard.press('c');
                await page.waitForTimeout(1200);
                const sf = await screenAt(page, far.x, far.y);
                const e0 = await distTo(far);
                await page.mouse.click(sf.x, sf.y, { button: 'right' });
                await page.waitForTimeout(1500);
                const e1 = await distTo(far);
                await page.mouse.move(sf.x, sf.y);
                await page.keyboard.press('x');
                await page.waitForTimeout(2500);
                const e2 = await distTo(far);
                if (Math.abs(e1[0] - e0[0]) > 8 || Math.abs(e1[1] - e0[1]) > 8) fail('move while held', page.__name, 'held units moved', { e0, e1 });
                else if (!(e2[0] < e1[0] - 20 && e2[1] < e1[1] - 20)) fail('move while held', page.__name, 'released units did not take the waiting order', { e0, e1, e2 });
                else pass('move while held', page.__name, { e0, e1, e2 });
                await page.evaluate(ids => { const set = new Set(ids); selectedEntities = []; selectedUnits = units.filter(u => u && !u.dead && set.has(u.id)); }, ids);
                await page.mouse.move(s.x, s.y);
                await page.keyboard.press('c');
                await page.waitForTimeout(1200);
                const h1 = await hold();
                await page.keyboard.press('x');
                await page.waitForTimeout(1200);
                const h2 = await hold();
                if (!(h1[0] > 0 && h1[0] === h1[1])) fail('hold key', page.__name, 'hold not on both', { h1 }); else pass('hold key', page.__name, { h1 });
                if (!(h2[0] === 0 && h2[1] === 0)) fail('stop key', page.__name, 'still held after stop', { h2 }); else pass('stop key', page.__name, { h2 });
            }
        }
        // Place: a tower from the shop, a click on the free tile.
        {
            await page.keyboard.press('Escape');
            await page.evaluate(() => { selectedUnits = []; selectedEntities = []; updateInfoPanel(); });
            const key = 'pistol';
            await page.locator('.build-tab[data-tab="towers"]').click().catch(() => { });
            await page.waitForTimeout(200);
            const item = page.locator(`#build-items [data-key="${key}"]`).first();
            if (!(await item.count()) || !(await item.isVisible().catch(() => false))) { fail('place', page.__name, 'shop item not visible'); }
            else {
                await item.click();
                const sel = await page.evaluate(() => selectedBuildItem);
                const s = await screenAt(page, spot.x, spot.y);
                await page.mouse.click(s.x, s.y);
                await page.waitForTimeout(2000);
                const r = await both(([gx, gy]) => { const e = getTileEntityRef(gx, gy); return e ? e.type + (e.underConstruction ? '(uc)' : '') : null; }, [spot.gx, spot.gy]);
                if (r[0] !== r[1] || !r[0] || !r[0].startsWith(key)) fail('place', page.__name, 'building not on both', { sel, r, spot });
                else pass('place', page.__name, { r });
                await page.keyboard.press('Escape');
            }
        }
    };
    if (!ONLY || ONLY === 'map') for (const page of pages) await mapActions(page);

    // ---- the bottom bar: a thing dropped on the research row, a task dragged to the front ----
    const queueSig = (p, owner) => p.evaluate(o => ({ tick: typeof _simClient !== 'undefined' && _simClient ? _simClient.appliedTick : currentTick, q: [getPlayerResearchTask(o), ...getPlayerResearchQueue(o)].filter(Boolean).map(t => t.kind + ':' + t.key + ':' + t.statKey) }), owner);
    const queueBoth = async owner => {
        const seen = pages.map(() => new Map()); let found = null; const t0 = Date.now();
        await Promise.all(pages.map(async (p, k) => { while (!found && Date.now() - t0 < 3000) { const d = await queueSig(p, owner); seen[k].set(d.tick, d); const o = seen[1 - k].get(d.tick); if (o && !found) found = k === 0 ? [d, o] : [o, d]; await p.waitForTimeout(3); } }));
        return found;
    };
    const drag = async (page, from, to) => {
        await page.mouse.move(from.x, from.y); await page.mouse.down();
        for (let i = 1; i <= 12; i++) { await page.mouse.move(from.x + (to.x - from.x) * i / 12, from.y + (to.y - from.y) * i / 12); await page.waitForTimeout(16); }
        await page.mouse.up();
    };
    const center = async loc => { const b = await loc.boundingBox(); return b ? { x: b.x + b.width / 2, y: b.y + b.height / 2 } : null; };
    const bottomBar = async page => {
        const me = await page.evaluate(() => localPlayerId);
        await page.keyboard.press('Escape');
        // (A few tasks queued first, so there is a place to drop between.)
        const lab = await page.evaluate(() => { const r = collectorSpawners.find(s => s && s.owner === localPlayerId && s.type === 'research' && !s.underConstruction); queueAction({ action: 'queueResearch', gx: r.gx, gy: r.gy, kind: 'building', key: 'pistol', statKey: 'maxEnergy', count: 3 }); return { gx: r.gx, gy: r.gy }; });
        await page.waitForTimeout(1500);
        const q0 = await queueBoth(me);
        // Drop: a thing tile onto the research row.
        const thing = page.locator('#bb-things .bb-thing:not(.bb-unowned)').nth(1);
        const tasks = page.locator('#bb-research .bb-task');
        const nTasks = await tasks.count();
        if (!(await thing.count()) || nTasks < 2) return fail('bb-drop', page.__name, 'no thing tile or tasks', { nTasks });
        const thingId = await thing.getAttribute('data-id');
        const t1 = await center(tasks.nth(1));
        await drag(page, await center(thing.locator('.bb-thing-body img')), t1);
        await page.waitForTimeout(300);
        const menu = await page.evaluate(() => bb.menu ? { type: bb.menu.type, insertAt: bb.menu.insertAt, id: bb.menu.id } : null);
        if (!menu || menu.type !== 'drop') return fail('bb-drop', page.__name, 'drop menu did not open', { menu, thingId });
        const slider = page.locator('.bb-menu input.count-slider').first();
        if (!(await slider.count())) return fail('bb-drop', page.__name, 'no slider in the drop menu', { menu });
        const spec = JSON.parse(await slider.getAttribute('data-count-spec'));
        const stat = spec.stats[0], sid = stat.kind + ':' + stat.key + ':' + stat.statKey;
        const v0 = Number(await slider.inputValue()), target = Math.min(10, v0 + 2);
        const box = await slider.boundingBox();
        await page.mouse.click(box.x + 2 + (box.width - 4) * target / 10, box.y + box.height / 2);
        const shown = [];
        for (let i = 0; i < 8; i++) { await page.waitForTimeout(200); shown.push(await page.locator('.bb-menu input.count-slider').first().inputValue().catch(() => 'gone')); }
        const q1 = await queueBoth(me);
        await page.keyboard.press('Escape');
        const at = q1 && q1[0].q.indexOf(sid);
        const added = q1 ? q1[0].q.filter(x => x === sid).length - q0[0].q.filter(x => x === sid).length : -1;
        const info = { menu, sid, v0, target, shown, q0: q0 && q0[0].q, q1: q1 && q1.map(d => d.q) };
        if (!q1 || JSON.stringify(q1[0].q) !== JSON.stringify(q1[1].q)) fail('bb-drop', page.__name, 'pages show different queues', info);
        else if (added !== target - v0) fail('bb-drop', page.__name, `added ${added}, want ${target - v0}`, info);
        else if (at !== menu.insertAt) fail('bb-drop', page.__name, `inserted at ${at}, want ${menu.insertAt}`, info);
        else if (shown.some(v => v !== String(target))) fail('bb-drop', page.__name, 'drop menu slider did not stay', info);
        else pass('bb-drop', page.__name, { sid, at, added });
        // Reorder: the last task dragged onto the first.
        const n = await tasks.count();
        const last = await page.evaluate(o => { const q = [getPlayerResearchTask(o), ...getPlayerResearchQueue(o)].filter(Boolean); const t = q[q.length - 1]; return t.kind + ':' + t.key + ':' + t.statKey; }, me);
        const qBefore = (await queueSig(page, me)).q;
        await page.evaluate(() => { window.__acts.length = 0; });
        await drag(page, await center(tasks.nth(n - 1)), await center(tasks.nth(0)));
        const dragActs = await page.evaluate(() => window.__acts.map(a => JSON.stringify(a)));
        const look = [];
        for (let i = 0; i < 6; i++) { await page.waitForTimeout(150); look.push(await page.evaluate(() => [...document.querySelectorAll('#bb-research .bb-task')].map(e => e.dataset.index).slice(0, 3).join(','))); }
        const q2 = await queueBoth(me);
        if (!q2 || JSON.stringify(q2[0].q) !== JSON.stringify(q2[1].q)) fail('bb-reorder', page.__name, 'pages show different queues', { q2 });
        else if (q2[0].q[0] !== last) fail('bb-reorder', page.__name, 'the dragged task is not first', { last, qBefore, n, dragActs, q2: q2[0].q, look });
        else pass('bb-reorder', page.__name, { first: q2[0].q[0] });
        // Boost: a slot of a thing tile clicked (energy +2 steps).
        const tile = page.locator('#bb-things .bb-thing:not(.bb-unowned)').first();
        const id = await tile.getAttribute('data-id');
        const slot = tile.locator('[data-bb-boost="energy"][data-step="2"]');
        if (!(await slot.count())) return fail('bb-boost', page.__name, 'no boost slot', { id });
        await slot.click();
        const filled = [];
        for (let i = 0; i < 8; i++) { await page.waitForTimeout(150); filled.push(await page.evaluate(id => { const t = [...document.querySelectorAll('#bb-things .bb-thing')].find(e => e.dataset.id === id); return t ? t.querySelectorAll('[data-bb-boost="energy"].on').length : -1; }, id)); }
        const boosts = await both(([id, owner]) => { const info = _bbThingInfo(id); const branch = info.kind === 'building' ? 'building' : 'unit'; return getPlayerThingBoost(owner, branch, _boostThingKey(branch, info.key), 'energy'); }, [id, me]);
        if (boosts[0] !== 2 || boosts[1] !== 2) fail('bb-boost', page.__name, 'boost not 2 on both', { id, boosts, filled });
        else if (filled.some(n => n !== 3)) fail('bb-boost', page.__name, 'slots did not stay filled (x1 + 2 steps)', { id, filled });
        else pass('bb-boost', page.__name, { id, boosts });
    };
    if (!ONLY || ONLY === 'bb') for (const page of pages) await bottomBar(page);

    // ---- more: tower target, worker assignment, salvage mark and unmark, the research popup's slider ----
    const POPUP_RESEARCH_SLIDER = '#research-popup input.count-slider:not([disabled])[data-count-spec*='+'"\\"type\\":\\"research\\""]';
    const more = async page => {
        const me = await page.evaluate(() => localPlayerId);
        await page.keyboard.press('Escape');
        // Tower target: own towers selected, right click on a visible enemy unit
        // (the other player first sends a few units next to this player's towers).
        {
            // (Where this player sees: its unit nearest the other's king; a preferred target needs to be seen, not in range.)
            const tw0 = await page.evaluate(() => { const k = units.find(u => u && u.isKing && u.owner !== localPlayerId && u.owner >= 0); if (!k) return null; let best = null, bd = Infinity; for (const u of units) if (u && !u.dead && u.owner === localPlayerId) { const d = Math.hypot(u.x - k.x, u.y - k.y); if (d < bd) { bd = d; best = u; } } return best ? { x: best.x, y: best.y } : null; });
            if (tw0) {
                await other(page).evaluate(p => { const us = units.filter(u => u && !u.dead && u.owner === localPlayerId && u.unitType === 'fast').slice(0, 10); if (us.length) queueAction({ action: 'move', unitIds: us.map(u => u.id), targetX: p.x, targetY: p.y }); }, tw0);
                await page.waitForFunction(p => units.some(u => u && !u.dead && u.owner !== localPlayerId && u.owner >= 0 && Math.hypot(u.x - p.x, u.y - p.y) < 8 * TILE && isTileActuallyVisibleToPlayer(localPlayerId, Math.floor(u.x / TILE), Math.floor(u.y / TILE))), tw0, { timeout: 180000, polling: 500 }).catch(() => { });
                console.log('tower target setup', page.__name, JSON.stringify(await page.evaluate(p => { let best = Infinity, vis = 0; for (const u of units) if (u && !u.dead && u.owner !== localPlayerId && u.owner >= 0) { const d = Math.hypot(u.x - p.x, u.y - p.y) / TILE; if (d < best) best = d; if (d < 8 && isTileActuallyVisibleToPlayer(localPlayerId, Math.floor(u.x / TILE), Math.floor(u.y / TILE))) vis++; } return { best: Math.round(best), vis, at: [Math.round(p.x / TILE), Math.round(p.y / TILE)] }; }, tw0)));
            }
            const t = await page.evaluate(() => {
                const mine = towers.filter(t => t && t.owner === localPlayerId && !t.underConstruction && !(t.baseStats && t.baseStats.isCloud)).slice(0, 3);
                const foe = units.filter(u => u && !u.dead && u.owner !== localPlayerId && u.owner >= 0 && isTileActuallyVisibleToPlayer(localPlayerId, Math.floor(u.x / TILE), Math.floor(u.y / TILE))).sort((a, b) => Math.hypot(a.x - mine[0].x, a.y - mine[0].y) - Math.hypot(b.x - mine[0].x, b.y - mine[0].y))[0];
                if (!mine.length || !foe) return null;
                selectedUnits = []; selectedEntities = mine; updateInfoPanel();
                return { towers: mine.map(t => [t.gx, t.gy]), foe: foe.id };
            });
            if (!t) { results.push({ name: 'tower target', page: page.__name, ok: true, skipped: 'no visible enemy unit' }); console.log('skip tower target', page.__name); }
            else {
                const at = await page.evaluate(id => { const u = getUnitById(id); return { x: u.x, y: u.y }; }, t.foe);
                const s = await screenAt(page, at.x, at.y);
                const now = await page.evaluate(id => { const u = getUnitById(id); const r = document.getElementById('game-area').getBoundingClientRect(); return { x: (u.x - camera.x) * camera.zoom + r.left, y: (u.y - camera.y) * camera.zoom + r.top }; }, t.foe);
                await page.mouse.click(now.x, now.y, { button: 'right' });
                await page.waitForTimeout(1500);
                const shown = await both(ts => ts.map(([gx, gy]) => { const e = getTileEntityRef(gx, gy); return e ? getTowerPreferredTargetDisplay(e) : 'gone'; }), t.towers);
                if (JSON.stringify(shown[0]) !== JSON.stringify(shown[1]) || shown[0].every(x => x === 'None')) fail('tower target', page.__name, 'target not set on both', { t, shown, s });
                else pass('tower target', page.__name, { shown: shown[0] });
            }
        }
        // Worker assignment: own builders, right click on a construction site of this player's (ordered just now, away from them): they head there on both pages.
        {
            const site = await page.evaluate(() => {
                const bs = units.filter(u => u && !u.dead && u.owner === localPlayerId && u.workerType === 'builder').slice(0, 6);
                if (!bs.length) return null;
                const cx = bs[0].x / TILE, cy = bs[0].y / TILE;
                for (let r = 8; r < 30; r++) for (let k = 0; k < 64; k++) {
                    const a = k / 64 * Math.PI * 2, gx = Math.round(cx + Math.cos(a) * r), gy = Math.round(cy + Math.sin(a) * r);
                    if (gx > 0 && gy > 0 && gx < GRID_W - 1 && gy < GRID_H - 1 && canBuildAt(gx, gy, localPlayerId) && isTileActuallyVisibleToPlayer(localPlayerId, gx, gy) && !getTileEntityRef(gx, gy)) {
                        queueAction({ action: 'place', gx, gy, itemType: 'pistol', count: 1, buildEnabled: true, autoUpgradeEnabled: false });
                        return { gx, gy, ids: bs.map(u => u.id) };
                    }
                }
                return null;
            });
            if (site) await page.waitForTimeout(1500);
            const w = site && await page.evaluate(s => {
                const e = getTileEntityRef(s.gx, s.gy); if (!e || !e.underConstruction) return null;
                const set = new Set(s.ids); selectedEntities = []; selectedUnits = units.filter(u => u && !u.dead && set.has(u.id)); updateInfoPanel();
                return { ids: s.ids, mine: { gx: s.gx, gy: s.gy, x: s.gx * TILE + TILE / 2, y: s.gy * TILE + TILE / 2 } };
            }, site);
            if (!w) { results.push({ name: 'worker assign', page: page.__name, ok: true, skipped: 'no builders or no site' }); console.log('skip worker assign', page.__name, JSON.stringify(site)); }
            else {
                const dist = () => both(([ids, x, y]) => { const set = new Set(ids); let d = 0, n = 0; for (const u of units) if (u && !u.dead && set.has(u.id)) { d += Math.hypot(u.x - x, u.y - y); n++; } return n ? d / n : -1; }, [w.ids, w.mine.x, w.mine.y]);
                const d0 = await dist();
                await page.evaluate(() => { window.__acts.length = 0; });
                const s = await screenAt(page, w.mine.x, w.mine.y);
                await page.mouse.click(s.x, s.y, { button: 'right' });
                await page.waitForTimeout(3000);
                const d1 = await dist(), acts = await page.evaluate(() => window.__acts.map(a => a.action + ':' + (a.targetType || (a.groups ? a.mode : ''))));
                // (Builders fetch material first: their target, not their distance, says they took it.)
                // (A site takes one builder: workers' targets are exclusive (rules 53). Their states, the same on both pages, one at work.)
                const tg = await both(ids => { const set = new Set(ids); const st = {}; for (const u of units) if (u && !u.dead && set.has(u.id)) st[u.workerState] = (st[u.workerState] || 0) + 1; return JSON.stringify(st); }, w.ids);
                const busy = Object.entries(JSON.parse(tg[0])).filter(([k]) => k !== 'IDLE').reduce((n, [, v]) => n + v, 0);
                if (tg[0] !== tg[1] || busy < 1) fail('worker assign', page.__name, 'builder states differ or none took the site', { d0, d1, acts, tg });
                else pass('worker assign', page.__name, { d0, d1, acts });
            }
        }
        // Salvage: a tower group's ❤️ pill to mark, then again to keep it; both pages follow, the pill holds each look.
        {
            const tw = await page.evaluate(() => { const t = towers.find(t => t && t.owner === localPlayerId && !t.underConstruction && t.type === 'pistol'); if (!t) return null; selectedUnits = []; selectedEntities = [t]; updateInfoPanel(); return { gx: t.gx, gy: t.gy }; });
            if (!tw) results.push({ name: 'salvage', page: page.__name, ok: true, skipped: 'no pistol tower' });
            else {
                await page.waitForTimeout(400);
                const marks = () => both(([gx, gy]) => { const e = getTileEntityRef(gx, gy); return e ? !!e.markedForSalvage : null; }, [tw.gx, tw.gy]);
                const pill = () => page.locator('#info-panel [data-b="salvage"]').filter({ visible: true }).first();
                const looks = [];
                await pill().click();
                for (let i = 0; i < 6; i++) { await page.waitForTimeout(150); looks.push(await pill().textContent().catch(() => '?')); }
                const m1 = await marks();
                await pill().click();
                for (let i = 0; i < 6; i++) { await page.waitForTimeout(150); looks.push(await pill().textContent().catch(() => '?')); }
                const m2 = await marks();
                const flick = looks.slice(0, 6).some(x => x !== looks[0]) || looks.slice(6).some(x => x !== looks[6]);
                if (!(m1[0] === true && m1[1] === true && m2[0] === false && m2[1] === false)) fail('salvage', page.__name, 'mark/unmark not on both', { m1, m2, looks });
                else if (flick) fail('salvage', page.__name, 'pill look changed after a press', { looks });
                else pass('salvage', page.__name, { looks: [looks[0], looks[6]] });
            }
        }
        // The research popup (P on a lab's section): its stat slider +2 levels, both peers.
        {
            await page.evaluate(() => { const r = collectorSpawners.find(s => s && s.owner === localPlayerId && s.type === 'research' && !s.underConstruction); selectedUnits = []; selectedEntities = [r]; updateInfoPanel(); });
            await page.waitForTimeout(400);
            const p = page.locator('#info-panel .info-subgroup-research-btn').filter({ visible: true }).first();
            if (!(await p.count())) { fail('research popup', page.__name, 'no P button'); }
            else {
                await p.click();
                await page.waitForTimeout(500);
                const sl = page.locator(POPUP_RESEARCH_SLIDER).filter({ visible: true }).first();
                if (!(await sl.count())) fail('research popup', page.__name, 'no research slider in the popup');
                else {
                    const spec = JSON.parse(await sl.getAttribute('data-count-spec'));
                    const st = spec.stats[0];
                    const v0 = Number(await sl.inputValue()), target = Math.min(10, v0 + 2);
                    const box = await sl.boundingBox();
                    await page.mouse.click(box.x + 2 + (box.width - 4) * target / 10, box.y + box.height / 2);
                    const vals = [];
                    for (let i = 0; i < 8; i++) { await page.waitForTimeout(200); vals.push(await page.locator(POPUP_RESEARCH_SLIDER).filter({ visible: true }).first().inputValue().catch(() => 'gone')); }
                    const lv = await both(([o, s]) => getPlayerResearchLevel(o, s.kind, s.key, s.statKey) + getResearchQueuedDepthForPlayer(o, s.kind, s.key, s.statKey), [me, st]);
                    if (lv[0] !== target || lv[1] !== target) fail('research popup', page.__name, `level+queued ${lv}, want ${target}`, { st, v0, vals });
                    else if (vals.some(v => v !== String(target))) fail('research popup', page.__name, 'popup slider did not stay', { vals, target });
                    else pass('research popup', page.__name, { st: st.key + '.' + st.statKey, target });
                }
                await page.keyboard.press('Escape');
            }
        }
    };
    if (!ONLY || ONLY === 'more') for (const page of pages) await more(page);

    console.log('queue forms', JSON.stringify(await Promise.all(pages.map(rqForm))));
    const health = await Promise.all(pages.map(p => p.evaluate(() => ({ tick: currentTick, desyncs: netCounters.desyncsDetected, stop: lockstepFatalStopActive, started: gameStarted }))));
    const out = { fixture, delay: DELAY, health, errors: errors.slice(0, 30), results };
    fs.writeFileSync(path.join(__dirname, 'browser-mp-actions-results.json'), JSON.stringify(out, null, 1));
    console.log(JSON.stringify({ health, errors: errors.length, failed: results.filter(r => !r.ok).map(r => r.name + '@' + r.page) }));
    for (const e of errors.slice(0, 10)) console.log('ERROR', e);
    await browser.close();
    server.close();
    process.exit(results.some(r => !r.ok) || errors.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
