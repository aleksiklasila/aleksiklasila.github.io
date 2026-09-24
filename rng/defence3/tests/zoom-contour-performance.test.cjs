const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const read = f => fs.readFileSync(path.join(__dirname,'..',f),'utf8');

// Wheel steps within a tier must not rasterize 1000 bodies again. Higher
// tiers must have enough physical pixels; budget misses use exact geometry.
let builds=0, vectors=0, images=0;
const canvases=[];
const c=vm.createContext({camera:{zoom:1},window:{devicePixelRatio:2},
    drawUnitBodyGeometry(g){if(g.sprite) builds++; else vectors++;},
    document:{createElement(){const canvas={getContext:()=>({sprite:true,setTransform(){}})};canvases.push(canvas);return canvas;}}});
const renderer=read('src/audio_visual/renderer2d.js');
vm.runInContext(renderer.slice(renderer.indexOf('const _unitBodySprites'),renderer.indexOf('function _drawAreaCoverageOverlay2D')),c);
const g={imageSmoothingEnabled:false,drawImage(){assert.equal(this.imageSmoothingEnabled,true);images++;}};
const unit={unitType:'norm',vis:'circle',r:8,color:'#0f0',x:30,y:40};
for (const zoom of [1,1.2,1.44,1.728,1.44,1.2,1]) {
    c.camera.zoom=zoom;
    for(let i=0;i<1000;i++) c.drawCachedUnitBody(g,unit,'#00f',1);
    assert.equal(g.imageSmoothingEnabled,false,'restore caller sampling state');
}
assert.equal(builds,2,'7000 draws across the old vector threshold build only two resolution tiers');
assert.equal(vectors,0);
assert.equal(images,7000);
assert.equal(canvases[1].width,64*2,'high tier has four pixels per world unit');
vm.runInContext('_unitBodySpriteBuildsRemaining=0',c);
c.camera.zoom=4;
c.drawCachedUnitBody(g,unit,'#00f',1);
assert.equal(vectors,1,'unbuilt tier uses vectors instead of blurry upscaling');
c.drawCachedUnitBody(g,{...unit,isSnake:true},'#00f',1);
assert.equal(vectors,2,'snake trail remains live');

// Compare bounded marching against the exhaustive cell traversal, including
// negative coordinates, chunk seams, buildings, holes and moving mixed groups.
const source=read('src/audio_visual/selection_overlay.js');
const make=s=>new Function(s+';return buildSelectionContours;')();
const optimized=make(source);
const exhaustive=make(source.replace('cy = chunk.minY; cy <= chunk.maxY','cy = 0; cy < chunkSize')
    .replace('cx = chunk.minX; cx <= chunk.maxX','cx = 0; cx < chunkSize'));
let seed=19431;
const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
for(let frame=0;frame<30;frame++) {
    const footprints=Array.from({length:180},(_,i)=>({x:random()*500-200,y:random()*500-200,
        radius:i%5?14:20,box:i%5?0:15,color:i%3?'#f00':'#00f'}));
    assert.deepEqual(optimized(footprints),exhaustive(footprints),'optimized traversal preserves every contour vertex');
}
console.log('PASS: 7000 zoomed bodies use two sharp sprite tiers; 30 contour frames match exhaustive geometry exactly.');
