"""Local server for the game, as GitHub Pages serves it but cross-origin
isolated by its own headers.

The simulation's helper threads need SharedArrayBuffer, which a page only
gets when cross-origin isolated (COOP + COEP). On GitHub Pages the
coi-serviceworker adds those headers; a plain `python -m http.server` on
Windows serves .js as text/plain, the service worker is refused, and the
game runs on one thread (a big map then ticks a few times a second).

Usage (from anywhere):  python rng/defence3/serve.py [port]
Then open http://localhost:<port>/rng/defence3/   (default port 8000)
It serves the repository root, so paths are those of GitHub Pages.
"""
import http.server
import os
import socketserver
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8000


class Handler(http.server.SimpleHTTPRequestHandler):
    # (Not from the Windows registry: .js must be JavaScript for workers and
    # the service worker.)
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        '.js': 'text/javascript', '.mjs': 'text/javascript', '.cjs': 'text/javascript',
        '.json': 'application/json', '.wasm': 'application/wasm', '.css': 'text/css',
        '.html': 'text/html', '.svg': 'image/svg+xml', '.png': 'image/png',
        '.webp': 'image/webp', '.glb': 'model/gltf-binary', '.wav': 'audio/wav', '.mp3': 'audio/mpeg',
    }

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def end_headers(self):
        self.send_header('Cross-Origin-Opener-Policy', 'same-origin')
        # (credentialless: cross-origin images and iframes without CORP still
        # load, as with the coi-serviceworker's default.)
        self.send_header('Cross-Origin-Embedder-Policy', 'credentialless')
        self.send_header('Cross-Origin-Resource-Policy', 'same-origin')
        # (Edited files are picked up on reload.)
        self.send_header('Cache-Control', 'no-cache')
        super().end_headers()


class Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


if __name__ == '__main__':
    with Server(('127.0.0.1', PORT), Handler) as httpd:
        print(f'Serving {ROOT}\nOpen http://localhost:{PORT}/rng/defence3/  (cross-origin isolated)')
        httpd.serve_forever()
