const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../src/audio_visual/jukebox.js'), 'utf8');
function instance(host) {
    const nodes = new Map();
    const node = id => {
        if (!nodes.has(id)) nodes.set(id, { value: '', listeners: {}, hidden: false,
            addEventListener(type, fn) { this.listeners[type] = fn; }, setAttribute() {}, focus() {} });
        return nodes.get(id);
    };
    let now = 1000;
    const context = { saveUiSettingsToStorage() {}, applyAudioSettings() { context.jukebox.applyVolume(); }, URL, performance: { now: () => now }, isHost: host, isMultiplayer: true,
        connections: [], wsHostId: 'host', audioEnabled: true, audioVolume: 1, audioBackgroundVolume: .5,
        location: { origin: 'https://example.com' }, localStorage: { getItem() { return null; }, setItem() {} },
        document: { getElementById: node }, setInterval(fn) { context.heartbeat = fn; return 1; },
        YT: { Player: class {
            constructor(id, options) { context.player = this; this.options = options; this.time = 0; }
            setVolume(value) { this.volume = value; } mute() { this.muted = true; } unMute() { this.muted = false; }
            loadVideoById(value) { this.video = value.videoId; this.time = value.startSeconds; this.playing = true; }
            cueVideoById(value) { this.video = value.videoId; this.time = value.startSeconds; this.playing = false; }
            getCurrentTime() { return this.time; } seekTo(value) { this.time = value; }
            playVideo() { this.playing = true; } pauseVideo() { this.playing = false; } stopVideo() { this.playing = false; this.stops = (this.stops || 0) + 1; }
        } }
    };
    context.window = context;
    vm.createContext(context); vm.runInContext(source + '\nthis.jukebox = Jukebox;', context);
    context.jukebox.init(); context.jukebox.start(); context.player.options.events.onReady();
    return { context, box: context.jukebox, node: id => node('jukebox-' + id), advance(ms) { now += ms; } };
}
const host = instance(true), client = instance(false);
const fromClient = { peer: 'client', open: true, send: data => client.box.handle(fromHost, data) };
const fromHost = { peer: 'host', open: true, send: data => host.box.handle(fromClient, data) };
host.context.connections.push(fromClient); client.context.connections.push(fromHost);
client.box.connected(fromHost);
assert.equal(client.box.snapshot().videoId, '9JD2nH4M8Dc');
assert.equal(client.context.player.volume, 20);
for (const bad of ['javascript:alert(1)', 'https://youtube.com.evil.test/watch?v=9JD2nH4M8Dc', 'https://example.com/watch?v=9JD2nH4M8Dc']) assert.equal(host.box.parseLink(bad), null);
client.node('link').value = 'https://youtu.be/M7lc1UVf-VE';
client.node('form').listeners.submit({ preventDefault() {} });
assert.equal(host.box.snapshot().videoId, 'M7lc1UVf-VE');
assert.equal(client.context.player.video, 'M7lc1UVf-VE');
client.node('music').value = '0'; client.node('music').listeners.input();
assert.equal(client.context.player.muted, true); assert.equal(host.context.player.muted, false);
const revision = client.box.snapshot().revision;
assert.deepEqual(Object.keys(host.box.snapshot()).sort(), ['revision', 'videoId']);
client.box.handle({peer:'imposter'}, {type:'JUKEBOX_STATE', state:{videoId:'9JD2nH4M8Dc',revision:999}});
assert.equal(client.box.snapshot().revision, revision);
client.box.handle(fromHost, {type:'JUKEBOX_STATE', state:{videoId:'9JD2nH4M8Dc',revision:0}});
assert.equal(client.box.snapshot().revision, revision);
assert.equal(client.context.player.muted,true);
client.box.connected(fromHost); assert.equal(client.box.snapshot().videoId,host.box.snapshot().videoId);
client.context.player.options.events.onAutoplayBlocked();assert.equal(client.node('enable').hidden,false);
client.node('enable').listeners.click();assert.equal(client.node('enable').hidden,true);
client.node('music').value='70';client.node('music').listeners.input();
assert.equal(client.context.player.playing,true);assert.equal(client.context.player.volume,28);
client.node('effects').value='0';client.node('effects').listeners.input();
assert.equal(client.context.audioVolume,0);assert.equal(client.context.player.volume,28);
const before=client.context.player.stops;client.node('music').value='0';client.node('music').listeners.input();
client.context.heartbeat();client.context.heartbeat();assert.equal(client.context.player.stops,before+1);
host.node('music').value='0';host.node('music').listeners.input();
assert.equal(host.context.player.playing,false);
client.node('music').value='60';client.node('music').listeners.input();
assert.equal(client.context.player.playing,true);
assert.equal(host.context.player.playing,false);
console.log('PASS: shared links, independent local playback, local volumes, host authority, stale packets, URL validation and autoplay recovery.');
