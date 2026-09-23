const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const read = file => fs.readFileSync(path.join(__dirname,'..',file),'utf8');
let created=0,trailLines=0,headCalls=0,draws=[];
function canvasContext(){return {setTransform(){},beginPath(){},moveTo(){},lineTo(){trailLines++;},stroke(){}};}
const context=vm.createContext({
    camera:{zoom:1},window:{devicePixelRatio:1},
    document:{createElement(){created++;return {getContext:()=>canvasContext()};}}
});
const source=read('src/audio_visual/renderer2d.js');
vm.runInContext(source,context);
// Observe the cached trail independently of the shared head sprite cache.
context.drawCachedUnitBody=(g)=>{assert.equal(g.__snakeHeadOnly,true);headCalls++;};
const g={save(){},restore(){},beginPath(){},moveTo(){},lineTo(){},stroke(){},drawImage(...args){draws.push(args);}};
const snake={x:100,y:100,r:7,color:'#0f0',snakeHistory:Array.from({length:20},(_,i)=>({x:96-i*6,y:100+i*2}))};
const before=JSON.stringify(snake);
for(let frame=0;frame<60;frame++)assert.equal(context.drawCachedSnakeBody(g,snake,'#f00',1),true);
assert.equal(created,1,'one per-unit trail canvas');
assert.equal(trailLines,19,'stationary history is rasterized once');
assert.equal(headCalls,60,'head remains live every frame');
assert.equal(JSON.stringify(snake),before,'render caches do not mutate deterministic unit state');
snake.x+=2;
context.drawCachedSnakeBody(g,snake,'#f00',1);
assert.equal(trailLines,19,'interpolated head movement does not rerasterize history');
snake.snakeHistory.unshift({x:snake.x,y:snake.y});snake.snakeHistory.pop();
context.drawCachedSnakeBody(g,snake,'#f00',1);
assert.equal(trailLines,38,'recording a new tail point invalidates the trail');
context.drawCachedSnakeBody(g,snake,'#afe',1);
assert.equal(trailLines,57,'status outline color invalidates the trail');
context.camera.zoom=2;
context.drawCachedSnakeBody(g,snake,'#afe',1);
assert.equal(trailLines,76,'zoom updates raster resolution');
assert.equal(created,1,'the same per-unit canvas is reused');
g.__snakeHeadOnly=true;
assert.equal(context.drawCachedSnakeBody(g,snake,'#afe',1),false,'3D head panels never rasterize the world tail');
g.__snakeHeadOnly=false;
snake.snakeHistory[0]={x:10000,y:10000};
assert.equal(context.drawCachedSnakeBody(g,snake,'#afe',1),false,'oversized/teleported trails retain vector fallback');
assert.equal(g.__drawImagesImmediately,undefined,'canvas flags are restored');
console.log('PASS: snake trail reuse, live heads, color/zoom/history invalidation, bounded canvases and unchanged unit state.');
