// A guest takes the host's input delay and pace only from a message no
// older than the newest it has seen (audit 2026-10-30, E). The channel is
// unordered and resends, repeated copies and the host worker's own seals
// come late: applied as they came, an old one put back a stale delay or pace.
// Also: a message without a version (an older host) is taken, a new host or
// match counts anew, and the host's version moves only when a value changes.
'use strict';
const assert = require('node:assert/strict'), H = require('./net-harness.cjs');
const controls = { ...H.SMALL_MATCH_CONTROLS, 'cfg-mapsize': '64', 'cfg-map-type': 'arena' };
const world = new H.World({ controls }), i = world.spawn('stale-pacing', { controls, simWorker: false });
const r = JSON.parse(i.eval(`JSON.stringify((()=>{
 startSoloGame();
 isHost = false; matchStartSessionId = 'mA'; wsHostId = 'h1';
 const got = [];
 const send = (q, d, pace) => { handleIncomingTickBundle(null, { type: 'TICK_BUNDLE', m: matchStartSessionId, q, d, pace, c: 1, bundle: { tick: -1, packets: [] } }); got.push([netMatchInputDelay, netMatchTickMs]); };
 send(5, 4, 100);          // current
 send(3, 1, 60);           // late: dropped
 send(5, 4, 100);          // a copy of the current: taken (same values)
 send(6, 2, 80);           // newer
 send(undefined, 3, 90);   // no version (older host): taken
 send(4, 5, 120);          // older than 6: dropped
 wsHostId = 'h2';          // migration: a new host's versions count anew
 send(1, 6, 140);
 matchStartSessionId = 'mB';
 send(1, 7, 150);          // a new match
 // Host side: the version moves only when a value changes.
 const v1 = netHostCtlVersion(3, 50), v2 = netHostCtlVersion(3, 50), v3 = netHostCtlVersion(4, 50), v4 = netHostCtlVersion(4, 55);
 return { got, dropped: netCounters.staleCtlDropped | 0, v: [v1, v2, v3, v4] };
})())`));
assert.deepEqual(r.got, [[4, 100], [4, 100], [4, 100], [2, 80], [3, 90], [3, 90], [6, 140], [7, 150]], JSON.stringify(r));
assert.equal(r.dropped, 2);
assert.equal(r.v[1], r.v[0]); assert.equal(r.v[2], r.v[0] + 1); assert.equal(r.v[3], r.v[0] + 2);
console.log('PASS: stale pacing/input-delay messages are ignored ' + JSON.stringify(r));
process.exit(0);
