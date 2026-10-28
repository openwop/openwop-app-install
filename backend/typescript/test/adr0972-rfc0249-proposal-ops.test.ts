/**
 * ADR 0972 — RFC 0249 phase 1 on this host: the seven v2 proposal operations,
 * a client-submitted `prompt-template` draft, and its install read-back.
 *
 * Each case drives the real routes with the credentials the suite uses: an env
 * key per tenant, and an `owk_` key that declares `proposals:read` and
 * `proposals:write` but not `proposals:apply`. The RFC 0249 wire is forced on
 * (`resetRfc0249WireCache(true)`) because the vendored schemas do not carry it
 * until the suite release; that is ADR 0972 D9's switch, tested on its own below.
 *
 * Sabotage-witnessed (each made one or more cases here red, then reverted):
 *   - the installed-template read ignoring the tenant →
 *     "tenant B never sees A's installed template" red;
 *   - dropping the digest binding in `applyProposal` → "apply binds the digest" red;
 *   - the installer skipping schema validation → "invalid artifact 422" red;
 *   - `commit` failing without calling `rollback` → "a lost CAS rolls back" red;
 *   - `listPromptTemplates` ignoring the installed layer → "the positive path" red.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { canonicalJSON } from '../src/host/jcs.js';
import { issueApiKey } from '../src/features/developer-keys/apiKeyService.js';
import { agentsCapability } from '../src/routes/discovery.js';
import { scopesSupported, SCOPES_SUPPORTED } from '../src/host/protocolAuthorization.js';
import { resetRfc0249WireCache, rfc0249WireAvailable } from '../src/features/proposals/installedPrompts.js';
import { applyProposal, getProposal, putProposal, registerProposalInstaller, __test } from '../src/features/proposals/proposalsService.js';
import { promptTemplateInstaller } from '../src/features/proposals/installedPrompts.js';
import type { Proposal } from '../src/features/proposals/types.js';

const TENANT_A = 'rfc0249-tenant-a';
const TENANT_B = 'rfc0249-tenant-b';
const KEY_A = 'rfc0249-key-a-0123456789abcdef';
const KEY_B = 'rfc0249-key-b-0123456789abcdef';
let LOW = '';
let server: http.Server;
let ORIGIN = '';
let n = 0;

interface Res { status: number; body: any; headers: Headers }

async function call(key: string, method: string, path: string, body?: unknown): Promise<Res> {
  const res = await fetch(`${ORIGIN}${path}`, {
    method,
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', 'openwop-version': '2' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined, headers: res.headers };
}

function template(version = '1.0.0', id = `rfc0249.t${Date.now()}.${n++}`): Record<string, unknown> {
  return { templateId: id, version, kind: 'system', text: `You are helper ${id} at ${version}.`, name: 'Helper' };
}

/** The three 409 codes are registered in the v2 error registry since 2.46.21, so
 *  `v2ErrorCode` passes them through bare (ADR 0972 P2). */
const code = (c: string): RegExp => new RegExp(`^${c}$`);

const withoutMeta = (t: Record<string, unknown>): Record<string, unknown> => {
  const { meta: _meta, ...rest } = t;
  return rest;
};

async function submit(key: string, artifact: Record<string, unknown>): Promise<Res> {
  return call(key, 'POST', '/proposals', { kind: 'prompt-template', artifact, title: 'A template' });
}

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_PROPOSALS_ENABLED = 'true';
  process.env.OPENWOP_API_KEYS = `${KEY_A}:${TENANT_A},${KEY_B}:${TENANT_B}`;
  resetRfc0249WireCache(true);
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { ORIGIN = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  LOW = (await issueApiKey({ tenantId: TENANT_A, name: 'low', createdBy: 'user:rfc0249-harness', scopes: ['proposals:read', 'proposals:write'] })).token;
});
afterAll(async () => {
  resetRfc0249WireCache();
  await new Promise<void>((res) => server.close(() => res()));
});

describe('the advertisement (ADR 0972 D9)', () => {
  it('the vendored schemas carry RFC 0249, so the wire is on', () => {
    // ADR 0972 P2: the 2.46.21 pin is the switch. P1 asserted false here.
    resetRfc0249WireCache();
    try {
      expect(rfc0249WireAvailable()).toBe(true);
    } finally {
      resetRfc0249WireCache(true);
    }
  });

  it('while the wire is off, scopes_supported omits the proposal scopes and no route refuses for them', async () => {
    resetRfc0249WireCache(false);
    try {
      expect(scopesSupported()).toEqual(SCOPES_SUPPORTED);
      const r = await call(LOW, 'POST', '/proposals/p:x:apply', { artifactDigest: 'sha256:0' });
      expect(r.status, 'unadvertised before any scope check').toBe(404);
      expect(r.headers.get('www-authenticate') ?? '').not.toContain('insufficient_scope');
    } finally {
      resetRfc0249WireCache(true);
    }
    expect(scopesSupported()).toEqual([...SCOPES_SUPPORTED, 'proposals:read', 'proposals:write', 'proposals:apply']);
  });

  it('agents.proposals advertises prompt-template with clientDrafts and readback', () => {
    expect(agentsCapability().proposals).toEqual({
      artifactKinds: ['prompt-template'], duplicationDetection: false, activation: 'direct-rbac',
      clientDrafts: true, readback: ['prompt-template'],
    });
  });

  it('every operation answers 404 not_found while agents.proposals is not advertised', async () => {
    process.env.OPENWOP_PROPOSALS_ENABLED = 'false';
    try {
      for (const [m, p, b] of [['GET', '/proposals'], ['GET', '/proposals/p:x'], ['POST', '/proposals', { kind: 'prompt-template', artifact: template() }], ['POST', '/proposals/p:x:apply', { artifactDigest: 'sha256:0' }]] as const) {
        const r = await call(KEY_A, m, p, b);
        expect(r.status, `${m} ${p} ${JSON.stringify(r.body)}`).toBe(404);
        expect(r.body.error).toBe('not_found');
      }
    } finally {
      process.env.OPENWOP_PROPOSALS_ENABLED = 'true';
    }
  });
});

describe('RFC 0249 §B–§D — submit, stay inert, revise, apply, read back', () => {
  it('the positive path: the read-back minus meta is JCS-equal to the revised artifact, not the first', async () => {
    const T = template('1.0.0');
    const id = T.templateId as string;
    const s = await submit(KEY_A, T);
    expect(s.status, JSON.stringify(s.body)).toBe(201);
    expect(s.body).toMatchObject({ state: 'draft', kind: 'prompt-template', provenance: { sourceRunIds: [] } });
    expect(s.body).not.toHaveProperty('revision');
    expect(s.body.artifactDigest).toMatch(/^sha256:[0-9a-f]{64}$/);

    // Inert while unapplied: not served, not listed, not renderable.
    expect((await call(KEY_A, 'GET', `/prompts/${id}`)).status).toBe(404);
    expect((await call(KEY_A, 'GET', '/prompts?limit=200')).body.items.map((t: { templateId: string }) => t.templateId)).not.toContain(id);
    expect((await call(KEY_A, 'POST', '/prompts:render', { ref: `prompt:${id}`, variables: {} })).status).toBe(404);

    const T2 = { ...T, version: '1.1.0', text: 'The revised text.' };
    const rv = await call(KEY_A, 'PATCH', `/proposals/${s.body.id}`, { artifact: T2 });
    expect(rv.status, JSON.stringify(rv.body)).toBe(200);
    expect(rv.body.state).toBe('revised');
    expect((await call(KEY_A, 'GET', `/prompts/${id}`)).status, 'a revise MUST NOT activate').toBe(404);

    const ap = await call(KEY_A, 'POST', `/proposals/${s.body.id}:apply`, { artifactDigest: rv.body.artifactDigest });
    expect(ap.status, JSON.stringify(ap.body)).toBe(200);
    expect(ap.body.state).toBe('applied');
    expect(ap.body.activation.installedArtifact).toEqual({ kind: 'prompt-template', operationId: 'getPromptTemplate', id, version: '1.1.0' });

    const read = await call(KEY_A, 'GET', `/prompts/${id}`);
    expect(read.status).toBe(200);
    expect(canonicalJSON(withoutMeta(read.body))).toBe(canonicalJSON(withoutMeta(T2)));
    expect(canonicalJSON(withoutMeta(read.body))).not.toBe(canonicalJSON(withoutMeta(T)));
    expect((await call(KEY_A, 'GET', '/prompts?limit=200')).body.items.map((t: { templateId: string }) => t.templateId)).toContain(id);
    const rendered = await call(KEY_A, 'POST', '/prompts:render', { ref: `prompt:${id}`, variables: {} });
    expect(rendered.status, JSON.stringify(rendered.body)).toBe(200);
    expect(rendered.body.composed).toBe('The revised text.');
  });

  it('apply binds the digest: missing is 400, a stale one is 409 proposal_stale, and nothing is installed', async () => {
    const T = template();
    const s = await submit(KEY_A, T);
    const missing = await call(KEY_A, 'POST', `/proposals/${s.body.id}:apply`, {});
    expect(missing.status).toBe(400);
    expect(missing.body.details.field).toBe('artifactDigest');
    const stale = await call(KEY_A, 'POST', `/proposals/${s.body.id}:apply`, { artifactDigest: `sha256:${'0'.repeat(64)}` });
    expect(stale.status, JSON.stringify(stale.body)).toBe(409);
    expect(stale.body.error).toMatch(code('proposal_stale'));
    expect((await call(KEY_A, 'GET', `/proposals/${s.body.id}`)).body.state).toBe('draft');
    expect((await call(KEY_A, 'GET', `/prompts/${T.templateId as string}`)).status).toBe(404);
  });

  it('a kind outside artifactKinds is 400 with details.field kind', async () => {
    const r = await call(KEY_A, 'POST', '/proposals', { kind: 'automation', artifact: { x: 1 } });
    expect(r.status).toBe(400);
    expect(r.body.details.field).toBe('kind');
  });

  it('an invalid artifact is refused 422 at apply, and nothing is installed', async () => {
    const bad = { templateId: `rfc0249.bad${n++}`, version: '1.0.0', kind: 'system' }; // no `text`
    const s = await submit(KEY_A, bad);
    expect(s.status).toBe(201);
    const ap = await call(KEY_A, 'POST', `/proposals/${s.body.id}:apply`, { artifactDigest: s.body.artifactDigest });
    expect(ap.status, JSON.stringify(ap.body)).toBe(422);
    expect((await call(KEY_A, 'GET', `/proposals/${s.body.id}`)).body.state).toBe('draft');
    expect((await call(KEY_A, 'GET', `/prompts/${bad.templateId}`)).status).toBe(404);
  });
});

describe('RFC 0249 §C — who may apply', () => {
  it('a key without proposals:apply gets 403 insufficient_scope, and nothing changes', async () => {
    const T = template();
    const s = await submit(KEY_A, T);
    const r = await call(LOW, 'POST', `/proposals/${s.body.id}:apply`, { artifactDigest: s.body.artifactDigest });
    expect(r.status, JSON.stringify(r.body)).toBe(403);
    expect(r.headers.get('www-authenticate') ?? '').toContain('error="insufficient_scope"');
    expect((await call(KEY_A, 'GET', `/proposals/${s.body.id}`)).body.state).toBe('draft');
    expect((await call(KEY_A, 'GET', `/prompts/${T.templateId as string}`)).status).toBe(404);
  });
});

describe('RFC 0249 §A — tenancy: a foreign id is an unknown id', () => {
  it('tenant B reads and applies A\'s proposal as an unknown id, and never sees A\'s installed template', async () => {
    const T = template();
    const s = await submit(KEY_A, T);
    const unknown = await call(KEY_B, 'GET', '/proposals/p:00000000-0000-0000-0000-000000000000');
    const foreign = await call(KEY_B, 'GET', `/proposals/${s.body.id}`);
    expect(foreign.status).toBe(404);
    expect(foreign.body).toEqual(unknown.body);
    const foreignApply = await call(KEY_B, 'POST', `/proposals/${s.body.id}:apply`, { artifactDigest: s.body.artifactDigest });
    expect(foreignApply.status).toBe(404);
    expect(foreignApply.body).toEqual(unknown.body);

    expect((await call(KEY_A, 'POST', `/proposals/${s.body.id}:apply`, { artifactDigest: s.body.artifactDigest })).status).toBe(200);
    const id = T.templateId as string;
    expect((await call(KEY_A, 'GET', `/prompts/${id}`)).status).toBe(200);
    expect((await call(KEY_B, 'GET', `/prompts/${id}`)).status).toBe(404);
    expect((await call(KEY_B, 'GET', '/prompts?limit=200')).body.items.map((t: { templateId: string }) => t.templateId)).not.toContain(id);
    expect((await call(KEY_B, 'POST', '/prompts:render', { ref: `prompt:${id}`, variables: {} })).status).toBe(404);
  });
});

describe('the lifecycle (ADR 0938 D4, RFC 0249 states)', () => {
  it('a terminal proposal refuses revise, apply, reject and archive with 409 proposal_state_conflict', async () => {
    const s = await submit(KEY_A, template());
    expect((await call(KEY_A, 'POST', `/proposals/${s.body.id}:apply`, { artifactDigest: s.body.artifactDigest })).status).toBe(200);
    for (const [m, p, b, action] of [
      ['PATCH', `/proposals/${s.body.id}`, { title: 'x' }, 'revise'],
      ['POST', `/proposals/${s.body.id}:apply`, { artifactDigest: s.body.artifactDigest }, 'apply'],
      ['POST', `/proposals/${s.body.id}:reject`, {}, 'reject'],
      ['DELETE', `/proposals/${s.body.id}`, undefined, 'archive'],
    ] as const) {
      const r = await call(KEY_A, m, p, b);
      expect(r.status, `${action} ${JSON.stringify(r.body)}`).toBe(409);
      expect(r.body.error).toMatch(code('proposal_state_conflict'));
      expect(r.body.details).toMatchObject({ state: 'applied', action });
    }
  });

  it('archive is soft, from a draft', async () => {
    const s = await submit(KEY_A, template());
    const r = await call(KEY_A, 'DELETE', `/proposals/${s.body.id}`);
    expect(r.status).toBe(200);
    expect(r.body.state).toBe('archived');
    expect((await call(KEY_A, 'GET', `/proposals/${s.body.id}`)).body.state).toBe('archived');
  });

  it('list filters by state and pages with nextCursor', async () => {
    for (let i = 0; i < 3; i++) await submit(KEY_A, template());
    const p1 = await call(KEY_A, 'GET', '/proposals?state=draft&limit=2');
    expect(p1.status).toBe(200);
    expect(p1.body.items).toHaveLength(2);
    expect(p1.body.items.every((p: { state: string }) => p.state === 'draft')).toBe(true);
    const p2 = await call(KEY_A, 'GET', `/proposals?state=draft&limit=2&cursor=${p1.body.nextCursor as string}`);
    expect(p2.body.items[0].id).not.toBe(p1.body.items[0].id);
  });
});

describe('the install refusals (ADR 0972 D5)', () => {
  it('a host template id is read-only: 409 proposal_install_conflict, nothing installed', async () => {
    const s = await submit(KEY_A, { templateId: 'conformance.prompt.writer-system', version: '9.0.0', kind: 'system', text: 'hijack' });
    const r = await call(KEY_A, 'POST', `/proposals/${s.body.id}:apply`, { artifactDigest: s.body.artifactDigest });
    expect(r.status, JSON.stringify(r.body)).toBe(409);
    expect(r.body.error).toMatch(code('proposal_install_conflict'));
    expect(r.body.details).toMatchObject({ reason: 'read-only' });
    expect((await call(KEY_A, 'GET', `/proposals/${s.body.id}`)).body.state).toBe('draft');
    expect((await call(KEY_A, 'GET', '/prompts/conformance.prompt.writer-system')).body.text).not.toBe('hijack');
  });

  it('an equal or lower version is version-not-greater; a higher one installs', async () => {
    const T = template('2.0.0');
    const first = await submit(KEY_A, T);
    expect((await call(KEY_A, 'POST', `/proposals/${first.body.id}:apply`, { artifactDigest: first.body.artifactDigest })).status).toBe(200);
    for (const version of ['2.0.0', '1.5.0']) {
      const s = await submit(KEY_A, { ...T, version, text: 'older' });
      const r = await call(KEY_A, 'POST', `/proposals/${s.body.id}:apply`, { artifactDigest: s.body.artifactDigest });
      expect(r.status, JSON.stringify(r.body)).toBe(409);
      expect(r.body.error).toMatch(code('proposal_install_conflict'));
      expect(r.body.details).toMatchObject({ reason: 'version-not-greater' });
    }
    const up = await submit(KEY_A, { ...T, version: '2.1.0', text: 'newer' });
    expect((await call(KEY_A, 'POST', `/proposals/${up.body.id}:apply`, { artifactDigest: up.body.artifactDigest })).status).toBe(200);
    expect((await call(KEY_A, 'GET', `/prompts/${T.templateId as string}`)).body.text).toBe('newer');
  });
});

describe('apply and install exist only together (ADR 0972 D5)', () => {
  it('a lost CAS rolls the install back', async () => {
    const T = template();
    const row: Proposal = {
      id: `p:rollback-${n++}`, kind: 'prompt-template', state: 'draft', artifact: T,
      provenance: { sourceRunIds: [] }, duplicateOf: null, owner: { tenant: TENANT_A }, revision: 0,
      createdAt: new Date().toISOString(),
    };
    await putProposal(row);
    let rolledBack = false;
    registerProposalInstaller('prompt-template', {
      async install(tenant, p) {
        const out = await promptTemplateInstaller.install(tenant, p);
        // A concurrent revise lands between the install and the proposal's CAS.
        await __test.collection.put({ ...p, title: 'concurrent', revision: 1 });
        return { ...out, rollback: async () => { rolledBack = true; await out.rollback?.(); } };
      },
    });
    try {
      const p = (await getProposal(TENANT_A, row.id))!;
      const { artifactDigestOf } = await import('../src/features/proposals/proposalsService.js');
      await expect(applyProposal(p, { artifactDigest: artifactDigestOf(p.artifact) })).rejects.toMatchObject({ details: { reason: 'proposal_stale' } });
      expect(rolledBack).toBe(true);
      expect((await call(KEY_A, 'GET', `/prompts/${T.templateId as string}`)).status).toBe(404);
    } finally {
      registerProposalInstaller('prompt-template', promptTemplateInstaller);
    }
  });
});
