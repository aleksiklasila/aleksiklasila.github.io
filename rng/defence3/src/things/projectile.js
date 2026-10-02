"use strict";

// ============================================================
// PROJECTILE CLASS
// ============================================================
// The structure a shot at (x, y) hits: of another owner, alive, within 18
// px: a tower first, then a barrack, then a spawner, each kind by its tile
// (row-major). During the projectile phase (projectilesBegin/End) a shot
// looks only at the tiles around it (structures stand at their tile's
// centre); otherwise the lists are scanned, with the same order.
let _projPhase = false;
function projectilesBegin() { _projPhase = true; }
function projectilesEnd() { _projPhase = false; }
// 0 tower, 1 barrack, 2 spawner, -1 none of these.
function _projBuildingKind(b) {
    return b instanceof Tower ? 0 : b instanceof Barrack ? 1 : isSpawnerEntity(b) ? 2 : -1;
}
function _projectileBuildingHit(p) {
    let best = null, bestRank = Infinity;
    const consider = (b, kind) => {
        if (b.owner === p.sourceOwner || b.energy <= 0) return;
        const r = kind * GRID_W * GRID_H + (Math.floor(b.gy) * GRID_W + Math.floor(b.gx));
        if (r >= bestRank) return;
        if (detHypot(b.x - p.x, b.y - p.y) <= 18) { best = b; bestRank = r; }
    };
    if (!_projPhase) {
        [towers, barracks, collectorSpawners].forEach((list, kind) => { for (const b of list) consider(b, kind); });
        return best;
    }
    const gx0 = Math.max(0, Math.floor((p.x - 18) / TILE) - 1), gx1 = Math.min(GRID_W - 1, Math.floor((p.x + 18) / TILE) + 1);
    const gy0 = Math.max(0, Math.floor((p.y - 18) / TILE) - 1), gy1 = Math.min(GRID_H - 1, Math.floor((p.y + 18) / TILE) + 1);
    for (let gy = gy0; gy <= gy1; gy++) {
        const refs = tileEntityRef[gy];
        if (!refs) continue;
        for (let gx = gx0; gx <= gx1; gx++) {
            const b = refs[gx];
            if (!b) continue;
            const kind = _projBuildingKind(b);
            if (kind >= 0) consider(b, kind);
        }
    }
    return best;
}

class Projectile {
    constructor(x, y, t, type, dmg, level, source, maxRange, blastDamage = NaN, blastRadius = NaN) {
        this.x = x; this.y = y; this.prevX = x; this.prevY = y; this.type = type; this.speed = 8; this.life = 100;
        this.startX = x; this.startY = y; this.maxRange = maxRange || 9999;
        // cos/sin(atan2) as an exact normalization: trig results may differ
        // between browsers, and lockstep peers must agree on every shot.
        let dx = t.x - x, dy = t.y - y;
        let len = detHypot(dx, dy);
        // Visual only: the shot's planned length shapes its rendered arc.
        this.aimDist = len;
        if (len > 0) { this.vx = dx / len * 8; this.vy = dy / len * 8; }
        else { this.vx = 8; this.vy = 0; }
        this.dmg = dmg; this.level = level;
        this.blastDamage = Number.isFinite(blastDamage) ? Math.max(0, blastDamage) : NaN;
        this.blastRadius = Number.isFinite(blastRadius) ? Math.max(0, blastRadius) : NaN;
        this.sourceOwner = source ? source.owner : -1;
        this.sx = source ? source.gx : -1;
        this.sy = source ? source.gy : -1;
        // Floor items do not block shots; only the aimed-at one is hit.
        let floorTarget = t && t.unitType === undefined && Number.isFinite(t.gx) && Number.isFinite(t.gy)
            && getFloorItemAtTile(t.gx, t.gy) === t;
        this.floorTargetGx = floorTarget ? t.gx : -1;
        this.floorTargetGy = floorTarget ? t.gy : -1;
    }

    getSourceAttacker() {
        if (!Number.isFinite(this.sx) || !Number.isFinite(this.sy)) return null;
        let source = getTileEntityRef(this.sx, this.sy);
        if (!source) return null;
        if (Number.isFinite(source.owner) && source.owner !== this.sourceOwner) return null;
        return source;
    }

    update() {
        this.x += this.vx; this.y += this.vy;
        this.life--;

        let checkHits = () => {
            if (forEachUnitInRange(this.x, this.y, 16, (u) => {
                let hitRange = u.r + 8;
                let dx = u.x - this.x, dy = u.y - this.y;
                if (dx * dx + dy * dy <= hitRange * hitRange) {
                    this.hit(u);
                    return true;
                }
            }, { enemyOfPlayer: this.sourceOwner })) return true;
            let b = _projectileBuildingHit(this);
            if (b) { this.hitBuilding(b); return true; }
            if (this.floorTargetGx >= 0) {
                let item = getFloorItemAtTile(this.floorTargetGx, this.floorTargetGy);
                if (item && item.owner !== this.sourceOwner && item.energy > 0
                    && detHypot(item.x - this.x, item.y - this.y) <= 18) { this.hitBuilding(item); return true; }
            }
            return false;
        };

        if (checkHits()) return false;
        if (detHypot(this.x - this.startX, this.y - this.startY) >= this.maxRange || this.life <= 0) return false;
        return true;
    }
    hit(t) {
        let sourceAttacker = this.getSourceAttacker();
        if (t.turretImmune) { createExplosion(t.x, t.y, "#888", 3); return; }
        let targetEnergyBefore = t.energy;
        let baseDmg = this.dmg;
        let splashDmg = Number.isFinite(this.blastDamage) ? this.blastDamage : baseDmg;
        let splashRadiusArea = Number.isFinite(this.blastRadius) ? this.blastRadius : ((64 / TILE) / AREA_UNIT_TILE_EQUIVALENT);
        let splashRadiusPx = Math.max(0, Number(splashRadiusArea) * AREA_UNIT_TILE_EQUIVALENT * TILE);
        let hasBlast = Number.isFinite(this.blastDamage) && this.blastDamage > 0 && Number.isFinite(this.blastRadius) && this.blastRadius > 0;
        if (this.type === 'fire') {
            applyStatusEffect(t, 'fire', this.level || 1, baseDmg * 0.05, this.sourceOwner, this.type);
            if (!t.fireResistant) { t.energy -= this.dmg; }
            let radius = 12 + this.level * 4;
            createExplosion(this.x, this.y, "orange", Math.min(radius, 20));
        } else if (this.type === 'ice') {
            applyStatusEffect(t, 'ice', this.level || 1, baseDmg * 0.2, this.sourceOwner, this.type);
            if (!t.iceResistant) t.energy -= this.dmg;
        } else if (this.type === 'elements') {
            applyStatusEffect(t, 'poison', this.level || 1, baseDmg * 0.2, this.sourceOwner, this.type);
            applyStatusEffect(t, 'fire', this.level || 1, baseDmg * 0.2, this.sourceOwner, this.type);
            applyStatusEffect(t, 'water', this.level || 1, 0, this.sourceOwner, this.type);
            applyStatusEffect(t, 'ice', this.level || 1, baseDmg * 0.2, this.sourceOwner, this.type);
            applyStatusEffect(t, 'sand', this.level || 1, 0, this.sourceOwner, this.type);
            if (!t.poisonResistant && !t.fireResistant && !t.waterResistant && !t.iceResistant) {
                // extra direct damage is handled below by projectile damage model
            }
        } else if (this.type === 'water') {
            applyStatusEffect(t, 'water', this.level || 1, 0, this.sourceOwner, this.type);
            if (!t.waterResistant) t.energy -= this.dmg;
            createExplosion(this.x, this.y, "#4af", 4);
        } else if (this.type === 'poison') {
            applyStatusEffect(t, 'poison', this.level || 1, baseDmg * 0.1, this.sourceOwner, this.type);
            if (!t.poisonResistant) t.energy -= this.dmg;
        } else if (this.type === 'sand_gun') {
            applyStatusEffect(t, 'sand', this.level || 1, 0, this.sourceOwner, this.type);
            if (!t.sandResistant) { t.energy -= this.dmg; createExplosion(this.x, this.y, "#c96", 4); }
        } else if (this.type === 'watch_tower') {
            applyStatusEffect(t, 'watch', this.level || 1, 0, this.sourceOwner, this.type);
            if (this.dmg > 0) t.energy -= this.dmg;
            createExplosion(this.x, this.y, "#fd0", 3);
        } else {
            t.energy -= this.dmg;
            createExplosion(this.x, this.y, "#fff", 4);
        }

        recordCombatFx(COMBAT_FX.IMPACT, this.startX, this.startY, this.x, this.y, this.type);
        pushHostileDamageAlert(t, targetEnergyBefore - t.energy, this.sourceOwner);
    recordDamageVisual(t, targetEnergyBefore - t.energy, this.sourceOwner); shrineDamageTaken(t, targetEnergyBefore - t.energy);
        if (targetEnergyBefore > t.energy) playSound('impact', t.x, t.y, this.type);
        tryAutoRetaliateOnHostileDamage(t, sourceAttacker, Number.isFinite(this.sx) ? this.sx * TILE + 16 : null, Number.isFinite(this.sy) ? this.sy * TILE + 16 : null);

        if (hasBlast) {
            forEachUnitInRange(this.x, this.y, splashRadiusPx, (e) => {
                if (e === t || e.turretImmune) return;
                let prevEnergy = e.energy;
                e.energy -= splashDmg;
                pushHostileDamageAlert(e, prevEnergy - e.energy, this.sourceOwner);
        recordDamageVisual(e, prevEnergy - e.energy, this.sourceOwner); shrineDamageTaken(e, prevEnergy - e.energy);
                tryAutoRetaliateOnHostileDamage(e, sourceAttacker, Number.isFinite(this.sx) ? this.sx * TILE + 16 : null, Number.isFinite(this.sy) ? this.sy * TILE + 16 : null);
                if (this.type === 'fire') applyStatusEffect(e, 'fire', this.level || 1, splashDmg * 0.05, this.sourceOwner, this.type);
                if (e.energy <= 0 && !e.dead) e.dead = true;
            }, { enemyOfPlayer: this.sourceOwner });
        }
        if (t.energy <= 0 && !t.dead) { t.dead = true; createExplosion(t.x, t.y, "#e44", 6); }
    }
    hitBuilding(b) {
        let buildingEnergyBefore = b.energy;
        // Apply damage to a building (tower, barrack, spawner)
        let actualDmg = this.dmg;
        if (this.type === 'fire' || this.type === 'ice' || this.type === 'poison' || this.type === 'water' || this.type === 'sand_gun' || this.type === 'elements') {
            actualDmg += (this.level * 2); // Elements apply burst damage to buildings
        }

        if (this.type === 'watch_tower') {
            applyStatusEffect(b, 'watch', this.level || 1, 0, this.sourceOwner, this.type);
        } else if (this.type === 'fire') {
            applyStatusEffect(b, 'fire', this.level || 1, this.dmg * 0.05, this.sourceOwner, this.type);
            if (!isEffectImmune(b, 'fire')) b.energy -= actualDmg;
        } else if (this.type === 'poison') {
            applyStatusEffect(b, 'poison', this.level || 1, this.dmg * 0.1, this.sourceOwner, this.type);
            if (!isEffectImmune(b, 'poison')) b.energy -= actualDmg;
        } else if (this.type === 'water') {
            applyStatusEffect(b, 'water', this.level || 1, 0, this.sourceOwner, this.type);
            if (!isEffectImmune(b, 'water')) b.energy -= actualDmg;
        } else if (this.type === 'ice') {
            applyStatusEffect(b, 'ice', this.level || 1, this.dmg * 0.2, this.sourceOwner, this.type);
            if (!isEffectImmune(b, 'ice')) b.energy -= actualDmg;
        } else if (this.type === 'sand_gun') {
            applyStatusEffect(b, 'sand', this.level || 1, 0, this.sourceOwner, this.type);
            if (!isEffectImmune(b, 'sand')) b.energy -= actualDmg;
        } else if (this.type === 'elements') {
            let appliedAny = false;
            appliedAny = applyStatusEffect(b, 'fire', this.level || 1, this.dmg * 0.2, this.sourceOwner, this.type) || appliedAny;
            appliedAny = applyStatusEffect(b, 'poison', this.level || 1, this.dmg * 0.2, this.sourceOwner, this.type) || appliedAny;
            appliedAny = applyStatusEffect(b, 'water', this.level || 1, 0, this.sourceOwner, this.type) || appliedAny;
            appliedAny = applyStatusEffect(b, 'ice', this.level || 1, this.dmg * 0.2, this.sourceOwner, this.type) || appliedAny;
            appliedAny = applyStatusEffect(b, 'sand', this.level || 1, 0, this.sourceOwner, this.type) || appliedAny;
            if (appliedAny) b.energy -= actualDmg;
        } else {
            b.energy -= actualDmg;
        }

        recordCombatFx(COMBAT_FX.IMPACT, this.startX, this.startY, this.x, this.y, this.type);
        pushHostileDamageAlert(b, buildingEnergyBefore - b.energy, this.sourceOwner);
    recordDamageVisual(b, buildingEnergyBefore - b.energy, this.sourceOwner); shrineDamageTaken(b, buildingEnergyBefore - b.energy);
        if (buildingEnergyBefore > b.energy) playSound('impact', b.x, b.y, this.type);

        createExplosion(this.x, this.y, "#f84", 4);
        if (b.energy <= 0) { createExplosion(b.x, b.y, "#e44", 8); destroyBuilding(b); }
    }
    draw(ctx) {
        ctx.fillStyle = BASE_CARD_TYPES[this.type] ? BASE_CARD_TYPES[this.type].color : '#fff';
        ctx.beginPath(); ctx.arc(this.x, this.y, 4, 0, 6.28); ctx.fill();
    }
}
