'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const c=vm.createContext({RESOURCE_COLLECTOR_UNIT_KEYS:[],TILE:32,CMD_IDLE:0,_thingTickX:t=>t.x,_thingTickY:t=>t.y});
vm.runInContext(fs.readFileSync('src/things/worker.js','utf8'),c);
for(const state of ['MOVING_TO','MOVING_TO_BUILD','MOVING_TO_HEAL','MOVING_TO_RESEARCH','RETURNING','RETURNING_ASTAR','RETURNING_FOR_GOLD']){
 const u={x:10.5*32,y:10.5*32,path:[{x:11,y:11}],pathIndex:0,workerState:state,workerTarget:{x:11.5*32,y:11.5*32},commandState:1,_pendingPathTarget:{gx:11,gy:11}};
 c.u=u;
 assert.equal(vm.runInContext('_workerFinishApproachInRange(u)',c),true,state);
 assert.equal(u.path.length,0);assert.equal(u.commandState,0);assert.equal(u._pendingPathTarget,null);
}
for(const [state,x,hold]of [['MANUAL_MOVE',10.5,false],['MOVING_TO_HEAL',6.5,false],['MOVING_TO_HEAL',10.5,true]]){
 c.u={x:x*32,y:10.5*32,path:[{x:11,y:11}],pathIndex:0,workerState:state,workerTarget:{gx:11,gy:11},holdPosition:hold};
 assert.equal(vm.runInContext('_workerFinishApproachInRange(u)',c),false);
 assert.equal(c.u.path.length,1);
}
console.log('PASS: occupied task endpoints finish at interaction range for every worker; distant, manual and held orders remain active');

const H=require('./net-harness.cjs'),world=new H.World({controls:{...H.SMALL_MATCH_CONTROLS,'cfg-mapsize':'64'}}),i=world.spawn('worker-interactions',{simWorker:false});
const r=i.eval(`(()=>{
 startSoloGame();
 const add=(type,x,y)=>{const u=new Unit(type,0,x*TILE,y*TILE);configureWorkerUnitFromType(u);applyUnitLevelScaling(u,1);units.push(u);unitSlotMapPushed(u);return u;};
 const worker=add('healer_unit',10.5,10.5),ally=add('norm',11.5,10.5);ally.energy=1;
 worker.workerState='MOVING_TO_HEAL';worker.workerTarget=ally;worker.workerTargetType='unit';worker.healerHasMaterial=true;
 worker.path=[{x:11,y:10}];worker.pathIndex=0;worker.commandState=CMD_MOVING;
 gameTime=(128-worker.id%128)%128;waiStepUnit(worker);
 const healed=ally.energy>1;
 const b=new Barrack(11,11,0,'norm');barracks.push(b);setTileEntity(11,11,'barrack',b);
 b.spawnQueue=[{unitType:'norm',level:1,energyPaid:0}];const front=getQueuedSpawnInfo(b.spawnQueue[0],'norm',1,0);b.spawnQueue[0]=front;
 worker.workerTransferCooldown=0;worker.workerState='MOVING_TO_HEAL';worker.workerTarget=b;worker.workerTargetType='queue';worker.healerHasMaterial=true;
 worker.path=[{x:11,y:11}];worker.pathIndex=0;worker.commandState=CMD_MOVING;waiStepUnit(worker);
 return {healed,paid:getQueuedSpawnInfo(b.spawnQueue[0],'norm',1,0).energyPaid};
})()`);
assert(r.healed,'healer works beside an occupied ally before path completion');assert(r.paid>0,'healer pays a queue beside its occupied endpoint');assert.deepEqual(i.errors,[]);
console.log('PASS: actual healer heals allies and pays production queues without entering their occupied endpoints');
