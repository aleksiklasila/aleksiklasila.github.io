"use strict";

// Per-player startup status map: peerId -> 'preparing'|'loading'|'ready'. Null when no startup in progress.
let _matchStartPlayerStatuses = null;
// Countdown timer for the all-ready launch sequence.
let _matchStartCountdownHandle = null;
let _matchStartCountdownRemaining = 0;

// ============================================================
// MULTIPLAYER (PeerJS)
// ============================================================
function _escapeHtml(v) {
    return String(v ?? '').replace(/[&<>'"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '\'': '&#39;', '"': '&quot;' }[c]));
}

function normalizeLobbyColor(color) {
    let c = String(color || '').toLowerCase();
    if (!TEAM_PRESET_COLORS.includes(c)) return TEAM_PRESET_COLORS[0];
    return c;
}

function defaultLobbyName(peerId) {
    let pid = String(peerId || '').trim();
    if (pid && myPeerId && pid === myPeerId && localPreferredName) return localPreferredName;
    if (!peerId) return 'Player';
    return `Player-${String(peerId).slice(0, 4)}`;
}

function loadOrCreateLocalIdentity() {
    let storedId = '';
    let storedName = '';
    try {
        storedId = String(localStorage.getItem(LS_PLAYER_UID_KEY) || '').trim();
        storedName = String(localStorage.getItem(LS_PLAYER_NAME_KEY) || '').trim();
    } catch { }
    if (!storedId) {
        storedId = generateSocketId();
        try { localStorage.setItem(LS_PLAYER_UID_KEY, storedId); } catch { }
    }
    localPersistentPeerId = storedId;
    let fallbackName = defaultLobbyName(storedId);
    localPreferredName = (storedName || fallbackName).slice(0, 24);
    try { localStorage.setItem(LS_PLAYER_NAME_KEY, localPreferredName); } catch { }
}

function setLocalPreferredName(name) {
    let n = String(name || '').trim().slice(0, 24);
    if (!n) n = defaultLobbyName(localPersistentPeerId || myPeerId || '');
    localPreferredName = n;
    try { localStorage.setItem(LS_PLAYER_NAME_KEY, n); } catch { }
    return n;
}

function getTeamIdForPeer(peerId) {
    let setup = computeTeamSetupFromLobby();
    let tid = setup.teamByPeer[String(peerId || '')];
    return Number.isFinite(tid) ? tid : -1;
}

function setMatchRoleForTeam(teamId, role, options = {}) {
    let normalizedRole = normalizeMatchRole(role, '');
    let tid = Number.isFinite(teamId) ? Math.floor(teamId) : Math.floor(Number(teamId));
    if (!normalizedRole || !Number.isFinite(tid) || tid < 0) return false;

    let setup = computeTeamSetupFromLobby();
    let touched = false;
    for (let lp of (lobbyPlayers || [])) {
        if (!lp || !lp.peerId) continue;
        if (setup.teamByPeer[lp.peerId] !== tid) continue;
        matchRoleByPeerId[lp.peerId] = normalizedRole;
        let uid = getPeerProfileUid(lp.peerId) || String(lp.uid || '').trim();
        if (uid) matchRoleByUid[uid] = normalizedRole;
        touched = true;
    }

    if (myPeerId && setup.teamByPeer[myPeerId] === tid) {
        matchRoleByPeerId[myPeerId] = normalizedRole;
        let myUid = getPeerProfileUid(myPeerId) || String(localPersistentPeerId || '').trim();
        if (myUid) matchRoleByUid[myUid] = normalizedRole;
        touched = true;
    }

    if (isHost && touched && options.broadcast !== false) {
        broadcastLobbyState();
        renderOnlineLobby();
    }
    return touched;
}

function ensureMatchLoadOverlayElement() {
    let el = document.getElementById('match-load-overlay');
    if (el) return el;
    el = document.createElement('div');
    el.id = 'match-load-overlay';
    el.style.position = 'fixed';
    el.style.left = '0';
    el.style.top = '0';
    el.style.width = '100vw';
    el.style.height = '100vh';
    el.style.display = 'none';
    el.style.alignItems = 'center';
    el.style.justifyContent = 'center';
    el.style.background = 'rgba(8, 12, 18, 0.86)';
    el.style.zIndex = '14000';
    el.innerHTML = '<div style="min-width:280px;max-width:480px;padding:20px 24px;border-radius:14px;background:linear-gradient(145deg,#1d2633,#141b25);border:1px solid rgba(255,255,255,0.12);box-shadow:0 10px 36px rgba(0,0,0,0.45);color:#eaf2ff;font-family:\'Segoe UI\',\'Trebuchet MS\',sans-serif;text-align:center;">'
        + '<div id="match-load-overlay-title" style="font-size:22px;font-weight:700;letter-spacing:0.2px;margin-bottom:8px;">Loading Match</div>'
        + '<div id="match-load-overlay-detail" style="font-size:14px;line-height:1.45;opacity:0.92;">Preparing game state...</div>'
        + '<div id="match-load-overlay-players" style="display:none;margin-top:14px;text-align:left;border-top:1px solid rgba(255,255,255,0.1);padding-top:12px;"></div>'
        + '</div>';
    document.body.appendChild(el);
    return el;
}

function _startMatchCountdown(totalSeconds) {
    _stopMatchCountdown();
    // Keep strict lockstep paused for host and guests until START_GAME_ALL_READY.
    matchStartWaitingForReady = true;
    _matchStartCountdownRemaining = Math.max(1, Math.floor(totalSeconds));
    _tickMatchCountdown();
    _matchStartCountdownHandle = setInterval(() => {
        _matchStartCountdownRemaining--;
        if (_matchStartCountdownRemaining <= 0) {
            _stopMatchCountdown();
            if (isHost) {
                matchStartWaitingForReady = false;
                _matchStartPlayerStatuses = null;
                setMatchLoadOverlay(false);
                broadcastStartGameAllReady();
            }
            // Clients close their overlay when START_GAME_ALL_READY arrives.
        } else {
            _tickMatchCountdown();
        }
    }, 1000);
}

function _stopMatchCountdown() {
    if (_matchStartCountdownHandle) { clearInterval(_matchStartCountdownHandle); _matchStartCountdownHandle = null; }
    _matchStartCountdownRemaining = 0;
}

function _tickMatchCountdown() {
    setMatchLoadOverlay(true, 'All Players Ready!', 'Starting in\u00a0' + _matchStartCountdownRemaining + '\u2026');
}

function _updateMatchLoadOverlayPlayers() {
    ensureMatchLoadOverlayElement();
    let btnEl = document.getElementById('btn-start-online');
    let listEl = document.getElementById('match-load-overlay-players');
    if (!listEl) return;
    let statuses = _matchStartPlayerStatuses;
    if (!statuses || Object.keys(statuses).length === 0) {
        listEl.style.display = 'none';
        return;
    }
    listEl.style.display = 'block';
    let allPlayers = (lobbyPlayers && lobbyPlayers.length > 0) ? lobbyPlayers : [];
    let pids = Object.keys(statuses);
    let html = '';
    for (let pid of pids) {
        let status = statuses[pid];
        let lp = allPlayers.find(p => p && p.peerId === pid);
        let name = lp ? (lp.name || defaultLobbyName(pid)).slice(0, 28) : defaultLobbyName(pid).slice(0, 28);
        let isMe = pid === myPeerId;
        let icon, color, label;
        if (status === 'ready') { icon = '&#10003;'; color = '#6fcf6f'; label = 'Ready'; }
        else if (status === 'loading') { icon = '&#8943;'; color = '#faa43a'; label = 'Loading…'; }
        else { icon = '&#8943;'; color = '#8ab4d0'; label = 'Preparing…'; }
        html += `<div style="display:flex;align-items:center;gap:8px;padding:4px 2px;font-size:13px;">`
            + `<span style="width:18px;text-align:center;font-size:15px;color:${color};font-weight:700;">${icon}</span>`
            + `<span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${_escapeHtml(name)}${isMe ? ' <span style="opacity:0.55;font-size:11px;">(you)</span>' : ''}</span>`
            + `<span style="font-size:12px;color:${color};white-space:nowrap;">${label}</span>`
            + `</div>`;
    }
    listEl.innerHTML = html;
    if (btnEl) {
        if (isHost && _matchStartPlayerStatuses) {
            let allReady = Object.values(statuses).every(s => s === 'ready');
            btnEl.style.display = 'block';
            btnEl.disabled = !allReady;
            btnEl.style.opacity = allReady ? '1' : '0.45';
            btnEl.style.cursor = allReady ? 'pointer' : 'not-allowed';
            btnEl.textContent = allReady ? '\u25BA Start Game' : 'Waiting for players…';
        } else {
            btnEl.style.display = 'none';
        }
    }
}

function setMatchLoadOverlay(visible, title = 'Loading Match', detail = 'Preparing game state...') {
    let el = ensureMatchLoadOverlayElement();
    let t = document.getElementById('match-load-overlay-title');
    let d = document.getElementById('match-load-overlay-detail');
    if (t) t.textContent = String(title || 'Loading Match');
    if (d) d.textContent = String(detail || 'Preparing game state...');
    el.style.display = visible ? 'flex' : 'none';
    if (visible) _updateMatchLoadOverlayPlayers();
}

function areAllMatchStartPeersReady() {
    if (!Array.isArray(matchStartExpectedReadyPeerIds) || matchStartExpectedReadyPeerIds.length <= 0) return true;
    for (let pid of matchStartExpectedReadyPeerIds) {
        if (!matchStartReadyByPeerId[pid]) return false;
    }
    return true;
}

function updateHostMatchStartReadyUi() {
    _updateMatchLoadOverlayPlayers();
}

function broadcastStartGameAllReady() {
    let payload = { type: 'START_GAME_ALL_READY', startSessionId: matchStartSessionId };
    for (let c of connections) {
        if (!c) continue;
        try { c.send(payload); } catch { }
    }
    // Retry a few times in case one packet drops during heavy startup.
    setTimeout(() => {
        for (let c of connections) {
            if (!c) continue;
            try { c.send(payload); } catch { }
        }
    }, 200);
    setTimeout(() => {
        for (let c of connections) {
            if (!c) continue;
            try { c.send(payload); } catch { }
        }
    }, 700);
}

function canonicalPeerId(peerId) {
    let pid = String(peerId || '').trim();
    if (!pid) return '';
    if (myPeerId) {
        if (pid === myPeerId) return myPeerId;
        if (isHost && wsHostId && pid === wsHostId) return myPeerId;
    }
    return pid;
}

function isLocalPeerAlias(peerId) {
    let pid = String(peerId || '').trim();
    if (!pid) return false;
    if (myPeerId && pid === myPeerId) return true;
    if (isHost && wsHostId && pid === wsHostId) return true;
    return false;
}

function getPeerProfileUid(peerId) {
    let pid = canonicalPeerId(peerId);
    if (!pid) return '';
    if (pid === myPeerId) return localPersistentPeerId || pid;
    return String(peerUidByPeerId[pid] || pid);
}

function migratePeerIdByUid(uid, newPeerId) {
    let profileUid = String(uid || '').trim();
    let targetPeerId = canonicalPeerId(newPeerId);
    if (!profileUid || !targetPeerId) return { hasActiveDuplicate: false, migrated: false };

    let matchingSet = new Set();
    for (let pid of Object.keys(peerUidByPeerId)) {
        if (pid !== targetPeerId && peerUidByPeerId[pid] === profileUid) matchingSet.add(pid);
    }
    for (let lp of (lobbyPlayers || [])) {
        if (!lp || !lp.peerId) continue;
        if (lp.peerId !== targetPeerId && String(lp.uid || '') === profileUid) matchingSet.add(lp.peerId);
    }
    for (let mp of (matchStartLobbyPlayers || [])) {
        if (!mp || !mp.peerId) continue;
        if (mp.peerId !== targetPeerId && String(mp.uid || '') === profileUid) matchingSet.add(mp.peerId);
    }

    let matchingPeerIds = Array.from(matchingSet);
    let activePeerIds = matchingPeerIds.filter(pid => peerPresenceById[pid] !== false);
    if (activePeerIds.length > 0) return { hasActiveDuplicate: true, activePeerIds, migrated: false };

    let migrated = false;
    let fallbackName = '';
    let fallbackColor = '';
    for (let oldPeerId of matchingPeerIds) {
        peerPresenceById[oldPeerId] = false;
        clearPeerRemovedFromMatch(oldPeerId);
        if (matchRoleByPeerId[oldPeerId] && !matchRoleByPeerId[targetPeerId]) {
            matchRoleByPeerId[targetPeerId] = matchRoleByPeerId[oldPeerId];
        }
        delete matchRoleByPeerId[oldPeerId];
        delete peerUidByPeerId[oldPeerId];

        for (let lp of (lobbyPlayers || [])) {
            if (lp && lp.peerId === oldPeerId) {
                fallbackName = fallbackName || String(lp.name || '');
                fallbackColor = fallbackColor || normalizeLobbyColor(lp.color);
                lp.peerId = targetPeerId;
                lp.uid = profileUid;
                migrated = true;
            }
        }
        for (let mp of (matchStartLobbyPlayers || [])) {
            if (mp && mp.peerId === oldPeerId) {
                fallbackName = fallbackName || String(mp.name || '');
                fallbackColor = fallbackColor || normalizeLobbyColor(mp.color);
                mp.peerId = targetPeerId;
                mp.uid = profileUid;
                migrated = true;
            }
        }
    }

    if (!lobbyPlayers.some(lp => lp && lp.peerId === targetPeerId)) {
        lobbyPlayers.push({
            peerId: targetPeerId,
            name: (fallbackName || defaultLobbyName(targetPeerId)).slice(0, 24),
            color: normalizeLobbyColor(fallbackColor || TEAM_PRESET_COLORS[(lobbyPlayers.length) % TEAM_PRESET_COLORS.length]),
            uid: profileUid
        });
        migrated = true;
    }
    if (!matchStartLobbyPlayers.some(lp => lp && lp.peerId === targetPeerId)) {
        matchStartLobbyPlayers.push({
            peerId: targetPeerId,
            name: (fallbackName || defaultLobbyName(targetPeerId)).slice(0, 24),
            color: normalizeLobbyColor(fallbackColor || TEAM_PRESET_COLORS[(matchStartLobbyPlayers.length) % TEAM_PRESET_COLORS.length]),
            uid: profileUid
        });
    }
    clearPeerRemovedFromMatch(targetPeerId);
    peerUidByPeerId[targetPeerId] = profileUid;

    return { hasActiveDuplicate: false, migrated };
}

function generateGameSessionId() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') {
        return window.crypto.randomUUID();
    }
    return `${generateSocketId()}-${generateSocketId()}`;
}

function _broadcastResyncPauseState(active, sessionId, reason = '') {
    let payload = {
        type: 'LOCKSTEP_RESYNC_PAUSE',
        active: !!active,
        sessionId: String(sessionId || ''),
        reason: String(reason || '')
    };
    for (let c of connections) {
        if (!c || !c.peer) continue;
        try { c.send(payload); } catch { }
    }
}

function _isHostResyncPauseComplete() {
    if (!lockstepResyncPauseActive) return true;
    let map = (lockstepResyncPendingAckByPeer && typeof lockstepResyncPendingAckByPeer === 'object')
        ? lockstepResyncPendingAckByPeer
        : {};
    let keys = Object.keys(map);
    if (keys.length <= 0) return true;
    for (let pid of keys) if (!map[pid]) return false;
    return true;
}

function _finishHostResyncPause(reason = '') {
    if (!lockstepResyncPauseActive) return;
    lockstepResyncPauseActive = false;
    lockstepResyncPendingAckByPeer = {};
    lockstepResyncSnapshotCache = null;
    lockstepResyncDeadlineAt = 0;
    lockstepResyncRequestedAt = 0;
    let sessionId = String(lockstepResyncSessionId || '');
    lockstepResyncSessionId = '';
    waitingForRemoteSince = 0;
    _broadcastResyncPauseState(false, sessionId, reason);
    // Everyone restarts from the snapshot tick; seal it right away.
    _hostAdvanceBundles(performance.now());
}

function _sendResyncSnapshotTo(conn) {
    let cache = lockstepResyncSnapshotCache;
    if (!conn || !cache || !cache.payload) return false;
    let pid = String(conn.peer || '');
    // Tracked per connection: a peer that reconnected needs it again. A link
    // still opening would drop it; it is sent when the link opens.
    if (cache.sentTo.has(conn)) return true;
    if (conn.open === false) return false;
    cache.sentTo.add(conn);
    let fullSync = cache.fullSyncByPeer[pid];
    let payload = netSnapshotPayloadForPeer(pid, cache.payload, cache.text);
    try {
        if (fullSync) {
            // A client without a running match gets the settings and world
            // together with the snapshot, in one message.
            conn.send({ ...fullSync, snapshotPayload: payload, resyncSessionId: cache.sessionId });
        } else {
            conn.send({ type: 'MATCH_STATE_SNAPSHOT', payload, sessionId: cache.sessionId, tick: cache.tick });
        }
    } catch { }
    return true;
}

// Pause the match, restore the host from the snapshot text it sends, and wait
// until every connected peer applied the same text. `fullSync` maps a peer id
// to a START_GAME/START_SPECTATE message for peers joining mid-match.
function _startHostResyncPause(reason = '', includeConfig = false, options = {}) {
    if (!isHost || !gameStarted) return;
    if (lockstepStrictDebugMode) {
        stopLockstepDebugMatch('resync requested in exact lockstep mode', { tick: currentTick, reason: String(reason || '') });
        return;
    }
    let fullSyncByPeer = (options && options.fullSync) || {};
    if (lockstepResyncPauseActive && lockstepResyncSnapshotCache) {
        // A resync is running: late requesters just get the same snapshot.
        // A peer asking again lost it (or the pause notice), so it gets both
        // again rather than being ignored until the resync times out.
        let cache = lockstepResyncSnapshotCache;
        let requester = String((options && options.requester) || '');
        for (let pid of Object.keys(fullSyncByPeer)) cache.fullSyncByPeer[pid] = fullSyncByPeer[pid];
        let pauseMsg = { type: 'LOCKSTEP_RESYNC_PAUSE', active: true, sessionId: cache.sessionId, reason: String(reason || '') };
        for (let c of connections) {
            if (!c || !c.peer || isPeerExplicitlyRemoved(c.peer)) continue;
            let pid = String(c.peer);
            let isNew = !Object.prototype.hasOwnProperty.call(lockstepResyncPendingAckByPeer, pid);
            if (pid === requester) {
                cache.sentTo.delete(c);
                lockstepResyncPendingAckByPeer[pid] = false;
            } else if (isNew) {
                lockstepResyncPendingAckByPeer[pid] = false;
            }
            if ((pid === requester || isNew) && !cache.sentTo.has(c)) { try { c.send(pauseMsg); } catch { } }
            _sendResyncSnapshotTo(c);
        }
        lockstepResyncDeadlineAt = performance.now() + 20000;
        return;
    }

    let now = performance.now();
    let sessionId = generateGameSessionId();
    let t0 = performance.now();
    // Peers joining from scratch generated their own map; send the host's.
    let snapshot = buildHostAuthoritativeStateSnapshot({
        includeConfig,
        includeStaticMapState: Object.keys(fullSyncByPeer).length > 0,
        includeGridTypes: true
    });
    let text = JSON.stringify(snapshot);
    netCounters.snapshotBuildMs = performance.now() - t0;
    // The host restores from the exact text the peers receive, so everyone
    // starts from identical state, including anything the snapshot rounds.
    let applyStart = performance.now();
    applyAuthoritativeStateSnapshot(JSON.parse(text));
    netCounters.snapshotApplyMs = performance.now() - applyStart;
    netCounters.hardResyncs++;
    netCounters.lastSnapshotAt = now;

    let ackMap = {};
    for (let c of connections) {
        if (c && c.peer && !isPeerExplicitlyRemoved(c.peer)) ackMap[String(c.peer)] = false;
    }
    lockstepResyncPauseActive = true;
    lockstepResyncSessionId = sessionId;
    lockstepResyncPendingAckByPeer = ackMap;
    lockstepResyncRequestedAt = now;
    lockstepResyncDeadlineAt = now + 20000;
    waitingForRemoteSince = now;
    lockstepResyncSnapshotCache = { sessionId, tick: currentTick, payload: null, text, sentTo: new Set(), fullSyncByPeer: { ...fullSyncByPeer } };
    logLockstepWarning('Host resynchronizing match', { tick: currentTick, reason: String(reason || ''), bytes: text.length });

    _broadcastResyncPauseState(true, sessionId, reason);
    netEncodeSnapshotText(text).then(payload => {
        let cache = lockstepResyncSnapshotCache;
        if (!cache || cache.sessionId !== sessionId) return;
        cache.payload = payload;
        netCounters.snapshotBytes = netSnapshotPayloadBytes(payload);
        for (let c of connections) {
            if (c && c.peer && Object.prototype.hasOwnProperty.call(lockstepResyncPendingAckByPeer, String(c.peer))) _sendResyncSnapshotTo(c);
        }
    });

    if (_isHostResyncPauseComplete()) {
        _finishHostResyncPause('no remote peers pending');
    }
}

function _markHostResyncAck(peerId, sessionId) {
    if (!isHost || !lockstepResyncPauseActive) return;
    let sid = String(sessionId || '');
    if (sid && lockstepResyncSessionId && sid !== lockstepResyncSessionId) return;
    let pid = String(peerId || '');
    if (!pid) return;
    if (lockstepResyncPendingAckByPeer && Object.prototype.hasOwnProperty.call(lockstepResyncPendingAckByPeer, pid)) {
        lockstepResyncPendingAckByPeer[pid] = true;
    }
    if (_isHostResyncPauseComplete()) {
        _finishHostResyncPause('all peers acknowledged snapshot');
    }
}

// Host: give a peer that has no running match (page reload, late spectator)
// the full match through a resync.
function hostSendFullMatchSync(conn, role) {
    if (!isHost || !conn || !conn.peer) return;
    let normalizedRole = normalizeMatchRole(role, 'spectating');
    let payload = buildHostMatchSyncPayload();
    let message = { type: normalizedRole === 'spectating' ? 'START_SPECTATE' : 'START_GAME', ...payload };
    _startHostResyncPause(`full sync for ${conn.peer}`, true, { fullSync: { [String(conn.peer)]: message } });
}

function normalizeIncomingLobbyPlayers(players) {
    let list = Array.isArray(players) ? players : [];
    let byPeer = new Map();
    for (let p of list) {
        let pid = canonicalPeerId(p && p.peerId);
        if (!pid) continue;
        byPeer.set(pid, {
            peerId: pid,
            name: String((p && p.name) || '').slice(0, 24),
            color: normalizeLobbyColor(p && p.color),
            uid: String((p && p.uid) || '')
        });
    }
    return Array.from(byPeer.values());
}

function notePeerLatency(peerId, rttMs) {
    let pid = canonicalPeerId(peerId);
    if (!pid || !Number.isFinite(rttMs) || rttMs < 0) return;
    netNoteRttSample(pid, rttMs);
    let link = netGetLinkStats(pid);
    peerLatencyByPeerId[pid] = link && Number.isFinite(link.srtt) ? Math.round(link.srtt) : Math.round(rttMs);
    peerLatencyUpdatedAtByPeerId[pid] = performance.now();
}

function getPeerLatencyMs(peerId) {
    let pid = canonicalPeerId(peerId);
    if (!pid) return null;

    if (pid === myPeerId && isHost) return 0;

    let localMs = Number(peerLatencyByPeerId[pid]);
    let localAt = Number(peerLatencyUpdatedAtByPeerId[pid]);
    let now = performance.now();
    if (Number.isFinite(localMs) && Number.isFinite(localAt) && (now - localAt) <= NETWORK_LATENCY_STALE_MS) {
        return Math.max(0, Math.round(localMs));
    }

    let remoteMs = Number(remoteLatencyByPeerId[pid]);
    if (Number.isFinite(remoteMs) && remoteMs >= 0) {
        return Math.max(0, Math.round(remoteMs));
    }

    if (!isHost && pid === myPeerId) {
        let hostPeer = canonicalPeerId(wsHostId || (connections[0] && connections[0].peer));
        let hostMs = Number(peerLatencyByPeerId[hostPeer]);
        let hostAt = Number(peerLatencyUpdatedAtByPeerId[hostPeer]);
        if (Number.isFinite(hostMs) && Number.isFinite(hostAt) && (now - hostAt) <= NETWORK_LATENCY_STALE_MS) {
            return Math.max(0, Math.round(hostMs));
        }
    }

    return null;
}

function getPeerLatencyLabel(peerId) {
    let ms = getPeerLatencyMs(peerId);
    return Number.isFinite(ms) ? `${ms} ms` : '--';
}

// Pings carry the sender's clock, so any number may be in flight, and a
// self-report (input delay, stalls) the host shows in the network panel.
function sendNetworkPings(now = performance.now()) {
    if (connections.length === 0) return;
    let interval = (gameStarted && isMultiplayer) ? NET_PING_INTERVAL_IN_MATCH_MS : NETWORK_PING_INTERVAL_MS;
    if ((now - lastNetworkPingSweepAt) < interval) return;
    lastNetworkPingSweepAt = now;
    let report = (gameStarted && isMultiplayer) ? netLocalReport(now) : null;
    for (let c of connections) {
        if (!c || !c.peer) continue;
        let seq = nextNetworkPingSeq++;
        try { c.send({ type: 'NET_PING', seq, t: now, report }); } catch { }
    }
}

function buildHostLatencySnapshot() {
    let map = {};
    for (let lp of (lobbyPlayers || [])) {
        if (!lp || !lp.peerId) continue;
        let pid = canonicalPeerId(lp.peerId);
        if (!pid) continue;
        let ms = getPeerLatencyMs(pid);
        if (Number.isFinite(ms)) map[pid] = Math.round(ms);
    }
    if (myPeerId && map[myPeerId] === undefined) map[myPeerId] = 0;
    return map;
}

function normalizeMatchRole(role, fallback = '') {
    let r = String(role || '').toLowerCase();
    if (r === 'playing' || r === 'spectating') return r;
    return fallback;
}

// Match settings for a client joining a running match. The state itself
// arrives as a snapshot (see hostSendFullMatchSync); tick history is kept
// only for a bounded window, so it is never replayed from the start.
function buildHostMatchSyncPayload() {
    return {
        seed: gameSeed,
        startSessionId: matchStartSessionId,
        lobbyPlayers: matchStartLobbyPlayers.length ? matchStartLobbyPlayers : lobbyPlayers,
        cfg: matchStartConfig,
        currentTick,
        roleByPeer: buildHostRoleSnapshot(),
        presenceByPeer: buildHostPresenceSnapshot(),
        latencyByPeer: buildHostLatencySnapshot()
    };
}

function buildHostRoleSnapshot() {
    let map = {};
    for (let lp of (lobbyPlayers || [])) {
        if (!lp || !lp.peerId) continue;
        let role = normalizeMatchRole(matchRoleByPeerId[lp.peerId], gameStarted ? 'spectating' : 'playing');
        map[lp.peerId] = role || (gameStarted ? 'spectating' : 'playing');
    }
    if (myPeerId && !map[myPeerId]) {
        map[myPeerId] = (gameStarted && (localDefeated || spectateMode !== 'none')) ? 'spectating' : 'playing';
    }
    return map;
}

function buildHostPresenceSnapshot() {
    let map = {};
    for (let lp of (lobbyPlayers || [])) {
        if (!lp || !lp.peerId) continue;
        map[lp.peerId] = lp.peerId === myPeerId ? true : (peerPresenceById[lp.peerId] !== false);
    }
    if (myPeerId && map[myPeerId] === undefined) map[myPeerId] = true;
    return map;
}

function cloneSnapshotValue(value, ancestors = new Set()) {
    if (value === undefined || value === null) return value;
    if (typeof value !== 'object') return value;
    if (typeof value === 'function') return undefined;

    // Detect and break cycles using a recursion stack (ancestors set).
    // This allows duplicate references in different branches but prevents infinite recursion.
    if (ancestors.has(value)) return null;
    ancestors.add(value);

    let out;
    try {
        if (Array.isArray(value)) {
            out = [];
            for (let i = 0; i < value.length; i++) {
                out[i] = cloneSnapshotValue(value[i], ancestors);
            }
        } else {
            out = {};
            // For class instances (Unit, Tower), we only want to clone their data properties.
            for (let k of Object.keys(value)) {
                // Skip internal/private properties
                if (k.startsWith('_')) continue;
                out[k] = cloneSnapshotValue(value[k], ancestors);
            }
        }
    } finally {
        ancestors.delete(value);
    }
    return out;
}

function snapshotEntity(obj, omitKeys = []) {
    if (!obj || typeof obj !== 'object') return null;
    let omit = new Set(omitKeys);
    let out = {};
    for (let k of Object.keys(obj)) {
        if (omit.has(k)) continue;
        let val = obj[k];
        
        // If the property is another entity, convert it to a ref to avoid circularity.
        let ref = makeSnapshotEntityRef(val);
        if (ref) {
            out[k] = ref;
        } else {
            out[k] = val;
        }
    }
    return cloneSnapshotValue(out);
}

function makeSnapshotEntityRef(target) {
    if (!target || typeof target !== 'object') return null;
    if (target instanceof Unit) {
        return { kind: 'unit', id: Math.floor(Number(target.id) || 0) };
    }
    if (target instanceof Tower) {
        return {
            kind: 'tower',
            owner: Math.floor(Number(target.owner) || 0),
            gx: Math.floor(Number(target.gx) || 0),
            gy: Math.floor(Number(target.gy) || 0),
            type: String(target.type || '')
        };
    }
    if (target instanceof Barrack) {
        return {
            kind: 'barrack',
            owner: Math.floor(Number(target.owner) || 0),
            gx: Math.floor(Number(target.gx) || 0),
            gy: Math.floor(Number(target.gy) || 0),
            unitType: String(target.unitType || '')
        };
    }
    if (isSpawnerEntity(target)) {
        return {
            kind: 'spawner',
            owner: Math.floor(Number(target.owner) || 0),
            gx: Math.floor(Number(target.gx) || 0),
            gy: Math.floor(Number(target.gy) || 0),
            type: String(target.type || '')
        };
    }
    if (Number.isFinite(target.gx) && Number.isFinite(target.gy) && Number.isFinite(target.gold)) {
        return {
            kind: 'mine',
            gx: Math.floor(Number(target.gx) || 0),
            gy: Math.floor(Number(target.gy) || 0)
        };
    }
    if (Number.isFinite(target.gx) && Number.isFinite(target.gy) && Number.isFinite(target.astar)) {
        return {
            kind: 'astarMine',
            gx: Math.floor(Number(target.gx) || 0),
            gy: Math.floor(Number(target.gy) || 0)
        };
    }
    if (Number.isFinite(target.gx) && Number.isFinite(target.gy) && target.type) {
        return {
            kind: 'gridItem',
            owner: Math.floor(Number(target.owner) || 0),
            gx: Math.floor(Number(target.gx) || 0),
            gy: Math.floor(Number(target.gy) || 0),
            type: String(target.type || '')
        };
    }
    return null;
}

function resolveSnapshotEntityRef(ref, context) {
    if (!ref || typeof ref !== 'object' || !context) return null;
    let kind = String(ref.kind || '');
    if (kind === 'unit') {
        return context.unitsById.get(Math.floor(Number(ref.id) || 0)) || null;
    }
    if (kind === 'tower' || kind === 'barrack' || kind === 'spawner') {
        // Indexed once per restore: thousands of unit references otherwise
        // scan every building each.
        let key = (e, typeField) => Math.floor(Number(e.owner) || 0) + '|' + Math.floor(Number(e.gx) || 0) + '|' + Math.floor(Number(e.gy) || 0) + '|' + String(e[typeField] || '');
        if (!context.buildingIndex) {
            let index = new Map();
            let add = (list, prefix, typeField) => {
                for (let e of (list || [])) {
                    if (!e) continue;
                    let k = prefix + key(e, typeField);
                    if (!index.has(k)) index.set(k, e);
                }
            };
            add(context.towers, 'tower|', 'type');
            add(context.barracks, 'barrack|', 'unitType');
            add(context.spawners, 'spawner|', 'type');
            context.buildingIndex = index;
        }
        let typeField = kind === 'barrack' ? 'unitType' : 'type';
        return context.buildingIndex.get(kind + '|' + key(ref, typeField)) || null;
    }
    if (kind === 'mine') {
        let gx = Math.floor(Number(ref.gx) || 0);
        let gy = Math.floor(Number(ref.gy) || 0);
        if (!context.goldMinesByTile) {
            let byTile = new Map();
            for (let mine of (context.goldMines || [])) {
                if (!mine) continue;
                let mx = Math.floor(Number(mine.gx) || 0);
                let my = Math.floor(Number(mine.gy) || 0);
                byTile.set(mx + ',' + my, mine);
            }
            context.goldMinesByTile = byTile;
        }
        return context.goldMinesByTile.get(gx + ',' + gy) || null;
    }
    if (kind === 'astarMine') {
        let gx = Math.floor(Number(ref.gx) || 0);
        let gy = Math.floor(Number(ref.gy) || 0);
        if (!context.astarMinesByTile) {
            let byTile = new Map();
            for (let mine of (context.astarMines || [])) {
                if (!mine) continue;
                let mx = Math.floor(Number(mine.gx) || 0);
                let my = Math.floor(Number(mine.gy) || 0);
                byTile.set(mx + ',' + my, mine);
            }
            context.astarMinesByTile = byTile;
        }
        return context.astarMinesByTile.get(gx + ',' + gy) || null;
    }
    if (kind === 'gridItem') {
        let gx = Math.floor(Number(ref.gx) || 0);
        let gy = Math.floor(Number(ref.gy) || 0);
        if (gx < 0 || gx >= GRID_W || gy < 0 || gy >= GRID_H) return null;
        let cell = grid[gy] && grid[gy][gx];
        let item = cell ? cell.item : null;
        if (!item) return null;
        if (Math.floor(Number(cell.owner) || 0) !== Math.floor(Number(ref.owner) || 0)) return null;
        if (String(item.type || '') !== String(ref.type || '')) return null;
        return item;
    }
    return null;
}

function _serializeUiSelectionGroupState(group) {
    if (!group || typeof group !== 'object') return null;
    return {
        unitRefs: Array.isArray(group.units) ? group.units.map(makeSnapshotEntityRef).filter(Boolean) : [],
        entityRefs: Array.isArray(group.entities) ? group.entities.map(makeSnapshotEntityRef).filter(Boolean) : [],
        activeSubGroups: { ...(group.activeSubGroups || {}) }
    };
}

function _restoreUiSelectionGroupState(groupSnapshot, context) {
    if (!groupSnapshot || !context) return null;
    let unitsRestored = Array.isArray(groupSnapshot.unitRefs)
        ? groupSnapshot.unitRefs.map(ref => resolveSnapshotEntityRef(ref, context)).filter(u => u && !u.dead)
        : [];
    let entitiesRestored = Array.isArray(groupSnapshot.entityRefs)
        ? groupSnapshot.entityRefs.map(ref => resolveSnapshotEntityRef(ref, context)).filter(e => e && !(e.energy !== undefined && e.energy <= 0))
        : [];
    if (unitsRestored.length <= 0 && entitiesRestored.length <= 0) return null;
    return {
        units: unitsRestored,
        entities: entitiesRestored,
        activeSubGroups: { ...(groupSnapshot.activeSubGroups || {}) }
    };
}

function _captureSnapshotApplyUiState() {
    let popupEl = document.getElementById('research-popup');
    let popupWasOpen = !!(popupEl && !popupEl.classList.contains('hidden'));
    let controlGroupSnapshots = {};
    for (let key in controlGroups) {
        if (!Object.prototype.hasOwnProperty.call(controlGroups, key)) continue;
        let snap = _serializeUiSelectionGroupState(controlGroups[key]);
        if (snap) controlGroupSnapshots[key] = snap;
    }
    let popupGroupSnapshots = {};
    for (let key in popupControlGroups) {
        if (!Object.prototype.hasOwnProperty.call(popupControlGroups, key)) continue;
        let snap = _serializeUiSelectionGroupState(popupControlGroups[key]);
        if (snap) popupGroupSnapshots[key] = snap;
    }
    return {
        selection: _serializeUiSelectionGroupState({ units: selectedUnits, entities: selectedEntities, activeSubGroups }),
        controlGroups: controlGroupSnapshots,
        popupControlGroups: popupGroupSnapshots,
        activePopupControlGroupKey: String(activePopupControlGroupKey || ''),
        popupWasOpen,
        selectedBuildItem,
        attackMoveMode: !!attackMoveMode
    };
}

function _restoreSnapshotApplyUiState(state, context) {
    if (!state || !context) return;
    let restoredSelection = _restoreUiSelectionGroupState(state.selection, context);
    selectedUnits = restoredSelection ? restoredSelection.units : [];
    selectedEntities = restoredSelection ? restoredSelection.entities : [];
    activeSubGroups = restoredSelection ? { ...(restoredSelection.activeSubGroups || {}) } : {};

    let nextControlGroups = {};
    for (let key in (state.controlGroups || {})) {
        if (!Object.prototype.hasOwnProperty.call(state.controlGroups, key)) continue;
        let restoredGroup = _restoreUiSelectionGroupState(state.controlGroups[key], context);
        if (restoredGroup) nextControlGroups[key] = restoredGroup;
    }
    controlGroups = nextControlGroups;

    let nextPopupControlGroups = {};
    for (let key in (state.popupControlGroups || {})) {
        if (!Object.prototype.hasOwnProperty.call(state.popupControlGroups, key)) continue;
        let restoredGroup = _restoreUiSelectionGroupState(state.popupControlGroups[key], context);
        if (restoredGroup) nextPopupControlGroups[key] = restoredGroup;
    }
    popupControlGroups = nextPopupControlGroups;
    activePopupControlGroupKey = nextPopupControlGroups[state.activePopupControlGroupKey] ? state.activePopupControlGroupKey : '';
    selectedBuildItem = state.selectedBuildItem || null;
    attackMoveMode = !!state.attackMoveMode;

    if (typeof updateControlGroupBar === 'function') updateControlGroupBar();
    if (state.popupWasOpen && activePopupControlGroupKey && typeof setResearchPopupOpen === 'function') {
        setResearchPopupOpen(true);
    }
}

function buildRuntimeConfigHashForSnapshot() {
    let cfg = {
        gridW: GRID_W,
        gridH: GRID_H,
        // Input delay is per-peer scheduling and does not affect the state.
        tickRate: TICK_RATE,
        exactLockstep: !!lockstepStrictDebugMode,
        gameMode: gameMode,
        maxPop: CONFIG_MAX_POP,
        maxThingLevel: MAX_THING_LEVEL,
        maxResearchLevel: MAX_RESEARCH_LEVEL,
        mapType: MAP_TYPE,
        fullVisibility: !!matchFullVisibility,
        startingMoney: STARTING_MONEY,
        startingAstar: STARTING_ASTAR,
        startingResources: cloneSnapshotValue(startingResourcesConfig || {}),
        editableConfig: serializeEditableRuntimeConfigForTransport()
    };
    return hashStringLockstep(stableSerializeForLockstep(cfg));
}

// Derived stat tables are rebuilt from level and research on restore, so
// snapshots leave them out (they were most of a snapshot's size).
const SNAPSHOT_DERIVED_STAT_KEYS = ['preComputed', 'preComputedEffective', 'preComputedBase', 'basePreComputed', 'preComputedPotential', 'currentStats', 'baseStats'];
const SNAPSHOT_BUILDING_OMIT_KEYS = ['textCtx', 'textCanvas', '_textCanvasScale', ...SNAPSHOT_DERIVED_STAT_KEYS];

// Drop entries restore treats as absent anyway (null, undefined, false, -1
// for indices), so mostly-empty runtime records stay small.
function compactSnapshotRecord(obj) {
    let out = {};
    for (let k of Object.keys(obj)) {
        let v = obj[k];
        if (v === null || v === undefined || v === false) continue;
        out[k] = v;
    }
    return out;
}

function buildHostAuthoritativeStateSnapshot(options = null) {
    let opts = (options && typeof options === 'object') ? options : {};
    let includeConfig = opts.includeConfig !== false;
    let includeStaticMapState = opts.includeStaticMapState !== false;
    let includeGridTypes = opts.includeGridTypes !== false;
    // Every tick the host already sealed, or holds packets for, travels along.
    let lockstepWindowStartTick = Math.max(0, Math.floor(Number(currentTick) || 0));
    let lockstepWindowEndTick = Number.MAX_SAFE_INTEGER;

    let serializeTickPacketForSnapshot = (packet) => {
        if (!packet || typeof packet !== 'object') return null;
        let tick = Math.floor(Number(packet.tick));
        let peerId = String(packet.peerId || '');
        if (!Number.isFinite(tick) || tick < 0 || !peerId) return null;
        return {
            tick,
            peerId,
            teamId: Math.floor(Number(packet.teamId) || 0),
            actions: Array.isArray(packet.actions) ? packet.actions.map(a => cloneSnapshotValue(a)) : [],
            stateHashTick: Math.floor(Number(packet.stateHashTick) || -1),
            stateHash: String(packet.stateHash || ''),
            stateDigest: packet.stateDigest && typeof packet.stateDigest === 'object' ? cloneSnapshotValue(packet.stateDigest) : null,
            checksum: String(packet.checksum || '')
        };
    };

    let serializeTickBundleForSnapshot = (bundle) => {
        if (!bundle || typeof bundle !== 'object') return null;
        let tick = Math.floor(Number(bundle.tick));
        if (!Number.isFinite(tick) || tick < 0) return null;
        return {
            tick,
            packets: Array.isArray(bundle.packets) ? bundle.packets.map(serializeTickPacketForSnapshot).filter(Boolean) : [],
            combinedChecksum: String(bundle.combinedChecksum || '')
        };
    };

    let floorItems = [];
    for (let gy = 0; gy < GRID_H; gy++) {
        for (let gx = 0; gx < GRID_W; gx++) {
            let cell = grid[gy][gx];
            if (!cell || !cell.item) continue;
            if (cell.item instanceof Tower || cell.item instanceof Barrack || isSpawnerEntity(cell.item)) continue;
            let item = snapshotEntity(cell.item, ['lockedBy', ...SNAPSHOT_BUILDING_OMIT_KEYS]);
            if (!item) continue;
            floorItems.push({ gx, gy, owner: Math.floor(Number(cell.owner) || 0), item });
        }
    }

    let gridTypes = null;
    if (includeGridTypes) {
        gridTypes = [];
        for (let gy = 0; gy < GRID_H; gy++) {
            let row = [];
            for (let gx = 0; gx < GRID_W; gx++) {
                let cell = grid[gy] && grid[gy][gx];
                row.push(Math.floor(Number(cell && cell.type) || TYPE_FLOOR));
            }
            gridTypes.push(row);
        }
    }

    let snapshot = {
        currentTick,
        gameTime,
        nextUnitId,
        gameOver: !!gameOver,
        localDefeated: !!localDefeated,
        spectateMode: String(spectateMode || 'none'),
        configHash: buildRuntimeConfigHashForSnapshot(),
        pendingPathResolveCursor: Math.max(0, Math.floor(Number(pendingPathResolveCursor) || 0)),
        // Mutable area state (activation, upgrade level); the areas themselves
        // come from map generation unless includeStaticMapState is set.
        areaState: (areas || []).map(ar => ar ? [Math.floor(Number(ar.id) || 0), ar.active ? 1 : 0, Math.floor(Number(ar.multiplierLevel) || 0)] : null),
        globalSpawnerReadyOrderCounter: typeof globalSpawnerReadyOrderCounter !== 'undefined' ? Math.floor(Number(globalSpawnerReadyOrderCounter) || 1) : 1,
        players: cloneSnapshotValue(players),
        // Serialize the fixed-point resource accumulators explicitly so the guest doesn't
        // re-derive them from floating-point player.energy/astar values on restore.
        playerResourceFixedValues: players.map(p => {
            let fv = p && p._resourceFixedValues;
            if (!fv || typeof fv !== 'object') return null;
            let out = {};
            for (let k of Object.keys(fv)) {
                let v = Math.floor(Number(fv[k]) || 0);
                if (Number.isFinite(v)) out[k] = v;
            }
            return out;
        }),
        towers: towers.map(t => snapshotEntity(t, ['connectedLasers', 'preferredTarget', ...SNAPSHOT_BUILDING_OMIT_KEYS])).filter(Boolean),
        barracks: barracks.map(b => {
            let snap = snapshotEntity(b, SNAPSHOT_BUILDING_OMIT_KEYS);
            if (snap) snap._spawnReadyOrder = (b._spawnReadyOrder !== null && b._spawnReadyOrder !== undefined && Number.isFinite(Number(b._spawnReadyOrder))) ? Math.floor(Number(b._spawnReadyOrder)) : null;
            return snap;
        }).filter(Boolean),
        spawners: collectorSpawners.map(s => {
            let snap = snapshotEntity(s, SNAPSHOT_BUILDING_OMIT_KEYS);
            if (snap) snap._spawnReadyOrder = (s._spawnReadyOrder !== null && s._spawnReadyOrder !== undefined && Number.isFinite(Number(s._spawnReadyOrder))) ? Math.floor(Number(s._spawnReadyOrder)) : null;
            return snap;
        }).filter(Boolean),
        units: units.map(u => {
            let snap = snapshotEntity(u, [
                'targetUnit', 'targetBuilding', 'attackTarget', 'workerTarget',
                '_collectorPinnedTarget', '_collectorNextSpawner', '_collectorLastDropoffSpawner', '_lastMineTarget',
                '_astarPinnedTarget', '_astarNextSpawner', '_astarLastMineTarget',
                '_healerPinnedQueueTarget', '_healerQueueCommitTarget', '_builderSpawnerTarget', '_healerSpawnerTarget', '_researchSpawnerTarget',
                '_spatialKey', 'prevX', 'prevY', ...SNAPSHOT_DERIVED_STAT_KEYS
            ]);
            if (!snap) return null;
            snap.snapshotRefs = compactSnapshotRecord({
                targetUnit: makeSnapshotEntityRef(u.targetUnit),
                targetBuilding: makeSnapshotEntityRef(u.targetBuilding),
                attackTarget: makeSnapshotEntityRef(u.attackTarget),
                workerTarget: makeSnapshotEntityRef(u.workerTarget),
                workerTargetType: u.workerTargetType !== undefined ? cloneSnapshotValue(u.workerTargetType) : null,
                _collectorPinnedTarget: makeSnapshotEntityRef(u._collectorPinnedTarget),
                _collectorNextSpawner: makeSnapshotEntityRef(u._collectorNextSpawner),
                _collectorLastDropoffSpawner: makeSnapshotEntityRef(u._collectorLastDropoffSpawner),
                _lastMineTarget: makeSnapshotEntityRef(u._lastMineTarget),
                _astarPinnedTarget: makeSnapshotEntityRef(u._astarPinnedTarget),
                _astarNextSpawner: makeSnapshotEntityRef(u._astarNextSpawner),
                _astarLastMineTarget: makeSnapshotEntityRef(u._astarLastMineTarget),
                _healerPinnedQueueTarget: makeSnapshotEntityRef(u._healerPinnedQueueTarget),
                _healerQueueCommitTarget: makeSnapshotEntityRef(u._healerQueueCommitTarget),
                _builderSpawnerTarget: makeSnapshotEntityRef(u._builderSpawnerTarget),
                _healerSpawnerTarget: makeSnapshotEntityRef(u._healerSpawnerTarget),
                _researchSpawnerTarget: makeSnapshotEntityRef(u._researchSpawnerTarget)
            });
            snap.snapshotRuntime = compactSnapshotRecord({
                pendingPathTarget: cloneSnapshotValue(u._pendingPathTarget),
                targetPos: cloneSnapshotValue(u.targetPos),
                path: u.path && u.path.length > 0 ? u.path.map(n => ({ x: Math.floor(Number(n.x)||0), y: Math.floor(Number(n.y)||0) })) : null,
                pathIndex: Number.isFinite(u.pathIndex) ? Math.floor(u.pathIndex) : 0,
                pathIsFallbackAstar: !!u.pathIsFallbackAstar,
                manualMoveIssuedTick: (u._manualMoveIssuedTick !== null && u._manualMoveIssuedTick !== undefined) ? Math.floor(Number(u._manualMoveIssuedTick)) : null,
                collectorPinnedTargetType: u._collectorPinnedTargetType !== undefined ? cloneSnapshotValue(u._collectorPinnedTargetType) : null,
                astarPinnedTargetType: u._astarPinnedTargetType !== undefined ? cloneSnapshotValue(u._astarPinnedTargetType) : null,
                astarLastMineTargetType: u._astarLastMineTargetType !== undefined ? cloneSnapshotValue(u._astarLastMineTargetType) : null,
                collectorLastGatherType: u._collectorLastGatherType !== undefined ? cloneSnapshotValue(u._collectorLastGatherType) : null,
                healerQueueTripCost: (u._healerQueueTripCost !== null && u._healerQueueTripCost !== undefined) ? Number(u._healerQueueTripCost) : null,
                healerLastWorkX: (u._healerLastWorkX !== null && u._healerLastWorkX !== undefined) ? Number(u._healerLastWorkX) : null,
                healerLastWorkY: (u._healerLastWorkY !== null && u._healerLastWorkY !== undefined) ? Number(u._healerLastWorkY) : null,
                healerLastWorkGx: (u._healerLastWorkGx !== null && u._healerLastWorkGx !== undefined) ? Math.floor(Number(u._healerLastWorkGx)) : null,
                healerLastWorkGy: (u._healerLastWorkGy !== null && u._healerLastWorkGy !== undefined) ? Math.floor(Number(u._healerLastWorkGy)) : null,
                healerQueueCommitRequired: (u._healerQueueCommitRequired !== null && u._healerQueueCommitRequired !== undefined) ? Math.floor(Number(u._healerQueueCommitRequired)) : null,
                healerQueueCommitMaxPaid: (u._healerQueueCommitMaxPaid !== null && u._healerQueueCommitMaxPaid !== undefined) ? Math.floor(Number(u._healerQueueCommitMaxPaid)) : null,
                astarLastGatherX: (u._astarLastGatherX !== null && u._astarLastGatherX !== undefined) ? Number(u._astarLastGatherX) : null,
                astarLastGatherY: (u._astarLastGatherY !== null && u._astarLastGatherY !== undefined) ? Number(u._astarLastGatherY) : null,
                astarLastGatherGx: (u._astarLastGatherGx !== null && u._astarLastGatherGx !== undefined) ? Math.floor(Number(u._astarLastGatherGx)) : null,
                astarLastGatherGy: (u._astarLastGatherGy !== null && u._astarLastGatherGy !== undefined) ? Math.floor(Number(u._astarLastGatherGy)) : null,
                collectorLastGatherX: (u._collectorLastGatherX !== null && u._collectorLastGatherX !== undefined) ? Number(u._collectorLastGatherX) : null,
                collectorLastGatherY: (u._collectorLastGatherY !== null && u._collectorLastGatherY !== undefined) ? Number(u._collectorLastGatherY) : null,
                collectorLastGatherGx: (u._collectorLastGatherGx !== null && u._collectorLastGatherGx !== undefined) ? Math.floor(Number(u._collectorLastGatherGx)) : null,
                collectorLastGatherGy: (u._collectorLastGatherGy !== null && u._collectorLastGatherGy !== undefined) ? Math.floor(Number(u._collectorLastGatherGy)) : null,
                
                builderLastWorkX: (u._builderLastWorkX !== null && u._builderLastWorkX !== undefined) ? Number(u._builderLastWorkX) : null,
                builderLastWorkY: (u._builderLastWorkY !== null && u._builderLastWorkY !== undefined) ? Number(u._builderLastWorkY) : null,
                builderLastWorkGx: (u._builderLastWorkGx !== null && u._builderLastWorkGx !== undefined) ? Math.floor(Number(u._builderLastWorkGx)) : null,
                builderLastWorkGy: (u._builderLastWorkGy !== null && u._builderLastWorkGy !== undefined) ? Math.floor(Number(u._builderLastWorkGy)) : null,
                
                builderLastMoveTick: (u._builderLastMoveTick !== null && u._builderLastMoveTick !== undefined) ? Math.floor(Number(u._builderLastMoveTick)) : null,
                builderNextRecheckTick: (u._builderNextRecheckTick !== null && u._builderNextRecheckTick !== undefined) ? Math.floor(Number(u._builderNextRecheckTick)) : null,
                collectorLastMoveTick: (u._collectorLastMoveTick !== null && u._collectorLastMoveTick !== undefined) ? Math.floor(Number(u._collectorLastMoveTick)) : null,
                collectorNextRecheckTick: (u._collectorNextRecheckTick !== null && u._collectorNextRecheckTick !== undefined) ? Math.floor(Number(u._collectorNextRecheckTick)) : null,
                healerLastMoveTick: (u._healerLastMoveTick !== null && u._healerLastMoveTick !== undefined) ? Math.floor(Number(u._healerLastMoveTick)) : null,
                healerNextRecheckTick: (u._healerNextRecheckTick !== null && u._healerNextRecheckTick !== undefined) ? Math.floor(Number(u._healerNextRecheckTick)) : null,
                researchLastMoveTick: (u._researchLastMoveTick !== null && u._researchLastMoveTick !== undefined) ? Math.floor(Number(u._researchLastMoveTick)) : null,
                researchNextRecheckTick: (u._researchNextRecheckTick !== null && u._researchNextRecheckTick !== undefined) ? Math.floor(Number(u._researchNextRecheckTick)) : null,
                astarLastChargedTick: (u._astarLastChargedTick !== null && u._astarLastChargedTick !== undefined) ? Math.floor(Number(u._astarLastChargedTick)) : null,
                astarLastChargedFromKey: (u._astarLastChargedFromKey !== null && u._astarLastChargedFromKey !== undefined) ? Math.floor(Number(u._astarLastChargedFromKey)) : null,
                astarLastChargedToKey: (u._astarLastChargedToKey !== null && u._astarLastChargedToKey !== undefined) ? Math.floor(Number(u._astarLastChargedToKey)) : null,
                energyBlockedUntil: (u._energyBlockedUntil !== null && u._energyBlockedUntil !== undefined) ? Math.floor(Number(u._energyBlockedUntil)) : null,
                workerNextIdleRetargetTick: (u._workerNextIdleRetargetTick !== null && u._workerNextIdleRetargetTick !== undefined) ? Math.floor(Number(u._workerNextIdleRetargetTick)) : null,
                workerReservedTileIndex: (u._workerReservedTileIndex !== null && u._workerReservedTileIndex !== undefined) ? Math.floor(Number(u._workerReservedTileIndex)) : -1,
                workerLastPathX: (u._workerLastPathX !== null && u._workerLastPathX !== undefined) ? Number(u._workerLastPathX) : null,
                workerLastPathY: (u._workerLastPathY !== null && u._workerLastPathY !== undefined) ? Number(u._workerLastPathY) : null,
                workerLastPathKey: (u._workerLastPathKey !== null && u._workerLastPathKey !== undefined) ? String(u._workerLastPathKey) : null,
                workerLastPathTick: (u._workerLastPathTick !== null && u._workerLastPathTick !== undefined) ? Math.floor(Number(u._workerLastPathTick)) : null,
                workerPathStallTicks: (u._workerPathStallTicks !== null && u._workerPathStallTicks !== undefined) ? Math.floor(Number(u._workerPathStallTicks)) : 0,
                lastIdleStateTime: (u._lastIdleStateTime !== null && u._lastIdleStateTime !== undefined) ? Math.floor(Number(u._lastIdleStateTime)) : null,
                forcedTargetLastSeenX: (u._forcedTargetLastSeenX !== null && u._forcedTargetLastSeenX !== undefined) ? Number(u._forcedTargetLastSeenX) : null,
                forcedTargetLastSeenY: (u._forcedTargetLastSeenY !== null && u._forcedTargetLastSeenY !== undefined) ? Number(u._forcedTargetLastSeenY) : null,
                builderLastWatchX: (u._builderLastWatchX !== null && u._builderLastWatchX !== undefined) ? Number(u._builderLastWatchX) : null,
                builderLastWatchY: (u._builderLastWatchY !== null && u._builderLastWatchY !== undefined) ? Number(u._builderLastWatchY) : null,
                researcherTripWork: (u._researcherTripWork !== null && u._researcherTripWork !== undefined) ? Math.floor(Number(u._researcherTripWork)) : 0,
                researcherTripCost: (u._researcherTripCost !== null && u._researcherTripCost !== undefined) ? Math.floor(Number(u._researcherTripCost)) : 0,
                researcherMaterialReadyTick: (u._researcherMaterialReadyTick !== null && u._researcherMaterialReadyTick !== undefined) ? Math.floor(Number(u._researcherMaterialReadyTick)) : 0,
                scoutTarget: u._scoutTarget ? { gx: Math.floor(Number(u._scoutTarget.gx)||0), gy: Math.floor(Number(u._scoutTarget.gy)||0) } : null,
                nextScoutRetargetTick: (u._nextScoutRetargetTick !== null && u._nextScoutRetargetTick !== undefined) ? Math.floor(Number(u._nextScoutRetargetTick)) : null,
                workerTransferCooldown: (u.workerTransferCooldown !== null && u.workerTransferCooldown !== undefined) ? Math.floor(Number(u.workerTransferCooldown)) : 0,
                healerHasMaterial: !!u.healerHasMaterial,
                builderHasMaterial: !!u.builderHasMaterial,
                researcherHasMaterial: !!u.researcherHasMaterial,
                astarBudgetBlockedUntil: (u._astarBudgetBlockedUntil !== null && u._astarBudgetBlockedUntil !== undefined) ? Math.floor(Number(u._astarBudgetBlockedUntil)) : null,
                astarBudgetRetryTick: (u._astarBudgetRetryTick !== null && u._astarBudgetRetryTick !== undefined) ? Math.floor(Number(u._astarBudgetRetryTick)) : null
            });
            return snap;
        }).filter(Boolean),
        // These projectiles apply damage; unlike particles, they are gameplay.
        projectiles: projectiles.map(p => snapshotEntity(p, ['prevX', 'prevY'])),
        goldMines: cloneSnapshotValue(goldMines),
        astarMines: cloneSnapshotValue(astarMines),
        droppedItems: cloneSnapshotValue(droppedItems),
        floorItems,
        resignedTeams: Array.from(resignedTeams || []).map(v => Math.floor(Number(v) || 0)).sort((a, b) => a - b),
        rngState: (rng && typeof rng.getState === 'function') ? rng.getState() : null,
        pathfindBudgetByPlayer: pathfindBudgetByPlayer && pathfindBudgetByPlayer.length > 0 ? Array.from(pathfindBudgetByPlayer).map(v => Math.max(0, Math.floor(Number(v) || 0))) : [],
        astarNodeBudgetRemainingByPlayer: astarNodeBudgetRemainingByPlayer && astarNodeBudgetRemainingByPlayer.length > 0 ? Array.from(astarNodeBudgetRemainingByPlayer).map(v => Math.max(0, Math.floor(Number(v) || 0))) : [],
        lockstepWindowPackets: Object.keys(lockstepHostPacketsByTick || {})
            .map(k => Math.floor(Number(k)))
            .filter(t => Number.isFinite(t) && t >= lockstepWindowStartTick && t <= lockstepWindowEndTick)
            .sort((a, b) => a - b)
            .map(t => ({
                tick: t,
                packets: Object.values(lockstepHostPacketsByTick[t] || {}).map(serializeTickPacketForSnapshot).filter(Boolean)
            })),
        lockstepWindowBundles: Object.keys(lockstepBundleByTick || {})
            .map(k => Math.floor(Number(k)))
            .filter(t => Number.isFinite(t) && t >= lockstepWindowStartTick && t <= lockstepWindowEndTick)
            .sort((a, b) => a - b)
            .map(t => serializeTickBundleForSnapshot(lockstepBundleByTick[t]))
            .filter(Boolean),
        lockstepWindowCommittedTicks: Object.keys(lockstepCommittedByTick || {})
            .map(k => Math.floor(Number(k)))
            .filter(t => Number.isFinite(t) && t >= lockstepWindowStartTick && t <= lockstepWindowEndTick && !!lockstepCommittedByTick[t])
            .sort((a, b) => a - b)
    };

    if (gridTypes) {
        snapshot.gridTypes = gridTypes;
    }

    if (includeConfig) {
        snapshot.editableConfig = serializeEditableRuntimeConfigForTransport();
    }
    if (includeStaticMapState) {
        snapshot.areas = cloneSnapshotValue(areas);
    }
    return snapshot;
}

function applyAuthoritativeStateSnapshot(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') return false;
    let now = performance.now();
    let uiStateBeforeApply = _captureSnapshotApplyUiState();

    // Commands this peer queued for ticks at or after the snapshot have not
    // run yet anywhere; keep them (and the packets carrying them).
    let snapTickPreview = Math.max(0, Math.floor(Number(snapshot.currentTick) || 0));
    let preservedInput = {};
    for (let k of Object.keys(localInputBuffer || {})) if (Number(k) >= snapTickPreview) preservedInput[k] = localInputBuffer[k];
    let preservedLocalPackets = {};
    for (let k of Object.keys(lockstepLocalPacketByTick || {})) if (Number(k) >= snapTickPreview) preservedLocalPackets[k] = lockstepLocalPacketByTick[k];
    let preservedHostPackets = {};
    if (isHost) {
        for (let k of Object.keys(lockstepHostPacketsByTick || {})) if (Number(k) >= snapTickPreview) preservedHostPackets[k] = { ...lockstepHostPacketsByTick[k] };
    }
    let preservedHighestSent = Math.floor(Number(lockstepHighestSentLocalTick));
    let wasLocalDefeated = !!localDefeated;
    let prevSpectateMode = String(spectateMode || 'none');

    let incomingConfigHash = String((snapshot && snapshot.configHash) || '');
    let localConfigHash = buildRuntimeConfigHashForSnapshot();
    let shouldApplyConfig = !!(snapshot.editableConfig && typeof snapshot.editableConfig === 'object');
    if (!shouldApplyConfig && incomingConfigHash && localConfigHash && incomingConfigHash !== localConfigHash) {
        // Host and guest config hashes differ; request explicit config payload in a follow-up snapshot.
        let hostConn = !isHost ? netGetHostConnection() : null;
        if (hostConn) {
            logLockstepWarning('Config hash differs from host; requesting config', { incomingConfigHash, localConfigHash });
            try { hostConn.send({ type: 'REQUEST_MATCH_SYNC', tick: currentTick, reason: 'config hash mismatch' }); } catch { }
        }
    }

    if (shouldApplyConfig) {
        try {
            applyEditableRuntimeConfigObject(snapshot.editableConfig, { fromTransport: true });
        } catch { }
        matchFullVisibility = !!fullVisibility;
        // A spectator keeps seeing everything.
        if (wasLocalDefeated || prevSpectateMode !== 'none') fullVisibility = true;
    }

    waitingForRemoteSince = 0;
    lockstepLastHardResyncRequestAt = now;
    lockstepHardResyncInFlightUntil = 0;
    let postSnapshotGraceMs = Math.max(
        Math.floor(Number(getLockstepPostSnapshotGraceMs()) || 0),
        Math.floor(Number(LOCKSTEP_HARD_RESYNC_MS) || 0) * 3
    );
    lockstepPostSnapshotGraceUntilAt = now + postSnapshotGraceMs;
    lockstepResyncSnapshotCache = null;
    lockstepDesyncDetected = false;
    lockstepExpectedStateHashByTick = {};
    lockstepLocalStateHashByTick = {};
    lockstepExpectedStateDigestByTick = {};
    lockstepLocalStateDigestByTick = {};

    towers = [];
    barracks = [];
    collectorSpawners = [];
    units = [];
    // Before any entity is restored: nothing from the old world may steer it.
    resetSimulationTickCaches();
    projectiles = (Array.isArray(snapshot.projectiles) ? snapshot.projectiles : []).map(state => {
        const p = Object.assign(Object.create(Projectile.prototype), cloneSnapshotValue(state));
        p.prevX = p.x; p.prevY = p.y;
        return p;
    });
    // Particles are local visual effects and can finish naturally after resync.
    droppedItems = [];
    droppedItemGrid = [];

    let snapshotGridTypes = Array.isArray(snapshot.gridTypes) ? snapshot.gridTypes : null;
    for (let gy = 0; gy < GRID_H; gy++) {
        for (let gx = 0; gx < GRID_W; gx++) {
            if (!grid[gy] || !grid[gy][gx]) continue;
            if (snapshotGridTypes && Array.isArray(snapshotGridTypes[gy])) {
                let snapType = Math.floor(Number(snapshotGridTypes[gy][gx]));
                if (Number.isFinite(snapType)) grid[gy][gx].type = snapType;
            }
            grid[gy][gx].item = null;
            grid[gy][gx].owner = -1;
            grid[gy][gx].droppedItem = null;
        }
    }
    initDroppedItemGrid();
    initTileEntityLookup();

    players = Array.isArray(snapshot.players) ? cloneSnapshotValue(snapshot.players) : players;
    // Restore the exact fixed-point resource counters so p.energy/p.astar are
    // re-derived from integers instead of being re-initialised from floats.
    if (Array.isArray(snapshot.playerResourceFixedValues)) {
        for (let i = 0; i < snapshot.playerResourceFixedValues.length; i++) {
            let fv = snapshot.playerResourceFixedValues[i];
            if (!fv || typeof fv !== 'object' || !players[i]) continue;
            players[i]._resourceFixedValues = {};
            for (let k of Object.keys(fv)) {
                let v = Math.floor(Number(fv[k]) || 0);
                if (Number.isFinite(v)) players[i]._resourceFixedValues[k] = v;
            }
        }
    }
    currentTick = Math.max(0, Math.floor(Number(snapshot.currentTick) || 0));
    // Host and guests restore from the same text, so hashes must agree from
    // the snapshot tick on.
    lockstepHashGraceUntilTick = currentTick - 1;
    gameTime = Math.max(0, Math.floor(Number(snapshot.gameTime) || currentTick));
    lockstepResyncResumeTick = currentTick;
    let snapshotNextUnitId = Math.max(1, Math.floor(Number(snapshot.nextUnitId) || 1));
    nextUnitId = snapshotNextUnitId;
    gameOver = !!snapshot.gameOver;
    // Defeat and spectating are per-client; the snapshot carries the host's.
    localDefeated = wasLocalDefeated;
    spectateMode = prevSpectateMode;
    pendingPathResolveCursor = Math.max(0, Math.floor(Number(snapshot.pendingPathResolveCursor) || 0));
    // Restore the global spawn-order counter so that the guest's spawn priority is identical to the host's.
    if (Number.isFinite(Number(snapshot.globalSpawnerReadyOrderCounter))) {
        try { globalSpawnerReadyOrderCounter = Math.max(1, Math.floor(Number(snapshot.globalSpawnerReadyOrderCounter))); } catch {}
    }
    let snapshotGoldMines = Array.isArray(snapshot.goldMines) ? cloneSnapshotValue(snapshot.goldMines) : goldMines;
    let snapshotAstarMines = Array.isArray(snapshot.astarMines) ? cloneSnapshotValue(snapshot.astarMines) : astarMines;

    let towerSnapshots = Array.isArray(snapshot.towers) ? snapshot.towers : [];
    for (let ts of towerSnapshots) {
        if (!ts || !Number.isFinite(ts.gx) || !Number.isFinite(ts.gy)) continue;
        let t = new Tower(Math.floor(ts.gx), Math.floor(ts.gy), String(ts.type || 'pistol'), Math.floor(Number(ts.owner) || 0), Math.max(1, Math.floor(Number(ts.stacks) || 1)));
        Object.assign(t, cloneSnapshotValue(ts));
        t.baseStats = BASE_CARD_TYPES[t.type] || BASE_CARD_TYPES.pistol;
        t.currentStats = { ...t.baseStats };
        t.connectedLasers = [];
        t.textCtx = ensureLevelTextCanvas(t);
        t.updateStats();
        // Re-apply the authoritative snapshot energy/maxEnergy AFTER updateStats() so that
        // construction-in-progress values are not corrupted by the preComputed clamp.
        if (Number.isFinite(Number(ts.energy))) t.energy = Number(ts.energy);
        if (Number.isFinite(Number(ts.maxEnergy))) t.maxEnergy = Number(ts.maxEnergy);
        if (ts.underConstruction !== undefined) t.underConstruction = !!ts.underConstruction;
        if (ts.isUpgrading !== undefined) t.isUpgrading = !!ts.isUpgrading;
        if (Number.isFinite(Number(ts.upgrademaxEnergy))) t.upgrademaxEnergy = Number(ts.upgrademaxEnergy);
        restoreDerivedThingStats(t);
        towers.push(t);
        let tgx = Math.floor(Number(t.gx));
        let tgy = Math.floor(Number(t.gy));
        if (tgx >= 0 && tgx < GRID_W && tgy >= 0 && tgy < GRID_H && grid[tgy] && grid[tgy][tgx]) {
            // Wall-target towers are tracked via towers[] + tile entity lookup, not grid cell floor items.
            grid[tgy][tgx].item = null;
            grid[tgy][tgx].owner = Math.floor(Number(t.owner) || 0);
            setTileEntity(tgx, tgy, String(t.type || 'tower'), t);
        }
    }

    let barrackSnapshots = Array.isArray(snapshot.barracks) ? snapshot.barracks : [];
    for (let bs of barrackSnapshots) {
        if (!bs || !Number.isFinite(bs.gx) || !Number.isFinite(bs.gy)) continue;
        let b = new Barrack(Math.floor(bs.gx), Math.floor(bs.gy), Math.floor(Number(bs.owner) || 0), String(bs.unitType || 'norm'), Math.max(1, Math.floor(Number(bs.stacks) || 1)));
        Object.assign(b, cloneSnapshotValue(bs));
        restoreDerivedThingStats(b);
        updateItemTextCache(b);
        // Re-apply authoritative snapshot energy values after stat recalc.
        if (Number.isFinite(Number(bs.energy))) b.energy = Number(bs.energy);
        if (Number.isFinite(Number(bs.maxEnergy))) b.maxEnergy = Number(bs.maxEnergy);
        if (bs.underConstruction !== undefined) b.underConstruction = !!bs.underConstruction;
        if (bs.isUpgrading !== undefined) b.isUpgrading = !!bs.isUpgrading;
        if (Number.isFinite(Number(bs.upgrademaxEnergy))) b.upgrademaxEnergy = Number(bs.upgrademaxEnergy);
        if (Number.isFinite(Number(bs.spawnTimer))) b.spawnTimer = Math.floor(Number(bs.spawnTimer));
        if (Number.isFinite(Number(bs.spawnCooldown))) b.spawnCooldown = Math.max(1, Math.floor(Number(bs.spawnCooldown)));
        b._spawnReadyOrder = (bs._spawnReadyOrder !== null && bs._spawnReadyOrder !== undefined && Number.isFinite(Number(bs._spawnReadyOrder))) ? Math.floor(Number(bs._spawnReadyOrder)) : undefined;
        barracks.push(b);
        let bgx = Math.floor(Number(b.gx));
        let bgy = Math.floor(Number(b.gy));
        if (bgx >= 0 && bgx < GRID_W && bgy >= 0 && bgy < GRID_H && grid[bgy] && grid[bgy][bgx]) {
            grid[bgy][bgx].item = b;
            grid[bgy][bgx].owner = Math.floor(Number(b.owner) || 0);
            setTileEntity(bgx, bgy, 'barrack_' + String(b.unitType || 'norm'), b);
        }
    }

    let createSpawnerByType = (type, gx, gy, owner, stacks) => {
        if (type === 'salvager') return new SalvagerSpawner(gx, gy, owner, stacks);
        if (type === 'astar_spawner') return new AstarSpawner(gx, gy, owner, stacks);
        if (type === 'builder_spawner') return new BuilderSpawner(gx, gy, owner, stacks);
        if (type === 'healer_spawner') return new HealerSpawner(gx, gy, owner, stacks);
        if (type === 'research') return new ResearchSpawner(gx, gy, owner, stacks);
        return new CollectorSpawner(gx, gy, owner, stacks);
    };

    let spawnerSnapshots = Array.isArray(snapshot.spawners) ? snapshot.spawners : [];
    for (let ss of spawnerSnapshots) {
        if (!ss || !Number.isFinite(ss.gx) || !Number.isFinite(ss.gy)) continue;
        let type = String(ss.type || 'spawner');
        let s = createSpawnerByType(type, Math.floor(ss.gx), Math.floor(ss.gy), Math.floor(Number(ss.owner) || 0), Math.max(1, Math.floor(Number(ss.stacks) || 1)));
        Object.assign(s, cloneSnapshotValue(ss));
        restoreDerivedThingStats(s);
        updateItemTextCache(s);
        // Re-apply authoritative snapshot energy values after stat recalc.
        if (Number.isFinite(Number(ss.energy))) s.energy = Number(ss.energy);
        if (Number.isFinite(Number(ss.maxEnergy))) s.maxEnergy = Number(ss.maxEnergy);
        if (ss.underConstruction !== undefined) s.underConstruction = !!ss.underConstruction;
        if (ss.isUpgrading !== undefined) s.isUpgrading = !!ss.isUpgrading;
        if (Number.isFinite(Number(ss.upgrademaxEnergy))) s.upgrademaxEnergy = Number(ss.upgrademaxEnergy);
        if (Number.isFinite(Number(ss.spawnTimer))) s.spawnTimer = Math.floor(Number(ss.spawnTimer));
        if (Number.isFinite(Number(ss.spawnCooldown))) s.spawnCooldown = Math.max(1, Math.floor(Number(ss.spawnCooldown)));
        s._spawnReadyOrder = (ss._spawnReadyOrder !== null && ss._spawnReadyOrder !== undefined && Number.isFinite(Number(ss._spawnReadyOrder))) ? Math.floor(Number(ss._spawnReadyOrder)) : undefined;
        collectorSpawners.push(s);
        let sgx = Math.floor(Number(s.gx));
        let sgy = Math.floor(Number(s.gy));
        if (sgx >= 0 && sgx < GRID_W && sgy >= 0 && sgy < GRID_H && grid[sgy] && grid[sgy][sgx]) {
            grid[sgy][sgx].item = s;
            grid[sgy][sgx].owner = Math.floor(Number(s.owner) || 0);
            setTileEntity(sgx, sgy, String(s.type || 'spawner'), s);
        }
    }

    let unitSnapshots = Array.isArray(snapshot.units) ? snapshot.units : [];
    // References and runtime fields stay beside the unit, never on it:
    // attaching and deleting extra properties would push every unit object
    // into V8's slow dictionary mode for the rest of the match.
    let unitRestoreExtras = new Map();
    for (let us of unitSnapshots) {
        if (!us || !Number.isFinite(us.x) || !Number.isFinite(us.y)) continue;
        let u = new Unit(String(us.unitType || 'norm'), Math.floor(Number(us.owner) || 0), Number(us.x), Number(us.y));
        // Snapshot records come fresh from JSON.parse, so no copy is needed.
        for (let k in us) {
            if (k === 'snapshotRefs' || k === 'snapshotRuntime' || k === '_snapshotRefs' || k === '_snapshotRuntime') continue;
            u[k] = us[k];
        }
        let refsIn = us.snapshotRefs || us._snapshotRefs || null;
        let runtimeIn = us.snapshotRuntime || us._snapshotRuntime || null;
        if (refsIn || runtimeIn) unitRestoreExtras.set(u, { refs: refsIn || {}, runtime: runtimeIn });
        u.targetUnit = null;
        u.targetBuilding = null;
        u.attackTarget = null;
        let snapshotWorkerTargetType = u.workerTargetType;
        _clearWorkerTarget(u);
        u.workerTargetType = snapshotWorkerTargetType;
        u._collectorPinnedTarget = null;
        u._collectorNextSpawner = null;
        u._collectorLastDropoffSpawner = null;
        u._lastMineTarget = null;
        u._healerPinnedQueueTarget = null;
        u._builderSpawnerTarget = null;
        u._healerSpawnerTarget = null;
        u._researchSpawnerTarget = null;
        u._spatialKey = undefined;
        units.push(u);
    }

    let snapshotResolveContext = {
        unitsById: new Map(units.map(u => [Math.floor(Number(u.id) || 0), u])),
        towers,
        barracks,
        spawners: collectorSpawners,
        goldMines: snapshotGoldMines,
        astarMines: snapshotAstarMines
    };
    for (let u of units) {
        let extras = unitRestoreExtras.get(u);
        if (!extras) continue;
        let refs = extras.refs || {};
        let runtime = extras.runtime;
        u.targetUnit = resolveSnapshotEntityRef(refs.targetUnit, snapshotResolveContext);
        u.targetBuilding = resolveSnapshotEntityRef(refs.targetBuilding, snapshotResolveContext);
        u.attackTarget = resolveSnapshotEntityRef(refs.attackTarget, snapshotResolveContext);
        _setWorkerTarget(u, resolveSnapshotEntityRef(refs.workerTarget, snapshotResolveContext), refs.workerTargetType !== undefined ? refs.workerTargetType : (u.workerTargetType !== undefined ? u.workerTargetType : null));
        u._collectorPinnedTarget = resolveSnapshotEntityRef(refs._collectorPinnedTarget, snapshotResolveContext);
        u._collectorNextSpawner = resolveSnapshotEntityRef(refs._collectorNextSpawner, snapshotResolveContext);
        u._collectorLastDropoffSpawner = resolveSnapshotEntityRef(refs._collectorLastDropoffSpawner, snapshotResolveContext);
        u._lastMineTarget = resolveSnapshotEntityRef(refs._lastMineTarget, snapshotResolveContext);
        u._astarPinnedTarget = resolveSnapshotEntityRef(refs._astarPinnedTarget, snapshotResolveContext);
        u._astarNextSpawner = resolveSnapshotEntityRef(refs._astarNextSpawner, snapshotResolveContext);
        u._astarLastMineTarget = resolveSnapshotEntityRef(refs._astarLastMineTarget, snapshotResolveContext);
        u._healerPinnedQueueTarget = resolveSnapshotEntityRef(refs._healerPinnedQueueTarget, snapshotResolveContext);
        u._healerQueueCommitTarget = resolveSnapshotEntityRef(refs._healerQueueCommitTarget, snapshotResolveContext);
        u._builderSpawnerTarget = resolveSnapshotEntityRef(refs._builderSpawnerTarget, snapshotResolveContext);
        u._healerSpawnerTarget = resolveSnapshotEntityRef(refs._healerSpawnerTarget, snapshotResolveContext);
        u._researchSpawnerTarget = resolveSnapshotEntityRef(refs._researchSpawnerTarget, snapshotResolveContext);
        if (runtime) {
            u._pendingPathTarget = runtime.pendingPathTarget ? cloneSnapshotValue(runtime.pendingPathTarget) : null;
            u.targetPos = runtime.targetPos ? cloneSnapshotValue(runtime.targetPos) : null;
            u.path = runtime.path && runtime.path.length > 0 ? runtime.path.map(n => ({ x: Math.floor(Number(n.x)||0), y: Math.floor(Number(n.y)||0) })) : null;
            u.pathIndex = Number.isFinite(runtime.pathIndex) ? Math.floor(runtime.pathIndex) : 0;
            u.pathIsFallbackAstar = !!runtime.pathIsFallbackAstar;

            if (u.workerState === 'MANUAL_MOVE') {
                u.commandState = CMD_MOVING;
            }
            
            // Only synthesize a pending path target if no path was restored - a restored path should
            // be followed as-is; creating a _pendingPathTarget here would force an unnecessary re-path
            // on the next tick and can skip one worker action after a resync.
            if (!u._pendingPathTarget && (!u.path || u.path.length === 0)) {
                let resumeGx = null;
                let resumeGy = null;
                let resumeCmd = u.commandState;
                let resumeSrc = 'deferred_resolver';

                if (u.workerState && u.workerState !== 'IDLE') {
                    if (u.workerState === 'RETURNING_FOR_GOLD') {
                        let returnSpawner = null;
                        if (u.workerType === 'builder') returnSpawner = u._builderSpawnerTarget;
                        else if (u.workerType === 'healer') returnSpawner = u._healerSpawnerTarget;
                        else if (u.workerType === 'researcher') returnSpawner = u._researchSpawnerTarget;

                        if (returnSpawner && Number.isFinite(returnSpawner.gx) && Number.isFinite(returnSpawner.gy)) {
                            resumeGx = Math.floor(Number(returnSpawner.gx));
                            resumeGy = Math.floor(Number(returnSpawner.gy));
                            resumeCmd = CMD_MOVING;
                            resumeSrc = 'deferred_worker_state';
                        } else if (u.targetPos && Number.isFinite(u.targetPos.x) && Number.isFinite(u.targetPos.y)) {
                            resumeGx = Math.floor(Number(u.targetPos.x) / TILE);
                            resumeGy = Math.floor(Number(u.targetPos.y) / TILE);
                            resumeCmd = CMD_MOVING;
                            resumeSrc = 'deferred_worker_state';
                        }
                    }

                    if (!Number.isFinite(resumeGx) || !Number.isFinite(resumeGy)) {
                        if (u.workerTarget && Number.isFinite(u.workerTarget.gx) && Number.isFinite(u.workerTarget.gy)) {
                            resumeGx = Math.floor(Number(u.workerTarget.gx));
                            resumeGy = Math.floor(Number(u.workerTarget.gy));
                            resumeCmd = CMD_MOVING;
                            resumeSrc = 'deferred_worker_state';
                        }
                    }
                } else if ((u.commandState === CMD_MOVING || u.commandState === CMD_ATTACK_MOVING || u.workerState === 'MANUAL_MOVE') && u.targetPos && Number.isFinite(u.targetPos.x) && Number.isFinite(u.targetPos.y)) {
                    resumeGx = Math.floor(Number(u.targetPos.x) / TILE);
                    resumeGy = Math.floor(Number(u.targetPos.y) / TILE);
                    if (u.workerState === 'MANUAL_MOVE') resumeCmd = CMD_MOVING;
                } else if (u.commandState === CMD_ATTACKING) {
                    let targetRef = null;
                    if (u.targetUnit && !u.targetUnit.dead) targetRef = u.targetUnit;
                    else if (u.targetBuilding && Number(u.targetBuilding.energy) > 0) targetRef = u.targetBuilding;

                    if (targetRef && Number.isFinite(targetRef.x) && Number.isFinite(targetRef.y)) {
                        resumeGx = Math.floor(Number(targetRef.x) / TILE);
                        resumeGy = Math.floor(Number(targetRef.y) / TILE);
                    } else if (u.targetPos && Number.isFinite(u.targetPos.x) && Number.isFinite(u.targetPos.y)) {
                        resumeGx = Math.floor(Number(u.targetPos.x) / TILE);
                        resumeGy = Math.floor(Number(u.targetPos.y) / TILE);
                    }
                }
                if (Number.isFinite(resumeGx) && Number.isFinite(resumeGy)) {
                    u._pendingPathTarget = { gx: resumeGx, gy: resumeGy, cmd: resumeCmd, src: resumeSrc };
                    u.pathIsFallbackAstar = true;
                    let retryJitter = Math.max(0, Math.floor(Number(u.id) || 0) % 4);
                    u._astarBudgetRetryTick = gameTime + 1 + retryJitter;
                }
            }

            u._manualMoveIssuedTick = (runtime.manualMoveIssuedTick !== null && runtime.manualMoveIssuedTick !== undefined) ? Math.floor(Number(runtime.manualMoveIssuedTick)) : null;
            u._collectorPinnedTargetType = runtime.collectorPinnedTargetType !== undefined ? runtime.collectorPinnedTargetType : null;
            u._astarPinnedTargetType = runtime.astarPinnedTargetType !== undefined ? runtime.astarPinnedTargetType : null;
            u._astarLastMineTargetType = runtime.astarLastMineTargetType !== undefined ? runtime.astarLastMineTargetType : null;
            u._collectorLastGatherType = runtime.collectorLastGatherType !== undefined ? runtime.collectorLastGatherType : null;
            u._healerQueueTripCost = (runtime.healerQueueTripCost !== null && runtime.healerQueueTripCost !== undefined) ? Number(runtime.healerQueueTripCost) : 0;
            u._healerLastWorkX = (runtime.healerLastWorkX !== null && runtime.healerLastWorkX !== undefined) ? Number(runtime.healerLastWorkX) : null;
            u._healerLastWorkY = (runtime.healerLastWorkY !== null && runtime.healerLastWorkY !== undefined) ? Number(runtime.healerLastWorkY) : null;
            u._healerLastWorkGx = (runtime.healerLastWorkGx !== null && runtime.healerLastWorkGx !== undefined) ? Math.floor(Number(runtime.healerLastWorkGx)) : null;
            u._healerLastWorkGy = (runtime.healerLastWorkGy !== null && runtime.healerLastWorkGy !== undefined) ? Math.floor(Number(runtime.healerLastWorkGy)) : null;
            u._healerQueueCommitRequired = (runtime.healerQueueCommitRequired !== null && runtime.healerQueueCommitRequired !== undefined) ? Math.floor(Number(runtime.healerQueueCommitRequired)) : 0;
            u._healerQueueCommitMaxPaid = (runtime.healerQueueCommitMaxPaid !== null && runtime.healerQueueCommitMaxPaid !== undefined) ? Math.floor(Number(runtime.healerQueueCommitMaxPaid)) : 0;
            u._astarLastGatherX = (runtime.astarLastGatherX !== null && runtime.astarLastGatherX !== undefined) ? Number(runtime.astarLastGatherX) : null;
            u._astarLastGatherY = (runtime.astarLastGatherY !== null && runtime.astarLastGatherY !== undefined) ? Number(runtime.astarLastGatherY) : null;
            u._astarLastGatherGx = (runtime.astarLastGatherGx !== null && runtime.astarLastGatherGx !== undefined) ? Math.floor(Number(runtime.astarLastGatherGx)) : null;
            u._astarLastGatherGy = (runtime.astarLastGatherGy !== null && runtime.astarLastGatherGy !== undefined) ? Math.floor(Number(runtime.astarLastGatherGy)) : null;
            u._collectorLastGatherX = (runtime.collectorLastGatherX !== null && runtime.collectorLastGatherX !== undefined) ? Number(runtime.collectorLastGatherX) : null;
            u._collectorLastGatherY = (runtime.collectorLastGatherY !== null && runtime.collectorLastGatherY !== undefined) ? Number(runtime.collectorLastGatherY) : null;
            u._collectorLastGatherGx = (runtime.collectorLastGatherGx !== null && runtime.collectorLastGatherGx !== undefined) ? Math.floor(Number(runtime.collectorLastGatherGx)) : null;
            u._collectorLastGatherGy = (runtime.collectorLastGatherGy !== null && runtime.collectorLastGatherGy !== undefined) ? Math.floor(Number(runtime.collectorLastGatherGy)) : null;
            
            u._builderLastWorkX = (runtime.builderLastWorkX !== null && runtime.builderLastWorkX !== undefined) ? Number(runtime.builderLastWorkX) : null;
            u._builderLastWorkY = (runtime.builderLastWorkY !== null && runtime.builderLastWorkY !== undefined) ? Number(runtime.builderLastWorkY) : null;
            u._builderLastWorkGx = (runtime.builderLastWorkGx !== null && runtime.builderLastWorkGx !== undefined) ? Math.floor(Number(runtime.builderLastWorkGx)) : null;
            u._builderLastWorkGy = (runtime.builderLastWorkGy !== null && runtime.builderLastWorkGy !== undefined) ? Math.floor(Number(runtime.builderLastWorkGy)) : null;
            
            u._builderLastMoveTick = (runtime.builderLastMoveTick !== null && runtime.builderLastMoveTick !== undefined) ? Math.floor(Number(runtime.builderLastMoveTick)) : null;
            u._builderNextRecheckTick = (runtime.builderNextRecheckTick !== null && runtime.builderNextRecheckTick !== undefined) ? Math.floor(Number(runtime.builderNextRecheckTick)) : null;
            u._collectorLastMoveTick = (runtime.collectorLastMoveTick !== null && runtime.collectorLastMoveTick !== undefined) ? Math.floor(Number(runtime.collectorLastMoveTick)) : null;
            u._collectorNextRecheckTick = (runtime.collectorNextRecheckTick !== null && runtime.collectorNextRecheckTick !== undefined) ? Math.floor(Number(runtime.collectorNextRecheckTick)) : null;
            u._healerLastMoveTick = (runtime.healerLastMoveTick !== null && runtime.healerLastMoveTick !== undefined) ? Math.floor(Number(runtime.healerLastMoveTick)) : null;
            u._healerNextRecheckTick = (runtime.healerNextRecheckTick !== null && runtime.healerNextRecheckTick !== undefined) ? Math.floor(Number(runtime.healerNextRecheckTick)) : null;
            u._researchLastMoveTick = (runtime.researchLastMoveTick !== null && runtime.researchLastMoveTick !== undefined) ? Math.floor(Number(runtime.researchLastMoveTick)) : null;
            u._researchNextRecheckTick = (runtime.researchNextRecheckTick !== null && runtime.researchNextRecheckTick !== undefined) ? Math.floor(Number(runtime.researchNextRecheckTick)) : null;
            u._astarLastChargedTick = (runtime.astarLastChargedTick !== null && runtime.astarLastChargedTick !== undefined) ? Math.floor(Number(runtime.astarLastChargedTick)) : null;
            u._astarLastChargedFromKey = (runtime.astarLastChargedFromKey !== null && runtime.astarLastChargedFromKey !== undefined) ? Math.floor(Number(runtime.astarLastChargedFromKey)) : null;
            u._astarLastChargedToKey = (runtime.astarLastChargedToKey !== null && runtime.astarLastChargedToKey !== undefined) ? Math.floor(Number(runtime.astarLastChargedToKey)) : null;
            u._energyBlockedUntil = (runtime.energyBlockedUntil !== null && runtime.energyBlockedUntil !== undefined) ? Math.floor(Number(runtime.energyBlockedUntil)) : null;
            u._workerNextIdleRetargetTick = (runtime.workerNextIdleRetargetTick !== null && runtime.workerNextIdleRetargetTick !== undefined) ? Math.floor(Number(runtime.workerNextIdleRetargetTick)) : null;
            u._workerReservedTileIndex = (runtime.workerReservedTileIndex !== null && runtime.workerReservedTileIndex !== undefined) ? Math.floor(Number(runtime.workerReservedTileIndex)) : -1;
            u._workerLastPathX = (runtime.workerLastPathX !== null && runtime.workerLastPathX !== undefined) ? Number(runtime.workerLastPathX) : null;
            u._workerLastPathY = (runtime.workerLastPathY !== null && runtime.workerLastPathY !== undefined) ? Number(runtime.workerLastPathY) : null;
            u._workerLastPathKey = (runtime.workerLastPathKey !== null && runtime.workerLastPathKey !== undefined) ? String(runtime.workerLastPathKey) : null;
            u._workerLastPathTick = (runtime.workerLastPathTick !== null && runtime.workerLastPathTick !== undefined) ? Math.floor(Number(runtime.workerLastPathTick)) : null;
            u._workerPathStallTicks = (runtime.workerPathStallTicks !== null && runtime.workerPathStallTicks !== undefined) ? Math.floor(Number(runtime.workerPathStallTicks)) : 0;
            u._lastIdleStateTime = (runtime.lastIdleStateTime !== null && runtime.lastIdleStateTime !== undefined) ? Math.floor(Number(runtime.lastIdleStateTime)) : null;
            u._forcedTargetLastSeenX = (runtime.forcedTargetLastSeenX !== null && runtime.forcedTargetLastSeenX !== undefined) ? Number(runtime.forcedTargetLastSeenX) : null;
            u._forcedTargetLastSeenY = (runtime.forcedTargetLastSeenY !== null && runtime.forcedTargetLastSeenY !== undefined) ? Number(runtime.forcedTargetLastSeenY) : null;
            u.workerTransferCooldown = (runtime.workerTransferCooldown !== null && runtime.workerTransferCooldown !== undefined) ? Math.floor(Number(runtime.workerTransferCooldown)) : 0;
            u.healerHasMaterial = !!runtime.healerHasMaterial;
            u.builderHasMaterial = !!runtime.builderHasMaterial;
            u.researcherHasMaterial = !!runtime.researcherHasMaterial;
            u._astarBudgetBlockedUntil = (runtime.astarBudgetBlockedUntil !== null && runtime.astarBudgetBlockedUntil !== undefined) ? Math.floor(Number(runtime.astarBudgetBlockedUntil)) : null;
            u._astarBudgetRetryTick = (runtime.astarBudgetRetryTick !== null && runtime.astarBudgetRetryTick !== undefined) ? Math.floor(Number(runtime.astarBudgetRetryTick)) : null;
            u._builderLastWatchX = (runtime.builderLastWatchX !== null && runtime.builderLastWatchX !== undefined) ? Number(runtime.builderLastWatchX) : null;
            u._builderLastWatchY = (runtime.builderLastWatchY !== null && runtime.builderLastWatchY !== undefined) ? Number(runtime.builderLastWatchY) : null;
            u._researcherTripWork = (runtime.researcherTripWork !== null && runtime.researcherTripWork !== undefined) ? Math.floor(Number(runtime.researcherTripWork)) : 0;
            u._researcherTripCost = (runtime.researcherTripCost !== null && runtime.researcherTripCost !== undefined) ? Math.floor(Number(runtime.researcherTripCost)) : 0;
            u._researcherMaterialReadyTick = (runtime.researcherMaterialReadyTick !== null && runtime.researcherMaterialReadyTick !== undefined) ? Math.floor(Number(runtime.researcherMaterialReadyTick)) : 0;
            u._scoutTarget = runtime.scoutTarget ? { gx: Math.floor(Number(runtime.scoutTarget.gx)||0), gy: Math.floor(Number(runtime.scoutTarget.gy)||0) } : null;
            u._nextScoutRetargetTick = (runtime.nextScoutRetargetTick !== null && runtime.nextScoutRetargetTick !== undefined) ? Math.floor(Number(runtime.nextScoutRetargetTick)) : null;
        }

        // Normalize worker timing fields after snapshot restore: only fix impossible future values.
        // Non-finite values should be left for normal game code initialization.
        // This prevents over-eager re-evaluation which can cause workers to behave differently post-snapshot.
        try {
            const ensureValidTick = (fld) => {
                if (u && Object.prototype.hasOwnProperty.call(u, fld)) {
                    let v = u[fld];
                    if (Number.isFinite(v) && v > gameTime) {
                        // Future tick value is impossible; clamp to safe past value
                        u[fld] = Math.max(0, Math.floor(gameTime) - 1);
                    }
                    // Non-finite values: leave for normal init code
                }
            };
            // All worker timing fields: only fix impossible future values
            ensureValidTick('_builderLastMoveTick');
            ensureValidTick('_builderNextRecheckTick');
            ensureValidTick('_collectorLastMoveTick');
            ensureValidTick('_collectorNextRecheckTick');
            ensureValidTick('_healerLastMoveTick');
            ensureValidTick('_healerNextRecheckTick');
            ensureValidTick('_researchLastMoveTick');
            ensureValidTick('_researchNextRecheckTick');
            ensureValidTick('_workerNextIdleRetargetTick');
        } catch (e) {}
    }

    // Rebuild worker target reservation cache from restored unit targets.
    // Snapshot payload can carry workerTarget references, but the reservation index is runtime-only.
    _invalidateWorkerTargetLoadCache();
    for (let u of units) {
        if (!u || !u.workerState || !u.workerType) continue;
        if (!u.workerTarget) continue;
        let restoredTarget = u.workerTarget;
        let restoredTargetType = u.workerTargetType;
        u.workerTarget = null;
        u.workerTargetType = null;
        u._workerReservedTileIndex = -1;
        _setWorkerTarget(u, restoredTarget, restoredTargetType);
    }

    // Re-populate _resourceCollectorMemory from the restored backing fields.
    // cloneSnapshotValue strips _-prefixed fields, so the cache is null on restore.
    // Without this, the collector's first `_getResourceCollectorMemory()` call creates
    // an empty cache, losing its mine/spawner routing memory and potentially causing
    // an extra mine visit or wrong-spawner deposit.
    for (let u of units) {
        if (!u || !u.workerType) continue;
        let wt = String(u.workerType || '');
        if (wt === 'collector') {
            u._resourceCollectorMemory = {
                pinnedTarget: u._collectorPinnedTarget || null,
                pinnedTargetType: u._collectorPinnedTargetType || null,
                lastGatherX: (u._collectorLastGatherX !== null && u._collectorLastGatherX !== undefined) ? Number(u._collectorLastGatherX) : null,
                lastGatherY: (u._collectorLastGatherY !== null && u._collectorLastGatherY !== undefined) ? Number(u._collectorLastGatherY) : null,
                lastGatherGx: (u._collectorLastGatherGx !== null && u._collectorLastGatherGx !== undefined) ? Math.floor(Number(u._collectorLastGatherGx)) : null,
                lastGatherGy: (u._collectorLastGatherGy !== null && u._collectorLastGatherGy !== undefined) ? Math.floor(Number(u._collectorLastGatherGy)) : null,
                lastGatherType: u._collectorLastGatherType || null,
                nextSpawner: u._collectorNextSpawner || null,
                lastDropoffSpawner: u._collectorLastDropoffSpawner || null,
                lastMineTarget: u._lastMineTarget || null,
                lastMineTargetType: null,
            };
        } else if (wt === 'astar_collector') {
            u._resourceCollectorMemory = {
                pinnedTarget: u._astarPinnedTarget || null,
                pinnedTargetType: u._astarPinnedTargetType || null,
                lastGatherX: (u._astarLastGatherX !== null && u._astarLastGatherX !== undefined) ? Number(u._astarLastGatherX) : null,
                lastGatherY: (u._astarLastGatherY !== null && u._astarLastGatherY !== undefined) ? Number(u._astarLastGatherY) : null,
                lastGatherGx: (u._astarLastGatherGx !== null && u._astarLastGatherGx !== undefined) ? Math.floor(Number(u._astarLastGatherGx)) : null,
                lastGatherGy: (u._astarLastGatherGy !== null && u._astarLastGatherGy !== undefined) ? Math.floor(Number(u._astarLastGatherGy)) : null,
                lastGatherType: u._astarLastMineTargetType || null,
                nextSpawner: u._astarNextSpawner || null,
                lastDropoffSpawner: null,
                lastMineTarget: u._astarLastMineTarget || null,
                lastMineTargetType: u._astarLastMineTargetType || null,
            };
        }
    }

    // Re-derive live unit stats from precomputed tables after snapshot assignment.
    // This prevents stale/invalid serialized fields (including astarCost) from bypassing runtime scaling.
    for (let u of units) {
        if (!u || u.dead) continue;
        let baseLevel = Math.max(1, getUnitBaseLevel(u));
        applyUnitLevelScaling(u, baseLevel);
        let effLevel = Math.max(1, getUnitEffectiveLevel(u, baseLevel));
        if (effLevel !== baseLevel) applyUnitEffectiveScaling(u, effLevel);
    }

    nextUnitId = Math.max(snapshotNextUnitId, units.reduce((m, u) => Math.max(m, Math.floor(Number(u.id) || 0) + 1), 1));

    goldMines.length = 0;
    if (Array.isArray(snapshotGoldMines)) {
        for (let m of snapshotGoldMines) {
            if (!m) continue;
            goldMines.push(m);
            let gx = Math.floor(Number(m.gx));
            let gy = Math.floor(Number(m.gy));
            setTileEntity(gx, gy, TILE_ENTITY_GOLDMINE, m);
        }
    }
    astarMines.length = 0;
    if (Array.isArray(snapshotAstarMines)) {
        for (let m of snapshotAstarMines) {
            if (!m) continue;
            astarMines.push(m);
            let gx = Math.floor(Number(m.gx));
            let gy = Math.floor(Number(m.gy));
            setTileEntity(gx, gy, TILE_ENTITY_ASTARMINE, m);
        }
    }
    droppedItems = [];
    initDroppedItemGrid();
    let snapshotDroppedItems = Array.isArray(snapshot.droppedItems) ? cloneSnapshotValue(snapshot.droppedItems) : [];
    for (let d of snapshotDroppedItems) {
        if (!d) continue;
        addDroppedItem(d);
    }

    let floorItems = Array.isArray(snapshot.floorItems) ? snapshot.floorItems : [];
    for (let f of floorItems) {
        if (!f) continue;
        let gx = Math.floor(Number(f.gx));
        let gy = Math.floor(Number(f.gy));
        if (!(gx >= 0 && gx < GRID_W && gy >= 0 && gy < GRID_H)) continue;
        if (!grid[gy] || !grid[gy][gx]) continue;
        if (grid[gy][gx].item) continue;
        let floorItem = cloneSnapshotValue(f.item || null);
        let floorItemType = String((floorItem && floorItem.type) || '');
        if (floorItemType && BASE_CARD_TYPES[floorItemType] && BASE_CARD_TYPES[floorItemType].target === 'wall') continue;
        // Structural entities must be restored from towers/barracks/spawners snapshot arrays, never floorItems.
        if (floorItemType.startsWith('barrack_')) continue;
        if (floorItemType === 'spawner' || floorItemType === 'astar_spawner' || floorItemType === 'salvager' || floorItemType === 'builder_spawner' || floorItemType === 'healer_spawner' || floorItemType === 'research') continue;
        grid[gy][gx].item = floorItem;
        grid[gy][gx].owner = Math.floor(Number(f.owner) || 0);
        if (floorItem) restoreDerivedThingStats(floorItem);
        if (grid[gy][gx].item) setTileEntity(gx, gy, String(grid[gy][gx].item.type || 'floor_item'), grid[gy][gx].item);
    }

    areas = Array.isArray(snapshot.areas) ? cloneSnapshotValue(snapshot.areas) : areas;
    rebuildAreaDistanceCachesFromAreas();
    if (Array.isArray(snapshot.areaState)) {
        for (let entry of snapshot.areaState) {
            if (!Array.isArray(entry)) continue;
            let ar = getAreaById(Math.floor(Number(entry[0])));
            if (!ar) continue;
            ar.active = !!entry[1];
            ar.multiplierLevel = Math.max(0, Math.floor(Number(entry[2]) || 0));
        }
        dirtyAreas = true;
    }
    resignedTeams = new Set(Array.isArray(snapshot.resignedTeams) ? snapshot.resignedTeams.map(v => Math.floor(Number(v) || 0)) : []);
    if (resignedTeams.has(localPlayerId) && !localDefeated) {
        localDefeated = true;
        if (spectateMode === 'none') spectateMode = 'defeated';
    }
    recomputePlayerPopCaps();

    if (rng && typeof rng.setState === 'function' && snapshot.rngState !== null && snapshot.rngState !== undefined) {
        rng.setState(snapshot.rngState);
    }

    // Restore pathfinding per-tick budgets to ensure deterministic path request allocation
    if (Array.isArray(snapshot.pathfindBudgetByPlayer) && snapshot.pathfindBudgetByPlayer.length > 0) {
        for (let i = 0; i < snapshot.pathfindBudgetByPlayer.length && i < Math.max(0, players.length || 0); i++) {
            pathfindBudgetByPlayer[i] = Math.max(0, Math.floor(Number(snapshot.pathfindBudgetByPlayer[i]) || 0));
        }
    }
    if (Array.isArray(snapshot.astarNodeBudgetRemainingByPlayer) && snapshot.astarNodeBudgetRemainingByPlayer.length > 0) {
        for (let i = 0; i < snapshot.astarNodeBudgetRemainingByPlayer.length && i < Math.max(0, players.length || 0); i++) {
            astarNodeBudgetRemainingByPlayer[i] = Math.max(0, Math.floor(Number(snapshot.astarNodeBudgetRemainingByPlayer[i]) || 0));
        }
    }

    // Snapshot objects are rebuilt from transport payloads; transient drag-box state is cleared,
    // but live panel/popup selections are remapped back onto restored authoritative objects.
    selectionBox = null;
    selectionBoxScreen = null;
    isBoxSelecting = false;

    if (typeof clearRendererTransientVisualCaches === 'function') {
        clearRendererTransientVisualCaches({ preserveTextSprites: true });
    }
    if (typeof updateItemTextCache === 'function') {
        for (let t of towers) {
            if (!t) continue;
            t._levelTextLabel = '';
            updateItemTextCache(t);
        }
        for (let b of barracks) {
            if (!b) continue;
            b._levelTextLabel = '';
            updateItemTextCache(b);
        }
        for (let s of collectorSpawners) {
            if (!s) continue;
            s._levelTextLabel = '';
            updateItemTextCache(s);
        }
    }
    _restoreSnapshotApplyUiState(uiStateBeforeApply, snapshotResolveContext);
    if (typeof requestBuildMenuRefresh === 'function') requestBuildMenuRefresh();
    if (typeof updateInfoPanel === 'function') updateInfoPanel();

    initSpatialHash();
    for (let u of units) updateUnitSpatial(u);
    recalculateLaserConnections();
    // Recompute gameplay visibility, retaining this client's visual history.
    visibilityGridRawByPlayerCache.clear();
    visibilityGridByPlayer = Array.from({ length: players.length }, () => []);
    visibilityCacheTick = -1;
    updateVisibility(localPlayerId);
    dirtyGrid = true;
    dirtyAreas = true;
    invalidateStaticLayerCache();
    // Hard-resync must also reset path caches/runtime topology state; stale local cache entries can
    // make the guest pick different route branches immediately after snapshot apply.
    if (typeof _bumpPathTopologyVersion === 'function') {
        _bumpPathTopologyVersion();
    } else {
        if (typeof sharedPathCache !== 'undefined' && sharedPathCache && typeof sharedPathCache.clear === 'function') sharedPathCache.clear();
        if (typeof sharedPartialPathCache !== 'undefined' && sharedPartialPathCache && typeof sharedPartialPathCache.clear === 'function') sharedPartialPathCache.clear();
        if (typeof sharedSpawnerRouteCache !== 'undefined' && sharedSpawnerRouteCache && typeof sharedSpawnerRouteCache.clear === 'function') sharedSpawnerRouteCache.clear();
        if (typeof sharedSpawnerRallyTemplateCache !== 'undefined' && sharedSpawnerRallyTemplateCache && typeof sharedSpawnerRallyTemplateCache.clear === 'function') sharedSpawnerRallyTemplateCache.clear();
    }
    pathfindBudget = 0;

    let snapTick = Math.max(0, Math.floor(Number(snapshot.currentTick) || Number(snapshot.tick) || 0));
    // Unsent or unsealed commands survive; everything else restarts at the
    // snapshot tick. Resend timestamps are cleared so packets go out again.
    lockstepLocalPacketByTick = preservedLocalPackets;
    localInputBuffer = preservedInput;
    lockstepHostPacketsByTick = preservedHostPackets;
    lockstepBundleByTick = {};
    lockstepPendingBundleByTick = {};
    lockstepPendingCommitByTick = {};
    lockstepCommittedByTick = {};
    lockstepLastPacketSentAtByTick = {};
    lockstepLastBundleSentAtByTick = {};
    lockstepLastResendRequestAtByTick = {};
    lockstepHistoryByTick = {};
    lockstepSnapshotLastSentAtByPeer = {};
    lockstepHostWaitRequestByPeer = {};
    lockstepGuestWaitRequest = null;
    lockstepHighestSentLocalTick = Math.max(snapTick - 1, Number.isFinite(preservedHighestSent) ? preservedHighestSent : -1);

    if (Array.isArray(snapshot.lockstepWindowPackets)) {
        for (let tickEntry of snapshot.lockstepWindowPackets) {
            let tick = Math.floor(Number(tickEntry && tickEntry.tick));
            if (!Number.isFinite(tick) || tick < snapTick) continue;
            let packets = Array.isArray(tickEntry && tickEntry.packets) ? tickEntry.packets : [];
            if (packets.length <= 0) continue;
            let packetMap = {};
            for (let packet of packets) {
                let restoredPacket = {
                    tick: Math.floor(Number(packet && packet.tick) || 0),
                    peerId: String((packet && packet.peerId) || ''),
                    teamId: Math.floor(Number(packet && packet.teamId) || 0),
                    actions: Array.isArray(packet && packet.actions) ? packet.actions.map(a => cloneSnapshotValue(a)) : [],
                    checksum: String((packet && packet.checksum) || '')
                };
                if (restoredPacket.tick !== tick || !restoredPacket.peerId) continue;
                if (typeof validateTickPacket === 'function' && !validateTickPacket(restoredPacket)) continue;
                packetMap[restoredPacket.peerId] = restoredPacket;
                if (!isHost && restoredPacket.peerId === String(myPeerId || '')) {
                    // The host holds this packet, so it is sent and final.
                    lockstepLocalPacketByTick[tick] = restoredPacket;
                    if (tick > lockstepHighestSentLocalTick) lockstepHighestSentLocalTick = tick;
                }
            }
            if (Object.keys(packetMap).length > 0) {
                lockstepHostPacketsByTick[tick] = { ...(lockstepHostPacketsByTick[tick] || {}), ...packetMap };
                if (isHost && myPeerId && packetMap[myPeerId]) lockstepLocalPacketByTick[tick] = packetMap[myPeerId];
            }
        }
    }

    if (Array.isArray(snapshot.lockstepWindowBundles)) {
        for (let bundle of snapshot.lockstepWindowBundles) {
            let restoredBundle = {
                tick: Math.floor(Number(bundle && bundle.tick) || 0),
                packets: Array.isArray(bundle && bundle.packets)
                    ? bundle.packets.map(packet => ({
                        tick: Math.floor(Number(packet && packet.tick) || 0),
                        peerId: String((packet && packet.peerId) || ''),
                        teamId: Math.floor(Number(packet && packet.teamId) || 0),
                        actions: Array.isArray(packet && packet.actions) ? packet.actions.map(a => cloneSnapshotValue(a)) : [],
                        checksum: String((packet && packet.checksum) || '')
                    }))
                    : [],
                combinedChecksum: String((bundle && bundle.combinedChecksum) || '')
            };
            if (!Number.isFinite(restoredBundle.tick) || restoredBundle.tick < snapTick) continue;
            if (typeof validateTickBundle === 'function' && !validateTickBundle(restoredBundle)) continue;
            lockstepBundleByTick[restoredBundle.tick] = restoredBundle;
        }
    }

    if (Array.isArray(snapshot.lockstepWindowCommittedTicks)) {
        for (let tick of snapshot.lockstepWindowCommittedTicks) {
            let restoredTick = Math.floor(Number(tick));
            if (!Number.isFinite(restoredTick) || restoredTick < snapTick) continue;
            lockstepCommittedByTick[restoredTick] = true;
        }
    }

    lockstepResyncResumeTick = snapTick;

    let st = document.getElementById('lobby-status');
    if (st && !isHost) {
        st.style.color = '#9f9';
    }
    return true;
}

// Guest: start (or join) the host's match from a START_GAME / START_SPECTATE
// message. The world is generated from the shared seed and settings, then
// overwritten by the host's snapshot. A mid-match join (`resyncSessionId`)
// stays paused until the host resumes everyone.
async function applyIncomingMatchSyncPayload(data, role = 'playing') {
    let now = performance.now();
    let midMatchJoin = !!(data && data.resyncSessionId);
    gameSeed = data.seed;
    matchStartSessionId = String((data && data.startSessionId) || matchStartSessionId || '');
    if (!isHost) {
        matchStartWaitingForReady = !midMatchJoin;
        setMatchLoadOverlay(true, midMatchJoin ? 'Joining Match' : 'Loading Match', 'Applying host state...');
    }
    waitingForRemoteSince = 0;
    lockstepLastHardResyncRequestAt = 0;
    lockstepHardResyncInFlightUntil = 0;
    lockstepPostSnapshotGraceUntilAt = now + getLockstepPostSnapshotGraceMs();
    lockstepSnapshotLastSentAtByPeer = {};
    lockstepResyncPauseActive = false;
    lockstepResyncSessionId = '';
    lockstepResyncPendingAckByPeer = {};
    lockstepResyncSnapshotCache = null;
    lockstepResyncResumeTick = -1;
    lockstepResyncRequestedAt = 0;
    lockstepDesyncDetected = false;
    lockstepExpectedStateHashByTick = {};
    lockstepLocalStateHashByTick = {};
    lockstepExpectedStateDigestByTick = {};
    lockstepLocalStateDigestByTick = {};
    removedFromMatchPeerIds = new Set();
    guestReconnectAttempt = 0;
    netHostUnreachable = false;
    if (guestReconnectTimer) {
        clearTimeout(guestReconnectTimer);
        guestReconnectTimer = null;
    }
    lobbyPlayers = normalizeIncomingLobbyPlayers(data.lobbyPlayers);
    matchStartLobbyPlayers = lobbyPlayers.map(p => ({ ...p }));
    peerPresenceById = {};
    for (let lp of lobbyPlayers) peerPresenceById[lp.peerId] = true;
    peerPresenceById[myPeerId] = true;
    // This runs after the snapshot is decoded, so a roster broadcast may
    // already have arrived: keep it unless this message carries its own.
    if (data && data.roleByPeer && typeof data.roleByPeer === 'object') remoteRoleByPeerId = { ...data.roleByPeer };
    if (data && data.presenceByPeer && typeof data.presenceByPeer === 'object') remotePresenceByPeerId = { ...data.presenceByPeer };
    if (data && data.latencyByPeer && typeof data.latencyByPeer === 'object') remoteLatencyByPeerId = { ...data.latencyByPeer };
    if (myPeerId) {
        remoteRoleByPeerId[myPeerId] = role;
        remotePresenceByPeerId[myPeerId] = true;
    }
    let setup = computeTeamSetupFromLobby();
    activeTeamIds = setup.activeTeamIds;
    teamColorById = setup.teamColorById;
    localPlayerId = resolveLocalPlayerTeamId(setup);
    isMultiplayer = true;
    if (data.cfg) {
        let cfgGridW = Math.max(8, Math.floor(Number(data.cfg.gridW) || 80));
        let cfgGridH = Math.max(8, Math.floor(Number((data.cfg.gridH !== undefined ? data.cfg.gridH : data.cfg.gridW)) || cfgGridW));
        GRID_W = cfgGridW;
        GRID_H = cfgGridH;
        WORLD_W = GRID_W * TILE; WORLD_H = GRID_H * TILE;
        GOLD_MINE_COUNT = data.cfg.goldCount;
        GOLD_MINE_MIN = data.cfg.goldMin;
        GOLD_MINE_MAX = data.cfg.goldMax;
        GOLD_MINE_AREA = data.cfg.goldArea;
        fullVisibility = !!data.cfg.fullVis;
        teamVisibilityHistory = !!data.cfg.teamHistory;
        gameMode = data.cfg.gameMode || 'destroy';
        CONFIG_MAX_POP = Math.max(1, Math.floor(data.cfg.maxPop || 200));
        STARTING_MONEY = Math.max(0, Math.floor(data.cfg.startingMoney || 2000));
        STARTING_ASTAR = Math.max(0, Number(data.cfg.startingAstar) || 9000);
        MAP_TYPE = data.cfg.mapType || 'random';
        THING_STATS_RECALC_INTERVAL_SECONDS = Math.max(0.05, Math.min(600, Number(data.cfg.thingStatsRecalcIntervalSeconds) || THING_STATS_RECALC_INTERVAL_SECONDS));
        UNIT_EFFECTIVE_STATS_RECALC_TICKS = Math.max(1, Math.min(240, Math.floor(Number(data.cfg.unitEffectiveStatsRecalcTicks) || UNIT_EFFECTIVE_STATS_RECALC_TICKS)));
        ASTAR_ITER_BUDGET_PER_PLAYER_TICK = Math.max(256, Math.min(500000, Math.floor(Number(data.cfg.astarIterBudgetPerPlayerTick) || ASTAR_ITER_BUDGET_PER_PLAYER_TICK)));
        WORKER_AI_TICK_DELAY = Math.max(1, Math.min(60, Math.floor(Number(data.cfg.workerAiTickDelay) || WORKER_AI_TICK_DELAY)));

        RESEARCH_COST_EXP = Math.max(1, Number(data.cfg.researchCostExp) || 1.85);
        RESEARCH_WORK_EXP = Math.max(1, Number(data.cfg.researchWorkExp) || 1.7);
        RESEARCH_WORK_BASE = Math.max(1, Math.floor(Number(data.cfg.researchWorkBase) || 110));
        RESEARCH_BONUS_EXP_UNITS = Math.max(1, Number(data.cfg.researchBonusExpUnits) || 2.0);
        RESEARCH_BONUS_EXP_OTHER = Math.max(1, Number(data.cfg.researchBonusExpOther) || 1.25);
        RESEARCH_BONUS_EXP_OTHER_HOUSE_POPCAP = Math.max(1, Number(data.cfg.researchBonusExpOtherHousePopCap) || 2.0);
        MAX_THING_LEVEL = Math.max(1, Math.floor(Number(data.cfg.maxThingLevel) || 20));
        MAX_RESEARCH_LEVEL = Math.max(1, Math.floor(Number(data.cfg.maxResearchLevel) || 10));
        startingResourcesConfig = normalizeStartingResourcesConfig(data.cfg.startingResources || makeDefaultStartingResourcesConfig());
        if (data.cfg.editableConfig && typeof data.cfg.editableConfig === 'object') {
            try {
                applyEditableRuntimeConfigObject(data.cfg.editableConfig, { fromTransport: true });
            } catch {
                // Fall back to standard cfg fields if advanced payload is malformed.
            }
        }
        // Timing last: the editable config carries the host's menu values,
        // while these are what the host actually runs with.
        applyTimingConfig(parseInt(data.cfg.tickRate), parseInt(data.cfg.pipelineDelay));
        netAutoEnabled = data.cfg.netAuto !== undefined ? !!data.cfg.netAuto : netAutoEnabled;
        lockstepStrictDebugMode = !!data.cfg.exactLockstep;
    }
    let snapshotText = null;
    try {
        snapshotText = await netDecodeSnapshotPayload(data.snapshotPayload || (data.stateSnapshot ? { json: JSON.stringify(data.stateSnapshot) } : null));
    } catch (err) {
        logLockstepWarning('Could not decode match snapshot', { error: String(err && err.message || err) });
    }

    let _savedSessionId = matchStartSessionId;
    initAudio();
    startGame();
    matchStartSessionId = _savedSessionId;
    if (midMatchJoin) matchStartWaitingForReady = false;

    let applyStart = performance.now();
    if (snapshotText) {
        applyAuthoritativeStateSnapshot(JSON.parse(snapshotText));
        netCounters.snapshotApplyMs = performance.now() - applyStart;
        netCounters.snapshotBytes = netSnapshotPayloadBytes(data.snapshotPayload);
        netCounters.lastSnapshotAt = performance.now();
    } else {
        logLockstepWarning('Match start carried no snapshot; requesting one', {});
    }
    // After startGame(), which fixes the match visibility for the simulation.
    if (role === 'spectating') { fullVisibility = true; enterSpectateMode('postgame'); }

    let hostConn = netGetHostConnection();
    if (midMatchJoin) {
        // Wait paused for the host to resume everyone after this resync.
        let sid = String(data.resyncSessionId || '');
        lockstepResyncPauseActive = true;
        lockstepResyncSessionId = sid;
        lockstepReceivedResyncSessionId = sid;
        lockstepAppliedResyncSessionId = snapshotText ? sid : '';
        lockstepResyncRequestedAt = performance.now();
        setMatchLoadOverlay(false);
        if (hostConn && snapshotText) {
            try { hostConn.send({ type: 'MATCH_STATE_SNAPSHOT_APPLIED', sessionId: sid, tick: currentTick }); } catch { }
        }
        if (lockstepPendingResumeSessionId && lockstepPendingResumeSessionId === sid) _guestResumeAfterResync(sid);
        if (!snapshotText) requestHardLockstepResync(currentTick, 'join without snapshot');
        return;
    }

    if (!snapshotText) requestHardLockstepResync(currentTick, 'start without snapshot');
    if (hostConn) {
        try {
            hostConn.send({
                type: 'START_GAME_READY',
                startSessionId: matchStartSessionId,
                teamId: localPlayerId,
                role: normalizeMatchRole(role, 'playing')
            });
        } catch { }
    }
}

// Guest: leave the resync pause once the host says everyone is restored.
function _guestResumeAfterResync(sessionId) {
    lockstepPendingResumeSessionId = '';
    lockstepResyncPauseActive = false;
    lockstepResyncSessionId = '';
    lockstepResyncRequestedAt = 0;
    waitingForRemoteSince = 0;
    lockstepHardResyncInFlightUntil = 0;
    lockstepDesyncDetected = false;
    // Push our pending packets right away; the host is waiting for them.
    if (gameStarted) sendLocalTickPacketWindow(currentTick, true);
}

function updateSpectateButtonVisibility() {
    let btn = document.getElementById('btn-spectate-online');
    if (!btn) return;
    let visible = !duplicateUidBlocked && !isHost && !gameStarted && !!remoteMatchRunning;
    btn.style.display = visible ? 'inline-block' : 'none';
    btn.disabled = !visible;
}

function requestSpectateCurrentMatch() {
    if (duplicateUidBlocked) return;
    let hostConn = netGetHostConnection();
    if (isHost || gameStarted || !hostConn || pendingJoinAsSpectator) return;
    pendingJoinAsSpectator = true;
    try { hostConn.send({ type: 'REQUEST_SPECTATE' }); } catch { }
    _setLobbyStatus('Requesting to spectate the running match...', '#4af');
    let btn = document.getElementById('btn-spectate-online');
    if (btn) btn.disabled = true;
    setTimeout(() => {
        if (!pendingJoinAsSpectator || gameStarted) return;
        pendingJoinAsSpectator = false;
        _setLobbyStatus('The host did not answer the spectate request. Try again.', '#fa4');
        updateSpectateButtonVisibility();
    }, 15000);
}

function computeTeamSetupFromLobby() {
    let teamByPeer = {};
    let activeSet = new Set();
    let colorByTeam = {};
    for (let lp of lobbyPlayers) {
        let color = normalizeLobbyColor(lp.color);
        let teamId = TEAM_PRESET_COLORS.indexOf(color);
        if (teamId < 0) teamId = 0;
        teamByPeer[lp.peerId] = teamId;
        activeSet.add(teamId);
        colorByTeam[teamId] = color;
    }
    let active = Array.from(activeSet).sort((a, b) => a - b);
    if (active.length === 0) active = [0, 1];
    return { teamByPeer, activeTeamIds: active, teamColorById: colorByTeam };
}

function resolveLocalPlayerTeamId(setup) {
    if (setup && setup.teamByPeer && myPeerId && setup.teamByPeer[myPeerId] !== undefined) {
        return setup.teamByPeer[myPeerId];
    }
    let uid = String(localPersistentPeerId || '').trim();
    if (uid) {
        let match = (lobbyPlayers || []).find(p => p && String(p.uid || '').trim() === uid);
        if (match && setup && setup.teamByPeer && setup.teamByPeer[match.peerId] !== undefined) {
            if (myPeerId) setup.teamByPeer[myPeerId] = setup.teamByPeer[match.peerId];
            return setup.teamByPeer[match.peerId];
        }
    }
    if (setup && Array.isArray(setup.activeTeamIds)) {
        let prevLocalTeam = Math.floor(Number(localPlayerId));
        if (setup.activeTeamIds.includes(prevLocalTeam)) return prevLocalTeam;
    }
    return (setup && Array.isArray(setup.activeTeamIds) && setup.activeTeamIds.length > 0)
        ? setup.activeTeamIds[0]
        : 0;
}

function dedupeLobbyPlayers() {
    if (!Array.isArray(lobbyPlayers) || lobbyPlayers.length <= 1) return;
    let seen = new Set();
    let out = [];
    for (let i = lobbyPlayers.length - 1; i >= 0; i--) {
        let lp = lobbyPlayers[i];
        if (!lp || !lp.peerId) continue;
        let pid = canonicalPeerId(lp.peerId);
        if (seen.has(pid)) continue;
        seen.add(pid);
        out.push({ peerId: pid, name: String(lp.name || '').slice(0, 24), color: normalizeLobbyColor(lp.color), uid: String(lp.uid || '') });
    }
    lobbyPlayers = out.reverse();
}

function getPeerConnectionState(peerId) {
    if (!peerId || peerId === myPeerId) return true;
    if (!isHost && remotePresenceByPeerId && remotePresenceByPeerId[peerId] !== undefined) return remotePresenceByPeerId[peerId] !== false;
    if (peerPresenceById[peerId] !== undefined) return peerPresenceById[peerId] !== false;
    return connections.some(c => c && c.peer === peerId);
}

function getPeerMatchState(peerId, setup = null) {
    if (!gameStarted) return 'playing';
    let st = setup || computeTeamSetupFromLobby();
    let teamId = st.teamByPeer[peerId];

    if (isPeerExplicitlyRemoved(peerId)) return 'removed';

    if (peerId === myPeerId) {
        if (localDefeated || spectateMode !== 'none' || resignedTeams.has(localPlayerId)) return 'spectator';
        return 'playing';
    }

    if (Number.isFinite(teamId) && resignedTeams.has(teamId)) return 'spectator';

    if (!isHost) {
        let remoteRole = normalizeMatchRole(remoteRoleByPeerId[peerId], '');
        if (remoteRole === 'spectating') return 'spectator';
        if (!getPeerConnectionState(peerId)) return 'left';
        if (remoteRole === 'playing') return 'playing';
    }

    if (!getPeerConnectionState(peerId)) return 'left';
    return 'playing';
}

function bindInfoPanelPlayerStatusControls(panel) {
    if (!panel) return;

    panel.querySelectorAll('.info-section-toggle').forEach(btn => {
        bindInstantPress(btn, () => {
            let sectionKey = btn.getAttribute('data-section-key') || '';
            if (!sectionKey) return;
            _toggleInfoSectionCollapsed(sectionKey);
            updateInfoPanel();
        });
    });

    panel.querySelectorAll('.info-energy-delta-window-btn').forEach(btn => {
        bindInstantPress(btn, () => {
            let metric = btn.getAttribute('data-metric') || '';
            if (!metric) return;
            cycleEnergyDeltaWindowSeconds(metric);
            updateInfoPanel();
        });
    });

    panel.querySelectorAll('.info-astar-window-btn').forEach(btn => {
        bindInstantPress(btn, () => {
            let metric = btn.getAttribute('data-metric') || '';
            if (!metric) return;
            cycleAstarWindowSeconds(metric);
            updateInfoPanel();
        });
    });

    panel.querySelectorAll('.info-player-status-select-btn').forEach(btn => {
        bindInstantPress(btn, () => {
            let domain = String(btn.getAttribute('data-domain') || '');
            let filter = String(btn.getAttribute('data-filter') || 'total');
            let mode = String(btn.getAttribute('data-mode') || 'all');
            if (!domain) return;
            selectInfoPanelPlayerRoster(domain, filter, mode, localPlayerId);
        });
    });

    let pingToggle = panel.querySelector('#info-toggle-show-ping');
    if (pingToggle) {
        pingToggle.onchange = () => {
            infoPanelShowPing = !!pingToggle.checked;
            updateInfoPanel();
        };
    }

    let removeToggle = panel.querySelector('#info-toggle-show-remove');
    if (removeToggle) {
        removeToggle.onchange = () => {
            infoPanelShowHostRemoveButtons = !!removeToggle.checked;
            updateInfoPanel();
        };
    }

    panel.querySelectorAll('.host-remove-player-btn').forEach(btn => {
        btn.onclick = () => {
            let peerId = btn.getAttribute('data-peer-id') || '';
            if (!peerId) return;
            let lp = lobbyPlayers.find(p => p.peerId === peerId);
            let name = lp ? (lp.name || defaultLobbyName(peerId)) : defaultLobbyName(peerId);
            if (!window.confirm(`Remove ${name} from the active match?`)) return;
            hostRemovePlayerFromMatch(peerId);
        };
    });
}

function buildInfoPanelPlayerStatusHtml() {
    if (!gameStarted) return '';

    let baseHtml = buildInfoPanelEnergyDeltaHtml(localPlayerId)
        + buildInfoPanelAstarBudgetHtml(localPlayerId)
        + buildInfoPanelIdleWorkersHtml(localPlayerId);
    if (!isMultiplayer || !Array.isArray(lobbyPlayers) || lobbyPlayers.length === 0) return baseHtml;

    let setup = computeTeamSetupFromLobby();
    let rows = '';
    let showHostRemoveToggle = isHost && gameStarted;
    let controls = `<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:2px 0 5px 0;color:#9aa;font-size:10px;">`;
    controls += `<label style="display:inline-flex;align-items:center;gap:4px;cursor:pointer;"><input id="info-toggle-show-ping" type="checkbox" ${infoPanelShowPing ? 'checked' : ''} /> Ping</label>`;
    if (showHostRemoveToggle) {
        controls += `<label style="display:inline-flex;align-items:center;gap:4px;cursor:pointer;"><input id="info-toggle-show-remove" type="checkbox" ${infoPanelShowHostRemoveButtons ? 'checked' : ''} /> Remove Buttons</label>`;
    }
    controls += `</div>`;

    for (let lp of lobbyPlayers) {
        let teamId = setup.teamByPeer[lp.peerId];
        let teamColor = Number.isFinite(teamId) ? (teamColorById[teamId] || PLAYER_COLORS[teamId] || '#888') : '#888';
        let state = getPeerMatchState(lp.peerId, setup);
        let stateLabel = state === 'spectator' ? 'Spectator' : (state === 'left' ? 'Disconnected' : (state === 'removed' ? 'Removed' : 'Playing'));
        let stateColor = state === 'spectator' ? '#fc8' : (state === 'left' ? '#f88' : (state === 'removed' ? '#f66' : '#9f9'));
        let latencyLabel = getPeerLatencyLabel(lp.peerId);
        let removeBtn = '';
        if (isHost && gameStarted && infoPanelShowHostRemoveButtons && lp.peerId !== myPeerId && !isPeerExplicitlyRemoved(lp.peerId)) {
            removeBtn = `<button class="host-remove-player-btn" data-peer-id="${_escapeHtml(lp.peerId)}" style="cursor:pointer;background:#2a1111;color:#f88;border:1px solid #744;border-radius:3px;font-size:10px;padding:2px 6px">Remove</button>`;
        }
        rows += `<div class="info-row" style="align-items:center;gap:6px">
                    <span style="display:inline-block;width:9px;height:9px;border-radius:50%;background:${teamColor};border:1px solid #444;flex:0 0 auto"></span>
                    <span class="info-label" style="color:#ddd;flex:1 1 48px;min-width:48px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis" title="${_escapeHtml(lp.name || defaultLobbyName(lp.peerId))}">${_escapeHtml(lp.name || defaultLobbyName(lp.peerId))}</span>
                    ${infoPanelShowPing ? `<span class="info-value" style="flex:0 0 auto;color:#8cf;text-align:right;min-width:56px" title="Round trip time">${latencyLabel}</span>` : ''}
                    <span class="info-value" style="flex:0 0 auto;color:${stateColor};text-align:right">${stateLabel}</span>
                    ${removeBtn}
                </div>`;
    }

    return `${baseHtml}<div class="info-title">Online Players</div>${controls}${rows}${buildNetworkInfoPanelHtml()}`;
}

function renderOnlineLobby() {
    dedupeLobbyPlayers();
    let list = document.getElementById('lobby-players');
    if (!list) return;
    let rows = '';
    for (let lp of lobbyPlayers) {
        let isSelf = lp.peerId === myPeerId;
        let teamId = TEAM_PRESET_COLORS.indexOf(normalizeLobbyColor(lp.color));
        let colorOpts = TEAM_PRESET_COLORS.map(c => `<option value="${c}" ${c === normalizeLobbyColor(lp.color) ? 'selected' : ''}>${c.toUpperCase()}</option>`).join('');
        let latencyLabel = getPeerLatencyLabel(lp.peerId);
        rows += `<div style="display:flex;align-items:center;gap:8px;border:1px solid #2b2b2b;background:#141414;padding:6px;border-radius:4px;">
                    <div style="width:14px;height:14px;border-radius:50%;background:${normalizeLobbyColor(lp.color)};border:1px solid #666"></div>
                    <div style="color:#777;font-size:11px;min-width:52px">Team ${teamId >= 0 ? teamId + 1 : '?'}</div>
                    <div style="color:#8cf;font-size:11px;min-width:54px;text-align:right">${latencyLabel}</div>
                    <input class="lobby-name-input" data-peer="${lp.peerId}" value="${_escapeHtml(lp.name || '')}" ${isSelf ? '' : 'disabled'} style="flex:1;min-width:110px;background:#111;color:${isSelf ? '#fff' : '#888'};border:1px solid #444;border-radius:3px;padding:3px 6px" />
                    <select class="lobby-color-select" data-peer="${lp.peerId}" ${isSelf ? '' : 'disabled'} style="background:#111;color:${isSelf ? '#fff' : '#888'};border:1px solid #444;border-radius:3px;padding:3px 6px">${colorOpts}</select>
                </div>`;
    }
    list.innerHTML = rows || '<div style="color:#777">No players yet.</div>';

    list.querySelectorAll('.lobby-name-input').forEach(inp => {
        inp.onchange = () => {
            if (inp.dataset.peer !== myPeerId) return;
            let me = lobbyPlayers.find(p => p.peerId === myPeerId);
            if (!me) return;
            me.name = setLocalPreferredName((inp.value || '').trim().slice(0, 24) || defaultLobbyName(myPeerId));
            if (isHost) {
                broadcastLobbyState();
                renderOnlineLobby();
            } else if (connections[0]) {
                connections[0].send({ type: 'LOBBY_UPDATE_SELF', name: me.name, color: me.color });
            }
        };
    });

    list.querySelectorAll('.lobby-color-select').forEach(sel => {
        sel.onchange = () => {
            if (sel.dataset.peer !== myPeerId) return;
            let me = lobbyPlayers.find(p => p.peerId === myPeerId);
            if (!me) return;
            me.color = normalizeLobbyColor(sel.value);
            if (isHost) {
                broadcastLobbyState();
                renderOnlineLobby();
            } else if (connections[0]) {
                connections[0].send({ type: 'LOBBY_UPDATE_SELF', name: me.name, color: me.color });
            }
        };
    });

    let setup = computeTeamSetupFromLobby();
    let status = document.getElementById('lobby-status');
    if (status && status.textContent.indexOf('Starting') === -1 && status.textContent.indexOf('Connecting') === -1 && status.textContent.indexOf('Creating') === -1) {
        status.textContent = `${lobbyPlayers.length} player(s), ${setup.activeTeamIds.length} team(s)`;
    }
    updateSpectateButtonVisibility();

    let startBtn = document.getElementById('btn-start-online');
    if (startBtn) {
        startBtn.style.display = isHost ? 'inline-block' : 'none';
        startBtn.disabled = !isHost || lobbyPlayers.length < 2 || setup.activeTeamIds.length < 2;
    }
}

let _lobbyPingTimer = null;
let _lastLobbyLatencyRenderAt = 0;

// Refresh the lobby's ping column, but not while the player edits a field
// in the list (rebuilding it would drop their typing).
function _refreshLobbyLatencyLabels() {
    let now = performance.now();
    if ((now - _lastLobbyLatencyRenderAt) < 1000) return;
    let list = document.getElementById('lobby-players');
    let active = document.activeElement;
    if (list && active && typeof list.contains === 'function' && list.contains(active)) return;
    _lastLobbyLatencyRenderAt = now;
    renderOnlineLobby();
}
let _lastLobbyBroadcastAt = 0;
let _lobbyBroadcastTimer = null;

// Membership changes go out at once (`force`); latency refreshes are
// coalesced to one message per second.
function broadcastLobbyState(force = false) {
    if (!isHost) return;
    let now = performance.now();
    if (!force && (now - _lastLobbyBroadcastAt) < 1000) {
        if (!_lobbyBroadcastTimer) {
            _lobbyBroadcastTimer = setTimeout(() => {
                _lobbyBroadcastTimer = null;
                broadcastLobbyState(true);
            }, Math.max(0, 1000 - (now - _lastLobbyBroadcastAt)));
        }
        return;
    }
    _lastLobbyBroadcastAt = now;
    dedupeLobbyPlayers();
    // Profile ids let a guest that takes over as host recognize players who
    // come back under a new peer id.
    let payload = lobbyPlayers.map(p => ({ peerId: p.peerId, name: (p.name || '').slice(0, 24), color: normalizeLobbyColor(p.color), uid: String(p.uid || peerUidByPeerId[p.peerId] || '') }));
    let msg = {
        type: 'LOBBY_STATE', players: payload, gameRunning: !!(gameStarted && !gameOver),
        roleByPeer: buildHostRoleSnapshot(), presenceByPeer: buildHostPresenceSnapshot(), latencyByPeer: buildHostLatencySnapshot(),
        netAuto: !!netAutoEnabled
    };
    for (let c of connections) {
        if (!c) continue;
        try { c.send(msg); } catch { }
    }
}

function generateSocketId() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') {
        return window.crypto.randomUUID().replace(/-/g, '').slice(0, 12);
    }
    return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function buildInviteUrl(roomId) {
    const room = String(roomId || wsRoomId || myPeerId || '').trim();
    if (!room) return '';
    const invite = new URL(window.location.href);
    invite.searchParams.set('game', room);
    invite.searchParams.set('room', room);
    invite.searchParams.delete('relay');
    invite.searchParams.delete('ws');
    return invite.toString();
}

function initPeer(opts, cb) {
    networkSessionEpoch++;
    const sessionEpoch = networkSessionEpoch;
    connections = [];
    peerPresenceById = {};
    peerLatencyByPeerId = {};
    peerLatencyUpdatedAtByPeerId = {};
    pendingPingByPeerId = {};
    remoteLatencyByPeerId = {};
    lastNetworkPingSweepAt = 0;
    if (peer) {
        try { peer.destroy(); } catch { }
        peer = null;
    }

    if (typeof window.Peer !== 'function') {
        let st = document.getElementById('lobby-status');
        if (st) {
            st.textContent = 'PeerJS failed to load. Check your network and reload.';
            st.style.color = '#f44';
        }
        return;
    }

    let mode = opts && opts.mode === 'guest' ? 'guest' : 'host';
    let roomId = (opts && opts.roomId) ? String(opts.roomId).trim() : generateSocketId();
    let localId = (opts && opts.peerId) ? String(opts.peerId).trim() : '';

    if (mode === 'host') {
        if (!localId) localId = generateGameSessionId();
        roomId = localId;
        wsHostId = localId;
    } else {
        if (!localId) localId = undefined;
        wsHostId = roomId;
    }
    wsRoomId = roomId;

    // The frame loop only pings during a match; measure the links in the
    // lobby too, so input delay and the lobby's ping column are right from
    // the first tick.
    if (!_lobbyPingTimer) {
        _lobbyPingTimer = setInterval(() => {
            if (!gameStarted && peer && connections.length > 0) sendNetworkPings(performance.now());
        }, NETWORK_PING_INTERVAL_MS / 2);
    }
    let thisPeer = localId ? new window.Peer(localId) : new window.Peer();
    peer = thisPeer;
    let signalingRetry = 0;
    thisPeer.on('open', id => {
        if (sessionEpoch !== networkSessionEpoch) return;
        signalingRetry = 0;
        if (myPeerId === id && thisPeer._openedOnce) return; // signaling reconnect
        thisPeer._openedOnce = true;
        myPeerId = id;
        if (mode === 'host') {
            wsHostId = id;
            wsRoomId = id;
        }
        if (cb) cb(id);
    });
    thisPeer.on('connection', conn => {
        if (sessionEpoch !== networkSessionEpoch) return;
        let meta = (conn && conn.metadata) || {};
        // "Who hosts this match?" is answered by anyone.
        if (meta.hostSeek) { answerHostSeek(conn); return; }
        if (!isHost) {
            // Guests talk to the host only, except when a player moving the
            // match after losing the host picked them as the successor.
            if (gameStarted && isMultiplayer && meta.migrate) { guestHandleMigrationConnection(conn); return; }
            try { conn.close(); } catch { }
            return;
        }
        setupConnection(conn);
    });
    thisPeer.on('error', err => {
        if (sessionEpoch !== networkSessionEpoch) return;
        let type = String((err && err.type) || '');
        if (type === 'peer-unavailable') {
            let missing = peerIdFromUnavailableError(err);
            // Probes asking who hosts the match find some peers gone.
            if (missing && missing !== String(wsHostId || '')) return;
            if (mode !== 'guest' || isHost) return;
            if (gameStarted) {
                // The host's page is gone (closed, crashed, reloaded): no
                // point waiting for it. Move the match, or try the next
                // successor if this was one.
                if (hostMigration) hostMigrationCandidateFailed(missing || wsHostId);
                else if (!guestStartHostMigration('host unavailable')) scheduleGuestAutoReconnect('Host unreachable');
            } else if (!tryRecoverMatchFromRecord(missing || roomId)) {
                _returnToMainMenuWithStatus('Could not find that game. It may have ended, or the link is wrong.', '#f66');
            }
            return;
        }
        if (type === 'unavailable-id' && mode === 'guest' && opts && opts.peerId) {
            // Our old id is still registered after a drop; rejoin under a new
            // one (the host maps it to the same player by profile id).
            setTimeout(() => {
                if (sessionEpoch !== networkSessionEpoch) return;
                joinGame(roomId, { ...(opts.joinOpts || {}), rejoin: true, freshId: true });
            }, 0);
            return;
        }
        // Mid-match these are expected (network loss, signaling hiccups) and
        // handled by reconnecting; do not flood the console.
        if (gameStarted) _lockstepWarnRateLimited('peer-error:' + type, 'Peer error', { type, message: String((err && err.message) || '') });
        else console.error(err);
        if (!gameStarted) _setLobbyStatus((err && err.message) ? err.message : 'Connection failed.', '#f44');
    });

    // Losing the signaling server does not affect open data links; register
    // again so new or reconnecting players can reach us.
    thisPeer.on('disconnected', () => {
        if (sessionEpoch !== networkSessionEpoch) return;
        let delay = Math.min(10000, 1000 * Math.pow(2, signalingRetry++));
        setTimeout(() => {
            if (sessionEpoch !== networkSessionEpoch || thisPeer.destroyed) return;
            try { thisPeer.reconnect(); } catch { }
        }, delay);
    });

    peer.on('close', () => {
        if (sessionEpoch !== networkSessionEpoch) return;
        peer = null;
        let st = document.getElementById('lobby-status');
        if (st && !gameStarted && !duplicateUidBlocked) {
            st.textContent = 'Disconnected from peer network.';
            st.style.color = '#f44';
        }
        if (!isHost && gameStarted && !duplicateUidBlocked) {
            scheduleGuestAutoReconnect('Disconnected from host');
        }
    });
}

function setupConnection(conn) {
    if (!conn || !conn.peer) return;
    conn.peer = canonicalPeerId(conn.peer);
    if (!conn.peer || isLocalPeerAlias(conn.peer)) {
        try { conn.close(); } catch { }
        return;
    }
    if (connections.includes(conn)) return;
    let prior = connections.find(c => c && c !== conn && c.peer === conn.peer);
    // Register the new link before closing the one it replaces, so the
    // close handler sees the peer as still connected.
    connections = connections.filter(c => c !== prior);
    connections.push(conn);
    if (prior) {
        try { prior.close(); } catch { }
    }
    if (conn && conn.peer) {
        peerPresenceById[conn.peer] = true;
    }
    conn.on('data', data => {
        if (!connections.includes(conn)) return;
        if (!data || typeof data !== 'object') return;
        netNoteHeard(conn.peer);
        if (!isHost && conn.peer === wsHostId && !hostMigration) guestHostLostAt = 0;
        // One bad message must not break the connection's later ones; lost
        // effects are recovered by resend requests and the state hash check.
        try {
            if (typeof Jukebox !== 'undefined' && Jukebox.handle(conn, data)) return;
            _handleConnectionMessage(conn, data);
        } catch (err) {
            reportRuntimeError('message ' + String(data.type || ''), err);
        }
    });
    conn.on('open', () => {
        if (typeof Jukebox !== 'undefined') Jukebox.connected(conn);
        netNoteHeard(conn.peer);
        if (conn && conn.peer) {
            peerPresenceById[conn.peer] = true;
            if (!isHost || conn.peer === wsHostId) {
                clearPeerRemovedFromMatch(conn.peer);
            }
        }
        if (isHost) {
            if (gameStarted && isPeerExplicitlyRemoved(conn.peer)) {
                conn.send({ type: 'PLAYER_REMOVED_FROM_MATCH', peerId: conn.peer, teamId: getTeamIdForPeer(conn.peer) });
                return;
            }
            if (gameStarted) {
                // Opened during a resync that counts on it: what was sent
                // while it was still opening was lost.
                let cache = lockstepResyncSnapshotCache;
                if (lockstepResyncPauseActive && cache && Object.prototype.hasOwnProperty.call(lockstepResyncPendingAckByPeer, String(conn.peer))) {
                    try { conn.send({ type: 'LOCKSTEP_RESYNC_PAUSE', active: true, sessionId: cache.sessionId, reason: 'resync' }); } catch { }
                    _sendResyncSnapshotTo(conn);
                }
                broadcastLobbyState(true);
                return;
            }
            if (!lobbyPlayers.find(p => p.peerId === conn.peer)) {
                let used = new Set(lobbyPlayers.map(p => normalizeLobbyColor(p.color)));
                let firstFree = TEAM_PRESET_COLORS.find(c => !used.has(c)) || TEAM_PRESET_COLORS[(lobbyPlayers.length) % TEAM_PRESET_COLORS.length];
                lobbyPlayers.push({ peerId: conn.peer, name: defaultLobbyName(conn.peer), color: firstFree });
            }
            _setLobbyStatus('Player joined lobby');
            broadcastLobbyState(true);
            renderOnlineLobby();
        } else if (conn.peer === wsHostId) {
            _clearGuestJoinTimeout();
            if (guestReconnectTimer) {
                clearTimeout(guestReconnectTimer);
                guestReconnectTimer = null;
            }
            if (gameStarted) _setLobbyStatus('Reconnected to host.', '#9f9');
        }
    });
    conn.on('close', () => _handleConnectionClosed(conn));
    conn.on('error', err => {
        _lockstepWarnRateLimited('conn-error:' + conn.peer, 'Data connection error', { peerId: conn.peer, error: String(err && (err.message || err.type) || err) });
    });
}

function _setLobbyStatus(text, color = '') {
    let st = document.getElementById('lobby-status');
    if (!st) return;
    st.textContent = text;
    if (color) st.style.color = color;
}

function _handleConnectionClosed(conn) {
    // Links we already let go of (replaced, torn down, or handed over while
    // re-creating the peer) closing must not act on the current session.
    if (!connections.includes(conn)) return;
    connections = connections.filter(c => c !== conn);
    let leftPeerId = conn && conn.peer ? conn.peer : null;
    if (leftPeerId) peerPresenceById[leftPeerId] = false;
    if (isHost && matchStartWaitingForReady && leftPeerId) {
        matchStartExpectedReadyPeerIds = (matchStartExpectedReadyPeerIds || []).filter(pid => pid !== leftPeerId);
        delete matchStartReadyByPeerId[leftPeerId];
        if (_matchStartPlayerStatuses) delete _matchStartPlayerStatuses[leftPeerId];
        updateHostMatchStartReadyUi();
        if (areAllMatchStartPeersReady() && matchStartExpectedReadyPeerIds.length === 0) {
            matchStartWaitingForReady = false;
            _matchStartPlayerStatuses = null;
            setMatchLoadOverlay(false);
            broadcastStartGameAllReady();
        }
    }
    if (leftPeerId) {
        delete pendingPingByPeerId[leftPeerId];
        if (isHost && lockstepResyncPauseActive && lockstepResyncPendingAckByPeer && Object.prototype.hasOwnProperty.call(lockstepResyncPendingAckByPeer, leftPeerId)) {
            delete lockstepResyncPendingAckByPeer[leftPeerId];
            if (_isHostResyncPauseComplete()) {
                _finishHostResyncPause('peer left during resync');
            }
        }
    }

    if (!isHost && leftPeerId === wsHostId) {
        if (gameStarted) {
            scheduleGuestAutoReconnect('Host disconnected');
        } else if (!_guestLeavingLobby) {
            _returnToMainMenuWithStatus('Lost connection to the host.', '#f66');
        }
    }

    if (isHost) {
        if (!gameStarted) {
            lobbyPlayers = lobbyPlayers.filter(p => p.peerId !== conn.peer);
            if (conn.peer) delete peerUidByPeerId[conn.peer];
            _setLobbyStatus('Player disconnected from lobby');
            broadcastLobbyState(true);
            renderOnlineLobby();
        } else {
            broadcastLobbyState(true);
            updateInfoPanel();
        }
    }
}

function _handleConnectionMessage(conn, data) {
    let type = data.type;
    if (type === 'TICK_PACKETS') {
        handleIncomingTickPackets(conn, data);
    } else if (type === 'TICK_BUNDLE') {
        handleIncomingTickBundle(conn, data);
    } else if (type === 'TICK_STATE_HASH') {
        handleIncomingTickStateHash(conn, data);
    } else if (type === 'NET_PING') {
        try { conn.send({ type: 'NET_PONG', seq: Number(data.seq) || 0, t: data.t, report: (gameStarted && isMultiplayer) ? netLocalReport() : null }); } catch { }
        if (data.report) netNoteRemoteReport(conn.peer, data.report);
    } else if (type === 'NET_PONG') {
        let sentAt = Number(data.t);
        if (Number.isFinite(sentAt)) notePeerLatency(conn.peer, performance.now() - sentAt);
        if (data.report) netNoteRemoteReport(conn.peer, data.report);
        if (isHost && !gameStarted) broadcastLobbyState();
        if (!gameStarted) _refreshLobbyLatencyLabels();
    } else if (type === 'NET_STATS' && !isHost) {
        let byPeer = data.byPeer && typeof data.byPeer === 'object' ? data.byPeer : {};
        for (let pid of Object.keys(byPeer)) {
            if (pid === myPeerId) continue;
            netNoteRemoteReport(pid, byPeer[pid]);
        }
        if (data.latencyByPeer && typeof data.latencyByPeer === 'object') remoteLatencyByPeerId = { ...data.latencyByPeer };
    } else if (type === 'TICK_PACKET') {
        handleIncomingTickPacket(conn, data);
    } else if (type === 'TICK_BUNDLE_ACK' && isHost) {
        handleIncomingTickBundleAck(conn, data);
    } else if (type === 'TICK_RESEND_REQUEST') {
        handleIncomingTickResendRequest(conn, data);
    } else if (type === 'TICK_COMMIT') {
        handleIncomingTickCommit(conn, data);
    } else if (type === 'TICK_UNAVAILABLE' && !isHost) {
        logLockstepWarning('Host no longer has a needed tick; requesting snapshot', { tick: data.tick, oldest: data.oldest });
        requestHardLockstepResync(currentTick, 'tick history unavailable');
    } else if (type === 'TICK_STATE_HASH_MISMATCH_REPORT' && isHost) {
        netCounters.desyncsDetected++;
        netCounters.lastDesyncTick = Math.floor(Number(data && data.tick) || 0);
        netCounters.lastDesyncParts = (data && data.details && Array.isArray(data.details.parts)) ? data.details.parts.join(', ') : '';
        logLockstepWarning('Guest reported state-hash mismatch details', {
            peerId: conn && conn.peer ? conn.peer : null,
            tick: Math.floor(Number(data && data.tick) || 0),
            expectedHash: String((data && data.expectedHash) || ''),
            localHash: String((data && data.localHash) || ''),
            details: data && data.details ? data.details : null
        });
    } else if (type === 'LOCKSTEP_FATAL_STOP') {
        if (lockstepStrictDebugMode) stopLockstepDebugMatch(String(data.reason || 'peer stopped the match'), { tick: data.tick, fromPeer: conn.peer });
    } else if (type === 'START_GAME_PREPARE' && !isHost) {
        // PREPARE is only meaningful before gameplay starts.
        // Late/retried PREPARE packets can interfere with startup flow and lockstep gating.
        if (gameStarted) return;
        _clearGuestJoinTimeout();
        let prepSessionId = String((data && (data.sessionId || data.startSessionId)) || '');
        if (prepSessionId) matchStartSessionId = prepSessionId;
        let prepPlayers = normalizeIncomingLobbyPlayers(data.lobbyPlayers);
        if (prepPlayers.length > 0) lobbyPlayers = prepPlayers;
        _matchStartPlayerStatuses = {};
        for (let p of lobbyPlayers) {
            if (p && p.peerId) _matchStartPlayerStatuses[p.peerId] = p.peerId === myPeerId ? 'loading' : 'preparing';
        }
        setMatchLoadOverlay(true, 'Match Starting', 'Waiting for host to generate world…');
    } else if (type === 'START_GAME' && !isHost) {
        _clearGuestJoinTimeout();
        let midMatchJoin = !!data.resyncSessionId;
        if (!midMatchJoin && !_matchStartPlayerStatuses) {
            // Fallback: if START_GAME_PREPARE was missed, set up statuses from this packet.
            let prepPlayers = normalizeIncomingLobbyPlayers(data.lobbyPlayers);
            if (prepPlayers.length > 0) lobbyPlayers = prepPlayers;
            _matchStartPlayerStatuses = {};
            for (let p of lobbyPlayers) {
                if (p && p.peerId) _matchStartPlayerStatuses[p.peerId] = p.peerId === myPeerId ? 'loading' : 'preparing';
            }
        }
        // Host just sent us the world, so they are ready.
        if (!midMatchJoin && conn && conn.peer && _matchStartPlayerStatuses) _matchStartPlayerStatuses[String(conn.peer)] = 'ready';
        setMatchLoadOverlay(true, midMatchJoin ? 'Joining Match' : 'Loading Match', 'Receiving host world state…');
        // Yield once so the loading overlay appears before heavy snapshot/startup work.
        setTimeout(() => {
            applyIncomingMatchSyncPayload(data, 'playing').then(() => {
                if (midMatchJoin) {
                    netCounters.reconnects++;
                    return;
                }
                if (_matchStartPlayerStatuses && myPeerId) _matchStartPlayerStatuses[myPeerId] = 'ready';
                if (matchStartWaitingForReady) setMatchLoadOverlay(true, 'Waiting for Players', 'Loaded! Waiting for other players…');
            }).catch(err => {
                console.error('[NET] Failed to apply match start', err);
                requestHardLockstepResync(currentTick, 'start apply failed');
            });
        }, 0);
    } else if (type === 'REJOIN_RESUME' && !isHost) {
        // The host still has every tick since we dropped: just continue.
        _clearGuestJoinTimeout();
        guestReconnectAttempt = 0;
        netHostUnreachable = false;
        netCounters.reconnects++;
        netCounters.softRejoins++;
        if (Array.isArray(data.lobbyPlayers)) lobbyPlayers = normalizeIncomingLobbyPlayers(data.lobbyPlayers);
        if (data.roleByPeer && typeof data.roleByPeer === 'object') remoteRoleByPeerId = { ...data.roleByPeer };
        if (data.presenceByPeer && typeof data.presenceByPeer === 'object') remotePresenceByPeerId = { ...data.presenceByPeer };
        if (myPeerId) remotePresenceByPeerId[myPeerId] = true;
        // Unsealed packets may carry an old peer id after a reconnect.
        for (let key of Object.keys(lockstepLocalPacketByTick)) {
            let p = lockstepLocalPacketByTick[key];
            if (p && p.peerId !== myPeerId && !lockstepCommittedByTick[key]) delete lockstepLocalPacketByTick[key];
        }
        lockstepLastPacketSentAtByTick = {};
        lockstepGuestWaitRequest = null;
        _setLobbyStatus('Reconnected to host. Lockstep resumed.', '#9f9');
        sendLocalTickPacketWindow(currentTick, true);
    } else if (type === 'LOBBY_JOIN' && isHost) {
        _hostHandleLobbyJoin(conn, data);
    } else if (type === 'LOBBY_LEAVE' && isHost) {
        if (!gameStarted) {
            lobbyPlayers = lobbyPlayers.filter(p => p.peerId !== conn.peer);
            broadcastLobbyState(true);
            renderOnlineLobby();
        }
        try { conn.close(); } catch { }
    } else if (type === 'HOST_CLOSED_LOBBY' && !isHost) {
        // The host left a running match: another player takes over.
        if (data.migrate && gameStarted && !gameOver && conn.peer === wsHostId && guestStartHostMigration('host left', { hostLeft: true })) return;
        _returnToMainMenuWithStatus(String(data.reason || 'The host closed the lobby.'), '#fa4');
    } else if (type === 'HOST_SEEK_REPLY' && !isHost) {
        hostMigrationHandleReply(conn, data);
    } else if (type === 'HOST_MOVED' && !isHost) {
        if (conn.peer === wsHostId && String(data.sessionId || '') === String(matchStartSessionId || '')) guestFollowHostMove(data.hostId);
    } else if (type === 'LOBBY_UPDATE_SELF' && isHost) {
        let lp = lobbyPlayers.find(p => p.peerId === conn.peer);
        if (lp) {
            lp.name = (data.name || lp.name || defaultLobbyName(conn.peer)).slice(0, 24);
            // A color is a team: it cannot change once the match runs.
            if (!gameStarted) lp.color = normalizeLobbyColor(data.color || lp.color);
            broadcastLobbyState(true);
            renderOnlineLobby();
        }
    } else if (type === 'LOBBY_STATE' && !isHost) {
        _clearGuestJoinTimeout();
        // The successor took us in: the move is done.
        if (hostMigration && conn.peer === wsHostId) hostMigration = null;
        lobbyPlayers = normalizeIncomingLobbyPlayers(data.players);
        remoteMatchRunning = !!data.gameRunning;
        remoteRoleByPeerId = (data && data.roleByPeer && typeof data.roleByPeer === 'object') ? { ...data.roleByPeer } : {};
        remotePresenceByPeerId = (data && data.presenceByPeer && typeof data.presenceByPeer === 'object') ? { ...data.presenceByPeer } : {};
        remoteLatencyByPeerId = (data && data.latencyByPeer && typeof data.latencyByPeer === 'object') ? { ...data.latencyByPeer } : {};
        if (myPeerId) remotePresenceByPeerId[myPeerId] = true;
        if (data.netAuto !== undefined && !gameStarted) netAutoEnabled = !!data.netAuto;
        if (!gameStarted) {
            let st = document.getElementById('lobby-status');
            if (st && /Connect|Reconnect/.test(st.textContent)) _setLobbyStatus(remoteMatchRunning ? 'Match in progress. You can spectate.' : 'Connected! Waiting for host to start...', '#4af');
        }
        renderOnlineLobby();
    } else if (type === 'REQUEST_SPECTATE' && isHost) {
        if (!gameStarted || gameOver) {
            conn.send({ type: 'SPECTATE_UNAVAILABLE', reason: 'No active match to spectate.' });
            return;
        }
        matchRoleByPeerId[conn.peer] = 'spectating';
        let uid = getPeerProfileUid(conn.peer);
        if (uid) matchRoleByUid[uid] = 'spectating';
        hostSendFullMatchSync(conn, 'spectating');
        broadcastLobbyState(true);
        renderOnlineLobby();
    } else if (type === 'REQUEST_MATCH_SYNC' && isHost) {
        if (!gameStarted || gameOver) return;
        if (lockstepStrictDebugMode) {
            stopLockstepDebugMatch('match sync requested in exact lockstep mode', {
                tick: Math.floor(Number((data && data.tick) || currentTick) || 0),
                fromPeer: String((conn && conn.peer) || ''),
                reason: String((data && data.reason) || '')
            });
            return;
        }
        let reqReason = String((data && data.reason) || 'peer requested full match sync');
        let includeConfig = reqReason.toLowerCase().includes('config hash mismatch');
        _startHostResyncPause(reqReason, includeConfig, { requester: conn && conn.peer });
    } else if (type === 'START_SPECTATE' && !isHost) {
        _clearGuestJoinTimeout();
        pendingJoinAsSpectator = false;
        setMatchLoadOverlay(true, 'Joining Match', 'Receiving host world state…');
        setTimeout(() => {
            applyIncomingMatchSyncPayload(data, 'spectating').then(() => {
                _setLobbyStatus('Spectating current match.', '#9f9');
            }).catch(err => {
                console.error('[NET] Failed to apply spectate state', err);
            });
        }, 0);
    } else if (type === 'START_GAME_READY' && isHost) {
        let incomingSessionId = String((data && data.startSessionId) || '');
        if (incomingSessionId && matchStartSessionId && incomingSessionId !== matchStartSessionId) return;
        let pid = String((conn && conn.peer) || '');
        if (!pid) return;
        matchStartReadyByPeerId[pid] = true;
        if (_matchStartPlayerStatuses) _matchStartPlayerStatuses[pid] = 'ready';
        updateHostMatchStartReadyUi();
        if (!matchStartWaitingForReady) {
            // The countdown already finished: let this client in right away.
            try { conn.send({ type: 'START_GAME_ALL_READY', startSessionId: matchStartSessionId }); } catch { }
            return;
        }
        // When all clients are ready, broadcast a countdown and start it locally.
        if (areAllMatchStartPeersReady() && !_matchStartCountdownHandle) {
            let allStatuses = {};
            for (let p of (matchStartLobbyPlayers || [])) if (p && p.peerId) allStatuses[p.peerId] = 'ready';
            if (myPeerId) allStatuses[myPeerId] = 'ready';
            if (_matchStartPlayerStatuses) Object.assign(_matchStartPlayerStatuses, allStatuses);
            let cdPayload = { type: 'START_GAME_COUNTDOWN', seconds: 3, statuses: allStatuses, startSessionId: matchStartSessionId };
            connections.forEach(c => { if (c && c.peer) try { c.send(cdPayload); } catch { } });
            _startMatchCountdown(3);
        }
    } else if (type === 'START_GAME_COUNTDOWN' && !isHost) {
        let incomingSessionId = String((data && data.startSessionId) || '');
        if (incomingSessionId && matchStartSessionId && incomingSessionId !== matchStartSessionId) return;
        if (!gameStarted) return;
        matchStartWaitingForReady = true;
        // Update all player statuses so the list shows everyone as ready.
        if (data.statuses && typeof data.statuses === 'object') {
            if (!_matchStartPlayerStatuses) _matchStartPlayerStatuses = {};
            for (let pid in data.statuses) _matchStartPlayerStatuses[pid] = data.statuses[pid];
            _updateMatchLoadOverlayPlayers();
        }
        _startMatchCountdown(Math.max(1, Math.floor(Number((data && data.seconds) || 3))));
    } else if (type === 'START_GAME_ALL_READY' && !isHost) {
        let incomingSessionId = String((data && data.startSessionId) || '');
        if (incomingSessionId && matchStartSessionId && incomingSessionId !== matchStartSessionId) return;
        _stopMatchCountdown();
        matchStartWaitingForReady = false;
        _matchStartPlayerStatuses = null;
        setMatchLoadOverlay(false);
    } else if (type === 'SPECTATE_UNAVAILABLE' && !isHost) {
        pendingJoinAsSpectator = false;
        _setLobbyStatus(data.reason || 'Spectate unavailable right now.', '#fa4');
    } else if (type === 'MATCH_STATE_SNAPSHOT' && !isHost) {
        _guestReceiveSnapshot(conn, data);
    } else if (type === 'MATCH_STATE_SNAPSHOT_APPLIED' && isHost) {
        _markHostResyncAck(conn && conn.peer ? conn.peer : '', data && data.sessionId ? String(data.sessionId) : '');
    } else if (type === 'LOCKSTEP_RESYNC_PAUSE' && !isHost) {
        let active = !!(data && data.active);
        let sessionId = String((data && data.sessionId) || '');
        if (active) {
            if (!gameStarted) return;
            lockstepResyncPauseActive = true;
            if (sessionId) lockstepResyncSessionId = sessionId;
            if (!lockstepResyncRequestedAt) lockstepResyncRequestedAt = performance.now();
            waitingForRemoteSince = performance.now();
        } else if (sessionId && lockstepReceivedResyncSessionId === sessionId && lockstepAppliedResyncSessionId !== sessionId) {
            // The resume overtook our (still decoding) snapshot.
            lockstepPendingResumeSessionId = sessionId;
        } else {
            _guestResumeAfterResync(sessionId);
        }
    } else if (type === 'MATCH_ROLE_UPDATE' && isHost) {
        let role = normalizeMatchRole(data.role, '');
        if (gameStarted && role && conn && conn.peer) {
            matchRoleByPeerId[conn.peer] = role;
            let uid = getPeerProfileUid(conn.peer);
            if (uid) matchRoleByUid[uid] = role;

            // Treat explicit switch to spectating as an authoritative resignation signal.
            // This keeps resign working even if the client's lockstep resign action packet
            // is delayed or dropped during resync/tick-stall conditions.
            if (role === 'spectating') {
                let teamId = getTeamIdForPeer(conn.peer);
                let teammatesLeft = getActiveMatchPeerIds().some(other => other !== conn.peer && getTeamIdForPeer(other) === teamId);
                if (Number.isFinite(teamId) && teamId >= 0 && !resignedTeams.has(teamId) && !teammatesLeft && typeof queueAction === 'function') {
                    queueAction({ action: 'forceResignTeam', targetTeam: teamId });
                }
            }

            broadcastLobbyState(true);
            renderOnlineLobby();
        }
    } else if (type === 'DUPLICATE_UID_ACTIVE' && !isHost) {
        _clearGuestJoinTimeout();
        let reason = String(data.reason || 'This profile is already connected in another tab/window.');
        if (gameStarted) {
            // Mid-match the "other" connection is most likely our own old
            // one; the host drops it once it stays silent, so try again.
            try { conn.close(); } catch { }
            connections = connections.filter(c => c !== conn);
            scheduleGuestAutoReconnect(reason);
        } else {
            _returnToMainMenuWithStatus(reason, '#f66');
        }
    } else if (type === 'RETURN_TO_LOBBY') {
        if (Array.isArray(data.lobbyPlayers)) {
            lobbyPlayers = normalizeIncomingLobbyPlayers(data.lobbyPlayers);
        }
        returnToOnlineLobby(false, data.status || 'Returned to host lobby. Waiting for host to start...');
    } else if (type === 'PLAYER_REMOVED_FROM_MATCH') {
        let removedPeerId = String(data.peerId || '').trim();
        if (!removedPeerId) return;
        markPeerRemovedFromMatch(removedPeerId);
        if (removedPeerId === myPeerId) {
            _setLobbyStatus('Host removed you from this match.', '#f66');
            if (guestReconnectTimer) { clearTimeout(guestReconnectTimer); guestReconnectTimer = null; }
            if (gameStarted && !gameOver) {
                if (!localDefeated) enterSpectateMode('defeated');
                netHostUnreachable = false;
            }
        }
        updateInfoPanel();
    }
}

// Guest: a resync snapshot arrived; decode, apply, acknowledge.
function _guestReceiveSnapshot(conn, data) {
    if (!gameStarted) return;
    if (lockstepStrictDebugMode) {
        stopLockstepDebugMatch('match snapshot received in exact lockstep mode', { tick: currentTick, sessionId: String((data && data.sessionId) || '') });
        return;
    }
    pendingJoinAsSpectator = false;
    let sid = String((data && data.sessionId) || '');
    if (sid && sid === lockstepAppliedResyncSessionId) {
        // Sent again (we asked, or the host could not tell we had it):
        // acknowledge without restoring a second time.
        try { conn.send({ type: 'MATCH_STATE_SNAPSHOT_APPLIED', sessionId: sid, tick: currentTick }); } catch { }
        return;
    }
    lockstepReceivedResyncSessionId = sid;
    lockstepResyncPauseActive = true;
    if (sid) lockstepResyncSessionId = sid;
    if (!lockstepResyncRequestedAt) lockstepResyncRequestedAt = performance.now();
    let payload = data.payload || (data.snapshot ? { json: JSON.stringify(data.snapshot) } : null);
    netDecodeSnapshotPayload(payload).then(text => {
        // A newer resync superseded this one while it decoded.
        if (lockstepReceivedResyncSessionId !== sid) return;
        if (!text) throw new Error('empty snapshot');
        let t0 = performance.now();
        applyAuthoritativeStateSnapshot(JSON.parse(text));
        netCounters.snapshotApplyMs = performance.now() - t0;
        netCounters.snapshotBytes = netSnapshotPayloadBytes(payload);
        netCounters.lastSnapshotAt = performance.now();
        netCounters.hardResyncs++;
        lockstepAppliedResyncSessionId = sid;
        lockstepResyncRequestedAt = performance.now();
        let hostConn = netGetHostConnection();
        if (hostConn && sid) {
            try { hostConn.send({ type: 'MATCH_STATE_SNAPSHOT_APPLIED', sessionId: sid, tick: currentTick }); } catch { }
        }
        if (!sid || lockstepPendingResumeSessionId === sid) _guestResumeAfterResync(sid);
    }).catch(err => {
        logLockstepWarning('Failed to apply resync snapshot; asking again', { error: String(err && err.message || err) });
        lockstepResyncRequestedAt = 0;
        requestHardLockstepResync(currentTick, 'snapshot apply failed');
    });
}

// Host: the same profile is joining under a new peer id while its old peer
// still looks connected. That is either a second tab, or the same player back
// after a crash or network switch whose old connection the browser has not
// noticed is dead yet (WebRTC can take ~30s). A live peer keeps talking (pings,
// tick packets), so probe the old ones and decide once they had time to answer.
const DUPLICATE_JOIN_PROBE_MS = 2500;
let _duplicateJoinProbeByPeer = {};

function _hostResolveDuplicateJoin(conn, data, oldPeerIds) {
    let reject = () => {
        try { conn.send({ type: 'DUPLICATE_UID_ACTIVE', reason: 'This profile is already connected in another tab/window.' }); } catch { }
        setTimeout(() => { try { conn.close(); } catch { } }, 200);
    };
    if (!conn || !conn.peer || oldPeerIds.includes(myPeerId)) { reject(); return; }
    if (_duplicateJoinProbeByPeer[conn.peer]) return;
    let epoch = networkSessionEpoch;
    let probeAt = performance.now();
    _duplicateJoinProbeByPeer[conn.peer] = true;
    for (let pid of oldPeerIds) {
        for (let c of connections) {
            if (c && c.peer === pid) { try { c.send({ type: 'NET_PING', seq: nextNetworkPingSeq++, t: probeAt, report: null }); } catch { } }
        }
    }
    setTimeout(() => {
        delete _duplicateJoinProbeByPeer[conn.peer];
        if (epoch !== networkSessionEpoch || !isHost || !connections.includes(conn)) return;
        // Messages already in flight when the old peer died land early in the
        // window; a live peer keeps sending through its second half as well.
        let liveAfter = probeAt + DUPLICATE_JOIN_PROBE_MS * 0.5;
        let live = oldPeerIds.some(pid => {
            if (!connections.some(c => c && c.peer === pid)) return false;
            let link = netGetLinkStats(pid);
            return !!link && link.lastHeardAt > liveAfter;
        });
        if (live) { reject(); return; }
        for (let pid of oldPeerIds) {
            logLockstepWarning('Replacing a silent connection of a rejoining player', { oldPeerId: pid, newPeerId: conn.peer });
            let stale = connections.filter(c => c && c.peer === pid);
            connections = connections.filter(c => !stale.includes(c));
            peerPresenceById[pid] = false;
            delete pendingPingByPeerId[pid];
            if (lockstepResyncPauseActive && lockstepResyncPendingAckByPeer && Object.prototype.hasOwnProperty.call(lockstepResyncPendingAckByPeer, pid)) {
                delete lockstepResyncPendingAckByPeer[pid];
                if (_isHostResyncPauseComplete()) _finishHostResyncPause('stale peer replaced');
            }
            for (let c of stale) { try { c.close(); } catch { } }
        }
        _hostHandleLobbyJoin(conn, data);
    }, DUPLICATE_JOIN_PROBE_MS);
}

// Host: a client (re)joined the lobby, or a running match.
function _hostHandleLobbyJoin(conn, data) {
    if (conn && conn.peer) peerPresenceById[conn.peer] = true;
    if (conn && conn.peer) netNotePeerCapabilities(conn.peer, data && data.caps);
    let joiningUid = String((data && data.uid) || peerUidByPeerId[conn.peer] || conn.peer || '').trim();
    if (joiningUid) {
        let migration = migratePeerIdByUid(joiningUid, conn.peer);
        if (migration.hasActiveDuplicate) {
            _hostResolveDuplicateJoin(conn, data, migration.activePeerIds);
            return;
        }
        peerUidByPeerId[conn.peer] = joiningUid;
    }
    if (gameStarted && isPeerExplicitlyRemoved(conn.peer)) {
        conn.send({ type: 'PLAYER_REMOVED_FROM_MATCH', peerId: conn.peer, teamId: getTeamIdForPeer(conn.peer) });
        return;
    }
    if (gameStarted) {
        let knownRole = normalizeMatchRole(matchRoleByPeerId[conn.peer], '');
        if (!knownRole && joiningUid) knownRole = normalizeMatchRole(matchRoleByUid[joiningUid], '');
        if (knownRole) {
            matchRoleByPeerId[conn.peer] = knownRole;
            if (joiningUid) matchRoleByUid[joiningUid] = knownRole;
            delete netDisconnectedSinceByPeer[conn.peer];
            let resumeTick = Math.floor(Number(data && data.resumeTick));
            let sameMatch = String((data && data.sessionId) || '') === String(matchStartSessionId || '');
            if (sameMatch && data && data.migrate && resumeTick >= 0) {
                // Its bundles came from another host: a snapshot of ours
                // replaces them and lines it up with everyone else.
                _startHostResyncPause('host migration: ' + conn.peer, false, { requester: conn.peer });
                broadcastLobbyState(true);
                renderOnlineLobby();
                return;
            }
            let canResume = sameMatch && Number.isFinite(resumeTick) && resumeTick >= 0 && !lockstepResyncPauseActive
                && resumeTick <= currentTick + 1 + LOCKSTEP_HOST_PREBUILD_TICKS
                && (resumeTick >= currentTick || !!lockstepHistoryByTick[resumeTick]);
            // A client ahead of us must have run only ticks we sealed: we
            // would wait forever for its packets for the others.
            for (let t = currentTick; canResume && t < resumeTick; t++) {
                if (!lockstepBundleByTick[t]) canResume = false;
            }
            if (canResume) {
                // Soft rejoin: the client still has the match; replay the
                // sealed ticks it missed instead of a full snapshot.
                netCounters.softRejoins++;
                conn.send({
                    type: 'REJOIN_RESUME',
                    tick: resumeTick,
                    lobbyPlayers: lobbyPlayers.map(p => ({ peerId: p.peerId, name: p.name, color: normalizeLobbyColor(p.color), uid: p.uid || '' })),
                    roleByPeer: buildHostRoleSnapshot(),
                    presenceByPeer: buildHostPresenceSnapshot()
                });
                for (let t = resumeTick; ; t++) {
                    let resend = getHostResendBundleForTick(t);
                    if (!resend) break;
                    try { conn.send({ type: 'TICK_BUNDLE', bundle: resend.bundle, c: 1 }); } catch { }
                }
            } else {
                hostSendFullMatchSync(conn, knownRole);
            }
            broadcastLobbyState(true);
            renderOnlineLobby();
            return;
        }
        let used = new Set(lobbyPlayers.map(p => normalizeLobbyColor(p.color)));
        let firstFree = TEAM_PRESET_COLORS.find(c => !used.has(c)) || TEAM_PRESET_COLORS[(lobbyPlayers.length) % TEAM_PRESET_COLORS.length];
        let existing = lobbyPlayers.find(p => p.peerId === conn.peer);
        if (existing) {
            existing.name = (data.name || existing.name || defaultLobbyName(conn.peer)).slice(0, 24);
            existing.color = normalizeLobbyColor(data.color || existing.color || firstFree);
            if (joiningUid) existing.uid = joiningUid;
        } else {
            lobbyPlayers.push({ peerId: conn.peer, name: (data.name || defaultLobbyName(conn.peer)).slice(0, 24), color: normalizeLobbyColor(data.color || firstFree), uid: joiningUid });
        }
        matchRoleByPeerId[conn.peer] = 'spectating';
        if (joiningUid) matchRoleByUid[joiningUid] = 'spectating';
        broadcastLobbyState(true);
        renderOnlineLobby();
        return;
    }
    let used = new Set(lobbyPlayers.filter(p => p.peerId !== conn.peer).map(p => normalizeLobbyColor(p.color)));
    let firstFree = TEAM_PRESET_COLORS.find(c => !used.has(c)) || TEAM_PRESET_COLORS[(lobbyPlayers.length) % TEAM_PRESET_COLORS.length];
    let existing = lobbyPlayers.find(p => p.peerId === conn.peer);
    if (existing) {
        existing.name = (data.name || existing.name || defaultLobbyName(conn.peer)).slice(0, 24);
        existing.color = normalizeLobbyColor(data.color || existing.color || firstFree);
        if (joiningUid) existing.uid = joiningUid;
    } else {
        lobbyPlayers.push({ peerId: conn.peer, name: (data.name || defaultLobbyName(conn.peer)).slice(0, 24), color: normalizeLobbyColor(data.color || firstFree), uid: joiningUid });
    }
    _setLobbyStatus('Lobby updated');
    broadcastLobbyState(true);
    renderOnlineLobby();
}

function copyGameLink() {
    if (!myPeerId) return;
    let url = buildInviteUrl(wsRoomId || myPeerId);
    if (!url) return;
    navigator.clipboard.writeText(url).then(() => {
        let msg = document.getElementById('invite-msg');
        msg.style.display = 'block'; setTimeout(() => msg.style.display = 'none', 2000);
    }).catch(() => prompt("Copy this URL:", url));
}

function setLobbyMode(mode) {
    let lobby = document.getElementById('lobby');
    let settings = document.getElementById('lobby-settings');
    let buttons = document.getElementById('lobby-buttons');
    let waiting = document.getElementById('lobby-waiting');
    let copyBtn = document.getElementById('btn-copy-link');
    let startBtn = document.getElementById('btn-start-online');
    let spectateBtn = document.getElementById('btn-spectate-online');
    let onlineBtn = document.getElementById('btn-online');

    if (!lobby || !settings || !buttons || !waiting) return;

    lobby.style.display = 'flex';
    lobbyUiMode = mode;
    let leaveBtn = document.getElementById('btn-lobby-leave');
    if (leaveBtn) {
        leaveBtn.style.display = mode === 'main' ? 'none' : 'inline-block';
        leaveBtn.textContent = mode === 'host' ? 'Close Lobby' : 'Leave';
    }
    if (mode === 'main') {
        settings.style.display = 'flex';
        buttons.style.display = 'flex';
        waiting.style.display = 'none';
        if (onlineBtn) onlineBtn.disabled = false;
        if (spectateBtn) spectateBtn.style.display = 'none';
        return;
    }

    waiting.style.display = 'block';
    buttons.style.display = 'none';
    if (mode === 'host') {
        // Host uses the exact same settings panel as the main menu.
        settings.style.display = 'flex';
        if (copyBtn) copyBtn.style.display = 'inline-block';
        if (startBtn) startBtn.style.display = 'inline-block';
        if (spectateBtn) spectateBtn.style.display = 'none';
    } else {
        settings.style.display = 'none';
        if (copyBtn) copyBtn.style.display = 'none';
        if (startBtn) startBtn.style.display = 'none';
        updateSpectateButtonVisibility();
    }
}

function resetWorldState() {
    visibilityHistoryState = null;
    // Clear all world/runtime objects so no match state carries over.
    towers = [];
    units = [];
    projectiles = [];
    particles = [];
    barracks = [];
    collectorSpawners = [];
    collectors = [];
    droppedItems = [];
    droppedItemGrid = [];
    goldMines = [];
    astarMines = [];
    initTileEntityLookup();
    areas = [];
    resetAreaDistanceCaches();
    grid = [];
    visibilityGrid = [];
    visibilityGridByPlayer = Array.from({ length: players.length }, () => []);
    visibilityVersion = 0;
    if (typeof visibilityGridRawByPlayerCache !== 'undefined' && visibilityGridRawByPlayerCache && typeof visibilityGridRawByPlayerCache.clear === 'function') {
        visibilityGridRawByPlayerCache.clear();
    }
    visibilityCacheTick = -1;

    selectedUnits = [];
    selectedEntities = [];
    selectionBox = null;
    isBoxSelecting = false;
    activeSubGroups = {};
    controlGroups = {};
    popupControlGroups = {};
    activePopupControlGroupKey = '';
    mapAlerts = [];
    controlGroupAlertState = {};

    localInputBuffer = {};
    lockstepLocalPacketByTick = {};
    lockstepHostPacketsByTick = {};
    lockstepBundleByTick = {};
    lockstepCommittedByTick = {};
    lockstepBundleAckByTick = {};
    lockstepLastPacketSentAtByTick = {};
    lockstepLastBundleSentAtByTick = {};
    lockstepLastFinalizeSentAtByTick = {};
    lockstepLastResendRequestAtByTick = {};
    lockstepHostHardResyncRequestedByTick = {};
    nextLocalActionSeq = 1;
    waitingForRemoteSince = 0;
    lockstepLastHardResyncRequestAt = 0;
    lockstepHardResyncInFlightUntil = 0;
    lockstepPostSnapshotGraceUntilAt = 0;
    lockstepSnapshotLastSentAtByPeer = {};
    lockstepResyncPauseActive = false;
    lockstepResyncSessionId = '';
    lockstepResyncPendingAckByPeer = {};
    lockstepResyncSnapshotCache = null;
    lockstepResyncResumeTick = -1;
    lockstepResyncRequestedAt = 0;
    lockstepResyncDeadlineAt = 0;
    lockstepReceivedResyncSessionId = '';
    lockstepAppliedResyncSessionId = '';
    lockstepPendingResumeSessionId = '';
    lockstepHighestSentLocalTick = -1;
    lockstepHostWaitRequestByPeer = {};
    lockstepGuestWaitRequest = null;
    lockstepPendingBundleByTick = {};
    lockstepPendingCommitByTick = {};
    lockstepFatalStopActive = false;
    // Presence, roles and latency describe the session, not the world: a
    // match start keeps them (link measurements feed the input delay).
    lockstepHistoryByTick = {};
    lockstepExpectedStateHashByTick = {};
    lockstepLocalStateHashByTick = {};
    lockstepExpectedStateDigestByTick = {};
    lockstepLocalStateDigestByTick = {};
    lockstepDesyncDetected = false;
    lockstepHashGraceUntilTick = -1;
    matchStartSessionId = '';
    matchStartWaitingForReady = false;
    matchStartExpectedReadyPeerIds = [];
    matchStartReadyByPeerId = {};
    currentTick = 0;
    gameTime = 0;
    nextUnitId = 1;
    pathfindBudget = 0;
    pendingPathResolveCursor = 0;
    pathTopologyVersion = 1;
    sharedPathCache.clear();
    sharedSpawnerRouteCache.clear();
    resetSimulationTickCaches();
    resetEnergyDeltaTracking();
    resetNetCounters();
    resetHostMigrationState();
    netDisconnectedSinceByPeer = {};
    netWaitingSinceByPeer = {};
    netStallStartedAt = 0;
    netStallSamples = [];
    netAutoExtraTicks = 0;
    netHostUnreachable = false;
    netUpdateWaitingOverlay(0, true);

    initSpatialHash();
    initGrid();
    dirtyGrid = true;
    dirtyAreas = true;
    invalidateStaticLayerCache();
    setMatchLoadOverlay(false);
}

function returnToOnlineLobby(asHost, statusText) {
    gameStarted = false;
    gameOver = false;
    winner = -1;
    localDefeated = false;
    spectateMode = 'none';
    selectedBuildItem = null;
    selectedUnits = [];
    selectedEntities = [];
    activeSubGroups = {};
    attackMoveMode = false;
    removedFromMatchPeerIds = new Set();
    guestReconnectAttempt = 0;
    if (guestReconnectTimer) {
        clearTimeout(guestReconnectTimer);
        guestReconnectTimer = null;
    }
    remoteMatchRunning = false;
    pendingJoinAsSpectator = false;
    matchRoleByPeerId = {};
    matchRoleByUid = {};
    // Keep profile ids of players still connected; reconnects rely on them.
    let keptUids = {};
    for (let c of connections) if (c && c.peer && peerUidByPeerId[c.peer]) keptUids[c.peer] = peerUidByPeerId[c.peer];
    if (myPeerId && peerUidByPeerId[myPeerId]) keptUids[myPeerId] = peerUidByPeerId[myPeerId];
    peerUidByPeerId = keptUids;
    matchStartSessionId = '';
    matchStartWaitingForReady = false;
    matchStartExpectedReadyPeerIds = [];
    matchStartReadyByPeerId = {};
    if (asHost) {
        duplicateUidBlocked = false;
        duplicateUidBlockReason = '';
    }
    resetWorldState();
    let go = document.getElementById('game-over');
    if (go) go.style.display = 'none';
    setLobbyMode(asHost ? 'host' : 'guest');
    let st = document.getElementById('lobby-status');
    if (st) st.textContent = statusText || (asHost ? 'Lobby ready. Configure settings and start when ready.' : 'Waiting for host to start...');
    renderOnlineLobby();
    requestBuildMenuRefresh();
    updateInfoPanel();
    updateSpectateButtonVisibility();
}

function hostPlayAgain() {
    if (!isHost || !isMultiplayer) return;
    let payloadPlayers = lobbyPlayers.map(p => ({ peerId: p.peerId, name: p.name, color: normalizeLobbyColor(p.color) }));
    connections.forEach(c => c.send({ type: 'RETURN_TO_LOBBY', lobbyPlayers: payloadPlayers, status: 'Host returned everyone to lobby.' }));
    returnToOnlineLobby(true, 'Returned to lobby. Configure settings and press Start Game.');
}

function readNetAutoFromMenu() {
    let el = document.getElementById('cfg-net-auto');
    return el ? !!el.checked : true;
}

// Grey out the manual timing fields while Auto is on.
function syncNetAutoMenuState() {
    let auto = readNetAutoFromMenu();
    for (let id of ['cfg-tick-rate', 'cfg-pipeline-delay']) {
        let el = document.getElementById(id);
        if (!el) continue;
        el.disabled = auto;
        if (el.style) el.style.opacity = auto ? '0.45' : '';
        el.title = auto ? 'Automatic: set from measured ping and stability during the match.' : (id === 'cfg-tick-rate' ? 'Game ticks per second' : 'Minimum lockstep pipeline delay in ticks');
        let row = typeof el.closest === 'function' ? el.closest('.lobby-setting-row') : null;
        if (row && row.style) row.style.opacity = auto ? '0.6' : '';
    }
    if (!gameStarted) netAutoEnabled = auto;
    if (isHost && !gameStarted) broadcastLobbyState(true);
}

function hostOnlineGame() {
    isHost = true;
    duplicateUidBlocked = false;
    duplicateUidBlockReason = '';
    remoteMatchRunning = false;
    netAutoEnabled = readNetAutoFromMenu();
    _clearGuestJoinTimeout();
    setLobbyMode('host');
    document.getElementById('lobby-status').textContent = 'Creating game...';
    document.getElementById('btn-online').disabled = true;
    let startBtn = document.getElementById('btn-start-online');
    startBtn.style.display = 'inline-block';
    startBtn.disabled = true;
    initPeer({ mode: 'host', peerId: generateGameSessionId() }, id => {
        let myName = setLocalPreferredName(localPreferredName || defaultLobbyName(id));
        lobbyPlayers = [{ peerId: id, name: myName, color: TEAM_PRESET_COLORS[0], uid: (localPersistentPeerId || id) }];
        peerPresenceById = { [id]: true };
        peerUidByPeerId[id] = localPersistentPeerId || id;
        // Update URL with game ID (without reloading)
        const inviteUrl = buildInviteUrl(id);
        if (inviteUrl) {
            window.history.replaceState({}, '', inviteUrl);
        }
        document.getElementById('lobby-status').textContent = 'Lobby created. Waiting for players...';
        document.getElementById('btn-copy-link').style.display = 'inline-block';
        renderOnlineLobby();
    });
}

function startHostedGame() {
    if (!isHost || connections.length === 0) return;
    let connectedPeerIds = connections
        .filter(c => c && c.peer)
        .map(c => String(c.peer));
    let lobbyPeerSet = new Set((lobbyPlayers || []).map(p => String((p && p.peerId) || '')));
    let missingPeers = connectedPeerIds.filter(pid => !!pid && !lobbyPeerSet.has(pid));
    if (missingPeers.length > 0) {
        document.getElementById('lobby-status').textContent = 'Still syncing lobby players. Please wait a moment and press Start again.';
        return;
    }
    let preSetup = computeTeamSetupFromLobby();
    if (preSetup.activeTeamIds.length < 2) {
        document.getElementById('lobby-status').textContent = 'Need at least 2 different team colors to start.';
        return;
    }
    let startBtn = document.getElementById('btn-start-online');
    startBtn.disabled = true;
    document.getElementById('lobby-status').textContent = 'Starting game...';

    // Initialize session/player metadata immediately so we can broadcast a prepare signal to clients
    // before the heavy world-generation work begins.
    matchStartSessionId = generateGameSessionId();
    let connectedSet = new Set(connectedPeerIds);
    matchStartLobbyPlayers = lobbyPlayers.filter(p => p && (p.peerId === myPeerId || connectedSet.has(String(p.peerId)))).map(p => ({
        peerId: p.peerId, name: p.name,
        color: normalizeLobbyColor(p.color),
        uid: String((p && p.uid) || getPeerProfileUid(p && p.peerId) || '')
    }));

    // Build per-player status map. Host starts as 'preparing'; clients are 'preparing' until they load.
    _matchStartPlayerStatuses = {};
    for (let p of matchStartLobbyPlayers) {
        if (p && p.peerId) _matchStartPlayerStatuses[p.peerId] = 'preparing';
    }

    // Show the overlay on the host immediately.
    setMatchLoadOverlay(true, 'Preparing Match', 'Generating world and synchronizing data\u2026');

    // Tell clients to show their overlay right away (before the snapshot even arrives).
    let preparePayload = {
        type: 'START_GAME_PREPARE',
        sessionId: matchStartSessionId,
        startSessionId: matchStartSessionId,
        lobbyPlayers: matchStartLobbyPlayers
    };
    let sendPreparePayload = () => {
        connections.forEach(c => { if (c && c.peer) try { c.send(preparePayload); } catch { } });
    };
    sendPreparePayload();

    // Yield once so the loading overlay can paint before heavy world generation begins.
    setTimeout(() => {
        try {
            readConfigFromMenu();
            // Run the host's config through the same transport path guests
            // use, so both sides normalize it identically.
            let menuTickRate = TICK_RATE, menuPipeline = LOCKSTEP_PIPELINE_MIN, menuStrict = lockstepStrictDebugMode;
            applyEditableRuntimeConfigObject(serializeEditableRuntimeConfigForTransport(), { fromTransport: true });
            applyTimingConfig(menuTickRate, menuPipeline);
            lockstepStrictDebugMode = menuStrict;
            gameSeed = Date.now();
            // matchStartSessionId and matchStartLobbyPlayers already set above.
            removedFromMatchPeerIds = new Set();
            lockstepHistoryByTick = {};
            matchRoleByPeerId = {};
            matchRoleByUid = {};
            for (let p of matchStartLobbyPlayers) {
                if (!p || !p.peerId) continue;
                matchRoleByPeerId[p.peerId] = 'playing';
                let uid = getPeerProfileUid(p.peerId);
                if (uid) matchRoleByUid[uid] = 'playing';
            }
            matchStartExpectedReadyPeerIds = matchStartLobbyPlayers
                .map(p => (p && p.peerId) ? String(p.peerId) : '')
                .filter(pid => !!pid && pid !== myPeerId && normalizeMatchRole(matchRoleByPeerId[pid], '') === 'playing');
            matchStartReadyByPeerId = {};
            for (let pid of matchStartExpectedReadyPeerIds) matchStartReadyByPeerId[pid] = false;
            // matchStartWaitingForReady is set AFTER startGame() because resetWorldState() (called
            // inside startGame()) clears it back to false. Setting it here would be overwritten.
            matchStartConfig = {
                gridW: GRID_W,
                gridH: GRID_H,
                goldCount: GOLD_MINE_COUNT,
                goldMin: GOLD_MINE_MIN,
                goldMax: GOLD_MINE_MAX,
                goldArea: GOLD_MINE_AREA,
                fullVis: fullVisibility,
                teamHistory: teamVisibilityHistory,
                gameMode: gameMode,
                maxPop: CONFIG_MAX_POP,
                startingMoney: STARTING_MONEY,
                startingAstar: STARTING_ASTAR,
                mapType: MAP_TYPE,
                tickRate: TICK_RATE,
                pipelineDelay: LOCKSTEP_PIPELINE_MIN,
                netAuto: !!netAutoEnabled,
                exactLockstep: !!lockstepStrictDebugMode,
                thingStatsRecalcIntervalSeconds: THING_STATS_RECALC_INTERVAL_SECONDS,
                unitEffectiveStatsRecalcTicks: UNIT_EFFECTIVE_STATS_RECALC_TICKS,
                astarIterBudgetPerPlayerTick: ASTAR_ITER_BUDGET_PER_PLAYER_TICK,
                workerAiTickDelay: WORKER_AI_TICK_DELAY,
                researchCostExp: RESEARCH_COST_EXP,
                researchWorkExp: RESEARCH_WORK_EXP,
                researchWorkBase: RESEARCH_WORK_BASE,
                researchBonusExpUnits: RESEARCH_BONUS_EXP_UNITS,
                researchBonusExpOther: RESEARCH_BONUS_EXP_OTHER,
                researchBonusExpOtherHousePopCap: RESEARCH_BONUS_EXP_OTHER_HOUSE_POPCAP,
                maxThingLevel: MAX_THING_LEVEL,
                maxResearchLevel: MAX_RESEARCH_LEVEL,
                startingResources: cloneStartingResourcesConfig(),
                editableConfig: serializeEditableRuntimeConfigForTransport(),
            };
            let setup = preSetup;
            activeTeamIds = setup.activeTeamIds;
            teamColorById = setup.teamColorById;
            localPlayerId = resolveLocalPlayerTeamId(setup);
            isMultiplayer = true;

            // Save the startup tracking vars before startGame(), because resetWorldState() (called
            // inside startGame()) clears matchStartSessionId, matchStartExpectedReadyPeerIds,
            // matchStartReadyByPeerId, and matchStartWaitingForReady.
            let _savedSessionId = matchStartSessionId;
            let _savedExpectedPeerIds = matchStartExpectedReadyPeerIds.slice();
            let _savedReadyByPeerId = { ...matchStartReadyByPeerId };

            initAudio();
            startGame();

            // Restore the startup tracking state that resetWorldState() wiped.
            matchStartSessionId = _savedSessionId;
            matchStartExpectedReadyPeerIds = _savedExpectedPeerIds;
            matchStartReadyByPeerId = _savedReadyByPeerId;
            matchStartWaitingForReady = _savedExpectedPeerIds.length > 0;

            // Host world is generated — mark host as ready in the status map.
            if (_matchStartPlayerStatuses && myPeerId) _matchStartPlayerStatuses[myPeerId] = 'ready';

            // Terrain travels too: guests must not depend on generating the
            // exact same map (floating-point differences between browsers).
            let startSnapshotText = JSON.stringify(buildHostAuthoritativeStateSnapshot({
                includeConfig: false,
                includeStaticMapState: true,
                includeGridTypes: true
            }));
            // Guests restore this snapshot over their generated world; the host
            // restores the same text so the match starts identical everywhere
            // (fields the snapshot rebuilds would otherwise differ on the host).
            applyAuthoritativeStateSnapshot(JSON.parse(startSnapshotText));
            let startSessionId = matchStartSessionId;
            let matchPeerIds = new Set(matchStartLobbyPlayers.map(p => String(p.peerId || '')));
            netEncodeSnapshotText(startSnapshotText).then(payload => {
                if (!gameStarted || matchStartSessionId !== startSessionId) return;
                netCounters.snapshotBytes = netSnapshotPayloadBytes(payload);
                let msg = {
                    type: 'START_GAME', seed: gameSeed,
                    startSessionId,
                    lobbyPlayers: matchStartLobbyPlayers,
                    roleByPeer: buildHostRoleSnapshot(),
                    presenceByPeer: buildHostPresenceSnapshot(),
                    cfg: matchStartConfig,
                    snapshotPayload: payload
                };
                for (let c of connections) {
                    // Players who joined after the start was pressed stay in
                    // the lobby and may spectate.
                    if (!c || !c.peer || !matchPeerIds.has(String(c.peer))) continue;
                    try { c.send({ ...msg, snapshotPayload: netSnapshotPayloadForPeer(c.peer, payload, startSnapshotText) }); } catch { }
                }
                broadcastLobbyState(true);
            });
            _armMatchStartReadyTimeout(startSessionId);

            if (matchStartWaitingForReady) {
                // Show the player-list overlay; host clicks "Start Game" when all are ready.
                setMatchLoadOverlay(true, 'Waiting for Players', 'Waiting for players to load\u2026');
            } else {
                // Solo — nobody to wait for, start immediately.
                _matchStartPlayerStatuses = null;
                setMatchLoadOverlay(false);
            }
        } catch (err) {
            console.error('[STARTUP] Failed to start hosted game', err);
            _matchStartPlayerStatuses = null;
            setMatchLoadOverlay(false);
            startBtn.disabled = false;
            let st = document.getElementById('lobby-status');
            if (st) {
                st.textContent = 'Failed to start game. Check console and try again.';
                st.style.color = '#f66';
            }
        }
    }, 0);
}

function joinGame(hostId, opts = null) {
    if (!hostId) return;
    if (duplicateUidBlocked) {
        setLobbyMode('guest');
        let st = document.getElementById('lobby-status');
        if (st) {
            st.textContent = duplicateUidBlockReason || 'This profile is already connected in another tab/window.';
            st.style.color = '#f66';
        }
        updateSpectateButtonVisibility();
        return;
    }
    let rejoin = !!(opts && opts.rejoin);
    isHost = false;
    // The silence watchdog measures from this join, not from whenever we
    // last heard this peer (possibly in another role).
    let joinLink = netLinkStatsByPeer[String(hostId)];
    if (joinLink) joinLink.lastHeardAt = performance.now();
    _guestLeavingLobby = false;
    if (!rejoin) {
        pendingJoinAsSpectator = false;
        remoteMatchRunning = false;
        setLobbyMode('guest');
        document.getElementById('btn-copy-link').style.display = 'none';
        document.getElementById('btn-start-online').style.display = 'none';
    }
    _setLobbyStatus(rejoin ? 'Reconnecting to host...' : 'Connecting to host...', '#4af');
    let previousPeerId = myPeerId;
    let reuseId = rejoin && !(opts && opts.freshId) ? myPeerId : undefined;
    _armGuestJoinTimeout(hostId, rejoin);
    initPeer({ mode: 'guest', roomId: hostId, peerId: reuseId, joinOpts: opts }, () => {
        let me = (lobbyPlayers || []).find(p => p && (p.peerId === myPeerId || (previousPeerId && p.peerId === previousPeerId)));
        if (!rejoin || !me) {
            lobbyPlayers = [{ peerId: myPeerId, name: setLocalPreferredName(localPreferredName || defaultLobbyName(myPeerId)), color: '' }];
            me = lobbyPlayers[0];
        } else if (me.peerId !== myPeerId) {
            me.peerId = myPeerId;
        }
        peerPresenceById = { ...peerPresenceById, [myPeerId]: true };
        clearPeerRemovedFromMatch(myPeerId);
        if (!gameStarted) renderOnlineLobby();
        // A reloaded page may know the match moved (or that it hosted it).
        if (!rejoin && joinWithMatchRecord(hostId)) return;
        let migrate = !!(opts && opts.migrate);
        // Moving the match: say which successors we found unreachable.
        let failed = migrate && hostMigration ? hostMigration.candidates.slice(0, hostMigration.index) : [];
        let conn = peer.connect(hostId, { metadata: { migrate, sessionId: gameStarted ? matchStartSessionId : '', failed } });
        setupConnection(conn);
        let sendLobbyJoin = () => {
            if (!conn.open) return;
            let desiredRole = (gameStarted && (localDefeated || spectateMode !== 'none')) ? 'spectating' : 'playing';
            conn.send({
                type: 'LOBBY_JOIN', name: me.name, color: me.color || null, desiredRole, uid: localPersistentPeerId || myPeerId,
                caps: netLocalCapabilities(),
                migrate,
                // A client that still runs the match can resume from its tick.
                resumeTick: gameStarted ? currentTick : -1,
                sessionId: gameStarted ? matchStartSessionId : ''
            });
        };
        conn.on('open', () => {
            sendLobbyJoin();
            if (guestReconnectTimer) {
                clearTimeout(guestReconnectTimer);
                guestReconnectTimer = null;
            }
            if (!gameStarted) _setLobbyStatus('Connected! Waiting for host to start...', '#4af');
            updateSpectateButtonVisibility();
        });
    });
}

let _guestJoinTimeoutHandle = null;
let _guestLeavingLobby = false;
let lobbyUiMode = 'main';

function _clearGuestJoinTimeout() {
    if (_guestJoinTimeoutHandle) clearTimeout(_guestJoinTimeoutHandle);
    _guestJoinTimeoutHandle = null;
}

// A link to a game that no longer exists must not leave the player stuck on
// "Connecting...": give up after a while and go back to the menu.
function _armGuestJoinTimeout(hostId, rejoin) {
    _clearGuestJoinTimeout();
    _guestJoinTimeoutHandle = setTimeout(() => {
        _guestJoinTimeoutHandle = null;
        if (isHost || String(wsHostId || '') !== String(hostId || '')) return;
        let hostConn = netGetHostConnection();
        if (hostConn && hostConn.open !== false && (gameStarted || lobbyPlayers.length > 1)) return;
        if (gameStarted) {
            // Mid-match: let the reconnect loop keep trying. Untracked first,
            // so closing it does not count as a second failure.
            connections = connections.filter(c => c !== hostConn);
            try { if (hostConn) hostConn.close(); } catch { }
            scheduleGuestAutoReconnect('Host not reachable');
            return;
        }
        if (tryRecoverMatchFromRecord(hostId)) return;
        _returnToMainMenuWithStatus('Could not reach the game host. The game may have ended or the link is wrong.', '#f66');
    }, rejoin ? _guestRejoinTimeoutMs() : 15000);
}

// A reconnect attempt that has not opened by now went into a dead route.
// Opening takes a few round trips (signaling, ICE, DTLS), so slow links get
// longer before the attempt is abandoned for a fresh one.
function _guestRejoinTimeoutMs() {
    let link = netGetLinkStats(wsHostId);
    let rtt = link ? netRttBudgetMs(link) : NaN;
    return Number.isFinite(rtt) ? Math.max(3000, Math.min(10000, rtt * 8)) : 5000;
}

function _clearInviteParamsFromUrl() {
    try {
        let url = new URL(window.location.href);
        if (!url.searchParams.has('game') && !url.searchParams.has('room')) return;
        url.searchParams.delete('game');
        url.searchParams.delete('room');
        window.history.replaceState({}, '', url.toString());
    } catch { }
}

// Tear down the online session and show the main menu (play solo / online).
function _returnToMainMenuWithStatus(statusText = '', color = '#fa4') {
    _clearGuestJoinTimeout();
    _stopMatchCountdown();
    _matchStartPlayerStatuses = null;
    if (guestReconnectTimer) { clearTimeout(guestReconnectTimer); guestReconnectTimer = null; }
    guestReconnectAttempt = 0;
    networkSessionEpoch++;
    let oldPeer = peer;
    peer = null;
    let oldConnections = connections;
    connections = [];
    for (let c of oldConnections) { try { c.close(); } catch { } }
    try { if (oldPeer) oldPeer.destroy(); } catch { }
    let wasInMatch = gameStarted;
    isHost = false;
    isMultiplayer = false;
    lobbyPlayers = [];
    matchStartLobbyPlayers = [];
    peerPresenceById = {};
    remotePresenceByPeerId = {};
    remoteRoleByPeerId = {};
    remoteLatencyByPeerId = {};
    remoteMatchRunning = false;
    pendingJoinAsSpectator = false;
    wsHostId = null;
    wsRoomId = null;
    resetNetQualityState();
    if (wasInMatch) {
        gameStarted = false;
        gameOver = false;
        winner = -1;
        localDefeated = false;
        spectateMode = 'none';
        resetWorldState();
        if (typeof stopBackgroundMusic === 'function') { try { stopBackgroundMusic(); } catch { } }
    }
    setMatchLoadOverlay(false);
    let go = document.getElementById('game-over');
    if (go) go.style.display = 'none';
    _clearInviteParamsFromUrl();
    setLobbyMode('main');
    let waiting = document.getElementById('lobby-waiting');
    if (statusText && waiting) {
        // Keep the reason visible above the main menu buttons.
        waiting.style.display = 'block';
        let players = document.getElementById('lobby-players');
        if (players) players.innerHTML = '';
        ['btn-copy-link', 'btn-start-online', 'btn-spectate-online', 'btn-lobby-leave'].forEach(id => {
            let el = document.getElementById(id);
            if (el) el.style.display = 'none';
        });
    }
    _setLobbyStatus(statusText || '', color);
    if (typeof updateInfoPanel === 'function') updateInfoPanel();
}

// Lobby "Leave"/"Close Lobby" button.
function leaveOnlineLobby() {
    clearMatchRecord();
    if (isHost) {
        for (let c of connections) {
            try { c.send({ type: 'HOST_CLOSED_LOBBY', reason: 'The host closed the lobby.' }); } catch { }
        }
    } else {
        _guestLeavingLobby = true;
        let hostConn = netGetHostConnection();
        if (hostConn) { try { hostConn.send({ type: 'LOBBY_LEAVE' }); } catch { } }
    }
    // Give the goodbye message a moment before the links close.
    let epoch = networkSessionEpoch;
    setTimeout(() => {
        if (epoch !== networkSessionEpoch) return;
        _returnToMainMenuWithStatus('');
    }, 150);
    connections = connections.slice();
}

// Leave a running (or finished) match and return to the main menu.
function leaveMultiplayerToMainMenu(statusText = '') {
    clearMatchRecord();
    if (!isMultiplayer) {
        _returnToMainMenuWithStatus(statusText);
        return;
    }
    if (isHost) {
        for (let c of connections) {
            try { c.send({ type: 'HOST_CLOSED_LOBBY', reason: gameStarted && !gameOver ? 'The host left the match.' : 'The host closed the lobby.', migrate: !!(gameStarted && !gameOver) }); } catch { }
        }
    } else {
        _guestLeavingLobby = true;
        let hostConn = netGetHostConnection();
        if (hostConn && gameStarted && !gameOver && !localDefeated) {
            // Leaving counts as resigning, so the match can continue.
            try { hostConn.send({ type: 'MATCH_ROLE_UPDATE', role: 'spectating' }); } catch { }
        }
        if (hostConn) { try { hostConn.send({ type: 'LOBBY_LEAVE' }); } catch { } }
    }
    let epoch = networkSessionEpoch;
    setTimeout(() => {
        if (epoch !== networkSessionEpoch) return;
        _returnToMainMenuWithStatus(statusText);
    }, 150);
}

// Host: players who never report "loaded" are dropped so the rest can start.
function _armMatchStartReadyTimeout(sessionId) {
    setTimeout(() => {
        if (!isHost || !gameStarted || !matchStartWaitingForReady || matchStartSessionId !== sessionId) return;
        let missing = (matchStartExpectedReadyPeerIds || []).filter(pid => !matchStartReadyByPeerId[pid]);
        logLockstepWarning('Players did not finish loading; starting without them', { missing });
        for (let pid of missing) {
            matchStartExpectedReadyPeerIds = matchStartExpectedReadyPeerIds.filter(x => x !== pid);
            delete matchStartReadyByPeerId[pid];
            if (_matchStartPlayerStatuses) delete _matchStartPlayerStatuses[pid];
            hostRemovePlayerFromMatch(pid);
        }
        if (areAllMatchStartPeersReady() && !_matchStartCountdownHandle) {
            if (matchStartExpectedReadyPeerIds.length === 0) {
                matchStartWaitingForReady = false;
                _matchStartPlayerStatuses = null;
                setMatchLoadOverlay(false);
                broadcastStartGameAllReady();
            } else {
                let cdPayload = { type: 'START_GAME_COUNTDOWN', seconds: 3, statuses: {}, startSessionId: matchStartSessionId };
                connections.forEach(c => { if (c && c.peer) try { c.send(cdPayload); } catch { } });
                _startMatchCountdown(3);
            }
        }
    }, 45000);
}

function readConfigFromMenu() {
    let size = parseInt(document.getElementById('cfg-mapsize').value) || 80;
    GRID_W = size; GRID_H = size;
    WORLD_W = GRID_W * TILE; WORLD_H = GRID_H * TILE;
    GOLD_MINE_COUNT = parseInt(document.getElementById('cfg-gold-count').value) || 18;
    GOLD_MINE_MIN = parseInt(document.getElementById('cfg-gold-min').value) || 500;
    GOLD_MINE_MAX = parseInt(document.getElementById('cfg-gold-max').value) || 1500;
    ASTAR_MINE_COUNT = Math.max(0, Math.floor(parseInt((document.getElementById('cfg-astar-mine-count') || {}).value) || ASTAR_MINE_COUNT));
    ASTAR_MINE_MIN = Math.max(0, Math.floor(parseInt((document.getElementById('cfg-astar-mine-min') || {}).value) || ASTAR_MINE_MIN));
    ASTAR_MINE_MAX = Math.max(ASTAR_MINE_MIN, Math.floor(parseInt((document.getElementById('cfg-astar-mine-max') || {}).value) || ASTAR_MINE_MAX));
    fullVisibility = document.getElementById('cfg-full-vis').value === 'full';
    teamVisibilityHistory = document.getElementById('cfg-full-vis').value === 'history';
    gameMode = document.getElementById('cfg-gamemode').value || 'destroy';
    CONFIG_MAX_POP = Math.max(1, Math.floor(parseInt(document.getElementById('cfg-max-pop').value) || 200));
    STARTING_MONEY = Math.max(0, Math.floor(parseInt(document.getElementById('cfg-starting-energy').value) || 2000));
    STARTING_ASTAR = Math.max(0, Number((document.getElementById('cfg-starting-astar') || {}).value) || STARTING_ASTAR);
    MAP_TYPE = document.getElementById('cfg-map-type').value || 'random';
    THING_STATS_RECALC_INTERVAL_SECONDS = Math.max(0.05, Math.min(600, Number((document.getElementById('cfg-thing-stats-seconds') || {}).value) || THING_STATS_RECALC_INTERVAL_SECONDS));
    UNIT_EFFECTIVE_STATS_RECALC_TICKS = Math.max(1, Math.min(240, Math.floor(Number(document.getElementById('cfg-unit-eff-stats-ticks').value) || 5)));
    UNIT_COLLISION_RECALC_TICKS = Math.max(1, Math.min(240, Math.floor(Number((document.getElementById('cfg-unit-collision-ticks') || {}).value) || 5)));
    ASTAR_ITER_BUDGET_PER_PLAYER_TICK = Math.max(256, Math.min(500000, Math.floor(Number((document.getElementById('cfg-astar-iter-budget-per-player') || {}).value) || ASTAR_ITER_BUDGET_PER_PLAYER_TICK)));
    WORKER_AI_TICK_DELAY = Math.max(1, Math.min(60, Math.floor(Number((document.getElementById('cfg-worker-ai-tick-delay') || {}).value) || WORKER_AI_TICK_DELAY)));
    lockstepStrictDebugMode = !!((document.getElementById('cfg-exact-lockstep') || {}).checked);

    netAutoEnabled = readNetAutoFromMenu();
    let menuTickRate = parseInt(document.getElementById('cfg-tick-rate').value);
    let menuPipelineDelay = parseInt(document.getElementById('cfg-pipeline-delay').value);
    // Auto: the tick rate is the game's reference rate, and each guest's
    // input delay follows its measured link during the match.
    if (netAutoEnabled) menuTickRate = netChooseAutoTickRate();
    applyTimingConfig(menuTickRate, menuPipelineDelay);

    MAX_THING_LEVEL = Math.max(1, Math.floor(Number(document.getElementById('cfg-max-thing-level').value) || 20));
    MAX_RESEARCH_LEVEL = Math.max(1, Math.floor(Number(document.getElementById('cfg-max-research-level').value) || 10));
    startingResourcesConfig = normalizeStartingResourcesConfig(startingResourcesConfig);
}

function initLobbySettingsCarousel() {
    let mapVisibility = document.getElementById('cfg-full-vis');
    if (mapVisibility && !mapVisibility.dataset.persistenceInit) {
        mapVisibility.dataset.persistenceInit = '1';
        mapVisibility.addEventListener('change', saveUiSettingsToStorage);
    }
    let wrap = document.getElementById('lobby-settings');
    if (!wrap || wrap.dataset.carouselInit === '1') return;
    wrap.dataset.carouselInit = '1';

    let slides = Array.from(wrap.querySelectorAll('.lobby-column'));
    if (!slides.length) return;

    let prevBtn = document.getElementById('btn-lobby-prev');
    let nextBtn = document.getElementById('btn-lobby-next');
    let dots = Array.from(document.querySelectorAll('.lobby-ind-dot'));
    let currentIndex = 1;

    function isMobileLayout() {
        return window.matchMedia('(max-width: 800px)').matches;
    }

    function getSlideWidth() {
        if (slides.length < 2) return slides[0].offsetWidth;
        return slides[1].offsetLeft - slides[0].offsetLeft;
    }

    function updateNavState() {
        dots.forEach((d, i) => d.classList.toggle('active', i === currentIndex));
        if (prevBtn) prevBtn.disabled = currentIndex <= 0;
        if (nextBtn) nextBtn.disabled = currentIndex >= slides.length - 1;
    }

    function scrollToIndex(idx, smooth = true) {
        currentIndex = Math.max(0, Math.min(slides.length - 1, idx));
        if (isMobileLayout()) {
            let slideWidth = getSlideWidth() || wrap.clientWidth;
            wrap.scrollTo({ left: currentIndex * slideWidth, behavior: smooth ? 'smooth' : 'auto' });
        } else {
            wrap.scrollTo({ left: 0, behavior: 'auto' });
            currentIndex = 1;
        }
        updateNavState();
    }

    function snapFromScroll() {
        if (!isMobileLayout()) {
            currentIndex = 1;
            updateNavState();
            return;
        }
        let slideWidth = getSlideWidth() || wrap.clientWidth;
        if (slideWidth <= 0) return;
        currentIndex = Math.max(0, Math.min(slides.length - 1, Math.round(wrap.scrollLeft / slideWidth)));
        updateNavState();
    }

    if (prevBtn) prevBtn.addEventListener('click', () => scrollToIndex(currentIndex - 1));
    if (nextBtn) nextBtn.addEventListener('click', () => scrollToIndex(currentIndex + 1));
    dots.forEach((dot, i) => dot.addEventListener('click', () => scrollToIndex(i)));
    wrap.addEventListener('scroll', snapFromScroll, { passive: true });

    window.addEventListener('resize', () => {
        if (!isMobileLayout()) {
            wrap.scrollLeft = 0;
            currentIndex = 1;
            updateNavState();
            return;
        }
        scrollToIndex(currentIndex, false);
    });

    scrollToIndex(1, false);
}

function startSoloGame() {
    readConfigFromMenu();
    isMultiplayer = false;
    gameSeed = Date.now();
    localPlayerId = 0;
    initAudio();
    startGame();
}

// ============================================================
