'use strict';
// Deterministic long rows: full/medium/far meshes, then column miniatures.
// No simulation or gameplay mutation is needed to inspect the LOD boundaries.
const fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const {chromium}=require('playwright');
const root=path.resolve(__dirname,'..');
const output=process.env.LOD_OUTPUT_DIR||__dirname;fs.mkdirSync(output,{recursive:true});
const server=http.createServer((req,res)=>{
    let file=path.resolve(root,'.'+new URL(req.url,'http://localhost').pathname);
    if(!file.startsWith(root+path.sep))return res.writeHead(403).end();
    if(process.env.LOD_BASELINE_DIR&&['renderer.js','renderer3d.js','renderer3d-lod-worker.js'].includes(path.basename(file)))file=path.join(process.env.LOD_BASELINE_DIR,path.basename(file));
    fs.readFile(file,(e,b)=>{if(e)return res.writeHead(404).end();res.writeHead(200,{'Content-Type':({'.html':'text/html','.js':'text/javascript','.css':'text/css'})[path.extname(file)]||'application/octet-stream'}).end(b);});
});
let browser;
(async()=>{
    await new Promise(r=>server.listen(0,'127.0.0.1',r));
    browser=await chromium.launch({channel:'msedge',headless:true});
    const page=await browser.newPage({viewport:{width:1440,height:960}}),errors=[];
    if(process.env.LOD_UPLOAD_AUDIT) {
        console.log(await page.evaluate(()=>{
            const gl=document.createElement('canvas').getContext('webgl2'),t=gl.createTexture(),f=gl.createFramebuffer(),out=[];
            gl.bindTexture(gl.TEXTURE_2D,t);gl.texStorage2D(gl.TEXTURE_2D,1,gl.RGBA8,1,1);
            gl.bindFramebuffer(gl.FRAMEBUFFER,f);gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,t,0);
            for(const premult of [false,true]) {
                gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL,premult);
                gl.texSubImage2D(gl.TEXTURE_2D,0,0,0,1,1,gl.RGBA,gl.UNSIGNED_BYTE,new Uint8Array([100,50,25,128]));
                const p=new Uint8Array(4);gl.readPixels(0,0,1,1,gl.RGBA,gl.UNSIGNED_BYTE,p);out.push({premult,pixels:[...p],error:gl.getError()});
            }
            return out;
        }));return;
    }
    page.on('pageerror',e=>errors.push(e.message));
    page.on('console',m=>{if(m.type()==='error'&&/WebGL|shader|INVALID|TypeError/.test(m.text()))errors.push(m.text());});
    await page.goto(`http://127.0.0.1:${server.address().port}/index.html`);
    const checker=!!process.env.LOD_CHECKER,diagonal=!!process.env.LOD_DIAGONAL,wide=!!process.env.LOD_WIDE,graphics=process.env.LOD_GRAPHICS,aa=process.env.LOD_AA;
    const setup=await page.evaluate(async({checker,diagonal,wide,graphics,aa,baseline})=>{
        await prepareRendererLodAssets();
        document.body.innerHTML='';document.body.style.margin='0';
        const R=window.stripRenderer=renderer3dInstance;document.body.appendChild(R.canvas);
        renderer3dInstance=R;R.layerAlpha=1;R.layerFlyTime=0;R.setEnabled(true);R.setGraphicsOptions({aa:'msaa',shadows:'off',ao:'off',outline:false,bloom:false,grade:false,sharpen:false,resolution:1});
        if(graphics)R.setGraphicsOptions(GRAPHICS_PRESETS[graphics]);
        if(aa)R.setGraphicsOptions({...R.graphicsOptions,aa});
        R.canvas.style.cssText='display:block;position:fixed;left:0;top:0;width:1440px;height:960px';
        _pageFrameStrings.push(...new Set([...Object.keys(BASE_UNIT_STATS),...Object.keys(BASE_CARD_TYPES)]));
        const A=R.prepareColumnAtlas();
        const backgroundBake=!!A.gpuBaked;
        while(A.prepare){R.advanceColumnAtlas(A);await new Promise(r=>setTimeout(r,0));}
        if(!backgroundBake||A.workerFailed||!A.gpuBaked)throw Error('Atlas baking did not complete in the background worker');
        window.stripAtlas=A;
        const getKey=R.getFigureMeshKey.bind(R);
        R.getFigureMeshKey=o=>{const k=getKey(o),base=k?.replace(/:lod2?$/,'');return window.stripMeshStage&&window.stripMeshStage!=='image'&&base?base+({full:'',lod1:':lod',lod2:':lod2'}[window.stripMeshStage]):o.forceFull&&k?base:k;};
        const styles=A.catalog.styles.filter(s=>s.unit||s.neutral||s.modelKey.startsWith('spawner_')
            ||s.modelKey.startsWith('barrack_')&&BASE_CARD_TYPES['barrack_'+s.type]
            ||s.modelKey.startsWith('tower_')&&BASE_CARD_TYPES[s.type]?.target==='wall'
            ||s.modelKey.startsWith('item_')&&!s.type.startsWith('barrack_'));
        // Group the complete roster into neighbouring strips for close views.
        const category=s=>s.unit?0:s.modelKey.startsWith('spawner_')?1:s.modelKey.startsWith('barrack_')?2:s.modelKey.startsWith('tower_')?3:4;
        styles.sort((a,b)=>category(a)-category(b));
        if(diagonal) {
            const chosen=['tower_sniper','tower_watch_tower','tower_elements','tower_fire','item_house','spawner_builder_spawner','barrack_norm','unit_norm','unit_snake','unit_laser_resistant','item_water_puddle','item_poison_puddle','item_ice_patch','item_lava'];
            styles.splice(0,styles.length,...chosen.map(key=>styles.find(s=>s.modelKey===key)).filter(Boolean));
        }
        const position=(col,row)=>wide?{x:20+col*18+row%15,z:20+Math.floor(row/15)}:diagonal?{x:20+col*7+row%4+Math.floor(row/4)*.35,z:20+Math.floor(row/4)}
            :checker?{x:20+(col%9)*28+(row%25),z:20+Math.floor(col/9)*28+Math.floor(row/25)}:{x:20+col*1.05,z:row*.9};
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
            const native=A.panels[A.catalog.styles.indexOf(s)],white=R.columnModelPanel(A,A.catalog.styles.indexOf(s),A.palette.colors[0]);
            const p=native.getContext('2d').getImageData(0,0,96,96).data,q=white.getContext('2d').getImageData(0,0,96,96).data;
            if(!baseline&&(native.width!==96||p.some((v,i)=>v!==q[i])))throw Error('Bake panel differs from the live material: '+s.modelKey);
        }
        const title=document.createElement('div');title.style.cssText='position:fixed;left:14px;top:12px;color:white;background:#080e16dd;padding:8px;font:14px monospace;z-index:99';document.body.appendChild(title);
        window.stripDraw=(view,reference=false)=>{
            window.stripMeshStage=view.meshStage;
            for(const atlas of [A,A.animation])for(const name of ['color']) {
                R.gl.bindTexture(R.gl.TEXTURE_2D_ARRAY,atlas[name]);
                R.gl.texParameteri(R.gl.TEXTURE_2D_ARRAY,R.gl.TEXTURE_MIN_FILTER,view.baseMip?R.gl.LINEAR:R.gl.LINEAR_MIPMAP_LINEAR);
            }
            const {pitch,yaw}=view,copies=wide?13500:diagonal?1200:checker?625:300,n=styles.length*copies,structures={n,cap:n},unitFrame={n,cap:n};
            const focus=view.focus,center=focus?styles.findIndex(s=>s.modelKey===focus):(styles.length-1)/2;
            if(center<0)throw Error('Missing focus '+focus);
            const footprint=styles[center]?.unit?.55:.94;
            const span=view.targetPixels?960/(2*Math.tan(.37))*footprint/(1.25*view.targetPixels):view.span||(checker?(focus?32:275):focus?16:styles.length*.95);
            const centerX=view.targetPixels?position(center,view.singleRow??440).x:wide?27+center*18:diagonal?20+center*7+110*.35:checker?(focus?20+(center%9)*28+12:140):20+center*1.05;
            const centerZ=view.targetPixels?position(center,view.singleRow??440).z:wide?780:diagonal?130:checker?(focus?20+Math.floor(center/9)*28+16:125):focus?245:210;
            const snapshot={worldWidth:wide?1400:400,worldHeight:wide?1000:400,viewportWidth:1440,viewportHeight:960,
                camera:{centerX:centerX+(view.dx||0),centerZ:centerZ+(view.dz||0),visibleWidth:span,visibleHeight:span*2/3},flat2d:false};
            R.orbitPitch=pitch;R.orbitYaw=yaw;R.resize(1440,960);R.buildViewProjection(snapshot);
            viewW=1440;viewH=960;
            let closeSlots=null;
            if((checker||diagonal||wide)&&!view.forceBands) {
                const structureScores=new Float32Array(n),unitScores=new Float32Array(n);
                for(let col=0;col<styles.length;col++)for(let row=0;row<copies;row++) {
                    const {x,z}=position(col,row),unit=styles[col].unit;
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
                if(view.single&&(col!==center||row!==(view.singleRow??440)))continue;
                if(view.cluster&&(col!==center||row>=400))continue;
                const i=col*copies+row,s=styles[col],units=!!s.unit,F=units?unitFrame:structures;
                const {x,z}=view.cluster?{x:centerX+(row%20-9.5)*1.1,z:centerZ+(Math.floor(row/20)-9.5)*1.1}:position(col,row);
                const band=checker?Math.floor(row/25):row;
                const size=units?.55:.94,stats=units?BASE_UNIT_STATS[s.type]:BASE_CARD_TYPES[s.type],vision=(stats?.visionRange||0)*(view.visionScale||1);
                const kind=units?7:s.neutral?(s.type==='gold'?4:5):s.modelKey.startsWith('spawner')?2:s.modelKey.startsWith('barrack')?1:s.modelKey.startsWith('item')?3:0;
                F.x[i]=F.px[i]=x*32;F.y[i]=F.py[i]=z*32;F.gx[i]=Math.floor(x);F.gy[i]=Math.floor(z);
                F.type[i]=F.utype[i]=s.neutral?0:_pageFrameStrings.indexOf(s.type);F.kind[i]=kind;F.r[i]=size*32/2.2;
                if(s.neutral)F.amount[i]=s.modelKey.endsWith('_active')?1:0;
                F.alive[i]=1;F.id[i]=i;F.energy[i]=100;F.owner[i]=0;F.vision[i]=vision;F.angle[i]=Math.PI/2;
                if(view.walk&&units){F.px[i]-=1;F.amount[i]=1;}
                // Hold: identical previous/current positions, no walk, attack,
                // production or idle-settling animation to hide a transition.
                if(reference||(view.meshStage?view.meshStage!=='image':(closeSlots?closeSlots.has(i):band>=(checker?20:264)))){
                    (units?C.detailMask:C.detailMaskS)[i]=255;
                    let sy=size*s.scaleY;if(units&&!s.mounted)sy=Math.max(s.snake?.24:.48*s.scaleX,sy);
                    if(!s.preserveModelHeight&&!s.isFlying&&!s.mounted&&vision>0)sy*=Math.max(.18,vision*AREA_UNIT_TILE_EQUIVALENT/5);
                    objects.push({modelKey:s.modelKey,weaponType:s.weaponType,isFlying:s.isFlying,isWorker:s.isWorker,x,z,y:s.isFlying?.3:0,
                        scaleX:size*s.scaleX,scaleZ:size*s.scaleX,scaleY:sy,rotationY:0,baseTint:ownerColor,tint:ownerColor,baseSideTint:s.color,sideTint:s.color,
                        moveAmount:view.walk&&units?1:0,walkPhase:0,lightLevel:1,alpha:1,topTextureKey:s.modelKey,topTextureCanvas:exactPanels.get(s)||A.panels[A.catalog.styles.indexOf(s)],statusTextureCanvas:s.statusTextureCanvas,forceFull:reference});
                } else if(!view.meshStage&&(closeSlots||band>=(checker?16:232))) {
                    if(units)C.unitCandidates.push({_s:i});else middle.push(i);
                }
            }
            _structureDetailCandidates=()=>middle;
            snapshot.objects=objects;snapshot.columnLayers=C;
            R.orbitPitch=pitch;R.orbitYaw=yaw;
            const now=performance.now.bind(performance);performance.now=()=>1000*(view.time||0);
            // Route a static pose through the animated-unit sampler, with the
            // same pixels and zero frame interpolation. Both paths must agree.
            const oldAnimation=A.animation,changed=[];
            const uploadMeta=()=>{const gl=R.gl;gl.bindTexture(gl.TEXTURE_2D,A.meta);gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL,false);gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL,false);gl.texSubImage2D(gl.TEXTURE_2D,0,0,0,A.grid,A.grid,gl.RGBA,gl.FLOAT,A.metaData);};
            if(view.staticPoseAsAnimation) {
                A.catalog.styles.forEach((s,i)=>{if(!s.unit){const base=i*A.catalog.stride+1,at=base*4+3;changed.push([at,A.metaData[at]]);A.metaData[at]=base+3;}});
                uploadMeta();A.animation=A;
            }
            if(!window.stripBackground) {
                R.render({...snapshot,objects:[],columnLayers:null});
                const clear=new Uint8Array(4);R.gl.bindFramebuffer(R.gl.FRAMEBUFFER,null);R.gl.readPixels(0,0,1,1,R.gl.RGBA,R.gl.UNSIGNED_BYTE,clear);
                window.stripBackground=[...clear.slice(0,3)];
            }
            try {R.render(snapshot);}finally{performance.now=now;if(changed.length){for(const [at,value] of changed)A.metaData[at]=value;uploadMeta();A.animation=oldAnimation;}}
            const gl=R.gl,w=R.canvas.width,h=R.canvas.height,pixels=new Uint8Array(w*h*4);
            gl.bindFramebuffer(gl.FRAMEBUFFER,null);gl.readPixels(0,0,w,h,gl.RGBA,gl.UNSIGNED_BYTE,pixels);
            const energy=[0,0,0],background=window.stripBackground;
            let visible=0,hash=2166136261,minX=w,minY=h,maxX=-1,maxY=-1;
            for(let i=0;i<pixels.length;i+=4)for(let c=0;c<3;c++)energy[c]+=pixels[i+c]-background[c];
            for(let i=0;i<pixels.length;i+=4){hash=Math.imul(hash^pixels[i]^pixels[i+1]^pixels[i+2],16777619);if(Math.max(pixels[i],pixels[i+1],pixels[i+2])>40){visible++;const x=i/4%w,y=Math.floor(i/4/w);minX=Math.min(minX,x);maxX=Math.max(maxX,x);minY=Math.min(minY,y);maxY=Math.max(maxY,y);}}
            title.textContent=`${view.name} | ${styles.length} types × ${wide?'15×900':diagonal?'4×300':checker?'25×25':300} = ${n.toLocaleString()} objects | ${reference?'full-detail reference':'LOD transitions'}${focus?' | focus: '+focus:''}`;
            return {glError:gl.getError(),coverage:visible/(w*h),energy,hash,bounds:[minX,minY,maxX,maxY],middle:R.columnModels?.count,objects:objects.length,atlasReady:A.next};
        };
        return {styles:A.catalog.styles.length,backgroundBake,atlasPixels:A.pixels,animationPixels:A.animation.pixels,snapshotSizes:A.catalog.styles.map(s=>[s.modelKey,Defence3Renderer3D.columnSnapshotSize?.(s)||32]),rows:styles.map(s=>s.modelKey),copiesPerType:wide?13500:diagonal?1200:checker?625:300,total:styles.length*(wide?13500:diagonal?1200:checker?625:300),panelErrors};
    },{checker,diagonal,wide,graphics,aa,baseline:!!process.env.LOD_BASELINE_DIR});
    console.log('SETUP',JSON.stringify(setup));
    if(process.env.LOD_ATLAS_AUDIT) {
        const png=await page.evaluate(()=>{
            const R=stripRenderer,A=stripAtlas,gl=R.gl,fbo=gl.createFramebuffer(),canvas=document.createElement('canvas'),g=canvas.getContext('2d');
            canvas.width=1024;canvas.height=576;g.fillStyle='#303030';g.fillRect(0,0,1024,576);g.imageSmoothingEnabled=false;
            const style=A.catalog.styles.findIndex(s=>s.modelKey==='item_water_puddle');
            for(let pitch=0;pitch<(A.catalog.stride-1)/16;pitch++)for(let level=0;level<4;level++) {
                const index=style*A.catalog.stride+2+pitch*16+1,rect=A.rects[index],size=rect.size>>level,pixels=new Uint8ClampedArray(size*size*4);
                gl.bindFramebuffer(gl.FRAMEBUFFER,fbo);gl.framebufferTextureLayer(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,A.color,level,0);
                gl.readPixels(rect.x>>level,rect.y>>level,size,size,gl.RGBA,gl.UNSIGNED_BYTE,pixels);
                const tile=document.createElement('canvas');tile.width=tile.height=size;tile.getContext('2d').putImageData(new ImageData(pixels,size,size),0,0);
                g.drawImage(tile,level*256,pitch*64,64,64);g.fillStyle='white';g.fillText('pitch '+pitch+' mip '+level,level*256+70,pitch*64+30);
            }
            gl.bindFramebuffer(gl.FRAMEBUFFER,null);gl.deleteFramebuffer(fbo);return canvas.toDataURL().split(',')[1];
        });
        fs.writeFileSync(path.join(output,'atlas-water.png'),Buffer.from(png,'base64'));
    }
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
        ...['item_water_puddle','item_poison_puddle','item_ice_patch','spawner_builder_spawner'].map(focus=>({name:'checker-low-'+focus,pitch:.38,yaw:.52,focus})),
        {name:'checker-houses-overhead',pitch:1.5,yaw:.52,focus:'item_house'},
        {name:'checker-houses-pan',pitch:.52,yaw:.52,focus:'item_house',dx:6,dz:6},
        {name:'checker-mines',pitch:.52,yaw:.52,focus:'gold_mine_active'},
        {name:'checker-15-wheel-steps',pitch:.52,yaw:.52,focus:'item_house',span:1440/(32*(15/1.2**15))},
        {name:'checker-forced-boundaries',pitch:.52,yaw:.52,focus:'item_house',forceBands:true});
    if(diagonal)views.splice(0,views.length,
        ...[.2,.52,1.2].map(pitch=>({name:'diagonal-towers-'+pitch,pitch,yaw:.52,span:65,focus:'tower_watch_tower'})),
        ...[0,.157].map(time=>({name:'diagonal-walk-'+time,pitch:.35,yaw:.52,span:40,focus:'unit_norm',walk:true,time})),
        {name:'diagonal-snake',pitch:.35,yaw:.52,span:38,focus:'unit_snake'},
        {name:'diagonal-workers',pitch:.35,yaw:.52,span:48,focus:'spawner_builder_spawner'},
        {name:'diagonal-barracks',pitch:.35,yaw:.52,span:48,focus:'barrack_norm'},
        ...['item_water_puddle','item_poison_puddle','item_ice_patch','spawner_builder_spawner'].flatMap(focus=>[.16,.38].map(pitch=>({name:'grazing-'+focus+'-'+pitch,pitch,yaw:.52,span:48,focus}))),
        ...[.08,.16,.38,.65].map(pitch=>({name:'floor-single-'+pitch,pitch,yaw:.52,span:70,focus:'item_water_puddle',single:true,meshStage:'image',compare:true})),
        ...[0,80,160,240].map(singleRow=>({name:'floor-far-'+singleRow,pitch:.16,yaw:.52,span:48,focus:'item_water_puddle',single:true,singleRow,meshStage:'image',compare:true})),
        ...[0,.157].map(time=>({name:'cached-walk-'+time,pitch:.35,yaw:.52,span:65,focus:'unit_norm',walk:true,time,meshStage:'image'})),
        ...['tower_sniper','tower_watch_tower','unit_snake','spawner_builder_spawner','barrack_norm','unit_laser_resistant'].flatMap(focus=>[.2,.52,1.2].map(pitch=>({name:'single-'+focus+'-'+pitch,pitch,yaw:.52,span:70,focus,single:true,meshStage:'image',compare:true}))),
        ...[.2,.52,1.2].map(pitch=>({name:'tall-watch-'+pitch,pitch,yaw:.52,span:70,focus:'tower_watch_tower',single:true,meshStage:'image',compare:true,visionScale:2.4})));
    if(process.env.LOD_STAGE_AUDIT)views.splice(0,views.length,...['item_water_puddle','tower_watch_tower','spawner_builder_spawner'].flatMap(focus=>['full','lod2','image'].map(meshStage=>({name:'audit-'+focus+'-'+meshStage,meshStage,focus,pitch:.38,yaw:.52,span:48}))));
    if(process.env.LOD_MIP_AUDIT)views.splice(0,views.length,...[false,true].flatMap(baseMip=>[
        {name:'mips-'+baseMip,pitch:.38,yaw:.52,span:48,focus:'item_water_puddle',baseMip},
        ...[0,80,160,240].map(singleRow=>({name:'floor-far-'+singleRow+'-'+baseMip,pitch:.16,yaw:.52,span:48,focus:'item_water_puddle',single:true,singleRow,meshStage:'image',compare:true,baseMip}))]));
    if(process.env.LOD_EXACT_AUDIT)views.splice(0,views.length,...['item_water_puddle','tower_watch_tower','spawner_builder_spawner','unit_laser_resistant'].flatMap(focus=>[.08,.35,.65].flatMap(pitch=>[0,.18,.36,.54].map(dx=>({name:'exact-'+focus+'-'+pitch+'-'+dx,pitch,yaw:0,span:100,focus,single:true,singleRow:440,meshStage:'image',compare:true,dx})))));
    if(process.env.LOD_SHARED_AUDIT)views.push(...['item_water_puddle','tower_watch_tower','spawner_builder_spawner','item_house'].flatMap(focus=>[false,true].map(staticPoseAsAnimation=>({name:'shared-'+focus+'-'+staticPoseAsAnimation,pitch:.38,yaw:.52,span:70,focus,single:true,singleRow:440,meshStage:'image',staticPoseAsAnimation}))));
    if(wide)views.splice(0,views.length,...['unit_fire_resistant','unit_laser_resistant','spawner_builder_spawner','item_water_puddle'].filter(s=>setup.rows.includes(s)).flatMap(focus=>[.16,.38,.65,1.05,1.3,1.42].flatMap(pitch=>[0,5,10,15,20,25,30].map(scroll=>({name:`wide-${focus}-${pitch}-scroll${scroll}`,pitch,yaw:0,span:1440/(32*(15/1.2**scroll)),focus})))));
    if(process.env.LOD_TRANSITION_AUDIT) {
        const all=process.env.LOD_TRANSITION_AUDIT==='all';
        const types=all?setup.rows:['unit_laser_resistant','spawner_builder_spawner','item_water_puddle','tower_watch_tower'];
        views.splice(0,views.length,...types.flatMap(focus=>[.08,.35,.65,1.05,1.3,1.56].flatMap(pitch=>[0,.20,.52].flatMap(yaw=>[64,40,12,8,4,2,1].flatMap(boundary=>[.98,1.02].map(side=>({
            name:`transition-${focus}-${pitch}-${yaw}-${boundary}-${side}`,focus,pitch,yaw,targetPixels:boundary*side,single:true,meshStage:boundary>=40?(boundary===64?'lod1':'lod2'):'image',compare:true,boundary
        })))))));
    }
    if(process.env.LOD_ROTATION_AUDIT)views.splice(0,views.length,...['unit_laser_resistant','item_water_puddle','spawner_builder_spawner','tower_watch_tower'].flatMap(focus=>(process.env.LOD_ROTATION_AUDIT==='all'?[.08,.35,.38,.65,1.05,1.42,1.56]:[.38,1.42]).flatMap(pitch=>[2,4,8,12].flatMap(targetPixels=>Array.from({length:9},(_,i)=>({
        name:`rotation-${focus}-${pitch}-${targetPixels}-${i}`,focus,pitch,yaw:i*Math.PI/16,targetPixels,cluster:true,meshStage:'image',compare:true,boundary:targetPixels
    }))))));
    if(process.env.LOD_COLOR_AUDIT)views.splice(0,views.length,...views.filter(v=>v.single));
    if(process.env.LOD_CAPTURE_FILTER){const filter=new RegExp(process.env.LOD_CAPTURE_FILTER);views.splice(0,views.length,...views.filter(v=>filter.test(v.name)));}
    for(const view of views)for(const reference of (view.compare?[false,true]:view.meshStage?[false]:[false,true])){
        const result=await page.evaluate(({view,reference})=>stripDraw(view,reference),{view,reference});
        if(result.glError)errors.push('WebGL '+result.glError);
        if(!view.targetPixels&&result.coverage<(view.single?.000005:.02))errors.push('Missing models in '+JSON.stringify({view,reference}));
        results.push({...view,reference,...result});console.log(JSON.stringify(results.at(-1)));
        if(!view.targetPixels||process.env.LOD_AUDIT_IMAGES)await page.screenshot({path:path.join(output,`lod-strip-${view.name}-${reference?'reference':'actual'}.png`)});
    }
    // Keep individual angle/distance failures; a whole-frame average can hide
    // opposite errors in different rows. Tiny silhouettes need a phase sweep
    // before asserting color (one covered MSAA sample can dominate a 1px model).
    for(const actual of results.filter(r=>r.targetPixels&&!r.reference&&r.boundary>=8)) {
        const ref=results.find(r=>r.name===actual.name&&r.reference);
        const ratios=actual.energy.map((v,i)=>ref.energy[i]>100?v/ref.energy[i]:1);
        if(ratios.some(r=>r<.8||r>1.2))errors.push('Transition color mismatch: '+JSON.stringify({name:actual.name,ratios}));
    }
    if(diagonal) {
        for(const actual of results.filter(r=>r.staticPoseAsAnimation)) {
            const staticPose=results.find(r=>r.name===actual.name.replace(/true$/,'false'));
            if(actual.hash!==staticPose?.hash)errors.push('Static and unit animation samplers disagree: '+actual.focus);
        }
        const floorRows=results.filter(r=>r.name.startsWith('floor-far-'));
        if(!graphics&&floorRows.length===8)for(let channel=0;channel<3;channel++) {
            const energy=reference=>floorRows.filter(r=>r.reference===reference).reduce((sum,r)=>sum+r.energy[channel],0);
            const ratio=energy(false)/energy(true);
            if(ratio<.85||ratio>1.15)errors.push('Distant floor color coverage differs from geometry: channel '+channel+' ratio '+ratio);
        }
        const walking=results.filter(r=>r.name.startsWith('cached-walk-'));
        if(walking.length&&walking[0].hash===walking[1].hash)errors.push('Cached walking animation did not advance');
        for(const actual of results.filter(r=>r.single&&r.compare&&!r.reference)) {
            const reference=results.find(r=>r.name===actual.name&&r.reference);
            const height=r=>r.bounds[3]-r.bounds[1]+1;
            if(Math.abs(height(actual)-height(reference))>3)errors.push('Cached model height differs: '+JSON.stringify({name:actual.name,actual:height(actual),reference:height(reference)}));
        }
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
