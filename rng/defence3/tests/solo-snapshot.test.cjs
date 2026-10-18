'use strict';
const assert = require('node:assert/strict');
const H = require('./net-harness.cjs');

async function settle(world, promise) {
    let done = false, result, error;
    promise.then(value => { result = value; done = true; }, e => { error = e; done = true; });
    assert.ok(await world.runUntil(() => done, 10000, 10), 'snapshot operation finished');
    if (error) throw error;
    return result;
}

(async () => {
    for (const worker of [false, true]) {
        const world = new H.World({ controls: H.SMALL_MATCH_CONTROLS });
        world.simWorker = worker;
        const source = world.spawn('source');
        await world.run(200);
        source.eval('startSoloGame()');
        await world.run(1200);
        assert.equal(source.eval('simClientActive()'), worker);
        source.evalSim(`(() => {
            const u = units.find(u => !u.dead);
            u.energy = 37;
            addPlayerResource(0, 'energy', 12345 - players[0].energy);
            players[0].researchLevels['unit:norm:speed'] = 2;
            projectiles.push(new Projectile(40, 112, { x: 400, y: 112 }, 'arrow', 7, 1, towers[0] || barracks[0], 300));
        })()`);
        source.eval(`camera.x = 40; camera.y = 50; camera.zoom = 1.5;
            localInputBuffer[currentTick + 5] = [{ action: 'stop', teamId: 0, unitIds: [] }];`);
        const text = await settle(world, source.eval('captureSoloGameSnapshotText()'));
        const saved = JSON.parse(text);
        assert.equal(saved.match.currentTick, saved.match.state.g.tick, 'clock and state captured together');
        assert.ok(saved.match.state.lists.u.length > 0, 'full units, including worker-owned units');
        assert.ok(saved.match.state.lists.p.length > 0, 'projectiles in flight');
        assert.ok(Object.keys(saved.pendingInput).length, 'pending commands');
        assert.equal(saved.camera.zoom, 1.5);

        const a = world.spawn('restore-a'), b = world.spawn('restore-b');
        await world.run(200);
        for (const inst of [a, b]) {
            inst.scratch.text = text;
            // Prevent automatic ticks so we can inspect the exact restored boundary.
            inst.eval('startMainThreadLoops = () => {};');
            await settle(world, inst.eval('restoreSoloGameSnapshotText(__scratch.text)'));
        }
        await world.run(100);
        const state = i => i.evalSim(`JSON.stringify({ tick: currentTick, time: gameTime, rng: rng.getState(),
            units: units.map(u => [u.id, u.x, u.y, u.energy, u.owner]),
            research: players[0].researchLevels, energy: players[0].energy,
            projectiles: projectiles.map(p => [p.x, p.y, p.dmg, p.life]),
            hash: snapTickHash(currentTick, true) })`);
        assert.equal(state(a), state(b), 'independent imports restore identical simulation state');
        assert.equal(a.evalSim('currentTick'), saved.match.currentTick);
        assert.equal(a.evalSim('rng.getState()'), saved.match.state.g.rng);
        assert.ok(a.evalSim('players[0].energy') > 12000, 'saved resources survive menu initialization');
        assert.equal(a.eval('camera.zoom'), 1.5);
        assert.equal(a.eval('JSON.stringify(localInputBuffer)'), JSON.stringify(saved.pendingInput));
        assert.equal(a.eval('simClientActive()'), worker);
        for (const inst of [a, b]) inst.evalSim(`__scratch.soloActions = 0;
            const originalSoloActions = processActions;
            processActions = function(actions, team) { __scratch.soloActions += actions.length; return originalSoloActions(actions, team); };`);
        // The same saved scene evolves identically over many ticks, with no menu defaults involved.
        for (let tick = 0; tick < 20; tick++) {
            for (const inst of [a, b]) {
                if (worker) {
                    const t = inst.evalSim('currentTick');
                    const actions = inst.eval('JSON.stringify(localInputBuffer[' + t + '] || [])');
                    inst.evalSim(`_simTick({ tick: currentTick, actions: ${actions}, teams: activeTeamIds, dk: 1 });`);
                    inst.eval('delete localInputBuffer[' + t + ']');
                } else inst.evalSim('runOneTick()');
            }
            assert.equal(state(a), state(b), 'identical continuation at tick ' + tick);
        }
        assert.equal(a.evalSim('__scratch.soloActions'), 1, 'queued command executes once after import');
        const menu = world.spawn('invalid');
        menu.eval('initSoloSnapshotControls()');
        assert.equal(menu.element('btn-import-snapshot').listeners.click.length, 1);
        assert.equal(menu.element('input-import-snapshot').listeners.change.length, 1);
        assert.equal(menu.element('btn-export-snapshot').listeners.click.length, 1);
        for (const modify of [d => { d.version++; }, d => { d.match.state.rules++; }, d => { d.match.state.grid.pop(); }, d => { delete d.match.state.lists.u; }]) {
            const bad = JSON.parse(text); modify(bad); menu.scratch.text = JSON.stringify(bad);
            await assert.rejects(menu.eval('restoreSoloGameSnapshotText(__scratch.text)'));
            assert.equal(menu.eval('gameStarted'), false, 'invalid file leaves the menu open');
        }
        await assert.rejects(menu.eval(`restoreSoloGameSnapshotText('not JSON')`), /valid JSON/);
        await assert.rejects(menu.eval(`restoreSoloGameSnapshotText('{"version":4}')`), /settings export/);
        // Ended games still load their world and expose the normal result/menu controls.
        const ended = JSON.parse(text);
        ended.match.state.g.gameOver = true;
        ended.match.state.g.winner = 0;
        ended.tickIntervalMs = 150;
        menu.scratch.text = JSON.stringify(ended);
        menu.eval('startMainThreadLoops = () => {}; showGameOver = () => { __scratch.resultShown = true; };');
        await settle(world, menu.eval('restoreSoloGameSnapshotText(__scratch.text)'));
        await world.run(100);
        assert.equal(menu.evalSim('gameOver'), true);
        assert.equal(menu.eval('netSimulationTickMs()'), 150, 'saved adaptive pace restored');
        assert.equal(menu.scratch.resultShown, true);
        assert.equal(menu.element('btn-export-snapshot').style.display, '');
        menu.eval('_returnToMainMenuWithStatus()');
        assert.equal(menu.eval('gameStarted'), false);
        source.eval('isMultiplayer = true');
        await assert.rejects(source.eval('captureSoloGameSnapshotText()'), /solo games only/);
        for (const inst of [source, a, b, menu]) assert.deepEqual(inst.errors, [], inst.name + ' errors');
        console.log('PASS solo snapshots: ' + (worker ? 'worker' : 'page') + ', exact restore, repeatable continuation, invalid files');
    }
})().catch(error => { console.error(error); process.exit(1); });
