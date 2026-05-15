"use strict";

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
    let hasActiveDuplicate = matchingPeerIds.some(pid => peerPresenceById[pid] !== false);
    if (hasActiveDuplicate) return { hasActiveDuplicate: true, migrated: false };

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
    let sample = Math.max(0, Math.min(9999, Math.round(rttMs)));
    let prev = Number(peerLatencyByPeerId[pid]);
    peerLatencyByPeerId[pid] = Number.isFinite(prev) ? Math.round(prev * 0.7 + sample * 0.3) : sample;
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

function sendNetworkPings(now = performance.now()) {
    if (!isMultiplayer || connections.length === 0) return;
    if ((now - lastNetworkPingSweepAt) < NETWORK_PING_INTERVAL_MS) return;
    lastNetworkPingSweepAt = now;
    for (let c of connections) {
        if (!c || !c.peer) continue;
        let seq = nextNetworkPingSeq++;
        pendingPingByPeerId[c.peer] = { seq, sentAt: now };
        c.send({ type: 'NET_PING', seq });
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

function buildHostMatchSyncPayload() {
    return {
        seed: gameSeed,
        lobbyPlayers: matchStartLobbyPlayers.length ? matchStartLobbyPlayers : lobbyPlayers,
        cfg: matchStartConfig,
        currentTick,
        roleByPeer: buildHostRoleSnapshot(),
        presenceByPeer: buildHostPresenceSnapshot(),
        latencyByPeer: buildHostLatencySnapshot(),
        history: Object.keys(lockstepHistoryByTick).map(k => lockstepHistoryByTick[k]).sort((a, b) => a.tick - b.tick)
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

function cloneSnapshotValue(value) {
    let seen = new WeakSet();
    return JSON.parse(JSON.stringify(value, (key, v) => {
        if (typeof v === 'function') return undefined;
        if (!v || typeof v !== 'object') return v;
        if (seen.has(v)) return undefined;
        seen.add(v);
        return v;
    }));
}

function snapshotEntity(obj, omitKeys = []) {
    if (!obj || typeof obj !== 'object') return null;
    let omit = new Set(omitKeys);
    let out = {};
    for (let k of Object.keys(obj)) {
        if (omit.has(k)) continue;
        out[k] = obj[k];
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
    if (kind === 'tower') {
        return context.towers.find(t =>
            Math.floor(Number(t.owner) || 0) === Math.floor(Number(ref.owner) || 0) &&
            Math.floor(Number(t.gx) || 0) === Math.floor(Number(ref.gx) || 0) &&
            Math.floor(Number(t.gy) || 0) === Math.floor(Number(ref.gy) || 0) &&
            String(t.type || '') === String(ref.type || '')
        ) || null;
    }
    if (kind === 'barrack') {
        return context.barracks.find(b =>
            Math.floor(Number(b.owner) || 0) === Math.floor(Number(ref.owner) || 0) &&
            Math.floor(Number(b.gx) || 0) === Math.floor(Number(ref.gx) || 0) &&
            Math.floor(Number(b.gy) || 0) === Math.floor(Number(ref.gy) || 0) &&
            String(b.unitType || '') === String(ref.unitType || '')
        ) || null;
    }
    if (kind === 'spawner') {
        return context.spawners.find(s =>
            Math.floor(Number(s.owner) || 0) === Math.floor(Number(ref.owner) || 0) &&
            Math.floor(Number(s.gx) || 0) === Math.floor(Number(ref.gx) || 0) &&
            Math.floor(Number(s.gy) || 0) === Math.floor(Number(ref.gy) || 0) &&
            String(s.type || '') === String(ref.type || '')
        ) || null;
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

function buildHostAuthoritativeStateSnapshot() {
    let floorItems = [];
    for (let gy = 0; gy < GRID_H; gy++) {
        for (let gx = 0; gx < GRID_W; gx++) {
            let cell = grid[gy][gx];
            if (!cell || !cell.item) continue;
            if (cell.item instanceof Tower || cell.item instanceof Barrack || isSpawnerEntity(cell.item)) continue;
            let item = snapshotEntity(cell.item, ['lockedBy', 'textCtx', 'textCanvas', '_textCanvasScale']);
            if (!item) continue;
            floorItems.push({ gx, gy, owner: Math.floor(Number(cell.owner) || 0), item });
        }
    }

    return {
        currentTick,
        gameTime,
        nextUnitId,
        gameOver: !!gameOver,
        localDefeated: !!localDefeated,
        spectateMode: String(spectateMode || 'none'),
        editableConfig: serializeEditableRuntimeConfigForTransport(),
        players: cloneSnapshotValue(players),
        towers: towers.map(t => snapshotEntity(t, ['connectedLasers', 'preferredTarget', 'textCtx', 'textCanvas', '_textCanvasScale'])).filter(Boolean),
        barracks: barracks.map(b => snapshotEntity(b, ['textCtx', 'textCanvas', '_textCanvasScale'])).filter(Boolean),
        spawners: collectorSpawners.map(s => snapshotEntity(s, ['textCtx', 'textCanvas', '_textCanvasScale'])).filter(Boolean),
        units: units.map(u => {
            let snap = snapshotEntity(u, [
                'targetUnit', 'targetBuilding', 'attackTarget', 'workerTarget',
                '_collectorPinnedTarget', '_collectorNextSpawner', '_collectorLastDropoffSpawner', '_lastMineTarget',
                '_healerPinnedQueueTarget', '_healerQueueCommitTarget', '_builderSpawnerTarget', '_healerSpawnerTarget', '_researchSpawnerTarget',
                '_spatialKey'
            ]);
            if (!snap) return null;
            snap._snapshotRefs = {
                targetUnit: makeSnapshotEntityRef(u.targetUnit),
                targetBuilding: makeSnapshotEntityRef(u.targetBuilding),
                attackTarget: makeSnapshotEntityRef(u.attackTarget),
                workerTarget: makeSnapshotEntityRef(u.workerTarget),
                _collectorPinnedTarget: makeSnapshotEntityRef(u._collectorPinnedTarget),
                _collectorNextSpawner: makeSnapshotEntityRef(u._collectorNextSpawner),
                _collectorLastDropoffSpawner: makeSnapshotEntityRef(u._collectorLastDropoffSpawner),
                _lastMineTarget: makeSnapshotEntityRef(u._lastMineTarget),
                _healerPinnedQueueTarget: makeSnapshotEntityRef(u._healerPinnedQueueTarget),
                _healerQueueCommitTarget: makeSnapshotEntityRef(u._healerQueueCommitTarget),
                _builderSpawnerTarget: makeSnapshotEntityRef(u._builderSpawnerTarget),
                _healerSpawnerTarget: makeSnapshotEntityRef(u._healerSpawnerTarget),
                _researchSpawnerTarget: makeSnapshotEntityRef(u._researchSpawnerTarget)
            };
            return snap;
        }).filter(Boolean),
        goldMines: cloneSnapshotValue(goldMines),
        droppedItems: cloneSnapshotValue(droppedItems),
        floorItems,
        areas: cloneSnapshotValue(areas),
        resignedTeams: Array.from(resignedTeams || []).map(v => Math.floor(Number(v) || 0)).sort((a, b) => a - b),
        rngState: (rng && typeof rng.getState === 'function') ? rng.getState() : null,
        visualRngState: (visualRng && typeof visualRng.getState === 'function') ? visualRng.getState() : null
    };
}

function applyAuthoritativeStateSnapshot(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') return false;

    if (snapshot.editableConfig && typeof snapshot.editableConfig === 'object') {
        try {
            applyEditableRuntimeConfigObject(snapshot.editableConfig, { fromTransport: true });
        } catch { }
    }

    waitingForRemoteSince = 0;
    lockstepLastHardResyncRequestAt = 0;
    lockstepDesyncDetected = false;
    lockstepExpectedStateHashByTick = {};
    lockstepLocalStateHashByTick = {};
    lockstepExpectedStateDigestByTick = {};
    lockstepLocalStateDigestByTick = {};

    towers = [];
    barracks = [];
    collectorSpawners = [];
    units = [];
    projectiles = [];
    particles = [];
    droppedItems = [];
    droppedItemGrid = [];

    for (let gy = 0; gy < GRID_H; gy++) {
        for (let gx = 0; gx < GRID_W; gx++) {
            if (!grid[gy] || !grid[gy][gx]) continue;
            grid[gy][gx].item = null;
            grid[gy][gx].owner = -1;
            grid[gy][gx].droppedItem = null;
        }
    }
    initDroppedItemGrid();
    initTileEntityLookup();

    players = Array.isArray(snapshot.players) ? cloneSnapshotValue(snapshot.players) : players;
    currentTick = Math.max(0, Math.floor(Number(snapshot.currentTick) || 0));
    gameTime = Math.max(0, Math.floor(Number(snapshot.gameTime) || currentTick));
    let snapshotNextUnitId = Math.max(1, Math.floor(Number(snapshot.nextUnitId) || 1));
    nextUnitId = snapshotNextUnitId;
    gameOver = !!snapshot.gameOver;
    localDefeated = !!snapshot.localDefeated;
    spectateMode = String(snapshot.spectateMode || spectateMode || 'none');

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
        towers.push(t);
        let tgx = Math.floor(Number(t.gx));
        let tgy = Math.floor(Number(t.gy));
        if (tgx >= 0 && tgx < GRID_W && tgy >= 0 && tgy < GRID_H && grid[tgy] && grid[tgy][tgx]) {
            grid[tgy][tgx].item = t;
            grid[tgy][tgx].owner = Math.floor(Number(t.owner) || 0);
            setTileEntity(tgx, tgy, String(t.type || 'tower'), t);
        }
    }

    let barrackSnapshots = Array.isArray(snapshot.barracks) ? snapshot.barracks : [];
    for (let bs of barrackSnapshots) {
        if (!bs || !Number.isFinite(bs.gx) || !Number.isFinite(bs.gy)) continue;
        let b = new Barrack(Math.floor(bs.gx), Math.floor(bs.gy), Math.floor(Number(bs.owner) || 0), String(bs.unitType || 'norm'), Math.max(1, Math.floor(Number(bs.stacks) || 1)));
        Object.assign(b, cloneSnapshotValue(bs));
        updateItemTextCache(b);
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
        updateItemTextCache(s);
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
    for (let us of unitSnapshots) {
        if (!us || !Number.isFinite(us.x) || !Number.isFinite(us.y)) continue;
        let u = new Unit(String(us.unitType || 'norm'), Math.floor(Number(us.owner) || 0), Number(us.x), Number(us.y));
        Object.assign(u, cloneSnapshotValue(us));
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
        goldMines
    };
    for (let u of units) {
        let refs = u && u._snapshotRefs && typeof u._snapshotRefs === 'object' ? u._snapshotRefs : null;
        if (!refs) continue;
        u.targetUnit = resolveSnapshotEntityRef(refs.targetUnit, snapshotResolveContext);
        u.targetBuilding = resolveSnapshotEntityRef(refs.targetBuilding, snapshotResolveContext);
        u.attackTarget = resolveSnapshotEntityRef(refs.attackTarget, snapshotResolveContext);
        _setWorkerTarget(u, resolveSnapshotEntityRef(refs.workerTarget, snapshotResolveContext), refs.workerTargetType !== undefined ? refs.workerTargetType : (u.workerTargetType !== undefined ? u.workerTargetType : null));
        u._collectorPinnedTarget = resolveSnapshotEntityRef(refs._collectorPinnedTarget, snapshotResolveContext);
        u._collectorNextSpawner = resolveSnapshotEntityRef(refs._collectorNextSpawner, snapshotResolveContext);
        u._collectorLastDropoffSpawner = resolveSnapshotEntityRef(refs._collectorLastDropoffSpawner, snapshotResolveContext);
        u._lastMineTarget = resolveSnapshotEntityRef(refs._lastMineTarget, snapshotResolveContext);
        u._healerPinnedQueueTarget = resolveSnapshotEntityRef(refs._healerPinnedQueueTarget, snapshotResolveContext);
        u._healerQueueCommitTarget = resolveSnapshotEntityRef(refs._healerQueueCommitTarget, snapshotResolveContext);
        u._builderSpawnerTarget = resolveSnapshotEntityRef(refs._builderSpawnerTarget, snapshotResolveContext);
        u._healerSpawnerTarget = resolveSnapshotEntityRef(refs._healerSpawnerTarget, snapshotResolveContext);
        u._researchSpawnerTarget = resolveSnapshotEntityRef(refs._researchSpawnerTarget, snapshotResolveContext);
        delete u._snapshotRefs;
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

    goldMines = Array.isArray(snapshot.goldMines) ? cloneSnapshotValue(snapshot.goldMines) : goldMines;
    for (let m of goldMines) {
        if (!m) continue;
        let gx = Math.floor(Number(m.gx));
        let gy = Math.floor(Number(m.gy));
        setTileEntity(gx, gy, TILE_ENTITY_GOLDMINE, m);
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
        grid[gy][gx].item = cloneSnapshotValue(f.item || null);
        grid[gy][gx].owner = Math.floor(Number(f.owner) || 0);
        if (grid[gy][gx].item) setTileEntity(gx, gy, String(grid[gy][gx].item.type || 'floor_item'), grid[gy][gx].item);
    }

    areas = Array.isArray(snapshot.areas) ? cloneSnapshotValue(snapshot.areas) : areas;
    rebuildAreaDistanceCachesFromAreas();
    resignedTeams = new Set(Array.isArray(snapshot.resignedTeams) ? snapshot.resignedTeams.map(v => Math.floor(Number(v) || 0)) : []);
    recomputePlayerPopCaps();

    if (rng && typeof rng.setState === 'function' && snapshot.rngState !== null && snapshot.rngState !== undefined) {
        rng.setState(snapshot.rngState);
    }
    if (visualRng && typeof visualRng.setState === 'function' && snapshot.visualRngState !== null && snapshot.visualRngState !== undefined) {
        visualRng.setState(snapshot.visualRngState);
    }

    initSpatialHash();
    for (let u of units) updateUnitSpatial(u);
    recalculateLaserConnections();
    updateVisibility(localPlayerId);
    dirtyGrid = true;
    dirtyAreas = true;
    invalidateStaticLayerCache();
    pathfindBudget = 0;

    lockstepLocalPacketByTick = {};
    lockstepHostPacketsByTick = {};
    lockstepBundleByTick = {};
    lockstepPendingBundleByTick = {};
    lockstepPendingBundleAckByTick = {};
    lockstepPendingCommitByTick = {};
    lockstepCommittedByTick = {};
    lockstepBundleAckByTick = {};
    lockstepLastPacketSentAtByTick = {};
    lockstepLastBundleSentAtByTick = {};
    lockstepLastFinalizeSentAtByTick = {};
    lockstepLastResendRequestAtByTick = {};
    lockstepHistoryByTick = {};

    let st = document.getElementById('lobby-status');
    if (st && !isHost) {
        st.style.color = '#9f9';
    }
    return true;
}

function applyIncomingMatchSyncPayload(data, role = 'playing') {
    gameSeed = data.seed;
    waitingForRemoteSince = 0;
    lockstepLastHardResyncRequestAt = 0;
    lockstepDesyncDetected = false;
    lockstepExpectedStateHashByTick = {};
    lockstepLocalStateHashByTick = {};
    lockstepExpectedStateDigestByTick = {};
    lockstepLocalStateDigestByTick = {};
    removedFromMatchPeerIds = new Set();
    guestReconnectAttempt = 0;
    if (guestReconnectTimer) {
        clearTimeout(guestReconnectTimer);
        guestReconnectTimer = null;
    }
    lobbyPlayers = normalizeIncomingLobbyPlayers(data.lobbyPlayers);
    peerPresenceById = {};
    for (let lp of lobbyPlayers) peerPresenceById[lp.peerId] = true;
    peerPresenceById[myPeerId] = true;
    remoteRoleByPeerId = (data && data.roleByPeer && typeof data.roleByPeer === 'object') ? { ...data.roleByPeer } : {};
    remotePresenceByPeerId = (data && data.presenceByPeer && typeof data.presenceByPeer === 'object') ? { ...data.presenceByPeer } : {};
    remoteLatencyByPeerId = (data && data.latencyByPeer && typeof data.latencyByPeer === 'object') ? { ...data.latencyByPeer } : {};
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
        fullVisibility = role === 'spectating' ? true : !!data.cfg.fullVis;
        gameMode = data.cfg.gameMode || 'destroy';
        CONFIG_MAX_POP = Math.max(1, Math.floor(data.cfg.maxPop || 200));
        STARTING_MONEY = Math.max(0, Math.floor(data.cfg.startingMoney || 2000));
        STARTING_ASTAR = Math.max(0, Number(data.cfg.startingAstar) || 9000);
        MAP_TYPE = data.cfg.mapType || 'random';
        THING_STATS_RECALC_INTERVAL_SECONDS = Math.max(0.05, Math.min(600, Number(data.cfg.thingStatsRecalcIntervalSeconds) || THING_STATS_RECALC_INTERVAL_SECONDS));
        UNIT_EFFECTIVE_STATS_RECALC_TICKS = Math.max(1, Math.min(240, Math.floor(Number(data.cfg.unitEffectiveStatsRecalcTicks) || UNIT_EFFECTIVE_STATS_RECALC_TICKS)));
        ASTAR_ITER_BUDGET_PER_PLAYER_TICK = Math.max(256, Math.min(500000, Math.floor(Number(data.cfg.astarIterBudgetPerPlayerTick) || ASTAR_ITER_BUDGET_PER_PLAYER_TICK)));
        WORKER_AI_TICK_DELAY = Math.max(1, Math.min(60, Math.floor(Number(data.cfg.workerAiTickDelay) || WORKER_AI_TICK_DELAY)));
        applyTimingConfig(parseInt(data.cfg.tickRate), parseInt(data.cfg.pipelineDelay));

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
    }
    initAudio();
    startGame();

    if (data && data.stateSnapshot && typeof data.stateSnapshot === 'object') {
        applyAuthoritativeStateSnapshot(data.stateSnapshot);
        return;
    }

    if (role === 'spectating') {
        enterSpectateMode('postgame');
        fullVisibility = true;
    }

    let history = Array.isArray(data.history) ? data.history : [];
    let historyByTick = {};
    for (let hb of history) {
        let tick = Math.floor(Number(hb && hb.tick));
        if (!Number.isFinite(tick) || tick < 0) continue;
        let bundle = {
            tick,
            packets: Array.isArray(hb.packets) ? hb.packets : [],
            combinedChecksum: String(hb.combinedChecksum || '')
        };
        if (!validateTickBundle(bundle)) continue;
        historyByTick[tick] = bundle;
    }

    let targetTick = Math.max(0, Math.floor(Number(data.currentTick) || 0));
    let replayedToTick = currentTick;
    while (currentTick < targetTick) {
        let replayBundle = historyByTick[currentTick];
        if (!replayBundle) break;
        lockstepBundleByTick[currentTick] = replayBundle;
        lockstepCommittedByTick[currentTick] = true;
        runOneTick();
        replayedToTick = currentTick;
    }

    if (currentTick < targetTick) {
        let missingTick = currentTick;
        let now = performance.now();
        waitingForRemoteSince = now;
        logLockstepWarning('Match sync history gap detected; waiting for host resend', {
            missingTick,
            targetTick,
            replayedToTick
        });

        if (connections[0]) {
            connections[0].send({ type: 'TICK_RESEND_REQUEST', tick: missingTick });
            connections[0].send({ type: 'REQUEST_MATCH_SYNC', tick: missingTick, reason: 'history gap' });
            lockstepLastResendRequestAtByTick[missingTick] = now;
        }
    }
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
    if (isHost || gameStarted || !connections[0]) return;
    pendingJoinAsSpectator = true;
    connections[0].send({ type: 'REQUEST_SPECTATE' });
    let st = document.getElementById('lobby-status');
    if (st) {
        st.textContent = 'Requesting spectate access...';
        st.style.color = '#8cf';
    }
}

function applyDuplicateUidBlock(reason = 'This profile is already connected in another tab/window.') {
    duplicateUidBlocked = true;
    duplicateUidBlockReason = String(reason || 'This profile is already connected in another tab/window.');
    pendingJoinAsSpectator = false;
    remoteMatchRunning = false;
    lobbyPlayers = [];
    connections = [];
    peerPresenceById = {};
    remotePresenceByPeerId = {};
    remoteRoleByPeerId = {};
    if (guestReconnectTimer) {
        clearTimeout(guestReconnectTimer);
        guestReconnectTimer = null;
    }
    let st = document.getElementById('lobby-status');
    if (st) {
        st.textContent = duplicateUidBlockReason;
        st.style.color = '#f66';
    }
    updateSpectateButtonVisibility();
    renderOnlineLobby();
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
        out.push({ peerId: pid, name: String(lp.name || '').slice(0, 24), color: normalizeLobbyColor(lp.color) });
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

    if (!isHost) {
        let remoteRole = normalizeMatchRole(remoteRoleByPeerId[peerId], '');
        if (remoteRole === 'spectating') return 'spectator';
        if (!getPeerConnectionState(peerId)) return 'left';
        if (remoteRole === 'playing') return 'playing';
    }

    if (!getPeerConnectionState(peerId)) return 'left';
    if (Number.isFinite(teamId) && resignedTeams.has(teamId)) return 'spectator';
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
        + buildInfoPanelMaintenanceHtml(localPlayerId)
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
                    <span class="info-label" style="color:#ddd;flex:1 1 auto;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${_escapeHtml(lp.name || defaultLobbyName(lp.peerId))}</span>
                    ${infoPanelShowPing ? `<span class="info-value" style="flex:0 0 auto;color:#8cf;text-align:right;min-width:56px">${latencyLabel}</span>` : ''}
                    <span class="info-value" style="flex:0 0 auto;color:${stateColor};text-align:right">${stateLabel}</span>
                    ${removeBtn}
                </div>`;
    }

    return `${baseHtml}<div class="info-title">Online Players</div>${controls}${rows}`;
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

function broadcastLobbyState() {
    if (!isHost) return;
    dedupeLobbyPlayers();
    let payload = lobbyPlayers.map(p => ({ peerId: p.peerId, name: (p.name || '').slice(0, 24), color: normalizeLobbyColor(p.color) }));
    let roleByPeer = buildHostRoleSnapshot();
    let presenceByPeer = buildHostPresenceSnapshot();
    let latencyByPeer = buildHostLatencySnapshot();
    connections.forEach(c => c.send({ type: 'LOBBY_STATE', players: payload, gameRunning: !!(gameStarted && !gameOver), roleByPeer, presenceByPeer, latencyByPeer }));
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

    peer = localId ? new window.Peer(localId) : new window.Peer();
    peer.on('open', id => {
        if (sessionEpoch !== networkSessionEpoch) return;
        myPeerId = id;
        if (mode === 'host') {
            wsHostId = id;
            wsRoomId = id;
        }
        if (cb) cb(id);
    });
    peer.on('connection', conn => setupConnection(conn));
    peer.on('error', err => {
        if (sessionEpoch !== networkSessionEpoch) return;
        console.error(err);
        let st = document.getElementById('lobby-status');
        if (st) {
            st.textContent = (err && err.message) ? err.message : 'Connection failed.';
            st.style.color = '#f44';
        }
    });

    peer.on('disconnected', () => {
        if (sessionEpoch !== networkSessionEpoch) return;
        if (!isHost && gameStarted && !duplicateUidBlocked) {
            scheduleGuestAutoReconnect('Disconnected from host');
        }
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
    if (prior) {
        connections = connections.filter(c => c !== prior);
        try { prior.close(); } catch { }
    }
    connections.push(conn);
    if (conn && conn.peer) {
        peerPresenceById[conn.peer] = true;
    }
    conn.on('data', data => {
        if (data.type === 'NET_PING') {
            conn.send({ type: 'NET_PONG', seq: Number(data.seq) || 0 });
        } else if (data.type === 'NET_PONG') {
            let pending = pendingPingByPeerId[conn.peer];
            let seq = Number(data.seq) || 0;
            if (pending && pending.seq === seq) {
                notePeerLatency(conn.peer, performance.now() - pending.sentAt);
                delete pendingPingByPeerId[conn.peer];
                if (isHost) broadcastLobbyState();
            }
        } else if (data.type === 'START_GAME') {
            applyIncomingMatchSyncPayload(data, 'playing');
        } else if (data.type === 'LOBBY_JOIN' && isHost) {
            if (conn && conn.peer) peerPresenceById[conn.peer] = true;
            let joiningUid = String((data && data.uid) || peerUidByPeerId[conn.peer] || conn.peer || '').trim();
            if (joiningUid) {
                let migration = migratePeerIdByUid(joiningUid, conn.peer);
                if (migration.hasActiveDuplicate) {
                    conn.send({ type: 'DUPLICATE_UID_ACTIVE', reason: 'This profile is already connected in another tab/window.' });
                    try { conn.close(); } catch { }
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
                    let payload = buildHostMatchSyncPayload();
                    if (knownRole === 'spectating') {
                        conn.send({ type: 'START_SPECTATE', ...payload });
                    } else {
                        conn.send({ type: 'START_GAME', ...payload });
                    }
                    broadcastLobbyState();
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
                broadcastLobbyState();
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
            document.getElementById('lobby-status').textContent = 'Lobby updated';
            broadcastLobbyState();
            renderOnlineLobby();
        } else if (data.type === 'LOBBY_UPDATE_SELF' && isHost) {
            let lp = lobbyPlayers.find(p => p.peerId === conn.peer);
            if (lp) {
                lp.name = (data.name || lp.name || defaultLobbyName(conn.peer)).slice(0, 24);
                lp.color = normalizeLobbyColor(data.color || lp.color);
                broadcastLobbyState();
                renderOnlineLobby();
            }
        } else if (data.type === 'LOBBY_STATE' && !isHost) {
            lobbyPlayers = normalizeIncomingLobbyPlayers(data.players);
            remoteMatchRunning = !!data.gameRunning;
            remoteRoleByPeerId = (data && data.roleByPeer && typeof data.roleByPeer === 'object') ? { ...data.roleByPeer } : {};
            remotePresenceByPeerId = (data && data.presenceByPeer && typeof data.presenceByPeer === 'object') ? { ...data.presenceByPeer } : {};
            remoteLatencyByPeerId = (data && data.latencyByPeer && typeof data.latencyByPeer === 'object') ? { ...data.latencyByPeer } : {};
            if (myPeerId) remotePresenceByPeerId[myPeerId] = true;
            renderOnlineLobby();
        } else if (data.type === 'REQUEST_SPECTATE' && isHost) {
            if (!gameStarted || gameOver) {
                conn.send({ type: 'SPECTATE_UNAVAILABLE', reason: 'No active match to spectate.' });
                return;
            }
            matchRoleByPeerId[conn.peer] = 'spectating';
            let uid = getPeerProfileUid(conn.peer);
            if (uid) matchRoleByUid[uid] = 'spectating';
            conn.send({ type: 'START_SPECTATE', ...buildHostMatchSyncPayload() });
            broadcastLobbyState();
            renderOnlineLobby();
        } else if (data.type === 'REQUEST_MATCH_SYNC' && isHost) {
            if (!gameStarted || gameOver) return;
            conn.send({ type: 'MATCH_STATE_SNAPSHOT', snapshot: buildHostAuthoritativeStateSnapshot() });
        } else if (data.type === 'START_SPECTATE' && !isHost) {
            pendingJoinAsSpectator = false;
            applyIncomingMatchSyncPayload(data, 'spectating');
            let st = document.getElementById('lobby-status');
            if (st) {
                st.textContent = 'Spectating current match.';
                st.style.color = '#9f9';
            }
        } else if (data.type === 'SPECTATE_UNAVAILABLE' && !isHost) {
            pendingJoinAsSpectator = false;
            let st = document.getElementById('lobby-status');
            if (st) {
                st.textContent = data.reason || 'Spectate unavailable right now.';
                st.style.color = '#fa4';
            }
        } else if (data.type === 'MATCH_STATE_SNAPSHOT' && !isHost) {
            pendingJoinAsSpectator = false;
            applyAuthoritativeStateSnapshot(data.snapshot);
        } else if (data.type === 'MATCH_ROLE_UPDATE' && isHost) {
            let role = normalizeMatchRole(data.role, '');
            if (gameStarted && role && conn && conn.peer) {
                matchRoleByPeerId[conn.peer] = role;
                let uid = getPeerProfileUid(conn.peer);
                if (uid) matchRoleByUid[uid] = role;
                broadcastLobbyState();
                renderOnlineLobby();
            }
        } else if (data.type === 'DUPLICATE_UID_ACTIVE' && !isHost) {
            applyDuplicateUidBlock(data.reason || 'This profile is already connected in another tab/window.');
            try { if (peer) peer.destroy(); } catch { }
            try { conn.close(); } catch { }
        } else if (data.type === 'TICK_PACKET') {
            handleIncomingTickPacket(conn, data);
        } else if (data.type === 'TICK_BUNDLE') {
            handleIncomingTickBundle(conn, data);
        } else if (data.type === 'TICK_BUNDLE_ACK' && isHost) {
            handleIncomingTickBundleAck(conn, data);
        } else if (data.type === 'TICK_RESEND_REQUEST') {
            handleIncomingTickResendRequest(conn, data);
        } else if (data.type === 'TICK_COMMIT') {
            handleIncomingTickCommit(conn, data);
        } else if (data.type === 'TICK_STATE_HASH') {
            handleIncomingTickStateHash(conn, data);
        } else if (data.type === 'TICK_STATE_HASH_MISMATCH_REPORT' && isHost) {
            logLockstepWarning('Guest reported state-hash mismatch details', {
                peerId: conn && conn.peer ? conn.peer : null,
                tick: Math.floor(Number(data && data.tick) || 0),
                expectedHash: String((data && data.expectedHash) || ''),
                localHash: String((data && data.localHash) || ''),
                details: data && data.details ? data.details : null
            });
        } else if (data.type === 'RETURN_TO_LOBBY') {
            if (Array.isArray(data.lobbyPlayers)) {
                lobbyPlayers = normalizeIncomingLobbyPlayers(data.lobbyPlayers);
            }
            returnToOnlineLobby(false, data.status || 'Returned to host lobby. Waiting for host to start...');
        } else if (data.type === 'PLAYER_REMOVED_FROM_MATCH') {
            let removedPeerId = String(data.peerId || '').trim();
            if (!removedPeerId) return;
            markPeerRemovedFromMatch(removedPeerId);
            if (removedPeerId === myPeerId) {
                let st = document.getElementById('lobby-status');
                if (st) {
                    st.textContent = 'Host removed you from this match.';
                    st.style.color = '#f66';
                }
            }
            updateInfoPanel();
        }
    });
    conn.on('open', () => {
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
                broadcastLobbyState();
                renderOnlineLobby();
                return;
            }
            if (!lobbyPlayers.find(p => p.peerId === conn.peer)) {
                let used = new Set(lobbyPlayers.map(p => normalizeLobbyColor(p.color)));
                let firstFree = TEAM_PRESET_COLORS.find(c => !used.has(c)) || TEAM_PRESET_COLORS[(lobbyPlayers.length) % TEAM_PRESET_COLORS.length];
                lobbyPlayers.push({ peerId: conn.peer, name: defaultLobbyName(conn.peer), color: firstFree });
            }
            document.getElementById('lobby-status').textContent = 'Player joined lobby';
            broadcastLobbyState();
            renderOnlineLobby();
        } else if (conn.peer === wsHostId) {
            guestReconnectAttempt = 0;
            if (guestReconnectTimer) {
                clearTimeout(guestReconnectTimer);
                guestReconnectTimer = null;
            }
            if (gameStarted) {
                let st = document.getElementById('lobby-status');
                if (st) {
                    st.textContent = 'Reconnected to host. Lockstep resumed.';
                    st.style.color = '#9f9';
                }
            }
        }
    });
    conn.on('close', () => {
        connections = connections.filter(c => c !== conn);
        let leftPeerId = conn && conn.peer ? conn.peer : null;
        if (leftPeerId) peerPresenceById[leftPeerId] = false;
        if (leftPeerId) {
            delete pendingPingByPeerId[leftPeerId];
            delete peerLatencyByPeerId[leftPeerId];
            delete peerLatencyUpdatedAtByPeerId[leftPeerId];
        }

        if (!isHost && gameStarted && leftPeerId === wsHostId) {
            scheduleGuestAutoReconnect('Host disconnected');
        }

        if (gameStarted && !gameOver && isMultiplayer && connections.length === 0) {
            let st = document.getElementById('lobby-status');
            if (st) {
                st.textContent = 'Disconnected from peers. Lockstep paused until reconnection.';
                st.style.color = '#fa4';
            }
        }
        if (isHost) {
            if (!gameStarted) {
                lobbyPlayers = lobbyPlayers.filter(p => p.peerId !== conn.peer);
                if (conn.peer) delete peerUidByPeerId[conn.peer];
                document.getElementById('lobby-status').textContent = 'Player disconnected from lobby';
                broadcastLobbyState();
                renderOnlineLobby();
            } else {
                if (conn.peer) delete peerUidByPeerId[conn.peer];
                broadcastLobbyState();
                updateInfoPanel();
            }
        }
    });
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
    visibilityVersion = 0;
    visibilityGridByPlayerCache.clear();
    if (typeof visibilityGridSmoothedByPlayerCache !== 'undefined' && visibilityGridSmoothedByPlayerCache && typeof visibilityGridSmoothedByPlayerCache.clear === 'function') {
        visibilityGridSmoothedByPlayerCache.clear();
    }
    if (typeof visibilityGridSmoothingTickByPlayer !== 'undefined' && visibilityGridSmoothingTickByPlayer && typeof visibilityGridSmoothingTickByPlayer.clear === 'function') {
        visibilityGridSmoothingTickByPlayer.clear();
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
    nextLocalActionSeq = 1;
    waitingForRemoteSince = 0;
    lockstepLastHardResyncRequestAt = 0;
    peerPresenceById = {};
    remoteRoleByPeerId = {};
    remotePresenceByPeerId = {};
    peerLatencyByPeerId = {};
    peerLatencyUpdatedAtByPeerId = {};
    pendingPingByPeerId = {};
    remoteLatencyByPeerId = {};
    lastNetworkPingSweepAt = 0;
    remoteMatchRunning = false;
    pendingJoinAsSpectator = false;
    lockstepHistoryByTick = {};
    lockstepExpectedStateHashByTick = {};
    lockstepLocalStateHashByTick = {};
    lockstepExpectedStateDigestByTick = {};
    lockstepLocalStateDigestByTick = {};
    lockstepDesyncDetected = false;
    currentTick = 0;
    gameTime = 0;
    nextUnitId = 1;
    pathfindBudget = 0;
    pendingPathResolveCursor = 0;
    pathTopologyVersion = 1;
    sharedPathCache.clear();
    sharedSpawnerRouteCache.clear();
    _invalidateWorkerTargetLoadCache();
    resetEnergyDeltaTracking();

    initSpatialHash();
    initGrid();
    dirtyGrid = true;
    dirtyAreas = true;
    invalidateStaticLayerCache();
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
    peerUidByPeerId = {};
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

function hostOnlineGame() {
    isHost = true;
    duplicateUidBlocked = false;
    duplicateUidBlockReason = '';
    remoteMatchRunning = false;
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
    let preSetup = computeTeamSetupFromLobby();
    if (preSetup.activeTeamIds.length < 2) {
        document.getElementById('lobby-status').textContent = 'Need at least 2 different team colors to start.';
        return;
    }
    let startBtn = document.getElementById('btn-start-online');
    startBtn.disabled = true;
    document.getElementById('lobby-status').textContent = 'Starting game...';

    readConfigFromMenu();
    gameSeed = Date.now();
    removedFromMatchPeerIds = new Set();
    lockstepHistoryByTick = {};
    matchStartLobbyPlayers = lobbyPlayers.map(p => ({ peerId: p.peerId, name: p.name, color: normalizeLobbyColor(p.color), uid: String((p && p.uid) || getPeerProfileUid(p && p.peerId) || '') }));
    matchRoleByPeerId = {};
    matchRoleByUid = {};
    for (let p of matchStartLobbyPlayers) {
        if (!p || !p.peerId) continue;
        matchRoleByPeerId[p.peerId] = 'playing';
        let uid = getPeerProfileUid(p.peerId);
        if (uid) matchRoleByUid[uid] = 'playing';
    }
    matchStartConfig = {
        gridW: GRID_W,
        gridH: GRID_H,
        goldCount: GOLD_MINE_COUNT,
        goldMin: GOLD_MINE_MIN,
        goldMax: GOLD_MINE_MAX,
        goldArea: GOLD_MINE_AREA,
        fullVis: fullVisibility,
        gameMode: gameMode,
        maxPop: CONFIG_MAX_POP,
        startingMoney: STARTING_MONEY,
        startingAstar: STARTING_ASTAR,
        mapType: MAP_TYPE,
        tickRate: TICK_RATE,
        pipelineDelay: LOCKSTEP_PIPELINE_MIN,
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

    initAudio();
    startGame();

    let startSnapshot = buildHostAuthoritativeStateSnapshot();
    connections.forEach(c => c.send({
        type: 'START_GAME', seed: gameSeed,
        lobbyPlayers: matchStartLobbyPlayers,
        cfg: matchStartConfig,
        stateSnapshot: startSnapshot
    }));
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
    if (!rejoin) {
        pendingJoinAsSpectator = false;
        remoteMatchRunning = false;
        setLobbyMode('guest');
        document.getElementById('btn-copy-link').style.display = 'none';
        document.getElementById('btn-start-online').style.display = 'none';
    }
    document.getElementById('lobby-status').textContent = rejoin ? 'Reconnecting to host...' : 'Connecting to host...';
    initPeer({ mode: 'guest', roomId: hostId, peerId: rejoin ? myPeerId : undefined }, () => {
        if (!rejoin || !Array.isArray(lobbyPlayers) || lobbyPlayers.length === 0) {
            lobbyPlayers = [{ peerId: myPeerId, name: setLocalPreferredName(localPreferredName || defaultLobbyName(myPeerId)), color: TEAM_PRESET_COLORS[1] }];
        }
        peerPresenceById = { [myPeerId]: true };
        clearPeerRemovedFromMatch(myPeerId);
        renderOnlineLobby();
        let conn = peer.connect(hostId);
        setupConnection(conn);
        let sendLobbyJoin = () => {
            let desiredRole = (gameStarted && (localDefeated || spectateMode !== 'none')) ? 'spectating' : 'playing';
            conn.send({ type: 'LOBBY_JOIN', name: lobbyPlayers[0].name, color: lobbyPlayers[0].color, desiredRole, uid: localPersistentPeerId || myPeerId });
        };
        // Send immediately (works as soon as websocket transport is open),
        // then resend on virtual connection open for reliability.
        sendLobbyJoin();
        conn.on('open', () => {
            sendLobbyJoin();
            guestReconnectAttempt = 0;
            if (guestReconnectTimer) {
                clearTimeout(guestReconnectTimer);
                guestReconnectTimer = null;
            }
            document.getElementById('lobby-status').textContent = gameStarted ? 'Reconnected to host.' : 'Connected! Waiting for host to start...';
            updateSpectateButtonVisibility();
        });
    });
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
    fullVisibility = document.getElementById('cfg-full-vis').checked;
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

    let menuTickRate = parseInt(document.getElementById('cfg-tick-rate').value);
    let menuPipelineDelay = parseInt(document.getElementById('cfg-pipeline-delay').value);
    applyTimingConfig(menuTickRate, menuPipelineDelay);

    MAX_THING_LEVEL = Math.max(1, Math.floor(Number(document.getElementById('cfg-max-thing-level').value) || 20));
    MAX_RESEARCH_LEVEL = Math.max(1, Math.floor(Number(document.getElementById('cfg-max-research-level').value) || 10));
    startingResourcesConfig = normalizeStartingResourcesConfig(startingResourcesConfig);
}

function initLobbySettingsCarousel() {
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
