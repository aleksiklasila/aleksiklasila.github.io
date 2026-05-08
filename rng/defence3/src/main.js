"use strict";

const MAX_CAMERA_ZOOM = 15;

// ============================================================
function _buildDeterministicUnitUpdateOrderForTick() {
    let order = units.slice();
    if (order.length <= 1) return order;
    let s = (((gameTime + 1) * 1664525) + ((order.length + 1) * 1013904223)) >>> 0;
    for (let i = order.length - 1; i > 0; i--) {
        s = ((s * 1664525) + 1013904223) >>> 0;
        let j = s % (i + 1);
        let tmp = order[i];
        order[i] = order[j];
        order[j] = tmp;
    }
    return order;
}

// ============================================================
// GAME TICK
// ============================================================
function gameTick() {
    if (gameOver) return;
    gameTime++;
    _resetPathfindPerfTick();
    _resetPathBudgetTrackingPerTick();

    let floorChanged = false;
    for (let y = 0; y < GRID_H; y++) {
        for (let x = 0; x < GRID_W; x++) {
            let cell = grid[y][x];
            let item = cell.item;
            if (!item) continue;
            if (tickStatusEffects(item)) {
                clearTileEntity(item.gx, item.gy, item);
                cell.item = null;
                cell.owner = -1;
                floorChanged = true;
            }
        }
    }
    if (floorChanged) {
        _minimapStaticDirty = true;
        _requestStaticCacheCommit();
        recalculateAdjacency();
    }

    recomputePlayerPopCaps();

    // Save previous positions for interpolation
    for (let u of units) { u.prevX = u.x; u.prevY = u.y; }
    for (let p of projectiles) { p.prevX = p.x; p.prevY = p.y; }

    // Resolve deferred pathfinding from previous ticks fairly.
    // A rotating cursor prevents early-array units from starving later units.
    if (units.length > 0) {
        let start = pendingPathResolveCursor % units.length;
        let checked = 0;
        let pendingBuckets = [[], [], [], [], []];
        while (checked < units.length) {
            let idx = (start + checked) % units.length;
            checked++;
            let u = units[idx];
            if (u.dead || !u._pendingPathTarget) continue;
            let src = u._pendingPathTarget && u._pendingPathTarget.src;
            let srcTier = Math.max(0, Math.min(4, _pendingPathPriority(src)));
            pendingBuckets[srcTier].push(u);
        }

        for (let srcTier = 0; srcTier <= 4; srcTier++) {
            let pending = pendingBuckets[srcTier];
            for (let i = 0; i < pending.length; i++) {
                let u = pending[i];
                let pt = u && u._pendingPathTarget;
                if (!u || u.dead || !pt) continue;
                if (u.pathIsFallbackAstar) {
                    _tryUpgradeAstarFallbackPath(u);
                    continue;
                }
                if (Number.isFinite(u._astarBudgetRetryTick) && gameTime < u._astarBudgetRetryTick) continue;
                if (!_canUsePathfindRequestBudget(u.owner)) {
                    _markUnitAstarBudgetBlocked(u);
                    continue;
                }

                let ugx = Math.floor(u.x / TILE), ugy = Math.floor(u.y / TILE);
                let dest = findNearestWalkable(pt.gx, pt.gy, ugx, ugy, u);
                let src = pt && pt.src ? pt.src : 'deferred_resolver';
                _consumePathfindRequestBudget(u.owner);
                u.path = _findPathForUnitTagged(src === 'player_commands' ? 'player_commands' : 'deferred_resolver', u, ugx, ugy, dest.x, dest.y, u.isFlying, getPathCanWalkForUnit(u), u.owner);
                if (u.path && u.path.length > 0) {
                    u.pathIndex = (u.path.length > 1 && u.path[0].x === ugx && u.path[0].y === ugy) ? 1 : 0;
                    u.commandState = pt.cmd;
                    u._pendingPathTarget = null;
                } else {
                    _markUnitAstarBudgetBlocked(u, 1);
                }
            }
        }
        pendingPathResolveCursor = (start + checked) % units.length;
    }

    recalculateUnitEffectiveStats();

    // Towers
    for (let t of towers) t.update();

    // Destroy dead towers
    for (let i = towers.length - 1; i >= 0; i--) {
        if (towers[i].energy <= 0) destroyBuilding(towers[i]);
    }

    // Projectiles
    for (let i = projectiles.length - 1; i >= 0; i--) { if (!projectiles[i].update()) projectiles.splice(i, 1); }

    // Units
    // Shuffle unit update order per tick so A* budget contention is shared
    // across different units over time (deterministically for lockstep).
    let unitUpdateOrder = _buildDeterministicUnitUpdateOrderForTick();
    for (let i = 0; i < unitUpdateOrder.length; i++) {
        let u = unitUpdateOrder[i];
        if (!u) continue;
        u.update();
    }

    for (let i = units.length - 1; i >= 0; i--) {
        let u = units[i];
        if (u.dead) {
            if (!u.isKing && !u.workerState) playSound('unit_death', u.x, u.y);
            // Drop energy on death (bounty)
            let cost = BASE_UNIT_STATS[u.unitType] ? BASE_UNIT_STATS[u.unitType].energy * 0.5 : 5;
            let bounty = Math.floor(cost * 0.1);
            if (bounty > 0) {
                let gx = Math.floor(u.x / TILE), gy = Math.floor(u.y / TILE);
                if (gx >= 0 && gx < GRID_W && gy >= 0 && gy < GRID_H && !getDroppedItemAt(gx, gy)) {
                    let drop = { type: 'energy', value: bounty, gx, gy, x: gx * TILE + 16, y: gy * TILE + 16, timer: TICK_RATE * 120 };
                    addDroppedItem(drop);
                }
            }
            // Release worker lock on target
            _clearWorkerTarget(u);
            if (u.workerTarget && u.workerTarget.lockedBy === u) {
                u.workerTarget.lockedBy = null;
            }
            if (u.isKing) checkWinCondition();
            removeUnitSpatial(u);
            players[u.owner].popCount--;
            selectedUnits = selectedUnits.filter(su => su !== u);
            units.splice(i, 1);
            if (gameOver) return;
        }
    }

    // Barracks
    for (let i = barracks.length - 1; i >= 0; i--) {
        let b = barracks[i];
        if (b.energy <= 0) { destroyBuilding(b); continue; }
        b.update();
    }

    // Collector/Salvager spawners (barrack-like)
    for (let i = collectorSpawners.length - 1; i >= 0; i--) {
        let cs = collectorSpawners[i];
        if (cs.energy <= 0) { destroyBuilding(cs); continue; }
        cs.update();
    }

    processGlobalSpawnerQueue();

    // Dropped items decay
    for (let i = droppedItems.length - 1; i >= 0; i--) {
        droppedItems[i].timer--;
        if (droppedItems[i].timer <= 0) {
            removeDroppedItem(droppedItems[i]);
        }
    }

    // Particles
    for (let i = particles.length - 1; i >= 0; i--) { if (!particles[i].update()) particles.splice(i, 1); }

    // Laser buzzer sound control
    let anyLaserActive = false;
    let laserSoundX = 0, laserSoundY = 0;
    let cameraCx = camera.x + viewW / camera.zoom / 2;
    let cameraCy = camera.y + viewH / camera.zoom / 2;
    let bestLaserDist2 = Infinity;
    for (let t of towers) {
        if (t.type !== 'laser' || t.laserState !== 1 || t.underConstruction) continue;
        anyLaserActive = true;
        let dx = t.x - cameraCx;
        let dy = t.y - cameraCy;
        let dist2 = dx * dx + dy * dy;
        if (dist2 < bestLaserDist2) {
            bestLaserDist2 = dist2;
            laserSoundX = t.x;
            laserSoundY = t.y;
        }
    }
    if (anyLaserActive) startLaserSound(laserSoundX, laserSoundY);
    else stopLaserSound();
    updateAudioReactiveState();

    if (_adjacencyNeedsRecalc && _adjacencyLastRecalcTick !== gameTime) {
        _runAdjacencyRecalculation();
    }

    updateVisibility(localPlayerId);
    _finalizePathfindPerfTick(_countPendingPathBacklog());
}

// ============================================================
// INPUT HANDLING
// ============================================================
function screenToWorld(sx, sy) {
    let gameArea = document.getElementById('game-area');
    let rect = gameArea.getBoundingClientRect();
    if (renderDimensionMode === '3d' && renderer3dInstance && typeof renderer3dInstance.screenToGround === 'function') {
        let picked = renderer3dInstance.screenToGround(sx, sy, rect);
        if (picked && Number.isFinite(picked.x) && Number.isFinite(picked.y)) {
            return {
                x: picked.x * TILE,
                y: picked.y * TILE,
            };
        }
    }
    let x = (sx - rect.left) / camera.zoom + camera.x;
    let y = (sy - rect.top) / camera.zoom + camera.y;
    return { x, y };
}

function initInput() {
    let gameArea = document.getElementById('game-area');
    let multiRallyPoints = [];
    let multiUnitCommandPoints = [];
    let multiTowerTargetPoints = [];
    let multiBuilderAssignTargets = [];
    let multiCollectorAssignTargets = [];
    let multiHealerAssignTargets = [];
    let multiResearcherAssignTargets = [];

    function isCtrlMultiCommand(evt) {
        if (!evt) return false;
        // Use only event modifier state here to avoid sticky-key issues when
        // browser context menus swallow keyup events (e.g. Firefox Shift+RMB).
        return !!(evt.shiftKey || evt.ctrlKey || evt.metaKey ||
            (evt.getModifierState && (
                evt.getModifierState('Shift') ||
                evt.getModifierState('Control') ||
                evt.getModifierState('Meta')
            )));
    }

    function applyRallyTargets(selSpawners, targetX, targetY, appendToMultiRally, targetUnitId = null) {
        if (!selSpawners || selSpawners.length === 0) return;
        if (appendToMultiRally && multiRallyPoints.length > 0) {
            multiRallyPoints.push({ x: targetX, y: targetY, targetUnitId });
        } else {
            multiRallyPoints = [{ x: targetX, y: targetY, targetUnitId }];
        }
        if (multiRallyPoints.length === 0) multiRallyPoints = [{ x: targetX, y: targetY, targetUnitId }];
        for (let i = 0; i < selSpawners.length; i++) {
            let b = selSpawners[i];
            let rp = multiRallyPoints[i % multiRallyPoints.length];
            queueAction({ action: 'setRally', gx: b.gx, gy: b.gy, targetX: rp.x, targetY: rp.y, targetUnitId: rp.targetUnitId || null });
            b.rallyX = rp.x; b.rallyY = rp.y; b.rallyTargetUnitId = rp.targetUnitId || null;
        }
    }

    function isRallyCapableEntity(ent) {
        if (!ent || ent.owner !== localPlayerId) return false;
        let byType = ['barrack', 'spawner', 'astar_spawner', 'salvager', 'builder_spawner', 'healer_spawner', 'research'].includes(ent.type);
        let byShape = Number.isFinite(ent.gx) && Number.isFinite(ent.gy) && ('rallyX' in ent) && ('rallyY' in ent);
        return !!(byType || byShape);
    }

    function findOwnRallyAnchorNear(worldX, worldY) {
        let candidates = [];
        for (let b of barracks) {
            if (b.owner !== localPlayerId || b.energy <= 0 || b.underConstruction) continue;
            if (!isTileVisible(b.gx, b.gy)) continue;
            candidates.push({ ref: b, x: b.x, y: b.y, hitShape: { kind: 'rect', hw: 14, hh: 14 }, hitRadius: 20, hitZ: 20 });
        }
        for (let s of collectorSpawners) {
            if (s.owner !== localPlayerId || s.energy <= 0 || s.underConstruction) continue;
            if (!isTileVisible(s.gx, s.gy)) continue;
            candidates.push({ ref: s, x: s.x, y: s.y, hitShape: { kind: 'rect', hw: 14, hh: 14 }, hitRadius: 20, hitZ: 20 });
        }
        let hit = pickNearestHitCandidate(candidates, worldX, worldY);
        return hit ? hit.ref : null;
    }

    function getUnitClickShape(u) {
        if (!u) return { kind: 'circle', r: 0 };
        let r = Math.max(0, Number(u.r) || 0);
        let vis = u.vis || 'circle';
        if (vis === 'rect') {
            return { kind: 'rect', hw: r, hh: r * 0.7 };
        }
        if (vis === 'mole') {
            return { kind: 'ellipse', rx: r * 0.8, ry: r * 1.1 };
        }
        return { kind: 'circle', r };
    }

    function isPointInsideCandidate(c, dx, dy) {
        if (!c || !c.hitShape) return false;
        let s = c.hitShape;
        if (s.kind === 'rect') {
            let hw = Math.max(0, Number(s.hw) || 0);
            let hh = Math.max(0, Number(s.hh) || 0);
            return Math.abs(dx) <= hw && Math.abs(dy) <= hh;
        }
        if (s.kind === 'ellipse') {
            let rx = Math.max(0.001, Number(s.rx) || 0.001);
            let ry = Math.max(0.001, Number(s.ry) || 0.001);
            let nx = dx / rx, ny = dy / ry;
            return (nx * nx + ny * ny) <= 1;
        }
        let r = Math.max(0, Number(s.r) || 0);
        return (dx * dx + dy * dy) <= (r * r);
    }

    function pickNearestHitCandidate(candidates, worldX, worldY) {
        let bestPointHit = null;
        let bestPointZ = -Infinity;
        let bestPointD2 = Infinity;

        let bestFallback = null;
        let bestFallbackD2 = Infinity;
        for (let c of candidates) {
            if (!c) continue;
            let cx = Number(c.x), cy = Number(c.y), hr = Number(c.hitRadius);
            if (!Number.isFinite(cx) || !Number.isFinite(cy)) continue;
            let dx = cx - worldX, dy = cy - worldY;
            let d2 = dx * dx + dy * dy;

            // Precise shape hit takes priority, with draw-order style tie-break.
            if (isPointInsideCandidate(c, dx, dy)) {
                let z = Number.isFinite(c.hitZ) ? c.hitZ : 0;
                if (z > bestPointZ || (z === bestPointZ && d2 < bestPointD2)) {
                    bestPointHit = c;
                    bestPointZ = z;
                    bestPointD2 = d2;
                }
            }

            // Fallback: nearest candidate still inside permissive click radius.
            if (Number.isFinite(hr) && hr > 0 && d2 <= hr * hr && d2 < bestFallbackD2) {
                bestFallback = c;
                bestFallbackD2 = d2;
            }
        }
        return bestPointHit || bestFallback;
    }

    function collectEnemyClickTargetCandidates(worldX, worldY, includeUnits = true) {
        let out = [];
        if (includeUnits) {
            for (let u of units) {
                if (u.owner === localPlayerId || u.dead) continue;
                let ugx = Math.floor(u.x / TILE), ugy = Math.floor(u.y / TILE);
                if (!isTileVisible(ugx, ugy)) continue;
                out.push({
                    kind: 'unit',
                    ref: u,
                    x: u.x,
                    y: u.y,
                    hitShape: getUnitClickShape(u),
                    hitRadius: (Number(u.r) || 0) + 10,
                    hitZ: 30,
                });
            }
        }
        for (let t of towers) {
            if (t.owner === localPlayerId || t.energy <= 0) continue;
            if (!isTileVisible(t.gx, t.gy)) continue;
            out.push({ kind: 'tower', ref: t, x: t.x, y: t.y, hitShape: { kind: 'rect', hw: 15, hh: 15 }, hitRadius: 20, hitZ: 20 });
        }
        for (let b of barracks) {
            if (b.owner === localPlayerId || b.energy <= 0) continue;
            if (!isTileVisible(b.gx, b.gy)) continue;
            out.push({ kind: 'barrack', ref: b, x: b.x, y: b.y, hitShape: { kind: 'rect', hw: 14, hh: 14 }, hitRadius: 20, hitZ: 20 });
        }
        for (let s of collectorSpawners) {
            if (s.owner === localPlayerId || s.energy <= 0) continue;
            if (!isTileVisible(s.gx, s.gy)) continue;
            out.push({ kind: 'spawner', ref: s, x: s.x, y: s.y, hitShape: { kind: 'rect', hw: 14, hh: 14 }, hitRadius: 20, hitZ: 20 });
        }
        let clickGx = Math.floor(worldX / TILE), clickGy = Math.floor(worldY / TILE);
        if (clickGx >= 0 && clickGx < GRID_W && clickGy >= 0 && clickGy < GRID_H && isTileVisible(clickGx, clickGy)) {
            let cell = grid[clickGy][clickGx];
            if (cell.item && cell.item.energy > 0 && cell.owner !== localPlayerId) {
                out.push({
                    kind: 'item',
                    ref: cell.item,
                    x: clickGx * TILE + TILE * 0.5,
                    y: clickGy * TILE + TILE * 0.5,
                    hitShape: { kind: 'rect', hw: 14, hh: 14 },
                    hitRadius: 20,
                    hitZ: 10,
                    gx: clickGx,
                    gy: clickGy,
                });
            }
        }
        return out;
    }

    function findNearestOwnedSelectableClickTarget(worldX, worldY) {
        let candidates = [];
        for (let u of units) {
            if (u.owner !== localPlayerId || u.dead) continue;
            let ugx = Math.floor(u.x / TILE), ugy = Math.floor(u.y / TILE);
            if (!isTileVisible(ugx, ugy)) continue;
            candidates.push({
                kind: 'unit',
                ref: u,
                x: u.x,
                y: u.y,
                hitShape: getUnitClickShape(u),
                hitRadius: (Number(u.r) || 0) + 8,
                hitZ: 30,
            });
        }
        for (let b of barracks) {
            if (b.owner !== localPlayerId || b.energy <= 0) continue;
            if (!isTileVisible(b.gx, b.gy)) continue;
            candidates.push({ kind: 'entity', ref: b, x: b.x, y: b.y, hitShape: { kind: 'rect', hw: 14, hh: 14 }, hitRadius: 20, hitZ: 20 });
        }
        for (let t of towers) {
            if (t.owner !== localPlayerId || t.energy <= 0) continue;
            if (!isTileVisible(t.gx, t.gy)) continue;
            candidates.push({ kind: 'entity', ref: t, x: t.x, y: t.y, hitShape: { kind: 'rect', hw: 15, hh: 15 }, hitRadius: 20, hitZ: 20 });
        }
        for (let s of collectorSpawners) {
            if (s.owner !== localPlayerId || s.energy <= 0) continue;
            if (!isTileVisible(s.gx, s.gy)) continue;
            candidates.push({ kind: 'entity', ref: s, x: s.x, y: s.y, hitShape: { kind: 'rect', hw: 14, hh: 14 }, hitRadius: 20, hitZ: 20 });
        }
        let gx = Math.floor(worldX / TILE), gy = Math.floor(worldY / TILE);
        if (gx >= 0 && gx < GRID_W && gy >= 0 && gy < GRID_H && isTileVisible(gx, gy)) {
            let cell = grid[gy][gx];
            if (cell.item && cell.owner === localPlayerId) {
                candidates.push({
                    kind: 'entity',
                    ref: cell.item,
                    x: gx * TILE + TILE * 0.5,
                    y: gy * TILE + TILE * 0.5,
                    hitShape: { kind: 'rect', hw: 14, hh: 14 },
                    hitRadius: 20,
                    hitZ: 10,
                    post: () => { cell.item._gx = gx; cell.item._gy = gy; cell.item._cell = cell; }
                });
            }
        }
        for (let m of goldMines) {
            if (!isTileVisible(m.gx, m.gy)) continue;
            candidates.push({
                kind: 'entity',
                ref: m,
                x: m.x,
                y: m.y,
                hitShape: { kind: 'circle', r: 12 },
                hitRadius: 20,
                hitZ: 5,
                post: () => { m._isGoldMine = true; }
            });
        }
        for (let m of astarMines) {
            if (!isTileVisible(m.gx, m.gy)) continue;
            candidates.push({
                kind: 'entity',
                ref: m,
                x: m.x,
                y: m.y,
                hitShape: { kind: 'circle', r: 12 },
                hitRadius: 20,
                hitZ: 5,
                post: () => { m._isAstarMine = true; }
            });
        }
        return pickNearestHitCandidate(candidates, worldX, worldY);
    }

    function isWorldPointInCurrentView(x, y, pad = 0) {
        if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
        let worldViewW = viewW / camera.zoom;
        let worldViewH = viewH / camera.zoom;
        return x >= camera.x - pad && x <= camera.x + worldViewW + pad &&
            y >= camera.y - pad && y <= camera.y + worldViewH + pad;
    }

    function getVisibleSameTypeUnits(sampleUnit) {
        if (!sampleUnit) return [];
        let typeKey = sampleUnit.unitType;
        let out = [];
        for (let u of units) {
            if (!u || u.dead || u.owner !== localPlayerId) continue;
            if (u.unitType !== typeKey) continue;
            let ugx = Math.floor(u.x / TILE), ugy = Math.floor(u.y / TILE);
            if (!isTileVisible(ugx, ugy)) continue;
            if (!isWorldPointInCurrentView(u.x, u.y, Math.max(4, Number(u.r) || 0))) continue;
            out.push(u);
        }
        return out;
    }

    function getVisibleSameTypeEntities(sampleEntity) {
        if (!sampleEntity) return [];
        let out = [];

        if (sampleEntity._isGoldMine) {
            for (let m of goldMines) {
                if (!m || !isTileVisible(m.gx, m.gy)) continue;
                if (!isWorldPointInCurrentView(m.x, m.y, 12)) continue;
                m._isGoldMine = true;
                out.push(m);
            }
            return out;
        }

        if (sampleEntity._isAstarMine) {
            for (let m of astarMines) {
                if (!m || !isTileVisible(m.gx, m.gy)) continue;
                if (!isWorldPointInCurrentView(m.x, m.y, 12)) continue;
                m._isAstarMine = true;
                out.push(m);
            }
            return out;
        }

        if (barracks.includes(sampleEntity)) {
            for (let b of barracks) {
                if (!b || b.energy <= 0) continue;
                if (b.unitType !== sampleEntity.unitType) continue;
                if (!isTileVisible(b.gx, b.gy)) continue;
                if (!isWorldPointInCurrentView(b.x, b.y, 14)) continue;
                out.push(b);
            }
            return out;
        }

        if (towers.includes(sampleEntity)) {
            for (let t of towers) {
                if (!t || t.energy <= 0) continue;
                if (t.type !== sampleEntity.type) continue;
                if (!isTileVisible(t.gx, t.gy)) continue;
                if (!isWorldPointInCurrentView(t.x, t.y, 15)) continue;
                out.push(t);
            }
            return out;
        }

        if (collectorSpawners.includes(sampleEntity)) {
            for (let s of collectorSpawners) {
                if (!s || s.energy <= 0) continue;
                if (s.type !== sampleEntity.type) continue;
                if (!isTileVisible(s.gx, s.gy)) continue;
                if (!isWorldPointInCurrentView(s.x, s.y, 14)) continue;
                out.push(s);
            }
            return out;
        }

        let sampleType = sampleEntity.type;
        for (let gy = 0; gy < GRID_H; gy++) {
            for (let gx = 0; gx < GRID_W; gx++) {
                if (!isTileVisible(gx, gy)) continue;
                let cell = grid[gy][gx];
                if (!cell || !cell.item || cell.item.energy <= 0) continue;
                if (cell.item.type !== sampleType) continue;
                if (!isWorldPointInCurrentView(gx * TILE + TILE * 0.5, gy * TILE + TILE * 0.5, 14)) continue;
                cell.item._gx = gx; cell.item._gy = gy; cell.item._cell = cell;
                out.push(cell.item);
            }
        }
        return out;
    }

    function toggleVisibleSameTypeSelectionFromHit(hit) {
        if (!hit || !hit.ref) return;

        if (hit.kind === 'unit') {
            let group = getVisibleSameTypeUnits(hit.ref);
            if (group.length <= 0) return;
            let isSelected = selectedUnits.includes(hit.ref);
            if (isSelected) {
                let groupSet = new Set(group);
                selectedUnits = selectedUnits.filter(u => !groupSet.has(u));
            } else {
                for (let u of group) {
                    if (!selectedUnits.includes(u)) selectedUnits.push(u);
                }
            }
            return;
        }

        if (hit.kind === 'entity') {
            let group = getVisibleSameTypeEntities(hit.ref);
            if (group.length <= 0) return;
            let isSelected = selectedEntities.includes(hit.ref);
            if (isSelected) {
                let groupSet = new Set(group);
                selectedEntities = selectedEntities.filter(ent => !groupSet.has(ent));
            } else {
                for (let ent of group) {
                    if (!selectedEntities.includes(ent)) selectedEntities.push(ent);
                }
            }
        }
    }

    function findEnemyUnitNear(worldX, worldY) {
        let cands = collectEnemyClickTargetCandidates(worldX, worldY, true)
            .filter(c => c.kind === 'unit');
        let best = pickNearestHitCandidate(cands, worldX, worldY);
        return best ? best.ref : null;
    }

    function applyUnitCommandTargets(unitIds, targetX, targetY, appendToMultiPoints, actionName = 'move') {
        if (!unitIds || unitIds.length === 0) return;
        if (appendToMultiPoints && multiUnitCommandPoints.length > 0) {
            multiUnitCommandPoints.push({ x: targetX, y: targetY });
        } else {
            multiUnitCommandPoints = [{ x: targetX, y: targetY }];
        }
        if (multiUnitCommandPoints.length === 0) multiUnitCommandPoints = [{ x: targetX, y: targetY }];

        let buckets = Array.from({ length: multiUnitCommandPoints.length }, () => []);
        for (let i = 0; i < unitIds.length; i++) buckets[i % multiUnitCommandPoints.length].push(unitIds[i]);

        for (let i = 0; i < buckets.length; i++) {
            if (buckets[i].length === 0) continue;
            let rp = multiUnitCommandPoints[i];
            queueAction({ action: actionName, unitIds: buckets[i], targetX: rp.x, targetY: rp.y });
        }
    }

    function applyTowerTargetAssignments(selTowers, targetSpec, appendToMultiTargets) {
        if (!selTowers || selTowers.length === 0 || !targetSpec) return;
        if (appendToMultiTargets && multiTowerTargetPoints.length > 0) {
            multiTowerTargetPoints.push({ ...targetSpec });
        } else {
            multiTowerTargetPoints = [{ ...targetSpec }];
        }
        if (multiTowerTargetPoints.length === 0) multiTowerTargetPoints = [{ ...targetSpec }];

        let buckets = Array.from({ length: multiTowerTargetPoints.length }, () => []);
        for (let i = 0; i < selTowers.length; i++) buckets[i % multiTowerTargetPoints.length].push(selTowers[i]);

        for (let i = 0; i < buckets.length; i++) {
            if (buckets[i].length === 0) continue;
            let target = multiTowerTargetPoints[i];
            let towerCoords = buckets[i].map(t => ({ gx: t.gx, gy: t.gy }));
            queueAction({ action: 'towerTarget', towerCoords, target });
        }
    }

    function applyWorkerAssignTargets(workerUnits, targetType, targetGx, targetGy, appendToMultiTargets) {
        if (!workerUnits || workerUnits.length === 0) return;
        let multiTargets = targetType === 'build'
            ? multiBuilderAssignTargets
            : (targetType === 'mine' || targetType === 'farm' || targetType === 'astar_mine' || targetType === 'astar_farm')
                ? multiCollectorAssignTargets
                : (targetType === 'research')
                    ? multiResearcherAssignTargets
                    : multiHealerAssignTargets;
        if (appendToMultiTargets && multiTargets.length > 0) {
            multiTargets.push({ targetGx, targetGy });
        } else {
            multiTargets.length = 0;
            multiTargets.push({ targetGx, targetGy });
        }
        if (multiTargets.length === 0) multiTargets.push({ targetGx, targetGy });

        let unitIds = workerUnits.map(u => u.id);
        let buckets = Array.from({ length: multiTargets.length }, () => []);
        for (let i = 0; i < unitIds.length; i++) {
            buckets[i % multiTargets.length].push(unitIds[i]);
        }

        for (let i = 0; i < buckets.length; i++) {
            if (buckets[i].length === 0) continue;
            let target = multiTargets[i];
            queueAction({
                action: 'workerAssign',
                unitIds: buckets[i],
                targetType,
                targetGx: target.targetGx,
                targetGy: target.targetGy
            });
        }
    }

    function screenToWorldClamped(sx, sy) {
        let rect = gameArea.getBoundingClientRect();
        let clampedX = Math.max(rect.left, Math.min(rect.right - 1, sx));
        let clampedY = Math.max(rect.top, Math.min(rect.bottom - 1, sy));
        return screenToWorld(clampedX, clampedY);
    }

    function stopBuildPlacementDrag() {
        buildPlacementDragActive = false;
        buildPlacementDragVisitedTiles = null;
    }

    function canPlaceSelectedBuildItemAt(gx, gy, purchaseCount) {
        if (!selectedBuildItem) return false;
        if (gx < 0 || gy < 0 || gx >= GRID_W || gy >= GRID_H) return false;
        let _cd = BASE_CARD_TYPES[selectedBuildItem];
        if (selectedBuildItem === 'area_upgrader') {
            let aId = grid[gy][gx].areaId;
            let area = getAreaById(aId);
            if (!area) return false;
            let filledCount = 0;
            for (let cp of area.cells) {
                let c = grid[cp.y][cp.x];
                if (c.type === TYPE_WALL && getTowerAtTile(cp.x, cp.y)) filledCount++;
                else if (c.item) filledCount++;
                else if (getBarrackAtTile(cp.x, cp.y)) filledCount++;
                else if (getSpawnerAtTile(cp.x, cp.y)) filledCount++;
            }
            return filledCount === area.cells.length && (area.multiplierLevel || 0) < 5;
        }
        return _cd &&
            (canStackAt(gx, gy, selectedBuildItem, localPlayerId) || canBuildAt(gx, gy, localPlayerId));
    }

    function tryPlaceSelectedBuildAt(gx, gy, playCantPlaceSound = true) {
        if (!selectedBuildItem) return false;
        if (gx < 0 || gy < 0 || gx >= GRID_W || gy >= GRID_H || !isTileVisible(gx, gy)) {
            if (playCantPlaceSound) playSound('cant_place');
            return false;
        }
        let purchaseCount = Math.max(1, Math.floor(buildPurchaseMultiplier || 1));
        let canPlace = canPlaceSelectedBuildItemAt(gx, gy, purchaseCount);
        if (!canPlace) {
            if (playCantPlaceSound) playSound('cant_place');
            return false;
        }
        queueAction({ action: 'place', gx, gy, itemType: selectedBuildItem, autoUpgradeEnabled: defaultAutoUpgradeEnabled, buildEnabled: defaultAutoBuildEnabled, count: purchaseCount });
        requestBuildMenuRefresh();
        return true;
    }

    function tryBuildPlacementDragAtClient(clientX, clientY) {
        if (!buildPlacementDragActive || !selectedBuildItem || !buildPlacementDragVisitedTiles) return;
        let world = screenToWorldClamped(clientX, clientY);
        let gx = Math.floor(world.x / TILE), gy = Math.floor(world.y / TILE);
        if (gx < 0 || gy < 0 || gx >= GRID_W || gy >= GRID_H) return;
        let tileKey = `${gx},${gy}`;
        if (buildPlacementDragVisitedTiles.has(tileKey)) return;
        buildPlacementDragVisitedTiles.add(tileKey);
        tryPlaceSelectedBuildAt(gx, gy, false);
    }

    gameArea.addEventListener('mousedown', (e) => {
        if (!gameStarted || gameOver) return;
        if (renderDimensionMode === '3d' && e.button === 1) {
            renderer3dRotateDrag = { clientX: e.clientX, clientY: e.clientY };
            e.preventDefault();
            return;
        }
        let rect = gameArea.getBoundingClientRect();
        let world = screenToWorld(e.clientX, e.clientY);

        if (e.button === 0) { // Left click
            if (selectedBuildItem) {
                if (localDefeated) {
                    selectedBuildItem = null;
                    requestBuildMenuRefresh();
                    stopBuildPlacementDrag();
                    return;
                }
                let gx = Math.floor(world.x / TILE), gy = Math.floor(world.y / TILE);
                let shiftHeld = !!e.shiftKey;
                let dragPlace = shouldShiftDragBuildPlace(shiftHeld);
                let keepSelected = shouldKeepBuildSelectionAfterLeftClick(shiftHeld);

                if (dragPlace) {
                    buildPlacementDragActive = true;
                    buildPlacementDragVisitedTiles = new Set();
                    buildPlacementDragVisitedTiles.add(`${gx},${gy}`);
                    tryPlaceSelectedBuildAt(gx, gy, true);
                } else {
                    stopBuildPlacementDrag();
                    tryPlaceSelectedBuildAt(gx, gy, true);
                }

                if (!keepSelected) {
                    selectedBuildItem = null;
                    requestBuildMenuRefresh();
                    stopBuildPlacementDrag();
                }
                return;
            }
            // Start box selection
            isBoxSelecting = true;
            selectionBox = { sx: world.x, sy: world.y, ex: world.x, ey: world.y };
            selectionBoxScreen = {
                sx: e.clientX - rect.left,
                sy: e.clientY - rect.top,
                ex: e.clientX - rect.left,
                ey: e.clientY - rect.top,
            };
        } else if (e.button === 2) { // Right click
            e.preventDefault();
            if (localDefeated) return;
            if (selectedBuildItem) { selectedBuildItem = null; requestBuildMenuRefresh(); stopBuildPlacementDrag(); return; }
            let isCtrlMulti = isCtrlMultiCommand(e);
            let clickedEnemyUnit = findEnemyUnitNear(world.x, world.y);
            let issuedStructureCommand = false;
            // Set rally for active selected barracks and spawners
            let selSpawners = getActiveEntities().filter(isRallyCapableEntity);
            if (selSpawners.length > 0) {
                let gatherTarget = clickedEnemyUnit
                    ? null
                    : (_getCollectorGatherTargetNear(world.x, world.y, localPlayerId, 22)
                        || _getAstarCollectorGatherTargetNear(world.x, world.y, localPlayerId, 22));
                let rallyAnchor = clickedEnemyUnit ? null : findOwnRallyAnchorNear(world.x, world.y);
                let rallyX = clickedEnemyUnit
                    ? clickedEnemyUnit.x
                    : (gatherTarget ? gatherTarget.target.x : (rallyAnchor ? rallyAnchor.x : world.x));
                let rallyY = clickedEnemyUnit
                    ? clickedEnemyUnit.y
                    : (gatherTarget ? gatherTarget.target.y : (rallyAnchor ? rallyAnchor.y : world.y));
                applyRallyTargets(selSpawners, rallyX, rallyY, isCtrlMulti, clickedEnemyUnit ? clickedEnemyUnit.id : null);
                issuedStructureCommand = true;
            } else if (!isCtrlMulti) {
                multiRallyPoints = [];
            }
            // Set preferred target for selected own towers
            let selTowers = getActiveEntities().filter(e => e instanceof Tower && e.owner === localPlayerId && e.energy > 0);
            if (selTowers.length > 0) {
                // Pick nearest clicked enemy target (unit/building/item) by center distance.
                let towerTarget = null;
                let targetHit = pickNearestHitCandidate(collectEnemyClickTargetCandidates(world.x, world.y, true), world.x, world.y);
                if (targetHit) {
                    if (targetHit.kind === 'unit') towerTarget = { type: 'unit', id: targetHit.ref.id };
                    else if (targetHit.kind === 'tower') towerTarget = { type: 'tower', gx: targetHit.ref.gx, gy: targetHit.ref.gy };
                    else if (targetHit.kind === 'barrack') towerTarget = { type: 'barrack', gx: targetHit.ref.gx, gy: targetHit.ref.gy };
                    else if (targetHit.kind === 'spawner') towerTarget = { type: 'spawner', gx: targetHit.ref.gx, gy: targetHit.ref.gy };
                    else if (targetHit.kind === 'item') towerTarget = { type: 'item', gx: targetHit.gx, gy: targetHit.gy };
                }
                if (towerTarget) {
                    applyTowerTargetAssignments(selTowers, towerTarget, isCtrlMulti);
                    issuedStructureCommand = true;
                } else {
                    // Right-click on ground: clear preferred target for selected towers
                    let towerCoords = selTowers.map(t => ({ gx: t.gx, gy: t.gy }));
                    queueAction({ action: 'towerTarget', towerCoords, target: null });
                    if (!isCtrlMulti) multiTowerTargetPoints = [];
                    issuedStructureCommand = true;
                }
            }
            let activeUnits = getActiveUnits();
            if (issuedStructureCommand && activeUnits.length === 0) {
                updateInfoPanel();
                return;
            }
            // Right-click own barrack to queue unit (only if no workers or combat units selected)
            if (selSpawners.length === 0 && activeUnits.length === 0) {
                let ownBarrackHits = [];
                for (let b of barracks) {
                    if (b.owner !== localPlayerId || b.energy <= 0 || b.underConstruction) continue;
                    if (!isTileVisible(b.gx, b.gy)) continue;
                    ownBarrackHits.push({ ref: b, x: b.x, y: b.y, hitShape: { kind: 'rect', hw: 14, hh: 14 }, hitRadius: 20, hitZ: 20 });
                }
                let clickedBarrack = pickNearestHitCandidate(ownBarrackHits, world.x, world.y);
                if (clickedBarrack) {
                    queueAction({ action: 'queueUnit', gx: clickedBarrack.ref.gx, gy: clickedBarrack.ref.gy, count: queuePurchaseMultiplier });
                    return;
                }
            }
            if (activeUnits.length > 0) {
                // --- Worker targeting logic ---
                let builderUnits = activeUnits.filter(u => u.workerType === 'builder');
                let collectorUnits = activeUnits.filter(u => u.workerType === 'collector');
                let astarCollectorUnits = activeUnits.filter(u => u.workerType === 'astar_collector');
                let salvagerUnits = activeUnits.filter(u => u.workerType === 'salvager');
                let healerUnits = activeUnits.filter(u => u.workerType === 'healer');
                let researcherUnits = activeUnits.filter(u => u.workerType === 'researcher');
                let workerIds = [...builderUnits, ...collectorUnits, ...astarCollectorUnits, ...salvagerUnits, ...healerUnits, ...researcherUnits].map(u => u.id);

                if (builderUnits.length > 0) {
                    // Generic builder-targeting for any placeable object that can be built/upgraded.
                    let buildTarget = _getBuilderWorkTargetNear(world.x, world.y, localPlayerId, 22, true);
                    if (buildTarget) {
                        applyWorkerAssignTargets(builderUnits, 'build', buildTarget.gx, buildTarget.gy, isCtrlMulti);
                        updateInfoPanel();
                        // If no non-worker units, return
                        let nonWorkers = activeUnits.filter(u => !u.workerType);
                        if (nonWorkers.length === 0) return;
                    }
                } else if (!isCtrlMulti) {
                    multiBuilderAssignTargets = [];
                }

                if (collectorUnits.length > 0) {
                    let gatherTarget = _getCollectorGatherTargetNear(world.x, world.y, localPlayerId, 22);
                    if (gatherTarget) {
                        applyWorkerAssignTargets(collectorUnits, gatherTarget.type, gatherTarget.target.gx, gatherTarget.target.gy, isCtrlMulti);
                        updateInfoPanel();
                        let nonWorkers = activeUnits.filter(u => !u.workerType);
                        if (nonWorkers.length === 0) return;
                    }
                } else if (!isCtrlMulti) {
                    multiCollectorAssignTargets = [];
                }

                if (astarCollectorUnits.length > 0) {
                    let gatherTarget = _getAstarCollectorGatherTargetNear(world.x, world.y, localPlayerId, 22);
                    if (gatherTarget) {
                        applyWorkerAssignTargets(astarCollectorUnits, gatherTarget.type, gatherTarget.target.gx, gatherTarget.target.gy, isCtrlMulti);
                        updateInfoPanel();
                        let nonWorkers = activeUnits.filter(u => !u.workerType);
                        if (nonWorkers.length === 0) return;
                    }
                } else if (!isCtrlMulti) {
                    multiCollectorAssignTargets = [];
                }

                if (healerUnits.length > 0) {
                    let queueTarget = _getHealerQueueTargetNear(world.x, world.y, localPlayerId, 22, false);
                    if (queueTarget) {
                        applyWorkerAssignTargets(healerUnits, 'queue', queueTarget.gx, queueTarget.gy, isCtrlMulti);
                        updateInfoPanel();
                        let nonWorkers = activeUnits.filter(u => !u.workerType);
                        if (nonWorkers.length === 0) return;
                    }
                } else if (!isCtrlMulti) {
                    multiHealerAssignTargets = [];
                }

                if (researcherUnits.length > 0) {
                    let researchTarget = null;
                    let researchBestDist = Infinity;
                    for (let s of collectorSpawners) {
                        if (!_isResearcherTargetBuilding(s, localPlayerId)) continue;
                        if (!isTileVisible(s.gx, s.gy)) continue;
                        let d = Math.hypot(s.x - world.x, s.y - world.y);
                        if (d > 22 || d >= researchBestDist) continue;
                        researchBestDist = d;
                        researchTarget = s;
                    }
                    if (researchTarget) {
                        applyWorkerAssignTargets(researcherUnits, 'research', researchTarget.gx, researchTarget.gy, isCtrlMulti);
                        updateInfoPanel();
                        let nonWorkers = activeUnits.filter(u => !u.workerType);
                        if (nonWorkers.length === 0) return;
                    }
                } else if (!isCtrlMulti) {
                    multiResearcherAssignTargets = [];
                }

                // --- Normal combat unit targeting ---
                let combatUnits = activeUnits.filter(u => !u.workerType);
                if (combatUnits.length > 0) {
                    let targetUnit = null, targetBuilding = null;
                    let targetBuildingGx = null, targetBuildingGy = null;
                    let combatHit = pickNearestHitCandidate(collectEnemyClickTargetCandidates(world.x, world.y, true), world.x, world.y);
                    if (combatHit) {
                        if (combatHit.kind === 'unit') targetUnit = combatHit.ref;
                        else {
                            targetBuilding = combatHit.ref;
                            if (combatHit.kind === 'item') {
                                targetBuildingGx = combatHit.gx;
                                targetBuildingGy = combatHit.gy;
                            } else {
                                targetBuildingGx = combatHit.ref.gx;
                                targetBuildingGy = combatHit.ref.gy;
                            }
                        }
                    }
                    let unitIds = combatUnits.map(u => u.id);
                    if (targetUnit) {
                        if (isCtrlMulti) {
                            // Allow enemy clicks to be part of multi-point command chains.
                            applyUnitCommandTargets(unitIds, targetUnit.x, targetUnit.y, true, 'attackMove');
                        } else {
                            queueAction({ action: 'attack', unitIds, targetId: targetUnit.id, targetX: targetUnit.x, targetY: targetUnit.y });
                            multiUnitCommandPoints = [];
                        }
                        if (workerIds.length > 0) {
                            // Keep mixed selections moving; workers cannot attack unit targets directly.
                            queueAction({ action: 'move', unitIds: workerIds, targetX: targetUnit.x, targetY: targetUnit.y });
                        }
                    } else if (targetBuilding) {
                        let targetBuildingX = Number.isFinite(targetBuilding.x) ? targetBuilding.x : (targetBuildingGx * TILE + TILE * 0.5);
                        let targetBuildingY = Number.isFinite(targetBuilding.y) ? targetBuilding.y : (targetBuildingGy * TILE + TILE * 0.5);
                        if (isCtrlMulti) {
                            // Allow enemy clicks to be part of multi-point command chains.
                            applyUnitCommandTargets(unitIds, targetBuildingX, targetBuildingY, true, 'attackMove');
                        } else {
                            queueAction({ action: 'attackBuilding', unitIds, targetGx: targetBuildingGx, targetGy: targetBuildingGy });
                            multiUnitCommandPoints = [];
                        }
                        if (workerIds.length > 0) {
                            // Keep mixed selections moving; workers cannot attack building targets directly.
                            queueAction({ action: 'move', unitIds: workerIds, targetX: targetBuildingX, targetY: targetBuildingY });
                        }
                    } else if (attackMoveMode) {
                        applyUnitCommandTargets(unitIds, world.x, world.y, isCtrlMulti, 'attackMove');
                        attackMoveMode = false;
                    } else {
                        // Workers also move to the position if no special target found
                        let allIds = activeUnits.map(u => u.id);
                        applyUnitCommandTargets(allIds, world.x, world.y, isCtrlMulti, 'move');
                    }
                } else if (workerIds.length > 0) {
                    // Only workers selected and no special target - move them
                    applyUnitCommandTargets(workerIds, world.x, world.y, isCtrlMulti, 'move');
                }
            } else if (!isCtrlMulti) {
                multiUnitCommandPoints = [];
            }
            updateInfoPanel();
        }
    });

    gameArea.addEventListener('mousemove', (e) => {
        if (renderer3dRotateDrag && renderDimensionMode === '3d' && renderer3dInstance && typeof renderer3dInstance.adjustOrbit === 'function') {
            let dx = e.clientX - renderer3dRotateDrag.clientX;
            let dy = e.clientY - renderer3dRotateDrag.clientY;
            renderer3dRotateDrag.clientX = e.clientX;
            renderer3dRotateDrag.clientY = e.clientY;
            renderer3dInstance.adjustOrbit(-dx * 0.008, dy * 0.006);
        }
        let rect = gameArea.getBoundingClientRect();
        let world = screenToWorldClamped(e.clientX, e.clientY);
        mouseWorldX = world.x; mouseWorldY = world.y;
        mouseScreenX = e.clientX; mouseScreenY = e.clientY;
        tryBuildPlacementDragAtClient(e.clientX, e.clientY);
        if (isBoxSelecting && selectionBox) {
            selectionBox.ex = world.x; selectionBox.ey = world.y;
            if (selectionBoxScreen) {
                selectionBoxScreen.ex = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
                selectionBoxScreen.ey = Math.max(0, Math.min(rect.height, e.clientY - rect.top));
            }
        }
    });

    window.addEventListener('mousemove', (e) => {
        if (renderer3dRotateDrag && renderDimensionMode === '3d' && renderer3dInstance && typeof renderer3dInstance.adjustOrbit === 'function') {
            let dx = e.clientX - renderer3dRotateDrag.clientX;
            let dy = e.clientY - renderer3dRotateDrag.clientY;
            renderer3dRotateDrag.clientX = e.clientX;
            renderer3dRotateDrag.clientY = e.clientY;
            renderer3dInstance.adjustOrbit(-dx * 0.008, dy * 0.006);
        }
        tryBuildPlacementDragAtClient(e.clientX, e.clientY);
        if (!isBoxSelecting || !selectionBox) return;
        let rect = gameArea.getBoundingClientRect();
        let world = screenToWorldClamped(e.clientX, e.clientY);
        mouseWorldX = world.x; mouseWorldY = world.y;
        selectionBox.ex = world.x; selectionBox.ey = world.y;
        if (selectionBoxScreen) {
            selectionBoxScreen.ex = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
            selectionBoxScreen.ey = Math.max(0, Math.min(rect.height, e.clientY - rect.top));
        }
    });

    gameArea.addEventListener('mouseup', (e) => {
        if (e.button === 1) renderer3dRotateDrag = null;
        if (e.button === 0) stopBuildPlacementDrag();
        if (e.button === 0 && isBoxSelecting) {
            isBoxSelecting = false;
            if (selectionBox) {
                let sx = Math.min(selectionBox.sx, selectionBox.ex);
                let sy = Math.min(selectionBox.sy, selectionBox.ey);
                let ex = Math.max(selectionBox.sx, selectionBox.ex);
                let ey = Math.max(selectionBox.sy, selectionBox.ey);
                let w = ex - sx, h = ey - sy;
                let screenW = selectionBoxScreen ? Math.abs(selectionBoxScreen.ex - selectionBoxScreen.sx) : w;
                let screenH = selectionBoxScreen ? Math.abs(selectionBoxScreen.ey - selectionBoxScreen.sy) : h;

                if (screenW < 5 && screenH < 5) {
                    // Click select: choose nearest hit among units/buildings/items/mines.
                    let clickHit = findNearestOwnedSelectableClickTarget(selectionBox.sx, selectionBox.sy);
                    if (clickHit && clickHit.post) clickHit.post();
                    let isCtrlLeftClick = !!(e.ctrlKey || e.metaKey || (e.getModifierState && (e.getModifierState('Control') || e.getModifierState('Meta'))));
                    if (isCtrlLeftClick && clickHit) {
                        toggleVisibleSameTypeSelectionFromHit(clickHit);
                    } else if (clickHit && clickHit.kind === 'unit') {
                        let clicked = clickHit.ref;
                        if (e.shiftKey) {
                            let idx = selectedUnits.indexOf(clicked);
                            if (idx >= 0) selectedUnits.splice(idx, 1);
                            else selectedUnits.push(clicked);
                        } else { selectedUnits = [clicked]; selectedEntities = []; }
                    } else if (clickHit && clickHit.kind === 'entity') {
                        let clickedEntity = clickHit.ref;
                        if (e.shiftKey) {
                            let idx = selectedEntities.indexOf(clickedEntity);
                            if (idx >= 0) selectedEntities.splice(idx, 1);
                            else selectedEntities.push(clickedEntity);
                        } else { selectedEntities = [clickedEntity]; selectedUnits = []; }
                    } else {
                        if (!e.shiftKey) { selectedUnits = []; selectedEntities = []; }
                    }
                } else {
                    // Box select - pick up units AND buildings
                    let newUnits = [];
                    let newEntities = [];
                    if (renderDimensionMode === '3d' && selectionBoxScreen) {
                        let projectedSelection = get3DBoxSelection(selectionBoxScreen);
                        newUnits = projectedSelection.units;
                        newEntities = projectedSelection.entities;
                    } else {
                        for (let u of units) {
                            if (u.owner !== localPlayerId || u.dead) continue;
                            let ugx = Math.floor(u.x / TILE), ugy = Math.floor(u.y / TILE);
                            if (!isTileVisible(ugx, ugy)) continue;
                            if (u.x >= sx && u.x <= ex && u.y >= sy && u.y <= ey) newUnits.push(u);
                        }
                        for (let b of barracks) {
                            if (b.energy > 0 && b.owner === localPlayerId && isTileVisible(b.gx, b.gy) && b.x >= sx && b.x <= ex && b.y >= sy && b.y <= ey) newEntities.push(b);
                        }
                        for (let t of towers) {
                            if (t.energy > 0 && t.owner === localPlayerId && isTileVisible(t.gx, t.gy) && t.x >= sx && t.x <= ex && t.y >= sy && t.y <= ey) newEntities.push(t);
                        }
                        for (let s of collectorSpawners) {
                            if (s.energy > 0 && s.owner === localPlayerId && isTileVisible(s.gx, s.gy) && s.x >= sx && s.x <= ex && s.y >= sy && s.y <= ey) newEntities.push(s);
                        }
                        let minGx = Math.max(0, Math.floor(sx / TILE)), maxGx = Math.min(GRID_W - 1, Math.floor(ex / TILE));
                        let minGy = Math.max(0, Math.floor(sy / TILE)), maxGy = Math.min(GRID_H - 1, Math.floor(ey / TILE));
                        for (let gy = minGy; gy <= maxGy; gy++) {
                            for (let gx = minGx; gx <= maxGx; gx++) {
                                if (!isTileVisible(gx, gy)) continue;
                                let cell = grid[gy][gx];
                                if (cell.item && cell.owner === localPlayerId && !newEntities.includes(cell.item)) {
                                    cell.item._gx = gx; cell.item._gy = gy; cell.item._cell = cell;
                                    newEntities.push(cell.item);
                                }
                            }
                        }
                        for (let m of goldMines) {
                            if (!isTileVisible(m.gx, m.gy)) continue;
                            if (m.x >= sx && m.x <= ex && m.y >= sy && m.y <= ey) { m._isGoldMine = true; newEntities.push(m); }
                        }
                        for (let m of astarMines) {
                            if (!isTileVisible(m.gx, m.gy)) continue;
                            if (m.x >= sx && m.x <= ex && m.y >= sy && m.y <= ey) { m._isAstarMine = true; newEntities.push(m); }
                        }
                    }
                    if (e.shiftKey) {
                        for (let u of newUnits) { if (!selectedUnits.includes(u)) selectedUnits.push(u); }
                        for (let ent of newEntities) { if (!selectedEntities.includes(ent)) selectedEntities.push(ent); }
                    } else {
                        selectedUnits = newUnits;
                        selectedEntities = newEntities;
                    }
                }
                activeSubGroups = {};
                selectionBox = null;
                selectionBoxScreen = null;
            }
            updateInfoPanel();
        }
    });

    window.addEventListener('mouseup', (e) => {
        if (e.button === 1) renderer3dRotateDrag = null;
        if (e.button === 0) stopBuildPlacementDrag();
        if (e.button !== 0 || !isBoxSelecting) return;
        let syntheticUp = new MouseEvent('mouseup', { button: 0, clientX: e.clientX, clientY: e.clientY, shiftKey: e.shiftKey });
        gameArea.dispatchEvent(syntheticUp);
    });

    gameArea.addEventListener('contextmenu', e => e.preventDefault());
    gameArea.addEventListener('auxclick', (e) => {
        if (e.button === 1) e.preventDefault();
    });

    gameArea.addEventListener('wheel', (e) => {
        // Zoom centered on mouse cursor position
        let worldBeforeX = mouseWorldX;
        let worldBeforeY = mouseWorldY;
        let rect = gameArea.getBoundingClientRect();
        let screenX = e.clientX - rect.left;
        let screenY = e.clientY - rect.top;
        let worldBefore3D = null;
        if (renderDimensionMode === '3d' && renderer3dInstance && typeof renderer3dInstance.buildViewProjection === 'function' && typeof renderer3dInstance.screenToGround === 'function') {
            renderer3dInstance.buildViewProjection(get3DProjectionSnapshot());
            let pickedBefore = renderer3dInstance.screenToGround(e.clientX, e.clientY, rect);
            if (pickedBefore && Number.isFinite(pickedBefore.x) && Number.isFinite(pickedBefore.y)) {
                worldBefore3D = { x: pickedBefore.x * TILE, y: pickedBefore.y * TILE };
            }
        }
        let minZoom = Math.max(viewW / WORLD_W, viewH / WORLD_H, 0.4);
        if (e.deltaY < 0) camera.zoom = Math.min(MAX_CAMERA_ZOOM, camera.zoom * 1.2);
        else camera.zoom = Math.max(minZoom, camera.zoom / 1.2);
        if (renderDimensionMode !== '3d') {
            // Keep 2D zoom centered on the cursor.
            camera.x = worldBeforeX - screenX / camera.zoom;
            camera.y = worldBeforeY - screenY / camera.zoom;
        } else if (worldBefore3D && renderer3dInstance && typeof renderer3dInstance.buildViewProjection === 'function' && typeof renderer3dInstance.screenToGround === 'function') {
            renderer3dInstance.buildViewProjection(get3DProjectionSnapshot());
            let pickedAfter = renderer3dInstance.screenToGround(e.clientX, e.clientY, rect);
            if (pickedAfter && Number.isFinite(pickedAfter.x) && Number.isFinite(pickedAfter.y)) {
                camera.x += worldBefore3D.x - pickedAfter.x * TILE;
                camera.y += worldBefore3D.y - pickedAfter.y * TILE;
            }
        }
        clampCamera();
    });

    minimapCanvas.addEventListener('contextmenu', (e) => e.preventDefault());

    // Minimap click / command
    minimapCanvas.addEventListener('mousedown', (e) => {
        let rect = minimapCanvas.getBoundingClientRect();
        let mx = (e.clientX - rect.left) * (MINIMAP_SIZE / rect.width);
        let my = (e.clientY - rect.top) * (MINIMAP_SIZE / rect.height);
        let scale = MINIMAP_SIZE / GRID_W;
        let gx = Math.max(0, Math.min(GRID_W - 1, Math.floor(mx / scale)));
        let gy = Math.max(0, Math.min(GRID_H - 1, Math.floor(my / scale)));
        let worldX = gx * TILE + TILE / 2;
        let worldY = gy * TILE + TILE / 2;

        if (e.button === 2) {
            e.preventDefault();
            if (!gameStarted || gameOver) return;
            if (localDefeated) return;
            if (selectedBuildItem) { selectedBuildItem = null; requestBuildMenuRefresh(); stopBuildPlacementDrag(); return; }

            let isCtrlMulti = isCtrlMultiCommand(e);
            let selSpawners = getActiveEntities().filter(isRallyCapableEntity);
            if (selSpawners.length > 0) {
                applyRallyTargets(selSpawners, worldX, worldY, isCtrlMulti);
            } else if (!isCtrlMulti) {
                multiRallyPoints = [];
            }

            let activeUnits = getActiveUnits();
            if (activeUnits.length > 0) {
                let combatUnits = activeUnits.filter(u => !u.workerType).map(u => u.id);
                let workerUnits = activeUnits.filter(u => !!u.workerType).map(u => u.id);
                if (combatUnits.length > 0) {
                    if (attackMoveMode) {
                        applyUnitCommandTargets(combatUnits, worldX, worldY, isCtrlMulti, 'attackMove');
                        attackMoveMode = false;
                    } else {
                        applyUnitCommandTargets(combatUnits, worldX, worldY, isCtrlMulti, 'move');
                    }
                }
                if (workerUnits.length > 0) {
                    applyUnitCommandTargets(workerUnits, worldX, worldY, isCtrlMulti, 'move');
                }
            } else if (!isCtrlMulti) {
                multiUnitCommandPoints = [];
            }

            updateInfoPanel();
            return;
        }

        // Left click centers camera
        camera.x = (mx / scale) * TILE - viewW / camera.zoom / 2;
        camera.y = (my / scale) * TILE - viewH / camera.zoom / 2;
        clampCamera();
    });

    // Keyboard
    document.addEventListener('keydown', (e) => {
        keysDown[e.key.toLowerCase()] = true;
        if (!gameStarted) return;
        if (e.key === 'Escape') {
            if (researchThingLevelDropdown) {
                closeResearchThingLevelDropdown();
                e.preventDefault();
                e.stopPropagation();
                return;
            }
            if (setResearchStatMatrixPopupOpen(false)) return;
            if (setResearchPopupOpen(false)) return;
            if (setStartingResourcesPopupOpen(false)) return;
            if (setHelpPopupOpen(false)) return;
            stopBuildPlacementDrag();
            selectedBuildItem = null; selectedUnits = []; selectedEntities = []; activeSubGroups = {}; attackMoveMode = false; requestBuildMenuRefresh(); updateInfoPanel();
        }

        let popupGroupKey = String(e.key || '').toLowerCase();
        if (!e.ctrlKey && !e.metaKey && !e.altKey && POPUP_CONTROL_GROUP_KEYS.includes(popupGroupKey)) {
            handlePopupControlGroupKey(popupGroupKey, !!e.shiftKey);
            return;
        }

        if ((e.key === 'z' || e.key === 'Z') && selectedUnits.length > 0) attackMoveMode = true;
        if ((e.key === 'x' || e.key === 'X') && selectedUnits.length > 0) { let au = getActiveUnits(); if (au.length) queueAction({ action: 'stop', unitIds: au.map(u => u.id) }); }
        if (e.key === 'c' || e.key === 'C') { let au = getActiveUnits(); if (au.length) queueAction({ action: 'hold', unitIds: au.map(u => u.id) }); }
        if (e.key === 'f' || e.key === 'F') {
            cycleLevelVisibilityMode();
        }
        if (e.key === '/' || e.code === 'NumpadDivide' || e.key === 'q' || e.key === 'Q') {
            queueResizeForEachActiveUnitSubgroup('d2');
        }
        if (e.key === '*' || e.code === 'NumpadMultiply' || e.key === 'e' || e.key === 'E') {
            queueResizeForEachActiveUnitSubgroup('x2');
        }
        // Control groups
        let num = null;
        if (e.code && e.code.startsWith('Digit')) {
            let d = e.code.slice(5);
            if (d >= '1' && d <= '9') num = d;
        } else if (e.code && e.code.startsWith('Numpad')) {
            let d = e.code.slice(6);
            if (d >= '1' && d <= '9') num = d;
        } else if (e.key >= '1' && e.key <= '9') {
            num = e.key;
        }
        if (num) {
            handleControlGroupKey(num, !!e.shiftKey);
        }
    });
    document.addEventListener('keyup', (e) => { keysDown[e.key.toLowerCase()] = false; });
    window.addEventListener('blur', () => { keysDown = {}; stopBuildPlacementDrag(); });
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) {
            keysDown = {};
            stopBuildPlacementDrag();
        }
    });

    // HUD Settings
    const audioToggle = document.getElementById('setting-audio');
    const audioVolumeSlider = document.getElementById('setting-audio-volume');
    const audioVolumeValue = document.getElementById('setting-audio-volume-value');
    const backgroundAudioVolumeSlider = document.getElementById('setting-background-audio-volume');
    const backgroundAudioVolumeValue = document.getElementById('setting-background-audio-volume-value');
    const goldMineTextToggle = document.getElementById('setting-gold-mine-text');
    const rallyLineTypeSelect = document.getElementById('setting-rally-line-type');
    const rallyLineScopeSelect = document.getElementById('setting-show-rally-lines');
    const selectionOutlineScopeSelect = document.getElementById('setting-show-selection-outlines');
    const selectionOutlineTypeSelect = document.getElementById('setting-selection-outline-type');
    function syncAudioVolumeUi() {
        let sliderValue = Math.round(Math.max(0, Math.min(1, Number(audioVolume) || 0)) * 100);
        if (audioVolumeSlider) audioVolumeSlider.value = String(sliderValue);
        if (audioVolumeValue) audioVolumeValue.textContent = `${sliderValue}%`;
    }
    function syncBackgroundAudioVolumeUi() {
        let sliderValue = Math.round(Math.max(0, Math.min(1, Number(audioBackgroundVolume) || 0)) * 100);
        if (backgroundAudioVolumeSlider) backgroundAudioVolumeSlider.value = String(sliderValue);
        if (backgroundAudioVolumeValue) backgroundAudioVolumeValue.textContent = `${sliderValue}%`;
    }
    if (audioToggle) {
        audioToggle.checked = !!audioEnabled;
        audioToggle.addEventListener('change', () => {
            audioEnabled = audioToggle.checked;
            applyAudioSettings();
            saveUiSettingsToStorage();
            if (!audioEnabled) {
                stopLaserSound();
                stopBackgroundMusic();
            } else {
                startBackgroundMusic();
            }
        });
    }
    if (audioVolumeSlider) {
        syncAudioVolumeUi();
        audioVolumeSlider.addEventListener('input', () => {
            audioVolume = Math.max(0, Math.min(1, (Number(audioVolumeSlider.value) || 0) / 100));
            syncAudioVolumeUi();
            applyAudioSettings();
            saveUiSettingsToStorage();
        });
    } else {
        syncAudioVolumeUi();
    }
    if (backgroundAudioVolumeSlider) {
        syncBackgroundAudioVolumeUi();
        backgroundAudioVolumeSlider.addEventListener('input', () => {
            audioBackgroundVolume = Math.max(0, Math.min(1, (Number(backgroundAudioVolumeSlider.value) || 0) / 100));
            syncBackgroundAudioVolumeUi();
            applyAudioSettings();
            saveUiSettingsToStorage();
        });
    } else {
        syncBackgroundAudioVolumeUi();
    }
    if (goldMineTextToggle) {
        goldMineTextToggle.checked = !!showGoldMineAmountText;
        goldMineTextToggle.addEventListener('change', () => {
            showGoldMineAmountText = goldMineTextToggle.checked;
            saveUiSettingsToStorage();
        });
    }
    if (rallyLineTypeSelect) {
        rallyLineTypeSelect.value = rallyLineType;
        rallyLineTypeSelect.addEventListener('change', () => {
            rallyLineType = rallyLineTypeSelect.value === OVERLAY_LINE_SOLID ? OVERLAY_LINE_SOLID : OVERLAY_LINE_DOTTED;
            saveUiSettingsToStorage();
        });
    }
    if (rallyLineScopeSelect) {
        rallyLineScopeSelect.value = rallyLineScope;
        rallyLineScopeSelect.addEventListener('change', () => {
            let v = String(rallyLineScopeSelect.value || OVERLAY_SCOPE_BUILDINGS);
            if (v !== OVERLAY_SCOPE_BUILDINGS && v !== OVERLAY_SCOPE_BUILDINGS_UNITS && v !== OVERLAY_SCOPE_NONE) v = OVERLAY_SCOPE_BUILDINGS;
            rallyLineScope = v;
            saveUiSettingsToStorage();
        });
    }
    if (selectionOutlineScopeSelect) {
        selectionOutlineScopeSelect.value = selectionOutlineScope;
        selectionOutlineScopeSelect.addEventListener('change', () => {
            let v = String(selectionOutlineScopeSelect.value || OVERLAY_SCOPE_BUILDINGS_UNITS);
            if (v !== OVERLAY_SCOPE_BUILDINGS && v !== OVERLAY_SCOPE_BUILDINGS_UNITS && v !== OVERLAY_SCOPE_NONE) v = OVERLAY_SCOPE_BUILDINGS_UNITS;
            selectionOutlineScope = v;
            saveUiSettingsToStorage();
        });
    }
    if (selectionOutlineTypeSelect) {
        selectionOutlineTypeSelect.value = selectionOutlineType;
        selectionOutlineTypeSelect.addEventListener('change', () => {
            selectionOutlineType = selectionOutlineTypeSelect.value === OVERLAY_LINE_SOLID ? OVERLAY_LINE_SOLID : OVERLAY_LINE_DOTTED;
            saveUiSettingsToStorage();
        });
    }

    updateControlGroupBar();

    // Fullscreen
    const btnFs = document.getElementById('btn-fullscreen');
    function syncFullscreenUi() {
        let isNativeFullscreen = !!document.fullscreenElement;
        appFullscreen = false;
        document.body.classList.remove('app-fullscreen');
        if (btnFs) btnFs.textContent = isNativeFullscreen ? '\uD83D\uDDD6 FS' : '\u26F6 FS';
        window.dispatchEvent(new Event('resize'));
    }
    document.addEventListener('fullscreenchange', syncFullscreenUi);
    if (btnFs) {
        btnFs.addEventListener('click', () => {
            if (document.fullscreenElement) {
                document.exitFullscreen().catch(() => { });
                return;
            }
            let root = document.documentElement;
            if (root && root.requestFullscreen) {
                root.requestFullscreen().catch(() => {
                    appFullscreen = false;
                    document.body.classList.remove('app-fullscreen');
                    btnFs.textContent = '\u26F6 FS';
                    window.dispatchEvent(new Event('resize'));
                });
            } else {
                appFullscreen = false;
                document.body.classList.remove('app-fullscreen');
                btnFs.textContent = '\u26F6 FS';
                window.dispatchEvent(new Event('resize'));
            }
        });
        syncFullscreenUi();
    }

    const btnView2d = document.getElementById('btn-view-2d');
    const btnView3d = document.getElementById('btn-view-3d');
    if (btnView2d) btnView2d.addEventListener('click', () => setRenderDimensionMode('2d'));
    if (btnView3d) btnView3d.addEventListener('click', () => setRenderDimensionMode('3d'));
    syncRenderModeUi();

    const btnLevelVisibility = document.getElementById('btn-level-visibility');
    if (btnLevelVisibility) {
        updateLevelVisibilityButton();
        btnLevelVisibility.addEventListener('click', () => {
            cycleLevelVisibilityMode();
        });
    }

    const btnRenderRange = document.getElementById('btn-render-range');
    if (btnRenderRange) {
        updateRenderRangeButton();
        btnRenderRange.addEventListener('click', () => {
            cycleRenderRangeMode();
        });
    }

    const btnBuildPlaceMode = document.getElementById('btn-build-place-mode');
    if (btnBuildPlaceMode) {
        updateBuildPlacementModeButton();
        btnBuildPlaceMode.addEventListener('click', () => {
            cycleBuildPlacementMode();
        });
    }

    const btnDefaultBuild = document.getElementById('btn-default-build');
    if (btnDefaultBuild) {
        btnDefaultBuild.addEventListener('click', () => {
            defaultAutoBuildEnabled = !defaultAutoBuildEnabled;
            updateDefaultToggleButtons();
        });
    }

    const btnDefaultAutoUpgrade = document.getElementById('btn-default-auto-upgrade');
    if (btnDefaultAutoUpgrade) {
        btnDefaultAutoUpgrade.addEventListener('click', () => {
            defaultAutoUpgradeEnabled = !defaultAutoUpgradeEnabled;
            updateDefaultToggleButtons();
        });
    }

    const btnIgnoreLevel = document.getElementById('btn-ignore-level');
    if (btnIgnoreLevel) {
        btnIgnoreLevel.addEventListener('click', () => {
            ignoreLevelSubgroups = !ignoreLevelSubgroups;
            updateIgnoreLevelButton();
            activeSubGroups = {};
            updateInfoPanel();
        });
    }
    updateDefaultToggleButtons();
    updateIgnoreLevelButton();
    updatePurchaseMultiplierBars();

    const btnHelp = document.getElementById('btn-help');
    const btnHelpClose = document.getElementById('btn-help-close');
    const btnResearchClose = document.getElementById('btn-research-close');
    const btnOpenStartingResources = document.getElementById('btn-open-starting-resources');
    const btnStartingResourcesClose = document.getElementById('btn-starting-resources-close');
    const btnOpenOptimization = document.getElementById('btn-open-optimization');
    const btnOptimizationClose = document.getElementById('btn-optimization-close');
    const btnOpenConfig = document.getElementById('btn-open-config');
    const btnConfigClose = document.getElementById('btn-config-close');
    const btnConfigApply = document.getElementById('btn-config-apply');
    const btnConfigReset = document.getElementById('btn-config-reset');
    const btnExportSettings = document.getElementById('btn-export-settings');
    const btnImportSettings = document.getElementById('btn-import-settings');
    const inputImportSettings = document.getElementById('input-import-settings');
    const btnShowStatsMap = document.getElementById('btn-show-statsmap');
    const btnRefreshStatsMap = document.getElementById('btn-refresh-statsmap');
    const btnStatsMapClose = document.getElementById('btn-statsmap-close');
    const btnResearchMatrixClose = document.getElementById('btn-research-matrix-close');
    const helpPopup = document.getElementById('help-popup');
    const researchPopup = document.getElementById('research-popup');
    const startingResourcesPopup = document.getElementById('starting-resources-popup');
    const statsMapPopup = document.getElementById('statsmap-popup');
    const researchMatrixPopup = document.getElementById('research-matrix-popup');
    const optimizationPopup = document.getElementById('optimization-popup');
    const configPopup = document.getElementById('config-popup');
    const btnResign = document.getElementById('btn-resign');
    const goBtnSpectate = document.getElementById('go-btn-spectate');
    const goBtnGraph = document.getElementById('go-btn-graph');
    const goBtnPlayAgain = document.getElementById('go-btn-play-again');
    const goGraphWrap = document.getElementById('go-graph-wrap');
    if (btnHelp) {
        btnHelp.addEventListener('click', () => {
            setHelpPopupOpen(true);
        });
    }
    if (btnShowStatsMap) {
        btnShowStatsMap.addEventListener('click', () => {
            setStatsMapPopupOpen(true);
        });
    }
    if (btnOpenStartingResources) {
        btnOpenStartingResources.addEventListener('click', () => {
            setStartingResourcesPopupOpen(true);
        });
    }
    if (btnOpenOptimization) {
        btnOpenOptimization.addEventListener('click', () => {
            setOptimizationPopupOpen(true);
        });
    }
    if (btnOptimizationClose) {
        btnOptimizationClose.addEventListener('click', () => {
            setOptimizationPopupOpen(false);
        });
    }
    if (btnOpenConfig) {
        btnOpenConfig.addEventListener('click', () => {
            setConfigPopupOpen(true);
        });
    }
    if (btnConfigApply) {
        btnConfigApply.addEventListener('click', () => {
            applyConfigEditorChanges();
        });
    }
    if (btnConfigReset) {
        btnConfigReset.addEventListener('click', () => {
            resetConfigEditorToDefaults();
        });
    }
    if (btnConfigClose) {
        btnConfigClose.addEventListener('click', () => {
            setConfigPopupOpen(false);
        });
    }
    if (btnStartingResourcesClose) {
        btnStartingResourcesClose.addEventListener('click', () => {
            setStartingResourcesPopupOpen(false);
        });
    }
    if (btnExportSettings) {
        btnExportSettings.addEventListener('click', () => {
            downloadMainMenuSettings();
        });
    }
    if (btnImportSettings && inputImportSettings) {
        btnImportSettings.addEventListener('click', () => {
            inputImportSettings.value = '';
            let opened = false;
            if (typeof inputImportSettings.showPicker === 'function') {
                try {
                    inputImportSettings.showPicker();
                    opened = true;
                } catch { }
            }
            if (!opened) inputImportSettings.click();
        });
        inputImportSettings.addEventListener('change', () => {
            let file = inputImportSettings.files && inputImportSettings.files[0] ? inputImportSettings.files[0] : null;
            importMainMenuSettingsFromFile(file);
        });
    }
    if (btnRefreshStatsMap) {
        btnRefreshStatsMap.addEventListener('click', () => {
            refreshStatsMapPopupText();
        });
    }
    if (btnResign) {
        btnResign.addEventListener('click', () => {
            let el = document.getElementById('game-over');
            if (gameOver) {
                if (spectateMode === 'postgame' && el && el.style.display === 'none') {
                    el.style.display = 'flex';
                }
                return;
            }
            if (!gameStarted || localDefeated) return;
            if (!confirm('Resign and become a spectator?')) return;
            queueAction({ action: 'resign' });
        });
    }
    if (goBtnSpectate) {
        goBtnSpectate.addEventListener('click', () => {
            if (!gameOver) return;
            enterSpectateMode('postgame');
            let el = document.getElementById('game-over');
            if (el) el.style.display = 'none';
        });
    }
    if (goBtnGraph) {
        goBtnGraph.addEventListener('click', () => {
            if (!goGraphWrap) return;
            goGraphWrap.style.display = goGraphWrap.style.display === 'none' ? 'block' : 'none';
            if (goGraphWrap.style.display !== 'none') renderGameGraph(graphMetric);
        });
    }
    if (goBtnPlayAgain) {
        goBtnPlayAgain.addEventListener('click', () => {
            if (!gameOver || !isHost || !isMultiplayer) return;
            hostPlayAgain();
        });
    }
    document.querySelectorAll('.go-graph-metric').forEach(btn => {
        btn.addEventListener('click', () => {
            let metric = btn.dataset.metric || 'units';
            renderGameGraph(metric);
        });
    });
    if (btnHelpClose) {
        btnHelpClose.addEventListener('click', () => {
            setHelpPopupOpen(false);
        });
    }
    if (btnResearchClose) {
        btnResearchClose.addEventListener('click', () => {
            setResearchPopupOpen(false);
        });
    }
    if (btnStatsMapClose) {
        btnStatsMapClose.addEventListener('click', () => {
            setStatsMapPopupOpen(false);
        });
    }
    if (btnResearchMatrixClose) {
        btnResearchMatrixClose.addEventListener('click', () => {
            setResearchStatMatrixPopupOpen(false);
        });
    }
    if (helpPopup) {
        helpPopup.addEventListener('click', (e) => {
            let tabBtn = e.target.closest('.help-tab-btn');
            if (tabBtn && tabBtn.dataset.tab) setHelpTab(tabBtn.dataset.tab);
        });
        helpPopup.addEventListener('mousedown', (e) => {
            if (e.target === helpPopup) setHelpPopupOpen(false);
        });
    }
    if (researchPopup) {
        researchPopup.addEventListener('mousedown', (e) => {
            if (e.target === researchPopup) setResearchPopupOpen(false);
        });
    }
    if (startingResourcesPopup) {
        startingResourcesPopup.addEventListener('mousedown', (e) => {
            if (e.target === startingResourcesPopup) setStartingResourcesPopupOpen(false);
        });
    }
    if (statsMapPopup) {
        statsMapPopup.addEventListener('mousedown', (e) => {
            if (e.target === statsMapPopup) setStatsMapPopupOpen(false);
        });
    }
    if (researchMatrixPopup) {
        researchMatrixPopup.addEventListener('mousedown', (e) => {
            if (e.target === researchMatrixPopup) setResearchStatMatrixPopupOpen(false);
        });
    }
    if (optimizationPopup) {
        optimizationPopup.addEventListener('mousedown', (e) => {
            if (e.target === optimizationPopup) setOptimizationPopupOpen(false);
        });
    }
    if (configPopup) {
        configPopup.addEventListener('mousedown', (e) => {
            if (e.target === configPopup) setConfigPopupOpen(false);
        });
    }

    ensureDefaultEditableRuntimeConfigSnapshot();

    // Minimap toggle
    const btnMap = document.getElementById('btn-minimap');
    const mapCont = document.getElementById('minimap-container');
    const statsCont = document.getElementById('shop-stats-container');
    if (btnMap && mapCont) {
        btnMap.addEventListener('click', () => {
            let isCollapsed = btnMap.innerText === '\u25B2';
            btnMap.innerText = isCollapsed ? '\u25BC' : '\u25B2';
            let showPanel = btnMap.innerText === '\u25BC';
            if (selectedBuildItem) {
                mapCont.style.display = 'none';
                if (statsCont) statsCont.style.display = showPanel ? 'block' : 'none';
            } else {
                mapCont.style.display = showPanel ? 'block' : 'none';
                if (statsCont) statsCont.style.display = 'none';
            }
        });
    }

    // Touch events for gameArea
    let activeTouches = {};
    let touchDistInitial = 0;
    let touchCenterInitial = null;
    let cameraZoomInitial = 1;
    let cameraXInitial = 0;
    let cameraYInitial = 0;
    let singleTouchId = null;
    let longPressTimer = null;
    let longPressFired = false;
    let touchStartX = 0;
    let touchStartY = 0;

    gameArea.addEventListener('touchstart', (e) => {
        e.preventDefault();
        for (let i = 0; i < e.changedTouches.length; i++) {
            activeTouches[e.changedTouches[i].identifier] = e.changedTouches[i];
        }
        let keys = Object.keys(activeTouches);

        if (keys.length === 1) {
            let t = activeTouches[keys[0]];
            singleTouchId = t.identifier;
            longPressFired = false;
            touchStartX = t.clientX;
            touchStartY = t.clientY;

            let syntheticDown = new MouseEvent('mousedown', { button: 0, clientX: t.clientX, clientY: t.clientY });
            gameArea.dispatchEvent(syntheticDown);

            if (longPressRallyEnabled) {
                longPressTimer = setTimeout(() => {
                    longPressTimer = null;
                    longPressFired = true;
                    isBoxSelecting = false;
                    selectionBox = null;
                    let syntheticRight = new MouseEvent('mousedown', { button: 2, clientX: t.clientX, clientY: t.clientY });
                    gameArea.dispatchEvent(syntheticRight);
                }, 300);
            }
        } else if (keys.length === 2) {
            if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
            isBoxSelecting = false;
            selectionBox = null;
            let t1 = activeTouches[keys[0]], t2 = activeTouches[keys[1]];
            let dx = t1.clientX - t2.clientX;
            let dy = t1.clientY - t2.clientY;
            touchDistInitial = Math.hypot(dx, dy);
            touchCenterInitial = { x: (t1.clientX + t2.clientX) / 2, y: (t1.clientY + t2.clientY) / 2 };
            cameraZoomInitial = camera.zoom;
            cameraXInitial = camera.x;
            cameraYInitial = camera.y;
        }
    }, { passive: false });

    gameArea.addEventListener('touchmove', (e) => {
        e.preventDefault();
        for (let i = 0; i < e.changedTouches.length; i++) {
            activeTouches[e.changedTouches[i].identifier] = e.changedTouches[i];
        }
        let keys = Object.keys(activeTouches);

        if (keys.length === 1 && keys[0] == singleTouchId) {
            let t = activeTouches[keys[0]];

            if (longPressTimer) {
                let limit = Math.min(gameArea.clientWidth, gameArea.clientHeight) * 0.10;
                let dx = t.clientX - touchStartX;
                let dy = t.clientY - touchStartY;
                if (Math.hypot(dx, dy) > limit) {
                    clearTimeout(longPressTimer);
                    longPressTimer = null;
                }
            }

            if (!longPressFired) {
                let syntheticMove = new MouseEvent('mousemove', { clientX: t.clientX, clientY: t.clientY });
                gameArea.dispatchEvent(syntheticMove);
            }
        } else if (keys.length === 2 && touchCenterInitial) {
            let t1 = activeTouches[keys[0]], t2 = activeTouches[keys[1]];
            let dx = t1.clientX - t2.clientX;
            let dy = t1.clientY - t2.clientY;
            let dist = Math.hypot(dx, dy);
            let cx = (t1.clientX + t2.clientX) / 2;
            let cy = (t1.clientY + t2.clientY) / 2;

            // Zoom
            let zoomRatio = dist / touchDistInitial;
            let minZoom = Math.max(viewW / WORLD_W, viewH / WORLD_H, 0.4);
            camera.zoom = Math.max(minZoom, Math.min(MAX_CAMERA_ZOOM, cameraZoomInitial * zoomRatio));

            if (renderDimensionMode !== '3d') {
                // Keep 2D pinch zoom centered on the gesture focus.
                let rect = gameArea.getBoundingClientRect();
                let worldBeforeX = cameraXInitial + (touchCenterInitial.x - rect.left) / cameraZoomInitial;
                let worldBeforeY = cameraYInitial + (touchCenterInitial.y - rect.top) / cameraZoomInitial;

                camera.x = worldBeforeX - (cx - rect.left) / camera.zoom;
                camera.y = worldBeforeY - (cy - rect.top) / camera.zoom;
            }

            clampCamera();
        }
    }, { passive: false });

    gameArea.addEventListener('touchend', (e) => {
        e.preventDefault();
        for (let i = 0; i < e.changedTouches.length; i++) {
            delete activeTouches[e.changedTouches[i].identifier];
        }
        let keys = Object.keys(activeTouches);

        if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }

        if (keys.length === 0) {
            if (!longPressFired) {
                let t = e.changedTouches[0];
                let syntheticUp = new MouseEvent('mouseup', { button: 0, clientX: t.clientX, clientY: t.clientY });
                gameArea.dispatchEvent(syntheticUp);
            }

            touchCenterInitial = null;
            singleTouchId = null;
            longPressFired = false;
        }
    }, { passive: false });

    gameArea.addEventListener('touchcancel', (e) => {
        e.preventDefault();
        for (let i = 0; i < e.changedTouches.length; i++) {
            delete activeTouches[e.changedTouches[i].identifier];
        }
        if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
        isBoxSelecting = false;
        selectionBox = null;
        touchCenterInitial = null;
        singleTouchId = null;
        longPressFired = false;
    }, { passive: false });

    let longPressToggle = document.getElementById('setting-long-press');
    if (longPressToggle) {
        longPressToggle.checked = longPressRallyEnabled;
        longPressToggle.addEventListener('change', (e) => {
            longPressRallyEnabled = e.target.checked;
        });
    }
}

function processActions(actions, playerId) {
    for (let a of actions) {
        if (a.action === 'place') {
            let count = Math.max(1, Math.floor(a.count || 1));
            for (let i = 0; i < count; i++) {
                placeBuilding(a.gx, a.gy, a.itemType, playerId, { autoUpgradeEnabled: a.autoUpgradeEnabled, buildEnabled: a.buildEnabled });
            }
        } else if (a.action === 'move') {
            let targetGx = Math.floor(a.targetX / TILE), targetGy = Math.floor(a.targetY / TILE);
            for (let u of units) {
                if (a.unitIds.includes(u.id) && u.owner === playerId && !u.dead) {
                    u.targetUnit = null; u.targetBuilding = null; u.forcedAttackTarget = false;
                    u._forcedTargetLastSeenX = null; u._forcedTargetLastSeenY = null;
                    u.commandState = CMD_MOVING;
                    if (u.workerState) {
                        _clearWorkerTarget(u);
                        Object.assign(u, { workerState: 'MANUAL_MOVE', workerTarget: null, workerTargetType: null });
                        clearWorkerTaskMemoryForFreeRetarget(u);
                    }
                    if (_canUsePathfindRequestBudget(u.owner)) {
                        _consumePathfindRequestBudget(u.owner);
                        let ugx = Math.floor(u.x / TILE), ugy = Math.floor(u.y / TILE);
                        let dest = findNearestWalkable(targetGx, targetGy, ugx, ugy, u);
                        u.path = _findPathForUnitTagged('player_commands', u, ugx, ugy, dest.x, dest.y, u.isFlying, getPathCanWalkForUnit(u), u.owner);
                        if (u.path && u.path.length > 0) {
                            u.pathIndex = (u.path.length > 1 && u.path[0].x === ugx && u.path[0].y === ugy) ? 1 : 0;
                            u._pendingPathTarget = null;
                        } else {
                            u.path = _makeFallbackPathForUnit(u, ugx, ugy, targetGx, targetGy, CMD_MOVING, 'player_commands');
                            u.pathIndex = (u.path && u.path.length > 1 && u.path[0].x === ugx && u.path[0].y === ugy) ? 1 : 0;
                        }
                    } else {
                        let ugx = Math.floor(u.x / TILE), ugy = Math.floor(u.y / TILE);
                        let dest = findNearestWalkable(targetGx, targetGy, ugx, ugy, u);
                        u.path = _makeFallbackPathForUnit(u, ugx, ugy, dest.x, dest.y, CMD_MOVING, 'player_commands');
                        u.pathIndex = (u.path && u.path.length > 1 && u.path[0].x === ugx && u.path[0].y === ugy) ? 1 : 0;
                    }
                }
            }
        } else if (a.action === 'attackMove') {
            let targetGx = Math.floor(a.targetX / TILE), targetGy = Math.floor(a.targetY / TILE);
            for (let u of units) {
                if (a.unitIds.includes(u.id) && u.owner === playerId && !u.dead) {
                    u.targetUnit = null; u.targetBuilding = null; u.forcedAttackTarget = false;
                    u._forcedTargetLastSeenX = null; u._forcedTargetLastSeenY = null;
                    u.commandState = CMD_ATTACK_MOVING;
                    if (u.workerState) {
                        _clearWorkerTarget(u);
                        Object.assign(u, { workerState: 'MANUAL_MOVE', workerTarget: null, workerTargetType: null });
                        clearWorkerTaskMemoryForFreeRetarget(u);
                    }
                    if (_canUsePathfindRequestBudget(u.owner)) {
                        _consumePathfindRequestBudget(u.owner);
                        let ugx = Math.floor(u.x / TILE), ugy = Math.floor(u.y / TILE);
                        let dest = findNearestWalkable(targetGx, targetGy, ugx, ugy, u);
                        u.path = _findPathForUnitTagged('player_commands', u, ugx, ugy, dest.x, dest.y, u.isFlying, getPathCanWalkForUnit(u), u.owner);
                        if (u.path && u.path.length > 0) {
                            u.pathIndex = (u.path.length > 1 && u.path[0].x === ugx && u.path[0].y === ugy) ? 1 : 0;
                            u._pendingPathTarget = null;
                        } else {
                            u.path = _makeFallbackPathForUnit(u, ugx, ugy, targetGx, targetGy, CMD_ATTACK_MOVING, 'player_commands');
                            u.pathIndex = (u.path && u.path.length > 1 && u.path[0].x === ugx && u.path[0].y === ugy) ? 1 : 0;
                        }
                    } else {
                        let ugx = Math.floor(u.x / TILE), ugy = Math.floor(u.y / TILE);
                        let dest = findNearestWalkable(targetGx, targetGy, ugx, ugy, u);
                        u.path = _makeFallbackPathForUnit(u, ugx, ugy, dest.x, dest.y, CMD_ATTACK_MOVING, 'player_commands');
                        u.pathIndex = (u.path && u.path.length > 1 && u.path[0].x === ugx && u.path[0].y === ugy) ? 1 : 0;
                    }
                }
            }
        } else if (a.action === 'attack') {
            let target = units.find(u => u.id === a.targetId);
            if (target) {
                let targetGx = Math.floor(target.x / TILE), targetGy = Math.floor(target.y / TILE);
                for (let u of units) {
                    if (a.unitIds.includes(u.id) && u.owner === playerId && !u.dead) {
                        u.targetUnit = target; u.commandState = CMD_ATTACKING; u.targetBuilding = null; u.forcedAttackTarget = true;
                        u._forcedTargetLastSeenX = target.x; u._forcedTargetLastSeenY = target.y;
                        let ugx = Math.floor(u.x / TILE), ugy = Math.floor(u.y / TILE);
                        let dest = findNearestWalkable(targetGx, targetGy, ugx, ugy, u);
                        if (_canUsePathfindRequestBudget(u.owner)) {
                            _consumePathfindRequestBudget(u.owner);
                            u.path = _findPathForUnitTagged('player_commands', u, ugx, ugy, dest.x, dest.y, u.isFlying, getPathCanWalkForUnit(u), u.owner);
                            if (u.path && u.path.length > 0) {
                                u.pathIndex = (u.path.length > 1 && u.path[0].x === ugx && u.path[0].y === ugy) ? 1 : 0;
                                u._pendingPathTarget = null;
                            } else {
                                u.path = null;
                                u.pathIndex = 0;
                                u._pendingPathTarget = { gx: dest.x, gy: dest.y, cmd: CMD_ATTACKING, src: 'player_commands' };
                            }
                        } else {
                            u.path = _makeFallbackPathForUnit(u, ugx, ugy, dest.x, dest.y, CMD_ATTACKING, 'player_commands');
                            u.pathIndex = (u.path && u.path.length > 1 && u.path[0].x === ugx && u.path[0].y === ugy) ? 1 : 0;
                        }
                    }
                }
            } else if (Number.isFinite(a.targetX) && Number.isFinite(a.targetY)) {
                // Target vanished before processing: continue toward last known position.
                processActions([{ action: 'attackMove', unitIds: a.unitIds, targetX: a.targetX, targetY: a.targetY }], playerId);
            }
        } else if (a.action === 'attackBuilding') {
            let tb = getTileEntityRef(a.targetGx, a.targetGy);
            if (!(tb && tb.energy > 0)) tb = null;
            if (tb) {
                for (let u of units) {
                    if (a.unitIds.includes(u.id) && u.owner === playerId && !u.dead) {
                        u.targetBuilding = tb; u.commandState = CMD_ATTACKING; u.targetUnit = null; u.forcedAttackTarget = false;
                        u._forcedTargetLastSeenX = null; u._forcedTargetLastSeenY = null;
                        let ugx = Math.floor(u.x / TILE), ugy = Math.floor(u.y / TILE);
                        let dest = findNearestWalkable(tb.gx, tb.gy, ugx, ugy, u);
                        if (_canUsePathfindRequestBudget(u.owner)) {
                            _consumePathfindRequestBudget(u.owner);
                            u.path = _findPathForUnitTagged('player_commands', u, ugx, ugy, dest.x, dest.y, u.isFlying, getPathCanWalkForUnit(u), u.owner);
                            if (u.path && u.path.length > 0) {
                                u.pathIndex = 0;
                                u._pendingPathTarget = null;
                            } else {
                                u.path = null;
                                u.pathIndex = 0;
                                u._pendingPathTarget = { gx: dest.x, gy: dest.y, cmd: CMD_ATTACKING, src: 'player_commands' };
                            }
                        } else {
                            u.path = _makeFallbackPathForUnit(u, ugx, ugy, dest.x, dest.y, CMD_ATTACKING, 'player_commands');
                            u.pathIndex = (u.path && u.path.length > 1 && u.path[0].x === ugx && u.path[0].y === ugy) ? 1 : 0;
                        }
                    }
                }
            }
        } else if (a.action === 'stop') {
            for (let u of units) {
                if (a.unitIds.includes(u.id) && u.owner === playerId) {
                    u.commandState = CMD_IDLE; u.path = null; u.targetUnit = null; u.targetBuilding = null; u._pendingPathTarget = null; u.forcedAttackTarget = false; u._forcedTargetLastSeenX = null; u._forcedTargetLastSeenY = null;
                    if (u.workerState) {
                        _clearWorkerTarget(u);
                        clearWorkerTaskMemoryForFreeRetarget(u);
                        u.workerState = 'IDLE';
                    }
                }
            }
        } else if (a.action === 'hold') {
            for (let u of units) {
                if (a.unitIds.includes(u.id) && u.owner === playerId) {
                    u.commandState = CMD_HOLDING; u.path = null; u.targetUnit = null; u.targetBuilding = null; u._pendingPathTarget = null; u.forcedAttackTarget = false; u._forcedTargetLastSeenX = null; u._forcedTargetLastSeenY = null;
                    if (u.workerState) {
                        _clearWorkerTarget(u);
                        clearWorkerTaskMemoryForFreeRetarget(u);
                        u.workerState = 'IDLE';
                    }
                }
            }
        } else if (a.action === 'queueUnit') {
            let b = getBarrackAtTile(a.gx, a.gy);
            if (!(b && b.owner === playerId)) b = null;
            if (b && b.energy > 0 && !b.underConstruction) {
                let count = Math.max(1, Math.floor(a.count || 1));
                for (let i = 0; i < count; i++) {
                    if (b.spawnQueue.length >= 20) break;
                    let queuedLevel = getThingEffectiveLevel(b);
                    b.spawnQueue.push(getQueuedSpawnInfo({ unitType: b.unitType, level: queuedLevel }, b.unitType, queuedLevel, playerId));
                }
            }
        } else if (a.action === 'queueWorker') {
            let s = getSpawnerAtTile(a.gx, a.gy);
            if (!(s && s.owner === playerId)) s = null;
            if (s && s.energy > 0 && !s.underConstruction) {
                let count = Math.max(1, Math.floor(a.count || 1));
                for (let i = 0; i < count; i++) {
                    if (s.spawnQueue.length >= 10) break;
                    let queuedLevel = getThingEffectiveLevel(s);
                    let queuedType = s.type === 'spawner'
                        ? 'collector'
                        : s.type === 'astar_spawner'
                            ? 'astar_collector'
                            : s.type === 'builder_spawner'
                                ? 'builder_unit'
                                : s.type === 'healer_spawner'
                                    ? 'healer_unit'
                                    : s.type === 'research'
                                        ? 'researcher_unit'
                                        : 'salvager_unit';
                    s.spawnQueue.push(getQueuedSpawnInfo({ unitType: queuedType, level: queuedLevel }, queuedType, queuedLevel, playerId));
                }
            }
        } else if (a.action === 'queueResearch') {
            let r = getSpawnerAtTile(a.gx, a.gy);
            if (!(r && r.owner === playerId && r.type === 'research')) r = null;
            let stat = getResearchStatEntry(a.kind, a.key, a.statKey);
            if (r && r.energy > 0 && !r.underConstruction && stat) {
                let p = ensurePlayerResearchQueueState(playerId);
                let count = Math.max(1, Math.floor(a.count || 1));
                for (let i = 0; i < count; i++) {
                    if (getPlayerResearchQueueTotalLength(playerId) >= getResearchQueueCapacityForPlayer(playerId)) break;
                    let baseLevel = getPlayerResearchLevel(playerId, a.kind, a.key, a.statKey);
                    let queuedDepth = getResearchQueuedDepthForPlayer(playerId, a.kind, a.key, a.statKey);
                    let projected = baseLevel + queuedDepth;
                    if (projected >= MAX_RESEARCH_LEVEL) break;
                    let task = makeResearchTask(playerId, a.kind, a.key, a.statKey, projected);
                    p.researchQueue.push(task);
                    tryAdvancePlayerResearchTask(playerId);
                }
            }
        } else if (a.action === 'workerAssign') {
            // Assign selected worker units to a specific target
            for (let u of units) {
                if (!a.unitIds.includes(u.id) || u.owner !== playerId || u.dead || !u.workerState) continue;
                let myGx = Math.floor(u.x / TILE), myGy = Math.floor(u.y / TILE);
                if (u.workerType === 'builder' && a.targetType === 'build') {
                    // Generic lookup: includes both under-construction and upgrading targets.
                    let target = _getBuilderWorkTargetAt(a.targetGx, a.targetGy, playerId, true);
                    if (target) {
                        _releaseManualWorkerAssignmentConflicts(u, target, null);
                        if (!_canAssignWorkerTargetExclusive(u, target, null)) {
                            issueWorkerBlockedAssignFallbackMove(u, a.targetGx, a.targetGy);
                            continue;
                        }
                        // Manual assignment should always allow builders to work this target,
                        // even if auto-build for new objects is currently disabled.
                        target.buildEnabled = true;
                        _clearWorkerTarget(u); // clear old target
                        _builderAssignTarget(u, target, myGx, myGy);
                    }
                } else if (u.workerType === 'collector' && (a.targetType === 'mine' || a.targetType === 'farm')) {
                    let gather = _getCollectorGatherTargetAt(a.targetGx, a.targetGy, playerId, a.targetType);
                    if (gather && _isCollectorTargetValid(gather.target, gather.type, playerId)) {
                        _releaseManualWorkerAssignmentConflicts(u, gather.target, gather.type);
                        if (!_canAssignWorkerTargetExclusive(u, gather.target, gather.type)) {
                            _clearWorkerTarget(u);
                            u.workerState = 'IDLE';
                            u.commandState = CMD_IDLE;
                            _collectorFindTarget(u, myGx, myGy);
                            continue;
                        }
                        _clearWorkerTarget(u);
                        u._collectorPinnedTarget = gather.target;
                        u._collectorPinnedTargetType = gather.type;
                        _collectorAssignTarget(u, gather.target, gather.type, myGx, myGy);
                    }
                } else if (u.workerType === 'astar_collector' && (a.targetType === 'astar_mine' || a.targetType === 'astar_farm')) {
                    let gather = _getAstarCollectorGatherTargetAt(a.targetGx, a.targetGy, playerId, a.targetType);
                    if (gather && _isAstarCollectorTargetValid(gather.target, gather.type, playerId)) {
                        _releaseManualWorkerAssignmentConflicts(u, gather.target, gather.type);
                        if (!_canAssignWorkerTargetExclusive(u, gather.target, gather.type)) {
                            _clearWorkerTarget(u);
                            u.workerState = 'IDLE';
                            u.commandState = CMD_IDLE;
                            _astarCollectorFindTarget(u);
                            continue;
                        }
                        _clearWorkerTarget(u);
                        u._astarPinnedTarget = gather.target;
                        u._astarPinnedTargetType = gather.type;
                        _astarCollectorAssignTarget(u, gather.target, gather.type);
                    }
                } else if (u.workerType === 'healer' && a.targetType === 'queue') {
                    let qTarget = getTileEntityRef(a.targetGx, a.targetGy);
                    if (!(qTarget && qTarget.owner === playerId && ((qTarget instanceof Barrack) || isSpawnerEntity(qTarget)))) qTarget = null;
                    if (_isHealerQueueAnchorTarget(qTarget, playerId)) {
                        _releaseManualWorkerAssignmentConflicts(u, qTarget, 'queue');
                        if (!_canAssignWorkerTargetExclusive(u, qTarget, 'queue')) {
                            issueWorkerBlockedAssignFallbackMove(u, a.targetGx, a.targetGy);
                            continue;
                        }
                        _clearWorkerTarget(u);
                        u._healerPinnedQueueTarget = qTarget;
                        if (_isHealerQueueTarget(qTarget, playerId)) _setHealerQueueCommit(u, qTarget);
                        else _clearHealerQueueCommit(u);
                        _healerFindTarget(u, myGx, myGy);
                    }
                } else if (u.workerType === 'researcher' && a.targetType === 'research') {
                    let rTarget = getTileEntityRef(a.targetGx, a.targetGy);
                    if (!_isResearcherTargetBuilding(rTarget, playerId)) rTarget = null;
                    if (rTarget) {
                        _releaseManualWorkerAssignmentConflicts(u, rTarget, 'research');
                        if (!_canAssignWorkerTargetExclusive(u, rTarget, 'research')) {
                            issueWorkerBlockedAssignFallbackMove(u, a.targetGx, a.targetGy);
                            continue;
                        }
                        _clearWorkerTarget(u);
                        if (!_setWorkerTarget(u, rTarget, 'research')) {
                            issueWorkerBlockedAssignFallbackMove(u, a.targetGx, a.targetGy);
                            continue;
                        }
                        u.workerState = 'MOVING_TO_RESEARCH';
                        u._workerNextIdleRetargetTick = gameTime;
                        u._researchSpawnerTarget = null;
                        let path = _requestWorkerPath(u, myGx, myGy, rTarget.gx, rTarget.gy, null, null);
                        if (path && path.length > 0) {
                            u.path = path;
                            u.pathIndex = 0;
                            u.commandState = CMD_MOVING;
                        } else {
                            u.commandState = CMD_IDLE;
                        }
                    }
                }
            }
        } else if (a.action === 'setRally') {
            let b = getTileEntityRef(a.gx, a.gy);
            if (!(b && b.owner === playerId && ((b instanceof Barrack) || isSpawnerEntity(b)))) b = null;
            if (b) {
                b.rallyX = a.targetX;
                b.rallyY = a.targetY;
                b.rallyTargetUnitId = (a.targetUnitId != null) ? a.targetUnitId : null;
                b._rallyLastSeenX = Number.isFinite(a.targetX) ? a.targetX : null;
                b._rallyLastSeenY = Number.isFinite(a.targetY) ? a.targetY : null;
                b._pendingRallyDetach = false;
            }
        } else if (a.action === 'resign') {
            resignedTeams.add(playerId);
            if (playerId === localPlayerId) enterSpectateMode('defeated');
            checkWinCondition();
        } else if (a.action === 'forceResignTeam') {
            let targetTeam = Number.isFinite(a.targetTeam) ? Math.floor(a.targetTeam) : null;
            if (targetTeam !== null) {
                resignedTeams.add(targetTeam);
                if (targetTeam === localPlayerId) enterSpectateMode('defeated');
                checkWinCondition();
            }
        } else if (a.action === 'dequeueUnit') {
            let b = getBarrackAtTile(a.gx, a.gy);
            if (!(b && b.owner === playerId)) b = null;
            if (b) {
                let count = Math.max(1, Math.floor(a.count || 1));
                for (let i = 0; i < count; i++) {
                    if (b.spawnQueue.length <= 0) break;
                    b.spawnQueue.shift();
                }
            }
        } else if (a.action === 'dequeueWorker') {
            let s = getSpawnerAtTile(a.gx, a.gy);
            if (!(s && s.owner === playerId)) s = null;
            if (s) {
                let count = Math.max(1, Math.floor(a.count || 1));
                for (let i = 0; i < count; i++) {
                    if (s.spawnQueue.length <= 0) break;
                    s.spawnQueue.shift();
                }
            }
        } else if (a.action === 'dequeueResearch') {
            let r = getSpawnerAtTile(a.gx, a.gy);
            if (!(r && r.owner === playerId && r.type === 'research')) r = null;
            if (r) {
                let p = ensurePlayerResearchQueueState(playerId);
                let count = Math.max(1, Math.floor(a.count || 1));
                for (let i = 0; i < count; i++) {
                    let idx = -1;
                    if (a.kind && a.key && a.statKey) {
                        for (let qi = p.researchQueue.length - 1; qi >= 0; qi--) {
                            let q = p.researchQueue[qi];
                            if (q && q.kind === a.kind && q.key === a.key && q.statKey === a.statKey) {
                                idx = qi;
                                break;
                            }
                        }
                    } else if (p.researchQueue.length > 0) {
                        idx = p.researchQueue.length - 1;
                    }

                    if (idx >= 0) {
                        p.researchQueue.splice(idx, 1);
                        continue;
                    }

                    if (p.researchTask) {
                        if (!a.kind || !a.key || !a.statKey || (p.researchTask.kind === a.kind && p.researchTask.key === a.key && p.researchTask.statKey === a.statKey)) {
                            p.researchTask = null;
                            tryAdvancePlayerResearchTask(playerId);
                        }
                    }
                }
            }
        } else if (a.action === 'reorderResearch') {
            let r = getSpawnerAtTile(a.gx, a.gy);
            if (!(r && r.owner === playerId && r.type === 'research')) r = null;
            if (r || getOwnedActiveResearchLabs(playerId).length > 0) {
                let p = ensurePlayerResearchQueueState(playerId);
                let fromIsActive = !!a.fromActive;
                let toIsActive = !!a.toActive;
                let ordered = [];
                if (p.researchTask) ordered.push(p.researchTask);
                for (let task of p.researchQueue) ordered.push(task);
                if (ordered.length <= 1) continue;

                let from = fromIsActive ? 0 : (Math.floor(Number(a.fromIndex)) + 1);
                if (!Number.isFinite(from) || from < 0 || from >= ordered.length) continue;

                let rawTo = Math.floor(Number(a.toIndex));
                let to = 0;
                if (toIsActive) {
                    to = 0;
                } else {
                    if (!Number.isFinite(rawTo)) continue;
                    if (fromIsActive) {
                        to = Math.max(0, Math.min(ordered.length - 1, rawTo + 1));
                    } else {
                        to = rawTo <= 0
                            ? 0
                            : Math.max(0, Math.min(ordered.length - 1, rawTo + 1));
                    }
                }
                if (from === to) continue;

                let [task] = ordered.splice(from, 1);
                if (!task) continue;
                ordered.splice(to, 0, task);

                p.researchTask = ordered[0] || null;
                p.researchQueue.length = 0;
                for (let i = 1; i < ordered.length; i++) p.researchQueue.push(ordered[i]);
            }
        } else if (a.action === 'markSalvage') {
            // Toggle salvage mark on a building at gx,gy
            let target = getTileEntityRef(a.gx, a.gy);
            if (target && target.owner === playerId && target.markedForSalvage !== undefined) {
                target.markedForSalvage = !target.markedForSalvage;
            }
        } else if (a.action === 'setAutoUpgrade') {
            let target = getTileEntityRef(a.gx, a.gy);
            if (!(target && target.owner === playerId)) target = null;
            if (target) {
                target.autoUpgradeEnabled = !!a.enabled;
                if (!target.autoUpgradeEnabled) {
                    target.isUpgrading = false;
                }
                refreshThingProgressState(target);
            }
        } else if (a.action === 'setAutoStack') {
            let target = getTileEntityRef(a.gx, a.gy);
            if (!(target && target.owner === playerId)) target = null;
            if (target) {
                target.autoStackEnabled = !!a.enabled;
                refreshThingProgressState(target);
            }
        } else if (a.action === 'setBuildEnabled') {
            let target = getTileEntityRef(a.gx, a.gy);
            if (!(target && target.owner === playerId)) target = null;
            if (target) {
                target.buildEnabled = !!a.enabled;
            }
        } else if (a.action === 'setQueueEnabled') {
            let target = getTileEntityRef(a.gx, a.gy);
            if (!(target && target.owner === playerId && ((target instanceof Barrack) || isSpawnerEntity(target)))) target = null;
            if (target) {
                target.queueEnabled = !!a.enabled;
            }
        } else if (a.action === 'setAutoResearch') {
            let target = getSpawnerAtTile(a.gx, a.gy);
            if (!(target && target.owner === playerId && target.type === 'research')) target = null;
            if (target) {
                target.autoResearchEnabled = !!a.enabled;
                if (target.autoResearchEnabled) {
                    let task = getPlayerResearchTask(playerId);
                    target.researchTask = task || null;
                    if (!target.isUpgrading && task && task.workDone < task.workRequired) {
                        target.isResearching = true;
                    }
                } else {
                    target.isResearching = false;
                }
            }
        } else if (a.action === 'killUnit') {
            let u = units.find(u => u.id === a.unitId && u.owner === playerId);
            if (u && !u.dead && !u.isKing) { u.energy = 0; u.dead = true; players[playerId].popCount--; }
        } else if (a.action === 'resizeUnitGroup') {
            let subgroupFilter = {
                unitType: a.unitType || null,
                unitLevel: Number.isFinite(a.unitLevel) ? a.unitLevel : null
            };
            resizeUnitSubgroup(playerId, a.unitIds || [], a.mode, subgroupFilter);
        } else if (a.action === 'towerTarget') {
            // Set preferredTarget on own towers
            for (let tc of (a.towerCoords || [])) {
                let t = getTowerAtTile(tc.gx, tc.gy);
                if (!(t && t.owner === playerId)) t = null;
                if (!t) continue;
                if (!a.target) { t.preferredTarget = null; t.preferredTargetSpec = null; continue; }
                if (a.target.type === 'unit') {
                    let tu = units.find(u => u.id === a.target.id && !u.dead && u.owner !== playerId);
                    t.preferredTarget = tu || null;
                    t.preferredTargetSpec = tu ? { type: 'unit', id: tu.id } : null;
                } else if (a.target.type === 'tower') {
                    let tb = getTowerAtTile(a.target.gx, a.target.gy);
                    t.preferredTarget = (tb && tb.energy > 0 && tb.owner !== playerId) ? tb : null;
                    t.preferredTargetSpec = t.preferredTarget ? { type: 'tower', gx: a.target.gx, gy: a.target.gy } : null;
                } else if (a.target.type === 'barrack') {
                    let b = getBarrackAtTile(a.target.gx, a.target.gy);
                    t.preferredTarget = (b && b.energy > 0 && b.owner !== playerId) ? b : null;
                    t.preferredTargetSpec = t.preferredTarget ? { type: 'barrack', gx: a.target.gx, gy: a.target.gy } : null;
                } else if (a.target.type === 'spawner') {
                    let s = getSpawnerAtTile(a.target.gx, a.target.gy);
                    t.preferredTarget = (s && s.energy > 0 && s.owner !== playerId) ? s : null;
                    t.preferredTargetSpec = t.preferredTarget ? { type: 'spawner', gx: a.target.gx, gy: a.target.gy } : null;
                } else if (a.target.type === 'item') {
                    let item = getFloorItemAtTile(a.target.gx, a.target.gy);
                    t.preferredTarget = (item && item.energy > 0 && item.owner !== playerId) ? item : null;
                    t.preferredTargetSpec = t.preferredTarget ? { type: 'item', gx: a.target.gx, gy: a.target.gy } : null;
                } else {
                    t.preferredTarget = null;
                    t.preferredTargetSpec = null;
                }
            }
        }
    }
}

// ============================================================
// CAMERA CONTROLS
// ============================================================
function clampCamera() {
    let maxX = WORLD_W - viewW / camera.zoom;
    let maxY = WORLD_H - viewH / camera.zoom;
    camera.x = Math.max(0, Math.min(maxX, camera.x));
    camera.y = Math.max(0, Math.min(maxY, camera.y));
}

function updateCamera() {
    let speed = 12 / camera.zoom;
    if (renderDimensionMode === '3d' && renderer3dInstance && typeof renderer3dInstance.getGroundMovementBasis === 'function') {
        let basis = renderer3dInstance.getGroundMovementBasis();
        let moveX = 0;
        let moveY = 0;
        if (keysDown['arrowup'] || keysDown['w']) {
            moveX += basis.forwardX;
            moveY += basis.forwardZ;
        }
        if (keysDown['arrowdown'] || keysDown['s']) {
            moveX -= basis.forwardX;
            moveY -= basis.forwardZ;
        }
        if (keysDown['arrowright'] || keysDown['d']) {
            moveX += basis.rightX;
            moveY += basis.rightZ;
        }
        if (keysDown['arrowleft'] || keysDown['a']) {
            moveX -= basis.rightX;
            moveY -= basis.rightZ;
        }
        if (moveX !== 0 || moveY !== 0) {
            let moveLen = Math.hypot(moveX, moveY) || 1;
            camera.x += moveX / moveLen * speed;
            camera.y += moveY / moveLen * speed;
        }
    } else {
        if (keysDown['arrowup'] || keysDown['w']) camera.y -= speed;
        if (keysDown['arrowdown'] || keysDown['s']) camera.y += speed;
        if (keysDown['arrowleft'] || keysDown['a']) camera.x -= speed;
        if (keysDown['arrowright'] || keysDown['d']) camera.x += speed;
    }

    clampCamera();
}

// ============================================================


// ============================================================
// GAME INIT & MAIN LOOP
// ============================================================
function startGame() {
    document.getElementById('lobby').style.display = 'none';
    let go = document.getElementById('game-over');
    if (go) go.style.display = 'none';

    loadUiSettingsFromStorage();
    updateBuildPlacementModeButton();

    rebuildPrecomputedStatsMap();

    resetWorldState();

    mapAlerts = [];
    controlGroupAlertState = {};
    controlGroups = {};
    popupControlGroups = {};
    activePopupControlGroupKey = '';
    localDefeated = false;
    spectateMode = 'none';
    resignedTeams = new Set();
    graphMetric = 'units';
    gameStatsHistory = [];
    researchPanelOpenState = {};
    researchQueuePanelOpenState = {};

    for (let p of players) {
        p.energy = STARTING_MONEY;
        p.astar = STARTING_ASTAR;
        p.popCount = 0;
        p.researchLevels = {};
        p.researchMultipliers = {};
        p.researchQueue = [];
        p.researchTask = null;
    }

    rng = mulberry32(gameSeed);
    visualRng = mulberry32(gameSeed ^ 0xDEADBEEF); // separate RNG for visual effects
    generateAreas();
    let teams = (activeTeamIds && activeTeamIds.length > 0) ? activeTeamIds : [0, 1];
    let spawns = pickPlayerSpawns(teams.length);
    generateResourceMinesMixed(spawns);

    let teamBuilderSpawners = {};
    let teamHealerSpawners = {};
    let teamCollectorSpawners = {};
    let teamResearchSpawners = {};
    let teamSpawnPos = {};
    let teamStarterSpawnState = {};

    startingResourcesConfig = normalizeStartingResourcesConfig(startingResourcesConfig);

    let findStarterBuildSpot = (origin, maxRadius = 12) => {
        for (let r = 1; r <= maxRadius; r++) {
            for (let dy = -r; dy <= r; dy++) {
                for (let dx = -r; dx <= r; dx++) {
                    let fx = origin.gx + dx, fy = origin.gy + dy;
                    if (fx < 0 || fx >= GRID_W || fy < 0 || fy >= GRID_H) continue;
                    if (Math.abs(dx) + Math.abs(dy) > r) continue;
                    let cell = grid[fy][fx];
                    if (!cell || cell.type === TYPE_WALL || cell.item) continue;
                    let blockedByMine = !!getGoldMineAt(fx, fy) || !!getAstarMineAt(fx, fy);
                    if (blockedByMine) continue;
                    return { gx: fx, gy: fy };
                }
            }
        }
        return null;
    };

    let applyWorkerDefaults = (u) => {
        if (!u) return;
        if (u.unitType === 'collector') {
            u.workerState = 'IDLE'; u.workerType = 'collector'; u.carryingValue = 0; _clearWorkerTarget(u);
        } else if (u.unitType === 'astar_collector') {
            u.workerState = 'IDLE'; u.workerType = 'astar_collector'; u.carryingValue = 0; _clearWorkerTarget(u);
        } else if (u.unitType === 'salvager_unit') {
            u.workerState = 'IDLE'; u.workerType = 'salvager'; u.carryingValue = 0; _clearWorkerTarget(u);
        } else if (u.unitType === 'builder_unit') {
            u.workerState = 'IDLE'; u.workerType = 'builder'; u.carryingValue = 0; _clearWorkerTarget(u); u.builderHasMaterial = false;
        } else if (u.unitType === 'healer_unit') {
            u.workerState = 'IDLE'; u.workerType = 'healer'; u.carryingValue = 0; _clearWorkerTarget(u); u.healerHasMaterial = false;
        } else if (u.unitType === 'researcher_unit') {
            u.workerState = 'IDLE'; u.workerType = 'researcher'; u.carryingValue = 0; _clearWorkerTarget(u); u.researcherHasMaterial = false;
        }
    };

    let completeStarterBuilding = (item, itemKey, owner, level) => {
        if (!item) return;
        let lvl = Math.max(1, clampThingLevel(level || 1));
        let stacks = getRequiredStacksForLevel(lvl);
        item.stacks = stacks;
        item.effectiveStacks = stacks;
        item.level = lvl;
        item.effectiveLevel = lvl;
        item.potentialEffectiveLevel = lvl;
        item.underConstruction = false;
        item.isUpgrading = false;

        if (item instanceof Tower) {
            item.updateStats();
        } else {
            let calcType = itemKey;
            if (item.type === 'barrack') calcType = `barrack_${item.unitType}`;
            let stats = calculateItemStats(calcType, lvl, owner);
            if (Number.isFinite(stats.maxEnergy)) {
                item.maxEnergy = Math.max(1, Math.floor(stats.maxEnergy));
                item.energy = item.maxEnergy;
            }
            if (Number.isFinite(stats.damage)) item.damage = stats.damage;
            if (item.spawnCooldown !== undefined) {
                let fallbackType = getSpawnerFallbackUnitType(item);
                let buildingKey = (item.type === 'barrack') ? `barrack_${item.unitType}` : item.type;
                item.spawnCooldown = Math.round(getBarrackSpawnCooldown(fallbackType, lvl, owner, buildingKey) * TICK_RATE);
            }
        }
        updateItemTextCache(item);
    };

    let getPlacedBuildingEntityAt = (gx, gy, itemKey, owner) => {
        if ((BASE_CARD_TYPES[itemKey] || {}).target === 'wall') {
            let t = getTowerAtTile(gx, gy);
            return (t && t.owner === owner && t.type === itemKey) ? t : null;
        }
        if (itemKey.startsWith('barrack_')) {
            let unitType = (BASE_CARD_TYPES[itemKey] || {}).unitType || 'norm';
            let b = getBarrackAtTile(gx, gy);
            return (b && b.owner === owner && b.unitType === unitType) ? b : null;
        }
        if (itemKey === 'spawner' || itemKey === 'salvager' || itemKey === 'builder_spawner' || itemKey === 'healer_spawner' || itemKey === 'research') {
            let s = getSpawnerAtTile(gx, gy);
            return (s && s.owner === owner && s.type === itemKey) ? s : null;
        }
        return (grid[gy] && grid[gy][gx]) ? grid[gy][gx].item : null;
    };

    let spawnStartingBuilding = (pid, origin, itemKey, level) => {
        let spot = findStarterBuildSpot(origin, 16);
        if (!spot) return null;
        let ok = placeBuilding(spot.gx, spot.gy, itemKey, pid, { autoUpgradeEnabled: true, buildEnabled: true, silent: true });
        if (!ok) return null;
        let placed = getPlacedBuildingEntityAt(spot.gx, spot.gy, itemKey, pid);
        if (!placed) return null;
        completeStarterBuilding(placed, itemKey, pid, level);
        return placed;
    };

    let buildStarterUnitSpawnTilesBfs = (origin, maxRadius = 24) => {
        let out = [];
        let q = [];
        let seen = new Set();
        let startGx = Math.max(0, Math.min(GRID_W - 1, Math.floor(origin.gx)));
        let startGy = Math.max(0, Math.min(GRID_H - 1, Math.floor(origin.gy)));
        q.push({ gx: startGx, gy: startGy });
        seen.add(startGy * GRID_W + startGx);

        while (q.length > 0) {
            let cur = q.shift();
            let gx = cur.gx, gy = cur.gy;
            let md = Math.abs(gx - startGx) + Math.abs(gy - startGy);
            if (md > maxRadius) continue;

            let cell = (grid[gy] && grid[gy][gx]) ? grid[gy][gx] : null;
            let isFloorTile = !!cell && cell.type !== TYPE_WALL;
            let isFreeTile = isFloorTile && !cell.item && !getGoldMineAt(gx, gy);
            if (isFreeTile) out.push({ gx, gy });

            if (!isFloorTile) continue;
            let n0 = gx + 1, n1 = gx - 1, n2 = gy + 1, n3 = gy - 1;
            if (n0 < GRID_W) {
                let k = gy * GRID_W + n0;
                if (!seen.has(k)) { seen.add(k); q.push({ gx: n0, gy }); }
            }
            if (n1 >= 0) {
                let k = gy * GRID_W + n1;
                if (!seen.has(k)) { seen.add(k); q.push({ gx: n1, gy }); }
            }
            if (n2 < GRID_H) {
                let k = n2 * GRID_W + gx;
                if (!seen.has(k)) { seen.add(k); q.push({ gx, gy: n2 }); }
            }
            if (n3 >= 0) {
                let k = n3 * GRID_W + gx;
                if (!seen.has(k)) { seen.add(k); q.push({ gx, gy: n3 }); }
            }
        }

        if (out.length <= 0) {
            let fallback = findNearestWalkable(startGx, startGy, startGx, startGy);
            out.push({ gx: fallback.x, gy: fallback.y });
        }
        return out;
    };

    let getNextStarterUnitSpawnTile = (pid, origin) => {
        let state = teamStarterSpawnState[pid];
        if (!state) {
            state = {
                tiles: buildStarterUnitSpawnTilesBfs(origin),
                cursor: 0
            };
            teamStarterSpawnState[pid] = state;
        }
        if (!state.tiles || state.tiles.length <= 0) {
            let fallback = findNearestWalkable(origin.gx, origin.gy, origin.gx, origin.gy);
            return { gx: fallback.x, gy: fallback.y };
        }
        let idx = state.cursor % state.tiles.length;
        let tile = state.tiles[idx];
        state.cursor = (idx + 1) % state.tiles.length;
        return tile;
    };

    let spawnStartingUnit = (pid, origin, unitType, level) => {
        let spawnTile = getNextStarterUnitSpawnTile(pid, origin);
        let u = new Unit(unitType, pid, spawnTile.gx * TILE + 16, spawnTile.gy * TILE + 16);
        applyWorkerDefaults(u);
        applyUnitLevelScaling(u, Math.max(1, clampThingLevel(level || 1)));
        u.energy = u.maxEnergy;
        units.push(u);
        players[pid].popCount++;
        return u;
    };

    for (let pid of teams) {
        let researchByThing = startingResourcesConfig.researchLevels || {};
        for (let thingId in researchByThing) {
            let parsed = parseStartingThingId(thingId);
            if (!parsed) continue;
            let levelMap = researchByThing[thingId];
            if (!levelMap || typeof levelMap !== 'object') continue;
            for (let statKey in levelMap) {
                if (!getResearchStatEntry(parsed.kind, parsed.key, statKey)) continue;
                let lvl = Math.max(0, Math.min(MAX_RESEARCH_LEVEL, Math.floor(Number(levelMap[statKey]) || 0)));
                if (lvl <= 0) continue;
                let id = makeResearchLevelId(parsed.kind, parsed.key, statKey);
                players[pid].researchLevels[id] = lvl;
                players[pid].researchMultipliers[id] = Math.pow(getResearchBonusExpForStat(parsed.kind, statKey), lvl);
            }
        }
    }

    for (let i = 0; i < teams.length; i++) {
        let pid = teams[i];
        let pos = spawns[i] || spawns[0];
        teamSpawnPos[pid] = pos;

        let builderSpawner = new BuilderSpawner(pos.gx, pos.gy, pid);
        completeStarterBuilding(builderSpawner, 'builder_spawner', pid, 1);
        teamBuilderSpawners[pid] = builderSpawner;
        collectorSpawners.push(builderSpawner);
        grid[pos.gy][pos.gx].item = builderSpawner;
        grid[pos.gy][pos.gx].owner = pid;
        setTileEntity(pos.gx, pos.gy, 'builder_spawner', builderSpawner);

        let healerSpawner = spawnStartingBuilding(pid, pos, 'healer_spawner', 1);
        if (healerSpawner) teamHealerSpawners[pid] = healerSpawner;

        let collectorSpawner = spawnStartingBuilding(pid, pos, 'spawner', 1);
        if (collectorSpawner) teamCollectorSpawners[pid] = collectorSpawner;

        let researchSpawner = spawnStartingBuilding(pid, pos, 'research', 1);
        if (researchSpawner) teamResearchSpawners[pid] = researchSpawner;

        spawnStartingBuilding(pid, pos, 'house', 6);
        spawnStartingBuilding(pid, pos, 'house', 6);
        // spawnStartingBuilding(pid, pos, 'house', 4);
    }

    recomputePlayerPopCaps();

    for (let pid of teams) {
        let pos = teamSpawnPos[pid];
        let builderSpawner = teamBuilderSpawners[pid];
        let healerSpawner = teamHealerSpawners[pid];
        let collectorSpawner = teamCollectorSpawners[pid];
        let researchSpawner = teamResearchSpawners[pid];

        for (let i = 0; i < 3; i++) {
            let u = spawnStartingUnit(pid, pos, 'builder_unit', builderSpawner ? getThingEffectiveLevel(builderSpawner) : 1);
            if (u && builderSpawner && builderSpawner.getBuilderDps) u.builderDps = builderSpawner.getBuilderDps();
        }
        for (let i = 0; i < 3; i++) {
            let u = spawnStartingUnit(pid, pos, 'healer_unit', healerSpawner ? getThingEffectiveLevel(healerSpawner) : 1);
            if (u && healerSpawner && healerSpawner.gethealerDps) u.healerDps = healerSpawner.gethealerDps();
        }

        // Requested starter replacements: give each team one collector + one researcher.
        spawnStartingUnit(pid, pos, 'collector', collectorSpawner ? getThingEffectiveLevel(collectorSpawner) : 1);
        let starterResearcher = spawnStartingUnit(pid, pos, 'researcher_unit', researchSpawner ? getThingEffectiveLevel(researchSpawner) : 1);
        if (starterResearcher && researchSpawner && researchSpawner.getResearcherDps) starterResearcher.researcherDps = researchSpawner.getResearcherDps();
    }

    for (let pid of teams) {
        let pos = teamSpawnPos[pid];
        let spawnByThing = startingResourcesConfig.spawnCounts || {};
        for (let thingId in spawnByThing) {
            let parsed = parseStartingThingId(thingId);
            if (!parsed) continue;
            let levelMap = spawnByThing[thingId];
            if (!levelMap || typeof levelMap !== 'object') continue;
            for (let levelText in levelMap) {
                let lvl = Math.max(1, Math.min(MAX_THING_LEVEL, Math.floor(Number(levelText) || 1)));
                let count = Math.max(0, Math.min(1000, Math.floor(Number(levelMap[levelText]) || 0)));
                for (let i = 0; i < count; i++) {
                    if (parsed.kind === 'building') {
                        spawnStartingBuilding(pid, pos, parsed.key, lvl);
                    } else {
                        spawnStartingUnit(pid, pos, parsed.key, lvl);
                    }
                }
            }
        }
    }

    // Spawn kings for each team
    for (let pid of teams) {
        let pos = teamSpawnPos[pid];
        let king = spawnStartingUnit(pid, pos, 'king', 1);
        if (king) applyUnitLevelScaling(king, 1);
    }

    // Center camera on own base
    let localSpawn = teamSpawnPos[localPlayerId] || spawns[0];
    camera.x = localSpawn.gx * TILE - viewW / 2;
    camera.y = localSpawn.gy * TILE - viewH / 2;
    clampCamera();

    recalculateAdjacency();
    dirtyGrid = true; dirtyAreas = true;
    gameStarted = true;
    requestBuildMenuRefresh();
    updateControlGroupBar();
    startBackgroundMusic();

    if (isMultiplayer) {
        lockstepLocalPacketByTick = {};
        lockstepHostPacketsByTick = {};
        lockstepBundleByTick = {};
        lockstepPendingBundleByTick = {};
        lockstepPendingBundleAckByTick = {};
        lockstepPendingCommitByTick = {};
        lockstepCommittedByTick = {};
        lockstepBundleAckByTick = {};
        lockstepLastPacketSentAtByTick = {};
        lockstepLastBundleSentAtByTick = {};
        lockstepLastFinalizeSentAtByTick = {};
        lockstepLastResendRequestAtByTick = {};
        lockstepLastHardResyncRequestAt = 0;
        lockstepExpectedStateHashByTick = {};
        lockstepLocalStateHashByTick = {};
        lockstepExpectedStateDigestByTick = {};
        lockstepLocalStateDigestByTick = {};
        lockstepDesyncDetected = false;
    }

    // Start unified game loop
    _lastTickTime = performance.now();
    _tickAccumulator = 0;
    _tpsTickCount = 0;
    _tpsDisplay = 0;
    _tpsLastTime = _lastTickTime;
    startMainThreadLoops();
}

let _lastTickTime = 0;
let _tickAccumulator = 0;
let _simulationFrameHandle = 0;
let _renderFrameHandle = 0;

function stableSerializeForLockstep(v) {
    if (v === null || v === undefined) return 'null';
    if (typeof v === 'number' || typeof v === 'boolean') return JSON.stringify(v);
    if (typeof v === 'string') return JSON.stringify(v);
    if (Array.isArray(v)) return '[' + v.map(stableSerializeForLockstep).join(',') + ']';
    if (typeof v === 'object') {
        let keys = Object.keys(v).sort();
        return '{' + keys.map(k => JSON.stringify(k) + ':' + stableSerializeForLockstep(v[k])).join(',') + '}';
    }
    return JSON.stringify(String(v));
}

function normalizeLockstepPayload(v) {
    if (v === null || v === undefined) return null;
    let t = typeof v;
    if (t === 'number') return Number.isFinite(v) ? v : null;
    if (t === 'string' || t === 'boolean') return v;
    if (Array.isArray(v)) return v.map(normalizeLockstepPayload);
    if (t === 'object') {
        let out = {};
        for (let k of Object.keys(v)) {
            let vv = v[k];
            if (vv === undefined || typeof vv === 'function' || typeof vv === 'symbol') continue;
            out[k] = normalizeLockstepPayload(vv);
        }
        return out;
    }
    return null;
}

function hashStringLockstep(s) {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(16).padStart(8, '0');
}

function computeTickPacketChecksum(tick, peerId, teamId, actions) {
    return hashStringLockstep(stableSerializeForLockstep({
        tick: Math.floor(tick),
        peerId: String(peerId || ''),
        teamId: Math.floor(Number(teamId) || 0),
        actions: Array.isArray(actions) ? actions : []
    }));
}

function computeTickBundleChecksum(tick, packets) {
    let sorted = (Array.isArray(packets) ? packets : [])
        .map(p => ({
            tick: Math.floor(Number(p.tick) || 0),
            peerId: String(p.peerId || ''),
            teamId: Math.floor(Number(p.teamId) || 0),
            actions: Array.isArray(p.actions) ? p.actions : [],
            checksum: String(p.checksum || '')
        }))
        .sort((a, b) => a.peerId.localeCompare(b.peerId));
    return hashStringLockstep(stableSerializeForLockstep({ tick: Math.floor(tick), packets: sorted }));
}

function logLockstepWarning(reason, details = {}) {
    try {
        console.warn('[LOCKSTEP]', reason, details);
    } catch { }
}

function isPeerExplicitlyRemoved(peerId) {
    let pid = String(peerId || '').trim();
    return !!pid && removedFromMatchPeerIds.has(pid);
}

function markPeerRemovedFromMatch(peerId) {
    let pid = String(peerId || '').trim();
    if (!pid) return;
    removedFromMatchPeerIds.add(pid);
    try { lockstepTickPacketsByPeer.delete(pid); } catch { }
    try { lockstepBundlePendingAcksByPeer.delete(pid); } catch { }
    try { remoteInputBuffer.delete(pid); } catch { }
    try {
        for (let [tick, waitingSet] of lockstepWaitingPeersByTick.entries()) {
            if (waitingSet && waitingSet.delete(pid) && waitingSet.size <= 0) {
                lockstepWaitingPeersByTick.delete(tick);
            }
        }
    } catch { }
}

function clearPeerRemovedFromMatch(peerId) {
    let pid = String(peerId || '').trim();
    if (!pid) return;
    removedFromMatchPeerIds.delete(pid);
}

function hostRemovePlayerFromMatch(peerId) {
    let pid = String(peerId || '').trim();
    if (!isHost || !pid || pid === myPeerId) return;
    let teamId = getTeamIdForPeer(pid);
    let uid = getPeerProfileUid(pid);
    markPeerRemovedFromMatch(pid);
    delete matchRoleByPeerId[pid];
    if (uid) delete matchRoleByUid[uid];
    delete peerUidByPeerId[pid];
    lobbyPlayers = lobbyPlayers.filter(p => p && p.peerId !== pid);
    matchStartLobbyPlayers = matchStartLobbyPlayers.filter(p => p && p.peerId !== pid);
    peerPresenceById[pid] = false;
    connections
        .filter(c => c && c.peer === pid)
        .forEach(c => {
            try { c.send({ type: 'PLAYER_REMOVED_FROM_MATCH', peerId: pid, teamId }); } catch { }
            try { c.close(); } catch { }
        });
    if (teamId >= 0 && !resignedTeams.has(teamId)) {
        queueAction({ action: 'forceResignTeam', targetTeam: teamId });
    }
    broadcastLobbyState();
    renderOnlineLobby();
    updateInfoPanel();
}

function scheduleGuestAutoReconnect(reason = 'Connection lost') {
    if (isHost || !isMultiplayer || !gameStarted || !wsHostId) return;
    if (duplicateUidBlocked) return;
    if (isPeerExplicitlyRemoved(myPeerId)) return;
    if (guestReconnectTimer) return;
    let st = document.getElementById('lobby-status');
    if (st) {
        st.textContent = `${reason}. Reconnecting...`;
        st.style.color = '#fa4';
    }
    let waitMs = Math.min(4000, 700 + guestReconnectAttempt * 700);
    guestReconnectTimer = setTimeout(() => {
        guestReconnectTimer = null;
        guestReconnectAttempt++;
        joinGame(wsHostId, { rejoin: true });
    }, waitMs);
}

function getActiveMatchPeerIds() {
    if (gameStarted) {
        let ids = [];
        for (let pid of Object.keys(matchRoleByPeerId || {})) {
            if (normalizeMatchRole(matchRoleByPeerId[pid], '') !== 'playing') continue;
            if (isPeerExplicitlyRemoved(pid)) continue;
            ids.push(pid);
        }
        if (myPeerId && !ids.includes(myPeerId) && !isPeerExplicitlyRemoved(myPeerId)) {
            ids.push(myPeerId);
        }
        if (ids.length > 0) {
            ids.sort();
            return ids;
        }
    }
    let ids = [];
    for (let lp of (lobbyPlayers || [])) {
        if (!lp || !lp.peerId) continue;
        if (isPeerExplicitlyRemoved(lp.peerId)) continue;
        ids.push(lp.peerId);
    }
    if (myPeerId && !ids.includes(myPeerId)) ids.push(myPeerId);
    ids.sort();
    return ids;
}

function buildLocalTickPacket(tick) {
    let t = Math.floor(Number(tick));
    if (!Number.isFinite(t) || t < 0 || !myPeerId) return null;
    let actions = (localInputBuffer[t] || []).map(a => normalizeLockstepPayload({ ...a, teamId: localPlayerId }));
    let packet = {
        tick: t,
        peerId: myPeerId,
        teamId: localPlayerId,
        actions
    };
    packet = normalizeLockstepPayload(packet) || packet;
    packet.checksum = computeTickPacketChecksum(packet.tick, packet.peerId, packet.teamId, packet.actions);
    lockstepLocalPacketByTick[t] = packet;
    return packet;
}

function validateTickPacket(packet) {
    if (!packet || typeof packet !== 'object') return false;
    let t = Math.floor(Number(packet.tick));
    if (!Number.isFinite(t) || t < 0) return false;
    let peerId = String(packet.peerId || '');
    if (!peerId) return false;
    let teamId = Math.floor(Number(packet.teamId) || 0);
    let actions = Array.isArray(packet.actions) ? packet.actions : [];
    let expected = computeTickPacketChecksum(t, peerId, teamId, actions);
    return String(packet.checksum || '') === expected;
}

function validateTickBundle(bundle) {
    if (!bundle || typeof bundle !== 'object') return false;
    let t = Math.floor(Number(bundle.tick));
    if (!Number.isFinite(t) || t < 0) return false;
    let packets = Array.isArray(bundle.packets) ? bundle.packets : [];
    for (let p of packets) {
        if (!validateTickPacket(p)) return false;
    }
    let expected = computeTickBundleChecksum(t, packets);
    return String(bundle.combinedChecksum || '') === expected;
}

function sendLocalTickPacket(tick, force = false) {
    if (!isMultiplayer || connections.length === 0) return;
    let t = Math.floor(Number(tick));
    if (!Number.isFinite(t) || t < 0) return;
    let now = performance.now();
    if (!force && lockstepLastPacketSentAtByTick[t] && (now - lockstepLastPacketSentAtByTick[t]) < LOCKSTEP_PACKET_RESEND_MS) return;
    let packet = lockstepLocalPacketByTick[t] || buildLocalTickPacket(t);
    if (!packet) return;
    connections.forEach(c => c.send({ type: 'TICK_PACKET', packet }));
    lockstepLastPacketSentAtByTick[t] = now;
    if (isHost) {
        if (!lockstepHostPacketsByTick[t]) lockstepHostPacketsByTick[t] = {};
        lockstepHostPacketsByTick[t][myPeerId] = packet;
    }
}

function sendLocalTickPacketWindow(tick, force = false) {
    let baseTick = Math.floor(Number(tick));
    if (!Number.isFinite(baseTick) || baseTick < 0) return;
    let endTick = baseTick + LOCKSTEP_PIPELINE_TICKS;
    for (let t = baseTick; t <= endTick; t++) {
        sendLocalTickPacket(t, force);
    }
}

function handleIncomingTickPacket(conn, data) {
    if (!isHost) return;
    let packet = data && data.packet ? data.packet : null;
    if (!packet || typeof packet !== 'object') return;
    let connPeerId = String((conn && conn.peer) || '');
    packet.peerId = connPeerId || String(packet.peerId || '');
    packet.tick = Math.floor(Number(packet.tick));
    if (!Number.isFinite(packet.tick) || packet.tick < 0 || !packet.peerId) return;
    packet.teamId = Math.floor(Number(packet.teamId) || 0);
    packet.actions = Array.isArray(packet.actions) ? packet.actions.map(a => normalizeLockstepPayload(a)) : [];
    packet = normalizeLockstepPayload(packet) || packet;

    if (!validateTickPacket(packet)) {
        logLockstepWarning('Packet checksum mismatch; requesting resend', {
            tick: packet.tick,
            packetPeerId: packet.peerId,
            fromPeer: connPeerId || null
        });
        conn.send({ type: 'TICK_RESEND_REQUEST', tick: packet.tick, packetPeerId: packet.peerId });
        return;
    }

    if (lockstepCommittedByTick[packet.tick] || lockstepBundleByTick[packet.tick]) {
        // This tick is already sealed by the host; late packet updates must be ignored.
        return;
    }

    let setup = computeTeamSetupFromLobby();
    let enforcedTeamId = setup.teamByPeer[packet.peerId] ?? packet.teamId;
    if (packet.teamId !== enforcedTeamId || packet.actions.some(a => Math.floor(Number(a && a.teamId) || 0) !== enforcedTeamId)) {
        packet.teamId = enforcedTeamId;
        packet.actions = packet.actions.map(a => normalizeLockstepPayload({ ...(a || {}), teamId: enforcedTeamId }));
        packet.checksum = computeTickPacketChecksum(packet.tick, packet.peerId, packet.teamId, packet.actions);
    }

    if (!lockstepHostPacketsByTick[packet.tick]) lockstepHostPacketsByTick[packet.tick] = {};
    lockstepHostPacketsByTick[packet.tick][packet.peerId] = packet;
}

function maybeBuildHostBundle(tick) {
    if (!isHost) return null;
    let t = Math.floor(Number(tick));
    if (!Number.isFinite(t) || t < 0) return null;
    if (!lockstepHostPacketsByTick[t]) lockstepHostPacketsByTick[t] = {};
    if (myPeerId && !lockstepHostPacketsByTick[t][myPeerId]) {
        let own = lockstepLocalPacketByTick[t] || buildLocalTickPacket(t);
        if (own) lockstepHostPacketsByTick[t][myPeerId] = own;
    }

    let participants = getActiveMatchPeerIds();
    let pmap = lockstepHostPacketsByTick[t];
    if (!participants.every(pid => !!pmap[pid])) return null;

    let packets = participants.map(pid => pmap[pid]).sort((a, b) => String(a.peerId).localeCompare(String(b.peerId)));
    let combinedChecksum = computeTickBundleChecksum(t, packets);
    let bundle = { tick: t, packets, combinedChecksum };
    lockstepBundleByTick[t] = bundle;

    if (!lockstepBundleAckByTick[t]) lockstepBundleAckByTick[t] = {};
    if (myPeerId) lockstepBundleAckByTick[t][myPeerId] = true;
    return bundle;
}

function sendHostBundle(tick, force = false) {
    if (!isHost || connections.length === 0) return;
    let t = Math.floor(Number(tick));
    if (!Number.isFinite(t) || t < 0) return;
    let bundle = lockstepBundleByTick[t] || maybeBuildHostBundle(t);
    if (!bundle) return;
    let now = performance.now();
    if (!force && lockstepLastBundleSentAtByTick[t] && (now - lockstepLastBundleSentAtByTick[t]) < LOCKSTEP_BUNDLE_RESEND_MS) return;
    connections.forEach(c => c.send({ type: 'TICK_BUNDLE', bundle }));
    lockstepLastBundleSentAtByTick[t] = now;
}

function maybeCommitHostTick(tick) {
    if (!isHost) return false;
    let t = Math.floor(Number(tick));
    if (!Number.isFinite(t) || t < 0) return false;
    if (lockstepCommittedByTick[t]) return true;
    let bundle = lockstepBundleByTick[t];
    if (!bundle) return false;
    lockstepCommittedByTick[t] = true;
    connections.forEach(c => c.send({ type: 'TICK_COMMIT', tick: t, combinedChecksum: bundle.combinedChecksum }));
    return true;
}

function sendHostFinalize(tick, force = false) {
    if (!isHost || connections.length === 0) return;
    let t = Math.floor(Number(tick));
    if (!Number.isFinite(t) || t < 0) return;
    let resend = getHostResendBundleForTick(t);
    if (!resend || !resend.bundle || !resend.committed) return;
    let now = performance.now();
    if (!force && lockstepLastFinalizeSentAtByTick[t] && (now - lockstepLastFinalizeSentAtByTick[t]) < LOCKSTEP_BUNDLE_RESEND_MS) return;
    connections.forEach(c => {
        c.send({ type: 'TICK_BUNDLE', bundle: resend.bundle });
        c.send({ type: 'TICK_COMMIT', tick: t, combinedChecksum: resend.bundle.combinedChecksum });
    });
    lockstepLastFinalizeSentAtByTick[t] = now;
}

function handleIncomingTickBundle(conn, data) {
    if (isHost) return;
    let bundle = data && data.bundle ? data.bundle : null;
    if (!bundle || typeof bundle !== 'object') return;
    let t = Math.floor(Number(bundle.tick));
    if (!Number.isFinite(t) || t < 0) return;
    bundle.tick = t;
    lockstepPendingBundleByTick[t] = bundle;
}

function handleIncomingTickBundleAck(conn, data) {
    if (!isHost) return;
    let t = Math.floor(Number(data && data.tick));
    if (!Number.isFinite(t) || t < 0 || !conn || !conn.peer) return;
    let bundle = lockstepBundleByTick[t];
    if (!bundle) return;
    if (String(data.combinedChecksum || '') !== String(bundle.combinedChecksum || '')) {
        logLockstepWarning('Bundle ACK checksum mismatch; resending bundle', {
            tick: t,
            peerId: conn.peer,
            expected: String(bundle.combinedChecksum || ''),
            received: String(data.combinedChecksum || '')
        });
        conn.send({ type: 'TICK_BUNDLE', bundle });
        return;
    }
    if (!lockstepBundleAckByTick[t]) lockstepBundleAckByTick[t] = {};
    lockstepBundleAckByTick[t][conn.peer] = true;
}

function handleIncomingTickCommit(conn, data) {
    if (isHost) return;
    let t = Math.floor(Number(data && data.tick));
    if (!Number.isFinite(t) || t < 0) return;
    lockstepPendingCommitByTick[t] = String(data.combinedChecksum || '');
}

function quantizeLockstepNumber(v) {
    let n = Number(v);
    if (!Number.isFinite(n)) return 0;
    return Math.round(n * 1000) / 1000;
}

function computeLockstepStateDigest(tick) {
    let t = Math.floor(Number(tick));
    let computePopCapFromGrid = (pid) => {
        let owner = Math.floor(Number(pid) || 0);
        let cfgCap = Math.max(1, Math.floor(CONFIG_MAX_POP || 200));
        let housePop = 0;
        for (let gy = 0; gy < GRID_H; gy++) {
            for (let gx = 0; gx < GRID_W; gx++) {
                let cell = grid[gy] && grid[gy][gx];
                let item = cell ? cell.item : null;
                if (!item || item.type !== 'house' || Math.floor(Number(cell.owner) || 0) !== owner) continue;
                if (!(Number(item.energy) > 0) || !!item.underConstruction) continue;
                let lvl = Math.max(1, Math.floor(getDisplayLevel(item) || 1));
                housePop += getHousePopCapContribution(owner, lvl);
            }
        }
        return Math.min(cfgCap, housePop);
    };

    let digest = {
        tick: Number.isFinite(t) ? t : currentTick,
        gameTime,
        players: players.map((p, idx) => ({
            idx,
            money: quantizeLockstepNumber(p && p.money),
            popCount: Math.floor(Number((p && p.popCount) || 0)),
            popCap: Math.floor(Number(computePopCapFromGrid(idx) || 0))
        })),
        units: units
            .filter(u => u && !u.dead)
            .map(u => ({
                id: Math.floor(Number(u.id) || 0),
                owner: Math.floor(Number(u.owner) || 0),
                type: String(u.unitType || ''),
                x: quantizeLockstepNumber(u.x),
                y: quantizeLockstepNumber(u.y),
                energy: quantizeLockstepNumber(u.energy),
                cmd: Math.floor(Number(u.commandState) || 0),
                workerState: String(u.workerState || ''),
                workerType: String(u.workerType || ''),
                stack: Math.floor(Number(u.stackCount || 1))
            }))
            .sort((a, b) => a.id - b.id),
        towers: towers
            .filter(tw => !!tw)
            .map(tw => ({
                gx: Math.floor(Number(tw.gx) || 0),
                gy: Math.floor(Number(tw.gy) || 0),
                owner: Math.floor(Number(tw.owner) || 0),
                type: String(tw.type || ''),
                level: Math.floor(Number(tw.level) || 1),
                energy: quantizeLockstepNumber(tw.energy),
                underConstruction: !!tw.underConstruction,
                isUpgrading: !!tw.isUpgrading
            }))
            .sort((a, b) => (a.gy - b.gy) || (a.gx - b.gx) || (a.owner - b.owner)),
        barracks: barracks
            .filter(b => !!b)
            .map(b => ({
                gx: Math.floor(Number(b.gx) || 0),
                gy: Math.floor(Number(b.gy) || 0),
                owner: Math.floor(Number(b.owner) || 0),
                unitType: String(b.unitType || ''),
                level: Math.floor(Number(b.level) || 1),
                energy: quantizeLockstepNumber(b.energy),
                queueLen: Array.isArray(b.spawnQueue) ? b.spawnQueue.length : 0,
                underConstruction: !!b.underConstruction,
                isUpgrading: !!b.isUpgrading
            }))
            .sort((a, b) => (a.gy - b.gy) || (a.gx - b.gx) || (a.owner - b.owner)),
        spawners: collectorSpawners
            .filter(s => !!s)
            .map(s => ({
                gx: Math.floor(Number(s.gx) || 0),
                gy: Math.floor(Number(s.gy) || 0),
                owner: Math.floor(Number(s.owner) || 0),
                type: String(s.type || ''),
                level: Math.floor(Number(s.level) || 1),
                energy: quantizeLockstepNumber(s.energy),
                queueLen: Array.isArray(s.spawnQueue) ? s.spawnQueue.length : 0,
                underConstruction: !!s.underConstruction,
                isUpgrading: !!s.isUpgrading
            }))
            .sort((a, b) => (a.gy - b.gy) || (a.gx - b.gx) || (a.owner - b.owner)),
        floorItems: [],
        mines: goldMines
            .map(m => ({
                gx: Math.floor(Number(m.gx) || 0),
                gy: Math.floor(Number(m.gy) || 0),
                gold: Math.floor(Number(m.gold) || 0)
            }))
            .sort((a, b) => (a.gy - b.gy) || (a.gx - b.gx))
    };

    for (let gy = 0; gy < GRID_H; gy++) {
        for (let gx = 0; gx < GRID_W; gx++) {
            let cell = grid[gy][gx];
            if (!cell || !cell.item) continue;
            digest.floorItems.push({
                gx,
                gy,
                owner: Math.floor(Number(cell.owner) || 0),
                type: String(cell.item.type || ''),
                level: Math.floor(Number(cell.item.level) || 1),
                energy: quantizeLockstepNumber(cell.item.energy),
                underConstruction: !!cell.item.underConstruction,
                isUpgrading: !!cell.item.isUpgrading
            });
        }
    }

    return digest;
}

function summarizeLockstepDigestMismatch(expectedDigest, localDigest) {
    if (!expectedDigest || !localDigest) return null;
    let summary = {
        expectedTick: Math.floor(Number(expectedDigest.tick) || 0),
        localTick: Math.floor(Number(localDigest.tick) || 0),
        expectedGameTime: Math.floor(Number(expectedDigest.gameTime) || 0),
        localGameTime: Math.floor(Number(localDigest.gameTime) || 0),
        counts: {},
        firstDiff: {}
    };

    let keys = ['players', 'units', 'towers', 'barracks', 'spawners', 'floorItems', 'mines'];
    for (let key of keys) {
        let expArr = Array.isArray(expectedDigest[key]) ? expectedDigest[key] : [];
        let locArr = Array.isArray(localDigest[key]) ? localDigest[key] : [];
        summary.counts[key] = { expected: expArr.length, local: locArr.length };
        let n = Math.min(expArr.length, locArr.length);
        for (let i = 0; i < n; i++) {
            let es = stableSerializeForLockstep(expArr[i]);
            let ls = stableSerializeForLockstep(locArr[i]);
            if (es !== ls) {
                summary.firstDiff[key] = { index: i, expected: expArr[i], local: locArr[i] };
                break;
            }
        }
        if (!summary.firstDiff[key] && expArr.length !== locArr.length) {
            summary.firstDiff[key] = {
                index: n,
                expected: expArr[n] || null,
                local: locArr[n] || null
            };
        }
    }

    return summary;
}

function computeLockstepStateHash(tick) {
    let digest = computeLockstepStateDigest(tick);
    return hashStringLockstep(stableSerializeForLockstep(digest));
}

function maybeCompareLockstepStateHash(tick) {
    if (isHost || lockstepDesyncDetected) return;
    let t = Math.floor(Number(tick));
    if (!Number.isFinite(t) || t < 0) return;
    let expected = String(lockstepExpectedStateHashByTick[t] || '');
    let local = String(lockstepLocalStateHashByTick[t] || '');
    if (!expected || !local) return;

    let expectedDigest = lockstepExpectedStateDigestByTick[t] || null;
    let localDigest = lockstepLocalStateDigestByTick[t] || null;

    delete lockstepExpectedStateHashByTick[t];
    delete lockstepLocalStateHashByTick[t];
    delete lockstepExpectedStateDigestByTick[t];
    delete lockstepLocalStateDigestByTick[t];

    if (expected === local) return;

    let mismatchSummary = summarizeLockstepDigestMismatch(expectedDigest, localDigest);

    lockstepDesyncDetected = true;
    waitingForRemoteSince = performance.now();
    logLockstepWarning('State hash mismatch; pausing lockstep and requesting hard resync', {
        tick: t,
        expected,
        local,
        details: mismatchSummary
    });

    if (connections[0] && mismatchSummary) {
        connections[0].send({
            type: 'TICK_STATE_HASH_MISMATCH_REPORT',
            tick: t,
            expectedHash: expected,
            localHash: local,
            details: mismatchSummary
        });
    }

    if (connections[0]) {
        connections[0].send({ type: 'REQUEST_MATCH_SYNC', tick: t, reason: 'state hash mismatch' });
    }
}

function handleIncomingTickStateHash(conn, data) {
    if (isHost) return;
    let t = Math.floor(Number(data && data.tick));
    if (!Number.isFinite(t) || t < 0) return;
    lockstepExpectedStateHashByTick[t] = String(data.stateHash || '');
    if (data && data.stateDigest && typeof data.stateDigest === 'object') {
        lockstepExpectedStateDigestByTick[t] = data.stateDigest;
    }
    maybeCompareLockstepStateHash(t);
}

function maybeRequestHardLockstepResync(now, tick, reason = 'tick timeout') {
    if (isHost || !isMultiplayer || !gameStarted) return;
    let conn = connections[0];
    if (!conn) return;
    let t = Math.floor(Number(tick));
    if (!Number.isFinite(t) || t < 0) return;

    let startedAt = Number(waitingForRemoteSince) || 0;
    if (!startedAt) return;
    if ((now - startedAt) < LOCKSTEP_HARD_RESYNC_MS) return;

    let minGap = Math.max(LOCKSTEP_HARD_RESYNC_MS, 2500);
    if (lockstepLastHardResyncRequestAt && (now - lockstepLastHardResyncRequestAt) < minGap) return;

    lockstepLastHardResyncRequestAt = now;
    logLockstepWarning('Lockstep stalled; requesting full match sync', {
        tick: t,
        waitMs: Math.round(now - startedAt),
        reason
    });
    conn.send({ type: 'REQUEST_MATCH_SYNC', tick: t, reason: String(reason || 'tick timeout') });
}

function processDeferredGuestLockstepWindow(now, tick) {
    if (isHost) return;
    let baseTick = Math.floor(Number(tick));
    if (!Number.isFinite(baseTick) || baseTick < 0) return;
    let endTick = baseTick + LOCKSTEP_PIPELINE_TICKS;

    for (let t = baseTick; t <= endTick; t++) {
        let pendingBundle = lockstepPendingBundleByTick[t];
        if (pendingBundle) {
            if (!validateTickBundle(pendingBundle)) {
                let lastReq = lockstepLastResendRequestAtByTick[t] || 0;
                if ((now - lastReq) >= LOCKSTEP_RESEND_REQUEST_MS && connections[0]) {
                    logLockstepWarning('Bundle checksum mismatch; requesting resend', {
                        tick: t,
                        combinedChecksum: String(pendingBundle.combinedChecksum || '')
                    });
                    connections[0].send({ type: 'TICK_RESEND_REQUEST', tick: t });
                    lockstepLastResendRequestAtByTick[t] = now;
                }
                delete lockstepPendingBundleByTick[t];
            } else {
                lockstepBundleByTick[t] = pendingBundle;
                lockstepPendingBundleAckByTick[t] = String(pendingBundle.combinedChecksum || '');
                delete lockstepPendingBundleByTick[t];
            }
        }

        if (lockstepPendingBundleAckByTick[t] && connections[0]) {
            connections[0].send({ type: 'TICK_BUNDLE_ACK', tick: t, combinedChecksum: lockstepPendingBundleAckByTick[t] });
            delete lockstepPendingBundleAckByTick[t];
        }

        let pendingCommitChecksum = lockstepPendingCommitByTick[t];
        if (!pendingCommitChecksum) continue;

        let bundle = lockstepBundleByTick[t];
        if (!bundle) {
            let lastReq = lockstepLastResendRequestAtByTick[t] || 0;
            if ((now - lastReq) >= LOCKSTEP_RESEND_REQUEST_MS && connections[0]) {
                logLockstepWarning('Commit received before bundle; requesting resend', { tick: t });
                connections[0].send({ type: 'TICK_RESEND_REQUEST', tick: t });
                lockstepLastResendRequestAtByTick[t] = now;
            }
            continue;
        }

        if (String(bundle.combinedChecksum || '') !== pendingCommitChecksum) {
            let lastReq = lockstepLastResendRequestAtByTick[t] || 0;
            if ((now - lastReq) >= LOCKSTEP_RESEND_REQUEST_MS && connections[0]) {
                logLockstepWarning('Commit checksum mismatch; requesting resend', {
                    tick: t,
                    bundleChecksum: String(bundle.combinedChecksum || ''),
                    commitChecksum: String(pendingCommitChecksum || '')
                });
                connections[0].send({ type: 'TICK_RESEND_REQUEST', tick: t });
                lockstepLastResendRequestAtByTick[t] = now;
            }
            delete lockstepPendingCommitByTick[t];
            continue;
        }

        lockstepCommittedByTick[t] = true;
        delete lockstepPendingCommitByTick[t];
    }
}

function getHostResendBundleForTick(tick) {
    let t = Math.floor(Number(tick));
    if (!Number.isFinite(t) || t < 0) return null;

    let liveBundle = lockstepBundleByTick[t];
    if (liveBundle && validateTickBundle(liveBundle)) {
        return {
            bundle: liveBundle,
            committed: !!lockstepCommittedByTick[t]
        };
    }

    let historyBundle = lockstepHistoryByTick[t];
    if (!historyBundle || !Array.isArray(historyBundle.packets)) return null;

    let resendBundle = {
        tick: t,
        packets: historyBundle.packets,
        combinedChecksum: String(historyBundle.combinedChecksum || '')
    };
    if (!validateTickBundle(resendBundle)) {
        logLockstepWarning('Unable to resend historical bundle due validation failure', { tick: t });
        return null;
    }
    return {
        bundle: resendBundle,
        committed: true
    };
}

function handleIncomingTickResendRequest(conn, data) {
    let t = Math.floor(Number(data && data.tick));
    if (!Number.isFinite(t) || t < 0) return;

    if (isHost) {
        let packetPeerId = data && data.packetPeerId ? String(data.packetPeerId) : '';
        if (packetPeerId) {
            if (packetPeerId === myPeerId) {
                sendLocalTickPacket(t, true);
            } else {
                let target = connections.find(c => c && c.peer === packetPeerId);
                if (target) target.send({ type: 'TICK_RESEND_REQUEST', tick: t, packetPeerId });
            }
            return;
        }

        let resend = getHostResendBundleForTick(t);
        if (!resend) {
            let liveBundle = maybeBuildHostBundle(t);
            if (liveBundle) {
                resend = {
                    bundle: liveBundle,
                    committed: !!lockstepCommittedByTick[t]
                };
            }
        }

        if (resend && resend.bundle) {
            conn.send({ type: 'TICK_BUNDLE', bundle: resend.bundle });
            if (resend.committed) {
                conn.send({ type: 'TICK_COMMIT', tick: t, combinedChecksum: resend.bundle.combinedChecksum });
            }
        }
        return;
    }

    let packetPeerId = data && data.packetPeerId ? String(data.packetPeerId) : '';
    if (!packetPeerId || packetPeerId === myPeerId) {
        sendLocalTickPacket(t, true);
    }
}

function driveStrictLockstep(now, tick) {
    if (!isMultiplayer) return;
    let t = Math.floor(Number(tick));
    if (!Number.isFinite(t) || t < 0) return;

    if (!isHost && lockstepDesyncDetected) {
        maybeRequestHardLockstepResync(now, t, 'state hash mismatch');
        return;
    }

    sendLocalTickPacketWindow(t);

    if (isHost) {
        let participants = getActiveMatchPeerIds();
        let pmap = lockstepHostPacketsByTick[t] || {};
        let missing = participants.filter(pid => !pmap[pid]);
        if (missing.length > 0) {
            let lastReq = lockstepLastResendRequestAtByTick[t] || 0;
            if ((now - lastReq) >= LOCKSTEP_RESEND_REQUEST_MS) {
                for (let pid of missing) {
                    if (pid === myPeerId) {
                        sendLocalTickPacket(t, true);
                        continue;
                    }
                    let conn = connections.find(c => c && c.peer === pid);
                    if (conn) {
                        logLockstepWarning('Missing tick packet; requesting resend from peer', {
                            tick: t,
                            packetPeerId: pid
                        });
                        conn.send({ type: 'TICK_RESEND_REQUEST', tick: t, packetPeerId: pid });
                    }
                }
                lockstepLastResendRequestAtByTick[t] = now;
            }
            return;
        }

        maybeBuildHostBundle(t);
        sendHostBundle(t);
        maybeCommitHostTick(t);

        for (let pt = t + 1; pt <= t + LOCKSTEP_PIPELINE_TICKS; pt++) {
            maybeBuildHostBundle(pt);
            sendHostBundle(pt);
            maybeCommitHostTick(pt);
        }

        let recentStart = Math.max(0, t - Math.max(2, LOCKSTEP_PIPELINE_TICKS));
        for (let rt = recentStart; rt < t; rt++) {
            sendHostFinalize(rt);
        }
        return;
    }

    processDeferredGuestLockstepWindow(now, t);

    if (!lockstepCommittedByTick[t]) {
        let lastReq = lockstepLastResendRequestAtByTick[t] || 0;
        if ((now - lastReq) >= LOCKSTEP_RESEND_REQUEST_MS && connections[0]) {
            logLockstepWarning('Tick not committed in time; requesting resend', {
                tick: t,
                hasBundle: !!lockstepBundleByTick[t],
                hasPendingBundle: !!lockstepPendingBundleByTick[t],
                hasPendingCommit: !!lockstepPendingCommitByTick[t],
                bundleAckQueued: !!lockstepPendingBundleAckByTick[t]
            });
            connections[0].send({ type: 'TICK_RESEND_REQUEST', tick: t });
            lockstepLastResendRequestAtByTick[t] = now;
        }
        maybeRequestHardLockstepResync(now, t, 'tick not committed in time');
    }
}

function isStrictTickReady(tick) {
    if (!isMultiplayer) return true;
    if (!isHost && lockstepDesyncDetected) return false;
    let t = Math.floor(Number(tick));
    if (!Number.isFinite(t) || t < 0) return false;
    return !!lockstepCommittedByTick[t] && !!lockstepBundleByTick[t];
}

let _researchPopupRefreshRequested = false;

function requestResearchPopupRefresh() {
    _researchPopupRefreshRequested = true;
}

function flushTickUiRequests() {
    if (!_researchPopupRefreshRequested) return;
    _researchPopupRefreshRequested = false;
    let researchPopup = document.getElementById('research-popup');
    if (researchPopup && !researchPopup.classList.contains('hidden') && !researchQueueDragInProgress) {
        renderResearchPopupContent();
    }
}

function runOneTick() {
    // Reset pathfinding budget before processing actions
    pathfindBudget = 0;
    let processedTick = currentTick;

    if (isHost && isMultiplayer) {
        let b = lockstepBundleByTick[currentTick];
        if (b && Array.isArray(b.packets)) {
            lockstepHistoryByTick[currentTick] = {
                tick: currentTick,
                packets: b.packets.map(p => ({
                    tick: p.tick,
                    peerId: p.peerId,
                    teamId: p.teamId,
                    actions: Array.isArray(p.actions) ? p.actions.map(a => ({ ...a })) : [],
                    checksum: p.checksum
                })),
                combinedChecksum: b.combinedChecksum
            };
        }
    }

    // Process deterministic combined actions for this tick.
    let allActs = isMultiplayer
        ? ((lockstepBundleByTick[currentTick] && Array.isArray(lockstepBundleByTick[currentTick].packets))
            ? lockstepBundleByTick[currentTick].packets.flatMap(p => Array.isArray(p.actions) ? p.actions : [])
            : [])
        : (localInputBuffer[currentTick] || []);
    let teams = (activeTeamIds && activeTeamIds.length > 0) ? [...activeTeamIds].sort((a, b) => a - b) : [0, 1];
    for (let teamId of teams) {
        let acts = allActs.filter(a => (a.teamId ?? 0) === teamId);
        if (acts.length > 0) processActions(acts, teamId);
    }

    delete localInputBuffer[currentTick];
    delete lockstepLocalPacketByTick[currentTick];
    delete lockstepHostPacketsByTick[currentTick];
    delete lockstepBundleByTick[currentTick];
    delete lockstepPendingBundleByTick[currentTick];
    delete lockstepPendingBundleAckByTick[currentTick];
    delete lockstepPendingCommitByTick[currentTick];
    delete lockstepCommittedByTick[currentTick];
    delete lockstepBundleAckByTick[currentTick];
    delete lockstepLastPacketSentAtByTick[currentTick];
    delete lockstepLastBundleSentAtByTick[currentTick];
    delete lockstepLastFinalizeSentAtByTick[currentTick];
    delete lockstepLastResendRequestAtByTick[currentTick];

    gameTick();

    if (currentTick % TICK_RATE === 0) sampleGameStats();
    requestResearchPopupRefresh();

    if (isMultiplayer && (processedTick % LOCKSTEP_STATE_CHECK_INTERVAL) === 0) {
        let stateDigest = computeLockstepStateDigest(processedTick);
        let stateHash = hashStringLockstep(stableSerializeForLockstep(stateDigest));
        if (isHost) {
            connections.forEach(c => {
                if (c) {
                    let msg = { type: 'TICK_STATE_HASH', tick: processedTick, stateHash };
                    if (LOCKSTEP_DEBUG_HASH_DETAILS) msg.stateDigest = stateDigest;
                    c.send(msg);
                }
            });
        } else {
            lockstepLocalStateHashByTick[processedTick] = stateHash;
            if (LOCKSTEP_DEBUG_HASH_DETAILS) lockstepLocalStateDigestByTick[processedTick] = stateDigest;
            maybeCompareLockstepStateHash(processedTick);
        }
    }

    if (isMultiplayer && !isHost) {
        let pruneBefore = processedTick - Math.max(200, LOCKSTEP_STATE_CHECK_INTERVAL * 20);
        for (let key of Object.keys(lockstepExpectedStateHashByTick)) {
            let t = Math.floor(Number(key));
            if (Number.isFinite(t) && t < pruneBefore) {
                delete lockstepExpectedStateHashByTick[key];
                delete lockstepExpectedStateDigestByTick[key];
            }
        }
        for (let key of Object.keys(lockstepLocalStateHashByTick)) {
            let t = Math.floor(Number(key));
            if (Number.isFinite(t) && t < pruneBefore) {
                delete lockstepLocalStateHashByTick[key];
                delete lockstepLocalStateDigestByTick[key];
            }
        }
    }

    _tpsTickCount++;
    let tpsNow = performance.now();
    if (tpsNow - _tpsLastTime >= 1000) {
        _tpsDisplay = Math.round(_tpsTickCount * 1000 / (tpsNow - _tpsLastTime));
        _tpsTickCount = 0;
        _tpsLastTime = tpsNow;
    }

    currentTick++;
}

Object.assign(globalThis, {
    gameTick,
    screenToWorld,
    initInput,
    startGame,
    runOneTick,
});
