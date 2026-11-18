# Stream Voice Leveler (Firefox add-on)

Equalizer and voice leveler for YouTube (videos, live streams, embeds). Made for
streams where the streamer's voice is much louder than the game or music behind them.

## Load it in Firefox

1. Open `about:debugging#/runtime/this-firefox`
2. **Load Temporary Add-on…** and pick `manifest.json` in this folder
3. Open or reload the YouTube tab and click the toolbar icon

A temporary add-on is removed when Firefox restarts. To keep it, either sign it
as an unlisted add-on on addons.mozilla.org (free, `web-ext sign --channel unlisted`),
or use Firefox Developer Edition / Nightly with `xpinstall.signatures.required = false`
and install a zip of this folder.

## What it does

```
         ┌─ DeepFilterNet3 ─ speech (streamer + game voices) ─ × voice gain ─┐
video ───┤                                                                   ├─ EQ chain (below)
         └─ original − speech = game sounds, music, ambience ─ × game gain ──┘
```

- **Streamer focus** (`separator-worklet.js` + `dfn/`, ~40 ms extra audio delay):
  [DeepFilterNet3](https://github.com/Rikorose/DeepFilterNet), a speech-enhancement
  network of the kind voice-chat apps use for noise suppression, runs as WebAssembly
  inside the audio worklet (~3 ms per 10 ms of audio, ~30 % of one core). It splits
  the sound into *speech* and *the rest* (= original − speech), mixed back as
  `out = gVoice·speech + gGame·rest`. With both gains at 1 that is the original
  sound, so quality stays original and only the balance changes.
  - *Game sounds* (the rest) settle so they sit **Streamer above game** dB under the
    streamer's loud level (at most **Game boost** dB up), and stay there while the
    streamer talks.
  - *Voices*: 0 dB while the streamer talks (the streamer stays as they speak);
    game voices on their own are raised toward the same target.
  - *Streamer detection* runs on the clean speech part: the streamer's mic is louder
    than the game's voices (measured on recorded clips), so a voice within the
    **Detect above** line (default −5 dB) of the streamer's usual loud level counts
    as the streamer. Until the streamer has spoken once, game voices are left as is.
  - **Listen to**: hear only the separated voices or only the game sounds.
  - Videos are taken over only after the model has loaded (~1 s, loading blocks the
    audio thread), so the video plays normally meanwhile.
  - Not "only this streamer's voice": target-speaker extraction models
    (SpeakerBeam-style) are 16 kHz and too heavy for real time in a browser today.
  Defaults are neutral otherwise (flat EQ, no compression).
- **Record buttons** save 10 s of the original audio to
  `Downloads/stream-voice-leveler/clip-<time>-<label>.wav` for tuning.
  `dev/analyze-clips.html?base=<folder url>&clips=a,b,c&timeline=b` runs clips
  back to back through the real chain and prints what the detector did.

```
video ─┬─ lows (below voice band) ──────────────── gain ──┐
       ├─ voice band ─ centre cut ─ voice tamer ── gain ──┼─ EQ curve ─ leveler ─ output ─ limiter
       └─ highs (above voice band) ─────────────── gain ──┘
```

- **Voice tamer**: a compressor on the voice band only (200 Hz to 5 kHz by default;
  drag the blue edges in the graph). Loud speech comes down, quiet parts stay.
- **Background lows/highs**: level of everything outside the voice band, so game
  bass, explosions, music and ambience can be turned up separately.
- **Centre cut**: the voice is usually mixed in the centre; this lowers only the
  centre part of the voice band. Only does anything on stereo audio.
- **Leveler**: compressor on the whole mix with matched gain, so quiet sounds
  come up and loud ones stay where they were.
- **Limiter**: keeps the boosted result from clipping.
- **EQ curve**: 8 draggable points over a live spectrum (grey = original,
  blue = after processing). Hover to see what a range sounds like; hold the right
  mouse button on the graph to hear just that frequency.

Settings are saved and apply to every YouTube tab.

## Files

- `common.js`: defaults, presets, knob-to-compressor mappings
- `dsp.js`: the Web Audio chain (no extension APIs)
- `content.js`: attaches the chain to YouTube's video element
- `popup.*`: the toolbar popup
- `separator-worklet.js`: streamer focus (DeepFilterNet split + remix) and clip recording
- `dfn/`: `svl_dfn.wasm` (built from `native/dfn-wasm`) and the official DeepFilterNet3
  model with its licences (MIT / Apache-2.0)
- `native/dfn-wasm`: Rust wrapper around libDF with plain exports (no wasm-bindgen).
  Build: `cargo build --release --target wasm32-unknown-unknown` (Cargo.lock is
  DeepFilterNet's own, which pins tract 0.21.4), then copy
  `target/wasm32-unknown-unknown/release/svl_dfn.wasm` to `dfn/`
- `background.js`: saves recorded clips to Downloads
- `dev/test-dsp.html`: offline tests of the EQ chain (serve this folder over http
  with `.js` served as `text/javascript`, open it, title shows PASS/FAIL)
- `dev/dfn-node-test.cjs <clip.wav>`: runs the model in Node (speed per hop, delay)
- `dev/popup-preview.html`: the popup with fake data, for working on the UI
