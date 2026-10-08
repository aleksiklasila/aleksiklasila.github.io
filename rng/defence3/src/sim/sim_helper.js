"use strict";
// A helper of the simulation worker: runs its parallel jobs (sim_parallel.js).
importScripts('sim_parallel.js?v=20261008-brain1');
// The Rust kernels (instantiated over the simulation's memory at init).
importScripts('sim_wasm_bin.js?v=20261008-brain1');
importScripts('sim_wasm.js?v=20261008-brain1');
importScripts('sim_frame.js?v=20261008-brain1');
// The navigation build's kernels (flow navigation, see flownav.js).
importScripts('../game/flownav.js?v=20261021-w');
simParallelHelperMain();
