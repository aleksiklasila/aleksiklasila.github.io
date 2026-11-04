'use strict';
const assert=require('node:assert/strict'),H=require('./net-harness.cjs');
const world=new H.World({controls:{...H.SMALL_MATCH_CONTROLS,'cfg-mapsize':'96','cfg-map-type':'arena'}});
const inst=world.spawn('structure-list-reuse',{simWorker:false});
inst.eval('startSoloGame();');
const result=inst.eval(`(() => {
    let checks=0;
    const saved=[structListView(0),structListView(1),structListView(2)];
    const check=()=>{
        const want=[[],[],[]];
        for(let gy=0;gy<GRID_H;gy++)for(let gx=0;gx<GRID_W;gx++){
            const e=getTileEntityRef(gx,gy);if(!e)continue;
            const k=e instanceof Tower?0:e instanceof Barrack?1:isSpawnerEntity(e)?2:-1;
            if(k>=0)want[k].push(e);
        }
        for(let k=0;k<3;k++){
            const actual=structListView(k);
            if(actual!==saved[k]||actual.length!==want[k].length||want[k].some((e,j)=>e!==actual[j]))throw Error('list membership/order/identity '+k+' check '+checks);
        }checks++;
    };
    const tiles=[];
    for(let gy=4;gy<GRID_H-4&&tiles.length<12;gy++)for(let gx=4;gx<GRID_W-4&&tiles.length<12;gx++)
        if(grid[gy][gx].type===TYPE_FLOOR&&!grid[gy][gx].item&&!getTileEntityRef(gx,gy))tiles.push([gx,gy]);
    if(tiles.length<12)throw Error('not enough placement tiles');
    const kinds=['pistol','barrack_norm','research'];
    check();
    for(let j=0;j<tiles.length;j++){
        const [gx,gy]=tiles[j];
        if(!placeBuilding(gx,gy,kinds[j%3],j%2,{ignorePlacementRules:true,silent:true,autoUpgradeEnabled:false,buildEnabled:true}))throw Error('placement');
        check();
    }
    // Refill at the same lengths with different row objects, then shrink
    // each list repeatedly. No old tail object may remain visible.
    for(let j=tiles.length-1;j>=0;j--){
        const [gx,gy]=tiles[j];destroyBuilding(getTileEntityRef(gx,gy));
        if(j%2===0){if(!placeBuilding(gx,gy,kinds[j%3],1,{ignorePlacementRules:true,silent:true,autoUpgradeEnabled:false,buildEnabled:true}))throw Error('replacement');check();destroyBuilding(getTileEntityRef(gx,gy));}
        check();
    }
    return {checks};
})()`);
assert.ok(result.checks>=30);
assert.deepEqual(inst.errors.map(String),[]);
console.log('PASS: reused structure lists retain tile order and exact membership through placement, same-size replacement and shrinking',result);
