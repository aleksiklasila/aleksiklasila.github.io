(function () {
    function parseHexColor(color) {
        let normalized = String(color || '').trim();
        let match = normalized.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
        if (!match) return { r: 200, g: 206, b: 216 };
        let hex = match[1];
        if (hex.length === 3) hex = hex.split('').map(ch => ch + ch).join('');
        return {
            r: parseInt(hex.slice(0, 2), 16),
            g: parseInt(hex.slice(2, 4), 16),
            b: parseInt(hex.slice(4, 6), 16)
        };
    }

    function rgbToHex(rgb) {
        let toHex = (value) => Math.max(0, Math.min(255, Math.round(value || 0))).toString(16).padStart(2, '0');
        return `#${toHex(rgb.r)}${toHex(rgb.g)}${toHex(rgb.b)}`;
    }

    function mixHex(colorA, colorB, mix) {
        let a = parseHexColor(colorA);
        let b = parseHexColor(colorB);
        let t = Math.max(0, Math.min(1, Number(mix) || 0));
        return rgbToHex({
            r: a.r + (b.r - a.r) * t,
            g: a.g + (b.g - a.g) * t,
            b: a.b + (b.b - a.b) * t
        });
    }

    function rgba(color, alpha) {
        let rgb = parseHexColor(color);
        return `rgba(${rgb.r},${rgb.g},${rgb.b},${Math.max(0, Math.min(1, Number(alpha) || 0))})`;
    }

    function clamp01(value) {
        return Math.max(0, Math.min(1, Number(value) || 0));
    }

    function getAudioRows(seed, version) {
        let bgGrid = Array.isArray(audioSpatialGridBackground) ? audioSpatialGridBackground : [];
        let waveGrid = Array.isArray(audioSpatialGrid) ? audioSpatialGrid : [];
        let fxGrid = Array.isArray(audioSpatialGridEffects) ? audioSpatialGridEffects : [];
        let rowCount = bgGrid.length;
        let colCount = rowCount > 0 && bgGrid[0] ? bgGrid[0].length : 0;
        let bgIndex = rowCount > 0 ? Math.abs((seed * 17 + version * 3) % rowCount) : 0;
        let waveIndex = waveGrid.length > 0 ? Math.abs((seed * 29 + version * 5 + 7) % waveGrid.length) : 0;
        let fxIndex = fxGrid.length > 0 ? Math.abs((seed * 13 + version * 7 + 11) % fxGrid.length) : 0;
        return {
            colCount,
            bgRow: rowCount > 0 ? bgGrid[bgIndex] : null,
            waveRow: waveGrid.length > 0 ? waveGrid[waveIndex] : null,
            fxRow: fxGrid.length > 0 ? fxGrid[fxIndex] : null,
            energy: Math.max(0, Math.min(1.3, (Number(audioReactiveBackgroundLevel) || 0) / 1.15))
        };
    }

    function sampleRow(row, colCount, index, total) {
        if (!row || colCount <= 0) return 0;
        let sampleX = Math.min(colCount - 1, Math.floor((index / Math.max(1, total - 1)) * (colCount - 1)));
        return Number(row[sampleX]) || 0;
    }

    function buildPalette(baseColor, accentColor) {
        let bright = mixHex(baseColor, '#ffffff', 0.35);
        let hot = mixHex(accentColor, '#ffffff', 0.3);
        let cool = mixHex(accentColor, '#00d8ff', 0.45);
        let warm = mixHex(accentColor, '#ff9a1f', 0.52);
        let deep = mixHex(baseColor, '#000000', 0.7);
        let contrast = mixHex(baseColor, accentColor, 0.5);
        return { baseColor, accentColor, bright, hot, cool, warm, deep, contrast };
    }

    function drawBackdrop(g, size, palette, energy, version, seed) {
        let linear = g.createLinearGradient(0, 0, size, size);
        linear.addColorStop(0, mixHex(palette.baseColor, palette.accentColor, 0.16));
        linear.addColorStop(0.5, palette.deep);
        linear.addColorStop(1, mixHex(palette.deep, palette.contrast, 0.32));
        g.fillStyle = linear;
        g.fillRect(0, 0, size, size);

        let radial = g.createRadialGradient(size * 0.5, size * 0.52, size * 0.04, size * 0.5, size * 0.52, size * 0.72);
        radial.addColorStop(0, rgba(palette.hot, 0.18 + energy * 0.2));
        radial.addColorStop(0.38, rgba(palette.cool, 0.12 + energy * 0.1));
        radial.addColorStop(1, rgba('#000000', 0));
        g.fillStyle = radial;
        g.fillRect(0, 0, size, size);

        g.save();
        g.strokeStyle = rgba(mixHex(palette.contrast, '#ffffff', 0.18), 0.14);
        g.lineWidth = Math.max(1, Math.round(size * 0.012));
        for (let i = -2; i <= 4; i++) {
            let x0 = size * (i * 0.22 + ((version + seed) % 9) * 0.015);
            g.beginPath();
            g.moveTo(x0, 0);
            g.lineTo(x0 + size * 0.55, size);
            g.stroke();
        }
        g.restore();
    }

    function drawFullWidthBars(g, size, palette, rows, topRatio) {
        let count = 14;
        let pad = Math.round(size * 0.08);
        let w = Math.max(3, Math.floor((size - pad * 2) / count));
        let available = size * (topRatio || 0.62);
        for (let i = 0; i < count; i++) {
            let a = sampleRow(rows.bgRow, rows.colCount, i, count);
            let b = sampleRow(rows.waveRow, rows.colCount, i, count);
            let c = sampleRow(rows.fxRow, rows.colCount, i, count);
            let level = clamp01((a * 0.5 + b * 0.3 + c * 0.3) / 1.45);
            let x = pad + i * w;
            let h = Math.max(4, Math.round(available * level));
            let y = size - pad - h;
            let color = i % 3 === 0 ? palette.hot : (i % 3 === 1 ? palette.cool : palette.warm);
            let grad = g.createLinearGradient(x, y, x, size - pad);
            grad.addColorStop(0, rgba('#ffffff', 0.82));
            grad.addColorStop(0.18, rgba(color, 0.88));
            grad.addColorStop(1, rgba(palette.deep, 0.16));
            g.fillStyle = grad;
            g.fillRect(x, y, Math.max(2, w - 1), h);
            g.fillStyle = rgba('#ffffff', 0.12 + level * 0.16);
            g.fillRect(x, y, Math.max(1, Math.round((w - 1) * 0.28)), h);
        }
    }

    function drawWaveRibbon(g, size, palette, rows, color, amp, verticalBias) {
        let count = 18;
        let pad = Math.round(size * 0.08);
        let band = Math.max(2, Math.floor((size - pad * 2) / count));
        g.beginPath();
        for (let i = 0; i < count; i++) {
            let level = clamp01(sampleRow(rows.waveRow || rows.bgRow, rows.colCount, i, count) / 1.5);
            let x = pad + i * band + band * 0.5;
            let y = size * verticalBias - level * size * amp;
            if (i === 0) g.moveTo(x, y);
            else g.lineTo(x, y);
        }
        g.strokeStyle = rgba(color, 0.52 + rows.energy * 0.18);
        g.lineWidth = Math.max(1.5, Math.round(size * 0.02));
        g.stroke();
    }

    function drawCollectorStars(g, size, palette, rows, seed, version) {
        let centerX = size * 0.5;
        let centerY = size * 0.48;
        for (let i = 0; i < 10; i++) {
            let level = clamp01(sampleRow(rows.bgRow, rows.colCount, i, 10) / 1.35);
            let angle = (i / 10) * Math.PI * 2 + version * 0.09 + seed * 0.15;
            let radius = size * (0.12 + level * 0.24);
            let x = centerX + Math.cos(angle) * radius;
            let y = centerY + Math.sin(angle) * radius * 0.7;
            let glow = Math.max(1.5, size * (0.012 + level * 0.018));
            g.fillStyle = rgba(i % 2 === 0 ? palette.hot : palette.cool, 0.28 + level * 0.48);
            g.beginPath();
            g.arc(x, y, glow, 0, Math.PI * 2);
            g.fill();
        }
        g.strokeStyle = rgba('#ffffff', 0.34);
        g.lineWidth = Math.max(1, Math.round(size * 0.014));
        for (let i = 0; i < 5; i++) {
            let angle = version * 0.08 + seed * 0.11 + i * (Math.PI * 0.4);
            let radius = size * (0.16 + i * 0.04);
            g.beginPath();
            g.arc(centerX, centerY, radius, angle, angle + Math.PI * 0.9);
            g.stroke();
        }
    }

    function drawGalaxy(g, size, palette, rows, seed, version) {
        let cx = size * 0.5;
        let cy = size * 0.5;
        for (let arm = 0; arm < 3; arm++) {
            g.beginPath();
            for (let i = 0; i < 22; i++) {
                let t = i / 21;
                let level = clamp01(sampleRow(rows.fxRow || rows.waveRow, rows.colCount, i, 22) / 1.45);
                let angle = version * 0.05 + seed * 0.2 + arm * (Math.PI * 0.66) + t * Math.PI * (1.1 + level * 0.5);
                let radius = size * (0.08 + t * (0.34 + level * 0.1));
                let x = cx + Math.cos(angle) * radius;
                let y = cy + Math.sin(angle) * radius * 0.78;
                if (i === 0) g.moveTo(x, y);
                else g.lineTo(x, y);
            }
            g.strokeStyle = rgba(arm === 0 ? palette.hot : (arm === 1 ? palette.cool : palette.warm), 0.34 + rows.energy * 0.22);
            g.lineWidth = Math.max(1.5, Math.round(size * (0.014 + arm * 0.004)));
            g.stroke();
        }
        g.fillStyle = rgba('#ffffff', 0.65);
        g.beginPath();
        g.arc(cx, cy, Math.max(3, Math.round(size * 0.04)), 0, Math.PI * 2);
        g.fill();
    }

    function drawBlueprint(g, size, palette, rows, version) {
        let pad = Math.round(size * 0.1);
        g.strokeStyle = rgba(palette.cool, 0.26);
        g.lineWidth = Math.max(1, Math.round(size * 0.012));
        for (let i = 0; i <= 5; i++) {
            let x = pad + (i / 5) * (size - pad * 2);
            let y = pad + (i / 5) * (size - pad * 2);
            g.beginPath(); g.moveTo(x, pad); g.lineTo(x, size - pad); g.stroke();
            g.beginPath(); g.moveTo(pad, y); g.lineTo(size - pad, y); g.stroke();
        }
        let scanY = pad + (((version % 120) / 119) * (size - pad * 2));
        g.fillStyle = rgba(palette.hot, 0.18 + rows.energy * 0.12);
        g.fillRect(pad, scanY - 2, size - pad * 2, 4);
        drawWaveRibbon(g, size, palette, rows, palette.hot, 0.22, 0.78);
    }

    function drawPulseMedic(g, size, palette, rows) {
        let y = size * 0.58;
        g.beginPath();
        g.moveTo(size * 0.08, y);
        g.lineTo(size * 0.24, y);
        g.lineTo(size * 0.34, y - size * 0.16);
        g.lineTo(size * 0.45, y + size * 0.12);
        g.lineTo(size * 0.56, y - size * 0.28 * clamp01((rows.energy + 0.2)));
        g.lineTo(size * 0.7, y);
        g.lineTo(size * 0.92, y);
        g.strokeStyle = rgba('#ffffff', 0.72);
        g.lineWidth = Math.max(2, Math.round(size * 0.024));
        g.stroke();
        g.fillStyle = rgba(palette.hot, 0.28);
        g.fillRect(size * 0.43, size * 0.18, size * 0.14, size * 0.44);
        g.fillRect(size * 0.28, size * 0.33, size * 0.44, size * 0.14);
    }

    function drawRecycler(g, size, palette, rows, version) {
        let cx = size * 0.5;
        let cy = size * 0.5;
        let radius = size * 0.22;
        g.lineWidth = Math.max(2, Math.round(size * 0.02));
        for (let i = 0; i < 3; i++) {
            let angle = version * 0.08 + i * (Math.PI * 0.66);
            g.beginPath();
            g.moveTo(cx + Math.cos(angle) * radius, cy + Math.sin(angle) * radius);
            g.lineTo(cx + Math.cos(angle + 0.55) * radius * 1.4, cy + Math.sin(angle + 0.55) * radius * 1.4);
            g.lineTo(cx + Math.cos(angle + 1.1) * radius, cy + Math.sin(angle + 1.1) * radius);
            g.closePath();
            g.strokeStyle = rgba(i === 0 ? palette.warm : (i === 1 ? palette.cool : palette.hot), 0.62);
            g.stroke();
        }
        drawFullWidthBars(g, size, palette, rows, 0.35);
    }

    function drawRoyal(g, size, palette, rows, version) {
        let crownY = size * 0.34;
        g.beginPath();
        g.moveTo(size * 0.18, size * 0.68);
        g.lineTo(size * 0.24, crownY);
        g.lineTo(size * 0.38, size * 0.5);
        g.lineTo(size * 0.5, crownY * 0.78);
        g.lineTo(size * 0.62, size * 0.5);
        g.lineTo(size * 0.76, crownY);
        g.lineTo(size * 0.82, size * 0.68);
        g.closePath();
        g.strokeStyle = rgba('#ffffff', 0.75);
        g.lineWidth = Math.max(2, Math.round(size * 0.024));
        g.stroke();
        g.fillStyle = rgba(palette.warm, 0.18);
        g.fill();
        for (let i = 0; i < 3; i++) {
            let angle = version * 0.06 + i * (Math.PI * 0.66);
            g.beginPath();
            g.arc(size * 0.5, size * 0.48, size * (0.18 + i * 0.08), angle, angle + Math.PI * 0.75);
            g.strokeStyle = rgba(i === 0 ? palette.hot : palette.cool, 0.34 + i * 0.08);
            g.stroke();
        }
    }

    function drawSerpent(g, size, palette, rows, version, seed) {
        for (let line = 0; line < 3; line++) {
            g.beginPath();
            for (let i = 0; i < 18; i++) {
                let t = i / 17;
                let level = clamp01(sampleRow(rows.waveRow || rows.bgRow, rows.colCount, i, 18) / 1.5);
                let x = size * (0.08 + t * 0.84);
                let y = size * (0.25 + line * 0.18) + Math.sin(t * Math.PI * 4 + version * 0.12 + seed * 0.2 + line) * size * (0.035 + level * 0.04);
                if (i === 0) g.moveTo(x, y);
                else g.lineTo(x, y);
            }
            g.strokeStyle = rgba(line === 1 ? palette.hot : palette.cool, 0.42 + rows.energy * 0.14);
            g.lineWidth = Math.max(2, Math.round(size * (0.015 + line * 0.004)));
            g.stroke();
        }
    }

    function drawRadar(g, size, palette, rows, version) {
        let cx = size * 0.5;
        let cy = size * 0.5;
        for (let i = 1; i <= 3; i++) {
            g.beginPath();
            g.arc(cx, cy, size * (0.12 + i * 0.11), 0, Math.PI * 2);
            g.strokeStyle = rgba(i === 3 ? palette.hot : palette.cool, 0.22 + i * 0.08);
            g.lineWidth = Math.max(1, Math.round(size * 0.014));
            g.stroke();
        }
        let angle = version * 0.08;
        g.beginPath();
        g.moveTo(cx, cy);
        g.lineTo(cx + Math.cos(angle) * size * 0.42, cy + Math.sin(angle) * size * 0.42);
        g.strokeStyle = rgba('#ffffff', 0.65);
        g.lineWidth = Math.max(2, Math.round(size * 0.022));
        g.stroke();
        for (let i = 0; i < 5; i++) {
            let level = clamp01(sampleRow(rows.fxRow || rows.waveRow, rows.colCount, i, 5) / 1.5);
            let dotAngle = angle + i * 1.1;
            let radius = size * (0.12 + level * 0.24);
            g.fillStyle = rgba(palette.hot, 0.24 + level * 0.45);
            g.beginPath();
            g.arc(cx + Math.cos(dotAngle) * radius, cy + Math.sin(dotAngle) * radius, Math.max(1.5, size * 0.014), 0, Math.PI * 2);
            g.fill();
        }
    }

    function drawBeamScope(g, size, palette, rows, version) {
        let cx = size * 0.5;
        let cy = size * 0.5;
        g.strokeStyle = rgba('#ffffff', 0.4);
        g.lineWidth = Math.max(1.5, Math.round(size * 0.016));
        g.beginPath(); g.moveTo(cx, size * 0.12); g.lineTo(cx, size * 0.88); g.stroke();
        g.beginPath(); g.moveTo(size * 0.12, cy); g.lineTo(size * 0.88, cy); g.stroke();
        let beamX = size * (0.2 + ((version % 90) / 89) * 0.6);
        g.fillStyle = rgba(palette.hot, 0.2 + rows.energy * 0.18);
        g.fillRect(beamX - 3, size * 0.14, 6, size * 0.72);
        drawWaveRibbon(g, size, palette, rows, palette.cool, 0.18, 0.76);
    }

    function drawFluid(g, size, palette, rows, version, variant) {
        let color = variant === 'lava' ? palette.warm : (variant === 'poison_puddle' ? '#65ff8f' : (variant === 'ice_patch' ? '#c7f5ff' : palette.cool));
        for (let band = 0; band < 4; band++) {
            g.beginPath();
            for (let i = 0; i < 16; i++) {
                let t = i / 15;
                let level = clamp01(sampleRow((band % 2 === 0 ? rows.waveRow : rows.bgRow), rows.colCount, i, 16) / 1.45);
                let x = size * (0.06 + t * 0.88);
                let y = size * (0.26 + band * 0.14) + Math.sin(t * Math.PI * (2.5 + band * 0.6) + version * 0.11 + band) * size * (0.02 + level * 0.03);
                if (i === 0) g.moveTo(x, y);
                else g.lineTo(x, y);
            }
            g.strokeStyle = rgba(color, 0.28 + band * 0.08);
            g.lineWidth = Math.max(2, Math.round(size * (0.014 + band * 0.002)));
            g.stroke();
        }
    }

    function drawWarning(g, size, palette, rows, version) {
        let stripeCount = 6;
        for (let i = -1; i < stripeCount; i++) {
            let x = size * (i * 0.22 + ((version % 80) / 79) * 0.14);
            g.beginPath();
            g.moveTo(x, size * 0.12);
            g.lineTo(x + size * 0.22, size * 0.12);
            g.lineTo(x - size * 0.02, size * 0.88);
            g.lineTo(x - size * 0.24, size * 0.88);
            g.closePath();
            g.fillStyle = rgba(i % 2 === 0 ? palette.warm : palette.hot, 0.28 + rows.energy * 0.12);
            g.fill();
        }
        drawWaveRibbon(g, size, palette, rows, '#ffffff', 0.14, 0.78);
    }

    function drawMineCrystal(g, size, palette, rows, version, kind) {
        let cx = size * 0.5;
        let cy = size * 0.5;
        let pointCount = kind === 'astar_mine' ? 5 : 6;
        for (let ring = 0; ring < 3; ring++) {
            g.beginPath();
            for (let i = 0; i < pointCount; i++) {
                let angle = version * 0.03 + (i / pointCount) * Math.PI * 2 + ring * 0.18;
                let radius = size * (0.14 + ring * 0.1 + clamp01(sampleRow(rows.fxRow || rows.bgRow, rows.colCount, i, pointCount) / 1.5) * 0.04);
                let x = cx + Math.cos(angle) * radius;
                let y = cy + Math.sin(angle) * radius;
                if (i === 0) g.moveTo(x, y);
                else g.lineTo(x, y);
            }
            g.closePath();
            g.strokeStyle = rgba(ring === 1 ? palette.cool : palette.hot, 0.36 + ring * 0.1);
            g.lineWidth = Math.max(2, Math.round(size * (0.016 + ring * 0.003)));
            g.stroke();
        }
    }

    function drawWindows(g, size, palette, rows, version) {
        let cols = 4;
        let rowsCount = 4;
        let padX = size * 0.18;
        let padY = size * 0.18;
        let gapX = size * 0.06;
        let gapY = size * 0.06;
        let winW = size * 0.11;
        let winH = size * 0.1;
        for (let y = 0; y < rowsCount; y++) {
            for (let x = 0; x < cols; x++) {
                let index = y * cols + x;
                let level = clamp01(sampleRow(rows.bgRow, rows.colCount, index, cols * rowsCount) / 1.3);
                let flicker = ((version + index * 9) % 24) < 12 ? 0.12 : 0;
                g.fillStyle = rgba(index % 2 === 0 ? palette.warm : palette.hot, 0.16 + level * 0.42 + flicker);
                g.fillRect(padX + x * (winW + gapX), padY + y * (winH + gapY), winW, winH);
            }
        }
    }

    function drawVisualization(g, options) {
        let size = g.canvas && g.canvas.width ? g.canvas.width : 96;
        let variant = String(options && options.variant || 'default');
        let seed = Number(options && options.seed) || 0;
        let version = Number(options && options.version) || 0;
        let palette = buildPalette(options && options.baseColor || '#88a0c6', options && options.accentColor || '#ffffff');
        let rows = getAudioRows(seed, version);

        g.clearRect(0, 0, size, size);
        drawBackdrop(g, size, palette, rows.energy, version, seed);

        switch (variant) {
            case 'collector':
            case 'astar_collector':
                drawCollectorStars(g, size, palette, rows, seed, version);
                drawFullWidthBars(g, size, palette, rows, 0.28);
                break;
            case 'builder_unit':
            case 'tower_builder':
                drawBlueprint(g, size, palette, rows, version);
                break;
            case 'researcher_unit':
            case 'spawner_research':
                drawGalaxy(g, size, palette, rows, seed, version);
                break;
            case 'healer_unit':
            case 'spawner_healer':
                drawPulseMedic(g, size, palette, rows);
                break;
            case 'salvager_unit':
            case 'spawner_salvager':
                drawRecycler(g, size, palette, rows, version);
                break;
            case 'king':
                drawRoyal(g, size, palette, rows, version);
                break;
            case 'snake':
            case 'snake_segment':
                drawSerpent(g, size, palette, rows, version, seed);
                break;
            case 'tower_watch':
                drawRadar(g, size, palette, rows, version);
                break;
            case 'tower_laser':
            case 'tower_sniper':
                drawBeamScope(g, size, palette, rows, version);
                break;
            case 'tower_fire':
            case 'lava':
                drawFluid(g, size, palette, rows, version, 'lava');
                break;
            case 'tower_water':
            case 'water_puddle':
                drawFluid(g, size, palette, rows, version, 'water_puddle');
                break;
            case 'tower_poison':
            case 'poison_puddle':
                drawFluid(g, size, palette, rows, version, 'poison_puddle');
                break;
            case 'tower_ice':
            case 'ice_patch':
                drawFluid(g, size, palette, rows, version, 'ice_patch');
                break;
            case 'floor_mine':
            case 'tower_sand':
                drawWarning(g, size, palette, rows, version);
                break;
            case 'farm':
            case 'astar_farm':
                drawWaveRibbon(g, size, palette, rows, palette.cool, 0.18, 0.76);
                drawFullWidthBars(g, size, palette, rows, 0.4);
                break;
            case 'house':
                drawWindows(g, size, palette, rows, version);
                break;
            case 'barrack':
                drawFullWidthBars(g, size, palette, rows, 0.58);
                drawWaveRibbon(g, size, palette, rows, palette.hot, 0.2, 0.68);
                break;
            case 'spawner_energy':
            case 'tower_default':
            case 'unit_default':
            case 'tower_elements':
                drawFullWidthBars(g, size, palette, rows, 0.55);
                drawWaveRibbon(g, size, palette, rows, palette.cool, 0.18, 0.72);
                break;
            case 'spawner_astar':
                drawCollectorStars(g, size, palette, rows, seed, version);
                drawGalaxy(g, size, palette, rows, seed + 3, version);
                break;
            case 'gold_mine':
                drawMineCrystal(g, size, palette, rows, version, 'gold_mine');
                break;
            case 'astar_mine':
                drawMineCrystal(g, size, palette, rows, version, 'astar_mine');
                break;
            default:
                drawFullWidthBars(g, size, palette, rows, 0.52);
                drawWaveRibbon(g, size, palette, rows, palette.hot, 0.16, 0.74);
                break;
        }

        g.strokeStyle = rgba(mixHex(palette.contrast, '#ffffff', 0.3), 0.5);
        g.lineWidth = Math.max(2, Math.round(size * 0.024));
        g.strokeRect(1.5, 1.5, size - 3, size - 3);
    }

    window.Defence3SideAudioVisualizations = {
        draw: drawVisualization
    };
})();