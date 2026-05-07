let canvas, ctx, bgCanvas, bgCtx, overlayCanvas, overlayCtx, minimapCanvas, minimapCtx;
let renderDimensionMode = '2d';
let renderer3dInstance = null;
let renderer3dHost = null;
let renderer3dBackgroundVersion = 0;
let renderer3dRotateDrag = null;
const renderer3dTopTextureCache = new Map();
const renderer3dOverlapFadeState = new Map();
const RENDERER3D_OVERLAP_FADE_DURATION_MS = 500;
const DRAW_Z_BACKGROUND = 500;
const DRAW_Z_STRUCTURES = 400;
const DRAW_Z_UNITS = 300;
const DRAW_Z_PARTICLES = 200;
const DRAW_Z_OVERLAY = 100;
const renderer3dLayerConfigs = [
    { z: DRAW_Z_BACKGROUND, key: 'background', slices: 1, thickness: 0.02, opacity: 1 },
    { z: DRAW_Z_STRUCTURES, key: 'structures', slices: 14, thickness: 0.05, opacity: 1 },
    { z: DRAW_Z_UNITS, key: 'units', slices: 10, thickness: 0.032, opacity: 1 },
    { z: DRAW_Z_PARTICLES, key: 'particles', slices: 6, thickness: 0.016, opacity: 0.95 },
    { z: DRAW_Z_OVERLAY, key: 'overlay', slices: 4, thickness: 0.012, opacity: 0.9 }
];
let renderer3dLayerCanvases = new Map();
let renderer3dLayerContexts = new Map();
let renderer3dLayerStats = new Map();
let visibilityGridByPlayerCache = new Map();
let visibilityCacheTick = -1;
let _backgroundTickInterval = null;
let _hiddenLastTickTime = 0;
let _hiddenTickAccumulator = 0;
let _buildMenuRefreshCounter = 0;
let _minimapRefreshCounter = 10;
let _backgroundCacheRefreshCounter = 20;
let _fpsFrameCount = 0, _fpsLastTime = performance.now(), _fpsDisplay = 0;
let _tpsTickCount = 0, _tpsLastTime = performance.now(), _tpsDisplay = 0;

function get3DRenderOwnerColor(owner) {
    if (Number.isFinite(owner) && owner >= 0 && owner < PLAYER_COLORS.length) return PLAYER_COLORS[owner];
    return '#c8ced8';
}

const RENDERER3D_TOP_TEXTURE_SIZE = 96;

function quantize3DStatusRatio(value, steps = 10) {
    if (!Number.isFinite(value)) return 0;
    return Math.max(0, Math.min(steps, Math.round(value * steps)));
}

function draw3DTopTextureBar(g, x, y, width, height, pct, bgColor, fillColor) {
    if (!g || width <= 0 || height <= 0) return;
    let clamped = Math.max(0, Math.min(1, Number(pct) || 0));
    g.fillStyle = bgColor || '#333';
    g.fillRect(x, y, width, height);
    g.fillStyle = fillColor || '#0f0';
    g.fillRect(x, y, Math.max(1, Math.round(width * clamped)), height);
}

function draw3DTopTextureStatus(g, status) {
    if (!g || !status) return;
    let size = g.canvas && g.canvas.width ? g.canvas.width : RENDERER3D_TOP_TEXTURE_SIZE;
    let bars = Array.isArray(status.bars) ? status.bars.slice(0, 3) : [];
    let inset = Math.max(6, Math.round(size * 0.08));
    let barWidth = size - inset * 2;
    let barHeight = Math.max(4, Math.round(size * 0.06));
    let barGap = Math.max(2, Math.round(size * 0.025));
    let currentY = size - inset - barHeight;
    for (let i = bars.length - 1; i >= 0; i--) {
        let bar = bars[i];
        draw3DTopTextureBar(g, inset, currentY, barWidth, barHeight, bar.pct, bar.bgColor, bar.fillColor);
        currentY -= barHeight + barGap;
    }
    if (status.label) {
        g.textAlign = 'center';
        g.textBaseline = 'top';
        g.lineJoin = 'round';
        g.lineWidth = Math.max(2, Math.round(size * 0.035));
        g.strokeStyle = status.strokeColor || 'rgba(0,0,0,0.95)';
        g.fillStyle = status.color || '#ddd';
        g.font = `700 ${Math.max(10, Math.round(size * 0.18))}px Segoe UI, Arial, sans-serif`;
        g.strokeText(String(status.label), size * 0.5, inset - 1);
        g.fillText(String(status.label), size * 0.5, inset - 1);
    }
}

function build3DStatusTextureOptions(label, bars) {
    let normalizedBars = [];
    let keyParts = [];
    for (let bar of bars || []) {
        if (!bar || !Number.isFinite(bar.pct) || bar.pct <= 0) continue;
        let pct = Math.max(0, Math.min(1, Number(bar.pct) || 0));
        let bucket = quantize3DStatusRatio(pct, 12);
        let entry = {
            pct,
            bgColor: bar.bgColor || '#333',
            fillColor: bar.fillColor || '#0f0'
        };
        normalizedBars.push(entry);
        keyParts.push(`${entry.bgColor}:${entry.fillColor}:${bucket}`);
    }
    let normalizedLabel = label ? String(label) : '';
    if (normalizedLabel) keyParts.unshift(`label:${normalizedLabel}`);
    return {
        label: normalizedLabel,
        bars: normalizedBars,
        keySuffix: keyParts.join('|')
    };
}

function get3DBuildingTextureStatus(entity, extraBars = []) {
    let bars = [];
    let maxEnergy = Number(entity && entity.maxEnergy) || 0;
    let energy = Math.max(0, Math.min(Number(entity && entity.energy) || 0, maxEnergy));
    let isProgress = !!(entity && (entity.underConstruction || entity.isUpgrading));
    let manualStacks = Number(entity && entity.manualStacks);
    let stackedStacks = Number(entity && entity.stacks);
    let hasStackQueue = (Number.isFinite(manualStacks) && Number.isFinite(stackedStacks))
        ? (manualStacks > stackedStacks)
        : (!!entity && getThingManualStacks(entity) > getThingStackedStacks(entity));
    if (hasStackQueue) {
        bars.push({ pct: getThingStackingProgressRatio(entity), bgColor: '#11291c', fillColor: '#2fd27f' });
    }
    if (maxEnergy > 0 && (isProgress || hasStackQueue || energy < maxEnergy)) {
        bars.push({ pct: maxEnergy > 0 ? energy / maxEnergy : 0, bgColor: isProgress ? '#333' : '#600', fillColor: isProgress ? '#fa0' : '#0f0' });
    }
    for (let bar of extraBars) bars.push(bar);
    return build3DStatusTextureOptions(entity && entity.textCanvas && shouldShowBuildingLevels() ? getLevelLabelText(entity) : '', bars);
}

function get3DUnitTextureStatus(unit) {
    let bars = [];
    if (unit && unit.energy < unit.maxEnergy) {
        bars.push({ pct: Math.max(0, unit.energy / Math.max(1, unit.maxEnergy)), bgColor: '#600', fillColor: '#0f0' });
    }
    return build3DStatusTextureOptions(shouldShowUnitLevels() ? getUnitLevelLabelText(unit) : '', bars);
}

function get3DTopTextureCanvas(key, drawFn) {
    let cached = renderer3dTopTextureCache.get(key);
    if (cached) return cached;
    let canvas = document.createElement('canvas');
    canvas.width = RENDERER3D_TOP_TEXTURE_SIZE;
    canvas.height = RENDERER3D_TOP_TEXTURE_SIZE;
    let g = canvas.getContext('2d');
    if (!g) return null;
    g.clearRect(0, 0, canvas.width, canvas.height);
    g.imageSmoothingEnabled = false;
    drawFn(g, canvas);
    renderer3dTopTextureCache.set(key, canvas);
    return canvas;
}

function draw3DSpriteIntoTopTexture(g, sprite, inset = 8) {
    if (!g || !sprite) return;
    let canvasSize = g.canvas && g.canvas.width ? g.canvas.width : RENDERER3D_TOP_TEXTURE_SIZE;
    let size = Math.max(8, canvasSize - inset * 2);
    g.drawImage(sprite, inset, inset, size, size);
}

function get3DUnitTopTexture(unitType, owner, statusOptions = null) {
    let stats = BASE_UNIT_STATS[unitType] || BASE_UNIT_STATS.norm;
    let color = stats.color || '#fff';
    let vis = stats.vis || 'circle';
    let ownerColor = get3DRenderOwnerColor(owner);
    let key = `unit:${unitType}:${owner}:${statusOptions && statusOptions.keySuffix ? statusOptions.keySuffix : ''}`;
    return get3DTopTextureCanvas(key, (g) => {
        let size = g.canvas.width;
        let inset = Math.round(size * 0.12);
        let innerSize = size - inset * 2;
        g.fillStyle = 'rgba(0,0,0,0.45)';
        g.fillRect(inset, inset, innerSize, innerSize);
        g.strokeStyle = ownerColor;
        g.lineWidth = 3;
        g.strokeRect(inset + 0.5, inset + 0.5, innerSize - 1, innerSize - 1);
        g.strokeStyle = '#111';
        g.lineWidth = 2;
        g.fillStyle = color;
        if (vis === 'triangle') {
            g.beginPath();
            g.moveTo(size * 0.5, size * 0.28);
            g.lineTo(size * 0.28, size * 0.7);
            g.lineTo(size * 0.72, size * 0.7);
            g.closePath();
            g.fill();
            g.stroke();
        } else if (vis === 'star') {
            if (unitType === 'collector' || unitType === 'astar_collector') {
                g.font = `700 ${Math.round(size * 0.34)}px Arial`;
                g.textAlign = 'center';
                g.textBaseline = 'middle';
                g.fillStyle = unitType === 'collector' ? '#ffd34d' : '#f4f4f4';
                g.fillText(unitType === 'collector' ? '⭐' : '★', size * 0.5, size * 0.52);
            } else {
                drawCachedUnitStar(g, size * 0.5, size * 0.5, Math.round(size * 0.18), color, '#111', 2);
            }
        } else if (vis === 'triangle_down') {
            g.beginPath();
            g.moveTo(size * 0.5, size * 0.72);
            g.lineTo(size * 0.28, size * 0.34);
            g.lineTo(size * 0.72, size * 0.34);
            g.closePath();
            g.fill();
            g.stroke();
        } else if (vis === 'mole') {
            g.beginPath();
            g.ellipse(size * 0.5, size * 0.5, size * 0.18, size * 0.24, 0, 0, Math.PI * 2);
            g.fill();
            g.stroke();
        } else if (vis === 'rect') {
            g.fillRect(size * 0.28, size * 0.34, size * 0.44, size * 0.3);
            g.strokeRect(size * 0.28, size * 0.34, size * 0.44, size * 0.3);
        } else if (vis === 'king') {
            g.beginPath();
            g.moveTo(size * 0.28, size * 0.66);
            g.lineTo(size * 0.28, size * 0.4);
            g.lineTo(size * 0.39, size * 0.48);
            g.lineTo(size * 0.5, size * 0.28);
            g.lineTo(size * 0.61, size * 0.48);
            g.lineTo(size * 0.72, size * 0.4);
            g.lineTo(size * 0.72, size * 0.66);
            g.closePath();
            g.fill();
            g.stroke();
        } else {
            g.beginPath();
            g.arc(size * 0.5, size * 0.5, size * 0.18, 0, Math.PI * 2);
            g.fill();
            g.stroke();
        }
        g.fillStyle = ownerColor;
        g.beginPath();
        g.arc(size * 0.5, size * 0.14, Math.max(4, Math.round(size * 0.05)), 0, Math.PI * 2);
        g.fill();
        draw3DTopTextureStatus(g, statusOptions);
    });
}

function get3DBuildingTopTexture(kind, owner, options = {}) {
    let key = `${kind}:${owner}:${options.subtype || ''}:${options.active ? 1 : 0}:${options.angleKey || ''}:${options.statusKey || ''}`;
    return get3DTopTextureCanvas(key, (g) => {
        let ownerColor = get3DRenderOwnerColor(owner);
        let size = g.canvas.width;
        let inset = Math.round(size * 0.12);
        let innerSize = size - inset * 2;
        g.fillStyle = 'rgba(0,0,0,0.45)';
        g.fillRect(inset, inset, innerSize, innerSize);
        g.strokeStyle = ownerColor;
        g.lineWidth = 3;
        g.strokeRect(inset + 0.5, inset + 0.5, innerSize - 1, innerSize - 1);
        if (kind === 'tower') {
            let sprite = _getTowerIconSprite(options.color || '#999', options.angle || 0, options.subtype || '', !!options.active);
            draw3DSpriteIntoTopTexture(g, sprite, inset);
            draw3DTopTextureStatus(g, options.status);
            return;
        }
        g.textAlign = 'center';
        g.textBaseline = 'middle';
        if (kind === 'barrack') {
            g.fillStyle = '#664';
            g.beginPath();
            g.moveTo(size * 0.22, size * 0.38); g.lineTo(size * 0.78, size * 0.38); g.lineTo(size * 0.5, size * 0.16); g.closePath(); g.fill();
            g.fillStyle = options.color || '#fff';
            g.beginPath(); g.arc(size * 0.5, size * 0.62, size * 0.12, 0, Math.PI * 2); g.fill();
        } else if (kind === 'spawner_energy') {
            g.fillStyle = '#432'; g.fillRect(size * 0.22, size * 0.22, size * 0.56, size * 0.56);
            g.fillStyle = '#f3d55b'; g.fillRect(size * 0.31, size * 0.38, size * 0.38, size * 0.22);
            g.strokeStyle = '#fff'; g.lineWidth = 2; g.strokeRect(size * 0.31, size * 0.38, size * 0.38, size * 0.22);
            g.fillStyle = '#111'; g.font = `700 ${Math.round(size * 0.22)}px Arial`; g.fillText('⚡', size * 0.5, size * 0.52);
        } else if (kind === 'spawner_astar') {
            g.fillStyle = '#555'; g.fillRect(size * 0.22, size * 0.22, size * 0.56, size * 0.56);
            g.fillStyle = '#f0f0f0'; g.font = `700 ${Math.round(size * 0.3)}px Arial`; g.fillText('★', size * 0.5, size * 0.52);
        } else if (kind === 'spawner_salvager') {
            g.fillStyle = '#543'; g.fillRect(size * 0.22, size * 0.22, size * 0.56, size * 0.56);
            g.fillStyle = '#8d8';
            g.beginPath();
            for (let i = 0; i < 3; i++) {
                let a = (i * 2 * Math.PI) / 3 - Math.PI / 2;
                let px = size * 0.5 + Math.cos(a) * size * 0.16;
                let py = size * 0.5 + Math.sin(a) * size * 0.16;
                if (i === 0) g.moveTo(px, py); else g.lineTo(px, py);
            }
            g.closePath(); g.fill();
        } else if (kind === 'spawner_builder') {
            g.fillStyle = '#354'; g.fillRect(size * 0.22, size * 0.22, size * 0.56, size * 0.56);
            g.fillStyle = '#8b5'; g.fillRect(size * 0.31, size * 0.38, size * 0.38, size * 0.22);
            g.strokeStyle = '#fff'; g.lineWidth = 2; g.strokeRect(size * 0.31, size * 0.38, size * 0.38, size * 0.22);
        } else if (kind === 'spawner_healer') {
            g.fillStyle = '#355'; g.fillRect(size * 0.22, size * 0.22, size * 0.56, size * 0.56);
            g.fillStyle = '#fff'; g.fillRect(size * 0.31, size * 0.38, size * 0.38, size * 0.22);
            g.strokeStyle = '#ddd'; g.lineWidth = 2; g.strokeRect(size * 0.31, size * 0.38, size * 0.38, size * 0.22);
        } else if (kind === 'spawner_research') {
            g.fillStyle = '#446'; g.fillRect(size * 0.22, size * 0.22, size * 0.56, size * 0.56);
            g.fillStyle = '#aef'; g.font = `700 ${Math.round(size * 0.24)}px Arial`; g.fillText('R', size * 0.5, size * 0.52);
        }
        draw3DTopTextureStatus(g, options.status);
    });
}

function get3DTopTextureForFloorItem(item, statusOptions = null) {
    if (!item) return null;
    let sprite = _getFloorItemSprite(item);
    let key = `item:${item.type}:${_getFloorItemEnergyBucket(item)}:${statusOptions && statusOptions.keySuffix ? statusOptions.keySuffix : ''}`;
    return get3DTopTextureCanvas(key, (g) => {
        draw3DSpriteIntoTopTexture(g, sprite, Math.round(g.canvas.width * 0.12));
        draw3DTopTextureStatus(g, statusOptions);
    });
}

function build3DOverlayData(bounds, alpha) {
    let overlays = { lines: [], rings: [], rects: [], markers: [], bars: [], texts: [] };
    let activeSelectedEntities = getActiveEntities();
    let activeSelectedUnits = getActiveUnits();
    let bakeHudIntoTopTexture = true;
    let pushLine = (x1, y1, x2, y2, color, dashed = false) => overlays.lines.push({ x1: x1 / TILE, z1: y1 / TILE, x2: x2 / TILE, z2: y2 / TILE, color, dashed });
    let pushMarker = (x, y, kind, color) => overlays.markers.push({ x: x / TILE, z: y / TILE, kind, color });
    let pushRing = (x, y, radiusPx, strokeColor, fillColor = null, dashed = false) => overlays.rings.push({ x: x / TILE, z: y / TILE, radius: radiusPx / TILE, strokeColor, fillColor: null, dashed });
    let pushRect = (x, y, halfWpx, halfHpx, color, dashed = false) => overlays.rects.push({ x: x / TILE, z: y / TILE, halfWidth: halfWpx / TILE, halfHeight: halfHpx / TILE, color, dashed });
    let pushBar = (x, y, lift, offsetY, width, height, pct, bgColor, fillColor) => {
        if (bakeHudIntoTopTexture) return;
        overlays.bars.push({ x: x / TILE, z: y / TILE, lift, offsetY, width, height, pct, bgColor, fillColor });
    };
    let pushText = (x, y, lift, offsetY, text, color = '#ddd', strokeColor = 'rgba(0,0,0,0.95)', font = '700 11px Segoe UI, Arial, sans-serif') => {
        if (bakeHudIntoTopTexture) return;
        if (!text) return;
        overlays.texts.push({ x: x / TILE, z: y / TILE, lift, offsetY, text, color, strokeColor, font });
    };
    let pushBuildingStatus = (entity, worldX, worldY, energyBarOffsetY, energyBarWidth, energyBarHeight, levelLift, levelOffsetY, extraBars = []) => {
        let maxEnergy = Number(entity && entity.maxEnergy) || 0;
        let energy = Math.max(0, Math.min(Number(entity && entity.energy) || 0, maxEnergy));
        let isProgress = !!(entity && (entity.underConstruction || entity.isUpgrading));
        let manualStacks = Number(entity && entity.manualStacks);
        let stackedStacks = Number(entity && entity.stacks);
        let hasStackQueue = (Number.isFinite(manualStacks) && Number.isFinite(stackedStacks))
            ? (manualStacks > stackedStacks)
            : (!!entity && getThingManualStacks(entity) > getThingStackedStacks(entity));
        if (hasStackQueue) {
            pushBar(worldX, worldY, 0.72, energyBarOffsetY - energyBarHeight - 1, energyBarWidth, energyBarHeight, getThingStackingProgressRatio(entity), '#11291c', '#2fd27f');
        }
        if (maxEnergy > 0 && (isProgress || hasStackQueue || energy < maxEnergy)) {
            pushBar(worldX, worldY, 0.72, energyBarOffsetY, energyBarWidth, energyBarHeight, maxEnergy > 0 ? energy / maxEnergy : 0, isProgress ? '#333' : '#600', isProgress ? '#fa0' : '#0f0');
        }
        for (let bar of extraBars) {
            if (!bar || !Number.isFinite(bar.pct) || bar.pct <= 0) continue;
            pushBar(worldX, worldY, 0.72, bar.offsetY, bar.width, bar.height, bar.pct, bar.bgColor, bar.fillColor);
        }
        if (entity && entity.textCanvas && shouldShowBuildingLevels()) {
            pushText(worldX, worldY, levelLift, levelOffsetY, getLevelLabelText(entity));
        }
    };

    for (let ent of activeSelectedEntities) {
        if (!ent || (ent.energy !== undefined && ent.energy <= 0)) continue;
        let ex = ent.x || (ent.gx * TILE + TILE * 0.5);
        let ey = ent.y || (ent.gy * TILE + TILE * 0.5);
        if (showSelectionOutlinesForBuildings()) pushRect(ex, ey, 18, 18, '#9aa', selectionOutlineType === OVERLAY_LINE_DOTTED);

        if (['barrack', 'spawner', 'astar_spawner', 'salvager', 'builder_spawner', 'healer_spawner', 'research'].includes(ent.type)) {
            let rallyTarget = getSpawnerRallyTargetWorld(ent);
            if (rallyTarget) {
                if (showRallyLinesForBuildings()) pushLine(ex, ey, rallyTarget.x, rallyTarget.y, '#9aa', rallyLineType === OVERLAY_LINE_DOTTED);
                pushMarker(rallyTarget.x, rallyTarget.y, showRallyLinesForBuildings() ? 'arrow' : 'plus', '#9aa');
            }
        }

        if (ent instanceof Tower && ent.owner === localPlayerId) {
            let marker = resolveTowerPreferredTargetVisual(ent);
            if (marker && Number.isFinite(marker.x) && Number.isFinite(marker.y)) {
                pushLine(ex, ey, marker.x, marker.y, marker.locked ? '#9cf' : 'rgba(153,204,255,0.55)', false);
                pushMarker(marker.x, marker.y, 'dot', '#9cf');
            }
        }

        if ((renderRangeMode === RENDER_RANGE_TURRETS || renderRangeMode === RENDER_RANGE_TURRETS_AND_UNITS) && ent instanceof Tower) {
            let visTiles = getEntityVisibilityRangeTiles(ent);
            let rr = Number.isFinite(visTiles) ? visTiles * TILE : 0;
            if (rr > 0) pushRing(ex, ey, rr, 'rgba(120,255,120,0.55)', null);
        }
    }

    if (showSelectionOutlinesForUnits()) {
        for (let u of activeSelectedUnits) {
            if (!u || u.dead) continue;
            let ux = Number.isFinite(u.prevX) ? (u.prevX + (u.x - u.prevX) * alpha) : u.x;
            let uy = Number.isFinite(u.prevY) ? (u.prevY + (u.y - u.prevY) * alpha) : u.y;
            pushRing(ux, uy, (Number(u.r) || 8) + 4, '#9aa', null, selectionOutlineType === OVERLAY_LINE_DOTTED);
        }
    }

    if (renderRangeMode === RENDER_RANGE_TURRETS_AND_UNITS) {
        for (let u of activeSelectedUnits) {
            if (!u || u.dead) continue;
            let rr = getUnitRenderActionRangePx(u);
            if (rr <= 0) continue;
            let ux = Number.isFinite(u.prevX) ? (u.prevX + (u.x - u.prevX) * alpha) : u.x;
            let uy = Number.isFinite(u.prevY) ? (u.prevY + (u.y - u.prevY) * alpha) : u.y;
            pushRing(ux, uy, rr, 'rgba(120,220,255,0.5)', null);
        }
    }

    for (let u of activeSelectedUnits) {
        if (!u || u.dead) continue;
        let ux = Number.isFinite(u.prevX) ? (u.prevX + (u.x - u.prevX) * alpha) : u.x;
        let uy = Number.isFinite(u.prevY) ? (u.prevY + (u.y - u.prevY) * alpha) : u.y;
        if (u.commandState >= CMD_MOVING && u.commandState <= CMD_ATTACK_MOVING) {
            let destX = null, destY = null;
            if (u.path && u.path.length > 0) {
                let lastPt = u.path[u.path.length - 1];
                destX = lastPt.x * TILE + 16;
                destY = lastPt.y * TILE + 16;
            } else if (u._pendingPathTarget) {
                destX = u._pendingPathTarget.gx * TILE + 16;
                destY = u._pendingPathTarget.gy * TILE + 16;
            }
            if (destX !== null && destY !== null) {
                let color = u.commandState === CMD_ATTACK_MOVING ? 'rgba(255,100,100,0.5)' : 'rgba(100,255,100,0.5)';
                pushLine(ux, uy, destX, destY, color, rallyLineType === OVERLAY_LINE_DOTTED);
                pushMarker(destX, destY, 'plus', u.commandState === CMD_ATTACK_MOVING ? '#f66' : '#4f4');
            }
        }
        if (u.targetUnit && !u.targetUnit.dead && u.commandState === CMD_ATTACKING) {
            pushLine(ux, uy, u.targetUnit.x, u.targetUnit.y, 'rgba(255,0,0,0.6)');
        } else if (u.targetBuilding && u.targetBuilding.energy > 0 && u.commandState === CMD_ATTACKING) {
            pushLine(ux, uy, u.targetBuilding.x, u.targetBuilding.y, 'rgba(255,0,0,0.6)');
        }
    }

    for (let y = bounds.minGy; y <= bounds.maxGy; y++) {
        let gridRow = grid[y];
        let visRow = visibilityGrid[y];
        if (!gridRow) continue;
        for (let x = bounds.minGx; x <= bounds.maxGx; x++) {
            let cell = gridRow[x];
            if (!cell || !cell.item) continue;
            if (!fullVisibility && (!visRow || visRow[x] === 0)) continue;
            pushBuildingStatus(cell.item, x * TILE + TILE * 0.5, y * TILE + TILE * 0.5, 6, TILE - 8, 3, 0.3, -12);
        }
    }

    for (let t of towers) {
        if (t.gx < bounds.minGx - 1 || t.gx > bounds.maxGx + 1 || t.gy < bounds.minGy - 1 || t.gy > bounds.maxGy + 1) continue;
        if (!fullVisibility && (!visibilityGrid[t.gy] || visibilityGrid[t.gy][t.gx] === 0)) continue;
        let isUpg = !!(t.underConstruction || t.isUpgrading);
        pushBuildingStatus(t, t.x, t.y, isUpg ? 10 : 13, isUpg ? 20 : 24, 3, 0.92, -18);
    }

    for (let b of barracks) {
        if (b.gx < bounds.minGx || b.gx > bounds.maxGx || b.gy < bounds.minGy || b.gy > bounds.maxGy) continue;
        if (!fullVisibility && (!visibilityGrid[b.gy] || visibilityGrid[b.gy][b.gx] === 0)) continue;
        let extraBars = [];
        if (!b.underConstruction && b.spawnQueue && b.spawnQueue.length > 0 && b.spawnCooldown > 0) {
            extraBars.push({ offsetY: 8, width: 24, height: 3, pct: b.spawnTimer / b.spawnCooldown, bgColor: '#333', fillColor: (b.spawnTimer / b.spawnCooldown) > 0.8 ? '#4f4' : '#fa0' });
        }
        pushBuildingStatus(b, b.x, b.y, b.underConstruction ? 10 : 13, 24, 3, 0.92, -18, extraBars);
    }

    for (let s of collectorSpawners) {
        if (s.gx < bounds.minGx || s.gx > bounds.maxGx || s.gy < bounds.minGy || s.gy > bounds.maxGy) continue;
        if (!fullVisibility && (!visibilityGrid[s.gy] || visibilityGrid[s.gy][s.gx] === 0)) continue;
        let extraBars = [];
        if (!s.underConstruction && s.spawnQueue && s.spawnQueue.length > 0 && s.spawnCooldown > 0) {
            extraBars.push({ offsetY: 5, width: 24, height: 3, pct: s.spawnTimer / s.spawnCooldown, bgColor: '#333', fillColor: (s.spawnTimer / s.spawnCooldown) > 0.8 ? '#4f4' : '#fa0' });
        }
        if (!s.underConstruction && s.type === 'research' && s.researchTask && s.researchTask.workRequired > 0) {
            let pct = Math.max(0, Math.min(1, (s.researchTask.workDone || 0) / s.researchTask.workRequired));
            extraBars.push({ offsetY: 1, width: 24, height: 3, pct, bgColor: '#333', fillColor: pct > 0.8 ? '#4f4' : '#4af' });
        }
        pushBuildingStatus(s, s.x, s.y, s.underConstruction ? 9 : 10, s.underConstruction ? 24 : 20, 3, 0.88, -18, extraBars);
    }

    for (let u of units) {
        if (!u || u.dead) continue;
        let ux = Number.isFinite(u.prevX) ? (u.prevX + (u.x - u.prevX) * alpha) : u.x;
        let uy = Number.isFinite(u.prevY) ? (u.prevY + (u.y - u.prevY) * alpha) : u.y;
        let ugx = Math.floor(ux / TILE), ugy = Math.floor(uy / TILE);
        if (ugx < bounds.minGx - 1 || ugx > bounds.maxGx + 1 || ugy < bounds.minGy - 1 || ugy > bounds.maxGy + 1) continue;
        if (!fullVisibility && (!visibilityGrid[ugy] || visibilityGrid[ugy][ugx] === 0)) continue;
        if (u.energy < u.maxEnergy) {
            pushBar(ux, uy, 0.72, -2, (Number(u.r) || 8) * 2 + 4, 2, Math.max(0, u.energy / Math.max(1, u.maxEnergy)), '#600', '#0f0');
        }
        if (shouldShowUnitLevels()) {
            pushText(ux, uy, 0.84, -16, getUnitLevelLabelText(u));
        }
    }

    return overlays;
}

function push3DRenderObject(target, object) {
    if (!target || !object) return;
    target.push({
        modelKey: object.modelKey || 'cube',
        modelCandidates: Array.isArray(object.modelCandidates) ? object.modelCandidates.slice() : [],
        x: Number(object.x) || 0,
        z: Number(object.z) || 0,
        y: Number(object.y) || 0,
        scaleX: Math.max(0.05, Number(object.scaleX) || 0.05),
        scaleY: Math.max(0.05, Number(object.scaleY) || 0.05),
        scaleZ: Math.max(0.05, Number(object.scaleZ) || 0.05),
        rotationY: Number(object.rotationY) || 0,
        tint: object.tint || '#c8ced8',
        alpha: Math.max(0.05, Math.min(1, Number(object.alpha) || 1)),
        topTextureKey: object.topTextureKey || '',
        topTextureCanvas: object.topTextureCanvas || null
    });
}

function get3DProjectionSnapshot() {
    let vw = viewW / camera.zoom;
    let vh = viewH / camera.zoom;
    return {
        viewportWidth: viewW,
        viewportHeight: viewH,
        worldWidth: GRID_W,
        worldHeight: GRID_H,
        camera: {
            centerX: (camera.x + vw * 0.5) / TILE,
            centerZ: (camera.y + vh * 0.5) / TILE,
            visibleWidth: vw / TILE,
            visibleHeight: vh / TILE,
            zoom: camera.zoom
        }
    };
}

function get3DVisibleWorldBounds() {
    let fallbackExtraTiles = Math.max(6, Math.ceil((viewH / Math.max(0.001, camera.zoom)) / TILE * 0.75));
    let fallback = getVisibleWorldBounds(fallbackExtraTiles);
    if (!renderer3dInstance || typeof renderer3dInstance.getGroundViewportBounds !== 'function') return fallback;
    let projected = renderer3dInstance.getGroundViewportBounds(get3DProjectionSnapshot(), Math.max(4, Math.ceil(Math.max(fallback.vw, fallback.vh) / TILE * 0.16)));
    if (!projected) return fallback;
    return {
        vw: fallback.vw,
        vh: fallback.vh,
        minGx: Math.max(0, Math.min(GRID_W - 1, projected.minGx)),
        minGy: Math.max(0, Math.min(GRID_H - 1, projected.minGy)),
        maxGx: Math.max(0, Math.min(GRID_W - 1, projected.maxGx)),
        maxGy: Math.max(0, Math.min(GRID_H - 1, projected.maxGy))
    };
}

function get3DBoxSelection(screenRect) {
    if (!screenRect || !renderer3dInstance || typeof renderer3dInstance.projectWorldToScreen !== 'function') {
        return { units: [], entities: [] };
    }

    if (typeof renderer3dInstance.buildViewProjection === 'function') {
        renderer3dInstance.buildViewProjection(get3DProjectionSnapshot());
    }

    let minSx = Math.min(screenRect.sx, screenRect.ex);
    let maxSx = Math.max(screenRect.sx, screenRect.ex);
    let minSy = Math.min(screenRect.sy, screenRect.ey);
    let maxSy = Math.max(screenRect.sy, screenRect.ey);
    let alpha = tickAlpha;
    let containsWorldPoint = (worldX, worldY, lift = 0.05) => {
        let projected = renderer3dInstance.projectWorldToScreen(worldX / TILE, lift, worldY / TILE);
        if (!projected) return false;
        return projected.x >= minSx && projected.x <= maxSx && projected.y >= minSy && projected.y <= maxSy;
    };

    let newUnits = [];
    let newEntities = [];
    for (let u of units) {
        if (u.owner !== localPlayerId || u.dead) continue;
        let ux = Number.isFinite(u.prevX) ? (u.prevX + (u.x - u.prevX) * alpha) : u.x;
        let uy = Number.isFinite(u.prevY) ? (u.prevY + (u.y - u.prevY) * alpha) : u.y;
        let ugx = Math.floor(ux / TILE), ugy = Math.floor(uy / TILE);
        if (!isTileVisible(ugx, ugy)) continue;
        if (containsWorldPoint(ux, uy, 0.28)) newUnits.push(u);
    }
    for (let b of barracks) {
        if (b.energy > 0 && b.owner === localPlayerId && isTileVisible(b.gx, b.gy) && containsWorldPoint(b.x, b.y, 0.12)) newEntities.push(b);
    }
    for (let t of towers) {
        if (t.energy > 0 && t.owner === localPlayerId && isTileVisible(t.gx, t.gy) && containsWorldPoint(t.x, t.y, 0.18)) newEntities.push(t);
    }
    for (let s of collectorSpawners) {
        if (s.energy > 0 && s.owner === localPlayerId && isTileVisible(s.gx, s.gy) && containsWorldPoint(s.x, s.y, 0.14)) newEntities.push(s);
    }
    let bounds = get3DVisibleWorldBounds();
    for (let gy = bounds.minGy; gy <= bounds.maxGy; gy++) {
        for (let gx = bounds.minGx; gx <= bounds.maxGx; gx++) {
            if (!isTileVisible(gx, gy)) continue;
            let cell = grid[gy][gx];
            if (cell.item && cell.owner === localPlayerId && containsWorldPoint(gx * TILE + TILE * 0.5, gy * TILE + TILE * 0.5, 0.08) && !newEntities.includes(cell.item)) {
                cell.item._gx = gx; cell.item._gy = gy; cell.item._cell = cell;
                newEntities.push(cell.item);
            }
        }
    }
    for (let m of goldMines) {
        if (!isTileVisible(m.gx, m.gy)) continue;
        if (containsWorldPoint(m.x, m.y, 0.06)) { m._isGoldMine = true; newEntities.push(m); }
    }
    for (let m of astarMines) {
        if (!isTileVisible(m.gx, m.gy)) continue;
        if (containsWorldPoint(m.x, m.y, 0.06)) { m._isAstarMine = true; newEntities.push(m); }
    }
    return { units: newUnits, entities: newEntities };
}

function getBackgroundWorldBoundsForRenderMode() {
    return renderDimensionMode === '3d' ? get3DVisibleWorldBounds() : getVisibleWorldBounds(1);
}

function build3DFrameData() {
    let bounds = get3DVisibleWorldBounds();
    let alpha = tickAlpha;
    let objects = [];
    let buildPreview = getCurrentBuildPreviewData();
    let centerX = camera.x + bounds.vw * 0.5;
    let centerY = camera.y + bounds.vh * 0.5;
    let backgroundMinX = bounds.minGx * TILE;
    let backgroundMinY = bounds.minGy * TILE;
    let backgroundMaxX = (bounds.maxGx + 1) * TILE;
    let backgroundMaxY = (bounds.maxGy + 1) * TILE;
    let overlays = build3DOverlayData(bounds, alpha);
    let unitOccupiedTileKeys = new Set();
    let overlapNowMs = (typeof performance !== 'undefined' && typeof performance.now === 'function') ? performance.now() : Date.now();
    let activeOverlapFadeKeys = new Set();
    let getOverlapFlattenScaleForTile = (gx, gy) => {
        let key = `${gx},${gy}`;
        let targetScale = unitOccupiedTileKeys.has(key) ? 0.2 : 1;
        let state = renderer3dOverlapFadeState.get(key);
        if (!state) {
            state = { value: targetScale, lastUpdateMs: overlapNowMs, lastSeenMs: overlapNowMs };
            renderer3dOverlapFadeState.set(key, state);
        } else {
            let deltaMs = Math.max(0, overlapNowMs - (Number(state.lastUpdateMs) || overlapNowMs));
            let maxStep = deltaMs / RENDERER3D_OVERLAP_FADE_DURATION_MS * 0.8;
            if (targetScale > state.value) state.value = Math.min(targetScale, state.value + maxStep);
            else if (targetScale < state.value) state.value = Math.max(targetScale, state.value - maxStep);
            state.lastUpdateMs = overlapNowMs;
            state.lastSeenMs = overlapNowMs;
        }
        activeOverlapFadeKeys.add(key);
        return state.value;
    };
    let getUnitHeightOffset = (unit) => {
        let id = Number(unit && unit.id) || 0;
        let bucket = ((id * 1103515245) >>> 0) % 7;
        return 0.012 + bucket * 0.003;
    };

    for (let u of units) {
        if (u.dead) continue;
        let ux = u.prevX + (u.x - u.prevX) * alpha;
        let uy = u.prevY + (u.y - u.prevY) * alpha;
        let ugx = Math.floor(ux / TILE), ugy = Math.floor(uy / TILE);
        if (ugx < bounds.minGx - 1 || ugx > bounds.maxGx + 1 || ugy < bounds.minGy - 1 || ugy > bounds.maxGy + 1) continue;
        if (!fullVisibility && (!visibilityGrid[ugy] || visibilityGrid[ugy][ugx] === 0)) continue;
        unitOccupiedTileKeys.add(`${ugx},${ugy}`);
    }

    for (let m of goldMines) {
        if (m.gx < bounds.minGx || m.gx > bounds.maxGx || m.gy < bounds.minGy || m.gy > bounds.maxGy) continue;
        if (!fullVisibility && (!visibilityGrid[m.gy] || visibilityGrid[m.gy][m.gx] === 0)) continue;
        push3DRenderObject(objects, {
            modelKey: m.gold > 0 ? 'gold_mine_active' : 'gold_mine_empty',
            x: m.gx + 0.5,
            z: m.gy + 0.5,
            scaleX: 0.9,
            scaleY: 0.35 * getOverlapFlattenScaleForTile(m.gx, m.gy),
            scaleZ: 0.9,
            tint: '#f0c83a',
            alpha: 1,
            topTextureKey: `gold_mine:${m.gold > 0 ? 'active' : 'empty'}`,
            topTextureCanvas: get3DTopTextureCanvas(`gold_mine:${m.gold > 0 ? 'active' : 'empty'}`, (g) => {
                draw3DSpriteIntoTopTexture(g, _getGoldMineTileSprite(m.gold > 0), 8);
            })
        });
    }

    for (let m of astarMines) {
        if (m.gx < bounds.minGx || m.gx > bounds.maxGx || m.gy < bounds.minGy || m.gy > bounds.maxGy) continue;
        if (!fullVisibility && (!visibilityGrid[m.gy] || visibilityGrid[m.gy][m.gx] === 0)) continue;
        push3DRenderObject(objects, {
            modelKey: m.astar > 0 ? 'astar_mine_active' : 'astar_mine_empty',
            x: m.gx + 0.5,
            z: m.gy + 0.5,
            scaleX: 0.9,
            scaleY: 0.35 * getOverlapFlattenScaleForTile(m.gx, m.gy),
            scaleZ: 0.9,
            tint: '#d8d8e8',
            alpha: 1,
            topTextureKey: `astar_mine:${m.astar > 0 ? 'active' : 'empty'}`,
            topTextureCanvas: get3DTopTextureCanvas(`astar_mine:${m.astar > 0 ? 'active' : 'empty'}`, (g) => {
                g.fillStyle = '#888'; g.beginPath(); g.arc(32, 32, 18, 0, Math.PI * 2); g.fill();
                g.fillStyle = '#fff'; g.font = 'bold 28px Arial'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('★', 32, 33);
            })
        });
    }

    for (let y = bounds.minGy; y <= bounds.maxGy; y++) {
        let gridRow = grid[y];
        let visRow = visibilityGrid[y];
        if (!gridRow) continue;
        for (let x = bounds.minGx; x <= bounds.maxGx; x++) {
            let cell = gridRow[x];
            if (!cell || !cell.item) continue;
            if (!fullVisibility && (!visRow || visRow[x] === 0)) continue;
            let itemStatus = get3DBuildingTextureStatus(cell.item);
            push3DRenderObject(objects, {
                modelKey: `item_${cell.item.type || 'floor'}`,
                x: x + 0.5,
                z: y + 0.5,
                scaleX: 0.84,
                scaleY: 0.14 * getOverlapFlattenScaleForTile(x, y),
                scaleZ: 0.84,
                rotationY: -(Number(cell.item.angle) || 0),
                tint: get3DRenderOwnerColor(cell.owner),
                alpha: 1,
                topTextureKey: `item:${cell.item.type}:${cell.owner}:${_getFloorItemEnergyBucket(cell.item)}:${itemStatus.keySuffix}`,
                topTextureCanvas: get3DTopTextureForFloorItem(cell.item, itemStatus)
            });
        }
    }

    for (let t of towers) {
        if (t.gx < bounds.minGx - 1 || t.gx > bounds.maxGx + 1 || t.gy < bounds.minGy - 1 || t.gy > bounds.maxGy + 1) continue;
        if (!fullVisibility && (!visibilityGrid[t.gy] || visibilityGrid[t.gy][t.gx] === 0)) continue;
        let towerStatus = get3DBuildingTextureStatus(t);
        push3DRenderObject(objects, {
            modelKey: `tower_${t.type || 'base'}`,
            x: t.x / TILE,
            z: t.y / TILE,
            scaleX: 0.82,
            scaleY: 1.05 * getOverlapFlattenScaleForTile(t.gx, t.gy),
            scaleZ: 0.82,
            rotationY: -(Number(t.angle) || 0),
            tint: get3DRenderOwnerColor(t.owner),
            alpha: 1,
            topTextureKey: `tower:${t.type}:${t.owner}:${_quantizeTowerAngleIndex(t.angle || 0)}:${towerStatus.keySuffix}`,
            topTextureCanvas: get3DBuildingTopTexture('tower', t.owner, { subtype: t.type, color: t.baseStats && t.baseStats.color, angle: t.angle || 0, angleKey: _quantizeTowerAngleIndex(t.angle || 0), active: t.type === 'laser' ? t.connectedLasers && t.connectedLasers.length > 0 : true, status: towerStatus, statusKey: towerStatus.keySuffix })
        });
    }

    for (let s of collectorSpawners) {
        if (s.gx < bounds.minGx || s.gx > bounds.maxGx || s.gy < bounds.minGy || s.gy > bounds.maxGy) continue;
        if (!fullVisibility && (!visibilityGrid[s.gy] || visibilityGrid[s.gy][s.gx] === 0)) continue;
        let spawnerExtraBars = [];
        if (!s.underConstruction && s.spawnQueue && s.spawnQueue.length > 0 && s.spawnCooldown > 0) {
            spawnerExtraBars.push({ pct: s.spawnTimer / s.spawnCooldown, bgColor: '#333', fillColor: (s.spawnTimer / s.spawnCooldown) > 0.8 ? '#4f4' : '#fa0' });
        }
        if (!s.underConstruction && s.type === 'research' && s.researchTask && s.researchTask.workRequired > 0) {
            let pct = Math.max(0, Math.min(1, (s.researchTask.workDone || 0) / s.researchTask.workRequired));
            spawnerExtraBars.push({ pct, bgColor: '#333', fillColor: pct > 0.8 ? '#4f4' : '#4af' });
        }
        let spawnerStatus = get3DBuildingTextureStatus(s, spawnerExtraBars);
        push3DRenderObject(objects, {
            modelKey: `spawner_${s.type || 'base'}`,
            x: s.x / TILE,
            z: s.y / TILE,
            scaleX: 0.95,
            scaleY: 0.9 * getOverlapFlattenScaleForTile(s.gx, s.gy),
            scaleZ: 0.95,
            tint: get3DRenderOwnerColor(s.owner),
            alpha: 1,
            topTextureKey: `spawner:${s.type}:${s.owner}:${spawnerStatus.keySuffix}`,
            topTextureCanvas: get3DBuildingTopTexture(
                s.type === 'astar_spawner' ? 'spawner_astar' :
                    s.type === 'salvager' ? 'spawner_salvager' :
                        s.type === 'builder_spawner' ? 'spawner_builder' :
                            s.type === 'healer_spawner' ? 'spawner_healer' :
                                s.type === 'research' ? 'spawner_research' :
                                    'spawner_energy',
                s.owner,
                { subtype: s.type, status: spawnerStatus, statusKey: spawnerStatus.keySuffix }
            )
        });
    }

    for (let b of barracks) {
        if (b.gx < bounds.minGx || b.gx > bounds.maxGx || b.gy < bounds.minGy || b.gy > bounds.maxGy) continue;
        if (!fullVisibility && (!visibilityGrid[b.gy] || visibilityGrid[b.gy][b.gx] === 0)) continue;
        let barrackExtraBars = [];
        if (!b.underConstruction && b.spawnQueue && b.spawnQueue.length > 0 && b.spawnCooldown > 0) {
            barrackExtraBars.push({ pct: b.spawnTimer / b.spawnCooldown, bgColor: '#333', fillColor: (b.spawnTimer / b.spawnCooldown) > 0.8 ? '#4f4' : '#fa0' });
        }
        let barrackStatus = get3DBuildingTextureStatus(b, barrackExtraBars);
        push3DRenderObject(objects, {
            modelKey: `barrack_${b.unitType || 'norm'}`,
            x: b.x / TILE,
            z: b.y / TILE,
            scaleX: 0.98,
            scaleY: 0.86 * getOverlapFlattenScaleForTile(b.gx, b.gy),
            scaleZ: 0.98,
            tint: get3DRenderOwnerColor(b.owner),
            alpha: 1,
            topTextureKey: `barrack:${b.unitType}:${b.owner}:${barrackStatus.keySuffix}`,
            topTextureCanvas: get3DBuildingTopTexture('barrack', b.owner, { subtype: b.unitType, color: (BASE_UNIT_STATS[b.unitType] || BASE_UNIT_STATS.norm).color, status: barrackStatus, statusKey: barrackStatus.keySuffix })
        });
    }

    for (let d of droppedItems) {
        if (d.gx < bounds.minGx || d.gx > bounds.maxGx || d.gy < bounds.minGy || d.gy > bounds.maxGy) continue;
        if (!fullVisibility && (!visibilityGrid[d.gy] || visibilityGrid[d.gy][d.gx] === 0)) continue;
        push3DRenderObject(objects, {
            modelKey: 'dropped_energy',
            x: d.x / TILE,
            z: d.y / TILE,
            scaleX: 0.22,
            scaleY: 0.22,
            scaleZ: 0.22,
            tint: '#ffd84d',
            topTextureKey: 'dropped_energy',
            topTextureCanvas: get3DTopTextureCanvas('dropped_energy', (g) => {
                g.fillStyle = '#ffd84d'; g.beginPath(); g.arc(32, 32, 16, 0, Math.PI * 2); g.fill();
                g.fillStyle = '#222'; g.font = 'bold 24px Arial'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('⚡', 32, 33);
            })
        });
    }

    for (let u of units) {
        if (u.dead) continue;
        let ux = u.prevX + (u.x - u.prevX) * alpha;
        let uy = u.prevY + (u.y - u.prevY) * alpha;
        let ugx = Math.floor(ux / TILE), ugy = Math.floor(uy / TILE);
        if (ugx < bounds.minGx - 1 || ugx > bounds.maxGx + 1 || ugy < bounds.minGy - 1 || ugy > bounds.maxGy + 1) continue;
        if (!fullVisibility && (!visibilityGrid[ugy] || visibilityGrid[ugy][ugx] === 0)) continue;
        let footprint = Math.max(0.28, Math.min(0.9, ((u.r || 8) * 2.2) / TILE));
        let unitStatus = get3DUnitTextureStatus(u);
        push3DRenderObject(objects, {
            modelKey: `unit_${u.unitType || 'norm'}`,
            x: ux / TILE,
            y: getUnitHeightOffset(u),
            z: uy / TILE,
            scaleX: footprint,
            scaleY: Math.max(0.32, footprint * 0.9),
            scaleZ: footprint,
            rotationY: Math.atan2(Number(u.vx) || 0, Number(u.vy) || 1),
            tint: get3DRenderOwnerColor(u.owner),
            topTextureKey: `unit:${u.unitType}:${u.owner}:${unitStatus.keySuffix}`,
            topTextureCanvas: get3DUnitTopTexture(u.unitType, u.owner, unitStatus)
        });
    }

    for (let [key, state] of renderer3dOverlapFadeState) {
        if (activeOverlapFadeKeys.has(key)) continue;
        let idleMs = overlapNowMs - (Number(state && state.lastSeenMs) || overlapNowMs);
        if (idleMs > RENDERER3D_OVERLAP_FADE_DURATION_MS && Math.abs((Number(state && state.value) || 1) - 1) < 0.001) {
            renderer3dOverlapFadeState.delete(key);
        }
    }

    return {
        viewportWidth: viewW,
        viewportHeight: viewH,
        worldWidth: GRID_W,
        worldHeight: GRID_H,
        backgroundCanvas: bgCanvas || canvas,
        backgroundVersion: renderer3dBackgroundVersion,
        backgroundBounds: {
            centerX: (backgroundMinX + backgroundMaxX) * 0.5 / TILE,
            centerZ: (backgroundMinY + backgroundMaxY) * 0.5 / TILE,
            width: (backgroundMaxX - backgroundMinX) / TILE,
            height: (backgroundMaxY - backgroundMinY) / TILE,
        },
        overlays,
        camera: {
            centerX: centerX / TILE,
            centerZ: centerY / TILE,
            visibleWidth: bounds.vw / TILE,
            visibleHeight: bounds.vh / TILE,
            zoom: camera.zoom
        },
        buildPreview,
        objects
    };
}

function drawInteractionOverlay(renderer3dSnapshot = null) {
    if (!overlayCtx || !overlayCanvas) return;
    let dpr = window.devicePixelRatio || 1;
    overlayCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    overlayCtx.clearRect(0, 0, viewW, viewH);

    if (renderDimensionMode === '3d' && renderer3dInstance && renderer3dSnapshot && renderer3dSnapshot.overlays && typeof renderer3dInstance.drawOverlay === 'function') {
        renderer3dInstance.drawOverlay(renderer3dSnapshot.overlays, overlayCtx);
        if (renderer3dSnapshot.buildPreview && typeof renderer3dInstance.drawBuildPreview === 'function') {
            renderer3dInstance.drawBuildPreview(renderer3dSnapshot.buildPreview, overlayCtx);
        }
    }

    if (isBoxSelecting && selectionBoxScreen) {
        let sx = Math.min(selectionBoxScreen.sx, selectionBoxScreen.ex);
        let sy = Math.min(selectionBoxScreen.sy, selectionBoxScreen.ey);
        let w = Math.abs(selectionBoxScreen.ex - selectionBoxScreen.sx);
        let h = Math.abs(selectionBoxScreen.ey - selectionBoxScreen.sy);
        overlayCtx.fillStyle = 'rgba(0,255,0,0.12)';
        overlayCtx.strokeStyle = 'rgba(0,255,0,0.9)';
        overlayCtx.lineWidth = 1;
        overlayCtx.fillRect(sx, sy, w, h);
        overlayCtx.strokeRect(sx + 0.5, sy + 0.5, Math.max(0, w - 1), Math.max(0, h - 1));
    }
}

function syncRenderModeUi() {
    let gameArea = document.getElementById('game-area');
    if (gameArea) gameArea.classList.toggle('render-mode-3d', renderDimensionMode === '3d');
    renderer3dHost = renderer3dHost || document.getElementById('renderer3d-host');
    if (renderer3dHost) renderer3dHost.style.opacity = renderDimensionMode === '3d' ? '1' : '0';
    let btn2d = document.getElementById('btn-view-2d');
    let btn3d = document.getElementById('btn-view-3d');
    if (btn2d) btn2d.classList.toggle('active', renderDimensionMode === '2d');
    if (btn3d) btn3d.classList.toggle('active', renderDimensionMode === '3d');
    if (renderer3dInstance) renderer3dInstance.setEnabled(renderDimensionMode === '3d');
}

function ensure3DRendererInitialized() {
    if (renderer3dInstance) return renderer3dInstance;
    renderer3dHost = renderer3dHost || document.getElementById('renderer3d-host');
    if (!renderer3dHost || !window.Defence3Renderer3D) return null;
    renderer3dInstance = new window.Defence3Renderer3D({
        mount: renderer3dHost
    });
    renderer3dInstance.resize(viewW, viewH);
    renderer3dInstance.setEnabled(renderDimensionMode === '3d');
    return renderer3dInstance;
}

function setRenderDimensionMode(nextMode) {
    let normalized = nextMode === '3d' ? '3d' : '2d';
    if (renderDimensionMode === normalized) return;
    renderDimensionMode = normalized;
    if (normalized === '3d') ensure3DRendererInitialized();
    syncRenderModeUi();
    window.dispatchEvent(new Event('resize'));
}

function rebuildMinimapStaticLayer(scale, tilePx) {
    if (!_minimapStaticCanvas || _minimapStaticScale !== scale || _minimapStaticTilePx !== tilePx) {
        _minimapStaticCanvas = document.createElement('canvas');
        _minimapStaticCanvas.width = MINIMAP_SIZE;
        _minimapStaticCanvas.height = MINIMAP_SIZE;
        _minimapStaticCtx = _minimapStaticCanvas.getContext('2d');
        _minimapStaticCtx.imageSmoothingEnabled = false;
        _minimapStaticScale = scale;
        _minimapStaticTilePx = tilePx;
    }

    let c = _minimapStaticCtx;
    c.clearRect(0, 0, MINIMAP_SIZE, MINIMAP_SIZE);
    c.fillStyle = '#111';
    c.fillRect(0, 0, MINIMAP_SIZE, MINIMAP_SIZE);

    let lastFill = null;
    const setFill = (color) => {
        if (lastFill !== color) {
            c.fillStyle = color;
            lastFill = color;
        }
    };
    const drawCell = (gx, gy, color) => {
        setFill(color);
        c.fillRect(gx * scale, gy * scale, tilePx, tilePx);
    };
    const drawRun = (startX, endX, y, color) => {
        if (endX <= startX) return;
        setFill(color);
        let cells = endX - startX;
        let runW = ((cells - 1) * scale) + tilePx;
        c.fillRect(startX * scale, y * scale, runW, tilePx);
    };

    for (let t of towers) drawCell(t.gx, t.gy, PLAYER_COLORS[t.owner]);
    for (let b of barracks) drawCell(b.gx, b.gy, PLAYER_COLORS[b.owner]);
    for (let s of collectorSpawners) drawCell(s.gx, s.gy, PLAYER_COLORS[s.owner]);

    for (let y = 0; y < GRID_H; y++) {
        let runStart = -1;
        let runOwner = -1;
        for (let x = 0; x <= GRID_W; x++) {
            let owner = -1;
            if (x < GRID_W) {
                let cell = grid[y][x];
                if (cell.item && cell.owner >= 0) owner = cell.owner;
            }

            if (owner >= 0) {
                if (runStart < 0) {
                    runStart = x;
                    runOwner = owner;
                } else if (owner !== runOwner) {
                    drawRun(runStart, x, y, PLAYER_COLORS_DIM[runOwner] || PLAYER_COLORS[runOwner]);
                    runStart = x;
                    runOwner = owner;
                }
            } else if (runStart >= 0) {
                drawRun(runStart, x, y, PLAYER_COLORS_DIM[runOwner] || PLAYER_COLORS[runOwner]);
                runStart = -1;
                runOwner = -1;
            }
        }
    }

    for (let m of goldMines) {
        if (m.gold > 0) drawCell(m.gx, m.gy, '#fd0');
    }

    _minimapStaticDirty = false;
}

function drawMinimap() {
    let scale = MINIMAP_SIZE / GRID_W; // 2 px per tile
    let tilePx = Math.max(1, scale);
    let vis = visibilityGrid;
    let lastFill = null;

    minimapCtx.imageSmoothingEnabled = false;

    if (_minimapStaticScale !== scale || _minimapStaticTilePx !== tilePx) {
        _minimapStaticDirty = true;
        _requestStaticCacheCommit();
        commitStaticCaches(true);
    }
    if (_staticCacheCommitVersion < 0 || !_minimapStaticCanvas) {
        commitStaticCaches(true);
    }

    const setMinimapFill = (color) => {
        if (lastFill !== color) {
            minimapCtx.fillStyle = color;
            lastFill = color;
        }
    };

    const drawMinimapRun = (startX, endX, y, color) => {
        if (endX <= startX) return;
        setMinimapFill(color);
        let cells = endX - startX;
        // Width for merged cells keeps the same visual coverage as per-cell fillRect.
        let runW = ((cells - 1) * scale) + tilePx;
        minimapCtx.fillRect(startX * scale, y * scale, runW, tilePx);
    };

    // Draw base minimap immediately so dynamic overlays (fog/units/alerts) stay visible on top.
    minimapCtx.drawImage(_minimapStaticCanvas, 0, 0);

    // Unknown areas
    if (!fullVisibility && vis.length > 0) {
        for (let y = 0; y < GRID_H; y++) {
            let row = vis[y];
            let runStart = -1;
            for (let x = 0; x <= GRID_W; x++) {
                let hidden = x < GRID_W && (!row || row[x] === 0);
                if (hidden) {
                    if (runStart < 0) runStart = x;
                } else if (runStart >= 0) {
                    drawMinimapRun(runStart, x, y, '#000');
                    runStart = -1;
                }
            }
        }
    }

    // Units
    for (let u of units) {
        if (u.dead) continue;
        let cgy = Math.floor(u.y / TILE), cgx = Math.floor(u.x / TILE);
        if (!fullVisibility && (!vis[cgy] || vis[cgy][cgx] === 0)) continue;
        setMinimapFill(PLAYER_COLORS[u.owner]);
        let ux = (u.x / TILE) * scale, uy = (u.y / TILE) * scale;
        minimapCtx.fillRect(ux, uy, 2, 2);
    }

    // Damage alerts (minimap only)
    drawMinimapAlerts(minimapCtx, scale);

    // Camera viewport rect
    let vw = viewW / camera.zoom, vh = viewH / camera.zoom;
    minimapCtx.strokeStyle = '#fff'; minimapCtx.lineWidth = 1;
    minimapCtx.strokeRect(camera.x / TILE * scale, camera.y / TILE * scale, vw / TILE * scale, vh / TILE * scale);
}

function isTileVisible(gx, gy) {
    return fullVisibility || (visibilityGrid[gy] && visibilityGrid[gy][gx] > 0);
}

function createEmptyVisibilityGrid() {
    let vis = new Array(GRID_H);
    for (let y = 0; y < GRID_H; y++) vis[y] = new Float32Array(GRID_W);
    return vis;
}

function computeVisibilityGridForPlayer(playerId, vis) {
    for (let y = 0; y < GRID_H; y++) vis[y].fill(0);

    let setVis = (gx, gy, r) => {
        if (gx >= 0 && gx < GRID_W && gy >= 0 && gy < GRID_H) {
            if (r > vis[gy][gx]) vis[gy][gx] = r;
        }
    };

    for (let u of units) if ((u.owner === playerId || (u.watched || 0) > 0) && !u.dead) {
        setVis(Math.floor(u.x / TILE), Math.floor(u.y / TILE), u.visionRange || 4);
    }
    for (let t of towers) if ((t.owner === playerId || (t.watched || 0) > 0) && t.energy > 0 && !t.underConstruction) {
        setVis(t.gx, t.gy, (t.currentStats && t.currentStats.visionRange) || 3);
    }
    for (let b of barracks) if ((b.owner === playerId || (b.watched || 0) > 0) && b.energy > 0 && !b.underConstruction) setVis(b.gx, b.gy, 4);
    for (let s of collectorSpawners) if ((s.owner === playerId || (s.watched || 0) > 0) && s.energy > 0 && !s.underConstruction) setVis(s.gx, s.gy, 4);
    for (let y = 0; y < GRID_H; y++) {
        for (let x = 0; x < GRID_W; x++) {
            let cell = grid[y][x];
            if (cell.item && cell.item.energy > 0 && !cell.item.underConstruction && (cell.owner === playerId || (cell.item.watched || 0) > 0)) setVis(x, y, 3);
        }
    }

    // 2-pass DP flood fill (Euclidean approximation)
    for (let y = 0; y < GRID_H; y++) {
        for (let x = 0; x < GRID_W; x++) {
            let v = vis[y][x];
            if (x > 0) v = Math.max(v, vis[y][x - 1] - 1);
            if (y > 0) v = Math.max(v, vis[y - 1][x] - 1);
            if (x > 0 && y > 0) v = Math.max(v, vis[y - 1][x - 1] - 1.414);
            if (x < GRID_W - 1 && y > 0) v = Math.max(v, vis[y - 1][x + 1] - 1.414);
            vis[y][x] = v;
        }
    }
    for (let y = GRID_H - 1; y >= 0; y--) {
        for (let x = GRID_W - 1; x >= 0; x--) {
            let v = vis[y][x];
            if (x < GRID_W - 1) v = Math.max(v, vis[y][x + 1] - 1);
            if (y < GRID_H - 1) v = Math.max(v, vis[y + 1][x] - 1);
            if (x < GRID_W - 1 && y < GRID_H - 1) v = Math.max(v, vis[y + 1][x + 1] - 1.414);
            if (x > 0 && y < GRID_H - 1) v = Math.max(v, vis[y + 1][x - 1] - 1.414);
            vis[y][x] = v;
        }
    }
}

function getVisibilityGridForPlayer(playerId) {
    if (fullVisibility) return null;
    if (visibilityCacheTick !== gameTime) {
        visibilityGridByPlayerCache.clear();
        visibilityCacheTick = gameTime;
    }
    let cached = visibilityGridByPlayerCache.get(playerId);
    if (cached) return cached;
    let vis = createEmptyVisibilityGrid();
    computeVisibilityGridForPlayer(playerId, vis);
    visibilityGridByPlayerCache.set(playerId, vis);
    return vis;
}

function isTileVisibleToPlayer(playerId, gx, gy) {
    if (fullVisibility) return true;
    if (gx < 0 || gx >= GRID_W || gy < 0 || gy >= GRID_H) return false;

    if (playerId === localPlayerId) return isTileVisible(gx, gy);
    let vis = getVisibilityGridForPlayer(playerId);
    return !!(vis[gy] && vis[gy][gx] > 0);
}

function isGameplayTargetVisibleToPlayer(playerId, gx, gy) {
    if (isMultiplayer) return true;
    return isTileVisibleToPlayer(playerId, gx, gy);
}

function updateVisibility(playerId) {
    // Check fullVisibility toggle
    if (fullVisibility) return;

    visibilityGrid = getVisibilityGridForPlayer(playerId);

    visibilityVersion++;
}


// Stagger periodic tasks so expensive refreshes don't bunch on one frame.
function processVisibleSimulationFrame(timestamp) {
    sendNetworkPings(timestamp);
    if (document.hidden) {
        _lastTickTime = timestamp;
        return;
    }

    if (gameStarted && !gameOver) {
        let dt = timestamp - _lastTickTime;
        _lastTickTime = timestamp;
        if (dt > 200) dt = 200; // cap to prevent spiral of death
        _tickAccumulator += dt;

        let ticksProcessed = 0;
        while (_tickAccumulator >= TICK_MS && ticksProcessed < 5) {
            if (isMultiplayer) {
                driveStrictLockstep(timestamp, currentTick);
            }
            if (isMultiplayer && !isStrictTickReady(currentTick)) {
                if (!waitingForRemoteSince) waitingForRemoteSince = timestamp;
                _tickAccumulator = TICK_MS; // wait for remote
                break;
            }
            waitingForRemoteSince = 0;
            runOneTick();
            ticksProcessed++;
            _tickAccumulator -= TICK_MS;
        }
    }
}

function processRenderFrame(timestamp) {
    if (!ctx || !canvas || !bgCtx || !minimapCtx) {
        ensureRenderContextsInitialized();
        return;
    }

    tickAlpha = Math.min(_tickAccumulator / TICK_MS, 1);
    updateCamera();
    let dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    draw();
    let renderer3dSnapshot = null;
    if (renderDimensionMode === '3d') {
        let renderer3d = ensure3DRendererInitialized();
        if (renderer3d) {
            renderer3dSnapshot = build3DFrameData();
            renderer3d.render(renderer3dSnapshot);
        }
    } else if (renderer3dInstance) {
        renderer3dInstance.setEnabled(false);
    }
    drawInteractionOverlay(renderer3dSnapshot);
    flushTickUiRequests();
    updateHUD();
    updateControlGroupBar();

    // FPS counter
    _fpsFrameCount++;
    if (timestamp - _fpsLastTime >= 1000) {
        _fpsDisplay = Math.round(_fpsFrameCount * 1000 / (timestamp - _fpsLastTime));
        _fpsFrameCount = 0; _fpsLastTime = timestamp;
    }
    // Refresh build menu and info panel every ~30 frames.
    if (++_buildMenuRefreshCounter >= 30) {
        _buildMenuRefreshCounter = 0;
        if (_buildMenuNeedsRefresh) updateBuildMenu();
        if (!researchQueueDragInProgress) updateInfoPanel();
    }
    // Refresh minimap static layer every ~30 frames on a different phase.
    if (++_minimapRefreshCounter >= 30) {
        _minimapRefreshCounter = 0;
        commitStaticCaches(false, 'minimap');
    }
    // Refresh combined background/static terrain every ~30 frames on a third phase.
    if (++_backgroundCacheRefreshCounter >= 30) {
        _backgroundCacheRefreshCounter = 0;
        commitStaticCaches(false, 'background');
    }
}

function simulationFrame(timestamp) {
    _simulationFrameHandle = 0;
    processVisibleSimulationFrame(timestamp);
    queueSimulationFrame();
}

function renderFrame(timestamp) {
    _renderFrameHandle = 0;
    processRenderFrame(timestamp);
    queueRenderFrame();
}

function queueSimulationFrame() {
    if (_simulationFrameHandle) return;
    _simulationFrameHandle = requestAnimationFrame(simulationFrame);
}

function queueRenderFrame() {
    if (_renderFrameHandle) return;
    _renderFrameHandle = requestAnimationFrame(renderFrame);
}

function startMainThreadLoops() {
    queueSimulationFrame();
    queueRenderFrame();
}

function runHiddenTickPump() {
    if (!gameStarted || gameOver || !document.hidden) return;

    let now = performance.now();
    sendNetworkPings(now);
    if (!_hiddenLastTickTime) _hiddenLastTickTime = now;
    let dt = now - _hiddenLastTickTime;
    _hiddenLastTickTime = now;
    if (dt > 2000) dt = 2000;
    if (dt < 0) dt = 0;
    _hiddenTickAccumulator += dt;

    let ticksProcessed = 0;
    while (_hiddenTickAccumulator >= TICK_MS && ticksProcessed < 30) {
        if (isMultiplayer) {
            driveStrictLockstep(now, currentTick);
        }
        if (isMultiplayer && !isStrictTickReady(currentTick)) {
            if (!waitingForRemoteSince) waitingForRemoteSince = now;
            _hiddenTickAccumulator = Math.min(_hiddenTickAccumulator, TICK_MS);
            break;
        }

        waitingForRemoteSince = 0;
        runOneTick();
        ticksProcessed++;
        _hiddenTickAccumulator -= TICK_MS;
    }
}

function refreshBackgroundTickMode() {
    if (document.hidden) {
        _hiddenLastTickTime = performance.now();
        _hiddenTickAccumulator = 0;
        if (!_backgroundTickInterval) {
            _backgroundTickInterval = setInterval(runHiddenTickPump, TICK_MS);
        }
    } else if (_backgroundTickInterval) {
        clearInterval(_backgroundTickInterval);
        _backgroundTickInterval = null;
        _hiddenLastTickTime = 0;
        _hiddenTickAccumulator = 0;
    }
}

let _renderInitEventsBound = false;

function ensureRenderContextsInitialized() {
    canvas = canvas || document.getElementById('gameCanvas');
    let gameArea = document.getElementById('game-area');
    if (!canvas || !gameArea) return false;
    renderer3dHost = renderer3dHost || document.getElementById('renderer3d-host');

    if (!ctx) {
        ctx = canvas.getContext('2d');

        if (!ctx) return false;
        ctx.imageSmoothingEnabled = false;
    }

    if (!bgCanvas) {
        bgCanvas = document.createElement('canvas');
        bgCanvas.id = 'gameBackgroundCanvas';
        bgCanvas.style.position = 'absolute';
        bgCanvas.style.top = '0';
        bgCanvas.style.left = '0';
        bgCanvas.style.pointerEvents = 'none';
    }
    if (!bgCanvas.parentElement) gameArea.insertBefore(bgCanvas, canvas);
    if (!bgCtx) {
        bgCtx = bgCanvas.getContext('2d');
        if (!bgCtx) return false;
        bgCtx.imageSmoothingEnabled = false;
    }

    if (!overlayCanvas) {
        overlayCanvas = document.createElement('canvas');
        overlayCanvas.id = 'gameOverlayCanvas';
        overlayCanvas.style.pointerEvents = 'none';
    }
    if (!overlayCanvas.parentElement) gameArea.appendChild(overlayCanvas);
    if (!overlayCtx) {
        overlayCtx = overlayCanvas.getContext('2d');
        if (!overlayCtx) return false;
        overlayCtx.imageSmoothingEnabled = false;
    }

    minimapCanvas = minimapCanvas || document.getElementById('minimapCanvas');
    if (!minimapCanvas) return false;
    if (!minimapCtx) minimapCtx = minimapCanvas.getContext('2d');
    if (!minimapCtx) return false;
    minimapCtx.imageSmoothingEnabled = false;

    let mmDpr = window.devicePixelRatio || 1;
    if (minimapCanvas.width !== MINIMAP_SIZE * mmDpr || minimapCanvas.height !== MINIMAP_SIZE * mmDpr) {
        minimapCanvas.width = MINIMAP_SIZE * mmDpr;
        minimapCanvas.height = MINIMAP_SIZE * mmDpr;
        minimapCanvas.style.width = MINIMAP_SIZE + 'px';
        minimapCanvas.style.height = MINIMAP_SIZE + 'px';
        minimapCtx.setTransform(mmDpr, 0, 0, mmDpr, 0, 0);
        minimapCtx.imageSmoothingEnabled = false;
        _minimapStaticCanvas = null;
        _minimapStaticCtx = null;
        _minimapStaticDirty = true;
        _requestStaticCacheCommit();
    }

    viewW = gameArea.clientWidth;
    viewH = gameArea.clientHeight;
    let dpr = window.devicePixelRatio || 1;
    bgCanvas.width = viewW * dpr;
    bgCanvas.height = viewH * dpr;
    bgCanvas.style.width = viewW + 'px';
    bgCanvas.style.height = viewH + 'px';
    overlayCanvas.width = viewW * dpr;
    overlayCanvas.height = viewH * dpr;
    overlayCanvas.style.width = viewW + 'px';
    overlayCanvas.style.height = viewH + 'px';
    canvas.width = viewW * dpr;
    canvas.height = viewH * dpr;
    canvas.style.width = viewW + 'px';
    canvas.style.height = viewH + 'px';

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    bgCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    overlayCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingEnabled = false;
    bgCtx.imageSmoothingEnabled = false;
    overlayCtx.imageSmoothingEnabled = false;
    if (renderer3dInstance) renderer3dInstance.resize(viewW, viewH);

    if (!_renderInitEventsBound) {
        window.addEventListener('resize', () => {
            if (!ensureRenderContextsInitialized()) return;
            invalidateStaticLayerCache();
        });
        document.addEventListener('visibilitychange', refreshBackgroundTickMode);
        _renderInitEventsBound = true;
    }

    return true;
}
