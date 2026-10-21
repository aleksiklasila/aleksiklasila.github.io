'use strict';
const assert=require('node:assert/strict'),H=require('./net-harness.cjs');
const w=new H.World({controls:H.SMALL_MATCH_CONTROLS}),i=w.spawn('range-display',{simWorker:false});
const result=i.eval(`(()=>{
 startSoloGame();
 const u=new Unit('norm',0,5*TILE,5*TILE);units.push(u);unitSlotMapPushed(u);
 const b=new Barrack(6,6,'norm',0),t=new Tower(7,7,'pistol',0);
 const row=(html,label)=>html.split('<div').find(s=>s.includes('>'+label+'</')||s.includes('>'+label+'<'))||'';
 const unit=row(renderUnitInfo(u),'Range'),group=row(renderUnitGroupInfo([u]),'Range');
 const barrack=row(renderBarrackInfo(b),'Unit Range'),bgroup=row(renderBarrackGroupInfo([b]),'Unit Range');
 // Deliberately different sight and range: neither the panel nor matrix may substitute sight.
 const st={...t.currentStats,attackRangeArea:1.5,visionRange:4,visionRangeArea:4};
 const proxy=Object.create(t);Object.defineProperties(proxy,{currentStats:{value:st},baseStats:{value:st}});
 const tower=row(renderTowerInfo(proxy),'Range'),tgroup=row(renderTowerGroupInfo([proxy]),'Range');
 const matrixId=/data-matrix-id="([^"]+)"/.exec(tower)[1];
 if(infoPanelStatMatrixDescriptorById[matrixId].statKey!=='attackRange')throw Error('Tower range matrix still opens sight');
 const preview=renderBuildItemDetailedStats('pistol');
 return {unit,group,barrack,bgroup,tower,tgroup,preview,
  fractional:formatAreaDistanceStat(.6),research:formatResearchStatValue('attackRange',1.5),
  tiles:formatRangeStatTiles(7.5),area:getStatAttackRangeArea({attackRangeArea:2.5,attackRange:0})};
})()`);
for(const key of ['unit','group','barrack','bgroup'])assert.match(result[key],/>1a(?: avg)?</,key+': '+result[key]);
for(const key of ['tower','tgroup']){assert.match(result[key],/>1\.5a</,key+': '+result[key]);assert.doesNotMatch(result[key],/>4a</);}
assert.match(result.preview,/Range/);assert.equal(result.fractional,'0.6a');assert.equal(result.research,'1.5 areas');assert.equal(result.tiles,'1.5a');assert.equal(result.area,2.5);assert.deepEqual(i.errors,[]);
console.log('PASS: unit/group/barrack/tower ranges use attack range in areas; fractional research and tile conversions agree');
