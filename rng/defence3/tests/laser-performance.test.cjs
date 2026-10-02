const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../src/things/unit.js'),'utf8');
const api=new Function(`let TILE=32,GRID_W=128,GRID_H=128,gameTime=0,pathTopologyVersion=0;
    ${source.slice(source.indexOf('const hostileStructureIndexes'),source.indexOf('// Preserve list order'))}
    return {query:getLaserStructureCandidates,tick:()=>gameTime++,rev:()=>pathTopologyVersion++};`)();
let seed=341;
const rand=n=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed%n;};
const list=Array.from({length:3000},(_,i)=>{
    const gx=rand(128),gy=rand(128);
    return {id:i%5?rand(200):undefined,gx,gy,x:gx*32+16,y:gy*32+16,owner:i%4,energy:20};
});
const hit=(b,sx,sy,ex,ey)=>sx===ex?Math.abs(b.x-sx)<18 && b.y>=Math.min(sy,ey) && b.y<=Math.max(sy,ey):Math.abs(b.y-sy)<18 && b.x>=Math.min(sx,ex) && b.x<=Math.max(sx,ex);
const reference=(list,...p)=>list.slice().sort((a,b)=>(a.id||0)-(b.id||0)).filter(b=>hit(b,...p));
let reads=0;
const beams=Array.from({length:1000},()=>{
    const x=rand(128)*32+16,y=rand(128)*32+16;
    return rand(2)?[x,y,Math.min(127*32+16,x+128),y]:[x,y,x,Math.min(127*32+16,y+128)];
});
for(const p of beams){const candidates=api.query(list,...p);reads+=candidates.length;assert.deepEqual(candidates.filter(b=>hit(b,...p)),reference(list,...p));}
assert.ok(reads<100000,'narrow beams do not rescan the complete building lists');
// Exact strict beam edge, endpoints, ties, and same-tick topology changes.
const edge=[{x:16,y:16,gx:0,gy:0},{x:34,y:16,gx:1,gy:0},{x:33.999,y:16,gx:1,gy:0},{x:16,y:80,gx:0,gy:2}];
assert.deepEqual(api.query(edge,16,16,16,80).filter(b=>hit(b,16,16,16,80)),reference(edge,16,16,16,80));
const p=beams[0];list[0]={id:-1,gx:Math.floor(p[0]/32),gy:Math.floor(p[1]/32),x:p[0],y:p[1]};api.rev();
assert.deepEqual(api.query(list,...p).filter(b=>hit(b,...p)),reference(list,...p));
list.splice(3,10);assert.deepEqual(api.query(list,...p).filter(b=>hit(b,...p)),reference(list,...p));
api.tick();list.reverse();assert.deepEqual(api.query(list,...p).filter(b=>hit(b,...p)),reference(list,...p));
// Exercise the real damage loop, including live deaths, resistant units,
// and stable ordering of id-less buildings in separate list classes.
const towerSource=fs.readFileSync(path.join(__dirname,'../src/things/tower.js'),'utf8');
const replay=new Function('exhaustive',`
    // (Tick 3: this laser's beam tick, see LASER_BEAM_TICKS.)
    let TILE=32,GRID_W=128,GRID_H=128,gameTime=3,pathTopologyVersion=1;
    ${source.slice(source.indexOf('const hostileStructureIndexes'),source.indexOf('// Preserve list order'))}
    ${towerSource}
    if(exhaustive)getLaserStructureCandidates=list=>list.slice().sort((a,b)=>(a.id||0)-(b.id||0));
    let events=[],towers=[],barracks=[],collectorSpawners=[];
    let tickStatusEffects=()=>{},thingStatusTickSelf=()=>{},playSound=()=>{},recordDamageVisual=()=>{},shrineDamageTaken=()=>{},createExplosion=()=>{},ensureLaserConnections=()=>{};
    let pushHostileDamageAlert=(b,d)=>events.push([b.key,d]);
    let tryAutoRetaliateOnHostileDamage=()=>{};
    let getUnitsInRange=()=>[{key:'immune',x:80,y:48,r:8,owner:1,energy:1,turretImmune:true},
        {key:'resistant',x:80,y:48,r:8,owner:1,energy:1,laserResistant:true},
        {key:'unit',x:90,y:48,r:8,owner:1,energy:.01,dead:false}];
    let destroyBuilding=b=>{events.push(['destroy',b.key]);for(const a of [towers,barracks,collectorSpawners]){const i=a.indexOf(b);if(i>=0)a.splice(i,1);}pathTopologyVersion++;};
    const make=(key,x,y,id,owner=1)=>({key,x,y,gx:Math.floor(x/32),gy:Math.floor(y/32),id,owner,energy:.01});
    towers=[make('tower-first',150,48),make('tower-tie',70,48),make('edge',100,66)];
    barracks=[make('b-high-id',120,48,3),make('b-low-id',80,48,1),make('own',90,48,0,0)];
    collectorSpawners=[make('spawner',80,48),make('outside',300,48)];
    const laser=Object.assign(Object.create(Tower.prototype),{key:'laser',type:'laser',owner:0,energy:10,gx:0,gy:1,x:16,y:48,currentStats:{damage:60},connectedLasers:[]});
    laser.connectedLasers.push({gx:6,gy:1,x:208,y:48,currentStats:{damage:60}});
    laser.update();laser.update();
    return {events,state:[towers,barracks,collectorSpawners].map(a=>a.map(b=>[b.key,b.energy])),laserState:laser.laserState};
`);
assert.deepEqual(replay(false),replay(true),'real laser damage, destruction and subsequent queries are identical');
if(process.argv.includes('--bench')) {
    const time=fn=>{const t=performance.now();for(const p of beams)fn(list,...p);return performance.now()-t;};
    for(let warm=0;warm<3;warm++){time(reference);time(api.query);}
    const results=[];
    for(let i=0;i<6;i++) {const r={};for(const k of i%2?['indexed','exhaustive']:['exhaustive','indexed'])r[k]=time(k==='indexed'?api.query:reference);results.push(r);}
    console.log(JSON.stringify({benchmark:'1000 beam scans / 2990 structures',results}));
}
console.log('PASS: 1000 laser rectangles match exhaustive stable damage order, strict edges, replacement/removal and tick reset; candidates '+reads+' / 3000000.');
