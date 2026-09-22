const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const main = fs.readFileSync(path.join(__dirname, '../src/main.js'), 'utf8');
const renderer = fs.readFileSync(path.join(__dirname, '../src/audio_visual/renderer.js'), 'utf8');
const renderer3d = fs.readFileSync(path.join(__dirname, '../src/audio_visual/renderer3d.js'), 'utf8');

assert.match(main, /function createCurrentViewPointTester\(\)/);
assert.match(main, /projectWorldToScreenDetailed\(tileX, lift, tileY\)/);
assert.match(main, /projected\.ndcZ < -1 \|\| projected\.ndcZ > 1/);
assert.doesNotMatch(main, /function isWorldPointInCurrentView\(/);

assert.match(renderer3d, /getGroundFrustumPolygon\(snapshot\)/);
assert.match(renderer3d, /let footprint = this\.getGroundFrustumPolygon\(snapshot\);/);
assert.match(renderer, /renderer3dInstance\.getGroundFrustumPolygon\(get3DProjectionSnapshot\(\)\)/);
assert.match(renderer, /if \(!drew3DFrustum\)/);

console.log('PASS: 3D same-type selection, render bounds, and minimap use the active camera frustum.');
