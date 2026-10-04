// EVAL probe (host): forced chasers that run Unit.update, by why: their
// mvOn before the movement kernel (armed and handed back, or never armed)
// and the first simMoveTryChase condition that fails. AFTER:
// JSON.stringify(__scratch.fw)
__scratch.fw = {};
{ let pre = null; const fr = simMoveRun; simMoveRun = function () { const S = _simUnitState; pre = S.columns.mvOn.slice(0, S.owners.length); return fr.apply(this, arguments); };
  const f = Unit.prototype.update;
  Unit.prototype.update = function () {
    const c = this._us, s = this._si;
    if (!c || c.mvOut[s] || this.workerState || this.commandState !== CMD_ATTACKING || !this.forcedAttackTarget || this.targetBuilding || !this.targetUnit || this.attackTarget === this.targetUnit || currentTick < 48) return f.call(this);
    const tu = this.targetUnit, on = pre ? pre[s] : -1, k = Math.floor(Math.max(0, Number(_getUnitAttackRangeArea(this)) || 0));
    const hasPath = !!(this.path && this.pathIndex < this.path.length), nd = hasPath ? this.path[this.pathIndex] : null;
    const tx = tu._us ? tu._us.x0[tu._si] : NaN, ty = tu._us ? tu._us.y0[tu._si] : NaN, d = Math.hypot(tx - this.x, ty - this.y) / TILE;
    const why = 'on' + on + ':' + (this.holdPosition ? 'hold' : tu.dead ? 'tdead' : tu._us !== c ? 'tdetached' : k > 1 ? 'range' + Math.min(k, 9) : !(this.preComputed.attackDamage > 0) ? 'nodmg'
      : (hasPath ? (nd.nav ? 'navpath' + (Math.floor(this.y / TILE) * GRID_W + Math.floor(this.x / TILE) === nd.y * GRID_W + nd.x ? ':atdest' : '') : 'plainpath') : 'nopath')
      + ':d' + (d < 2 ? '<2' : d < 6 ? '<6' : d < 8 ? '<8' : '>=8') + (isGameplayTargetVisibleToPlayer(this.owner, Math.floor(tx / TILE), Math.floor(ty / TILE)) ? ':vis' : ':novis'));
    __scratch.fw[why] = (__scratch.fw[why] || 0) + 1;
    return f.call(this);
  }; }
