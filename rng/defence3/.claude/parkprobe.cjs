// Why idle workers are not parked (mvOn 2) after their Unit.update:
//   DATA=tests/10000-160.json node .claude/parkprobe.cjs [seconds]
const path = require('node:path');
const H = require(path.join(__dirname, '../tests/net-harness.cjs'));
const data = require(path.resolve(process.env.DATA || 'tests/10000-160.json'));
(async () => {
    const controls = { ...H.SMALL_MATCH_CONTROLS };
    for (const [k, v] of Object.entries(data.lobby.numbers)) controls[k] = String(v);
    for (const [k, v] of Object.entries(data.lobby.selects)) controls[k] = String(v);
    controls['cfg-full-vis'] = data.lobby.selects['cfg-full-vis'] || 'full';
    const world = new H.World({ controls, hashEvery: 1e9 });
    const hostSetup = `MAX_THING_LEVEL = ${data.lobby.numbers['cfg-max-thing-level'] || 20}; MAX_RESEARCH_LEVEL = ${data.lobby.numbers['cfg-max-research-level'] || 10};
        startingResourcesConfig = normalizeStartingResourcesConfig(${JSON.stringify(data.startingResources)}); applyMainMenuControlsToRuntimeState();
        applyEditableRuntimeConfigObject(${JSON.stringify(data.editableConfig)}, { fromTransport: true });`;
    const { host } = await H.startHostedMatch(world, { guests: 1, maxMs: 60000, controls, hostSetup });
    await world.run(2000);
    host.eval(`__scratch.park = {}; { const f = Unit.prototype.update; Unit.prototype.update = function () {
        const r = f.apply(this, arguments);
        if (this.workerState === 'IDLE' && this.commandState === CMD_IDLE && this._us) {
            const c = this._us, s = this._si; let why;
            if (c.mvOn[s] === 2) why = 'parked';
            else if (this.dead) why = 'dead';
            else if (this.holdPosition) why = 'hold';
            else if (this.workerTransferCooldown > 0) why = 'transferCooldown';
            else if (this._spatialEpoch !== spatialEpoch) why = 'epoch';
            else if (c.sepKey[s] === SIM_SEP_ABSENT) why = 'sepAbsent';
            else if (!Number.isFinite(this._workerNextIdleRetargetTick)) why = 'noNext';
            else why = 'wakeSoon:' + Math.min(9, this._workerNextIdleRetargetTick - gameTime);
            const k = this.workerType + ' ' + why; __scratch.park[k] = (__scratch.park[k] || 0) + 1;
        }
        return r; }; }`);
    const t0 = host.eval('currentTick');
    await world.run(Number(process.argv[2] || 5) * 1000);
    const n = host.eval('currentTick') - t0;
    const park = JSON.parse(host.eval('JSON.stringify(__scratch.park)'));
    console.log('ticks', n, 'idle workers', host.eval("units.filter(u => u.workerState === 'IDLE').length"));
    for (const [k, v] of Object.entries(park).sort((a, b) => b[1] - a[1])) console.log(String(Math.round(v / n)).padStart(7), k);
    process.exit(0);
})();
