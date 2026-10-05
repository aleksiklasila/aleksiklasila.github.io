// JS heap composition of a hosted match (host + guest over the net harness):
// a heap snapshot after the start, self sizes summed by constructor / node
// type, and per unit. Small fixtures only (the snapshot is the whole heap).
//   DATA=tests/10000-160.json node --max-old-space-size=8000 .claude/probes/heapcomp.cjs [top=50]
const path = require('node:path'), v8 = require('node:v8'), fs = require('node:fs');
const H = require(path.join(__dirname, '../../tests/net-harness.cjs'));
const data = require(path.resolve(process.env.DATA || 'tests/10000-160.json'));
(async () => {
    const controls = { ...H.SMALL_MATCH_CONTROLS };
    for (const [k, v] of Object.entries(data.lobby.numbers)) controls[k] = String(v);
    for (const [k, v] of Object.entries(data.lobby.selects)) controls[k] = String(v);
    controls['cfg-full-vis'] = 'full';
    const world = new H.World({ controls, hashEvery: 1e9 });
    const hostSetup = `
        MAX_THING_LEVEL = ${data.lobby.numbers['cfg-max-thing-level'] || 20};
        MAX_RESEARCH_LEVEL = ${data.lobby.numbers['cfg-max-research-level'] || 10};
        startingResourcesConfig = normalizeStartingResourcesConfig(${JSON.stringify(data.startingResources)});
        applyMainMenuControlsToRuntimeState();
        applyEditableRuntimeConfigObject(${JSON.stringify(data.editableConfig)}, { fromTransport: true });`;
    const { host, guests } = await H.startHostedMatch(world, { guests: 1, maxMs: 60000, controls, hostSetup });
    await world.run(2000);
    const units = host.eval('units.length'), cells = host.eval('GRID_W * GRID_H');
    global.gc && global.gc();
    const file = path.join(require('node:os').tmpdir(), 'heapcomp-' + process.pid + '.heapsnapshot');
    v8.writeHeapSnapshot(file);
    const snap = JSON.parse(fs.readFileSync(file, 'utf8'));
    fs.unlinkSync(file);
    const m = snap.snapshot.meta, F = m.node_fields, nf = F.length, types = m.node_types[0], S = snap.strings, N = snap.nodes;
    const iType = F.indexOf('type'), iName = F.indexOf('name'), iSize = F.indexOf('self_size');
    const by = new Map();
    let total = 0;
    for (let i = 0; i < N.length; i += nf) {
        const t = types[N[i + iType]], name = S[N[i + iName]], sz = N[i + iSize];
        total += sz;
        const key = t === 'object' || t === 'closure' ? t + ':' + name : t === 'string' || t === 'concatenated string' || t === 'sliced string' ? 'string' : t + (t === 'array' || t === 'code' || t === 'hidden' ? ':' + (name.length > 40 ? name.slice(0, 40) : name) : '');
        const e = by.get(key) || [0, 0];
        e[0] += sz; e[1]++;
        by.set(key, e);
    }
    // Unit fields: per property name, the targets' self sizes and kinds
    // (each target counted once per unit edge).
    const E = snap.edges, ef = m.edge_fields, nef = ef.length, etypes = m.edge_types[0];
    const iEc = F.indexOf('edge_count'), iEt = ef.indexOf('type'), iEn = ef.indexOf('name_or_index'), iTo = ef.indexOf('to_node');
    const fieldBy = new Map();
    let unitNodes = 0;
    for (let i = 0, e = 0; i < N.length; i += nf) {
        const ec = N[i + iEc];
        const isUnit = types[N[i + iType]] === 'object' && S[N[i + iName]] === 'Unit';
        if (isUnit) {
            unitNodes++;
            for (let k = 0; k < ec; k++) {
                const o = (e + k) * nef, et = etypes[E[o + iEt]];
                if (et !== 'property' && et !== 'internal') continue;
                const name = et === 'property' ? S[E[o + iEn]] : 'internal:' + S[E[o + iEn]];
                const to = E[o + iTo], tt = types[N[to + iType]], tn = S[N[to + iName]], tsz = N[to + iSize];
                const key = name + ' -> ' + (tt === 'object' ? tn : tt);
                let r = fieldBy.get(key);
                if (!r) fieldBy.set(key, r = [0, 0, new Set()]);
                if (!r[2].has(to)) { r[2].add(to); r[0] += tsz; }
                r[1]++;
            }
        }
        e += ec;
    }
    console.log('unit fields by target bytes (unit nodes', unitNodes, '):');
    for (const [k, [sz, n, set]] of [...fieldBy].sort((a, b) => b[1][0] - a[1][0]).slice(0, 45))
        console.log((sz / 1048576).toFixed(2).padStart(9), 'MB', String(set.size).padStart(9), 'distinct of', String(n).padStart(7), (sz / set.size).toFixed(0).padStart(6), 'B ', k);
    // Numbers, strings, element arrays and plain objects by who holds them
    // (parent's constructor or type, and the edge's name): every edge into
    // one counts its target's size once per (parent kind, edge) key.
    {
        const want = new Set(['number', 'string', 'concatenated string', 'sliced string', 'array']);
        const held = new Map();
        for (let i = 0, e = 0; i < N.length; i += nf) {
            const ec = N[i + iEc], pt = types[N[i + iType]], pn = S[N[i + iName]];
            const pkind = pt === 'object' || pt === 'closure' ? pn : pt + (pt === 'array' || pt === 'hidden' ? ':' + pn.slice(0, 30) : '');
            for (let k = 0; k < ec; k++) {
                const o = (e + k) * nef, et = etypes[E[o + iEt]];
                if (et === 'weak' || et === 'shortcut') continue;
                const to = E[o + iTo], tt = types[N[to + iType]];
                if (!want.has(tt) && !(tt === 'object' && S[N[to + iName]] === 'Object')) continue;
                const ename = et === 'element' || et === 'hidden' ? '[' + et + ']' : S[E[o + iEn]];
                const key = (tt === 'object' ? 'Object' : tt) + ' <- ' + pkind + '.' + ename;
                let r = held.get(key);
                if (!r) held.set(key, r = [0, 0]);
                r[0] += N[to + iSize]; r[1]++;
            }
            e += ec;
        }
        console.log('values by holder:');
        for (const [k, [sz, n]] of [...held].sort((a, b) => b[1][0] - a[1][0]).slice(0, 40))
            console.log((sz / 1048576).toFixed(2).padStart(9), 'MB', String(n).padStart(9), 'x', (sz / n).toFixed(0).padStart(7), 'B ', k.slice(0, 120));
    }
    // Plain objects by their property names (the shape): what the many
    // small objects are.
    {
        const edgeStart = new Int32Array(N.length / nf + 1);
        for (let i = 0, e = 0, j = 0; i < N.length; i += nf, j++) { edgeStart[j] = e; e += N[i + iEc]; }
        const shapes = new Map();
        for (let i = 0, j = 0; i < N.length; i += nf, j++) {
            if (types[N[i + iType]] !== 'object' || S[N[i + iName]] !== 'Object') continue;
            const ec = N[i + iEc], names = [];
            for (let k = 0; k < ec && names.length < 8; k++) { const o = (edgeStart[j] + k) * nef; if (etypes[E[o + iEt]] === 'property') names.push(S[E[o + iEn]]); }
            const key = names.join(',');
            let r = shapes.get(key);
            if (!r) shapes.set(key, r = [0, 0]);
            r[0] += N[i + iSize]; r[1]++;
        }
        console.log('plain objects by shape:');
        for (const [k, [sz, n]] of [...shapes].sort((a, b) => b[1][0] - a[1][0]).slice(0, 25))
            console.log((sz / 1048576).toFixed(2).padStart(9), 'MB', String(n).padStart(9), 'x', (sz / n).toFixed(0).padStart(7), 'B ', k.slice(0, 120));
        // Element arrays by their owner array's holder.
        const arrs = new Map();
        for (let i = 0, j = 0; i < N.length; i += nf, j++) {
            const pt = types[N[i + iType]], pn = S[N[i + iName]];
            const ec = N[i + iEc];
            for (let k = 0; k < ec; k++) {
                const o = (edgeStart[j] + k) * nef, et = etypes[E[o + iEt]];
                if (et !== 'property') continue;
                const to = E[o + iTo];
                if (types[N[to + iType]] !== 'object' || S[N[to + iName]] !== 'Array') continue;
                // The array's elements store size.
                let el = 0; const tj = to / nf;
                for (let q = 0; q < N[to + iEc]; q++) { const o2 = (edgeStart[tj] + q) * nef; if (etypes[E[o2 + iEt]] === 'internal' && S[E[o2 + iEn]] === 'elements') el += N[E[o2 + iTo] + iSize]; }
                const key = (pt === 'object' ? pn : pt) + '.' + S[E[o + iEn]];
                let r = arrs.get(key);
                if (!r) arrs.set(key, r = [0, 0]);
                r[0] += el + N[to + iSize]; r[1]++;
            }
        }
        // Holders of the property-less plain objects, and what those hold.
        {
            const empty = new Uint8Array(N.length / nf);
            for (let i = 0, j = 0; i < N.length; i += nf, j++) {
                if (types[N[i + iType]] !== 'object' || S[N[i + iName]] !== 'Object') continue;
                let props = 0; for (let k = 0; k < N[i + iEc]; k++) { const o = (edgeStart[j] + k) * nef; if (etypes[E[o + iEt]] === 'property' && S[E[o + iEn]] !== '__proto__') props++; }
                if (!props) empty[j] = 1;
            }
            const hold = new Map(), inner = new Map();
            for (let i = 0, j = 0; i < N.length; i += nf, j++) {
                const pt = types[N[i + iType]], pn = S[N[i + iName]];
                for (let k = 0; k < N[i + iEc]; k++) {
                    const o = (edgeStart[j] + k) * nef, et = etypes[E[o + iEt]], to = E[o + iTo];
                    if (et === 'weak' || !empty[to / nf]) continue;
                    const key = (pt === 'object' ? pn : pt + ':' + pn.slice(0, 20)) + '.' + (et === 'element' ? '[i]' : S[E[o + iEn]]);
                    hold.set(key, (hold.get(key) || 0) + 1);
                }
                if (empty[j]) for (let k = 0; k < N[i + iEc]; k++) { const o = (edgeStart[j] + k) * nef; const key = etypes[E[o + iEt]] + ':' + S[E[o + iEn]] + '->' + types[N[E[o + iTo] + iType]]; inner.set(key, (inner.get(key) || 0) + 1); }
            }
            console.log('holders of property-less objects:', JSON.stringify([...hold].sort((a, b) => b[1] - a[1]).slice(0, 12)));
            console.log('their edges:', JSON.stringify([...inner].sort((a, b) => b[1] - a[1]).slice(0, 12)));
        }
        console.log('arrays (with element stores) by holder:');
        for (const [k, [sz, n]] of [...arrs].sort((a, b) => b[1][0] - a[1][0]).slice(0, 25))
            console.log((sz / 1048576).toFixed(2).padStart(9), 'MB', String(n).padStart(9), 'x', (sz / n).toFixed(0).padStart(7), 'B ', k.slice(0, 120));
    }
    const top = +process.argv[2] || 50;
    console.log('units per peer', units, 'tiles', cells, 'total self MB', (total / 1048576).toFixed(1), '(both peers)');
    for (const [k, [sz, n]] of [...by].sort((a, b) => b[1][0] - a[1][0]).slice(0, top))
        console.log((sz / 1048576).toFixed(2).padStart(9), 'MB', String(n).padStart(9), 'x', (sz / n).toFixed(0).padStart(6), 'B ', k);
    process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
