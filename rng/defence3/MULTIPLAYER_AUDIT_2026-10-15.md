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
teams and rematches under delayed messages), 2026-10-16; 40 found in a
real-browser run (three Edge tabs). Findings 42-49 came from a sixth audit
(fault injection in the harness: replayed and delayed messages, slow
decodes, disconnects while loading, host loss after a false end; page and
worker), 2026-10-17. Findings 50-54 came from a seventh, read-only audit
(deltatick and helper interactions, failure paths, pacing), 2026-10-30: each
checked against the source here, reproduced by a new test that fails on the
old code, and fixed.

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
| 40 | P1 | A match start dropped players still loading: 45 s after the start every player not ready was removed (its team resigned), however busy loading; the host makes its model views (~30-60 s), the guests theirs only after the world came. Three real Edge tabs on one machine never started (also on d93eb5d). | `utils_networking.js` start | fixed |
| 41 | P1 | The state hash summed each field's term as (key ^ value) * M: one bit flipped in two fields at once cancelled out where their keys differ. A unit's effective stacks 4 -> 6 with its level 2 -> 3 (always together) flip the same float bit: a guest with a neighbour seen elsewhere kept that unit a level apart unseen (its hysteresis holds it), repairs fixed the players' energy every second but never the unit (`multiplayer-chaos-determinism` crossroads, worker mode, every run). | `k.rs` k_snap_units, `utils_snapshot.js`, `sim_unit_state.js` | fixed |
| 42 | P1 | A stale live-join snapshot freezes a rematch: `START_GAME` took an older match's join payload and replaced the guest's match id. A captured join replayed after a rematch left the host at tick 36 and the guest at 11, still stuck 20 s later (page and worker). No match or recovery freshness check, at receipt or after the decode. | `utils_networking.js` START_GAME | fixed |
| 43 | P2 | Overlapping snapshot decodes apply the same recovery twice: the duplicate check ran before the decode; two copies arriving before either finished, the slower one restored obsolete state after the first recovery had completed (rolled a guest back from tick 65 to 7). | `utils_networking.js` `_guestReceiveSnapshot` | fixed |
| 44 | P2 | A join makes the host build the snapshot twice on its main thread in worker mode: the page encoded its own whole state, then replaced it with the worker's (cloned over as objects) and stringified that on the page. 200k units in Node: 2.7-5.6 s to build, 1.2-2.3 s to stringify, ~78 MB. | `utils_resync.js` `_resyncHostSendJoin` | fixed |
| 45 | P2 | The 30 s join timeout starts waiting for a player still loading: its expiry removed the "joining" exemption without the joiner being ready. A 45 s snapshot decode on a healthy link: the host fell from 20 to ~10 TPS until the load finished. | `utils_resync.js` `resyncHostIsJoining` | fixed |
| 46 | P1 | An old resignation ends the next match: `MATCH_ROLE_UPDATE` had no match id and the host took it as a current resignation. Delayed 15 s past a rematch's start, the guest's team was resigned and the opponent won (page and worker). | `utils_networking.js` MATCH_ROLE_UPDATE | fixed |
| 47 | P1 | A disconnect while loading leaves the match at tick 0 for good: two guests, one ready, the other disconnects; the host dropped it but never started the countdown, and its start timeout waited on, nobody left unready (worker case still stuck after 610 s). | `utils_networking.js` `_handleConnectionClosed`, `_armMatchStartReadyTimeout` | fixed |
| 48 | P1 | A false local game over blocks recovery after host loss: migration took the guest's unconfirmed `gameOver` as final. A divergence giving a false victory, then the host lost: the guest stood at tick 6 after 90 s and 25 reconnect attempts; also when another guest became the host (page and worker). | `utils_host_migration.js` | fixed |
| 49 | P3 | The harness's simulation worker had no event-target API: the newer UI scripts the worker loads with the game's (`hover_text.js`) threw at load, so worker-mode suites failed before testing anything (a real worker's scope has `addEventListener`). | `tests/net-harness.cjs` | fixed |
| 50 | P1 | A step of more base ticks than the worker search cycle (simDk > 4) wrote the work site grid while the search posted last step still read it: the step's earlier base ticks ran `_wswStep` before the cycle's `_wsOrder` joined the search. Fast helpers read the old grid, slow ones or none (the search runs at the wait) the new one, so assignments could differ by helper timing. 144 grid writes during an in-flight search in 168 ticks of mixed step sizes. | `worker.js` `workerSearchTierStep` | fixed |
| 51 | P1 | A failed background chunk left different states by thread: on the simulation thread it was rethrown uncounted (the stage's other chunks kept running on helpers after the job was unlisted, so heap retirement took its memory as free); on a helper it set the foreground error flag, which a foreground job in between took (the background wait then reported success); the next stage ran on the failed one's output. Foreground jobs likewise returned at the simulation thread's throw while helpers still wrote. Loops waiting every lane stopped at the first failing one. | `sim_parallel.js` `_simBgClaim`, `simParallelBackgroundWait(Stage)`, `simParallelRun`; `sim_unit_state.js` | fixed |
| 52 | P2 | A tick that threw part way counted as healthy (page and worker): only a hash mismatch, if the half-run tick showed in one, led to a repair, and then a partial patch. | `sim_worker.js` `_simTick`, `main.js` runOneTick, `utils_resync.js` | fixed (guest); host: logged only |
| 53 | P2 | Upkeep was deducted once a step: below 20 TPS a step of SIM_DK_MAX (20) base ticks spans several seconds (100 charged instead of 330 over 33 s at 5 TPS). Not a desync. Research drain and boost checks read accumulated state and lose nothing. | `main.js` gameTick upkeep | fixed |
| 54 | P3 | Old host messages overwrote the guest's input delay and pace: `d` and `pace` were applied from every bundle as it came, before any freshness check; the channel is unordered, and resends, copies and the host worker's own seals (values as armed) come late. Lag or controller oscillation, no state divergence. | `main.js` `handleIncomingTickBundle`, `sim_worker.js` auto seals | fixed |
| 55 | P1 | A worker tick whose command preparation threw (or a pre-step before `currentTick++`) was lost: the worker refused every later tick, the page and network stayed alive (host looked connected, never advanced). | `sim_worker.js` onmessage tick, `_simTick`; `sim_client.js` error | fixed 2026-11-18; validated 2026-11-19 (multiplayer-worker-hang ONLY=prepare; fails on 7aedaabd) |
| 56 | P1 | After a failed chunk or local task the dispatching thread skipped its remaining chunks; a skipped occupancy block never published its marker: helper and simulation thread deadlocked. | `sim_parallel.js` `simParallelRun`, MOVE_OCCUPANCY kernel | fixed 2026-11-18; validated 2026-11-19 (occupancy-chunk-failure; fails on 7aedaabd) |
| 57 | P1 | A guest's 8 s full-sync retry superseded the host's in-progress snapshot each time: a snapshot slower than 8 s was never sent, guest paused forever. | `utils_resync.js` `resyncHostJoinInFlight`; REQUEST_MATCH_SYNC | fixed 2026-11-18; validated 2026-11-19 (multiplayer-join-retry slow; fails on 7aedaabd) |
| 58 | P1 | Movement rule switches (?occupancy, ?traffic*, ?acq) were per page, not in the match config or hash: peers diverged again after every repair. | `utils_networking.js` `netSimRulesOfPage/Apply`, config hash | fixed 2026-11-18; validated 2026-11-19 (multiplayer-sim-rules; fails on 7aedaabd) |
| 59 | P2 | A late handover acknowledgement (> HOST_HANDOVER_MS) was dropped and the retry ignored: two hosts. | `utils_host_migration.js` handover | fixed 2026-11-18; validated 2026-11-19 (multiplayer-worker-hang ONLY=handover-late; fails on 7aedaabd) |
| 60 | P1 | A guest joining during the start's initialization stopped reporting; the host's barrier waited for it: startup froze for all. | `_matchInitializationPoll`, `resyncHostScheduleJoin` (exempt) | fixed 2026-11-18; validated 2026-11-20 (multiplayer-start-warmup ONLY=join, both modes; fails on 7aedaabd) |
| 61 | P1 | A guest's own unconfirmed end disabled its silent-host reconnect and migration: frozen at a false victory. | `utils_net_quality.js` `netMaintain` | fixed 2026-11-18; validated 2026-11-20 (multiplayer-stale-loading ONLY=61, both modes; frozen at the false end on 7aedaabd) |
| 62 | P1 | A full join asked after the host's end was scheduled for a tick that never runs: reloader waited forever. | `hostSendFullMatchSync`, `resyncHostSendFinalState` | fixed 2026-11-18; validated 2026-11-20 (multiplayer-stale-loading ONLY=62, both modes; never loaded on 7aedaabd) |
| 63 | P1 | A live join with the worker lost a staged Q/E (and nav state): the worker started from a page snapshot without them. | `simClientNoteJoinText/TakeJoinText`, `snapDecodeSeq` | fixed 2026-11-18; validated 2026-11-20 (multiplayer-live-join-worker; diverges after the join on 7aedaabd) |
| 64 | P1 | Team force-resign used the tick-input peer list: a teammate loading a join was missed (team resigned), a resigned host counted (team kept). | `hostTeamStillPlayed` | fixed 2026-11-18; validated 2026-11-20 (multiplayer-stale-loading ONLY=64, both modes; team resigned under the loading teammate on 7aedaabd) |
| 65 | P1 | A guest's normal start left `matchStartWaitingForReady` cleared by `startGame()`: loading heartbeat stopped, host dropped a loading player after 45 s. | `applyIncomingMatchSyncPayload` | fixed 2026-11-18; validated 2026-11-20 (multiplayer-slow-worker-start; team resigned on 7aedaabd) |
| 66 | P2 | Late commands carried under a player's old peer id were lost on a reconnect under a new id. | `migratePeerIdByUid` | fixed 2026-11-18; validated 2026-11-20 (multiplayer-carry-new-peer-id; stuck under the old id on 7aedaabd) |
| 67 | P1 | TICK_RESEND_REQUEST had no match tag (rematch: far-future packets, orders queued behind them); a stale request for a tick already run forced a full sync. | `main.js` `handleIncomingTickResendRequest` | fixed 2026-11-18; validated 2026-11-20 (multiplayer-resend-request stale, other-match; both fail on 7aedaabd) |
| 68 | P1 | Requests deferred while the worker ran ticks itself were never drained after the last adoption; autonomous ticks stayed disabled. | `simClientFlushDeferred`, `lockstepAdoptAutoTick` | fixed 2026-11-18, unvalidated: needs a page stall (worker ticks alone once the page beat is >40 ms stale), which the Node harness cannot make |
| 69 | P1 | Initialization release never happened with a periodic tick-cost spike (settled test). | `MATCH_INIT_MAX_TICKS` | fixed 2026-11-18; validated 2026-11-19 (multiplayer-join-retry warmup; fails on 7aedaabd) |
| 70 | P1 | A guest with the host's result but more than 2 base ticks short and no next bundle waited forever. | `guestReviewMatchResult` | fixed defensively 2026-11-18; regression test multiplayer-stale-loading ONLY=70 (every bundle dropped after the end: passes on 7aedaabd too, another path ends it; no trigger for the old hang found) |
| 71 | P2 | Two lone hosts after a healed split both demoted: no host. | `hostMaybeSeekOtherHost`, HOST_SEEK_REPLY `players` | fixed 2026-11-18; partly validated 2026-11-20 (multiplayer-split-heal: one host, the smaller id; 7aedaabd kept the larger; the both-demote race not reproduced) |
| 72 | P1 | A restore during warmup (migration resync) ended the warmup poll loop: every peer stopped at that tick. | `_matchLoadOverlayUntilRunning` | fixed 2026-11-18; validated 2026-11-20 with row 78 (multiplayer-start-warmup ONLY=migration; fails on 7aedaabd) |
| 73 | P1 | Worker-loss handover excluded spectators: with no player linked the match froze. | `hostHandOverMatch` | fixed 2026-11-18; validated 2026-11-20 (multiplayer-handover-spectator; no handover on 7aedaabd) |
| 74 | P2 | A second guest-only tick failure inside the 60 s repair interval was dropped. | `_resyncGuestSettleFails` (`failOwed`) | fixed 2026-11-18; validated 2026-11-20 (multiplayer-tick-failure part 3; never repaired on 7aedaabd) |
| 75 | P2 | A host start that failed after START_GAME_PREPARE left guests on "Waiting for host to generate world". | START_GAME_CANCEL | fixed 2026-11-18; validated 2026-11-20 (multiplayer-stale-loading ONLY=75, both modes; guests stayed on the overlay on 7aedaabd) |
| 76 | P2 | A reloaded former host gave up (~35 s) before a lone opponent took over (60 s). | `MATCH_RECORD_SEEK_MS` | fixed 2026-11-18; validated 2026-11-20 (multiplayer-reload-seek; gave up on 7aedaabd) |
| 77 | P2 | A joining guest promoted to host kept its held orders forever. | `resyncGuestReleaseOnPromotion` | fixed 2026-11-18; validated 2026-11-20 (multiplayer-promoted-joiner, both modes; held for good on 7aedaabd) |
| 78 | P1 | Host lost during the start's initialization (found validating 72, page and worker): the new host's barrier waited for the lost host's status (still a player until back or dropped), and its `allowed` was a guest's (the start tick), dropping every status as ahead: the start stood after the old host came back or was dropped. | `_matchInitializationPoll` (skips players with no link), `matchInitializationOnPromotion` | fixed 2026-11-20; multiplayer-start-warmup ONLY=migration (both fail without the skip) |
| 79 | P2 | PLAYER_REMOVED_FROM_MATCH carried no match tag: one late past a rematch's start (the channel is unordered) marked that peer removed in the new match on a guest, the guest itself put into spectating. | `hostRemovePlayerFromMatch`, lobby-join senders (`m`), guest handler `netMatchTagOk` | fixed 2026-11-20 (audit while validating); multiplayer-stale-loading ONLY=79 (the previous match's message delivered: 7aedaabd went to spectating) |
| 80 | P2 | REQUEST_SPECTATE from a player of the running match (a reloaded player clicking Spectate in the lobby before its rejoin) set its role (peer and uid) to spectating without the resign check MATCH_ROLE_UPDATE / LOBBY_LEAVE make: its team neither played nor resigned, and the player cannot rejoin as one (its uid now spectates). | `REQUEST_SPECTATE` handler | fixed 2026-11-20 (user: a member comes back with its role, no Spectate button): `hostRejoinRole` (a player back as a player unless its team is out: defeated or resigned, then spectating) for the lobby join and REQUEST_SPECTATE (a player asking gets the match as a player; ignored while its join is on its way); the button hidden for a player of the match; resign the usual way after. multiplayer-stale-loading ONLY=80 (7aedaabd: button shown, and the request made it a spectator) |
| 81 | P1 | A worker's tick result that threw while publishing (the world's encode, events, sight, the clone) left the page counting the tick in flight for good; a guest's patch, gated on no ticks in flight, never applied (the guest stood at its tick with the patch in hand). | sim_worker.js `_simTick` / `_simPostBareResult`; sim_client.js `_simClientApplyTick` | fixed 2026-11-20: every tick that ran ends in one result (a bare one, the failure reported with the tick; the next frame whole); the page also retires dispatched ticks older than a result (results come in order). Test: multiplayer-stuck-recovery ONLY=81 (worker) |
| 82 | P1 | A worker that stops without a word (silenced, a helper gone from a parallel job's barrier) froze every peer while its page answered the network: no worker recovery, no migration. | sim_client.js `simClientStallCheck` (renderer.js pump) | fixed 2026-11-20: a worker is lost once a peer reports it completed the oldest tick this worker has had in flight and 20 s more pass without its result (relative to the peers' progress, not silence alone: a slow world is slow everywhere); a host then hands the match on, a guest gets it again. Test: ONLY=82 (worker) |
| 83 | P1 | Both peers' simulations lost: no state source; the host asked the guest to take over, the guest declined silently and asked the host for the match, for good. | utils_checkpoint.js (new); `HOST_HANDOVER_REFUSED` | fixed 2026-11-20: every peer keeps the newest whole state of the match (start / join / match-wide resync text) and the commands of every tick since (only ticks with commands or a flush; step sizes as runs); a host nobody can take over from restores it into a new worker and runs the ticks again (catch-up); the guests then get the match from it. A guest whose own simulation is lost refuses a handover at once. Test: ONLY=83 (worker) |
| 84 | P1 | A guest-only player / global / order difference that came back after every patch never counted as a failed patch: partial patches for good (73 in 85 s), never a full one or a reload. | utils_resync.js `_resyncCodesRecur` | fixed 2026-11-20: a request naming a part the previous one named (any part) counts as a patch that did not hold (also outside the 60-tick window), escalating to full patches and the reload. Test: ONLY=84 |
| 85 | P2 | A page-mode tick whose statistics / hash / shadow step threw after the step ran repeated the step (currentTick advanced only after them): the host two steps on, the guest patched to it. | main.js `runOneTick` | fixed 2026-11-20: what follows the step fails alone. Test: ONLY=85 (page) |
| 86 | P1 | A guest promoted to host during the start's wait for players (after the worlds came, before the countdown) inherited a guest's wait: no list of whom to wait for, nothing asked the start to go on: tick 0 for good. | utils_networking.js `hostTakeOverStartWait` (promoteSelfToHost) | fixed 2026-11-20: the wait is the new host's (every linked player expected again, the deadlines armed). Test: ONLY=86 |
| 87 | P1 | A guest that had found its state diverged stayed eligible to take over ahead of a healthy one; its state became the match's. | utils_resync.js `resyncGuestStateSuspect`; utils_host_migration.js `_migrationSelfDefers` | fixed 2026-11-20: such a guest takes over only when nobody else can (as one whose end was unconfirmed). Test: ONLY=87 |
| 88 | P1 | START_GAME_READY was sent once; its beat said "loading": one lost message, and the loaded player was dropped at the start's deadline (the 1v1 ended). | utils_networking.js `_guestStartReady`, `_guestStartLoadingBeat` | fixed 2026-11-20: the start's beat repeats the ready message once loaded (to whoever hosts: row 86 too). Test: ONLY=88 |
| 89 | P1 | A start snapshot that failed to build after the host's startGame: gameStarted already set, so no START_GAME_CANCEL; failures in the start's promise callbacks went nowhere: the host at tick 0, the guest on "Match Starting". | utils_networking.js `startHostedGame` (startFailed, sendStart); sim_client.js `_simClientCreated` | fixed 2026-11-20: every start-text failure ends in startFailed before START_GAME went out: the cancel is sent and the host's own match ends (back to the lobby). Test: ONLY=89 (page) |
| 90 | P1 | A host whose PeerJS peer closed for good kept the host role with no peer: it could neither seek nor be found; two hosts for good. | utils_host_migration.js `hostAfterPeerClosed` | fixed 2026-11-20: it joins the first successor as a migrating player (a new peer; the successor takes over at once), whose snapshot replaces its lone ticks. Test: ONLY=90 |
| 91 | P2 | A live join whose restore threw kept its loading beat going and its next request did not name the failed join: the host took every request for a repeat, ten minutes lost. | utils_networking.js START_GAME catch | fixed 2026-11-20: the beat stops and the request names the failed join (sent again at once). Test: ONLY=91 |
| 92 | P1 | A join's 45 s silence counted from its scheduling: a snapshot slower to encode was replaced, the finished one dropped, every time. | utils_resync.js `_resyncHostSendJoin` (`sentAt`), `resyncHostCheckJoins`, `resyncHostJoinInFlight` | fixed 2026-11-20: silence counts from the sending; an unsent join is in flight (one that fails to encode or loses its link is dropped, the next request makes another). Test: ONLY=92 (worker) |
| 93 | P1 | A final state's trailing MATCH_RESULT read the match id, time and winner when its encode finished: a rematch's (winner -1), and the guest reloaded the rematch over and over. | utils_resync.js `_resyncHostSendJoin` | fixed 2026-11-20: the match and result are taken when the send is made; a snapshot of another match by then is not sent. Test: ONLY=93 |
| 94 | P1 | A guest with another winner asked for the final state every 5 s; each answer started a newer restore that dropped the one decoding: with a decode over 5 s, none applied. | utils_resync.js `_resyncHostFinals` / `resyncHostFinalInFlight`; utils_networking.js `_guestRepairResult` | fixed 2026-11-20: one final state per peer on its way (encoded, sent, loading) answers repeats; the guest does not ask while a load runs. Test: ONLY=94 |
| 95 | P1 | A rejoin scheduled for a tick after the match's end was never sent (the tick never ran): the player linked, no match, no result. | utils_resync.js `resyncHostFlushJoinsAtEnd` | fixed 2026-11-20: at the end, scheduled joins go as the final state. Test: ONLY=95 |
| 96 | P1 | A guest that missed the end announcement asked for bundles past the host's last tick; the finished host answered nothing. | main.js `handleIncomingTickResendRequest` | fixed 2026-11-20: such a request brings the result again (once a second per peer). Test: ONLY=96 |
| 97 | P2 | A hidden guest's background pump stopped on its own (false) end before reviewing the host's result: no repair until visible. | renderer.js `runHiddenTickPump` | fixed 2026-11-20: as the visible frame, it keeps reviewing. Test: ONLY=97 |
| 98 | P2 | The same winner with another final world (a difference in the last step) was confirmed as it was. | utils_networking.js `hostMatchResultMessage` (`h`), `_guestFinalStateAgrees`; the end's tick hashed (sim_worker.js, utils_resync.js `resyncAfterTick`) | fixed 2026-11-20: MATCH_RESULT carries the host's hash of its end's tick (sent after that tick's hash is recorded); a guest confirms only when its own agrees (or it has the host's final state). Test: ONLY=98 |
| 99 | P2 | The navigation substitutes' room counted the table's entries, which differ between peers (a restored one's holds only the waiting units'): past about half the population asking in a tick, peers refused different asks. | pp.rs `sub_ask` / `sub_asked`; flownav.js `navSubRoom`, `_navSubAsk` | fixed 2026-11-20: the room is a tick's asks (counted alike everywhere, found or not; the table cannot fill); a refused unit asks again next tick reading nothing. No test (needs about half a large population asking at once). |
| 100 | P2 | A join scheduled before a match-wide resync pause and sent after it (the pause holds the tick it was due at) carried a recovery number below the pause's: the guest dropped it as an older recovery's and waited for the next join (the old host of a late handover, ~45 s more; found validating row 92's change, which made the next join wait for the first one's silence). | utils_resync.js `_resyncHostSendJoin` | fixed 2026-11-20: a join is numbered when it is made. Test: multiplayer-worker-hang ONLY=handover-late (failed with the row-92 change before this) |
| 101 | P1 | Worker-loss handover promoted a guest that knew it diverged (the ordinary migration's suspect check was skipped): its state (nextUnitId 1000010 vs 10) became every peer's. | utils_host_migration.js `guestTakeHandedOverMatch`, `hostHandoverRefused`, `_hostHandoverNext` | fixed 2026-11-20: a suspect guest (`_migrationSelfDefers`) refuses (`suspect: 1`); the host asks the next, then runs its checkpoint, and only without one forces a diverged player (`force`). Test: stuck-recovery ONLY=101 (worker) |
| 102 | P1 | A START_GAME_COUNTDOWN arriving after ALL_READY covered the running match for good (bundles cleared the wait flag, not the overlay; a guest's countdown never hides it). | utils_networking.js `guestReleaseMatchStart`, START_GAME_COUNTDOWN; main.js bundle handler | fixed 2026-11-20: ALL_READY or the host's first bundle releases the start (overlay, countdown) and marks it; a countdown of a released start is dropped. Test: ONLY=102 |
| 103 | P2 | An older live join whose decode outlasted a match-wide recovery restored its older tick over the newer state; the host then sent another join. | utils_networking.js `_guestStartCurrent`, `_markHostResyncAck` | fixed 2026-11-20: a join is stale once a newer recovery number is seen; the host retires a join older than the recovery the joiner acknowledged. Test: ONLY=103 |
| 104 | P2 | The end's tick hash (row 98) was the rotating partial one: a unit difference outside that tick's slice confirmed two different final worlds. | utils_snapshot.js `snapRecordTickHash` | fixed 2026-11-20: the tick the match ends on hashes every slice (page and worker). Test: ONLY=104 |
| 105 | P2 | A successor rebuilt the rematch roster from those playing at the migration: a starting player who resigned and spectated was left in the lobby. | utils_networking.js `hostMatchStartPlayersWire` (`sp` in START_GAME and joins), `guestMatchStartPlayerIds`; utils_host_migration.js `promoteSelfToHost` | fixed 2026-11-20: every peer keeps the start players as [peer id, uid] from its host; a successor maps them to current ids. Test: ONLY=105 |
| 106 | P2 | A spectator's restore that threw only logged: loading beat on, no new request, the loading screen for good. | utils_networking.js START_SPECTATE catch, `_guestJoinApplyFailed` | fixed 2026-11-20: as a player's (row 91): the beat stops, the request names the failed join and goes again. Test: ONLY=106 |
| 107 | P1 | A join snapshot that failed to build (worker text, or the page's build throwing) was dropped: the reloaded player, with no match to ask from, waited for good, and the host waited for its input (the match stood at tick 35). A page build that threw left the join counted as on its way for good. | utils_resync.js `_resyncHostSendJoin` (`drop`, `fail`) | fixed 2026-11-20: a failed build or encode makes the join (or final state) again after 1 s; the page build is inside the failure path. Test: stuck-recovery ONLY=107 |
| 108 | P1 | A delayed patch request reaching the host just before a guest's join replaced the scheduled join with a patch while the join stayed counted as on its way; every later request was taken for a repeat (guest at tick 29, host at 1029). | utils_resync.js `resyncHostHandleRequest`, `resyncHostBeforeTick` | fixed 2026-11-20: a patch request for a peer with a join pending or on its way is moot (dropped); a join whose tick the pump missed is made again. Test: ONLY=108 |
| 109 | P1 | A guest that caught up by a match-wide snapshot never kept it as its checkpoint; the skipped ticks cleared the old one, and as host after a migration it could not run the match again when its worker was lost (stood at tick 62). | utils_networking.js `_guestReceiveSnapshot` | fixed 2026-11-20: the restored snapshot is noted as the checkpoint at its tick. Test: ONLY=109 (worker) |
| 110 | P2 | A guest's order queued for a tick before a match-wide snapshot's (a lagging guest's own tick, while the snapshot decoded) was dropped by the restore: run by nobody. | utils_networking.js `applyAuthoritativeStateSnapshot` (`requeueInput`) | fixed 2026-11-20: a guest's commands for ticks before the snapshot that have not run and are in no bundle it has go back into the input with their ids (the host drops copies it had). Test: ONLY=110 |
| 111 | P2 | A visitor's RESYNC_NO_MATCH that came after it joined as a spectator marked it as in the lobby before the reply's recovery was checked: the next pause passed it over (tick 147 vs 205), an extra full reload. | utils_networking.js `_hostNoteResyncNoMatch`, `hostNotePeerHasMatch` (`_hostPeerGotMatchGen`); utils_resync.js `resyncHostHandleJoinApplied` | fixed 2026-11-20: only a reply to the pause running now counts, and not from a peer sent the match since that pause began; a join applied marks the peer as having the match. Test: ONLY=111 |
| 112 | P2 | REQUEST_MATCH_SYNC carried no match id: a request of a finished match (conflicting winners) delayed into the rematch reloaded the healthy rematch. | every REQUEST_MATCH_SYNC sender (`m`); utils_networking.js REQUEST_MATCH_SYNC handler | fixed 2026-11-20: requests carry their match; one of another match from a peer that already runs this one (its packets, or ready for its start) is dropped; a peer still in the old match is answered as before. Test: ONLY=112 |
| 113 | P1 | The host election could promote a guest whose own simulation was lost: it took over with an empty world, sent it to the healthy guest, and both stood (ticks 20 and 23). | utils_host_migration.js `_migrationSelfDefers` | fixed 2026-11-20: a lost simulation defers like a known divergence (redirects to the next successor; takes over only when nobody else can). Test: stuck-recovery ONLY=113 (worker) |
| 114 | P1 | Two workers that stopped publishing on the same tick froze the match: the stall check needs a peer to complete the tick. | sim_client.js `simClientStallCheck`, `_simClientWorkerLost` | fixed 2026-11-20: the worker's own shared progress counts as evidence too (it ran the oldest tick in flight, its result never came; 20 s on it is lost). No silence timeout: a tick still running gives no evidence. Without shared memory (no cross-origin isolation) only peers' reports count, as before. Test: ONLY=114 (worker, SIM_SHARED) |
| 115 | P1 | A guest whose start apply failed once (renderer preparation) asked a repair a page without a running match never sends; its start beat kept saying it loaded: the host waited ten minutes, dropped it and won. | utils_networking.js START_GAME (`applyStart`) | fixed 2026-11-20: a match start's apply that fails runs again a second later while it is still this page's start. Test: ONLY=115 |
| 116 | P1 | A cancelled start's prepare, delayed past the cancel and the retry's prepare, was taken for a new match: the retry was marked ended and its START_GAME dropped (the guest dropped after 45 s). | utils_networking.js START_GAME_CANCEL, START_GAME_PREPARE, START_GAME (`_guestStartSeqFresh`, `_hostStartSeq`) | fixed 2026-11-20: a cancel marks its start ended even before its prepare came; prepares and starts carry the host page's increasing start number, an older one after a newer one is dropped. Test: ONLY=116 (page) |
| 117 | P2 | A host order sealed but not run when the host's worker was lost (the successor never got the bundle) was lost: the rejoin left it out, the seal-time ledger counting it as run. | utils_networking.js `netNoteSealedUnrunOwnCommands`, `_takeUnsentLocalActions`; utils_host_migration.js `demoteSelfToGuest`; sim_client.js (`_simClientLost.appliedTick`) | fixed 2026-11-20: a host handing over carries its own commands in bundles after its lost worker's last result into its rejoin, with their ids (the successor drops any it ran). Test: ONLY=117 (worker) |
| 118 | P2 | A host whose peer closed (its guest gone) during the start's renderer preparation started alone afterwards and won. | utils_networking.js `startHostedGame` (after `prepareRendererLodAssets`) | fixed 2026-11-20: after the preparation, no peer or no other start player linked: the start fails (back in the lobby). Test: ONLY=118 |
| 119 | P2 | A three-player split healing with crossing probes: the lone host yielded to the host with a player, which yielded to the smaller id: both demoted. | utils_host_migration.js `hostMaybeSeekOtherHost` | fixed 2026-11-20: one order both read alike: more linked players stays, a tie goes to the smaller id (the old rule only for a reply without a count). Test: ONLY=119 |
| 120 | P2 | A command given while a new match's initialization blocked input (a hotkey under the loading overlay, the first second or two) was dropped silently. | worker.js `queueAction`, utils_networking.js `_matchInitializationRelease` | fixed 2026-11-21: held (`matchInitializationHoldAction`) and queued at the release, in order. Test: ONLY=120 |
| 121 | P1 | A guest paused waiting for the whole match (its own full-sync request, at tick 8) was the preferred successor: it took over and the healthy guest (at 228) restored its tick; a Hold both had run was lost, the survivors then agreed. | utils_host_migration.js `_migrationSelfDefers` | fixed 2026-11-21: such a guest (`_migrationAwaitingWholeMatch`: its own request pending, a join or a full patch on the way) defers like a diverged one. Test: ONLY=121 |
| 122 | P1 | A guest whose link closed and whose worker was then lost: the reconnect started a new network epoch, which ended its recovery loop, and its LOBBY_JOIN offered its tick for a soft resume: stood at tick 9 for good, no request sent. | utils_networking.js `netRecoverLostSimulation`, `connectToHost` LOBBY_JOIN `resumeTick` | fixed 2026-11-21: the loop is kept by the match; a guest whose simulation is lost offers no resume (the whole match). Test: ONLY=122 |
| 123 | P1 | A guest's start apply that failed after its world reset (stat rebuild) never retried: the retry required the match id the reset had cleared; the host waited ten minutes and dropped it. | utils_networking.js START_GAME `applyStart` retry | fixed 2026-11-21: the same start and network session decide (a cleared match id counts as this one). Test: ONLY=123 |
| 124 | P2 | A JOIN_LIVE_ACK of the last match's join, delayed into the rematch, was taken: the guest's held commands went out for its tick (Hold issued at 20 ran at 247). | utils_resync.js `resyncHostHandleJoinLive`, `resyncGuestHandleJoinLiveAck` | fixed 2026-11-21: the acknowledgement carries the join's number and the match; others are dropped. Test: ONLY=124 |
| 125 | P2 | A held command (a guest awaiting JOIN_LIVE_ACK) was lost when the next join's apply threw: the world reset cleared the input and only a successful apply gave the carried commands back. | utils_networking.js `applyIncomingMatchSyncPayload` (`carried`) | fixed 2026-11-21: kept aside by match until an apply has them in place (`_netCarriedAside`), merged into the next apply's. Test: ONLY=125 |
| 126 | P1 | A guest's link closed after the host scheduled its join and before the join's tick: the entry was dropped but the join stayed counted as on its way (never sent, never timed out), and every request of the reconnected guest was a repeat. | utils_resync.js `resyncHostBeforeTick` | fixed 2026-11-21: a join that cannot go is no longer on its way; an open link of the peer is preferred. Test: ONLY=126 |
| 127 | P1 | A START_GAME whose send failed: the guest (it had the prepare) beat "loading" and the host waited ten minutes, then dropped it. | utils_networking.js `hostNoteStartLoading`, `_guestStartLoadingBeat`, `startHostedGame` sendStart | fixed 2026-11-21: the beat says whether its start came (`has`); the host keeps its start while it waits and sends it again (4 s after sending, at most every 4 s). Test: ONLY=127 |
| 128 | P2 | A duplicate START_GAME reached a running guest: it applied tick 0 again (49 -> 0) and caught up. | utils_networking.js `_guestTakeStart` | fixed 2026-11-21: a start this page took already is dropped (its own apply retries do not come through it). Test: ONLY=128 |

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
40. A guest loading a start says so every 2 s (`START_GAME_LOADING`, from
    `START_GAME_PREPARE` until its match runs); the host waits while it
    hears that, and drops a player only after 45 s of silence (or 10
    minutes). And the guest makes its model views from the prepare on, for
    the match's teams and rules (the prepare carries the host's rules): the
    start's own preparation then finds them made (it made them anew, ~30 s,
    once the world had come). Three Edge tabs on one machine: never started
    before; with the wait 131 s; with both 71 s. Test
    `multiplayer-start-wait` (a guest loading 60 s is waited for, a silent
    one dropped; the prepare carries the rules; failed on d93eb5d);
    `tests/browser-mp-gui-fuzz.cjs --players=3` (401 controls clicked over
    three real tabs: 396 hash comparisons, 0 desyncs, no errors).
    Found by the suites after that change: a prepare is sent just before
    the host makes the world, its START_GAME right after; delivered out of
    order (while the guest applied the start) the prepare set the guest's
    rules back to the host page's from before it read its menu (an 80x80
    map for a 20x20 match: diverged at tick 0, `multiplayer-disconnect`,
    `-extremes`, `-scenarios`). Now the host reads its menu at the press,
    so the prepare carries the match's rules, and a guest ignores a prepare
    whose START_GAME has come (`_guestStartTakenSessionId`); each half
    alone keeps the start in sync. Test `multiplayer-start-wait` (a prepare
    delivered during the start's apply: diverged at tick 0 before).

41. Every term is mixed before the sum (t ^ t >>> 15, times an odd
    constant): the units' kernel (`k_snap_units`), the units' object digest
    (`_simHTerm`, the setters' inline terms too) and the structures',
    mines', drops' and projectiles' field hasher. Found by the full suite
    after 36-40 (it passed on d93eb5d by chance: another game). The
    harness's exact fingerprint reads effective stacks and level too. Test
    `multiplayer-corruption-fuzz unitStacksLevel` (both values a step
    apart, the same bit flipped: never patched before, 1 patch now).

Tests for 42-48: `tests/multiplayer-stale-loading.test.cjs` (`ONLY=42,...`,
`MODES=page|worker`). `SIM_RULES_REVISION` 16 for the join and role-update
fields.

42. A guest keeps the matches the host has moved past (their
    `RETURN_TO_LOBBY`, or another match's prepare or start:
    `_guestNoteMatchEnded`, `_guestNoteMatchStarting`); a `START_GAME`,
    `START_SPECTATE` or prepare of one of them is dropped
    (`netCounters.staleJoinsDropped`). A live join carries a number (`g`,
    from the recoveries' count `_hostNextResyncGen`); the guest takes a join
    once, none older than one taken or than a recovery seen in that match
    (`_guestTakeStart`), and the join counts as a recovery from then. After
    the yield and after every await of the load, the join must still be
    current: the same host, its match not past, no newer join
    (`_guestStartCurrent`, in `applyIncomingMatchSyncPayload`'s `stale()`).
    Test part 42 (a copy in the same match: no roll back; the last match's
    join after a rematch's start: dropped, the rematch plays on).
43. A copy of the snapshot decoding now is dropped
    (`_guestSnapshotDecoding`, `netCounters.duplicateSnapshotsDropped`),
    and a decode that finishes after its recovery was restored (by another
    copy) or done is dropped. Test part 43 (two copies at once, the second
    decode 3 s slower: no roll back).
44. With the simulation worker the host page builds the snapshot without a
    state (`buildHostAuthoritativeStateSnapshot({ withoutState })`) and the
    worker encodes and stringifies the state (`encodeStateText`); the page
    puts its small part around that text (`simClientSnapshotText`). For a
    join and for a match-wide recovery (`simClientFillSnapshotState`, the
    object path, removed). A join superseded by a newer one for that peer
    is not sent. Test part 44 (worker: the host page's `snapEncodeState`
    is not called for a join or a recovery; in sync).
45. A join is loading until the joiner says `JOIN_APPLIED` (tagged with
    the join's number, as `JOIN_LIVE` is; one of another join is dropped):
    not waited for meanwhile, while it says it is loading (`JOIN_LOADING`
    every 2 s, `_guestJoinLoadingBeat`, up to 10 minutes). The 30 s catch-up
    limit counts from `JOIN_APPLIED`. A joiner silent for 45 s while loading
    is sent the match again, once; silent again, it is waited for as any
    player (`resyncHostCheckJoins`). Found by the test in worker mode: a
    joiner said it had caught up while ~870 ticks behind (the committed
    bundles were not counted, only those still pending; with the worker the
    ticks run behind them), and the host waited for it at ~12 TPS:
    `resyncGuestMaybeLive` counts both. Test part 45 (a 45 s decode: 20 TPS
    throughout, live once caught up; silent 50 s: sent again, joined).
46. `MATCH_ROLE_UPDATE` names its match (`m`); the host drops one of
    another match, untagged ones too (`netCounters.otherMatchDropped`).
    Test part 46 (15 s late, past the rematch's start: nobody resigned).
47. A player disconnecting while loading the start is out of the match (as
    a loader gone silent is: `hostRemovePlayerFromMatch`; kept in, the
    match started and then waited for it as for a player gone mid-match),
    and the start goes on once everyone left is ready
    (`_hostStartWaitReevaluate`: after a disconnect, and at every start
    timeout check, with or without anyone to drop). Test part 47.
48. A guest's end is final only once the host's result confirms it
    (`netMatchEndFinal`); host migration and following a moved host go on
    past an unconfirmed one (`_migrationMatchOver`). That guest takes over
    only when nobody else can: it puts itself last among the successors,
    and pointed at as the successor it names the next one
    (`_successorFromMyView(..., passSelf)`); the new host's snapshot undoes
    its end. Alone it takes over and its end is the match's (shown and told:
    `matchOverShow`). A host asked for the match after its end sends its
    result with the final state (`resyncHostSendFinalState`). Test part 48
    (a false victory on the first and on the second successor, then the
    host lost: the other guest hosts, both play on in sync; alone: it hosts,
    the match ended).
49. The harness's simulation worker scope has `addEventListener` /
    `removeEventListener` (idle), as a worker's global scope has.

50. When a step covers more base ticks than the search cycle and a search
    is in flight, it is joined before the step's first grid write
    (`workerSearchTierStep`); results are still taken at the same base
    ticks. The join was going to happen in the same call anyway (the
    cycle's order), so no tick waits more than before. Test:
    `tests/worker-search-deltatick.test.cjs` (step sizes 1-20, 1->20->1,
    3->8->5, ...; every phase offset; `--helpers=N` for real helpers).
51. Per-lane error flags (`SIM_PAR_BG_ERR` + lane). A failed chunk counts
    as done on every thread; the chain's remaining chunks and stages are
    skipped (counted, not run); the wait drains and closes the lane, then
    throws (the simulation thread's own error object when it failed there).
    A stage wait on a failed chain drains it and throws. Foreground: a chunk
    failing on the simulation thread counts, and the error is thrown after
    every helper left the job. `simParallelBackgroundWaitAll` drains every
    lane before throwing the first error (the three memory-move paths in
    `sim_unit_state.js`). Cost: one atomic load per background chunk. Test:
    `tests/background-failure.test.cjs` (0, 1, 7 real helpers; failures on
    the simulation thread, a helper, either; a foreground job between; stage
    wait; foreground failure).
52. `resyncNoteTickFailed` (page tick; worker tick through the error
    message's tick): counted (`netCounters.tickFailures`). The host puts a
    marker for each of its failed ticks in its hash stream (`-1 - tick`,
    before that tick's sum; older guests skip negative ticks). A guest whose
    tick failed where the host's did not asks for a full repair
    (`forceFull`) once the host's sum for that tick or later has come; failed
    on both alike (a deterministic bug, identical partial state:
    `multiplayer-desync-recovery` part 12) nothing is repaired and the
    hashes compare as ever. At most one such request a minute. A host has
    nothing to repair from: logged once a minute. Test:
    `tests/multiplayer-tick-failure.test.cjs` (one failed guest tick: full
    repair, agreement after; ~60 failing ticks on both peers: no repair
    loop, the match goes on, agreement after; page and worker). (A first
    version repaired every guest failure, shared or not: part 12 of the
    desync suite caught it.)
53. Upkeep times the seconds' boundaries the step crossed (0 or 1 at 20 TPS
    and above: unchanged there). Test: `tests/upkeep-deltatick.test.cjs`
    (5, 10, 20, 60, 120 TPS, steps of 1-20).
54. Host messages carry `q`, a version that moves only when the delay or
    pace changes (`netHostCtlVersion`; the worker's arm carries it, so its
    seals have the version of their values); a guest takes `d`/`pace` only
    from a message no older than the newest version seen from that host in
    that match (`_guestCtlFresh`; no version: an older host, taken). Dropped
    ones: `netCounters.staleCtlDropped`. Test: `tests/stale-pacing.test.cjs`.

Not done from the 2026-10-30 audit (its sections 3-6, beyond 50-54): a host
whose own ticks fail has no healthy source to repair from (counted and
logged: containment, not recovery). The wider recovery matrix (blocked
worker, failed snapshot encodes, host migration with in-flight helper work
and mixed-dk bundles, lifecycle cancellation, stale page/helper/WASM
combinations) was not re-audited here. Diagnostics that convert input-delay
steps with TICK_MS (they understate the delay at adaptive steps) are
unchanged, display only. The multiplayer deltatick test's host step
override still does not drive the adaptive controller.

Validation in the audit's session: snapshot, rematch, cross-engine math and
real shared-memory worker tests passed; the full worker recovery suite was
interrupted. With a smaller population reservation in the test harness the
migration, desync-recovery and patch suites passed (memory, see 12).
