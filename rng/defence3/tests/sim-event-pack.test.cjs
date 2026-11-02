// The tick's side effects the simulation worker sends the page (sounds,
// damage flashes, alerts, particles, fx, energy/star deltas) are packed into
// one Float64Array with a string table (sim_worker.js _simEv) and replayed by
// the page (sim_client.js _simClientReplayEvents). Every handler must get the
// values it got from the old array events.
//   node tests/sim-event-pack.test.cjs
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm'), assert = require('assert');
const cut = (file, a, b) => { const t = fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), i = t.indexOf(a), j = t.indexOf(b, i); assert.ok(i >= 0 && j > i, file + ': ' + a); return t.slice(i, j); };
const worker = cut('src/sim/sim_worker.js', '// ---- side effects the page replays', '// Set when the simulation') + cut('src/sim/sim_worker.js', 'function _simIsRef', '// Hooks that only drive');
const client = cut('src/sim/sim_client.js', '// (Packed by the worker', "// This player's sight grid");
class Unit { constructor(id) { this.id = id; } }
const got = [];
const ctx = { Unit, Map, Float64Array, Math, got, combatFxSpan: null };
for (const name of ['playSound', 'createExplosion', 'createDirectedParticles', 'recordEnergyDelta']) ctx[name] = (...a) => got.push([name, ...a]);
ctx.recordDamageVisual = (t, a, o) => got.push(['dmg', t, a, o]);
ctx.pushHostileDamageAlert = (t, a, o) => got.push(['alert', t, a, o]);
ctx.recordCombatFx = (...a) => got.push(['fx', ...a]);
ctx.recordAstarDelta = (p, d, o, s) => got.push(['astar', p, d, o.unitType, s]);
ctx._simClientResolve = r => r[0] === 'u' ? 'unit' + r[1] : 'b' + r[1] + ',' + r[2];
vm.createContext(ctx);
vm.runInContext(worker + client + ';this._simEv=_simEv;this._simEvTake=_simEvTake;this._simIsRef=_simIsRef;this.replay=_simClientReplayEvents;', ctx);
const u = new Unit(77), b = { gx: 12, gy: 345 }, style = { color: 'red' };
const want = [];
ctx._simEv('s', 4, 'shot', 1.5, -2.25, ''); want.push(['playSound', 'shot', 1.5, -2.25, '']);
ctx._simEv('s', 4, 'boom', 3, 4, 2); want.push(['playSound', 'boom', 3, 4, 2]);
ctx._simEv('d', 3, u, 12.5, null); want.push(['dmg', 'unit77', 12.5, undefined]);
ctx._simEv('d', 3, b, 3, 2); want.push(['dmg', 'b12,345', 3, 2]);
ctx._simEv('h', 3, u, 9, 1); want.push(['alert', 'unit77', 9, 1]);
ctx._simEv('x', 4, 10, 20, '#ff0', 8); want.push(['createExplosion', 10, 20, '#ff0', 8]);
ctx._simEv('p', 6, 1, 2, 3, 4, 'blue', 5); want.push(['createDirectedParticles', 1, 2, 3, 4, 'blue', 5]);
ctx._simEv('f', 8, 'laser', 1, 2, 3, 4, null, 5, 6); want.push(['fx', 'laser', 1, 2, 3, 4, undefined, 5, 6]);
ctx._simEv('f', 8, 'beam', 1, 2, 3, 4, style, 0, 0);
ctx._simEv('E', 3, 1, 'builder', -40); want.push(['recordEnergyDelta', 1, 'builder', -40]);
ctx._simEv('A', 4, 0, 'norm', 'path', -3); want.push(['astar', 0, -3, 'norm', 'path']);
for (let i = 0; i < 20000; i++) ctx._simEv('s', 4, 'shot', i, i, '');
const transfer = [], ev = ctx._simEvTake(transfer);
assert.strictEqual(transfer.length, 1);
assert.strictEqual(ev.x.length, 1, 'the object style goes as an array');
const msg = structuredClone(ev);
ctx.replay(msg);
// (The fallback event replays after the packed ones.)
const objFx = got.pop();
assert.deepStrictEqual(objFx, ['fx', 'beam', 1, 2, 3, 4, { color: 'red' }, 0, 0]);
assert.deepStrictEqual(got.slice(0, want.length), want);
assert.strictEqual(got.length, want.length + 20000);
assert.deepStrictEqual(got[got.length - 1], ['playSound', 'shot', 19999, 19999, '']);
const again = ctx._simEvTake([]);
assert.strictEqual(again.f.length, 0, 'reset after take');
console.log('sim-event-pack ok:', got.length, 'events,', ev.f.byteLength, 'bytes');
