// Drives the real input handlers of every player with random gestures:
// box/click selection, right-click commands on ground, enemies, own
// buildings and mines (with Ctrl multi-points and Shift), attack-move,
// stop/hold, split/merge keys, control groups (set, add, recall), popup
// group keys, build placement (Shift keeps the tool) and Escape.
//
// Input may only schedule actions: a bit-exact fingerprint of the simulation
// must be identical before and after every gesture (a handler that changes
// state directly desyncs the clicking player). All peers must also agree on
// every tick.
const assert = require('node:assert/strict');
const C = require('./multiplayer-chaos-determinism.test.cjs');

const SECONDS = Number(process.argv[2]) || 30;

(async () => {
    const { world, host, guests, all } = await C.setupChaosWorld('arena', 777, { exactHashes: true });
    for (const inst of all) inst.eval("minimapCanvas = document.getElementById('minimapCanvas'); canvas = document.getElementById('gameCanvas'); initInput();");
    let s = 31337;
    const rand = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
    const pick = a => a[Math.floor(rand() * a.length) % a.length];

    // World <-> screen for the 2D camera, derived from screenToWorld itself.
    const toScreen = (inst, wx, wy) => {
        const m = JSON.parse(inst.eval('JSON.stringify([screenToWorld(0, 0), screenToWorld(100, 100)])'));
        const kx = (m[1].x - m[0].x) / 100, ky = (m[1].y - m[0].y) / 100;
        return { clientX: (wx - m[0].x) / kx, clientY: (wy - m[0].y) / ky };
    };
    const focusCamera = inst => inst.eval(`(() => {
        const mine = units.filter(u => u.owner === localPlayerId && !u.dead);
        const u = mine[Math.floor(${rand()} * mine.length)] || units[0];
        camera.zoom = 1; camera.x = u.x - viewW / 2; camera.y = u.y - viewH / 2; clampCamera();
    })()`);
    const worldPoints = (inst, kind) => JSON.parse(inst.eval(`JSON.stringify((() => {
        const me = localPlayerId;
        const pts = [];
        const add = (e) => { if (e) pts.push({ x: Number.isFinite(e.x) ? e.x : e.gx * TILE + 16, y: Number.isFinite(e.y) ? e.y : e.gy * TILE + 16 }); };
        if ('${kind}' === 'ownUnit') units.filter(u => u.owner === me && !u.dead).slice(0, 40).forEach(add);
        if ('${kind}' === 'enemyUnit') units.filter(u => u.owner !== me && !u.dead).slice(0, 40).forEach(add);
        if ('${kind}' === 'ownBuilding') [...barracks, ...collectorSpawners, ...towers].filter(b => b.owner === me).forEach(add);
        if ('${kind}' === 'enemyBuilding') [...barracks, ...collectorSpawners, ...towers].filter(b => b.owner !== me).forEach(add);
        if ('${kind}' === 'mine') [...goldMines, ...astarMines].slice(0, 40).forEach(add);
        return pts;
    })())`));

    const gestureKinds = new Map();
    const note = k => gestureKinds.set(k, (gestureKinds.get(k) || 0) + 1);
    const gesture = inst => {
        const mods = { ctrlKey: rand() < 0.3, shiftKey: rand() < 0.25 };
        const kind = pick(['boxSelect', 'boxSelect', 'clickSelect', 'rightClick', 'rightClick', 'rightClick', 'key', 'key', 'build', 'attackMove', 'group']);
        if (kind !== 'key' && kind !== 'group') focusCamera(inst);
        const at = (target) => {
            const pts = worldPoints(inst, target);
            const p = pts.length ? pick(pts) : { x: rand() * 900, y: rand() * 900 };
            return toScreen(inst, p.x + (rand() - 0.5) * 20, p.y + (rand() - 0.5) * 20);
        };
        if (kind === 'boxSelect') {
            const a = at('ownUnit'), b = { clientX: a.clientX + (rand() - 0.3) * 300, clientY: a.clientY + (rand() - 0.3) * 300 };
            inst.dispatch('game-area', 'mousedown', { button: 0, ...a, ...mods });
            inst.dispatch('game-area', 'mousemove', { buttons: 1, ...b, ...mods });
            inst.dispatch('game-area', 'mouseup', { button: 0, ...b, ...mods });
        } else if (kind === 'clickSelect') {
            const a = at(pick(['ownBuilding', 'ownUnit', 'enemyUnit', 'mine']));
            inst.dispatch('game-area', 'mousedown', { button: 0, ...a, ...mods });
            inst.dispatch('game-area', 'mouseup', { button: 0, ...a, ...mods });
        } else if (kind === 'rightClick') {
            const target = pick(['enemyUnit', 'enemyBuilding', 'ownBuilding', 'mine', 'ground', 'ownUnit']);
            const a = target === 'ground' ? toScreen(inst, rand() * 1200, rand() * 1200) : at(target);
            inst.dispatch('game-area', 'mousedown', { button: 2, ...a, ...mods });
            inst.dispatch('game-area', 'mouseup', { button: 2, ...a, ...mods });
            note('rightClick:' + target + (mods.ctrlKey ? '+ctrl' : ''));
            return;
        } else if (kind === 'attackMove') {
            inst.dispatch('document', 'keydown', { key: 'z', code: 'KeyZ' });
            const a = at(pick(['enemyUnit', 'enemyBuilding']));
            inst.dispatch('game-area', 'mousedown', { button: 0, ...a, ...mods });
            inst.dispatch('game-area', 'mouseup', { button: 0, ...a, ...mods });
        } else if (kind === 'key') {
            const key = pick(['x', 'c', 'q', 'e', '/', '*', 'Escape', 'f', 'r', 't', 'y', 'u']);
            inst.dispatch('document', 'keydown', { key, code: key.length === 1 ? 'Key' + key.toUpperCase() : key, ...mods });
            inst.dispatch('document', 'keyup', { key });
            note('key:' + key);
            return;
        } else if (kind === 'group') {
            const d = String(1 + Math.floor(rand() * 9));
            inst.dispatch('document', 'keydown', { key: d, code: 'Digit' + d, ...mods });
            note('group' + (mods.ctrlKey ? ':set' : mods.shiftKey ? ':add' : ':recall'));
            return;
        } else if (kind === 'build') {
            inst.eval(`selectedBuildItem = ${JSON.stringify(pick(C.BUILDINGS))}`);
            const a = at('ownBuilding');
            const shift = rand() < 0.4;
            inst.dispatch('game-area', 'mousedown', { button: 0, clientX: a.clientX + 40, clientY: a.clientY + 40, shiftKey: shift });
            inst.dispatch('game-area', 'mouseup', { button: 0, clientX: a.clientX + 40, clientY: a.clientY + 40, shiftKey: shift });
            if (shift) inst.dispatch('document', 'keydown', { key: 'Escape', code: 'Escape' });
        }
        note(kind);
    };

    const impure = [];
    const end = world.now + SECONDS * 1000;
    let gestures = 0;
    while (world.now < end) {
        for (const inst of all) {
            for (let k = 0; k < 3; k++) {
                const before = inst.eval('__exactStateHash()');
                const queuedBefore = inst.eval('nextLocalActionSeq');
                try { gesture(inst); } catch (err) { inst.errors.push(err); }
                gestures++;
                const after = inst.eval('__exactStateHash()');
                if (before !== after && impure.length < 5) impure.push({ peer: inst.name, gestures: [...gestureKinds.keys()].slice(-3), queued: inst.eval('nextLocalActionSeq') - queuedBefore });
            }
        }
        await world.run(150);
    }
    await world.run(3000);

    for (const inst of all) assert.deepEqual(inst.errors.map(e => String(e.stack || e).slice(0, 500)), [], inst.name + ' threw');
    assert.deepEqual(impure, [], 'input handlers changed simulation state directly');
    const cmp = world.compareHashes(all, 0, 'tickExact');
    assert.equal(cmp.mismatches.length, 0, 'diverged: ' + JSON.stringify(cmp.mismatches.slice(0, 3)));
    for (const inst of all) assert.equal(inst.eval('netCounters.desyncsDetected'), 0, inst.name + ' desynced');
    const issued = [...world.issued.values()].length;
    assert.ok(issued > gestures * 0.2, `gestures produced commands: ${issued} from ${gestures}`);
    const kinds = [...gestureKinds.keys()];
    for (const k of ['rightClick:enemyUnit', 'rightClick:enemyBuilding', 'rightClick:ownBuilding', 'rightClick:mine', 'group:set', 'group:recall', 'build', 'boxSelect', 'attackMove']) {
        assert.ok(kinds.some(x => x.startsWith(k)), 'gesture exercised: ' + k);
    }
    console.log(`PASS: UI fuzz: ${gestures} gestures (${kinds.length} kinds) -> ${issued} commands, input never touched simulation state, ${cmp.compared} bit-exact tick comparisons equal`);
})().catch(err => { console.error(err); process.exit(1); });
