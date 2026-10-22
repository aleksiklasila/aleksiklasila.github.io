'use strict';
const assert=require('node:assert/strict'),H=require('./net-harness.cjs');
for(const dk of [1,4,20]) {
// (A map with room: units cannot overlap on the occupancy raster, and one that is refused a place is dead.)
const world=new H.World({controls:{...H.SMALL_MATCH_CONTROLS,'cfg-mapsize':'200','cfg-map-type':'arena'}}),inst=world.spawn('collection'+dk,{simWorker:false});
const result=inst.eval(`(() => {
    startSoloGame();
    const old=[];
    simUnitStateReserve(8192);
    for(let i=0;i<8192;i++) {
        const u=new Unit('norm',0,400+(i%100)*14,400+Math.floor(i/100)*14);units.push(u);old.push(u);
    }
    simUnitStateCollect();
    const dead=old.filter((u,i)=>i%3===0), live=old.filter((u,i)=>i%3!==0);
    const before=dead.map(u=>[u.id,u.x,u.y,u.energy]);
    for(const u of dead)u.dead=true;
    for(let t=1;t<=64;t++){gameTime=t*${dk};simUnitStateCollect();}
    const detached=dead.every((u,i)=>!u._us&&u.dead&&u.id===before[i][0]&&u.x===before[i][1]&&u.y===before[i][2]&&u.energy===before[i][3]);
    const kept=live.every(u=>u._us&&!u.dead);
    simUnitStateReleaseFreed();
    for(let i=0;i<dead.length;i++){const u=new Unit('norm',1,200,200);units.push(u);}
    return {detached,kept,stale:dead.every((u,i)=>u.dead&&u.owner===0&&u.x===before[i][1])};
})()`);
assert.deepEqual(JSON.parse(JSON.stringify(result)),{detached:true,kept:true,stale:true});
}
console.log('PASS: block collection covers every dead slot in 64 steps at dk 1/4/20, preserves live units and stale references through reuse');
