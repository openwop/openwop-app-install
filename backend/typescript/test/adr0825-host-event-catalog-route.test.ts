/**
 * ADR 0825 — `GET /host/openwop-app/host-events/catalog` serves the host-event
 * catalog from its one SSOT (`host/hostEventTypes.ts`), replacing the SPA's
 * hand-kept list (`settings/hostEventCatalog.ts`, retired with its
 * shrink-only parity baseline). The SSOT is pinned against every emit site by
 * `adr0825-rfc0236-host-events.test.ts`, so this test pins only that the route
 * serves exactly the SSOT, as JSON, and that every row is bindable.
 *
 * The non-vacuity floor (179) is the MEASURED catalog size at w62; a smaller
 * catalog fails here until the floor is lowered deliberately.
 *
 * Tracker TST-BHE-2. Sabotage-witnessed (w62): red when the route serves a
 * subset of the SSOT, or the binding route's eventType check stops accepting a
 * catalogued spelling outside both grammars (`crm.segment.entered`).
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Express } from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { hostEventTypeEntries } from '../src/host/hostEventTypes.js';
import { getSetCookies } from './headerCookies.js';

let BASE: string;
let server: http.Server;
let app: Express;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => {
    server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); });
  });
});
afterAll(async () => {
  await new Promise<void>((res) => server.close(() => res()));
});

async function signedIn(): Promise<string> {
  const res = await fetch(`${BASE}/host/openwop-app/test/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: `catalog-${Date.now()}@acme.test`, tenantId: `org:catalog-${Date.now()}` }),
  });
  expect(res.status).toBe(201);
  for (const c of getSetCookies(res.headers) as string[]) {
    const m = /(__session=[^;]+)/.exec(c);
    if (m) return m[1]!;
  }
  throw new Error('no session cookie');
}

describe('host-event catalog route (ADR 0825)', () => {
  it('serves exactly the SSOT, as JSON, with both spellings per row', async () => {
    const cookie = await signedIn();
    const res = await fetch(`${BASE}/host/openwop-app/host-events/catalog`, { headers: { cookie, accept: 'application/json' } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
    const body = (await res.json()) as { types: Array<{ emitted: string; type: string; delivery: string }> };
    const ssot = hostEventTypeEntries();
    // Non-vacuity: the SSOT is the real population, not an empty list.
    expect(ssot.length).toBeGreaterThanOrEqual(179);
    expect(body.types).toEqual(ssot.map((e) => ({ emitted: e.emitted, type: e.type, delivery: e.delivery })));
    // Rows the retired hand list was missing (its baseline) are now discoverable.
    const emitted = new Set(body.types.map((t) => t.emitted));
    for (const once of ['host.forms.submission.created', 'host.goals.evaluated', 'host.webinar.attended', 'openwop-app.entities.entity-written']) {
      expect(emitted.has(once), once).toBe(true);
    }
  });

  it('every catalog row is accepted by the binding route, in both spellings', async () => {
    const cookie = await signedIn();
    const body = (await (await fetch(`${BASE}/host/openwop-app/host-events/catalog`, { headers: { cookie } })).json()) as {
      types: Array<{ emitted: string; type: string }>;
    };
    // A binding to an unknown workflow is refused AFTER the eventType check, so a
    // 422 (not a 400) proves the name itself passed validation, with no row created.
    for (const row of body.types) {
      for (const name of [row.emitted, row.type]) {
        const res = await fetch(`${BASE}/host/openwop-app/host-events/bindings`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', cookie },
          body: JSON.stringify({ eventType: name, workflowId: 'nope.does-not-exist' }),
        });
        expect(res.status, name).toBe(422);
      }
    }
  });
});
