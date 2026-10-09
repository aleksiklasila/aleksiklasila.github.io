(() => {
    const now = __scratch.realNow || (() => Date.now());
    const C = _simUnitState.columns, out = {};
    const a = C.oc_unitType;
    out.len = a.length; out.slots = _simUnitState.owners.length;
    let t0 = now(), n = 0;
    for (const u of units) if (u.unitType === 'norm') n++;
    out.readType = now() - t0;
    t0 = now();
    for (const u of units) if (u.owner === 0) n++;
    out.readOwner = now() - t0;
    t0 = now();
    for (let i = 0; i < a.length; i++) if (a[i] === 'norm') n++;
    out.scanArr = now() - t0;
    t0 = now();
    for (const u of units) if (u.workerState === 'IDLE') n++;
    out.readWs = now() - t0;
    t0 = now();
    for (const u of units) if (u.targetUnit) n++;
    out.readTarget = now() - t0;
    try { out.dictElems = eval('%HasDictionaryElements(a)'); out.fastCols = eval('%HasFastProperties(C)'); } catch (e) { out.natives = String(e).slice(0, 60); }
    out.n = n;
    return JSON.stringify(out);
})()
