"use strict";

function saveUiSettingsToStorage() {
    try {
        localStorage.setItem(LS_UI_SETTINGS_KEY, JSON.stringify({
            levelVisibilityMode,
            renderRangeMode,
            audioEnabled,
            audioVolume,
            audioBackgroundVolume,
            showGoldMineAmountText,
            rallyLineType,
            rallyLineScope,
            selectionOutlineType,
            selectionOutlineScope,
            buildPlacementMode
        }));
    } catch { }
}

function loadUiSettingsFromStorage() {
    try {
        let raw = localStorage.getItem(LS_UI_SETTINGS_KEY);
        if (!raw) return;
        let s = JSON.parse(raw);
        if (!s || typeof s !== 'object') return;

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
    } catch { }
}