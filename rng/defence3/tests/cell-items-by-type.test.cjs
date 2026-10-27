'use strict';
const assert=require('node:assert/strict'),H=require('./net-harness.cjs');
const world=new H.World({controls:H.SMALL_MATCH_CONTROLS}),inst=world.spawn('type-journal',{simWorker:false});
const result=inst.eval(`(() => {
    // Exercise the real journal and type index against an independent grid
    // scan, including type swaps, repeated edits, no-op tiles and resets.
    GRID_W=64; GRID_H=64;
    grid=Array.from({length:GRID_H},()=>Array.from({length:GRID_W},()=>({item:null})));
    _activeTileEntities=new Set(); tileEntityIndexesReset();
    let seed=7919,id=0,checks=0;
    const rnd=n=>{seed=Math.imul(seed,1664525)+1013904223|0;return Math.floor((seed>>>0)/4294967296*n);};
    const types=['farm','astar_farm','house','research'];
    const key=e=>e.gy*GRID_W+e.gx;
    const scan=type=>{
        const out=[];
        for(let y=0;y<GRID_H;y++)for(let x=0;x<GRID_W;x++){
            const e=grid[y][x].item;
            if(e&&e.type===type&&_activeTileEntities.has(e))out.push(e);
        }
        return out;
    };
    for(let round=0;round<200;round++){
        const old=types.map(type=>_cellItemsOfType(type)),copies=old.map(x=>x.slice());
        for(let j=0,n=1+rnd(50);j<n;j++){
            const t=rnd(512),x=t%GRID_W,y=Math.floor(t/GRID_W),cell=grid[y][x];
            if(rnd(5)!==0){
                if(cell.item)_activeTileEntities.delete(cell.item);
                cell.item=rnd(4)?{gx:x,gy:y,type:types[rnd(types.length)],id:++id}:null;
                if(cell.item)_activeTileEntities.add(cell.item);
            }
            noteTileEntityChanged(x,y);
        }
        if(round===100){_activeTileEntities=new Set(_activeTileEntities);tileEntityIndexesReset();}
        for(let i=0;i<types.length;i++){
            const list=_cellItemsOfType(types[i]),expected=scan(types[i]);
            if(list.length!==expected.length||!list.every((e,j)=>e===expected[j]))throw Error('Index differs from grid: '+round+'/'+types[i]);
            if(old[i].length!==copies[i].length||!old[i].every((e,j)=>e===copies[i][j]))throw Error('Held list mutated');
            if(_cellItemsOfType(types[i])!==list)throw Error('Unchanged index lost identity');
            if(!list.every((e,j)=>j===0||key(list[j-1])<key(e)))throw Error('Unordered index');
            checks++;
        }
    }
    // A journaled ownership/metadata change must invalidate downstream
    // collector tables even when the entity reference stays the same.
    for(const type of types){
        const list=_cellItemsOfType(type),e=list[0];
        if(!e)throw Error('Fixture has no '+type);
        e.owner=1;
        noteTileEntityChanged(e.gx,e.gy);
        noteTileEntityChanged(63,63); // exercise the multi-tile batch path
        const next=_cellItemsOfType(type);
        if(next===list||next.length!==list.length||!next.every((x,j)=>x===list[j]))throw Error('Metadata invalidation lost');
    }
    return checks;
})()`);
assert.equal(result,800);
console.log('PASS: 800 type-index/grid comparisons, held lists, no-op reads, metadata invalidation and epoch reset');
