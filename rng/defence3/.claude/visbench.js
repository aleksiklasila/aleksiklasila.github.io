// Visual check helpers for effects and models (browser console / preview):
//   await (0,eval)(await (await fetch('/rng/defence3/.claude/visbench.js')).text());
//   await VIS.setup()            // small arena: every unit type, every turret
//   VIS.ticks(60)                // run the fight
//   await VIS.shot('name')       // render and POST the 3D canvas as PNG to
//                                // http://127.0.0.1:8124/save?name=... (any
//                                // small local server that writes the body)
(() => {
const sleep = ms => new Promise(r => setTimeout(r, ms));
function place(key, owner, gx, gy) {
    if (!placeBuilding(gx, gy, key, owner, { silent: true, ignorePlacementRules: true, buildEnabled: true, autoUpgradeEnabled: true })) return null;
    const item = getTileEntityRef(gx, gy);
    if (!item) return null;
    Object.assign(item, { underConstruction: false, isUpgrading: false });
    if (item instanceof Tower) item.updateStats();
    if (item.maxEnergy) item.energy = item.maxEnergy;
    updateItemTextCache(item);
    return item;
}
const VIS = {
    async setup({ size = 60, perTeam = 150, turrets = 20 } = {}) {
        if (!window.RB) await (0, eval)(await (await fetch('/rng/defence3/.claude/renderbench.js')).text());
        await RB.setup({ size, perTeam, turrets });
        return units.length;
    },
    ticks(n) {
        for (let i = 0; i < n; i++) {
            gameOver = false; RB.refill();
            if (i % 60 === 0) RB.issue(RB.SCENARIOS.fight.tick(0));
            gameTick();
        }
    },
    view(mode = '3d', zoom = 1.6, focus = null, alpha = .5) {
        setRenderDimensionMode(mode);
        if (!focus) {
            const a = units.filter(u => !u.dead);
            focus = { gx: a.reduce((s, u) => s + u.x, 0) / a.length / TILE, gy: a.reduce((s, u) => s + u.y, 0) / a.length / TILE };
        }
        camera.zoom = zoom; if (camera.targetZoom !== undefined) camera.targetZoom = zoom;
        camera.x = focus.gx * TILE - viewW / zoom / 2; camera.y = focus.gy * TILE - viewH / zoom / 2;
        _tickAccumulator = TICK_MS * alpha;
        renderFrame(performance.now());
        return { focus, fx: renderer3dFxBatch ? renderer3dFxBatch.total : -1, units: units.filter(u => !u.dead).length, projectiles: projectiles.length };
    },
    async shot(name, mode = '3d', zoom = 1.6, focus = null, alpha = .5) {
        const info = VIS.view(mode, zoom, focus, alpha);
        const data = renderer3dInstance.canvas.toDataURL('image/png');
        await fetch('http://127.0.0.1:8124/save?name=' + name, { method: 'POST', body: data });
        return info;
    },
    // One of every unit (two rows: owners 0 and 1) beside every turret, a
    // producing barrack, spawners and houses. Call after setup({perTeam: 0}).
    lineup({ gx = 10, gy = 20 } = {}) {
        const types = ['norm', 'fast', 'tank', 'boss', 'king', 'flying', 'scout', 'mole', 'snake', 'poison_resistant',
            'fire_resistant', 'water_resistant', 'ice_resistant', 'laser_resistant', 'builder_unit', 'collector',
            'salvager_unit', 'healer_unit', 'researcher_unit'];
        const made = [];
        types.forEach((t, i) => {
            if (!BASE_UNIT_STATS[t]) return;
            for (let pid = 0; pid < 2; pid++) {
                const u = new Unit(t, pid, (gx + i * 1.5) * TILE + 16, (gy + pid * 2) * TILE + 16);
                applyUnitLevelScaling(u, 1); u.energy = u.preComputed.maxEnergy;
                units.push(u); players[pid].popCount++; updateUnitSpatial(u); made.push(u);
            }
        });
        return made.length;
    },
    // Attacker/target pairs of every combat type and a row of every turret
    // with targets; everything is kept alive by arenaTicks().
    arena({ gx = 8, gy = 8 } = {}) {
        for (const u of units) u.dead = true;
        for (let i = 0; i < 3; i++) gameTick();
        const spawn = (t, pid, x, y) => {
            const u = new Unit(t, pid, x * TILE + 16, y * TILE + 16);
            applyUnitLevelScaling(u, 1); u.energy = u.preComputed.maxEnergy;
            units.push(u); players[pid].popCount++; updateUnitSpatial(u); return u;
        };
        const types = ['norm', 'fast', 'tank', 'boss', 'king', 'flying', 'scout', 'mole', 'snake',
            'poison_resistant', 'fire_resistant', 'water_resistant', 'ice_resistant', 'laser_resistant'];
        VIS.pairs = types.map((t, i) => {
            const x = gx + (i % 7) * 2.2, y = gy + Math.floor(i / 7) * 2.5;
            return { type: t, a: spawn(t, 0, x, y), b: spawn('norm', 1, x + .45, y) };
        });
        const kinds = ['pistol', 'smg', 'water', 'poison', 'fire', 'sand_gun', 'ice', 'sniper', 'elements', 'watch_tower', 'laser', 'laser'];
        VIS.turrets = [];
        kinds.forEach((k, i) => {
            const tx = gx + i * 1.6 | 0, ty = gy + 8;
            const t = place(k, 1, i === 11 ? (gx + 10 * 1.6 | 0) : tx, i === 11 ? ty + 3 : ty) ;
            if (t) VIS.turrets.push(t);
            if (k !== 'laser') VIS.pairs.push({ type: 'target_' + k, a: null, b: spawn('tank', 0, tx, ty + 2.5) });
        });
        recalculateLaserConnections && recalculateLaserConnections();
        return { pairs: VIS.pairs.length, turrets: VIS.turrets.length };
    },
    arenaTicks(n) {
        for (let i = 0; i < n; i++) {
            RB.refill();
            for (const p of VIS.pairs) for (const u of [p.a, p.b]) if (u) {
                u.energy = u.preComputed.maxEnergy; u.dead = false;
                if (u._home === undefined) u._home = [u.x, u.y];
                if (Math.hypot(u.x - u._home[0], u.y - u._home[1]) > 6) { u.x = u.prevX = u._home[0]; u.y = u.prevY = u._home[1]; updateUnitSpatial(u); }
                if (p.a && u === p.a) { u.targetUnit = p.b; u.commandState = CMD_ATTACKING; }
            }
            for (const t of VIS.turrets) t.energy = t.maxEnergy;
            gameTick();
        }
    },
    sleep
};
window.VIS = VIS;
return 'VIS ready';
})();
