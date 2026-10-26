// Runs in every page before the game's own scripts (playwright addInitScript):
// counts the live WebGL objects (textures, buffers, render targets,
// programs...) so a view switch or a settings change that leaks GPU
// resources shows in the perf fuzzer's memory columns.
(() => {
    if (window.__pfgl) return;
    const C = window.__pfgl = { textures: 0, buffers: 0, framebuffers: 0, renderbuffers: 0, programs: 0, shaders: 0, vaos: 0, samplers: 0, queries: 0, transformFeedbacks: 0, created: 0, deleted: 0 };
    const kinds = [['createTexture', 'deleteTexture', 'textures'], ['createBuffer', 'deleteBuffer', 'buffers'], ['createFramebuffer', 'deleteFramebuffer', 'framebuffers'],
        ['createRenderbuffer', 'deleteRenderbuffer', 'renderbuffers'], ['createProgram', 'deleteProgram', 'programs'], ['createShader', 'deleteShader', 'shaders'],
        ['createVertexArray', 'deleteVertexArray', 'vaos'], ['createSampler', 'deleteSampler', 'samplers'], ['createQuery', 'deleteQuery', 'queries'],
        ['createTransformFeedback', 'deleteTransformFeedback', 'transformFeedbacks']];
    const live = {};
    for (const k of kinds) live[k[2]] = new WeakSet();
    for (const proto of [window.WebGL2RenderingContext && WebGL2RenderingContext.prototype, window.WebGLRenderingContext && WebGLRenderingContext.prototype]) {
        if (!proto) continue;
        for (const [create, del, key] of kinds) {
            const c = proto[create], d = proto[del];
            if (typeof c !== 'function' || typeof d !== 'function') continue;
            proto[create] = function () { const o = c.apply(this, arguments); if (o && !live[key].has(o)) { live[key].add(o); C[key]++; C.created++; } return o; };
            proto[del] = function (o) { if (o && live[key].delete(o)) { C[key]--; C.deleted++; } return d.apply(this, arguments); };
        }
    }
})();
