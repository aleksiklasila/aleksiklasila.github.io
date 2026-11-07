'use strict';
// Preloaded by tests/run-full.cjs (NODE_OPTIONS --require) so unattended runs
// open no browser windows: forces headless on Playwright launches. Patches only
// when a process actually loads Playwright.
const Module = require('node:module'), load = Module._load, seen = new WeakSet();
Module._load = function (name) {
    const result = load.apply(this, arguments);
    if (/playwright/.test(name) && result && result.chromium) {
        for (const type of [result.chromium, result.firefox, result.webkit]) {
            if (!type || seen.has(type)) continue;
            seen.add(type);
            const launch = type.launch, persistent = type.launchPersistentContext;
            type.launch = function (options = {}) { return launch.call(this, { ...options, headless: true }); };
            type.launchPersistentContext = function (dir, options = {}) { return persistent.call(this, dir, { ...options, headless: true }); };
        }
    }
    return result;
};
