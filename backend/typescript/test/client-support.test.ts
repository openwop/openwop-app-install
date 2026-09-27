/**
 * ADR 0413 host-side delta — the client-support handshake. Proves the advertise-only
 * min-supported-build endpoint: default floor 0 ⇒ everything supported; a per-platform
 * floor overrides the global one; a build below the floor is unsupported + carries the
 * platform upgrade URL; an UNKNOWN build is never gated (no lock-out); the route is
 * public (no auth) and makes zero writes.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/index.js';

describe('GET /v1/host/openwop-app/client-support (ADR 0413)', () => {
  let server: http.Server;
  let base: string;

  beforeAll(async () => {
    process.env.OPENWOP_STORAGE_DSN = 'memory://';
    const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
    await new Promise<void>((r) => { server = app.listen(0, '127.0.0.1', r); });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });
  afterEach(() => {
    for (const k of Object.keys(process.env)) {
      if (k.startsWith('OPENWOP_MIN_CLIENT_BUILD') || k.startsWith('OPENWOP_CLIENT_UPGRADE_URL')) delete process.env[k];
    }
  });

  const get = async (qs: string): Promise<{ status: number; body: Record<string, unknown> }> => {
    const res = await fetch(`${base}/v1/host/openwop-app/client-support${qs}`);
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };

  it('default floor 0 → everything supported (no-op until an operator sets a floor)', async () => {
    const { status, body } = await get('?build=1&platform=ios');
    expect(status).toBe(200);
    expect(body).toMatchObject({ platform: 'ios', minBuild: 0, build: 1, supported: true });
    expect(body.upgradeUrl).toBeUndefined();
  });

  it('a build below the global floor is unsupported and carries the upgrade URL', async () => {
    process.env.OPENWOP_MIN_CLIENT_BUILD = '100';
    process.env.OPENWOP_CLIENT_UPGRADE_URL = 'https://app.openwop.dev/upgrade';
    const below = await get('?build=42&platform=web');
    expect(below.body).toMatchObject({ minBuild: 100, build: 42, supported: false, upgradeUrl: 'https://app.openwop.dev/upgrade' });
    const at = await get('?build=100&platform=web');
    expect(at.body).toMatchObject({ minBuild: 100, supported: true });
    expect(at.body.upgradeUrl).toBeUndefined();
  });

  it('a per-platform floor overrides the global one', async () => {
    process.env.OPENWOP_MIN_CLIENT_BUILD = '10';
    process.env.OPENWOP_MIN_CLIENT_BUILD_IOS = '50';
    process.env.OPENWOP_CLIENT_UPGRADE_URL_IOS = 'https://apps.apple.com/app';
    // web uses the global floor (10) → build 20 supported
    expect((await get('?build=20&platform=web')).body).toMatchObject({ minBuild: 10, supported: true });
    // ios uses its own floor (50) → build 20 unsupported, with the ios store URL
    expect((await get('?build=20&platform=ios')).body).toMatchObject({ minBuild: 50, supported: false, upgradeUrl: 'https://apps.apple.com/app' });
  });

  it('an UNKNOWN build is never gated (no lock-out), even above a floor', async () => {
    process.env.OPENWOP_MIN_CLIENT_BUILD = '100';
    const { body } = await get('?platform=android'); // no build param
    expect(body).toMatchObject({ platform: 'android', minBuild: 100, supported: true });
    expect(body.build).toBeUndefined();
  });

  it('an unrecognized platform falls back to the global floor and reads `unknown`', async () => {
    process.env.OPENWOP_MIN_CLIENT_BUILD = '5';
    const { body } = await get('?build=3&platform=blackberry');
    expect(body).toMatchObject({ platform: 'unknown', minBuild: 5, build: 3, supported: false });
  });

  it('reads the build + platform from headers too', async () => {
    process.env.OPENWOP_MIN_CLIENT_BUILD_ANDROID = '7';
    const res = await fetch(`${base}/v1/host/openwop-app/client-support`, {
      headers: { 'x-openwop-client-build': '4', 'x-openwop-client-platform': 'android' },
    });
    expect(await res.json()).toMatchObject({ platform: 'android', minBuild: 7, build: 4, supported: false });
  });
});
