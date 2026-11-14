'use strict';
// Step-size compensation calibrator (deltatick fairness). For each step size in the knob table (data_static.js
// SIM_DK_KNOBS), measures what a base tick gives at that step size against dk 1, averaged over a scene set, and
// solves each knob so the average is 1.0; rewrites the table between the DK-KNOBS markers.
// Knob 'move': crowd marchers' speed (all unit types of the scenes, equally weighted): the wanted step of a mover in
// a crowd is scaled by 1 + move x density. The rate is close to linear in the knob: two trials, a linear solve, one
// check (a second solve from the two nearest when the check is off by more than --tol).
// Run it again after any change to movement, occupancy or stepping.
//   node tests/dk-calibrate.cjs [--sizes=2,4,8,16] [--maps=arena,random,crossroads] [--counts=1,2] [--jobs=4]
//     [--trial=0.5] [--tol=0.01] [--dry] (no write)
// One run (internal): node tests/dk-calibrate.cjs --one='{"K":10,"map":"arena","mult":1,"move":0.5}'
const path = require('node:path'), fs = require('node:fs'), { spawn } = require('node:child_process');
const arg = (k, d) => { const a = process.argv.find(x => x.startsWith('--' + k + '=')); return a ? a.slice(k.length + 3) : d; };

// ---- one scene run: mean px a base tick by unit type of own fighters ordered across the map ----
async function one(o) {
    const H = require('./net-harness.cjs');
    const controls = { ...H.SMALL_MATCH_CONTROLS, 'cfg-mapsize': '48', 'cfg-map-type': o.map, 'cfg-max-pop': '5000', 'cfg-full-vis': 'all' };
    const world = new H.World({ simWorker: true, controls });
    const inst = world.spawn('solo', { controls });
    inst.eval(`netStepTicks = () => ${o.K};`);
    const spawnCounts = { 'unit:king': { 1: 1 }, 'unit:norm': { 1: Math.round(40 * o.mult) }, 'unit:fast': { 1: Math.round(10 * o.mult) } };
    inst.eval(`startingResourcesConfig = ${JSON.stringify({ spawnCounts, researchLevels: {} })}; startSoloGame();`);
    await world.run(1500);
    // (The simulation's context is made at the match's start: the trial value set after it.)
    if (o.move !== undefined) inst.evalSim(`SIM_DK_KNOB_OVERRIDE = { move: ${Number(o.move)} }`);
    await world.run(1000);
    inst.evalSim(`(() => {
        const mine = units.filter(u => !u.dead && u.owner === localPlayerId && !u.workerType && !u.isKing);
        const k = units.find(u => u.isKing && u.owner === localPlayerId);
        __scratch.mv = { ids: mine.map(u => u.id), start: Object.fromEntries(mine.map(u => [u.id, [u.x, u.y, u.unitType]])), tx: (k.x < GRID_W * TILE / 2 ? 0.8 : 0.2) * GRID_W * TILE, ty: k.y };
    })()`);
    const n = Number(inst.evalSim('__scratch.mv.ids.length'));
    inst.eval(`queueAction({ action: 'move', unitIds: ${inst.evalSim('JSON.stringify(__scratch.mv.ids)')}, targetX: ${inst.evalSim('__scratch.mv.tx')}, targetY: ${inst.evalSim('__scratch.mv.ty')} })`);
    await world.runUntil(() => Number(inst.evalSim(`units.filter(u => __scratch.mv.start[u.id] && Math.hypot(u.x - __scratch.mv.start[u.id][0], u.y - __scratch.mv.start[u.id][1]) > 0.5).length`)) > n / 2, 4000, 10);
    const snap = () => JSON.parse(inst.evalSim(`JSON.stringify({ g: gameTime, at: Object.fromEntries(units.filter(u => __scratch.mv.start[u.id]).map(u => [u.id, [u.x, u.y]])) })`));
    const m0 = snap();
    await world.runUntil(() => Number(inst.evalSim('gameTime')) >= m0.g + 120, 40000, 10);
    const m1 = snap(), start = JSON.parse(inst.evalSim('JSON.stringify(__scratch.mv.start)'));
    const rate = {};
    for (const id of Object.keys(m1.at)) {
        const a = m0.at[id], b = m1.at[id];
        if (a && b) (rate[start[id][2]] ||= []).push(Math.hypot(b[0] - a[0], b[1] - a[1]) / (m1.g - m0.g));
    }
    world.instances.forEach(i => { try { i.kill({ silent: true }); } catch { } });
    return Object.fromEntries(Object.entries(rate).map(([t, a]) => [t, a.reduce((s, v) => s + v, 0) / a.length]));
}
if (arg('one', '')) {
    one(JSON.parse(arg('one', ''))).then(r => { console.log('RESULT ' + JSON.stringify(r)); process.exit(0); }, e => { console.error(e); process.exit(1); });
    return;
}

// ---- the calibration ----
const sizes = arg('sizes', '2,4,8,16').split(',').map(Number), maps = arg('maps', 'arena,random,crossroads').split(','), counts = arg('counts', '1,2').split(',').map(Number);
const jobs = Number(arg('jobs', 4)), trial = Number(arg('trial', 0.5)), tol = Number(arg('tol', 0.01)), dry = process.argv.includes('--dry');
const scenes = maps.flatMap(map => counts.map(mult => ({ map, mult })));
let running = 0; const queue = [];
function runOne(o) {
    return new Promise((ok, bad) => {
        const go = () => {
            running++;
            const p = spawn(process.execPath, ['--max-old-space-size=4096', __filename, '--one=' + JSON.stringify(o)], { cwd: path.join(__dirname, '..'), stdio: ['ignore', 'pipe', 'pipe'] });
            let out = '', err = '';
            p.stdout.on('data', d => out += d); p.stderr.on('data', d => err += d);
            p.on('exit', code => {
                running--; if (queue.length) queue.shift()();
                const m = /RESULT (.*)/.exec(out);
                if (code === 0 && m) ok(JSON.parse(m[1])); else bad(new Error('run failed ' + JSON.stringify(o) + ': ' + err.slice(-400)));
            });
        };
        if (running < jobs) go(); else queue.push(go);
    });
}
// The scenes' mean ratio to dk 1 at a step size and knob value (types equally weighted, then scenes).
async function ratio(K, move, base) {
    const rs = await Promise.all(scenes.map(sc => runOne({ K, map: sc.map, mult: sc.mult, move })));
    const qs = rs.map((r, i) => { const b = base[i], ts = Object.keys(b).filter(t => r[t] > 0 && b[t] > 0); return ts.reduce((s, t) => s + r[t] / b[t], 0) / ts.length; });
    return qs.reduce((s, v) => s + v, 0) / qs.length;
}
(async () => {
    const t0 = Date.now();
    const base = await Promise.all(scenes.map(sc => runOne({ K: 1, map: sc.map, mult: sc.mult })));
    const out = {};
    await Promise.all(sizes.map(async K => {
        const [r0, r1] = await Promise.all([ratio(K, 0, base), ratio(K, trial, base)]);
        const solve = (a, ra, b, rb) => rb === ra ? a : Math.max(0, a + (1 - ra) * (b - a) / (rb - ra));
        let c = solve(0, r0, trial, r1);
        let rc = await ratio(K, c, base);
        if (Math.abs(rc - 1) > tol) { const near = rc < 1 ? (r1 > 1 ? [c, rc, trial, r1] : [0, r0, c, rc]) : [0, r0, c, rc]; c = solve(...near); rc = await ratio(K, c, base); }
        out[K] = { move: +c.toFixed(3), ratio: +rc.toFixed(4), without: +r0.toFixed(4) };
        console.log(`dk ${K}: move ${c.toFixed(3)} -> ratio ${rc.toFixed(4)} (without ${r0.toFixed(4)}, at ${trial} ${r1.toFixed(4)})`);
    }));
    console.log('minutes ' + ((Date.now() - t0) / 60000).toFixed(1));
    const dks = [1, ...sizes.slice().sort((a, b) => a - b)];
    const line = `const SIM_DK_KNOBS = { dk: [${dks.join(', ')}], move: [${dks.map(k => k === 1 ? 0 : out[k].move).join(', ')}] };`;
    console.log(line);
    if (dry) return process.exit(0);
    const file = path.join(__dirname, '..', 'src', 'data', 'data_static.js');
    const raw = fs.readFileSync(file, 'utf8'), nl = raw.includes('\r\n') ? '\r\n' : '\n';
    const re = /(\/\/ DK-KNOBS-BEGIN\r?\n)[^\n]*\r?\n(\/\/ DK-KNOBS-END)/;
    if (!re.test(raw)) throw new Error('DK-KNOBS markers not found in ' + file);
    fs.writeFileSync(file, raw.replace(re, `$1${line}${nl}$2`));
    console.log('written: ' + file);
    process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
