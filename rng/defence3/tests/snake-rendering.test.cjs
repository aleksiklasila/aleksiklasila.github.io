const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const read = file => fs.readFileSync(path.join(__dirname,'..',file),'utf8');
const unitSource = read('src/things/unit.js');
const renderer = read('src/audio_visual/renderer.js');
const renderer3d = read('src/audio_visual/renderer3d.js');

// Snakes are drawn as their head only: no tail history, strokes or segments.
const context = vm.createContext({ camera:{zoom:1}, document:{createElement(){throw Error('immediate draw');}} });
vm.runInContext(unitSource.slice(unitSource.indexOf('function drawUnitBodyGeometry(')),context);
let strokes=0,fills=0;
const g={save(){},restore(){},beginPath(){},moveTo(){},lineTo(){},arc(){},stroke(){strokes++;},fill(){fills++;}};
const snake={isSnake:true,x:100,y:100,r:7,color:'#0f0'};
const before=JSON.stringify(snake);
context.drawUnitBodyGeometry(g,snake,'#f00',1);
assert.equal(strokes,0,'no tail strokes');
assert.equal(fills,4,'head outline, head and two eyes');
assert.equal(JSON.stringify(snake),before,'rendering does not mutate unit state');
for (const source of [unitSource, renderer, renderer3d, read('src/utils/utils_networking.js'), read('src/audio_visual/visibility_history.js')]) {
    assert.doesNotMatch(source,/snakeHistory|snakeRecordTimer|snake_segment|__snakeHeadOnly/);
}

// The head panel is part of the model: uniform XZ scale keeps the 2D texture
// square, and the serpent panel turns with the model (not world-aligned).
const headStart = renderer.indexOf('let pushSnakeRenderObjects');
const head = renderer.slice(headStart, renderer.indexOf('for (let u of units)', headStart));
assert.match(head,/scaleX: footprint,[\s\S]*scaleZ: footprint,/);
const serpent = renderer3d.slice(renderer3d.indexOf("} else if (kind === 'serpent') {"), renderer3d.indexOf('} else {', renderer3d.indexOf("} else if (kind === 'serpent') {")));
const panel = serpent.match(/panel\(([^)]*)\)/)[1].split(',').map(s=>s.trim());
assert.equal(panel.length,6,'horizontal panel without the world-aligned flag');
assert.equal(panel[3],panel[4],'square panel');
const panelY = Number(panel[1]);
for (const part of serpent.matchAll(/part\(([^)]*)\)/g)) {
    const [, y, , , sy] = part[1].split(',').map(Number);
    assert.ok(y + sy < panelY, `model part reaches ${y + sy}, above the roof panel at ${panelY}`);
}
console.log('PASS: head-only snakes, no tail state, square model-mounted roof panel with nothing above it.');
