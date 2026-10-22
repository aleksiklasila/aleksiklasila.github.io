const s = simClientStats();
const c = _simClient;
return JSON.stringify({ stats: s, keys: Object.keys(c).filter(k => !/^(stats|play|world|frames|buffers)/.test(k)).slice(0, 120) }).slice(0, 6000);
