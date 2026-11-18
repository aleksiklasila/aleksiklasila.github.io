'use strict';
// Streamer focus with real separation.
//
// DeepFilterNet3 (speech enhancement network, the same kind of model voice
// chat apps use for noise suppression; runs here as WebAssembly) splits the
// stream into
//   speech = everything voice-like (streamer + game characters)
//   rest   = original - speech (game sounds, music, ambience)
// and the two are mixed back:
//   out = gSpeech * speech + gRest * rest
// With both gains at 1 the output is the original sound (just delayed), so the
// quality stays original and only the balance changes.
//
// gRest: game sounds slowly settle so they sit `level` dB under the streamer's
//        loud level, and stay there while the streamer talks.
// gSpeech: 0 dB while the streamer talks (the streamer stays as they are);
//        game voices on their own are raised toward the same target.
// Streamer detection runs on the clean speech part: the streamer's mic is
// louder than the game's voices (measured ~6+ dB on recorded clips), so a
// voice within `margin` dB of the streamer's usual loud level is the streamer.
//
// Also records the incoming (unprocessed) audio on request, for tuning.
class Separator extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const po = (options && options.processorOptions) || {};
    // solo: 0 = mix, 1 = speech part only, 2 = everything-else part only
    this.p = { boost: 12, trigger: 19, level: 4, solo: 0, ...(po.params || {}) };
    this.ready = false;
    this.error = '';
    this.rec = null;
    this.hopsSinceReport = 0;
    this.port.onmessage = (e) => {
      const d = e.data || {};
      if (d.type === 'params') Object.assign(this.p, d.params);
      else if (d.type === 'record') {
        const frames = Math.round(Math.min(60, Math.max(1, d.seconds || 10)) * sampleRate);
        this.rec = { L: new Float32Array(frames), R: new Float32Array(frames), pos: 0, label: d.label || 'clip' };
      }
    };
    if (sampleRate !== 48000) {
      this.fail('needs a 48 kHz audio context, got ' + sampleRate);
      return;
    }
    if (!po.wasm || !po.model) {
      this.fail('model files missing');
      return;
    }
    // Compile off the audio callback; pass audio through untouched until ready.
    WebAssembly.instantiate(po.wasm, {}).then((res) => this.init(res.instance, po.model)).catch((err) => this.fail(String(err && err.message || err)));
  }

  fail(msg) {
    this.error = msg;
    this.port.postMessage({ type: 'error', error: msg });
  }

  init(instance, modelBuf) {
    const x = instance.exports;
    const model = new Uint8Array(modelBuf);
    const ptr = x.svl_alloc(model.length);
    new Uint8Array(x.memory.buffer, ptr, model.length).set(model);
    const st = x.svl_create(ptr, model.length, 100);
    x.svl_free(ptr, model.length);
    if (!st) { this.fail('model failed to load'); return; }
    this.x = x;
    this.st = st;
    const hop = (this.hop = x.svl_hop(st));
    this.inPtr = x.svl_input_ptr(st);
    this.outPtr = x.svl_output_ptr(st);
    // Model delay: STFT (fft - hop = hop for DFN3) plus look-ahead frames.
    this.modelDelay = hop + x.svl_lookahead(st) * hop + (this.p.delayAdjust || 0);
    // Hop buffering: collect `hop` input samples, process, play them out on the
    // following blocks. Dry (stereo) goes through a delay line matching the model.
    this.fill = 0;
    this.inL = new Float32Array(hop); this.inR = new Float32Array(hop);
    this.ring = 1 << Math.ceil(Math.log2(this.modelDelay + hop * 2 + 1));
    this.dL = new Float32Array(this.ring); this.dR = new Float32Array(this.ring);
    this.dPos = 0;
    this.outL = new Float32Array(hop); this.outR = new Float32Array(hop);
    this.outPos = hop; // nothing queued yet -> silence for the first hop

    const hopSec = hop / sampleRate;
    const tc = (s) => 1 - Math.exp(-hopSec / s);
    this.k = {
      lvl: tc(0.03), envUp: tc(0.3), envDown: tc(3), sRise: tc(0.5), sFall: 0.05 * hopSec,
      detRel: tc(0.25), gUp: tc(0.4), gDown: tc(0.015), restUp: tc(1.5), restDown: tc(0.3),
    };
    this.speechPow = 0; this.restPow = 0;
    this.streamerDb = null; this.gameVoiceDb = -90; this.restDb = -90;
    this.det = 0; this.detLevel = 0;
    this.gS = 1; this.gR = 1; this.gSdb = 0; this.gRdb = 0;
    this.warm = 0; this.warmHops = Math.round(2 / hopSec);
    this.reportEvery = Math.max(1, Math.round(0.06 / hopSec));
    this.ready = true;
    this.port.postMessage({ type: 'ready', delaySamples: hop + this.modelDelay, hop });
  }

  processHop() {
    const { x, st, hop, inL, inR, dL, dR, ring } = this;
    // Model input: the centre of the stereo image (where voices sit).
    const mIn = new Float32Array(x.memory.buffer, this.inPtr, hop);
    for (let i = 0; i < hop; i++) mIn[i] = 0.5 * (inL[i] + inR[i]);
    x.svl_process(st);
    const sp = new Float32Array(x.memory.buffer, this.outPtr, hop);
    // Dry stereo into the delay line; read it back aligned with the model output.
    let ps = 0, pr = 0;
    const D = this.modelDelay;
    for (let i = 0; i < hop; i++) {
      dL[this.dPos] = inL[i]; dR[this.dPos] = inR[i];
      const rp = (this.dPos - D + ring) & (ring - 1);
      this.dPos = (this.dPos + 1) & (ring - 1);
      const s = sp[i];
      const l = dL[rp], r = dR[rp];
      const restMid = 0.5 * (l + r) - s;
      ps += s * s; pr += restMid * restMid;
      this.outL[i] = l; this.outR[i] = r; // dry, mixed below
      inL[i] = s; // reuse: aligned speech for this hop
    }
    this.levels(ps / hop, pr / hop);
    // Mix with per-sample gain ramps.
    const gS0 = this.gS, gR0 = this.gR;
    this.updateGains();
    const dS = (this.gS - gS0) / hop, dRg = (this.gR - gR0) / hop;
    let gs = gS0, gr = gR0;
    const solo = this.p.solo | 0;
    const ms = solo === 2 ? 0 : 1, mr = solo === 1 ? 0 : 1;
    for (let i = 0; i < hop; i++) {
      gs += dS; gr += dRg;
      const s = inL[i];
      this.outL[i] = ms * gs * s + mr * gr * (this.outL[i] - s);
      this.outR[i] = ms * gs * s + mr * gr * (this.outR[i] - s);
    }
    this.outPos = 0;
  }

  levels(pS, pR) {
    const k = this.k, p = this.p;
    this.speechPow += (pS - this.speechPow) * k.lvl;
    this.restPow += (pR - this.restPow) * k.lvl;
    const Ls = 10 * Math.log10(this.speechPow + 1e-12);
    const Lr = 10 * Math.log10(this.restPow + 1e-12);
    const warming = this.warm < this.warmHops;
    if (warming) this.warm++;
    // Streamer's loud level: slow upper envelope of the speech level.
    if (this.streamerDb === null) this.streamerDb = Ls;
    const S0 = this.streamerDb;
    this.streamerDb = Ls > S0 ? S0 + (Ls - S0) * k.sRise : S0 - k.sFall;
    const S = this.streamerDb;
    this.detLevel = 24 + (Ls - S);
    let d = Math.min(1, Math.max(0, (this.detLevel - p.trigger) / 2 + 0.5));
    if (warming || Ls < -70) d = 0;
    this.det = d > this.det ? d : this.det + (d - this.det) * k.detRel;
    // Game voice level (only while the streamer is not talking and a voice is present).
    if (this.det < 0.5 && d < 0.2 && Ls > -70) {
      const G = this.gameVoiceDb;
      this.gameVoiceDb = G + (Ls - G) * (Ls > G ? k.envUp : k.envDown);
    }
    // Game sounds level: always tracked (the rest has no streamer in it).
    if (Lr > -80) {
      const R = this.restDb;
      this.restDb = R + (Lr - R) * (Lr > R ? k.envUp : k.envDown);
    }
    const target = S - p.level;
    this.gSdbTarget = warming ? 0 : Math.min(p.boost, Math.max(0, target - this.gameVoiceDb)) * (1 - this.det);
    this.gRdbTarget = warming ? 0 : Math.min(p.boost, Math.max(0, target - this.restDb));
  }

  updateGains() {
    const k = this.k;
    this.gSdb += (this.gSdbTarget - this.gSdb) * (this.gSdbTarget < this.gSdb ? k.gDown : k.gUp);
    this.gRdb += (this.gRdbTarget - this.gRdb) * (this.gRdbTarget < this.gRdb ? k.restDown : k.restUp);
    this.gS = Math.pow(10, this.gSdb / 20);
    this.gR = Math.pow(10, this.gRdb / 20);
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const out = outputs[0];
    const oL = out[0], oR = out[1] || out[0];
    const n = oL.length;
    const iL = input && input[0];
    const iR = input && (input[1] || input[0]);
    const rec = this.rec;
    if (rec && iL) {
      const m = Math.min(n, rec.L.length - rec.pos);
      rec.L.set(iL.subarray(0, m), rec.pos);
      rec.R.set(iR.subarray(0, m), rec.pos);
      rec.pos += m;
      if (rec.pos >= rec.L.length) {
        this.port.postMessage({ type: 'recording', label: rec.label, sampleRate, L: rec.L, R: rec.R }, [rec.L.buffer, rec.R.buffer]);
        this.rec = null;
      }
    }
    if (!this.ready) {
      for (let i = 0; i < n; i++) { oL[i] = iL ? iL[i] : 0; oR[i] = iR ? iR[i] : 0; }
      return true;
    }
    const hop = this.hop;
    for (let i = 0; i < n; i++) {
      this.inL[this.fill] = iL ? iL[i] : 0;
      this.inR[this.fill] = iR ? iR[i] : 0;
      if (this.outPos < hop) { oL[i] = this.outL[this.outPos]; oR[i] = this.outR[this.outPos]; this.outPos++; }
      else { oL[i] = 0; oR[i] = 0; }
      if (++this.fill >= hop) {
        this.fill = 0;
        this.processHop();
        if (++this.hopsSinceReport >= this.reportEvery) {
          this.hopsSinceReport = 0;
          this.port.postMessage({
            type: 'report', avg: this.gRdb, speechBoost: this.gSdb, detLevel: this.detLevel, det: this.det,
            rec: this.rec ? (this.rec.L.length - this.rec.pos) / sampleRate : 0,
          });
        }
      }
    }
    return true;
  }
}
registerProcessor('svl-separator', Separator);
