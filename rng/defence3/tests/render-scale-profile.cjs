// Real browser, real fixture, real simulation. Run serially, never with tests.
// NODE_PATH must contain playwright. BASELINE optionally serves a Git revision.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const {execFileSync} = require('node:child_process');
const {chromium} = require('playwright');
const root = path.resolve(__dirname, '..');
const ref = process.env.BASELINE;
const prefix = execFileSync('git',['rev-parse','--show-prefix'],{cwd:root,encoding:'utf8'}).trim();
const cache = new Map();
const mime = {'.js':'text/javascript','.html':'text/html','.css':'text/css','.json':'application/json','.png':'image/png','.svg':'image/svg+xml'};
const server = http.createServer((req,res)=>{
    let name = decodeURIComponent(new URL(req.url,'http://localhost').pathname).replace(/^\//,'') || 'index.html';
    const file = path.resolve(root,name);
    if (!file.startsWith(root+path.sep)) {res.writeHead(403).end();return;}
    try {
        let data;
        if (ref && (name.startsWith('src/') || name==='index.html')) {
            if (!cache.has(name)) cache.set(name,execFileSync('git',['show',ref+':'+prefix+name],{cwd:root,maxBuffer:16e6}));
            data=cache.get(name);
        } else data=fs.readFileSync(file);
        res.writeHead(200,{'Content-Type':mime[path.extname(file)]||'application/octet-stream','Cache-Control':'no-store',
            'Cross-Origin-Opener-Policy':'same-origin','Cross-Origin-Embedder-Policy':'require-corp'});res.end(data);
    }catch {res.writeHead(404).end();}
});
const sleep = ms=>new Promise(r=>setTimeout(r,ms));
let browser;
(async()=>{
    await new Promise(r=>server.listen(0,'127.0.0.1',r));
    browser = await chromium.launch({channel:'msedge',headless:true,args:['--disable-background-timer-throttling','--disable-renderer-backgrounding','--disable-backgrounding-occluded-windows']});
    const page = await browser.newPage({viewport:{width:1920,height:1080},deviceScaleFactor:1});
    const errors=[];page.on('pageerror',e=>errors.push(e.message));
    page.on('console',m=>{if(m.type()==='error')errors.push(m.text().slice(0,300));});
    await page.goto(`http://127.0.0.1:${server.address().port}/index.html`,{waitUntil:'load',timeout:120000});
    await page.waitForTimeout(1000);
    const fixture=process.argv[2]||'100000-1000.json';
    const setup=await page.evaluate(async fixture=>{
        const data=await(await fetch('tests/'+fixture)).json();
        applyMainMenuSettingsSnapshot(data);
        const now=Date.now; Date.now=()=>1790000000000;
        try { startSoloGame(); } finally { Date.now=now; }
        return {units:units.length,towers:towers.length,barracks:barracks.length,spawners:collectorSpawners.length,map:GRID_W};
    },fixture);
    console.log('SETUP',JSON.stringify(setup));
    await page.waitForFunction(()=>simClientStats().appliedTick >= 10,{},{timeout:240000});
    const cdp=await page.context().newCDPSession(page);
    await cdp.send('Profiler.enable');await cdp.send('Profiler.setSamplingInterval',{interval:500});
    const info=await page.evaluate(()=>{
        setRenderDimensionMode('3d');
        camera.zoom=Math.min(viewW/WORLD_W,viewH/WORLD_H);
        camera.x=WORLD_W/2-viewW/camera.zoom/2;camera.y=WORLD_H/2-viewH/camera.zoom/2;
        renderer3dInstance.orbitPitch=1.35;
        const gl=renderer3dInstance.gl,ext=gl.getExtension('WEBGL_debug_renderer_info');
        window.__measure={};
        for(const name of ['processRenderFrame','build3DFrameData','drawMinimap','updateHUD','updateControlGroupBar','updateBottomBar','_simClientApplyFrame','_simClientApplyWorldFrame','_simClientPageTickWork','updateVisualVisibility','updateLocalVisibilityHistory','updateAudioReactiveState','rebuildVisibilityMaskCacheIfNeeded','sampleGameStats','commitStaticCaches']) {
            const fn=window[name];if(typeof fn!=='function')continue;
            window[name]=function(...args){const t=performance.now();try{return fn.apply(this,args);}finally{const s=window.__measure[name]||(window.__measure[name]={n:0,ms:0,max:0});const d=performance.now()-t;s.n++;s.ms+=d;s.max=Math.max(s.max,d);}};
        }
        const r=renderer3dInstance,fn=r.render;
        r.render=function(...args){const t=performance.now();try{return fn.apply(this,args);}finally{const s=window.__measure.gpuSubmit||(window.__measure.gpuSubmit={n:0,ms:0,max:0});const d=performance.now()-t;s.n++;s.ms+=d;s.max=Math.max(s.max,d);}};
        return {gpu:ext?gl.getParameter(ext.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER),zoom:camera.zoom,settings:graphicsOptions,sim:simClientStats(),start:performance.now(),tick:currentTick};
    });
    console.log('INFO',JSON.stringify(info));
    await cdp.send('Profiler.start');
    await sleep(Number(process.env.PROFILE_MS)||10000);
    const {profile}=await cdp.send('Profiler.stop');
    const results=await page.evaluate(()=>({phases:window.__measure,sim:simClientStats(),fps:_fpsDisplay,tps:_tpsDisplay,end:performance.now(),tick:currentTick,
        scale:typeof rendererScaleCache!=='undefined'&&rendererScaleCache?rendererScaleCache.layers.map(x=>({count:x.count,bytes:x.data.byteLength,upload:x.uploadBytes})):null}));
    const times=new Map();for(let i=0;i<(profile.samples||[]).length;i++)times.set(profile.samples[i],(times.get(profile.samples[i])||0)+profile.timeDeltas[i]);
    results.hot=profile.nodes.map(n=>({fn:n.callFrame.functionName,url:n.callFrame.url,line:n.callFrame.lineNumber+1,ms:(times.get(n.id)||0)/1000})).sort((a,b)=>b.ms-a.ms).slice(0,40);
    const output={ref:ref||'working-tree',fixture,setup,info,results,errors};
    const tag=process.env.PROFILE_TAG||'current';
    fs.writeFileSync(path.join(__dirname,'render-scale-'+tag+'.json'),JSON.stringify(output,null,2)+'\n');
    fs.writeFileSync(path.join(__dirname,'render-scale-'+tag+'.cpuprofile'),JSON.stringify(profile));
    await page.screenshot({path:path.join(__dirname,'render-scale-'+tag+'.png')});
    console.log(JSON.stringify(output,null,2));
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(async()=>{if(browser)await browser.close();server.close();});
