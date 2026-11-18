'use strict';
(function () {
  const Y = globalThis.YTEQ;
  const $ = (id) => document.getElementById(id);

  let settings = Y.normalize(null);
  let tabId = null;
  let specIn = null, specOut = null, focusCut = null;
  let selected = -1;
  let hoverX = -1;

  const F_MIN = 20, F_MAX = 20000, DB_MAX = 18, DB_MIN = -18;
  const SPEC_TOP = -15, SPEC_BOTTOM = -105;
  const PAD = { l: 30, r: 8, t: 18, b: 18 };
  const BAND_COLORS = ['#e8590c', '#f08c00', '#2f9e44', '#1c7ed6', '#7048e8', '#ae3ec9', '#d6336c', '#0c8599'];
  const BAND_NAMES = { lowshelf: 'Low shelf', peaking: 'Peak', highshelf: 'High shelf' };

  // ---------- settings I/O ----------
  let saveTimer = 0;
  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      browser.storage.local.set({ settings: Y.clone(settings) });
    }, 40);
  }
  function changed() {
    save();
    syncControls();
    computeResponse();
    draw();
  }

  // ---------- sliders ----------
  const pct = (v) => Math.round(v * 100) + ' %';
  const db = (v) => (v > 0 ? '+' : '') + v.toFixed(1) + ' dB';
  const SLIDERS = {
    focusSliders: [
      { key: 'gameBoost', label: 'Game boost', hint: 'most the game is raised (0 = off)', min: 0, max: 24, step: 0.5, fmt: (v) => '+' + v.toFixed(1) + ' dB' },
      { key: 'focusLevel', label: 'Streamer above game', hint: 'how much louder the streamer stays', min: -6, max: 18, step: 0.5, fmt: db },
      { key: 'focusTrigger', label: 'Detect above', hint: 'how close to the usual streamer loudness (the line)', min: 0, max: 24, step: 0.5, fmt: (v) => '−' + (24 - v).toFixed(1) + ' dB' },
    ],
    voiceSliders: [
      { key: 'voiceTamer', label: 'Voice tamer', hint: 'squashes loud speech', min: 0, max: 1, step: 0.01, fmt: pct },
      { key: 'voiceGain', label: 'Voice level', hint: 'voice band after taming', min: -18, max: 12, step: 0.5, fmt: db },
      { key: 'centerGain', label: 'Centre cut', hint: 'voice sits in the centre (stereo only)', min: -24, max: 0, step: 0.5, fmt: db },
      { key: 'lowGain', label: 'Background lows', hint: () => 'below ' + hz(settings.xoverLow), min: -12, max: 18, step: 0.5, fmt: db },
      { key: 'highGain', label: 'Background highs', hint: () => 'above ' + hz(settings.xoverHigh), min: -12, max: 18, step: 0.5, fmt: db },
    ],
    mixSliders: [
      { key: 'leveler', label: 'Leveler', hint: 'raises quiet sounds', min: 0, max: 1, step: 0.01, fmt: pct },
      { key: 'output', label: 'Output', hint: 'final volume', min: -18, max: 18, step: 0.5, fmt: db },
    ],
  };
  const sliderEls = [];
  for (const [containerId, defs] of Object.entries(SLIDERS)) {
    const box = $(containerId);
    for (const d of defs) {
      const row = document.createElement('div');
      row.className = 'slider';
      const label = document.createElement('label');
      label.textContent = d.label;
      const small = document.createElement('small');
      label.appendChild(small);
      const input = document.createElement('input');
      input.type = 'range';
      input.min = d.min; input.max = d.max; input.step = d.step;
      const out = document.createElement('output');
      input.addEventListener('input', () => {
        settings[d.key] = Number(input.value);
        changed();
      });
      input.addEventListener('dblclick', () => {
        settings[d.key] = Y.DEFAULTS[d.key];
        changed();
      });
      row.append(label, input, out);
      box.appendChild(row);
      sliderEls.push({ d, input, out, small });
    }
  }

  function syncControls() {
    $('enabled').checked = settings.enabled;
    $('solo').value = String(settings.solo || 0);
    if (typeof syncDetMark === 'function') syncDetMark();
    for (const { d, input, out, small } of sliderEls) {
      input.value = settings[d.key];
      out.textContent = d.fmt(settings[d.key]);
      small.textContent = typeof d.hint === 'function' ? d.hint() : d.hint;
    }
    const b = settings.eq[selected];
    $('bandType').disabled = !b;
    $('bandQ').disabled = !b || b.type !== 'peaking';
    if (b) {
      $('bandName').textContent = `${BAND_NAMES[b.type]} · ${hz(b.freq)} · ${db(b.gain)}` + (b.type === 'peaking' ? ` · Q ${b.q.toFixed(2)}` : '');
      $('bandName').style.color = BAND_COLORS[selected];
      $('bandType').value = b.type;
      $('bandQ').value = Math.log(b.q / 0.2) / Math.log(12 / 0.2);
    } else {
      $('bandName').textContent = 'Click a point to edit it';
      $('bandName').style.color = '';
    }
  }

  $('enabled').addEventListener('change', (e) => { settings.enabled = e.target.checked; changed(); });
  $('solo').addEventListener('change', (e) => { settings.solo = Number(e.target.value); changed(); });
  $('bandType').addEventListener('change', (e) => {
    if (selected < 0) return;
    settings.eq[selected].type = e.target.value;
    changed();
  });
  $('bandQ').addEventListener('input', (e) => {
    if (selected < 0) return;
    // Slider runs wide (left) to narrow (right) on a log scale.
    settings.eq[selected].q = 0.2 * Math.pow(12 / 0.2, Number(e.target.value));
    changed();
  });

  const presetSel = $('preset');
  for (const [name, p] of Object.entries(Y.PRESETS)) {
    const o = document.createElement('option');
    o.value = name; o.textContent = p.label;
    presetSel.appendChild(o);
  }
  presetSel.value = 'quieter';
  function applyPreset() {
    settings = Y.presetSettings(presetSel.value, settings.enabled);
    changed();
  }
  presetSel.addEventListener('change', applyPreset);
  $('reset').addEventListener('click', applyPreset);

  function hz(f) {
    return f >= 1000 ? (f / 1000).toFixed(f >= 10000 ? 1 : 2).replace(/\.?0+$/, '') + ' kHz' : Math.round(f) + ' Hz';
  }

  // ---------- frequency response of the whole static chain ----------
  const N_RESP = 300;
  const respFreqs = new Float32Array(N_RESP);
  for (let i = 0; i < N_RESP; i++) respFreqs[i] = F_MIN * Math.pow(F_MAX / F_MIN, i / (N_RESP - 1));
  const respDb = new Float32Array(N_RESP);
  const actx = new OfflineAudioContext(1, 128, 48000);
  // lowpass/highpass Q is in dB in Web Audio, allpass Q is linear.
  const mk = (type) => { const b = actx.createBiquadFilter(); b.type = type; b.Q.value = type === 'allpass' ? Math.SQRT1_2 : 20 * Math.log10(Math.SQRT1_2); return b; };
  const xf = { lp1: mk('lowpass'), hp1: mk('highpass'), ap2: mk('allpass'), lp2: mk('lowpass'), hp2: mk('highpass') };
  const eqF = settings.eq.map(() => actx.createBiquadFilter());
  const mag = new Float32Array(N_RESP), ph = new Float32Array(N_RESP);

  function resp(filter, power) {
    filter.getFrequencyResponse(respFreqs, mag, ph);
    const re = new Float32Array(N_RESP), im = new Float32Array(N_RESP);
    for (let i = 0; i < N_RESP; i++) {
      const m = Math.pow(mag[i], power), p = ph[i] * power;
      re[i] = m * Math.cos(p); im[i] = m * Math.sin(p);
    }
    return { re, im };
  }
  function mul(a, b) {
    const re = new Float32Array(N_RESP), im = new Float32Array(N_RESP);
    for (let i = 0; i < N_RESP; i++) {
      re[i] = a.re[i] * b.re[i] - a.im[i] * b.im[i];
      im[i] = a.re[i] * b.im[i] + a.im[i] * b.re[i];
    }
    return { re, im };
  }

  function computeResponse() {
    const s = settings;
    xf.lp1.frequency.value = xf.hp1.frequency.value = s.xoverLow;
    xf.ap2.frequency.value = xf.lp2.frequency.value = xf.hp2.frequency.value = s.xoverHigh;
    const lp1 = resp(xf.lp1, 2), hp1 = resp(xf.hp1, 2), ap2 = resp(xf.ap2, 1), lp2 = resp(xf.lp2, 2), hp2 = resp(xf.hp2, 2);
    const low = mul(lp1, ap2), mid = mul(hp1, lp2), high = mul(hp1, hp2);
    const gl = Y.dbToGain(s.lowGain), gm = Y.dbToGain(s.voiceGain), gh = Y.dbToGain(s.highGain);
    let total = { re: new Float32Array(N_RESP), im: new Float32Array(N_RESP) };
    for (let i = 0; i < N_RESP; i++) {
      total.re[i] = low.re[i] * gl + mid.re[i] * gm + high.re[i] * gh;
      total.im[i] = low.im[i] * gl + mid.im[i] * gm + high.im[i] * gh;
    }
    s.eq.forEach((b, i) => {
      const f = eqF[i];
      f.type = b.type; f.frequency.value = b.freq; f.gain.value = b.gain; f.Q.value = b.q;
      total = mul(total, resp(f, 1));
    });
    for (let i = 0; i < N_RESP; i++) {
      respDb[i] = 20 * Math.log10(Math.hypot(total.re[i], total.im[i]) + 1e-9);
    }
  }

  // ---------- graph ----------
  const canvas = $('curve');
  const g = canvas.getContext('2d');
  let W = 0, H = 0;
  function resize() {
    const r = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    W = r.width; H = r.height;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  const LMIN = Math.log(F_MIN), LMAX = Math.log(F_MAX);
  const xOf = (f) => PAD.l + ((Math.log(f) - LMIN) / (LMAX - LMIN)) * (W - PAD.l - PAD.r);
  const fOf = (x) => Math.exp(LMIN + ((x - PAD.l) / (W - PAD.l - PAD.r)) * (LMAX - LMIN));
  const yOf = (v) => PAD.t + ((DB_MAX - v) / (DB_MAX - DB_MIN)) * (H - PAD.t - PAD.b);
  const vOf = (y) => DB_MAX - ((y - PAD.t) / (H - PAD.t - PAD.b)) * (DB_MAX - DB_MIN);
  const ySpec = (v) => PAD.t + ((SPEC_TOP - v) / (SPEC_TOP - SPEC_BOTTOM)) * (H - PAD.t - PAD.b);

  function css(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }
  let colors = null;
  function readColors() {
    colors = {
      text: css('--text'), muted: css('--muted'), grid: css('--grid'), voice: css('--voice'),
      curve: css('--curve'), cut: css('--boost'), specIn: css('--spec-in'), specOut: css('--spec-out'), bg: css('--bg'),
    };
  }

  function drawSpectrum(arr, fill) {
    if (!arr) return;
    const n = arr.length;
    g.beginPath();
    g.moveTo(PAD.l, H - PAD.b);
    for (let i = 0; i < n; i++) {
      const f = Math.exp(LMIN + (LMAX - LMIN) * ((i + 0.5) / n));
      const y = Math.min(H - PAD.b, Math.max(PAD.t, ySpec(arr[i])));
      g.lineTo(xOf(f), y);
    }
    g.lineTo(W - PAD.r, H - PAD.b);
    g.closePath();
    g.fillStyle = fill;
    g.fill();
  }

  function draw() {
    if (!W) return;
    const c = colors;
    g.clearRect(0, 0, W, H);
    const bottom = H - PAD.b;

    // Voice band
    const vx0 = xOf(settings.xoverLow), vx1 = xOf(settings.xoverHigh);
    g.fillStyle = c.voice;
    g.globalAlpha = 0.09;
    g.fillRect(vx0, PAD.t, vx1 - vx0, bottom - PAD.t);
    g.globalAlpha = 1;

    // Regions (what each range sounds like)
    g.font = '10px system-ui, sans-serif';
    g.textBaseline = 'top';
    Y.REGIONS.forEach(([f0, f1, name, , short], i) => {
      const x0 = xOf(f0), x1 = xOf(f1);
      if (i > 0) {
        g.strokeStyle = c.grid;
        g.beginPath(); g.moveTo(x0 + 0.5, 0); g.lineTo(x0 + 0.5, bottom); g.stroke();
      }
      const hover = hoverX >= x0 && hoverX < x1;
      g.fillStyle = hover ? c.text : c.muted;
      g.textAlign = 'center';
      const label = g.measureText(name).width > x1 - x0 - 4 && short ? short : name;
      g.fillText(label, (x0 + x1) / 2, 3);
    });

    // dB grid
    g.textAlign = 'right';
    g.textBaseline = 'middle';
    for (let v = DB_MIN; v <= DB_MAX; v += 6) {
      const y = Math.round(yOf(v)) + 0.5;
      g.strokeStyle = c.grid;
      g.lineWidth = v === 0 ? 2 : 1;
      g.beginPath(); g.moveTo(PAD.l, y); g.lineTo(W - PAD.r, y); g.stroke();
      g.fillStyle = c.muted;
      g.fillText((v > 0 ? '+' : '') + v, PAD.l - 4, y);
    }
    g.lineWidth = 1;
    // Frequency labels
    g.textAlign = 'center';
    g.textBaseline = 'top';
    for (const f of [50, 100, 200, 500, 1000, 2000, 5000, 10000]) {
      g.fillStyle = c.muted;
      g.fillText(f >= 1000 ? f / 1000 + 'k' : String(f), xOf(f), bottom + 4);
    }

    // Live spectrum: before (grey) and after (blue) processing
    drawSpectrum(specIn, c.specIn);
    drawSpectrum(specOut, c.specOut);

    // How much streamer focus raises each range right now, up from the 0 dB line.
    if (focusCut && focusCut.some((v) => v > 0.2)) {
      const n = focusCut.length, pxPerDb = (bottom - PAD.t) / (DB_MAX - DB_MIN);
      g.beginPath();
      const y0 = yOf(0);
      g.moveTo(PAD.l, y0);
      for (let i = 0; i < n; i++) {
        const f = Math.exp(LMIN + (LMAX - LMIN) * ((i + 0.5) / n));
        g.lineTo(xOf(f), Math.max(PAD.t, y0 - focusCut[i] * pxPerDb));
      }
      g.lineTo(W - PAD.r, y0);
      g.closePath();
      g.fillStyle = c.cut;
      g.globalAlpha = 0.45;
      g.fill();
      g.globalAlpha = 1;
    }

    // Voice band edges
    g.strokeStyle = c.voice;
    g.lineWidth = 2;
    g.setLineDash([4, 3]);
    for (const x of [vx0, vx1]) { g.beginPath(); g.moveTo(x, PAD.t); g.lineTo(x, bottom); g.stroke(); }
    g.setLineDash([]);
    g.fillStyle = c.voice;
    for (const x of [vx0, vx1]) { g.fillRect(x - 4, bottom - 14, 8, 14); }
    g.font = '10px system-ui, sans-serif';
    g.textBaseline = 'bottom';
    g.fillText('voice band', (vx0 + vx1) / 2, bottom - 2);

    // Response curve
    g.strokeStyle = c.curve;
    g.lineWidth = 2.5;
    g.beginPath();
    for (let i = 0; i < N_RESP; i++) {
      const x = xOf(respFreqs[i]);
      const y = Math.min(bottom, Math.max(PAD.t, yOf(respDb[i])));
      i ? g.lineTo(x, y) : g.moveTo(x, y);
    }
    g.stroke();
    g.lineWidth = 1;

    // EQ points
    settings.eq.forEach((b, i) => {
      const x = xOf(b.freq), y = yOf(b.gain);
      g.beginPath();
      g.arc(x, y, i === selected ? 7.5 : 6, 0, Math.PI * 2);
      g.fillStyle = BAND_COLORS[i];
      g.fill();
      g.strokeStyle = i === selected ? c.text : c.bg;
      g.lineWidth = 2;
      g.stroke();
      g.lineWidth = 1;
    });

    // Audition marker
    if (drag && drag.kind === 'aud') {
      g.strokeStyle = c.text;
      g.setLineDash([2, 2]);
      g.beginPath(); g.moveTo(drag.x, PAD.t); g.lineTo(drag.x, bottom); g.stroke();
      g.setLineDash([]);
    }
  }

  // ---------- pointer interaction ----------
  let drag = null;
  function pos(e) {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }
  function hitPoint(p) {
    let best = -1, bestD = 12;
    settings.eq.forEach((b, i) => {
      const d = Math.hypot(xOf(b.freq) - p.x, yOf(b.gain) - p.y);
      if (d < bestD) { best = i; bestD = d; }
    });
    return best;
  }
  function hitEdge(p) {
    const d0 = Math.abs(xOf(settings.xoverLow) - p.x), d1 = Math.abs(xOf(settings.xoverHigh) - p.x);
    if (Math.min(d0, d1) > 6) return null;
    return d0 <= d1 ? 'xoverLow' : 'xoverHigh';
  }
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  function describe(x) {
    const f = fOf(x);
    const r = Y.REGIONS.find(([f0, f1]) => f >= f0 && f < f1) || Y.REGIONS[Y.REGIONS.length - 1];
    const inVoice = f >= settings.xoverLow && f <= settings.xoverHigh;
    return `${hz(f)} · ${r[2]}: ${r[3]}` + (inVoice ? ' · in the voice band' : ' · background');
  }

  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  canvas.addEventListener('pointerdown', (e) => {
    const p = pos(e);
    canvas.setPointerCapture(e.pointerId);
    if (e.button === 2) {
      drag = { kind: 'aud', x: p.x };
      audition(fOf(p.x));
      draw();
      return;
    }
    if (e.button !== 0) return;
    const i = hitPoint(p);
    if (i >= 0) {
      selected = i;
      drag = { kind: 'eq', i };
      syncControls();
      draw();
      return;
    }
    const edge = hitEdge(p);
    if (edge) { drag = { kind: 'edge', key: edge }; return; }
    selected = -1;
    syncControls();
    draw();
  });
  canvas.addEventListener('pointermove', (e) => {
    const p = pos(e);
    hoverX = p.x;
    $('hoverInfo').textContent = p.x >= PAD.l && p.x <= W - PAD.r ? describe(p.x) : '';
    if (!drag) {
      canvas.style.cursor = hitPoint(p) >= 0 ? 'grab' : hitEdge(p) ? 'ew-resize' : 'crosshair';
      draw();
      return;
    }
    if (drag.kind === 'eq') {
      const b = settings.eq[drag.i];
      b.freq = Math.round(clamp(fOf(p.x), 20, 20000));
      b.gain = Math.round(clamp(vOf(p.y), DB_MIN, DB_MAX) * 2) / 2;
      changed();
    } else if (drag.kind === 'edge') {
      const f = fOf(p.x);
      if (drag.key === 'xoverLow') settings.xoverLow = Math.round(clamp(f, 60, Math.min(1000, settings.xoverHigh / 2)));
      else settings.xoverHigh = Math.round(clamp(f, Math.max(1500, settings.xoverLow * 2), 12000));
      changed();
    } else if (drag.kind === 'aud') {
      drag.x = p.x;
      audition(fOf(p.x));
      draw();
    }
  });
  function endDrag() {
    if (drag && drag.kind === 'aud') audition(null);
    drag = null;
    draw();
  }
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);
  canvas.addEventListener('pointerleave', () => {
    hoverX = -1;
    $('hoverInfo').textContent = 'Hover the graph to see what each range sounds like';
    draw();
  });
  canvas.addEventListener('dblclick', (e) => {
    const i = hitPoint(pos(e));
    if (i < 0) return;
    settings.eq[i] = { ...Y.DEFAULTS.eq[i], gain: 0 };
    selected = i;
    changed();
  });
  canvas.addEventListener('wheel', (e) => {
    const i = hitPoint(pos(e));
    const target = i >= 0 ? i : selected;
    if (target < 0) return;
    e.preventDefault();
    const b = settings.eq[target];
    b.q = clamp(b.q * Math.exp(-e.deltaY * 0.0015), 0.2, 12);
    selected = target;
    changed();
  }, { passive: false });

  // ---------- talking to the tab ----------
  let audTimer = 0;
  function audition(freq) {
    clearInterval(audTimer);
    send({ type: 'audition', freq: freq || null });
    if (freq) audTimer = setInterval(() => send({ type: 'audition', freq: fOf(drag ? drag.x : 0) }), 150);
  }

  function send(msg) {
    if (tabId == null) return Promise.resolve(null);
    return browser.tabs.sendMessage(tabId, msg).catch(() => null);
  }

  function setStatus(cls, text) {
    $('statusDot').className = 'dot ' + cls;
    $('statusText').textContent = text;
  }

  function meter(barId, textId, v) {
    const r = Math.max(0, -(v || 0));
    $(barId).style.width = Math.min(100, (r / 24) * 100) + '%';
    $(textId).textContent = (r ? '−' : '') + r.toFixed(1) + ' dB';
  }

  let polling = false;
  async function poll() {
    if (polling) return;
    polling = true;
    const st = await send({ type: 'status', spectrum: true });
    polling = false;
    if (!st || !st.present) {
      setStatus('', 'Open a YouTube video in this tab to use the leveler');
      specIn = specOut = null;
    } else if (st.error && !st.hooked) {
      setStatus('bad', 'Could not take over the video audio: ' + st.error);
    } else if (!st.hooked && st.state === 'suspended') {
      setStatus('warn', 'Click once anywhere on the YouTube page to start');
    } else if (!st.hooked && st.loading) {
      setStatus('warn', 'Loading the voice separation model… (video plays normally meanwhile)');
    } else if (!st.hooked) {
      setStatus('warn', 'Start playing a video');
    } else {
      setStatus('ok', settings.enabled ? 'Processing the video audio' : 'Off: original audio');
    }
    if (st && st.present && st.hooked && st.focusError) {
      setStatus('warn', 'Streamer focus could not start: ' + st.focusError);
    }
    if (st && st.reductions) {
      const fb = Math.max(0, st.reductions.focus || 0);
      $('mFocus').style.width = Math.min(100, (fb / 24) * 100) + '%';
      $('tFocus').textContent = '+' + fb.toFixed(1) + ' dB';
      meter('mVoice', 'tVoice', st.reductions.voice);
      meter('mLev', 'tLev', st.reductions.leveler);
      meter('mLim', 'tLim', st.reductions.limiter);
    }
    if (st && st.present) { showDetector(st.focusDet); showRecording(st.rec); }
    if (st && st.specIn) { specIn = st.specIn; specOut = st.specOut; focusCut = st.focusCut || null; draw(); }
  }

  // ---------- detector meter ----------
  const DET_MAX = 24;
  const detBar = $('detBar');
  function syncDetMark() { $('detMark').style.left = (settings.focusTrigger / DET_MAX) * 100 + '%'; }
  function detFromEvent(e) {
    const r = detBar.getBoundingClientRect();
    settings.focusTrigger = Math.round(clamp(((e.clientX - r.left) / r.width) * DET_MAX, 0, 24) * 2) / 2;
    changed();
  }
  let detDrag = false;
  detBar.addEventListener('pointerdown', (e) => { detDrag = true; detBar.setPointerCapture(e.pointerId); detFromEvent(e); });
  detBar.addEventListener('pointermove', (e) => { if (detDrag) detFromEvent(e); });
  detBar.addEventListener('pointerup', () => { detDrag = false; });
  function showDetector(fd) {
    const fill = $('detFill'), state = $('detState');
    if (!fd) { fill.style.width = '0'; state.textContent = 'not running'; state.className = ''; return; }
    fill.style.width = clamp(fd.level / DET_MAX, 0, 1) * 100 + '%';
    const on = fd.det >= 0.5;
    fill.className = on ? 'on' : '';
    state.className = on ? 'on' : '';
    state.textContent = (on ? 'streamer talking' : 'game / quiet') + ' · ' + Math.round(Math.min(0, fd.level - 24)) + ' dB vs streamer';
  }

  // ---------- recording ----------
  const recButtons = [...document.querySelectorAll('.rec-buttons button')];
  for (const b of recButtons) {
    b.addEventListener('click', async () => {
      const r = await send({ type: 'record', label: b.dataset.label });
      $('recStatus').textContent = r && r.ok ? 'Recording…' : 'Could not record: ' + ((r && r.error) || 'no video playing');
    });
  }
  function showRecording(rec) {
    if (!rec) return;
    for (const b of recButtons) b.className = rec.label === b.dataset.label ? 'busy' : '';
    const s = $('recStatus');
    if (rec.label && rec.left > 0) s.textContent = 'Recording "' + rec.label + '"… ' + rec.left.toFixed(0) + ' s left (popup can be closed)';
    else if (rec.label) s.textContent = 'Saving…';
    else if (rec.error) s.textContent = 'Saving failed: ' + rec.error;
    else if (rec.saved) s.textContent = 'Saved Downloads/stream-voice-leveler/' + rec.saved;
  }

  // ---------- start ----------
  async function init() {
    resize();
    readColors();
    const stored = await browser.storage.local.get('settings').catch(() => ({}));
    settings = Y.normalize(stored && stored.settings);
    if (!stored || !stored.settings) save();
    syncControls();
    computeResponse();
    draw();
    const tabs = await browser.tabs.query({ active: true, currentWindow: true }).catch(() => []);
    tabId = tabs && tabs[0] ? tabs[0].id : null;
    poll();
    setInterval(poll, 70);
  }
  window.addEventListener('resize', () => { resize(); draw(); });
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { readColors(); draw(); });
  init();
})();
