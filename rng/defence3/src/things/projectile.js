"use strict";

// ============================================================
// PROJECTILE CLASS
// ============================================================
class Projectile {
    constructor(x, y, t, type, dmg, level, source, maxRange, blastDamage = NaN, blastRadius = NaN) {
        this.x = x; this.y = y; this.prevX = x; this.prevY = y; this.type = type; this.speed = 8; this.life = 100;
        this.startX = x; this.startY = y; this.maxRange = maxRange || 9999;
        let a = Math.atan2(t.y - y, t.x - x);
        this.vx = Math.cos(a) * 8; this.vy = Math.sin(a) * 8;
        this.dmg = dmg; this.level = level;
        this.blastDamage = Number.isFinite(blastDamage) ? Math.max(0, blastDamage) : NaN;
        this.blastRadius = Number.isFinite(blastRadius) ? Math.max(0, blastRadius) : NaN;
        this.sourceOwner = source ? source.owner : -1;
        this.sx = source ? source.gx : -1;
        this.sy = source ? source.gy : -1;
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
            for (let list of [towers, barracks, collectorSpawners]) {
                for (let b of list) {
                    if (b.owner === this.sourceOwner || b.energy <= 0) continue;
                    if (Math.hypot(b.x - this.x, b.y - this.y) <= 18) { this.hitBuilding(b); return true; }
                }
            }
            return false;
        };

        if (checkHits()) return false;
        if (Math.hypot(this.x - this.startX, this.y - this.startY) >= this.maxRange || this.life <= 0) return false;
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

        pushHostileDamageAlert(t, targetEnergyBefore - t.energy, this.sourceOwner);
    recordDamageVisual(t, targetEnergyBefore - t.energy, this.sourceOwner);
        tryAutoRetaliateOnHostileDamage(t, sourceAttacker, Number.isFinite(this.sx) ? this.sx * TILE + 16 : null, Number.isFinite(this.sy) ? this.sy * TILE + 16 : null);

        if (hasBlast) {
            forEachUnitInRange(this.x, this.y, splashRadiusPx, (e) => {
                if (e === t || e.turretImmune) return;
                let prevEnergy = e.energy;
                e.energy -= splashDmg;
                pushHostileDamageAlert(e, prevEnergy - e.energy, this.sourceOwner);
        recordDamageVisual(e, prevEnergy - e.energy, this.sourceOwner);
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

        pushHostileDamageAlert(b, buildingEnergyBefore - b.energy, this.sourceOwner);
    recordDamageVisual(b, buildingEnergyBefore - b.energy, this.sourceOwner);

        createExplosion(this.x, this.y, "#f84", 4);
        if (b.energy <= 0) { createExplosion(b.x, b.y, "#e44", 8); destroyBuilding(b); }
    }
    draw(ctx) {
        ctx.fillStyle = BASE_CARD_TYPES[this.type] ? BASE_CARD_TYPES[this.type].color : '#fff';
        ctx.beginPath(); ctx.arc(this.x, this.y, 4, 0, 6.28); ctx.fill();
    }
}