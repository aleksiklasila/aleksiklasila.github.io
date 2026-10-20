'use strict';
const fs=require('node:fs'),path=require('node:path');
if(process.argv.includes('--cached-structures'))process.env.DEFENCE_TEST_SOURCE_OVERRIDES=JSON.stringify(Object.fromEntries([
 ['src/data/data_state.js','baseline-data-state.js'],['src/data/data_dynamic.js','baseline-data-dynamic.js'],['src/things/things_utils.js','baseline-things-utils.js'],['src/things/tower.js','baseline-tower.js'],['src/things/barrack.js','baseline-barrack.js']
].map(([a,b])=>[a,'tests/test-runs/structure-stats-20261020/'+b])));
const H=require('./net-harness.cjs');
const world=new H.World({controls:{...H.SMALL_MATCH_CONTROLS,'cfg-mapsize':'64'}});
const inst=world.spawn('entity-storage-census',{simWorker:false});
const census=inst.eval(`(()=>{
 startSoloGame();
 const columns=Object.entries(SIM_UNIT_SCHEMA).map(([name,e])=>({name,type:e.Type.name,count:e.count,bytes:e.bytes,workerRecordBytes:e.recordBytes||0,snapshot:e.snapshot}));
 const js=SIM_UNIT_JS_FIELDS.filter(e=>e[1]!=='r').map(([name,kind])=>({name,kind,bytes:kind==='b'?1:kind==='d'?8:4}));
 const refs=Object.entries(_simUnitState.columns).filter(([k,v])=>v instanceof SimRefColumn).map(([name,v])=>({name,storage:v instanceof SimSharedColumn?'interned handle':'paged reference',bytesPerHandle:v.data?v.data.BYTES_PER_ELEMENT:null}));
 const structures=[];
 for(const C of [Tower,Barrack,CollectorSpawner,AstarSpawner,SalvagerSpawner,BuilderSpawner,HealerSpawner,ResearchSpawner,FloorItem,GoldMine,AstarMine]){
  const T=_sTableOf(C);
  structures.push({name:C.name,derived:T.derived||[],unique:T.unique?Object.fromEntries(Object.entries(T.unique).map(([k,v])=>[k,v.size])):{},fields:T.fields.map(f=>({name:f.name,storage:f.shared?'interned handle':f.kind==='r'?'reference':T[f.col].constructor.name,bytes:f.shared?T[f.col].data.BYTES_PER_ELEMENT:f.kind==='r'?null:T[f.col].BYTES_PER_ELEMENT}))});
 }
 return {flatStats:typeof _thingStatTables!=='undefined'?{tables:_thingStatTables.size,bytes:[..._thingStatTables.values()].reduce((n,t)=>n+t.data.byteLength,0),views:[..._thingStatTables.values()].reduce((n,t)=>n+t.entries.filter(Boolean).length,0)}:null,unit:{wasmBytesPerSlot:columns.reduce((n,e)=>n+e.bytes,5),jsNumericBytesPerSlot:js.reduce((n,e)=>n+e.bytes,0),columns,jsNumeric:js,references:refs},structures,sharedStats:{width:EFF_HOT_WIDTH,rows:_effRowN,capacity:_effRowCap,bytes:_effHot?_effHot.byteLength:0,removedColumns:['mvSpd','mvCost','mvChs','cbRange','atkCd','atkDmg']}};
})()`);
const output=process.argv.find(a=>a.startsWith('--out='))?.slice(6)||path.join(__dirname,'test-runs/collision-tps-20261020/entity-storage.json');
fs.mkdirSync(path.dirname(output),{recursive:true});fs.writeFileSync(output,JSON.stringify(census,null,2)+'\n');
console.log(JSON.stringify({wasmBytesPerSlot:census.unit.wasmBytesPerSlot,jsNumericBytesPerSlot:census.unit.jsNumericBytesPerSlot,structures:census.structures.length,sharedStats:census.sharedStats}));
