import { createServer, type Server } from 'node:http';
import type { Socket } from 'node:net';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deriveNeverCache } from '../scripts/gen-service-worker.mjs';

/**
 * ADR 0873 Verification 2–3 — a stand-in for Firebase Hosting in front of a fixture
 * build (scripts/build-offline-fixture.mjs).
 *
 * It answers the way the `app` hosting target does: an exact static file first, then
 * the `firebase.json` rewrites in order. A Cloud Run rewrite is answered with a
 * marker (this lane has no backend) that carries a per-request counter, so a response
 * replayed from a cache is distinguishable from a fresh one (`X-Cloud-Run`). Everything else falls
 * through to `/app-shell.html`, as `**` does, which is also what a pruned chunk gets
 * after a deploy: `text/html` where a module was expected.
 *
 * "Offline" is a real network failure: `goOffline()` closes the listener and destroys
 * every open socket, so the browser gets connection refused. Emulated offline
 * (`context.setOffline`) is not used, because whether it reaches a service worker's
 * own fetches is a property of the browser build, and that is the thing under test.
 */
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
};

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const cloudRun = deriveNeverCache(JSON.parse(readFileSync(join(repoRoot, 'firebase.json'), 'utf8')), 'app').map(
  (r) => new RegExp(r.source),
);

export interface FixtureServer {
  readonly origin: string;
  /** Serve a different build from now on: a deploy. */
  deploy(dir: string): void;
  goOffline(): Promise<void>;
  goOnline(): Promise<void>;
  close(): Promise<void>;
  /** Paths the server answered, in order. */
  readonly served: string[];
}

export async function startFixtureServer(port: number, dir: string): Promise<FixtureServer> {
  let root = dir;
  let runCounter = 0;
  const served: string[] = [];
  const sockets = new Set<Socket>();

  const server: Server = createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
    served.push(path);
    if (cloudRun.some((re) => re.test(path))) {
      runCounter += 1;
      // The API answers as a backend that is down (the app degrades on a 503, while a
      // made-up JSON body would be read as data); a document path gets a marker page.
      // Both carry the counter, so a replay from a cache would show a stale value.
      const api = path.startsWith('/api/');
      res.writeHead(api ? 503 : 200, {
        'Content-Type': api ? 'text/plain; charset=utf-8' : 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Cloud-Run': String(runCounter),
      });
      res.end(api ? `cloud-run ${runCounter}` : `<!doctype html><title>cloud-run</title><p data-cloud-run="${runCounter}">cloud-run</p>`);
      return;
    }
    const file = normalize(join(root, path));
    const isFile = file.startsWith(root) && existsSync(file) && statSync(file).isFile();
    const target = isFile ? file : join(root, 'app-shell.html');
    res.writeHead(200, {
      'Content-Type': TYPES[extname(target)] ?? 'application/octet-stream',
      'Cache-Control': isFile && path.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
    });
    res.end(readFileSync(target));
  });
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });

  const listen = () => new Promise<void>((ok, fail) => {
    server.once('error', fail);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', fail);
      ok();
    });
  });
  const stop = () => new Promise<void>((ok) => {
    if (!server.listening) return ok();
    server.close(() => ok());
    for (const s of sockets) s.destroy();
  });

  await listen();
  return {
    // 127.0.0.1, not localhost: the listener is IPv4 only, and both are secure
    // contexts, which a service worker needs.
    origin: `http://127.0.0.1:${port}`,
    deploy: (next) => { root = next; },
    goOffline: stop,
    goOnline: listen,
    close: stop,
    served,
  };
}
