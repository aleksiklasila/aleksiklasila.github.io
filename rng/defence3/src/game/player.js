"use strict";

function getPlayerPopCap(playerId) {
    let cfgCap = getConfiguredMaxPop();
    if (playerId < 0 || playerId >= playerPopCaps.length) return cfgCap;
    let cap = playerPopCaps[playerId];
    return Number.isFinite(cap) ? cap : cfgCap;
}

// This player's defeat came from the win check here (opts.auto), not from a
// resign, a removal or a forced resignation: in multiplayer that is this
// peer's state alone. A guest's own resign tells the host, which takes it
// as the team's resignation; an automatic defeat does not (a king killed only
// in a guest's diverged state made the host resign that team and end the
// match: audit 2026-10-15, 20). The host finds defeats in its own state
// (noteTeamsDefeated), and a repair that shows the team alive undoes an
// automatic one (reviewLocalDefeat).
let localDefeatAuto = false;
function enterSpectateMode(mode = 'defeated', opts = null) {
    let auto = !!(opts && opts.auto);
    localDefeatAuto = auto && (!localDefeated || localDefeatAuto);
    spectateMode = mode;
    localDefeated = true;
    fullVisibility = true;
    selectedBuildItem = null;
    selectedUnits = [];
    selectedEntities = [];
    activeSubGroups = {};
    attackMoveMode = false;
    // (Roles: a defeat the host's own state found is the team's; one this
    // player chose (a resign, its team resigned) is this player's: its team
    // plays on while a teammate does (hostPeerStopsPlaying). It set the whole
    // team spectating.)
    if (isMultiplayer && gameStarted && auto && isHost && typeof setMatchRoleForTeam === 'function') {
        setMatchRoleForTeam(localPlayerId, 'spectating');
    }
    if (isMultiplayer && gameStarted && !auto) {
        if (isHost) { if (typeof hostPeerStopsPlaying === 'function') hostPeerStopsPlaying(myPeerId); }
        else {
            if (myPeerId) matchRoleByPeerId[myPeerId] = 'spectating';
            if (connections[0]) { try { connections[0].send({ type: 'MATCH_ROLE_UPDATE', role: 'spectating', m: matchStartSessionId || undefined }); } catch { } }
        }
    }
    requestBuildMenuRefresh();
    updateInfoPanel();
}

// Whether a team is in the match by the state here (the win check's test).
function isTeamAliveNow(pid) {
    if (gameMode === 'killking') return !resignedTeams.has(pid) && units.some(u => u.owner === pid && u.isKing && !u.dead);
    return isTeamAliveByAssets(pid);
}
// After a repair or restore here (the worker's own: sim_worker.js): this
// player's automatic defeat follows the state, undone when the team is
// alive in it, taken when it is not.
function reviewLocalDefeat(alive = null) {
    if (!gameStarted || gameOver) return;
    // (With the simulation worker its win check says: sim_frame_world.js.)
    if (alive === null && typeof simClientActive === 'function' && simClientActive()) return;
    if (alive === null) alive = isTeamAliveNow(localPlayerId);
    if (alive) {
        if (!localDefeated || !localDefeatAuto || spectateMode !== 'defeated' || resignedTeams.has(localPlayerId)) return;
        localDefeated = false;
        localDefeatAuto = false;
        spectateMode = 'none';
        fullVisibility = !!matchFullVisibility;
        requestBuildMenuRefresh();
        updateInfoPanel();
    } else if (!localDefeated) {
        enterSpectateMode('defeated', { auto: true });
    }
}

// The match's end as the state here has it. A multiplayer host tells its
// guests (MATCH_RESULT); a guest shows it once the host's result agrees
// (utils_networking.js guestReviewMatchResult): its own state alone made a
// false victory final, the guest stood at its tick for good, never repaired
// (audit 2026-10-15, 20).
function matchOverShow() {
    if (isMultiplayer && isHost && typeof hostBroadcastMatchResult === 'function') hostBroadcastMatchResult();
    if (isMultiplayer && !isHost) return;
    showGameOver();
}

function checkWinCondition() {
    let teams = (activeTeamIds && activeTeamIds.length > 0) ? activeTeamIds : [0, 1];
    let alive = [];
    if (gameMode === 'killking') {
        alive = teams.filter(pid => !resignedTeams.has(pid) && units.some(u => u.owner === pid && u.isKing && !u.dead));
    } else {
        for (let pid of teams) {
            if (isTeamAliveByAssets(pid)) alive.push(pid);
        }
    }

    if (!gameOver && !localDefeated && !alive.includes(localPlayerId)) {
        enterSpectateMode('defeated', { auto: true });
    }
    if (typeof noteTeamsDefeated === 'function') noteTeamsDefeated(teams.filter(pid => !alive.includes(pid)));

    if (alive.length <= 1 && teams.length > 1) {
        gameOver = true;
        winner = alive.length === 1 ? alive[0] : -1;
        matchOverShow();
    }
}