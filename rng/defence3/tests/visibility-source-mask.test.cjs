const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const read = name => fs.readFileSync(path.join(__dirname, '..', name), 'utf8');
const functionSource = (source, name) => {
    const start = source.indexOf(`function ${name}(`);
    const end = source.indexOf('\nfunction ', start + 1);
    assert.ok(start >= 0);
    return source.slice(start, end < 0 ? undefined : end);
};

let grid = [Float32Array.from([4, 0])];
let maskPixels, maskDraw;
const canvasContext = () => ({
    clearRect() {}, save() {}, restore() {},
    createImageData(w, h) { return {data: new Uint8ClampedArray(w * h * 4)}; },
    putImageData(data) { maskPixels = data.data; },
    drawImage(...args) { maskDraw = {args, filter:this.filter}; }
});
const context = vm.createContext({
    TILE:32, GRID_W:2, GRID_H:1, WORLD_W:64, WORLD_H:32,
    VISIBILITY_LIGHT_NORMALIZATION_RANGE:6, _visibilityFogGamma:1.8, _visibilityFogMinAlpha:0,
    visibilityVersion:1, fullVisibility:false, localPlayerId:0,
    _visibilityMaskCanvas:null, _visibilityMaskCtx:null, _visibilityMaskGridCanvas:null,
    _visibilityMaskGridCtx:null, _visibilityMaskVersion:-1, _visibilityMaskFullVisibility:false,
    _visibilityMaskUnitFloor:new Float32Array(0),
    document:{createElement:()=>({width:0,height:0,getContext:canvasContext})},
    getRenderVisibilityGrid:()=>grid,
    getEntityEffectiveVisibilityRangeTiles:()=>4,
    units:[{unitType:'norm',owner:0,x:48,y:16,dead:false}]
});
vm.runInContext(functionSource(read('src/audio_visual/renderer.js'),'getVisualUnitSourceLight'),context);
const maskSource = read('src/audio_visual/renderer2d.js');
// The fog lookup table's declarations sit between these two functions.
vm.runInContext(functionSource(maskSource,'_getVisibilityFogAlphaLut')+'\n'+functionSource(maskSource,'ensureVisibilityMaskCanvas')+'\n'+
    functionSource(maskSource,'rebuildVisibilityMaskCacheIfNeeded'),context);
context.rebuildVisibilityMaskCacheIfNeeded();
assert.equal(grid[0][1],0,'gameplay visibility remains unchanged');
assert.ok(maskPixels[7]<255,'the moving source is lit in the presentation mask');
assert.equal(context._visibilityMaskCanvas.width,4,'the mask has two samples per tile');
assert.equal(maskDraw.filter,'blur(1px)','the visual mask bleeds by half a tile');
context.units[0].x = 16;
context.visibilityVersion++;
context.rebuildVisibilityMaskCacheIfNeeded();
assert.equal(maskPixels[7],255,'the visual source floor leaves the old tile when the unit moves');
assert.equal(context.getVisualUnitSourceLight({unitType:'norm',owner:1,x:48,y:16}),0,
    'enemy units do not add light to the local mask');
console.log('PASS: moving source stays lit in the blurred mask without changing gameplay visibility.');
