// Summarize runtime GC events over the continuous settled window, including
// the time between tick timers. Pass one or more --system-metrics run files.
'use strict';
const fs = require('node:fs');
const { constants } = require('node:perf_hooks');

const names = {
    [constants.NODE_PERFORMANCE_GC_MINOR]: 'minor',
    [constants.NODE_PERFORMANCE_GC_MAJOR]: 'major',
    [constants.NODE_PERFORMANCE_GC_INCREMENTAL]: 'incremental',
    [constants.NODE_PERFORMANCE_GC_WEAKCB]: 'weakCallbacks',
};

function stats(pauses) {
    pauses.sort((a, b) => a - b);
    return {
        count: pauses.length,
        totalMs: pauses.reduce((sum, ms) => sum + ms, 0),
        p95Ms: pauses[Math.ceil(pauses.length * 0.95) - 1] ?? 0,
        maxMs: pauses.at(-1) ?? 0,
    };
}

const files = process.argv.slice(2);
if (!files.length) throw new Error('Usage: node tests/chaos-gc-summary.cjs RUN.json [RUN.json ...]');
const summaries = files.map(file => {
    const run = JSON.parse(fs.readFileSync(file, 'utf8'));
    const first = run.rows[run.warmup], last = run.rows.at(-1);
    if (!Array.isArray(run.gcEntries) || !first || !last || !Number.isFinite(first.gcMs)) {
        throw new Error('Expected a --system-metrics run with a settled window: ' + file);
    }
    const start = first.at, end = last.at + last.wallMs;
    const seconds = (end - start) / 1000;
    const events = run.gcEntries.filter(event => event.at >= start && event.at < end);
    const byKind = new Map();
    for (const event of events) {
        const name = names[event.kind] ?? String(event.kind);
        if (!byKind.has(name)) byKind.set(name, []);
        byKind.get(name).push(event.ms);
    }
    const all = stats(events.map(event => event.ms));
    return {
        file,
        firstStep: first.step,
        lastStep: last.step,
        seconds,
        ...all,
        eventsPerSecond: all.count / seconds,
        gcMsPerSecond: all.totalMs / seconds,
        byKind: Object.fromEntries([...byKind].map(([name, pauses]) => [name, stats(pauses)])),
    };
});
console.log(JSON.stringify(summaries, null, 2));
