'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const read=f=>fs.readFileSync(path.join(__dirname,'..',f),'utf8');
const elements=new Map();
function element(id){
    const e={id,listeners:{},children:[],value:'',textContent:id||'',open:false,style:{},attrs:{},offsetWidth:110,offsetHeight:50,
        addEventListener(type,fn){this.listeners[type]=fn;},click(){this.listeners.click?.();},focus(){this.focused=true;},
        getBoundingClientRect(){return this.rect||{left:200,top:300,bottom:330};},
        setAttribute(k,v){this.attrs[k]=v;},matches(){return this.open;},
        appendChild(child){this.children.push(child);},replaceChildren(){this.children=[];},
        get firstElementChild(){return this.children[0];},
        showPopover(){this.open=true;this.ontoggle?.({newState:'open'});},
        hidePopover(){this.open=false;this.ontoggle?.({newState:'closed'});}};
    if(id)elements.set(id,e);return e;
}
for(const id of ['menu-action-popover','btn-play-offline','btn-export-snapshot','btn-export-settings','input-import-snapshot'])element(id);
const c=vm.createContext({window:{innerWidth:800,innerHeight:600},document:{getElementById:id=>elements.get(id),createElement:()=>element()}});
vm.runInContext(read('src/audio_visual/menu_actions.js'),c);
vm.runInContext(read('src/utils/utils_solo_snapshot.js'),c);
let newGames=0,pickers=0,downloads=[];
c.startSoloGame=()=>newGames++;c.downloadSoloGameSnapshot=compressed=>downloads.push(compressed);
elements.get('input-import-snapshot').click=()=>pickers++;
c.initSoloSnapshotControls();
const menu=elements.get('menu-action-popover'),offline=elements.get('btn-play-offline');
const choices=()=>menu.children;
offline.click();
assert.equal(newGames,0);assert.equal(pickers,0);assert.equal(menu.open,true);
assert.equal(menu.style.top,'248px');assert.equal(menu.style.left,'200px');
assert.deepEqual(choices().map(b=>b.textContent),['New','Load']);
choices()[1].click();assert.equal(menu.open,false);assert.equal(pickers,1);
offline.click();choices()[0].click();assert.equal(newGames,1);
offline.click();offline.click();assert.equal(menu.open,false,'same button toggles menu closed');
offline.click();let prevented=false;
menu.onkeydown({key:'Escape',stopPropagation(){},preventDefault(){prevented=true;}});
assert.equal(menu.open,false);assert.equal(prevented,true);assert.equal(offline.attrs['aria-expanded'],'false');assert.equal(offline.focused,true);
offline.click();menu.hidePopover();assert.equal(offline.attrs['aria-expanded'],'false','native outside dismissal updates trigger');
const save=elements.get('btn-export-snapshot');save.rect={left:750,top:5,bottom:31};
save.click();assert.equal(downloads.length,0);
assert.equal(menu.style.left,'690px');assert.equal(menu.style.top,'33px','top-edge menu stays visible below trigger');
assert.deepEqual(choices().map(b=>b.textContent),['Compressed','Uncompressed']);
choices()[0].click();save.click();choices()[1].click();assert.deepEqual(downloads,[true,false]);
let settings=[];c.showExportOptions(elements.get('btn-export-settings'),compressed=>settings.push(compressed));
choices()[0].click();assert.deepEqual(settings,[true]);
const html=read('index.html');assert.match(html,/id="menu-action-popover" popover="auto"/);
assert.ok(!html.includes('menu-action-cancel'));assert.ok(!html.includes('menu-action-title'));
assert.match(read('src/main.js'),/showExportOptions\(btnExportSettings, downloadMainMenuSettings\)/);
console.log('PASS anchored menus: compact choices, above-button placement, edge clamping, Escape/outside dismissal, new/load and export actions');
