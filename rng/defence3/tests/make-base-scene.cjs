// A base scene (terrain, areas, mines and the starting bases) of a new map of the given size, in the portable
// scene format: the map for tests/make-mixed-scene.cjs (--base=) at sizes the real scenes do not have.
//   node --max-old-space-size=12000 tests/make-base-scene.cjs --map=2000 --type=arena --teams=2 --out=tests/scenes/base-2000.gz
'use strict';
const fs = require('node:fs'), path = require('node:path'), zlib = require('node:zlib');
const arg = (n, d) => { const a = process.argv.find(x => x.startsWith('--' + n + '=')); return a ? a.slice(n.length + 3) : d; };
const MAP = arg('map', '2000'), TYPE = arg('type', 'arena'), OUT = arg('out', path.join(__dirname, 'scenes', 'base-' + MAP + '.gz')), SEED = Number(arg('seed', 12345));
const H = require('./net-harness.cjs');
(async () => {
    const controls = { ...H.SMALL_MATCH_CONTROLS, 'cfg-mapsize': MAP, 'cfg-map-type': TYPE, 'cfg-full-vis': 'full', 'cfg-gold-count': '10000', 'cfg-astar-mine-count': '10000' };
    const world = new H.World({ controls });
    const inst = world.spawn('base', { controls, simWorker: false });
    inst.eval(`startingResourcesConfig = normalizeStartingResourcesConfig({spawnCounts:{},researchLevels:{}}); applyMainMenuControlsToRuntimeState(); gameSeed = ${SEED}; startSoloGame();`);
    await world.run(500);
    const gridW = inst.eval('GRID_W');
    console.error('map', gridW, 'x', inst.eval('GRID_H'), 'areas', inst.eval('areas.length'), 'mines', inst.eval('goldMines.length + astarMines.length'));
    inst.eval('__scratch.parts = buildSoloGameSnapshotParts({ settings: { ...createMainMenuSettingsSnapshot(), editableConfig: serializeEditableRuntimeConfigForTransport() }, player: 0, teamColors: {}, camera: { x: GRID_W / 2, y: GRID_H / 2, zoom: 0.08 }, createdAt: "base" }); __scratch.parts.length');
    const n = inst.eval('__scratch.parts.length');
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    const gz = zlib.createGzip({ level: 6 }), file = fs.createWriteStream(OUT);
    gz.pipe(file);
    const write = text => new Promise(res => { if (gz.write(text)) res(); else gz.once('drain', res); });
    for (let i = 0; i < n; i++) await write((i ? ',\n' : '[\n') + inst.eval(`__scratch.parts[${i}].trimEnd()`));
    await write('\n]\n');
    await new Promise(res => { file.on('finish', res); gz.end(); });
    console.error('wrote', OUT, Math.round(fs.statSync(OUT).size / 1048576) + ' MB', n, 'records');
    process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
