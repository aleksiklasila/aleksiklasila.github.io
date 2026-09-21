// Shared transport is host-ordered and deliberately outside deterministic game state.
// Volume, autoplay permission and mute always belong to the local listener.
const Jukebox = (() => {
    const DEFAULT_VIDEO = '9JD2nH4M8Dc';
    let state = { videoId: DEFAULT_VIDEO, playing: true, position: 0, revision: 0 };
    let receivedAt = performance.now(), acceptedRevision = -1;
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

    function position() {
        return state.position + (state.playing ? Math.max(0, performance.now() - receivedAt) / 1000 : 0);
    }
    function snapshot() { return { ...state, position: position() }; }
    function send(conn, data) { try { conn.send(data); } catch { /* Reconnect requests a fresh snapshot. */ } }
    function broadcast() {
        if (!isMultiplayer || !isHost) return;
        const packet = { type: 'JUKEBOX_STATE', state: snapshot() };
        for (const conn of connections) if (conn && conn.open !== false) send(conn, packet);
    }
    function status() {
        if (!el('status')) return;
        el('play').textContent = state.playing ? 'Pause for everyone' : 'Play for everyone';
        el('play').title = state.playing ? 'Pause for everyone' : 'Play for everyone';
        el('enable').hidden = !blocked;
        el('status').textContent = message || (blocked ? 'Click Enable here to allow playback on this device.' : state.playing ? 'Playing for everyone' : 'Paused for everyone');
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
        if (!state.playing || audioBackgroundVolume <= 0 || localStopped || !audioEnabled) {
            // Stop instead of silently streaming. Shared time keeps running so
            // this listener can rejoin at the current position when unmuted.
            if (!playbackStopped) { playbackStopped = true; loadedVideo = ''; player.stopVideo(); }
            return;
        }
        const seconds = position();
        if (loadedVideo !== state.videoId) {
            loadedVideo = state.videoId;
            playbackStopped = false;
            player[state.playing ? 'loadVideoById' : 'cueVideoById']({ videoId: state.videoId, startSeconds: seconds });
        } else {
            if (force || Math.abs((player.getCurrentTime() || 0) - seconds) > 2.5) player.seekTo(seconds, true);
            if (state.playing && !blocked) player.playVideo();
            else if (!state.playing) player.pauseVideo();
        }
    }
    function accept(next, force = false) {
        if (!next || !/^[A-Za-z0-9_-]{11}$/.test(next.videoId || '') || typeof next.playing !== 'boolean' ||
            !Number.isFinite(next.position) || next.position < 0 || next.position > 604800 ||
            !Number.isSafeInteger(next.revision) || next.revision < 0 || next.revision < acceptedRevision) return false;
        const changed = next.revision > acceptedRevision;
        state = { videoId: next.videoId, playing: next.playing, position: next.position, revision: next.revision };
        receivedAt = performance.now(); acceptedRevision = next.revision;
        if (changed) message = '';
        if (started && !apiRequested && state.playing) start();
        else applyPlayer(force || changed);
        return true;
    }
    function commit(action) {
        if (!action || !['link','play','pause','restart'].includes(action.action)) return false;
        const next = snapshot();
        if (action.action === 'link') {
            const id = parseLink(action.link);
            if (!id) return false;
            next.videoId = id; next.position = 0; next.playing = true;
        } else if (action.action === 'restart') next.position = 0;
        else next.playing = action.action === 'play';
        next.revision++;
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
                    // Only the host advances the shared transport, avoiding client races.
                    if (event.data === 0 && !playbackStopped && state.playing && (!isMultiplayer || isHost)) commit({ action: 'restart' });
                },
                onError() { message = 'YouTube cannot play this video here. Change the link or open it on YouTube.'; status(); }
            }
        });
    }
    function start() {
        init(); started = true; localStopped = false;
        if (!apiRequested && state.playing && audioBackgroundVolume > 0 && audioEnabled) {
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
        if (timer || !el('play')) return;
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
        el('play').addEventListener('click', () => { start(); request({ action: state.playing ? 'pause' : 'play' }); });
        for (const name of ['music', 'effects']) el(name).addEventListener('input', () => {
            const value = Math.max(0, Math.min(1, Number(el(name).value) / 100));
            if (name === 'music') audioBackgroundVolume = value; else audioVolume = value;
            // Moving a slider is an explicit local request to enable sound.
            if (value > 0) audioEnabled = true;
            applyAudioSettings(); saveUiSettingsToStorage();
            const setting = document.getElementById(name === 'music' ? 'setting-background-audio-volume' : 'setting-audio-volume');
            if (setting) { setting.value = String(Math.round(value * 100)); document.getElementById(setting.id + '-value').textContent = setting.value + '%'; }
            const toggle = document.getElementById('setting-audio'); if (toggle) toggle.checked = audioEnabled;
        });
        el('enable').addEventListener('click', () => { blocked = false; start(); if (ready && state.playing) player.playVideo(); status(); });
        el('form').addEventListener('submit', event => {
            event.preventDefault();
            if (!parseLink(el('link').value)) { message = 'Enter a YouTube video link.'; status(); return; }
            start(); request({ action: 'link', link: el('link').value });
        });
        for (const event of ['keydown','keyup','pointerdown']) el('panel').addEventListener(event, event => event.stopPropagation());
        timer = setInterval(() => { if (started) { broadcast(); applyPlayer(); } }, 5000);
        volume(); status();
    }
    return { init, start, handle, connected, parseLink, snapshot,
        applyVolume() { if (started) start(); else volume(); },
        stopLocal() { localStopped = true; applyPlayer(); } };
})();
