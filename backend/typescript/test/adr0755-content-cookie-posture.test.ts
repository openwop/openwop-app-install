/**
 * ADR 0755 (WIT-CNT-2) — the RFC 0103 §D content admin ops in the COOKIE posture:
 * a credential-less write is 401, and a host-minted ANONYMOUS session is refused
 * by the content gate itself, never treated as a personal-workspace owner.
 *
 * Split out of `adr0755-content-authority.test.ts` (wave 60, tracker TST-BRA-1):
 * `OPENWOP_AUTH_ENFORCE_BEARER` is read when the auth middleware is built, so this
 * posture needs its own app, and a second `createApp` re-initialises the shared
 * in-memory storage under every other case in that file.
 *
 * Red when `authorizeContent` admits `req.anonymousPrincipal` (the `anon:` tenant
 * then reads as the caller's own personal workspace and the draft lands 201).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { createApp } from '../src/index.js';
import { mintAnonSession, signSession } from '../src/middleware/cookieSession.js';

const ENV_KEYS = ['OPENWOP_API_KEYS', 'OPENWOP_AUTH_ENFORCE_BEARER', 'OPENWOP_DEPLOY_POSTURE', 'OPENWOP_I18N_LOCALES'] as const;
const saved: Record<string, string | undefined> = {};
let base = '';
let server: http.Server | undefined;

const draft = (pageId: string) => ({ pageId, slug: pageId, name: pageId, sectionOrder: ['hero'] });

beforeAll(async () => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  // ADR 0781 — major 2 serves the content family only while it is advertised (host i18n on).
  process.env.OPENWOP_I18N_LOCALES = 'en,es';
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_API_KEYS = 'k-op-0755-operator:*';
  process.env.OPENWOP_DEPLOY_POSTURE = 'bearer-shared';
  // The cookie posture: bearer enforcement OFF, so a header-less request may carry a session.
  delete process.env.OPENWOP_AUTH_ENFORCE_BEARER;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`; res(); }); });
});

afterAll(async () => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  if (server) await new Promise<void>((res) => server!.close(() => res()));
});

describe('ADR 0755 — content admin authority in the cookie posture', () => {
  it('WIT-CNT-2: in the cookie posture a credential-less write is 401, never an anonymous owner', async () => {
    // (1) No credential at all: since the ADR 0750 major-1 extension the auth
    // layer refuses it 401 before any gate, and mints no anonymous owner.
    const bare = await fetch(`${base}/content/pages`, { method: 'POST', headers: { 'content-type': 'application/json', 'openwop-version': '2' }, body: JSON.stringify(draft('anon-draft')) });
    expect(bare.status).toBe(401);
    expect(bare.headers.get('set-cookie'), 'a refusal mints no anonymous identity').toBeNull();
    // (2) An anonymous SESSION (what the SPA holds) reaches the content gate,
    // which must still refuse it — the WIT-CNT-2 property proper.
    const r = await fetch(`${base}/content/pages`, { method: 'POST', headers: { 'content-type': 'application/json', 'openwop-version': '2', cookie: `__session=${signSession(mintAnonSession())}` }, body: JSON.stringify(draft('anon-draft')) });
    const body = (await r.json()) as { details?: { reason?: string } };
    expect(r.status, JSON.stringify(body)).toBe(401);
    expect(body.details?.reason, 'refused by the content gate, not by the auth middleware').toBe('anonymous_principal_refused');
  });
});
