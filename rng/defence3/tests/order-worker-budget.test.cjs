'use strict';
// Worker move orders through the order queue's kernels (main.js
// _orderAdmit / _orderTake, wasm ord.rs): every selected worker gets the order
// once (the workers' order kernel, k_order_workers: their task let go,
// MANUAL_MOVE, moving to the order's tile); a small order (ORDER_NOW units or
// fewer) at once.
const assert=require('node:assert/strict'),H=require('./net-harness.cjs');
const world=new H.World({controls:{...H.SMALL_MATCH_CONTROLS,'cfg-mapsize':'64','cfg-map-type':'arena','cfg-max-pop':'20000'}});
const i=world.spawn('worker-order-budget',{simWorker:false});
const result=JSON.parse(i.eval(`JSON.stringify((()=>{
 startSoloGame();
 const ids=[];
 for(let k=0;k<240;k++){
   const u=new Unit('healer_unit',0,(5+k%20)*TILE+16,(5+Math.floor(k/20))*TILE+16);
   if(u.dead)throw Error('fixture');u.workerType='healer';u.workerState='IDLE';units.push(u);unitSlotMapPushed(u);updateUnitSpatial(u);ids.push(u.id);
 }
 resetOrderQueue();
 const run=(n,perTick)=>{
   _queueGroupMoveOrder(sanitizeAction({action:'move',unitIds:ids.slice(0,n),targetX:400,targetY:400}),0,CMD_MOVING);
   for(let tick=0;_orderQueue.length&&tick<20;tick++){const b=simOrderStats.units;runQueuedOrders();perTick.push(simOrderStats.units-b);currentTick++;}
   return ids.slice(0,n).filter(id=>{const u=getUnitById(id);return u&&u.workerState==='MANUAL_MOVE'&&u.commandState===CMD_MOVING&&u.targetPos&&u.workerTarget===null;});
 };
 const small=[],got=run(240,small);
 if(_orderQueue.length)throw Error('orders did not drain');
 return {ids,got,small,now:ORDER_NOW,steps:ORDER_DRAIN_STEPS};
})())`));
assert.deepEqual(result.got,result.ids,'every selected worker takes the order: MANUAL_MOVE, moving, its task let go');
assert.deepEqual(result.small,[240],'a small order applies at once');
assert.deepEqual(i.errors.map(String),[]);
console.log('PASS: worker orders through the queue kernels: every worker once, a small one at once');
