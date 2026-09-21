// The host orders only the shared link. Playback, position and volume are local.
// This keeps the jukebox out of deterministic game state and avoids syncing media.
const Jukebox = (() => {
    const DEFAULT_VIDEO = '9JD2nH4M8Dc';
    let state = { videoId: DEFAULT_VIDEO, revision: 0 };
    let acceptedRevision = -1;
    let player = null, ready = false, started = false, loadedVideo = '';
    let localStopped = false, blocked = false, apiRequested = false, playbackStopped = true;
    let message = '', timer = null;
    const requestTimes = new WeakMap();
    const el = id => document.getElementById('jukebox-' + id);

    function parseLink(value) {
        if (typeof value !== 'string' || value.length > 2048) return null;
        try {
            let url = new URL(value.trim());
            if (!['https:', 'http:'].includes(url.protocol)) return null;
            let host = url.hostname.toLowerCase(), id = '';
            if (host === 'youtu.be') id = url.pathname.slice(1);
            else if (['youtube.com','www.youtube.com','m.youtube.com','www.youtube-nocookie.com'].includes(host)) {
                id = url.searchParams.get('v') || (/^\/(?:embed|shorts|live)\/([^/]+)$/.exec(url.pathname) || [])[1];
            }
            return /^[A-Za-z0-9_-]{11}$/.test(id || '') ? id : null;
        } catch { return null; }
    }

    function snapshot() { return { ...state }; }
    function send(conn, data) { try { conn.send(data); } catch { /* Reconnect requests a fresh snapshot. */ } }
    function broadcast() {
        if (!isMultiplayer || !isHost) return;
        const packet = { type: 'JUKEBOX_STATE', state: snapshot() };
        for (const conn of connections) if (conn && conn.open !== false) send(conn, packet);
    }
    function status() {
        if (!el('status')) return;
        el('enable').hidden = !blocked;
        el('status').textContent = message || (blocked ? 'Click Enable here to allow playback on this device.' : audioBackgroundVolume > 0 && audioEnabled ? 'Playing on this device' : 'Music is muted on this device');
        el('external').href = 'https://www.youtube.com/watch?v=' + state.videoId;
    }
    function volume() {
        for (const [name, value] of [['music', audioBackgroundVolume], ['effects', audioVolume]]) {
            if (!el(name)) continue;
            const percent = Math.round(Math.max(0, Math.min(1, Number(value) || 0)) * 100);
            el(name).value = String(percent);
            el(name + '-value').textContent = percent === 0 ? 'Muted' : percent + '%';
        }
        if (!ready) return;
        let background = typeof audioBackgroundVolume === 'number' ? audioBackgroundVolume : 1;
        player.setVolume(Math.round(40 * Math.max(0, Math.min(1, background))));
        if (background <= 0 || localStopped || !audioEnabled) player.mute(); else player.unMute();
    }
    function applyPlayer(force = false) {
        status();
        volume();
        if (!ready || !started) return;
        if (audioBackgroundVolume <= 0 || localStopped || !audioEnabled) {
            // Stop instead of silently streaming. Resuming starts this listener's
            // own playback; it never changes another player's music.
            if (!playbackStopped) { playbackStopped = true; loadedVideo = ''; player.stopVideo(); }
            return;
        }
        if (loadedVideo !== state.videoId) {
            loadedVideo = state.videoId;
            playbackStopped = false;
            player.loadVideoById({ videoId: state.videoId, startSeconds: 0 });
        } else {
            if (!blocked) player.playVideo();
        }
    }
    function accept(next, force = false) {
        if (!next || !/^[A-Za-z0-9_-]{11}$/.test(next.videoId || '') ||
            !Number.isSafeInteger(next.revision) || next.revision < 0 || next.revision < acceptedRevision) return false;
        const changed = next.revision > acceptedRevision;
        state = { videoId: next.videoId, revision: next.revision };
        acceptedRevision = next.revision;
        if (changed) message = '';
        if (started && !apiRequested) start();
        else applyPlayer(force || changed);
        return true;
    }
    function commit(action) {
        if (!action || action.action !== 'link') return false;
        const id = parseLink(action.link);
        if (!id) return false;
        const next = { videoId: id, revision: state.revision + 1 };
        accept(next, true); broadcast();
        return true;
    }
    function request(action) {
        if (isMultiplayer && !isHost) {
            const host = connections.find(c => c.peer === wsHostId) || connections[0];
            if (!host || host.open === false) { message = 'Disconnected — reconnect to change the jukebox.'; status(); return; }
            send(host, { type: 'JUKEBOX_REQUEST', ...action });
        } else commit(action);
    }
    function handle(conn, data) {
        if (!data || !['JUKEBOX_REQUEST','JUKEBOX_STATE','JUKEBOX_SYNC'].includes(data.type)) return false;
        if (isHost) {
            if (typeof isPeerExplicitlyRemoved === 'function' && isPeerExplicitlyRemoved(conn.peer)) return true;
            if (data.type === 'JUKEBOX_SYNC') send(conn, { type: 'JUKEBOX_STATE', state: snapshot() });
            if (data.type === 'JUKEBOX_REQUEST') {
                const now = performance.now(), last = requestTimes.get(conn);
                if (last === undefined || now - last >= 150) { requestTimes.set(conn, now); commit(data); }
            }
        } else {
            const host = connections.find(c => c.peer === wsHostId) || connections[0];
            if (conn === host && data.type === 'JUKEBOX_STATE') accept(data.state);
        }
        return true;
    }
    function connected(conn) {
        if (isHost) send(conn, { type: 'JUKEBOX_STATE', state: snapshot() });
        else { acceptedRevision = -1; send(conn, { type: 'JUKEBOX_SYNC' }); }
    }
    function createPlayer() {
        if (player || !window.YT || !window.YT.Player) return;
        player = new YT.Player('jukebox-player', {
            width: '240', height: '200', videoId: state.videoId,
            playerVars: { playsinline: 1, controls: 0, disablekb: 1, origin: location.origin, rel: 0 },
            events: {
                onReady() { ready = true; message = ''; applyPlayer(true); },
                onAutoplayBlocked() { blocked = true; status(); },
                onStateChange(event) {
                    if (event.data === 1) { blocked = false; message = ''; status(); }
                },
                onError() { message = 'YouTube cannot play this video here. Change the link or open it on YouTube.'; status(); }
            }
        });
    }
    function start() {
        init(); started = true; localStopped = false;
        if (!apiRequested && audioBackgroundVolume > 0 && audioEnabled) {
            apiRequested = true;
            if (window.YT && window.YT.Player) createPlayer();
            else {
                window.onYouTubeIframeAPIReady = createPlayer;
                const script = document.createElement('script'); script.src = 'https://www.youtube.com/iframe_api';
                script.onerror = () => { apiRequested = false; message = 'YouTube is unavailable. Try Play again.'; status(); };
                document.head.appendChild(script);
            }
        }
        applyPlayer();
    }
    function init() {
        if (timer || !el('open')) return;
        try {
            if (localStorage.getItem('defence3_jukebox_muted') === '1') {
                audioBackgroundVolume = 0;
                localStorage.removeItem('defence3_jukebox_muted');
                saveUiSettingsToStorage();
            }
        } catch {}
        el('open').addEventListener('click', () => { volume(); el('panel').showModal(); });
        el('close').addEventListener('click', () => el('panel').close());
        el('panel').addEventListener('click', event => {
            if (event.target !== el('panel')) return;
            const rect = el('panel').getBoundingClientRect();
            if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) el('panel').close();
        });
        for (const name of ['music', 'effects']) el(name).addEventListener('input', () => {
            const value = Math.max(0, Math.min(1, Number(el(name).value) / 100));
            if (name === 'music') audioBackgroundVolume = value; else audioVolume = value;
            // Moving a slider is an explicit local request to enable sound.
            if (value > 0) audioEnabled = true;
            applyAudioSettings(); saveUiSettingsToStorage();
        });
        el('enable').addEventListener('click', () => { blocked = false; start(); if (ready) player.playVideo(); status(); });
        el('form').addEventListener('submit', event => {
            event.preventDefault();
            if (!parseLink(el('link').value)) { message = 'Enter a YouTube video link.'; status(); return; }
            start(); request({ action: 'link', link: el('link').value });
        });
        for (const event of ['keydown','keyup','pointerdown']) el('panel').addEventListener(event, event => event.stopPropagation());
        timer = setInterval(() => { if (started) applyPlayer(); }, 5000);
        volume(); status();
    }
    return { init, start, handle, connected, parseLink, snapshot,
        applyVolume() { if (started) start(); else volume(); },
        stopLocal() { localStopped = true; applyPlayer(); } };
})();
