'use strict';
const fs=require('node:fs'),path=require('node:path');
const ratio=(a,b)=>b>0?a/b:null;
const fmt=n=>n==null?'—':Math.abs(n)>=1e6?n.toExponential(2):Number(n).toLocaleString('en-US',{maximumFractionDigits:2});
function buildReport(manifest,results,out) {
    fs.mkdirSync(out,{recursive:true});
    const rows=[],byThing=new Map(),coverage=new Map();
    const allowed=new Set(manifest.catalog.map(t=>t.id));
    for(const result of results) for(const a of result.arenas) {
        if(!allowed.has(a.focal)||!allowed.has(a.opponent))continue;
        const profile=manifest.profiles.find(p=>p.level===a.level&&p.research===a.research);
        const sides=a.sides.map((s,i)=>{
            const id=i===0?a.focal:a.opponent,p=profile.things[id];
            const creationEnergy=a.counts[i]*p.creationEnergyEach;
            const healthEnergyLost=Math.max(0,s.hpInitial-s.hpRemaining);
            const upkeepEnergy=s.upkeepEnergyExposure||0;
            return {...s,id,creationEnergy,researchEnergy:p.researchEnergy,
                healthEnergyLost,healthEnergyLossFraction:Math.min(1,healthEnergyLost/Math.max(1,s.hpInitial)),upkeepEnergy,damagePlusUpkeepEnergy:healthEnergyLost+upkeepEnergy,
                destroyedCapitalEnergy:(a.counts[i]-s.alive)*p.creationEnergyEach,
                totalInvestmentEnergy:creationEnergy+p.researchEnergy+upkeepEnergy,
                movementAstarPerTile:p.movementAstarPerTileEach??p.creationAstarEach,
                astarApproximate:a.astarEstimate?.[i]??null,astarDirectlyAttributed:a.astar?.[i]??null,
                traits:manifest.catalog.find(t=>t.id===id).traits};
        });
        const [a0,a1]=sides,sum=a0.healthEnergyLost+a1.healthEnergyLost;
        // Percent depletion handles very different health pools: a small chip
        // on a huge tower army must not rank like the elimination of a force.
        const healthEnergyTradeAdvantage=a1.healthEnergyLossFraction-a0.healthEnergyLossFraction;
        const upkeepSum=a0.upkeepEnergy+a1.upkeepEnergy;
        const engaged=sum>0,contaminated=a.crossAttacks>0||a.leftBounds>0;
        const primary=sides.map(s=>s.healthEnergyLost),dead=sides.map((s,i)=>a.counts[i]-s.alive);
        const balanceMode=a.balanceMode||(result.name.includes('-equal-energy-')?'equal-energy':'equal-numbers');
        const row={scenario:result.name,...a,balanceMode,sides,engaged,contaminated,
            classification:a.mode==='crossing'?'hazard-survival':!engaged?'no-engagement':contaminated?'mixed-groups':'combat',
            wallSeconds:result.wallSeconds,simulationSeconds:result.simulationSeconds,stepping:result.stepping||'fixed-base-ticks',
            healthEnergyTradeAdvantage,healthDepletionAdvantage:healthEnergyTradeAdvantage,oneSidedness:Math.abs(healthEnergyTradeAdvantage),
            upkeepTradeAdvantage:upkeepSum>0?(a1.upkeepEnergy-a0.upkeepEnergy)/upkeepSum:0,
            casualtyImbalance:Math.abs(dead[0]/a.counts[0]-dead[1]/a.counts[1]),
            energyLossRatio0to1:ratio(primary[0],primary[1]),
            // These are affordability counts, never claimed to be victory thresholds.
            equalCreationEnergyCounts:[a1.creationEnergy/profile.things[a.focal].creationEnergyEach,a0.creationEnergy/profile.things[a.opponent].creationEnergyEach],
            costParityCountMeaning:'count of this side costing the opposing tested force; not the number required to win',
            upkeepAccounting:result.upkeepAccounting||'estimated exposure from live stats',
            astarAccounting:'per-matchup movement estimate plus attributed searches; exact team totals in performance',
            towerAllowanceApplied:false};
        rows.push(row);
        if(a.mode==='combat'&&!contaminated)for(let i=0;i<2;i++) {
            const id=sides[i].id,key=balanceMode+':'+id;
            let c=coverage.get(key);if(!c){c={id,balanceMode,observations:0,defeats:0,wins:0,mutualDestruction:0,cappedObservations:0,counters:[],bestPressure:null};coverage.set(key,c);}
            c.observations++;if(a.countBounded)c.cappedObservations++;
            const enemy=sides[1-i],own=sides[i],observation={opponent:enemy.id,level:a.level,research:a.research,scenario:result.name,counts:a.counts,energyMismatchFraction:a.energyMismatchFraction??null,countBounded:!!a.countBounded};
            if(own.alive===0&&enemy.alive>0){c.defeats++;c.counters.push(observation);}
            if(enemy.alive===0&&own.alive>0)c.wins++;
            if(enemy.alive===0&&own.alive===0)c.mutualDestruction++;
            const pressure=own.healthEnergyLossFraction-enemy.healthEnergyLossFraction;
            if(!c.bestPressure||pressure>c.bestPressure.pressure)c.bestPressure={...observation,pressure};
        }
        if(a.mode==='combat'&&engaged&&!contaminated) for(let i=0;i<2;i++) {
            const id=sides[i].id,score=healthEnergyTradeAdvantage*(i===0?1:-1);
            const key=balanceMode+':'+id;
            let s=byThing.get(key);if(!s){s={id,balanceMode,observations:0,sum:0,best:null,worst:null};byThing.set(key,s);}
            s.observations++;s.sum+=score;
            const matchup={opponent:sides[1-i].id,level:a.level,research:a.research,score};
            if(!s.best||score>s.best.score)s.best=matchup;
            if(!s.worst||score<s.worst.score)s.worst=matchup;
        }
    }
    rows.sort((a,b)=>(b.engaged-a.engaged)||(b.oneSidedness-a.oneSidedness)||(Math.abs(b.upkeepTradeAdvantage)-Math.abs(a.upkeepTradeAdvantage))||(b.casualtyImbalance-a.casualtyImbalance));
    const summaries=[...byThing.values()].map(({sum,...s})=>({...s,meanHealthEnergyTradeAdvantage:sum/s.observations})).sort((a,b)=>b.meanHealthEnergyTradeAdvantage-a.meanHealthEnergyTradeAdvantage);
    const performance=results.map(({arenas,...r})=>({...r,completedTPS:r.ticks/r.wallSeconds}));
    const counterCoverage=[...coverage.values()].map(c=>({...c,counterFound:c.defeats>0,uncappedCounterFound:c.counters.some(o=>!o.countBounded),counters:c.counters.filter((o,i,a)=>a.findIndex(x=>x.opponent===o.opponent)===i)})).sort((a,b)=>Number(a.counterFound)-Number(b.counterFound)||a.defeats-b.defeats||a.id.localeCompare(b.id));
    const report={generatedAt:new Date().toISOString(),scenarios:results.length,energyCountLimits:manifest.equalEnergy?{min:manifest.equalEnergy.minCount,max:manifest.equalEnergy.maxCount}:null,ranking:'percentage of starting health energy depleted first; upkeep separately, as lower-priority tie-break; Astar separate',rows,summaries,counterCoverage,performance};
    fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2));
    const keys=['scenario','focal','opponent','level','research','classification','wallSeconds','simulationSeconds','healthEnergyTradeAdvantage','oneSidedness','survivors0','survivors1','initialHealthEnergy0','initialHealthEnergy1','healthEnergyLost0','healthEnergyLost1','healthEnergyLossFraction0','healthEnergyLossFraction1','upkeepEnergy0','upkeepEnergy1','damagePlusUpkeepEnergy0','damagePlusUpkeepEnergy1','creationEnergy0','creationEnergy1','researchEnergy0','researchEnergy1','equalCreationEnergyCount0','equalCreationEnergyCount1','astarApproximate0','astarApproximate1','crossAttacks','leftBounds','upkeepAccounting'];
    function field(r,k) {
        if(/^initialCount[01]$/.test(k))return r.counts[+k.at(-1)];
        if(/^survivors[01]$/.test(k))return r.sides[+k.at(-1)].alive;
        if(/^initialHealthEnergy[01]$/.test(k))return r.sides[+k.at(-1)].hpInitial;
        if(/^equalCreationEnergyCount[01]$/.test(k))return r.equalCreationEnergyCounts[+k.at(-1)];
        if(/^(healthEnergyLost|healthEnergyLossFraction|upkeepEnergy|damagePlusUpkeepEnergy|creationEnergy|researchEnergy|astarApproximate)[01]$/.test(k))return r.sides[+k.at(-1)][k.slice(0,-1)];
        return r[k];
    }
    keys.splice(1,0,'balanceMode','initialCount0','initialCount1','countBounded','energyMismatchFraction');
    const q=x=>'"'+String(x??'').replaceAll('"','""')+'"';
    fs.writeFileSync(path.join(out,'report.csv'),[keys.join(','),...rows.map(r=>keys.map(k=>q(field(r,k))).join(','))].join('\n'));
    const lines=['# Fight results: energy first','',`${results.length} completed scenarios; ${rows.length} matchups.`,
        '', '**Primary ranking: percentage of each force’s starting health-energy depleted by damage.** Upkeep is shown separately and only breaks equal primary scores. The combined damage-plus-upkeep total is in CSV/JSON, but is not the primary ranking. Research is an investment, not damage to the army. Astar is a separate currency, primarily spent on movement and searches; no conversion into energy is assumed.',
        '', 'One-sidedness = |(side 0 health-energy lost / side 0 starting health-energy) − (side 1 health-energy lost / side 1 starting health-energy)|. Losing 1,000 from a 1,000-health force is 100%; losing it from a million-health force is 0.1%. Starting force energy and equal-cost counts show budget differences. Equal-cost counts are affordability comparisons, not measured counts required to win.',
        '', 'These are shared-map, fixed-count observations. Escaped units and cross-group attacks are flagged; unflagged results can still have unobserved cross-group effects. Hazards are survival courses and are excluded from the thing-strength summary. Normal resistance and immunity rules run in the simulation; no extra resistance multiplier is invented. No balance values are changed.',
        '', '## Completed runs','', '| Scenario | Wall seconds | Game seconds | TPS | Delta ticks | Upkeep accounting |','|---|---:|---:|---:|---|---|'];
    for(const p of performance)lines.push(`| ${p.name} | ${fmt(p.wallSeconds)} | ${fmt(p.simulationSeconds)} | ${fmt(p.completedTPS)} | ${p.dkHistogram?JSON.stringify(p.dkHistogram):'fixed 1'} | ${p.upkeepAccounting||'estimated exposure'} |`);
    lines.push('','## Most one-sided health-energy trades','','Side 0 is the focal thing; side 1 is its opponent. All energy columns use the same game energy units.','',
        '| Focal vs opponent | L / R | Survivors 0:1 | Start energy 0:1 | Damage energy lost 0:1 | Damage lost % 0:1 | Upkeep 0:1 | Equal-cost count 0:1 | Status |',
        '|---|---|---|---|---|---|---|---|---|');
    for(const r of rows.slice(0,75)){const [s,t]=r.sides;lines.push(`| ${r.focal} vs ${r.opponent} | ${r.level} / ${r.research} | ${s.alive}:${t.alive} | ${fmt(s.hpInitial)}:${fmt(t.hpInitial)} | ${fmt(s.healthEnergyLost)}:${fmt(t.healthEnergyLost)} | ${(s.healthEnergyLossFraction*100).toFixed(3)}:${(t.healthEnergyLossFraction*100).toFixed(3)} | ${fmt(s.upkeepEnergy)}:${fmt(t.upkeepEnergy)} | ${fmt(r.equalCreationEnergyCounts[0])}:${fmt(r.equalCreationEnergyCounts[1])} | ${r.classification} |`);}
    lines.push('','## Thing summary','','Mean percentage-health depletion advantage across engaged, unflagged fixed-count combat observations. Positive is favorable. These observations include mirrored cases and levels, not independent repeated samples. Different force budgets remain a confound; use the equal-cost counts before making balance changes.','',
        '| Thing | Mean advantage | Observations | Weakest observed matchup |','|---|---:|---:|---|');
    for(const s of summaries)lines.push(`| ${s.id} | ${(s.meanHealthEnergyTradeAdvantage*100).toFixed(1)}% | ${s.observations} | ${s.worst.opponent}, L${s.worst.level} R${s.worst.research}: ${(s.worst.score*100).toFixed(1)}% |`);
    lines.push('','## Counter coverage','','An observed defeat means this force has no survivors while its opponent still has survivors. Mixed groups and hazard courses are excluded. No observed counter is an open question, not proof that a thing cannot be defeated. Capped energy matchups are identified.','','| Thing | Set | Observations | Defeats | Wins | Observed counters |','|---|---|---:|---:|---:|---|');
    for(const c of counterCoverage)lines.push(`| ${c.id} | ${c.balanceMode} | ${c.observations} | ${c.defeats} | ${c.wins} | ${c.counters.length?c.counters.map(o=>o.opponent+(o.countBounded?' (count-limited)':'')).join(', '):'No counter observed'} |`);
    lines.push('','[All sorted rows (CSV)](report.csv) · [Full data and performance (JSON)](report.json)','');
    fs.writeFileSync(path.join(out,'report.md'),lines.join('\n'));
    require('./html-report.cjs').writeHtmlReport(report,out);
    return report;
}
if(require.main===module) {
    const out=path.resolve(process.argv[2]||path.join(__dirname,'reports/adaptive'));
    const manifest=JSON.parse(fs.readFileSync(path.resolve(__dirname,'../scenarios/manifest.json')));
    const registered=new Set(manifest.scenarios.filter(s=>s.kind==='fight').map(s=>s.name));
    const results=fs.readdirSync(out).filter(f=>f.endsWith('.json')&&registered.has(f.slice(0,-5))).map(f=>JSON.parse(fs.readFileSync(path.join(out,f))));
    buildReport(manifest,results,out);console.log(path.join(out,'report.md'));
}
module.exports={buildReport};
