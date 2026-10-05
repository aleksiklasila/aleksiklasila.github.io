// Counts which hand-back site of the movement kernel's pre-pass
// (_simMovePre: every `ON[s] = 0; continue;`) fires, by the mvOn the slot
// was armed with. Kernels must run on the simulation thread, where the
// re-evaluated function lives: HELPERS=0 (shared memory, no helper threads;
// without HELPERS at all the world runs another mode).
// Use: EVAL="$(cat .claude/probes/handback_sites.js)"
//      AFTER='JSON.stringify(__scratch.hbTop())'
// (The harness runs the game in an eval'd function scope: its "globals" are
// that scope's bindings. So the copy is made with a direct eval in a plain
// block, with names the kernel does not use; a direct eval inside a helper
// with locals such as H resolved the kernel's free names to them, and a
// global eval cannot see the game's names at all: both desynced the peer.)
__scratch.hbMap = new Map(); __scratch.hbLines = []; __scratch.hbCalls = 0;
__scratch.hbFn = (k, s, R) => {
    __scratch.hbCalls++;
    if (gameTime < 48) return;
    const key = k + ':on' + R['unit.mvOn'][s];
    __scratch.hbMap.set(key, (__scratch.hbMap.get(key) || 0) + 1);
};
{
    let __pSrc = _simMovePre.toString(), __pSite = 0;
    __pSrc = __pSrc.replace(/ON\[s\] = 0; continue;/g, (m, off, all) => {
        const ls = all.lastIndexOf('\n', off) + 1, le = all.indexOf('\n', off);
        __scratch.hbLines.push(all.slice(ls, le < 0 ? undefined : le).trim().slice(0, 140));
        return `{ __scratch.hbFn(${__pSite++}, s, R); ON[s] = 0; continue; }`;
    });
    _simMovePre = eval('(' + __pSrc + ')');
}
__scratch.hbTop = () => {
    const n = Math.max(1, __scratch.tickMs.length - 48), L = __scratch.hbLines;
    return [...__scratch.hbMap].sort((a, b) => b[1] - a[1]).slice(0, 25).map(([k, v]) => [k, Math.round(v / n), L[+k.split(':')[0]]]);
};
