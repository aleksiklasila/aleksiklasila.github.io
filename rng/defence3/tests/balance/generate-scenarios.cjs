'use strict';
// Real game configuration/stat formulas; portable scenes, no combat substitutes.
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const H = require('../net-harness.cjs');
const SIZE = 2000, GROUP_SIZE = 36, COUNT = 100;
const geometryCache = new Map(), compressedGeometryCache = new WeakMap();

// One standard gzip member. Full-flush deflate boundaries let repeated map
// geometry be compressed once, while headers, research and armies stay unique.
function compressScene(records) {
    const areas = records[2].areas;
    let common=compressedGeometryCache.get(areas);
    if(!common) {
        const plain=Buffer.from(','+JSON.stringify(records[1])+','+JSON.stringify(records[2]));
        common={plain,compressed:zlib.deflateRawSync(plain,{level:6,finishFlush:zlib.constants.Z_FULL_FLUSH})};
        compressedGeometryCache.set(areas,common);
    }
    const prefix=Buffer.from('['+JSON.stringify(records[0]));
    const suffix=Buffer.from(','+records.slice(3).map(r=>JSON.stringify(r)).join(',')+']');
    const trailer=Buffer.alloc(8);
    trailer.writeUInt32LE(zlib.crc32(suffix,zlib.crc32(common.plain,zlib.crc32(prefix))),0);
    trailer.writeUInt32LE((prefix.length+common.plain.length+suffix.length)>>>0,4);
    return Buffer.concat([Buffer.from([31,139,8,0,0,0,0,0,0,3]),
        zlib.deflateRawSync(prefix,{level:6,finishFlush:zlib.constants.Z_FULL_FLUSH}),common.compressed,
        zlib.deflateRawSync(suffix,{level:6}),trailer]);
}

function layoutFor(count,groupSize=GROUP_SIZE,minimumGap=32) {
    const columns=Math.ceil(Math.sqrt(count)), rows=Math.ceil(count/columns);
    const pitch=Math.floor((SIZE-8)/Math.max(columns,rows));
    if(pitch<groupSize+minimumGap) throw new Error('Too many groups for the requested spacing.');
    return {columns,rows,pitch,clearGap:pitch-groupSize,groupSize,
        originX:Math.floor((SIZE-(columns-1)*pitch-groupSize)/2),
        originY:Math.floor((SIZE-(rows-1)*pitch-groupSize)/2)};
}

// A solid block makes its center unreachable to ground units. Open a two-tile
// entrance from the opposing army to the middle; place the displaced turrets
// behind the block so there are still exactly 100 and no special AI rules.
function turretPositions(owner) {
    const positions=[];
    for(let y=0;y<10;y++) for(let x=0;x<10;x++)
        if(!((y===4 || y===5) && (owner===0 ? x>=4 : x<=5))) positions.push([x,y]);
    for(let y=10;positions.length<COUNT;y++) for(let x=0;x<10 && positions.length<COUNT;x++) positions.push([x,y]);
    return positions;
}
const TURRET_POSITIONS=[turretPositions(0),turretPositions(1)];

function readGameData({work=false}={}) {
    const world = new H.World({ controls: { 'cfg-mapsize': '80', 'cfg-map-type': 'arena',
        'cfg-gamemode': 'destroy', 'cfg-full-vis': 'full' } });
    const inst = world.spawn('balance-config', { simWorker: false });
    inst.eval('startSoloGame()');
    const data = JSON.parse(inst.eval(`JSON.stringify((() => {
        const catalog = [];
        for (const [key, def] of Object.entries(BASE_UNIT_STATS)) if (${work} || (def.atk > 0 && key !== 'scout'))
            catalog.push({ id: 'unit_' + key, kind: 'unit', key, name: getUnitDisplayName(key),
                role: 'army', traits: Object.fromEntries(Object.entries(def).filter(([k,v]) => v === true)) });
        for (const [key, def] of Object.entries(BASE_CARD_TYPES)) {
            const stats = calculateItemStats(key, 1, 0);
            if (def.notBuildable || def.target==='area_upgrade' || (!${work} && (def.isCloud || def.unitType || key === 'watch_tower'))) continue;
            const damaging = ['damage','blastDamage','burnDps','poisonDps','freezeDps'].some(k => def[k] > 0 || stats[k] > 0);
            // Sand damage is provided by the floor kernel's formula, not its card.
            if (!${work} && !damaging && key !== 'sand') continue;
            catalog.push({ id: 'building_' + key, kind: 'building', key, name: def.name,
                role: key === 'laser' || def.target === 'floor' ? 'crossing' : 'army', traits: {},
                target:def.target,spawnedUnitType:getSpawnedUnitTypeForBuildingKey(key) || def.unitType || null });
        }
        const levels = Array.from({length:MAX_THING_LEVEL},(_,i)=>i+1), research = [0,5,10].filter(r=>r<=MAX_RESEARCH_LEVEL);
        const profiles = [];
        for (const r of research) {
            for (const p of players) {
                p.researchLevels = {}; p.researchMultipliers = {};
                for (const t of catalog) for (const s of getResearchStatEntriesForThing(t.kind,t.key)) {
                    const id = makeResearchLevelId(t.kind,t.key,s.statKey);
                    p.researchLevels[id] = r;
                    p.researchMultipliers[id] = detPow(getResearchBonusExpForStat(t.kind,s.statKey,t.key),r);
                }
            }
            rebuildPrecomputedStatsMapPlayer();
            for (const l of levels) {
                const things = {};
                for (const t of catalog) {
                    const stats = t.kind === 'unit'
                        ? Object.fromEntries(['energy','atk','attackRange','visionRange','atkCd','speed','astarCost','upKeep','gatherPerTrip','workerSearchDistance','builderDps','healerDps','researcherDps','transferCooldown'].map(k => [k,getUnitStatForOwner(0,t.key,l,k)]))
                        : { ...calculateItemStats(t.key,l,0) };
                    let researchEnergy = 0;
                    const researchLevels = {};
                    for (const s of getResearchStatEntriesForThing(t.kind,t.key)) {
                        researchLevels[makeResearchLevelId(t.kind,t.key,s.statKey)] = r;
                        for (let j=0;j<r;j++) researchEnergy += getResearchCost(t.kind,t.key,s.statKey,j);
                    }
                    things[t.id] = { stats, researchLevels, researchEnergy,
                        creationEnergyEach: t.kind === 'unit' ? Math.max(1,Math.floor(stats.energy)) : Math.floor(stats.maxEnergy),
                        creationAstarEach:0,movementAstarPerTileEach:t.kind === 'unit' ? stats.astarCost : 0,
                        upkeepPerSecondEach: stats.upKeep || 0, stacks: getRequiredStacksForLevel(l) };
                }
                profiles.push({ level:l, research:r, things });
            }
        }
        GRID_W = GRID_H = ${SIZE};
        document.getElementById('cfg-mapsize').value=String(GRID_W);
        const settings = createMainMenuSettingsSnapshot();
        settings.editableConfig = serializeEditableRuntimeConfigForTransport();
        return { catalog, levels, research, profiles, settings,
            floor:TYPE_FLOOR, wall:TYPE_WALL, maxLevel:MAX_THING_LEVEL, maxResearch:MAX_RESEARCH_LEVEL,
            anchorStats:{...calculateItemStats('house',1,0)} };
    })())`));
    if (inst.errors.length) throw new Error(inst.errors.join('\n'));
    return data;
}

function makeScene(data, focal, profiles, opponents = data.catalog.filter(t => focal.role === 'crossing' ? t.kind === 'unit' : t.role === 'army'), options = {}) {
    if(!Array.isArray(profiles)) profiles=[profiles];
    const specs=options.specs||profiles.flatMap(profile=>opponents.map(other=>({profile,other})));
    if(!specs.length)throw new Error('No matchups fit this scenario');
    const groupSize=options.groupSize||GROUP_SIZE;
    const layout=layoutFor(specs.length,groupSize,options.minimumGap??32);
    const geometryKey=options.geometryKey||JSON.stringify([focal.kind,focal.role,focal.key==='laser',profiles.length,opponents.map(t=>t.id)]);
    const cached=geometryCache.get(geometryKey);
    // Typed columns keep a 2000x2000 map from allocating four million arrays.
    const terrain = cached ? null : {types:new Uint8Array(SIZE*SIZE).fill(data.floor),
        owners:new Int8Array(SIZE*SIZE).fill(-1),ids:new Int32Array(SIZE*SIZE).fill(-1)};
    const buildings = [], units = [], arenas = [];
    let areas = cached ? cached.areas : [], runs=cached ? cached.runs : null;
    let profile;
    const researchLevels = [{},{}];
    const place = (t, owner, x, y, order) => {
        const p = profile.things[t.id];
        Object.assign(researchLevels[owner], p.researchLevels);
        if (t.kind === 'unit') units.push([t.key,owner,x+.5,y+.5,p.stats.energy,profile.level,p.stacks,order,false]);
        else {
            if(terrain) {
                terrain.owners[y*SIZE+x] = owner;
                if (t.role === 'army' || t.key === 'laser') terrain.types[y*SIZE+x] = data.wall;
            }
            buildings.push([t.key,owner,x,y,p.stacks,p.stats.maxEnergy,false,null,null,false,false]);
        }
    };
    specs.forEach((spec, index) => {
        profile=spec.profile;
        const other=spec.other;
        const x = layout.originX + index % layout.columns * layout.pitch;
        const y = layout.originY + Math.floor(index/layout.columns) * layout.pitch;
        const crossing = focal.role === 'crossing';
        const stationary = !crossing && focal.kind === 'building' && other.kind === 'building';
        const counts=spec.counts||(stationary?[98,98]:[COUNT,COUNT]);
        const bothMobile=focal.kind==='unit' && other.kind==='unit';
        const middle=spec.counts?29:17;
        const targets=crossing ? null : bothMobile ? [[x+middle,y+middle],[x+middle,y+middle]] : [
            focal.kind==='unit' ? [x+(spec.counts?44:27),y+middle] : null,
            other.kind==='unit' ? [x+(spec.counts?14:7),y+middle] : null];
        if(spec.counts) {
            // Equal-energy armies retain individual entities and the same arena
            // bounds. Unequal turret forces use the nearest checkerboard slots.
            const checker=owner=>{const slots=[];for(let dy=0;dy<56;dy++)for(let dx=0;dx<56;dx++)if((dx+dy)%2===owner)slots.push([dx+1,dy+1]);return slots.sort((a,b)=>((a[0]-28.5)**2+(a[1]-28.5)**2)-((b[0]-28.5)**2+(b[1]-28.5)**2)||a[1]-b[1]||a[0]-b[0]);};
            for(let owner=0;owner<2;owner++) {
                const t=owner?other:focal,n=counts[owner];
                let positions;
                if(stationary)positions=checker(owner);
                else if(!crossing&&t.kind==='building') {
                    const rows=Math.ceil((n+28)/28),centerRow=Math.floor(rows/2),raw=[];
                    for(let dy=0;raw.length<n;dy++)for(let dx=0;dx<28&&raw.length<n;dx++) {
                        if((dy===centerRow-1||dy===centerRow)&&(owner===0?dx>=13:dx<=14))continue;
                        raw.push([dx,dy]);
                    }
                    const top=29-centerRow;
                    positions=raw.map(([dx,dy])=>[(owner?30:1)+dx,top+dy]);
                } else if(!crossing) {
                    const top=Math.floor(29-Math.ceil(n/28)/2);
                    positions=Array.from({length:n},(_,i)=>[(owner?30:1)+i%28,top+Math.floor(i/28)]);
                } else if(owner===0) {
                    positions=Array.from({length:n},(_,i)=>focal.key==='laser'?[34+Math.floor(Math.floor(i/2)/28)*2,2+(Math.floor(i/2)%28)*3+(i%2)*2]:[34+i%28,2+Math.floor(i/28)]);
                } else {
                    positions=Array.from({length:n},(_,i)=>[1+i%28,2+Math.floor(i/28)*2]);
                }
                if(positions.length<n)throw new Error('Army exceeds formation capacity');
                for(let i=0;i<n;i++) {
                    const [dx,dy]=positions[i];
                    if(dx<0||dx>=groupSize||dy<0||dy>=groupSize)throw new Error('Army exceeds arena bounds');
                    const order=crossing?(owner?['move',x+groupSize-3,y+dy]:null):(targets[owner]?['attackMove',...targets[owner]]:null);
                    place(t,owner,x+dx,y+dy,order);
                }
            }
        } else for (let i=0;i<COUNT;i++) {
            if(stationary && i>=98) continue;
            if (crossing) {
                const row = Math.floor(i/10), col = i%10;
                if (focal.key === 'laser') {
                    // 50 pairs, each with one walkable beam tile even at L1.
                    const pair = Math.floor(i/2), lane = pair%10, gate = Math.floor(pair/10);
                    place(focal,0,x+16+gate*2,y+2+lane*3+(i%2)*2,null);
                    place(other,1,x+2+col,y+3+row*3,['move',x+33,y+3+row*3]);
                } else {
                    place(focal,0,x+16+col,y+3+row*3,null);
                    place(other,1,x+2+col,y+3+row*3,['move',x+33,y+3+row*3]);
                }
            } else {
                if(stationary) {
                    const row=Math.floor(i/7), col=2*(i%7);
                    place(focal,0,x+10+col+row%2,y+10+row,null);
                    place(other,1,x+10+col+1-row%2,y+10+row,null);
                } else {
                    const a=focal.kind==='building' ? TURRET_POSITIONS[0][i] : [i%10,Math.floor(i/10)];
                    const b=other.kind==='building' ? TURRET_POSITIONS[1][i] : [i%10,Math.floor(i/10)];
                    place(focal,0,x+2+a[0],y+12+a[1],targets[0] ? ['attackMove',...targets[0]] : null);
                    place(other,1,x+22+b[0],y+12+b[1],targets[1] ? ['attackMove',...targets[1]] : null);
                }
            }
        }
        arenas.push({ index, row:Math.floor(index/layout.columns)+1, column:index%layout.columns+1,
            level:profile.level,research:profile.research,rallyTargets:targets,
            bounds:[x,y,x+groupSize-1,y+groupSize-1], focal:focal.id, opponent:other.id, counts,
            ...(spec.accounting||{}),
            mode:crossing?'crossing':'combat',
            caveat:stationary&&spec.counts?'Unequal forces occupy alternating checkerboard slots, centered on the same target area.':!crossing && focal.kind === 'building' && other.kind === 'building'
                ? '14x14 alternating-team checkerboard: 98 turrets per team.' : null });
    });
    // Destroy Base counts buildings, not surviving units. Keep a noncombat
    // house for each team outside the matchup grids, otherwise a unit-only
    // team loses immediately and its army can be removed before it moves.
    // These are match-liveness fixtures, excluded from matchup costs/counts.
    const anchors=[{type:'house',owner:0,x:2,y:2},{type:'house',owner:1,x:SIZE-3,y:SIZE-3}];
    for(const a of anchors) {
        if(terrain) terrain.owners[a.y*SIZE+a.x]=a.owner;
        buildings.push([a.type,a.owner,a.x,a.y,1,data.anchorStats.maxEnergy,false,null,null,false,false]);
    }
    // Small real areas are essential: attacks and vision use the area graph.
    // Partition after tower placement so walls/floors never share an area.
    if(!cached) {
    for (let by=0;by<SIZE;by+=3) for (let bx=0;bx<SIZE;bx+=3) for (const type of [data.floor,data.wall]) {
        const cells=[];
        for(let y=by;y<Math.min(by+3,SIZE);y++) for(let x=bx;x<Math.min(bx+3,SIZE);x++)
            if(terrain.types[y*SIZE+x]===type) cells.push({x,y});
        if(!cells.length) continue;
        const id=areas.length;
        for(const c of cells) terrain.ids[c.y*SIZE+c.x]=id;
        areas.push({id,type,cells,multiplierLevel:0,minGx:Math.min(...cells.map(c=>c.x)),minGy:Math.min(...cells.map(c=>c.y)),maxGx:Math.max(...cells.map(c=>c.x)),maxGy:Math.max(...cells.map(c=>c.y))});
    }
    runs = Array.from({length:SIZE},(_,y) => {
        const out=[];
        for(let x=0;x<SIZE;x++) {
            const k=y*SIZE+x, type=terrain.types[k], owner=terrain.owners[k], area=terrain.ids[k];
            const n=out.length;
            if(n && out[n-4]===type && out[n-3]===owner && out[n-2]===area) out[n-1]++;
            else out.push(type,owner,area,1);
        }
        return out;
    });
    geometryCache.set(geometryKey,{runs,areas});
    if(geometryCache.size>2) geometryCache.delete(geometryCache.keys().next().value);
    }
    const header = { kind:'defence3-scene',version:1,createdAt:'2026-10-19T00:00:00.000Z',
        settings:data.settings,seed:20261019,width:SIZE,height:SIZE,teams:[0,1],
        teamColors:{0:'#4488ff',1:'#ff4444'},player:0,camera:{x:layout.originX+18,y:layout.originY+17,zoom:0.7},sourceTick:0,
        // Large finite reserve lets normal upkeep run. These are sandbox funds,
        // never counted as the cost of either army.
        players:researchLevels.map(researchLevels=>({energy:1e15,astar:1e15,researchLevels})) };
    const records=[header,{terrain:runs},{areas},{buildings},{units},
        {end:{terrain:SIZE,areas:areas.length,mines:0,buildings:buildings.length,units:units.length}}];
    return {records,arenas,layout,anchors};
}

async function main() {
    const out = path.resolve(__dirname,'../scenarios');
    fs.mkdirSync(out,{recursive:true});
    fs.mkdirSync(path.join(out,'equal_numbers'),{recursive:true});
    const manifestPath=path.join(out,'manifest.json');
    const priorManifest=fs.existsSync(manifestPath)?JSON.parse(fs.readFileSync(manifestPath)):{};
    const previous=priorManifest.scenarios||[];
    const data=readGameData();
    const manifest={version:2,countPerSide:COUNT,mapSize:SIZE,minimumClearGap:32,orderPolicy:'shared midpoint for units; reachable turret center for attackers',catalog:data.catalog,levels:data.levels,researchLevels:data.research,profiles:data.profiles,scenarios:[]};
    if(priorManifest.equalEnergy)manifest.equalEnergy=priorManifest.equalEnergy;
    let totalBytes=0;
    for(const research of data.research) {
        const profiles=data.profiles.filter(p=>p.research===research);
        for(const focal of data.catalog) {
            const name=`fight-2-teams-${focal.id}_R${research}`;
            const {records,arenas,layout,anchors}=makeScene(data,focal,profiles);
            // Same gzip JSON array as the main menu's compressed export.
            const bytes=compressScene(records);
            const file='equal_numbers/'+name+'.json.gz';
            fs.writeFileSync(path.join(out,file),bytes); totalBytes+=bytes.length;
            manifest.scenarios.push({kind:'fight',balanceMode:'equal-numbers',name,file,levels:data.levels,research,focal:focal.id,layout,anchors,arenas});
        }
        console.log(`Generated R${research}: ${data.catalog.length} snapshots, all L1–L${data.maxLevel}`);
        await new Promise(resolve=>setImmediate(resolve));
    }
    manifest.scenarios.push(...previous.filter(s=>data.research.includes(s.research)&&(s.kind==='work'||(s.balanceMode==='equal-energy'&&data.catalog.some(t=>t.id===s.focal)))));
    fs.writeFileSync(manifestPath,JSON.stringify(manifest,null,2)+'\n');
    // Retire only old generator-owned files listed in the previous manifest.
    // Keep unrelated snapshots and never recurse or leave the scenarios folder.
    const currentFiles=new Set(manifest.scenarios.map(s=>path.resolve(out,s.file)));
    const root=path.resolve(out)+path.sep;
    for(const old of previous) {
        const file=path.resolve(out,old.file);
        if(!file.startsWith(root) || !/^(?:(unit|building)_[a-z0-9_]+_L\d+_R\d+|fight-2-teams-(?:equal-energy-)?(?:unit|building)_[a-z0-9_]+_R\d+)\.json\.gz$/.test(path.basename(file))) continue;
        if(!currentFiles.has(file) && fs.existsSync(file)) fs.unlinkSync(file);
    }
    const order=['# Pair order','','Each file includes L1–L'+data.maxLevel+'. Read left to right, then top to bottom.',
        'For each level, opponents appear in the order below; then the next level starts.',
        'The grid continues across row boundaries. Exact row, column and destinations are in manifest.json.',
        '','| File kind | Columns | Rows | Origin spacing | Clear gap |','|---|---|---|---|---|'];
    for(const role of ['army','crossing']) {
        const sample=manifest.scenarios.find(s=>data.catalog.find(t=>t.id===s.focal).role===role), l=sample.layout;
        order.push(`| ${role} | ${l.columns} | ${l.rows} | ${l.pitch} tiles | ${l.clearGap} tiles |`);
    }
    order.push('','| Opponent order within each level | Opponent |','|---|---|');
    data.catalog.filter(t=>t.role==='army').forEach((t,i)=>order.push(`| ${i+1} | ${t.name} (${t.id}) |`));
    order.push('','Crossing maps use only the unit entries above, in the same order.','');
    fs.writeFileSync(path.join(out,'pair-order.md'),order.join('\n'));
    console.log(`${manifest.scenarios.length} snapshots; ${(totalBytes/1048576).toFixed(1)} MiB compressed. See tests/balance/README.md.`);
}
module.exports={readGameData,makeScene,compressScene,layoutFor,SIZE,COUNT};
if(require.main===module) main().catch(e=>{console.error(e);process.exitCode=1;});
