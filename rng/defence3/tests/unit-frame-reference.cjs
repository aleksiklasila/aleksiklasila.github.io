// Scalar encoder before shared unit columns: independent numerical oracle.
module.exports = function simFrameEncode() {
    let R = _simRenderSlots;
    let stampTick = ++R.tick;
    let list = units, count = list.length;
    // Slots first (a new unit takes one), so the size is known.
    let live = 0;
    for (let i = 0; i < count; i++) { let u = list[i]; if (!u.dead) { _simRenderSlotOf(u); live++; } }
    let n = R.owner.length;
    let cap = Math.max(64, n);
    let buf = _simFrameAcquire(cap * SIM_FRAME_SLOT_BYTES);
    let F = simFrameViews(buf, cap);
    if (R.stamp.length < n) { let grown = new Int32Array(Math.max(1024, n * 2)); grown.set(R.stamp); R.stamp = grown; }
    let order = F.order, k = 0, orderChanged = !_simFrameOrderLast || _simFrameOrderLast.length !== live;
    let flagsA = F.flags;
    for (let i = 0; i < count; i++) {
        let u = list[i];
        if (u.dead) continue;
        let s = u._rslot;
        R.stamp[s] = stampTick;
        if (!orderChanged && _simFrameOrderLast[k] !== s) orderChanged = true;
        order[k++] = s;
        F.id[s] = u.id;
        F.x[s] = u.x; F.y[s] = u.y; F.px[s] = R.lastX[s]; F.py[s] = R.lastY[s];
        R.lastX[s] = u.x; R.lastY[s] = u.y;
        F.vx[s] = Number(u.vx) || 0; F.vy[s] = Number(u.vy) || 0;
        F.energy[s] = u.energy;
        let pc = u.preComputed;
        F.maxEnergy[s] = pc ? pc.maxEnergy : u.energy;
        F.r[s] = u.r;
        let at = u.attackTarget;
        let flags = (u.isFlying ? SIM_UF_FLYING : 0) | (u.isSnake ? SIM_UF_SNAKE : 0) | (u.isWorker ? SIM_UF_WORKER : 0)
            | (u.holdPosition ? SIM_UF_HOLD : 0) | (u.burning > 0 ? SIM_UF_BURNING : 0) | (u.poisoned > 0 ? SIM_UF_POISONED : 0)
            | (u.frozen > 0 ? SIM_UF_FROZEN : 0) | (u.wet > 0 ? SIM_UF_WET : 0) | (u.sandy > 0 ? SIM_UF_SANDY : 0)
            | (u.watched > 0 ? SIM_UF_WATCHED : 0) | (u.teleportHideTicks > 0 ? SIM_UF_HIDDEN : 0)
            | (Number.isFinite(u._energyBlockedUntil) && gameTime < u._energyBlockedUntil ? SIM_UF_ENERGY_BLOCKED : 0)
            | (u.researcherHasMaterial ? SIM_UF_RESEARCH_MATERIAL : 0) | (u.workerTransferCooldown > 0 ? SIM_UF_TRANSFER : 0)
            | (at && Number.isFinite(at.x) ? SIM_UF_ATTACK_TARGET : 0) | (u.isKing ? SIM_UF_KING : 0);
        flagsA[s] = flags;
        F.tx[s] = at ? at.x : 0; F.ty[s] = at ? at.y : 0;
        let eff = u.preComputedEffective;
        F.vision[s] = eff && Number.isFinite(eff.visionRangeArea) ? eff.visionRangeArea : getEntityEffectiveVisibilityRangeArea(u);
        F.cargo[s] = Number(u.carryingValue) || 0;
        F.owner[s] = u.owner;
        F.watchedBy[s] = Number.isFinite(u.watchedByTeam) ? u.watchedByTeam : -1;
        F.level[s] = Number.isFinite(u.effectiveLevel) ? u.effectiveLevel : -1;
        F.blevel[s] = Number.isFinite(u.unitLevel) ? u.unitLevel : -1;
        F.type[s] = _simFrameCode(u.unitType);
        F.wtype[s] = _simFrameCode(u.workerType);
        F.wstate[s] = _simFrameCode(u.workerState);
        F.style[s] = _simFrameCode(u.attackStyle);
        let flash = Number(u.attackFlash) || 0;
        F.flash[s] = flash <= 0 ? 0 : flash >= 255 ? 255 : flash;
        F.cmd[s] = u.commandState | 0;
        // Look: activity, facing, walk phase, status face, own light, panel.
        if (u.isSnake) {
            let act = getUnit3DActivity(u);
            F.mode[s] = 0; F.amount[s] = 0;
            F.facing[s] = Math.atan2(Number(u.vx) || 0, Number(u.vy) || 1);
            F.phase[s] = 0; F.prate[s] = 0;
            F.status[s] = _simUnitStatusCode[getUnit3DStatusState(u, act)] || 0;
        } else {
            let activity = getUnit3DActivity(u);
            if (activity.mode !== 0 || activity.amount > 0 || u._visStill === undefined) u._visStill = gameTime;
            activity = _unit3DIdleActivity(u, activity, u._visStill);
            let fx = Number(u.vx) || 0, fy = Number(u.vy) || 0;
            if (activity.target && Number.isFinite(activity.target.x) && Number.isFinite(activity.target.y)) {
                fx = activity.target.x - u.x; fy = activity.target.y - u.y;
            }
            F.mode[s] = activity.mode;
            F.amount[s] = Math.max(0, Math.min(1, activity.amount || Math.min(1, Math.hypot(u.x - u.prevX, u.y - u.prevY) / Math.max(.01, TILE * .025)) || 0));
            F.facing[s] = Math.atan2(fx, fy || 0.0001) || 0;
            _unit3DWalkPhaseLinear(u, activity, _simVisPhase);
            F.phase[s] = _simVisPhase[0]; F.prate[s] = _simVisPhase[1];
            F.status[s] = _simUnitStatusCode[getUnit3DStatusState(u, activity)] || 0;
        }
        F.light[s] = getVisualUnitSourceLight(u);
        F.sig[s] = _simSignatureHash(u);
    }
    // Slots of units no longer in the list are free again (marked empty).
    for (let slot = 0; slot < n; slot++) {
        if (R.stamp[slot] !== stampTick) {
            F.id[slot] = -1; flagsA[slot] = 0;
            if (R.owner[slot]) { R.owner[slot]._rslot = undefined; R.owner[slot] = null; R.free.push(slot); R.version++; }
        }
    }
    if (orderChanged) { _simFrameOrderLast = order.slice(0, live); R.version++; }
    return { buf, cap, n, count: live, mver: R.version };
};
