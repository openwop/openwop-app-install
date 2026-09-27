/**
 * CDP W3d — per-tenant purpose-vocabulary registry (ADR 0302; RFC 0128 R3).
 *
 * The registry is ADVISORY + HOST-LOCAL. These tests pin the invariants that keep
 * it from becoming a wire enum:
 *   - the host-default seed vocabulary is present per-tenant;
 *   - add / remove mutate ONLY the tenant's advisory catalog (tenant-isolated);
 *   - `validatePurposes` is a pure known/unknown splitter that never throws;
 *   - strict mode ON ⇒ consent CAPTURE fails closed (400) on an unknown purpose,
 *     at both the service and the public HTTP route;
 *   - strict OFF (default) ⇒ capture is fail-open (accepted, warned);
 *   - the RFC 0128 opaque-string egress (`purposeLabels`) is UNCHANGED — a stored
 *     opaque label normalizes + re-emits verbatim regardless of the vocab/strict.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import {
  PURPOSE_VOCAB_SEED,
  listPurposeVocab,
  addPurposeCode,
  removePurposeCode,
  isStrictPurposes,
  setStrictPurposes,
  validatePurposes,
  __resetPurposeVocabStore,
} from '../src/features/cdp/purposeVocabService.js';
import { recordConsent, __resetConsentStore } from '../src/features/consent/consentService.js';
import { normalizeLabel, reEmitLabel } from '../src/features/cdp/purposeLabels.js';
import { OpenwopError } from '../src/types.js';

let BASE: string;
let server: http.Server;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['users', 'consent']) { const d = getToggleDefault(id); if (d) await saveConfig({ ...d, status: 'on' }, 'test'); }
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });
beforeEach(async () => { await __resetPurposeVocabStore(); await __resetConsentStore(); });

describe('purposeVocabService — catalog + CRUD', () => {
  it('exposes the host-default seed vocabulary per tenant', async () => {
    const v = await listPurposeVocab('t-seed');
    for (const s of PURPOSE_VOCAB_SEED) expect(v).toContain(s);
    expect(v).toEqual([...v].sort()); // sorted
    expect(await isStrictPurposes('t-seed')).toBe(false); // strict off by default
  });

  it('adds + removes a tenant purpose (custom + seed disable)', async () => {
    const t = 't-crud';
    const added = await addPurposeCode(t, 'loyalty');
    expect(added).toContain('loyalty');
    expect(await addPurposeCode(t, 'loyalty')).toEqual(added); // idempotent
    // remove a custom addition
    expect(await removePurposeCode(t, 'loyalty')).not.toContain('loyalty');
    // disable a SEED code, then re-enable it
    const noMarketing = await removePurposeCode(t, 'marketing');
    expect(noMarketing).not.toContain('marketing');
    expect(await addPurposeCode(t, 'marketing')).toContain('marketing');
  });

  it('rejects an empty purpose code', async () => {
    await expect(addPurposeCode('t-empty', '   ')).rejects.toBeInstanceOf(OpenwopError);
  });

  it('isolates the vocabulary per tenant', async () => {
    await addPurposeCode('t-a', 'alpha-only');
    await removePurposeCode('t-a', 'support');
    const b = await listPurposeVocab('t-b');
    expect(b).not.toContain('alpha-only'); // A's addition does not leak
    expect(b).toContain('support');        // A's seed-disable does not leak
  });
});

describe('validatePurposes — advisory splitter (never throws)', () => {
  it('splits known / unknown against the tenant vocabulary', async () => {
    const t = 't-split';
    await addPurposeCode(t, 'loyalty');
    const { known, unknown } = await validatePurposes(t, ['analytics', 'loyalty', 'wormhole', 'analytics']);
    expect(known).toEqual(['analytics', 'loyalty']);
    expect(unknown).toEqual(['wormhole']); // deduped, non-vocab
  });

  it('ignores empty / non-string entries and never throws (fail-open)', async () => {
    const { known, unknown } = await validatePurposes('t-fo', ['', '  ', 42, 'analytics']);
    expect(known).toEqual(['analytics']);
    expect(unknown).toEqual([]);
  });
});

describe('strict-mode capture (fail-closed only in strict)', () => {
  it('strict OFF (default) ⇒ recordConsent accepts an unknown purpose', async () => {
    const rec = await recordConsent({ tenantId: 't-off', subjectKey: 's1', categories: { analytics: true }, source: 'test', purposes: ['analytics', 'not-in-vocab'] });
    expect(rec.purposes).toEqual(['analytics', 'not-in-vocab']); // stored verbatim
  });

  it('strict ON ⇒ recordConsent rejects an unknown purpose (400)', async () => {
    await setStrictPurposes('t-strict', true);
    // a KNOWN purpose still passes
    await expect(recordConsent({ tenantId: 't-strict', subjectKey: 's-ok', categories: {}, source: 'test', purposes: ['analytics'] })).resolves.toBeTruthy();
    // an unknown one is rejected 400
    await expect(recordConsent({ tenantId: 't-strict', subjectKey: 's-bad', categories: {}, source: 'test', purposes: ['analytics', 'sneaky'] }))
      .rejects.toMatchObject({ httpStatus: 400, code: 'validation_error' });
  });
});

describe('RFC 0128 opaque-string wire is UNCHANGED', () => {
  it('a stored opaque label with codes outside ANY vocab still normalizes + re-emits verbatim', async () => {
    // These codes are deliberately NOT in the seed nor any tenant vocab. The
    // purposeLabels algebra must be totally unaffected by the registry.
    const stored = ['bespoke:x', 'legacy-code', 'analytics'];
    expect(normalizeLabel(stored)).toEqual(['analytics', 'bespoke:x', 'legacy-code']); // dedupe+sort only
    expect(reEmitLabel(stored)).toEqual(['analytics', 'bespoke:x', 'legacy-code']);     // carried verbatim
    // undefined (unlabelled) and [] (no-onward-use) semantics untouched
    expect(normalizeLabel(undefined)).toBeUndefined();
    expect(normalizeLabel([])).toEqual([]);
  });
});

// ─────────────────────── HTTP surface (routes, RBAC, warnings) ───────────────
interface Res<T = any> { status: number; body: T }
function client(initialCookie = '') {
  let cookie = initialCookie;
  const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const h = res.headers as { getSetCookie?: () => string[] };
    const sc = typeof h.getSetCookie === 'function' ? h.getSetCookie() : [];
    for (const c of sc) { const m = /(__session=[^;]+)/.exec(c); if (m) cookie = m[1]; }
    const out = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    return { status: res.status, body: out };
  };
  return { get: (p: string) => call('GET', p), post: (p: string, b?: unknown) => call('POST', p, b), put: (p: string, b?: unknown) => call('PUT', p, b), del: (p: string) => call('DELETE', p) };
}
let n = 0;
async function ownerWithOrg(): Promise<{ owner: ReturnType<typeof client>; orgId: string }> {
  const owner = client();
  const su = await owner.post('/v1/host/openwop-app/test/login', { email: `pv-${Date.now()}-${n++}@acme.test` });
  expect(su.status, JSON.stringify(su.body)).toBe(201);
  const org = await owner.post('/v1/host/openwop-app/orgs', { name: 'Acme' });
  expect(org.status, JSON.stringify(org.body)).toBe(201);
  return { owner, orgId: org.body.orgId };
}

describe('purpose-vocab HTTP routes', () => {
  it('GET seeds; POST adds; DELETE removes; PUT flips strict (RBAC)', async () => {
    const { owner, orgId } = await ownerWithOrg();
    const B = `/v1/host/openwop-app/consent/orgs/${orgId}/purpose-vocab`;
    const seeded = await owner.get(B);
    expect(seeded.status, JSON.stringify(seeded.body)).toBe(200);
    expect(seeded.body.purposes).toEqual(expect.arrayContaining([...PURPOSE_VOCAB_SEED]));
    expect(seeded.body.strict).toBe(false);

    expect((await owner.post(B, { code: 'loyalty' })).body.purposes).toContain('loyalty');
    expect((await owner.del(`${B}/loyalty`)).body.purposes).not.toContain('loyalty');
    expect((await owner.put(`${B}/strict`, { strict: true })).body.strict).toBe(true);
    expect((await owner.put(`${B}/strict`, { strict: 'yes' })).status).toBe(400); // non-boolean rejected
  });

  it('public consent capture: non-strict warns; strict rejects (400)', async () => {
    const { owner, orgId } = await ownerWithOrg();
    const PUB = `/v1/host/openwop-app/public-consent/${orgId}`;
    // non-strict (default): unknown purpose accepted, surfaced as a warning
    // CONS-2 — the public lane mints its own `visitor:` subject; a caller-chosen
    // `subjectKey` is refused (it was an anonymous forgery vector).
    const warn = await client().post(PUB, { categories: { analytics: true }, purposes: ['analytics', 'mystery'] });
    expect(warn.status, JSON.stringify(warn.body)).toBe(201);
    expect(warn.body.unknownPurposes).toEqual(['mystery']);
    // flip strict on, then the same capture is rejected 400
    await owner.put(`/v1/host/openwop-app/consent/orgs/${orgId}/purpose-vocab/strict`, { strict: true });
    const rej = await client().post(PUB, { categories: {}, purposes: ['mystery'] });
    expect(rej.status).toBe(400);
    expect(rej.body.error).toBe('validation_error');
  });
});
