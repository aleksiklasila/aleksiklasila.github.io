"use strict";
// Occupancy contacts are the default; ?occupancy=0 keeps the comparison path.
// Identity queries keep the existing index; contacts use only this grid.
let SIM_OCCUPANCY_ENABLED = !(typeof location!=='undefined'&&location&&/[?&]occupancy=0(?:&|$)/.test(String(location.search||'')));
let SIM_OCCUPANCY_PLANES = 1, SIM_OCCUPANCY_SUBCELLS = 8, SIM_OCCUPANCY_BLOCK_TILES = 16;
// Per movement job: idle units it swapped with across its block's edge
// (mv.rs traffic_swap; their index entries are moved after the phases).
const SIM_OCCUPANCY_XSWAP = 32;
const SIM_OCCUPANCY_XSWAP_STRIDE = 48; // 33 words rounded to cache lines.
let _occ = null;
// The footprint of a slot is one 16-byte record in occ.rec (Int32 x4: x, y, meta = radius | layer << 8 | active << 16; the fourth word the movement's first stage's results for its second, mv.rs FW_*):
// the second stage's neighbour scans read one line a unit, not one for each of x, y, radius, layer and active.
const _occNames = ['occ.bits','occ.mask','occ.rec'];
function _occActive(O,s){return (O.rec[s*4+2]>>16&255)!==0;}
function _occRadius(O,s){return O.rec[s*4+2]&255;}
function _occLayer(O,s){return O.rec[s*4+2]>>8&255;}
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
        _occ.stats=simHeapArray(Int32Array,(bw*bh+1)*16);
        _occ.offsets=simHeapArray(Int32Array,bw*bh+1);
        _occ.xswap=simHeapArray(Int32Array,bw*bh*SIM_OCCUPANCY_XSWAP_STRIDE);_occ.xswap.fill(0);
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
        for(const [name,Type,per]of [['rec',Int32Array,4]]){
            const old=O[name],a=O[name]=simHeapArray(Type,n*per);if(old){a.set(old);simHeapFree(old);}
        }O.cap=n;
    }
    for(const name of ['bits','mask','rec'])simParallelBind('occ.'+name,O[name]);
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
    const s=u._si;if(_occActive(O,s))return true;
    const x=u._us.x[s],y=u._us.y[s],r=Math.max(1,Math.min(32,Math.ceil((u.collisionR||u.r||1)/(TILE/SIM_OCCUPANCY_SUBCELLS))));
    const layer=O.planes===1?0:Math.min(O.planes-1,u.isFlying?1:u.unitType==='mole'?2:0);
    const A=_occupancyAddresses();
    const ok=_simWasmX.occ_spawn(A[0],A[1],A[2],O.w,O.h,O.stride,O.cell,O.planes,s,x,y,r,layer,32);
    if(!ok){O.rejected++;return false;}
    const fx=O.rec[s*4],fy=O.rec[s*4+1];
    if(fx!==x||fy!==y){O.relocated++;u._us.x[mvtM(s)]=fx;u._us.y[mvtM(s)]=fy;u._us.prevX[s]=fx;u._us.prevY[s]=fy;u._us.x0[s]=fx;u._us.y0[s]=fy;}
    O.spawns++;O.registered++;O.expectedBits+=O.sizes[r];return true;
}
function occupancyRelease(u) {
    const O=_occ;if(!SIM_OCCUPANCY_ENABLED||!O||!u._us||!_occActive(O,u._si))return;
    _simWasmX.occ_release(..._occupancyAddresses(),O.w,O.h,O.stride,O.cell,O.planes,u._si);
    O.registered--;O.expectedBits-=O.sizes[_occRadius(O,u._si)];
}
// Snapshot decoding creates shells and may compact their slots. Rebuild
// the slot-addressed grid only after every restored unit has its stats.
function occupancyRebuild() {
    if(!SIM_OCCUPANCY_ENABLED)return;
    const O=occupancyEnsure();if(!O)return;
    O.bits.fill(0);O.rec.fill(0);
    O.registered=0;O.expectedBits=0;
    if(typeof mvtInvalidate==='function')mvtInvalidate();
    for(const u of units)if(u&&!u.dead&&u._us)occupancySpawn(u);
}
function occupancyPrepareMovement() {
    const O=occupancyEnsure(),C=O.config,bw=C[5],bh=C[6];
    simParallelBind('occ.eslot',_sxESlot);simParallelBind('occ.start',_sxStart);simParallelBind('occ.count',_sxCount);simParallelBind('occ.stamp',_sxStamp);
    simParallelBind('occ.areaGrid',_spatialAreaGridFlat());
    C[11]=_sxEpoch;
    O.stats.fill(0,bw*bh*16);
    // The mover table's rows of the slots written since the last movement,
    // and each block's first place in the jobs' lists (occ.offsets: the
    // blocks' row counts summed up, mvt.rs): a block's job walks its rows.
    mvtBeforeMovement();
    return bw*bh;
}
// The blocks the occupancy's second stage runs (mv.rs move_job, 36): per
// phase (colour) those with units in the index, heaviest first, so the long
// ones start first and the empty ones (most of a map: ~3k of 4k blocks at
// 200k units) are not run at all. What an empty block's job wrote is written
// here: its post and pushed-unit counts (postc, sexc), its step-charge flag
// (chFix, W a chunk), its cross-block swaps and stats, and the traffic
// inputs all at once (each job cleared its own block's). The order within a
// phase decides nothing: its blocks touch disjoint cells.
const _occJobsP=new Float64Array(4);
function occupancyJobs(postc,sexc,chFix,W){
    const O=_occ,C=O.config,bw=C[5],bh=C[6],jobs=bw*bh,F=O.offsets,k=SIM_OCCUPANCY_XSWAP_STRIDE;
    if(!O.jobs||O.jobs.length<jobs+8){if(O.jobs)simHeapFree(O.jobs);O.jobs=simHeapArray(Int32Array,jobs+8);}
    simParallelBind('occ.jobs',O.jobs);
    const J=O.jobs;
    O.stats.fill(0,0,jobs*16);
    // (Each phase's blocks with units, heaviest first; the empty ones' outputs cleared: jobs.rs.)
    const P=_occJobsP;P[0]=bw;P[1]=bh;P[2]=W;P[3]=k;
    simRustDirect('k_occ_jobs',[F,J,postc,sexc,chFix,O.xswap],P);
    if(_traffic)for(const key of ['workX','workY','workLoss'])_traffic[key].fill(0);
    return J;
}
// Idle units a movement job swapped with in a neighbouring block: their
// tiles in the index (its own epilogue may have run before the swap).
function occupancyAfterMovement(c) {
    const O=_occ,X=O.xswap,jobs=O.config[5]*O.config[6],k=SIM_OCCUPANCY_XSWAP_STRIDE;
    for(let j=0;j<jobs;j++){const n=X[j*k];for(let i=1;i<=n;i++)spatialSlotUpdate(c,X[j*k+i]);}
}
// Whether a position write moves unit slot s through the grid: a unit in
// this world's grid (the grid of another world, a rematch's last match,
// swept a restored guest's units from that match's positions and left them
// there), and not while a snapshot is decoded (the grid is rebuilt from the
// decoded positions after it: a resync's units were swept from where the
// diverged peer had them and stopped on the way).
function occupancyTracks(s){
    return _occ!==null&&_occ.epoch===spatialEpoch&&(_occ.rec[s*4+2]>>16&255)===1&&(typeof _snapDec==='undefined'||_snapDec===null);
}
// A jump, not a walk (a portal, a placement): the footprint leaves where it
// stood and is placed at the nearest free spot around (x, y) (Q8), as a
// spawn is; with no room there, back where it stood. (Swept, it stopped at
// the first unit on the way, and a target past its block's halo was
// refused: portal jumps did not happen.)
function occupancyTeleport(u,x,y) {
    const O=_occ,s=u._si,c=u._us,ox=O.rec[s*4],oy=O.rec[s*4+1],r=_occRadius(O,s),layer=_occLayer(O,s);
    occupancyRelease(u);
    const A=_occupancyAddresses();
    let ok=_simWasmX.occ_spawn(...A,O.w,O.h,O.stride,O.cell,O.planes,s,x,y,r,layer,32);
    if(!ok)ok=_simWasmX.occ_spawn(...A,O.w,O.h,O.stride,O.cell,O.planes,s,ox,oy,r,layer,32);
    if(ok){O.registered++;O.expectedBits+=O.sizes[r];x=O.rec[s*4];y=O.rec[s*4+1];}
    c.x[mvtM(s)]=x;c.y[mvtM(s)]=y;{const r=s*SIM_STEER_W;c.mvSteer[mvtS(r+SIM_ST_STEADY)]=0;c.mvSteer[mvtS(r+SIM_ST_CT)]=-1;c.mvSteer[mvtS(r)]=-1;}
}
// (The five arrays' encoded addresses for the move below, worked out again
// only when a binding changed: five calls and a registry lookup each, a move.)
let _occMoveEnc=null,_occMoveEncVer=-1,_occMoveEncO=null;
function occupancyMovePosition(u,x,y) {
    const O=_occ,s=u._si,c=u._us,rec=O.rec;
    if(x===rec[s*4] && y===rec[s*4+1])return;
    // (Farther than any step goes: a jump.)
    if(Math.max(Math.abs(x-rec[s*4]),Math.abs(y-rec[s*4+1]))>3*TILE*8){occupancyTeleport(u,x,y);return;}
    // Same bitmap operation for JS-only movement; called at the coordinate
    // write, with helpers idle. It never scans another unit.
    let E=_occMoveEnc;
    if(E===null||_occMoveEncVer!==_simParRegVer||_occMoveEncO!==O){
        E=_occMoveEnc=[];for(let i=0;i<_occNames.length;i++)E.push(_simWEnc(_simParReg[_occNames[i]].byteOffset));
        E.push(_simWEnc(O.stats.byteOffset),_simWEnc(O.config.byteOffset));_occMoveEncVer=_simParRegVer;_occMoveEncO=O;
    }
    const I=_simWasmArgI;
    I[512]=E[0];I[513]=E[1];I[514]=E[2];I[512+28]=E[3];I[512+33]=E[4];
    _simWasmX.occ_move_one(_simWasmArgsW,s,x,y);
    // (Where the footprint ended is its record: the position it returned.)
    const nx=rec[s*4],ny=rec[s*4+1];
    c.x[mvtM(s)]=nx;c.y[mvtM(s)]=ny;
    if(nx!==x || ny!==y){const r=s*SIM_STEER_W;c.mvSteer[mvtS(r+SIM_ST_STEADY)]=0;c.mvSteer[mvtS(r+SIM_ST_CT)]=-1;c.mvSteer[mvtS(r)]=-1;}
}
function occupancyAudit() {
    const O=_occ;if(!O)return null;
    const actualBits=_simWasmX.occ_count(_simWEnc(O.bits.byteOffset),O.bits.length);
    const c=_simUnitState.columns;let activeUnits=0,positionMismatches=0;
    for(let s=0;s<O.cap;s++)if(_occActive(O,s)){activeUnits++;if(c.x[s]!==O.rec[s*4]||c.y[s]!==O.rec[s*4+1])positionMismatches++;}
    return {actualBits,expectedBits:O.expectedBits,registered:O.registered,activeUnits,positionMismatches,ok:actualBits===O.expectedBits&&activeUnits===O.registered&&positionMismatches===0};
}
function occupancyStats() {
    const O=_occ;if(!O)return null;const counts=new Array(8).fill(0);
    if(O.stats)for(let i=0;i<O.stats.length;i++)counts[i&7]+=O.stats[i];
    return {planes:O.planes,cellPixels:O.cell/8,gridMiB:O.bits.byteLength/1048576,spawns:O.spawns,rejectedSpawns:O.rejected,relocatedSpawns:O.relocated,
        registered:O.registered,visited:counts[0],attempted:counts[1],moved:counts[2],blockedOrClipped:counts[3],simdGroups:counts[4],overHalo:counts[5],footprintMoves:counts[6],scalarLanes:counts[7]};
}

// ---- The mover table (wasm/src/mvt.rs; MOVE_OCCUPANCY_OPTIMIZATION_PLAN.md stage 3) ----
// One row a live unit, kept by the occupancy's blocks: the movement's block
// jobs (mv.rs move_job) walk their block's rows, not the tile index. A row
// is made from the unit's columns (mvt.rs row_of: x, y, id, live, dead, its
// footprint record's radius, layer and active, owner). The
// rule: whoever writes one of those outside the movement marks the slot
// (mvtM, or mvt.dirty in a kernel); the rows of marked slots are made again
// before the movement (mvtSync: on the helpers). The movement keeps the rows' positions
// itself, where it writes the footprint records. ?mvt=2 audits every row
// against the columns before and after each movement and throws on a
// difference (the tests' MVT=2); ?mvt=3 collects the differences.
let SIM_MVT = (typeof location !== 'undefined' && location && (/[?&]mvt=(\d)(?:&|$)/.exec(String(location.search || '')) || [])[1]) | 0;
let _mvt = null;
const MVT_SLAB = 64, MVT_ROW_W = 8;
// (The sync's scan: slots a job, mvt.rs SCAN: the movement's first stage's chunk; its block pass: blocks a job.)
const MVT_SCAN = 512, MVT_APPLY = 16;
const MVT_FIELDS = ['x', 'y', '-', 'slot', 'id', '-', 'radius|layer|footprint', 'owner'];
function mvtEnsure() {
    if (!SIM_OCCUPANCY_ENABLED || typeof _simUnitState === 'undefined' || !_simUnitState) return null;
    const O = occupancyEnsure();
    if (!O) return null;
    const cap = _simUnitState.cap, C = O.config, bw = C[5], bh = C[6];
    let M = _mvt;
    if (M !== null && M.cap === cap && M.bw === bw && M.bh === bh && M.grid === C && M.cols === _simUnitState.columns) return M;
    if (M !== null) for (const a of Object.values(M)) if (ArrayBuffer.isView(a) && a !== M.P) simHeapFree(a);
    if (SIM_MOVE_CHUNK !== MVT_SCAN) throw new Error('the mover table scans by the movement chunk: ' + SIM_MOVE_CHUNK);
    // (Sized once from the slots' capacity: a block's partial slab is the only slack; a slab a block more, so the
    // sync's blocks can put rows in before the others have given theirs back.)
    const slabs = Math.ceil(cap / MVT_SLAB) + 2 * bw * bh;
    M = _mvt = { cap, bw, bh, grid: C, cols: _simUnitState.columns, slabs, whole: false, P: new Float64Array(4),
        cfg: simHeapArray(Int32Array, 64), hrow: simHeapArray(Int32Array, cap), dirty: simHeapArray(Uint8Array, cap + 16),
        bhead: simHeapArray(Int32Array, bw * bh), btail: simHeapArray(Int32Array, bw * bh), bcount: simHeapArray(Int32Array, bw * bh),
        snext: simHeapArray(Int32Array, slabs), sprev: simHeapArray(Int32Array, slabs), rows: simHeapArray(Int32Array, slabs * MVT_SLAB * MVT_ROW_W),
        // (The sync, mvt.rs: per scan job the slots to put in a block's rows with their positions (lst, two words each; lcnt), per block the rows taken away and put in (rmc, inc), the entries by block (ins, ioff), the blocks with any (jobs).)
        lst: simHeapArray(Int32Array, Math.ceil(cap / MVT_SCAN) * MVT_SCAN * 2), lcnt: simHeapArray(Int32Array, Math.ceil(cap / MVT_SCAN) + 1),
        rmc: simHeapArray(Int32Array, bw * bh), inc: simHeapArray(Int32Array, bw * bh + 1), ioff: simHeapArray(Int32Array, bw * bh + 1), ins: simHeapArray(Int32Array, Math.ceil(cap / MVT_SCAN) * MVT_SCAN), jobs: simHeapArray(Int32Array, bw * bh),
        // (The movement's first stage's marks for the block jobs, a bit a slot: mv.rs mark_need.)
        needb: simHeapArray(Uint32Array, (cap >> 5) + 2) };
    M.needb.fill(0); simParallelBind('occ.needb', M.needb);
    M.cfg.fill(0); M.cfg.set([cap, slabs, bw, bh, C[7] * C[15] * C[14]]);
    M.hrow.fill(-1); M.dirty.fill(0); M.lcnt.fill(0); M.rmc.fill(0); M.inc.fill(0);
    // (For the movement's jobs, and the kernels that mark slots themselves.)
    for (const k of ['cfg', 'hrow', 'dirty', 'bhead', 'snext', 'bcount', 'rows']) simParallelBind('mvt.' + k, M[k]);
    _mvtDirty = M.dirty; _mvtWhole = false;
    return M;
}
function _mvtArrays(M) {
    const c = _simUnitState.columns;
    // ([24] occ.offsets: each block's first place in the jobs' lists, its rows before it: written by the rebuild and the sync.)
    return [M.cfg, M.hrow, M.dirty, M.bhead, M.btail, M.bcount, M.snext, M.sprev, M.rows, c.x, c.y, c.id, c.live, c.dead, _occ.rec, c.owner,
        M.lst, M.lcnt, M.rmc, M.inc, M.ins, M.jobs, M.ioff, null, _occ.offsets];
}
// (The arrays' addresses in the table's own header: the movement's first stage has one argument word for the table, mvt.rs C_ADDR.)
function _mvtAddr(M) {
    const A = _mvtArrays(M), C = M.cfg;
    for (let i = 0; i < A.length; i++) C[16 + i] = A[i] ? _simWEnc(_simHeapPtrOf(A[i])) : 0;
}
function _mvtRun(M, fn) {
    // (Every slot of the capacity: the count of slots in use shrinks when the last ones are let go, and their marks are past it then.)
    M.P[0] = M.cap;
    simRustDirect(fn, _mvtArrays(M), M.P);
}
// The marked slots' rows made again (mvt.rs). In a movement: the scan is part of the first stage's slot chunks (a
// row in the same block written in place; else marked gone and listed with its position for its new block); after
// that stage, mvtSyncFinish: the plan (the blocks with changes, the listed entries by block, occ.offsets: one small
// job here) and the block pass on the helpers (their rows closed up, the listed ones put in). n: the slots the
// scan covered. M.two (a test's): the block pass in two rounds, as when the free slabs run short.
function mvtSyncFinish(M, n) {
    const A = _mvtArrays(M), P = M.P;
    // (simRustParallel puts its selector in the kernels' shared params, which the movement has filled by now: its word kept.)
    const p0 = _simParams[0];
    P[0] = n; P[1] = 3;
    simRustDirect('mvt_sync_plan', A, P);
    // (mvt.rs APPLY blocks a job.)
    const jobs = Math.ceil(M.cfg[14] / MVT_APPLY);
    if (jobs > 0) {
        if (M.cfg[15] !== 0 || M.two) { P[1] = 1; simRustParallel(SIM_BLOCK_MVT_APPLY, A, P, jobs); P[1] = 2; simRustParallel(SIM_BLOCK_MVT_APPLY, A, P, jobs); }
        else simRustParallel(SIM_BLOCK_MVT_APPLY, A, P, jobs);
        M.cfg[14] = 0;
    }
    _simParams[0] = p0;
}
// The whole sync outside a movement (the tests'): the scan as a kernel of its own over every slot.
function mvtSync(M) {
    const A = _mvtArrays(M), P = M.P, p0 = _simParams[0];
    P[0] = M.cap; P[1] = 3;
    simRustParallel(SIM_BLOCK_MVT_SCAN, A, P, Math.ceil(M.cap / MVT_SCAN));
    _simParams[0] = p0;
    mvtSyncFinish(M, M.cap);
}
// Between the movement's two stages (unit.js simMoveRun): the first stage's chunks have scanned their slots' marks.
function mvtAfterFirstStage(n) {
    const M = _mvt;
    if (M === null || !M.whole) return;
    mvtSyncFinish(M, n);
    // (?mvt=3: every kind of difference reported once, the table made whole, the run goes on: finding the writers without a mark.)
    if (SIM_MVT === 3) { const r = mvtCheck(1); if (r !== null) { const k = r.differs.join(','), L = M.seen || (M.seen = {}); if (!L[k]) { L[k] = 1; r.tick = typeof currentTick !== 'undefined' ? currentTick : -1; if (typeof __scratch !== 'undefined') (__scratch.mvtSeen || (__scratch.mvtSeen = [])).push(r); } _mvtRun(M, 'mvt_rebuild'); } }
    else if (SIM_MVT >= 2) mvtAudit('between the movement\'s stages', 1);
}
// Before the movement's kernels: the table made whole after a restore or at its first use; else the marked
// slots' rows are made again by the first stage and mvtAfterFirstStage.
function mvtBeforeMovement() {
    const M = mvtEnsure();
    if (M === null) return;
    _mvtAddr(M);
    if (!_mvtWhole || !M.whole) { _mvtRun(M, 'mvt_rebuild'); M.whole = _mvtWhole = true; }
}
// After the movement (?mvt=2): the rows it wrote against the columns it wrote.
function mvtAfterMovement() {
    if (SIM_MVT === 2 && _mvt !== null && _mvt.whole && _mvtWhole) mvtAudit('after the movement');
}
// Every row against the columns (mvt.rs mvt_audit): null when equal, else what differs at the first slot.
function mvtCheck(mid) {
    const M = _mvt;
    if (M === null || !M.whole) return null;
    M.P[1] = mid ? 1 : 0;
    _mvtRun(M, 'mvt_audit');
    M.audits = (M.audits | 0) + 1; M.rowsSeen = M.cfg[11];
    const bad = M.cfg[8];
    if (!bad) return null;
    const s = M.cfg[9], bits = M.cfg[10], what = [];
    for (let f = 0; f < MVT_ROW_W; f++) if (bits & (1 << f)) {
        const h = M.hrow[s], at = (h >> 6) * MVT_SLAB * MVT_ROW_W + f * MVT_SLAB + (h & 63);
        what.push(MVT_FIELDS[f] + ' (row ' + (h >= 0 ? M.rows[at] : '-') + ')');
    }
    if (bits & 65536) what.push('a row for no unit');
    if (bits & 131072) what.push('a unit without a row');
    if (bits & 262144) what.push("another slot's row");
    if (bits & 524288) what.push("a block's chain or count");
    const c = _simUnitState.columns, u = _simUnitState.owners.at(s);
    return { slots: bad, slot: s, hrow: M.hrow[s], count: _simUnitState.owners.length, cap: M.cap, rows: M.cfg[6], seen: M.cfg[11], differs: what, unit: u ? u.unitType + ' ' + u.id : null,
        columns: { x: c.x[s], y: c.y[s], id: c.id[s], live: c.live[s], dead: c.dead[s], rec: _occ.rec[s * 4 + 2], owner: c.owner[s] } };
}
function mvtAudit(where, mid) {
    const r = mvtCheck(mid);
    if (r !== null) throw new Error('mover table differs from the columns ' + where + ' (tick ' + (typeof currentTick !== 'undefined' ? currentTick : '?') + '): ' + JSON.stringify(r));
}
