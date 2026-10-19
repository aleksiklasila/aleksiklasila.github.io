'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const read=f=>fs.readFileSync(path.join(__dirname,'..',f),'utf8');
(async()=>{
    const fixture=JSON.parse(read('tests/4M-1K.json')),messages=[],downloads=[],button={disabled:false};
    let blob,applied=null;
    const c=vm.createContext({Blob,Response,CompressionStream,DecompressionStream,Date,
        URL:{createObjectURL:b=>(blob=b,'blob:test'),revokeObjectURL(){}},setTimeout(){},
        document:{getElementById:()=>button,body:{appendChild(){}},createElement:()=>({click(){downloads.push(this.download);},remove(){}})},
        createMainMenuSettingsSnapshot:()=>fixture,applyMainMenuSettingsSnapshot:d=>{applied=d;},saveUiSettingsToStorage(){},
        showUiBanner:(...args)=>messages.push(args)});
    vm.runInContext(read('src/utils/utils_file_io.js'),c);
    const source=read('src/data/data_dynamic.js');
    vm.runInContext(source.slice(source.indexOf('async function downloadMainMenuSettings('),source.indexOf('function getGameModeLabel(')),c);
    for(const compressed of [false,true]) {
        await c.downloadMainMenuSettings(compressed);
        assert.match(downloads.at(-1),compressed?/\.gz$/:/\.json$/);
        assert.equal(button.disabled,false);
        const data=await new Response(await c.openJsonFileStream(blob)).json();
        assert.deepEqual(data,fixture);
        // Detection uses bytes, even when the extension says the opposite.
        const file=new File([blob],compressed?'settings.json':'settings.gz');
        await c.importMainMenuSettingsFromFile(file);
        assert.deepEqual(applied,fixture);assert.equal(messages.at(-1)[1],'success');
    }
    applied=null;
    for(const file of [new Blob(['not json']),new Blob(['[]']),new Blob([new Uint8Array([0x1f,0x8b,0,0])])]) {
        await c.importMainMenuSettingsFromFile(file);
        assert.equal(applied,null);assert.equal(messages.at(-1)[1],'error');
    }
    const html=read('index.html');
    for(const kind of ['settings','snapshot']) {
        assert.ok(!html.includes('id="'+kind+'-export-format"'));
        assert.match(html,new RegExp('id="input-import-'+kind+'"[^>]*accept="[^\"]*\\.json[^\"]*\\.gz'));
    }
    console.log('PASS settings files: JSON/gzip exports and auto-detected imports, corrupt-file errors, format options available through export buttons');
})().catch(e=>{console.error(e);process.exitCode=1;});
