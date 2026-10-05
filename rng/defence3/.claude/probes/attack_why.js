// Attacking combat units (c3) that ran Unit.update, by kind (in range of a
// unit target, chasing one, a structure) and why the movement kernel did
// not take them: 'armedN-handback' (armed as mvOn N before the kernel, it
// handed the unit back), else the first unmet arming condition of
// simMoveTryHold / simMoveTryChase as the unit stands before its update.
// Use: EVAL="$(cat .claude/probes/attack_why.js)" AFTER='JSON.stringify(__scratch.aw)'
// (ms and calls per tick from tick 48 on).
(() => {
    __scratch.aw = {};
    let pre = null;
    const fr = simMoveRun;
    simMoveRun = function () { const S = _simUnitState; pre = S ? S.columns.mvOn.slice(0, S.owners.length) : null; return fr.apply(this, arguments); };
    const why = (u, kind) => {
        const c = u._us, s = u._si, p = pre ? pre[s] : -1;
        if (p > 0) return 'armed' + p + '-handback';
        const tu = u.targetUnit;
        if (u.holdPosition) return 'holdPos';
        if (kind === 'bld') {
            const tb = u.targetBuilding;
            if (u.path) return 'path';
            if (u.attackTarget !== tb) return 'notAttackTarget';
            if (!(u.attackTimer > 0)) return 'timer0';
            const k = Math.floor(Math.max(0, Number(_getUnitAttackRangeArea(u)) || 0));
            if (!(k <= 2)) return 'range' + Math.min(k, 9);
            return 'other';
        }
        if (!tu || tu.dead) return 'tdead';
        const k = Math.floor(Math.max(0, Number(_getUnitAttackRangeArea(u)) || 0));
        if (kind === 'inrange') {
            if (u.path) return 'path' + (u.pathIndex < u.path.length ? ':left' : ':done');
            if (!(u.attackTimer > 0)) return 'timer0';
            if (!(k <= 1)) return 'long' + Math.min(k, 9);
            return 'other';
        }
        // chase
        if (!(u.preComputed && u.preComputed.attackDamage > 0)) return 'nodmg';
        if (!(k <= 1)) return 'range' + Math.min(k, 9);
        if (u._spatialEpoch !== spatialEpoch || c.sepKey[s] === SIM_SEP_ABSENT) return 'notIndexed';
        const hasPath = !!(u.path && u.pathIndex < u.path.length);
        return 'other' + (hasPath ? ':path' : ':nopath') + (u.forcedAttackTarget ? ':forced' : '');
    };
    const f = Unit.prototype.update;
    Unit.prototype.update = function () {
        const c = this._us;
        if (!c || c.mvOut[this._si] || this.workerState || this.commandState !== CMD_ATTACKING) return f.call(this);
        const kind = this.targetBuilding ? 'bld' : this.targetUnit && this.attackTarget === this.targetUnit ? 'inrange' : 'chase';
        const k = kind + ':' + why(this, kind);
        const a = __scratch.realNow();
        try { return f.call(this); } finally {
            if (currentTick >= 48) { const e = (__scratch.aw[k] ||= [0, 0]); e[0] += __scratch.realNow() - a; e[1]++; }
        }
    };
})();
