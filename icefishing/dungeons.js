// dungeons.js - Zelda-style Grid Dungeon Generator
const Dungeons = {
    ROOM_SIZE: 120, // 3m x 3m (3 * 40px = 120px)
    ENTRANCE_SPACING: 4000, // roughly 100m
    dungeons: [],

    init() {
        this.dungeons = [];
    },

    canCarveRoom(startX, startSurfaceY, gridX, gridY) {
        if (gridX === 0 && gridY === 0) return true; // Entrance room is allowed

        let roomCenterX = startX + gridX * this.ROOM_SIZE + this.ROOM_SIZE / 2;
        let col = World.getColumnAt(roomCenterX);
        if (!col) return false;

        // roomTopWorldY is the highest worldY the room occupies. 
        // Remember worldY increases upwards.
        let roomTopWorldY = startSurfaceY - (gridY * this.ROOM_SIZE) + 20;

        // Voxel grid bottom is at TOP_Y (500) - GRID_H (300) * SIZE (4) = -700
        // We want to keep rooms safely above -680
        let roomBottomWorldY = startSurfaceY - ((gridY + 1) * this.ROOM_SIZE) - 20;
        if (roomBottomWorldY < -680) {
            return false;
        }

        // For water/ice, col.surfaceY stores the lakebed height (negative)
        // For ground, it stores the ground surface height (positive)
        // We want to ensure the room top is safely below the actual terrain height by at least 40px
        if (roomTopWorldY > col.surfaceY - 40) {
            return false;
        }
        return true;
    },

    buildDungeon(startX, rng) {
        console.log("buildDungeon(" + startX + ", " + rng + ")")
        let surfaceY = World.getSurfaceY(startX);

        let distFromOrigin = Math.abs(startX - (World.WORLD_WIDTH * World.TILE_SIZE / 2));

        // Scale depth and width based on distance
        // Base depth 8 rooms, max depth increases with distance
        let maxDepth = 8 + Math.floor(distFromOrigin / 5000);
        maxDepth = Math.min(maxDepth, 12); // Hard cap to fit in voxel grid depth
        let maxWidth = 15 + Math.floor(distFromOrigin / 4000);

        let grid = {}; // 'x,y' -> true

        // Start carving (0, 0 is entrance, Y going down is positive here for grid logic)
        this.carveRoom(grid, 0, 0); // Entrance room
        this.carveRoom(grid, 0, 1); // Shaft down

        // Explore stack: {x, y, depth} for Depth-First Search Maze Generation
        let stack = [{ x: 0, y: 1, depth: 1 }];

        // Scale total maze capacity with distance
        const MAX_ROOMS = 300 + Math.floor(distFromOrigin / 1000);
        let roomCount = 2; // Entrance and shaft down

        // Bias towards going away from the world center
        const worldCenter = (World.WORLD_WIDTH * World.TILE_SIZE) / 2;
        const awayDir = (startX > worldCenter) ? 1 : -1; // 1 = Right is away, -1 = Left is away

        // Helper to prevent the DFS maze from carving into itself (creating loops)
        // Returns true if the proposed room at (x,y) touches any existing rooms other than its guaranteed parent (ex,ey)
        const hasConnectedNeighbors = (gx, gy, parentX, parentY) => {
            let count = 0;
            if (grid[`${gx + 1},${gy}`]) count++;
            if (grid[`${gx - 1},${gy}`]) count++;
            if (grid[`${gx},${gy + 1}`]) count++;
            if (grid[`${gx},${gy - 1}`]) count++;
            // The guaranteed parent will always be 1 of these adjacent cells length-wise
            return count > 1;
        };

        while (stack.length > 0 && roomCount < MAX_ROOMS) {
            let curr = stack[stack.length - 1]; // Peek at current head of tunnel

            // Find valid, UNVISITED neighbors that do NOT loop back into other tunnels
            let neighbors = [];

            // Dynamic weights to encourage horizontal expansion at the bottom of the dungeon
            // We use a 1-room margin to ensure we don't hit the absolute "maxDepth" abruptly
            let depthMargin = maxDepth - 1;
            let approachingBottom = curr.depth >= depthMargin - 1;
            let canGoDown = curr.depth < depthMargin;

            let weightDown = canGoDown ? (approachingBottom ? 0.2 : 1.0) : 0.0;
            let weightSide = approachingBottom ? 6.0 : 1.2;
            let weightUp = 0.05;

            // Bias the side priority based on direction away from center
            let weightAway = weightSide * 2.5; // Favor expanding further into the wilderness
            let weightBack = weightSide * 0.4;

            // Down
            if (canGoDown) {
                let ny = curr.y + 1;
                if (!grid[`${curr.x},${ny}`] && !hasConnectedNeighbors(curr.x, ny, curr.x, curr.y) && this.canCarveRoom(startX, surfaceY, curr.x, ny)) {
                    neighbors.push({ x: curr.x, y: ny, depth: curr.depth + 1, weight: weightDown });
                }
            }
            // Left
            let nxL = curr.x - 1;
            if (Math.abs(nxL) <= maxWidth && !grid[`${nxL},${curr.y}`] && !hasConnectedNeighbors(nxL, curr.y, curr.x, curr.y) && this.canCarveRoom(startX, surfaceY, nxL, curr.y)) {
                neighbors.push({ x: nxL, y: curr.y, depth: curr.depth, weight: (awayDir === -1 ? weightAway : weightBack) });
            }
            // Right
            let nxR = curr.x + 1;
            if (Math.abs(nxR) <= maxWidth && !grid[`${nxR},${curr.y}`] && !hasConnectedNeighbors(nxR, curr.y, curr.x, curr.y) && this.canCarveRoom(startX, surfaceY, nxR, curr.y)) {
                neighbors.push({ x: nxR, y: curr.y, depth: curr.depth, weight: (awayDir === 1 ? weightAway : weightBack) });
            }
            // Up (Very Low Probability)
            if (curr.depth > 2 && curr.y > 2) {
                let ny = curr.y - 1;
                if (!grid[`${curr.x},${ny}`] && !hasConnectedNeighbors(curr.x, ny, curr.x, curr.y) && this.canCarveRoom(startX, surfaceY, curr.x, ny)) {
                    neighbors.push({ x: curr.x, y: ny, depth: curr.depth - 1, weight: weightUp });
                }
            }

            if (neighbors.length > 0) {
                // Weighted random selection of the next turn
                let totalWeight = neighbors.reduce((acc, n) => acc + n.weight, 0);
                let r = rng() * totalWeight;
                let next = null;
                for (let n of neighbors) {
                    if (r < n.weight) {
                        next = n;
                        break;
                    }
                    r -= n.weight;
                }
                if (!next) next = neighbors[neighbors.length - 1]; // Failsafe

                this.carveRoom(grid, next.x, next.y);
                stack.push(next);
                roomCount++;
            } else {
                // Dead end hit! Backtrack up the tunnel to the previous junction 
                stack.pop();
            }
        }

        this.dungeons.push({
            worldX: startX,
            surfaceY: surfaceY,
            grid: grid // The carved out rooms relative to entrance
        });
    },

    carveRoom(grid, gridX, gridY) {
        console.log("canCarveRoom: " + `${gridX},${gridY}`)
        grid[`${gridX},${gridY}`] = true;
    },

    // Checks if a specific world coordinate falls inside any carved dungeon room
    // Checks if a specific world coordinate falls inside any carved dungeon room
    isCave(worldX, worldY) {
        for (let i = 0; i < this.dungeons.length; i++) {
            let d = this.dungeons[i];

            // Tight bounding box check (X)
            if (Math.abs(worldX - d.worldX) > 8000) continue;

            // Allow checking well above surface to ensure the hole easily punctures the surface island perfectly
            // worldY goes positive *upwards*, so checking y < -20000 is bottom of world
            if (worldY > d.surfaceY + 300) continue;
            if (worldY < -20000) continue;

            // Calculate grid coordinate for this world point
            // Offset diffX so d.worldX sits precisely in the middle of gridX=0
            let diffX = worldX - d.worldX + (this.ROOM_SIZE / 2);
            let diffY = d.surfaceY - worldY; // Positive = deeper underground

            // Explicitly force a massive 80px wide crater right at the entrance to completely bypass grid math!
            if (diffY > -80 && diffY < 80) {
                if (Math.abs(worldX - d.worldX) < 40) return true;
            }

            // Shift grid start up slightly so gridY=0 breaks cleanly through the island bump
            let gridX = Math.floor(diffX / this.ROOM_SIZE);
            let gridY = Math.floor((diffY + 80) / this.ROOM_SIZE); // +80 pushes the "entrance" room physically higher

            if (d.grid[`${gridX},${gridY}`]) {
                let innerGridX = diffX % this.ROOM_SIZE;
                if (innerGridX < 0) innerGridX += this.ROOM_SIZE; // JS modulo fix
                let innerGridY = (diffY + 80) % this.ROOM_SIZE;

                // Add slight organic noise to the tunnel walls
                let noiseX = Perlin.fbm(worldX / 30, worldY / 30, 2, 2.0, 0.5) * 16 - 8;
                let noiseY = Perlin.fbm((worldX + 1000) / 30, (worldY + 1000) / 30, 2, 2.0, 0.5) * 16 - 8;

                let nx = innerGridX + noiseX;
                let ny = innerGridY + noiseY;

                let m1 = 30; // Tunnel starts at 30px
                let m2 = 90; // Tunnel ends at 90px (60px total width / 1.5m)

                let core = (nx >= m1 && nx <= m2 && ny >= m1 && ny <= m2);
                let left = (nx < m1 && ny >= m1 && ny <= m2 && d.grid[`${gridX - 1},${gridY}`]);
                let right = (nx > m2 && ny >= m1 && ny <= m2 && d.grid[`${gridX + 1},${gridY}`]);
                let top = (ny < m1 && nx >= m1 && nx <= m2 && d.grid[`${gridX},${gridY - 1}`]);
                let bottom = (ny > m2 && nx >= m1 && nx <= m2 && d.grid[`${gridX},${gridY + 1}`]);

                // Special handling for the entrance crater to open straight up unconditionally
                let crater = false;
                if (gridX === 0 && gridY === 0) {
                    if (ny < m1 && nx >= m1 && nx <= m2) crater = true;
                }

                if (core || left || right || top || bottom || crater) {
                    return true;
                }
            }
        }
        return false;
    }
};
