// EVALALL probe (every peer): forced attack targets kept out of the hold and
// chase kernels, as before the fourteenth round (a baseline for ACTIONS).
{ const h = simMoveTryHold, c = simMoveTryChase;
  simMoveTryHold = function (u) { if (u.forcedAttackTarget && u.targetUnit) return; return h(u); };
  simMoveTryChase = function (u) { if (u.forcedAttackTarget) return; return c(u); }; }
