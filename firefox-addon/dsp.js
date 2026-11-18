'use strict';
// The audio chain. No extension APIs here, so it can be tested on a plain page.
//
//  input ─┬─ LR4 low(f1) ── allpass(f2) ─────────── comp ─ gain(low)  ──┐
//         └─ LR4 high(f1) ┬─ LR4 low(f2) ─ centre ─ comp ─ gain(voice) ─┼─ EQ x8 ─ leveler ─ output gain ─ limiter ─ out
//                         └─ LR4 high(f2) ───────── comp ─ gain(high) ──┘
//
// Linkwitz-Riley 4th-order crossovers sum back to an allpass, so with all
// gains at 0 dB and the compressors idle the chain is flat.
(function (root) {
  const Y = root.YTEQ;
  // Butterworth Q. Web Audio takes lowpass/highpass Q in dB but allpass Q linear.
  const BW_Q = Math.SQRT1_2;
  const BW_Q_DB = 20 * Math.log10(Math.SQRT1_2);

  // Steady-state gain of a compressor (including the browser's automatic
  // makeup gain) for a sine at levelDb. Rendered offline once per setting.
  const gainCache = new Map();
  function measureCompGain(p, levelDb) {
    const key = [p.threshold, p.ratio, p.knee, p.attack, p.release, levelDb].map((v) => v.toFixed(3)).join('|');
    if (gainCache.has(key)) return gainCache.get(key);
    const promise = (async () => {
      const sr = 22050;
      const len = Math.round(sr * 1.6);
      const oc = new OfflineAudioContext(1, len, sr);
      const osc = oc.createOscillator();
      osc.frequency.value = 997;
      const amp = Math.pow(10, levelDb / 20);
      const g = oc.createGain();
      g.gain.value = amp;
      const c = oc.createDynamicsCompressor();
      setCompValues(c, p);
      osc.connect(g).connect(c).connect(oc.destination);
      osc.start();
      const buf = await oc.startRendering();
      const d = buf.getChannelData(0);
      let sum = 0;
      const from = len - Math.round(sr * 0.4);
      for (let i = from; i < len; i++) sum += d[i] * d[i];
      const rms = Math.sqrt(sum / (len - from));
      const gain = rms / (amp * Math.SQRT1_2);
      return Number.isFinite(gain) && gain > 1e-4 ? gain : 1;
    })().catch(() => 1);
    gainCache.set(key, promise);
    return promise;
  }

  function setCompValues(c, p) {
    c.threshold.value = p.threshold;
    c.ratio.value = p.ratio;
    c.knee.value = p.knee;
    c.attack.value = p.attack;
    c.release.value = p.release;
  }

  function reductionOf(c) {
    const r = c.reduction;
    return typeof r === 'number' ? r : r && typeof r.value === 'number' ? r.value : 0;
  }

  function createChain(ctx) {
    const bq = (type, f, q) => {
      const b = ctx.createBiquadFilter();
      b.type = type;
      b.frequency.value = f;
      b.Q.value = q;
      return b;
    };
    const gain = (v = 1) => {
      const g = ctx.createGain();
      g.gain.value = v;
      return g;
    };

    const input = gain();
    // Force stereo so the centre control and the filters always see 2 channels.
    input.channelCount = 2;
    input.channelCountMode = 'explicit';
    input.channelInterpretation = 'speakers';

    const d = Y.DEFAULTS;
    const lp1a = bq('lowpass', d.xoverLow, BW_Q_DB), lp1b = bq('lowpass', d.xoverLow, BW_Q_DB);
    const hp1a = bq('highpass', d.xoverLow, BW_Q_DB), hp1b = bq('highpass', d.xoverLow, BW_Q_DB);
    const ap2 = bq('allpass', d.xoverHigh, BW_Q);
    const lp2a = bq('lowpass', d.xoverHigh, BW_Q_DB), lp2b = bq('lowpass', d.xoverHigh, BW_Q_DB);
    const hp2a = bq('highpass', d.xoverHigh, BW_Q_DB), hp2b = bq('highpass', d.xoverHigh, BW_Q_DB);

    const mkComp = (p) => {
      const c = ctx.createDynamicsCompressor();
      setCompValues(c, p);
      return c;
    };
    const compLow = mkComp(Y.NEUTRAL), compMid = mkComp(Y.NEUTRAL), compHigh = mkComp(Y.NEUTRAL);
    const leveler = mkComp(Y.NEUTRAL), limiter = mkComp(Y.LIMITER);
    // Makeup-gain compensation, one per compressor.
    const cgLow = gain(), cgMid = gain(), cgHigh = gain(), cgLev = gain(), cgLim = gain();
    const gLow = gain(), gMid = gain(), gHigh = gain(), outGain = gain();

    // Centre (mid/side) control inside the voice band.
    const splitter = ctx.createChannelSplitter(2);
    const merger = ctx.createChannelMerger(2);
    const gLL = gain(), gLR = gain(0), gRL = gain(0), gRR = gain();

    const sum = gain();
    const eq = d.eq.map((b) => {
      const f = bq(b.type, b.freq, b.q);
      f.gain.value = 0;
      return f;
    });
    const output = gain();

    const analyserIn = ctx.createAnalyser();
    const analyserOut = ctx.createAnalyser();
    for (const a of [analyserIn, analyserOut]) {
      a.fftSize = 4096;
      a.smoothingTimeConstant = 0.75;
      a.minDecibels = -110;
      a.maxDecibels = 0;
    }

    // `pre` is where the streamer-focus worklet goes once it has loaded.
    const pre = gain();
    input.connect(analyserIn);
    input.connect(pre);
    // Low band
    pre.connect(lp1a).connect(lp1b).connect(ap2).connect(compLow).connect(cgLow).connect(gLow).connect(sum);
    // Voice band
    pre.connect(hp1a).connect(hp1b);
    hp1b.connect(lp2a).connect(lp2b).connect(splitter);
    splitter.connect(gLL, 0); gLL.connect(merger, 0, 0);
    splitter.connect(gLR, 0); gLR.connect(merger, 0, 1);
    splitter.connect(gRL, 1); gRL.connect(merger, 0, 0);
    splitter.connect(gRR, 1); gRR.connect(merger, 0, 1);
    merger.connect(compMid).connect(cgMid).connect(gMid).connect(sum);
    // High band
    hp1b.connect(hp2a).connect(hp2b).connect(compHigh).connect(cgHigh).connect(gHigh).connect(sum);
    // Whole mix
    let node = sum;
    for (const f of eq) node = node.connect(f);
    node.connect(leveler).connect(cgLev).connect(outGain).connect(limiter).connect(cgLim).connect(output);
    output.connect(analyserOut);

    const TC = 0.03;
    const to = (param, v) => param.setTargetAtTime(v, ctx.currentTime, TC);

    let compToken = 0;
    async function applyComps(s) {
      const token = ++compToken;
      const jobs = [
        [compLow, cgLow, Y.NEUTRAL],
        [compMid, cgMid, Y.voiceComp(s.voiceTamer)],
        [compHigh, cgHigh, Y.NEUTRAL],
        [leveler, cgLev, Y.levelerComp(s.leveler)],
        [limiter, cgLim, Y.LIMITER],
      ];
      const gains = await Promise.all(jobs.map(([, , p]) => measureCompGain(p, p.anchorDb)));
      if (token !== compToken) return; // a newer setting won
      jobs.forEach(([c, cg, p], i) => {
        to(c.threshold, p.threshold);
        to(c.ratio, p.ratio);
        to(c.knee, p.knee);
        c.attack.value = p.attack;
        c.release.value = p.release;
        to(cg.gain, 1 / gains[i]);
      });
    }

    let focusNode = null;
    let focusReport = null;
    let focusStatus = { ready: false, error: '' };
    let lastSettings = null;
    function focusParams() {
      const s = lastSettings;
      return s ? { boost: s.gameBoost, trigger: s.focusTrigger, level: s.focusLevel, solo: s.solo } : {};
    }
    function sendFocusParams() {
      if (!focusNode || !lastSettings) return;
      focusNode.port.postMessage({ type: 'params', params: focusParams() });
    }
    // Insert the streamer-focus worklet between input and the band split.
    function attachFocus(node) {
      focusNode = node;
      node.port.onmessage = (e) => {
        const d = e.data || {};
        if (d.type === 'report') focusReport = d;
        else if (d.type === 'recording' && chain.onRecording) chain.onRecording(d);
        else if (d.type === 'error') focusStatus = { ready: false, error: d.error };
        else if (d.type === 'ready') focusStatus = { ready: true, error: '', delaySamples: d.delaySamples };
        if ((d.type === 'error' || d.type === 'ready') && chain.onFocusStatus) chain.onFocusStatus(focusStatus);
      };
      input.disconnect(pre);
      input.connect(node).connect(pre);
      sendFocusParams();
    }

    function apply(s) {
      lastSettings = s;
      sendFocusParams();
      for (const f of [lp1a, lp1b, hp1a, hp1b]) to(f.frequency, s.xoverLow);
      for (const f of [ap2, lp2a, lp2b, hp2a, hp2b]) to(f.frequency, s.xoverHigh);
      to(gLow.gain, Y.dbToGain(s.lowGain));
      to(gMid.gain, Y.dbToGain(s.voiceGain));
      to(gHigh.gain, Y.dbToGain(s.highGain));
      to(outGain.gain, Y.dbToGain(s.output));
      // L' = aL + bR, R' = bL + aR keeps the side part and scales the centre.
      const c = Y.dbToGain(s.centerGain);
      const a = (c + 1) / 2, b = (c - 1) / 2;
      to(gLL.gain, a); to(gRR.gain, a); to(gLR.gain, b); to(gRL.gain, b);
      s.eq.forEach((band, i) => {
        const f = eq[i];
        if (f.type !== band.type) f.type = band.type;
        to(f.frequency, band.freq);
        to(f.gain, band.gain);
        to(f.Q, band.q);
      });
      return applyComps(s);
    }

    const chain = {
      onRecording: null,
      onFocusStatus: null,
      record: (label, seconds) => {
        if (!focusNode) return false;
        focusNode.port.postMessage({ type: 'record', label, seconds });
        return true;
      },
      input, output, analyserIn, analyserOut, apply, attachFocus, focusParams,
      hasFocus: () => !!focusNode && focusStatus.ready,
      focusStatus: () => focusStatus,
      focusReport: () => focusReport,
      reductions: () => ({
        focus: focusReport ? focusReport.avg : 0,
        voice: reductionOf(compMid),
        leveler: reductionOf(leveler),
        limiter: reductionOf(limiter),
      }),
    };
    return chain;
  }

  // Log-spaced spectrum points (dB) from an analyser, for the popup graph.
  function spectrumReader(analyser) {
    const n = Y.SPECTRUM_POINTS;
    const bins = new Float32Array(analyser.frequencyBinCount);
    const binHz = analyser.context.sampleRate / analyser.fftSize;
    const lo = new Int32Array(n), hi = new Int32Array(n);
    const lmin = Math.log(Y.SPECTRUM_MIN_HZ), lmax = Math.log(Y.SPECTRUM_MAX_HZ);
    for (let i = 0; i < n; i++) {
      const f0 = Math.exp(lmin + (lmax - lmin) * (i / n));
      const f1 = Math.exp(lmin + (lmax - lmin) * ((i + 1) / n));
      lo[i] = Math.min(bins.length - 1, Math.floor(f0 / binHz));
      hi[i] = Math.min(bins.length - 1, Math.max(lo[i], Math.ceil(f1 / binHz) - 1));
    }
    return () => {
      analyser.getFloatFrequencyData(bins);
      const out = new Array(n);
      for (let i = 0; i < n; i++) {
        let m = -Infinity;
        for (let k = lo[i]; k <= hi[i]; k++) if (bins[k] > m) m = bins[k];
        out[i] = Number.isFinite(m) ? Math.max(-120, Math.round(m)) : -120;
      }
      return out;
    };
  }

  // Per-bin streamer-focus gains (dB, positive = game raised) -> log-spaced points for the graph.
  function focusPoints(report) {
    const n = Y.SPECTRUM_POINTS;
    const out = new Array(n).fill(0);
    if (!report || !report.gdb) return out;
    const red = report.gdb, binHz = report.binHz;
    const lmin = Math.log(Y.SPECTRUM_MIN_HZ), lmax = Math.log(Y.SPECTRUM_MAX_HZ);
    for (let i = 0; i < n; i++) {
      const f0 = Math.exp(lmin + (lmax - lmin) * (i / n));
      const f1 = Math.exp(lmin + (lmax - lmin) * ((i + 1) / n));
      const k0 = Math.min(red.length - 1, Math.floor(f0 / binHz));
      const k1 = Math.min(red.length - 1, Math.max(k0, Math.ceil(f1 / binHz) - 1));
      let m = 0;
      for (let k = k0; k <= k1; k++) if (red[k] > m) m = red[k];
      out[i] = Math.round(m * 10) / 10;
    }
    return out;
  }

  // Loads the separator worklet and the DeepFilterNet files, attaches to the chain.
  // assets = { worklet: url, wasm: url, model: url }
  async function loadFocus(ctx, chain, assets) {
    const get = async (u) => { const r = await fetch(u); if (!r.ok) throw new Error('could not load ' + u); return r.arrayBuffer(); };
    const [wasm, model] = await Promise.all([get(assets.wasm), get(assets.model)]);
    await ctx.audioWorklet.addModule(assets.worklet);
    const opts = { params: chain.focusParams(), wasm, model };
    const node = new AudioWorkletNode(ctx, 'svl-separator', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      channelCount: 2,
      channelCountMode: 'explicit',
      channelInterpretation: 'speakers',
      // Start with the current settings; a port message could arrive late.
      // Firefox content scripts must hand the page's APIs objects made in the
      // page's compartment, or cloning into the worklet fails.
      processorOptions: typeof cloneInto === 'function' ? cloneInto(opts, window) : opts,
    });
    chain.attachFocus(node);
    return node;
  }

  root.YTEQ.createChain = createChain;
  root.YTEQ.focusPoints = focusPoints;
  root.YTEQ.loadFocus = loadFocus;
  root.YTEQ.measureCompGain = measureCompGain;
  root.YTEQ.spectrumReader = spectrumReader;
})(typeof globalThis !== 'undefined' ? globalThis : this);
