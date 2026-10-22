// Simulation-only crowd quality with adaptive steps. No presentation filter.
'use strict';
const assert = require('node:assert/strict');
const H = require('./net-harness.cjs');
for (const dk of [1, 10, 20]) {
    const world = new H.World({ controls: { ...H.SMALL_MATCH_CONTROLS, 'cfg-mapsize': '60', 'cfg-map-type': 'arena' } });
    const inst = world.spawn('forces' + dk, { simWorker: false });
    inst.eval('SIM_OCCUPANCY_ENABLED = false; startSoloGame();');
    const result = JSON.parse(inst.eval(`JSON.stringify((() => {
        for (const u of units) u.dead = true;
        gameTick(); currentTick++;
        const crowd = [], cx = 30 * TILE + 16, cy = 30 * TILE + 16;
        let seed = 17;
        const rnd = () => { seed = seed * 16807 % 2147483647; return seed / 2147483647; };
        for (let i = 0; i < 320; i++) {
            const p = findNearestWalkable(23 + Math.floor(rnd() * 15), 23 + Math.floor(rnd() * 15));
            const u = new Unit(i % 4 ? 'norm' : 'fast', 0, p.x * TILE + 4 + rnd() * 24, p.y * TILE + 4 + rnd() * 24);
            units.push(u); updateUnitSpatial(u); crowd.push(u);
        }
        processAction({ action: 'move', unitIds: crowd.map(u => u.id), targetX: cx, targetY: cy }, 0);
        simDk = ${dk};
        const positions = [];
        for (let t = 0; t < Math.ceil(800 / simDk); t++) { gameTick(); currentTick++; positions.push(crowd.map(u => [u.x, u.y])); }
        let jitter = 0, distance = 0, samples = 0, overlap = 0, pairs = 0, maxStep = 0;
        for (let t = Math.ceil(320 / simDk); t < positions.length; t++) {
            for (let i = 0; i < crowd.length; i++) {
                const a = positions[t - 2][i], b = positions[t - 1][i], c = positions[t][i];
                const dx = c[0] - b[0], dy = c[1] - b[1], ex = b[0] - a[0], ey = b[1] - a[1];
                const d = Math.hypot(dx, dy), e = Math.hypot(ex, ey);
                distance += d; maxStep = Math.max(maxStep, d); samples++;
                if (d > .25 && e > .25 && dx * ex + dy * ey < 0) jitter += Math.min(d, e);
                for (let j = 0; j < i; j++) {
                    const want = crowd[i].getCollisionRadius() + crowd[j].getCollisionRadius();
                    const p = positions[t][j], sep = Math.hypot(c[0] - p[0], c[1] - p[1]);
                    if (sep < want) { overlap += (want - sep) / want; pairs++; }
                }
            }
        }
        return { overlap: overlap / Math.max(1, pairs), jitter: jitter / samples, meanStep: distance / samples, maxStep, pairs };
    })())`));
    assert.deepEqual(inst.errors.map(String), []);
    console.log(`${20 / dk} TPS simulation:`, result);
    assert.ok(result.overlap < .4, 'crowd pressure keeps mean penetration bounded');
    assert.ok(result.maxStep < 12 * dk, 'combined movement and separation stay velocity bounded');
}

// Bodies that start almost coincident must escape, including workers whose
// combat contact radius is smaller than their drawn body. Measure persistent
// deep overlap, not whether the coarse simulation endpoints turn around.
for (const dk of [1, 20]) {
    const world = new H.World({ controls: { ...H.SMALL_MATCH_CONTROLS, 'cfg-mapsize': '60', 'cfg-map-type': 'arena' } });
    const inst = world.spawn('stack' + dk, { simWorker: false });
    inst.eval('SIM_OCCUPANCY_ENABLED = false; startSoloGame();');
    const result = JSON.parse(inst.eval(`JSON.stringify((() => {
        for (const u of units) u.dead = true;
        gameTick(); currentTick++;
        const crowd = [], p = findNearestWalkable(30, 30);
        for (let i = 0; i < 96; i++) {
            const u = new Unit(['tank', 'norm', 'researcher_unit'][i % 3], 0,
                p.x * TILE + 10 + (i % 8) * .125, p.y * TILE + 10 + Math.floor(i / 8) * .125);
            units.push(u); updateUnitSpatial(u); crowd.push(u);
        }
        simDk = ${dk};
        let severe = 0, samples = 0, maxDuration = 0;
        const streak = new Uint16Array(crowd.length * crowd.length);
        for (let t = 0; t < 800 / simDk; t++) {
            gameTick(); currentTick++;
            if (t < 320 / simDk) continue;
            for (let i = 0; i < crowd.length; i++) {
                let deep = false;
                for (let j = 0; j < i; j++) {
                    const a = crowd[i], b = crowd[j], k = i * crowd.length + j;
                    if (a.getCollisionLayer() !== b.getCollisionLayer()) continue;
                    const overlap = Math.hypot(a.x-b.x, a.y-b.y) < .5 * (a.r+b.r);
                    streak[k] = overlap ? streak[k] + simDk : 0;
                    maxDuration = Math.max(maxDuration, streak[k]);
                    deep ||= overlap;
                }
                severe += +deep; samples++;
            }
        }
        return { severeFraction: severe / samples, maxDuration };
    })())`));
    console.log(20 / dk + ' TPS mixed stack:', result);
    assert.deepEqual(inst.errors.map(String), []);
    assert.ok(result.severeFraction < .08, 'small and large bodies escape deep overlaps');
    assert.ok(result.maxDuration < 120, 'near-coincident pairs do not remain stacked for six seconds');
}
