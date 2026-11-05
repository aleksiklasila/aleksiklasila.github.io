// Towers' turns are all kernels' (tower.rs k_tower_due, the prepare
// kernels, k_tower_fire): a preferred target (a structure; a unit by id,
// cleared when it falls) is shot before the nearest unit, a tower with
// custom stats shoots with them, and a step with no units left shoots
// structures.
'use strict';
const assert = require('node:assert/strict'), H = require('./net-harness.cjs');
const controls = { ...H.SMALL_MATCH_CONTROLS, 'cfg-mapsize': '64', 'cfg-map-type': 'arena', 'cfg-gold-count': '0', 'cfg-astar-mine-count': '0', 'cfg-max-pop': '20000', 'cfg-full-vis': 'full' };
const world = new H.World({ controls }), i = world.spawn('tower-kernel-cases', { controls, simWorker: false });
const result = JSON.parse(i.eval(`JSON.stringify((()=>{
 startSoloGame();gameTime=100;
 const put=(gx,gy,type,owner)=>{if(!placeBuilding(gx,gy,type,owner,{silent:true,ignorePlacementRules:true}))throw Error('place '+type);const t=getTileEntityRef(gx,gy);markConstructionComplete(t);t.energy=t.maxEnergy;structTableRefresh(t);return t;};
 const a=put(20,20,'pistol',0),b=put(20,26,'pistol',0),c=put(20,32,'pistol',0);
 const foe=put(21,20,'pistol',1);foe.energy=foe.maxEnergy=1e6;structTableRefresh(foe);
 put(50,50,'ice',1);
 const packed=()=>{const s=_stationaryStatsPrepare();return JSON.stringify([s.maxRange,Object.values(s.arrays).map(v=>Array.from(v))]);};
 const initialPack=packed(), initialVersion=_stationaryStats.version;
 if(!setPlayerThingBoost(0,'unit','norm','energy',1))throw Error('unit boost setup');
 if(packed()!==initialPack||_stationaryStats.version!==initialVersion)throw Error('unit boost invalidated building stat pack');
 if(!setPlayerThingBoost(0,'building','pistol','energy',1)||!setPlayerThingBoost(1,'building','ice','energy',2))throw Error('building boost setup');
 const changedPack=packed();
 if(changedPack===initialPack)throw Error('building boosts left packed stats unchanged');
 _stationaryStats.version=-1;
 if(packed()!==changedPack)throw Error('incremental tower stat pack differs from full rebuild');
 setPlayerThingBoost(0,'unit','norm','energy',0);
 setPlayerThingBoost(0,'building','pistol','energy',0);
 setPlayerThingBoost(1,'building','ice','energy',0);
 if(packed()!==initialPack)throw Error('clearing building boosts did not restore packed stats');
 const mk=(x,y)=>{const u=new Unit('tank',1,x*TILE+16,y*TILE+16);u.energy=u.maxEnergy=1e6;units.push(u);updateUnitSpatial(u);return u;};
 const ua=mk(19,20),ub=mk(19,26),uc=mk(19,32);
 recalculateAdjacency(true);
 // A preferred structure, a preferred unit, custom stats.
 a.preferredTargetSpec={type:'tower',gx:21,gy:20};
 processActions([{action:'towerTarget',towerCoords:[{gx:a.gx,gy:a.gy},{gx:c.gx,gy:c.gy}],target:{type:'tower',gx:foe.gx,gy:foe.gy}}],0);
 if(a.preferredTarget!==foe||c.preferredTargetSpec!==null)throw Error('structure order changed the existing-lock rule');
 const coords=[null,{gx:'20',gy:26},{gx:20.9,gy:26.1}];
 for(let k=1;k<ACTION_MAX_TOWER_COORDS;k++)coords.push({gx:-1,gy:-1});
 coords.push({gx:c.gx,gy:c.gy});
 processActions([{action:'towerTarget',towerCoords:coords,target:{type:'unit',id:ub.id}}],0);
 if(c.preferredTargetSpec||coords[2].gx!==20.9)throw Error('tower target cap or packet mutation');
 c.currentStats={...c.currentStats,damage:777};
 const brainBits=t=>(_ST.brain[t._stT]>>>24)&3;
 const bits0=[brainBits(a),brainBits(b),brainBits(c)];
 const foe0=foe.energy,ub0=ub.energy;let maxDmg=0;
 for(let k=0;k<90;k++){gameTick();projForEach((s,A)=>{if(A.dmg[s]>maxDmg)maxDmg=A.dmg[s];});}
 const out={bits0,foeLoss:foe0-foe.energy,ubLoss:ub0-ub.energy,maxDmg,specA:a.preferredTargetSpec,specB:b.preferredTargetSpec,targetA:a.preferredTarget===foe};
 // The preferred unit falls: the preference is cleared.
 ub.energy=0;ub.dead=true;
 for(let k=0;k<60;k++)gameTick();
 out.specBAfter=b.preferredTargetSpec;out.bitB=brainBits(b);
 return out;
})())`));
console.log(JSON.stringify(result));
assert.deepEqual(i.errors.map(String), []);
assert.deepEqual(result.bits0, [1, 1, 2], 'preference and custom bits in the descriptors');
assert.ok(result.foeLoss > 0, 'the preferred structure is shot though units stand nearer');
assert.ok(result.ubLoss > 0, 'the preferred unit is shot');
assert.equal(result.maxDmg, 777, 'custom stats shoot with their damage');
assert.deepEqual(result.specA, { type: 'tower', gx: 21, gy: 20 });
assert.equal(result.targetA, true);
assert.equal(result.specBAfter, null, 'a fallen preferred unit clears the preference');
assert.equal(result.bitB, 0);
console.log('PASS: preferred targets, custom stats: towers all in kernels');
process.exit(0);
