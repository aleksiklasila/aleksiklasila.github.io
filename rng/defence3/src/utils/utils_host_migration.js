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
// (A reloaded page looks for where its match went this long from its first look: past the time a lone remaining
// player waits before it takes the match over (HOST_MIGRATION_ALONE_AFTER_SILENT_MS) and its attempt. Six looks,
// ~35 s, gave up first: the match went on without the old host, which was told it could not be found.)
const MATCH_RECORD_SEEK_MS = HOST_MIGRATION_ALONE_AFTER_SILENT_MS + HOST_MIGRATION_ATTEMPT_MS + 10000;
let _recordRecoveryStartedAt = 0;
function _recordRecoveryMore(now = performance.now()) { return _recordRecoveryTries === 0 || now - _recordRecoveryStartedAt < MATCH_RECORD_SEEK_MS; }

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
// known to be unreachable ('' when that is us). (passSelf: the first other
// one, as a guest whose own end is not confirmed sees it.)
function _successorFromMyView(failedByOthers, passSelf = false) {
    let m = hostMigration;
    let failed = new Set(Array.isArray(failedByOthers) ? failedByOthers.map(String) : []);
    if (m) for (let pid of m.candidates.slice(0, m.index)) failed.add(pid);
    let order = m ? m.candidates : computeHostMigrationCandidates(String(wsHostId || ''));
    for (let pid of order) {
        if (pid === myPeerId) { if (passSelf) continue; return ''; }
        if (!failed.has(pid)) return pid;
    }
    return '';
}

// A guest whose end of the match the host never confirmed (netMatchEndFinal):
// its state may be the divergent one. Losing the host, the match moves on
// (it stopped there: the guest stood at its tick for good, audit
// 2026-10-17, 48), and that guest takes over only when nobody else can: the
// others' state goes on, its own end undone by their snapshot.
function _migrationOwnEndUnconfirmed() {
    return gameOver && typeof netMatchEndFinal === 'function' && !netMatchEndFinal();
}
// (Its own state in doubt: an end the host never confirmed, or a known divergence not repaired yet (audit row 87).
// Such a guest takes over only when nobody else can.)
// (Its own simulation lost too (waiting for the match again): it has no world to run or send. The preferred
// successor took over with its empty world and the healthy guest restored it: audit row 113.)
// (Waiting for the whole match: its own request for it, a join or a full patch on the way. Its world stands at the
// tick it stopped; the others ran on. The preferred successor paused at tick 8 took over and the healthy guest,
// at 228, restored its tick: an order both had run was lost. Audit row 121. Everyone paused alike (a match-wide
// recovery): each defers, the first asker still takes it.)
function _migrationAwaitingWholeMatch() {
    if (isHost || !gameStarted) return false;
    const g = typeof resyncGuest !== 'undefined' ? resyncGuest : null;
    return (lockstepResyncPauseActive && lockstepResyncRequestedAt > 0) || !!(g && (g.joining || (g.T >= 0 && g.full)));
}
function _migrationSelfDefers() {
    return _migrationOwnEndUnconfirmed() || (typeof resyncGuestStateSuspect === 'function' && resyncGuestStateSuspect())
        || (typeof simClientLostPending === 'function' && simClientLostPending()) || _migrationAwaitingWholeMatch();
}
function _migrationMatchOver() {
    return gameOver && !_migrationOwnEndUnconfirmed();
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
    if (isHost || !gameStarted || _migrationMatchOver() || hostMigration) return false;
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
    if (isHost || !isMultiplayer || !gameStarted || _migrationMatchOver()) return false;
    if (isPeerExplicitlyRemoved(myPeerId)) return false;
    if (hostMigration) {
        if (opts.hostLeft) hostMigration.hostLeft = true;
        return true;
    }
    let oldHostId = String(wsHostId || '');
    if (!oldHostId) return false;
    let candidates = computeHostMigrationCandidates(oldHostId);
    if (candidates.length === 0) return false;
    // (Its own end unconfirmed: itself last.)
    if (_migrationSelfDefers() && candidates.length > 1 && candidates.includes(myPeerId)) candidates = [...candidates.filter(pid => pid !== myPeerId), myPeerId];
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
    if (!m || !gameStarted || _migrationMatchOver()) return;
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
    if (isHost || !gameStarted || _migrationMatchOver() || !hid || hid === myPeerId) return;
    hostMigration = null;
    guestHostLostAt = 0;
    joinGame(hid, { rejoin: true, migrate: true });
}

// Guest: take over as host with the match state we have. (keepOldLink: the
// old host handed the match over and joins again by itself: its link is
// left to it.)
function promoteSelfToHost(oldHostId, hostLeft, opts = null) {
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
    // (A rematch's players: the match's start players as the old host sent them (one who resigned and spectates on
    // too: audit row 105); from an old host that sent none, those still playing.)
    _matchStartPlayerIds = (typeof guestMatchStartPlayerIds === 'function' && guestMatchStartPlayerIds())
        || new Set(Object.keys(matchRoleByPeerId).filter(pid => matchRoleByPeerId[pid] === 'playing'));
    if (!(opts && opts.keepOldLink)) {
        let stale = connections.filter(c => c && c.peer === oldHostId);
        connections = connections.filter(c => !stale.includes(c));
        for (let c of stale) { try { c.close(); } catch { } }
    }
    isHost = true;
    wsHostId = myPeerId;
    wsRoomId = myPeerId;
    // Guest-side lockstep state does not apply to a host.
    lockstepHostPacketsByTick = {};
    lockstepHistoryByTick = {};
    lockstepHostWaitRequestByPeer = {};
    lockstepHostLateByTick = {};
    lockstepHostCarryByPeer = {};
    lockstepHostLastOnTimeAt = {};
    lockstepHostLastPacketAt = {};
    lockstepHostLastPacketTick = {};
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
    // (Commands held while it was joining: its own now, utils_resync.js resyncGuestReleaseOnPromotion.)
    if (typeof resyncGuestReleaseOnPromotion === 'function') resyncGuestReleaseOnPromotion();
    // (The start's initialization barrier, if it still runs: the host's now.)
    if (typeof matchInitializationOnPromotion === 'function') matchInitializationOnPromotion();
    netDisconnectedSinceByPeer = {};
    for (let pid of getActiveMatchPeerIds()) {
        if (pid !== myPeerId && !connections.some(c => c && c.peer === pid)) netDisconnectedSinceByPeer[pid] = now;
    }
    LOCKSTEP_PIPELINE_TICKS = Math.max(0, Math.floor(Number(INPUT_DELAY) || 0));
    if (hostLeft && oldHostId) hostRemovePlayerFromMatch(oldHostId);
    // (The start's wait for players to load, if it still runs: this host's now, utils_networking.js.)
    if (typeof hostTakeOverStartWait === 'function') hostTakeOverStartWait();
    try {
        let url = new URL(window.location.href);
        url.searchParams.set('game', myPeerId);
        url.searchParams.set('room', myPeerId);
        window.history.replaceState({}, '', url.toString());
    } catch { }
    _setLobbyStatus('You are now hosting this match.', '#9f9');
    if (typeof simClientSyncGlobals === 'function') simClientSyncGlobals();
    saveMatchRecord(true);
    broadcastLobbyState(true);
    updateInfoPanel();
    // (Its own end, not confirmed as a guest (nobody else could take over):
    // the match's end now, told and shown.)
    if (gameOver && typeof matchOverShow === 'function') matchOverShow();
}

// ---- a host whose simulation was lost ----
// Its simulation worker was lost mid-match (sim_client.js), and the match's
// state with it; every player has the same state. The host hands the match
// to the first player in the successor order still linked (HOST_HANDOVER;
// the next one after HOST_HANDOVER_MS without an answer), which takes over
// as in a migration (its team plays on, the old host's too); then the old
// host moves its guests there (demoteSelfToGuest) and joins it for the
// whole match (fullSync: a reload's). (A guest gets the match again from
// its host: netRecoverLostSimulation.)
const HOST_HANDOVER_MS = 4000;
let _hostHandover = null;
// (Every player this host handed the match to, this match: a late answer from one of them still counts, after the
// next one was asked or the handover gave up. Before: an answer later than HOST_HANDOVER_MS was dropped, the
// player had already taken over, and the match had two hosts; a retry it ignored, being host.)
let _hostHandoverSent = { sessionId: '', peers: new Set() };
// (Successor: the old host that handed this page the match: its retry is answered again, and its word on where
// the match went (HOST_MOVED, when it took another player's answer first) is followed.)
let _handedOverFrom = { sessionId: '', peer: '' };
function hostHandoverActive() { return !!_hostHandover; }
function hostHandOverMatch(reason) {
    if (!isHost || !gameStarted || gameOver) return false;
    let linked = pid => connections.some(c => c && c.peer === pid && c.open !== false);
    // (Players first, then spectators: they have the same state, and ordinary migration lets them take over. Players
    // alone: with the other player gone and a spectator linked, the host held its ticks and asked nobody for good.)
    let ok = computeHostMigrationCandidates(myPeerId).filter(pid => pid !== myPeerId && linked(pid)
        && !(typeof resyncHostIsJoining === 'function' && resyncHostIsJoining(pid)));
    let cands = ok.filter(pid => _migrationRoleOf(pid) === 'playing').concat(ok.filter(pid => _migrationRoleOf(pid) !== 'playing'));
    if (!cands.length) return false;
    _hostHandover = { cands, i: 0, reason: String(reason || ''), to: '', suspect: [], force: false };
    _hostHandoverNext();
    return true;
}
function _hostHandoverNext() {
    let h = _hostHandover;
    if (!h || !isHost || !gameStarted) return;
    for (; h.i < h.cands.length; h.i++) {
        let pid = h.cands[h.i], conn = connections.find(c => c && c.peer === pid && c.open !== false);
        if (!conn) continue;
        h.i++;
        h.to = pid;
        if (_hostHandoverSent.sessionId !== String(matchStartSessionId || '')) _hostHandoverSent = { sessionId: String(matchStartSessionId || ''), peers: new Set() };
        _hostHandoverSent.peers.add(pid);
        logLockstepWarning('Simulation lost: handing the match to a player', { to: pid, reason: h.reason });
        try { conn.send({ type: 'HOST_HANDOVER', sessionId: matchStartSessionId, reason: h.reason, force: h.force ? 1 : undefined }); } catch { }
        let epoch = networkSessionEpoch;
        setTimeout(() => { if (_hostHandover === h && h.to === pid && epoch === networkSessionEpoch && isHost) _hostHandoverNext(); }, HOST_HANDOVER_MS);
        return;
    }
    // (Every live simulation gone, or every one left known diverged: the match again from this page's checkpoint,
    // utils_checkpoint.js. Only without one does a diverged player take it, its state as it is (audit row 101).)
    if (!h.force && typeof netCheckpointRestoreSelf === 'function' && netCheckpointRestoreSelf(h.reason)) { _hostHandover = null; return; }
    if (!h.force && h.suspect.length) {
        logLockstepWarning('Simulation lost: no checkpoint; handing the match to a diverged player', { reason: h.reason });
        h.cands = h.suspect; h.suspect = []; h.i = 0; h.force = true;
        _hostHandoverNext();
        return;
    }
    _hostHandover = null;
    logLockstepWarning('Simulation lost: no player took the match over', { reason: h.reason });
    if (typeof setMatchLoadOverlay === 'function') setMatchLoadOverlay(true, 'Simulation stopped', 'No other player could take the match over.');
}
// Host: the player it handed the match to cannot take it (its own simulation lost): the next one at once.
function hostHandoverRefused(conn, data) {
    let h = _hostHandover;
    if (!isHost || !h || !conn || String(conn.peer || '') !== h.to) return;
    if (String((data && data.sessionId) || '') !== String(matchStartSessionId || '')) return;
    if (_hostHandoverSent.peers) _hostHandoverSent.peers.delete(h.to);
    // (Its state known diverged: asked again only when nothing else can take the match.)
    if (data && data.suspect && !h.force) h.suspect.push(h.to);
    h.to = '';
    _hostHandoverNext();
}
// Guest: our host hands us the match (its simulation lost).
function guestTakeHandedOverMatch(conn, data) {
    if (!gameStarted || gameOver || !conn) return;
    if (String((data && data.sessionId) || '') !== String(matchStartSessionId || '')) return;
    // (Already took it from this host: its retry (our answer late or lost) is answered again.)
    if (isHost) {
        if (_handedOverFrom.peer === conn.peer && _handedOverFrom.sessionId === String(matchStartSessionId || '')) {
            try { conn.send({ type: 'HOST_HANDOVER_DONE', sessionId: matchStartSessionId }); } catch { }
        }
        return;
    }
    if (conn.peer !== wsHostId) return;
    // (Its own simulation lost too: it says so, the host asks the next one, or runs the match again from its
    // checkpoint when nobody can: audit row 83.)
    if (typeof simClientLostPending === 'function' && simClientLostPending()) { try { conn.send({ type: 'HOST_HANDOVER_REFUSED', sessionId: matchStartSessionId }); } catch { } return; }
    // (Its own state known diverged (or its end unconfirmed): a healthy player, or the host's checkpoint, first. The
    // handover skipped the check an ordinary migration makes, and the diverged state became the match's: audit row
    // 101. Forced: nothing else can.)
    if (!(data && data.force) && typeof _migrationSelfDefers === 'function' && _migrationSelfDefers()) { try { conn.send({ type: 'HOST_HANDOVER_REFUSED', sessionId: matchStartSessionId, suspect: 1 }); } catch { } return; }
    promoteSelfToHost(conn.peer, false, { keepOldLink: true });
    _handedOverFrom = { sessionId: String(matchStartSessionId || ''), peer: String(conn.peer) };
    try { conn.send({ type: 'HOST_HANDOVER_DONE', sessionId: matchStartSessionId }); } catch { }
}
// Host: the player took the match: move there, for the whole match. (Any player it was handed to, the first
// answer: also one after the wait for it ran out; _hostHandoverSent.)
function hostHandoverDone(conn, data) {
    if (!isHost || !conn) return;
    if (String((data && data.sessionId) || '') !== String(matchStartSessionId || '')) return;
    let pid = String(conn.peer || '');
    let h = _hostHandover;
    let ours = (h && pid === h.to) || (_hostHandoverSent.sessionId === String(matchStartSessionId || '') && _hostHandoverSent.peers.has(pid));
    if (!ours) return;
    _hostHandover = null;
    _hostHandoverSent = { sessionId: '', peers: new Set() };
    demoteSelfToGuest(pid, { fullSync: true });
}
// Successor (host by a handover): the old host says the match went to another player it asked (that one's answer
// came first): two hosts otherwise; this page joins that one.
function hostHandoverMovedElsewhere(conn, data) {
    if (!isHost || !gameStarted || !conn) return false;
    if (String((data && data.sessionId) || '') !== String(matchStartSessionId || '')) return false;
    if (_handedOverFrom.peer !== conn.peer || _handedOverFrom.sessionId !== String(matchStartSessionId || '')) return false;
    let hid = String((data && data.hostId) || '');
    if (!hid || hid === myPeerId) return false;
    _handedOverFrom = { sessionId: '', peer: '' };
    demoteSelfToGuest(hid);
    return true;
}

// Host: another host runs this match (we were cut off and the others moved
// on): join it and bring our own guests along. (fullSync: this page has no
// state to resume from: the whole match, as a reload gets it.)
function demoteSelfToGuest(newHostId, opts = null) {
    if (!isHost || !gameStarted) return;
    let hid = String(newHostId || '');
    logLockstepWarning('Another host runs this match; joining it', { newHostId: hid });
    netCounters.hostMigrations++;
    // (Its state gone (a handover: fullSync): its own commands in bundles it sealed but never ran go along with its
    // join, with their ids (the new host leaves out any it ran). Its ledger counts a command as run once sealed, so
    // the rejoin left them out, and if the bundle never reached the successor nobody ran them: audit row 117.)
    if (opts && opts.fullSync && typeof netNoteSealedUnrunOwnCommands === 'function') netNoteSealedUnrunOwnCommands();
    for (let c of connections) {
        try { c.send({ type: 'HOST_MOVED', hostId: hid, sessionId: matchStartSessionId }); } catch { }
    }
    isHost = false;
    wsHostId = hid;
    if (typeof simClientSyncGlobals === 'function') simClientSyncGlobals();
    lockstepResyncPauseActive = false;
    lockstepResyncPendingAckByPeer = {};
    lockstepResyncSnapshotCache = null;
    lockstepHostPacketsByTick = {};
    lockstepHistoryByTick = {};
    lockstepHostWaitRequestByPeer = {};
    lockstepHostLateByTick = {};
    lockstepHostCarryByPeer = {};
    lockstepHostLastOnTimeAt = {};
    lockstepHostLastPacketAt = {};
    lockstepHostLastPacketTick = {};
    netDisconnectedSinceByPeer = {};
    guestHostLostAt = 0;
    let epoch = networkSessionEpoch;
    setTimeout(() => {
        if (epoch !== networkSessionEpoch || isHost || !gameStarted) return;
        joinGame(hid, opts && opts.fullSync ? { rejoin: true, fullSync: true } : { rejoin: true, migrate: true });
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
                hostLost: !isHost && guestConsidersHostLost(), successor,
                // (A host: its players still linked; two hosts each alone break the tie by id: hostMaybeSeekOtherHost.)
                players: isHost && gameStarted ? getActiveMatchPeerIds().filter(p => p !== myPeerId && connections.some(x => x && x.peer === p && x.open !== false)).length : undefined
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
    if (sameMatch && !_migrationMatchOver() && !isPeerExplicitlyRemoved(myPeerId) && guestConsidersHostLost()) {
        // (Our own end unconfirmed: the next one in our view takes over, the
        // asker itself if it is that one; we do only when nobody else can.)
        let deferring = _migrationSelfDefers();
        let successor = _successorFromMyView(meta.failed, deferring);
        if (deferring && successor) { answerHostSeek(conn, successor); return; }
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
    let finish = (hostId, reply = null) => {
        if (finished) return;
        finished = true;
        for (let c of conns) { try { c.close(); } catch { } }
        done(hostId || '', reply);
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
                if (d.isHost && hid && hid !== myPeerId) { finish(hid, d); return; }
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
    seekMatchHost(missing.concat(alone ? spectators : []), sessionId, (hostId, reply) => {
        _hostSeekActive = false;
        if (!hostId || epoch !== networkSessionEpoch || !isHost || !gameStarted || gameOver || matchStartSessionId !== sessionId) return;
        let stillAlone = !participants.some(pid => connections.some(c => c && c.peer === pid));
        // (Alone, it joins a host that has players; of two hosts both alone (their probes crossed as a split healed)
        // only the larger id moves: each gave up hosting for the other's match, and nobody hosted.)
        // One order both hosts read alike: more linked players stays, a tie goes to the smaller id. (The lone host
        // yielded to the one with players while that one yielded to the smaller id: both demoted, audit row 119.)
        let otherAlone = !!reply && reply.players === 0;
        if (reply && Number.isFinite(reply.players)) {
            const mine = participants.filter(pid => connections.some(c => c && c.peer === pid && c.open !== false)).length;
            if (reply.players > mine || (reply.players === mine && hostId < myPeerId)) demoteSelfToGuest(hostId);
            return;
        }
        if ((stillAlone && !otherAlone) || hostId < myPeerId) demoteSelfToGuest(hostId);
    });
}

// Host: its peer closed for good (not a signaling hiccup: a closed peer cannot reconnect). Every link went with it;
// its players move the match to the first successor in the order they share. This page kept the host role with no
// peer: it could neither seek that host (hostMaybeSeekOtherHost needs a peer) nor be found, two hosts for good
// (audit row 90). It joins the successor as a migrating player (a new peer; the successor takes over at once,
// having lost this host too), whose snapshot replaces the ticks run here alone.
const HOST_PEER_CLOSED_JOIN_MS = HOST_MIGRATION_CANDIDATE_SILENT_MS + 1000;
function hostAfterPeerClosed() {
    if (!isHost || !gameStarted || gameOver) return;
    const session = String(matchStartSessionId || ''), epoch = networkSessionEpoch;
    logLockstepWarning('This host lost its peer; joining the match where its players move it', {});
    setTimeout(() => {
        if (!isHost || !gameStarted || gameOver || String(matchStartSessionId || '') !== session) return;
        // (A new peer came meanwhile (initPeer): its links are this host's again.)
        if (peer && epoch !== networkSessionEpoch) return;
        const cands = computeHostMigrationCandidates(myPeerId).filter(pid => pid !== myPeerId);
        if (!cands.length) return;
        demoteSelfToGuest(cands[0]);
    }, HOST_PEER_CLOSED_JOIN_MS);
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
    if (!rec || gameStarted || isHost || !_recordRecoveryMore()) return false;
    if (_recordRecoveryTries++ === 0) _recordRecoveryStartedAt = performance.now();
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
        if (_recordRecoveryMore()) {
            setTimeout(() => {
                if (epoch !== networkSessionEpoch || gameStarted) return;
                if (!tryRecoverMatchFromRecord(missing)) { _recordRecoveryTries = 0; _returnToMainMenuWithStatus('Could not find that game. It may have ended, or the link is wrong.', '#f66'); }
            }, 2000);
            return;
        }
        _recordRecoveryTries = 0;
        _returnToMainMenuWithStatus('Could not find that game. It may have ended, or the link is wrong.', '#f66');
    });
    return true;
}

// "peer-unavailable" errors name the peer that could not be reached.
function peerIdFromUnavailableError(err) {
    let m = String((err && err.message) || '').match(/peer\s+(\S+)\s*$/i);
    return m ? m[1] : '';
}
