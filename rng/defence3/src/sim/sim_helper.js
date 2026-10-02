"use strict";
// A helper of the simulation worker: runs its parallel jobs (sim_parallel.js).
importScripts('sim_parallel.js?v=20261016-a');
importScripts('sim_frame.js?v=20261008-a');
// The navigation build's kernels (flow navigation, see flownav.js).
importScripts('../game/flownav.js?v=20261012-a');
simParallelHelperMain();
