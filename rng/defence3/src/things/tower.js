"use strict";

// Laser beams: a map made when the links change (laserBeamsTick), not
// looked for each tick: a beam is the tiles strictly between two linked
// lasers. Each tick a helper kernel (SIM_KERNEL_LASER_HITS) finds the units
// on beam tiles (one look-up each); the structures on a beam's tiles are
// listed with it. Units' records come every LASER_REPORT_TICKS ticks, summed.
const LASER_REPORT_TICKS = 4;
// Laser links, kept by lines (laser.rs k_laser_lines): a laser's links
// depend only on its row and column, so its events (placed, removed:
// laserListToggle; level, construction: laserCheck) and a wall set or
// cleared on a tile a laser's walk looked at (laserWallChanged) mark those
// lines (lz.rdirty, lz.cdirty; placements and removals also listed, lz.ev),
// and only they are worked out again from their laser lists. Each tick the
// beams' damage from the static stat tables (k_laser_dmg); what they do to
// the tiles between their lasers is the tile effects' pass (tileEffectsTick).
const _laserMap = { N: 0, scap: 0, bcap: 0, hdr: null, rd: null, cd: null, walk: null, list: null, lastReports: 0, shrine: null };
const LASER_LOOKS = 64;
function _laserArr(name, Type, n) {
    let a = _simParReg[name];
    if (!a || a.constructor !== Type || a.length < n || !simHeapHas(a)) { const old = a; a = simSharedArray(Type, Math.max(1, n)); simParallelBind(name, a); if (old && simHeapHas(old)) simHeapFree(old); }
    return a;
}
// The tower table (laser.rs reads its effectiveLevel, level, laserState).
function _laserTowerTable() { const T = typeof Tower !== 'undefined' ? _sTables.get(Tower) : null; if (T && !_sColsInHeap(T)) _sTableGrow(T, T.cap); return T; }
// Every laser looked at again (a restore, the map's first, a new map).
function laserMapDirty() { const M = _laserMap; if (M.hdr) M.hdr[5] = 1; else M.N = 0; }
// A laser placed or removed: listed, its lines marked.
function laserLinesTouch(t, placed = false) {
    const M = _laserMap;
    if (!M.rd || !t || !(t.gx >= 0 && t.gy >= 0 && t.gx < GRID_W && t.gy < GRID_H)) return;
    M.rd[t.gy] = 1; M.cd[t.gx] = 1;
    if (placed) { const n = M.hdr[4]; if (n < M.ev.length) { M.ev[n] = t.gy * GRID_W + t.gx; M.hdr[4] = n + 1; } else M.hdr[5] = 1; }
}
// A tile's wall changed (simMoveTileTypeChanged): only when a laser's walk
// looked at it (lz.walk) can a link change: its lines marked.
function laserWallChanged(gx, gy) {
    const M = _laserMap;
    if (M.walk && M.walk[gy * GRID_W + gx]) { M.rd[gy] = 1; M.cd[gx] = 1; }
}
// The arrays for this map, sized from the towers' table (slots: a laser
// each at most; beams: two a laser).
function _laserEnsure(T) {
    const M = _laserMap, W = GRID_W, H = GRID_H, N = W * H, cap = Math.max(1024, T ? T.cap : 1024);
    if (M.N === N && M.scap >= cap && simHeapHas(M.hdr)) return M;
    const I = (name, n, fill) => { const a = _laserArr(name, Int32Array, n); if (fill !== undefined) a.fill(fill); return a; };
    M.lslot = I('lz.lslot', N, -1); M.walk = _laserArr('lz.walk', Uint8Array, N); M.walk.fill(0);
    M.rd = _laserArr('lz.rdirty', Uint8Array, H); M.cd = _laserArr('lz.cdirty', Uint8Array, W);
    M.rhead = I('lz.rhead', H, -1); M.chead = I('lz.chead', W, -1);
    M.hdr = I('lz.hdr', 8, 0);
    M.slt = I('lz.slt', cap, -1); M.sfree = I('lz.sfree', cap + 1, 0); M.part = I('lz.part', 16 * cap); M.pn = I('lz.pn', 4 * cap);
    M.rnext = I('lz.rnext', cap); M.cnext = I('lz.cnext', cap); M.sb = I('lz.sb', 8 * cap); M.sbn = I('lz.sbn', 2 * cap); M.ev = I('lz.ev', cap);
    const bc = 2 * cap;
    M.ba = I('lz.ba', bc); M.bb = I('lz.bb', bc); M.bown = I('lz.bown', bc); M.bfree = I('lz.bfree', bc + 1, 0); M.border = I('lz.border', bc);
    M.bdmg = _laserArr('lz.bdmg', Float32Array, bc); M.hit = _laserArr('lz.hit', Uint8Array, bc); M.blive = _laserArr('lz.blive', Uint8Array, bc); M.blive.fill(0);
    M.bkeys = _laserArr('lz.bkeys', Float64Array, 2 * bc);
    M.N = N; M.scap = cap; M.bcap = bc;
    // (Made whole: every slot and beam starts over from the world.)
    M.hdr[5] = 1;
    return M;
}
// The marked lines worked out (k_laser_lines), then every beam's damage and
// order (k_laser_dmg).
function _laserMapBuild() {
    const T = _laserTowerTable(), ty = _stationaryTypeIds.get('laser');
    if (!_ST.code || !T) return null;
    const M = _laserEnsure(T), P = _simParams;
    if (ty === undefined) { M.rd.fill(0); M.cd.fill(0); M.hdr[4] = 0; M.hdr[3] = 0; return M; }
    let any = M.hdr[4] > 0 || M.hdr[5] !== 0;
    for (let y = 0; y < GRID_H && !any; y++) if (M.rd[y]) any = true;
    for (let x = 0; x < GRID_W && !any; x++) if (M.cd[x]) any = true;
    if (any) {
        P[0] = GRID_W; P[1] = GRID_H; P[2] = TYPE_WALL; P[3] = ty; P[4] = M.scap; P[5] = M.bcap;
        simRustDirect('k_laser_lines', [_ST.code, _ST.brain, _ST.own, _ST.uc, _ST.val, _ST.rrow, cellType, M.lslot, M.slt, M.sfree, M.part, M.pn,
            M.rhead, M.chead, M.rnext, M.cnext, M.sb, M.sbn, M.ba, M.bb, M.bown, M.bfree, M.blive, M.walk, T.c_effectiveLevel, T.c_level, M.hdr, M.rd, M.cd, M.ev], P);
    }
    if (!(M.hdr[2] > 0)) { M.hdr[3] = 0; return M; }
    const S = statTablesStatic(), X = _adjPlayerStats(S), NT = _adjTypeKeys(), tc = _simParReg['tc.dmg'] || null;
    P[0] = S.nk; P[1] = S.L1; P[2] = S.R1; P[3] = NT; P[4] = MAX_THING_LEVEL; P[5] = players.length; P[6] = GRID_W;
    simRustDirect('k_laser_dmg', [M.ba, M.bb, M.blive, M.bdmg, _ST.brain, _ST.own, _ST.rrow, _simParReg['adj.tykey'], X.rlv, X.bl, S.dmg, tc, M.bkeys, M.border, M.hdr], P);
    return M;
}
// Once a tick, before the towers' updates (gameTick): the laser lines, then
// the tile effects (traps and beams) on the units standing there and the
// structures on beam tiles (tfx.rs k_tile_effects), the reports' shrine
// income (k_laser_report) and the first looks.
function laserBeamsTick() {
    const M = _laserMapBuild();
    const traps = typeof simTrapTiles === 'function' ? simTrapTiles() : null, nTraps = traps ? traps.n : 0;
    const nb = M ? M.hdr[3] : 0;
    if (!nb && !nTraps) return;
    const S = typeof _simUnitState !== 'undefined' ? _simUnitState : null;
    if (!S || !_sxBySlot || !_sxPar) return;
    if (M) M.hit.fill(0, 0, M.hdr[1]);
    if (nTraps && typeof _simTrapUnitsBound === 'function') simUnitStReserve(_simTrapUnitsBound());
    const C = S.columns, ns = S.owners.length, Tt = _laserTowerTable();
    if (!M.list || M.list.length < ns || !simHeapHas(M.list)) { M.list = simSharedArray(Int32Array, simReserveCap(Math.max(1, ns))); M.lastReports = 0; }
    if (!M.out || !simHeapHas(M.out)) M.out = simSharedArray(Int32Array, 4);
    const T = S.st, P = _laserStructP;
    P.fill(0);
    P[4] = GRID_W; P[10] = simDk; P[11] = gameTime; P[12] = LASER_REPORT_TICKS; P[13] = _sxEpoch; P[14] = nTraps;
    P[15] = traps ? traps.players : 0; P[16] = traps ? traps.levels : 0; P[17] = traps ? traps.types : 0; P[18] = M.lastReports;
    const X = _sxPar, A = traps || {};
    const tail = [X.stamp, X.start, X.cnt, _sxESlot, C.dead, C.owner, C.energy, C.id, C.lzFlags, C.lzAcc, C.lzBeam, C.lzEv, M.list,
        C.upT, A.tres || null, C.stIx, T ? T.hdr : null, T ? T.free : null, C.stBu, C.stBd, C.stPo, C.stPd, C.stFr, C.stId, C.stWe, C.stSa, M.out];
    const K = _structHitsRun('k_tile_effects', [M.ba, M.bb, M.bown, M.bdmg, M.hit, M.border, M.hdr, Tt ? Tt.c_laserState : null, _ST.own,
        A.list || null, A.k || null, A.l || null, A.t || null, A.tg || null], P, Math.max(1, nb) * (MAX_THING_LEVEL + 2), tail);
    if (!K) return;
    if (T) simUnitStSettle();
    const nrep = M.out[0];
    M.lastReports = nrep;
    if (nrep > 0) {
        // The reports: shrine income by the kernel; the first looks here.
        const NO = Math.max(16, players.length);
        if (!M.shrine || M.shrine.length < NO || !simHeapHas(M.shrine)) { M.shrine = simSharedArray(Float64Array, NO); M.look = simSharedArray(Int32Array, 3 * LASER_LOOKS); M.lcnt = simSharedArray(Int32Array, 4); M.rcnt = simSharedArray(Int32Array, 4); }
        M.shrine.fill(0); M.rcnt[0] = nrep;
        const R = _laserReportP;
        R[0] = 1; R[1] = M.list.length; R[2] = RESOURCE_FIXED_POINT_SCALE; R[3] = LASER_LOOKS; R[4] = NO;
        simRustDirect('k_laser_report', [M.list, M.rcnt, C.lzAcc, C.lzBeam, C.owner, C.energy, M.shrine, M.look, M.lcnt], R);
        _shrineAdd(M.shrine, NO);
        for (let k = 0, nl = M.lcnt[0]; k < nl; k++) {
            const u = S.owners[M.look[3 * k]], d = M.look[3 * k + 2] / 1024, own = M.bown[M.look[3 * k + 1]];
            if (!u) continue;
            pushHostileDamageAlert(u, d, own); recordDamageVisual(u, d, own);
            createExplosion(u.x, u.y, "#f00", 1);
        }
    }
    _structHitsAfter(K, (b, tb, dmg) => { const own = M.bown[b]; pushHostileDamageAlert(tb, dmg, own); recordDamageVisual(tb, dmg, own); if (simStepCrosses(0, 10)) createExplosion(tb.x, tb.y, "#f84", 1); });
    if (M.out[1] && simStepCrosses(0, 40)) { const tl = M.ba[M.border[0]], gx = tl % GRID_W; playSound('laser_tick', gx * TILE + TILE / 2, ((tl - gx) / GRID_W) * TILE + TILE / 2); }
}
const _laserReportP = new Float64Array(8), _laserStructP = new Float64Array(24);
// A structure hit kernel's shrine sums into the players' pending income.
function _shrineAdd(A, NO) {
    for (let o = 0; o < NO; o++) if (A[o] > 0) { if (o >= _shrinePendingFixed.length) { const a = new Float64Array(o + 8); a.set(_shrinePendingFixed); _shrinePendingFixed = a; } _shrinePendingFixed[o] += A[o]; }
}
// A laser's partners (laser.rs lz.part, its four directions) as structures
// in tile order; none for other towers. (Its links are the kernels': read
// only.)
const _NO_LASER_LINKS = Object.freeze([]);
function laserPartnersOf(t) {
    const M = _laserMap;
    if (!M.lslot || !(t._stT >= 0)) return _NO_LASER_LINKS;
    const sl = M.lslot[t._stT];
    if (!(sl >= 0)) return _NO_LASER_LINKS;
    const tiles = [];
    for (let d = 0; d < 4; d++) for (let k = 0, n = M.pn[sl * 4 + d]; k < n; k++) tiles.push(M.part[sl * 16 + d * 4 + k]);
    if (!tiles.length) return _NO_LASER_LINKS;
    tiles.sort((x, y) => x - y);
    const out = [];
    for (const tl of tiles) { const gx = tl % GRID_W, e = getTileEntityRef(gx, (tl - gx) / GRID_W); if (e) out.push(e); }
    return out;
}
// At a resync, on every peer: the map made again (its structures by
// object), the same way on every peer. (The units' unreported sums are
// state, kept: unit.js _laserPending.)
function laserBeamsReset() { laserMapDirty(); }
function _isProducerStructure(e) {
    return e instanceof Barrack || e instanceof CollectorSpawner || e instanceof AstarSpawner || e instanceof SalvagerSpawner
        || e instanceof BuilderSpawner || e instanceof HealerSpawner || e instanceof ResearchSpawner;
}

// ============================================================
// TOWER CLASS
// ============================================================
// Towers act only when due (towersTick): a tower's cooldown is the tick it
// ends (_cdUntil, st.tim; cd reads and sets the ticks left): due the tick
// after (a cooldown of N set at tick T acts again at T + N + 1), found by a
// kernel over the tower table (tower.rs k_tower_due), no wheel.
// Read-only acquisition for all due towers, before any of them shoot. Their
// projectiles are resolved afterwards, so every query sees the same live unit
// state. Snapshot by spatial ENTRY (not slot) for contiguous SIMD loads.
// No persistent per-unit columns: three reusable scratch arrays, 12 B/entry.
const _towerAcq={list:[],areaLists:[],arrays:{},pos:0,ready:false,tick:-1,lastN:0,lastActive:0,lastUsed:0};
const _towerAcqTypes={fire:1,water:2,poison:3,ice:4,elements:5,sand_gun:6,watch_tower:7};
function _towerAcqArray(name,Type,n){
    const T=_towerAcq,old=T.arrays[name];
    if(old&&old.length>=n)return old;
    const a=T.arrays[name]=simSharedArray(Type,simReserveCap(Math.max(1,n),256));
    simParallelBind('tac.'+name,a);if(old)simHeapFree(old);return a;
}
// The stationary reach table: per area, the areas within each distance
// (sta.off / sta.box / sta.ids, the prepare and scan kernels'), from the
// layout and every tower's reach (sta.need, k_stationary_need). Two sets:
// the one in use (bound sta.*) and the next, made on the build lane
// (bound stb.*, k_stationary_need / k_stationary_areas) and switched to
// when made: no tick waits for it, except the match's first (made at once:
// nothing to use before it). Fixed positions make every turret in an
// area/range reuse the same slice without packing or copying it.
const _stationaryReach={sets:[{},{}],active:-1,bset:0,layout:null,depth:0,refresh:false,phase:0,blayout:null,bdepth:0,failed:false};
const _stationaryStats={version:-1,types:0,players:0,levels:0,arrays:{},maxRange:0};
let SIM_STATIONARY_BRAINS=true;
function _stationaryArray(S,name,Type,n){
    const old=S.arrays[name];if(old&&old.length>=n)return old;
    const a=S.arrays[name]=simSharedArray(Type,simReserveCap(Math.max(1,n),256));
    simParallelBind('sta.'+name,a);if(old)simHeapFree(old);return a;
}
// An array of the set being made (bound stb.<name>).
function _reachArray(name,Type,n){
    const S=_stationaryReach,R=S.sets[S.bset],old=R[name];
    if(old&&old.length>=n&&simHeapHas(old)){simParallelBind('stb.'+name,old);return old;}
    const a=R[name]=simSharedArray(Type,simReserveCap(Math.max(1,n),256));
    simParallelBind('stb.'+name,a);if(old&&simHeapHas(old))simHeapFree(old);return a;
}
// The set in use, bound for the kernels (tac.areas: its area lists).
function _reachBindActive(){
    const S=_stationaryReach;if(S.active<0)return null;
    const A=S.sets[S.active];
    for(const k of ['off','box','need'])simParallelBind('sta.'+k,A[k]);
    simParallelBind('tac.areas',A.ids);
    return A;
}
// The next set's making, a step (block: to its end, waiting on the lane).
function _reachAdvance(block){
    const S=_stationaryReach,lane=SIM_LANE_BUILD;
    if(simParallelBackgroundPending(lane)){
        // (Someone else's work on the lane: ours starts after it.)
        if(!block&&(!S.phase||!simParallelBackgroundDone(lane)))return;
        simParallelBackgroundWait(lane);
    }
    _simAreaCsr();const na=areaNeighborIds.length,dd=S.bdepth+1;
    if(!na){S.phase=0;return;}
    if(!S.phase){
        _reachArray('off',Int32Array,na*(dd+1));_reachArray('box',Int32Array,na*dd*4);_reachArray('meta',Int32Array,16).fill(0);
        _reachArray('need',Int32Array,na).fill(Math.min(3,S.bdepth));
        _visibilityKernelAreas();for(const key of ['code','own','brain'])simParallelBind('st.'+key,_ST[key]);
        const N=_simParams;N[0]=_ST.n;N[1]=4096;N[2]=_stationaryStats.types;N[3]=_stationaryStats.players;N[4]=S.bdepth;N[5]=na;
        simParallelRun(SIM_KERNEL_STATIONARY_NEED,Math.ceil(_ST.n/4096));
        // Thread-local BFS scratch holds two words per source area.
        if(na*2>_simWasmScratchWords){if(!S.failed)console.error('stationary reach: '+na+' areas need more kernel scratch than '+_simWasmScratchWords+' words');S.failed=true;return;}
        for(let stage=0;stage<2;stage++){
            const P=simParallelStageParams(lane,stage);P.fill(0);P[0]=na;P[1]=32;P[2]=dd;P[3]=stage?2:0;P[4]=16*1024*1024;
        }
        S.phase=1;simParallelBackgroundChain(lane,[[SIM_KERNEL_STATIONARY_AREAS,Math.ceil(na/32)],[SIM_KERNEL_STATIONARY_AREAS,1]],true);
        if(!block)return;
        simParallelBackgroundWait(lane);
    }
    if(S.phase===1){
        if(simParallelBackgroundPending(lane)){if(!block&&!simParallelBackgroundDone(lane))return;simParallelBackgroundWait(lane);}
        const total=S.sets[S.bset].meta[0];
        if(total<0){if(!S.failed)console.error('stationary reach: more than 16M area entries at depth '+S.bdepth);S.failed=true;S.phase=0;return;}
        _reachArray('ids',Int32Array,total);
        const P=simParallelStageParams(lane,0);P.fill(0);P[0]=na;P[1]=32;P[2]=dd;P[3]=1;
        S.phase=2;simParallelBackground(SIM_KERNEL_STATIONARY_AREAS,Math.ceil(na/32),lane);
        if(!block)return;
    }
    if(S.phase===2){
        if(simParallelBackgroundPending(lane)){if(!block&&!simParallelBackgroundDone(lane))return;simParallelBackgroundWait(lane);}
        // Made: switched to (a flip), the other set the next one's.
        S.active=S.bset;S.bset=1-S.active;S.layout=S.blayout;S.depth=S.bdepth;S.phase=0;
        _reachBindActive();
    }
}
// A tower type's shot status: its duration and dps stat keys (renderer.js _getEffectStatKey).
const _TOWER_EFFECT_STATS={fire:['burnDuration','burnDps'],poison:['poisonDuration','poisonDps'],ice:['freezeDuration','freezeDps'],water:['wetDuration',null],sand_gun:['sandDuration',null],watch_tower:['watchDuration',null]};
function _stationaryStatsPrepare(){
    const S=_stationaryStats,nt=_stationaryTypes.length,np=players.length,nl=MAX_THING_LEVEL+1;
    if(S.version===_precomputedStatsVersion&&S.types===nt&&S.players===np&&S.levels===nl&&S.sources?.every((entry,o)=>entry===PRECOMPUTED_STATS_MAP_PLAYER[o]))return S;
    const ranges=_stationaryArray(S,'range',Int32Array,(np+1)*nt*nl),cds=_stationaryArray(S,'cd',Int32Array,(np+1)*nt*nl),kinds=_stationaryArray(S,'kind',Int32Array,nt);
    const damage=_stationaryArray(S,'damage',Float32Array,(np+1)*nt*nl),blast=_stationaryArray(S,'blast',Float32Array,(np+1)*nt*nl),radius=_stationaryArray(S,'radius',Float32Array,(np+1)*nt*nl);
    const maxRanges=_stationaryArray(S,'maxRange',Int32Array,(np+1)*nt);
    // (The shots' status: its duration in ticks and dps as the stats map them, 0 / -1 none: projectile.js; the type's name, pj.tt.)
    const sds=_stationaryArray(S,'sd',Int32Array,(np+1)*nt*nl),sps=_stationaryArray(S,'sp',Float32Array,(np+1)*nt*nl),tts=_stationaryArray(S,'tt',Int32Array,nt);
    let max=0;
    for(let ty=0;ty<nt;ty++){
        const name=_stationaryTypes[ty],key=normalizeBuildingResearchKey(name);
        kinds[ty]=name==='laser'||name.startsWith('cloud')?-1:(_towerAcqTypes[name]||0);
        tts[ty]=_projTypeId(name);const eff=_TOWER_EFFECT_STATS[name];
        for(let own=-1;own<np;own++){
        let maximum=0;
        for(let lvl=1;lvl<nl;lvl++){
            const st=own>=0?PRECOMPUTED_STATS_MAP_PLAYER[own]?.building?.[key]?.[lvl]:_thingStatTables.get('-1|building|'+key)?.entries[lvl];
            const at=((own+1)*nt+ty)*nl+lvl;
            // Unknown/custom stat entries stay on the scalar behavior path.
            const r=st?Math.floor(Math.max(0,Number(st.attackRangeArea)||0)):-1;
            ranges[at]=r;cds[at]=st?Math.max(1,Math.ceil(secondsToTicks(st.cd||1.5))):0;
            damage[at]=st?.damage;blast[at]=st?.blastDamage;radius[at]=st?.blastRadius;
            const dur=eff&&st?Number(st[eff[0]]):NaN,dps=eff&&eff[1]&&st?Number(st[eff[1]]):NaN;
            sds[at]=Number.isFinite(dur)?secondsToTicks(dur):0;sps[at]=Number.isFinite(dps)&&dps>=0?dps:-1;
            if(r>maximum)maximum=r;
        }
        maxRanges[(own+1)*nt+ty]=maximum;
        if(kinds[ty]>=0&&BASE_CARD_TYPES[name]?.target==='wall'&&maximum>max)max=maximum;
        }
    }
    S.version=_precomputedStatsVersion;S.types=nt;S.players=np;S.levels=nl;S.sources=PRECOMPUTED_STATS_MAP_PLAYER.slice(0,np);S.maxRange=Math.min(63,max);return S;
}
// Whether a table is there for this step (depth: the towers' reach), the
// next one started or carried on when it should be deeper or newer.
function _stationaryReachStep(depth){
    const S=_stationaryReach;
    const fresh=S.active>=0&&S.layout===areaNeighborIds;
    if(S.phase)_reachAdvance(!fresh);
    else if(!fresh||S.depth<depth||S.refresh){
        S.refresh=false;S.blayout=areaNeighborIds;S.bdepth=Math.max(depth,fresh?S.depth:0);
        _reachAdvance(!fresh);
    }
    // (Nothing to use yet: made at once.)
    for(let k=0;k<4&&S.phase&&!(S.active>=0&&S.layout===areaNeighborIds);k++)_reachAdvance(true);
    if(!(S.active>=0&&S.layout===areaNeighborIds))return false;
    _reachBindActive();
    return true;
}
// A tower with custom stats or position (data_state.js stationaryBrainChanged:
// descriptor bit 25): its own values by its row (tc.*: the prepare kernel's
// in place of the stat tables), written when its descriptor is.
const _towerCustom = { cap: 0, a: null };
const _TC_COLS = [['x', Float32Array], ['y', Float32Array], ['range', Int32Array], ['cd', Int32Array], ['dmg', Float32Array], ['blast', Float32Array], ['radius', Float32Array], ['lvl', Int32Array]];
function _towerCustomArrays(cap) {
    const C = _towerCustom;
    if (C.a && C.cap >= cap && simHeapHas(C.a.x)) return C.a;
    const a = {};
    for (const [k, T] of _TC_COLS) { a[k] = simSharedArray(T, Math.max(1024, cap)); if (C.a && simHeapHas(C.a[k])) { a[k].set(C.a[k].subarray(0, Math.min(C.cap, a[k].length))); simHeapFree(C.a[k]); } simParallelBind('tc.' + k, a[k]); }
    C.a = a; C.cap = Math.max(1024, cap);
    return a;
}
function towerCustomWrite(t, row) {
    if (!(row >= 0)) return;
    const a = _towerCustomArrays(row + 1), st = t.currentStats || {};
    a.x[row] = t.x; a.y[row] = t.y;
    a.range[row] = Math.floor(Math.max(0, Number(st.attackRangeArea) || 0));
    a.cd[row] = Math.max(1, Math.ceil(secondsToTicks(st.cd || 1.5)));
    a.dmg[row] = Number(st.damage) || 0; a.blast[row] = Number(st.blastDamage); a.radius[row] = Number(st.blastRadius);
    a.lvl[row] = getThingEffectiveLevel(t);
}
// The prepare kernels for the n due towers whose tiles are in tac.input
// (rows in tac.row). False when there is no reach table (cannot be: it is
// made at once when missing; a failure to make it is logged).
function _towerAcqKernels(n){
    const T=_towerAcq,TT=_sTables.get(Tower);
    if(!_ST.n)return false;
    const stats=_stationaryStatsPrepare();
    if(!_stationaryReachStep(stats.maxRange))return false;
    spatialIndexEnsure();_visibilityKernelAreas();_simMoveStructs();
    for(const key of ['code','own','uc','val','tim','brain','rrow'])simParallelBind('st.'+key,_ST[key]);
    simParallelBind('mv.stblk',_simMoveStructBlocks);
    _towerCustomArrays(TT.cap);
    _towerAcqArray('valid',Int32Array,n);_towerAcqArray('pref',Int32Array,n);
    for(const name of ['qx','qy'])_towerAcqArray(name,Float32Array,n+4);
    for(const name of ['owner','type','base','tile','out','sout','idle'])_towerAcqArray(name,Int32Array,n);
    for(const name of ['shots','shotCd','level'])_towerAcqArray(name,Int32Array,n);
    for(const name of ['damage','blast','radius'])_towerAcqArray(name,Float64Array,n);
    _towerAcqArray('off',Int32Array,n*2);_towerAcqArray('boxes',Int32Array,n*4);_towerAcqArray('live',Uint32Array,n);
    _towerAcqArray('count',Int32Array,Math.ceil(n/32)*16);
    const ext=_towerAcqArray('ext',Int32Array,Math.ceil(n/256));
    T.lastN=n;T.lastActive=0;T.lastPrepared=0;
    const P=_simParams;P[0]=n;P[1]=256;P[2]=GRID_W;P[3]=_stationaryReach.depth+1;P[4]=stats.types;P[5]=stats.levels;P[6]=stats.players;P[7]=gameTime;P[8]=TILE;P[9]=_ST.n;P[10]=areaNeighborIds.length;P[11]=simDk;
    simParallelRun(SIM_KERNEL_TOWER_PREPARE,Math.ceil(n/256));
    // (A reach past the table's: the next table deeper.)
    for(let c=0;c<Math.ceil(n/256);c++)if(ext[c]){_stationaryReach.refresh=true;break;}
    P[0]=n;P[1]=32;P[2]=spatialUnitsComplexPlayerCount;P[3]=spatialBlockCols;P[4]=GRID_W;P[5]=SPATIAL_BLOCK_SIZE;P[6]=1;
    simParallelRun(SIM_KERNEL_TOWER_COARSE,Math.ceil(n/32));
    for(let c=0;c<Math.ceil(n/32);c++){T.lastActive+=T.arrays.count[c*16];T.lastPrepared+=T.arrays.count[c*16+1];}
    // Empty broad-phase queries share the empty CSR slice. The kernel can
    // skip their searches without another foreground query walk.
    const nt=_simUnitTypeNames.length,flags=_towerAcqArray('flags',Uint8Array,nt);
    for(let i=0;i<nt;i++){const b=BASE_UNIT_STATS[_simUnitTypeNames[i]]||BASE_UNIT_STATS.norm;flags[i]=(b.turretImmune?1:0)|(b.fireResistant?2:0)|(b.waterResistant?4:0)|(b.poisonResistant?8:0)|(b.iceResistant?16:0);}
    for(const name of ['x','y','meta'])_towerAcqArray(name,Int32Array,_sxListed+4);
    P[0]=_sxListed;P[1]=4096;P[2]=nt;
    const b=BASE_UNIT_STATS.norm;P[3]=(b.turretImmune?1:0)|(b.fireResistant?2:0)|(b.waterResistant?4:0)|(b.poisonResistant?8:0)|(b.iceResistant?16:0);
    if(T.lastActive)simParallelRun(SIM_KERNEL_TOWER_PACK,Math.ceil(_sxListed/4096));
    P[0]=n;P[1]=32;P[2]=_sxEpoch;
    if(T.lastActive)simParallelRun(SIM_KERNEL_TOWER_SCAN,Math.ceil(n/32));else T.arrays.out.fill(-1,0,n);
    P[3]=GRID_W;P[4]=TILE;P[5]=gameTime;simParallelRun(SIM_KERNEL_TOWER_STRUCT,Math.ceil(n/32));
    return true;
}
// A step of the towers (gameTick, after the statuses' kernel removed those
// without energy), all in kernels: the due ones (k_tower_due over the tower
// table), their targets (the prepare kernels), their turns (k_tower_fire:
// preferred targets, shots into the projectile pool, cooldowns, angles).
// Here: the first shots' looks and the turrets' angles to the presentation.
const _twP = new Float64Array(16);
function towersTick() {
    const TT = _sTables.get(Tower);
    if (!TT || !TT.n || !_ST.n || !_ST.rrow) return;
    if (!simHeapHas(_ST.code)) structTablesRehome();
    if (!_sColsInHeap(TT)) _sTableGrow(TT, TT.cap);
    const T = _towerAcq, stats = _stationaryStatsPrepare(), P = _twP;
    const input = _towerAcqArray('input', Int32Array, TT.n), rows = _towerAcqArray('row', Int32Array, TT.n), cnt = _towerAcqArray('cnt', Int32Array, 8);
    P[0] = TT.n; P[1] = gameTime; P[2] = stats.types; P[3] = _ST.n;
    simRustDirect('k_tower_due', [TT.c__stT, _ST.code, _ST.uc, _ST.val, _ST.tim, _ST.brain, stats.arrays.kind, _ST.rrow, input, rows, cnt], P);
    const n = cnt[0];
    if (n === 0 || !_towerAcqKernels(n)) return;
    const A = T.arrays, PJ = _pjEnsure(), J = PJ.a, C = _simUnitState.columns, U = unitIdIndex(), V = _visCover;
    const ltgt = _towerAcqArray('ltgt', Int32Array, 2 * PROJ_LOOKS), ftile = _towerAcqArray('ftile', Int32Array, n), fang = _towerAcqArray('fang', Float32Array, n);
    const looks = _towerAcqArray('looks', Int32Array, PROJ_LOOKS), fc = _towerAcqArray('fcnt', Int32Array, 8);
    if (typeof _visCoverReady === 'function') _visCoverReady();
    P[0] = n; P[1] = gameTime; P[2] = GRID_W; P[3] = TILE; P[4] = Math.max(WORLD_W, WORLD_H) * 2; P[5] = AREA_UNIT_TILE_EQUIVALENT * TILE;
    P[6] = stats.types; P[7] = stats.levels; P[8] = PROJ_LOOKS; P[9] = U.n; P[10] = V.coverFlat ? V.coverStride : 0; P[11] = V.coverFlat ? V.players : 0; P[12] = _ST.n;
    const S = stats.arrays, R = _stationaryReach.sets[_stationaryReach.active];
    simRustDirect('k_tower_fire', [input, rows, A.valid, A.base, A.sout, A.out, A.idle, A.qx, A.qy, A.owner, A.type, A.shots, A.shotCd, A.level, A.damage, A.blast, A.radius,
        C.x, C.y, C.id, _ST.code, _ST.tim, TT.c__cdUntil, TT.c_angle, S.tt, _ST.brain, S.sd, S.sp,
        PJ.live, PJ.free, PJ.hdr, J.x, J.y, J.vx, J.vy, J.sx, J.sy, J.px, J.py, J.aim, J.life, J.range, J.dmg, J.lvl, J.own, J.ty, J.tt, J.shots, J.bd, J.br, J.ft, J.sd, J.sp, J.id, J.ev, J.arg,
        ltgt, ftile, fang, looks, fc,
        A.pref, TT.c__ptK, TT.c__ptV, U.ids, U.slots, C.dead, C.owner, _ST.own, _ST.val, V.coverFlat || null, _simParReg['vis.areaGrid'], A.off, R.ids], P);
    T.lastUsed = n;
    // The first shots' looks (presentation only).
    for (let i = 0, m = fc[2]; i < m; i++) {
        const q = looks[i], tile = input[q], s = ltgt[2 * i], g = ltgt[2 * i + 1], name = _stationaryTypes[(_ST.brain[tile] & 65535) - 1] || '';
        let tx, ty, id = 0;
        if (s >= 0) { tx = C.x[s] * 0.125; ty = C.y[s] * 0.125; id = C.id[s]; }
        else { const gx = g % GRID_W; tx = gx * TILE + TILE / 2; ty = (g - gx) / GRID_W * TILE + TILE / 2; }
        // (A volley: src -shots, dst the unit's id or 0: effects3d.js _fxVolley.)
        recordCombatFx(COMBAT_FX.MUZZLE, A.qx[q], A.qy[q], tx, ty, name, -Math.max(1, A.shots[q] | 0), id);
        playSound('shoot_' + name, A.qx[q], A.qy[q]);
    }
    if (fc[1] > 0 && typeof simPresentTowerAngles === 'function') simPresentTowerAngles(ftile, fang, fc[1]);
}

class Tower {
    // (The cooldown: see k_tower_due.)
    get cd() { return Math.max(0, (Number(this._cdUntil) || 0) - gameTime); }
    set cd(v) { this._cdUntil = gameTime + Math.max(0, Number(v) || 0); if (this._stT >= 0 && typeof _ST !== 'undefined' && _ST.n) _ST.tim[this._stT] = this._cdUntil; }
    constructor(gx, gy, type, owner, startStacks = 1) {
        if (typeof structTableInit === 'function') structTableInit(this);
        this.gx = gx; this.gy = gy; this.type = type; this.owner = owner;
        this.x = gx * TILE + 16; this.y = gy * TILE + 16;
        this.stacks = startStacks;
        this.manualStacks = startStacks;
        this.effectiveStacks = startStacks;
        this.level = stackCountToLevel(this.stacks);
        this.effectiveLevel = this.level;
        this.isStacking = false;
        this.stackingWorkDone = 0;

// ENERGY
        let baseEnergy = calculateItemStats(type, this.level, owner).maxEnergy;
        this.maxEnergy = baseEnergy;
        this.energy = baseEnergy;

        this.textCtx = null;
        this.updateTextCache();
        this.updateStats();
        this.cd = 0; this.angle = 0;
        this.laserState = 0; this.laserTimer = 0;
        this.markedForSalvage = false;
        this.autoUpgradeEnabled = true;
        this.buildEnabled = true;
        this.preferredTarget = null;
        this.preferredTargetSpec = null;
    }

    upgrade() {
        addManualStackToThing(this, 1);
    }

    updateTextCache() {
        let label = getLevelLabelText(this);
        _bindBuildingLevelTextSprite(this, label);
    }

    updateStats() {
let newmaxEnergy = Number(this.preComputedBase && this.preComputedBase.maxEnergy);
        if (!Number.isFinite(newmaxEnergy)) newmaxEnergy = this.maxEnergy || 1;
        newmaxEnergy = Math.max(1, Math.floor(newmaxEnergy));
        if (this.isUpgrading && this.upgrademaxEnergy > 0) {
            this.maxEnergy = Math.max(1, Math.floor(this.upgrademaxEnergy));
            if (!Number.isFinite(this.energy) || this.energy < 1) this.energy = 1;
            this.energy = Math.min(this.energy, this.maxEnergy);
        } else {
            let prevEnergy = Number(this.energy);
            if (!Number.isFinite(prevEnergy)) prevEnergy = newmaxEnergy;
            this.maxEnergy = newmaxEnergy;
            this.energy = Math.max(1, Math.min(this.maxEnergy, Math.floor(prevEnergy)));
        }
        this.updateTextCache();
        if (typeof visCoverOnBuildingChanged === 'function') visCoverOnBuildingChanged(this);
        if (this.type === 'laser') this.laserCheck();
    }

    calcStats(lvl) {
        return calculateItemStats(this.type, lvl, this.owner);
    }

    // A laser's links follow its level and construction: its lines marked
    // when they changed (laserBeamsTick). (Its damage is the static tables'.)
    laserCheck() {
        if (this.type !== 'laser') return;
        const lv = this.effectiveLevel, uc = !!this.underConstruction;
        if (this._lzLv === lv && this._lzUc === uc) return;
        this._lzLv = lv; this._lzUc = uc;
        laserLinesTouch(this);
    }
    // Its links (the kernels': laserPartnersOf); writes are ignored.
    get connectedLasers() { return typeof laserPartnersOf === 'function' ? laserPartnersOf(this) : []; }
    set connectedLasers(v) {}

    draw(ctx) {
        const gameTime = this._historyGhost ? this._historyTick : getRenderGameTime();
        if (this.owner >= 0) {
            ctx.strokeStyle = get2DRenderOwnerColor(this.owner); ctx.lineWidth = 1;
            ctx.strokeRect(this.x - 15, this.y - 15, 30, 30);
        }

        // Under construction overlay
        if (this.underConstruction || this.isUpgrading) {
            let isUpg = this.isUpgrading;
            if (!isUpg) {
                ctx.fillStyle = '#333'; ctx.fillRect(this.x - 14, this.y - 14, 28, 28);
                ctx.globalAlpha = 0.35;
                drawTowerIcon(ctx, this.x, this.y, this.baseStats.color, 0, this.level, this.type, false);
                ctx.globalAlpha = 1;
            } else {
                if (this.type === 'laser') {
                    if (this.laserState === 1) {
                        ctx.strokeStyle = '#f00'; ctx.lineWidth = 4;
                        ctx.shadowColor = '#f00'; ctx.shadowBlur = 10;
                        for (let other of this.connectedLasers) {
                            if (this.gx < other.gx || (this.gx === other.gx && this.gy < other.gy)) {
                                ctx.beginPath(); ctx.moveTo(this.x, this.y); ctx.lineTo(other.x, other.y); ctx.stroke();
                            }
                        }
                        ctx.shadowBlur = 0; ctx.lineWidth = 1;
                    }
                    drawTowerIcon(ctx, this.x, this.y, this.baseStats.color, 0, Math.max(1, this.level - 1), this.type, this.connectedLasers.length > 0);
                } else {
                    drawTowerIcon(ctx, this.x, this.y, this.baseStats.color, this.angle, Math.max(1, this.level - 1), this.type);
                }
                ctx.fillStyle = 'rgba(0,0,0,0.5)'; ctx.fillRect(this.x - 14, this.y - 14, 28, 28);
            }
            drawBuildingEnergyProgressBar(ctx, this, this.x, this.y + 11, 20, 3);
            if (!isUpg) {
                if (shouldShowBuildingLevels(this)) drawLevelTextCache(ctx, this, this.x, this.y);
                return;
            }
        } else {
            if (this.type === 'laser') {
                if (this.laserState === 1) {
                    ctx.strokeStyle = '#f00'; ctx.lineWidth = 4;
                    ctx.shadowColor = '#f00'; ctx.shadowBlur = 10;
                    for (let other of this.connectedLasers) {
                        if (this.gx < other.gx || (this.gx === other.gx && this.gy < other.gy)) {
                            ctx.beginPath(); ctx.moveTo(this.x, this.y); ctx.lineTo(other.x, other.y); ctx.stroke();
                        }
                    }
                    ctx.shadowBlur = 0; ctx.lineWidth = 1;
                }
                drawTowerIcon(ctx, this.x, this.y, this.baseStats.color, 0, this.level, this.type, this.connectedLasers.length > 0);
            } else {
                drawTowerIcon(ctx, this.x, this.y, this.baseStats.color, this.angle, this.level, this.type);
            }
        }
        if (shouldShowBuildingLevels(this)) drawLevelTextCache(ctx, this, this.x, this.y);

        // Energy bar (single bar for damage/progress)
        if (!this.underConstruction && !this.isUpgrading) {
            drawBuildingEnergyProgressBar(ctx, this, this.x, this.y + 14, 24, 3);
        }
    }
}
if (typeof structTableAccessors === 'function') structTableAccessors(Tower, 0x22);

// A tower's preferred target (Tower.preferredTargetSpec): two columns of its
// row, _ptK (TOWER_TARGET_KINDS: 1 a unit by id, else a structure at the tile
// _ptV) and _ptV; the kernel (k_tower_fire) clears them when the target is
// gone or out of sight. preferredTarget: its object (looked up).
const TOWER_TARGET_KINDS = ['', 'unit', 'tower', 'barrack', 'spawner', 'item'];
Object.defineProperty(Tower.prototype, 'preferredTargetSpec', { configurable: true, enumerable: false,
    get() {
        const k = this._ptK, v = this._ptV;
        if (!(k > 0) || !Number.isFinite(v)) return null;
        return k === 1 ? { type: 'unit', id: v } : { type: TOWER_TARGET_KINDS[k], gx: v % GRID_W, gy: Math.floor(v / GRID_W) };
    },
    set(s) {
        const spec = s ? normalizeTowerTargetSpec(s) : null, k = spec ? TOWER_TARGET_KINDS.indexOf(spec.type) : -1;
        if (k <= 0) { this._ptK = 0; this._ptV = -1; }
        else { this._ptK = k; this._ptV = k === 1 ? spec.id : spec.gy * GRID_W + spec.gx; }
        stationaryBrainChanged(this);
    } });
Object.defineProperty(Tower.prototype, 'preferredTarget', { configurable: true, enumerable: false,
    get() { return resolveTowerPreferredTarget(this); },
    set(v) { if (!v) this.preferredTargetSpec = null; } });

