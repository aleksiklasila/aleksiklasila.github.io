
// ============================================================
// AUDIO ENGINE
// ============================================================
let audioCtx = null;
let masterGain = null;
let audioEnabled = true;
let _laserAudioNodes = null; // {osc, gain} for sustained laser buzz
let _laserAudioActive = false;
let _kingHurtTimer = 0;
let _damageAlertTimer = 0;
let _kingDamageAlertTimer = 0;
let _bgMusicNodes = null;
let _bgMusicAnalyser = null;
let _bgMusicAnalyserData = null;
let _bgMusicReactiveSmoothedLevel = 0;
let _bgMusicReactiveLevelHistory = [];
const _audioAssetCache = new Map();
const _audioAssetPending = new Map();
const _audioAssetMissing = new Set();
const AUDIO_ASSET_BASE_PATH = 'assets/audio';
const AUDIO_ASSET_EXTENSIONS = ['wav', 'mp3'];
const AUDIO_BACKGROUND_TRACKS = ['background_music', 'background_audio'];

let audioSpatialGrid = [];
let audioSpatialGridBackground = [];
let audioSpatialGridEffects = [];
let audioReactiveGlobalOffsetX = 0;
let audioReactiveGlobalOffsetY = 0;
let audioReactiveBackgroundLevel = 0;
let audioReactiveEffectsLevel = 0;
let audioReactiveTextureVersion = 0;

let AUDIO_REACTIVE_RENDER_3D_POSITION_FROM_BG = 0;
let AUDIO_REACTIVE_RENDER_3D_POSITION_FROM_SFX = 0;
let AUDIO_REACTIVE_RENDER_3D_HEIGHT_FROM_BG = 0.64;
let AUDIO_REACTIVE_RENDER_3D_HEIGHT_FROM_SFX = 0.11;
let AUDIO_REACTIVE_RENDER_2D_POSITION_FROM_BG = 0;
let AUDIO_REACTIVE_RENDER_2D_POSITION_FROM_SFX = 0;
let AUDIO_REACTIVE_RENDER_2D_SCALE_FROM_BG = 0;
let AUDIO_REACTIVE_RENDER_2D_SCALE_FROM_SFX = 0;

const AUDIO_MASTER_GAIN_MIN = 0;
const AUDIO_MASTER_GAIN_MAX = 0.85;

const AUDIO_PITCH_SCALE = 0.68;
const AUDIO_SPATIAL_MIN_GAIN = 0.001;
const AUDIO_SPATIAL_2D_NEAR_DISTANCE_TILES = 2.5;
const AUDIO_SPATIAL_2D_FAR_DISTANCE_TILES = 14;
const AUDIO_SPATIAL_2D_FALLOFF_EXPONENT = 3.8;
const AUDIO_SPATIAL_2D_HEIGHT_VIEW_FACTOR = 0.34;
const AUDIO_SPATIAL_3D_NEAR_DISTANCE_TILES = 2.5;
const AUDIO_SPATIAL_3D_FAR_DISTANCE_TILES = 18;
const AUDIO_SPATIAL_3D_FALLOFF_EXPONENT = 3.2;
const AUDIO_SPATIAL_3D_DISTANCE_FACTOR = 1.25;
const AUDIO_AMBIENT_WORK_MIN_TICKS = 10;
const AUDIO_REACTIVE_GRID_UPDATE_INTERVAL = 3;
const AUDIO_REACTIVE_BG_PULSE_SCALE = 0.42;
const AUDIO_REACTIVE_BG_SWELL_SCALE = 0.23;
const AUDIO_REACTIVE_BG_RADIAL_WAVELENGTH_TILES = 5.5;
const AUDIO_REACTIVE_BG_RADIAL_SCROLL_SPEED = 2.1;
const AUDIO_REACTIVE_BG_EDGE_BLEND = 0.35;
const AUDIO_REACTIVE_BG_ANALYSER_GAIN = 1.85;
const AUDIO_REACTIVE_BG_ANALYSER_HISTORY = 8;
const AUDIO_REACTIVE_BG_ANALYSER_SMOOTHING = 0.18;
const AUDIO_REACTIVE_BG_TILE_SMOOTH_ACCEL = 0.34;
const AUDIO_REACTIVE_BG_TILE_SMOOTH_DAMPING = 0.74;
const AUDIO_REACTIVE_FX_EMITTER_MAX = 48;
const AUDIO_REACTIVE_FX_DEFAULT_RADIUS_TILES = 4.2;
const AUDIO_REACTIVE_FX_DEFAULT_LIFE_TICKS = 12;
let CONTROL_GROUP_ALERT_TICKS = Math.floor(TICK_RATE * 2.2);
let MAP_ALERT_DURATION = Math.floor(TICK_RATE * 1.8);
let MAP_KING_ALERT_DURATION = Math.floor(TICK_RATE * 2.6);
let _audioReactiveEmitters = [];
let _audioSpatialGridPrev = [];
let _audioSpatialGridTarget = [];
let _audioSpatialGridBackgroundPrev = [];
let _audioSpatialGridBackgroundTarget = [];
let _audioSpatialGridBackgroundVelocity = [];
let _audioSpatialGridEffectsPrev = [];
let _audioSpatialGridEffectsTarget = [];
let _audioReactiveLastGridTick = -1;
let _audioTypeBurstState = Object.create(null);

function _makeAudioReactiveGridRows() {
    let rows = new Array(Math.max(0, GRID_H | 0));
    for (let y = 0; y < rows.length; y++) rows[y] = new Float32Array(Math.max(0, GRID_W | 0));
    return rows;
}

function _ensureAudioReactiveGrid() {
    if (!Number.isFinite(GRID_W) || !Number.isFinite(GRID_H) || GRID_W <= 0 || GRID_H <= 0) return;
    if (audioSpatialGrid.length === GRID_H && audioSpatialGrid[0] && audioSpatialGrid[0].length === GRID_W) return;
    audioSpatialGrid = _makeAudioReactiveGridRows();
    audioSpatialGridBackground = _makeAudioReactiveGridRows();
    audioSpatialGridEffects = _makeAudioReactiveGridRows();
    _audioSpatialGridPrev = _makeAudioReactiveGridRows();
    _audioSpatialGridTarget = _makeAudioReactiveGridRows();
    _audioSpatialGridBackgroundPrev = _makeAudioReactiveGridRows();
    _audioSpatialGridBackgroundTarget = _makeAudioReactiveGridRows();
    _audioSpatialGridBackgroundVelocity = _makeAudioReactiveGridRows();
    _audioSpatialGridEffectsPrev = _makeAudioReactiveGridRows();
    _audioSpatialGridEffectsTarget = _makeAudioReactiveGridRows();
    _audioReactiveLastGridTick = -1;
    audioReactiveTextureVersion = 0;
}

function _copyAudioReactiveGridRows(targetRows, sourceRows) {
    let rowCount = Math.min(targetRows.length, sourceRows.length);
    for (let y = 0; y < rowCount; y++) targetRows[y].set(sourceRows[y]);
}

function _getAudioReactiveNowSeconds() {
    if (audioCtx) return audioCtx.currentTime;
    if (typeof performance !== 'undefined' && typeof performance.now === 'function') return performance.now() * 0.001;
    return Date.now() * 0.001;
}

function _getBackgroundMusicReactiveLevel(nowSeconds) {
    if (!audioEnabled || !_bgMusicNodes || !_bgMusicAnalyser || !_bgMusicAnalyserData) return 0;
    let analyser = _bgMusicAnalyser;
    let data = _bgMusicAnalyserData;
    let rms = 0;
    let peak = 0;
    if (typeof analyser.getFloatTimeDomainData === 'function') {
        analyser.getFloatTimeDomainData(data);
        let sumSq = 0;
        for (let i = 0; i < data.length; i++) {
            let sample = Number(data[i]) || 0;
            sumSq += sample * sample;
            let absSample = Math.abs(sample);
            if (absSample > peak) peak = absSample;
        }
        rms = Math.sqrt(sumSq / Math.max(1, data.length));
    } else {
        analyser.getByteTimeDomainData(data);
        let sumSq = 0;
        for (let i = 0; i < data.length; i++) {
            let sample = ((Number(data[i]) || 128) - 128) / 128;
            sumSq += sample * sample;
            let absSample = Math.abs(sample);
            if (absSample > peak) peak = absSample;
        }
        rms = Math.sqrt(sumSq / Math.max(1, data.length));
    }

    let rawLevel = Math.max(0, Math.min(1, (rms * 4.6 + peak * 1.15) * AUDIO_REACTIVE_BG_ANALYSER_GAIN));
    _bgMusicReactiveLevelHistory.push(rawLevel);
    if (_bgMusicReactiveLevelHistory.length > AUDIO_REACTIVE_BG_ANALYSER_HISTORY) {
        _bgMusicReactiveLevelHistory.splice(0, _bgMusicReactiveLevelHistory.length - AUDIO_REACTIVE_BG_ANALYSER_HISTORY);
    }
    let averagedLevel = 0;
    for (let i = 0; i < _bgMusicReactiveLevelHistory.length; i++) averagedLevel += _bgMusicReactiveLevelHistory[i];
    averagedLevel /= Math.max(1, _bgMusicReactiveLevelHistory.length);
    _bgMusicReactiveSmoothedLevel += (averagedLevel - _bgMusicReactiveSmoothedLevel) * AUDIO_REACTIVE_BG_ANALYSER_SMOOTHING;
    return Math.max(0, Math.min(1, _bgMusicReactiveSmoothedLevel));
}

function _getBackgroundReactiveTileLevel(baseLevel, tileX, tileY, nowSeconds) {
    if (!(baseLevel > 0) || !Number.isFinite(tileX) || !Number.isFinite(tileY)) return 0;
    let centerX = GRID_W * 0.5;
    let centerY = GRID_H * 0.5;
    let dx = tileX + 0.5 - centerX;
    let dy = tileY + 0.5 - centerY;
    let dist = Math.hypot(dx, dy);
    let maxDist = Math.max(1, Math.hypot(Math.max(centerX, GRID_W - centerX), Math.max(centerY, GRID_H - centerY)));
    let distNorm = Math.max(0, Math.min(1, dist / maxDist));
    let centerWeight = Math.max(0, 1 - distNorm);
    let wavePhase = dist / Math.max(0.001, AUDIO_REACTIVE_BG_RADIAL_WAVELENGTH_TILES) - nowSeconds * AUDIO_REACTIVE_BG_RADIAL_SCROLL_SPEED;
    let wave = Math.sin(wavePhase * Math.PI * 2);
    let waveAmount = AUDIO_REACTIVE_BG_PULSE_SCALE * (AUDIO_REACTIVE_BG_EDGE_BLEND + centerWeight * (1 - AUDIO_REACTIVE_BG_EDGE_BLEND));
    let waveScale = 1 + wave * waveAmount;
    let swellScale = 1 + centerWeight * centerWeight * AUDIO_REACTIVE_BG_SWELL_SCALE;
    return Math.max(0, Math.min(1.5, baseLevel * waveScale * swellScale));
}

function _recordAudioReactiveEmitter(type, worldX, worldY, strength = 0.75) {
    if (!Number.isFinite(worldX) || !Number.isFinite(worldY)) return;
    let normalizedType = String(type || '').trim();
    let radiusTiles = AUDIO_REACTIVE_FX_DEFAULT_RADIUS_TILES;
    let lifeTicks = AUDIO_REACTIVE_FX_DEFAULT_LIFE_TICKS;
    let baseStrength = Math.max(0.08, Math.min(1.4, Number(strength) || 0.75));

    if (normalizedType === 'mine_explode' || normalizedType === 'building_destroyed') {
        radiusTiles = 6.2;
        lifeTicks = 18;
        baseStrength = Math.max(baseStrength, 1.05);
    } else if (normalizedType === 'laser_tick') {
        radiusTiles = 5.4;
        lifeTicks = 8;
        baseStrength = Math.max(baseStrength, 0.62);
    } else if (normalizedType === 'victory' || normalizedType === 'defeat') {
        radiusTiles = 8.5;
        lifeTicks = 28;
        baseStrength = Math.max(baseStrength, 0.95);
    } else if (normalizedType === 'melee_hit' || normalizedType === 'heal_tick' || normalizedType === 'builder_work') {
        radiusTiles = 2.8;
        lifeTicks = 8;
        baseStrength *= 0.78;
    }

    _audioReactiveEmitters.push({
        x: worldX,
        y: worldY,
        radiusTiles,
        life: lifeTicks,
        maxLife: lifeTicks,
        strength: baseStrength
    });
    if (_audioReactiveEmitters.length > AUDIO_REACTIVE_FX_EMITTER_MAX) {
        _audioReactiveEmitters.splice(0, _audioReactiveEmitters.length - AUDIO_REACTIVE_FX_EMITTER_MAX);
    }
}

function updateAudioReactiveState() {
    _ensureAudioReactiveGrid();
    if (!audioSpatialGrid.length) return;

    let nowTick = Number.isFinite(gameTime) ? gameTime : 0;
    let nowSeconds = _getAudioReactiveNowSeconds();

    for (let i = _audioReactiveEmitters.length - 1; i >= 0; i--) {
        let emitter = _audioReactiveEmitters[i];
        emitter.life--;
        if (emitter.life <= 0) _audioReactiveEmitters.splice(i, 1);
    }

    audioReactiveBackgroundLevel = _getBackgroundMusicReactiveLevel(nowSeconds);
    let fxPeak = 0;
    for (let i = 0; i < _audioReactiveEmitters.length; i++) {
        let emitter = _audioReactiveEmitters[i];
        let age = Math.max(0, Math.min(1, emitter.life / Math.max(1, emitter.maxLife)));
        fxPeak = Math.max(fxPeak, emitter.strength * age);
    }
    audioReactiveEffectsLevel = Math.max(0, Math.min(1.2, fxPeak));

    let offsetPulse = audioReactiveBackgroundLevel + audioReactiveEffectsLevel * 0.5;
    audioReactiveGlobalOffsetX = Math.sin(nowSeconds * 1.45) * offsetPulse + Math.sin(nowSeconds * 3.6 + 0.9) * audioReactiveEffectsLevel * 0.22;
    audioReactiveGlobalOffsetY = Math.cos(nowSeconds * 1.18 + 0.4) * offsetPulse + Math.cos(nowSeconds * 3.1 + 1.7) * audioReactiveEffectsLevel * 0.18;

    if (_audioReactiveLastGridTick < 0 || nowTick - _audioReactiveLastGridTick >= AUDIO_REACTIVE_GRID_UPDATE_INTERVAL) {
        _copyAudioReactiveGridRows(_audioSpatialGridPrev, audioSpatialGrid);
        _copyAudioReactiveGridRows(_audioSpatialGridBackgroundPrev, audioSpatialGridBackground);
        _copyAudioReactiveGridRows(_audioSpatialGridEffectsPrev, audioSpatialGridEffects);

        for (let y = 0; y < GRID_H; y++) {
            let bgTargetRow = _audioSpatialGridBackgroundTarget[y];
            let bgVelocityRow = _audioSpatialGridBackgroundVelocity[y];
            let fxTargetRow = _audioSpatialGridEffectsTarget[y];
            let totalTargetRow = _audioSpatialGridTarget[y];
            for (let x = 0; x < GRID_W; x++) {
                let rawBgValue = _getBackgroundReactiveTileLevel(audioReactiveBackgroundLevel, x, y, nowSeconds);
                let bgDelta = rawBgValue - bgTargetRow[x];
                let nextVelocity = (bgVelocityRow[x] + bgDelta * AUDIO_REACTIVE_BG_TILE_SMOOTH_ACCEL) * AUDIO_REACTIVE_BG_TILE_SMOOTH_DAMPING;
                let nextValue = bgTargetRow[x] + nextVelocity;
                if (Math.abs(rawBgValue - nextValue) < 0.001 && Math.abs(nextVelocity) < 0.001) {
                    nextValue = rawBgValue;
                    nextVelocity = 0;
                }
                bgVelocityRow[x] = nextVelocity;
                bgTargetRow[x] = Math.max(0, Math.min(1.5, nextValue));
                fxTargetRow[x] = 0;
                totalTargetRow[x] = bgTargetRow[x];
            }
        }

        for (let i = 0; i < _audioReactiveEmitters.length; i++) {
            let emitter = _audioReactiveEmitters[i];
            let centerX = emitter.x / TILE;
            let centerY = emitter.y / TILE;
            let radiusTiles = Math.max(0.75, emitter.radiusTiles || AUDIO_REACTIVE_FX_DEFAULT_RADIUS_TILES);
            let radiusSq = radiusTiles * radiusTiles;
            let minX = Math.max(0, Math.floor(centerX - radiusTiles));
            let maxX = Math.min(GRID_W - 1, Math.ceil(centerX + radiusTiles));
            let minY = Math.max(0, Math.floor(centerY - radiusTiles));
            let maxY = Math.min(GRID_H - 1, Math.ceil(centerY + radiusTiles));
            let age = Math.max(0, Math.min(1, emitter.life / Math.max(1, emitter.maxLife)));
            let amplitude = emitter.strength * age;

            for (let gy = minY; gy <= maxY; gy++) {
                let fy = gy + 0.5 - centerY;
                let fxTargetRow = _audioSpatialGridEffectsTarget[gy];
                let totalTargetRow = _audioSpatialGridTarget[gy];
                for (let gx = minX; gx <= maxX; gx++) {
                    let fx = gx + 0.5 - centerX;
                    let distSq = fx * fx + fy * fy;
                    if (distSq > radiusSq) continue;
                    let dist = Math.sqrt(distSq);
                    let falloff = 1 - dist / radiusTiles;
                    let value = amplitude * falloff * falloff;
                    fxTargetRow[gx] = Math.min(1.5, fxTargetRow[gx] + value);
                    totalTargetRow[gx] = Math.min(1.75, totalTargetRow[gx] + value);
                }
            }
        }

        _audioReactiveLastGridTick = nowTick;
        audioReactiveTextureVersion++;
    }

    let blend = (_audioReactiveLastGridTick < 0)
        ? 1
        : Math.max(0, Math.min(1, (nowTick - _audioReactiveLastGridTick + AUDIO_REACTIVE_GRID_UPDATE_INTERVAL) / AUDIO_REACTIVE_GRID_UPDATE_INTERVAL));
    for (let y = 0; y < GRID_H; y++) {
        let totalRow = audioSpatialGrid[y];
        let totalPrevRow = _audioSpatialGridPrev[y];
        let totalTargetRow = _audioSpatialGridTarget[y];
        let bgRow = audioSpatialGridBackground[y];
        let bgPrevRow = _audioSpatialGridBackgroundPrev[y];
        let bgTargetRow = _audioSpatialGridBackgroundTarget[y];
        let fxRow = audioSpatialGridEffects[y];
        let fxPrevRow = _audioSpatialGridEffectsPrev[y];
        let fxTargetRow = _audioSpatialGridEffectsTarget[y];
        for (let x = 0; x < GRID_W; x++) {
            bgRow[x] = bgPrevRow[x] + (bgTargetRow[x] - bgPrevRow[x]) * blend;
            fxRow[x] = fxPrevRow[x] + (fxTargetRow[x] - fxPrevRow[x]) * blend;
            totalRow[x] = totalPrevRow[x] + (totalTargetRow[x] - totalPrevRow[x]) * blend;
        }
    }
}

function applyTimingConfig(nextTickRate, nextPipelineMin) {
    let tps = Number.isFinite(nextTickRate) ? Math.floor(nextTickRate) : TICK_RATE;
    let pipelineMin = Number.isFinite(nextPipelineMin) ? Math.floor(nextPipelineMin) : LOCKSTEP_PIPELINE_MIN;

    TICK_RATE = Math.max(5, Math.min(120, tps));
    LOCKSTEP_PIPELINE_MIN = Math.max(0, Math.min(12, pipelineMin));

    TICK_MS = 1000 / TICK_RATE;
    LOCKSTEP_PIPELINE_TICKS = Math.max(INPUT_DELAY, LOCKSTEP_PIPELINE_MIN);
    LOCKSTEP_PACKET_RESEND_MS = Math.max(40, Math.floor(TICK_MS * 2));
    LOCKSTEP_BUNDLE_RESEND_MS = Math.max(40, Math.floor(TICK_MS * 2));
    LOCKSTEP_RESEND_REQUEST_MS = getLockstepResendRequestMs();
    LOCKSTEP_HARD_RESYNC_MS = getLockstepHardResyncMs();
    LOCKSTEP_STATE_CHECK_INTERVAL = Math.max(1, Math.floor(TICK_RATE / 2));

    CONTROL_GROUP_ALERT_TICKS = Math.floor(TICK_RATE * 2.2);
    MAP_ALERT_DURATION = Math.floor(TICK_RATE * 1.8);
    MAP_KING_ALERT_DURATION = Math.floor(TICK_RATE * 2.6);
}

function ensureControlGroupAlertState(num) {
    if (!controlGroupAlertState[num]) controlGroupAlertState[num] = { damageUntil: 0, kingUntil: 0 };
    return controlGroupAlertState[num];
}

function getControlGroupSnapshot(num) {
    let grp = controlGroups[num];
    if (!grp) return null;
    // Backward compatibility: older saves stored an array of units only.
    if (Array.isArray(grp)) {
        grp = { units: grp, entities: [], activeSubGroups: {} };
        controlGroups[num] = grp;
    }
    if (!Array.isArray(grp.units)) grp.units = [];
    if (!Array.isArray(grp.entities)) grp.entities = [];
    if (!grp.activeSubGroups || typeof grp.activeSubGroups !== 'object') grp.activeSubGroups = {};
    return grp;
}

function normalizeControlGroup(num) {
    let grp = getControlGroupSnapshot(num);
    if (!grp) return;
    grp.units = grp.units.filter(u => u && !u.dead);
    grp.entities = grp.entities.filter(e => e && !(e.energy !== undefined && e.energy <= 0));
    if (grp.units.length === 0 && grp.entities.length === 0) delete controlGroups[num];
}

function getPopupControlGroupSnapshot(key) {
    let grp = popupControlGroups[key];
    if (!grp) return null;
    if (!Array.isArray(grp.units)) grp.units = [];
    if (!Array.isArray(grp.entities)) grp.entities = [];
    if (!grp.activeSubGroups || typeof grp.activeSubGroups !== 'object') grp.activeSubGroups = {};
    return grp;
}

function normalizePopupControlGroup(key) {
    let grp = getPopupControlGroupSnapshot(key);
    if (!grp) return;
    grp.units = grp.units.filter(u => u && !u.dead);
    grp.entities = grp.entities.filter(e => e && !(e.energy !== undefined && e.energy <= 0));
    if (grp.units.length === 0 && grp.entities.length === 0) {
        delete popupControlGroups[key];
        if (activePopupControlGroupKey === key) activePopupControlGroupKey = '';
    }
}

function doesCurrentSelectionMatchSnapshot(grp) {
    if (!grp) return false;
    let aliveUnits = (grp.units || []).filter(u => u && !u.dead);
    let aliveEntities = (grp.entities || []).filter(e => e && !(e.energy !== undefined && e.energy <= 0));
    if (aliveUnits.length === 0 && aliveEntities.length === 0) return false;
    if (selectedUnits.length !== aliveUnits.length || selectedEntities.length !== aliveEntities.length) return false;
    if (!aliveUnits.every(u => selectedUnits.includes(u))) return false;
    if (!aliveEntities.every(e => selectedEntities.includes(e))) return false;

    let saved = grp.activeSubGroups || {};
    for (let k in saved) {
        if ((activeSubGroups[k] !== false) !== (saved[k] !== false)) return false;
    }
    return true;
}

function getUnitWorldPos(u) {
    if (!u) return { x: 0, y: 0 };
    if (u.x !== undefined && u.y !== undefined) return { x: u.x, y: u.y };
    let gx = u.gx !== undefined ? u.gx : (u._gx !== undefined ? u._gx : 0);
    let gy = u.gy !== undefined ? u.gy : (u._gy !== undefined ? u._gy : 0);
    return { x: gx * TILE + TILE / 2, y: gy * TILE + TILE / 2 };
}

function markControlGroupsDamaged(unit, isKing) {
    if (!unit) return;
    for (let n = 1; n <= 9; n++) {
        let key = String(n);
        let grp = getControlGroupSnapshot(key);
        if (!grp) continue;
        if (grp.units.length === 0 && grp.entities.length === 0) continue;
        if (!grp.units.includes(unit) && !grp.entities.includes(unit)) continue;
        let st = ensureControlGroupAlertState(key);
        st.damageUntil = Math.max(st.damageUntil, gameTime + CONTROL_GROUP_ALERT_TICKS);
        if (isKing) st.kingUntil = Math.max(st.kingUntil, gameTime + CONTROL_GROUP_ALERT_TICKS);
    }
}

function pushDamageAlert(target, dmg) {
    if (!target || !Number.isFinite(dmg) || dmg <= 0.35) return;
    let isKing = !!target.isKing;
    let pos = getUnitWorldPos(target);
    mapAlerts.push({ x: pos.x, y: pos.y, start: gameTime, dur: isKing ? MAP_KING_ALERT_DURATION : MAP_ALERT_DURATION, kind: isKing ? 'king' : 'damage' });
    if (mapAlerts.length > 40) mapAlerts.splice(0, mapAlerts.length - 40);

    markControlGroupsDamaged(target, isKing);

    if (isKing) {
        if (!_kingDamageAlertTimer || gameTime > _kingDamageAlertTimer + Math.floor(TICK_RATE * 0.9)) {
            _kingDamageAlertTimer = gameTime;
            playSound('alert_king_damage', pos.x, pos.y);
        }
    } else {
        if (!_damageAlertTimer || gameTime > _damageAlertTimer + Math.floor(TICK_RATE * 0.6)) {
            _damageAlertTimer = gameTime;
            playSound('alert_damage', pos.x, pos.y);
        }
    }
}

function pushHostileDamageAlert(target, dmg, sourceOwner) {
    if (!target || !Number.isFinite(dmg) || dmg <= 0.35) return;
    if (!Number.isFinite(sourceOwner) || sourceOwner < 0) return;
    if (!Number.isFinite(localPlayerId)) return;
    if (sourceOwner === localPlayerId) return;
    if (!Number.isFinite(target.owner) || target.owner !== localPlayerId) return;
    pushDamageAlert(target, dmg);
}

function drawMinimapAlerts(ctx, scale) {
    if (!mapAlerts.length) return;
    let now = gameTime + tickAlpha;
    for (let i = mapAlerts.length - 1; i >= 0; i--) {
        let a = mapAlerts[i];
        let age = now - a.start;
        if (age >= a.dur) {
            mapAlerts.splice(i, 1);
            continue;
        }
        let p = Math.max(0, Math.min(1, age / a.dur));
        let worldRadius = 6 + p * (a.kind === 'king' ? 54 : 40);
        let radius = (worldRadius / TILE) * scale;
        let alpha = Math.pow(1 - p, 1.4);
        let rgb = a.kind === 'king' ? '255,58,58' : '255,140,80';
        let mx = (a.x / TILE) * scale;
        let my = (a.y / TILE) * scale;

        ctx.strokeStyle = `rgba(${rgb},${0.9 * alpha})`;
        ctx.lineWidth = a.kind === 'king' ? 1.4 : 1.1;
        ctx.beginPath();
        ctx.arc(mx, my, radius, 0, Math.PI * 2);
        ctx.stroke();

        ctx.strokeStyle = `rgba(${rgb},${0.45 * alpha})`;
        ctx.lineWidth = 0.9;
        ctx.beginPath();
        ctx.arc(mx, my, Math.max(0.8, radius * 0.52), 0, Math.PI * 2);
        ctx.stroke();

        ctx.fillStyle = `rgba(${rgb},${0.35 * alpha})`;
        ctx.beginPath();
        ctx.arc(mx, my, a.kind === 'king' ? 1.6 : 1.2, 0, Math.PI * 2);
        ctx.fill();
    }
}

function isControlGroupSelected(num) {
    let grp = getControlGroupSnapshot(num);
    return doesCurrentSelectionMatchSnapshot(grp);
}

function isPopupControlGroupSelected(key) {
    let grp = getPopupControlGroupSnapshot(key);
    return doesCurrentSelectionMatchSnapshot(grp);
}

function updateControlGroupBar() {
    let bar = document.getElementById('control-group-bar');
    if (!bar) return;
    if (!bar.dataset.built) {
        let html = '<div class="control-group-row number-row">';
        for (let n = 1; n <= 9; n++) html += `<button class="control-group-btn" data-group="${n}" title="Select control group ${n}">${n}</button>`;
        html += '</div>';
        html += '<div class="control-group-row popup-row">';
        for (let key of POPUP_CONTROL_GROUP_KEYS) {
            let label = key.toUpperCase();
            html += `<button class="control-group-btn control-group-popup-btn control-group--popup-btn" data-popup-group="${key}" title="Open popup control group ${label}">${label}</button>`;
        }
        html += '</div>';
        bar.innerHTML = html;
        bar.dataset.built = '1';
        bar.querySelectorAll('.control-group-btn').forEach(btn => {
            if (btn.dataset.popupGroup) return;
            bindInstantPress(btn, () => {
                if (!gameStarted || gameOver) return;
                handleControlGroupKey(btn.dataset.group, false);
            }, {
                longPressMs: 320,
                onLongPress: () => {
                    if (!gameStarted || gameOver) return;
                    handleControlGroupKey(btn.dataset.group, true);
                }
            });
        });
        bar.querySelectorAll('.control-group-popup-btn').forEach(btn => {
            bindInstantPress(btn, () => {
                if (!gameStarted || gameOver) return;
                handlePopupControlGroupKey(btn.dataset.popupGroup, false);
            }, {
                longPressMs: 320,
                onLongPress: () => {
                    if (!gameStarted || gameOver) return;
                    handlePopupControlGroupKey(btn.dataset.popupGroup, true);
                }
            });
        });
    }

    for (let n = 1; n <= 9; n++) {
        let key = String(n);
        normalizeControlGroup(key);
        let btn = bar.querySelector(`.control-group-btn[data-group="${key}"]`);
        if (!btn) continue;
        let grp = getControlGroupSnapshot(key);
        let st = ensureControlGroupAlertState(key);
        let count = grp ? (grp.units.length + grp.entities.length) : 0;
        let hasAssigned = count > 0;
        let hasKingDamage = st.kingUntil > gameTime;
        let hasDamage = st.damageUntil > gameTime;

        btn.classList.toggle('empty', !hasAssigned);
        btn.classList.toggle('assigned', hasAssigned);
        btn.classList.toggle('active', isControlGroupSelected(key));
        btn.classList.toggle('damaged', hasDamage);
        btn.classList.toggle('king-damaged', hasKingDamage);
        btn.title = hasKingDamage ? `Group ${key}: king under attack` : hasDamage ? `Group ${key}: taking damage` : hasAssigned ? `Group ${key}: ${count} item(s)` : `Group ${key}: empty`;
    }

    for (let key of POPUP_CONTROL_GROUP_KEYS) {
        normalizePopupControlGroup(key);
        let btn = bar.querySelector(`.control-group-popup-btn[data-popup-group="${key}"]`);
        if (!btn) continue;
        let grp = getPopupControlGroupSnapshot(key);
        let count = grp ? (grp.units.length + grp.entities.length) : 0;
        let hasAssigned = count > 0;
        btn.classList.toggle('empty', !hasAssigned);
        btn.classList.toggle('assigned', hasAssigned);
        btn.classList.toggle('active', isPopupControlGroupSelected(key));
        btn.title = hasAssigned
            ? `Popup group ${key.toUpperCase()}: ${count} item(s)`
            : `Popup group ${key.toUpperCase()}: empty`;
    }
}

function handleControlGroupKey(num, assignMode) {
    if (!num || num < '1' || num > '9') return;
    if (assignMode) {
        let unitsSnap = selectedUnits.filter(u => u && !u.dead);
        let entitiesSnap = selectedEntities.filter(e => e && !(e.energy !== undefined && e.energy <= 0));
        let subSnap = {};
        for (let u of unitsSnap) {
            let key = getUnitGroupKey(u);
            subSnap[key] = activeSubGroups[key] !== false;
        }
        for (let e of entitiesSnap) {
            let key = getEntityGroupKey(e);
            subSnap[key] = activeSubGroups[key] !== false;
        }
        controlGroups[num] = { units: unitsSnap, entities: entitiesSnap, activeSubGroups: subSnap };
        ensureControlGroupAlertState(num);
    } else if (controlGroups[num]) {
        let grp = getControlGroupSnapshot(num);
        if (!grp) return;
        selectedUnits = grp.units.filter(u => u && !u.dead);
        selectedEntities = grp.entities.filter(e => e && !(e.energy !== undefined && e.energy <= 0));
        activeSubGroups = { ...(grp.activeSubGroups || {}) };
        controlGroups[num] = { units: selectedUnits, entities: selectedEntities, activeSubGroups: { ...activeSubGroups } };
        updateInfoPanel();
    }
    updateControlGroupBar();
}

function handlePopupControlGroupKey(key, assignMode) {
    key = String(key || '').toLowerCase();
    if (!POPUP_CONTROL_GROUP_KEYS.includes(key)) return;
    if (assignMode) {
        let unitsSnap = selectedUnits.filter(u => u && !u.dead);
        let entitiesSnap = selectedEntities.filter(e => e && !(e.energy !== undefined && e.energy <= 0));
        let subSnap = {};
        for (let u of unitsSnap) {
            let gk = getUnitGroupKey(u);
            subSnap[gk] = activeSubGroups[gk] !== false;
        }
        for (let e of entitiesSnap) {
            let gk = getEntityGroupKey(e);
            subSnap[gk] = activeSubGroups[gk] !== false;
        }
        popupControlGroups[key] = { units: unitsSnap, entities: entitiesSnap, activeSubGroups: subSnap };
        updateControlGroupBar();
        return;
    }

    let grp = getPopupControlGroupSnapshot(key);
    if (!grp) return;
    normalizePopupControlGroup(key);
    grp = getPopupControlGroupSnapshot(key);
    if (!grp) {
        updateControlGroupBar();
        return;
    }

    activePopupControlGroupKey = key;
    setResearchPopupOpen(true);
    updateControlGroupBar();
}

function _scaleFreqValue(v) {
    return Math.max(20, v * AUDIO_PITCH_SCALE);
}

function _scaleFreqInput(freq) {
    if (Array.isArray(freq)) return freq.map(f => _scaleFreqValue(f));
    return _scaleFreqValue(freq);
}

function initAudio() {
    if (audioCtx) return;
    try {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        masterGain = audioCtx.createGain();
        applyAudioSettings();
        masterGain.connect(audioCtx.destination);
    } catch (e) { audioCtx = null; }
}

function applyAudioSettings() {
    if (!masterGain) return;
    let volume = Number.isFinite(audioVolume) ? audioVolume : 1;
    volume = Math.max(0, Math.min(1, volume));
    let shapedVolume = Math.pow(volume, 0.8);
    masterGain.gain.value = AUDIO_MASTER_GAIN_MIN + (AUDIO_MASTER_GAIN_MAX - AUDIO_MASTER_GAIN_MIN) * shapedVolume;
    _applyBackgroundMusicVolume();
}

function _getBackgroundMusicTargetGain() {
    let volume = Number.isFinite(audioBackgroundVolume) ? audioBackgroundVolume : 1;
    volume = Math.max(0, Math.min(1, volume));
    return 0.24 * Math.pow(volume, 0.8);
}

function _applyBackgroundMusicVolume() {
    if (!audioCtx || !_bgMusicNodes || !_bgMusicNodes.gain) return;
    let targetGain = _getBackgroundMusicTargetGain();
    let t = audioCtx.currentTime;
    let param = _bgMusicNodes.gain.gain;
    let currentValue = Math.max(0.0001, Number(param.value) || 0.0001);
    param.cancelScheduledValues(t);
    param.setValueAtTime(currentValue, t);
    if (targetGain <= 0.0001) param.linearRampToValueAtTime(0.0001, t + 0.08);
    else param.exponentialRampToValueAtTime(targetGain, t + 0.12);
}

function _attachBackgroundMusicAnalyser(loopNode) {
    if (!audioCtx || !loopNode || !loopNode.gain) return;
    try {
        let analyser = audioCtx.createAnalyser();
        analyser.fftSize = 512;
        analyser.smoothingTimeConstant = 0.82;
        let usesFloatData = typeof analyser.getFloatTimeDomainData === 'function';
        let data = usesFloatData ? new Float32Array(analyser.fftSize) : new Uint8Array(analyser.fftSize);
        loopNode.gain.connect(analyser);
        _bgMusicAnalyser = analyser;
        _bgMusicAnalyserData = data;
        _bgMusicReactiveSmoothedLevel = 0;
        _bgMusicReactiveLevelHistory.length = 0;
    } catch {
        _bgMusicAnalyser = null;
        _bgMusicAnalyserData = null;
        _bgMusicReactiveSmoothedLevel = 0;
        _bgMusicReactiveLevelHistory.length = 0;
    }
}

// Per-frame global audio source cap: reset each game tick
let _audioFrameSoundCount = 0;
let _audioFrameSoundTick = -1;
const AUDIO_MAX_SOUNDS_PER_FRAME = 6;

// Throttle rules: [maxPerWindow, windowTicks]
const _audioTypeThrottle = {
    builder_work:      [3, 6],
    heal_tick:         [3, 6],
    research_tick:     [3, 6],
    gold_collected:    [3, 6],
    astar_collected:   [2, 6],
    salvage_collected: [2, 6],
    melee_hit:         [4, 4],
};

function _canPlaySoundTypeNow(type) {
    let normalizedType = String(type || '').trim();
    if (!normalizedType) return false;

    // Global per-frame cap
    let tick = Number.isFinite(gameTime) ? gameTime : 0;
    if (tick !== _audioFrameSoundTick) {
        _audioFrameSoundCount = 0;
        _audioFrameSoundTick = tick;
    }
    if (_audioFrameSoundCount >= AUDIO_MAX_SOUNDS_PER_FRAME) return false;

    let throttle = _audioTypeThrottle[normalizedType];
    if (throttle) {
        let [maxCount, windowTicks] = throttle;
        let state = _audioTypeBurstState[normalizedType];
        if (!state || tick - state.windowStartTick >= windowTicks) {
            _audioTypeBurstState[normalizedType] = { windowStartTick: tick, count: 1 };
        } else if (state.count >= maxCount) {
            return false;
        } else {
            state.count++;
        }
    }

    _audioFrameSoundCount++;
    return true;
}

function _getAudioSpatialState(worldX, worldY) {
    if (!gameStarted || !Number.isFinite(worldX) || !Number.isFinite(worldY) || !camera || !Number.isFinite(camera.zoom) || camera.zoom <= 0) {
        return { gain: 1, pan: 0 };
    }
    let worldViewW = viewW / camera.zoom;
    let worldViewH = viewH / camera.zoom;
    let cx = camera.x + worldViewW * 0.5;
    let cy = camera.y + worldViewH * 0.5;
    let dx = worldX - cx;
    let dy = worldY - cy;
    let nx = dx / Math.max(1, worldViewW * 0.5);
    let sourceTileX = worldX / Math.max(1, TILE);
    let sourceTileY = worldY / Math.max(1, TILE);
    let cameraTileX = cx / Math.max(1, TILE);
    let cameraTileY = cy / Math.max(1, TILE);
    let cameraHeightTiles = Math.max(0, Math.max(worldViewW, worldViewH) / Math.max(1, TILE) * AUDIO_SPATIAL_2D_HEIGHT_VIEW_FACTOR);
    let nearDistanceTiles = AUDIO_SPATIAL_2D_NEAR_DISTANCE_TILES;
    let farDistanceTiles = AUDIO_SPATIAL_2D_FAR_DISTANCE_TILES;
    let falloffExponent = AUDIO_SPATIAL_2D_FALLOFF_EXPONENT;

    if (renderDimensionMode === '3d' && renderer3dInstance) {
        let visibleWidthTiles = Math.max(1.2, worldViewW / Math.max(1, TILE));
        let visibleHeightTiles = Math.max(1.2, worldViewH / Math.max(1, TILE));
        let orbitPitch = Number(renderer3dInstance.orbitPitch);
        let orbitYaw = Number(renderer3dInstance.orbitYaw);
        if (!Number.isFinite(orbitPitch)) orbitPitch = 0.92;
        if (!Number.isFinite(orbitYaw)) orbitYaw = 0;
        let orbitDistance = Math.max(1.8, Math.max(visibleWidthTiles, visibleHeightTiles) * AUDIO_SPATIAL_3D_DISTANCE_FACTOR);
        let horizontalDistance = Math.cos(orbitPitch) * orbitDistance;
        cameraTileX += Math.sin(orbitYaw) * horizontalDistance;
        cameraTileY += Math.cos(orbitYaw) * horizontalDistance;
        cameraHeightTiles = Math.max(0, Math.sin(orbitPitch) * orbitDistance);
        nearDistanceTiles = AUDIO_SPATIAL_3D_NEAR_DISTANCE_TILES;
        farDistanceTiles = AUDIO_SPATIAL_3D_FAR_DISTANCE_TILES;
        falloffExponent = AUDIO_SPATIAL_3D_FALLOFF_EXPONENT;
    }

    let distTiles = Math.hypot(sourceTileX - cameraTileX, sourceTileY - cameraTileY, cameraHeightTiles);
    let gain = 1;
    if (distTiles > nearDistanceTiles) {
        let t = Math.max(0, Math.min(1, (distTiles - nearDistanceTiles) / Math.max(0.001, farDistanceTiles - nearDistanceTiles)));
        gain = Math.pow(1 - t, falloffExponent);
    }
    gain = Math.max(AUDIO_SPATIAL_MIN_GAIN, Math.min(1, gain));
    let pan = Math.max(-1, Math.min(1, nx * 0.85));
    return { gain, pan };
}

function _createGainNode(vol, pan = 0) {
    let g = audioCtx.createGain();
    g.gain.value = vol;
    if (audioCtx.createStereoPanner) {
        let p = audioCtx.createStereoPanner();
        p.pan.value = Math.max(-1, Math.min(1, Number(pan) || 0));
        g.connect(p);
        p.connect(masterGain);
        g._stereoPanner = p;
    } else {
        g.connect(masterGain);
    }
    return g;
}

async function _loadAudioAsset(type) {
    let normalizedType = String(type || '').trim();
    if (!normalizedType || !audioCtx) return null;
    if (_audioAssetCache.has(normalizedType)) return _audioAssetCache.get(normalizedType);
    if (_audioAssetMissing.has(normalizedType)) return null;
    if (_audioAssetPending.has(normalizedType)) return _audioAssetPending.get(normalizedType);

    let promise = (async () => {
        try {
            for (let ext of AUDIO_ASSET_EXTENSIONS) {
                let response = await fetch(`${AUDIO_ASSET_BASE_PATH}/${encodeURIComponent(normalizedType)}.${ext}`);
                if (!response.ok) continue;
                let arrayBuffer = await response.arrayBuffer();
                let decoded = await audioCtx.decodeAudioData(arrayBuffer.slice(0));
                _audioAssetCache.set(normalizedType, decoded);
                return decoded;
            }
            _audioAssetMissing.add(normalizedType);
            return null;
        } catch {
            _audioAssetMissing.add(normalizedType);
            return null;
        } finally {
            _audioAssetPending.delete(normalizedType);
        }
    })();

    _audioAssetPending.set(normalizedType, promise);
    return promise;
}

function _playLoadedAudioBuffer(buffer, vol, pan = 0, loop = false) {
    if (!audioCtx || !buffer || !(vol > 0)) return null;
    let source = audioCtx.createBufferSource();
    source.buffer = buffer;
    source.loop = !!loop;
    let gainNode = _createGainNode(vol, pan);
    source.connect(gainNode);
    source.start();
    return { source, gain: gainNode, panner: gainNode._stereoPanner || null };
}

function _playAudioAsset(type, vol, pan = 0, loop = false) {
    if (!audioCtx || !audioEnabled || !(vol > 0)) return null;
    let normalizedType = String(type || '').trim();
    if (!normalizedType) return null;

    let cached = _audioAssetCache.get(normalizedType);
    if (cached) return _playLoadedAudioBuffer(cached, vol, pan, loop);

    if (!_audioAssetMissing.has(normalizedType)) {
        _loadAudioAsset(normalizedType);
    }
    return null;
}

async function _startLoopedAudioAsset(type, vol, pan = 0) {
    if (!audioCtx || !audioEnabled || !(vol > 0)) return null;
    let buffer = _audioAssetCache.get(type);
    if (!buffer) buffer = await _loadAudioAsset(type);
    if (!audioEnabled || !buffer) return null;
    return _playLoadedAudioBuffer(buffer, vol, pan, true);
}

async function _startFirstLoopedAudioAsset(types, vol, pan = 0) {
    let keys = Array.isArray(types) ? types : [types];
    for (let i = 0; i < keys.length; i++) {
        let loopNode = await _startLoopedAudioAsset(keys[i], vol, pan);
        if (loopNode) return loopNode;
    }
    return null;
}

function _noteAmbientSoundTick(target, key, cooldownTicks = AUDIO_AMBIENT_WORK_MIN_TICKS) {
    if (!target || !key) return true;
    if (!Number.isFinite(target._ambientSoundTicks)) target._ambientSoundTicks = Object.create(null);
    let nextTick = Number(target._ambientSoundTicks[key]) || 0;
    if (gameTime < nextTick) return false;
    target._ambientSoundTicks[key] = gameTime + Math.max(1, Math.floor(cooldownTicks));
    return true;
}

// Play a simple tone: type=waveform, freq (hz or array for sequence), dur (s), vol
function _playTone(freq, dur, vol, wave, detune, pan = 0) {
    if (!audioCtx) return;
    if (typeof wave !== 'string') {
        pan = Number.isFinite(detune) ? detune : pan;
        detune = Number.isFinite(wave) ? wave : 0;
        wave = 'triangle';
    }
    freq = _scaleFreqInput(freq);
    let g = _createGainNode(vol, pan);
    let o = audioCtx.createOscillator();
    o.type = wave || 'triangle';
    let t = audioCtx.currentTime;
    if (detune) o.detune.value = detune;
    if (Array.isArray(freq)) {
        let step = dur / freq.length;
        o.frequency.setValueAtTime(freq[0], t);
        for (let i = 1; i < freq.length; i++) {
            let nextTime = t + i * step;
            o.frequency.linearRampToValueAtTime(freq[i], nextTime);
        }
    } else {
        o.frequency.value = freq;
    }
    o.connect(g);
    let attack = Math.min(0.055, Math.max(0.01, dur * 0.28));
    let decayTime = Math.max(attack + 0.018, dur * 0.72);
    let sustainLevel = Math.max(0.001, vol * 0.5);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(vol, t + attack);
    g.gain.exponentialRampToValueAtTime(sustainLevel, t + decayTime);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.start(t);
    o.stop(t + dur + 0.05);
}

// Play a noise burst (white noise filtered)
function _playNoise(dur, vol, energyFreq, lpFreq, pan = 0) {
    if (!audioCtx) return;
    let bufLen = Math.ceil(audioCtx.sampleRate * dur);
    let buf = audioCtx.createBuffer(1, bufLen, audioCtx.sampleRate);
    let data = buf.getChannelData(0);
    for (let i = 0; i < bufLen; i++) data[i] = Math.random() * 2 - 1;
    let src = audioCtx.createBufferSource();
    src.buffer = buf;
    let g = _createGainNode(vol, pan);
    let t = audioCtx.currentTime;
    let attack = Math.min(0.025, Math.max(0.003, dur * 0.12));
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(vol, t + attack);
    g.gain.exponentialRampToValueAtTime(Math.max(0.001, vol * 0.42), t + Math.max(attack + 0.01, dur * 0.5));
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    if (lpFreq) {
        let lp = audioCtx.createBiquadFilter();
        lp.type = 'lowpass'; lp.frequency.value = lpFreq;
        src.connect(lp); lp.connect(g);
    } else {
        src.connect(g);
    }
    src.start(t); src.stop(t + dur);
}

function playSound(type, worldX, worldY) {
    if (!audioCtx || !audioEnabled) return;
    if (audioCtx.state === 'suspended') audioCtx.resume();
    if (!_canPlaySoundTypeNow(type)) return;
    let spatial = (worldX !== undefined) ? _getAudioSpatialState(worldX, worldY) : { gain: 1, pan: 0 };
    let vol = spatial.gain;
    let pan = spatial.pan;
    if (vol < AUDIO_SPATIAL_MIN_GAIN) return;
    _recordAudioReactiveEmitter(type, worldX, worldY, 0.75);
    _playAudioAsset(type, vol, pan, false);
}

// Laser: start/stop sustained buzz
function startLaserSound(worldX, worldY) {
    if (!audioCtx || !audioEnabled) return;
    if (audioCtx.state === 'suspended') audioCtx.resume();
    let spatial = (worldX !== undefined) ? _getAudioSpatialState(worldX, worldY) : { gain: 1, pan: 0 };
    let targetGain = 0.22 * spatial.gain;
    if (_laserAudioActive && _laserAudioNodes) {
        let t = audioCtx.currentTime;
        _laserAudioNodes.gain.gain.cancelScheduledValues(t);
        _laserAudioNodes.gain.gain.setValueAtTime(_laserAudioNodes.gain.gain.value, t);
        _laserAudioNodes.gain.gain.linearRampToValueAtTime(targetGain, t + 0.08);
        if (_laserAudioNodes.panner) {
            _laserAudioNodes.panner.pan.cancelScheduledValues(t);
            _laserAudioNodes.panner.pan.linearRampToValueAtTime(spatial.pan, t + 0.08);
        }
        return;
    }
    _laserAudioActive = true;
    if (_laserAudioNodes) {
        try { _laserAudioNodes.source.stop(); } catch (e) { }
        _laserAudioNodes = null;
    }
    let loopNode = _playAudioAsset('laser_tick', targetGain, spatial.pan, true);
    if (loopNode) {
        let t = audioCtx.currentTime;
        loopNode.gain.gain.setValueAtTime(0, t);
        loopNode.gain.gain.linearRampToValueAtTime(targetGain, t + 0.05);
        _laserAudioNodes = loopNode;
    }
}
function stopLaserSound() {
    if (!_laserAudioActive || !_laserAudioNodes) return;
    _laserAudioActive = false;
    let { gain, source } = _laserAudioNodes;
    let t = audioCtx.currentTime;
    gain.gain.setValueAtTime(gain.gain.value, t);
    gain.gain.linearRampToValueAtTime(0, t + 0.15);
    setTimeout(() => { try { source.stop(); } catch (e) { } }, 200);
    _laserAudioNodes = null;
}

function startBackgroundMusic() {
    if (!audioCtx || !audioEnabled || _bgMusicNodes) return;
    if (audioCtx.state === 'suspended') audioCtx.resume();
    _bgMusicAnalyser = null;
    _bgMusicAnalyserData = null;
    _bgMusicReactiveSmoothedLevel = 0;
    _bgMusicReactiveLevelHistory.length = 0;
    _bgMusicNodes = { pending: true, cancelled: false, source: null, gain: null };

    _startFirstLoopedAudioAsset(AUDIO_BACKGROUND_TRACKS, 0.24, 0).then(loopNode => {
        if (!_bgMusicNodes || _bgMusicNodes.cancelled || !audioEnabled) {
            if (loopNode && loopNode.source) {
                try { loopNode.source.stop(); } catch (e) { }
            }
            return;
        }
        if (!loopNode) {
            _bgMusicNodes = null;
            return;
        }

        let t = audioCtx.currentTime;
        let targetGain = Math.max(0.0001, _getBackgroundMusicTargetGain());
        loopNode.gain.gain.setValueAtTime(0.0001, t);
        loopNode.gain.gain.exponentialRampToValueAtTime(targetGain, t + 1.2);
        _attachBackgroundMusicAnalyser(loopNode);
        _bgMusicNodes = {
            pending: false,
            cancelled: false,
            source: loopNode.source,
            gain: loopNode.gain,
            panner: loopNode.panner || null
        };
    });
}

function stopBackgroundMusic() {
    if (!_bgMusicNodes) return;
    let nodes = _bgMusicNodes;
    _bgMusicNodes = null;
    _bgMusicAnalyser = null;
    _bgMusicAnalyserData = null;
    _bgMusicReactiveSmoothedLevel = 0;
    _bgMusicReactiveLevelHistory.length = 0;
    nodes.cancelled = true;
    let t = audioCtx ? audioCtx.currentTime : 0;
    if (!nodes.gain || !nodes.source) return;
    try {
        nodes.gain.gain.cancelScheduledValues(t);
        nodes.gain.gain.setValueAtTime(Math.max(0.0001, nodes.gain.gain.value), t);
        nodes.gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.5);
    } catch (e) { }
    setTimeout(() => {
        try { nodes.source.stop(); } catch (e) { }
    }, 600);
}

