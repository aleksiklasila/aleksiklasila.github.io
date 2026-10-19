'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const read=p=>fs.readFileSync(path.join(__dirname,'..',p),'utf8');
const c=vm.createContext({RESOURCE_COLLECTOR_UNIT_KEYS:[],TILE:32,GRID_W:20,gameTime:500,WORKER_AI_TICK_DELAY:3,CMD_MOVING:1,CMD_IDLE:0,
    simStepCrosses:()=>true,detHypot:Math.hypot,navProfileOf:()=>0,_nav:[{seq:2}],
    findNearestWalkable:(x,y)=>({x,y}),_navGoalRecheckTick:()=>510,
    _clearWorkerTarget:()=>{},clearWorkerTaskMemoryForFreeRetarget:()=>{}});
vm.runInContext(read('src/things/worker.js'),c);
c.clearWorkerTaskMemoryForFreeRetarget=()=>{}; c._clearWorkerTarget=()=>{};
const source=read('src/game/pathfinding.js');
vm.runInContext(source.slice(source.indexOf('function _tryUpgradeAstarFallbackPath('),source.indexOf('function _recordAstarUsage(')),c);
const make=()=>({id:1,x:48,y:48,owner:0,workerState:'MANUAL_MOVE',targetPos:{x:336,y:336},path:[],pathIndex:0,
    pathIsFallbackAstar:true,_pendingPathTarget:{gx:10,gy:10,cmd:1},_manualMoveIssuedTick:1});
c.navPathReach=()=>[{x:1,y:1},{x:10,y:10}];
const upgraded=make(); c.updateWorkerAI(upgraded);
assert.equal(upgraded._pendingPathTarget,null);
assert.equal(upgraded.path.length,2,'successful recovery keeps its new path');
assert.equal(upgraded.workerState,'MANUAL_MOVE','old order age does not cancel a successful upgrade');
c.navPathReach=()=>null; c.navPathSubstitute=()=>[];
const waiting=make(); c.updateWorkerAI(waiting);
assert.equal(waiting.workerState,'MANUAL_MOVE','unreachable navigation waits for a topology change');
assert.ok(waiting._pendingPathTarget.ver>0);
const timeout=make();timeout.pathIsFallbackAstar=false;c.updateWorkerAI(timeout);
assert.equal(timeout.workerState,'IDLE','unmanaged stale targets still expire');
console.log('PASS worker fallback: upgraded paths, unreachable waits, stale timeout');


