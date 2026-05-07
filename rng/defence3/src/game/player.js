"use strict";

function getPlayerPopCap(playerId) {
    let cfgCap = getConfiguredMaxPop();
    if (playerId < 0 || playerId >= playerPopCaps.length) return cfgCap;
    let cap = playerPopCaps[playerId];
    return Number.isFinite(cap) ? cap : cfgCap;
}

function enterSpectateMode(mode = 'defeated') {
    spectateMode = mode;
    localDefeated = true;
    fullVisibility = true;
    selectedBuildItem = null;
    selectedUnits = [];
    selectedEntities = [];
    activeSubGroups = {};
    attackMoveMode = false;
    if (isMultiplayer && !isHost && gameStarted && connections[0]) {
        try { connections[0].send({ type: 'MATCH_ROLE_UPDATE', role: 'spectating' }); } catch { }
    }
    requestBuildMenuRefresh();
    updateInfoPanel();
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
        enterSpectateMode('defeated');
    }

    if (alive.length <= 1 && teams.length > 1) {
        gameOver = true;
        winner = alive.length === 1 ? alive[0] : -1;
        showGameOver();
    }
}