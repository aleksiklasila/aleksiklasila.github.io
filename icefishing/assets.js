const Assets = {
    images: {},
    processed: {},
    toLoad: [
        { name: 'player_idle', src: 'assets/player_idle.png' },
        { name: 'player_walk', src: 'assets/player_walk.png' },
        { name: 'tree', src: 'assets/tree.png' },
        { name: 'campfire_anim', src: 'assets/campfire_anim.png' },
        { name: 'campfire_on', src: 'assets/campfire_on.png' },
        { name: 'campfire_off', src: 'assets/campfire_off.png' },
        { name: 'shop', src: 'assets/shop.png' },
        { name: 'repair_shop', src: 'assets/repair_shop.png' },
        { name: 'axe', src: 'assets/item_axe.png' },
        { name: 'hammer', src: 'assets/item_hammer.png' },
        { name: 'fishing_rod', src: 'assets/item_fishing_rod.png' },
        { name: 'ice_drill', src: 'assets/item_ice_drill.png' },
        { name: 'scoop', src: 'assets/item_scoop.png' },
        { name: 'flint_steel', src: 'assets/item_flint_steel.png' },
        { name: 'tent', src: 'assets/item_tent.png' },
        { name: 'money', src: 'assets/item_money.png' },
        { name: 'wood', src: 'assets/item_wood.png' },
        { name: 'raw_fish', src: 'assets/item_raw_fish.png' },
        { name: 'cooked_fish', src: 'assets/item_cooked_fish.png' },
        // Fallbacks for large fish variants
        { name: 'raw_fish_large', src: 'assets/item_raw_fish.png' },
        { name: 'cooked_fish_large', src: 'assets/item_cooked_fish.png' },
        { name: 'torch', src: 'assets/item_torch.png' },
        { name: 'torch_off', src: 'assets/item_torch_off.png' },
        { name: 'fish_egg', src: 'assets/item_fish_egg.png' },
        { name: 'tree_egg', src: 'assets/item_tree_egg.png' },
        { name: 'polar_bear_egg', src: 'assets/polar_bear_egg.png' },
        { name: 'shovel', src: 'assets/item_shovel.png' },
        { name: 'simple_bridge', src: 'assets/item_simple_bridge.png' },
        { name: 'pickaxe', src: 'assets/pickaxe.png' },
        { name: 'rock', src: 'assets/rock.png' },
        { name: 'item_rock', src: 'assets/item_rock.png' },
        { name: 'anvil', src: 'assets/anvil.png' },
        { name: 'chest', src: 'assets/chest.png' },
        { name: 'item_chest', src: 'assets/item_chest.png' },
        { name: 'tombstone', src: 'assets/tombstone.png' },
        { name: 'gate_open', src: 'assets/gate_open.png' },
        { name: 'gate_closed', src: 'assets/gate_closed.png' },
        { name: 'shotgun', src: 'assets/shotgun.png' },
        { name: 'hide', src: 'assets/hide.png' },
        { name: 'zombie', src: 'assets/zombie.png' },
        { name: 'polar_bear', src: 'assets/polar_bear.png' }
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

    // Removes near-magenta background (r >= 250, g <= 5, b >= 250) from assets
    removeBackground(img) {
        return img;
    },

    get(name) {
        return this.processed[name] || this.images[name] || null;
    }
};
