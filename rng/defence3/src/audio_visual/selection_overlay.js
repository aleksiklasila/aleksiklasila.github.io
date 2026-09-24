// Presentation-only geometry. No selection or simulation state is changed here.
// A sparse distance field merges nearby footprints without pairwise unit scans,
// and keeps separate clusters (and holes) separate at every selection size.
let selectionContourCache = { input: [], groups: [] };
const selectionCircleDirections = Array.from({ length: 16 }, (_, i) => [Math.cos(i * Math.PI / 8), Math.sin(i * Math.PI / 8)]);
const selectionCanvasPaths = new WeakMap();
const selectionPresentationPositions = new WeakMap();

function stabilizeSelectionPosition(entity, x, y, now) {
    let p = selectionPresentationPositions.get(entity);
    if (!p || Math.abs(x - p.x) + Math.abs(y - p.y) > 128 || now - p.time > 250) {
        p = { x, y, time: now };
        selectionPresentationPositions.set(entity, p);
    } else {
        // Small motion near a cluster threshold should not split/rejoin the
        // outline every frame. Presentation smoothing never moves the unit.
        let blend = 1 - Math.exp(-Math.max(0, now - p.time) / 90);
        p.x += (x - p.x) * blend; p.y += (y - p.y) * blend; p.time = now;
    }
    return p;
}

function buildSelectionContours(footprints) {
    let input = [];
    for (let p of footprints) input.push(p.x, p.y, p.radius, p.box || 0, p.color);
    let previous = selectionContourCache;
    if (input.length === previous.input.length && input.every((v, i) => v === previous.input[i])) return previous.groups;
    // Large moving selections otherwise remarch the whole union at render FPS.
    // Reuse only for subpixel motion relative to the last built geometry (not
    // the last frame), so accumulated movement always triggers a fresh outline.
    let tolerance = footprints.length >= 100 && typeof camera !== 'undefined'
        ? Math.min(2, 0.75 / Math.max(0.25, camera.zoom)) : 0;
    if (tolerance && input.length === previous.input.length && input.every((v, i) =>
        i % 5 < 2 ? Math.abs(v - previous.input[i]) <= tolerance : v === previous.input[i])) return previous.groups;
    const step = 8, stride = 1048576, origin = 524288, iso = 4;
    const keyAt = (x, y) => (y + origin) * stride + x + origin;
    // Isolated objects need no union at all. This also bounds the cost of a
    // thousand widely separated selections without allocating a world-sized grid.
    let bucketSize = 16;
    for (let p of footprints) bucketSize = Math.max(bucketSize, p.radius * 2 + step);
    let buckets = new Map();
    for (let p of footprints) {
        let key = keyAt(Math.floor(p.x / bucketSize), Math.floor(p.y / bucketSize));
        let bucket = buckets.get(key);
        if (!bucket) buckets.set(key, bucket = []);
        bucket.push(p);
    }
    let isolated = new Map(), isolatedShapes = new Map(), clustered = [];
    for (let p of footprints) {
        let bx = Math.floor(p.x / bucketSize), by = Math.floor(p.y / bucketSize), nearby = false;
        for (let y = by - 1; y <= by + 1 && !nearby; y++) for (let x = bx - 1; x <= bx + 1 && !nearby; x++) {
            let bucket = buckets.get(keyAt(x, y));
            if (!bucket) continue;
            for (let q of bucket) {
                if (p === q || p.color !== q.color) continue;
                let dx = p.x - q.x, dy = p.y - q.y, reach = p.radius + q.radius + step;
                if (dx * dx + dy * dy <= reach * reach) { nearby = true; break; }
            }
        }
        if (nearby) { clustered.push(p); continue; }
        let paths = isolated.get(p.color);
        if (!paths) { isolated.set(p.color, paths = []); isolatedShapes.set(p.color, []); }
        isolatedShapes.get(p.color).push({ x: p.x, y: p.y, radius: p.radius, box: p.box });
        let points = [];
        for (let [dx, dy] of selectionCircleDirections) {
            let radius = p.box ? Math.min(p.radius / Math.max(Math.abs(dx), Math.abs(dy)), p.radius + 4) : p.radius;
            points.push([p.x + dx * radius, p.y + dy * radius]);
        }
        paths.push(points);
    }
    const chunkSize = 16, rowSize = chunkSize + 1;
    let fields = new Map();
    for (let p of clustered) {
        if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || !(p.radius > 0)) continue;
        let chunks = fields.get(p.color);
        if (!chunks) fields.set(p.color, chunks = new Map());
        let reach = p.radius + iso;
        let minX = Math.ceil((p.x - reach) / step), maxX = Math.floor((p.x + reach) / step);
        let minY = Math.ceil((p.y - reach) / step), maxY = Math.floor((p.y + reach) / step);
        // Shared border samples are stamped into both adjacent chunks.
        for (let cy = Math.floor((minY - 1) / chunkSize); cy <= Math.floor(maxY / chunkSize); cy++) {
            for (let cx = Math.floor((minX - 1) / chunkSize); cx <= Math.floor(maxX / chunkSize); cx++) {
                let key = keyAt(cx, cy), chunk = chunks.get(key);
                if (!chunk) {
                    chunk = { x: cx * chunkSize, y: cy * chunkSize, values: new Float32Array(rowSize * rowSize), minX: chunkSize, minY: chunkSize, maxX: 0, maxY: 0 };
                    chunks.set(key, chunk);
                }
                let x0 = Math.max(minX, chunk.x), x1 = Math.min(maxX, chunk.x + chunkSize);
                let y0 = Math.max(minY, chunk.y), y1 = Math.min(maxY, chunk.y + chunkSize);
                // Only cells touching stamped samples can cross the isoline.
                // Include the preceding cell so chunk seams remain identical.
                chunk.minX = Math.min(chunk.minX, Math.max(0, x0 - chunk.x - 1));
                chunk.minY = Math.min(chunk.minY, Math.max(0, y0 - chunk.y - 1));
                chunk.maxX = Math.max(chunk.maxX, Math.min(chunkSize - 1, x1 - chunk.x));
                chunk.maxY = Math.max(chunk.maxY, Math.min(chunkSize - 1, y1 - chunk.y));
                for (let y = y0; y <= y1; y++) {
                    let dy = Math.abs(y * step - p.y), row = (y - chunk.y) * rowSize;
                    for (let x = x0; x <= x1; x++) {
                        let dx = Math.abs(x * step - p.x);
                        let qx = p.box ? Math.max(0, dx - p.box) : dx;
                        let qy = p.box ? Math.max(0, dy - p.box) : dy;
                        let distance = Math.sqrt(qx * qx + qy * qy);
                        if (p.box) distance += Math.min(0, Math.max(dx - p.box, dy - p.box)) + p.box;
                        let value = reach - distance, index = row + x - chunk.x;
                        if (value > chunk.values[index]) chunk.values[index] = value;
                    }
                }
            }
        }
    }
    // Edges: top, right, bottom, left. Ambiguous diagonal cells stay separate.
    const cases = [[], [3,0], [0,1], [3,1], [1,2], [3,0,1,2], [0,2], [3,2],
        [2,3], [0,2], [0,1,2,3], [1,2], [1,3], [0,1], [3,0], []];
    let groups = Array.from(isolated, ([color, paths]) => ({ color, paths, shapes: isolatedShapes.get(color) }));
    for (let [color, chunks] of fields) {
        let nodes = new Map(), links = new Map();
        for (let chunk of chunks.values()) for (let cy = chunk.minY; cy <= chunk.maxY; cy++) for (let cx = chunk.minX; cx <= chunk.maxX; cx++) {
            let index = cy * rowSize + cx, samples = chunk.values;
            let v0 = samples[index], v1 = samples[index + 1], v2 = samples[index + rowSize + 1], v3 = samples[index + rowSize];
            if (Math.max(v0, v1, v2, v3) < iso || Math.min(v0, v1, v2, v3) >= iso) continue;
            let values = [v0, v1, v2, v3];
            let key = keyAt(chunk.x + cx, chunk.y + cy);
            let mask = 0;
            for (let i = 0; i < 4; i++) if (values[i] >= iso) mask |= 1 << i;
            let edges = cases[mask];
            if (!edges.length) continue;
            let x = (key % stride - origin) * step, y = (Math.floor(key / stride) - origin) * step;
            let corners = [[x,y], [x+step,y], [x+step,y+step], [x,y+step]];
            let ids = [key * 2, (key + 1) * 2 + 1, (key + stride) * 2, key * 2 + 1];
            for (let e of edges) {
                let id = ids[e];
                if (nodes.has(id)) continue;
                let next = (e + 1) % 4;
                let t = (iso - values[e]) / (values[next] - values[e]);
                nodes.set(id, [corners[e][0] + (corners[next][0] - corners[e][0]) * t,
                    corners[e][1] + (corners[next][1] - corners[e][1]) * t]);
            }
            for (let i = 0; i < edges.length; i += 2) {
                let a = ids[edges[i]], b = ids[edges[i+1]];
                if (!links.has(a)) links.set(a, []);
                if (!links.has(b)) links.set(b, []);
                links.get(a).push(b); links.get(b).push(a);
            }
        }
        let paths = [], visited = new Set();
        for (let start of links.keys()) {
            if (visited.has(start)) continue;
            let path = [], current = start, last = -1;
            while (!visited.has(current)) {
                visited.add(current); path.push(nodes.get(current));
                let next = links.get(current).find(id => id !== last);
                if (next === undefined) break;
                last = current; current = next;
            }
            if (path.length >= 3) {
                // A short, local smoothing pass rounds grid transitions without
                // bridging separate loops or replacing concave shapes with hulls.
                paths.push(path.map((p, i) => {
                    let a = path[(i + path.length - 1) % path.length], b = path[(i + 1) % path.length];
                    return [(a[0] + p[0] * 2 + b[0]) * .25, (a[1] + p[1] * 2 + b[1]) * .25];
                }));
            }
        }
        groups.push({ color, paths });
    }
    selectionContourCache = { input, groups };
    return groups;
}

function getSelectionContours(entities, selected, alpha, ownerColor) {
    let footprints = [];
    let now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    if (showSelectionOutlinesForBuildings()) for (let e of entities) {
        if (!e || (e.energy !== undefined && e.energy <= 0)) continue;
        footprints.push({ x: Number.isFinite(e.x) ? e.x : e.gx * TILE + TILE / 2,
            y: Number.isFinite(e.y) ? e.y : e.gy * TILE + TILE / 2,
            radius: 20, box: 15, color: ownerColor(e.owner) });
    }
    if (showSelectionOutlinesForUnits()) for (let u of selected) {
        if (!u || u.dead) continue;
        let p = stabilizeSelectionPosition(u,
            Number.isFinite(u.prevX) ? u.prevX + (u.x - u.prevX) * alpha : u.x,
            Number.isFinite(u.prevY) ? u.prevY + (u.y - u.prevY) * alpha : u.y, now);
        footprints.push({ x: p.x, y: p.y,
            radius: (Number(u.r) || 8) + 6, color: ownerColor(u.owner) });
    }
    return buildSelectionContours(footprints);
}

function drawSelectionContours2D(ctx, groups) {
    ctx.save();
    ctx.lineWidth = 1.5 / Math.max(0.25, camera.zoom);
    ctx.lineJoin = 'round';
    ctx.setLineDash(selectionOutlineType === OVERLAY_LINE_DOTTED ? [4 / camera.zoom, 3 / camera.zoom] : []);
    for (let group of groups) {
        if (group.shapes) {
            // Isolated objects retain cheap shared sprites in 2D; only merged
            // boundaries need a stroke. Their 3D equivalents share the GPU batch.
            for (let p of group.shapes) {
                if (p.box) {
                    let sprite = _getOverlayRectOutlineSprite(p.radius * 2, p.radius * 2, selectionOutlineType, group.color, 1);
                    ctx.drawImage(sprite.canvas, Math.round(p.x - p.radius - sprite.offsetX), Math.round(p.y - p.radius - sprite.offsetY), sprite.drawW, sprite.drawH);
                } else {
                    let sprite = _getUnitSelectionRingSprite(Math.round(p.radius), selectionOutlineType, group.color);
                    ctx.drawImage(sprite.canvas, Math.round(p.x - sprite.half), Math.round(p.y - sprite.half), sprite.drawW, sprite.drawH);
                }
            }
            continue;
        }
        ctx.strokeStyle = group.color;
        for (let points of group.paths) {
            let path = selectionCanvasPaths.get(points);
            if (!path) {
                path = new Path2D(); path.moveTo(points[0][0], points[0][1]);
                for (let i = 1; i < points.length; i++) path.lineTo(points[i][0], points[i][1]);
                path.closePath(); selectionCanvasPaths.set(points, path);
            }
            ctx.stroke(path);
        }
    }
    ctx.restore();
}

// Reuse the short line texture (including its dash pattern), composing its
// transform directly rather than saving/rotating/scaling the context per line.
function drawRallySegments2D(ctx, segments, color, dashed) {
    if (!segments.length) return;
    let sprite = _getOverlayLineSprite(dashed ? OVERLAY_LINE_DOTTED : OVERLAY_LINE_SOLID, color, 1);
    let m = ctx.getTransform();
    ctx.save(); ctx.imageSmoothingEnabled = false;
    for (let p of segments) {
        let dx = p[2] - p[0], dy = p[3] - p[1], length = Math.hypot(dx, dy);
        if (length < 1) continue;
        let x = Math.round((p[0] + p[2]) * .5), y = Math.round((p[1] + p[3]) * .5);
        let a = dx / sprite.baseLen, b = dy / sprite.baseLen, c = -dy / length, d = dx / length;
        _setDrawImageTrackedTransform(ctx, m.a*a + m.c*b, m.b*a + m.d*b, m.a*c + m.c*d, m.b*c + m.d*d,
            m.a*x + m.c*y + m.e, m.b*x + m.d*y + m.f);
        ctx.drawImage(sprite.canvas, -sprite.halfW, -sprite.halfH, sprite.drawW, sprite.drawH);
    }
    ctx.restore();
    _setDrawImageTrackedTransform(ctx, m.a, m.b, m.c, m.d, m.e, m.f);
}

function drawBuildingRallies2D(ctx, segments, markers) {
    let groups = new Map(), destinations = new Map();
    for (let pos of markers) destinations.set(pos[0] + '|' + pos[1] + '|' + pos[2], pos);
    if (showRallyLinesForBuildings()) {
        for (let segment of segments) {
            let color = segment[4] || '#9aa', group = groups.get(color);
            if (!group) groups.set(color, group = []);
            group.push(segment);
        }
        for (let pos of destinations.values()) {
            let color = pos[2] || '#9aa';
            if (groups.has(color)) groups.get(color).push([pos[0], pos[1], pos[0], pos[1] - 12]);
        }
        for (let [color, group] of groups) drawRallySegments2D(ctx, group, color, rallyLineType === OVERLAY_LINE_DOTTED);
    }
    let showLines = showRallyLinesForBuildings();
    for (let pos of destinations.values()) {
        let sprite = _getOverlayMarkerSprite(showLines ? 'rally_arrow' : 'plus', pos[2] || '#9aa');
        ctx.drawImage(sprite.canvas, Math.round(pos[0] - sprite.offsetX),
            Math.round(pos[1] - (showLines ? 8 : 0) - sprite.offsetY), sprite.drawW, sprite.drawH);
    }
}
