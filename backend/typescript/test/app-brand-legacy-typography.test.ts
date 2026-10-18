/**
 * ADR 0883 correction — migration 23 drops the frozen copy of the legacy default
 * typography (Instrument Serif "Editorial (default)") from the app brand, and
 * nothing else. Driven through the real routes: a super admin stores the identity,
 * the migration helper runs, `/public-brand` is what the SPA would apply.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createApp } from '../src/index.js';
import { clearLegacyDefaultTypography, LEGACY_DEFAULT_TYPOGRAPHY } from '../src/host/systemBrand.js';

let BASE: string;
const ADMIN = { authorization: 'Bearer dev-token', 'content-type': 'application/json' };
let server: Server;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  delete process.env.OPENWOP_SUPERADMIN_TENANTS;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

const put = (identity: unknown) => fetch(`${BASE}/host/openwop-app/app-brand`, { method: 'PUT', headers: ADMIN, body: JSON.stringify({ identity }) });
const publicIdentity = async () => ((await (await fetch(`${BASE}/host/openwop-app/public-brand`)).json()) as { identity: Record<string, unknown> }).identity;

describe('clearLegacyDefaultTypography (migration 23)', () => {
  it('drops the frozen legacy default and keeps every other field', async () => {
    expect((await put({ colors: { accent: 'oklch(58% 0.13 40)' }, productName: 'Acme', typography: { ...LEGACY_DEFAULT_TYPOGRAPHY } })).status).toBe(200);
    expect(JSON.stringify(await publicIdentity())).toContain('Instrument Serif');
    expect(await clearLegacyDefaultTypography()).toEqual({ cleared: true, reason: 'cleared' });
    const after = await publicIdentity();
    expect(after.typography).toBeUndefined();
    expect(after.colors).toEqual({ accent: 'oklch(58% 0.13 40)' });
    expect(after.productName).toBe('Acme');
    // Idempotent: a second boot finds nothing to clear.
    expect(await clearLegacyDefaultTypography()).toEqual({ cleared: false, reason: 'absent' });
  });

  it("keeps an operator's own Instrument Serif choice (not the exact legacy set)", async () => {
    const mine = { ...LEGACY_DEFAULT_TYPOGRAPHY, sans: '"Inter", ui-sans-serif, system-ui, sans-serif' };
    expect((await put({ typography: mine })).status).toBe(200);
    expect(await clearLegacyDefaultTypography()).toEqual({ cleared: false, reason: 'operator-choice' });
    expect((await publicIdentity()).typography).toEqual(mine);
  });
});
