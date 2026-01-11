
const MARKET_SIZE = 6;
let marketCards = [];
let gameState = {
    shopLevel: 1,
    wave: 1,
    money: 1000,
    hp: 20
};

// Mock CARD_TYPES (simplified w/ necessary props)
const CARD_TYPES = {
    pistol: { name: "Pistol", price: 50, weight: 1 },
    smg: { name: "SMG", price: 50, weight: 0.2 },
    missile: { name: "Missile", price: 150, weight: 1 },
    poison: { name: "Poison", price: 80, weight: 1 },
    sand: { name: "Sand", price: 30, weight: 1 },
    salvage: { name: "Salvage", price: 20, weight: 0.2 },
    nuke: { name: "Nuke", price: 50, weight: 0.15 },
    heart: { name: "Heart", price: 80, weight: 0.15, hpCost: 5 },
    sacrifice: { name: "Sacrifice", price: 0, hpCost: 5, weight: 0.15 },
    shop_up: { name: "Shop Up", price: 150, weight: 0.2 }
};

function updateUI() { }

// Paste the function under test
function generateMarket() {
    let newCards = new Array(MARKET_SIZE).fill(null);

    // Keep locked cards in their exact positions
    for (let i = 0; i < MARKET_SIZE; i++) {
        if (marketCards[i] && marketCards[i].locked && !marketCards[i].bought) {
            newCards[i] = marketCards[i];
        }
    }

    // Boss Shop Up Guarantee
    let hasShopUp = newCards.some(c => c && c.type === 'shop_up');
    // Wave N is ending, generating for N+1. Bosses are at 3, 6, 9.
    if ((gameState.wave + 1) % 3 === 0 && !hasShopUp) {
        let emptyIndices = [];
        for (let i = 0; i < MARKET_SIZE; i++) if (!newCards[i]) emptyIndices.push(i);

        if (emptyIndices.length > 0) {
            let idx = emptyIndices[Math.floor(Math.random() * emptyIndices.length)];
            let basePrice = CARD_TYPES['shop_up'].price;
            let price = Math.floor(basePrice * gameState.shopLevel);
            let level = gameState.shopLevel + 1;
            newCards[idx] = { type: 'shop_up', bought: false, locked: false, level: level, price: price };
        }
    }

    let keys = Object.keys(CARD_TYPES);

    // Calculate total weight
    let totalWeight = 0;
    keys.forEach(k => totalWeight += (CARD_TYPES[k].weight || 1));

    // Fill empty slots
    for (let i = 0; i < MARKET_SIZE; i++) {
        if (newCards[i] === null) {
            let r = Math.random() * totalWeight;
            let selectedType = keys[0];
            let currentW = 0;

            for (let k of keys) {
                currentW += (CARD_TYPES[k].weight || 1);
                if (r <= currentW) {
                    selectedType = k;
                    break;
                }
            }

            // Calculate Level and Price
            let level = 1;
            let price = CARD_TYPES[selectedType].price; // Base

            if (selectedType === 'shop_up') {
                price = Math.floor(price * gameState.shopLevel);
                level = gameState.shopLevel + 1; // Visual mostly
            } else {
                // Weighted Random for Shop Level
                // Favors current shopLevel
                let pool = [];
                for (let l = 1; l <= gameState.shopLevel; l++) {
                    // Weight = 1 / 2^(shopLevel - l)
                    // l=shopLevel => 1/1 = 1
                    // l=shopLevel-1 => 1/2 = 0.5
                    let weight = 1 / Math.pow(2, gameState.shopLevel - l);
                    pool.push({ l: l, w: weight });
                }
                let totalW = pool.reduce((a, b) => a + b.w, 0);
                let rL = Math.random() * totalW;
                let sumL = 0;
                for (let p of pool) {
                    sumL += p.w;
                    if (rL <= sumL) {
                        level = p.l;
                        break;
                    }
                }
                // Scale Price
                if (CARD_TYPES[selectedType].hpCost) {
                    // HP Cost doesn't scale for now or linear?
                    // Let's scale it linear
                    // price is 0 for sacrifice, but hpCost is defined.
                    // We deal with price storage here.
                } else {
                    price = price * level;
                }
            }

            newCards[i] = { type: selectedType, bought: false, locked: false, level: level, price: price };
        }
    }
    marketCards = newCards;
    updateUI();
}

// TESTS
console.log("Running Tests...");
let passed = 0;
let total = 0;

function assert(cond, msg) {
    total++;
    if (cond) {
        passed++;
    } else {
        console.error("FAIL: " + msg);
    }
}

// Test 1: Wave 2 (Next is 3 -> Boss)
gameState.wave = 2;
marketCards = [];
// Run 100 times to ensure consistency
let failCount = 0;
for (let i = 0; i < 100; i++) {
    generateMarket();
    if (!marketCards.some(c => c.type === 'shop_up')) failCount++;
}
assert(failCount === 0, "Shop Up missing in Wave 2 generation");

// Test 2: Wave 5 (Next is 6 -> Boss)
gameState.wave = 5;
failCount = 0;
for (let i = 0; i < 100; i++) {
    generateMarket();
    if (!marketCards.some(c => c.type === 'shop_up')) failCount++;
}
assert(failCount === 0, "Shop Up missing in Wave 5 generation");

// Test 3: Wave 1 (Next is 2 -> Normal)
gameState.wave = 1;
// Should NOT be 100% guaranteed (but can appear randomly)
// It's acceptable if it appears, but we want to verify the logic didn't force it.
// To verify logic didn't force it, we can't easily check black-box.
// But we can check if it appears less than 100% of the time?
// Random chance is small.
let hasIt = 0;
for (let i = 0; i < 1000; i++) {
    generateMarket();
    if (marketCards.some(c => c.type === 'shop_up')) hasIt++;
}
// Expectation: it's rare. Weight 0.2 vs ~5.5 total. 6 slots.
// Prob of NOT getting it in one slot: 1 - (0.2/5.5) ~= 0.96.
// Prob of NOT getting it in 6 slots: 0.96^6 ~= 0.78.
// So prob of getting it is ~22%.
console.log("Wave 1 appearance rate: " + (hasIt / 1000));
assert(hasIt < 900, "Shop Up appears too often in normal wave (suspiciously high)");

console.log(`Passed ${passed}/${total} tests.`);
