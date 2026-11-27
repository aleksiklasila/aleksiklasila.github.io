// A scene of lines (the portable scene format, as tests/make-mixed-scene.cjs): team 0's structures in horizontal lines
// across the map every --period rows, team 1's units in the bands between each two lines, so every structure and
// every unit has something in reach at once (all towers firing, all units fighting).
//
//   node --max-old-space-size=12000 tests/make-lines-scene.cjs --kind=towers --structs=131072 --units=131072 --out=tests/scenes/lines-towers.gz
//
//   --kind=towers|lasers|floor|mixed   towers (mixed types), laser towers (links along a line), floor traps (sand,
//                                      water, ice, poison, lava), or a mix of the three, line by line
//   --structs=N    structures (team 0), at most the budget's (131072 a team at a population of 131072)
//   --units=N      units (team 1), spread over the bands
//   --period=P     rows from one line to the next (default: the map's rows / lines)
//   --level=L      the structures' and units' level (default 8)
//   --order=none|cross   cross: every unit attack-moves to the far side of the map (through every line)
//   --team0-units=N      team 0 units too (in the bands' middle row), default 0
//   --base=file.gz       the map (terrain, areas, mines; default tests/200k-attack-low-tps.gz)
//   --unit-energy=E      the units' energy (default 1e9: full, the restore clamps to their maximum; e.g. 5: they die
//                        at the first shots, a wave of deaths)
//   --struct-energy=E    the structures' energy (default 1e12: full; e.g. 5: the lines fall at once)
//   --research=a,b       per team: none (default), half (5), max (10) of every research stat
//   --uc=1               the structures under construction (team 0's builders build them: --team0-type=builder_unit)
//   --team0-type=T       team 0's units' type (default: the mixed combat types), e.g. builder_unit, healer_unit
//   --kind=barracks      barracks lines (every unit type), each with a full queue (20) and a rally point across the map
'use strict';
const fs = require('node:fs'), path = require('node:path'), zlib = require('node:zlib');
const arg = (name, fallback) => { const a = process.argv.find(x => x.startsWith('--' + name + '=')); return a ? a.slice(name.length + 3) : fallback; };
const KIND = arg('kind', 'towers'), STRUCTS = Number(arg('structs', 131072)), UNITS = Number(arg('units', 131072));
const LEVEL = Number(arg('level', 8)), ORDER = arg('order', 'none'), T0U = Number(arg('team0-units', 0));
const UC = arg('uc', '0') === '1', T0TYPE = arg('team0-type', '');
const UE = Number(arg('unit-energy', 1e9)), SE = Number(arg('struct-energy', 1e12)), RESEARCH = arg('research', 'none').split(',');
const BASE = arg('base', path.join(__dirname, '200k-attack-low-tps.gz')), OUT = arg('out', path.join(__dirname, 'scenes', 'lines-' + KIND + '.gz'));
const TOWERS = ['pistol', 'smg', 'sniper', 'elements', 'water', 'poison', 'sand_gun', 'ice', 'fire'];
const TRAPS = ['sand', 'water_puddle', 'ice_patch', 'poison_puddle', 'lava'];
const UNIT_TYPES = ['norm', 'fast', 'tank', 'flying', 'mole', 'snake', 'water_resistant', 'fire_resistant', 'ice_resistant', 'poison_resistant', 'laser_resistant', 'boss'];
function hash(a, b = 0, c = 0) { let h = (a * 0x85ebca6b) ^ (b * 0xc2b2ae35) ^ (c * 0x27d4eb2f) ^ 0x9e3779b1; h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d); h = Math.imul(h ^ (h >>> 12), 0x297a2d39); h ^= h >>> 15; return (h >>> 0) / 4294967296; }

(async () => {
    const records = JSON.parse(zlib.gunzipSync(fs.readFileSync(BASE)));
    const header = records[0], W = header.width, H = header.height;
    const terrain = records.filter(r => r.terrain), areas = records.filter(r => r.areas), mines = records.filter(r => r.mines);
    const floor = new Uint8Array(W * H);
    let y = 0;
    for (const rec of terrain) for (const runs of rec.terrain) {
        let x = 0;
        for (let i = 0; i < runs.length; i += 4) { if (runs[i] === 0) floor.fill(1, y * W + x, y * W + x + runs[i + 3]); x += runs[i + 3]; }
        y++;
    }
    for (const rec of mines) for (const m of rec.mines) floor[m[2] * W + m[1]] = 0;
    // Lines: as many as the structures fill, each a row of floor tiles from x 2 to W - 3.
    const perLine = W - 4, lines = Math.max(1, Math.ceil(STRUCTS / (perLine * 0.9)));
    const period = Number(arg('period', 0)) || Math.max(3, Math.floor((H - 4) / lines));
    const struct = [], units = [];
    const stacks = 2 ** (LEVEL - 1);
    let ns = 0;
    const lineRows = [];
    for (let gy = 2; gy < H - 2 && ns < STRUCTS; gy += period) {
        lineRows.push(gy);
        const li = lineRows.length - 1;
        const kind = KIND === 'mixed' ? ['towers', 'lasers', 'floor'][li % 3] : KIND;
        for (let gx = 2; gx < W - 2 && ns < STRUCTS; gx++) {
            const t = gy * W + gx;
            if (!floor[t]) continue;
            const type = kind === 'lasers' ? 'laser' : kind === 'floor' ? TRAPS[(gx + li) % TRAPS.length] : kind === 'barracks' ? 'barrack_' + UNIT_TYPES[(gx + li) % UNIT_TYPES.length] : TOWERS[Math.floor(hash(gx, gy, 1) * TOWERS.length)];
            // (Barracks: a full queue of their own type, a rally point across the map.)
            const work = kind === 'barracks' ? { spawnQueue: Array.from({ length: 20 }, () => [type.slice(8), LEVEL, 0]) } : null;
            const rx = kind === 'barracks' ? W - 1 - gx + 0.5 : null, ry = kind === 'barracks' ? H - 1 - gy + 0.5 : null;
            struct.push([type, 0, gx, gy, stacks, UC ? 1 : SE, UC, rx, ry, true, true, work]);
            floor[t] = 0; ns++;
        }
    }
    // (Team 1 holds a few houses at the bottom edge: a team with no structures is out at the first win check
    // (data_dynamic.js isTeamAliveByAssets), which a structure destroyed runs.)
    let nh = 0;
    for (let gy = H - 3; gy > H / 2 && nh < 16; gy--) for (let gx = 2; gx < W - 2 && nh < 16; gx += 37) { const tt = gy * W + gx; if (!floor[tt]) continue; struct.push(['house', 1, gx, gy, 1, 1e12, false, null, null, true, true]); floor[tt] = 0; nh++; }
    // Units: the bands' tiles (between each two lines), one unit every few tiles so the total is UNITS.
    const band = [];
    for (let li = 0; li < lineRows.length; li++) {
        const y0 = lineRows[li] + 1, y1 = li + 1 < lineRows.length ? lineRows[li + 1] : Math.min(H - 2, y0 + period - 1);
        for (let gy = y0; gy < y1; gy++) for (let gx = 2; gx < W - 2; gx++) if (floor[gy * W + gx]) band.push(gy * W + gx);
    }
    const every = Math.max(1, band.length / Math.max(1, UNITS + T0U));
    let nu = 0, n0 = 0;
    for (let i = 0; i < UNITS + T0U && Math.floor(i * every) < band.length; i++) {
        const t = band[Math.floor(i * every)], gx = t % W, gy = (t - gx) / W;
        // (Team 1 exactly UNITS: its population decides the structures' budget, data_static.js memoryBudgetBuildings.)
        const team = nu >= UNITS || (n0 < T0U && i % Math.max(1, Math.round((UNITS + T0U) / Math.max(1, T0U))) === 0) ? 0 : 1;
        if (team === 0 && n0 >= T0U) break;
        if (team === 0) n0++; else nu++;
        const type = team === 0 && T0TYPE ? T0TYPE : UNIT_TYPES[Math.floor(hash(gx, gy, 2) * UNIT_TYPES.length)];
        const order = ORDER === 'cross' && team === 1 ? ['attackMove', gx, gy < H / 2 ? H - 4 : 3] : null;
        units.push([type, team, gx + 0.5, gy + 0.5, UE, LEVEL, 1, order, false]);
    }
    // (Research by team, every stat: the game's own list, as make-mixed-scene.cjs reads it.)
    let researchKeys = [];
    if (RESEARCH.some(r => r.trim() !== 'none')) {
        const H2 = require('./net-harness.cjs'), world = new H2.World(), inst = world.spawn('keys', { simWorker: false });
        inst.eval('rebuildResearchThings()');
        researchKeys = JSON.parse(inst.eval('JSON.stringify(RESEARCH_THINGS.flatMap(t => (t.stats || []).map(s => t.kind + ":" + t.key + ":" + s.statKey)))'));
    }
    const players = header.players.map((_, i) => { const r = (RESEARCH[Math.min(i, RESEARCH.length - 1)] || 'none').trim(), researchLevels = {};
        if (r !== 'none') for (const k of researchKeys) researchLevels[k] = r === 'half' ? 5 : 10;
        return { energy: 1.2e14, astar: 1.2e13, researchLevels, researchOrders: [] }; });
    const settings = JSON.parse(JSON.stringify(header.settings));
    // (The population a team: its budget gives the structures their room, data_static.js memoryBudgetBuildings.)
    settings.lobby.numbers['cfg-max-pop'] = 131072;
    const out = { ...header, settings, teams: [0, 1], player: 1, sourceTick: 0, players, camera: { x: W / 2, y: H / 2, zoom: 0.08 } };
    const gz = zlib.createGzip({ level: 6 }), file = fs.createWriteStream(OUT);
    gz.pipe(file);
    const write = text => new Promise(res => { if (gz.write(text)) res(); else gz.once('drain', res); });
    let first = true;
    const emit = async record => { await write((first ? '[\n' : ',\n') + JSON.stringify(record)); first = false; };
    await emit(out);
    const counts = { terrain: 0, areas: 0, mines: 0, buildings: struct.length, units: units.length };
    for (const rec of terrain) { await emit(rec); counts.terrain += rec.terrain.length; }
    for (const rec of areas) { await emit(rec); counts.areas += rec.areas.length; }
    for (const rec of mines) { await emit(rec); counts.mines += rec.mines.length; }
    for (let i = 0; i < struct.length; i += 1024) await emit({ buildings: struct.slice(i, i + 1024) });
    for (let i = 0; i < units.length; i += 1024) await emit({ units: units.slice(i, i + 1024) });
    await emit({ end: counts });
    await write('\n]\n');
    await new Promise(res => { file.on('finish', res); gz.end(); });
    console.error(JSON.stringify({ out: OUT, MB: Math.round(fs.statSync(OUT).size / 1048576), kind: KIND, lines: lineRows.length, period, structs: struct.length, units: nu, team0Units: n0 }));
})().catch(e => { console.error(e); process.exit(1); });
