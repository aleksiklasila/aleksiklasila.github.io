'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const {chromium}=require('playwright');
const root=path.resolve(__dirname,'..');
const server=http.createServer((req,res)=>{
    const file=path.resolve(root,'.'+new URL(req.url,'http://localhost').pathname);
    if(!file.startsWith(root+path.sep))return res.writeHead(403).end();
    fs.readFile(file,(error,body)=>{
        if(error)return res.writeHead(404).end();
        res.writeHead(200,{'Content-Type':({'.html':'text/html','.js':'text/javascript','.css':'text/css'})[path.extname(file)]||'application/octet-stream','Cross-Origin-Opener-Policy':'same-origin','Cross-Origin-Embedder-Policy':'require-corp'}).end(body);
    });
});
let browser;
(async()=>{
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    browser=await chromium.launch({channel:'msedge',headless:true});
    const page=await browser.newPage();
    page.on('pageerror',error=>console.error('PAGE ERROR:',error.stack));
    await page.goto(`http://127.0.0.1:${server.address().port}/index.html`);
    await page.evaluate(()=>{
        window.bakeTest={};
        document.getElementById('cfg-mapsize').value='30';
        startingResourcesConfig={spawnCounts:{'unit:king':{1:1}},researchLevels:{}};
        const start=startGame;
        startGame=()=>{
            if(!renderer3dInstance.columnAtlas?.complete)throw Error('game started before baking completed');
            start();bakeTest.done=true;
        };
        window.addEventListener('unhandledrejection',event=>bakeTest.error=event.reason?.stack||String(event.reason));
    });
    await page.locator('#btn-play-offline').click();
    await page.locator('#menu-action-popover button',{hasText:'New'}).click();
    const deadline=Date.now()+240000;
    let status,sawProgress=false;
    do {
        await new Promise(resolve=>setTimeout(resolve,3000));
        status=await page.evaluate(()=>({ ...bakeTest,next:renderer3dInstance?.columnAtlas?.next,jobs:renderer3dInstance?.columnAtlas?.jobs,workerFailed:renderer3dInstance?.columnAtlas?.workerFailed,detail:document.getElementById('match-load-overlay-detail')?.textContent }));
        console.log(JSON.stringify(status));
        if(/Preparing model views.*\d+%/.test(status.detail))sawProgress=true;
        if(status.error)throw Error(status.error);
    }while(!status.done&&Date.now()<deadline);
    assert.ok(status.done,'full roster preparation finishes');
    assert.ok(sawProgress,'Play Offline displays progress when it joins the background menu bake');
    const result=await page.evaluate(()=>{
        const R=renderer3dInstance,A=R.columnAtlas;
        const expected=[...Object.keys(BASE_UNIT_STATS).flatMap(type=>['unit_'+type,'barrack_'+type]),...Object.keys(BASE_CARD_TYPES)];
        const missing=expected.filter(key=>!A.catalog.styles.some(style=>style.modelKey===key||style.type===key));
        const canvases=document.createElement.bind(document);
        document.createElement=tag=>{if(tag==='canvas')throw Error('late canvas bake');return canvases(tag);};
        try {
            for(let i=0;i<A.catalog.styles.length;i++)for(const color of A.palette.colors)R.columnModelPanel(A,i,color);
            _pageFrameStrings.push(...Object.keys(BASE_UNIT_STATS),...Object.keys(BASE_CARD_TYPES));
            R.disposeFrameColumns();
            const current=R.getColumnAtlas();
            return {missing,same:current===A,complete:A.complete,next:A.next,jobs:A.jobs,styles:A.catalog.styles.length};
        } finally {document.createElement=canvases;}
    });
    assert.deepEqual(result.missing,[]);
    assert.equal(result.same,true);assert.equal(result.complete,true);assert.equal(result.next,result.jobs);
    console.log('PASS: full roster baked before spawning, no late panel baking, and atlas survives reset.',result);
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(async()=>{await browser?.close();server.close();});
