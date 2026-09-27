const assert=require('node:assert/strict');const H=require('./net-harness.cjs');
const world=new H.World(),game=world.spawn('config');
const fields=['cfg-gold-count','cfg-gold-min','cfg-gold-max','cfg-astar-mine-count','cfg-astar-mine-min','cfg-astar-mine-max','cfg-starting-energy','cfg-starting-astar'];
const values='[GOLD_MINE_COUNT,GOLD_MINE_MIN,GOLD_MINE_MAX,ASTAR_MINE_COUNT,ASTAR_MINE_MIN,ASTAR_MINE_MAX,STARTING_MONEY,STARTING_ASTAR]';
const read=()=>JSON.parse(game.eval('JSON.stringify('+values+')'));
for(const value of ['0','-10']) {
    game.eval(`${JSON.stringify(fields)}.forEach(id=>document.getElementById(id).value=${JSON.stringify(value)});readConfigFromMenu();`);
    assert.deepEqual(read(),Array(8).fill(0),'zero and negative values normalize to zero');
}
game.eval(`${JSON.stringify(fields)}.forEach(id=>document.getElementById(id).value='12.75');readConfigFromMenu();`);
assert.deepEqual(read(),[12,12,12,12,12,12,12,12.75],'integer counts and fractional A*');
for(const value of ['','bad','Infinity']) {
    game.eval(`${JSON.stringify(fields)}.forEach(id=>document.getElementById(id).value=${JSON.stringify(value)});readConfigFromMenu();`);
    assert.deepEqual(read(),[18,500,1500,12,12,12,2000,12.75],'missing and invalid values use finite defaults');
}
game.eval(`document.getElementById('cfg-gold-min').value='200';document.getElementById('cfg-gold-max').value='100';readConfigFromMenu();`);
assert.equal(game.eval('GOLD_MINE_MAX'),200,'reversed mine amounts normalize');
// Both resource generation and starting-resource application use the exact
// zero settings read from the menu, without an implicit refill.
game.eval(`${JSON.stringify(fields)}.forEach(id=>document.getElementById(id).value='0');startSoloGame();`);
assert.equal(game.eval('goldMines.length+astarMines.length'),0);
assert.equal(game.eval('players.some(p=>p && (p.energy!==0 || p.astar!==0))'),false);
assert.deepEqual(game.errors,[]);
console.log('PASS: zero resource startup, no generated mines, finite fallbacks, negative/fractional normalization and ordered mine amounts.');
