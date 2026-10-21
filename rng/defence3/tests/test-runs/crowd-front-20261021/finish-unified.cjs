const fs=require('fs'),p='src/data/data_static.js';let s=fs.readFileSync(p,'utf8');
const start=s.indexOf('const THING_STATS = {'),end=s.indexOf('\n};',start)+3;
// Read plain-data definitions without loading the game.
const vm=require('vm'),ctx={};vm.runInNewContext(s.slice(start,end)+';this.things=THING_STATS',ctx);
for(const [key,t]of Object.entries(ctx.things)){
 if(t.kind==='unit')for(const [stat,d]of Object.entries(t.stats)){
  if(stat==='energy'){d.min=1;d.round='floor';}
  if(stat==='atk')d.min=0;
  if(stat==='atkCd')d.min=.01;
  if(stat==='speed')d.min=.1;
  if(stat==='visionRange')d.min=.05;
  if(['attackRange','watchDuration'].includes(stat))d.min=0;
  if(['astarCost','upKeep'].includes(stat))d.min=.01;
  if(stat==='workerSearchDistance')d.min=t.isWorker?.2:0;
  if(stat==='transferCooldown')d.min=t.isWorker?.01:0;
  if(['builderDps','healerDps','researcherDps'].includes(stat)&&d.base>0){d.min=1;d.round='round';}
  if(stat==='gatherPerTrip'&&d.base>0)d.min=1;
 }
 if(t.kind==='building'&&t.stats.attackRange?.base>0)t.stats.attackRange.researchable=true;
 // Clear outliers from the role audit: fast remains fragile but dangerous up close;
 // SMG trades health/reach/cost for real throughput; poison's old sustained damage dwarfed peers.
 if(key==='fast')t.stats.atk.base=4;
 if(key==='smg')t.stats.damage.base=6;
 if(key==='poison')t.stats.poisonDps.base=12;
 const roles={
 norm:['Affordable frontline damage','Melee reach and ordinary mobility'],fast:['Fast worker raider with high close-range damage','Low health and melee reach'],tank:['Durable frontline anchor','Slow, short reach and low damage for its cost'],boss:['Heavy frontline health and damage','Very slow, costly and slow to train'],flying:['Flies over buildings to raid workers','Low health and slower attacks than melee'],mole:['Turret immunity enables attacks on defenses','Very low health; ground hazards and melee defenders counter it'],poison_resistant:['Poison immunity and ranged pressure','Moderate health, speed and slow attacks'],fire_resistant:['Fire immunity and sturdy mid-range pressure','Slow movement and shorter reach than ranged specialists'],water_resistant:['Water immunity, speed and long reach','Low health and slow attacks'],ice_resistant:['Ice immunity and reliable mid-range damage','Slow movement and limited reach'],laser_resistant:['Laser immunity and long reach','Low health, slow attacks and modest speed'],snake:['Durable charging melee attacker','Very expensive, slow to train and cannot retaliate at range'],scout:['Fast flying scout with the longest unit reach and Watch','Very low health and damage'],king:['Durable command unit with solid melee damage','Limited melee reach'],
 pistol:['Cheap dependable direct fire','Short reach and low health'],smg:['Higher direct-fire throughput at close range','Shorter reach and less health than Pistol'],water:['Wet enables freeze combinations','Modest direct damage and short reach'],poison:['Strong sustained poison damage','Low direct damage; poison-resistant units counter it'],fire:['Splash and burn punish packed groups','Long cooldown, short reach and fire-resistant counters'],sand_gun:['Long-range slowing helps hold a front','Very low damage and long cooldown'],ice:['High damage and freeze control','Expensive; ice-resistant units counter it'],sniper:['Very long reach and heavy single-target hits','Very long cooldown, high price and fragile for its cost'],elements:['Flexible mixed status support','Very low direct damage and modest health'],laser:['Very high damage along linked beams','Requires alignment; laser-resistant units counter it'],watch_tower:['Extreme reach and Watch support','Very low damage and health'],
 };
 const workerRole=key.includes('collector')?['Harvests '+(t.resourceKey||'resources'),'Unarmed and vulnerable to raiders']:key==='builder_unit'?['Builds and repairs structures','Unarmed; requires access to worksites']:key==='healer_unit'?['Flying healing and queue support','Unarmed and fragile']:key==='researcher_unit'?['Flying research worker','Unarmed and fragile']:key==='salvager_unit'?['Recovers value from structures','Unarmed and slow']:null;
 const generic=t.spawns?['Produces '+t.spawns,'Needs time, resources and protection from raiders']:t.isCloud?['Paired transport across obstacles','Requires both endpoints and sustained upkeep']:key==='house'?['Raises population capacity','No direct combat power; vulnerable infrastructure']:key==='research'?['Produces researchers and enables upgrades','Needs workers, time and protection']:key==='shrine'?['Recovers resources from losses','Recovery depends on taking losses']:key.includes('farm')?['Renewable resources close to base','Needs collectors and protection']:t.target==='floor'?['Ground area denial','Immobile; flying units bypass it']:['Improves territory','No direct combat damage'];
 const [strength,weakness]=roles[key]||workerRole||generic;t.strength=strength;t.weakness=weakness;
}
const fmt=v=>JSON.stringify(v).replace(/"([a-zA-Z][a-zA-Z0-9]*)":/g,'$1: ').replace(/,/g,', ');
s=s.slice(0,start)+'const THING_STATS = {\n'+Object.entries(ctx.things).map(([key,{stats,...meta}])=>'    '+key+': { '+Object.entries(meta).map(([k,v])=>k+': '+JSON.stringify(v)).join(', ')+',\n        stats: {\n'+Object.entries(stats).map(([stat,d])=>'            '+stat+': '+fmt(d)+',').join('\n')+'\n        }\n    },').join('\n')+'\n};'+s.slice(end);
fs.writeFileSync(p+'.new',s);fs.renameSync(p+'.new',p);
const dyn='src/data/data_dynamic.js';s=fs.readFileSync(dyn,'utf8');const a=s.indexOf('function getUnitStatFallbackValue'),b=s.indexOf('// This evaluator runs',a);
s=s.slice(0,a)+`function getUnitStatFallbackValue(unitType, statKey) {
    const value = getThingStatBase(unitType,statKey);
    return Number.isFinite(value) ? value : 0;
}
function normalizePrecomputedUnitStatValue(unitType, statKey, value) {
    const rule = THING_STATS[unitType]?.stats[statKey];
    if (!Number.isFinite(value)) value = getUnitStatFallbackValue(unitType,statKey);
    if (rule?.round === 'floor') value = Math.floor(value);
    if (rule?.round === 'round') value = Math.round(value);
    return clampThingStatValue(unitType,statKey,value);
}

`+s.slice(b);
fs.writeFileSync(dyn+'.new',s);fs.renameSync(dyn+'.new',dyn);
