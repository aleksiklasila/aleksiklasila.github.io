// DRAWING HELPERS
// ============================================================
let _visibilityMaskCanvas = null;
let _visibilityMaskCtx = null;
let _visibilityMaskGridCanvas = null;
let _visibilityMaskGridCtx = null;
let _visibilityMaskVersion = -1;
let _visibilityMaskFullVisibility = false;
let _combinedBgDirtyFull = true;
let _combinedBgDirtyBounds = null; // {minGx,minGy,maxGx,maxGy}

function _drawAreaCoverageOverlay2D(ctx, cells, color, overlayViewMinX, overlayViewMinY, overlayViewMaxX, overlayViewMaxY) {
    if (!ctx || !Array.isArray(cells) || cells.length <= 0) return;
    let cellSet = new Set();
    for (let i = 0; i < cells.length; i++) {
        let cell = cells[i];
        if (!cell) continue;
        cellSet.add(`${cell.x},${cell.y}`);
    }
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = 2.5;
    for (let i = 0; i < cells.length; i++) {
        let cell = cells[i];
        if (!cell) continue;
        let x = cell.x * TILE;
        let y = cell.y * TILE;
        if (!_overlayBoundsVisible(x, y, x + TILE, y + TILE, overlayViewMinX, overlayViewMinY, overlayViewMaxX, overlayViewMaxY, 4)) continue;
        if (!cellSet.has(`${cell.x},${cell.y - 1}`)) {
            ctx.beginPath();
            ctx.moveTo(x, y + 0.5);
            ctx.lineTo(x + TILE, y + 0.5);
            ctx.stroke();
        }
        if (!cellSet.has(`${cell.x + 1},${cell.y}`)) {
            ctx.beginPath();
            ctx.moveTo(x + TILE - 0.5, y);
            ctx.lineTo(x + TILE - 0.5, y + TILE);
            ctx.stroke();
        }
        if (!cellSet.has(`${cell.x},${cell.y + 1}`)) {
            ctx.beginPath();
            ctx.moveTo(x, y + TILE - 0.5);
            ctx.lineTo(x + TILE, y + TILE - 0.5);
            ctx.stroke();
        }
        if (!cellSet.has(`${cell.x - 1},${cell.y}`)) {
            ctx.beginPath();
            ctx.moveTo(x + 0.5, y);
            ctx.lineTo(x + 0.5, y + TILE);
            ctx.stroke();
        }
    }
    ctx.restore();
}

const TOWER_ICON_SPRITE_CACHE = new Map();
const TOWER_ICON_SPRITE_CACHE_MAX = 1024;
const TOWER_ICON_ANGLE_STEPS = 32;
const TOWER_ICON_ANGLE_TABLE = (() => {
    let table = new Float32Array(TOWER_ICON_ANGLE_STEPS);
    let tau = Math.PI * 2;
    for (let i = 0; i < TOWER_ICON_ANGLE_STEPS; i++) table[i] = (i / TOWER_ICON_ANGLE_STEPS) * tau;
    return table;
})();

function _quantizeTowerAngleIndex(angle) {
    let a = Number.isFinite(angle) ? angle : 0;
    let tau = Math.PI * 2;
    a = ((a % tau) + tau) % tau;
    return Math.round((a / tau) * TOWER_ICON_ANGLE_STEPS) % TOWER_ICON_ANGLE_STEPS;
}

function get2DRenderOwnerColor(owner) {
    if (Number.isFinite(owner) && owner >= 0) {
        return teamColorById[owner] || PLAYER_COLORS[owner] || '#c8ced8';
    }
    return '#c8ced8';
}

function draw2DDamageFlashOverlay(ctx, target, x, y, radiusOrHalfSize, isRect = false) {
    if (!ctx || !target) return;
    let flash = typeof getDamageFlashState === 'function' ? getDamageFlashState(target) : null;
    if (!flash || flash.alpha <= 0) return;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    if (isRect) {
        let halfSize = Math.max(10, Number(radiusOrHalfSize) || 14);
        ctx.fillStyle = _hexToRgba(flash.color, flash.alpha * 0.55);
        ctx.fillRect(x - halfSize, y - halfSize, halfSize * 2, halfSize * 2);
        ctx.strokeStyle = _hexToRgba(flash.color, Math.min(1, flash.alpha * 1.1));
        ctx.lineWidth = 1.5;
        ctx.strokeRect(x - halfSize - 0.5, y - halfSize - 0.5, halfSize * 2 + 1, halfSize * 2 + 1);
    } else {
        let radius = Math.max(6, Number(radiusOrHalfSize) || 10);
        let grad = ctx.createRadialGradient(x, y, Math.max(1, radius * 0.2), x, y, radius * 1.5);
        grad.addColorStop(0, _hexToRgba(flash.color, flash.alpha * 0.75));
        grad.addColorStop(1, _hexToRgba(flash.color, 0));
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(x, y, radius * 1.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = _hexToRgba(flash.color, flash.alpha * 0.9);
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(x, y, radius * 1.1, 0, Math.PI * 2);
        ctx.stroke();
    }
    ctx.restore();
}

function _getTowerIconSprite(color, angle, type, active) {
    let qIdx = _quantizeTowerAngleIndex(angle);
    let key = (type || '') + '|' + String(color || '') + '|' + (active ? '1' : '0') + '|' + qIdx;
    let cached = TOWER_ICON_SPRITE_CACHE.get(key);
    if (cached) return cached;

    let c = document.createElement('canvas');
    c.width = 32;
    c.height = 32;
    let g = c.getContext('2d');
    let cx = 16, cy = 16;
    let qa = TOWER_ICON_ANGLE_TABLE[qIdx];

    if (type === 'laser') {
        g.fillStyle = '#222'; g.beginPath(); g.arc(cx, cy, 10, 0, 6.28); g.fill();
        g.strokeStyle = '#000'; g.stroke();
        g.fillStyle = active ? '#f00' : '#400'; g.beginPath(); g.arc(cx, cy, 6, 0, 6.28); g.fill();
    } else if (type === 'elements') {
        g.save(); g.translate(cx, cy - 2); g.rotate(qa);
        g.fillStyle = '#f44'; g.fillRect(-6, -6, 3, 12);
        g.fillStyle = '#4f4'; g.fillRect(-3, -6, 3, 12);
        g.fillStyle = '#4af'; g.fillRect(0, -6, 3, 12);
        g.fillStyle = '#afe'; g.fillRect(3, -6, 3, 12);
        g.fillStyle = 'black'; g.fillRect(-6, 2, 12, 4);
        g.restore();
    } else if (type && type.startsWith('cloud')) {
        g.fillStyle = '#000'; g.beginPath(); g.arc(cx, cy - 2, 12, 0, 6.28); g.fill();
        g.fillStyle = color; g.beginPath();
        g.arc(cx - 4, cy + 1, 5, 0, 6.28); g.arc(cx + 4, cy + 1, 5, 0, 6.28); g.arc(cx, cy - 5, 6, 0, 6.28);
        g.fill();
    } else {
        g.fillStyle = '#000'; g.beginPath(); g.arc(cx, cy - 2, 10, 0, 6.28); g.fill();
        g.save(); g.translate(cx, cy - 2); g.rotate(qa);
        g.fillStyle = color; g.fillRect(-6, -6, 12, 12);
        g.fillStyle = 'black'; g.fillRect(0, -2, 12, 4);
        g.restore();
    }

    TOWER_ICON_SPRITE_CACHE.set(key, c);
    _trimSpriteCache(TOWER_ICON_SPRITE_CACHE, TOWER_ICON_SPRITE_CACHE_MAX);
    return c;
}

function drawTowerIcon(ctx, x, y, color, angle, level, type, active) {
    let sprite = _getTowerIconSprite(color, angle, type, active);
    queueDrawImage(ctx, sprite, Math.round(x - 16), Math.round(y - 16));
}

const PROGRESS_BAR_SPRITE_CACHE = new Map();
const PROGRESS_BAR_SPRITE_CACHE_MAX = 4096;
const PROGRESS_BAR_STYLE_ID = new Map();
let _progressBarStyleIdCounter = 1;

function _getProgressBarStyleId(bgColor, fillColor) {
    let styleKey = String(bgColor) + '|' + String(fillColor);
    let id = PROGRESS_BAR_STYLE_ID.get(styleKey);
    if (id) return id;
    id = _progressBarStyleIdCounter++;
    PROGRESS_BAR_STYLE_ID.set(styleKey, id);
    return id;
}

function _getProgressBarSprite(width, height, bgColor, fillColor, pctInt) {
    let w = Math.max(1, Math.floor(width || 1));
    let h = Math.max(1, Math.floor(height || 1));
    let p = Math.max(0, Math.min(100, Math.floor(pctInt || 0)));
    let styleId = _getProgressBarStyleId(bgColor, fillColor);
    let key = styleId + '|' + ((w << 8) | h) + '|' + p;
    let cached = PROGRESS_BAR_SPRITE_CACHE.get(key);
    if (cached) return cached;

    let c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    let g = c.getContext('2d');
    g.fillStyle = bgColor;
    g.fillRect(0, 0, w, h);
    if (p > 0) {
        g.fillStyle = fillColor;
        g.fillRect(0, 0, Math.round((w * p) / 100), h);
    }

    PROGRESS_BAR_SPRITE_CACHE.set(key, c);
    _trimSpriteCache(PROGRESS_BAR_SPRITE_CACHE, PROGRESS_BAR_SPRITE_CACHE_MAX);
    return c;
}

function _drawCachedProgressBar(ctx, centerX, y, width, height, pct, bgColor, fillColor) {
    let w = Math.max(1, Math.floor(width || 1));
    let h = Math.max(1, Math.floor(height || 1));
    let pctInt = Math.round(Math.max(0, Math.min(1, Number(pct) || 0)) * 100);
    let sprite = _getProgressBarSprite(w, h, bgColor, fillColor, pctInt);
    let x = Math.round(centerX - w / 2);
    let py = Math.round(y);
    queueDrawImage(ctx, sprite, x, py);
}

function drawBuildingEnergyProgressBar(ctx, entity, centerX, y, width = 24, height = 3) {
    let maxEnergy = Number(entity && entity.maxEnergy) || 0;
    if (maxEnergy <= 0) return false;
    let energy = Math.max(0, Math.min(Number(entity && entity.energy) || 0, maxEnergy));
    let pct = energy / maxEnergy;
    let isProgress = !!(entity.underConstruction || entity.isUpgrading);
    let manualStacks = Number(entity && entity.manualStacks);
    let stackedStacks = Number(entity && entity.stacks);
    let hasStackQueue = (Number.isFinite(manualStacks) && Number.isFinite(stackedStacks))
        ? (manualStacks > stackedStacks)
        : (!!entity && getThingManualStacks(entity) > getThingStackedStacks(entity));
    if (!isProgress && !hasStackQueue && energy >= maxEnergy) return false;
    if (hasStackQueue) {
        let stackPct = getThingStackingProgressRatio(entity);
        let stackY = y - height;
        _drawCachedProgressBar(ctx, centerX, stackY, width, height, stackPct, '#11291c', '#2fd27f');
    }

    _drawCachedProgressBar(ctx, centerX, y, width, height, pct, isProgress ? '#333' : '#600', isProgress ? '#fa0' : '#0f0');
    return true;
}

const FLOOR_ITEM_SPRITE_CACHE = new Map();
const FLOOR_ITEM_SPRITE_CACHE_MAX = 512;
const GOLD_MINE_TILE_SPRITE_CACHE = new Map();

function _getFloorItemEnergyBucket(item) {
    let maxEnergy = Number(item && item.maxEnergy) || 0;
    if (maxEnergy <= 0) return 20;
    let pct = Math.max(0, Math.min(1, (Number(item.energy) || 0) / maxEnergy));
    return Math.round(pct * 20);
}

function _buildFloorItemSprite(type, bucket) {
    let c = document.createElement('canvas');
    c.width = TILE;
    c.height = TILE;
    let g = c.getContext('2d');
    let x = TILE * 0.5, y = TILE * 0.5;
    if (type === 'sand' || type === 'lava' || type === 'poison_puddle' || type === 'ice_patch' || type === 'water_puddle') {
        let colors = { sand: '#875', lava: '#d22', poison_puddle: '#2d2', ice_patch: '#afe', water_puddle: '#4af' };
        g.fillStyle = colors[type]; g.beginPath(); g.arc(x, y, 12, 0, 6.28); g.fill();
        let alpha = Math.max(0, 1 - (Math.max(0, Math.min(20, bucket)) / 20));
        g.fillStyle = `rgba(0,0,0,${alpha})`; g.beginPath(); g.arc(x, y, 8, 0, 6.28); g.fill();
    } else if (type === 'farm') {
        g.fillStyle = '#da0'; g.beginPath(); g.arc(x, y, 12, 0, 6.28); g.fill();
        g.font = '14px Arial'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillStyle = '#fff'; g.fillText('\uD83C\uDF3E', x, y);
    } else if (type === 'astar_farm') {
        g.fillStyle = '#888'; g.beginPath(); g.arc(x, y, 12, 0, 6.28); g.fill();
        g.font = '14px Arial'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillStyle = '#fff'; g.fillText('\u2605', x, y);
    } else if (type === 'house') {
        g.fillStyle = '#c95';
        g.fillRect(x - 10, y - 6, 20, 14);
        g.fillStyle = '#844';
        g.beginPath();
        g.moveTo(x - 12, y - 6);
        g.lineTo(x, y - 14);
        g.lineTo(x + 12, y - 6);
        g.closePath();
        g.fill();
        g.fillStyle = '#222';
        g.fillRect(x - 2, y + 1, 4, 7);
    } else if (type === 'mine') {
        g.fillStyle = '#444'; g.beginPath(); g.arc(x, y, 8, 0, 6.28); g.fill();
        g.fillStyle = '#f00'; g.beginPath(); g.arc(x, y, 3, 0, 6.28); g.fill();
    }
    return c;
}

function _getFloorItemSprite(item) {
    if (!item || !item.type) return null;
    let bucket = _getFloorItemEnergyBucket(item);
    let dynamic = (item.type === 'sand' || item.type === 'lava' || item.type === 'poison_puddle' || item.type === 'ice_patch' || item.type === 'water_puddle');
    let key = dynamic ? `${item.type}|${bucket}` : `${item.type}|base`;
    let cached = FLOOR_ITEM_SPRITE_CACHE.get(key);
    if (cached) return cached;
    cached = _buildFloorItemSprite(item.type, bucket);
    FLOOR_ITEM_SPRITE_CACHE.set(key, cached);
    _trimSpriteCache(FLOOR_ITEM_SPRITE_CACHE, FLOOR_ITEM_SPRITE_CACHE_MAX);
    return cached;
}

function drawFloorItem(ctx, cell, px, py) {
    let item = cell.item;
    if (!item || item.draw) return;
    let x = px + 16, y = py + 16;
    // Owner border
    if (cell.owner >= 0) {
        ctx.strokeStyle = PLAYER_COLORS_DIM[cell.owner]; ctx.lineWidth = 1;
        ctx.strokeRect(px + 1, py + 1, TILE - 2, TILE - 2);
    }
    let floorSprite = _getFloorItemSprite(item);
    if (floorSprite) queueDrawImage(ctx, floorSprite, px, py, TILE, TILE);
    if (item.underConstruction) {
        ctx.fillStyle = 'rgba(0,0,0,0.5)'; ctx.fillRect(px + 2, py + 2, TILE - 4, TILE - 4);
    } else if (item.isUpgrading) {
        ctx.fillStyle = 'rgba(0,0,0,0.3)'; ctx.fillRect(px + 2, py + 2, TILE - 4, TILE - 4);
    }
    drawBuildingEnergyProgressBar(ctx, item, x, y + 2, TILE - 8, 3);
    if (item.textCanvas && shouldShowBuildingLevels()) drawLevelTextCache(ctx, item, x, y);
}

function _getGoldMineTileSprite(isActive) {
    let key = isActive ? 'active' : 'depleted';
    let cached = GOLD_MINE_TILE_SPRITE_CACHE.get(key);
    if (cached) return cached;

    let c = document.createElement('canvas');
    c.width = TILE;
    c.height = TILE;
    let g = c.getContext('2d');
    g.clearRect(0, 0, TILE, TILE);
    if (isActive) {
        g.fillStyle = '#fd0';
        g.fillRect(2, 2, TILE - 4, TILE - 4);
    } else {
        g.globalAlpha = 0.28;
        g.fillStyle = '#9a9000';
        g.fillRect(2, 2, TILE - 4, TILE - 4);
        g.globalAlpha = 1;
    }

    GOLD_MINE_TILE_SPRITE_CACHE.set(key, c);
    return c;
}

function _getAstarMineTileSprite(isActive) {
    let key = isActive ? 'astar_active' : 'astar_depleted';
    let cached = GOLD_MINE_TILE_SPRITE_CACHE.get(key);
    if (cached) return cached;

    let c = document.createElement('canvas');
    c.width = TILE;
    c.height = TILE;
    let g = c.getContext('2d');
    g.imageSmoothingEnabled = false;
    g.clearRect(0, 0, TILE, TILE);
    g.fillStyle = isActive ? '#8a8a8a' : '#555';
    g.fillRect(2, 2, TILE - 4, TILE - 4);
    g.fillStyle = isActive ? '#f0f0f0' : '#999';
    g.strokeStyle = isActive ? '#2a2a2a' : '#444';
    g.lineWidth = 1.25;
    g.beginPath();
    for (let i = 0; i < 5; i++) {
        let a = (i * 4 * Math.PI) / 5 - Math.PI / 2;
        let px = TILE * 0.5 + Math.cos(a) * 8;
        let py = TILE * 0.5 + Math.sin(a) * 8;
        if (i === 0) g.moveTo(px, py);
        else g.lineTo(px, py);
    }
    g.closePath();
    g.fill();
    g.stroke();

    GOLD_MINE_TILE_SPRITE_CACHE.set(key, c);
    return c;
}

// Thumbnail cache for build menu and sub-group icons
let _thumbCache = {};
let _thumbImageCache = {};
function getItemThumbnail(key, size) {
    let cacheKey = key + '_' + size;
    if (_thumbCache[cacheKey]) return _thumbCache[cacheKey];
    let dpr = window.devicePixelRatio || 1;
    let c = document.createElement('canvas');
    c.width = size * dpr; c.height = size * dpr;
    c.style.width = size + 'px'; c.style.height = size + 'px';
    let ctx = c.getContext('2d');
    ctx.scale(dpr, dpr);
    let cx = size / 2, cy = size / 2;
    let s = size / 32; // scale factor relative to 32px tile

    let def = BASE_CARD_TYPES[key];
    let us = BASE_UNIT_STATS[key]; // for unit types

    if (key === 'area_upgrader') {
        ctx.fillStyle = '#fd0'; ctx.beginPath(); ctx.arc(cx, cy, 10 * s, 0, 6.28); ctx.fill();
        ctx.fillStyle = '#000';
        ctx.beginPath(); ctx.moveTo(cx, cy - 7 * s); ctx.lineTo(cx - 5 * s, cy + 3 * s); ctx.lineTo(cx + 5 * s, cy + 3 * s); ctx.closePath(); ctx.fill();
    } else if (key === 'goldmine') {
        ctx.fillStyle = '#fd0'; ctx.fillRect(cx - 10 * s, cy - 10 * s, 20 * s, 20 * s);
        ctx.fillStyle = '#a80'; ctx.fillRect(cx - 6 * s, cy - 6 * s, 12 * s, 12 * s);
    } else if (def && def.target === 'wall' && def.isCloud) {
        // Cloud tower
        ctx.fillStyle = '#000'; ctx.beginPath(); ctx.arc(cx, cy - 1 * s, 12 * s, 0, 6.28); ctx.fill();
        ctx.fillStyle = def.color; ctx.beginPath();
        ctx.arc(cx - 4 * s, cy + 1 * s, 5 * s, 0, 6.28); ctx.arc(cx + 4 * s, cy + 1 * s, 5 * s, 0, 6.28); ctx.arc(cx, cy - 5 * s, 6 * s, 0, 6.28);
        ctx.fill();
    } else if (def && def.target === 'wall' && def.towerEnergy) {
        // Tower
        let type = key;
        if (type === 'laser') {
            ctx.fillStyle = '#222'; ctx.beginPath(); ctx.arc(cx, cy, 10 * s, 0, 6.28); ctx.fill();
            ctx.strokeStyle = '#000'; ctx.lineWidth = 1; ctx.stroke();
            ctx.fillStyle = '#f00'; ctx.beginPath(); ctx.arc(cx, cy, 6 * s, 0, 6.28); ctx.fill();
        } else if (type === 'elements') {
            ctx.fillStyle = "#f44"; ctx.fillRect(cx - 6 * s, cy - 6 * s, 3 * s, 12 * s);
            ctx.fillStyle = "#4f4"; ctx.fillRect(cx - 3 * s, cy - 6 * s, 3 * s, 12 * s);
            ctx.fillStyle = "#4af"; ctx.fillRect(cx, cy - 6 * s, 3 * s, 12 * s);
            ctx.fillStyle = "#afe"; ctx.fillRect(cx + 3 * s, cy - 6 * s, 3 * s, 12 * s);
            ctx.fillStyle = 'black'; ctx.fillRect(cx - 6 * s, cy + 2 * s, 12 * s, 4 * s);
        } else {
            ctx.fillStyle = '#000'; ctx.beginPath(); ctx.arc(cx, cy, 10 * s, 0, 6.28); ctx.fill();
            ctx.fillStyle = def.color; ctx.fillRect(cx - 6 * s, cy - 6 * s, 12 * s, 12 * s);
            ctx.fillStyle = 'black'; ctx.fillRect(cx, cy - 2 * s, 12 * s, 4 * s);
        }
    } else if (def && def.unitType) {
        // Barrack
        let unitColor = (BASE_UNIT_STATS[def.unitType] || {}).color || '#fff';
        ctx.fillStyle = '#664'; ctx.beginPath();
        ctx.moveTo(cx - 12 * s, cy - 6 * s); ctx.lineTo(cx + 12 * s, cy - 6 * s); ctx.lineTo(cx, cy - 14 * s);
        ctx.fill();
        ctx.fillStyle = unitColor; ctx.beginPath(); ctx.arc(cx, cy + 4 * s, 5 * s, 0, 6.28); ctx.fill();
    } else if (key === 'spawner') {
        ctx.strokeStyle = PLAYER_COLORS[0] || '#4488ff';
        ctx.lineWidth = Math.max(1, s);
        ctx.strokeRect(cx - 14 * s, cy - 14 * s, 28 * s, 28 * s);
        ctx.fillStyle = '#432';
        ctx.fillRect(cx - 12 * s, cy - 12 * s, 24 * s, 24 * s);
        ctx.fillStyle = '#f3d55b';
        ctx.fillRect(cx - 7 * s, cy - 5 * s, 14 * s, 10 * s);
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = Math.max(1, s * 0.9);
        ctx.strokeRect(cx - 7 * s, cy - 5 * s, 14 * s, 10 * s);
        ctx.fillStyle = '#111';
        ctx.font = `${Math.max(8, Math.round(11 * s))}px Arial`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('\u26A1', cx, cy + 1 * s);
    } else if (key === 'astar_spawner') {
        ctx.fillStyle = '#555'; ctx.fillRect(cx - 12 * s, cy - 12 * s, 24 * s, 24 * s);
        ctx.fillStyle = '#f0f0f0';
        ctx.font = `${Math.max(11, Math.round(14 * s))}px Arial`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('★', cx, cy + 1 * s);
    } else if (key === 'salvager') {
        ctx.fillStyle = '#543'; ctx.fillRect(cx - 12 * s, cy - 12 * s, 24 * s, 24 * s);
        ctx.fillStyle = '#8d8'; ctx.beginPath();
        for (let i = 0; i < 3; i++) { let a = (i * 2 * Math.PI) / 3 - Math.PI / 2; ctx.lineTo(cx + Math.cos(a) * 8 * s, cy + Math.sin(a) * 8 * s); }
        ctx.closePath(); ctx.fill();
    } else if (key === 'builder_spawner') {
        ctx.fillStyle = '#354'; ctx.fillRect(cx - 12 * s, cy - 12 * s, 24 * s, 24 * s);
        ctx.fillStyle = '#8b5'; ctx.fillRect(cx - 7 * s, cy - 5 * s, 14 * s, 10 * s);
        ctx.strokeStyle = '#fff'; ctx.lineWidth = 1; ctx.strokeRect(cx - 7 * s, cy - 5 * s, 14 * s, 10 * s);
    } else if (key === 'healer_spawner') {
        ctx.fillStyle = '#355'; ctx.fillRect(cx - 12 * s, cy - 12 * s, 24 * s, 24 * s);
        ctx.fillStyle = '#fff'; ctx.fillRect(cx - 7 * s, cy - 5 * s, 14 * s, 10 * s);
        ctx.strokeStyle = '#ddd'; ctx.lineWidth = 1; ctx.strokeRect(cx - 7 * s, cy - 5 * s, 14 * s, 10 * s);
    } else if (key === 'research') {
        // Match play-area look: team border, blue tile, and centered R.
        ctx.strokeStyle = PLAYER_COLORS[0] || '#4488ff';
        ctx.lineWidth = Math.max(1, s);
        ctx.strokeRect(cx - 14 * s, cy - 14 * s, 28 * s, 28 * s);
        ctx.fillStyle = '#446';
        ctx.fillRect(cx - 12 * s, cy - 12 * s, 24 * s, 24 * s);
        ctx.fillStyle = '#aef';
        ctx.font = `${Math.max(9, Math.round(11 * s))}px Arial`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('R', cx, cy + 1 * s);
    } else if (def && def.target === 'floor') {
        // Floor items
        let floorColors = { sand: '#875', lava: '#d22', poison_puddle: '#2d2', ice_patch: '#afe', water_puddle: '#4af' };
        if (floorColors[key]) {
            ctx.fillStyle = floorColors[key]; ctx.beginPath(); ctx.arc(cx, cy, 12 * s, 0, 6.28); ctx.fill();
        } else if (key === 'farm') {
            ctx.fillStyle = '#da0'; ctx.beginPath(); ctx.arc(cx, cy, 12 * s, 0, 6.28); ctx.fill();
            ctx.font = Math.round(14 * s) + "px Arial"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
            ctx.fillStyle = "#fff"; ctx.fillText("\uD83C\uDF3E", cx, cy);
        } else if (key === 'astar_farm') {
            ctx.fillStyle = '#888'; ctx.beginPath(); ctx.arc(cx, cy, 12 * s, 0, 6.28); ctx.fill();
            ctx.font = Math.round(14 * s) + "px Arial"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
            ctx.fillStyle = "#fff"; ctx.fillText("\u2605", cx, cy);
        } else if (key === 'house') {
            ctx.fillStyle = '#c95'; ctx.fillRect(cx - 10 * s, cy - 6 * s, 20 * s, 14 * s);
            ctx.fillStyle = '#844';
            ctx.beginPath();
            ctx.moveTo(cx - 12 * s, cy - 6 * s);
            ctx.lineTo(cx, cy - 14 * s);
            ctx.lineTo(cx + 12 * s, cy - 6 * s);
            ctx.closePath();
            ctx.fill();
            ctx.fillStyle = '#222';
            ctx.fillRect(cx - 2 * s, cy + 1 * s, 4 * s, 7 * s);
        } else if (key === 'mine') {
            ctx.fillStyle = '#444'; ctx.beginPath(); ctx.arc(cx, cy, 8 * s, 0, 6.28); ctx.fill();
            ctx.fillStyle = '#f00'; ctx.beginPath(); ctx.arc(cx, cy, 3 * s, 0, 6.28); ctx.fill();
        }
    } else if (us) {
        // Unit type
        let r = (us.r || 8) * s;
        if (us.vis === 'snake') {
            ctx.lineCap = 'round'; ctx.lineWidth = r * 2;
            ctx.strokeStyle = us.color; ctx.beginPath();
            ctx.moveTo(cx, cy); ctx.lineTo(cx - 6 * s, cy + 4 * s); ctx.lineTo(cx - 10 * s, cy); ctx.stroke();
            ctx.fillStyle = us.color; ctx.beginPath(); ctx.arc(cx, cy, r + 2 * s, 0, 6.28); ctx.fill();
            ctx.fillStyle = "black";
            ctx.beginPath(); ctx.arc(cx - 2 * s, cy - 2 * s, 2 * s, 0, 6.28); ctx.fill();
            ctx.beginPath(); ctx.arc(cx + 2 * s, cy - 2 * s, 2 * s, 0, 6.28); ctx.fill();
        } else if (us.vis === 'triangle') {
            let tr = r * 0.5;
            ctx.fillStyle = us.color; ctx.beginPath();
            ctx.moveTo(cx, cy + tr); ctx.lineTo(cx - tr, cy - tr); ctx.lineTo(cx + tr, cy - tr);
            ctx.closePath(); ctx.fill(); ctx.strokeStyle = '#000'; ctx.lineWidth = 1; ctx.stroke();
        } else if (us.vis === 'star') {
            ctx.fillStyle = us.color; ctx.beginPath();
            for (let i = 0; i < 5; i++) { let a = (i * 4 * Math.PI) / 5 - Math.PI / 2; ctx.lineTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r); }
            ctx.closePath(); ctx.fill(); ctx.strokeStyle = '#000'; ctx.lineWidth = 1; ctx.stroke();
        } else if (us.vis === 'triangle_down') {
            ctx.fillStyle = us.color; ctx.beginPath();
            let tr = r;
            ctx.moveTo(cx, cy + tr); ctx.lineTo(cx - tr, cy - tr * 0.5); ctx.lineTo(cx + tr, cy - tr * 0.5);
            ctx.closePath(); ctx.fill(); ctx.strokeStyle = '#000'; ctx.lineWidth = 1; ctx.stroke();
        } else if (us.vis === 'rect') {
            ctx.fillStyle = us.color; ctx.fillRect(cx - r, cy - r * 0.7, r * 2, r * 1.4);
            ctx.strokeStyle = '#000'; ctx.lineWidth = 1; ctx.strokeRect(cx - r, cy - r * 0.7, r * 2, r * 1.4);
            if (key === 'researcher_unit') {
                ctx.fillStyle = '#5af';
                ctx.fillRect(cx - r * 0.3, cy - r * 0.35, r * 0.6, r * 0.7);
                ctx.strokeStyle = '#93f';
                ctx.lineWidth = 1;
                ctx.strokeRect(cx - r * 0.3, cy - r * 0.35, r * 0.6, r * 0.7);
            }
        } else if (us.vis === 'mole') {
            ctx.fillStyle = us.color; ctx.beginPath();
            ctx.ellipse(cx, cy, r * 0.8, r * 1.1, 0, 0, Math.PI * 2);
            ctx.fill(); ctx.strokeStyle = '#000'; ctx.lineWidth = 1; ctx.stroke();
        } else if (us.vis === 'king') {
            ctx.fillStyle = us.color; ctx.beginPath();
            ctx.moveTo(cx - r, cy + r * 0.4);
            ctx.lineTo(cx - r, cy - r * 0.2);
            ctx.lineTo(cx - r * 0.5, cy + r * 0.1);
            ctx.lineTo(cx, cy - r * 0.7);
            ctx.lineTo(cx + r * 0.5, cy + r * 0.1);
            ctx.lineTo(cx + r, cy - r * 0.2);
            ctx.lineTo(cx + r, cy + r * 0.4);
            ctx.closePath(); ctx.fill();
            ctx.strokeStyle = '#000'; ctx.lineWidth = 1; ctx.stroke();
        } else {
            ctx.fillStyle = us.color; ctx.beginPath(); ctx.arc(cx, cy, r, 0, 6.28); ctx.fill();
            ctx.strokeStyle = '#000'; ctx.lineWidth = 1; ctx.stroke();
        }
    }

    _thumbCache[cacheKey] = c.toDataURL();
    return _thumbCache[cacheKey];
}

function getItemThumbnailImage(key, size) {
    let cacheKey = key + '_' + size;
    if (_thumbImageCache[cacheKey]) return _thumbImageCache[cacheKey];
    let img = new Image();
    img.src = getItemThumbnail(key, size);
    _thumbImageCache[cacheKey] = img;
    return img;
}

function getBuildPreviewLevelFromMultiplier() {
    let stacks = Math.max(1, Math.floor(buildPurchaseMultiplier || 1));
    return stackCountToLevel(stacks);
}

function getTowerPreviewVisionRange(type, level) {
    let vr = getBuildingStatForOwner(localPlayerId, type, level, 'visionRange');
    if (!Number.isFinite(vr)) return 0;
    return vr;
}

function drawBuildPlacementGhost(ctx, gx, gy, key, canBuild, previewLevel) {
    let img = getItemThumbnailImage(key, 30);
    if (img && img.complete && img.naturalWidth > 0) {
        ctx.save();
        ctx.globalAlpha = canBuild ? 0.78 : 0.62;
        queueDrawImage(ctx, img, gx * TILE + 1, gy * TILE + 1, TILE - 2, TILE - 2);
        ctx.restore();
    }

    let def = BASE_CARD_TYPES[key];
    if (renderRangeMode !== RENDER_RANGE_NONE && def && def.target === 'wall' && def.towerEnergy && !def.isCloud) {
        let rrTiles = getTowerPreviewVisionRange(key, previewLevel);
        if (rrTiles > 0) {
            ctx.save();
            ctx.lineWidth = 1.4;
            ctx.strokeStyle = canBuild ? 'rgba(80,255,80,0.45)' : 'rgba(255,90,90,0.45)';
            ctx.beginPath();
            ctx.arc(gx * TILE + TILE / 2, gy * TILE + TILE / 2, rrTiles * TILE, 0, Math.PI * 2);
            ctx.stroke();
            ctx.restore();
        }
    }
}

function getCurrentBuildPreviewData() {
    if (!selectedBuildItem) return null;
    let gx = Math.floor(mouseWorldX / TILE), gy = Math.floor(mouseWorldY / TILE);
    if (gx < 0 || gx >= GRID_W || gy < 0 || gy >= GRID_H) return null;

    let previewLevel = getBuildPreviewLevelFromMultiplier();
    let preview = {
        key: selectedBuildItem,
        gx,
        gy,
        canBuild: false,
        previewLevel,
        image: getItemThumbnailImage(selectedBuildItem, 30),
        rangeRadiusTiles: 0,
        areaCells: null,
        filledCount: 0,
        areaCellCount: 0,
        areaMultiplierLevel: 0,
        areaUpgradeCost: 0,
        areaCenterX: gx + 0.5,
        areaCenterY: gy + 0.5,
    };

    if (selectedBuildItem === 'area_upgrader') {
        let aId = grid[gy][gx].areaId;
        let area = getAreaById(aId);
        if (!area) return preview;
        let filledCount = 0;
        let cells = [];
        for (let cp of area.cells) {
            let c = grid[cp.y][cp.x];
            let occupied = false;
            if (c.type === TYPE_WALL && getTowerAtTile(cp.x, cp.y)) occupied = true;
            else if (c.item) occupied = true;
            else if (getBarrackAtTile(cp.x, cp.y)) occupied = true;
            else if (getSpawnerAtTile(cp.x, cp.y)) occupied = true;
            if (occupied) filledCount++;
            cells.push({ x: cp.x, y: cp.y, occupied });
        }
        preview.areaCells = cells;
        preview.filledCount = filledCount;
        preview.areaCellCount = area.cells.length;
        preview.areaMultiplierLevel = area.multiplierLevel || 0;
        preview.areaUpgradeCost = getAreaUpgradeCost(preview.areaMultiplierLevel);
        preview.areaCenterX = area.cells.reduce((sum, cell) => sum + cell.x + 0.5, 0) / Math.max(1, area.cells.length);
        preview.areaCenterY = area.cells.reduce((sum, cell) => sum + cell.y + 0.5, 0) / Math.max(1, area.cells.length);
        preview.canBuild = filledCount === area.cells.length && preview.areaMultiplierLevel < 5;
    } else {
        preview.canBuild = isTileVisible(gx, gy) && (canBuildAt(gx, gy, localPlayerId) || canStackAt(gx, gy, selectedBuildItem, localPlayerId));
    }

    let def = BASE_CARD_TYPES[selectedBuildItem];
    if (renderRangeMode !== RENDER_RANGE_NONE && def && def.target === 'wall' && def.towerEnergy && !def.isCloud) {
        preview.rangeRadiusTiles = getTowerPreviewVisionRange(selectedBuildItem, previewLevel);
    }
    return preview;
}

// ============================================================
// RENDER
// ============================================================
// Pre-compute area color lookup (rebuilt when dirtyAreas)
let _areaById = [];
let _areaColorCache = null; // Array: [areaId] -> color string
let _areaOutlinePathCache = null; // Array: [areaId] -> Path2D
let _combinedBgCanvas = null; // Full world background (grid + area outlines)
let _combinedBgCtx = null;
let _combinedTerrainCanvas = null; // Base terrain only (floor/walls)
let _combinedTerrainCtx = null;
let _combinedTerrainDirty = true;
let _combinedTerrainDirtyFull = true;
let _combinedTerrainDirtyBounds = null; // {minGx,minGy,maxGx,maxGy}
let _minimapStaticCanvas = null;
let _minimapStaticCtx = null;
let _minimapStaticDirty = true;
let _minimapStaticScale = 0;
let _minimapStaticTilePx = 0;
let _staticCacheNeedsCommit = true;
let _staticCacheCommitVersion = -1;
let _staticLayerCache = {
    valid: false,
    cameraX: 0,
    cameraY: 0,
    zoom: 1,
    viewW: 0,
    viewH: 0,
    dpr: 1,
    minGx: 0,
    minGy: 0,
    maxGx: 0,
    maxGy: 0,
    fullVisibility: false,
    visibilityVersion: -1,
    staticCommitVersion: -1
};
const _visibilityFogMinAlpha = 0.01;
const _visibilityFogGamma = 1.8;

function invalidateStaticLayerCache() {
    _staticLayerCache.valid = false;
}

function getAreaById(areaId) {
    if (!Number.isFinite(areaId) || areaId < 0 || areaId >= _areaById.length) return null;
    return _areaById[areaId] || null;
}

function _requestStaticCacheCommit() {
    _staticCacheNeedsCommit = true;
}

function _clampTileRect(minGx, minGy, maxGx, maxGy) {
    minGx = Math.max(0, Math.min(GRID_W - 1, Math.floor(minGx)));
    minGy = Math.max(0, Math.min(GRID_H - 1, Math.floor(minGy)));
    maxGx = Math.max(0, Math.min(GRID_W - 1, Math.floor(maxGx)));
    maxGy = Math.max(0, Math.min(GRID_H - 1, Math.floor(maxGy)));
    if (maxGx < minGx || maxGy < minGy) return null;
    return { minGx, minGy, maxGx, maxGy };
}

function _markCombinedTerrainFullDirty() {
    _combinedTerrainDirty = true;
    _combinedTerrainDirtyFull = true;
    _combinedTerrainDirtyBounds = null;
}

function _markCombinedTerrainRectDirty(minGx, minGy, maxGx, maxGy) {
    // Pad by one tile so neighboring wall borders/outlines stay coherent.
    let rect = _clampTileRect(minGx - 1, minGy - 1, maxGx + 1, maxGy + 1);
    if (!rect) return;
    _combinedTerrainDirty = true;
    if (_combinedTerrainDirtyFull) return;
    if (_combinedTerrainDirtyBounds) {
        _combinedTerrainDirtyBounds.minGx = Math.min(_combinedTerrainDirtyBounds.minGx, rect.minGx);
        _combinedTerrainDirtyBounds.minGy = Math.min(_combinedTerrainDirtyBounds.minGy, rect.minGy);
        _combinedTerrainDirtyBounds.maxGx = Math.max(_combinedTerrainDirtyBounds.maxGx, rect.maxGx);
        _combinedTerrainDirtyBounds.maxGy = Math.max(_combinedTerrainDirtyBounds.maxGy, rect.maxGy);
    } else {
        _combinedTerrainDirtyBounds = rect;
    }
}

function _hasPendingStaticCacheDirty() {
    return !!(
        _staticCacheNeedsCommit ||
        _combinedBgDirtyFull ||
        _combinedBgDirtyBounds ||
        _combinedTerrainDirty ||
        _minimapStaticDirty ||
        dirtyGrid ||
        dirtyAreas
    );
}

// scope: 'all' | 'background' | 'minimap'
function commitStaticCaches(force = false, scope = 'all') {
    let wantsBackground = scope === 'all' || scope === 'background';
    let wantsMinimap = scope === 'all' || scope === 'minimap';

    let hasBackgroundDirty =
        !!_combinedBgDirtyFull ||
        !!_combinedBgDirtyBounds ||
        !!_combinedTerrainDirty ||
        !!dirtyGrid ||
        !!dirtyAreas ||
        !_combinedBgCanvas ||
        !_combinedBgCtx;
    let hasMinimapDirty =
        !!_minimapStaticDirty ||
        !_minimapStaticCanvas;

    let shouldCommitBackground = wantsBackground && (force || hasBackgroundDirty);
    let shouldCommitMinimap = wantsMinimap && (force || hasMinimapDirty);
    if (!shouldCommitBackground && !shouldCommitMinimap) return;
    let didRebuild = false;

    if (shouldCommitBackground) {
        rebuildCombinedBackgroundCache();
        didRebuild = true;
    }

    if (shouldCommitMinimap) {
        let scale = MINIMAP_SIZE / GRID_W;
        let tilePx = Math.max(1, scale);
        if (_minimapStaticDirty || !_minimapStaticCanvas || _minimapStaticScale !== scale || _minimapStaticTilePx !== tilePx) {
            rebuildMinimapStaticLayer(scale, tilePx);
            didRebuild = true;
        }
    }

    _staticCacheNeedsCommit = _hasPendingStaticCacheDirty();
    if (didRebuild) _staticCacheCommitVersion++;
}

function _markCombinedBgFullDirty() {
    _combinedBgDirtyFull = true;
    _combinedBgDirtyBounds = null;
    _markCombinedTerrainFullDirty();
    _minimapStaticDirty = true;
    dirtyGrid = true;
    dirtyAreas = true;
    _requestStaticCacheCommit();
}

function _markCombinedBgRectDirty(minGx, minGy, maxGx, maxGy, markAreas = false, terrainChanged = false) {
    let rect = _clampTileRect(minGx, minGy, maxGx, maxGy);
    if (!rect) return;
    minGx = rect.minGx;
    minGy = rect.minGy;
    maxGx = rect.maxGx;
    maxGy = rect.maxGy;

    if (!_combinedBgDirtyFull) {
        if (_combinedBgDirtyBounds) {
            _combinedBgDirtyBounds.minGx = Math.min(_combinedBgDirtyBounds.minGx, minGx);
            _combinedBgDirtyBounds.minGy = Math.min(_combinedBgDirtyBounds.minGy, minGy);
            _combinedBgDirtyBounds.maxGx = Math.max(_combinedBgDirtyBounds.maxGx, maxGx);
            _combinedBgDirtyBounds.maxGy = Math.max(_combinedBgDirtyBounds.maxGy, maxGy);
        } else {
            _combinedBgDirtyBounds = { minGx, minGy, maxGx, maxGy };
        }
    }

    if (terrainChanged) _markCombinedTerrainRectDirty(minGx, minGy, maxGx, maxGy);
    _minimapStaticDirty = true;
    dirtyGrid = true;
    if (markAreas) dirtyAreas = true;
    _requestStaticCacheCommit();
}

function _markCombinedBgTileDirty(gx, gy, pad = 0, terrainChanged = false) {
    _markCombinedBgRectDirty(gx - pad, gy - pad, gx + pad, gy + pad, false, terrainChanged);
}

function _markCombinedBgAreaDirty(areaId, pad = 1) {
    let area = getAreaById(areaId);
    if (!area || !area.cells || area.cells.length <= 0) return;

    _markCombinedBgRectDirty(area.minGx - pad, area.minGy - pad, area.maxGx + pad, area.maxGy + pad, true);
}

function _areaIntersectsTileRect(area, minGx, minGy, maxGx, maxGy) {
    if (!area) return false;
    return area.maxGx >= minGx && area.minGx <= maxGx && area.maxGy >= minGy && area.minGy <= maxGy;
}

function _drawCombinedBackgroundRegion(c, minGx, minGy, maxGx, maxGy, redrawAreaOutlines) {
    let startX = minGx * TILE;
    let startY = minGy * TILE;
    let width = (maxGx - minGx + 1) * TILE;
    let height = (maxGy - minGy + 1) * TILE;

    c.clearRect(startX, startY, width, height);
    if (_combinedTerrainDirty || !_combinedTerrainCanvas || !_combinedTerrainCtx) {
        rebuildCombinedTerrainCache();
    }
    c.drawImage(_combinedTerrainCanvas, startX, startY, width, height, startX, startY, width, height);

    if (redrawAreaOutlines && _areaOutlinePathCache && _areaColorCache) {
        c.save();
        c.beginPath();
        c.rect(startX, startY, width, height);
        c.clip();
        c.lineWidth = 2;
        for (let area of areas) {
            if (!_areaIntersectsTileRect(area, minGx, minGy, maxGx, maxGy)) continue;
            let path = _areaOutlinePathCache[area.id];
            if (!path) continue;
            c.strokeStyle = _areaColorCache[area.id];
            c.stroke(path);
        }
        c.restore();
    }
}

function ensureVisibilityMaskCanvas() {
    if (!_visibilityMaskCanvas || _visibilityMaskCanvas.width !== WORLD_W || _visibilityMaskCanvas.height !== WORLD_H) {
        _visibilityMaskCanvas = document.createElement('canvas');
        _visibilityMaskCanvas.width = WORLD_W;
        _visibilityMaskCanvas.height = WORLD_H;
        _visibilityMaskCtx = _visibilityMaskCanvas.getContext('2d');
        _visibilityMaskVersion = -1;
        _visibilityMaskFullVisibility = false;
    }
    if (!_visibilityMaskGridCanvas || _visibilityMaskGridCanvas.width !== GRID_W || _visibilityMaskGridCanvas.height !== GRID_H) {
        _visibilityMaskGridCanvas = document.createElement('canvas');
        _visibilityMaskGridCanvas.width = GRID_W;
        _visibilityMaskGridCanvas.height = GRID_H;
        _visibilityMaskGridCtx = _visibilityMaskGridCanvas.getContext('2d', { willReadFrequently: false });
        _visibilityMaskVersion = -1;
        _visibilityMaskFullVisibility = false;
    }
}

function rebuildVisibilityMaskCacheIfNeeded() {
    ensureVisibilityMaskCanvas();
    if (!_visibilityMaskCtx || !_visibilityMaskGridCtx) return;

    if (fullVisibility) {
        _visibilityMaskVersion = visibilityVersion;
        _visibilityMaskFullVisibility = true;
        _visibilityMaskCtx.clearRect(0, 0, WORLD_W, WORLD_H);
        return;
    }
    if (_visibilityMaskVersion === visibilityVersion && !_visibilityMaskFullVisibility) return;

    let invNorm = 1 / Math.max(0.0001, Number(VISIBILITY_LIGHT_NORMALIZATION_RANGE) || 6);
    let imageData = _visibilityMaskGridCtx.createImageData(GRID_W, GRID_H);
    let data = imageData.data;
    let i = 0;
    for (let y = 0; y < GRID_H; y++) {
        let row = visibilityGrid[y];
        for (let x = 0; x < GRID_W; x++) {
            let raw = row ? (row[x] || 0) : 0;
            let lightLevel = Math.max(0, Math.min(1, raw * invNorm));
            let fogAlpha = Math.pow(1 - lightLevel, _visibilityFogGamma);
            let alpha = fogAlpha <= _visibilityFogMinAlpha ? 0 : Math.round(Math.max(0, Math.min(1, fogAlpha)) * 255);
            data[i++] = 10;
            data[i++] = 10;
            data[i++] = 10;
            data[i++] = alpha;
        }
    }
    _visibilityMaskGridCtx.putImageData(imageData, 0, 0);

    _visibilityMaskCtx.clearRect(0, 0, WORLD_W, WORLD_H);
    _visibilityMaskCtx.save();
    _visibilityMaskCtx.imageSmoothingEnabled = true;
    _visibilityMaskCtx.drawImage(_visibilityMaskGridCanvas, 0, 0, GRID_W, GRID_H, 0, 0, WORLD_W, WORLD_H);
    _visibilityMaskCtx.restore();
    _visibilityMaskVersion = visibilityVersion;
    _visibilityMaskFullVisibility = false;
}

function ensureCombinedBgCanvas() {
    if (!_combinedBgCanvas || _combinedBgCanvas.width !== WORLD_W || _combinedBgCanvas.height !== WORLD_H) {
        _combinedBgCanvas = document.createElement('canvas');
        _combinedBgCanvas.width = WORLD_W;
        _combinedBgCanvas.height = WORLD_H;
        _combinedBgCtx = _combinedBgCanvas.getContext('2d');
        _combinedBgCtx.imageSmoothingEnabled = false;
        _areaColorCache = null;
        _areaOutlinePathCache = null;
        _markCombinedTerrainFullDirty();
        _markCombinedBgFullDirty();
        invalidateStaticLayerCache();
    }
}

function ensureCombinedTerrainCanvas() {
    if (!_combinedTerrainCanvas || _combinedTerrainCanvas.width !== WORLD_W || _combinedTerrainCanvas.height !== WORLD_H) {
        _combinedTerrainCanvas = document.createElement('canvas');
        _combinedTerrainCanvas.width = WORLD_W;
        _combinedTerrainCanvas.height = WORLD_H;
        _combinedTerrainCtx = _combinedTerrainCanvas.getContext('2d');
        _combinedTerrainCtx.imageSmoothingEnabled = false;
        _markCombinedTerrainFullDirty();
    }
}

function rebuildCombinedTerrainCache() {
    ensureCombinedTerrainCanvas();
    let c = _combinedTerrainCtx;
    let rect = _combinedTerrainDirtyFull
        ? { minGx: 0, minGy: 0, maxGx: GRID_W - 1, maxGy: GRID_H - 1 }
        : (_combinedTerrainDirtyBounds || null);
    if (!rect) {
        _combinedTerrainDirty = false;
        return;
    }

    let startX = rect.minGx * TILE;
    let startY = rect.minGy * TILE;
    let width = (rect.maxGx - rect.minGx + 1) * TILE;
    let height = (rect.maxGy - rect.minGy + 1) * TILE;
    c.clearRect(startX, startY, width, height);

    c.fillStyle = C_FLOOR;
    for (let y = rect.minGy; y <= rect.maxGy; y++) {
        for (let x = rect.minGx; x <= rect.maxGx; x++) {
            if (grid[y][x].type !== TYPE_WALL) c.fillRect(x * TILE, y * TILE, TILE, TILE);
        }
    }

    c.fillStyle = '#222';
    for (let y = rect.minGy; y <= rect.maxGy; y++) {
        for (let x = rect.minGx; x <= rect.maxGx; x++) {
            if (grid[y][x].type === TYPE_WALL) c.fillRect(x * TILE, y * TILE + 4, TILE, TILE - 4);
        }
    }

    c.fillStyle = C_WALL;
    for (let y = rect.minGy; y <= rect.maxGy; y++) {
        for (let x = rect.minGx; x <= rect.maxGx; x++) {
            if (grid[y][x].type === TYPE_WALL) c.fillRect(x * TILE, y * TILE, TILE, TILE - 4);
        }
    }

    c.strokeStyle = '#444';
    c.lineWidth = 1;
    c.beginPath();
    for (let y = rect.minGy; y <= rect.maxGy; y++) {
        for (let x = rect.minGx; x <= rect.maxGx; x++) {
            if (grid[y][x].type === TYPE_WALL) c.rect(x * TILE, y * TILE, TILE, TILE - 4);
        }
    }
    c.stroke();
    _combinedTerrainDirty = false;
    _combinedTerrainDirtyFull = false;
    _combinedTerrainDirtyBounds = null;
}

function rebuildCombinedBackgroundCache() {
    ensureCombinedBgCanvas();
    if (dirtyAreas || !_areaColorCache) rebuildAreaColorCache();
    if (!_areaOutlinePathCache) rebuildAreaOutlinePathCache();
    let c = _combinedBgCtx;

    if (!_combinedBgDirtyFull && !_combinedBgDirtyBounds && dirtyAreas) {
        _combinedBgDirtyFull = true;
    }

    if (_combinedBgDirtyFull) {
        _drawCombinedBackgroundRegion(c, 0, 0, GRID_W - 1, GRID_H - 1, true);
    } else if (_combinedBgDirtyBounds) {
        _drawCombinedBackgroundRegion(
            c,
            _combinedBgDirtyBounds.minGx,
            _combinedBgDirtyBounds.minGy,
            _combinedBgDirtyBounds.maxGx,
            _combinedBgDirtyBounds.maxGy,
            true
        );
    }

    dirtyGrid = false;
    dirtyAreas = false;
    _combinedBgDirtyFull = false;
    _combinedBgDirtyBounds = null;
}

function drawCombinedBackground(ctx, minGx, minGy, maxGx, maxGy) {
    ensureCombinedBgCanvas();
    if (_staticCacheCommitVersion < 0) commitStaticCaches(true);
    let sx = minGx * TILE, sy = minGy * TILE;
    let sw = (maxGx - minGx + 1) * TILE;
    let sh = (maxGy - minGy + 1) * TILE;
    queueDrawImage(ctx, _combinedBgCanvas, sx, sy, sw, sh, sx, sy, sw, sh);
}

function drawVisibilityMask(ctx, minGx, minGy, maxGx, maxGy) {
    if (fullVisibility || visibilityGrid.length === 0) return;
    let invNorm = 1 / Math.max(0.0001, Number(VISIBILITY_LIGHT_NORMALIZATION_RANGE) || 6);
    let tileSize = TILE;
    for (let y = minGy; y <= maxGy; y++) {
        let row = visibilityGrid[y];
        for (let x = minGx; x <= maxGx; x++) {
            let raw = row ? (row[x] || 0) : 0;
            let lightLevel = Math.max(0, Math.min(1, raw * invNorm));
            let fogAlpha = Math.pow(1 - lightLevel, _visibilityFogGamma);
            if (fogAlpha <= _visibilityFogMinAlpha) continue;
            ctx.fillStyle = `rgba(10,10,10,${fogAlpha.toFixed(4)})`;
            ctx.fillRect(x * tileSize, y * tileSize, tileSize, tileSize);
        }
    }
}

function drawLightingOverlayWorld(ctx, minGx, minGy, maxGx, maxGy) {
    if (!ctx || fullVisibility) return;
    rebuildVisibilityMaskCacheIfNeeded();
    if (!_visibilityMaskCanvas) return;
    let sx = minGx * TILE;
    let sy = minGy * TILE;
    let sw = (maxGx - minGx + 1) * TILE;
    let sh = (maxGy - minGy + 1) * TILE;
    setFrameDrawImageDepth(DRAW_Z_OVERLAY + 1);
    queueDrawImage(ctx, _visibilityMaskCanvas, sx, sy, sw, sh, sx, sy, sw, sh);
}

function renderStaticLayer(minGx, minGy, maxGx, maxGy) {
    if (!bgCtx || !bgCanvas) return;

    let dpr = window.devicePixelRatio || 1;
    let c = _staticLayerCache;
    let needsRedraw =
        !c.valid ||
        c.cameraX !== camera.x ||
        c.cameraY !== camera.y ||
        c.zoom !== camera.zoom ||
        c.viewW !== viewW ||
        c.viewH !== viewH ||
        c.dpr !== dpr ||
        c.minGx !== minGx ||
        c.minGy !== minGy ||
        c.maxGx !== maxGx ||
        c.maxGy !== maxGy ||
        c.staticCommitVersion !== _staticCacheCommitVersion;

    if (!needsRedraw) return;

    bgCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    bgCtx.clearRect(0, 0, viewW, viewH);
    bgCtx.fillStyle = '#0a0a0a';
    bgCtx.fillRect(0, 0, viewW, viewH);
    if (renderDimensionMode === '3d') {
        let worldWidth = Math.max(TILE, (maxGx - minGx + 1) * TILE);
        let worldHeight = Math.max(TILE, (maxGy - minGy + 1) * TILE);
        let scaleX = viewW / worldWidth;
        let scaleY = viewH / worldHeight;
        bgCtx.setTransform(scaleX * dpr, 0, 0, scaleY * dpr, -(minGx * TILE) * scaleX * dpr, -(minGy * TILE) * scaleY * dpr);
    } else {
        bgCtx.setTransform(camera.zoom * dpr, 0, 0, camera.zoom * dpr, -camera.x * camera.zoom * dpr, -camera.y * camera.zoom * dpr);
    }
    drawCombinedBackground(bgCtx, minGx, minGy, maxGx, maxGy);
    renderer3dBackgroundVersion++;

    c.valid = true;
    c.cameraX = camera.x;
    c.cameraY = camera.y;
    c.zoom = camera.zoom;
    c.viewW = viewW;
    c.viewH = viewH;
    c.dpr = dpr;
    c.minGx = minGx;
    c.minGy = minGy;
    c.maxGx = maxGx;
    c.maxGy = maxGy;
    c.staticCommitVersion = _staticCacheCommitVersion;
}

function rebuildAreaColorCache() {
    _areaColorCache = new Array(areas.length);
    for (let a of areas) {
        let color;
        if (a.active) {
            let lvl = a.multiplierLevel || 0;
            let cs = ['rgba(0,255,0,0.6)', 'rgba(0,255,0,0.8)', 'rgba(70,170,255,0.8)', 'rgba(200,0,255,0.8)', 'rgba(255,150,0,0.8)', 'rgba(255,220,0,0.9)'];
            color = cs[lvl] || cs[cs.length - 1];
        } else { color = 'rgba(128,128,128,0.1)'; }
        _areaColorCache[a.id] = color;
    }
}

function rebuildAreaOutlinePathCache() {
    let paths = new Array(areas.length);

    for (let y = 0; y < GRID_H; y++) {
        for (let x = 0; x < GRID_W; x++) {
            let aid = grid[y][x].areaId;
            if (aid === -1) continue;
            let p = paths[aid];
            if (!p) p = paths[aid] = new Path2D();

            let px = x * TILE, py = y * TILE;
            if (x === GRID_W - 1 || grid[y][x + 1].areaId !== aid) { p.moveTo(px + TILE - 1, py); p.lineTo(px + TILE - 1, py + TILE); }
            if (x === 0 || grid[y][x - 1].areaId !== aid) { p.moveTo(px + 1, py); p.lineTo(px + 1, py + TILE); }
            if (y === GRID_H - 1 || grid[y + 1][x].areaId !== aid) { p.moveTo(px, py + TILE - 1); p.lineTo(px + TILE, py + TILE - 1); }
            if (y === 0 || grid[y - 1][x].areaId !== aid) { p.moveTo(px, py + 1); p.lineTo(px + TILE, py + 1); }
        }
    }

    _areaOutlinePathCache = paths;
}

// Draw grid tiles directly to main ctx for visible area only (batched)
function drawGridDirect(ctx, minGx, minGy, maxGx, maxGy) {
    // Draw all floor tiles first, then wall tiles, to minimize state changes
    ctx.fillStyle = C_FLOOR;
    for (let y = minGy; y <= maxGy; y++) {
        for (let x = minGx; x <= maxGx; x++) {
            if (grid[y][x].type !== TYPE_WALL && (fullVisibility || (visibilityGrid[y] && visibilityGrid[y][x] > 0))) ctx.fillRect(x * TILE, y * TILE, TILE, TILE);
        }
    }
    // Wall shadow
    ctx.fillStyle = '#222';
    for (let y = minGy; y <= maxGy; y++) {
        for (let x = minGx; x <= maxGx; x++) {
            if (grid[y][x].type === TYPE_WALL && (fullVisibility || (visibilityGrid[y] && visibilityGrid[y][x] > 0))) ctx.fillRect(x * TILE, y * TILE + 4, TILE, TILE - 4);
        }
    }
    // Wall face
    ctx.fillStyle = C_WALL;
    for (let y = minGy; y <= maxGy; y++) {
        for (let x = minGx; x <= maxGx; x++) {
            if (grid[y][x].type === TYPE_WALL && (fullVisibility || (visibilityGrid[y] && visibilityGrid[y][x] > 0))) ctx.fillRect(x * TILE, y * TILE, TILE, TILE - 4);
        }
    }
    // Wall border (batched)
    ctx.strokeStyle = '#444'; ctx.lineWidth = 1;
    ctx.beginPath();
    for (let y = minGy; y <= maxGy; y++) {
        for (let x = minGx; x <= maxGx; x++) {
            if (grid[y][x].type === TYPE_WALL && (fullVisibility || (visibilityGrid[y] && visibilityGrid[y][x] > 0))) {
                let px = x * TILE, py = y * TILE;
                ctx.rect(px, py, TILE, TILE - 4);
            }
        }
    }
    ctx.stroke();
}

// Draw area outlines directly to main ctx for visible area only (batched by color)
function drawAreaOutlinesDirect(ctx, minGx, minGy, maxGx, maxGy) {
    if (dirtyAreas || !_areaColorCache) rebuildAreaColorCache();
    if (!_areaOutlinePathCache) rebuildAreaOutlinePathCache();
    if (!_areaColorCache || !_areaOutlinePathCache) return;

    ctx.lineWidth = 2;
    ctx.save();
    ctx.beginPath();
    ctx.rect(minGx * TILE, minGy * TILE, (maxGx - minGx + 1) * TILE, (maxGy - minGy + 1) * TILE);
    ctx.clip();
    for (let area of areas) {
        if (!_areaIntersectsTileRect(area, minGx, minGy, maxGx, maxGy)) continue;
        let path = _areaOutlinePathCache[area.id];
        if (!path) continue;
        ctx.strokeStyle = _areaColorCache[area.id];
        ctx.stroke(path);
    }
    ctx.restore();
}

function draw() {
    let vw = viewW / camera.zoom, vh = viewH / camera.zoom;
    let minGx = Math.max(0, Math.floor(camera.x / TILE) - 1);
    let minGy = Math.max(0, Math.floor(camera.y / TILE) - 1);
    let maxGx = Math.min(GRID_W - 1, Math.ceil((camera.x + vw) / TILE) + 1);
    let maxGy = Math.min(GRID_H - 1, Math.ceil((camera.y + vh) / TILE) + 1);
    let staticBounds = getBackgroundWorldBoundsForRenderMode();
    let bgSoundGrid = audioSpatialGridBackground;
    let fxSoundGrid = audioSpatialGridEffects;
    let getTileReactiveScale = (bgLevel, fxLevel) => 1 + bgLevel * AUDIO_REACTIVE_RENDER_2D_SCALE_FROM_BG + fxLevel * AUDIO_REACTIVE_RENDER_2D_SCALE_FROM_SFX;

    renderStaticLayer(staticBounds.minGx, staticBounds.minGy, staticBounds.maxGx, staticBounds.maxGy);
    beginFrameDrawImageQueue();

    ctx.save();
    let dpr = window.devicePixelRatio || 1;
    // Clear dynamic layer only; static world is drawn to bgCanvas
    _setDrawImageTrackedTransform(ctx, dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, viewW, viewH);
    _setDrawImageTrackedTransform(ctx, camera.zoom * dpr, 0, 0, camera.zoom * dpr, -camera.x * camera.zoom * dpr, -camera.y * camera.zoom * dpr);

    // Fallback (if bg layer context is unavailable)
    if (!bgCtx) {
        setFrameDrawImageDepth(DRAW_Z_BACKGROUND);
        drawCombinedBackground(ctx, minGx, minGy, maxGx, maxGy);
    }

    // Gold mines
    let visibleGoldMines = [];
    for (let m of goldMines) {
        if (m.gx < minGx || m.gx > maxGx || m.gy < minGy || m.gy > maxGy) continue;
        if (!fullVisibility && (!visibilityGrid[m.gy] || visibilityGrid[m.gy][m.gx] === 0)) continue;
        visibleGoldMines.push(m);
    }

    setFrameDrawImageDepth(DRAW_Z_STRUCTURES);
    let activeMineSprite = _getGoldMineTileSprite(true);
    let depletedMineSprite = _getGoldMineTileSprite(false);
    for (let m of visibleGoldMines) {
        let mineSprite = m.gold > 0 ? activeMineSprite : depletedMineSprite;
        let bgSoundRow = bgSoundGrid[m.gy];
        let fxSoundRow = fxSoundGrid[m.gy];
        let bgLevel = bgSoundRow ? bgSoundRow[m.gx] || 0 : 0;
        let fxLevel = fxSoundRow ? fxSoundRow[m.gx] || 0 : 0;
        let drawScale = getTileReactiveScale(bgLevel, fxLevel);
        drawWithTrackedContextTransform(ctx, m.gx * TILE + TILE * 0.5, m.gy * TILE + TILE * 0.5, 0, 0, drawScale, () => {
            queueDrawImage(ctx, mineSprite, m.gx * TILE, m.gy * TILE, TILE, TILE);
        });
    }

    let visibleAstarMines = [];
    for (let m of astarMines) {
        if (m.gx < minGx || m.gx > maxGx || m.gy < minGy || m.gy > maxGy) continue;
        if (!fullVisibility && (!visibilityGrid[m.gy] || visibilityGrid[m.gy][m.gx] === 0)) continue;
        visibleAstarMines.push(m);
    }

    let activeAstarMineSprite = _getAstarMineTileSprite(true);
    let depletedAstarMineSprite = _getAstarMineTileSprite(false);
    for (let m of visibleAstarMines) {
        let mineSprite = m.astar > 0 ? activeAstarMineSprite : depletedAstarMineSprite;
        let bgSoundRow = bgSoundGrid[m.gy];
        let fxSoundRow = fxSoundGrid[m.gy];
        let bgLevel = bgSoundRow ? bgSoundRow[m.gx] || 0 : 0;
        let fxLevel = fxSoundRow ? fxSoundRow[m.gx] || 0 : 0;
        let drawScale = getTileReactiveScale(bgLevel, fxLevel);
        drawWithTrackedContextTransform(ctx, m.gx * TILE + TILE * 0.5, m.gy * TILE + TILE * 0.5, 0, 0, drawScale, () => {
            queueDrawImage(ctx, mineSprite, m.gx * TILE, m.gy * TILE, TILE, TILE);
        });
    }

    // Gold mine amount labels (re-enabled for FPS comparison testing).
    if (showGoldMineAmountText && visibleGoldMines.length > 0) {
        ctx.font = "bold 8px Arial";
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.lineWidth = 2;
        // Use shadow filter instead of strokeText (faster)
        ctx.shadowColor = 'rgba(0,0,0,0.9)';
        ctx.shadowBlur = 2;
        ctx.shadowOffsetX = 0;
        ctx.shadowOffsetY = 0;

        for (let m of visibleGoldMines) {
            let label = formatBigNumber(Math.max(0, m.gold || 0), 0);
            ctx.fillStyle = (m.gold > 0) ? '#fffbe8' : '#bbb';
            ctx.fillText(label, m.gx * TILE + 16, m.gy * TILE + 16);
        }

        ctx.shadowColor = 'transparent';
        ctx.shadowBlur = 0;
    }

    if (showGoldMineAmountText && visibleAstarMines.length > 0) {
        ctx.font = "bold 8px Arial";
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.shadowColor = 'rgba(0,0,0,0.9)';
        ctx.shadowBlur = 2;
        ctx.shadowOffsetX = 0;
        ctx.shadowOffsetY = 0;
        for (let m of visibleAstarMines) {
            let label = formatBigNumber(Math.max(0, m.astar || 0), 0);
            ctx.fillStyle = (m.astar > 0) ? '#f0f0f0' : '#999';
            ctx.fillText(label, m.gx * TILE + 16, m.gy * TILE + 16);
        }
        ctx.shadowColor = 'transparent';
        ctx.shadowBlur = 0;
    }

    // Floor items
    setFrameDrawImageDepth(DRAW_Z_STRUCTURES);
    for (let y = minGy; y <= maxGy; y++) {
        for (let x = minGx; x <= maxGx; x++) {
            if (grid[y][x].item && (fullVisibility || (visibilityGrid[y] && visibilityGrid[y][x] > 0))) {
                let bgSoundRow = bgSoundGrid[y];
                let fxSoundRow = fxSoundGrid[y];
                let bgLevel = bgSoundRow ? bgSoundRow[x] || 0 : 0;
                let fxLevel = fxSoundRow ? fxSoundRow[x] || 0 : 0;
                let drawScale = getTileReactiveScale(bgLevel, fxLevel);
                drawWithTrackedContextTransform(ctx, x * TILE + TILE * 0.5, y * TILE + TILE * 0.5, 0, 0, drawScale, () => {
                    drawFloorItem(ctx, grid[y][x], x * TILE, y * TILE);
                });
            }
        }
    }

    // Dropped energy
    for (let d of droppedItems) {
        if (d.gx < minGx || d.gx > maxGx || d.gy < minGy || d.gy > maxGy) continue;
        if (!fullVisibility && (!visibilityGrid[d.gy] || visibilityGrid[d.gy][d.gx] === 0)) continue;
        let bgSoundRow = bgSoundGrid[d.gy];
        let fxSoundRow = fxSoundGrid[d.gy];
        let bgLevel = bgSoundRow ? bgSoundRow[d.gx] || 0 : 0;
        let fxLevel = fxSoundRow ? fxSoundRow[d.gx] || 0 : 0;
        let drawScale = getTileReactiveScale(bgLevel, fxLevel);
        drawWithTrackedContextTransform(ctx, d.x, d.y, 0, 0, drawScale, () => {
            ctx.fillStyle = '#fd0'; ctx.font = "900 20px Arial"; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
            ctx.fillText('⚡', d.x, d.y);
        });
    }

    // Towers
    setFrameDrawImageDepth(DRAW_Z_STRUCTURES);
    for (let t of towers) {
        if (t.gx < minGx - 2 || t.gx > maxGx + 2 || t.gy < minGy - 2 || t.gy > maxGy + 2) continue;
        if (!fullVisibility && (!visibilityGrid[t.gy] || visibilityGrid[t.gy][t.gx] === 0)) continue;
        let bgSoundRow = bgSoundGrid[t.gy];
        let fxSoundRow = fxSoundGrid[t.gy];
        let bgLevel = bgSoundRow ? bgSoundRow[t.gx] || 0 : 0;
        let fxLevel = fxSoundRow ? fxSoundRow[t.gx] || 0 : 0;
        let drawScale = getTileReactiveScale(bgLevel, fxLevel);
        drawWithTrackedContextTransform(ctx, t.x, t.y, 0, 0, drawScale, () => {
            t.draw(ctx);
        });
    }

    // Collector/Salvager spawners
    setFrameDrawImageDepth(DRAW_Z_STRUCTURES);
    collectorSpawners.forEach(s => {
        if (s.gx >= minGx && s.gx <= maxGx && s.gy >= minGy && s.gy <= maxGy) {
            if (fullVisibility || (visibilityGrid[s.gy] && visibilityGrid[s.gy][s.gx] > 0)) {
                let bgSoundRow = bgSoundGrid[s.gy];
                let fxSoundRow = fxSoundGrid[s.gy];
                let bgLevel = bgSoundRow ? bgSoundRow[s.gx] || 0 : 0;
                let fxLevel = fxSoundRow ? fxSoundRow[s.gx] || 0 : 0;
                let drawScale = getTileReactiveScale(bgLevel, fxLevel);
                drawWithTrackedContextTransform(ctx, s.x, s.y, 0, 0, drawScale, () => {
                    s.draw(ctx);
                });
            }
        }
    });

    // Barracks
    setFrameDrawImageDepth(DRAW_Z_STRUCTURES);
    barracks.forEach(b => {
        if (b.gx >= minGx && b.gx <= maxGx && b.gy >= minGy && b.gy <= maxGy) {
            if (fullVisibility || (visibilityGrid[b.gy] && visibilityGrid[b.gy][b.gx] > 0)) {
                let bgSoundRow = bgSoundGrid[b.gy];
                let fxSoundRow = fxSoundGrid[b.gy];
                let bgLevel = bgSoundRow ? bgSoundRow[b.gx] || 0 : 0;
                let fxLevel = fxSoundRow ? fxSoundRow[b.gx] || 0 : 0;
                let drawScale = getTileReactiveScale(bgLevel, fxLevel);
                drawWithTrackedContextTransform(ctx, b.x, b.y, 0, 0, drawScale, () => {
                    b.draw(ctx);
                });
            }
        }
    });

    // Flush queued background/structure sprites now so immediate unit draws happen on top.
    flushFrameDrawImageQueue();
    beginFrameDrawImageQueue();

    // Units (interpolated positions for smooth rendering)
    setFrameDrawImageDepth(DRAW_Z_UNITS);
    let alpha = tickAlpha;
    for (let u of units) {
        if (u.dead) continue;
        let rx = u.x, ry = u.y;
        u.x = u.prevX + (u.x - u.prevX) * alpha;
        u.y = u.prevY + (u.y - u.prevY) * alpha;
        let ugx = Math.floor(u.x / TILE), ugy = Math.floor(u.y / TILE);
        if (ugx < minGx - 2 || ugx > maxGx + 2 || ugy < minGy - 2 || ugy > maxGy + 2) { u.x = rx; u.y = ry; continue; }
        if (fullVisibility || (visibilityGrid[ugy] && visibilityGrid[ugy][ugx] > 0)) {
            let bgSoundRow = bgSoundGrid[ugy];
            let fxSoundRow = fxSoundGrid[ugy];
            let bgLevel = bgSoundRow ? bgSoundRow[ugx] || 0 : 0;
            let fxLevel = fxSoundRow ? fxSoundRow[ugx] || 0 : 0;
            let drawScale = getTileReactiveScale(bgLevel, fxLevel);
            drawWithTrackedContextTransform(ctx, u.x, u.y, 0, 0, drawScale, () => {
                u.draw(ctx);
            });
        }
        u.x = rx; u.y = ry;
    }

    // Projectiles (interpolated)
    setFrameDrawImageDepth(DRAW_Z_PARTICLES);
    for (let p of projectiles) {
        let rx = p.x, ry = p.y;
        p.x = p.prevX + (p.x - p.prevX) * alpha;
        p.y = p.prevY + (p.y - p.prevY) * alpha;
        let cgy = Math.floor(p.y / TILE), cgx = Math.floor(p.x / TILE);
        if (fullVisibility || (visibilityGrid[cgy] && visibilityGrid[cgy][cgx] > 0)) {
            p.draw(ctx);
        }
        p.x = rx; p.y = ry;
    }
    for (let p of particles) {
        let rx = p.x, ry = p.y;
        p.x = p.prevX + (p.x - p.prevX) * alpha;
        p.y = p.prevY + (p.y - p.prevY) * alpha;
        let cgy = Math.floor(p.y / TILE), cgx = Math.floor(p.x / TILE);
        if (fullVisibility || (visibilityGrid[cgy] && visibilityGrid[cgy][cgx] > 0)) {
            p.draw(ctx);
        }
        p.x = rx; p.y = ry;
    }

    for (let t of towers) {
        if (t.gx < minGx - 2 || t.gx > maxGx + 2 || t.gy < minGy - 2 || t.gy > maxGy + 2) continue;
        if (!fullVisibility && (!visibilityGrid[t.gy] || visibilityGrid[t.gy][t.gx] === 0)) continue;
        let bgSoundRow = bgSoundGrid[t.gy];
        let fxSoundRow = fxSoundGrid[t.gy];
        let bgLevel = bgSoundRow ? bgSoundRow[t.gx] || 0 : 0;
        let fxLevel = fxSoundRow ? fxSoundRow[t.gx] || 0 : 0;
        let scaleAmount = getTileReactiveScale(bgLevel, fxLevel);
        draw2DDamageFlashOverlay(ctx, t, t.x, t.y, 16 * scaleAmount, true);
    }
    for (let s of collectorSpawners) {
        if (s.gx < minGx || s.gx > maxGx || s.gy < minGy || s.gy > maxGy) continue;
        if (!fullVisibility && (!visibilityGrid[s.gy] || visibilityGrid[s.gy][s.gx] === 0)) continue;
        let bgSoundRow = bgSoundGrid[s.gy];
        let fxSoundRow = fxSoundGrid[s.gy];
        let bgLevel = bgSoundRow ? bgSoundRow[s.gx] || 0 : 0;
        let fxLevel = fxSoundRow ? fxSoundRow[s.gx] || 0 : 0;
        let scaleAmount = getTileReactiveScale(bgLevel, fxLevel);
        draw2DDamageFlashOverlay(ctx, s, s.x, s.y, 15 * scaleAmount, true);
    }
    for (let b of barracks) {
        if (b.gx < minGx || b.gx > maxGx || b.gy < minGy || b.gy > maxGy) continue;
        if (!fullVisibility && (!visibilityGrid[b.gy] || visibilityGrid[b.gy][b.gx] === 0)) continue;
        let bgSoundRow = bgSoundGrid[b.gy];
        let fxSoundRow = fxSoundGrid[b.gy];
        let bgLevel = bgSoundRow ? bgSoundRow[b.gx] || 0 : 0;
        let fxLevel = fxSoundRow ? fxSoundRow[b.gx] || 0 : 0;
        let scaleAmount = getTileReactiveScale(bgLevel, fxLevel);
        draw2DDamageFlashOverlay(ctx, b, b.x, b.y, 15 * scaleAmount, true);
    }
    for (let y = minGy; y <= maxGy; y++) {
        let visRow = visibilityGrid[y];
        for (let x = minGx; x <= maxGx; x++) {
            if (!fullVisibility && (!visRow || visRow[x] === 0)) continue;
            let cell = grid[y][x];
            if (!cell || !cell.item) continue;
            let bgSoundRow = bgSoundGrid[y];
            let fxSoundRow = fxSoundGrid[y];
            let bgLevel = bgSoundRow ? bgSoundRow[x] || 0 : 0;
            let fxLevel = fxSoundRow ? fxSoundRow[x] || 0 : 0;
            let scaleAmount = getTileReactiveScale(bgLevel, fxLevel);
            draw2DDamageFlashOverlay(ctx, cell.item, x * TILE + 16, y * TILE + 16, 16 * scaleAmount, true);
        }
    }
    for (let u of units) {
        if (!u || u.dead) continue;
        let ux = Number.isFinite(u.prevX) ? (u.prevX + (u.x - u.prevX) * alpha) : u.x;
        let uy = Number.isFinite(u.prevY) ? (u.prevY + (u.y - u.prevY) * alpha) : u.y;
        let ugx = Math.floor(ux / TILE), ugy = Math.floor(uy / TILE);
        if (ugx < minGx - 2 || ugx > maxGx + 2 || ugy < minGy - 2 || ugy > maxGy + 2) continue;
        if (!fullVisibility && (!visibilityGrid[ugy] || visibilityGrid[ugy][ugx] === 0)) continue;
        let bgSoundRow = bgSoundGrid[ugy];
        let fxSoundRow = fxSoundGrid[ugy];
        let bgLevel = bgSoundRow ? bgSoundRow[ugx] || 0 : 0;
        let fxLevel = fxSoundRow ? fxSoundRow[ugx] || 0 : 0;
        let scaleAmount = getTileReactiveScale(bgLevel, fxLevel);
        draw2DDamageFlashOverlay(ctx, u, ux, uy, ((Number(u.r) || 8) + 3) * scaleAmount, false);
    }

    // Salvage marks (red X on marked buildings)
    ctx.strokeStyle = '#f44'; ctx.lineWidth = 2;
    for (let t of towers) { if (t.markedForSalvage) { let px = t.gx * TILE, py = t.gy * TILE; ctx.beginPath(); ctx.moveTo(px + 4, py + 4); ctx.lineTo(px + TILE - 4, py + TILE - 4); ctx.moveTo(px + TILE - 4, py + 4); ctx.lineTo(px + 4, py + TILE - 4); ctx.stroke(); } }
    for (let b of barracks) { if (b.markedForSalvage) { let px = b.gx * TILE, py = b.gy * TILE; ctx.beginPath(); ctx.moveTo(px + 4, py + 4); ctx.lineTo(px + TILE - 4, py + TILE - 4); ctx.moveTo(px + TILE - 4, py + 4); ctx.lineTo(px + 4, py + TILE - 4); ctx.stroke(); } }
    for (let s of collectorSpawners) { if (s.markedForSalvage) { let px = s.gx * TILE, py = s.gy * TILE; ctx.beginPath(); ctx.moveTo(px + 4, py + 4); ctx.lineTo(px + TILE - 4, py + TILE - 4); ctx.moveTo(px + TILE - 4, py + 4); ctx.lineTo(px + 4, py + TILE - 4); ctx.stroke(); } }
    for (let y = minGy; y <= maxGy; y++) for (let x = minGx; x <= maxGx; x++) { let c = grid[y][x]; if (c.item && c.item.markedForSalvage) { let px = x * TILE, py = y * TILE; ctx.beginPath(); ctx.moveTo(px + 4, py + 4); ctx.lineTo(px + TILE - 4, py + TILE - 4); ctx.moveTo(px + TILE - 4, py + 4); ctx.lineTo(px + 4, py + TILE - 4); ctx.stroke(); } }

    // Selection box
    if (isBoxSelecting && selectionBox) {
        ctx.strokeStyle = 'rgba(0,255,0,0.8)'; ctx.lineWidth = 1;
        ctx.fillStyle = 'rgba(0,255,0,0.1)';
        let sx = selectionBox.sx, sy = selectionBox.sy, w = selectionBox.ex - sx, h = selectionBox.ey - sy;
        ctx.fillRect(sx, sy, w, h); ctx.strokeRect(sx, sy, w, h);
    }

    let activeSelectedEntities = getActiveEntities();
    let activeSelectedUnits = getActiveUnits();
    let localOwnerIndex = players.findIndex(p => p.id === myPeerId);
    let overlayViewMinX = camera.x;
    let overlayViewMinY = camera.y;
    let overlayViewMaxX = camera.x + vw;
    let overlayViewMaxY = camera.y + vh;
    ctx.imageSmoothingEnabled = false;
    let selectedEntityRects = [];
    let stationaryBuildingRallySegments = [];
    let stationaryBuildingRallyMarkers = [];
    let dynamicBuildingRallySegments = [];
    let dynamicBuildingRallyMarkers = [];
    let towerRangeEntries = [];

    // Selected entities highlight + rally + tower target/range metadata.
    for (let ent of activeSelectedEntities) {
        if (ent.energy !== undefined && ent.energy <= 0) continue;
        let ex = ent.x || (ent.gx * TILE + 16);
        let ey = ent.y || (ent.gy * TILE + 16);
        let entVisible = _overlayBoundsVisible(ex, ey, ex, ey, overlayViewMinX, overlayViewMinY, overlayViewMaxX, overlayViewMaxY, 64);

        if (entVisible && showSelectionOutlinesForBuildings()) {
            selectedEntityRects.push([ex - 18, ey - 18, 36, 36, get2DRenderOwnerColor(ent.owner)]);
        }

        if (['barrack', 'spawner', 'astar_spawner', 'salvager', 'builder_spawner', 'healer_spawner', 'research'].includes(ent.type) && ent.rallyX !== null) {
            let rx = ent.rallyX, ry = ent.rallyY;
            let segVisible = _overlayBoundsVisible(Math.min(ex, rx), Math.min(ey, ry), Math.max(ex, rx), Math.max(ey, ry), overlayViewMinX, overlayViewMinY, overlayViewMaxX, overlayViewMaxY, 20);
            if (!segVisible) continue;
            let isDynamicRally = ent.rallyTargetUnitId != null;
            if (isDynamicRally) {
                dynamicBuildingRallySegments.push([ex, ey, rx, ry]);
                dynamicBuildingRallyMarkers.push([rx, ry]);
            } else {
                stationaryBuildingRallySegments.push([ex, ey, rx, ry]);
                stationaryBuildingRallyMarkers.push([rx, ry]);
            }
        }

        if (ent instanceof Tower && ent.owner === localPlayerId) {
            let marker = resolveTowerPreferredTargetVisual(ent);
            if (marker && Number.isFinite(marker.x) && Number.isFinite(marker.y)) {
                let rx = marker.x, ry = marker.y;
                ctx.save();
                ctx.globalAlpha = marker.locked ? 1 : 0.55;
                ctx.strokeStyle = '#9cf'; ctx.lineWidth = 1.5;
                ctx.beginPath(); ctx.moveTo(ex, ey); ctx.lineTo(rx, ry); ctx.stroke();
                ctx.fillStyle = '#9cf';
                ctx.beginPath(); ctx.arc(rx, ry, 4, 0, 6.28); ctx.fill();
                ctx.restore();
            }
        }

        if (renderRangeMode === RENDER_RANGE_TURRETS || renderRangeMode === RENDER_RANGE_TURRETS_AND_UNITS) {
            if (ent instanceof Tower) {
                let visArea = getEntityVisibilityRangeArea(ent);
                if (Number.isFinite(visArea) && visArea > 0) {
                    let color = (ent.owner === localOwnerIndex || !isMultiplayer) ? 'rgba(0,255,0,0.20)' : 'rgba(255,0,0,0.20)';
                    towerRangeEntries.push([getAreaRangeCellsAtWorld(ex, ey, visArea), color]);
                }
            }
        }
    }

    if (selectedEntityRects.length > 0) {
        for (let rect of selectedEntityRects) {
            let rectSprite = _getOverlayRectOutlineSprite(36, 36, selectionOutlineType, rect[4] || '#9aa', 1);
            ctx.drawImage(rectSprite.canvas, Math.round(rect[0] - rectSprite.offsetX), Math.round(rect[1] - rectSprite.offsetY), rectSprite.drawW, rectSprite.drawH);
        }
    }

    if (stationaryBuildingRallyMarkers.length > 0) {
        if (showRallyLinesForBuildings()) {
            let markerSprite = _getOverlayMarkerSprite('rally_arrow', '#9aa');
            for (let seg of stationaryBuildingRallySegments) {
                _drawOverlayLineSprite(ctx, seg[0], seg[1], seg[2], seg[3], rallyLineType, '#9aa', 1);
                _drawOverlayLineSprite(ctx, seg[2], seg[3], seg[2], seg[3] - 12, rallyLineType, '#9aa', 1);
            }
            for (let pos of stationaryBuildingRallyMarkers) {
                let rx = pos[0], ry = pos[1];
                ctx.drawImage(markerSprite.canvas, Math.round(rx - markerSprite.offsetX), Math.round((ry - 8) - markerSprite.offsetY), markerSprite.drawW, markerSprite.drawH);
            }
        } else {
            let markerSprite = _getOverlayMarkerSprite('plus', '#9aa');
            for (let pos of stationaryBuildingRallyMarkers) {
                let rx = pos[0], ry = pos[1];
                ctx.drawImage(markerSprite.canvas, Math.round(rx - markerSprite.offsetX), Math.round(ry - markerSprite.offsetY), markerSprite.drawW, markerSprite.drawH);
            }
        }
    }

    if (dynamicBuildingRallyMarkers.length > 0) {
        if (showRallyLinesForBuildings()) {
            let markerSprite = _getOverlayMarkerSprite('rally_arrow', '#9aa');
            for (let seg of dynamicBuildingRallySegments) {
                _drawOverlayLineSprite(ctx, seg[0], seg[1], seg[2], seg[3], rallyLineType, '#9aa', 1);
                _drawOverlayLineSprite(ctx, seg[2], seg[3], seg[2], seg[3] - 12, rallyLineType, '#9aa', 1);
            }
            for (let pos of dynamicBuildingRallyMarkers) {
                let rx = pos[0], ry = pos[1];
                ctx.drawImage(markerSprite.canvas, Math.round(rx - markerSprite.offsetX), Math.round((ry - 8) - markerSprite.offsetY), markerSprite.drawW, markerSprite.drawH);
            }
        } else {
            let markerSprite = _getOverlayMarkerSprite('plus', '#9aa');
            for (let pos of dynamicBuildingRallyMarkers) {
                let rx = pos[0], ry = pos[1];
                ctx.drawImage(markerSprite.canvas, Math.round(rx - markerSprite.offsetX), Math.round(ry - markerSprite.offsetY), markerSprite.drawW, markerSprite.drawH);
            }
        }
    }

    // Range overlays: draw the included area tiles directly.
    if (renderRangeMode !== RENDER_RANGE_NONE) {
        if (towerRangeEntries.length > 0) {
            for (let e of towerRangeEntries) {
                _drawAreaCoverageOverlay2D(ctx, e[0], e[1], overlayViewMinX, overlayViewMinY, overlayViewMaxX, overlayViewMaxY);
            }
        }

        if (renderRangeMode === RENDER_RANGE_TURRETS_AND_UNITS) {
            for (let u of activeSelectedUnits) {
                if (!u || u.dead) continue;
                let rangeArea = getUnitRenderActionRangeArea(u);
                if (rangeArea <= 0) continue;
                let ux = Number.isFinite(u.prevX) ? (u.prevX + (u.x - u.prevX) * alpha) : u.x;
                let uy = Number.isFinite(u.prevY) ? (u.prevY + (u.y - u.prevY) * alpha) : u.y;
                let color = (u.owner === localOwnerIndex || !isMultiplayer) ? 'rgba(120,220,255,0.52)' : 'rgba(255,150,150,0.52)';
                _drawAreaCoverageOverlay2D(ctx, getAreaRangeCellsAtWorld(ux, uy, rangeArea), color, overlayViewMinX, overlayViewMinY, overlayViewMaxX, overlayViewMaxY);
            }
        }
    }

    if (showSelectionOutlinesForUnits() && activeSelectedUnits.length > 0) {
        let spriteByRadius = new Map();
        for (let u of activeSelectedUnits) {
            if (!u || u.dead) continue;
            let ux = Number.isFinite(u.prevX) ? (u.prevX + (u.x - u.prevX) * alpha) : u.x;
            let uy = Number.isFinite(u.prevY) ? (u.prevY + (u.y - u.prevY) * alpha) : u.y;
            let rr = (Number(u.r) || 8) + 4;
            if (!_overlayBoundsVisible(ux - rr, uy - rr, ux + rr, uy + rr, overlayViewMinX, overlayViewMinY, overlayViewMaxX, overlayViewMaxY, 6)) continue;
            let rKey = Math.max(2, Math.round(rr));
            let ringColor = get2DRenderOwnerColor(u.owner);
            let spriteKey = `${rKey}|${ringColor}`;
            let ring = spriteByRadius.get(spriteKey);
            if (!ring) {
                ring = _getUnitSelectionRingSprite(rKey, selectionOutlineType, ringColor);
                spriteByRadius.set(spriteKey, ring);
            }
            let dx = Math.round(ux - ring.half);
            let dy = Math.round(uy - ring.half);
            ctx.drawImage(ring.canvas, dx, dy, ring.drawW, ring.drawH);
        }
    }

    // Unit waypoints (move/attack-move destinations for selected units)
    let moveSegments = [];
    let attackMoveSegments = [];
    let moveMarkers = new Map();
    let attackMoveMarkers = new Map();

    for (let u of activeSelectedUnits) {
        if (u.dead) continue;
        let ux = u.prevX + (u.x - u.prevX) * alpha, uy = u.prevY + (u.y - u.prevY) * alpha;
        let neutralEndpoint = null;
        if (u.path && u.path.length > 0) {
            let last = u.path[u.path.length - 1];
            neutralEndpoint = { x: last.x * TILE + 16, y: last.y * TILE + 16 };
        } else if (u._pendingPathTarget) {
            neutralEndpoint = { x: u._pendingPathTarget.gx * TILE + 16, y: u._pendingPathTarget.gy * TILE + 16 };
        } else if (Number.isFinite(u._forcedTargetLastSeenX) && Number.isFinite(u._forcedTargetLastSeenY)) {
            neutralEndpoint = { x: u._forcedTargetLastSeenX, y: u._forcedTargetLastSeenY };
        }
        if (u.commandState >= CMD_MOVING && u.commandState <= CMD_ATTACK_MOVING) {
            let destX = null, destY = null, markerKey = null;
            if (u.path && u.path.length > 0) {
                let lastPt = u.path[u.path.length - 1];
                destX = lastPt.x * TILE + 16;
                destY = lastPt.y * TILE + 16;
                markerKey = lastPt.x + ',' + lastPt.y;
            } else if (u._pendingPathTarget) {
                destX = u._pendingPathTarget.gx * TILE + 16;
                destY = u._pendingPathTarget.gy * TILE + 16;
                markerKey = u._pendingPathTarget.gx + ',' + u._pendingPathTarget.gy;
            }

            if (destX !== null && destY !== null) {
                if (u.commandState === CMD_ATTACK_MOVING) {
                    attackMoveSegments.push([ux, uy, destX, destY]);
                    attackMoveMarkers.set(markerKey, [destX, destY]);
                } else {
                    moveSegments.push([ux, uy, destX, destY]);
                    moveMarkers.set(markerKey, [destX, destY]);
                }
            }
        }
        // Attack target indicator
        if (u.targetUnit && !u.targetUnit.dead && u.commandState === CMD_ATTACKING) {
            let tgx = Math.floor(u.targetUnit.x / TILE), tgy = Math.floor(u.targetUnit.y / TILE);
            let targetVisible = isTileVisible(tgx, tgy);
            ctx.lineWidth = 1;
            if (targetVisible) {
                let tx = u.targetUnit.prevX + (u.targetUnit.x - u.targetUnit.prevX) * alpha;
                let ty = u.targetUnit.prevY + (u.targetUnit.y - u.targetUnit.prevY) * alpha;
                ctx.strokeStyle = 'rgba(255,0,0,0.6)';
                ctx.beginPath(); ctx.moveTo(ux, uy); ctx.lineTo(tx, ty); ctx.stroke();
            } else if (neutralEndpoint) {
                ctx.strokeStyle = 'rgba(100,255,100,0.6)';
                ctx.beginPath(); ctx.moveTo(ux, uy); ctx.lineTo(neutralEndpoint.x, neutralEndpoint.y); ctx.stroke();
            }
        }
        if (u.targetBuilding && u.targetBuilding.energy > 0 && u.commandState === CMD_ATTACKING) {
            let targetVisible = isTileVisible(u.targetBuilding.gx, u.targetBuilding.gy);
            ctx.lineWidth = 1;
            if (targetVisible) {
                ctx.strokeStyle = 'rgba(255,0,0,0.6)';
                ctx.beginPath(); ctx.moveTo(ux, uy); ctx.lineTo(u.targetBuilding.x, u.targetBuilding.y); ctx.stroke();
            } else if (neutralEndpoint) {
                ctx.strokeStyle = 'rgba(100,255,100,0.6)';
                ctx.beginPath(); ctx.moveTo(ux, uy); ctx.lineTo(neutralEndpoint.x, neutralEndpoint.y); ctx.stroke();
            }
        }
    }

    if (showRallyLinesForUnits() && (moveSegments.length > 0 || attackMoveSegments.length > 0)) {
        let maxWaypointLines = 320;

        if (moveSegments.length > 0) {
            let moveStep = Math.max(1, Math.ceil(moveSegments.length / maxWaypointLines));
            for (let i = 0; i < moveSegments.length; i += moveStep) {
                let seg = moveSegments[i];
                _drawOverlayLineSprite(ctx, seg[0], seg[1], seg[2], seg[3], rallyLineType, 'rgba(100,255,100,0.5)', 1);
            }
        }

        if (attackMoveSegments.length > 0) {
            let attackStep = Math.max(1, Math.ceil(attackMoveSegments.length / maxWaypointLines));
            for (let i = 0; i < attackMoveSegments.length; i += attackStep) {
                let seg = attackMoveSegments[i];
                _drawOverlayLineSprite(ctx, seg[0], seg[1], seg[2], seg[3], rallyLineType, 'rgba(255,100,100,0.5)', 1);
            }
        }
    }

    let drawMarkers = (markers, color) => {
        if (markers.size === 0) return;
        let markerSprite = _getOverlayMarkerSprite('plus', color);
        for (let pos of markers.values()) {
            let dx = pos[0], dy = pos[1];
            ctx.drawImage(markerSprite.canvas, Math.round(dx - markerSprite.offsetX), Math.round(dy - markerSprite.offsetY), markerSprite.drawW, markerSprite.drawH);
        }
    };

    drawMarkers(moveMarkers, '#4f4');
    drawMarkers(attackMoveMarkers, '#f66');

    // Build preview ghost
    let buildPreview = getCurrentBuildPreviewData();
    if (buildPreview) {
        setFrameDrawImageDepth(DRAW_Z_OVERLAY);
        if (buildPreview.areaCells) {
            for (let cell of buildPreview.areaCells) {
                ctx.fillStyle = cell.occupied ? 'rgba(0,255,0,0.2)' : 'rgba(255,100,0,0.2)';
                ctx.fillRect(cell.x * TILE + 3, cell.y * TILE + 3, TILE - 6, TILE - 6);
            }
            ctx.strokeStyle = buildPreview.canBuild ? 'rgba(0,255,0,0.9)' : 'rgba(255,200,0,0.9)';
            ctx.lineWidth = 3;
            let areaId = grid[buildPreview.gy][buildPreview.gx].areaId;
            for (let cell of buildPreview.areaCells) {
                let px = cell.x * TILE, py = cell.y * TILE;
                if (cell.x === GRID_W - 1 || grid[cell.y][cell.x + 1].areaId !== areaId) { ctx.beginPath(); ctx.moveTo(px + TILE, py); ctx.lineTo(px + TILE, py + TILE); ctx.stroke(); }
                if (cell.x === 0 || grid[cell.y][cell.x - 1].areaId !== areaId) { ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(px, py + TILE); ctx.stroke(); }
                if (cell.y === GRID_H - 1 || grid[cell.y + 1][cell.x].areaId !== areaId) { ctx.beginPath(); ctx.moveTo(px, py + TILE); ctx.lineTo(px + TILE, py + TILE); ctx.stroke(); }
                if (cell.y === 0 || grid[cell.y - 1][cell.x].areaId !== areaId) { ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(px + TILE, py); ctx.stroke(); }
            }
            let cx = buildPreview.areaCenterX * TILE;
            let cy = buildPreview.areaCenterY * TILE;
            ctx.font = 'bold 14px monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
            ctx.fillStyle = buildPreview.canBuild ? '#4f4' : '#fd0';
            ctx.fillText(`${buildPreview.filledCount}/${buildPreview.areaCellCount}`, cx, cy);
            if (buildPreview.filledCount === buildPreview.areaCellCount) {
                ctx.font = '10px monospace';
                ctx.fillStyle = buildPreview.canBuild ? '#4f4' : '#fd0';
                ctx.fillText(`M${buildPreview.areaMultiplierLevel}\u2192${buildPreview.areaMultiplierLevel + 1}`, cx, cy + 14);
                ctx.fillStyle = buildPreview.canBuild ? '#4f4' : '#f88';
                ctx.fillText(`⚡${buildPreview.areaUpgradeCost}`, cx, cy + 26);
            }
        }
        drawBuildPlacementGhost(ctx, buildPreview.gx, buildPreview.gy, buildPreview.key, !!buildPreview.canBuild, buildPreview.previewLevel);
        ctx.fillStyle = buildPreview.canBuild ? 'rgba(0,255,0,0.3)' : 'rgba(255,0,0,0.3)';
        ctx.fillRect(buildPreview.gx * TILE, buildPreview.gy * TILE, TILE, TILE);
    }

    drawLightingOverlayWorld(ctx, minGx, minGy, maxGx, maxGy);

    ctx.restore();

    // Minimap
    drawMinimap();
    flushFrameDrawImageQueue();
}

function getVisibleWorldBounds(padTiles = 1) {
    let vw = viewW / camera.zoom;
    let vh = viewH / camera.zoom;
    return {
        vw,
        vh,
        minGx: Math.max(0, Math.floor(camera.x / TILE) - padTiles),
        minGy: Math.max(0, Math.floor(camera.y / TILE) - padTiles),
        maxGx: Math.min(GRID_W - 1, Math.ceil((camera.x + vw) / TILE) + padTiles),
        maxGy: Math.min(GRID_H - 1, Math.ceil((camera.y + vh) / TILE) + padTiles)
    };
}
