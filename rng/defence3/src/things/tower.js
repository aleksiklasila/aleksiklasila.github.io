"use strict";

function _compareDeterministicBuildingRefs(a, b) {
    let agy = Math.floor(Number(a && a.gy) || 0);
    let bgy = Math.floor(Number(b && b.gy) || 0);
    if (agy !== bgy) return agy - bgy;

    let agx = Math.floor(Number(a && a.gx) || 0);
    let bgx = Math.floor(Number(b && b.gx) || 0);
    if (agx !== bgx) return agx - bgx;

    let aowner = Math.floor(Number(a && a.owner) || 0);
    let bowner = Math.floor(Number(b && b.owner) || 0);
    if (aowner !== bowner) return aowner - bowner;

    let atype = String((a && a.type) || '');
    let btype = String((b && b.type) || '');
    if (atype !== btype) return atype < btype ? -1 : 1;

    let aid = Math.floor(Number(a && a.id) || 0);
    let bid = Math.floor(Number(b && b.id) || 0);
    if (aid !== bid) return aid - bid;

    let ax = Number(a && a.x) || 0;
    let bx = Number(b && b.x) || 0;
    if (ax !== bx) return ax - bx;

    let ay = Number(a && a.y) || 0;
    let by = Number(b && b.y) || 0;
    return ay - by;
}

let _deterministicTowerBuildingOrderCacheTick = -1;
let _deterministicTowerBuildingOrderCache = new WeakMap();

function _getDeterministicBuildingRefsForTick(buildings) {
    if (!Array.isArray(buildings) || buildings.length <= 1) return buildings || [];
    if (_deterministicTowerBuildingOrderCacheTick !== gameTime) {
        _deterministicTowerBuildingOrderCacheTick = gameTime;
        _deterministicTowerBuildingOrderCache = new WeakMap();
    }
    let cached = _deterministicTowerBuildingOrderCache.get(buildings);
    if (cached) return cached;
    let order = buildings.slice().sort(_compareDeterministicBuildingRefs);
    _deterministicTowerBuildingOrderCache.set(buildings, order);
    return order;
}

function _shouldPreferBuildingTarget(candidate, best, candidateDist, bestDist) {
    if (candidateDist > bestDist + 1e-9) return false;
    if (!best) return true;
    if (candidateDist < bestDist - 1e-9) return true;
    if (candidateDist > bestDist + 1e-9) return false;
    return _compareDeterministicBuildingRefs(candidate, best) < 0;
}

function _shouldPreferBuildingTargetSquared(candidate, best, candidateDist2, bestDist2) {
    if (candidateDist2 > bestDist2) return false;
    if (!best) return true;
    if (candidateDist2 < bestDist2) return true;
    return _compareDeterministicBuildingRefs(candidate, best) < 0;
}

function _isTargetVisibleInRawVisibilityGrid(rawVisibilityGrid, target) {
    if (!rawVisibilityGrid || !target) return false;
    let gx = Number.isFinite(target.gx) ? Math.floor(Number(target.gx)) : Math.floor((Number(target.x) || 0) / TILE);
    let gy = Number.isFinite(target.gy) ? Math.floor(Number(target.gy)) : Math.floor((Number(target.y) || 0) / TILE);
    if (gx < 0 || gx >= GRID_W || gy < 0 || gy >= GRID_H) return false;
    let row = rawVisibilityGrid[gy];
    return !!(row && row[gx] > 0);
}

function _isTowerTargetVisibleToOwner(tower, target, rawVisibilityGrid = null) {
    if (!tower || !target) return false;
    if (rawVisibilityGrid) return _isTargetVisibleInRawVisibilityGrid(rawVisibilityGrid, target);
    let gx = Number.isFinite(target.gx) ? Math.floor(Number(target.gx)) : Math.floor((Number(target.x) || 0) / TILE);
    let gy = Number.isFinite(target.gy) ? Math.floor(Number(target.gy)) : Math.floor((Number(target.y) || 0) / TILE);
    return isGameplayTargetVisibleToPlayer(tower.owner, gx, gy);
}

function _getTowerAttackRangeArea(tower) {
    let attackRangeArea = Math.max(0, Number(tower && tower.currentStats && tower.currentStats.attackRangeArea) || 0);
    if (attackRangeArea > 0) return attackRangeArea;
    let attackRangePx = Math.max(0, Number(tower && tower.currentStats && tower.currentStats.attackRange) || 0);
    if (attackRangePx > 0) return attackRangePx / (AREA_UNIT_TILE_EQUIVALENT * TILE);
    return Math.max(0, Number(tower && tower.currentStats && tower.currentStats.visionRangeArea) || 0);
}

function _getTowerAttackRangePx(tower) {
    let attackRangePx = Math.max(0, Number(tower && tower.currentStats && tower.currentStats.attackRange) || 0);
    if (attackRangePx > 0) return attackRangePx;
    return _getTowerAttackRangeArea(tower) * AREA_UNIT_TILE_EQUIVALENT * TILE;
}

// ============================================================
// TOWER CLASS
// ============================================================
class Tower {
    constructor(gx, gy, type, owner, startStacks = 1) {
        this.gx = gx; this.gy = gy; this.type = type; this.owner = owner;
        this.x = gx * TILE + 16; this.y = gy * TILE + 16;
        this.stacks = startStacks;
        this.manualStacks = startStacks;
        this.effectiveStacks = startStacks;
        this.level = stackCountToLevel(this.stacks);
        this.effectiveLevel = this.level;
        this.isStacking = false;
        this.stackingWorkDone = 0;
        this.baseStats = BASE_CARD_TYPES[type];
        this.preComputedBase = null;
        this.preComputedEffective = null;
        this.preComputed = null;
        this.currentStats = this.baseStats;

        // ENERGY
        let baseEnergy = calculateItemStats(type, this.level, owner).maxEnergy;
        this.maxEnergy = baseEnergy;
        this.energy = baseEnergy;

        this.textCtx = null;
        this.updateTextCache();
        this.updateStats();
        this.cd = 0; this.angle = 0;
        this.connectedLasers = [];
        this.laserState = 0; this.laserTimer = 0;
        this.markedForSalvage = false;
        this.autoUpgradeEnabled = true;
        this.buildEnabled = true;
        this.preferredTarget = null;
        this.preferredTargetSpec = null;
    }

    upgrade() {
        addManualStackToThing(this, 1);
    }

    updateTextCache() {
        let label = getLevelLabelText(this);
        _bindBuildingLevelTextSprite(this, label);
    }

    updateStats() {
        let effLevel = getThingEffectiveLevel(this);
        this.preComputedBase = calculateItemStats(this.type, Math.max(1, this.level), this.owner);
        this.preComputedEffective = clonePrecomputedWithBaseMaxEnergy(this.preComputedBase, calculateItemStats(this.type, effLevel, this.owner), false);
        this.preComputed = this.preComputedBase;
        this.currentStats = this.preComputedBase || this.baseStats;

        let newmaxEnergy = Number(this.preComputedBase && this.preComputedBase.maxEnergy);
        if (!Number.isFinite(newmaxEnergy)) newmaxEnergy = this.maxEnergy || 1;
        newmaxEnergy = Math.max(1, Math.floor(newmaxEnergy));
        if (this.isUpgrading && this.upgrademaxEnergy > 0) {
            this.maxEnergy = Math.max(1, Math.floor(this.upgrademaxEnergy));
            if (!Number.isFinite(this.energy) || this.energy < 1) this.energy = 1;
            this.energy = Math.min(this.energy, this.maxEnergy);
        } else {
            let prevEnergy = Number(this.energy);
            if (!Number.isFinite(prevEnergy)) prevEnergy = newmaxEnergy;
            this.maxEnergy = newmaxEnergy;
            this.energy = Math.max(1, Math.min(this.maxEnergy, Math.floor(prevEnergy)));
        }
        this.updateTextCache();
    }

    calcStats(lvl) {
        return calculateItemStats(this.type, lvl, this.owner);
    }

    update() {
        if (this.energy <= 0) return;
        tickStatusEffects(this);
        if (this.energy <= 0) return;
        if (this.underConstruction) {
            let requiredEnergy = Math.max(1, Math.floor(getUpgrademaxEnergy(this, 1) || this.maxEnergy || 1));
            if ((Number(this.energy) || 0) >= requiredEnergy) markConstructionComplete(this);
            if (this.underConstruction) return;
        }
        if (this.type.startsWith('cloud')) return;

        let ownerRawVisibility = getRawVisibilityGridForPlayer(this.owner);

        if (this.type === 'laser') {
            this.laserState = 0;
            let sortedTowerRefs = _getDeterministicBuildingRefsForTick(towers);
            let sortedBarrackRefs = _getDeterministicBuildingRefsForTick(barracks);
            let sortedSpawnerRefs = _getDeterministicBuildingRefsForTick(collectorSpawners);
            for (let other of this.connectedLasers) {
                if (this.gx < other.gx || (this.gx === other.gx && this.gy < other.gy)) {
                    let dmg = this.currentStats.damage + other.currentStats.damage;
                    let sx = this.x, sy = this.y, ex = other.x, ey = other.y;
                    let isVert = (this.gx === other.gx);
                    let mn = isVert ? Math.min(sy, ey) : Math.min(sx, ex);
                    let mx = isVert ? Math.max(sy, ey) : Math.max(sx, ex);
                    let hitAny = false;
                    let nearUnits = getUnitsInRange((sx + ex) / 2, (sy + ey) / 2, Math.max(Math.abs(ex - sx), Math.abs(ey - sy)) / 2 + TILE);
                    for (let u of nearUnits) {
                        if (u.owner === this.owner) continue;
                        if (u.turretImmune) continue;
                        if (!_isTowerTargetVisibleToOwner(this, u, ownerRawVisibility)) continue;
                        let hit = false;
                        if (isVert) { hit = Math.abs(u.x - sx) < u.r + 4 && u.y >= mn && u.y <= mx; }
                        else { hit = Math.abs(u.y - sy) < u.r + 4 && u.x >= mn && u.x <= mx; }
                        if (hit) {
                            hitAny = true;
                            if (gameTime % 40 === 0) playSound('laser_tick', (this.x + other.x) / 2, (this.y + other.y) / 2);
                            if (u.laserResistant) { if (gameTime % 10 === 0) createExplosion(u.x, u.y, "#888", 1); }
                            else {
                                let prevEnergy = u.energy;
                                u.energy -= dmg / 60;
                                pushHostileDamageAlert(u, prevEnergy - u.energy, this.owner);
                                recordDamageVisual(u, prevEnergy - u.energy, this.owner);
                                tryAutoRetaliateOnHostileDamage(u, this, this.x, this.y);
                                if (gameTime % 10 === 0) createExplosion(u.x, u.y, "#f00", 1);
                                if (u.energy <= 0 && !u.dead) { u.dead = true; }
                            }
                        }
                    }
                    // Check buildings using shared deterministic per-tick order.
                    let applyLaserToBuildings = (list) => {
                        for (let i = 0; i < list.length; i++) {
                            let b = list[i];
                            if (b.owner === this.owner || b.energy <= 0) continue;
                            if (!_isTowerTargetVisibleToOwner(this, b, ownerRawVisibility)) continue;
                            let hit = false;
                            if (isVert) { hit = Math.abs(b.x - sx) < 18 && b.y >= mn && b.y <= mx; }
                            else { hit = Math.abs(b.y - sy) < 18 && b.x >= mn && b.x <= mx; }
                            if (!hit) continue;
                            hitAny = true;
                            let prevEnergy = b.energy;
                            b.energy -= dmg / 60;
                            pushHostileDamageAlert(b, prevEnergy - b.energy, this.owner);
                            recordDamageVisual(b, prevEnergy - b.energy, this.owner);
                            if (gameTime % 10 === 0) createExplosion(b.x, b.y, "#f84", 1);
                            if (b.energy <= 0) destroyBuilding(b);
                        }
                    };
                    applyLaserToBuildings(sortedTowerRefs);
                    applyLaserToBuildings(sortedBarrackRefs);
                    applyLaserToBuildings(sortedSpawnerRefs);
                    if (hitAny) this.laserState = 1;
                }
            }
            return;
        }

        if (this.cd > 0) { this.cd--; return; }
        this.shoot(ownerRawVisibility);
    }

    shoot(ownerRawVisibility = null) {
        if (this.cd > 0) return;
        if (!ownerRawVisibility) ownerRawVisibility = getRawVisibilityGridForPlayer(this.owner);
        let rangeArea = _getTowerAttackRangeArea(this);
        let rangePx = _getTowerAttackRangePx(this);
        let rangePxSq = rangePx * rangePx;
        let preferredTarget = getTowerPreferredTargetInRange(this, rangePx);
        if (preferredTarget) {
            let target = preferredTarget;
            projectiles.push(new Projectile(this.x, this.y, target, this.type, this.currentStats.damage, getThingEffectiveLevel(this), this, rangePx, this.currentStats.blastDamage, this.currentStats.blastRadius));
            this.cd = secondsToTicks(this.currentStats.cd || 1.5);
            this.angle = Math.atan2(target.y - this.y, target.x - this.x);
            createExplosion(this.x + Math.cos(this.angle) * 12, this.y + Math.sin(this.angle) * 12, '#fff', 2);
            if (this.owner === localPlayerId || true) {
                let sndType = 'shoot_' + this.type;
                if (!['shoot_pistol', 'shoot_smg', 'shoot_fire', 'shoot_water', 'shoot_poison', 'shoot_ice', 'shoot_sand_gun', 'shoot_elements'].includes(sndType))
                    sndType = 'shoot_generic';
                if (this.owner === localPlayerId) playSound(sndType, this.x, this.y);
                else if (Math.random() < 0.3) playSound(sndType, this.x, this.y);
            }
            return;
        }
        let bestPrimary = null, bestSecondary = null, bestImmune = null;
        let dPrimarySq = rangePxSq, dSecondarySq = rangePxSq, dImmuneSq = rangePxSq;

        forEachUnitInAreaRange(this.x, this.y, rangeArea, (u) => {
            if (!_isTowerTargetVisibleToOwner(this, u, ownerRawVisibility)) return;
            if (u.turretImmune) return;
            let dx = u.x - this.x;
            let dy = u.y - this.y;
            let d2 = dx * dx + dy * dy;
            if (d2 > rangePxSq) return;

            let immune = (this.type === 'fire' && u.fireResistant) || (this.type === 'water' && u.waterResistant) ||
                (this.type === 'poison' && u.poisonResistant) || (this.type === 'ice' && u.iceResistant) ||
                (this.type === 'elements' && (u.waterResistant || u.fireResistant || u.poisonResistant || u.iceResistant));

            if (immune) { if (d2 < dImmuneSq) { dImmuneSq = d2; bestImmune = u; } }
            else {
                let affected = false;
                if (this.type === 'fire') affected = u.burning > 0;
                else if (this.type === 'poison') affected = u.poisoned > 0;
                else if (this.type === 'water') affected = u.wet > 0;
                else if (this.type === 'ice') affected = u.frozen > 0;
                else if (this.type === 'sand_gun') affected = u.sandy > 0;
                else if (this.type === 'watch_tower') affected = u.watched > 0;
                if (!affected) { if (d2 < dPrimarySq) { dPrimarySq = d2; bestPrimary = u; } }
                else { if (d2 < dSecondarySq) { dSecondarySq = d2; bestSecondary = u; } }
            }
        }, { enemyOfPlayer: this.owner });

        let target = bestPrimary || bestSecondary || bestImmune;

        // If no unit target, try closest enemy building
        if (!target) {
            // Auto-find nearest enemy building: towers first, then barracks/spawners
            let bestDistSq = rangePxSq;
            for (let t of _getDeterministicBuildingRefsForTick(towers)) {
                if (t === this || t.owner === this.owner || t.energy <= 0) continue;
                if (!_isTowerTargetVisibleToOwner(this, t, ownerRawVisibility)) continue;
                let dx = t.x - this.x;
                let dy = t.y - this.y;
                let d2 = dx * dx + dy * dy;
                if (_shouldPreferBuildingTargetSquared(t, target, d2, bestDistSq)) {
                    bestDistSq = d2;
                    target = t;
                }
            }
            // Try barracks and spawners (lower priority, only if no tower found)
            if (!target) {
                for (let b of _getDeterministicBuildingRefsForTick(barracks)) {
                    if (b.owner === this.owner || b.energy <= 0) continue;
                    if (!_isTowerTargetVisibleToOwner(this, b, ownerRawVisibility)) continue;
                    let dx = b.x - this.x;
                    let dy = b.y - this.y;
                    let d2 = dx * dx + dy * dy;
                    if (_shouldPreferBuildingTargetSquared(b, target, d2, bestDistSq)) {
                        bestDistSq = d2;
                        target = b;
                    }
                }
                for (let s of _getDeterministicBuildingRefsForTick(collectorSpawners)) {
                    if (s.owner === this.owner || s.energy <= 0) continue;
                    if (!_isTowerTargetVisibleToOwner(this, s, ownerRawVisibility)) continue;
                    let dx = s.x - this.x;
                    let dy = s.y - this.y;
                    let d2 = dx * dx + dy * dy;
                    if (_shouldPreferBuildingTargetSquared(s, target, d2, bestDistSq)) {
                        bestDistSq = d2;
                        target = s;
                    }
                }
            }
        }

        if (target) {
            projectiles.push(new Projectile(this.x, this.y, target, this.type, this.currentStats.damage, getThingEffectiveLevel(this), this, rangePx, this.currentStats.blastDamage, this.currentStats.blastRadius));
            this.cd = secondsToTicks(this.currentStats.cd || 1.5);
            this.angle = Math.atan2(target.y - this.y, target.x - this.x);
            createExplosion(this.x + Math.cos(this.angle) * 12, this.y + Math.sin(this.angle) * 12, '#fff', 2);
            if (this.owner === localPlayerId || true) {
                let sndType = 'shoot_' + this.type;
                if (!['shoot_pistol', 'shoot_smg', 'shoot_fire', 'shoot_water', 'shoot_poison', 'shoot_ice', 'shoot_sand_gun', 'shoot_elements'].includes(sndType))
                    sndType = 'shoot_generic';
                if (this.owner === localPlayerId) playSound(sndType, this.x, this.y);
                else if (Math.random() < 0.3) playSound(sndType, this.x, this.y); // sparsify enemy turret sounds
            }
        }
    }

    draw(ctx) {
        if (this.owner >= 0) {
            ctx.strokeStyle = get2DRenderOwnerColor(this.owner); ctx.lineWidth = 1;
            ctx.strokeRect(this.x - 15, this.y - 15, 30, 30);
        }

        // Under construction overlay
        if (this.underConstruction || this.isUpgrading) {
            let isUpg = this.isUpgrading;
            if (!isUpg) {
                ctx.fillStyle = '#333'; ctx.fillRect(this.x - 14, this.y - 14, 28, 28);
                ctx.globalAlpha = 0.35;
                drawTowerIcon(ctx, this.x, this.y, this.baseStats.color, 0, this.level, this.type, false);
                ctx.globalAlpha = 1;
            } else {
                if (this.type === 'laser') {
                    if (this.laserState === 1) {
                        ctx.strokeStyle = '#f00'; ctx.lineWidth = 4;
                        ctx.shadowColor = '#f00'; ctx.shadowBlur = 10;
                        for (let other of this.connectedLasers) {
                            if (this.gx < other.gx || (this.gx === other.gx && this.gy < other.gy)) {
                                ctx.beginPath(); ctx.moveTo(this.x, this.y); ctx.lineTo(other.x, other.y); ctx.stroke();
                            }
                        }
                        ctx.shadowBlur = 0; ctx.lineWidth = 1;
                    }
                    drawTowerIcon(ctx, this.x, this.y, this.baseStats.color, 0, Math.max(1, this.level - 1), this.type, this.connectedLasers.length > 0);
                } else {
                    drawTowerIcon(ctx, this.x, this.y, this.baseStats.color, this.angle, Math.max(1, this.level - 1), this.type);
                }
                ctx.fillStyle = 'rgba(0,0,0,0.5)'; ctx.fillRect(this.x - 14, this.y - 14, 28, 28);
            }
            drawBuildingEnergyProgressBar(ctx, this, this.x, this.y + 11, 20, 3);
            if (!isUpg) {
                if (shouldShowBuildingLevels()) drawLevelTextCache(ctx, this, this.x, this.y);
                return;
            }
        } else {
            if (this.type === 'laser') {
                if (this.laserState === 1) {
                    ctx.strokeStyle = '#f00'; ctx.lineWidth = 4;
                    ctx.shadowColor = '#f00'; ctx.shadowBlur = 10;
                    for (let other of this.connectedLasers) {
                        if (this.gx < other.gx || (this.gx === other.gx && this.gy < other.gy)) {
                            ctx.beginPath(); ctx.moveTo(this.x, this.y); ctx.lineTo(other.x, other.y); ctx.stroke();
                        }
                    }
                    ctx.shadowBlur = 0; ctx.lineWidth = 1;
                }
                drawTowerIcon(ctx, this.x, this.y, this.baseStats.color, 0, this.level, this.type, this.connectedLasers.length > 0);
            } else {
                drawTowerIcon(ctx, this.x, this.y, this.baseStats.color, this.angle, this.level, this.type);
            }
        }
        if (shouldShowBuildingLevels()) drawLevelTextCache(ctx, this, this.x, this.y);

        // Energy bar (single bar for damage/progress)
        if (!this.underConstruction && !this.isUpgrading) {
            drawBuildingEnergyProgressBar(ctx, this, this.x, this.y + 14, 24, 3);
        }
    }
}