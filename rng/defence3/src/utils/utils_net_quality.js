"use strict";

// ============================================================
// NETWORK QUALITY
// Latency/jitter tracking, the automatic input-delay controller, stall and
// resync accounting, the in-match network panel and the waiting overlay.
//
// Input delay (LOCKSTEP_PIPELINE_TICKS) only decides which future tick a
// peer's commands are scheduled on. The host seals every tick's commands into
// one bundle that all peers execute, so each peer may change its own delay at
// any time without affecting the simulation. Tick rate is different: unit
// movement is expressed per tick, so it stays fixed for a whole match.
// ============================================================

const NET_AUTO_REFERENCE_TICK_RATE = 20;
const NET_MAX_INPUT_DELAY_TICKS = 40;
// Earlier ticks repeated in each tick message (bundles from the host,
// packets from guests).
const NET_TICK_REDUNDANCY = 2;
const NET_PING_INTERVAL_IN_MATCH_MS = 500;
const NET_STATS_BROADCAST_MS = 2000;
const NET_PEER_UNRESPONSIVE_MS = 4000;
const NET_GUEST_FORCE_RECONNECT_MS = 12000;
const NET_WAIT_OVERLAY_DELAY_MS = 1200;
const NET_HOST_DROP_AVAILABLE_MS = 8000;
const NET_HOST_AUTO_DROP_MS = 180000;
const NET_STALL_WINDOW_MS = 10000;
const GUEST_RECONNECT_MAX_ATTEMPTS = 25;

let netAutoEnabled = true;
let netLinkStatsByPeer = {};
let netRemoteReportByPeer = {};
let netAutoExtraTicks = 0;
// Fair play: every player's commands take effect the same number of ticks
// after they are issued. The host sets this from what its guests' links
// need and its own commands wait as long (otherwise the host, with no link to
// cross, would react faster than anyone).
let netFairInputDelay = true;
let netMatchInputDelay = 0;
let netMatchDelayCalmSince = 0;
let netAutoLastRaiseAt = 0;
let netAutoLastStallAt = 0;
let netAutoCalmSince = 0;
let netStallStartedAt = 0;
let netStallSamples = [];
let netLastStatsBroadcastAt = 0;
let netDisconnectedSinceByPeer = {};
let netWaitingSinceByPeer = {};
let netHostUnreachable = false;
let netWaitOverlayState = '';
let netCounters = null;
let netPumpGaps = [];
// Not reset between matches: learned when a peer joins the lobby.
let netPeerCapsByPeer = {};
let netLastPumpAt = 0;

function resetNetCounters() {
    netCounters = {
        stallEvents: 0,
        stallMs: 0,
        longestStallMs: 0,
        resendRequestsSent: 0,
        resendRequestsServed: 0,
        packetsResent: 0,
        hardResyncs: 0,
        // Per-guest repairs (delta or full), and how long the guest waited
        // for them.
        patches: 0,
        fullPatches: 0,
        patchStallMs: 0,
        patchStallMaxMs: 0,
        desyncsDetected: 0,
        lastDesyncTick: -1,
        lastDesyncParts: '',
        snapshotBytes: 0,
        snapshotBuildMs: 0,
        snapshotApplyMs: 0,
        lastSnapshotAt: 0,
        reconnects: 0,
        reconnectAttempts: 0,
        softRejoins: 0,
        inputDelayChanges: 0,
        hostMigrations: 0,
        messagesIn: 0,
        messagesOut: 0
    };
}
resetNetCounters();

function resetNetQualityState() {
    netLinkStatsByPeer = {};
    netRemoteReportByPeer = {};
    netAutoExtraTicks = 0;
    netMatchInputDelay = 0;
    netMatchDelayCalmSince = 0;
    netAutoLastRaiseAt = 0;
    netAutoLastStallAt = 0;
    netAutoCalmSince = 0;
    netStallStartedAt = 0;
    netStallSamples = [];
    netLastStatsBroadcastAt = 0;
    netDisconnectedSinceByPeer = {};
    netWaitingSinceByPeer = {};
    netHostUnreachable = false;
    netPumpGaps = [];
    netLastPumpAt = 0;
    resetNetCounters();
    netUpdateWaitingOverlay(0, true);
}

function _netLink(peerId) {
    let pid = String(peerId || '');
    if (!pid) return null;
    let link = netLinkStatsByPeer[pid];
    if (!link) {
        link = { srtt: NaN, rttvar: 0, minRtt: Infinity, maxRtt: 0, samples: 0, lastSampleAt: 0, lastHeardAt: 0, recent: [] };
        netLinkStatsByPeer[pid] = link;
    }
    return link;
}

// Smoothed round trip time and variation, as TCP computes them (RFC 6298).
function netNoteRttSample(peerId, rttMs, now = performance.now()) {
    let link = _netLink(peerId);
    if (!link || !Number.isFinite(rttMs) || rttMs < 0) return;
    let r = Math.min(30000, rttMs);
    if (!Number.isFinite(link.srtt)) {
        link.srtt = r;
        link.rttvar = r / 2;
    } else {
        link.rttvar = 0.75 * link.rttvar + 0.25 * Math.abs(link.srtt - r);
        link.srtt = 0.875 * link.srtt + 0.125 * r;
    }
    link.minRtt = Math.min(link.minRtt, r);
    link.maxRtt = Math.max(link.maxRtt * 0.995, r);
    link.samples++;
    link.lastSampleAt = now;
    link.recent.push(r);
    if (link.recent.length > 40) link.recent.shift();
}

// Round trip most packets make it within: the 90th percentile of recent
// samples. Unlike mean + variance it is not inflated by the occasional
// retransmitted packet, which the stall-driven margin covers instead.
function netRttBudgetMs(link) {
    if (!link || !Array.isArray(link.recent) || link.recent.length === 0) return NaN;
    let sorted = link.recent.slice().sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.9))];
}

function netNoteHeard(peerId, now = performance.now()) {
    let link = _netLink(peerId);
    if (link) link.lastHeardAt = now;
    if (netCounters) netCounters.messagesIn++;
}

function netGetLinkStats(peerId) {
    return netLinkStatsByPeer[String(peerId || '')] || null;
}

function netGetHostConnection() {
    return connections.find(c => c && c.peer === wsHostId) || connections[0] || null;
}

function netGetHostLinkStats() {
    let hostConn = netGetHostConnection();
    return hostConn ? netGetLinkStats(hostConn.peer) : null;
}

// How often this peer actually gets to run its simulation pump (and so send
// its packets): the 90th percentile of recent gaps. Covers slow machines,
// throttled background tabs and the worker ticker alike.
function netNotePumpFrame(now) {
    if (netLastPumpAt > 0) {
        let gap = now - netLastPumpAt;
        // Gaps over 2s are pauses (debugger, suspended laptop), not cadence.
        if (gap > 0 && gap < 2000) {
            netPumpGaps.push(gap);
            if (netPumpGaps.length > 60) netPumpGaps.shift();
        }
    }
    netLastPumpAt = now;
}

function netFrameMs() {
    if (netPumpGaps.length < 10) return document.hidden ? Math.max(TICK_MS, 250) : 1000 / 60;
    let sorted = netPumpGaps.slice().sort((a, b) => a - b);
    let p90 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.9))];
    return Math.max(1000 / 60, Math.min(1000, p90));
}

// Ticks of lead a guest needs so its commands reach the host, and the sealed
// bundle comes back, before any peer has to wait for them.
function netComputeRttInputDelayTicks(link = netGetHostLinkStats()) {
    let rtt = netRttBudgetMs(link);
    if (!Number.isFinite(rtt)) return Math.max(2, Math.floor(Number(LOCKSTEP_PIPELINE_MIN) || 2));
    let budgetMs = rtt + netFrameMs() + 10;
    return Math.max(1, Math.ceil(budgetMs / TICK_MS));
}

function netTargetInputDelayTicks(now = performance.now()) {
    if (!isMultiplayer || isHost) return Math.max(0, Math.floor(Number(INPUT_DELAY) || 0));
    if (!netAutoEnabled) return Math.max(Math.floor(Number(INPUT_DELAY) || 0), Math.floor(Number(LOCKSTEP_PIPELINE_MIN) || 0));
    return Math.max(1, Math.min(NET_MAX_INPUT_DELAY_TICKS, netComputeRttInputDelayTicks() + netAutoExtraTicks));
}

// Runs every frame. Raises the delay at once when the sim has to wait for the
// host, lowers it one tick at a time only after a calm period.
function netUpdateAutoController(now = performance.now()) {
    if (!isMultiplayer || !gameStarted) return;
    if (isHost) {
        LOCKSTEP_PIPELINE_TICKS = Math.max(0, Math.floor(Number(INPUT_DELAY) || 0));
        netHostUpdateMatchInputDelay(now);
        return;
    }
    if (netAutoEnabled) {
        let calmMs = 5000;
        if (netAutoExtraTicks > 0 && (now - netAutoLastStallAt) > calmMs && (now - netAutoLastRaiseAt) > calmMs) {
            netAutoExtraTicks--;
            netAutoLastRaiseAt = now;
        }
    }
    let target = netTargetInputDelayTicks(now);
    let current = Math.floor(Number(LOCKSTEP_PIPELINE_TICKS) || 0);
    if (target > current) {
        LOCKSTEP_PIPELINE_TICKS = target;
        netAutoCalmSince = now;
        netCounters.inputDelayChanges++;
    } else if (target < current) {
        if (!netAutoCalmSince) netAutoCalmSince = now;
        // Lowering is safe at any time (queueAction never reuses a sent
        // tick) but done gradually so short dips do not cause oscillation.
        if ((now - netAutoCalmSince) > 3000) {
            LOCKSTEP_PIPELINE_TICKS = current - 1;
            netAutoCalmSince = now;
            netCounters.inputDelayChanges++;
        }
    } else {
        netAutoCalmSince = now;
    }
}

// Host: the match-wide command delay is the largest any playing guest needs
// (what it reports, or what its measured ping implies until it reports).
// Raised at once, lowered a tick at a time after a calm period.
function netHostUpdateMatchInputDelay(now = performance.now()) {
    if (!isHost) return;
    let target = 0;
    if (netFairInputDelay) {
        for (let pid of getActiveMatchPeerIds()) {
            if (!pid || pid === myPeerId) continue;
            let r = netRemoteReportByPeer[pid];
            let need = r ? r.inputDelay : NaN;
            if (!Number.isFinite(need) || need <= 0) {
                let link = netGetLinkStats(pid);
                let rtt = netRttBudgetMs(link);
                need = Number.isFinite(rtt) ? Math.ceil((rtt + 1000 / 60 + 10) / TICK_MS) : Math.floor(Number(LOCKSTEP_PIPELINE_MIN) || 2);
            }
            target = Math.max(target, need);
        }
    }
    target = Math.max(0, Math.min(NET_MAX_INPUT_DELAY_TICKS, Math.floor(target)));
    if (target > netMatchInputDelay) {
        netMatchInputDelay = target;
        netMatchDelayCalmSince = now;
    } else if (target < netMatchInputDelay) {
        if (!netMatchDelayCalmSince) netMatchDelayCalmSince = now;
        if ((now - netMatchDelayCalmSince) > 3000) {
            netMatchInputDelay--;
            netMatchDelayCalmSince = now;
        }
    } else {
        netMatchDelayCalmSince = now;
    }
}

// Ticks between issuing a command and the tick it runs on.
function netCommandLeadTicks() {
    let lead = Math.max(0, Math.floor(INPUT_DELAY || 0));
    if (!isMultiplayer || !gameStarted) return lead;
    if (!isHost) lead = Math.max(lead, Math.max(0, Math.floor(LOCKSTEP_PIPELINE_TICKS || 0)) + 1);
    if (netFairInputDelay) lead = Math.max(lead, netMatchInputDelay + 1);
    return lead;
}

// Called by the simulation pump: `waiting` is true while the next tick is due
// but cannot run because remote input is missing.
function netNoteSimWaiting(waiting, now = performance.now()) {
    if (waiting) {
        if (!netStallStartedAt) netStallStartedAt = now;
        return;
    }
    if (!netStallStartedAt) return;
    let dur = now - netStallStartedAt;
    netStallStartedAt = 0;
    if (dur < TICK_MS * 0.75) return;
    netCounters.stallEvents++;
    netCounters.stallMs += dur;
    netCounters.longestStallMs = Math.max(netCounters.longestStallMs, dur);
    netStallSamples.push({ at: now, ms: dur });
    while (netStallSamples.length > 0 && (now - netStallSamples[0].at) > NET_STALL_WINDOW_MS) netStallSamples.shift();
    // Waiting on the host means our lead was too short for this link. A
    // lone late packet is cheaper to wait out than to pay for in latency on
    // every command, so the margin grows only while waiting exceeds ~2% of
    // the recent time, and by at most two ticks per stall.
    if (!netAutoEnabled || !isMultiplayer || isHost || lockstepResyncPauseActive || dur <= TICK_MS) return;
    netAutoLastStallAt = now;
    let pct = netStallPercent(now);
    if (pct > 2 && (now - netAutoLastRaiseAt) > 400) {
        netAutoExtraTicks = Math.min(12, netAutoExtraTicks + (pct > 6 ? 2 : 1));
        netAutoLastRaiseAt = now;
    }
}

function netStallPercent(now = performance.now()) {
    while (netStallSamples.length > 0 && (now - netStallSamples[0].at) > NET_STALL_WINDOW_MS) netStallSamples.shift();
    let ms = netStallSamples.reduce((s, x) => s + x.ms, 0);
    if (netStallStartedAt) ms += now - netStallStartedAt;
    return Math.max(0, Math.min(100, ms / NET_STALL_WINDOW_MS * 100));
}

// Tick rate for a new match in automatic mode. Unit speeds and projectile
// motion are tuned per tick at the reference rate, so auto mode keeps it;
// latency is handled by the input delay instead.
function netChooseAutoTickRate() {
    return NET_AUTO_REFERENCE_TICK_RATE;
}

function netLocalReport(now = performance.now()) {
    let hostLink = isHost ? null : netGetHostLinkStats();
    return {
        inputDelay: Math.floor(Number(LOCKSTEP_PIPELINE_TICKS) || 0),
        auto: !!netAutoEnabled,
        srtt: hostLink && Number.isFinite(hostLink.srtt) ? Math.round(hostLink.srtt) : null,
        jitter: hostLink ? Math.round(hostLink.rttvar) : null,
        stallPct: Math.round(netStallPercent(now) * 10) / 10,
        tps: Math.floor(Number(_tpsDisplay) || 0),
        tick: Math.floor(Number(currentTick) || 0),
        hidden: !!document.hidden,
        resyncs: netCounters.hardResyncs,
        patches: netCounters.patches + netCounters.fullPatches,
        desyncs: netCounters.desyncsDetected
    };
}

function netNoteRemoteReport(peerId, report) {
    let pid = canonicalPeerId(peerId);
    if (!pid || !report || typeof report !== 'object') return;
    netRemoteReportByPeer[pid] = {
        inputDelay: Math.max(0, Math.floor(Number(report.inputDelay) || 0)),
        auto: !!report.auto,
        srtt: Number.isFinite(Number(report.srtt)) && report.srtt !== null ? Math.round(Number(report.srtt)) : null,
        jitter: Number.isFinite(Number(report.jitter)) && report.jitter !== null ? Math.round(Number(report.jitter)) : null,
        stallPct: Math.max(0, Number(report.stallPct) || 0),
        tps: Math.max(0, Math.floor(Number(report.tps) || 0)),
        tick: Math.max(0, Math.floor(Number(report.tick) || 0)),
        hidden: !!report.hidden,
        resyncs: Math.max(0, Math.floor(Number(report.resyncs) || 0)),
        desyncs: Math.max(0, Math.floor(Number(report.desyncs) || 0)),
        at: performance.now()
    };
}

// Host: share every peer's report so guests can show the whole table.
function netMaybeBroadcastStats(now = performance.now()) {
    if (!isHost || !isMultiplayer || connections.length === 0) return;
    if ((now - netLastStatsBroadcastAt) < NET_STATS_BROADCAST_MS) return;
    netLastStatsBroadcastAt = now;
    let byPeer = {};
    for (let pid of Object.keys(netRemoteReportByPeer)) {
        let r = netRemoteReportByPeer[pid];
        let link = netGetLinkStats(pid);
        byPeer[pid] = { ...r, srtt: link && Number.isFinite(link.srtt) ? Math.round(link.srtt) : r.srtt, jitter: link ? Math.round(link.rttvar) : r.jitter };
    }
    if (myPeerId) byPeer[myPeerId] = { ...netLocalReport(now), srtt: 0, jitter: 0 };
    let payload = { type: 'NET_STATS', byPeer, tickRate: TICK_RATE, auto: !!netAutoEnabled, latencyByPeer: buildHostLatencySnapshot() };
    for (let c of connections) {
        if (!c) continue;
        try { c.send(payload); } catch { }
    }
}

// Players the local simulation is currently waiting on.
function netGetWaitingPeerIds() {
    if (!isMultiplayer || !gameStarted || gameOver) return [];
    if (!isHost) {
        let hostId = String(wsHostId || '');
        return hostId ? [hostId] : [];
    }
    let t = Math.floor(Number(currentTick) || 0);
    if (lockstepBundleByTick[t]) return [];
    let pmap = lockstepHostPacketsByTick[t] || {};
    return getActiveMatchPeerIds().filter(pid => pid !== myPeerId && !pmap[pid]);
}

function _netPeerName(peerId) {
    let lp = (lobbyPlayers || []).find(p => p && p.peerId === peerId)
        || (matchStartLobbyPlayers || []).find(p => p && p.peerId === peerId);
    return lp ? String(lp.name || defaultLobbyName(peerId)) : defaultLobbyName(peerId);
}

function _ensureNetWaitOverlay() {
    let el = document.getElementById('net-wait-overlay');
    if (el && el.dataset && el.dataset.netInit === '1') return el;
    if (!el) {
        el = document.createElement('div');
        el.id = 'net-wait-overlay';
        if (document.body) document.body.appendChild(el);
    }
    el.dataset.netInit = '1';
    el.style.position = 'fixed';
    el.style.left = '50%';
    el.style.top = '64px';
    el.style.transform = 'translateX(-50%)';
    el.style.zIndex = '13000';
    el.style.display = 'none';
    el.style.minWidth = '280px';
    el.style.maxWidth = 'min(520px, 92vw)';
    el.style.padding = '10px 14px';
    el.style.borderRadius = '10px';
    el.style.background = 'rgba(16, 22, 30, 0.94)';
    el.style.border = '1px solid rgba(255, 170, 64, 0.55)';
    el.style.boxShadow = '0 8px 28px rgba(0,0,0,0.45)';
    el.style.color = '#f3e7d2';
    el.style.font = "13px 'Segoe UI', 'Trebuchet MS', sans-serif";
    el.style.textAlign = 'center';
    el.addEventListener('click', e => {
        let btn = e.target && e.target.closest ? e.target.closest('button[data-net-action]') : null;
        if (!btn) return;
        let action = btn.getAttribute('data-net-action');
        let pid = btn.getAttribute('data-peer-id') || '';
        if (action === 'drop' && isHost && pid) {
            if (window.confirm(`Drop ${_netPeerName(pid)} from the match? Their team resigns.`)) hostRemovePlayerFromMatch(pid);
        } else if (action === 'leave') {
            leaveMultiplayerToMainMenu('Left the match.');
        } else if (action === 'retry') {
            guestReconnectAttempt = 0;
            netHostUnreachable = false;
            scheduleGuestAutoReconnect('Retrying');
        }
    });
    return el;
}

function _formatSecs(ms) {
    return `${Math.max(0, ms / 1000).toFixed(ms < 10000 ? 1 : 0)}s`;
}

// Shows who the match is waiting for, reconnect progress and resyncs.
function netUpdateWaitingOverlay(now = performance.now(), forceHide = false) {
    let el = document.getElementById('net-wait-overlay');
    if (forceHide || !isMultiplayer || !gameStarted || gameOver || matchStartWaitingForReady) {
        if (el && el.style.display !== 'none') el.style.display = 'none';
        netWaitOverlayState = '';
        return;
    }
    let lines = [];
    let buttons = [];
    let hostConnected = isHost || !!netGetHostConnection();
    if (lockstepFatalStopActive) {
        lines.push(`<b style="color:#f88">Exact lockstep stopped the match</b>`);
        lines.push(_escapeHtml(lockstepFatalStopReason || 'State mismatch'));
        buttons.push(`<button data-net-action="leave">Main menu</button>`);
    } else if (!isHost && hostMigration) {
        lines.push(`<b>${hostMigration.hostLeft ? 'The host left' : 'Lost the host'}</b>`);
        lines.push('Moving the match to another player…');
        buttons.push(`<button data-net-action="leave">Leave match</button>`);
    } else if (!isHost && (!hostConnected || netHostUnreachable || guestReconnectTimer)) {
        if (netHostUnreachable) {
            lines.push(`<b style="color:#f88">Host unreachable</b>`);
            lines.push('The connection to the host could not be restored.');
            buttons.push(`<button data-net-action="retry">Retry</button>`);
        } else {
            lines.push(`<b>Connection to host lost</b>`);
            lines.push(`Reconnecting${guestReconnectAttempt > 0 ? ` (attempt ${guestReconnectAttempt + 1})` : ''}…`);
        }
        buttons.push(`<button data-net-action="leave">Leave match</button>`);
    } else if (lockstepResyncPauseActive) {
        lines.push(`<b>Resynchronizing match state…</b>`);
        let since = Number(lockstepResyncRequestedAt) || 0;
        if (since) lines.push(`<span style="opacity:.75">${_formatSecs(now - since)}</span>`);
    } else if (netStallStartedAt && (now - netStallStartedAt) > NET_WAIT_OVERLAY_DELAY_MS) {
        let waitMs = now - netStallStartedAt;
        let waiting = netGetWaitingPeerIds();
        if (!isHost) {
            let hostLink = netGetHostLinkStats();
            let silentMs = hostLink && hostLink.lastHeardAt ? now - hostLink.lastHeardAt : 0;
            lines.push(`<b>Waiting for other players…</b> <span style="opacity:.75">${_formatSecs(waitMs)}</span>`);
            if (silentMs > NET_PEER_UNRESPONSIVE_MS) lines.push(`<span style="color:#fc8">Host not responding for ${_formatSecs(silentMs)}</span>`);
        } else if (waiting.length > 0) {
            lines.push(`<b>Waiting for players</b> <span style="opacity:.75">${_formatSecs(waitMs)}</span>`);
            for (let pid of waiting) {
                let since = netDisconnectedSinceByPeer[pid] || netWaitingSinceByPeer[pid] || netStallStartedAt;
                let connected = connections.some(c => c && c.peer === pid);
                let state = connected ? 'slow connection' : 'disconnected, waiting to reconnect';
                let autoDropIn = !connected && netDisconnectedSinceByPeer[pid] ? NET_HOST_AUTO_DROP_MS - (now - netDisconnectedSinceByPeer[pid]) : 0;
                lines.push(`${_escapeHtml(_netPeerName(pid))}: <span style="color:#fc8">${state}</span> ${_formatSecs(now - since)}`
                    + (autoDropIn > 0 ? ` <span style="opacity:.6">(auto-drop in ${Math.ceil(autoDropIn / 1000)}s)</span>` : ''));
                if ((now - since) > NET_HOST_DROP_AVAILABLE_MS || !connected) {
                    buttons.push(`<button data-net-action="drop" data-peer-id="${_escapeHtml(pid)}">Drop ${_escapeHtml(_netPeerName(pid).slice(0, 16))}</button>`);
                }
            }
        }
    }
    if (lines.length === 0) {
        if (el && el.style.display !== 'none') el.style.display = 'none';
        netWaitOverlayState = '';
        return;
    }
    el = _ensureNetWaitOverlay();
    let buttonHtml = buttons.length
        ? `<div style="margin-top:8px;display:flex;gap:6px;justify-content:center;flex-wrap:wrap">${buttons.join('')}</div>`
        : '';
    let html = lines.map(l => `<div style="margin:2px 0">${l}</div>`).join('') + buttonHtml;
    if (html !== netWaitOverlayState) {
        el.innerHTML = html;
        netWaitOverlayState = html;
    }
    if (el.style.display !== 'block') el.style.display = 'block';
}

// Per-frame housekeeping: heartbeats, reconnect triggers, auto-drop.
function netMaintain(now = performance.now()) {
    if (!isMultiplayer) return;
    netNotePumpFrame(now);
    netUpdateAutoController(now);
    netMaybeBroadcastStats(now);
    if (gameStarted && !gameOver) {
        if (isHost) {
            let participants = getActiveMatchPeerIds();
            for (let pid of participants) {
                if (pid === myPeerId) continue;
                let connected = connections.some(c => c && c.peer === pid);
                if (connected) delete netDisconnectedSinceByPeer[pid];
                else if (!netDisconnectedSinceByPeer[pid]) netDisconnectedSinceByPeer[pid] = now;
                else if ((now - netDisconnectedSinceByPeer[pid]) > NET_HOST_AUTO_DROP_MS && !isPeerExplicitlyRemoved(pid)) {
                    logLockstepWarning('Dropping player after long disconnect', { peerId: pid });
                    hostRemovePlayerFromMatch(pid);
                }
            }
            let waiting = new Set(netGetWaitingPeerIds());
            for (let pid of Object.keys(netWaitingSinceByPeer)) if (!waiting.has(pid)) delete netWaitingSinceByPeer[pid];
            for (let pid of waiting) if (!netWaitingSinceByPeer[pid]) netWaitingSinceByPeer[pid] = now;
        } else {
            let hostConn = netGetHostConnection();
            let hostLink = hostConn ? netGetLinkStats(hostConn.peer) : null;
            // WebRTC may take a long time to report a dead link; do it ourselves.
            if (hostConn && hostLink && hostLink.lastHeardAt && (now - hostLink.lastHeardAt) > NET_GUEST_FORCE_RECONNECT_MS && !guestReconnectTimer) {
                logLockstepWarning('Host silent; forcing reconnect', { silentMs: Math.round(now - hostLink.lastHeardAt) });
                if (!guestHostLostAt) guestHostLostAt = hostLink.lastHeardAt;
                hostLink.lastHeardAt = now;
                connections = connections.filter(c => c !== hostConn);
                try { hostConn.close(); } catch { }
                scheduleGuestAutoReconnect('Host not responding');
            }
        }
    }
    if (gameStarted && !gameOver) {
        if (isHost) hostMaybeSeekOtherHost(now);
        else guestMaintainHostMigration(now);
        saveMatchRecord();
    }
    netUpdateWaitingOverlay(now);
}

function _fmtMs(v) {
    return Number.isFinite(v) && v !== null ? `${Math.round(v)} ms` : '--';
}

function buildNetworkInfoPanelHtml() {
    if (!isMultiplayer || !gameStarted) return '';
    let now = performance.now();
    let sectionKey = 'network';
    let collapsed = _isInfoSectionCollapsed(sectionKey);
    let delayTicks = Math.floor(Number(LOCKSTEP_PIPELINE_TICKS) || 0);
    let mode = netAutoEnabled ? 'auto' : 'manual';
    let title = _buildCollapsibleInfoSectionTitle(sectionKey, 'Network',
        `<span style="color:#8ab;font-size:10px">${TICK_RATE} TPS · ${mode}</span>`);
    if (collapsed) return title;
    let row = (label, value, color = '#cde') => `<div class="info-row" style="gap:6px"><span class="info-label" style="color:#9aa">${label}</span><span class="info-value" style="color:${color};font-variant-numeric:tabular-nums">${value}</span></div>`;
    let stall = netStallPercent(now);
    let html = title;
    html += row('Tick rate', `${Math.floor(Number(_tpsDisplay) || 0)} / ${TICK_RATE} TPS`, (_tpsDisplay || 0) >= TICK_RATE * 0.9 ? '#9f9' : '#fc8');
    let leadTicks = netCommandLeadTicks();
    html += row('Command delay', `${leadTicks} ticks (${Math.round(leadTicks * TICK_MS)} ms)${netFairInputDelay ? ' · equal for all' : ''}`);
    if (isHost) {
        html += row('Your input delay', `${delayTicks} ticks (${Math.round(delayTicks * TICK_MS)} ms)`);
    } else {
        let hostLink = netGetHostLinkStats();
        html += row('Input delay', `${delayTicks} ticks (${Math.round((delayTicks + 1) * TICK_MS)} ms)${netAutoEnabled ? ' auto' : ''}`);
        html += row('Ping to host', hostLink && Number.isFinite(hostLink.srtt) ? `${Math.round(hostLink.srtt)} ms ±${Math.round(hostLink.rttvar)}` : '--');
    }
    html += row('Waiting (10s)', `${stall.toFixed(1)}%`, stall < 2 ? '#9f9' : stall < 10 ? '#fc8' : '#f88');
    html += row('Desyncs', `${netCounters.desyncsDetected} · ${netCounters.patches + netCounters.fullPatches} patched · ${netCounters.hardResyncs} full resyncs`, netCounters.desyncsDetected > 0 ? '#fc8' : '#cde');
    html += row('Resend requests', `${netCounters.resendRequestsSent} sent · ${netCounters.resendRequestsServed} served`);
    if (netCounters.hostMigrations > 0) html += row('Host changes', String(netCounters.hostMigrations), '#fc8');
    if (netCounters.lastSnapshotAt) {
        html += row('Last repair', `${Math.round(netCounters.snapshotBytes / 1024)} KB · ${Math.round(isHost ? netCounters.snapshotBuildMs : netCounters.snapshotApplyMs)} ms${!isHost && netCounters.patchStallMs > 0 ? ` · waited ${Math.round(netCounters.patchStallMs)} ms` : ''} · ${_formatSecs(now - netCounters.lastSnapshotAt)} ago`);
    }
    if (netCounters.lastDesyncTick >= 0) {
        html += row('Last desync', `tick ${netCounters.lastDesyncTick}${netCounters.lastDesyncParts ? ` (${_escapeHtml(netCounters.lastDesyncParts)})` : ''}`, '#fc8');
    }
    // Per-player table. The host measures directly; guests use the host's broadcast.
    let rows = '';
    for (let lp of (lobbyPlayers || [])) {
        if (!lp || !lp.peerId) continue;
        let pid = lp.peerId;
        let r = netRemoteReportByPeer[pid] || null;
        let isSelf = pid === myPeerId;
        if (isSelf) r = { ...netLocalReport(now) };
        let rtt = isHost ? (isSelf ? 0 : (netGetLinkStats(pid) || {}).srtt) : (r ? r.srtt : null);
        if (!isHost && pid === wsHostId) rtt = 0;
        let jitter = isHost ? (isSelf ? 0 : (netGetLinkStats(pid) || {}).rttvar) : (r ? r.jitter : null);
        let delay = r ? r.inputDelay : null;
        let stallPct = r ? r.stallPct : null;
        let flags = [];
        if (r && r.hidden) flags.push('tab hidden');
        if (isHost && netDisconnectedSinceByPeer[pid]) flags.push('offline');
        rows += `<tr>
            <td style="color:#ddd;max-width:84px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${_escapeHtml(lp.name || defaultLobbyName(pid))}</td>
            <td style="padding-left:6px;text-align:right">${_fmtMs(rtt)}</td>
            <td style="padding-left:6px;text-align:right">${Number.isFinite(jitter) ? '±' + Math.round(jitter) : '--'}</td>
            <td style="padding-left:6px;text-align:right">${Number.isFinite(delay) ? delay : '--'}</td>
            <td style="padding-left:6px;text-align:right;color:${(stallPct || 0) < 2 ? '#9f9' : '#fc8'}">${Number.isFinite(stallPct) ? stallPct.toFixed(0) + '%' : '--'}</td>
            <td style="color:#fc8">${flags.join(', ')}</td>
        </tr>`;
    }
    if (rows) {
        html += `<table style="width:100%;border-collapse:collapse;font-size:10px;color:#abc;margin-top:3px">
            <tr style="color:#789"><th style="text-align:left">Player</th><th style="padding-left:6px;text-align:right">Ping</th><th style="padding-left:6px;text-align:right">Jitter</th><th style="padding-left:6px;text-align:right" title="Input delay in ticks">Delay</th><th style="padding-left:6px;text-align:right" title="Share of the last 10s spent waiting">Wait</th><th></th></tr>
            ${rows}
        </table>`;
    }
    return html;
}

// ------------------------------------------------------------
// Background ticking. Hidden tabs clamp setInterval to about once per
// second, which would stall every other player in lockstep. Timers inside a
// dedicated worker are not clamped, so the worker drives the hidden pump.
// ------------------------------------------------------------
let _netBackgroundWorker = null;
let _netBackgroundWorkerUrl = '';

function netStartBackgroundTicker(intervalMs, fn) {
    netStopBackgroundTicker();
    if (typeof Worker === 'function' && typeof Blob === 'function' && typeof URL !== 'undefined' && URL.createObjectURL) {
        try {
            let src = `let h=0;onmessage=e=>{clearInterval(h);if(e.data>0)h=setInterval(()=>postMessage(0),e.data);};`;
            _netBackgroundWorkerUrl = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
            _netBackgroundWorker = new Worker(_netBackgroundWorkerUrl);
            _netBackgroundWorker.onmessage = () => fn();
            _netBackgroundWorker.postMessage(Math.max(4, Math.floor(intervalMs)));
            return 'worker';
        } catch {
            netStopBackgroundTicker();
        }
    }
    _netBackgroundWorker = setInterval(fn, intervalMs);
    return 'interval';
}

function netStopBackgroundTicker() {
    if (!_netBackgroundWorker) return;
    if (typeof _netBackgroundWorker === 'object' && typeof _netBackgroundWorker.terminate === 'function') {
        try { _netBackgroundWorker.postMessage(0); } catch { }
        try { _netBackgroundWorker.terminate(); } catch { }
        if (_netBackgroundWorkerUrl) { try { URL.revokeObjectURL(_netBackgroundWorkerUrl); } catch { } }
    } else {
        clearInterval(_netBackgroundWorker);
    }
    _netBackgroundWorker = null;
    _netBackgroundWorkerUrl = '';
}

// ------------------------------------------------------------
// Snapshot transport: JSON text, gzip-compressed where the browser supports
// it. The host applies the same decoded text it sends, so both sides restore
// from byte-identical input.
// ------------------------------------------------------------
// Small snapshots go as plain text: compressing costs more time than the
// transfer it saves.
let NET_SNAPSHOT_COMPRESS_MIN_BYTES = 48 * 1024;

async function netEncodeSnapshotText(text) {
    if (text.length >= NET_SNAPSHOT_COMPRESS_MIN_BYTES && typeof CompressionStream === 'function' && typeof TextEncoder === 'function' && typeof Response === 'function') {
        try {
            let stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
            let buf = await new Response(stream).arrayBuffer();
            return { z: new Uint8Array(buf) };
        } catch { }
    }
    return { json: text };
}

async function netDecodeSnapshotPayload(payload) {
    if (!payload || typeof payload !== 'object') return null;
    if (typeof payload.json === 'string') return payload.json;
    if (payload.z && typeof DecompressionStream === 'function') {
        let bytes = payload.z instanceof Uint8Array ? payload.z : new Uint8Array(payload.z);
        let stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
        return await new Response(stream).text();
    }
    return null;
}

// What this browser can decode, told to the host when joining.
function netLocalCapabilities() {
    return { gzip: typeof DecompressionStream === 'function' };
}

function netNotePeerCapabilities(peerId, caps) {
    let pid = String(peerId || '');
    if (!pid) return;
    netPeerCapsByPeer[pid] = { gzip: !!(caps && caps.gzip) };
}

// A compressed snapshot only goes to peers that said they can decompress it
// (older browsers lack DecompressionStream); others get the JSON text.
function netSnapshotPayloadForPeer(peerId, payload, text) {
    if (!payload || !payload.z) return payload;
    let caps = netPeerCapsByPeer[String(peerId || '')];
    if (caps && caps.gzip) return payload;
    return typeof text === 'string' ? { json: text } : payload;
}

function netSnapshotPayloadBytes(payload) {
    if (!payload) return 0;
    if (typeof payload.json === 'string') return payload.json.length;
    if (payload.z) return payload.z.byteLength || payload.z.length || 0;
    return 0;
}
