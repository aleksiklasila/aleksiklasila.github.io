'use strict';
const assert=require('node:assert/strict'),N=require('./report-navigation.js');
const view={x:[0,1],y:[0,1],width:100,height:200};
const close=(a,b)=>{assert.equal(a.length,b.length);a.forEach((v,i)=>assert(Math.abs(v-b[i])<1e-10,`${v} ~= ${b[i]}`));};
close(N.dragRanges(view,10,20).x,[-.1,.9]);close(N.dragRanges(view,10,20).y,[.1,1.1]);
close(N.keyRanges(view,'ArrowRight').x,[.1,1.1]);close(N.keyRanges(view,'ArrowDown').y,[-.1,.9]);
close(N.keyRanges({...view,y:[10,-1]},'ArrowDown').y,[11.1,.1]);
close(N.dragRanges({...view,y:[10,-1]},0,20).y,[8.9,-2.1]);
close(N.keyRanges(view,'ArrowUp',true).y,[.3,1.3]);assert.equal(N.keyRanges(view,'a'),null);
const handlers=new Map(),classes=new Set(),frames=[],updates=[];let capture=null,focused=0;
const node={_fullLayout:{xaxis:{range:[0,1],_length:100},yaxis:{range:[0,1],_length:200}},
 addEventListener:(type,fn)=>handlers.set(type,fn),focus:()=>focused++,classList:{add:c=>classes.add(c),remove:c=>classes.delete(c)},setPointerCapture:id=>capture=id,hasPointerCapture:id=>capture===id,releasePointerCapture:()=>capture=null};
const host={requestAnimationFrame:fn=>{frames.push(fn);return frames.length;}};
N.attach(node,{relayout:(element,update)=>{assert.equal(element,node);updates.push(update);node._fullLayout.xaxis.range=update['xaxis.range'];node._fullLayout.yaxis.range=update['yaxis.range'];}},host);
function fire(type,fields={}){const e={type,target:node,prevented:0,stopped:0,preventDefault(){this.prevented++;},stopImmediatePropagation(){this.stopped++;},...fields};handlers.get(type)(e);return e;}
const left=fire('pointerdown',{button:0});assert.equal(left.prevented,0,'Left drag still belongs to Plotly');
const middle=fire('pointerdown',{button:1,pointerId:7,clientX:20,clientY:30});assert.equal(middle.prevented,1);assert.equal(middle.stopped,1);assert.equal(capture,7);assert(classes.has('middle-panning'));
assert.equal(fire('mousedown',{button:1}).prevented,1,'Plotly middle-button zoom/autoscroll is suppressed');
fire('pointermove',{pointerId:7,clientX:30,clientY:50});assert.equal(updates.length,0);frames.shift()();
close(updates[0]['xaxis.range'],[-.1,.9]);close(updates[0]['yaxis.range'],[.1,1.1]);
fire('pointerup',{pointerId:7});assert.equal(capture,null);assert(!classes.has('middle-panning'));
assert.equal(fire('keydown',{key:'ArrowRight'}).prevented,1);frames.shift()();close(updates.at(-1)['xaxis.range'],[0,1]);
assert.equal(fire('keydown',{key:'ArrowLeft',ctrlKey:true}).prevented,0);
assert.equal(fire('keydown',{key:'ArrowDown',target:{}}).prevented,0,'Inputs and toolbar controls retain their keys');
assert.equal(fire('pointerdown',{button:1,target:{closest:()=>true}}).prevented,0,'Toolbar controls retain their mouse behavior');
assert(focused>=2);
console.log('PASS middle-button panning, arrow keys, reversed heatmap axes, capture and retained Plotly controls');
