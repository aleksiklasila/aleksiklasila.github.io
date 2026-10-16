"use strict";

// ============================================================
// GRID & MAP INITIALIZATION
// ============================================================
function initGrid() {
    grid = [];
    areaIdGrid = [];
    initDroppedItemGrid();
    workerReservedTiles = new Array(Math.max(0, GRID_W * GRID_H * _WORKER_TARGET_LOAD_TYPE_COUNT)).fill(null);
    for (let y = 0; y < GRID_H; y++) {
        let row = [];
        let areaRow = new Int32Array(GRID_W).fill(-1);
        for (let x = 0; x < GRID_W; x++) {
            row.push({ type: TYPE_FLOOR, item: null, owner: -1, areaId: -1, droppedItem: null });
        }
        grid.push(row);
        areaIdGrid.push(areaRow);
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
                if (areaIdGrid[cur.y]) areaIdGrid[cur.y][cur.x] = areaId;
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

    rebuildAreaDistanceCachesFromAreas();
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

    // Every map type is a shape that holds the mines the host asked for (the
    // density: a share of the map's tiles) and a pattern of the two
    // resources of its own:
    //   order(gx, gy)  the lower, the sooner a tile is taken: the first
    //                  totalMines tiles are the mines, so more of them make
    //                  the shape bigger (thicker arms, a wider ring, bigger
    //                  islands), never denser or sparser;
    //   score(gx, gy)  the higher, the sooner a taken tile is a \u2605 mine:
    //                  the first totalAstar by it are, the rest energy, so
    //                  both counts are exact whatever the pattern.
    // The patterns are the same around the map's centre or around every
    // spawn, so no player starts with only one resource in reach.
    let L = mapMineLayout(), margin = L.margin, centerX = L.cx, centerY = L.cy;
    // (Room for a base around every spawn, whatever the density: more of
    // it on bigger maps.)
    let spawnSafeRadius = Math.max(4, Math.min(8, Math.round(L.mapMin * 0.1)));
    let share = totalAstar / totalMines;
    let jitter = amount => amount * rng();
    // Around bodies (islets, a sun and its planets): a tile belongs to the
    // nearest body by its distance in that body's radii.
    let bodies = null;
    let nearestBody = (gx, gy) => {
        let best = null, bestD = Infinity;
        for (let body of bodies) {
            let d = detHypot(gx - body.cx, gy - body.cy) / body.r;
            if (d < bestD) { bestD = d; best = body; }
        }
        return [best, bestD];
    };
    // (A body grows to its `most` tiles of radius at most.)
    let bodyOrder = (gx, gy) => { let [body, d] = nearestBody(gx, gy); return d * body.r > body.most ? Infinity : d + jitter(0.02); };
    let bodyScore = (gx, gy) => { let [body, d] = nearestBody(gx, gy); let rim = Math.min(1, d) * 0.4; return body.astar ? 1 - rim : rim; };
    // (A radius whose discs, n of them, hold `count` tiles together.)
    let discRadius = (count, n) => Math.max(1.2, Math.sqrt(Math.max(1, count) / Math.max(1, n) / Math.PI));
    let order, score;

    if (MAP_TYPE === 'arena') {
        // A ring along the edge, wider with more mines; around it the two
        // resources in wedges (eight pairs).
        order = (gx, gy) => { let e = Math.min(gx - margin, gy - margin, GRID_W - 1 - margin - gx, GRID_H - 1 - margin - gy); return e > L.ringMost ? Infinity : e + jitter(0.9); };
        score = (gx, gy) => { let t = (detAtan2(gy - centerY, gx - centerX) / (Math.PI * 2) + 1) * 8; return 1 - (t - Math.floor(t)) + jitter(0.01); };
    } else if (MAP_TYPE === 'island') {
        // One island in the middle, bigger with more mines; the resources
        // in rings.
        let band = Math.max(3, Math.round(L.islandR / 4));
        order = (gx, gy) => { let d = detHypot(gx - centerX, gy - centerY); return d > L.islandMost ? Infinity : d + jitter(0.9); };
        score = (gx, gy) => { let t = detHypot(gx - centerX, gy - centerY) / band; return 1 - (t - Math.floor(t)) + jitter(0.01); };
    } else if (MAP_TYPE === 'islands') {
        // Every player has four islets around a point between its spawn and
        // the centre, each of one resource (two and two, across from each
        // other), bigger with more mines.
        let anchors = (spawnTiles && spawnTiles.length > 0) ? spawnTiles : pickEdgePlayerSpawns(2);
        let rG = discRadius(totalGold, anchors.length * 2), rA = discRadius(totalAstar, anchors.length * 2);
        rG = Math.min(rG, L.mapMin * 0.13); rA = Math.min(rA, L.mapMin * 0.13);
        let reach = (rG + rA) * 0.72 + 1.5;
        bodies = [];
        for (let sp of anchors) {
            // (The same way off for every player, toward the centre: far
            // enough that no islet is cut off by the map's edge, from a
            // corner either, while there is room.)
            let room = (reach + Math.max(rG, rA) + margin + 1) * Math.SQRT2, toCentre = detHypot(centerX - sp.gx, centerY - sp.gy);
            let along = Math.min(room, toCentre * 0.9) / Math.max(1, toCentre);
            let cx = sp.gx + (centerX - sp.gx) * along, cy = sp.gy + (centerY - sp.gy) * along;
            let toward = detAtan2(centerY - cy, centerX - cx) + Math.PI / 4;
            for (let i = 0; i < 4; i++) {
                let astar = totalAstar > 0 && (totalGold <= 0 || i % 2 === 1), ang = toward + i * Math.PI / 2;
                bodies.push({ cx: cx + detCos(ang) * reach, cy: cy + detSin(ang) * reach, r: astar ? rA : rG, astar, most: L.mapMin * 0.13 });
            }
        }
        order = bodyOrder; score = bodyScore;
    } else if (MAP_TYPE === 'solar_system') {
        // A sun of energy in the middle and planets on four orbits, each of
        // one resource (\u2605 and energy in turn along an orbit), all
        // bigger with more mines.
        let half = Math.max(4, L.mapMin / 2 - margin - 1);
        let orbits = [[0.3, 4], [0.5, 6], [0.72, 8], [0.92, 10]];
        let planets = 0; for (let [, n] of orbits) planets += n;
        let astarPlanets = totalAstar > 0 ? (totalGold > 0 ? planets / 2 : planets) : 0, goldPlanets = planets - astarPlanets;
        let sunGold = totalGold > 0 ? Math.round(totalGold * (goldPlanets > 0 ? 0.45 : 1)) : 0;
        let rSun = discRadius(sunGold > 0 ? sunGold : totalAstar * 0.3, 1);
        let rG = discRadius(totalGold - sunGold, goldPlanets), rA = discRadius(sunGold > 0 ? totalAstar : totalAstar * 0.7, astarPlanets);
        bodies = [{ cx: centerX, cy: centerY, r: rSun, astar: totalGold <= 0, most: L.mapMin * 0.16 }];
        for (let [at, n] of orbits) {
            let phase = rng() * Math.PI * 2;
            for (let i = 0; i < n; i++) {
                let astar = totalAstar > 0 && (totalGold <= 0 || i % 2 === 0), ang = phase + i * Math.PI * 2 / n;
                bodies.push({ cx: centerX + detCos(ang) * half * at, cy: centerY + detSin(ang) * half * at, r: astar ? rA : rG, astar, most: L.mapMin * 0.07 });
            }
        }
        order = bodyOrder; score = bodyScore;
    } else if (MAP_TYPE === 'crossroads') {
        // Two roads of mines crossing in the middle, thicker with more
        // mines; along them lines of one resource, then of the other.
        let line = Math.max(2, Math.round(L.armHalf / 3));
        let off = (gx, gy) => Math.min(Math.abs(gx - centerX), Math.abs(gy - centerY));
        order = (gx, gy) => { let o = off(gx, gy); return o > L.armMost ? Infinity : o + jitter(0.9); };
        score = (gx, gy) => { let t = off(gx, gy) / (line * 2); return 1 - (t - Math.floor(t)) + jitter(0.01); };
    } else {
        // Random: anywhere, either resource.
        order = () => rng();
        score = () => rng();
    }

    let tiles = [];
    for (let gy = margin; gy < GRID_H - margin; gy++) {
        let row = grid[gy];
        if (!row) continue;
        for (let gx = margin; gx < GRID_W - margin; gx++) {
            if (!row[gx] || row[gx].type !== TYPE_FLOOR) continue;
            if (MAP_TYPE !== 'arena' && spawnTiles && spawnTiles.length > 0 && spawnTiles.some(sp => detHypot(gx - sp.gx, gy - sp.gy) <= spawnSafeRadius)) continue;
            let o = order(gx, gy);
            if (o < Infinity) tiles.push({ gx, gy, o, s: 0 });
        }
    }
    tiles.sort((p, q) => p.o - q.o || p.gy - q.gy || p.gx - q.gx);
    let taken = tiles.slice(0, Math.min(tiles.length, totalMines));
    for (let t of taken) t.s = score(t.gx, t.gy);
    // (Fewer tiles than mines asked for: both resources keep their share.)
    let astarCount = taken.length >= totalMines ? totalAstar : Math.round(taken.length * share);
    if (totalGold > 0 && totalAstar > 0 && taken.length >= 2) astarCount = Math.max(1, Math.min(taken.length - 1, astarCount));
    let byScore = taken.slice().sort((p, q) => q.s - p.s || p.gy - q.gy || p.gx - q.gx);
    for (let i = 0; i < byScore.length; i++) byScore[i].astar = i < astarCount;
    // (Placed row by row: the mines' lists in the map's order.)
    taken.sort((p, q) => p.gy - q.gy || p.gx - q.gx);

    let goldRange = Math.max(0, GOLD_MINE_MAX - GOLD_MINE_MIN);
    let astarRange = Math.max(0, ASTAR_MINE_MAX - ASTAR_MINE_MIN);
    for (let t of taken) {
        if (t.astar) {
            let astar = ASTAR_MINE_MIN + Math.floor(rng() * astarRange);
            let mine = Object.assign(new AstarMine(), { gx: t.gx, gy: t.gy, astar, maxAstar: astar, x: t.gx * TILE + 16, y: t.gy * TILE + 16 });
            astarMines.push(mine);
            setTileEntity(t.gx, t.gy, TILE_ENTITY_ASTARMINE, mine);
        } else {
            let gold = GOLD_MINE_MIN + Math.floor(rng() * goldRange);
            let mine = Object.assign(new GoldMine(), { gx: t.gx, gy: t.gy, gold, maxGold: gold, x: t.gx * TILE + 16, y: t.gy * TILE + 16 });
            goldMines.push(mine);
            setTileEntity(t.gx, t.gy, TILE_ENTITY_GOLDMINE, mine);
        }
        grid[t.gy][t.gx].type = TYPE_WALL;
        if (typeof simMoveTileTypeChanged === 'function') simMoveTileTypeChanged(t.gx, t.gy);
    }
}

// Every player starts near both resources (when the map has both): each
// spawn moves to the nearest free tile, with a little room around it, that
// has an energy mine and a ★ mine within a few tiles (the fewest tiles
// that any tile of the map offers, from SPAWN_RESOURCE_REACH up), keeping
// its distance to the other players' spawns. The same rule for every
// player, on patterns that are the same around the centre or around each
// spawn: nobody starts in a corner of nothing.
// (Room for a base: SPAWN_CLEAR free tiles every way, and most of the
// tiles within SPAWN_OPEN free: beside the mines, not in a pocket of them.)
const SPAWN_RESOURCE_REACH = 6, SPAWN_CLEAR = 3, SPAWN_OPEN = 8, SPAWN_OPEN_SHARE = 0.62;
function settleSpawnsNearResources(spawns) {
    if (!Array.isArray(spawns) || spawns.length === 0 || goldMines.length === 0 || astarMines.length === 0) return spawns;
    const W = GRID_W, H = GRID_H, n = W * H;
    // Distance (in tiles, the larger of dx and dy) to the nearest mine of each kind, up to a cap.
    const CAP = Math.max(8, Math.min(48, Math.floor(Math.min(W, H) / 3)));
    const dist = mines => {
        const d = new Uint8Array(n).fill(CAP + 1);
        let frontier = [];
        for (const m of mines) { const i = m.gy * W + m.gx; if (d[i] !== 0) { d[i] = 0; frontier.push(i); } }
        for (let step = 1; step <= CAP && frontier.length; step++) {
            const next = [];
            for (const i of frontier) {
                const x = i % W, y = (i - x) / W;
                for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
                    const nx = x + dx, ny = y + dy;
                    if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
                    const j = ny * W + nx;
                    if (d[j] > step) { d[j] = step; next.push(j); }
                }
            }
            frontier = next;
        }
        return d;
    };
    const dG = dist(goldMines), dA = dist(astarMines);
    // (Free tiles in any box: a summed table.)
    const sum = new Int32Array((W + 1) * (H + 1));
    for (let y = 0; y < H; y++) for (let x = 0, run = 0; x < W; x++) {
        const c = grid[y] && grid[y][x];
        run += c && c.type === TYPE_FLOOR ? 1 : 0;
        sum[(y + 1) * (W + 1) + x + 1] = sum[y * (W + 1) + x + 1] + run;
    }
    const open = (gx, gy) => {
        const x0 = Math.max(0, gx - SPAWN_OPEN), y0 = Math.max(0, gy - SPAWN_OPEN), x1 = Math.min(W, gx + SPAWN_OPEN + 1), y1 = Math.min(H, gy + SPAWN_OPEN + 1);
        const free = sum[y1 * (W + 1) + x1] - sum[y0 * (W + 1) + x1] - sum[y1 * (W + 1) + x0] + sum[y0 * (W + 1) + x0];
        return free >= SPAWN_OPEN_SHARE * (2 * SPAWN_OPEN + 1) * (2 * SPAWN_OPEN + 1);
    };
    const clear = (gx, gy) => {
        for (let dy = -SPAWN_CLEAR; dy <= SPAWN_CLEAR; dy++) for (let dx = -SPAWN_CLEAR; dx <= SPAWN_CLEAR; dx++) {
            const x = gx + dx, y = gy + dy;
            if (x < 1 || y < 1 || x >= W - 1 || y >= H - 1) return false;
            const c = grid[y] && grid[y][x];
            if (!c || c.type !== TYPE_FLOOR) return false;
        }
        return true;
    };
    // (Apart: most of what the original spawns were, never under a few tiles.)
    let apart = Infinity;
    for (let i = 0; i < spawns.length; i++) for (let j = i + 1; j < spawns.length; j++) apart = Math.min(apart, detHypot(spawns[i].gx - spawns[j].gx, spawns[i].gy - spawns[j].gy));
    apart = Number.isFinite(apart) ? Math.max(6, apart * 0.6) : 0;
    const out = [];
    for (let k = 0; k < spawns.length; k++) {
        const sp = spawns[k];
        let best = null, bestNeed = Infinity, bestD = Infinity;
        for (let gy = 1 + SPAWN_CLEAR; gy < H - 1 - SPAWN_CLEAR; gy++) for (let gx = 1 + SPAWN_CLEAR; gx < W - 1 - SPAWN_CLEAR; gx++) {
            const i = gy * W + gx, need = Math.max(SPAWN_RESOURCE_REACH, dG[i], dA[i]);
            if (need > CAP || need > bestNeed) continue;
            const d = detHypot(gx - sp.gx, gy - sp.gy);
            if (need === bestNeed && d >= bestD) continue;
            if (!open(gx, gy) || !clear(gx, gy)) continue;
            let ok = true;
            for (let j = 0; ok && j < spawns.length; j++) {
                if (j === k) continue;
                const o = j < k ? out[j] : spawns[j];
                if (detHypot(gx - o.gx, gy - o.gy) < apart) ok = false;
            }
            if (!ok) continue;
            best = { gx, gy }; bestNeed = need; bestD = d;
        }
        out.push(best || sp);
    }
    return out;
}

// The numbers of a map's layout that its mines and its spawns share: how
// wide the arena's ring, how big the island, how thick the crossroads' arms
// have to be for the mines the host asked for (their density).
function mapMineLayout() {
    let total = Math.max(0, Math.floor(GOLD_MINE_COUNT || 0)) + Math.max(0, Math.floor(ASTAR_MINE_COUNT || 0));
    let margin = 1, mapMin = Math.min(GRID_W, GRID_H), iw = GRID_W - 2 * margin, ih = GRID_H - 2 * margin;
    let most = Math.max(1, Math.floor(mapMin / 2) - 2);
    let ring = 1;
    while (ring < most && iw * ih - Math.max(0, iw - 2 * ring) * Math.max(0, ih - 2 * ring) < total) ring++;
    let arm = 0;
    while (arm < most && (2 * arm + 1) * (iw + ih) - (2 * arm + 1) * (2 * arm + 1) < total) arm++;
    return {
        total, margin, mapMin, cx: (GRID_W - 1) / 2, cy: (GRID_H - 1) / 2,
        // The most each shape grows to, whatever the density asks for (the
        // mines past it are left out): the arena keeps its middle, the
        // island a shore around it, the crossroads their four fields.
        ringMost: Math.max(2, Math.floor(mapMin * 0.3)), islandMost: Math.max(3, mapMin * 0.36), armMost: Math.max(1, Math.floor(mapMin * 0.2)),
        arenaRing: Math.max(2, Math.min(ring, Math.floor(mapMin * 0.3))), armHalf: Math.max(1, Math.min(arm, Math.floor(mapMin * 0.2))),
        islandR: Math.max(3, Math.min(most, mapMin * 0.36, Math.ceil(Math.sqrt(total / Math.PI))))
    };
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
        return spawnTiles.some(s => detHypot(gx - s.gx, gy - s.gy) <= spawnSafeRadius);
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
        let mine = Object.assign(new GoldMine(), { gx, gy, gold, maxGold: gold, x: gx * TILE + 16, y: gy * TILE + 16 });
        goldMines.push(mine);
        setTileEntity(gx, gy, TILE_ENTITY_GOLDMINE, mine);
        grid[gy][gx].type = TYPE_WALL;
        if (typeof simMoveTileTypeChanged === 'function') simMoveTileTypeChanged(gx, gy);
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
        shapeMask = (gx, gy) => detHypot(gx - centerX, gy - centerY) <= islandRadius;
        let candidates = [];
        for (let gy = margin; gy < GRID_H - margin; gy++) {
            for (let gx = margin; gx < GRID_W - margin; gx++) {
                let d = detHypot(gx - centerX, gy - centerY);
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

        shapeMask = (gx, gy) => islandCenters.some(c => detHypot(gx - c.cx, gy - c.cy) <= islandRadius);

        let candidates = [];
        for (let gy = margin; gy < GRID_H - margin; gy++) {
            for (let gx = margin; gx < GRID_W - margin; gx++) {
                let best = Infinity;
                for (let c of islandCenters) {
                    let d = detHypot(gx - c.cx, gy - c.cy);
                    if (d < best) best = d;
                }
                if (best <= islandRadius) candidates.push({ gx, gy, d: best });
            }
        }
        candidates.sort((a, b) => a.d - b.d);
        addMinesFromCandidates(candidates, false);
    } else if (MAP_TYPE === 'solar_system') {
        shapeMask = (gx, gy) => {
            let d = detHypot(gx - centerX, gy - centerY);
            let maxDist = detHypot(centerX - margin, centerY - margin);
            let norm = Math.min(1, d / Math.max(1, maxDist));
            return norm <= 0.98;
        };
        let candidates = [];
        let maxDist = detHypot(centerX - margin, centerY - margin);
        for (let gy = margin; gy < GRID_H - margin; gy++) {
            for (let gx = margin; gx < GRID_W - margin; gx++) {
                let d = detHypot(gx - centerX, gy - centerY);
                let norm = Math.min(1, d / Math.max(1, maxDist));
                let p = detPow(Math.max(0, 1 - norm), 6.5);
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
        return spawnTiles.some(s => detHypot(gx - s.gx, gy - s.gy) <= spawnSafeRadius);
    };

    let addMine = (gx, gy) => {
        if (gx < margin || gx >= GRID_W - margin || gy < margin || gy >= GRID_H - margin) return false;
        if (placed.has(`${gx},${gy}`)) return false;
        if (!grid[gy] || !grid[gy][gx] || grid[gy][gx].type !== TYPE_FLOOR) return false;
        if (MAP_TYPE !== 'arena' && nearAnySpawn(gx, gy)) return false;
        if (getGoldMineAt(gx, gy) || getAstarMineAt(gx, gy)) return false;
        placed.add(`${gx},${gy}`);
        let astar = ASTAR_MINE_MIN + Math.floor(rng() * astarRange);
        let mine = Object.assign(new AstarMine(), { gx, gy, astar, maxAstar: astar, x: gx * TILE + 16, y: gy * TILE + 16 });
        astarMines.push(mine);
        setTileEntity(gx, gy, TILE_ENTITY_ASTARMINE, mine);
        grid[gy][gx].type = TYPE_WALL;
        if (typeof simMoveTileTypeChanged === 'function') simMoveTileTypeChanged(gx, gy);
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
                let d = detHypot(c.gx - p.gx, c.gy - p.gy);
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
    // (Outside the island, however big the density made it.)
    let radius = Math.max(6, Math.floor(Math.min(GRID_W, GRID_H) * 0.34), Math.min(Math.floor(Math.min(GRID_W, GRID_H) / 2) - 3, mapMineLayout().islandR + 5));
    let picks = [];
    for (let i = 0; i < teamCount; i++) {
        let ang = (Math.PI * 2 * i) / teamCount;
        let gx = Math.round(centerX + detCos(ang) * radius);
        let gy = Math.round(centerY + detSin(ang) * radius);
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
                let d = detHypot(c.gx - p.gx, c.gy - p.gy);
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
    // (Just inside the ring of mines, as wide as the density made it.)
    // (Never nearer the edge than a sixth of the map: where they stood
    // before the ring followed the density.)
    let ringWidth = Math.min(Math.max(2, Math.floor(Math.min(GRID_W, GRID_H) / 2) - 4), mapMineLayout().arenaRing);
    let targetEdgeDist = Math.max(ringWidth + 2, Math.max(2, Math.floor(Math.min(GRID_W, GRID_H) * 0.16)) + 1);
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
                let d = detHypot(c.gx - p.gx, c.gy - p.gy);
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

// Crossroads: between the roads, every player as far from them as the next
// (around the centre, from a diagonal on).
function pickCrossroadsPlayerSpawns(teamCount = 2) {
    teamCount = Math.max(2, Math.min(8, Math.floor(teamCount || 2)));
    let L = mapMineLayout(), half = L.mapMin / 2 - 2;
    let off = Math.min(half - 2, L.armHalf + 2 + Math.max(0, half - L.armHalf - 4) * 0.5);
    let picks = [];
    for (let i = 0; i < teamCount; i++) {
        let ang = Math.PI / 4 + (Math.PI * 2 * i) / teamCount;
        // (On the square through the diagonals' points: the same distance
        // from the nearer road for two and for four players.)
        let c = detCos(ang), sn = detSin(ang), k = off / Math.max(Math.abs(c), Math.abs(sn), 1e-6) * Math.SQRT1_2 * Math.SQRT2;
        let gx = Math.max(2, Math.min(GRID_W - 3, Math.round(L.cx + c * k)));
        let gy = Math.max(2, Math.min(GRID_H - 3, Math.round(L.cy + sn * k)));
        if (grid[gy][gx].type !== TYPE_FLOOR) { let n = findNearestWalkable(gx, gy, L.cx, L.cy); gx = n.x; gy = n.y; }
        picks.push({ gx, gy });
    }
    return picks;
}

function pickPlayerSpawns(teamCount = 2) {
    if (MAP_TYPE === 'crossroads') return pickCrossroadsPlayerSpawns(teamCount);
    if (MAP_TYPE === 'arena') return pickArenaPlayerSpawns(teamCount);
    if (MAP_TYPE === 'solar_system') return pickEdgePlayerSpawns(teamCount);
    if (MAP_TYPE === 'islands') return pickIslandsPlayerSpawns(teamCount);
    if (MAP_TYPE === 'island') return pickIslandPlayerSpawns(teamCount);
    return pickRandomPlayerSpawns(teamCount);
}
