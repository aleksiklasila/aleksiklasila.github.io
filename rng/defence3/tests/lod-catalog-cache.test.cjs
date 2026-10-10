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
c._getGoldMineTileSprite=()=>mineSprites.gold;c._getAstarMineTileSprite=()=>mineSprites.astar;
for(const type of ['gold','astar']) {
    const style=first.styles.find(s=>s.modelKey===type+'_mine_active');
    const calls=[];style.draw({drawImage:(...args)=>calls.push(args)});
    assert.equal(calls[0][0],mineSprites[type],'far mines reuse their real square tile sprite');
    assert.equal(style.neutral,true,'resource tiles do not acquire a player-colored rim');
    assert.equal(style.scaleX,.9/.94);assert.equal(style.scaleY,.35/.94);
}
assert.equal(first.styles.length, 7);
assert.equal(first.lookup[(7 * first.width + 1) * 4], 1);
// Runtime labels can grow beyond a texture-width boundary on any tick.
// They must not trigger hundreds of model bakes and texture uploads.
for (let i = 0; i < 1000; i++) strings.push('L' + (i + 2));
assert.equal(c.getColumnLodCatalog(), first);
strings.push('scout');
const added = c.getColumnLodCatalog();
assert.notEqual(added, first);
assert.equal(added.styles.length, 9);
assert.ok(added.lookup[(7 * added.width + strings.length - 1) * 4] > 0);
// Restarting a game reuses the table object but may assign different codes.
strings.splice(0, strings.length, '', 'fire', 'norm', 'L1');
const restarted = c.getColumnLodCatalog();
assert.notEqual(restarted, added);
assert.equal(restarted.lookup[(7 * restarted.width + 1) * 4], 0);
assert.ok(restarted.lookup[(7 * restarted.width + 2) * 4] > 0);
assert.equal(c.getColumnLodCatalog(), restarted);
console.log('PASS: atlas cache ignores labels, includes new types, and remaps codes after restart.');
