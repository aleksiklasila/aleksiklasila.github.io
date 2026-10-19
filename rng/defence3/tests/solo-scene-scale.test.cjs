'use strict';
// Exercise the real export and streaming import at the reported population,
// without allocating a second four-million-unit simulation in a browser.
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),vm=require('node:vm');
(async()=>{
    const count=Number(process.argv[2])||4000000;
    const unit={unitType:'norm',owner:0,x:48,y:80,energy:37,baseLevel:2,stackCount:1};
    const c=vm.createContext({console,TextDecoder,Blob,Response,CompressionStream,DecompressionStream,gameStarted:true,isMultiplayer:false,gameSeed:123,GRID_W:8,GRID_H:8,TILE:32,
        currentTick:120,activeTeamIds:[0,1],players:[{energy:1000,astar:500,researchLevels:{}},{energy:1000,astar:500,researchLevels:{}}],
        grid:Array.from({length:8},()=>Array.from({length:8},()=>({type:0,owner:-1,areaId:0}))),areas:[],goldMines:[],astarMines:[],
        towers:[],barracks:[],collectorSpawners:[],getCellItemsRowMajor:()=>[],units:new Array(count).fill(unit),getUnitOrderDestinationCode:()=>-55});
    vm.runInContext(fs.readFileSync(path.join(__dirname,'../src/utils/utils_file_io.js'),'utf8'),c);
    vm.runInContext(fs.readFileSync(path.join(__dirname,'../src/utils/utils_solo_snapshot.js'),'utf8'),c);
    const parts=c.buildSoloGameSnapshotParts({settings:{},player:0,teamColors:{},camera:{x:0,y:0,zoom:1}});
    assert.ok(Math.max(...parts.map(p=>p.length))<1024*1024,'bounded serialization chunks');
    const filename=path.join(os.tmpdir(),'defence3-scene-scale-'+process.pid+'.gz');
    try {
        const blob=await c.compressSoloGameSnapshot(parts);
        fs.writeFileSync(filename,Buffer.from(await blob.arrayBuffer()));
        assert.equal(fs.readFileSync(filename).readUInt16BE(0),0x1f8b,'real gzip file');
        const bytes=fs.statSync(filename).size;
        const scene=await c.readSoloGameSnapshotFile(await fs.openAsBlob(filename));
        let imported=0;
        for(const record of scene.records)for(const row of record.units||[]){assert.equal(row[0],'norm');assert.equal(row[2],1.5);assert.equal(row[3],2.5);assert.equal(row[7][0],'attackMove');imported++;}
        assert.equal(imported,count);
        const raw=parts.reduce((n,p)=>n+Buffer.byteLength(p),0);
        console.log('PASS gzip file export / streaming import: '+count.toLocaleString()+' units, '+(raw/1048576).toFixed(1)+' MiB raw, '+(bytes/1048576).toFixed(2)+' MiB gzip');
    }finally{fs.unlinkSync(filename);}
})().catch(e=>{console.error(e);process.exitCode=1;});
