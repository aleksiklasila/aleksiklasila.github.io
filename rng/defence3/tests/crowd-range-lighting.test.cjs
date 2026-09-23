const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const read = p => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const src = read('src/things/unit.js');
const c = vm.createContext({TILE:32,UNIT_POSITION_QUANTIZATION:1024,gameTime:0,
    CROSS_TEAM_UNIT_COLLISION_PADDING:16,getUnitCollisionRecalcTicks:()=>5,canUnitOccupyTile:()=>true});
vm.runInContext(src,c);
// Run the actual collision gather/sort/solve used by Unit.update, including
// staggered ticks, while 100 units keep moving towards the same waypoint.
const start=src.indexOf('        // Movement must not accumulate');
const end=src.indexOf('        if (hadUnitCollision &&',start);
vm.runInContext('function separate() {\n'+src.slice(start,end)+'\n}',c);
function crowdRun() {
    let crowd=Array.from({length:100},(_,id)=>({id,owner:0,x:500+(id%10)*2,y:500+Math.floor(id/10)*2,
        vx:0,vy:0,getCollisionRadius:()=>8,getCollisionLayer:()=> 'ground'}));
    c.forEachUnitInRange=(x,y,r,visit)=>{for(let u of crowd){let dx=u.x-x,dy=u.y-y,d2=dx*dx+dy*dy;if(d2<=r*r)visit(u,d2,dx,dy);}};
    for(let tick=0;tick<180;tick++) {
        c.gameTime=tick;
        for(let u of crowd) {
            u.prevX=u.x;u.prevY=u.y;
            let dx=509-u.x,dy=509-u.y,d=Math.hypot(dx,dy);
            if(d>8){u.vx=dx/d*2;u.vy=dy/d*2;u.x+=u.vx;u.y+=u.vy;}
            c.separate.call(u);
        }
    }
    let maxPacked=0;
    for(let u of crowd) maxPacked=Math.max(maxPacked,crowd.filter(v=>Math.abs(u.x-v.x)<=32&&Math.abs(u.y-v.y)<=32).length);
    let meanNearest=crowd.reduce((sum,u)=>sum+Math.min(...crowd.filter(v=>v!==u).map(v=>Math.hypot(u.x-v.x,u.y-v.y))),0)/crowd.length;
    return {positions:crowd.map(u=>[u.x,u.y]),maxPacked,meanNearest};
}
const crowd=crowdRun();
assert.deepEqual(crowdRun(),crowd,'crowd resolution replays deterministically');
assert.ok(crowd.maxPacked<65,`crowd should spread beyond 2x2 tiles: ${crowd.maxPacked}`);
assert.ok(crowd.meanNearest>5,`nearest-neighbor spacing recovers promptly: ${crowd.meanNearest}`);
// A huge accumulated push cannot skip a wall even if its endpoint is empty.
c.canUnitOccupyTile=(_u,x)=>x!==1;
let u={x:16,y:16,getCollisionRadius:()=>64};c.applyUnitSeparation(u,10000,0,128);
assert.ok(u.x<32,'swept large correction cannot jump an intervening wall');

const r=vm.createContext({});vm.runInContext(read('src/audio_visual/range_overlay.js'),r);
const a=r.buildRangeBoundary([{x:0,y:0},{x:0,y:1}],3,2);
const b=r.buildRangeBoundary([{x:1,y:0},{x:2,y:0}],3,2);
const boundary=r.unionRangePerimeters([a,b]);
assert.ok(!boundary.some(l=>l.x1===1&&l.x2===1&&l.z1===0&&l.z2>0),'partial shared edges cancel');
assert.equal(r.clipRangeBoundaryToBounds(boundary,10,10,20,20).length,0,'off-screen range work is culled');
const clipped=r.clipRangeBoundaryToBounds(boundary,0,0,1,1);
assert.equal(r.clipRangeBoundaryToBounds(boundary,0,0,1,1),clipped,'camera-stable clipped geometry is reused');

// Exercise object/shadow preparation in both visibility modes with the same
// live light field and a different (lifted) presentation field.
const render=read('src/audio_visual/renderer.js');
let p=render.indexOf('function push3DRenderObject('),q=render.indexOf('\nfunction ',p+1);
const light=vm.createContext({fullVisibility:false,VISIBILITY_LIGHT_NORMALIZATION_RANGE:6,
    DEFAULT_SHADOW_DIR_X:1,DEFAULT_SHADOW_DIR_Y:0,AREA_UNIT_TILE_EQUIVALENT:5,GRID_W:4,
    visibilityGrid:[[0,0,0,0],[0,.1,3,6],[0,.2,2,4],[0,0,0,0]],
    _getCachedLitTint:(_color,l)=>String(l),getHistoryRenderView:()=>null,
    visibilityHistoryState:{explored:new Uint8Array(16).fill(1),raw:[[0,0,0,0],[0,1,1,1],[0,1,1,1],[0,0,0,0]]}});
light.getRenderVisibilityGrid=()=>light.visibilityGrid.map(row=>row.map(v=>Math.max(.84,v)));
vm.runInContext(render.slice(p,q),light);
let team=[],history=[],object={x:1.4,z:1.4,scaleX:1,scaleY:1,scaleZ:1};
light.push3DRenderObject(team,object);
light.getHistoryRenderView=()=>({});light.push3DRenderObject(history,object);
assert.deepEqual(history,team,'visible object light, shadow direction and length exactly match Team mode');
console.log(`PASS: 100 moving units spread to ${crowd.maxPacked} per 2x2 tiles; mean nearest ${crowd.meanNearest.toFixed(1)}px; deterministic sweep, clipped perimeter and identical live shadows.`);
