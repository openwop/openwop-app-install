/**
 * ADR 0812 P3c — a `/v1` WebSocket upgrade is refused `410`.
 *
 * A raw upgrade never reaches Express, so the negotiator's `/v1` front (410 / the
 * ADR 0806 308) never sees it. Before P3c `upgradePathname` STRIPPED a `/v1`, so a
 * retired host still opened sockets on the withdrawn path space. The registry now
 * answers the twin itself, and a bare path still reaches its handler.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { connect } from 'node:net';
import type { AddressInfo } from 'node:net';
import {
  attachRegisteredUpgradeHandlers,
  denyUpgrade,
  registerUpgradeHandler,
  upgradePathname,
} from '../src/host/upgradeRegistry.js';

let server: Server;
let port = 0;
const seen: string[] = [];

/** Send a raw upgrade request and return the status line the server answers with. */
function upgrade(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const sock = connect(port, '127.0.0.1', () => {
      sock.write(
        `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n`
        + 'Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n',
      );
    });
    let buf = '';
    sock.on('data', (d) => { buf += d.toString('utf8'); });
    sock.on('close', () => resolve(buf.split('\r\n')[0] ?? ''));
    sock.on('error', reject);
  });
}

beforeAll(async () => {
  registerUpgradeHandler({
    name: 'adr0812-p3c-witness',
    match: (p) => p === '/host/openwop-app/p3c-witness',
    // Answers 418 so the test can tell "reached the handler" from "refused before it".
    handle: (req, socket) => { seen.push(upgradePathname(req.url)); denyUpgrade(socket, 418, "I'm a teapot"); },
  });
  server = createServer((_req, res) => { res.statusCode = 404; res.end(); });
  attachRegisteredUpgradeHandlers(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

describe('ADR 0812 P3c — the /v1 path space refuses WebSocket upgrades', () => {
  it('a bare vendor path reaches its handler (control: the probe can see a handler run)', async () => {
    expect(await upgrade('/host/openwop-app/p3c-witness')).toMatch(/^HTTP\/1\.1 418 /);
    expect(await upgrade('/api/host/openwop-app/p3c-witness')).toMatch(/^HTTP\/1\.1 418 /);
    expect(seen).toEqual(['/host/openwop-app/p3c-witness', '/host/openwop-app/p3c-witness']);
  });

  it('its /v1 twin is refused 410 before any handler runs, with or without the /api prefix', async () => {
    seen.length = 0;
    for (const p of ['/v1/host/openwop-app/p3c-witness', '/api/v1/host/openwop-app/p3c-witness', '/v1']) {
      expect(await upgrade(p), p).toMatch(/^HTTP\/1\.1 410 /);
    }
    expect(seen, 'no handler may see a /v1 upgrade').toEqual([]);
  });

  it('upgradePathname no longer strips /v1, so no handler can match one', () => {
    expect(upgradePathname('/api/host/openwop-app/x?y=1')).toBe('/host/openwop-app/x');
    expect(upgradePathname('/v1/host/openwop-app/x')).toBe('/v1/host/openwop-app/x');
  });
});
