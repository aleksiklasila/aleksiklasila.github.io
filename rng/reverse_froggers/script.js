const canvas = document.getElementById('game-canvas');
const ctx = canvas.getContext('2d');

let cw, ch;
function resize() {
    cw = window.innerWidth;
    ch = window.innerHeight;
    canvas.width = cw;
    canvas.height = ch;
}
window.addEventListener('resize', resize);
resize();

// UI Elements
const uiMainMenu = document.getElementById('main-menu');
const uiHud = document.getElementById('hud');
const uiGameOver = document.getElementById('game-over');
const scoreVal = document.getElementById('scoreVal');
const finalScoreVal = document.getElementById('finalScoreVal');
const deathReasonEl = document.getElementById('death-reason');
const startBtn = document.getElementById('start-btn');
const restartBtn = document.getElementById('restart-btn');

function setScreen(screenId) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    if (screenId) document.getElementById(screenId).classList.add('active');
}

// Input and Control State
let leftPressed = false, rightPressed = false, spacePressed = false;
window.addEventListener('keydown', (e) => {
    if (e.code === 'KeyA' || e.code === 'ArrowLeft') {
        if (!leftPressed && gameState === 'PLAYING' && frog.lane > -1) {
            frog.lane--;
        }
        leftPressed = true;
    }
    if (e.code === 'KeyD' || e.code === 'ArrowRight') {
        if (!rightPressed && gameState === 'PLAYING' && frog.lane < 1) {
            frog.lane++;
        }
        rightPressed = true;
    }
    if (e.code === 'Space') {
        e.preventDefault(); // Stop scrolling
        if (gameState !== 'PLAYING') {
            if (!spacePressed) startGame();
        } else {
            if (!spacePressed && !tongue.active && !frog.grappling) {
                fireTongue();
            }
        }
        spacePressed = true;
    }
});
window.addEventListener('keyup', (e) => {
    if (e.code === 'KeyA' || e.code === 'ArrowLeft') leftPressed = false;
    if (e.code === 'KeyD' || e.code === 'ArrowRight') rightPressed = false;
    if (e.code === 'Space') spacePressed = false;
});

startBtn.addEventListener('click', () => { startBtn.blur(); if (gameState !== 'PLAYING') startGame(); });
restartBtn.addEventListener('click', () => { restartBtn.blur(); if (gameState !== 'PLAYING') startGame(); });

// Game Constants
const TILE_SIZE = 260; // Straight length
const PATH_W = 240;
const PATH_R = 120;
const LANE_W = 80;
const FROG_BASE_SPEED = 200;
const TONGUE_RANGE = 200;
const DIR = { UP: 0, RIGHT: 1, DOWN: 2, LEFT: 3 };

function getDirVec(dir) {
    if (dir === 0) return { x: 0, y: -1 };
    if (dir === 1) return { x: 1, y: 0 };
    if (dir === 2) return { x: 0, y: 1 };
    if (dir === 3) return { x: -1, y: 0 };
}

// Global Game State
let gameState = 'MENU';
let score = 0;
let gameSpeedMultiplier = 1.0;
let lastTime = 0;
let timeAlive = 0;

let activeTiles = [];
let nextWorldX = 0;
let nextWorldY = 0;
let currentWorldDir = DIR.UP;
let spawnCount = 0;

let camera = { x: 0, y: 0, angle: 0 };
let frog = {
    tileIndex: 0,
    pathT: 0, // Distance along current tile [0, length]
    lane: 0, // -1, 0, 1
    sideOffset: 0, // Smoothly lerps to lane * LANE_W
    wx: 0, wy: 0, wAngle: 0, // World Position Output
    hopScale: 1,
    grappling: false,
    grappleSpeed: 0,
    dead: false
};
let tongue = { active: false, timer: 0 };

// Base Tile Classes
class Tile {
    constructor() {
        this.worldX = 0;
        this.worldY = 0;
        this.worldDir = DIR.UP;
        this.length = 0;
        this.isLeftTurn = false;
        this.isRightTurn = false;
        this.isStraight = false;
    }
    update(dt) { }
    draw(ctx) { }
    getLocalPos(t, offset) { return { x: 0, y: 0, angle: 0 }; }
    checkCollisionLocal(lx, ly, t, dt) { return null; }
    // Collision helpers
    checkTongueLine(lsx, lsy, lex, ley, bx, by, bw, bh) {
        for (let i = 0; i <= 1; i += 0.1) {
            let px = lsx + (lex - lsx) * i;
            let py = lsy + (ley - lsy) * i;
            if (Math.abs(px - bx) < bw / 2 && Math.abs(py - by) < bh / 2) return true;
        }
        return false;
    }
    checkTongueInteraction(lsx, lsy, lex, ley) { return false; }
}

class TileStraight extends Tile {
    constructor() {
        super();
        this.length = 260;
        this.isStraight = true;
    }
    getLocalPos(t, offset) {
        return { x: offset, y: 130 - t, angle: 0 };
    }
    draw(ctx) {
        ctx.fillStyle = '#1e293b';
        ctx.fillRect(-130, -130, 260, 260);
        ctx.fillStyle = '#cbd5e1';
        ctx.fillRect(-PATH_R, -130, PATH_W, 260);
    }
}

class TileTurnLeft extends Tile {
    constructor() {
        super();
        this.length = 130 * Math.PI / 2;
        this.isLeftTurn = true;
    }
    getLocalPos(t, offset) {
        let a = t / 130;
        return {
            x: -130 + (130 + offset) * Math.cos(a),
            y: 130 - (130 + offset) * Math.sin(a),
            angle: -a
        };
    }
    draw(ctx) {
        ctx.fillStyle = '#1e293b';
        ctx.fillRect(-130, -130, 260, 260);
        ctx.fillStyle = '#cbd5e1';
        ctx.beginPath();
        ctx.moveTo(-PATH_R, 130); ctx.lineTo(PATH_R, 130);
        ctx.arc(PATH_R, -PATH_R, PATH_W, Math.PI / 2, Math.PI, false);
        ctx.lineTo(-130, -PATH_R); ctx.lineTo(-130, PATH_R);
        ctx.arc(-PATH_R, PATH_R, PATH_W, Math.PI, Math.PI / 2, true);
        ctx.fill();
    }
}

class TileTurnRight extends Tile {
    constructor() {
        super();
        this.length = 130 * Math.PI / 2;
        this.isRightTurn = true;
    }
    getLocalPos(t, offset) {
        let a = t / 130;
        return {
            x: 130 - (130 - offset) * Math.cos(a),
            y: 130 - (130 - offset) * Math.sin(a),
            angle: a
        };
    }
    draw(ctx) {
        ctx.fillStyle = '#1e293b';
        ctx.fillRect(-130, -130, 260, 260);
        ctx.fillStyle = '#cbd5e1';
        ctx.beginPath();
        ctx.moveTo(-PATH_R, 130); ctx.lineTo(PATH_R, 130);
        ctx.arc(-PATH_R, -PATH_R, PATH_W, Math.PI / 2, 0, true);
        ctx.lineTo(130, -PATH_R); ctx.lineTo(130, PATH_R);
        ctx.arc(PATH_R, PATH_R, PATH_W, 0, Math.PI / 2, false);
        ctx.fill();
    }
}

// ---------------- Obstacles ----------------

class TileRoadBasic extends TileStraight {
    constructor() {
        super();
        this.cars = [
            { lx: -200, ly: 40, speed: 120, dir: 1, color: '#ef4444', w: 80, h: 45, eaten: false },
            { lx: 200, ly: -40, speed: 100, dir: -1, color: '#3b82f6', w: 80, h: 45, eaten: false }
        ];
    }
    update(dt) {
        for (let car of this.cars) {
            car.lx += car.speed * gameSpeedMultiplier * dt * car.dir;
            if (car.dir > 0 && car.lx > 250) car.lx = -250;
            if (car.dir < 0 && car.lx < -250) car.lx = 250;
        }
    }
    draw(ctx) {
        ctx.fillStyle = '#334155'; ctx.fillRect(-130, -70, 260, 140);
        ctx.fillStyle = '#cbd5e1'; ctx.fillRect(-PATH_R, -130, PATH_W, 60); ctx.fillRect(-PATH_R, 70, PATH_W, 60);

        for (let car of this.cars) {
            if (car.eaten) continue;
            ctx.fillStyle = car.color;
            ctx.fillRect(car.lx - car.w / 2, car.ly - car.h / 2, car.w, car.h);
            ctx.fillStyle = '#0f172a';
            ctx.fillRect(car.lx - car.w / 2 + 10, car.ly - car.h / 2 + 5, car.w - 20, car.h - 10);
        }
    }
    checkCollisionLocal(lx, ly) {
        for (let car of this.cars) {
            if (!car.eaten && Math.abs(lx - car.lx) < car.w / 2 + 15 && Math.abs(ly - car.ly) < car.h / 2 + 15) {
                return "Hit by a car!";
            }
        }
        return null;
    }
    checkTongueInteraction(lsx, lsy, lex, ley) {
        for (let car of this.cars) {
            if (!car.eaten && this.checkTongueLine(lsx, lsy, lex, ley, car.lx, car.ly, car.w, car.h)) {
                car.eaten = true;
                score += 50; scoreVal.innerText = score;
                return true;
            }
        }
        return false;
    }
}

class TileRoadFast extends TileRoadBasic {
    constructor() {
        super();
        this.cars[0].speed = 400; this.cars[0].color = '#eab308';
        this.cars[1].speed = 450; this.cars[1].color = '#f97316';
    }
}

class TileLaser extends TileStraight {
    constructor() {
        super();
        this.laserActive = true;
        this.switchBox = { x: 90, y: -20, w: 40, h: 40 };
    }
    draw(ctx) {
        super.draw(ctx);
        // Switch
        ctx.fillStyle = this.laserActive ? '#ef4444' : '#22c55e';
        ctx.beginPath(); ctx.arc(this.switchBox.x, this.switchBox.y, 15, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#cbd5e1'; ctx.beginPath(); ctx.arc(this.switchBox.x, this.switchBox.y, 8, 0, Math.PI * 2); ctx.fill();

        // Laser emitters
        ctx.fillStyle = '#475569';
        ctx.fillRect(-PATH_R - 10, -15, 20, 30);
        ctx.fillRect(PATH_R - 10, -15, 20, 30);
        if (this.laserActive) {
            ctx.fillStyle = 'rgba(239, 68, 68, 0.8)'; ctx.fillRect(-PATH_R, -8, PATH_W, 16);
            ctx.fillStyle = '#fca5a5'; ctx.fillRect(-PATH_R, -3, PATH_W, 6);
        }
    }
    checkCollisionLocal(lx, ly) {
        if (this.laserActive && Math.abs(ly) < 15) return "Zapped by a laser!";
        return null;
    }
    checkTongueInteraction(lsx, lsy, lex, ley) {
        if (this.laserActive && this.checkTongueLine(lsx, lsy, lex, ley, this.switchBox.x, this.switchBox.y, this.switchBox.w, this.switchBox.h)) {
            this.laserActive = false;
            score += 50; scoreVal.innerText = score;
            return true;
        }
        return false;
    }
}

class TileRiver extends TileStraight {
    constructor() {
        super();
        this.log = { lx: 0, ly: 0, speed: 100, dir: 1, w: Math.max(PATH_W + 40, 160), h: 70 };
        this.postBox = { x: 0, y: -80, w: 50, h: 50 }; // Grapple target is across the river
    }
    update(dt) {
        this.log.lx += this.log.speed * gameSpeedMultiplier * dt * this.log.dir;
        if (this.log.dir > 0 && this.log.lx > 120) this.log.dir = -1;
        if (this.log.dir < 0 && this.log.lx < -120) this.log.dir = 1;
    }
    draw(ctx) {
        super.draw(ctx);
        // River
        ctx.fillStyle = '#0284c7'; ctx.fillRect(-130, -60, 260, 120);
        ctx.fillStyle = '#38bdf8'; ctx.fillRect(-130, -60, 260, 10); ctx.fillRect(-130, 50, 260, 10);

        // Log
        ctx.fillStyle = '#78350f'; ctx.beginPath();
        ctx.roundRect(this.log.lx - this.log.w / 2, this.log.ly - this.log.h / 2, this.log.w, this.log.h, 15); ctx.fill();

        // Grapple Post
        ctx.fillStyle = '#b45309'; ctx.beginPath(); ctx.arc(this.postBox.x, this.postBox.y, 20, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#fef08a'; ctx.beginPath(); ctx.arc(this.postBox.x, this.postBox.y, 10, 0, Math.PI * 2); ctx.fill();
    }
    checkCollisionLocal(lx, ly, t) {
        if (frog.grappling) return null; // Safe in the air
        // Water is from y=-50 to 50
        if (Math.abs(ly) < 50) {
            let onLog = (Math.abs(lx - this.log.lx) < this.log.w / 2 + 10 && Math.abs(ly - this.log.ly) < this.log.h / 2 + 20);
            if (onLog) {
                // Let the log push side offset smoothly
                frog.sideOffset += this.log.speed * gameSpeedMultiplier * 1 / 60 * this.log.dir;
                if (frog.sideOffset > frog.lane * 80 + 40 && frog.lane < 1) frog.lane++;
                if (frog.sideOffset < frog.lane * 80 - 40 && frog.lane > -1) frog.lane--;
                if (Math.abs(frog.sideOffset) > PATH_R) return "Fell off the log into water!";
                return null;
            }
            return "Drowned in the river!";
        }
        return null;
    }
    checkTongueInteraction(lsx, lsy, lex, ley) {
        if (this.checkTongueLine(lsx, lsy, lex, ley, this.postBox.x, this.postBox.y, this.postBox.w, this.postBox.h)) {
            frog.grappling = true;
            frog.grappleSpeed = 600 * gameSpeedMultiplier; // Zip fast!
            score += 50; scoreVal.innerText = score;
            return true;
        }
        return false;
    }
}

class TileConveyor extends TileStraight {
    constructor() {
        super();
        this.bgOffset = 0;
        this.stopped = false;
        this.switchBox = { x: -90, y: 0, w: 40, h: 40 };
    }
    update(dt) {
        if (!this.stopped) {
            this.bgOffset += 160 * gameSpeedMultiplier * dt;
            if (this.bgOffset > 40) this.bgOffset -= 40;
            // Push frog
            if (Math.abs(frog.wy - this.worldY) < 130 && frog.tileIndex === activeTiles.indexOf(this)) {
                frog.sideOffset += 160 * gameSpeedMultiplier * dt;
                if (frog.sideOffset > frog.lane * 80 + 40 && frog.lane < 1) frog.lane++;
                if (frog.sideOffset > PATH_R + 10) frog.dead = true; // Wait, handled in bounds check if necessary. Just let them fall.
            }
        }
    }
    draw(ctx) {
        super.draw(ctx);
        // Switching Box Look
        ctx.fillStyle = this.stopped ? '#22c55e' : '#ef4444';
        ctx.beginPath(); ctx.arc(this.switchBox.x, this.switchBox.y, 15, 0, Math.PI * 2); ctx.fill();

        ctx.fillStyle = '#f59e0b';
        ctx.fillRect(-PATH_R, -130, PATH_W, 260);
        ctx.fillStyle = '#450a0a';
        for (let i = -130 - 40; i < 130 + 40; i += 40) {
            ctx.fillRect(-PATH_R, i + this.bgOffset, PATH_W, 20);
        }
    }
    checkCollisionLocal(lx, ly) {
        if (!this.stopped && Math.abs(lx) > PATH_R + 10) return "Pushed off by conveyor!";
        return null;
    }
    checkTongueInteraction(lsx, lsy, lex, ley) {
        if (!this.stopped && this.checkTongueLine(lsx, lsy, lex, ley, this.switchBox.x, this.switchBox.y, this.switchBox.w, this.switchBox.h)) {
            this.stopped = true;
            score += 50; scoreVal.innerText = score;
            return true;
        }
        return false;
    }
}

class TileDrawbridge extends TileStraight {
    constructor() {
        super();
        this.closed = false; // By default open == PIT!
        this.openPhase = 1;
        this.leverBox = { x: 90, y: 50, w: 40, h: 40 };
    }
    update(dt) {
        if (this.closed) {
            this.openPhase -= dt * 6;
            if (this.openPhase < 0) this.openPhase = 0;
        }
    }
    draw(ctx) {
        super.draw(ctx);
        ctx.fillStyle = '#000'; ctx.fillRect(-130, -50, 260, 100);

        ctx.fillStyle = '#8b5cf6';
        let bridgeLen = 50; let gap = this.openPhase * 100;
        ctx.fillRect(-PATH_R, 50 - bridgeLen, PATH_W, bridgeLen - gap / 2); // Bottom
        ctx.fillRect(-PATH_R, -50 + gap / 2, PATH_W, bridgeLen - gap / 2); // Top

        ctx.fillStyle = this.closed ? '#22c55e' : '#ef4444';
        ctx.beginPath(); ctx.arc(this.leverBox.x, this.leverBox.y, 15, 0, Math.PI * 2); ctx.fill();
    }
    checkCollisionLocal(lx, ly) {
        if (Math.abs(ly) < 30 && this.openPhase > 0.1) return "You fell in the drawbridge pit!";
        return null;
    }
    checkTongueInteraction(lsx, lsy, lex, ley) {
        if (!this.closed && this.checkTongueLine(lsx, lsy, lex, ley, this.leverBox.x, this.leverBox.y, this.leverBox.w, this.leverBox.h)) {
            this.closed = true;
            score += 50; scoreVal.innerText = score;
            return true;
        }
        return false;
    }
}

class TileTrain extends TileStraight {
    constructor() {
        super();
        this.trainX = 600;
        this.timer = 0;
        this.barricadeDown = false;
        this.switchBox = { x: -90, y: 40, w: 40, h: 40 };
    }
    update(dt) {
        if (!this.barricadeDown) {
            this.timer += dt * gameSpeedMultiplier;
            if (this.timer > 0.8) {
                this.trainX -= 2500 * dt;
                if (this.trainX < -600) { this.trainX = 600; this.timer = 0; }
            }
        }
    }
    draw(ctx) {
        super.draw(ctx);
        ctx.fillStyle = '#94a3b8'; ctx.fillRect(-130, -25, 260, 10); ctx.fillRect(-130, 15, 260, 10);
        ctx.fillStyle = '#ef4444'; ctx.fillRect(this.trainX, -40, 350, 80);

        ctx.fillStyle = this.barricadeDown ? '#22c55e' : '#ef4444';
        ctx.beginPath(); ctx.arc(this.switchBox.x, this.switchBox.y, 15, 0, Math.PI * 2); ctx.fill();

        ctx.fillStyle = '#f59e0b';
        ctx.fillRect(-PATH_R - 10, 60, 20, 10); // Post
        if (this.barricadeDown) ctx.fillRect(-PATH_R - 10, 60, PATH_W + 20, 10); // Barrier Down blocking train!
        else ctx.fillRect(-PATH_R - 5, -40, 10, 100); // Barrier Up! (Train passes)
    }
    checkCollisionLocal(lx, ly) {
        if (Math.abs(ly) < 45 && !this.barricadeDown) {
            if (this.trainX < PATH_R && this.trainX + 350 > -PATH_R) return "Hit by the High-Speed Train!";
        }
        return null;
    }
    checkTongueInteraction(lsx, lsy, lex, ley) {
        if (!this.barricadeDown && this.checkTongueLine(lsx, lsy, lex, ley, this.switchBox.x, this.switchBox.y, this.switchBox.w, this.switchBox.h)) {
            this.barricadeDown = true;
            this.trainX = -600; // Poof train gone
            score += 50; scoreVal.innerText = score;
            return true;
        }
        return false;
    }
}

class TileCrocs extends TileStraight {
    constructor() {
        super();
        this.open = true; this.timer = 0; this.stunned = false;
        this.crocBox = { x: 0, y: -10, w: PATH_W, h: 80 };
    }
    update(dt) {
        if (!this.stunned) {
            this.timer += dt * gameSpeedMultiplier;
            if (this.timer > 0.4) { this.open = !this.open; this.timer = 0; }
        }
    }
    draw(ctx) {
        super.draw(ctx);
        ctx.fillStyle = '#166534'; ctx.fillRect(-130, -60, 260, 120);
        ctx.fillStyle = '#cbd5e1'; ctx.globalAlpha = 0.4; ctx.fillRect(-PATH_R, -60, PATH_W, 120); ctx.globalAlpha = 1.0;

        ctx.fillStyle = this.stunned ? '#064e3b' : '#22c55e'; // Darker when stunned
        ctx.fillRect(-PATH_R + 10, -50, PATH_W - 20, 100);

        ctx.fillStyle = '#000';
        if (this.open && !this.stunned) {
            ctx.fillRect(-PATH_R + 20, -40, PATH_W - 40, 80);
            ctx.fillStyle = '#ef4444'; ctx.fillRect(-PATH_R + 30, -20, PATH_W - 60, 40);
            ctx.fillStyle = '#fff';
            for (let i = -PATH_R + 25; i < PATH_R - 25; i += 20) {
                ctx.beginPath(); ctx.moveTo(i, -40); ctx.lineTo(i + 10, -25); ctx.lineTo(i + 20, -40); ctx.fill();
                ctx.beginPath(); ctx.moveTo(i, 40); ctx.lineTo(i + 10, 25); ctx.lineTo(i + 20, 40); ctx.fill();
            }
        } else {
            ctx.fillRect(-PATH_R + 20, 0, PATH_W - 40, 5);
        }
    }
    checkCollisionLocal(lx, ly) {
        if (Math.abs(ly) < 50 && this.open && !this.stunned) return "Chomped by Crocodiles!";
        return null;
    }
    checkTongueInteraction(lsx, lsy, lex, ley) {
        if (!this.stunned && this.checkTongueLine(lsx, lsy, lex, ley, this.crocBox.x, this.crocBox.y, this.crocBox.w, this.crocBox.h)) {
            this.stunned = true;
            score += 50; scoreVal.innerText = score;
            return true;
        }
        return false;
    }
}

class TileBoulders extends TileStraight {
    constructor() {
        super();
        this.boulders = []; this.timer = 0;
    }
    update(dt) {
        this.timer += dt * gameSpeedMultiplier;
        if (this.timer > 0.8) {
            this.boulders.push({ lx: (Math.random() > 0.5 ? -1 : 1) * LANE_W, ly: -150 });
            this.boulders.push({ lx: 0, ly: -150 });
            this.timer = 0;
        }
        for (let i = this.boulders.length - 1; i >= 0; i--) {
            this.boulders[i].ly += 180 * gameSpeedMultiplier * dt;
            if (this.boulders[i].ly > 150) this.boulders.splice(i, 1);
        }
    }
    draw(ctx) {
        super.draw(ctx);
        for (let b of this.boulders) {
            ctx.fillStyle = '#475569';
            ctx.beginPath(); ctx.arc(b.lx, b.ly, 30, 0, Math.PI * 2); ctx.fill();
            ctx.fillStyle = '#64748b'; ctx.beginPath(); ctx.arc(b.lx - 5, b.ly - 5, 10, 0, Math.PI * 2); ctx.fill();
        }
    }
    checkCollisionLocal(lx, ly) {
        for (let b of this.boulders) {
            if (Math.abs(lx - b.lx) < 30 && Math.abs(ly - b.ly) < 30) return "Smashed by a Boulder!";
        }
        return null;
    }
    checkTongueInteraction(lsx, lsy, lex, ley) {
        for (let i = 0; i < this.boulders.length; i++) {
            let b = this.boulders[i];
            if (this.checkTongueLine(lsx, lsy, lex, ley, b.lx, b.ly, 60, 60)) {
                this.boulders.splice(i, 1);
                score += 50; scoreVal.innerText = score;
                return true;
            }
        }
        return false;
    }
}

class TileCrusher extends TileStraight {
    constructor() {
        super();
        this.yPos = -400; this.timer = 0; this.disabled = false;
        this.switchBox = { x: 90, y: 0, w: 40, h: 40 };
    }
    update(dt) {
        if (!this.disabled) {
            this.timer += dt * gameSpeedMultiplier;
            if (this.timer < 1.0) this.yPos = -400;
            else if (this.timer < 1.1) this.yPos = 0;
            else if (this.timer < 1.6) this.yPos -= dt * 800;
            else this.timer = 0;
        } else {
            this.yPos = -400; // Floats away safely
        }
    }
    draw(ctx) {
        super.draw(ctx);
        ctx.fillStyle = this.disabled ? '#22c55e' : '#ef4444';
        ctx.beginPath(); ctx.arc(this.switchBox.x, this.switchBox.y, 15, 0, Math.PI * 2); ctx.fill();

        ctx.fillStyle = 'rgba(0,0,0,0.5)';
        let sr = this.yPos < -20 ? PATH_R - 10 : PATH_R + 10;
        ctx.beginPath(); ctx.ellipse(0, 0, sr, sr, 0, 0, Math.PI * 2); ctx.fill();

        ctx.save();
        ctx.translate(0, this.yPos);
        let sc = Math.max(0.5, 1 - this.yPos / 800); ctx.scale(sc, sc);

        ctx.fillStyle = '#64748b'; ctx.fillRect(-PATH_R - 10, -PATH_R - 10, PATH_W + 20, PATH_W + 20);
        ctx.fillStyle = '#ef4444'; ctx.fillRect(-40, 30, 80, 15);
        ctx.fillStyle = '#f8fafc'; ctx.fillRect(-40, -40, 25, 15); ctx.fillRect(15, -40, 25, 15);
        ctx.restore();
    }
    checkCollisionLocal(lx, ly) {
        if (this.yPos > -10 && Math.abs(lx) < PATH_R && Math.abs(ly) < PATH_R) return "Squashed by Thwomp!";
        return null;
    }
    checkTongueInteraction(lsx, lsy, lex, ley) {
        if (!this.disabled && this.checkTongueLine(lsx, lsy, lex, ley, this.switchBox.x, this.switchBox.y, this.switchBox.w, this.switchBox.h)) {
            this.disabled = true;
            score += 50; scoreVal.innerText = score;
            return true;
        }
        return false;
    }
}

const TILE_OBSTACLES = [
    TileRoadBasic, TileRoadFast, TileLaser, TileRiver,
    TileConveyor, TileDrawbridge, TileTrain, TileCrocs,
    TileBoulders, TileCrusher
];

function addTile() {
    let TileType;
    if (spawnCount === 0) TileType = TileStraight;
    else if (spawnCount !== 0 && spawnCount % 7 === 0) {
        TileType = Math.random() > 0.5 ? TileTurnLeft : TileTurnRight;
    } else {
        TileType = TILE_OBSTACLES[Math.floor(Math.random() * TILE_OBSTACLES.length)];
    }

    let t = new TileType();
    t.worldX = nextWorldX;
    t.worldY = nextWorldY;
    t.worldDir = currentWorldDir;

    let vec = getDirVec(currentWorldDir);
    nextWorldX += vec.x * 260;
    nextWorldY += vec.y * 260;

    if (t.isLeftTurn) currentWorldDir = (currentWorldDir + 3) % 4;
    else if (t.isRightTurn) currentWorldDir = (currentWorldDir + 1) % 4;

    activeTiles.push(t);
    spawnCount++;
}

function initGame() {
    activeTiles = []; nextWorldX = 0; nextWorldY = 0; currentWorldDir = DIR.UP;
    spawnCount = 0; score = 0; scoreVal.innerText = 0;
    gameSpeedMultiplier = 1.0; timeAlive = 0;
    tongue.active = false;

    for (let i = 0; i < 6; i++) addTile();

    frog = {
        tileIndex: 0, pathT: 0, lane: 0, sideOffset: 0,
        wx: activeTiles[0].worldX, wy: activeTiles[0].worldY + 130, wAngle: 0,
        hopScale: 1, grappling: false, grappleSpeed: 0, dead: false
    };
    camera = { x: frog.wx, y: frog.wy, angle: 0 };
}

function fireTongue() {
    tongue.active = true;
    tongue.timer = 0;

    // Tongue points forward (relative to frog's local space UP, which is wAngle)
    let wAngle = frog.wAngle - Math.PI / 2;
    let startX = frog.wx; let startY = frog.wy;
    let endX = startX + Math.cos(wAngle) * TONGUE_RANGE;
    let endY = startY + Math.sin(wAngle) * TONGUE_RANGE;

    // Check interaction with current and NEXT tile
    for (let i = frog.tileIndex; i <= frog.tileIndex + 1; i++) {
        let t = activeTiles[i];
        if (!t) continue;

        let tAngle = -t.worldDir * Math.PI / 2;
        let dsx = startX - t.worldX; let dsy = startY - t.worldY;
        let lsx = dsx * Math.cos(tAngle) - dsy * Math.sin(tAngle);
        let lsy = dsx * Math.sin(tAngle) + dsy * Math.cos(tAngle);

        let dex = endX - t.worldX; let dey = endY - t.worldY;
        let lex = dex * Math.cos(tAngle) - dey * Math.sin(tAngle);
        let ley = dex * Math.sin(tAngle) + dey * Math.cos(tAngle);

        if (t.checkTongueInteraction(lsx, lsy, lex, ley)) break;
    }
}

function gameLoop(now) {
    if (gameState !== 'PLAYING') return;

    let dt = (now - lastTime) / 1000;
    if (dt > 0.1) dt = 0.1;
    lastTime = now;

    timeAlive += dt;
    gameSpeedMultiplier = 1.0 + timeAlive * 0.015;

    for (let t of activeTiles) t.update(dt);

    updateFrog(dt);
    updateCamera(dt);

    if (tongue.active) {
        tongue.timer += dt;
        if (tongue.timer > 0.3) tongue.active = false; // 0.3s tongue animation loop
    }

    while (frog.pathT > activeTiles[frog.tileIndex].length) {
        frog.pathT -= activeTiles[frog.tileIndex].length;
        frog.tileIndex++;
        score += 10;
        scoreVal.innerText = score;
    }

    // Generator
    while (activeTiles.length - frog.tileIndex < 6) addTile();
    // Cleanup old tiles
    while (frog.tileIndex > 2) { activeTiles.shift(); frog.tileIndex--; }

    draw();

    let tile = activeTiles[frog.tileIndex];
    if (tile && !frog.grappling && !frog.dead) {
        let lPos = tile.getLocalPos(frog.pathT, frog.sideOffset);
        let crash = tile.checkCollisionLocal(lPos.x, lPos.y, frog.pathT, dt);
        if (crash) {
            frog.dead = true;
            gameOver(crash);
            return;
        }
    }

    requestAnimationFrame(gameLoop);
}

function updateFrog(dt) {
    let tile = activeTiles[frog.tileIndex];
    if (!tile) return;

    if (frog.grappling) {
        frog.pathT += frog.grappleSpeed * dt;
        if (frog.pathT > tile.length) frog.grappling = false;
    } else {
        frog.pathT += FROG_BASE_SPEED * gameSpeedMultiplier * dt;
    }

    // Lateral Physics
    let targetOffset = frog.lane * LANE_W;
    frog.sideOffset += (targetOffset - frog.sideOffset) * 15 * dt;

    // Calculate Exact Spline transform
    let lPos = tile.getLocalPos(frog.pathT, frog.sideOffset);
    let worldAngle = tile.worldDir * Math.PI / 2;
    frog.wAngle = worldAngle + lPos.angle;
    frog.wx = tile.worldX + lPos.x * Math.cos(worldAngle) - lPos.y * Math.sin(worldAngle);
    frog.wy = tile.worldY + lPos.x * Math.sin(worldAngle) + lPos.y * Math.cos(worldAngle);

    frog.hopScale = 1 + Math.abs(Math.sin(timeAlive * 12 * gameSpeedMultiplier)) * 0.2;
}

function updateCamera(dt) {
    camera.x += (frog.wx - camera.x) * dt * 5;
    camera.y += (frog.wy - camera.y) * dt * 5;

    let targetAngle = frog.wAngle;
    let diff = targetAngle - camera.angle;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    camera.angle += diff * dt * 4;
}

function draw() {
    ctx.fillStyle = '#0f172a';
    ctx.fillRect(0, 0, cw, ch);

    ctx.save();
    ctx.translate(cw / 2, ch / 2);
    ctx.rotate(-camera.angle);
    ctx.translate(-camera.x, -camera.y);

    for (let t of activeTiles) {
        ctx.save();
        ctx.translate(t.worldX, t.worldY);
        ctx.rotate(t.worldDir * Math.PI / 2);
        t.draw(ctx);
        ctx.restore();
    }

    // Tongue Drawing
    if (tongue.active) {
        let prog = tongue.timer / 0.3; // 150ms out, 150ms in
        if (prog < 1) {
            let ext = Math.sin(prog * Math.PI); // Ping-pong interpolation 0->1->0
            let tDirX = Math.cos(frog.wAngle - Math.PI / 2);
            let tDirY = Math.sin(frog.wAngle - Math.PI / 2);
            let ex = frog.wx + tDirX * TONGUE_RANGE * ext;
            let ey = frog.wy + tDirY * TONGUE_RANGE * ext;

            ctx.strokeStyle = '#f43f5e';
            ctx.lineWidth = 14;
            ctx.lineCap = 'round';
            ctx.beginPath();
            ctx.moveTo(frog.wx, frog.wy);
            ctx.lineTo(ex, ey);
            ctx.stroke();

            ctx.fillStyle = '#be123c';
            ctx.beginPath();
            ctx.arc(ex, ey, 10, 0, Math.PI * 2);
            ctx.fill();
        }
    }

    // Draw frog
    ctx.save();
    ctx.translate(frog.wx, frog.wy);
    ctx.rotate(frog.wAngle);

    // Shadow
    ctx.fillStyle = 'rgba(0,0,0,0.4)';
    ctx.beginPath(); ctx.ellipse(0, 0, 20, 25, 0, 0, Math.PI * 2); ctx.fill();

    // Scale Hop relative locally
    ctx.scale(frog.hopScale, frog.hopScale);
    ctx.fillStyle = '#22c55e';
    ctx.beginPath(); ctx.roundRect(-20, -20, 40, 40, 10); ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.beginPath(); ctx.arc(-10, -20, 6, 0, Math.PI * 2); ctx.arc(10, -20, 6, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#0f172a';
    ctx.beginPath(); ctx.arc(-10, -23, 3, 0, Math.PI * 2); ctx.arc(10, -23, 3, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
    ctx.restore();
}

function gameOver(reason) {
    gameState = 'GAMEOVER';
    deathReasonEl.innerText = reason;
    finalScoreVal.innerText = score;
    setScreen('game-over');
}
