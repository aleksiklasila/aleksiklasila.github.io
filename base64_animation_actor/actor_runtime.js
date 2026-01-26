/**
 * ActorRuntime
 * Standalone class that can be used in 2D games.
 * Handles:
 * - Loading resources (images/animations)
 * - State Machine logic
 * - Rendering
 */
class ActorRuntime {
    constructor(config) {
        this.config = config;
        this.images = new Map();

        // State
        this.currentState = this.config.initialState || 'Idle';
        this.currentAnimName = null;
        this.currentAnimFrame = 0;
        this.animTimer = 0;
        this.isLoopFinished = false;

        // Load Resources
        this.loadResources();

        // If no explicit initial state or it's missing, try the first one
        if (!this.config.states[this.currentState]) {
            const keys = Object.keys(this.config.states);
            if (keys.length > 0) this.currentState = keys[0];
        }

        this.setAnimationForState(this.currentState);
    }

    loadResources() {
        if (this.config.resources && this.config.resources.images) {
            for (const [name, src] of Object.entries(this.config.resources.images)) {
                const img = new Image();
                img.src = src;
                this.images.set(name, img);
            }
        }
    }

    update(dt, inputs) {
        // 1. Check Transitions
        if (this.isLoopFinished) {
            const stateDef = this.config.states[this.currentState];
            if (stateDef && stateDef.transitions) {
                for (const trans of stateDef.transitions) {
                    if (this.checkCondition(trans.condition, inputs)) {
                        this.changeState(trans.target);
                        break;
                    }
                }
            }
            // Consume the finished loop event (unless we changed state, which resets it anyway)
            this.isLoopFinished = false;
        }

        // 2. Update Animation
        this.updateAnimation(dt);
    }

    checkCondition(condition, inputs) {
        // If condition is empty or "default", it might be an auto-transition? 
        // For now, let's assume strict key matching based on the requirement "idle if none of w,a,s,d".

        // Input: "No Input" or explicit keys
        if (condition === "No Input" || (Array.isArray(condition) && condition.length === 0)) {
            // Check if ANY relevant keys are pressed.
            // "Relevant" keys could be all known keys in the config, or just checking if input object is empty-ish.
            // Using the input object values:
            const pressed = Object.values(inputs).some(v => v === true);
            return !pressed;
        }

        // Check explicit keys (AND logic: All specified keys must be pressed)
        if (Array.isArray(condition)) {
            for (const key of condition) {
                if (!inputs[key]) return false;
            }
            return true;
        }

        return false;
    }

    changeState(newStateName) {
        if (this.currentState === newStateName) return;
        if (!this.config.states[newStateName]) {
            console.warn(`Attempted to switch to missing state: ${newStateName}`);
            return;
        }

        this.onStateExit(this.currentState);

        this.currentState = newStateName;
        this.setAnimationForState(newStateName);
    }

    setAnimationForState(stateName) {
        const state = this.config.states[stateName];
        if (!state) return;

        // Reset anim
        this.currentAnimName = state.animation;
        this.currentAnimFrame = 0;
        this.animTimer = 0;
        this.isLoopFinished = false;

        this.onStateEnter(stateName);
    }

    onStateEnter(stateName) {
        // Placeholder for future gameplay logic
        // console.log(`Enter state: ${stateName}`);
    }

    onStateExit(stateName) {
        // Placeholder for future gameplay logic
        // console.log(`Exit state: ${stateName}`);
    }

    updateAnimation(dt) {
        const animData = this.config.resources.animations[this.currentAnimName];
        if (!animData) {
            this.isLoopFinished = true; // No animation counts as finished immediately
            return;
        }

        // animData is array of values. 
        // The export from previous tool was base64 encoded JSON array.
        // We assume 'config' passed here has already decoded arrays for animations.

        // Format: [ "img1", 0.04, "img2", 0.1, ... ]
        // We need to find the current item based on frame index.
        // Actually, let's just interpret the command list.

        // Simple interpreter:
        // currentAnimFrame points to index in the array.

        if (this.currentAnimFrame >= animData.length) {
            this.currentAnimFrame = 0; // Loop by default
            this.isLoopFinished = true;
        }

        const item = animData[this.currentAnimFrame];

        // If it's a number, it's a sleep duration
        if (typeof item === 'number') {
            this.animTimer += dt;
            if (this.animTimer >= item) {
                this.animTimer -= item; // keep remainder? or just reset 0? 0 is safer for frame skips.
                this.animTimer = 0;
                this.currentAnimFrame++;
            }
        }
        // If it's a string, it's an image.
        else if (typeof item === 'string') {
            // It's an image to show.
            // We stay on this index? No, we advance immediately to the next item (which is likely a sleep).
            // We just "render" this frame.

            // However, our update loop needs to know if we are "waiting" on a sleep or just "showing" an image.

            // Logic:
            // 1. If at Image, we assume it takes 0 time to "set" the image, so we advance to next immediately.
            // 2. But we need to remember this image to draw it.
            // 3. So we look ahead for Sleep?

            // Better:
            // We keep a "currentImage" property.
            // We iterate until we hit a Sleep or End.

            let infiniteLoopGuard = 0;
            while (true) {
                if (this.currentAnimFrame >= animData.length) {
                    this.currentAnimFrame = 0;
                }

                const cmd = animData[this.currentAnimFrame];

                if (typeof cmd === 'string') {
                    this.currentImage = cmd;
                    this.currentAnimFrame++;
                } else if (typeof cmd === 'number') {
                    // Sleep
                    this.animTimer += dt;
                    if (this.animTimer >= cmd) {
                        this.animTimer = 0; // Reset timer
                        this.currentAnimFrame++;
                        // Continue loop to consume next image immediately
                        dt = 0; // Consumed time
                    } else {
                        // Still sleeping
                        break;
                    }
                }

                infiniteLoopGuard++;
                if (infiniteLoopGuard > 100) break; // Safety
            }
        }
    }

    draw(ctx, x, y) {
        if (!this.currentImage) return;

        const img = this.images.get(this.currentImage);
        if (img && img.complete) {
            // Draw centered
            // Assuming pixel art, disable smoothing in main loop (done in CSS/Canvas context usually)
            ctx.drawImage(img, Math.floor(x - img.width / 2), Math.floor(y - img.height / 2));
        }
    }
}

// Allow usage in both browser (script tag) and maybe Node (module) if needed later.
if (typeof module !== 'undefined' && module.exports) {
    module.exports = ActorRuntime;
}
