// EVAL probe (host): moving combat units (CMD_MOVING / CMD_ATTACK_MOVING)
// that run Unit.update, by why: mvOn before the movement kernel (0: not
// armed; else armed and handed back), their path (none, nav node, plain),
// a pending target (waiting for a substitute / route), on a hostile
// structure's tile, at the path's node tile. AFTER: JSON.stringify(__scratch.mw)
__scratch.mw = {};
{ let pre = null, preFl = null; const fr = simMoveRun; simMoveRun = function () { const S = _simUnitState; pre = S.columns.mvOn.slice(0, S.owners.length); preFl = S.columns.mvFlags.slice(0, S.owners.length); return fr.apply(this, arguments); };
  const f = Unit.prototype.update;
  Unit.prototype.update = function () {
    const c = this._us, s = this._si, cmd = this.commandState;
    if (!c || c.mvOut[s] || this.workerState || (cmd !== CMD_MOVING && cmd !== CMD_ATTACK_MOVING) || currentTick < 48) return f.call(this);
    const on = pre ? pre[s] : -1, fl = preFl ? preFl[s] : 0, p = this.path, i = this.pathIndex, nd = p && i < p.length ? p[i] : null;
    const gx = Math.floor(this.x / TILE), gy = Math.floor(this.y / TILE), cell = grid[gy] && grid[gy][gx];
    const hostileFloor = cell && cell.item && cell.owner !== this.owner && !cell.item.underConstruction;
    const why = (cmd === CMD_MOVING ? 'mv' : 'am') + ':on' + on + (on ? ':f' + fl : '') + ':' + (!p ? 'nopath' : i >= p.length ? 'pathdone' : nd.nav ? 'nav' + (gy * GRID_W + gx === nd.y * GRID_W + nd.x ? ':atnode' : '') : 'plain')
      + (this._pendingPathTarget ? ':pending' : '') + (hostileFloor ? ':hostilefloor' : '') + (this.holdPosition ? ':hold' : '') + (this.frozen > 0 ? ':frozen' : '');
    __scratch.mw[why] = (__scratch.mw[why] || 0) + 1;
    return f.call(this);
  }; }
