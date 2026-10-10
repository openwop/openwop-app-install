/**
 * ADR 0785 P2 — a registry for raw WebSocket upgrade handlers owned by features.
 *
 * `createApp` returns Express, and only `main()` holds the `http.Server`, so a
 * feature that needs an upgrade path had no seam: the one existing handler
 * (collab) is attached by name in `index.ts`. Wiring a feature the same way
 * would make core import the feature, which the ADR 0630 boundary forbids and
 * which would defeat a distribution that excludes it.
 *
 * So a feature REGISTERS here from its `registerRoutes` (the ADR 0318
 * fill-a-seam pattern), and `main()` attaches the registry once. Each handler
 * owns only the paths its `match` accepts; a path nobody matches is left alone
 * for any other listener (collab keeps its own).
 *
 * A raw upgrade BYPASSES the Express middleware chain — no CORS, no auth, no
 * rate limit, no body parsing. A handler is therefore responsible for its own
 * origin check, authentication, toggle gate and caps, and must reject by
 * writing a status line and destroying the socket (`denyUpgrade`), never by
 * completing the handshake.
 */
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { createLogger } from '../observability/logger.js';
import { V1_PATH_PREFIX } from '../middleware/protocolVersion.js';

const log = createLogger('host.upgradeRegistry');

export interface UpgradeHandler {
  /** Stable name, for logs and idempotent re-registration. */
  name: string;
  /** Does this handler own the request path (already stripped of any query)? */
  match: (pathname: string) => boolean;
  handle: (req: IncomingMessage, socket: Duplex, head: Buffer) => void | Promise<void>;
}

const handlers = new Map<string, UpgradeHandler>();

/** Idempotent by name (feature boot re-runs under test isolation). */
export function registerUpgradeHandler(handler: UpgradeHandler): void {
  handlers.set(handler.name, handler);
}

/** Reject an upgrade with an HTTP status — never complete the handshake. */
export function denyUpgrade(socket: Duplex, status: number, reason: string): void {
  if (socket.destroyed) return;
  socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

/** The `/api` prefix Firebase preserves is not part of a handler's path. */
export function upgradePathname(url: string | undefined): string {
  const raw = (url ?? '/').split('?')[0] ?? '/';
  return raw.replace(/^\/api(?=\/)/, '');
}

/**
 * ADR 0812 P3c — a `/v1` upgrade is refused `410`, the WebSocket twin of the
 * negotiator's front. A raw upgrade never reaches Express, so without this the
 * withdrawn path space would still open sockets on a retired host.
 */
export function isRetiredUpgradePath(pathname: string): boolean {
  return pathname === V1_PATH_PREFIX || pathname.startsWith(`${V1_PATH_PREFIX}/`);
}

const attached = new WeakSet<Server>();

/** Called once from `main()` (and by tests on their own server). */
export function attachRegisteredUpgradeHandlers(server: Server): void {
  if (attached.has(server)) return;
  attached.add(server);
  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const path = upgradePathname(req.url);
    if (isRetiredUpgradePath(path)) { denyUpgrade(socket, 410, 'Gone'); return; }
    for (const h of handlers.values()) {
      if (!h.match(path)) continue;
      Promise.resolve(h.handle(req, socket, head)).catch((err: unknown) => {
        log.warn('upgrade_handler_failed', { handler: h.name, error: err instanceof Error ? err.message : String(err) });
        denyUpgrade(socket, 500, 'Internal Server Error');
      });
      return;
    }
    // Not ours: leave it for collab or any other listener.
  });
}

/** Test-only. */
export function __listUpgradeHandlersForTest(): string[] {
  return [...handlers.keys()];
}
