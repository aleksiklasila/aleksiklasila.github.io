// Large homogeneous armies and contrasting map/resource sizes, driven through
// real UI handlers while only the clicking peer refreshes its selection.
const assert=require('node:assert/strict');
const H=require('./net-harness.cjs');
const cases=[
    {name:'tiny-eight-teams',size:20,map:'arena',teams:8,count:3,type:'norm',mines:0},
    {name:'huge-four-teams-mines',size:120,map:'solar_system',teams:4,count:80,type:'collector',mines:600},
    {name:'dense-snakes',size:40,map:'arena',teams:2,count:600,type:'snake',mines:2},
    {name:'healers-portals',size:80,map:'islands',teams:2,count:400,type:'healer_unit',mines:160}
];
(async()=>{
    for(const c of cases.filter(c=>!process.argv[2] || c.name===process.argv[2])) {
        const controls={...H.SMALL_MATCH_CONTROLS,'cfg-mapsize':String(c.size),'cfg-map-type':c.map,'cfg-gold-count':String(c.mines),'cfg-astar-mine-count':String(c.mines),
            'cfg-max-pop':'100000','cfg-starting-energy':'1000000000','cfg-starting-astar':'1000000000','cfg-full-vis':'history'};
        const world=new H.World({controls,network:{latencyMs:40,jitterMs:12},hashEvery:1,exactHashes:true});
        const spawnCounts={'unit:king':{1:1},['unit:'+c.type]:{1:c.count},'building:house':{8:1},'building:spawner':{1:1},'building:healer_spawner':{1:1},'building:cloud_0a':{1:1},'building:cloud_0b':{1:1}};
        const {host,guests}=await H.startHostedMatch(world,{guests:c.teams-1,teams:Array.from({length:c.teams},(_,i)=>i),maxMs:120000,
            hostSetup:'startingResourcesConfig='+JSON.stringify({researchLevels:{},spawnCounts})});
        const all=[host,...guests];const start=host.eval('currentTick');
        for(const inst of all) {
            assert.equal(inst.eval('GOLD_MINE_COUNT'),c.mines,c.name+': gold count setting');
            assert.equal(inst.eval('ASTAR_MINE_COUNT'),c.mines,c.name+': A* count setting');
            if(c.mines===0)assert.equal(inst.eval('goldMines.length+astarMines.length'),0,'zero mines stays zero on every peer');
        }
        for(const inst of all)inst.eval(`minimapCanvas=document.getElementById('minimapCanvas');canvas=document.getElementById('gameCanvas');initInput();`);
        let gestures=0;
        for(let round=0;round<12;round++) {
            for(const inst of all) {
                const before=inst.eval('__exactStateHash()');
                const point=JSON.parse(inst.eval(`JSON.stringify((()=>{const u=units.find(u=>u.owner===localPlayerId&&!u.dead);camera.zoom=.6;camera.x=u.x-300;camera.y=u.y-200;return {x:180,y:120};})())`));
                for(let j=0;j<3;j++) {
                    inst.dispatch('game-area','mousedown',{button:0,clientX:point.x-90,clientY:point.y-80});
                    inst.dispatch('game-area','mousemove',{buttons:1,clientX:point.x+180,clientY:point.y+180});
                    inst.dispatch('game-area','mouseup',{button:0,clientX:point.x+180,clientY:point.y+180,shiftKey:j===1});
                    inst.dispatch('game-area','wheel',{clientX:point.x+50,clientY:point.y+30,deltaY:j%2?-1:1});
                    gestures+=2;
                }
                inst.dispatch('document','keydown',{key:'!',code:'Digit1',shiftKey:true});
                inst.dispatch('document','keyup',{key:'!'});
                inst.dispatch('game-area','mousedown',{button:2,clientX:point.x+100,clientY:point.y+80});
                inst.dispatch('game-area','mouseup',{button:2,clientX:point.x+100,clientY:point.y+80});
                assert.equal(inst.eval('__exactStateHash()'),before,c.name+': input changed simulation');
            }
            await world.run(250);
        }
        await world.run(3000);
        const cmp=world.compareHashes(all,start,'tickExact');
        assert.ok(cmp.compared>80,c.name+': progressed');
        assert.equal(cmp.mismatches.length,0,c.name+': '+JSON.stringify(cmp.mismatches.slice(0,2)));
        for(const inst of all) {
            assert.deepEqual(inst.errors.map(e=>String(e.stack||e)),[],c.name+': '+inst.name);
            assert.equal(inst.eval('netCounters.desyncsDetected'),0,c.name+': no desync');
            assert.equal(inst.patchesApplied,0,c.name+': no repair');
            assert.equal(inst.eval('units.some(u=>!Number.isFinite(u.x)||!Number.isFinite(u.y)||!Number.isFinite(u.energy))'),false);
        }
        console.log(`PASS: ${c.name}: ${c.teams*c.count} starting ${c.type}, ${gestures} gestures, ${cmp.compared} exact comparisons, no repairs.`);
    }
})().catch(err=>{console.error(err);process.exitCode=1;});
