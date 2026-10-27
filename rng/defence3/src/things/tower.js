"use strict";

// Laser beams: a map made when the links change (laserBeamsTick), not
// looked for each tick: a beam is the tiles strictly between two linked
// lasers. Each tick a helper kernel (SIM_KERNEL_LASER_HITS) finds the units
// on beam tiles (one look-up each); the structures on a beam's tiles are
// listed with it. Units' records come every LASER_REPORT_TICKS ticks, summed.
const LASER_REPORT_TICKS = 4;
// Made again when stale: a link changed (recalculateLaserConnections), a
// laser's damage did (laserCheck), or a structure came or went on a beam's
// tile (the tile journal, laserBeamsTick): it lists the structures there.
// From the lasers alone, in tile order (_laserTowerList).
const _laserMap = { stale: true, head: null, cap: 0, next: null, beam: null, bown: null, bdmg: null, hit: null, count: null, list: null, beams: [], aTowers: [], set: [], cursor: { epoch: -1, pos: 0 } };
function laserMapDirty() { _laserMap.stale = true; }
function _laserMapBuild() {
    const M = _laserMap, W = GRID_W, H = GRID_H;
    M.stale = false;
    if (!M.head || M.head.length !== W * H) { M.head = simSharedArray(Int32Array, W * H).fill(-1); simParallelBind('lz.head', M.head); M.set = []; }
    for (const t of M.set) M.head[t] = -1;
    M.set = [];
    for (const t of M.aTowers) t.laserState = 0;
    const beams = [], aTowers = [], ent = [];
    for (const t of (typeof _laserTowerList === 'function' ? _laserTowerList() : towers)) {
        if (t.type !== 'laser' || !t.connectedLasers || !t.connectedLasers.length || t.underConstruction || !(t.energy > 0)) continue;
        t._laserDmgSeen = t.currentStats ? t.currentStats.damage : 0;
        let isA = false;
        for (const o of t.connectedLasers) {
            if (!(t.gx < o.gx || (t.gx === o.gx && t.gy < o.gy))) continue;
            const b = beams.length, vert = t.gx === o.gx;
            const dmg = ((Number(t.currentStats && t.currentStats.damage) || 0) + (Number(o.currentStats && o.currentStats.damage) || 0)) / 60;
            const structs = [];
            const from = vert ? t.gy : t.gx, to = vert ? o.gy : o.gx;
            for (let c = from + 1; c < to; c++) {
                const gx = vert ? t.gx : c, gy = vert ? c : t.gy, k = gy * W + gx;
                if (M.head[k] === -1) M.set.push(k);
                ent.push(b, M.head[k]); M.head[k] = (ent.length >> 1) - 1;
                const e = getTileEntityRef(gx, gy);
                if (e && _projBuildingKind(e) >= 0) structs.push(e);
            }
            beams.push({ a: t, b: o, owner: t.owner, dmg, structs });
            isA = true;
        }
        if (isA) aTowers.push(t);
    }
    const ne = ent.length >> 1, nb = beams.length;
    if (M.cap < Math.max(ne, nb)) {
        const cap = Math.max(1024, 2 * Math.max(ne, nb));
        M.next = simSharedArray(Int32Array, cap); M.beam = simSharedArray(Int32Array, cap);
        M.bown = simSharedArray(Int32Array, cap); M.bdmg = simSharedArray(Float32Array, cap); M.hit = simSharedArray(Uint8Array, cap);
        simParallelBind('lz.next', M.next); simParallelBind('lz.beam', M.beam); simParallelBind('lz.bown', M.bown); simParallelBind('lz.bdmg', M.bdmg); simParallelBind('lz.hit', M.hit);
        M.cap = cap;
    }
    for (let k = 0; k < ne; k++) { M.beam[k] = ent[2 * k]; M.next[k] = ent[2 * k + 1]; }
    for (let b = 0; b < nb; b++) { M.bown[b] = Number.isFinite(beams[b].owner) ? beams[b].owner : -999; M.bdmg[b] = beams[b].dmg; }
    M.beams = beams; M.aTowers = aTowers;
}
// Once a tick, before the towers' updates (gameTick): every beam's damage.
function laserBeamsTick() {
    if (typeof ensureLaserConnections === 'function') ensureLaserConnections();
    const M = _laserMap;
    // (Structures placed or removed since: on a beam's tile, the map again.)
    if (typeof tileEntityChangesSince === 'function') {
        const ch = tileEntityChangesSince(M.cursor);
        if (ch === null) M.stale = true;
        else if (!M.stale && M.set.length && M.head) for (let i = 0; i < ch.length; i++) if (M.head[ch[i]] !== -1) { M.stale = true; break; }
    }
    if (M.stale) _laserMapBuild();
    const nb = M.beams.length;
    if (!nb) return;
    M.hit.fill(0, 0, nb);
    const S = typeof _simUnitState !== 'undefined' ? _simUnitState : null, n = S ? S.owners.length : 0;
    if (n > 0) {
        const chunks = Math.ceil(n / 8192);
        if (!M.count || M.count.length < chunks) { M.count = simSharedArray(Int32Array, Math.max(64, chunks * 2)); simParallelBind('lz.count', M.count); }
        // (The kernel lists each job's reporting slots: no pass over the job's slots here.)
        if (!M.list || M.list.length < n) { M.list = simSharedArray(Int32Array, simReserveCap(n)); simParallelBind('lz.list', M.list); }
        const P = _simParams;
        P[0] = n; P[1] = 8192; P[2] = TILE; P[3] = GRID_W; P[4] = GRID_H; P[5] = gameTime; P[6] = LASER_REPORT_TICKS; P[7] = SIM_SEP_ABSENT; P[8] = simDk;
        simParallelRun(SIM_KERNEL_LASER_HITS, chunks);
        // The records of the units reporting (in slot order).
        const C = S.columns, ACC = C.lzAcc, LB = C.lzBeam, owners = S.owners, LIST = M.list;
        for (let k = 0; k < chunks; k++) {
            for (let j = k * 8192, end = j + M.count[k]; j < end; j++) {
                const s = LIST[j];
                const u = owners[s], d = ACC[s], beam = M.beams[LB[s]];
                ACC[s] = 0;
                if (!u || !beam || !(d > 0)) continue;
                pushHostileDamageAlert(u, d, beam.owner);
                recordDamageVisual(u, d, beam.owner); shrineDamageTaken(u, d);
                createExplosion(u.x, u.y, "#f00", 1);
            }
        }
    }
    // Structures on the beams (in the map's order), then which lasers show lit.
    for (let b = 0; b < nb; b++) {
        // (A step of several base ticks: their damage.)
        const beam = M.beams[b], dmg = simDk > 1 ? beam.dmg * simDk : beam.dmg;
        for (const e of beam.structs) {
            if (e.owner === beam.owner || !(e.energy > 0) || getTileEntityRef(e.gx, e.gy) !== e) continue;
            M.hit[b] = 1;
            const prev = e.energy;
            e.energy -= dmg;
            pushHostileDamageAlert(e, prev - e.energy, beam.owner);
            recordDamageVisual(e, prev - e.energy, beam.owner); shrineDamageTaken(e, prev - e.energy);
            if (simStepCrosses(0, 10)) createExplosion(e.x, e.y, "#f84", 1);
            if (e.energy <= 0) destroyBuilding(e);
        }
    }
    for (const t of M.aTowers) t.laserState = 0;
    let lit = false;
    for (let b = 0; b < nb; b++) if (M.hit[b]) { M.beams[b].a.laserState = 1; lit = true; }
    if (lit && simStepCrosses(0, 40)) { const bm = M.beams[0]; playSound('laser_tick', bm.a.x, bm.a.y); }
}
// At a resync, on every peer: the map made again (its structures by
// object), the same way on every peer. (The units' unreported sums are
// state, kept: unit.js _laserPending.)
function laserBeamsReset() {
    _laserMap.stale = true; _laserMap.cursor = { epoch: -1, pos: 0 };
}
function _getTowerAttackRangeArea(tower) {
    return Math.max(0, Number(tower && tower.currentStats && tower.currentStats.attackRangeArea) || 0);
}

function _isTargetWithinTowerAttackAreaRange(tower, target, rangeArea = NaN) {
    if (!tower || !target) return false;
    let maxAreaDistance = Number.isFinite(rangeArea) ? Math.max(0, Number(rangeArea)) : _getTowerAttackRangeArea(tower);
    return isWorldTargetWithinAreaRange(tower.x, tower.y, target.x, target.y, Math.floor(maxAreaDistance));
}

function _isProducerStructure(e) {
    return e instanceof Barrack || e instanceof CollectorSpawner || e instanceof AstarSpawner || e instanceof SalvagerSpawner
        || e instanceof BuilderSpawner || e instanceof HealerSpawner || e instanceof ResearchSpawner;
}

// Nearest living enemy tower ('tower') or barrack/spawner ('producer') in
// the areas within `wholeRange` steps of the tower; ties go to the lower
// tile index.
function _findTowerStructureTarget(tower, wholeRange, kind) {
    let sources = getSourceAreaIdsAtWorld(tower.x, tower.y);
    if (sources.length === 0) return null;
    let box = getAreaRangeTileBox(sources, wholeRange);
    if (!hasHostileStructureInTileRect(tower.owner, box[0], box[1], box[2], box[3])) return null;
    let best = null, bestD2 = Infinity, bestKey = Infinity;
    let structuresByArea = getStructuresByArea();
    for (let areaId of getAreaIdsWithinDistanceOfSources(sources, wholeRange)) {
        let structures = structuresByArea[areaId];
        if (!structures) continue;
        for (let e of structures) {
            if (e === tower || e.owner === tower.owner || !(e.energy > 0)) continue;
            let isTower = e instanceof Tower;
            if (kind === 'tower' ? !isTower : (isTower || !_isProducerStructure(e))) continue;
            let dx = e.x - tower.x, dy = e.y - tower.y, d2 = dx * dx + dy * dy, key = e.gy * GRID_W + e.gx;
            if (d2 < bestD2 || (d2 === bestD2 && key < bestKey)) { best = e; bestD2 = d2; bestKey = key; }
        }
    }
    return best;
}

// Whether a structure or floor item hostile to the tower may stand in the
// areas within either range of it (by their tile box; the movement kernel's
// structure table: false is exact).
function _towerHostileStructureNear(tower, wholeRange, rangeArea) {
    const sources = getSourceAreaIdsAtWorld(tower.x, tower.y);
    if (sources.length === 0) return false;
    const box = getAreaRangeTileBox(sources, Math.max(wholeRange, Math.floor(Math.max(0, Number(rangeArea) || 0))));
    return hasHostileStructureInTileRect(tower.owner, box[0], box[1], box[2], box[3]);
}

// Nearest hostile floor item (never a barrack or spawner) in the tower's
// area range: traps, or everything else. Ties go to the lower tile index.
function _findTowerFloorTarget(tower, rangeArea, traps) {
    let sources = getSourceAreaIdsAtWorld(tower.x, tower.y);
    if (sources.length === 0) return null;
    let best = null, bestD2 = Infinity, bestKey = Infinity;
    let structuresByArea = getStructuresByArea();
    for (let areaId of getAreaIdsWithinDistanceOfSources(sources, Math.floor(Math.max(0, Number(rangeArea) || 0)))) {
        let structures = structuresByArea[areaId];
        if (!structures) continue;
        for (let item of structures) {
            if (item.energy <= 0 || item.underConstruction || isTrapItem(item) !== traps) continue;
            if (getFloorItemAtTile(item.gx, item.gy) !== item) continue;
            let cell = grid[item.gy][item.gx];
            let owner = item.owner !== undefined ? item.owner : cell.owner;
            if (owner === tower.owner || owner < 0) continue;
            let dx = item.x - tower.x, dy = item.y - tower.y, d2 = dx * dx + dy * dy, key = item.gy * GRID_W + item.gx;
            if (d2 < bestD2 || (d2 === bestD2 && key < bestKey)) { best = item; bestD2 = d2; bestKey = key; }
        }
    }
    return best;
}

// One traversal for the structure fallback. The old cascade walked the same
// areas up to four times (and repeated their range/hostility lookups). Reduce
// by target class first, distance second and tile index third instead.
function _findTowerBuildingTarget(tower,rangeArea){
    const T = _towerAcq;
    if (T.ready && T.tick === gameTime && T.list[T.pos - 1] === tower) {
        const tile = T.arrays.sout[T.pos - 1];
        if (tile !== -2) return tile >= 0 ? getTileEntityRef(tile % GRID_W, Math.floor(tile / GRID_W)) : null;
    }
    const x=tower.x,y=tower.y,owner=tower.owner,sources=getSourceAreaIdsAtWorld(x,y);
    if(!sources.length)return null;
    const range=Math.floor(Math.max(0,Number(rangeArea)||0)),box=getAreaRangeTileBox(sources,range);
    if(!hasHostileStructureInTileRect(owner,box[0],box[1],box[2],box[3]))return null;
    const byArea=getStructuresByArea();
    let best=null,priority=4,bestD2=Infinity,bestKey=Infinity;
    for(const area of getAreaIdsWithinDistanceOfSources(sources,range)){
        const list=byArea[area];if(!list)continue;
        for(const e of list){
            if(e===tower||e.owner===owner||!(e.energy>0))continue;
            let p;
            if(e instanceof Tower)p=0;
            else if(priority===0)continue;
            else if(_isProducerStructure(e))p=2;
            else{
                p=isTrapItem(e)?1:3;
                if(p>priority)continue;
                if(e.underConstruction||getFloorItemAtTile(e.gx,e.gy)!==e)continue;
                const own=e.owner!==undefined?e.owner:grid[e.gy][e.gx].owner;
                if(own===owner||own<0)continue;
            }
            if(p>priority)continue;
            const dx=e.x-x,dy=e.y-y,d2=dx*dx+dy*dy,key=e.gy*GRID_W+e.gx;
            if(p<priority||d2<bestD2||(d2===bestD2&&key<bestKey)){
                best=e;priority=p;bestD2=d2;bestKey=key;
            }
        }
    }
    return best;
}

// ============================================================
// TOWER CLASS
// ============================================================
// Towers act only when due (towersTick): a tower's cooldown is the tick it
// ends (_cdUntil; cd reads and sets the ticks left), and setting it puts the
// tower in the due wheel at the tick after (as the countdown it replaces:
// a cooldown of N set at tick T acts again at T + N + 1). The wheel is made
// anew from every tower after a resync on every peer (towerDueReset).
let _towerDue = null;
function towerDueReset() { _towerDue = null; }
function towerSchedule(t) {
    const W = _towerDue;
    if (!W || !t || t.energy <= 0 || t.underConstruction || (typeof t.type === 'string' && (t.type === 'laser' || t.type.startsWith('cloud')))) return;
    const at = Math.max(gameTime + 1, Math.ceil(Number(t._cdUntil) || 0) + 1);
    let L = W.get(at);
    if (!L) W.set(at, L = []);
    L.push(t);
}
// The cooldown of a tower that found no unit to shoot: its usual one,
// lengthened (once: from then on it is exact) to end on the tower's own place
// in the wheel of that cooldown (by its tile). Idle towers then look again
// spread over the cooldown's ticks, not all on one: every tower of a base
// finding nothing on the same tick looked again on the same later tick, for
// good (their searches for a structure to shoot instead: a 45-60 ms tick
// every cooldown with 6k towers). A function of the tick and the tile only.
function towerIdleCooldown(t, base) {
    base = Math.max(1, Math.ceil(Number(base) || 1));
    // (A cooldown of N set now acts again at gameTime + N + 1 (towerSchedule):
    // an idle tower's looks are N + 1 ticks apart, the wheel's size.)
    const period = base + 1, at = gameTime + period, slot = (t.gy * GRID_W + t.gx) % period;
    return base + (((slot - at) % period) + period) % period;
}
function _towerDueBuild(now) {
    const W = _towerDue = new Map();
    for (const t of towers) {
        if (!t || t.energy <= 0 || t.underConstruction || t.type === 'laser' || (typeof t.type === 'string' && t.type.startsWith('cloud'))) continue;
        const at = Math.max(now, Math.ceil(Number(t._cdUntil) || 0) + 1);
        let L = W.get(at);
        if (!L) W.set(at, L = []);
        L.push(t);
    }
    return W;
}
// Read-only acquisition for all due towers, before any of them shoot. Their
// projectiles are resolved afterwards, so every query sees the same live unit
// state. Snapshot by spatial ENTRY (not slot) for contiguous SIMD loads.
// No persistent per-unit columns: three reusable scratch arrays, 12 B/entry.
let SIM_TOWER_WASM=true,SIM_TOWER_VERIFY=false;
const _towerAcq={list:[],areaLists:[],arrays:{},pos:0,ready:false,tick:-1,lastN:0,lastActive:0,lastUsed:0};
const _towerAcqTypes={fire:1,water:2,poison:3,ice:4,elements:5,sand_gun:6,watch_tower:7};
function _towerAcqArray(name,Type,n){
    const T=_towerAcq,old=T.arrays[name];
    if(old&&old.length>=n)return old;
    const a=T.arrays[name]=simSharedArray(Type,simReserveCap(Math.max(1,n),256));
    simParallelBind('tac.'+name,a);if(old)simHeapFree(old);return a;
}
function _towerAcqPrepare(due){
    const T=_towerAcq;T.ready=false;T.list.length=0;T.areaLists.length=0;T.pos=0;T.lastN=0;T.lastActive=0;T.lastUsed=0;
    if(!SIM_TOWER_WASM||SIM_TOWER_TYPE_OVERRIDES||CHUNK_SIZE!==1||!_sxBySlot||!_ST.n||!_simWasmOk(_simParReg)||typeof _simWasmX.k_tower_scan!=='function'||due.length<128)return;
    spatialIndexEnsure();_visibilityKernelAreas();
    _simMoveStructs();
    simParallelBind('mv.stblk',_simMoveStructBlocks);
    for (const key of ['code','own','uc','val']) simParallelBind('st.' + key, _ST[key]);
    const qx=_towerAcqArray('qx',Float32Array,due.length),qy=_towerAcqArray('qy',Float32Array,due.length),owner=_towerAcqArray('owner',Int32Array,due.length),type=_towerAcqArray('type',Int32Array,due.length);
    const base=_towerAcqArray('base',Int32Array,due.length),qtile=_towerAcqArray('tile',Int32Array,due.length);
    const boxes=_towerAcqArray('boxes',Int32Array,due.length*4),live=_towerAcqArray('live',Uint32Array,due.length),qr=_towerAcqArray('range',Int32Array,due.length);
    const ST=_ST;
    let prev=null,total=0,active=0;
    for(const t of due){
        if(t===prev)continue;prev=t;
        // The authoritative tile SoA avoids repeatedly going through the
        // structure object's paged accessors while preparing a large burst.
        const tile=t._stT;
        if(tile<0||ST.code[tile]!==0x22||!(ST.val[tile]>0)||ST.uc[tile]||gameTime<=Math.ceil(ST.tim[tile]))continue;
        const gx=tile%GRID_W,gy=(tile-gx)/GRID_W;
        if(tileEntityRef[gy][gx]!==t)continue;
        const name=t.type;if(name==='laser'||name.startsWith('cloud'))continue;
        const stats=t.currentStats,x=t.x,y=t.y,own=ST.own[tile],sources=getSourceAreaIdsAtWorld(x,y),range=Math.floor(Math.max(0,Number(stats.attackRangeArea)||0));
        const i=T.list.length,o=i*4;boxes[o+2]=-1;
        if(sources.length){
            const box=getAreaRangeTileBox(sources,range);
            boxes[o]=box[0];boxes[o+1]=box[1];boxes[o+2]=box[2];boxes[o+3]=box[3];
        }
        qx[i]=x;qy[i]=y;owner[i]=own;type[i]=_towerAcqTypes[name]||0;qr[i]=range;
        // Preferred targets retain their ordered resolution in shoot().
        base[i]=!t.preferredTarget&&!t.preferredTargetSpec?Math.max(1,Math.ceil(secondsToTicks(stats.cd||1.5))):0;qtile[i]=tile;
        T.list.push(t);T.areaLists.push(sources);
    }
    if(!T.list.length)return;
    const P=_simParams;P[0]=T.list.length;P[1]=32;P[2]=spatialUnitsComplexPlayerCount;P[3]=spatialBlockCols;P[4]=GRID_W;P[5]=SPATIAL_BLOCK_SIZE;
    simParallelRun(SIM_KERNEL_TOWER_COARSE,Math.ceil(T.list.length/32));
    for(let i=0;i<T.list.length;i++){
        const sources=T.areaLists[i],ids=live[i]?getAreaIdsWithinDistanceOfSources(sources,qr[i]):null;
        T.areaLists[i]=ids;if(ids?.length){total+=ids.length;active++;}
    }
    T.lastN=T.list.length;T.lastActive=active;
    const n=T.list.length,nt=_simUnitTypeNames.length,flags=_towerAcqArray('flags',Uint8Array,nt);
    for(let i=0;i<nt;i++){
        const b=BASE_UNIT_STATS[_simUnitTypeNames[i]]||BASE_UNIT_STATS.norm;
        flags[i]=(b.turretImmune?1:0)|(b.fireResistant?2:0)|(b.waterResistant?4:0)|(b.poisonResistant?8:0)|(b.iceResistant?16:0);
    }
    for(const name of ['x','y','meta'])_towerAcqArray(name,Int32Array,_sxListed+4);
    const off=_towerAcqArray('off',Int32Array,n+1),ids=_towerAcqArray('areas',Int32Array,total);
    _towerAcqArray('out',Int32Array,n);
    _towerAcqArray('sout',Int32Array,n);
    _towerAcqArray('idle',Int32Array,n);
    let at=0;
    for(let i=0;i<n;i++){
        const areas=T.areaLists[i];off[i]=at;
        if(areas){ids.set(areas,at);at+=areas.length;}
    }
    off[n]=at;
    P[0]=_sxListed;P[1]=4096;P[2]=nt;
    const normal=BASE_UNIT_STATS.norm;P[3]=(normal.turretImmune?1:0)|(normal.fireResistant?2:0)|(normal.waterResistant?4:0)|(normal.poisonResistant?8:0)|(normal.iceResistant?16:0);
    if(active)simParallelRun(SIM_KERNEL_TOWER_PACK,Math.ceil(_sxListed/4096));
    P[0]=n;P[1]=32;P[2]=_sxEpoch;
    if(active)simParallelRun(SIM_KERNEL_TOWER_SCAN,Math.ceil(n/32));else T.arrays.out.fill(-1,0,n);
    P[3]=GRID_W;P[4]=TILE;P[5]=gameTime;
    simParallelRun(SIM_KERNEL_TOWER_STRUCT,Math.ceil(n/32));
    T.ready=true;T.tick=gameTime;
}
function _towerAcqTake(t){
    const T=_towerAcq;if(!T.ready||T.tick!==gameTime||T.list[T.pos]!==t)return undefined;
    T.lastUsed++;const s=T.arrays.out[T.pos++];return s>=0?_simUnitState.owners[s]||null:null;
}
// Attached structures already carry their row-major tile key. Reading gx/gy
// through the paged structure table for every sort comparison is costly on
// a mass cooldown burst. Detached entries retain their coordinate fallback.
function _towerTileOrder(a, b) {
    const at = a._stT, bt = b._stT;
    return (at >= 0 ? at : a.gy * GRID_W + a.gx) - (bt >= 0 ? bt : b.gy * GRID_W + b.gx);
}
const _towerSort={list:[]};
function _towerSortDue(due){
    if(due.length<128||!_simWasmOk(_simParReg)||typeof _simWasmX.k_tower_order!=='function'){due.sort(_towerTileOrder);return;}
    const n=due.length,keys=_towerAcqArray('sortKeys',Int32Array,n),order=_towerAcqArray('sortOrder',Int32Array,n);
    _towerAcqArray('sortTmp',Int32Array,n);
    for(let i=0;i<n;i++){const t=due[i],tile=t._stT;keys[i]=tile>=0?tile:t.gy*GRID_W+t.gx;}
    simParallelStageParams(SIM_LANE_TICK,0)[0]=n;
    simParallelBackground(SIM_KERNEL_TOWER_ORDER,1,SIM_LANE_TICK);
    // Independent input preparation lets the helper finish the radix pass.
    spatialIndexEnsure();_visibilityKernelAreas();_simMoveStructs();
    simParallelBackgroundWait(SIM_LANE_TICK);
    const copy=_towerSort.list;copy.length=n;
    for(let i=0;i<n;i++)copy[i]=due[i];
    for(let i=0;i<n;i++)due[i]=copy[order[i]];
    copy.length=0;
}
// A tick of the towers: statuses of those with some running (every tick, as
// ever), then the towers due, in tile order; any whose energy ran out are
// removed (the list from the end, as ever).
function towersTick() {
    let dead = false, st = null;
    for (const e of _thingStatusSelf) if (e instanceof Tower) (st || (st = [])).push(e);
    if (st) {
        st.sort(_towerTileOrder);
        for (const e of st) { if (e.energy > 0) thingStatusTickSelf(e); if (!(e.energy > 0)) dead = true; }
    }
    const W = _towerDue || _towerDueBuild(gameTime);
    // (Those due at any of the step's base ticks.)
    let due = null;
    for (let b = gameTime - simDk + 1; b <= gameTime; b++) {
        const L = W.get(b);
        if (!L) continue;
        W.delete(b);
        due = due ? due.concat(L) : L;
    }
    if (due) {
        _towerSortDue(due);
        _towerAcqPrepare(due);
        let prev = null;
        for (const t of due) {
            if (t === prev) continue;
            prev = t;
            const A=_towerAcq;
            if(!SIM_TOWER_VERIFY&&A.ready&&A.list[A.pos]===t&&A.arrays.idle[A.pos]>0){
                const cd=A.arrays.idle[A.pos++];A.lastUsed++;t.cd=cd;continue;
            }
            if (!(t.energy > 0)) { dead = true; continue; }
            // (Only once its cooldown is over, by its deadline: an entry
            // left from a cooldown set again since never acts early, so
            // what the wheel holds besides the deadlines is nothing a
            // restored peer, whose wheel is made from them, could miss.)
            if (gameTime <= Math.ceil(Number(t._cdUntil) || 0)) continue;
            // (How many of the step's base ticks it stood ready: its shots,
            // _towerShotCooldown.)
            _towerLate = simDk > 1 ? Math.max(0, Math.min(simDk - 1, gameTime - (Math.ceil(Number(t._cdUntil) || 0) + 1))) : 0;
            if (getTileEntityRef(t.gx, t.gy) === t) t.act();
            _towerLate = 0;
            if (!(t.energy > 0)) dead = true;
        }
        _towerAcq.ready=false;_towerAcq.list.length=0;_towerAcq.areaLists.length=0;
    }
    if (dead) {
        for (let i = towers.length - 1; i >= 0; i--) if (towers[i].energy <= 0) destroyBuilding(towers[i]);
        for (const e of [..._thingStatusSelf]) if ((e instanceof Tower) && !(e.energy > 0) && getTileEntityRef(e.gx, e.gy) !== e) _thingStatusSelf.delete(e);
    }
}

// A tower's shot at a step of several base ticks (simDk): the base ticks it
// stood ready before the step's end (_towerLate, towersTick) make its shots,
// 1 + late / (cooldown + 1) (a cooldown of N acts every N + 1 base ticks),
// their damage at once, its next turn where the last one's would be.
// (One base tick a step: no lateness, one shot, its cooldown.)
let _towerLate = 0;
function _towerShots(t) {
    const N = secondsToTicks(t.currentStats.cd || 1.5);
    const shots = _towerLate > 0 ? 1 + Math.floor(_towerLate / (N + 1)) : 1;
    return { shots, cd: shots * (N + 1) - 1 - _towerLate };
}
function _towerProjectile(t, target, maxRange) {
    const k = _towerShots(t), st = t.currentStats;
    const dmg = k.shots > 1 ? st.damage * k.shots : st.damage, blast = k.shots > 1 && st.blastDamage ? st.blastDamage * k.shots : st.blastDamage;
    const p = new Projectile(t.x, t.y, target, t.type, dmg, getThingEffectiveLevel(t), t, maxRange, blast, st.blastRadius);
    if (k.shots > 1) p.shots = k.shots;
    projectiles.push(p);
    t.cd = k.cd;
    return k.shots;
}
// A tower's shot as a look: its muzzle, and (src -shots, dst the target unit's
// id or 0) the volley the page draws in flight to its target as drawn, on
// its own clock (effects3d.js _fxVolley): a step of several base ticks fires
// one projectile for all its shots, often spent within the step, never drawn.
function _towerShotFx(t, target, shots) {
    const unit = typeof Unit === 'function' && target instanceof Unit;
    recordCombatFx(COMBAT_FX.MUZZLE, t.x, t.y, target.x, target.y, t.type, -Math.max(1, shots | 0), unit ? target.id : 0);
}

class Tower {
    // (The cooldown: see towerSchedule.)
    get cd() { return Math.max(0, (Number(this._cdUntil) || 0) - gameTime); }
    set cd(v) { this._cdUntil = gameTime + Math.max(0, Number(v) || 0); if (this._stT >= 0 && typeof _ST !== 'undefined' && _ST.n) _ST.tim[this._stT] = this._cdUntil; towerSchedule(this); }
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
        this.connectedLasers = [];
        this.laserState = 0; this.laserTimer = 0;
        // effectiveLevel the current connectedLasers were computed with.
        this._laserLinkLevel = -1;
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
        if (this.type === 'laser' && this.connectedLasers) this.laserCheck();
    }

    calcStats(lvl) {
        return calculateItemStats(this.type, lvl, this.owner);
    }

    update() {
        if (this.energy <= 0) return;
        thingStatusTickSelf(this);
        this.act();
    }

    // Its turn (towersTick: due, its cooldown over).
    act() {
        if (this.energy <= 0) return;
        if (this.underConstruction) {
            let requiredEnergy = Math.max(1, Math.floor(getUpgrademaxEnergy(this, 1) || this.maxEnergy || 1));
            if ((Number(this.energy) || 0) >= requiredEnergy) markConstructionComplete(this);
            if (this.underConstruction) return;
        }
        if (this.type.startsWith('cloud')) return;

        if (this.type === 'laser') { this.laserCheck(); return; }

        if (this.cd > 0) return;
        this.shoot();
    }

    // A laser's beams are the map's (laserBeamsTick). Reach depends on its
    // effective level (0 while under construction, adjacency, upgrades),
    // damage on its stats: relinked when they move (checked where its stats
    // are made: updateStats).
    laserCheck() {
        if (this.type !== 'laser') return;
        // (Its row and column relinked; the beam map follows if a link
        // changed, or its damage did.)
        if (this._laserLinkLevel !== this.effectiveLevel && typeof markLaserConnectionsDirty === 'function') markLaserConnectionsDirty(this.gx, this.gy);
        if (this.currentStats && this._laserDmgSeen !== this.currentStats.damage && this.connectedLasers && this.connectedLasers.length && typeof laserMapDirty === 'function') laserMapDirty();
    }

    shoot() {
        if (this.cd > 0) return;
        const cachedUnit=_towerAcqTake(this);
        let rangeArea = _getTowerAttackRangeArea(this);
        let projectileMaxRange = Math.max(WORLD_W, WORLD_H) * 2;
        let preferredTarget = getTowerPreferredTargetInRange(this, rangeArea);
        if (preferredTarget) {
            let target = preferredTarget;
            const shots = _towerProjectile(this, target, projectileMaxRange);
            this.angle = Math.atan2(target.y - this.y, target.x - this.x);
            if (typeof simPresentTowerAngle === 'function') simPresentTowerAngle(this);
            _towerShotFx(this, target, shots);
            playSound('shoot_' + this.type, this.x, this.y);
            return;
        }
        const wholeRange=Math.floor(rangeArea);
        let target;
        if(cachedUnit===undefined||SIM_TOWER_VERIFY){
        let bestPrimary = null, bestSecondary = null, bestImmune = null;
        let dPrimary = Infinity, dSecondary = Infinity, dImmune = Infinity;
        const x=this.x,y=this.y,type=this.type,owner=this.owner;
        const canImmune=type==='fire'||type==='water'||type==='poison'||type==='ice'||type==='elements';
        const canAffected=type==='fire'||type==='water'||type==='poison'||type==='ice'||type==='sand_gun'||type==='watch_tower';

        // Every unit in the areas within floor(range) steps is in range (the
        // area of its tile is its bucket's), so no per-unit range check.
        forEachUnitInAreaRange(x, y, wholeRange, (u) => {
            if (u.turretImmune) return;
            let dx = u.x - x;
            let dy = u.y - y;
            let d2 = dx * dx + dy * dy;
            let d = Math.sqrt(d2);
            // None of the target classes this tower can choose can improve.
            // Preserve strict distance ties and the area's visiting order.
            if(d>=dPrimary&&(!canAffected||d>=dSecondary)&&(!canImmune||d>=dImmune))return;

            let immune = (type === 'fire' && u.fireResistant) || (type === 'water' && u.waterResistant) ||
                (type === 'poison' && u.poisonResistant) || (type === 'ice' && u.iceResistant) ||
                (type === 'elements' && (u.waterResistant || u.fireResistant || u.poisonResistant || u.iceResistant));

            if (immune) { if (d < dImmune) { dImmune = d; bestImmune = u; } }
            else {
                let affected = false;
                if (type === 'fire') affected = u.burning > 0;
                else if (type === 'poison') affected = u.poisoned > 0;
                else if (type === 'water') affected = u.wet > 0;
                else if (type === 'ice') affected = u.frozen > 0;
                else if (type === 'sand_gun') affected = u.sandy > 0;
                else if (type === 'watch_tower') affected = u.watched > 0 && u.watchedByTeam === owner;
                if (!affected) { if (d < dPrimary) { dPrimary = d; bestPrimary = u; } }
                else { if (d < dSecondary) { dSecondary = d; bestSecondary = u; } }
            }
        }, { enemyOfPlayer: owner, areaOnly: true, readOnlyColumns: true });

        target = bestPrimary || bestSecondary || bestImmune;
        if(cachedUnit!==undefined&&target!==cachedUnit){
            const info=u=>u&&({id:u.id,type:u.unitType,x:u.x,y:u.y,owner:u.owner,dead:u.dead,fire:u.fireResistant,water:u.waterResistant,poison:u.poisonResistant,ice:u.iceResistant,burning:u.burning,wet:u.wet,poisoned:u.poisoned,frozen:u.frozen,sandy:u.sandy,watched:u.watched,team:u.watchedByTeam});
            throw Error('Tower SIMD target differs '+this.type+' at '+this.gx+','+this.gy+': '+JSON.stringify({scalar:info(target),simd:info(cachedUnit)}));
        }
        }
        if(cachedUnit!==undefined)target=cachedUnit;

        // If no unit target, the nearest enemy building in range: towers
        // first, then traps, then barracks and spawners, then other floor
        // buildings. Only the structures in the areas in range are visited.
        // (First whether any hostile structure or floor item stands in the
        // box of the areas in either range: most idle towers have none near,
        // and each search visited every structure of those areas.)
        if (!target) target=_findTowerBuildingTarget(this,rangeArea);
        if (!target) {
            // (Nothing to shoot: it looks again on a tick of its own. Set
            // once, when nothing was found: a cooldown set twice with
            // different ends leaves the tower in the wheel at both.)
            if (!target) this.cd = towerIdleCooldown(this, secondsToTicks(this.currentStats.cd || 1.5));
        }

        if (target) {
            const shots = _towerProjectile(this, target, projectileMaxRange);
            this.angle = Math.atan2(target.y - this.y, target.x - this.x);
            if (typeof simPresentTowerAngle === 'function') simPresentTowerAngle(this);
            _towerShotFx(this, target, shots);
            playSound('shoot_' + this.type, this.x, this.y);
        }
    }

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
