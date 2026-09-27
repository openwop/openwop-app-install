/**
 * ADR 0516 — instantiating a form template goes through `createForm`.
 *
 * This is the whole security story, and it is only observable over HTTP: the rule
 * is not "the loader validated the pack" but "pack-sourced fields are sanitized by
 * the SAME code path typed input takes". A service-level test cannot prove it,
 * because writing a `FormDef` row directly would also pass one.
 *
 * The probe: register a template whose fields the loader accepts (well-formed shape)
 * but which `sanitizeFields` must still normalize or drop. If the persisted form
 * comes back with the raw pack values, the route bypassed the sanitizer.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import type { FormDef } from '../src/features/forms/formsService.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { loadFormContentPacks, _resetFormContentRegistryForTest } from '../src/host/formContentPackLoader.js';

let BASE: string;
let server: http.Server;
let packDir = '';

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;

  packDir = mkdtempSync(join(tmpdir(), 'form-tpl-route-'));
  mkdirSync(join(packDir, 'test.forms'), { recursive: true });
  writeFileSync(join(packDir, 'test.forms', 'pack.json'), JSON.stringify({
    name: 'test.forms', version: '1.0.0', kind: 'form-content',
    templates: [{
      // A version DELIBERATELY different from the pack's 1.0.0 — if both were
      // the same, stamping packVersion into templateVersion would pass unnoticed.
      templateId: 'vendor.test.form.probe', version: '2.3.4', label: 'Probe', title: 'Probe form',
      fields: [
        { id: 'name', label: 'Name', type: 'text', required: true },
        // `options` on a NON-select field. The loader validates the options
        // SHAPE (array of bounded strings) and accepts this; only
        // `sanitizeFields` knows that options belong to 'select' alone and
        // drops them otherwise. An out-of-catalog TYPE no longer works as this
        // probe — the loader refuses those outright now — so the probe moved to
        // the nearest thing the loader still lets through.
        { id: 'sneaky', label: 'Sneaky', type: 'text', options: ['ghost'] },
      ],
    }],
  }), 'utf8');

  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['users', 'forms']) {
    const d = getToggleDefault(id);
    if (d) await saveConfig({ ...d, status: 'on' }, 'test');
  }
  _resetFormContentRegistryForTest();
  loadFormContentPacks({ roots: [packDir] });
});
afterAll(async () => {
  await new Promise<void>((res) => server.close(() => res()));
  _resetFormContentRegistryForTest();
  if (packDir) rmSync(packDir, { recursive: true, force: true });
});

interface Res<T = any> { status: number; body: T }
function client() {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const h = res.headers as Headers & { getSetCookie?: () => string[] };
    const single = res.headers.get('set-cookie');
    for (const sc of (typeof h.getSetCookie === 'function' ? h.getSetCookie() : single ? [single] : [])) {
      const m = /(__session=[^;]+)/.exec(sc); if (m) cookie = m[1];
    }
    return { status: res.status, body: res.status === 204 ? undefined : await res.json().catch(() => undefined) };
  };
  return { get: (p: string) => call('GET', p), post: (p: string, b?: unknown) => call('POST', p, b) };
}

let n = 0;
async function signedInOrg(): Promise<{ c: ReturnType<typeof client>; orgId: string }> {
  const c = client();
  const login = await c.post('/v1/host/openwop-app/test/login', { email: `ft-${Date.now()}-${n++}@t.test` });
  expect(login.status, JSON.stringify(login.body)).toBe(201);
  const org = await c.post('/v1/host/openwop-app/orgs', { name: `Org ${n++}` });
  expect(org.status, JSON.stringify(org.body)).toBe(201);
  return { c, orgId: org.body.org?.orgId ?? org.body.orgId };
}
const base = (orgId: string) => `/v1/host/openwop-app/forms/orgs/${encodeURIComponent(orgId)}`;

describe('ADR 0516 — form templates over HTTP', () => {
  it('lists installed templates', async () => {
    const { c, orgId } = await signedInOrg();
    const res = await c.get(`${base(orgId)}/form-templates`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.templates.map((t: { templateId: string }) => t.templateId)).toContain('vendor.test.form.probe');
  });

  it('instantiates THROUGH createForm — pack fields are sanitized, not trusted', async () => {
    const { c, orgId } = await signedInOrg();
    const res = await c.post(`${base(orgId)}/forms/from-template`, { templateId: 'vendor.test.form.probe' });
    expect(res.status, JSON.stringify(res.body)).toBe(201);

    const form = res.body.form ?? res.body;
    expect(form.title).toBe('Probe form');
    // THE ASSERTION THAT MATTERS. `sanitizeFields` owns the closed field catalog, so
    // the unknown type must not survive verbatim. If it does, the route wrote the
    // row directly and pack data is defining a public submission surface unchecked.
    const sneaky = (form.fields as { key: string; type: string; options?: string[] }[]).find((f) => f.key === 'sneaky');
    expect(
      sneaky?.options,
      'options on a non-select field must be dropped by sanitizeFields, not persisted verbatim',
    ).toBeUndefined();
    // And the legitimate field survives — the sanitizer must not eat everything,
    // which would make the assertion above pass for the wrong reason.
    expect((form.fields as { key: string }[]).some((f) => f.key === 'name')).toBe(true);
  });

  it('a form created from a template is tenant/org-stamped by the CALLER, not the pack', async () => {
    const { c, orgId } = await signedInOrg();
    const res = await c.post(`${base(orgId)}/forms/from-template`, { templateId: 'vendor.test.form.probe' });
    const form = res.body.form ?? res.body;
    expect(form.orgId).toBe(orgId);
    // Readable back through the ordinary list route — same tenant, same org.
    const list = await c.get(`${base(orgId)}/forms`);
    expect(list.body.forms.some((f: { formId: string }) => f.formId === form.formId)).toBe(true);
  });

  it('stamps the ORIGIN PACK on the created form — grade-data FT-DATA-1', async () => {
    const { c, orgId } = await signedInOrg();
    const res = await c.post(`${base(orgId)}/forms/from-template`, { templateId: 'vendor.test.form.probe' });
    const form = res.body.form ?? res.body;
    // Instantiation COPIES the fields, so without this stamp there is nothing left
    // to tell a pack-authored form from a hand-typed one — and no later pass could
    // recover it. The version matters as much as the name: "which forms came from
    // the BAD release of this pack" is the question an operator actually asks.
    expect(form.originTemplate).toEqual({
      templateId: 'vendor.test.form.probe', packName: 'test.forms', packVersion: '1.0.0',
      // grade-code GC-4 — the template's OWN version. The loader had always
      // REQUIRED authors to supply this and consumed it nowhere; recording it
      // makes provenance answer the sharper question, which revision of THIS
      // template produced the form, not just which pack release.
      templateVersion: '2.3.4',
    });
  });

  it('models the OLDER three-key provenance shape — grade-data DATA-1', async () => {
    // `templateVersion` was added (#2941) after the stamp itself (#2924). This is
    // a JSON blob store with NO migration, so rows written in between keep their
    // three-key shape forever. A required `templateVersion` would be the type
    // lying about data that already exists — the first reader would deref a
    // string the compiler promised and get undefined.
    const legacy: FormDef['originTemplate'] = {
      templateId: 'vendor.test.form.probe', packName: 'test.forms', packVersion: '1.0.0',
    };
    expect(legacy?.templateVersion).toBeUndefined();
    // And the CURRENT writer supplies it, so absence means "stamped before we
    // recorded the revision" rather than "we forgot".
    const { c, orgId } = await signedInOrg();
    const res = await c.post(`${base(orgId)}/forms/from-template`, { templateId: 'vendor.test.form.probe' });
    expect((res.body.form ?? res.body).originTemplate.templateVersion).toBe('2.3.4');
  });

  it('leaves originTemplate ABSENT on a hand-authored form', async () => {
    const { c, orgId } = await signedInOrg();
    const res = await c.post(`${base(orgId)}/forms`, { title: 'Typed by hand', fields: [] });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const form = res.body.form ?? res.body;
    // Absence is the signal. If the field were always present (say, an empty
    // object) the stamp would distinguish nothing.
    expect(form.originTemplate).toBeUndefined();
  });

  it('will not let a caller FORGE a template origin through the request body', async () => {
    const { c, orgId } = await signedInOrg();
    const forged = { templateId: 'forms.contact-us', packName: 'core.openwop.forms.starters', packVersion: '9.9.9' };
    const res = await c.post(`${base(orgId)}/forms`, { title: 'Claims a pedigree', fields: [], originTemplate: forged });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const form = res.body.form ?? res.body;
    // Provenance is only worth querying if it cannot be self-declared: a tenant
    // that could stamp its own form as pack-authored would poison the very audit
    // the stamp exists to serve.
    expect(form.originTemplate).toBeUndefined();
  });

  it('an unknown templateId is a 404 naming the id, not a 500', async () => {
    const { c, orgId } = await signedInOrg();
    const res = await c.post(`${base(orgId)}/forms/from-template`, { templateId: 'nope.missing' });
    expect(res.status, JSON.stringify(res.body)).toBe(404);
    expect(JSON.stringify(res.body)).toContain('nope.missing');
  });

  it('the caller may override the template title', async () => {
    const { c, orgId } = await signedInOrg();
    const res = await c.post(`${base(orgId)}/forms/from-template`, { templateId: 'vendor.test.form.probe', title: 'My own title' });
    expect((res.body.form ?? res.body).title).toBe('My own title');
  });

  it('both template routes are org-gated — an unauthenticated caller is refused', async () => {
    const anon = client();
    const listRes = await anon.get(`${base('org-whatever')}/form-templates`);
    expect(listRes.status).toBeGreaterThanOrEqual(400);
    const createRes = await anon.post(`${base('org-whatever')}/forms/from-template`, { templateId: 'vendor.test.form.probe' });
    expect(createRes.status).toBeGreaterThanOrEqual(400);
  });
});
