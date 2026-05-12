let canvas, ctx, bgCanvas, bgCtx, overlayCanvas, overlayCtx, minimapCanvas, minimapCtx;
let renderDimensionMode = '2d';
let renderer3dInstance = null;
let renderer3dHost = null;
let renderer3dBackgroundVersion = 0;
let renderer3dRotateDrag = null;
const renderer3dTopTextureCache = new Map();
const renderer3dOverlapFadeState = new Map();
const renderer3dSharedAudioTextureCanvases = new Map();
const renderer3dSideTextureAngleState = new Map();
let renderer3dMaskedBackgroundCanvas = null;
let renderer3dMaskedBackgroundCtx = null;
let renderer3dMaskedBackgroundSignature = '';
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
let visibilityGridSmoothedByPlayerCache = new Map();
let visibilityGridSmoothingTickByPlayer = new Map();
let visibilityCacheTick = -1;
let renderer3dSideTextureAngleStateLastPruneVersion = -1;
const VISIBILITY_LIGHT_CELL_SIZE = 4;
const VISIBILITY_LIGHT_NORMALIZATION_RANGE = 6;
const VISIBILITY_LIGHT_MAX_CHANGE_PER_SECOND = VISIBILITY_LIGHT_NORMALIZATION_RANGE;
const VISIBILITY_FADE_MAX_CHANGE_PER_SECOND = VISIBILITY_LIGHT_NORMALIZATION_RANGE * 0.5;
const DEFAULT_SHADOW_DIR_X = -0.42;
const DEFAULT_SHADOW_DIR_Y = 0.31;
let _backgroundTickInterval = null;
let _hiddenLastTickTime = 0;
let _hiddenTickAccumulator = 0;
let _buildMenuRefreshCounter = 0;
let _minimapRefreshCounter = 10;
let _backgroundCacheRefreshCounter = 20;
let _fpsFrameCount = 0, _fpsLastTime = performance.now(), _fpsDisplay = 0;
let _tpsTickCount = 0, _tpsLastTime = performance.now(), _tpsDisplay = 0;
const _litTintCache = new Map();

function get3DRenderOwnerColor(owner) {
    if (Number.isFinite(owner) && owner >= 0 && owner < PLAYER_COLORS.length) return PLAYER_COLORS[owner];
    return '#c8ced8';
}

const DAMAGE_FLASH_TICKS = 10;

function _parseHexColor(color) {
    let normalized = String(color || '').trim();
    let match = normalized.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
    if (!match) return null;
    let hex = match[1];
    if (hex.length === 3) hex = hex.split('').map(ch => ch + ch).join('');
    return {
        r: parseInt(hex.slice(0, 2), 16),
        g: parseInt(hex.slice(2, 4), 16),
        b: parseInt(hex.slice(4, 6), 16)
    };
}

function _rgbToHex(rgb) {
    if (!rgb) return '#ffffff';
    let toHex = (value) => Math.max(0, Math.min(255, Math.round(value || 0))).toString(16).padStart(2, '0');
    return `#${toHex(rgb.r)}${toHex(rgb.g)}${toHex(rgb.b)}`;
}

function _mixHexColors(colorA, colorB, mix) {
    let a = _parseHexColor(colorA) || { r: 200, g: 206, b: 216 };
    let b = _parseHexColor(colorB) || { r: 255, g: 255, b: 255 };
    let t = Math.max(0, Math.min(1, Number(mix) || 0));
    return _rgbToHex({
        r: a.r + (b.r - a.r) * t,
        g: a.g + (b.g - a.g) * t,
        b: a.b + (b.b - a.b) * t
    });
}

function _hexToRgba(color, alpha = 1) {
    let rgb = _parseHexColor(color) || { r: 255, g: 255, b: 255 };
    return `rgba(${rgb.r},${rgb.g},${rgb.b},${Math.max(0, Math.min(1, Number(alpha) || 0))})`;
}

function _getCachedLitTint(baseTint, lightLevel) {
    let tint = String(baseTint || '#c8ced8');
    let bucket = Math.max(0, Math.min(24, Math.round(Math.max(0, Math.min(1, Number(lightLevel) || 0)) * 24)));
    if (bucket >= 24) return tint;
    let key = `${tint}|${bucket}`;
    let cached = _litTintCache.get(key);
    if (cached) return cached;
    let rgb = _parseHexColor(tint);
    if (!rgb) return tint;
    let lightMul = 0.28 + (bucket / 24) * 0.72;
    let lit = _rgbToHex({ r: rgb.r * lightMul, g: rgb.g * lightMul, b: rgb.b * lightMul });
    if (_litTintCache.size > 2048) _litTintCache.clear();
    _litTintCache.set(key, lit);
    return lit;
}

function getDamageFlashColor(target, sourceOwner = null) {
    if (Number.isFinite(sourceOwner) && sourceOwner >= 0 && sourceOwner < PLAYER_COLORS.length) {
        return PLAYER_COLORS[sourceOwner];
    }
    let base = get3DRenderOwnerColor(target && target.owner);
    let rgb = _parseHexColor(base);
    if (!rgb) return '#ffffff';
    return _rgbToHex({ r: 255 - rgb.r, g: 255 - rgb.g, b: 255 - rgb.b });
}

function recordDamageVisual(target, amount, sourceOwner = null) {
    if (!target) return;
    let dmg = Math.max(0, Number(amount) || 0);
    if (dmg <= 0.01) return;
    let maxEnergy = Math.max(1, Number(target.maxEnergy) || 0);
    let scaledStrength = Math.min(1, 0.28 + (dmg / maxEnergy) * 3.5);
    target._damageFlashStart = gameTime;
    target._damageFlashUntil = Math.max(Number(target._damageFlashUntil) || 0, gameTime + DAMAGE_FLASH_TICKS);
    target._damageFlashStrength = Math.max(Number(target._damageFlashStrength) || 0, scaledStrength);
    target._damageFlashColor = getDamageFlashColor(target, sourceOwner);
}

function getDamageFlashState(target) {
    if (!target) return null;
    let until = Number(target._damageFlashUntil) || 0;
    let strength = Number(target._damageFlashStrength) || 0;
    if (until <= 0 || strength <= 0) return null;
    let now = gameTime + tickAlpha;
    if (now >= until) return null;
    let remaining = Math.max(0, until - now);
    let fade = Math.max(0, Math.min(1, remaining / DAMAGE_FLASH_TICKS));
    let eased = Math.pow(fade, 0.65);
    return {
        color: target._damageFlashColor || getDamageFlashColor(target),
        alpha: Math.max(0, Math.min(0.85, strength * eased * 0.7)),
        tintMix: Math.max(0, Math.min(0.8, strength * eased))
    };
}

function get3DDamageFlashTint(target, baseColor) {
    let flash = getDamageFlashState(target);
    if (!flash) return baseColor;
    return _mixHexColors(baseColor, flash.color, flash.tintMix);
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

function get3DConstructionAlpha(entity) {
    if (!entity) return 1;
    if (entity.underConstruction) return 0.25;
    return 1;
}

function get3DConstructionLift(entity) {
    if (!entity) return 0;
    if (entity.underConstruction) return 0.03;
    return 0;
}

function get3DUnitStatusGlyph(unit) {
    if (!unit) return null;
    let energyBlocked = Number.isFinite(unit._energyBlockedUntil) && gameTime < unit._energyBlockedUntil;
    if (unit.workerType === 'astar_collector') {
        return { symbol: unit.carryingValue > 0 ? '★' : '☆', color: unit.carryingValue > 0 ? '#ddd' : '#888' };
    }
    if (unit.carryingValue > 0) {
        return { symbol: '⚡', color: '#fd0' };
    }
    if (unit.workerType === 'builder' && unit.workerState) {
        if (unit.workerState === 'RETURNING_FOR_GOLD') return { symbol: '⚡', color: energyBlocked ? '#f55' : '#fd0' };
        if (unit.workerState === 'MOVING_TO_BUILD' || unit.workerState === 'BUILDING_IN_PLACE') return { symbol: '🔨', color: '#fa0' };
    }
    if (unit.workerType === 'healer' && unit.workerState) {
        if (unit.workerState === 'RETURNING_FOR_GOLD') return { symbol: '⚡', color: energyBlocked ? '#f55' : '#fd0' };
        if (unit.workerState === 'MOVING_TO_HEAL' || unit.workerState === 'HEALING') return { symbol: '+', color: '#fff' };
    }
    if (unit.workerType === 'researcher' && unit.workerState) {
        if (unit.workerState === 'RETURNING_FOR_GOLD' || !unit.researcherHasMaterial) return { symbol: '⚡', color: energyBlocked ? '#f55' : '#fd0' };
        if (unit.workerState === 'MOVING_TO_RESEARCH' || unit.workerState === 'RESEARCHING') return { symbol: 'R', color: '#7bf' };
    }
    return null;
}

function get3DUnitTextureStatus(unit) {
    let bars = [];
    if (unit && unit.energy < unit.maxEnergy) {
        bars.push({ pct: Math.max(0, unit.energy / Math.max(1, unit.maxEnergy)), bgColor: '#600', fillColor: '#0f0' });
    }
    let status = build3DStatusTextureOptions(shouldShowUnitLevels() ? getUnitLevelLabelText(unit) : '', bars);
    let glyph = get3DUnitStatusGlyph(unit);
    if (glyph) {
        status.glyphSymbol = glyph.symbol;
        status.glyphColor = glyph.color;
        status.keySuffix = status.keySuffix ? `${status.keySuffix}|glyph:${glyph.symbol}:${glyph.color}` : `glyph:${glyph.symbol}:${glyph.color}`;
    }
    return status;
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

function get3DSharedAudioTextureKeyForPlayer(owner, variant = 'default') {
    return `shared_audio_player:${Number.isFinite(owner) ? owner : -1}:${variant || 'default'}`;
}

function get3DSharedAudioTextureKeyForMine(kind, variant = 'default') {
    return `shared_audio_mine:${kind || 'default'}:${variant || 'default'}`;
}

function _getAudioTextureCanvasEntry(cacheKey) {
    let entry = renderer3dSharedAudioTextureCanvases.get(cacheKey);
    if (entry) return entry;
    let canvas = document.createElement('canvas');
    canvas.width = RENDERER3D_TOP_TEXTURE_SIZE;
    canvas.height = RENDERER3D_TOP_TEXTURE_SIZE;
    let ctx = canvas.getContext('2d');
    entry = { canvas, ctx, version: -1 };
    renderer3dSharedAudioTextureCanvases.set(cacheKey, entry);
    return entry;
}

function get3DSharedAudioTextureCanvas(cacheKey, variant, baseColor, accentColor, seed = 0) {
    let entry = _getAudioTextureCanvasEntry(cacheKey);
    if (!entry || !entry.ctx) return null;
    let version = Number(audioReactiveTextureVersion) || 0;
    if (entry.version !== version) {
        if (window.Defence3SideAudioVisualizations && typeof window.Defence3SideAudioVisualizations.draw === 'function') {
            window.Defence3SideAudioVisualizations.draw(entry.ctx, { variant, baseColor, accentColor, seed, version });
        } else {
            entry.ctx.clearRect(0, 0, entry.canvas.width, entry.canvas.height);
            entry.ctx.fillStyle = baseColor || '#789';
            entry.ctx.fillRect(0, 0, entry.canvas.width, entry.canvas.height);
        }
        entry.canvas._textureVersion = version;
        entry.version = version;
    }
    return entry.canvas;
}

function _get3DSideAccentColorForOwner(owner, extraColor = null) {
    let oppositeOwner = Number.isFinite(owner) && PLAYER_COLORS.length > 1
        ? ((owner + 1) % PLAYER_COLORS.length)
        : -1;
    let accentColor = oppositeOwner >= 0 ? PLAYER_COLORS[oppositeOwner] : '#ffffff';
    if (extraColor) accentColor = _mixHexColors(accentColor, extraColor, 0.45);
    return accentColor;
}

function get3DSideAudioTextureForPlayer(owner, variant = 'unit_default', seed = 0, extraColor = null) {
    let ownerColor = get3DRenderOwnerColor(owner);
    let accentColor = _get3DSideAccentColorForOwner(owner, extraColor);
    return get3DSharedAudioTextureCanvas(get3DSharedAudioTextureKeyForPlayer(owner, variant), variant, ownerColor, accentColor, seed);
}

function get3DSideAudioTextureForMine(kind, variant, baseColor, accentColor, seed = 0) {
    return get3DSharedAudioTextureCanvas(get3DSharedAudioTextureKeyForMine(kind, variant), variant, baseColor, accentColor, seed);
}

function get3DUnitSideVisualizationVariant(unit) {
    let unitType = String((unit && unit.unitType) || 'norm');
    switch (unitType) {
        case 'collector': return 'collector';
        case 'astar_collector': return 'astar_collector';
        case 'builder_unit': return 'builder_unit';
        case 'healer_unit': return 'healer_unit';
        case 'researcher_unit': return 'researcher_unit';
        case 'salvager_unit': return 'salvager_unit';
        case 'king': return 'king';
        case 'snake': return 'snake';
        case 'flying':
        case 'scout': return 'tower_watch';
        case 'tank':
        case 'boss': return 'barrack';
        case 'fire_resistant': return 'tower_fire';
        case 'water_resistant': return 'tower_water';
        case 'ice_resistant': return 'tower_ice';
        case 'poison_resistant': return 'tower_poison';
        case 'laser_resistant': return 'tower_laser';
        default: return 'unit_default';
    }
}

function get3DTowerSideVisualizationVariant(tower) {
    switch (String((tower && tower.type) || '')) {
        case 'watch_tower': return 'tower_watch';
        case 'laser': return 'tower_laser';
        case 'sniper': return 'tower_sniper';
        case 'fire': return 'tower_fire';
        case 'water': return 'tower_water';
        case 'poison': return 'tower_poison';
        case 'ice': return 'tower_ice';
        case 'sand_gun': return 'tower_sand';
        case 'elements': return 'tower_elements';
        default: return 'tower_default';
    }
}

function get3DSpawnerSideVisualizationVariant(spawner) {
    switch (String((spawner && spawner.type) || '')) {
        case 'astar_spawner': return 'spawner_astar';
        case 'salvager': return 'spawner_salvager';
        case 'builder_spawner': return 'builder_unit';
        case 'healer_spawner': return 'spawner_healer';
        case 'research': return 'spawner_research';
        default: return 'spawner_energy';
    }
}

function get3DFloorItemSideVisualizationVariant(item) {
    switch (String((item && item.type) || '')) {
        case 'farm': return 'farm';
        case 'astar_farm': return 'astar_farm';
        case 'mine': return 'floor_mine';
        case 'lava': return 'lava';
        case 'water_puddle': return 'water_puddle';
        case 'poison_puddle': return 'poison_puddle';
        case 'ice_patch': return 'ice_patch';
        case 'sand': return 'tower_sand';
        case 'house': return 'house';
        default: return 'unit_default';
    }
}

function draw3DSpriteIntoTopTexture(g, sprite, inset = 8) {
    if (!g || !sprite) return;
    let canvasSize = g.canvas && g.canvas.width ? g.canvas.width : RENDERER3D_TOP_TEXTURE_SIZE;
    let size = Math.max(8, canvasSize - inset * 2);
    g.drawImage(sprite, inset, inset, size, size);
}

function get3DUnitTopTexture(unitOrType, owner, statusOptions = null) {
    let unitType = typeof unitOrType === 'string' ? unitOrType : (unitOrType && unitOrType.unitType);
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
        } else if (vis === 'snake') {
            g.fillStyle = color;
            g.beginPath();
            g.ellipse(size * 0.5, size * 0.48, size * 0.16, size * 0.22, 0, 0, Math.PI * 2);
            g.fill();
            g.strokeStyle = '#111';
            g.lineWidth = 2;
            g.beginPath();
            g.ellipse(size * 0.5, size * 0.48, size * 0.16, size * 0.22, 0, 0, Math.PI * 2);
            g.stroke();
            g.fillStyle = '#111';
            g.beginPath();
            g.arc(size * 0.46, size * 0.42, Math.max(1.5, size * 0.018), 0, Math.PI * 2);
            g.fill();
            g.beginPath();
            g.arc(size * 0.54, size * 0.42, Math.max(1.5, size * 0.018), 0, Math.PI * 2);
            g.fill();
            g.strokeStyle = '#f66';
            g.lineWidth = Math.max(1, Math.round(size * 0.015));
            g.beginPath();
            g.moveTo(size * 0.5, size * 0.62);
            g.lineTo(size * 0.47, size * 0.69);
            g.moveTo(size * 0.5, size * 0.62);
            g.lineTo(size * 0.53, size * 0.69);
            g.stroke();
        } else if (vis === 'star') {
            if (unitType === 'collector' || unitType === 'astar_collector') {
                g.font = `700 ${Math.round(size * 0.34)}px Arial`;
                g.textAlign = 'center';
                g.textBaseline = 'middle';
                g.fillStyle = unitType === 'collector' ? '#ffd34d' : '#f4f4f4';
                g.fillText(unitType === 'collector' ? '⚡' : '★', size * 0.5, size * 0.52);
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
        if (statusOptions && statusOptions.glyphSymbol) {
            g.textAlign = 'center';
            g.textBaseline = 'middle';
            g.font = `700 ${Math.max(11, Math.round(size * 0.2))}px Segoe UI Emoji, Segoe UI Symbol, Segoe UI, Arial, sans-serif`;
            g.fillStyle = statusOptions.glyphColor || '#fff';
            g.fillText(String(statusOptions.glyphSymbol), size * 0.5, size * 0.26);
        }
        draw3DTopTextureStatus(g, statusOptions);
    });
}

function get3DSnakeBodyTopTexture(owner, segmentIndex = 0) {
    let ownerColor = get3DRenderOwnerColor(owner);
    let shade = Math.max(0, Math.min(255, 120 - segmentIndex * 8));
    let stripe = `rgb(${shade},${Math.max(40, shade - 30)},${Math.max(20, shade - 60)})`;
    let key = `snake_body:${owner}:${segmentIndex}`;
    return get3DTopTextureCanvas(key, (g) => {
        let size = g.canvas.width;
        let inset = Math.round(size * 0.12);
        let innerSize = size - inset * 2;
        g.fillStyle = 'rgba(0,0,0,0.45)';
        g.fillRect(inset, inset, innerSize, innerSize);
        g.strokeStyle = ownerColor;
        g.lineWidth = 3;
        g.strokeRect(inset + 0.5, inset + 0.5, innerSize - 1, innerSize - 1);
        g.fillStyle = '#0f0';
        g.fillRect(size * 0.28, size * 0.28, size * 0.44, size * 0.44);
        g.fillStyle = stripe;
        g.fillRect(size * 0.28, size * 0.34, size * 0.44, size * 0.1);
        g.fillRect(size * 0.28, size * 0.56, size * 0.44, size * 0.08);
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
    let overlays = { lines: [], rings: [], rects: [], areaTiles: [], markers: [], bars: [], texts: [] };
    let activeSelectedEntities = getActiveEntities();
    let activeSelectedUnits = getActiveUnits();
    let bakeHudIntoTopTexture = true;
    let pushLine = (x1, y1, x2, y2, color, dashed = false) => overlays.lines.push({ x1: x1 / TILE, z1: y1 / TILE, x2: x2 / TILE, z2: y2 / TILE, color, dashed });
    let pushMarker = (x, y, kind, color) => overlays.markers.push({ x: x / TILE, z: y / TILE, kind, color });
    let pushRing = (x, y, radiusPx, strokeColor, fillColor = null, dashed = false) => overlays.rings.push({ x: x / TILE, z: y / TILE, radius: radiusPx / TILE, strokeColor, fillColor, dashed });
    let pushAreaTiles = (wx, wy, rangeArea, strokeColor, fillColor = null, dashed = false) => {
        let cells = getAreaRangeCellsAtWorld(wx, wy, rangeArea);
        for (let i = 0; i < cells.length; i++) {
            let cell = cells[i];
            if (!cell) continue;
            overlays.areaTiles.push({ x: cell.x, y: cell.y, strokeColor, fillColor, dashed });
        }
    };
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
    let pushSalvageCross = (worldX, worldY) => {
        let span = TILE * 0.34;
        pushLine(worldX - span, worldY - span, worldX + span, worldY + span, '#f44');
        pushLine(worldX + span, worldY - span, worldX - span, worldY + span, '#f44');
    };
    for (let ent of activeSelectedEntities) {
        if (!ent || (ent.energy !== undefined && ent.energy <= 0)) continue;
        let ex = ent.x || (ent.gx * TILE + TILE * 0.5);
        let ey = ent.y || (ent.gy * TILE + TILE * 0.5);
        if (showSelectionOutlinesForBuildings()) pushRect(ex, ey, 18, 18, get3DRenderOwnerColor(ent.owner), selectionOutlineType === OVERLAY_LINE_DOTTED);

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
            let visArea = getEntityVisibilityRangeArea(ent);
            if (Number.isFinite(visArea) && visArea > 0) pushAreaTiles(ex, ey, visArea, 'rgba(120,255,120,0.55)', 'rgba(120,255,120,0.18)');
        }
    }

    if (showSelectionOutlinesForUnits()) {
        for (let u of activeSelectedUnits) {
            if (!u || u.dead) continue;
            let ux = Number.isFinite(u.prevX) ? (u.prevX + (u.x - u.prevX) * alpha) : u.x;
            let uy = Number.isFinite(u.prevY) ? (u.prevY + (u.y - u.prevY) * alpha) : u.y;
            pushRing(ux, uy, (Number(u.r) || 8) + 4, get3DRenderOwnerColor(u.owner), null, selectionOutlineType === OVERLAY_LINE_DOTTED);
        }
    }

    if (renderRangeMode === RENDER_RANGE_TURRETS_AND_UNITS) {
        for (let u of activeSelectedUnits) {
            if (!u || u.dead) continue;
            let rangeArea = getUnitRenderActionRangeArea(u);
            if (rangeArea <= 0) continue;
            let ux = Number.isFinite(u.prevX) ? (u.prevX + (u.x - u.prevX) * alpha) : u.x;
            let uy = Number.isFinite(u.prevY) ? (u.prevY + (u.y - u.prevY) * alpha) : u.y;
            pushAreaTiles(ux, uy, rangeArea, 'rgba(120,220,255,0.5)', 'rgba(120,220,255,0.18)');
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
                if (showRallyLinesForUnits()) pushLine(ux, uy, destX, destY, color, rallyLineType === OVERLAY_LINE_DOTTED);
                pushMarker(destX, destY, 'plus', u.commandState === CMD_ATTACK_MOVING ? '#f66' : '#4f4');
            }
        }
        if (u.targetUnit && !u.targetUnit.dead && u.commandState === CMD_ATTACKING) {
            pushLine(ux, uy, u.targetUnit.x, u.targetUnit.y, 'rgba(255,0,0,0.6)');
        } else if (u.targetBuilding && u.targetBuilding.energy > 0 && u.commandState === CMD_ATTACKING) {
            pushLine(ux, uy, u.targetBuilding.x, u.targetBuilding.y, 'rgba(255,0,0,0.6)');
        }
    }

    for (let t of towers) {
        if (t.gx < bounds.minGx - 1 || t.gx > bounds.maxGx + 1 || t.gy < bounds.minGy - 1 || t.gy > bounds.maxGy + 1) continue;
        if (!fullVisibility && (!visibilityGrid[t.gy] || visibilityGrid[t.gy][t.gx] === 0)) continue;
        if (t.markedForSalvage) pushSalvageCross(t.x, t.y);
    }

    for (let b of barracks) {
        if (b.gx < bounds.minGx || b.gx > bounds.maxGx || b.gy < bounds.minGy || b.gy > bounds.maxGy) continue;
        if (!fullVisibility && (!visibilityGrid[b.gy] || visibilityGrid[b.gy][b.gx] === 0)) continue;
        if (b.markedForSalvage) pushSalvageCross(b.x, b.y);
    }

    for (let s of collectorSpawners) {
        if (s.gx < bounds.minGx || s.gx > bounds.maxGx || s.gy < bounds.minGy || s.gy > bounds.maxGy) continue;
        if (!fullVisibility && (!visibilityGrid[s.gy] || visibilityGrid[s.gy][s.gx] === 0)) continue;
        if (s.markedForSalvage) pushSalvageCross(s.x, s.y);
    }

    for (let y = bounds.minGy; y <= bounds.maxGy; y++) {
        let gridRow = grid[y];
        let visRow = visibilityGrid[y];
        if (!gridRow) continue;
        for (let x = bounds.minGx; x <= bounds.maxGx; x++) {
            let cell = gridRow[x];
            if (!cell || !cell.item) continue;
            if (!fullVisibility && (!visRow || visRow[x] === 0)) continue;
            if (cell.item.markedForSalvage) pushSalvageCross(x * TILE + TILE * 0.5, y * TILE + TILE * 0.5);
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
    let ox = Number(object.x) || 0;
    let oz = Number(object.z) || 0;
    let gx = Math.floor(ox);
    let gy = Math.floor(oz);
    let lightRawCenter = fullVisibility ? VISIBILITY_LIGHT_NORMALIZATION_RANGE : ((visibilityGrid[gy] && visibilityGrid[gy][gx]) || 0);
    let lightLevel = fullVisibility ? 1 : Math.max(0, Math.min(1, lightRawCenter / VISIBILITY_LIGHT_NORMALIZATION_RANGE));
    // Bilinear interpolation of gradient across 4 surrounding tile corners to avoid boundary jumps
    let shadowDirX = DEFAULT_SHADOW_DIR_X;
    let shadowDirZ = DEFAULT_SHADOW_DIR_Y;
    if (!fullVisibility) {
        let fx = ox - gx, fz = oz - gy;
        let ifx = 1 - fx, ifz = 1 - fz;
        let _vis = visibilityGrid;
        let g00x = ((_vis[gy] && _vis[gy][gx+1])||0) - ((_vis[gy] && _vis[gy][gx-1])||0);
        let g00z = ((_vis[gy+1] && _vis[gy+1][gx])||0) - ((_vis[gy-1] && _vis[gy-1][gx])||0);
        let g10x = ((_vis[gy] && _vis[gy][gx+2])||0) - ((_vis[gy] && _vis[gy][gx])||0);
        let g10z = ((_vis[gy+1] && _vis[gy+1][gx+1])||0) - ((_vis[gy-1] && _vis[gy-1][gx+1])||0);
        let g01x = ((_vis[gy+1] && _vis[gy+1][gx+1])||0) - ((_vis[gy+1] && _vis[gy+1][gx-1])||0);
        let g01z = ((_vis[gy+2] && _vis[gy+2][gx])||0) - ((_vis[gy] && _vis[gy][gx])||0);
        let g11x = ((_vis[gy+1] && _vis[gy+1][gx+2])||0) - ((_vis[gy+1] && _vis[gy+1][gx])||0);
        let g11z = ((_vis[gy+2] && _vis[gy+2][gx+1])||0) - ((_vis[gy] && _vis[gy][gx+1])||0);
        let gradX = g00x*ifx*ifz + g10x*fx*ifz + g01x*ifx*fz + g11x*fx*fz;
        let gradZ = g00z*ifx*ifz + g10z*fx*ifz + g01z*ifx*fz + g11z*fx*fz;
        let gradLen = Math.hypot(gradX, gradZ);
        if (gradLen > 0.001) { shadowDirX = gradX / gradLen; shadowDirZ = gradZ / gradLen; }
    }
    let finalLightLevel = Math.max(0, Math.min(1, Number(object.lightLevel) || lightLevel));
    let _resolveVisionRangeFromSource = (source) => {
        if (!source) return NaN;
        if (typeof getEntityVisibilityRangeTiles === 'function') {
            let sharedTiles = Number(getEntityVisibilityRangeTiles(source));
            if (Number.isFinite(sharedTiles)) return sharedTiles;
        }
        if (source.currentStats && Number.isFinite(source.currentStats.visionRangeArea)) return Number(source.currentStats.visionRangeArea) * AREA_UNIT_TILE_EQUIVALENT;
        if (Number.isFinite(source.visionRangeArea)) return Number(source.visionRangeArea) * AREA_UNIT_TILE_EQUIVALENT;
        if (Number.isFinite(source.baseLevelVisionRangeArea)) return Number(source.baseLevelVisionRangeArea) * AREA_UNIT_TILE_EQUIVALENT;
        if (Number.isFinite(source.baseVisionRangeArea)) return Number(source.baseVisionRangeArea) * AREA_UNIT_TILE_EQUIVALENT;
        if (source.currentStats && Number.isFinite(source.currentStats.visionRange)) return Number(source.currentStats.visionRange);
        if (Number.isFinite(source.baseLevelVisionRange)) return Number(source.baseLevelVisionRange);
        if (Number.isFinite(source.visionRange)) return Number(source.visionRange);

        let ownerId = Number(source.owner);
        if (!Number.isFinite(ownerId)) ownerId = 0;

        if (source.unitType) {
            let unitType = String(source.unitType || 'norm');
            let unitLevel = 1;
            if (typeof getDisplayLevel === 'function') {
                unitLevel = Math.max(1, Math.floor(Number(getDisplayLevel(source)) || 1));
            }
            if (typeof getUnitStatForOwner === 'function') {
                let unitVision = Number(getUnitStatForOwner(ownerId, unitType, unitLevel, 'visionRange'));
                if (Number.isFinite(unitVision)) return unitVision;
            }
            return Number((BASE_UNIT_STATS[unitType] || BASE_UNIT_STATS.norm || {}).visionRange);
        }

        if (source.type) {
            let buildingType = String(source.type || '');
            if (buildingType === 'barrack') {
                buildingType = `barrack_${String(source.unitType || 'norm')}`;
            }
            let buildingLevel = 1;
            if (typeof getDisplayLevel === 'function') {
                buildingLevel = Math.max(1, Math.floor(Number(getDisplayLevel(source)) || 1));
            }
            if (typeof getBuildingStatForOwner === 'function') {
                let buildingVision = Number(getBuildingStatForOwner(ownerId, buildingType, buildingLevel, 'visionRange'));
                if (Number.isFinite(buildingVision)) return buildingVision;
            }
            return Number((BASE_CARD_TYPES[buildingType] || {}).visionRange);
        }

        return NaN;
    };
    let visionRange = Number(object.visibilityRangeTiles);
    if (!Number.isFinite(visionRange)) visionRange = Number(object.visionRange);
    if (!Number.isFinite(visionRange)) visionRange = _resolveVisionRangeFromSource(object.visibilitySource);
    let resolvedScaleY = Math.max(0.05, Number(object.scaleY) || 0.05);
    if (Number.isFinite(visionRange) && visionRange > 0) {
        let visibilityHeight = Math.max(0.18, visionRange / 5);
        resolvedScaleY = Math.max(0.05, resolvedScaleY * visibilityHeight);
    }
    let tint = _getCachedLitTint(object.tint || '#c8ced8', finalLightLevel);
    let sideTint = _getCachedLitTint(object.sideTint || object.tint || '#c8ced8', finalLightLevel);
    target.push({
        modelKey: object.modelKey || 'cube',
        modelCandidates: Array.isArray(object.modelCandidates) ? object.modelCandidates.slice() : [],
        x: Number(object.x) || 0,
        z: Number(object.z) || 0,
        y: Number(object.y) || 0,
        scaleX: Math.max(0.05, Number(object.scaleX) || 0.05),
        scaleY: resolvedScaleY,
        scaleZ: Math.max(0.05, Number(object.scaleZ) || 0.05),
        rotationY: Number(object.rotationY) || 0,
        tint,
        sideTint,
        alpha: Math.max(0.05, Math.min(1, Number(object.alpha) || 1)),
        renderShape: object.renderShape === 'cylinder' ? 'cylinder' : 'box',
        topTextureKey: object.topTextureKey || '',
        topTextureCanvas: object.topTextureCanvas || null,
        sideTextureKey: object.sideTextureKey || '',
        sideTextureCanvas: object.sideTextureCanvas || null,
        sideTextureAngle: Number.isFinite(object.sideTextureAngle) ? Number(object.sideTextureAngle) : 0,
        lightLevel: finalLightLevel,
        shadowDirX: Number.isFinite(object.shadowDirX) ? Number(object.shadowDirX) : shadowDirX,
        shadowDirZ: Number.isFinite(object.shadowDirZ) ? Number(object.shadowDirZ) : shadowDirZ,
        shadowLength: Math.max(0.6, Math.min(2.4, Number(object.shadowLength) || (1 + (1 - lightLevel) * 0.9)))
    });
}

function drawWithTrackedContextTransform(ctx, centerX, centerY, offsetX, offsetY, scale, drawFn) {
    if (!ctx || typeof drawFn !== 'function') return;
    let drawScale = Number.isFinite(scale) ? scale : 1;
    let dx = Number.isFinite(offsetX) ? offsetX : 0;
    let dy = Number.isFinite(offsetY) ? offsetY : 0;
    if (Math.abs(dx) < 0.001 && Math.abs(dy) < 0.001 && Math.abs(drawScale - 1) < 0.0001) {
        drawFn();
        return;
    }

    let st = _captureDrawImageCtxState(ctx);
    ctx.save();
    ctx.translate(centerX + dx, centerY + dy);
    ctx.scale(drawScale, drawScale);
    ctx.translate(-centerX, -centerY);
    let nextTransform = ctx.getTransform();
    _setDrawImageTrackedTransform(ctx, nextTransform.a, nextTransform.b, nextTransform.c, nextTransform.d, nextTransform.e, nextTransform.f);
    drawFn();
    ctx.restore();
    _setDrawImageTrackedTransform(ctx, st.ta, st.tb, st.tc, st.td, st.te, st.tf);
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

function get3DBackgroundCanvasWithVisibilityMask(sourceCanvas, backgroundPixelBounds) {
    if (!sourceCanvas) return sourceCanvas;
    if (fullVisibility) return sourceCanvas;
    if (typeof rebuildVisibilityMaskCacheIfNeeded !== 'function') return sourceCanvas;

    rebuildVisibilityMaskCacheIfNeeded();
    if (typeof _visibilityMaskCanvas === 'undefined' || !_visibilityMaskCanvas) return sourceCanvas;

    if (!renderer3dMaskedBackgroundCanvas || renderer3dMaskedBackgroundCanvas.width !== sourceCanvas.width || renderer3dMaskedBackgroundCanvas.height !== sourceCanvas.height) {
        renderer3dMaskedBackgroundCanvas = document.createElement('canvas');
        renderer3dMaskedBackgroundCanvas.width = sourceCanvas.width;
        renderer3dMaskedBackgroundCanvas.height = sourceCanvas.height;
        renderer3dMaskedBackgroundCtx = renderer3dMaskedBackgroundCanvas.getContext('2d');
        renderer3dMaskedBackgroundSignature = '';
    }

    if (!renderer3dMaskedBackgroundCtx) return sourceCanvas;

    let minX = Math.max(0, Math.floor((backgroundPixelBounds && backgroundPixelBounds.minX) || 0));
    let minY = Math.max(0, Math.floor((backgroundPixelBounds && backgroundPixelBounds.minY) || 0));
    let maxX = Math.min(WORLD_W, Math.ceil((backgroundPixelBounds && backgroundPixelBounds.maxX) || WORLD_W));
    let maxY = Math.min(WORLD_H, Math.ceil((backgroundPixelBounds && backgroundPixelBounds.maxY) || WORLD_H));
    let sw = Math.max(1, maxX - minX);
    let sh = Math.max(1, maxY - minY);

    let signature = [
        renderer3dBackgroundVersion,
        Number.isFinite(visibilityVersion) ? visibilityVersion : 0,
        minX,
        minY,
        sw,
        sh,
        sourceCanvas.width,
        sourceCanvas.height
    ].join('|');

    if (renderer3dMaskedBackgroundSignature !== signature) {
        renderer3dMaskedBackgroundCtx.clearRect(0, 0, sourceCanvas.width, sourceCanvas.height);
        renderer3dMaskedBackgroundCtx.drawImage(sourceCanvas, 0, 0);
        renderer3dMaskedBackgroundCtx.drawImage(_visibilityMaskCanvas, minX, minY, sw, sh, 0, 0, sourceCanvas.width, sourceCanvas.height);
        renderer3dMaskedBackgroundSignature = signature;
    }

    return renderer3dMaskedBackgroundCanvas;
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
    let sourceBackgroundCanvas = bgCanvas || canvas;
    let backgroundCanvasFor3D = get3DBackgroundCanvasWithVisibilityMask(sourceBackgroundCanvas, {
        minX: backgroundMinX,
        minY: backgroundMinY,
        maxX: backgroundMaxX,
        maxY: backgroundMaxY
    });
    let backgroundVersionFor3D = renderer3dBackgroundVersion;
    if (!fullVisibility) {
        let visVersion = Number.isFinite(visibilityVersion) ? visibilityVersion : 0;
        backgroundVersionFor3D = renderer3dBackgroundVersion * 1000000 + (visVersion % 1000000);
    }
    let overlays = build3DOverlayData(bounds, alpha);
    let soundGrid = audioSpatialGrid;
    let bgSoundGrid = audioSpatialGridBackground;
    let fxSoundGrid = audioSpatialGridEffects;
    let reactiveOffsetX = Number(audioReactiveGlobalOffsetX) || 0;
    let reactiveOffsetY = Number(audioReactiveGlobalOffsetY) || 0;
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
    let getSnakePathPoints = (unit, headX, headY) => {
        let points = [{ x: headX, y: headY }];
        if (!unit || !Array.isArray(unit.snakeHistory) || unit.snakeHistory.length <= 0) return points;
        let lastX = headX;
        let lastY = headY;
        let minSpacing = Math.max(6, (Number(unit.r) || 7) * 1.1);
        for (let point of unit.snakeHistory) {
            if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) continue;
            if (Math.hypot(point.x - lastX, point.y - lastY) < minSpacing) continue;
            points.push({ x: point.x, y: point.y });
            lastX = point.x;
            lastY = point.y;
            if (points.length >= 7) break;
        }
        return points;
    };
    let getTileLightLevel = (gx, gy) => {
        if (fullVisibility) return 1;
        let raw = (visibilityGrid[gy] && visibilityGrid[gy][gx]) || 0;
        return Math.max(0, Math.min(1, raw / VISIBILITY_LIGHT_NORMALIZATION_RANGE));
    };
    let getAudioReactiveSideTextureAngle = (gx, gy, seed = 0) => {
        const LEVEL_SMOOTHING = 0.14;
        const BASE_ANGLE_DELTA = 0.004;
        const AUDIO_ANGLE_DELTA_SCALE = 0.026;
        const MAX_SPEED_DELTA_PER_STEP = 0.004;
        let sampleLevel = (gridRef, sx, sy) => {
            let row = gridRef && gridRef[sy];
            return row ? (Number(row[sx]) || 0) : 0;
        };
        let version = Number(audioReactiveTextureVersion) || 0;
        let key = String(seed);
        let state = renderer3dSideTextureAngleState.get(key);
        if (!state) {
            state = {
                angle: (((Number(seed) || 0) * 0.61803398875) % 1) * Math.PI * 2,
                smoothedLevel: sampleLevel(bgSoundGrid, gx, gy) * 0.7 + sampleLevel(fxSoundGrid, gx, gy) * 0.5,
                lastLevel: sampleLevel(bgSoundGrid, gx, gy) * 0.7 + sampleLevel(fxSoundGrid, gx, gy) * 0.5,
                speed: BASE_ANGLE_DELTA,
                version,
                lastTouchedVersion: version
            };
            renderer3dSideTextureAngleState.set(key, state);
        }
        let currentLevel = sampleLevel(bgSoundGrid, gx, gy) * 0.7 + sampleLevel(fxSoundGrid, gx, gy) * 0.5;
        if (state.version !== version) {
            state.smoothedLevel += (currentLevel - state.smoothedLevel) * LEVEL_SMOOTHING;
            state.smoothedLevel = Math.max(0, Math.min(1, state.smoothedLevel));
            let targetSpeed = BASE_ANGLE_DELTA + state.smoothedLevel * AUDIO_ANGLE_DELTA_SCALE;
            let speedDelta = targetSpeed - state.speed;
            if (speedDelta > MAX_SPEED_DELTA_PER_STEP) speedDelta = MAX_SPEED_DELTA_PER_STEP;
            if (speedDelta < -MAX_SPEED_DELTA_PER_STEP) speedDelta = -MAX_SPEED_DELTA_PER_STEP;
            state.speed = Math.max(BASE_ANGLE_DELTA, state.speed + speedDelta);
            state.angle += state.speed;
            state.lastLevel = currentLevel;
            state.version = version;
        }
        state.lastTouchedVersion = version;
        if (renderer3dSideTextureAngleState.size > 512 && renderer3dSideTextureAngleStateLastPruneVersion !== version) {
            renderer3dSideTextureAngleStateLastPruneVersion = version;
            for (let [stateKey, entry] of renderer3dSideTextureAngleState.entries()) {
                if (version - (Number(entry.lastTouchedVersion) || 0) > 64) renderer3dSideTextureAngleState.delete(stateKey);
            }
        }
        return state.angle;
    };
    let pushSnakeRenderObjects = (target, unit, headX, headY, footprint, unitStatus) => {
        let points = getSnakePathPoints(unit, headX, headY);
        let ownerTint = get3DDamageFlashTint(unit, get3DRenderOwnerColor(unit.owner));
        for (let i = points.length - 1; i >= 1; i--) {
            let point = points[i];
            let prev = points[i - 1];
            let pointGx = Math.max(0, Math.min(GRID_W - 1, Math.floor(point.x / TILE)));
            let pointGy = Math.max(0, Math.min(GRID_H - 1, Math.floor(point.y / TILE)));
            let age = i / Math.max(1, points.length - 1);
            let dx = prev.x - point.x;
            let dy = prev.y - point.y;
            let segmentLen = Math.max(0.18, Math.min(0.55, Math.hypot(dx, dy) / TILE * 0.9));
            let width = Math.max(0.14, footprint * (0.55 - age * 0.2));
            push3DRenderObject(target, {
                modelKey: 'snake_segment',
                x: point.x / TILE,
                y: getUnitHeightOffset(unit) * (0.6 - age * 0.12),
                z: point.y / TILE,
                scaleX: width,
                scaleY: Math.max(0.12, width * 0.42),
                scaleZ: Math.max(width * 0.9, segmentLen),
                rotationY: Math.atan2(dx, dy),
                tint: ownerTint,
                alpha: Math.max(0.35, 0.78 - age * 0.18),
                renderShape: 'cylinder',
                topTextureKey: `snake_body:${unit.owner}:${i}`,
                topTextureCanvas: get3DSnakeBodyTopTexture(unit.owner, i),
                sideTextureKey: get3DSharedAudioTextureKeyForPlayer(unit.owner, 'snake_segment'),
                sideTextureCanvas: get3DSideAudioTextureForPlayer(unit.owner, 'snake_segment', (Number(unit.owner) || 0) + i, '#3dff64'),
                sideTint: get3DDamageFlashTint(unit, '#3dff64'),
                sideTextureAngle: getAudioReactiveSideTextureAngle(pointGx, pointGy, (Number(unit.id) || 0) * 131 + i)
            });
        }
        push3DRenderObject(target, {
            modelKey: `unit_${unit.unitType || 'snake'}`,
            x: headX / TILE,
            y: getUnitHeightOffset(unit),
            z: headY / TILE,
            scaleX: footprint,
            scaleY: Math.max(0.24, footprint * 0.52),
            scaleZ: Math.max(0.34, footprint * 1.3),
            visibilitySource: unit,
            rotationY: Math.atan2(Number(unit.vx) || 0, Number(unit.vy) || 1),
            tint: ownerTint,
            renderShape: 'cylinder',
            topTextureKey: `unit:${unit.unitType}:${unit.owner}:${unitStatus.keySuffix}`,
            topTextureCanvas: get3DUnitTopTexture(unit, unit.owner, unitStatus),
            sideTextureKey: get3DSharedAudioTextureKeyForPlayer(unit.owner, 'snake'),
            sideTextureCanvas: get3DSideAudioTextureForPlayer(unit.owner, 'snake', Number(unit.owner) || 0, '#3dff64'),
            sideTint: get3DDamageFlashTint(unit, '#3dff64'),
            sideTextureAngle: getAudioReactiveSideTextureAngle(Math.floor(headX / TILE), Math.floor(headY / TILE), (Number(unit.id) || 0) * 131 + 97)
        });
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
        let bgSoundRow = bgSoundGrid[m.gy];
        let fxSoundRow = fxSoundGrid[m.gy];
        let bgLevel = bgSoundRow ? bgSoundRow[m.gx] || 0 : 0;
        let fxLevel = fxSoundRow ? fxSoundRow[m.gx] || 0 : 0;
        let audioMove = bgLevel * AUDIO_REACTIVE_RENDER_3D_POSITION_FROM_BG + fxLevel * AUDIO_REACTIVE_RENDER_3D_POSITION_FROM_SFX;
        let audioHeight = bgLevel * AUDIO_REACTIVE_RENDER_3D_HEIGHT_FROM_BG + fxLevel * AUDIO_REACTIVE_RENDER_3D_HEIGHT_FROM_SFX;
        push3DRenderObject(objects, {
            modelKey: m.gold > 0 ? 'gold_mine_active' : 'gold_mine_empty',
            x: m.gx + 0.5 + reactiveOffsetX * audioMove,
            z: m.gy + 0.5 + reactiveOffsetY * audioMove,
            y: 0,
            scaleX: 0.9,
            scaleY: 0.35 * getOverlapFlattenScaleForTile(m.gx, m.gy) * (1 + audioHeight),
            scaleZ: 0.9,
            heightMode: 'mine',
            tint: '#f0c83a',
            alpha: 1,
            topTextureKey: `gold_mine:${m.gold > 0 ? 'active' : 'empty'}`,
            topTextureCanvas: get3DTopTextureCanvas(`gold_mine:${m.gold > 0 ? 'active' : 'empty'}`, (g) => {
                draw3DSpriteIntoTopTexture(g, _getGoldMineTileSprite(m.gold > 0), 8);
            }),
            sideTextureKey: get3DSharedAudioTextureKeyForMine('gold', 'gold_mine'),
            sideTextureCanvas: get3DSideAudioTextureForMine('gold', 'gold_mine', '#f0c83a', '#fff2a8', 11),
            sideTint: '#f0c83a'
        });
    }

    for (let m of astarMines) {
        if (m.gx < bounds.minGx || m.gx > bounds.maxGx || m.gy < bounds.minGy || m.gy > bounds.maxGy) continue;
        if (!fullVisibility && (!visibilityGrid[m.gy] || visibilityGrid[m.gy][m.gx] === 0)) continue;
        let bgSoundRow = bgSoundGrid[m.gy];
        let fxSoundRow = fxSoundGrid[m.gy];
        let bgLevel = bgSoundRow ? bgSoundRow[m.gx] || 0 : 0;
        let fxLevel = fxSoundRow ? fxSoundRow[m.gx] || 0 : 0;
        let audioMove = bgLevel * AUDIO_REACTIVE_RENDER_3D_POSITION_FROM_BG + fxLevel * AUDIO_REACTIVE_RENDER_3D_POSITION_FROM_SFX;
        let audioHeight = bgLevel * AUDIO_REACTIVE_RENDER_3D_HEIGHT_FROM_BG + fxLevel * AUDIO_REACTIVE_RENDER_3D_HEIGHT_FROM_SFX;
        push3DRenderObject(objects, {
            modelKey: m.astar > 0 ? 'astar_mine_active' : 'astar_mine_empty',
            x: m.gx + 0.5 + reactiveOffsetX * audioMove,
            z: m.gy + 0.5 + reactiveOffsetY * audioMove,
            y: 0,
            scaleX: 0.9,
            scaleY: 0.35 * getOverlapFlattenScaleForTile(m.gx, m.gy) * (1 + audioHeight),
            scaleZ: 0.9,
            heightMode: 'mine',
            tint: '#d8d8e8',
            alpha: 1,
            topTextureKey: `astar_mine:${m.astar > 0 ? 'active' : 'empty'}`,
            topTextureCanvas: get3DTopTextureCanvas(`astar_mine:${m.astar > 0 ? 'active' : 'empty'}`, (g) => {
                g.fillStyle = '#888'; g.beginPath(); g.arc(32, 32, 18, 0, Math.PI * 2); g.fill();
                g.fillStyle = '#fff'; g.font = 'bold 28px Arial'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('★', 32, 33);
            }),
            sideTextureKey: get3DSharedAudioTextureKeyForMine('astar', 'astar_mine'),
            sideTextureCanvas: get3DSideAudioTextureForMine('astar', 'astar_mine', '#d8d8e8', '#ffffff', 23),
            sideTint: '#d8d8e8'
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
            let bgSoundRow = bgSoundGrid[y];
            let fxSoundRow = fxSoundGrid[y];
            let bgLevel = bgSoundRow ? bgSoundRow[x] || 0 : 0;
            let fxLevel = fxSoundRow ? fxSoundRow[x] || 0 : 0;
            let audioMove = bgLevel * AUDIO_REACTIVE_RENDER_3D_POSITION_FROM_BG + fxLevel * AUDIO_REACTIVE_RENDER_3D_POSITION_FROM_SFX;
            let audioHeight = bgLevel * AUDIO_REACTIVE_RENDER_3D_HEIGHT_FROM_BG + fxLevel * AUDIO_REACTIVE_RENDER_3D_HEIGHT_FROM_SFX;
            let itemStatus = get3DBuildingTextureStatus(cell.item);
            let itemSideVariant = get3DFloorItemSideVisualizationVariant(cell.item);
            push3DRenderObject(objects, {
                modelKey: `item_${cell.item.type || 'floor'}`,
                x: x + 0.5 + reactiveOffsetX * audioMove,
                y: get3DConstructionLift(cell.item),
                z: y + 0.5 + reactiveOffsetY * audioMove,
                scaleX: 0.84,
                scaleY: 0.14 * getOverlapFlattenScaleForTile(x, y) * (1 + audioHeight),
                scaleZ: 0.84,
                visibilitySource: cell.item,
                rotationY: -(Number(cell.item.angle) || 0),
                tint: get3DDamageFlashTint(cell.item, get3DRenderOwnerColor(cell.owner)),
                alpha: get3DConstructionAlpha(cell.item),
                topTextureKey: `item:${cell.item.type}:${_getFloorItemEnergyBucket(cell.item)}:${itemStatus.keySuffix}`,
                topTextureCanvas: get3DTopTextureForFloorItem(cell.item, itemStatus),
                sideTextureKey: Number.isFinite(cell.owner) && cell.owner >= 0 ? get3DSharedAudioTextureKeyForPlayer(cell.owner, itemSideVariant) : '',
                sideTextureCanvas: Number.isFinite(cell.owner) && cell.owner >= 0 ? get3DSideAudioTextureForPlayer(cell.owner, itemSideVariant, Number(cell.owner) || 0, (BASE_CARD_TYPES[cell.item.type] || {}).color || null) : null,
                sideTint: get3DDamageFlashTint(cell.item, (BASE_CARD_TYPES[cell.item.type] || {}).color || get3DRenderOwnerColor(cell.owner))
            });
        }
    }

    for (let t of towers) {
        if (t.gx < bounds.minGx - 1 || t.gx > bounds.maxGx + 1 || t.gy < bounds.minGy - 1 || t.gy > bounds.maxGy + 1) continue;
        if (!fullVisibility && (!visibilityGrid[t.gy] || visibilityGrid[t.gy][t.gx] === 0)) continue;
        let bgSoundRow = bgSoundGrid[t.gy];
        let fxSoundRow = fxSoundGrid[t.gy];
        let bgLevel = bgSoundRow ? bgSoundRow[t.gx] || 0 : 0;
        let fxLevel = fxSoundRow ? fxSoundRow[t.gx] || 0 : 0;
        let audioMove = bgLevel * AUDIO_REACTIVE_RENDER_3D_POSITION_FROM_BG + fxLevel * AUDIO_REACTIVE_RENDER_3D_POSITION_FROM_SFX;
        let audioHeight = bgLevel * AUDIO_REACTIVE_RENDER_3D_HEIGHT_FROM_BG + fxLevel * AUDIO_REACTIVE_RENDER_3D_HEIGHT_FROM_SFX;
        let towerStatus = get3DBuildingTextureStatus(t);
        let towerSideVariant = get3DTowerSideVisualizationVariant(t);
        push3DRenderObject(objects, {
            modelKey: `tower_${t.type || 'base'}`,
            x: t.x / TILE + reactiveOffsetX * audioMove,
            y: get3DConstructionLift(t),
            z: t.y / TILE + reactiveOffsetY * audioMove,
            scaleX: 0.82,
            scaleY: 1.05 * getOverlapFlattenScaleForTile(t.gx, t.gy) * (1 + audioHeight),
            scaleZ: 0.82,
            visibilitySource: t,
            rotationY: Math.PI * 0.5 - (Number(t.angle) || 0),
            tint: get3DDamageFlashTint(t, get3DRenderOwnerColor(t.owner)),
            alpha: get3DConstructionAlpha(t),
            topTextureKey: `tower:${t.type}:${t.owner}:${_quantizeTowerAngleIndex(t.angle || 0)}:${towerStatus.keySuffix}`,
            topTextureCanvas: get3DBuildingTopTexture('tower', t.owner, { subtype: t.type, color: t.baseStats && t.baseStats.color, angle: t.angle || 0, angleKey: _quantizeTowerAngleIndex(t.angle || 0), active: t.type === 'laser' ? t.connectedLasers && t.connectedLasers.length > 0 : true, status: towerStatus, statusKey: towerStatus.keySuffix }),
            sideTextureKey: get3DSharedAudioTextureKeyForPlayer(t.owner, towerSideVariant),
            sideTextureCanvas: get3DSideAudioTextureForPlayer(t.owner, towerSideVariant, Number(t.owner) || 0, (t.baseStats && t.baseStats.color) || null),
            sideTint: get3DDamageFlashTint(t, (t.baseStats && t.baseStats.color) || get3DRenderOwnerColor(t.owner))
        });
    }

    for (let s of collectorSpawners) {
        if (s.gx < bounds.minGx || s.gx > bounds.maxGx || s.gy < bounds.minGy || s.gy > bounds.maxGy) continue;
        if (!fullVisibility && (!visibilityGrid[s.gy] || visibilityGrid[s.gy][s.gx] === 0)) continue;
        let bgSoundRow = bgSoundGrid[s.gy];
        let fxSoundRow = fxSoundGrid[s.gy];
        let bgLevel = bgSoundRow ? bgSoundRow[s.gx] || 0 : 0;
        let fxLevel = fxSoundRow ? fxSoundRow[s.gx] || 0 : 0;
        let audioMove = bgLevel * AUDIO_REACTIVE_RENDER_3D_POSITION_FROM_BG + fxLevel * AUDIO_REACTIVE_RENDER_3D_POSITION_FROM_SFX;
        let audioHeight = bgLevel * AUDIO_REACTIVE_RENDER_3D_HEIGHT_FROM_BG + fxLevel * AUDIO_REACTIVE_RENDER_3D_HEIGHT_FROM_SFX;
        let spawnerExtraBars = [];
        if (!s.underConstruction && s.spawnQueue && s.spawnQueue.length > 0 && s.spawnCooldown > 0) {
            spawnerExtraBars.push({ pct: s.spawnTimer / s.spawnCooldown, bgColor: '#333', fillColor: (s.spawnTimer / s.spawnCooldown) > 0.8 ? '#4f4' : '#fa0' });
        }
        if (!s.underConstruction && s.type === 'research' && s.researchTask && s.researchTask.workRequired > 0) {
            let pct = Math.max(0, Math.min(1, (s.researchTask.workDone || 0) / s.researchTask.workRequired));
            spawnerExtraBars.push({ pct, bgColor: '#333', fillColor: pct > 0.8 ? '#4f4' : '#4af' });
        }
        let spawnerStatus = get3DBuildingTextureStatus(s, spawnerExtraBars);
        let spawnerSideVariant = get3DSpawnerSideVisualizationVariant(s);
        push3DRenderObject(objects, {
            modelKey: `spawner_${s.type || 'base'}`,
            x: s.x / TILE + reactiveOffsetX * audioMove,
            y: get3DConstructionLift(s),
            z: s.y / TILE + reactiveOffsetY * audioMove,
            scaleX: 0.95,
            scaleY: 0.9 * getOverlapFlattenScaleForTile(s.gx, s.gy) * (1 + audioHeight),
            scaleZ: 0.95,
            visibilitySource: s,
            tint: get3DDamageFlashTint(s, get3DRenderOwnerColor(s.owner)),
            alpha: get3DConstructionAlpha(s),
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
            ),
            sideTextureKey: get3DSharedAudioTextureKeyForPlayer(s.owner, spawnerSideVariant),
            sideTextureCanvas: get3DSideAudioTextureForPlayer(s.owner, spawnerSideVariant, Number(s.owner) || 0, (BASE_CARD_TYPES[s.type] || {}).color || null),
            sideTint: get3DDamageFlashTint(s, (BASE_CARD_TYPES[s.type] || {}).color || get3DRenderOwnerColor(s.owner))
        });
    }

    for (let b of barracks) {
        if (b.gx < bounds.minGx || b.gx > bounds.maxGx || b.gy < bounds.minGy || b.gy > bounds.maxGy) continue;
        if (!fullVisibility && (!visibilityGrid[b.gy] || visibilityGrid[b.gy][b.gx] === 0)) continue;
        let bgSoundRow = bgSoundGrid[b.gy];
        let fxSoundRow = fxSoundGrid[b.gy];
        let bgLevel = bgSoundRow ? bgSoundRow[b.gx] || 0 : 0;
        let fxLevel = fxSoundRow ? fxSoundRow[b.gx] || 0 : 0;
        let audioMove = bgLevel * AUDIO_REACTIVE_RENDER_3D_POSITION_FROM_BG + fxLevel * AUDIO_REACTIVE_RENDER_3D_POSITION_FROM_SFX;
        let audioHeight = bgLevel * AUDIO_REACTIVE_RENDER_3D_HEIGHT_FROM_BG + fxLevel * AUDIO_REACTIVE_RENDER_3D_HEIGHT_FROM_SFX;
        let barrackExtraBars = [];
        if (!b.underConstruction && b.spawnQueue && b.spawnQueue.length > 0 && b.spawnCooldown > 0) {
            barrackExtraBars.push({ pct: b.spawnTimer / b.spawnCooldown, bgColor: '#333', fillColor: (b.spawnTimer / b.spawnCooldown) > 0.8 ? '#4f4' : '#fa0' });
        }
        let barrackStatus = get3DBuildingTextureStatus(b, barrackExtraBars);
        push3DRenderObject(objects, {
            modelKey: `barrack_${b.unitType || 'norm'}`,
            x: b.x / TILE + reactiveOffsetX * audioMove,
            y: get3DConstructionLift(b),
            z: b.y / TILE + reactiveOffsetY * audioMove,
            scaleX: 0.98,
            scaleY: 0.86 * getOverlapFlattenScaleForTile(b.gx, b.gy) * (1 + audioHeight),
            scaleZ: 0.98,
            visibilitySource: b,
            tint: get3DDamageFlashTint(b, get3DRenderOwnerColor(b.owner)),
            alpha: get3DConstructionAlpha(b),
            topTextureKey: `barrack:${b.unitType}:${b.owner}:${barrackStatus.keySuffix}`,
            topTextureCanvas: get3DBuildingTopTexture('barrack', b.owner, { subtype: b.unitType, color: (BASE_UNIT_STATS[b.unitType] || BASE_UNIT_STATS.norm).color, status: barrackStatus, statusKey: barrackStatus.keySuffix }),
            sideTextureKey: get3DSharedAudioTextureKeyForPlayer(b.owner, 'barrack'),
            sideTextureCanvas: get3DSideAudioTextureForPlayer(b.owner, 'barrack', Number(b.owner) || 0, (BASE_UNIT_STATS[b.unitType] || BASE_UNIT_STATS.norm).color),
            sideTint: get3DDamageFlashTint(b, (BASE_UNIT_STATS[b.unitType] || BASE_UNIT_STATS.norm).color)
        });
    }

    for (let d of droppedItems) {
        if (d.gx < bounds.minGx || d.gx > bounds.maxGx || d.gy < bounds.minGy || d.gy > bounds.maxGy) continue;
        if (!fullVisibility && (!visibilityGrid[d.gy] || visibilityGrid[d.gy][d.gx] === 0)) continue;
        let bgSoundRow = bgSoundGrid[d.gy];
        let fxSoundRow = fxSoundGrid[d.gy];
        let bgLevel = bgSoundRow ? bgSoundRow[d.gx] || 0 : 0;
        let fxLevel = fxSoundRow ? fxSoundRow[d.gx] || 0 : 0;
        let audioMove = bgLevel * AUDIO_REACTIVE_RENDER_3D_POSITION_FROM_BG + fxLevel * AUDIO_REACTIVE_RENDER_3D_POSITION_FROM_SFX;
        let audioHeight = bgLevel * AUDIO_REACTIVE_RENDER_3D_HEIGHT_FROM_BG + fxLevel * AUDIO_REACTIVE_RENDER_3D_HEIGHT_FROM_SFX;
        push3DRenderObject(objects, {
            modelKey: 'dropped_energy',
            x: d.x / TILE + reactiveOffsetX * audioMove,
            y: 0,
            z: d.y / TILE + reactiveOffsetY * audioMove,
            scaleX: 0.22,
            scaleY: 0.22 * (1 + audioHeight),
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
        let bgSoundRow = bgSoundGrid[ugy];
        let fxSoundRow = fxSoundGrid[ugy];
        let bgLevel = bgSoundRow ? bgSoundRow[ugx] || 0 : 0;
        let fxLevel = fxSoundRow ? fxSoundRow[ugx] || 0 : 0;
        let audioMove = bgLevel * AUDIO_REACTIVE_RENDER_3D_POSITION_FROM_BG + fxLevel * AUDIO_REACTIVE_RENDER_3D_POSITION_FROM_SFX;
        let audioHeight = bgLevel * AUDIO_REACTIVE_RENDER_3D_HEIGHT_FROM_BG + fxLevel * AUDIO_REACTIVE_RENDER_3D_HEIGHT_FROM_SFX;
        let footprint = Math.max(0.28, Math.min(0.9, ((u.r || 8) * 2.2) / TILE));
        let unitStatus = get3DUnitTextureStatus(u);
        let unitSideVariant = get3DUnitSideVisualizationVariant(u);
        let unitSideColor = (BASE_UNIT_STATS[u.unitType] || BASE_UNIT_STATS.norm).color || null;
        if (u.isSnake) {
            pushSnakeRenderObjects(objects, u, ux + reactiveOffsetX * audioMove * TILE, uy + reactiveOffsetY * audioMove * TILE, footprint, unitStatus);
        } else {
            push3DRenderObject(objects, {
                modelKey: `unit_${u.unitType || 'norm'}`,
                x: ux / TILE + reactiveOffsetX * audioMove,
                y: getUnitHeightOffset(u),
                z: uy / TILE + reactiveOffsetY * audioMove,
                scaleX: footprint,
                scaleY: Math.max(0.32, footprint * 0.9) * (1 + audioHeight),
                scaleZ: footprint,
                visibilitySource: u,
                rotationY: Math.atan2(Number(u.vx) || 0, Number(u.vy) || 1),
                tint: get3DDamageFlashTint(u, get3DRenderOwnerColor(u.owner)),
                renderShape: 'cylinder',
                topTextureKey: `unit:${u.unitType}:${u.owner}:${unitStatus.keySuffix}`,
                topTextureCanvas: get3DUnitTopTexture(u, u.owner, unitStatus),
                sideTextureKey: get3DSharedAudioTextureKeyForPlayer(u.owner, unitSideVariant),
                sideTextureCanvas: get3DSideAudioTextureForPlayer(u.owner, unitSideVariant, Number(u.owner) || 0, unitSideColor),
                sideTint: get3DDamageFlashTint(u, unitSideColor || get3DRenderOwnerColor(u.owner)),
                sideTextureAngle: getAudioReactiveSideTextureAngle(ugx, ugy, (Number(u.id) || 0) + (Number(u.owner) || 0) * 17)
            });
        }
    }

    for (let p of projectiles) {
        let px = Number.isFinite(p.prevX) ? (p.prevX + (p.x - p.prevX) * alpha) : p.x;
        let py = Number.isFinite(p.prevY) ? (p.prevY + (p.y - p.prevY) * alpha) : p.y;
        let pgx = Math.floor(px / TILE), pgy = Math.floor(py / TILE);
        if (pgx < bounds.minGx - 1 || pgx > bounds.maxGx + 1 || pgy < bounds.minGy - 1 || pgy > bounds.maxGy + 1) continue;
        if (!fullVisibility && (!visibilityGrid[pgy] || visibilityGrid[pgy][pgx] === 0)) continue;
        let bgSoundRow = bgSoundGrid[pgy];
        let fxSoundRow = fxSoundGrid[pgy];
        let bgLevel = bgSoundRow ? bgSoundRow[pgx] || 0 : 0;
        let fxLevel = fxSoundRow ? fxSoundRow[pgx] || 0 : 0;
        let audioMove = bgLevel * AUDIO_REACTIVE_RENDER_3D_POSITION_FROM_BG + fxLevel * AUDIO_REACTIVE_RENDER_3D_POSITION_FROM_SFX;
        let audioHeight = bgLevel * AUDIO_REACTIVE_RENDER_3D_HEIGHT_FROM_BG + fxLevel * AUDIO_REACTIVE_RENDER_3D_HEIGHT_FROM_SFX;
        let projectileColor = (BASE_CARD_TYPES[p.type] || {}).color || '#fff';
        let projectileKey = `projectile:${p.type}:${projectileColor}`;
        push3DRenderObject(objects, {
            modelKey: `projectile_${p.type || 'default'}`,
            x: px / TILE + reactiveOffsetX * audioMove,
            y: 0.18,
            z: py / TILE + reactiveOffsetY * audioMove,
            scaleX: 0.12,
            scaleY: 0.12 * (1 + audioHeight),
            scaleZ: 0.2,
            rotationY: Math.atan2(Number(p.vx) || 0, Number(p.vy) || 1),
            tint: projectileColor,
            alpha: 0.95,
            topTextureKey: projectileKey,
            topTextureCanvas: get3DTopTextureCanvas(projectileKey, (g) => {
                let size = g.canvas.width;
                g.fillStyle = projectileColor;
                g.beginPath();
                g.arc(size * 0.5, size * 0.5, size * 0.18, 0, Math.PI * 2);
                g.fill();
                g.strokeStyle = '#fff';
                g.lineWidth = Math.max(2, Math.round(size * 0.035));
                g.stroke();
            })
        });
    }

    for (let p of particles) {
        let px = Number.isFinite(p.prevX) ? (p.prevX + (p.x - p.prevX) * alpha) : p.x;
        let py = Number.isFinite(p.prevY) ? (p.prevY + (p.y - p.prevY) * alpha) : p.y;
        let pgx = Math.floor(px / TILE), pgy = Math.floor(py / TILE);
        if (pgx < bounds.minGx - 1 || pgx > bounds.maxGx + 1 || pgy < bounds.minGy - 1 || pgy > bounds.maxGy + 1) continue;
        if (!fullVisibility && (!visibilityGrid[pgy] || visibilityGrid[pgy][pgx] === 0)) continue;
        let bgSoundRow = bgSoundGrid[pgy];
        let fxSoundRow = fxSoundGrid[pgy];
        let bgLevel = bgSoundRow ? bgSoundRow[pgx] || 0 : 0;
        let fxLevel = fxSoundRow ? fxSoundRow[pgx] || 0 : 0;
        let audioMove = bgLevel * AUDIO_REACTIVE_RENDER_3D_POSITION_FROM_BG + fxLevel * AUDIO_REACTIVE_RENDER_3D_POSITION_FROM_SFX;
        let audioHeight = bgLevel * AUDIO_REACTIVE_RENDER_3D_HEIGHT_FROM_BG + fxLevel * AUDIO_REACTIVE_RENDER_3D_HEIGHT_FROM_SFX;
        push3DRenderObject(objects, {
            modelKey: 'particle',
            x: px / TILE + reactiveOffsetX * audioMove,
            y: 0.08,
            z: py / TILE + reactiveOffsetY * audioMove,
            scaleX: 0.06,
            scaleY: 0.06 * (1 + audioHeight),
            scaleZ: 0.06,
            tint: p.color || '#fff',
            alpha: Math.max(0.1, Math.min(1, (Number(p.life) || 0) / 35))
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
        backgroundCanvas: backgroundCanvasFor3D,
        backgroundVersion: backgroundVersionFor3D,
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
    for (let m of astarMines) {
        if (m.astar > 0) drawCell(m.gx, m.gy, '#888');
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

function cloneVisibilityGrid(source) {
    let copy = new Array(GRID_H);
    for (let y = 0; y < GRID_H; y++) {
        let src = source[y] || new Float32Array(GRID_W);
        copy[y] = new Float32Array(src);
    }
    return copy;
}

function smoothVisibilityGridForPlayer(playerId, targetVis) {
    if (!targetVis) return targetVis;
    let nowTick = Number.isFinite(gameTime) ? gameTime : 0;
    let previous = visibilityGridSmoothedByPlayerCache.get(playerId);
    if (!previous || previous.length !== GRID_H) {
        let seeded = cloneVisibilityGrid(targetVis);
        visibilityGridSmoothedByPlayerCache.set(playerId, seeded);
        visibilityGridSmoothingTickByPlayer.set(playerId, nowTick);
        return seeded;
    }

    let lastTick = visibilityGridSmoothingTickByPlayer.get(playerId);
    let tickDelta = Number.isFinite(lastTick) ? Math.max(1, nowTick - lastTick) : 1;
    tickDelta = Math.min(tickDelta, 2);
    let tickMs = Math.max(1, Number(TICK_MS) || 16.6667);
    let dtSeconds = (tickDelta * tickMs) / 1000;
    let maxDelta = Math.max(0.0001, VISIBILITY_LIGHT_MAX_CHANGE_PER_SECOND * dtSeconds);
    let maxDropDelta = Math.max(0.0001, VISIBILITY_FADE_MAX_CHANGE_PER_SECOND * dtSeconds);

    for (let y = 0; y < GRID_H; y++) {
        let targetRow = targetVis[y];
        let smoothedRow = previous[y];
        for (let x = 0; x < GRID_W; x++) {
            let targetValue = targetRow[x];
            let currentValue = smoothedRow[x];
            let diff = targetValue - currentValue;
            if (diff > maxDelta) diff = maxDelta;
            else if (diff < -maxDropDelta) diff = -maxDropDelta;
            smoothedRow[x] = currentValue + diff;
        }
    }

    visibilityGridSmoothingTickByPlayer.set(playerId, nowTick);
    return previous;
}

function computeVisibilityGridForPlayer(playerId, vis) {
    for (let y = 0; y < GRID_H; y++) vis[y].fill(0);

    let areaRangeBySourceArea = new Map();
    let includedTiles = new Array(GRID_H);
    for (let y = 0; y < GRID_H; y++) includedTiles[y] = new Uint8Array(GRID_W);
    let stampSource = (gx, gy, rangeTiles) => {
        let x = Math.floor(Number(gx));
        let y = Math.floor(Number(gy));
        let range = Math.max(0, Number(rangeTiles) || 0);
        if (x < 0 || x >= GRID_W || y < 0 || y >= GRID_H || !(range > 0)) return;
        if (range > vis[y][x]) vis[y][x] = range;
    };
    let addAreaVisibilitySource = (areaId, rangeArea) => {
        let aId = Math.floor(Number(areaId));
        let range = Math.max(0, Number(rangeArea) || 0);
        if (aId < 0 || !(range > 0)) return;
        let current = areaRangeBySourceArea.get(aId) || 0;
        if (range > current) areaRangeBySourceArea.set(aId, range);
    };
    let addWorldVisibilitySource = (wx, wy, rangeArea) => {
        let x = Number(wx);
        let y = Number(wy);
        let range = Math.max(0, Number(rangeArea) || 0);
        let areaId = getAreaIdAtWorld(x, y);
        addAreaVisibilitySource(areaId, range);
        if (areaId < 0 || !(range > 0) || !Number.isFinite(x) || !Number.isFinite(y)) return;
        stampSource(x / TILE, y / TILE, range * AREA_UNIT_TILE_EQUIVALENT);
    };

    let shouldRevealForPlayer = (owner, watched) => {
        let ownerId = Math.floor(Number(owner));
        return ownerId === playerId || (Number(watched) || 0) > 0;
    };

    for (let u of units) {
        if (!u || u.dead) continue;
        if (!shouldRevealForPlayer(u.owner, u.watched || 0)) continue;
        let visionArea = Number.isFinite(u.visionRangeArea) ? Number(u.visionRangeArea) : ((Number(u.visionRange) || 4) / AREA_UNIT_TILE_EQUIVALENT);
        addWorldVisibilitySource(u.x, u.y, visionArea);
    }
    for (let t of towers) {
        if (!t || !(t.energy > 0) || t.underConstruction) continue;
        if (!shouldRevealForPlayer(t.owner, t.watched || 0)) continue;
        addWorldVisibilitySource(t.x, t.y, Number(t.currentStats && t.currentStats.visionRange));
    }
    for (let b of barracks) {
        if (!b || !(b.energy > 0) || b.underConstruction) continue;
        if (!shouldRevealForPlayer(b.owner, b.watched || 0)) continue;
        addWorldVisibilitySource(b.x, b.y, getEntityVisibilityRangeArea(b));
    }
    for (let s of collectorSpawners) {
        if (!s || !(s.energy > 0) || s.underConstruction) continue;
        if (!shouldRevealForPlayer(s.owner, s.watched || 0)) continue;
        addWorldVisibilitySource(s.x, s.y, getEntityVisibilityRangeArea(s));
    }
    for (let y = 0; y < GRID_H; y++) {
        let row = grid[y];
        for (let x = 0; x < GRID_W; x++) {
            let cell = row[x];
            if (!cell || !cell.item || !(cell.item.energy > 0) || cell.item.underConstruction) continue;
            if (!shouldRevealForPlayer(cell.owner, cell.item.watched || 0)) continue;
            addWorldVisibilitySource(x * TILE + TILE * 0.5, y * TILE + TILE * 0.5, 0.6);
        }
    }

    for (let entry of areaRangeBySourceArea.entries()) {
        let areaId = entry[0];
        let rangeArea = entry[1];
        let cells = getGridCellsWithinAreaDistance(areaId, Math.floor(Math.max(0, Number(rangeArea) || 0)));
        for (let i = 0; i < cells.length; i++) {
            let cell = cells[i];
            if (!cell) continue;
            includedTiles[cell.y][cell.x] = 1;
        }
    }

    for (let y = 0; y < GRID_H; y++) {
        for (let x = 0; x < GRID_W; x++) {
            if (!includedTiles[y][x]) {
                vis[y][x] = 0;
                continue;
            }
            let v = vis[y][x];
            if (x > 0 && includedTiles[y][x - 1]) v = Math.max(v, vis[y][x - 1] - 1);
            if (y > 0 && includedTiles[y - 1][x]) v = Math.max(v, vis[y - 1][x] - 1);
            if (x > 0 && y > 0 && includedTiles[y - 1][x - 1]) v = Math.max(v, vis[y - 1][x - 1] - 1);
            if (x < GRID_W - 1 && y > 0 && includedTiles[y - 1][x + 1]) v = Math.max(v, vis[y - 1][x + 1] - 1);
            vis[y][x] = v;
        }
    }
    for (let y = GRID_H - 1; y >= 0; y--) {
        for (let x = GRID_W - 1; x >= 0; x--) {
            if (!includedTiles[y][x]) {
                vis[y][x] = 0;
                continue;
            }
            let v = vis[y][x];
            if (x < GRID_W - 1 && includedTiles[y][x + 1]) v = Math.max(v, vis[y][x + 1] - 1);
            if (y < GRID_H - 1 && includedTiles[y + 1][x]) v = Math.max(v, vis[y + 1][x] - 1);
            if (x < GRID_W - 1 && y < GRID_H - 1 && includedTiles[y + 1][x + 1]) v = Math.max(v, vis[y + 1][x + 1] - 1);
            if (x > 0 && y < GRID_H - 1 && includedTiles[y + 1][x - 1]) v = Math.max(v, vis[y + 1][x - 1] - 1);
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
    let rawVis = createEmptyVisibilityGrid();
    computeVisibilityGridForPlayer(playerId, rawVis);
    let smoothedVis = smoothVisibilityGridForPlayer(playerId, rawVis);
    visibilityGridByPlayerCache.set(playerId, smoothedVis);
    return smoothedVis;
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

function updateDefaultToggleButtons() {
    let btnBuild = document.getElementById('btn-default-build');
    if (btnBuild) {
        btnBuild.textContent = `\uD83D\uDD28 New: ${defaultAutoBuildEnabled ? 'ON' : 'OFF'}`;
        btnBuild.style.borderColor = defaultAutoBuildEnabled ? '#6f6' : '#555';
        btnBuild.style.color = defaultAutoBuildEnabled ? '#9f9' : '#888';
        btnBuild.style.background = defaultAutoBuildEnabled ? 'rgba(40,90,40,0.25)' : 'transparent';
    }
    let btnAuto = document.getElementById('btn-default-auto-upgrade');
    if (btnAuto) {
        btnAuto.textContent = `L+New: ${defaultAutoUpgradeEnabled ? 'ON' : 'OFF'}`;
        btnAuto.style.borderColor = defaultAutoUpgradeEnabled ? '#4af' : '#555';
        btnAuto.style.color = defaultAutoUpgradeEnabled ? '#8cf' : '#888';
        btnAuto.style.background = defaultAutoUpgradeEnabled ? 'rgba(40,70,110,0.25)' : 'transparent';
    }
}

function updateIgnoreLevelButton() {
    let buttons = [
        document.getElementById('btn-ignore-level'),
        document.getElementById('btn-ignore-level-popup')
    ].filter(Boolean);
    if (buttons.length <= 0) return;
    for (let btn of buttons) {
        btn.textContent = `Collapse Same Type: ${ignoreLevelSubgroups ? 'ON' : 'OFF'}`;
        btn.style.borderColor = ignoreLevelSubgroups ? '#fd0' : '#555';
        btn.style.color = ignoreLevelSubgroups ? '#fd0' : '#999';
        btn.style.background = ignoreLevelSubgroups ? 'rgba(110,90,20,0.25)' : '#181818';
    }
}

function renderMultiplierBar(containerId, currentValue, onChange, label) {
    let bar = document.getElementById(containerId);
    if (!bar) return;
    let html = '';
    for (let mult of PURCHASE_MULTIPLIERS) {
        let activeCls = mult === currentValue ? ' active' : '';
        html += `<button class="mult-toggle-btn${activeCls}" data-mult="${mult}">x${mult}</button>`;
    }
    bar.innerHTML = html;
    bar.querySelectorAll('.mult-toggle-btn').forEach(btn => {
        bindInstantPress(btn, () => {
            let val = parseInt(btn.dataset.mult);
            if (!Number.isFinite(val) || val < 1) return;
            onChange(val);
        });
    });
}

function updatePurchaseMultiplierBars() {
    renderMultiplierBar('build-multiplier-bar', buildPurchaseMultiplier, (val) => {
        buildPurchaseMultiplier = val;
        updatePurchaseMultiplierBars();
        updateBuildMenu();
    }, 'Buy');
    renderMultiplierBar('queue-multiplier-bar', queuePurchaseMultiplier, (val) => {
        queuePurchaseMultiplier = val;
        updatePurchaseMultiplierBars();
        updateInfoPanel();
    }, 'Queue');
    renderMultiplierBar('queue-multiplier-bar-popup', queuePurchaseMultiplier, (val) => {
        queuePurchaseMultiplier = val;
        updatePurchaseMultiplierBars();
        updateInfoPanel();
        renderResearchPopupContent();
    }, 'Queue');
}

function queueResizeForEachActiveUnitSubgroup(mode) {
    let activeUnits = getActiveUnits();
    if (!activeUnits || activeUnits.length === 0) return;
    let groups = new Map();
    for (let u of activeUnits) {
        let key = getUnitGroupKey(u);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(u);
    }
    for (let group of groups.values()) {
        if (!group || group.length === 0) continue;
        if (mode === 'd2' && group.length < 2) continue;
        let u0 = group[0];
        let unitType = u0.unitType;
        let unitLevel = ignoreLevelSubgroups ? null : getUnitBaseLevel(u0);
        let ids = group.map(u => u.id);
        queueAction({ action: 'resizeUnitGroup', unitIds: ids, mode, unitType, unitLevel });
    }
    setTimeout(updateInfoPanel, 50);
}

function getNextLevelUpgradeInfo(item) {
    let stacks = Math.max(1, item.stacks || 1);
    let level = stackCountToLevel(stacks);
    let nextLevel = Math.max(1, level + 1);
    let nextStacksNeeded = getRequiredStacksForLevel(nextLevel);
    let missingStacks = Math.max(0, nextStacksNeeded - stacks);
    let key = item instanceof Tower ? item.type : (item.type === 'barrack' ? 'barrack_' + item.unitType : item.type);
    let def = BASE_CARD_TYPES[key] || { price: 0 };
    let goldCost = missingStacks * (def.price || 0);
    let energyNow = item.maxEnergy || 0;
    let energyNext = item instanceof Tower ? getUpgrademaxEnergy(item, nextLevel) : (calculateItemStats(item.type || 'farm', nextLevel, item.owner).maxEnergy || energyNow);
    return { nextLevel, missingStacks, goldCost, energyNow, energyNext };
}

function normalizeBuildingResearchKey(type) {
    if (!type) return 'farm';
    if (type === 'barrack') return 'barrack_norm';
    if (type.startsWith('barrack_')) return type;
    return type;
}

function calculateItemStats(type, level, owner = null) {
    let stats = { maxEnergy: 0, damage: 0, blastDamage: NaN, blastRadius: NaN, multiplier: NaN };
    let ownerId = Number.isFinite(owner) ? owner : localPlayerId;
    let bKey = normalizeBuildingResearchKey(type);
    let lvl = Math.max(1, clampThingLevel(level));
    let maxEnergy = getBuildingStatForOwner(ownerId, bKey, lvl, 'maxEnergy');
    let damage = getBuildingStatForOwner(ownerId, bKey, lvl, 'damage');
    let blastDamage = getBuildingStatForOwner(ownerId, bKey, lvl, 'blastDamage');
    let blastRadius = getBuildingStatForOwner(ownerId, bKey, lvl, 'blastRadius');
    let multiplier = getBuildingStatForOwner(ownerId, bKey, lvl, 'multiplier');
    if (Number.isFinite(maxEnergy)) stats.maxEnergy = Math.max(1, Math.floor(maxEnergy));
    if (Number.isFinite(damage)) stats.damage = damage;
    if (Number.isFinite(blastDamage)) stats.blastDamage = blastDamage;
    if (Number.isFinite(blastRadius)) stats.blastRadius = Math.max(0, blastRadius);
    if (Number.isFinite(multiplier)) stats.multiplier = multiplier;
    return stats;
}

function ensureStatusState(target) {
    if (!target) return;
    if (target.burning === undefined) target.burning = 0;
    if (target.burnTickDamage === undefined) target.burnTickDamage = 0;
    if (target.poisoned === undefined) target.poisoned = 0;
    if (target.poisonTickDamage === undefined) target.poisonTickDamage = 0;
    if (target.frozen === undefined) target.frozen = 0;
    if (target.iceTickDamage === undefined) target.iceTickDamage = 0;
    if (target.wet === undefined) target.wet = 0;
    if (target.sandy === undefined) target.sandy = 0;
    if (target.watched === undefined) target.watched = 0;
}

function isEffectImmune(target, effect) {
    if (!target) return false;
    if (effect === 'fire' && target.fireResistant) return true;
    if (effect === 'poison' && target.poisonResistant) return true;
    if (effect === 'water' && target.waterResistant) return true;
    if (effect === 'ice' && target.iceResistant) return true;
    if (effect === 'sand' && target.sandResistant) return true;

    let tType = target.type || '';
    if (tType === 'fire' && effect === 'fire') return true;
    if (tType === 'poison' && effect === 'poison') return true;
    if (tType === 'water' && effect === 'water') return true;
    if (tType === 'ice' && effect === 'ice') return true;
    if (tType === 'sand_gun' && effect === 'sand') return true;
    if (tType === 'watch_tower' && effect === 'watch') return true;
    if (tType === 'elements' && ['fire', 'poison', 'water', 'ice', 'sand'].includes(effect)) return true;
    return false;
}

function _getEffectStatKey(effect, statKind) {
    if (effect === 'fire') return statKind === 'dps' ? 'burnDps' : 'burnDuration';
    if (effect === 'poison') return statKind === 'dps' ? 'poisonDps' : 'poisonDuration';
    if (effect === 'ice') return statKind === 'dps' ? 'freezeDps' : 'freezeDuration';
    if (effect === 'water') return statKind === 'duration' ? 'wetDuration' : '';
    if (effect === 'sand') return statKind === 'duration' ? 'sandDuration' : '';
    if (effect === 'watch') return statKind === 'duration' ? 'watchDuration' : '';
    return '';
}

function _getBuildingEffectStat(owner, sourceType, level, effect, statKind) {
    let statKey = _getEffectStatKey(effect, statKind);
    if (!statKey || !sourceType) return NaN;
    let ownerId = Number.isFinite(owner) ? owner : localPlayerId;
    let lvl = Math.max(1, clampThingLevel(level || 1));
    return getBuildingStatForOwner(ownerId, sourceType, lvl, statKey);
}

function applyStatusEffect(target, effect, level, baseDamage = 0, sourceOwner = null, sourceType = '') {
    if (!target) return false;
    ensureStatusState(target);
    if (isEffectImmune(target, effect)) return false;

    let lvl = Math.max(1, level || 1);
    let mappedDuration = _getBuildingEffectStat(sourceOwner, sourceType, lvl, effect, 'duration');
    let mappedDps = _getBuildingEffectStat(sourceOwner, sourceType, lvl, effect, 'dps');
    if (effect === 'fire') {
        let durSec = Number.isFinite(mappedDuration) ? mappedDuration : (3 + lvl * 0.5);
        let dur = secondsToTicks(durSec);
        target.burning = Math.max(target.burning, dur);
        let d = Number.isFinite(mappedDps) ? mappedDps : Math.max(0.1, baseDamage > 0 ? baseDamage : 0.5);
        target.burnTickDamage = Math.max(target.burnTickDamage, d);
    } else if (effect === 'poison') {
        let durSec = Number.isFinite(mappedDuration) ? mappedDuration : (5 + lvl);
        let dur = secondsToTicks(durSec);
        target.poisoned = Math.max(target.poisoned, dur);
        let d = Number.isFinite(mappedDps) ? mappedDps : Math.max(0.1, baseDamage > 0 ? baseDamage : 0.5);
        target.poisonTickDamage = Math.max(target.poisonTickDamage, d);
    } else if (effect === 'ice') {
        let durSec = Number.isFinite(mappedDuration) ? mappedDuration : (3 + lvl * 0.5);
        let dur = secondsToTicks(durSec);
        target.frozen = Math.max(target.frozen, dur);
        let d = Number.isFinite(mappedDps) ? mappedDps : Math.max(0.2, baseDamage > 0 ? baseDamage : 0.5);
        target.iceTickDamage = Math.max(target.iceTickDamage, d);
    } else if (effect === 'water') {
        let durSec = Number.isFinite(mappedDuration) ? mappedDuration : (6 + lvl);
        let dur = secondsToTicks(durSec);
        target.wet = Math.max(target.wet, dur);
    } else if (effect === 'sand') {
        let durSec = Number.isFinite(mappedDuration) ? mappedDuration : 9;
        let dur = secondsToTicks(durSec);
        target.sandy = Math.max(target.sandy, dur);
    } else if (effect === 'watch') {
        let durSec = Number.isFinite(mappedDuration) ? mappedDuration : (4 + lvl);
        let dur = secondsToTicks(durSec);
        target.watched = Math.max(target.watched, dur);
    }
    return true;
}

function tickStatusEffects(target) {
    if (!target) return false;
    ensureStatusState(target);

    if (target.burning > 0) {
        target.burning--;
        if (target.burnTickDamage > 0) {
            target.energy -= target.burnTickDamage;
            recordDamageVisual(target, target.burnTickDamage);
        }
    }
    if (target.poisoned > 0) {
        target.poisoned--;
        if (target.poisonTickDamage > 0) {
            target.energy -= target.poisonTickDamage;
            recordDamageVisual(target, target.poisonTickDamage);
        }
    }
    if (target.frozen > 0 && target.wet > 0 && target.iceTickDamage > 0) {
        target.energy -= target.iceTickDamage;
        recordDamageVisual(target, target.iceTickDamage);
    }
    if (target.frozen > 0) target.frozen--;
    if (target.wet > 0) target.wet--;
    if (target.sandy > 0) target.sandy--;
    if (target.watched > 0) target.watched--;

    if (target.energy !== undefined && target.energy <= 0) {
        target.energy = 0;
        return true;
    }
    return false;
}

function ensureLevelTextCanvas(target) {
    let scale = 2;
    if (!target.textCanvas || !target.textCtx || target._textCanvasScale !== scale) {
        target.textCanvas = document.createElement('canvas');
        target.textCanvas.width = 32 * scale;
        target.textCanvas.height = 48 * scale;
        target.textCtx = target.textCanvas.getContext('2d');
        target._textCanvasScale = scale;
    }
    return target.textCtx;
}

const LEVEL_TEXT_SPRITE_CACHE = new Map();
const LEVEL_TEXT_SPRITE_CACHE_MAX = 512;
const UNIT_LEVEL_TEXT_SPRITE_CACHE = new Map();
const UNIT_LEVEL_TEXT_SPRITE_CACHE_MAX = 256;

function _getUiSpriteScale() {
    // Render tiny text/glyph sprites at higher internal resolution to reduce color interpolation.
    let dpr = Number(window.devicePixelRatio) || 1;
    return Math.max(1, Math.min(3, Math.round(dpr * 2)));
}

function _trimSpriteCache(cache, maxEntries) {
    if (cache.size <= maxEntries) return;
    let removeCount = cache.size - maxEntries;
    for (let key of cache.keys()) {
        cache.delete(key);
        removeCount--;
        if (removeCount <= 0) break;
    }
}

function _getBuildingLevelTextSprite(label) {
    let txt = String(label || '');
    let scale = _getUiSpriteScale();
    let key = txt + '|' + scale;
    let cached = LEVEL_TEXT_SPRITE_CACHE.get(key);
    if (cached) return cached;

    let width = 32;
    let height = 48;
    let canvas = document.createElement('canvas');
    canvas.width = width * scale;
    canvas.height = height * scale;
    let c = canvas.getContext('2d');
    c.imageSmoothingEnabled = false;
    c.setTransform(scale, 0, 0, scale, 0, 0);
    c.clearRect(0, 0, width, height);
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.font = '700 8px Segoe UI, Arial, sans-serif';
    c.lineJoin = 'round';
    c.strokeStyle = 'rgba(0,0,0,0.95)';
    c.lineWidth = 2;
    c.strokeText(txt, 16, 11);
    c.fillStyle = '#eee';
    c.fillText(txt, 16, 11);

    cached = { canvas, scale };
    LEVEL_TEXT_SPRITE_CACHE.set(key, cached);
    _trimSpriteCache(LEVEL_TEXT_SPRITE_CACHE, LEVEL_TEXT_SPRITE_CACHE_MAX);
    return cached;
}

function _bindBuildingLevelTextSprite(target, label) {
    if (!target) return;
    let sprite = _getBuildingLevelTextSprite(label);
    target.textCanvas = sprite.canvas;
    target.textCtx = null;
    target._textCanvasScale = sprite.scale;
}

function _getUnitLevelTextSprite(label) {
    let txt = String(label || '');
    let scale = _getUiSpriteScale();
    let key = txt + '|' + scale;
    let cached = UNIT_LEVEL_TEXT_SPRITE_CACHE.get(key);
    if (cached) return cached;

    let width = 28;
    let height = 14;
    let canvas = document.createElement('canvas');
    canvas.width = width * scale;
    canvas.height = height * scale;
    let c = canvas.getContext('2d');
    c.imageSmoothingEnabled = false;
    c.setTransform(scale, 0, 0, scale, 0, 0);
    c.clearRect(0, 0, width, height);
    c.font = '700 7px Segoe UI, Arial, sans-serif';
    c.textAlign = 'center';
    c.textBaseline = 'bottom';
    c.fillStyle = '#ddd';
    c.strokeStyle = 'rgba(0,0,0,0.95)';
    c.lineJoin = 'round';
    c.lineWidth = 1.5;
    c.strokeText(txt, width * 0.5, height - 1);
    c.fillText(txt, width * 0.5, height - 1);

    cached = { canvas, width, height };
    UNIT_LEVEL_TEXT_SPRITE_CACHE.set(key, cached);
    _trimSpriteCache(UNIT_LEVEL_TEXT_SPRITE_CACHE, UNIT_LEVEL_TEXT_SPRITE_CACHE_MAX);
    return cached;
}

// Frame-local drawImage queue: batches by source image to improve sprite cache locality.
let _frameDrawImageQueueActive = false;
let _frameDrawImageQueue = [];
let _frameDrawImageContexts = new Set();
let _frameDrawImageCurrentZ = 0;
let _frameDrawImageFrameId = 0;
let _frameDrawImageIdCounter = 1;
const _frameDrawImageIdBySource = new WeakMap();
const _frameDrawImageCtxStateCache = new WeakMap();

function _setDrawImageTrackedTransform(ctx, a, b, c, d, e, f) {
    ctx.setTransform(a, b, c, d, e, f);
    let st = _frameDrawImageCtxStateCache.get(ctx);
    if (!st) st = {};
    st.frameId = _frameDrawImageFrameId;
    st.ta = a; st.tb = b; st.tc = c; st.td = d; st.te = e; st.tf = f;
    _frameDrawImageCtxStateCache.set(ctx, st);
}

function _captureDrawImageCtxState(ctx) {
    let st = _frameDrawImageCtxStateCache.get(ctx);
    if (!st) st = {};
    if (st.frameId !== _frameDrawImageFrameId ||
        !Number.isFinite(st.ta) || !Number.isFinite(st.tb) || !Number.isFinite(st.tc) ||
        !Number.isFinite(st.td) || !Number.isFinite(st.te) || !Number.isFinite(st.tf)) {
        let t = ctx.getTransform();
        st.frameId = _frameDrawImageFrameId;
        st.ta = t.a;
        st.tb = t.b;
        st.tc = t.c;
        st.td = t.d;
        st.te = t.e;
        st.tf = t.f;
    }
    st.alpha = ctx.globalAlpha;
    st.comp = ctx.globalCompositeOperation;
    st.smooth = ctx.imageSmoothingEnabled;
    st.filter = ctx.filter || 'none';
    _frameDrawImageCtxStateCache.set(ctx, st);
    return st;
}

function beginFrameDrawImageQueue() {
    _frameDrawImageQueueActive = true;
    _frameDrawImageFrameId++;
    _frameDrawImageQueue.length = 0;
    _frameDrawImageContexts.clear();
    _frameDrawImageCurrentZ = 0;
}

function setFrameDrawImageDepth(z) {
    _frameDrawImageCurrentZ = Number.isFinite(z) ? z : 0;
}

function queueDrawImage(ctx, image, a0, a1, a2, a3, a4, a5, a6, a7) {
    if (!ctx || !image) return;
    let argc = arguments.length - 2;

    if (!_frameDrawImageQueueActive) {
        if (argc === 2) ctx.drawImage(image, a0, a1);
        else if (argc === 4) ctx.drawImage(image, a0, a1, a2, a3);
        else if (argc === 8) ctx.drawImage(image, a0, a1, a2, a3, a4, a5, a6, a7);
        else ctx.drawImage(image, a0, a1);
        return;
    }

    _frameDrawImageContexts.add(ctx);

    let imageId = _frameDrawImageIdBySource.get(image);
    if (!imageId) {
        imageId = _frameDrawImageIdCounter++;
        _frameDrawImageIdBySource.set(image, imageId);
    }

    let st = _captureDrawImageCtxState(ctx);
    _frameDrawImageQueue.push({
        ctx,
        image,
        argc,
        a0,
        a1,
        a2,
        a3,
        a4,
        a5,
        a6,
        a7,
        z: _frameDrawImageCurrentZ,
        imageId,
        ta: st.ta,
        tb: st.tb,
        tc: st.tc,
        td: st.td,
        te: st.te,
        tf: st.tf,
        alpha: st.alpha,
        comp: st.comp,
        smooth: st.smooth,
        filter: st.filter
    });
}

function flushFrameDrawImageQueue() {
    if (!_frameDrawImageQueueActive) return;
    if (_frameDrawImageQueue.length <= 0) {
        _frameDrawImageQueueActive = false;
        return;
    }

    let bucketsByZ = new Map();
    let zOrder = [];
    for (let cmd of _frameDrawImageQueue) {
        let zKey = cmd.z;
        if (!bucketsByZ.has(zKey)) {
            bucketsByZ.set(zKey, []);
            zOrder.push(zKey);
        }
        bucketsByZ.get(zKey).push(cmd);
    }
    zOrder.sort((a, b) => b - a); // Furthest/highest z first, closest last.

    let liveStateByCtx = new Map();
    let layerStateByCtx = new Map();
    for (let c of _frameDrawImageContexts) c.save();
    let layerContextsToRestore = [];
    for (let z of zOrder) {
        let layerCtx = renderer3dLayerContexts.get(z);
        if (layerCtx) {
            layerCtx.save();
            layerContextsToRestore.push(layerCtx);
        }
        let imageBuckets = new Map();
        let imageOrder = [];
        let zCmds = bucketsByZ.get(z);
        for (let cmd of zCmds) {
            let id = cmd.imageId;
            if (!imageBuckets.has(id)) {
                imageBuckets.set(id, []);
                imageOrder.push(id);
            }
            imageBuckets.get(id).push(cmd);
        }

        for (let id of imageOrder) {
            let cmds = imageBuckets.get(id);
            for (let cmd of cmds) {
                let replayToContext = (targetCtx, stateMap) => {
                    if (!targetCtx) return;
                    let s = stateMap.get(targetCtx);
                    if (!s || s.ta !== cmd.ta || s.tb !== cmd.tb || s.tc !== cmd.tc || s.td !== cmd.td || s.te !== cmd.te || s.tf !== cmd.tf) {
                        targetCtx.setTransform(cmd.ta, cmd.tb, cmd.tc, cmd.td, cmd.te, cmd.tf);
                        if (!s) s = {};
                        s.ta = cmd.ta; s.tb = cmd.tb; s.tc = cmd.tc; s.td = cmd.td; s.te = cmd.te; s.tf = cmd.tf;
                    }
                    if (!s || s.alpha !== cmd.alpha) {
                        targetCtx.globalAlpha = cmd.alpha;
                        if (!s) s = {};
                        s.alpha = cmd.alpha;
                    }
                    if (!s || s.comp !== cmd.comp) {
                        targetCtx.globalCompositeOperation = cmd.comp;
                        if (!s) s = {};
                        s.comp = cmd.comp;
                    }
                    if (!s || s.smooth !== cmd.smooth) {
                        targetCtx.imageSmoothingEnabled = cmd.smooth;
                        if (!s) s = {};
                        s.smooth = cmd.smooth;
                    }
                    if (!s || s.filter !== cmd.filter) {
                        targetCtx.filter = cmd.filter;
                        if (!s) s = {};
                        s.filter = cmd.filter;
                    }
                    stateMap.set(targetCtx, s);

                    if (cmd.argc === 2) targetCtx.drawImage(cmd.image, cmd.a0, cmd.a1);
                    else if (cmd.argc === 4) targetCtx.drawImage(cmd.image, cmd.a0, cmd.a1, cmd.a2, cmd.a3);
                    else if (cmd.argc === 8) targetCtx.drawImage(cmd.image, cmd.a0, cmd.a1, cmd.a2, cmd.a3, cmd.a4, cmd.a5, cmd.a6, cmd.a7);
                    else targetCtx.drawImage(cmd.image, cmd.a0, cmd.a1);
                };

                replayToContext(cmd.ctx, liveStateByCtx);
                if (layerCtx) {
                    replayToContext(layerCtx, layerStateByCtx);
                    let stats = renderer3dLayerStats.get(z);
                    if (stats) stats.commandCount++;
                }
            }
        }
    }

    for (let c of _frameDrawImageContexts) c.restore();
    for (let c of layerContextsToRestore) c.restore();

    _frameDrawImageQueue.length = 0;
    _frameDrawImageContexts.clear();
    _frameDrawImageQueueActive = false;
}

function ensureRenderer3DLayerCanvas(z) {
    let dpr = window.devicePixelRatio || 1;
    let width = Math.max(1, Math.floor(viewW * dpr));
    let height = Math.max(1, Math.floor(viewH * dpr));
    let layerCanvas = renderer3dLayerCanvases.get(z);
    let layerCtx = renderer3dLayerContexts.get(z);
    if (!layerCanvas || layerCanvas.width !== width || layerCanvas.height !== height) {
        layerCanvas = document.createElement('canvas');
        layerCanvas.width = width;
        layerCanvas.height = height;
        layerCtx = layerCanvas.getContext('2d');
        layerCtx.imageSmoothingEnabled = false;
        renderer3dLayerCanvases.set(z, layerCanvas);
        renderer3dLayerContexts.set(z, layerCtx);
    }
    return { canvas: layerCanvas, ctx: layerCtx };
}

function beginRenderer3DLayerCapture() {
    for (let config of renderer3dLayerConfigs) {
        let layer = ensureRenderer3DLayerCanvas(config.z);
        layer.ctx.setTransform(1, 0, 0, 1, 0, 0);
        layer.ctx.clearRect(0, 0, layer.canvas.width, layer.canvas.height);
        layer.ctx.globalAlpha = 1;
        layer.ctx.globalCompositeOperation = 'source-over';
        layer.ctx.filter = 'none';
        layer.ctx.imageSmoothingEnabled = false;
        renderer3dLayerStats.set(config.z, { commandCount: 0 });
    }
}

function build3DLayerFrameData() {
    let layers = [];
    if (bgCanvas) {
        layers.push({
            key: 'background',
            canvas: bgCanvas,
            slices: 1,
            thickness: 0.02,
            opacity: 1
        });
    } else {
        let fallbackBackground = renderer3dLayerCanvases.get(DRAW_Z_BACKGROUND);
        if (fallbackBackground) {
            layers.push({
                key: 'background',
                canvas: fallbackBackground,
                slices: 1,
                thickness: 0.02,
                opacity: 1
            });
        }
    }

    for (let config of renderer3dLayerConfigs) {
        if (config.z === DRAW_Z_BACKGROUND && bgCanvas) continue;
        let stats = renderer3dLayerStats.get(config.z);
        let canvasForLayer = renderer3dLayerCanvases.get(config.z);
        if (!canvasForLayer || !stats || stats.commandCount <= 0) continue;
        layers.push({
            key: config.key,
            canvas: canvasForLayer,
            slices: config.slices,
            thickness: config.thickness,
            opacity: config.opacity
        });
    }

    if (layers.length <= 0) return null;
    return {
        layers,
        viewportWidth: viewW,
        viewportHeight: viewH,
        camera: {
            zoom: camera.zoom
        }
    };
}

function drawLevelTextCache(ctx, target, x, y) {
    if (!target || !target.textCanvas || !target._textCanvasScale) return;
    let dx = Math.round(x - 16);
    let dy = Math.round(y - 24);
    queueDrawImage(ctx, target.textCanvas, dx, dy, 32, 48);
}

function updateItemTextCache(item) {
    let label = getLevelLabelText(item);
    _bindBuildingLevelTextSprite(item, label);
}
