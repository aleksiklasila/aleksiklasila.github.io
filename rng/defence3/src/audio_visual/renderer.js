let canvas, ctx, bgCanvas, bgCtx, overlayCanvas, overlayCtx, minimapCanvas, minimapCtx;
let renderDimensionMode = '2d';
let renderer3dInstance = null;
let renderer3dHost = null;
let renderer3dBackgroundVersion = 0;
let renderer3dRotateDrag = null;
const renderer3dTopTextureCache = new Map();
const renderer3dOverlapFadeState = new Map();
const renderer3dSharedAudioTextureCanvases = new Map();
const RENDERER3D_OVERLAP_FADE_DURATION_MS = 500;
// A structure under a unit keeps this share of its height (so its roof and 2D
// panel still read the same), within world-unit bounds that keep the unit on
// top visible.
const RENDERER3D_OVERLAP_HEIGHT_FRACTION = 0.25;
const RENDERER3D_OVERLAP_MIN_HEIGHT = 0.05;
const RENDERER3D_OVERLAP_MAX_HEIGHT = 0.14;
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
let visibilityGridRawByPlayerCache = new Map();
let visibilityCacheTick = -1;
// Gameplay visibility is recomputed every VISIBILITY_TICK_INTERVAL ticks per
// player, players on alternating ticks, and reused in between (targeting sees
// the world at most a tick late). All peers reuse identically; caches are
// dropped together at resyncs (snapFlushHistoryCaches).
const VISIBILITY_TICK_INTERVAL = 2;
let visibilityGridStampByPlayer = new Map();

function clearGameplayVisibilityCache() {
    visibilityGridRawByPlayerCache.clear();
    visibilityGridStampByPlayer.clear();
    visibilityCacheTick = -1;
    resetVisibilityCoverage();
}
const visibilityGridPoolByPlayer = new Map();
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

// The info panel refreshes every INFO_PANEL_REFRESH_MS, stretched for large
// selections so that refreshing takes at most ~5% of the time (the markup of
// hundreds of selected things costs tens of milliseconds to rebuild).
const INFO_PANEL_REFRESH_MS = 250;
const INFO_PANEL_REFRESH_MAX_MS = 1500;
let _infoPanelNextRefreshAt = 0;
let _infoPanelRefreshCostMs = 0;

// Commands take effect on a later tick, so refreshing the panel as they are
// issued shows nothing new yet costs a full refresh on the input frame. Pull
// the periodic refresh forward to just after that tick instead.
function requestInfoPanelRefresh(delayMs = TICK_MS * 1.5) {
    _infoPanelNextRefreshAt = Math.min(_infoPanelNextRefreshAt, performance.now() + delayMs);
}

// Refresh after the next rendered frame, which itself stays free of it (see
// the box-selection mouseup: that frame shows the new selection at once).
let _infoPanelRefreshAfterFrames = 0;
function requestInfoPanelRefreshAfterFrame() {
    _infoPanelRefreshAfterFrames = 2;
}

function _refreshInfoPanelPeriodic(now) {
    if (_infoPanelRefreshAfterFrames > 0) {
        if (--_infoPanelRefreshAfterFrames > 0) return;
        _infoPanelNextRefreshAt = 0;
    }
    if (now < _infoPanelNextRefreshAt || researchQueueDragInProgress) return;
    let started = performance.now();
    updateInfoPanel();
    let cost = performance.now() - started;
    // Smoothed, so one slow refresh (a garbage collection) does not stall it.
    _infoPanelRefreshCostMs += (cost - _infoPanelRefreshCostMs) * 0.3;
    _infoPanelNextRefreshAt = now + Math.min(INFO_PANEL_REFRESH_MAX_MS, Math.max(INFO_PANEL_REFRESH_MS, _infoPanelRefreshCostMs * 20));
}
let _minimapRefreshCounter = 10;
let _backgroundCacheRefreshCounter = 20;
let _fpsFrameCount = 0, _fpsLastTime = performance.now(), _fpsDisplay = 0;
let _tpsTickCount = 0, _tpsLastTime = performance.now(), _tpsDisplay = 0;
const _litTintCache = new Map();

function get3DRenderOwnerColor(owner) {
    if (owner === undefined || owner === null || owner < 0) return '#c8ced8';
    let pid = Math.floor(Number(owner));
    if (typeof getTeamDisplayColor === 'function') return getTeamDisplayColor(pid);
    if (typeof teamColorById !== 'undefined' && teamColorById[pid]) return teamColorById[pid];
    return (typeof PLAYER_COLORS !== 'undefined' && PLAYER_COLORS[pid]) || '#c8ced8';
}

const DAMAGE_FLASH_TICKS = 10;

const _parsedHexColors = new Map();
function _parseHexColor(color) {
    if (_parsedHexColors.has(color)) return _parsedHexColors.get(color);
    let normalized = String(color || '').trim();
    let match = normalized.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
    if (!match) return null;
    let hex = match[1];
    if (hex.length === 3) hex = hex.split('').map(ch => ch + ch).join('');
    let rgb = {
        r: parseInt(hex.slice(0, 2), 16),
        g: parseInt(hex.slice(2, 4), 16),
        b: parseInt(hex.slice(4, 6), 16)
    };
    if (_parsedHexColors.size >= 2048) _parsedHexColors.clear();
    _parsedHexColors.set(color, rgb);
    return rgb;
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
    // Per tint, one slot per light bucket: no string key per lookup.
    let buckets = _litTintCache.get(tint);
    if (!buckets) {
        if (_litTintCache.size > 512) _litTintCache.clear();
        _litTintCache.set(tint, buckets = new Array(24).fill(null));
    }
    let cached = buckets[bucket];
    if (cached) return cached;
    let rgb = _parseHexColor(tint);
    if (!rgb) return tint;
    let lightMul = 0.28 + (bucket / 24) * 0.72;
    let lit = _rgbToHex({ r: rgb.r * lightMul, g: rgb.g * lightMul, b: rgb.b * lightMul });
    buckets[bucket] = lit;
    return lit;
}

function getDamageFlashColor(target, sourceOwner = null) {
    if (Number.isFinite(sourceOwner) && sourceOwner >= 0 && typeof getTeamDisplayColor === 'function') {
        return getTeamDisplayColor(Math.floor(sourceOwner));
    }
    let base = get3DRenderOwnerColor(target && target.owner);
    let rgb = _parseHexColor(base);
    if (!rgb) return '#ffffff';
    return _rgbToHex({ r: 255 - rgb.r, g: 255 - rgb.g, b: 255 - rgb.b });
}

function recordDamageVisual(target, amount, sourceOwner = null) {
    if (!target) return;
    // (A building's or floor item's energy may have run out: see gameTick.)
    if (typeof Unit === 'undefined' || !(target instanceof Unit)) thingStatusWake(target);
    let dmg = Math.max(0, Number(amount) || 0);
    if (dmg <= 0.01) return;
    let maxEnergy = Math.max(1, Number(target.maxEnergy) || Number(target.preComputed && target.preComputed.maxEnergy) || 0);
    let scaledStrength = Math.min(1, 0.28 + (dmg / maxEnergy) * 3.5);
    target._damageFlashStart = gameTime;
    target._damageFlashUntil = Math.max(Number(target._damageFlashUntil) || 0, gameTime + DAMAGE_FLASH_TICKS);
    target._damageFlashStrength = Math.max(Number(target._damageFlashStrength) || 0, scaledStrength);
    target._damageFlashColor = getDamageFlashColor(target, sourceOwner);
    // Units flashing now take the per-object path (see UNIT RENDER SLOTS).
    if (target.unitType && target.id !== undefined) renderer3dFlashUntil.set(target.id, target._damageFlashUntil);
}
const renderer3dFlashUntil = new Map();

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

    // Don't show upgrading progress if at max level
    if (isProgress && entity) {
        let baseLevel = getThingBaseLevel(entity);
        let maxLevel = getThingResearchedMaxLevel(entity);
        if (baseLevel >= maxLevel) {
            isProgress = false;
        }
    }

    let manualStacks = Number(entity && entity.manualStacks);
    let stackedStacks = Number(entity && entity.stacks);
    let hasStackQueue = (Number.isFinite(manualStacks) && Number.isFinite(stackedStacks))
        ? (manualStacks > stackedStacks)
        : (!!entity && getThingManualStacks(entity) > getThingStackedStacks(entity));

    // Don't show stacking progress if next stack would exceed max level
    if (hasStackQueue && entity) {
        let nextStackLevel = stackCountToLevel(getThingStackedStacks(entity) + 1);
        let maxLevel = getThingResearchedMaxLevel(entity);
        if (nextStackLevel > maxLevel) {
            hasStackQueue = false;
        }
    }

    if (hasStackQueue) {
        bars.push({ pct: getThingStackingProgressRatio(entity), bgColor: '#11291c', fillColor: '#2fd27f' });
    }
    if (maxEnergy > 0 && (isProgress || hasStackQueue || energy < maxEnergy)) {
        bars.push({ pct: maxEnergy > 0 ? energy / maxEnergy : 0, bgColor: isProgress ? '#333' : '#600', fillColor: isProgress ? '#fa0' : '#0f0' });
    }
    for (let bar of extraBars) bars.push(bar);
    return build3DStatusTextureOptions(entity && entity.textCanvas && shouldShowBuildingLevels(entity) ? getLevelLabelText(entity) : '', bars);
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
    let maxEnergy = Number(unit && unit.preComputed && unit.preComputed.maxEnergy);
    if (unit && unit.energy < maxEnergy) {
        bars.push({ pct: Math.max(0, unit.energy / Math.max(1, maxEnergy)), bgColor: '#600', fillColor: '#0f0' });
    }
    let status = build3DStatusTextureOptions(shouldShowUnitLevels(unit) ? getUnitLevelLabelText(unit) : '', bars);
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

const renderer3dExact2DTextureCache = new Map();
const RENDERER3D_EXACT_2D_TEXTURE_CACHE_MAX = 1024;
let renderer3dExactTextureFrame = 0;
let renderer3dExactTextureBuildsRemaining = 12;
let renderer3dExactTextureTimeRemaining = 2;
let renderer3dExactUnitTextureBuildsRemaining = 12;
let renderer3dExactUnitTextureTimeRemaining = 2;

// Evicted panel canvases are redrawn for new signatures: creating a canvas
// and its context cost several times the drawing. Every drawing gets a new
// _textureVersion, so holders of a recycled canvas (GPU caches, cached
// scene objects) see that it changed. Holders that keep a panel across
// frames without looking it up mark it used (_touch3DPanel).
const renderer3dPanelPool = [];
const RENDERER3D_PANEL_POOL_MAX = 256;
let renderer3dPanelSerial = 0;

function _touch3DPanel(panel) {
    if (panel && panel._panelCtx) panel._usedFrame = renderer3dExactTextureFrame;
}

// Structure layer state (see build3DFrameData, STRUCTURE LAYER).
let renderer3dStaticLayer = null;
let renderer3dStaticLayerVersion = 0;
// Set when _reuseStatic3DObject serves a structure from its cache.
let _staticReuseHit = false;

// Structures whose activity effects play every frame (_pushStructureActivity).
function _structureHasActivity(entity) {
    if (!entity || entity.underConstruction) return false;
    return entity.type === 'house' || entity.type === 'research' || !!(entity.spawnQueue && entity.spawnQueue.length);
}

function _pin3DPanelToStatic(panel, version) {
    if (panel && panel._panelCtx) { panel._usedFrame = renderer3dExactTextureFrame; panel._staticPin = version; }
}

// Panels drawn by the unit layer stay in use for its whole life (until the
// next build) without a touch per frame.
function _pin3DPanelToLayer(panel, version) {
    if (panel && panel._panelCtx) { panel._usedFrame = renderer3dExactTextureFrame; panel._layerPin = version; }
}

function cache3DExact2DTexture(signature, panel) {
    panel._usedFrame = renderer3dExactTextureFrame;
    renderer3dExact2DTextureCache.set(signature, panel);
}

function getCached3DExact2DTexture(signature) {
    let panel = renderer3dExact2DTextureCache.get(signature);
    if (panel) panel._usedFrame = renderer3dExactTextureFrame;
    return panel;
}

function begin3DTextureFrame() {
    renderer3dExactTextureFrame++;
    // Match the GPU cache: the visible working set may exceed the idle budget.
    // Evict only unused entries, once per frame, rather than evicting panels
    // that an earlier entity just used and rebuilding them on the next frame.
    if (renderer3dExact2DTextureCache.size <= RENDERER3D_EXACT_2D_TEXTURE_CACHE_MAX) return;
    for (let [key, panel] of renderer3dExact2DTextureCache) {
        if (panel._usedFrame >= renderer3dExactTextureFrame - 2) continue;
        // (Guarded: some tests load parts of this file.)
        if (typeof renderer3dUnitLayer !== 'undefined' && renderer3dUnitLayer && panel._layerPin === renderer3dUnitLayer.version) continue;
        if (typeof renderer3dStaticLayer !== 'undefined' && renderer3dStaticLayer && panel._staticPin === renderer3dStaticLayer.version) continue;
        renderer3dExact2DTextureCache.delete(key);
        if (panel._panelCtx && renderer3dPanelPool.length < RENDERER3D_PANEL_POOL_MAX) renderer3dPanelPool.push(panel);
        if (renderer3dExact2DTextureCache.size <= RENDERER3D_EXACT_2D_TEXTURE_CACHE_MAX) break;
    }
}

function quantize3DExactRatio(value, maximum) {
    if (!(maximum > 0)) return 0;
    return Math.round(Math.max(0, Math.min(1, (Number(value) || 0) / maximum)) * RENDERER3D_TOP_TEXTURE_SIZE);
}

// Each entity's last visual signature lives on it (entity._r3dSig): a
// property read instead of a WeakMap lookup per visible entity.
const renderer3dSignatureScratch = [];

function get3DExact2DVisualSignature(entity, isUnit = false) {
    if (!entity) return '';
    let researchTask = entity.researchTask || null;
    let maxEnergy = Number(entity.maxEnergy)
        || Number(entity.preComputed && entity.preComputed.maxEnergy)
        || Number(entity.preComputedEffective && entity.preComputedEffective.maxEnergy)
        || 0;
    // Unit panels omit attacks (drawn as effects), so a fight does not
    // re-rasterize every attacking unit's panel each tick.
    let activeAttack = !isUnit;
    let attackTarget = activeAttack ? entity.attackTarget || null : null;
    // Filled in place: allocating this per visible entity per frame only fed
    // the garbage collector, as unchanged inputs reuse the stored key.
    let values = renderer3dSignatureScratch, n = 0;
    values[n++] = entity.type || '';
    values[n++] = entity.unitType || '';
    values[n++] = Number(entity.owner) || 0;
    values[n++] = entity.vis || '';
    values[n++] = entity.color || '';
    values[n++] = Math.round((Number(entity.r) || 0) * 10);
    values[n++] = entity.textCanvas && shouldShowBuildingLevels(entity) ? getLevelLabelText(entity) : '';
    values[n++] = entity.unitType && shouldShowUnitLevels(entity) ? getUnitLevelLabelText(entity) : '';
    values[n++] = quantize3DExactRatio(entity.energy, maxEnergy);
    values[n++] = entity.underConstruction ? 1 : 0;
    values[n++] = entity.isUpgrading ? 1 : 0;
    values[n++] = quantize3DExactRatio(entity.stackingWorkDone, Number(entity.stackingWorkRequired) || 0);
    values[n++] = quantize3DExactRatio(entity.spawnTimer, Number(entity.spawnCooldown) || 0);
    values[n++] = researchTask ? quantize3DExactRatio(researchTask.workDone, Number(researchTask.workRequired) || 0) : 0;
    values[n++] = Math.round((Number(entity.angle) || 0) * 128);
    values[n++] = Number(entity.laserState) || 0;
    values[n++] = Array.isArray(entity.connectedLasers) ? entity.connectedLasers.length : 0;
    values[n++] = entity.carryingValue > 0 ? 1 : 0;
    values[n++] = entity.workerState || '';
    values[n++] = entity.burning > 0 ? 1 : 0;
    values[n++] = entity.poisoned > 0 ? 1 : 0;
    values[n++] = entity.frozen > 0 ? 1 : 0;
    values[n++] = entity.wet > 0 ? 1 : 0;
    values[n++] = isUnit ? 0 : Number(entity.attackFlash) || 0;
    values[n++] = activeAttack ? entity.attackStyle || '' : '';
    values[n++] = attackTarget ? Math.round((Number(attackTarget.x) - Number(entity.x)) / 4) : 0;
    values[n++] = attackTarget ? Math.round((Number(attackTarget.y) - Number(entity.y)) / 4) : 0;
    values[n++] = Number.isFinite(entity._energyBlockedUntil) && gameTime < entity._energyBlockedUntil ? 1 : 0;
    values[n++] = entity.researcherHasMaterial ? 1 : 0;
    // Keep the interned key when visual inputs are unchanged. Joining and
    // hashing a long key for every visible unit dominated zoomed-out frames.
    let previous = entity._r3dSig;
    if (previous && previous.isUnit === isUnit) {
        let same = true, stored = previous.values;
        for (let i = 0; i < n; i++) if (values[i] !== stored[i]) { same = false; break; }
        if (same) return previous.signature;
    }
    let stored = values.slice(0, n);
    let signature = stored.join('|');
    entity._r3dSig = { isUnit, values: stored, signature };
    return signature;
}

function get3DExact2DCapture(entity, x, y, isUnit) {
    if (!isUnit) return { centerX: x, centerY: y, extent: TILE };

    let radius = Math.max(1, Number(entity && entity.r) || 8);
    let halfWidth = radius + 3; // body outline and the energy bar overhang
    let top = y - radius - 7;  // health bar
    let bottom = y + radius + 3;

    if (shouldShowUnitLevels(entity)) {
        let labelSprite = _getUnitLevelTextSprite(getUnitLevelLabelText(entity));
        halfWidth = Math.max(halfWidth, labelSprite.width * 0.5);
        top -= labelSprite.height;
    }

    // Worker/carrying glyphs share the health-bar area, but can extend six
    // logical pixels above and to either side of their center.
    if (get3DUnitStatusGlyph(entity)) {
        halfWidth = Math.max(halfWidth, 7);
        top = Math.min(top, y - radius - 15);
    }

    let left = x - halfWidth;
    let right = x + halfWidth;
    let centerY = (top + bottom) * 0.5;
    return {
        centerX: (left + right) * 0.5,
        centerY,
        extent: Math.max(right - left, bottom - top)
    };
}

// Render through the same draw method as the 2D renderer. This deliberately
// includes its cached level sprite, progress bars, status colors and outlines.
// Whether the last get3DExact2DTexture call returned a stand-in because this
// frame's raster budget was spent (cached scene objects must not keep it).
let renderer3dExactTextureFallback = false;
// True while a unit panel is rasterized: Unit.draw leaves out attacks.
let renderer3dPanelRaster = false;

function _rasterize3DPanel(signature, scale, offsetX, offsetY, drawFn) {
    let canvas = renderer3dPanelPool.pop();
    if (!canvas) {
        canvas = document.createElement('canvas');
        canvas.width = RENDERER3D_TOP_TEXTURE_SIZE;
        canvas.height = RENDERER3D_TOP_TEXTURE_SIZE;
        canvas._panelCtx = canvas.getContext('2d');
        if (!canvas._panelCtx) return null;
    }
    let g = canvas._panelCtx, size = RENDERER3D_TOP_TEXTURE_SIZE;
    g.imageSmoothingEnabled = false;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalAlpha = 1;
    g.clearRect(0, 0, size, size);
    g.save();
    g.__drawImagesImmediately = true;
    g.setTransform(scale, 0, 0, scale, offsetX, offsetY);
    drawFn(g);
    g.restore();
    g.__drawImagesImmediately = false;
    canvas._renderer3DExactKey = `2d:${signature}`;
    canvas._textureVersion = ++renderer3dPanelSerial;
    canvas._flatWorldSize = undefined;
    canvas._flatOffsetZ = undefined;
    return canvas;
}

function get3DExact2DTexture(entity, useUnitBudget = false) {
    renderer3dExactTextureFallback = false;
    if (!entity || typeof entity.draw !== 'function') return null;
    let signature = get3DExact2DVisualSignature(entity, useUnitBudget);
    let cached = getCached3DExact2DTexture(signature);
    if (cached) {
        _rememberExact2DTexture(entity, cached);
        return cached;
    }
    // A camera jump must not rasterize hundreds of status panels at once.
    // Callers already have a shared type/owner sprite as a fallback.
    // Units are collected after buildings. Give them a separate raster
    // budget so a dense base cannot permanently starve every unit panel.
    if (useUnitBudget) {
        if (renderer3dExactUnitTextureBuildsRemaining <= 0 || renderer3dExactUnitTextureTimeRemaining <= 0) {
            renderer3dExactTextureFallback = true;
            return get3DExact2DFallbackTexture(entity, true);
        }
        renderer3dExactUnitTextureBuildsRemaining--;
    } else {
        if (renderer3dExactTextureBuildsRemaining <= 0 || renderer3dExactTextureTimeRemaining <= 0) {
            renderer3dExactTextureFallback = true;
            return get3DExact2DFallbackTexture(entity, false);
        }
        renderer3dExactTextureBuildsRemaining--;
    }
    let buildStarted = performance.now();
    let x = Number(entity.x);
    let y = Number(entity.y);
    if (!Number.isFinite(x)) x = (Number(entity.gx) || 0) * TILE + TILE * 0.5;
    if (!Number.isFinite(y)) y = (Number(entity.gy) || 0) * TILE + TILE * 0.5;
    // Unit labels and status marks live above the body in 2D. Center the
    // capture on that complete footprint instead of on the body alone; the
    // old tile-centered crop cut level labels off the mounted panel.
    let capture = get3DExact2DCapture(entity, x, y, useUnitBudget);
    let size = RENDERER3D_TOP_TEXTURE_SIZE;
    let scale = (size - 8) / Math.max(1, capture.extent);
    renderer3dPanelRaster = useUnitBudget;
    let panel;
    try {
        panel = _rasterize3DPanel(signature, scale, size * 0.5 - capture.centerX * scale, size * 0.5 - capture.centerY * scale,
            g => entity.draw(g));
    } finally {
        renderer3dPanelRaster = false;
    }
    if (!panel) return null;
    // Flat sprites include the capture padding and the label's offset above
    // the entity. Model footprints are deliberately unrelated to these sizes.
    panel._flatWorldSize = size / scale / TILE;
    panel._flatOffsetZ = (capture.centerY - y) / TILE;
    cache3DExact2DTexture(signature, panel);
    _rememberExact2DTexture(entity, panel);
    let buildTime = performance.now() - buildStarted;
    if (useUnitBudget) renderer3dExactUnitTextureTimeRemaining -= buildTime;
    else renderer3dExactTextureTimeRemaining -= buildTime;
    return panel;
}

// While the raster budget is spent, keep showing the 2D look rather than a
// generic boxed placeholder: first the entity's own previous panel (at most
// a few frames stale), else for units the plain 2D body at the same framing,
// shared by every unit of that type, owner and footprint. The version tells
// whether the previous panel's canvas was since recycled for another.
// Kept on the entity (entity._r3dTex), as the signature above.

function _rememberExact2DTexture(entity, panel) {
    let last = entity._r3dTex;
    if (!last) entity._r3dTex = last = { panel: null, version: 0 };
    last.panel = panel;
    last.version = panel._textureVersion;
}

function get3DExact2DFallbackTexture(entity, isUnit) {
    let previous = entity._r3dTex;
    if (previous && previous.panel._textureVersion === previous.version) {
        _touch3DPanel(previous.panel);
        return previous.panel;
    }
    if (!isUnit) return null;
    let x = Number(entity.x) || 0, y = Number(entity.y) || 0;
    let capture = get3DExact2DCapture(entity, x, y, true);
    let signature = `body|${entity.unitType || ''}|${Number(entity.owner) || 0}|${entity.vis || ''}|${entity.color || ''}|`
        + `${Math.round((Number(entity.r) || 0) * 10)}|${entity.carryingValue > 0 ? 1 : 0}|`
        + `${Math.round(capture.extent * 4)}|${Math.round((capture.centerX - x) * 4)}|${Math.round((capture.centerY - y) * 4)}`;
    let cached = getCached3DExact2DTexture(signature);
    if (cached) return cached;
    let size = RENDERER3D_TOP_TEXTURE_SIZE;
    let scale = (size - 8) / Math.max(1, capture.extent);
    let ownerId = Number(entity.owner);
    let panel = _rasterize3DPanel(signature, scale, size * 0.5 - capture.centerX * scale, size * 0.5 - capture.centerY * scale,
        g => drawUnitBodyGeometry(g, entity, ownerId >= 0 ? get2DRenderOwnerColor(ownerId) : '#000', 1));
    if (!panel) return null;
    panel._flatWorldSize = size / scale / TILE;
    panel._flatOffsetZ = (capture.centerY - y) / TILE;
    cache3DExact2DTexture(signature, panel);
    return panel;
}

// A tile-sized panel (floor items, mines), cached by signature.
function _get3DExact2DTilePanel(signature, drawFn) {
    let cached = getCached3DExact2DTexture(signature);
    if (cached) return cached;
    let size = RENDERER3D_TOP_TEXTURE_SIZE;
    let scale = (size - 8) / TILE;
    let panel = _rasterize3DPanel(signature, scale, size * 0.5 - TILE * 0.5 * scale, size * 0.5 - TILE * 0.5 * scale, drawFn);
    if (panel) cache3DExact2DTexture(signature, panel);
    return panel;
}

function get3DExact2DFloorTexture(item, owner) {
    if (!item) return null;
    let signature = `floor|${Number(owner) || 0}|${get3DExact2DVisualSignature(item)}|${_getFloorItemEnergyBucket(item)}`;
    return _get3DExact2DTilePanel(signature, g => drawFloorItem(g, { item, owner }, 0, 0));
}

function get3DExact2DMineTexture(kind, amount) {
    let active = Number(amount) > 0;
    let label = showGoldMineAmountText ? formatBigNumber(Math.max(0, Number(amount) || 0), 0) : '';
    let signature = `mine|${kind}|${active ? 1 : 0}|${label}`;
    return _get3DExact2DTilePanel(signature, g => {
        queueDrawImage(g, kind === 'astar' ? _getAstarMineTileSprite(active) : _getGoldMineTileSprite(active), 0, 0, TILE, TILE);
        if (label) {
            g.font = 'bold 8px Arial';
            g.textAlign = 'center';
            g.textBaseline = 'middle';
            g.shadowColor = 'rgba(0,0,0,0.9)';
            g.shadowBlur = 2;
            g.fillStyle = kind === 'astar' ? (active ? '#f0f0f0' : '#999') : (active ? '#fffbe8' : '#bbb');
            g.fillText(label, TILE * 0.5, TILE * 0.5);
        }
    });
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
    let accentColor = oppositeOwner >= 0 ? get3DRenderOwnerColor(oppositeOwner) : '#ffffff';
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

// Model scale for non-tower structures. They share the house's roof height
// (~0.52 world) with only slight variation, instead of growing with vision
// range: uneven heights make the 3D skyline look messy. Towers stay tall.
function get3DStructureModelHeight(type) {
    // Barracks and worker buildings are flat workshop yards (deck plus
    // features along the back edge); one height keeps the skyline even.
    return 0.62;
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
        // Owner dot removed in favor of border
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
            g.fillStyle = '#432'; g.fillRect(size * 0.22, size * 0.22, size * 0.56, size * 0.56);
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
            g.fillStyle = '#355';
            g.fillRect(size * 0.22, size * 0.22, size * 0.56, size * 0.56);
            g.fillStyle = '#fff'; g.fillRect(size * 0.31, size * 0.38, size * 0.38, size * 0.22);
            g.strokeStyle = '#ddd'; g.lineWidth = 2; g.strokeRect(size * 0.31, size * 0.38, size * 0.38, size * 0.22);
        } else if (kind === 'spawner_research') {
            g.fillStyle = '#446';
            g.fillRect(size * 0.22, size * 0.22, size * 0.56, size * 0.56);
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
    let activeSelectedUnits = getActiveUnitsForRender();
    overlays.selectionContours = getSelectionContours(activeSelectedEntities, activeSelectedUnits, alpha, get3DRenderOwnerColor);
    overlays.selectionDashed = selectionOutlineType === OVERLAY_LINE_DOTTED;
    overlays.selectionSeeThrough = selectionOutlineSeeThrough;
    overlays.worldTileSize = TILE;
    let pushLine = (x1, y1, x2, y2, color, dashed = false) => overlays.lines.push({ x1: x1 / TILE, z1: y1 / TILE, x2: x2 / TILE, z2: y2 / TILE, color, dashed });
    let markerKeys = new Set();
    let pushMarker = (x, y, kind, color) => {
        let key = `${x}|${y}|${kind}|${color}`;
        if (markerKeys.has(key)) return;
        markerKeys.add(key);
        overlays.markers.push({ x: x / TILE, z: y / TILE, kind, color });
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
                if (showRallyLinesForBuildings()) pushLine(ex, ey, marker.x, marker.y, marker.locked ? '#9cf' : 'rgba(153,204,255,0.55)', false);
                pushMarker(marker.x, marker.y, showRallyLinesForBuildings() ? 'dot' : 'plus', '#9cf');
            }
        }


    }

    overlays.rangeLines = clipRangeBoundaryToBounds(getRenderRangeBoundary(activeSelectedEntities, activeSelectedUnits),
        bounds.minGx - 1, bounds.minGy - 1, bounds.maxGx + 2, bounds.maxGy + 2);
    overlays.rangeSeeThrough = renderRangeSeeThrough;

    for (let u of activeSelectedUnits) {
        if (!u || u.dead) continue;
        let ux = Number.isFinite(u.prevX) ? (u.prevX + (u.x - u.prevX) * alpha) : u.x;
        let uy = Number.isFinite(u.prevY) ? (u.prevY + (u.y - u.prevY) * alpha) : u.y;
        if (u.commandState >= CMD_MOVING && u.commandState <= CMD_ATTACK_MOVING) {
            let destX = null, destY = null;
            let lastPt = typeof unitDisplayDest === 'function' ? unitDisplayDest(u) : (u.path && u.path.length ? u.path[u.path.length - 1] : null);
            if (lastPt) {
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
            if (showRallyLinesForUnits()) pushLine(ux, uy, u.targetUnit.x, u.targetUnit.y, 'rgba(255,0,0,0.6)');
            else pushMarker(u.targetUnit.x, u.targetUnit.y, 'plus', '#f66');
        } else if (u.targetBuilding && u.targetBuilding.energy > 0 && u.commandState === CMD_ATTACKING) {
            if (showRallyLinesForUnits()) pushLine(ux, uy, u.targetBuilding.x, u.targetBuilding.y, 'rgba(255,0,0,0.6)');
            else pushMarker(u.targetBuilding.x, u.targetBuilding.y, 'plus', '#f66');
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

    // The tile index already tracks floor entities; empty terrain has no markers.
    if (typeof _activeTileEntities !== 'undefined') {
        for (const item of _activeTileEntities) {
            const x = item.gx, y = item.gy;
            if (!item.markedForSalvage || x < bounds.minGx || x > bounds.maxGx || y < bounds.minGy || y > bounds.maxGy) continue;
            if (grid[y] && grid[y][x] && grid[y][x].item === item && (fullVisibility || (visibilityGrid[y] && visibilityGrid[y][x] > 0)))
                pushSalvageCross(x * TILE + TILE * .5, y * TILE + TILE * .5);
        }
    } else {
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
    }

    return overlays;
}

function getVisualUnitSourceLight(unit) {
    if (!unit || !unit.unitType || unit.dead || unit._historyGhost) return 0;
    // A unit view (sim_frame.js): the worker's value for this player.
    if (unit._frameView) return unit._col('light');
    if (unit.owner !== localPlayerId && !(unit.watched > 0 && unit.watchedByTeam === localPlayerId)) return 0;
    let range = getEntityEffectiveVisibilityRangeTiles(unit);
    return Number.isFinite(range) ? Math.max(0, range) : 0;
}

function getRenderLightGradient(gx, gy) {
    const o = _lightGradientIndex(gx, gy);
    return Array.from(_lightGradients.values.subarray(o, o + 8));
}

// Light gradients at a tile's four corners (8 values per tile), cached for
// one visibility grid version in typed arrays: every visible object reads
// them each frame. Keys as (gy + 2) * (GRID_W + 4) + gx + 2.
const _lightGradients = { grid: null, version: -1, width: 0, stamp: 0, stamps: null, values: null };

// Index of the tile's 8 gradient values in _lightGradients.values.
function _lightGradientIndex(gx, gy) {
    const version = typeof visibilityVersion === 'number' ? visibilityVersion : 0;
    const cache = _lightGradients, _vis = visibilityGrid;
    const width = GRID_W + 4, size = width * ((_vis ? _vis.length : 0) + 4);
    if (!cache.stamps || cache.stamps.length !== size) {
        cache.stamps = new Int32Array(size);
        cache.values = new Float64Array(size * 8 + 8); // + one uncached slot
        cache.stamp = 0;
        cache.grid = null;
    }
    if (cache.grid !== _vis || cache.version !== version || cache.width !== width) {
        cache.grid = _vis; cache.version = version; cache.width = width;
        if (++cache.stamp >= 0x7fffffff) { cache.stamps.fill(0); cache.stamp = 1; }
    }
    const key = (gy + 2) * width + gx + 2;
    const cached = key >= 0 && key < size;
    if (cached && cache.stamps[key] === cache.stamp) return key * 8;
    const o = cached ? key * 8 : size * 8, g = cache.values;
    g[o] = ((_vis[gy] && _vis[gy][gx + 1]) || 0) - ((_vis[gy] && _vis[gy][gx - 1]) || 0);
    g[o + 1] = ((_vis[gy + 1] && _vis[gy + 1][gx]) || 0) - ((_vis[gy - 1] && _vis[gy - 1][gx]) || 0);
    g[o + 2] = ((_vis[gy] && _vis[gy][gx + 2]) || 0) - ((_vis[gy] && _vis[gy][gx]) || 0);
    g[o + 3] = ((_vis[gy + 1] && _vis[gy + 1][gx + 1]) || 0) - ((_vis[gy - 1] && _vis[gy - 1][gx + 1]) || 0);
    g[o + 4] = ((_vis[gy + 1] && _vis[gy + 1][gx + 1]) || 0) - ((_vis[gy + 1] && _vis[gy + 1][gx - 1]) || 0);
    g[o + 5] = ((_vis[gy + 2] && _vis[gy + 2][gx]) || 0) - ((_vis[gy] && _vis[gy][gx]) || 0);
    g[o + 6] = ((_vis[gy + 1] && _vis[gy + 1][gx + 2]) || 0) - ((_vis[gy + 1] && _vis[gy + 1][gx]) || 0);
    g[o + 7] = ((_vis[gy + 2] && _vis[gy + 2][gx + 1]) || 0) - ((_vis[gy] && _vis[gy][gx + 1]) || 0);
    if (cached) cache.stamps[key] = cache.stamp;
    return o;
}

// Shadow direction at (ox, oz) in tiles from the bilinear light gradient,
// or the default direction where the light is flat. Written to `out`.
const _shadowDirScratch = { x: 0, z: 0 };
function _shadowDirAt(ox, oz, out) {
    let gx = Math.floor(ox), gy = Math.floor(oz);
    let fx = ox - gx, fz = oz - gy, ifx = 1 - fx, ifz = 1 - fz;
    const o = _lightGradientIndex(gx, gy), g = _lightGradients.values;
    let gradX = g[o] * ifx * ifz + g[o + 2] * fx * ifz + g[o + 4] * ifx * fz + g[o + 6] * fx * fz;
    let gradZ = g[o + 1] * ifx * ifz + g[o + 3] * fx * ifz + g[o + 5] * ifx * fz + g[o + 7] * fx * fz;
    let gradLen = Math.hypot(gradX, gradZ);
    if (gradLen > 0.001) { out.x = gradX / gradLen; out.z = gradZ / gradLen; }
    else { out.x = DEFAULT_SHADOW_DIR_X; out.z = DEFAULT_SHADOW_DIR_Y; }
    return out;
}

function resolveRenderVisionRange(source) {
    if (!source) return NaN;
    if (typeof getEntityEffectiveVisibilityRangeTiles === 'function') {
        let sharedTiles = Number(getEntityEffectiveVisibilityRangeTiles(source));
        if (Number.isFinite(sharedTiles)) return sharedTiles;
    }
    if (source.preComputed && Number.isFinite(source.preComputed.visionRangeArea)) return Number(source.preComputed.visionRangeArea) * AREA_UNIT_TILE_EQUIVALENT;
    if (source.currentStats && Number.isFinite(source.currentStats.visionRangeArea)) return Number(source.currentStats.visionRangeArea) * AREA_UNIT_TILE_EQUIVALENT;
    if (source.basePreComputed && Number.isFinite(source.basePreComputed.visionRangeArea)) return Number(source.basePreComputed.visionRangeArea) * AREA_UNIT_TILE_EQUIVALENT;
    if (source.currentStats && Number.isFinite(source.currentStats.visionRange)) return Number(source.currentStats.visionRange);
    if (source.preComputed && Number.isFinite(source.preComputed.visionRange)) return Number(source.preComputed.visionRange);
    if (source.basePreComputed && Number.isFinite(source.basePreComputed.visionRange)) return Number(source.basePreComputed.visionRange);

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
}

const RENDER_NO_MODEL_CANDIDATES = Object.freeze([]);

// Whether a render view's grid is the live one (not a remembered history
// grid), so the live tile indexes describe it.
function _isLiveRenderGrid(viewGrid) {
    return viewGrid === grid && typeof getCellItemsRowMajor === 'function' && typeof findCellItemRowStart === 'function';
}

function push3DRenderObject(target, object) {
    if (!target || !object) return;
    let ox = Number(object.x) || 0;
    let oz = Number(object.z) || 0;
    let gx = Math.floor(ox);
    let gy = Math.floor(oz);
    const rememberedSource = object.visibilitySource || object.pickSource;
    const remembered = !!(rememberedSource && rememberedSource._historyGhost);
    let lightGrid = remembered ? getRenderVisibilityGrid() : visibilityGrid;
    let lightRawCenter = fullVisibility ? VISIBILITY_LIGHT_NORMALIZATION_RANGE : ((lightGrid[gy] && lightGrid[gy][gx]) || 0);
    if (!fullVisibility && object.visibilitySource && object.visibilitySource.unitType) {
        lightRawCenter = Math.max(lightRawCenter, getVisualUnitSourceLight(object.visibilitySource));
    }
    let lightLevel = fullVisibility ? 1 : Math.max(0, Math.min(1, lightRawCenter / VISIBILITY_LIGHT_NORMALIZATION_RANGE));
    // Bilinear interpolation of gradient across 4 surrounding tile corners to avoid boundary jumps
    let shadowDirX = DEFAULT_SHADOW_DIR_X;
    let shadowDirZ = DEFAULT_SHADOW_DIR_Y;
    if (!fullVisibility && !target.flat2d) {
        const dir = _shadowDirAt(ox, oz, _shadowDirScratch);
        shadowDirX = dir.x; shadowDirZ = dir.z;
    }
    let finalLightLevel = Math.max(0, Math.min(1, Number(object.lightLevel) || lightLevel));
    let visionRange = Number(object.visibilityRangeTiles);
    if (!Number.isFinite(visionRange)) visionRange = Number(object.visionRange);
    if (!target.flat2d && !Number.isFinite(visionRange)) visionRange = resolveRenderVisionRange(object.visibilitySource);
    let resolvedScaleY = Math.max(0.05, Number(object.scaleY) || 0.05);
    if (!object.preserveModelHeight && Number.isFinite(visionRange) && visionRange > 0) {
        let visibilityHeight = Math.max(0.18, visionRange / 5);
        resolvedScaleY = Math.max(0.05, resolvedScaleY * visibilityHeight);
    }
    let overlapFadeKey;
    if (object.overlapFade) {
        let fade = object.overlapFade;
        // Numeric key (model id, tile): hundreds of mines use this every frame.
        let modelIds = push3DRenderObject.fadeModelIds || (push3DRenderObject.fadeModelIds = new Map());
        let modelId = modelIds.get(object.modelKey);
        if (modelId === undefined) modelIds.set(object.modelKey, modelId = modelIds.size);
        let key = modelId * 4294967296 + (fade.gy & 0xffff) * 65536 + (fade.gx & 0xffff);
        let lowHeight = Math.min(resolvedScaleY, Math.max(RENDERER3D_OVERLAP_MIN_HEIGHT,
            Math.min(RENDERER3D_OVERLAP_MAX_HEIGHT, resolvedScaleY * RENDERER3D_OVERLAP_HEIGHT_FRACTION)));
        let targetHeight = fade.occupied ? lowHeight : resolvedScaleY;
        let state = renderer3dOverlapFadeState.get(key);
        if (!state) {
            state = { value: resolvedScaleY, lastUpdateMs: fade.nowMs, lastSeenMs: fade.nowMs };
            renderer3dOverlapFadeState.set(key, state);
        } else {
            let deltaMs = Math.max(0, fade.nowMs - state.lastUpdateMs);
            // Same speed both ways: rising mirrors the descent.
            let maxStep = deltaMs / RENDERER3D_OVERLAP_FADE_DURATION_MS * Math.max(0.01, resolvedScaleY - lowHeight);
            if (targetHeight > state.value) state.value = Math.min(targetHeight, state.value + maxStep);
            else if (targetHeight < state.value) state.value = Math.max(targetHeight, state.value - maxStep);
            state.lastUpdateMs = fade.nowMs;
            state.lastSeenMs = fade.nowMs;
        }
        fade.activeKeys.add(key);
        resolvedScaleY = state.value;
        overlapFadeKey = key;
    }
    let tint = _getCachedLitTint(object.tint || '#c8ced8', finalLightLevel);
    let sideTint = _getCachedLitTint(object.sideTint || object.tint || '#c8ced8', finalLightLevel);
    target.push({
        baseTint: object.tint || '#c8ced8',
        baseSideTint: object.sideTint || object.tint || '#c8ced8',
        pickSource: (object.pickSource || object.visibilitySource || {})._historyGhost ? null : object.pickSource || object.visibilitySource || null,
        modelKey: object.modelKey || 'cube',
        modelCandidates: Array.isArray(object.modelCandidates) && object.modelCandidates.length ? object.modelCandidates.slice() : RENDER_NO_MODEL_CANDIDATES,
        x: Number(object.x) || 0,
        z: Number(object.z) || 0,
        y: Number(object.y) || 0,
        scaleX: Math.max(0.05, Number(object.scaleX) || 0.05),
        scaleY: resolvedScaleY,
        overlapFadeKey,
        scaleZ: Math.max(0.05, Number(object.scaleZ) || 0.05),
        rotationY: Number(object.rotationY) || 0,
        moveAmount: Math.max(0, Math.min(1, Number(object.moveAmount) || 0)),
        walkPhase: Number(object.walkPhase) || 0,
        animationMode: Math.max(0, Math.min(7, Math.floor(Number(object.animationMode) || 0))),
        weaponType: String(object.weaponType || ''),
        preserveModelHeight: !!object.preserveModelHeight,
        isFlying: !!object.isFlying,
        isWorker: !!object.isWorker,
        tint,
        sideTint,
        alpha: Math.max(0.05, Math.min(1, Number(object.alpha) || 1)),
        renderShape: object.renderShape === 'cylinder' ? 'cylinder' : 'box',
        topTextureKey: object.topTextureKey || '',
        topTextureCanvas: object.topTextureCanvas || null,
        topTextureUv: object.topTextureUv || null,
        sideTextureKey: object.sideTextureKey || '',
        sideTextureCanvas: object.sideTextureCanvas || null,
        sideTextureAngle: Number.isFinite(object.sideTextureAngle) ? Number(object.sideTextureAngle) : 0,
        statusTextureCanvas: object.statusTextureCanvas || null,
        lightLevel: finalLightLevel,
        historyGhost: remembered,
        shadowDirX: Number.isFinite(object.shadowDirX) ? Number(object.shadowDirX) : shadowDirX,
        shadowDirZ: Number.isFinite(object.shadowDirZ) ? Number(object.shadowDirZ) : shadowDirZ,
        shadowLength: Math.max(0.6, Math.min(2.4, Number(object.shadowLength) || (1 + (1 - lightLevel) * 0.9))),
        // The 3D renderer's own per-object caches, declared here so every
        // render object has one shape (fast property reads in its loops).
        _r3dGroupKey: undefined, _r3dGroupFigure: undefined, _r3dKind: undefined, _r3dKindModel: undefined, _r3dKindWeapon: undefined,
        _r3dLod: 0, _r3dPick: null,
        _iRot: NaN, _iCos: 1, _iSin: 0, _iTint: undefined, _iRgb: null, _iSide: undefined, _iSideRgb: null,
        // Unit layer: position at the tick, offset back to the previous
        // tick, walk phase rate and flyer bob (see UNIT LAYER).
        _cx: 0, _cz: 0, _pdx: 0, _pdz: 0, _phaseRate: 0, _flyOn: 0, _flySeed: 0, _layerTop: -1,
        _iAtlasKey: undefined, _iAtlasOk: false, _litFor: undefined
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
        viewPad: getRenderViewPad(),
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
    let pointInBox = (worldX, worldY, lift) => {
        let projected = renderer3dInstance.projectWorldToScreen(worldX / TILE, lift, worldY / TILE);
        return !!projected && projected.x >= minSx && projected.x <= maxSx && projected.y >= minSy && projected.y <= maxSy;
    };

    // What the player sees: anything whose drawn model reaches into the box.
    // The ground point is checked first (cheap, and the only test for things
    // not drawn last frame); only the rest have their drawn mesh tested.
    let unitCandidates = [], entityCandidates = [];
    let pending = new Set();
    let consider = (list, ref, worldX, worldY, lift, mark = null) => {
        let hit = pointInBox(worldX, worldY, lift);
        if (!hit) pending.add(ref);
        list.push({ ref, hit, mark });
    };
    for (let u of units) {
        if (u.owner !== localPlayerId || u.dead) continue;
        let ux = Number.isFinite(u.prevX) ? (u.prevX + (u.x - u.prevX) * alpha) : u.x;
        let uy = Number.isFinite(u.prevY) ? (u.prevY + (u.y - u.prevY) * alpha) : u.y;
        let ugx = Math.floor(ux / TILE), ugy = Math.floor(uy / TILE);
        if (!isTileVisible(ugx, ugy)) continue;
        consider(unitCandidates, u, ux, uy, 0.28);
    }
    for (let b of barracks) {
        if (b.energy > 0 && b.owner === localPlayerId && isTileVisible(b.gx, b.gy)) consider(entityCandidates, b, b.x, b.y, 0.12);
    }
    for (let t of towers) {
        if (t.energy > 0 && t.owner === localPlayerId && isTileVisible(t.gx, t.gy)) consider(entityCandidates, t, t.x, t.y, 0.18);
    }
    for (let s of collectorSpawners) {
        if (s.energy > 0 && s.owner === localPlayerId && isTileVisible(s.gx, s.gy)) consider(entityCandidates, s, s.x, s.y, 0.14);
    }
    let seenItems = new Set(entityCandidates.map(c => c.ref));
    let bounds = get3DVisibleWorldBounds();
    let items = getCellItemsRowMajor();
    for (let i = findCellItemRowStart(items, bounds.minGy); i < items.length; i++) {
        let item = items[i], gx = item.gx, gy = item.gy;
        if (gy > bounds.maxGy) break;
        if (gx < bounds.minGx || gx > bounds.maxGx || seenItems.has(item)) continue;
        let cell = grid[gy] && grid[gy][gx];
        if (!cell || cell.item !== item || cell.owner !== localPlayerId || !isTileVisible(gx, gy)) continue;
        seenItems.add(item);
        consider(entityCandidates, item, gx * TILE + TILE * 0.5, gy * TILE + TILE * 0.5, 0.08, item => { item._gx = gx; item._gy = gy; item._cell = cell; });
    }
    for (let m of goldMines) {
        if (isTileVisible(m.gx, m.gy)) consider(entityCandidates, m, m.x, m.y, 0.06, mine => { mine._isGoldMine = true; });
    }
    for (let m of astarMines) {
        if (isTileVisible(m.gx, m.gy)) consider(entityCandidates, m, m.x, m.y, 0.06, mine => { mine._isAstarMine = true; });
    }

    let drawnHits = pending.size && typeof renderer3dInstance.boxRenderedSources === 'function'
        ? renderer3dInstance.boxRenderedSources(minSx, minSy, maxSx, maxSy, pending)
        : null;
    let newUnits = [];
    let newEntities = [];
    for (let c of unitCandidates) if (c.hit || (drawnHits && drawnHits.has(c.ref))) newUnits.push(c.ref);
    for (let c of entityCandidates) {
        if (!c.hit && !(drawnHits && drawnHits.has(c.ref))) continue;
        if (c.mark) c.mark(c.ref);
        newEntities.push(c.ref);
    }
    return { units: newUnits, entities: newEntities };
}

function getBackgroundWorldBoundsForRenderMode() {
    return renderDimensionMode === '3d' ? get3DVisibleWorldBounds() : getVisibleWorldBounds(1);
}

function getUnit3DActivity(u) {
    // A unit view (sim_frame.js): the worker's reading of it.
    if (u._frameView) return u._activity();
    let moving = Math.hypot(u.x - u.prevX, u.y - u.prevY) > 0.01;
    if (u.attackFlash > 0) return { mode: 1, amount: 1, target: u.attackTarget || null };
    let state = String(u.workerState || '');
    if ((u.workerType === 'collector' || u.workerType === 'astar_collector') && u.workerTransferCooldown > 0 && u.carryingValue > 0) return { mode: 3, amount: 1, target: u.workerTarget || null };
    if (u.workerType === 'salvager' && u.workerTransferCooldown > 0) return { mode: 4, amount: 1, target: u.workerTarget || null };
    if (!u.workerType || moving) return { mode: 0, amount: moving ? 1 : 0, target: null };
    let hasArrived = !u.path || u.pathIndex >= u.path.length;
    if (u.workerType === 'builder' && (state === 'BUILDING_IN_PLACE' || (state === 'MOVING_TO_BUILD' && hasArrived))) return { mode: 2, amount: 1, target: u.workerTarget || null };
    if (u.workerType === 'healer' && (state === 'HEALING' || (state === 'MOVING_TO_HEAL' && hasArrived))) return { mode: 5, amount: 1, target: u.workerTarget || null };
    if (u.workerType === 'researcher' && (state === 'RESEARCHING' || (state === 'MOVING_TO_RESEARCH' && hasArrived))) return { mode: 6, amount: 1, target: u.workerTarget || null };
    return { mode: 0, amount: 0, target: null };
}

// 3D body colors that differ from the 2D sprite color: healers are red and
// researchers blue, so flying workers read apart from fighters at a glance.
const UNIT_3D_BODY_COLORS = { collector: '#f0a52b', healer_unit: '#d8403a', researcher_unit: '#3f74d8' };
// Riders on (winged) horses: height = width * MOUNT_HEIGHT_RATIO.
const MOUNTED_UNIT_TYPES = new Set(['fast', 'scout', 'flying']);
const MOUNT_HEIGHT_RATIO = 0.87;

function getUnit3DWeaponType(u) {
    let unitType = String(u && u.unitType || '');
    let workerType = String(u && u.workerType || '');
    if (workerType === 'builder' || unitType === 'builder_unit') return 'hammer';
    // Energy grows on farm trees (an axe); A* is dug from mines (a pickaxe).
    if (workerType === 'collector' || unitType === 'collector') return 'axe';
    if (workerType === 'astar_collector' || unitType === 'astar_collector') return 'pickaxe';
    if (workerType === 'salvager' || unitType === 'salvager_unit') return 'cutter';
    if (workerType === 'healer' || unitType === 'healer_unit') return 'healer_staff';
    if (workerType === 'researcher' || unitType === 'researcher_unit') return 'research_orb';
    if (unitType === 'king') return 'king_sword';
    if (unitType === 'boss') return 'great_axe';
    if (unitType === 'tank') return 'warhammer';
    if (unitType === 'fast') return 'dual_blades';
    if (unitType === 'flying') return 'lance';
    if (unitType === 'scout') return 'bow';
    if (unitType === 'mole') return 'claws';
    let styleWeapons = {
        fire: 'fire_staff', water: 'water_staff', ice: 'ice_staff',
        poison: 'poison_staff', laser: 'laser_staff', melee: 'sword'
    };
    return styleWeapons[String(u && u.attackStyle || 'melee')] || 'sword';
}

// Idle pose (mode 7): after a unit has stood still for a moment it settles
// into its role's rest pose (workers sit, mounts graze, flyers hover).
const RENDERER3D_IDLE_DELAY_SECONDS = 1.5;
const RENDERER3D_IDLE_SETTLE_SECONDS = .8;
function _unit3DIdleActivity(u, activity, stillSince) {
    if (activity.mode !== 0 || activity.amount > 0 || u.isSnake) return activity;
    let still = (gameTime + (u._historyGhost ? 0 : tickAlpha) - stillSince) / Math.max(1, TICK_RATE) - RENDERER3D_IDLE_DELAY_SECONDS;
    if (still <= 0) return activity;
    return { mode: 7, amount: Math.min(1, still / RENDERER3D_IDLE_SETTLE_SECONDS), target: null };
}

// Flyers keep an altitude with a slow bob; an attack is a dive.
function _unit3DFlightHeight(u, activity) {
    if (!u.isFlying) return 0;
    let t = (u._historyGhost ? u._historyTick : gameTime + tickAlpha) / Math.max(1, TICK_RATE);
    let height = (u.isWorker ? .36 : .30) + Math.sin(t * 2.2 + (Number(u.id) || 0) * 1.7) * .035;
    if (activity.mode === 1) height -= Math.sin(_unit3DWalkPhase(u, activity)) * .22;
    return height;
}

// A building at work (production, research, a lived-in house), placed on
// the structure object just pushed so it follows its rendered height.
function _pushStructureActivity(objects, entity, flat2d) {
    if (flat2d || entity.underConstruction) return;
    let type = entity.type;
    if (type !== 'house' && type !== 'research' && !(entity.spawnQueue && entity.spawnQueue.length)) return;
    let o = objects[objects.length - 1];
    // Workshops are open yards: activity rises from among their back features.
    let roof = type === 'house' ? .63 : .5;
    pushStructureActivityFx(entity, o.x, o.z, o.y + o.scaleY * roof, get3DRenderOwnerColor(entity.owner));
}

// The build placement preview in 3D: a translucent copy of the structure's
// own model on the hovered tile (red where it cannot be built), with the
// item's 2D icon on its panel. Sizes match the structure passes below.
// Returns false while the icon is still loading (the overlay draws it then).
const RENDERER3D_WORKSHOP_KEYS = new Set(['spawner', 'astar_spawner', 'salvager', 'builder_spawner', 'healer_spawner', 'research']);
function _pushBuildPreview3DObject(objects, preview) {
    let key = preview && preview.key;
    let def = key && BASE_CARD_TYPES[key];
    if (!def || preview.areaCells || key === 'area_upgrader') return false;
    let icon = getItemThumbnailImage(key, RENDERER3D_TOP_TEXTURE_SIZE);
    if (!icon || !icon.complete || !(icon.naturalWidth > 0)) return false;
    let panel = get3DTopTextureCanvas(`buildpreview:${key}`, g => g.drawImage(icon, 0, 0, g.canvas.width, g.canvas.height));
    let ownerColor = get3DRenderOwnerColor(localPlayerId);
    let blocked = !preview.canBuild;
    let object = {
        x: preview.gx + 0.5, y: 0, z: preview.gy + 0.5,
        tint: blocked ? '#ff4a3a' : ownerColor,
        sideTint: blocked ? '#ff4a3a' : (def.color || ownerColor),
        alpha: blocked ? 0.45 : 0.6,
        preserveModelHeight: true,
        topTextureKey: `buildpreview:${key}`,
        topTextureCanvas: panel,
        lightLevel: 1
    };
    if (key.startsWith('barrack_')) {
        Object.assign(object, { modelKey: key, scaleX: 0.98, scaleZ: 0.98, scaleY: get3DStructureModelHeight('barrack') });
    } else if (RENDERER3D_WORKSHOP_KEYS.has(key)) {
        Object.assign(object, { modelKey: `spawner_${key}`, scaleX: 0.95, scaleZ: 0.95, scaleY: get3DStructureModelHeight(key) });
    } else if (def.target === 'wall') {
        let portal = !!def.isCloud || key.startsWith('cloud');
        let visionTiles = getTowerPreviewVisionRange(key, preview.previewLevel) * AREA_UNIT_TILE_EQUIVALENT;
        Object.assign(object, {
            modelKey: `tower_${key}`, scaleX: portal ? 0.96 : 0.82, scaleZ: portal ? 0.96 : 0.82,
            scaleY: 1.05, rotationY: portal ? 0 : Math.PI * 0.5,
            preserveModelHeight: false, visibilityRangeTiles: Number.isFinite(visionTiles) && visionTiles > 0 ? visionTiles : 5
        });
    } else {
        let farm = key === 'farm' || key === 'astar_farm';
        Object.assign(object, {
            modelKey: `item_${key}`, scaleX: 0.84, scaleZ: 0.84,
            scaleY: key === 'house' ? 0.82 : farm ? 0.72 : 0.14, preserveModelHeight: key === 'house' || farm
        });
    }
    push3DRenderObject(objects, object);
    return true;
}

// Front status display of 3D units (surface 15 of the unit models): a 96px
// pixel-art icon drawn over the owner color, so one texture per state is
// shared by every player. States: 'walk', 'angry', 'work', 'sleep', or a
// queue count (number). Colored features with a dark outline read on any
// owner color.
const RENDERER3D_STATUS_CELL = 8; // 12x12 grid of chunky pixels
// Pixel letters: W white, R red, G green, B pale blue, Y yellow.
const RENDERER3D_STATUS_COLORS = { W: '#ffffff', R: '#ff3b30', G: '#4ee04a', B: '#9cc8ff', Y: '#ffd93a' };
const RENDERER3D_STATUS_FACES = {
    walk: [
        '............',
        '............',
        '............',
        '...WW..WW...',
        '...WW..WW...',
        '............',
        '............',
        '....WWWW....'],
    angry: [
        '............',
        '..R......R..',
        '...RR..RR...',
        '............',
        '...RR..RR...',
        '............',
        '............',
        '....RRRR....',
        '...R....R...'],
    work: [
        '............',
        '............',
        '............',
        '..GGG..GGG..',
        '..G.G..G.G..',
        '............',
        '...G....G...',
        '....GGGG....'],
    sleep: [
        '.......YYYY.',
        '.........Y..',
        '........Y...',
        '.......YYYY.',
        '............',
        '............',
        '..BBB..BBB..',
        '............',
        '............',
        '.....BB.....']
};
// Queue counts: empty white, short green, busy orange, long red.
function get3DQueueCountColor(count) {
    return count <= 0 ? '#ffffff' : count <= 3 ? '#4ee04a' : count <= 8 ? '#ff9a1f' : '#ff3b30';
}
function get3DStatusTexture(state) {
    return get3DTopTextureCanvas(`status:${state}`, g => {
        let size = g.canvas.width, c = RENDERER3D_STATUS_CELL, pad = 3;
        if (typeof state === 'number') {
            let text = state > 99 ? '99+' : String(state);
            g.font = `900 ${Math.round(size * (text.length > 2 ? 0.46 : text.length > 1 ? 0.62 : 0.74))}px Arial, sans-serif`;
            g.textAlign = 'center';
            g.textBaseline = 'middle';
            g.lineJoin = 'round';
            g.lineWidth = Math.max(4, Math.round(size * 0.12));
            g.strokeStyle = '#10131a';
            g.strokeText(text, size * 0.5, size * 0.55);
            g.fillStyle = get3DQueueCountColor(state);
            g.fillText(text, size * 0.5, size * 0.55);
            return;
        }
        let rows = RENDERER3D_STATUS_FACES[state] || RENDERER3D_STATUS_FACES.walk;
        let cells = [];
        rows.forEach((row, y) => { for (let x = 0; x < row.length; x++) if (RENDERER3D_STATUS_COLORS[row[x]]) cells.push([x, y, RENDERER3D_STATUS_COLORS[row[x]]]); });
        g.fillStyle = '#10131a';
        for (let [x, y] of cells) g.fillRect(x * c - pad, y * c + c - pad, c + pad * 2, c + pad * 2);
        for (let [x, y, color] of cells) {
            g.fillStyle = color;
            g.fillRect(x * c, y * c + c, c, c);
        }
    });
}
// Fighting (or closing in) is angry, work is content, a settled idle pose
// sleeps; anything else (walking, a short stop) looks ahead. Target fields
// can outlive a fight (a dead target under a new order, a structure's
// attackTarget), so anger needs a live attack order or a recent blow.
const RENDERER3D_ANGRY_LINGER_SECONDS = 1.5;
const renderer3dLastAttackTick = new WeakMap();
function getUnit3DStatusState(u, activity) {
    if (u._frameView) return SIM_UNIT_STATUS_NAMES[u._col('status')] || 'walk';
    if (u.attackFlash > 0) renderer3dLastAttackTick.set(u, gameTime);
    let lastAttack = renderer3dLastAttackTick.get(u);
    let recentlyAttacked = lastAttack !== undefined && gameTime - lastAttack < RENDERER3D_ANGRY_LINGER_SECONDS * TICK_RATE;
    let target = u.targetUnit || u.targetBuilding;
    let engaged = u.commandState === CMD_ATTACKING && target && !target.dead && !(target.energy <= 0);
    if (recentlyAttacked || engaged) return 'angry';
    if (activity.mode >= 2 && activity.mode <= 6) return 'work';
    if (activity.mode === 7) return 'sleep';
    return 'walk';
}

// The unit a barrack or worker building produces, a small still miniature
// among the yard's back features (3D only): the unit at the front of the
// queue, else the building's own unit type. Its front display shows the
// queued count (also 0). Cached per building; call right after the
// building's object was pushed.
const renderer3dProductionGhosts = new WeakMap();
// Placement per yard style: Defence3Renderer3D.workshopMiniature.
const RENDERER3D_WORKSHOP_MINIATURE_FALLBACK = { x: 0, y: .112, z: -.30, yaw: 0 };
function _get3DWorkshopMiniature(modelKey) {
    let R = typeof window !== 'undefined' ? window.Defence3Renderer3D : null;
    return (R && R.workshopMiniature && R.workshopMiniature(modelKey)) || RENDERER3D_WORKSHOP_MINIATURE_FALLBACK;
}
function _pushProductionGhost(objects, entity, flat2d) {
    if (flat2d || !entity || entity.underConstruction || !(entity.energy > 0) || entity._historyGhost) return;
    let building = objects[objects.length - 1];
    if (!building) return;
    let queue = Array.isArray(entity.spawnQueue) ? entity.spawnQueue : null;
    let entry = queue && queue.length ? queue[0] : null;
    let type = (entry && typeof entry === 'object' && entry.unitType) || getSpawnerFallbackUnitType(entity);
    let stats = BASE_UNIT_STATS[type];
    if (!stats) return;
    let cache = renderer3dProductionGhosts.get(entity);
    if (!cache || cache.type !== type || cache.owner !== entity.owner) {
        let footprint = Math.max(0.28, Math.min(0.9, ((stats.r || 8) * 2.2) / TILE));
        let mount = type === 'fast' ? 1.35 : type === 'scout' ? 1.2 : type === 'flying' ? 1.3 : 1;
        // A miniature: about a sixth of a tile wide (mounts a little wider).
        let width = mount > 1 ? 0.2 : 0.16;
        let temp = [];
        push3DRenderObject(temp, {
            modelKey: `unit_${type}`,
            x: building.x, y: building.y, z: building.z,
            scaleX: width, scaleZ: width,
            scaleY: MOUNTED_UNIT_TYPES.has(type) ? width * MOUNT_HEIGHT_RATIO : width * Math.max(0.48, footprint * 1.45) / footprint,
            weaponType: getUnit3DWeaponType({ unitType: type }),
            preserveModelHeight: true,
            isFlying: !!stats.isFlying,
            isWorker: !!stats.isWorker,
            renderShape: 'cylinder',
            tint: get3DRenderOwnerColor(entity.owner),
            sideTint: UNIT_3D_BODY_COLORS[type] || stats.color || get3DRenderOwnerColor(entity.owner),
            topTextureKey: `unit:${type}:${entity.owner}:`,
            topTextureCanvas: get3DUnitTopTexture(type, entity.owner)
        });
        cache = { type, owner: entity.owner, object: temp[0], stand: _get3DWorkshopMiniature(building.modelKey), litVersion: -1, litGrid: null };
        renderer3dProductionGhosts.set(entity, cache);
    }
    let o = cache.object, stand = cache.stand;
    o.x = building.x + stand.x * building.scaleX;
    o.z = building.z + stand.z * building.scaleZ;
    o.y = building.y + building.scaleY * stand.y;
    o.rotationY = stand.yaw;
    o.statusTextureCanvas = get3DStatusTexture(queue ? queue.length : 0);
    if (cache.litVersion !== visibilityVersion || cache.litGrid !== visibilityGrid) {
        _relight3DObject(o, null, o.baseTint, o.baseSideTint, false);
        cache.litVersion = visibilityVersion;
        cache.litGrid = visibilityGrid;
    }
    _touch3DPanel(o.topTextureCanvas);
    objects.push(o);
}

// Structures barely change, but the scene is rebuilt every frame. Reuse a
// structure's render object (relit every frame) while nothing it depends on
// changed: view mode, audio pulse, facing, whether a unit stands on its
// tile, and it is not flashing, waiting for its exact panel or easing its
// height (the last two builds differed). Panels refresh every 1-4 ticks.
// The entry lives on the entity (entity._r3dStatic): a property read per
// structure per frame instead of a WeakMap lookup.
const renderer3dStaticFrame = { occupied: null, flat2d: false, overlapNowMs: 0, overlapFadeKeys: null };

// Tiles holding a visible unit this frame (tile index keys), stamped per
// frame instead of filling a new Set with every visible unit.
const renderer3dOccupiedTiles = {
    stamps: new Uint32Array(0),
    stamp: 0,
    begin(size) {
        if (this.stamps.length !== size) { this.stamps = new Uint32Array(size); this.stamp = 0; }
        if (++this.stamp >= 0xffffffff) { this.stamps.fill(0); this.stamp = 1; }
    },
    add(key) { if (key >= 0 && key < this.stamps.length) this.stamps[key] = this.stamp; },
    has(key) { return this.stamps[key] === this.stamp; }
};

// A unit's cached 3D object lives on the unit itself (u._r3d: a property
// read instead of a WeakMap lookup per unit per frame; not simulation state).

// Full unit object rebuilds per unit, in ticks (see build3DFrameData): at
// least every 3 ticks, and with big armies so that about 1000 units rebuild
// per tick (panel contents such as health bars then lag a little more;
// facing, activity and status icons still update every tick).
const UNIT_3D_REBUILD_TICKS_MIN = 3;
let UNIT_3D_REBUILD_TICKS = UNIT_3D_REBUILD_TICKS_MIN;

// UNIT LAYER (3D)
// Between ticks a unit's 3D object changes only by interpolation: its
// position (a straight line from the previous tick's), its walk cycle
// (linear in time) and a flyer's bob (a sine of time). On a tick (or when
// the view needs it) the frame builder puts every unit whose object is
// stable into the layer: the renderer uploads it once, and on the frames
// until the next tick draws it again with the interpolation done on the GPU
// (see renderer3d.js, drawUnitLayer), so those frames skip the per-unit work.
// Units whose look changes within a tick (damage flash, a panel not ready
// yet, transparency) stay on the per-frame path. ?unitlayer=0 disables it.
const RENDERER3D_UNIT_LAYER_ENABLED = (() => {
    try { return new URLSearchParams(location.search).get('unitlayer') !== '0'; } catch { return true; }
})();
let renderer3dUnitLayer = null;
let renderer3dUnitLayerVersion = 0;
// Frames that reused the layer / built it, and why a build was needed.
const renderer3dUnitLayerStats = { reuse: 0, build: 0, why: {} };
// Period of the flyer bob's time argument (2.2 rad per second of game time).
const UNIT_LAYER_FLY_PERIOD = Math.PI * 2 / 2.2 * 1000;

// _unit3DWalkPhase as base + rate * tickAlpha (exact where it is linear).
function _unit3DWalkPhaseLinear(u, activity, out) {
    if (activity.mode === 1) {
        let b = (8 - Number(u.attackFlash || 0)) / 8;
        if (b >= 1) { out[0] = Math.PI; out[1] = 0; }
        else if (b <= -1 / 8) { out[0] = 0; out[1] = 0; }
        else { out[0] = Math.max(0, b) * Math.PI; out[1] = Math.PI / 8; }
        return out;
    }
    let speed = activity.mode === 2 ? 8 : activity.mode === 4 ? 14 : activity.mode === 7 ? 2 : 10;
    out[0] = gameTime / TICK_RATE * speed + (Number(u.id) || 0) * 2.399;
    out[1] = speed / TICK_RATE;
    return out;
}
const _unitLayerPhase = [0, 0];

// A cached unit object set up for the layer from the worker's record: the
// tick's position and the offset back, facing, activity, walk phase, status
// icon and light (as layerCollect and _refreshUnit3DObject would).
function _layerWriteFromVis(u, cached, F, sl, statusCanvases, offX, offZ) {
    let o = cached.object;
    _pin3DPanelToLayer(o.topTextureCanvas, renderer3dUnitLayerVersion);
    let cx = u.x / TILE + offX, cz = u.y / TILE + offZ;
    o.x = o._cx = cx; o.z = o._cz = cz;
    o._pdx = (u.prevX - u.x) / TILE; o._pdz = (u.prevY - u.y) / TILE;
    o.rotationY = F.facing[sl];
    o.statusTextureCanvas = statusCanvases[F.status[sl] | 0] || null;
    if (u.isSnake) {
        o._phaseRate = 0; o._flyOn = 0; o._flySeed = 0;
    } else {
        let mode = F.mode[sl];
        o.animationMode = mode;
        o.moveAmount = F.amount[sl];
        o.walkPhase = F.phase[sl]; o._phaseRate = F.prate[sl];
        o.y = cached.baseY + (u.isFlying ? (u.isWorker ? .36 : .30) : 0);
        o._flyOn = u.isFlying ? 1 : 0;
        o._flySeed = ((Number(u.id) || 0) * 1.7) % (Math.PI * 2);
    }
    // Light where it is at the tick (as _relight3DObject; no shadow
    // direction: the layer is not used with drop shadows).
    let level = 1;
    if (!fullVisibility) {
        let gx = Math.floor(cx), gy = Math.floor(cz);
        let row = visibilityGrid[gy];
        let raw = Math.max((row && row[gx]) || 0, F.light[sl]);
        level = Math.max(0, Math.min(1, raw / VISIBILITY_LIGHT_NORMALIZATION_RANGE));
    }
    if (o.lightLevel !== level || o._litFor !== cached.tint) {
        o.tint = _getCachedLitTint(cached.tint || '#c8ced8', level);
        o.sideTint = _getCachedLitTint(cached.sideTint || cached.tint || '#c8ced8', level);
        o.lightLevel = level;
        o._litFor = cached.tint;
    }
    o.historyGhost = false;
    // Drop shadows (Simple shadows) lean away from the light at its tile.
    if (_simpleShadows && !fullVisibility) {
        let dir = _shadowDirAt(cx, cz, _shadowDirScratch);
        o.shadowDirX = dir.x; o.shadowDirZ = dir.z;
        o.shadowLength = Math.max(0.6, Math.min(2.4, 1 + (1 - level) * 0.9));
    }
}
let _simpleShadows = false;

// UNIT RENDER SLOTS (3D, with the simulation worker)
// Each living unit has a render slot (the worker's record says which). A
// slot keeps what the unit layer needs that changes only with the unit's
// panel or the view: model, scales, height, base colours, panel. A layer
// build then reads the worker's records and these typed arrays in one
// loop, without touching the unit objects; a unit goes through the
// per-object path (which refills its slot) only when its slot is not valid.
const _uSlot = { cap: 0 };
function _uSlotGrow(slot) {
    if (slot < _uSlot.cap) return;
    let cap = Math.max(1024, _uSlot.cap * 2, slot + 1);
    let grow = (Type, old, per = 1) => { let a = new Type(cap * per); if (old) a.set(old); return a; };
    _uSlot.valid = grow(Uint8Array, _uSlot.valid);
    _uSlot.id = grow(Float64Array, _uSlot.id);
    _uSlot.sig = grow(Float32Array, _uSlot.sig);
    _uSlot.view = grow(Int32Array, _uSlot.view);
    _uSlot.label = grow(Uint8Array, _uSlot.label);
    _uSlot.labelShown = grow(Uint8Array, _uSlot.labelShown);
    _uSlot.texVer = grow(Float64Array, _uSlot.texVer);
    _uSlot.lod = grow(Uint8Array, _uSlot.lod);
    _uSlot.flags = grow(Uint8Array, _uSlot.flags);
    _uSlot.dim = grow(Float32Array, _uSlot.dim, 4);    // sx, sy, sz, y
    // The last record written for the slot and the inputs it came from
    // (U_SLOT_KEY_N values): an unchanged unit (idle) reuses it.
    _uSlot.rec = grow(Float32Array, _uSlot.rec, 28);
    _uSlot.inKey = grow(Float64Array, _uSlot.inKey, U_SLOT_KEY_N);
    _uSlot.rgb = grow(Uint8Array, _uSlot.rgb, 6);      // tint r g b, side r g b (0-255)
    _uSlot.kind = _uSlot.kind || []; _uSlot.kindLod = _uSlot.kindLod || []; _uSlot.kindLod2 = _uSlot.kindLod2 || []; _uSlot.panel = _uSlot.panel || [];
    _uSlot.cap = cap;
}
const U_SLOT_FLYING = 1, U_SLOT_WORKER = 2, U_SLOT_SNAKE = 4, U_SLOT_MOTION = 8;
const U_SLOT_KEY_N = 12;
// Camera state for levels of detail: bumped when the LOD camera changes.
let _uLodCamStamp = 0, _uLodCamKey = '';

// After the per-object path put a unit's object in the layer: its slot.
function _uSlotFill(slot, u, o, cached, sig, view) {
    if (!(slot >= 0)) return;
    _uSlotGrow(slot);
    let kind = renderer3dInstance && renderer3dInstance.getFigureMeshKey(o) ? o._r3dKind : null;
    let tint = _parseHexColor(cached.tint || '#c8ced8'), side = _parseHexColor(cached.sideTint || cached.tint || '#c8ced8');
    if (!kind || !tint || !side || !o.topTextureCanvas) { _uSlot.valid[slot] = 0; return; }
    let S = _uSlot;
    S.valid[slot] = 1; S.id[slot] = u.id; S.sig[slot] = sig; S.view[slot] = view;
    S.label[slot] = u.isSnake ? 2 : (cached.label ? 1 : 0);
    S.labelShown[slot] = cached.label ? 1 : 0;
    S.texVer[slot] = o.topTextureCanvas._textureVersion || 0;
    S.lod[slot] = o._r3dLod | 0;
    S.flags[slot] = (u.isFlying ? U_SLOT_FLYING : 0) | (u.isWorker ? U_SLOT_WORKER : 0) | (u.isSnake ? U_SLOT_SNAKE : 0)
        | ((u.isSnake || u.unitType === 'tank' || u.unitType === 'boss' || u.unitType === 'king') ? U_SLOT_MOTION : 0);
    let d = slot * 4;
    S.dim[d] = o.scaleX; S.dim[d + 1] = o.scaleY; S.dim[d + 2] = o.scaleZ;
    S.dim[d + 3] = u.isSnake ? o.y : cached.baseY + (u.isFlying ? (u.isWorker ? .36 : .30) : 0);
    let c = slot * 6;
    S.rgb[c] = tint.r; S.rgb[c + 1] = tint.g; S.rgb[c + 2] = tint.b; S.rgb[c + 3] = side.r; S.rgb[c + 4] = side.g; S.rgb[c + 5] = side.b;
    S.inKey[slot * U_SLOT_KEY_N] = NaN;   // the cached record is stale
    S.kind[slot] = kind;
    S.kindLod[slot] = kind + ':lod';
    S.kindLod2[slot] = kind + ':lod2';
    S.panel[slot] = o.topTextureCanvas;
}

// A lit colour channel as _getCachedLitTint and the renderer produce it.
function _litChannel(c255, bucket) {
    if (bucket >= 24) return c255 / 255;
    let mul = 0.28 + (bucket / 24) * 0.72;
    return Math.max(0, Math.min(255, Math.round(c255 * mul))) / 255;
}
// _litChannel for each light bucket (0-24) and channel value (0-255).
const _LIT_LUT = (() => {
    let t = new Float32Array(25 * 256);
    for (let b = 0; b < 25; b++) for (let c = 0; c < 256; c++) t[b * 256 + c] = _litChannel(c, b);
    return t;
})();
const _uRec = new Float32Array(28);
// Debug: why units leave the unit layer's fast path (window.__unitSlowWhy).
let _dbgStats = null;
let _uSlotVisIndex = -1;

// Whether a unit's object can be drawn from the layer until the next tick.
function _unitLayerEligible(u, cached, o) {
    return !!(cached && cached.object === o && !cached.dynamic && !getDamageFlashState(u) && o.alpha >= 0.999
        && o.topTextureCanvas && !u._historyGhost);
}

// Per-tick part of a unit's 3D object, between full rebuilds: activity,
// facing and movement, and the status icon (as the rebuild computes them).
function _refreshUnit3DObject(u, o, cached) {
    cached.refreshTick = gameTime;
    let activity = getUnit3DActivity(u);
    if (activity.mode !== 0 || activity.amount > 0) cached.stillSince = gameTime;
    activity = _unit3DIdleActivity(u, activity, cached.stillSince);
    cached.activity = activity;
    let facingX = Number(u.vx) || 0, facingY = Number(u.vy) || 0;
    if (activity.target && Number.isFinite(activity.target.x) && Number.isFinite(activity.target.y)) {
        facingX = activity.target.x - u.x; facingY = activity.target.y - u.y;
    }
    o.rotationY = Math.atan2(facingX, facingY || 0.0001) || 0;
    o.moveAmount = Math.max(0, Math.min(1, activity.amount || Math.min(1, Math.hypot(u.x - u.prevX, u.y - u.prevY) / Math.max(.01, TILE * .025)) || 0));
    o.animationMode = Math.max(0, Math.min(7, Math.floor(Number(activity.mode) || 0)));
    o.statusTextureCanvas = u._historyGhost ? null : (get3DStatusTexture(getUnit3DStatusState(u, activity)) || null);
}

function _unit3DWalkPhase(u, activity) {
    return activity.mode === 1
        ? Math.max(0, Math.min(1, (8 - Number(u.attackFlash || 0) + (u._historyGhost ? 0 : tickAlpha)) / 8)) * Math.PI
        : ((u._historyGhost ? u._historyTick : gameTime + tickAlpha)) / TICK_RATE * (activity.mode === 2 ? 8 : activity.mode === 4 ? 14 : activity.mode === 7 ? 2 : 10) + (Number(u.id) || 0) * 2.399;
}

// Lighting of an object at its current position, exactly as
// push3DRenderObject derives it (for objects without light overrides).
// `sourceLight`, when given, is the unit's own light this tick.
function _relight3DObject(o, source, baseTint, baseSideTint, flat2d, sourceLight) {
    let ox = o.x, oz = o.z, gx = Math.floor(ox), gy = Math.floor(oz);
    let remembered = !!(source && source._historyGhost);
    let lightGrid = remembered ? getRenderVisibilityGrid() : visibilityGrid;
    let lightRawCenter = fullVisibility ? VISIBILITY_LIGHT_NORMALIZATION_RANGE : ((lightGrid[gy] && lightGrid[gy][gx]) || 0);
    if (!fullVisibility && source && source.unitType) {
        lightRawCenter = Math.max(lightRawCenter, sourceLight === undefined ? getVisualUnitSourceLight(source) : sourceLight);
    }
    let lightLevel = fullVisibility ? 1 : Math.max(0, Math.min(1, lightRawCenter / VISIBILITY_LIGHT_NORMALIZATION_RANGE));
    let shadowDirX = DEFAULT_SHADOW_DIR_X, shadowDirZ = DEFAULT_SHADOW_DIR_Y;
    if (!fullVisibility && !flat2d) {
        const dir = _shadowDirAt(ox, oz, _shadowDirScratch);
        shadowDirX = dir.x; shadowDirZ = dir.z;
    }
    let finalLightLevel = Math.max(0, Math.min(1, lightLevel));
    o.tint = _getCachedLitTint(baseTint || '#c8ced8', finalLightLevel);
    o.sideTint = _getCachedLitTint(baseSideTint || baseTint || '#c8ced8', finalLightLevel);
    o.lightLevel = finalLightLevel;
    o.historyGhost = remembered;
    o.shadowDirX = shadowDirX;
    o.shadowDirZ = shadowDirZ;
    o.shadowLength = Math.max(0.6, Math.min(2.4, 1 + (1 - lightLevel) * 0.9));
}

// Whether a structure's panel shows its level (per thing in 3D: distance).
function _static3DLabelShown(entity) {
    return renderer3dStaticFrame.flat2d ? false : !!(entity && entity.textCanvas && shouldShowBuildingLevels(entity));
}

function _reuseStatic3DObject(target, entity, gx, gy, audioMove, audioHeight) {
    let entry = entity._r3dStatic;
    let age = entry ? gameTime - entry.tick : -1;
    if (!entry || entry.dynamic || age < 0 || age >= entry.maxAge
        || entry.view !== renderer3dStaticFrame.view || entry.audioMove !== audioMove || entry.audioHeight !== audioHeight
        || entry.label !== _static3DLabelShown(entity)
        || entry.angle !== entity.angle
        || entry.occupied !== renderer3dStaticFrame.occupied.has(gy * GRID_W + gx)
        || getDamageFlashState(entity)) return false;
    // Its panel's inputs (health, progress, aim...), checked once per tick:
    // unchanged, the structure is kept however long.
    if (entry.sigTick !== gameTime) {
        if (get3DExact2DVisualSignature(entity, false) !== entry.sig) return false;
        entry.sigTick = gameTime;
    }
    // Structures do not move: their light changes only with the grid.
    let object = entry.object;
    let panel = object.topTextureCanvas;
    if (panel && panel._textureVersion !== entry.textureVersion) return false; // recycled
    _touch3DPanel(panel);
    // A reused (lowered) structure keeps its height state alive; otherwise the
    // state is pruned and the structure pops back to full height at once.
    if (object.overlapFadeKey !== undefined) {
        let fadeState = renderer3dOverlapFadeState.get(object.overlapFadeKey);
        if (!fadeState) return false;
        fadeState.lastSeenMs = fadeState.lastUpdateMs = renderer3dStaticFrame.overlapNowMs;
        renderer3dStaticFrame.overlapFadeKeys.add(object.overlapFadeKey);
    }
    if (entry.litVersion !== visibilityVersion || entry.litGrid !== visibilityGrid) {
        _relight3DObject(object, entity, object.baseTint, object.baseSideTint, renderer3dStaticFrame.flat2d);
        entry.litVersion = visibilityVersion;
        entry.litGrid = visibilityGrid;
    }
    target.push(object);
    _staticReuseHit = true;
    return true;
}

function _rememberStatic3DObject(target, entity, gx, gy, audioMove, audioHeight, fallbackTexture) {
    let object = target[target.length - 1];
    let entry = entity._r3dStatic;
    let easing = !!(entry && entry.object.scaleY !== object.scaleY);
    entity._r3dStatic = ({ object, tick: gameTime, audioMove, audioHeight, angle: entity.angle,
        textureVersion: object.topTextureCanvas ? object.topTextureCanvas._textureVersion : undefined,
        litVersion: visibilityVersion, litGrid: visibilityGrid,
        // Kept while its panel signature holds (see _reuseStatic3DObject);
        // rebuilt now and then anyway (spread by tile).
        maxAge: 200 + ((gx * 7 + gy * 13) & 31),
        sig: get3DExact2DVisualSignature(entity, false), sigTick: gameTime,
        view: renderer3dStaticFrame.view,
        label: _static3DLabelShown(entity),
        occupied: renderer3dStaticFrame.occupied.has(gy * GRID_W + gx),
        dynamic: fallbackTexture || easing || !!getDamageFlashState(entity) });
}

// ---- Flat (2D view) sprites -------------------------------------------
// The 2D view needs only a position, footprint, light and panel per sprite.
// Units, projectiles and particles write those straight into the renderer's
// typed instance batch instead of building scene objects; structures reuse
// their cached scene objects (pushObject).
let renderer3dFlatBatch = null;
let renderer3dFxBatch = null;
let renderer3dFlatGeneration = 0;
// Per unit: the panel and own light source of the current tick.
const renderer3dFlatUnits = new WeakMap();

function _getRenderer3DFlatBatch() {
    if (!renderer3dFlatBatch) renderer3dFlatBatch = new window.Defence3Renderer3D.FlatSpriteBatch();
    renderer3dFlatBatch.reset();
    return renderer3dFlatBatch;
}

// push3DRenderObject's light level for a sprite at (x, z) in tiles.
function _flatLightAt(x, z, sourceLight, remembered) {
    if (fullVisibility) return 1;
    let gx = Math.floor(x), gy = Math.floor(z);
    let lightGrid = remembered ? getRenderVisibilityGrid() : visibilityGrid;
    let row = lightGrid[gy];
    let raw = (row && row[gx]) || 0;
    if (sourceLight > raw) raw = sourceLight;
    return Math.max(0, Math.min(1, raw / VISIBILITY_LIGHT_NORMALIZATION_RANGE));
}

// Returns false when the unit has no exact panel (the caller then builds a
// scene object). Like the 3D cache, tick data may be one tick old for half
// of the units, which halves panel lookups on tick frames.
function _pushFlatUnit(batch, u, x, z, view) {
    let state = renderer3dFlatUnits.get(u);
    let age = state ? gameTime - state.tick : -1;
    if (!state || state.view !== view || state.generation !== renderer3dFlatGeneration || state.fallback
        || state.panel._textureVersion !== state.version
        || !(age === 0 || (age === 1 && ((u.id + gameTime) & 1) === 1))) {
        let panel = get3DExact2DTexture(u, true);
        if (!panel || !panel._flatWorldSize) return false;
        if (!state) renderer3dFlatUnits.set(u, state = {});
        state.tick = gameTime;
        state.view = view;
        state.generation = renderer3dFlatGeneration;
        state.panel = panel;
        state.version = panel._textureVersion;
        state.fallback = renderer3dExactTextureFallback;
        state.sourceLight = fullVisibility ? 0 : getVisualUnitSourceLight(u);
    }
    let panel = state.panel, size = panel._flatWorldSize;
    _touch3DPanel(panel);
    let remembered = !!u._historyGhost;
    let light = _flatLightAt(x, z, state.sourceLight, remembered);
    if (remembered) light *= 0.65;
    batch.push(x, z + (panel._flatOffsetZ || 0), size, size, light, light, light, 1, 0, panel);
    return true;
}

// Debug: when window.__r3dPhases is an object, build3DFrameData adds the
// time of each of its phases to it (ms), per kind of frame.
function _r3dPhase(name, t0) {
    let P = typeof window !== 'undefined' ? window.__r3dPhases : null;
    if (!P) return 0;
    let now = performance.now();
    if (t0) P[name] = (P[name] || 0) + (now - t0);
    return now;
}

// Army-scale presentation owns only packed visual records, never simulation
// state. Two buffers retain structures and units across frames; only changed
// pages upload on a tick. Shader interpolation also handles stopping/teleports.
let rendererScaleCache = null;
let rendererScaleActive = false;
let rendererChunkCache = null;
function getChunkRenderView(view, bounds) {
    if (!rendererChunkCache || rendererChunkCache.grid !== view.grid) rendererChunkCache = { grid: view.grid, lists: new Map() };
    const result = { ...view }, columns = Math.ceil(GRID_W / 16);
    // Match the detailed layers' overscan, plus one whole chunk for bodies
    // and interpolation. Query results preserve the original painter order.
    const padX = Math.max(4, Math.ceil((bounds.maxGx - bounds.minGx) * .3)) + 16;
    const padY = Math.max(4, Math.ceil((bounds.maxGy - bounds.minGy) * .3)) + 16;
    const x0 = Math.max(0, Math.floor((bounds.minGx - padX) / 16));
    const y0 = Math.max(0, Math.floor((bounds.minGy - padY) / 16));
    const x1 = Math.min(columns - 1, Math.floor((bounds.maxGx + padX) / 16));
    const y1 = Math.min(Math.ceil(GRID_H / 16) - 1, Math.floor((bounds.maxGy + padY) / 16));
    for (const name of ['units', 'towers', 'barracks', 'collectorSpawners', 'goldMines', 'astarMines', 'droppedItems']) {
        const list = view[name];
        if (list.length < 5000) continue;
        let index = rendererChunkCache.lists.get(name);
        if (!index || index.list !== list || index.tick !== gameTime || index.length !== list.length) {
            index = { list, tick: gameTime, length: list.length, buckets: new Map(), overflow: [] };
            rendererChunkCache.lists.set(name, index);
            for (let i = 0; i < list.length; i++) {
                const e = list[i], moving = name === 'units';
                const x = moving ? e.x / TILE : e.gx, y = moving ? e.y / TILE : e.gy;
                const px = moving && Number.isFinite(e.prevX) ? e.prevX / TILE : x;
                const py = moving && Number.isFinite(e.prevY) ? e.prevY / TILE : y;
                const left = Math.max(0, Math.floor(Math.min(x, px) / 16)), right = Math.min(columns - 1, Math.floor(Math.max(x, px) / 16));
                const top = Math.max(0, Math.floor(Math.min(y, py) / 16)), bottom = Math.min(Math.ceil(GRID_H / 16) - 1, Math.floor(Math.max(y, py) / 16));
                if ((right - left + 1) * (bottom - top + 1) > 16) { index.overflow.push(i); continue; }
                for (let by = top; by <= bottom; by++) for (let bx = left; bx <= right; bx++) {
                    const key = by * columns + bx;
                    let bucket = index.buckets.get(key);
                    if (!bucket) index.buckets.set(key, bucket = []);
                    bucket.push(i);
                }
            }
        }
        const key = x0 + '|' + y0 + '|' + x1 + '|' + y1;
        if (index.queryKey !== key) {
            const ids = index.overflow.slice();
            for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
                const bucket = index.buckets.get(y * columns + x);
                if (bucket) for (const i of bucket) ids.push(i);
            }
            ids.sort((a, b) => a - b);
            index.query = []; let previous = -1;
            for (const i of ids) if (i !== previous) { index.query.push(list[i]); previous = i; }
            index.queryKey = key;
        }
        result[name] = index.query;
    }
    return result;
}
function useScaleRendering(flat2d, view) {
    if (!renderer3dInstance || typeof renderer3dInstance.buildViewProjection !== 'function' || window.__disableScaleRendering) return false;
    const snapshot = get3DProjectionSnapshot(); snapshot.flat2d = flat2d;
    renderer3dInstance.buildViewProjection(snapshot);
    const pixels = flat2d ? camera.zoom * TILE : renderer3dInstance.lodPixelsPerWorld;
    // In a large match, performance takes priority even at closer zooms.
    // A population gate also catches dense armies with >12px nominal models.
    const population = view ? view.units.length + view.towers.length + view.barracks.length + view.collectorSpawners.length : 0;
    rendererScaleActive = population >= 5000 || pixels < (rendererScaleActive ? 16 : 12);
    return rendererScaleActive;
}

function buildScaleFrameData(flat2d, view) {
    let cache = rendererScaleCache;
    if (!cache || cache.grid !== view.grid || cache.renderer !== renderer3dInstance) {
        if (cache) for (const layer of cache.layers) layer.dispose(cache.renderer.gl);
        const P = window.Defence3Renderer3D.PersistentInstances;
        cache = rendererScaleCache = { grid: view.grid, renderer: renderer3dInstance,
            layers: [new P(12), new P(12)], tick: NaN, colors: new Map() };
    }
    const refs = [view.towers, view.barracks, view.collectorSpawners, view.goldMines, view.astarMines, view.droppedItems, view.units];
    const frame = view.units === units && typeof simClientCurrentUnitVis === 'function' ? simClientCurrentUnitVis() : null;
    const structuresFrame = frame && typeof _pageTables !== 'undefined' && _isLiveRenderGrid(view.grid) ? _pageTables.s : null;
    const columns = frame && structuresFrame ? { units: frame, structures: structuresFrame,
        unitSources: units, structureSources: _pageStructViews, alpha: tickAlpha,
        visibility: view.visibilityGrid, visibilityVersion, fullVisibility, tile: TILE, lightNorm: VISIBILITY_LIGHT_NORMALIZATION_RANGE,
        colors: Array.from({length:9}, (_, i) => get3DRenderOwnerColor(i - 1)) } : null;
    const changed = cache.tick !== gameTime || cache.vis !== visibilityVersion || cache.full !== fullVisibility
        || cache.player !== localPlayerId || cache.history !== teamVisibilityHistory
        || !cache.refs || refs.some((list, i) => list !== cache.refs[i] || list.length !== cache.lengths[i]);
    if (changed && !columns) {
        cache.colors.clear();
        const colorFor = owner => {
            let c = cache.colors.get(owner);
            if (!c) { c = _parseHexColor(get3DRenderOwnerColor(owner)) || { r: 200, g: 206, b: 216 }; cache.colors.set(owner, c); }
            return c;
        };
        const push = (layer, e, kind, gx, gy, owner = e.owner) => {
            if (!e || e.dead || e.energy <= 0 || e.teleportHideTicks > 0) return;
            const x = kind === 0 ? e.x / TILE : gx + .5, z = kind === 0 ? e.y / TILE : gy + .5;
            gx = Math.floor(x); gy = Math.floor(z);
            const light = view.visibilityGrid[gy] && view.visibilityGrid[gy][gx];
            if (!fullVisibility && !e._historyGhost && !(light > 0)) return;
            layer.reserve(layer.count + 1);
            const d = layer.data, o = layer.count++ * 12, c = colorFor(owner);
            d[o] = x; d[o + 1] = z;
            d[o + 2] = kind === 0 && !e._historyGhost && Number.isFinite(e.prevX) ? e.prevX / TILE : x;
            d[o + 3] = kind === 0 && !e._historyGhost && Number.isFinite(e.prevY) ? e.prevY / TILE : z;
            d[o + 4] = kind === 0 ? Math.max(.28, Math.min(.9, (e.r || 8) * 2.2 / TILE)) : .94;
            d[o + 5] = kind === 0 ? (e.isFlying ? .9 : .5) : kind === 1 ? .85 : .2;
            d[o + 6] = kind === 0 ? Math.atan2(e.vx || 0, e.vy || 1) : 0;
            d[o + 7] = kind;
            const brightness = fullVisibility ? 1 : .35 + .65 * Math.min(1, (light || 0) / VISIBILITY_LIGHT_NORMALIZATION_RANGE);
            d[o + 8] = c.r / 255 * brightness; d[o + 9] = c.g / 255 * brightness; d[o + 10] = c.b / 255 * brightness;
            d[o + 11] = e._historyGhost ? .3 : e.underConstruction ? .6 : 1;
            layer.sources.push(e);
        };
        for (const layer of cache.layers) { layer.count = 0; layer.sources = layer.sources || []; layer.sources.length = 0; layer.sourceIndex = null; }
        const structures = cache.layers[0], moving = cache.layers[1];
        for (const list of refs.slice(0, 6)) for (const e of list) push(structures, e, 1, e.gx, e.gy);
        if (_isLiveRenderGrid(view.grid)) {
            for (const e of getCellItemsRowMajor()) {
                const cell = view.grid[e.gy] && view.grid[e.gy][e.gx];
                if (cell && cell.item === e) push(structures, e, 2, e.gx, e.gy, cell.owner);
            }
        } else if (visibilityHistoryState && visibilityHistoryState.memories) {
            for (const record of visibilityHistoryState.memories.floorItems.values()) {
                const e = record.snapshot || record.source;
                if (e) push(structures, e, 2, record.gx, record.gy, view.grid[record.gy][record.gx].owner);
            }
        }
        // Read worker columns directly: avoid millions of PageUnit getter
        // calls when the authoritative frame is already packed for rendering.
        const F = view.units === units && typeof simClientCurrentUnitVis === 'function' ? simClientCurrentUnitVis() : null;
        if (F) {
            moving.reserve(view.units.length);
            const d = moving.data;
            for (let i = 0; i < view.units.length; i++) {
                const s = F.order[i];
                if (F.energy[s] <= 0 || (F.flags[s] & 1024)) continue;
                const x = F.x[s] / TILE, z = F.y[s] / TILE;
                const row = view.visibilityGrid[Math.floor(z)], light = row && row[Math.floor(x)];
                if (!fullVisibility && !(light > 0)) continue;
                const o = moving.count++ * 12, c = colorFor(F.owner[s]);
                d[o] = x; d[o + 1] = z; d[o + 2] = F.px[s] / TILE; d[o + 3] = F.py[s] / TILE;
                d[o + 4] = Math.max(.28, Math.min(.9, F.r[s] * 2.2 / TILE));
                d[o + 5] = F.flags[s] & 1 ? .9 : .5; d[o + 6] = F.facing[s]; d[o + 7] = 0;
                const brightness = fullVisibility ? 1 : .35 + .65 * Math.min(1, (light || 0) / VISIBILITY_LIGHT_NORMALIZATION_RANGE);
                d[o + 8] = c.r / 255 * brightness; d[o + 9] = c.g / 255 * brightness; d[o + 10] = c.b / 255 * brightness; d[o + 11] = 1;
                moving.sources.push(view.units[i]);
            }
        } else for (const e of view.units) push(moving, e, 0);
        for (const layer of cache.layers) layer.version++;
        cache.tick = gameTime; cache.vis = visibilityVersion; cache.full = fullVisibility; cache.player = localPlayerId;
        cache.history = teamVisibilityHistory; cache.refs = refs; cache.lengths = refs.map(list => list.length);
    }
    for (const layer of cache.layers) layer.alpha = tickAlpha;
    if (_staticCacheCommitVersion < 0 || !_combinedBgCanvas) commitStaticCaches(true, 'background');
    if (!fullVisibility) rebuildVisibilityMaskCacheIfNeeded();
    const snapshot = get3DProjectionSnapshot();
    const bounds = flat2d ? getVisibleWorldBounds(2) : get3DVisibleWorldBounds();
    const fx = renderer3dFxBatch || (renderer3dFxBatch = new window.Defence3Renderer3D.FxBatch());
    beginFrameEffects(fx, flat2d, bounds, getTeamLightingGrid(), camera.zoom * TILE, renderer3dInstance);
    buildFrameEffects(view.projectiles, view.particles, view.towers);
    endFrameEffects();
    return Object.assign(snapshot, { flat2d, scaleLayers: columns ? [] : cache.layers, columnLayers: columns, objects: [], fx,
        backgroundCanvas: getBackgroundMip(Math.min(1, 2048 / Math.max(WORLD_W, WORLD_H))), backgroundVersion: _backgroundContentVersion,
        backgroundBounds: { centerX: GRID_W / 2, centerZ: GRID_H / 2, width: GRID_W, height: GRID_H },
        fogCanvas: fullVisibility ? null : _visibilityMaskCanvas,
        fogVersion: _visibilityMaskCanvas ? _visibilityMaskCanvas._visibilityContentVersion || 0 : 0,
        overlays: buildScaleOverlays(cache), buildPreview: getCurrentBuildPreviewData() });
}

// Aggregate selection outlines by fixed world chunks. This bounds geometry
// at full zoom-out while exact selection/commands remain untouched.
function buildScaleOverlays(cache) {
    const key = gameTime + '|' + selectedUnits.length + '|' + selectedEntities.length + '|' + JSON.stringify(activeSubGroups);
    if (cache.overlayKey === key && cache.selectedUnits === selectedUnits && cache.selectedEntities === selectedEntities) return cache.overlays;
    const overlays = { lines: [], rings: [], rects: [], areaTiles: [], markers: [], bars: [], texts: [], worldTileSize: TILE };
    const groups = new Map();
    for (const list of [getActiveUnitsForRender(), getActiveEntities()]) for (const e of list) {
        if (!e || e.dead || e.energy <= 0) continue;
        const x = Number.isFinite(e.x) ? e.x / TILE : e.gx + .5, z = Number.isFinite(e.y) ? e.y / TILE : e.gy + .5;
        const k = Math.floor(z / 16) * Math.ceil(GRID_W / 16) + Math.floor(x / 16);
        let b = groups.get(k);
        if (!b) groups.set(k, b = [x, z, x, z]);
        b[0] = Math.min(b[0], x); b[1] = Math.min(b[1], z); b[2] = Math.max(b[2], x); b[3] = Math.max(b[3], z);
    }
    for (const b of groups.values()) {
        const x = b[0] - .5, z = b[1] - .5, r = b[2] + .5, t = b[3] + .5;
        for (const p of [[x,z,r,z],[r,z,r,t],[r,t,x,t],[x,t,x,z]]) overlays.lines.push({ x1: p[0], z1: p[1], x2: p[2], z2: p[3], color: '#6f8', dashed: false });
    }
    cache.overlayKey = key; cache.selectedUnits = selectedUnits; cache.selectedEntities = selectedEntities;
    return cache.overlays = overlays;
}

function build3DFrameData(flat2d = false) {
    let _ph = _r3dPhase('', 0);
    const sourceView = getLiveRenderView();
    if (useScaleRendering(flat2d, sourceView)) return buildScaleFrameData(flat2d, sourceView);
    const queryBounds = flat2d ? getVisibleWorldBounds(2 + Math.ceil(getRenderViewPad() / Math.max(.01, camera.zoom) / TILE)) : get3DVisibleWorldBounds();
    const { grid, units, towers, barracks, collectorSpawners, goldMines, astarMines, droppedItems, projectiles, particles, visibilityGrid } = getChunkRenderView(sourceView, queryBounds);

    begin3DTextureFrame();
    renderer3dExactTextureBuildsRemaining = 12;
    renderer3dExactTextureTimeRemaining = 2;
    renderer3dExactUnitTextureBuildsRemaining = 12;
    renderer3dExactUnitTextureTimeRemaining = 2;
    // The overscan margin is drawn too (see getRenderViewPad).
    let bounds = flat2d ? getVisibleWorldBounds(2 + Math.ceil(getRenderViewPad() / Math.max(0.01, camera.zoom) / TILE)) : get3DVisibleWorldBounds();
    let alpha = tickAlpha;
    // All entity models below are procedural: their shader uses the top/status
    // panel and side tint, never the legacy animated side texture.
    let objects = [];
    objects.flat2d = flat2d;
    // 2D: scene objects (structures, units without a panel) move into the
    // sprite batch in order, between directly written sprites.
    let flatBatch = flat2d ? _getRenderer3DFlatBatch() : null;
    let flatDrained = 0;
    let drainFlatObjects = () => {
        while (flatDrained < objects.length) flatBatch.pushObject(objects[flatDrained++]);
    };
    let buildPreview = getCurrentBuildPreviewData();
    let centerX = camera.x + bounds.vw * 0.5;
    let centerY = camera.y + bounds.vh * 0.5;
    // Stable world-space textures: camera motion changes matrices, not pixels.
    if (_staticCacheCommitVersion < 0 || !_combinedBgCanvas) commitStaticCaches(true, 'background');
    let backgroundMinX = 0, backgroundMinY = 0;
    let backgroundMaxX = WORLD_W, backgroundMaxY = WORLD_H;
    let backgroundCanvasFor3D = getBackgroundMip(Math.min(1, 4096 / Math.max(WORLD_W, WORLD_H)));
    let backgroundVersionFor3D = _backgroundContentVersion;
    _ph = _r3dPhase('startPre', _ph);
    if (!fullVisibility) rebuildVisibilityMaskCacheIfNeeded();
    _ph = _r3dPhase('visMask', _ph);
    let overlays = build3DOverlayData(bounds, alpha);
    _ph = _r3dPhase('overlays', _ph);
    let fxBatch = renderer3dFxBatch || (renderer3dFxBatch = new window.Defence3Renderer3D.FxBatch());
    let fxPixelsPerTile = flat2d ? camera.zoom * TILE : ((renderer3dInstance && renderer3dInstance.lodPixelsPerWorld) || 32);
    // Live effects are culled by live visibility, never by remembered fog.
    beginFrameEffects(fxBatch, flat2d, bounds, getTeamLightingGrid(), fxPixelsPerTile, renderer3dInstance);
    let soundGrid = audioSpatialGrid;
    let bgSoundGrid = audioSpatialGridBackground;
    let fxSoundGrid = audioSpatialGridEffects;
    let reactiveOffsetX = Number(audioReactiveGlobalOffsetX) || 0;
    let reactiveOffsetY = Number(audioReactiveGlobalOffsetY) || 0;
    let unitOccupiedTileKeys = renderer3dOccupiedTiles;
    unitOccupiedTileKeys.begin(GRID_W * GRID_H);
    renderer3dStaticFrame.occupied = unitOccupiedTileKeys;
    renderer3dStaticFrame.flat2d = !!flat2d;
    // Settings that change cached objects (view mode, fog, level labels).
    // Flat 2D shows labels by zoom for everything at once; in 3D each thing
    // decides by its own distance, checked by the caches per thing.
    let view3DKey = (flat2d ? 1 : 0) | (fullVisibility ? 2 : 0) | (levelVisibilityMode << 4)
        | (flat2d ? (shouldShowUnitLevels() ? 4 : 0) | (shouldShowBuildingLevels() ? 8 : 0) : 0);
    renderer3dStaticFrame.view = view3DKey;
    let overlapNowMs = (typeof performance !== 'undefined' && typeof performance.now === 'function') ? performance.now() : Date.now();
    let activeOverlapFadeKeys = new Set();
    renderer3dStaticFrame.overlapNowMs = overlapNowMs;
    renderer3dStaticFrame.overlapFadeKeys = activeOverlapFadeKeys;
    // One height transition for every overlapping structure, including mines.
    // Occupied structures keep part of their height (RENDERER3D_OVERLAP_*).
    // Flat sprites have no height.
    let getOverlapFadeForTile = (gx, gy) => flat2d ? null : ({
        gx, gy, occupied: unitOccupiedTileKeys.has(gy * GRID_W + gx),
        nowMs: overlapNowMs, activeKeys: activeOverlapFadeKeys
    });
    let getUnitHeightOffset = (unit) => {
        let id = Number(unit && unit.id) || 0;
        let bucket = ((id * 1103515245) >>> 0) % 7;
        return 0.012 + bucket * 0.003;
    };
    let getTileLightLevel = (gx, gy) => {
        if (fullVisibility) return 1;
        let lighting = visibilityGrid;
        let raw = (lighting[gy] && lighting[gy][gx]) || 0;
        return Math.max(0, Math.min(1, raw / VISIBILITY_LIGHT_NORMALIZATION_RANGE));
    };
    // Snakes render as their head only. The mounted panel is part of the
    // model: uniform footprint scale keeps it square, and it turns with it.
    let pushSnakeRenderObjects = (target, unit, headX, headY, footprint) => {
        let ownerTint = get3DDamageFlashTint(unit, get3DRenderOwnerColor(unit.owner));
        const sideTint = get3DDamageFlashTint(unit, '#3dff64');
        const heightOffset = getUnitHeightOffset(unit);
        let snake2DTexture = get3DExact2DTexture(unit, true);
        let unitStatus = snake2DTexture ? null : get3DUnitTextureStatus(unit);
        let snakeTextureKey = snake2DTexture ? snake2DTexture._renderer3DExactKey : `unit:${unit.unitType || 'snake'}:${unit.owner}:${unitStatus.keySuffix || ''}`;
        push3DRenderObject(target, {
            modelKey: `unit_${unit.unitType || 'snake'}`,
            x: headX / TILE,
            y: heightOffset,
            z: headY / TILE,
            scaleX: footprint,
            scaleY: Math.max(0.24, footprint * 0.52),
            scaleZ: footprint,
            visibilitySource: unit,
            rotationY: Math.atan2(Number(unit.vx) || 0, Number(unit.vy) || 1),
            tint: ownerTint,
            renderShape: 'cylinder',
            topTextureKey: snake2DTexture ? snake2DTexture._renderer3DExactKey : snakeTextureKey,
            topTextureCanvas: snake2DTexture || get3DUnitTopTexture(unit, unit.owner, unitStatus),
            statusTextureCanvas: unit._historyGhost ? null : get3DStatusTexture(getUnit3DStatusState(unit, getUnit3DActivity(unit))),
            sideTint,
        });
    };

    UNIT_3D_REBUILD_TICKS = Math.max(UNIT_3D_REBUILD_TICKS_MIN, Math.min(8, Math.ceil(units.length / 1000)));
    // The unit layer: reused from its tick, or built this frame.
    let unitLayer = null, layerReuse = false, previousOccupied = null;
    _simpleShadows = !!(graphicsOptions && graphicsOptions.shadows === 'simple');
    if (!flat2d && RENDERER3D_UNIT_LAYER_ENABLED && renderer3dInstance) {
        let L = renderer3dUnitLayer;
        // (A big zoom change rebuilds too: model detail follows on-screen size.)
        layerReuse = !!(L && L.tick === gameTime && L.view === view3DKey && L.fullVis === fullVisibility && L.player === localPlayerId
            && L.units === units && L.unitCount === units.length && Math.abs(camera.zoom / L.zoom - 1) < 0.25
            && bounds.minGx >= L.bounds.minGx && bounds.maxGx <= L.bounds.maxGx && bounds.minGy >= L.bounds.minGy && bounds.maxGy <= L.bounds.maxGy);
        if (layerReuse) { unitLayer = L; renderer3dUnitLayerStats.reuse++; }
        else {
            if (L && L.occupied && L.view === view3DKey) previousOccupied = L.occupied;
            renderer3dUnitLayerStats.build++;
            let why = !L ? 'none' : L.tick !== gameTime ? 'tick' : L.view !== view3DKey ? 'view' : L.units !== units || L.unitCount !== units.length ? 'units'
                : L.fullVis !== fullVisibility || L.player !== localPlayerId ? 'player' : 'bounds';
            renderer3dUnitLayerStats.why[why] = (renderer3dUnitLayerStats.why[why] || 0) + 1;
            // A margin around the view, so panning between ticks keeps it.
            let mx = Math.max(4, Math.ceil((bounds.maxGx - bounds.minGx) * 0.3)), my = Math.max(4, Math.ceil((bounds.maxGy - bounds.minGy) * 0.3));
            unitLayer = renderer3dUnitLayer = {
                tick: gameTime, view: view3DKey, fullVis: fullVisibility, player: localPlayerId, units, unitCount: units.length, zoom: camera.zoom,
                bounds: { minGx: bounds.minGx - mx, maxGx: bounds.maxGx + mx, minGy: bounds.minGy - my, maxGy: bounds.maxGy + my },
                objects: [], occupied: [], perFrame: [], motion: [], fallback: [], version: ++renderer3dUnitLayerVersion
            };
            renderer3dInstance.beginUnitLayerWrite(unitLayer.version);
        }
    } else renderer3dUnitLayer = null;
    let layerBuilding = !!(unitLayer && !layerReuse);
    let unitBounds = layerBuilding ? unitLayer.bounds : bounds;
    // With the layer, occupied tiles are collected in the unit pass below;
    // structures (drawn first) use the layer's, a tick old on build frames.
    if (layerReuse) {
        for (let k of unitLayer.occupied) unitOccupiedTileKeys.add(k);
    } else if (layerBuilding && previousOccupied) {
        for (let k of previousOccupied) unitOccupiedTileKeys.add(k);
    }
    // Occupied tiles lower structures in 3D; flat sprites do not overlap-fade.
    if (!flat2d && !unitLayer) for (let u of units) {
        if (u.dead) continue;
        let ux = u.prevX + (u.x - u.prevX) * alpha;
        let uy = u.prevY + (u.y - u.prevY) * alpha;
        let ugx = Math.floor(ux / TILE), ugy = Math.floor(uy / TILE);
        if (ugx < bounds.minGx - 1 || ugx > bounds.maxGx + 1 || ugy < bounds.minGy - 1 || ugy > bounds.maxGy + 1) continue;
        if (!fullVisibility && (!visibilityGrid[ugy] || visibilityGrid[ugy][ugx] === 0)) continue;
        unitOccupiedTileKeys.add(ugy * GRID_W + ugx);
    }

    _ph = _r3dPhase('start', _ph);
    // STRUCTURE LAYER (3D): structures whose cached object is reused
    // unchanged (no audio pulse, flash, rebuild) are drawn from a buffer the
    // renderer keeps (see renderer3d.js, the static arena) until the next
    // tick or view change; on the frames between only the others are
    // processed. Activity effects and overlap-fade states are kept up.
    let staticLayer = null, staticReuse = false;
    if (!flat2d && RENDERER3D_UNIT_LAYER_ENABLED && renderer3dInstance) {
        let S = renderer3dStaticLayer;
        let sameView = !!(S && S.view === view3DKey && S.fullVis === fullVisibility && S.player === localPlayerId && S.grid === grid
            && Math.abs(camera.zoom / S.zoom - 1) < 0.25
            && bounds.minGx >= S.bounds.minGx && bounds.maxGx <= S.bounds.maxGx && bounds.minGy >= S.bounds.minGy && bounds.maxGy <= S.bounds.maxGy);
        staticReuse = sameView && S.tick === gameTime && S.visVersion === visibilityVersion && S.visGrid === visibilityGrid;
        // A tick frame also builds the unit layer: the structures keep the
        // previous tick's layer for this one frame and rebuild on the next,
        // so the two builds do not share a frame.
        // (Ticks may come in groups: any older layer.)
        if (!staticReuse && sameView && layerBuilding && S.tick < gameTime) staticReuse = true;
        if (staticReuse) staticLayer = S;
        else {
            let mx = Math.max(4, Math.ceil((bounds.maxGx - bounds.minGx) * 0.3)), my = Math.max(4, Math.ceil((bounds.maxGy - bounds.minGy) * 0.3));
            staticLayer = renderer3dStaticLayer = {
                tick: gameTime, view: view3DKey, fullVis: fullVisibility, player: localPlayerId, visVersion: visibilityVersion, visGrid: visibilityGrid, grid, zoom: camera.zoom,
                bounds: { minGx: bounds.minGx - mx, maxGx: bounds.maxGx + mx, minGy: bounds.minGy - my, maxGy: bounds.maxGy + my },
                objects: [], perFrame: [], activity: [], fadeKeys: [], version: ++renderer3dStaticLayerVersion
            };
        }
    } else renderer3dStaticLayer = null;
    let staticBuilding = !!(staticLayer && !staticReuse);
    let sBounds = staticBuilding ? staticLayer.bounds : bounds;
    // One structure: stable ones go to the layer being built, the rest are
    // remembered for the frames that reuse it.
    let structureStep = (entity, fn, x, y) => {
        if (!staticBuilding) { fn(entity, x, y); return; }
        let before = objects.length;
        _staticReuseHit = false;
        fn(entity, x, y);
        let n = objects.length - before;
        if (n === 0) return;
        // Served from its cache, or just rebuilt into a cache entry that is
        // not easing, flashing or waiting for its panel.
        let entry = entity._r3dStatic;
        let stable = _staticReuseHit || !!(entry && entry.object === objects[before] && !entry.dynamic);
        for (let k = before; stable && k < objects.length; k++) if (!(objects[k].alpha >= 0.999)) stable = false;
        // By name: the frames reusing the layer call their own step
        // functions (a stored closure would push into this frame's list).
        if (!stable) { staticLayer.perFrame.push({ step: fn.name, entity, x, y }); return; }
        let first = objects[before];
        for (let k = before; k < objects.length; k++) {
            let o = objects[k];
            staticLayer.objects.push(o);
            _pin3DPanelToStatic(o.topTextureCanvas, staticLayer.version);
            if (o.overlapFadeKey !== undefined) staticLayer.fadeKeys.push(o.overlapFadeKey);
        }
        objects.length = before;
        if (_structureHasActivity(entity)) staticLayer.activity.push(entity, first);
    };
    let pushCellItemStep = (item, x, y) => pushCellItem(x, y, grid[y][x]);
    let pushGoldMine = (m) => {
        if (m.gx < sBounds.minGx || m.gx > sBounds.maxGx || m.gy < sBounds.minGy || m.gy > sBounds.maxGy) return;
        if (!fullVisibility && (!visibilityGrid[m.gy] || visibilityGrid[m.gy][m.gx] === 0)) return;
        let bgSoundRow = bgSoundGrid[m.gy];
        let fxSoundRow = fxSoundGrid[m.gy];
        let bgLevel = bgSoundRow ? bgSoundRow[m.gx] || 0 : 0;
        let fxLevel = fxSoundRow ? fxSoundRow[m.gx] || 0 : 0;
        let audioMove = bgLevel * AUDIO_REACTIVE_RENDER_3D_POSITION_FROM_BG + fxLevel * AUDIO_REACTIVE_RENDER_3D_POSITION_FROM_SFX;
        let audioHeight = bgLevel * AUDIO_REACTIVE_RENDER_3D_HEIGHT_FROM_BG + fxLevel * AUDIO_REACTIVE_RENDER_3D_HEIGHT_FROM_SFX;
        if (_reuseStatic3DObject(objects, m, m.gx, m.gy, audioMove, audioHeight)) return;
        let mine2DTexture = get3DExact2DMineTexture('gold', m.gold);
        push3DRenderObject(objects, {
            modelKey: m.gold > 0 ? 'gold_mine_active' : 'gold_mine_empty',
            pickSource: m,
            x: m.gx + 0.5 + reactiveOffsetX * audioMove,
            z: m.gy + 0.5 + reactiveOffsetY * audioMove,
            y: 0,
            scaleX: 0.9,
            scaleY: 0.35 * (1 + audioHeight),
            overlapFade: getOverlapFadeForTile(m.gx, m.gy),
            scaleZ: 0.9,
            heightMode: 'mine',
            tint: '#f0c83a',
            alpha: 1,
            topTextureKey: mine2DTexture ? mine2DTexture._renderer3DExactKey : 'mine:gold',
            topTextureCanvas: mine2DTexture,
            sideTint: '#f0c83a'
        });
        _rememberStatic3DObject(objects, m, m.gx, m.gy, audioMove, audioHeight, !mine2DTexture);
    };
    if (!staticReuse) for (let m of goldMines) structureStep(m, pushGoldMine);

    let pushAstarMine = (m) => {
        if (m.gx < sBounds.minGx || m.gx > sBounds.maxGx || m.gy < sBounds.minGy || m.gy > sBounds.maxGy) return;
        if (!fullVisibility && (!visibilityGrid[m.gy] || visibilityGrid[m.gy][m.gx] === 0)) return;
        let bgSoundRow = bgSoundGrid[m.gy];
        let fxSoundRow = fxSoundGrid[m.gy];
        let bgLevel = bgSoundRow ? bgSoundRow[m.gx] || 0 : 0;
        let fxLevel = fxSoundRow ? fxSoundRow[m.gx] || 0 : 0;
        let audioMove = bgLevel * AUDIO_REACTIVE_RENDER_3D_POSITION_FROM_BG + fxLevel * AUDIO_REACTIVE_RENDER_3D_POSITION_FROM_SFX;
        let audioHeight = bgLevel * AUDIO_REACTIVE_RENDER_3D_HEIGHT_FROM_BG + fxLevel * AUDIO_REACTIVE_RENDER_3D_HEIGHT_FROM_SFX;
        if (_reuseStatic3DObject(objects, m, m.gx, m.gy, audioMove, audioHeight)) return;
        let mine2DTexture = get3DExact2DMineTexture('astar', m.astar);
        push3DRenderObject(objects, {
            modelKey: m.astar > 0 ? 'astar_mine_active' : 'astar_mine_empty',
            pickSource: m,
            x: m.gx + 0.5 + reactiveOffsetX * audioMove,
            z: m.gy + 0.5 + reactiveOffsetY * audioMove,
            y: 0,
            scaleX: 0.9,
            scaleY: 0.35 * (1 + audioHeight),
            overlapFade: getOverlapFadeForTile(m.gx, m.gy),
            scaleZ: 0.9,
            heightMode: 'mine',
            tint: '#d8d8e8',
            alpha: 1,
            topTextureKey: mine2DTexture ? mine2DTexture._renderer3DExactKey : 'mine:astar',
            topTextureCanvas: mine2DTexture,
            sideTint: '#d8d8e8'
        });
        _rememberStatic3DObject(objects, m, m.gx, m.gy, audioMove, audioHeight, !mine2DTexture);
    };
    if (!staticReuse) for (let m of astarMines) structureStep(m, pushAstarMine);

    let pushCellItem = (x, y, cell) => {
        // Barracks and spawners are cell items too, but draw themselves in
        // their own passes below (drawFloorItem leaves their panel blank).
        // Both passes share the per-entity static object cache, so pushing
        // them here would let the blank floor object replace the real one.
        if (typeof cell.item.draw === 'function') return;
        let bgSoundRow = bgSoundGrid[y];
        let fxSoundRow = fxSoundGrid[y];
        let bgLevel = bgSoundRow ? bgSoundRow[x] || 0 : 0;
        let fxLevel = fxSoundRow ? fxSoundRow[x] || 0 : 0;
        let audioMove = bgLevel * AUDIO_REACTIVE_RENDER_3D_POSITION_FROM_BG + fxLevel * AUDIO_REACTIVE_RENDER_3D_POSITION_FROM_SFX;
        let audioHeight = bgLevel * AUDIO_REACTIVE_RENDER_3D_HEIGHT_FROM_BG + fxLevel * AUDIO_REACTIVE_RENDER_3D_HEIGHT_FROM_SFX;
        if (_reuseStatic3DObject(objects, cell.item, x, y, audioMove, audioHeight)) { _pushStructureActivity(objects, cell.item, flat2d); return; }
        let item2DTexture = get3DExact2DFloorTexture(cell.item, cell.owner);
        let itemStatus = item2DTexture ? null : get3DBuildingTextureStatus(cell.item);
        let isFarmItem = cell.item.type === 'farm' || cell.item.type === 'astar_farm';
        push3DRenderObject(objects, {
            modelKey: `item_${cell.item.type || 'floor'}`,
            x: x + 0.5 + reactiveOffsetX * audioMove,
            y: get3DConstructionLift(cell.item),
            z: y + 0.5 + reactiveOffsetY * audioMove,
            scaleX: 0.84,
            scaleY: (cell.item.type === 'house' ? 0.82 : isFarmItem ? 0.72 : 0.14) * (1 + audioHeight),
            overlapFade: getOverlapFadeForTile(x, y),
            scaleZ: 0.84,
            preserveModelHeight: cell.item.type === 'house' || isFarmItem,
            visibilitySource: cell.item,
            rotationY: -(Number(cell.item.angle) || 0),
            tint: get3DDamageFlashTint(cell.item, get3DRenderOwnerColor(cell.owner)),
            alpha: get3DConstructionAlpha(cell.item),
            topTextureKey: item2DTexture ? item2DTexture._renderer3DExactKey : `item:${cell.item.type}:${cell.owner}:${itemStatus.keySuffix}`,
            topTextureCanvas: item2DTexture || get3DTopTextureForFloorItem(cell.item, itemStatus),
            sideTint: get3DDamageFlashTint(cell.item, (BASE_CARD_TYPES[cell.item.type] || {}).color || get3DRenderOwnerColor(cell.owner))
        });
        _rememberStatic3DObject(objects, cell.item, x, y, audioMove, audioHeight, !item2DTexture);
        _pushStructureActivity(objects, cell.item, flat2d);
    };
    // Floor items in row-major order. The live tile index lists them, so
    // only a remembered (history) grid needs a scan of every visible tile.
    if (staticReuse) {
        // Nothing to walk: only what could not be kept.
    } else if (_isLiveRenderGrid(grid)) {
        let items = getCellItemsRowMajor();
        for (let i = findCellItemRowStart(items, sBounds.minGy); i < items.length; i++) {
            let item = items[i], x = item.gx, y = item.gy;
            if (y > sBounds.maxGy) break;
            if (x < sBounds.minGx || x > sBounds.maxGx) continue;
            let cell = grid[y][x];
            if (!cell || cell.item !== item) continue;
            if (!fullVisibility && (!visibilityGrid[y] || visibilityGrid[y][x] === 0)) continue;
            structureStep(cell.item, pushCellItemStep, x, y);
        }
    } else {
        for (let y = sBounds.minGy; y <= sBounds.maxGy; y++) {
            let gridRow = grid[y];
            let visRow = visibilityGrid[y];
            if (!gridRow) continue;
            for (let x = sBounds.minGx; x <= sBounds.maxGx; x++) {
                let cell = gridRow[x];
                if (!cell || !cell.item) continue;
                if (!fullVisibility && (!visRow || visRow[x] === 0)) continue;
                structureStep(cell.item, pushCellItemStep, x, y);
            }
        }
    }

    let pushTower = (t) => {
        if (t.gx < sBounds.minGx - 1 || t.gx > sBounds.maxGx + 1 || t.gy < sBounds.minGy - 1 || t.gy > sBounds.maxGy + 1) return;
        if (!fullVisibility && (!visibilityGrid[t.gy] || visibilityGrid[t.gy][t.gx] === 0)) return;
        let bgSoundRow = bgSoundGrid[t.gy];
        let fxSoundRow = fxSoundGrid[t.gy];
        let bgLevel = bgSoundRow ? bgSoundRow[t.gx] || 0 : 0;
        let fxLevel = fxSoundRow ? fxSoundRow[t.gx] || 0 : 0;
        let audioMove = bgLevel * AUDIO_REACTIVE_RENDER_3D_POSITION_FROM_BG + fxLevel * AUDIO_REACTIVE_RENDER_3D_POSITION_FROM_SFX;
        let audioHeight = bgLevel * AUDIO_REACTIVE_RENDER_3D_HEIGHT_FROM_BG + fxLevel * AUDIO_REACTIVE_RENDER_3D_HEIGHT_FROM_SFX;
        if (_reuseStatic3DObject(objects, t, t.gx, t.gy, audioMove, audioHeight)) return;
        let tower2DTexture = get3DExact2DTexture(t);
        let tower2DTextureFallback = renderer3dExactTextureFallback;
        let towerStatus = tower2DTexture ? null : get3DBuildingTextureStatus(t);
        // Clouds are portals: they never aim, and their gate faces the camera.
        let isPortal = String(t.type || '').startsWith('cloud');
        push3DRenderObject(objects, {
            modelKey: `tower_${t.type || 'base'}`,
            x: t.x / TILE + reactiveOffsetX * audioMove,
            y: get3DConstructionLift(t),
            z: t.y / TILE + reactiveOffsetY * audioMove,
            scaleX: isPortal ? 0.96 : 0.82,
            scaleY: 1.05 * (1 + audioHeight),
            overlapFade: getOverlapFadeForTile(t.gx, t.gy),
            scaleZ: isPortal ? 0.96 : 0.82,
            visibilitySource: t,
            rotationY: isPortal ? 0 : Math.PI * 0.5 - (Number(t.angle) || 0),
            tint: get3DDamageFlashTint(t, get3DRenderOwnerColor(t.owner)),
            alpha: get3DConstructionAlpha(t),
            topTextureKey: tower2DTexture ? tower2DTexture._renderer3DExactKey : `tower:${t.type}:${t.owner}:${_quantizeTowerAngleIndex(t.angle || 0)}:${towerStatus.keySuffix}`,
            topTextureCanvas: tower2DTexture || get3DBuildingTopTexture('tower', t.owner, { subtype: t.type, color: t.baseStats && t.baseStats.color, angle: t.angle || 0, angleKey: _quantizeTowerAngleIndex(t.angle || 0), active: t.type === 'laser' ? t.connectedLasers && t.connectedLasers.length > 0 : true, status: towerStatus, statusKey: towerStatus.keySuffix }),
            sideTint: get3DDamageFlashTint(t, (t.baseStats && t.baseStats.color) || get3DRenderOwnerColor(t.owner))
        });
        _rememberStatic3DObject(objects, t, t.gx, t.gy, audioMove, audioHeight, !tower2DTexture || tower2DTextureFallback);
    };
    if (!staticReuse) for (let t of towers) structureStep(t, pushTower);

    let pushSpawner = (s) => {
        if (s.gx < sBounds.minGx || s.gx > sBounds.maxGx || s.gy < sBounds.minGy || s.gy > sBounds.maxGy) return;
        if (!fullVisibility && (!visibilityGrid[s.gy] || visibilityGrid[s.gy][s.gx] === 0)) return;
        let bgSoundRow = bgSoundGrid[s.gy];
        let fxSoundRow = fxSoundGrid[s.gy];
        let bgLevel = bgSoundRow ? bgSoundRow[s.gx] || 0 : 0;
        let fxLevel = fxSoundRow ? fxSoundRow[s.gx] || 0 : 0;
        let audioMove = bgLevel * AUDIO_REACTIVE_RENDER_3D_POSITION_FROM_BG + fxLevel * AUDIO_REACTIVE_RENDER_3D_POSITION_FROM_SFX;
        let audioHeight = bgLevel * AUDIO_REACTIVE_RENDER_3D_HEIGHT_FROM_BG + fxLevel * AUDIO_REACTIVE_RENDER_3D_HEIGHT_FROM_SFX;
        if (_reuseStatic3DObject(objects, s, s.gx, s.gy, audioMove, audioHeight)) { _pushStructureActivity(objects, s, flat2d); _pushProductionGhost(objects, s, flat2d); return; }
        let spawner2DTexture = get3DExact2DTexture(s);
        let spawner2DTextureFallback = renderer3dExactTextureFallback;
        let spawnerExtraBars = spawner2DTexture ? null : [];
        if (!spawner2DTexture && !s.underConstruction && s.spawnQueue && s.spawnQueue.length > 0 && s.spawnCooldown > 0) {
            spawnerExtraBars.push({ pct: s.spawnTimer / s.spawnCooldown, bgColor: '#333', fillColor: (s.spawnTimer / s.spawnCooldown) > 0.8 ? '#4f4' : '#fa0' });
        }
        if (!spawner2DTexture && !s.underConstruction && s.type === 'research' && s.researchTask && s.researchTask.workRequired > 0) {
            let pct = Math.max(0, Math.min(1, (s.researchTask.workDone || 0) / s.researchTask.workRequired));
            spawnerExtraBars.push({ pct, bgColor: '#333', fillColor: pct > 0.8 ? '#4f4' : '#4af' });
        }
        let spawnerStatus = spawner2DTexture ? null : get3DBuildingTextureStatus(s, spawnerExtraBars);
        push3DRenderObject(objects, {
            modelKey: `spawner_${s.type || 'base'}`,
            x: s.x / TILE + reactiveOffsetX * audioMove,
            y: get3DConstructionLift(s),
            z: s.y / TILE + reactiveOffsetY * audioMove,
            scaleX: 0.95,
            scaleY: get3DStructureModelHeight(s.type) * (1 + audioHeight),
            preserveModelHeight: true,
            overlapFade: getOverlapFadeForTile(s.gx, s.gy),
            scaleZ: 0.95,
            visibilitySource: s,
            tint: get3DDamageFlashTint(s, get3DRenderOwnerColor(s.owner)),
            alpha: get3DConstructionAlpha(s),
            topTextureKey: spawner2DTexture ? spawner2DTexture._renderer3DExactKey : `spawner:${s.type}:${s.owner}:${spawnerStatus.keySuffix}`,
            topTextureCanvas: spawner2DTexture || get3DBuildingTopTexture(
                s.type === 'astar_spawner' ? 'spawner_astar' :
                    s.type === 'salvager' ? 'spawner_salvager' :
                        s.type === 'builder_spawner' ? 'spawner_builder' :
                            s.type === 'healer_spawner' ? 'spawner_healer' :
                                s.type === 'research' ? 'spawner_research' :
                                    'spawner_energy',
                s.owner,
                { subtype: s.type, status: spawnerStatus, statusKey: spawnerStatus.keySuffix }
            ),
            sideTint: get3DDamageFlashTint(s, (BASE_CARD_TYPES[s.type] || {}).color || get3DRenderOwnerColor(s.owner))
        });
        _rememberStatic3DObject(objects, s, s.gx, s.gy, audioMove, audioHeight, !spawner2DTexture || spawner2DTextureFallback);
        _pushStructureActivity(objects, s, flat2d);
        _pushProductionGhost(objects, s, flat2d);
    };
    if (!staticReuse) for (let s of collectorSpawners) structureStep(s, pushSpawner);

    let pushBarrack = (b) => {
        if (b.gx < sBounds.minGx || b.gx > sBounds.maxGx || b.gy < sBounds.minGy || b.gy > sBounds.maxGy) return;
        if (!fullVisibility && (!visibilityGrid[b.gy] || visibilityGrid[b.gy][b.gx] === 0)) return;
        let bgSoundRow = bgSoundGrid[b.gy];
        let fxSoundRow = fxSoundGrid[b.gy];
        let bgLevel = bgSoundRow ? bgSoundRow[b.gx] || 0 : 0;
        let fxLevel = fxSoundRow ? fxSoundRow[b.gx] || 0 : 0;
        let audioMove = bgLevel * AUDIO_REACTIVE_RENDER_3D_POSITION_FROM_BG + fxLevel * AUDIO_REACTIVE_RENDER_3D_POSITION_FROM_SFX;
        let audioHeight = bgLevel * AUDIO_REACTIVE_RENDER_3D_HEIGHT_FROM_BG + fxLevel * AUDIO_REACTIVE_RENDER_3D_HEIGHT_FROM_SFX;
        if (_reuseStatic3DObject(objects, b, b.gx, b.gy, audioMove, audioHeight)) { _pushStructureActivity(objects, b, flat2d); _pushProductionGhost(objects, b, flat2d); return; }
        let barrack2DTexture = get3DExact2DTexture(b);
        let barrack2DTextureFallback = renderer3dExactTextureFallback;
        let barrackExtraBars = barrack2DTexture ? null : [];
        if (!barrack2DTexture && !b.underConstruction && b.spawnQueue && b.spawnQueue.length > 0 && b.spawnCooldown > 0) {
            barrackExtraBars.push({ pct: b.spawnTimer / b.spawnCooldown, bgColor: '#333', fillColor: (b.spawnTimer / b.spawnCooldown) > 0.8 ? '#4f4' : '#fa0' });
        }
        let barrackStatus = barrack2DTexture ? null : get3DBuildingTextureStatus(b, barrackExtraBars);
        push3DRenderObject(objects, {
            modelKey: `barrack_${b.unitType || 'norm'}`,
            x: b.x / TILE + reactiveOffsetX * audioMove,
            y: get3DConstructionLift(b),
            z: b.y / TILE + reactiveOffsetY * audioMove,
            scaleX: 0.98,
            scaleY: get3DStructureModelHeight('barrack') * (1 + audioHeight),
            preserveModelHeight: true,
            overlapFade: getOverlapFadeForTile(b.gx, b.gy),
            scaleZ: 0.98,
            visibilitySource: b,
            tint: get3DDamageFlashTint(b, get3DRenderOwnerColor(b.owner)),
            alpha: get3DConstructionAlpha(b),
            topTextureKey: barrack2DTexture ? barrack2DTexture._renderer3DExactKey : `barrack:${b.unitType}:${b.owner}:${barrackStatus.keySuffix}`,
            topTextureCanvas: barrack2DTexture || get3DBuildingTopTexture('barrack', b.owner, { subtype: b.unitType, color: (BASE_UNIT_STATS[b.unitType] || BASE_UNIT_STATS.norm).color, status: barrackStatus, statusKey: barrackStatus.keySuffix }),
            sideTint: get3DDamageFlashTint(b, (BASE_UNIT_STATS[b.unitType] || BASE_UNIT_STATS.norm).color)
        });
        _rememberStatic3DObject(objects, b, b.gx, b.gy, audioMove, audioHeight, !barrack2DTexture || barrack2DTextureFallback);
        _pushStructureActivity(objects, b, flat2d);
        _pushProductionGhost(objects, b, flat2d);
    };
    if (!staticReuse) for (let b of barracks) structureStep(b, pushBarrack);

    _ph = _r3dPhase(staticBuilding ? 'structuresBuild' : 'structuresReuse', _ph);
    // Reusing the structure layer: the structures it could not keep, and the
    // per-frame upkeep of those it holds.
    if (staticReuse) {
        let steps = { pushGoldMine, pushAstarMine, pushTower, pushSpawner, pushBarrack, pushCellItemStep };
        for (let p of staticLayer.perFrame) steps[p.step](p.entity, p.x, p.y);
        for (let i = 0; i < staticLayer.activity.length; i += 2) _pushStructureActivity([staticLayer.activity[i + 1]], staticLayer.activity[i], false);
        // (Its structures' fade states are kept: pruning runs only on frames
        // that walk the structures; the layer is rebuilt every tick.)
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

    if (flat2d) drainFlatObjects();
    // Units already in the reused layer need only their panels kept alive
    // and their motion effects (a few unit types) at this frame's position.
    if (layerReuse) {
        for (let m of unitLayer.motion) {
            let u = m.u;
            if (u.dead) continue;
            let x = (u.prevX + (u.x - u.prevX) * alpha) / TILE + reactiveOffsetX * m.audioMove;
            let z = (u.prevY + (u.y - u.prevY) * alpha) / TILE + reactiveOffsetY * m.audioMove;
            pushUnitMotionFx(u, x, z, m.footprint, m.scaleY);
        }
    }
    // A unit's object moves into the layer being built when it is stable
    // until the next tick; the rest stay on the per-frame path.
    let layerCollect = (u, footprint, audioMove) => {
        let o = objects[objects.length - 1];
        let cached = u._r3d;
        if (!_unitLayerEligible(u, cached, o)) {
            unitLayer.perFrame.push(u);
            return;
        }
        objects.pop();
        let cx = u.x / TILE + reactiveOffsetX * audioMove, cz = u.y / TILE + reactiveOffsetY * audioMove;
        o.x = o._cx = cx; o.z = o._cz = cz;
        o._pdx = (u.prevX - u.x) / TILE; o._pdz = (u.prevY - u.y) / TILE;
        if (cached.snake) { o._phaseRate = 0; o._flyOn = 0; o._flySeed = 0; }
        else {
            _unit3DWalkPhaseLinear(u, cached.activity, _unitLayerPhase);
            o.walkPhase = _unitLayerPhase[0]; o._phaseRate = _unitLayerPhase[1];
            o.y = cached.baseY + (u.isFlying ? (u.isWorker ? .36 : .30) : 0);
            o._flyOn = u.isFlying ? 1 : 0;
            o._flySeed = ((Number(u.id) || 0) * 1.7) % (Math.PI * 2);
        }
        // Lit where it is at the tick (the light grid changes on ticks).
        _relight3DObject(o, u, cached.tint, cached.sideTint, false, cached.sourceLight);
        _pin3DPanelToLayer(o.topTextureCanvas, unitLayer.version);
        unitLayer.objects.push(o);
        if (!renderer3dInstance.writeUnitLayerObject(o)) unitLayer.fallback.push(o);
        else if (unitVis && _uSlotVisIndex >= 0) {
            let sl = unitVis.order[_uSlotVisIndex];
            _uSlotFill(sl, u, o, cached, unitVis.sig[sl], view3DKey);
        }
        if (u.isSnake || u.unitType === 'tank' || u.unitType === 'boss' || u.unitType === 'king') {
            unitLayer.motion.push({ u, footprint, scaleY: o.scaleY, audioMove });
        }
    };
    // Building the layer from the worker's unit frame (sim_frame.js): a unit
    // whose cached object is still valid is written from its frame columns,
    // without the per-object logic below.
    let unitVis = layerBuilding && units === sourceView.units && typeof simClientCurrentUnitVis === 'function' ? simClientCurrentUnitVis() : null;
    let statusCanvases = unitVis ? SIM_UNIT_STATUS_NAMES.map(name => get3DStatusTexture(name)) : null;
    let unitList = layerReuse ? unitLayer.perFrame : units;
    // With the records: units whose slot is valid are written from it; the
    // rest (slowIdx) take the per-object loop below.
    let slowIdx = null;
    _dbgStats = typeof window !== 'undefined' && window.__unitSlowWhy ? (window.__unitSlowWhy.builds++, window.__unitSlowWhy) : null;
    if (unitVis) {
        slowIdx = [];
        let FV = unitVis, FO = FV.order, S = _uSlot, r3 = renderer3dInstance;
        let statusSlots = r3.statusSlotsFor(statusCanvases);
        let labelsOn = levelVisibilityMode === LEVEL_VISIBILITY_ALL;
        let flashChecks = renderer3dFlashUntil.size > 0, nowT = gameTime + tickAlpha;
        let layerVersion = unitLayer.version;
        let rec = _uRec;
        let camKey = r3.lodEye ? r3.lodEye[0] + ',' + r3.lodEye[1] + ',' + r3.lodEye[2] + ',' + r3.lodForward[0] + ',' + r3.lodForward[1] + ',' + r3.lodForward[2] + ',' + r3.lodProjectionScale : String(r3.lodPixelsPerWorld);
        if (camKey !== _uLodCamKey) { _uLodCamKey = camKey; _uLodCamStamp++; }
        let camStamp = _uLodCamStamp, KN = U_SLOT_KEY_N, keyArr = S.inKey, recArr = S.rec;
        for (let i = 0; i < units.length; i++) {
            let slot = FO[i];
            let x = FV.x[slot], y = FV.y[slot], px = FV.px[slot], py = FV.py[slot];
            let ux = px + (x - px) * alpha, uy = py + (y - py) * alpha;
            let ugx = Math.floor(ux / TILE), ugy = Math.floor(uy / TILE);
            if (ugx < unitBounds.minGx - 1 || ugx > unitBounds.maxGx + 1 || ugy < unitBounds.minGy - 1 || ugy > unitBounds.maxGy + 1) continue;
            if (!fullVisibility && (!visibilityGrid[ugy] || visibilityGrid[ugy][ugx] === 0)) continue;
            unitLayer.occupied.push(ugy * GRID_W + ugx);
            let id = FV.id[slot];
            if (!(slot < S.cap) || !S.valid[slot] || S.id[slot] !== id || S.sig[slot] !== FV.sig[slot] || S.view[slot] !== view3DKey
                || (S.panel[slot]._textureVersion || 0) !== S.texVer[slot]) {
                let st = _dbgStats; if (st) { let why = !(slot < S.cap) || !S.valid[slot] ? 'invalid' : S.id[slot] !== id ? 'id' : S.sig[slot] !== FV.sig[slot] ? 'sig' : S.view[slot] !== view3DKey ? 'view' : 'tex'; st[why]++; if (why === 'invalid') { let t = 'type_' + units[i].unitType; st[t] = (st[t] || 0) + 1; } }
                slowIdx.push(i); continue;
            }
            if (flashChecks) {
                let until = renderer3dFlashUntil.get(id);
                if (until !== undefined) { if (until > nowT) { if (_dbgStats) _dbgStats.flash++; slowIdx.push(i); continue; } renderer3dFlashUntil.delete(id); }
            }
            let flags = S.flags[slot];
            if (S.label[slot] !== 2) {
                // Level labels by on-screen size, with the same hysteresis.
                let shown = S.labelShown[slot] === 1;
                if (labelsOn) {
                    let zoom = getViewZoomAt(ux, uy);
                    shown = shown ? zoom >= 0.7 * 0.95 : zoom >= 0.7 * 1.05;
                } else shown = false;
                S.labelShown[slot] = shown ? 1 : 0;
                if ((shown ? 1 : 0) !== S.label[slot]) { if (_dbgStats) _dbgStats.label++; slowIdx.push(i); continue; }
            }
            let gx = Math.floor(x / TILE), gy = Math.floor(y / TILE);
            let bgRow = bgSoundGrid[gy], fxRow = fxSoundGrid[gy];
            let audioMove = (bgRow ? bgRow[gx] || 0 : 0) * AUDIO_REACTIVE_RENDER_3D_POSITION_FROM_BG + (fxRow ? fxRow[gx] || 0 : 0) * AUDIO_REACTIVE_RENDER_3D_POSITION_FROM_SFX;
            let cx = x / TILE + reactiveOffsetX * audioMove, cz = y / TILE + reactiveOffsetY * audioMove;
            // Light at the tick's tile (and the unit's own).
            let level = 1;
            if (!fullVisibility) {
                let row = visibilityGrid[Math.floor(cz)];
                let raw = Math.max((row && row[Math.floor(cx)]) || 0, FV.light[slot]);
                level = Math.max(0, Math.min(1, raw / VISIBILITY_LIGHT_NORMALIZATION_RANGE));
            }
            let bucket = Math.max(0, Math.min(24, Math.round(level * 24)));
            // Unchanged since the slot's last record (an idle unit): that
            // record, with this tick's animation phase.
            let ko = slot * KN, ro = slot * 28, st = statusSlots[FV.status[slot] | 0];
            if (keyArr[ko] === x && keyArr[ko + 1] === y && keyArr[ko + 2] === px && keyArr[ko + 3] === py && keyArr[ko + 4] === FV.facing[slot]
                && keyArr[ko + 5] === FV.mode[slot] && keyArr[ko + 6] === FV.amount[slot] && keyArr[ko + 7] === st && keyArr[ko + 8] === cx
                && keyArr[ko + 9] === cz && keyArr[ko + 10] === level && keyArr[ko + 11] === camStamp) {
                for (let q = 0; q < 28; q++) rec[q] = recArr[ro + q];
                let snakeC = flags & U_SLOT_SNAKE;
                rec[11] = snakeC ? 0 : FV.prate[slot]; rec[21] = snakeC ? 0 : FV.phase[slot];
                let lodC = S.lod[slot], panelC = S.panel[slot];
                panelC._layerPin = layerVersion; panelC._usedFrame = renderer3dExactTextureFrame;
                if (!r3.writeUnitLayerRecord(lodC === 0 ? S.kind[slot] : lodC === 1 ? S.kindLod[slot] : S.kindLod2[slot], snakeC ? 0 : FV.mode[slot], rec, panelC, units[i])) { slowIdx.push(i); continue; }
                if (flags & U_SLOT_MOTION) {
                    let u = units[i];
                    let footprint = Math.max(0.28, Math.min(0.9, ((u.r || 8) * 2.2) / TILE));
                    unitLayer.motion.push({ u, footprint, scaleY: S.dim[slot * 4 + 1], audioMove });
                    pushUnitMotionFx(u, ux / TILE + reactiveOffsetX * audioMove, uy / TILE + reactiveOffsetY * audioMove, footprint, S.dim[slot * 4 + 1]);
                }
                continue;
            }
            let d = slot * 4, c = slot * 6;
            let sx = S.dim[d], sy = S.dim[d + 1], sz = S.dim[d + 2];
            let facing = FV.facing[slot], cs = Math.cos(facing), sn = Math.sin(facing);
            let snake = flags & U_SLOT_SNAKE, flying = !snake && (flags & U_SLOT_FLYING);
            rec[0] = cs * sx; rec[1] = 0; rec[2] = -sn * sx; rec[3] = (px - x) / TILE;
            rec[4] = flying ? (id * 1.7) % (Math.PI * 2) : 0; rec[5] = sy; rec[6] = flying ? 1 : 0; rec[7] = (py - y) / TILE;
            rec[8] = sn * sz; rec[9] = 0; rec[10] = cs * sz; rec[11] = snake ? 0 : FV.prate[slot];
            rec[12] = cx; rec[13] = S.dim[d + 3]; rec[14] = cz; rec[15] = 1;
            let lut = bucket * 256, rgb = S.rgb;
            rec[16] = _LIT_LUT[lut + rgb[c]]; rec[17] = _LIT_LUT[lut + rgb[c + 1]]; rec[18] = _LIT_LUT[lut + rgb[c + 2]];
            rec[19] = 1;
            rec[20] = snake ? 0 : FV.amount[slot];
            rec[21] = snake ? 0 : FV.phase[slot];
            rec[22] = _LIT_LUT[lut + rgb[c + 3]]; rec[23] = _LIT_LUT[lut + rgb[c + 4]]; rec[24] = _LIT_LUT[lut + rgb[c + 5]];
            rec[25] = level;
            rec[27] = statusSlots[FV.status[slot] | 0];
            // Level of detail by on-screen size (hysteresis as getFigureMeshKey).
            let pixels = r3.pixelsPerWorldAt(cx, 0, cz) * Math.max(sx, sz);
            let lod = figureLodLevel(S.lod[slot], pixels);
            S.lod[slot] = lod;
            for (let q = 0; q < 28; q++) recArr[ro + q] = rec[q];
            keyArr[ko] = x; keyArr[ko + 1] = y; keyArr[ko + 2] = px; keyArr[ko + 3] = py; keyArr[ko + 4] = FV.facing[slot];
            keyArr[ko + 5] = FV.mode[slot]; keyArr[ko + 6] = FV.amount[slot]; keyArr[ko + 7] = st; keyArr[ko + 8] = cx;
            keyArr[ko + 9] = cz; keyArr[ko + 10] = level; keyArr[ko + 11] = camStamp;
            let panel = S.panel[slot];
            panel._layerPin = layerVersion; panel._usedFrame = renderer3dExactTextureFrame;
            if (!r3.writeUnitLayerRecord(lod === 0 ? S.kind[slot] : lod === 1 ? S.kindLod[slot] : S.kindLod2[slot], snake ? 0 : FV.mode[slot], rec, panel, units[i])) { slowIdx.push(i); continue; }
            if (flags & U_SLOT_MOTION) {
                let u = units[i];
                let footprint = Math.max(0.28, Math.min(0.9, ((u.r || 8) * 2.2) / TILE));
                unitLayer.motion.push({ u, footprint, scaleY: sy, audioMove });
                pushUnitMotionFx(u, ux / TILE + reactiveOffsetX * audioMove, uy / TILE + reactiveOffsetY * audioMove, footprint, sy);
            }
        }
    }
    _ph = _r3dPhase(layerBuilding ? 'unitsFast' : 'unitsPre', _ph);
    let loopCount = slowIdx ? slowIdx.length : unitList.length;
    if (typeof window !== 'undefined' && window.__unitLayerStats) { let st = window.__unitLayerStats; st.builds++; st.slow += slowIdx ? slowIdx.length : -1; st.total += units.length; }
    for (let li = 0; li < loopCount; li++) {
        let ui = slowIdx ? slowIdx[li] : li;
        let u = slowIdx ? units[ui] : unitList[ui];
        _uSlotVisIndex = ui;
        if (flat2d) drainFlatObjects();
        if (u.dead) continue;
        let ux = u.prevX + (u.x - u.prevX) * alpha;
        let uy = u.prevY + (u.y - u.prevY) * alpha;
        let ugx = Math.floor(ux / TILE), ugy = Math.floor(uy / TILE);
        if (ugx < unitBounds.minGx - 1 || ugx > unitBounds.maxGx + 1 || ugy < unitBounds.minGy - 1 || ugy > unitBounds.maxGy + 1) continue;
        if (!fullVisibility && (!visibilityGrid[ugy] || visibilityGrid[ugy][ugx] === 0)) continue;
        if (layerBuilding) unitLayer.occupied.push(ugy * GRID_W + ugx);
        let bgSoundRow = bgSoundGrid[ugy];
        let fxSoundRow = fxSoundGrid[ugy];
        let bgLevel = bgSoundRow ? bgSoundRow[ugx] || 0 : 0;
        let fxLevel = fxSoundRow ? fxSoundRow[ugx] || 0 : 0;
        let audioMove = bgLevel * AUDIO_REACTIVE_RENDER_3D_POSITION_FROM_BG + fxLevel * AUDIO_REACTIVE_RENDER_3D_POSITION_FROM_SFX;
        if (flat2d && _pushFlatUnit(flatBatch, u, ux / TILE + reactiveOffsetX * audioMove, uy / TILE + reactiveOffsetY * audioMove, view3DKey)) continue;
        let audioHeight = bgLevel * AUDIO_REACTIVE_RENDER_3D_HEIGHT_FROM_BG + fxLevel * AUDIO_REACTIVE_RENDER_3D_HEIGHT_FROM_SFX;
        let footprint = Math.max(0.28, Math.min(0.9, ((u.r || 8) * 2.2) / TILE));
        if (unitVis) {
            let cached = u._r3d, sl = unitVis.order[ui];
            let sig = unitVis.sig[sl];
            if (cached && cached.sigW !== sig) cached.tick = -1e9;   // panel changed: rebuild below
            else if (cached && (cached.snake ? !!u.isSnake : !u.isSnake) && cached.view === view3DKey
                && (u.isSnake || cached.label === shouldShowUnitLevels(u))
                && _unitLayerEligible(u, cached, cached.object)
                && (cached.object.topTextureCanvas || {})._textureVersion === cached.textureVersion) {
                _layerWriteFromVis(u, cached, unitVis, sl, statusCanvases, reactiveOffsetX * audioMove, reactiveOffsetY * audioMove);
                unitLayer.objects.push(cached.object);
                if (!renderer3dInstance.writeUnitLayerObject(cached.object)) unitLayer.fallback.push(cached.object);
                else _uSlotFill(sl, u, cached.object, cached, sig, view3DKey);
                if (u.isSnake || u.unitType === 'tank' || u.unitType === 'boss' || u.unitType === 'king') {
                    unitLayer.motion.push({ u, footprint, scaleY: cached.object.scaleY, audioMove });
                    pushUnitMotionFx(u, ux / TILE + reactiveOffsetX * audioMove, uy / TILE + reactiveOffsetY * audioMove, footprint, cached.object.scaleY);
                }
                continue;
            }
        }
        if (u.isSnake) {
            // As units below: between ticks only the position and lighting
            // of the cached head object change.
            let cached = u._r3d;
            let cachedAge = cached ? gameTime - cached.tick : -1;
            if (cached && cached.snake && (cachedAge === 0 || (cachedAge < UNIT_3D_REBUILD_TICKS && ((u.id + gameTime) % UNIT_3D_REBUILD_TICKS) !== 0))
                && cached.view === view3DKey && !cached.dynamic && !getDamageFlashState(u)
                && (cached.object.topTextureCanvas || {})._textureVersion === cached.textureVersion) {
                let o = cached.object;
                _touch3DPanel(o.topTextureCanvas);
                if (cached.refreshTick !== gameTime) {
                    cached.refreshTick = gameTime;
                    o.rotationY = Math.atan2(Number(u.vx) || 0, Number(u.vy) || 1);
                    o.statusTextureCanvas = u._historyGhost ? null : get3DStatusTexture(getUnit3DStatusState(u, getUnit3DActivity(u)));
                }
                o.x = (ux + reactiveOffsetX * audioMove * TILE) / TILE;
                o.z = (uy + reactiveOffsetY * audioMove * TILE) / TILE;
                if (cached.sourceLightTick !== gameTime || cached.sourceLightPlayer !== localPlayerId) {
                    cached.sourceLight = getVisualUnitSourceLight(u);
                    cached.sourceLightTick = gameTime;
                    cached.sourceLightPlayer = localPlayerId;
                }
                _relight3DObject(o, u, cached.tint, cached.sideTint, !!objects.flat2d, cached.sourceLight);
                objects.push(o);
                if (!flat2d) pushUnitMotionFx(u, o.x, o.z, footprint, o.scaleY);
                if (layerBuilding) layerCollect(u, footprint, audioMove);
                if (unitVis) cached.sigW = unitVis.sig[unitVis.order[ui]];
                continue;
            }
            pushSnakeRenderObjects(objects, u, ux + reactiveOffsetX * audioMove * TILE, uy + reactiveOffsetY * audioMove * TILE, footprint);
            let head = objects[objects.length - 1];
            u._r3d = { snake: true, object: head, tick: gameTime, refreshTick: gameTime, view: view3DKey, tint: head.baseTint, sideTint: head.baseSideTint,
                textureVersion: head.topTextureCanvas && head.topTextureCanvas._textureVersion,
                dynamic: !head.topTextureCanvas || renderer3dExactTextureFallback || !!getDamageFlashState(u) };
            if (!flat2d) pushUnitMotionFx(u, head.x, head.z, footprint, head.scaleY);
            if (layerBuilding) layerCollect(u, footprint, audioMove);
        } else {
            // Everything but the interpolated position, walk cycle and
            // lighting changes only on ticks: refresh just those.
            let cached = u._r3d;
            // A full rebuild (panel texture signature, colours, model) runs
            // for each unit every UNIT_3D_REBUILD_TICKS ticks, a third of the
            // units per tick (by id); in between, a cheap per-tick refresh
            // keeps facing, activity and the status icon current.
            let cachedAge = cached ? gameTime - cached.tick : -1;
            if (cached && (cachedAge === 0 || (cachedAge < UNIT_3D_REBUILD_TICKS && ((u.id + gameTime) % UNIT_3D_REBUILD_TICKS) !== 0))
                && cached.view === view3DKey && !cached.dynamic && !getDamageFlashState(u)
                && cached.label === (!flat2d && shouldShowUnitLevels(u))
                && (cached.object.topTextureCanvas || {})._textureVersion === cached.textureVersion) {
                let o = cached.object;
                _touch3DPanel(o.topTextureCanvas);
                if (cached.refreshTick !== gameTime) _refreshUnit3DObject(u, o, cached);
                if (layerBuilding && _unitLayerEligible(u, cached, o)) {
                    if (cached.sourceLightTick !== gameTime || cached.sourceLightPlayer !== localPlayerId) {
                        cached.sourceLight = getVisualUnitSourceLight(u);
                        cached.sourceLightTick = gameTime;
                        cached.sourceLightPlayer = localPlayerId;
                    }
                    objects.push(o);
                    layerCollect(u, footprint, audioMove);
                    if (unitVis) cached.sigW = unitVis.sig[unitVis.order[ui]];
                    // This frame's motion effects (the layer's own start next frame).
                    if (u.unitType === 'tank' || u.unitType === 'boss' || u.unitType === 'king') {
                        pushUnitMotionFx(u, ux / TILE + reactiveOffsetX * audioMove, uy / TILE + reactiveOffsetY * audioMove, footprint, o.scaleY);
                    }
                    continue;
                }
                o.x = ux / TILE + reactiveOffsetX * audioMove;
                o.z = uy / TILE + reactiveOffsetY * audioMove;
                o.y = cached.baseY + _unit3DFlightHeight(u, cached.activity);
                o.walkPhase = _unit3DWalkPhase(u, cached.activity);
                // A unit's own light changes only with ticks (or the viewer).
                if (cached.sourceLightTick !== gameTime || cached.sourceLightPlayer !== localPlayerId) {
                    cached.sourceLight = getVisualUnitSourceLight(u);
                    cached.sourceLightTick = gameTime;
                    cached.sourceLightPlayer = localPlayerId;
                }
                _relight3DObject(o, u, cached.tint, cached.sideTint, !!objects.flat2d, cached.sourceLight);
                objects.push(o);
                if (!flat2d) pushUnitMotionFx(u, o.x, o.z, footprint, o.scaleY);
                if (layerBuilding) layerCollect(u, footprint, audioMove);
                if (unitVis) cached.sigW = unitVis.sig[unitVis.order[ui]];
                continue;
            }
            // Mounts (pony, winged horses) carry a rider: larger than a lone figure.
            let modelScale = u.unitType === 'fast' ? 1.35 : u.unitType === 'scout' ? 1.2 : u.unitType === 'flying' ? 1.3
                : u.isFlying ? 0.8 : 1;
            let mounted = MOUNTED_UNIT_TYPES.has(u.unitType);
            // The mounted panel is the unit's canonical 2D rendering at every LOD.
            // The shared status texture remains only a short-lived fallback while a
            // newly visible exact texture is rasterized within the frame budget.
            let unitSideColor = UNIT_3D_BODY_COLORS[u.unitType]
                || ((BASE_UNIT_STATS[u.unitType] || BASE_UNIT_STATS.norm).color || null);
            let activity = getUnit3DActivity(u);
            let moved = activity.mode !== 0 || activity.amount > 0;
            let stillSince = moved || !cached ? gameTime : cached.stillSince;
            activity = _unit3DIdleActivity(u, activity, stillSince);
            let unit2DTexture = get3DExact2DTexture(u, true);
            let unitTextureFallback = renderer3dExactTextureFallback;
            let unitStatus = unit2DTexture ? null : get3DUnitTextureStatus(u);
            let facingX = Number(u.vx) || 0, facingY = Number(u.vy) || 0;
            if (activity.target && Number.isFinite(activity.target.x) && Number.isFinite(activity.target.y)) {
                facingX = activity.target.x - u.x; facingY = activity.target.y - u.y;
            }
            let unitTint = get3DDamageFlashTint(u, get3DRenderOwnerColor(u.owner));
            let unitSideTint = get3DDamageFlashTint(u, unitSideColor || get3DRenderOwnerColor(u.owner));
            let baseY = getUnitHeightOffset(u);
            push3DRenderObject(objects, {
                modelKey: `unit_${u.unitType || 'norm'}`,
                x: ux / TILE + reactiveOffsetX * audioMove,
                y: baseY + _unit3DFlightHeight(u, activity),
                z: uy / TILE + reactiveOffsetY * audioMove,
                scaleX: footprint * modelScale,
                scaleY: (mounted ? footprint * MOUNT_HEIGHT_RATIO : Math.max(0.48, footprint * 1.45)) * (1 + audioHeight) * modelScale,
                scaleZ: footprint * modelScale,
                visibilitySource: u,
                rotationY: Math.atan2(facingX, facingY || 0.0001),
                moveAmount: activity.amount || Math.min(1, Math.hypot(u.x - u.prevX, u.y - u.prevY) / Math.max(.01, TILE * .025)),
                walkPhase: _unit3DWalkPhase(u, activity),
                animationMode: activity.mode,
                weaponType: getUnit3DWeaponType(u),
                // Flyers show altitude instead; mounts keep their proportions.
                preserveModelHeight: !!u.isFlying || mounted,
                isFlying: !!u.isFlying,
                isWorker: !!u.isWorker,
                tint: unitTint,
                renderShape: 'cylinder',
                topTextureKey: unit2DTexture ? unit2DTexture._renderer3DExactKey : `unit:${u.unitType}:${u.owner}:${unitStatus.keySuffix}`,
                topTextureCanvas: unit2DTexture || get3DUnitTopTexture(u, u.owner, unitStatus),
                statusTextureCanvas: u._historyGhost ? null : get3DStatusTexture(getUnit3DStatusState(u, activity)),
                sideTint: unitSideTint,
            });
            u._r3d = ({ object: objects[objects.length - 1], tick: gameTime, refreshTick: gameTime, view: view3DKey, label: !flat2d && shouldShowUnitLevels(u), activity, stillSince, baseY,
                textureVersion: objects[objects.length - 1].topTextureCanvas && objects[objects.length - 1].topTextureCanvas._textureVersion,
                tint: unitTint, sideTint: unitSideTint, dynamic: !unit2DTexture || unitTextureFallback || !!getDamageFlashState(u) });
            if (!flat2d) {
                let o = objects[objects.length - 1];
                pushUnitMotionFx(u, o.x, o.z, footprint, o.scaleY);
            }
            if (layerBuilding) layerCollect(u, footprint, audioMove);
        }
        if (unitVis && u._r3d) u._r3d.sigW = unitVis.sig[unitVis.order[ui]];
    }

    _ph = _r3dPhase(layerBuilding ? 'unitsBuild' : 'unitsReuse', _ph);
    if (buildPreview && !flat2d) buildPreview.modelShown = _pushBuildPreview3DObject(objects, buildPreview);
    if (flat2d) drainFlatObjects();
    // Shots, debris, attacks and laser fences: GPU effect instances.
    buildFrameEffects(projectiles, particles, towers);
    endFrameEffects();

    _ph = _r3dPhase('effects', _ph);
    if (!staticReuse) for (let [key, state] of renderer3dOverlapFadeState) {
        if (activeOverlapFadeKeys.has(key)) continue;
        let idleMs = overlapNowMs - (Number(state && state.lastSeenMs) || overlapNowMs);
        if (idleMs > RENDERER3D_OVERLAP_FADE_DURATION_MS) {
            renderer3dOverlapFadeState.delete(key);
        }
    }

    return {
        flat2d,
        staticLayer: staticLayer ? { version: staticLayer.version, objects: staticLayer.objects } : null,
        unitLayer: unitLayer ? { version: unitLayer.version, objects: unitLayer.objects, alpha,
            flyTime: ((gameTime + alpha) / Math.max(1, TICK_RATE)) % UNIT_LAYER_FLY_PERIOD } : null,
        viewportWidth: viewW,
        viewportHeight: viewH,
        viewPad: getRenderViewPad(),
        worldWidth: GRID_W,
        worldHeight: GRID_H,
        backgroundCanvas: backgroundCanvasFor3D,
        backgroundVersion: backgroundVersionFor3D,
        fogCanvas: fullVisibility ? null : _visibilityMaskCanvas,
        fogVersion: _visibilityMaskCanvas ? _visibilityMaskCanvas._visibilityContentVersion || 0 : 0,
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
        objects,
        flatBatch,
        fx: fxBatch
    };
}

function drawInteractionOverlay(renderer3dSnapshot = null) {
    if (!overlayCtx || !overlayCanvas) return;
    const o = renderer3dSnapshot && renderer3dSnapshot.overlays;
    const hasContent = !!((isBoxSelecting && selectionBoxScreen)
        || (renderer3dSnapshot && renderer3dSnapshot.buildPreview)
        || (o && !o.groundLinesRendered && o.lines && o.lines.length)
        || (o && ['rects', 'areaTiles', 'rings', 'markers', 'bars', 'texts'].some(key => o[key] && o[key].length)));
    if (!hasContent && overlayCanvas._interactionEmpty) return;
    let dpr = window.devicePixelRatio || 1;
    let pad = overlayCanvas._viewPad || 0;
    overlayCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    overlayCtx.clearRect(0, 0, viewW + 2 * pad, viewH + 2 * pad);
    overlayCanvas._interactionEmpty = !hasContent;
    if (!hasContent) return;

    if (renderer3dInstance && renderer3dSnapshot && renderer3dSnapshot.overlays && typeof renderer3dInstance.drawOverlay === 'function') {
        renderer3dInstance.drawOverlay(renderer3dSnapshot.overlays, overlayCtx);
        if (renderer3dSnapshot.buildPreview && typeof renderer3dInstance.drawBuildPreview === 'function') {
            renderer3dInstance.drawBuildPreview(renderer3dSnapshot.buildPreview, overlayCtx);
        }
    }

    if (isBoxSelecting && selectionBoxScreen) {
        let sx = Math.min(selectionBoxScreen.sx, selectionBoxScreen.ex) + pad;
        let sy = Math.min(selectionBoxScreen.sy, selectionBoxScreen.ey) + pad;
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
    let gpuEnabled = !!(renderer3dInstance && renderer3dInstance.supported);
    if (gameArea) gameArea.classList.toggle('render-mode-3d', gpuEnabled);
    renderer3dHost = renderer3dHost || document.getElementById('renderer3d-host');
    if (renderer3dHost) renderer3dHost.style.opacity = gpuEnabled ? '1' : '0';
    let btn2d = document.getElementById('btn-view-2d');
    let btn3d = document.getElementById('btn-view-3d');
    if (btn2d) btn2d.classList.toggle('active', renderDimensionMode === '2d');
    if (btn3d) btn3d.classList.toggle('active', renderDimensionMode === '3d');
    if (renderer3dInstance) renderer3dInstance.setEnabled(gpuEnabled);
}

function ensure3DRendererInitialized() {
    if (renderer3dInstance) return renderer3dInstance.supported ? renderer3dInstance : null;
    renderer3dHost = renderer3dHost || document.getElementById('renderer3d-host');
    if (!renderer3dHost || !window.Defence3Renderer3D) return null;
    renderer3dInstance = new window.Defence3Renderer3D({
        mount: renderer3dHost
    });
    const renderer = renderer3dInstance;
    renderer.canvas.addEventListener('webglcontextlost', event => {
        event.preventDefault(); renderer.supported = false;
    });
    renderer.canvas.addEventListener('webglcontextrestored', () => {
        if (renderer3dInstance !== renderer) return;
        clearRendererTransientVisualCaches();
        renderer.canvas.remove();
        renderer3dInstance = null;
        ensure3DRendererInitialized();
    });
    renderer3dInstance.setEnabled(true);
    syncRenderModeUi();
    _applyRenderViewPad();
    return renderer3dInstance.supported ? renderer3dInstance : null;
}

function setRenderDimensionMode(nextMode) {
    let normalized = nextMode === '3d' ? '3d' : '2d';
    if (renderDimensionMode === normalized) return;
    renderer3dRotateDrag = null;
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
    const getMinimapTilePixelBounds = (startX, endX, y) => {
        let left = Math.round(startX * scale);
        let right = Math.round(endX * scale);
        let top = Math.round(y * scale);
        let bottom = Math.round((y + 1) * scale);
        if (right <= left) right = left + Math.max(1, Math.round(tilePx));
        if (bottom <= top) bottom = top + Math.max(1, Math.round(tilePx));
        return {
            left,
            top,
            width: right - left,
            height: bottom - top,
        };
    };
    const drawCell = (gx, gy, color) => {
        setFill(color);
        let bounds = getMinimapTilePixelBounds(gx, gx + 1, gy);
        c.fillRect(bounds.left, bounds.top, bounds.width, bounds.height);
    };
    const drawRun = (startX, endX, y, color) => {
        if (endX <= startX) return;
        setFill(color);
        let bounds = getMinimapTilePixelBounds(startX, endX, y);
        c.fillRect(bounds.left, bounds.top, bounds.width, bounds.height);
    };

    for (let t of towers) drawCell(t.gx, t.gy, get3DRenderOwnerColor(t.owner));
    for (let b of barracks) drawCell(b.gx, b.gy, get3DRenderOwnerColor(b.owner));
    for (let s of collectorSpawners) drawCell(s.gx, s.gy, get3DRenderOwnerColor(s.owner));

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
                    drawRun(runStart, x, y, (typeof get3DRenderOwnerColor === 'function' ? get3DRenderOwnerColor(runOwner) : '#c8ced8') + '4d');
                    runStart = x;
                    runOwner = owner;
                }
            } else if (runStart >= 0) {
                drawRun(runStart, x, y, (typeof get3DRenderOwnerColor === 'function' ? get3DRenderOwnerColor(runOwner) : '#c8ced8') + '4d');
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

// The minimap only needs a few updates a second. Redraw it immediately when
// the camera moves (so the viewport box tracks panning), otherwise at ~10 Hz.
let _minimapLastDrawMs = -Infinity;
let _minimapLastCameraKey = '';
let _minimapContentCanvas = null;
let _minimapContentGrid = null;
let _minimapContentMode = '';
let _minimapContentTick = -1;
let _minimapUnitCanvas = null;
let _minimapUnitPixels = null;
function drawMinimap() {
    let nowMs = performance.now();
    let scale = MINIMAP_SIZE / GRID_W; // 2 px per tile
    const mode = localPlayerId + '|' + fullVisibility + '|' + teamVisibilityHistory;
    if (!_minimapContentCanvas) {
        _minimapContentCanvas = document.createElement('canvas');
        _minimapContentCanvas.width = _minimapContentCanvas.height = MINIMAP_SIZE;
    }
    if ((gameTime !== _minimapContentTick && nowMs - _minimapLastDrawMs >= 100) || nowMs < _minimapLastDrawMs || _minimapContentGrid !== grid || _minimapContentMode !== mode) {
    _minimapLastDrawMs = nowMs; _minimapContentGrid = grid; _minimapContentMode = mode;
    _minimapContentTick = gameTime;
    const minimapCtx = _minimapContentCanvas.getContext('2d');
    const units = getLiveRenderView().units;
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

    const getMinimapTilePixelBounds = (startX, endX, y) => {
        let left = Math.round(startX * scale);
        let right = Math.round(endX * scale);
        let top = Math.round(y * scale);
        let bottom = Math.round((y + 1) * scale);
        if (right <= left) right = left + Math.max(1, Math.round(tilePx));
        if (bottom <= top) bottom = top + Math.max(1, Math.round(tilePx));
        return {
            left,
            top,
            width: right - left,
            height: bottom - top,
        };
    };

    const drawMinimapRun = (startX, endX, y, color) => {
        if (endX <= startX) return;
        setMinimapFill(color);
        let bounds = getMinimapTilePixelBounds(startX, endX, y);
        minimapCtx.fillRect(bounds.left, bounds.top, bounds.width, bounds.height);
    };

    // Draw base minimap immediately so dynamic overlays (fog/units/alerts) stay visible on top.
    minimapCtx.drawImage(_minimapStaticCanvas, 0, 0);

    // Unknown areas
    if (!fullVisibility && vis.length > 0) {
        for (let y = 0; y < GRID_H; y++) {
            let row = vis[y];
            let runStart = 0, runState = -1;
            for (let x = 0; x <= GRID_W; x++) {
                let state = x === GRID_W ? -1 : row && row[x] > 0 ? 0
                    : teamVisibilityHistory && visibilityHistoryState && visibilityHistoryState.explored[y * GRID_W + x] ? 1 : 2;
                if (state !== runState) {
                    if (runState > 0) drawMinimapRun(runStart, x, y, runState === 1 ? 'rgba(0,0,0,0.77)' : '#000');
                    runStart = x; runState = state;
                }
            }
        }
    }

    // At army scale, compose directly into minimap pixels. Overlapping units
    // no longer issue hundreds of thousands of Canvas draw commands.
    if (units.length > 5000) {
        if (!_minimapUnitCanvas) {
            _minimapUnitCanvas = document.createElement('canvas');
            _minimapUnitCanvas.width = _minimapUnitCanvas.height = MINIMAP_SIZE;
            _minimapUnitPixels = _minimapUnitCanvas.getContext('2d').createImageData(MINIMAP_SIZE, MINIMAP_SIZE);
        }
        const pixels = _minimapUnitPixels.data, colors = new Map();
        pixels.fill(0);
        const F = (!teamVisibilityHistory || fullVisibility) && typeof simClientCurrentUnitVis === 'function' ? simClientCurrentUnitVis() : null;
        for (let i = 0; i < units.length; i++) {
            const u = F ? null : units[i], slot = F ? F.order[i] : 0;
            if (F ? F.energy[slot] <= 0 : u.dead) continue;
            const ux = F ? F.x[slot] : u.x, uy = F ? F.y[slot] : u.y, owner = F ? F.owner[slot] : u.owner;
            const ghost = !F && u._historyGhost;
            const gx = Math.floor(ux / TILE), gy = Math.floor(uy / TILE);
            if (!fullVisibility && (!vis[gy] || vis[gy][gx] === 0) && !ghost) continue;
            const x = Math.floor(ux / TILE * scale), y = Math.floor(uy / TILE * scale);
            if (x < 0 || y < 0 || x >= MINIMAP_SIZE || y >= MINIMAP_SIZE) continue;
            let color = colors.get(owner);
            if (!color) { color = _parseHexColor(get3DRenderOwnerColor(owner)); colors.set(owner, color); }
            const o = (y * MINIMAP_SIZE + x) * 4;
            pixels[o] = color.r; pixels[o + 1] = color.g; pixels[o + 2] = color.b; pixels[o + 3] = ghost ? 59 : 255;
        }
        _minimapUnitCanvas.getContext('2d').putImageData(_minimapUnitPixels, 0, 0);
        minimapCtx.drawImage(_minimapUnitCanvas, 0, 0);
    } else for (let u of units) {
        if (u.dead) continue;
        let cgy = Math.floor(u.y / TILE), cgx = Math.floor(u.x / TILE);
        if (!fullVisibility && (!vis[cgy] || vis[cgy][cgx] === 0) && !u._historyGhost) continue;
        minimapCtx.globalAlpha = u._historyGhost ? .23 : 1;
        setMinimapFill(get3DRenderOwnerColor(u.owner));
        let ux = (u.x / TILE) * scale, uy = (u.y / TILE) * scale;
        minimapCtx.fillRect(ux, uy, 2, 2);
    }

    minimapCtx.globalAlpha = 1;
    }
    // Camera/alerts update every frame without rescanning units or fog.
    minimapCtx.clearRect(0, 0, MINIMAP_SIZE, MINIMAP_SIZE);
    minimapCtx.drawImage(_minimapContentCanvas, 0, 0);
    // Damage alerts (minimap only)
    drawMinimapAlerts(minimapCtx, scale);

    // Camera viewport: exact ground-frustum footprint in 3D, rectangle in 2D.
    minimapCtx.strokeStyle = '#fff'; minimapCtx.lineWidth = 1;
    let drew3DFrustum = false;
    if (
        renderDimensionMode === '3d' &&
        renderer3dInstance &&
        typeof renderer3dInstance.getGroundFrustumPolygon === 'function'
    ) {
        let footprint = renderer3dInstance.getGroundFrustumPolygon(get3DProjectionSnapshot(), true);
        if (footprint && footprint.length >= 3) {
            minimapCtx.beginPath();
            minimapCtx.moveTo(footprint[0].x * scale, footprint[0].y * scale);
            for (let i = 1; i < footprint.length; i++) {
                minimapCtx.lineTo(footprint[i].x * scale, footprint[i].y * scale);
            }
            minimapCtx.closePath();
            minimapCtx.stroke();
            drew3DFrustum = true;
        }
    }
    if (!drew3DFrustum) {
        let vw = viewW / camera.zoom, vh = viewH / camera.zoom;
        minimapCtx.strokeRect(camera.x / TILE * scale, camera.y / TILE * scale, vw / TILE * scale, vh / TILE * scale);
    }
}

function isTileVisible(gx, gy) {
    return fullVisibility || (visibilityGrid[gy] && visibilityGrid[gy][gx] > 0);
}

function createEmptyVisibilityGrid() {
    let vis = new Array(GRID_H);
    for (let y = 0; y < GRID_H; y++) vis[y] = new Float32Array(GRID_W);
    return vis;
}

let visibilityIncludedTilesScratch = [];
let visibilityStampScratch = [];
let visibilityRowSpanMinScratch = new Int32Array(0), visibilityRowSpanMaxScratch = new Int32Array(0);
function _getVisibilityFloorItemCandidates() {
    return getCellItemsRowMajor();
}

// sources/sourceLength: the player's sources as (world x, world y, range)
// triples, in enumeration order (see _buildVisibilitySourceLists); without
// them the world is scanned for the player's sources.
function computeVisibilityGridForPlayer(playerId, vis, sources = null, sourceLength = 0) {
    for (let y = 0; y < GRID_H; y++) vis[y].fill(0);

    let areaRangeBySourceArea = new Map();
    // let shouldLog = isMultiplayer && !isHost && (gameTime % 60 === 0);
    // let shouldLog = isMultiplayer && (gameTime % 60 === 0);
    // Scratch only: never retained by a player grid or used outside this call.
    let includedTiles = visibilityIncludedTilesScratch;
    if (includedTiles.length !== GRID_H || (GRID_H > 0 && includedTiles[0].length !== GRID_W)) {
        includedTiles = Array.from({ length: GRID_H }, () => new Uint8Array(GRID_W));
        visibilityIncludedTilesScratch = includedTiles;
    } else {
        for (let y = 0; y < GRID_H; y++) includedTiles[y].fill(0);
    }
    let stampSource = (gx, gy, rangeTiles) => {
        let x = Math.floor(Number(gx));
        let y = Math.floor(Number(gy));
        let range = Math.max(0, Number(rangeTiles) || 0);
        if (x < 0 || x >= GRID_W || y < 0 || y >= GRID_H || !(range > 0)) return;
        if (range > vis[y][x]) vis[y][x] = range;
    };
    let includeFallbackCircleAroundSource = (gx, gy, rangeTiles) => {
        let cx = Math.floor(Number(gx));
        let cy = Math.floor(Number(gy));
        let r = Math.max(0, Math.ceil(Number(rangeTiles) || 0));
        if (cx < 0 || cx >= GRID_W || cy < 0 || cy >= GRID_H || !(r > 0)) return;
        let minY = Math.max(0, cy - r);
        let maxY = Math.min(GRID_H - 1, cy + r);
        let minX = Math.max(0, cx - r);
        let maxX = Math.min(GRID_W - 1, cx + r);
        let r2 = r * r;
        for (let y = minY; y <= maxY; y++) {
            let dy = y - cy;
            let row = includedTiles[y];
            for (let x = minX; x <= maxX; x++) {
                let dx = x - cx;
                if ((dx * dx + dy * dy) <= r2) row[x] = 1;
            }
        }
    };
    let hasSource = false;
    // Stamped tiles (source tile and range): only tiles within a stamp's
    // range of it can end up lit, which bounds the sweeps below.
    let stamps = visibilityStampScratch, stampCount = 0;
    let addWorldVisibilitySource = (wx, wy, rangeArea) => {
        hasSource = true;
        let x = Number(wx);
        let y = Number(wy);
        let range = Math.max(0, Number(rangeArea) || 0);
        let areaId = getAreaIdAtWorld(x, y);
        let rangeTiles = range * AREA_UNIT_TILE_EQUIVALENT;
        addVisibilitySourceAreas(areaRangeBySourceArea, x, y, range, vis);
        if (!(range > 0) || !Number.isFinite(x) || !Number.isFinite(y)) return;
        stamps[stampCount++] = Math.floor(x / TILE);
        stamps[stampCount++] = Math.floor(y / TILE);
        stamps[stampCount++] = rangeTiles;
        stampSource(x / TILE, y / TILE, rangeTiles);
        if (areaId < 0) {
            includeFallbackCircleAroundSource(x / TILE, y / TILE, rangeTiles);
        }
    };

    let shouldRevealForPlayer = (owner, watched, watchedByTeam) => {
        let ownerId = Math.floor(Number(owner));
        let targetId = Math.floor(Number(playerId));
        return ownerId === targetId || ((Number(watched) || 0) > 0 && Math.floor(Number(watchedByTeam)) === targetId);
    };

    if (sources) for (let i = 0; i < sourceLength; i += 3) addWorldVisibilitySource(sources[i], sources[i + 1], sources[i + 2]);
    else for (let u of units) {
        if (!u || u.dead) continue;
        if (!shouldRevealForPlayer(u.owner, u.watched || 0, u.watchedByTeam)) continue;
        let visionArea = getEntityEffectiveVisibilityRangeArea(u);
        addWorldVisibilitySource(u.x, u.y, visionArea);
    }
    if (!sources) {
    for (let t of towers) {
        if (!t || !(t.energy > 0) || t.underConstruction) continue;
        if (!shouldRevealForPlayer(t.owner, t.watched || 0, t.watchedByTeam)) continue;
        addWorldVisibilitySource(t.x, t.y, getEntityEffectiveVisibilityRangeArea(t));
    }
    for (let b of barracks) {
        if (!b || !(b.energy > 0) || b.underConstruction) continue;
        if (!shouldRevealForPlayer(b.owner, b.watched || 0, b.watchedByTeam)) continue;
        addWorldVisibilitySource(b.x, b.y, getEntityEffectiveVisibilityRangeArea(b));
    }
    for (let s of collectorSpawners) {
        if (!s || !(s.energy > 0) || s.underConstruction) continue;
        if (!shouldRevealForPlayer(s.owner, s.watched || 0, s.watchedByTeam)) continue;
        addWorldVisibilitySource(s.x, s.y, getEntityEffectiveVisibilityRangeArea(s));
    }
    const revealFloorItem = (cell, x, y) => {
        if (!cell || !cell.item || !(cell.item.energy > 0) || cell.item.underConstruction) return;
        if (!shouldRevealForPlayer(cell.owner, cell.item.watched || 0, cell.item.watchedByTeam)) return;
        addWorldVisibilitySource(x * TILE + TILE * 0.5, y * TILE + TILE * 0.5, getEntityEffectiveVisibilityRangeArea(cell.item));
    };
    if (typeof _activeTileEntities !== 'undefined') {
        // The live tile index includes floor items; avoid a world scan for
        // every player's visibility. Source stamping is an order-independent max.
        // Most indexed entities are resource mines, which are never cell items;
        // keep the floor-item subset per index version rather than per player.
        for (let item of _getVisibilityFloorItemCandidates()) {
            let cell = grid[item.gy] && grid[item.gy][item.gx];
            if (cell && cell.item === item) revealFloorItem(cell, item.gx, item.gy);
        }
    } else {
        for (let y = 0; y < GRID_H; y++) for (let x = 0; x < GRID_W; x++) revealFloorItem(grid[y][x], x, y);
    }
    }

    // Players without sources (empty slots, eliminated teams) see nothing;
    // the grid is already cleared, so skip the union and both sweeps.
    if (!hasSource) return;

    // The range caches contain whole areas. Union area ids first so hundreds
    // of overlapping sources do not repeatedly walk the same tile arrays.
    let includedAreas = new Set();
    for (let [areaId, rangeArea] of areaRangeBySourceArea) {
        let areaIds = getAreaIdsWithinDistance(areaId, Math.floor(Math.max(0, Number(rangeArea) || 0)));
        for (let targetAreaId of areaIds) {
            if (includedAreas.has(targetAreaId)) continue;
            includedAreas.add(targetAreaId);
            let cells = gridCellsByArea[targetAreaId] || [];
            for (let cell of cells) {
                if (cell) includedTiles[cell.y][cell.x] = 1;
            }
        }
    }

    // Values fall by one per tile away from a stamp (the source tile, or a
    // border tile of its +-0.3 window, with the same range), so a tile more
    // than ceil(range) + 1 tiles from every source stays 0. Sweep only each
    // row's [min, max] span of such tiles; every other tile is already 0,
    // like non-included tiles, which the sweeps also clear inside the spans.
    // Tiles outside the spans read as 0 in both passes, as after full sweeps.
    let spanMin = visibilityRowSpanMinScratch, spanMax = visibilityRowSpanMaxScratch;
    if (spanMin.length !== GRID_H) {
        spanMin = visibilityRowSpanMinScratch = new Int32Array(GRID_H).fill(GRID_W);
        spanMax = visibilityRowSpanMaxScratch = new Int32Array(GRID_H).fill(-1);
    }
    let spanY0 = GRID_H, spanY1 = -1;
    for (let i = 0; i < stampCount; i += 3) {
        let reach = Math.ceil(stamps[i + 2]) + 1;
        let x0 = Math.max(0, stamps[i] - reach), x1 = Math.min(GRID_W - 1, stamps[i] + reach);
        let y0 = Math.max(0, stamps[i + 1] - reach), y1 = Math.min(GRID_H - 1, stamps[i + 1] + reach);
        if (x0 > x1 || y0 > y1) continue;
        if (y0 < spanY0) spanY0 = y0;
        if (y1 > spanY1) spanY1 = y1;
        for (let y = y0; y <= y1; y++) {
            if (x0 < spanMin[y]) spanMin[y] = x0;
            if (x1 > spanMax[y]) spanMax[y] = x1;
        }
    }
    let lastX = GRID_W - 1;
    // Forward pass: left, up-left, up and up-right neighbours (-1 per tile).
    for (let y = spanY0; y <= spanY1; y++) {
        if (spanMax[y] < 0) continue;
        let row = vis[y], includedRow = includedTiles[y];
        let hasPrev = y > 0;
        let prevRow = hasPrev ? vis[y - 1] : null, prevIncluded = hasPrev ? includedTiles[y - 1] : null;
        for (let x = spanMin[y], end = spanMax[y]; x <= end; x++) {
            if (!includedRow[x]) {
                row[x] = 0;
                continue;
            }
            let v = row[x];
            if (x > 0 && includedRow[x - 1]) { let n = row[x - 1] - 1; if (n > v) v = n; }
            if (hasPrev) {
                if (prevIncluded[x]) { let n = prevRow[x] - 1; if (n > v) v = n; }
                if (x > 0 && prevIncluded[x - 1]) { let n = prevRow[x - 1] - 1; if (n > v) v = n; }
                if (x < lastX && prevIncluded[x + 1]) { let n = prevRow[x + 1] - 1; if (n > v) v = n; }
            }
            row[x] = v;
        }
    }
    // Backward pass: right, down, down-right and down-left neighbours.
    for (let y = spanY1; y >= spanY0; y--) {
        if (spanMax[y] < 0) continue;
        let row = vis[y], includedRow = includedTiles[y];
        let hasNext = y < GRID_H - 1;
        let nextRow = hasNext ? vis[y + 1] : null, nextIncluded = hasNext ? includedTiles[y + 1] : null;
        for (let x = spanMax[y], start = spanMin[y]; x >= start; x--) {
            if (!includedRow[x]) {
                row[x] = 0;
                continue;
            }
            let v = row[x];
            if (x < lastX && includedRow[x + 1]) { let n = row[x + 1] - 1; if (n > v) v = n; }
            if (hasNext) {
                if (nextIncluded[x]) { let n = nextRow[x] - 1; if (n > v) v = n; }
                if (x < lastX && nextIncluded[x + 1]) { let n = nextRow[x + 1] - 1; if (n > v) v = n; }
                if (x > 0 && nextIncluded[x - 1]) { let n = nextRow[x - 1] - 1; if (n > v) v = n; }
            }
            row[x] = v;
        }
        spanMin[y] = GRID_W;
        spanMax[y] = -1;
    }
}

function getVisibilityGridForPlayer(playerId) {
    return getRawVisibilityGridForPlayer(playerId);
}

function getRawVisibilityGridForPlayer(playerId) {
    let pid = Math.floor(Number(playerId));
    if (!Number.isFinite(pid) || pid < 0) pid = localPlayerId;
    // Where the simulation runs, the grid follows the coverage (no rebuild).
    if (_visCoverReady() && pid < _visCover.players) {
        let rows = _visCoverRows(pid);
        visibilityGridRawByPlayerCache.set(pid, rows);
        return rows;
    }

    visibilityCacheTick = gameTime;
    let cachedRaw = visibilityGridRawByPlayerCache.get(pid);
    let stamp = visibilityGridStampByPlayer.get(pid);
    if (cachedRaw && stamp !== undefined && (stamp === gameTime
        || (gameTime > stamp && gameTime - stamp < VISIBILITY_TICK_INTERVAL && (gameTime + pid) % VISIBILITY_TICK_INTERVAL !== 0))) return cachedRaw;
    visibilityGridStampByPlayer.set(pid, gameTime);
    let pool = visibilityGridPoolByPlayer.get(pid);
    if (!pool) visibilityGridPoolByPlayer.set(pid, pool = { grids: [null, null], next: 0, last: null, signature: null, signatureLength: -1,
        areaGrid: null, areaCells: null, misses: 0, skipUntil: -1 });
    // The grid is a pure function of the sources' tile windows and ranges
    // (and the area layout). Idle teams keep identical sources for many
    // ticks: reuse their last grid instead of recomputing it. A team whose
    // sources keep changing skips the comparison for a while.
    let now = typeof gameTime === 'number' ? gameTime : 0;
    // Every player's sources, collected in one pass (updateAllPlayerVisibility).
    let src = null, srcLength = 0;
    if (_visibilitySourceLists === true) _visibilitySourceLists = _buildVisibilitySourceLists();
    if (_visibilitySourceLists) { src = _visibilitySourceLists.lists[pid] || _EMPTY_VISIBILITY_SOURCES; srcLength = _visibilitySourceLists.lengths[pid] || 0; }
    let compare = !(pool.skipUntil > now && pool.skipUntil - now <= VISIBILITY_SIGNATURE_BACKOFF_TICKS);
    let signature = _visibilitySourceSignatureScratch, signatureLength = -1;
    if (compare) {
        if (pool.skipUntil >= 0) { pool.skipUntil = -1; pool.misses = 0; }
        signatureLength = _collectVisibilitySourceSignature(pid, signature, src, srcLength);
        signature = _visibilitySourceSignatureScratch; // may have grown
        let last = pool.last;
        if (last && last.length === GRID_H && (GRID_H === 0 || last[0].length === GRID_W)
            && pool.areaGrid === areaIdGrid && pool.areaCells === gridCellsByArea
            && pool.signatureLength === signatureLength && _visibilitySignaturesEqual(pool.signature, signature, signatureLength)) {
            pool.misses = 0;
            visibilityGridRawByPlayerCache.set(pid, last);
            return last;
        }
        if (++pool.misses >= 2) pool.skipUntil = now + VISIBILITY_SIGNATURE_BACKOFF_TICKS;
    }
    // Alternate two grids per player instead of allocating rows each time;
    // the computation clears the grid, and a grid handed out last tick (e.g.
    // the render grid) stays intact.
    let k = pool.next;
    let rawVis = _visibilityPoolGrid(pool, k, pid);
    pool.next ^= 1;
    // In updateAllPlayerVisibility: computed there, with the other players'
    // grids due this tick, in parallel (sim_parallel.js).
    if (_visibilityJobs && src) _visibilityJobs.push(pid, k);
    else computeVisibilityGridForPlayer(pid, rawVis, src, srcLength);
    if (compare) {
        if (!pool.signature || pool.signature.length < signatureLength) pool.signature = new Float64Array(Math.max(64, signature.length));
        pool.signature.set(signature.subarray(0, signatureLength));
    }
    // Without a comparison the stored signature no longer describes the grid.
    pool.signatureLength = compare ? signatureLength : -1;
    pool.areaGrid = areaIdGrid;
    pool.areaCells = gridCellsByArea;
    pool.last = rawVis;
    visibilityGridRawByPlayerCache.set(pid, rawVis);
    return rawVis;
}

// A player's grid k (of two): rows over one flat Float32Array (in shared
// memory for the parallel jobs, named vis.g.<player>.<k>).
function _visibilityPoolGrid(pool, k, pid) {
    let rows = pool.grids[k];
    if (rows && rows.length === GRID_H && (GRID_H === 0 || rows[0].length === GRID_W)) return rows;
    let flat = typeof simSharedArray === 'function' ? simSharedArray(Float32Array, GRID_W * GRID_H) : new Float32Array(GRID_W * GRID_H);
    rows = new Array(GRID_H);
    for (let y = 0; y < GRID_H; y++) rows[y] = flat.subarray(y * GRID_W, (y + 1) * GRID_W);
    rows._flat = flat;
    pool.grids[k] = rows;
    if (typeof simParallelBind === 'function') simParallelBind('vis.g.' + pid + '.' + k, flat);
    return rows;
}

// Grids due in this updateAllPlayerVisibility call: (player, grid) pairs.
let _visibilityJobs = null;
// The area layout as the visibility kernel reads it (rebuilt when it changes).
let _visibilityKernelAreaKey = null;
function _visibilityKernelAreas() {
    let key = _visibilityKernelAreaKey;
    if (key && key.grid === areaIdGrid && key.cells === gridCellsByArea && key.nb === areaNeighborIds && key.byId === _areaById
        && key.w === GRID_W && key.h === GRID_H) return key.count;
    let W = GRID_W, H = GRID_H;
    let count = Math.max(_areaById.length, gridCellsByArea.length, areaNeighborIds.length);
    let areaGrid = simSharedArray(Int32Array, W * H);
    for (let y = 0; y < H; y++) {
        let row = areaIdGrid[y];
        for (let x = 0; x < W; x++) { let a = row ? Math.floor(Number(row[x])) : -1; areaGrid[y * W + x] = a >= 0 ? a : -1; }
    }
    let nbOff = simSharedArray(Int32Array, count + 1), cellOff = simSharedArray(Int32Array, count + 1), exists = simSharedArray(Uint8Array, count);
    let nbTotal = 0, cellTotal = 0;
    for (let a = 0; a < count; a++) {
        nbTotal += (areaNeighborIds[a] || []).length;
        for (let c of (gridCellsByArea[a] || [])) if (c) cellTotal++;
    }
    let nb = simSharedArray(Int32Array, nbTotal), cells = simSharedArray(Int32Array, cellTotal);
    let j = 0, q = 0;
    for (let a = 0; a < count; a++) {
        nbOff[a] = j; cellOff[a] = q;
        for (let n of (areaNeighborIds[a] || [])) nb[j++] = n;
        for (let c of (gridCellsByArea[a] || [])) if (c) cells[q++] = c.y * W + c.x;
        exists[a] = _areaById[a] ? 1 : 0;
    }
    nbOff[count] = j; cellOff[count] = q;
    for (let [name, arr] of [['vis.areaGrid', areaGrid], ['vis.nbOff', nbOff], ['vis.nb', nb], ['vis.cellOff', cellOff], ['vis.cells', cells], ['vis.areaExists', exists]]) simParallelBind(name, arr);
    _visibilityKernelAreaKey = { grid: areaIdGrid, cells: gridCellsByArea, nb: areaNeighborIds, byId: _areaById, w: W, h: H, count };
    return count;
}
let _visibilityKernelSrc = null, _visibilityKernelSrcOff = null, _visibilityKernelJobs = null;
// Runs the queued grids (the visibility kernel, sim_parallel.js).
function _runVisibilityJobs(jobs) {
    let lists = _visibilitySourceLists;
    let count = _visibilityKernelAreas();
    // Every player's sources, one array; (offset, count) per player.
    let maxPid = 0, total = 0;
    for (let pid = 0; pid < lists.lengths.length; pid++) { if (lists.lengths[pid]) { maxPid = pid; total += lists.lengths[pid]; } }
    for (let j = 0; j < jobs.length; j += 2) maxPid = Math.max(maxPid, jobs[j]);
    if (!_visibilityKernelSrc || _visibilityKernelSrc.length < total) { _visibilityKernelSrc = simSharedArray(Float64Array, Math.max(3072, total * 2)); simParallelBind('vis.src', _visibilityKernelSrc); }
    if (!_visibilityKernelSrcOff || _visibilityKernelSrcOff.length < (maxPid + 1) * 2) { _visibilityKernelSrcOff = simSharedArray(Int32Array, Math.max(64, (maxPid + 1) * 4)); simParallelBind('vis.srcOff', _visibilityKernelSrcOff); }
    if (!_visibilityKernelJobs || _visibilityKernelJobs.length < jobs.length) { _visibilityKernelJobs = simSharedArray(Int32Array, Math.max(64, jobs.length * 2)); simParallelBind('vis.jobs', _visibilityKernelJobs); }
    let src = _visibilityKernelSrc, off = _visibilityKernelSrcOff, at = 0;
    off.fill(0);
    for (let pid = 0; pid <= maxPid; pid++) {
        let n = lists.lengths[pid] || 0;
        off[pid * 2] = at / 3; off[pid * 2 + 1] = n / 3;
        if (n) { src.set(lists.lists[pid].subarray(0, n), at); at += n; }
    }
    _visibilityKernelJobs.set(jobs);
    _simParams[0] = GRID_W; _simParams[1] = GRID_H; _simParams[2] = TILE; _simParams[3] = AREA_UNIT_TILE_EQUIVALENT; _simParams[4] = count;
    simParallelRun(SIM_KERNEL_VISIBILITY, jobs.length / 2);
}

const VISIBILITY_SIGNATURE_BACKOFF_TICKS = 8;
let _visibilitySourceSignatureScratch = new Float64Array(1024);

function _visibilitySignaturesEqual(a, b, length) {
    if (!a) return false;
    for (let i = 0; i < length; i++) if (a[i] !== b[i]) return false;
    return true;
}

// Everything computeVisibilityGridForPlayer reads from one source, in its
// enumeration order: the tiles under the source and its +-0.3 tile window
// (area stamping), and its range. Three numbers per source.
function _collectVisibilitySourceSignature(playerId, out, sources = null, sourceLength = 0) {
    let length = 0;
    if (sources) {
        if (sourceLength > out.length) out = _visibilitySourceSignatureScratch = new Float64Array(Math.max(sourceLength, out.length * 2));
        for (let i = 0; i < sourceLength; i += 3) {
            let fx = sources[i] / TILE, fy = sources[i + 1] / TILE;
            let bx = Math.floor(fx), by = Math.floor(fy);
            out[i] = bx * 4 + (bx - Math.floor(fx - .3)) * 2 + (Math.floor(fx + .3) - bx);
            out[i + 1] = by * 4 + (by - Math.floor(fy - .3)) * 2 + (Math.floor(fy + .3) - by);
            out[i + 2] = Math.max(0, Number(sources[i + 2]) || 0);
        }
        return sourceLength;
    }
    let target = Math.floor(Number(playerId));
    // Same test as computeVisibilityGridForPlayer's shouldRevealForPlayer;
    // the common integer-owner case is decided without coercion.
    let reveals = (e, owner) => owner === target
        ? true
        : (((Number(e.watched) || 0) > 0 && Math.floor(Number(e.watchedByTeam)) === target)
            || (owner !== (owner | 0) && Math.floor(Number(owner)) === target));
    let push = (wx, wy, rangeArea) => {
        if (length + 3 > out.length) {
            let grown = new Float64Array(out.length * 2);
            grown.set(out);
            out = _visibilitySourceSignatureScratch = grown;
        }
        let fx = Number(wx) / TILE, fy = Number(wy) / TILE;
        let bx = Math.floor(fx), by = Math.floor(fy);
        out[length] = bx * 4 + (bx - Math.floor(fx - .3)) * 2 + (Math.floor(fx + .3) - bx);
        out[length + 1] = by * 4 + (by - Math.floor(fy - .3)) * 2 + (Math.floor(fy + .3) - by);
        out[length + 2] = Math.max(0, Number(rangeArea) || 0);
        length += 3;
    };
    for (let u of units) {
        if (!u || u.dead) continue;
        if (u.owner !== target && !(u.watched > 0) && u.owner === (u.owner | 0)) continue;
        if (reveals(u, u.owner)) push(u.x, u.y, getEntityEffectiveVisibilityRangeArea(u));
    }
    for (let list of [towers, barracks, collectorSpawners]) for (let b of list) {
        if (!b || !(b.energy > 0) || b.underConstruction || !reveals(b, b.owner)) continue;
        push(b.x, b.y, getEntityEffectiveVisibilityRangeArea(b));
    }
    for (let item of _getVisibilityFloorItemCandidates()) {
        let cell = grid[item.gy] && grid[item.gy][item.gx];
        if (!cell || cell.item !== item || !(item.energy > 0) || item.underConstruction || !reveals(item, cell.owner)) continue;
        push(item.gx * TILE + TILE * 0.5, item.gy * TILE + TILE * 0.5, getEntityEffectiveVisibilityRangeArea(item));
    }
    return length;
}

// Every player's visibility sources in one pass over the world (instead of
// a pass per player): per player id, (world x, world y, range) triples in
// the enumeration order of computeVisibilityGridForPlayer. An entity reveals
// to its owner and, while watched, to the watching team.
const _EMPTY_VISIBILITY_SOURCES = new Float64Array(0);
// null, true (to be built on first use) or the built lists.
let _visibilitySourceLists = null;
const _visibilitySourceStore = { lists: [], lengths: [] };
function _buildVisibilitySourceLists() {
    let S = _visibilitySourceStore, lists = S.lists, lengths = S.lengths;
    for (let i = 0; i < lengths.length; i++) lengths[i] = 0;
    const pushTo = (pid, wx, wy, range) => {
        let list = lists[pid], n = lengths[pid] || 0;
        if (!list || n + 3 > list.length) {
            let grown = new Float64Array(Math.max(96, list ? list.length * 2 : 0));
            if (list) grown.set(list.subarray(0, n));
            lists[pid] = list = grown;
        }
        list[n] = wx; list[n + 1] = wy; list[n + 2] = range;
        lengths[pid] = n + 3;
    };
    const add = (owner, e, wx, wy) => {
        let p1 = Math.floor(Number(owner));
        let p2 = (Number(e.watched) || 0) > 0 ? Math.floor(Number(e.watchedByTeam)) : -1;
        let ok1 = p1 >= 0 && p1 < 4096, ok2 = p2 >= 0 && p2 < 4096 && p2 !== p1;
        if (!ok1 && !ok2) return;
        let range = getEntityEffectiveVisibilityRangeArea(e);
        if (ok1) pushTo(p1, wx, wy, range);
        if (ok2) pushTo(p2, wx, wy, range);
    };
    for (let u of units) if (u && !u.dead) add(u.owner, u, u.x, u.y);
    for (let list of [towers, barracks, collectorSpawners]) for (let b of list) {
        if (b && b.energy > 0 && !b.underConstruction) add(b.owner, b, b.x, b.y);
    }
    if (typeof _activeTileEntities !== 'undefined') {
        for (let item of _getVisibilityFloorItemCandidates()) {
            let cell = grid[item.gy] && grid[item.gy][item.gx];
            if (!cell || cell.item !== item || !(item.energy > 0) || item.underConstruction) continue;
            add(cell.owner, item, item.gx * TILE + TILE * 0.5, item.gy * TILE + TILE * 0.5);
        }
    } else {
        for (let y = 0; y < GRID_H; y++) for (let x = 0; x < GRID_W; x++) {
            let cell = grid[y][x], item = cell && cell.item;
            if (!item || !(item.energy > 0) || item.underConstruction) continue;
            add(cell.owner, item, x * TILE + TILE * 0.5, y * TILE + TILE * 0.5);
        }
    }
    return S;
}

// ============================================================
// GAMEPLAY VISIBILITY: AREA COVERAGE, KEPT INCREMENTALLY
// ============================================================
// A tile is visible to a player when its area is within range (area steps)
// of an area under the +-0.3 tile window of one of the player's sources.
// Per player and area: how many entries cover it. Buildings keep theirs
// incrementally ((source area, steps) entries, registered when they finish
// or go; a range change is picked up by a staggered sweep). Units' cover is
// recomputed once a tick from where they stand (_visCoverUnits: the
// helpers mark each unit's window areas, then the steps spread over the
// area graph) and counts once per covered area; a unit's own parameters
// (range, player, watching team) are kept by hooks and the sweep, so moving
// costs nothing here. A query is one array read. Every peer runs the same
// hooks, sweeps and recomputes and resets together, so all keep the same
// coverage.
const VIS_COVER_MAX_STEPS = 63;
// Source counts per (player, area, steps) below this live in a typed array;
// longer ranges (a few buildings) in a map.
const VIS_COVER_DENSE_STEPS = 8;
const _visCover = {
    gen: 1, adm: null, areaCount: 0, players: 0,
    cover: [],         // [player] Int32Array(areaCount): covering entries
    steps: [],         // [player] Int8Array(areaCount): the area's range as a source (steps), -1 none
    dense: null,       // Int32Array((player * areaCount + area) * DENSE + steps): sources
    sparse: new Map(), // same key * 64 + steps, for steps >= DENSE
    list: [],          // registered buildings
    syncedTick: -1,
    visual: [],        // [player] rows kept in step with the cover, made on request
    // Units' part (_visCoverUnitsStep), for generation uGen, all shared
    // (SIM_KERNEL_VIS_SEED, SIM_KERNEL_VIS_SPREAD): seeds ([player * areas
    // + area] = stamp << 6 | steps), the areas seeded this stamp (ulist,
    // ucnt), the areas covered at the last run (uprev, uprevn; ust 1: counted
    // in the cover), the last run's change (uplus, uminus, udiff), scratch;
    // the snapshot (vtx, vty, vtkey); uStage: 0 idle, 1 seeds posted, 2 the
    // spread posted; uTick: the tick of the last step.
    uGen: 0, useed: null, ulist: null, ucnt: null, ustamp: 0, urem: null, ust: null, uprev: null, uprevn: null,
    uplus: null, uminus: null, udiff: null, ubufA: null, ubufB: null, ubufC: null, ucur: null, uaok: null,
    vtx: null, vty: null, vtkey: null, uStage: 0, uTick: -1,
};

function resetVisibilityCoverage() {
    _visCover.adm = null;
    _visCover.syncedTick = -1;
}

function _visCoverEnsure() {
    let C = _visCover, n = Math.max(1, players.length), A = areaDistanceMatrix.length;
    if (C.adm === areaDistanceMatrix && C.areaCount === A && C.players === n) return;
    // Entities registered under an older generation count as unregistered.
    C.gen++;
    C.adm = areaDistanceMatrix; C.areaCount = A; C.players = n;
    // (Shared: the combat scan reads it on the helpers.)
    C.cover = Array.from({ length: n }, () => simSharedArray(Int32Array, Math.max(1, A)));
    C.steps = Array.from({ length: n }, () => new Int8Array(A).fill(-1));
    C.dense = new Int32Array(n * A * VIS_COVER_DENSE_STEPS);
    C.sparse = new Map();
    C.list = [];
    C.visual = [];
    C.syncedTick = -1;
}

// Areas `fromSteps`..`toSteps` steps from `area` enter (delta 1) or leave
// (-1) the player's cover.
function _visCoverApplyRing(p, area, fromSteps, toSteps, delta) {
    let C = _visCover, cover = C.cover[p], rows = C.visual[p];
    for (let d = fromSteps; d <= toSteps; d++) {
        let ring = getAreaIdsAtDistance(area, d);
        for (let i = 0; i < ring.length; i++) {
            let a = ring[i], before = cover[a], after = before + delta;
            cover[a] = after;
            if (rows && (before > 0) !== (after > 0)) _visCoverPaintArea(rows, a, after > 0);
        }
    }
}

// Visual rows: a covered area is fully lit (light saturates at the
// normalization range; visibility_history fades it in and out).
function _visCoverPaintArea(rows, area, lit) {
    let cells = gridCellsByArea[area];
    if (!cells) return;
    let v = lit ? VISIBILITY_LIGHT_NORMALIZATION_RANGE : 0;
    for (let c of cells) if (c) rows[c.y][c.x] = v;
}

function _visCoverCount(p, area, steps) {
    let C = _visCover, pa = p * C.areaCount + area;
    return steps < VIS_COVER_DENSE_STEPS ? C.dense[pa * VIS_COVER_DENSE_STEPS + steps] : (C.sparse.get(pa * 64 + steps) || 0);
}

function _visCoverAdd(p, area, steps, delta) {
    let C = _visCover;
    if (!(area >= 0 && area < C.areaCount) || !_areaById[area]) return;
    let pa = p * C.areaCount + area, c;
    if (steps < VIS_COVER_DENSE_STEPS) {
        c = C.dense[pa * VIS_COVER_DENSE_STEPS + steps] += delta;
    } else {
        let key = pa * 64 + steps;
        c = (C.sparse.get(key) || 0) + delta;
        if (c > 0) C.sparse.set(key, c); else C.sparse.delete(key);
    }
    let stepsArr = C.steps[p], old = stepsArr[area], next = old;
    if (delta > 0 && steps > old) next = steps;
    else if (delta < 0 && c <= 0 && steps === old) {
        next = -1;
        for (let h = steps - 1; h >= 0; h--) if (_visCoverCount(p, area, h) > 0) { next = h; break; }
    }
    if (next === old) return;
    stepsArr[area] = next;
    if (next > old) _visCoverApplyRing(p, area, old + 1, next, 1);
    else _visCoverApplyRing(p, area, next + 1, old, -1);
}

function _visCoverApply(e, delta) {
    let steps = e._vsR, id = e._vsListId, areas = id >= 0 ? _sourceAreaListById[id] : null;
    if (steps < 0 || !areas) return;
    for (let i = 0; i < areas.length; i++) {
        if (e._vsP1 >= 0) _visCoverAdd(e._vsP1, areas[i], steps, delta);
        if (e._vsP2 >= 0) _visCoverAdd(e._vsP2, areas[i], steps, delta);
    }
}

// Which of the 3x3 zones of its tile a coordinate pair is in: the zone and
// the tile decide which tiles the +-0.3 tile window covers.
function visWindowZone(wx, wy) {
    let fx = wx / TILE, fy = wy / TILE, rx = fx - Math.floor(fx), ry = fy - Math.floor(fy);
    return (rx < .3 ? 0 : rx < .7 ? 1 : 2) * 3 + (ry < .3 ? 0 : ry < .7 ? 1 : 2);
}

// The sweeps are a safety net behind the hooks (every change is applied
// where it happens): buildings over 128 ticks, units over 512 (a share of
// each a tick, by list position: the same on every peer; at 64/256 they
// cost ~1.5 ms a tick with 200k units and 35k buildings).
const VIS_COVER_SWEEP_TICKS = 128;
// Units' parameters (their range mostly: level and research changes).
const VIS_COVER_UNIT_SWEEP_TICKS = 512;

// Brings one source's registration up to date with the world (a unit: its
// parameters, _visCoverSyncUnit). Buildings are live while on their tile,
// alive and built. A building ranges from the areas under its +-0.3 tile
// window (as ranges are drawn), identified by its tile and zone (`area`).
function _visCoverSync(e, isUnit) {
    if (isUnit) { _visCoverSyncUnit(e); return; }
    let C = _visCover;
    let known = e._vsGen === C.gen;
    let steps = -1, p1 = -1, p2 = -1, area = -1, owner = e.owner, wx = e.x, wy = e.y;
    let gx = e.gx, gy = e.gy;
    let cell = grid[gy] && grid[gy][gx];
    let onTile = !!cell && getTileEntityRef(gx, gy) === e;
    if (onTile && cell.item === e) { owner = cell.owner; wx = gx * TILE + TILE * 0.5; wy = gy * TILE + TILE * 0.5; }
    let active = onTile && e.energy > 0 && !e.underConstruction && Number.isFinite(wx) && Number.isFinite(wy);
    if (active) area = (gy * GRID_W + gx) * 9 + visWindowZone(wx, wy);
    if (active && area >= 0) {
        let range = getEntityEffectiveVisibilityRangeArea(e);
        if (range > 0) {
            steps = Math.min(VIS_COVER_MAX_STEPS, Math.floor(range));
            let o = Math.floor(Number(owner));
            p1 = o >= 0 && o < C.players ? o : -1;
            if (e.watched > 0) {
                let w = Math.floor(Number(e.watchedByTeam));
                if (w >= 0 && w < C.players && w !== p1) p2 = w;
            }
            if (p1 < 0 && p2 < 0) steps = -1;
        }
    }
    if (steps < 0) area = -1;
    if (known && e._vsR === steps && e._vsA === area && e._vsP1 === p1 && e._vsP2 === p2) return;
    if (!known && steps < 0) return;
    // Areas as the id of their shared list (see getSourceAreaListIdAtWorld).
    let listId = steps >= 0 ? getSourceAreaListIdAtWorld(wx, wy) : -1;
    // A new window zone often covers the same areas: only the key changes.
    if (known && listId === e._vsListId && e._vsR === steps && e._vsP1 === p1 && e._vsP2 === p2) { e._vsA = area; return; }
    if (known) _visCoverApply(e, -1);
    else C.list.push(e);
    e._vsGen = C.gen;
    e._vsR = steps; e._vsA = area; e._vsP1 = p1; e._vsP2 = p2;
    e._vsListId = listId;
    _visCoverApply(e, 1);
}

// A unit's parameters as a source (unit state columns: vsGen this
// generation, vsR steps or -1 none, vsP1 its player, vsP2 a watching team,
// vsA 1 while alive and indexed): where it stands is read by the
// recompute, so a move needs nothing here.
function _visCoverSyncUnit(e) {
    const C = _visCover;
    let steps = -1, p1 = -1, p2 = -1;
    const active = !e.dead && e._spatialKey !== undefined;
    if (active) {
        const range = getEntityEffectiveVisibilityRangeArea(e);
        if (range > 0) {
            steps = Math.min(VIS_COVER_MAX_STEPS, Math.floor(range));
            const o = Math.floor(Number(e.owner));
            p1 = o >= 0 && o < C.players ? o : -1;
            if (e.watched > 0) {
                const w = Math.floor(Number(e.watchedByTeam));
                if (w >= 0 && w < C.players && w !== p1) p2 = w;
            }
            if (p1 < 0 && p2 < 0) steps = -1;
        }
    }
    e._vsGen = C.gen; e._vsR = steps; e._vsP1 = p1; e._vsP2 = p2; e._vsA = active ? 1 : 0;
}

// A unit's window moved (slot `s` of the unit state columns `c`): nothing
// to do once its parameters are registered this generation. False when it
// must go through visCoverOnUnitSpatialChanged.
function visCoverSlotWindow(c, s) {
    const C = _visCover;
    return C.syncedTick < 0 || C.adm !== areaDistanceMatrix || c.vsGen[s] === C.gen;
}

// Hooks (simulation code only).
// During the unit phase of a tick (the status pre-pass to the hits) the
// coverage stands still: every unit decides by what was seen at its start,
// whoever moved first (and the kernels, which run before the pass, decide
// as Unit.update would). Buildings' changes wait in _visCoverHeld until it
// ends (units' cover changes only at the recompute).
let _visCoverHold = false;
const _visCoverHeld = new Map();
function visCoverHoldBegin() { _visCoverHold = true; }
function visCoverHoldEnd() {
    _visCoverHold = false;
    if (_visCoverHeld.size === 0) return;
    for (const [e, isUnit] of _visCoverHeld) {
        if (_visCover.syncedTick < 0 || _visCover.adm !== areaDistanceMatrix) break;
        _visCoverSync(e, isUnit);
    }
    _visCoverHeld.clear();
}
function visCoverHoldReset() { _visCoverHold = false; _visCoverHeld.clear(); }
// A unit joined or left the index, changed owner, or its watchers changed.
function visCoverOnUnitSpatialChanged(u) {
    if (_visCover.syncedTick < 0 || _visCover.adm !== areaDistanceMatrix) return;
    _visCoverSyncUnit(u);
}
function visCoverOnBuildingChanged(e) {
    if (!e || _visCover.syncedTick < 0 || _visCover.adm !== areaDistanceMatrix) return;
    if (_visCoverHold) { _visCoverHeld.set(e, false); return; }
    _visCoverSync(e, false);
}
// Any source whose range, watcher or state changed (unit or building).
function visCoverOnEntityChanged(e) {
    if (!e || _visCover.syncedTick < 0 || _visCover.adm !== areaDistanceMatrix) return;
    if (e instanceof Unit) { _visCoverSyncUnit(e); return; }
    if (_visCoverHold) { _visCoverHeld.set(e, false); return; }
    _visCoverSync(e, false);
}

// Per tick: a staggered sweep (1/VIS_COVER_SWEEP_TICKS of the sources:
// ranges, and a guard for the hooks: removal, tile entities set or
// cleared, watch start and end, construction), then the units' cover
// recomputed. After a reset every source is registered at once; every peer
// resets on the same tick (clearGameplayVisibilityCache).
function syncVisibilityCoverage() {
    _visCoverEnsure();
    let C = _visCover;
    let full = C.syncedTick < 0;
    let k = full ? 0 : gameTime % VIS_COVER_SWEEP_TICKS, step = full ? 1 : VIS_COVER_SWEEP_TICKS;
    for (let i = full ? 0 : gameTime % VIS_COVER_UNIT_SWEEP_TICKS, n = units.length, us = full ? 1 : VIS_COVER_UNIT_SWEEP_TICKS; i < n; i += us) {
        let u = units[i];
        if (u) _visCoverSync(u, true);
    }
    for (let list of [towers, barracks, collectorSpawners]) for (let i = k; i < list.length; i += step) {
        if (list[i]) _visCoverSync(list[i], false);
    }
    let items = _getVisibilityFloorItemCandidates();
    for (let i = k; i < items.length; i += step) _visCoverSync(items[i], false);
    // Registered buildings no longer in the world, on the same stagger; the
    // list is compacted once per cycle.
    let list = C.list;
    for (let i = k; i < list.length; i += step) {
        let e = list[i];
        if (e._vsGen === C.gen) _visCoverSync(e, false);
    }
    if (full || k === 0) {
        let w = 0;
        for (let i = 0; i < list.length; i++) {
            let e = list[i];
            if (e._vsGen === C.gen && e._vsR >= 0) list[w++] = e;
            else e._vsGen = 0;
        }
        list.length = w;
    }
    C.syncedTick = gameTime;
    // Units' cover: a tier below the tick (SIM_LANE_T5, see
    // _visCoverUnitsStep); at once after a reset, then the tick's step as
    // usual (whenever the reset's first query came: the steps go by tick).
    if (full) _visCoverUnitsNow();
    _visCoverUnitsStep();
}

// The units' cover, from where every unit stood at a tick: the areas under
// each live, indexed unit's +-0.3 tile window (as getSourceAreaListIdAtWorld)
// get its steps, the most per player and area; then per player the steps
// spread over the area graph, one less per neighbour (an area within
// `steps` of a seed: the rings of _visCoverApplyRing). Each area covered
// counts once in the cover, so a change from last time is one count.
// A tier at 5 per second on the helpers (lane SIM_LANE_T5), every
// VIS_COVER_UNITS_TICKS ticks from phase VIS_COVER_UNITS_PHASE: at phase 0
// the last run's change is counted in the cover (the commit), the units are
// taken (SIM_KERNEL_VIS_SNAP, in parallel) and their seeds posted
// (SIM_KERNEL_VIS_SEED); at phase 2 the spread (SIM_KERNEL_VIS_SPREAD, a job
// per player). So sight follows where units stood up to two periods ago.
// Its inputs are the snapshot and the area layout of its start (the grid
// and graph arrays of a layout are never changed, a new layout gets new
// ones), its outputs counted at fixed ticks: every peer the same.
const VIS_COVER_UNITS_TICKS = 4, VIS_COVER_UNITS_PHASE = 1;
const VIS_COVER_UNITS_LANE = typeof SIM_LANE_T5 === 'number' ? SIM_LANE_T5 : 3;
function _visCoverUnitsStep() {
    const C = _visCover;
    if (C.uTick === gameTime) return;
    C.uTick = gameTime;
    const T = VIS_COVER_UNITS_TICKS, ph = (((gameTime - VIS_COVER_UNITS_PHASE) % T) + T) % T;
    if (ph === 0) { _visCoverUnitsCommit(); _visCoverUnitsPost(); }
    else if (ph === 2) _visCoverUnitsSpreadPost();
}
// After a reset: the whole run at once (the helpers help), counted now.
// (Every peer resets at the same point of a tick; its first query, which
// makes this, may come earlier or later on one than another, but no tick
// runs in between: the same units, the same result. The step of the tick
// is its own: _visCoverUnitsStep, once per tick.)
function _visCoverUnitsNow() {
    _visCoverUnitsDrop();
    _visCoverUnitsPost();
    _visCoverUnitsSpreadPost();
    _visCoverUnitsCommit();
}
// A run in progress is dropped (a reset: every peer at the same tick).
function _visCoverUnitsDrop() {
    simParallelBackgroundWait(VIS_COVER_UNITS_LANE);
    _visCover.uStage = 0;
}
// The tier's arrays for this generation (players and areas); a new
// generation starts with nothing counted.
function _visCoverUnitsAlloc() {
    const C = _visCover, A = C.areaCount, np = C.players, NA = Math.max(1, np * A);
    if (C.uGen === C.gen && C.useed && C.useed.length === NA) return;
    _visCoverUnitsDrop();
    const I32 = n => simSharedArray(Int32Array, Math.max(1, n));
    C.useed = I32(NA); C.ulist = I32(NA); C.ucnt = I32(np);
    C.urem = simSharedArray(Int8Array, NA).fill(-1);
    C.ubufA = I32(NA); C.ubufB = I32(NA); C.ubufC = I32(NA); C.ucur = I32(NA);
    C.ust = simSharedArray(Uint8Array, NA); C.uprev = I32(NA); C.uprevn = I32(np);
    C.uplus = I32(NA); C.uminus = I32(NA); C.udiff = I32(2 * np);
    C.uaok = simSharedArray(Uint8Array, Math.max(1, A));
    for (const [name, arr] of [['vis.useed', C.useed], ['vis.ulist', C.ulist], ['vis.ucnt', C.ucnt], ['vis.urem', C.urem],
        ['vis.ubufA', C.ubufA], ['vis.ubufB', C.ubufB], ['vis.ubufC', C.ubufC], ['vis.ucur', C.ucur], ['vis.ust', C.ust],
        ['vis.uprev', C.uprev], ['vis.uprevn', C.uprevn], ['vis.uplus', C.uplus], ['vis.uminus', C.uminus], ['vis.udiff', C.udiff], ['vt.aok', C.uaok]]) simParallelBind(name, arr);
    C.ustamp = 0; C.uGen = C.gen; C.uStage = 0;
}
// Phase 0: the snapshot and the seeds.
function _visCoverUnitsPost() {
    const C = _visCover, S = typeof _simUnitState !== 'undefined' ? _simUnitState : null;
    _visCoverUnitsAlloc();
    simParallelBackgroundWait(VIS_COVER_UNITS_LANE);
    const n = S ? S.owners.length : 0, A = C.areaCount, np = C.players;
    if (!C.vtx || C.vtx.length < n) {
        const cap = Math.max(1024, n * 2);
        C.vtx = simSharedArray(Float64Array, cap); C.vty = simSharedArray(Float64Array, cap); C.vtkey = simSharedArray(Int32Array, cap);
        simParallelBind('vt.x', C.vtx); simParallelBind('vt.y', C.vty); simParallelBind('vt.key', C.vtkey);
    }
    if (n > 0) {
        const P = _simParams;
        P[0] = n; P[1] = 8192; P[2] = C.gen; P[3] = SIM_SEP_ABSENT;
        simParallelRun(SIM_KERNEL_VIS_SNAP, Math.ceil(n / 8192));
    }
    // The layout as of now (its arrays are its own: see above).
    simParallelBind('vt.agrid', _spatialAreaGridFlat());
    _simAreaCsr();
    simParallelBind('vt.aoff', _simParReg['area.off']); simParallelBind('vt.anb', _simParReg['area.nb']);
    const aok = C.uaok;
    for (let a = 0; a < A; a++) aok[a] = _areaById[a] ? 1 : 0;
    if (++C.ustamp >= (1 << 24)) { C.useed.fill(0); C.ustamp = 1; }
    C.ucnt.fill(0);
    const B = _simBgParamsByLane[VIS_COVER_UNITS_LANE];
    B[0] = n; B[1] = 1024; B[2] = TILE; B[3] = GRID_W; B[4] = GRID_H; B[6] = A; B[7] = np; B[8] = C.ustamp;
    simParallelBackground(SIM_KERNEL_VIS_SEED, Math.ceil(n / 1024), VIS_COVER_UNITS_LANE);
    C.uStage = 1;
}
// Phase 2: the spread, once the seeds are in.
function _visCoverUnitsSpreadPost() {
    const C = _visCover;
    if (C.uStage !== 1 || C.uGen !== C.gen) return;
    simParallelBackgroundWait(VIS_COVER_UNITS_LANE);
    const B = _simBgParamsByLane[VIS_COVER_UNITS_LANE];
    B[0] = C.areaCount; B[1] = C.players; B[2] = C.ustamp;
    simParallelBackground(SIM_KERNEL_VIS_SPREAD, C.players, VIS_COVER_UNITS_LANE);
    C.uStage = 2;
}
// The commit: the run's change counted in the cover (no longer covered
// first, then newly covered).
function _visCoverUnitsCommit() {
    const C = _visCover;
    if (C.uStage === 1) _visCoverUnitsSpreadPost();
    if (C.uStage !== 2 || C.uGen !== C.gen) { C.uStage = 0; return; }
    simParallelBackgroundWait(VIS_COVER_UNITS_LANE);
    C.uStage = 0;
    const A = C.areaCount, D = C.udiff, PL = C.uplus, MI = C.uminus;
    for (let p = 0; p < C.players; p++) {
        const cover = C.cover[p], rows = C.visual[p], base = p * A;
        for (let i = 0, e = D[2 * p + 1]; i < e; i++) { const a = MI[base + i]; if (--cover[a] === 0 && rows) _visCoverPaintArea(rows, a, false); }
        for (let i = 0, e = D[2 * p]; i < e; i++) { const a = PL[base + i]; if (++cover[a] === 1 && rows) _visCoverPaintArea(rows, a, true); }
    }
}

function _visCoverActive() {
    return _visCover.syncedTick >= 0 && _visCover.adm === areaDistanceMatrix;
}

let _visCoverSimContext = false;
// Whether queries here use the coverage. After a reset (resync, new match)
// the simulating context rebuilds it on the first query: the same point on
// every peer.
function _visCoverReady() {
    if (_visCoverActive()) return true;
    if (!_visCoverSimContext) return false;
    syncVisibilityCoverage();
    return true;
}

// Gameplay visibility of a tile from the coverage; null where the coverage
// is not kept (the page, while the simulation runs in a worker).
function _visCoverTileVisible(pid, gx, gy) {
    if (!_visCoverReady()) return null;
    if (gx < 0 || gx >= GRID_W || gy < 0 || gy >= GRID_H) return false;
    if (!(pid >= 0 && pid < _visCover.players)) return false;
    let row = areaIdGrid[gy], a = row ? row[gx] : -1;
    return a >= 0 && _visCover.cover[pid][a] > 0;
}

// A player's visibility rows from the coverage: made on first request, then
// repainted per area as areas enter and leave cover.
function _visCoverRows(pid) {
    let C = _visCover;
    let rows = C.visual[pid];
    if (rows && rows.length === GRID_H) return rows;
    let flat = new Float32Array(GRID_W * GRID_H);
    rows = new Array(GRID_H);
    for (let y = 0; y < GRID_H; y++) rows[y] = flat.subarray(y * GRID_W, (y + 1) * GRID_W);
    rows._flat = flat;
    let cover = C.cover[pid];
    for (let a = 0; a < cover.length; a++) if (cover[a] > 0) _visCoverPaintArea(rows, a, true);
    C.visual[pid] = rows;
    return rows;
}

function isTileActuallyVisibleToPlayer(playerId, gx, gy) {
    if (gx < 0 || gx >= GRID_W || gy < 0 || gy >= GRID_H) return false;
    let pid = Math.floor(Number(playerId));
    if (!Number.isFinite(pid) || pid < 0) pid = localPlayerId;
    let covered = _visCoverTileVisible(pid, gx, gy);
    if (covered !== null) return covered;

    let vis = getRawVisibilityGridForPlayer(pid);
    if (!vis || vis.length !== GRID_H) return false;
    return !!(vis[gy] && vis[gy][gx] > 0);
}

// Gameplay visibility (same on every peer): the match setting, never the
// local spectator view.
function isTileVisibleToPlayer(playerId, gx, gy) {
    if (matchFullVisibility) return true;
    if (gx < 0 || gx >= GRID_W || gy < 0 || gy >= GRID_H) return false;

    let pid = Math.floor(Number(playerId));
    let covered = _visCoverTileVisible(pid, gx, gy);
    if (covered !== null) return covered;
    let vis = getRawVisibilityGridForPlayer(pid);
    if (!vis || vis.length !== GRID_H) return false;
    return !!(vis[gy] && vis[gy][gx] > 0);
}

function isGameplayTargetVisibleToPlayer(playerId, gx, gy) {
    return isTileActuallyVisibleToPlayer(playerId, gx, gy);
}

function updateVisibility(playerId) {
    let targetPlayerId = Math.floor(Number(playerId));
    if (!Number.isFinite(targetPlayerId) || targetPlayerId < 0) targetPlayerId = localPlayerId;
    visibilityGrid = updateVisualVisibility(targetPlayerId, getRawVisibilityGridForPlayer(targetPlayerId));
}

// Every player's gameplay visibility for this tick (see syncVisibilityCoverage).
// Called by gameTick only: the context that runs the simulation keeps the
// coverage; elsewhere (the page beside a simulation worker) queries read
// the grids as before.
function updateAllPlayerVisibility() {
    _visCoverSimContext = true;
    syncVisibilityCoverage();
}


// Advances the simulation clock to `simTime` (frame-clock time) and runs the
// ticks due by then. Network work uses the wall clock.
function processVisibleSimulationFrame(simTime) {
    let now = performance.now();
    sendNetworkPings(now);
    if (document.hidden) {
        _lastTickTime = simTime;
        return;
    }

    if (gameStarted && !gameOver) {
        let dt = simTime - _lastTickTime;
        if (dt > 0) {
            _lastTickTime = simTime;
            // Keep a bounded catch-up budget in ticks even when the shared
            // pace is slow; a fixed 200 ms cap would discard more wall time
            // as the pace drops and falsely report an ever-slower machine.
            let maxGap = Math.max(200, netSimulationTickMs() * 5);
            if (dt > maxGap) dt = maxGap;
            _tickAccumulator += dt;
        }
        _tickAccumulator = pumpSimulationTicks(now, _tickAccumulator, 5);
    }
}

// Runs due ticks. In multiplayer a tick runs only once the host sealed it;
// while it is missing the accumulator holds one tick so it runs on arrival.
// A guest that fell behind the host (hidden tab, slow frame, reconnect) runs
// a few extra ticks per call until it is back to its normal buffer.
function pumpSimulationTicks(now, accumulator, maxTicks) {
    if (isMultiplayer) {
        netMaintain(now);
        netHostUpdateSimulationPace(now);
        driveStrictLockstep(now, currentTick);
        resyncHostFlushHashes(now);
    }
    let catchUp = 0;
    if (isMultiplayer && !isHost) {
        let buffered = getLockstepBufferedTicks();
        // The input pipeline is a future command horizon, not a target amount
        // of already sealed simulation to leave unplayed on this guest. A
        // large pipeline (e.g. 16 ticks) used to permit another ~800 ms of
        // visible lag here, despite the same displayed command delay.
        let normal = 2;
        if (buffered > normal) catchUp = Math.min(buffered - normal, buffered > normal * 4 ? 12 : 3);
    }
    let processed = 0;
    let limit = maxTicks + catchUp;
    let tickMs = netSimulationTickMs();
    while (processed < limit) {
        let due = accumulator >= tickMs;
        if (!due && catchUp <= 0) break;
        if (isMultiplayer && processed > 0) driveStrictLockstep(now, currentTick);
        if (isMultiplayer && !isStrictTickReady(currentTick)) {
            if (due) {
                // Deliberate pauses (start countdown, resync) are not stalls.
                let paused = lockstepResyncPauseActive || matchStartWaitingForReady || lockstepFatalStopActive || (!isHost && lockstepDesyncDetected);
                if (paused) netStallStartedAt = 0;
                else netNoteSimWaiting(true, now);
                if (!waitingForRemoteSince) waitingForRemoteSince = now;
                accumulator = Math.min(accumulator, tickMs);
            }
            break;
        }
        // Simulation worker: a few ticks may be in flight; beyond that the
        // page waits for results rather than queueing more.
        let inWorker = typeof simClientActive === 'function' && simClientActive();
        if (inWorker && simClientInFlight() >= SIM_CLIENT_MAX_IN_FLIGHT + (catchUp > 0 ? 2 : 0)) {
            if (due) accumulator = Math.min(accumulator, tickMs);
            break;
        }
        if (isMultiplayer) {
            // A guest applies a resync patch to the page's copy of the state
            // too: with the worker, once every tick before it has come back.
            // (The host's patches are encoded by the worker, in order.)
            if (inWorker && !isHost && resyncGuest.T === currentTick && !simClientQuiescent()) {
                if (due) accumulator = Math.min(accumulator, tickMs);
                break;
            }
            // Resync patches: the host encodes one, or the guest applies one,
            // in its own frame; the tick runs in the next.
            if (isHost) {
                if (resyncHostBeforeTick(currentTick)) break;
            } else if (resyncGuest.T === currentTick) {
                let hadPatch = !!resyncGuest.patch;
                if (!resyncGuestBeforeTick(currentTick, now)) {
                    if (due) accumulator = Math.min(accumulator, tickMs);
                    break;
                }
                if (hadPatch) break;
            }
        }
        if (due) accumulator -= tickMs;
        else catchUp--;
        if (isMultiplayer) netNoteSimWaiting(false, now);
        waitingForRemoteSince = 0;
        runOneTick();
        processed++;
        if (gameOver) break;
    }
    return accumulator;
}

// CAMERA SLIDE (Settings > Camera slide)
// A frame shows the camera at its frame time, and the browser shows it until
// the next frame is drawn, which a game tick can hold up for 20+ ms. So the
// GPU canvas and the overlay are drawn with a margin around the view, and the
// browser's compositor (its own thread, running at the display rate even
// while the page is busy) slides them at the camera's pan velocity from the
// frame time on. On screen the camera is then where it should be at every
// display refresh; the next frame replaces the slide seamlessly. The margin
// bounds the slide, so a very long stall stops at its edge. Panning only:
// rotation and zoom are not extrapolated.
const CAMERA_SLIDE_PAD_PX = 64;
const CAMERA_SLIDE_MAX_MS = 200;
let cameraSlideEnabled = true;
// Settings > Pixel-snapped camera (2D): each frame is drawn with the camera
// on a whole device pixel, so sprites are not resampled at a different
// sub-pixel phase every frame while panning (shimmer and smear). The camera
// itself keeps its exact position; only drawing rounds it.
let pixelSnapCamera = true;
let _cameraSnapSaved = null;

function _applyRenderCameraSnap() {
    _cameraSnapSaved = null;
    if (!pixelSnapCamera || renderDimensionMode !== '2d') return;
    let px = camera.zoom * (window.devicePixelRatio || 1);
    if (!(px > 0)) return;
    _cameraSnapSaved = { x: camera.x, y: camera.y };
    camera.x = Math.round(camera.x * px) / px;
    camera.y = Math.round(camera.y * px) / px;
}

function _restoreRenderCameraSnap() {
    if (!_cameraSnapSaved) return;
    camera.x = _cameraSnapSaved.x;
    camera.y = _cameraSnapSaved.y;
    _cameraSnapSaved = null;
}
let _cameraSlideAnims = [];
let _cameraSlideActive = false;
// The latest slide (for diagnostics): frame time, duration, warp inputs.
let _cameraSlideLast = null;
// What the current slide starts from: the last drawn frame's view and camera.
let _cameraSlideFrame = null;

// Overscan margin (css px on each side) of the GPU canvas and overlay.
function getRenderViewPad() {
    return cameraSlideEnabled && renderer3dInstance && renderer3dInstance.supported ? CAMERA_SLIDE_PAD_PX : 0;
}

// Sizes and places the padded layers; called on resize and setting changes.
function _applyRenderViewPad() {
    let pad = getRenderViewPad();
    let dpr = window.devicePixelRatio || 1;
    if (overlayCanvas) {
        overlayCanvas.width = Math.round((viewW + 2 * pad) * dpr);
        overlayCanvas.height = Math.round((viewH + 2 * pad) * dpr);
        overlayCanvas.style.width = (viewW + 2 * pad) + 'px';
        overlayCanvas.style.height = (viewH + 2 * pad) + 'px';
        overlayCanvas.style.left = overlayCanvas.style.top = (-pad) + 'px';
        overlayCanvas.style.right = overlayCanvas.style.bottom = 'auto';
        overlayCanvas._viewPad = pad;
        overlayCanvas._interactionEmpty = false;
    }
    renderer3dHost = renderer3dHost || document.getElementById('renderer3d-host');
    if (renderer3dHost) {
        renderer3dHost.style.inset = 'auto';
        renderer3dHost.style.left = renderer3dHost.style.top = (-pad) + 'px';
        renderer3dHost.style.width = (viewW + 2 * pad) + 'px';
        renderer3dHost.style.height = (viewH + 2 * pad) + 'px';
    }
    if (renderer3dInstance) renderer3dInstance.resize(viewW + 2 * pad, viewH + 2 * pad);
    _stopCameraSlide();
}

function setCameraSlideEnabled(on) {
    cameraSlideEnabled = !!on;
    _applyRenderViewPad();
}

function _stopCameraSlide() {
    for (let a of _cameraSlideAnims) a.cancel();
    _cameraSlideAnims = [];
    _cameraSlideActive = false;
    _cameraSlideLast = null;
}

// 3x3 matrix helpers (row-major arrays of 9) for the slide's ground warp.
function _m3mul(a, b) {
    let r = new Array(9);
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) r[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j];
    return r;
}

function _m3inv(m) {
    let [a, b, c, d, e, f, g, h, i] = m;
    let A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
    let det = a * A + b * B + c * C;
    if (!det) return null;
    return [A / det, -(b * i - c * h) / det, (b * f - c * e) / det,
        B / det, (a * i - c * g) / det, -(a * f - c * d) / det,
        C / det, -(a * h - b * g) / det, (a * e - b * d) / det];
}

function _m3apply(m, x, y) {
    let w = m[6] * x + m[7] * y + m[8];
    return [(m[0] * x + m[1] * y + m[2]) / w, (m[3] * x + m[4] * y + m[5]) / w];
}

// Panning moves every ground point by the same world offset, so the drawn
// ground moves by a projective map of the image (a homography: exact for the
// ground plane in perspective, near-exact for what stands on it). A plain
// shift would move near and far ground equally, which in a tilted view makes
// the picture bob between frames.
// Returns the map, in the layers' css px, from the last frame's image to the
// image after the camera moved by (dx, dz) tiles.
function _cameraSlideWarp(base, baseInv, dx, dz) {
    return _m3mul(_m3mul(base, [1, 0, -dx, 0, 1, -dz, 0, 0, 1]), baseInv);
}

function _cssMatrixFromHomography(m) {
    let k = 1 / m[8];
    let f = v => (v * k).toPrecision(9);
    return `matrix3d(${f(m[0])},${f(m[3])},0,${f(m[6])},${f(m[1])},${f(m[4])},0,${f(m[7])},0,0,1,0,${f(m[2])},${f(m[5])},0,1)`;
}

// Called after each drawn frame: records what the slide starts from, then
// builds it (see _buildCameraSlide).
function updateCameraSlide(frameTime) {
    let pad = getRenderViewPad();
    let r3 = renderer3dInstance;
    let flat = renderDimensionMode !== '3d';
    let m = r3 && r3.pickViewProjection;
    if (!(pad > 0) || !gameStarted || document.hidden || !r3 || (!flat && !m)) {
        _cameraSlideFrame = null;
        if (_cameraSlideActive) _stopCameraSlide();
        return;
    }
    // Ground (tile x, tile z) -> layer css px, from the frame just drawn:
    // 2D is a scaled top-down view; 3D uses the drawn frame's projection.
    let W = r3.cssWidth, H = r3.cssHeight, z = camera.zoom;
    let base = flat
        ? [TILE * z, 0, pad - camera.x * z, 0, TILE * z, pad - camera.y * z, 0, 0, 1]
        : _m3mul([W / 2, 0, W / 2, 0, -H / 2, H / 2, 0, 0, 1], [m[0], m[8], m[12], m[1], m[9], m[13], m[3], m[11], m[15]]);
    let baseInv = _m3inv(base);
    if (!baseInv) { _cameraSlideFrame = null; return; }
    let vel = _cameraPanVel, tgt = _cameraPanTarget;
    _cameraSlideFrame = {
        frameTime, base, baseInv, pad, W, H, cx: camera.x, cy: camera.y, v0x: vel.x, v0y: vel.y, tx: tgt.x, ty: tgt.y,
        maxX: WORLD_W - viewW / camera.zoom, maxY: WORLD_H - viewH / camera.zoom
    };
    _buildCameraSlide();
}

// A pan key changed: turn the picture now instead of at the next frame.
function refreshCameraSlideForInput() {
    if (_cameraSlideFrame && getRenderViewPad() > 0) _buildCameraSlide();
}

function _buildCameraSlide() {
    let F = _cameraSlideFrame;
    let inputs = typeof _cameraPanInputs !== 'undefined' ? _cameraPanInputs.slice() : [];
    let moving = F.v0x !== 0 || F.v0y !== 0 || F.tx !== 0 || F.ty !== 0 || inputs.some(i => i.x !== 0 || i.y !== 0);
    let layers = [renderer3dHost, overlayCanvas].filter(Boolean);
    if (!moving || !layers.length || typeof layers[0].animate !== 'function') {
        if (_cameraSlideActive) _stopCameraSlide();
        return;
    }
    // Where the camera will be `sec` after the frame, in tiles from there:
    // updateCamera's own motion model through the key changes so far, each
    // axis stopping where the camera is clamped at the map edge.
    let shift = sec => {
        let r = cameraPanTravel(F.v0x, F.v0y, F.tx, F.ty, F.frameTime, sec, inputs);
        return [Math.max(-F.cx, Math.min(F.maxX - F.cx, r.x)) / TILE, Math.max(-F.cy, Math.min(F.maxY - F.cy, r.y)) / TILE];
    };
    // How long until the view's corners would show past the margin.
    let pad = F.pad, W = F.W, H = F.H;
    let corners = [[pad, pad], [W - pad, pad], [pad, H - pad], [W - pad, H - pad]];
    let reach = sec => {
        let [dx, dz] = shift(sec);
        let inv = _m3inv(_cameraSlideWarp(F.base, F.baseInv, dx, dz));
        if (!inv) return Infinity;
        let worst = 0;
        for (let [x, y] of corners) {
            let [sx, sy] = _m3apply(inv, x, y);
            worst = Math.max(worst, Math.abs(sx - x), Math.abs(sy - y));
        }
        return worst;
    };
    let durMs = CAMERA_SLIDE_MAX_MS;
    for (let i = 0; i < 3; i++) {
        let r = reach(durMs / 1000);
        if (!(r > pad)) break;
        durMs *= pad / r * 0.98;
    }
    if (!(durMs > 1)) { if (_cameraSlideActive) _stopCameraSlide(); return; }
    // Keyframes every ~8 ms: the browser interpolates between them, and the
    // warp is not linear in time.
    let steps = Math.max(2, Math.ceil(durMs / 8));
    let keyframes = [];
    for (let k = 0; k <= steps; k++) {
        let [dx, dz] = shift(durMs / 1000 * k / steps);
        keyframes.push({ offset: k / steps, transform: _cssMatrixFromHomography(_cameraSlideWarp(F.base, F.baseInv, dx, dz)) });
    }
    let next = layers.map(el => {
        let anim = el.animate(keyframes, { duration: durMs, fill: 'forwards', easing: 'linear' });
        // From the frame's own time: the slide covers exactly the time the
        // frame has been, and will be, on screen.
        anim.startTime = F.frameTime;
        return anim;
    });
    for (let a of _cameraSlideAnims) a.cancel();
    _cameraSlideAnims = next;
    _cameraSlideActive = true;
    _cameraSlideLast = { frameTime: F.frameTime, durMs, base: F.base, baseInv: F.baseInv, shift };
}

function processRenderFrame(timestamp) {
    if (!ctx || !canvas || !bgCtx || !minimapCtx) {
        ensureRenderContextsInitialized();
        return;
    }

    // _frameSimLeadMs: how far this frame's time is past the simulation
    // clock (the loop runs ticks after drawing, see _runLoopFrame).
    tickAlpha = (typeof simClientActive === 'function' && simClientActive())
        ? simClientTickAlpha(timestamp)
        : Math.max(0, Math.min((_tickAccumulator + _frameSimLeadMs) / netSimulationTickMs(), 1));
    updateCamera(timestamp);
    _applyRenderCameraSnap();
    let dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    let renderer3dSnapshot = null;
    let renderer3d = ensure3DRendererInitialized();
    if (renderer3d) {
        renderer3dSnapshot = build3DFrameData(renderDimensionMode === '2d');
        renderer3d.setGraphicsOptions(graphicsOptions);
        renderer3d.render(renderer3dSnapshot);
        drawMinimap();
    } else {
        draw();
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
    // Refresh the build menu every ~30 frames (the info panel on its own clock).
    if (++_buildMenuRefreshCounter >= 30) {
        _buildMenuRefreshCounter = 0;
        if (_buildMenuNeedsRefresh) updateBuildMenu();
    }
    _refreshInfoPanelPeriodic(Number.isFinite(timestamp) ? timestamp : performance.now());
    if (typeof updateBottomBar === 'function') updateBottomBar(Number.isFinite(timestamp) ? timestamp : performance.now());
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

// FRAME LOOP
// One steady frame clock drives drawing, camera and unit interpolation:
// browser frames use the rAF timestamp (vsync aligned) and fill-in frames
// (below) use evenly spaced slots between two browser frames. Camera and
// units therefore move by the same amount every frame, even when a frame
// starts a little late, which is what makes panning look locked.
//
// Game ticks run right after a frame is drawn, in their own task, for the
// ticks due by the NEXT frame. A long tick then falls in the gap between
// frames instead of delaying the frame that was about to be shown, and the
// interpolation is exactly what running the tick before the next frame gives.
//
// Frames are always queued again, even after an error, so one bad frame
// cannot freeze the game.
function _scheduleSimulationUpTo(time) {
    if (!(time > _simTargetTime)) return;
    _simTargetTime = time;
    if (_simTaskPosted) return;
    _simTaskPosted = true;
    _simChannel.port2.postMessage(0);
}

let _frameSimLeadMs = 0;
let _frameClock = 0;
let _rafLastTs = 0;
let _rafIntervalMs = 1000 / 60;
const _rafDeltas = [];
let _simTargetTime = 0;
let _simTaskPosted = false;
const _simChannel = new MessageChannel();
_simChannel.port1.onmessage = () => {
    _simTaskPosted = false;
    let t0 = performance.now();
    try { processVisibleSimulationFrame(_simTargetTime); } catch (err) { reportRuntimeError('frame', err); }
    let simMs = performance.now() - t0;
    _simMsEma += (simMs - _simMsEma) * 0.1;
};
// Headless runs (Node): a port with a handler would keep the process alive
// (assigning onmessage references it, so this comes after).
if (_simChannel.port1.unref) { _simChannel.port1.unref(); _simChannel.port2.unref(); }

// Browser frame interval: median of the last 15 gaps, ignoring stalls.
// Steady gaps also teach the display's refresh rate (see getDisplayRefreshRate).
let _rafDisplayKey = '';

function _noteRafTimestamp(ts) {
    let key = _displayKey();
    if (key !== _rafDisplayKey) {
        // Another display: learn its frame interval afresh.
        _rafDisplayKey = key;
        _rafDeltas.length = 0;
        _rafLastTs = 0;
    }
    if (_rafLastTs) {
        let d = ts - _rafLastTs;
        if (d > 2 && d < 60) {
            _rafDeltas.push(d);
            if (_rafDeltas.length > 15) _rafDeltas.shift();
            let sorted = _rafDeltas.slice().sort((x, y) => x - y);
            _rafIntervalMs = sorted[sorted.length >> 1];
            if (sorted.length >= 15 && !document.hidden && sorted[11] - sorted[3] < _rafIntervalMs * 0.12) {
                _learnDisplayRefreshRate(1000 / _rafIntervalMs);
            }
        }
    }
    _rafLastTs = ts;
}

function _runLoopFrame(time, nextTime) {
    time = Math.max(time, _frameClock);
    _frameClock = time;
    _lastRenderFrameAt = performance.now();
    _frameSimLeadMs = gameStarted && !gameOver && !document.hidden ? Math.max(0, time - _lastTickTime) : 0;
    try { processRenderFrame(time); } catch (err) { reportRuntimeError('render', err); }
    _frameSimLeadMs = 0;
    try { updateCameraSlide(time); } catch (err) { reportRuntimeError('render', err); }
    // The slide starts from the drawn (snapped) camera; the camera itself
    // goes back to its exact position.
    _restoreRenderCameraSnap();
    let renderMs = performance.now() - _lastRenderFrameAt;
    _renderMsEma += (renderMs - _renderMsEma) * 0.1;
    _scheduleSimulationUpTo(Math.max(time, nextTime));
}

let _frameCapCredit = 0;
let _frameCapLastTs = 0;

function _rafLoopFrame(ts) {
    _renderFrameHandle = 0;
    _noteRafTimestamp(ts);
    queueRenderFrame();
    // Browser faster than the target (say 120 Hz, target 60): draw on the
    // browser frames that keep the target pace, so every drawn frame is shown for
    // the same number of refreshes. Credit follows the real frame times, so
    // a browser frame delayed by a long tick does not shift the pace.
    let targetMs = 1000 / getTargetFrameRate();
    let gap = _frameCapLastTs ? ts - _frameCapLastTs : _rafIntervalMs;
    _frameCapLastTs = ts;
    if (_rafIntervalMs < targetMs * 0.9) {
        _frameCapCredit = Math.min(_frameCapCredit + gap, targetMs * 2);
        if (_frameCapCredit < targetMs - _rafIntervalMs * 0.5) return;
        _frameCapCredit = Math.max(0, _frameCapCredit - targetMs);
        _planFillInFrames(ts, 0);
        _runLoopFrame(ts, ts + targetMs);
        return;
    }
    _frameCapCredit = 0;
    let slots = _planFillInFrames(ts);
    _runLoopFrame(ts, ts + _rafIntervalMs / (slots + 1));
    scheduleFillInFrame();
}

// Draws one frame now (benchmarks and tools); the loop uses _rafLoopFrame.
function renderFrame(timestamp) {
    let t = Number.isFinite(timestamp) ? timestamp : performance.now();
    _lastRenderFrameAt = performance.now();
    try { processRenderFrame(t); } catch (err) { reportRuntimeError('render', err); }
}

// Browsers pace requestAnimationFrame to what they think the display runs at,
// and Edge/Chrome drop it to 60 in fullscreen after a few seconds. When rAF
// comes slower than the target FPS, extra frames run in between, evenly
// spaced: at 60 Hz with a 120 target one frame goes exactly half way. The
// count is the whole number of target frames that fit (60 -> 144 adds one,
// 60 -> 240 adds three), so steps stay even. When rAF is faster than the
// target, frames are skipped to keep the target pace instead.
//
// Timers are often only as precise as Windows' 15.6 ms tick (on battery for
// example), too coarse to hit 8.3 ms gaps. Then the wait is a timer for the
// part it can cover and MessageChannel hops (not clamped) for the rest, which
// keeps the main thread polling part of the time; hence the setting.
//
// Target (Settings > Target FPS): 'auto' follows the refresh rate of the
// display the window is on, or a fixed common rate. The choice is kept per
// display: browsers may run a 60 Hz display at another display's 120 Hz
// (Chromium vsyncs to one display on some multi-monitor setups), which no web
// API reveals, so picking 60 once on that display fixes it for good, while
// other displays keep their own choice.
const FPS_TARGET_CHOICES = [30, 50, 60, 72, 75, 90, 100, 120, 144, 165, 180, 240, 360];
let fpsTargetByDisplay = {};
function normalizeFpsTargetSetting(v) {
    if (v === 'auto') return 'auto';
    let n = Math.round(Number(v));
    return FPS_TARGET_CHOICES.includes(n) ? n : 'auto';
}

function getFpsTargetSetting() {
    let v = fpsTargetByDisplay[_displayKey()];
    return v === undefined ? 'auto' : v;
}

function setFpsTargetSetting(v) {
    v = normalizeFpsTargetSetting(v);
    if (v === 'auto') delete fpsTargetByDisplay[_displayKey()];
    else fpsTargetByDisplay[_displayKey()] = v;
}

function getTargetFrameRate() {
    let v = getFpsTargetSetting();
    return v === 'auto' ? getDisplayRefreshRate() : v;
}

// Display refresh rate, per display. Browsers slow rAF down (fullscreen,
// battery saver, load) but never run it faster than the display, so the
// fastest steady rate seen on a display is its refresh rate. Displays are told
// apart by their screen geometry, which changes when the window moves to
// another display, and the rates are remembered across page loads so
// fullscreen right after loading still knows a 120 Hz display is 120 Hz.
const LS_DISPLAY_RATES_KEY = 'defence3_display_rates_v1';
const COMMON_REFRESH_RATES = [24, 30, 48, 50, 60, 72, 75, 85, 90, 100, 110, 120, 144, 160, 165, 170, 180, 200, 240, 280, 300, 360, 480];
// Only real display rates (48 Hz and up) count: a steady low frame rate
// under load says nothing about the display.
const MIN_DISPLAY_RATE = 48;
let _displayRates = (() => {
    try {
        let v = JSON.parse(localStorage.getItem(LS_DISPLAY_RATES_KEY) || '{}');
        let out = {};
        if (v && typeof v === 'object') for (let k in v) if (Number(v[k]) >= MIN_DISPLAY_RATE) out[k] = Number(v[k]);
        return out;
    } catch { return {}; }
})();

function _displayKey() {
    let sc = window.screen || {};
    return [sc.availLeft || 0, sc.availTop || 0, sc.width || 0, sc.height || 0, Math.round((window.devicePixelRatio || 1) * 100)].join(',');
}

function _snapRefreshRate(hz) {
    let best = 0;
    for (let r of COMMON_REFRESH_RATES) if (Math.abs(r - hz) <= r * 0.04 && (!best || Math.abs(r - hz) < Math.abs(best - hz))) best = r;
    return best || Math.round(hz);
}

function _learnDisplayRefreshRate(hz) {
    let key = _displayKey();
    let rate = _snapRefreshRate(hz);
    if (rate < MIN_DISPLAY_RATE || !(rate > (Number(_displayRates[key]) || 0))) return;
    _displayRates[key] = rate;
    try { localStorage.setItem(LS_DISPLAY_RATES_KEY, JSON.stringify(_displayRates)); } catch { }
    if (typeof refreshFpsTargetAutoLabel === 'function') refreshFpsTargetAutoLabel();
}

// The learned rate of this display; 60 until one is learned. Never the
// current frame rate itself: under load that drops, and a target following it
// down would cap the frame rate lower and lower.
function getDisplayRefreshRate() {
    return Number(_displayRates[_displayKey()]) || 60;
}

let _lastRenderFrameAt = 0;
let _fillInTimer = 0;
let _fillInHopPending = false;
let _timerGranularityMs = 16;
// Fill-in slots after the latest browser frame: base time, spacing, next slot, slot count.
let _fillInBase = 0;
let _fillInSpacing = 0;
let _fillInNext = 1;
let _fillInCount = 0;
const _fillInChannel = new MessageChannel();
_fillInChannel.port1.onmessage = () => { _fillInHopPending = false; _fillInStep(); };
if (_fillInChannel.port1.unref) { _fillInChannel.port1.unref(); _fillInChannel.port2.unref(); }

// Measured once: how late a 1 ms timer fires. Precise timers make hops unnecessary.
(function measureTimerGranularity() {
    let samples = [], last = performance.now();
    let step = () => {
        let now = performance.now();
        samples.push(now - last);
        last = now;
        if (samples.length < 8) setTimeout(step, 1);
        else _timerGranularityMs = samples.slice(2).sort((a, b) => a - b)[3] || 16;
    };
    setTimeout(step, 1);
})();

// Only the target FPS decides: fill-in frames run when it is above the
// browser's frame rate (for example Edge's fullscreen 60 on a 120 Hz display).
function _fillInFramesWanted() {
    return gameStarted && !document.hidden;
}

// Plans the fill-in frames after the browser frame at `ts`; returns their count.
// Recent cost of one frame and of the simulation work after it (ms).
let _renderMsEma = 0;
let _simMsEma = 0;

// Fill-in frames are for a browser that throttles its frames (fullscreen
// 60 on a faster display), never for frames that are slow because the game
// is busy: extra frames would only slow it further. So none below 50 browser
// FPS, and only as many as the measured frame cost leaves room for.
function _planFillInFrames(ts, maxCount = 7) {
    let count = 0;
    if (_fillInFramesWanted() && _rafIntervalMs <= 20) {
        // Never above the display's refresh rate: frames it cannot show only
        // make the shown ones uneven (it shows whichever finished last).
        let rate = Math.min(getTargetFrameRate(), getDisplayRefreshRate());
        count = Math.max(0, Math.min(maxCount, Math.round(_rafIntervalMs * rate / 1000 + 0.05) - 1));
        let perFrame = _renderMsEma + _simMsEma;
        if (perFrame > 0) count = Math.min(count, Math.max(0, Math.floor(_rafIntervalMs * 0.7 / perFrame) - 1));
    }
    _fillInBase = ts;
    _fillInCount = count;
    _fillInSpacing = _rafIntervalMs / (count + 1);
    _fillInNext = 1;
    return count;
}

function _fillInDueAt() {
    return _fillInBase + _fillInNext * _fillInSpacing;
}

function scheduleFillInFrame() {
    if (_fillInTimer) { clearTimeout(_fillInTimer); _fillInTimer = 0; }
    if (!_fillInFramesWanted() || _fillInNext > _fillInCount) return;
    let wait = _fillInDueAt() - performance.now();
    if (_timerGranularityMs <= 4) {
        // Precise timers: just sleep until due.
        _fillInTimer = setTimeout(_fillInStep, Math.max(0, wait));
    } else if (wait > _timerGranularityMs + 1) {
        // Coarse timers: sleep while the timer cannot overshoot, then hop.
        _fillInTimer = setTimeout(scheduleFillInFrame, wait - _timerGranularityMs - 1);
    } else {
        _fillInStep();
    }
}

function _fillInStep() {
    _fillInTimer = 0;
    if (!_fillInFramesWanted() || _fillInNext > _fillInCount) return;
    let now = performance.now();
    if (now >= _fillInDueAt()) {
        // A slot missed by more than half a slot is skipped: the next one (or
        // the next browser frame) shows the right moment instead.
        while (_fillInNext <= _fillInCount && now > _fillInDueAt() + _fillInSpacing * 0.5) _fillInNext++;
        if (_fillInNext > _fillInCount) return;
        let time = _fillInDueAt();
        _fillInNext++;
        _runLoopFrame(time, time + _fillInSpacing);
        scheduleFillInFrame();
    } else if (_timerGranularityMs <= 4) {
        scheduleFillInFrame();
    } else if (!_fillInHopPending) {
        // Not due yet: hop again (input and rAF still run in between).
        _fillInHopPending = true;
        _fillInChannel.port2.postMessage(0);
    }
}

// The simulation's own browser-frame loop: it keeps ticks going even when
// no frame is drawn (and headless). It only schedules the tick task, which
// runs after the frame is painted, like the one each drawn frame schedules.
function simulationFrame(ts) {
    _simulationFrameHandle = 0;
    _scheduleSimulationUpTo(Number.isFinite(ts) ? ts : performance.now());
    queueSimulationFrame();
}

function queueSimulationFrame() {
    if (_simulationFrameHandle) return;
    _simulationFrameHandle = requestAnimationFrame(simulationFrame);
}

function queueRenderFrame() {
    if (_renderFrameHandle) return;
    _renderFrameHandle = requestAnimationFrame(_rafLoopFrame);
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

    _hiddenTickAccumulator = pumpSimulationTicks(now, _hiddenTickAccumulator, 30);
}

function refreshBackgroundTickMode() {
    if (document.hidden) {
        _hiddenLastTickTime = performance.now();
        _hiddenTickAccumulator = 0;
        if (!_backgroundTickInterval) {
            // A worker-driven ticker keeps a hidden tab at full tick rate, so a
            // player who switches tabs does not stall everyone else.
            _backgroundTickInterval = netStartBackgroundTicker(TICK_MS, runHiddenTickPump) || true;
        }
    } else if (_backgroundTickInterval) {
        netStopBackgroundTicker();
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

    let minimapSizePx = MINIMAP_SIZE + 'px';
    if (minimapCanvas.width !== MINIMAP_SIZE || minimapCanvas.height !== MINIMAP_SIZE || minimapCanvas.style.width !== minimapSizePx || minimapCanvas.style.height !== minimapSizePx) {
        minimapCanvas.width = MINIMAP_SIZE;
        minimapCanvas.height = MINIMAP_SIZE;
        minimapCanvas.style.width = MINIMAP_SIZE + 'px';
        minimapCanvas.style.height = MINIMAP_SIZE + 'px';
        _minimapStaticCanvas = null;
        _minimapStaticCtx = null;
        _minimapStaticDirty = true;
        _requestStaticCacheCommit();
    }
    minimapCtx.setTransform(1, 0, 0, 1, 0, 0);
    minimapCtx.imageSmoothingEnabled = false;

    viewW = gameArea.clientWidth;
    viewH = gameArea.clientHeight;
    let dpr = window.devicePixelRatio || 1;
    bgCanvas.width = viewW * dpr;
    bgCanvas.height = viewH * dpr;
    bgCanvas.style.width = viewW + 'px';
    bgCanvas.style.height = viewH + 'px';
    _applyRenderViewPad();
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
    let ownerId = Number.isFinite(owner) ? owner : localPlayerId;
    let bKey = normalizeBuildingResearchKey(type);
    let lvl = Math.max(1, clampThingLevel(level));
    if (!PRECOMPUTED_STATS_MAP_PLAYER[ownerId]) rebuildPrecomputedStatsMapPlayer(ownerId);
    let playerMap = PRECOMPUTED_STATS_MAP_PLAYER[ownerId];
    let direct = playerMap && playerMap.building && playerMap.building[bKey] ? playerMap.building[bKey][lvl] : null;
    if (direct) return direct;
    return _getBuildingPlayerPrecomputedEntry(ownerId, bKey, lvl);
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
    if (target.watchedByTeam === undefined) target.watchedByTeam = -1;
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

function _getEffectStat(owner, sourceType, level, effect, statKind) {
    let statKey = _getEffectStatKey(effect, statKind);
    if (!statKey || !sourceType) return NaN;
    let ownerId = Number.isFinite(owner) ? owner : localPlayerId;
    let lvl = Math.max(1, clampThingLevel(level || 1));
    if (effect === 'watch' && BASE_UNIT_STATS[sourceType]) {
        return getUnitStatForOwner(ownerId, sourceType, lvl, statKey);
    }
    return getBuildingStatForOwner(ownerId, sourceType, lvl, statKey);
}

function applyStatusEffect(target, effect, level, baseDamage = 0, sourceOwner = null, sourceType = '') {
    if (!target) return false;
    ensureStatusState(target);
    if (isEffectImmune(target, effect)) return false;
    // An armed mover (see simMoveTryArm) is handed back to Unit.update.
    if (typeof simMoveDisarm === 'function' && target instanceof Unit) simMoveDisarm(target);

    let lvl = Math.max(1, level || 1);
    let mappedDuration = _getEffectStat(sourceOwner, sourceType, lvl, effect, 'duration');
    let mappedDps = _getEffectStat(sourceOwner, sourceType, lvl, effect, 'dps');
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
        let teamId = Number.isFinite(sourceOwner) ? Math.floor(sourceOwner) : -1;
        if (target.watched > 0 && target.watchedByTeam === teamId) target.watched = Math.max(target.watched, dur);
        else target.watched = dur;
        target.watchedByTeam = teamId;
        if (typeof visCoverOnEntityChanged === 'function') visCoverOnEntityChanged(target);
    }
    if (typeof Unit === 'undefined' || !(target instanceof Unit)) thingStatusWake(target);
    return true;
}

// Buildings and floor items whose statuses are running or whose energy may
// have run out (the tick's status loop looks at these only, in row-major
// order): added by status effects and damage, and by gameTick's sweep of a
// TICK_RATE-th of the items a tick; made anew from every item on every peer
// at a resync (thingStatusRebuild). An extra member changes nothing.
let _thingStatusActive = new Set();
// Buildings that tick their own statuses in their update (towers, barracks,
// spawners: thingStatusTickSelf), while something may run: the same hooks
// add them, a tick with nothing left removes them, a resync makes it anew
// (an extra member changes nothing either).
let _thingStatusSelf = new Set();
function thingStatusWake(e) { _thingStatusActive.add(e); _thingStatusSelf.add(e); }
function thingStatusTickSelf(e) {
    if (!_thingStatusSelf.has(e)) return false;
    const gone = tickStatusEffects(e);
    if (!thingStatusPending(e)) _thingStatusSelf.delete(e);
    return gone;
}
function thingStatusDone(e) { _thingStatusActive.delete(e); }
function thingStatusPending(e) {
    return e.burning > 0 || e.poisoned > 0 || e.frozen > 0 || e.wet > 0 || e.sandy > 0 || e.watched > 0 || (e.energy !== undefined && e.energy <= 0);
}
// The members in row-major order (a copy: the loop removes some).
function thingStatusDue() {
    if (_thingStatusActive.size === 0) return _NO_THINGS;
    const out = Array.from(_thingStatusActive);
    out.sort((a, b) => (a.gy * GRID_W + a.gx) - (b.gy * GRID_W + b.gx));
    return out;
}
const _NO_THINGS = Object.freeze([]);
function thingStatusRebuild() {
    _thingStatusActive = new Set();
    for (const item of getCellItemsRowMajor()) if (thingStatusPending(item)) _thingStatusActive.add(item);
    _thingStatusSelf = new Set();
    for (const list of [towers, barracks, collectorSpawners]) for (const e of list) if (e) { ensureStatusState(e); if (thingStatusPending(e)) _thingStatusSelf.add(e); }
}

function tickStatusEffects(target) {
    if (!target) return false;
    ensureStatusState(target);

    if (target.burning > 0) {
        target.burning--;
        if (target.burnTickDamage > 0) {
            target.energy -= target.burnTickDamage;
            recordDamageVisual(target, target.burnTickDamage); shrineDamageTaken(target, target.burnTickDamage);
        }
    }
    if (target.poisoned > 0) {
        target.poisoned--;
        if (target.poisonTickDamage > 0) {
            target.energy -= target.poisonTickDamage;
            recordDamageVisual(target, target.poisonTickDamage); shrineDamageTaken(target, target.poisonTickDamage);
        }
    }
    if (target.frozen > 0 && target.wet > 0 && target.iceTickDamage > 0) {
        target.energy -= target.iceTickDamage;
        recordDamageVisual(target, target.iceTickDamage); shrineDamageTaken(target, target.iceTickDamage);
    }
    if (target.frozen > 0) target.frozen--;
    if (target.wet > 0) target.wet--;
    if (target.sandy > 0) target.sandy--;
    if (target.watched > 0) {
        target.watched--;
        if (target.watched <= 0) { target.watchedByTeam = -1; if (typeof visCoverOnEntityChanged === 'function') visCoverOnEntityChanged(target); }
    }

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

function clearRendererTransientVisualCaches(options = null) {
    if (rendererScaleCache) {
        for (const layer of rendererScaleCache.layers) layer.dispose(rendererScaleCache.renderer.gl);
        if (typeof rendererScaleCache.renderer.disposeFrameColumns === 'function') rendererScaleCache.renderer.disposeFrameColumns();
        rendererScaleCache = null;
    }
    rendererChunkCache = null;
    rendererScaleActive = false;
    let preserveTextSprites = !!(options && options.preserveTextSprites);
    if (!preserveTextSprites) {
        LEVEL_TEXT_SPRITE_CACHE.clear();
        UNIT_LEVEL_TEXT_SPRITE_CACHE.clear();
        renderer3dTopTextureCache.clear();
        renderer3dExact2DTextureCache.clear();
        renderer3dFlatGeneration++;
        if (renderer3dInstance && renderer3dInstance.topTextureCache && typeof renderer3dInstance.topTextureCache.clear === 'function') {
            for (let entry of renderer3dInstance.topTextureCache.values()) renderer3dInstance.gl.deleteTexture(entry.texture);
            renderer3dInstance.topTextureCache.clear();
        }
    }
    renderer3dOverlapFadeState.clear();
    renderer3dSharedAudioTextureCanvases.clear();
    _litTintCache.clear();
}

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
    let isBlocked = txt.includes('|BLOCKED');
    let displayText = txt.replace('|BLOCKED', '').trim();
    let scale = _getUiSpriteScale();
    let key = displayText + '|' + scale + '|' + (isBlocked ? 'BLOCKED' : '');
    let cached = LEVEL_TEXT_SPRITE_CACHE.get(key);
    if (cached) return cached;

    let width = 40;
    let height = 48;
    let canvas = document.createElement('canvas');
    let c = canvas.getContext('2d');

    // Use smaller font if three-part (with ->) or blocked
    let isThreePart = (displayText.match(/->/g) || []).length === 2;
    let fontSize = isThreePart || isBlocked ? 6 : 8;

    c.font = `700 ${fontSize}px Segoe UI, Arial, sans-serif`;
    width = Math.max(width, Math.ceil(c.measureText(displayText).width + 10));
    canvas.width = width * scale;
    canvas.height = height * scale;
    c = canvas.getContext('2d');
    c.imageSmoothingEnabled = false;
    c.setTransform(scale, 0, 0, scale, 0, 0);
    c.clearRect(0, 0, width, height);
    c.textAlign = 'left';
    c.textBaseline = 'middle';
    c.font = `700 ${fontSize}px Segoe UI, Arial, sans-serif`;
    c.lineJoin = 'round';
    c.strokeStyle = 'rgba(0,0,0,0.95)';
    c.lineWidth = 2;

    if (isBlocked && displayText.includes('->')) {
        // Parse either L1->L3->L5 or L1->L5 format
        let parts = displayText.split('->');
        if (parts.length === 3) {
            // Three-part: L0->L1->L3
            let part1 = parts[0]; // L0
            let part2 = parts[1]; // L1
            let part3 = parts[2]; // L3
            let arrow = '->';

            let fullText = displayText;
            let startX = (width - c.measureText(fullText).width) * 0.5;

            let x1 = startX;
            let x2 = x1 + c.measureText(part1 + arrow).width;
            let x3 = x2 + c.measureText(part2 + arrow).width;

            // Stroke all
            c.strokeText(part1, x1, 11);
            c.strokeText(arrow, x1 + c.measureText(part1).width, 11);
            c.strokeText(part2, x2, 11);
            c.strokeText(arrow, x2 + c.measureText(part2).width, 11);
            c.strokeText(part3, x3, 11);

            // Fill - normal for L0->L1, red for L3
            c.fillStyle = '#eee';
            c.fillText(part1, x1, 11);
            c.fillText(arrow, x1 + c.measureText(part1).width, 11);
            c.fillText(part2, x2, 11);
            c.fillText(arrow, x2 + c.measureText(part2).width, 11);
            c.fillStyle = '#ff6666';  // Bright red
            c.fillText(part3, x3, 11);
        } else if (parts.length === 2) {
            // Two-part with blocked (L1->L5|BLOCKED)
            let currentText = parts[0];
            let arrow = '->';
            let potentialText = parts[1];

            let startX = (width - c.measureText(displayText).width) * 0.5;
            let x1 = startX;
            let x2 = x1 + c.measureText(currentText + arrow).width;

            // Stroke all
            c.strokeText(currentText, x1, 11);
            c.strokeText(arrow, x1 + c.measureText(currentText).width, 11);
            c.strokeText(potentialText, x2, 11);

            // Fill - normal for current and arrow, bright red for potential
            c.fillStyle = '#eee';
            c.fillText(currentText, x1, 11);
            c.fillText(arrow, x1 + c.measureText(currentText).width, 11);
            c.fillStyle = '#ff6666';  // Bright red
            c.fillText(potentialText, x2, 11);
        }
    } else if (displayText.includes('->')) {
        // Normal two-part (L1->L3)
        let arrowIdx = displayText.indexOf('->');
        let currentText = displayText.substring(0, arrowIdx);
        let arrow = '->';
        let nextText = displayText.substring(arrowIdx + 2);

        let fullWidth = c.measureText(displayText).width;
        let startX = (width - fullWidth) * 0.5;
        let x1 = startX;
        let x2 = x1 + c.measureText(currentText + arrow).width;

        // Stroke all
        c.strokeText(currentText, x1, 11);
        c.strokeText(arrow, x1 + c.measureText(currentText).width, 11);
        c.strokeText(nextText, x2, 11);

        // Fill - all normal
        c.fillStyle = '#eee';
        c.fillText(currentText, x1, 11);
        c.fillText(arrow, x1 + c.measureText(currentText).width, 11);
        c.fillText(nextText, x2, 11);
    } else {
        // Single level (L1) - use center alignment
        c.textAlign = 'center';
        c.strokeText(displayText, width * 0.5, 11);
        c.fillStyle = '#eee';
        c.fillText(displayText, width * 0.5, 11);
    }

    cached = { canvas, scale, width, height };
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
    target._textCanvasWidth = sprite.width;
    target._textCanvasHeight = sprite.height;
    target._levelTextLabel = String(label || '');
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
// Insertion-ordered buckets preserve the existing depth/image replay order.
const _frameDrawImageBuckets = new Map();
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
    _frameDrawImageBuckets.clear();
    _frameDrawImageContexts.clear();
    _frameDrawImageCurrentZ = 0;
}

function setFrameDrawImageDepth(z) {
    _frameDrawImageCurrentZ = Number.isFinite(z) ? z : 0;
}

function queueDrawImage(ctx, image, a0, a1, a2, a3, a4, a5, a6, a7) {
    if (!ctx || !image) return;
    let argc = arguments.length - 2;

    if (!_frameDrawImageQueueActive || ctx.__drawImagesImmediately) {
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
    let depthBucket = _frameDrawImageBuckets.get(_frameDrawImageCurrentZ);
    if (!depthBucket) {
        depthBucket = new Map();
        _frameDrawImageBuckets.set(_frameDrawImageCurrentZ, depthBucket);
    }
    let imageBucket = depthBucket.get(imageId);
    if (!imageBucket) {
        imageBucket = [];
        depthBucket.set(imageId, imageBucket);
    }
    imageBucket.push({
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

function replayDrawImageCommand(cmd, targetCtx, stateMap) {
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
}

function flushFrameDrawImageQueue() {
    if (!_frameDrawImageQueueActive) return;
    if (_frameDrawImageBuckets.size === 0) {
        _frameDrawImageQueueActive = false;
        return;
    }

    let zOrder = Array.from(_frameDrawImageBuckets.keys());
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
        for (let cmds of _frameDrawImageBuckets.get(z).values()) {
            for (let cmd of cmds) {
                replayDrawImageCommand(cmd, cmd.ctx, liveStateByCtx);
                if (layerCtx) {
                    replayDrawImageCommand(cmd, layerCtx, layerStateByCtx);
                    let stats = renderer3dLayerStats.get(z);
                    if (stats) stats.commandCount++;
                }
            }
        }
    }

    for (let c of _frameDrawImageContexts) c.restore();
    for (let c of layerContextsToRestore) c.restore();

    _frameDrawImageBuckets.clear();
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
    let label = String(getLevelLabelText(target) || '');
    if (target._levelTextLabel !== label) updateItemTextCache(target);
    let width = Math.max(32, Math.floor(Number(target._textCanvasWidth) || 32));
    let height = Math.max(48, Math.floor(Number(target._textCanvasHeight) || 48));
    let dx = Math.round(x - width * 0.5);
    let dy = Math.round(y - 24);
    queueDrawImage(ctx, target.textCanvas, dx, dy, width, height);
}

function updateItemTextCache(item) {
    let label = getLevelLabelText(item);
    _bindBuildingLevelTextSprite(item, label);
}
