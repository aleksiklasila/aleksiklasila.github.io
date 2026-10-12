// Bake shared model views once on an offscreen WebGL context. The live renderer
// owns the final atlas; camera motion only samples its resident textures.
self.window=self;
self.document={createElement:()=>new OffscreenCanvas(64,64)};
importScripts('renderer3d.js?v=20261012-lod12');
const renderer=Object.create(Defence3Renderer3D.prototype);
const color=new OffscreenCanvas(64,64),mask=new OffscreenCanvas(64,64);
const g=color.getContext('2d',{willReadFrequently:true}),m=mask.getContext('2d',{willReadFrequently:true});
const canvasFrom=bitmap=>{
    if(!bitmap)return null;
    const canvas=new OffscreenCanvas(bitmap.width,bitmap.height);
    canvas.getContext('2d').drawImage(bitmap,0,0);bitmap.close();return canvas;
};

class GpuSnapshots {
    constructor() {
        const gl=this.gl=new OffscreenCanvas(64,32).getContext('webgl2',{alpha:true,antialias:false,premultipliedAlpha:false});
        if(!gl)throw Error('Offscreen WebGL2 unavailable');
        renderer.gl=gl;renderer.createFigureProgram();
        this.program=renderer.figureProgram;this.u=renderer.figureUniforms;
        this.samples=Math.min(4,gl.getParameter(gl.MAX_SAMPLES));
        this.ms=gl.createFramebuffer();gl.bindFramebuffer(gl.FRAMEBUFFER,this.ms);
        this.color=gl.createRenderbuffer();gl.bindRenderbuffer(gl.RENDERBUFFER,this.color);
        gl.renderbufferStorageMultisample(gl.RENDERBUFFER,this.samples,gl.RGBA8,1024,160);
        gl.framebufferRenderbuffer(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.RENDERBUFFER,this.color);
        this.depth=gl.createRenderbuffer();gl.bindRenderbuffer(gl.RENDERBUFFER,this.depth);
        gl.renderbufferStorageMultisample(gl.RENDERBUFFER,this.samples,gl.DEPTH_COMPONENT24,1024,160);
        gl.framebufferRenderbuffer(gl.FRAMEBUFFER,gl.DEPTH_ATTACHMENT,gl.RENDERBUFFER,this.depth);
        this.resolve=gl.createFramebuffer();gl.bindFramebuffer(gl.FRAMEBUFFER,this.resolve);
        this.output=gl.createTexture();gl.bindTexture(gl.TEXTURE_2D,this.output);
        gl.texStorage2D(gl.TEXTURE_2D,1,gl.RGBA8,1024,160);
        gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,this.output,0);
        this.side=gl.createTexture();gl.bindTexture(gl.TEXTURE_2D_ARRAY,this.side);
        gl.texStorage3D(gl.TEXTURE_2D_ARRAY,7,gl.RGBA8,64,64,1);
        gl.texParameteri(gl.TEXTURE_2D_ARRAY,gl.TEXTURE_MIN_FILTER,gl.LINEAR_MIPMAP_LINEAR);
        gl.texParameteri(gl.TEXTURE_2D_ARRAY,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
        this.textures=[gl.createTexture(),gl.createTexture()];
        this.pixels=[new Uint8Array(1024*160*4),new Uint8Array(1024*160*4)];
    }
    prepare(data,style,panel) {
        const gl=this.gl;
        if(this.vao)gl.deleteVertexArray(this.vao);
        for(const buffer of this.buffers||[])gl.deleteBuffer(buffer);
        this.buffers=[];this.vao=gl.createVertexArray();gl.bindVertexArray(this.vao);
        const buffer=(target,array)=>{const b=gl.createBuffer();this.buffers.push(b);gl.bindBuffer(target,b);gl.bufferData(target,ArrayBuffer.isView(array)?array:new Float32Array(array),gl.STATIC_DRAW);};
        for(const [index,size,array] of [[0,3,data.positions],[1,3,data.normals],[2,2,data.uvs],[13,4,data.details]]) {
            buffer(gl.ARRAY_BUFFER,array);gl.enableVertexAttribArray(index);gl.vertexAttribPointer(index,size,gl.FLOAT,false,0,0);
        }
        buffer(gl.ELEMENT_ARRAY_BUFFER,data.indices);this.count=data.indices.length;
        this.sx=style.scaleX;this.sy=style.scaleY*(style.bakeHeight||1);this.data=data;
        gl.vertexAttrib4f(3,this.sx,0,0,0);gl.vertexAttrib4f(4,0,this.sy,0,0);
        gl.vertexAttrib4f(5,0,0,this.sx,0);gl.vertexAttrib4f(6,0,0,0,1);
        gl.vertexAttrib1f(8,1);gl.vertexAttrib1f(9,0);gl.vertexAttrib1f(10,0);
        const hex=(style.color||'#aaaaaa').replace('#','');
        const rgb=hex.length===3?hex.split('').map(x=>parseInt(x+x,16)/255):[0,2,4].map(i=>parseInt(hex.slice(i,i+2),16)/255);
        gl.vertexAttrib3f(11,...rgb);gl.vertexAttrib1f(12,1);gl.vertexAttrib1f(14,0);gl.vertexAttrib1f(15,style.statusTextureCanvas?0:-1);
        gl.useProgram(this.program);const u=this.u;
        gl.uniform1f(u.layerAlpha,1);gl.uniform1f(u.isUnit,style.unit?1:0);
        gl.uniform1f(u.isFlying,Defence3Renderer3D.columnFlying(style)?1:0);
        gl.uniform1f(u.useAtlas,0);gl.uniform1i(u.topTexture,0);gl.uniform1i(u.sideTexture,1);gl.uniform1i(u.atlas,2);gl.uniform1i(u.walkSurface,3);
        // White/black ownership renders recover the exact per-channel tint
        // contribution, including antialiased panel strokes and face outlines.
        const ctx=panel.getContext('2d'),white=ctx.getImageData(0,0,64,64),black=ctx.getImageData(0,0,64,64);
        const owner=panel._ownerMask.getContext('2d').getImageData(0,0,64,64).data;
        for(let i=0;i<black.data.length;i+=4)for(let k=0;k<3;k++)black.data[i+k]*=1-owner[i]/255;
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL,true);gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL,false);
        for(let pass=0;pass<2;pass++) {
            const canvas=new OffscreenCanvas(64,64);canvas.getContext('2d').putImageData(pass?black:white,0,0);
            gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,this.textures[pass]);
            gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,canvas);
            gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR_MIPMAP_LINEAR);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
            gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);gl.generateMipmap(gl.TEXTURE_2D);
        }
        gl.activeTexture(gl.TEXTURE2);gl.bindTexture(gl.TEXTURE_2D_ARRAY,this.side);
        if(style.statusTextureCanvas)gl.texSubImage3D(gl.TEXTURE_2D_ARRAY,0,0,0,0,64,64,1,gl.RGBA,gl.UNSIGNED_BYTE,style.statusTextureCanvas);
        gl.generateMipmap(gl.TEXTURE_2D_ARRAY);
    }
    projection(yaw,pitch) {
        const gl=this.gl,c=Math.cos(yaw),s=Math.sin(yaw),sp=Math.sin(pitch),cp=Math.cos(pitch),P=this.data.positions;
        let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity,maxDepth=1;
        for(let i=0;i<P.length;i+=3) {
            const x=P[i]*this.sx,z=P[i+2]*this.sx;
            let y=P[i+1]*this.sy;
            if(this.data.details[i/3*4]===4&&this.data.normals[i+1]>.5)y+=.02*(1-Math.min(1,this.sy));
            const px=c*x-s*z,py=cp*y-sp*(s*x+c*z);
            minX=Math.min(minX,px);maxX=Math.max(maxX,px);minY=Math.min(minY,py);maxY=Math.max(maxY,py);
            maxDepth=Math.max(maxDepth,Math.abs(sp*y+cp*(s*x+c*z))+1);
        }
        const size=Math.max(maxX-minX,maxY-minY)*1.12,cx=(minX+maxX)/2,cy=(minY+maxY)/2,k=2/size;
        const vp=new Float32Array([k*c,-k*sp*s,-cp*s/maxDepth,0, 0,k*cp,-sp/maxDepth,0, -k*s,-k*sp*c,-cp*c/maxDepth,0, -k*cx,-k*cy,0,1]);
        return {vp,meta:[size,cx,cy,1]};
    }
    bakeBatch(stride,animation,style) {
        const gl=this.gl,count=stride-1;
        this.sizes=[32,16,8,4];
        const phase=animation?.phase||0,mode=animation?.mode||0,move=animation&&style.unit?1:0,time=animation?.time||0;
        gl.vertexAttrib1f(10,phase);gl.vertexAttrib1f(9,move);gl.vertexAttrib1f(12,-2);
        gl.uniform1f(this.u.animationMode,mode);gl.uniform1f(this.u.rig,Defence3Renderer3D.columnRig(style));gl.uniform1f(this.u.time,time);
        const original=this.data;
        if(animation)this.data={...original,positions:Defence3Renderer3D.columnPose(style,original,phase,mode,move,time)};
        const views=Array.from({length:count},(_,i)=>this.projection(...Defence3Renderer3D.columnView(stride,i)));
        this.data=original;
        gl.enable(gl.DEPTH_TEST);gl.disable(gl.BLEND);gl.disable(gl.CULL_FACE);
        for(let pass=0;pass<2;pass++) {
            gl.bindFramebuffer(gl.FRAMEBUFFER,this.ms);gl.clearColor(0,0,0,0);gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT);
            gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,this.textures[pass]);gl.vertexAttrib3f(7,pass?0:1,pass?0:1,pass?0:1);
            for(let i=0;i<count;i++) {
                gl.uniformMatrix4fv(this.u.viewProjection,false,views[i].vp);
                let left=(i%16)*64,top=Math.floor(i/16)*32;
                for(const size of this.sizes) {
                    gl.viewport(left,top,size,size);gl.drawElements(gl.TRIANGLES,this.count,gl.UNSIGNED_INT,0);left+=size;
                }
            }
            gl.bindFramebuffer(gl.READ_FRAMEBUFFER,this.ms);gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER,this.resolve);
            gl.blitFramebuffer(0,0,1024,160,0,0,1024,160,gl.COLOR_BUFFER_BIT,gl.NEAREST);
            gl.bindFramebuffer(gl.FRAMEBUFFER,this.resolve);gl.readPixels(0,0,1024,160,gl.RGBA,gl.UNSIGNED_BYTE,this.pixels[pass]);
        }
        if(!this.pixels[0].some((v,i)=>i%4===3&&v>0))throw Error('Empty GPU snapshot sheet');
        const error=gl.getError();if(error)throw Error('GPU snapshot error '+error);
        return views.map((view,i)=>this.unpack(view.meta,(i%16)*64,Math.floor(i/16)*32));
    }
    unpack(meta,offsetX,offsetY) {
        const levels=[],[white,black]=this.pixels;
        let left=0;
        for(const size of this.sizes) {
            const color=new Uint8ClampedArray(size*size*4),mask=new Uint8ClampedArray(color.length);
            for(let y=0;y<size;y++)for(let x=0;x<size;x++) {
                const src=((offsetY+size-1-y)*1024+offsetX+x+left)*4,dst=(y*size+x)*4,alpha=white[src+3];
                for(let k=0;k<3;k++) {
                    color[dst+k]=alpha?white[src+k]*255/alpha:0;
                    mask[dst+k]=white[src+k]?Math.max(0,white[src+k]-black[src+k])*255/white[src+k]:0;
                }
                color[dst+3]=mask[dst+3]=alpha;
            }
            levels.push({color,mask,size});left+=size;
        }
        return {levels,meta};
    }
}
let gpu;
try {gpu=new GpuSnapshots();}catch(error){console.warn('GPU snapshot fallback',error);}
self.onmessage=({data:job})=>{
    const panel=canvasFrom(job.panel);panel._ownerMask=canvasFrom(job.ownerMask);
    const style=job.style;style.statusTextureCanvas=canvasFrom(job.status);
    const data=Defence3Renderer3D.columnBakeData(style),images=[],transfer=[];
    let sheet;
    if(data&&gpu){gpu.prepare(data,style,panel);sheet=gpu.bakeBatch(job.stride,job.animation,style);}
    for(let direction=0;direction<job.stride-1;direction++) {
        if(!data){images.push(null);continue;}
        const [yaw,pitch]=Defence3Renderer3D.columnView(job.stride,direction);
        let baked;
        if(gpu)baked=sheet[direction];
        else {
            const meta=renderer.bakeColumnModel(g,m,data,style,yaw,panel,pitch);
            baked={color:g.getImageData(0,0,64,64).data,mask:m.getImageData(0,0,64,64).data,meta};
        }
        images.push(baked);
        for(const level of baked.levels||[baked])transfer.push(level.color.buffer,level.mask.buffer);
    }
    self.postMessage({index:job.index,images,gpuBaked:!!gpu},transfer);
};
