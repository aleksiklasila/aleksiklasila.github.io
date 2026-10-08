// Per tick (from 120): the building/floor-item status set's size (sorted
// every tick by thingStatusDue) and the pending-path units visited
// (takeDuePendingPathUnits). AFTER='JSON.stringify(__scratch.hcTop())'
__scratch.hc = { st: [], pp: [] };
{
    const __hcDue = thingStatusDue;
    thingStatusDue = function () { if (gameTime >= 120) __scratch.hc.st.push(_thingStatusActive.size); return __hcDue.apply(this, arguments); };
    const __hcTake = takeDuePendingPathUnits;
    takeDuePendingPathUnits = function () { const r = __hcTake.apply(this, arguments); if (gameTime >= 120) __scratch.hc.pp.push(r ? (r.length !== undefined ? r.length : r.size) : 0); return r; };
}
__scratch.hcTop = () => { const f = a => { const s = a.slice().sort((x, y) => x - y); return { n: a.length, mean: Math.round(a.reduce((x, y) => x + y, 0) / Math.max(1, a.length)), p50: s[s.length >> 1], max: s[s.length - 1] }; }; return { status: f(__scratch.hc.st), pending: f(__scratch.hc.pp) }; };
