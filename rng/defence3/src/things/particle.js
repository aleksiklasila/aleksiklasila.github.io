"use strict";

// ============================================================
// PARTICLE CLASS
// ============================================================
class Particle {
    constructor(x, y, color) {
        this.x = x; this.y = y; this.prevX = x; this.prevY = y; this.color = color;
        let r = visualRng || Math.random;
        let a = r() * 6.28, s = r() * 3;
        this.vx = Math.cos(a) * s; this.vy = Math.sin(a) * s;
        this.life = 20 + r() * 15;
        // Rendered height of a hop (debris thrown up and falling back);
        // derived, so the visual RNG sequence is unchanged.
        this.hop = 0.12 + s * 0.1;
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
    let r = visualRng || Math.random;
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

// ============================================================
// COMBAT EFFECTS (visual only)
// ============================================================
// Attacks, shots and hits append a short record to a fixed ring; the
// renderers animate each record from its start tick. Nothing here is read by
// the simulation, snapshots or hashes, and recording never allocates.
const COMBAT_FX_CAPACITY = 4096;
const COMBAT_FX_STRIDE = 8; // kind, x0, y0, x1, y1, start tick, variant, seed
const COMBAT_FX = {
    SLASH: 1, DUAL: 2, SMASH: 3, CAST: 4, BEAM: 5, SWOOP: 6, SCOUT: 7, SPIT: 8,
    DIG: 9, MUZZLE: 10, IMPACT: 11, CLEAVE: 12
};
// Variants: element / projectile styles shared by casts, shots and hits.
const COMBAT_FX_STYLE = {
    default: 0, fire: 1, water: 2, ice: 3, poison: 4, laser: 5, pistol: 6, smg: 7,
    sniper: 8, sand_gun: 9, elements: 10, watch_tower: 11, king: 12, boss: 13, tank: 14, building: 15
};
const combatFxData = new Float64Array(COMBAT_FX_CAPACITY * COMBAT_FX_STRIDE);
let combatFxHead = 0;
let combatFxSerial = 0;

function recordCombatFx(kind, x0, y0, x1, y1, style) {
    let o = combatFxHead * COMBAT_FX_STRIDE;
    combatFxData[o] = kind;
    combatFxData[o + 1] = x0; combatFxData[o + 2] = y0;
    combatFxData[o + 3] = x1; combatFxData[o + 4] = y1;
    combatFxData[o + 5] = typeof gameTime === 'number' ? gameTime : 0;
    combatFxData[o + 6] = COMBAT_FX_STYLE[style] || (typeof style === 'number' ? style : 0);
    combatFxData[o + 7] = (combatFxSerial = (combatFxSerial + 1) | 0) & 1023;
    combatFxHead = (combatFxHead + 1) % COMBAT_FX_CAPACITY;
}

function clearCombatFx() {
    combatFxData.fill(0);
    combatFxHead = 0;
}

// A unit's attack as an effect. Melee and caster styles differ by role, so
// units of one purpose share a look and others are told apart at a glance.
function recordUnitAttackFx(unit, target) {
    let style = unit.attackStyle, type = unit.unitType;
    let kind = COMBAT_FX.SLASH, variant = 'default';
    if (style === 'fire' || style === 'water' || style === 'ice' || style === 'poison') { kind = COMBAT_FX.CAST; variant = style; }
    else if (style === 'laser') { kind = COMBAT_FX.BEAM; variant = 'laser'; }
    else if (style === 'swoop') kind = type === 'scout' ? COMBAT_FX.SCOUT : COMBAT_FX.SWOOP;
    else if (style === 'ram') kind = COMBAT_FX.SPIT;
    else if (type === 'mole') kind = COMBAT_FX.DIG;
    else if (type === 'fast') kind = COMBAT_FX.DUAL;
    else if (type === 'tank' || type === 'boss') { kind = COMBAT_FX.SMASH; variant = type; }
    else if (type === 'king') { kind = COMBAT_FX.CLEAVE; variant = 'king'; }
    recordCombatFx(kind, unit.x, unit.y, target.x, target.y, variant);
}
