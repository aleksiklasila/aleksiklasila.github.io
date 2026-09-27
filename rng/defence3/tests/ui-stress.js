// Browser diagnostics only; never loaded by the production page.
// Controls prepare reproducible live fixtures; normal mouse/keyboard input
// and the real game loop stay active. Timings exclude the first 3 seconds.
(() => {
    const query = new URLSearchParams(location.search);
    const count = Number(query.get('units')) || 600;
    const size = Number(query.get('size')) || 120;
    const kind = query.get('kind') || 'mixed';
    const mines = Number(query.get('mines') ?? 120);
    const teams = Number(query.get('teams')) || 2;
    const mode = query.get('mode') || '2d';
    const samples = {}, errors = [], input = {}, hashes = [];
    let readyAt = Infinity, collecting = false, orbitDrag = false, lastFrame = 0;
    let cameraStats = null;
    const resetCameraStats = () => cameraStats = {frames:0,invalid:0,zoom:[Infinity,-Infinity],x:[Infinity,-Infinity],y:[Infinity,-Infinity],yaw:[Infinity,-Infinity],pitch:[Infinity,-Infinity]};
    resetCameraStats();
    const summary = a => {
        const sorted = a.slice().sort((a,b) => a-b);
        return { n:a.length, mean:a.reduce((a,b)=>a+b,0)/(a.length||1), p95:sorted[Math.floor(sorted.length*.95)]||0, max:sorted.at(-1)||0 };
    };
    for (const name of ['gameTick','renderFrame','updateCamera','updateInfoPanel','get3DBoxSelection','build3DFrameData','drawMinimap','updateControlGroupBar']) {
        const original = window[name];
        if (typeof original !== 'function') continue;
        window[name] = function(...args) {
            const begin = performance.now();
            if(name==='renderFrame' && collecting && begin>=readyAt+3000) {
                if(lastFrame)(samples.frameInterval ||= []).push(begin-lastFrame);
                lastFrame=begin;cameraStats.frames++;
                const values={...camera,yaw:renderer3dInstance?.orbitYaw||0,pitch:renderer3dInstance?.orbitPitch||0};
                for(const key of ['x','y','zoom','yaw','pitch']) {
                    const value=values[key];
                    if(!Number.isFinite(value))cameraStats.invalid++;
                    else {cameraStats[key][0]=Math.min(cameraStats[key][0],value);cameraStats[key][1]=Math.max(cameraStats[key][1],value);}
                }
            }
            try {
                const value=original.apply(this,args);
                if(name==='gameTick' && !Number.isFinite(readyAt)) readyAt=begin;
                if(name==='gameTick' && isMultiplayer && gameTime%20===0) {
                    hashes.push([gameTime,computeLockstepStateHashFast(gameTime)]);
                    if(hashes.length>120)hashes.shift();
                }
                return value;
            }
            finally { if (collecting && performance.now()>=readyAt+3000) (samples[name] ||= []).push(performance.now()-begin); }
        };
    }
    window.addEventListener('error', e => errors.push(e.message));
    window.addEventListener('unhandledrejection', e => errors.push(String(e.reason)));
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;left:180px;top:35px;z-index:99999;background:#17202d;color:white;padding:5px;font:12px sans-serif;border:1px solid #688;max-width:600px';
    const add = (label, action) => { const b=document.createElement('button'); b.textContent=label; b.onclick=action; overlay.append(b); };
    const label = document.createElement('span');
    function configure() {
        for (const [id,value] of Object.entries({'cfg-mapsize':size,'cfg-map-type':query.get('map')||'arena','cfg-gold-count':mines,'cfg-astar-mine-count':mines,'cfg-max-pop':100000,'cfg-full-vis':'full','cfg-starting-energy':1e9,'cfg-starting-astar':1e9})) {
            const e = document.getElementById(id); if(e) {e.value=String(value); e.dispatchEvent(new Event('change'));}
        }
    }
    async function setup() {
        if (gameStarted) return;
        configure();
        startingResourcesConfig = {researchLevels:{},spawnCounts:{}};
        const realNow=Date.now; Date.now=()=>1700000000000;
        try { startSoloGame(); } finally { Date.now=realNow; }
        const wait = setInterval(() => {
            if (!gameStarted || !grid.length) return;
            clearInterval(wait);
            const random=mulberry32(9123);
            const kinds = kind==='mixed' ? Object.keys(BASE_UNIT_STATS).filter(k=>k!=='king' && !k.startsWith('_')) : [kind];
            for(let owner=0;owner<teams;owner++) {
                if (!players[owner]) players[owner]={...players[0],researchLevels:{},researchMultipliers:{},researchQueue:[],researchTask:null,popCount:0};
                if(!activeTeamIds.includes(owner))activeTeamIds.push(owner);
            }
            rebuildPrecomputedStatsMapPlayer();
            for(let owner=0;owner<teams;owner++) {
                for(let i=0;i<count;i++) {
                    const x=(size*(.15+.6*(owner%2))+random()*Math.min(18,size*.2))*TILE;
                    const y=(2+random()*(size-5))*TILE;
                    const u=new Unit(kinds[i%kinds.length],owner,x,y);
                    configureWorkerUnitFromType(u); units.push(u);players[owner].popCount++;updateUnitSpatial(u);
                }
                const keys=Object.keys(BASE_CARD_TYPES).filter(k=>k!=='area_upgrader');
                for(let i=0;i<Math.min(200,size*2);i++) {
                    const gx=2+i%Math.max(2,Math.floor(size*.25))+(owner%2)*Math.floor(size*.6),gy=2+Math.floor(i/Math.max(2,Math.floor(size*.25)))*2;
                    if(gx>=size-1 || gy>=size-1 || grid[gy][gx].item)continue;
                    placeBuilding(gx,gy,keys[i%keys.length],owner,{silent:true,ignorePlacementRules:true});
                    const b=getTileEntityRef(gx,gy);if(b){b.underConstruction=false;if(b.maxEnergy)b.energy=b.maxEnergy;}
                }
            }
            recalculateAdjacency(); fullVisibility=true; setRenderDimensionMode(mode);
            camera.zoom=Math.max(.4,viewW/(size*TILE));camera.x=0;camera.y=0;clampCamera();
            readyAt=performance.now();
            label.textContent=` ${kind} ${units.length} units / ${teams} teams / ${size}² / ${mode}`;
        },50);
    }
    add('Prepare stress match',setup);
    add('Prepare online',()=>{
        if(gameStarted)return;
        configure();
        const kinds=kind==='mixed'?Object.keys(BASE_UNIT_STATS).filter(k=>k!=='king'&&!k.startsWith('_')):[kind];
        const spawnCounts=Object.fromEntries(kinds.map(k=>['unit:'+k,{1:Math.max(1,Math.floor(count/kinds.length))}]));
        for(const k of Object.keys(BASE_CARD_TYPES).filter(k=>!['area_upgrader','mine','sand','lava','poison_puddle','water_puddle','ice_patch'].includes(k)))spawnCounts['building:'+k]={1:2};
        spawnCounts['unit:king']={1:1};spawnCounts['building:house']={10:2};
        startingResourcesConfig={researchLevels:{},spawnCounts};
        readyAt=performance.now();
        setRenderDimensionMode(mode);hostOnlineGame();
    });
    add('Select roster',()=>selectInfoPanelPlayerRoster('all-owned','total','all'));
    add('2D',()=>setRenderDimensionMode('2d'));
    add('3D',()=>setRenderDimensionMode('3d'));
    // The automation API only exposes left-button drags. This optional relay
    // translates their button edges to middle-button edges; real pointer moves
    // still reach the unmodified game's rotation handlers.
    add('Orbit drag',()=>{orbitDrag=!orbitDrag;label.textContent=orbitDrag?' Orbit drag ON':' Orbit drag OFF';});
    add('Pan sweep',()=>{
        const keys=['ArrowRight','ArrowDown','ArrowLeft','ArrowUp'];
        let frame=0,key=null;
        const step=()=>{
            const next=frame<240?keys[Math.floor(frame/20)%4]:null;
            if(next!==key){if(key)document.dispatchEvent(new KeyboardEvent('keyup',{key}));key=next;if(key)document.dispatchEvent(new KeyboardEvent('keydown',{key}));}
            if(frame++<240)requestAnimationFrame(step);
        };
        step();
    });
    add('Measure',()=> {for(const k of Object.keys(samples))delete samples[k];for(const k of Object.keys(input))delete input[k];lastFrame=0;resetCameraStats();collecting=true;label.textContent=' Measuring';});
    add('Report',()=> {
        collecting=false;
        const report={version:3,scenario:query.get('scenario')||'selection',baseline:query.has('baseline'),kind,count,size,mines,teams,viewport:[innerWidth,innerHeight],mode:renderDimensionMode,multiplayer:isMultiplayer,host:isHost,desyncs:netCounters.desyncsDetected,hashes,warmup:performance.now()-readyAt,units:units.length,selection:[selectedUnits.length,selectedEntities.length],camera:cameraStats,samples:Object.fromEntries(Object.entries(samples).map(([k,v])=>[k,summary(v)])),input,errors};
        fetch('/__reports',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(report)});
        label.textContent=' Report saved ('+errors.length+' errors)';
    });
    overlay.append(label);document.body.append(overlay);
    // Bootstrap registers the game's bubbling listeners on load. Install the
    // trailing observer afterwards, otherwise it measures only itself.
    window.addEventListener('load',()=>{
        const area=document.getElementById('game-area');
        for(const type of ['mousedown','mouseup'])area.addEventListener(type,e=>{
            if(!orbitDrag||e.button!==0)return;
            e.preventDefault();e.stopImmediatePropagation();
            area.dispatchEvent(new MouseEvent(type,{button:1,buttons:type==='mousedown'?4:0,clientX:e.clientX,clientY:e.clientY,bubbles:true}));
        },{capture:true});
        for(const type of ['mousedown','mouseup','mousemove','wheel']) {
            let begin;
            area.addEventListener(type,()=>{begin=performance.now();},{capture:true});
            area.addEventListener(type,()=>{if(collecting){const v=input[type]||={n:0,total:0,max:0};const ms=performance.now()-begin;v.n++;v.total+=ms;v.max=Math.max(v.max,ms);}});
        }
    });
})();
