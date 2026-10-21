"use strict";
// Occupancy contacts are the default; ?occupancy=0 keeps the comparison path.
// Identity queries keep the existing index; contacts use only this grid.
let SIM_OCCUPANCY_ENABLED = !(typeof location!=='undefined'&&location&&/[?&]occupancy=0(?:&|$)/.test(String(location.search||'')));
let SIM_OCCUPANCY_PLANES = 1, SIM_OCCUPANCY_SUBCELLS = 8, SIM_OCCUPANCY_BLOCK_TILES = 16;
// Per movement job: idle units it swapped with across its block's edge
// (mv.rs traffic_swap; their index entries are moved after the phases).
const SIM_OCCUPANCY_XSWAP = 32;
let _occ = null;
const _occNames = ['occ.bits','occ.mask','occ.x','occ.y','occ.radius','occ.layer','occ.active'];
function occupancyEnsure() {
    if (!SIM_OCCUPANCY_ENABLED || typeof _simUnitState === 'undefined' || !_simUnitState) return null;
    const w=GRID_W*SIM_OCCUPANCY_SUBCELLS,h=GRID_H*SIM_OCCUPANCY_SUBCELLS,stride=Math.ceil(w/32)+1,planes=SIM_OCCUPANCY_PLANES;
    if(!_occ || _occ.w!==w || _occ.h!==h || _occ.planes!==planes || _occ.epoch!==spatialEpoch) {
        if(_occ)for(const a of Object.values(_occ))if(ArrayBuffer.isView(a))simHeapFree(a);
        _occ={w,h,stride,planes,epoch:spatialEpoch,cell:Math.round(TILE*8/SIM_OCCUPANCY_SUBCELLS),cap:0,spawns:0,rejected:0,relocated:0,expectedBits:0,registered:0};
        if(_occ.cell<1 || (_occ.cell&(_occ.cell-1)))throw Error('Occupancy cell size must be a power of two');
        _occ.bits=simHeapArray(Uint32Array,stride*h*planes);
        const block=Math.max(16,SIM_OCCUPANCY_BLOCK_TILES),bw=Math.ceil(CHUNKS_W/block),bh=Math.ceil(CHUNKS_H/block);
        _occ.config=simHeapArray(Int32Array,16);
        _occ.config.set([w,h,stride,_occ.cell,planes,bw,bh,block,0,CHUNKS_W,CHUNKS_H,_sxEpoch,GRID_W,GRID_H,TILE*8,CHUNK_SIZE]);
        _occ.stats=simHeapArray(Int32Array,(bw*bh+1)*8);
        _occ.offsets=simHeapArray(Int32Array,bw*bh+1);
        _occ.xswap=simHeapArray(Int32Array,bw*bh*(SIM_OCCUPANCY_XSWAP+1));_occ.xswap.fill(0);
        for(const name of ['config','stats','offsets','xswap'])simParallelBind('occ.'+name,_occ[name]);
        _occ.mask=simHeapArray(Int8Array,33*65);_occ.mask.fill(-1);
        _occ.sizes=new Array(33).fill(0);
        for(let r=1;r<=32;r++)for(let dy=-r;dy<=r;dy++){
            let hw=-1;for(let dx=0;dx<r;dx++)if(dx*dx+dy*dy<r*r)hw=dx;
            _occ.mask[r*65+dy+32]=hw;
            if(hw>=0)_occ.sizes[r]+=hw*2+1;
        }
    }
    const O=_occ,n=_simUnitState.cap;
    if(O.cap<n){
        for(const [name,Type]of [['x',Int32Array],['y',Int32Array],['radius',Uint8Array],['layer',Uint8Array],['active',Uint8Array]]){
            const old=O[name],a=O[name]=simHeapArray(Type,n);if(old){a.set(old);simHeapFree(old);}
        }O.cap=n;
    }
    for(const name of ['bits','mask','x','y','radius','layer','active'])simParallelBind('occ.'+name,O[name]);
    if(typeof trafficEnsure==='function')trafficEnsure(O);
    return O;
}
function _occupancyAddresses(){return _occNames.map(n=>_simWEnc(_simParReg[n].byteOffset));}
function occupancySpawn(u) {
    if(!SIM_OCCUPANCY_ENABLED)return true;
    const O=occupancyEnsure();if(!O||!u._us)return true;
    const s=u._si;if(O.active[s])return true;
    const x=u._us.x[s],y=u._us.y[s],r=Math.max(1,Math.min(32,Math.ceil((u.collisionR||u.r||1)/(TILE/SIM_OCCUPANCY_SUBCELLS))));
    const layer=O.planes===1?0:Math.min(O.planes-1,u.isFlying?1:u.unitType==='mole'?2:0);
    const ok=_simWasmX.occ_spawn(..._occupancyAddresses(),O.w,O.h,O.stride,O.cell,O.planes,s,x,y,r,layer,32);
    if(!ok){O.rejected++;return false;}
    if(O.x[s]!==x||O.y[s]!==y){O.relocated++;u._us.x[s]=O.x[s];u._us.y[s]=O.y[s];u._us.prevX[s]=O.x[s];u._us.prevY[s]=O.y[s];u._us.x0[s]=O.x[s];u._us.y0[s]=O.y[s];}
    O.spawns++;O.registered++;O.expectedBits+=O.sizes[r];return true;
}
function occupancyRelease(u) {
    const O=_occ;if(!SIM_OCCUPANCY_ENABLED||!O||!u._us||!O.active[u._si])return;
    _simWasmX.occ_release(..._occupancyAddresses(),O.w,O.h,O.stride,O.cell,O.planes,u._si);
    O.registered--;O.expectedBits-=O.sizes[O.radius[u._si]];
}
// Snapshot decoding creates shells and may compact their slots. Rebuild
// the slot-addressed grid only after every restored unit has its stats.
function occupancyRebuild() {
    if(!SIM_OCCUPANCY_ENABLED)return;
    const O=occupancyEnsure();if(!O)return;
    O.bits.fill(0);O.active.fill(0);O.radius.fill(0);O.layer.fill(0);
    O.registered=0;O.expectedBits=0;
    for(const u of units)if(u&&!u.dead&&u._us)occupancySpawn(u);
}
function occupancyPrepareMovement() {
    const O=occupancyEnsure(),C=O.config,bw=C[5],bh=C[6];
    simParallelBind('occ.eslot',_sxESlot);simParallelBind('occ.start',_sxStart);simParallelBind('occ.count',_sxCount);simParallelBind('occ.stamp',_sxStamp);
    simParallelBind('occ.areaGrid',_spatialAreaGridFlat());
    C[11]=_sxEpoch;
    O.stats.fill(0,bw*bh*8);
    // Prefix sizes only reserve each spatial job's hit/post list. No units
    // are visited here; occupancy work happens at position writes in WASM.
    // (The blocks' counts on the helpers, summed up here: 4096 entries.)
    // (64 blocks a chunk: occ.rs OCC_COUNT_BLOCKS; the movement's params,
    // already set, are not touched.)
    const jobs=bw*bh,per=64,F=O.offsets;
    simParallelRun(SIM_KERNEL_OCC_COUNTS,Math.ceil(jobs/per));
    let total=0;
    for(let j=0;j<jobs;j++){const c=F[j];F[j]=total;total+=c;}
    F[jobs]=total;
    return jobs;
}
// Idle units a movement job swapped with in a neighbouring block: their
// tiles in the index (its own epilogue may have run before the swap).
function occupancyAfterMovement(c) {
    const O=_occ,X=O.xswap,jobs=O.config[5]*O.config[6],k=SIM_OCCUPANCY_XSWAP+1;
    for(let j=0;j<jobs;j++){const n=X[j*k];for(let i=1;i<=n;i++)spatialSlotUpdate(c,X[j*k+i]);}
}
function occupancyMovePosition(u,x,y) {
    const O=_occ,s=u._si,c=u._us;
    if(x===O.x[s] && y===O.y[s])return;
    // Same bitmap operation for JS-only movement; called at the coordinate
    // write, with helpers idle. It never scans another unit.
    for(let i=0;i<_occNames.length;i++)_simWasmArgI[512+i]=_simWEnc(_simParReg[_occNames[i]].byteOffset);
    _simWasmArgI[512+28]=_simWEnc(O.stats.byteOffset);_simWasmArgI[512+33]=_simWEnc(O.config.byteOffset);
    const pos=_simWasmX.occ_move_one(_simWasmArgsW,s,x,y);
    c.x[s]=Number(BigInt.asIntN(32,pos));c.y[s]=Number(BigInt.asIntN(32,pos>>32n));
    if(c.x[s]!==x || c.y[s]!==y){c.mvSteady[s]=0;c.mvCT[s]=-1;c.mvCD[s]=-1;}
}
function occupancyAudit() {
    const O=_occ;if(!O)return null;
    const actualBits=_simWasmX.occ_count(_simWEnc(O.bits.byteOffset),O.bits.length);
    const c=_simUnitState.columns;let activeUnits=0,positionMismatches=0;
    for(let s=0;s<O.cap;s++)if(O.active[s]){activeUnits++;if(c.x[s]!==O.x[s]||c.y[s]!==O.y[s])positionMismatches++;}
    return {actualBits,expectedBits:O.expectedBits,registered:O.registered,activeUnits,positionMismatches,ok:actualBits===O.expectedBits&&activeUnits===O.registered&&positionMismatches===0};
}
function occupancyStats() {
    const O=_occ;if(!O)return null;const counts=new Array(8).fill(0);
    if(O.stats)for(let i=0;i<O.stats.length;i++)counts[i&7]+=O.stats[i];
    return {planes:O.planes,cellPixels:O.cell/8,gridMiB:O.bits.byteLength/1048576,spawns:O.spawns,rejectedSpawns:O.rejected,relocatedSpawns:O.relocated,
        registered:O.registered,visited:counts[0],attempted:counts[1],moved:counts[2],blockedOrClipped:counts[3],simdGroups:counts[4],overHalo:counts[5],footprintMoves:counts[6],scalarLanes:counts[7]};
}
