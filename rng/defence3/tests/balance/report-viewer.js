'use strict';
(()=>{
const data=JSON.parse(document.getElementById('report-data').textContent),all=data.rows;
const $=id=>document.getElementById(id),esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const n=x=>x==null?'—':Math.abs(x)>=1e7?Number(x).toExponential(2):Number(x).toLocaleString(undefined,{maximumFractionDigits:2});
const pct=x=>(100*x).toFixed(2)+'%';
let visible=[],sortKey='oneSidedness',descending=true,page=0,plotReady=false;
for(const r of all)r.balanceMode??=r.scenario.includes('-equal-energy-')?'equal-energy':'equal-numbers';
function select(id,values){$(id).innerHTML='<option value="">All</option>'+[...new Set(values)].sort((a,b)=>typeof a==='number'?a-b:String(a).localeCompare(String(b))).map(x=>`<option>${esc(x)}</option>`).join('');}
select('focal',all.map(r=>r.focal));select('opponent',all.map(r=>r.opponent));select('level',all.map(r=>r.level));select('research',all.map(r=>r.research));
select('balance-mode',all.map(r=>r.balanceMode));
$('scenario-count').textContent=data.scenarios;$('row-count').textContent=n(all.length);$('mixed-count').textContent=n(all.filter(r=>r.contaminated).length);
$('updated').textContent='Generated '+new Date(data.generatedAt).toLocaleString();
$('runs').innerHTML=data.performance.map(p=>`<tr><td>${esc(p.name)}</td><td>${n(p.wallSeconds)}</td><td>${n(p.simulationSeconds)}</td><td>${n(p.completedTPS)}</td><td>${esc(p.dkHistogram?Object.entries(p.dkHistogram).map(([k,v])=>k+'×'+v).join(', '):'fixed 1')}</td><td>${esc(p.upkeepAccounting||'estimated live exposure')}</td></tr>`).join('');
function value(r,key){if(key==='health0')return r.sides[0].healthEnergyLossFraction;if(key==='health1')return r.sides[1].healthEnergyLossFraction;if(key==='upkeep0')return r.sides[0].upkeepEnergy;if(key==='upkeep1')return r.sides[1].upkeepEnergy;return r[key];}
function filter(){
 const term=$('search').value.toLowerCase();
 visible=all.filter(r=>(!$('balance-mode').value||r.balanceMode===$('balance-mode').value)&&(!$('focal').value||r.focal===$('focal').value)&&(!$('opponent').value||r.opponent===$('opponent').value)&&(!$('level').value||r.level===Number($('level').value))&&(!$('research').value||r.research===Number($('research').value))&&($('mixed').checked||!r.contaminated)&&($('idle').checked||r.engaged)&&($('hazards').checked||r.mode!=='crossing')&&($('bounded').checked||!r.countBounded)&&(!term||[r.focal,r.opponent,r.scenario].some(x=>x.toLowerCase().includes(term))));
 visible.sort((a,b)=>{const av=value(a,sortKey),bv=value(b,sortKey);const d=typeof av==='string'?av.localeCompare(bv):av-bv;return (descending?-d:d)||b.oneSidedness-a.oneSidedness;});
 page=0;render();draw();
}
function loss(s,enemy){return `<td class="loss ${enemy?'enemy':''}">${pct(s.healthEnergyLossFraction)}<div class="bar"><i style="width:${Math.min(100,s.healthEnergyLossFraction*100)}%"></i></div></td>`;}
function render(){
 const start=page*100,part=visible.slice(start,start+100);$('shown-count').textContent=n(visible.length);
 $('rows').innerHTML=part.map((r,i)=>{const [s,t]=r.sides;return `<tr data-index="${start+i}"><td class="names">${esc(r.focal)}<small>vs ${esc(r.opponent)}</small></td><td>${r.level}</td><td>${r.research}</td>${loss(s,false)}${loss(t,true)}<td>${(r.oneSidedness*100).toFixed(2)} pp</td><td>${s.alive}:${t.alive}</td><td>${n(s.healthEnergyLost)}<br><span class="small">${n(t.healthEnergyLost)}</span></td><td>${n(s.upkeepEnergy)}<br><span class="small">${n(t.upkeepEnergy)}</span></td><td>${n(s.hpInitial)}<br><span class="small">${n(t.hpInitial)}</span></td><td><span class="badge">${esc(r.classification)}</span></td></tr>`;}).join('');
 $('page-label').textContent=visible.length?`${start+1}–${Math.min(start+100,visible.length)} / ${visible.length}`:'No matching observations';
 $('previous').disabled=page===0;$('next').disabled=start+100>=visible.length;
 for(const tr of $('rows').querySelectorAll('tr'))tr.onclick=()=>detail(visible[+tr.dataset.index]);
}
function draw(){
 const axis=title=>({title:{text:title,standoff:14},range:[-.03,1.03],tickformat:'.0%',gridcolor:'#263345',zerolinecolor:'#536277',automargin:true});
 Plotly.react($('scatter'),[{
  type:'scattergl',mode:'markers',x:visible.map(r=>r.sides[0].healthEnergyLossFraction),y:visible.map(r=>r.sides[1].healthEnergyLossFraction),
  marker:{size:7,opacity:.65,symbol:visible.map(r=>r.countBounded?'diamond':'circle'),color:visible.map(r=>r.healthDepletionAdvantage),cmin:-1,cmax:1,colorscale:[[0,'#ff747e'],[.5,'#a6b0c0'],[1,'#57b5ff']],showscale:false},
  customdata:visible.map((r,i)=>[i,esc(r.focal),esc(r.opponent),r.level,r.research,r.counts[0],r.counts[1],r.sides[0].hpInitial,r.sides[1].hpInitial,r.sides[0].upkeepEnergy,r.sides[1].upkeepEnergy,esc(r.balanceMode),r.countBounded?'COUNT-LIMITED':esc(r.classification),r.sides[0].alive,r.sides[1].alive]),
  hovertemplate:'<b>%{customdata[1]} vs %{customdata[2]}</b><br>L%{customdata[3]} · R%{customdata[4]} · %{customdata[11]}<br>Counts: %{customdata[5]} : %{customdata[6]}<br>Start energy: %{customdata[7]:.4s} : %{customdata[8]:.4s}<br>Health lost: %{x:.2%} : %{y:.2%}<br>Survivors: %{customdata[13]} : %{customdata[14]}<br>Upkeep: %{customdata[9]:.4s} : %{customdata[10]:.4s}<br>%{customdata[12]}<extra></extra>'
 }],{paper_bgcolor:'#10141b',plot_bgcolor:'#10141b',font:{color:'#b8c7d9',family:'system-ui'},margin:{l:78,r:30,t:35,b:65},xaxis:axis('Focal health-energy lost'),yaxis:axis('Opponent health-energy lost'),dragmode:'zoom',hovermode:'closest',uirevision:'health-comparison',showlegend:false,
 shapes:[{type:'line',xref:'x',yref:'y',x0:0,y0:0,x1:1,y1:1,line:{color:'#63758d',width:1,dash:'dot'},layer:'below'}],annotations:visible.length?[]:[{xref:'paper',yref:'paper',x:.5,y:.5,text:'No observations match these filters',showarrow:false}]},
 {responsive:true,scrollZoom:true,displaylogo:false,displayModeBar:true,toImageButtonOptions:{filename:'fight-health-comparison',format:'png',scale:2}});
 if(!plotReady){$('scatter').on('plotly_click',e=>{const i=e.points[0]?.customdata?.[0];if(i!=null&&visible[i])detail(visible[i]);});plotReady=true;}
}
function detail(r){
 $('detail-title').textContent=r.focal+' vs '+r.opponent+' · L'+r.level+' R'+r.research+' · '+r.balanceMode;
 const hist=h=>h?Object.entries(h).map(([l,c])=>'L'+l+': '+c).join(', '):'not recorded in this initial run';
 $('detail-body').innerHTML='<div class="detail-grid">'+r.sides.map((s,i)=>`<section><h2 class="${i?'red':'blue'}">Side ${i} · ${esc(s.id)}</h2><dl>${[
 ['Surviving things',s.alive+' / '+s.initial],['Starting health-energy',n(s.hpInitial)],['Remaining health-energy',n(s.hpRemaining)],['Health-energy lost to damage',n(s.healthEnergyLost)+' ('+pct(s.healthEnergyLossFraction)+')'],['Upkeep paid',n(s.upkeepEnergy)],['Damage + upkeep (secondary)',n(s.damagePlusUpkeepEnergy)],['Creation energy',n(s.creationEnergy)],['Research investment',n(s.researchEnergy)],['Equal-cost count vs tested opponent',n(r.equalCreationEnergyCounts[i])],['Approximate Astar spending',n(s.astarApproximate)],['Directly attributed Astar subset',n(s.astarDirectlyAttributed)],['Effective levels at start',hist(s.effectiveLevelsStart)],['Effective levels among survivors',hist(s.effectiveLevelsEnd)]
 ].map(([a,b])=>'<dt>'+esc(a)+'</dt><dd>'+esc(b)+'</dd>').join('')}</dl></section>`).join('')+'</div>'+`<p>${esc(r.scenario)} · ${n(r.wallSeconds)} wall seconds · ${n(r.simulationSeconds)} game seconds. ${esc(r.upkeepAccounting)}.</p><div class="note">Equal-cost counts describe affordability, not the count required to win. Group escapes: ${r.leftBounds}; detected cross-group attack attempts: ${r.crossAttacks}. Normal effective-level rules remain active.</div>`;
 $('detail').showModal();
 const extra=document.createElement('p');extra.className='note';extra.textContent='Starting counts: '+r.counts.join(' : ')+'. '+(r.energyMismatchFraction!=null?'Planned base-energy difference: '+pct(r.energyMismatchFraction)+'. ':'')+(r.countBounded?'Count limits applied; uncapped counts would be '+r.requiredCounts.join(' : ')+'.':'');$('detail-body').prepend(extra);
}
function showCounters(){
 const coverage=new Map();
 for(const r of visible.filter(r=>r.mode==='combat'&&!r.contaminated))for(let i=0;i<2;i++) {
  const own=r.sides[i],enemy=r.sides[1-i],key=r.balanceMode+':'+own.id;
  if(!coverage.has(key))coverage.set(key,{id:own.id,mode:r.balanceMode,n:0,wins:0,defeats:0,counters:new Map(),pressure:-Infinity,best:null});
  const c=coverage.get(key);c.n++;
  if(own.alive===0&&enemy.alive>0){c.defeats++;const label=enemy.id+(r.countBounded?' (count-limited)':'');c.counters.set(label,(c.counters.get(label)||0)+1);}
  if(enemy.alive===0&&own.alive>0)c.wins++;
  const pressure=own.healthEnergyLossFraction-enemy.healthEnergyLossFraction;
  if(pressure>c.pressure){c.pressure=pressure;c.best=enemy.id+' · L'+r.level+' R'+r.research+(r.countBounded?' (count-limited)':'');}
 }
 $('counter-rows').innerHTML=[...coverage.values()].sort((a,b)=>a.defeats-b.defeats||a.id.localeCompare(b.id)).map(c=>`<tr><td>${esc(c.id)}<small class="small"> · ${esc(c.mode)}</small></td><td>${c.n}</td><td>${c.defeats} / ${c.wins}</td><td>${c.counters.size?[...c.counters.keys()].map(esc).join('<br>'):'<span class="red">No counter observed</span>'}</td><td>${c.pressure>0?esc(c.best)+'<br>'+pct(c.pressure)+' net depletion':'No unfavorable health trade observed'}</td></tr>`).join('')||'<tr><td colspan="5">No unflagged combat observations match the filters.</td></tr>';
 $('counters').showModal();
}
for(const id of ['balance-mode','focal','opponent','level','research','mixed','idle','hazards','bounded'])$(id).onchange=filter;
$('search').oninput=filter;$('previous').onclick=()=>{page--;render();};$('next').onclick=()=>{page++;render();};
for(const b of document.querySelectorAll('[data-sort]'))b.onclick=()=>{const key=b.dataset.sort;descending=key===sortKey?!descending:true;sortKey=key;filter();};
$('close-detail').onclick=()=>$('detail').close();
for(const b of document.querySelectorAll('[data-close]'))b.onclick=()=>$(b.dataset.close).close();
$('help-button').onclick=()=>$('help').showModal();$('show-data').onclick=()=>$('data-table').showModal();
$('show-counters').onclick=showCounters;
$('export').onclick=()=>{const quote=x=>'"'+String(x??'').replaceAll('"','""')+'"';const rows=[['focal','opponent','level','research','set','count_0','count_1','count_limited','planned_energy_mismatch','start_energy_0','start_energy_1','health_loss_fraction_0','health_loss_fraction_1','damage_energy_0','damage_energy_1','upkeep_0','upkeep_1','status'],...visible.map(r=>[r.focal,r.opponent,r.level,r.research,r.balanceMode,...r.counts,!!r.countBounded,r.energyMismatchFraction,...r.sides.map(s=>s.hpInitial),...r.sides.map(s=>s.healthEnergyLossFraction),...r.sides.map(s=>s.healthEnergyLost),...r.sides.map(s=>s.upkeepEnergy),r.classification])];const url=URL.createObjectURL(new Blob([rows.map(r=>r.map(quote).join(',')).join('\n')],{type:'text/csv'})),a=document.createElement('a');a.href=url;a.download='filtered-fight-results.csv';a.click();URL.revokeObjectURL(url);};
window.addEventListener('resize',draw);filter();
})();
