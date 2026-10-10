// Test-only stand-in for PeerJS in real browser tabs (Playwright init
// script): the API the game uses (Peer: open/connection/error/close/
// disconnected, connect, destroy, disconnect, reconnect; DataConnection:
// open/data/close/error, send, close, peer, open, metadata), carried between
// the tabs of one browser over a BroadcastChannel, in order, with an
// optional one-way delay (window.__fakePeerDelayMs, default 25 ms). No
// signaling server, no WebRTC: multiplayer GUI tests run offline.
(() => {
    const CHANNEL = 'defence3-fake-peer';
    const bc = new BroadcastChannel(CHANNEL);
    const delay = () => Number(window.__fakePeerDelayMs ?? 25);
    const later = fn => { const d = delay(); if (d > 0) setTimeout(fn, d); else queueMicrotask(fn); };
    const rid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
    class Emitter {
        constructor() { this._ev = new Map(); }
        on(name, fn) { if (!this._ev.has(name)) this._ev.set(name, []); this._ev.get(name).push(fn); return this; }
        once(name, fn) { const w = (...a) => { this.off(name, w); fn(...a); }; return this.on(name, w); }
        off(name, fn) { const l = this._ev.get(name); if (l) { const i = l.indexOf(fn); if (i >= 0) l.splice(i, 1); } return this; }
        removeAllListeners(name) { if (name) this._ev.delete(name); else this._ev.clear(); return this; }
        emit(name, ...a) { const l = this._ev.get(name); if (!l) return false; for (const fn of l.slice()) { try { fn(...a); } catch (e) { console.error('[fake peer] listener', name, e); } } return true; }
    }
    const peers = new Map();
    const conns = new Map(); // `${localId}|${cid}` -> connection
    class FakeDataConnection extends Emitter {
        constructor(localId, remoteId, cid, options) {
            super();
            this._local = localId; this.peer = remoteId; this._cid = cid;
            this.open = false; this._closed = false;
            this.metadata = options && options.metadata;
            this.reliable = !!(options && options.reliable);
            this.serialization = 'binary';
            this.label = 'dc_' + cid;
            this.connectionId = cid;
            this.bufferSize = 0;
            conns.set(localId + '|' + cid, this);
        }
        send(data) {
            if (!this.open || this._closed) return;
            const msg = { t: 'data', to: this.peer, from: this._local, cid: this._cid, d: data };
            later(() => bc.postMessage(msg));
        }
        close() {
            if (this._closed) return;
            this._closed = true; this.open = false;
            conns.delete(this._local + '|' + this._cid);
            this.emit('close');
            later(() => bc.postMessage({ t: 'close', to: this.peer, from: this._local, cid: this._cid }));
        }
        _remoteClosed() {
            if (this._closed) return;
            this._closed = true; this.open = false;
            conns.delete(this._local + '|' + this._cid);
            this.emit('close');
        }
    }
    class FakePeer extends Emitter {
        constructor(id) {
            super();
            this.id = id || ('auto' + rid());
            this.open = false; this.destroyed = false; this.disconnected = false;
            this.connections = {};
            this._pending = new Map();
            peers.set(this.id, this);
            later(() => { if (this.destroyed) return; this.open = true; this.emit('open', this.id); });
        }
        connect(remoteId, options = {}) {
            const cid = rid();
            const conn = new FakeDataConnection(this.id, String(remoteId), cid, options);
            (this.connections[remoteId] ||= []).push(conn);
            const timer = setTimeout(() => {
                if (!this._pending.has(cid)) return;
                this._pending.delete(cid);
                this.emit('error', { type: 'peer-unavailable', message: `Could not connect to peer ${remoteId}` });
            }, 4000);
            this._pending.set(cid, timer);
            later(() => bc.postMessage({ t: 'conn', to: String(remoteId), from: this.id, cid, metadata: options.metadata ?? null, reliable: !!options.reliable }));
            return conn;
        }
        disconnect() { this.disconnected = true; this.emit('disconnected', this.id); }
        reconnect() { this.disconnected = false; }
        destroy() {
            if (this.destroyed) return;
            this.destroyed = true; this.open = false;
            for (const list of Object.values(this.connections)) for (const c of list) c.close();
            peers.delete(this.id);
            this.emit('close');
        }
    }
    bc.onmessage = ev => {
        const m = ev.data;
        if (!m || !peers.has(m.to)) return;
        const p = peers.get(m.to);
        if (p.destroyed) return;
        if (m.t === 'conn') {
            const conn = new FakeDataConnection(p.id, m.from, m.cid, { metadata: m.metadata, reliable: m.reliable });
            (p.connections[m.from] ||= []).push(conn);
            p.emit('connection', conn);
            later(() => {
                bc.postMessage({ t: 'ack', to: m.from, from: p.id, cid: m.cid });
                if (!conn._closed) { conn.open = true; conn.emit('open'); }
            });
        } else if (m.t === 'ack') {
            const t = p._pending.get(m.cid);
            if (t) { clearTimeout(t); p._pending.delete(m.cid); }
            const c = conns.get(p.id + '|' + m.cid);
            if (c && !c._closed) { c.open = true; c.emit('open'); }
        } else if (m.t === 'data') {
            const c = conns.get(p.id + '|' + m.cid);
            if (c && c.open) c.emit('data', m.d);
        } else if (m.t === 'close') {
            const c = conns.get(p.id + '|' + m.cid);
            if (c) c._remoteClosed();
        }
    };
    Object.defineProperty(window, 'Peer', { get: () => FakePeer, set: () => { }, configurable: true });
    // (Each tab its own player: the tabs of one context share localStorage,
    // where the game keeps its player id; sessionStorage is per tab.)
    try { Object.defineProperty(window, 'localStorage', { get: () => window.sessionStorage, configurable: true }); } catch { }
    window.__fakePeer = { peers, conns };
})();
