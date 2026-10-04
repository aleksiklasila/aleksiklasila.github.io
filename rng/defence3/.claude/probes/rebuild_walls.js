// EVALALL probe (every peer): at gameTime WALL_AT (default 200) a wall line
// down the middle of the map (floor tiles without items), which starts a
// navigation rebuild (navTick) on every peer at the same tick.
{ const at = Number(globalThis.__wallAt || 200), f = runOneTick;
  runOneTick = function () {
    if (gameTime === at) {
      let n = 0; const gx0 = GRID_W >> 1;
      for (let gy = Math.floor(GRID_H * 0.25); gy < Math.floor(GRID_H * 0.75); gy++) {
        const c = grid[gy][gx0];
        if (c.type === TYPE_FLOOR && !c.item && !getTileEntityRef(gx0, gy)) { c.type = TYPE_WALL; simMoveTileTypeChanged(gx0, gy); n++; }
      }
      __scratch.wallsSet = [gameTime, n];
    }
    return f.apply(this, arguments);
  }; }
