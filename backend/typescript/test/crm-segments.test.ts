/**
 * ADR 0213 §2 (tenant-scoped `contact` field defs + `Contact.customFields`)
 * and ADR 0211 §2 (saved segments) — ROUTE-level harness, mirroring
 * `crm-org-route.test.ts`'s cookie-session boilerplate (an org is still needed
 * here to mint `company`/`deal` ids for `reference`-type custom fields).
 *
 * Segment CAP tests call `segmentsService` directly (200 HTTP round-trips
 * would be slow/flaky for no extra coverage — the cap check itself is a
 * single in-process count comparison).
 *
 * SABOTAGE (wave-4 grade-tests probes): drop the 20-filter or 200-segment cap,
 * make `contains` case-sensitive, make `exists` always true, accept an unknown
 * field/op, drop `getSegment`'s tenant check, or accept a tombstoned contact as a
 * `reference` value → the matching case is red.
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { createSegment, listSegments, __resetCrmSegments, type Segment } from '../src/features/crm/segmentsService.js';
import type { Contact } from '../src/features/crm/contactsService.js';
import type { FieldDef } from '../src/features/crm/entities/fieldDefs.js';

let BASE: string;
let server: http.Server;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => {
    server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); });
  });
  const u = getToggleDefault('users');
  if (u) await saveConfig({ ...u, status: 'on' }, 'test');
});
afterAll(async () => {
  await new Promise<void>((res) => server.close(() => res()));
});

interface Res<T = unknown> { status: number; body: T }
/** The typed error envelope a refused host route answers with. */
interface ErrBody { error?: string }
// The JSON boundary is untyped; each call site names the body shape it reads.
interface Client {
  get: <T = ErrBody>(p: string) => Promise<Res<T>>;
  post: <T = ErrBody>(p: string, b?: unknown) => Promise<Res<T>>;
  patch: <T = ErrBody>(p: string, b?: unknown) => Promise<Res<T>>;
  del: (p: string) => Promise<Res<ErrBody>>;
}
function client(initialCookie = ''): Client {
  let cookie = initialCookie;
  const call = async <T,>(method: string, path: string, body?: unknown): Promise<Res<T>> => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const sc = getSetCookies(res.headers);
    for (const c of sc as string[]) {
      const m = /(__session=[^;]+)/.exec(c);
      if (m) cookie = m[1];
    }
    const out = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    return { status: res.status, body: out as T };
  };
  return {
    get: <T,>(p: string) => call<T>('GET', p),
    post: <T,>(p: string, b?: unknown) => call<T>('POST', p, b),
    patch: <T,>(p: string, b?: unknown) => call<T>('PATCH', p, b),
    del: (p) => call<ErrBody>('DELETE', p),
  };
}

let n = 0;
const uniqEmail = (who: string): string => `${who}-${Date.now()}-${n++}@acme.test`;
async function signup(c: Client, opts: { tenantId?: string } = {}): Promise<{ userId: string }> {
  const r = await c.post<{ user: { userId: string } }>('/host/openwop-app/test/login', { email: uniqEmail('crm'), ...(opts.tenantId ? { tenantId: opts.tenantId } : {}) });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.user;
}
const enableCrm = async (status: 'on' | 'off'): Promise<void> => {
  const def = getToggleDefault('crm');
  if (def) await saveConfig({ ...def, status }, 'test');
};

/** One signed-in user + one org they own (companies/deals need an org). */
async function userWithOrg(): Promise<{ user: Client; orgId: string }> {
  const tenantId = `org:test-${Date.now()}-${n++}`;
  const user = client();
  await signup(user, { tenantId });
  const org = await user.post<{ orgId: string }>('/host/openwop-app/orgs', { name: 'Acme' });
  expect(org.status, JSON.stringify(org.body)).toBe(201);
  return { user, orgId: org.body.orgId };
}
const orgPath = (orgId: string, suffix = ''): string => `/host/openwop-app/crm/orgs/${encodeURIComponent(orgId)}${suffix}`;
/** A refusal must be the typed validation error, not a 400 for some other reason. */
const expectValidation = (r: Res<ErrBody>): void => {
  expect(r.status, JSON.stringify(r.body)).toBe(400);
  expect(r.body.error).toBe('validation_error');
};
/** A toggle-off read is the uniform 404 (no existence disclosure). */
async function expectGatedWhileOff(path: string): Promise<void> {
  await enableCrm('off');
  try {
    const { user } = await userWithOrg();
    const r = await user.get(path);
    expect(r.status).toBe(404);
    expect(r.body.error).toBe('not_found');
  } finally {
    await enableCrm('on');
  }
}
type FieldsBody = { fields: FieldDef[] };
type MembersBody = { members: Contact[] };
const ids = (b: MembersBody): string[] => b.members.map((m) => m.contactId);

describe('crm contact field defs (ADR 0213 §2) — tenant-scoped', () => {
  it('404s while CRM is off', async () => {
    await expectGatedWhileOff('/host/openwop-app/crm/fields');
  });

  it('creates date/enum/reference contact field defs; validates enum options + refEntityType', async () => {
    await enableCrm('on');
    const { user } = await userWithOrg();

    const dateDef = await user.post<FieldDef>('/host/openwop-app/crm/fields', { key: 'birthday', label: 'Birthday', type: 'date' });
    expect(dateDef.status, JSON.stringify(dateDef.body)).toBe(201);
    expect(dateDef.body.orgId).toBe(''); // tenant-scoped sentinel

    const enumDef = await user.post<FieldDef>('/host/openwop-app/crm/fields', { key: 'tier', label: 'Tier', type: 'enum', options: ['bronze', 'silver', 'gold'] });
    expect(enumDef.status, JSON.stringify(enumDef.body)).toBe(201);
    expect(enumDef.body.options).toEqual(['bronze', 'silver', 'gold']);

    // enum with no options → 400; too many options → 400.
    expectValidation(await user.post('/host/openwop-app/crm/fields', { key: 'bad', label: 'Bad', type: 'enum' }));
    const tooMany = Array.from({ length: 25 }, (_, i) => `o${i}`);
    expectValidation(await user.post('/host/openwop-app/crm/fields', { key: 'toomany', label: 'Too many', type: 'enum', options: tooMany }));

    const refDef = await user.post('/host/openwop-app/crm/fields', { key: 'referredBy', label: 'Referred by', type: 'reference', refEntityType: 'contact' });
    expect(refDef.status, JSON.stringify(refDef.body)).toBe(201);
    // reference with bad refEntityType → 400.
    expectValidation(await user.post('/host/openwop-app/crm/fields', { key: 'badref', label: 'Bad ref', type: 'reference', refEntityType: 'nope' }));
    // reference with no refEntityType → 400.
    expectValidation(await user.post('/host/openwop-app/crm/fields', { key: 'noref', label: 'No ref', type: 'reference' }));

    const list = await user.get<FieldsBody>('/host/openwop-app/crm/fields');
    expect(list.status).toBe(200);
    expect(list.body.fields.map((f) => f.key).sort()).toEqual(['birthday', 'referredby', 'tier']);

    const del = await user.del(`/host/openwop-app/crm/fields/${encodeURIComponent(dateDef.body.defId)}`);
    expect(del.status).toBe(204);
    expect((await user.get<FieldsBody>('/host/openwop-app/crm/fields')).body.fields).toHaveLength(2);
  });

  it('org-scoped /fields still rejects entityType `contact` (tenant defs are not reachable via an org path)', async () => {
    await enableCrm('on');
    const { user, orgId } = await userWithOrg();
    expectValidation(await user.post(orgPath(orgId, '/fields'), { entityType: 'contact', key: 'x', label: 'X', type: 'string' }));
  });
});

describe('crm contact customFields round-trip (ADR 0213 §1/§2)', () => {
  it('validates date/enum/reference types; accepts valid values; rejects dangling/tombstoned/cross-tenant refs', async () => {
    await enableCrm('on');
    const { user, orgId } = await userWithOrg();

    await user.post('/host/openwop-app/crm/fields', { key: 'birthday', label: 'Birthday', type: 'date' });
    await user.post('/host/openwop-app/crm/fields', { key: 'tier', label: 'Tier', type: 'enum', options: ['bronze', 'gold'] });
    await user.post('/host/openwop-app/crm/fields', { key: 'company_ref', label: 'Company ref', type: 'reference', refEntityType: 'company' });
    await user.post('/host/openwop-app/crm/fields', { key: 'referred_by', label: 'Referred by', type: 'reference', refEntityType: 'contact' });

    const company = await user.post<{ companyId: string }>(orgPath(orgId, '/companies'), { name: 'RefCo' });
    expect(company.status).toBe(201);
    const referrer = await user.post<Contact>('/host/openwop-app/crm/contacts', { name: 'Referrer' });
    expect(referrer.status).toBe(201);

    // Bad date → 400.
    expectValidation(await user.post('/host/openwop-app/crm/contacts', { name: 'X', customFields: { birthday: 'soon' } }));
    // Bad enum value → 400.
    expectValidation(await user.post('/host/openwop-app/crm/contacts', { name: 'X', customFields: { tier: 'platinum' } }));
    // Dangling reference → 400.
    expectValidation(await user.post('/host/openwop-app/crm/contacts', { name: 'X', customFields: { company_ref: 'cmp:nope' } }));

    // Valid — all four typed fields round-trip.
    const ok = await user.post<Contact>('/host/openwop-app/crm/contacts', {
      name: 'Valid Contact',
      customFields: { birthday: '2000-01-01', tier: 'gold', company_ref: company.body.companyId, referred_by: referrer.body.contactId },
    });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect(ok.body.customFields).toEqual({ birthday: '2000-01-01', tier: 'gold', company_ref: company.body.companyId, referred_by: referrer.body.contactId });

    // PATCH replaces the customFields map wholesale (companies/deals precedent).
    const patched = await user.patch<Contact>(`/host/openwop-app/crm/contacts/${ok.body.contactId}`, { customFields: { tier: 'bronze' } });
    expect(patched.status, JSON.stringify(patched.body)).toBe(200);
    expect(patched.body.customFields).toEqual({ tier: 'bronze' });

    // A tombstoned company reference is rejected.
    const source = await user.post<{ companyId: string }>(orgPath(orgId, '/companies'), { name: 'ToMerge' });
    const merged = await user.post(orgPath(orgId, `/companies/${encodeURIComponent(company.body.companyId)}/merge`), { sourceCompanyId: source.body.companyId });
    expect(merged.status, JSON.stringify(merged.body)).toBe(200);
    expectValidation(await user.post('/host/openwop-app/crm/contacts', { name: 'X', customFields: { company_ref: source.body.companyId } }));

    // A tombstoned contact reference is rejected.
    const mergeTarget = await user.post<Contact>('/host/openwop-app/crm/contacts', { name: 'Survivor' });
    const mergeSource = await user.post<Contact>('/host/openwop-app/crm/contacts', { name: 'Source' });
    const mergedContact = await user.post(`/host/openwop-app/crm/contacts/${mergeTarget.body.contactId}/merge`, { sourceContactId: mergeSource.body.contactId });
    expect(mergedContact.status, JSON.stringify(mergedContact.body)).toBe(200);
    expectValidation(await user.post('/host/openwop-app/crm/contacts', { name: 'X', customFields: { referred_by: mergeSource.body.contactId } }));

    // A cross-tenant reference is rejected (a company minted by a DIFFERENT tenant).
    const { user: otherUser } = await userWithOrg();
    await otherUser.post('/host/openwop-app/crm/fields', { key: 'company_ref', label: 'Company ref', type: 'reference', refEntityType: 'company' });
    const foreignCompany = await user.post<{ companyId: string }>(orgPath(orgId, '/companies'), { name: 'MineOnly' });
    expectValidation(await otherUser.post('/host/openwop-app/crm/contacts', { name: 'X', customFields: { company_ref: foreignCompany.body.companyId } }));
  });

  it('import binds a contact\'s validated customFields (org route, ADR 0213 §2)', async () => {
    await enableCrm('on');
    const { user, orgId } = await userWithOrg();
    await user.post('/host/openwop-app/crm/fields', { key: 'tier', label: 'Tier', type: 'enum', options: ['bronze', 'gold'] });
    const imp = await user.post<{ created: number; errors: unknown[] }>(orgPath(orgId, '/import'), {
      entityType: 'contact',
      rows: [{ name: 'Imported Good', customFields: { tier: 'gold' } }, { name: 'Imported Bad', customFields: { tier: 'platinum' } }],
    });
    expect(imp.status, JSON.stringify(imp.body)).toBe(200);
    expect(imp.body.created).toBe(1);
    expect(imp.body.errors).toHaveLength(1);
    const list = await user.get<{ contacts: Contact[] }>('/host/openwop-app/crm/contacts');
    const row = list.body.contacts.find((c) => c.name === 'Imported Good');
    expect(row?.customFields).toEqual({ tier: 'gold' });
  });
});

describe('crm segments (ADR 0211 §2)', () => {
  it('404s while CRM is off', async () => {
    await expectGatedWhileOff('/host/openwop-app/crm/segments');
  });

  it('unknown filter field/op → 400', async () => {
    await enableCrm('on');
    const { user } = await userWithOrg();
    expectValidation(await user.post('/host/openwop-app/crm/segments', { name: 'Bad', filters: [{ field: 'bogus', op: 'eq', value: 'x' }] }));
    expectValidation(await user.post('/host/openwop-app/crm/segments', { name: 'Bad', filters: [{ field: 'stage', op: 'bogus', value: 'x' }] }));
  });

  it('CRUD + member resolution: stage eq, customFields exists, company contains (case-insensitive), tombstone excluded', async () => {
    await enableCrm('on');
    const { user } = await userWithOrg();
    await user.post('/host/openwop-app/crm/fields', { key: 'tier', label: 'Tier', type: 'string' });

    const qualified = await user.post<Contact>('/host/openwop-app/crm/contacts', { name: 'Qualified Lead', stage: 'qualified', company: 'Acme Rockets', customFields: { tier: 'gold' } });
    const lead = await user.post<Contact>('/host/openwop-app/crm/contacts', { name: 'Cold Lead', stage: 'lead', company: 'Other Co' });
    const toTombstone = await user.post<Contact>('/host/openwop-app/crm/contacts', { name: 'Will Merge', stage: 'qualified' });
    expect(qualified.status).toBe(201);
    expect(lead.status).toBe(201);
    expect(toTombstone.status).toBe(201);
    // Tombstone one qualified contact — it must never resolve as a member again.
    const mergeRes = await user.post(`/host/openwop-app/crm/contacts/${qualified.body.contactId}/merge`, { sourceContactId: toTombstone.body.contactId });
    expect(mergeRes.status, JSON.stringify(mergeRes.body)).toBe(200);

    // stage eq 'qualified'.
    const stageSeg = await user.post<Segment>('/host/openwop-app/crm/segments', { name: 'Qualified', filters: [{ field: 'stage', op: 'eq', value: 'qualified' }] });
    expect(stageSeg.status, JSON.stringify(stageSeg.body)).toBe(201);
    const stageMembers = await user.get<MembersBody>(`/host/openwop-app/crm/segments/${stageSeg.body.segmentId}/members`);
    expect(stageMembers.status).toBe(200);
    expect(ids(stageMembers.body)).toEqual([qualified.body.contactId]);

    // customFields.tier exists.
    const cfSeg = await user.post<Segment>('/host/openwop-app/crm/segments', { name: 'HasTier', filters: [{ field: 'customFields.tier', op: 'exists' }] });
    const cfMembers = await user.get<MembersBody>(`/host/openwop-app/crm/segments/${cfSeg.body.segmentId}/members`);
    expect(ids(cfMembers.body)).toEqual([qualified.body.contactId]);

    // company contains 'rocket' (case-insensitive).
    const companySeg = await user.post<Segment>('/host/openwop-app/crm/segments', { name: 'Rockets', filters: [{ field: 'company', op: 'contains', value: 'ROCKET' }] });
    const companyMembers = await user.get<MembersBody>(`/host/openwop-app/crm/segments/${companySeg.body.segmentId}/members`);
    expect(ids(companyMembers.body)).toEqual([qualified.body.contactId]);

    // The tombstoned contact never appears in any resolution.
    for (const seg of [stageSeg, cfSeg, companySeg]) {
      const members = await user.get<MembersBody>(`/host/openwop-app/crm/segments/${seg.body.segmentId}/members`);
      expect(ids(members.body)).not.toContain(toTombstone.body.contactId);
    }

    // PATCH renames + replaces filters; DELETE removes; both 404 after delete.
    const patched = await user.patch<Segment>(`/host/openwop-app/crm/segments/${companySeg.body.segmentId}`, { name: 'Renamed' });
    expect(patched.status, JSON.stringify(patched.body)).toBe(200);
    expect(patched.body.name).toBe('Renamed');
    expect((await user.del(`/host/openwop-app/crm/segments/${companySeg.body.segmentId}`)).status).toBe(204);
    expect((await user.get(`/host/openwop-app/crm/segments/${companySeg.body.segmentId}`)).status).toBe(404);
    expect((await user.get(`/host/openwop-app/crm/segments/${companySeg.body.segmentId}/members`)).status).toBe(404);
  });

  it('a tenant cannot read or resolve another tenant\'s segment', async () => {
    await enableCrm('on');
    const { user } = await userWithOrg();
    const seg = await user.post<Segment>('/host/openwop-app/crm/segments', { name: 'Mine', filters: [] });
    expect(seg.status).toBe(201);
    const { user: stranger } = await userWithOrg();
    expect((await stranger.get(`/host/openwop-app/crm/segments/${seg.body.segmentId}`)).status).toBe(404);
    expect((await stranger.get(`/host/openwop-app/crm/segments/${seg.body.segmentId}/members`)).status).toBe(404);
  });
});

describe('crm segments — caps (direct service calls, ADR 0211 §2)', () => {
  it('refuses a segment with more than 20 filters', async () => {
    await __resetCrmSegments();
    const filters = Array.from({ length: 21 }, () => ({ field: 'stage', op: 'exists' as const }));
    await expect(createSegment({ tenantId: 't-caps', name: 'TooMany', filters, createdBy: 'test' }))
      .rejects.toMatchObject({ code: 'validation_error', httpStatus: 400, details: { max: 20 } });
  });

  it('refuses a 201st segment for the same tenant', async () => {
    await __resetCrmSegments();
    const tenantId = 't-caps-2';
    for (let i = 0; i < 200; i++) {
      await createSegment({ tenantId, name: `Seg ${i}`, filters: [], createdBy: 'test' });
    }
    expect((await listSegments(tenantId)).length).toBe(200);
    await expect(createSegment({ tenantId, name: 'Seg 201', filters: [], createdBy: 'test' }))
      .rejects.toMatchObject({ code: 'validation_error', httpStatus: 409, details: { max: 200 } });
  });
});
