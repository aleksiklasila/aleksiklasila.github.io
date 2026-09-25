const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const read = p => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const fn = (text, name) => {
    const start = text.indexOf(`function ${name}(`);
    const end = text.indexOf('\nfunction ', start + 1);
    return text.slice(start, end < 0 ? undefined : end);
};
let lookups = 0;
const c = vm.createContext({TILE:32, GRID_W:8, GRID_H:8, AREA_UNIT_TILE_EQUIVALENT:5,
    areaIdGrid:Array.from({length:8},(_,y)=>Array.from({length:8},(_,x)=>(y<4?0:2)+(x<4?0:1)))});
const state = read('src/data/data_state.js');
for (const name of ['getAreaIdAtTile','getAreaIdAtWorld','addVisibilitySourceAreas']) vm.runInContext(fn(state,name),c);
const lookup = c.getAreaIdAtTile;
c.getAreaIdAtTile = (...args) => { lookups++; return lookup(...args); };
function coverage(x,y) {
    const areas = new Map();
    c.addVisibilitySourceAreas(areas,x*32,y*32,.6);
    return [...areas.keys()].sort();
}
assert.deepEqual(coverage(3.69,2.5),[0], 'outside the overlap only the original area is included');
assert.deepEqual(coverage(3.71,2.5),[0,1], 'neighbor starts before center crosses border');
assert.deepEqual(coverage(4.29,2.5),[0,1], 'old area stays during the overlap');
assert.deepEqual(coverage(4.31,2.5),[1], 'old area is released after overlap');
assert.deepEqual(coverage(3.9,3.9),[0,1,2,3], 'corner includes four areas');
assert.deepEqual(coverage(.1,.1),[0], 'map edge is bounded');
const light = Array.from({length:8},()=>new Float32Array(8));
c.addVisibilitySourceAreas(new Map(),3.9*32,2.5*32,.6,light);
assert.equal(light[2][4],3,'neighbor receives source light before crossing');
assert.equal(light[2][5],0,'overlap does not directly brighten distant tiles');
lookups=0;
const sources=new Map();
for(let i=0;i<1500;i++) c.addVisibilitySourceAreas(sources,3.9*32,3.9*32,.6);
assert.equal(sources.size,4,'1500 sources collapse to four shared area entries');
assert.ok(lookups<=1500*5,'constant lookup cost per source');

const things = read('src/things/things_utils.js');
vm.runInContext(fn(things,'getEntityEffectiveVisibilityRangeArea'),c);
c.calculateItemStats=()=>{throw Error('cached effective stats must avoid recalculation');};
for(const type of ['pistol','barrack','spawner','house',undefined]) {
    const entity={type,unitType:'norm',preComputed:{visionRangeArea:.6},currentStats:{visionRange:.6},
        preComputedEffective:{visionRangeArea:2.4}};
    assert.equal(c.getEntityEffectiveVisibilityRangeArea(entity),2.4);
    entity.preComputedEffective.visionRangeArea=0;
    assert.equal(c.getEntityEffectiveVisibilityRangeArea(entity),0,'zero effective range stays zero');
}

// Run the real visibility builder: neighboring area must be lit before entry,
// and a building must reveal using its effective rather than base range.
c.units=[{owner:0,x:3.9*32,y:2.5*32,preComputedEffective:{visionRangeArea:.6}}];
c.towers=[];c.barracks=[];c.collectorSpawners=[];
c.grid=Array.from({length:8},()=>Array.from({length:8},()=>({})));
c.gridCellsByArea=Array.from({length:4},()=>[]);
for(let y=0;y<8;y++) for(let x=0;x<8;x++) c.gridCellsByArea[lookup(x,y)].push({x,y});
c.getAreaIdsWithinDistance=(id,range)=>range>=1?[0,1,2,3]:[id];
vm.runInContext('let visibilityIncludedTilesScratch = [], visibilityStampScratch = [], visibilityRowSpanMinScratch = new Int32Array(0), visibilityRowSpanMaxScratch = new Int32Array(0);\n'+fn(read('src/audio_visual/renderer.js'),'computeVisibilityGridForPlayer'),c);
c.computeVisibilityGridForPlayer(0,light);
assert.equal(light[2][4],3);
c.units=[];
c.towers=[{type:'pistol',owner:0,energy:10,x:2.5*32,y:2.5*32,
    currentStats:{visionRange:.6},preComputedEffective:{visionRangeArea:2.4}}];
c.computeVisibilityGridForPlayer(0,light);
assert.equal(light[2][2],12);
assert.ok(light[6][6]>0,'effective range includes farther areas');
c.units=[{unitType:'norm',owner:0,energy:10,x:2.5*32,y:2.5*32,
    preComputed:{visionRangeArea:.6,attackRangeArea:.1},preComputedEffective:{visionRangeArea:2.4}}];
c.towers=[];
c.computeVisibilityGridForPlayer(0,light);
assert.equal(light[2][2],12,'grouped unit stamps its effective range');
assert.ok(light[6][6]>0,'grouped unit reveals farther areas');

Object.assign(c,{localPlayerId:0,renderRangeMode:4,renderRangeAllTeam:false,
    RENDER_RANGE_TURRETS:0,RENDER_RANGE_TURRETS_AND_UNITS:1,RENDER_RANGE_NONE:2,
    RENDER_RANGE_ALL:3,RENDER_RANGE_UNITS:4,RENDER_RANGE_BUILDINGS:5,
    _areaById:c.gridCellsByArea.map(cells=>({cells}))});
let now = 0;
c.Date = {now:()=>now};
vm.runInContext(read('src/audio_visual/range_overlay.js'),c);
const groupedOutline=c.getRenderRangeBoundary([],c.units);
assert.ok(groupedOutline.some(line=>line.x2===8),'unit outline uses effective vision, not base vision or attack range');
c.units[0].preComputedEffective.visionRangeArea=.6;
assert.ok(c.getRenderRangeBoundary([],c.units).some(line=>line.x2===8),
    'an area remains outlined briefly after its last source leaves');
now = 300;
c.units[0].preComputedEffective.visionRangeArea=2.4;
c.getRenderRangeBoundary([],c.units);
now = 400;
c.units[0].preComputedEffective.visionRangeArea=.6;
c.getRenderRangeBoundary([],c.units);
now = 1001;
assert.ok(c.getRenderRangeBoundary([],c.units).some(line=>line.x2===8),
    'returning to an area renews its hold when the unit leaves again');
now = 1401;
const ungroupedOutline=c.getRenderRangeBoundary([],c.units);
assert.ok(ungroupedOutline.every(line=>line.x1<=4&&line.x2<=4),'outline follows grouping range changes');

// Gameplay now releases immediately; the outline's hold remains visual only.
c.units=[{unitType:'norm',owner:0,energy:10,x:3.9*32,y:2.5*32,
    preComputedEffective:{visionRangeArea:.6}}];
c.computeVisibilityGridForPlayer(0,light);
assert.ok(light[2][2]>0);
c.units[0].x=4.31*32;
c.computeVisibilityGridForPlayer(0,light);
assert.equal(light[2][2],0,'gameplay drops coverage immediately after leaving the overlap');
console.log('PASS: border/corner overlap, effective ranges, immediate gameplay visibility and visual outline hold.');
