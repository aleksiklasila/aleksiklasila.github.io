// Upkeep is charged once per elapsed second at any tick rate and step size
// (audit 2026-10-30, D). Below 20 TPS a step of SIM_DK_MAX (20) base ticks
// spans several seconds, but upkeep was deducted once a step: a fifth of it
// at 5 TPS. Real match ticks at 5, 10, 20, 60 and 120 TPS, steps of 1..20
// base ticks; the second's breakdown is fixed (10 a player) so the charge
// counts seconds.
'use strict';
const assert = require('node:assert/strict'), H = require('./net-harness.cjs');
const out = [];
for (const rate of [5, 10, 20, 60, 120]) {
    const controls = { ...H.SMALL_MATCH_CONTROLS, 'cfg-mapsize': '64', 'cfg-map-type': 'arena', 'cfg-tick-rate': String(rate) };
    const world = new H.World({ controls }), i = world.spawn('upkeep-' + rate, { controls, simWorker: false });
    const r = JSON.parse(i.eval(`JSON.stringify((()=>{
 startSoloGame();
 applyTimingConfig(${rate}, LOCKSTEP_PIPELINE_MIN);
 _upKeepSecond = () => players.map(() => ({ total: 10 }));
 let charged = 0;
 const add = addPlayerResource;
 addPlayerResource = function (pid, res, d) { if (pid === 0 && res === 'energy' && d < 0 && d % 10 === 0) charged -= d; return add.apply(this, arguments); };
 const g0 = gameTime, seq = [1, 20, 20, 3, 8, 5, 20, 1, 1, 19, 20, 7, 20, 20, 2];
 for (const dk of seq) { simDk = dk; gameTick(); currentTick++; }
 const seconds = Math.floor(gameTime / TICK_RATE) - Math.floor(g0 / TICK_RATE);
 return { rate: TICK_RATE, charged, seconds, gameTime };
})())`));
    assert.equal(r.rate, rate);
    assert.equal(r.charged, r.seconds * 10, 'upkeep per elapsed second at ' + rate + ' TPS: ' + JSON.stringify(r));
    out.push(rate + ' TPS: ' + r.seconds + ' s');
}
console.log('PASS: upkeep charged once per elapsed second (' + out.join(', ') + ')');
process.exit(0);
