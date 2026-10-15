'use strict';
// Real DOM regression coverage for roster selection and a 100-task research
// queue, in Edge over its debugging protocol (tests/edge-cdp.cjs; skipped
// without Edge): node tests/research-menu.test.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const { launch } = require('./edge-cdp.cjs');
const root = path.resolve(__dirname, '..');
const server = http.createServer((req, res) => {
    const file = path.resolve(root, '.' + new URL(req.url, 'http://localhost').pathname);
    if (!file.startsWith(root + path.sep)) return res.writeHead(403).end();
    // Start the game explicitly, with no render/tick loop racing the checks.
    if (file.endsWith(path.sep + 'bootstrap.js')) return res.writeHead(200, { 'Content-Type': 'text/javascript' }).end('');
    fs.readFile(file, (error, data) => {
        if (error) return res.writeHead(404).end();
        res.writeHead(200, { 'Content-Type': ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png' })[path.extname(file)] || 'application/octet-stream' }).end(data);
    });
});

(async () => {
    let browser;
    try {
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        browser = await launch(`http://127.0.0.1:${server.address().port}/index.html?simworker=0`, { width: 1280, height: 800 });
        if (!browser) { console.log('research-menu: skipped (no Edge)'); return; }
        for (let i = 0; i < 100 && !(await browser.ev("typeof renderResearchPopupContent === 'function'")); i++) await new Promise(r => setTimeout(r, 100));
        const errors = browser.errors;
        const result = await browser.evFn(() => {
            const check = (condition, message) => { if (!condition) throw Error(message); };
            // Unselected frame views have state but no path/target details.
            const savedUnits = units;
            const savedUpdate = updateInfoPanel;
            updateInfoPanel = () => {};
            units = [
                { id: 1, owner: 0, unitType: 'collector', workerType: 'collector', workerState: 'IDLE' },
                { id: 2, owner: 0, unitType: 'collector', workerType: 'collector', workerState: 'MOVING' },
                { id: 3, owner: 0, unitType: 'collector', workerType: 'collector', workerState: 'GATHERING' },
                { id: 4, owner: 1, unitType: 'collector', workerType: 'collector', workerState: 'IDLE' },
                { id: 5, owner: 0, unitType: 'norm', commandState: CMD_IDLE },
                { id: 6, owner: 0, unitType: 'norm', commandState: CMD_IDLE + 1 },
                { id: 7, owner: 0, unitType: 'norm', commandState: CMD_IDLE + 1, holdPosition: true },
                { id: 8, owner: 0, unitType: 'collector', workerType: 'collector', workerState: 'IDLE', dead: true }
            ];
            selectInfoPanelPlayerRoster('units', 'total', 'idle', 0);
            check(selectedUnits.map(u => u.id).join(',') === '1,5,7', 'Idle must exclude working, moving, dead and enemy units');
            selectInfoPanelPlayerRoster('units', 'collector', 'idle', 0);
            check(selectedUnits.length === 1 && selectedUnits[0].id === 1, 'type filter');
            units[0].workerState = 'MOVING';
            selectInfoPanelPlayerRoster('units', 'collector', 'idle', 0);
            check(selectedUnits.length === 0, 'zero idle must clear the previous selection');
            units = savedUnits;
            updateInfoPanel = savedUpdate;
            const labView = { _s: -1, _last: { flags: SIM_SF_RESEARCHING } };
            Object.defineProperty(labView, 'isResearching', _PAGE_STRUCT_ACCESSORS.isResearching);
            check(!_isInfoPanelBuildingIdleLike(labView), 'active research lab is busy in frame views');
            labView._last.flags = 0;
            check(_isInfoPanelBuildingIdleLike(labView), 'paused research lab is idle');
            labView.spawnQueue = [{}];
            check(!_isInfoPanelBuildingIdleLike(labView), 'queued production is busy');

            for (const [id, value] of Object.entries({ 'cfg-mapsize': '30', 'cfg-map-type': 'arena', 'cfg-starting-energy': '2000000', 'cfg-starting-astar': '2000000' })) document.getElementById(id).value = value;
            readConfigFromMenu();
            startingResourcesConfig = { spawnCounts: { 'building:research': { 1: 8 }, 'unit:king': { 1: 1 } }, researchLevels: {} };
            localPlayerId = 0;
            gameSeed = 17;
            startMainThreadLoops = () => {};
            prewarmItemThumbnails = () => {};
            startGame();
            const labs = collectorSpawners.filter(s => s.owner === 0 && s.type === 'research');
            check(labs.length === 8, 'fixture labs');
            const lab = labs[0], player = players[0];
            ensureResearchThingsReady();
            const stats = RESEARCH_THINGS.flatMap(thing => thing.stats.map(stat => ({ kind: thing.kind, key: thing.key, statKey: stat.statKey })));
            for (const stat of stats.slice(0, 100)) processAction({ action: 'queueResearch', gx: lab.gx, gy: lab.gy, count: 1, ...stat }, 0);
            check(getPlayerResearchQueueTotalLength(0) === 100, 'fixture queue');
            selectedEntities = [lab]; selectedUnits = []; activeSubGroups = {};
            queuePurchaseMultiplier = 1;
            const actions = [];
            queueAction = action => { actions.push(action); processAction(action, 0); };
            setResearchPopupOpen(true);
            const panel = document.getElementById('research-popup-info-panel');
            const pane = panel.querySelector('.research-popup-queue-scroll');
            const row = panel.querySelectorAll('.info-research-queue-row')[50];
            const plus = row.querySelector('.info-research-buy-btn');
            const minus = row.querySelector('.info-research-dequeue-btn');
            check(panel.querySelectorAll('.info-research-queue-item').length === 100, '100 visible rows');
            pane.scrollTop = 1000;
            const scrollTop = pane.scrollTop;
            const observer = new MutationObserver(() => {});
            observer.observe(panel, { childList: true, subtree: true });
            const start = performance.now();
            for (let i = 0; i < 10; i++) { player.researchTask.workDone++; renderResearchPopupContent(); }
            const refreshMs = (performance.now() - start) / 10;
            check(observer.takeRecords().length === 0, 'progress refreshes must retain all nodes');
            check(panel.querySelector('.research-popup-queue-scroll') === pane && pane.scrollTop === scrollTop, 'progress preserves scroll pane and position');
            const press = button => button.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
            const editStart = performance.now();
            for (let i = 0; i < 5; i++) {
                press(plus); renderResearchPopupContent();
                check(getPlayerResearchQueueTotalLength(0) === 101, 'plus adds once');
                check(plus.isConnected && row.querySelector('.info-research-buy-btn') === plus, 'add preserves existing button');
                press(minus); renderResearchPopupContent();
                check(getPlayerResearchQueueTotalLength(0) === 100, 'minus removes once');
            }
            const editMs = (performance.now() - editStart) / 10;
            check(actions.length === 10, 'retained listeners fire exactly once');
            check(pane.scrollTop === scrollTop, 'queue edits preserve scroll position');
            // Add an entirely new stat, then exercise its freshly bound button.
            processAction({ action: 'queueResearch', gx: lab.gx, gy: lab.gy, count: 1, ...stats[100] }, 0);
            renderResearchPopupContent();
            const added = panel.querySelectorAll('.info-research-queue-row')[100];
            press(added.querySelector('.info-research-dequeue-btn')); renderResearchPopupContent();
            check(!added.isConnected && getPlayerResearchQueueTotalLength(0) === 100, 'new row controls are bound');
            // Reordering changes pending indices without discarding the rows.
            const moved = panel.querySelectorAll('.info-research-queue-row')[50];
            press(moved.querySelector('.info-research-move-top-btn')); renderResearchPopupContent();
            check(moved.isConnected && moved.querySelector('.info-research-queue-item').dataset.pendingIndex === '-1', 'reorder promotes retained row to active');
            press(moved.querySelector('.info-research-move-bottom-btn')); renderResearchPopupContent();
            check(moved.querySelector('.info-research-queue-item').dataset.pendingIndex === '98', 'retained reorder button reads current attributes');
            // Group and normal sidebar use the same queue patching path.
            selectedEntities = labs.slice(0, 2); renderResearchPopupContent();
            check(panel.textContent.includes('Shared Queue (2 labs)'), 'group queue');
            const groupPane = panel.querySelector('.research-popup-queue-scroll');
            renderResearchPopupContent();
            check(panel.querySelector('.research-popup-queue-scroll') === groupPane, 'group popup is cached');
            researchQueuePanelOpenState[getResearchPanelScopeKey(0, `group:${selectedEntities.map(r => `${r.gx},${r.gy}`).join(';')}`)] = true;
            updateInfoPanel();
            const sidebar = document.getElementById('info-panel');
            const sidebarPlus = sidebar.querySelector('.info-research-queue-item .info-research-buy-btn');
            press(sidebarPlus); updateInfoPanel();
            check(sidebarPlus.isConnected, 'sidebar queue edits retain controls');
            player.researchTask = null; player.researchQueue = [];
            renderResearchPopupContent();
            check(panel.querySelectorAll('.info-research-queue-item').length === 0 && panel.textContent.includes('Queue is empty.'), 'empty queue');
            processAction({ action: 'queueResearch', gx: lab.gx, gy: lab.gy, count: 1, ...stats[100] }, 0);
            renderResearchPopupContent();
            check(panel.querySelectorAll('.info-research-queue-item').length === 1, 'empty queue can be populated again');
            return { refreshMs, editMs, rows: 100 };
        });
        assert.deepEqual(errors, []);
        console.log('PASS: idle selection; 100-task popup/sidebar queue, progress, scroll, add/remove, new stats, reordering and listener retention.', result);
    } finally {
        if (browser) await browser.close();
        server.close();
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
