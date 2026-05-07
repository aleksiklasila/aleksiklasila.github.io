"use strict";

// ============================================================
// PARTICLE CLASS
// ============================================================
class Particle {
    constructor(x, y, color) {
        this.x = x; this.y = y; this.prevX = x; this.prevY = y; this.color = color;
        let r = visualRng || rng;
        let a = r() * 6.28, s = r() * 3;
        this.vx = Math.cos(a) * s; this.vy = Math.sin(a) * s;
        this.life = 20 + r() * 15;
    }
    update() { this.prevX = this.x; this.prevY = this.y; this.x += this.vx; this.y += this.vy; this.life--; return this.life > 0; }
    draw(ctx) { ctx.globalAlpha = this.life / 35; ctx.fillStyle = this.color; ctx.fillRect(this.x, this.y, 3, 3); ctx.globalAlpha = 1; }
}
function createExplosion(x, y, c, n) {
    if (particles.length > 500) return;
    for (let i = 0; i < n; i++) particles.push(new Particle(x, y, c));
}
function createDirectedParticles(fromX, fromY, toX, toY, c, n) {
    if (particles.length > 500) return;
    let dx = toX - fromX, dy = toY - fromY;
    let d = Math.hypot(dx, dy) || 1;
    let nx = dx / d, ny = dy / d;
    let r = visualRng || rng;
    for (let i = 0; i < n; i++) {
        let p = new Particle(fromX, fromY, c);
        let spd = 1.5 + r() * 2.5;
        let spread = (r() - 0.5) * 0.6;
        p.vx = (nx + spread * -ny) * spd;
        p.vy = (ny + spread * nx) * spd;
        p.life = 12 + r() * 10;
        particles.push(p);
    }
}