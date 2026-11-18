// Node check of dfn/svl_dfn.wasm: loads the model, runs a WAV clip through it,
// reports speed per 10 ms hop and the delay between input and speech output.
// usage: node dev/dfn-node-test.cjs <clip.wav>
'use strict';
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const wasm = fs.readFileSync(path.join(root, 'dfn/svl_dfn.wasm'));
const model = fs.readFileSync(path.join(root, 'dfn/DeepFilterNet3_onnx.tar.gz'));

function readWav(file) {
  const b = fs.readFileSync(file);
  const ch = b.readUInt16LE(22), sr = b.readUInt32LE(24), bits = b.readUInt16LE(34);
  let off = 12;
  while (b.toString('ascii', off, off + 4) !== 'data') off += 8 + b.readUInt32LE(off + 4);
  const n = b.readUInt32LE(off + 4) / (ch * bits / 8);
  const mid = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let c = 0; c < ch; c++) s += b.readInt16LE(off + 8 + (i * ch + c) * 2) / 32768;
    mid[i] = s / ch;
  }
  return { sr, mid };
}
function resample(x, from, to) {
  if (from === to) return x;
  const n = Math.floor(x.length * to / from), y = new Float32Array(n);
  for (let i = 0; i < n; i++) { const t = i * from / to, j = Math.floor(t), f = t - j; y[i] = (x[j] || 0) * (1 - f) + (x[j + 1] || 0) * f; }
  return y;
}

(async () => {
  const t0 = performance.now();
  const { instance } = await WebAssembly.instantiate(wasm, {});
  const x = instance.exports;
  const t1 = performance.now();
  const ptr = x.svl_alloc(model.length);
  new Uint8Array(x.memory.buffer, ptr, model.length).set(model);
  const st = x.svl_create(ptr, model.length, 100);
  x.svl_free(ptr, model.length);
  const t2 = performance.now();
  if (!st) throw new Error('svl_create failed');
  const hop = x.svl_hop(st), la = x.svl_lookahead(st);
  console.log(`compile+instantiate ${(t1 - t0).toFixed(0)} ms, model load ${(t2 - t1).toFixed(0)} ms, hop ${hop}, lookahead ${la}`);

  const { sr, mid } = readWav(process.argv[2]);
  const inp = resample(mid, sr, 48000);
  const out = new Float32Array(inp.length);
  const nh = Math.floor(inp.length / hop);
  const times = [];
  for (let h = 0; h < nh; h++) {
    new Float32Array(x.memory.buffer, x.svl_input_ptr(st), hop).set(inp.subarray(h * hop, (h + 1) * hop));
    const a = performance.now();
    x.svl_process(st);
    times.push(performance.now() - a);
    out.set(new Float32Array(x.memory.buffer, x.svl_output_ptr(st), hop), h * hop);
  }
  times.sort((a, b) => a - b);
  const mean = times.reduce((a, b) => a + b, 0) / times.length;
  console.log(`per 10 ms hop: mean ${mean.toFixed(2)} ms, p50 ${times[times.length >> 1].toFixed(2)}, p99 ${times[Math.floor(times.length * 0.99)].toFixed(2)}, max ${times[times.length - 1].toFixed(2)}  (real-time load ${(100 * mean / 10).toFixed(0)} % of one core)`);

  // Delay: lag that best aligns speech output with the input.
  let best = -Infinity, lag = 0;
  for (let d = 0; d < 4000; d++) {
    let s = 0;
    for (let i = 48000; i < inp.length - 4000; i += 3) s += inp[i] * out[i + d];
    if (s > best) { best = s; lag = d; }
  }
  const e = (a) => 10 * Math.log10(a.reduce((s, v) => s + v * v, 0) / a.length + 1e-12);
  console.log(`delay ${lag} samples (${(lag / 48).toFixed(1)} ms); formula hop+lookahead*hop = ${hop + la * hop}; input ${e(inp).toFixed(1)} dB, speech part ${e(out).toFixed(1)} dB`);
})().catch((err) => { console.error(err); process.exit(1); });
