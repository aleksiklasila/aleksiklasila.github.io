const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const controls = new Map();
const attr = (text, name) => text.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1];
for (const match of html.matchAll(/<input\b([^>]*)>|<select\b([^>]*)>([\s\S]*?)<\/select>/g)) {
    const tag = match[1] === undefined ? 'select' : 'input';
    const attrs = match[1] ?? match[2];
    const body = match[3] || '';
    const id = attr(attrs, 'id');
    if (!id || !/^(cfg-|setting-|btn-level-visibility$|btn-render-range$|jukebox-music$|jukebox-effects$)/.test(id)) continue;
    const options = [...body.matchAll(/<option\b([^>]*)>/g)].map(m => ({ value: attr(m[1], 'value'), selected: /\bselected\b/.test(m[1]) }));
    controls.set(id, {
        id, tagName: tag.toUpperCase(), type: tag === 'select' ? 'select-one' : attr(attrs, 'type'),
        value: options.length ? (options.find(o => o.selected) || options[0]).value : attr(attrs, 'value') || '',
        checked: /\bchecked\b/.test(attrs), options,
        matches: () => true, dispatchEvent: () => {}
    });
}
const noop = () => {};
const values = new Map();
const context = vm.createContext({
    document: {
        getElementById: id => controls.get(id) || null,
        querySelectorAll: () => [...controls.values()], addEventListener: noop,
        createElement: () => ({ style: {}, getContext: () => null })
    },
    window: { innerWidth: 1280, innerHeight: 720, addEventListener: noop, matchMedia: () => ({ matches: false }) },
    localStorage: { getItem: key => values.get(key) || null, setItem: (key, value) => values.set(key, value) },
    Event: class { constructor(type) { this.type = type; } }, console, performance
});
for (const [, file] of html.matchAll(/<script src="\.\/(src\/[^"?]+)(?:\?[^" ]*)?"/g)) {
    if (!file.endsWith('bootstrap.js')) vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), context, { filename: file });
}
const run = code => vm.runInContext(code, context);
// These rebuild gameplay caches, unrelated to settings serialization.
run('rebuildPrecomputedStatsMap = refreshStartingResourcesPreviewPrecomputedStats = () => {};');

for (const mode of ['full', 'team', 'history']) {
    controls.get('cfg-full-vis').value = mode;
    controls.get('cfg-gamemode').value = 'killking';
    const snapshot = run('createMainMenuSettingsSnapshot()');
    assert.equal(snapshot.editableConfig.config.MAP_VISIBILITY, mode);
    assert.equal(snapshot.editableConfig.config.GAME_MODE, 'killking');
    assert.equal(snapshot.lobby.selects['cfg-full-vis'], mode);
    const editor = run('parseConfigEditorObject(makeConfigEditorTextFromCurrentConfig())');
    assert.equal(editor.config.MAP_VISIBILITY, mode, 'Config uses current menu selection');
    assert.equal(editor.config.GAME_MODE, 'killking');
    context.saved = JSON.parse(JSON.stringify(snapshot));
    for (const el of controls.values()) {
        if (el.type === 'checkbox') el.checked = !el.checked;
        else if (el.options.length) el.value = el.options.find(o => o.value !== el.value)?.value || el.value;
        else el.value = '1';
    }
    run('applyMainMenuSettingsSnapshot(saved)');
    for (const [id, expected] of Object.entries(snapshot.lobby.numbers)) assert.equal(Number(controls.get(id).value), expected, id);
    for (const [id, expected] of Object.entries(snapshot.lobby.selects)) assert.equal(controls.get(id).value, expected, id);
    for (const [id, expected] of Object.entries(snapshot.lobby.checks)) assert.equal(controls.get(id).checked, expected, id);
    assert.equal(run('fullVisibility'), mode === 'full');
    assert.equal(run('teamVisibilityHistory'), mode === 'history');
    assert.equal(run('gameMode'), 'killking');
    run('saveUiSettingsToStorage()');
    controls.get('cfg-full-vis').value = '';
    run('loadUiSettingsFromStorage()');
    assert.equal(controls.get('cfg-full-vis').value, mode);
}
// Config-only imports work without lobby controls and ignore absent/invalid fields.
run("applyEditableRuntimeConfigObject({config: {MAP_VISIBILITY: 'team', GAME_MODE: 'destroy'}})");
assert.equal(controls.get('cfg-full-vis').value, 'team');
assert.equal(controls.get('cfg-gamemode').value, 'destroy');
run("applyEditableRuntimeConfigObject({config: {MAP_VISIBILITY: 'invalid', GAME_MODE: 'invalid'}})");
run('applyEditableRuntimeConfigObject({config: {}})');
assert.equal(controls.get('cfg-full-vis').value, 'team');
assert.equal(controls.get('cfg-gamemode').value, 'destroy');
console.log(`PASS: all ${controls.size} menu/display controls round trip; visibility modes, Config, browser storage and legacy config imports.`);
