"use strict";

// ============================================================
// DESYNC DETECTION AND REPAIR
//
// Every peer hashes one slice of the state each tick (snapTickHash). The
// host's per-tick sums ride along on its tick bundles; a guest compares them
// with its own.
//
// When a guest differs, nobody pauses:
// 1. The guest sends its last rotation of bucket hashes (RESYNC_REQUEST) and
//    keeps playing.
// 2. The host compares them with its own, picks a tick T a little ahead, and
//    answers RESYNC_AT. The bundle of T tells every peer to drop the caches
//    whose hits change outcomes (snapFlushHistoryCaches), so all of them
//    start T with the same (empty) caches.
// 3. Just before running T, the host encodes the differing regions (or, when
//    that did not help, everything) and sends RESYNC_PATCH.
// 4. The guest stops at T until the patch is there, applies it and goes on.
//    Its input packets keep going out meanwhile, so no one waits for it.
// The host keeps what each guest's last patch carried. A new mismatch soon
// after it that hits the same things means the patch did not hold; twice
// escalates to a full patch for that guest, and full patches that do not
// hold to reloading the match on that guest alone. A mismatch
// elsewhere is divergence that spread while the patch was on its way, and
// is simply patched too.
// ============================================================

// How long a guest stopped at its patch tick waits for the patch before it
// goes on without it (and asks again): the patch is sent when the host
// reaches that tick, normally before the guest does, so this only covers a
// lost message. Longer for full patches, which can be large.
const RESYNC_PATCH_WAIT_MS = 2000;
const RESYNC_FULL_PATCH_WAIT_MS = 8000;
const RESYNC_REQUEST_RETRY_MS = 2500;
// A patch that is followed by another mismatch this soon did not fix it.
const RESYNC_FAILURE_WINDOW_TICKS = 60;
const RESYNC_FULL_AFTER_FAILURES = 2;
const RESYNC_GLOBAL_AFTER_FULL_FAILURES = 2;
// Reloading the match is the heaviest step for that guest; when even that
// does not hold (a persistent bug on it), keep to full patches for a while.
const RESYNC_GLOBAL_MIN_INTERVAL_MS = 60000;

// Host: pending patches per guest peer id: { T, codes: Set, full, id }.
let resyncHostPending = new Map();
// Host: per guest peer id, the last patch and the escalation state.
let resyncHostPeers = new Map();
// Host: players joining a running match (page reload, lost state): not waited
// for until they have caught up. peer id -> since.
let resyncHostJoining = new Map();
const RESYNC_JOIN_MAX_CATCH_UP_MS = 30000;
// Host: ticks whose bundles carry the cache flush.
let resyncHostFlushTicks = new Set();
// Host: tick hash sums not yet sent ([tick, sum, ...]).
let _resyncHostHashQueue = [];
let _resyncHostHashesSentAt = 0;
let _resyncPatchSeq = 0;

// Guest state.
let resyncGuest = null;

function resyncResetState() {
    resyncHostPending = new Map();
    resyncHostPeers = new Map();
    resyncHostJoining = new Map();
    resyncHostFlushTicks = new Set();
    _resyncHostHashQueue = [];
    _resyncHostHashesSentAt = 0;
    resyncGuest = {
        outstanding: false, requestedAt: 0, requestId: 0,
        T: -1, patchId: 0, patch: null, full: false, waitSince: 0, divergedAt: -1, lastHashedTick: -1,
        graceTick: -1, lastPatchTick: -1, patches: 0, fullPatches: 0, forceFull: false, lastChanged: [],
        joining: false, joinTick: -1, awaitingLive: false, liveFromTick: -1, heldActions: []
    };
    snapResetHashHistory();
}
resyncResetState();

// After a snapshot restore (start, join, match-wide resync): only ticks from
// here on are compared.
function resyncNoteRestored(tick) {
    let t = Math.floor(Number(tick) || 0);
    for (let peer of resyncHostPeers.values()) { peer.lastT = -1; peer.carried = null; peer.failures = 0; peer.fullFailures = 0; }
    resyncGuest.graceTick = Math.max(resyncGuest.graceTick, t);
    resyncGuest.outstanding = false;
    resyncGuest.T = -1;
    resyncGuest.patch = null;
    resyncGuest.waitSince = 0;
    resyncGuest.divergedAt = -1;
    lockstepExpectedStateHashByTick = {};
    lockstepLocalStateHashByTick = {};
    snapResetHashHistory();
}

// ---------------------------------------------------------------------------
// Per-tick hashing (both sides)
// ---------------------------------------------------------------------------

// Called after every simulated tick in multiplayer.
function resyncAfterTick(tick) {
    let r = snapRecordTickHash(tick);
    if (isHost) {
        _resyncHostHashQueue.push(r.tick, r.sum);
        if (_resyncHostHashQueue.length > 400) _resyncHostHashQueue.splice(0, _resyncHostHashQueue.length - 400);
        return;
    }
    lockstepLocalStateHashByTick[r.tick] = r.sum;
    resyncGuest.lastHashedTick = r.tick;
    if (resyncGuest.joining) resyncGuestMaybeLive();
    resyncGuestCompare(r.tick);
    resyncGuestMaybeRequest(performance.now());
    // Drop comparisons that can no longer complete.
    if ((r.tick & 63) === 0) {
        let before = r.tick - 400;
        for (let k in lockstepExpectedStateHashByTick) if (+k < before) delete lockstepExpectedStateHashByTick[k];
        for (let k in lockstepLocalStateHashByTick) if (+k < before) delete lockstepLocalStateHashByTick[k];
    }
}

// Host: the tick sums queued since the last message, for a bundle to carry.
function resyncTakeHostHashes() {
    if (_resyncHostHashQueue.length === 0) return null;
    let out = _resyncHostHashQueue;
    _resyncHostHashQueue = [];
    _resyncHostHashesSentAt = performance.now();
    return out;
}

// Host: sums still queued after a while without bundles (the match waits for
// someone) go out on their own.
function resyncHostFlushHashes(now = performance.now()) {
    if (!isHost || _resyncHostHashQueue.length === 0 || (now - _resyncHostHashesSentAt) < 150) return;
    let h = resyncTakeHostHashes();
    for (let c of connections) {
        if (!c) continue;
        try { c.send({ type: 'TICK_HASHES', h }); } catch { }
    }
}

// Guest: host sums arrived.
function resyncGuestReceiveHashes(h) {
    if (isHost || !Array.isArray(h)) return;
    for (let i = 0; i + 1 < h.length; i += 2) {
        let t = Math.floor(Number(h[i]));
        if (!Number.isFinite(t) || t < 0) continue;
        lockstepExpectedStateHashByTick[t] = h[i + 1] >>> 0;
        resyncGuestCompare(t);
    }
}

function resyncGuestCompare(t) {
    let expected = lockstepExpectedStateHashByTick[t];
    let local = lockstepLocalStateHashByTick[t];
    if (expected === undefined || local === undefined) return;
    delete lockstepExpectedStateHashByTick[t];
    delete lockstepLocalStateHashByTick[t];
    let g = resyncGuest;
    if (t < g.graceTick) return;
    if (expected === local) return;
    netCounters.desyncsDetected++;
    netCounters.lastDesyncTick = t;
    if (lockstepStrictDebugMode) {
        // The host names what differs from these (then stops everyone).
        let hostConn = netGetHostConnection();
        if (hostConn) { try { hostConn.send({ type: 'RESYNC_REQUEST', tick: t, from: t, at: currentTick, rotation: snapHashRotation(t).filter(r => r.tick >= g.graceTick), full: false, id: 0 }); } catch { } }
        stopLockstepDebugMatch('state hash mismatch at tick ' + t, { tick: t, expected, local });
        return;
    }
    if (g.divergedAt < 0 || t < g.divergedAt) g.divergedAt = t;
    resyncGuestMaybeRequest(performance.now());
}

// Each tick hashes one slice of the regions, so a divergence shows in all of
// them only a rotation after it began: the request waits for that, so that
// one patch covers everything (players, projectiles and order are hashed
// every tick).
function resyncGuestMaybeRequest(now) {
    let g = resyncGuest;
    if (g.divergedAt < 0) return;
    // A patch is on its way; what diverged before it is repaired by it or
    // shows again after it.
    if (g.T >= currentTick || g.divergedAt < g.graceTick) { g.divergedAt = -1; return; }
    let upTo = g.lastHashedTick;
    if (upTo < g.divergedAt + SNAP_HASH_SLICES - 1 && !g.forceFull) return;
    if (g.outstanding && (now - g.requestedAt) < RESYNC_REQUEST_RETRY_MS) return;
    let from = g.divergedAt;
    g.divergedAt = -1;
    resyncGuestRequest(upTo, now, from);
}

// ---------------------------------------------------------------------------
// Guest: asking and applying
// ---------------------------------------------------------------------------
function resyncGuestRequest(tick, now, from = tick) {
    let g = resyncGuest;
    // A patch is on its way; mismatches before it are expected.
    if (g.T >= currentTick) return;
    if (g.outstanding && (now - g.requestedAt) < RESYNC_REQUEST_RETRY_MS) return;
    let hostConn = netGetHostConnection();
    if (!hostConn || !gameStarted || gameOver) return;
    let full = g.forceFull;
    g.forceFull = false;
    g.outstanding = true;
    g.requestedAt = now;
    g.requestId++;
    // Hashes from before the last restore describe a state since replaced.
    let rotation = full ? [] : snapHashRotation(tick).filter(r => r.tick >= g.graceTick);
    logLockstepWarning('State hash mismatch; asking for a patch', { tick, from, full });
    try {
        hostConn.send({ type: 'RESYNC_REQUEST', tick, from, at: currentTick, rotation, full, id: g.requestId });
    } catch { }
}

function resyncGuestHandleAt(data) {
    if (isHost || !gameStarted) return;
    let T = Math.floor(Number(data && data.tick));
    if (!Number.isFinite(T)) return;
    let g = resyncGuest;
    if (T < currentTick) {
        // Already past it: ask again for a later tick.
        g.outstanding = false;
        resyncGuestRequest(Math.max(0, currentTick - 1), performance.now());
        return;
    }
    g.T = T;
    g.patchId = Math.floor(Number(data.id) || 0);
    g.full = !!data.full;
    if (g.patch && g.patch.tick !== T) g.patch = null;
}

function resyncGuestHandlePatch(data) {
    if (isHost || !gameStarted) return;
    let T = Math.floor(Number(data && data.tick));
    let id = Math.floor(Number(data && data.id) || 0);
    if (!Number.isFinite(T)) return;
    netDecodeSnapshotPayload(data.payload).then(text => {
        if (!text) throw new Error('empty patch');
        let g = resyncGuest;
        if (T < currentTick || (g.T >= 0 && g.T !== T)) {
            // Too late for this one (or superseded): ask again.
            if (g.T === T || g.T < currentTick) { g.T = -1; g.outstanding = false; }
            return;
        }
        g.T = T;
        g.patchId = id;
        g.full = !!data.full;
        g.patch = { tick: T, text, bytes: netSnapshotPayloadBytes(data.payload) };
    }).catch(err => {
        logLockstepWarning('Could not decode a patch', { error: String(err && err.message || err) });
        resyncGuest.outstanding = false;
    });
}

// Guest pump, before running `tick`: true when the tick may run now.
function resyncGuestBeforeTick(tick, now) {
    let g = resyncGuest;
    if (isHost || g.T < 0) return true;
    if (tick < g.T) return true;
    if (tick > g.T) {
        // Passed it (a restore moved us on): the patch no longer applies.
        g.T = -1; g.patch = null; g.waitSince = 0; g.outstanding = false;
        return true;
    }
    if (!g.patch) {
        if (!g.waitSince) g.waitSince = now;
        let link = netGetHostLinkStats();
        let rtt = link && Number.isFinite(link.srtt) ? link.srtt + 4 * (link.rttvar || 0) : 500;
        if ((now - g.waitSince) > (g.full ? RESYNC_FULL_PATCH_WAIT_MS : RESYNC_PATCH_WAIT_MS) + rtt) {
            // Never came (lost link, host busy): continue and ask again later.
            netCounters.patchStallMaxMs = Math.max(netCounters.patchStallMaxMs, now - g.waitSince);
            logLockstepWarning('Patch did not arrive; continuing', { tick });
            g.T = -1; g.waitSince = 0; g.outstanding = false;
            return true;
        }
        return false;
    }
    let stall = g.waitSince ? now - g.waitSince : 0;
    netCounters.patchStallMs = stall;
    netCounters.patchStallMaxMs = Math.max(netCounters.patchStallMaxMs, stall);
    applyResyncPatch(g.patch.text, g.full);
    return true;
}

// Guest: restore the carried state (the patch was taken just before `T`).
function applyResyncPatch(text, full) {
    let g = resyncGuest;
    let t0 = performance.now();
    let S = JSON.parse(text);
    let uiState = _captureSnapshotApplyUiState();
    let before = new Map();
    for (let u of units) before.set(u, u.x * 65536 + u.y);
    let res = snapDecodeState(S, { collectChanges: !full });
    let tick = currentTick;
    netCounters.snapshotApplyMs = performance.now() - t0;
    netCounters.snapshotBytes = g.patch ? g.patch.bytes : text.length;
    netCounters.lastSnapshotAt = performance.now();
    if (full) netCounters.fullPatches++; else netCounters.patches++;
    netCounters.lastDesyncParts = res && res.changed ? res.changed.slice(0, 6).join(' | ') : (full ? 'full state' : '');
    if (full) g.fullPatches++; else g.patches++;
    g.lastChanged = res && res.changed ? res.changed.slice(0, 50) : [];
    if (res && res.missingRefs > 0) logLockstepWarning('Patch left references unresolved', { missing: res.missingRefs, tick });
    if (g.lastChanged.length > 0) logLockstepWarning('Patched diverged state', { tick, fields: g.lastChanged.slice(0, 12) });
    _restoreSnapshotApplyUiState(uiState, { unitsById: res ? res.unitsById : new Map(), towers, barracks, spawners: collectorSpawners, goldMines, astarMines });
    // Visual continuity: units the patch moved slide there over one tick.
    for (let u of units) {
        let prev = before.get(u);
        if (prev === undefined) continue;
        if (prev !== u.x * 65536 + u.y) { u.prevX = Math.floor(prev / 65536); u.prevY = prev - u.prevX * 65536; }
    }
    visibilityCacheTick = -1;
    updateVisibility(localPlayerId);
    dirtyGrid = true;
    _minimapStaticDirty = true;
    if (typeof requestBuildMenuRefresh === 'function') requestBuildMenuRefresh();
    g.T = -1;
    g.patch = null;
    g.waitSince = 0;
    g.outstanding = false;
    g.divergedAt = -1;
    g.lastPatchTick = tick;
    g.graceTick = tick;
    // Comparisons for ticks before the patch no longer mean anything.
    for (let k in lockstepExpectedStateHashByTick) if (+k < tick) delete lockstepExpectedStateHashByTick[k];
    for (let k in lockstepLocalStateHashByTick) if (+k < tick) delete lockstepLocalStateHashByTick[k];
    let hostConn = netGetHostConnection();
    if (hostConn) { try { hostConn.send({ type: 'RESYNC_PATCH_APPLIED', tick, id: g.patchId, ms: Math.round(netCounters.snapshotApplyMs), changed: g.lastChanged.slice(0, 20) }); } catch { } }
}

// ---------------------------------------------------------------------------
// Host: answering
// ---------------------------------------------------------------------------
function _resyncHostPeer(pid) {
    let peer = resyncHostPeers.get(pid);
    if (!peer) {
        peer = { lastT: -1, lastFull: false, carried: null, failures: 0, fullFailures: 0, lastGlobalAt: -Infinity };
        resyncHostPeers.set(pid, peer);
    }
    return peer;
}

// Whether differing codes point at what a patch carried (its regions,
// projectiles or grid): then the patch did not fix them. Players, globals
// and list orders are left out: divergence elsewhere changes them too.
function _resyncCodesHitCarried(codes, carried) {
    if (!carried) return false;
    for (let code of codes) {
        let part = Math.floor(code / SNAP_CODE_SHIFT);
        let index = code - part * SNAP_CODE_SHIFT;
        if (part === SNAP_PART_REGION && carried.regions.has(index)) return true;
        if (part === SNAP_PART_PROJECTILES && carried.projectiles) return true;
        if (part === SNAP_PART_GRID && carried.grid) return true;
    }
    return false;
}

function resyncHostHandleRequest(conn, data) {
    if (!isHost || !gameStarted || gameOver || !conn || !conn.peer) return;
    let pid = String(conn.peer);
    if (lockstepStrictDebugMode) {
        let t = Math.floor(Number(data && data.tick) || 0);
        let codes = new Set();
        for (let r of (Array.isArray(data && data.rotation) ? data.rotation : [])) {
            let mine = r && Array.isArray(r.pairs) ? snapGetTickHash(r.tick) : null;
            if (mine) for (let c of snapDiffTickHash(mine, r)) codes.add(c);
        }
        let differs = snapDescribeCodes(codes);
        let reason = 'state hash mismatch at tick ' + t + (differs.length ? ' in ' + differs.join('; ') : '');
        if (!lockstepFatalStopActive) {
            stopLockstepDebugMatch(reason, { tick: t, fromPeer: pid, differs });
        } else if (differs.length) {
            // Already stopped (the guest's stop notice came first): pass on
            // what differs.
            lockstepFatalStopReason = reason;
            for (let c of connections) { if (c) { try { c.send({ type: 'LOCKSTEP_FATAL_STOP', reason, tick: lockstepFatalStopTick }); } catch { } } }
        }
        return;
    }
    netCounters.desyncsDetected++;
    let tick = Math.floor(Number(data && data.tick) || 0);
    let from = Number.isFinite(Number(data && data.from)) ? Math.floor(Number(data.from)) : tick;
    netCounters.lastDesyncTick = from;
    let full = !!(data && data.full);
    let codes = new Set();
    if (!full) {
        let compared = 0;
        for (let r of (Array.isArray(data.rotation) ? data.rotation : [])) {
            if (!r || !Array.isArray(r.pairs)) continue;
            let mine = snapGetTickHash(r.tick);
            if (!mine) continue;
            compared++;
            for (let c of snapDiffTickHash(mine, r)) codes.add(c);
        }
        // Too old to compare (or it matches now): send everything.
        if (compared === 0 || codes.size === 0) full = true;
    }
    let pending = resyncHostPending.get(pid);
    if (pending && pending.T > currentTick + LOCKSTEP_HOST_PREBUILD_TICKS) {
        for (let c of codes) pending.codes.add(c);
        pending.full = pending.full || full;
    } else {
        let peer = _resyncHostPeer(pid);
        let now = performance.now();
        if (peer.lastT >= 0) {
            if (from <= peer.lastT + RESYNC_FAILURE_WINDOW_TICKS) {
                // Right after the last patch: did it hold?
                if (peer.lastFull) peer.fullFailures++;
                else if (_resyncCodesHitCarried(codes, peer.carried)) peer.failures++;
            } else {
                peer.failures = 0;
                peer.fullFailures = 0;
            }
            peer.lastT = -1;
        }
        if (peer.fullFailures >= RESYNC_GLOBAL_AFTER_FULL_FAILURES && (now - peer.lastGlobalAt) >= RESYNC_GLOBAL_MIN_INTERVAL_MS) {
            // Last resort: that guest reloads the whole match, as after a
            // page reload (everything rebuilt from scratch); the others play on.
            peer.lastGlobalAt = now;
            peer.failures = 0;
            peer.fullFailures = 0;
            logLockstepWarning('Patches do not hold for a guest; it reloads the match', { peerId: pid, tick: from });
            hostSendFullMatchSync(conn, normalizeMatchRole(matchRoleByPeerId[pid], 'playing'));
            return;
        }
        if (peer.failures >= RESYNC_FULL_AFTER_FAILURES || peer.fullFailures > 0) full = true;
        // Ahead of the guest and of every sealed bundle; the guest reported
        // where it was when it asked.
        let guestTick = Math.floor(Number(data && data.at) || 0);
        let link = netGetLinkStats(pid);
        let aheadTicks = link && Number.isFinite(link.srtt) ? Math.ceil(link.srtt / 2 / TICK_MS) : 2;
        let T = Math.max(currentTick + LOCKSTEP_HOST_PREBUILD_TICKS + 2, guestTick + aheadTicks + 2);
        pending = { T, codes, full, id: ++_resyncPatchSeq, requestedAt: now };
        resyncHostPending.set(pid, pending);
        resyncHostFlushTicks.add(T);
    }
    netCounters.lastDesyncParts = full ? 'full' : (codes.size + ' buckets');
    try { conn.send({ type: 'RESYNC_AT', tick: pending.T, id: pending.id, full: pending.full }); } catch { }
}

// Host pump, before running `tick`: encode and send the patches due now.
// Returns true when it did work (the caller may leave the tick to the next
// frame, so the patch and the tick do not share one frame).
function resyncHostBeforeTick(tick) {
    if (!isHost || resyncHostPending.size === 0) return false;
    let did = false;
    for (let [pid, pending] of resyncHostPending) {
        if (pending.T > tick) continue;
        resyncHostPending.delete(pid);
        if (pending.T < tick) continue; // missed (should not happen); the guest asks again
        let conn = connections.find(c => c && c.peer === pid);
        if (!conn || conn.open === false) continue;
        if (pending.join) { _resyncHostSendJoin(conn, pending); did = true; continue; }
        let t0 = performance.now();
        let buckets = pending.full ? null : snapBucketsFromCodes(pending.codes);
        let S = snapEncodeState(buckets ? { buckets } : null);
        let peer = _resyncHostPeer(pid);
        peer.lastT = pending.T;
        peer.lastFull = !!pending.full;
        peer.carried = buckets;
        let text = JSON.stringify(S);
        netCounters.snapshotBuildMs = performance.now() - t0;
        netCounters.lastSnapshotAt = performance.now();
        if (pending.full) netCounters.fullPatches++; else netCounters.patches++;
        did = true;
        let msg = { type: 'RESYNC_PATCH', tick: pending.T, id: pending.id, full: pending.full };
        if (text.length >= NET_SNAPSHOT_COMPRESS_MIN_BYTES) {
            netEncodeSnapshotText(text).then(payload => {
                netCounters.snapshotBytes = netSnapshotPayloadBytes(payload);
                try { conn.send({ ...msg, payload: netSnapshotPayloadForPeer(pid, payload, text) }); } catch { }
            });
        } else {
            netCounters.snapshotBytes = text.length;
            try { conn.send({ ...msg, payload: { json: text } }); } catch { }
        }
    }
    for (let t of resyncHostFlushTicks) if (t < tick - 600) resyncHostFlushTicks.delete(t);
    return did;
}

// Guest: while stopped at a patch tick, input packets still go out as if
// ticking, so the others never wait for us.
function resyncPacketHorizonTick(now = performance.now()) {
    let g = resyncGuest;
    if (isHost || g.T < 0 || !g.waitSince || currentTick !== g.T) return currentTick;
    return currentTick + Math.floor((now - g.waitSince) / TICK_MS);
}

// ---------------------------------------------------------------------------
// Joining a running match without pausing it
//
// A player with no usable state (page reload, too far behind for a replay)
// gets the whole match as of a tick T a little ahead, T's bundle tells every
// peer to drop its history caches (the joiner starts without them), the host
// resends the bundles since T, and the joiner catches up. Until it says it
// has, the host does not wait for its input.
// ---------------------------------------------------------------------------
function resyncHostScheduleJoin(conn, role) {
    if (!isHost || !conn || !conn.peer) return;
    let pid = String(conn.peer);
    let normalizedRole = normalizeMatchRole(role, 'spectating');
    if (normalizedRole === 'playing') resyncHostJoining.set(pid, performance.now());
    else resyncHostJoining.delete(pid);
    let T = currentTick + LOCKSTEP_HOST_PREBUILD_TICKS + 2;
    resyncHostPending.set(pid, { T, codes: new Set(), full: true, id: ++_resyncPatchSeq, requestedAt: performance.now(), join: normalizedRole });
    resyncHostFlushTicks.add(T);
}

// Host, at T: the match as a new player needs it.
function _resyncHostSendJoin(conn, pending) {
    let pid = String(conn.peer);
    let t0 = performance.now();
    let snapshot = buildHostAuthoritativeStateSnapshot({ includeConfig: true, includeStaticMapState: true, includeGridTypes: true });
    let text = JSON.stringify(snapshot);
    netCounters.snapshotBuildMs = performance.now() - t0;
    netCounters.lastSnapshotAt = performance.now();
    let message = { type: pending.join === 'spectating' ? 'START_SPECTATE' : 'START_GAME', ...buildHostMatchSyncPayload(), joinTick: pending.T };
    logLockstepWarning('Sending the match to a joining player', { peerId: pid, tick: pending.T, bytes: text.length });
    netEncodeSnapshotText(text).then(payload => {
        netCounters.snapshotBytes = netSnapshotPayloadBytes(payload);
        if (conn.open === false) return;
        try { conn.send({ ...message, snapshotPayload: netSnapshotPayloadForPeer(pid, payload, text) }); } catch { }
    });
}

// Host: the joiner restored the match at `tick`; send what was sealed since.
function resyncHostHandleJoinApplied(conn, data) {
    if (!isHost || !conn) return;
    let from = Math.max(0, Math.floor(Number(data && data.tick) || 0));
    for (let t = from; ; t++) {
        let resend = getHostResendBundleForTick(t);
        if (!resend) break;
        try { conn.send({ type: 'TICK_BUNDLE', w: packTickBundleForWire(resend.bundle), c: 1 }); } catch { }
    }
}

function resyncHostHandleJoinLive(conn) {
    if (!isHost || !conn) return;
    if (resyncHostJoining.delete(String(conn.peer))) logLockstepWarning('Joining player caught up', { peerId: String(conn.peer), tick: currentTick });
    // The first tick sealed only with its input.
    let first = currentTick;
    while (lockstepBundleByTick[first] || lockstepCommittedByTick[first]) first++;
    try { conn.send({ type: 'JOIN_LIVE_ACK', tick: first }); } catch { }
}

// Host: whether to wait for this peer's input yet.
function resyncHostIsJoining(pid, now = performance.now()) {
    let since = resyncHostJoining.get(pid);
    if (since === undefined) return false;
    if ((now - since) > RESYNC_JOIN_MAX_CATCH_UP_MS) { resyncHostJoining.delete(pid); return false; }
    return true;
}

// Guest: after restoring the match for a live join.
function resyncGuestJoined(tick) {
    let g = resyncGuest;
    g.joining = true;
    g.joinTick = tick;
    let hostConn = netGetHostConnection();
    if (hostConn) { try { hostConn.send({ type: 'JOIN_APPLIED', tick }); } catch { } }
}

// Guest: caught up with the bundles the host has sealed.
function resyncGuestMaybeLive() {
    let g = resyncGuest;
    if (!g.joining) return;
    let newest = currentTick;
    for (let k in lockstepPendingBundleByTick) { let t = +k; if (t > newest) newest = t; }
    if (newest - currentTick > 2) return;
    g.joining = false;
    g.awaitingLive = true;
    let hostConn = netGetHostConnection();
    if (hostConn) { try { hostConn.send({ type: 'JOIN_LIVE', tick: currentTick }); } catch { } }
}

// Guest: the host waits for our input from `tick` on; commands issued while
// catching up go out now, from there.
function resyncGuestHandleJoinLiveAck(data) {
    let g = resyncGuest;
    let tick = Math.floor(Number(data && data.tick));
    if (!Number.isFinite(tick)) return;
    g.awaitingLive = false;
    g.liveFromTick = tick;
    let held = g.heldActions;
    g.heldActions = [];
    for (let a of held) queueAction(a);
    if (gameStarted) sendLocalTickPacketWindow(currentTick, true);
}

// Guest: while joining, commands wait (the host would not wait for them).
function resyncGuestHoldAction(action) {
    let g = resyncGuest;
    if (isHost || !g || !(g.joining || g.awaitingLive)) return false;
    if (g.heldActions.length < 256) g.heldActions.push(action);
    return true;
}
