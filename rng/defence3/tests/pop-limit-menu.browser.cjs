// The menu's population dropdown in Microsoft Edge: a fixed list of powers of
// two (the same on every map), an older export's values snapped to the nearest
// choices, and a started match's building limit and reservations derived
// for the map (data_static.js memory budget) and shown in the HUD.
//   NODE_PATH=<dir with playwright> node tests/pop-limit-menu.browser.cjs
'use strict';
const fs = require('node:fs'), path = require('node:path'), http = require('node:http'), assert = require('node:assert/strict');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '..');
const mime = { '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.wasm': 'application/wasm' };
const server = http.createServer((req, res) => {
    const name = decodeURIComponent(new URL(req.url, 'http://localhost').pathname).replace(/^\//, '') || 'index.html';
    const file = path.resolve(root, name);
    if (!file.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
    fs.readFile(file, (err, data) => {
        if (err) { res.writeHead(404).end(); return; }
        res.writeHead(200, { 'Content-Type': mime[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store',
            'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' });
        res.end(data);
    });
});
(async () => {
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const browser = await chromium.launch({ channel: 'msedge', headless: !process.env.HEADED });
    const page = await (await browser.newContext({ viewport: { width: 1600, height: 900 } })).newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message.slice(0, 300)));
    page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text().slice(0, 300)); });
    try {
        await page.goto(`http://127.0.0.1:${server.address().port}/index.html`, { waitUntil: 'load', timeout: 120000 });
        await page.waitForTimeout(1500);
        const menu = () => page.evaluate(() => {
            const el = document.getElementById('cfg-max-pop'), map = document.getElementById('cfg-mapsize');
            return { map: map.value, maps: [...map.options].map(o => Number(o.value)), value: el.value, tag: el.tagName,
                options: [...el.options].map(o => ({ v: Number(o.value), t: o.textContent })), buildingsInput: !!document.getElementById('cfg-max-buildings') };
        });
        const first = await menu();
        console.log('default', JSON.stringify({ map: first.map, value: first.value, n: first.options.length, last: first.options.at(-1) }));
        assert.equal(first.tag, 'SELECT');
        assert.equal(first.buildingsInput, false, 'no separate Max Buildings control');
        assert.deepEqual(first.maps, [16, 32, 64, 128, 256, 512, 1024, 2048], 'power-of-two map sizes');
        for (const o of first.options) assert.equal(o.v & (o.v - 1), 0, 'power-of-two population: ' + o.v);
        assert.deepEqual(first.options.map(o => o.v), Array.from({ length: 18 }, (_, k) => 2 ** (k + 3)), 'populations 8 to 2^20');
        assert.equal(first.value, '256');
        await page.selectOption('#cfg-mapsize', '2048');
        const big = await menu();
        assert.deepEqual(big.options, first.options, 'the same choices on every map');
        assert.equal(big.value, first.value, 'the chosen population kept');
        // (An older export: map 2000, population 500000: the nearest choices.)
        await page.evaluate(() => applyMainMenuSettingsSnapshot({ lobby: { numbers: { 'cfg-max-pop': 500000 }, selects: { 'cfg-mapsize': '2000' } } }));
        const old = await menu();
        assert.equal(old.map, '2048'); assert.equal(old.value, '524288');
        // (A match: the limits and the reservations follow the population.)
        await page.selectOption('#cfg-mapsize', '256');
        await page.selectOption('#cfg-max-pop', '16384');
        const run = await page.evaluate(async () => {
            await startSoloGame();
            return { pop: CONFIG_MAX_POP, cfgBuildings: CONFIG_MAX_BUILDINGS, grid: GRID_W, teams: activeTeamIds.length,
                limit: getPlayerStructureLimit(), memory: structMemoryLimitPerPlayer(), budget: memoryBudgetBuildings(CONFIG_MAX_POP, activeTeamIds.length, GRID_W * GRID_H) };
        });
        console.log('match', JSON.stringify(run));
        assert.equal(run.pop, 16384); assert.equal(run.grid, 256); assert.equal(run.cfgBuildings, 0, 'the menu derives the building limit');
        assert.equal(run.limit, run.budget, 'the budget\'s limit, held by the structure pool');
        assert.ok(run.memory >= run.budget, 'the pool holds it');
        await page.waitForFunction(() => typeof simClientStats === 'function' && simClientStats().appliedTick >= 10, {}, { timeout: 120000 });
        const hud = await page.evaluate(() => ({ tick: simClientStats().appliedTick, text: document.body.innerText }));
        assert.ok(hud.tick >= 10, 'the match runs');
        assert.ok(/16,?384|16\.4k|16k/i.test(hud.text), "the match's population on screen");
        // (A choice that does not fit (8 teams of 2^20 on 2048x2048): the match's
        // population is the budget's, shown and used in the game.)
        const fit = await page.evaluate(() => ({ p: memoryBudgetPop(1048576, 8, 2048 * 2048), b: memoryBudgetBuildings(memoryBudgetPop(1048576, 8, 2048 * 2048), 8, 2048 * 2048) }));
        console.log('8 teams, 2^20 on 2048:', JSON.stringify(fit));
        assert.ok(fit.p < 1048576 && fit.b >= 64, 'lowered until it fits');
        assert.deepEqual(errors, []);
        console.log('PASS: static power-of-two population dropdown and map sizes, old exports snapped, match limits derived for the map and shown');
    } finally { await browser.close(); server.close(); }
})().catch(err => { console.error(err); process.exit(1); });
