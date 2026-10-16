# Multiplayer audit, 2026-10-15

The findings of a small multiplayer audit run in another session (user,
2026-10-15), reproduced there against the code as it stood. Each is a bug to
fix (user: fix every divergence and bug found, pre-existing or not). The
status column is kept up to date; what was done for each is under "Fixes". Findings 16-21 came
from a second audit (recovery: reloads, late messages, migration, worker
death, injected divergence), 2026-10-16. Findings 22-30 came from a third,
read-only audit (35 suites passing, faults injected beside them), 2026-10-16.
Findings 31-34 from a fourth, on portability and test coverage, 2026-10-16;
35 found running the suites in worker mode; 36-39 from a fifth (roles,
teams and rematches under delayed messages), 2026-10-16.

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
| 22 | P1 | Stale recovery messages overwrite newer state: only the last applied recovery counted as a duplicate. A replayed older snapshot rolled a guest from tick 425 back to 386 and paused it; an old resume ended a newer recovery's pause; a patch still decoding through a host change was taken from the former host. | `utils_networking.js`, `utils_resync.js` | fixed |
| 23 | P1 | A worker lost while it restores a snapshot is never noticed: the watch skipped a world not loaded yet. A guest stood at tick 26 for 25 s, not ready, no recovery. | `sim_client.js` | fixed |
| 24 | P1 | The worker's own bundle channel took another match's bundles: `_simNetMessage` checked sender, generation and checksum, not the match; a bundle tagged `previous-match` went into the sealed ticks. | `sim_worker.js` | fixed |
| 25 | P1 | Reconnect identity bypass: the key was not checked when the claimed profile id equals the connection's peer id; a peer id equal to a disconnected player's public id took its role and team without the key. (Also: another profile under a gone player's freed peer id took the slot.) | `utils_networking.js` | fixed |
| 26 | P1 | A defeated host cannot resign a leaving player's team: its administrative commands went through `queueAction`, which refuses all but a resignation once defeated. Three teams, the host resigned, a player left: that team stayed in, the last player did not win. | `worker.js`, `main.js` | fixed |
| 27 | P2 | A command sent but never delivered disappears in a match reload: "sent" was taken for safe. With its packet suppressed while the snapshot decoded, a move ran on no peer. | `utils_networking.js`, `main.js` | fixed |
| 28 | P2 | A refused full snapshot was acknowledged: `_guestReceiveSnapshot` ignored `applyAuthoritativeStateSnapshot` returning false (an invalid format counted a successful resync and sent `MATCH_STATE_SNAPSHOT_APPLIED`); the worker's restore was not waited for. | `utils_networking.js`, `sim_client.js`, `sim_worker.js` | fixed |
| 29 | P2 | A newer patch that came before its announcement was dropped while an older repair waited (its tick differed); its announcement then left the guest waiting for a patch it had had. | `utils_resync.js` | fixed |
| 30 | P2 | A malformed patch stalled the page's ticks for good: a throw while parsing or applying left the patch in place, tried again at every pump; the missing-patch wait never applied (stood at tick 26 for 15 s). Worker requests that threw never answered. | `utils_resync.js`, `sim_worker.js`, `sim_client.js` | fixed |
| 31 | P3 | The cross-engine test overstated its coverage (perturbed math in Node, not other engines), and its exact fingerprint missed path waypoints (a moved waypoint, same length: same fingerprint). | `tests/net-harness.cjs`, `multiplayer-cross-engine` | fixed |
| 32 | P2 | `Math.sqrt` taken as exact: ECMAScript lets it be approximated; a one-unit-in-the-last-place difference changed a projectile's velocity (sensitivity shown, no engine seen to differ). | `utils_common.js` | fixed |
| 33 | P3 | Map generation from the seed used Math's trigonometry: under perturbed trigonometry an island spawn moved from (20,47) to (19,47) (multiplayer sends the host's map, so matches were not affected). | `map.js` | fixed |
| 34 | P3 | `wasm/README.md` promised a JavaScript fallback that no longer exists (wasm with shared memory is required, on purpose). | `wasm/README.md` | fixed |
| 35 | P1 | In worker mode a rematch left its guests out: the worker kept the last match's defeated teams and sent them in the new match's frames; the host took those players for spectators and sealed the ticks without their commands (in sync, so no hash showed it). | `sim_worker.js` | fixed |
| 36 | P1 | Resignation timing changes the winner: teams `[0,0,1]`, the guest teammate resigns; normally only that guest spectates and the match goes on, but with its `MATCH_ROLE_UPDATE` delayed by 1 s the whole team resigns and team 1 wins. (Page and worker.) | `main.js` resign handler, `utils_networking.js` | fixed |
| 37 | P1 | A team change during the start leaves a guest's commands without effect: host renderer preparation delayed 500 ms, a guest's colour change delivered meanwhile; the guest starts as team 1 while the roster gives it team 0 or 3; its Hold does nothing (peers stay in sync, no hash sees it). | `utils_networking.js` team change | fixed |
| 38 | P1 | A delayed `RETURN_TO_LOBBY` ejects a guest from the rematch: three players, rematch, one guest's message delayed 4.5 or 8 s; it stays in the lobby at tick 0 (60 s later still out) while the others play. | `utils_networking.js` lobby return, rematch | fixed |
| 39 | P2 | A rematch promotes spectators (and lobby visitors who only wait) to playing teams without their choice. | `utils_networking.js` `hostRematch` | fixed |

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

22. A host numbers its recoveries in order (`g`, from the clock so a host
    page reloaded under the same id goes on above its old numbers,
    `_hostNextResyncGen`); every pause, resume and snapshot carries it and
    its match (`m`). A guest keeps the newest number seen from this host in
    this match (`_guestRecoveryFresh`) and drops what is older
    (`netCounters.staleRecoveryDropped`) or of another match; a snapshot is
    applied only if, after its decode, it is still of this host, match and
    the newest recovery. A resume ends only its own recovery, and only once
    that recovery's snapshot is restored here (`_guestTakeResume`; before:
    held, as when it overtook the decode). A patch remembers its host:
    finishing its decode after a host change, it is dropped. Test
    `multiplayer-recovery-order`.
23. A worker loading a match (a start, a restore) is watched too: silent
    for 5 s and 2 s a MB of what it loads (`simClientLostHold`,
    `_simClientLoadLimitMs`), it is lost: a running multiplayer match is got
    again as for a worker lost mid-match (`_simClientWorkerLost`); a match's
    first load (or solo) runs on the page, as when a start fails, with a new
    worker for later matches. A guest waiting on its worker's restore does
    not time its recovery out meanwhile (`simClientLoading`). Test
    `multiplayer-recovery-authority` (guest's and host's worker).
24. The worker takes a bundle over its own channel only if tagged with its
    match (untagged ones too are refused there), before anything is counted
    or kept (`_simNetOtherMatch`); a new host or a new state of the host's
    drops the sealed ticks its worker sent before (`_simSealedDropNet`). Test
    `multiplayer-recovery-order`.
25. Every profile claim needs its key, also one equal to the joiner's peer
    id (a keyless join under its own id is no claim). A peer without a
    proven profile stands under `peer:<its id>` (`_transportUid`), which no
    profile id equals; a peer id once joined under a profile stays that
    profile's: another joining under it is refused (`HOST_CLOSED_LOBBY`).
    Test `multiplayer-recovery-authority`.
26. Administrative commands (`HOST_ADMIN_ACTIONS`: `forceResignTeam`) go
    through `queueHostAdminAction`, host only, also while it is defeated; a
    host that does not play puts them in the bundle in a packet of its own
    (`_hostAdminPacket`; carried on past a tick its worker sealed). Guests'
    are dropped as before. Test `multiplayer-recovery-authority` (page and
    worker).
27. A guest keeps its commands until they are known to have run: those
    whose tick ran without them (`lockstepNoteUnconfirmed`) and all in its
    input go on over a reload with their ids (`_takeUnsentLocalActions`,
    `lockstepTakeUnconfirmed`); the host seals a command id once
    (`_hostCommandsOnce`: a copy of one that ran, is in the bundle or waits
    in the sender's carry is left out). Test `multiplayer-recovery-authority`
    (never delivered, and delivered: sealed once).
28. A snapshot is acknowledged and counted only once restored, by the page
    and its worker (`simClientRestoreDone`: the worker's `started`, or its
    `restoreFailed`); a refused one is counted as refused
    (`netCounters.snapshotsRefused`), the guest stays paused and asks for
    the match, and a host waiting on that guest's acknowledgement stops
    waiting when it asks (REQUEST_MATCH_SYNC during the pause). The worker
    answers a failed restore (`restoreFailed`: the page treats the worker
    as lost). A full sync's restore likewise. Test `multiplayer-recovery-order`
    (the decoder's refusal on page and worker; the worker's failure).
29. Announcement and patch go by the repair's id: a newer valid patch
    supersedes the repair waited for whichever came first, and its
    announcement keeps it. Test `multiplayer-recovery-order`.
30. A patch that throws is dropped, counted (`netCounters.patchesFailed`),
    and the whole match asked for (`_resyncGuestPatchFailed`); a worker
    request that throws answers with its error (the promise rejects; it
    waited for good and looked like a lost worker), and the worker's patch
    path restarts its presentation. Test `multiplayer-recovery-order` (page
    and worker).

`SIM_RULES_REVISION` 15 for the recovery metadata and the sealing rules.

31. The test says what it is (perturbed math in Node; real pages run in Edge
    only, `tests/browser-*`: nothing here shows Firefox or Safari compute
    the same). The exact fingerprint mixes every waypoint of a unit's path
    (both copies in `net-harness.cjs`); the foreign Math also has an off
    square root (32). Tests `math-portability` (a moved waypoint changes the
    fingerprint), `multiplayer-cross-engine`.
32. `utils_common.js` checks Math.sqrt when it loads (page, simulation
    worker; helpers run no JS square roots): ~680 values (squares and their
    neighbours, every binade, subnormals) against an exact test with BigInt
    (the square of the midpoints next to the result against the input). An
    engine that fails gets a correctly rounded square root in its place
    (`_detSqrtSoft`: its own result, one Newton step, then unit steps until
    the exact test holds), `DET_SQRT_NATIVE` false and a console warning.
    V8 passes (nothing changes there). The wasm kernels' sqrt is IEEE 754's
    by the wasm specification. Found while looking: `_effSticky` took
    `Math.pow(2, k)` (now `detPow`, exact for 2^k). Tests `math-portability`
    (one unit off on half the inputs, and far off: found, replaced, 20000
    values each equal to V8's), `multiplayer-cross-engine` (two guests with
    such a square root stay in sync, bit-exact fingerprints).
33. `detSin`, `detCos`, `detAtan2` (fdlibm's kernels and reductions, + - * /
    alone; within 1.1e-16 of V8's) in map generation. Test
    `math-portability`: every map type from one seed under perturbed
    trigonometry and square root, the same terrain, spawns and fingerprint
    (solar_system's spawns differed before).
34. The README says the kernels are Rust only, wasm with shared memory is
    required (no fallback; the HUD warns on a page that is not isolated),
    and what determinism they keep (IEEE 754 operations, no relaxed SIMD, no
    fused multiply-add).
35. The worker's defeated teams start empty with each match and each
    restore. Test `multiplayer-rematch` (every player plays the rematch:
    failed in worker mode before, and the old test passed in page mode).
36. A player's resignation in multiplayer is the player stopping: the host
    turns a guest's resign action into `hostPeerStopsPlaying` (not sealed),
    as it does its role update, whichever comes first; the team resigns (a
    forced resignation, queued once) only when no teammate plays it. The
    Resign button is `resignLocalPlayer()` (the host's own resignation the
    same way); a chosen spectating sets that player's role alone (it set the
    whole team's on the host), a defeat the host's state finds the team's.
    Test `multiplayer-roles-rematch` (role update 1 s late and on time, the
    last player, the host with a guest teammate; page and worker).
37. From Start pressed (`_hostMatchStarting`) the host takes no colour
    change, and in a match a player's team is its colour in the start
    roster (`computeTeamSetupFromLobby`; spectators and visitors by their
    own colours, which make no team). Test `multiplayer-roles-rematch`
    (a colour change during a 500 ms preparation: same team, its Hold holds).
38. `RETURN_TO_LOBBY` names the match it ends (`m`); a guest in or loading
    another match drops it (`netCounters.lateLobbyReturnsDropped`). Test
    `multiplayer-roles-rematch` (4.5 s and 8 s late, page and worker).
39. A rematch's players are the last match's (`_matchStartPlayerIds`, the
    start's players followed to new peer ids; after a migration those
    playing); spectators and lobby visitors stay in the lobby and may
    spectate (`startHostedGame({ roster })`, teams from those players
    alone). Test `multiplayer-roles-rematch`.

Validation in the audit's session: snapshot, rematch, cross-engine math and
real shared-memory worker tests passed; the full worker recovery suite was
interrupted. With a smaller population reservation in the test harness the
migration, desync-recovery and patch suites passed (memory, see 12).
