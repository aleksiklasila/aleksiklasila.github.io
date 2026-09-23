const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

// Real range helpers: fractional distances still contain the source area.
const rc = vm.createContext({ TILE:32, GRID_W:4, GRID_H:2, grid:[[]], localPlayerId:0,
    RENDER_RANGE_TURRETS:0, RENDER_RANGE_TURRETS_AND_UNITS:1, RENDER_RANGE_NONE:2,
    RENDER_RANGE_ALL:3, RENDER_RANGE_UNITS:4, RENDER_RANGE_BUILDINGS:5,
    renderRangeMode:0, renderRangeAllTeam:false, Tower:class Tower {},
    units:[], towers:[], barracks:[], collectorSpawners:[],
    getAreaIdAtWorld:x => x < 64 ? 0 : 1,
    getEntityVisibilityRangeArea:e => e.range, getUnitRenderActionRangeArea:e => e.range,
    getAreaIdsWithinDistance:(id, radius) => radius === 0 ? [id] : [0,1],
    _areaById:[{cells:[{x:0,y:0},{x:1,y:0},{x:0,y:1},{x:1,y:1}]},
        {cells:[{x:2,y:0},{x:3,y:0},{x:2,y:1},{x:3,y:1}]}] });
vm.runInContext(read('src/audio_visual/range_overlay.js'), rc);
const a=Object.assign(new rc.Tower(),{x:16,y:16,range:.6,owner:0,energy:10});
const b=Object.assign(new rc.Tower(),{x:80,y:16,range:.6,owner:0,energy:10});
let first=rc.getRenderRangeBoundary([a],[]);
assert.equal(first.length,4,'fractional turret range renders its source-area rectangle');
assert.equal(rc.getRenderRangeBoundary([a],[]),first,'static boundary is reused');
let union=rc.getRenderRangeBoundary([a,b],[]);
assert.equal(union.length,4,'adjacent ranges merge into a single outer rectangle');
assert.ok(!union.some(l=>l.x1===2 && l.x2===2),'internal border is removed');
rc.renderRangeMode=4;
assert.equal(rc.getRenderRangeBoundary([], [{...a,range:.1}]).length,4,'fractional unit ranges work');
rc.renderRangeMode=3; rc.renderRangeAllTeam=true; rc.towers=[a,b,{...a,owner:1}];
assert.equal(rc.getRenderRangeBoundary([],[]).length,4,'all-team ranges do not depend on selection');
rc.renderRangeMode=2;
assert.equal(rc.getRenderRangeBoundary([a],[]).length,0);
const dense=Array.from({length:10000},(_,i)=>({x:i%100,y:Math.floor(i/100)}));
assert.equal(rc.buildRangeBoundary(dense,100,100).length,4,'10,000 covered tiles become four lines');

// History is detached: unseen movement, deaths, building changes and effects
// cannot alter what was observed. Re-entering clears obsolete memories.
const hc=vm.createContext({TILE:32,GRID_W:3,GRID_H:1,localPlayerId:0,gameTime:1,visibilityVersion:1,
    fullVisibility:false,VISIBILITY_LIGHT_NORMALIZATION_RANGE:6,
    grid:[[{type:0,item:null},{type:0,item:{type:'farm',energy:20}},{type:0,item:null}]],
    visibilityGrid:[[6,6,0]],raw:[[6,6,0]], units:[], towers:[], barracks:[],collectorSpawners:[],goldMines:[],astarMines:[],droppedItems:[],projectiles:[],particles:[]});
hc.getRawVisibilityGridForPlayer=()=>hc.raw;
vm.runInContext(read('src/audio_visual/visibility_history.js')+'\nteamVisibilityHistory=true;',hc);
const enemy={id:5,x:48,y:16,prevX:47,prevY:16,energy:20,preComputed:{attackDamage:5},path:[{x:2,y:0}]};
hc.units=[enemy]; hc.updateVisibilityHistory();
const snapshot=JSON.stringify(enemy);
hc.gameTime++; hc.visibilityVersion++; hc.raw=[[6,0,0]]; hc.visibilityGrid=[[6,0,0]];
enemy.x=80; enemy.energy=0; enemy.preComputed.attackDamage=100;
hc.grid[0][1].item.energy=0; hc.projectiles=[{x:48,y:16}]; hc.updateVisibilityHistory();
let view=hc.getHistoryRenderView();
assert.equal(view.units.length,1); assert.equal(view.units[0].x,48);
assert.equal(view.units[0].energy,20); assert.equal(view.units[0].preComputed.attackDamage,5);
assert.equal(view.grid[0][1].item.energy,20); assert.equal(view.projectiles.length,0);
assert.equal(view.visibilityGrid[0][2],0,'unexplored tiles remain black');
assert.ok(view.visibilityGrid[0][1]>0 && view.visibilityGrid[0][1]<1,'history is dimmed');
assert.equal(hc.visibilityGrid[0][1],0,'gameplay visibility is untouched');
assert.equal(view.units[0].path,null,'history cannot reference live paths');
assert.equal(view.units[0].prevX,48,'remembered interpolation remains frozen');
hc.gameTime++;hc.visibilityVersion++;hc.raw=[[6,6,0]];hc.updateVisibilityHistory();
assert.equal(hc.getHistoryRenderView().units.length,0,'seeing an empty last-seen tile removes its ghost');
assert.equal(hc.getHistoryRenderView().grid[0][1].item.energy,0);
hc.localPlayerId=1;hc.raw=[[6,0,0]];hc.gameTime++;hc.visibilityVersion++;hc.updateVisibilityHistory();
assert.equal(hc.getHistoryRenderView().visibilityGrid[0][1],0,'changing team clears previous team knowledge');
hc.fullVisibility=true;
assert.equal(hc.getHistoryRenderView(),null,'full visibility bypasses memory');
hc.fullVisibility=false;
hc.document={createElement:()=>({getContext:()=>({fillRect(){},drawImage(){}})})};
const background=hc.getHistoryBackground({width:1024,height:1024});
assert.equal(hc.getHistoryBackground({width:512,height:512}),background,'changing source mip never reallocates history');
assert.equal(hc.getHistoryAudioGrid([[1,1,1]],'test')[0][1],0,'hidden audio does not animate history');

// Pushing is bounded and deterministic even at diagonal caps.
const uc=vm.createContext({TILE:32,UNIT_POSITION_QUANTIZATION:1024,gameTime:0});
vm.runInContext(read('src/things/unit.js'),uc);
let blocked=new Set(['1,0','0,1']);
uc.canUnitOccupyTile=(_u,x,y)=>!blocked.has(`${x},${y}`);
const make=()=>({x:31.5,y:31.5,isFlying:false,getCollisionRadius:()=>8});
let unit=make();uc.applyUnitSeparation(unit,1000,1000);
assert.equal(unit.x,31.5);assert.equal(unit.y,31.5,'cannot cross between two blocked corner tiles');
blocked.clear();unit=make();let peer=make();
for(let i=0;i<100;i++) {uc.applyUnitSeparation(unit,1000,800);uc.applyUnitSeparation(peer,1000,800);}
assert.deepEqual([unit.x,unit.y],[peer.x,peer.y],'identical pushes replay identically');
assert.ok(Math.hypot(unit.x-31.5,unit.y-31.5)<=1601,'crowd correction is capped at one contact diameter per update');
let flying=make();flying.isFlying=true;blocked.add('1,0');blocked.add('0,1');uc.applyUnitSeparation(flying,100,100);
assert.ok(flying.x>31.5,'air units retain their collision layer');

// Exercise the actual targeting branch; stop at its first unit visibility check.
const Unit=vm.runInContext('Unit',uc), seen=new Error('unit target selected');
let targets=[{id:4,owner:1,x:16,y:16},{id:3,owner:1,x:16,y:16},{id:1,owner:1,x:0,y:0,gx:9}];
uc.isGameplayTargetVisibleToPlayer=(_owner,x)=>x!==9;
uc.forEachUnitInRange=(_x,_y,_r,visit)=>targets.forEach(e=>visit(e,e.x*e.x+e.y*e.y));
assert.equal(uc._findNearbyCombatEnemy({owner:0,x:0,y:0},100).id,3);
targets.reverse();
assert.equal(uc._findNearbyCombatEnemy({owner:0,x:0,y:0},100).id,3,'retarget ties ignore spatial bucket order');
let enemyUnit={id:2,owner:1,x:16,y:16,dead:false};uc._findNearbyCombatEnemy=()=>enemyUnit;
uc.isGameplayTargetVisibleToPlayer=()=>{throw seen;};
let attacker=Object.assign(Object.create(Unit.prototype),{id:0,x:0,y:0,owner:0,
    preComputed:{visionRange:4},targetBuilding:{energy:10},targetUnit:null,forcedAttackTarget:false,path:[{}]});
assert.throws(()=>attacker.doAttacking(1),e=>e===seen);
assert.equal(attacker.targetUnit,enemyUnit);assert.equal(attacker.targetBuilding,null);
attacker.forcedAttackTarget=true;attacker.targetUnit=null;
uc._findNearbyCombatEnemy=()=>{throw Error('explicit orders must not retarget');};
attacker.doAttacking(1);

// Towers must not apply a pixel cutoff to units while using areas for buildings.
vm.runInContext(read('src/things/tower.js'),uc);
const Tower=vm.runInContext('Tower',uc);
uc.getTowerPreferredTargetInRange=()=>null;
uc.getAreaIdAtWorld=()=>0;uc.getAreaDistance=()=>0;
uc.forEachUnitInAreaRange=(_x,_y,_r,visit,opts)=>{assert.equal(opts.areaOnly,true);visit(enemyUnit);};
uc.WORLD_W=1000;uc.WORLD_H=1000;uc.getThingEffectiveLevel=()=>1;uc.secondsToTicks=()=>60;
uc.createExplosion=()=>{};uc.playSound=()=>{};uc.projectiles=[];
uc.Projectile=function(x,y,target){this.target=target;};
let tower=Object.assign(Object.create(Tower.prototype),{x:0,y:0,owner:0,cd:0,type:'pistol',currentStats:{attackRangeArea:.6,damage:10}});
tower.shoot();assert.equal(uc.projectiles[0].target,enemyUnit);
let explicitBuilding={x:80,y:80};uc.getTowerPreferredTargetInRange=()=>explicitBuilding;tower.cd=0;
tower.shoot();assert.equal(uc.projectiles[1].target,explicitBuilding,'explicit tower targets retain priority');

const sc=vm.createContext({});vm.runInContext(read('src/audio_visual/selection_overlay.js'),sc);
let entity={};sc.stabilizeSelectionPosition(entity,0,0,0);
let stable=sc.stabilizeSelectionPosition(entity,2,0,16);
assert.ok(stable.x>0 && stable.x<.5,'brief motion across merge thresholds is damped');
assert.equal(sc.stabilizeSelectionPosition(entity,200,0,32).x,200,'teleports do not drag stale outlines');

console.log('PASS: fractional/union/team ranges, 10k-tile perimeter, hidden-state isolation, team reset, bounded corner pushes, deterministic replay and automatic retargeting.');
