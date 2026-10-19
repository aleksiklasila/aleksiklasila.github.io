'use strict';
const fs=require('node:fs'),path=require('node:path');
const G=require('./generate-scenarios.cjs');
const ROOT=path.resolve(__dirname,'../scenarios');
const SIZE=G.SIZE;
const KINDS=['energy-mines','energy-farms','astar-mines','astar-farms','mixed-collection','salvage','heal-units-buildings','heal-production-queues','research','construction'];
let geometry;
function makeWorkScene(data,research) {
    const specs=data.levels.flatMap(level=>KINDS.map(kind=>({level,kind}))), columns=Math.ceil(Math.sqrt(specs.length)),rows=Math.ceil(specs.length/columns);
    const pitch=Math.floor((SIZE-8)/Math.max(rows,columns)),origin=20;
    const types=geometry?null:new Uint8Array(SIZE*SIZE),owners=geometry?null:new Int8Array(SIZE*SIZE).fill(-1);
    const buildings=[],units=[],mines=[],groups=[],levels={};
    const byId=new Map(data.catalog.map(t=>[t.id,t]));
    const profiles=data.profiles.filter(p=>p.research===research);
    for(const p of profiles) for(const t of data.catalog) Object.assign(levels,p.things[t.id].researchLevels);
    // Leave actual work available even in the R10 worker fixture. These target
    // stats are deliberately unreasearched; worker skills remain at the file R.
    const researchTargets=[['unit','norm','atk'],['unit','norm','energy'],['unit','norm','speed'],['building','house','maxEnergy'],['building','house','popCap']];
    for(const [kind,key,stat] of researchTargets) levels[[kind,key,stat].join(':')]=0;
    for(let index=0;index<specs.length;index++) {
        const spec=specs[index],p=profiles.find(p=>p.level===spec.level),x=origin+(index%columns)*pitch,y=origin+Math.floor(index/columns)*pitch;
        const before={buildings:buildings.length,units:units.length,mines:mines.length};
        const profile=id=>{if(!p.things[id])throw new Error('Missing work type '+id);return p.things[id];};
        function building(key,dx,dy,{salvage=false,damaged=false,construct=false,queue=false}={}) {
            const t=byId.get('building_'+key),s=profile(t.id);
            const work={markedForSalvage:salvage,queueEnabled:true,autoResearchEnabled:false};
            if(queue&&t.spawnedUnitType) work.spawnQueue=Array.from({length:3},()=>[t.spawnedUnitType,spec.level,0]);
            // maxEnergy is the actual stat at the file's R; the reserved house
            // target stat is R0, so use its unresearched profile value instead.
            const health=key==='house'?data.profiles.find(q=>q.level===spec.level&&q.research===0).things[t.id].stats.maxEnergy:s.stats.maxEnergy;
            buildings.push([key,0,x+dx,y+dy,s.stacks,construct?1:damaged?Math.max(1,health*.35):health,construct,null,null,false,true,work]);
            if(types&&t.target==='wall') types[(y+dy)*SIZE+x+dx]=1;
            if(owners) owners[(y+dy)*SIZE+x+dx]=0;
        }
        function unit(key,dx,dy,{damaged=false,hold=false}={}) {
            const s=profile('unit_'+key);
            const health=key==='norm'?data.profiles.find(q=>q.level===spec.level&&q.research===0).things['unit_norm'].stats.energy:s.stats.energy;
            units.push([key,0,x+dx+.5,y+dy+.5,damaged?Math.max(1,health*.3):health,spec.level,s.stacks,null,hold]);
        }
        function workers(key,n=24) {for(let i=0;i<n;i++) unit(key,1+(i%12)*2,1+Math.floor(i/12)*4);}
        function collection(resource,farm) {
            for(let dy=0;dy<9;dy++) for(let dx=0;dx<9;dx++) {
                if(dx%3===1&&dy%3===1) building(resource==='energy'?'spawner':'astar_spawner',dx*2,dy*2);
                else if(farm) building(resource==='energy'?'farm':'astar_farm',dx*2,dy*2);
                else mines.push([resource,x+dx*2,y+dy*2,1e12,1e12]);
            }
            workers(resource==='energy'?'collector':'astar_collector',40);
        }
        if(spec.kind==='energy-mines') collection('energy',false);
        else if(spec.kind==='energy-farms') collection('energy',true);
        else if(spec.kind==='astar-mines') collection('astar',false);
        else if(spec.kind==='astar-farms') collection('astar',true);
        else if(spec.kind==='mixed-collection') {
            for(let dy=0;dy<10;dy++) for(let dx=0;dx<10;dx++) {
                const resource=(dx+dy)%2?'energy':'astar';
                if(dx%3===1&&dy%3===1) building(resource==='energy'?'spawner':'astar_spawner',dx*2,dy*2);
                else if((dx+dy)%3===0) building(resource==='energy'?'farm':'astar_farm',dx*2,dy*2);
                else mines.push([resource,x+dx*2,y+dy*2,1e12,1e12]);
            }
            workers('collector',24);for(let i=0;i<24;i++)unit('astar_collector',14+i%8,22+Math.floor(i/8));
        } else {
            // Clouds are globally unique per owner, including unfinished clouds.
            // Include one set in L1 construction instead of repeating them in
            // each worker group (which cannot be loaded by the normal game).
            const allBuildings=data.catalog.filter(t=>t.kind==='building'&&(!t.key.startsWith('cloud_')||(spec.kind==='construction'&&spec.level===1)));
            const allUnits=data.catalog.filter(t=>t.kind==='unit');
            const producer=allBuildings.filter(t=>t.spawnedUnitType);
            if(spec.kind==='salvage') {
                allBuildings.forEach((t,i)=>building(t.key,(i%12)*2,Math.floor(i/12)*2,{salvage:true}));
                building('salvager',11,7);workers('salvager_unit');
            } else if(spec.kind==='heal-units-buildings') {
                allBuildings.forEach((t,i)=>building(t.key,(i%12)*2,Math.floor(i/12)*2,{damaged:true}));
                allUnits.forEach((t,i)=>unit(t.key,(i%10)*2,20+Math.floor(i/10)*2,{damaged:true,hold:true}));
                building('healer_spawner',11,7);for(let i=0;i<24;i++)unit('healer_unit',1+(i%12)*2,i<12?3:21);
            } else if(spec.kind==='heal-production-queues') {
                producer.forEach((t,i)=>building(t.key,(i%10)*2,Math.floor(i/10)*2,{queue:true}));
                building('healer_spawner',11,7);workers('healer_unit');
            } else if(spec.kind==='research') {
                building('research',8,8);for(let i=0;i<24;i++)unit('researcher_unit',6+i%6,5+Math.floor(i/6));
            } else if(spec.kind==='construction') {
                allBuildings.forEach((t,i)=>building(t.key,(i%12)*2,Math.floor(i/12)*2,{construct:true}));
                building('builder_spawner',11,7);workers('builder_unit');
            }
        }
        groups.push({index,row:Math.floor(index/columns)+1,column:index%columns+1,level:spec.level,kind:spec.kind,bounds:[x,y,x+36,y+30],counts:{buildings:buildings.length-before.buildings,units:units.length-before.units,mines:mines.length-before.mines}});
    }
    if(!geometry) {
        const areas=[],ids=new Int32Array(SIZE*SIZE).fill(-1);
        for(let by=0;by<SIZE;by+=3) for(let bx=0;bx<SIZE;bx+=3) for(const type of [0,1]) {
            const cells=[];
            for(let y=by;y<Math.min(SIZE,by+3);y++)for(let x=bx;x<Math.min(SIZE,bx+3);x++)if(types[y*SIZE+x]===type)cells.push({x,y});
            if(!cells.length)continue;
            const id=areas.length;for(const c of cells)ids[c.y*SIZE+c.x]=id;
            areas.push({id,type,cells,multiplierLevel:0,minGx:Math.min(...cells.map(c=>c.x)),minGy:Math.min(...cells.map(c=>c.y)),maxGx:Math.max(...cells.map(c=>c.x)),maxGy:Math.max(...cells.map(c=>c.y))});
        }
        const terrain=Array.from({length:SIZE},(_,y)=>{const row=[];for(let x=0;x<SIZE;x++){const k=y*SIZE+x,n=row.length;if(n&&row[n-4]===types[k]&&row[n-3]===owners[k]&&row[n-2]===ids[k])row[n-1]++;else row.push(types[k],owners[k],ids[k],1);}return row;});
        geometry={areas,terrain};
    }
    const researchOrders=researchTargets.flatMap(([kind,key,statKey])=>Array.from({length:data.maxResearch},()=>({kind,key,statKey,workDone:0})));
    const header={kind:'defence3-scene',version:1,createdAt:new Date().toISOString(),settings:data.settings,seed:20261019,width:SIZE,height:SIZE,teams:[0],teamColors:{0:'#4488ff'},player:0,camera:{x:origin+16,y:origin+16,zoom:.7},sourceTick:0,
        players:[{energy:1e15,astar:1e15,researchLevels:levels,researchOrders}]};
    const records=[header,{terrain:geometry.terrain},{areas:geometry.areas},{buildings},{units},{mines},{end:{terrain:SIZE,areas:geometry.areas.length,buildings:buildings.length,units:units.length,mines:mines.length}}];
    return {records,groups,layout:{columns,rows,pitch,originX:origin,originY:origin},researchTargets};
}
async function main() {
    const data=G.readGameData({work:true}),mp=path.join(ROOT,'manifest.json'),manifest=JSON.parse(fs.readFileSync(mp));
    manifest.scenarios=manifest.scenarios.filter(s=>s.kind!=='work'&&data.research.includes(s.research));
    manifest.researchLevels=data.research;
    for(const research of data.research) {
        const name='work-1-team-all-workers_R'+research,{records,groups,layout,researchTargets}=makeWorkScene(data,research);
        fs.writeFileSync(path.join(ROOT,name+'.json.gz'),G.compressScene(records));
        manifest.scenarios.push({kind:'work',name,file:name+'.json.gz',research,levels:data.levels,groups,layout,researchTargets,cloudCoverage:'One of each cloud in L1 construction; normal per-owner uniqueness prevents repetition.'});
        console.log('Generated '+name+' ('+unitsCount(records)+' units, '+groups.length+' groups)');
        await new Promise(resolve=>setImmediate(resolve));
    }
    fs.writeFileSync(mp,JSON.stringify(manifest,null,2)+'\n');
}
const unitsCount=records=>records.find(r=>r.units).units.length;
module.exports={makeWorkScene};
if(require.main===module)main().catch(e=>{console.error(e);process.exitCode=1;});
