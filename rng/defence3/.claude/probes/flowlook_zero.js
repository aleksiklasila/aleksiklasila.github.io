// Why simFlowLook found no way (returned 0) for ticks __FROM__..__TO__: the
// row entry of the unit's part in its destination's row (254/255), a wall
// part (0xFFFF), or a found entry whose step still failed; and whether the
// field's own meta says made. JS kernels on the simulation thread: WASM=0 HELPERS=0.
// Use: EVAL="$(sed -e s/__FROM__/211/ -e s/__TO__/215/ .claude/probes/flowlook_zero.js)" AFTER='JSON.stringify(__scratch.flz)'
__scratch.flz = {}; __scratch.flzTicks = new Set();
{
    const __fOrig = simFlowLook;
    simFlowLook = function (LC, s, refresh, tl, gx, gy, dk, Wd, Hd, WL, navVer, wv, fgen, nC, ncw, PL, PB, ROWS, ro, NF, NB, NT, NP, df, doff, dbx, dby, dbw, dbh) {
        const r = __fOrig.apply(this, arguments);
        if (r === 0 && gameTime >= Number('__FROM__') && gameTime <= Number('__TO__')) {
            __scratch.flzTicks.add(gameTime);
            const cs = 31 - Math.clz32(nC), cf = (gy >> cs) * ncw + (gx >> cs), pl = PL[tl];
            const k = pl === 0xFFFF ? 'wallpart' : 'e' + ROWS[ro + PB[cf] + pl] + (ro + PB[cf] + pl >= ROWS.length ? ':oob' : '');
            __scratch.flz[k] = (__scratch.flz[k] || 0) + 1;
        }
        return r;
    };
}
