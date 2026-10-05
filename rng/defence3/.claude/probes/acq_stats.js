// The acquisition scan's work (SIM_KERNEL_ACQ_SCAN), counted: per tier job
// the units scanned, those ended by the blocks check, the tiles visited
// (and those holding foes), the entries looked at, the rings, units found.
// HELPERS=0 (the counted copy runs on the simulation thread).
// Use: EVAL="$(cat .claude/probes/acq_stats.js)" AFTER='JSON.stringify(__scratch.acqTop())'
__scratch.acqC = { jobs: 0, units: 0, blocksEnd: 0, tiles: 0, foeTiles: 0, entries: 0, rings: 0, found: 0 };
{
    let __aSrc = SIM_KERNELS[SIM_KERNEL_ACQ_SCAN].toString();
    const __aRep = (a, b) => { if (!__aSrc.includes(a)) throw new Error('acq_stats: no ' + a); __aSrc = __aSrc.replace(a, b); };
    const C = '__scratch.acqC';
    __aRep('const cbase = owner * A;', 'const cbase = owner * A; ' + C + '.units++;');
    __aRep('HS[o + by0 * stride + bx0] <= 0) continue;', 'HS[o + by0 * stride + bx0] <= 0) { ' + C + '.blocksEnd++; continue; }');
    __aRep('for (let ring = 0; ring <= rt; ring++) {', 'for (let ring = 0; ring <= rt; ring++) { ' + C + '.rings++;');
    __aRep('const k = ty * CW + tx;', 'const k = ty * CW + tx; ' + C + '.tiles++;');
    __aRep('if (rst[k] !== ep || (OM[k] & foe) === 0) continue;', 'if (rst[k] !== ep || (OM[k] & foe) === 0) continue; ' + C + '.foeTiles++;');
    __aRep('const q = es[e];', 'const q = es[e]; ' + C + '.entries++;');
    __aRep('OUTA[s] = best; TID[s]', 'if (best >= 0) ' + C + '.found++; OUTA[s] = best; TID[s]');
    SIM_KERNELS[SIM_KERNEL_ACQ_SCAN] = eval('(' + __aSrc + ')');
}
__scratch.acqTop = () => { const c = __scratch.acqC, u = Math.max(1, c.units); return { ...c, perUnit: { tiles: +(c.tiles / u).toFixed(1), foeTiles: +(c.foeTiles / u).toFixed(1), entries: +(c.entries / u).toFixed(1), rings: +(c.rings / u).toFixed(2) } }; };
