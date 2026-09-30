'use strict';
const assert = require('node:assert/strict');
const H = require('./net-harness.cjs');
const world = new H.World({ controls: H.SMALL_MATCH_CONTROLS });
const inst = world.spawn('columns', { simWorker: false });
inst.eval('startSoloGame();');
inst.eval(`__scratch.referenceFrame = (() => { const _simVisPhase = [0,0]; return (${require('./unit-frame-reference.cjs')}); })();`);
const result = JSON.parse(inst.eval(`JSON.stringify((() => {
    const fail = msg => { throw new Error(msg); };
    const layout = simFrameViews(new ArrayBuffer(64 * SIM_FRAME_SLOT_BYTES), 64);
    let offset = 0;
    for (const [keys, bytes] of [[SIM_FRAME_F32,4], [[...SIM_FRAME_I32,'order'],4], [SIM_FRAME_I16,2], [SIM_FRAME_U8,1]])
        for (const k of keys) { if (layout[k].byteOffset !== offset) fail('frame layout '+k); offset += bytes*64; }
    if (offset !== 64 * SIM_FRAME_SLOT_BYTES) fail('frame size');
    // Growth must update every live accessor, including objects that existed
    // before reallocation. Fractions stay Float64, not render precision.
    const first = units[0], x = first.x = 123.1234567890123;
    for (let i = 0; i < 2100; i++) { const u = new Unit('norm', i & 1, 50+i%20, 50+(i%19)); units.push(u); }
    // (Positions are unit fields, copied into the columns after each move.)
    simUnitMirror(first);
    if (first.x !== x || first._us.x[first._si] !== x) fail('growth/precision');
    const retired = units.pop(), oldX = retired.x, slot = retired._si;
    removeUnitSpatial(retired); retired.dead = true; simUnitStateCollect(true);
    const replacement = new Unit('norm', 0, 300, 300); units.push(replacement);
    if (replacement._si !== slot || retired.x !== oldX) fail('slot retirement');
    retired.x = -100;
    if (replacement.x !== 300) fail('stale reference wrote reused slot');
    let compared = 0;
    for (let t = 0; t < 20; t++) {
        gameTick();
        // Exercise each animation branch, numeric edge and target facing.
        for (let i = 0; i < 40; i++) {
            const u = units[i];
            u.attackFlash = [0, 1, 8, 9, 255, 0.5][(i+t)%6];
            u.attackTarget = i%2 ? units[(i+1)%40] : null;
            u._visStill = gameTime - (i%5)*20;
        }
        for (const u of units) if (!u.dead) _simRenderSlotOf(u);
        const R = _simRenderSlots, px = R.lastX.slice(), py = R.lastY.slice(), tick = R.tick;
        const actual = simFrameEncode(), A = simFrameViews(actual.buf, actual.cap);
        R.lastX.set(px); R.lastY.set(py); R.tick = tick;
        const expected = __scratch.referenceFrame(), B = simFrameViews(expected.buf, expected.cap);
        if (actual.count !== expected.count) fail('frame count');
        for (let i = 0; i < actual.count; i++) {
            const s = A.order[i];
            if (s !== B.order[i]) fail('frame order');
            for (const k of [...SIM_FRAME_F32, ...SIM_FRAME_I32, ...SIM_FRAME_I16, ...SIM_FRAME_U8]) {
                if (!Object.is(A[k][s], B[k][s])) fail('frame '+k+' slot '+s+': '+A[k][s]+' vs '+B[k][s]);
                compared++;
            }
        }
        simFrameReturn(actual.buf); simFrameReturn(expected.buf);
    }
    const saved = snapEncodeState(), hash = computeLockstepStateHashFast(gameTime);
    snapDecodeState(saved); simUnitStateCollect();
    if (computeLockstepStateHashFast(gameTime) !== hash) fail('snapshot columns');
    if (!units.every(u => u._us && u._us.x[u._si] === u.x)) fail('restored units not column-backed');
    return { compared, units:units.length, capacity:_simUnitState.cap };
})())`));
assert.deepEqual(inst.errors.map(String), []);
assert.ok(result.compared > 100000);
console.log('PASS: shared unit growth, Float64 precision, stale references, slot reuse, snapshot restore; scalar frame oracle:', result);
