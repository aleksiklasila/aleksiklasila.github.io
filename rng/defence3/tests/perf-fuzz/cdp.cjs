'use strict';
// Raw DevTools protocol to the browser (playwright's own pipe is not shared):
// the workers' JS heap and CPU profiles. Needs the browser started with
// --remote-debugging-port=<port>.
const net = require('node:net');
const { sleep, withTimeout } = require('./env.cjs');

const freePort = () => new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
});

async function connectBrowserCdp(port) {
    let ver;
    for (let i = 0; i < 50 && !ver; i++) {
        try { ver = await (await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1500) })).json(); } catch { await sleep(200); }
    }
    if (!ver) throw new Error('browser debugging endpoint did not open on port ' + port);
    const ws = new WebSocket(ver.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('cdp websocket failed')); });
    let id = 0;
    const pending = new Map(), listeners = new Set();
    ws.onmessage = m => {
        let d; try { d = JSON.parse(m.data); } catch { return; }
        if (d.id && pending.has(d.id)) { const p = pending.get(d.id); pending.delete(d.id); clearTimeout(p.timer); d.error ? p.reject(new Error(d.error.message)) : p.resolve(d.result); return; }
        if (d.method) for (const l of listeners) { try { l(d); } catch { } }
    };
    ws.onclose = () => { for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error('cdp closed')); } pending.clear(); };
    const send = (method, params = {}, sessionId, timeoutMs = 20000) => new Promise((resolve, reject) => {
        const i = ++id;
        const timer = setTimeout(() => { pending.delete(i); reject(new Error('cdp timeout ' + method)); }, timeoutMs);
        pending.set(i, { resolve, reject, timer });
        try { ws.send(JSON.stringify({ id: i, method, params, ...(sessionId ? { sessionId } : {}) })); } catch (e) { pending.delete(i); clearTimeout(timer); reject(e); }
    });
    return { send, on: l => { listeners.add(l); return () => listeners.delete(l); }, close: () => { try { ws.close(); } catch { } }, version: ver.Browser };
}

const nameOf = url => { const m = /([A-Za-z0-9_.-]+?)(?:\.js)?(?:[?#].*)?$/.exec(url || ''); return m ? m[1] : 'worker'; };

// Every dedicated worker of the browser, attached once (no domain enabled:
// nothing runs in them until a heap or profile question).
function workerProbe(cdp) {
    const sessions = new Map(); // targetId -> { sessionId, name, url }
    const counts = {};
    const refresh = async () => {
        let infos;
        try { ({ targetInfos: infos } = await cdp.send('Target.getTargets')); } catch { return sessions.size; }
        const live = new Set();
        for (const t of infos) {
            if (t.type !== 'worker') continue;
            live.add(t.targetId);
            if (sessions.has(t.targetId)) continue;
            try {
                const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: t.targetId, flatten: true });
                const base = nameOf(t.url);
                counts[base] = (counts[base] || 0) + 1;
                sessions.set(t.targetId, { sessionId, url: t.url, name: base, index: counts[base] });
            } catch { }
        }
        for (const id of [...sessions.keys()]) if (!live.has(id)) sessions.delete(id);
        return sessions.size;
    };
    // Heap of each worker: MB used / total / backing stores, grouped by script (helpers summed).
    const heap = async () => {
        await refresh();
        const rows = await Promise.all([...sessions.values()].map(async s => {
            try { const h = await cdp.send('Runtime.getHeapUsage', {}, s.sessionId, 6000); return { name: s.name, used: h.usedSize, total: h.totalSize, backing: h.backingStorageSize || 0 }; } catch { return null; }
        }));
        const by = {};
        for (const r of rows) {
            if (!r) continue;
            const g = by[r.name] || (by[r.name] = { n: 0, usedMB: 0, totalMB: 0, backingMB: 0 });
            g.n++; g.usedMB += r.used / 1048576; g.totalMB += r.total / 1048576; g.backingMB += r.backing / 1048576;
        }
        for (const g of Object.values(by)) { g.usedMB = Math.round(g.usedMB * 10) / 10; g.totalMB = Math.round(g.totalMB * 10) / 10; g.backingMB = Math.round(g.backingMB * 10) / 10; }
        return by;
    };
    const profileStart = async (intervalUs = 500) => {
        await refresh();
        const started = [];
        for (const s of sessions.values()) {
            try { await cdp.send('Profiler.enable', {}, s.sessionId); await cdp.send('Profiler.setSamplingInterval', { interval: intervalUs }, s.sessionId); await cdp.send('Profiler.start', {}, s.sessionId); started.push(s); } catch { }
        }
        return started.length;
    };
    const profileStop = async () => {
        const out = [];
        for (const s of sessions.values()) {
            try { const r = await cdp.send('Profiler.stop', {}, s.sessionId, 60000); if (r && r.profile) out.push({ name: s.name + (s.index > 1 ? '#' + s.index : ''), profile: r.profile }); await cdp.send('Profiler.disable', {}, s.sessionId).catch(() => { }); } catch { }
        }
        return out;
    };
    // A full garbage collection in every worker (a heap that is still large afterwards is retained).
    const gc = async () => { await refresh(); await Promise.all([...sessions.values()].map(s => cdp.send('HeapProfiler.collectGarbage', {}, s.sessionId, 20000).catch(() => { }))); };
    return { refresh, heap, gc, profileStart, profileStop, count: () => sessions.size };
}

module.exports = { freePort, connectBrowserCdp, workerProbe, nameOf };
