'use strict';
// Real fixtures, active simulation, hardware WebGL. Run serially.
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const {chromium} = require('playwright');
const root = path.resolve(__dirname, '..');
const server = http.createServer((req, res) => {
    const file = path.resolve(root, '.' + new URL(req.url, 'http://localhost').pathname);
    if (!file.startsWith(root + path.sep)) return res.writeHead(403).end();
    fs.readFile(file, (error, data) => {
        if (error) return res.writeHead(404).end();
        res.writeHead(200, {'Content-Type': ({'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json'})[path.extname(file)] || 'application/octet-stream',
            'Cross-Origin-Opener-Policy':'same-origin','Cross-Origin-Embedder-Policy':'require-corp'}).end(data);
    });
});
let browser;
(async () => {
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    browser = await chromium.launch({channel:'msedge', headless:true, args:['--disable-background-timer-throttling','--disable-renderer-backgrounding','--disable-backgrounding-occluded-windows']});
    const page = await browser.newPage({viewport:{width:1280,height:800}}), errors=[];
    page.on('pageerror', e => errors.push(e.message));
    page.on('console',m=>{if(m.type()==='error' && /render|ReferenceError|TypeError|INVALID_OPERATION/i.test(m.text())) errors.push(m.text().slice(0,500));});
    await page.goto(`http://127.0.0.1:${server.address().port}/index.html`);
    const fixture = process.argv[2] || '200000-1000.json', tag = process.env.LOD_TAG || 'current';
    await page.evaluate(async fixture => {
        applyMainMenuSettingsSnapshot(await (await fetch('tests/' + fixture)).json());
        const now=Date.now; Date.now=()=>1790000000000;
        try { startSoloGame(); } finally { Date.now=now; }
    }, fixture);
    await page.waitForFunction(()=>simClientStats().appliedTick>=10, {}, {timeout:240000});
    const setup=await page.evaluate(()=>{
        setRenderDimensionMode('3d');
        const R=renderer3dInstance, gl=R.gl, ext=gl.getExtension('WEBGL_debug_renderer_info');
        const build=build3DFrameData;
        window.build3DFrameData=function(...args){const t=performance.now(), s=build(...args); window.__lodLast=s; window.__lodBuild.push(performance.now()-t); return s;};
        window.__lodBuild=[];
        return {units:units.length,structures:_pageTables.s.n,map:GRID_W,viewport:{width:viewW,height:viewH},gpu:ext?gl.getParameter(ext.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER),graphics:graphicsOptions};
    });
    console.log('SETUP',JSON.stringify(setup));
    const cases=[];
    for (const zoom of [.025,.6,1.5,3]) cases.push({mode:'2d',zoom,pitch:1.35,yaw:0});
    for (const zoom of [.025,.6,1.5,3]) for (const [pitch,yaw] of [[1.35,0],[.55,0],[.55,Math.PI/2],[.8,Math.PI]]) cases.push({mode:'3d',zoom,pitch,yaw});
    if (process.env.LOD_PROFILE) cases.splice(0,cases.length,{mode:'3d',zoom:1.5,pitch:.38,yaw:Math.PI/2});
    if (process.env.LOD_EXTENDED) {
        cases.push({mode:'2d',zoom:8,pitch:1.35,yaw:0},{mode:'2d',zoom:15,pitch:1.35,yaw:0});
        for (const zoom of [1.5,3,8,15]) for (const yaw of [0,Math.PI/2,Math.PI,3*Math.PI/2]) cases.push({mode:'3d',zoom,pitch:.38,yaw});
    }
    const results=[];
    for (const c of cases) {
        await page.evaluate(c=>{
            setRenderDimensionMode(c.mode);
            camera.zoom=c.zoom;
            // Stay over a populated army rather than the empty map centre.
            const u=units[Math.floor(units.length/4)];
            camera.x=u.x-viewW/camera.zoom/2; camera.y=u.y-viewH/camera.zoom/2;
            renderer3dInstance.orbitPitch=c.pitch;renderer3dInstance.orbitYaw=c.yaw;
        },c);
        await page.waitForTimeout(Number(process.env.LOD_WARMUP)||3000);
        let cdp;
        if (process.env.LOD_PROFILE) { cdp=await page.context().newCDPSession(page);await cdp.send('Profiler.enable');await cdp.send('Profiler.start'); }
        const result=await page.evaluate(async()=>{
            window.__lodBuild=[]; const gaps=[]; let last=performance.now(),start=last;
            await new Promise(resolve=>{const frame=now=>{gaps.push(now-last);last=now;if(now-start<2200)requestAnimationFrame(frame);else resolve();};requestAnimationFrame(frame);});
            const s=window.__lodLast, R=renderer3dInstance, slots=s.scaleLayers||typeof _detailSlots==='undefined'?[]:_detailSlots;
            const visible=slots.filter(slot=>{const F=simClientCurrentUnitVis(),p=R.projectWorldToScreenDetailed(F.x[slot]/TILE,0,F.y[slot]/TILE);return p&&p.x>=0&&p.y>=0&&p.x<viewW&&p.y<viewH&&p.ndcZ>=-1&&p.ndcZ<=1;}).length;
            gaps.sort((a,b)=>a-b);const build=window.__lodBuild;
            return {fps:1000*gaps.length/(last-start),p95:gaps[Math.floor(gaps.length*.95)],buildMs:build.reduce((a,b)=>a+b,0)/build.length,
                detail:slots.length,visibleDetail:visible,scale:!!s.scaleLayers,flat:!!s.flat2d,objects:s.objects.length,flatCount:s.flatBatch?.count,
                modelCount:R.unitLayerDraws?.reduce((n,d)=>n+d.count,0)||0,units:units.length,tps:_tpsDisplay,unitLayerStats:renderer3dUnitLayerStats};
        });
        results.push({...c,...result});console.log(JSON.stringify(results[results.length-1]));
        if(cdp) {const {profile}=await cdp.send('Profiler.stop');fs.writeFileSync(path.join(__dirname,`lod-${tag}.cpuprofile`),JSON.stringify(profile));const times=new Map();for(let i=0;i<(profile.samples||[]).length;i++)times.set(profile.samples[i],(times.get(profile.samples[i])||0)+profile.timeDeltas[i]); console.log(profile.nodes.map(n=>({fn:n.callFrame.functionName,line:n.callFrame.lineNumber+1,ms:(times.get(n.id)||0)/1000})).sort((a,b)=>b.ms-a.ms).slice(0,30));}
        if (c.zoom===3 && (c.mode==='2d'||c.pitch===.55&&c.yaw===0) || c.zoom===15&&c.pitch===.38&&c.yaw===0) await page.screenshot({path:path.join(__dirname,`lod-${tag}-${c.mode}-${c.zoom}.png`)});
    }
    fs.writeFileSync(path.join(__dirname,`lod-${tag}.json`),JSON.stringify({fixture,setup,results,errors},null,2));
    if(errors.length) throw new Error(errors.join('\n'));
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(async()=>{if(browser)await browser.close();server.close();});
