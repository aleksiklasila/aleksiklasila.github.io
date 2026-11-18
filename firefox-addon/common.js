'use strict';
// Shared between the content script and the popup: defaults, presets,
// and the mapping from UI "amount" knobs to compressor parameters.
(function (root) {
  const EQ_TYPES = ['lowshelf', 'peaking', 'highshelf'];

  function eqBands(gains) {
    const base = [
      { type: 'lowshelf', freq: 60, q: 0.7 },
      { type: 'peaking', freq: 150, q: 1.0 },
      { type: 'peaking', freq: 400, q: 1.0 },
      { type: 'peaking', freq: 1000, q: 1.0 },
      { type: 'peaking', freq: 2500, q: 1.0 },
      { type: 'peaking', freq: 5000, q: 1.0 },
      { type: 'peaking', freq: 9000, q: 1.0 },
      { type: 'highshelf', freq: 14000, q: 0.7 },
    ];
    return base.map((b, i) => ({ ...b, gain: (gains && gains[i]) || 0 }));
  }

  // Settings layout version. Older stored settings (from versions that dipped
  // the clarity range and compressed by default) are replaced once by these.
  const SETTINGS_VERSION = 2;

  // Every number the audio chain reads. dB values unless noted. Defaults keep
  // the original sound: only streamer focus (raising the game per range) is active.
  const DEFAULTS = {
    version: SETTINGS_VERSION,
    enabled: true,
    gameBoost: 12, // dB, most the game is raised while the streamer is quiet (0 = off)
    focusLevel: 4, // dB the streamer stays above the raised game
    focusTrigger: 19, // detector line, 0..24 where 24 = the streamer's loud level (19 = within 5 dB of it)
    voiceTamer: 0, // 0..1 compression of the voice band
    voiceGain: 0, // dB, voice band level after compression
    centerGain: 0, // dB, centre (mono) part of the voice band only
    lowGain: 0, // dB, everything below the voice band
    highGain: 0, // dB, everything above the voice band
    xoverLow: 200, // Hz, voice band lower edge
    xoverHigh: 5000, // Hz, voice band upper edge
    leveler: 0, // 0..1 whole-mix leveling (raises quiet sounds)
    output: 0, // dB
    eq: eqBands(),
  };

  const PRESETS = {
    quieter: { label: 'Raise the game (original sound)', values: {} },
    flat: { label: 'Off (no change at all)', values: { gameBoost: 0 } },
    strong: { label: 'Raise the game more', values: { gameBoost: 18, focusLevel: 1 } },
    night: { label: 'Night mode (everything even)', values: { gameBoost: 12, leveler: 0.6, output: -2 } },
    centercut: { label: 'Raise game + centre cut', values: { gameBoost: 12, centerGain: -6 } },
  };

  function presetSettings(name, keepEnabled) {
    const p = PRESETS[name] || PRESETS.quieter;
    const s = normalize({ ...clone(DEFAULTS), ...clone(p.values) });
    if (keepEnabled !== undefined) s.enabled = keepEnabled;
    return s;
  }

  function clone(v) { return JSON.parse(JSON.stringify(v)); }
  function num(v, lo, hi, def) {
    v = Number(v);
    if (!Number.isFinite(v)) return def;
    return Math.min(hi, Math.max(lo, v));
  }

  function normalize(raw) {
    let r = raw && typeof raw === 'object' ? raw : {};
    if (r.version !== SETTINGS_VERSION) r = { enabled: r.enabled };
    const d = DEFAULTS;
    const s = {
      version: SETTINGS_VERSION,
      enabled: r.enabled === undefined ? d.enabled : !!r.enabled,
      gameBoost: num(r.gameBoost, 0, 24, d.gameBoost),
      solo: Math.round(num(r.solo, 0, 2, 0)),
      focusLevel: num(r.focusLevel, -12, 18, d.focusLevel),
      focusTrigger: num(r.focusTrigger, 0, 24, d.focusTrigger),
      voiceTamer: num(r.voiceTamer, 0, 1, d.voiceTamer),
      voiceGain: num(r.voiceGain, -18, 12, d.voiceGain),
      centerGain: num(r.centerGain, -24, 0, d.centerGain),
      lowGain: num(r.lowGain, -12, 18, d.lowGain),
      highGain: num(r.highGain, -12, 18, d.highGain),
      xoverLow: num(r.xoverLow, 60, 1000, d.xoverLow),
      xoverHigh: num(r.xoverHigh, 1500, 12000, d.xoverHigh),
      leveler: num(r.leveler, 0, 1, d.leveler),
      output: num(r.output, -18, 18, d.output),
      eq: [],
    };
    if (s.xoverHigh < s.xoverLow * 2) s.xoverHigh = s.xoverLow * 2;
    const eq = Array.isArray(r.eq) ? r.eq : d.eq;
    for (let i = 0; i < d.eq.length; i++) {
      const b = eq[i] || d.eq[i];
      const db = d.eq[i];
      s.eq.push({
        type: EQ_TYPES.includes(b.type) ? b.type : db.type,
        freq: num(b.freq, 20, 20000, db.freq),
        gain: num(b.gain, -18, 18, 0),
        q: num(b.q, 0.2, 12, db.q),
      });
    }
    return s;
  }

  // Voice band compressor: pulls loud speech down. Its built-in makeup
  // gain is cancelled (measured below threshold), so quiet parts of the
  // band are left alone and only the loud parts come down.
  function voiceComp(a) {
    return { threshold: -12 - 30 * a, ratio: 1 + 7 * a, knee: 10, attack: 0.005, release: 0.2, anchorDb: -90 };
  }
  // Whole-mix leveler: compensated so a loud -14 dBFS signal keeps its
  // level, so quiet sounds (background) are raised instead.
  function levelerComp(a) {
    return { threshold: -14 - 30 * a, ratio: 1 + 5 * a, knee: 12, attack: 0.02, release: 0.4, anchorDb: -14 };
  }
  const LIMITER = { threshold: -1.5, ratio: 20, knee: 0, attack: 0.001, release: 0.08, anchorDb: -90 };
  // Low/high bands carry a do-nothing compressor so all three bands get
  // the same compressor look-ahead delay and still sum back flat.
  const NEUTRAL = { threshold: 0, ratio: 1, knee: 0, attack: 0.005, release: 0.2, anchorDb: -90 };

  // What each part of the spectrum sounds like (used for graph labels).
  const REGIONS = [
    [20, 60, 'Sub', 'rumble, explosions you feel more than hear'],
    [60, 250, 'Bass', 'bass, kick drums, depth of a voice'],
    [250, 800, 'Low mids', 'warmth, body of the voice, boominess'],
    [800, 3000, 'Voice', 'speech clarity and intelligibility'],
    [3000, 6000, 'Presence', 'bite, harshness, many game effects', 'Pres.'],
    [6000, 10000, 'Sibilance', 's and t sounds, cymbals', 'S'],
    [10000, 20000, 'Air', 'sparkle, ambience, room sound'],
  ];

  const SPECTRUM_POINTS = 160;
  const SPECTRUM_MIN_HZ = 20;
  const SPECTRUM_MAX_HZ = 20000;

  root.YTEQ = {
    DEFAULTS, PRESETS, EQ_TYPES, REGIONS, LIMITER, NEUTRAL,
    SPECTRUM_POINTS, SPECTRUM_MIN_HZ, SPECTRUM_MAX_HZ,
    normalize, presetSettings, voiceComp, levelerComp, clone,
    dbToGain: (db) => Math.pow(10, db / 20),
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
