"use strict";
// (Contexts without data_static.js, the unit tests': one base tick a step.)
if (typeof simDk === 'undefined') {
    globalThis.simDk = 1;
    globalThis.simStepCrosses = (phase, period) => !(period > 1) || ((((globalThis.gameTime | 0) + phase) % period) + period) % period < globalThis.simDk;
    globalThis.simStepPhases = period => [(((globalThis.gameTime | 0) % period) + period) % period];
}

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

// ---- Native flight (wasm/src/proj.rs k_proj_flight) ----
// Every shot's base ticks of the step on the helpers: its first event (a unit
// hit, a structure hit, its floor target, out of range or life) from the
// typed unit index, unit columns and tile table, no object reads. The events
// are applied here in the shots' order (the JavaScript loop's), each target
// checked again: an earlier shot of the phase may have killed or destroyed
// it, and then that shot flies on in JavaScript from that base tick (kills
// only remove candidates, so a target still standing is still the first).
let SIM_PROJECTILE_WASM = true;
const SIM_PROJ_FLIGHT_MIN = 256, SIM_PROJ_FLIGHT_PER_JOB = 512;
// (Room for this many shots from the first use: grown past it only.)
const SIM_PROJ_FLIGHT_RESERVE = 65536;
const _pjf = { cap: 0, a: {}, stats: { steps: 0, shots: 0, rechecks: 0, js: 0 } };
const _PJF_F64 = ['x', 'y', 'vx', 'vy', 'life', 'sx', 'sy', 'range', 'ox', 'oy', 'px', 'py', 'ol', 'pl'], _PJF_I32 = ['own', 'ft', 'ev', 'arg'];
function _pjfReserve(n) {
    if (_pjf.cap >= n) return;
    const cap = simReserveCap(Math.max(n, SIM_PROJ_FLIGHT_RESERVE), 4096);
    for (const [names, Type] of [[_PJF_F64, Float64Array], [_PJF_I32, Int32Array]]) for (const k of names) {
        const old = _pjf.a[k];
        _pjf.a[k] = simSharedArray(Type, cap);
        simParallelBind('pj.' + k, _pjf.a[k]);
        if (old) simHeapFree(old);
    }
    _pjf.cap = cap;
}
function _projFlightReady(n) {
    if (!SIM_PROJECTILE_WASM || n < SIM_PROJ_FLIGHT_MIN || CHUNK_SIZE !== 1 || typeof SIM_KERNEL_PROJ_FLIGHT !== 'number') return false;
    if (typeof _simWasmX === 'undefined' || !_simWasmX || typeof _simWasmX.k_proj_flight !== 'function' || !_simWasmOk(_simParReg)) return false;
    const S = typeof _simUnitState !== 'undefined' ? _simUnitState : null;
    if (!S || _sxOwners() === null || _ST.n !== GRID_W * GRID_H) return false;
    const R = _simParReg, C = S.columns;
    return R['ix.stamp'] === _sxStamp && R['ix.start'] === _sxStart && R['ix.cnt'] === _sxCount && R['sep.eslot'] === _sxESlot
        && R['unit.x'] === C.x && R['unit.y'] === C.y && R['unit.r'] === C.r && R['unit.dead'] === C.dead && R['unit.live'] === C.live && R['unit.owner'] === C.owner;
}
// A shot's base ticks in JavaScript (its update, or its rest after a target
// the kernel named went down earlier in the phase).
function _projectileFly(p, ticks) {
    for (let k = ticks; k > 1; k--) if (!p._tick()) return false;
    return p._tick();
}
// The step's flight for all shots: false when not available (the JavaScript
// loop flies them), else the mask of the shots that ended (spent[i] 1; how
// many in _pjf.ended).
function projectilesAdvanceNative() {
    const n = projectiles.length;
    if (n < SIM_PROJ_FLIGHT_MIN) return false;
    spatialIndexEnsure();
    if (!_projFlightReady(n)) return false;
    _pjfReserve(n);
    const A = _pjf.a, X = A.x, Y = A.y, VX = A.vx, VY = A.vy, L = A.life, SX = A.sx, SY = A.sy, RG = A.range, OW = A.own, FT = A.ft;
    for (let i = 0; i < n; i++) {
        const p = projectiles[i];
        X[i] = p.x; Y[i] = p.y; VX[i] = p.vx; VY[i] = p.vy; L[i] = p.life; SX[i] = p.startX; SY[i] = p.startY; RG[i] = p.maxRange;
        const o = p.sourceOwner; OW[i] = Number.isFinite(o) ? Math.floor(o) : -1;
        FT[i] = p.floorTargetGx >= 0 ? p.floorTargetGy * GRID_W + p.floorTargetGx : -1;
    }
    for (const key of ['code', 'own', 'val', 'brain']) simParallelBind('st.' + key, _ST[key]);
    const cplxOk = spatialUnitsComplex.length > 0 && spatialUnitsComplexStridePerChunk > 0 && spatialUnitsComplexStridePerPlayer > 0;
    if (cplxOk) simParallelBind('ix.complex', spatialUnitsComplex);
    const P = _simParams, per = Math.max(SIM_PROJ_FLIGHT_PER_JOB, Math.ceil(n / 64));
    P[0] = n; P[1] = per; P[2] = simDk; P[3] = GRID_W; P[4] = GRID_H; P[5] = TILE; P[6] = _sxEpoch;
    P[7] = spatialUnitsComplexPlayerCount; P[8] = cplxOk && _simParReg['ix.complex'] === spatialUnitsComplex ? spatialUnitsComplexStridePerChunk : 0; P[9] = GRID_W * GRID_H;
    simParallelRun(SIM_KERNEL_PROJ_FLIGHT, Math.ceil(n / per));
    const EV = A.ev, ARG = A.arg, OX = A.ox, OY = A.oy, PX = A.px, PY = A.py, OL = A.ol, PL = A.pl, owners = _simUnitState.owners;
    if (!_pjf.spent || _pjf.spent.length < n) _pjf.spent = new Uint8Array(_pjf.cap);
    const spent = _pjf.spent;
    spent.fill(0, 0, n);
    let ended = 0, rechecks = 0, js = 0;
    for (let i = n - 1; i >= 0; i--) {
        const p = projectiles[i], e = EV[i], kind = e & 15, j = e >> 4;
        let alive = true, again = kind === 5;
        if (kind === 5) js++;
        else {
            p.x = OX[i]; p.y = OY[i]; p.life = OL[i];
            if (kind === 0) alive = true;
            else if (kind === 4) alive = false;
            else if (kind === 1) {
                const u = owners[ARG[i]];
                if (u && !u.dead) { p.hit(u); alive = false; } else again = true;
            } else {
                const t = ARG[i], gx = t % GRID_W, gy = (t - gx) / GRID_W;
                const b = kind === 2 ? getTileEntityRef(gx, gy) : getFloorItemAtTile(gx, gy);
                const ok = !!b && b.owner !== p.sourceOwner && (kind === 2 ? _projBuildingKind(b) >= 0 && !(b.energy <= 0) : b.energy > 0);
                if (ok) { p.hitBuilding(b); alive = false; } else again = true;
            }
            if (again) rechecks++;
        }
        if (again) { p.x = PX[i]; p.y = PY[i]; p.life = PL[i]; alive = _projectileFly(p, simDk - j + 1); }
        if (!alive) { spent[i] = 1; ended++; }
    }
    const st = _pjf.stats; st.steps++; st.shots += n; st.rechecks += rechecks; st.js += js;
    _pjf.ended = ended;
    return spent;
}
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
    // Structure centres belong to their own tiles. The radius already
    // covers every possible hit tile; expanding it another tile on all
    // sides made every projectile inspect 16–25 cells instead of 4–9.
    const gx0 = Math.max(0, Math.floor((p.x - 18) / TILE)), gx1 = Math.min(GRID_W - 1, Math.floor((p.x + 18) / TILE));
    const gy0 = Math.max(0, Math.floor((p.y - 18) / TILE)), gy1 = Math.min(GRID_H - 1, Math.floor((p.y + 18) / TILE));
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

    // A step: its base ticks (simDk) one at a time (a shot's hit is looked
    // for where it is each base tick: one stride of several passed by).
    update() { return _projectileFly(this, simDk); }
    _tick() {
        this.x += this.vx; this.y += this.vy;
        this.life--;

        // This check runs once per base tick of every projectile. Keeping it
        // inline avoids allocating a second closure for every flight step.
        if (forEachUnitInRange(this.x, this.y, 16, (u) => {
                let hitRange = u.r + 8;
                let dx = u.x - this.x, dy = u.y - this.y;
                if (dx * dx + dy * dy <= hitRange * hitRange) {
                    this.hit(u);
                    return true;
                }
            }, { enemyOfPlayer: this.sourceOwner })) return false;
        let b = _projectileBuildingHit(this);
        if (b) { this.hitBuilding(b); return false; }
        if (this.floorTargetGx >= 0) {
            let item = getFloorItemAtTile(this.floorTargetGx, this.floorTargetGy);
            if (item && item.owner !== this.sourceOwner && item.energy > 0
                && detHypot(item.x - this.x, item.y - this.y) <= 18) { this.hitBuilding(item); return false; }
        }
        if (detHypot(this.x - this.startX, this.y - this.startY) >= this.maxRange || this.life <= 0) return false;
        return true;
    }
    hit(t) {
        let sourceAttacker = this.getSourceAttacker();
        if (t.turretImmune) { createExplosion(t.x, t.y, "#888", 3); return; }
        let targetEnergyBefore = t.energy;
        // (A tower's shots of a step together (tower.js _towerProjectile):
        // their damage at once, a status's tick damage of one.)
        let baseDmg = this.dmg / (this.shots > 1 ? this.shots : 1);
        let splashDmg = Number.isFinite(this.blastDamage) ? this.blastDamage : this.dmg;
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

        if (hasBlast) {
            forEachUnitInRange(this.x, this.y, splashRadiusPx, (e) => {
                if (e === t || e.turretImmune) return;
                let prevEnergy = e.energy;
                e.energy -= splashDmg;
                pushHostileDamageAlert(e, prevEnergy - e.energy, this.sourceOwner);
        recordDamageVisual(e, prevEnergy - e.energy, this.sourceOwner); shrineDamageTaken(e, prevEnergy - e.energy);
                if (this.type === 'fire') applyStatusEffect(e, 'fire', this.level || 1, splashDmg * 0.05, this.sourceOwner, this.type);
                if (e.energy <= 0 && !e.dead) e.dead = true;
            }, { enemyOfPlayer: this.sourceOwner });
        }
        if (t.energy <= 0 && !t.dead) { t.dead = true; createExplosion(t.x, t.y, "#e44", 6); }
    }
    hitBuilding(b) {
        let buildingEnergyBefore = b.energy;
        // Apply damage to a building (tower, barrack, spawner)
        let actualDmg = this.dmg, dotDmg = this.dmg / (this.shots > 1 ? this.shots : 1);
        if (this.type === 'fire' || this.type === 'ice' || this.type === 'poison' || this.type === 'water' || this.type === 'sand_gun' || this.type === 'elements') {
            actualDmg += (this.level * 2); // Elements apply burst damage to buildings
        }

        if (this.type === 'watch_tower') {
            applyStatusEffect(b, 'watch', this.level || 1, 0, this.sourceOwner, this.type);
        } else if (this.type === 'fire') {
            applyStatusEffect(b, 'fire', this.level || 1, dotDmg * 0.05, this.sourceOwner, this.type);
            if (!isEffectImmune(b, 'fire')) b.energy -= actualDmg;
        } else if (this.type === 'poison') {
            applyStatusEffect(b, 'poison', this.level || 1, dotDmg * 0.1, this.sourceOwner, this.type);
            if (!isEffectImmune(b, 'poison')) b.energy -= actualDmg;
        } else if (this.type === 'water') {
            applyStatusEffect(b, 'water', this.level || 1, 0, this.sourceOwner, this.type);
            if (!isEffectImmune(b, 'water')) b.energy -= actualDmg;
        } else if (this.type === 'ice') {
            applyStatusEffect(b, 'ice', this.level || 1, dotDmg * 0.2, this.sourceOwner, this.type);
            if (!isEffectImmune(b, 'ice')) b.energy -= actualDmg;
        } else if (this.type === 'sand_gun') {
            applyStatusEffect(b, 'sand', this.level || 1, 0, this.sourceOwner, this.type);
            if (!isEffectImmune(b, 'sand')) b.energy -= actualDmg;
        } else if (this.type === 'elements') {
            let appliedAny = false;
            appliedAny = applyStatusEffect(b, 'fire', this.level || 1, dotDmg * 0.2, this.sourceOwner, this.type) || appliedAny;
            appliedAny = applyStatusEffect(b, 'poison', this.level || 1, dotDmg * 0.2, this.sourceOwner, this.type) || appliedAny;
            appliedAny = applyStatusEffect(b, 'water', this.level || 1, 0, this.sourceOwner, this.type) || appliedAny;
            appliedAny = applyStatusEffect(b, 'ice', this.level || 1, dotDmg * 0.2, this.sourceOwner, this.type) || appliedAny;
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
