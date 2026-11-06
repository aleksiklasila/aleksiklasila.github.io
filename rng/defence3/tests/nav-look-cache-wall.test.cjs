'use strict';
// A remote wall edit and the flow looks made off the turns (unit.js
// flowLooksPost / flowLooksCommit): a look made before a wall appears inside
// its reach is not committed (the walls' version in reach moved), so no
// look committed after it leads into the new wall; and the helpers' shared table (a
// memo of the answers) changes nothing: a run that empties it every tick
// commits the same looks and moves the unit the same.
const assert = require('node:assert/strict'), H = require('./net-harness.cjs');
const controls = { ...H.SMALL_MATCH_CONTROLS, 'cfg-mapsize': '128', 'cfg-map-type': 'arena', 'cfg-starting-energy': '900000000', 'cfg-starting-astar': '900000000' };
const run = cold => {
    const w = new H.World({ controls }), i = w.spawn('cache-wall' + cold, { simWorker: false });
    return i.eval(`(()=>{
 startingResourcesConfig=normalizeStartingResourcesConfig({spawnCounts:{},researchLevels:{}});applyMainMenuControlsToRuntimeState();startSoloGame();
 const wall=(x,y,on)=>{grid[y][x].type=on?TYPE_WALL:TYPE_FLOOR;simMoveTileTypeChanged(x,y);};
 for(let y=16;y<112;y++)for(let x=16;x<112;x++)wall(x,y,false);
 wall(70,57,true);
 const u=new Unit('tank',0,24*TILE+16,56*TILE+16);units.push(u);unitByIdAdded(u);players[0].popCount++;for(let t=0;t<NAV_BUILD_TICKS+4;t++)gameTick();
 processAction({action:'move',unitIds:[u.id],targetX:110*TILE+16,targetY:56*TILE+16},0);
 const rec=()=>Array.from(u._us.mvNav.subarray(u._si*8,u._si*8+8));
 const tick=()=>{if(${cold})simMoveLookCacheClear();gameTick();};
 // Until its record holds a committed (exact) look reaching past the next tile.
 let primed=null;
 for(let t=0;t<12&&!primed;t++){tick();const r=rec();if(r[0]>=0&&!(r[4]&65536)&&(r[7]>>1)!==r[5])primed=r;}
 if(!primed)return {primed:null};
 // A wall on the far tile it heads for: inside its looks' reach.
 const far=primed[7]>>1;wall(far%GRID_W,Math.floor(far/GRID_W),true);
 // (Its record and step let go, as a unit entering another tile: the next look is made after the edit;
 // one listed before it, still on the helpers, must not be committed.)
 u._us.mvNav[u._si*8]=-1;u._us.mvSteer[u._si*8]=-1;u._us.mvSteer[u._si*8+1]=-1;
 const after=[],path=[];
 for(let t=0;t<8;t++){tick();const r=rec();after.push(r);path.push([u.x,u.y]);}
 return {primed,far,after,path,walled:after.filter(r=>r[0]>=0&&!(r[4]&65536)&&((r[7]>>1)===far||r[5]===far)).length};
})()`);
};
const warm = run(false), cold = run(true);
assert.ok(warm.primed, 'a committed look reaching ahead');
assert.equal(warm.walled, 0, 'no committed look leads into the new wall');
assert.deepEqual(warm.after, cold.after, 'the helpers\' memo changes no committed look');
assert.deepEqual(warm.path, cold.path, 'the helpers\' memo changes no position');
console.log('PASS: flow looks after a remote wall edit: none into the wall; the memo changes nothing', JSON.stringify({ far: warm.far, primedFar: warm.primed[7] >> 1 }));
process.exit(0);
