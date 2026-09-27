// Settings > Rendering > Graphics: presets, option validation, persistence,
// and the post-process shader variants (GPU output is verified in-browser;
// see PERFORMANCE.md for the benchmark).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');
const state = read('src/data/data_state.js');
const defaults = state.slice(state.indexOf('const LEVEL_VISIBILITY_ALL'), state.indexOf('const OVERLAY_SPRITE_CACHE_MAX_SIDE'));
const storage = read('src/utils/utils_storage.js');
const values = new Map();

function session() {
    const context = vm.createContext({
        LS_UI_SETTINGS_KEY: 'defence3_ui_settings_v1',
        localStorage: { getItem: k => values.get(k) ?? null, setItem: (k, v) => values.set(k, v) },
        document: { getElementById: () => null },
        applyAudioSettings() { }
    });
    vm.runInContext('let audioEnabled = true; let buildPlacementMode = 2; ' + defaults + storage, context);
    return { get: e => vm.runInContext(e, context), run: c => vm.runInContext(c, context) };
}

const s = session();
// Default is the original pipeline.
assert.deepEqual(JSON.parse(s.get('JSON.stringify(graphicsOptions)')), JSON.parse(s.get('JSON.stringify(GRAPHICS_PRESETS.simple)')));
assert.equal(s.get('matchGraphicsPreset(graphicsOptions)'), 'simple');
for (const name of ['off', 'simple', 'balanced', 'high', 'ultra']) {
    assert.equal(s.get(`matchGraphicsPreset(GRAPHICS_PRESETS.${name})`), name, name + ' round-trips');
}
assert.equal(s.get(`matchGraphicsPreset({ ...GRAPHICS_PRESETS.high, bloom: false })`), 'custom');
// Shadow modes include shadow-mapped quality levels.
assert.deepEqual([...s.get('GRAPHICS_SHADOW_MODES')], ['off', 'simple', 'detailed', 'high']);
assert.equal(s.get('GRAPHICS_PRESETS.high.shadows'), 'detailed');
assert.equal(s.get('GRAPHICS_PRESETS.ultra.shadows'), 'high');
// Invalid values fall back per field; resolution is clamped; zero is not "missing".
const bad = JSON.parse(s.get(`JSON.stringify(normalizeGraphicsOptions({ aa: 'ssaa', shadows: 'rtx', ao: 'high', outline: 'yes', bloom: true, resolution: 0.1 }))`));
assert.deepEqual(bad, { aa: 'msaa', shadows: 'simple', ao: 'high', outline: false, bloom: true, grade: false, sharpen: false, resolution: 0.5 });
assert.equal(s.get('normalizeGraphicsOptions({ resolution: 3 }).resolution'), 1);
assert.equal(s.get('normalizeGraphicsOptions({ resolution: null }).resolution'), 1);

// Persistence round trip, and corrupt stored options recover to valid ones.
s.run(`graphicsOptions = normalizeGraphicsOptions({ ...GRAPHICS_PRESETS.ultra, resolution: 0.75, sharpen: true }); saveUiSettingsToStorage();`);
const t = session();
t.run('loadUiSettingsFromStorage()');
assert.deepEqual(JSON.parse(t.get('JSON.stringify(graphicsOptions)')), { aa: 'msaa_fxaa', shadows: 'high', ao: 'high', outline: true, bloom: true, grade: true, sharpen: true, resolution: 0.75 });
values.set('defence3_ui_settings_v1', JSON.stringify({ graphicsOptions: { aa: 42, shadows: 'detailed' } }));
const u = session();
u.run('loadUiSettingsFromStorage()');
assert.equal(u.get('graphicsOptions.aa'), 'msaa');
assert.equal(u.get('graphicsOptions.shadows'), 'detailed');

// Shader variants: disabled effects are compiled out entirely.
const pctx = vm.createContext({ window: {} });
vm.runInContext(read('src/audio_visual/postprocess3d.js'), pctx);
const PP = pctx.window.Defence3PostProcess;
const post = new PP({});
const opts = o => ({ aa: 'off', shadows: 'off', ao: 'off', outline: false, bloom: false, grade: false, sharpen: false, resolution: 1, ...o });
assert.equal(post.isActive(opts({}), false), false, 'nothing enabled keeps the plain blit');
assert.equal(post.isActive(opts({ aa: 'msaa', shadows: 'simple' }), false), false, "'simple' is the original pipeline");
assert.equal(post.isActive(opts({ shadows: 'detailed' }), false), true);
assert.equal(post.needsDepth(opts({ shadows: 'high' }), false), true);
assert.equal(post.needsDepth(opts({ bloom: true, aa: 'fxaa' }), false), false);
assert.equal(post.isActive(opts({ ao: 'high', outline: true, shadows: 'high' }), true), false, 'depth effects are skipped in flat 2D');
const src = PP.compositeSource(post.features(opts({ aa: 'fxaa', shadows: 'high', grade: true }), false));
assert.match(src, /#define FXAA 1/);
assert.match(src, /#define SHADOWMAP 16/);
assert.match(src, /#define SHADOW_TAPS 16/);
assert.doesNotMatch(src, /#define (AO|BLOOM|OUTLINE|SHARPEN)\b/);
assert.match(PP.compositeSource(post.features(opts({ shadows: 'detailed' }), false)), /#define SHADOW_TAPS 9/);

// Renderer wiring: detailed shadows replace drop shadows and render a map.
const r3d = read('src/audio_visual/renderer3d.js');
assert.match(r3d, /let castShadows = shadowMode === 'simple';/);
assert.match(r3d, /this\.renderShadowMap\(snapshot, shadowMode,/);
console.log('PASS: graphics presets, validation, persistence, shader variants and shadow-mode wiring.');
