/**
 * KT-PORT-6a — the calendar-write provider adapter (SSRF-guarded, honesty-gated,
 * connection-backed). Mock-tested: a real Google write needs live OAuth creds this
 * env can't provide, so we pin the adapter's SHAPE against a loopback endpoint +
 * a seeded user-scoped Connection.
 *
 * COST CEILING: `createApp()` is booted because the Connections broker's secret
 * resolver is wired there (every connections test in this suite does the same —
 * e.g. `connection-acting-user-alias.test.ts`); it is not served or listened on.
 *
 * Sabotages that turn this red (w41 probes): the ENABLE-flag honesty gate, the
 * owner-credential lookup (actingUserId) and its fail-closed throw, the
 * google all-day `end` date, the sha1 event-id derivation, the unmodelled
 * provider's not-configured throw, and the SSRF private-host / plain-http refusals.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import http from 'node:http';
import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/index.js';
import { createSecretConnection } from '../src/features/connections/connectionsService.js';
import {
  calendarProviderTransport,
  calendarProviderConfigured,
  calendarEndpoint,
  registerCalendarProviderAdapter,
} from '../src/features/kicktodo-integrations/calendarProviderAdapter.js';
import { isCalendarTransportConfigured, __clearCalendarTransport } from '../src/features/kicktodo-integrations/calendarWriteService.js';

let server: http.Server;
let PORT = 0;
const PRIOR_DSN = process.env.OPENWOP_STORAGE_DSN;
const PRIOR_SESSION_SECRET = process.env.OPENWOP_SESSION_SECRET;
function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key]; else process.env[key] = value;
}
const seen: Array<{ method: string; url: string; auth: string; body: string }> = [];

const TENANT = 'tenant-cal';
const OWNER = 'user:cal-owner';
const eid = (externalId: string) => `kt${createHash('sha1').update(externalId).digest('hex')}`;

beforeAll(async () => {
  // Full app boot wires the secret resolver + surfaces the Connections layer needs.
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      seen.push({ method: req.method ?? '', url: req.url ?? '', auth: req.headers.authorization ?? '', body: raw });
      res.writeHead(200); res.end('{}');
    });
  });
  await new Promise<void>((r) => { server.listen(0, '127.0.0.1', () => r()); });
  const addr: AddressInfo | string | null = server.address();
  if (!addr || typeof addr === 'string') throw new Error('mock calendar has no TCP address');
  PORT = addr.port;
  // A user-scoped `google` Connection for the owner (calendar-write is per-participant).
  await createSecretConnection({ tenantId: TENANT, provider: 'google', kind: 'bearer', secret: 'owner-cal-token', scope: 'user', userId: OWNER });
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  restoreEnv('OPENWOP_STORAGE_DSN', PRIOR_DSN);
  restoreEnv('OPENWOP_SESSION_SECRET', PRIOR_SESSION_SECRET);
});
afterEach(() => {
  seen.length = 0;
  __clearCalendarTransport();
  for (const k of Object.keys(process.env)) {
    if (k.startsWith('OPENWOP_CALENDAR_PROVIDER') || k === 'OPENWOP_WEBHOOK_ALLOW_PRIVATE') delete process.env[k];
  }
});

describe('endpoint is provider-DERIVED (no operator endpoint env for a known provider)', () => {
  it('google resolves its known API base with NO endpoint env; the env is only an override', () => {
    // Default provider is `google` — its endpoint is derived, never operator-configured.
    expect(calendarEndpoint()).toBe('https://www.googleapis.com/calendar/v3/calendars/primary');
    process.env.OPENWOP_CALENDAR_PROVIDER_ENDPOINT = 'https://self-hosted.example/cal';
    expect(calendarEndpoint()).toBe('https://self-hosted.example/cal'); // override wins
  });
});

describe('calendarProviderConfigured — the honesty gate', () => {
  it('for google, only the ENABLE flag is needed (endpoint derived) — the env var is gone', () => {
    expect(calendarProviderConfigured()).toBe(false); // not opted in
    process.env.OPENWOP_CALENDAR_PROVIDER_ENABLED = 'true';
    expect(calendarProviderConfigured()).toBe(true); // no endpoint env required — derived for google
  });
});

describe('registerCalendarProviderAdapter — inert by default', () => {
  it('registers NOTHING when not opted in (the port stays honestly inert)', () => {
    registerCalendarProviderAdapter();
    expect(isCalendarTransportConfigured()).toBe(false);
  });
  it('registers the transport when the operator opts in (google — endpoint derived, no env)', () => {
    process.env.OPENWOP_CALENDAR_PROVIDER_ENABLED = 'true';
    registerCalendarProviderAdapter();
    expect(isCalendarTransportConfigured()).toBe(true);
  });
});

describe('the connection-backed transport', () => {
  it('upsert PUTs the event to the deterministic id with the OWNER\'s bearer credential', async () => {
    process.env.OPENWOP_CALENDAR_PROVIDER_ENDPOINT = `http://127.0.0.1:${PORT}/cal`;
    process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE = 'true';
    await calendarProviderTransport.upsert('enr1|2026-07-21|act1', { dateLocal: '2026-07-21', title: 'KickTodo day 1' }, { tenantId: TENANT, ownerSubject: OWNER });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.method).toBe('PUT');
    expect(seen[0]!.url).toBe(`/cal/events/${eid('enr1|2026-07-21|act1')}`);
    expect(seen[0]!.auth).toBe('Bearer owner-cal-token'); // resolved from the owner's Connection
    // provider `google` → the request is Google-SHAPED (all-day event, end exclusive),
    // not the toy {dateLocal,title} — the endpoint override still routes to the mock.
    expect(JSON.parse(seen[0]!.body)).toEqual({ summary: 'KickTodo day 1', start: { date: '2026-07-21' }, end: { date: '2026-07-22' } });
  });

  it('remove DELETEs the same deterministic id', async () => {
    process.env.OPENWOP_CALENDAR_PROVIDER_ENDPOINT = `http://127.0.0.1:${PORT}/cal`;
    process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE = 'true';
    await calendarProviderTransport.remove('enr1|2026-07-21|act1', { tenantId: TENANT, ownerSubject: OWNER });
    expect(seen[0]!.method).toBe('DELETE');
    expect(seen[0]!.url).toBe(`/cal/events/${eid('enr1|2026-07-21|act1')}`);
  });

  it('fails closed when the owner has NO authorized Connection (never writes unauthenticated)', async () => {
    process.env.OPENWOP_CALENDAR_PROVIDER_ENDPOINT = `http://127.0.0.1:${PORT}/cal`;
    process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE = 'true';
    await expect(
      calendarProviderTransport.upsert('e|d|a', { dateLocal: '2026-07-21', title: 't' }, { tenantId: TENANT, ownerSubject: 'user:no-connection' }),
    ).rejects.toThrow('calendar_provider_unauthorized');
    expect(seen).toHaveLength(0); // never reached the network
  });

  it('throws (generic) for an UNMODELLED provider with no override endpoint — never echoes the endpoint', async () => {
    // An unmodelled provider has no derived base; without an operator override there
    // is no endpoint to resolve (google, being modelled, never hits this).
    process.env.OPENWOP_CALENDAR_PROVIDER = 'some-unmodelled-provider';
    await expect(
      calendarProviderTransport.upsert('e|d|a', { dateLocal: '2026-07-21', title: 't' }, { tenantId: TENANT, ownerSubject: OWNER }),
    ).rejects.toThrow(/^calendar_provider_not_configured$/);
    expect(seen).toHaveLength(0);
  });

  it('SSRF: refuses a loopback endpoint unless private egress is explicitly allowed — never reaches the network', async () => {
    process.env.OPENWOP_CALENDAR_PROVIDER_ENDPOINT = `http://127.0.0.1:${PORT}/cal`;
    // NO OPENWOP_WEBHOOK_ALLOW_PRIVATE — the default posture.
    await expect(
      calendarProviderTransport.upsert('e|d|a', { dateLocal: '2026-07-21', title: 't' }, { tenantId: TENANT, ownerSubject: OWNER }),
    ).rejects.toThrow(/^calendar_provider_blocked$/);
    expect(seen).toHaveLength(0);
  });

  it('refuses plain http to a public host (https only without the private-egress opt-in)', async () => {
    process.env.OPENWOP_CALENDAR_PROVIDER_ENDPOINT = 'http://calendar.example.com/cal';
    await expect(
      calendarProviderTransport.upsert('e|d|a', { dateLocal: '2026-07-21', title: 't' }, { tenantId: TENANT, ownerSubject: OWNER }),
    ).rejects.toThrow(/^calendar_provider_insecure$/);
    expect(seen).toHaveLength(0);
  });
});
