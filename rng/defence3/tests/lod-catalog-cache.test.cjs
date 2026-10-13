'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../src/audio_visual/renderer.js'), 'utf8');
const strings = ['', 'norm', 'fire', 'L1'];
const c = vm.createContext({
    _pageFrameStrings: strings,
    BASE_UNIT_STATS: {norm:{color:'#aaa'}, scout:{color:'#bbb'}},
    BASE_CARD_TYPES: {fire:{target:'wall',color:'#f00'}},
    MOUNTED_UNIT_TYPES: new Set(), UNIT_3D_BODY_COLORS: {},
    getUnit3DWeaponType: () => 'sword'
});
vm.runInContext(source.slice(source.indexOf('let _columnLodCatalog = null;'), source.indexOf('// Shared sprites for every unit/structure')), c);
const first = c.getColumnLodCatalog();
const mineSprites={gold:{type:'gold-square'},astar:{type:'astar-gray-square'}};
const mineStates=[];
c._getGoldMineTileSprite=active=>{mineStates.push(active);return mineSprites.gold;};
c._getAstarMineTileSprite=active=>{mineStates.push(active);return mineSprites.astar;};
for(const type of ['gold','astar']) {
    const style=first.styles.find(s=>s.modelKey===type+'_mine_active');
    const calls=[];style.draw({drawImage:(...args)=>calls.push(args)});
    assert.equal(calls[0][0],mineSprites[type],'far mines reuse their real square tile sprite');
    assert.equal(style.neutral,true,'resource tiles do not acquire a player-colored rim');
    assert.equal(style.scaleX,.9/.94);assert.equal(style.scaleY,.35/.94);
    assert.equal(mineStates.at(-1),true);
    const empty=first.styles.find(s=>s.modelKey===type+'_mine_empty');
    empty.draw({drawImage(){}});assert.equal(mineStates.at(-1),false,'depleted mines retain their real tile state');
    const row=type==='gold'?4:5;
    assert.notEqual(first.lookup[row*first.width*4],first.lookup[(row*first.width+1)*4]);
}
assert.equal(first.styles.length, 9,'the full roster is prepared before every type has spawned');
assert.equal(first.lookup[(7 * first.width + 1) * 4], 1);
// Runtime labels can grow beyond a texture-width boundary on any tick.
// They must not trigger hundreds of model bakes and texture uploads.
for (let i = 0; i < 1000; i++) strings.push('L' + (i + 2));
assert.equal(c.getColumnLodCatalog(), first);
strings.push('scout');
const added = c.getColumnLodCatalog();
assert.notEqual(added, first);
assert.equal(added.styles.length, 9);
assert.equal(added.styles,first.styles,'new string codes reuse the baked style list');
assert.ok(added.lookup[(7 * added.width + strings.length - 1) * 4] > 0);
// Restarting a game reuses the table object but may assign different codes.
strings.splice(0, strings.length, '', 'fire', 'norm', 'L1');
const restarted = c.getColumnLodCatalog();
assert.notEqual(restarted, added);
assert.equal(restarted.styles,first.styles,'restarting a game keeps the same baked styles');
assert.equal(restarted.lookup[(7 * restarted.width + 1) * 4], 0);
assert.ok(restarted.lookup[(7 * restarted.width + 2) * 4] > 0);
assert.equal(c.getColumnLodCatalog(), restarted);
strings.push('house','farm','lava','builder_spawner');
Object.assign(c.BASE_CARD_TYPES,{
    house:{target:'floor',visionRange:.4},farm:{target:'floor',visionRange:0},
    lava:{target:'floor',visionRange:0},builder_spawner:{target:'floor',visionRange:.6}
});
c.get3DWorkshopSignTexture=type=>({type});
const buildings=c.getColumnLodCatalog();
for(const [type,height,preserve] of [['house',.82,true],['farm',.72,true],['lava',.14,false],['builder_spawner',.62,true]]) {
    const s=buildings.styles.find(s=>s.type===type);
    assert.ok(Math.abs(s.scaleY*.94-height)<1e-7,`${type} matches the close model's height`);
    assert.equal(s.preserveModelHeight,preserve);
    assert.equal(s.bakeHeight,1);
}
assert.equal(buildings.styles.find(s=>s.type==='builder_spawner').statusTextureCanvas.type,'builder_spawner');
assert.equal(buildings.stride,81,'static models use the same direction/elevation layout as animated units');
const fire=buildings.styles.find(s=>s.type==='fire');
assert.equal(fire.scaleY,1.05/.94);
c.BASE_UNIT_STATS.snake={color:'#0f0',visionRange:1};strings.push('snake');
const snakes=c.getColumnLodCatalog(),snake=snakes.styles.find(s=>s.modelKey==='unit_snake');
assert.equal(snake.snake,true);assert.equal(snake.scaleY,.52);
assert.equal(snakes.lookup[(7*snakes.width+strings.indexOf('snake'))*4+1],-1,'snake uses its own minimum height, not a humanoid torso');
console.log('PASS: atlas cache ignores labels, includes new types, and remaps codes after restart.');
