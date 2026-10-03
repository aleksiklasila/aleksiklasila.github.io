const assert = require('node:assert/strict');
const H = require('./net-harness.cjs');

(async () => {
    const spawnCounts = { 'unit:king': { 1: 1 }, 'unit:norm': { 1: 1 }, 'building:barrack_norm': { 1: 1 } };
    const world = new H.World({ simWorker: true, controls: { ...H.SMALL_MATCH_CONTROLS, 'cfg-full-vis': 'all' } });
    const inst = world.spawn('solo');
    inst.eval(`startingResourcesConfig = ${JSON.stringify({ spawnCounts, researchLevels: {} })}; startSoloGame();`);
    await world.run(1000);
    assert.equal(inst.eval('simClientActive()'), true, 'uses the default simulation worker');
    {
        // Browser scripts run main.js in strict mode. The harness concatenates
        // scripts, so restore that mode for the real input handler here.
        inst.eval(`initInput = eval('"use strict"; (' + initInput.toString() + ')');
            minimapCanvas = document.getElementById('minimapCanvas'); canvas = document.getElementById('gameCanvas'); initInput();`);
        const setup = JSON.parse(inst.eval(`JSON.stringify((() => {
            const u = units.find(u => u.owner === localPlayerId && !u.dead && u.unitType === 'norm');
            const b = barracks.find(b => b.owner === localPlayerId && b.energy > 0);
            if (!u || !b) return null;
            selectedUnits = [u]; selectedEntities = [b]; activeSubGroups = {};
            camera.zoom = 1; camera.x = u.x - 200; camera.y = u.y - 200;
            return { id: u.id, bx: b.gx, by: b.gy, x: u.x, y: u.y };
        })())`));
        assert.ok(setup, inst.name + ' has a unit and barrack');
        const before = inst.eval('nextLocalActionSeq');
        inst.dispatch('game-area', 'mousedown', { button: 2, clientX: 296, clientY: 296 });
        const issued = JSON.parse(inst.eval(`JSON.stringify(Object.values(localInputBuffer).flat()
            .filter(a => Number(a.netId.split(':').pop()) >= ${before})
            .map(a => ({ action: a.action, unitIds: a.unitIds || [], gx: a.gx, gy: a.gy, coords: a.coords || [] })))`));
        // (Rallies go as one action per point with the buildings' tiles.)
        assert.ok(issued.some(a => (a.action === 'setRally' && a.gx === setup.bx && a.gy === setup.by) || (a.action === 'setRallyMany' && a.coords.some((v, i) => i % 2 === 0 && v === setup.bx && a.coords[i + 1] === setup.by))), inst.name + ' rallies building');
        assert.ok(issued.some(a => a.action === 'move' && a.unitIds.includes(setup.id)), inst.name + ' moves unit');
        await world.run(1000);
        assert.equal(inst.eval(`(() => { const u = units.find(u => u.id === ${setup.id}); return u.x !== ${setup.x} || u.y !== ${setup.y}; })()`), true, 'the selected unit actually moves');
        assert.equal(inst.eval(`(() => { const b = barracks.find(b => b.gx === ${setup.bx} && b.gy === ${setup.by}); return b.rallyX === ${setup.x + 96} && b.rallyY === ${setup.y + 96}; })()`), true, 'the building rally is applied by the worker');
    }
    console.log('PASS: mixed selection issues both rally and move.');
    process.exit(0);
})().catch(err => { console.error(err); process.exit(1); });
