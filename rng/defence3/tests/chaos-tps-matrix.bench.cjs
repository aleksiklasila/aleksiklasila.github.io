// Serial comparisons of the same million-unit worlds at different simulation
// strides. Full chaos retains economy/jobs/actions; checkerboard isolates combat.
'use strict';
const fs=require('node:fs'),path=require('node:path'),{spawn}=require('node:child_process');
const opt=(k,v)=>process.argv.find(a=>a.startsWith('--'+k+'='))?.slice(k.length+3)??v;
const root=path.resolve(__dirname,'..'),out=path.resolve(opt('out','tests/test-runs/chaos-tps-matrix'));
const ticks=Number(opt('ticks',100)),warmup=Number(opt('warmup',20)),repeats=Number(opt('repeats',1));
const referenceDir=opt('reference-dir','');
const reference=opt('reference-worker',referenceDir?path.join(referenceDir,'baseline-worker.js'):''),selected=opt('scenarios','chaos-dk1,chaos-dk4,chaos-dk20,front-dk1,front-dk20,checkerboard-dk1,checkerboard-dk20').split(',');
const referenceProjectile=opt('reference-projectile','');
const profiles=process.argv.includes('--profile'),hash=process.argv.includes('--hash');
const compareTowers=process.argv.includes('--compare-towers');
const rows=[];
fs.mkdirSync(out,{recursive:true});
function save(){
 fs.writeFileSync(path.join(out,'results.json'),JSON.stringify({node:process.version,reference,referenceDir,compareTowers,profiles,ticks,warmup,repeats,rows},null,2));
 fs.writeFileSync(path.join(out,'report.md'),'# Serial million-unit TPS matrix\n\nWhole-step wall time; rendering/transport excluded. Profiler overhead is included only when requested. Natural deaths/production remain enabled.\n\n| Scene | Variant | Repeat | Mean ms | p95 | p99 | Max | TPS | Measured units, min–max |\n|---|---|---:|---:|---:|---:|---:|---:|---|\n'+rows.map(r=>`| ${r.scene} | ${r.variant} | ${r.repeat} | ${r.mean.toFixed(1)} | ${r.p95.toFixed(1)} | ${r.p99.toFixed(1)} | ${r.max.toFixed(1)} | ${(1000/r.mean).toFixed(2)} | ${r.minUnits}–${r.maxUnits} |`).join('\n')+'\n');
}
async function run(scene,variant,repeat){
 const m=/^(chaos|front|checkerboard)-dk(1|4|20)$/.exec(scene);if(!m)throw Error('Unknown scene '+scene);
 const mixed=m[1]!=='checkerboard';
 const file=path.join(out,scene+'-'+variant+'-'+repeat+'.json'),log=fs.openSync(file+'.log','w');
 const args=['--max-old-space-size=8192',path.join(__dirname,mixed?'chaos-spikes.bench.cjs':'checkerboard-tps.bench.cjs'),
  '--units=1000000','--helpers=11','--dk='+m[2],'--ticks='+ticks,'--warmup='+warmup,'--out='+file];
 if(mixed)args.push('--structures=250000','--kernels','--system-metrics',...(m[1]==='front'?['--layout=front']:[]),...(hash?['--hash']:[]));
 if(mixed&&compareTowers)args.push('--tower-mode='+(variant==='js'?'js':'auto'));
 if(profiles)args.push('--profile',...(mixed?['--timeline']:[]));
 const env={...process.env};
 if(variant==='reference'&&reference){
  const overrides={...JSON.parse(env.DEFENCE_TEST_SOURCE_OVERRIDES||'{}'),'src/things/worker.js':path.resolve(reference),...(referenceProjectile?{'src/things/projectile.js':path.resolve(referenceProjectile)}:{})};
  if(referenceDir)for(const [file,name]of [['src/things/projectile.js','projectile'],['src/things/tower.js','tower'],['src/game/chunk.js','chunk']])overrides[file]=path.resolve(referenceDir,'baseline-'+name+'.js');
  env.DEFENCE_TEST_SOURCE_OVERRIDES=JSON.stringify(overrides);
 }
 console.log('Starting',scene,variant,repeat);
 try{await new Promise((resolve,reject)=>{const child=spawn(process.execPath,args,{cwd:root,env,windowsHide:true,stdio:['ignore',log,log]});child.on('error',reject);child.on('exit',code=>code===0?resolve():reject(Error(scene+' '+variant+' exited '+code+'; see '+file+'.log')));});}
 finally{fs.closeSync(log);}
 const r=JSON.parse(fs.readFileSync(file)),samples=mixed?r.rows.slice(r.warmup):r.timeline;
 const a=samples.map(s=>s.wallMs??s.ms).sort((a,b)=>a-b),units=samples.map(s=>s.units);
 rows.push({scene,variant,repeat,file,mean:a.reduce((s,n)=>s+n,0)/a.length,p95:a[Math.floor(a.length*.95)],p99:a[Math.floor(a.length*.99)],max:a.at(-1),worst5Mean:a.slice(Math.floor(a.length*.95)).reduce((s,n)=>s+n,0)/a.slice(Math.floor(a.length*.95)).length,outliers:r.outliers,minUnits:Math.min(...units),maxUnits:Math.max(...units),hash:r.hash??r.final?.hash,heap:r.heap??r.setup.heap});
 save();console.log(JSON.stringify(rows.at(-1)));
}
(async()=>{
 if(!Number.isInteger(ticks)||!Number.isInteger(warmup)||ticks<=warmup||warmup<0||!Number.isInteger(repeats)||repeats<1)throw Error('Invalid ticks/warmup/repeats');
 if(reference&&!fs.existsSync(reference))throw Error('Missing reference worker');
 for(let repeat=0;repeat<repeats;repeat++)for(const scene of selected){
  const variants=compareTowers?['js','simd']:reference?['reference','current']:['current'];
  for(const variant of repeat%2?variants.slice().reverse():variants)await run(scene,variant,repeat);
  if((reference||compareTowers)&&hash){
   const pair=rows.filter(r=>r.scene===scene&&r.repeat===repeat),match=pair[0].hash===pair[1].hash;
   console.log(scene,'legacy hash match:',match);
   if(process.argv.includes('--require-match'))require('node:assert/strict').ok(match,scene+' exact state hash');
  }
 }
})().catch(e=>{console.error(e);process.exitCode=1;});
