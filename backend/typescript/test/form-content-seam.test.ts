/**
 * RFC 0137 — the conformance seam, tested host-side.
 *
 * The published leg (`form-content-instantiation.test.ts`, openwop#885) drives
 * this over HTTP. This asserts the same contract in-repo so a regression is
 * caught here rather than in someone else's suite, and so the seam is not the
 * only thing witnessing itself.
 *
 * The legs mirror the published ones exactly:
 *   #1  instantiation goes through the NORMAL create path
 *   #1/F2  the instantiated form carries NO pack-bound destination
 *   #2  an unrecognized `vendor.*` type DEGRADES to plain text, does not refuse
 *   #3  pack-authored fields are fully editable
 *
 * DOCT-1 — the seam is env-gated (`OPENWOP_TEST_SEAM_ENABLED`) and requires a
 * NON-ANONYMOUS principal: it persists real rows through the real `createForm`,
 * which has no per-org cap, so the previous always-on unauthenticated mount was
 * an unbounded anonymous durable write. The published conformance leg logs in
 * through the test-auth seam exactly like the MCP invoke seam's leg does.
 * DOCT-12 — fixtures load into a seam-LOCAL registry; the product catalog
 * (`GET …/form-templates`) must never list `vendor.conformance.form.*`.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';

const PLAIN_TEXT_CONTROLS = new Set(['text', 'string', 'plaintext', 'plain-text', 'input', 'textbox']);
const BASIC = 'vendor.conformance.form.basic';
const EXTENDED = 'vendor.conformance.form.extended';

let BASE = '';
let server: http.Server;
let cookie = '';

function getSetCookies(headers: Headers): string[] {
  const anyHeaders = headers as Headers & { getSetCookie?: () => string[] };
  if (typeof anyHeaders.getSetCookie === 'function') return anyHeaders.getSetCookie();
  const single = headers.get('set-cookie');
  return single ? [single] : [];
}

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  // DOCT-1 — the seam mounts only under the test-seam switch, and its guard
  // requires a real (non-anonymous) principal, so the test logs in.
  process.env.OPENWOP_TEST_SEAM_ENABLED = 'true';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  // Point the seam at the in-repo conformance fixtures (never under packs/).
  process.env.OPENWOP_FORM_CONTENT_CONFORMANCE_FIXTURES = join(process.cwd(), '../../conformance-fixtures/form-content');
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 't', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((r) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; r(); }); });
  const login = await fetch(`${BASE}/v1/host/openwop-app/test/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: `formcontent-seam-${Date.now()}@acme.test` }),
  });
  expect(login.status, await login.clone().text()).toBe(201);
  for (const ck of getSetCookies(login.headers)) {
    const m = /(__session=[^;]+)/.exec(ck);
    if (m?.[1]) cookie = m[1];
  }
  expect(cookie, 'login did not set a session cookie — every leg below would 401').toBeTruthy();
});
afterAll(async () => {
  delete process.env.OPENWOP_TEST_SEAM_ENABLED;
  delete process.env.OPENWOP_TEST_AUTH_ENABLED;
  await new Promise<void>((r) => server.close(() => r()));
});

const instantiate = async (templateId: string, opts: { withCredential?: boolean } = {}) => {
  const withCredential = opts.withCredential !== false;
  const res = await fetch(`${BASE}/v1/host/sample/formcontent/instantiate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(withCredential && cookie ? { cookie } : {}) },
    body: JSON.stringify({ templateId }),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
};
const fields = (j: Record<string, unknown>) =>
  (Array.isArray(j.fields) ? j.fields : []) as { id?: string; control?: string; declaredType?: string; editable?: boolean; locked?: boolean }[];

describe('RFC 0137 conformance seam — the behavioral witness', () => {
  it('advertises forms.contentPacks on the CANONICAL arm (plain key, document root)', async () => {
    const res = await fetch(`${BASE}/.well-known/openwop`);
    const doc = (await res.json()) as Record<string, unknown> & { capabilities?: Record<string, unknown> };
    const packs = (v: unknown) => (v as { contentPacks?: boolean } | undefined)?.contentPacks;

    // RFC 0073 root + RFC 0137 G16 plain spelling — the FIRST arm the conformance
    // helper tries (plain-root → dotted-root → plain-wrapper → dotted-wrapper).
    // This assertion is the point of the test: the previous version read
    // `doc.capabilities['host.forms']`, the LAST arm, so it stayed green while
    // the host was only ever found on the migration fallback — and would have
    // stayed green if root emission broke outright.
    expect(packs(doc['forms']), 'plain key at the document root (canonical)').toBe(true);

    // The deprecated mirrors, asserted so their removal is a deliberate act.
    expect(packs(doc['host.forms']), 'dotted root mirror (deprecated)').toBe(true);
    expect(packs(doc.capabilities?.['forms']), 'plain wrapper mirror (deprecated)').toBe(true);
  });

  it('#1 instantiation goes through the NORMAL create path', async () => {
    const { status, json } = await instantiate(BASIC);
    expect(status).toBe(200);
    expect(json.refused, 'a registered template must instantiate').not.toBe(true);
    expect(json.viaCreatePath, 'must report the normal create path').toBe(true);
    expect(json.formId, 'must return the created form id').toBeTruthy();
    expect(fields(json).map((f) => f.id)).toEqual(['name', 'email', 'notes']);
  });

  it('#1/F2 the instantiated form carries NO pack-bound destination', async () => {
    const { json } = await instantiate(BASIC);
    const routing = json.routing;
    expect(routing == null || (typeof routing === 'object' && Object.keys(routing).length === 0)).toBe(true);
  });

  it('#2 an unrecognized vendor.* type DEGRADES to plain text and does NOT refuse', async () => {
    // The leg that matters most: refuse-everything is the natural instinct and it
    // is non-conformant. This is exactly my pre-#884 loader behaviour.
    const { json } = await instantiate(EXTENDED);
    expect(json.refused, 'a vendor extension must NOT fail the instantiation').not.toBe(true);
    const f = fields(json).find((x) => x.id === 'vendorExtended');
    expect(f, 'the vendor-typed field must survive').toBeTruthy();
    expect(f!.declaredType, 'the wire-declared type must be reported verbatim').toBe('vendor.acme.rating');
    expect(PLAIN_TEXT_CONTROLS.has(String(f!.control)), `degraded control was '${f!.control}'`).toBe(true);
  });

  it('#3 pack-authored fields are FULLY EDITABLE', async () => {
    const { json } = await instantiate(EXTENDED);
    for (const f of fields(json)) {
      expect(f.locked, `${f.id} must not be locked`).not.toBe(true);
      expect(f.editable, `${f.id} must be editable`).not.toBe(false);
    }
  });

  it('an UNREGISTERED template is refused — the seam is not a rubber stamp', async () => {
    // Anti-vacuity: without this, a seam that returned a canned success for any
    // input would pass every leg above.
    const { json } = await instantiate('vendor.conformance.form.does-not-exist');
    expect(json.refused).toBe(true);
  });

  it('DOCT-1: an unauthenticated caller is REFUSED — this was a 200 with a persisted row', async () => {
    // The flipped former no-credential-200 assertion. The seam calls the real
    // `createForm` (no per-org cap), so an anonymous 200 here is an unbounded
    // anonymous durable write.
    const { status, json } = await instantiate(BASIC, { withCredential: false });
    expect(status).toBe(401);
    expect(json.error).toBe('unauthenticated');
    expect(json.formId, 'a refused call must not report a created form').toBeUndefined();
  });

  it('DOCT-12: conformance fixtures never reach the product template catalog', async () => {
    // Force the seam to load its fixtures first (an authenticated instantiate),
    // then read the catalog a real org member sees.
    await instantiate(BASIC);
    for (const id of ['users', 'forms']) {
      const d = getToggleDefault(id);
      if (d) await saveConfig({ ...d, status: 'on' }, 'test');
    }
    const orgRes = await fetch(`${BASE}/v1/host/openwop-app/orgs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ name: 'Seam pollution probe' }),
    });
    const orgBody = (await orgRes.json()) as { org?: { orgId?: string }; orgId?: string };
    const orgId = orgBody.org?.orgId ?? orgBody.orgId;
    expect(orgId, JSON.stringify(orgBody)).toBeTruthy();
    const list = await fetch(`${BASE}/v1/host/openwop-app/forms/orgs/${encodeURIComponent(String(orgId))}/form-templates`, {
      headers: { cookie },
    });
    expect(list.status).toBe(200);
    const body = (await list.json()) as { templates?: { templateId: string }[] };
    const conformance = (body.templates ?? []).filter((t) => t.templateId.startsWith('vendor.conformance.form.'));
    expect(conformance, 'seam fixtures leaked into the product catalog').toEqual([]);
  });
});

describe('DOCT-1 — the seam is env-gated', () => {
  it('does not mount without OPENWOP_TEST_SEAM_ENABLED', async () => {
    const prev = process.env.OPENWOP_TEST_SEAM_ENABLED;
    delete process.env.OPENWOP_TEST_SEAM_ENABLED;
    try {
      const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 't2', serviceVersion: '0.0.1', enableConsoleTracer: false });
      const srv: http.Server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
      const port = (srv.address() as AddressInfo).port;
      const res = await fetch(`http://127.0.0.1:${port}/v1/host/sample/formcontent/instantiate`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ templateId: BASIC }),
      });
      expect(res.status, 'an ungated process must not expose the seam').toBe(404);
      await new Promise<void>((r) => srv.close(() => r()));
    } finally {
      process.env.OPENWOP_TEST_SEAM_ENABLED = prev;
    }
  });
});
