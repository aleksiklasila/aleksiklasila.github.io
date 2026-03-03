const Assets = {
    images: {},
    processed: {},
    toLoad: [
        { name: 'player', src: 'assets/player.png' },
        { name: 'tree', src: 'assets/tree.png' },
        { name: 'campfire_on', src: 'assets/campfire_on.png' },
        { name: 'fishing_hole', src: 'assets/fishing_hole.png' },
        { name: 'axe', src: 'assets/item_axe.png' },
        { name: 'fishing_rod', src: 'assets/item_fishing_rod.png' },
        { name: 'ice_drill', src: 'assets/item_ice_drill.png' },
        { name: 'flint_steel', src: 'assets/item_flint_steel.png' },
        { name: 'wood', src: 'assets/item_wood.png' },
        { name: 'raw_fish', src: 'assets/item_raw_fish.png' },
        { name: 'cooked_fish', src: 'assets/item_cooked_fish.png' },
        // Fallbacks for large fish variants
        { name: 'raw_fish_large', src: 'assets/item_raw_fish.png' },
        { name: 'cooked_fish_large', src: 'assets/item_cooked_fish.png' }
    ],
    loadedCount: 0,

    init(onComplete) {
        if (this.toLoad.length === 0) {
            onComplete();
            return;
        }

        this.toLoad.forEach(item => {
            const img = new Image();
            img.onload = () => {
                this.images[item.name] = img;
                this.processed[item.name] = this.removeBackground(img);

                this.loadedCount++;
                if (this.loadedCount === this.toLoad.length) {
                    onComplete();
                }
            };
            img.onerror = () => {
                console.error("Failed to load asset: " + item.src);
                this.loadedCount++;
                if (this.loadedCount === this.toLoad.length) {
                    onComplete();
                }
            };
            img.src = item.src;
        });
    },

    // Removes magenta, violet, purple, and similar colored backgrounds from AI-generated assets
    removeBackground(img) {
        const canvas = document.createElement('canvas');
        canvas.width = img.width;
        canvas.height = img.height;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(img, 0, 0);

        try {
            const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
            const data = imageData.data;

            // Sample the four corners to auto-detect background color
            const corners = [
                0, // top-left
                (canvas.width - 1) * 4, // top-right
                (canvas.height - 1) * canvas.width * 4, // bottom-left
                ((canvas.height - 1) * canvas.width + canvas.width - 1) * 4 // bottom-right
            ];

            // Collect corner colors
            const cornerColors = corners.map(i => ({
                r: data[i], g: data[i + 1], b: data[i + 2]
            }));

            // Check if corners are similar (likely background)
            const bgColor = cornerColors[0];
            const cornersSimilar = cornerColors.every(c =>
                Math.abs(c.r - bgColor.r) < 40 &&
                Math.abs(c.g - bgColor.g) < 40 &&
                Math.abs(c.b - bgColor.b) < 40
            );

            for (let i = 0; i < data.length; i += 4) {
                const r = data[i];
                const g = data[i + 1];
                const b = data[i + 2];

                // Check if pixel matches magenta/violet/purple family
                const isMagenta = r > 180 && g < 80 && b > 180;
                const isViolet = r > 100 && r < 200 && g < 80 && b > 150;
                const isPurple = r > 80 && g < 60 && b > 120 && (r + b) > 250 && g < (r + b) / 5;

                // Check if pixel matches detected background color
                const matchesBg = cornersSimilar &&
                    Math.abs(r - bgColor.r) < 30 &&
                    Math.abs(g - bgColor.g) < 30 &&
                    Math.abs(b - bgColor.b) < 30;

                if (isMagenta || isViolet || isPurple || matchesBg) {
                    // Calculate how close we are to the background color for smooth edges
                    let dist;
                    if (matchesBg) {
                        dist = Math.sqrt(
                            (r - bgColor.r) ** 2 +
                            (g - bgColor.g) ** 2 +
                            (b - bgColor.b) ** 2
                        );
                    } else {
                        // Distance from pure magenta
                        dist = Math.sqrt((255 - r) ** 2 + g * g + (255 - b) ** 2);
                    }

                    if (dist < 15) {
                        data[i + 3] = 0; // fully transparent
                    } else if (dist < 50) {
                        // Smooth edge transition
                        data[i + 3] = Math.min(data[i + 3], Math.round((dist - 15) / 35 * 255));
                    }
                }
            }

            ctx.putImageData(imageData, 0, 0);
        } catch (e) {
            console.warn("Could not remove background due to CORS/Tainted Canvas limits.", e);
        }

        return canvas;
    },

    get(name) {
        return this.processed[name] || this.images[name] || null;
    }
};
