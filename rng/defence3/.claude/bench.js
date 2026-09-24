(async () => {
  document.getElementById('cfg-mapsize').value='60'; document.getElementById('cfg-map-type').value='arena'; document.getElementById('cfg-max-pop').value='400';
  for (const id of ['cfg-mapsize','cfg-map-type','cfg-max-pop']) document.getElementById(id).dispatchEvent(new Event('change'));
  [...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Play Solo').click();
  await new Promise(r=>setTimeout(r,1000));
  for (let y=1;y<GRID_H-1;y++) for (let x=1;x<GRID_W-1;x++){ const c=grid[y][x]; if(c.type===TYPE_WALL && !c.item && !getTowerAtTile(x,y)) c.type=TYPE_FLOOR; }
  _bumpPathTopologyVersion();
  const me=localPlayerId, ids=[];
  for (let i=0;i<200;i++){ const u=new Unit('snake', me, 0, 0); applyUnitLevelScaling(u,1); u.energy=u.preComputed.maxEnergy; units.push(u); players[me].popCount++; ids.push(u.id); }
  window.__benchIds=ids;
  window.__runBench = (ticks=600, period=300, opts={}) => {
    const snakes = units.filter(u=>ids.includes(u.id));
    snakes.forEach((u,i)=>{ u.x=u.prevX=(5+(i%14))*TILE+16; u.y=u.prevY=(15+Math.floor(i/14)*2)*TILE+16; u.path=null; u.commandState=CMD_IDLE; if(u.snakeHistory) u.snakeHistory.length=0; updateUnitSpatial(u); });
    const times=[], renders=[]; let side=0; const t0=performance.now();
    for (let t=0;t<ticks;t++){
      if (!opts.negative) { _setPlayerResourceValue(me,'astar',1e9); _setPlayerResourceValue(me,'energy',1e9); }
      if (t%period===0){ side^=1; processActions([{action:'move', unitIds: ids, targetX:(side?52:7)*TILE+16, targetY:30*TILE+16}], me); }
      const s=performance.now(); gameTick(); times.push(performance.now()-s);
      if (opts.render && t%3===0) { const r=performance.now(); renderFrame(performance.now()); renders.push(performance.now()-r); }
    }
    const st=a=>{ if(!a.length) return null; const b=[...a].sort((x,y)=>x-y); return {mean:+(a.reduce((x,c)=>x+c,0)/a.length).toFixed(2), p50:+b[b.length>>1].toFixed(2), p95:+b[Math.floor(b.length*.95)].toFixed(2), max:+b[b.length-1].toFixed(1)}; };
    return {sim:st(times), render:st(renders), total:+(performance.now()-t0).toFixed(0), avgX:+(snakes.reduce((a,u)=>a+u.x,0)/snakes.length/TILE).toFixed(1)};
  };
  return 'ready ' + units.length;
})()
