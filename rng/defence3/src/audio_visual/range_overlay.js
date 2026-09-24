// Presentation-only range union shared by the Canvas and instanced WebGL paths.
let rangeBoundaryCache = { grid: null, areas: null, signature: '', lines: [], path: null };
const RANGE_AREA_HOLD_MS = 1000;
let rangeAreaEdges = new WeakMap();
let rangeClippedCache = { lines: null, key: '', result: [] };
const rangeCanvasPaths = new WeakMap();
const areaCoveragePaths = new WeakMap();

function getAreaCoveragePath(cells) {
    let path = areaCoveragePaths.get(cells);
    if (!path) {
        path = new Path2D();
        for (let l of buildRangeBoundary(cells, GRID_W, GRID_H)) {
            path.moveTo(l.x1 * TILE, l.z1 * TILE); path.lineTo(l.x2 * TILE, l.z2 * TILE);
        }
        areaCoveragePaths.set(cells, path);
    }
    return path;
}

function clipRangeBoundaryToBounds(lines, minX, minY, maxX, maxY) {
    let key = [minX,minY,maxX,maxY].join(',');
    if (rangeClippedCache.lines === lines && rangeClippedCache.key === key) return rangeClippedCache.result;
    let result = [];
    for (let l of lines) {
        if (l.z1 === l.z2) {
            if (l.z1 < minY || l.z1 > maxY || l.x2 < minX || l.x1 > maxX) continue;
            result.push({...l, x1:Math.max(minX,l.x1), x2:Math.min(maxX,l.x2)});
        } else {
            if (l.x1 < minX || l.x1 > maxX || l.z2 < minY || l.z1 > maxY) continue;
            result.push({...l, z1:Math.max(minY,l.z1), z2:Math.min(maxY,l.z2)});
        }
    }
    rangeClippedCache = {lines,key,result};
    return result;
}

function unionRangePerimeters(boundaries) {
    let rows = new Map(), columns = new Map();
    for (let lines of boundaries) for (let l of lines) {
        let horizontal = l.z1 === l.z2, map = horizontal ? rows : columns;
        let axis = horizontal ? l.z1 : l.x1;
        let start = horizontal ? l.x1 : l.z1, end = horizontal ? l.x2 : l.z2;
        let events = map.get(axis);
        if (!events) map.set(axis, events = new Map());
        events.set(start, (events.get(start) || 0) + 1);
        events.set(end, (events.get(end) || 0) - 1);
    }
    let result = [];
    for (let [map, horizontal] of [[rows, true], [columns, false]]) for (let [axis, events] of map) {
        let positions = Array.from(events.keys()).sort((a,b) => a-b), count = 0, start = null;
        for (let p of positions) {
            count += events.get(p);
            // Shared area edges occur twice and cancel, even when one edge
            // only covers part of the other area's long straight perimeter.
            if (count % 2 && start === null) start = p;
            if (!(count % 2) && start !== null) {
                result.push(horizontal
                    ? {x1:start,z1:axis,x2:p,z2:axis,color:'rgba(120,220,255,0.65)'}
                    : {x1:axis,z1:start,x2:axis,z2:p,color:'rgba(120,220,255,0.65)'});
                start = null;
            }
        }
    }
    return result;
}

function buildRangeBoundary(cells, width, height) {
    let covered = new Set();
    for (let c of cells) if (c && c.x >= 0 && c.y >= 0 && c.x < width && c.y < height) covered.add(c.y * width + c.x);
    let horizontal = new Map(), vertical = new Map();
    const edge = (map, axis, start) => {
        let row = map.get(axis); if (!row) map.set(axis, row = []); row.push(start);
    };
    for (let key of covered) {
        let x = key % width, y = Math.floor(key / width);
        if (y === 0 || !covered.has(key - width)) edge(horizontal, y, x);
        if (y === height - 1 || !covered.has(key + width)) edge(horizontal, y + 1, x);
        if (x === 0 || !covered.has(key - 1)) edge(vertical, x, y);
        if (x === width - 1 || !covered.has(key + 1)) edge(vertical, x + 1, y);
    }
    let lines = [];
    for (let [map, horizontalAxis] of [[horizontal, true], [vertical, false]]) for (let [axis, row] of map) {
        row.sort((a, b) => a - b);
        let start = row[0], end = start + 1;
        const emit = () => lines.push(horizontalAxis
            ? { x1: start, z1: axis, x2: end, z2: axis, color: 'rgba(120,220,255,0.65)' }
            : { x1: axis, z1: start, x2: axis, z2: end, color: 'rgba(120,220,255,0.65)' });
        for (let i = 1; i < row.length; i++) {
            if (row[i] === end) end++;
            else { emit(); start = row[i]; end = start + 1; }
        }
        emit();
    }
    return lines;
}

let rangeFrameSourcesCache = null;
function getRenderRangeBoundary(selectedBuildings, selected) {
    // Positions and source stats change on simulation ticks. Reuse the team
    // union between ticks; selection mode remains immediately responsive.
    if (renderRangeAllTeam && typeof gameTime === 'number') {
        const c = rangeFrameSourcesCache;
        if (c && c.tick === gameTime && c.grid === grid && c.areas === _areaById
            && c.units === units && c.towers === towers && c.barracks === barracks
            && c.spawners === collectorSpawners && c.mode === renderRangeMode && c.player === localPlayerId) return c.lines;
        const lines = computeRenderRangeBoundary(selectedBuildings, selected);
        rangeFrameSourcesCache = { tick: gameTime, grid, areas: _areaById, units, towers, barracks,
            spawners: collectorSpawners, mode: renderRangeMode, player: localPlayerId, lines };
        return lines;
    }
    rangeFrameSourcesCache = null;
    return computeRenderRangeBoundary(selectedBuildings, selected);
}

function computeRenderRangeBoundary(selectedBuildings, selected) {
    if (renderRangeMode === RENDER_RANGE_NONE) {
        rangeBoundaryCache.context = null;
        return [];
    }
    let sources = new Map();
    const add = (e, unit) => {
        if (!e || e.dead || e.energy <= 0 || (!unit && e.underConstruction)
            || (renderRangeAllTeam && e.owner !== localPlayerId)) return;
        let x = Number.isFinite(e.x) ? e.x : (e.gx + .5) * TILE;
        let y = Number.isFinite(e.y) ? e.y : (e.gy + .5) * TILE;
        let range = getEntityEffectiveVisibilityRangeArea(e);
        // A fractional range includes the source area (distance zero).
        // Floor only after the positive-range check, as gameplay does.
        addVisibilitySourceAreas(sources, x, y, range);
    };
    let includeUnits = [RENDER_RANGE_ALL, RENDER_RANGE_UNITS, RENDER_RANGE_TURRETS_AND_UNITS].includes(renderRangeMode);
    let includeBuildings = renderRangeMode !== RENDER_RANGE_UNITS;
    if (includeUnits) for (let u of renderRangeAllTeam ? units : selected) add(u, true);
    if (includeBuildings) {
        let allBuildings = renderRangeMode === RENDER_RANGE_ALL || renderRangeMode === RENDER_RANGE_BUILDINGS;
        for (let list of renderRangeAllTeam ? (allBuildings ? [towers, barracks, collectorSpawners] : [towers]) : [selectedBuildings]) {
            for (let e of list) if (allBuildings || e instanceof Tower) add(e, false);
        }
        if (renderRangeAllTeam && allBuildings) {
            if (typeof _activeTileEntities !== 'undefined') {
                for (let e of _activeTileEntities) add(e, false);
            } else for (let row of grid) for (let c of row) if (c.item) add(c.item, false);
        }
    }
    let context = `${renderRangeMode}:${renderRangeAllTeam}:${localPlayerId}`;
    let sameWorld = rangeBoundaryCache.grid === grid && rangeBoundaryCache.areas === _areaById
        && rangeBoundaryCache.context === context;
    // Integer simulation ticks avoid floating-point drift at the expiry tick.
    let tickClock = typeof gameTime === 'number' && typeof TICK_RATE === 'number';
    let now = tickClock ? gameTime : Date.now();
    let holdDuration = tickClock ? Math.max(1, Math.floor(TICK_RATE)) : RANGE_AREA_HOLD_MS;
    // Compare numeric maps directly: source order is irrelevant. Avoid sorting
    // and allocating string signatures every render frame for large armies.
    if (sameWorld && rangeBoundaryCache.sources && sources.size === rangeBoundaryCache.sources.size) {
        let unchanged = true;
        for (let [area, radius] of sources) if (rangeBoundaryCache.sources.get(area) !== radius) { unchanged = false; break; }
        if (unchanged && now < rangeBoundaryCache.nextExpiry) return rangeBoundaryCache.lines;
    }
    // Union area ids before visiting tiles; identical unit ranges cost once.
    let activeIds = new Set();
    for (let [area, range] of sources) for (let id of getAreaIdsWithinDistance(area, Math.floor(range))) activeIds.add(id);
    let lastSeen = sameWorld ? rangeBoundaryCache.lastSeen : new Map();
    // A source that just left an area keeps its outline for one second.
    // Refresh the previously active areas only when sources change, so the
    // steady frame path still returns from the cache above.
    if (sameWorld && rangeBoundaryCache.activeCoverage) {
        for (let id of rangeBoundaryCache.activeCoverage) lastSeen.set(id, now);
    }
    for (let id of activeIds) lastSeen.set(id, now);
    let ids = new Set(activeIds), nextExpiry = Infinity;
    for (let [id, seenAt] of lastSeen) {
        if (activeIds.has(id)) continue;
        let expiry = seenAt + holdDuration;
        if (expiry > now) { ids.add(id); nextExpiry = Math.min(nextExpiry, expiry); }
        else lastSeen.delete(id);
    }
    if (sameWorld && rangeBoundaryCache.coverage && ids.size === rangeBoundaryCache.coverage.size) {
        let unchanged = true;
        for (let id of ids) if (!rangeBoundaryCache.coverage.has(id)) { unchanged = false; break; }
        if (unchanged) {
            rangeBoundaryCache.sources = sources;
            rangeBoundaryCache.activeCoverage = activeIds;
            rangeBoundaryCache.lastSeen = lastSeen;
            rangeBoundaryCache.nextExpiry = nextExpiry;
            return rangeBoundaryCache.lines;
        }
    }
    let boundaries = [];
    for (let id of ids) {
        let area = _areaById[id];
        if (!area) continue;
        let edges = rangeAreaEdges.get(area);
        if (!edges) { edges = buildRangeBoundary(area.cells, GRID_W, GRID_H); rangeAreaEdges.set(area, edges); }
        boundaries.push(edges);
    }
    let lines = unionRangePerimeters(boundaries);
    rangeBoundaryCache = { grid, areas: _areaById, context, sources, activeCoverage: activeIds,
        lastSeen, nextExpiry, coverage: ids, lines, path: null };
    return lines;
}

function drawRangeBoundary2D(ctx, lines) {
    lines = clipRangeBoundaryToBounds(lines, Math.floor(camera.x / TILE)-1, Math.floor(camera.y / TILE)-1,
        Math.ceil((camera.x + viewW / camera.zoom) / TILE)+1, Math.ceil((camera.y + viewH / camera.zoom) / TILE)+1);
    if (!lines.length) return;
    let path = rangeCanvasPaths.get(lines);
    if (!path) {
        path = new Path2D();
        for (let l of lines) { path.moveTo(l.x1 * TILE, l.z1 * TILE); path.lineTo(l.x2 * TILE, l.z2 * TILE); }
        rangeCanvasPaths.set(lines, path);
    }
    ctx.save(); ctx.strokeStyle = 'rgba(120,220,255,0.65)';
    ctx.lineWidth = 1.5 / Math.max(.25, camera.zoom); ctx.setLineDash([]);
    ctx.stroke(path); ctx.restore();
}
