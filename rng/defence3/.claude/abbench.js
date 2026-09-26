// Interleaved A/B of two page copies (e.g. /rng/defence3/ vs an untracked
// HEAD export at /rng/defence3_base/). Per page load:
//   await (0,eval)(await (await fetch('/rng/defence3/.claude/abbench.js')).text());
//   AB.start()   // then poll AB.result (JSON) until set
// Each load: 2,200 units, probes of move/fight in 3D (two zooms) and 2D.
(() => {
const AB = { result: null, error: null };
const pick = r => ({ cpu: r.cpu, p95: r.p95, build: r['ms:build3DFrameData'], render: r['ms:r3.render'] });
AB.start = async ({ perTeam = 1100, frames = 60 } = {}) => {
    try {
        await (0, eval)(await (await fetch('/rng/defence3/.claude/renderbench.js')).text());
        await RB.setup({ perTeam, turrets: 40 });
        const out = {};
        for (const [mode, zoom] of [['3d', .35], ['3d', 1], ['2d', .35]]) {
            out[`move ${mode} ${zoom}`] = pick(await RB.probe({ scenario: 'move', mode, zoom, frames, startTick: 1000 }));
        }
        for (let i = 0; i < 140; i++) { gameOver = false; RB.refill(); RB.issue(RB.SCENARIOS.fight.tick(i)); gameTick(); }
        for (const [mode, zoom] of [['3d', .35], ['3d', 1], ['2d', .35]]) {
            out[`fight ${mode} ${zoom}`] = pick(await RB.probe({ scenario: 'fight', mode, zoom, frames, startTick: 140 }));
        }
        AB.result = out;
    } catch (e) { AB.error = String(e.stack || e); }
};
window.AB = AB;
return 'AB ready';
})();
