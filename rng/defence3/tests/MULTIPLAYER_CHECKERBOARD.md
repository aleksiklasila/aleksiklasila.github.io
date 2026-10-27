# Mixed checkerboard multiplayer robustness

Run these serially. The driver uses real hosted-match command sealing and
isolated simulation contexts, with real shared-memory helper workers. It
compares both the normal hash and the harness's exact fingerprint at every
common tick, rejects unplanned repairs, checks command delivery and exclusive
occupancy, and records successful work by all six worker professions.

```powershell
$env:WASM64='0'
node --max-old-space-size=8192 tests/multiplayer-checkerboard-chaos.cjs --units=50000 --map=384 --structures=20000 --ticks=260 --dk=20 --helpers=7,0,3 --out=tests/test-runs/multiplayer-checkerboard/large.json
node --max-old-space-size=8192 tests/multiplayer-checkerboard-chaos.cjs --units=12000 --map=192 --structures=5000 --ticks=160 --dk=4 --helpers=3,0,1,2 --teams=0,1,2,0 --map-type=solar_system --network=unstable --recover --out=tests/test-runs/multiplayer-checkerboard/three-teams.json
node --max-old-space-size=8192 tests/multiplayer-checkerboard-chaos.cjs --units=18000 --map=256 --structures=8000 --ticks=160 --dk=4 --helpers=3,0,1,2 --teams=0,1,2,3 --seed=999 --map-type=islands --network=unstable --recover --out=tests/test-runs/multiplayer-checkerboard/four-teams.json
```

`--teams` assigns one team per peer; IDs must be contiguous from zero. Team
count controls initial population scaling and fixture ownership, including
research, production, armies, and each profession's job districts. Default
teams are `0,1,0`; default helpers are `7,0,3`. Distinct client variants issue
different orders against shared teammates' units, buildings and contested
tiles. `--legacy-collisions` reproduces the original identical teammate bursts.

Conflict commands lead each burst so contested placements share a tick. Extra
actions spill into successive packets at the real 256-action limit. Final
checks wait for the last packet and the simulation action backlog. Every
issued command must appear in every peer's sealed command stream; a separate
counter requires dispatch of all 30 live-game action kinds to `processAction`.
Dispatch can legitimately do nothing when a target dies, a placement loses,
or a queue is full; useful-work counters check actual gameplay separately.

`resign` and host-only `forceResignTeam` terminate participation rather than
being ordinary battle commands. Their transport/authority behavior is covered
by `multiplayer-roles-rematch.test.cjs` and `multiplayer-action-fuzz.test.cjs`.
`multiplayer-input-overflow.test.cjs` exercises the normal input queue and
reload requeues, requiring 2,310 commands to be applied exactly once across
three peers. It supports both `SIM_WORKER=0` and `SIM_WORKER=1`.

The unstable profile simulates reliable transport with retransmission delays:
80 ms latency, up to 150 ms jitter, 3% datagram-loss probability and periodic
600 ms stalls. It does not permanently drop reliable messages. `--recover`
corrupts a guest's energy after the clean battle, requires one targeted patch,
then checks 64 further ticks with no repeated repair or match-wide snapshot.

JSON retains configuration, scheduled action counts/kinds, population/work
samples, final states and raw per-tick hashes/parts. JSONL is updated during
play. On failure, `--trace --trace-from=N` retains neighboring unit-state traces
for first-divergence investigation. Population falls through ordinary combat;
requested population is not a claim about the entire measured window.

These are correctness runs, not TPS measurements. Use
`CHAOS_SPIKES_BENCHMARK.md` for serial timing captures and neighboring-tick
CPU-profile attribution before making a performance claim.
