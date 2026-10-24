// Bake shared model views once on an offscreen WebGL context. The live renderer
// owns the final atlas; camera motion only samples its resident textures.
self.window=self;
self.document={createElement:()=>new OffscreenCanvas(64,64)};
importScripts('renderer3d.js?v=20261024-ui5');
const renderer=Object.create(Defence3Renderer3D.prototype);
const color=new OffscreenCanvas(64,64);
const g=color.getContext('2d',{willReadFrequently:true});
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
        gl.texStorage3D(gl.TEXTURE_2D_ARRAY,7,gl.RGBA8,96,96,1);
        gl.texParameteri(gl.TEXTURE_2D_ARRAY,gl.TEXTURE_MIN_FILTER,gl.LINEAR_MIPMAP_LINEAR);
        gl.texParameteri(gl.TEXTURE_2D_ARRAY,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
        this.texture=gl.createTexture();
        this.pixels=new Uint8Array(1024*160*4);
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
        // Capture the final owner color, including the native colored panel.
        const owner=(style.ownerColor||'#c8ced8').slice(1);
        gl.vertexAttrib3f(7,...[0,2,4].map(i=>parseInt(owner.slice(i,i+2),16)/255));
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL,true);gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL,false);
        gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,this.texture);
        gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,panel);
        gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR_MIPMAP_LINEAR);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);gl.generateMipmap(gl.TEXTURE_2D);
        gl.activeTexture(gl.TEXTURE2);gl.bindTexture(gl.TEXTURE_2D_ARRAY,this.side);
        if(style.statusTextureCanvas) {
            gl.texSubImage3D(gl.TEXTURE_2D_ARRAY,0,0,0,0,96,96,1,gl.RGBA,gl.UNSIGNED_BYTE,style.statusTextureCanvas);
        }
        gl.generateMipmap(gl.TEXTURE_2D_ARRAY);
    }
    projection(yaw,pitch,pixels=32,focalPixels=1238) {
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
        // Place the camera at the distance that projects this frame to the
        // target mip's pixel size. Each smaller mip is a new, more distant view.
        const inverseDistance=pixels/(focalPixels*size),dx=cp*s,dy=sp,dz=cp*c;
        const vp=new Float32Array([k*(c+cx*dx*inverseDistance),k*(-sp*s+cy*dx*inverseDistance),-dx/maxDepth,-dx*inverseDistance,
            k*cx*dy*inverseDistance,k*(cp+cy*dy*inverseDistance),-dy/maxDepth,-dy*inverseDistance,
            k*(-s+cx*dz*inverseDistance),k*(-sp*c+cy*dz*inverseDistance),-dz/maxDepth,-dz*inverseDistance, -k*cx,-k*cy,0,1]);
        return {vp,meta:[size,cx,cy,1]};
    }
    bakeBatch(stride,animation,style,cell=32,levels=6,focalPixels=1238) {
        const gl=this.gl,count=stride-1;
        this.sizes=Array.from({length:levels},(_,level)=>cell>>level);
        // Rasterize each mip at its actual pixel size, as the live model is.
        // Rendering tiny mips at 32px and box-reducing them added a second
        // coverage filter on top of MSAA, then atlas filtering averaged those
        // already softened details again. Native-size captures also give panel
        // mip selection and face borders the live shader's pixel derivatives.
        this.sampleScales=this.sizes.map(()=>1);
        this.renderSizes=this.sizes.slice();
        this.sheetStride=this.renderSizes.reduce((sum,size)=>sum+size,0);
        // Every model uses the unit capture path, including a fresh model
        // render for each mip. Static models simply omit additional poses.
        this.sheetRow=Math.max(...this.renderSizes);
        this.sheetWidth=this.sheetStride*16;this.sheetHeight=this.sheetRow*Math.ceil(count/16);
        if(this.sheetCell!==cell||this.sheetViews!==count) {
            this.sheetCell=cell;this.sheetViews=count;
            gl.bindRenderbuffer(gl.RENDERBUFFER,this.color);gl.renderbufferStorageMultisample(gl.RENDERBUFFER,this.samples,gl.RGBA8,this.sheetWidth,this.sheetHeight);
            gl.bindRenderbuffer(gl.RENDERBUFFER,this.depth);gl.renderbufferStorageMultisample(gl.RENDERBUFFER,this.samples,gl.DEPTH_COMPONENT24,this.sheetWidth,this.sheetHeight);
            gl.deleteTexture(this.output);this.output=gl.createTexture();gl.bindTexture(gl.TEXTURE_2D,this.output);
            gl.texStorage2D(gl.TEXTURE_2D,1,gl.RGBA8,this.sheetWidth,this.sheetHeight);
            gl.bindFramebuffer(gl.FRAMEBUFFER,this.resolve);gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,this.output,0);
            this.pixels=new Uint8Array(this.sheetWidth*this.sheetHeight*4);
        }
        const phase=animation?.phase||0,mode=animation?.mode||0,move=animation&&style.unit?1:0,time=animation?.time||0;
        gl.vertexAttrib1f(10,phase);gl.vertexAttrib1f(9,move);gl.vertexAttrib1f(12,-2);
        gl.uniform1f(this.u.animationMode,mode);gl.uniform1f(this.u.rig,Defence3Renderer3D.columnRig(style));gl.uniform1f(this.u.time,time);
        const original=this.data;
        if(animation)this.data={...original,positions:Defence3Renderer3D.columnPose(style,original,phase,mode,move,time)};
        const views=Array.from({length:count},(_,i)=>this.sizes.map(size=>this.projection(...Defence3Renderer3D.columnView(stride,i),size,focalPixels)));
        this.data=original;
        // Match the live context's equal-depth draw precedence for overlapping
        // model surfaces; a fresh WebGL context otherwise defaults to LESS.
        gl.enable(gl.DEPTH_TEST);gl.depthFunc(gl.LEQUAL);gl.disable(gl.BLEND);gl.disable(gl.CULL_FACE);
        {
            gl.bindFramebuffer(gl.FRAMEBUFFER,this.ms);gl.clearColor(0,0,0,0);gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT);
            gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,this.texture);
            for(let i=0;i<count;i++) {
                let left=(i%16)*this.sheetStride,top=Math.floor(i/16)*this.sheetRow;
                for(let level=0;level<this.sizes.length;level++) {
                    const size=this.renderSizes[level];
                    gl.uniformMatrix4fv(this.u.viewProjection,false,views[i][level].vp);
                    gl.uniform1f(this.u.inkScale,this.sampleScales[level]);
                    gl.viewport(left,top,size,size);gl.drawElements(gl.TRIANGLES,this.count,gl.UNSIGNED_INT,0);left+=size;
                }
            }
            gl.bindFramebuffer(gl.READ_FRAMEBUFFER,this.ms);gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER,this.resolve);
            gl.blitFramebuffer(0,0,this.sheetWidth,this.sheetHeight,0,0,this.sheetWidth,this.sheetHeight,gl.COLOR_BUFFER_BIT,gl.NEAREST);
            gl.bindFramebuffer(gl.FRAMEBUFFER,this.resolve);gl.readPixels(0,0,this.sheetWidth,this.sheetHeight,gl.RGBA,gl.UNSIGNED_BYTE,this.pixels);
        }
        if(!this.pixels.some((v,i)=>i%4===3&&v>0))throw Error('Empty GPU snapshot sheet');
        const error=gl.getError();if(error)throw Error('GPU snapshot error '+error);
        return views.map((view,i)=>this.unpack(view[0].meta,(i%16)*this.sheetStride,Math.floor(i/16)*this.sheetRow));
    }
    // Match the live RGBA8 framebuffer. MSAA has already weighted RGB by
    // coverage; average those bytes directly, without another alpha or gamma pass.
    unpack(meta,offsetX,offsetY) {
        const levels=[],pixels=this.pixels;
        let left=0;
        for(let level=0;level<this.sizes.length;level++) {
            const size=this.sizes[level],scale=this.sampleScales[level],renderSize=this.renderSizes[level],n=scale*scale;
            const color=new Uint8ClampedArray(size*size*4);
            for(let y=0;y<size;y++)for(let x=0;x<size;x++) {
                const dst=(y*size+x)*4,sums=[0,0,0,0];
                for(let sy=0;sy<scale;sy++)for(let sx=0;sx<scale;sx++) {
                    const src=((offsetY+renderSize-1-y*scale-sy)*this.sheetWidth+offsetX+x*scale+sx+left)*4;
                    for(let k=0;k<4;k++)sums[k]+=pixels[src+k];
                }
                for(let k=0;k<4;k++)color[dst+k]=Math.round(sums[k]/n);
            }
            levels.push({color,size});left+=renderSize;
        }
        return {levels,meta};
    }
}
let gpu;
try {gpu=new GpuSnapshots();}catch(error){console.warn('GPU snapshot fallback',error);}
let cached;
self.onmessage=({data:job})=>{
    if(job.style) {
        const panel=canvasFrom(job.panel);
        const style=job.style;style.statusTextureCanvas=canvasFrom(job.status);
        const data=Defence3Renderer3D.columnBakeData(style);
        cached={panel,style,data};
        if(data&&gpu)gpu.prepare(data,style,panel);
    }
    const {panel,style,data}=cached,images=[],transfer=[];
    let sheet;
    if(data&&gpu)sheet=gpu.bakeBatch(job.stride,job.animation,style,job.cell,job.levels,job.focalPixels);
    for(let direction=0;direction<job.stride-1;direction++) {
        if(!data){images.push(null);continue;}
        const [yaw,pitch]=Defence3Renderer3D.columnView(job.stride,direction);
        let baked;
        if(gpu)baked=sheet[direction];
        else {
            const posed=job.animation?{...data,positions:Defence3Renderer3D.columnPose(style,data,job.animation.phase,job.animation.mode,style.unit?1:0,job.animation.time)}:data;
            const meta=renderer.bakeColumnModel(g,posed,style,yaw,panel,pitch);
            baked={color:g.getImageData(0,0,64,64).data,meta};
        }
        images.push(baked);
        for(const level of baked.levels||[baked])transfer.push(level.color.buffer);
    }
    self.postMessage({index:job.index,layer:job.layer,images,gpuBaked:!!gpu},transfer);
};
