"use strict";

// ============================================================
// ADJACENCY & LASER CONNECTIONS
// ============================================================
// Laser links: two lasers of one owner in the same row or column, 1 to
// min(effective levels) tiles apart, no wall between (other towers do not
// block). Each tower's partners are in towers-array order. Lasers of a
// line are only compared with the next ones along it within reach, so a
// recompute is O(lasers log lasers + links), not O(towers^2).
const _laserLines = new Map();
function recalculateLaserConnections() {
    _laserLinksDirty = false;
    const lines = _laserLines, partners = [];
    lines.clear();
    for (let i = 0; i < towers.length; i++) {
        const t = towers[i];
        if (t.type !== 'laser') continue;
        t.connectedLasers = []; t._laserLinkLevel = t.effectiveLevel;
        // (Lines by owner and row/column: string keys, owners may be anything.)
        const kc = 'c' + t.owner + ':' + t.gx, kr = 'r' + t.owner + ':' + t.gy;
        let a = lines.get(kc); if (!a) lines.set(kc, a = []); a.push(i);
        let b = lines.get(kr); if (!b) lines.set(kr, b = []); b.push(i);
    }
    for (const [key, list] of lines) {
        if (list.length < 2) continue;
        const col = key[0] === 'c';
        list.sort((x, y) => (col ? towers[x].gy - towers[y].gy : towers[x].gx - towers[y].gx) || x - y);
        // (A laser without a numeric level links at any distance: the
        // minimum of the levels is NaN, never exceeded.)
        let anyNaN = false;
        for (let k = 0; k < list.length && !anyNaN; k++) anyNaN = !(towers[list[k]].effectiveLevel >= -Infinity);
        for (let a = 0; a < list.length; a++) {
            const t1 = towers[list[a]], c1 = col ? t1.gy : t1.gx, l1 = t1.effectiveLevel;
            for (let b = a + 1; b < list.length; b++) {
                const t2 = towers[list[b]], dist = (col ? t2.gy : t2.gx) - c1, gap = dist - 1;
                // (Further ones are further: past t1's level none can link.)
                if (gap > l1 && !anyNaN) break;
                if (gap < 1) continue;
                const limit = Math.min(l1, t2.effectiveLevel);
                if (gap > limit) continue;
                let blocked = false;
                if (col) { for (let y = c1 + 1; y < c1 + dist && !blocked; y++) if (grid[y][t1.gx].type === TYPE_WALL) blocked = true; }
                else { const row = grid[t1.gy]; for (let x = c1 + 1; x < c1 + dist && !blocked; x++) if (row[x].type === TYPE_WALL) blocked = true; }
                if (blocked) continue;
                partners.push(list[a], list[b]);
            }
        }
    }
    if (!partners.length) return;
    // Each tower's partners in towers-array order.
    const byTower = new Map();
    for (let k = 0; k < partners.length; k += 2) {
        const i = partners[k], j = partners[k + 1];
        let a = byTower.get(i); if (!a) byTower.set(i, a = []); a.push(j);
        let b = byTower.get(j); if (!b) byTower.set(j, b = []); b.push(i);
    }
    for (const [i, list] of byTower) {
        list.sort((x, y) => x - y);
        const out = towers[i].connectedLasers;
        for (const j of list) out.push(towers[j]);
    }
}
// Structures placed or removed: the links are made again before they are
// next used (a laser's update, the end of the tick: ensureLaserConnections),
// once however many changed. Restores recompute at once.
let _laserLinksDirty = false;
function markLaserConnectionsDirty() { _laserLinksDirty = true; }
function ensureLaserConnections() { if (_laserLinksDirty) recalculateLaserConnections(); }

function _isOperationalAdjacencyEntity(obj) {
    if (!obj) return false;
    if (obj.underConstruction) return false;
    let lvl = (obj.effectiveLevel !== undefined ? obj.effectiveLevel : obj.level);
    if (lvl !== undefined && lvl <= 0) return false;
    return true;
}

function _getCanonicalAreaCellsById(areaId, fallbackArea = null) {
    let aId = Math.floor(Number(areaId));
    if (aId >= 0 && Array.isArray(gridCellsByArea) && Array.isArray(gridCellsByArea[aId]) && gridCellsByArea[aId].length > 0) {
        return gridCellsByArea[aId];
    }
    let area = fallbackArea || getAreaById(aId);
    if (!area || !Array.isArray(area.cells) || area.cells.length <= 0) return [];
    return area.cells.filter(cp => cp && Number.isFinite(cp.x) && Number.isFinite(cp.y));
}

function _getAdjacencySignatureAt(gx, gy) {
    if (gx < 0 || gx >= GRID_W || gy < 0 || gy >= GRID_H) return null;
    let ref = getTileEntityRef(gx, gy);
    if (!ref || !_isOperationalAdjacencyEntity(ref)) return null;
    if (ref instanceof Tower) {
        if (!grid[gy] || !grid[gy][gx] || grid[gy][gx].type !== TYPE_WALL) return null;
        let owner = Number.isFinite(ref.owner) ? ref.owner : grid[gy][gx].owner;
        if (!Number.isFinite(owner) || owner < 0) return null;
        let type = String(ref.type || '');
        if (!type) return null;
        return {
            obj: ref,
            isTower: true,
            owner,
            type,
            unitType: '',
            sigKey: `T|${owner}|${type}`
        };
    }

    if (getTileEntityType(gx, gy) === TILE_ENTITY_GOLDMINE) return null;
    let owner = Number.isFinite(ref.owner) ? ref.owner : (grid[gy] && grid[gy][gx] ? grid[gy][gx].owner : -1);
    if (!Number.isFinite(owner) || owner < 0) return null;
    let type = String(ref.type || '');
    if (!type) return null;
    let unitType = type === 'barrack' ? String(ref.unitType || 'norm') : '';
    return {
        obj: ref,
        isTower: false,
        owner,
        type,
        unitType,
        sigKey: `I|${owner}|${type}|${unitType}`
    };
}

// Portals (cloud towers) join path regions; spawners are route targets.
function _adjacencyObjAffectsPaths(obj) {
    if (obj instanceof Tower) return !!(obj.baseStats && obj.baseStats.isCloud);
    return obj instanceof CollectorSpawner || obj instanceof AstarSpawner || obj instanceof SalvagerSpawner
        || obj instanceof BuilderSpawner || obj instanceof HealerSpawner || obj instanceof ResearchSpawner;
}

function _runAdjacencyRecalculation() {
    if (!_adjacencyNeedsRecalc) return;
    if (!_adjacencyDirtyAll && _adjacencyDirtyTiles.size <= 0) {
        _adjacencyNeedsRecalc = false;
        _adjacencyPassiveRefreshMode = false;
        return;
    }

    let passiveRefresh = !!_adjacencyPassiveRefreshMode;
    let runFull = _adjacencyDirtyAll || _adjacencyDirtyTiles.size > 1200;
    let prevAreaActive = areas.map(a => !!(a && a.active));
    let areaVisualsChanged = false;
    let touchedAreaIds = new Set();
    let seeds = [];
    let seedKeySet = new Set();

    let touchesPathTopology = false;
    let pushSeedAt = (gx, gy) => {
        let sig = _getAdjacencySignatureAt(gx, gy);
        if (!sig || !sig.obj || !Number.isFinite(sig.obj.gx) || !Number.isFinite(sig.obj.gy)) return;
        if (!touchesPathTopology && _adjacencyObjAffectsPaths(sig.obj)) touchesPathTopology = true;
        let key = _adjTileKey(sig.obj.gx, sig.obj.gy);
        if (seedKeySet.has(key)) return;
        seedKeySet.add(key);
        seeds.push(sig.obj);
    };

    if (runFull) {
        for (let i = 0; i < areas.length; i++) touchedAreaIds.add(i);
        for (let ent of _activeTileEntities) {
            if (!ent || !Number.isFinite(ent.gx) || !Number.isFinite(ent.gy)) continue;
            pushSeedAt(ent.gx, ent.gy);
        }
    } else {
        for (let key of _adjacencyDirtyTiles) {
            let gx = key % GRID_W;
            let gy = Math.floor(key / GRID_W);
            if (gx < 0 || gx >= GRID_W || gy < 0 || gy >= GRID_H) continue;
            let cell = grid[gy] && grid[gy][gx];
            if (cell && Number.isFinite(cell.areaId) && cell.areaId >= 0) touchedAreaIds.add(cell.areaId);
            for (let dy = -1; dy <= 1; dy++) {
                for (let dx = -1; dx <= 1; dx++) {
                    pushSeedAt(gx + dx, gy + dy);
                }
            }
        }
    }

    if (runFull) {
        for (let a of areas) if (a) a.active = false;
    } else {
        for (let aId of touchedAreaIds) {
            let a = getAreaById(aId);
            if (a) a.active = false;
        }
    }

    const areaSignatureCache = new Map();
    const getAreaSignatureKey = (aId) => {
        try {
            if (areaSignatureCache.has(aId)) return areaSignatureCache.get(aId);
            let area = getAreaById(aId);
            let areaCells = _getCanonicalAreaCellsById(aId, area);
            if (!area || areaCells.length <= 0) {
                areaSignatureCache.set(aId, null);
                return null;
            }
            let firstKey = null;
            for (let cp of areaCells) {
                let cx = cp?.x;
                let cy = cp?.y;
                if (!Number.isFinite(cx) || !Number.isFinite(cy)) {
                    areaSignatureCache.set(aId, null);
                    return null;
                }
                let sig = _getAdjacencySignatureAt(cx, cy);
                if (!sig) {
                    areaSignatureCache.set(aId, null);
                    return null;
                }
                if (firstKey === null) firstKey = sig.sigKey;
                else if (firstKey !== sig.sigKey) {
                    areaSignatureCache.set(aId, null);
                    return null;
                }
            }
            areaSignatureCache.set(aId, firstKey);
            return firstKey;
        } catch {
            areaSignatureCache.set(aId, null);
            return null;
        }
    };

    let visited = new Set();
    let dirs4 = [[0, 1], [0, -1], [1, 0], [-1, 0]];

    for (let seed of seeds) {
        if (!seed || !Number.isFinite(seed.gx) || !Number.isFinite(seed.gy)) continue;
        let rootSig = _getAdjacencySignatureAt(seed.gx, seed.gy);
        if (!rootSig) continue;
        let rootKey = _adjTileKey(seed.gx, seed.gy);
        if (visited.has(rootKey)) continue;

        let queue = [{ x: seed.gx, y: seed.gy }];
        let qHead = 0;
        let group = [];
        let touchedAreas = new Set();

        const enqueueMatchingCell = (tx, ty) => {
            if (tx < 0 || tx >= GRID_W || ty < 0 || ty >= GRID_H) return;
            let key = _adjTileKey(tx, ty);
            if (visited.has(key)) return;
            let sig = _getAdjacencySignatureAt(tx, ty);
            if (!sig || sig.sigKey !== rootSig.sigKey) return;
            visited.add(key);
            queue.push({ x: tx, y: ty });
            group.push(sig.obj);
            let cell = grid[ty] && grid[ty][tx];
            if (cell && Number.isFinite(cell.areaId) && cell.areaId >= 0) {
                touchedAreas.add(cell.areaId);
                touchedAreaIds.add(cell.areaId);
            }
        };

        enqueueMatchingCell(seed.gx, seed.gy);

        while (qHead < queue.length) {
            let cur = queue[qHead++];
            for (let d of dirs4) {
                let nx = cur.x + d[0], ny = cur.y + d[1];
                enqueueMatchingCell(nx, ny);

                let cloud = getTowerAtTile(nx, ny);
                if (!cloud || cloud.owner !== rootSig.owner || !_isOperationalAdjacencyEntity(cloud) || !(cloud.baseStats && cloud.baseStats.isCloud)) continue;
                let partner = getPairedCloudTower(cloud, rootSig.owner);
                let endpoints = [cloud];
                if (partner) endpoints.push(partner);
                for (let ep of endpoints) {
                    for (let d2 of dirs4) {
                        enqueueMatchingCell(ep.gx + d2[0], ep.gy + d2[1]);
                    }
                }
            }
        }

        if (group.length <= 0) continue;

        let areaMult = 1;
        for (let aId of touchedAreas) {
            let area = getAreaById(aId);
            if (!area) continue;
            let areaSig = getAreaSignatureKey(aId);
            if (areaSig !== rootSig.sigKey) continue;
            let power = (area.multiplierLevel || 0) + 1;
            let areaCellCount = _getCanonicalAreaCellsById(aId, area).length;
            areaMult *= detPow(Math.max(1, areaCellCount), power);
        }

        let groupSize = group.length;
        for (let obj of group) {
            let nextStacks = getThingStackedStacks(obj);
            let nextManualStacks = getThingManualStacks(obj);
            let actualStacks = nextStacks || 1;
            let nextEffectiveStacks = actualStacks * groupSize * areaMult;
            let nextPotentialStacks = Math.max(actualStacks, nextManualStacks) * groupSize * areaMult;
            let nextPotentialLevel = stackCountToLevel(nextPotentialStacks);
            let nextEffectiveLevel = stackCountToLevel(nextEffectiveStacks);
            let nextIsUpgrading = !!obj.isUpgrading;

            if (!passiveRefresh) {
                if (nextEffectiveLevel < Math.max(1, Math.floor(Number(obj.effectiveLevel) || 1))) {
                    nextIsUpgrading = false;
                }

                if (!isAutoUpgradeEnabled(obj) && nextIsUpgrading) {
                    nextIsUpgrading = false;
                }
            }

            // Passive area refresh should only affect adjacency-derived values.
            if (!passiveRefresh) {
                obj.stacks = nextStacks;
                obj.manualStacks = nextManualStacks;
            }
            obj.effectiveStacks = nextEffectiveStacks;
            obj.potentialEffectiveLevel = nextPotentialLevel;
            obj.effectiveLevel = nextEffectiveLevel;
            if (!passiveRefresh) obj.isUpgrading = nextIsUpgrading;

            let baseLevel = getThingBaseLevel(obj);
            let researchedMaxLevel = getThingResearchedMaxLevel(obj);
            let maxAutoUpgradeLevel = Math.min(obj.effectiveLevel, researchedMaxLevel);
            if (!passiveRefresh && baseLevel < maxAutoUpgradeLevel && !obj.underConstruction && !obj.isUpgrading && isAutoUpgradeEnabled(obj)) {
                beginUpgradeProgress(obj, baseLevel + 1);
            }

            if (!passiveRefresh) {
                if (!obj.underConstruction && !obj.isUpgrading) {
                    // Only set isStacking if there are remaining stacks AND they won't exceed max level
                    if (getThingRemainingStacks(obj) > 0 && isAutoStackEnabled(obj)) {
                        let nextStackLevel = stackCountToLevel(getThingStackedStacks(obj) + 1);
                        let maxLevel = getThingResearchedMaxLevel(obj);
                        obj.isStacking = nextStackLevel <= maxLevel;
                    } else {
                        obj.isStacking = false;
                    }
                    if (!obj.isStacking) obj.stackingWorkDone = 0;
                } else if (obj.isUpgrading) {
                    obj.isStacking = false;
                }
            }

            // Stats follow from these (research changes reach them through
            // the periodic refresh): members of a big group whose inputs did
            // not change keep theirs instead of rebuilding every table.
            // Snapshotted, so every peer skips the same members.
            let statsSig = baseLevel + '|' + obj.effectiveLevel + '|' + nextPotentialLevel + '|' + (obj.isUpgrading ? 1 : 0)
                + '|' + (obj.underConstruction ? 1 : 0) + '|' + obj.upgrademaxEnergy + '|' + groupSize + '|' + areaMult + '|' + obj.owner;
            if (obj._adjStatsSig === statsSig && obj.effectiveGroupSize === groupSize && obj.effectiveAreaMult === areaMult) continue;
            obj._adjStatsSig = statsSig;

            if (obj.updateStats) {
                obj.effectiveGroupSize = groupSize;
                obj.effectiveAreaMult = areaMult;
                obj.updateStats();
                let statsType = (obj.type === 'barrack' && obj.unitType) ? ('barrack_' + obj.unitType) : obj.type;
                if (statsType) {
                    let baseStats = calculateItemStats(statsType, getThingBaseLevel(obj), obj.owner);
                    let potentialStats = clonePrecomputedWithBaseMaxEnergy(baseStats, calculateItemStats(statsType, nextPotentialLevel, obj.owner), false);
                    obj.preComputedPotential = potentialStats;
                }
            } else {
                obj.effectiveGroupSize = groupSize;
                obj.effectiveAreaMult = areaMult;
                let statsType = (obj.type === 'barrack' && obj.unitType) ? ('barrack_' + obj.unitType) : obj.type;
                let baseStats = calculateItemStats(statsType, getThingBaseLevel(obj), obj.owner);
                let stats = clonePrecomputedWithBaseMaxEnergy(baseStats, calculateItemStats(statsType, obj.effectiveLevel, obj.owner), false);
                let potentialStats = clonePrecomputedWithBaseMaxEnergy(baseStats, calculateItemStats(statsType, nextPotentialLevel, obj.owner), false);
                obj.preComputedBase = baseStats;
                obj.preComputedEffective = stats;
                obj.preComputedPotential = potentialStats;
                obj.preComputed = obj.preComputedBase;
                if (obj.isUpgrading && obj.upgrademaxEnergy > 0) {
                    obj.maxEnergy = Math.max(1, Math.floor(obj.upgrademaxEnergy));
                    if (!Number.isFinite(obj.energy) || obj.energy < 1) obj.energy = 1;
                    obj.energy = Math.min(obj.energy, obj.maxEnergy);
                    if (stats.damage) obj.damage = stats.damage;
                } else {
                    let prevEnergy = Number(obj.energy);
                    if (!Number.isFinite(prevEnergy)) prevEnergy = Number(baseStats.maxEnergy) || 1;
                    obj.maxEnergy = baseStats.maxEnergy;
                    if (stats.damage) obj.damage = stats.damage;
                    obj.energy = Math.max(1, Math.min(obj.maxEnergy, Math.floor(prevEnergy)));
                }
                updateItemTextCache(obj);
                if (typeof visCoverOnBuildingChanged === 'function') visCoverOnBuildingChanged(obj);
            }
        }
    }

    for (let aId of touchedAreaIds) {
        let a = getAreaById(aId);
        if (!a) continue;
        let nextActive = !!getAreaSignatureKey(aId);
        if (!passiveRefresh && !nextActive && a.multiplierLevel > 0) {
            a.multiplierLevel = 0;
            areaVisualsChanged = true;
        }
        if (!!prevAreaActive[aId] !== nextActive) areaVisualsChanged = true;
        a.active = nextActive;
    }

    if (areaVisualsChanged) dirtyAreas = true;

    // Paths and routes only change when walkability does (placements,
    // removals and mines bump on their own) or when a portal or spawner may
    // have come into service: a finished barrack or turret keeps every
    // path cache.
    if (runFull || touchesPathTopology) _bumpPathTopologyVersion();
    _adjacencyNeedsRecalc = false;
    _adjacencyDirtyAll = false;
    _adjacencyDirtyTiles.clear();
    _adjacencyLastRecalcTick = gameTime;
    _adjacencyPassiveRefreshMode = false;
}

function recalculateAdjacency(forceFull = false, options = null) {
    if (forceFull && typeof forceFull === 'object') {
        options = forceFull;
        forceFull = !!options.forceFull;
    }
    if (forceFull) _adjacencyDirtyAll = true;
    _adjacencyPassiveRefreshMode = !!(options && options.passiveRefresh);
    _adjacencyNeedsRecalc = true;
    if (_adjacencyLastRecalcTick === gameTime) return;
    _runAdjacencyRecalculation();
}

function getUnitEffectiveStatsRecalcTicks() {
    return Math.max(1, Math.min(240, Math.floor(Number(UNIT_EFFECTIVE_STATS_RECALC_TICKS) || 1)));
}

function getThingStatsRecalcIntervalTicks() {
    let seconds = Number(THING_STATS_RECALC_INTERVAL_SECONDS);
    if (!Number.isFinite(seconds)) seconds = 3;
    return Math.max(1, Math.min(36000, Math.floor(seconds * TICK_RATE) || 1));
}

function getUnitCollisionRecalcTicks() {
    return Math.max(1, Math.min(240, Math.floor(Number(UNIT_COLLISION_RECALC_TICKS) || 1)));
}

// Rebuild a building's derived stat tables from its level and owner, without
// the energy adjustments of a periodic refresh. Snapshots leave the tables
// out (they are most of a snapshot's size) and restore them with this.
function restoreDerivedThingStats(item) {
    if (!item || item.unitType && !(item instanceof Barrack)) return;
    let statsType = (item.type === 'barrack' && item.unitType) ? ('barrack_' + item.unitType) : item.type;
    if (!statsType || !BASE_CARD_TYPES[statsType]) return;
    let baseLevel = getThingBaseLevel(item);
    let effectiveLevel = getThingEffectiveLevel(item, baseLevel);
    let potentialLevel = getThingPotentialLevel(item, effectiveLevel);
    let base = calculateItemStats(statsType, baseLevel, item.owner);
    if (!(item instanceof Tower)) {
        item.preComputedBase = base;
        item.preComputedEffective = clonePrecomputedWithBaseMaxEnergy(base, calculateItemStats(statsType, effectiveLevel, item.owner), false);
        item.preComputed = item.preComputedBase;
    }
    item.preComputedPotential = clonePrecomputedWithBaseMaxEnergy(base, calculateItemStats(statsType, potentialLevel, item.owner), false);
}

function _refreshThingPrecomputedStats(item) {
    if (!item || item.dead) return;

    // Units only (barracks carry a unitType too: theirs are building stats).
    if (item instanceof Unit && item.unitType && Number.isFinite(item.owner)) {
        let baseLevel = getUnitBaseLevel(item);
        let effectiveLevel = getUnitEffectiveLevel(item, baseLevel);
        // Its tables unchanged (same levels, no stat table rebuilt since its
        // last refresh): the refresh would only redo the field writes below,
        // so those alone (the same outcome, without the table work).
        const lvl = Math.max(1, Math.floor(baseLevel || 1)), eff = Math.max(1, Math.floor(effectiveLevel || 1));
        if (item._statsVer === _precomputedStatsVersion && item.baseLevel === lvl && item.effectiveLevel === eff
            && Number.isFinite(item.stackCount) && item.stackCount >= 1 && item.preComputedBase && item.preComputed === item.preComputedEffective
            && item.basePreComputed === item.preComputedBase && !!item.isFlying === !!(BASE_UNIT_STATS[item.unitType] || BASE_UNIT_STATS.norm || {}).isFlying
            && item.preComputedBase === computeUnitLevelScaledStats(item, lvl)
            && item.preComputedEffective === clonePrecomputedWithBaseMaxEnergy(item.preComputedBase, computeUnitLevelScaledStats(item, eff))) {
            item.unitLevel = lvl;
            item.effectiveStacks = Math.max(1, Math.floor(item.stackCount));
            item.maxEnergy = item.preComputedBase.maxEnergy;
            let e = Number(item.energy);
            if (!Number.isFinite(e)) e = Number(item.preComputedBase.maxEnergy) || 1;
            item.energy = Math.max(1, Math.min(item.maxEnergy, Math.floor(e)));
            item.effectiveLevel = eff;
            return;
        }
        applyUnitLevelScaling(item, baseLevel);
        applyUnitEffectiveScaling(item, effectiveLevel);
        item._statsVer = _precomputedStatsVersion;
        return;
    }

    let statsType = (item.type === 'barrack' && item.unitType) ? ('barrack_' + item.unitType) : item.type;
    if (!statsType) return;

    if (item.updateStats) {
        item.updateStats();
        let baseLevelForPotential = getThingBaseLevel(item);
        let potentialLevelForPotential = getThingPotentialLevel(item, getThingEffectiveLevel(item, baseLevelForPotential));
        let baseStatsForPotential = calculateItemStats(statsType, baseLevelForPotential, item.owner);
        item.preComputedPotential = clonePrecomputedWithBaseMaxEnergy(baseStatsForPotential, calculateItemStats(statsType, potentialLevelForPotential, item.owner), false);
        return;
    }

    let baseLevel = getThingBaseLevel(item);
    let effectiveLevel = getThingEffectiveLevel(item, baseLevel);
    let potentialLevel = getThingPotentialLevel(item, effectiveLevel);
    item.preComputedBase = calculateItemStats(statsType, baseLevel, item.owner);
    item.preComputedEffective = clonePrecomputedWithBaseMaxEnergy(item.preComputedBase, calculateItemStats(statsType, effectiveLevel, item.owner), false);
    item.preComputedPotential = clonePrecomputedWithBaseMaxEnergy(item.preComputedBase, calculateItemStats(statsType, potentialLevel, item.owner), false);
    item.preComputed = item.preComputedBase;

    if (item.isUpgrading && item.upgrademaxEnergy > 0) {
        item.maxEnergy = Math.max(1, Math.floor(item.upgrademaxEnergy));
        if (!Number.isFinite(item.energy) || item.energy < 1) item.energy = 1;
        item.energy = Math.min(item.energy, item.maxEnergy);
        if (item.preComputed && Number.isFinite(item.preComputed.damage)) item.damage = item.preComputed.damage;
    } else if (item.underConstruction) {
        let prevEnergy = Number(item.energy);
        if (!Number.isFinite(prevEnergy)) prevEnergy = 1;
        item.maxEnergy = Number(item.preComputedBase && item.preComputedBase.maxEnergy) || item.maxEnergy;
        if (item.preComputed && Number.isFinite(item.preComputed.damage)) item.damage = item.preComputed.damage;
        item.energy = Math.max(1, Math.min(item.maxEnergy, prevEnergy));
    } else {
        let prevEnergy = Number(item.energy);
        if (!Number.isFinite(prevEnergy)) prevEnergy = Number(item.preComputedBase && item.preComputedBase.maxEnergy) || 1;
        item.maxEnergy = Number(item.preComputedBase && item.preComputedBase.maxEnergy) || item.maxEnergy;
        if (item.preComputed && Number.isFinite(item.preComputed.damage)) item.damage = item.preComputed.damage;
        item.energy = Math.max(1, Math.min(item.maxEnergy, Math.floor(prevEnergy)));
    }

    updateItemTextCache(item);
    if (typeof visCoverOnBuildingChanged === 'function') visCoverOnBuildingChanged(item);
}

// Selected things refresh stats sooner so the info panel stays live (single
// player only). A large selection is spread over a few ticks, about 32
// refreshes per tick, instead of refreshing a whole army every tick.
const SELECTION_STATS_REFRESH_PER_TICK = 32;
function _isSelectionStatsRefreshDue(item, selectionSize) {
    if (selectionSize <= SELECTION_STATS_REFRESH_PER_TICK) return true;
    let every = Math.min(10, Math.ceil(selectionSize / SELECTION_STATS_REFRESH_PER_TICK));
    let seed = Number.isFinite(item.id) ? Math.floor(item.id) : (Math.floor(Number(item.gx) || 0) * 7 + Math.floor(Number(item.gy) || 0));
    return ((gameTime + seed) % every + every) % every === 0;
}

// Units created since the last stats pass (u._needsStatsInit): refreshed on
// their first tick, before their turn in the strided passes below comes up.
// The list follows the flag, which snapshots carry: a restore rebuilds it.
// (Capped: where no tick drains it, e.g. the page beside a simulation
// worker, it is dropped.)
let _newUnitsForStats = [];
function _noteNewUnitForStats(u) {
    if (_newUnitsForStats.length >= 65536) _newUnitsForStats.length = 0;
    _newUnitsForStats.push(u);
}
function resetNewUnitsForStats() {
    _newUnitsForStats = [];
    for (let u of units) if (u && u._needsStatsInit) _newUnitsForStats.push(u);
}

// A strided pass: the units at indices congruent to the tick modulo the
// interval, so each tick touches only the due share. Removals shift
// indices, which can move a unit's turn by a tick or so.
function _forEachStridedUnit(intervalTicks, tick, fn) {
    let step = Math.max(1, intervalTicks | 0);
    for (let i = tick % step, n = units.length; i < n; i += step) {
        let u = units[i];
        if (u && !u.dead) fn(u);
    }
}

// Periodic refreshes run on a fixed phase per thing instead of a countdown
// stored on it: a thing is due on the ticks where (gameTime + phase) is a
// multiple of the interval. Deciding that is a little integer math per
// thing, with no per-tick writes to every unit and building.
function _thingStatsPhase(item, intervalTicks) {
    if (intervalTicks <= 1) return 0;
    let seed;
    if (Number.isFinite(item.id)) seed = (Math.floor(item.id) * 1103515245 + 12345) >>> 0;
    else seed = (((Math.floor(Number(item.gx) || 0) + 1) * 73856093) ^ ((Math.floor(Number(item.gy) || 0) + 1) * 19349663)) >>> 0;
    return seed % intervalTicks;
}

let _thingStatsRefreshStamp = 0;

function recalculateThingPrecomputedStats() {
    let intervalTicks = getThingStatsRecalcIntervalTicks();
    let tick = Math.max(0, Math.floor(Number(gameTime) || 0));
    let selectedUnitSet = null;
    let selectedEntitySet = null;
    if (!isMultiplayer || !gameStarted) {
        if (selectedUnits && selectedUnits.length > 0) selectedUnitSet = new Set(selectedUnits);
        if (selectedEntities && selectedEntities.length > 0) selectedEntitySet = new Set(selectedEntities);
    }
    let selectionSize = (selectedUnitSet ? selectedUnitSet.size : 0) + (selectedEntitySet ? selectedEntitySet.size : 0);

    // New units, the strided share and (single player) the selection; a
    // stamp keeps a unit to one refresh per call.
    let unitStamp = ++_thingStatsRefreshStamp;
    let refreshUnit = (u) => {
        if (!u || u.dead || u._thingStatsRefreshStamp === unitStamp) return;
        u._thingStatsRefreshStamp = unitStamp;
        _refreshThingPrecomputedStats(u);
    };
    for (let u of _newUnitsForStats) {
        if (!u._needsStatsInit) continue;
        u._needsStatsInit = false;
        refreshUnit(u);
    }
    _newUnitsForStats.length = 0;
    _forEachStridedUnit(intervalTicks, tick, refreshUnit);
    if (selectedUnitSet) for (let u of selectedUnitSet) if (_isSelectionStatsRefreshDue(u, selectionSize)) refreshUnit(u);

    // Buildings and floor items: those due this tick (their phase bucket),
    // new ones (no stats yet) and, single player, the selection; in tile
    // order, a stamp refreshing each at most once per call.
    let stamp = ++_thingStatsRefreshStamp;
    let processThing = (item) => {
        if (!item || item.dead || item._thingStatsRefreshStamp === stamp) return;
        item._thingStatsRefreshStamp = stamp;
        _refreshThingPrecomputedStats(item);
    };
    for (const item of _thingStatsDue(intervalTicks, tick)) processThing(item);
    if (selectedEntitySet) for (let item of selectedEntitySet) {
        if (item && !(item instanceof Unit) && _isSelectionStatsRefreshDue(item, selectionSize)) processThing(item);
    }
}

// The cells' items (buildings, floor items) by refresh phase: per phase
// tile -> item, kept from the tile entity journal (made anew when the tile
// index was rebuilt); items placed since the last call that have no stats
// yet are due at once.
let _thingPhaseBuckets = null;
function _thingStatsDue(intervalTicks, tick) {
    let B = _thingPhaseBuckets;
    const changes = B && B.interval === intervalTicks && B.w === GRID_W && B.h === GRID_H ? tileEntityChangesSince(B.cursor) : null;
    const due = [];
    const add = (t, e) => {
        const p = _thingStatsPhase(e, intervalTicks);
        B.buckets[p].set(t, e); B.phaseOf.set(t, p);
        if (!(e.preComputed && Number.isFinite(e.preComputed.maxEnergy))) due.push(e);
    };
    if (changes === null) {
        B = _thingPhaseBuckets = { interval: intervalTicks, w: GRID_W, h: GRID_H, cursor: { epoch: -1, pos: 0 },
            buckets: Array.from({ length: intervalTicks }, () => new Map()), phaseOf: new Map() };
        tileEntityChangesSince(B.cursor);
        for (const e of _activeTileEntities) {
            if (!e || getTileEntityRef(e.gx, e.gy) !== e) continue;
            const cell = grid[e.gy] && grid[e.gy][e.gx];
            if (cell && cell.item === e) add(e.gy * GRID_W + e.gx, e);
        }
    } else for (const t of changes) {
        const p = B.phaseOf.get(t);
        if (p !== undefined) { B.buckets[p].delete(t); B.phaseOf.delete(t); }
        const gx = t % GRID_W, gy = (t - gx) / GRID_W, e = getTileEntityRef(gx, gy), cell = grid[gy] && grid[gy][gx];
        if (e && cell && cell.item === e) add(t, e);
    }
    for (const e of B.buckets[(intervalTicks - tick % intervalTicks) % intervalTicks].values()) due.push(e);
    due.sort((a, b) => (a.gy * GRID_W + a.gx) - (b.gy * GRID_W + b.gx));
    return due;
}

function _effectiveStatsRadiusPx(u) {
    return Math.max(0.5, Number((u.basePreComputed && u.basePreComputed.visionRange) || (u.preComputed && u.preComputed.visionRange) || 0.5)) * TILE;
}

// Scratch for _countNearbySameTypeUnits, reused across ticks (no garbage).
let _effCountPrefix = new Int32Array(0);
let _effCountWin = new Int32Array(0); // per due unit: x1, y1, x2, y2, pair key

// Nearby same-owner same-type unit counts for the due units, from the
// spatial chunk counts over the square of chunks around each unit (clamped
// to the map). Units are grouped by owner and type; each group either sums
// its windows directly or, when the windows overlap a lot, builds a
// summed-area table over just the box they cover and answers each in O(1).
// Whichever is cheaper is used; both give the same exact integer counts.
let _effCountOut = new Int32Array(0);
function _countNearbySameTypeUnits(dueUnits, n, similarOut, chunkPx) {
    if (_effCountWin.length < n * 5) _effCountWin = simSharedArray(Int32Array, Math.max(n * 5, _effCountWin.length * 2));
    let win = _effCountWin;
    let typeCount = Math.max(1, spatialUnitsComplexUnitTypeCount | 0);
    let groups = new Map(); // pair key -> [indices]
    for (let i = 0; i < n; i++) {
        let u = dueUnits[i];
        win[i * 5 + 4] = -1;
        let owner = Math.floor(Number(u.owner));
        let typeIdx = spatialUnitTypeToIndex[u.unitType];
        if (!Number.isFinite(typeIdx) || typeIdx < 0) continue;
        if (!(owner >= 0 && owner < spatialUnitsComplexPlayerCount)) continue;
        let cx = Math.floor(u.x / chunkPx);
        let cy = Math.floor(u.y / chunkPx);
        let chunkRadius = Math.max(0, Math.ceil(_effectiveStatsRadiusPx(u) / chunkPx));
        let x1 = Math.max(0, Math.min(CHUNKS_W - 1, cx - chunkRadius));
        let y1 = Math.max(0, Math.min(CHUNKS_H - 1, cy - chunkRadius));
        let x2 = Math.max(0, Math.min(CHUNKS_W - 1, cx + chunkRadius));
        let y2 = Math.max(0, Math.min(CHUNKS_H - 1, cy + chunkRadius));
        if (!(x1 <= x2 && y1 <= y2)) continue; // NaN positions
        let key = owner * typeCount + typeIdx;
        let o = i * 5;
        win[o] = x1; win[o + 1] = y1; win[o + 2] = x2; win[o + 3] = y2; win[o + 4] = key;
        let list = groups.get(key);
        if (!list) { list = []; groups.set(key, list); }
        list.push(i);
    }

    let strideChunk = spatialUnitsComplexStridePerChunk;
    let data = spatialUnitsComplex;
    // Many due units (large worlds): every window summed by the kernels.
    if (n >= 2048 && typeof SIM_KERNEL_EFF_COUNT === 'number') {
        for (let i = 0; i < n; i++) {
            let o = i * 5, key = win[o + 4];
            if (key < 0) continue;
            let owner = Math.floor(key / typeCount), typeIdx = key - owner * typeCount;
            win[o + 4] = owner * spatialUnitsComplexStridePerPlayer + 1 + typeIdx;
        }
        if (_effCountOut.length < n) { _effCountOut = simSharedArray(Int32Array, win.length / 5); }
        simParallelBind('eff.win', win); simParallelBind('eff.out', _effCountOut); simParallelBind('spatial.cplx', data);
        const P = _simParams;
        P[0] = n; P[1] = 512; P[2] = CHUNKS_W; P[3] = strideChunk;
        simParallelRun(SIM_KERNEL_EFF_COUNT, Math.ceil(n / 512));
        for (let i = 0; i < n; i++) if (win[i * 5 + 4] >= 0) similarOut[i] = _effCountOut[i];
        return;
    }
    for (let [key, list] of groups) {
        let owner = Math.floor(key / typeCount), typeIdx = key - owner * typeCount;
        let lane = owner * spatialUnitsComplexStridePerPlayer + 1 + typeIdx;
        let bx1 = CHUNKS_W, by1 = CHUNKS_H, bx2 = -1, by2 = -1, directCost = 0;
        for (let i of list) {
            let o = i * 5;
            let x1 = win[o], y1 = win[o + 1], x2 = win[o + 2], y2 = win[o + 3];
            if (x1 < bx1) bx1 = x1;
            if (y1 < by1) by1 = y1;
            if (x2 > bx2) bx2 = x2;
            if (y2 > by2) by2 = y2;
            directCost += (x2 - x1 + 1) * (y2 - y1 + 1);
        }
        let bw = bx2 - bx1 + 1, bh = by2 - by1 + 1;
        // A table cell costs about two window reads (read, add, store).
        if (directCost <= bw * bh * 2) {
            for (let i of list) {
                let o = i * 5;
                let x1 = win[o], y1 = win[o + 1], x2 = win[o + 2], y2 = win[o + 3];
                let sum = 0;
                for (let y = y1; y <= y2; y++) {
                    let idx = (y * CHUNKS_W + x1) * strideChunk + lane;
                    for (let x = x1; x <= x2; x++, idx += strideChunk) sum += data[idx];
                }
                similarOut[i] = sum | 0;
            }
            continue;
        }
        // Summed-area table of the box, with a zero row and column in front.
        let pStride = bw + 1;
        let cells = pStride * (bh + 1);
        if (_effCountPrefix.length < cells) _effCountPrefix = new Int32Array(Math.max(cells, _effCountPrefix.length * 2));
        let prefix = _effCountPrefix;
        prefix.fill(0, 0, pStride);
        for (let ry = 1; ry <= bh; ry++) {
            let out = ry * pStride, prev = out - pStride;
            prefix[out] = 0;
            let rowAccum = 0;
            let idx = ((by1 + ry - 1) * CHUNKS_W + bx1) * strideChunk + lane;
            for (let rx = 1; rx <= bw; rx++, idx += strideChunk) {
                rowAccum += data[idx];
                prefix[out + rx] = prefix[prev + rx] + rowAccum;
            }
        }
        for (let i of list) {
            let o = i * 5;
            let xa = win[o] - bx1, ya = win[o + 1] - by1, xb = win[o + 2] - bx1 + 1, yb = win[o + 3] - by1 + 1;
            similarOut[i] = (prefix[yb * pStride + xb] - prefix[ya * pStride + xb]
                - prefix[yb * pStride + xa] + prefix[ya * pStride + xa]) | 0;
        }
    }
}

let _effectiveStatsStamp = 0;

// A unit's base tables were (re)applied (applyUnitLevelScaling): the
// effective-stats kernel can take it from the columns (esOk) while its
// window does not depend on its effective tables (_effectiveStatsRadiusPx).
function effStatsUnitBaseChanged(u) {
    const c = u && u._us;
    if (!c) return;
    const s = u._si, b = u.basePreComputed, typeIdx = spatialUnitTypeToIndex[u.unitType];
    const ok = !!(b && Number.isFinite(b.visionRange) && b.visionRange && Number.isFinite(b.maxEnergy)
        && Number.isFinite(typeIdx) && typeIdx >= 0 && Number.isFinite(u.baseLevel));
    c.esOk[s] = ok ? 1 : 0;
    if (!ok) return;
    const chunkPx = Math.max(1, CHUNK_SIZE * TILE);
    c.esRad[s] = Math.max(0, Math.ceil(Math.max(0.5, Number(b.visionRange)) * TILE / chunkPx));
    c.esType[s] = typeIdx;
}
// Every unit takes the full path once more (a restore replaced tables in
// place, the stat tables changed).
function effStatsInvalidateAll() {
    if (typeof _simUnitState !== 'undefined' && _simUnitState) _simUnitState.columns.esOk.fill(0);
}
let _effStatsVersion = -1;

// The nearby same-owner same-type count of one unit (the full path): the
// spatial chunk counts over its window, as the kernel sums them.
function _effWindowCount(u, chunkPx) {
    let owner = Math.floor(Number(u.owner));
    let typeIdx = spatialUnitTypeToIndex[u.unitType];
    if (!Number.isFinite(typeIdx) || typeIdx < 0 || !(owner >= 0 && owner < spatialUnitsComplexPlayerCount)) return 0;
    let cx = Math.floor(u.x / chunkPx), cy = Math.floor(u.y / chunkPx);
    let chunkRadius = Math.max(0, Math.ceil(_effectiveStatsRadiusPx(u) / chunkPx));
    let x1 = Math.max(0, Math.min(CHUNKS_W - 1, cx - chunkRadius)), y1 = Math.max(0, Math.min(CHUNKS_H - 1, cy - chunkRadius));
    let x2 = Math.max(0, Math.min(CHUNKS_W - 1, cx + chunkRadius)), y2 = Math.max(0, Math.min(CHUNKS_H - 1, cy + chunkRadius));
    if (!(x1 <= x2 && y1 <= y2)) return 0;
    let strideChunk = spatialUnitsComplexStridePerChunk, data = spatialUnitsComplex;
    let lane = owner * spatialUnitsComplexStridePerPlayer + 1 + typeIdx, sum = 0;
    for (let y = y1; y <= y2; y++) {
        let idx = (y * CHUNKS_W + x1) * strideChunk + lane;
        for (let x = x1; x <= x2; x++, idx += strideChunk) sum += data[idx];
    }
    return sum | 0;
}

// One unit, the whole way (new units, the selection, units the kernel
// leaves to objects): base stacks and level (its base tables made again
// when they do not fit), the nearby count, effective stacks and level, and
// its effective tables when that level changed.
function _effStatsFullUnit(u, canUseSpatialCounts, chunkPx) {
    let baseStacks = getUnitStackCount(u);
    let baseLevel = stackCountToLevel(baseStacks);
    let needsRefresh = !Number.isFinite(u.baseLevel) || u.baseLevel !== baseLevel ||
        !(u.basePreComputed && Number.isFinite(u.basePreComputed.visionRange)) || !(u.basePreComputed && Number.isFinite(u.basePreComputed.maxEnergy));
    u.stackCount = baseStacks;
    u.unitLevel = baseLevel;
    if (needsRefresh) {
        applyUnitLevelScaling(u, baseLevel);
        u.stackCount = baseStacks;
    } else if (u._us && !u._us.esOk[u._si]) effStatsUnitBaseChanged(u);
    let similarCount = canUseSpatialCounts ? _effWindowCount(u, chunkPx) : 0;
    if (similarCount <= 0) {
        let radiusPx = _effectiveStatsRadiusPx(u);
        forEachUnitInRange(u.x, u.y, radiusPx, () => { similarCount++; }, { player: u.owner, unitType: u.unitType });
    }
    if (similarCount < 1) similarCount = 1;
    let effStacks = Math.max(1, Math.floor(similarCount * baseStacks));
    u.effectiveStacks = effStacks;
    u.effectiveLevel = stackCountToLevel(effStacks);
    let nextEffLevel = getUnitEffectiveLevel(u);
    if (needsRefresh || u._lastAppliedEffectiveLevel !== nextEffLevel) {
        applyUnitEffectiveScaling(u, nextEffLevel);
        u._lastAppliedEffectiveLevel = nextEffLevel;
    }
}

// Units' effective stats: new units, the strided share of the units
// (1/intervalTicks of them a tick, by index) and, in single player, the
// selection. The strided share runs in the kernels from the columns
// (SIM_KERNEL_EFF_UNITS: stacks, levels, nearby counts); only units whose
// effective level changed (their effective tables), and units the columns
// cannot answer for, are touched as objects, in the share's order.
let _effFlags = null;
function recalculateUnitEffectiveStats() {
    let intervalTicks = getUnitEffectiveStatsRecalcTicks();
    let selectedSet = null;
    if ((!isMultiplayer || !gameStarted) && selectedUnits && selectedUnits.length > 0) selectedSet = new Set(selectedUnits);
    let tick = Math.max(0, Math.floor(Number(gameTime) || 0));
    let stamp = ++_effectiveStatsStamp;
    if (typeof _precomputedStatsVersion !== 'undefined' && _effStatsVersion !== _precomputedStatsVersion) { _effStatsVersion = _precomputedStatsVersion; effStatsInvalidateAll(); }
    let canUseSpatialCounts = spatialUnitsComplexStridePerChunk > 0
        && spatialUnitsComplexStridePerPlayer > 0
        && spatialUnitsComplex.length > 0
        && CHUNKS_W > 0
        && CHUNKS_H > 0;
    let chunkPx = Math.max(1, CHUNK_SIZE * TILE);
    const S = typeof _simUnitState !== 'undefined' ? _simUnitState : null;
    const taken = u => {
        if (!u || u.dead) return true;
        const c = u._us;
        if (c) { if (c.esTaken[u._si] === stamp) return true; c.esTaken[u._si] = stamp; return false; }
        if (u._effectiveStatsStamp === stamp) return true;
        u._effectiveStatsStamp = stamp;
        return false;
    };
    // New units (their list is drained by recalculateThingPrecomputedStats,
    // which runs next).
    for (let u of _newUnitsForStats) if (u._needsStatsInit && !taken(u)) _effStatsFullUnit(u, canUseSpatialCounts, chunkPx);
    // The strided share.
    let step = Math.max(1, intervalTicks | 0), phase = tick % step, n = units.length;
    let m = phase < n ? Math.ceil((n - phase) / step) : 0;
    if (m > 0 && S && canUseSpatialCounts && typeof SIM_KERNEL_EFF_UNITS === 'number' && n >= EFF_STATS_KERNEL_MIN_UNITS) {
        const slots = _unitSlotMapEnsure(), c = S.columns;
        if (!_effFlags || _effFlags.length < m) { _effFlags = simSharedArray(Uint8Array, Math.max(1024, m * 2)); simParallelBind('eff.flag', _effFlags); }
        simParallelBind('ix.slots', slots); simParallelBind('spatial.cplx', spatialUnitsComplex);
        const P = _simParams;
        P[0] = m; P[1] = 1024; P[2] = step; P[3] = phase; P[4] = chunkPx; P[5] = CHUNKS_W; P[6] = CHUNKS_H;
        P[7] = spatialUnitsComplexStridePerChunk; P[8] = spatialUnitsComplexStridePerPlayer; P[9] = spatialUnitsComplexPlayerCount;
        P[10] = MAX_THING_LEVEL; P[11] = stamp;
        simParallelRun(SIM_KERNEL_EFF_UNITS, Math.ceil(m / 1024));
        const F = _effFlags;
        for (let j = 0; j < m; j++) {
            const f = F[j];
            if (f === 0 || f === 3) continue;
            const i = phase + j * step, u = units[i];
            if (f === 1) {
                // (The kernel set its stacks and levels.)
                const s = slots[i], lvl = c.effectiveLevel[s];
                applyUnitEffectiveScaling(u, lvl);
                c._lastAppliedEffectiveLevel[s] = lvl;
            } else if (!taken(u)) _effStatsFullUnit(u, canUseSpatialCounts, chunkPx);
        }
    } else {
        for (let i = phase; i < n; i += step) { const u = units[i]; if (!taken(u)) _effStatsFullUnit(u, canUseSpatialCounts, chunkPx); }
    }
    // The selection (single player only: never local timing in multiplayer).
    if (selectedSet) for (let u of selectedSet) if (_isSelectionStatsRefreshDue(u, selectedSet.size) && !taken(u)) _effStatsFullUnit(u, canUseSpatialCounts, chunkPx);
}
// From this many units the strided share runs in the kernels (tests lower
// it; both ways give the same state).
let EFF_STATS_KERNEL_MIN_UNITS = 2048;

// ============================================================
// BUILDING PLACEMENT & DESTRUCTION
// ============================================================
function _areaHasForeignBuildPresence(areaId, playerId) {
    let aId = Math.floor(Number(areaId));
    if (!(aId >= 0)) return false;

    let unitBucket = spatialUnitsByArea[aId];
    if (unitBucket instanceof Set) {
        for (let u of unitBucket) {
            if (!u || u.dead || u.owner === playerId) continue;
            return true;
        }
    }

    let area = getAreaById(aId);
    let areaCells = _getCanonicalAreaCellsById(aId, area);
    if (areaCells.length <= 0) return false;
    for (let cellPos of areaCells) {
        let ref = getTileEntityRef(cellPos.x, cellPos.y);
        if (!ref) continue;
        if (!Number.isFinite(ref.owner) || ref.owner < 0 || ref.owner === playerId) continue;
        return true;
    }
    return false;
}

function _isBuildAreaContested(gx, gy, playerId) {
    return _areaHasForeignBuildPresence(getAreaIdAtTile(gx, gy), playerId);
}

function canBuildAt(gx, gy, playerId) {
    if (gx < 0 || gx >= GRID_W || gy < 0 || gy >= GRID_H) return false;
    if (!isTileActuallyVisibleToPlayer(playerId, gx, gy)) return false;
    if (!(isMultiplayer && gameStarted) && _isBuildAreaContested(gx, gy, playerId)) return false;
    if (grid[gy][gx].type === TYPE_WALL) return false;
    if (grid[gy][gx].item) return false;
    // Don't allow building on gold mines
    if (getGoldMineAt(gx, gy)) return false;
    if (getAstarMineAt(gx, gy)) return false;
    // Check within 5 tiles of any fully-built owned building
    /*
    // distance thing disabled for now.
    for (let t of towers) { if (t.owner === playerId && !t.underConstruction && Math.abs(t.gx - gx) + Math.abs(t.gy - gy) <= 5) return true; }
    for (let b of barracks) { if (b.owner === playerId && !b.underConstruction && Math.abs(b.gx - gx) + Math.abs(b.gy - gy) <= 5) return true; }
    for (let s of collectorSpawners) { if (s.owner === playerId && !s.underConstruction && Math.abs(s.gx - gx) + Math.abs(s.gy - gy) <= 5) return true; }
    // Check floor items too (exclude under-construction)
    for (let y2 = 0; y2 < GRID_H; y2++) for (let x2 = 0; x2 < GRID_W; x2++) {
        if (grid[y2][x2].item && !grid[y2][x2].item.underConstruction && grid[y2][x2].owner === playerId && Math.abs(x2 - gx) + Math.abs(y2 - gy) <= 5) return true;
    }
    return false;
    */
    return true
}

function canStackAt(gx, gy, itemKey, playerId) {
    // Check if we can stack on an existing same-type building
    if (gx < 0 || gx >= GRID_W || gy < 0 || gy >= GRID_H) return false;
    let pid = Math.floor(Number(playerId));
    let isVisible = isTileActuallyVisibleToPlayer(pid, gx, gy);
    if (!isVisible) return false;

    if (!(isMultiplayer && gameStarted) && _isBuildAreaContested(gx, gy, pid)) return false;
    let cardDef = BASE_CARD_TYPES[itemKey];
    if (!cardDef) return false;
    if (cardDef.target === 'wall') {
        let t = getTowerAtTile(gx, gy);
        let ok = !!(t && t.type === itemKey && Math.floor(Number(t.owner)) === pid);
        if (!ok && t && t.type === itemKey && gameTime % 20 === 0) {
             console.warn(`canStackAt: owner mismatch for tower. t.owner: ${t.owner}, pid: ${pid}`);
        }
        return ok;
    }
    if (itemKey.startsWith('barrack_')) {
        let unitType = cardDef.unitType || 'norm';
        let b = getBarrackAtTile(gx, gy);
        let ok = !!(b && b.unitType === unitType && Math.floor(Number(b.owner)) === pid);
        if (!ok && b && b.unitType === unitType && gameTime % 20 === 0) {
             console.warn(`canStackAt: owner mismatch for barrack. b.owner: ${b.owner}, pid: ${pid}`);
        }
        return ok;
    }
    if (itemKey === 'spawner' || itemKey === 'astar_spawner' || itemKey === 'salvager' || itemKey === 'builder_spawner' || itemKey === 'healer_spawner' || itemKey === 'research') {
        let s = getSpawnerAtTile(gx, gy);
        let ok = !!(s && s.type === itemKey && Math.floor(Number(s.owner)) === pid);
        if (!ok && s && s.type === itemKey && gameTime % 20 === 0) {
             console.warn(`canStackAt: owner mismatch for spawner. s.owner: ${s.owner}, pid: ${pid}`);
        }
        return ok;
    }
    // Floor items
    let cell = grid[gy][gx];
    let ok = !!(cell.item && cell.item.type === itemKey && Math.floor(Number(cell.owner)) === pid);
    if (!ok && cell.item && cell.item.type === itemKey && gameTime % 20 === 0) {
         console.warn(`canStackAt: owner mismatch for floor item. cell.owner: ${cell.owner}, pid: ${pid}`);
    }
    return ok;
}

const AREA_LEVEL_COLORS = ['#888', '#4f4', '#4af', '#c4f', '#f90', '#fd0'];
const AREA_LEVEL_NAMES = ['Gray', 'Green', 'Blue', 'Purple', 'Orange', 'Gold'];

function getAreaUpgradeCost(currentLevel) {
    return Math.floor(100 * detPow(3, currentLevel));
}

function placeBuilding(gx, gy, itemKey, playerId, defaults = null) {
    let cardDef = BASE_CARD_TYPES[itemKey];
    if (!cardDef) return false;
    let placedNewStructure = false;
    let placedNewWallStructure = false;

    // Simulation code must not read this client's UI toggles (they differ
    // between players); the placing player's choice travels in the action.
    let useDefaultAutoUpgrade = true;
    let useDefaultBuild = true;
    let silentPlace = false;
    let ignorePlacementRules = false;
    if (defaults && typeof defaults === 'object') {
        if (defaults.autoUpgradeEnabled !== undefined) useDefaultAutoUpgrade = !!defaults.autoUpgradeEnabled;
        if (defaults.buildEnabled !== undefined) useDefaultBuild = !!defaults.buildEnabled;
        if (defaults.silent !== undefined) silentPlace = !!defaults.silent;
        if (defaults.ignorePlacementRules !== undefined) ignorePlacementRules = !!defaults.ignorePlacementRules;
    }

    if (itemKey.startsWith('cloud_')) {
        let hasSameCloud = towers.some(t => t.owner === playerId && t.type === itemKey && t.energy > 0);
        if (hasSameCloud) return false;
    }

    // Area upgrader: special handling
    if (itemKey === 'area_upgrader') {
        let aId = grid[gy][gx].areaId;
        if (aId === -1) return false;
        if (_areaHasForeignBuildPresence(aId, playerId)) return false;
        let area = getAreaById(aId);
        if (!area) return false;
        let areaCells = _getCanonicalAreaCellsById(aId, area);
        if (areaCells.length <= 0) return false;
        // Check if ALL cells in area are occupied by any building/item (any owner)
        let allFilled = areaCells.every(cp => {
            if (!cp || !Number.isFinite(cp.x) || !Number.isFinite(cp.y)) return false;
            let c = grid[cp.y][cp.x];
            if (!c) return false;
            if (c.type === TYPE_WALL) {
                let t = getTowerAtTile(cp.x, cp.y);
                if (t && !t.underConstruction && getDisplayLevel(t) > 0) return true;
            }
            if (c.item && !c.item.underConstruction && getDisplayLevel(c.item) > 0) return true;
            let b = getBarrackAtTile(cp.x, cp.y);
            if (b && !b.underConstruction && getDisplayLevel(b) > 0) return true;
            let s = getSpawnerAtTile(cp.x, cp.y);
            if (s && !s.underConstruction && getDisplayLevel(s) > 0) return true;
            return false;
        });
        if (!allFilled) return false;
        if ((area.multiplierLevel || 0) >= 5) return false;
        let upgradeCost = getAreaUpgradeCost(area.multiplierLevel || 0);
        addPlayerResource(playerId, 'energy', -upgradeCost);
        recordEnergyDelta(playerId, 'builder', -upgradeCost);
        area.multiplierLevel = (area.multiplierLevel || 0) + 1;
        _markCombinedBgAreaDirty(aId, 1);
        for (let cp of areaCells) {
            if (!cp || !Number.isFinite(cp.x) || !Number.isFinite(cp.y)) continue;
            requestAdjacencyRecalc(cp.x, cp.y, 0);
        }
        recalculateAdjacency({ passiveRefresh: true });
        if (playerId === localPlayerId && !silentPlace) playSound('place', gx * TILE + 16, gy * TILE + 16);
        return true;
    }

    // Allow startup/bootstrap spawns to bypass visibility/normal placement gates.
    // This keeps configured starter spawns deterministic even under fog/contested checks.
    if (!ignorePlacementRules) {
        // Allow stacking on existing same-type buildings, otherwise check canBuildAt
        if (!canStackAt(gx, gy, itemKey, playerId) && !canBuildAt(gx, gy, playerId)) return false;
    }

    if (cardDef.target === 'wall') {
        // Tower - check if same type exists for stacking
        let existing = getTowerAtTile(gx, gy);
        if (!(existing && existing.type === itemKey && existing.owner === playerId)) existing = null;
        if (existing) { existing.upgrade(); }
        else {
            grid[gy][gx].type = TYPE_WALL;
            grid[gy][gx].owner = playerId;
            simMoveTileTypeChanged(gx, gy);
            let t = new Tower(gx, gy, itemKey, playerId);
            t.underConstruction = true; t.energy = 1;
            t.autoUpgradeEnabled = useDefaultAutoUpgrade;
            t.buildEnabled = useDefaultBuild;
            t.level = 0; t.effectiveLevel = 0; t.potentialEffectiveLevel = 0;
            t.updateTextCache();
            towers.push(t);
            setTileEntity(gx, gy, itemKey, t);
            placedNewStructure = true;
            placedNewWallStructure = true;
        }
        _markCombinedBgTileDirty(gx, gy, 0, true);
    } else if (itemKey.startsWith('barrack_')) {
        let unitType = cardDef.unitType || 'norm';
        let existing = getBarrackAtTile(gx, gy);
        if (!(existing && existing.unitType === unitType && existing.owner === playerId)) existing = null;
        if (existing) {
            addManualStackToThing(existing, 1);
        }
        else {
            let b = new Barrack(gx, gy, playerId, unitType);
            b.underConstruction = true; b.energy = 1;
            b.autoUpgradeEnabled = useDefaultAutoUpgrade;
            b.buildEnabled = useDefaultBuild;
            b.level = 0; b.effectiveLevel = 0; b.potentialEffectiveLevel = 0;
            updateItemTextCache(b);
            barracks.push(b); barracksChanged();
            grid[gy][gx].item = b;
            grid[gy][gx].owner = playerId;
            setTileEntity(gx, gy, itemKey, b);
            placedNewStructure = true;
        }
    } else if (itemKey === 'spawner') {
        let existing = getSpawnerAtTile(gx, gy);
        if (!(existing && existing.type === 'spawner' && existing.owner === playerId)) existing = null;
        if (existing) {
            addManualStackToThing(existing, 1);
        }
        else {
            let s = new CollectorSpawner(gx, gy, playerId);
            s.underConstruction = true; s.energy = 1;
            s.autoUpgradeEnabled = useDefaultAutoUpgrade;
            s.buildEnabled = useDefaultBuild;
            s.level = 0; s.effectiveLevel = 0; s.potentialEffectiveLevel = 0;
            updateItemTextCache(s);
            collectorSpawners.push(s); collectorSpawnersChanged();
            grid[gy][gx].item = s;
            grid[gy][gx].owner = playerId;
            setTileEntity(gx, gy, itemKey, s);
            placedNewStructure = true;
        }
    } else if (itemKey === 'astar_spawner') {
        let existing = getSpawnerAtTile(gx, gy);
        if (!(existing && existing.type === 'astar_spawner' && existing.owner === playerId)) existing = null;
        if (existing) {
            addManualStackToThing(existing, 1);
        }
        else {
            let s = new AstarSpawner(gx, gy, playerId);
            s.underConstruction = true; s.energy = 1;
            s.autoUpgradeEnabled = useDefaultAutoUpgrade;
            s.buildEnabled = useDefaultBuild;
            s.level = 0; s.effectiveLevel = 0; s.potentialEffectiveLevel = 0;
            updateItemTextCache(s);
            collectorSpawners.push(s); collectorSpawnersChanged();
            grid[gy][gx].item = s;
            grid[gy][gx].owner = playerId;
            setTileEntity(gx, gy, itemKey, s);
            placedNewStructure = true;
        }
    } else if (itemKey === 'salvager') {
        let existing = getSpawnerAtTile(gx, gy);
        if (!(existing && existing.type === 'salvager' && existing.owner === playerId)) existing = null;
        if (existing) {
            addManualStackToThing(existing, 1);
        }
        else {
            let s = new SalvagerSpawner(gx, gy, playerId);
            s.underConstruction = true; s.energy = 1;
            s.autoUpgradeEnabled = useDefaultAutoUpgrade;
            s.buildEnabled = useDefaultBuild;
            s.level = 0; s.effectiveLevel = 0; s.potentialEffectiveLevel = 0;
            updateItemTextCache(s);
            collectorSpawners.push(s); collectorSpawnersChanged();
            grid[gy][gx].item = s;
            grid[gy][gx].owner = playerId;
            setTileEntity(gx, gy, itemKey, s);
            placedNewStructure = true;
        }
    } else if (itemKey === 'builder_spawner') {
        let existing = getSpawnerAtTile(gx, gy);
        if (!(existing && existing.type === 'builder_spawner' && existing.owner === playerId)) existing = null;
        if (existing) {
            addManualStackToThing(existing, 1);
        }
        else {
            let s = new BuilderSpawner(gx, gy, playerId);
            // builder spawner starts under construction too
            s.underConstruction = true; s.energy = 1;
            s.autoUpgradeEnabled = useDefaultAutoUpgrade;
            s.buildEnabled = useDefaultBuild;
            s.level = 0; s.effectiveLevel = 0; s.potentialEffectiveLevel = 0;
            updateItemTextCache(s);
            collectorSpawners.push(s); collectorSpawnersChanged();
            grid[gy][gx].item = s;
            grid[gy][gx].owner = playerId;
            setTileEntity(gx, gy, itemKey, s);
            placedNewStructure = true;
        }
    } else if (itemKey === 'healer_spawner') {
        let existing = getSpawnerAtTile(gx, gy);
        if (!(existing && existing.type === 'healer_spawner' && existing.owner === playerId)) existing = null;
        if (existing) {
            addManualStackToThing(existing, 1);
        }
        else {
            let s = new HealerSpawner(gx, gy, playerId);
            s.underConstruction = true; s.energy = 1;
            s.autoUpgradeEnabled = useDefaultAutoUpgrade;
            s.buildEnabled = useDefaultBuild;
            s.level = 0; s.effectiveLevel = 0; s.potentialEffectiveLevel = 0;
            updateItemTextCache(s);
            collectorSpawners.push(s); collectorSpawnersChanged();
            grid[gy][gx].item = s;
            grid[gy][gx].owner = playerId;
            setTileEntity(gx, gy, itemKey, s);
            placedNewStructure = true;
        }
    } else if (itemKey === 'research') {
        let existing = getSpawnerAtTile(gx, gy);
        if (!(existing && existing.type === 'research' && existing.owner === playerId)) existing = null;
        if (existing) {
            addManualStackToThing(existing, 1);
        }
        else {
            let s = new ResearchSpawner(gx, gy, playerId);
            s.underConstruction = true; s.energy = 1;
            s.autoUpgradeEnabled = useDefaultAutoUpgrade;
            s.buildEnabled = useDefaultBuild;
            s.level = 0; s.effectiveLevel = 0; s.potentialEffectiveLevel = 0;
            updateItemTextCache(s);
            collectorSpawners.push(s); collectorSpawnersChanged();
            grid[gy][gx].item = s;
            grid[gy][gx].owner = playerId;
            setTileEntity(gx, gy, itemKey, s);
            placedNewStructure = true;
        }
    } else {
        // Floor item
        let cell = grid[gy][gx];
        if (cell.item && cell.item.type === itemKey && cell.owner === playerId) {
            addManualStackToThing(cell.item, 1);
        } else {
            let stats = calculateItemStats(itemKey, 1, playerId);
            let item = { type: itemKey, stacks: 1, manualStacks: 1, effectiveStacks: 1, level: 0, effectiveLevel: 0, potentialEffectiveLevel: 0, isStacking: false, stackingWorkDone: 0, energy: 1, maxEnergy: stats.maxEnergy, damage: stats.damage || 0, gx, gy, x: gx * TILE + 16, y: gy * TILE + 16, underConstruction: true, owner: playerId, markedForSalvage: false, autoUpgradeEnabled: useDefaultAutoUpgrade, buildEnabled: useDefaultBuild };
            cell.item = item;
            cell.owner = playerId;
            setTileEntity(gx, gy, itemKey, item);
            updateItemTextCache(item);
            placedNewStructure = true;
        }
    }
    // Newly placed structures start under construction, so they don't affect adjacency yet.
    // Avoid expensive full-map adjacency recalculation on every placement.
    if (placedNewStructure) _bumpPathTopologyVersion();
    if (placedNewWallStructure) markLaserConnectionsDirty();
    if (playerId === localPlayerId && !silentPlace) playSound('place', gx * TILE + 16, gy * TILE + 16);
    return true;
}

function destroyBuilding(building) {
    let buildingType = String((building && building.type) || '');
    let typeDef = BASE_CARD_TYPES[buildingType] || null;
    let isWallTargetType = !!(typeDef && typeDef.target === 'wall');

    if (building instanceof Tower || (building.constructor && building.constructor.name === 'Tower') || isWallTargetType) {
        let idx = towers.indexOf(building);
        if (idx !== -1) towers.splice(idx, 1);
        clearTileEntity(building.gx, building.gy, building);
        grid[building.gy][building.gx].type = TYPE_FLOOR;
        grid[building.gy][building.gx].owner = -1;
        simMoveTileTypeChanged(building.gx, building.gy);
        _markCombinedBgTileDirty(building.gx, building.gy, 0, true);
        recalculateAdjacency();
        markLaserConnectionsDirty();
    } else if (building instanceof Barrack || (building.type === 'barrack')) {
        let idx = barracks.indexOf(building);
        if (idx !== -1) { barracks.splice(idx, 1); barracksChanged(); }
        clearTileEntity(building.gx, building.gy, building);
        grid[building.gy][building.gx].item = null;
        grid[building.gy][building.gx].owner = -1;
        _markCombinedBgTileDirty(building.gx, building.gy, 0, false);
        recalculateAdjacency();
    } else if (building instanceof CollectorSpawner || building instanceof AstarSpawner || building instanceof SalvagerSpawner || building instanceof BuilderSpawner || building instanceof HealerSpawner || building instanceof ResearchSpawner) {
        let idx = collectorSpawners.indexOf(building);
        if (idx !== -1) { collectorSpawners.splice(idx, 1); collectorSpawnersChanged(); }
        clearTileEntity(building.gx, building.gy, building);
        grid[building.gy][building.gx].item = null;
        grid[building.gy][building.gx].owner = -1;
        _markCombinedBgTileDirty(building.gx, building.gy, 0, false);
    } else if (building.type) {
        // Floor item
        clearTileEntity(building.gx, building.gy, building);
        grid[building.gy][building.gx].item = null;
        grid[building.gy][building.gx].owner = -1;
        _markCombinedBgTileDirty(building.gx, building.gy, 0, false);
    }
    // A freed tile: walls, builder passage and routes change.
    _bumpPathTopologyVersion();
    visCoverOnBuildingChanged(building);
    createExplosion(building.x, building.y, '#f44', 10);
    playSound('building_destroyed', building.x, building.y);
    checkWinCondition();
}


// ============================================================
// ITEM STATS
// ============================================================
function getUpgrademaxEnergy(item, nextLevel) {
    if (item.type === 'barrack' || (item.type && item.type.startsWith('barrack'))) {
        let bType = item.unitType ? ('barrack_' + item.unitType) : 'barrack_norm';
        return calculateItemStats(bType, nextLevel, item.owner).maxEnergy;
    }
    if (item.type === 'spawner' || item.type === 'astar_spawner' || item.type === 'salvager' || item.type === 'builder_spawner' || item.type === 'healer_spawner' || item.type === 'research') return calculateItemStats(item.type, nextLevel, item.owner).maxEnergy;
    if (item instanceof Tower) return calculateItemStats(item.type, nextLevel, item.owner).maxEnergy;
    return calculateItemStats(item.type || 'farm', nextLevel, item.owner).maxEnergy;
}

function getThingResearchBuildingKey(item) {
    if (!item || !item.type) return '';
    if (item.type === 'barrack') return `barrack_${item.unitType || 'norm'}`;
    return String(item.type || '');
}

function getThingResearchedMaxLevel(item) {
    if (!item) return Math.max(1, MAX_THING_LEVEL);
    let key = getThingResearchBuildingKey(item);
    if (!key) return Math.max(1, MAX_THING_LEVEL);
    let owner = Number.isFinite(item.owner) ? Math.floor(item.owner) : -1;
    if (owner < 0 || typeof getPlayerResearchLevel !== 'function') return 1;
    let researchedLevel = Math.max(0, Math.floor(getPlayerResearchLevel(owner, 'building', key, 'maxLevel') || 0));
    return Math.max(1, Math.min(MAX_THING_LEVEL, 1 + Math.round(researchedLevel * (MAX_THING_LEVEL - 1) / Math.max(1, MAX_RESEARCH_LEVEL))));
}

function beginUpgradeProgress(item, nextLevel) {
    if (!item) return;
    let targetLevel = Math.max(1, clampThingLevel(Math.floor(Number(nextLevel) || 1)));
    if (targetLevel > getThingResearchedMaxLevel(item)) return;
    let targetmaxEnergy = Math.max(1, Math.floor(getUpgrademaxEnergy(item, nextLevel) || (item.maxEnergy || 1)));
    item.isUpgrading = true;
    item.isStacking = false;
    item.upgrademaxEnergy = targetmaxEnergy;
    item.maxEnergy = targetmaxEnergy;
    if (!Number.isFinite(item.energy) || item.energy < 1) item.energy = 1;
    item.energy = Math.min(item.energy, item.maxEnergy);
}

function getDisplayLevel(item) {
    if (!item) return 1;
    if (item.underConstruction) return 0;
    if (item.effectiveLevel !== undefined) return clampThingLevel(item.effectiveLevel);
    if (item.level !== undefined) return clampThingLevel(item.level);
    return stackCountToLevel(item.stacks || 1);
}

function getRequiredStacksForLevel(level) {
    let lvl = Math.max(1, clampThingLevel(Math.floor(Number(level) || 1)));
    return Math.max(1, Math.round(detPow(2, lvl - 1)));
}

function getThingStackedStacks(item) {
    if (!item) return 1;
    return Math.max(1, Math.floor(Number(item.stacks) || 1));
}

function getThingManualStacks(item) {
    if (!item) return 1;
    let stacked = getThingStackedStacks(item);
    let manual = Number.isFinite(item.manualStacks) ? Math.floor(item.manualStacks) : stacked;
    return Math.max(stacked, Math.max(1, manual));
}

function getThingRemainingStacks(item) {
    return Math.max(0, getThingManualStacks(item) - getThingStackedStacks(item));
}

function getThingStackingProgressRatio(item) {
    let stacked = getThingStackedStacks(item);
    let total = getThingManualStacks(item);
    if (total <= 0) return 1;
    let stackCost = getThingStackingEnergyCost(item);
    let partial = 0;
    if (stackCost > 0) {
        let work = Math.max(0, Number(item && item.stackingWorkDone) || 0);
        partial = Math.max(0, Math.min(1, work / stackCost));
    }
    let progressStacks = Math.min(total, stacked + partial);
    return Math.max(0, Math.min(1, progressStacks / total));
}

function getThingStackingRemainingEnergy(item) {
    if (!item) return 0;
    let remainingStacks = getThingRemainingStacks(item);
    if (remainingStacks <= 0) return 0;
    let stackCost = getThingStackingEnergyCost(item);
    let done = Math.max(0, Number(item.stackingWorkDone) || 0);
    return Math.max(0, remainingStacks * stackCost - done);
}

function getThingStackingEnergyCost(item) {
    if (!item) return 1;
    let baseEnergy = getUpgrademaxEnergy(item, 1);
    if (!Number.isFinite(baseEnergy) || baseEnergy <= 0) baseEnergy = item.maxEnergy || 1;
    return Math.max(1, Math.floor(baseEnergy));
}

function refreshThingProgressState(item) {
    if (!item) return;

    item.stacks = getThingStackedStacks(item);
    item.manualStacks = getThingManualStacks(item);
    if (!Number.isFinite(item.stackingWorkDone) || item.stackingWorkDone < 0) item.stackingWorkDone = 0;

    let hasPendingStacks = getThingRemainingStacks(item) > 0;
    if (item.underConstruction || item.isUpgrading) {
        item.isStacking = false;
        return;
    }

    let baseLevel = getThingBaseLevel(item);
    let effLevel = getThingEffectiveLevel(item, baseLevel);
    let researchedMaxLevel = getThingResearchedMaxLevel(item);
    let maxAutoUpgradeLevel = Math.min(effLevel, researchedMaxLevel);
    if (baseLevel < maxAutoUpgradeLevel && isAutoUpgradeEnabled(item)) {
        beginUpgradeProgress(item, baseLevel + 1);
        item.isStacking = false;
        return;
    }

    item.isStacking = false;
    if (hasPendingStacks && isAutoStackEnabled(item)) {
        // Only stack if next stack level won't exceed max level
        let nextStackLevel = stackCountToLevel(getThingStackedStacks(item) + 1);
        let maxLevel = getThingResearchedMaxLevel(item);
        item.isStacking = nextStackLevel <= maxLevel;
    }
    if (!item.isStacking) item.stackingWorkDone = 0;
    if (!item.underConstruction && !item.isUpgrading && !item.isStacking && Number.isFinite(item.gx) && Number.isFinite(item.gy)) {
        let builderTypeIndex = _workerTypeToLoadIndex('builder');
        let tileIndex = Math.floor(item.gy) * GRID_W + Math.floor(item.gx);
        let slotIndex = tileIndex * _WORKER_TARGET_LOAD_TYPE_COUNT + builderTypeIndex;
        let reservedUnit = workerReservedTiles[slotIndex];
        if (reservedUnit) reservedUnit._workerReservedTileIndex = -1;
        workerReservedSet(slotIndex, null);
    }
}

function addManualStackToThing(item, amount = 1) {
    if (!item) return;
    let addCount = Math.max(1, Math.floor(Number(amount) || 1));
    item.stacks = getThingStackedStacks(item);
    item.manualStacks = getThingManualStacks(item) + addCount;
    item.level = stackCountToLevel(item.stacks);
    if (Number.isFinite(item.gx) && Number.isFinite(item.gy)) {
        _requestAdjacencyRecalcForThing(item, 1);
        recalculateAdjacency();
    }
    refreshThingProgressState(item);
    if (item.updateTextCache) item.updateTextCache();
    else updateItemTextCache(item);
    bumpTileOccupancyVersion();
    visCoverOnBuildingChanged(item);
}

function getThingBaseLevel(item, fallback = 1) {
    if (!item) return Math.max(1, clampThingLevel(fallback));
    if (Number.isFinite(item.level)) return Math.max(1, clampThingLevel(item.level));
    if (Number.isFinite(item.stacks)) return stackCountToLevel(item.stacks || 1);
    return Math.max(1, clampThingLevel(fallback));
}

function getThingEffectiveLevel(item, fallback = 1) {
    if (!item) return Math.max(1, clampThingLevel(fallback));
    if (Number.isFinite(item.effectiveLevel)) return Math.max(1, clampThingLevel(item.effectiveLevel));
    return getThingBaseLevel(item, fallback);
}

function getThingPotentialLevel(item, fallback = 1) {
    let lvl = getThingEffectiveLevel(item, fallback);
    if (!item) return lvl;
    if (Number.isFinite(item.potentialEffectiveLevel)) lvl = Math.max(lvl, Math.max(1, clampThingLevel(item.potentialEffectiveLevel)));
    if (Number.isFinite(item.level)) lvl = Math.max(lvl, Math.max(1, clampThingLevel(item.level)));
    if (Number.isFinite(item.stacks)) lvl = Math.max(lvl, stackCountToLevel(item.stacks || 1));
    if (Number.isFinite(item.manualStacks)) lvl = Math.max(lvl, stackCountToLevel(item.manualStacks || 1));
    return lvl;
}

function getUnitBaseLevel(unit, fallback = 1) {
    if (!unit) return Math.max(1, clampThingLevel(fallback));
    if (Number.isFinite(unit.unitLevel)) return Math.max(1, clampThingLevel(unit.unitLevel));
    if (Number.isFinite(unit.baseLevel)) return Math.max(1, clampThingLevel(unit.baseLevel));
    if (Number.isFinite(unit.stackCount)) return stackCountToLevel(unit.stackCount || 1);
    return Math.max(1, clampThingLevel(fallback));
}

function getUnitEffectiveLevel(unit, fallback = 1) {
    if (!unit) return Math.max(1, clampThingLevel(fallback));
    if (Number.isFinite(unit.effectiveLevel)) return Math.max(1, clampThingLevel(unit.effectiveLevel));
    return getUnitBaseLevel(unit, fallback);
}

function getConfiguredMaxPop() {
    return Math.max(1, Math.floor(CONFIG_MAX_POP || 200));
}

function getHousePopCapContribution(ownerId, level) {
    let lvl = Math.max(1, clampThingLevel(Math.floor(Number(level) || 1)));
    let mapped = getBuildingStatForOwner(ownerId, 'house', lvl, 'popCap');
    if (Number.isFinite(mapped)) return Math.max(1, Math.floor(mapped));
    return Math.max(1, Math.floor(detPow(1.6, lvl)));
}

function recomputePlayerPopCaps() {
    let cfgCap = getConfiguredMaxPop();
    if (_popCapScratchByOwner.length !== players.length) _popCapScratchByOwner = new Int32Array(players.length);
    else _popCapScratchByOwner.fill(0);
    let popByOwner = _popCapScratchByOwner;

    // The houses (kept per type from the tile entity journal; integer sums,
    // so their order does not matter).
    for (let item of (typeof _cellItemsOfType === 'function' ? _cellItemsOfType('house') : getCellItemsRowMajor())) {
        let cell = grid[item.gy] && grid[item.gy][item.gx];
        if (!cell || cell.item !== item || item.type !== 'house') continue;
        let owner = cell.owner;
        if (owner < 0 || owner >= players.length) continue;
        if (item.energy <= 0 || item.underConstruction) continue;
        let level = Math.max(1, Math.floor(getThingBaseLevel(item) || 1));
        popByOwner[owner] += getHousePopCapContribution(owner, level);
    }

    for (let pid = 0; pid < players.length; pid++) {
        playerPopCaps[pid] = Math.min(cfgCap, popByOwner[pid] || 0);
    }
}


function getEntityVisibilityRangeArea(e) {
    if (!e) return null;
    if (e.preComputed && Number.isFinite(e.preComputed.visionRangeArea)) return e.preComputed.visionRangeArea;
    if (e.currentStats && Number.isFinite(e.currentStats.visionRangeArea)) return e.currentStats.visionRangeArea;
    if (e.basePreComputed && Number.isFinite(e.basePreComputed.visionRangeArea)) return e.basePreComputed.visionRangeArea;
    if (e.currentStats && Number.isFinite(e.currentStats.visionRange)) return e.currentStats.visionRange;
    if (e.preComputed && Number.isFinite(e.preComputed.visionRange)) return Number(e.preComputed.visionRange) / AREA_UNIT_TILE_EQUIVALENT;
    if (e.basePreComputed && Number.isFinite(e.basePreComputed.visionRange)) return Number(e.basePreComputed.visionRange) / AREA_UNIT_TILE_EQUIVALENT;
    return null;
}

function getEntityVisibilityRangeTiles(e) {
    let area = getEntityVisibilityRangeArea(e);
    return Number.isFinite(area) ? (Number(area) * AREA_UNIT_TILE_EQUIVALENT) : null;
}

function getEntityStatsCalcType(e) {
    if (!e) return '';
    if (e.type === 'barrack' && e.unitType) return 'barrack_' + e.unitType;
    return e.type || '';
}

function getEntityBaseVisibilityRangeArea(e) {
    if (!e) return null;
    if (e.basePreComputed && Number.isFinite(e.basePreComputed.visionRangeArea)) return e.basePreComputed.visionRangeArea;
    let statsType = getEntityStatsCalcType(e);
    let baseLevel = getThingBaseLevel(e, stackCountToLevel((e.stacks || 1)));
    if (statsType) {
        let s = calculateItemStats(statsType, baseLevel, e.owner);
        if (s && Number.isFinite(s.visionRange)) return s.visionRange;
        if (typeof getBuildingStatForOwner === 'function') {
            let statVision = Number(getBuildingStatForOwner(e.owner, statsType, baseLevel, 'visionRange'));
            if (Number.isFinite(statVision)) return statVision;
        }
        let defVision = Number(BASE_CARD_TYPES && BASE_CARD_TYPES[statsType] && BASE_CARD_TYPES[statsType].visionRange);
        if (Number.isFinite(defVision)) return defVision;
    }
    return getEntityVisibilityRangeArea(e);
}

function getEntityBaseVisibilityRangeTiles(e) {
    let area = getEntityBaseVisibilityRangeArea(e);
    return Number.isFinite(area) ? (Number(area) * AREA_UNIT_TILE_EQUIVALENT) : null;
}

function getEntityEffectiveVisibilityRangeArea(e) {
    if (!e) return null;
    if (e.preComputedEffective && Number.isFinite(e.preComputedEffective.visionRangeArea)) return e.preComputedEffective.visionRangeArea;
    if (e.preComputedEffective && Number.isFinite(e.preComputedEffective.visionRange)) {
        return e.preComputedEffective.visionRange / (e.unitType && !e.type ? AREA_UNIT_TILE_EQUIVALENT : 1);
    }
    if (!e.type && e.preComputed && Number.isFinite(e.preComputed.visionRangeArea)) return e.preComputed.visionRangeArea;
    let statsType = getEntityStatsCalcType(e);
    let baseLevel = getThingBaseLevel(e, stackCountToLevel((e.stacks || 1)));
    let effLevel = getThingEffectiveLevel(e, baseLevel);
    if (statsType) {
        let s = calculateItemStats(statsType, effLevel, e.owner);
        if (s && Number.isFinite(s.visionRange)) return s.visionRange;
        if (typeof getBuildingStatForOwner === 'function') {
            let statVision = Number(getBuildingStatForOwner(e.owner, statsType, effLevel, 'visionRange'));
            if (Number.isFinite(statVision)) return statVision;
        }
        let defVision = Number(BASE_CARD_TYPES && BASE_CARD_TYPES[statsType] && BASE_CARD_TYPES[statsType].visionRange);
        if (Number.isFinite(defVision)) return defVision;
    }
    return getEntityVisibilityRangeArea(e);
}

function getEntityEffectiveVisibilityRangeTiles(e) {
    let area = getEntityEffectiveVisibilityRangeArea(e);
    return Number.isFinite(area) ? (Number(area) * AREA_UNIT_TILE_EQUIVALENT) : null;
}

function getEntityBaseEnergyMax(e) {
    if (!e) return 0;
    if (e.basePreComputed && Number.isFinite(e.basePreComputed.maxEnergy)) {
        return Math.max(1, Math.floor(e.basePreComputed.maxEnergy));
    }
    if (e.preComputedBase && Number.isFinite(e.preComputedBase.maxEnergy)) {
        return Math.max(1, Math.floor(e.preComputedBase.maxEnergy));
    }
    let statsType = getEntityStatsCalcType(e);
    let baseLevel = getThingBaseLevel(e, stackCountToLevel((e.stacks || 1)));
    if (statsType) {
        let s = calculateItemStats(statsType, baseLevel, e.owner);
        if (s && Number.isFinite(s.maxEnergy)) return Math.max(1, Math.floor(s.maxEnergy));
    }
    return 1;
}

function getEntityEffectiveEnergyMax(e) {
    if (!e) return 0;
    if (e.preComputedEffective && Number.isFinite(e.preComputedEffective.maxEnergy)) {
        return Math.max(1, Math.floor(e.preComputedEffective.maxEnergy));
    }
    if (e.preComputed && Number.isFinite(e.preComputed.maxEnergy)) {
        return Math.max(1, Math.floor(e.preComputed.maxEnergy));
    }
    if (e.currentStats && Number.isFinite(e.currentStats.maxEnergy)) {
        return Math.max(1, Math.floor(e.currentStats.maxEnergy));
    }
    let statsType = getEntityStatsCalcType(e);
    let baseLevel = getThingBaseLevel(e, stackCountToLevel((e.stacks || 1)));
    let effLevel = getThingEffectiveLevel(e, baseLevel);
    if (statsType) {
        let s = calculateItemStats(statsType, effLevel, e.owner);
        if (s && Number.isFinite(s.maxEnergy)) return Math.max(1, Math.floor(s.maxEnergy));
    }
    return Math.max(1, getEntityBaseEnergyMax(e));
}

function getEntityPotentialEnergyMax(e) {
    if (!e) return 0;
    if (e.preComputedPotential && Number.isFinite(e.preComputedPotential.maxEnergy)) {
        return Math.max(1, Math.floor(e.preComputedPotential.maxEnergy));
    }
    let statsType = getEntityStatsCalcType(e);
    let baseLevel = getThingBaseLevel(e, stackCountToLevel((e.stacks || 1)));
    let potentialLevel = getThingPotentialLevel(e, getThingEffectiveLevel(e, baseLevel));
    if (statsType) {
        let s = calculateItemStats(statsType, potentialLevel, e.owner);
        if (s && Number.isFinite(s.maxEnergy)) return Math.max(1, Math.floor(s.maxEnergy));
    }
    return Math.max(1, getEntityEffectiveEnergyMax(e));
}

function getUnitRenderActionRangeArea(u) {
    if (!u) return 0;
    if (u.workerType === 'collector' || u.workerType === 'astar_collector' || u.workerType === 'salvager' || u.workerType === 'builder' || u.workerType === 'healer' || u.workerType === 'researcher') {
        return (24 / TILE) / AREA_UNIT_TILE_EQUIVALENT;
    }
    return Math.max(0, Number(u.preComputed && u.preComputed.attackRangeArea) || 0);
}

function getUnitRenderActionRangePx(u) {
    let area = getUnitRenderActionRangeArea(u);
    return area > 0 ? (Number(area) * AREA_UNIT_TILE_EQUIVALENT * TILE) : 0;
}

function getAreaRangeCellsAtWorld(wx, wy, rangeArea) {
    let sources = getSourceAreaIdsAtWorld(wx, wy);
    if (sources.length === 0) return [];
    return getGridCellsWithinDistanceOfSources(sources, Math.floor(Math.max(0, Number(rangeArea) || 0)));
}

function markConstructionComplete(item) {
    if (!item) return;
    item.underConstruction = false;
    if ((item.level || 0) < 1) item.level = 1;
    if ((item.effectiveLevel || 0) < 1) item.effectiveLevel = 1;
    if ((item.potentialEffectiveLevel || 0) < 1) item.potentialEffectiveLevel = 1;
    refreshThingProgressState(item);
    if (item.updateTextCache) item.updateTextCache();
    else updateItemTextCache(item);
    // Built: it sees from now (visibility coverage).
    if (typeof visCoverOnBuildingChanged === 'function') visCoverOnBuildingChanged(item);
}

function isAutoUpgradeEnabled(item) {
    return item && item.autoUpgradeEnabled !== false;
}

function isBuildEnabled(item) {
    return item && item.buildEnabled !== false;
}

function isAutoStackEnabled(item) {
    return item && item.autoStackEnabled !== false;
}

function isQueueEnabled(item) {
    return item && item.queueEnabled !== false;
}

function isAutoResearchEnabled(item) {
    if (!item || item.type !== 'research') return true;
    return item.autoResearchEnabled !== false;
}


function getLevelLabelText(item) {
    if (!item) return 'L1';
    // A structure view (sim_frame_world.js): the simulation's label.
    if (item._structView) return item._labelText();
    let currentLevel = item.underConstruction
        ? 0
        : Math.max(1, Math.floor(getThingBaseLevel(item) || 1));
    let effectiveLevel = item.underConstruction
        ? Math.max(0, Math.floor(getThingEffectiveLevel(item, currentLevel || 1) || 0))
        : Math.max(1, Math.floor(getThingEffectiveLevel(item, currentLevel) || currentLevel));
    let potentialLevel = item.underConstruction
        ? Math.max(0, Math.floor(getThingPotentialLevel(item, Math.max(0, effectiveLevel)) || effectiveLevel))
        : Math.max(effectiveLevel, Math.floor(getThingPotentialLevel(item, effectiveLevel) || effectiveLevel));
    let researchedMax = (typeof getThingResearchedMaxLevel === 'function') ? getThingResearchedMaxLevel(item) : MAX_THING_LEVEL;
    let shownLevel = Math.max(effectiveLevel, potentialLevel);
    
    if (shownLevel > currentLevel) {
        // If potential exceeds research max, show differently
        if (potentialLevel > researchedMax) {
            // If current is already at max, just show current->potential with blocked marker
            if (currentLevel === researchedMax) {
                return `L${currentLevel}->L${potentialLevel}|BLOCKED`;
            }
            // Otherwise show current->max->potential with blocked marker
            return `L${currentLevel}->L${researchedMax}->L${potentialLevel}|BLOCKED`;
        }
        // Otherwise cap shown level to researched max
        shownLevel = Math.min(shownLevel, researchedMax);
        return `L${currentLevel}->L${shownLevel}`;
    }
    return `L${currentLevel}`;
}

function getUnitLevelLabelText(unit) {
    let lvl = getUnitEffectiveLevel(unit, getUnitBaseLevel(unit));
    return `L${lvl}`;
}

// How large a world point is drawn, as a 2D-equivalent zoom (screen pixels
// per world pixel). In 2D this is the camera zoom. In 3D it is the on-screen
// scale at that point, i.e. its distance to the camera: zoom, tilt and where
// the point is on the map all count, so the far end of a tilted view is
// "zoomed out" even when the camera is zoomed in.
function getViewZoomAt(worldX, worldY) {
    let r = typeof renderer3dInstance !== 'undefined' ? renderer3dInstance : null;
    if (r && r.enabled && r.lodProjectionScale > 0 && typeof renderDimensionMode !== 'undefined' && renderDimensionMode === '3d'
        && Number.isFinite(worldX) && Number.isFinite(worldY)) {
        return r.pixelsPerWorldAt(worldX / TILE, 0, worldY / TILE) / TILE;
    }
    return camera && Number.isFinite(camera.zoom) ? camera.zoom : 1;
}

// Level labels appear once a thing is drawn large enough. With an entity the
// size is measured where it is (see getViewZoomAt); in 3D a 5% band keeps a
// label from flickering while the camera moves across the threshold.
const _levelLabelShown = new WeakMap();
function _isDrawnLargeEnough(entity, threshold) {
    if (!entity) return !camera || !Number.isFinite(camera.zoom) || camera.zoom >= threshold;
    let zoom = getViewZoomAt(Number(entity.x), Number(entity.y));
    if (renderDimensionMode !== '3d') return zoom >= threshold;
    let shown = _levelLabelShown.get(entity);
    let next = shown ? zoom >= threshold * 0.95 : zoom >= threshold * 1.05;
    if (next !== shown) _levelLabelShown.set(entity, next);
    return next;
}

function shouldShowBuildingLevels(entity = null) {
    if (!(levelVisibilityMode === LEVEL_VISIBILITY_ALL || levelVisibilityMode === LEVEL_VISIBILITY_BUILDINGS)) return false;
    return _isDrawnLargeEnough(entity, 0.62);
}

function shouldShowUnitLevels(entity = null) {
    if (levelVisibilityMode !== LEVEL_VISIBILITY_ALL) return false;
    return _isDrawnLargeEnough(entity, 0.7);
}

function getLevelVisibilityButtonText() {
    if (levelVisibilityMode === LEVEL_VISIBILITY_ALL) return 'Levels: Everything';
    if (levelVisibilityMode === LEVEL_VISIBILITY_BUILDINGS) return 'Levels: Buildings';
    return 'Levels: Off';
}

function updateLevelVisibilityButton() {
    let btn = document.getElementById('btn-level-visibility');
    if (!btn) return;
    btn.value = String(levelVisibilityMode);
}

function cycleLevelVisibilityMode() {
    levelVisibilityMode = (levelVisibilityMode + 1) % 3;
    updateLevelVisibilityButton();
    saveUiSettingsToStorage();
}

function getRenderRangeButtonText() {
    if (renderRangeMode === RENDER_RANGE_TURRETS) return 'Render range: Turrets';
    if (renderRangeMode === RENDER_RANGE_TURRETS_AND_UNITS) return 'Render range: Turrets + Units';
    if (renderRangeMode === RENDER_RANGE_ALL) return 'Render range: All things';
    if (renderRangeMode === RENDER_RANGE_UNITS) return 'Render range: Units';
    if (renderRangeMode === RENDER_RANGE_BUILDINGS) return 'Render range: Buildings';
    return 'Render range: None';
}

function updateRenderRangeButton() {
    let btn = document.getElementById('btn-render-range');
    if (!btn) return;
    btn.value = String(renderRangeMode);
}

function cycleRenderRangeMode() {
    renderRangeMode = (renderRangeMode + 1) % 6;
    updateRenderRangeButton();
    saveUiSettingsToStorage();
}

function getBuildPlacementModeButtonText() {
    return `Build place: ${buildPlacementMode + 1}`;
}

function getBuildPlacementModeDescription() {
    if (buildPlacementMode === BUILD_PLACE_MODE_DRAG_KEEP) {
        return 'Left Click: place + keep selected | Shift + Left Click: place + drag place + keep selected';
    }
    if (buildPlacementMode === BUILD_PLACE_MODE_SHIFT_KEEP) {
        return 'Left Click: place + unselect | Shift + Left Click: place + keep selected';
    }
    return 'Left Click: place + unselect | Shift + Left Click: place + keep selected + drag place';
}

function updateBuildPlacementModeButton() {
    let btn = document.getElementById('btn-build-place-mode');
    if (btn) btn.textContent = getBuildPlacementModeButtonText();
    let desc = document.getElementById('build-place-mode-desc');
    if (desc) desc.textContent = getBuildPlacementModeDescription();
}

function cycleBuildPlacementMode() {
    buildPlacementMode = (buildPlacementMode + 1) % 3;
    updateBuildPlacementModeButton();
    saveUiSettingsToStorage();
}

function shouldShiftDragBuildPlace(shiftHeld) {
    if (!shiftHeld) return false;
    return buildPlacementMode === BUILD_PLACE_MODE_DRAG_KEEP || buildPlacementMode === BUILD_PLACE_MODE_SHIFT_DRAG;
}

function shouldKeepBuildSelectionAfterLeftClick(shiftHeld) {
    if (buildPlacementMode === BUILD_PLACE_MODE_DRAG_KEEP) return true;
    if (!shiftHeld) return false;
    return buildPlacementMode === BUILD_PLACE_MODE_SHIFT_KEEP || buildPlacementMode === BUILD_PLACE_MODE_SHIFT_DRAG;
}

function formatRangeStatTiles(v) {
    return Number.isFinite(v) ? `${Math.max(0, Math.floor(Number(v) / AREA_UNIT_TILE_EQUIVALENT))}a` : '-';
}
