// A single order into a resting crowd must meet pressure and displace neighbours.
'use strict';
const assert = require('node:assert/strict');
const H = require('./net-harness.cjs');
for(const dk of [1,20]) {
let freeProgress=0;
for (const crowded of [false,true]) {
    const world=new H.World({controls:{...H.SMALL_MATCH_CONTROLS,'cfg-mapsize':'60','cfg-map-type':'arena'}});
    const inst=world.spawn('entry'+crowded,{simWorker:false}); inst.eval('startSoloGame();');
    const result=JSON.parse(inst.eval(`JSON.stringify((()=>{
        for(const u of units) u.dead=true;
        gameTick();currentTick++;
        const cx=30*TILE+16,cy=30*TILE+16,crowd=[];
        if(${crowded}) for(let i=0;i<121;i++) {
            const u=new Unit('tank',0,cx+(i%11-5)*22,cy+(Math.floor(i/11)-5)*22);
            units.push(u);updateUnitSpatial(u);crowd.push(u);
        }
        for(let t=0;t<120;t++){gameTick();currentTick++;}
        const start=crowd.map(u=>[u.x,u.y]);
        const mover=new Unit('tank',0,cx-160,cy);units.push(mover);updateUnitSpatial(mover);
        processAction({action:'move',unitIds:[mover.id],targetX:cx,targetY:cy},0);
        simDk=${dk};
        let travel=0,deep=0,contacts=0,neighbourTravel=0;
        for(let t=0;t<240/simDk;t++) {
            const x=mover.x;gameTick();currentTick++;
            travel+=Math.max(0,mover.x-x);
            for(let i=0;i<crowd.length;i++) {
                const u=crowd[i],d=Math.hypot(u.x-mover.x,u.y-mover.y),r=u.r+mover.r;
                if(d<r) contacts++;
                if(d<r*.5) deep++;
            }
        }
        for(let i=0;i<crowd.length;i++)neighbourTravel+=Math.hypot(crowd[i].x-start[i][0],crowd[i].y-start[i][1]);
        return {progress:mover.x-(cx-160),travel,deep,contacts,neighbourTravel};
    })())`));
    console.log(20/dk+' TPS '+(crowded?'crowd':'free'),result);
    assert.deepEqual(inst.errors.map(String),[]);
    if(!crowded) freeProgress=result.progress;
    if(crowded) {
        assert.ok(result.deep<10,'incoming body must not walk through neighbours');
        assert.ok(result.progress < freeProgress*.5 || result.neighbourTravel>10, 'crowd blocks entry or makes room by pushing neighbours');
    }
}

}
