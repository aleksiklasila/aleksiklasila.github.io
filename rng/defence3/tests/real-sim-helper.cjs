// Browser helper-worker adapter for headless scale measurements.
'use strict';
const { Worker, isMainThread, parentPort, MessageChannel } = require('node:worker_threads');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
if (!isMainThread) {
    globalThis.self = { crossOriginIsolated: true };
    globalThis.MessageChannel = MessageChannel;
    globalThis.importScripts = (...files) => {
        for (const file of files) vm.runInThisContext(fs.readFileSync(path.join(__dirname, '../src/sim', file.split('?')[0]), 'utf8'), { filename: file });
    };
    importScripts('sim_helper.js');
    parentPort.on('message', data => self.onmessage({ data }));
} else {
    module.exports = class RealSimHelper {
        constructor() {
            this.worker = new Worker(__filename);
            this.worker.on('error', err => { throw err; });
        }
        postMessage(msg) { this.worker.postMessage(msg); }
        terminate() { return this.worker.terminate(); }
    };
}
