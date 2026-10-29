// The adjacency recompute as JavaScript did it before the kernels (git HEAD
// 0dd3b18 things_utils.js, functions renamed _ref*): the oracle of
// adjacency-lane-carry.test.cjs, which evaluates this file inside its
// instance. (effectiveStacks clamped to the Int32 maximum as the apply kernel
// stores it.)
function _refAdjSig(gx, gy) {
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
function _refAdjPaths(obj) {
    if (obj instanceof Tower) return !!(obj.baseStats && obj.baseStats.isCloud);
    return obj instanceof CollectorSpawner || obj instanceof AstarSpawner || obj instanceof SalvagerSpawner
        || obj instanceof BuilderSpawner || obj instanceof HealerSpawner || obj instanceof ResearchSpawner;
}

function _refAdjRecalc() {
    if (!_adjacencyNeedsRecalc) return;
    if (!_adjacencyDirtyAll && _adjacencyDirtyTiles.size <= 0) {
        _adjacencyNeedsRecalc = false;
        _adjacencyPassiveRefreshMode = false;
        return;
    }

    let passiveRefresh = !!_adjacencyPassiveRefreshMode;
    // (Many dirty tiles: the first ADJACENCY_TILES_PER_TICK by tile index
    // now, the rest on the next ticks; only a forced recalculation does every
    // structure at once.)
    let runFull = _adjacencyDirtyAll;
    let dirtyKeys = null;
    if (!runFull) dirtyKeys = Array.from(_adjacencyDirtyTiles);
    // (Each touched area's state before: the whole list only for a full run.)
    let prevAreaActive = runFull ? areas.map(a => !!(a && a.active)) : null, prevActive = new Map();
    let areaVisualsChanged = false;
    let touchedAreaIds = new Set();
    let seeds = [];
    let seedKeySet = new Set();

    let touchesPathTopology = false;
    let pushSeedAt = (gx, gy) => {
        let sig = _refAdjSig(gx, gy);
        if (!sig || !sig.obj || !Number.isFinite(sig.obj.gx) || !Number.isFinite(sig.obj.gy)) return;
        if (!touchesPathTopology && _refAdjPaths(sig.obj)) touchesPathTopology = true;
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
        for (let key of dirtyKeys) {
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
            if (a) { prevActive.set(aId, !!a.active); a.active = false; }
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
                let sig = _refAdjSig(cx, cy);
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
        let rootSig = _refAdjSig(seed.gx, seed.gy);
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
            let sig = _refAdjSig(tx, ty);
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
            _refAdjApply(obj, groupSize, areaMult, passiveRefresh);
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
        const wasActive = prevAreaActive ? !!prevAreaActive[aId] : (prevActive.has(aId) ? prevActive.get(aId) : !!a.active);
        if (wasActive !== nextActive) areaVisualsChanged = true;
        a.active = nextActive;
    }

    if (areaVisualsChanged) dirtyAreas = true;

    // Paths and routes only change when walkability does (placements,
    // removals and mines bump on their own) or when a portal or spawner may
    // have come into service: a finished barrack or turret keeps every
    // path cache.
    if (runFull || touchesPathTopology) _bumpPathTopologyVersion();
    if (runFull) _adjacencyDirtyTiles.clear();
    _adjacencyNeedsRecalc = _adjacencyDirtyTiles.size > 0;
    _adjacencyDirtyAll = false;
    _adjacencyLastRecalcTick = gameTime;
    _adjacencyPassiveRefreshMode = false;
}

// One member of an adjacency group: its stacks, levels, upgrade/stacking
// state and stats from the group's size and area multiplier.
function _refAdjApply(obj, groupSize, areaMult, passiveRefresh) {
    const priorLevel=obj.effectiveLevel, priorPotential=obj.potentialEffectiveLevel, priorUpgrade=obj.isUpgrading, priorGroup=obj.effectiveGroupSize, priorArea=obj.effectiveAreaMult;
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
    obj.effectiveStacks = Math.min(nextEffectiveStacks, 2147483647);
    obj.potentialEffectiveLevel = nextPotentialLevel;
    // (An upgrade may come due: the workers' sites; a trap's status strength.)
    if (obj.effectiveLevel !== nextEffectiveLevel && typeof workSiteDirty === 'function') workSiteDirty(obj.gx, obj.gy);
    if (obj.effectiveLevel !== nextEffectiveLevel && typeof simTrapDirty === 'function') simTrapDirty(obj.gx, obj.gy);
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

    obj.effectiveGroupSize = groupSize;
    obj.effectiveAreaMult = areaMult;
    // Shared rows already reflect these inputs. Only state/visual effects
    // need an event when the group's actual levels or upgrade state change.
    if (priorLevel === obj.effectiveLevel && priorPotential === nextPotentialLevel
        && priorUpgrade === obj.isUpgrading && priorGroup === groupSize && priorArea === areaMult) return;
    if (obj.updateStats) obj.updateStats();
    else {
        const energy=Number(obj.energy);
        obj.energy=Math.max(1,Math.min(obj.maxEnergy,Number.isFinite(energy)?energy:obj.maxEnergy));
        updateItemTextCache(obj);
        if (typeof visCoverOnBuildingChanged === 'function') visCoverOnBuildingChanged(obj);
    }
}
