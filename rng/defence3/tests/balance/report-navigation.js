'use strict';
(function(root){
 function dragRanges(view,dx,dy){
  const sx=-(dx/view.width)*(view.x[1]-view.x[0]),sy=(dy/view.height)*(view.y[1]-view.y[0]);
  return {x:view.x.map(v=>v+sx),y:view.y.map(v=>v+sy)};
 }
 function keyRanges(view,key,large=false){
  const amount=large ? 0.3 : 0.1,x=[...view.x],y=[...view.y];
  if(key==='ArrowLeft'||key==='ArrowRight'){const step=(x[1]-x[0])*amount*(key==='ArrowRight'?1:-1);return {x:x.map(v=>v+step),y};}
  if(key==='ArrowUp'||key==='ArrowDown'){const step=(y[1]-y[0])*amount*(key==='ArrowUp'?1:-1);return {x,y:y.map(v=>v+step)};}
  return null;
 }
 function attach(node,plotly,host=root){
  let drag=null,pending=null,frame=0;
  function view(){
   const layout=node._fullLayout,xa=layout?.xaxis,ya=layout?.yaxis;
   if(!xa||!ya)return null;
   const x=pending?.x||xa.range,y=pending?.y||ya.range,width=xa._length,height=ya._length;
   if(!x?.every(Number.isFinite)||!y?.every(Number.isFinite)||!(width>0&&height>0))return null;
   return {x:[...x],y:[...y],width,height};
  }
  function pan(ranges){
   pending=ranges;
   if(frame)return;
   frame=host.requestAnimationFrame(()=>{
    frame=0;const next=pending;pending=null;
    if(next)plotly.relayout(node,{'xaxis.range':next.x,'yaxis.range':next.y,'xaxis.autorange':false,'yaxis.autorange':false});
   });
  }
  const toolbar=event=>!!event.target?.closest?.('.modebar');
  const consume=event=>{event.preventDefault();event.stopImmediatePropagation();};
  node.addEventListener('pointerdown',event=>{
   if(toolbar(event))return;
   node.focus({preventScroll:true});
   if(event.button!==1)return;
   consume(event);const start=view();if(!start)return;
   drag={id:event.pointerId,x:event.clientX,y:event.clientY,view:start};
   node.setPointerCapture(event.pointerId);node.classList.add('middle-panning');
  },true);
  // Also suppress Plotly's mouse handler and browser middle-button autoscroll.
  node.addEventListener('mousedown',event=>{if(event.button===1&&!toolbar(event))consume(event);},true);
  node.addEventListener('pointermove',event=>{
   if(!drag||event.pointerId!==drag.id)return;
   consume(event);pan(dragRanges(drag.view,event.clientX-drag.x,event.clientY-drag.y));
  },true);
  function end(event){
   if(!drag||event.pointerId!==drag.id)return;
   const id=drag.id;drag=null;node.classList.remove('middle-panning');
   if(node.hasPointerCapture(id))node.releasePointerCapture(id);
   if(event.type==='pointerup')consume(event);
  }
  for(const type of ['pointerup','pointercancel','lostpointercapture'])node.addEventListener(type,end,true);
  node.addEventListener('keydown',event=>{
   if(event.altKey||event.ctrlKey||event.metaKey||event.target!==node)return;
   const current=view(),ranges=current&&keyRanges(current,event.key,event.shiftKey);
   if(!ranges)return;consume(event);pan(ranges);
  });
 }
 const api={dragRanges,keyRanges,attach};
 if(typeof module==='object'&&module.exports)module.exports=api;else root.FightReportNavigation=api;
})(globalThis);
