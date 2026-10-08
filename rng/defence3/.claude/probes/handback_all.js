// Which hand-back site of the JS movement kernels fires (every
// `ON[s] = 0; continue;` / `return` hand-back is not covered: only the
// `ON[s] = 0;` sites), by function and the slot's mvOn before, for ticks
// from __HB_FROM__ to __HB_TO__ (sed them in; default 48..1e9).
// Run the JS kernels on the simulation thread: WASM=0 HELPERS=0.
// Use: EVAL="$(sed -e s/__HB_FROM__/211/ -e s/__HB_TO__/215/ .claude/probes/handback_all.js)"
//      AFTER='JSON.stringify(__scratch.hbTop())'
// (Copies made with a direct eval in a plain block: see handback_sites.js.)
__scratch.hbMap = new Map(); __scratch.hbLines = []; __scratch.hbTicks = new Set();
__scratch.hbFrom = Number('__HB_FROM__') || 48; __scratch.hbTo = Number('__HB_TO__') || 1e9;
__scratch.hbFn = (k, s, R) => {
    if (gameTime < __scratch.hbFrom || gameTime > __scratch.hbTo) return;
    __scratch.hbTicks.add(gameTime);
    const key = k + ':on' + R['unit.mvOn'][s];
    __scratch.hbMap.set(key, (__scratch.hbMap.get(key) || 0) + 1);
};
{
    let __pSite = 0;
    const __pPatch = (__pName, __pSrc) => __pSrc.replace(/ON\[s\] = 0;/g, (m, off, all) => {
        const ls = all.lastIndexOf('\n', off) + 1, le = all.indexOf('\n', off);
        __scratch.hbLines.push(__pName + ': ' + all.slice(ls, le < 0 ? undefined : le).trim().slice(0, 150));
        return `{ __scratch.hbFn(${__pSite++}, s, R); ON[s] = 0; }`;
    });
    _simMovePre = eval('(' + __pPatch('pre', _simMovePre.toString()) + ')');
    _simMoveFlow = eval('(' + __pPatch('flow', _simMoveFlow.toString()) + ')');
    _simMovePath = eval('(' + __pPatch('path', _simMovePath.toString()) + ')');
    _simStepFlow = eval('(' + __pPatch('stepflow', _simStepFlow.toString()) + ')');
}
__scratch.hbTop = () => {
    const n = Math.max(1, __scratch.hbTicks.size), L = __scratch.hbLines;
    return [...__scratch.hbMap].sort((a, b) => b[1] - a[1]).slice(0, 30).map(([k, v]) => [k, Math.round(v / n), L[+k.split(':')[0]]]);
};
