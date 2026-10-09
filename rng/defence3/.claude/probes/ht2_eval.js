__scratch.snapHT = { now: __scratch.realNow, slices: 0, ents: 0, drops: 0, grid: 0, rebuilds: 0, order: 0 };
{ const f = _snapHashOrder; _snapHashOrder = function () { const t0 = __scratch.realNow(); try { return f.apply(this, arguments); } finally { __scratch.snapHT.order += __scratch.realNow() - t0; } }; }
