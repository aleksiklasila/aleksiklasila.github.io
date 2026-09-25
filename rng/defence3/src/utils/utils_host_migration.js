"use strict";

// ============================================================
// HOST MIGRATION
// Everyone talks only to the host, so losing it used to end the match for
// all players. Every guest runs the same verified simulation, so any of them
// can take over. When the host is gone (tab closed or crashed, network lost,
// or it left), the others try successors in the same order (players before
// spectators, each by peer id). The first reachable one becomes host, the
// rest reconnect to it, and one resync lines everyone up on its state. The
// old host's slot is then handled like any missing player (the match waits,
// with a drop button), unless it left on purpose.
//
// Splits heal on their own: a host that has been missing players for a
// while asks them who hosts the match now, and joins that host if it is
// alone (or loses on id order). A reloaded page finds the match through a
// per-tab record, even if its invite link names a host that moved on.
// ============================================================

const HOST_MIGRATION_AFTER_SILENT_MS = 15000;
// With nobody else to ask whether the host is really gone (a 1v1), our own
// link is as likely the problem: keep trying the host much longer.
const HOST_MIGRATION_ALONE_AFTER_SILENT_MS = 60000;
// A guest that heard its host this recently does not consider it lost.
const HOST_MIGRATION_CANDIDATE_SILENT_MS = 2000;
const HOST_MIGRATION_ATTEMPT_MS = 15000;
const HOST_SEEK_AFTER_MISSING_MS = 20000;
const HOST_SEEK_ALONE_INTERVAL_MS = 4000;
const HOST_SEEK_INTERVAL_MS = 10000;
const HOST_SEEK_TIMEOUT_MS = 5000;
const MATCH_RECORD_KEY = 'defence3_mp_match';
const MATCH_RECORD_MAX_AGE_MS = 2 * 60 * 60 * 1000;

// Guest: { oldHostId, candidates, index, hostLeft, attemptAt, redirects }
let hostMigration = null;
// Guest: when the current host was last heard before it was lost (0: fine).
let guestHostLostAt = 0;
let _hostSeekActive = false;
let _hostLastSeekAt = 0;
let _matchRecordSavedAt = 0;
let _recordRecoveryTries = 0;

function resetHostMigrationState() {
    hostMigration = null;
    guestHostLostAt = 0;
    _hostSeekActive = false;
    _hostLastSeekAt = 0;
}

function _migrationRoleOf(pid) {
    if (pid === myPeerId) return (localDefeated || spectateMode !== 'none') ? 'spectating' : 'playing';
    let known = normalizeMatchRole(isHost ? matchRoleByPeerId[pid] : remoteRoleByPeerId[pid], '');
    if (known) return known;
    // Not reported (yet): whoever started the match plays.
    return (matchStartLobbyPlayers || []).some(p => p && p.peerId === pid) ? 'playing' : 'spectating';
}

// Successor order: players before spectators, each by peer id. Only data
// that rarely changes goes in, so every guest computes the same order
// (presence does not: a host tearing down reports peers gone to some
// guests but not others).
function computeHostMigrationCandidates(excludeId) {
    let groups = [[], []];
    let seen = new Set();
    let ids = (lobbyPlayers || []).map(p => String((p && p.peerId) || ''));
    if (myPeerId) ids.push(String(myPeerId));
    for (let pid of ids) {
        if (!pid || pid === excludeId || seen.has(pid)) continue;
        seen.add(pid);
        if (isPeerExplicitlyRemoved(pid)) continue;
        groups[_migrationRoleOf(pid) === 'playing' ? 0 : 1].push(pid);
    }
    let byId = (a, b) => (a < b ? -1 : (a > b ? 1 : 0));
    return groups.flatMap(g => g.sort(byId));
}

// Who should take over, as far as this guest knows: the first successor not
// known to be unreachable ('' when that is us).
function _successorFromMyView(failedByOthers) {
    let m = hostMigration;
    let failed = new Set(Array.isArray(failedByOthers) ? failedByOthers.map(String) : []);
    if (m) for (let pid of m.candidates.slice(0, m.index)) failed.add(pid);
    let order = m ? m.candidates : computeHostMigrationCandidates(String(wsHostId || ''));
    for (let pid of order) {
        if (pid === myPeerId) return '';
        if (!failed.has(pid)) return pid;
    }
    return '';
}

function guestConsidersHostLost(now = performance.now()) {
    if (isHost || !gameStarted) return false;
    if (hostMigration) return true;
    let hostConn = connections.find(c => c && c.peer === wsHostId);
    if (!hostConn || hostConn.open === false) return true;
    let link = netGetLinkStats(wsHostId);
    return !link || !link.lastHeardAt || (now - link.lastHeardAt) > HOST_MIGRATION_CANDIDATE_SILENT_MS;
}

// Guest: called when the host connection is lost; true when it is time to
// move the match rather than keep reconnecting.
function guestShouldMigrate(now = performance.now()) {
    if (isHost || !gameStarted || gameOver || hostMigration) return false;
    if (!guestHostLostAt) {
        let link = netGetLinkStats(wsHostId);
        guestHostLostAt = (link && link.lastHeardAt) || now;
    }
    // Without our own signaling link the problem is probably ours: keep
    // reconnecting to the host until the network is back.
    if (!peer || !peer.open || peer.disconnected) return false;
    let alone = computeHostMigrationCandidates(String(wsHostId || '')).every(pid => pid === myPeerId);
    return (now - guestHostLostAt) > (alone ? HOST_MIGRATION_ALONE_AFTER_SILENT_MS : HOST_MIGRATION_AFTER_SILENT_MS);
}

function guestStartHostMigration(reason, opts = {}) {
    if (isHost || !isMultiplayer || !gameStarted || gameOver) return false;
    if (isPeerExplicitlyRemoved(myPeerId)) return false;
    if (hostMigration) {
        if (opts.hostLeft) hostMigration.hostLeft = true;
        return true;
    }
    let oldHostId = String(wsHostId || '');
    if (!oldHostId) return false;
    let candidates = computeHostMigrationCandidates(oldHostId);
    if (candidates.length === 0) return false;
    hostMigration = { oldHostId, candidates, index: 0, hostLeft: !!opts.hostLeft, attemptAt: 0, redirects: 0, target: '' };
    netCounters.hostMigrations++;
    logLockstepWarning('Host lost; moving the match', { oldHostId, candidates, reason: String(reason || '') });
    if (guestReconnectTimer) { clearTimeout(guestReconnectTimer); guestReconnectTimer = null; }
    _clearGuestJoinTimeout();
    let stale = connections.filter(c => c && c.peer === oldHostId);
    connections = connections.filter(c => !stale.includes(c));
    for (let c of stale) { try { c.close(); } catch { } }
    _hostMigrationTryNext();
    return true;
}

function _hostMigrationTryNext() {
    let m = hostMigration;
    if (!m || !gameStarted || gameOver) return;
    if (m.index >= m.candidates.length) {
        // Nobody answered, not even as a successor: fall back to waiting
        // for the old host, and try moving again later.
        hostMigration = null;
        wsHostId = m.oldHostId;
        guestHostLostAt = performance.now();
        scheduleGuestAutoReconnect('Host unreachable');
        return;
    }
    let cand = m.candidates[m.index];
    m.attemptAt = performance.now();
    if (cand === myPeerId) {
        let others = m.candidates.filter(pid => pid !== myPeerId);
        if (m.hostLeft || others.length === 0) {
            promoteSelfToHost(m.oldHostId, m.hostLeft);
            return;
        }
        // Before taking over, make sure the others lost the host too: if
        // only our own link to it broke, taking over would split the match.
        probeHostAlive(others, matchStartSessionId, m.oldHostId, (alive, otherHostId) => {
            if (hostMigration !== m || isHost || !gameStarted) return;
            if (alive) {
                logLockstepWarning('Host still reachable by others; reconnecting to it', {});
                hostMigration = null;
                wsHostId = m.oldHostId;
                guestHostLostAt = performance.now();
                scheduleGuestAutoReconnect('Host unreachable from here');
            } else if (otherHostId) {
                _hostMigrationJoin(m, otherHostId);
            } else {
                promoteSelfToHost(m.oldHostId, m.hostLeft);
            }
        });
        return;
    }
    _setLobbyStatus('Host lost. Moving the match to another player...', '#fa4');
    _hostMigrationJoin(m, cand);
}

// Start a join to a successor (or the host a successor pointed us to).
function _hostMigrationJoin(m, target) {
    m.target = target;
    m.attemptAt = performance.now();
    joinGame(target, { rejoin: true, migrate: true });
}

// The peer being joined is unreachable (or dropped us): try the next
// successor. Events for earlier attempts (their links closing as the next
// join replaces the peer) are ignored.
function hostMigrationCandidateFailed(peerId) {
    let m = hostMigration;
    if (!m) return false;
    if (!m.target || m.target !== String(peerId || '')) return true;
    m.target = '';
    m.index++;
    _hostMigrationTryNext();
    return true;
}

// Guest: a successor answered that it does not host. It either still has
// the old host (so the problem is our link: go back to it) or knows the
// host the match moved to.
function hostMigrationHandleReply(conn, data) {
    let m = hostMigration;
    if (!m || !conn || conn.peer !== wsHostId) return;
    if (String(data.sessionId || '') !== String(matchStartSessionId || '')) { hostMigrationCandidateFailed(conn.peer); return; }
    if (m.redirects >= 6) { hostMigrationCandidateFailed(conn.peer); return; }
    m.redirects++;
    let hostId = String(data.hostId || '');
    let successor = String(data.successor || '');
    if (data.hostLost) {
        // It lost the host too, and knows a successor ahead of it that we
        // have not tried (possibly us).
        if (!successor) hostMigrationCandidateFailed(conn.peer);
        else if (successor === myPeerId) {
            m.index = Math.max(m.index, m.candidates.indexOf(myPeerId));
            m.target = '';
            _hostMigrationTryNext();
        } else _hostMigrationJoin(m, successor);
        return;
    }
    // It still has a host.
    if (!hostId || hostId === myPeerId) { hostMigrationCandidateFailed(conn.peer); return; }
    if (hostId === m.oldHostId) {
        // Only our link to the host broke: go back to it.
        logLockstepWarning('Host still reachable by others; reconnecting to it', { via: conn.peer });
        hostMigration = null;
        guestHostLostAt = performance.now();
        joinGame(hostId, { rejoin: true });
        return;
    }
    // The match already moved there.
    _hostMigrationJoin(m, hostId);
}

// Guest: the host told us the match moved (it joined another host).
function guestFollowHostMove(hostId) {
    let hid = String(hostId || '');
    if (isHost || !gameStarted || gameOver || !hid || hid === myPeerId) return;
    hostMigration = null;
    guestHostLostAt = 0;
    joinGame(hid, { rejoin: true, migrate: true });
}

// Guest: take over as host with the match state we have.
function promoteSelfToHost(oldHostId, hostLeft) {
    if (isHost || !gameStarted) return;
    let now = performance.now();
    logLockstepWarning('Taking over as host', { oldHostId, tick: currentTick });
    hostMigration = null;
    guestHostLostAt = 0;
    _clearGuestJoinTimeout();
    if (guestReconnectTimer) { clearTimeout(guestReconnectTimer); guestReconnectTimer = null; }
    guestReconnectAttempt = 0;
    netHostUnreachable = false;
    // Host bookkeeping from the roster every guest has.
    for (let lp of (lobbyPlayers || [])) {
        let pid = String((lp && lp.peerId) || '');
        if (!pid) continue;
        let role = _migrationRoleOf(pid);
        matchRoleByPeerId[pid] = role;
        let uid = String(lp.uid || '');
        if (uid) {
            peerUidByPeerId[pid] = uid;
            matchRoleByUid[uid] = role;
        }
        peerPresenceById[pid] = pid === myPeerId || connections.some(c => c && c.peer === pid && c.open !== false);
    }
    if (myPeerId && localPersistentPeerId) peerUidByPeerId[myPeerId] = localPersistentPeerId;
    // Guests keep the start roster as it was; the host's broadcasts carry
    // current peer ids (players who reconnected under a new one).
    matchStartLobbyPlayers = (lobbyPlayers || []).filter(lp => lp && lp.peerId && !isPeerExplicitlyRemoved(lp.peerId)).map(lp => ({ ...lp }));
    let stale = connections.filter(c => c && c.peer === oldHostId);
    connections = connections.filter(c => !stale.includes(c));
    for (let c of stale) { try { c.close(); } catch { } }
    isHost = true;
    wsHostId = myPeerId;
    wsRoomId = myPeerId;
    // Guest-side lockstep state does not apply to a host.
    lockstepHostPacketsByTick = {};
    lockstepHistoryByTick = {};
    lockstepHostWaitRequestByPeer = {};
    lockstepGuestWaitRequest = null;
    lockstepPendingBundleByTick = {};
    lockstepPendingCommitByTick = {};
    lockstepExpectedStateHashByTick = {};
    lockstepLocalStateHashByTick = {};
    lockstepExpectedStateDigestByTick = {};
    lockstepLocalStateDigestByTick = {};
    lockstepDesyncDetected = false;
    lockstepResyncPauseActive = false;
    lockstepResyncSessionId = '';
    lockstepResyncPendingAckByPeer = {};
    lockstepResyncSnapshotCache = null;
    lockstepResyncRequestedAt = 0;
    lockstepResyncDeadlineAt = 0;
    lockstepPendingResumeSessionId = '';
    waitingForRemoteSince = 0;
    netDisconnectedSinceByPeer = {};
    for (let pid of getActiveMatchPeerIds()) {
        if (pid !== myPeerId && !connections.some(c => c && c.peer === pid)) netDisconnectedSinceByPeer[pid] = now;
    }
    LOCKSTEP_PIPELINE_TICKS = Math.max(0, Math.floor(Number(INPUT_DELAY) || 0));
    if (hostLeft && oldHostId) hostRemovePlayerFromMatch(oldHostId);
    try {
        let url = new URL(window.location.href);
        url.searchParams.set('game', myPeerId);
        url.searchParams.set('room', myPeerId);
        window.history.replaceState({}, '', url.toString());
    } catch { }
    _setLobbyStatus('You are now hosting this match.', '#9f9');
    saveMatchRecord(true);
    broadcastLobbyState(true);
    updateInfoPanel();
}

// Host: another host runs this match (we were cut off and the others moved
// on): join it and bring our own guests along.
function demoteSelfToGuest(newHostId) {
    if (!isHost || !gameStarted) return;
    let hid = String(newHostId || '');
    logLockstepWarning('Another host runs this match; joining it', { newHostId: hid });
    netCounters.hostMigrations++;
    for (let c of connections) {
        try { c.send({ type: 'HOST_MOVED', hostId: hid, sessionId: matchStartSessionId }); } catch { }
    }
    isHost = false;
    wsHostId = hid;
    lockstepResyncPauseActive = false;
    lockstepResyncPendingAckByPeer = {};
    lockstepResyncSnapshotCache = null;
    lockstepHostPacketsByTick = {};
    lockstepHistoryByTick = {};
    lockstepHostWaitRequestByPeer = {};
    netDisconnectedSinceByPeer = {};
    guestHostLostAt = 0;
    let epoch = networkSessionEpoch;
    setTimeout(() => {
        if (epoch !== networkSessionEpoch || isHost || !gameStarted) return;
        joinGame(hid, { rejoin: true, migrate: true });
    }, 150);
}

// Answer "who hosts this match?" on a link opened only to ask that.
// `successor` points a player moving the match at the peer it should try.
function answerHostSeek(conn, successor = '') {
    let replied = false;
    let reply = () => {
        if (replied) return;
        replied = true;
        try {
            conn.send({
                type: 'HOST_SEEK_REPLY', sessionId: matchStartSessionId,
                isHost: !!(isHost && gameStarted), hostId: isHost ? myPeerId : String((hostMigration && hostMigration.oldHostId) || wsHostId || ''),
                hostLost: !isHost && guestConsidersHostLost(), successor
            });
        } catch { }
        setTimeout(() => { try { conn.close(); } catch { } }, 1000);
    };
    if (conn.open) reply();
    else conn.on('open', reply);
    setTimeout(() => { try { conn.close(); } catch { } }, HOST_SEEK_TIMEOUT_MS + 2000);
}

// Guest: a player moving the match picked us as the successor. Take over if
// we lost the host too and nobody ahead of us in the order may still be
// reachable; otherwise point them at the host, or at that successor.
function guestHandleMigrationConnection(conn) {
    let meta = (conn && conn.metadata) || {};
    let sameMatch = String(meta.sessionId || '') === String(matchStartSessionId || '');
    if (sameMatch && !gameOver && !isPeerExplicitlyRemoved(myPeerId) && guestConsidersHostLost()) {
        let successor = _successorFromMyView(meta.failed);
        if (!successor || successor === conn.peer) {
            let m = hostMigration;
            promoteSelfToHost(String((m && m.oldHostId) || wsHostId || ''), !!(m && m.hostLeft));
            setupConnection(conn);
            return;
        }
        answerHostSeek(conn, successor);
        return;
    }
    answerHostSeek(conn);
}

// Ask peers who hosts this match now. Calls back with the first host found
// other than us, or '' once the time is up. Uses the current peer, so a host
// looking around keeps its id.
function seekMatchHost(peerIds, sessionId, done) {
    let finished = false;
    let conns = [];
    let probed = new Set();
    let pending = 0;
    let finish = hostId => {
        if (finished) return;
        finished = true;
        for (let c of conns) { try { c.close(); } catch { } }
        done(hostId || '');
    };
    if (!peer || peer.destroyed) { finish(''); return; }
    let probe = pid => {
        pid = String(pid || '');
        if (finished || !pid || pid === myPeerId || probed.has(pid)) return;
        probed.add(pid);
        let c = null;
        try { c = peer.connect(pid, { metadata: { hostSeek: true, sessionId } }); } catch { }
        if (!c) return;
        conns.push(c);
        pending++;
        let answered = false;
        c.on('data', d => {
            if (answered || !d || d.type !== 'HOST_SEEK_REPLY') return;
            answered = true;
            let hid = String(d.hostId || '');
            if (String(d.sessionId || '') === String(sessionId || '')) {
                if (d.isHost && hid && hid !== myPeerId) { finish(hid); return; }
                if (hid && !d.hostLost) probe(hid);
            }
            // Everyone answered and nobody hosts (yet): no need to wait.
            if (--pending <= 0) finish('');
        });
        c.on('error', () => { });
    };
    for (let pid of peerIds) probe(pid);
    setTimeout(() => finish(''), HOST_SEEK_TIMEOUT_MS);
}

// Ask peers whether they still have the old host. Calls back with
// (true) as soon as one does, (false, hostId) when one reports a different
// host, else (false) once everyone answered or the time is up.
function probeHostAlive(peerIds, sessionId, oldHostId, done) {
    let finished = false;
    let conns = [];
    let pending = 0;
    let finish = (alive, otherHostId = '') => {
        if (finished) return;
        finished = true;
        for (let c of conns) { try { c.close(); } catch { } }
        done(alive, otherHostId);
    };
    if (!peer || peer.destroyed) { finish(false); return; }
    for (let pid of peerIds) {
        if (!pid || pid === myPeerId || pid === oldHostId) continue;
        let c = null;
        try { c = peer.connect(pid, { metadata: { hostSeek: true, sessionId } }); } catch { }
        if (!c) continue;
        conns.push(c);
        pending++;
        let answered = false;
        c.on('data', d => {
            if (answered || !d || d.type !== 'HOST_SEEK_REPLY') return;
            answered = true;
            let hid = String(d.hostId || '');
            if (String(d.sessionId || '') === String(sessionId || '')) {
                if (d.isHost && hid && hid !== myPeerId && hid !== oldHostId) { finish(false, hid); return; }
                if (!d.hostLost && hid === oldHostId) { finish(true); return; }
            }
            if (--pending <= 0) finish(false);
        });
        c.on('error', () => { });
    }
    if (pending === 0) { finish(false); return; }
    setTimeout(() => finish(false), 3000);
}

// Host (every frame): players missing for a while may have moved the match
// to another host; ask them. An isolated host joins any host it finds; of
// two hosts that split the players, the one with the smaller id stays.
function hostMaybeSeekOtherHost(now = performance.now()) {
    if (!isHost || !gameStarted || gameOver || _hostSeekActive || !peer) return;
    let participants = getActiveMatchPeerIds().filter(pid => pid !== myPeerId);
    if (participants.length === 0) return;
    let missing = participants.filter(pid => netDisconnectedSinceByPeer[pid] && (now - netDisconnectedSinceByPeer[pid]) > HOST_SEEK_AFTER_MISSING_MS);
    if (missing.length === 0) return;
    let alone = missing.length === participants.length;
    if ((now - _hostLastSeekAt) < (alone ? HOST_SEEK_ALONE_INTERVAL_MS : HOST_SEEK_INTERVAL_MS)) return;
    _hostLastSeekAt = now;
    _hostSeekActive = true;
    let sessionId = matchStartSessionId;
    let epoch = networkSessionEpoch;
    let spectators = (lobbyPlayers || []).map(p => String((p && p.peerId) || '')).filter(pid => pid && pid !== myPeerId && !participants.includes(pid));
    seekMatchHost(missing.concat(alone ? spectators : []), sessionId, hostId => {
        _hostSeekActive = false;
        if (!hostId || epoch !== networkSessionEpoch || !isHost || !gameStarted || gameOver || matchStartSessionId !== sessionId) return;
        let stillAlone = !participants.some(pid => connections.some(c => c && c.peer === pid));
        if (stillAlone || hostId < myPeerId) demoteSelfToGuest(hostId);
    });
}

// Guest (every frame): a successor that accepted the link but never took
// over or answered is given up on.
function guestMaintainHostMigration(now = performance.now()) {
    let m = hostMigration;
    if (!m || isHost) return;
    if (m.target && m.attemptAt && (now - m.attemptAt) > HOST_MIGRATION_ATTEMPT_MS) hostMigrationCandidateFailed(m.target);
}

// Per-tab record of the running match, so a reloaded page can find it again
// after the host moved.
function saveMatchRecord(force = false) {
    if (!isMultiplayer || !gameStarted || !matchStartSessionId) return;
    let now = performance.now();
    if (!force && (now - _matchRecordSavedAt) < 3000) return;
    _matchRecordSavedAt = now;
    let hostId = isHost ? String(myPeerId || '') : String(wsHostId || '');
    // Earlier ids (ours and hosts') of this match, so any older invite link
    // in this tab still leads back to it.
    let prev = loadMatchRecord();
    let same = prev && prev.sessionId === matchStartSessionId;
    let merge = (list, extra) => Array.from(new Set([...(same && Array.isArray(list) ? list : []), ...extra].filter(Boolean))).slice(-16);
    try {
        sessionStorage.setItem(MATCH_RECORD_KEY, JSON.stringify({
            sessionId: matchStartSessionId,
            selfId: String(myPeerId || ''),
            selfIds: merge(prev && prev.selfIds, [String(myPeerId || '')]),
            hostId,
            knownIds: merge(prev && prev.knownIds, [hostId, same ? prev.hostId : '']),
            peers: (lobbyPlayers || []).map(p => String((p && p.peerId) || '')).filter(pid => pid && pid !== myPeerId),
            savedAt: Date.now()
        }));
    } catch { }
    // Keep the address bar's invite on the current host, for reloads.
    try {
        let url = new URL(window.location.href);
        if (hostId && url.searchParams.get('game') !== hostId) {
            url.searchParams.set('game', hostId);
            url.searchParams.set('room', hostId);
            window.history.replaceState({}, '', url.toString());
        }
    } catch { }
}

function clearMatchRecord() {
    try { sessionStorage.removeItem(MATCH_RECORD_KEY); } catch { }
}

function loadMatchRecord() {
    try {
        let rec = JSON.parse(sessionStorage.getItem(MATCH_RECORD_KEY) || 'null');
        if (!rec || typeof rec !== 'object' || !rec.sessionId || !Array.isArray(rec.peers)) return null;
        if (!(Date.now() - Number(rec.savedAt) < MATCH_RECORD_MAX_AGE_MS)) return null;
        return rec;
    } catch { return null; }
}

// This tab's record of the match an invite points into, if any.
function matchRecordFor(hostId) {
    let rec = loadMatchRecord();
    let hid = String(hostId || '');
    if (!rec || !hid) return null;
    let known = [rec.hostId, rec.selfId].concat(rec.peers, rec.selfIds || [], rec.knownIds || []);
    return known.includes(hid) ? rec : null;
}

function _recordWasSelf(rec, hid) {
    return rec.selfId === hid || (Array.isArray(rec.selfIds) && rec.selfIds.includes(hid));
}

// Fresh page joining a match this tab was in (a reload). If the invite names
// this tab's own old id, it hosted: that host is gone with the old page, so
// only look for where the match went. Otherwise join as usual, but also ask
// around, in case the match moved to another host. True when the direct
// join should be skipped.
function joinWithMatchRecord(hostId) {
    let rec = matchRecordFor(hostId);
    if (!rec) return false;
    if (_recordWasSelf(rec, String(hostId))) return tryRecoverMatchFromRecord(hostId);
    let epoch = networkSessionEpoch;
    let peers = Array.from(new Set(rec.peers.concat(rec.hostId || [], rec.knownIds || []))).filter(pid => pid && !_recordWasSelf(rec, pid));
    seekMatchHost(peers, rec.sessionId, found => {
        if (!found || found === String(hostId) || epoch !== networkSessionEpoch || gameStarted || isHost) return;
        joinGame(found);
    });
    return false;
}

// Fresh page whose invite names a host that is gone: if this tab was in
// that match, look for where it went. True when a search was started.
function tryRecoverMatchFromRecord(missingHostId) {
    let missing = String(missingHostId || '');
    let rec = matchRecordFor(missing);
    if (!rec || gameStarted || isHost || _recordRecoveryTries >= 6) return false;
    _recordRecoveryTries++;
    _clearGuestJoinTimeout();
    _setLobbyStatus('The host moved. Looking for the match...', '#4af');
    let peers = Array.from(new Set(rec.peers.concat(rec.hostId || [], rec.knownIds || []))).filter(pid => pid && pid !== missing && !_recordWasSelf(rec, pid));
    let epoch = networkSessionEpoch;
    seekMatchHost(peers, rec.sessionId, hostId => {
        if (epoch !== networkSessionEpoch || gameStarted) return;
        if (hostId) {
            _recordRecoveryTries = 0;
            joinGame(hostId);
            return;
        }
        // Others may still be picking the new host: look again shortly.
        if (_recordRecoveryTries < 6) {
            setTimeout(() => {
                if (epoch !== networkSessionEpoch || gameStarted) return;
                if (!tryRecoverMatchFromRecord(missing)) _returnToMainMenuWithStatus('Could not find that game. It may have ended, or the link is wrong.', '#f66');
            }, 1000);
            return;
        }
        _returnToMainMenuWithStatus('Could not find that game. It may have ended, or the link is wrong.', '#f66');
    });
    return true;
}

// "peer-unavailable" errors name the peer that could not be reached.
function peerIdFromUnavailableError(err) {
    let m = String((err && err.message) || '').match(/peer\s+(\S+)\s*$/i);
    return m ? m[1] : '';
}
