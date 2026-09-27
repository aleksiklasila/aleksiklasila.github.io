const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../src/audio_visual/renderer.js'),'utf8');
const start=source.indexOf('function get3DBoxSelection('),end=source.indexOf('\nfunction ',start+1);
const setup=new Function(`let TILE=32,localPlayerId=0,tickAlpha=.5,units=[],barracks=[],towers=[],collectorSpawners=[],goldMines=[],astarMines=[],items=[],grid=[];
    let reads=0,visible=(x,y)=>x%7!==0;
    const isTileVisible=(x,y)=>{reads++;return visible(x,y);};
    const get3DProjectionSnapshot=()=>({}),get3DVisibleWorldBounds=()=>({minGx:0,minGy:0,maxGx:119,maxGy:119});
    const renderer3dInstance={buildViewProjection(){},projectWorldToScreen:(x,y,z)=>({x:x*32,y:z*32-y*100}),boxRenderedSources:(x0,y0,x1,y1,pending)=>new Set([...pending].filter(e=>e.modelHit))};
    const getCellItemsRowMajor=()=>items;
    const findCellItemRowStart=(a,y)=>a.findIndex(e=>e.gy>=y)<0?a.length:a.findIndex(e=>e.gy>=y);
    ${source.slice(start,end)}
    return {run:get3DBoxSelection,reads:()=>reads,
        set(s){({units,barracks,towers,collectorSpawners,goldMines,astarMines,grid,items}=s);reads=0;}};
`);
let seed=713;const rand=n=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed%n;};
for(let trial=0;trial<40;trial++) {
    const api=setup(),grid=Array.from({length:120},()=>Array.from({length:120},()=>({owner:-1,item:null})));
    const make=(i,owner=0)=>{const gx=rand(118)+1,gy=rand(118)+1;return{id:i,gx,gy,x:gx*32+16,y:gy*32+16,owner,energy:i%9?10:0,modelHit:i%17===0};};
    const items=[];
    for(let i=0;i<400;i++){const e=make(i,i%4?0:1);if(grid[e.gy][e.gx].item)continue;items.push(e);grid[e.gy][e.gx]={item:e,owner:e.owner};}
    items.sort((a,b)=>a.gy-b.gy||a.gx-b.gx);
    const s={grid,items,barracks:items.slice(0,50),towers:[make(501),make(502,1)],collectorSpawners:items.slice(50,90),
        goldMines:[make(601)],astarMines:[make(602)],units:Array.from({length:100},(_,i)=>({...make(700+i,i%3?0:1),dead:i%11===0,prevX:10+i,prevY:20+i}))};
    api.set(s);
    const rect={sx:rand(1800),sy:rand(1800),ex:1800+rand(2000),ey:1800+rand(2000)};
    const hits=(e,x,y,lift)=>e.modelHit || (x>=rect.sx && x<=rect.ex && y-lift*100>=rect.sy && y-lift*100<=rect.ey);
    const expected={units:[],entities:[]},visible=(x,y)=>x%7!==0;
    for(const u of s.units){const x=(u.prevX+u.x)/2,y=(u.prevY+u.y)/2;if(!u.dead&&u.owner===0&&visible(Math.floor(x/32),Math.floor(y/32))&&hits(u,x,y,.28))expected.units.push(u);}
    const considered=new Set();
    for(const [list,lift] of [[s.barracks,.12],[s.towers,.18],[s.collectorSpawners,.14]])for(const e of list){if(e.energy>0&&e.owner===0&&visible(e.gx,e.gy)){considered.add(e);if(hits(e,e.x,e.y,lift))expected.entities.push(e);}}
    for(let gy=0;gy<120;gy++)for(let gx=0;gx<120;gx++){const c=grid[gy][gx],e=c.item;if(e&&c.owner===0&&!considered.has(e)&&visible(gx,gy)){considered.add(e);if(hits(e,e.x,e.y,.08))expected.entities.push(e);}}
    for(const e of [...s.goldMines,...s.astarMines])if(visible(e.gx,e.gy)&&hits(e,e.x,e.y,.06))expected.entities.push(e);
    assert.deepEqual(api.run(rect),expected,'indexed box matches exhaustive ground + model hits in original order');
    assert.ok(api.reads()<700,'sparse 120x120 map visits occupied tiles, not every cell');
    assert.equal(new Set(expected.entities).size,expected.entities.length);
}
console.log('PASS: 40 randomized 3D selections match exhaustive tile traversal, including model-only hits, interpolation, fog, mines and duplicate building representations.');
