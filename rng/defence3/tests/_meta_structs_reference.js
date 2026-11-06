// The JavaScript writer of a structure's presentation row (was sim_frame_world.js _simWriteStructure; the
// kernel wasm/src/nfs.rs k_meta_structs writes them now): the reference of tests/meta-structs-kernel.test.cjs.
// (Its label: 0; the test compares the labels' text.)
// (A laser link's table slot, -1 none; columns l0-l3 by name: no key strings.)
function _simLinkSlot(o) { return o && o._sslot !== undefined && _simStructSlots.owner[o._sslot] === o ? o._sslot : -1; }
function _simWriteStructure(F, s, e, kind, tick) {
    F.alive[s] = 1;
    F.serial[s] = _simStructSlots.serials[s];
    F.orderTick[s] = currentTick - 1;
    F.kind[s] = kind;
    let gx = e.gx | 0, gy = e.gy | 0;
    F.gx[s] = gx; F.gy[s] = gy;
    F.x[s] = Number.isFinite(e.x) ? e.x : gx * TILE + TILE * .5;
    F.y[s] = Number.isFinite(e.y) ? e.y : gy * TILE + TILE * .5;
    F.owner[s] = Number.isFinite(e.owner) ? e.owner : (kind === 3 && grid[gy] && grid[gy][gx] ? grid[gy][gx].owner : -1);
    F.type[s] = _simFrameCode(e.type);
    F.utype[s] = _simFrameCode(e.unitType);
    F.energy[s] = Number(e.energy) || 0;
    F.maxEnergy[s] = Number(e.maxEnergy) || Number(e.preComputed && e.preComputed.maxEnergy) || Number(e.preComputedEffective && e.preComputedEffective.maxEnergy) || 0;
    F.spawnTimer[s] = Number(e.spawnTimer) || 0; F.spawnCooldown[s] = Number(e.spawnCooldown) || 0;
    F.stackWork[s] = Number(e.stackingWorkDone) || 0; F.stackReq[s] = Number(e.stackingWorkRequired) || 0;
    F.angle[s] = Number(e.angle) || 0;
    F.cd[s] = Number(e.cd) || 0; F.damage[s] = Number(e.damage) || 0;
    F.amount[s] = kind === 4 ? Number(e.gold) || 0 : kind === 5 ? Number(e.astar) || 0 : 0;
    F.amountMax[s] = kind === 4 ? Number(e.maxGold) || 0 : kind === 5 ? Number(e.maxAstar) || 0 : 0;
    F.timer[s] = Number(e.timer) || 0;
    let at = e.attackTarget, task = e.researchTask;
    F.tx[s] = at ? Number(at.x) || 0 : 0; F.ty[s] = at ? Number(at.y) || 0 : 0;
    F.resDone[s] = task ? Number(task.workDone) || 0 : 0; F.resReq[s] = task ? Number(task.workRequired) || 0 : 0;
    F.rallyX[s] = Number(e.rallyX) || 0; F.rallyY[s] = Number(e.rallyY) || 0;
    F.rallyTargetId[s] = e.rallyTargetUnitId == null ? -1 : e.rallyTargetUnitId;
    F.vision[s] = kind <= 3 ? areaSteps(getEntityEffectiveVisibilityRangeArea(e)) : 0;
    F.level[s] = Number.isFinite(e.level) ? e.level : -1;
    F.elevel[s] = Number.isFinite(e.effectiveLevel) ? e.effectiveLevel : -1;
    F.stacks[s] = Number.isFinite(e.stacks) ? e.stacks : -1;
    F.mstacks[s] = Number.isFinite(e.manualStacks) ? e.manualStacks : -1;
    F.estacks[s] = Number.isFinite(e.effectiveStacks) ? e.effectiveStacks : -1;
    F.stackCount[s] = Number.isFinite(e.stackCount) ? e.stackCount : -1;
    const qn = typeof spawnQueueCount === 'function' ? spawnQueueCount(e) : 0;
    F.qlen[s] = qn;
    F.qtype[s] = qn > 0 ? _simFrameCode(spawnQueueUnitType(e)) : 0;
    F.laser[s] = Number(e.laserState) || 0;
    F.watchedBy[s] = Number.isFinite(e.watchedByTeam) ? e.watchedByTeam : -1;
    let flash = Number(e.attackFlash) || 0;
    F.flash[s] = flash <= 0 ? 0 : flash >= 255 ? 255 : flash;
    let links = e.connectedLasers;
    const linked = Array.isArray(links);
    F.l0[s] = _simLinkSlot(linked ? links[0] : null); F.l1[s] = _simLinkSlot(linked ? links[1] : null);
    F.l2[s] = _simLinkSlot(linked ? links[2] : null); F.l3[s] = _simLinkSlot(linked ? links[3] : null);
    F.flags[s] = (e.underConstruction ? SIM_SF_UC : 0) | (e.isUpgrading ? SIM_SF_UPGRADING : 0) | (e.markedForSalvage ? SIM_SF_SALVAGE : 0)
        | (e.isStacking ? SIM_SF_STACKING : 0) | (e.watched > 0 ? SIM_SF_WATCHED : 0) | (e.burning > 0 ? SIM_SF_BURNING : 0)
        | (e.poisoned > 0 ? SIM_SF_POISONED : 0) | (e.frozen > 0 ? SIM_SF_FROZEN : 0) | (e.wet > 0 ? SIM_SF_WET : 0) | (e.sandy > 0 ? SIM_SF_SANDY : 0)
        | (e.autoUpgradeEnabled ? SIM_SF_AUTO_UPGRADE : 0) | (e.buildEnabled ? SIM_SF_BUILD : 0) | (e.queueEnabled ? SIM_SF_QUEUE : 0)
        | (e.autoResearchEnabled ? SIM_SF_AUTO_RESEARCH : 0) | (at && Number.isFinite(at.x) ? SIM_SF_ATTACK_TARGET : 0)
        | (Number.isFinite(e.rallyX) && Number.isFinite(e.rallyY) ? SIM_SF_RALLY : 0) | (task ? SIM_SF_RESEARCH_TASK : 0)
        | (e.autoStackEnabled ? SIM_SF_AUTO_STACK : 0) | (e.isResearching ? SIM_SF_RESEARCHING : 0);
    F.label[s] = 0;
}

