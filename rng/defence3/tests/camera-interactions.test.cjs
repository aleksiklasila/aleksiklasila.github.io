// Camera gestures use the real input handlers and projection/orbit math.
// WebGL is unnecessary for these checks; browser stress covers the GPU view.
const assert=require('node:assert/strict');
const H=require('./net-harness.cjs');
(async()=>{
    const world=new H.World({controls:{...H.SMALL_MATCH_CONTROLS,'cfg-mapsize':'120'},hashEvery:1,exactHashes:true});
    const {host,guests}=await H.startHostedMatch(world,{guests:1,maxMs:120000});
    for(const game of [host,...guests])game.eval(`
        minimapCanvas=document.getElementById('minimapCanvas');canvas=document.getElementById('gameCanvas');initInput();
        renderer3dInstance=Object.create(window.Defence3Renderer3D.prototype);
        Object.assign(renderer3dInstance,{orbitYaw:0,orbitPitch:.8,cssWidth:1280,cssHeight:720,supported:true,canvas:document.createElement('canvas')});
        for(const k of ['tmpProjection','tmpView','tmpViewProjection','tmpInverseViewProjection'])renderer3dInstance[k]=new Float32Array(16);
        viewW=1280;viewH=720;
        __scratch.projections=0;
        const build=renderer3dInstance.buildViewProjection;
        renderer3dInstance.buildViewProjection=function(s){__scratch.projections++;return build.call(this,s);};
    `);
    const game=host,start=game.eval('currentTick'),before=game.eval('__exactStateHash()');
    // Wheel zoom eases over frames: run the camera until it settles.
    const wheel=delta=>{
        game.dispatch('game-area','wheel',{clientX:600,clientY:400,deltaY:delta});
        game.eval('__scratch.camT=(__scratch.camT||1e6);for(let i=0;i<40&&_cameraZoomAnim;i++)updateCamera(__scratch.camT+=16)');
    };
    for(const mode of ['2d','3d']) {
        game.eval(`renderDimensionMode='${mode}';camera={x:1200,y:1100,zoom:4};`);
        const point=()=>JSON.parse(game.eval(`JSON.stringify((()=>{
            if(renderDimensionMode==='2d')return {x:camera.x+600/camera.zoom,y:camera.y+400/camera.zoom};
            renderer3dInstance.buildViewProjection(get3DProjectionSnapshot());
            const p=renderer3dInstance.screenToGround(600,400,document.getElementById('game-area').getBoundingClientRect());
            return {x:p.x*TILE,y:p.y*TILE};
        })())`));
        for(let i=0;i<80;i++) {
            if(mode==='3d') {
                game.dispatch('game-area','mousedown',{button:1,buttons:4,clientX:400,clientY:300});
                game.dispatch('window','mousemove',{buttons:4,clientX:400+(i%2? -35:35),clientY:300+(i%3?-8:16)});
                game.dispatch('window','mouseup',{button:1});
            }
            const anchor=point();wheel(-1);const zoomed=point();wheel(1);const restored=point();
            // Float32 inverse projection causes a small, bounded roundoff.
            for(const key of ['x','y']) {
                assert.ok(Math.abs(zoomed[key]-anchor[key])<.15,mode+': zoom anchor '+key);
                assert.ok(Math.abs(restored[key]-anchor[key])<.2,mode+': reversal anchor '+key);
            }
            game.dispatch('document','keydown',{key:'ArrowRight'});
            game.eval('updateCamera()');
            game.dispatch('document','keyup',{key:'ArrowRight'});
            game.dispatch('document','keydown',{key:'ArrowLeft'});
            game.eval('updateCamera()');
            game.dispatch('document','keyup',{key:'ArrowLeft'});
        }
        for(const delta of [-1,1]) {
            for(let i=0;i<100;i++)wheel(delta);
            const state=game.eval('JSON.stringify(camera)'),p=game.eval('__scratch.projections');
            for(let i=0;i<100;i++)wheel(delta);
            assert.equal(game.eval('JSON.stringify(camera)'),state,'camera is stationary at limit');
            assert.equal(game.eval('__scratch.projections'),p,'limit wheels do not rebuild projections');
        }
        for(const key of ['ArrowUp','ArrowRight','ArrowDown','ArrowLeft']) {
            game.dispatch('document','keydown',{key});
            game.eval('for(let i=0;i<1500;i++)updateCamera()');
            game.dispatch('document','keyup',{key});
            assert.equal(game.eval('Number.isFinite(camera.x+camera.y+camera.zoom)&&camera.x>=0&&camera.y>=0&&camera.x<=Math.max(0,WORLD_W-viewW/camera.zoom)&&camera.y<=Math.max(0,WORLD_H-viewH/camera.zoom)'),true,'pan remains within map');
        }
    }
    game.dispatch('game-area','mousedown',{button:1,clientX:300,clientY:300});
    game.dispatch('document','keydown',{key:'ArrowRight'});
    game.dispatch('window','blur');
    assert.equal(game.eval('renderer3dRotateDrag===null&&Object.keys(keysDown).length===0'),true,'blur cancels orbit and pan');
    game.dispatch('game-area','mousedown',{button:1,clientX:300,clientY:300});
    world.setHidden(game,true);game.dispatch('document','visibilitychange');world.setHidden(game,false);
    assert.equal(game.eval('renderer3dRotateDrag'),null,'hidden tab cancels orbit');
    game.dispatch('game-area','mousedown',{button:1,clientX:300,clientY:300});
    game.eval("setRenderDimensionMode('2d');setRenderDimensionMode('3d');");
    assert.equal(game.eval('renderer3dRotateDrag'),null,'mode switches do not resume stale drags');
    assert.equal(game.eval('__exactStateHash()'),before,'camera gestures never mutate gameplay');
    await world.run(3000);
    const cmp=world.compareHashes([host,...guests],start,'tickExact');
    assert.ok(cmp.compared>30);assert.deepEqual(cmp.mismatches,[]);
    for(const peer of [host,...guests]){assert.deepEqual(peer.errors,[]);assert.equal(peer.eval('netCounters.desyncsDetected'),0);}
    console.log('PASS: 2D/3D zoom anchors, 1,120 wheels, 80 rotations, pan limits, focus/view transitions, unchanged gameplay and matching peer hashes.');
})().catch(err=>{console.error(err);process.exitCode=1;});
