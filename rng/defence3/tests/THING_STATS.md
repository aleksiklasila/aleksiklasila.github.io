# Editing and auditing thing definitions

`src/data/data_static.js` contains the sole authored `THING_STATS` table: units
first, followed by buildings. Each entry includes identity, role/strength/weakness,
flags, and `stats`. Runtime `BASE_UNIT_STATS`, `BASE_CARD_TYPES`, descriptions,
names and spawn timing are derived compatibility views. They are not balance
inputs or exported editor tables.

```js
attackRange: {
    base: 1,
    level: { factor: 1.06, max: 4.6 },
    researchable: true,
    research: { factor: 1.08, direction: "increase" },
    softCap: 4,
    min: 0
}
```

`level.factor` multiplies by `factor ** (level - 1)`. `linear` multiplies by
`1 + (level - 1) * linear`; `power` multiplies by `level ** power`; `add` adds
`(level - 1) * add`. These operations run in that order. `offset` changes the
exponential starting level, where needed. Optional `round`, `min`, and `max`
inside `level` apply before research. The two exceptional level models are
`population` (house capacity) and `farm` (polynomial/logarithmic production).

`researchable: false` hides research and prevents bonuses, including from old
saved research levels. Research multiplies or divides by `research.factor ** r`.
`softCap: null` means unbounded; a number sets the endpoint at the configured
maximum level and research, using the existing logarithmic interpolation.
It is an endpoint remapping, not a conventional asymptotic cap. Top-level
`round`, `min`, and `max` apply to final values. No hard maximum is assumed when
`max` is absent. House capacity can use `{model: "populationLimit"}` as its cap.

`from: "norm.trainingTime"` links producer cooldowns to the unit's training stat.
An empty level rule inherits that stat's level rule; an explicit level rule
replaces it. Producer prices similarly refer to the unit's `price`. `spawns`
defines the producer's unit type. Cyclic/missing references are rejected when
applying editor configurations. Export/transport contains the unified table.
Old base-stat/scaling tables can still be imported into the new definitions.

## Initial balance audit

All 69 things have explicit strengths and weaknesses in their definitions.
Combat units keep distinct roles: cheap frontline infantry; fragile fast raiders;
slow durable tanks/bosses; fragile flying raiders; turret-immune but fragile moles;
resistance/range specialists; costly snakes; fragile long-range scouts. Workers
remain unarmed. Moles retain turret immunity and are vulnerable to ground hazards
and defending units; flying units retain building traversal without gaining
frontline durability. Turrets retain cost, reach, cooldown, status/resistance and
placement tradeoffs. This is a numerical/role audit, not a completed matchup study.

Clear outliers adjusted in this pass:

| Thing | Change | Reason |
| --- | --- | --- |
| Fast | Attack 3 → 4 | Dangerous when it closes; still half infantry health and melee-only |
| SMG | Damage 5 → 6 | 20% more direct throughput than Pistol; shorter reach, less health, higher cost |
| Poison tower | Poison DPS 28 → 12 | Old duration/cooldown combination greatly outperformed similarly priced sustained fire; retains strong poison damage and immunity counters |
| Boss | Health growth 1.36 → 1.28; researched cooldown endpoint 0.025 → 0.05 seconds | Prevents health growth from overwhelming other melee roles and preserves a heavy-attack fire-rate weakness after maximum research |
| Ranged towers | Range explicitly researchable | The previous research menu omitted attack range despite having a range matrix |

The evaluator only runs while rebuilding shared stat rows; movement, acquisition,
and combat continue reading the same precomputed WASM-facing arrays. No per-unit
descriptor evaluation or additional environment scans were added.

Validation: `node tests/thing-stats.test.cjs`, `node tests/combat-reach.test.cjs`,
`node tests/shared-stat-rows.test.cjs`. Multiplayer worker startup, combat orders,
worker walk/work, and helper determinism tests cover the derived runtime views.
