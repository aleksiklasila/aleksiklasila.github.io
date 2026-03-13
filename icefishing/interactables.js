// interactables.js - Unified interaction definitions for world objects

const Interactables = {
    // Returns screen bounds [x, y, w, h] for an object based on its type and world position
    getBounds(type, x, surfaceY) {
        const screen = Game.worldToScreen(x, surfaceY);
        switch (type) {
            case 'gate':
                // Gate is 128x128, centered horizontally, sits on surfaceY
                return { x: screen.x - 64, y: screen.y - 128, w: 128, h: 128 };
            case 'shop':
            case 'repair_shop':
                return { x: screen.x - 64, y: screen.y - 128, w: 128, h: 128 };
            case 'chest':
                return { x: screen.x - 16, y: screen.y - 28, w: 32, h: 28 };
            case 'tombstone':
                return { x: screen.x - 16, y: screen.y - 36, w: 32, h: 36 };
            case 'tent':
                return { x: screen.x - 25, y: screen.y - 36, w: 50, h: 36 };
            case 'torch':
                return { x: screen.x - 12, y: screen.y - 24, w: 24, h: 24 };
            case 'ground_item':
                return { x: screen.x - 12, y: screen.y - 24, w: 24, h: 24 };
            default:
                return null;
        }
    },

    // Check if a screen mouse coordinate is within an object's bounds
    isHit(type, worldX, surfaceY, mouseX, mouseY) {
        const bounds = this.getBounds(type, worldX, surfaceY);
        if (!bounds) return false;
        return mouseX >= bounds.x && mouseX <= bounds.x + bounds.w &&
            mouseY >= bounds.y && mouseY <= bounds.y + bounds.h;
    }
};
