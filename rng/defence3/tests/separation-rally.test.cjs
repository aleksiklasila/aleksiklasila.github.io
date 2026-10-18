// Reissuing the same rally must not compress a crowd indefinitely.
'use strict';
const assert = require('node:assert/strict');
const H = require('./net-harness.cjs');
for (const dk of [1, 20]) {
    const world = new H.World({ controls: { ...H.SMALL_MATCH_CONTROLS, 'cfg-mapsize': '60', 'cfg-map-type': 'arena' } });
    const inst = world.spawn('rally' + dk, { simWorker: false });
    inst.eval('startSoloGame();');
    const result = JSON.parse(inst.eval(`JSON.stringify((() => {
        for (const u of units) u.dead = true;
        gameTick(); currentTick++;
        const crowd = [], cx = 30*TILE+16, cy = 30*TILE+16;
        for (let i=0; i<120; i++) {
            const p = findNearestWalkable(26+i%10, 25+Math.floor(i/10));
            const u = new Unit(['norm','fast','tank'][i%3], 0, p.x*TILE+16, p.y*TILE+16);
            units.push(u); updateUnitSpatial(u); crowd.push(u);
        }
        simDk = ${dk};
        let overlap=0, pairs=0, deep=0, samples=0;
        const radii=[], streak=new Uint16Array(crowd.length*crowd.length); let maxDeepTicks=0;
        for(let t=0; t<1200/simDk; t++) {
            if(t%Math.max(1,Math.round(5/simDk))===0)
                processAction({action:'move',unitIds:crowd.map(u=>u.id),targetX:cx,targetY:cy},0);
            gameTick(); currentTick++;
            if(t<400/simDk) continue;
            let radius=0;
            for(let i=0;i<crowd.length;i++) {
                const a=crowd[i]; radius+=Math.hypot(a.x-cx,a.y-cy);
                for(let j=0;j<i;j++) {
                    const b=crowd[j], want=a.r+b.r, d=Math.hypot(a.x-b.x,a.y-b.y);
                    if(d<want) { overlap+=(want-d)/want; pairs++; }
                    const k=i*crowd.length+j;
                    streak[k]=d<want*.5 ? streak[k]+simDk : 0;
                    maxDeepTicks=Math.max(maxDeepTicks,streak[k]);
                    if(d<want*.5) deep++;
                }
            }
            samples++; radii.push(radius/crowd.length);
        }
        const mean=a=>a.reduce((x,y)=>x+y,0)/a.length;
        return {maxDeepTicks,penetration:overlap/Math.max(1,pairs),deepPairsPerFrame:deep/samples,
            earlyRadius:mean(radii.slice(0,radii.length/2)),lateRadius:mean(radii.slice(radii.length/2))};
    })())`));
    console.log(20/dk+' TPS repeated rally:',result);
    assert.deepEqual(inst.errors.map(String), []);
    assert.ok(result.penetration < (dk===1?.2:.4), 'pressure resists sustained inward orders');
    if(dk===1) assert.ok(result.deepPairsPerFrame < 5, 'rally does not produce a deeply overlapping pile');
    assert.ok(result.maxDeepTicks < 80, 'coarse steps do not leave pairs deeply overlapping for four seconds');
    assert.ok(result.lateRadius > result.earlyRadius*.9, 'continued orders do not keep shrinking the crowd');
}

