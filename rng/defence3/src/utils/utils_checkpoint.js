// ---- the match's checkpoint, outside the simulation ----
// Every peer keeps the newest whole state of the match it has as text (the
// start's, a join's it sent or got, a match-wide resync's: states the host's
// simulation made, so every peer's agrees with them), and the commands of
// every tick run since (by reference: a sealed bundle is never changed).
// That is a state source no simulation holds: when every live simulation of
// the match is gone at once (each peer's worker lost: no peer to hand the
// match to, none to send it), the host restores the checkpoint into a new
// worker and runs the ticks since again, faster than real time; the players
// get the match from it then as after any loss (audit row 83: the host tried
// to hand the match on, the guest declined, its state gone too, and both
// asked each other for good).
// Only ticks that carry something are kept (commands, a cache flush), and
// the step sizes as runs: a quiet tick at the last step size costs nothing.
// The text is the one string the snapshot already was (not a copy).
let _netCkpt = null;
// (Ticks the host runs again from its checkpoint: up to here, as catch-up.)
let netCheckpointReplayUntil = -1;
function _netCkptNew(session, tick, text) {
    return { session, tick, text, ticks: new Map(), dkRuns: [[tick, 1]], last: tick - 1 };
}
// A whole state of the match at `tick` (before that tick runs), as text.
function netCheckpointNote(session, tick, text) {
    session = String(session || '');
    const t = Math.floor(Number(tick));
    if (!session || typeof text !== 'string' || !text || !Number.isFinite(t) || t < 0) return;
    const old = _netCkpt && _netCkpt.session === session ? _netCkpt : null;
    // (An older state than the one kept: kept as it is. The same tick again: the newer text.)
    if (old && t < old.tick) return;
    const k = _netCkptNew(session, t, text);
    if (old) {
        // (Ticks this page already ran from there: the text came after them, its encode took a while.)
        for (const [tt, e] of old.ticks) if (tt >= t) k.ticks.set(tt, e);
        let dk = 1;
        for (const [rt, d] of old.dkRuns) { if (rt <= t) dk = d; else k.dkRuns.push([rt, d]); }
        k.dkRuns[0][1] = dk;
        k.last = Math.max(k.last, old.last);
    }
    _netCkpt = k;
}
function netCheckpointNoteStart(session, text) { netCheckpointNote(session, 0, text); }
// A tick of the match ran with this sealed bundle (main.js runOneTick).
function netCheckpointNoteTick(tick, bundle) {
    const k = _netCkpt;
    if (!k || k.session !== String(matchStartSessionId || '') || tick < k.tick) return;
    if (tick !== k.last + 1) {
        // (A gap: ticks since the state that this page did not run (a restore that skipped ahead without a text,
        // a join it came into later). Nothing to run them again from: no checkpoint until the next text.)
        if (tick > k.last + 1) { _netCkpt = null; return; }
        return;
    }
    k.last = tick;
    const b = bundle && typeof bundle === 'object' ? bundle : null;
    const dk = b && b.dk > 1 ? b.dk | 0 : 1;
    const runs = k.dkRuns;
    if (runs[runs.length - 1][1] !== dk) runs.push([tick, dk]);
    const packets = b && Array.isArray(b.packets) ? b.packets : null;
    let any = !!(b && b.flush);
    if (packets) for (const p of packets) if (p && Array.isArray(p.actions) && p.actions.length) { any = true; break; }
    if (any) k.ticks.set(tick, b);
}
// Whether this page can run the match again from its checkpoint up to now.
function netCheckpointCovers() {
    const k = _netCkpt;
    return !!k && k.session === String(matchStartSessionId || '') && k.last >= k.tick - 1 && k.last + 1 >= currentTick;
}
function _netCkptDk(k, t) {
    let dk = 1;
    for (const [rt, d] of k.dkRuns) { if (rt <= t) dk = d; else break; }
    return dk;
}
// The bundle of a kept tick, as sealed (a quiet one: no packets, the step size of its run).
function _netCkptBundle(k, t) {
    const b = k.ticks.get(t);
    if (b) return b;
    const out = { tick: t, packets: [], combinedChecksum: '' };
    const dk = _netCkptDk(k, t);
    if (dk > 1) out.dk = dk;
    // (Sealed as any bundle: a guest catching up from a join takes it only with its checksum, main.js validateTickBundle.)
    out.combinedChecksum = computeTickBundleChecksum(t, out.packets, 0, dk > 1 ? dk : 0);
    return out;
}
// Host, its simulation lost and nobody to take the match: the checkpoint
// into a new worker, its ticks up to now run again. False when it cannot
// (no checkpoint of this match, no worker to take it).
let _netCkptRestoring = null;
function netCheckpointRestoring() { return !!_netCkptRestoring && _netCkptRestoring.session === String(matchStartSessionId || ''); }
function netCheckpointRestoreSelf(reason) {
    if (netCheckpointRestoring()) return true;
    if (!isHost || !isMultiplayer || !gameStarted || gameOver || !netCheckpointCovers()) return false;
    if (typeof simClientLostPending !== 'function' || !simClientLostPending()) return false;
    const k = _netCkpt, upTo = currentTick;
    logLockstepWarning('Simulation lost everywhere: running the match again from its checkpoint', { reason: String(reason || ''), from: k.tick, to: upTo });
    netCounters.checkpointRestores = (netCounters.checkpointRestores | 0) + 1;
    const session = String(matchStartSessionId || '');
    const job = _netCkptRestoring = { session };
    const done = () => { if (_netCkptRestoring === job) _netCkptRestoring = null; };
    (typeof simClientWhenLoaded === 'function' ? simClientWhenLoaded(10000) : Promise.resolve(true)).then(ok => {
        done();
        if (!ok || !isHost || !gameStarted || gameOver || String(matchStartSessionId || '') !== session || _netCkpt !== k) return;
        if (!simClientLostPending()) return;
        simClientLostClear();
        // The ticks from the checkpoint to now, as sealed (the ones sealed ahead stay).
        for (let t = k.tick; t < upTo; t++) {
            const b = _netCkptBundle(k, t);
            lockstepBundleByTick[t] = b;
            lockstepCommittedByTick[t] = true;
            if (Array.isArray(b.packets)) lockstepHistoryByTick[t] = b;
        }
        currentTick = k.tick;
        if (typeof resyncNoteRestored === 'function') resyncNoteRestored(k.tick);
        // (The page decodes the text without units; the worker loads all of it: sim_client.js simClientStartMatch.)
        if (typeof _simClientStartedThisMatch !== 'undefined') _simClientStartedThisMatch = false;
        if (!(typeof simClientStartMatch === 'function' && simClientStartMatch(k.text))) {
            logLockstepWarning('The checkpoint could not be loaded into a worker', {});
            return;
        }
        if (typeof _simClientStartedThisMatch !== 'undefined') _simClientStartedThisMatch = true;
        netCheckpointReplayUntil = upTo;
        if (typeof setMatchLoadOverlay === 'function') setMatchLoadOverlay(true, 'Recovering Match', 'Running the match again from its last saved state...');
    });
    return true;
}
// Host pump: the catch-up while running the checkpoint's ticks again; the overlay goes once they ran.
function netCheckpointReplayCatchUp() {
    if (netCheckpointReplayUntil < 0) return 0;
    if (!isHost || !gameStarted || gameOver || currentTick >= netCheckpointReplayUntil) {
        netCheckpointReplayUntil = -1;
        if (typeof setMatchLoadOverlay === 'function') setMatchLoadOverlay(false);
        return 0;
    }
    return Math.min(netCheckpointReplayUntil - currentTick, 12);
}
function netCheckpointReset() { _netCkpt = null; netCheckpointReplayUntil = -1; _netCkptRestoring = null; }
