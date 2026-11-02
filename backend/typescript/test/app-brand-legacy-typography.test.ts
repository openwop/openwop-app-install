/**
 * ADR 0883 correction — the app background job
 * `clear-frozen-legacy-default-typography` (host/appMigrations.ts, not an app
 * migration) drops the frozen copy of the legacy default typography (Instrument
 * Serif "Editorial (default)") from the app brand, and nothing else. Driven
 * through the real routes: a super admin stores the identity, the helper runs,
 * `/public-brand` is what the SPA would apply. The legacy set is pinned here as
 * literals, so a drift of the product constant cannot move the fixture with it.
 *
 * TST-BXE-3. Red when: the exact-set match loosens (an operator's own choice is
 * cleared), the write keeps the typography, the other identity fields are
 * dropped, or the "absent" answer changes (w66 probes lt-every/write/rest/absent).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createApp } from '../src/index.js';
import { clearLegacyDefaultTypography } from '../src/host/systemBrand.js';

/** The frozen legacy default as shipped (ADR 0883) — literals, not the product constant. */
const LEGACY = {
  serif: '"Instrument Serif", "Times New Roman", serif',
  sans: '"Geist", ui-sans-serif, system-ui, sans-serif',
  mono: '"Geist Mono", ui-monospace, "SF Mono", Menlo, monospace',
  fontsHref: 'https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=Geist:wght@300;400;500;600;700&family=Geist+Mono:wght@400;500&display=swap',
};

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

describe('clearLegacyDefaultTypography (background job clear-frozen-legacy-default-typography)', () => {
  it('drops the frozen legacy default and keeps every other field', async () => {
    expect((await put({ colors: { accent: 'oklch(58% 0.13 40)' }, productName: 'Acme', typography: { ...LEGACY } })).status).toBe(200);
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
    const mine = { ...LEGACY, sans: '"Inter", ui-sans-serif, system-ui, sans-serif' };
    expect((await put({ typography: mine })).status).toBe(200);
    expect(await clearLegacyDefaultTypography()).toEqual({ cleared: false, reason: 'operator-choice' });
    expect((await publicIdentity()).typography).toEqual(mine);
  });
});
