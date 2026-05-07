"use strict";

// ============================================================
// GRID & MAP INITIALIZATION
// ============================================================
function initGrid() {
    grid = [];
    initDroppedItemGrid();
    workerReservedTiles = new Array(Math.max(0, GRID_W * GRID_H * _WORKER_TARGET_LOAD_TYPE_COUNT)).fill(null);
    for (let y = 0; y < GRID_H; y++) {
        let row = [];
        for (let x = 0; x < GRID_W; x++) {
            row.push({ type: TYPE_FLOOR, item: null, owner: -1, areaId: -1, droppedItem: null });
        }
        grid.push(row);
    }
}

function generateAreas() {
    areas = [];
    _areaById = [];
    let visited = Array.from({ length: GRID_H }, () => new Array(GRID_W).fill(false));
    let areaId = 0;

    for (let y = 0; y < GRID_H; y++) {
        for (let x = 0; x < GRID_W; x++) {
            if (visited[y][x]) continue;
            let targetSize = 5 + Math.floor(rng() * 8);
            let cells = [];
            let queue = [{ x, y }];
            visited[y][x] = true;
            let cellType = grid[y][x].type;
            let minAreaGx = x, minAreaGy = y, maxAreaGx = x, maxAreaGy = y;

            while (queue.length > 0 && cells.length < targetSize) {
                let cur = queue.shift();
                cells.push({ x: cur.x, y: cur.y });
                grid[cur.y][cur.x].areaId = areaId;
                if (cur.x < minAreaGx) minAreaGx = cur.x;
                if (cur.y < minAreaGy) minAreaGy = cur.y;
                if (cur.x > maxAreaGx) maxAreaGx = cur.x;
                if (cur.y > maxAreaGy) maxAreaGy = cur.y;

                let dirs = [[0, 1], [0, -1], [1, 0], [-1, 0]];
                for (let i = dirs.length - 1; i > 0; i--) {
                    let j = Math.floor(rng() * (i + 1));
                    [dirs[i], dirs[j]] = [dirs[j], dirs[i]];
                }
                for (let [dx, dy] of dirs) {
                    let nx = cur.x + dx, ny = cur.y + dy;
                    if (nx >= 0 && nx < GRID_W && ny >= 0 && ny < GRID_H && !visited[ny][nx] && grid[ny][nx].type === cellType) {
                        visited[ny][nx] = true;
                        queue.push({ x: nx, y: ny });
                    }
                }
            }
            // Un-visit cells left in queue so they can form their own areas
            for (let rem of queue) visited[rem.y][rem.x] = false;
            let area = {
                id: areaId,
                type: cellType,
                cells,
                active: false,
                multiplierLevel: 0,
                minGx: minAreaGx,
                minGy: minAreaGy,
                maxGx: maxAreaGx,
                maxGy: maxAreaGy
            };
            areas.push(area);
            _areaById[areaId] = area;
            areaId++;
        }
    }

    _areaColorCache = null;
    _areaOutlinePathCache = null;
    _markCombinedBgFullDirty();
}

function generateResourceMinesMixed() {
    let spawnTiles = arguments.length > 0 && arguments[0] ? arguments[0] : [];

    for (let m of goldMines) {
        if (!m) continue;
        clearTileEntity(Math.floor(Number(m.gx)), Math.floor(Number(m.gy)), m);
    }
    for (let m of astarMines) {
        if (!m) continue;
        clearTileEntity(Math.floor(Number(m.gx)), Math.floor(Number(m.gy)), m);
    }
    goldMines = [];
    astarMines = [];

    let totalGold = Math.max(0, Math.floor(GOLD_MINE_COUNT || 0));
    let totalAstar = Math.max(0, Math.floor(ASTAR_MINE_COUNT || 0));
    let totalMines = totalGold + totalAstar;
    if (totalMines <= 0) return;

    let margin = 1;
    let spawnSafeRadius = 3;
    let mapMin = Math.min(GRID_W, GRID_H);
    let centerX = (GRID_W - 1) / 2;
    let centerY = (GRID_H - 1) / 2;
    let shapeMask = null;

    let nearAnySpawn = (gx, gy) => {
        if (!spawnTiles || spawnTiles.length === 0) return false;
        return spawnTiles.some(s => Math.hypot(gx - s.gx, gy - s.gy) <= spawnSafeRadius);
    };

    let isAllowedByShape = (gx, gy) => {
        if (!shapeMask) return true;
        return !!shapeMask(gx, gy);
    };

    let candidateSet = new Set();
    let candidates = [];
    let addCandidate = (gx, gy) => {
        if (gx < margin || gx >= GRID_W - margin || gy < margin || gy >= GRID_H - margin) return false;
        let key = `${gx},${gy}`;
        if (candidateSet.has(key)) return false;
        if (!grid[gy] || !grid[gy][gx] || grid[gy][gx].type !== TYPE_FLOOR) return false;
        if (!isAllowedByShape(gx, gy)) return false;
        if (MAP_TYPE !== 'arena' && nearAnySpawn(gx, gy)) return false;
        candidateSet.add(key);
        candidates.push({ gx, gy });
        return true;
    };

    let addCandidatesFromList = (list, shuffle = true) => {
        if (!Array.isArray(list) || list.length === 0) return;
        let src = list.slice();
        if (shuffle) {
            for (let i = src.length - 1; i > 0; i--) {
                let j = Math.floor(rng() * (i + 1));
                [src[i], src[j]] = [src[j], src[i]];
            }
        }
        for (let c of src) {
            if (candidates.length >= totalMines) break;
            addCandidate(c.gx, c.gy);
        }
    };

    let buildArenaEdgeSpiralCandidates = (ringWidth) => {
        let out = [];
        let seen = new Set();
        let add = (gx, gy) => {
            if (gx < margin || gx >= GRID_W - margin || gy < margin || gy >= GRID_H - margin) return;
            let k = `${gx},${gy}`;
            if (seen.has(k)) return;
            seen.add(k);
            out.push({ gx, gy });
        };

        for (let layer = 0; layer <= ringWidth; layer++) {
            let left = margin + layer;
            let right = GRID_W - 1 - margin - layer;
            let top = margin + layer;
            let bottom = GRID_H - 1 - margin - layer;
            if (left > right || top > bottom) break;

            for (let gx = left; gx <= right; gx++) add(gx, top);
            for (let gy = top + 1; gy <= bottom; gy++) add(right, gy);
            if (bottom > top) {
                for (let gx = right - 1; gx >= left; gx--) add(gx, bottom);
            }
            if (right > left) {
                for (let gy = bottom - 1; gy > top; gy--) add(left, gy);
            }
        }

        return out;
    };

    if (MAP_TYPE === 'arena') {
        let ringWidth = Math.max(2, Math.floor(mapMin * 0.16));
        shapeMask = (gx, gy) => {
            let edgeDist = Math.min(gx, gy, GRID_W - 1 - gx, GRID_H - 1 - gy);
            return edgeDist <= ringWidth;
        };
        addCandidatesFromList(buildArenaEdgeSpiralCandidates(ringWidth), false);
    } else if (MAP_TYPE === 'island') {
        let islandRadius = Math.max(4, Math.floor(mapMin * 0.19));
        shapeMask = (gx, gy) => Math.hypot(gx - centerX, gy - centerY) <= islandRadius;
        let list = [];
        for (let gy = margin; gy < GRID_H - margin; gy++) {
            for (let gx = margin; gx < GRID_W - margin; gx++) {
                let d = Math.hypot(gx - centerX, gy - centerY);
                if (d <= islandRadius) list.push({ gx, gy, d });
            }
        }
        list.sort((a, b) => a.d - b.d);
        addCandidatesFromList(list, false);
    } else if (MAP_TYPE === 'islands') {
        let anchors = (spawnTiles && spawnTiles.length > 0) ? spawnTiles : pickEdgePlayerSpawns(2);
        let centerPull = 0.3;
        let islandRadius = Math.max(4, Math.floor(mapMin * Math.max(0.08, 0.2 - anchors.length * 0.015)));
        let islandCenters = anchors.map(s => ({
            cx: s.gx + (centerX - s.gx) * centerPull,
            cy: s.gy + (centerY - s.gy) * centerPull
        }));

        shapeMask = (gx, gy) => islandCenters.some(c => Math.hypot(gx - c.cx, gy - c.cy) <= islandRadius);

        let list = [];
        for (let gy = margin; gy < GRID_H - margin; gy++) {
            for (let gx = margin; gx < GRID_W - margin; gx++) {
                let best = Infinity;
                for (let c of islandCenters) {
                    let d = Math.hypot(gx - c.cx, gy - c.cy);
                    if (d < best) best = d;
                }
                if (best <= islandRadius) list.push({ gx, gy, d: best });
            }
        }
        list.sort((a, b) => a.d - b.d);
        addCandidatesFromList(list, false);
    } else if (MAP_TYPE === 'solar_system') {
        shapeMask = (gx, gy) => {
            let d = Math.hypot(gx - centerX, gy - centerY);
            let maxDist = Math.hypot(centerX - margin, centerY - margin);
            let norm = Math.min(1, d / Math.max(1, maxDist));
            return norm <= 0.98;
        };
        let list = [];
        let maxDist = Math.hypot(centerX - margin, centerY - margin);
        for (let gy = margin; gy < GRID_H - margin; gy++) {
            for (let gx = margin; gx < GRID_W - margin; gx++) {
                let d = Math.hypot(gx - centerX, gy - centerY);
                let norm = Math.min(1, d / Math.max(1, maxDist));
                let p = Math.pow(Math.max(0, 1 - norm), 6.5);
                if (norm <= 0.12 || rng() < p) list.push({ gx, gy });
            }
        }
        addCandidatesFromList(list, true);
    } else if (MAP_TYPE === 'crossroads') {
        let armHalf = Math.max(2, Math.floor(mapMin * 0.08));
        shapeMask = (gx, gy) => Math.abs(gx - centerX) <= armHalf || Math.abs(gy - centerY) <= armHalf;
        let list = [];
        for (let gy = margin; gy < GRID_H - margin; gy++) {
            for (let gx = margin; gx < GRID_W - margin; gx++) {
                let onVertical = Math.abs(gx - centerX) <= armHalf;
                let onHorizontal = Math.abs(gy - centerY) <= armHalf;
                if (onVertical || onHorizontal) list.push({ gx, gy });
            }
        }
        addCandidatesFromList(list, true);
    }

    let fallbackAttempts = Math.max(totalMines * 30, 300);
    for (let i = 0; i < fallbackAttempts && candidates.length < totalMines; i++) {
        let gx = margin + Math.floor(rng() * Math.max(1, GRID_W - margin * 2));
        let gy = margin + Math.floor(rng() * Math.max(1, GRID_H - margin * 2));
        addCandidate(gx, gy);
    }

    let goldRange = Math.max(0, GOLD_MINE_MAX - GOLD_MINE_MIN);
    let astarRange = Math.max(0, ASTAR_MINE_MAX - ASTAR_MINE_MIN);
    let occupied = new Set();
    let remainingGold = totalGold;
    let remainingAstar = totalAstar;
    let targetPlacements = Math.max(0, Math.min(totalMines, candidates.length));
    let placedRecords = [];

    let placeGoldMine = (gx, gy) => {
        let gold = GOLD_MINE_MIN + Math.floor(rng() * goldRange);
        let mine = { gx, gy, gold, maxGold: gold, x: gx * TILE + 16, y: gy * TILE + 16 };
        goldMines.push(mine);
        setTileEntity(gx, gy, TILE_ENTITY_GOLDMINE, mine);
        return mine;
    };

    let placeAstarMine = (gx, gy) => {
        let astar = ASTAR_MINE_MIN + Math.floor(rng() * astarRange);
        let mine = { gx, gy, astar, maxAstar: astar, x: gx * TILE + 16, y: gy * TILE + 16 };
        astarMines.push(mine);
        setTileEntity(gx, gy, TILE_ENTITY_ASTARMINE, mine);
        return mine;
    };

    for (let i = 0; i < candidates.length; i++) {
        let c = candidates[i];
        if (placedRecords.length >= targetPlacements) break;
        let key = `${c.gx},${c.gy}`;
        if (occupied.has(key)) continue;
        if (!grid[c.gy] || !grid[c.gy][c.gx] || grid[c.gy][c.gx].type !== TYPE_FLOOR) continue;

        let totalLeft = remainingGold + remainingAstar;
        if (totalLeft <= 0) break;
        let pickAstar = remainingAstar > 0 && (remainingGold <= 0 || rng() < (remainingAstar / totalLeft));

        if (pickAstar) {
            let mine = placeAstarMine(c.gx, c.gy);
            remainingAstar--;
            placedRecords.push({ type: 'astar', gx: c.gx, gy: c.gy, mine });
        } else {
            let mine = placeGoldMine(c.gx, c.gy);
            remainingGold--;
            placedRecords.push({ type: 'gold', gx: c.gx, gy: c.gy, mine });
        }
        occupied.add(key);
        grid[c.gy][c.gx].type = TYPE_WALL;
    }

    // If both resource types are configured, ensure both appear when at least two mines were placed.
    if (totalGold > 0 && totalAstar > 0 && placedRecords.length >= 2) {
        let placedGold = placedRecords.filter(r => r.type === 'gold');
        let placedAstar = placedRecords.filter(r => r.type === 'astar');

        if (placedGold.length === 0 && placedAstar.length > 0) {
            let pick = placedAstar[Math.floor(rng() * placedAstar.length)];
            clearTileEntity(pick.gx, pick.gy, pick.mine);
            let idx = astarMines.indexOf(pick.mine);
            if (idx !== -1) astarMines.splice(idx, 1);
            let converted = placeGoldMine(pick.gx, pick.gy);
            pick.type = 'gold';
            pick.mine = converted;
        } else if (placedAstar.length === 0 && placedGold.length > 0) {
            let pick = placedGold[Math.floor(rng() * placedGold.length)];
            clearTileEntity(pick.gx, pick.gy, pick.mine);
            let idx = goldMines.indexOf(pick.mine);
            if (idx !== -1) goldMines.splice(idx, 1);
            let converted = placeAstarMine(pick.gx, pick.gy);
            pick.type = 'astar';
            pick.mine = converted;
        }
    }
}

function generateGoldMines() {
    let spawnTiles = arguments.length > 0 && arguments[0] ? arguments[0] : [];
    for (let m of goldMines) {
        if (!m) continue;
        clearTileEntity(Math.floor(Number(m.gx)), Math.floor(Number(m.gy)), m);
    }
    goldMines = [];
    let totalMines = Math.max(0, Math.floor(GOLD_MINE_COUNT || 0));
    let margin = 1;
    let spawnSafeRadius = 3;
    let placed = new Set();
    let goldRange = Math.max(0, GOLD_MINE_MAX - GOLD_MINE_MIN);
    let shapeMask = null;

    let nearAnySpawn = (gx, gy) => {
        if (!spawnTiles || spawnTiles.length === 0) return false;
        return spawnTiles.some(s => Math.hypot(gx - s.gx, gy - s.gy) <= spawnSafeRadius);
    };

    let isAllowedByShape = (gx, gy) => {
        if (!shapeMask) return true;
        return !!shapeMask(gx, gy);
    };

    let addMine = (gx, gy) => {
        if (gx < margin || gx >= GRID_W - margin || gy < margin || gy >= GRID_H - margin) return false;
        if (placed.has(`${gx},${gy}`)) return false;
        if (!grid[gy] || !grid[gy][gx] || grid[gy][gx].type !== TYPE_FLOOR) return false;
        if (!isAllowedByShape(gx, gy)) return false;
        if (MAP_TYPE !== 'arena' && nearAnySpawn(gx, gy)) return false;
        placed.add(`${gx},${gy}`);
        let gold = GOLD_MINE_MIN + Math.floor(rng() * goldRange);
        let mine = { gx, gy, gold, maxGold: gold, x: gx * TILE + 16, y: gy * TILE + 16 };
        goldMines.push(mine);
        setTileEntity(gx, gy, TILE_ENTITY_GOLDMINE, mine);
        grid[gy][gx].type = TYPE_WALL;
        return true;
    };

    let addMinesFromCandidates = (candidates, shuffle = true) => {
        if (shuffle) {
            for (let i = candidates.length - 1; i > 0; i--) {
                let j = Math.floor(rng() * (i + 1));
                [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
            }
        }
        for (let c of candidates) {
            if (goldMines.length >= totalMines) break;
            addMine(c.gx, c.gy);
        }
    };

    let buildArenaEdgeSpiralCandidates = (ringWidth) => {
        let candidates = [];
        let seen = new Set();
        let add = (gx, gy) => {
            if (gx < margin || gx >= GRID_W - margin || gy < margin || gy >= GRID_H - margin) return;
            let k = `${gx},${gy}`;
            if (seen.has(k)) return;
            seen.add(k);
            candidates.push({ gx, gy });
        };

        for (let layer = 0; layer <= ringWidth; layer++) {
            let left = margin + layer;
            let right = GRID_W - 1 - margin - layer;
            let top = margin + layer;
            let bottom = GRID_H - 1 - margin - layer;
            if (left > right || top > bottom) break;

            for (let gx = left; gx <= right; gx++) add(gx, top);
            for (let gy = top + 1; gy <= bottom; gy++) add(right, gy);
            if (bottom > top) {
                for (let gx = right - 1; gx >= left; gx--) add(gx, bottom);
            }
            if (right > left) {
                for (let gy = bottom - 1; gy > top; gy--) add(left, gy);
            }
        }

        return candidates;
    };

    let generateRandomMines = () => {
        let remaining = totalMines - goldMines.length;
        let veinSeeds = [];
        while (remaining > 0) {
            let veinSize = Math.min(remaining, 3 + Math.floor(rng() * 4));
            veinSeeds.push(veinSize);
            remaining -= veinSize;
        }

        for (let veinSize of veinSeeds) {
            let seedGx = -1, seedGy = -1;
            for (let att = 0; att < 100; att++) {
                let gx = margin + Math.floor(rng() * Math.max(1, GRID_W - margin * 2));
                let gy = margin + Math.floor(rng() * Math.max(1, GRID_H - margin * 2));
                if (!placed.has(`${gx},${gy}`) && !nearAnySpawn(gx, gy) && isAllowedByShape(gx, gy) && grid[gy][gx].type === TYPE_FLOOR) {
                    seedGx = gx; seedGy = gy;
                    break;
                }
            }
            if (seedGx < 0) continue;

            let frontier = [{ x: seedGx, y: seedGy }];
            let placedCount = 0;
            while (placedCount < veinSize && frontier.length > 0) {
                let idx = Math.floor(rng() * frontier.length);
                let tile = frontier[idx];
                frontier.splice(idx, 1);
                if (addMine(tile.x, tile.y)) {
                    placedCount++;
                    for (let [dx, dy] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) {
                        let nx = tile.x + dx, ny = tile.y + dy;
                        if (nx >= margin && nx < GRID_W - margin && ny >= margin && ny < GRID_H - margin) {
                            frontier.push({ x: nx, y: ny });
                        }
                    }
                }
            }
        }
    };

    let mapMin = Math.min(GRID_W, GRID_H);
    let centerX = (GRID_W - 1) / 2;
    let centerY = (GRID_H - 1) / 2;

    if (MAP_TYPE === 'arena') {
        let ringWidth = Math.max(2, Math.floor(mapMin * 0.16));
        shapeMask = (gx, gy) => {
            let edgeDist = Math.min(gx, gy, GRID_W - 1 - gx, GRID_H - 1 - gy);
            return edgeDist <= ringWidth;
        };
        let candidates = buildArenaEdgeSpiralCandidates(ringWidth);
        totalMines = Math.max(totalMines, candidates.length);
        addMinesFromCandidates(candidates, false);
    } else if (MAP_TYPE === 'island') {
        let islandRadius = Math.max(4, Math.floor(mapMin * 0.19));
        shapeMask = (gx, gy) => Math.hypot(gx - centerX, gy - centerY) <= islandRadius;
        let candidates = [];
        for (let gy = margin; gy < GRID_H - margin; gy++) {
            for (let gx = margin; gx < GRID_W - margin; gx++) {
                let d = Math.hypot(gx - centerX, gy - centerY);
                if (d <= islandRadius) candidates.push({ gx, gy, d });
            }
        }
        candidates.sort((a, b) => a.d - b.d);
        addMinesFromCandidates(candidates, false);
    } else if (MAP_TYPE === 'islands') {
        let anchors = (spawnTiles && spawnTiles.length > 0) ? spawnTiles : pickEdgePlayerSpawns(2);
        let centerPull = 0.3;
        let islandRadius = Math.max(4, Math.floor(mapMin * Math.max(0.08, 0.2 - anchors.length * 0.015)));
        let islandCenters = anchors.map(s => ({
            cx: s.gx + (centerX - s.gx) * centerPull,
            cy: s.gy + (centerY - s.gy) * centerPull
        }));

        shapeMask = (gx, gy) => islandCenters.some(c => Math.hypot(gx - c.cx, gy - c.cy) <= islandRadius);

        let candidates = [];
        for (let gy = margin; gy < GRID_H - margin; gy++) {
            for (let gx = margin; gx < GRID_W - margin; gx++) {
                let best = Infinity;
                for (let c of islandCenters) {
                    let d = Math.hypot(gx - c.cx, gy - c.cy);
                    if (d < best) best = d;
                }
                if (best <= islandRadius) candidates.push({ gx, gy, d: best });
            }
        }
        candidates.sort((a, b) => a.d - b.d);
        addMinesFromCandidates(candidates, false);
    } else if (MAP_TYPE === 'solar_system') {
        shapeMask = (gx, gy) => {
            let d = Math.hypot(gx - centerX, gy - centerY);
            let maxDist = Math.hypot(centerX - margin, centerY - margin);
            let norm = Math.min(1, d / Math.max(1, maxDist));
            return norm <= 0.98;
        };
        let candidates = [];
        let maxDist = Math.hypot(centerX - margin, centerY - margin);
        for (let gy = margin; gy < GRID_H - margin; gy++) {
            for (let gx = margin; gx < GRID_W - margin; gx++) {
                let d = Math.hypot(gx - centerX, gy - centerY);
                let norm = Math.min(1, d / Math.max(1, maxDist));
                let p = Math.pow(Math.max(0, 1 - norm), 6.5);
                if (norm <= 0.12 || rng() < p) candidates.push({ gx, gy });
            }
        }
        addMinesFromCandidates(candidates);
    } else if (MAP_TYPE === 'crossroads') {
        let armHalf = Math.max(2, Math.floor(mapMin * 0.08));
        shapeMask = (gx, gy) => Math.abs(gx - centerX) <= armHalf || Math.abs(gy - centerY) <= armHalf;
        let candidates = [];
        for (let gy = margin; gy < GRID_H - margin; gy++) {
            for (let gx = margin; gx < GRID_W - margin; gx++) {
                let onVertical = Math.abs(gx - centerX) <= armHalf;
                let onHorizontal = Math.abs(gy - centerY) <= armHalf;
                if (onVertical || onHorizontal) candidates.push({ gx, gy });
            }
        }
        addMinesFromCandidates(candidates);
    } else {
        generateRandomMines();
    }

    if (MAP_TYPE !== 'arena' && goldMines.length < totalMines) {
        generateRandomMines();
    }
}

function generateAstarMines() {
    let spawnTiles = arguments.length > 0 && arguments[0] ? arguments[0] : [];
    for (let m of astarMines) {
        if (!m) continue;
        clearTileEntity(Math.floor(Number(m.gx)), Math.floor(Number(m.gy)), m);
    }
    astarMines = [];
    let totalMines = Math.max(0, Math.floor(ASTAR_MINE_COUNT || 0));
    let margin = 1;
    let spawnSafeRadius = 3;
    let placed = new Set();
    let astarRange = Math.max(0, ASTAR_MINE_MAX - ASTAR_MINE_MIN);

    let nearAnySpawn = (gx, gy) => {
        if (!spawnTiles || spawnTiles.length === 0) return false;
        return spawnTiles.some(s => Math.hypot(gx - s.gx, gy - s.gy) <= spawnSafeRadius);
    };

    let addMine = (gx, gy) => {
        if (gx < margin || gx >= GRID_W - margin || gy < margin || gy >= GRID_H - margin) return false;
        if (placed.has(`${gx},${gy}`)) return false;
        if (!grid[gy] || !grid[gy][gx] || grid[gy][gx].type !== TYPE_FLOOR) return false;
        if (MAP_TYPE !== 'arena' && nearAnySpawn(gx, gy)) return false;
        if (getGoldMineAt(gx, gy) || getAstarMineAt(gx, gy)) return false;
        placed.add(`${gx},${gy}`);
        let astar = ASTAR_MINE_MIN + Math.floor(rng() * astarRange);
        let mine = { gx, gy, astar, maxAstar: astar, x: gx * TILE + 16, y: gy * TILE + 16 };
        astarMines.push(mine);
        setTileEntity(gx, gy, TILE_ENTITY_ASTARMINE, mine);
        grid[gy][gx].type = TYPE_WALL;
        return true;
    };

    let attempts = Math.max(totalMines * 20, 200);
    for (let i = 0; i < attempts && astarMines.length < totalMines; i++) {
        let gx = margin + Math.floor(rng() * Math.max(1, GRID_W - margin * 2));
        let gy = margin + Math.floor(rng() * Math.max(1, GRID_H - margin * 2));
        addMine(gx, gy);
    }
}

function pickRandomPlayerSpawns(teamCount = 2) {
    teamCount = Math.max(2, Math.min(8, Math.floor(teamCount || 2)));
    let margin = 2;
    let minSpawnSeparation = Math.max(8, Math.floor(Math.min(GRID_W, GRID_H) * (teamCount <= 3 ? 0.28 : 0.18)));

    function randomFloorTile() {
        for (let i = 0; i < 120; i++) {
            let gx = margin + Math.floor(rng() * Math.max(1, GRID_W - margin * 2));
            let gy = margin + Math.floor(rng() * Math.max(1, GRID_H - margin * 2));
            if (gx >= 0 && gx < GRID_W && gy >= 0 && gy < GRID_H && grid[gy][gx].type === TYPE_FLOOR) {
                return { gx, gy };
            }
        }
        return null;
    }

    for (let att = 0; att < 240; att++) {
        let picks = [];
        let ok = true;
        for (let i = 0; i < teamCount; i++) {
            let tile = randomFloorTile();
            if (!tile) { ok = false; break; }
            let tooClose = picks.some(p => (Math.abs(p.gx - tile.gx) + Math.abs(p.gy - tile.gy)) < minSpawnSeparation);
            if (tooClose) { ok = false; break; }
            picks.push(tile);
        }
        if (ok && picks.length === teamCount) return picks;
    }

    let fallback = [];
    for (let i = 0; i < teamCount; i++) {
        let t = i / teamCount;
        let gx = Math.max(1, Math.min(GRID_W - 2, Math.floor((GRID_W - 2) * t) + 1));
        let gy = (i % 2 === 0) ? Math.max(1, Math.min(GRID_H - 2, 3)) : Math.max(1, Math.min(GRID_H - 2, GRID_H - 4));
        fallback.push({ gx, gy });
    }
    return fallback;
}

function pickEdgePlayerSpawns(teamCount = 2) {
    teamCount = Math.max(2, Math.min(8, Math.floor(teamCount || 2)));
    let margin = 2;
    let candidates = [];
    for (let gy = margin; gy < GRID_H - margin; gy++) {
        for (let gx = margin; gx < GRID_W - margin; gx++) {
            if (grid[gy][gx].type !== TYPE_FLOOR) continue;
            let edgeDist = Math.min(gx - margin, gy - margin, (GRID_W - 1 - margin) - gx, (GRID_H - 1 - margin) - gy);
            if (edgeDist <= 1) candidates.push({ gx, gy });
        }
    }
    if (!candidates.length) return pickRandomPlayerSpawns(teamCount);

    let picks = [];
    let first = candidates[Math.floor(rng() * candidates.length)];
    picks.push(first);
    while (picks.length < teamCount) {
        let best = null;
        let bestScore = -1;
        for (let c of candidates) {
            if (picks.some(p => p.gx === c.gx && p.gy === c.gy)) continue;
            let nearest = Infinity;
            for (let p of picks) {
                let d = Math.hypot(c.gx - p.gx, c.gy - p.gy);
                if (d < nearest) nearest = d;
            }
            if (nearest > bestScore) {
                bestScore = nearest;
                best = c;
            }
        }
        if (!best) break;
        picks.push(best);
    }

    if (picks.length < teamCount) return pickRandomPlayerSpawns(teamCount);
    return picks;
}

function pickIslandPlayerSpawns(teamCount = 2) {
    teamCount = Math.max(2, Math.min(8, Math.floor(teamCount || 2)));
    let centerX = (GRID_W - 1) / 2;
    let centerY = (GRID_H - 1) / 2;
    let radius = Math.max(6, Math.floor(Math.min(GRID_W, GRID_H) * 0.34));
    let picks = [];
    for (let i = 0; i < teamCount; i++) {
        let ang = (Math.PI * 2 * i) / teamCount;
        let gx = Math.round(centerX + Math.cos(ang) * radius);
        let gy = Math.round(centerY + Math.sin(ang) * radius);
        gx = Math.max(1, Math.min(GRID_W - 2, gx));
        gy = Math.max(1, Math.min(GRID_H - 2, gy));
        if (grid[gy][gx].type !== TYPE_FLOOR) {
            let n = findNearestWalkable(gx, gy, centerX, centerY);
            gx = n.x; gy = n.y;
        }
        picks.push({ gx, gy });
    }
    return picks;
}

function pickIslandsPlayerSpawns(teamCount = 2) {
    teamCount = Math.max(2, Math.min(8, Math.floor(teamCount || 2)));
    let margin = 1;
    let candidates = [];
    for (let gy = margin; gy < GRID_H - margin; gy++) {
        for (let gx = margin; gx < GRID_W - margin; gx++) {
            if (grid[gy][gx].type !== TYPE_FLOOR) continue;
            let edgeDist = Math.min(gx - margin, gy - margin, (GRID_W - 1 - margin) - gx, (GRID_H - 1 - margin) - gy);
            if (edgeDist <= 1) candidates.push({ gx, gy });
        }
    }
    if (!candidates.length) return pickEdgePlayerSpawns(teamCount);

    let picks = [];
    let first = candidates[Math.floor(rng() * candidates.length)];
    picks.push(first);
    while (picks.length < teamCount) {
        let best = null;
        let bestScore = -1;
        for (let c of candidates) {
            if (picks.some(p => p.gx === c.gx && p.gy === c.gy)) continue;
            let nearest = Infinity;
            for (let p of picks) {
                let d = Math.hypot(c.gx - p.gx, c.gy - p.gy);
                if (d < nearest) nearest = d;
            }
            if (nearest > bestScore) {
                bestScore = nearest;
                best = c;
            }
        }
        if (!best) break;
        picks.push(best);
    }

    if (picks.length < teamCount) return pickEdgePlayerSpawns(teamCount);
    return picks;
}

function pickArenaPlayerSpawns(teamCount = 2) {
    teamCount = Math.max(2, Math.min(8, Math.floor(teamCount || 2)));
    let margin = 1;
    let ringWidth = Math.max(2, Math.floor(Math.min(GRID_W, GRID_H) * 0.16));
    let targetEdgeDist = ringWidth + 1;
    let candidates = [];

    for (let gy = margin; gy < GRID_H - margin; gy++) {
        for (let gx = margin; gx < GRID_W - margin; gx++) {
            if (grid[gy][gx].type !== TYPE_FLOOR) continue;
            let edgeDist = Math.min(gx, gy, GRID_W - 1 - gx, GRID_H - 1 - gy);
            if (edgeDist === targetEdgeDist) candidates.push({ gx, gy });
        }
    }

    if (!candidates.length) {
        for (let gy = margin; gy < GRID_H - margin; gy++) {
            for (let gx = margin; gx < GRID_W - margin; gx++) {
                if (grid[gy][gx].type !== TYPE_FLOOR) continue;
                let edgeDist = Math.min(gx, gy, GRID_W - 1 - gx, GRID_H - 1 - gy);
                if (Math.abs(edgeDist - targetEdgeDist) <= 1) candidates.push({ gx, gy });
            }
        }
    }

    if (!candidates.length) return pickEdgePlayerSpawns(teamCount);

    let picks = [];
    let first = candidates[Math.floor(rng() * candidates.length)];
    picks.push(first);
    while (picks.length < teamCount) {
        let best = null;
        let bestScore = -1;
        for (let c of candidates) {
            if (picks.some(p => p.gx === c.gx && p.gy === c.gy)) continue;
            let nearest = Infinity;
            for (let p of picks) {
                let d = Math.hypot(c.gx - p.gx, c.gy - p.gy);
                if (d < nearest) nearest = d;
            }
            if (nearest > bestScore) {
                bestScore = nearest;
                best = c;
            }
        }
        if (!best) break;
        picks.push(best);
    }

    if (picks.length < teamCount) return pickEdgePlayerSpawns(teamCount);
    return picks;
}

function pickPlayerSpawns(teamCount = 2) {
    if (MAP_TYPE === 'arena') return pickArenaPlayerSpawns(teamCount);
    if (MAP_TYPE === 'solar_system') return pickEdgePlayerSpawns(teamCount);
    if (MAP_TYPE === 'islands') return pickIslandsPlayerSpawns(teamCount);
    if (MAP_TYPE === 'island') return pickIslandPlayerSpawns(teamCount);
    return pickRandomPlayerSpawns(teamCount);
}