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
    const page = await browser.newPage({viewport:{width:Number(process.env.LOD_WIDTH)||1280,height:Number(process.env.LOD_HEIGHT)||800}}), errors=[];
    page.on('pageerror', e => { errors.push(e.message); console.error('PAGE ERROR',e.message); });
    page.on('console',m=>{if(m.type()==='error' && /render|ReferenceError|TypeError|INVALID_OPERATION/i.test(m.text())) errors.push(m.text().slice(0,500));});
    await page.goto(`http://127.0.0.1:${server.address().port}/index.html`);
    console.log('LOADED');
    const fixture = process.argv[2] || '200000-1000.json', tag = process.env.LOD_TAG || 'current';
    await page.evaluate(async ({fixture,million,population}) => {
        const data=await (await fetch('tests/' + fixture)).json();
        if (million || population) {
            const groups=Object.entries(data.startingResources.spawnCounts).filter(([k])=>k.startsWith('unit:')).map(([,v])=>v);
            const total=groups.reduce((n,g)=>n+Object.values(g).reduce((a,b)=>a+b,0),0);let count=0;
            const target=population||500000;
            for(const g of groups)for(const k of Object.keys(g)){g[k]=Math.floor(g[k]*target/total);count+=g[k];}
            groups[0][Object.keys(groups[0])[0]]+=target-count;
            data.lobby.numbers['cfg-max-pop']=target;
        }
        applyMainMenuSettingsSnapshot(data);
        const now=Date.now; Date.now=()=>1790000000000;
        try { startSoloGame(); } finally { Date.now=now; }
    }, {fixture,million:!!process.env.LOD_MILLION,population:Number(process.env.LOD_POP_PER_TEAM)||0});
    console.log('STARTED');
    await page.waitForFunction(()=>simClientStats().appliedTick>=10, {}, {timeout:240000});
    const setup=await page.evaluate(()=>{
        setRenderDimensionMode('3d');
        const R=renderer3dInstance, gl=R.gl, ext=gl.getExtension('WEBGL_debug_renderer_info');
        const build=build3DFrameData;
        window.build3DFrameData=function(...args){const t=performance.now(), s=build(...args); window.__lodLast=s; window.__lodBuild.push(performance.now()-t); return s;};
        window.__lodBuild=[];
        const drawColumns=R.drawFrameColumns;
        window.__lodColumns=[];
        R.drawFrameColumns=function(...args){const t=performance.now(), result=drawColumns.apply(this,args);window.__lodColumns.push(performance.now()-t);return result;};
        window.__lodTimings={};window.__lodGpu=[];window.__lodRender=[];
        for(const name of ['_simClientRebaseFrame','_simClientApplyWorld','drawMinimap','updateBottomBar','build3DOverlayData','getChunkRenderView','_unitDetailSplit','_structureDetailSplit']) {
            const fn=window[name];if(typeof fn!=='function')continue;
            window[name]=function(...args){const t=performance.now(),result=fn.apply(this,args);(window.__lodTimings[name] ||= []).push(performance.now()-t);return result;};
        }
        const timer=gl.getExtension('EXT_disjoint_timer_query_webgl2'),pending=[],render=R.render;let serial=0;
        R.render=function(...args){
            if(timer)while(pending.length&&gl.getQueryParameter(pending[0],gl.QUERY_RESULT_AVAILABLE)) {
                const q=pending.shift();if(!gl.getParameter(timer.GPU_DISJOINT_EXT))window.__lodGpu.push(gl.getQueryParameter(q,gl.QUERY_RESULT)/1e6);gl.deleteQuery(q);
            }
            const q=timer&&++serial%4===0&&pending.length<8?gl.createQuery():null;
            if(q)gl.beginQuery(timer.TIME_ELAPSED_EXT,q);
            const t=performance.now(),result=render.apply(this,args);window.__lodRender.push(performance.now()-t);
            if(q){gl.endQuery(timer.TIME_ELAPSED_EXT);pending.push(q);}return result;
        };
        return {units:units.length,structures:_pageTables.s.n,map:GRID_W,viewport:{width:viewW,height:viewH},gpu:ext?gl.getParameter(ext.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER),graphics:graphicsOptions};
    });
    console.log('SETUP',JSON.stringify(setup));
    if(process.env.LOD_RETIRE) await page.evaluate(()=>simClientRequest('debugEval',{expr:`(() => { const tick=gameTick; self.gameTick=function(...args){const u=units[units.length-1];if(u)u.energy=0;return tick.apply(this,args);}; })()`}));
    const cases=[];
    for (const zoom of [.025,.6,1.5,3]) cases.push({mode:'2d',zoom,pitch:1.35,yaw:0});
    for (const zoom of [.025,.6,1.5,3]) for (const [pitch,yaw] of [[1.35,0],[.55,0],[.55,Math.PI/2],[.8,Math.PI]]) cases.push({mode:'3d',zoom,pitch,yaw});
    if (process.env.LOD_PROFILE) cases.splice(0,cases.length,{mode:'3d',zoom:1.5,pitch:.38,yaw:Math.PI/2});
    if (process.env.LOD_EXTENDED) {
        cases.push({mode:'2d',zoom:8,pitch:1.35,yaw:0},{mode:'2d',zoom:15,pitch:1.35,yaw:0});
        for (const zoom of [1.5,3,8,15]) for (const yaw of [0,Math.PI/2,Math.PI,3*Math.PI/2]) cases.push({mode:'3d',zoom,pitch:.38,yaw});
    }
    if(process.env.LOD_QUICK) {
        cases.splice(0,cases.length,...[.025,.6,3,15].map(zoom=>({mode:'2d',zoom,pitch:1.35,yaw:0})),{mode:'3d',zoom:.025,pitch:1.35,yaw:0},{mode:'3d',zoom:.6,pitch:1.35,yaw:0});
        for(const zoom of [3,15])for(const yaw of [0,Math.PI/2,Math.PI,3*Math.PI/2])cases.push({mode:'3d',zoom,pitch:.38,yaw});
    }
    if (process.env.LOD_MILLION) cases.splice(0,cases.length,
        {mode:'2d',zoom:.025,pitch:1.35,yaw:0},{mode:'2d',zoom:1.5,pitch:1.35,yaw:0},{mode:'2d',zoom:15,pitch:1.35,yaw:0},
        {mode:'3d',zoom:.025,pitch:1.35,yaw:0},{mode:'3d',zoom:3,pitch:.38,yaw:0},{mode:'3d',zoom:15,pitch:.38,yaw:Math.PI/2});
    if(process.env.LOD_MOTION) cases.push({mode:'2d',zoom:3,pitch:1.35,yaw:0,motion:true},{mode:'3d',zoom:3,pitch:.38,yaw:0,motion:true});
    if(process.env.LOD_TRANSITIONS) cases.splice(0,cases.length,
        ...['2d','3d'].flatMap(mode=>[.15,.3,.6,1,1.5,3].map(zoom=>({mode,zoom,pitch:mode==='2d'?1.35:.55,yaw:0}))));
    if(process.env.LOD_STABILITY) cases.splice(0,cases.length,
        ...[1.5,3,8].map(zoom=>({mode:'3d',zoom,pitch:.55,yaw:0,motion:true})),
        {mode:'3d',zoom:.6,pitch:1.35,yaw:0,motion:true});
    if(process.env.LOD_CASE) cases.splice(0,cases.length,...cases.filter(c=>c.zoom===Number(process.env.LOD_CASE)));
    if(process.env.LOD_ZOOM) cases.splice(0,cases.length,...['2d','3d'].flatMap(mode=>['msaa','off'].map(aa=>
        ({mode,aa,zoom:1.5,pitch:.55,yaw:0,motion:true,zoomMotion:true}))));
    const results=[];
    for (const c of cases) {
        await page.evaluate(c=>{
            setRenderDimensionMode(c.mode);
            if(c.aa) graphicsOptions={...graphicsOptions,aa:c.aa};
            camera.zoom=c.zoom;
            // Stay over a populated army rather than the empty map centre.
            const u=units[Math.floor(units.length/4)];
            camera.x=u.x-viewW/camera.zoom/2; camera.y=u.y-viewH/camera.zoom/2;
            renderer3dInstance.orbitPitch=c.pitch;renderer3dInstance.orbitYaw=c.yaw;
        },c);
        await page.waitForTimeout(Number(process.env.LOD_WARMUP)||3000);
        let cdp;
        if (process.env.LOD_PROFILE) { cdp=await page.context().newCDPSession(page);await cdp.send('Profiler.enable');await cdp.send('Profiler.start'); }
        const result=await page.evaluate(async c=>{
            window.__lodBuild=[];window.__lodColumns=[];window.__lodTimings={};window.__lodGpu=[];window.__lodRender=[]; const gaps=[]; let last=performance.now(),start=last;
            await new Promise(resolve=>{const frame=now=>{gaps.push(now-last);last=now;
                if(c.motion){if(c.mode==='3d')renderer3dInstance.orbitYaw=c.yaw+(now-start)*.0004;else camera.x+=.5;}
                if(c.zoomMotion)camera.zoom=c.zoom*(1+.45*Math.sin((now-start)*.004));
                if(now-start<2200)requestAnimationFrame(frame);else resolve();};requestAnimationFrame(frame);});
            const s=window.__lodLast, R=renderer3dInstance, slots=s.scaleLayers||typeof _detailSlots==='undefined'?[]:_detailSlots;
            const visible=slots.filter(slot=>{const F=simClientCurrentUnitVis(),p=R.projectWorldToScreenDetailed(F.x[slot]/TILE,0,F.y[slot]/TILE);return p&&p.x>=0&&p.y>=0&&p.x<viewW&&p.y<viewH&&p.ndcZ>=-1&&p.ndcZ<=1;}).length;
            gaps.sort((a,b)=>a-b);const build=window.__lodBuild;
            return {fps:1000*gaps.length/(last-start),p95:gaps[Math.floor(gaps.length*.95)],buildMs:build.reduce((a,b)=>a+b,0)/build.length,
                columnMs:window.__lodColumns.reduce((a,b)=>a+b,0)/window.__lodColumns.length,
                renderCpuMs:window.__lodRender.reduce((a,b)=>a+b,0)/window.__lodRender.length,
                gpuMs:window.__lodGpu.length?window.__lodGpu.reduce((a,b)=>a+b,0)/window.__lodGpu.length:null,
                timings:Object.fromEntries(Object.entries(window.__lodTimings).map(([k,v])=>[k,{calls:v.length,mean:v.reduce((a,b)=>a+b,0)/v.length,total:v.reduce((a,b)=>a+b,0)}])),
                glError:R.gl.getError(),
                detail:slots.length,visibleDetail:visible,scale:!!s.scaleLayers,flat:!!s.flat2d,objects:s.objects.length,flatCount:s.flatBatch?.count,
                modelCount:s.flat2d?0:R.unitLayerDraws?.reduce((n,d)=>n+d.count,0)||0,
                meshLods:s.flat2d?null:R.unitLayerDraws?.reduce((n,d)=>{const level=d.kind?.endsWith(':lod2')?'far':d.kind?.endsWith(':lod')?'medium':'full';n[level]=(n[level]||0)+d.count;return n;},{}),
                units:units.length,tps:_tpsDisplay,unitLayerStats:renderer3dUnitLayerStats};
        },c);
        results.push({...c,...result});console.log(JSON.stringify(results[results.length-1]));
        if(result.glError) errors.push(`WebGL error ${result.glError} in ${JSON.stringify(c)}`);
        if(cdp) {const {profile}=await cdp.send('Profiler.stop');fs.writeFileSync(path.join(__dirname,`lod-${tag}.cpuprofile`),JSON.stringify(profile));const times=new Map();for(let i=0;i<(profile.samples||[]).length;i++)times.set(profile.samples[i],(times.get(profile.samples[i])||0)+profile.timeDeltas[i]); console.log(profile.nodes.map(n=>({fn:n.callFrame.functionName,line:n.callFrame.lineNumber+1,ms:(times.get(n.id)||0)/1000})).sort((a,b)=>b.ms-a.ms).slice(0,30));}
        if (process.env.LOD_STABILITY || process.env.LOD_TRANSITIONS || c.zoom===3 && (c.mode==='2d'||c.pitch===.55&&c.yaw===0) || c.zoom===15&&c.pitch===.38&&c.yaw===0) await page.screenshot({path:path.join(__dirname,`lod-${tag}-${c.mode}-${c.zoom}.png`)});
    }
    fs.writeFileSync(path.join(__dirname,`lod-${tag}.json`),JSON.stringify({fixture,setup,results,errors},null,2));
    if(errors.length) throw new Error(errors.join('\n'));
    if(process.env.LOD_MIN_FPS && results.some(r=>r.fps<Number(process.env.LOD_MIN_FPS)))
        throw new Error(`FPS below ${process.env.LOD_MIN_FPS}: `+JSON.stringify(results.filter(r=>r.fps<Number(process.env.LOD_MIN_FPS))));
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(async()=>{if(browser)await browser.close();server.close();});
