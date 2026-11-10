/**
 * ADR 1056 — the grouped footer's call to action and bottom-bar utility links
 * ride a page's `siteNav` (ADR 1049) as two more optional fields:
 *
 *   - `cta` — the footer button label (string, trimmed, capped at 40, content
 *     lane); a non-string is a 400, a blank one is dropped;
 *   - `utility` — list the page in the footer's bottom bar (boolean); a
 *     non-boolean is a 400, `false` is not stored;
 *   - both round-trip on PATCH and reach the public nav list's `nav`.
 *
 * Sabotage-witnessed (w88 probes): dropping the cta branch or raising its cap
 * reds "accepts"; storing a blank cta or `utility:false` reds "drops";
 * coercing a non-string `cta` reds "refuses" and the route case; accepting a
 * non-boolean `utility` reds "refuses".
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { cleanSiteNav } from '../src/features/cms/cmsService.js';
import { OpenwopError } from '../src/types.js';
import { errorCodeOf } from './helpers/errorEnvelope.js';

let BASE: string;
let server: http.Server;
let savedTtl: string | undefined;
const ADMIN = { authorization: 'Bearer dev-token', 'content-type': 'application/json' };
const SITE = '/host/openwop-app/cms/orgs/host-site';

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  savedTtl = process.env.OPENWOP_PUBLIC_LIST_TTL_S;
  process.env.OPENWOP_PUBLIC_LIST_TTL_S = '0'; // the public list memo would hide the publish
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
});
afterAll(async () => {
  if (savedTtl === undefined) Reflect.deleteProperty(process.env, 'OPENWOP_PUBLIC_LIST_TTL_S'); else process.env.OPENWOP_PUBLIC_LIST_TTL_S = savedTtl;
  await new Promise<void>((res) => server.close(() => res()));
});

const admin = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> => {
  const r = await fetch(`${BASE}${path}`, { method, headers: ADMIN, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as Record<string, unknown> };
};

function refusal(fn: () => unknown): OpenwopError {
  try { fn(); } catch (err) { if (err instanceof OpenwopError) return err; throw err; }
  throw new Error('expected a refusal');
}

describe('cleanSiteNav cta + utility (ADR 1056)', () => {
  it('accepts a trimmed, capped cta label and a true utility flag', () => {
    expect(cleanSiteNav({ group: 'company', cta: '  Book a call  ', utility: true }))
      .toEqual({ group: 'company', cta: 'Book a call', utility: true });
    expect(cleanSiteNav({ cta: 'C'.repeat(80) })?.cta).toHaveLength(40);
  });

  it('drops a blank cta and a false utility, so neither alone keeps the object', () => {
    expect(cleanSiteNav({ cta: '   ', utility: false })).toBeUndefined();
    expect(cleanSiteNav({ group: 'legal', utility: false })).toEqual({ group: 'legal' });
  });

  it('refuses a non-string cta or a non-boolean utility with a 400 (never coerced)', () => {
    for (const bad of [{ cta: 7 }, { cta: true }, { utility: 'yes' }, { utility: 1 }]) {
      const err = refusal(() => cleanSiteNav(bad));
      expect(err.code, JSON.stringify(bad)).toBe('validation_error');
      expect(err.httpStatus, JSON.stringify(bad)).toBe(400);
    }
  });
});

describe('cta + utility over the CMS routes + public nav list (ADR 1056)', () => {
  it('round-trips on PATCH and reaches the published nav row', async () => {
    const created = await admin('POST', `${SITE}/pages`, { title: 'Talk to us', slug: 'adr1056-contact' });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const pageId = String(created.body.pageId);
    const patched = await admin('PATCH', `${SITE}/pages/${pageId}`, { siteNav: { group: 'company', label: 'Contact', cta: 'Book a call', utility: true } });
    expect(patched.status, JSON.stringify(patched.body)).toBe(200);
    expect(patched.body.siteNav).toEqual({ group: 'company', label: 'Contact', cta: 'Book a call', utility: true });
    const refused = await admin('PATCH', `${SITE}/pages/${pageId}`, { siteNav: { cta: 3 } });
    expect(refused.status).toBe(400);
    expect(errorCodeOf(refused.body)).toBe('validation_error');
    expect((await admin('POST', `${SITE}/pages/${pageId}/publish`)).status).toBe(200);
    const rows = ((await (await fetch(`${BASE}/host/openwop-app/public/host-site/pages`)).json()) as { pages: Array<{ slug: string; nav?: unknown }> }).pages;
    expect(rows.find((p) => p.slug === 'adr1056-contact')?.nav).toEqual({ group: 'company', label: 'Contact', cta: 'Book a call', utility: true });
  });
});
