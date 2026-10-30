'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const H = require('./net-harness.cjs');

// Test the ABI boundary without committing a multi-gigabyte test heap.
const source = fs.readFileSync(require('node:path').join(__dirname, '../src/game/flownav.js'), 'utf8');
const headerSource = source.slice(source.indexOf('function navAtlasHeader('), source.indexOf('// The next tile from', source.indexOf('function navAtlasHeader(')));
const context = vm.createContext({ _navArr: (Type, n) => new Type(n), _simWEnc: p => p, _simHeapPtrOf: a => a?.ptr ?? -1 });
vm.runInContext(headerSource, context);
const names = ['bm','bc','cb','co','ct','anc','cip','cin','rco','rc','dn','cn','didx'];
const atlas = Object.fromEntries(names.map((n, i) => [n, { ptr: 0x80000000 + i * 64 }]));
Object.assign(atlas, { L: 3, C: 32, cw: 32, bw: 125, np: 1024 });
const header = context.navAtlasHeader(atlas, {ptr:0xfffffe00}, {ptr:0xffffff00});
assert.ok(header, 'upper-half wasm32 pointers must retain the atlas');
assert.equal(header[5] >>> 0, 0x80000000);
assert.equal(header[19] >>> 0, 0xffffff00);
assert.equal(context.navAtlasHeader({...atlas, ct: {ptr:-1}}, {ptr:64}, {ptr:128}), null, 'outside-heap arrays rejected');

const world = new H.World({controls:H.SMALL_MATCH_CONTROLS});
const inst = world.spawn('memory-regressions', {simWorker:false});
inst.eval('startSoloGame();');
const result = inst.eval(`(() => {
 const before = simMemoryStats().workerRecords;
 const army = [];
 for (let n=0;n<200;n++) army.push(new Unit('norm',0,5*TILE,5*TILE));
 const after = simMemoryStats().workerRecords;
 if(army.some(u=>u._us.wkIx[u._si]!==0||u._idleFailUntil!==0))throw Error('Combat unit allocated worker memory');
 const u=army[0];u._idleFailUntil=123;
 if(u._idleFailUntil!==123||u._us.wkIx[u._si]<=0)throw Error('Non-default timer was not retained');
 u._idleFailUntil=0;
 if(u._idleFailUntil!==0)throw Error('Timer did not clear');
 u._idleFailUntil=undefined;
 if(u._idleFailUntil!==undefined)throw Error('Explicit unset timer was not retained');
 const worker=new Unit('collector',0,6*TILE,5*TILE);configureWorkerUnitFromType(worker);
 if(!worker._us.wkIx[worker._si]||worker._idleFailUntil!==0)throw Error('Worker defaults changed');
 return {before,after,reserveBytes:_simUnitReserveBytes(1000000)};
})()`);
assert.equal(result.after, result.before);
assert.ok(result.reserveBytes <= 512 * 1024 * 1024, 'speculative slots must leave memory for gameplay');
assert.deepEqual(inst.errors.map(String), []);
console.log('PASS memory allocation regressions', result);
