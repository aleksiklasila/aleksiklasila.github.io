
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
let _audioSpatialGridBackgroundVelocity = [];
// Static per-tile geometry of the radial background wave.
let _audioBgTileDist = null, _audioBgTileWaveAmount = null, _audioBgTileSwell = null;
// Whether the background spring still has nonzero tiles, and the tile rects
// the effect emitters stamped last update (only those need clearing).
let _audioBgSpringActive = false;
let _audioFxStampedRects = [];
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
    _audioSpatialGridBackgroundVelocity = _makeAudioReactiveGridRows();
    let n = GRID_W * GRID_H;
    _audioBgTileDist = new Float32Array(n);
    _audioBgTileWaveAmount = new Float32Array(n);
    _audioBgTileSwell = new Float32Array(n);
    let centerX = GRID_W * 0.5, centerY = GRID_H * 0.5;
    let maxDist = Math.max(1, Math.hypot(Math.max(centerX, GRID_W - centerX), Math.max(centerY, GRID_H - centerY)));
    for (let y = 0, i = 0; y < GRID_H; y++) for (let x = 0; x < GRID_W; x++, i++) {
        let dist = Math.hypot(x + 0.5 - centerX, y + 0.5 - centerY);
        let centerWeight = Math.max(0, 1 - Math.max(0, Math.min(1, dist / maxDist)));
        _audioBgTileDist[i] = dist;
        _audioBgTileWaveAmount[i] = AUDIO_REACTIVE_BG_PULSE_SCALE * (AUDIO_REACTIVE_BG_EDGE_BLEND + centerWeight * (1 - AUDIO_REACTIVE_BG_EDGE_BLEND));
        _audioBgTileSwell[i] = 1 + centerWeight * centerWeight * AUDIO_REACTIVE_BG_SWELL_SCALE;
    }
    _audioBgSpringActive = false;
    _audioFxStampedRects = [];
    _audioReactiveLastGridTick = -1;
    audioReactiveTextureVersion = 0;
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
    } else if (normalizedType === 'melee_hit' || normalizedType === 'attack_swing' || normalizedType === 'attack_cast' ||
        normalizedType === 'heal_tick' || normalizedType === 'builder_work' || normalizedType === 'collector_work' ||
        normalizedType === 'astar_work' || normalizedType === 'salvager_work' || normalizedType === 'research_tick') {
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
    _updateGeneratedAudioVoices();
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

    // The grids change only every few ticks. Rendering reads them directly
    // (the old per-tick interpolation always resolved to the latest target).
    if (_audioReactiveLastGridTick >= 0 && nowTick >= _audioReactiveLastGridTick &&
        nowTick - _audioReactiveLastGridTick < AUDIO_REACTIVE_GRID_UPDATE_INTERVAL) return;

    let level = audioReactiveBackgroundLevel;
    // Silent music with a settled spring leaves every background tile at 0:
    // only the tiles last stamped by effect emitters need clearing.
    let fullPass = level > 0 || _audioBgSpringActive;
    if (fullPass) {
        let active = false;
        let phaseScale = 1 / Math.max(0.001, AUDIO_REACTIVE_BG_RADIAL_WAVELENGTH_TILES);
        let phaseOffset = nowSeconds * AUDIO_REACTIVE_BG_RADIAL_SCROLL_SPEED;
        for (let y = 0, i = 0; y < GRID_H; y++) {
            let bgRow = audioSpatialGridBackground[y];
            let bgVelocityRow = _audioSpatialGridBackgroundVelocity[y];
            let fxRow = audioSpatialGridEffects[y];
            let totalRow = audioSpatialGrid[y];
            for (let x = 0; x < GRID_W; x++, i++) {
                let rawBgValue = 0;
                if (level > 0) {
                    let wave = Math.sin((_audioBgTileDist[i] * phaseScale - phaseOffset) * Math.PI * 2);
                    rawBgValue = Math.max(0, Math.min(1.5, level * (1 + wave * _audioBgTileWaveAmount[i]) * _audioBgTileSwell[i]));
                }
                let bgDelta = rawBgValue - bgRow[x];
                let nextVelocity = (bgVelocityRow[x] + bgDelta * AUDIO_REACTIVE_BG_TILE_SMOOTH_ACCEL) * AUDIO_REACTIVE_BG_TILE_SMOOTH_DAMPING;
                let nextValue = bgRow[x] + nextVelocity;
                if (Math.abs(rawBgValue - nextValue) < 0.001 && Math.abs(nextVelocity) < 0.001) {
                    nextValue = rawBgValue;
                    nextVelocity = 0;
                }
                bgVelocityRow[x] = nextVelocity;
                let bg = bgRow[x] = Math.max(0, Math.min(1.5, nextValue));
                if (bg !== 0 || nextVelocity !== 0) active = true;
                fxRow[x] = 0;
                totalRow[x] = bg;
            }
        }
        _audioBgSpringActive = active;
    } else {
        for (let r of _audioFxStampedRects) for (let y = r[1]; y <= r[3]; y++) {
            audioSpatialGridEffects[y].fill(0, r[0], r[2] + 1);
            audioSpatialGrid[y].fill(0, r[0], r[2] + 1);
        }
    }
    _audioFxStampedRects.length = 0;

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
        if (minX > maxX || minY > maxY) continue;
        _audioFxStampedRects.push([minX, minY, maxX, maxY]);
        let age = Math.max(0, Math.min(1, emitter.life / Math.max(1, emitter.maxLife)));
        let amplitude = emitter.strength * age;

        for (let gy = minY; gy <= maxY; gy++) {
            let fy = gy + 0.5 - centerY;
            let fxRow = audioSpatialGridEffects[gy];
            let totalRow = audioSpatialGrid[gy];
            for (let gx = minX; gx <= maxX; gx++) {
                let fx = gx + 0.5 - centerX;
                let distSq = fx * fx + fy * fy;
                if (distSq > radiusSq) continue;
                let dist = Math.sqrt(distSq);
                let falloff = 1 - dist / radiusTiles;
                let value = amplitude * falloff * falloff;
                fxRow[gx] = Math.min(1.5, fxRow[gx] + value);
                totalRow[gx] = Math.min(1.75, totalRow[gx] + value);
            }
        }
    }

    _audioReactiveLastGridTick = nowTick;
    audioReactiveTextureVersion++;
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

function doesCurrentSelectionMatchSnapshot(grp, membership = null) {
    if (!grp) return false;
    let aliveUnits = (grp.units || []).filter(u => u && !u.dead);
    let aliveEntities = (grp.entities || []).filter(e => e && !(e.energy !== undefined && e.energy <= 0));
    if (aliveUnits.length === 0 && aliveEntities.length === 0) return false;
    if (selectedUnits.length !== aliveUnits.length || selectedEntities.length !== aliveEntities.length) return false;
    let unitSet = membership ? membership.units : new Set(selectedUnits);
    let entitySet = membership ? membership.entities : new Set(selectedEntities);
    if (!aliveUnits.every(u => unitSet.has(u))) return false;
    if (!aliveEntities.every(e => entitySet.has(e))) return false;

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

    let membership = { units: new Set(selectedUnits), entities: new Set(selectedEntities) };
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
        btn.classList.toggle('active', doesCurrentSelectionMatchSnapshot(grp, membership));
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
        btn.classList.toggle('active', doesCurrentSelectionMatchSnapshot(grp, membership));
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

function initAudio() {
    if (audioCtx) return;
    try {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        masterGain = audioCtx.createGain();
        applyAudioSettings();
        // A gentle bus compressor keeps overlapping battles from becoming harsh.
        let compressor = audioCtx.createDynamicsCompressor();
        compressor.threshold.value = -20;
        compressor.knee.value = 18;
        compressor.ratio.value = 3;
        compressor.attack.value = .012;
        compressor.release.value = .22;
        masterGain.connect(compressor);
        compressor.connect(audioCtx.destination);
    } catch (e) { audioCtx = null; }
}

function applyAudioSettings() {
    if (typeof Jukebox !== 'undefined') Jukebox.applyVolume();
    if (!masterGain) return;
    let volume = Number.isFinite(audioVolume) ? audioVolume : 1;
    volume = Math.max(0, Math.min(1, volume));
    let shapedVolume = Math.pow(volume, 0.8);
    masterGain.gain.setTargetAtTime(audioEnabled ? AUDIO_MASTER_GAIN_MIN + (AUDIO_MASTER_GAIN_MAX - AUDIO_MASTER_GAIN_MIN) * shapedVolume : 0, audioCtx.currentTime, .04);
    _applyBackgroundMusicVolume();
}

function _getBackgroundMusicTargetGain() {
    let volume = Number.isFinite(audioBackgroundVolume) ? audioBackgroundVolume : 1;
    volume = Math.max(0, Math.min(1, volume));
    return 0.24 * Math.pow(volume, 0.8);
}

function _applyBackgroundMusicVolume() {
    if (typeof Jukebox !== 'undefined') Jukebox.applyVolume();
    if (!audioCtx || !_bgMusicNodes || !_bgMusicNodes.gain) return;
    _bgMusicNodes.volume = _getBackgroundMusicTargetGain();
    _bgMusicNodes.gain.gain.setTargetAtTime(_bgMusicNodes.volume, audioCtx.currentTime, .12);
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
    collector_work:    [3, 8],
    astar_work:        [2, 8],
    salvager_work:     [3, 8],
    heal_tick:         [3, 6],
    research_tick:     [3, 6],
    gold_collected:    [3, 6],
    astar_collected:   [2, 6],
    salvage_collected: [2, 6],
    melee_hit:         [4, 4],
    attack_swing:      [4, 4],
    attack_cast:       [4, 4],
    impact:            [4, 4],
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

// Procedural sound recipes: [frequency, ending frequency, seconds, noise mix,
// brightness Hz, volume, reach in tiles, pulse count]. No downloaded samples.
const AUDIO_RECIPES = {
    shoot_generic: [150,65,.23,.55,1100,.19,12,1],
    shoot_pistol: [180,70,.20,.50,1250,.18,12,1],
    shoot_smg: [145,80,.26,.58,1400,.15,11,3],
    shoot_sniper: [100,38,.52,.65,1050,.27,23,1],
    shoot_fire: [95,42,.58,.82,850,.22,18,1],
    shoot_water: [245,100,.32,.56,1050,.15,10,2],
    shoot_poison: [155,95,.40,.33,650,.14,9,3],
    shoot_ice: [340,210,.34,.24,1500,.14,11,2],
    shoot_sand_gun: [125,65,.38,.87,700,.17,12,2],
    shoot_elements: [220,140,.48,.28,1250,.18,15,3],
    shoot_watch_tower: [280,190,.22,.08,1000,.11,8,2],
    shoot_laser: [190,110,.38,.10,900,.14,14,1],
    laser_tick: [140,105,.28,.10,700,.10,13,1],
    melee_hit: [135,55,.19,.52,850,.12,7,1],
    attack_swing: [105,48,.16,.72,950,.075,7,1],
    attack_cast: [260,125,.24,.18,1450,.075,9,2],
    weapon_sword: [145,62,.18,.48,1350,.08,7,1],
    weapon_axe: [92,38,.28,.70,820,.10,8,1],
    weapon_hammer: [74,34,.31,.80,680,.11,8,1],
    weapon_daggers: [210,105,.13,.38,1650,.065,6,2],
    impact: [115,45,.22,.65,750,.12,8,1],
    mine_explode: [75,30,.85,.88,700,.27,24,1],
    unit_death: [160,48,.45,.32,700,.13,9,1],
    building_destroyed: [85,28,.95,.85,600,.25,22,3],
    place: [190,115,.22,.28,950,.12,7,1],
    cant_place: [180,130,.30,.02,600,.12,6,2],
    builder_work: [160,85,.20,.60,650,.075,4.5,2],
    collector_work: [215,145,.24,.22,1050,.07,4.5,2],
    astar_work: [330,210,.34,.08,1650,.07,5,3],
    salvager_work: [120,72,.26,.78,1150,.075,4.5,4],
    heal_tick: [240,300,.48,.02,1000,.075,5,2],
    research_tick: [190,285,.42,.05,1100,.075,5,3],
    gold_collected: [260,330,.34,.06,1300,.10,6,2],
    astar_collected: [220,350,.46,.02,1200,.10,6,3],
    salvage_collected: [180,240,.28,.35,850,.09,5,2],
    build_complete: [196,294,.65,.04,1300,.13,10,3],
    upgrade_complete: [220,330,.78,.02,1400,.14,11,4],
    alert_damage: [196,165,.45,.04,850,.12,15,2],
    alert_king_damage: [220,147,.68,.04,850,.17,20,3],
    victory: [196,392,1.8,.01,1400,.17,16,5],
    defeat: [220,98,1.7,.03,850,.14,16,4]
};
const _generatedAudioBuffers = new Map();
const _activeAudioVoices = new Set();
const AUDIO_MAX_ACTIVE_VOICES = 32;
let _audioVariation = 0;

function _audioHash(text) {
    let h = 2166136261;
    for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
    return h >>> 0;
}

function _getSoundRecipe(type, subtype = '') {
    let recipe = AUDIO_RECIPES[type] || AUDIO_RECIPES.shoot_generic;
    if (type === 'attack_swing') {
        recipe = /boss/.test(subtype) ? AUDIO_RECIPES.weapon_axe
            : /tank/.test(subtype) ? AUDIO_RECIPES.weapon_hammer
                : /fast/.test(subtype) ? AUDIO_RECIPES.weapon_daggers
                    : AUDIO_RECIPES.weapon_sword;
    } else if (type === 'attack_cast') {
        let element = String(subtype).replace('_resistant', '');
        let elementalWeapon = AUDIO_RECIPES['shoot_' + element];
        if (elementalWeapon) {
            recipe = elementalWeapon.slice();
            recipe[2] *= .72; recipe[5] *= .55; recipe[6] *= .7;
        }
    }
    let profile = recipe.slice();
    if (subtype) {
        // Use the same elemental palette for impacts, with a shorter, duller tail.
        let element = String(subtype).replace('_resistant', '');
        let elemental = AUDIO_RECIPES['shoot_' + element];
        if ((type === 'melee_hit' || type === 'impact') && elemental) {
            profile = elemental.slice();
            profile[2] *= .65; profile[4] *= .72; profile[5] *= .65; profile[6] *= .65;
        }
        let weight = /tank|boss|king|snake/.test(subtype) ? .70 : /fast|scout|flying/.test(subtype) ? 1.15 : 1;
        let variation = .94 + (_audioHash(subtype) % 13) / 100;
        profile[0] *= weight * variation; profile[1] *= weight * variation;
        if (weight < 1) { profile[2] *= 1.2; profile[5] *= 1.15; profile[6] *= 1.3; }
    }
    return profile;
}

function _generateEffectBuffer(type, subtype, variant, recipe) {
    let key = type + ':' + subtype + ':' + variant;
    if (_generatedAudioBuffers.has(key)) return _generatedAudioBuffers.get(key);
    let [frequency, endFrequency, duration, noiseMix, cutoff, , , pulses] = recipe;
    let rate = audioCtx.sampleRate;
    let buffer = audioCtx.createBuffer(1, Math.ceil(duration * rate), rate);
    let data = buffer.getChannelData(0), seed = _audioHash(key) || 1;
    let phase = 0, filteredNoise = 0, filtered = 0;
    let toneOffset = 1 + (variant - 1) * .025;
    let filterAmount = 1 - Math.exp(-2 * Math.PI * cutoff / rate);
    for (let i = 0; i < data.length; i++) {
        let time = i / rate, progress = time / duration;
        let pulse = (time * pulses / duration) % 1;
        let envelope = Math.min(1, time / .012) * Math.pow(1 - progress, 1.7);
        envelope *= pulses > 1 ? Math.pow(Math.sin(Math.PI * pulse), 2) : 1;
        let pitch = frequency * Math.pow(endFrequency / frequency, progress) * toneOffset;
        phase += 2 * Math.PI * pitch / rate;
        // Local PRNG never consumes the game's random stream.
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        filteredNoise += filterAmount * ((seed / 2147483648 - 1) - filteredNoise);
        let tone = Math.sin(phase) * .82 + Math.sin(phase * 2) * .12;
        let sample = tone * (1 - noiseMix) + filteredNoise * noiseMix * 1.8;
        filtered += filterAmount * (sample - filtered);
        data[i] = filtered * envelope * .8;
    }
    // Bounded even for custom/modded unit names; active sources retain their buffer.
    if (_generatedAudioBuffers.size >= 192) _generatedAudioBuffers.delete(_generatedAudioBuffers.keys().next().value);
    _generatedAudioBuffers.set(key, buffer);
    return buffer;
}

function _getAudioSpatialState(worldX, worldY, reach = 12) {
    if (!gameStarted || !Number.isFinite(worldX) || !Number.isFinite(worldY) || !camera || !(camera.zoom > 0)) {
        return { gain: 1, pan: 0, cutoff: 2800 };
    }
    let width = viewW / camera.zoom, height = viewH / camera.zoom;
    let dx = (worldX - camera.x - width * .5) / TILE;
    let dy = (worldY - camera.y - height * .5) / TILE;
    // Listen at the point the player is looking at, not the elevated 3D eye.
    // Zoom still gently changes level, but cannot push every source past a cutoff.
    let zoomDistance = Math.max(0, Math.max(width, height) / TILE - 12) * .06;
    let distance = Math.hypot(dx, dy, zoomDistance);
    let normalized = distance / Math.max(1, reach);
    let edge = Math.max(0, 1 - normalized * normalized);
    let gain = edge * edge / (1 + 3 * normalized * normalized);
    let yaw = renderDimensionMode === '3d' && renderer3dInstance ? Number(renderer3dInstance.orbitYaw) || 0 : 0;
    let right = dx * Math.cos(yaw) - dy * Math.sin(yaw);
    let pan = Math.tanh(right / Math.max(3, width / TILE * .35)) * .8;
    return { gain, pan, cutoff: 700 + 2100 / (1 + normalized * normalized * 4) };
}

function _createGeneratedVoice(buffer, volume, worldX, worldY, reach, loop = false) {
    let spatial = _getAudioSpatialState(worldX, worldY, reach);
    let source = audioCtx.createBufferSource(); source.buffer = buffer; source.loop = loop;
    let gain = audioCtx.createGain(); gain.gain.value = 0;
    let filter = audioCtx.createBiquadFilter(); filter.type = 'lowpass'; filter.Q.value = .5;
    filter.frequency.value = spatial.cutoff;
    let panner = audioCtx.createStereoPanner ? audioCtx.createStereoPanner() : null;
    source.connect(filter); filter.connect(gain);
    if (panner) { panner.pan.value = spatial.pan; gain.connect(panner); panner.connect(masterGain); }
    else gain.connect(masterGain);
    let voice = { source, gain, filter, panner, volume, worldX, worldY, reach, loop, stopping: false };
    gain.gain.setTargetAtTime(volume * spatial.gain, audioCtx.currentTime, loop ? .15 : .008);
    _activeAudioVoices.add(voice);
    source.onended = () => {
        _activeAudioVoices.delete(voice);
        source.disconnect(); filter.disconnect(); gain.disconnect();
        if (panner) panner.disconnect();
    };
    source.start();
    return voice;
}

function _updateGeneratedAudioVoices() {
    if (!audioCtx) return;
    for (let voice of _activeAudioVoices) {
        if (voice.stopping || voice === _bgMusicNodes) continue;
        let spatial = _getAudioSpatialState(voice.worldX, voice.worldY, voice.reach);
        let time = audioCtx.currentTime;
        voice.gain.gain.setTargetAtTime(audioEnabled ? voice.volume * spatial.gain : 0, time, .075);
        voice.filter.frequency.setTargetAtTime(spatial.cutoff, time, .10);
        if (voice.panner) voice.panner.pan.setTargetAtTime(spatial.pan, time, .08);
    }
}

function _stopGeneratedVoice(voice, fade = .15) {
    if (!voice || voice.stopping) return;
    voice.stopping = true;
    let time = audioCtx.currentTime;
    voice.gain.gain.cancelScheduledValues(time);
    voice.gain.gain.setTargetAtTime(0, time, fade / 4);
    voice.source.stop(time + fade);
}

function _noteAmbientSoundTick(target, key, cooldownTicks = AUDIO_AMBIENT_WORK_MIN_TICKS) {
    if (!target || !key) return true;
    if (!target._ambientSoundTicks || typeof target._ambientSoundTicks !== 'object') target._ambientSoundTicks = Object.create(null);
    let nextTick = Number(target._ambientSoundTicks[key]) || 0;
    if (gameTime < nextTick) return false;
    target._ambientSoundTicks[key] = gameTime + Math.max(1, Math.floor(cooldownTicks));
    return true;
}

function playSound(type, worldX, worldY, subtype = '') {
    if (!audioCtx || !audioEnabled) return;
    if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
    let recipe = _getSoundRecipe(type, subtype);
    let spatial = _getAudioSpatialState(worldX, worldY, recipe[6]);
    // Cull only below -80 dB of full-scale output, after a smooth zero-slope fade.
    // Inaudible/offscreen events do not consume the audible event budget.
    if (spatial.gain * recipe[5] < .0001) return;
    if (_activeAudioVoices.size >= AUDIO_MAX_ACTIVE_VOICES || !_canPlaySoundTypeNow(type)) return;
    _recordAudioReactiveEmitter(type, worldX, worldY, recipe[5] * 3);
    let buffer = _generateEffectBuffer(type, subtype, (_audioVariation++) % 3, recipe);
    _createGeneratedVoice(buffer, recipe[5], worldX, worldY, recipe[6]);
}

function _generateLaserLoopBuffer() {
    let key = 'generated_laser';
    if (_generatedAudioBuffers.has(key)) return _generatedAudioBuffers.get(key);
    // Integer cycles make a seamless, timer-free laser loop.
    let duration = 2, rate = audioCtx.sampleRate;
    let buffer = audioCtx.createBuffer(1, duration * rate, rate), data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) {
        let t = i / rate, tau = 2 * Math.PI;
        data[i] = (.23 * Math.sin(tau * 110 * t) + .07 * Math.sin(tau * 165 * t)) * (.8 + .2 * Math.cos(tau * 3 * t));
    }
    _generatedAudioBuffers.set(key, buffer);
    return buffer;
}

function startLaserSound(worldX, worldY) {
    if (!audioCtx || !audioEnabled) return;
    if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
    if (!_laserAudioNodes) _laserAudioNodes = _createGeneratedVoice(_generateLaserLoopBuffer(), .13, worldX, worldY, 15, true);
    _laserAudioNodes.worldX = worldX; _laserAudioNodes.worldY = worldY;
    _laserAudioActive = true;
}

function stopLaserSound() {
    _stopGeneratedVoice(_laserAudioNodes);
    _laserAudioNodes = null; _laserAudioActive = false;
}

function startBackgroundMusic() {
    if (typeof Jukebox !== 'undefined') Jukebox.start();
}

function stopBackgroundMusic() {
    if (typeof Jukebox !== 'undefined') Jukebox.stopLocal();
    _stopGeneratedVoice(_bgMusicNodes, .6);
    _bgMusicNodes = null;
    if (_bgMusicAnalyser) _bgMusicAnalyser.disconnect();
    _bgMusicAnalyser = null; _bgMusicAnalyserData = null;
    _bgMusicReactiveSmoothedLevel = 0; _bgMusicReactiveLevelHistory.length = 0;
}
