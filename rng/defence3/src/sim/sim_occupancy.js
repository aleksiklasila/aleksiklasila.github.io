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
    // (Nothing changed since the last full pass: its arrays bound, as many as the columns have slots. Every spawn made it again:
    // eight bind names and an array of them a unit, 1.4 GB of garbage at 2.3M units.)
    { const F = _occ; if (F !== null && F.fast === _simParRegVer && F.fastCap === _simUnitState.cap && F.epoch === spatialEpoch && F.w === GRID_W * SIM_OCCUPANCY_SUBCELLS && F.h === GRID_H * SIM_OCCUPANCY_SUBCELLS && F.planes === SIM_OCCUPANCY_PLANES) return F; }
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
        for(const [name,Type]of [['x',Int32Array],['y',Int32Array],['radius',Uint8Array],['layer',Uint8Array],['active',Uint8Array],['need',Uint8Array]]){
            const old=O[name],a=O[name]=simHeapArray(Type,n);if(old){a.set(old);simHeapFree(old);}
        }O.cap=n;
    }
    for(const name of ['bits','mask','x','y','radius','layer','active','need'])simParallelBind('occ.'+name,O[name]);
    if(typeof trafficEnsure==='function')trafficEnsure(O);
    O.fast=_simParRegVer;O.fastCap=n;
    return O;
}
// (The arrays' addresses, worked out again only when a binding changed.)
let _occAddr=null,_occAddrVer=-1;
function _occupancyAddresses(){
    if(_occAddr===null||_occAddrVer!==_simParRegVer){_occAddr=_occNames.map(n=>_simWEnc(_simParReg[n].byteOffset));_occAddrVer=_simParRegVer;}
    return _occAddr;
}
function occupancySpawn(u) {
    // (No kernels here, as the world a page keeps beside its simulation
    // worker: no grid; the worker's world has one.)
    if(!SIM_OCCUPANCY_ENABLED||typeof _simWasmX==='undefined'||!_simWasmX)return true;
    const O=occupancyEnsure();if(!O||!u._us)return true;
    const s=u._si;if(O.active[s])return true;
    const x=u._us.x[s],y=u._us.y[s],r=Math.max(1,Math.min(32,Math.ceil((u.collisionR||u.r||1)/(TILE/SIM_OCCUPANCY_SUBCELLS))));
    const layer=O.planes===1?0:Math.min(O.planes-1,u.isFlying?1:u.unitType==='mole'?2:0);
    const A=_occupancyAddresses();
    const ok=_simWasmX.occ_spawn(A[0],A[1],A[2],A[3],A[4],A[5],A[6],O.w,O.h,O.stride,O.cell,O.planes,s,x,y,r,layer,32);
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
// The blocks the occupancy's second stage runs (mv.rs move_job, 36): per
// phase (colour) those with units in the index, heaviest first, so the long
// ones start first and the empty ones (most of a map: ~3k of 4k blocks at
// 200k units) are not run at all. What an empty block's job wrote is written
// here: its post and pushed-unit counts (postc, sexc), its step-charge flag
// (chFix, W a chunk), its cross-block swaps and stats, and the traffic
// inputs all at once (each job cleared its own block's). The order within a
// phase decides nothing: its blocks touch disjoint cells.
function occupancyJobs(postc,sexc,chFix,W){
    const O=_occ,C=O.config,bw=C[5],bh=C[6],jobs=bw*bh,F=O.offsets,k=SIM_OCCUPANCY_XSWAP+1;
    if(!O.jobs||O.jobs.length<jobs+8){if(O.jobs)simHeapFree(O.jobs);O.jobs=simHeapArray(Int32Array,jobs+8);O.jobKeys=new Float64Array(jobs);}
    simParallelBind('occ.jobs',O.jobs);
    const J=O.jobs,K=O.jobKeys;
    O.stats.fill(0,0,jobs*8);
    let n=8;
    for(let p=0;p<4;p++){
        let m=0;J[p]=n-8;
        for(let by=p>>1;by<bh;by+=2)for(let bx=p&1;bx<bw;bx+=2){
            const j=by*bw+bx,c=F[j+1]-F[j];
            if(c>0){K[m++]=(16777216-Math.min(c,16777215))*65536+j;continue;}
            postc[j]=0;if(sexc)sexc[j]=0;if(chFix)chFix[j*W+W-1]=0;O.xswap[j*k]=0;
        }
        const S=K.subarray(0,m);S.sort();
        for(let i=0;i<m;i++)J[n+i]=S[i]%65536;
        J[4+p]=m;n+=m;
    }
    if(_traffic)for(const key of ['workX','workY','workLoss'])_traffic[key].fill(0);
    return J;
}
// Idle units a movement job swapped with in a neighbouring block: their
// tiles in the index (its own epilogue may have run before the swap).
function occupancyAfterMovement(c) {
    const O=_occ,X=O.xswap,jobs=O.config[5]*O.config[6],k=SIM_OCCUPANCY_XSWAP+1;
    for(let j=0;j<jobs;j++){const n=X[j*k];for(let i=1;i<=n;i++)spatialSlotUpdate(c,X[j*k+i]);}
}
// Whether a position write moves unit slot s through the grid: a unit in
// this world's grid (the grid of another world, a rematch's last match,
// swept a restored guest's units from that match's positions and left them
// there), and not while a snapshot is decoded (the grid is rebuilt from the
// decoded positions after it: a resync's units were swept from where the
// diverged peer had them and stopped on the way).
function occupancyTracks(s){
    return _occ!==null&&_occ.epoch===spatialEpoch&&_occ.active[s]===1&&(typeof _snapDec==='undefined'||_snapDec===null);
}
// A jump, not a walk (a portal, a placement): the footprint leaves where it
// stood and is placed at the nearest free spot around (x, y) (Q8), as a
// spawn is; with no room there, back where it stood. (Swept, it stopped at
// the first unit on the way, and a target past its block's halo was
// refused: portal jumps did not happen.)
function occupancyTeleport(u,x,y) {
    const O=_occ,s=u._si,c=u._us,ox=O.x[s],oy=O.y[s],r=O.radius[s],layer=O.layer[s];
    occupancyRelease(u);
    const A=_occupancyAddresses();
    let ok=_simWasmX.occ_spawn(...A,O.w,O.h,O.stride,O.cell,O.planes,s,x,y,r,layer,32);
    if(!ok)ok=_simWasmX.occ_spawn(...A,O.w,O.h,O.stride,O.cell,O.planes,s,ox,oy,r,layer,32);
    if(ok){O.registered++;O.expectedBits+=O.sizes[r];x=O.x[s];y=O.y[s];}
    c.x[s]=x;c.y[s]=y;c.mvSteady[s]=0;c.mvCT[s]=-1;c.mvCD[s]=-1;
}
function occupancyMovePosition(u,x,y) {
    const O=_occ,s=u._si,c=u._us;
    if(x===O.x[s] && y===O.y[s])return;
    // (Farther than any step goes: a jump.)
    if(Math.max(Math.abs(x-O.x[s]),Math.abs(y-O.y[s]))>3*TILE*8){occupancyTeleport(u,x,y);return;}
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
