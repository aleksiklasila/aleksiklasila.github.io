'use strict';
// Hooks YouTube's <video>/<audio> elements into the processing chain.
(function () {
  const Y = globalThis.YTEQ;
  if (!Y || Y.contentLoaded) return;
  Y.contentLoaded = true;

  let settings = Y.normalize(null);
  let ctx = null;
  let chain = null;
  let dry = null, wet = null, audBP = null, audGain = null;
  let readIn = null, readOut = null;
  let audTimer = 0;
  let hookedCount = 0;
  let lastError = '';
  let focusError = '';
  // Loading the separation model blocks the audio thread for ~1 s, so videos are
  // only taken over once it has loaded (or failed); until then they play normally.
  let focusSettled = false;
  function settleFocus() {
    if (focusSettled) return;
    focusSettled = true;
    flushPending();
  }
  const recState = { label: '', saved: '', error: '' };
  const hooked = new WeakSet();
  const pending = new Set();

  browser.storage.local.get('settings').then((r) => {
    settings = Y.normalize(r && r.settings);
    applySettings();
  });
  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.settings) return;
    settings = Y.normalize(changes.settings.newValue);
    applySettings();
  });

  function ensureContext() {
    if (ctx) return;
    // DeepFilterNet runs at 48 kHz; the browser resamples the video to it.
    ctx = new AudioContext({ sampleRate: 48000 });
    chain = Y.createChain(ctx);
    dry = ctx.createGain();
    wet = ctx.createGain();
    audBP = ctx.createBiquadFilter();
    audBP.type = 'bandpass';
    audBP.Q.value = 3;
    audGain = ctx.createGain();
    audGain.gain.value = 0;
    chain.output.connect(wet).connect(ctx.destination);
    chain.output.connect(audBP).connect(audGain).connect(ctx.destination);
    dry.connect(ctx.destination);
    chain.onRecording = saveRecording;
    chain.onFocusStatus = settleFocus;
    setTimeout(settleFocus, 20000);
    readIn = Y.spectrumReader(chain.analyserIn);
    readOut = Y.spectrumReader(chain.analyserOut);
    ctx.addEventListener('statechange', flushPending);
    applySettings(true);
    Y.loadFocus(ctx, chain, {
      worklet: browser.runtime.getURL('separator-worklet.js'),
      wasm: browser.runtime.getURL('dfn/svl_dfn.wasm'),
      model: browser.runtime.getURL('dfn/DeepFilterNet3_onnx.tar.gz'),
    }).catch((err) => {
      focusError = String((err && err.message) || err);
      settleFocus();
      console.warn('[Stream Voice Leveler] streamer focus unavailable:', err);
    });
  }

  function applySettings(immediate) {
    if (!ctx) return;
    const on = settings.enabled;
    if (immediate) {
      wet.gain.value = on ? 1 : 0;
      dry.gain.value = on ? 0 : 1;
    } else {
      wet.gain.setTargetAtTime(on ? 1 : 0, ctx.currentTime, 0.03);
      dry.gain.setTargetAtTime(on ? 0 : 1, ctx.currentTime, 0.03);
    }
    chain.apply(settings);
  }

  function resume() {
    if (ctx && ctx.state !== 'running') ctx.resume().catch(() => {});
  }

  // The video is only taken over once the AudioContext is running. If the
  // browser keeps the context suspended (autoplay rules), the video keeps
  // playing normally instead of going silent.
  function flushPending() {
    if (!ctx || ctx.state !== 'running' || !focusSettled) return;
    for (const el of pending) hook(el);
    pending.clear();
  }

  function hook(el) {
    if (hooked.has(el)) return;
    hooked.add(el);
    try {
      const src = ctx.createMediaElementSource(el);
      src.connect(chain.input);
      src.connect(dry);
      hookedCount++;
    } catch (err) {
      lastError = String((err && err.message) || err);
      console.warn('[Stream Voice Leveler] could not hook media element:', err);
    }
  }

  function consider(el) {
    if (!el || (el.tagName !== 'VIDEO' && el.tagName !== 'AUDIO')) return;
    if (hooked.has(el)) { resume(); return; }
    pending.add(el);
    ensureContext();
    resume();
    flushPending();
  }

  // Media events don't bubble, but they do pass through the capture phase.
  document.addEventListener('play', (e) => consider(e.target), true);
  document.addEventListener('playing', (e) => consider(e.target), true);
  for (const el of document.querySelectorAll('video, audio')) if (!el.paused) consider(el);
  // A click or key press lets a suspended AudioContext start.
  window.addEventListener('pointerdown', resume, true);
  window.addEventListener('keydown', resume, true);

  // 16-bit stereo WAV of the unprocessed stream audio, saved via the background page.
  function saveRecording(d) {
    const n = d.L.length, sr = d.sampleRate;
    const buf = new ArrayBuffer(44 + n * 4);
    const v = new DataView(buf);
    const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    str(0, 'RIFF'); v.setUint32(4, 36 + n * 4, true); str(8, 'WAVE');
    str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 2, true);
    v.setUint32(24, sr, true); v.setUint32(28, sr * 4, true); v.setUint16(32, 4, true); v.setUint16(34, 16, true);
    str(36, 'data'); v.setUint32(40, n * 4, true);
    for (let i = 0, o = 44; i < n; i++, o += 4) {
      v.setInt16(o, Math.max(-1, Math.min(1, d.L[i])) * 32767, true);
      v.setInt16(o + 2, Math.max(-1, Math.min(1, d.R[i])) * 32767, true);
    }
    const t = new Date();
    const pad = (x) => String(x).padStart(2, '0');
    const stamp = t.getFullYear() + pad(t.getMonth() + 1) + pad(t.getDate()) + '-' + pad(t.getHours()) + pad(t.getMinutes()) + pad(t.getSeconds());
    const name = 'clip-' + stamp + '-' + d.label + '.wav';
    browser.runtime.sendMessage({ type: 'saveClip', name, data: buf }).then((r) => {
      recState.label = '';
      if (r && r.ok) { recState.saved = name; recState.error = ''; } else recState.error = (r && r.error) || 'save failed';
    }).catch((err) => { recState.label = ''; recState.error = String((err && err.message) || err); });
  }

  function stopAudition() {
    if (!ctx) return;
    audGain.gain.setTargetAtTime(0, ctx.currentTime, 0.02);
    wet.gain.setTargetAtTime(settings.enabled ? 1 : 0, ctx.currentTime, 0.02);
    dry.gain.setTargetAtTime(settings.enabled ? 0 : 1, ctx.currentTime, 0.02);
  }

  browser.runtime.onMessage.addListener((msg) => {
    if (!msg || typeof msg !== 'object') return undefined;
    const top = window === window.top;
    if (msg.type === 'status') {
      if (!ctx && !top) return undefined;
      const st = {
        present: true,
        state: ctx ? ctx.state : 'none',
        hooked: hookedCount,
        waiting: pending.size,
        error: lastError,
        focusError: focusError || (chain ? chain.focusStatus().error : ''),
        focusReady: !!(chain && chain.hasFocus()),
        loading: !!ctx && !focusSettled,
        sampleRate: ctx ? ctx.sampleRate : 0,
      };
      if (ctx && hookedCount) {
        st.reductions = chain.reductions();
        if (msg.spectrum) {
          st.specIn = readIn();
          st.specOut = readOut();
          st.focusCut = Y.focusPoints(chain.focusReport());
        }
        const rep = chain.focusReport();
        if (rep) st.focusDet = { level: rep.detLevel, det: rep.det };
        st.rec = { left: rep ? rep.rec : 0, label: recState.label, saved: recState.saved, error: recState.error };
      }
      return Promise.resolve(st);
    }
    if (msg.type === 'record') {
      if (!ctx || !hookedCount) return undefined;
      const label = String(msg.label || 'clip').replace(/[^a-z0-9-]/gi, '');
      if (!chain.record(label, 10)) return Promise.resolve({ ok: false, error: 'streamer focus not loaded' });
      recState.label = label; recState.saved = ''; recState.error = '';
      return Promise.resolve({ ok: true });
    }
    if (msg.type === 'audition') {
      if (!ctx || !hookedCount) return undefined;
      clearTimeout(audTimer);
      if (msg.freq) {
        const t = ctx.currentTime;
        audBP.frequency.setTargetAtTime(msg.freq, t, 0.01);
        audGain.gain.setTargetAtTime(2, t, 0.02);
        wet.gain.setTargetAtTime(0, t, 0.02);
        dry.gain.setTargetAtTime(0, t, 0.02);
        // The popup keeps refreshing this; if it closes, audio comes back.
        audTimer = setTimeout(stopAudition, 450);
      } else {
        stopAudition();
      }
      return Promise.resolve(true);
    }
    return undefined;
  });
})();
