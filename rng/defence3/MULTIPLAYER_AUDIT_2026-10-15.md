# Multiplayer audit, 2026-10-15

The findings of a small multiplayer audit run in another session (user,
2026-10-15), reproduced there against the code as it stood. Each is a bug to
fix (user: fix every divergence and bug found, pre-existing or not). The
status column is kept up to date; what was done for each is under "Fixes". Findings 16-21 came
from a second audit (recovery: reloads, late messages, migration, worker
death, injected divergence), 2026-10-16.

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
| 16 | P1 | Reloading a guest can run a command twice: while it joins, delayed packets are carried on without checking whether their commands already ran (one salvage click marked a building, the delayed duplicate unmarked it after the reload, on both peers). | `main.js` carry | fixed |
| 17 | P2 | A late pause message freezes a recovered guest: a recovery's pause can arrive after its snapshot and resume, and the guest pauses again (stood at tick 94 while the host reached 121, until the 8 s timeout). | `utils_networking.js` | fixed |
| 18 | P2 | A host migration can stop the worker's direct tick delivery: the worker compares the new host's generation counter with the old host's (each host's own count), so a successor with a lower count is refused. | `sim_worker.js` | fixed |
| 19 | P1 | A worker failure mid-match never recovers: errors after load are only logged, the worker stays marked active and its ticks never complete (the host's: the match stalls; a guest's: that guest is stuck). Heartbeats stay healthy, so nothing else steps in. | `sim_client.js` | fixed |
| 20 | P1 | A temporary desync can become a real defeat: a local automatic defeat sends the role change the host takes as a resignation (a king killed only in the guest's divergent state made the host resign that team and end the match). A false local victory left the guest stuck (tick 26, host 329) with no repair asked for. | `player.js`, `utils_networking.js` | fixed |
| 21 | P2 | A lobby visitor can freeze a migration's recovery for 20 s: it waits for every connected peer, also ones that have not loaded the match (they ignore the snapshot). | `utils_networking.js` | fixed |

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

16. Every peer keeps the ids of the commands in the ticks it sealed (host) or
    ran, for 2400 ticks (`lockstepNoteRanCommands`; a successor host has them
    too); a carried command found there is dropped (`lockstepCommandRan`, in
    both carries and where carried commands join a packet). Command ids are
    `peer:epoch:seq`, the epoch new at every reset of the world: a guest's
    reload starts its count again under the same peer id, and its new
    commands took the ids of old ones. Test `multiplayer-ran-once` (fails
    with the check off: the copy was carried).
17. A guest keeps the recovery sessions it resumed from (the last 32) and
    drops a pause of one of them (`_guestResyncDoneHas`). Test
    `multiplayer-recovery-late`.
18. The worker's bundle generation is counted per host: a bundle from
    another host than the last starts the count again (`_simNetGenHost`).
    Test `multiplayer-recovery-late` (a lower count from the new host taken,
    the old host's refused after).
19. The page notices a worker silent for 10 s with work out (ticks,
    requests; counted only while the page runs and work is out:
    `simClientLostHold`), stops ticking, rejects what waited on it, starts a
    new worker (up to 3 times) and, once that loaded, gets the match again: a
    guest asks its host for the whole match (`REQUEST_MATCH_SYNC`, every 8 s
    until it comes); a host hands the match to the first linked player in the
    successor order (`HOST_HANDOVER`; it takes over as in a migration and
    answers `HOST_HANDOVER_DONE`), moves its guests there and joins it for
    the whole match (`demoteSelfToGuest(..., { fullSync })`, a join with no
    tick to resume from). Every team plays on. Alone (solo, a host without
    players) there is nobody to get it from: the overlay says so. Test
    `multiplayer-worker-lost` (guest and host).
20. A defeat the win check finds is automatic: it sends nothing (the host
    took the guest's role change as a resignation) and a repair or restore
    that shows the team alive undoes it (`reviewLocalDefeat`, the worker's
    flag too). The host's roles follow the defeats its own state finds
    (`noteTeamsDefeated`). The end of a match is the host's: it says its
    result (`MATCH_RESULT`); a guest shows its own end once the host's has
    the same winner, and asks for the match when they differ (its end while
    the host seals past it, or 6 s without a word; the host's end and not
    its own; the host answers after its end with the final state). The page
    keeps reviewing while a guest's end waits. Test
    `multiplayer-result-authority` (page and worker: a king killed in a
    guest's state only, a false victory, a real end).
21. A peer without the match that gets a recovery's pause or snapshot says
    so (`RESYNC_NO_MATCH`); the host stops waiting for it and passes it over
    in later recoveries until it is sent the match. Test
    `multiplayer-recovery-late` (a lobby visitor: 100 ms, was 20 s).

Validation in the audit's session: snapshot, rematch, cross-engine math and
real shared-memory worker tests passed; the full worker recovery suite was
interrupted. With a smaller population reservation in the test harness the
migration, desync-recovery and patch suites passed (memory, see 12).
