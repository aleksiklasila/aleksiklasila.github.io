'use strict';
const fs=require('node:fs'),vm=require('node:vm'),cp=require('node:child_process'),path=require('node:path');
const w64=process.argv.includes('--wasm64'),out=process.argv.find(a=>a.startsWith('--out='))?.slice(6);
if(!out)throw Error('Usage: node tests/inspect-occupancy-wasm.cjs [--wasm64] --out=path-prefix');
const ctx={},key=w64?'SIM_WASM64_BIN':'SIM_WASM_BIN';
vm.runInNewContext(fs.readFileSync('src/sim/'+(w64?'sim_wasm64_bin.js':'sim_wasm_bin.js'),'utf8')+';this.bin='+key,ctx);
fs.writeFileSync(out+'.wasm',Buffer.from(ctx.bin,'base64'));
const exe=path.resolve('wasm/tools/binaryen-version_133/bin/wasm-opt.exe');
const r=cp.spawnSync(exe,[out+'.wasm','--all-features','--print','-o',out+'.copy.wasm'],{encoding:'utf8',maxBuffer:64*1024*1024,windowsHide:true});
if(r.status!==0)throw Error(r.stderr);fs.writeFileSync(out+'.wat',r.stdout);
const functions=r.stdout.split(/(?=^ \(func )/m);
const bodies=functions.filter(x=>/^ \(func [^\n]*occ[^\n]*(free_r\d+|mark_r\d+|free_step_r2|free_special|mark_special)/.test(x)).map(x=>({
 name:x.split('\n')[0],ifs:(x.match(/\(if\b/g)||[]).length,conditionalBranches:(x.match(/\(br_if\b/g)||[]).length,
 loops:(x.match(/\(loop\b/g)||[]).length,dispatches:(x.match(/\(br_table\b/g)||[]).length,
 loads32:(x.match(/\(i32.load\b/g)||[]).length,loads64:(x.match(/\(i64.load\b/g)||[]).length,
 stores64:(x.match(/\(i64.store\b/g)||[]).length}));
const vectorOps=functions.filter(x=>/^ \(func [^\n]*(move_job|combat4|step4|occ_prepare)/.test(x)).map(x=>({name:x.split('\n')[0],
 f32x4Ops:(x.match(/\(f32x4\./g)||[]).length,i32x4Ops:(x.match(/\(i32x4\./g)||[]).length}));
fs.writeFileSync(out+'.instructions.json',JSON.stringify({w64,bodies,vectorOps},null,2));
console.log(JSON.stringify({w64,shapeFunctions:bodies.length,fringe:bodies.filter(x=>x.name.includes('free_step_r2')),vectorOps},null,2));
