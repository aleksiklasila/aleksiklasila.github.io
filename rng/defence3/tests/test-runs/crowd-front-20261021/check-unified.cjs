const fs=require('fs'),assert=require('assert/strict'),H=require('../../net-harness.cjs'),old=JSON.parse(fs.readFileSync(__dirname+'/static-before.json'));
const w=new H.World({controls:H.SMALL_MATCH_CONTROLS}),i=w.spawn('unified',{simWorker:false});
const data=i.eval(`(()=>{startSoloGame();return Object.fromEntries(Object.entries(THING_STATS).map(([key,t])=>[key,Array.from({length:21},(_,l)=>t.kind==='unit'?computeBaseUnitStatsAtLevel(key,l):computeBaseBuildingStatsAtLevel(key,l))]));})()`);
const diffs=[];for(const [key,row] of Object.entries(old.rows))for(let l=0;l<=20;l++)for(const [s,v]of Object.entries(row.base[l])){const n=data[key][l][s];if(!(v===null&&!Number.isFinite(n))&&v!==n&&!(Number.isFinite(v)&&Number.isFinite(n)&&Math.abs(v-n)<1e-9*Math.max(1,Math.abs(v))))diffs.push({key,l,s,v,n});}
console.log('base differences',diffs.length,diffs.slice(0,15));assert.equal(diffs.length,0);assert.deepEqual(i.errors,[]);

