// Crowds must move smoothly: unit separation may not make units step back
// and forth between ticks (a sawtooth from separating only every few
// ticks). Measures, per unit and tick, reversals of the tick-to-tick
// displacement in a crowd walking to one point and then standing there.
'use strict';
const assert = require('node:assert/strict');
const H = require('./net-harness.cjs');

async function measure() {
    const controls = { ...H.SMALL_MATCH_CONTROLS, 'cfg-mapsize': '40', 'cfg-unit-collision-ticks': '10', 'cfg-max-pop': '5000',
        'cfg-starting-energy': '900000000', 'cfg-full-vis': 'all' };
    const world = new H.World({ network: { latencyMs: 20, jitterMs: 2 }, controls, hashEvery: 100000 });
    const { host } = await H.startHostedMatch(world, { guests: 1, maxMs: 60000 });
    const T = world.atNextSafeTick(`(() => {
        let n = 0;
        for (let i = 0; i < 400; i++) {
            const type = ['norm', 'fast', 'tank', 'norm'][i % 4];
            const u = new Unit(type, 0, (8 + (i % 20) * 0.9) * TILE, (8 + Math.floor(i / 20) * 0.9) * TILE);
            units.push(u); players[0].popCount++; n++;
        }
        __scratch.made = n;
    })()`, 20);
    await world.runUntil(() => host.eval('currentTick') > T + 2, 20000);
    host.eval(`(() => {
        const ids = units.filter(u => !u.dead && u.owner === 0 && !u.isWorker && u.unitType !== 'collector').map(u => u.id);
        queueAction({ action: 'move', unitIds: ids, targetX: GRID_W * TILE * 0.62, targetY: GRID_H * TILE * 0.55 });
        __scratch.jit = { prev: new Map(), last: new Map(), reversals: 0, samples: 0, back: 0, ticks: 0 };
        const o = runOneTick;
        runOneTick = function () {
            const r = o.apply(this, arguments);
            const J = __scratch.jit; J.ticks++;
            for (const u of units) {
                if (u.dead || u.owner !== 0) continue;
                const p = J.prev.get(u.id);
                if (p) {
                    const dx = u.x - p[0], dy = u.y - p[1];
                    const l = J.last.get(u.id);
                    const m = Math.hypot(dx, dy);
                    if (l && m > 0.25 && l[2] > 0.25) {
                        J.samples++;
                        const cos = (dx * l[0] + dy * l[1]) / (m * l[2]);
                        if (cos < -0.5) { J.reversals++; J.back += Math.min(m, l[2]); }
                    }
                    if (m > 0.25) J.last.set(u.id, [dx, dy, m]);
                }
                J.prev.set(u.id, [u.x, u.y]);
            }
            return r;
        };
    })()`);
    await world.run(40000);
    const J = JSON.parse(host.eval(`JSON.stringify({ reversals: __scratch.jit.reversals, samples: __scratch.jit.samples, ticks: __scratch.jit.ticks, back: __scratch.jit.back,
        // Crowd packing at the end: mean penetration of touching same-layer
        // pairs, as a fraction of their collision distance.
        penetration: (() => { const us = units.filter(u => !u.dead && u.owner === 0 && !u.isFlying); let sum = 0, pairs = 0;
            for (let i = 0; i < us.length; i++) for (let j = i + 1; j < us.length; j++) { const a = us[i], b = us[j]; const m = a.getCollisionRadius() + b.getCollisionRadius();
                const d = Math.hypot(a.x - b.x, a.y - b.y); if (d < m) { sum += (m - d) / m; pairs++; } }
            return pairs ? sum / pairs : 0; })() })`));
    world.dispose && world.dispose();
    return J;
}

(async () => {
    const J = await measure();
    const rate = J.reversals / Math.max(1, J.samples);
    console.log('collision smoothness', JSON.stringify({ ...J, rate: +rate.toFixed(4) }));
    assert.ok(J.ticks > 200, 'the crowd ran for a while');
    assert.ok(J.samples > 5000, 'enough moving samples');
    // A smooth crowd reverses rarely (units that genuinely turn around, or
    // a push from a newly arriving neighbour).
    assert.ok(J.penetration < 0.25, `crowds still separate (mean penetration ${J.penetration.toFixed(3)})`);
    assert.ok(rate < 0.015, `back-and-forth steps: ${(rate * 100).toFixed(1)}% of moving unit-ticks`);
    console.log('unit-collision-smoothness: ok');
    process.exit(0);
})().catch(err => { console.error(err); process.exit(1); });
