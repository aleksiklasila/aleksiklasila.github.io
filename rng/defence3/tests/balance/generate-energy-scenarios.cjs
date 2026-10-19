'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const G=require('./generate-scenarios.cjs');
const ROOT=path.resolve(__dirname,'../scenarios');
// Keep the cheaper side near 100. Ratios above 100 use one expensive
// participant and as many cheap individuals as its energy can fund.
function energyCounts(a,b,target=100) {
    if(!(a>0&&b>0&&Number.isFinite(a)&&Number.isFinite(b)))throw Error('Invalid health-energy');
    const cheap=a<=b?0:1,ratio=Math.max(a,b)/Math.min(a,b),expensive=Math.max(1,Math.round(target/ratio));
    const counts=[];counts[cheap]=Math.max(1,Math.round(expensive*ratio));counts[1-cheap]=expensive;
    return counts;
}
async function main(args=process.argv.slice(2)) {
    let minCount=1,maxCount=1000;
    for(let i=0;i<args.length;i++) {
        if(args[i]==='--help'){console.log('node tests/balance/generate-energy-scenarios.cjs [--min-count 1] [--max-count 1000]\nPreserves equal-count/work scenes. Matches starting base health-energy, excluding upkeep and research. Bounded counts and energy mismatch are recorded for every group. Formation capacity: 1000 per thing.');return;}
        if(args[i]==='--min-count')minCount=Number(args[++i]);else if(args[i]==='--max-count')maxCount=Number(args[++i]);else throw Error('Unknown argument '+args[i]);
    }
    if(!Number.isInteger(minCount)||!Number.isInteger(maxCount)||minCount<1||minCount>maxCount||maxCount<2||maxCount>1000)throw Error('Require 1 <= min-count <= max-count <= 1000; max-count >= 2 for laser pairs');
    if(Math.ceil(minCount/2)>Math.floor(maxCount/2))throw Error('The count range must include an even count for paired lasers');
    const mp=path.join(ROOT,'manifest.json'),manifest=JSON.parse(fs.readFileSync(mp));
    const data=G.readGameData(),generated=[],bounded=[];
    fs.mkdirSync(path.join(ROOT,'equal_energy'),{recursive:true});
    // Preserve every existing equal-count scene; new names are disjoint.
    for(const research of data.research) {
        const profiles=data.profiles.filter(p=>p.research===research);
        for(const focal of data.catalog) {
            const opponents=data.catalog.filter(t=>focal.role==='crossing'?t.kind==='unit':t.role==='army'),specs=[];
            for(const profile of profiles)for(const other of opponents) {
                const energy=t=>{const s=profile.things[t.id].stats;return t.kind==='unit'?s.energy:s.maxEnergy;};
                const each=[energy(focal),energy(other)],requiredCounts=energyCounts(...each);
                // Lasers need paired endpoints, as in the equal-count courses.
                if(focal.key==='laser'&&requiredCounts[0]%2){requiredCounts[0]++;requiredCounts[1]=Math.max(1,Math.round(requiredCounts[0]*each[0]/each[1]));}
                const counts=requiredCounts.map(n=>Math.max(minCount,Math.min(maxCount,n)));
                if(focal.key==='laser')counts[0]=Math.min(2*Math.floor(maxCount/2),2*Math.ceil(counts[0]/2));
                const countBounded=counts.some((n,i)=>n!==requiredCounts[i]);
                if(countBounded)bounded.push({focal:focal.id,opponent:other.id,level:profile.level,research,requiredCounts,counts,energyEach:each});
                const startingEnergy=counts.map((n,i)=>n*each[i]);
                specs.push({profile,other,counts,accounting:{balanceMode:'equal-energy',countBounded,requiredCounts,energyEach:each,plannedStartingEnergy:startingEnergy,energyMismatchFraction:Math.abs(startingEnergy[0]-startingEnergy[1])/Math.max(...startingEnergy)}});
            }
            if(!specs.length)continue;
            const geometryKey='energy:'+crypto.createHash('sha256').update(JSON.stringify([focal.id,specs.map(s=>[s.profile.level,s.other.id,s.counts])])).digest('hex');
            const {records,arenas,layout,anchors}=G.makeScene(data,focal,profiles,opponents,{specs,geometryKey,groupSize:focal.role==='crossing'?90:58,minimumGap:focal.role==='crossing'?24:32});
            const name=`fight-2-teams-equal-energy-${focal.id}_R${research}`;
            const file='equal_energy/'+name+'.json.gz';
            fs.writeFileSync(path.join(ROOT,file),G.compressScene(records));
            generated.push({kind:'fight',balanceMode:'equal-energy',name,file,levels:data.levels,research,focal:focal.id,layout,anchors,arenas});
            console.log('Generated '+name+': '+arenas.length+' matchups');
            await new Promise(r=>setImmediate(r));
        }
    }
    manifest.scenarios=manifest.scenarios.filter(s=>s.balanceMode!=='equal-energy'&&data.research.includes(s.research)&&(s.kind==='work'||data.catalog.some(t=>t.id===s.focal))).concat(generated);
    manifest.researchLevels=data.research;
    manifest.equalEnergy={generatedAt:new Date().toISOString(),metric:'Starting base health-energy at the configured L/R; normal live effective levels unchanged. Excludes upkeep, research and production infrastructure.',targetCheapCount:100,minCount,maxCount,rounding:'Nearest whole entity, then bounded by min/max; lasers use paired endpoints. Each arena records actual energy mismatch.',bounded};
    manifest.profiles=data.profiles;manifest.catalog=data.catalog;
    fs.writeFileSync(mp,JSON.stringify(manifest,null,2)+'\n');
    fs.writeFileSync(path.join(ROOT,'equal_energy/count-limits.json'),JSON.stringify(manifest.equalEnergy,null,2)+'\n');
    console.log(`${generated.length} equal-energy scenes; ${bounded.length} bounded pairings listed in equal_energy/count-limits.json. Equal-count scenes retained.`);
}
module.exports={energyCounts};
if(require.main===module)main().catch(e=>{console.error(e);process.exitCode=1;});
