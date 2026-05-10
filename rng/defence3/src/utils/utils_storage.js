"use strict";

const LS_AUDIO_SETTINGS_KEY = 'defence3_audio_settings_v1';

function saveUiSettingsToStorage() {
    try {
        // Build payload defensively so one missing setting does not block all persistence.
        let ui = {};
        if (Number.isFinite(levelVisibilityMode)) ui.levelVisibilityMode = Math.floor(levelVisibilityMode);
        if (Number.isFinite(renderRangeMode)) ui.renderRangeMode = Math.floor(renderRangeMode);
        if (typeof audioEnabled === 'boolean') ui.audioEnabled = !!audioEnabled;
        if (Number.isFinite(audioVolume)) ui.audioVolume = Math.max(0, Math.min(1, Number(audioVolume)));
        if (Number.isFinite(audioBackgroundVolume)) ui.audioBackgroundVolume = Math.max(0, Math.min(1, Number(audioBackgroundVolume)));
        if (typeof showGoldMineAmountText === 'boolean') ui.showGoldMineAmountText = !!showGoldMineAmountText;
        if (typeof rallyLineType !== 'undefined') ui.rallyLineType = rallyLineType;
        if (typeof rallyLineScope !== 'undefined') ui.rallyLineScope = rallyLineScope;
        if (typeof selectionOutlineType !== 'undefined') ui.selectionOutlineType = selectionOutlineType;
        if (typeof selectionOutlineScope !== 'undefined') ui.selectionOutlineScope = selectionOutlineScope;
        if (Number.isFinite(buildPlacementMode)) ui.buildPlacementMode = Math.floor(buildPlacementMode);
        localStorage.setItem(LS_UI_SETTINGS_KEY, JSON.stringify(ui));

        // Keep audio in its own key as a robust fallback for older/corrupt UI blobs.
        localStorage.setItem(LS_AUDIO_SETTINGS_KEY, JSON.stringify({
            audioEnabled: (typeof audioEnabled === 'boolean') ? !!audioEnabled : true,
            audioVolume: Number.isFinite(audioVolume) ? Math.max(0, Math.min(1, Number(audioVolume))) : 1,
            audioBackgroundVolume: Number.isFinite(audioBackgroundVolume) ? Math.max(0, Math.min(1, Number(audioBackgroundVolume))) : 1
        }));
    } catch { }
}

function loadUiSettingsFromStorage() {
    try {
        let raw = localStorage.getItem(LS_UI_SETTINGS_KEY);
        let s = null;
        if (raw) {
            s = JSON.parse(raw);
            if (s && typeof s === 'object') {
                if (Number.isFinite(s.levelVisibilityMode)) {
                    levelVisibilityMode = Math.max(0, Math.min(2, Math.floor(s.levelVisibilityMode)));
                }
                if (Number.isFinite(s.renderRangeMode)) {
                    renderRangeMode = Math.max(0, Math.min(2, Math.floor(s.renderRangeMode)));
                }
                if (typeof s.audioEnabled === 'boolean') {
                    audioEnabled = s.audioEnabled;
                }
                if (Number.isFinite(s.audioVolume)) {
                    audioVolume = Math.max(0, Math.min(1, Number(s.audioVolume)));
                }
                if (Number.isFinite(s.audioBackgroundVolume)) {
                    audioBackgroundVolume = Math.max(0, Math.min(1, Number(s.audioBackgroundVolume)));
                }
                if (typeof s.showGoldMineAmountText === 'boolean') {
                    showGoldMineAmountText = s.showGoldMineAmountText;
                }
                if (s.rallyLineType === OVERLAY_LINE_SOLID || s.rallyLineType === OVERLAY_LINE_DOTTED) {
                    rallyLineType = s.rallyLineType;
                }
                if (s.rallyLineScope === OVERLAY_SCOPE_BUILDINGS || s.rallyLineScope === OVERLAY_SCOPE_BUILDINGS_UNITS || s.rallyLineScope === OVERLAY_SCOPE_NONE) {
                    rallyLineScope = s.rallyLineScope;
                }
                if (s.selectionOutlineType === OVERLAY_LINE_SOLID || s.selectionOutlineType === OVERLAY_LINE_DOTTED) {
                    selectionOutlineType = s.selectionOutlineType;
                }
                if (s.selectionOutlineScope === OVERLAY_SCOPE_BUILDINGS || s.selectionOutlineScope === OVERLAY_SCOPE_BUILDINGS_UNITS || s.selectionOutlineScope === OVERLAY_SCOPE_NONE) {
                    selectionOutlineScope = s.selectionOutlineScope;
                }
                if (Number.isFinite(s.buildPlacementMode)) {
                    buildPlacementMode = Math.max(0, Math.min(2, Math.floor(s.buildPlacementMode)));
                }
            }
        }

        // Audio fallback: apply dedicated audio key if UI blob lacked these values.
        let hadUiAudio = !!(s && typeof s === 'object' && (typeof s.audioEnabled === 'boolean' || Number.isFinite(s.audioVolume) || Number.isFinite(s.audioBackgroundVolume)));
        if (!hadUiAudio) {
            let rawAudio = localStorage.getItem(LS_AUDIO_SETTINGS_KEY);
            if (rawAudio) {
                let a = JSON.parse(rawAudio);
                if (a && typeof a === 'object') {
                    if (typeof a.audioEnabled === 'boolean') audioEnabled = a.audioEnabled;
                    if (Number.isFinite(a.audioVolume)) audioVolume = Math.max(0, Math.min(1, Number(a.audioVolume)));
                    if (Number.isFinite(a.audioBackgroundVolume)) audioBackgroundVolume = Math.max(0, Math.min(1, Number(a.audioBackgroundVolume)));
                }
            }
        }

        if (typeof applyAudioSettings === 'function') applyAudioSettings();
    } catch { }
}