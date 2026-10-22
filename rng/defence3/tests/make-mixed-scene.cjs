// A synthetic mid-game scene of any size, in the portable scene format (the
// menu's Load and the benches' SCENE= read it): a checkerboard of cells over
// a real map (the terrain, areas and mines of a base scene), each cell one
// team's yard of mixed units packed side by side and a strip of its own
// structures (towers, barracks with rally points all over the map, spawners,
// houses), neighbours of other teams everywhere, so there are fronts all over.
// Teams differ in level and research (a corner case each: low, mid, max).
//
//   node --max-old-space-size=12000 tests/make-mixed-scene.cjs --units=4000000 --teams=4 \
//     --levels=low,mid,max,max --research=none,half,max,max --out=tests/mixed-4m.gz
//
//   --units=N        target number of units (as many as the map holds, if fewer)
//   --teams=T        2..8 teams (cell colours: (cx + cy) % T, a checkerboard for 2)
//   --levels=a,b,..  per team: low (1-3), mid (7-10), max (20), mixed (1-20), keep (the base's mix)
//   --research=a,b   per team: none, half (5), max (10)
//   --workers=F      share of workers among the units (default 0.2)
//   --small          only small types (radius <= 8) and no big ones: the densest packing
//   --structs=S      structures a cell (default 6 of its 8 top-row tiles)
//   --rally-points=P distinct rally points across the map (default 256; every barracks and spawner has one)
//   --orders=F       share of units with an attack-move order to one of --order-points (default 0.15 / 32)
//   --base=file.gz   the base scene (default tests/200k-attack-low-tps.gz)
//   --spread=center|hash  a patch round the middle (default) or cells all over the map
//   --seed=N
'use strict';
const fs = require('node:fs'), path = require('node:path'), zlib = require('node:zlib');
const arg = (name, fallback) => { const a = process.argv.find(x => x.startsWith('--' + name + '=')); return a ? a.slice(name.length + 3) : fallback; };
const flag = name => process.argv.includes('--' + name);
const UNITS = Number(arg('units', 200000)), TEAMS = Math.max(2, Math.min(8, Number(arg('teams', 2))));
const LEVELS = arg('levels', 'mixed').split(','), RESEARCH = arg('research', 'none').split(',');
const WORKERS = Number(arg('workers', 0.2)), SMALL = flag('small'), STRUCTS = Number(arg('structs', 6));
const RALLY_POINTS = Number(arg('rally-points', 256)), ORDERS = Number(arg('orders', 0.15)), ORDER_POINTS = Number(arg('order-points', 32));
const BASE = arg('base', path.join(__dirname, '200k-attack-low-tps.gz')), OUT = arg('out', path.join(__dirname, 'mixed-scene.gz'));
const SEED = Number(arg('seed', 1)), CELL = Number(arg('cell', 8)), GAP = Number(arg('gap', 1));
const TILE = 32;
const forTeam = (list, t) => list[Math.min(t, list.length - 1)].trim();

// Deterministic hash -> [0, 1).
function hash(a, b = 0, c = 0, d = 0) {
    let h = (SEED * 0x9e3779b1) ^ (a * 0x85ebca6b) ^ (b * 0xc2b2ae35) ^ (c * 0x27d4eb2f) ^ (d * 0x165667b1);
    h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d); h = Math.imul(h ^ (h >>> 12), 0x297a2d39); h ^= h >>> 15;
    return (h >>> 0) / 4294967296;
}
const pick = (list, r) => list[Math.min(list.length - 1, Math.floor(r * list.length))];

// Unit types: [type, radius, share]. (Radii from BASE_UNIT_STATS.)
const COMBAT = [['norm', 8, 20], ['fast', 6, 10], ['flying', 7, 8], ['mole', 7.5, 8], ['snake', 7, 7], ['scout', 5.5, 2], ['water_resistant', 8, 5],
    ['tank', 10, 8], ['boss', 12, 6], ['poison_resistant', 9, 5], ['fire_resistant', 10, 5], ['ice_resistant', 9, 5], ['laser_resistant', 9, 6]];
const SMALL_COMBAT = [['norm', 8, 22], ['fast', 6, 14], ['flying', 7, 12], ['mole', 7.5, 12], ['snake', 7, 10], ['scout', 5.5, 6], ['water_resistant', 8, 10]];
const WORK = [['collector', 6, 6], ['astar_collector', 6, 3], ['builder_unit', 6, 5], ['healer_unit', 6, 5], ['researcher_unit', 6, 3], ['salvager_unit', 6, 3]];
const combat = SMALL ? SMALL_COMBAT : COMBAT;
function chooseType(r) {
    const worker = r < WORKERS, list = worker ? WORK : combat;
    const total = list.reduce((s, x) => s + x[2], 0), q = (worker ? r / Math.max(1e-9, WORKERS) : (r - WORKERS) / Math.max(1e-9, 1 - WORKERS)) * total;
    let acc = 0;
    for (const x of list) { acc += x[2]; if (q < acc) return x; }
    return list[list.length - 1];
}
const TOWERS = ['pistol', 'smg', 'sniper', 'elements', 'laser', 'water', 'poison', 'sand_gun', 'ice', 'fire', 'watch_tower'];
const BARRACKS = combat.map(x => 'barrack_' + x[0]);
const SPAWNERS = ['spawner', 'astar_spawner', 'research', 'builder_spawner', 'healer_spawner', 'salvager'];

function levelOf(profile, r) {
    switch (profile) {
        case 'low': return 1 + Math.floor(r * 3);
        case 'mid': return 7 + Math.floor(r * 4);
        case 'max': return 20;
        case 'mixed': return 1 + Math.floor(r * 20);
        default: return null;
    }
}

(async () => {
    console.error('reading', BASE);
    const records = JSON.parse(zlib.gunzipSync(fs.readFileSync(BASE)));
    const header = records[0];
    const W = header.width, H = header.height;
    const terrain = records.filter(r => r.terrain), areas = records.filter(r => r.areas), mines = records.filter(r => r.mines);
    // Floor tiles (type 0), minus the mines'.
    const floor = new Uint8Array(W * H);
    let y = 0;
    for (const rec of terrain) for (const runs of rec.terrain) {
        let x = 0;
        for (let i = 0; i < runs.length; i += 4) { if (runs[i] === 0) floor.fill(1, y * W + x, y * W + x + runs[i + 3]); x += runs[i + 3]; }
        y++;
    }
    for (const rec of mines) for (const m of rec.mines) floor[m[2] * W + m[1]] = 0;
    // The game's research stats, for the research profiles.
    let researchKeys = [];
    if (RESEARCH.some(r => r !== 'none')) {
        const H2 = require('./net-harness.cjs');
        const world = new H2.World(), inst = world.spawn('keys', { simWorker: false });
        inst.eval('rebuildResearchThings()');
        researchKeys = JSON.parse(inst.eval('JSON.stringify(RESEARCH_THINGS.flatMap(t => (t.stats || []).map(s => t.kind + ":" + t.key + ":" + s.statKey)))'));
        console.error('research stats', researchKeys.length);
    }
    // Random floor tiles for rally and order points.
    const floorTiles = [];
    for (let i = 0; i < 4096; i++) {
        for (let k = 0; k < 40; k++) {
            const gx = Math.floor(hash(i, k, 7) * W), gy = Math.floor(hash(i, k, 8) * H);
            if (floor[gy * W + gx]) { floorTiles.push([gx, gy]); break; }
        }
    }
    const rallyPts = floorTiles.slice(0, Math.max(1, RALLY_POINTS)), orderPts = floorTiles.slice(2048, 2048 + Math.max(1, ORDER_POINTS));
    // ---- the cells ----
    const cols = Math.floor((W - 2) / CELL), rows = Math.floor((H - 2) / CELL);
    const cellUnits = []; // per cell: [cx, cy, team]
    // Each cell's yard capacity (px): its tiles minus the structure strip's.
    const cellW = CELL * TILE;
    const struct = [], units = [];
    const wantPerCell = Math.ceil(UNITS / (cols * rows));
    let total = 0;
    const order = [];
    for (let cy = 0; cy < rows; cy++) for (let cx = 0; cx < cols; cx++) order.push([cx, cy]);
    // A partial fill is one patch round the middle (fronts all through it), or spread over the map (--spread=hash).
    if (arg('spread', 'center') === 'hash') order.sort((a, b) => hash(a[0], a[1], 99) - hash(b[0], b[1], 99));
    else order.sort((a, b) => Math.hypot(a[0] - cols / 2, a[1] - rows / 2) - Math.hypot(b[0] - cols / 2, b[1] - rows / 2) || hash(a[0], a[1], 99) - hash(b[0], b[1], 99));
    const stats = { cells: 0, units: 0, structures: 0, byTeam: new Array(TEAMS).fill(0), levels: {} };
    for (const [cx, cy] of order) {
        if (total >= UNITS) break;
        const team = (cx + cy) % TEAMS, x0 = 1 + cx * CELL, y0 = 1 + cy * CELL;
        const profile = forTeam(LEVELS, team);
        // Structure strip: the first row's first STRUCTS tiles (floor ones).
        let used = 0;
        for (let s = 0; s < STRUCTS && s < CELL; s++) {
            const gx = x0 + s, gy = y0;
            if (!floor[gy * W + gx]) continue;
            const r = hash(cx, cy, s, 1), lv = levelOf(profile, hash(cx, cy, s, 2));
            // 2 towers, 2 barracks, a spawner, a house: in the strip's order.
            const kind = s % 6;
            const type = kind < 2 ? pick(TOWERS, r) : kind < 4 ? pick(BARRACKS, r) : kind === 4 ? pick(SPAWNERS, r) : 'house';
            const level = lv == null ? 4 : lv;
            const rally = kind >= 2 && kind <= 4 ? rallyPts[Math.floor(hash(cx, cy, s, 3) * rallyPts.length)] : null;
            struct.push([type, team, gx, gy, 2 ** (level - 1), 1e12, false, rally ? rally[0] + .5 : null, rally ? rally[1] + .5 : null, true, true]);
            floor[gy * W + gx] = 0;
            used++; stats.structures++;
        }
        // The yard: units packed left to right, row by row, in the cell's pixels.
        const px0 = x0 * TILE, py0 = y0 * TILE;
        let cursorX = 0, cursorY = 0, rowH = 0, placed = 0, k = 0;
        const limitY = CELL * TILE;
        // (The strip's row is units' too beside the structures: start under it.)
        cursorY = TILE;
        for (;;) {
            if (total >= UNITS) break;
            const [type, r] = chooseType(hash(cx, cy, k, 5));
            const d = Math.ceil(2 * r * GAP);
            if (cursorX + d > cellW) { cursorX = 0; cursorY += rowH; rowH = 0; }
            if (cursorY + d > limitY) break;
            const ux = px0 + cursorX + d / 2, uy = py0 + cursorY + d / 2;
            cursorX += d; rowH = Math.max(rowH, d); k++;
            const gx = Math.floor(ux / TILE), gy = Math.floor(uy / TILE);
            if (!floor[gy * W + gx]) continue;
            const lv = levelOf(profile, hash(cx, cy, k, 6));
            let order = null;
            if (ORDERS > 0 && hash(cx, cy, k, 7) < ORDERS) { const p = orderPts[Math.floor(hash(cx, cy, k, 8) * orderPts.length)]; order = ['attackMove', p[0], p[1]]; }
            units.push([type, team, ux / TILE, uy / TILE, 1e9, lv == null ? 1 + Math.floor(hash(cx, cy, k, 9) * 6) : lv, 1, order, false]);
            total++; placed++; stats.byTeam[team]++;
            if (lv != null) stats.levels[team + ':' + lv] = (stats.levels[team + ':' + lv] || 0) + 1;
        }
        stats.cells++; stats.units += placed;
    }
    // ---- the header ----
    const players = header.players.map((p, i) => {
        const t = i < TEAMS ? RESEARCH[Math.min(i, RESEARCH.length - 1)].trim() : 'none';
        const researchLevels = {};
        if (t !== 'none') for (const key of researchKeys) researchLevels[key] = t === 'half' ? 5 : 10;
        return { energy: 1.2e14, astar: 1.2e13, researchLevels, researchOrders: [] };
    });
    const settings = JSON.parse(JSON.stringify(header.settings));
    settings.lobby.numbers['cfg-max-pop'] = Math.ceil(UNITS / TEAMS * 1.05) + 1000;
    const out = { ...header, settings, teams: Array.from({ length: TEAMS }, (_, i) => i), player: 0, sourceTick: 0, players,
        camera: { x: W / 2, y: H / 2, zoom: 0.08 } };
    // ---- write ----
    const gz = zlib.createGzip({ level: 6 }), file = fs.createWriteStream(OUT);
    gz.pipe(file);
    const write = text => new Promise(res => { if (gz.write(text)) res(); else gz.once('drain', res); });
    const counts = { terrain: 0, areas: 0, mines: 0, buildings: 0, units: 0 };
    let first = true;
    const emit = async record => { await write((first ? '[\n' : ',\n') + JSON.stringify(record)); first = false; };
    await emit(out);
    for (const rec of terrain) { await emit(rec); counts.terrain += rec.terrain.length; }
    for (const rec of areas) { await emit(rec); counts.areas += rec.areas.length; }
    for (const rec of mines) { await emit(rec); counts.mines += rec.mines.length; }
    for (let i = 0; i < struct.length; i += 1024) { const rows2 = struct.slice(i, i + 1024); await emit({ buildings: rows2 }); counts.buildings += rows2.length; }
    for (let i = 0; i < units.length; i += 1024) { const rows2 = units.slice(i, i + 1024); await emit({ units: rows2 }); counts.units += rows2.length; }
    await emit({ end: counts });
    await write('\n]\n');
    await new Promise(res => { file.on('finish', res); gz.end(); });
    console.error(JSON.stringify({ out: OUT, MB: Math.round(fs.statSync(OUT).size / 1048576), ...counts, cells: stats.cells, byTeam: stats.byTeam, levelSample: Object.entries(stats.levels).slice(0, 12) }));
})().catch(e => { console.error(e); process.exit(1); });
