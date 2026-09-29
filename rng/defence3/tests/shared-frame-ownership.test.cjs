// Exercise the full page/worker frame protocol with real shared-memory clones
// and ArrayBuffer detachment. The regular harness uses the non-isolated path.
process.env.SIM_SHARED = '1';
require('./sim-frame-replica.test.cjs');
