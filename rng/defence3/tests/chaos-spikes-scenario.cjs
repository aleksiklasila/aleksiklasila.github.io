// Mixed workload used by chaos-spikes.bench.cjs. Originally developed for
// .claude/tickbench.cjs (CHAOS=queue|mixed), evaluated in
// every peer at the same tick (setup) and as each peer's player's commands
// (bursts): lots of different things happening at once, to find tick spikes
// and slow paths no single-purpose bench shows.
//
// CHAOS=queue (tests/chaos-queue-600.json): per team CHAOS_BUILDINGS (5000)
//   barracks and worker buildings on a lattice over the team's half, a
//   healer building every 10th, labs among them; collector buildings (energy
//   and astar) beside the mines with their collectors at work; every
//   building leveled up (CHAOS_LEVEL, 6) and its queue full (barracks 20,
//   worker buildings 10: the game's caps); the healers spread over the
//   buildings; researchers (level 9) with the research stats raised and the
//   research queue full of cheap and dear stats; 30 rally points over the
//   map; tower sites under construction for the builders, some marked for
//   salvage.
// CHAOS=mixed (tests/chaos-mixed-600.json): the same with the buildings in
//   each team's outer third, and the armies (30k a team) in thick lines
//   across the middle third, between rows of towers and floor traps,
//   attack-moving into each other.
// Bursts (CHAOS_BURSTS, default 20, CHAOS_GAP ms apart, default 1000): each
// peer tops queues up (at most ~200 actions a packet), moves rally points,
// queues research, places towers for the builders, and in mixed sends the
// armies' orders by turns.
'use strict';

// (Evaluated in the game's context: game globals only, no closures.)
function chaosSetup(o) {
    let seed = o.seed || 777;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    const W = GRID_W, H = GRID_H, np = Math.min(o.teams || 2, players.length);
    const zeros = () => Array(np).fill(0);
    const st = { buildings: zeros(), collectorBuildings: zeros(), queued: 0, research: 0, rallies: 0, towerSites: zeros(), salvage: 0, army: zeros(), traps: 0, armyTowers: 0, healersPlaced: 0, errors: [] };
    const free = (gx, gy) => { if (gx < 2 || gy < 2 || gx >= W - 2 || gy >= H - 2) return false; const c = grid[gy][gx]; return c.type === TYPE_FLOOR && !c.item && !getTileEntityRef(gx, gy) && !getGoldMineAt(gx, gy); };
    const entityAt = (gx, gy) => getTileEntityRef(gx, gy) || (grid[gy][gx] && grid[gy][gx].item) || null;
    // As main.js completeStarterBuilding: built, at a level, full.
    const complete = (item, key, owner, lvl) => {
        const stacks = getRequiredStacksForLevel(lvl);
        item.stacks = stacks; item.effectiveStacks = stacks; item.level = lvl; item.effectiveLevel = lvl; item.potentialEffectiveLevel = lvl;
        item.underConstruction = false; if (typeof structureWallSync === 'function') structureWallSync(item); item.isUpgrading = false; upkeepThingDirty(item);
        if (item instanceof Tower) item.updateStats();
        else {
            const calcType = item.type === 'barrack' ? 'barrack_' + item.unitType : key, s = calculateItemStats(calcType, lvl, owner);
            if (Number.isFinite(s.maxEnergy)) { item.maxEnergy = Math.max(1, Math.floor(s.maxEnergy)); item.energy = item.maxEnergy; }
            if (Number.isFinite(s.damage)) item.damage = s.damage;
            if (item.spawnCooldown !== undefined) item.spawnCooldown = Math.round(getBarrackSpawnCooldown(getSpawnerFallbackUnitType(item), lvl, owner, item.type === 'barrack' ? 'barrack_' + item.unitType : item.type) * TICK_RATE);
        }
        updateItemTextCache(item);
        if (typeof visCoverOnBuildingChanged === 'function') visCoverOnBuildingChanged(item);
    };
    const place = (gx, gy, key, p, built = true, lvl = o.level) => {
        if (!free(gx, gy)) return null;
        if (!placeBuilding(gx, gy, key, p, { ignorePlacementRules: true, silent: true, autoUpgradeEnabled: true, buildEnabled: true })) return null;
        const e = entityAt(gx, gy);
        if (e && built) complete(e, key, p, lvl);
        return e;
    };
    const freeNear = (gx, gy, r) => { for (let d = 1; d <= r; d++) for (let dy = -d; dy <= d; dy++) for (let dx = -d; dx <= d; dx++) { if (Math.max(Math.abs(dx), Math.abs(dy)) !== d) continue; if (free(gx + dx, gy + dy)) return { gx: gx + dx, gy: gy + dy }; } return null; };
    const put = (u, gx, gy) => { const t = findNearestWalkable(Math.max(1, Math.min(W - 2, gx)), Math.max(1, Math.min(H - 2, gy))); u.x = u.prevX = t.x * TILE + 16; u.y = u.prevY = t.y * TILE + 16; updateUnitSpatial(u); u._workerNextIdleRetargetTick = gameTime; u._idleFailVer = -1; };
    // Each team's band of rows for its buildings (queue: its half; mixed and
    // mega: its outer third, the armies between).
    const battle = o.mode === 'mixed' || o.mode === 'mega';
    const band = p => {
        const [lo, hi] = battle ? (!(p&1) ? [4, Math.floor(H/3)-4] : [Math.floor(2*H/3)+4,H-4]) : (!(p&1) ? [4,Math.floor(H/2)-3] : [Math.floor(H/2)+3,H-4]);
        const n=Math.ceil((np-(p&1))/2),part=p>>1;
        return [lo+Math.floor((hi-lo)*part/n),lo+Math.floor((hi-lo)*(part+1)/n)];
    };
    const barrackKeys = BUILD_CATEGORIES.barracks.filter(k => BASE_CARD_TYPES[k]);
    const workerKeys = ['builder_spawner', 'salvager', 'research', 'builder_spawner', 'research'].filter(k => BASE_CARD_TYPES[k]);
    const towerKeys = BUILD_CATEGORIES.towers.filter(k => k !== 'watch_tower' && BASE_CARD_TYPES[k]);
    const trapKeys = ['lava', 'poison_puddle', 'ice_patch', 'water_puddle', 'sand', 'mine'].filter(k => BASE_CARD_TYPES[k]);
    const built = Array.from({length:np},()=>[]);
    const jobs=Array.from({length:np},()=>({}));
    const fronts=[];
    for (let p = 0; p < np; p++) {
        // Collector buildings by the mines of the team's band, the collectors at them.
        const [y0, y1] = band(p);
        const mine = units.filter(u => !u.dead && u.owner === p);
        for (const cfg of RESOURCE_TYPE_LIST) {
            const mines = (_getResourceCollectorMineArray(cfg) || []).filter(m => m && m.gy >= y0 && m.gy < y1);
            const cols = mine.filter(u => u.workerType === cfg.collectorUnitKey);
            let ci = 0;
            for (let i = 0; i < mines.length && st.collectorBuildings[p] < o.collectorBuildings; i += 3) {
                const at = freeNear(mines[i].gx, mines[i].gy, 3);
                if (!at) continue;
                const e = place(at.gx, at.gy, cfg.collectorBuildingKey, p);
                if (!e) continue;
                st.collectorBuildings[p]++; built[p].push(e);
                for (let k = 0; k < 4 && ci < cols.length; k++) put(cols[ci++], mines[(i + k) % mines.length].gx, mines[(i + k) % mines.length].gy);
            }
            if(o.structures)for(;ci<cols.length&&mines.length;ci++){
                const m=mines[ci%mines.length];put(cols[ci],m.gx+(ci%3)-1,m.gy+((ci/3|0)%3)-1);
            }
        }
        // The lattice: every 3rd tile, a healer building every 10th.
        let k = 0;
        for (let gy = y0 + 1; gy < y1 && st.buildings[p] < o.buildings; gy += 3) for (let gx = 4 + (gy % 2); gx < W - 4 && st.buildings[p] < o.buildings; gx += 3) {
            if (rnd() < 0.08) continue;
            const key = k % 10 === 9 ? 'healer_spawner' : k % 10 >= 7 ? workerKeys[(k / 10 | 0) % workerKeys.length] : barrackKeys[(k * 7 + (k / 10 | 0)) % barrackKeys.length];
            const e = place(gx, gy, key, p);
            if (!e) continue;
            k++; st.buildings[p]++; built[p].push(e);
        }
    }
    // mega: every other kind of building too: farms beside the collector
    // buildings, area upgraders, watch towers, the cloud portal pairs; and
    // some boosts on.
    if (o.mode === 'mega') {
        st.extra = { farms: 0, upgraders: 0, watch: 0, clouds: 0, boosts: 0 };
        for (let p = 0; p < np; p++) {
            const [y0, y1] = band(p);
            for (const b of built[p]) {
                const cfg = RESOURCE_TYPE_LIST.find(c => c.collectorBuildingKey === b.type);
                if (!cfg || st.extra.farms >= 400 * (p + 1)) continue;
                const at = freeNear(b.gx, b.gy, 3);
                if (at && place(at.gx, at.gy, cfg.farmKey, p)) { st.extra.farms++; built[p].push(entityAt(at.gx, at.gy)); }
            }
            for (let i = 0; i < 300; i++) {
                const gx = 4 + Math.floor(rnd() * (W - 8)), gy = y0 + Math.floor(rnd() * (y1 - y0));
                if (BASE_CARD_TYPES.watch_tower && place(gx, gy, 'watch_tower', p)) st.extra.watch++;
            }
            // Area upgrades: small areas of the band filled with houses (an
            // upgrader needs every cell built), then 1-3 levels up.
            for (let a = 0, areasDone = 0; a < areas.length && areasDone < 80; a++) {
                const cells = gridCellsByArea[a];
                if (!Array.isArray(cells) || cells.length < 2 || cells.length > 12 || !cells.every(c => c.y >= y0 && c.y < y1)) continue;
                if (!cells.every(c => entityAt(c.x, c.y) || free(c.x, c.y))) continue;
                for (const c of cells) if (!entityAt(c.x, c.y)) place(c.x, c.y, 'house', p);
                if (!cells.every(c => entityAt(c.x, c.y))) continue;
                areasDone++;
                (st.upgradeAreas || (st.upgradeAreas = Array.from({length:np},()=>[])))[p].push(cells[0].x, cells[0].y);
                for (let l = 0; l <= a % 3; l++) if (placeBuilding(cells[0].x, cells[0].y, 'area_upgrader', p, { silent: true })) st.extra.upgraders++;
            }
            for (let c = 0; c < 4; c++) for (const end of ['a', 'b']) {
                const key = 'cloud_' + c + end;
                if (!BASE_CARD_TYPES[key]) continue;
                for (let tries = 0; tries < 50; tries++) {
                    const gx = end === 'a' ? 10 + Math.floor(rnd() * (W / 3)) : W - 10 - Math.floor(rnd() * (W / 3)), gy = y0 + Math.floor(rnd() * (y1 - y0));
                    if (place(gx, gy, key, p)) { st.extra.clouds++; break; }
                }
            }
            for (const [kind, key] of [['unit', 'norm'], ['unit', 'tank'], ['unit', 'healer_unit'], ['building', 'barrack_fast'], ['building', 'pistol'], ['building', 'healer_spawner']]) {
                processAction(sanitizeAction({ action: 'setBoost', kind, key, res: 'energy', steps: 1 + (st.extra.boosts % 3) }), p); st.extra.boosts++;
            }
        }
        if (typeof recalculateLaserConnections === 'function') recalculateLaserConnections();
    }
    if(o.layout==='front'){
        for(let y=Math.floor(H/3)+12;y+30<2*H/3;y+=40)for(let x=8;x<W-8;x+=2){
            // Gaps break the solid production rows into walkable sections.
            if(x%16===0)continue;
            for(let p=0;p<np;p++){
                const gy=y+p*24,homeY=gy+(p?2:-2);
                const b=place(x,gy,barrackKeys[(x/2+y)%barrackKeys.length],p);
                if(b){built[p].push(b);fronts.push({b,homeY,targetY:y+(p?8:16)});}
                const h=place(x,homeY,'healer_spawner',p);if(h)built[p].push(h);
                if(x%32===8)place(x,homeY+(p?2:-2),towerKeys[(x+y)%towerKeys.length],p);
            }
        }
        st.frontBarracks=fronts.length;
    }
    // Dense checkerboard with open corridors: retain the mixed battle and
    // economy above, but stress hundreds of thousands of live things as well.
    // Insert before queues and worker placement, so these are real job sites.
    if(o.structures){
        let total=new Set([...towers,...getCellItemsRowMajor()]).size,k=0;
        st.dense={added:0,types:{}};
        const remember=(p,role,e)=>{(jobs[p][role]||(jobs[p][role]=[])).push(e);};
        for(let gy=3;gy<H-3&&total<o.structures;gy+=2)for(let gx=3;gx<W-3&&total<o.structures;gx++){
            // Alternating solid turret runs form staggered choke points;
            // intervening rows of isolated buildings allow local circulation.
            if(gy%8===3?((gx+((gy>>3)&1)*8)%16>=12):(gx&1)===0)continue;
            const bx=Math.floor(gx/12),by=Math.floor(gy/12),district=(bx+by*3)%8;
            // Use sub-district tiles for ownership: reusing the district's
            // bx/by sum correlated profession and owner for four teams.
            const p=np>2?((gx>>2)+(gy>>2))%np:district>=6&&o.layout!=='front'?((gx>>2)+(gy>>2))&1:gy<H/2?0:1;
            const center=gx%12===5&&gy%12===5,home=gy%12===9;
            let key;
            if(district<2)key=center?(district?'astar_spawner':'spawner'):(district?'astar_farm':'farm');
            else if(district===2)key='research';
            else if(district===3)key=home?'healer_spawner':barrackKeys[(bx+by+gx+gy)%barrackKeys.length];
            else if(district===4)key=home?'salvager':towerKeys[(gx+gy)%towerKeys.length];
            else if(district===5)key=home?'builder_spawner':towerKeys[(gx+gy)%towerKeys.length];
            else key=towerKeys[(gx+gy+bx)%towerKeys.length];
            const site=district===5&&!home;
            const e=place(gx,gy,key,p,!site);
            if(!e)continue;
            if(district===4&&!home){e.markedForSalvage=true;st.salvage++;remember(p,'salvager',e);}
            if(site)st.towerSites[p]++;
            if(site)remember(p,'builder',e);
            if(district<2&&!center)remember(p,district?'astar_collector':'collector',e);
            if(key==='research')remember(p,'researcher',e);
            if(e.type==='barrack')remember(p,'healer',e);
            if(e.type==='barrack'||['research','healer_spawner','spawner','astar_spawner','builder_spawner','salvager'].includes(e.type))built[p].push(e);
            total++;k++;st.dense.added++;st.dense.types[key]=(st.dense.types[key]||0)+1;
        }
        if(total<o.structures)st.errors.push('Only '+total+' structures fit; requested '+o.structures);
        st.structures=total;
    }
    // Research: the labs' and researchers' stats raised, the researchers at level 9 by the labs.
    const things = Object.values(RESEARCH_THINGS_BY_ID || {}).filter(t => t && t.stats && t.stats.length);
    for (let p = 0; p < np; p++) {
        const levels = ensurePlayerResearchLevels(p);
        for (const t of things) for (const s of t.stats) {
            if(o.structures)levels[makeResearchLevelId(t.kind,t.key,s.statKey)]=Math.floor(rnd()*(MAX_RESEARCH_LEVEL+1));
            else if(/research/.test(String(t.key))||/research/.test(String(t.kind)))levels[makeResearchLevelId(t.kind,t.key,s.statKey)]=Math.min(MAX_RESEARCH_LEVEL,7);
        }
    }
    rebuildPrecomputedStatsMapPlayer();
    for (let p = 0; p < np; p++) {
        const labs = built[p].filter(b => b.type === 'research'), healerHomes = built[p].filter(b => b.type === 'healer_spawner' || b.type === 'barrack');
        const mine = units.filter(u => !u.dead && u.owner === p);
        mine.filter(u => u.workerType === 'researcher').forEach((u, i) => { if (labs.length) { const s = labs[i % labs.length]; put(u, s.gx + 1, s.gy); s.autoResearchEnabled = true; } });
        mine.filter(u => u.workerType === 'healer').forEach((u, i) => { if (healerHomes.length) { const b = healerHomes[(i * 7) % healerHomes.length]; put(u, b.gx + 1 + (i % 3), b.gy + ((i >> 2) % 3) - 1); st.healersPlaced++; } });
        // Research queue: as many as the labs allow, stats by turns (cheap
        // and dear: every thing and stat over the list).
        for (let i = 0; i < labs.length && i < (o.structures?labs.length:400); i++) {
            const t = things[(i * 13 + p) % things.length], s = t.stats[(i * 5) % t.stats.length], lab = labs[i];
            // Full stats cannot accept another task. Avoid repeating a no-op
            // action/capacity scan at tens of thousands of labs during setup.
            if(getPlayerResearchLevel(p,t.kind,t.key,s.statKey)+getResearchQueuedDepthForPlayer(p,t.kind,t.key,s.statKey)<MAX_RESEARCH_LEVEL)
                processAction(sanitizeAction({ action: 'queueResearch', gx: lab.gx, gy: lab.gy, kind: t.kind, key: t.key, statKey: s.statKey, count: 1 + (i % 4) }), p);
            st.research++;
        }
        // Queues full.
        for (const b of built[p]) {
            if (b.type === 'barrack') { processAction(sanitizeAction({ action: 'queueUnit', gx: b.gx, gy: b.gy, count: 20 }), p); st.queued++; }
            else if (b.type !== 'research') { processAction(sanitizeAction({ action: 'queueWorker', gx: b.gx, gy: b.gy, count: 10 }), p); st.queued++; }
        }
        // 30 rally points over the map (all teams' together), by turns.
        const pts = [];
        for (let r = 0; r < 30; r++) { const t = findNearestWalkable(Math.floor(W * (0.05 + 0.9 * rnd())), Math.floor(H * (0.05 + 0.9 * rnd()))); pts.push([t.x * TILE + 16, t.y * TILE + 16]); }
        const byPt = pts.map(() => []);
        built[p].forEach((b, i) => byPt[(i * 31 + (b.gx >> 3)) % pts.length].push(b.gx, b.gy));
        byPt.forEach((c, j) => { for (let q = 0; q < c.length; q += 2 * ACTION_MAX_RALLY_COORDS) { processAction(sanitizeAction({ action: 'setRallyMany', coords: c.slice(q, q + 2 * ACTION_MAX_RALLY_COORDS), targetX: pts[j][0], targetY: pts[j][1], targetUnitId: null }), p); st.rallies++; } });
        // Builders' work: tower sites under construction around the band;
        // salvagers': built towers marked for salvage.
        const [y0, y1] = band(p);
        const builders = mine.filter(u => u.workerType === 'builder'), salvagers = mine.filter(u => u.workerType === 'salvager');
        for (let i = 0; i < o.towerSites; i++) {
            const gx = 4 + Math.floor(rnd() * (W - 8)), gy = y0 + Math.floor(rnd() * (y1 - y0));
            const e = place(gx, gy, towerKeys[i % towerKeys.length], p, false);
            if (!e) continue;
            st.towerSites[p]++;
            if (builders.length) put(builders[i % builders.length], gx + 1, gy);
        }
        if(o.structures){
            // Spread builders across actual unfinished jobs, rather than leaving
            // most of them at the starting base waiting on distant assignments.
            const sites=towers.filter(t=>t.owner===p&&t.underConstruction);
            for(let i=0;i<builders.length&&sites.length;i++){const t=sites[i%sites.length];put(builders[i],t.gx+1,t.gy);}
        }
        for (let i = 0; i < salvagers.length; i++) {
            const at = freeNear(Math.floor(salvagers[i].x / TILE), Math.floor(salvagers[i].y / TILE), 5);
            if (!at) continue;
            const e = place(at.gx, at.gy, 'pistol', p);
            if (e) { e.markedForSalvage = true; st.salvage++; }
        }
    }
    // Mixed: the armies in thick lines across the middle third (teams in
    // blocks of 4 rows, facing each other 6 rows apart), a row of towers and
    // a row of traps between every pair; then attack-move across.
    if (battle) {
        const teams = Array.from({length:np},(_,p) => units.filter(u => !u.dead && u.owner === p && !u.workerType && (!o.keepKings || !u.isKing)));
        // (mega: 15% of each army as raiding blocks in front of its own
        // buildings, attack-moving into the enemy's building band at points
        // spread across the map; the lines take the rest.)
        if (o.mode === 'mega') {
            st.raid = zeros();
            for (let p = 0; p < np; p++) {
                const n = Math.floor(teams[p].length * 0.15), raid = teams[p].splice(0, n);
                const [by0, by1] = band(p), gy = p === 0 ? by1 + 1 : by0 - 31, groups = Math.max(1, Math.ceil(n / 900));
                for (let g = 0; g < groups; g++) {
                    const gx = 6 + Math.floor((W - 40) * (g + 0.5) / groups), ids = [];
                    for (let k = 0; k < 900; k++) { const u = raid[g * 900 + k]; if (!u) break; put(u, gx + (k % 30), gy + Math.floor(k / 30)); ids.push(u.id); }
                    const [ey0, ey1] = band((p + 1) % np), tx = 6 + Math.floor((W - 12) * (((g * 7) % groups) + 0.5) / groups);
                    for (let q = 0; q < ids.length; q += 5000) processAction(sanitizeAction({ action: 'attackMove', unitIds: ids.slice(q, q + 5000), targetX: tx * TILE, targetY: Math.floor((ey0 + ey1) / 2) * TILE }), p);
                    st.raid[p] += ids.length;
                }
            }
        }
        const y0 = Math.floor(H / 3) + 2, y1 = Math.floor(2 * H / 3) - 2, next = zeros();
        let y = y0, pair = 0;
        while (y + np * 10 - 4 < y1 && teams.some((a,p)=>next[p]<a.length)) {
            for (let p = 0; p < np; p++) {
                const ys = y + p * 10;
                for (let r = 0; r < 4; r++) for (let gx = 6; gx < W - 6; gx++) { const u = teams[p][next[p]]; if (!u) break; if (grid[ys + r][gx].type === TYPE_WALL) continue; next[p]++; put(u, gx, ys + r); }
            }
            // Between the blocks: towers of both teams, then traps.
            for (let gx = 6 + (pair & 1); gx < W - 6; gx += 4) { if (place(gx, y + 5, towerKeys[(gx >> 2) % towerKeys.length], gx & 4 ? 1 : 0)) st.armyTowers++; }
            for (let gx = 7; gx < W - 6; gx += 3) { if (place(gx, y + 7, trapKeys[(gx / 3 | 0) % trapKeys.length], (gx / 3 | 0) & 1)) st.traps++; }
            y += np * 10 - 2; pair++;
        }
        for (let p = 0; p < np; p++) {
            if(o.structures){
                // The original line fixture has room for only ~130k fighters.
                // Give the remainder real orders and spread it through the
                // maze instead of silently leaving most of a million at base.
                for(let i=next[p];i<teams[p].length;i++){
                    put(teams[p][i],6+(i*37)%(W-12),y0+((i/(W-12)|0)*7+p*3)%(y1-y0));
                }
                next[p]=teams[p].length;
            }
            st.army[p] = next[p];
            const ids = teams[p].slice(0, next[p]).map(u => u.id);
            for (let k = 0; k < ids.length; k += 5000) processAction(sanitizeAction({ action: 'attackMove', unitIds: ids.slice(k, k + 5000), targetX: (W / 2) * TILE, targetY: (p ? 0.36 : 0.64) * H * TILE }), p);
        }
        if (typeof recalculateLaserConnections === 'function') recalculateLaserConnections();
    }
    recalculateAdjacency(true);
    if(o.structures){
        st.jobs={};st.jobsByTeam=jobs.map(j=>Object.fromEntries(Object.entries(j).map(([role,list])=>[role,list.length])));
        const assigned=Array.from({length:np},()=>({}));
        for(const u of units){
            if(u.dead||!u.workerType)continue;
            const list=jobs[u.owner]?.[u.workerType];if(!list?.length)continue;
            const j=assigned[u.owner][u.workerType]||0;assigned[u.owner][u.workerType]=j+1;
            const t=list[j%list.length];put(u,t.gx+1,t.gy);
            // Establish real reservations through the normal setter. Oversupply
            // stays unassigned and exercises the normal no-work fallback.
            if(j>=list.length)continue;
            const type=u.workerType==='researcher'?'research':u.workerType==='healer'?'queue':u.workerType==='collector'?'farm':u.workerType==='astar_collector'?'astar_farm':null;
            if(u.workerType==='healer')u._healerPinnedQueueTarget=t;
            if(_setWorkerTarget(u,t,type)){
                u.path=null;u.pathIndex=0;u.commandState=CMD_IDLE;
                u.workerState=u.workerType==='researcher'?'MOVING_TO_RESEARCH':u.workerType==='healer'?'MOVING_TO_HEAL':u.workerType==='builder'?'MOVING_TO_BUILD':'MOVING_TO';
            }
        }
        for(let p=0;p<np;p++)for(const [role,list]of Object.entries(jobs[p]))st.jobs[role]=(st.jobs[role]||0)+list.length;
    }
    if(fronts.length){
        __scratch.chaosFrontArmy=new Set();
        __scratch.chaosFrontBuildings=fronts;
        const orders=new Map();
        const byOwner=Array.from({length:np},(_,p)=>fronts.filter(f=>f.b.owner===p)),armyCount=zeros(),healerCount=zeros();
        for(const f of fronts){
            f.b.rallyX=f.b.x;f.b.rallyY=f.targetY*TILE+16;f.b.rallyTargetUnitId=null;
        }
        for(const u of units){
            if(u.dead)continue;const p=u.owner;
            if(u.workerType==='healer'){
                const i=healerCount[p]++,f=byOwner[p][i%byOwner[p].length];
                // One healer per barrack, extras continue ordinary nearby work.
                if(i<byOwner[p].length){put(u,f.b.gx+1,f.homeY);u._healerPinnedQueueTarget=f.b;_clearWorkerTarget(u);_setWorkerTarget(u,f.b,'queue');u.workerState='MOVING_TO_HEAL';u.path=null;}
            }else if(!u.workerType&&!u.isKing){
                const i=armyCount[p]++,f=byOwner[p][i%byOwner[p].length];
                const fighting=i<Math.max(500,byOwner[p].length/4);
                if(fighting){put(u,f.b.gx,f.b.gy+(p?-3:3));__scratch.chaosFrontArmy.add(u.id);}
                else{
                    const [lo,hi]=band(p);put(u,6+(i*37)%(W-12),lo+(i/(W-12)|0)%(hi-lo));
                }
                // The reserve population travels between flanks through the
                // dense job/maze districts; the frontline is replenished by
                // ordinary paid queues, not out-of-band unit injections.
                const action=fighting?'attackMove':'move',x=fighting?f.b.gx:(i&1?W-12:12),y=fighting?f.targetY:Math.floor(u.y/TILE),key=p+':'+action+':'+x+':'+y;
                let a=orders.get(key);if(!a)orders.set(key,a={p,action,unitIds:[],targetX:x*TILE,targetY:y*TILE});a.unitIds.push(u.id);
            }
        }
        for(const a of orders.values())for(let i=0;i<a.unitIds.length;i+=5000)processAction(sanitizeAction({...a,unitIds:a.unitIds.slice(i,i+5000)}),a.p);
        st.frontFighters=__scratch.chaosFrontArmy.size;
    }
    st.units = units.length; st.barracks = barracks.length; st.spawners = collectorSpawners.length; st.towers = towers.length;
    st.researchQueued = Array.from({length:np},(_,p) => getPlayerResearchQueueTotalLength(p));
    // (The upgraded areas, for the bursts' further upgrades: the same on
    // every peer.)
    if (st.upgradeAreas) __scratch.chaosUpgradeAreas = st.upgradeAreas;
    return st;
}

// One burst of the local player's commands (k: the burst's number).
function chaosBurst(o, k) {
    let seed = 4242 + ((o.seed || 777) - 777) + k * 7919 + localPlayerId * 104729;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    const me = localPlayerId, W = GRID_W, H = GRID_H, out = { queue: 0, rally: 0, research: 0, place: 0, orders: 0 };
    const mineB = [...barracks, ...collectorSpawners].filter(b => b.owner === me && b.energy > 0 && !b.underConstruction);
    // Queues topped up: 150 buildings a burst, by turns over all of them.
    for (let i = 0; i < 150 && mineB.length; i++) {
        const b = mineB[(k * 150 + i) % mineB.length];
        if (b instanceof Barrack) { if (b.spawnQueue.length < 20) { queueAction({ action: 'queueUnit', gx: b.gx, gy: b.gy, count: 20 - b.spawnQueue.length }); out.queue++; } }
        else if (b.type !== 'research') { if (b.spawnQueue && b.spawnQueue.length < 10) { queueAction({ action: 'queueWorker', gx: b.gx, gy: b.gy, count: 10 - b.spawnQueue.length }); out.queue++; } }
    }
    // Every 3rd burst: the rally points moved (30 points, all buildings).
    if (k % 3 === 0 && o.layout!=='front') {
        const pts = [];
        for (let r = 0; r < 30; r++) { const t = findNearestWalkable(Math.floor(W * (0.05 + 0.9 * rnd())), Math.floor(H * (0.05 + 0.9 * rnd()))); pts.push([t.x * TILE + 16, t.y * TILE + 16]); }
        const byPt = pts.map(() => []);
        mineB.forEach((b, i) => byPt[(i + k) % pts.length].push(b.gx, b.gy));
        byPt.forEach((c, j) => { for (let q = 0; q < c.length; q += 2 * ACTION_MAX_RALLY_COORDS) { queueAction({ action: 'setRallyMany', coords: c.slice(q, q + 2 * ACTION_MAX_RALLY_COORDS), targetX: pts[j][0], targetY: pts[j][1], targetUnitId: null }); out.rally++; } });
    }
    if(o.layout==='front'){
        const line=(__scratch.chaosFrontBuildings||[]).filter(f=>f.b.owner===me&&f.b.energy>0);
        for(let i=0;i<150&&i<line.length;i++){
            const f=line[(k*150+i)%line.length],b=f.b;
            queueAction({action:'setRally',gx:b.gx,gy:b.gy,targetX:b.x+((k&1)?8:-8)*TILE,targetY:f.targetY*TILE+16,targetUnitId:null});out.rally++;
            if(b.spawnQueue.length<20){queueAction({action:'queueUnit',gx:b.gx,gy:b.gy,count:20-b.spawnQueue.length});out.queue++;}
        }
    }
    // Research: 20 stats queued at labs (cheap and dear, by turns).
    const things = Object.values(RESEARCH_THINGS_BY_ID || {}).filter(t => t && t.stats && t.stats.length);
    const labs = mineB.filter(b => b.type === 'research');
    for (let i = 0; i < 20 && labs.length && things.length; i++) {
        const t = things[Math.floor(rnd() * things.length)], s = t.stats[Math.floor(rnd() * t.stats.length)], lab = labs[i % labs.length];
        queueAction({ action: 'queueResearch', gx: lab.gx, gy: lab.gy, kind: t.kind, key: t.key, statKey: s.statKey, count: 1 + (i % 3) });
        out.research++;
    }
    // New buildings for the builders: 20 towers near the player's buildings.
    const towerKeys = BUILD_CATEGORIES.towers.filter(x => x !== 'watch_tower');
    for (let i = 0; i < 20 && mineB.length; i++) {
        const b = mineB[Math.floor(rnd() * mineB.length)], gx = b.gx + Math.floor(rnd() * 7) - 3, gy = b.gy + Math.floor(rnd() * 7) - 3;
        if (gx < 2 || gy < 2 || gx >= W - 2 || gy >= H - 2 || grid[gy][gx].type !== TYPE_FLOOR || grid[gy][gx].item || getTileEntityRef(gx, gy)) continue;
        queueAction({ action: 'place', gx, gy, itemType: towerKeys[(k + i) % towerKeys.length], count: 1 }); out.place++;
    }
    // Mixed and mega: the army ordered by turns (attack-move across, then
    // move to a point, then attack-move back), a quarter of it each burst;
    // mega's every fourth burst sends that quarter raiding the enemy's
    // buildings instead.
    if (o.mode === 'mixed' || o.mode === 'mega') {
        const army = units.filter(u => !u.dead && u.owner === me && !u.workerType && (!o.keepKings || !u.isKing) && u.commandState !== undefined && (o.layout!=='front'||__scratch.chaosFrontArmy.has(u.id)));
        const q = k & 3, part = army.filter((u, i) => (i & 3) === q).map(u => u.id);
        const raid = o.mode === 'mega' && (k & 3) === 2;
        const tx = W * (0.1 + 0.8 * rnd()) * TILE, ty = raid ? H * (me ? 1 / 6 : 5 / 6) * TILE : H * (me ? 0.36 : 0.64) * TILE;
        if (part.length) { queueAction({ action: (k & 1) && !raid ? 'move' : 'attackMove', unitIds: part, targetX: tx, targetY: ty }); out.orders++; }
    }
    // mega: every other kind of command, a little of each a burst.
    if (o.mode === 'mega') {
        Object.assign(out, { towerTarget: 0, boost: 0, unitCmds: 0, kill: 0, toggles: 0, research: out.research });
        const foeUnits = units.filter((u, i) => (i & 63) === (k & 63) && !u.dead && u.owner !== me);
        const foeB = [...towers, ...barracks].filter((b, i) => (i & 15) === (k & 15) && b.owner !== me && b.energy > 0);
        // Towers' targets (an enemy unit, an enemy building, none, by turns).
        const myTowers = towers.filter(t => t.owner === me && t.energy > 0 && !t.underConstruction);
        if (myTowers.length) {
            const off = (k * 1013) % myTowers.length, coords = [];
            for (let i = 0; i < Math.min(2000, myTowers.length); i++) { const t = myTowers[(off + i) % myTowers.length]; coords.push({ gx: t.gx, gy: t.gy }); }
            const pick = k % 3;
            let target = null;
            if (pick === 0 && foeUnits.length) target = { type: 'unit', id: foeUnits[Math.floor(rnd() * foeUnits.length)].id };
            else if (pick === 1 && foeB.length) { const b = foeB[Math.floor(rnd() * foeB.length)]; target = { type: b instanceof Tower ? 'tower' : 'barrack', gx: b.gx, gy: b.gy }; }
            queueAction({ action: 'towerTarget', towerCoords: coords, target }); out.towerTarget++;
        }
        // A boost changed.
        const bkeys = [['unit', 'norm'], ['unit', 'fast'], ['unit', 'mole'], ['unit', 'collector'], ['building', 'barrack_tank'], ['building', 'sniper'], ['building', 'research']];
        { const [kind, key] = bkeys[k % bkeys.length]; queueAction({ action: 'setBoost', kind, key, res: k % 4 === 3 && kind === 'unit' ? 'astar' : 'energy', steps: k % 5 }); out.boost++; }
        // Small groups: hold, stop, attack a unit, attack a building, killed.
        const army = units.filter((u, i) => (i & 31) === (k & 31) && !u.dead && u.owner === me && !u.workerType && !u.isKing);
        const slice = (j, n) => army.slice(j * n, (j + 1) * n).map(u => u.id);
        if (army.length > 100) {
            queueAction({ action: 'hold', unitIds: slice(0, 200) }); queueAction({ action: 'stop', unitIds: slice(1, 200) });
            if (foeUnits.length) { const f = foeUnits[Math.floor(rnd() * foeUnits.length)]; queueAction({ action: 'attack', unitIds: slice(2, 300), targetId: f.id, targetX: f.x, targetY: f.y }); }
            if (foeB.length) { const b = foeB[Math.floor(rnd() * foeB.length)]; queueAction({ action: 'attackBuilding', unitIds: slice(3, 300), targetGx: b.gx, targetGy: b.gy }); }
            queueAction({ action: 'killUnit', unitIds: slice(4, 40) }); out.kill += 40; out.unitCmds += 4;
        }
        // Buildings' switches: salvage marks, auto-upgrade and stacking,
        // production on and off, queues shortened.
        const mineB = [...barracks, ...collectorSpawners, ...towers].filter((b, i) => (i % 97) === (k % 97) && b.owner === me);
        for (let i = 0; i < mineB.length && i < 40; i++) {
            const b = mineB[i], on = ((k >> 1) + i) & 1;
            if (i % 5 === 0) queueAction({ action: 'markSalvage', gx: b.gx, gy: b.gy });
            else if (i % 5 === 1) queueAction({ action: 'setAutoUpgrade', gx: b.gx, gy: b.gy, enabled: !!on });
            else if (i % 5 === 2) queueAction({ action: 'setAutoStack', gx: b.gx, gy: b.gy, enabled: !!on });
            else if (i % 5 === 3 && b.spawnQueue) queueAction({ action: 'setQueueEnabled', gx: b.gx, gy: b.gy, enabled: !!on });
            else if (b instanceof Barrack) queueAction({ action: 'dequeueUnit', gx: b.gx, gy: b.gy, count: 2 });
            out.toggles++;
        }
        // An upgraded area one level more (an upgrader's place order).
        const ua = ((__scratch.chaosUpgradeAreas || [])[me]) || [];
        if (ua.length) { const j = (k % (ua.length / 2)) * 2; queueAction({ action: 'place', gx: ua[j], gy: ua[j + 1], itemType: 'area_upgrader', count: 1 }); out.areaUp = 1; }
        // The research queue reordered and shortened.
        const lab = collectorSpawners.find(s => s.owner === me && s.type === 'research' && s.energy > 0);
        if (lab) {
            queueAction({ action: 'moveResearch', gx: lab.gx, gy: lab.gy, from: 1 + (k % 50), to: 1 });
            queueAction({ action: 'dequeueResearch', gx: lab.gx, gy: lab.gy, count: 3 });
            out.research += 2;
        }
    }
    return out;
}

// All clients receive the same contested tiles/mines, but act as their own
// player. The multiplayer driver seals these alongside the ordinary chaos
// burst at one shared tick, including competing commands from teammates.
function chaosConflicts(o, k, shared) {
    const me = localPlayerId, variant = o.clientVariant || 0, out = [], add = a => out.push(a);
    const owned = [...towers, ...barracks, ...collectorSpawners, ...getCellItemsRowMajor()]
        .filter(b => b && b.owner === me && b.energy > 0);
    const workers = units.filter(u => !u.dead && u.owner === me && u.workerType);
    const army = units.filter(u => !u.dead && u.owner === me && !u.workerType && !u.isKing);
    const point = shared.tiles[0] || { gx: GRID_W >> 1, gy: GRID_H >> 1 };
    const rank = u => Math.abs(u.x / TILE - point.gx) + Math.abs(u.y / TILE - point.gy);
    army.sort((a, b) => rank(a) - rank(b) || a.id - b.id);
    const ids = army.slice(0, 400).map(u => u.id);
    const destination = { targetX: (point.gx + .5) * TILE, targetY: (point.gy + .5) * TILE };
    if (ids.length) {
        add({ action: 'attackMove', unitIds: ids, ...destination });
        add({ action: 'resizeUnitGroup', unitIds: ids.slice(0, 12), mode: k & 1 ? 'd2' : 'm2' });
        // Small groups guarantee coverage even after the armies have thinned;
        // the ordinary burst's sampled groups may no longer have 100 units.
        add({ action: 'move', unitIds: ids.slice(0, 8), ...destination });
        add({ action: 'hold', unitIds: ids.slice(8, 16) });
        add({ action: 'stop', unitIds: ids.slice(16, 24) });
        const enemy=units.find(u=>!u.dead&&u.owner!==me&&!u.isKing);
        if(enemy)add({action:'attack',unitIds:ids.slice(24,32),targetId:enemy.id,targetX:enemy.x,targetY:enemy.y});
        const building=[...towers,...barracks].find(b=>b.owner!==me&&b.energy>0);
        if(building)add({action:'attackBuilding',unitIds:ids.slice(32,40),targetGx:building.gx,targetGy:building.gy});
        add({action:'killUnit',unitIds:ids.slice(-1)});
    }
    add({action:'shrineDrain',drain:(k+variant)&3});
    const production = owned.filter(b => b instanceof Barrack || isSpawnerEntity(b));
    const workerHome=production.find(b=>!(b instanceof Barrack)&&b.type!=='research');
    if(workerHome){
        add({action:'queueWorker',gx:workerHome.gx,gy:workerHome.gy,count:2});
        add({action:'dequeueWorker',gx:workerHome.gx,gy:workerHome.gy,count:1});
    }
    for (const b of production.slice(k % 7, k % 7 + 16)) {
        add({ action: 'setRally', gx: b.gx, gy: b.gy, ...destination, targetX: destination.targetX + (o.clientVariant === undefined ? 0 : variant - 1) * TILE });
        add({ action: b instanceof Barrack ? 'queueUnit' : 'queueWorker', gx: b.gx, gy: b.gy, count: 2 });
        add({ action: 'setQueueEnabled', gx: b.gx, gy: b.gy, enabled: true });
        add({ action: b instanceof Barrack ? 'dequeueUnit' : 'dequeueWorker', gx: b.gx, gy: b.gy, count: 1 });
        add({ action: 'setBuildEnabled', gx: b.gx, gy: b.gy, enabled: !!((k+variant)&1) });
        add({ action: 'setAutoUpgrade', gx: b.gx, gy: b.gy, enabled: !!(k&1) });
        add({ action: 'setAutoStack', gx: b.gx, gy: b.gy, enabled: !!(k&1) });
    }
    const keys = Object.keys(BASE_CARD_TYPES).filter(key => !BASE_CARD_TYPES[key].notBuildable);
    for (let j = 0; j < shared.tiles.length; j++) {
        const t = shared.tiles[j], key = j < 3 ? ['pistol', 'sand', 'barrack_fast'][(j + me + k + variant) % 3] : keys[(k * 7 + j + variant) % keys.length];
        add({ action: 'place', gx: t.gx, gy: t.gy, itemType: key, count: 1 + (j & 1), buildEnabled: true, autoUpgradeEnabled: !!(k & 1) });
    }
    const assign = (role, target, type) => {
        if (!target) return;
        const list = workers.filter(u => u.workerType === role).sort((a, b) => rank(a) - rank(b) || a.id - b.id);
        if (list.length) add({ action: 'workerAssign', unitIds: list.slice(0, 16).map(u => u.id), targetType: type, targetGx: target.gx, targetGy: target.gy });
    };
    assign('collector', shared.gold, 'mine');
    assign('astar_collector', shared.astar, 'astar_mine');
    const sites = owned.filter(b => b.underConstruction || b.isUpgrading || b.isStacking);
    assign('builder', sites[variant % Math.max(1, sites.length)], 'build');
    assign('healer', production.find(b => !b.underConstruction), 'queue');
    assign('researcher', production.find(b => b.type === 'research'), 'research');
    // Removing active workplaces tests reservations, worker return trips,
    // route invalidation and collision footprints while other clients build.
    const salvage = owned.filter(b => b instanceof Tower && !b.type.startsWith('cloud'));
    for (const b of salvage.slice(k * 3 % Math.max(1, salvage.length), k * 3 % Math.max(1, salvage.length) + 12))
        add({ action: 'setSalvage', gx: b.gx, gy: b.gy, marked: true });
    const lab = production.find(b => b.type === 'research');
    if (lab) {
        add({ action: 'queueResearch', gx: lab.gx, gy: lab.gy, kind: 'building', key: 'pistol', statKey: 'maxLevel', count: 2 });
        add({ action: 'reorderResearch', gx: lab.gx, gy: lab.gy, fromIndex: 1, toIndex: 0, fromActive: false, toActive: !!(k&1) });
        add({ action: 'setAutoResearch', gx: lab.gx, gy: lab.gy, enabled: true });
    }
    return out;
}

module.exports = {
    setup: o => `(${chaosSetup.toString()})(${JSON.stringify(o)})`,
    burst: (o, k) => `(${chaosBurst.toString()})(${JSON.stringify(o)}, ${k})`,
    conflicts: (o, k, shared) => `(${chaosConflicts.toString()})(${JSON.stringify(o)}, ${k}, ${JSON.stringify(shared)})`,
};
