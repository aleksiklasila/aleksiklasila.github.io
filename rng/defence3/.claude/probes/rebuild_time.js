// EVAL probe (host, timing only): per tick gameTick / navTick / navFieldsFlush
// ms and the rebuild job's step, plus the ticks where the next build was
// staged and installed and whether a remake-all ran. Sub-timings of the
// build's stages and of simParallelRun by kernel go to __scratch.rbSub
// (tick -> name -> ms) for ticks where navTick ran over 2 ms.
__scratch.rb = []; __scratch.rbEv = []; __scratch.rbSub = {};
{ const T = (name, fn) => function () { const a = __scratch.realNow(); try { return fn.apply(this, arguments); } finally { (__scratch.rbCur ||= {})[name] = ((__scratch.rbCur[name] || 0) + __scratch.realNow() - a); } };
  gameTick = T('gameTick', gameTick); navTick = T('navTick', navTick); navFieldsFlush = T('flush', navFieldsFlush);
  for (const n of ['navBuildStart', 'navBuildNodesBackground', 'navBuildNodesFinish', 'navBuildLocalBackground', 'navBuildCollect', 'navBuildGraphAlloc', 'navBuildGraphBackground', 'navBuildGraphFinish', 'navBuildPartsFinish', 'navBuildFinish', 'simParallelBackgroundWait', 'simSharedArray']) { const f = eval(n); eval(n + ' = T(n, f)'); }
  { const f = simParallelRun; simParallelRun = function (k) { const a = __scratch.realNow(); try { return f.apply(this, arguments); } finally { const key = 'run' + k; (__scratch.rbCur ||= {})[key] = ((__scratch.rbCur[key] || 0) + __scratch.realNow() - a); } }; }
  const st = _navNextStage, ins = _navNextInstall, ra = _navFieldsRemakeAll;
  _navNextStage = function () { __scratch.rbEv.push(['stage', gameTime, _navFields.pools.map(F => F.byKey ? F.byKey.size : 0)]); const a = __scratch.realNow(); try { return st.apply(this, arguments); } finally { __scratch.rbEv.push(['stageMs', gameTime, Math.round((__scratch.realNow() - a) * 100) / 100]); } };
  _navNextInstall = function () { const a = __scratch.realNow(); try { return ins.apply(this, arguments); } finally { __scratch.rbEv.push(['install', gameTime, Math.round((__scratch.realNow() - a) * 100) / 100]); } };
  _navFieldsRemakeAll = function () { __scratch.rbEv.push(['remakeAll', gameTime]); return ra.apply(this, arguments); };
  const f = runOneTick; runOneTick = function () { __scratch.rbCur = {}; const a = __scratch.realNow(); try { return f.apply(this, arguments); } finally {
    const r = __scratch.rbCur; __scratch.rb.push([gameTime, Math.round((__scratch.realNow() - a) * 10) / 10, Math.round((r.gameTick || 0) * 10) / 10, Math.round((r.navTick || 0) * 10) / 10, Math.round((r.flush || 0) * 10) / 10, _navJob ? _navJob.step : -1]);
    if ((r.navTick || 0) > 2) __scratch.rbSub[gameTime] = Object.fromEntries(Object.entries(r).map(([k, v]) => [k, Math.round(v * 100) / 100])); } }; }
