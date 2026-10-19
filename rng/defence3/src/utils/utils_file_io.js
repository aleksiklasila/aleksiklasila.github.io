"use strict";

// Detect gzip by its contents, so renamed files and .json.gz also work.
async function openJsonFileStream(file) {
    const signature = new Uint8Array(await file.slice(0, 2).arrayBuffer());
    let stream = file.stream();
    if (signature[0] === 0x1f && signature[1] === 0x8b) {
        if (typeof DecompressionStream !== 'function') throw new Error('This browser cannot decompress gzip files.');
        stream = stream.pipeThrough(new DecompressionStream('gzip'));
    }
    return stream;
}

async function makeJsonExportBlob(parts, compressed) {
    const blob = new Blob(parts, { type: 'application/json' });
    if (!compressed) return blob;
    if (typeof CompressionStream !== 'function') throw new Error('This browser cannot compress gzip files. Choose JSON instead.');
    const stream = blob.stream().pipeThrough(new CompressionStream('gzip'));
    return new Response(stream, { headers: { 'Content-Type': 'application/gzip' } }).blob();
}

function downloadJsonExport(blob, prefix, compressed) {
    const url = URL.createObjectURL(blob), a = document.createElement('a');
    a.href = url;
    a.download = prefix + '-' + new Date().toISOString().replace(/[:.]/g, '-') + (compressed ? '.gz' : '.json');
    document.body.appendChild(a);
    try { a.click(); } finally { a.remove(); setTimeout(() => URL.revokeObjectURL(url), 60000); }
}
