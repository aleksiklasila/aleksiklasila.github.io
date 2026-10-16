// Perturbed math, in Node (not other browser engines: this does not show
// that Firefox or Safari compute the same; tests/browser-* runs real pages
// in Edge only): two guests' Math return slightly different results for
// every function whose result ECMAScript does not pin down (pow, exp, log,
// trig, hypot...), and a square root one unit in the last place off for
// about half the inputs, as another engine might (net-harness.cjs
// makeForeignMath). The simulation must not depend on them (the square root
// is checked at load and replaced by a correctly rounded one where it is
// off), so the chaotic match stays in sync with no resync, its exact
// fingerprints (unit paths' waypoints too) equal every tick.
const assert = require('node:assert/strict');
const C = require('./multiplayer-chaos-determinism.test.cjs');

(async () => {
    const rows = [];
    for (const mapType of (process.argv[2] ? [process.argv[2]] : ['solar_system', 'islands'])) {
        const { world, host, guests, all } = await C.setupChaosWorld(mapType, 4242, { guestOptions: [{ foreignMath: true }, {}, { foreignMath: true }], exactHashes: true });
        assert.notEqual(guests[0].eval('Math.pow(1.1, 2.5)'), host.eval('Math.pow(1.1, 2.5)'), 'guest math differs');
        // (The off square root found at load and replaced; V8's kept.)
        assert.deepEqual(all.map(i => i.eval('DET_SQRT_NATIVE')), [true, false, true, false], 'square roots checked');
        assert.equal(guests[0].eval('Math.sqrt(3)'), host.eval('Math.sqrt(3)'), 'the replaced square root is correctly rounded');
        let s = 99;
        const rand = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
        const end = world.now + 25000;
        while (world.now < end) {
            for (const inst of all) for (let k = 0; k < 2; k++) if (rand() < 0.7) inst.eval(C.CHAOS_COMMAND + '(' + rand() + ')');
            await world.run(200);
        }
        await world.run(2000);
        for (const inst of all) {
            assert.deepEqual(inst.errors.map(e => String(e.stack || e).slice(0, 400)), [], inst.name + ' threw');
            assert.equal(inst.eval('netCounters.desyncsDetected'), 0, mapType + ': ' + inst.name + ' desynced with foreign math');
            assert.equal(inst.snapshotsApplied, 1, mapType + ': ' + inst.name + ' resynced');
        }
        const cmp = world.compareHashes(all, 0, 'tickExact');
        assert.equal(cmp.mismatches.length, 0, mapType + ': ' + JSON.stringify(cmp.mismatches.slice(0, 3)));
        rows.push(`${mapType}: ${cmp.compared} tick hashes bit-exact fingerprints equal across engines`);
    }
    console.log('PASS: cross-engine math\n  ' + rows.join('\n  '));
})().catch(err => { console.error(err); process.exit(1); });
