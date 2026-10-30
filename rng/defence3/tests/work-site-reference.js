// The work site grid's flags as the JavaScript made them before the kernel
// (worker.js at git HEAD 35a027e: _wswFlagsOf, _wswResvOf): the oracle of
// tests/work-site-flags.test.cjs.
var _refWswResMax = new Map();
function _refWswFlagsOf(e, o) {
    let f = 0;
    if (e.markedForSalvage) { if (getTileEntityRef(e.gx, e.gy) === e) f |= WSW_SALVAGE; }
    else if (e.underConstruction) { if (e.buildEnabled !== false) f |= WSW_BUILD; }
    else if (e.isUpgrading || e.isStacking) f |= WSW_BUILD;
    else if (e.energy > 0 && e.energy < e.maxEnergy) f |= WSW_BUILD;
    else if (_isBuilderStackCandidate(e)) f |= WSW_BUILD;
    else if (e.autoUpgradeEnabled !== false && !(e.effectiveLevel <= e.level)) {
        // (_isBuilderUpgradeCandidate, the researched level once a step per
        // owner and building.)
        const base = getThingBaseLevel(e, stackCountToLevel(e.stacks || 1)), eff = getThingEffectiveLevel(e, base);
        if (eff > base) {
            const k = o + ':' + getThingResearchBuildingKey(e);
            let rmax = _refWswResMax.get(k);
            if (rmax === undefined) _refWswResMax.set(k, rmax = getThingResearchedMaxLevel(e));
            if (Math.min(eff, rmax) > base) f |= WSW_BUILD;
        }
    }
    const q = e.spawnQueue;
    if (q && q.length > 0 && _isHealerQueueTarget(e, o)) f |= WSW_QUEUE;
    if (e.type === 'research' && !e.markedForSalvage && e.energy > 0 && !e.underConstruction) { f |= WSW_RESEARCH; if (isAutoResearchEnabled(e)) f |= WSW_AUTORES; }
    return f;
}

function _refWswResvOf(W, t) {
    const NT = Math.min(8, _WORKER_TARGET_LOAD_TYPE_COUNT), base = t * _WORKER_TARGET_LOAD_TYPE_COUNT;
    let rv = 0;
    for (let i = 0; i < NT; i++) { const r = workerReservedAt(base + i); if (r && !r.dead) rv |= 1 << i; }
    return rv;
}

