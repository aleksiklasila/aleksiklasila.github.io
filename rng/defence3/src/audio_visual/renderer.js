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
    let dmg = Math.max(0, Number(amount) || 0);
    if (dmg <= 0.01) return;
    let maxEnergy = Math.max(1, Number(target.maxEnergy) || Number(target.preComputed && target.preComputed.maxEnergy) || 0);
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
    let maxEnergy = Number(unit && unit.preComputed && unit.preComputed.maxEnergy);
    if (unit && unit.energy < maxEnergy) {
        bars.push({ pct: Math.max(0, unit.energy / Math.max(1, maxEnergy)), bgColor: '#600', fillColor: '#0f0' });
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
        renderer3dExact2DTextureCache.delete(key);
        if (panel._panelCtx && renderer3dPanelPool.length < RENDERER3D_PANEL_POOL_MAX) renderer3dPanelPool.push(panel);
        if (renderer3dExact2DTextureCache.size <= RENDERER3D_EXACT_2D_TEXTURE_CACHE_MAX) break;
    }
}

function quantize3DExactRatio(value, maximum) {
    if (!(maximum > 0)) return 0;
    return Math.round(Math.max(0, Math.min(1, (Number(value) || 0) / maximum)) * RENDERER3D_TOP_TEXTURE_SIZE);
}

const renderer3dVisualSignatures = new WeakMap();
const renderer3dSignatureScratch = [];

function get3DExact2DVisualSignature(entity, isUnit = false) {
    if (!entity) return '';
    let researchTask = entity.researchTask || null;
    let maxEnergy = Number(entity.maxEnergy)
        || Number(entity.preComputed && entity.preComputed.maxEnergy)
        || Number(entity.preComputedEffective && entity.preComputedEffective.maxEnergy)
        || 0;
    // Unit.draw only uses the target/style while the attack flash is active.
    // A remembered target moving elsewhere must not invalidate an idle panel.
    let activeAttack = !isUnit || Number(entity.attackFlash) > 0;
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
    values[n++] = entity.textCanvas && shouldShowBuildingLevels() ? getLevelLabelText(entity) : '';
    values[n++] = shouldShowUnitLevels() && entity.unitType ? getUnitLevelLabelText(entity) : '';
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
    values[n++] = Number(entity.attackFlash) || 0;
    values[n++] = activeAttack ? entity.attackStyle || '' : '';
    values[n++] = attackTarget ? Math.round((Number(attackTarget.x) - Number(entity.x)) / 4) : 0;
    values[n++] = attackTarget ? Math.round((Number(attackTarget.y) - Number(entity.y)) / 4) : 0;
    values[n++] = Number.isFinite(entity._energyBlockedUntil) && gameTime < entity._energyBlockedUntil ? 1 : 0;
    values[n++] = entity.researcherHasMaterial ? 1 : 0;
    // Keep the interned key when visual inputs are unchanged. Joining and
    // hashing a long key for every visible unit dominated zoomed-out frames.
    let previous = renderer3dVisualSignatures.get(entity);
    if (previous && previous.isUnit === isUnit) {
        let same = true, stored = previous.values;
        for (let i = 0; i < n; i++) if (values[i] !== stored[i]) { same = false; break; }
        if (same) return previous.signature;
    }
    let stored = values.slice(0, n);
    let signature = stored.join('|');
    renderer3dVisualSignatures.set(entity, { isUnit, values: stored, signature });
    return signature;
}

function get3DExact2DCapture(entity, x, y, isUnit) {
    if (!isUnit) return { centerX: x, centerY: y, extent: TILE };

    let radius = Math.max(1, Number(entity && entity.r) || 8);
    let halfWidth = radius + 3; // body outline and the energy bar overhang
    let top = y - radius - 7;  // health bar
    let bottom = y + radius + 3;

    if (shouldShowUnitLevels()) {
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
    let panel = _rasterize3DPanel(signature, scale, size * 0.5 - capture.centerX * scale, size * 0.5 - capture.centerY * scale,
        g => entity.draw(g));
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
const renderer3dLastExactTextures = new WeakMap();

function _rememberExact2DTexture(entity, panel) {
    let last = renderer3dLastExactTextures.get(entity);
    if (!last) renderer3dLastExactTextures.set(entity, last = {});
    last.panel = panel;
    last.version = panel._textureVersion;
}

function get3DExact2DFallbackTexture(entity, isUnit) {
    let previous = renderer3dLastExactTextures.get(entity);
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
    switch (type) {
        case 'barrack': return 0.6;
        case 'research': return 0.64;
        case 'spawner': case 'astar_spawner': return 0.56;
        default: return 0.58;
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

    for (let ring of commandFeedbackRings3D()) overlays.rings.push(ring);
    return overlays;
}

function getVisualUnitSourceLight(unit) {
    if (!unit || !unit.unitType || unit.dead || unit._historyGhost) return 0;
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
        animationMode: Math.max(0, Math.min(6, Math.floor(Number(object.animationMode) || 0))),
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
        lightLevel: finalLightLevel,
        historyGhost: remembered,
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

function getUnit3DActivity(u) {
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

function getUnit3DWeaponType(u) {
    let unitType = String(u && u.unitType || '');
    let workerType = String(u && u.workerType || '');
    if (workerType === 'builder') return 'hammer';
    if (workerType === 'collector' || workerType === 'astar_collector') return 'pickaxe';
    if (workerType === 'salvager') return 'cutter';
    if (workerType === 'healer') return 'healer_staff';
    if (workerType === 'researcher') return 'research_orb';
    if (unitType === 'king') return 'king_sword';
    if (unitType === 'boss') return 'great_axe';
    if (unitType === 'tank') return 'warhammer';
    if (unitType === 'fast') return 'dual_blades';
    if (unitType === 'flying' || unitType === 'scout') return 'talons';
    if (unitType === 'mole') return 'claws';
    let styleWeapons = {
        fire: 'fire_blade', water: 'water_trident', ice: 'ice_spear',
        poison: 'poison_scythe', laser: 'laser_staff', melee: 'sword'
    };
    return styleWeapons[String(u && u.attackStyle || 'melee')] || 'sword';
}

function pushUnit3DActivityEffects(target, u, activity, x, z, footprint) {
    if (!activity || activity.mode < 2 || activity.amount <= 0) return;
    // Physical equipment carries most of the action. Keep only small contact/magic accents.
    if (activity.mode === 3) return;
    let palette = {
        2: ['#ffb52e', '#fff1a8'], 3: [u.workerType === 'astar_collector' ? '#e8e8ff' : '#ffd84d', '#ffffff'],
        4: ['#ff7043', '#d7e0e8'], 5: ['#62ffb0', '#eafff4'], 6: ['#55bfff', '#c76cff']
    }[activity.mode];
    let phase = (u._historyGhost ? u._historyTick : gameTime + tickAlpha) / Math.max(1, TICK_RATE) * (activity.mode === 4 ? 12 : 7) + (Number(u.id) || 0) * 1.37;
    let count = 2;
    for (let i = 0; i < count; i++) {
        let p = phase + i * Math.PI * 2 / count;
        let radius = activity.mode === 5 ? .38 : activity.mode === 6 ? .32 : .24;
        let burst = activity.mode === 2 || activity.mode === 4;
        let ox = burst ? Math.cos(p * .63) * .20 : Math.cos(p) * radius;
        let oz = burst ? .26 + Math.sin(p * .71) * .16 : Math.sin(p) * radius;
        let oy = burst ? .18 + ((phase * .18 + i / count) % 1) * .42 : .28 + Math.sin(p * 2) * .16 + i * .035;
        push3DRenderObject(target, {
            modelKey: `worker_activity_${activity.mode}`,
            x: x + ox * footprint, y: oy * Math.max(.7, footprint), z: z + oz * footprint,
            scaleX: burst ? .055 : .07, scaleY: activity.mode === 5 ? .025 : .065, scaleZ: burst ? .025 : .07,
            rotationY: p, tint: palette[i % palette.length], alpha: .72 + .2 * Math.sin(p), renderShape: activity.mode === 3 || activity.mode === 6 ? 'cylinder' : 'box'
        });
    }
}

// Structures barely change, but the scene is rebuilt every frame. Reuse a
// structure's render object (relit every frame) while nothing it depends on
// changed: view mode, audio pulse, facing, whether a unit stands on its
// tile, and it is not flashing, waiting for its exact panel or easing its
// height (the last two builds differed). Panels refresh every 1-4 ticks.
const renderer3dStaticObjects = new WeakMap();
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

const renderer3dUnitObjects = new WeakMap();

function _unit3DWalkPhase(u, activity) {
    return activity.mode === 1
        ? Math.max(0, Math.min(1, (8 - Number(u.attackFlash || 0) + (u._historyGhost ? 0 : tickAlpha)) / 8)) * Math.PI
        : ((u._historyGhost ? u._historyTick : gameTime + tickAlpha)) / TICK_RATE * (activity.mode === 2 ? 8 : activity.mode === 4 ? 14 : 10) + (Number(u.id) || 0) * 2.399;
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

function _reuseStatic3DObject(target, entity, gx, gy, audioMove, audioHeight) {
    let entry = renderer3dStaticObjects.get(entity);
    let age = entry ? gameTime - entry.tick : -1;
    if (!entry || entry.dynamic || age < 0 || age >= entry.maxAge
        || entry.view !== renderer3dStaticFrame.view || entry.audioMove !== audioMove || entry.audioHeight !== audioHeight
        || entry.angle !== entity.angle
        || entry.occupied !== renderer3dStaticFrame.occupied.has(gy * GRID_W + gx)
        || getDamageFlashState(entity)) return false;
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
    return true;
}

function _rememberStatic3DObject(target, entity, gx, gy, audioMove, audioHeight, fallbackTexture) {
    let object = target[target.length - 1];
    let entry = renderer3dStaticObjects.get(entity);
    let easing = !!(entry && entry.object.scaleY !== object.scaleY);
    renderer3dStaticObjects.set(entity, { object, tick: gameTime, audioMove, audioHeight, angle: entity.angle,
        textureVersion: object.topTextureCanvas ? object.topTextureCanvas._textureVersion : undefined,
        litVersion: visibilityVersion, litGrid: visibilityGrid,
        // Panels (health, progress) refresh every 1-4 ticks, spread by tile.
        maxAge: 1 + ((gx * 7 + gy * 13) & 3),
        view: renderer3dStaticFrame.view,
        occupied: renderer3dStaticFrame.occupied.has(gy * GRID_W + gx),
        dynamic: fallbackTexture || easing || !!getDamageFlashState(entity) });
}

// ---- Flat (2D view) sprites -------------------------------------------
// The 2D view needs only a position, footprint, light and panel per sprite.
// Units, projectiles and particles write those straight into the renderer's
// typed instance batch instead of building scene objects; structures reuse
// their cached scene objects (pushObject).
let renderer3dFlatBatch = null;
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

const renderer3dFlatProjectileSprites = new Map();

function _pushFlatProjectile(batch, p, x, z) {
    let sprite = renderer3dFlatProjectileSprites.get(p.type);
    if (!sprite) {
        let color = (BASE_CARD_TYPES[p.type] || {}).color || '#fff';
        let key = `projectile:${p.type}:${color}`;
        sprite = { key, texture: get3DTopTextureCanvas(key, (g) => {
            let size = g.canvas.width;
            g.fillStyle = color;
            g.beginPath();
            g.arc(size * 0.5, size * 0.5, size * 0.18, 0, Math.PI * 2);
            g.fill();
            g.strokeStyle = '#fff';
            g.lineWidth = Math.max(2, Math.round(size * 0.035));
            g.stroke();
        }) };
        renderer3dFlatProjectileSprites.set(p.type, sprite);
    }
    let light = _flatLightAt(x, z, 0, false);
    batch.push(x, z, 0.12, 0.2, light, light, light, 0.95, -Math.atan2(Number(p.vx) || 0, Number(p.vy) || 1), sprite.texture);
}

// The lit tint as 0..1 rgb, as the GPU renderer parses _getCachedLitTint.
const renderer3dFlatTintRgb = new Map();
const RENDERER3D_FLAT_DEFAULT_RGB = [0.78, 0.81, 0.85];

function _getFlatLitRgb(tint, light) {
    let lit = _getCachedLitTint(tint, light);
    let rgb = renderer3dFlatTintRgb.get(lit);
    if (rgb) return rgb;
    let match = String(lit).trim().match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
    if (!match) return RENDERER3D_FLAT_DEFAULT_RGB;
    let hex = match[1].length === 3 ? match[1].replace(/./g, ch => ch + ch) : match[1];
    rgb = [parseInt(hex.slice(0, 2), 16) / 255, parseInt(hex.slice(2, 4), 16) / 255, parseInt(hex.slice(4, 6), 16) / 255];
    if (renderer3dFlatTintRgb.size >= 2048) renderer3dFlatTintRgb.clear();
    renderer3dFlatTintRgb.set(lit, rgb);
    return rgb;
}

function _pushFlatParticle(batch, p, x, z) {
    let rgb = _getFlatLitRgb(p.color || '#fff', _flatLightAt(x, z, 0, false));
    let alpha = Math.max(0.1, Math.min(1, (Number(p.life) || 0) / 35));
    batch.push(x, z, 0.06, 0.06, rgb[0], rgb[1], rgb[2], alpha, 0, null);
}

function build3DFrameData(flat2d = false) {
    const { grid, units, towers, barracks, collectorSpawners, goldMines, astarMines, droppedItems, projectiles, particles, visibilityGrid } = getLiveRenderView();

    begin3DTextureFrame();
    renderer3dExactTextureBuildsRemaining = 12;
    renderer3dExactTextureTimeRemaining = 2;
    renderer3dExactUnitTextureBuildsRemaining = 12;
    renderer3dExactUnitTextureTimeRemaining = 2;
    let bounds = flat2d ? getVisibleWorldBounds(2) : get3DVisibleWorldBounds();
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
    if (!fullVisibility) rebuildVisibilityMaskCacheIfNeeded();
    let overlays = build3DOverlayData(bounds, alpha);
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
    let view3DKey = (flat2d ? 1 : 0) | (fullVisibility ? 2 : 0) | (shouldShowUnitLevels() ? 4 : 0) | (shouldShowBuildingLevels() ? 8 : 0);
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
            sideTint,
        });
    };

    // Occupied tiles lower structures in 3D; flat sprites do not overlap-fade.
    if (!flat2d) for (let u of units) {
        if (u.dead) continue;
        let ux = u.prevX + (u.x - u.prevX) * alpha;
        let uy = u.prevY + (u.y - u.prevY) * alpha;
        let ugx = Math.floor(ux / TILE), ugy = Math.floor(uy / TILE);
        if (ugx < bounds.minGx - 1 || ugx > bounds.maxGx + 1 || ugy < bounds.minGy - 1 || ugy > bounds.maxGy + 1) continue;
        if (!fullVisibility && (!visibilityGrid[ugy] || visibilityGrid[ugy][ugx] === 0)) continue;
        unitOccupiedTileKeys.add(ugy * GRID_W + ugx);
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
        if (_reuseStatic3DObject(objects, m, m.gx, m.gy, audioMove, audioHeight)) continue;
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
        if (_reuseStatic3DObject(objects, m, m.gx, m.gy, audioMove, audioHeight)) continue;
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
    }

    let pushCellItem = (x, y, cell) => {
        let bgSoundRow = bgSoundGrid[y];
        let fxSoundRow = fxSoundGrid[y];
        let bgLevel = bgSoundRow ? bgSoundRow[x] || 0 : 0;
        let fxLevel = fxSoundRow ? fxSoundRow[x] || 0 : 0;
        let audioMove = bgLevel * AUDIO_REACTIVE_RENDER_3D_POSITION_FROM_BG + fxLevel * AUDIO_REACTIVE_RENDER_3D_POSITION_FROM_SFX;
        let audioHeight = bgLevel * AUDIO_REACTIVE_RENDER_3D_HEIGHT_FROM_BG + fxLevel * AUDIO_REACTIVE_RENDER_3D_HEIGHT_FROM_SFX;
        if (_reuseStatic3DObject(objects, cell.item, x, y, audioMove, audioHeight)) return;
        let item2DTexture = get3DExact2DFloorTexture(cell.item, cell.owner);
        let itemStatus = item2DTexture ? null : get3DBuildingTextureStatus(cell.item);
        push3DRenderObject(objects, {
            modelKey: `item_${cell.item.type || 'floor'}`,
            x: x + 0.5 + reactiveOffsetX * audioMove,
            y: get3DConstructionLift(cell.item),
            z: y + 0.5 + reactiveOffsetY * audioMove,
            scaleX: 0.84,
            scaleY: (cell.item.type === 'house' ? 0.82 : 0.14) * (1 + audioHeight),
            overlapFade: getOverlapFadeForTile(x, y),
            scaleZ: 0.84,
            preserveModelHeight: cell.item.type === 'house',
            visibilitySource: cell.item,
            rotationY: -(Number(cell.item.angle) || 0),
            tint: get3DDamageFlashTint(cell.item, get3DRenderOwnerColor(cell.owner)),
            alpha: get3DConstructionAlpha(cell.item),
            topTextureKey: item2DTexture ? item2DTexture._renderer3DExactKey : `item:${cell.item.type}:${cell.owner}:${itemStatus.keySuffix}`,
            topTextureCanvas: item2DTexture || get3DTopTextureForFloorItem(cell.item, itemStatus),
            sideTint: get3DDamageFlashTint(cell.item, (BASE_CARD_TYPES[cell.item.type] || {}).color || get3DRenderOwnerColor(cell.owner))
        });
        _rememberStatic3DObject(objects, cell.item, x, y, audioMove, audioHeight, !item2DTexture);
    };
    // Floor items in row-major order. The live tile index lists them, so
    // only a remembered (history) grid needs a scan of every visible tile.
    if (_isLiveRenderGrid(grid)) {
        let items = getCellItemsRowMajor();
        for (let i = findCellItemRowStart(items, bounds.minGy); i < items.length; i++) {
            let item = items[i], x = item.gx, y = item.gy;
            if (y > bounds.maxGy) break;
            if (x < bounds.minGx || x > bounds.maxGx) continue;
            let cell = grid[y][x];
            if (!cell || cell.item !== item) continue;
            if (!fullVisibility && (!visibilityGrid[y] || visibilityGrid[y][x] === 0)) continue;
            pushCellItem(x, y, cell);
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
                pushCellItem(x, y, cell);
            }
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
        if (_reuseStatic3DObject(objects, t, t.gx, t.gy, audioMove, audioHeight)) continue;
        let tower2DTexture = get3DExact2DTexture(t);
        let tower2DTextureFallback = renderer3dExactTextureFallback;
        let towerStatus = tower2DTexture ? null : get3DBuildingTextureStatus(t);
        push3DRenderObject(objects, {
            modelKey: `tower_${t.type || 'base'}`,
            x: t.x / TILE + reactiveOffsetX * audioMove,
            y: get3DConstructionLift(t),
            z: t.y / TILE + reactiveOffsetY * audioMove,
            scaleX: 0.82,
            scaleY: 1.05 * (1 + audioHeight),
            overlapFade: getOverlapFadeForTile(t.gx, t.gy),
            scaleZ: 0.82,
            visibilitySource: t,
            rotationY: Math.PI * 0.5 - (Number(t.angle) || 0),
            tint: get3DDamageFlashTint(t, get3DRenderOwnerColor(t.owner)),
            alpha: get3DConstructionAlpha(t),
            topTextureKey: tower2DTexture ? tower2DTexture._renderer3DExactKey : `tower:${t.type}:${t.owner}:${_quantizeTowerAngleIndex(t.angle || 0)}:${towerStatus.keySuffix}`,
            topTextureCanvas: tower2DTexture || get3DBuildingTopTexture('tower', t.owner, { subtype: t.type, color: t.baseStats && t.baseStats.color, angle: t.angle || 0, angleKey: _quantizeTowerAngleIndex(t.angle || 0), active: t.type === 'laser' ? t.connectedLasers && t.connectedLasers.length > 0 : true, status: towerStatus, statusKey: towerStatus.keySuffix }),
            sideTint: get3DDamageFlashTint(t, (t.baseStats && t.baseStats.color) || get3DRenderOwnerColor(t.owner))
        });
        _rememberStatic3DObject(objects, t, t.gx, t.gy, audioMove, audioHeight, !tower2DTexture || tower2DTextureFallback);
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
        if (_reuseStatic3DObject(objects, s, s.gx, s.gy, audioMove, audioHeight)) continue;
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
        if (_reuseStatic3DObject(objects, b, b.gx, b.gy, audioMove, audioHeight)) continue;
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
    for (let u of units) {
        if (flat2d) drainFlatObjects();
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
        if (flat2d && _pushFlatUnit(flatBatch, u, ux / TILE + reactiveOffsetX * audioMove, uy / TILE + reactiveOffsetY * audioMove, view3DKey)) continue;
        let audioHeight = bgLevel * AUDIO_REACTIVE_RENDER_3D_HEIGHT_FROM_BG + fxLevel * AUDIO_REACTIVE_RENDER_3D_HEIGHT_FROM_SFX;
        let footprint = Math.max(0.28, Math.min(0.9, ((u.r || 8) * 2.2) / TILE));
        if (u.isSnake) {
            pushSnakeRenderObjects(objects, u, ux + reactiveOffsetX * audioMove * TILE, uy + reactiveOffsetY * audioMove * TILE, footprint);
        } else {
            // Everything but the interpolated position, walk cycle and
            // lighting changes only on ticks: refresh just those.
            let cached = renderer3dUnitObjects.get(u);
            // Tick-level data may be one tick old for half of the units (by id),
            // which halves the rebuild on tick frames.
            let cachedAge = cached ? gameTime - cached.tick : -1;
            if (cached && (cachedAge === 0 || (cachedAge === 1 && ((u.id + gameTime) & 1) === 1))
                && cached.view === view3DKey && !cached.dynamic && !getDamageFlashState(u)
                && (cached.object.topTextureCanvas || {})._textureVersion === cached.textureVersion) {
                let o = cached.object;
                _touch3DPanel(o.topTextureCanvas);
                o.x = ux / TILE + reactiveOffsetX * audioMove;
                o.z = uy / TILE + reactiveOffsetY * audioMove;
                o.walkPhase = _unit3DWalkPhase(u, cached.activity);
                // A unit's own light changes only with ticks (or the viewer).
                if (cached.sourceLightTick !== gameTime || cached.sourceLightPlayer !== localPlayerId) {
                    cached.sourceLight = getVisualUnitSourceLight(u);
                    cached.sourceLightTick = gameTime;
                    cached.sourceLightPlayer = localPlayerId;
                }
                _relight3DObject(o, u, cached.tint, cached.sideTint, !!objects.flat2d, cached.sourceLight);
                objects.push(o);
                if (!flat2d) pushUnit3DActivityEffects(objects, u, cached.activity, ux / TILE, uy / TILE, footprint);
                continue;
            }
            let modelScale = u.isFlying ? (u.isWorker ? 0.65 : 0.8) : 1;
            // The mounted panel is the unit's canonical 2D rendering at every LOD.
            // The shared status texture remains only a short-lived fallback while a
            // newly visible exact texture is rasterized within the frame budget.
            let unitSideColor = u.unitType === 'collector'
                ? '#f0a52b'
                : ((BASE_UNIT_STATS[u.unitType] || BASE_UNIT_STATS.norm).color || null);
            let activity = getUnit3DActivity(u);
            let unit2DTexture = get3DExact2DTexture(u, true);
            let unitTextureFallback = renderer3dExactTextureFallback;
            let unitStatus = unit2DTexture ? null : get3DUnitTextureStatus(u);
            let facingX = Number(u.vx) || 0, facingY = Number(u.vy) || 0;
            if (activity.target && Number.isFinite(activity.target.x) && Number.isFinite(activity.target.y)) {
                facingX = activity.target.x - u.x; facingY = activity.target.y - u.y;
            }
            let unitTint = get3DDamageFlashTint(u, get3DRenderOwnerColor(u.owner));
            let unitSideTint = get3DDamageFlashTint(u, unitSideColor || get3DRenderOwnerColor(u.owner));
            push3DRenderObject(objects, {
                modelKey: `unit_${u.unitType || 'norm'}`,
                x: ux / TILE + reactiveOffsetX * audioMove,
                y: getUnitHeightOffset(u),
                z: uy / TILE + reactiveOffsetY * audioMove,
                scaleX: footprint * modelScale,
                scaleY: Math.max(0.48, footprint * 1.45) * (1 + audioHeight) * modelScale,
                scaleZ: footprint * modelScale,
                visibilitySource: u,
                rotationY: Math.atan2(facingX, facingY || 0.0001),
                moveAmount: activity.amount || Math.min(1, Math.hypot(u.x - u.prevX, u.y - u.prevY) / Math.max(.01, TILE * .025)),
                walkPhase: _unit3DWalkPhase(u, activity),
                animationMode: activity.mode,
                weaponType: getUnit3DWeaponType(u),
                isFlying: !!u.isFlying,
                isWorker: !!u.isWorker,
                tint: unitTint,
                renderShape: 'cylinder',
                topTextureKey: unit2DTexture ? unit2DTexture._renderer3DExactKey : `unit:${u.unitType}:${u.owner}:${unitStatus.keySuffix}`,
                topTextureCanvas: unit2DTexture || get3DUnitTopTexture(u, u.owner, unitStatus),
                sideTint: unitSideTint,
            });
            renderer3dUnitObjects.set(u, { object: objects[objects.length - 1], tick: gameTime, view: view3DKey, activity,
                textureVersion: objects[objects.length - 1].topTextureCanvas && objects[objects.length - 1].topTextureCanvas._textureVersion,
                tint: unitTint, sideTint: unitSideTint, dynamic: !unit2DTexture || unitTextureFallback || !!getDamageFlashState(u) });
            if (!flat2d) pushUnit3DActivityEffects(objects, u, activity, ux / TILE, uy / TILE, footprint);
        }
    }

    if (flat2d) drainFlatObjects();
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
        if (flat2d) {
            _pushFlatProjectile(flatBatch, p, px / TILE + reactiveOffsetX * audioMove, py / TILE + reactiveOffsetY * audioMove);
            continue;
        }
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
        if (flat2d) {
            _pushFlatParticle(flatBatch, p, px / TILE + reactiveOffsetX * audioMove, py / TILE + reactiveOffsetY * audioMove);
            continue;
        }
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
        if (idleMs > RENDERER3D_OVERLAP_FADE_DURATION_MS) {
            renderer3dOverlapFadeState.delete(key);
        }
    }

    return {
        flat2d,
        viewportWidth: viewW,
        viewportHeight: viewH,
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
        flatBatch
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
    overlayCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    overlayCtx.clearRect(0, 0, viewW, viewH);
    overlayCanvas._interactionEmpty = !hasContent;
    if (!hasContent) return;

    if (renderer3dInstance && renderer3dSnapshot && renderer3dSnapshot.overlays && typeof renderer3dInstance.drawOverlay === 'function') {
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
    renderer3dInstance.resize(viewW, viewH);
    renderer3dInstance.setEnabled(true);
    syncRenderModeUi();
    return renderer3dInstance.supported ? renderer3dInstance : null;
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
function drawMinimap() {
    let nowMs = performance.now();
    let cameraKey = camera.x + '|' + camera.y + '|' + camera.zoom + '|' + renderDimensionMode + '|' + GRID_W;
    if (cameraKey === _minimapLastCameraKey && nowMs - _minimapLastDrawMs < 100 && nowMs >= _minimapLastDrawMs) return;
    _minimapLastDrawMs = nowMs;
    _minimapLastCameraKey = cameraKey;
    const units = getLiveRenderView().units;
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

    // Units
    for (let u of units) {
        if (u.dead) continue;
        let cgy = Math.floor(u.y / TILE), cgx = Math.floor(u.x / TILE);
        if (!fullVisibility && (!vis[cgy] || vis[cgy][cgx] === 0) && !u._historyGhost) continue;
        minimapCtx.globalAlpha = u._historyGhost ? .23 : 1;
        setMinimapFill(get3DRenderOwnerColor(u.owner));
        let ux = (u.x / TILE) * scale, uy = (u.y / TILE) * scale;
        minimapCtx.fillRect(ux, uy, 2, 2);
    }

    minimapCtx.globalAlpha = 1;
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
        let footprint = renderer3dInstance.getGroundFrustumPolygon(get3DProjectionSnapshot());
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

function computeVisibilityGridForPlayer(playerId, vis) {
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

    for (let u of units) {
        if (!u || u.dead) continue;
        if (!shouldRevealForPlayer(u.owner, u.watched || 0, u.watchedByTeam)) continue;
        let visionArea = getEntityEffectiveVisibilityRangeArea(u);
        addWorldVisibilitySource(u.x, u.y, visionArea);
    }
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

    if (visibilityCacheTick !== gameTime) {
        visibilityGridRawByPlayerCache.clear();
        visibilityCacheTick = gameTime;
    }
    let cachedRaw = visibilityGridRawByPlayerCache.get(pid);
    if (cachedRaw) return cachedRaw;
    let pool = visibilityGridPoolByPlayer.get(pid);
    if (!pool) visibilityGridPoolByPlayer.set(pid, pool = { grids: [null, null], next: 0, last: null, signature: null, signatureLength: -1,
        areaGrid: null, areaCells: null, misses: 0, skipUntil: -1 });
    // The grid is a pure function of the sources' tile windows and ranges
    // (and the area layout). Idle teams keep identical sources for many
    // ticks: reuse their last grid instead of recomputing it. A team whose
    // sources keep changing skips the comparison for a while.
    let now = typeof gameTime === 'number' ? gameTime : 0;
    let compare = !(pool.skipUntil > now && pool.skipUntil - now <= VISIBILITY_SIGNATURE_BACKOFF_TICKS);
    let signature = _visibilitySourceSignatureScratch, signatureLength = -1;
    if (compare) {
        if (pool.skipUntil >= 0) { pool.skipUntil = -1; pool.misses = 0; }
        signatureLength = _collectVisibilitySourceSignature(pid, signature);
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
    let rawVis = pool.grids[pool.next];
    if (!rawVis || rawVis.length !== GRID_H || (GRID_H > 0 && rawVis[0].length !== GRID_W)) {
        rawVis = pool.grids[pool.next] = createEmptyVisibilityGrid();
    }
    pool.next ^= 1;
    computeVisibilityGridForPlayer(pid, rawVis);
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
function _collectVisibilitySourceSignature(playerId, out) {
    let length = 0;
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

function isTileActuallyVisibleToPlayer(playerId, gx, gy) {
    if (gx < 0 || gx >= GRID_W || gy < 0 || gy >= GRID_H) return false;
    let pid = Math.floor(Number(playerId));
    if (!Number.isFinite(pid) || pid < 0) pid = localPlayerId;

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
    updateAllPlayerVisibility();
    visibilityGrid = updateVisualVisibility(targetPlayerId, getRawVisibilityGridForPlayer(targetPlayerId));
}

function updateAllPlayerVisibility() {
    let seen = new Set();
    let ids = [];
    let pushId = (value) => {
        let id = Math.floor(Number(value));
        if (!Number.isFinite(id) || id < 0 || seen.has(id)) return;
        seen.add(id);
        ids.push(id);
    };

    pushId(localPlayerId);
    for (let lp of (lobbyPlayers || [])) {
        if (!lp) continue;
        pushId(lp.teamId);
        pushId(lp.playerId);
        pushId(lp.owner);
    }
    if (Array.isArray(activeTeamIds)) for (let id of activeTeamIds) pushId(id);
    if (Array.isArray(players)) for (let i = 0; i < players.length; i++) pushId(i);

    if (!Array.isArray(visibilityGridByPlayer) || visibilityGridByPlayer.length < players.length) {
        visibilityGridByPlayer = Array.from({ length: players.length }, () => []);
    }
    for (let id of ids) {
        let vis = getRawVisibilityGridForPlayer(id);
        visibilityGridByPlayer[id] = vis || [];
    }
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
        _tickAccumulator = pumpSimulationTicks(timestamp, _tickAccumulator, 5);
    }
}

// Runs due ticks. In multiplayer a tick runs only once the host sealed it;
// while it is missing the accumulator holds one tick so it runs on arrival.
// A guest that fell behind the host (hidden tab, slow frame, reconnect) runs
// a few extra ticks per call until it is back to its normal buffer.
function pumpSimulationTicks(now, accumulator, maxTicks) {
    if (isMultiplayer) {
        netMaintain(now);
        driveStrictLockstep(now, currentTick);
        resyncHostFlushHashes(now);
    }
    let catchUp = 0;
    if (isMultiplayer && !isHost) {
        let buffered = getLockstepBufferedTicks();
        let normal = Math.max(2, Math.floor(Number(LOCKSTEP_PIPELINE_TICKS) || 0) + 2);
        if (buffered > normal) catchUp = Math.min(buffered - normal, buffered > normal * 4 ? 12 : 3);
    }
    let processed = 0;
    let limit = maxTicks + catchUp;
    while (processed < limit) {
        let due = accumulator >= TICK_MS;
        if (!due && catchUp <= 0) break;
        if (isMultiplayer && processed > 0) driveStrictLockstep(now, currentTick);
        if (isMultiplayer && !isStrictTickReady(currentTick)) {
            if (due) {
                // Deliberate pauses (start countdown, resync) are not stalls.
                let paused = lockstepResyncPauseActive || matchStartWaitingForReady || lockstepFatalStopActive || (!isHost && lockstepDesyncDetected);
                if (paused) netStallStartedAt = 0;
                else netNoteSimWaiting(true, now);
                if (!waitingForRemoteSince) waitingForRemoteSince = now;
                accumulator = Math.min(accumulator, TICK_MS);
            }
            break;
        }
        if (isMultiplayer) {
            // Resync patches: the host encodes one, or the guest applies one,
            // in its own frame; the tick runs in the next.
            if (isHost) {
                if (resyncHostBeforeTick(currentTick)) break;
            } else if (resyncGuest.T === currentTick) {
                let hadPatch = !!resyncGuest.patch;
                if (!resyncGuestBeforeTick(currentTick, now)) {
                    if (due) accumulator = Math.min(accumulator, TICK_MS);
                    break;
                }
                if (hadPatch) break;
            }
        }
        if (due) accumulator -= TICK_MS;
        else catchUp--;
        if (isMultiplayer) netNoteSimWaiting(false, now);
        waitingForRemoteSince = 0;
        runOneTick();
        processed++;
        if (gameOver) break;
    }
    return accumulator;
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
    let renderer3dSnapshot = null;
    let renderer3d = ensure3DRendererInitialized();
    if (renderer3d) {
        renderer3dSnapshot = build3DFrameData(renderDimensionMode === '2d');
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

// Frames are always queued again, even after an error, so one bad frame
// cannot freeze the game.
function simulationFrame(timestamp) {
    _simulationFrameHandle = 0;
    try { processVisibleSimulationFrame(timestamp); } catch (err) { reportRuntimeError('frame', err); }
    queueSimulationFrame();
}

function renderFrame(timestamp) {
    _renderFrameHandle = 0;
    try { processRenderFrame(timestamp); } catch (err) { reportRuntimeError('render', err); }
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
    if (target.watched > 0) {
        target.watched--;
        if (target.watched <= 0) target.watchedByTeam = -1;
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
    let preserveTextSprites = !!(options && options.preserveTextSprites);
    if (!preserveTextSprites) {
        LEVEL_TEXT_SPRITE_CACHE.clear();
        UNIT_LEVEL_TEXT_SPRITE_CACHE.clear();
        renderer3dTopTextureCache.clear();
        renderer3dExact2DTextureCache.clear();
        renderer3dFlatProjectileSprites.clear();
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
