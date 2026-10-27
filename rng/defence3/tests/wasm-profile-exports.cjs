// Keep export/function indices with a profile so later binary rebuilds cannot
// mislabel numeric V8 WASM frames. Internal stripped functions stay numeric.
'use strict';
module.exports=function wasmProfileExports(base64){
 const b=Buffer.from(base64,'base64'),names={};let p=8;
 const leb=()=>{let n=0,shift=0,x;do{x=b[p++];n|=(x&127)<<shift;shift+=7;}while(x&128);return n>>>0;};
 while(p<b.length){
  const id=b[p++],length=leb(),end=p+length;
  if(id===7){const n=leb();for(let i=0;i<n;i++){
   const size=leb(),name=b.subarray(p,p+size).toString();p+=size;
   const kind=b[p++],index=leb();if(kind===0)names[index]=names[index]?names[index]+'/'+name:name;
  }}
  p=end;
 }
 return names;
};
