// difficulty.js — Distance-based difficulty scaling (continuous)
const Difficulty = {
    originX: 0, // Set by Game.startNewGame()
    SAFE_ZONE: 50, // columns (meters) of safe zone radius around origin

    // Returns continuous difficulty level:
    //   0 within safe zone (origin ± 50m)
    //   Increases by 1 per 100m beyond the safe zone (smooth, no steps)
    getLevel(worldX) {
        const distCols = Math.abs(worldX - this.originX) / World.TILE_SIZE;
        if (distCols <= this.SAFE_ZONE) return 0;
        return (distCols - this.SAFE_ZONE) / 100;
    },

    // Returns distance from origin in meters (columns)
    getDistance(worldX) {
        return Math.abs(worldX - this.originX) / World.TILE_SIZE;
    },

    // Returns terrain multiplier for world generation (column-based, no player dependency)
    getTerrainMultiplier(colIndex, centerCol) {
        const distFromCenter = Math.abs(colIndex - centerCol);
        if (distFromCenter <= this.SAFE_ZONE) return 1;
        const level = (distFromCenter - this.SAFE_ZONE) / 100;
        return 1 + level * 0.5;
    }
};
