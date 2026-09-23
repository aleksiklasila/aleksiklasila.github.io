const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const renderer = fs.readFileSync(path.join(__dirname, '../src/audio_visual/renderer.js'), 'utf8');
const renderer3d = fs.readFileSync(path.join(__dirname, '../src/audio_visual/renderer3d.js'), 'utf8');

assert.match(renderer, /let unitStatus = unit2DTexture \? null : get3DUnitTextureStatus\(u\);/);
assert.match(renderer, /let unitStatus = snake2DTexture \? null : get3DUnitTextureStatus\(unit\);/);
assert.match(renderer, /let unit2DTexture = get3DExact2DTexture\(u, true\);/);
assert.match(renderer, /let snake2DTexture = get3DExact2DTexture\(unit, true\);/);
assert.match(renderer, /top -= labelSprite\.height;/);
assert.match(renderer, /capture\.centerY \* scale/);
assert.doesNotMatch(renderer, /let unit2DTexture = detailedUnit \?/);

assert.doesNotMatch(
    renderer3d,
    /if \(kind === 'barrack'\) for \(let side of \[-1,1\]\) part\(side\*\.40,\.80,-\.36,\.14,\.18,\.14,2\);/
);
assert.match(renderer3d, /panel\(0, \.20, -\.277, \.49, \.49\);/);

console.log('PASS: unit panels use exact 2D renders at every LOD and barrack roof markers are absent.');
