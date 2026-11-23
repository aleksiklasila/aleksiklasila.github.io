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
// for until they have caught up. peer id -> { since, g (the join's number),
// heard (its last JOIN_LOADING), applied (when it said JOIN_APPLIED: 0 while
// it loads), resent }.
let resyncHostJoining = new Map();
// Catching up (from JOIN_APPLIED): waited for after this long. Loading (not
// applied yet): not waited for while it says so; silent for
// RESYNC_JOIN_LOAD_SILENT_MS (or loading past RESYNC_JOIN_LOAD_MAX_MS) its
// join is sent again, once, then it is waited for as any player
// (resyncHostCheckJoins). The 30 s from the join's sending also ran while it
// loaded: a 45 s decode, and the host waited for a player with no state yet
// (20 -> ~10 TPS until it had loaded: audit 2026-10-17, 45).
const RESYNC_JOIN_MAX_CATCH_UP_MS = 30000;
const RESYNC_JOIN_LOAD_SILENT_MS = 45000, RESYNC_JOIN_LOAD_MAX_MS = 600000;
let _resyncHostJoinsCheckedAt = 0;
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
        joining: false, joinTick: -1, joinGen: 0, awaitingLive: false, liveFromTick: -1, heldActions: [], heldFinal: [], liveSentAt: 0,
        // (The newest repair id seen, and the host it came from: see
        // _resyncGuestFreshId.)
        maxId: 0, idHost: '',
        // (Ticks that threw here, and when the last one asked for a repair: resyncNoteTickFailed.)
        tickFailures: 0, failRepairAt: -Infinity,
        // (Its failed ticks waiting for the host's word on them; the host's
        // failed ticks heard of; the newest host hash's tick.)
        pendingFails: [], hostFails: [], hostHashTick: -1,
        // (A failed tick of its own whose repair the request interval held back: asked for once it allows.)
        failOwed: -1,
        // (Its state known to differ from the host's since the last repair (a mismatch, a failed tick of its own):
        // host migration passes it over while anyone else can take the match, resyncGuestStateSuspect.)
        suspect: false
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
    resyncGuest.suspect = false;
    resyncGuest.pendingFails.length = 0;
    resyncGuest.failOwed = -1;
    resyncGuest.hostFails.length = 0;
    resyncGuest.hostHashTick = -1;
    lockstepExpectedStateHashByTick = {};
    lockstepLocalStateHashByTick = {};
    snapResetHashHistory();
}

// ---------------------------------------------------------------------------
// Per-tick hashing (both sides)
// ---------------------------------------------------------------------------

// Called after every simulated tick in multiplayer. With the simulation
// worker, `record` is the hash it computed for the tick.
function resyncAfterTick(tick, record = null) {
    // (A join's JOIN_LIVE again while unanswered: every tick runs here.)
    if (!isHost && resyncGuest.awaitingLive) {
        let now = performance.now();
        if (now - resyncGuest.liveSentAt >= RESYNC_JOIN_LIVE_RETRY_MS) _resyncGuestSendLive(now);
    }
    // (Hashed ticks only: snapHashDue; and the last one, its end's: compared with the host's word on its end,
    // utils_networking.js guestReviewMatchResult.)
    if (!record && !snapHashDue(tick) && !gameOver) return;
    let r = record ? snapStoreTickHash(record) : snapRecordTickHash(tick);
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
        try { c.send({ type: 'TICK_HASHES', h, m: matchStartSessionId || undefined }); } catch { }
    }
}

// Guest: host sums arrived.
// (An entry of a negative tick, -1 - t: the host's tick t failed; it comes
// before t's own sum: resyncNoteTickFailed. Older guests skip it.)
function resyncGuestReceiveHashes(h) {
    if (isHost || !Array.isArray(h)) return;
    const g = resyncGuest;
    for (let i = 0; i + 1 < h.length; i += 2) {
        let t = Math.floor(Number(h[i]));
        if (!Number.isFinite(t)) continue;
        if (t < 0) { g.hostFails.push(-1 - t); if (g.hostFails.length > 64) g.hostFails.shift(); continue; }
        lockstepExpectedStateHashByTick[t] = h[i + 1] >>> 0;
        if (t > g.hostHashTick) g.hostHashTick = t;
        resyncGuestCompare(t);
    }
    if (g.pendingFails.length || g.failOwed >= 0) _resyncGuestSettleFails();
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
    g.suspect = true;
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
    if (upTo < g.divergedAt + SNAP_HASH_ROTATION_TICKS - 1 && !g.forceFull) return;
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
        hostConn.send({ type: 'RESYNC_REQUEST', tick, from, at: currentTick, rotation, full, id: g.requestId, m: matchStartSessionId || undefined });
    } catch { }
}

// A tick that threw part way (gameTick or its commands; page or worker): its
// state may be half updated anywhere, also where hashes look late or never
// (derived caches, tier lanes). The host tells its guests which of its own
// ticks failed (a marker in its hash stream, before that tick's sum). A
// guest whose tick failed where the host's did not asks for a full repair
// (as after a mismatch) as soon as it knows: the host's sum for that tick or
// a later one came without the marker. Failed on both alike (a deterministic
// bug: identical partial state), there is nothing to repair from, and the
// hashes still compare as ever. At most one such request a
// RESYNC_GLOBAL_MIN_INTERVAL_MS. The host has no one to repair from:
// counted and logged. (Before: a guest's failed tick counted as healthy and
// only a hash mismatch, if any, led to a repair: audit 2026-10-30, C.)
function resyncNoteTickFailed(tick, where) {
    const t = Math.floor(Number(tick) || 0);
    netCounters.tickFailures = (netCounters.tickFailures | 0) + 1;
    netCounters.lastTickFailure = t;
    if (!isMultiplayer || !gameStarted || gameOver) return;
    const g = resyncGuest, now = performance.now();
    g.tickFailures++;
    if (isHost) {
        _resyncHostHashQueue.push(-1 - t, 0);
        if (now - g.failRepairAt >= RESYNC_GLOBAL_MIN_INTERVAL_MS) { g.failRepairAt = now; logLockstepWarning('A tick failed on the host (no repair source)', { tick, where, failures: g.tickFailures }); }
        return;
    }
    if (g.pendingFails.length < 64) g.pendingFails.push(t);
    _resyncGuestSettleFails(where);
}
// Guest: its failed ticks the host's word has come for (its sum for that
// tick or later): failed there too, nothing to do; not, a full repair.
function _resyncGuestSettleFails(where = '') {
    const g = resyncGuest, P = g.pendingFails;
    let own = -1;
    for (let i = P.length - 1; i >= 0; i--) {
        const t = P[i];
        if (g.hostHashTick < t) continue;
        P.splice(i, 1);
        if (!g.hostFails.includes(t) && (own < 0 || t < own)) own = t;
    }
    // (One held back before: still owed, unless a restore since replaced the state it failed in. Before: taken off
    // the list and dropped while the interval ran, a second failure within it was never repaired.)
    if (g.failOwed >= 0 && g.failOwed >= g.graceTick && (own < 0 || g.failOwed < own)) own = g.failOwed;
    g.failOwed = -1;
    if (own < 0) return;
    g.suspect = true;
    const now = performance.now();
    if (lockstepStrictDebugMode) return;
    if (g.joining || now - g.failRepairAt < RESYNC_GLOBAL_MIN_INTERVAL_MS) { g.failOwed = own; return; }
    g.failRepairAt = now;
    logLockstepWarning('A tick failed here only; asking for a full repair', { tick: own, where, failures: g.tickFailures });
    g.forceFull = true;
    const t = Math.max(own, g.graceTick);
    if (g.divergedAt < 0 || t < g.divergedAt) g.divergedAt = t;
    resyncGuestMaybeRequest(now);
}

// Guest: its state is known to differ from the host's (not repaired since): it must not become the match's state
// while a peer whose state agreed can take over (audit row 87: a diverged guest won a host migration and its
// snapshot overwrote the healthy one's).
function resyncGuestStateSuspect() { return !isHost && !!(resyncGuest && (resyncGuest.suspect || resyncGuest.divergedAt >= 0 || resyncGuest.pendingFails.length || resyncGuest.failOwed >= 0)); }

// A repair message's id is current: not older than one already seen from
// this host (messages overtake each other: an older RESYNC_AT replaced a
// newer one, the guest then stopped at the older tick and asked again).
// Ids count per host: a new host (migration) starts them again.
function _resyncGuestFreshId(id) {
    let g = resyncGuest, host = String(wsHostId || '');
    if (g.idHost !== host) { g.idHost = host; g.maxId = 0; }
    if (id > 0 && id < g.maxId) return false;
    if (id > g.maxId) g.maxId = id;
    return true;
}

function resyncGuestHandleAt(data) {
    if (isHost || !gameStarted || !netMatchTagOk(data && data.m)) return;
    let T = Math.floor(Number(data && data.tick));
    if (!Number.isFinite(T)) return;
    let id = Math.floor(Number(data.id) || 0);
    if (!_resyncGuestFreshId(id)) return;
    let g = resyncGuest;
    // (Older than the repair waited for, its patch come first: changes
    // nothing.)
    if (g.T >= 0 && id < g.patchId) return;
    // (The simulation worker leaves that tick to the page from now on; it
    // may have run it by itself already, the page stalled.)
    if (typeof simClientAutoBarrier === 'function') simClientAutoBarrier(T);
    if (T < currentTick || (typeof simClientTickFree === 'function' && !simClientTickFree(T))) {
        // Already past it: ask again for a later tick (an older repair
        // waited for is superseded by it).
        g.T = -1; g.patch = null;
        g.outstanding = false;
        resyncGuestRequest(Math.max(0, currentTick - 1), performance.now());
        return;
    }
    g.T = T;
    g.patchId = id;
    g.full = !!data.full;
    // (Announcement and patch go by the repair's id: its patch may have
    // come first, and waiting for it again stalled the guest.)
    if (g.patch && g.patch.id !== id) g.patch = null;
}

function resyncGuestHandlePatch(data) {
    if (isHost || !gameStarted || !netMatchTagOk(data && data.m)) return;
    let T = Math.floor(Number(data && data.tick));
    let id = Math.floor(Number(data && data.id) || 0);
    if (!Number.isFinite(T)) return;
    if (!_resyncGuestFreshId(id)) return;
    // (The state it was asked for: a reset (a new match, a restore of the
    // whole match), a newer repair or another host (a migration) while it
    // decodes makes it obsolete; installed into the reset state it was
    // applied to the wrong match.)
    let g0 = resyncGuest, session = matchStartSessionId, host = String(wsHostId || '');
    netDecodeSnapshotPayload(data.payload).then(text => {
        if (!text) throw new Error('empty patch');
        let g = resyncGuest;
        if (g !== g0 || matchStartSessionId !== session || String(wsHostId || '') !== host || g.idHost !== host || !gameStarted || isHost || id < g.maxId) return;
        // (Older than the repair waited for: superseded.)
        if (g.T >= 0 && id < g.patchId) return;
        // A newer valid repair supersedes the one waited for, whichever of
        // its announcement and patch came first (one that came before its
        // announcement was dropped, the guest then waited for it again).
        if (typeof simClientAutoBarrier === 'function') simClientAutoBarrier(T);
        if (T < currentTick || (typeof simClientTickFree === 'function' && !simClientTickFree(T))) {
            // Too late for this one: ask again.
            if (g.patchId === id || g.T < currentTick) { g.T = -1; g.patch = null; g.outstanding = false; }
            return;
        }
        g.T = T;
        g.patchId = id;
        g.full = !!data.full;
        g.patch = { id, tick: T, text, bytes: netSnapshotPayloadBytes(data.payload) };
    }).catch(err => {
        logLockstepWarning('Could not decode a patch', { error: String(err && err.message || err) });
        if (resyncGuest === g0) resyncGuest.outstanding = false;
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
    // (One that throws (malformed: parsing, applying) is dropped: it was
    // kept and tried again at every pump, the page's ticks held for good,
    // and the wait for a missing patch never applied, one being there.)
    let id = g.patchId;
    try { applyResyncPatch(g.patch.text, g.full); }
    catch (err) { _resyncGuestPatchFailed(tick, id, err); }
    return true;
}

// A patch that could not be applied (it threw: malformed, or the state it
// met): dropped, and the whole match asked for (what it changed before it
// threw is unknown). Audit 2026-10-16, 30.
function _resyncGuestPatchFailed(tick, id, err) {
    let g = resyncGuest;
    _resyncGuestPatchTaken();
    g.outstanding = false;
    g.divergedAt = -1;
    netCounters.patchesFailed = (netCounters.patchesFailed | 0) + 1;
    logLockstepWarning('A patch could not be applied; asking for the match', { tick, id, error: String(err && err.message || err) });
    lockstepResyncRequestedAt = 0;
    if (typeof requestHardLockstepResync === 'function') requestHardLockstepResync(currentTick, 'patch failed');
}

// Guest: restore the carried state (the patch was taken just before `T`).
function applyResyncPatch(text, full) {
    let g = resyncGuest;
    let t0 = performance.now();
    // With the simulation worker, the worker applies it: the page sees the
    // result in the next frame and records.
    if (typeof simClientActive === 'function' && simClientActive()) {
        // (Counted and acknowledged once the worker says it took it: a patch
        // its decoder refuses (another format or rules) was counted as
        // applied, and the host told so.)
        let bytes = g.patch ? g.patch.bytes : text.length, tick = currentTick, id = g.patchId;
        _resyncGuestPatchSettle(tick);
        simClientAfterPatchApplied(text, full).then(ok => {
            if (resyncGuest !== g) return;
            if (!ok) { _resyncGuestPatchRefused(tick, id); return; }
            netCounters.snapshotApplyMs = performance.now() - t0;
            netCounters.snapshotBytes = bytes;
            netCounters.lastSnapshotAt = performance.now();
            if (full) { netCounters.fullPatches++; g.fullPatches++; } else { netCounters.patches++; g.patches++; }
            netCounters.lastDesyncParts = full ? 'full state' : '';
            g.lastChanged = [];
            _resyncGuestPatchAck(tick, id);
        }, err => {
            // (It threw in the worker; a worker lost or a match restarted
            // settles it otherwise.)
            if (resyncGuest !== g || !simClientActive()) return;
            _resyncGuestPatchFailed(tick, id, err);
        });
        return;
    }
    let S = JSON.parse(text);
    let uiState = _captureSnapshotApplyUiState();
    // Where each unit was drawn, so ones the patch moves slide there.
    let before = new Map();
    for (let u of units) before.set(u, [u.x, u.y]);
    let res = snapDecodeState(S, { collectChanges: !full });
    let tick = currentTick;
    // (Refused by the decoder: another format or rules. Nothing changed;
    // neither counted nor acknowledged as applied.)
    if (!res) { _resyncGuestPatchTaken(); _resyncGuestPatchRefused(tick, g.patchId); return; }
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
        if (prev[0] !== u.x || prev[1] !== u.y) { u.prevX = prev[0]; u.prevY = prev[1]; }
    }
    visibilityCacheTick = -1;
    updateVisibility(localPlayerId);
    dirtyGrid = true;
    _minimapStaticDirty = true;
    if (typeof requestBuildMenuRefresh === 'function') requestBuildMenuRefresh();
    if (typeof reviewLocalDefeat === 'function') reviewLocalDefeat();
    _resyncGuestPatchDone(tick);
}

// The patch for T taken (applied now, or by the worker): no longer waited
// for at T.
function _resyncGuestPatchTaken() {
    let g = resyncGuest;
    g.T = -1;
    g.patch = null;
    g.waitSince = 0;
}
// A patch its decoder refused: not applied, so not acknowledged; asked for
// again when a mismatch shows next.
function _resyncGuestPatchRefused(tick, id) {
    let g = resyncGuest;
    g.outstanding = false;
    netCounters.patchesRefused = (netCounters.patchesRefused | 0) + 1;
    logLockstepWarning('A patch was refused by the decoder (another format or rules); not applied', { tick, id });
}
// A patch applied at `tick` (or handed to the worker, which applies it
// before that tick): what was compared before it no longer counts.
function _resyncGuestPatchSettle(tick) {
    let g = resyncGuest;
    _resyncGuestPatchTaken();
    g.outstanding = false;
    g.divergedAt = -1;
    g.lastPatchTick = tick;
    g.suspect = false;
    g.graceTick = Math.max(g.graceTick, tick);
    // Comparisons for ticks before the patch no longer mean anything.
    for (let k in lockstepExpectedStateHashByTick) if (+k < tick) delete lockstepExpectedStateHashByTick[k];
    for (let k in lockstepLocalStateHashByTick) if (+k < tick) delete lockstepLocalStateHashByTick[k];
}
// The guest's bookkeeping once a patch is applied (at `tick`).
function _resyncGuestPatchDone(tick, id = resyncGuest.patchId) {
    _resyncGuestPatchSettle(tick);
    _resyncGuestPatchAck(tick, id);
}
function _resyncGuestPatchAck(tick, id) {
    let hostConn = netGetHostConnection();
    if (hostConn) { try { hostConn.send({ type: 'RESYNC_PATCH_APPLIED', tick, id, ms: Math.round(netCounters.snapshotApplyMs), changed: resyncGuest.lastChanged.slice(0, 20) }); } catch { } }
}

// ---------------------------------------------------------------------------
// Host: answering
// ---------------------------------------------------------------------------
function _resyncHostPeer(pid) {
    let peer = resyncHostPeers.get(pid);
    if (!peer) {
        peer = { lastT: -1, lastFull: false, carried: null, failures: 0, fullFailures: 0, lastGlobalAt: -Infinity, lastCodes: null };
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

// Whether a request names a part the last one named too (any part: players, globals, list orders included): the
// same difference back after its patch. (Left out of _resyncCodesHitCarried, a guest-only player difference that
// came back after every patch got partial patches for good, ~one a second, never a full one or a reload: audit
// row 84.)
function _resyncCodesRecur(codes, last) {
    if (!last || !last.size) return false;
    for (let code of codes) if (last.has(code)) return true;
    return false;
}

function resyncHostHandleRequest(conn, data) {
    if (!isHost || !gameStarted || gameOver || !conn || !conn.peer || !netMatchTagOk(data && data.m)) return;
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
            if (lockstepFatalStopDetails) lockstepFatalStopDetails.detailed = true;
            for (let c of connections) { if (c) { try { c.send({ type: 'LOCKSTEP_FATAL_STOP', reason, tick: lockstepFatalStopTick, detailed: true }); } catch { } } }
        }
        return;
    }
    netCounters.desyncsDetected++;
    let tick = Math.floor(Number(data && data.tick) || 0);
    let from = Number.isFinite(Number(data && data.from)) ? Math.floor(Number(data.from)) : tick;
    netCounters.lastDesyncTick = from;
    let full = !!(data && data.full);
    let codes = new Set();
    // (The earliest hashed tick that differed: a unit seen differing in a region then may have moved on by the
    // patch's tick, the regions widened by what it could cover since: snapEncodeState, buckets.ageTicks.)
    let oldest = Infinity;
    if (!full) {
        let compared = 0;
        for (let r of (Array.isArray(data.rotation) ? data.rotation : [])) {
            if (!r || !Array.isArray(r.pairs)) continue;
            let mine = snapGetTickHash(r.tick);
            if (!mine) continue;
            compared++;
            let d = snapDiffTickHash(mine, r);
            if (d.length > 0 && Number.isFinite(Number(r.tick))) oldest = Math.min(oldest, Math.floor(Number(r.tick)));
            for (let c of d) codes.add(c);
        }
        // Too old to compare (or it matches now): send everything.
        if (compared === 0 || codes.size === 0) full = true;
    }
    let pending = resyncHostPending.get(pid);
    // (A join for this peer scheduled or on its way: it replaces the whole state, the patch is moot. A request older
    // than the join (delayed) replaced the scheduled join with a patch while the join stayed counted as on its way,
    // and every request after it was taken for a repeat: the guest stood for good, audit row 108.)
    if ((pending && pending.join) || resyncHostJoinInFlight(pid)) { netCounters.patchForJoinIgnored = (netCounters.patchForJoinIgnored | 0) + 1; return; }
    if (pending && pending.T > currentTick + LOCKSTEP_HOST_PREBUILD_TICKS) {
        for (let c of codes) pending.codes.add(c);
        if (oldest < (pending.oldest ?? Infinity)) pending.oldest = oldest;
        pending.full = pending.full || full;
    } else {
        let peer = _resyncHostPeer(pid);
        let now = performance.now();
        if (peer.lastT >= 0) {
            const recur = _resyncCodesRecur(codes, peer.lastCodes);
            if (from <= peer.lastT + RESYNC_FAILURE_WINDOW_TICKS) {
                // Right after the last patch: did it hold?
                if (peer.lastFull) peer.fullFailures++;
                else if (recur || _resyncCodesHitCarried(codes, peer.carried)) peer.failures++;
            } else if (recur) {
                // (Later, but the same parts again: it did not hold either.)
                if (peer.lastFull) peer.fullFailures++; else peer.failures++;
            } else {
                peer.failures = 0;
                peer.fullFailures = 0;
            }
            peer.lastT = -1;
        }
        // (A full request names no parts: the last partial one's stay to compare with.)
        if (codes.size) peer.lastCodes = new Set(codes);
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
        let T = Math.max(_resyncHostFirstOpenTick() + 1, guestTick + aheadTicks + 2);
        pending = { T, codes, full, id: ++_resyncPatchSeq, requestedAt: now, oldest };
        resyncHostPending.set(pid, pending);
        resyncHostFlushTicks.add(T);
    }
    netCounters.lastDesyncParts = full ? 'full' : (codes.size + ' buckets');
    try { conn.send({ type: 'RESYNC_AT', tick: pending.T, id: pending.id, full: pending.full, m: matchStartSessionId || undefined }); } catch { }
}

// Host: the first tick no bundle is sealed for yet: past what this page
// seals ahead, and past what its simulation worker sealed or ran by itself
// while the page was stalled (it takes no more from here to the next pump,
// which bounds it by the tick planned here: main.js lockstepAutoLimit).
function _resyncHostFirstOpenTick() {
    let open = currentTick + LOCKSTEP_HOST_PREBUILD_TICKS + 1;
    return typeof simClientAutoFreeze === 'function' ? Math.max(open, simClientAutoFreeze() + 1) : open;
}

// Host pump, before running `tick`: encode and send the patches due now.
// Returns true when it did work (the caller may leave the tick to the next
// frame, so the patch and the tick do not share one frame).
function resyncHostBeforeTick(tick) {
    if (isHost && resyncHostJoining.size) resyncHostCheckJoins(performance.now());
    if (!isHost || resyncHostPending.size === 0) return false;
    let did = false;
    for (let [pid, pending] of resyncHostPending) {
        if (pending.T > tick) continue;
        resyncHostPending.delete(pid);
        if (pending.T < tick) {
            // Missed (should not happen): a patch, the guest asks again; a join (counted as on its way, so a request
            // is a repeat of it) is made again.
            if (pending.join) { const c = connections.find(c => c && c.peer === pid && c.open !== false); if (c) resyncHostScheduleJoin(c, pending.join); else resyncHostJoining.delete(pid); }
            continue;
        }
        let conn = connections.find(c => c && c.peer === pid && c.open !== false) || connections.find(c => c && c.peer === pid);
        if (!conn || conn.open === false) {
            // (A join that cannot go (the link closed before its tick): no longer on its way. Counted as on its way
            // without ever being sent, it held every request of the reconnected guest off for good: audit row 126.)
            if (pending.join) { const j = resyncHostJoining.get(pid); if (j && j.g === pending.g && !j.sentAt) resyncHostJoining.delete(pid); }
            continue;
        }
        if (pending.join) { _resyncHostSendJoin(conn, pending); did = true; continue; }
        let t0 = performance.now();
        let buckets = pending.full ? null : snapBucketsFromCodes(pending.codes);
        // (How old the differences are at T: the encoder widens the regions by the units' reach since.)
        if (buckets && Number.isFinite(pending.oldest)) buckets.ageTicks = Math.max(0, pending.T - pending.oldest);
        // The small parts always go along: a divergence reaches players'
        // resources (bounties, costs), projectiles and globals soon after
        // it starts, often after the guest reported, which would take
        // another round trip.
        if (buckets) { buckets.players = true; buckets.projectiles = true; buckets.globals = true; }
        let peer = _resyncHostPeer(pid);
        peer.lastT = pending.T;
        peer.lastFull = !!pending.full;
        peer.carried = buckets;
        if (pending.full) netCounters.fullPatches++; else netCounters.patches++;
        did = true;
        let msg = { type: 'RESYNC_PATCH', tick: pending.T, id: pending.id, full: pending.full, m: matchStartSessionId || undefined };
        let send = text => {
            netCounters.snapshotBuildMs = performance.now() - t0;
            netCounters.lastSnapshotAt = performance.now();
            if (text.length >= NET_SNAPSHOT_COMPRESS_MIN_BYTES) {
                netEncodeSnapshotText(text).then(payload => {
                    netCounters.snapshotBytes = netSnapshotPayloadBytes(payload);
                    try { conn.send({ ...msg, payload: netSnapshotPayloadForPeer(pid, payload, text) }); } catch { }
                });
            } else {
                netCounters.snapshotBytes = text.length;
                try { conn.send({ ...msg, payload: { json: text } }); } catch { }
            }
        };
        // With the simulation worker, the worker encodes it (the page's copy
        // does not hold every field exactly); the request goes before tick T.
        if (typeof simClientActive === 'function' && simClientActive()) simClientEncodePatch(buckets).then(send, () => { });
        else send(JSON.stringify(snapEncodeState(buckets ? { buckets } : null)));
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
function resyncHostScheduleJoin(conn, role, opts = null) {
    if (!isHost || !conn || !conn.peer) return;
    let pid = String(conn.peer);
    if (typeof hostNotePeerHasMatch === 'function') hostNotePeerHasMatch(pid);
    let normalizedRole = normalizeMatchRole(role, 'spectating');
    // (The join's number, from the recoveries' count: the joiner takes a
    // join once, and none older than one it took, and tags its join
    // messages with it: a replayed join of an earlier match froze a
    // rematch, audit 2026-10-17, 42.)
    let gen = typeof _hostNextResyncGen === 'function' ? _hostNextResyncGen() : 0;
    if (normalizedRole === 'playing') resyncHostJoining.set(pid, { since: performance.now(), g: gen, heard: 0, applied: 0, resent: (opts && opts.resent) || 0 });
    else resyncHostJoining.delete(pid);
    let T = _resyncHostFirstOpenTick() + 1;
    // (A join during the start's initialization ticks: the joiner's barrier is done once it has the match
    // (applyIncomingMatchSyncPayload); the host's barrier waits for it no more: utils_networking.js _matchInitializationPoll.)
    if (typeof _matchInit !== 'undefined' && _matchInit && _matchInit.exempt && !_matchInit.released) _matchInit.exempt[pid] = true;
    resyncHostPending.set(pid, { T, codes: new Set(), full: true, id: ++_resyncPatchSeq, requestedAt: performance.now(), join: normalizedRole, g: gen });
    resyncHostFlushTicks.add(T);
}

// Host, at T: the match as a new player needs it.
function _resyncHostSendJoin(conn, pending) {
    let pid = String(conn.peer);
    let t0 = performance.now();
    // With the simulation worker, the state is the worker's, encoded and
    // stringified there (simClientSnapshotText): the page encoded its own
    // copy first, threw it away, and stringified the worker's state here
    // (200k units: seconds on the host's main thread, ~78 MB: audit
    // 2026-10-17, 44).
    let inWorker = typeof simClientActive === 'function' && simClientActive();
    // (Numbered as it is made, not as it was scheduled: one scheduled before a match-wide pause and made after it
    // carried a number below the pause's, and the guest dropped it as an older recovery's: the old host of a
    // handover waited for the next join (multiplayer-worker-hang handover-late).)
    if (!pending.final && typeof _hostNextResyncGen === 'function') {
        const j0 = resyncHostJoining.get(pid), g = _hostNextResyncGen();
        if (j0 && j0.g === pending.g) j0.g = g;
        pending.g = g;
    }
    // (The match and result as of now: the encode may take long, and what it sends is of now. A final state's
    // result read when its encode finished was a rematch's (its id, no winner), and the guest reloaded that
    // rematch over and over: audit row 93. Of another match by then: not sent at all.)
    const session = String(matchStartSessionId || ''), result = pending.final ? hostMatchResultMessage() : null;
    // (A newer join for this peer since: this one is not sent.)
    let superseded = () => { let j = pending.final ? _resyncHostFinals.get(pid) : resyncHostJoining.get(pid); return String(matchStartSessionId || '') !== session || (!!j && j.g !== pending.g); };
    // (Not sent after all (its encode failed, its link closed): no longer on its way, the next request makes another.
    // Counted as on its way until sent, such a join would hold every request off for good.)
    // A snapshot that failed to build or encode (err) is made again: the player waits for this join (a reload has no
    // match to ask from again), and the host waits for its input once the join is gone: the match stood at the
    // failure for good (audit row 107). A closed link: dropped, the next request makes another.
    let drop = err => {
        const map = pending.final ? _resyncHostFinals : resyncHostJoining, j = map.get(pid);
        if (!(j && j.g === pending.g && !j.sentAt)) return;
        map.delete(pid);
        if (err === undefined) return;
        logLockstepWarning('A join snapshot failed; making it again', { peerId: pid, error: String(err && err.message || err) });
        setTimeout(() => {
            if (!isHost || !gameStarted || String(matchStartSessionId || '') !== session || conn.open === false) return;
            // (Another join or final state for this peer meanwhile: that one goes.)
            if (resyncHostPending.has(pid) || (pending.final ? _resyncHostFinals : resyncHostJoining).has(pid)) return;
            if (pending.final || gameOver) resyncHostSendFinalState(conn);
            else resyncHostScheduleJoin(conn, pending.join);
        }, 1000);
    };
    const fail = e => drop(e || new Error('snapshot failed'));
    // (Its build throwing too: the join counted as on its way for good otherwise.)
    let snapshot, message;
    try {
        snapshot = buildHostAuthoritativeStateSnapshot({ includeConfig: true, includeStaticMapState: true, includeGridTypes: true, withoutState: inWorker });
        message = { type: pending.join === 'spectating' ? 'START_SPECTATE' : 'START_GAME', ...buildHostMatchSyncPayload(), joinTick: pending.T, g: pending.g };
    } catch (err) { console.error('[NET] Join snapshot failed', err); fail(err); return; }
    // (text: the snapshot's text; ready: its payload made already (the worker's, gzipped there), no text on this page.)
    let send = (text, ready = null) => {
        netCounters.snapshotBuildMs = performance.now() - t0;
        netCounters.lastSnapshotAt = performance.now();
        if (superseded()) return;
        // (This host's own state at T: its checkpoint, utils_checkpoint.js; the payload as it is, decoded if ever used.)
        if (!pending.final && typeof netCheckpointNote === 'function') netCheckpointNote(session, pending.T, ready ? ready.payload : text);
        logLockstepWarning('Sending the match to a joining player', { peerId: pid, tick: pending.T, bytes: ready ? ready.bytes : text.length });
        (ready ? Promise.resolve(ready.payload) : netEncodeSnapshotText(text)).then(async payload => {
            netCounters.snapshotBytes = netSnapshotPayloadBytes(payload);
            if (superseded()) return;
            if (conn.open === false) { drop(); return; }
            // (The connection it went on: a request for the match over another one (a reconnect) is not of it.)
            let j = pending.final ? _resyncHostFinals.get(pid) : resyncHostJoining.get(pid);
            // (Sent now: its silence counts from here, not from its scheduling: an encode longer than
            // RESYNC_JOIN_LOAD_SILENT_MS made a new join each time, which dropped the finished one: audit row 92.)
            if (j && j.g === pending.g) { j.conn = conn; j.sentAt = performance.now(); }
            // (A peer without gzip: the text, decoded here for it alone.)
            let out = netSnapshotPayloadForPeer(pid, payload, text);
            if (out && out.z && ready && !(netPeerCapsByPeer[pid] && netPeerCapsByPeer[pid].gzip)) out = { json: await netDecodeSnapshotPayload(out) };
            if (superseded()) return;
            try { conn.send({ ...message, snapshotPayload: out }); } catch { }
            // (The final state: the result after it, for a page that had no match when the result came first.)
            if (result) { try { conn.send(result); } catch { } }
        }).catch(fail);
    };
    if (inWorker) simClientJoinPayload(snapshot).then(r => send(null, r), fail).catch(fail);
    else { try { send(JSON.stringify(snapshot)); } catch (err) { fail(err); throw err; } }
}

// Host, after the end: the final state, for a guest whose end differed from
// ours (no tick runs any more: sent now, numbered as any join).
// (Host: each peer's final state on its way (by match): a repeated request while it is encoded, sent or loading
// is not a new one. Each made a new one, and the guest's newer restore dropped the one it was decoding: with a
// decode longer than its 5 s retry, never one applied (audit row 94).)
const _resyncHostFinals = new Map();
function resyncHostFinalInFlight(pid, now = performance.now(), failedJoin = -1) {
    const j = _resyncHostFinals.get(pid);
    if (!j || j.session !== String(matchStartSessionId || '') || j.applied) return false;
    const failed = Number.isFinite(Number(failedJoin)) && failedJoin !== null ? Math.floor(Number(failedJoin)) : -1;
    if (j.g === failed) return false;
    return !j.sentAt || now - Math.max(j.sentAt, j.heard) <= RESYNC_JOIN_LOAD_SILENT_MS;
}
function resyncHostSendFinalState(conn, failedJoin = -1) {
    let pid = String(conn.peer);
    resyncHostJoining.delete(pid);
    if (resyncHostFinalInFlight(pid, performance.now(), failedJoin)) { netCounters.repeatMatchSyncIgnored = (netCounters.repeatMatchSyncIgnored | 0) + 1; return; }
    let gen = typeof _hostNextResyncGen === 'function' ? _hostNextResyncGen() : 0;
    _resyncHostFinals.set(pid, { g: gen, session: String(matchStartSessionId || ''), since: performance.now(), sentAt: 0, heard: 0, applied: 0 });
    _resyncHostSendJoin(conn, { T: currentTick, join: normalizeMatchRole(matchRoleByPeerId[pid], 'playing'), g: gen, final: true });
}

// Host, at the match's end: joins scheduled for a tick that will not run (a player back just before the end, its
// join due a few ticks on) go now as the final state; they waited for good, the player linked and without a
// match (audit row 95).
function resyncHostFlushJoinsAtEnd() {
    if (!isHost) return;
    for (const [pid, pending] of [...resyncHostPending]) {
        if (!pending || !pending.join) continue;
        resyncHostPending.delete(pid);
        resyncHostJoining.delete(pid);
        const conn = connections.find(c => c && c.peer === pid && c.open !== false);
        if (conn) resyncHostSendFinalState(conn);
    }
}

// Host: a joiner's message is of the join it waits on (its number), or of none
// (then: whatever it was of, it is over).
function _resyncHostJoinOf(conn, data) {
    let j = conn && conn.peer ? resyncHostJoining.get(String(conn.peer)) : null;
    if (j && Math.floor(Number(data && data.j)) !== j.g) { netCounters.staleJoinsDropped = (netCounters.staleJoinsDropped | 0) + 1; return false; }
    return j || true;
}

// Host: a joiner still loading its join says so (every 2 s).
function resyncHostNoteJoinLoading(conn, data) {
    if (!isHost || !conn) return;
    { const f = _resyncHostFinals.get(String(conn.peer)); if (f && f.g === Math.floor(Number(data && data.j))) f.heard = performance.now(); }
    let j = _resyncHostJoinOf(conn, data);
    if (j && j !== true) j.heard = performance.now();
}

// Host: loading joins that went silent (resyncHostIsJoining): sent again
// once, then waited for as any player (the match's own handling of a player
// it waits for: drop button, disconnect). Once a second.
function resyncHostCheckJoins(now) {
    if (now - _resyncHostJoinsCheckedAt < 1000) return;
    _resyncHostJoinsCheckedAt = now;
    for (let [pid, j] of [...resyncHostJoining]) {
        // (Not sent yet: this host's own encode, however long it takes; then from its sending.)
        if (j.applied || !j.sentAt || (now - Math.max(j.sentAt, j.heard) <= RESYNC_JOIN_LOAD_SILENT_MS && now - j.sentAt <= RESYNC_JOIN_LOAD_MAX_MS)) continue;
        let conn = connections.find(c => c && c.peer === pid && c.open !== false);
        if (conn && j.resent < 1 && gameStarted && !gameOver) {
            logLockstepWarning('A joining player went silent while loading; sending the match again', { peerId: pid });
            resyncHostScheduleJoin(conn, 'playing', { resent: j.resent + 1 });
        } else {
            logLockstepWarning('A joining player went silent while loading; waiting for it', { peerId: pid });
            resyncHostJoining.delete(pid);
        }
    }
}

// Host: the joiner restored the match at `tick`; send what was sealed since.
// (It is catching up from now: resyncHostIsJoining.)
function resyncHostHandleJoinApplied(conn, data) {
    if (!isHost || !conn) return;
    { const f = _resyncHostFinals.get(String(conn.peer)); if (f && f.g === Math.floor(Number(data && data.j))) f.applied = performance.now(); }
    let j = _resyncHostJoinOf(conn, data);
    if (!j) return;
    if (j !== true) j.applied = performance.now();
    // (It has the match now: a pause it answered while its join decoded does not keep it out of the next.)
    if (typeof hostNotePeerHasMatch === 'function') hostNotePeerHasMatch(String(conn.peer));
    let from = Math.max(0, Math.floor(Number(data && data.tick) || 0));
    for (let t = from; ; t++) {
        let resend = getHostResendBundleForTick(t);
        if (!resend) break;
        try { conn.send({ type: 'TICK_BUNDLE', w: packTickBundleForWire(resend.bundle), c: 1 }); } catch { }
    }
}

function resyncHostHandleJoinLive(conn, data) {
    if (!isHost || !conn) return;
    // (One of an older join: the newer one goes on. None waited on: an
    // answer again, the first one was lost.)
    if (!_resyncHostJoinOf(conn, data)) return;
    if (resyncHostJoining.delete(String(conn.peer))) logLockstepWarning('Joining player caught up', { peerId: String(conn.peer), tick: currentTick });
    // The first tick sealed only with its input.
    let first = currentTick;
    while (lockstepBundleByTick[first] || lockstepCommittedByTick[first]) first++;
    // (With the join's number and the match: a delayed answer of another join or match is not taken, row 124.)
    try { conn.send({ type: 'JOIN_LIVE_ACK', tick: first, j: Math.floor(Number(data && data.j) || 0), m: String(matchStartSessionId || '') }); } catch { }
}

// Host: whether this peer's join is on its way (scheduled, being encoded or sent, or loading, heard within
// RESYNC_JOIN_LOAD_SILENT_MS): a repeated request for the match is not a new join. (The guest asks again every
// 8 s while it waits; each request made a new join, which dropped the one being built: a snapshot slower than
// that was never sent, the guest paused for good.) A join that went silent: resyncHostCheckJoins.
// Not in flight: the join the guest says it got and could not use (`failedJoin`: its snapshot did not decode,
// came without one), nor one sent over another connection than the request's (gone with a reconnect): before,
// such a guest waited for the 45 s silence check, its loading notes keeping the failed join alive meanwhile.
function resyncHostJoinInFlight(pid, now = performance.now(), conn = null, failedJoin = -1) {
    let failed = Number.isFinite(Number(failedJoin)) && failedJoin !== null ? Math.floor(Number(failedJoin)) : -1;
    let j = resyncHostJoining.get(pid);
    if (j && !j.applied && j.g !== failed && !(conn && j.conn && j.conn !== conn) && (!j.sentAt || now - Math.max(j.sentAt, j.heard) <= RESYNC_JOIN_LOAD_SILENT_MS)) return true;
    let p = resyncHostPending.get(pid);
    return !!(p && p.join && p.g !== failed);
}

// Host: whether to wait for this peer's input yet. Not while it loads its
// join (resyncHostCheckJoins times that); catching up, up to
// RESYNC_JOIN_MAX_CATCH_UP_MS from its JOIN_APPLIED.
function resyncHostIsJoining(pid, now = performance.now()) {
    let j = resyncHostJoining.get(pid);
    if (j === undefined) return false;
    if (j.applied && (now - j.applied) > RESYNC_JOIN_MAX_CATCH_UP_MS) { resyncHostJoining.delete(pid); return false; }
    return true;
}

// Guest: after restoring the match for a live join (its number: gen).
function resyncGuestJoined(tick, gen) {
    let g = resyncGuest;
    g.joining = true;
    g.joinTick = tick;
    g.joinGen = Math.max(0, Math.floor(Number(gen) || 0));
    let hostConn = netGetHostConnection();
    if (hostConn) { try { hostConn.send({ type: 'JOIN_APPLIED', tick, j: g.joinGen }); } catch { } }
}

// Guest: caught up with the bundles the host has sealed.
function resyncGuestMaybeLive() {
    let g = resyncGuest;
    if (!g.joining) return;
    // (The bundles committed ahead count too: they leave the pending ones
    // within a frame, and with the simulation worker the ticks run behind
    // them: a joiner 870 ticks behind said it had caught up, and the host
    // waited for it at ~12 TPS until it had: audit 2026-10-17, 45.)
    let newest = currentTick;
    for (let k in lockstepPendingBundleByTick) { let t = +k; if (t > newest) newest = t; }
    for (let k in lockstepBundleByTick) { let t = +k; if (t > newest) newest = t; }
    if (newest - currentTick > 2) return;
    g.joining = false;
    g.awaitingLive = true;
    _resyncGuestSendLive(performance.now());
}
// (Sent again every RESYNC_JOIN_LIVE_RETRY_MS until acknowledged
// (resyncGuestBeforeTick): one lost, and commands were held for good.)
const RESYNC_JOIN_LIVE_RETRY_MS = 1000;
function _resyncGuestSendLive(now) {
    let g = resyncGuest;
    g.liveSentAt = now;
    let hostConn = netGetHostConnection();
    if (hostConn) { try { hostConn.send({ type: 'JOIN_LIVE', tick: currentTick, j: g.joinGen }); } catch { } }
}

// Guest: the host waits for our input from `tick` on; commands issued while
// catching up go out now, from there.
function resyncGuestHandleJoinLiveAck(data) {
    let g = resyncGuest;
    let tick = Math.floor(Number(data && data.tick));
    // (Only the first answer counts: the retries may bring more.)
    if (!Number.isFinite(tick) || !g.awaitingLive) return;
    // (Of this join and match only: a delayed one of the last match's join was taken in the rematch, and the
    // commands held went out for its tick, 265, at 22: run 243 ticks late. Audit row 124.)
    if (data && data.m !== undefined && String(data.m || '') !== String(matchStartSessionId || '')) return;
    if (data && data.j !== undefined && Math.floor(Number(data.j) || 0) !== g.joinGen) return;
    g.awaitingLive = false;
    g.liveFromTick = tick;
    let held = g.heldActions, final = g.heldFinal || [];
    g.heldActions = []; g.heldFinal = [];
    // (Commands made before a reload of the match, their ids kept, first:
    // utils_networking.js _takeUnsentLocalActions.)
    for (let a of final) requeueLocalAction(a);
    for (let a of held) queueAction(a);
    if (gameStarted) sendLocalTickPacketWindow(currentTick, true);
}

// A joining guest that became the host (a migration before its JOIN_LIVE_ACK): no host is left to answer it; the
// commands it held go out as the host's own now. (Before: held for good; the acknowledgement that releases them
// is refused once this peer hosts.)
function resyncGuestReleaseOnPromotion() {
    let g = resyncGuest;
    if (!g) return;
    let held = g.heldActions || [], final = g.heldFinal || [];
    g.joining = false; g.awaitingLive = false;
    g.heldActions = []; g.heldFinal = [];
    for (let a of final) requeueLocalAction(a);
    for (let a of held) queueAction(a);
}

// Guest: while joining, commands wait (the host would not wait for them).
function resyncGuestHoldAction(action) {
    let g = resyncGuest;
    if (isHost || !g || !(g.joining || g.awaitingLive)) return false;
    // (Past RESYNC_HELD_ACTIONS_MAX (a join that never completes), dropped
    // with a warning, once: no longer silently, at 256.)
    if (g.heldActions.length < RESYNC_HELD_ACTIONS_MAX) g.heldActions.push(action);
    else if (!g.heldDropWarned) { g.heldDropWarned = true; logLockstepWarning('Commands dropped while joining (the join did not complete)', { held: g.heldActions.length }); }
    return true;
}
const RESYNC_HELD_ACTIONS_MAX = 4096;
