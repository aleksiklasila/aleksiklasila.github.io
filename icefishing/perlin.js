// perlin.js — Classic 2D Perlin Noise
const Perlin = (() => {
    const p = new Uint8Array(512);
    const perm = new Uint8Array(512);

    function seed(s) {
        // Simple seeded RNG (xorshift32)
        let state = s | 0 || 1;
        function rand() {
            state ^= state << 13;
            state ^= state >> 17;
            state ^= state << 5;
            return (state >>> 0) / 4294967296;
        }
        const vals = new Uint8Array(256);
        for (let i = 0; i < 256; i++) vals[i] = i;
        // Fisher-Yates shuffle
        for (let i = 255; i > 0; i--) {
            const j = (rand() * (i + 1)) | 0;
            [vals[i], vals[j]] = [vals[j], vals[i]];
        }
        for (let i = 0; i < 256; i++) {
            p[i] = p[i + 256] = vals[i];
            perm[i] = perm[i + 256] = vals[i];
        }
    }

    // 2D gradients
    const grad2 = [
        [1, 1], [-1, 1], [1, -1], [-1, -1],
        [1, 0], [-1, 0], [0, 1], [0, -1]
    ];

    // 3D gradients
    const grad3 = [
        [1, 1, 0], [-1, 1, 0], [1, -1, 0], [-1, -1, 0],
        [1, 0, 1], [-1, 0, 1], [1, 0, -1], [-1, 0, -1],
        [0, 1, 1], [0, -1, 1], [0, 1, -1], [0, -1, -1],
        [1, 1, 0], [-1, 1, 0], [0, -1, 1], [0, -1, -1]
    ];

    function dot2(g, x, y) {
        return g[0] * x + g[1] * y;
    }

    function dot3(g, x, y, z) {
        return g[0] * x + g[1] * y + g[2] * z;
    }

    function fade(t) {
        return t * t * t * (t * (t * 6 - 15) + 10);
    }

    function lerp(a, b, t) {
        return a + t * (b - a);
    }

    function noise2D(x, y) {
        const X = Math.floor(x) & 255;
        const Y = Math.floor(y) & 255;
        const xf = x - Math.floor(x);
        const yf = y - Math.floor(y);
        const u = fade(xf);
        const v = fade(yf);

        const aa = perm[perm[X] + Y] & 7;
        const ab = perm[perm[X] + Y + 1] & 7;
        const ba = perm[perm[X + 1] + Y] & 7;
        const bb = perm[perm[X + 1] + Y + 1] & 7;

        const x1 = lerp(dot2(grad2[aa], xf, yf), dot2(grad2[ba], xf - 1, yf), u);
        const x2 = lerp(dot2(grad2[ab], xf, yf - 1), dot2(grad2[bb], xf - 1, yf - 1), u);

        return lerp(x1, x2, v);
    }

    function fbm(x, y, octaves = 4, lacunarity = 2.0, gain = 0.5) {
        let sum = 0;
        let amp = 1;
        let freq = 1;
        let max = 0;
        for (let i = 0; i < octaves; i++) {
            sum += noise2D(x * freq, y * freq) * amp;
            max += amp;
            amp *= gain;
            freq *= lacunarity;
        }
        return sum / max;
    }

    function noise3D(x, y, z) {
        const X = Math.floor(x) & 255;
        const Y = Math.floor(y) & 255;
        const Z = Math.floor(z) & 255;

        const xf = x - Math.floor(x);
        const yf = y - Math.floor(y);
        const zf = z - Math.floor(z);

        const u = fade(xf);
        const v = fade(yf);
        const w = fade(zf);

        const A = perm[X] + Y, AA = perm[A] + Z, AB = perm[A + 1] + Z;
        const B = perm[X + 1] + Y, BA = perm[B] + Z, BB = perm[B + 1] + Z;

        const x1 = lerp(dot3(grad3[perm[AA] & 15], xf, yf, zf), dot3(grad3[perm[BA] & 15], xf - 1, yf, zf), u);
        const x2 = lerp(dot3(grad3[perm[AB] & 15], xf, yf - 1, zf), dot3(grad3[perm[BB] & 15], xf - 1, yf - 1, zf), u);
        const y1 = lerp(x1, x2, v);

        const x3 = lerp(dot3(grad3[perm[AA + 1] & 15], xf, yf, zf - 1), dot3(grad3[perm[BA + 1] & 15], xf - 1, yf, zf - 1), u);
        const x4 = lerp(dot3(grad3[perm[AB + 1] & 15], xf, yf - 1, zf - 1), dot3(grad3[perm[BB + 1] & 15], xf - 1, yf - 1, zf - 1), u);
        const y2 = lerp(x3, x4, v);

        return lerp(y1, y2, w);
    }

    function fbm3D(x, y, z, octaves = 4, lacunarity = 2.0, gain = 0.5) {
        let sum = 0;
        let amp = 1;
        let freq = 1;
        let max = 0;
        for (let i = 0; i < octaves; i++) {
            sum += noise3D(x * freq, y * freq, z * freq) * amp;
            max += amp;
            amp *= gain;
            freq *= lacunarity;
        }
        return sum / max;
    }

    // Initialize with default seed
    seed(42);

    return { noise2D, fbm, noise3D, fbm3D, seed };
})();
