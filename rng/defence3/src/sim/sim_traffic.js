"use strict";
// 0: previous occupation behavior, 1: local fan-out, 2: coarse pressure,
// 3: pressure + local fan-out. Fields are independent of team/destination.
let SIM_TRAFFIC_MODE=typeof location!=='undefined'&&/[?&]traffic=[0-3](?:&|$)/.test(location.search||'')?
    Number((location.search.match(/[?&]traffic=([0-3])/)||[])[1]):3;
let SIM_TRAFFIC_RESPONSE=typeof location!=='undefined'&&/[?&]trafficResponse=0(?:&|$)/.test(location.search||'')?0:1;
let SIM_TRAFFIC_PASSES=typeof location!=='undefined'&&/[?&]trafficPasses=1(?:&|$)/.test(location.search||'')?1:2;
let SIM_TRAFFIC_LOCAL=typeof location!=='undefined'&&/[?&]trafficLocal=0(?:&|$)/.test(location.search||'')?0:1;
// Push records (traffic.rs push_deposit): words a tile.
const SIM_TRAFFIC_PUSH_WORDS=5;
let _traffic=null;
function trafficReset(){
    const T=_traffic;if(!T)return;
    if(T.pending)simParallelBackgroundWait(SIM_LANE_TRAFFIC);
    T.pending=0;T.config[5]=0;
    // (Push records: invalid by their stamps once the epoch moves past
    // them; a restoring peer's start the same way.)
    T.config[36]+=2;
    for(const [k,a]of Object.entries(T))if(k!=='config'&&k!=='pushA'&&k!=='pushB'&&ArrayBuffer.isView(a))a.fill(0);
}
function trafficEnsure(O){
    const w=Math.ceil(GRID_W/4),h=Math.ceil(GRID_H/4),n=w*h*O.planes;
    if(!_traffic||_traffic.epoch!==spatialEpoch||_traffic.n!==n){
        if(_traffic){if(_traffic.pending)simParallelBackgroundWait(SIM_LANE_TRAFFIC);for(const a of Object.values(_traffic))if(ArrayBuffer.isView(a))simHeapFree(a);}
        const T=_traffic={epoch:spatialEpoch,n,w,h,pending:0,config:simHeapArray(Int32Array,40)};
        for(const key of ['workX','workY','workLoss','snapX','snapY','snapLoss'])T[key]=simHeapArray(Int32Array,n);
        for(const key of ['density','capacity','source','p0','p1','x','y','nextX','nextY'])T[key]=simHeapArray(Float32Array,n);
        T.mask=simHeapArray(Uint8Array,n);T.nextMask=simHeapArray(Uint8Array,n);
        for(const key of ['pushA','pushB']){T[key]=simHeapArray(Int32Array,GRID_W*GRID_H*SIM_TRAFFIC_PUSH_WORDS);T[key].fill(0);}
        const C=T.config,ptr=a=>_simWEnc(_simHeapPtrOf(a));
        C.fill(0);
        C.set([SIM_TRAFFIC_MODE,w,h,10,O.planes,0,O.stride,O.h,GRID_W,GRID_H,32,0,0,0,0,0]);
        for(const [i,key]of [[16,'x'],[17,'y'],[18,'workX'],[19,'workY'],[20,'snapX'],[21,'snapY'],[22,'density'],[23,'p0'],[24,'p1'],[25,'capacity'],[26,'source'],[27,'nextX'],[28,'nextY'],[29,'workLoss'],[30,'snapLoss']])C[i]=ptr(T[key]);
        C[32]=ptr(T.mask);C[33]=ptr(T.nextMask);
        C[34]=ptr(T.pushA);C[35]=ptr(T.pushB);C[36]=2;C[37]=GRID_W;C[38]=GRID_H;C[39]=Math.round(Math.log2(TILE*8));
        simParallelBind('traffic.config',C);
    }
    _traffic.config[0]=SIM_TRAFFIC_MODE;
    _traffic.config[11]=SIM_TRAFFIC_RESPONSE;
    _traffic.config[12]=SIM_TRAFFIC_PASSES;
    _traffic.config[13]=SIM_TRAFFIC_LOCAL;
    return _traffic;
}
function trafficBeforeMovement(){
    const T=_traffic;if(!T)return;
    // This step's pushes go to the other buffer; last step's are read.
    {const C=T.config;[C[34],C[35]]=[C[35],C[34]];[T.pushA,T.pushB]=[T.pushB,T.pushA];C[36]++;}
    if(T.pending&&gameTime>=T.pending){
        simParallelBackgroundWait(SIM_LANE_TRAFFIC);T.pending=0;
        [T.x,T.nextX]=[T.nextX,T.x];[T.y,T.nextY]=[T.nextY,T.y];
        [T.mask,T.nextMask]=[T.nextMask,T.mask];
        const C=T.config;[C[16],C[27]]=[C[27],C[16]];[C[17],C[28]]=[C[28],C[17]];C[5]++;
        [C[32],C[33]]=[C[33],C[32]];
    }
}
function trafficAfterMovement(){
    const T=_traffic;if(!T||SIM_TRAFFIC_MODE<2||T.pending)return;
    const P=_simParams;P.fill(0);P[0]=T.n;P[1]=256;
    // Snapshot only the small coarse grid and packed occupancy words. No
    // background worker reads positions or a bitmap while units write them.
    simParallelRun(SIM_KERNEL_TRAFFIC_CAPTURE,Math.ceil(T.n/256));
    const lane=SIM_LANE_TRAFFIC,stages=[];
    for(let k=0;k<16;k++){
        const Q=simParallelStageParams(lane,k);Q.fill(0);Q[0]=T.n;Q[1]=256;Q[2]=k;
        stages.push([SIM_KERNEL_TRAFFIC_SOLVE,Math.ceil(T.n/256)]);
    }
    const Q=simParallelStageParams(lane,16);Q.fill(0);Q[0]=T.n;Q[1]=256;
    stages.push([SIM_KERNEL_TRAFFIC_OUTPUT,Math.ceil(T.n/256)]);
    const M=simParallelStageParams(lane,17);M.set(Q);
    stages.push([SIM_KERNEL_TRAFFIC_MASK,Math.ceil(T.n/256)]);
    simParallelBackgroundChain(lane,stages);
    // Published at the next step's start when steps are long (a lag of two
    // long steps was seconds of game time: crowds swayed on stale fields).
    T.pending=gameTime+(simDk>1?simDk:2);
}
