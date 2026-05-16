"use strict";

const ASSET_PACK_STORAGE_KEY = 'defence3.asset-pack.v1';
const ASSET_EDITOR_FRAME_COUNT = 30;
const ASSET_EDITOR_FPS = 30;
const ASSET_EDITOR_DEFAULT_PACK_NAME = 'Default';
const ASSET_EDITOR_PLAYER_COLOR_TOKEN = '__player__';
const ASSET_EDITOR_CATEGORY_ORDER = ['barracks', 'towers', 'floor', 'special', 'units'];
const ASSET_EDITOR_CATEGORIES = {
    barracks: () => (BUILD_CATEGORIES && BUILD_CATEGORIES.barracks ? BUILD_CATEGORIES.barracks.slice() : []),
    towers: () => (BUILD_CATEGORIES && BUILD_CATEGORIES.towers ? BUILD_CATEGORIES.towers.slice() : []),
    floor: () => (BUILD_CATEGORIES && BUILD_CATEGORIES.floor ? BUILD_CATEGORIES.floor.slice() : []),
    special: () => (BUILD_CATEGORIES && BUILD_CATEGORIES.special ? BUILD_CATEGORIES.special.slice() : []),
    units: () => {
        let preferred = ['norm', 'fast', 'tank', 'boss', 'flying', 'mole', 'poison_resistant', 'fire_resistant', 'water_resistant', 'ice_resistant', 'laser_resistant', 'snake', 'scout', 'collector', 'astar_collector', 'salvager_unit', 'builder_unit', 'healer_unit', 'researcher_unit', 'king'];
        let all = Object.keys(BASE_UNIT_STATS || {});
        let out = [];
        for (let key of preferred) if (all.includes(key)) out.push(key);
        for (let key of all) if (!out.includes(key)) out.push(key);
        return out;
    }
};

let currentAssetPack = null;
let assetPackRevision = 1;
let _assetThumbnailCache = new Map();

function assetClone(value) {
    return JSON.parse(JSON.stringify(value));
}

function normalizeAssetHexColor(color) {
    let value = String(color || '').trim();
    if (value === ASSET_EDITOR_PLAYER_COLOR_TOKEN) return ASSET_EDITOR_PLAYER_COLOR_TOKEN;
    if (/^#[0-9a-f]{3}$/i.test(value)) {
        return '#' + value[1] + value[1] + value[2] + value[2] + value[3] + value[3];
    }
    if (/^#[0-9a-f]{6}$/i.test(value)) return value.toLowerCase();
    return '#c8ced8';
}

function resolveAssetPartColor(color, fallbackColor = '#c8ced8') {
    let value = normalizeAssetHexColor(color);
    if (value === ASSET_EDITOR_PLAYER_COLOR_TOKEN) return normalizeAssetHexColor(fallbackColor);
    return value;
}

function createEmptyAssetPack(name = ASSET_EDITOR_DEFAULT_PACK_NAME) {
    return {
        version: 1,
        name: String(name || ASSET_EDITOR_DEFAULT_PACK_NAME),
        overrides: {}
    };
}

function _nextAssetPartId() {
    return 'part_' + Math.random().toString(36).slice(2, 10);
}

function getAssetEditorCategoryItems(category) {
    let resolver = ASSET_EDITOR_CATEGORIES[category];
    return typeof resolver === 'function' ? resolver() : [];
}

function getAllAssetThingKeys() {
    let out = [];
    for (let category of ASSET_EDITOR_CATEGORY_ORDER) {
        for (let key of getAssetEditorCategoryItems(category)) {
            if (!out.includes(key)) out.push(key);
        }
    }
    return out;
}

function getThingAssetLabel(key) {
    if (BASE_CARD_TYPES && BASE_CARD_TYPES[key] && BASE_CARD_TYPES[key].name) return BASE_CARD_TYPES[key].name;
    if (BASE_UNIT_STATS && BASE_UNIT_STATS[key]) {
        if (DESCRIPTIONS && DESCRIPTIONS[key]) {
            let text = String(DESCRIPTIONS[key]).split('.')[0].trim();
            if (text) return text.length > 26 ? text.slice(0, 26) : text;
        }
        return String(key).replace(/_/g, ' ');
    }
    return String(key);
}

function getThingAssetCategory(key) {
    for (let category of ASSET_EDITOR_CATEGORY_ORDER) {
        if (getAssetEditorCategoryItems(category).includes(key)) return category;
    }
    return BASE_UNIT_STATS && BASE_UNIT_STATS[key] ? 'units' : 'special';
}

function getThingAssetAnimationKeys(key) {
    if (BASE_UNIT_STATS && BASE_UNIT_STATS[key]) {
        if (key === 'collector' || key === 'astar_collector' || key === 'salvager_unit' || key === 'builder_unit' || key === 'healer_unit' || key === 'researcher_unit') {
            return ['idle', 'move', 'work'];
        }
        return ['idle', 'move', 'attack'];
    }
    if (String(key).startsWith('barrack_')) return ['idle', 'spawn'];
    if (key === 'spawner' || key === 'astar_spawner' || key === 'salvager' || key === 'builder_spawner' || key === 'healer_spawner') return ['idle', 'spawn'];
    if (key === 'research') return ['idle', 'spawn', 'work'];
    if (BASE_CARD_TYPES && BASE_CARD_TYPES[key] && BASE_CARD_TYPES[key].target === 'wall') return ['idle', 'attack'];
    return ['idle'];
}

function normalizeAssetPart(part, index = 0) {
    let source = part && typeof part === 'object' ? part : {};
    let shape = source.shape === 'cylinder' ? 'cylinder' : 'box';
    return {
        id: source.id || _nextAssetPartId(),
        name: source.name || `${shape}_${index + 1}`,
        shape,
        locked: !!source.locked,
        x: Number(source.x) || 0,
        y: Number(source.y) || 0,
        z: Number(source.z) || 0,
        w: Math.max(2, Number(source.w) || 12),
        d: Math.max(2, Number(source.d) || 12),
        h: Math.max(2, Number(source.h) || 12),
        color: normalizeAssetHexColor(source.color)
    };
}

function normalizeAssetPartArray(parts) {
    let list = Array.isArray(parts) ? parts : [];
    return list.map((part, index) => normalizeAssetPart(part, index));
}

function getThingDefaultAssetDimensions(key) {
    if (BASE_UNIT_STATS && BASE_UNIT_STATS[key]) {
        let stats = BASE_UNIT_STATS[key] || {};
        let footprint = Math.max(0.28, Math.min(0.9, ((Math.max(5, Number(stats.r) || 8) * 2.2) / TILE)));
        return {
            shape: 'cylinder',
            w: Math.round(footprint * TILE),
            d: Math.round(footprint * TILE),
            h: Math.round(Math.max(0.32, footprint * 0.9) * TILE * 0.68),
            color: normalizeAssetHexColor(stats.color || '#c8ced8')
        };
    }
    if (String(key).startsWith('barrack_')) {
        let unitType = String(key).slice(8) || 'norm';
        let stats = (BASE_UNIT_STATS && BASE_UNIT_STATS[unitType]) ? BASE_UNIT_STATS[unitType] : null;
        return {
            shape: 'box',
            w: Math.round(0.98 * TILE),
            d: Math.round(0.98 * TILE),
            h: Math.round(0.86 * TILE * 0.46),
            color: normalizeAssetHexColor(stats && stats.color ? stats.color : '#686868')
        };
    }
    if (key === 'spawner' || key === 'astar_spawner' || key === 'salvager' || key === 'builder_spawner' || key === 'healer_spawner' || key === 'research') {
        let def = BASE_CARD_TYPES && BASE_CARD_TYPES[key] ? BASE_CARD_TYPES[key] : null;
        return {
            shape: 'box',
            w: Math.round(0.95 * TILE),
            d: Math.round(0.95 * TILE),
            h: Math.round(0.9 * TILE * 0.46),
            color: normalizeAssetHexColor(def && def.color ? def.color : '#8d949d')
        };
    }
    if (BASE_CARD_TYPES && BASE_CARD_TYPES[key] && BASE_CARD_TYPES[key].target === 'wall') {
        let def = BASE_CARD_TYPES[key] || {};
        return {
            shape: 'box',
            w: Math.round(0.82 * TILE),
            d: Math.round(0.82 * TILE),
            h: Math.round(1.05 * TILE * 0.5),
            color: normalizeAssetHexColor(def.color || '#8d949d')
        };
    }
    let def = BASE_CARD_TYPES && BASE_CARD_TYPES[key] ? BASE_CARD_TYPES[key] : {};
    return {
        shape: 'box',
        w: Math.round(0.84 * TILE),
        d: Math.round(0.84 * TILE),
        h: Math.max(4, Math.round(0.14 * TILE)),
        color: normalizeAssetHexColor(def.color || '#8d949d')
    };
}

function buildDefaultBasePartForThing(key) {
    let dims = getThingDefaultAssetDimensions(key);
    return normalizeAssetPart({
        id: 'base',
        name: 'base',
        shape: dims.shape,
        locked: true,
        x: 0,
        y: 0,
        z: 0,
        w: dims.w,
        d: dims.d,
        h: dims.h,
        color: dims.color
    }, 0);
}

function createDefaultThingAsset(key) {
    let baseParts = [buildDefaultBasePartForThing(key)];
    let animations = {};
    for (let animationName of getThingAssetAnimationKeys(key)) {
        animations[animationName] = {
            fps: ASSET_EDITOR_FPS,
            frames: buildDefaultAnimationFrames(key, baseParts, animationName)
        };
    }
    return {
        key,
        model: {
            parts: baseParts
        },
        animations
    };
}

function buildDefaultAnimationFrames(key, baseParts, animationName) {
    let frames = [];
    for (let index = 0; index < ASSET_EDITOR_FRAME_COUNT; index++) {
        let t = (index / ASSET_EDITOR_FRAME_COUNT) * Math.PI * 2;
        let partList = normalizeAssetPartArray(baseParts).map((part) => {
            let next = { ...part };
            if (animationName === 'idle') {
                next.z += Math.sin(t) * 0.8;
            } else if (animationName === 'move') {
                next.x += Math.sin(t) * 1.3;
                next.z += Math.abs(Math.cos(t)) * 1.4;
            } else if (animationName === 'attack') {
                next.y += Math.sin(t) * 1.8;
                next.h = Math.max(2, next.h + Math.sin(t) * 1.6);
            } else if (animationName === 'spawn') {
                let growth = 0.8 + (((index % ASSET_EDITOR_FRAME_COUNT) + 1) / ASSET_EDITOR_FRAME_COUNT) * 0.2;
                next.w *= growth;
                next.d *= growth;
                next.h *= growth;
                next.z += (1 - growth) * 6;
            } else if (animationName === 'work') {
                next.z += Math.sin(t * 2) * 1.2;
                next.w = Math.max(2, next.w + Math.sin(t * 2) * 0.8);
                next.d = Math.max(2, next.d + Math.cos(t * 2) * 0.8);
            }
            return normalizeAssetPart(next);
        });
        frames.push({ parts: partList });
    }
    return frames;
}

function normalizeAnimationFrame(frame, fallbackParts) {
    let parts = frame && Array.isArray(frame.parts) ? frame.parts : fallbackParts;
    return { parts: normalizeAssetPartArray(parts) };
}

function normalizeAnimation(framesLike, fallbackParts) {
    let source = framesLike && typeof framesLike === 'object' ? framesLike : {};
    let frames = Array.isArray(source.frames) ? source.frames.slice(0, ASSET_EDITOR_FRAME_COUNT) : [];
    while (frames.length < ASSET_EDITOR_FRAME_COUNT) {
        frames.push({ parts: assetClone(fallbackParts) });
    }
    return {
        fps: ASSET_EDITOR_FPS,
        frames: frames.map((frame) => normalizeAnimationFrame(frame, fallbackParts))
    };
}

function normalizeThingAssetOverride(key, rawAsset) {
    let fallback = createDefaultThingAsset(key);
    let source = rawAsset && typeof rawAsset === 'object' ? rawAsset : {};
    let modelParts = normalizeAssetPartArray(source.model && source.model.parts ? source.model.parts : fallback.model.parts);
    let animations = {};
    let animationNames = new Set([...getThingAssetAnimationKeys(key), ...Object.keys(source.animations || {})]);
    for (let animationName of animationNames) {
        let rawAnimation = source.animations && source.animations[animationName] ? source.animations[animationName] : null;
        animations[animationName] = normalizeAnimation(rawAnimation || fallback.animations[animationName], modelParts);
    }
    return {
        key,
        model: { parts: modelParts },
        animations
    };
}

function normalizeAssetPack(rawPack) {
    let source = rawPack && typeof rawPack === 'object' ? rawPack : {};
    let out = createEmptyAssetPack(source.name || ASSET_EDITOR_DEFAULT_PACK_NAME);
    let overrides = source.overrides && typeof source.overrides === 'object' ? source.overrides : {};
    for (let key of Object.keys(overrides)) {
        if (!getAllAssetThingKeys().includes(key)) continue;
        out.overrides[key] = normalizeThingAssetOverride(key, overrides[key]);
    }
    return out;
}

function getAssetPackSnapshot() {
    return normalizeAssetPack(currentAssetPack || createEmptyAssetPack());
}

function getCurrentAssetPackName() {
    let pack = currentAssetPack || createEmptyAssetPack();
    return pack.name || ASSET_EDITOR_DEFAULT_PACK_NAME;
}

function _saveAssetPackToStorage() {
    try {
        localStorage.setItem(ASSET_PACK_STORAGE_KEY, JSON.stringify(getAssetPackSnapshot()));
    } catch { }
}

function _markAssetPackDirty() {
    assetPackRevision++;
    _assetThumbnailCache.clear();
    _saveAssetPackToStorage();
    updateAssetPackLobbyUi();
    if (typeof requestBuildMenuRefresh === 'function') requestBuildMenuRefresh();
}

function loadAssetPackFromStorage() {
    try {
        let raw = localStorage.getItem(ASSET_PACK_STORAGE_KEY);
        if (!raw) return createEmptyAssetPack();
        return normalizeAssetPack(JSON.parse(raw));
    } catch {
        return createEmptyAssetPack();
    }
}

function setCurrentAssetPack(rawPack, opts = {}) {
    currentAssetPack = normalizeAssetPack(rawPack);
    if (opts.name) currentAssetPack.name = String(opts.name);
    _markAssetPackDirty();
}

function updateAssetPackLobbyUi() {
    let nameEl = document.getElementById('asset-pack-name');
    let packName = getCurrentAssetPackName();
    if (nameEl) nameEl.textContent = packName;
    let editorNameEl = document.getElementById('asset-editor-pack-name');
    if (editorNameEl) editorNameEl.textContent = packName;
    let editorNameInput = document.getElementById('asset-editor-pack-name-input');
    if (editorNameInput && document.activeElement !== editorNameInput) editorNameInput.value = packName;
}

function initAssetSystem() {
    currentAssetPack = loadAssetPackFromStorage();
    updateAssetPackLobbyUi();
    let saveBtn = document.getElementById('btn-assets-save');
    let loadBtn = document.getElementById('btn-assets-load');
    let fileInput = document.getElementById('input-import-assets');
    if (saveBtn && !saveBtn.dataset.assetPackBound) {
        saveBtn.dataset.assetPackBound = '1';
        bindInstantPress(saveBtn, () => downloadCurrentAssetPack());
    }
    if (loadBtn && fileInput && !loadBtn.dataset.assetPackBound) {
        loadBtn.dataset.assetPackBound = '1';
        bindInstantPress(loadBtn, () => fileInput.click());
        fileInput.addEventListener('change', (ev) => {
            let file = ev.target && ev.target.files ? ev.target.files[0] : null;
            if (file) importAssetPackFromFile(file);
            fileInput.value = '';
        });
    }
}

function downloadCurrentAssetPack() {
    let blob = new Blob([JSON.stringify(getAssetPackSnapshot(), null, 2)], { type: 'application/json' });
    let url = URL.createObjectURL(blob);
    let a = document.createElement('a');
    let stamp = new Date().toISOString().replace(/[:.]/g, '-');
    a.href = url;
    a.download = `defence3-assets-${stamp}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    if (typeof showUiBanner === 'function') showUiBanner('Asset pack downloaded.', 'success');
}

function importAssetPackFromFile(file) {
    if (!file) return;
    let reader = new FileReader();
    reader.onload = () => {
        try {
            let parsed = JSON.parse(String(reader.result || '{}'));
            setCurrentAssetPack(parsed);
            if (typeof showUiBanner === 'function') showUiBanner('Asset pack loaded.', 'success');
            if (typeof renderAssetEditor === 'function') renderAssetEditor();
        } catch {
            if (typeof showUiBanner === 'function') showUiBanner('Invalid asset JSON.', 'error', 3600);
        }
    };
    reader.readAsText(file);
}

function getThingAssetOverride(key) {
    let pack = currentAssetPack || createEmptyAssetPack();
    return pack.overrides && pack.overrides[key] ? pack.overrides[key] : null;
}

function getThingAsset(key) {
    let override = getThingAssetOverride(key);
    if (override) return normalizeThingAssetOverride(key, override);
    return createDefaultThingAsset(key);
}

function getEditableThingAssetSnapshot(key) {
    return assetClone(getThingAsset(key));
}

function saveThingAssetOverride(key, asset, options = {}) {
    let pack = currentAssetPack || createEmptyAssetPack();
    pack.overrides[key] = normalizeThingAssetOverride(key, asset);
    if (options.packName) pack.name = String(options.packName);
    currentAssetPack = pack;
    _markAssetPackDirty();
}

function clearThingAssetOverride(key) {
    let pack = currentAssetPack || createEmptyAssetPack();
    if (pack.overrides && pack.overrides[key]) {
        delete pack.overrides[key];
        currentAssetPack = pack;
        _markAssetPackDirty();
    }
}

function renameCurrentAssetPack(nextName) {
    let pack = currentAssetPack || createEmptyAssetPack();
    pack.name = String(nextName || ASSET_EDITOR_DEFAULT_PACK_NAME).trim() || ASSET_EDITOR_DEFAULT_PACK_NAME;
    currentAssetPack = pack;
    _markAssetPackDirty();
}

function ensureThingAssetAnimation(asset, animationName) {
    if (!asset || typeof asset !== 'object') return null;
    if (!asset.animations) asset.animations = {};
    if (!asset.animations[animationName]) {
        asset.animations[animationName] = {
            fps: ASSET_EDITOR_FPS,
            frames: buildDefaultAnimationFrames(asset.key, normalizeAssetPartArray(asset.model && asset.model.parts), animationName)
        };
    }
    asset.animations[animationName] = normalizeAnimation(asset.animations[animationName], normalizeAssetPartArray(asset.model && asset.model.parts));
    return asset.animations[animationName];
}

function resetThingAnimationFrameToModel(asset, animationName, frameIndex) {
    let animation = ensureThingAssetAnimation(asset, animationName);
    if (!animation) return;
    let idx = Math.max(0, Math.min(ASSET_EDITOR_FRAME_COUNT - 1, Math.floor(frameIndex || 0)));
    animation.frames[idx] = { parts: normalizeAssetPartArray(asset.model && asset.model.parts) };
}

function _getAssetAnimationNameForEntity(entity) {
    if (!entity) return 'idle';
    let key = getThingAssetKeyForEntity(entity);
    let available = getThingAssetAnimationKeys(key);
    let preferred = 'idle';
    if (BASE_UNIT_STATS && BASE_UNIT_STATS[key]) {
        if (entity.attackFlash > 0 || entity.commandState === CMD_ATTACKING || entity.commandState === CMD_ATTACK_MOVING) preferred = 'attack';
        else if (entity.workerState && entity.workerState !== 'IDLE' && entity.workerState !== 'MANUAL_MOVE') preferred = 'work';
        else if (entity.commandState === CMD_MOVING || entity.vx || entity.vy) preferred = 'move';
    } else if (entity.type === 'research') {
        if (entity.isResearching) preferred = 'work';
        else if (Array.isArray(entity.spawnQueue) && entity.spawnQueue.length > 0) preferred = 'spawn';
    } else if (entity.type === 'barrack' || entity.type === 'spawner' || entity.type === 'astar_spawner' || entity.type === 'salvager' || entity.type === 'builder_spawner' || entity.type === 'healer_spawner') {
        if (Array.isArray(entity.spawnQueue) && entity.spawnQueue.length > 0) preferred = 'spawn';
    } else if (entity.type && BASE_CARD_TYPES && BASE_CARD_TYPES[entity.type] && BASE_CARD_TYPES[entity.type].target === 'wall') {
        if (entity.laserState === 1 || entity.cd > 0) preferred = 'attack';
    }
    return available.includes(preferred) ? preferred : available[0];
}

function getThingAssetKeyForEntity(entity) {
    if (!entity) return '';
    if (entity.unitType) return entity.unitType;
    if (entity.type === 'barrack' && entity.unitType) return `barrack_${entity.unitType}`;
    if (entity.type) return entity.type;
    return '';
}

function _getAnimationFrameIndex(animation) {
    let fps = Math.max(1, Number(animation && animation.fps) || ASSET_EDITOR_FPS);
    let baseTime = Number.isFinite(gameTime) ? gameTime / Math.max(1, TICK_RATE || 20) : performance.now() / 1000;
    return Math.floor(baseTime * fps) % ASSET_EDITOR_FRAME_COUNT;
}

function _assetColorToRgb(color) {
    let value = resolveAssetPartColor(color, '#c8ced8');
    if (/^#[0-9a-f]{3}$/i.test(value)) {
        value = '#' + value[1] + value[1] + value[2] + value[2] + value[3] + value[3];
    }
    if (!/^#[0-9a-f]{6}$/i.test(value)) return { r: 200, g: 206, b: 216 };
    return {
        r: parseInt(value.slice(1, 3), 16),
        g: parseInt(value.slice(3, 5), 16),
        b: parseInt(value.slice(5, 7), 16)
    };
}

function _shadeAssetColor(color, mul, fallbackColor = '#c8ced8') {
    let rgb = _assetColorToRgb(resolveAssetPartColor(color, fallbackColor));
    let clamp = (v) => Math.max(0, Math.min(255, Math.round(v)));
    return `rgb(${clamp(rgb.r * mul)}, ${clamp(rgb.g * mul)}, ${clamp(rgb.b * mul)})`;
}

function getThingAssetHorizontalRadius(parts) {
    let best = 0;
    for (let part of normalizeAssetPartArray(parts)) {
        let hw = Math.max(0.5, Number(part.w) || 0) * 0.5;
        let hd = Math.max(0.5, Number(part.d) || 0) * 0.5;
        let x0 = (Number(part.x) || 0) - hw;
        let x1 = (Number(part.x) || 0) + hw;
        let y0 = (Number(part.y) || 0) - hd;
        let y1 = (Number(part.y) || 0) + hd;
        best = Math.max(best,
            Math.hypot(x0, y0),
            Math.hypot(x0, y1),
            Math.hypot(x1, y0),
            Math.hypot(x1, y1));
    }
    return Math.max(1, best);
}

function _projectAssetPoint(originX, originY, scale, x, y, z) {
    return {
        x: originX + ((x - y) * 0.72 * scale),
        y: originY + ((x + y) * 0.38 * scale) - (z * scale)
    };
}

function _drawAssetBoxPart(ctx, part, originX, originY, scale) {
    let x0 = part.x - part.w / 2;
    let x1 = part.x + part.w / 2;
    let y0 = part.y - part.d / 2;
    let y1 = part.y + part.d / 2;
    let z0 = part.z;
    let z1 = part.z + part.h;

    let p000 = _projectAssetPoint(originX, originY, scale, x0, y0, z0);
    let p100 = _projectAssetPoint(originX, originY, scale, x1, y0, z0);
    let p110 = _projectAssetPoint(originX, originY, scale, x1, y1, z0);
    let p010 = _projectAssetPoint(originX, originY, scale, x0, y1, z0);
    let p001 = _projectAssetPoint(originX, originY, scale, x0, y0, z1);
    let p101 = _projectAssetPoint(originX, originY, scale, x1, y0, z1);
    let p111 = _projectAssetPoint(originX, originY, scale, x1, y1, z1);
    let p011 = _projectAssetPoint(originX, originY, scale, x0, y1, z1);

    ctx.beginPath();
    ctx.moveTo(p001.x, p001.y);
    ctx.lineTo(p101.x, p101.y);
    ctx.lineTo(p111.x, p111.y);
    ctx.lineTo(p011.x, p011.y);
    ctx.closePath();
    ctx.fillStyle = _shadeAssetColor(part.color, 1.16);
    ctx.fill();

    ctx.beginPath();
    ctx.moveTo(p100.x, p100.y);
    ctx.lineTo(p110.x, p110.y);
    ctx.lineTo(p111.x, p111.y);
    ctx.lineTo(p101.x, p101.y);
    ctx.closePath();
    ctx.fillStyle = _shadeAssetColor(part.color, 0.9);
    ctx.fill();

    ctx.beginPath();
    ctx.moveTo(p010.x, p010.y);
    ctx.lineTo(p110.x, p110.y);
    ctx.lineTo(p111.x, p111.y);
    ctx.lineTo(p011.x, p011.y);
    ctx.closePath();
    ctx.fillStyle = _shadeAssetColor(part.color, 0.72);
    ctx.fill();

    ctx.strokeStyle = _shadeAssetColor(part.color, 0.45);
    ctx.lineWidth = Math.max(1, scale * 0.8);
    ctx.stroke();
}

function _drawAssetCylinderPart(ctx, part, originX, originY, scale) {
    let base = _projectAssetPoint(originX, originY, scale, part.x, part.y, part.z);
    let top = _projectAssetPoint(originX, originY, scale, part.x, part.y, part.z + part.h);
    let rx = Math.max(2, part.w * 0.24 * scale);
    let ry = Math.max(1.2, part.d * 0.12 * scale);

    ctx.beginPath();
    ctx.ellipse(base.x, base.y, rx, ry, 0, 0, Math.PI);
    ctx.lineTo(top.x - rx, top.y);
    ctx.ellipse(top.x, top.y, rx, ry, 0, Math.PI, 0, true);
    ctx.closePath();
    ctx.fillStyle = _shadeAssetColor(part.color, 0.82);
    ctx.fill();

    ctx.beginPath();
    ctx.ellipse(top.x, top.y, rx, ry, 0, 0, Math.PI * 2);
    ctx.fillStyle = _shadeAssetColor(part.color, 1.12);
    ctx.fill();
    ctx.strokeStyle = _shadeAssetColor(part.color, 0.45);
    ctx.lineWidth = Math.max(1, scale * 0.8);
    ctx.stroke();
}

function getThing3DPreviewProfile(key, options = {}) {
    let owner = Number.isFinite(options.owner) ? options.owner : 0;
    let ownerColor = typeof get3DRenderOwnerColor === 'function'
        ? get3DRenderOwnerColor(owner)
        : ((PLAYER_COLORS && PLAYER_COLORS[owner]) || '#c8ced8');
    if (BASE_UNIT_STATS && BASE_UNIT_STATS[key]) {
        let unitStub = {
            unitType: key,
            owner,
            energy: (BASE_UNIT_STATS[key] && BASE_UNIT_STATS[key].energy) || 1,
            maxEnergy: (BASE_UNIT_STATS[key] && BASE_UNIT_STATS[key].energy) || 1,
            carryingValue: 0,
            workerType: null,
            workerState: 'IDLE',
            researcherHasMaterial: false
        };
        let status = typeof get3DUnitTextureStatus === 'function'
            ? get3DUnitTextureStatus(unitStub)
            : { keySuffix: '', bars: [] };
        return {
            renderShape: 'cylinder',
            topTextureCanvas: typeof get3DUnitTopTexture === 'function' ? get3DUnitTopTexture(unitStub, owner, status) : null,
            tint: '#c8ced8'
        };
    }
    if (String(key).startsWith('barrack_')) {
        let unitType = String(key).slice(8) || 'norm';
        return {
            renderShape: 'box',
            topTextureCanvas: typeof get3DBuildingTopTexture === 'function'
                ? get3DBuildingTopTexture('barrack', owner, { subtype: unitType, color: ((BASE_UNIT_STATS[unitType] || BASE_UNIT_STATS.norm || {}).color || '#fff'), status: { keySuffix: '', bars: [] }, statusKey: '' })
                : null,
            tint: '#c8ced8'
        };
    }
    if (key === 'spawner' || key === 'astar_spawner' || key === 'salvager' || key === 'builder_spawner' || key === 'healer_spawner' || key === 'research') {
        let kind = key === 'astar_spawner' ? 'spawner_astar'
            : key === 'salvager' ? 'spawner_salvager'
                : key === 'builder_spawner' ? 'spawner_builder'
                    : key === 'healer_spawner' ? 'spawner_healer'
                        : key === 'research' ? 'spawner_research'
                            : 'spawner_energy';
        return {
            renderShape: 'box',
            topTextureCanvas: typeof get3DBuildingTopTexture === 'function'
                ? get3DBuildingTopTexture(kind, owner, { subtype: key, status: { keySuffix: '', bars: [] }, statusKey: '' })
                : null,
            tint: '#c8ced8'
        };
    }
    if (BASE_CARD_TYPES && BASE_CARD_TYPES[key] && BASE_CARD_TYPES[key].target === 'wall') {
        let def = BASE_CARD_TYPES[key] || {};
        return {
            renderShape: 'box',
            topTextureCanvas: typeof get3DBuildingTopTexture === 'function'
                ? get3DBuildingTopTexture('tower', owner, { subtype: key, color: def.color || '#999', angle: 0, angleKey: 0, active: true, status: { keySuffix: '', bars: [] }, statusKey: '' })
                : null,
            tint: '#c8ced8'
        };
    }
    if (BASE_CARD_TYPES && BASE_CARD_TYPES[key]) {
        let itemStub = { type: key, owner, energy: 1, maxEnergy: 1 };
        return {
            renderShape: 'box',
            topTextureCanvas: typeof get3DTopTextureForFloorItem === 'function' ? get3DTopTextureForFloorItem(itemStub, { keySuffix: '', bars: [] }) : null,
            tint: '#c8ced8'
        };
    }
    return { renderShape: 'box', topTextureCanvas: null, tint: '#c8ced8' };
}

function buildThingAsset3DObjects(entityOrKey, baseObject = {}, options = {}) {
    let key = typeof entityOrKey === 'string' ? entityOrKey : getThingAssetKeyForEntity(entityOrKey);
    if (!key || !getThingAssetOverride(key)) return null;
    let asset = getThingAsset(key);
    let animationName = options.animation || (typeof entityOrKey === 'string' ? 'idle' : _getAssetAnimationNameForEntity(entityOrKey));
    let animation = asset.animations[animationName] || asset.animations.idle;
    let frameIndex = Number.isFinite(options.frameIndex) ? Math.floor(options.frameIndex) : _getAnimationFrameIndex(animation);
    frameIndex = Math.max(0, Math.min(ASSET_EDITOR_FRAME_COUNT - 1, frameIndex));
    let frame = animation && Array.isArray(animation.frames) ? animation.frames[frameIndex] : null;
    let parts = frame && Array.isArray(frame.parts) ? frame.parts : (asset.model && Array.isArray(asset.model.parts) ? asset.model.parts : []);
    if (!Array.isArray(parts) || parts.length <= 0) return null;

    let originX = Number(baseObject.x) || 0;
    let originY = Number(baseObject.y) || 0;
    let originZ = Number(baseObject.z) || 0;
    let rotationY = Number(baseObject.rotationY) || 0;
    let cos = Math.cos(rotationY);
    let sin = Math.sin(rotationY);
    let verticalScale = Math.max(0.05, Number(options.verticalScale) || 1);
    let alpha = Math.max(0.05, Math.min(1, Number(baseObject.alpha) || 1));
    let tint = baseObject.tint || '#c8ced8';
    let profile = getThing3DPreviewProfile(key, { owner: Number.isFinite(options.owner) ? options.owner : 0 });
    let basePartId = options.basePartId || 'base';
    let localRadius = getThingAssetHorizontalRadius(parts) / TILE;
    let targetRadius = Math.max(0.05, Number(baseObject.scaleX) || Number(baseObject.scaleZ) || 0.5);
    let horizontalScale = Math.max(0.05, targetRadius / Math.max(0.05, localRadius));

    return normalizeAssetPartArray(parts).map((part, index) => {
        let localX = (Number(part.x) || 0) / TILE;
        let localZ = (Number(part.y) || 0) / TILE;
        let localY = (Number(part.z) || 0) / TILE;
        let resolvedColor = resolveAssetPartColor(part.color, tint);
        return {
            modelKey: 'cube',
            x: originX + ((localX * horizontalScale) * cos) - ((localZ * horizontalScale) * sin),
            y: originY + (localY * horizontalScale * verticalScale),
            z: originZ + ((localX * horizontalScale) * sin) + ((localZ * horizontalScale) * cos),
            scaleX: Math.max(0.05, ((Number(part.w) || 0) / TILE) * horizontalScale),
            scaleY: Math.max(0.05, ((Number(part.h) || 0) / TILE) * horizontalScale * verticalScale),
            scaleZ: Math.max(0.05, ((Number(part.d) || 0) / TILE) * horizontalScale),
            rotationY,
            tint: resolvedColor,
            alpha,
            renderShape: part.shape === 'cylinder' ? 'cylinder' : 'box',
            topTextureKey: (index === 0 || part.id === basePartId || part.locked) && baseObject.topTextureKey ? `${baseObject.topTextureKey}:asset` : '',
            topTextureCanvas: (index === 0 || part.id === basePartId || part.locked) ? (baseObject.topTextureCanvas || profile.topTextureCanvas || null) : null
        };
    });
}

function _drawTextureIntoPolygonBounds(ctx, textureCanvas, points) {
    if (!ctx || !textureCanvas || !Array.isArray(points) || points.length <= 0) return;
    let xs = points.map((point) => point.x);
    let ys = points.map((point) => point.y);
    let minX = Math.min(...xs);
    let maxX = Math.max(...xs);
    let minY = Math.min(...ys);
    let maxY = Math.max(...ys);
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let index = 1; index < points.length; index++) ctx.lineTo(points[index].x, points[index].y);
    ctx.closePath();
    ctx.clip();
    ctx.drawImage(textureCanvas, minX, minY, Math.max(1, maxX - minX), Math.max(1, maxY - minY));
    ctx.restore();
}

function drawThingAssetEditorPreview(ctx, key, parts, options = {}) {
    if (!ctx || !key) return false;
    let drawParts = normalizeAssetPartArray(parts).slice();
    if (drawParts.length <= 0) return false;
    let originX = Number.isFinite(options.originX) ? options.originX : 0;
    let originY = Number.isFinite(options.originY) ? options.originY : 0;
    let scale = Math.max(0.04, Number.isFinite(options.scale) ? options.scale : 0.34);
    let profile = getThing3DPreviewProfile(key, options);
    let previewTint = options.tint
        || (typeof get2DRenderOwnerColor === 'function' ? get2DRenderOwnerColor(Number.isFinite(options.owner) ? options.owner : 0) : '#6cb7ff');
    drawParts.sort((a, b) => (a.x + a.y + a.z) - (b.x + b.y + b.z));
    for (let index = 0; index < drawParts.length; index++) {
        let part = drawParts[index];
        let isBase = index === 0 || part.id === 'base' || part.locked;
        let resolvedColor = resolveAssetPartColor(part.color, previewTint);
        if (part.shape === 'cylinder') {
            let base = _projectAssetPoint(originX, originY, scale, part.x, part.y, part.z);
            let top = _projectAssetPoint(originX, originY, scale, part.x, part.y, part.z + part.h);
            let rx = Math.max(2, part.w * 0.24 * scale);
            let ry = Math.max(1.2, part.d * 0.12 * scale);

            ctx.beginPath();
            ctx.ellipse(base.x, base.y, rx, ry, 0, 0, Math.PI);
            ctx.lineTo(top.x - rx, top.y);
            ctx.ellipse(top.x, top.y, rx, ry, 0, Math.PI, 0, true);
            ctx.closePath();
            ctx.fillStyle = _shadeAssetColor(resolvedColor, 0.78, previewTint);
            ctx.fill();

            ctx.beginPath();
            ctx.ellipse(top.x, top.y, rx, ry, 0, 0, Math.PI * 2);
            ctx.fillStyle = _shadeAssetColor(resolvedColor, 1.02, previewTint);
            ctx.fill();
            if (isBase && profile.topTextureCanvas) {
                _drawTextureIntoPolygonBounds(ctx, profile.topTextureCanvas, [
                    { x: top.x - rx, y: top.y - ry },
                    { x: top.x + rx, y: top.y - ry },
                    { x: top.x + rx, y: top.y + ry },
                    { x: top.x - rx, y: top.y + ry }
                ]);
            }
            ctx.strokeStyle = _shadeAssetColor(resolvedColor, 0.42, previewTint);
            ctx.lineWidth = Math.max(1, scale * 0.7);
            ctx.stroke();
            continue;
        }

        let x0 = part.x - part.w / 2;
        let x1 = part.x + part.w / 2;
        let y0 = part.y - part.d / 2;
        let y1 = part.y + part.d / 2;
        let z0 = part.z;
        let z1 = part.z + part.h;
        let p100 = _projectAssetPoint(originX, originY, scale, x1, y0, z0);
        let p110 = _projectAssetPoint(originX, originY, scale, x1, y1, z0);
        let p010 = _projectAssetPoint(originX, originY, scale, x0, y1, z0);
        let p001 = _projectAssetPoint(originX, originY, scale, x0, y0, z1);
        let p101 = _projectAssetPoint(originX, originY, scale, x1, y0, z1);
        let p111 = _projectAssetPoint(originX, originY, scale, x1, y1, z1);
        let p011 = _projectAssetPoint(originX, originY, scale, x0, y1, z1);

        ctx.beginPath();
        ctx.moveTo(p001.x, p001.y);
        ctx.lineTo(p101.x, p101.y);
        ctx.lineTo(p111.x, p111.y);
        ctx.lineTo(p011.x, p011.y);
        ctx.closePath();
        ctx.fillStyle = _shadeAssetColor(resolvedColor, 1.04, previewTint);
        ctx.fill();
        if (isBase && profile.topTextureCanvas) _drawTextureIntoPolygonBounds(ctx, profile.topTextureCanvas, [p001, p101, p111, p011]);

        ctx.beginPath();
        ctx.moveTo(p100.x, p100.y);
        ctx.lineTo(p110.x, p110.y);
        ctx.lineTo(p111.x, p111.y);
        ctx.lineTo(p101.x, p101.y);
        ctx.closePath();
        ctx.fillStyle = _shadeAssetColor(resolvedColor, 0.76, previewTint);
        ctx.fill();

        ctx.beginPath();
        ctx.moveTo(p010.x, p010.y);
        ctx.lineTo(p110.x, p110.y);
        ctx.lineTo(p111.x, p111.y);
        ctx.lineTo(p011.x, p011.y);
        ctx.closePath();
        ctx.fillStyle = _shadeAssetColor(resolvedColor, 0.62, previewTint);
        ctx.fill();

        ctx.strokeStyle = _shadeAssetColor(resolvedColor, 0.4, previewTint);
        ctx.lineWidth = Math.max(1, scale * 0.7);
        ctx.beginPath();
        ctx.moveTo(p001.x, p001.y);
        ctx.lineTo(p101.x, p101.y);
        ctx.lineTo(p111.x, p111.y);
        ctx.lineTo(p011.x, p011.y);
        ctx.closePath();
        ctx.stroke();
    }
    return true;
}

function _drawAssetParts(ctx, parts, originX, originY, scale) {
    let drawParts = normalizeAssetPartArray(parts).slice();
    drawParts.sort((a, b) => (a.x + a.y + a.z) - (b.x + b.y + b.z));
    for (let part of drawParts) {
        if (part.shape === 'cylinder') _drawAssetCylinderPart(ctx, part, originX, originY, scale);
        else _drawAssetBoxPart(ctx, part, originX, originY, scale);
    }
}

function drawThingAsset2D(ctx, entityOrKey, options = {}) {
    if (!ctx || !entityOrKey) return false;
    let key = typeof entityOrKey === 'string' ? entityOrKey : getThingAssetKeyForEntity(entityOrKey);
    if (!key) return false;
    let asset = getThingAsset(key);
    let animationName = options.animation || (typeof entityOrKey === 'string' ? 'idle' : _getAssetAnimationNameForEntity(entityOrKey));
    let animation = asset.animations[animationName] || asset.animations.idle;
    let frameIndex = Number.isFinite(options.frameIndex) ? Math.floor(options.frameIndex) : _getAnimationFrameIndex(animation);
    frameIndex = Math.max(0, Math.min(ASSET_EDITOR_FRAME_COUNT - 1, frameIndex));
    let frame = animation && animation.frames ? animation.frames[frameIndex] : null;
    let parts = frame && Array.isArray(frame.parts) ? frame.parts : asset.model.parts;
    if (!Array.isArray(parts) || parts.length <= 0) return false;

    let originX = Number.isFinite(options.originX) ? options.originX : (entityOrKey.x || 0);
    let originY = Number.isFinite(options.originY) ? options.originY : ((entityOrKey.y || 0) + 10);
    let scale = Math.max(0.04, Number.isFinite(options.scale) ? options.scale : 0.34);
    ctx.save();
    if (options.alpha !== undefined) ctx.globalAlpha *= Math.max(0, Math.min(1, options.alpha));
    _drawAssetParts(ctx, parts, originX, originY, scale);
    ctx.restore();
    return true;
}

function getThingAssetThumbnailDataUrl(key, size) {
    let cacheKey = `${assetPackRevision}|${key}|${size}`;
    if (_assetThumbnailCache.has(cacheKey)) return _assetThumbnailCache.get(cacheKey);
    let dpr = window.devicePixelRatio || 1;
    let canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(size * dpr));
    canvas.height = Math.max(1, Math.round(size * dpr));
    let ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.imageSmoothingEnabled = false;
    let asset = getThingAsset(key);
    let parts = asset && asset.model && Array.isArray(asset.model.parts) ? asset.model.parts : [buildDefaultBasePartForThing(key)];
    drawThingAssetEditorPreview(ctx, key, parts, {
        originX: size * 0.5,
        originY: size * 0.74,
        scale: Math.max(0.18, size / 52)
    });
    let url = canvas.toDataURL();
    _assetThumbnailCache.set(cacheKey, url);
    return url;
}