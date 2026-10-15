# Multiplayer audit, 2026-10-15

The findings of a small multiplayer audit run in another session (user,
2026-10-15), reproduced there against the code as it stood. Each is a bug to
fix (user: fix every divergence and bug found, pre-existing or not). The
status column is kept up to date; what was done for each is under "Fixes".

| # | Pri | Finding | Where | Status |
|---|---|---|---|---|
| 1 | P1 | A lost join acknowledgement disables commands for good: `JOIN_LIVE` is sent once and never retried while `awaitingLive` stays true; commands pile up in `heldActions`, past 256 dropped silently. One suppressed acknowledgement left input blocked after 15 s and after a successful soft reconnect (also with the simulation worker). | `utils_resync.js` | fixed |
| 2 | P1 | Obsolete resync messages replace newer recovery state: repair announcements accept older ids (reordered: id 20 at tick 26 replaced by id 10 at tick 16), and an asynchronous patch decode does not check the match/session generation (an old decode resolved after `resyncResetState()` installed its obsolete patch into the reset state). | `utils_resync.js` | fixed |
| 3 | P2 | A full match recovery drops commands issued while the snapshot decodes: the reload calls `startGame()`, which clears local input before the restore keeps it. | `utils_networking.js` | fixed |
| 4 | P2 | An in-flight match load can restart play after leaving: no cancellation check after the snapshot decode or the renderer's preparation. Back in the main menu, the old decode completing set `gameStarted` true again with `isMultiplayer` false. | `utils_networking.js` | fixed |
| 5 | P2 | Rejected patches are counted and acknowledged as applied (`snapDecodeState()` returns null for an unsupported format; `{"v":-999}` reproduces it). The worker path marks completion before the result arrives. | `utils_resync.js` | fixed |
| 6 | P2 | The state hash misses queued-command differences: a backlogged move's destination, or the backlog's order; a pending movement order (the queue is not hashed). | `main.js`, `utils_snapshot.js` | fixed |
| 7 | P2 | Recovery discards pending damage accounting: the cache flush clears accumulated status and laser damage (pending 7/9 → 0/0). They feed shrine income, and laser reports trigger retaliation. | `utils_snapshot.js`, `tower.js` | fixed |
| 8 | P1 | Tick packets carry no match identifier: a bundle from the previous match was accepted in a rematch (divergence). | netcode | fixed |
| 9 | P1 | Bundle checksums ignore packet order, which decides command execution order: two teammates' packets reversed changed the result with the same checksum. | netcode | fixed |
| 10 | P1 | No authority check: a guest can send the host back to the lobby. | netcode | fixed |
| 11 | P2 | A simulation-worker load failure leaves the match stuck at tick 0. | `sim_client.js` | fixed |
| 12 | P2 | One failed wasm allocation leaves the array outside the wasm heap for good (even a full snapshot restore keeps it): every Rust kernel over it throws each tick. Seen in `multiplayer-host-migration`, `multiplayer-desync-recovery`, a patch-suite out-of-memory. | `sim_wasm.js`, unit storage | fixed |
| 13 | P2 | Accepted late commands are not in snapshots. | snapshots | fixed |
| 14 | P1 | Another client can claim a disconnected player's slot with that player's public profile id. | lobby / rejoin | fixed |
| 15 | P2 | A start under high jitter failed (cause not found). | netcode | not reproduced |

## Fixes

1. `JOIN_LIVE` is sent again every second until answered (checked every
   tick, `resyncAfterTick`); only the first answer counts; held commands are
   kept up to 4096, then dropped with a warning. Test
   `multiplayer-resync-messages`.
2. A `RESYNC_AT` / `RESYNC_PATCH` older than the newest id seen from this
   host is ignored (ids count per host: a migration starts them again); a
   decode that finishes after a reset of the repair state, in another match,
   or after a newer id, is dropped. Test `multiplayer-resync-messages`.
3. A reload of the match this peer plays keeps its commands not yet sent
   (with their ids) and those held while joining across `startGame()`: held
   until it is live (`_takeUnsentLocalActions`, `requeueLocalAction`). And
   the host, which leaves a peer it reloads out of the bundles until it is
   live, no longer drops what that peer sent meanwhile (before it knew of
   the reload): carried to its first live ticks, each id once
   (`_hostCarryJoiningCommands`). Test `multiplayer-reload-input`.
4. Each load has a number (`_matchLoadGen`), checked with the network
   session after every await; leaving to the menu or the lobby, or a newer
   load, ends an older one. Test `multiplayer-reload-input`.
5. A refused patch is counted as refused (`netCounters.patchesRefused`), not
   applied, not acknowledged; the worker answers whether its decoder took
   it, and the page counts and acknowledges then. Test
   `multiplayer-resync-messages` (page and worker).
6. The backlog is hashed by each action's content in order (`_actionDigest`,
   made once per action; fields processing adds left out); the queue of
   move orders is hashed (`orderQueueChecksum`: each entry's player, kind,
   target and its units still to apply, as a count and an order-free sum
   kept as units are applied or ordered again, so a restored peer hashes the
   same; the tick's budgets). Test `hash-queued-commands`.
7. The units' unreported damage (over time `stAcc`; laser `lzAcc` with its
   beam `lzBeam`) is unit state (accessors `_dotPending`, `_laserPending`,
   `_laserBeam`): snapshots and patches carry it, the repair flush keeps it.
   (The shrines' pending sum is empty between ticks.) Test
   `pending-damage-restore`.
8. Tick bundles (`w.m`, their copies too), tick packets, hash sums and repair
   messages (`RESYNC_REQUEST/AT/PATCH`) carry the match's session id;
   another match's are dropped (`netCounters.otherMatchDropped`); the
   simulation worker gets the id with its globals. Test
   `multiplayer-tick-messages`.
9. Packets are sealed in peer id order by code units (`tickPacketOrder`;
   `localeCompare` was the locale's, so peers of different languages could
   disagree), and the bundle checksum covers them in that order (it sorted
   them itself). `SIM_RULES_REVISION` 14's list says so. Test
   `multiplayer-tick-messages`.
10. What only the host says (lobby return, removals, ticks, hashes, repairs,
    start, snapshots, pauses...) a guest takes from its host alone, and the
    host never (`NET_HOST_ONLY_MESSAGES`, `netCounters.notFromHostDropped`);
    `RETURN_TO_LOBBY` and `PLAYER_REMOVED_FROM_MATCH` had no check at all.
    Test `multiplayer-authority`.
11. A page whose worker failed makes its own wasm heap (it refused one while
    a worker was enabled: every kernel failed on the page, a multiplayer
    match stood at tick 0); a worker that cannot start a match (`error`
    where `start`) gives it to the page, which decodes the start state it
    kept (with the units). Test `sim-worker-failure` (solo and a guest, load
    and start failures).
12. The reservation of unit columns is at most 8 units a tile of the map (a
    20x20 match: 4096 slots and a 32 MB heap, was ~500 MB); a reservation the
    heap has no room for is made smaller, in the heap (`simHeapRoom`,
    `_simUnitCapThatFits`); columns found outside the heap are made again at
    the next reservation (a restore's); a next size prepared ahead that does
    not fit is dropped. Test `heap-full-reserve`; `multiplayer-host-migration`,
    `-desync-recovery`, `-patch` pass.
13. The host's carried late commands go in its snapshots (`lockstepCarry`),
    and a host restoring a snapshot keeps them (a match-wide resync restores
    the host too, and dropped them). (After a migration the old host's are
    gone with it.) Test `multiplayer-late-carry-restore`.
14. The profile id is made from a key only that browser keeps
    (`profileUidFromKey`, SHA-256); a join sends the key to the host, which
    takes the id only when the key makes it (any host can check it, a new
    one after a migration too; nothing secret is stored or passed on). Old
    profiles get a key and a new id once. Test `multiplayer-authority`.
15. Not reproduced after 12's fix: 24 starts (latency 60-210 ms, jitter
    200-600 ms, 1-3 guests, with and without workers) all started and stayed
    in sync; most likely the same memory failure. Kept as test
    `multiplayer-jitter-start` (6 of them).

Validation in the audit's session: snapshot, rematch, cross-engine math and
real shared-memory worker tests passed; the full worker recovery suite was
interrupted. With a smaller population reservation in the test harness the
migration, desync-recovery and patch suites passed (memory, see 12).
