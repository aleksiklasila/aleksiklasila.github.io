// Replay actual movement chunks through the original and current kernels.
// Quiet contacts, old brake history, carried/closing forces and wake-up
// contacts exercise the sleeping shortcut and its general-path fallbacks.
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const H=require('./net-harness.cjs');
const fixture={};vm.runInNewContext(fs.readFileSync(path.join(__dirname,'fixtures/checkerboard-kernels/wasm32.js'),'utf8')+';this.bin=SIM_WASM_BIN;',fixture);
const world=new H.World({controls:{...H.SMALL_MATCH_CONTROLS,'cfg-mapsize':'64'}});
const inst=world.spawn('sleep-replay',{simWorker:false});
inst.scratch.bytes=Buffer.from(fixture.bin,'base64');
inst.eval(`_simWasm64Bytes=()=>null;startSoloGame();gameTick();currentTick++;
    // (The oracle has no unit controller: this compares the movement paths only.)
    _simUnitCtlOn=false;
    for(let j=0;j<32;j++){const u=new Unit('norm',0,(25+j%8)*TILE+8,(25+(j>>3))*TILE+8);units.push(u);updateUnitSpatial(u);}
    spatialIndexRebuild();
    const originalMove=new WebAssembly.Instance(new WebAssembly.Module(__scratch.bytes),{env:{memory:_simWasmMem}}).exports;
    originalMove.__stack_pointer.value=_simHeapTake(SIM_WASM_STACK)+SIM_WASM_STACK;
    const dispatchMove=simParallelRun;
    // The oracle binary predates shared-row stats. Give only that oracle
    // temporary stat columns; production/current kernels allocate none.
    const oracleStats=[[47,0],[125,1],[62,2],[63,3],[140,4]].map(([word,stat])=>({word,stat,array:simHeapArray(Float32Array,_simUnitState.cap)}));
    __scratch.compared=0;
    simParallelRun=function(kernel,total){
        if(kernel!==SIM_KERNEL_MOVE)return dispatchMove(kernel,total);
        for(let chunk=0;chunk<total;chunk++){
            _simMoveWasm(_simParReg,_simParams);
            const arrays=Object.entries(_simParReg).filter(([k,v])=>/^(unit|mv|sep)\\./.test(k)&&ArrayBuffer.isView(v));
            const before=arrays.map(([k,v])=>new Uint8Array(v.buffer,v.byteOffset,v.byteLength).slice());
            const start=chunk*SIM_MOVE_CHUNK,end=Math.min(_simParams[0],start+SIM_MOVE_CHUNK);
            const savedWords=oracleStats.map(e=>_simWasmArgI[e.word]);
            for(const e of oracleStats){for(let s=start;s<end;s++)e.array[s]=simUnitStatValue(_simUnitState.columns,s,e.stat);_simWasmArgI[e.word]=_simWEnc(_simHeapPtrOf(e.array));}
            originalMove.mv_move(_simWasmArgsW,start,end,chunk);
            oracleStats.forEach((e,i)=>_simWasmArgI[e.word]=savedWords[i]);
            const expected=arrays.map(([k,v])=>new Uint8Array(v.buffer,v.byteOffset,v.byteLength).slice());
            arrays.forEach(([k,v],i)=>new Uint8Array(v.buffer,v.byteOffset,v.byteLength).set(before[i]));
            SIM_KERNELS[kernel](_simParReg,_simParams,chunk);
            arrays.forEach(([k,v],i)=>{
                const bytes=new Uint8Array(v.buffer,v.byteOffset,v.byteLength),want=expected[i];
                for(let j=0;j<bytes.length;j++)if(bytes[j]!==want[j])throw Error(k+' byte '+j+' case '+__scratch.caseName);
            });
            __scratch.compared++;
        }
    };
    for(const dk of [1,4,20])for(const kind of ['quiet','brake','carry','closing','flow','wake']){
        simDk=dk;__scratch.caseName=dk+':'+kind;
        const C=_simUnitState.columns,n=_simUnitState.owners.length;
        _sepArrays(n);
        for(let s=0;s<n;s++){
            C.mvOn[s]=0;C.cmMode[s]=0;C.mvOut[s]=0;
            C.x0[s]=C.prevX[s]=C.x[s];C.y0[s]=C.prevY[s]=C.y[s];
            C.sepCx[s]=C.sepCv[s]=C.sepIv[s]=0;
            C.sepMov[s]=kind==='brake'?224:0;
            _sep.hit[s]=s%3?4:0;_sep.ov[s]=C.collisionR[s]*(kind==='wake'?0.8:0.2);
            _sep.px[s]=1234;_sep.py[s]=-2345;_sep.cx[s]=_sep.cy[s]=_sep.fx[s]=_sep.fy[s]=0;
        }
        // (sepCx: x and y as i16 halves, 1/256 px: x 0.25.)
        if(kind==='carry')C.sepCx[4]=64<<16;
        if(kind==='closing')_sep.cx[4]=512;
        if(kind==='flow')_sep.fx[4]=1024;
        _sepPending={tick:currentTick,lane:0};
        simMoveRun();
    }
`);
assert.ok(inst.scratch.compared>=18);
assert.deepEqual(inst.errors.map(String),[]);
console.log('PASS: movement sleep and force fallbacks match the original kernel at dk 1/4/20 ('+inst.scratch.compared+' chunks)');
