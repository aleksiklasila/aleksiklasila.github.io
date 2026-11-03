'use strict';
// Workload fixtures use the actual dropdowns, then the game's own budget.
const fs = require('node:fs'), path = require('node:path');
const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
let budgetContext;
function budget(population, teams, map) {
    const vm=require('node:vm');
    if(!budgetContext){
        const source=fs.readFileSync(path.join(__dirname,'../src/data/data_static.js'),'utf8');
        budgetContext=vm.createContext({});vm.runInContext(source.slice(0,source.indexOf('let TICK_RATE')),budgetContext);
    }
    const args=[population,teams,map*map].map(Number);
    if(args.some(n=>!Number.isFinite(n)))throw Error('Invalid budget inputs');
    return vm.runInContext(`(()=>{const p=memoryBudgetPop(${args});return{population:p,buildings:memoryBudgetBuildings(p,${args[1]},${args[2]})};})()`,budgetContext);
}
function choices(id) {
    const body = html.match(new RegExp('<select\\b[^>]*id="' + id + '"[^>]*>([\\s\\S]*?)</select>'))?.[1];
    if (!body) throw Error('Missing menu select: ' + id);
    return [...body.matchAll(/<option\b[^>]*value="([^"]+)"/g)].map(m => Number(m[1])).filter(Number.isFinite);
}
function pick(id, wanted) {
    const values = choices(id).sort((a, b) => a - b);
    return values.find(v => v >= wanted) ?? values.at(-1);
}
function settings(data, { population, map } = {}) {
    const lobby = data.lobby ||= {}, numbers = lobby.numbers ||= {}, selects = lobby.selects ||= {};
    const config = data.editableConfig?.config;
    const pop = pick('cfg-max-pop', population ?? numbers['cfg-max-pop'] ?? selects['cfg-max-pop'] ?? config?.CONFIG_MAX_POP ?? 131072);
    const size = pick('cfg-mapsize', map ?? selects['cfg-mapsize'] ?? numbers['cfg-mapsize'] ?? config?.GRID_W ?? 128);
    numbers['cfg-max-pop'] = pop; selects['cfg-mapsize'] = String(size);
    delete selects['cfg-max-pop']; delete numbers['cfg-mapsize']; delete numbers['cfg-max-buildings'];
    if (config) Object.assign(config, { CONFIG_MAX_POP: pop, CONFIG_MAX_BUILDINGS: 0, GRID_W: size, GRID_H: size });
    return { population: pop, map: size };
}
function controls(raw, options = {}) {
    const data = { lobby: { numbers: { 'cfg-max-pop': raw['cfg-max-pop'] }, selects: { 'cfg-mapsize': raw['cfg-mapsize'] } } };
    const selected = settings(data, options);
    const result = { ...raw, 'cfg-max-pop': String(selected.population), 'cfg-mapsize': String(selected.map) };
    delete result['cfg-max-buildings'];
    return result;
}
function scene(records, inst, { population } = {}) {
    const header = records[0], oldW = header.width, oldH = header.height;
    if (population === undefined) {
        const counts = new Map();
        for (const record of records) for (const u of record.units || []) counts.set(u[1], (counts.get(u[1]) || 0) + 1);
        population = Math.max(8, ...counts.values());
    }
    const selected = settings(header.settings, { population, map: Math.max(oldW, oldH) });
    if (selected.map < oldW || selected.map < oldH) throw Error('Scene exceeds the largest menu map');
    const teams = header.teams.length;
    const budget = inst.eval(`({population:memoryBudgetPop(${selected.population},${teams},${selected.map ** 2}),
        buildings:memoryBudgetBuildings(memoryBudgetPop(${selected.population},${teams},${selected.map ** 2}),${teams},${selected.map ** 2}),
        mines:memoryBudgetMines(memoryBudgetPop(${selected.population},${teams},${selected.map ** 2}),${teams},${selected.map ** 2})})`);
    settings(header.settings, { population: budget.population, map: selected.map });
    // Preserve the mix and ordering of each team's professions when reducing
    // historical exports, rather than keeping just their first unit types.
    const groups = new Map(), totals = new Map();
    for (const record of records) for (const u of record.units || []) {
        const key = u[1] + ':' + u[0]; groups.set(key, (groups.get(key) || 0) + 1); totals.set(u[1], (totals.get(u[1]) || 0) + 1);
    }
    const quotas = new Map(), used = new Map();
    for (const [owner, total] of totals) {
        const kingKey = owner + ':king', kings = groups.get(kingKey) || 0;
        quotas.set(kingKey, Math.min(kings, budget.population));
        let left = Math.min(total, budget.population) - quotas.get(kingKey), remaining = total - kings;
        for (const [key, count] of groups) if (key.startsWith(owner + ':') && key !== kingKey) {
            const n = Math.min(count, Math.round(count * left / remaining)); quotas.set(key, n); left -= n; remaining -= count;
        }
    }
    for (const record of records) if (record.units) record.units = record.units.filter(u => {
        const key = u[1] + ':' + u[0], n = used.get(key) || 0; used.set(key, n + 1); return n < quotas.get(key);
    });
    const mineCounts = new Map();
    for (const record of records) for (const m of record.mines || []) mineCounts.set(m[0], (mineCounts.get(m[0]) || 0) + 1);
    let mineRemaining = [...mineCounts.values()].reduce((a,b)=>a+b,0), mineSlots = Math.min(mineRemaining,budget.mines);
    const mineQuotas = new Map(), mineUsed = new Map();
    for (const [type,count] of mineCounts) {const n=Math.round(count*mineSlots/mineRemaining);mineQuotas.set(type,n);mineSlots-=n;mineRemaining-=count;}
    for (const record of records) if(record.mines)record.mines=record.mines.filter(m=>{const n=mineUsed.get(m[0])||0;mineUsed.set(m[0],n+1);return n<mineQuotas.get(m[0]);});
    const buildings = new Map();
    for (const record of records) for (const b of record.buildings || []) buildings.set(b[1], (buildings.get(b[1]) || 0) + 1);
    const removed = new Map();
    if ([...buildings.values()].some(n => n > budget.buildings)) {
        const groups = new Map(), quotas = new Map(), used = new Map();
        for (const record of records) for (const b of record.buildings || []) {const key=b[1]+':'+b[0];groups.set(key,(groups.get(key)||0)+1);}
        for (const [owner,total] of buildings) {
            let left=Math.min(total,budget.buildings),remaining=total;
            for (const [key,count] of groups) if(key.startsWith(owner+':')) {const n=Math.round(count*left/remaining);quotas.set(key,n);left-=n;remaining-=count;}
        }
        const wallTypes=new Set(inst.eval('Object.keys(BASE_CARD_TYPES).filter(k=>BASE_CARD_TYPES[k].target==="wall")'));
        for (const record of records) if(record.buildings)record.buildings=record.buildings.filter(b=>{
            const key=b[1]+':'+b[0],n=used.get(key)||0;used.set(key,n+1);
            if(n<quotas.get(key))return true;
            if(!removed.has(b[3]))removed.set(b[3],new Map());removed.get(b[3]).set(b[2],wallTypes.has(b[0]));return false;
        });
    }
    // Older exports used 1000/2000-square maps. Embed their unchanged world
    // in the next menu size, with a sealed unused border.
    let terrainRecord,y=0;
    for (const record of records) if (record.terrain) {
        terrainRecord = record;
        for(let i=0;i<record.terrain.length;i++,y++)if(removed.has(y)){
            const cells=removed.get(y),fixed=[];let x=0;
            for(let k=0;k<record.terrain[i].length;k+=4){const row=record.terrain[i];for(let j=0;j<row[k+3];j++,x++){
                const type=cells.get(x)?0:row[k],owner=cells.has(x)?-1:row[k+1],area=row[k+2],last=fixed.length-4;
                if(last>=0&&fixed[last]===type&&fixed[last+1]===owner&&fixed[last+2]===area)fixed[last+3]++;
                else fixed.push(type,owner,area,1);
            }}record.terrain[i]=fixed;
        }
        if (selected.map > oldW) for (const row of record.terrain) row.push(1, -1, -1, selected.map - oldW);
    }
    if (terrainRecord) for (let y = oldH; y < selected.map; y++) terrainRecord.terrain.push([1, -1, -1, selected.map]);
    header.width = header.height = selected.map;
    const end = records.find(r => r.end)?.end;
    if (end) for (const key of Object.keys(end)) end[key] = records.reduce((n, r) => n + (r[key]?.length || 0), 0);
    const limits = { requestedPopulation: selected.population, population: budget.population, map: selected.map, buildings: budget.buildings,
        originalUnits: [...totals.values()].reduce((a, b) => a + b, 0), units: [...quotas.values()].reduce((a, b) => a + b, 0),
        originalBuildings:[...buildings.values()].reduce((a,b)=>a+b,0),liveBuildings:records.reduce((n,r)=>n+(r.buildings?.length||0),0) };
    return limits;
}
module.exports = { choices, pick, budget, settings, controls, scene };
