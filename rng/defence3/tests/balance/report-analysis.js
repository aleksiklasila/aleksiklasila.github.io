'use strict';
(function(root){
 function mode(row){return row.balanceMode||(row.scenario.includes('-equal-energy-')?'equal-energy':'equal-numbers');}
 function matches(row,options){
  return (mode(row)==='equal-energy'?options.energy:options.numbers)
   &&(options.self||row.focal!==row.opponent)
   &&(options.mixed||!row.contaminated)&&(options.idle||row.engaged)
   &&(options.hazards||row.mode!=='crossing')&&(options.bounded||!row.countBounded);
 }
 function relativeDanger(lossY,lossX){
  const total=lossY+lossX;
  return total>0?100*(lossY-lossX)/total:0;
 }
 // Each real fight measures both directions. Reverse the measured sides for
 // the opposite cell; never infer a win or create data for untested pairings.
 // Self-match controls keep their original side order, exposing asymmetry.
 function dangerMatrix(rows,things,{level='',research='',victim='',threat=''}={}){
  const ys=things.filter(t=>!victim||t===victim),xs=things.filter(t=>!threat||t===threat),cells=new Map();
  function add(r,i){
   const y=i===0?r.focal:r.opponent,x=i===0?r.opponent:r.focal;
   if((victim&&y!==victim)||(threat&&x!==threat))return;
   const key=JSON.stringify([y,x]);let c=cells.get(key);
   if(!c){c={victim:y,threat:x,lossY:0,lossX:0,count:0,bounded:0,observations:[]};cells.set(key,c);}
   c.lossY+=r.sides[i].healthEnergyLossFraction;c.lossX+=r.sides[1-i].healthEnergyLossFraction;c.count++;c.bounded+=Number(!!r.countBounded);c.observations.push({row:r,victimSide:i});
  }
  for(const r of rows){
   if((level!==''&&r.level!==Number(level))||(research!==''&&r.research!==Number(research)))continue;
   add(r,0);if(r.focal!==r.opponent)add(r,1);
  }
  for(const c of cells.values()){c.lossY/=c.count;c.lossX/=c.count;c.danger=relativeDanger(c.lossY,c.lossX);}
  return {xs,ys,cells,grid:ys.map(y=>xs.map(x=>cells.get(JSON.stringify([y,x]))||null))};
 }
 const api={mode,matches,relativeDanger,dangerMatrix};
 if(typeof module==='object'&&module.exports)module.exports=api;else root.FightReportAnalysis=api;
})(globalThis);
