const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (relativePath) => fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');
const renderer = read('src/audio_visual/renderer.js');
const renderer3d = read('src/audio_visual/renderer3d.js');
const audio = read('src/audio_visual/audio.js');
const unit = read('src/things/unit.js');
const worker = read('src/things/worker.js');

for (const mode of [1, 2, 3, 4, 5, 6]) {
    assert.match(renderer, new RegExp(`mode: ${mode}`), `3D activity mode ${mode} should be produced`);
    assert.match(renderer3d, new RegExp(`animationMode == ${mode}\\.0`), `3D activity mode ${mode} should animate the rig`);
}

assert.match(renderer3d, /uniform float uAnimationMode;/);
assert.match(renderer3d, /anim:\$\{Number\(object\.animationMode\) \|\| 0\}/);
assert.match(renderer, /pushUnit3DActivityEffects\(objects, u, activity/);

for (const weapon of [
    'king_sword', 'great_axe', 'warhammer', 'dual_blades', 'fire_staff', 'water_staff',
    'ice_staff', 'poison_staff', 'laser_staff', 'hammer', 'pickaxe', 'cutter',
    'healer_staff', 'research_orb', 'talons', 'claws'
]) {
    assert.match(renderer, new RegExp(`'${weapon}'`), `${weapon} should be assigned to a unit role`);
    assert.match(renderer3d, new RegExp(`weapon === '${weapon}'|weapon === \\"${weapon}\\"|:${weapon}`), `${weapon} needs 3D geometry`);
}
// Idle rest poses: units that stood still settle (workers sit, mounts graze).
assert.match(renderer, /mode: 7, amount:/, 'idle pose is produced');
assert.match(renderer3d, /animationMode == 7\.0/, 'idle pose animates the rig');
assert.match(renderer3d, /function poseFigureVertex/, 'picking mirrors the animated pose');
// Roles have their own body plans; related roles share one.
for (const kind of ["'rider:dual_blades'", "'griffin:javelin'", "'balloon:medic'", "'drone:instruments'", '`knight:', '`ogre:', '`mage:']) {
    assert.ok(renderer3d.includes(kind), `${kind} body plan`);
}
assert.match(renderer3d, /if \(\/_resistant\$\/\.test\(type\)\) return `mage:/, 'every elemental caster is a mage');
assert.match(renderer, /if \(activity\.mode === 3\) return;/);
assert.match(renderer, /u\.unitType === 'collector'[\s\S]*?'#f0a52b'/);
assert.match(renderer, /cell\.item\.type === 'house' \? 0\.82 : 0\.14/);
assert.doesNotMatch(renderer3d, /serpent:car|snake_segment/, 'snakes render their head only');
assert.match(renderer3d, /return 'serpent:engine'/);
assert.match(renderer3d, /return 'item:house'/);
assert.match(renderer3d, /Paired medical booms are mounted to the wing roots/);
assert.match(renderer3d, /Flying fighters carry slim forward blades on top of their wings/);
assert.match(renderer3d, /let humanoid = kind === 'figure' \|\| kind === 'heavy' \|\| kind === 'knight' \|\| kind === 'ogre' \|\| kind === 'mage' \|\| kind === 'worker'/);
assert.match(renderer3d, /let equipmentYaw = humanoid \? Math\.PI \* \.5 : 0/);
assert.match(renderer3d, /part\(x, y, z, sx, sy, sz, surface, joint, pivot, taper, equipmentYaw\)/);
assert.match(renderer3d, /wp\(\.47,\.71,\.16,\.21,\.66,\.055,1,handJoint,handPivot,\.18\)/);

for (const cue of ['attack_swing', 'attack_cast', 'collector_work', 'astar_work', 'salvager_work']) {
    assert.match(audio, new RegExp(`${cue}: \\[`), `${cue} needs a procedural recipe`);
}
for (const weaponCue of ['weapon_sword', 'weapon_axe', 'weapon_hammer', 'weapon_daggers']) {
    assert.match(audio, new RegExp(`${weaponCue}: \\[`));
}
assert.match(unit, /playSound\(attackCue, this\.x, this\.y, this\.unitType\)/);
assert.match(worker, /playSound\(u\.workerType === 'astar_collector' \? 'astar_work' : 'collector_work'/);
assert.match(worker, /playSound\('salvager_work'/);

console.log('PASS: 3D profession/attack animations and their shared audio cues are wired.');
