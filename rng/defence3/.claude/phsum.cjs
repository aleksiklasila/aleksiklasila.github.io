const s=require('fs').readFileSync(process.argv[2],'utf8');const j=JSON.parse(s.slice(s.indexOf('{"ticks"')));const agg={};let n=0;
const from=Number(process.argv[3]||40);
for(const [t,r] of Object.entries(j.phases)){if(t<from)continue;n++;for(const[k,v] of Object.entries(r))agg[k]=(agg[k]||0)+v;}
for(const [k,v] of Object.entries(agg).sort((a,b)=>b[1]-a[1]).slice(0,45))console.log((v/n).toFixed(1).padStart(8),k);console.log('mean',j.meanMs,'p50',j.p50,'max',j.max);
