const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const read = file => fs.readFileSync(path.join(__dirname,'..',file),'utf8');
const context = vm.createContext({
    camera:{zoom:1},
    document:{createElement(){throw Error('2D snakes must not allocate raster caches');}}
});
vm.runInContext(read('src/audio_visual/renderer2d.js'),context);
const unitSource = read('src/things/unit.js');
vm.runInContext(unitSource.slice(unitSource.indexOf('function buildSnakeTrailPath(')),context);
let points=[],strokes=[],fills=0;
const g={
    save(){},restore(){},beginPath(){points=[];},moveTo(x,y){points.push([x,y]);},lineTo(x,y){points.push([x,y]);},
    stroke(){strokes.push({points:points.slice(),color:this.strokeStyle,width:this.lineWidth});},arc(){},fill(){fills++;},
    drawImage(){throw Error('2D snakes must not upload/draw tail canvases');}
};
const snake={isSnake:true,x:100,y:100,r:7,color:'#0f0',snakeHistory:Array.from({length:20},(_,i)=>({x:100-i*6,y:100-i*2}))};
let before=JSON.stringify(snake);
context.drawCachedUnitBody(g,snake,'#f00',1);
assert.equal(strokes.length,2,'one outline and one body stroke');
assert.equal(strokes[0].points.length,2,'straight tail has one segment, not twenty round joins');
assert.deepEqual(strokes[0].points,[[100,100],[-14,62]]);
assert.deepEqual(strokes[0].points,strokes[1].points,'both strokes reuse one path');
assert.deepEqual(strokes.map(s=>[s.width,s.color]),[[17,'#f00'],[14,'#0f0']]);
assert.equal(fills,4,'head and eyes remain visible');
assert.equal(JSON.stringify(snake),before,'rendering does not mutate unit state');

// Turns and reversals must survive; identical points may disappear.
snake.x=0;snake.y=0;
snake.snakeHistory=[{x:0,y:0},{x:1,y:0},{x:2,y:0},{x:2,y:1},{x:2,y:1},{x:2,y:2},{x:2,y:0},{x:1,y:0}];
context.buildSnakeTrailPath(g,snake);
assert.deepEqual(points,[[0,0],[2,0],[2,2],[2,0],[1,0]]);
snake.snakeHistory=Array.from({length:20},()=>({x:0,y:0}));
strokes=[];fills=0;
context.drawCachedUnitBody(g,snake,'#afe',1);
assert.equal(strokes.length,0,'a collapsed stationary tail needs no strokes underneath its head');
assert.equal(fills,4);

// Exercise moving heads and changing history at several zooms. Any raster cache
// creation or drawImage above fails immediately, including on the first frame.
for(const zoom of [.25,1,3]) {
    context.camera.zoom=zoom;
    for(let i=0;i<1200;i++) {
        snake.x=i*.125;snake.y=i*.25;
        snake.snakeHistory=Array.from({length:20},(_,j)=>({x:snake.x-j*4,y:snake.y-j*2}));
        strokes=[];
        context.drawCachedUnitBody(g,snake,'#afe',1);
        assert.equal(strokes.length,2);
        assert.equal(strokes[0].points.length,2);
    }
}
g.__snakeHeadOnly=true;strokes=[];fills=0;
context.drawCachedUnitBody(g,snake,'#f00',1);
assert.equal(strokes.length,0,'the improved 3D panel path still excludes the world tail');
assert.equal(fills,4);
console.log('PASS: 3600 live snake draws without raster caches; exact straight-path reduction, turns, reversals, stationary tails and 3D head-only panels.');
