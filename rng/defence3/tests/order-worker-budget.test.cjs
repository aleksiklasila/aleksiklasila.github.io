'use strict';
const assert=require('node:assert/strict'),H=require('./net-harness.cjs');
const world=new H.World({controls:{...H.SMALL_MATCH_CONTROLS,'cfg-mapsize':'64','cfg-map-type':'arena','cfg-max-pop':'20000'}});
const i=world.spawn('worker-order-budget',{simWorker:false});
const result=JSON.parse(i.eval(`JSON.stringify((()=>{
 startSoloGame();
 const ids=[];
 for(let k=0;k<240;k++){
   const u=new Unit('healer_unit',0,(5+k%20)*TILE+16,(5+Math.floor(k/20))*TILE+16);
   if(u.dead)throw Error('fixture');u.workerType='healer';u.workerState='IDLE';units.push(u);updateUnitSpatial(u);ids.push(u.id);
 }
 if(ids.some(id=>!_unitByIdMap().get(id).workerType))throw Error('expected workers');
 ORDER_KERNEL=true;ORDER_UNITS_PER_TICK_ALL=160;ORDER_UNITS_PER_PLAYER_TICK=160;ORDER_UNITS_PER_ROUND=40;
 resetOrderQueue();
 const applied=[],perTick=[];
 _issueGroupMoveOrder=function(a){for(const id of a.unitIds)applied.push(id);return a.unitIds.length;};
 _queueGroupMoveOrder(sanitizeAction({action:'move',unitIds:ids,targetX:400,targetY:400}),0,CMD_MOVING);
 for(let tick=0;_orderQueue.length&&tick<20;tick++){
   const before=applied.length;runQueuedOrders();perTick.push(applied.length-before);
   if(_orderAllLeft<0||_orderBudgetOf(0)<0)throw Error('worker batch overshot budget');
   currentTick++;_refillOrderBudget();
 }
 if(_orderQueue.length)throw Error('orders did not drain');
 return {ids,applied,perTick};
})())`));
assert.deepEqual(result.applied,result.ids,'all selected workers receive the order once, in order');
assert.deepEqual(result.perTick,[40,40,40,40,40,40],'slow work is bounded before dispatch');
assert.deepEqual(i.errors.map(String),[]);
console.log('PASS: worker orders stay within per-tick budgets and drain without losses');
