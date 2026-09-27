/**
 * The provenance-not-rendered family, write side (feature 20 fix batch).
 *
 * WF-DOC-9 — seed-template instantiation stores its origin. The ADR 0516
 * §Provenance lesson ported from the forms lane: instantiation COPIES, so the
 * catalog→template link exists only at write time and is UNBACKFILLABLE — every
 * day without the stamp adds unattributable rows. Forgery posture matches
 * forms: the stamp is server-supplied (the HTTP create route never forwards a
 * catalogId), so a client cannot claim seed origin for a hand-authored template.
 *
 * DOCTPL-2 (server half) — the PUBLIC share projection exposes the producer
 * KIND (and only the kind: no internal agent/user/run ids on the public
 * surface), so the share page can say a model wrote it.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getSetCookies } from './headerCookies.js';
import { createApp } from '../src/index.js';
import { createOrg } from '../src/host/accessControlService.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import {
  instantiateSeedTemplate, createTemplate, getTemplate,
  createDocument, addVersion, updateDocument, publicDocumentView,
} from '../src/features/documents/documentsService.js';
import { listSeedTemplates } from '../src/features/documents/seedTemplates.js';

const TENANT = 'org:doc-prov-stamps';
let ORG = '';
let BASE = '';
let server: http.Server;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  // Review F4 — the forgery test must sit at the FORGERY POINT (the HTTP
  // route), so the app boots with the test-auth seam on and the server is a
  // real client target, not scaffolding.
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['users', 'documents']) {
    const d = getToggleDefault(id);
    if (d) await saveConfig({ ...d, status: 'on' }, 'test');
  }
  const org = await createOrg({ tenantId: TENANT, createdBy: 'u-1', name: 'Acme', ownerSubject: 'u-1' });
  ORG = org.orgId;
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

describe('WF-DOC-9 — seed instantiation stamps its catalog origin', () => {
  it('the copied template carries catalogId; a hand-authored one does not', async () => {
    const seed = listSeedTemplates()[0]!;
    const copied = await instantiateSeedTemplate(TENANT, ORG, seed.catalogId, 'u-1');
    expect(copied.catalogId).toBe(seed.catalogId);
    // Persisted, not just returned.
    const row = await getTemplate(TENANT, ORG, copied.templateId);
    expect(row?.catalogId).toBe(seed.catalogId);

    const hand = await createTemplate({
      tenantId: TENANT, orgId: ORG, name: 'Hand-authored', kind: 'doc', outputFormat: 'markdown',
      promptBody: 'Write about {{x}}.', createdBy: 'u-1',
    });
    expect(hand.catalogId, 'a hand-authored template must NOT claim seed origin').toBeUndefined();
  });
});

describe('review F4 — the HTTP create route is the forgery point, and it IGNORES a client catalogId', () => {
  it('POST /templates with a VALID catalogId in the body creates the template WITHOUT it', async () => {
    // A minimal cookie client over the test-auth seam — its own tenant, so the
    // service-level arms above stay undisturbed.
    let cookie = '';
    const call = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> => {
      const res = await fetch(`${BASE}${path}`, {
        method,
        headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]; }
      return { status: res.status, body: await res.json().catch(() => undefined) };
    };
    const login = await call('POST', '/v1/host/openwop-app/test/login', { email: `forge-${Date.now()}@acme.test`, tenantId: 'org:doc-prov-forge' });
    expect(login.status, JSON.stringify(login.body)).toBe(201);
    const org = await call('POST', '/v1/host/openwop-app/orgs', { name: 'Forge Inc' });
    expect(org.status, JSON.stringify(org.body)).toBe(201);
    const orgId: string = org.body.orgId;

    const validCatalogId = listSeedTemplates()[0]!.catalogId; // a VALID id — the strongest forgery attempt
    const created = await call('POST', `/v1/host/openwop-app/documents/orgs/${encodeURIComponent(orgId)}/templates`, {
      name: 'Forged origin', kind: 'doc', outputFormat: 'markdown',
      promptBody: 'Write about {{x}}.',
      catalogId: validCatalogId,
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.catalogId, 'the route must IGNORE a client-supplied catalogId — seed origin is stamped only by the seed path').toBeUndefined();

    // Persisted row, not just the response projection.
    const read = await call('GET', `/v1/host/openwop-app/documents/orgs/${encodeURIComponent(orgId)}/templates/${encodeURIComponent(created.body.templateId)}`);
    expect(read.status).toBe(200);
    expect(read.body.catalogId, 'no seed origin on the persisted row either').toBeUndefined();
  });
});

describe('DOCT-6 — updateTemplate enforces the SAME registered-artifact-type check as createTemplate', () => {
  it('an edit cannot bind an unregistered type; clearing and a registered type still work', async () => {
    const { updateTemplate } = await import('../src/features/documents/documentsService.js');
    const tmpl = await createTemplate({
      tenantId: TENANT, orgId: ORG, name: 'Type probe', kind: 'doc', outputFormat: 'markdown',
      promptBody: 'Write about {{x}}.', createdBy: 'u-1',
    });
    await expect(
      updateTemplate(TENANT, ORG, tmpl.templateId, { artifactTypeId: 'not.a.registered.type' }),
    ).rejects.toMatchObject({ code: 'validation_error' });
    // Polarity: a REGISTERED type binds, and null clears.
    const bound = await updateTemplate(TENANT, ORG, tmpl.templateId, { artifactTypeId: 'doc.sow' });
    expect(bound?.artifactTypeId).toBe('doc.sow');
    const cleared = await updateTemplate(TENANT, ORG, tmpl.templateId, { artifactTypeId: null });
    expect(cleared?.artifactTypeId).toBeUndefined();
  });
});

describe('DOCTPL-2 — the public share projection exposes the producer KIND only', () => {
  async function sharedDoc(producedBy: { kind: 'user' | 'agent' | 'run'; id: string }): Promise<string> {
    const doc = await createDocument({
      tenantId: TENANT, orgId: ORG, title: `Shared ${producedBy.kind}`, kind: 'sow',
      provenance: { producedBy }, createdBy: 'u-1',
    });
    await addVersion(TENANT, ORG, doc.documentId, { content: '# Body', producedBy });
    // Only approved/final are shareable; walk the legal transition.
    await updateDocument(TENANT, ORG, doc.documentId, 'u-1', { status: 'approved' });
    return doc.documentId;
  }

  it('an agent-drafted document says so; ids never leak', async () => {
    const id = await sharedDoc({ kind: 'agent', id: 'agent:writer' });
    const view = await publicDocumentView(TENANT, ORG, id);
    expect(view?.producedByKind).toBe('agent');
    expect(JSON.stringify(view), 'no internal producer id on the public surface').not.toContain('agent:writer');
  });

  it('a human-drafted document does not carry a false model claim', async () => {
    const id = await sharedDoc({ kind: 'user', id: 'u-1' });
    const view = await publicDocumentView(TENANT, ORG, id);
    expect(view?.producedByKind).toBe('user');
  });
});
