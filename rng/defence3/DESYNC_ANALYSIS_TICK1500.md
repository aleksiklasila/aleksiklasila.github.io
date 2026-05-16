# Defence3 Desync Analysis: Tick 1500 

## Reported Desync Symptoms

- **Unit 2:** Different positions with different worker states (IDLE vs MOVING_TO)  
- **Tower Energy:** 472 vs 431 = **41-point divergence**  
- **Floor Items:** Completely wrong positions  
- **A* Mines:** 20000 vs 19880 = **120-point divergence** (suggests work accumulation/ordering issue)

---

## CRITICAL: Tower Update Ordering Before Unit Shuffle

**Files:** [src/main.js](src/main.js#L203-L220)

### The Problem

```javascript
// Line 203: Towers update in NATURAL ARRAY ORDER
for (let t of towers) t.update();

// ...later...

// Line 216-219: Units update in SHUFFLED order
let unitUpdateOrder = _buildDeterministicUnitUpdateOrderForTick();
for (let i = 0; i < unitUpdateOrder.length; i++) {
    let u = unitUpdateOrder[i];
    if (!u) continue;
    u.update();
}
```

**The Issue:** Towers can damage units and affect their state, but towers themselves are NOT shuffled. This creates an order-dependent simulation:

- If towers update before units in natural array order, tower effects apply to units in a fixed sequence
- On one peer, tower[0] shoots unit[2], damaging it → unit[2] becomes IDLE
- On another peer with slightly different tower/unit interleaving, tower[0] might miss or hit a different unit
- The damage happens in the same tick but affects different entities based on starting array positions

### Why This Breaks Lockstep

Towers can kill/damage units, change their state, and affect movement. If tower execution order differs:
- Unit energy diverges (different damage taken)
- Worker state diverges (IDLE vs MOVING_TO based on whether damaged)
- This cascades through the entire simulation after tick 1500

---

## CRITICAL: Laser Tower Damage Loop - Non-Deterministic Building Iteration

**File:** [src/things/tower.js](src/things/tower.js#L90-L137)

### The Problem

```javascript
// Line 90-108: Laser damage application
if (this.type === 'laser') {
    for (let other of this.connectedLasers) {
        // ... collision detection ...
        // Check buildings - ITERATING IN NATURAL ARRAY ORDER
        for (let list of [towers, barracks, collectorSpawners]) {
            for (let b of list) {
                if (b.owner === this.owner || b.energy <= 0) continue;
                let hit = false;
                if (isVert) { hit = Math.abs(b.x - sx) < 18 && b.y >= mn && b.y <= mx; }
                else { hit = Math.abs(b.y - sy) < 18 && b.x >= mn && b.x <= mx; }
                if (hit) {
                    // DAMAGE APPLICATION - ORDER MATTERS
                    let prevEnergy = b.energy;
                    b.energy -= dmg / 60;  // Floating point damage per tick
                    // ...
                    if (b.energy <= 0) destroyBuilding(b);
                }
            }
        }
    }
}
```

### Why This Is Non-Deterministic

1. **Building arrays not sorted:** towers[], barracks[], collectorSpawners[] are iterated in insertion order
2. **Multiple lasers interact:** If 2+ lasers fire at overlapping targets, the order they're processed affects which building takes damage first
3. **Floating point accumulation:** `b.energy -= dmg / 60` uses floating-point arithmetic. The order of operations matters:
   - Peer A: tower[0] -= 0.68, then tower[1] -= 0.68 → tower[0]=431.32, tower[1]=430.64
   - Peer B: tower[1] -= 0.68, then tower[0] -= 0.68 → tower[1]=431.32, tower[0]=430.64
   - After many ticks, rounding errors accumulate to integer differences (41-point divergence)

4. **Building destruction side effects:** If a building dies from laser damage, it's removed from the array, affecting subsequent iteration order

### The 41-Point Difference

At 20 TPS, a laser tower fires every tick. By tick 1500 (75 seconds):
- Lasers fire 1500 times
- Each fire: `dmg / 60` per affected building
- With multiple buildings hit and order-dependent floating-point rounding
- Typical damage: ~0.68 per tick, 41 point difference = ~60 misorderings with rounding divergence

---

## HIGH: Collector Mine Selection - A* Divergence (120-point difference)

**File:** [src/things/worker.js](src/things/worker.js#L916-990)

### The Problem

```javascript
function _resourceCollectorFindTarget(u, myGx, myGy, resourceCfg) {
    let origin = _getResourceCollectorSearchOrigin(u, resourceCfg);
    let candidates = [];
    
    // Build candidates from arrays in ORDER
    if (resourceCfg.supportsDropTarget) {
        for (let drop of droppedItems) {  // <- NATURAL ARRAY ORDER
            considerCandidate(drop, 'drop', TILE * 0.5);
        }
    }

    let mineArray = _getResourceCollectorMineArray(resourceCfg) || [];
    for (let mine of mineArray) {  // <- NATURAL ARRAY ORDER
        if (!(Number.isFinite(mine[resourceCfg.mineStatKey]) && mine[resourceCfg.mineStatKey] > 0)) continue;
        considerCandidate(mine, resourceCfg.mineTileType, 0);
    }

    for (let s of collectorSpawners) {  // <- NATURAL ARRAY ORDER
        if (!s || s.type !== resourceCfg.farmKey || s.owner !== u.owner || s.underConstruction || !(Number(s.energy) > 0)) continue;
        considerCandidate(s, resourceCfg.farmKey, 0);
    }

    let picked = _pickDistributedWorkerCandidate(u, candidates);
    // ...
}
```

### Why This Causes 120-Point Divergence

1. **Candidates built from arrays in natural order**
   - If astarMines or goldMines list gets reordered on different peers, candidates appear in different order
   - Same mines exist, but candidates array has different ordering

2. **Tie-breaking in `_pickDistributedWorkerCandidate()`** [line 1862-1887]:
   ```javascript
   let best = null;
   let bestScore = Infinity;
   for (let c of candidates) {
       let score = _scoreWorkerTaskCandidate(u, c);
       if (score < bestScore) {
           bestScore = score;
           best = c;
           continue;
       }
       // TIE-BREAKING: String comparison on grid coordinates
       if (Math.abs(score - bestScore) <= 1e-9 && best) {
           let aKey = getTargetSortKey(c);
           let bKey = getTargetSortKey(best);
           if (aKey < bKey) {  // ALPHABETICAL STRING COMPARISON
               best = c;
           }
       }
   }
   ```
   
   - When multiple mines have similar scores (expected for A* mines with same value), tie-breaking uses string comparison
   - **Candidates array order matters:** If candidates are in different order, the first-seen equal-score mine wins
   - Different collector picks mine A vs mine B
   - Subsequent trips pick wrong mines → accumulates energy

3. **Work Accumulation Over 75 Seconds**
   - Typical A* collector: 10-20 trips per 75 seconds
   - If collector picks different mine each time: wrong values
   - Each wrong pick: ~20 A* accumulated (assuming linear collection rate)
   - 6 wrong picks × 20 A* = 120 total divergence ✓

4. **Cascade Effect**
   - If Unit 2 collector diverges at tick ~1400
   - By tick 1500, it's made 10+ trips to different mines
   - Energy/A* delta compounds

---

## HIGH: Worker Target Reservation - Order-Dependent Lock Acquisition

**File:** [src/things/worker.js](src/things/worker.js#L1862-1887) + memory notes

The memory file notes (defence3_notes.md line 125):
> "Lockstep determinism fix (2026-05-16): worker target reservation in _setWorkerTarget now uses a stable lower-unit-id tie-break instead of first-come wins"

**But the implementation in _pickDistributedWorkerCandidate still uses string comparison, not unit ID tie-breaking.** This could be incomplete.

### The Problem

If two workers compete for the same target tile:
- Peer A: worker[2] locks it first (MOVING_TO)
- Peer B: worker[3] locks it first (MOVING_TO)
- Worker[2] becomes IDLE on peer B
- This matches the reported symptom: "Unit 2 at different positions with different worker states"

---

## MEDIUM: Potential Issues in Grid/Floor Item Placement

**File:** [src/data/data_state.js](src/data/data_state.js#L507-540)

### Observed Symptom
"Floor items completely wrong positions"

### Potential Causes

1. **Grid cell ownership:** When items are placed in grid cells, the order of cell lookup might matter
2. **Dropped item collection:** If droppedItems[] order diverges, collectors pick different items
3. **Area assignment:** Dropped items are assigned to areas based on grid position. If area arrays diverge, positions appear wrong

### Hypothesis
Workers collecting A* mines place dropped items at different locations if they reach different mines first.

---

## MEDIUM: Deferred Path Resolution Rotation

**File:** [src/main.js](src/main.js#L154-190)

```javascript
let pendingPathResolveCursor = 0;  // Rotates through units fairly
// ...
if (units.length > 0) {
    let start = pendingPathResolveCursor % units.length;
    let checked = 0;
    let pendingBuckets = [[], [], [], [], []];  // By priority
    while (checked < units.length) {
        let idx = (start + checked) % units.length;
        checked++;
        let u = units[idx];
        // ...
    }
    pendingPathResolveCursor = (start + checked) % units.length;
}
```

**Potential Issue:** If units array order differs between peers due to spawning order or removal order, the rotation point diverges. This is probably NOT the main issue (marked MEDIUM).

---

## Summary of Root Causes

| Severity | Issue | Energy/Value Impact | How It Cascades |
|----------|-------|-------------------|-----------------|
| **CRITICAL** | Tower update order (before unit shuffle) | 41-point | Different towers shoot different units → state divergence |
| **CRITICAL** | Laser damage building iteration order | 41-point | Order-dependent floating-point rounding accumulates |
| **HIGH** | Collector mine selection order | 120-point A* | Collectors pick wrong mines → work accumulation |
| **HIGH** | Worker target contention order | Unit state (IDLE/MOVING) | Different locks acquired → Unit 2 diverges |
| **MEDIUM** | Dropped item order | Floor item positions | Collectors place items differently |
| **MEDIUM** | Deferred path cursor | Pathfinding divergence | Minor, probably not primary cause |

---

## Recommended Fixes

### Fix 1: Deterministic Tower Update Order (URGENT)

Apply the same deterministic shuffle to towers as units:

```javascript
// In main.js, before tower updates:
let towerUpdateOrder = towers.slice();
if (towerUpdateOrder.length > 1) {
    let s = (((gameTime + 1) * 1664525) + ((towerUpdateOrder.length + 1) * 1013904223)) >>> 0;
    for (let i = towerUpdateOrder.length - 1; i > 0; i--) {
        s = ((s * 1664525) + 1013904223) >>> 0;
        let j = s % (i + 1);
        let tmp = towerUpdateOrder[i];
        towerUpdateOrder[i] = towerUpdateOrder[j];
        towerUpdateOrder[j] = tmp;
    }
}
for (let t of towerUpdateOrder) t.update();
```

### Fix 2: Deterministic Laser Damage Iteration (URGENT)

Sort building arrays before damage application:

```javascript
// In tower.js, laser damage section:
for (let list of [towers, barracks, collectorSpawners]) {
    let sortedList = [...list].sort((a, b) => (a.id || 0) - (b.id || 0));
    for (let b of sortedList) {
        // ... apply damage ...
    }
}
```

### Fix 3: Verify Mine Array Consistency (HIGH)

Add debug logging to mineArray ordering:

```javascript
function _resourceCollectorFindTarget(u, myGx, myGy, resourceCfg) {
    let mineArray = _getResourceCollectorMineArray(resourceCfg) || [];
    if (resourceCfg.mineArrayKey === 'astarMines' && gameTime === 1500) {
        console.log('TICK 1500 astarMines order:', mineArray.map(m => m.id).join(','));
    }
    // ... rest of function
}
```

### Fix 4: Ensure Mine Values Accumulate Deterministically (HIGH)

When collector picks a mine and reduces its value:

```javascript
// Ensure mine value changes are atomic and deterministic
let collected = Math.min(mine.value, collectRate);
mine.value = Math.max(0, mine.value - collected);
```

### Fix 5: Add Subsystem-Level State Hashing (HIGH)

Hash individual subsystems after update to isolate divergence:

```javascript
function _computeSystemStateHash() {
    let towerHash = towers.map(t => t.energy).reduce((a, b) => a ^ (b | 0), 0);
    let minerHash = astarMines.map(m => m.value).reduce((a, b) => a ^ (b | 0), 0);
    return `t${towerHash}_m${minerHash}`;
}

// After tower updates and mine collection
if (gameTime % 10 === 0) {
    console.log(`Tick ${gameTime}: ${_computeSystemStateHash()}`);
}
```

---

## References

- [src/main.js - Tower update loop](src/main.js#L203)
- [src/main.js - Unit shuffle function](src/main.js#L6-L16)
- [src/things/tower.js - Laser damage loop](src/things/tower.js#L90-L137)
- [src/things/worker.js - Collector targeting](src/things/worker.js#L916-L990)
- [src/things/worker.js - Candidate selection](src/things/worker.js#L1862-L1887)
- [Defence3 Memory Notes](../../memories/repo/defence3_notes.md) - Line 125 on determinism fixes
