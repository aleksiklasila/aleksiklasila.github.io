const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const state = fs.readFileSync(path.join(root, 'src/data/data_state.js'), 'utf8');
const defaults = state.slice(state.indexOf('const LEVEL_VISIBILITY_ALL'), state.indexOf('const OVERLAY_SPRITE_CACHE_MAX_SIDE'));
const storage = fs.readFileSync(path.join(root, 'src/utils/utils_storage.js'), 'utf8');
const values = new Map();

function session() {
    const mapVisibility = { value: 'history' };
    const context = vm.createContext({
        LS_UI_SETTINGS_KEY: 'defence3_ui_settings_v1',
        localStorage: {
            getItem(key) { return values.get(key) ?? null; },
            setItem(key, value) { values.set(key, value); }
        },
        document: { getElementById(id) { return id === 'cfg-full-vis' ? mapVisibility : null; } },
        applyAudioSettings() { context.audioApplied = true; }
    });
    vm.runInContext('let audioEnabled = true; let buildPlacementMode = 2; ' + defaults + storage, context);
    return {
        mapVisibility,
        get(expression) { return vm.runInContext(expression, context); },
        run(code) { vm.runInContext(code, context); }
    };
}

const first = session();
assert.equal(first.get('levelVisibilityMode'), 1);
assert.equal(first.get('renderRangeMode'), 3);
assert.equal(first.get('renderRangeAllTeam'), true);
assert.equal(first.get('rallyLineScope'), 'none');
assert.equal(first.get('selectionOutlineType'), 'solid');
assert.equal(first.get('audioBackgroundVolume'), .1);
first.run("levelVisibilityMode = 0; renderRangeMode = 4; renderRangeAllTeam = false; renderRangeSeeThrough = true; showGoldMineAmountText = true; rallyLineType = 'solid'; rallyLineScope = 'buildings_units'; selectionOutlineType = 'dotted'; selectionOutlineScope = 'units'; selectionOutlineSeeThrough = true; audioVolume = .35; audioBackgroundVolume = .6; buildPlacementMode = 1; saveUiSettingsToStorage()");
first.mapVisibility.value = 'team';
first.run('saveUiSettingsToStorage()');

const second = session();
second.run('loadUiSettingsFromStorage()');
for (const [name, expected] of Object.entries({
    levelVisibilityMode: 0, renderRangeMode: 4, renderRangeAllTeam: false,
    renderRangeSeeThrough: true, showGoldMineAmountText: true, rallyLineType: 'solid',
    rallyLineScope: 'buildings_units', selectionOutlineType: 'dotted',
    selectionOutlineScope: 'units', selectionOutlineSeeThrough: true,
    audioVolume: .35, audioBackgroundVolume: .6, buildPlacementMode: 1
})) assert.equal(second.get(name), expected, name);
assert.equal(second.mapVisibility.value, 'team');
assert.equal(second.get('showSelectionOutlinesForBuildings()'), false);
assert.equal(second.get('showSelectionOutlinesForUnits()'), true);
assert.equal(second.get('audioApplied'), true);

values.set('defence3_ui_settings_v1', JSON.stringify({ selectionOutlineScope: 'buildings' }));
const legacy = session();
legacy.run('loadUiSettingsFromStorage()');
assert.equal(legacy.get('selectionOutlineScope'), 'buildings_units');
assert.equal(legacy.get('audioBackgroundVolume'), .6);
values.set('defence3_ui_settings_v1', '{bad json');
const corrupt = session();
corrupt.run('loadUiSettingsFromStorage()');
assert.equal(corrupt.get('audioVolume'), .35);
assert.equal(corrupt.get('audioBackgroundVolume'), .6);
console.log('PASS: settings defaults, round trip, legacy outlines, and audio recovery.');
