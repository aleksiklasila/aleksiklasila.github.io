"use strict";

const ASSET_EDITOR_VOXEL_WIDTH = 16;
const ASSET_EDITOR_VOXEL_DEPTH = 16;
const ASSET_EDITOR_VOXEL_HEIGHT = 48;
const ASSET_EDITOR_VOXEL_SIZE = 2;
const ASSET_EDITOR_CAMERA_MOVE_SPEED = 1.8;
const ASSET_EDITOR_CAMERA_VERTICAL_SPEED = 1.5;
const ASSET_EDITOR_CAMERA_MIN_Y = -8;
const ASSET_EDITOR_CAMERA_MAX_Y = 6;
const ASSET_EDITOR_LOOK_SPEED = 0.0034;
const ASSET_EDITOR_VOXEL_PALETTE = [
    ASSET_EDITOR_PLAYER_COLOR_TOKEN,
    '#f4f7fb',
    '#d8dee8',
    '#9ca8b5',
    '#3d4752',
    '#1b2128',
    '#c06a4d',
    '#e8bf63',
    '#80b96c',
    '#4ea2d9',
    '#7566c6',
    '#d3699b'
];

let assetEditorState = {
    open: false,
    activeCategory: 'barracks',
    selectedKey: 'barrack_norm',
    selectedAnimation: 'idle',
    selectedFrame: 0,
    play: false,
    lastFrameAt: 0,
    workingAssets: {},
    previewRenderer: null,
    previewRendererFailed: false,
    selectedColor: ASSET_EDITOR_PLAYER_COLOR_TOKEN,
    cursorRadius: 0,
    activeLayer: 0,
    voxelCanvasMetrics: null,
    cameraCenterX: 0,
    cameraCenterY: 1.25,
    cameraCenterZ: 0,
    movementKeys: {},
    viewportHover: null,
    viewportPointer: null,
    viewportDrag: null,
    pointerLocked: false,
    lastTickAt: 0
};

function getAssetEditorThingEnergyCost(key) {
    if (typeof getBuildMenuEnergyCost === 'function' && BASE_CARD_TYPES && BASE_CARD_TYPES[key]) return getBuildMenuEnergyCost(key, 1);
    if (String(key).startsWith('barrack_')) {
        let unitType = String(key).slice(8);
        let stats = BASE_UNIT_STATS && BASE_UNIT_STATS[unitType] ? BASE_UNIT_STATS[unitType] : null;
        return Math.max(0, Number(stats && stats.energy) || 0);
    }
    if (BASE_UNIT_STATS && BASE_UNIT_STATS[key]) return Math.max(0, Number(BASE_UNIT_STATS[key].energy) || 0);
    if (BASE_CARD_TYPES && BASE_CARD_TYPES[key]) return Math.max(0, Number(BASE_CARD_TYPES[key].energy) || 0);
    return 0;
}

function clampAssetEditorValue(value, min, max) {
    return Math.max(min, Math.min(max, Math.floor(value)));
}

function getAssetEditorAnimationNames(asset) {
    if (!asset) return ['idle'];
    for (let animationName of getThingAssetAnimationKeys(asset.key || assetEditorState.selectedKey)) {
        ensureThingAssetAnimation(asset, animationName);
    }
    let names = Object.keys(asset.animations || {}).filter(Boolean);
    if (!names.includes('idle')) names.unshift('idle');
    return names;
}

function syncAssetEditorAnimationSelection(asset) {
    let names = getAssetEditorAnimationNames(asset);
    if (!names.includes(assetEditorState.selectedAnimation)) assetEditorState.selectedAnimation = names[0] || 'idle';
    assetEditorState.selectedFrame = clampAssetEditorValue(assetEditorState.selectedFrame || 0, 0, ASSET_EDITOR_FRAME_COUNT - 1);
    assetEditorState.activeLayer = clampAssetEditorValue(assetEditorState.activeLayer || 0, 0, ASSET_EDITOR_VOXEL_HEIGHT - 1);
}

function ensureWorkingAsset(key) {
    if (!assetEditorState.workingAssets[key]) assetEditorState.workingAssets[key] = getEditableThingAssetSnapshot(key);
    syncAssetEditorAnimationSelection(assetEditorState.workingAssets[key]);
    return assetEditorState.workingAssets[key];
}

function getAssetEditorPreviewOwnerColor() {
    if (typeof get2DRenderOwnerColor === 'function') return get2DRenderOwnerColor(0);
    if (typeof get3DRenderOwnerColor === 'function') return get3DRenderOwnerColor(0);
    return '#6cb7ff';
}

function getAssetEditorCollisionRadius(key) {
    if (BASE_UNIT_STATS && BASE_UNIT_STATS[key]) {
        let stats = BASE_UNIT_STATS[key] || {};
        return Math.max(1, Number(stats.collisionR) || Number(stats.r) || 8);
    }
    return 20;
}

function getAssetEditorCurrentAnimation(asset) {
    let currentAsset = asset || ensureWorkingAsset(assetEditorState.selectedKey);
    let animation = ensureThingAssetAnimation(currentAsset, assetEditorState.selectedAnimation);
    if (!animation.frames[assetEditorState.selectedFrame]) animation.frames[assetEditorState.selectedFrame] = { parts: assetClone(currentAsset.model.parts) };
    return animation;
}

function makeAssetEditorVoxelKey(vx, vy, vz) {
    return `${vx},${vy},${vz}`;
}

function assetEditorVoxelToWorldAxis(index) {
    return (index - ((ASSET_EDITOR_VOXEL_WIDTH - 1) * 0.5)) * ASSET_EDITOR_VOXEL_SIZE;
}

function assetEditorVoxelToWorldHeight(index) {
    return index * ASSET_EDITOR_VOXEL_SIZE;
}

function getAssetEditorFrameData() {
    let key = assetEditorState.selectedKey;
    let asset = ensureWorkingAsset(key);
    let animation = getAssetEditorCurrentAnimation(asset);
    let frame = animation.frames[assetEditorState.selectedFrame];
    let sourceParts = normalizeAssetPartArray(Array.isArray(frame.parts) ? frame.parts : asset.model.parts);
    let basePart = sourceParts.find(part => part.locked || part.id === 'base') || buildDefaultBasePartForThing(key);
    let voxels = new Map();
    for (let part of sourceParts) {
        if (part.locked || part.id === 'base') continue;
        for (let vz = 0; vz < ASSET_EDITOR_VOXEL_HEIGHT; vz++) {
            let centerZ = assetEditorVoxelToWorldHeight(vz) + (ASSET_EDITOR_VOXEL_SIZE * 0.5);
            if (centerZ < Number(part.z || 0) || centerZ > Number(part.z || 0) + Number(part.h || 0)) continue;
            for (let vx = 0; vx < ASSET_EDITOR_VOXEL_WIDTH; vx++) {
                let centerX = assetEditorVoxelToWorldAxis(vx);
                for (let vy = 0; vy < ASSET_EDITOR_VOXEL_DEPTH; vy++) {
                    let centerY = assetEditorVoxelToWorldAxis(vy);
                    let inside = false;
                    if (part.shape === 'cylinder') {
                        let nx = (centerX - Number(part.x || 0)) / Math.max(0.5, Number(part.w || 0) * 0.5);
                        let ny = (centerY - Number(part.y || 0)) / Math.max(0.5, Number(part.d || 0) * 0.5);
                        inside = (nx * nx) + (ny * ny) <= 1;
                    } else {
                        inside = Math.abs(centerX - Number(part.x || 0)) <= Math.max(0.5, Number(part.w || 0) * 0.5)
                            && Math.abs(centerY - Number(part.y || 0)) <= Math.max(0.5, Number(part.d || 0) * 0.5);
                    }
                    if (inside) voxels.set(makeAssetEditorVoxelKey(vx, vy, vz), normalizeAssetHexColor(part.color));
                }
            }
        }
    }
    return {
        asset,
        frame,
        basePart: normalizeAssetPart({ ...basePart, id: 'base', name: 'base', locked: true }, 0),
        voxels
    };
}

function buildAssetEditorPartsFromFrameData(basePart, voxels) {
    let parts = [normalizeAssetPart({ ...basePart, id: 'base', name: 'base', locked: true }, 0)];
    let keys = Array.from(voxels.keys()).sort((a, b) => {
        let [ax, ay, az] = a.split(',').map(Number);
        let [bx, by, bz] = b.split(',').map(Number);
        return az - bz || ay - by || ax - bx;
    });
    for (let key of keys) {
        let [vx, vy, vz] = key.split(',').map(Number);
        parts.push(normalizeAssetPart({
            id: `voxel_${vx}_${vy}_${vz}`,
            name: `voxel ${vx},${vy},${vz}`,
            shape: 'box',
            x: assetEditorVoxelToWorldAxis(vx),
            y: assetEditorVoxelToWorldAxis(vy),
            z: assetEditorVoxelToWorldHeight(vz),
            w: ASSET_EDITOR_VOXEL_SIZE,
            d: ASSET_EDITOR_VOXEL_SIZE,
            h: ASSET_EDITOR_VOXEL_SIZE,
            color: voxels.get(key)
        }, parts.length));
    }
    return parts;
}

function updateAssetEditorFrameData(mutator) {
    let data = getAssetEditorFrameData();
    mutator(data);
    let parts = buildAssetEditorPartsFromFrameData(data.basePart, data.voxels);
    data.frame.parts = parts;
    if (assetEditorState.selectedAnimation === 'idle') data.asset.model.parts = assetClone(parts);
}

function getAssetEditorHighestVoxelLayer(voxels) {
    let best = 0;
    for (let key of voxels.keys()) best = Math.max(best, Number(key.split(',')[2]) || 0);
    return best;
}

function getAssetEditorCurrentFrameParts() {
    let data = getAssetEditorFrameData();
    return buildAssetEditorPartsFromFrameData(data.basePart, data.voxels);
}

function getAssetEditorPreviewScale(parts, key) {
    let localRadius = getThingAssetHorizontalRadius(parts) / TILE;
    let targetRadius = getAssetEditorCollisionRadius(key) / TILE;
    return Math.max(0.05, targetRadius / Math.max(0.05, localRadius));
}

function getAssetEditorVoxelSizeInPreview(scale) {
    return (ASSET_EDITOR_VOXEL_SIZE * scale) / TILE;
}

function clampAssetEditorVoxelIndex(vx, vy, vz) {
    if (vx < 0 || vx >= ASSET_EDITOR_VOXEL_WIDTH) return null;
    if (vy < 0 || vy >= ASSET_EDITOR_VOXEL_DEPTH) return null;
    if (vz < 0 || vz >= ASSET_EDITOR_VOXEL_HEIGHT) return null;
    return { vx, vy, vz };
}

function getAssetEditorViewportClientPoint(clientX, clientY) {
    let canvas = document.getElementById('asset-editor-canvas');
    if (!canvas) return null;
    let rect = canvas.getBoundingClientRect();
    if (assetEditorState.pointerLocked) {
        return {
            clientX: rect.left + (rect.width * 0.5),
            clientY: rect.top + (rect.height * 0.5)
        };
    }
    return { clientX, clientY };
}

function getAssetEditorViewportPointerPosition(width, height) {
    if (assetEditorState.pointerLocked || !assetEditorState.viewportPointer) {
        return { x: width * 0.5, y: height * 0.5 };
    }
    return assetEditorState.viewportPointer;
}

function getAssetEditorBrushOffsets(radius) {
    let out = [];
    let brushRadius = Math.max(0, Math.floor(radius || 0));
    for (let dx = -brushRadius; dx <= brushRadius; dx++) {
        for (let dy = -brushRadius; dy <= brushRadius; dy++) {
            for (let dz = -brushRadius; dz <= brushRadius; dz++) {
                if (Math.hypot(dx, dy, dz) > brushRadius + 0.001) continue;
                out.push({ dx, dy, dz });
            }
        }
    }
    return out;
}

function getAssetEditorVoxelIndexFromLocalAxis(value, dimension) {
    return Math.floor((value / ASSET_EDITOR_VOXEL_SIZE) + (dimension * 0.5));
}

function getAssetEditorVoxelBox(vx, vy, vz, scale) {
    let size = getAssetEditorVoxelSizeInPreview(scale);
    let centerX = (assetEditorVoxelToWorldAxis(vx) * scale) / TILE;
    let centerZ = (assetEditorVoxelToWorldAxis(vy) * scale) / TILE;
    let minY = (assetEditorVoxelToWorldHeight(vz) * scale) / TILE;
    return {
        minX: centerX - (size * 0.5),
        maxX: centerX + (size * 0.5),
        minY,
        maxY: minY + size,
        minZ: centerZ - (size * 0.5),
        maxZ: centerZ + (size * 0.5)
    };
}

function assetEditorTransformClipToWorld(matrix, x, y, z) {
    if (!matrix) return null;
    let tx = matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12];
    let ty = matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13];
    let tz = matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14];
    let tw = matrix[3] * x + matrix[7] * y + matrix[11] * z + matrix[15];
    if (Math.abs(tw) < 1e-6) return null;
    return [tx / tw, ty / tw, tz / tw];
}

function getAssetEditorViewportRay(clientX, clientY) {
    let previewRenderer = ensureAssetEditorPreviewRenderer();
    let canvas = document.getElementById('asset-editor-canvas');
    if (!previewRenderer || !previewRenderer.tmpInverseViewProjection || !canvas) return null;
    let rect = canvas.getBoundingClientRect();
    let width = Math.max(1, rect.width || 1);
    let height = Math.max(1, rect.height || 1);
    let ndcX = ((clientX - rect.left) / width) * 2 - 1;
    let ndcY = 1 - ((clientY - rect.top) / height) * 2;
    let nearPoint = assetEditorTransformClipToWorld(previewRenderer.tmpInverseViewProjection, ndcX, ndcY, -1);
    let farPoint = assetEditorTransformClipToWorld(previewRenderer.tmpInverseViewProjection, ndcX, ndcY, 1);
    if (!nearPoint || !farPoint) return null;
    let dirX = farPoint[0] - nearPoint[0];
    let dirY = farPoint[1] - nearPoint[1];
    let dirZ = farPoint[2] - nearPoint[2];
    let length = Math.hypot(dirX, dirY, dirZ) || 0;
    if (length <= 1e-6) return null;
    return {
        origin: { x: nearPoint[0], y: nearPoint[1], z: nearPoint[2] },
        direction: { x: dirX / length, y: dirY / length, z: dirZ / length }
    };
}

function getAssetEditorRayPlaneIntersection(ray, planeY) {
    if (!ray || Math.abs(ray.direction.y) < 1e-6) return null;
    let t = (planeY - ray.origin.y) / ray.direction.y;
    if (!Number.isFinite(t) || t < 0) return null;
    return {
        x: ray.origin.x + ray.direction.x * t,
        y: planeY,
        z: ray.origin.z + ray.direction.z * t,
        t
    };
}

function intersectAssetEditorRayBox(ray, box) {
    if (!ray || !box) return null;
    let tMin = -Infinity;
    let tMax = Infinity;
    let axes = [
        { min: box.minX, max: box.maxX, origin: ray.origin.x, dir: ray.direction.x, axis: 'x' },
        { min: box.minY, max: box.maxY, origin: ray.origin.y, dir: ray.direction.y, axis: 'y' },
        { min: box.minZ, max: box.maxZ, origin: ray.origin.z, dir: ray.direction.z, axis: 'z' }
    ];
    for (let axis of axes) {
        if (Math.abs(axis.dir) < 1e-6) {
            if (axis.origin < axis.min || axis.origin > axis.max) return null;
            continue;
        }
        let t1 = (axis.min - axis.origin) / axis.dir;
        let t2 = (axis.max - axis.origin) / axis.dir;
        let nearT = Math.min(t1, t2);
        let farT = Math.max(t1, t2);
        tMin = Math.max(tMin, nearT);
        tMax = Math.min(tMax, farT);
        if (tMin > tMax) return null;
    }
    let t = tMin >= 0 ? tMin : tMax;
    if (!Number.isFinite(t) || t < 0) return null;
    let hitX = ray.origin.x + ray.direction.x * t;
    let hitY = ray.origin.y + ray.direction.y * t;
    let hitZ = ray.origin.z + ray.direction.z * t;
    let faceDistances = [
        { dist: Math.abs(hitX - box.minX), dvx: -1, dvy: 0, dvz: 0 },
        { dist: Math.abs(hitX - box.maxX), dvx: 1, dvy: 0, dvz: 0 },
        { dist: Math.abs(hitY - box.minY), dvx: 0, dvy: 0, dvz: -1 },
        { dist: Math.abs(hitY - box.maxY), dvx: 0, dvy: 0, dvz: 1 },
        { dist: Math.abs(hitZ - box.minZ), dvx: 0, dvy: -1, dvz: 0 },
        { dist: Math.abs(hitZ - box.maxZ), dvx: 0, dvy: 1, dvz: 0 }
    ].sort((a, b) => a.dist - b.dist)[0];
    return {
        t,
        point: { x: hitX, y: hitY, z: hitZ },
        normal: faceDistances
    };
}

function resolveAssetEditorViewportTargets(clientX, clientY) {
    let data = getAssetEditorFrameData();
    let scale = getAssetEditorPreviewScale(getAssetEditorCurrentFrameParts(), assetEditorState.selectedKey);
    let ray = getAssetEditorViewportRay(clientX, clientY);
    if (!ray) return null;
    let removeTarget = null;
    for (let voxelKey of data.voxels.keys()) {
        let [vx, vy, vz] = voxelKey.split(',').map(Number);
        let hit = intersectAssetEditorRayBox(ray, getAssetEditorVoxelBox(vx, vy, vz, scale));
        if (!hit) continue;
        if (!removeTarget || hit.t < removeTarget.t) {
            removeTarget = {
                type: 'voxel',
                t: hit.t,
                vx,
                vy,
                vz,
                key: voxelKey,
                normal: hit.normal
            };
        }
    }
    let addTarget = null;
    if (removeTarget) {
        addTarget = clampAssetEditorVoxelIndex(
            removeTarget.vx + removeTarget.normal.dvx,
            removeTarget.vy + removeTarget.normal.dvy,
            removeTarget.vz + removeTarget.normal.dvz
        );
    } else {
        let groundHit = getAssetEditorRayPlaneIntersection(ray, 0);
        if (groundHit) {
            let localX = (groundHit.x * TILE) / scale;
            let localY = (groundHit.z * TILE) / scale;
            addTarget = clampAssetEditorVoxelIndex(
                getAssetEditorVoxelIndexFromLocalAxis(localX, ASSET_EDITOR_VOXEL_WIDTH),
                getAssetEditorVoxelIndexFromLocalAxis(localY, ASSET_EDITOR_VOXEL_DEPTH),
                0
            );
        }
    }
    return {
        removeTarget,
        addTarget,
        scale,
        ray
    };
}

function getAssetEditorViewportBrushPreviewWorld(hover) {
    if (!hover) return null;
    let target = hover.addTarget || hover.removeTarget;
    if (!target) return null;
    let box = getAssetEditorVoxelBox(target.vx, target.vy, target.vz, hover.scale || getAssetEditorPreviewScale(getAssetEditorCurrentFrameParts(), assetEditorState.selectedKey));
    let voxelRadius = getAssetEditorVoxelSizeInPreview(hover.scale || 1);
    return {
        x: (box.minX + box.maxX) * 0.5,
        y: box.minY + 0.02,
        z: (box.minZ + box.maxZ) * 0.5,
        radius: Math.max(voxelRadius * 0.45, (assetEditorState.cursorRadius + 0.5) * voxelRadius)
    };
}

function renderAssetEditorViewportStatus() {
    let status = document.getElementById('asset-editor-viewport-status');
    if (!status) return;
    let hover = assetEditorState.viewportHover;
    let lockText = assetEditorState.pointerLocked ? 'Look ON' : 'Click viewport to look';
    if (!hover) {
        status.textContent = `${lockText}. Brush ${assetEditorState.cursorRadius}. LMB remove voxel. RMB add voxel.`;
        return;
    }
    let parts = ['LMB'];
    parts.push(hover.removeTarget ? `remove ${hover.removeTarget.vx},${hover.removeTarget.vy},${hover.removeTarget.vz}` : 'remove none');
    parts.push('|');
    parts.push('RMB');
    parts.push(hover.addTarget ? `add ${hover.addTarget.vx},${hover.addTarget.vy},${hover.addTarget.vz}` : 'add blocked');
    parts.push('|');
    parts.push(lockText);
    parts.push('|');
    parts.push(`brush ${assetEditorState.cursorRadius}`);
    status.textContent = parts.join(' ');
}

function drawAssetEditorViewportOverlay(ctx, width, height) {
    let pointer = getAssetEditorViewportPointerPosition(width, height);
    if (pointer) {
        ctx.save();
        ctx.strokeStyle = 'rgba(255,255,255,0.8)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(pointer.x - 6, pointer.y);
        ctx.lineTo(pointer.x + 6, pointer.y);
        ctx.moveTo(pointer.x, pointer.y - 6);
        ctx.lineTo(pointer.x, pointer.y + 6);
        ctx.stroke();
        ctx.restore();
    }
    let previewRenderer = ensureAssetEditorPreviewRenderer();
    let brushWorld = previewRenderer && typeof previewRenderer.projectWorldToScreen === 'function'
        ? getAssetEditorViewportBrushPreviewWorld(assetEditorState.viewportHover)
        : null;
    if (previewRenderer && brushWorld) {
        ctx.save();
        ctx.strokeStyle = 'rgba(255, 214, 102, 0.9)';
        ctx.lineWidth = 1.25;
        ctx.setLineDash([5, 4]);
        ctx.beginPath();
        let started = false;
        for (let index = 0; index <= 40; index++) {
            let angle = (index / 40) * Math.PI * 2;
            let point = previewRenderer.projectWorldToScreen(
                brushWorld.x + Math.cos(angle) * brushWorld.radius,
                brushWorld.y,
                brushWorld.z + Math.sin(angle) * brushWorld.radius
            );
            if (!point) continue;
            if (!started) {
                ctx.moveTo(point.x, point.y);
                started = true;
            } else {
                ctx.lineTo(point.x, point.y);
            }
        }
        if (started) ctx.stroke();
        ctx.setLineDash([]);
        ctx.restore();
    }
    ctx.save();
    ctx.fillStyle = 'rgba(9, 14, 18, 0.76)';
    ctx.fillRect(12, height - 38, 310, 24);
    ctx.fillStyle = '#d6e8f8';
    ctx.font = '600 11px Segoe UI, Arial, sans-serif';
    ctx.fillText('Click viewport to look   WASD move   Space up   Shift down   LMB remove   RMB add', 18, height - 22);
    ctx.restore();
}

function updateAssetEditorViewportHover(clientX, clientY) {
    let canvas = document.getElementById('asset-editor-canvas');
    if (!canvas) return;
    let rect = canvas.getBoundingClientRect();
    let point = getAssetEditorViewportClientPoint(clientX, clientY);
    if (!point) return;
    assetEditorState.viewportPointer = assetEditorState.pointerLocked
        ? { x: rect.width * 0.5, y: rect.height * 0.5 }
        : { x: point.clientX - rect.left, y: point.clientY - rect.top };
    assetEditorState.viewportHover = resolveAssetEditorViewportTargets(point.clientX, point.clientY);
    renderAssetEditorViewportStatus();
    renderAssetEditorPreview();
}

function updateAssetEditorViewportPointerFromMovement(movementX, movementY) {
    let point = getAssetEditorViewportClientPoint(0, 0);
    if (!point) return;
    let canvas = document.getElementById('asset-editor-canvas');
    let rect = canvas ? canvas.getBoundingClientRect() : { width: 0, height: 0 };
    assetEditorState.viewportPointer = {
        x: rect.width * 0.5,
        y: rect.height * 0.5
    };
    let clientX = point.clientX;
    let clientY = point.clientY;
    assetEditorState.viewportHover = resolveAssetEditorViewportTargets(clientX, clientY);
    renderAssetEditorViewportStatus();
    renderAssetEditorPreview();
}

function applyAssetEditorViewportAction(mode, clientX, clientY) {
    let point = getAssetEditorViewportClientPoint(clientX, clientY);
    if (!point) return null;
    let targets = resolveAssetEditorViewportTargets(point.clientX, point.clientY);
    if (!targets) return null;
    let target = mode === 'remove' ? targets.removeTarget : targets.addTarget;
    if (!target) return null;
    let brushOffsets = getAssetEditorBrushOffsets(assetEditorState.cursorRadius);
    let applied = [];
    updateAssetEditorFrameData((data) => {
        for (let offset of brushOffsets) {
            let voxel = clampAssetEditorVoxelIndex(target.vx + offset.dx, target.vy + offset.dy, target.vz + offset.dz);
            if (!voxel) continue;
            let targetKey = makeAssetEditorVoxelKey(voxel.vx, voxel.vy, voxel.vz);
            if (mode === 'remove') data.voxels.delete(targetKey);
            else data.voxels.set(targetKey, assetEditorState.selectedColor);
            applied.push(targetKey);
        }
    });
    assetEditorState.viewportHover = resolveAssetEditorViewportTargets(point.clientX, point.clientY);
    renderAssetEditorViewportStatus();
    renderAssetEditorPreview();
    return applied.length ? `${mode}:${applied[0]}` : null;
}

function syncAssetEditorPointerLockState() {
    let canvas = document.getElementById('asset-editor-canvas');
    assetEditorState.pointerLocked = !!canvas && document.pointerLockElement === canvas;
    if (assetEditorState.pointerLocked && canvas) {
        let rect = canvas.getBoundingClientRect();
        assetEditorState.viewportPointer = { x: rect.width * 0.5, y: rect.height * 0.5 };
        let point = getAssetEditorViewportClientPoint(0, 0);
        if (point) assetEditorState.viewportHover = resolveAssetEditorViewportTargets(point.clientX, point.clientY);
    }
    renderAssetEditorViewportStatus();
    renderAssetEditorPreview();
}

function handleAssetEditorPointerLockLook(ev) {
    if (!assetEditorState.open || !assetEditorState.pointerLocked) return;
    let previewRenderer = ensureAssetEditorPreviewRenderer();
    if (!previewRenderer || typeof previewRenderer.adjustOrbit !== 'function') return;
    previewRenderer.adjustOrbit(-(Number(ev.movementX) || 0) * ASSET_EDITOR_LOOK_SPEED, -(Number(ev.movementY) || 0) * ASSET_EDITOR_LOOK_SPEED);
    updateAssetEditorViewportPointerFromMovement(Number(ev.movementX) || 0, Number(ev.movementY) || 0);
}

function bindAssetEditorViewportCanvas(canvas) {
    canvas.addEventListener('contextmenu', (ev) => ev.preventDefault());
    canvas.addEventListener('pointerleave', () => {
        if (assetEditorState.pointerLocked) return;
        assetEditorState.viewportPointer = null;
        assetEditorState.viewportHover = null;
        renderAssetEditorViewportStatus();
        renderAssetEditorPreview();
    });
    canvas.addEventListener('pointermove', (ev) => {
        updateAssetEditorViewportHover(ev.clientX, ev.clientY);
        if (!assetEditorState.viewportDrag || assetEditorState.viewportDrag.pointerId !== ev.pointerId) return;
        let appliedKey = applyAssetEditorViewportAction(assetEditorState.viewportDrag.mode, ev.clientX, ev.clientY);
        if (appliedKey) assetEditorState.viewportDrag.lastAppliedKey = appliedKey;
    });
    canvas.addEventListener('pointerdown', (ev) => {
        ev.preventDefault();
        canvas.focus({ preventScroll: true });
        if (document.pointerLockElement !== canvas && canvas.requestPointerLock) {
            try { canvas.requestPointerLock(); } catch { }
        }
        try { canvas.setPointerCapture(ev.pointerId); } catch { }
        let mode = ev.button === 2 ? 'add' : 'remove';
        let appliedKey = applyAssetEditorViewportAction(mode, ev.clientX, ev.clientY);
        assetEditorState.viewportDrag = {
            pointerId: ev.pointerId,
            mode,
            lastAppliedKey: appliedKey
        };
    });
    let releaseDrag = (ev) => {
        if (!assetEditorState.viewportDrag || assetEditorState.viewportDrag.pointerId !== ev.pointerId) return;
        assetEditorState.viewportDrag = null;
        try { canvas.releasePointerCapture(ev.pointerId); } catch { }
    };
    canvas.addEventListener('pointerup', releaseDrag);
    canvas.addEventListener('pointercancel', releaseDrag);
}

function resetAssetEditorCamera() {
    assetEditorState.cameraCenterX = 0;
    assetEditorState.cameraCenterY = 1.25;
    assetEditorState.cameraCenterZ = 0;
    let previewRenderer = ensureAssetEditorPreviewRenderer();
    if (previewRenderer) {
        previewRenderer.orbitYaw = 0;
        previewRenderer.orbitPitch = -0.12;
    }
}

function renderAssetEditorCursorRadiusControls() {
    let range = document.getElementById('asset-editor-cursor-radius-range');
    let label = document.getElementById('asset-editor-cursor-radius-label');
    if (range) range.value = String(assetEditorState.cursorRadius);
    if (label) label.textContent = assetEditorState.cursorRadius <= 0 ? 'Brush 0 (single voxel)' : `Brush ${assetEditorState.cursorRadius}`;
}

function updateAssetEditorCamera(deltaSeconds) {
    let amount = Math.max(0, Number(deltaSeconds) || 0);
    if (!assetEditorState.open || amount <= 0) return false;
    let previewRenderer = ensureAssetEditorPreviewRenderer();
    let basis = previewRenderer && typeof previewRenderer.getGroundMovementBasis === 'function'
        ? previewRenderer.getGroundMovementBasis()
        : { forwardX: 0, forwardZ: -1, rightX: 1, rightZ: 0 };
    let moveForward = (assetEditorState.movementKeys.KeyW ? 1 : 0) - (assetEditorState.movementKeys.KeyS ? 1 : 0);
    let moveRight = (assetEditorState.movementKeys.KeyD ? 1 : 0) - (assetEditorState.movementKeys.KeyA ? 1 : 0);
    let moveVertical = ((assetEditorState.movementKeys.Space || assetEditorState.movementKeys.Numpad0) ? 1 : 0)
        - ((assetEditorState.movementKeys.ShiftLeft || assetEditorState.movementKeys.ShiftRight) ? 1 : 0);
    if (!moveForward && !moveRight && !moveVertical) return false;
    let horizontalSpeed = ASSET_EDITOR_CAMERA_MOVE_SPEED * amount;
    assetEditorState.cameraCenterX += (basis.forwardX * moveForward + basis.rightX * moveRight) * horizontalSpeed;
    assetEditorState.cameraCenterZ += (basis.forwardZ * moveForward + basis.rightZ * moveRight) * horizontalSpeed;
    assetEditorState.cameraCenterY = Math.max(
        ASSET_EDITOR_CAMERA_MIN_Y,
        Math.min(ASSET_EDITOR_CAMERA_MAX_Y, assetEditorState.cameraCenterY + (moveVertical * ASSET_EDITOR_CAMERA_VERTICAL_SPEED * amount))
    );
    return true;
}

function handleAssetEditorMovementKey(ev, isDown) {
    if (!assetEditorState.open) return;
    let inputTag = document.activeElement && document.activeElement.tagName ? document.activeElement.tagName.toUpperCase() : '';
    if (inputTag === 'INPUT' || inputTag === 'TEXTAREA') return;
    if (!['KeyW', 'KeyA', 'KeyS', 'KeyD', 'Space', 'ShiftLeft', 'ShiftRight', 'Numpad0'].includes(ev.code)) return;
    ev.preventDefault();
    assetEditorState.movementKeys[ev.code] = isDown;
}

function setAssetEditorFrame(nextFrame) {
    assetEditorState.selectedFrame = ((Math.floor(nextFrame || 0) % ASSET_EDITOR_FRAME_COUNT) + ASSET_EDITOR_FRAME_COUNT) % ASSET_EDITOR_FRAME_COUNT;
    assetEditorState.activeLayer = Math.min(assetEditorState.activeLayer, getAssetEditorHighestVoxelLayer(getAssetEditorFrameData().voxels));
    renderAssetEditor();
}

function shiftAssetEditorLayer(delta) {
    assetEditorState.activeLayer = clampAssetEditorValue(assetEditorState.activeLayer + delta, 0, ASSET_EDITOR_VOXEL_HEIGHT - 1);
    renderAssetEditorLayerControls();
    renderAssetEditorVoxelCanvas();
}

function selectAssetEditorKey(key) {
    assetEditorState.selectedKey = key;
    assetEditorState.selectedAnimation = 'idle';
    assetEditorState.selectedFrame = 0;
    assetEditorState.activeLayer = getAssetEditorHighestVoxelLayer(getAssetEditorFrameData().voxels);
    renderAssetEditor();
}

function bindAssetEditorVoxelCanvas(canvas) {
    let applyAtEvent = (ev, mode) => {
        let hit = getAssetEditorVoxelHit(canvas, ev.clientX, ev.clientY);
        if (!hit) return;
        updateAssetEditorFrameData((data) => {
            let key = makeAssetEditorVoxelKey(hit.vx, hit.vy, assetEditorState.activeLayer);
            if (mode === 'erase') data.voxels.delete(key);
            else data.voxels.set(key, assetEditorState.selectedColor);
        });
        renderAssetEditorPreview();
        renderAssetEditorVoxelCanvas();
    };

    canvas.addEventListener('contextmenu', (ev) => ev.preventDefault());
    canvas.addEventListener('pointerdown', (ev) => {
        ev.preventDefault();
        canvas.setPointerCapture(ev.pointerId);
        assetEditorState.dragPaint = { pointerId: ev.pointerId, mode: ev.button === 2 ? 'erase' : assetEditorState.selectedTool };
        applyAtEvent(ev, assetEditorState.dragPaint.mode);
    });
    canvas.addEventListener('pointermove', (ev) => {
        if (!assetEditorState.dragPaint || assetEditorState.dragPaint.pointerId !== ev.pointerId) return;
        applyAtEvent(ev, assetEditorState.dragPaint.mode);
    });
    let release = (ev) => {
        if (!assetEditorState.dragPaint || assetEditorState.dragPaint.pointerId !== ev.pointerId) return;
        assetEditorState.dragPaint = null;
        try { canvas.releasePointerCapture(ev.pointerId); } catch { }
    };
    canvas.addEventListener('pointerup', release);
    canvas.addEventListener('pointercancel', release);
}

function getAssetEditorVoxelHit(canvas, clientX, clientY) {
    if (!assetEditorState.voxelCanvasMetrics) return null;
    let rect = canvas.getBoundingClientRect();
    let metrics = assetEditorState.voxelCanvasMetrics;
    let x = clientX - rect.left;
    let y = clientY - rect.top;
    if (x < metrics.originX || y < metrics.originY || x > metrics.originX + metrics.size || y > metrics.originY + metrics.size) return null;
    let vx = clampAssetEditorValue((x - metrics.originX) / metrics.cellSize, 0, ASSET_EDITOR_VOXEL_WIDTH - 1);
    let vyFromTop = clampAssetEditorValue((y - metrics.originY) / metrics.cellSize, 0, ASSET_EDITOR_VOXEL_DEPTH - 1);
    return { vx, vy: (ASSET_EDITOR_VOXEL_DEPTH - 1) - vyFromTop };
}

function ensureAssetEditorPreviewRenderer() {
    if (assetEditorState.previewRenderer || assetEditorState.previewRendererFailed) return assetEditorState.previewRenderer;
    let host = document.getElementById('asset-editor-3d-preview');
    if (!host || !window.Defence3Renderer3D) return null;
    try {
        assetEditorState.previewRenderer = new window.Defence3Renderer3D({ mount: host });
        assetEditorState.previewRenderer.setEnabled(assetEditorState.open);
        if (!assetEditorState.previewRenderer.supported) {
            assetEditorState.previewRendererFailed = true;
            assetEditorState.previewRenderer = null;
        }
    } catch {
        assetEditorState.previewRendererFailed = true;
        assetEditorState.previewRenderer = null;
    }
    return assetEditorState.previewRenderer;
}

function getScaledAssetEditorPreviewParts(parts, key) {
    let scale = getAssetEditorPreviewScale(parts, key);
    return normalizeAssetPartArray(parts).map((part) => normalizeAssetPart({
        ...part,
        x: Number(part.x || 0) * scale,
        y: Number(part.y || 0) * scale,
        z: Number(part.z || 0) * scale,
        w: Math.max(ASSET_EDITOR_VOXEL_SIZE, Number(part.w || 0) * scale),
        d: Math.max(ASSET_EDITOR_VOXEL_SIZE, Number(part.d || 0) * scale),
        h: Math.max(ASSET_EDITOR_VOXEL_SIZE, Number(part.h || 0) * scale)
    }));
}

function getAssetEditorPreviewSnapshot(width, height) {
    let key = assetEditorState.selectedKey;
    let ownerTint = getAssetEditorPreviewOwnerColor();
    let profile = typeof getThing3DPreviewProfile === 'function' ? getThing3DPreviewProfile(key, { owner: 0 }) : { topTextureCanvas: null };
    let parts = getScaledAssetEditorPreviewParts(getAssetEditorCurrentFrameParts(), key);
    return {
        viewportWidth: width,
        viewportHeight: height,
        camera: {
            mode: 'fps',
            centerX: assetEditorState.cameraCenterX,
            centerY: assetEditorState.cameraCenterY,
            centerZ: assetEditorState.cameraCenterZ,
            visibleWidth: 2.7,
            visibleHeight: 2.45,
            zoom: 1
        },
        objects: parts.map((part) => ({
            modelKey: 'cube',
            x: (Number(part.x) || 0) / TILE,
            y: (Number(part.z) || 0) / TILE,
            z: (Number(part.y) || 0) / TILE,
            scaleX: Math.max(0.05, (Number(part.w) || ASSET_EDITOR_VOXEL_SIZE) / TILE),
            scaleY: Math.max(0.05, (Number(part.h) || ASSET_EDITOR_VOXEL_SIZE) / TILE),
            scaleZ: Math.max(0.05, (Number(part.d) || ASSET_EDITOR_VOXEL_SIZE) / TILE),
            rotationY: 0,
            tint: resolveAssetPartColor(part.color, ownerTint),
            alpha: 1,
            renderShape: part.shape === 'cylinder' ? 'cylinder' : 'box',
            topTextureKey: (part.locked || part.id === 'base') && profile.topTextureCanvas ? `asset_editor:${key}` : '',
            topTextureCanvas: (part.locked || part.id === 'base') ? profile.topTextureCanvas : null
        }))
    };
}

function drawAssetEditorGrid(ctx, width, height, previewScale) {
    ctx.save();
    ctx.strokeStyle = 'rgba(120, 140, 160, 0.12)';
    ctx.lineWidth = 1;
    for (let i = -12; i <= 12; i++) {
        let start = _projectAssetPoint(width * 0.5, height * 0.68, previewScale, i * 6, -72, 0);
        let end = _projectAssetPoint(width * 0.5, height * 0.68, previewScale, i * 6, 72, 0);
        ctx.beginPath();
        ctx.moveTo(start.x, start.y);
        ctx.lineTo(end.x, end.y);
        ctx.stroke();
        start = _projectAssetPoint(width * 0.5, height * 0.68, previewScale, -72, i * 6, 0);
        end = _projectAssetPoint(width * 0.5, height * 0.68, previewScale, 72, i * 6, 0);
        ctx.beginPath();
        ctx.moveTo(start.x, start.y);
        ctx.lineTo(end.x, end.y);
        ctx.stroke();
    }
    ctx.restore();
}

function drawAssetEditorCollisionRing(ctx, width, height, previewScale) {
    let radiusPx = getAssetEditorCollisionRadius(assetEditorState.selectedKey);
    ctx.save();
    ctx.strokeStyle = 'rgba(111, 196, 255, 0.9)';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([6, 5]);
    ctx.beginPath();
    for (let i = 0; i <= 48; i++) {
        let angle = (i / 48) * Math.PI * 2;
        let point = _projectAssetPoint(width * 0.5, height * 0.69, previewScale, Math.cos(angle) * radiusPx, Math.sin(angle) * radiusPx, 0);
        if (i === 0) ctx.moveTo(point.x, point.y);
        else ctx.lineTo(point.x, point.y);
    }
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(12, 20, 28, 0.72)';
    ctx.fillRect(12, 12, 176, 22);
    ctx.fillStyle = '#9fd8ff';
    ctx.font = '600 11px Segoe UI, Arial, sans-serif';
    ctx.fillText(`Collision Radius ${radiusPx}px`, 18, 27);
    ctx.restore();
}

function renderAssetEditorPreview() {
    let canvas = document.getElementById('asset-editor-canvas');
    if (!canvas) return;
    let previewHost = document.getElementById('asset-editor-3d-preview');
    let rect = canvas.getBoundingClientRect();
    let dpr = window.devicePixelRatio || 1;
    let width = Math.max(320, Math.floor(rect.width || 720));
    let height = Math.max(220, Math.floor(rect.height || 480));
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    let ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    let previewRenderer = ensureAssetEditorPreviewRenderer();
    let previewScale = Math.min(width, height) / 86;
    if (previewHost) previewHost.style.display = previewRenderer ? 'block' : 'none';
    if (previewRenderer) {
        previewRenderer.setEnabled(true);
        previewRenderer.render(getAssetEditorPreviewSnapshot(width, height));
    } else {
        let backdrop = ctx.createLinearGradient(0, 0, 0, height);
        backdrop.addColorStop(0, '#11171e');
        backdrop.addColorStop(1, '#090c10');
        ctx.fillStyle = backdrop;
        ctx.fillRect(0, 0, width, height);
        drawAssetEditorGrid(ctx, width, height, previewScale);
        drawThingAssetEditorPreview(ctx, assetEditorState.selectedKey, getScaledAssetEditorPreviewParts(getAssetEditorCurrentFrameParts(), assetEditorState.selectedKey), {
            originX: width * 0.5,
            originY: height * 0.69,
            scale: previewScale,
            owner: 0,
            tint: getAssetEditorPreviewOwnerColor()
        });
    }
    drawAssetEditorCollisionRing(ctx, width, height, previewScale);
    drawAssetEditorViewportOverlay(ctx, width, height);
}

function renderAssetEditorFrameControls() {
    let range = document.getElementById('asset-editor-frame-range');
    let label = document.getElementById('asset-editor-frame-label');
    let playBtn = document.getElementById('btn-asset-editor-play');
    if (range) range.value = String(assetEditorState.selectedFrame);
    if (label) label.textContent = `Frame ${assetEditorState.selectedFrame + 1} / ${ASSET_EDITOR_FRAME_COUNT}`;
    if (playBtn) playBtn.textContent = assetEditorState.play ? 'Pause' : 'Play';
}

function renderAssetEditorMeta() {
    let meta = document.getElementById('asset-editor-asset-meta');
    let title = document.getElementById('asset-editor-selected-title');
    if (title) title.textContent = getThingAssetLabel(assetEditorState.selectedKey);
    if (!meta) return;
    meta.innerHTML = '';
    let strong = document.createElement('strong');
    strong.textContent = getThingAssetLabel(assetEditorState.selectedKey);
    meta.appendChild(strong);
    let body = document.createElement('div');
    body.textContent = `Collision radius: ${getAssetEditorCollisionRadius(assetEditorState.selectedKey)}px. The render scales to this footprint; collisions stay inside the ring.`;
    meta.appendChild(body);
    let note = document.createElement('div');
    note.className = 'asset-editor-meta-note';
    note.textContent = 'The base marker carries top textures and status bars. Voxels can extend beyond it.';
    meta.appendChild(note);
}

function renderAssetEditorAnimations() {
    let wrap = document.getElementById('asset-editor-animation-list');
    if (!wrap) return;
    wrap.innerHTML = '';
    for (let animationName of getAssetEditorAnimationNames(ensureWorkingAsset(assetEditorState.selectedKey))) {
        let button = document.createElement('button');
        button.type = 'button';
        button.className = animationName === assetEditorState.selectedAnimation ? 'active' : '';
        button.textContent = animationName;
        bindInstantPress(button, () => {
            assetEditorState.selectedAnimation = animationName;
            assetEditorState.selectedFrame = 0;
            assetEditorState.activeLayer = getAssetEditorHighestVoxelLayer(getAssetEditorFrameData().voxels);
            renderAssetEditor();
        });
        wrap.appendChild(button);
    }
}

function renderAssetEditorPalette() {
    let wrap = document.getElementById('asset-editor-palette');
    if (!wrap) return;
    wrap.innerHTML = '';
    for (let color of ASSET_EDITOR_VOXEL_PALETTE) {
        let button = document.createElement('button');
        button.type = 'button';
        button.className = color === assetEditorState.selectedColor ? 'asset-editor-swatch active' : 'asset-editor-swatch';
        if (color === ASSET_EDITOR_PLAYER_COLOR_TOKEN) {
            button.classList.add('player');
            button.title = 'Player Color';
        } else {
            button.style.background = color;
            button.title = color;
        }
        bindInstantPress(button, () => {
            assetEditorState.selectedColor = color;
            assetEditorState.selectedTool = 'paint';
            renderAssetEditorPalette();
            renderAssetEditorVoxelTools();
        });
        wrap.appendChild(button);
    }
}

function renderAssetEditorVoxelTools() {
    let paintBtn = document.getElementById('btn-asset-editor-tool-paint');
    let eraseBtn = document.getElementById('btn-asset-editor-tool-erase');
    if (paintBtn) paintBtn.className = assetEditorState.selectedTool === 'paint' ? 'active' : '';
    if (eraseBtn) eraseBtn.className = assetEditorState.selectedTool === 'erase' ? 'active' : '';
}

function renderAssetEditorLayerControls() {
    let range = document.getElementById('asset-editor-layer-range');
    let label = document.getElementById('asset-editor-layer-label');
    if (range) range.value = String(assetEditorState.activeLayer);
    if (label) label.textContent = `Layer ${assetEditorState.activeLayer} / ${ASSET_EDITOR_VOXEL_HEIGHT - 1}`;
}

function renderAssetEditorBaseControls() {
    let shapeRow = document.getElementById('asset-editor-base-shape-row');
    let offsetControls = document.getElementById('asset-editor-base-offset-controls');
    let summary = document.getElementById('asset-editor-base-summary');
    let data = getAssetEditorFrameData();
    if (shapeRow) {
        shapeRow.innerHTML = '';
        for (let shape of ['box', 'cylinder']) {
            let button = document.createElement('button');
            button.type = 'button';
            button.className = data.basePart.shape === shape ? 'active' : '';
            button.textContent = shape === 'box' ? 'Rectangle' : 'Cylinder';
            bindInstantPress(button, () => {
                updateAssetEditorFrameData(frameData => { frameData.basePart.shape = shape; });
                renderAssetEditor();
            });
            shapeRow.appendChild(button);
        }
    }
    if (offsetControls) {
        offsetControls.innerHTML = '';
        let actions = [
            { label: 'Left', dx: -ASSET_EDITOR_VOXEL_SIZE, dy: 0, dz: 0 },
            { label: 'Right', dx: ASSET_EDITOR_VOXEL_SIZE, dy: 0, dz: 0 },
            { label: 'Front', dx: 0, dy: -ASSET_EDITOR_VOXEL_SIZE, dz: 0 },
            { label: 'Back', dx: 0, dy: ASSET_EDITOR_VOXEL_SIZE, dz: 0 },
            { label: 'Down', dx: 0, dy: 0, dz: -ASSET_EDITOR_VOXEL_SIZE },
            { label: 'Up', dx: 0, dy: 0, dz: ASSET_EDITOR_VOXEL_SIZE },
            { label: 'Reset', reset: true }
        ];
        for (let action of actions) {
            let button = document.createElement('button');
            button.type = 'button';
            button.textContent = action.label;
            bindInstantPress(button, () => {
                updateAssetEditorFrameData(frameData => {
                    if (action.reset) {
                        frameData.basePart.x = 0;
                        frameData.basePart.y = 0;
                        frameData.basePart.z = 0;
                    } else {
                        frameData.basePart.x += action.dx;
                        frameData.basePart.y += action.dy;
                        frameData.basePart.z = Math.max(0, Number(frameData.basePart.z || 0) + action.dz);
                    }
                });
                renderAssetEditor();
            });
            offsetControls.appendChild(button);
        }
    }
    if (summary) summary.textContent = `Offset X ${Number(data.basePart.x) || 0}, Y ${Number(data.basePart.y) || 0}, Z ${Number(data.basePart.z) || 0}`;
}

function renderAssetEditorVoxelCanvas() {
    let canvas = document.getElementById('asset-editor-voxel-canvas');
    if (!canvas) return;
    let rect = canvas.getBoundingClientRect();
    let dpr = window.devicePixelRatio || 1;
    let size = Math.max(220, Math.floor(Math.min(rect.width || 320, rect.height || rect.width || 320)));
    canvas.width = Math.max(1, Math.round(size * dpr));
    canvas.height = Math.max(1, Math.round(size * dpr));
    let ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size, size);
    ctx.fillStyle = '#0a0f14';
    ctx.fillRect(0, 0, size, size);
    let pad = 12;
    let gridSize = size - (pad * 2);
    let cellSize = gridSize / ASSET_EDITOR_VOXEL_WIDTH;
    assetEditorState.voxelCanvasMetrics = { originX: pad, originY: pad, size: gridSize, cellSize };
    let data = getAssetEditorFrameData();
    let ownerTint = getAssetEditorPreviewOwnerColor();
    ctx.strokeStyle = '#1c2630';
    ctx.lineWidth = 1;
    for (let i = 0; i <= ASSET_EDITOR_VOXEL_WIDTH; i++) {
        let pos = pad + i * cellSize;
        ctx.beginPath();
        ctx.moveTo(pos, pad);
        ctx.lineTo(pos, pad + gridSize);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(pad, pos);
        ctx.lineTo(pad + gridSize, pos);
        ctx.stroke();
    }
    for (let vx = 0; vx < ASSET_EDITOR_VOXEL_WIDTH; vx++) {
        for (let vy = 0; vy < ASSET_EDITOR_VOXEL_DEPTH; vy++) {
            let color = data.voxels.get(makeAssetEditorVoxelKey(vx, vy, assetEditorState.activeLayer));
            if (!color) continue;
            ctx.fillStyle = resolveAssetPartColor(color, ownerTint);
            let px = pad + vx * cellSize;
            let py = pad + (ASSET_EDITOR_VOXEL_DEPTH - 1 - vy) * cellSize;
            ctx.fillRect(px + 1, py + 1, Math.max(1, cellSize - 2), Math.max(1, cellSize - 2));
        }
    }
    ctx.strokeStyle = '#8fd2ff';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(pad + 0.75, pad + 0.75, gridSize - 1.5, gridSize - 1.5);
}

function renderAssetEditorAssetList() {
    let list = document.getElementById('asset-editor-asset-list');
    let desc = document.getElementById('asset-editor-selection-desc');
    if (!list) return;
    let items = getAssetEditorCategoryItems(assetEditorState.activeCategory);
    if (!items.includes(assetEditorState.selectedKey)) assetEditorState.selectedKey = items[0] || assetEditorState.selectedKey;
    list.innerHTML = '';
    for (let key of items) {
        let button = document.createElement('button');
        button.type = 'button';
        button.className = key === assetEditorState.selectedKey ? 'build-item asset-editor-asset-btn selected' : 'build-item asset-editor-asset-btn';
        button.title = getThingAssetLabel(key);
        let iconWrap = document.createElement('span');
        iconWrap.className = 'bi-icon';
        let thumb = document.createElement('img');
        thumb.width = 28;
        thumb.height = 28;
        thumb.src = typeof getItemThumbnail === 'function' ? getItemThumbnail(key, 28) : getThingAssetThumbnailDataUrl(key, 28);
        iconWrap.appendChild(thumb);
        let text = document.createElement('span');
        text.className = 'bi-name asset-editor-asset-name';
        text.textContent = getThingAssetLabel(key);
        let price = document.createElement('span');
        price.className = 'bi-price';
        price.textContent = `⚡${typeof formatBigNumber === 'function' ? formatBigNumber(getAssetEditorThingEnergyCost(key)) : getAssetEditorThingEnergyCost(key)}`;
        button.appendChild(iconWrap);
        button.appendChild(text);
        button.appendChild(price);
        if (getThingAssetOverride(key)) {
            let badge = document.createElement('span');
            badge.className = 'asset-editor-edited-badge';
            badge.textContent = 'mod';
            button.appendChild(badge);
        }
        bindInstantPress(button, () => selectAssetEditorKey(key));
        list.appendChild(button);
    }
    if (desc) {
        let description = DESCRIPTIONS && DESCRIPTIONS[assetEditorState.selectedKey]
            ? String(DESCRIPTIONS[assetEditorState.selectedKey])
            : 'Edit fixed 16x16x48 voxel layers for the selected animation.';
        desc.textContent = description.split('\n')[0].trim();
    }
}

function assetEditorAnimationLoop(now) {
    let deltaSeconds = assetEditorState.lastTickAt ? Math.max(0, (now - assetEditorState.lastTickAt) / 1000) : 0;
    assetEditorState.lastTickAt = now;
    let needsPreviewRender = false;
    if (updateAssetEditorCamera(deltaSeconds)) needsPreviewRender = true;
    if (assetEditorState.open && assetEditorState.play) {
        let frameMs = 1000 / ASSET_EDITOR_FPS;
        if (!assetEditorState.lastFrameAt) assetEditorState.lastFrameAt = now;
        if ((now - assetEditorState.lastFrameAt) >= frameMs) {
            let step = Math.max(1, Math.floor((now - assetEditorState.lastFrameAt) / frameMs));
            assetEditorState.lastFrameAt = now;
            assetEditorState.selectedFrame = (assetEditorState.selectedFrame + step) % ASSET_EDITOR_FRAME_COUNT;
            needsPreviewRender = true;
            renderAssetEditorFrameControls();
            renderAssetEditorVoxelCanvas();
        }
    } else {
        assetEditorState.lastFrameAt = now;
    }
    if (needsPreviewRender) renderAssetEditorPreview();
    requestAnimationFrame(assetEditorAnimationLoop);
}

function renderAssetEditor() {
    if (!assetEditorState.open) return;
    renderAssetEditorCategories();
    renderAssetEditorAssetList();
    renderAssetEditorMeta();
    renderAssetEditorAnimations();
    renderAssetEditorPalette();
    renderAssetEditorCursorRadiusControls();
    renderAssetEditorBaseControls();
    renderAssetEditorViewportStatus();
    renderAssetEditorPreview();
    renderAssetEditorFrameControls();
    updateAssetPackLobbyUi();
}

function renderAssetEditorCategories() {
    let wrap = document.getElementById('asset-editor-category-tabs');
    if (!wrap) return;
    wrap.innerHTML = '';
    for (let category of ASSET_EDITOR_CATEGORY_ORDER) {
        let button = document.createElement('button');
        button.type = 'button';
        button.className = category === assetEditorState.activeCategory ? 'active' : '';
        button.textContent = String(category).replace(/_/g, ' ');
        bindInstantPress(button, () => {
            assetEditorState.activeCategory = category;
            let items = getAssetEditorCategoryItems(category);
            if (items.length && !items.includes(assetEditorState.selectedKey)) assetEditorState.selectedKey = items[0];
            renderAssetEditor();
        });
        wrap.appendChild(button);
    }
}

function syncAssetEditorPackNameInput() {
    let input = document.getElementById('asset-editor-pack-name-input');
    if (input && document.activeElement !== input) input.value = getCurrentAssetPackName();
}

function saveAssetEditorPackName() {
    let input = document.getElementById('asset-editor-pack-name-input');
    if (!input) return;
    let nextName = String(input.value || '').trim() || ASSET_EDITOR_DEFAULT_PACK_NAME;
    if (nextName === getCurrentAssetPackName()) {
        input.value = nextName;
        return;
    }
    setCurrentAssetPack(getAssetPackSnapshot(), { name: nextName });
    input.value = nextName;
}

function saveCurrentAssetEditorAsset() {
    let key = assetEditorState.selectedKey;
    let asset = ensureWorkingAsset(key);
    saveThingAssetOverride(key, asset, { packName: getCurrentAssetPackName() });
    assetEditorState.workingAssets[key] = getEditableThingAssetSnapshot(key);
    renderAssetEditor();
    if (typeof showUiBanner === 'function') showUiBanner('Asset saved.', 'success');
}

function resetCurrentAssetEditorAsset() {
    let key = assetEditorState.selectedKey;
    clearThingAssetOverride(key);
    assetEditorState.workingAssets[key] = getEditableThingAssetSnapshot(key);
    assetEditorState.selectedAnimation = 'idle';
    assetEditorState.selectedFrame = 0;
    assetEditorState.activeLayer = getAssetEditorHighestVoxelLayer(getAssetEditorFrameData().voxels);
    renderAssetEditor();
    if (typeof showUiBanner === 'function') showUiBanner('Asset reset to pack default.', 'success');
}

function resetAssetEditorCurrentFrame() {
    let asset = ensureWorkingAsset(assetEditorState.selectedKey);
    let animation = getAssetEditorCurrentAnimation(asset);
    let fallbackAsset = getThingAsset(assetEditorState.selectedKey);
    let fallbackAnimation = ensureThingAssetAnimation(fallbackAsset, assetEditorState.selectedAnimation);
    animation.frames[assetEditorState.selectedFrame] = assetClone(fallbackAnimation.frames[assetEditorState.selectedFrame]);
    if (assetEditorState.selectedAnimation === 'idle') asset.model.parts = assetClone(animation.frames[assetEditorState.selectedFrame].parts);
    assetEditorState.activeLayer = getAssetEditorHighestVoxelLayer(getAssetEditorFrameData().voxels);
    renderAssetEditor();
}

function copyPreviousAssetEditorFrame() {
    let asset = ensureWorkingAsset(assetEditorState.selectedKey);
    let animation = getAssetEditorCurrentAnimation(asset);
    let sourceIndex = (assetEditorState.selectedFrame + ASSET_EDITOR_FRAME_COUNT - 1) % ASSET_EDITOR_FRAME_COUNT;
    animation.frames[assetEditorState.selectedFrame] = assetClone(animation.frames[sourceIndex]);
    if (assetEditorState.selectedAnimation === 'idle') asset.model.parts = assetClone(animation.frames[assetEditorState.selectedFrame].parts);
    assetEditorState.activeLayer = getAssetEditorHighestVoxelLayer(getAssetEditorFrameData().voxels);
    renderAssetEditor();
}

function clearAssetEditorCurrentFrame() {
    updateAssetEditorFrameData((data) => {
        data.voxels.clear();
    });
    assetEditorState.viewportHover = null;
    renderAssetEditorViewportStatus();
    renderAssetEditorPreview();
}

function clearAssetEditorActiveLayer() {
    updateAssetEditorFrameData((data) => {
        for (let vx = 0; vx < ASSET_EDITOR_VOXEL_WIDTH; vx++) {
            for (let vy = 0; vy < ASSET_EDITOR_VOXEL_DEPTH; vy++) data.voxels.delete(makeAssetEditorVoxelKey(vx, vy, assetEditorState.activeLayer));
        }
    });
    renderAssetEditorVoxelCanvas();
    renderAssetEditorPreview();
}

function openAssetEditor(startKey) {
    let overlay = document.getElementById('asset-editor-overlay');
    if (!overlay) return;
    if (startKey) {
        assetEditorState.selectedKey = startKey;
        assetEditorState.activeCategory = getThingAssetCategory(startKey);
    } else if (!getAssetEditorCategoryItems(assetEditorState.activeCategory).includes(assetEditorState.selectedKey)) {
        assetEditorState.activeCategory = getThingAssetCategory(assetEditorState.selectedKey);
    }
    ensureWorkingAsset(assetEditorState.selectedKey);
    assetEditorState.open = true;
    assetEditorState.play = false;
    assetEditorState.lastFrameAt = 0;
    assetEditorState.lastTickAt = 0;
    assetEditorState.viewportHover = null;
    assetEditorState.viewportPointer = null;
    assetEditorState.pointerLocked = false;
    resetAssetEditorCamera();
    assetEditorState.activeLayer = getAssetEditorHighestVoxelLayer(getAssetEditorFrameData().voxels);
    overlay.style.display = 'flex';
    let previewRenderer = ensureAssetEditorPreviewRenderer();
    if (previewRenderer) previewRenderer.setEnabled(true);
    syncAssetEditorPackNameInput();
    renderAssetEditor();
}

function closeAssetEditor() {
    assetEditorState.open = false;
    let canvas = document.getElementById('asset-editor-canvas');
    if (document.pointerLockElement === canvas && document.exitPointerLock) {
        try { document.exitPointerLock(); } catch { }
    }
    assetEditorState.viewportDrag = null;
    assetEditorState.viewportHover = null;
    assetEditorState.viewportPointer = null;
    assetEditorState.movementKeys = {};
    assetEditorState.pointerLocked = false;
    let overlay = document.getElementById('asset-editor-overlay');
    if (overlay) overlay.style.display = 'none';
    if (assetEditorState.previewRenderer) assetEditorState.previewRenderer.setEnabled(false);
}

function initAssetEditor() {
    let overlay = document.getElementById('asset-editor-overlay');
    if (!overlay || overlay.dataset.assetEditorBound) return;
    overlay.dataset.assetEditorBound = '1';

    let viewportCanvas = document.getElementById('asset-editor-canvas');
    if (viewportCanvas && !viewportCanvas.dataset.assetEditorBound) {
        viewportCanvas.dataset.assetEditorBound = '1';
        viewportCanvas.tabIndex = 0;
        bindAssetEditorViewportCanvas(viewportCanvas);
    }

    if (!window.__assetEditorMovementBound) {
        window.__assetEditorMovementBound = true;
        window.addEventListener('keydown', (ev) => handleAssetEditorMovementKey(ev, true));
        window.addEventListener('keyup', (ev) => handleAssetEditorMovementKey(ev, false));
        document.addEventListener('pointerlockchange', syncAssetEditorPointerLockState);
        document.addEventListener('mousemove', handleAssetEditorPointerLockLook);
    }

    let assetsBtn = document.getElementById('btn-assets-edit');
    if (assetsBtn) bindInstantPress(assetsBtn, () => openAssetEditor());

    let closeBtn = document.getElementById('btn-asset-editor-close');
    if (closeBtn) bindInstantPress(closeBtn, () => closeAssetEditor());

    let playBtn = document.getElementById('btn-asset-editor-play');
    if (playBtn) bindInstantPress(playBtn, () => {
        assetEditorState.play = !assetEditorState.play;
        assetEditorState.lastFrameAt = 0;
        renderAssetEditorFrameControls();
    });

    let prevBtn = document.getElementById('btn-asset-editor-prev-frame');
    if (prevBtn) bindInstantPress(prevBtn, () => setAssetEditorFrame(assetEditorState.selectedFrame - 1));

    let nextBtn = document.getElementById('btn-asset-editor-next-frame');
    if (nextBtn) bindInstantPress(nextBtn, () => setAssetEditorFrame(assetEditorState.selectedFrame + 1));

    let frameRange = document.getElementById('asset-editor-frame-range');
    if (frameRange && !frameRange.dataset.assetEditorBound) {
        frameRange.dataset.assetEditorBound = '1';
        frameRange.addEventListener('input', () => setAssetEditorFrame(Number(frameRange.value || 0)));
    }

    let clearFrameBtn = document.getElementById('btn-asset-editor-clear-frame');
    if (clearFrameBtn) bindInstantPress(clearFrameBtn, () => clearAssetEditorCurrentFrame());

    let cursorRadiusRange = document.getElementById('asset-editor-cursor-radius-range');
    if (cursorRadiusRange && !cursorRadiusRange.dataset.assetEditorBound) {
        cursorRadiusRange.dataset.assetEditorBound = '1';
        cursorRadiusRange.addEventListener('input', () => {
            assetEditorState.cursorRadius = Math.max(0, Math.min(6, Math.floor(Number(cursorRadiusRange.value) || 0)));
            renderAssetEditorCursorRadiusControls();
            renderAssetEditorViewportStatus();
            renderAssetEditorPreview();
        });
    }

    let copyPrevBtn = document.getElementById('btn-asset-editor-copy-prev-frame');
    if (copyPrevBtn) bindInstantPress(copyPrevBtn, () => copyPreviousAssetEditorFrame());

    let resetFrameBtn = document.getElementById('btn-asset-editor-reset-frame');
    if (resetFrameBtn) bindInstantPress(resetFrameBtn, () => resetAssetEditorCurrentFrame());

    let saveAssetBtn = document.getElementById('btn-asset-editor-save-asset');
    if (saveAssetBtn) bindInstantPress(saveAssetBtn, () => saveCurrentAssetEditorAsset());

    let resetAssetBtn = document.getElementById('btn-asset-editor-reset-asset');
    if (resetAssetBtn) bindInstantPress(resetAssetBtn, () => resetCurrentAssetEditorAsset());

    let importBtn = document.getElementById('btn-asset-editor-import-pack');
    let importInput = document.getElementById('input-import-assets');
    if (importBtn && importInput) {
        bindInstantPress(importBtn, () => importInput.click());
        if (!importInput.dataset.assetEditorBound) {
            importInput.dataset.assetEditorBound = '1';
            importInput.addEventListener('change', (ev) => {
                let file = ev.target && ev.target.files ? ev.target.files[0] : null;
                if (file) {
                    importAssetPackFromFile(file);
                    assetEditorState.workingAssets = {};
                    renderAssetEditor();
                }
                importInput.value = '';
            });
        }
    }

    let exportBtn = document.getElementById('btn-asset-editor-save-pack');
    if (exportBtn) bindInstantPress(exportBtn, () => {
        saveAssetEditorPackName();
        downloadCurrentAssetPack();
    });

    let packNameInput = document.getElementById('asset-editor-pack-name-input');
    if (packNameInput && !packNameInput.dataset.assetEditorBound) {
        packNameInput.dataset.assetEditorBound = '1';
        packNameInput.addEventListener('change', saveAssetEditorPackName);
        packNameInput.addEventListener('blur', saveAssetEditorPackName);
        packNameInput.addEventListener('keydown', (ev) => {
            if (ev.key === 'Enter') {
                saveAssetEditorPackName();
                packNameInput.blur();
            }
        });
    }

    syncAssetEditorPackNameInput();
    renderAssetEditorViewportStatus();
    requestAnimationFrame(assetEditorAnimationLoop);
}

window.openAssetEditor = openAssetEditor;
window.closeAssetEditor = closeAssetEditor;
window.initAssetEditor = initAssetEditor;
window.renderAssetEditor = renderAssetEditor;