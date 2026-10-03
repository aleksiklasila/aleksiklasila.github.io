'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const c = vm.createContext({ window: {}, console });
vm.runInContext(read('src/audio_visual/renderer3d.js'), c);
const P = c.window.Defence3Renderer3D.PersistentInstances;
const calls = [];
const gl = new Proxy({}, { get: (_, name) => (...args) => { calls.push([name, ...args]); return {}; } });
const layer = new P(12);
layer.reserve(1024); layer.count = 1024; layer.data.fill(1); layer.version++;
layer.upload(gl);
assert.equal(layer.uploadBytes, 1024 * 48);
calls.length = 0; layer.alpha = .75; layer.upload(gl);
assert.equal(calls.length, 0, 'interpolation/camera frames perform zero buffer work');
layer.version++; layer.upload(gl);
assert.equal(layer.uploadBytes, 0, 'unchanged tick does not upload static records');
layer.data[300 * 12] = 2; layer.version++; layer.upload(gl);
assert.equal(layer.uploadBytes, 256 * 48, 'one changed page uploads rather than the entire army');
layer.count = 10; layer.version++; layer.upload(gl);
assert.equal(layer.uploadBytes, 0, 'removals shorten draw count without uploading unchanged records');
layer.dispose(gl); layer.upload(gl);
assert.equal(layer.uploadBytes, 10 * 48, 'context/resource reset restores all live data');

const source = read('src/audio_visual/renderer.js');
Object.assign(c, { gameTime: 1, visibilityVersion: 1, fullVisibility: true, localPlayerId: 0, teamVisibilityHistory: false,
    TILE: 32, GRID_W: 1000, GRID_H: 1000, WORLD_W: 32000, WORLD_H: 32000, tickAlpha: .25,
    selectedUnits: [], selectedEntities: [], activeSubGroups: {},
    getActiveUnitsForRender: () => c.selectedUnits, getActiveEntities: () => c.selectedEntities,
    renderer3dInstance: { gl }, _parseHexColor: () => ({r:255,g:128,b:0}), get3DRenderOwnerColor: () => '#ff8000',
    _isLiveRenderGrid: () => true, getCellItemsRowMajor: () => [],
    VISIBILITY_LIGHT_NORMALIZATION_RANGE: 6, _staticCacheCommitVersion: 1, _combinedBgCanvas: {},
    _backgroundContentVersion: 1, _visibilityMaskCanvas: null, renderer3dFxBatch: {reset(){}},
    beginFrameEffects(){}, buildFrameEffects(){}, endFrameEffects(){}, getTeamLightingGrid: () => [],
    get3DProjectionSnapshot: () => ({camera:{}}), get3DVisibleWorldBounds: () => ({}), getVisibleWorldBounds: () => ({}),
    camera: { zoom:.02 }, getBackgroundMip: () => ({}), getCurrentBuildPreviewData: () => null,
    rebuildVisibilityMaskCacheIfNeeded(){}, visibilityHistoryState: null });
vm.runInContext(source.slice(source.indexOf('let rendererScaleCache ='), source.indexOf('function build3DFrameData(')), c);
const u = {id:1,x:100,y:100,prevX:90,prevY:95,owner:0,energy:10,r:8,vx:1,vy:0};
const v = {grid:[],units:[u],towers:[],barracks:[],collectorSpawners:[],goldMines:[],astarMines:[],droppedItems:[],projectiles:[],particles:[],visibilityGrid:[]};
c.units = v.units;
let snap = c.buildScaleFrameData(true, v), moving = snap.scaleLayers[1];
assert.equal(moving.count, 1);
assert.equal(moving.data[2], 90 / 32);
const version = moving.version;
c.tickAlpha = .9;
c.buildScaleFrameData(true, v);
assert.equal(moving.version, version, 'unchanged presentation is not repacked on frames');
assert.equal(moving.alpha, .9);
c.gameTime++; u.prevX = u.x; u.prevY = u.y;
c.buildScaleFrameData(true, v);
assert.equal(moving.data[0], moving.data[2], 'stopping clears previous movement');
u.teleportHideTicks = 2; c.gameTime++;
c.buildScaleFrameData(true, v); assert.equal(moving.count, 0, 'teleport hide preserved');
u.teleportHideTicks = 0; u._historyGhost = true; c.fullVisibility = false; c.gameTime++;
c.buildScaleFrameData(true, v);
assert.equal(moving.count, 1, 'frozen remembered units remain visible in dark fog');
assert.equal(moving.data[0], moving.data[2], 'history position stays frozen');
u._historyGhost = false; c.gameTime++;
c.buildScaleFrameData(true, v); assert.equal(moving.count, 0, 'unseen live units stay hidden');
v.units = Array.from({length:6000}, (_, i) => ({x:(i % 1000) * 32,y:Math.floor(i / 1000) * 32,prevX:(i % 1000) * 32,prevY:0}));
v.units[5900].prevX = 0; // Long interpolation belongs to conservative overflow.
const bounds = {minGx:0,minGy:0,maxGx:10,maxGy:10};
const subset = c.getChunkRenderView(v,bounds).units;
assert.ok(subset.length < 1000 && subset.includes(v.units[5900]), 'query rejects distant population but retains crossing motions');
assert.equal(c.getChunkRenderView(v,bounds).units, subset, 'same camera chunk query reused');
assert.deepEqual(Array.from(subset, e => v.units.indexOf(e)), Array.from(subset, e => v.units.indexOf(e)).sort((a,b)=>a-b), 'painter order preserved');

const r = Object.create(c.window.Defence3Renderer3D.prototype);
r.tmpViewProjection = new Float32Array(16); r.tmpInverseViewProjection = new Float32Array(16);
r.tmpProjection = new Float32Array(16); r.tmpView = new Float32Array(16);
r.cssWidth = 1920; r.cssHeight = 1080; r.orbitPitch = 1; r.orbitYaw = 0;
r.buildViewProjection({viewportWidth:1920,viewportHeight:1080,worldWidth:1000,worldHeight:1000,camera:{centerX:500,centerZ:500,visibleWidth:1000,visibleHeight:1000}});
const p = r.projectWorldToScreenDetailed(500,0,500);
assert.ok(p.ndcZ > -1 && p.ndcZ < 1, 'whole-map camera lies inside the depth range');
console.log('PASS persistent GPU pages, interpolation, removal, history, chunks and large-map projection');
