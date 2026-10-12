'use strict';
// Deterministic long rows: full/medium/far meshes, then column miniatures.
// No simulation or gameplay mutation is needed to inspect the LOD boundaries.
const fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const {chromium}=require('playwright');
const root=path.resolve(__dirname,'..');
const output=process.env.LOD_OUTPUT_DIR||__dirname;fs.mkdirSync(output,{recursive:true});
const server=http.createServer((req,res)=>{
    const file=path.resolve(root,'.'+new URL(req.url,'http://localhost').pathname);
    if(!file.startsWith(root+path.sep))return res.writeHead(403).end();
    fs.readFile(file,(e,b)=>{if(e)return res.writeHead(404).end();res.writeHead(200,{'Content-Type':({'.html':'text/html','.js':'text/javascript','.css':'text/css'})[path.extname(file)]||'application/octet-stream'}).end(b);});
});
let browser;
(async()=>{
    await new Promise(r=>server.listen(0,'127.0.0.1',r));
    browser=await chromium.launch({channel:'msedge',headless:true});
    const page=await browser.newPage({viewport:{width:1440,height:960}}),errors=[];
    page.on('pageerror',e=>errors.push(e.message));
    page.on('console',m=>{if(m.type()==='error'&&/WebGL|shader|INVALID|TypeError/.test(m.text()))errors.push(m.text());});
    await page.goto(`http://127.0.0.1:${server.address().port}/index.html`);
    const checker=!!process.env.LOD_CHECKER;
    const setup=await page.evaluate(async(checker)=>{
        await prepareRendererLodAssets();
        document.body.innerHTML='';document.body.style.margin='0';
        const R=window.stripRenderer=renderer3dInstance;document.body.appendChild(R.canvas);
        renderer3dInstance=R;R.layerAlpha=1;R.layerFlyTime=0;R.setEnabled(true);R.setGraphicsOptions({aa:'msaa',shadows:'off',ao:'off',outline:false,bloom:false,grade:false,sharpen:false,resolution:1});
        R.canvas.style.cssText='display:block;position:fixed;left:0;top:0;width:1440px;height:960px';
        _pageFrameStrings.push(...new Set([...Object.keys(BASE_UNIT_STATS),...Object.keys(BASE_CARD_TYPES)]));
        const A=R.prepareColumnAtlas();
        const backgroundBake=!!A.gpuBaked;
        while(A.prepare){R.advanceColumnAtlas(A);await new Promise(r=>setTimeout(r,0));}
        if(!backgroundBake||A.workerFailed||!A.gpuBaked)throw Error('Atlas baking did not complete in the background worker');
        window.stripAtlas=A;
        const getKey=R.getFigureMeshKey.bind(R);
        R.getFigureMeshKey=o=>{const k=getKey(o);return o.forceFull&&k?k.replace(/:lod2?$/,''):k;};
        const styles=A.catalog.styles.filter(s=>s.unit||s.neutral||s.modelKey.startsWith('spawner_')
            ||s.modelKey.startsWith('barrack_')&&BASE_CARD_TYPES['barrack_'+s.type]
            ||s.modelKey.startsWith('tower_')&&BASE_CARD_TYPES[s.type]?.target==='wall'
            ||s.modelKey.startsWith('item_')&&!s.type.startsWith('barrack_'));
        // Group the complete roster into neighbouring strips for close views.
        const category=s=>s.unit?0:s.modelKey.startsWith('spawner_')?1:s.modelKey.startsWith('barrack_')?2:s.modelKey.startsWith('tower_')?3:4;
        styles.sort((a,b)=>category(a)-category(b));
        // Reference panels come from the production draw methods, independent
        // of the distant catalog: a shared approximation hid mismatches here.
        const exactPanels=new Map();
        const ownerColor=get2DRenderOwnerColor(0);
        for(const s of styles) {
            if(s.unit||s.neutral)continue;
            const entity={x:0,y:0,gx:0,gy:0,owner:0,type:s.type,unitType:s.type,level:1,stacks:1,manualStacks:1,
                spawnQueue:[],maxEnergy:0,angle:0,baseStats:BASE_CARD_TYPES[s.type],connectedLasers:[],laserState:0};
            const draw=s.modelKey.startsWith('barrack_')?g=>Barrack.prototype.draw.call(entity,g)
                :s.modelKey.startsWith('spawner_')?g=>CollectorSpawner.prototype.draw.call(entity,g)
                :s.modelKey.startsWith('item_')?g=>drawFloorItem(g,{owner:0,item:entity},-16,-16)
                :g=>Tower.prototype.draw.call(entity,g);
            exactPanels.set(s,_rasterize3DPanel('strip-'+s.modelKey,88/32,48,48,draw));
        }
        const panelErrors=[];
        for(const [s,exact] of exactPanels) {
            const middle=R.columnModelPanel(A,A.catalog.styles.indexOf(s),ownerColor);
            const a=exact.getContext('2d').getImageData(0,0,96,96).data,b=middle.getContext('2d').getImageData(0,0,96,96).data;
            let error=0;for(let i=0;i<a.length;i++)error+=Math.abs(a[i]-b[i]);
            panelErrors.push({type:s.modelKey,meanError:error/a.length});
            if(error/a.length>1)throw Error('Middle panel differs from production: '+JSON.stringify(panelErrors.at(-1)));
        }
        const title=document.createElement('div');title.style.cssText='position:fixed;left:14px;top:12px;color:white;background:#080e16dd;padding:8px;font:14px monospace;z-index:99';document.body.appendChild(title);
        window.stripDraw=(view,reference=false)=>{
            const {pitch,yaw}=view,copies=checker?625:300,n=styles.length*copies,structures={n,cap:n},unitFrame={n,cap:n};
            const focus=view.focus,center=focus?styles.findIndex(s=>s.modelKey===focus):(styles.length-1)/2;
            if(center<0)throw Error('Missing focus '+focus);
            const span=view.span||(checker?(focus?32:275):focus?16:styles.length*.95);
            const centerX=checker?(focus?20+(center%9)*28+12:140):20+center*1.05;
            const centerZ=checker?(focus?20+Math.floor(center/9)*28+16:125):focus?245:210;
            const snapshot={worldWidth:400,worldHeight:400,viewportWidth:1440,viewportHeight:960,
                camera:{centerX:centerX+(view.dx||0),centerZ:centerZ+(view.dz||0),visibleWidth:span,visibleHeight:span*2/3},flat2d:false};
            R.orbitPitch=pitch;R.orbitYaw=yaw;R.resize(1440,960);R.buildViewProjection(snapshot);
            viewW=1440;viewH=960;
            let closeSlots=null;
            if(checker&&!view.forceBands) {
                const structureScores=new Float32Array(n),unitScores=new Float32Array(n);
                for(let col=0;col<styles.length;col++)for(let row=0;row<copies;row++) {
                    const x=20+(col%9)*28+(row%25),z=20+Math.floor(col/9)*28+Math.floor(row/25),unit=styles[col].unit;
                    (unit?unitScores:structureScores)[col*copies+row]=_detailScore(x,z,unit?.55:.94,false,false,16);
                }
                closeSlots=new Set([..._detailPick(structureScores,600),..._detailPick(unitScores,600)]);
            }
            for(const F of [structures,unitFrame])for(const key of ['x','y','px','py','r','id','energy','flags','type','owner','facing','mode','vision','prate','amount','phase','alive','kind','utype','angle','gx','gy'])F[key]=new Float32Array(n);
            unitFrame.id.fill(-1);
            const C={units:unitFrame,structures,unitCandidates:[],detailMask:new Uint8Array(n),detailMaskS:new Uint8Array(n),detailMaskVersion:1,detailMaskVersionS:1,
                colors:Array(9).fill(ownerColor),fullVisibility:true,tile:32,alpha:1,lightNorm:1,visibilityVersion:1};
            const objects=[],middle=[];
            for(let col=0;col<styles.length;col++)for(let row=0;row<copies;row++){
                const i=col*copies+row,s=styles[col],units=!!s.unit,F=units?unitFrame:structures;
                const x=checker?20+(col%9)*28+(row%25):20+col*1.05,z=checker?20+Math.floor(col/9)*28+Math.floor(row/25):row*.9;
                const band=checker?Math.floor(row/25):row;
                const size=units?.55:.94,stats=units?BASE_UNIT_STATS[s.type]:BASE_CARD_TYPES[s.type],vision=stats?.visionRange||0;
                const kind=units?7:s.neutral?(s.type==='gold'?4:5):s.modelKey.startsWith('spawner')?2:s.modelKey.startsWith('barrack')?1:s.modelKey.startsWith('item')?3:0;
                F.x[i]=F.px[i]=x*32;F.y[i]=F.py[i]=z*32;F.gx[i]=Math.floor(x);F.gy[i]=Math.floor(z);
                F.type[i]=F.utype[i]=s.neutral?0:_pageFrameStrings.indexOf(s.type);F.kind[i]=kind;F.r[i]=size*32/2.2;
                if(s.neutral)F.amount[i]=s.modelKey.endsWith('_active')?1:0;
                F.alive[i]=1;F.id[i]=i;F.energy[i]=100;F.owner[i]=0;F.vision[i]=vision;F.angle[i]=Math.PI/2;
                // Hold: identical previous/current positions, no walk, attack,
                // production or idle-settling animation to hide a transition.
                if(reference||(closeSlots?closeSlots.has(i):band>=(checker?20:264))){
                    (units?C.detailMask:C.detailMaskS)[i]=255;
                    let sy=size*s.scaleY;if(units&&!s.mounted)sy=Math.max(.48*s.scaleX,sy);
                    if(!s.preserveModelHeight&&!s.isFlying&&!s.mounted&&vision>0)sy*=Math.max(.18,vision*AREA_UNIT_TILE_EQUIVALENT/5);
                    objects.push({modelKey:s.modelKey,weaponType:s.weaponType,isFlying:s.isFlying,isWorker:s.isWorker,x,z,y:s.isFlying?.3:0,
                        scaleX:size*s.scaleX,scaleZ:size*s.scaleX,scaleY:sy,rotationY:0,baseTint:ownerColor,tint:ownerColor,baseSideTint:s.color,sideTint:s.color,
                        lightLevel:1,alpha:1,topTextureKey:s.modelKey,topTextureCanvas:exactPanels.get(s)||A.panels[A.catalog.styles.indexOf(s)],statusTextureCanvas:s.statusTextureCanvas,forceFull:reference});
                } else if(closeSlots||band>=(checker?16:232)) {
                    if(units)C.unitCandidates.push({_s:i});else middle.push(i);
                }
            }
            _structureDetailCandidates=()=>middle;
            snapshot.objects=objects;snapshot.columnLayers=C;
            R.orbitPitch=pitch;R.orbitYaw=yaw;R.render(snapshot);
            const gl=R.gl,w=R.canvas.width,h=R.canvas.height,pixels=new Uint8Array(w*h*4);
            gl.bindFramebuffer(gl.FRAMEBUFFER,null);gl.readPixels(0,0,w,h,gl.RGBA,gl.UNSIGNED_BYTE,pixels);
            let visible=0;for(let i=0;i<pixels.length;i+=4)if(Math.max(pixels[i],pixels[i+1],pixels[i+2])>40)visible++;
            title.textContent=`${view.name} | ${styles.length} types × ${checker?'25×25':300} = ${n.toLocaleString()} stationary objects | ${reference?'full-detail reference':'LOD transitions'}${focus?' | focus: '+focus:''}`;
            return {glError:gl.getError(),coverage:visible/(w*h),middle:R.columnModels?.count,objects:objects.length,atlasReady:A.next};
        };
        return {styles:A.catalog.styles.length,backgroundBake,atlasPixels:A.grid*32,rows:styles.map(s=>s.modelKey),copiesPerType:checker?625:300,total:styles.length*(checker?625:300),panelErrors};
    },checker);
    console.log('SETUP',JSON.stringify(setup));
    const results=[];
    const prepared=await page.evaluate(()=>({next:stripAtlas.next,revision:stripAtlas.revision,gpuBaked:stripAtlas.gpuBaked}));
    const views=[
        {name:'all-low',pitch:.16,yaw:0}, {name:'all-diagonal-low',pitch:.16,yaw:.65},
        {name:'all-diagonal',pitch:.45,yaw:.65}, {name:'all-overhead',pitch:1.2,yaw:.35},
        {name:'towers-low',pitch:.16,yaw:0,focus:'tower_sniper'},
        {name:'towers-diagonal',pitch:.20,yaw:.65,focus:'tower_sniper'},
        {name:'workshops-diagonal',pitch:.20,yaw:.65,focus:'spawner_builder_spawner'},
        {name:'barracks-diagonal',pitch:.20,yaw:.65,focus:'barrack_norm'},
        {name:'houses-low',pitch:.12,yaw:0,focus:'item_house'},
        {name:'houses-diagonal',pitch:.20,yaw:.65,focus:'item_house'},
        {name:'units-diagonal',pitch:.20,yaw:.65,focus:'unit_water_resistant'}
    ];
    if(checker)views.splice(0,views.length,
        {name:'checker-overview',pitch:.65,yaw:.52},
        ...['item_house','barrack_norm','spawner_builder_spawner','tower_sniper','tower_watch_tower','tower_elements','unit_fire_resistant'].map(focus=>({name:'checker-'+focus,pitch:.52,yaw:.52,focus})),
        {name:'checker-houses-low',pitch:.16,yaw:.52,focus:'item_house'},
        {name:'checker-houses-overhead',pitch:1.5,yaw:.52,focus:'item_house'},
        {name:'checker-houses-pan',pitch:.52,yaw:.52,focus:'item_house',dx:6,dz:6},
        {name:'checker-mines',pitch:.52,yaw:.52,focus:'gold_mine_active'},
        {name:'checker-15-wheel-steps',pitch:.52,yaw:.52,focus:'item_house',span:1440/(32*(15/1.2**15))},
        {name:'checker-forced-boundaries',pitch:.52,yaw:.52,focus:'item_house',forceBands:true});
    for(const view of views)for(const reference of [false,true]){
        const result=await page.evaluate(({view,reference})=>stripDraw(view,reference),{view,reference});
        if(result.glError)errors.push('WebGL '+result.glError);
        if(result.coverage<.02)errors.push('Missing models in '+JSON.stringify({view,reference}));
        results.push({...view,reference,...result});console.log(JSON.stringify(results.at(-1)));
        await page.screenshot({path:path.join(output,`lod-strip-${view.name}-${reference?'reference':'actual'}.png`)});
    }
    // Continuous tilt and yaw must reuse the atlas and keep all shaders valid.
    for(let i=0;i<24;i++){
        const view=checker?{name:i<12?'30-degree camera sweep':'overhead camera sweep',pitch:i<12?.52:1.5,yaw:.52+(i%12-6)*.035,
            focus:'item_house',span:1440/(32*(15/1.2**15)),dx:(i%12-6)*1.2,dz:(i%12-6)*.5}
            :{name:'camera sweep',pitch:.16+i*.0225,yaw:i*.02,focus:'tower_sniper'};
        const result=await page.evaluate(view=>stripDraw(view),view);
        if(result.glError)errors.push('WebGL during motion '+result.glError);
        if(checker&&[0,5,11,12,17,23].includes(i))await page.screenshot({path:path.join(output,`lod-checker-sweep-${i}.png`)});
    }
    const after=await page.evaluate(()=>({next:stripAtlas.next,revision:stripAtlas.revision,gpuBaked:stripAtlas.gpuBaked}));
    if(JSON.stringify(after)!==JSON.stringify(prepared))errors.push('Camera motion changed prepared atlas');
    fs.writeFileSync(path.join(output,checker?'lod-checker-results.json':'lod-strip-results.json'),JSON.stringify({setup,results,errors},null,2));
    if(errors.length)throw Error(errors.join('\n'));
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(async()=>{if(browser)await browser.close();server.close();});
