// AFTER probe: the events, the ticks around them, the heaviest ticks.
JSON.stringify((() => {
  const R = __scratch.rb, ev = __scratch.rbEv, near = new Set();
  for (const e of ev) for (const r of R) if (Math.abs(r[0] - e[1]) <= 2) near.add(r);
  const heavy = R.slice().sort((a, b) => b[1] - a[1]).slice(0, 10);
  return { walls: __scratch.wallsSet, events: ev, cols: 'gameTime,tickMs,gameTickMs,navTickMs,flushMs,jobStep', near: [...near], heavy, sub: __scratch.rbSub,
    maxNav: R.reduce((m, r) => Math.max(m, r[3]), 0), maxFlush: R.reduce((m, r) => Math.max(m, r[4]), 0) };
})())
