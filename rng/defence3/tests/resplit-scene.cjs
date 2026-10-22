// A real scene played by more teams: every unit and structure goes to a team by the BLOCK-tile block it
// stands in (a hash of the block), so the two armies of the base scene become T teams with fronts all
// through the old battlefield. The terrain, areas, mines, types, levels and research stay as they were.
//   node --max-old-space-size=8192 tests/resplit-scene.cjs --in=tests/200k-attack-low-tps.gz --teams=8 --out=tests/scenes/attack-200k-8teams.gz
'use strict';
const fs = require('node:fs'), zlib = require('node:zlib');
const arg = (n, d) => { const a = process.argv.find(x => x.startsWith('--' + n + '=')); return a ? a.slice(n.length + 3) : d; };
const IN = arg('in', 'tests/200k-attack-low-tps.gz'), OUT = arg('out', 'tests/scenes/resplit.gz'), T = Number(arg('teams', 8)), BLOCK = Number(arg('block', 24)), SEED = Number(arg('seed', 3));
const records = JSON.parse(zlib.gunzipSync(fs.readFileSync(IN)));
const h = records[0];
const hash = (a, b) => { let x = Math.imul(a + 1, 0x9e3779b1) ^ Math.imul(b + 7, 0x85ebca6b) ^ SEED; x = Math.imul(x ^ (x >>> 15), 0x2c1b3c6d); x ^= x >>> 12; return (x >>> 0); };
const team = (gx, gy) => hash(Math.floor(gx / BLOCK), Math.floor(gy / BLOCK)) % T;
const count = new Array(T).fill(0);
for (const r of records) {
    if (r.units) for (const row of r.units) { row[1] = team(row[2], row[3]); count[row[1]]++; }
    if (r.buildings) for (const row of r.buildings) { row[1] = team(row[2], row[3]); }
}
h.teams = Array.from({ length: T }, (_, i) => i); h.player = 0;
// The research of the base's team 0 and 1 is kept for those; the others start from the first's.
for (let i = 0; i < h.players.length; i++) if (i >= 2) h.players[i].researchLevels = { ...h.players[i % 2].researchLevels };
fs.mkdirSync(require('node:path').dirname(OUT), { recursive: true });
const gz = zlib.createGzip({ level: 6 }), file = fs.createWriteStream(OUT);
gz.pipe(file);
(async () => {
    const write = text => new Promise(res => { if (gz.write(text)) res(); else gz.once('drain', res); });
    for (let i = 0; i < records.length; i++) await write((i ? ',\n' : '[\n') + JSON.stringify(records[i]));
    await write('\n]\n');
    await new Promise(res => { file.on('finish', res); gz.end(); });
    console.error(JSON.stringify({ out: OUT, teams: T, unitsByTeam: count }));
})();
