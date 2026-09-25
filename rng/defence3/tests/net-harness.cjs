// Headless multiplayer harness: several isolated game instances (the real
// sources, one scope each) connected by a fake PeerJS over a simulated
// network, all driven by one virtual clock. Used by tests/multiplayer-*.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const nodeCrypto = require('node:crypto');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const files = Array.from(html.matchAll(/<script src="\.\/(src\/[^"?]+)(?:\?[^" ]*)?"/g), m => m[1])
    .filter(f => !f.endsWith('bootstrap.js'));
const SOURCE = files.map(f => fs.readFileSync(path.join(root, f), 'utf8')).join('\n;\n');

// Default control values, read from the menu markup.
const CONTROL_DEFAULTS = new Map();
{
    const attr = (text, name) => text.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1];
    for (const match of html.matchAll(/<input\b([^>]*)>|<select\b([^>]*)>([\s\S]*?)<\/select>/g)) {
        const isSelect = match[1] === undefined;
        const attrs = match[1] ?? match[2];
        const id = attr(attrs, 'id');
        if (!id) continue;
        const options = [...(match[3] || '').matchAll(/<option\b([^>]*)>/g)]
            .map(m => ({ value: attr(m[1], 'value'), selected: /\bselected\b/.test(m[1]) }));
        CONTROL_DEFAULTS.set(id, {
            tagName: isSelect ? 'SELECT' : 'INPUT',
            type: isSelect ? 'select-one' : (attr(attrs, 'type') || 'text'),
            value: options.length ? (options.find(o => o.selected) || options[0]).value : (attr(attrs, 'value') || ''),
            checked: /\bchecked\b/.test(attrs),
            options
        });
    }
}

// ------------------------------------------------------------------
// Virtual clock
// ------------------------------------------------------------------
class Scheduler {
    constructor() { this.now = 0; this.heap = []; this.seq = 0; }
    at(time, fn, owner = null) {
        const e = { time: Math.max(this.now, time), seq: this.seq++, fn, owner, cancelled: false };
        const h = this.heap;
        h.push(e);
        let i = h.length - 1;
        while (i > 0) {
            const p = (i - 1) >> 1;
            if (this._less(h[p], h[i])) break;
            [h[p], h[i]] = [h[i], h[p]];
            i = p;
        }
        return e;
    }
    _less(a, b) { return a.time < b.time || (a.time === b.time && a.seq < b.seq); }
    _pop() {
        const h = this.heap;
        const top = h[0];
        const last = h.pop();
        if (h.length > 0) {
            h[0] = last;
            let i = 0;
            for (;;) {
                const l = i * 2 + 1, r = l + 1;
                let m = i;
                if (l < h.length && this._less(h[l], h[m])) m = l;
                if (r < h.length && this._less(h[r], h[m])) m = r;
                if (m === i) break;
                [h[m], h[i]] = [h[i], h[m]];
                i = m;
            }
        }
        return top;
    }
    runUntil(time) {
        while (this.heap.length > 0 && this.heap[0].time <= time) {
            const e = this._pop();
            if (e.cancelled || (e.owner && e.owner.dead)) continue;
            this.now = e.time;
            try { e.fn(); }
            catch (err) {
                if (e.owner) e.owner.errors.push(err);
                else throw err;
            }
        }
        this.now = time;
    }
}

// ------------------------------------------------------------------
// Minimal DOM
// ------------------------------------------------------------------
class FakeElement {
    constructor(id = '', init = null) {
        this.id = id;
        this.style = {};
        this.dataset = {};
        this.tagName = init?.tagName || 'DIV';
        this.type = init?.type || '';
        this.value = init?.value ?? '';
        this.checked = !!init?.checked;
        this.options = init?.options || [];
        this.disabled = false;
        this.hidden = false;
        this.textContent = '';
        this.innerHTML = '';
        this.title = '';
        this.children = [];
        this.listeners = {};
        const classes = new Set();
        this.classList = {
            add: (...c) => c.forEach(x => classes.add(x)), remove: (...c) => c.forEach(x => classes.delete(x)),
            toggle: (c, on) => { if (on === undefined ? !classes.has(c) : on) classes.add(c); else classes.delete(c); },
            contains: c => classes.has(c)
        };
    }
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
    removeEventListener() { }
    dispatchEvent(ev) { for (const fn of this.listeners[ev?.type] || []) fn(ev); return true; }
    click() { this.dispatchEvent({ type: 'click', target: this, preventDefault() { }, stopPropagation() { } }); if (typeof this.onclick === 'function') this.onclick(); }
    querySelector() { return null; }
    querySelectorAll() { return []; }
    appendChild(c) { this.children.push(c); return c; }
    insertBefore(c) { this.children.push(c); return c; }
    removeChild() { }
    remove() { }
    replaceChildren() { this.children = []; }
    setAttribute(k, v) { this[k] = v; }
    getAttribute(k) { return this[k] ?? null; }
    removeAttribute() { }
    matches() { return true; }
    closest() { return null; }
    contains() { return false; }
    focus() { } blur() { } select() { }
    scrollTo() { } scrollIntoView() { }
    getBoundingClientRect() { return { left: 0, top: 0, width: 1280, height: 720, right: 1280, bottom: 720 }; }
    getContext() { return null; }
    get offsetWidth() { return 100; }
    get offsetHeight() { return 100; }
    get offsetLeft() { return 0; }
    get clientWidth() { return 1280; }
    get clientHeight() { return 720; }
}

// ------------------------------------------------------------------
// Simulated network + fake PeerJS
// ------------------------------------------------------------------
const DEFAULT_LINK = { latencyMs: 20, jitterMs: 0, lossRate: 0, bandwidthKBps: 0, spikeEveryMs: 0, spikeMs: 0 };

function payloadSize(data) {
    try {
        let n = 0;
        const s = JSON.stringify(data, (k, v) => {
            if (v && typeof v === 'object' && ArrayBuffer.isView(v)) { n += v.byteLength; return 0; }
            return v;
        });
        return n + (s ? s.length : 0);
    } catch { return 1000; }
}

class Emitter {
    constructor() { this._handlers = {}; }
    on(type, fn) { (this._handlers[type] ||= []).push(fn); return this; }
    once(type, fn) { const w = (...a) => { this.off(type, w); fn(...a); }; return this.on(type, w); }
    off(type, fn) { this._handlers[type] = (this._handlers[type] || []).filter(f => f !== fn); return this; }
    emit(type, ...args) {
        for (const fn of (this._handlers[type] || []).slice()) {
            try { fn(...args); }
            catch (err) { if (this._owner) this._owner.errors.push(err); else throw err; }
        }
    }
}

class Network {
    constructor(world) {
        this.world = world;
        this.peers = new Map();
        this.linkProfiles = new Map(); // "a|b" -> profile (direction a->b)
        this.linkState = new Map();    // "a|b" (sorted) -> 'up' | 'blackhole'
        this.defaultProfile = { ...DEFAULT_LINK };
        this.rngState = 0x9e3779b9;
        this.stats = { messages: 0, bytes: 0, dropped: 0 };
    }
    rand() {
        // Seeded so each scenario is reproducible.
        let t = (this.rngState += 0x6D2B79F5) >>> 0;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    }
    key(a, b) { return a + '|' + b; }
    pairKey(a, b) { return a < b ? a + '|' + b : b + '|' + a; }
    ownerOf(peerId) { const p = this.peers.get(peerId); return p ? p.instanceName : ''; }
    profileFor(fromId, toId) {
        const a = this.ownerOf(fromId), b = this.ownerOf(toId);
        return this.linkProfiles.get(this.key(a, b)) || this.linkProfiles.get('*') || this.defaultProfile;
    }
    setProfile(profile, a = null, b = null) {
        if (!a) { this.linkProfiles.set('*', { ...DEFAULT_LINK, ...profile }); return; }
        this.linkProfiles.set(this.key(a, b), { ...DEFAULT_LINK, ...profile });
        this.linkProfiles.set(this.key(b, a), { ...DEFAULT_LINK, ...profile });
    }
    setLinkState(a, b, state) { this.linkState.set(this.pairKey(a, b), state); }
    linkUp(fromId, toId) {
        return (this.linkState.get(this.pairKey(this.ownerOf(fromId), this.ownerOf(toId))) || 'up') === 'up';
    }
    oneWayDelay(fromId, toId, size) {
        const p = this.profileFor(fromId, toId);
        const now = this.world.sched.now;
        let d = p.latencyMs / 2;
        if (p.jitterMs > 0) d += this.rand() * p.jitterMs;
        if (p.spikeEveryMs > 0 && (now % p.spikeEveryMs) < p.spikeMs) d += p.spikeMs - (now % p.spikeEveryMs);
        // Reliable SCTP: a lost datagram is retransmitted after roughly an RTO.
        let tries = 0;
        while (p.lossRate > 0 && this.rand() < p.lossRate && tries < 6) { d += Math.max(200, p.latencyMs * 1.5) * (1 << tries); tries++; }
        if (p.bandwidthKBps > 0) d += size / p.bandwidthKBps;
        return Math.max(0.1, d);
    }
    deliver(fromConn, data) {
        const to = fromConn._remote;
        if (!to) return;
        const size = payloadSize(data);
        this.stats.messages++;
        this.stats.bytes += size;
        fromConn._owner.netStats.sentMessages++;
        fromConn._owner.netStats.sentBytes += size;
        if (!this.linkUp(fromConn._localPeerId, to._localPeerId)) { this.stats.dropped++; return; }
        let clone;
        try { clone = structuredClone(data); } catch { clone = JSON.parse(JSON.stringify(data)); }
        let at = this.world.sched.now + this.oneWayDelay(fromConn._localPeerId, to._localPeerId, size);
        if (fromConn._ordered) {
            at = Math.max(at, fromConn._lastDeliverAt || 0);
            fromConn._lastDeliverAt = at;
        }
        this.world.sched.at(at, () => {
            if (!to.open || to._closed) return;
            if (!this.linkUp(fromConn._localPeerId, to._localPeerId)) { this.stats.dropped++; return; }
            to._owner.netStats.recvMessages++;
            to._owner.netStats.recvBytes += size;
            to.emit('data', clone);
        }, to._owner);
    }
}

function makePeerClass(world, inst) {
    const net = world.net;
    class FakeDataConnection extends Emitter {
        constructor(localPeerId, remotePeerId, options) {
            super();
            this._owner = inst;
            this._localPeerId = localPeerId;
            this.peer = remotePeerId;
            this.open = false;
            this._closed = false;
            this.reliable = !!(options && options.reliable);
            this._ordered = this.reliable;
            this.label = 'dc_' + Math.floor(net.rand() * 2 ** 32).toString(16);
            this.metadata = options && options.metadata;
            this.serialization = 'binary';
        }
        send(data) {
            if (!this.open || this._closed) { inst.netStats.sendWhileClosed++; return; }
            net.deliver(this, data);
        }
        close() {
            if (this._closed) return;
            this._closed = true;
            const wasOpen = this.open;
            this.open = false;
            if (wasOpen || true) this.emit('close');
            const remote = this._remote;
            if (remote && !remote._closed) {
                world.sched.at(world.sched.now + net.oneWayDelay(this._localPeerId, remote._localPeerId, 64), () => remote._remoteClosed(), remote._owner);
            }
        }
        _remoteClosed() {
            if (this._closed) return;
            this._closed = true;
            this.open = false;
            this.emit('close');
        }
    }

    class FakePeer extends Emitter {
        constructor(id) {
            super();
            this._owner = inst;
            this.id = id || ('auto' + Math.floor(net.rand() * 2 ** 40).toString(16).padStart(10, '0'));
            this.open = false;
            this.destroyed = false;
            this.disconnected = false;
            this.instanceName = inst.name;
            this.connections = [];
            inst.peers.push(this);
            world.sched.at(world.sched.now + world.signalingMs, () => {
                if (this.destroyed) return;
                if (inst.offline) { this.emit('error', { type: 'network', message: 'Lost connection to server.' }); return; }
                if (net.peers.has(this.id) && !net.peers.get(this.id).destroyed) {
                    this.emit('error', { type: 'unavailable-id', message: `ID "${this.id}" is taken` });
                    return;
                }
                net.peers.set(this.id, this);
                this.open = true;
                this.emit('open', this.id);
            }, inst);
        }
        connect(remoteId, options = {}) {
            const conn = new FakeDataConnection(this.id, String(remoteId), options);
            this.connections.push(conn);
            const signalDelay = world.signalingMs + net.oneWayDelay(this.id, remoteId, 256) * 2;
            world.sched.at(world.sched.now + signalDelay, () => {
                if (this.destroyed || conn._closed || inst.offline || !this.open) return;
                const target = net.peers.get(String(remoteId));
                if (!target || target.destroyed || !net.linkUp(this.id, remoteId)) {
                    if (!target || target.destroyed) this.emit('error', { type: 'peer-unavailable', message: `Could not connect to peer ${remoteId}` });
                    return;
                }
                const remote = new FakeDataConnection(target.id, this.id, options);
                remote._owner = target._owner;
                remote._remote = conn;
                conn._remote = remote;
                target.connections.push(remote);
                target.emit('connection', remote);
                const openDelay = net.oneWayDelay(this.id, remoteId, 64) * 2;
                world.sched.at(world.sched.now + openDelay, () => {
                    if (conn._closed || remote._closed) return;
                    remote.open = true;
                    remote.emit('open');
                }, remote._owner);
                world.sched.at(world.sched.now + openDelay, () => {
                    if (conn._closed || remote._closed) return;
                    conn.open = true;
                    conn.emit('open');
                }, inst);
            }, inst);
            return conn;
        }
        disconnect() { this.disconnected = true; }
        reconnect() {
            if (inst.offline) { world.sched.at(world.sched.now + world.signalingMs, () => { if (!this.destroyed) this.emit('disconnected'); }, inst); return; }
            this.disconnected = false;
        }
        destroy() {
            if (this.destroyed) return;
            this.destroyed = true;
            this.open = false;
            for (const c of this.connections) c.close();
            if (net.peers.get(this.id) === this) net.peers.delete(this.id);
            this.emit('close');
        }
    }
    return FakePeer;
}

// ------------------------------------------------------------------
// Game instance
// ------------------------------------------------------------------
const SETUP = `
const __stubs = {
    playSound: () => {}, startLaserSound: () => {}, stopLaserSound: () => {}, updateAudioReactiveState: () => {},
    initAudio: () => {}, startBackgroundMusic: () => {}, applyAudioSettings: () => {},
    updateItemTextCache: () => {}, ensureLevelTextCanvas: () => null,
    updateInfoPanel: () => {}, updateHUD: () => {}, requestBuildMenuRefresh: () => {}, updateBuildMenu: () => {},
    updateControlGroupBar: () => {}, queueRenderFrame: () => {}, invalidateStaticLayerCache: () => {},
    clearRendererTransientVisualCaches: () => {}, commitStaticCaches: () => {}, _requestStaticCacheCommit: () => {},
    showGameOver: () => {}, renderGameGraph: () => {}, setResearchPopupOpen: () => {}
};
const __orig = {};
const __exactView = new DataView(new ArrayBuffer(8));
function __exactStateHash() {
    let h = 2166136261 >>> 0;
    const mix = v => {
        if (typeof v === 'number') { __exactView.setFloat64(0, v); for (let i = 0; i < 8; i++) h = Math.imul(h ^ __exactView.getUint8(i), 16777619); return; }
        const str = v === undefined ? '~u' : v === null ? '~n' : typeof v === 'object' ? JSON.stringify(v) : String(v);
        for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619);
        h = Math.imul(h ^ 255, 16777619);
    };
    const ref = e => e ? (e.id !== undefined ? 'u' + e.id : (e.gx + ',' + e.gy)) : null;
    for (const u of units.slice().sort((a, b) => a.id - b.id)) {
        mix(u.id); mix(u.x); mix(u.y); mix(u.energy); mix(u.attackTimer); mix(u.commandState); mix(!!u.holdPosition); mix(u.workerState);
        mix(u.stackCount); mix(u.path ? u.path.length : -1); mix(u.pathIndex); mix(u.targetPos ? u.targetPos.x : null); mix(u.targetPos ? u.targetPos.y : null);
        mix(ref(u.targetUnit)); mix(ref(u.targetBuilding)); mix(ref(u.workerTarget)); mix(u._pendingPathTarget ? u._pendingPathTarget.gx + ',' + u._pendingPathTarget.gy : null);
    }
    const bld = b => {
        mix(b.gx); mix(b.gy); mix(b.type); mix(b.energy); mix(b.maxEnergy); mix(b.spawnTimer); mix(b.stackingWorkDone); mix(b.stacks); mix(b.manualStacks); mix(b.level);
        mix(b.rallyX); mix(b.rallyY); mix(b.rallyTargetUnitId); mix(b.autoUpgradeEnabled); mix(b.autoStackEnabled); mix(b.buildEnabled); mix(b.queueEnabled);
        mix(b.markedForSalvage); mix(b.autoResearchEnabled); mix(Array.isArray(b.spawnQueue) ? b.spawnQueue.length : -1); mix(!!b.isUpgrading); mix(!!b.underConstruction); mix(b.preferredTargetSpec || null);
    };
    for (const list of [towers, barracks, collectorSpawners]) for (const b of list.slice().sort((a, b) => (a.gy - b.gy) || (a.gx - b.gx))) bld(b);
    for (const it of getCellItemsRowMajor()) bld(it);
    for (const pl of players) {
        mix(pl.energy); mix(pl.astar); for (const k of Object.keys(pl._resourceFixedValues || {}).sort()) mix(pl._resourceFixedValues[k]);
        mix(pl.researchLevels || null); mix((pl.researchQueue || []).map(t => t && (t.kind + t.key + t.statKey)).join('|')); mix(pl.researchTask ? pl.researchTask.workDone : null);
    }
    for (const pr of projectiles) { mix(pr.x); mix(pr.y); }
    for (const ar of (areas || [])) if (ar) { mix(ar.multiplierLevel || 0); mix(!!ar.active); }
    for (const d of droppedItems) { mix(d.gx); mix(d.gy); mix(d.value); mix(d.timer); }
    mix([...resignedTeams].sort().join(','));
    return (h >>> 0).toString(16);
}
for (const __k in __stubs) { try { __orig[__k] = eval(__k); eval(__k + ' = __stubs[__k]'); } catch (e) {} }
try { Tower.prototype.updateTextCache = () => {}; } catch (e) {}
return {
    eval: (code) => eval(code),
    set: (name, value) => { __harnessValue = value; eval(name + ' = __harnessValue'); },
};
`;

// A Math whose functions without exactly specified results (pow, exp, log,
// trig, hypot...) answer slightly off (exaggerated, so any dependency shows up).
// Exactly specified ones (sqrt, floor, min, ...) are untouched.
function makeForeignMath() {
    const m = Object.create(Math);
    const nudge = v => (Number.isFinite(v) && v !== 0 && !Number.isInteger(v)) ? v * (1 + 1e-9) : v;
    for (const k of ['pow', 'exp', 'expm1', 'log', 'log1p', 'log2', 'log10', 'sin', 'cos', 'tan', 'atan', 'atan2', 'asin', 'acos', 'hypot', 'cbrt', 'sinh', 'cosh', 'tanh']) {
        const f = Math[k];
        m[k] = (...a) => nudge(f(...a));
    }
    return m;
}

function createInstance(world, name, options = {}) {
    const inst = {
        name, dead: false, errors: [], warnings: [], logs: [], peers: [], rafCallbacks: [],
        timers: new Map(), nextTimerId: 1, hidden: false, frameMs: options.frameMs || 1000 / 60,
        netStats: { sentMessages: 0, sentBytes: 0, recvMessages: 0, recvBytes: 0, sendWhileClosed: 0 },
        tickHashes: new Map(), executedActions: new Map(), workers: [], docListeners: {}, winListeners: {}, issuedActions: new Map(), snapshotsApplied: 0,
        storage: options.storage || new Map(),
        // Per-tab storage: pass the old instance's to model a reload.
        session: options.session || new Map()
    };
    const sched = world.sched;
    const controls = new Map();
    const elementFor = id => {
        if (!controls.has(id)) controls.set(id, new FakeElement(id, CONTROL_DEFAULTS.get(id)));
        return controls.get(id);
    };
    for (const [id, value] of Object.entries(options.controls || {})) {
        const el = elementFor(id);
        if (typeof value === 'boolean') el.checked = value; else el.value = String(value);
    }
    const body = new FakeElement('body');
    const document = {
        get hidden() { return inst.hidden; },
        get visibilityState() { return inst.hidden ? 'hidden' : 'visible'; },
        body, documentElement: new FakeElement('html'),
        getElementById: id => elementFor(id),
        createElement: tag => new FakeElement('', { tagName: String(tag).toUpperCase() }),
        querySelector: () => null, querySelectorAll: () => [],
        addEventListener: (type, fn) => { (inst.docListeners[type] ||= []).push(fn); }, removeEventListener: () => { },
        dispatchEvent: ev => { for (const fn of (inst.docListeners[ev && ev.type] || []).slice()) fn(ev); return true; },
        activeElement: null, exitFullscreen: async () => { },
        fullscreenElement: null
    };
    const location = new URL(options.url || 'http://localhost/rng/defence3/index.html');
    const window = {
        innerWidth: 1280, innerHeight: 720, devicePixelRatio: 1,
        addEventListener: (type, fn) => { (inst.winListeners[type] ||= []).push(fn); }, removeEventListener: () => { },
        dispatchEvent: ev => { for (const fn of (inst.winListeners[ev && ev.type] || []).slice()) fn(ev); return true; },
        getComputedStyle: () => ({ getPropertyValue: () => '' }), open: () => null, focus: () => { },
        matchMedia: () => ({ matches: false, addEventListener() { }, removeEventListener() { } }),
        get location() { return location; },
        history: { replaceState: (_s, _t, url) => { if (url) { const next = new URL(url, location.href); location.href = next.href; } }, pushState() { } },
        crypto: {
            randomUUID: () => { const h = n => Math.floor(world.net.rand() * 16 ** n).toString(16).padStart(n, '0'); return h(8) + '-' + h(4) + '-4' + h(3) + '-a' + h(3) + '-' + h(12); },
            getRandomValues: arr => { for (let i = 0; i < arr.length; i++) arr[i] = Math.floor(world.net.rand() * 256); return arr; },
            subtle: nodeCrypto.webcrypto.subtle
        },
        navigator: { userAgent: 'harness', clipboard: { writeText: async () => { } } },
        Peer: null
    };
    window.Peer = makePeerClass(world, inst);
    const localStorage = {
        getItem: k => (inst.storage.has(k) ? inst.storage.get(k) : null),
        setItem: (k, v) => inst.storage.set(k, String(v)),
        removeItem: k => inst.storage.delete(k)
    };
    const sessionStorage = {
        getItem: k => (inst.session.has(k) ? inst.session.get(k) : null),
        setItem: (k, v) => inst.session.set(k, String(v)),
        removeItem: k => inst.session.delete(k)
    };
    const performance = { now: () => sched.now };
    const setTimeoutFn = (fn, ms = 0, ...args) => {
        const id = inst.nextTimerId++;
        const e = sched.at(sched.now + Math.max(0, Number(ms) || 0), () => { inst.timers.delete(id); fn(...args); }, inst);
        inst.timers.set(id, e);
        return id;
    };
    const clearTimeoutFn = id => { const e = inst.timers.get(id); if (e) e.cancelled = true; inst.timers.delete(id); };
    const setIntervalFn = (fn, ms = 0, ...args) => {
        const id = inst.nextTimerId++;
        const period = () => Math.max(inst.hidden ? world.hiddenTimerMinMs : 1, Number(ms) || 0);
        const schedule = () => {
            const e = sched.at(sched.now + period(), () => { schedule(); fn(...args); }, inst);
            inst.timers.set(id, e);
        };
        schedule();
        return id;
    };
    const raf = fn => { inst.rafCallbacks.push(fn); return inst.rafCallbacks.length; };
    // Dedicated-worker timers are not throttled in hidden tabs; this stand-in
    // ticks on the virtual clock regardless of visibility.
    class HarnessWorker {
        constructor() { this.onmessage = null; this._timer = null; inst.workers.push(this); }
        postMessage(ms) {
            if (this._timer) this._timer.cancelled = true;
            this._timer = null;
            if (!(ms > 0) || this._terminated) return;
            const tick = () => { this._timer = sched.at(sched.now + ms, () => { tick(); if (this.onmessage) this.onmessage({ data: 0 }); }, inst); };
            tick();
        }
        terminate() { this._terminated = true; if (this._timer) this._timer.cancelled = true; }
    }
    const consoleProxy = {
        log: (...a) => inst.logs.push(a), info: (...a) => inst.logs.push(a), debug: () => { },
        warn: (...a) => inst.warnings.push({ t: sched.now, a }),
        error: (...a) => { inst.errors.push(new Error(a.map(x => (x && x.stack) || String(x)).join(' '))); }
    };
    class HarnessEvent { constructor(type) { this.type = type; } }
    // Wall-clock time follows the virtual clock, so seeds are reproducible.
    class HarnessDate extends Date {
        constructor(...a) { if (a.length) super(...a); else super(1767225600000 + Math.floor(sched.now)); }
        static now() { return 1767225600000 + Math.floor(sched.now); }
    }
    const factory = new Function(
        'window', 'document', 'localStorage', 'performance', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
        'requestAnimationFrame', 'cancelAnimationFrame', 'console', 'navigator', 'alert', 'confirm', 'prompt', 'Event', 'globalThis', 'location', 'Worker', 'Date', 'Math', 'DecompressionStream', 'sessionStorage',
        SOURCE + '\nlet __harnessValue;\nlet __hooks = null; let __cap = null; const __scratch = {};\n' + SETUP
    );
    inst.game = factory(window, document, localStorage, performance, setTimeoutFn, clearTimeoutFn, setIntervalFn, clearTimeoutFn,
        raf, () => { }, consoleProxy, window.navigator, () => { }, () => true, () => null, HarnessEvent, window, location, options.noWorker ? undefined : HarnessWorker, HarnessDate, options.foreignMath ? makeForeignMath() : Math,
        // { noDecompression: true } models an older browser without it.
        options.noDecompression ? undefined : globalThis.DecompressionStream, sessionStorage);
    inst.window = window;
    inst.document = document;
    inst.element = elementFor;
    inst.eval = code => inst.game.eval(code);
    inst.set = (n, v) => inst.game.set(n, v);
    // Shared object for passing values into eval'd code: inst.scratch.x -> __scratch.x
    inst.scratch = inst.eval('__scratch');
    // Schedule a command for a given future tick, as queueAction would.
    // Lets tests make several players act on exactly the same tick.
    inst.queueAt = (tick, action) => {
        inst.scratch.qa = action;
        const netId = inst.eval(`(() => {
            const T = ${Math.floor(tick)};
            if (!isHost && T <= lockstepHighestSentLocalTick) throw new Error('tick already sent: ' + T);
            if (lockstepCommittedByTick[T] || lockstepBundleByTick[T] || T < currentTick) throw new Error('tick sealed: ' + T);
            const netId = (myPeerId || ('p' + localPlayerId)) + ':' + (nextLocalActionSeq++);
            (localInputBuffer[T] ||= []).push({ ...__scratch.qa, teamId: localPlayerId, netId });
            delete lockstepLocalPacketByTick[T];
            if (isHost && lockstepHostPacketsByTick[T] && myPeerId) delete lockstepHostPacketsByTick[T][myPeerId];
            return netId;
        })()`);
        world.issued.set(netId, { at: world.sched.now, tick, by: inst.name });
        return netId;
    };
    // Fire a DOM-like event at 'document', 'window' or an element id.
    inst.dispatch = (target, type, props = {}) => {
        const ev = { type, button: 0, buttons: 0, clientX: 0, clientY: 0, key: '', code: '', ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, deltaY: 0,
            preventDefault() { }, stopPropagation() { }, stopImmediatePropagation() { }, target: null, ...props };
        let list;
        if (target === 'document') list = inst.docListeners[type];
        else if (target === 'window') list = inst.winListeners[type];
        else { const el = elementFor(target); ev.target = ev.target || el; list = el.listeners[type]; }
        for (const fn of (list || []).slice()) fn(ev);
    };

    // Record the per-tick state hash and the executed action ids.
    inst.eval(`(() => {
        const __origRunOneTick = runOneTick;
        runOneTick = function () {
            const tick = currentTick;
            const acts = (isMultiplayer && lockstepBundleByTick[tick] && Array.isArray(lockstepBundleByTick[tick].packets))
                ? lockstepBundleByTick[tick].packets.flatMap(p => p.actions || []) : [];
            const r = __origRunOneTick.apply(this, arguments);
            __harnessHooks.afterTick(tick, acts);
            return r;
        };
        const __origApply = applyAuthoritativeStateSnapshot;
        applyAuthoritativeStateSnapshot = function () {
            const r = __origApply.apply(this, arguments);
            __harnessHooks.snapshotApplied(currentTick);
            return r;
        };
        const __origQueue = queueAction;
        queueAction = function (action) {
            const before = nextLocalActionSeq;
            const r = __origQueue.apply(this, arguments);
            if (nextLocalActionSeq !== before) __harnessHooks.issued((myPeerId || ('p' + localPlayerId)) + ':' + before, currentTick);
            return r;
        };
    })()`.replace(/__harnessHooks/g, '__hooks'));
    return inst;
}

function attachHooks(world, inst) {
    inst.set('__hooks', {
        afterTick: (tick, acts) => {
            // Scripted setup, applied on every peer after the same tick.
            const scripts = world.tickScripts.get(tick);
            if (scripts) for (const code of scripts) inst.eval(code);
            if (tick % world.hashEvery === 0) {
                if (world.recordParts) {
                    const r = JSON.parse(inst.eval('(() => { const p = {}; const h = computeLockstepStateHashFast(' + tick + ', p); return JSON.stringify([h, p]); })()'));
                    inst.tickHashes.set(tick, r[0]);
                    (inst.tickParts ||= new Map()).set(tick, r[1]);
                } else inst.tickHashes.set(tick, inst.eval('computeLockstepStateHashFast(' + tick + ')'));
            }
            if (world.exactHashes) (inst.tickExact ||= new Map()).set(tick, inst.eval('__exactStateHash()'));
            if (world.digestTicks && world.digestTicks.has(tick)) (inst.tickDigests ||= new Map()).set(tick, inst.eval('JSON.stringify(computeLockstepStateDigest(' + tick + '))'));
            for (const a of acts) if (a && a.netId && !inst.executedActions.has(a.netId)) inst.executedActions.set(a.netId, { tick, at: world.sched.now });
        },
        snapshotApplied: tick => { inst.snapshotsApplied++; inst.lastSnapshotTick = tick; (inst.snapshotTicks ||= []).push(tick); },
        issued: (netId, tick) => world.issued.set(netId, { at: world.sched.now, tick, by: inst.name })
    });
}

class World {
    constructor(options = {}) {
        this.sched = new Scheduler();
        this.net = new Network(this);
        this.instances = [];
        this.signalingMs = options.signalingMs ?? 80;
        this.hiddenTimerMinMs = options.hiddenTimerMinMs ?? 1000;
        this.hashEvery = options.hashEvery ?? 5;
        this.recordParts = !!options.recordParts;
        // Real gzip streams finish after a variable amount of wall time, which
        // would make runs irreproducible; JSON transport resolves on the next
        // virtual step. The compressed path has its own test.
        this.compressSnapshots = !!options.compressSnapshots;
        // Bit-exact fingerprints (the game's own hash rounds values).
        this.exactHashes = !!options.exactHashes;
        this.issued = new Map();
        this.tickScripts = new Map();
        this.controls = options.controls || {};
        if (options.network) this.net.setProfile(options.network);
    }
    get now() { return this.sched.now; }
    // Run `code` on every instance right after it simulates `tick`.
    atTick(tick, code) { if (!this.tickScripts.has(tick)) this.tickScripts.set(tick, []); this.tickScripts.get(tick).push(code); }
    // Schedule on a tick safely ahead of every live peer.
    atNextSafeTick(code, lead = 40) { const t = Math.max(...this.instances.filter(i => !i.dead).map(i => i.eval('currentTick'))) + lead; this.atTick(t, code); return t; }
    spawn(name, options = {}) {
        const inst = createInstance(this, name, { ...options, controls: { ...this.controls, ...(options.controls || {}) } });
        attachHooks(this, inst);
        if (!this.compressSnapshots) inst.eval('netEncodeSnapshotText = async (text) => ({ json: text })');
        this.instances.push(inst);
        this._scheduleFrame(inst);
        return inst;
    }
    // Tab visibility, as the page sees it (fires the visibilitychange path).
    setHidden(inst, hidden) {
        inst.hidden = !!hidden;
        inst.eval('refreshBackgroundTickMode()');
    }
    // Cut or restore the link between two instances. 'blackhole' drops
    // messages silently (like a dead route); 'up' restores it.
    setLink(a, b, state) { this.net.setLinkState(a.name, b.name, state); }
    // The whole machine loses its network: every link and the signaling
    // server. Existing peers report 'disconnected' and reconnect on return.
    setOffline(inst, offline) {
        inst.offline = !!offline;
        for (const o of this.instances) if (o !== inst && !o.dead) this.setLink(inst, o, offline ? 'blackhole' : 'up');
        for (const p of inst.peers) {
            if (p.destroyed) continue;
            if (offline && !p.disconnected) { p.disconnected = true; p.emit('disconnected'); }
        }
    }
    // { silent: true } models a crash or network switch: nobody is told, the
    // other side just stops hearing from it.
    kill(inst, { silent = false } = {}) {
        if (silent) { for (const o of this.instances) if (o !== inst) this.setLink(inst, o, 'blackhole'); }
        else { for (const p of inst.peers) { try { p.destroy(); } catch { } } }
        inst.dead = true;
    }
    _scheduleFrame(inst) {
        this.sched.at(this.sched.now + inst.frameMs, () => {
            if (!inst.hidden) {
                const cbs = inst.rafCallbacks;
                inst.rafCallbacks = [];
                for (const cb of cbs) cb(this.sched.now);
            }
            this._scheduleFrame(inst);
        }, inst);
    }
    // Virtual time advances in small steps; between steps the real event
    // loop runs, so promise/stream work (snapshot compression) completes.
    async run(ms, stepMs = 8) {
        const end = this.sched.now + ms;
        while (this.sched.now < end) {
            this.sched.runUntil(Math.min(end, this.sched.now + stepMs));
            await new Promise(r => setImmediate(r));
        }
    }
    async runUntil(pred, maxMs, stepMs = 50) {
        const end = this.sched.now + maxMs;
        while (this.sched.now < end) {
            if (pred()) return true;
            await this.run(Math.min(stepMs, end - this.sched.now));
        }
        return pred();
    }
    // Compare state hashes recorded on every instance for common ticks.
    compareHashes(instances = this.instances.filter(i => !i.dead), fromTick = 0, field = 'tickHashes') {
        const mismatches = [];
        let compared = 0;
        const [first, ...rest] = instances;
        if (!first) return { compared, mismatches };
        for (const [tick, hash] of (first[field] || new Map())) {
            if (tick < fromTick) continue;
            for (const other of rest) {
                if (!(other[field] || new Map()).has(tick)) continue;
                compared++;
                if (other[field].get(tick) !== hash) mismatches.push({ tick, a: first.name, b: other.name });
            }
        }
        return { compared, mismatches };
    }
    // Delay from issuing a command to executing it on the issuer, in ms.
    actionLatencies(inst) {
        const out = [];
        for (const [netId, issued] of this.issued) {
            if (issued.by !== inst.name) continue;
            const exec = inst.executedActions.get(netId);
            if (exec) out.push(exec.at - issued.at);
        }
        return out;
    }
}

// ------------------------------------------------------------------
// Scenario helpers
// ------------------------------------------------------------------
const SMALL_MATCH_CONTROLS = {
    'cfg-mapsize': '20', 'cfg-map-type': 'arena', 'cfg-gold-count': '8', 'cfg-astar-mine-count': '6',
    'cfg-gold-min': '2000', 'cfg-gold-max': '2000', 'cfg-astar-mine-min': '2000', 'cfg-astar-mine-max': '2000',
    'cfg-full-vis': 'team'
};

// `teams` gives the team color index of the host, then of each guest, e.g.
// [0, 1, 0, 1] is a 2v2. Default: everyone on their own team.
// `hostSetup` is code run on the host before the start (e.g. starting resources).
async function startHostedMatch(world, { guests = 1, hostName = 'host', guestNames = null, maxMs = 20000, controls = {}, teams = null, hostSetup = '', guestOptions = [] } = {}) {
    const teamOf = i => (teams ? teams[i] : i);
    const host = world.spawn(hostName, { controls });
    host.eval('loadOrCreateLocalIdentity(); hostOnlineGame();');
    if (!(await world.runUntil(() => !!host.eval('myPeerId'), 5000))) throw new Error('host peer never opened');
    const hostId = host.eval('myPeerId');
    const list = [];
    for (let i = 0; i < guests; i++) {
        const name = guestNames ? guestNames[i] : `guest${i + 1}`;
        const g = world.spawn(name, { ...(guestOptions[i] || {}), controls, url: `http://localhost/rng/defence3/index.html?game=${hostId}&room=${hostId}` });
        g.eval('loadOrCreateLocalIdentity()');
        g.eval(`joinGame(${JSON.stringify(hostId)})`);
        list.push(g);
    }
    const expectedPlayers = guests + 1;
    if (!(await world.runUntil(() => host.eval('lobbyPlayers.length') >= expectedPlayers && host.eval('connections.length') >= guests, maxMs))) {
        throw new Error('guests never joined the lobby: ' + host.eval('lobbyPlayers.length'));
    }
    // Every player picks their team color.
    host.eval(`(() => { const me = lobbyPlayers.find(p => p.peerId === myPeerId); if (me) me.color = TEAM_PRESET_COLORS[${teamOf(0)}]; broadcastLobbyState(true); })()`);
    list.forEach((g, i) => {
        g.eval(`(() => {
            const me = lobbyPlayers.find(p => p.peerId === myPeerId);
            if (me) { me.color = TEAM_PRESET_COLORS[${teamOf(i + 1)}]; connections[0].send({ type: 'LOBBY_UPDATE_SELF', name: me.name, color: me.color }); }
        })()`);
    });
    await world.run(1000);
    if (hostSetup) host.eval(hostSetup);
    host.eval('startHostedGame()');
    const started = await world.runUntil(() => [host, ...list].every(i => i.eval('gameStarted') && !i.eval('matchStartWaitingForReady')) && host.eval('currentTick') > 5, maxMs);
    if (!started) throw new Error('match never started: ' + JSON.stringify([host, ...list].map(i => [i.name, i.eval('gameStarted'), i.eval('matchStartWaitingForReady'), i.eval('currentTick')])));
    return { host, guests: list, hostId };
}

// Issue a varied, valid-looking command stream from one instance.
function issueRandomCommand(inst, rand) {
    return inst.eval(`(() => {
        if (!gameStarted || gameOver) return null;
        const r = ${rand};
        const mine = units.filter(u => u.owner === localPlayerId && !u.dead);
        const kinds = ['move', 'attackMove', 'place', 'stop', 'queue'];
        const kind = kinds[Math.floor(r * kinds.length) % kinds.length];
        const gx = 1 + Math.floor((r * 7919) % (GRID_W - 2)), gy = 1 + Math.floor((r * 104729) % (GRID_H - 2));
        if ((kind === 'move' || kind === 'attackMove') && mine.length) {
            queueAction({ action: kind, unitIds: mine.slice(0, 3).map(u => u.id), targetX: gx * TILE + 16, targetY: gy * TILE + 16 });
        } else if (kind === 'place') {
            const types = ['pistol', 'house', 'barrack_norm', 'spawner'].filter(t => BASE_CARD_TYPES[t]);
            queueAction({ action: 'place', gx, gy, itemType: types[Math.floor(r * 13) % types.length], autoUpgradeEnabled: true, buildEnabled: true });
        } else if (kind === 'stop' && mine.length) {
            queueAction({ action: 'stop', unitIds: [mine[0].id] });
        } else {
            const b = barracks.find(b => b.owner === localPlayerId && !b.underConstruction) || collectorSpawners.find(s => s.owner === localPlayerId && !s.underConstruction);
            if (b) queueAction({ action: b instanceof Barrack ? 'queueUnit' : 'queueWorker', gx: b.gx, gy: b.gy, count: 1 });
            else if (mine.length) queueAction({ action: 'move', unitIds: [mine[0].id], targetX: gx * TILE + 16, targetY: gy * TILE + 16 });
        }
        return kind;
    })()`);
}

// Advance time while every live, playing instance issues random commands.
async function playFor(world, instances, ms, { stepMs = 250, chance = 0.5, seed = 1 } = {}) {
    let state = seed >>> 0 || 1;
    const rand = () => { state = (state * 16807) % 2147483647; return state / 2147483647; };
    const end = world.now + ms;
    while (world.now < end) {
        for (const inst of instances) {
            if (inst.dead) continue;
            if (rand() < chance) { try { issueRandomCommand(inst, rand()); } catch (err) { inst.errors.push(err); } }
        }
        await world.run(Math.min(stepMs, end - world.now));
    }
}

// Common invariants for a scenario; returns a summary for logging.
function checkHealthy(world, instances, { minCompared = 10, fromTick = 0, label = '' } = {}) {
    const assert = require('node:assert/strict');
    const live = instances.filter(i => !i.dead);
    for (const inst of live) {
        assert.deepEqual(inst.errors.map(e => String(e && e.stack || e).slice(0, 400)), [], label + ' ' + inst.name + ' threw');
    }
    const cmp = world.compareHashes(live, fromTick);
    assert.equal(cmp.mismatches.length, 0, label + ' state diverged: ' + JSON.stringify(cmp.mismatches.slice(0, 3)));
    assert.ok(cmp.compared >= minCompared, label + ' too few hash comparisons: ' + cmp.compared);
    return cmp;
}

// Every command an instance issued must have executed on that instance.
function assertAllCommandsExecuted(world, inst, label = '', issuedBefore = Infinity) {
    const assert = require('node:assert/strict');
    const missing = [];
    for (const [netId, info] of world.issued) {
        if (info.by !== inst.name || info.at > issuedBefore) continue;
        if (!inst.executedActions.has(netId)) missing.push(netId);
    }
    assert.deepEqual(missing, [], label + ' ' + inst.name + ' lost commands');
}

function percentile(values, p) {
    if (!values.length) return NaN;
    const s = values.slice().sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.floor(p * s.length))];
}

module.exports = { World, startHostedMatch, issueRandomCommand, percentile, playFor, checkHealthy, assertAllCommandsExecuted, SMALL_MATCH_CONTROLS, SOURCE_FILES: files };
