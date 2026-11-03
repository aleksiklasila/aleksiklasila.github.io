'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const H = require('./net-harness.cjs');

// Test the ABI boundary without committing a multi-gigabyte test heap.
const source = fs.readFileSync(require('node:path').join(__dirname, '../src/game/flownav.js'), 'utf8');
const wrapperSource = source.slice(source.indexOf('function _navRust('), source.indexOf('SIM_KERNELS[SIM_KERNEL_NAV_CHAIN]', source.indexOf('function _navRust(')));
const context = vm.createContext({ _simWasmArgI: new Int32Array(1024), SIM_RUST_W0:512, _simWEnc:p=>p });
vm.runInContext(wrapperSource, context);
const offsets = new Int32Array(64); offsets[16]=256; offsets[17]=1024;
context._navRust([16,17,18],offsets,0x80000000);
assert.equal(context._simWasmArgI[512]>>>0,0x80000100,'upper-half wasm32 arena address');
assert.equal(context._simWasmArgI[513]>>>0,0x80000400,'header offset resolved without signed truncation');
assert.equal(context._simWasmArgI[514],0,'absent cost pointer remains null');

const world = new H.World({controls:H.SMALL_MATCH_CONTROLS});
const inst = world.spawn('memory-regressions', {simWorker:false});
inst.eval('startSoloGame();');
const result = inst.eval(`(() => {
 const reservations = workerReservedTiles;
 reservations[0] = 123;
 _invalidateWorkerTargetLoadCache();
 if(workerReservedTiles!==reservations||workerReservedTiles[0]!==0)throw Error('Worker reservation reset replaced its map-sized buffer or retained stale entries');
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
 return {before,after,reservedSlots:_simUnitState.cap,populationSlots:simUnitPopulationSlots()};
})()`);
assert.equal(result.after, result.before);
// Match-start reservation replaced the old 512 MB speculative cap: all
// configured slots must already exist, rather than growing during play.
assert.ok(result.reservedSlots >= result.populationSlots, 'configured unit slots reserved at match start');
assert.deepEqual(inst.errors.map(String), []);
console.log('PASS memory allocation regressions', result);
