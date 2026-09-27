// Warmed, alternating before/after measurements of the real Ctrl-click union.
// Excludes hit testing, panel rendering and simulation; no timing assertions.
const fs=require('node:fs');const path=require('node:path');const {execFileSync}=require('node:child_process');const assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..');
const prefix=execFileSync('git',['rev-parse','--show-prefix'],{cwd:root,encoding:'utf8'}).trim();
const ref=process.env.DEFENCE_BENCH_BASELINE||'HEAD';
const sources={before:execFileSync('git',['show',ref+':'+prefix+'src/main.js'],{cwd:root,encoding:'utf8'}),after:fs.readFileSync(path.join(root,'src/main.js'),'utf8')};
const result=[];
for(const n of [50,1500,6000,12000]) {
    const cases=Object.fromEntries(Object.entries(sources).map(([label,source])=>{
        const start=source.indexOf('    function toggleVisibleSameTypeSelectionFromHit('),end=source.indexOf('\n    function ',start+1);
        const run=new Function('n',`let group=Array.from({length:n},(_,id)=>({id})),selectedUnits=[],selectedEntities=[];
            let getVisibleSameTypeUnits=()=>group,getVisibleSameTypeEntities=()=>group;
            ${source.slice(start,end)}
            return ()=>{selectedUnits=group.slice(1,Math.floor(n/2));const t=performance.now();toggleVisibleSameTypeSelectionFromHit({kind:'unit',ref:group[0]});const ms=performance.now()-t;
                if(selectedUnits.length!==n || new Set(selectedUnits).size!==n)throw Error('selection mismatch');return ms;};`)(n);
        for(let warm=0;warm<10;warm++)run();return[label,run];
    }));
    for(let repeat=0;repeat<3;repeat++) {
        const row={n,repeat};
        for(const k of repeat%2?['after','before']:['before','after']) {
            const samples=Array.from({length:30},()=>cases[k]()).sort((a,b)=>a-b);
            row[k]={mean:samples.reduce((a,b)=>a+b,0)/samples.length,p95:samples[28],max:samples.at(-1)};
        }
        result.push(row);
    }
}
assert.equal(result.length,12);
console.log(JSON.stringify({benchmark:'Ctrl-click same-type union, half already selected',ref,node:process.version,cpu:require('node:os').cpus()[0].model,result}));
