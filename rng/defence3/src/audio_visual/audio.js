
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

const AUDIO_PITCH_SCALE = 0.78;
let CONTROL_GROUP_ALERT_TICKS = Math.floor(TICK_RATE * 2.2);
let MAP_ALERT_DURATION = Math.floor(TICK_RATE * 1.8);
let MAP_KING_ALERT_DURATION = Math.floor(TICK_RATE * 2.6);

function applyTimingConfig(nextTickRate, nextPipelineMin) {
    let tps = Number.isFinite(nextTickRate) ? Math.floor(nextTickRate) : TICK_RATE;
    let pipelineMin = Number.isFinite(nextPipelineMin) ? Math.floor(nextPipelineMin) : LOCKSTEP_PIPELINE_MIN;

    TICK_RATE = Math.max(5, Math.min(120, tps));
    LOCKSTEP_PIPELINE_MIN = Math.max(0, Math.min(12, pipelineMin));

    TICK_MS = 1000 / TICK_RATE;
    LOCKSTEP_PIPELINE_TICKS = Math.max(INPUT_DELAY, LOCKSTEP_PIPELINE_MIN);
    LOCKSTEP_PACKET_RESEND_MS = Math.max(40, Math.floor(TICK_MS * 2));
    LOCKSTEP_BUNDLE_RESEND_MS = Math.max(40, Math.floor(TICK_MS * 2));
    LOCKSTEP_RESEND_REQUEST_MS = Math.max(200, Math.floor(TICK_MS * 4));
    LOCKSTEP_HARD_RESYNC_MS = Math.max(3000, Math.floor(TICK_MS * 60));
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
        masterGain.gain.value = 0.18;
        masterGain.connect(audioCtx.destination);
    } catch (e) { audioCtx = null; }
}

// Spatial attenuation: volume based on distance from camera viewport center
function _audioVol(worldX, worldY) {
    if (!gameStarted) return 1;
    let cx = camera.x + viewW / camera.zoom / 2;
    let cy = camera.y + viewH / camera.zoom / 2;
    let dist = Math.hypot(worldX - cx, worldY - cy);
    let maxDist = Math.max(viewW, viewH) / camera.zoom * 1.2;
    return Math.max(0.04, 1 - dist / maxDist);
}

function _createGainNode(vol) {
    let g = audioCtx.createGain();
    g.gain.value = vol;
    g.connect(masterGain);
    return g;
}

// Play a simple tone: type=waveform, freq (hz or array for sequence), dur (s), vol
function _playTone(freq, dur, vol, wave, detune) {
    if (!audioCtx) return;
    freq = _scaleFreqInput(freq);
    let g = _createGainNode(vol);
    let o = audioCtx.createOscillator();
    o.type = wave || 'triangle';
    let t = audioCtx.currentTime;
    if (detune) o.detune.value = detune;
    if (Array.isArray(freq)) {
        let step = dur / freq.length;
        freq.forEach((f, i) => o.frequency.setValueAtTime(f, t + i * step));
    } else {
        o.frequency.value = freq;
    }
    o.connect(g);
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.start(t);
    o.stop(t + dur + 0.05);
}

// Play a noise burst (white noise filtered)
function _playNoise(dur, vol, energyFreq, lpFreq) {
    if (!audioCtx) return;
    let bufLen = Math.ceil(audioCtx.sampleRate * dur);
    let buf = audioCtx.createBuffer(1, bufLen, audioCtx.sampleRate);
    let data = buf.getChannelData(0);
    for (let i = 0; i < bufLen; i++) data[i] = Math.random() * 2 - 1;
    let src = audioCtx.createBufferSource();
    src.buffer = buf;
    let g = _createGainNode(vol);
    let t = audioCtx.currentTime;
    g.gain.setValueAtTime(vol, t);
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
    console.log("Audio trigger:", type, worldX, worldY);
    if (audioCtx.state === 'suspended') audioCtx.resume();
    let vol = (worldX !== undefined) ? _audioVol(worldX, worldY) : 1;
    if (vol < 0.02) return;

    switch (type) {
        // --- Turret shoot sounds ---
        case 'shoot_pistol':
            _playTone(320, 0.07, vol * 0.7, 'square');
            _playNoise(0.06, vol * 0.3, 0, 3000);
            break;
        case 'shoot_smg':
            _playTone(380, 0.05, vol * 0.5, 'square', -200);
            _playNoise(0.04, vol * 0.25, 0, 4000);
            break;
        case 'shoot_fire':
            _playNoise(0.12, vol * 0.5, 0, 1200);
            _playTone(80, 0.1, vol * 0.4, 'sawtooth');
            break;
        case 'shoot_water':
            _playNoise(0.09, vol * 0.4, 0, 2500);
            _playTone(500, 0.08, vol * 0.3, 'sine');
            break;
        case 'shoot_poison':
            _playTone([180, 160, 140], 0.12, vol * 0.4, 'sawtooth');
            break;
        case 'shoot_ice':
            _playTone([800, 1200, 900], 0.1, vol * 0.45, 'sine');
            break;
        case 'shoot_sand_gun':
            _playNoise(0.1, vol * 0.45, 0, 1800);
            _playTone(120, 0.09, vol * 0.25, 'sawtooth');
            break;
        case 'shoot_elements':
            _playTone([400, 500, 600, 700], 0.12, vol * 0.35, 'triangle');
            break;
        case 'shoot_generic':
            _playTone(260, 0.07, vol * 0.5, 'triangle');
            _playNoise(0.06, vol * 0.2, 0, 3500);
            break;

        // --- Laser beam sounds (use sustained osc, started/stopped separately) ---
        case 'laser_tick':
            _playTone(55, 0.05, vol * 0.15, 'sawtooth', 0);
            break;

        // --- Building events ---
        case 'place':
            _playTone([300, 420], 0.12, vol * 0.55, 'triangle');
            break;
        case 'cant_place':
            _playTone([180, 140], 0.18, 0.45, 'square');
            break;
        case 'build_complete':
            _playTone([440, 550, 660], 0.22, vol * 0.6, 'triangle');
            break;
        case 'upgrade_complete':
            _playTone([440, 550, 660, 880], 0.28, vol * 0.65, 'triangle');
            break;
        case 'building_destroyed':
            _playNoise(0.3, vol * 0.6, 0, 800);
            _playTone([90, 70, 55], 0.3, vol * 0.5, 'sawtooth');
            break;

        // --- Worker events ---
        case 'gold_collected':
            _playTone([880, 1100], 0.07, vol * 0.5, 'sine');
            break;
        case 'salvage_collected':
            _playTone([440, 550], 0.08, vol * 0.4, 'sine');
            break;

        // --- Combat events ---
        case 'mine_explode':
            _playNoise(0.35, vol * 0.8, 0, 600);
            _playTone([55, 45, 35], 0.3, vol * 0.6, 'sawtooth');
            break;
        case 'unit_death':
            _playTone([160, 110], 0.1, vol * 0.4, 'triangle');
            _playNoise(0.07, vol * 0.2, 0, 1500);
            break;
        case 'king_hurt':
            _playTone([220, 180, 150], 0.25, 0.7, 'square');
            _playNoise(0.15, 0.4, 0, 500);
            break;
        case 'alert_king_damage':
            _playTone([180, 145, 120], 0.33, 0.8, 'square');
            _playNoise(0.08, 0.26, 0, 680);
            break;
        case 'alert_damage':
            _playTone([150, 120], 0.18, vol * 0.45, 'triangle');
            _playNoise(0.04, vol * 0.18, 0, 1100);
            break;

        // --- Game over ---
        case 'victory':
            setTimeout(() => _playTone([523, 659, 784, 1047], 0.8, 0.55, 'triangle'), 0);
            break;
        case 'defeat':
            setTimeout(() => _playTone([523, 440, 349, 262], 0.8, 0.5, 'sawtooth'), 0);
            break;
    }
}

// Laser: start/stop sustained buzz
function startLaserSound() {
    if (!audioCtx || !audioEnabled || _laserAudioActive) return;
    _laserAudioActive = true;
    if (_laserAudioNodes) { try { _laserAudioNodes.osc.stop(); } catch (e) { } }
    let osc = audioCtx.createOscillator();
    let g = audioCtx.createGain();
    osc.type = 'sawtooth'; osc.frequency.value = 60;
    osc.detune.value = 15;
    g.gain.value = 0;
    osc.connect(g); g.connect(masterGain);
    osc.start();
    g.gain.linearRampToValueAtTime(0.06, audioCtx.currentTime + 0.05);
    _laserAudioNodes = { osc, gain: g };
}
function stopLaserSound() {
    if (!_laserAudioActive || !_laserAudioNodes) return;
    _laserAudioActive = false;
    let { gain, osc } = _laserAudioNodes;
    let t = audioCtx.currentTime;
    gain.gain.setValueAtTime(gain.gain.value, t);
    gain.gain.linearRampToValueAtTime(0, t + 0.15);
    setTimeout(() => { try { osc.stop(); } catch (e) { } }, 200);
    _laserAudioNodes = null;
}

function startBackgroundMusic() {
    if (!audioCtx || !audioEnabled || _bgMusicNodes) return;
    if (audioCtx.state === 'suspended') audioCtx.resume();

    let chordProgression = [
        [73.42, 98.0, 123.47],
        [69.3, 92.5, 110.0],
        [65.41, 82.41, 110.0],
        [61.74, 82.41, 98.0]
    ];

    let mix = audioCtx.createGain();
    mix.gain.value = 0.0001;
    mix.connect(masterGain);

    let oscillators = [];
    let gains = [];
    let now = audioCtx.currentTime;
    let baseChord = chordProgression[0];
    for (let i = 0; i < 3; i++) {
        let o = audioCtx.createOscillator();
        let g = audioCtx.createGain();
        o.type = 'sine';
        o.frequency.value = _scaleFreqValue(baseChord[i] * 0.75);
        g.gain.value = i === 0 ? 0.022 : 0.014;
        o.connect(g);
        g.connect(mix);
        o.start(now);
        oscillators.push(o);
        gains.push(g);
    }

    mix.gain.exponentialRampToValueAtTime(0.06, now + 1.4);

    let chordIndex = 0;
    let timer = setInterval(() => {
        if (!audioCtx || !_bgMusicNodes || !audioEnabled) return;
        if (audioCtx.state === 'suspended') audioCtx.resume();
        chordIndex = (chordIndex + 1) % chordProgression.length;
        let chord = chordProgression[chordIndex];
        let t = audioCtx.currentTime;
        for (let i = 0; i < oscillators.length; i++) {
            let targetFreq = _scaleFreqValue(chord[i] * 0.75);
            oscillators[i].frequency.cancelScheduledValues(t);
            oscillators[i].frequency.linearRampToValueAtTime(targetFreq, t + 0.9);
        }
    }, 1800);

    _bgMusicNodes = { oscillators, gains, mix, timer };
}

function stopBackgroundMusic() {
    if (!_bgMusicNodes) return;
    let nodes = _bgMusicNodes;
    _bgMusicNodes = null;
    if (nodes.timer) clearInterval(nodes.timer);
    let t = audioCtx ? audioCtx.currentTime : 0;
    try {
        nodes.mix.gain.cancelScheduledValues(t);
        nodes.mix.gain.setValueAtTime(nodes.mix.gain.value, t);
        nodes.mix.gain.exponentialRampToValueAtTime(0.0001, t + 0.5);
    } catch (e) { }
    setTimeout(() => {
        nodes.oscillators.forEach(o => { try { o.stop(); } catch (e) { } });
    }, 600);
}

