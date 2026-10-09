"use strict";

// Laser beams: a map made when the links change (laserBeamsTick), not
// looked for each tick: a beam is the tiles strictly between two linked
// lasers. Each tick a helper kernel (SIM_KERNEL_LASER_HITS) finds the units
// on beam tiles (one look-up each); the structures on a beam's tiles are
// listed with it. Units' records come every LASER_REPORT_TICKS ticks, summed.
const LASER_REPORT_TICKS = 4;
const _laserMap = { stale: true, head: null, cap: 0, next: null, beam: null, bown: null, bdmg: null, hit: null, count: null, list: null, beams: [], aTowers: [], set: [] };
function laserMapDirty() { _laserMap.stale = true; }
function _laserMapBuild() {
    const M = _laserMap, W = GRID_W, H = GRID_H;
    M.stale = false;
    if (!M.head || M.head.length !== W * H) { M.head = simSharedArray(Int32Array, W * H).fill(-1); simParallelBind('lz.head', M.head); M.set = []; }
    for (const t of M.set) M.head[t] = -1;
    M.set = [];
    for (const t of M.aTowers) t.laserState = 0;
    const beams = [], aTowers = [], ent = [];
    for (const t of towers) {
        if (t.type !== 'laser' || !t.connectedLasers || !t.connectedLasers.length || t.underConstruction || !(t.energy > 0)) continue;
        t._laserDmgSeen = t.currentStats ? t.currentStats.damage : 0;
        let isA = false;
        for (const o of t.connectedLasers) {
            if (!(t.gx < o.gx || (t.gx === o.gx && t.gy < o.gy))) continue;
            const b = beams.length, vert = t.gx === o.gx;
            const dmg = ((Number(t.currentStats && t.currentStats.damage) || 0) + (Number(o.currentStats && o.currentStats.damage) || 0)) / 60;
            const structs = [];
            const from = vert ? t.gy : t.gx, to = vert ? o.gy : o.gx;
            for (let c = from + 1; c < to; c++) {
                const gx = vert ? t.gx : c, gy = vert ? c : t.gy, k = gy * W + gx;
                if (M.head[k] === -1) M.set.push(k);
                ent.push(b, M.head[k]); M.head[k] = (ent.length >> 1) - 1;
                const e = getTileEntityRef(gx, gy);
                if (e && _projBuildingKind(e) >= 0) structs.push(e);
            }
            beams.push({ a: t, b: o, owner: t.owner, dmg, structs });
            isA = true;
        }
        if (isA) aTowers.push(t);
    }
    const ne = ent.length >> 1, nb = beams.length;
    if (M.cap < Math.max(ne, nb)) {
        const cap = Math.max(1024, 2 * Math.max(ne, nb));
        M.next = simSharedArray(Int32Array, cap); M.beam = simSharedArray(Int32Array, cap);
        M.bown = simSharedArray(Int32Array, cap); M.bdmg = simSharedArray(Float32Array, cap); M.hit = simSharedArray(Uint8Array, cap);
        simParallelBind('lz.next', M.next); simParallelBind('lz.beam', M.beam); simParallelBind('lz.bown', M.bown); simParallelBind('lz.bdmg', M.bdmg); simParallelBind('lz.hit', M.hit);
        M.cap = cap;
    }
    for (let k = 0; k < ne; k++) { M.beam[k] = ent[2 * k]; M.next[k] = ent[2 * k + 1]; }
    for (let b = 0; b < nb; b++) { M.bown[b] = Number.isFinite(beams[b].owner) ? beams[b].owner : -999; M.bdmg[b] = beams[b].dmg; }
    M.beams = beams; M.aTowers = aTowers;
}
// Once a tick, before the towers' updates (gameTick): every beam's damage.
function laserBeamsTick() {
    if (typeof ensureLaserConnections === 'function') ensureLaserConnections();
    const M = _laserMap;
    if (M.stale) _laserMapBuild();
    const nb = M.beams.length;
    if (!nb) return;
    M.hit.fill(0, 0, nb);
    const S = typeof _simUnitState !== 'undefined' ? _simUnitState : null, n = S ? S.owners.length : 0;
    if (n > 0) {
        const chunks = Math.ceil(n / 8192);
        if (!M.count || M.count.length < chunks) { M.count = simSharedArray(Int32Array, Math.max(64, chunks * 2)); simParallelBind('lz.count', M.count); }
        // (The kernel lists each job's reporting slots: no pass over the job's slots here.)
        if (!M.list || M.list.length < n) { M.list = simSharedArray(Int32Array, simReserveCap(n)); simParallelBind('lz.list', M.list); }
        const P = _simParams;
        P[0] = n; P[1] = 8192; P[2] = TILE; P[3] = GRID_W; P[4] = GRID_H; P[5] = gameTime; P[6] = LASER_REPORT_TICKS; P[7] = SIM_SEP_ABSENT;
        simParallelRun(SIM_KERNEL_LASER_HITS, chunks);
        // The records of the units reporting (in slot order).
        const C = S.columns, ACC = C.lzAcc, LB = C.lzBeam, owners = S.owners, LIST = M.list;
        for (let k = 0; k < chunks; k++) {
            for (let j = k * 8192, end = j + M.count[k]; j < end; j++) {
                const s = LIST[j];
                const u = owners[s], d = ACC[s], beam = M.beams[LB[s]];
                ACC[s] = 0;
                if (!u || !beam || !(d > 0)) continue;
                pushHostileDamageAlert(u, d, beam.owner);
                recordDamageVisual(u, d, beam.owner); shrineDamageTaken(u, d);
                tryAutoRetaliateOnHostileDamage(u, beam.a, beam.a.x, beam.a.y);
                createExplosion(u.x, u.y, "#f00", 1);
            }
        }
    }
    // Structures on the beams (in the map's order), then which lasers show lit.
    for (let b = 0; b < nb; b++) {
        const beam = M.beams[b], dmg = beam.dmg;
        for (const e of beam.structs) {
            if (e.owner === beam.owner || !(e.energy > 0) || getTileEntityRef(e.gx, e.gy) !== e) continue;
            M.hit[b] = 1;
            const prev = e.energy;
            e.energy -= dmg;
            pushHostileDamageAlert(e, prev - e.energy, beam.owner);
            recordDamageVisual(e, prev - e.energy, beam.owner); shrineDamageTaken(e, prev - e.energy);
            if ((gameTime % 10) === 0) createExplosion(e.x, e.y, "#f84", 1);
            if (e.energy <= 0) destroyBuilding(e);
        }
    }
    for (const t of M.aTowers) t.laserState = 0;
    let lit = false;
    for (let b = 0; b < nb; b++) if (M.hit[b]) { M.beams[b].a.laserState = 1; lit = true; }
    if (lit && (gameTime % 40) === 0) { const bm = M.beams[0]; playSound('laser_tick', bm.a.x, bm.a.y); }
}
// At a resync, on every peer: the map made again (its structures by object)
// and the units' unreported sums dropped.
function laserBeamsReset() {
    _laserMap.stale = true;
    const S = typeof _simUnitState !== 'undefined' ? _simUnitState : null;
    if (S) S.columns.lzAcc.fill(0);
}
function _getTowerAttackRangeArea(tower) {
    return Math.max(0, Number(tower && tower.currentStats && tower.currentStats.attackRangeArea) || 0);
}

function _isTargetWithinTowerAttackAreaRange(tower, target, rangeArea = NaN) {
    if (!tower || !target) return false;
    let maxAreaDistance = Number.isFinite(rangeArea) ? Math.max(0, Number(rangeArea)) : _getTowerAttackRangeArea(tower);
    return isWorldTargetWithinAreaRange(tower.x, tower.y, target.x, target.y, Math.floor(maxAreaDistance));
}

function _isProducerStructure(e) {
    return e instanceof Barrack || e instanceof CollectorSpawner || e instanceof AstarSpawner || e instanceof SalvagerSpawner
        || e instanceof BuilderSpawner || e instanceof HealerSpawner || e instanceof ResearchSpawner;
}

// Nearest living enemy tower ('tower') or barrack/spawner ('producer') in
// the areas within `wholeRange` steps of the tower; ties go to the lower
// tile index.
function _findTowerStructureTarget(tower, wholeRange, kind) {
    let sources = getSourceAreaIdsAtWorld(tower.x, tower.y);
    if (sources.length === 0) return null;
    let box = getAreaRangeTileBox(sources, wholeRange);
    if (!hasHostileStructureInTileRect(tower.owner, box[0], box[1], box[2], box[3])) return null;
    let best = null, bestD2 = Infinity, bestKey = Infinity;
    let structuresByArea = getStructuresByArea();
    for (let areaId of getAreaIdsWithinDistanceOfSources(sources, wholeRange)) {
        let structures = structuresByArea[areaId];
        if (!structures) continue;
        for (let e of structures) {
            if (e === tower || e.owner === tower.owner || !(e.energy > 0)) continue;
            let isTower = e instanceof Tower;
            if (kind === 'tower' ? !isTower : (isTower || !_isProducerStructure(e))) continue;
            let dx = e.x - tower.x, dy = e.y - tower.y, d2 = dx * dx + dy * dy, key = e.gy * GRID_W + e.gx;
            if (d2 < bestD2 || (d2 === bestD2 && key < bestKey)) { best = e; bestD2 = d2; bestKey = key; }
        }
    }
    return best;
}

// Nearest hostile floor item (never a barrack or spawner) in the tower's
// area range: traps, or everything else. Ties go to the lower tile index.
function _findTowerFloorTarget(tower, rangeArea, traps) {
    let sources = getSourceAreaIdsAtWorld(tower.x, tower.y);
    if (sources.length === 0) return null;
    let best = null, bestD2 = Infinity, bestKey = Infinity;
    let structuresByArea = getStructuresByArea();
    for (let areaId of getAreaIdsWithinDistanceOfSources(sources, Math.floor(Math.max(0, Number(rangeArea) || 0)))) {
        let structures = structuresByArea[areaId];
        if (!structures) continue;
        for (let item of structures) {
            if (item.energy <= 0 || item.underConstruction || isTrapItem(item) !== traps) continue;
            if (getFloorItemAtTile(item.gx, item.gy) !== item) continue;
            let cell = grid[item.gy][item.gx];
            let owner = item.owner !== undefined ? item.owner : cell.owner;
            if (owner === tower.owner || owner < 0) continue;
            let dx = item.x - tower.x, dy = item.y - tower.y, d2 = dx * dx + dy * dy, key = item.gy * GRID_W + item.gx;
            if (d2 < bestD2 || (d2 === bestD2 && key < bestKey)) { best = item; bestD2 = d2; bestKey = key; }
        }
    }
    return best;
}

// ============================================================
// TOWER CLASS
// ============================================================
// Towers act only when due (towersTick): a tower's cooldown is the tick it
// ends (_cdUntil; cd reads and sets the ticks left), and setting it puts the
// tower in the due wheel at the tick after (as the countdown it replaces:
// a cooldown of N set at tick T acts again at T + N + 1). The wheel is made
// anew from every tower after a resync on every peer (towerDueReset).
let _towerDue = null;
function towerDueReset() { _towerDue = null; }
function towerSchedule(t) {
    const W = _towerDue;
    if (!W || !t || t.energy <= 0 || t.underConstruction || (typeof t.type === 'string' && (t.type === 'laser' || t.type.startsWith('cloud')))) return;
    const at = Math.max(gameTime + 1, Math.ceil(Number(t._cdUntil) || 0) + 1);
    let L = W.get(at);
    if (!L) W.set(at, L = []);
    L.push(t);
}
function _towerDueBuild(now) {
    const W = _towerDue = new Map();
    for (const t of towers) {
        if (!t || t.energy <= 0 || t.underConstruction || t.type === 'laser' || (typeof t.type === 'string' && t.type.startsWith('cloud'))) continue;
        const at = Math.max(now, Math.ceil(Number(t._cdUntil) || 0) + 1);
        let L = W.get(at);
        if (!L) W.set(at, L = []);
        L.push(t);
    }
    return W;
}
// A tick of the towers: statuses of those with some running (every tick, as
// ever), then the towers due, in tile order; any whose energy ran out are
// removed (the list from the end, as ever).
function towersTick() {
    let dead = false, st = null;
    for (const e of _thingStatusSelf) if (e instanceof Tower) (st || (st = [])).push(e);
    if (st) {
        st.sort((a, b) => (a.gy * GRID_W + a.gx) - (b.gy * GRID_W + b.gx));
        for (const e of st) { if (e.energy > 0) thingStatusTickSelf(e); if (!(e.energy > 0)) dead = true; }
    }
    const W = _towerDue || _towerDueBuild(gameTime);
    const due = W.get(gameTime);
    if (due) {
        W.delete(gameTime);
        due.sort((a, b) => (a.gy * GRID_W + a.gx) - (b.gy * GRID_W + b.gx));
        let prev = null;
        for (const t of due) {
            if (t === prev) continue;
            prev = t;
            if (t.energy > 0 && getTileEntityRef(t.gx, t.gy) === t) t.act();
            if (!(t.energy > 0)) dead = true;
        }
    }
    if (dead) {
        for (let i = towers.length - 1; i >= 0; i--) if (towers[i].energy <= 0) destroyBuilding(towers[i]);
        for (const e of [..._thingStatusSelf]) if ((e instanceof Tower) && !(e.energy > 0) && getTileEntityRef(e.gx, e.gy) !== e) _thingStatusSelf.delete(e);
    }
}

class Tower {
    // (The cooldown: see towerSchedule.)
    get cd() { return Math.max(0, (Number(this._cdUntil) || 0) - gameTime); }
    set cd(v) { this._cdUntil = gameTime + Math.max(0, Number(v) || 0); towerSchedule(this); }
    constructor(gx, gy, type, owner, startStacks = 1) {
        if (typeof structTableInit === 'function') structTableInit(this);
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
        // effectiveLevel the current connectedLasers were computed with.
        this._laserLinkLevel = -1;
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
        if (typeof visCoverOnBuildingChanged === 'function') visCoverOnBuildingChanged(this);
        if (this.type === 'laser' && this.connectedLasers) this.laserCheck();
    }

    calcStats(lvl) {
        return calculateItemStats(this.type, lvl, this.owner);
    }

    update() {
        if (this.energy <= 0) return;
        thingStatusTickSelf(this);
        this.act();
    }

    // Its turn (towersTick: due, its cooldown over).
    act() {
        if (this.energy <= 0) return;
        if (this.underConstruction) {
            let requiredEnergy = Math.max(1, Math.floor(getUpgrademaxEnergy(this, 1) || this.maxEnergy || 1));
            if ((Number(this.energy) || 0) >= requiredEnergy) markConstructionComplete(this);
            if (this.underConstruction) return;
        }
        if (this.type.startsWith('cloud')) return;

        if (this.type === 'laser') { this.laserCheck(); return; }

        if (this.cd > 0) return;
        this.shoot();
    }

    // A laser's beams are the map's (laserBeamsTick). Reach depends on its
    // effective level (0 while under construction, adjacency, upgrades),
    // damage on its stats: relinked when they move (checked where its stats
    // are made: updateStats).
    laserCheck() {
        if (this.type !== 'laser') return;
        if (this._laserLinkLevel !== this.effectiveLevel) { if (typeof markLaserConnectionsDirty === 'function') markLaserConnectionsDirty(); if (typeof laserMapDirty === 'function') laserMapDirty(); }
        else if (this.currentStats && this._laserDmgSeen !== this.currentStats.damage && this.connectedLasers && this.connectedLasers.length && typeof laserMapDirty === 'function') laserMapDirty();
    }

    shoot() {
        if (this.cd > 0) return;
        let rangeArea = _getTowerAttackRangeArea(this);
        let projectileMaxRange = Math.max(WORLD_W, WORLD_H) * 2;
        let preferredTarget = getTowerPreferredTargetInRange(this, rangeArea);
        if (preferredTarget) {
            let target = preferredTarget;
            projectiles.push(new Projectile(this.x, this.y, target, this.type, this.currentStats.damage, getThingEffectiveLevel(this), this, projectileMaxRange, this.currentStats.blastDamage, this.currentStats.blastRadius));
            this.cd = secondsToTicks(this.currentStats.cd || 1.5);
            this.angle = Math.atan2(target.y - this.y, target.x - this.x);
            recordCombatFx(COMBAT_FX.MUZZLE, this.x, this.y, target.x, target.y, this.type);
            playSound('shoot_' + this.type, this.x, this.y);
            return;
        }
        let bestPrimary = null, bestSecondary = null, bestImmune = null;
        let dPrimary = Infinity, dSecondary = Infinity, dImmune = Infinity;

        // Every unit in the areas within floor(range) steps is in range (the
        // area of its tile is its bucket's), so no per-unit range check.
        let wholeRange = Math.floor(rangeArea);
        forEachUnitInAreaRange(this.x, this.y, wholeRange, (u) => {
            if (u.turretImmune) return;
            let dx = u.x - this.x;
            let dy = u.y - this.y;
            let d2 = dx * dx + dy * dy;
            let d = Math.sqrt(d2);

            let immune = (this.type === 'fire' && u.fireResistant) || (this.type === 'water' && u.waterResistant) ||
                (this.type === 'poison' && u.poisonResistant) || (this.type === 'ice' && u.iceResistant) ||
                (this.type === 'elements' && (u.waterResistant || u.fireResistant || u.poisonResistant || u.iceResistant));

            if (immune) { if (d < dImmune) { dImmune = d; bestImmune = u; } }
            else {
                let affected = false;
                if (this.type === 'fire') affected = u.burning > 0;
                else if (this.type === 'poison') affected = u.poisoned > 0;
                else if (this.type === 'water') affected = u.wet > 0;
                else if (this.type === 'ice') affected = u.frozen > 0;
                else if (this.type === 'sand_gun') affected = u.sandy > 0;
                else if (this.type === 'watch_tower') affected = u.watched > 0 && u.watchedByTeam === this.owner;
                if (!affected) { if (d < dPrimary) { dPrimary = d; bestPrimary = u; } }
                else { if (d < dSecondary) { dSecondary = d; bestSecondary = u; } }
            }
        }, { enemyOfPlayer: this.owner, areaOnly: true });

        let target = bestPrimary || bestSecondary || bestImmune;

        // If no unit target, the nearest enemy building in range: towers
        // first, then traps, then barracks and spawners, then other floor
        // buildings. Only the structures in the areas in range are visited.
        if (!target) {
            this.cd = secondsToTicks(this.currentStats.cd || 1.5);
            target = _findTowerStructureTarget(this, wholeRange, 'tower');
            if (!target) target = _findTowerFloorTarget(this, rangeArea, true);
            if (!target) target = _findTowerStructureTarget(this, wholeRange, 'producer');
            if (!target) target = _findTowerFloorTarget(this, rangeArea, false);
        }

        if (target) {
            projectiles.push(new Projectile(this.x, this.y, target, this.type, this.currentStats.damage, getThingEffectiveLevel(this), this, projectileMaxRange, this.currentStats.blastDamage, this.currentStats.blastRadius));
            this.cd = secondsToTicks(this.currentStats.cd || 1.5);
            this.angle = Math.atan2(target.y - this.y, target.x - this.x);
            recordCombatFx(COMBAT_FX.MUZZLE, this.x, this.y, target.x, target.y, this.type);
            playSound('shoot_' + this.type, this.x, this.y);
        }
    }

    draw(ctx) {
        const gameTime = this._historyGhost ? this._historyTick : getRenderGameTime();
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
                if (shouldShowBuildingLevels(this)) drawLevelTextCache(ctx, this, this.x, this.y);
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
        if (shouldShowBuildingLevels(this)) drawLevelTextCache(ctx, this, this.x, this.y);

        // Energy bar (single bar for damage/progress)
        if (!this.underConstruction && !this.isUpgrading) {
            drawBuildingEnergyProgressBar(ctx, this, this.x, this.y + 14, 24, 3);
        }
    }
}
if (typeof structTableAccessors === 'function') structTableAccessors(Tower, 0x22);
