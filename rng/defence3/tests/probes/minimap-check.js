// Page probe (scene_tps_probe.cjs PAGEEVAL=@tests/probes/minimap-check.js):
// whether the minimap shows the worker's picture (sim_presentation.js
// simMinimapMake), and how many of its pixels hold units by player.
(() => {
    const pic = typeof simClientMinimapPicture === 'function' ? simClientMinimapPicture() : null;
    const out = { worker: !!pic, seq: pic ? pic.seq : -1, size: pic ? pic.size : 0, byPlayer: {}, canvasColoured: 0 };
    if (pic) {
        const v = new Uint8Array(pic.buf, pic.off, pic.size * pic.size);
        for (let i = 0; i < v.length; i++) if (v[i]) out.byPlayer[v[i] - 1] = (out.byPlayer[v[i] - 1] || 0) + 1;
    }
    const c = document.getElementById('minimapCanvas');
    if (c) {
        const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
        for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] > 60) out.canvasColoured++;
    }
    return out;
})()
