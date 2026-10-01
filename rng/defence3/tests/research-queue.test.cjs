// Research queue in multiplayer: every task's level, cost and work must follow
// its position (same-stat tasks always run lowest level first), progress stays
// with the level when tasks are reordered, and every peer agrees tick by tick
// through queueing, reordering, dequeueing and completion in any combination.
const assert = require('node:assert/strict');
const H = require('./net-harness.cjs');

const WAN = { latencyMs: 50, jitterMs: 10 };
const BASE = {
    ...H.SMALL_MATCH_CONTROLS, 'cfg-mapsize': '30', 'cfg-map-type': 'arena',
    'cfg-starting-energy': '2000000', 'cfg-starting-astar': '2000000', 'cfg-max-pop': '5000'
};
const START = {
    'building:research': { 3: 2 }, 'building:house': { 8: 1 },
    'unit:researcher_unit': { 3: 8 }, 'unit:king': { 1: 1 }
};

async function match({ guests = 1, spawnCounts = START, researchLevels = {} } = {}) {
    const world = new H.World({ network: WAN, controls: BASE, hashEvery: 1, exactHashes: true });
    const res = await H.startHostedMatch(world, { guests, hostSetup: `startingResourcesConfig = ${JSON.stringify({ spawnCounts, researchLevels })};` });
    return { world, ...res, all: [res.host, ...res.guests] };
}

function assertInSync(world, all, label, minCompared = 50) {
    for (const inst of all) assert.deepEqual(inst.errors.map(e => String(e.stack || e).slice(0, 400)), [], label + ': ' + inst.name + ' threw');
    const cmp = world.compareHashes(all, 0, 'tickExact');
    assert.equal(cmp.mismatches.length, 0, label + ': diverged ' + JSON.stringify(cmp.mismatches.slice(0, 3)));
    assert.ok(cmp.compared >= minCompared, label + ': compared ' + cmp.compared);
    for (const inst of all) assert.equal(inst.eval('netCounters.desyncsDetected'), 0, label + ': ' + inst.name + ' desynced');
}

const q = (inst, a) => inst.eval(`queueAction(${JSON.stringify(a)})`);
const own = (inst, expr) => JSON.parse(inst.eval(`JSON.stringify(${expr})`));
const labOf = inst => own(inst, `(s => ({ gx: s.gx, gy: s.gy }))(collectorSpawners.find(s => s.owner === localPlayerId && s.type === 'research'))`);
const sid = s => s.kind + ':' + s.key + ':' + s.statKey;

// Ordered tasks of a player: active first, then the pending queue.
const tasksOf = (inst, pid) => own(inst, `(p => [p.researchTask, ...p.researchQueue].filter(Boolean).map(t => ({
    id: t.kind + ':' + t.key + ':' + t.statKey, kind: t.kind, key: t.key, statKey: t.statKey,
    fromLevel: t.fromLevel, toLevel: t.toLevel, cost: t.cost, workRequired: t.workRequired, workDone: t.workDone })))(ensurePlayerResearchQueueState(${pid}))`);
const hasActive = (inst, pid) => inst.eval(`!!ensurePlayerResearchQueueState(${pid}).researchTask`);
const pendingLen = (inst, pid) => inst.eval(`ensurePlayerResearchQueueState(${pid}).researchQueue.length`);
const levelOf = (inst, pid, s) => inst.eval(`getPlayerResearchLevel(${pid}, ${JSON.stringify(s.kind)}, ${JSON.stringify(s.key)}, ${JSON.stringify(s.statKey)})`);

// Every task is priced for its position: the n-th task of a stat researches
// base + n, with the cost and work of that level.
function invariantViolations(inst, pid) {
    return own(inst, `(() => {
        const out = [];
        const p = ensurePlayerResearchQueueState(${pid});
        const ordered = [p.researchTask, ...p.researchQueue].filter(Boolean);
        if (!p.researchTask && p.researchQueue.length > 0) out.push('pending tasks without an active task');
        if (ordered.length > getResearchQueueCapacityForPlayer(${pid})) out.push('over capacity ' + ordered.length);
        const prior = {};
        ordered.forEach((t, i) => {
            const id = t.kind + ':' + t.key + ':' + t.statKey;
            const cap = MAX_RESEARCH_LEVEL;
            const want = getPlayerResearchLevel(${pid}, t.kind, t.key, t.statKey) + (prior[id] || 0);
            prior[id] = (prior[id] || 0) + 1;
            const at = '#' + i + ' ' + id;
            if (want >= cap) out.push(at + ' queued past the cap');
            if (t.fromLevel !== want) out.push(at + ' fromLevel ' + t.fromLevel + ' want ' + want);
            if (t.toLevel !== t.fromLevel + 1) out.push(at + ' toLevel ' + t.toLevel);
            if (t.cost !== getResearchCost(t.kind, t.key, t.statKey, want)) out.push(at + ' cost ' + t.cost);
            if (t.workRequired !== getResearchWork(t.kind, t.key, t.statKey, want)) out.push(at + ' work ' + t.workRequired);
            if (!(t.workDone >= 0 && t.workDone <= t.workRequired)) out.push(at + ' workDone ' + t.workDone + '/' + t.workRequired);
        });
        return out;
    })()`);
}

// The queue panel shows the same level and work as the task it renders.
function hudViolations(inst, pid) {
    // Thumbnails need a canvas; the harness has none.
    const html = inst.eval(`(() => {
        const labs = collectorSpawners.filter(s => s.owner === ${pid} && s.type === 'research');
        const icon = _renderResearchQueueThingIconHtml;
        _renderResearchQueueThingIconHtml = () => '';
        try { return labs.length ? renderQueuedResearchTasksForGroup(labs) : ''; } finally { _renderResearchQueueThingIconHtml = icon; }
    })()`);
    const tasks = tasksOf(inst, pid);
    const labels = [...html.matchAll(/<span style="color:#9cf">R(\d+)<\/span>/g)].map(m => Number(m[1]));
    const out = [];
    if (labels.length !== tasks.length) out.push('rows ' + labels.length + ' vs tasks ' + tasks.length);
    tasks.forEach((t, i) => { if (labels[i] !== t.toLevel) out.push('row ' + i + ' shows R' + labels[i] + ' for R' + t.toLevel); });
    return out;
}

// The tick the page's copy of the state is at: with the simulation worker the
// lockstep counter (currentTick) runs ahead of the results applied so far.
const stateTick = inst => inst.eval(`typeof simClientActive === 'function' && simClientActive() ? _simClient.appliedTick + 1 : currentTick`);

function assertValid(all, pids, label) {
    for (const inst of all) for (const pid of pids) {
        assert.deepEqual(invariantViolations(inst, pid), [], `${label}: ${inst.name} player ${pid}`);
    }
    for (const pid of pids) {
        const ref = tasksOf(all[0], pid);
        // Peers run at slightly different ticks, so compare the order only; exact per-tick
        // agreement of every field is covered by the harness hash.
        for (const inst of all.slice(1)) {
            const other = tasksOf(inst, pid);
            if (stateTick(inst) === stateTick(all[0])) assert.deepEqual(other, ref, `${label}: ${inst.name} sees player ${pid}'s queue`);
        }
    }
}

// Deterministic PRNG so a failure reproduces.
function rng(seed) {
    let s = seed >>> 0;
    return () => { s = (Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) + 0x6d2b79f5) >>> 0; s ^= s >>> 13; return (s >>> 0) / 4294967296; };
}

(async () => {
    const rows = [];

    // 1. The reported case: two levels of one stat, the second moved to the top.
    {
        // Start two cheap stats at R2 so a level takes long enough to watch its progress.
        const S = { kind: 'building', key: 'farm', statKey: 'multiplier' };
        const T = { kind: 'building', key: 'astar_farm', statKey: 'multiplier' };
        const { world, host, guests, all } = await match({ researchLevels: { 'building:farm': { multiplier: 2 }, 'building:astar_farm': { multiplier: 2 } } });
        const pid = host.eval('localPlayerId');
        const lab = labOf(host);
        assert.equal(levelOf(host, pid, S), 2, 'starting research level applied');
        const add = (s, count = 1) => q(host, { action: 'queueResearch', gx: lab.gx, gy: lab.gy, kind: s.kind, key: s.key, statKey: s.statKey, count });
        const moveTop = i => q(host, { action: 'reorderResearch', gx: lab.gx, gy: lab.gy, fromIndex: i, toIndex: 0, fromActive: false, toActive: false });
        const moveBottom = (i, active = false) => q(host, { action: 'reorderResearch', gx: lab.gx, gy: lab.gy, fromIndex: i, toIndex: pendingLen(host, pid) - 1, fromActive: active, toActive: false });

        // Expected rows: [stat, fromLevel, progress], where progress is a minimum for the level
        // researchers may still be feeding (they keep delivering in-flight material), exact otherwise.
        let progress = 0;
        const expectRows = (want, label) => {
            const t = tasksOf(host, pid);
            assert.deepEqual(t.map(x => [x.id, x.fromLevel]), want.map(w => [sid(w[0]), w[1]]), label + ': order/levels');
            want.forEach((w, i) => {
                if (w[2] === 'kept') assert.ok(t[i].workDone >= progress && t[i].workDone > 0, `${label}: row ${i} kept its progress (${t[i].workDone} >= ${progress})`);
                else if (w[2] === 'any') assert.ok(t[i].workDone >= 0);
                else assert.equal(t[i].workDone, w[2], `${label}: row ${i} progress`);
            });
            assertValid(all, [pid], label);
            assert.deepEqual(hudViolations(host, pid), [], label + ': panel rows');
            return t;
        };

        add(S, 2);
        assert.ok(await world.runUntil(() => (tasksOf(host, pid)[0] || {}).workDone > 0, 20000, 50), 'research started');
        const base = levelOf(host, pid, S);
        progress = tasksOf(host, pid)[0].workDone;

        moveTop(0);
        await world.run(1000);
        let t = expectRows([[S, base, 'kept'], [S, base + 1, 0]], 'moving R' + (base + 2) + ' above R' + (base + 1));
        assert.equal(t[0].workRequired, host.eval(`getResearchWork(${JSON.stringify(S.kind)}, ${JSON.stringify(S.key)}, ${JSON.stringify(S.statKey)}, ${base})`));
        progress = t[0].workDone;

        moveBottom(-1, true);
        await world.run(1000);
        progress = expectRows([[S, base, 'kept'], [S, base + 1, 0]], 'moving the active level down')[0].workDone;

        // Another stat in between: S, S, T -> move T to the top, then an S above T.
        add(T, 1);
        await world.run(1000);
        progress = tasksOf(host, pid)[0].workDone;
        moveTop(1);
        await world.run(2000);
        const tBase = levelOf(host, pid, T);
        // Researchers may finish one in-flight delivery into S right after the move.
        t = expectRows([[T, tBase, 'any'], [S, base, 'kept'], [S, base + 1, 0]], 'other stat to the top');
        progress = t[1].workDone;
        await world.run(2000);
        assert.equal(tasksOf(host, pid)[1].workDone, progress, 'paused stat keeps its progress unchanged');
        moveTop(1); // the higher S level jumps above T: still the lowest S level runs first
        await world.run(1000);
        t = expectRows([[S, base, 'kept'], [T, tBase, 'any'], [S, base + 1, 0]], 'higher S level above T');
        progress = t[0].workDone;

        // Dequeue removes the highest level and leaves the rest priced right.
        q(host, { action: 'dequeueResearch', gx: lab.gx, gy: lab.gy, kind: S.kind, key: S.key, statKey: S.statKey, count: 1 });
        await world.run(1000);
        expectRows([[S, base, 'kept'], [T, tBase, 'any']], 'dequeue drops the top level');

        // Resume and let everything finish: exactly one level per queued task.
        const beforeS = levelOf(host, pid, S), beforeT = levelOf(host, pid, T);
        add(S, 1);
        await world.run(500);
        moveTop(pendingLen(host, pid) - 1);
        let checks = 0;
        const done = await world.runUntil(() => {
            if (++checks % 10 === 0) assertValid(all, [pid], 'draining');
            return !hasActive(host, pid);
        }, 240000, 200);
        assert.ok(done, 'queue drained: ' + JSON.stringify(tasksOf(host, pid)));
        assert.equal(levelOf(host, pid, S), beforeS + 2, 'two S levels researched');
        assert.equal(levelOf(host, pid, T), beforeT + 1, 'one T level researched');
        for (const g of guests) {
            assert.equal(levelOf(g, pid, S), beforeS + 2);
            assert.equal(levelOf(g, pid, T), beforeT + 1);
        }
        assertInSync(world, all, 'reported case');
        rows.push(`reported case: R${base + 2} moved above R${base + 1} stays second, progress ${progress.toFixed(0)} kept on R${base + 1}; queue drained to +2/+1`);
    }

    // 2. A queue left inconsistent (e.g. by an older build) heals on the next reorder/dequeue.
    {
        const { world, host, all } = await match();
        const pid = host.eval('localPlayerId');
        const lab = labOf(host);
        const S = own(host, `(t => ({ kind: t.kind, key: t.key, statKey: t.stats[0].statKey }))(RESEARCH_THINGS.find(t => t.kind === 'unit'))`);
        q(host, { action: 'queueResearch', gx: lab.gx, gy: lab.gy, ...S, count: 3 });
        await world.run(1500);
        // Same corruption on every peer at the same tick: levels swapped, like the old reorder left them.
        world.atNextSafeTick(`(() => { const p = ensurePlayerResearchQueueState(${pid}); const a = p.researchTask, b = p.researchQueue[1];
            for (const k of ['fromLevel', 'toLevel', 'cost', 'workRequired']) { const v = a[k]; a[k] = b[k]; b[k] = v; } })()`);
        await world.run(3000);
        assert.ok(invariantViolations(host, pid).length > 0, 'corruption applied');
        q(host, { action: 'reorderResearch', gx: lab.gx, gy: lab.gy, fromIndex: 1, toIndex: 0, fromActive: false, toActive: false });
        await world.run(1500);
        assertValid(all, [pid], 'healed by reorder');
        world.atNextSafeTick(`(() => { const p = ensurePlayerResearchQueueState(${pid}); p.researchQueue[0].fromLevel = 7; p.researchQueue[0].workRequired = 99999; })()`);
        await world.run(3000);
        q(host, { action: 'dequeueResearch', gx: lab.gx, gy: lab.gy, kind: 'unit', key: 'nope', statKey: 'nope', count: 1 });
        await world.run(1500);
        assertValid(all, [pid], 'healed by dequeue');
        assertInSync(world, all, 'healing');
        rows.push('stale queue state heals on the next reorder or dequeue, identically on every peer');
    }

    // 3. Fuzz: three players edit their own queues at once with every action and
    //    index combination while researchers keep working.
    for (const seed of [1, 7, 42]) {
        const { world, host, guests, all } = await match({ guests: 2 });
        const rand = rng(seed);
        const pick = arr => arr[Math.floor(rand() * arr.length)];
        const pool = own(host, `(() => {
            const all = RESEARCH_THINGS.flatMap(t => (t.stats || []).map(s => ({ kind: t.kind, key: t.key, statKey: s.statKey, w: getResearchWork(t.kind, t.key, s.statKey, 0) })));
            const cheap = all.slice().sort((a, b) => a.w - b.w).slice(0, 3);
            const cap = all.find(s => s.statKey === 'maxLevel');
            const unit = all.find(s => s.kind === 'unit');
            return [...cheap, cap, unit].filter(Boolean);
        })()`);
        const players = all.map(inst => ({ inst, pid: inst.eval('localPlayerId'), lab: labOf(inst) }));
        const pids = players.map(p => p.pid);
        const counts = {};
        const startLevels = players.map(p => pool.map(s => levelOf(host, p.pid, s)));
        for (let step = 0; step < 160; step++) {
            for (const p of players) {
                if (rand() < 0.35) continue;
                const { inst, pid, lab } = p;
                const len = pendingLen(inst, pid);
                const r = rand();
                let a;
                if (r < 0.3) {
                    const s = pick(pool);
                    a = { action: 'queueResearch', gx: lab.gx, gy: lab.gy, kind: s.kind, key: s.key, statKey: s.statKey, count: 1 + Math.floor(rand() * 3) };
                    // Bottom bar drop: insert at a position, including the active slot and past the end.
                    if (rand() < 0.4) a.insertAt = Math.floor(rand() * (len + 3));
                } else if (r < 0.45) {
                    const s = pick(pool);
                    a = rand() < 0.8
                        ? { action: 'dequeueResearch', gx: lab.gx, gy: lab.gy, kind: s.kind, key: s.key, statKey: s.statKey, count: 1 + Math.floor(rand() * 2) }
                        : { action: 'dequeueResearch', gx: lab.gx, gy: lab.gy, count: 1 };
                } else if (r < 0.7) {
                    a = { action: 'reorderResearch', gx: lab.gx, gy: lab.gy, fromIndex: Math.floor(rand() * Math.max(1, len)), toIndex: 0, fromActive: false, toActive: false };
                } else if (r < 0.85) {
                    const fromActive = rand() < 0.3;
                    a = { action: 'reorderResearch', gx: lab.gx, gy: lab.gy, fromIndex: fromActive ? -1 : Math.floor(rand() * Math.max(1, len)), toIndex: Math.max(0, len - 1), fromActive, toActive: false };
                } else if (r < 0.89) {
                    // Bottom bar drag: plain ordered indices, including out-of-range ones.
                    a = { action: 'moveResearch', from: Math.floor(rand() * (len + 3)) - 1, to: Math.floor(rand() * (len + 3)) - 1 };
                } else if (r < 0.93) {
                    // Arbitrary moves, including out-of-range and to the active slot.
                    a = { action: 'reorderResearch', gx: lab.gx, gy: lab.gy, fromIndex: Math.floor(rand() * (len + 3)) - 1, toIndex: Math.floor(rand() * (len + 3)) - 1, fromActive: rand() < 0.2, toActive: rand() < 0.2 };
                } else {
                    const l = own(inst, `collectorSpawners.filter(s => s.owner === localPlayerId && s.type === 'research').map(s => ({ gx: s.gx, gy: s.gy }))`);
                    const target = pick(l);
                    a = { action: 'setAutoResearch', gx: target.gx, gy: target.gy, enabled: rand() < 0.75 };
                }
                const kind = a.action + (a.action === 'reorderResearch' ? (a.fromActive ? ':active' : a.toIndex === 0 ? ':top' : ':down') : '') + (a.insertAt !== undefined ? ':insertAt' : '');
                counts[kind] = (counts[kind] || 0) + 1;
                q(inst, a);
            }
            await world.run(150 + Math.floor(rand() * 400));
            if (step % 8 === 0) assertValid(all, pids, `seed ${seed} step ${step}`);
        }
        // Re-enable research everywhere and let it run a while; queues stay valid throughout.
        for (const p of players) for (const l of own(p.inst, `collectorSpawners.filter(s => s.owner === localPlayerId && s.type === 'research').map(s => ({ gx: s.gx, gy: s.gy }))`)) {
            q(p.inst, { action: 'setAutoResearch', gx: l.gx, gy: l.gy, enabled: true });
        }
        for (let i = 0; i < 20; i++) { await world.run(1000); assertValid(all, pids, `seed ${seed} settle ${i}`); }
        for (const inst of all) for (const pid of pids) assert.deepEqual(hudViolations(inst, pid), [], `seed ${seed}: ${inst.name} panel for ${pid}`);
        const gained = players.reduce((n, p, i) => n + pool.reduce((m, s, j) => m + levelOf(host, p.pid, s) - startLevels[i][j], 0), 0);
        assert.ok(gained > 0, `seed ${seed}: research progressed`);
        // Every peer's levels at the same tick (peers run a few ticks apart).
        const levelsExpr = JSON.stringify(players.map(p => pool.map(s => `getPlayerResearchLevel(${p.pid}, ${JSON.stringify(s.kind)}, ${JSON.stringify(s.key)}, ${JSON.stringify(s.statKey)})`)));
        const at = world.atNextSafeTick(`__scratch.levels = JSON.stringify(${levelsExpr}.map(r => r.map(e => eval(e))))`);
        await world.runUntil(() => all.every(i => i.eval('currentTick') > at + 1), 20000, 20);
        for (const g of guests) assert.equal(g.scratch.levels, host.scratch.levels, `seed ${seed}: levels agree at tick ${at}`);
        assertInSync(world, all, `fuzz seed ${seed}`, 500);
        rows.push(`fuzz seed ${seed}: 3 players, ${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(', ')}; ${gained} levels researched, in sync`);
    }

    console.log('PASS: research queue');
    for (const r of rows) console.log('  ' + r);
    process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
