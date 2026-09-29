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
        // Team outlines refresh at most every other tick (10 Hz at 20 TPS),
        // every fourth with very large armies.
        if (c && gameTime >= c.tick && gameTime - c.tick < (units.length > 2000 ? 4 : 2) && c.grid === grid && c.areas === _areaById
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

// Working state of the range outline, per area (typed arrays sized to the
// area count; reset when the world changes):
// best/prevBest: largest floored range of a source in the area (-1: none),
// rem: remaining range while spreading, active/prevActive/shown: coverage
// masks, lastSeen: when an area was last covered (for the hold).
let _rangeWork = null;
function _rangeWorkFor(areaCount) {
    let w = _rangeWork;
    if (w && w.grid === grid && w.areas === _areaById && w.n === areaCount) return w;
    w = _rangeWork = { grid, areas: _areaById, n: areaCount,
        best: new Int16Array(areaCount).fill(-1), prevBest: new Int16Array(areaCount).fill(-1),
        touched: new Int32Array(areaCount), nTouched: 0, prevTouched: new Int32Array(areaCount), nPrev: 0,
        rem: new Int16Array(areaCount), active: new Uint8Array(areaCount), prevActive: new Uint8Array(areaCount),
        shown: new Uint8Array(areaCount), lastSeen: new Float64Array(areaCount).fill(-Infinity),
        buckets: [], tiles: null };
    return w;
}

// Areas one step from an area.
function _rangeAreaNeighbors(id) {
    let list = typeof areaNeighborIds !== 'undefined' ? areaNeighborIds[id] : null;
    return list || getAreaIdsWithinDistance(id, 1);
}

// Outline of the covered tiles: per grid line, the runs of edges with a
// covered tile on exactly one side (outside the map counts as uncovered).
function _rangeBoundaryFromTiles(cov, width, height) {
    let lines = [];
    const push = (horizontal, axis, start, end) => lines.push(horizontal
        ? { x1: start, z1: axis, x2: end, z2: axis, color: 'rgba(120,220,255,0.65)' }
        : { x1: axis, z1: start, x2: axis, z2: end, color: 'rgba(120,220,255,0.65)' });
    for (let y = 0; y <= height; y++) {
        let start = -1, above = (y - 1) * width, below = y * width;
        for (let x = 0; x <= width; x++) {
            let edge = x < width && (y > 0 ? cov[above + x] : 0) !== (y < height ? cov[below + x] : 0);
            if (edge) { if (start < 0) start = x; }
            else if (start >= 0) { push(true, y, start, x); start = -1; }
        }
    }
    for (let x = 0; x <= width; x++) {
        let start = -1;
        for (let y = 0; y <= height; y++) {
            let edge = y < height && (x > 0 ? cov[y * width + x - 1] : 0) !== (x < width ? cov[y * width + x] : 0);
            if (edge) { if (start < 0) start = y; }
            else if (start >= 0) { push(false, x, start, y); start = -1; }
        }
    }
    return lines;
}

// The outline of every area within range of a source. Sources reduce to
// their areas' largest floored range, which then spreads over the area graph
// in one pass (a bucket queue by remaining range: O(areas + borders), however
// many units), instead of uniting each source's own list of areas. The
// outline is traced from a tile mask of the covered areas.
function computeRenderRangeBoundary(selectedBuildings, selected) {
    if (renderRangeMode === RENDER_RANGE_NONE) {
        rangeBoundaryCache.context = null;
        return [];
    }
    let areaCount = _areaById.length;
    let context = `${renderRangeMode}:${renderRangeAllTeam}:${localPlayerId}`;
    let sameWorld = rangeBoundaryCache.grid === grid && rangeBoundaryCache.areas === _areaById
        && rangeBoundaryCache.context === context && !!_rangeWork && _rangeWork.grid === grid
        && _rangeWork.areas === _areaById && _rangeWork.n === areaCount;
    let w = _rangeWorkFor(areaCount);
    if (!sameWorld) {
        w.best.fill(-1); w.prevBest.fill(-1); w.nTouched = 0; w.nPrev = 0;
        w.prevActive.fill(0); w.shown.fill(0); w.lastSeen.fill(-Infinity);
    }
    // Clear the older source table and fill it; the last one is kept to compare.
    for (let i = 0; i < w.nPrev; i++) w.prevBest[w.prevTouched[i]] = -1;
    let t16 = w.prevBest; w.prevBest = w.best; w.best = t16;
    let t32 = w.prevTouched; w.prevTouched = w.touched; w.touched = t32;
    let nPrev = w.nPrev = sameWorld ? w.nTouched : -1;
    if (nPrev < 0) w.nPrev = w.nTouched;
    w.nTouched = 0;
    let best = w.best, touched = w.touched, maxRange = 0;
    const add = (e, unit) => {
        if (!e || e.dead || e.energy <= 0 || (!unit && e.underConstruction)
            || (renderRangeAllTeam && e.owner !== localPlayerId)) return;
        let range = getEntityEffectiveVisibilityRangeArea(e);
        // A fractional range includes the source area (distance zero).
        // Floor only after the positive-range check, as gameplay does.
        if (!(range > 0)) return;
        let wx = Number.isFinite(e.x) ? e.x : (e.gx + .5) * TILE;
        let wy = Number.isFinite(e.y) ? e.y : (e.gy + .5) * TILE;
        if (!Number.isFinite(wx) || !Number.isFinite(wy)) return;
        let r = Math.min(32767, Math.floor(range));
        // Every area under the source's +-0.3 tile window, as gameplay.
        let x = wx / TILE, y = wy / TILE;
        let minX = Math.floor(x - .3), maxX = Math.floor(x + .3), minY = Math.floor(y - .3), maxY = Math.floor(y + .3);
        for (let gy = minY; gy <= maxY; gy++) for (let gx = minX; gx <= maxX; gx++) {
            let area = getAreaIdAtTile(gx, gy);
            if (!(area >= 0 && area < areaCount) || best[area] >= r) continue;
            if (best[area] < 0) touched[w.nTouched++] = area;
            best[area] = r;
            if (r > maxRange) maxRange = r;
        }
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
                // Only cell items can be owned sources here (mines never are).
                let items = typeof _getVisibilityFloorItemCandidates === 'function' ? _getVisibilityFloorItemCandidates() : _activeTileEntities;
                for (let e of items) add(e, false);
            } else for (let row of grid) for (let c of row) if (c.item) add(c.item, false);
        }
    }
    // Integer simulation ticks avoid floating-point drift at the expiry tick.
    let tickClock = typeof gameTime === 'number' && typeof TICK_RATE === 'number';
    let now = tickClock ? gameTime : Date.now();
    let holdDuration = tickClock ? Math.max(1, Math.floor(TICK_RATE)) : RANGE_AREA_HOLD_MS;
    // Unchanged sources (in any order) keep the outline until a hold expires.
    if (sameWorld && nPrev === w.nTouched) {
        let unchanged = true;
        for (let i = 0; i < w.nTouched; i++) if (w.prevBest[touched[i]] !== best[touched[i]]) { unchanged = false; break; }
        if (unchanged && now < rangeBoundaryCache.nextExpiry) return rangeBoundaryCache.lines;
    }
    // Spread the ranges: rem[a] is the most range left on reaching area a.
    let rem = w.rem, active = w.active, buckets = w.buckets;
    rem.fill(-1); active.fill(0);
    for (let d = 0; d <= maxRange; d++) { if (buckets[d]) buckets[d].length = 0; else buckets[d] = []; }
    for (let i = 0; i < w.nTouched; i++) { let a = touched[i]; rem[a] = best[a]; buckets[best[a]].push(a); }
    for (let d = maxRange; d >= 0; d--) {
        let bucket = buckets[d];
        for (let k = 0; k < bucket.length; k++) {
            let a = bucket[k];
            if (rem[a] !== d || active[a]) continue;
            active[a] = 1;
            if (d === 0) continue;
            for (let n of _rangeAreaNeighbors(a)) {
                if (n >= 0 && n < areaCount && rem[n] < d - 1) { rem[n] = d - 1; buckets[d - 1].push(n); }
            }
        }
    }
    // A source that just left an area keeps its outline for one second.
    // The previously active areas renew their hold only when sources change,
    // so the steady frame path still returns from the cache above.
    let lastSeen = w.lastSeen, prevActive = w.prevActive, shown = w.shown, nextExpiry = Infinity, changed = !sameWorld;
    for (let a = 0; a < areaCount; a++) {
        if (active[a] || prevActive[a]) lastSeen[a] = now;
        let on = 0;
        if (active[a]) on = 1;
        else if (lastSeen[a] + holdDuration > now) {
            on = 1;
            if (lastSeen[a] + holdDuration < nextExpiry) nextExpiry = lastSeen[a] + holdDuration;
        }
        if (on !== shown[a]) { shown[a] = on; changed = true; }
    }
    w.active = prevActive; w.prevActive = active;
    if (!changed) {
        rangeBoundaryCache.nextExpiry = nextExpiry;
        return rangeBoundaryCache.lines;
    }
    let width = GRID_W, height = GRID_H;
    if (!w.tiles || w.tiles.length !== width * height) w.tiles = new Uint8Array(width * height);
    let cov = w.tiles, hasGrid = typeof areaIdGrid !== 'undefined' && areaIdGrid && areaIdGrid.length === height;
    for (let y = 0; y < height; y++) {
        let row = hasGrid ? areaIdGrid[y] : null, o = y * width;
        for (let x = 0; x < width; x++) {
            let id = row ? row[x] : getAreaIdAtTile(x, y);
            cov[o + x] = id >= 0 && id < areaCount && shown[id] && _areaById[id] ? 1 : 0;
        }
    }
    let lines = _rangeBoundaryFromTiles(cov, width, height);
    rangeBoundaryCache = { grid, areas: _areaById, context, nextExpiry, lines, path: null };
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
