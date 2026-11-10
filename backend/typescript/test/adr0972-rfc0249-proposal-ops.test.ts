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
 * Re-witnessed by the w73 probes po72-*.
 *
 * DOUBLE GUARD (recorded, TST-DRO): tenant isolation is held twice on each read —
 * the `${tenant}::` key prefix AND the owner-tenant filter, in `getProposal` and in
 * the installed-template list. A probe removing one leaves the other refusing, so
 * po72-tenantget / po72-tenantlist each remove BOTH in one edit.
 *
 * The list case owns its fixture (wave 73): it applies one proposal and archives
 * another itself, then pages the whole draft listing, so the state filter and the
 * cursor are exercised whatever order the cases run in.
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

interface Res { status: number; body: unknown; headers: Headers }

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
/** One field of a JSON object (`undefined` when it is not an object). */
const field = (v: unknown, key: string): unknown => (isRecord(v) ? v[key] : undefined);
/** A JSON object body, or a thrown error naming what came back. */
function asRecord(v: unknown): Record<string, unknown> {
  if (!isRecord(v)) throw new Error(`not an object: ${JSON.stringify(v)}`);
  return v;
}
/** `items[].<key>` of a list body (throws when there is no items array). */
function itemField(body: unknown, key: string): unknown[] {
  const items = field(body, 'items');
  if (!Array.isArray(items)) throw new Error(`no items: ${JSON.stringify(body)}`);
  return items.map((i) => field(i, key));
}

async function call(key: string, method: string, path: string, body?: unknown): Promise<Res> {
  const res = await fetch(`${ORIGIN}${path}`, {
    method,
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', 'openwop-version': '2' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined, headers: res.headers };
}

type Tmpl = { templateId: string; version: string; kind: string; text: string; name: string };
function template(version = '1.0.0', id = `rfc0249.t${Date.now()}.${n++}`): Tmpl {
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

/** Submit a draft that MUST be accepted; returns its id and digest. */
async function draft(key: string, artifact: Record<string, unknown>): Promise<{ id: string; artifactDigest: string }> {
  const s = await submit(key, artifact);
  expect(s.status, JSON.stringify(s.body)).toBe(201);
  const id = field(s.body, 'id');
  const artifactDigest = field(s.body, 'artifactDigest');
  if (typeof id !== 'string' || typeof artifactDigest !== 'string') throw new Error(`not a proposal: ${JSON.stringify(s.body)}`);
  return { id, artifactDigest };
}
const stateOf = async (id: string): Promise<unknown> => field((await call(KEY_A, 'GET', `/proposals/${id}`)).body, 'state');

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_PROPOSALS_ENABLED = 'true';
  process.env.OPENWOP_API_KEYS = `${KEY_A}:${TENANT_A},${KEY_B}:${TENANT_B}`;
  resetRfc0249WireCache(true);
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { ORIGIN = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  LOW = (await issueApiKey({ tenantId: TENANT_A, name: 'low', createdBy: 'user:rfc0249-harness', scopes: ['proposals:read', 'proposals:write'] })).token;
}, 120_000);
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
    // ADR 1033 — both pack kinds join it once RFC 0253 is vendored. Kinds list in
    // installer-registration order, so compare them as sets.
    const facet = agentsCapability().proposals as Record<string, unknown>;
    const kinds = ['agent-pack', 'prompt-template', 'workflow-chain-pack'];
    expect({ ...facet, artifactKinds: [...(facet.artifactKinds as string[])].sort(), readback: [...(facet.readback as string[])].sort() }).toEqual({
      artifactKinds: kinds, duplicationDetection: false, activation: 'direct-rbac', clientDrafts: true, readback: kinds,
    });
  });

  it('every operation answers 404 not_found while agents.proposals is not advertised', async () => {
    process.env.OPENWOP_PROPOSALS_ENABLED = 'false';
    try {
      for (const [m, p, b] of [['GET', '/proposals'], ['GET', '/proposals/p:x'], ['POST', '/proposals', { kind: 'prompt-template', artifact: template() }], ['POST', '/proposals/p:x:apply', { artifactDigest: 'sha256:0' }]] as const) {
        const r = await call(KEY_A, m, p, b);
        expect(r.status, `${m} ${p} ${JSON.stringify(r.body)}`).toBe(404);
        expect(field(r.body, 'error')).toBe('not_found');
      }
    } finally {
      process.env.OPENWOP_PROPOSALS_ENABLED = 'true';
    }
  });
});

describe('RFC 0249 §B–§D — submit, stay inert, revise, apply, read back', () => {
  it('the positive path: the read-back minus meta is JCS-equal to the revised artifact, not the first', async () => {
    const T = template('1.0.0');
    const id = T.templateId;
    const s = await submit(KEY_A, T);
    expect(s.status, JSON.stringify(s.body)).toBe(201);
    expect(s.body).toMatchObject({ state: 'draft', kind: 'prompt-template', provenance: { sourceRunIds: [] } });
    expect(s.body).not.toHaveProperty('revision');
    expect(field(s.body, 'artifactDigest')).toMatch(/^sha256:[0-9a-f]{64}$/);
    const sid = String(field(s.body, 'id'));

    // Inert while unapplied: not served, not listed, not renderable.
    expect((await call(KEY_A, 'GET', `/prompts/${id}`)).status).toBe(404);
    expect(itemField((await call(KEY_A, 'GET', '/prompts?limit=200')).body, 'templateId')).not.toContain(id);
    expect((await call(KEY_A, 'POST', '/prompts:render', { ref: `prompt:${id}`, variables: {} })).status).toBe(404);

    const T2 = { ...T, version: '1.1.0', text: 'The revised text.' };
    const rv = await call(KEY_A, 'PATCH', `/proposals/${sid}`, { artifact: T2 });
    expect(rv.status, JSON.stringify(rv.body)).toBe(200);
    expect(field(rv.body, 'state')).toBe('revised');
    expect((await call(KEY_A, 'GET', `/prompts/${id}`)).status, 'a revise MUST NOT activate').toBe(404);

    const ap = await call(KEY_A, 'POST', `/proposals/${sid}:apply`, { artifactDigest: field(rv.body, 'artifactDigest') });
    expect(ap.status, JSON.stringify(ap.body)).toBe(200);
    expect(field(ap.body, 'state')).toBe('applied');
    expect(field(field(ap.body, 'activation'), 'installedArtifact')).toEqual({ kind: 'prompt-template', operationId: 'getPromptTemplate', id, version: '1.1.0' });

    const read = await call(KEY_A, 'GET', `/prompts/${id}`);
    expect(read.status).toBe(200);
    expect(canonicalJSON(withoutMeta(asRecord(read.body)))).toBe(canonicalJSON(withoutMeta(T2)));
    expect(canonicalJSON(withoutMeta(asRecord(read.body)))).not.toBe(canonicalJSON(withoutMeta(T)));
    expect(itemField((await call(KEY_A, 'GET', '/prompts?limit=200')).body, 'templateId')).toContain(id);
    const rendered = await call(KEY_A, 'POST', '/prompts:render', { ref: `prompt:${id}`, variables: {} });
    expect(rendered.status, JSON.stringify(rendered.body)).toBe(200);
    expect(field(rendered.body, 'composed')).toBe('The revised text.');
  });

  it('apply binds the digest: missing is 400, a stale one is 409 proposal_stale, and nothing is installed', async () => {
    const T = template();
    const s = await draft(KEY_A, T);
    const missing = await call(KEY_A, 'POST', `/proposals/${s.id}:apply`, {});
    expect(missing.status).toBe(400);
    expect(field(field(missing.body, 'details'), 'field')).toBe('artifactDigest');
    const stale = await call(KEY_A, 'POST', `/proposals/${s.id}:apply`, { artifactDigest: `sha256:${'0'.repeat(64)}` });
    expect(stale.status, JSON.stringify(stale.body)).toBe(409);
    expect(field(stale.body, 'error')).toMatch(code('proposal_stale'));
    expect(await stateOf(s.id)).toBe('draft');
    expect((await call(KEY_A, 'GET', `/prompts/${T.templateId}`)).status).toBe(404);
  });

  it('a kind outside artifactKinds is 400 with details.field kind', async () => {
    const r = await call(KEY_A, 'POST', '/proposals', { kind: 'automation', artifact: { x: 1 } });
    expect(r.status).toBe(400);
    expect(field(field(r.body, 'details'), 'field')).toBe('kind');
  });

  it('an invalid artifact is refused 422 at apply, and nothing is installed', async () => {
    const bad = { templateId: `rfc0249.bad${n++}`, version: '1.0.0', kind: 'system' }; // no `text`
    const s = await draft(KEY_A, bad);
    const ap = await call(KEY_A, 'POST', `/proposals/${s.id}:apply`, { artifactDigest: s.artifactDigest });
    expect(ap.status, JSON.stringify(ap.body)).toBe(422);
    expect(await stateOf(s.id)).toBe('draft');
    expect((await call(KEY_A, 'GET', `/prompts/${bad.templateId}`)).status).toBe(404);
  });
});

describe('RFC 0249 §C — who may apply', () => {
  it('a key without proposals:apply gets 403 insufficient_scope, and nothing changes', async () => {
    const T = template();
    const s = await draft(KEY_A, T);
    const r = await call(LOW, 'POST', `/proposals/${s.id}:apply`, { artifactDigest: s.artifactDigest });
    expect(r.status, JSON.stringify(r.body)).toBe(403);
    expect(r.headers.get('www-authenticate') ?? '').toContain('error="insufficient_scope"');
    expect(await stateOf(s.id)).toBe('draft');
    expect((await call(KEY_A, 'GET', `/prompts/${T.templateId}`)).status).toBe(404);
  });
});

describe('RFC 0249 §A — tenancy: a foreign id is an unknown id', () => {
  it('tenant B reads and applies A\'s proposal as an unknown id, and never sees A\'s installed template', async () => {
    const T = template();
    const s = await draft(KEY_A, T);
    const unknown = await call(KEY_B, 'GET', '/proposals/p:00000000-0000-0000-0000-000000000000');
    const foreign = await call(KEY_B, 'GET', `/proposals/${s.id}`);
    expect(foreign.status).toBe(404);
    expect(foreign.body).toEqual(unknown.body);
    const foreignApply = await call(KEY_B, 'POST', `/proposals/${s.id}:apply`, { artifactDigest: s.artifactDigest });
    expect(foreignApply.status).toBe(404);
    expect(foreignApply.body).toEqual(unknown.body);

    expect((await call(KEY_A, 'POST', `/proposals/${s.id}:apply`, { artifactDigest: s.artifactDigest })).status).toBe(200);
    const id = T.templateId;
    expect((await call(KEY_A, 'GET', `/prompts/${id}`)).status).toBe(200);
    expect((await call(KEY_B, 'GET', `/prompts/${id}`)).status).toBe(404);
    expect(itemField((await call(KEY_B, 'GET', '/prompts?limit=200')).body, 'templateId')).not.toContain(id);
    expect((await call(KEY_B, 'POST', '/prompts:render', { ref: `prompt:${id}`, variables: {} })).status).toBe(404);
  });
});

describe('the lifecycle (ADR 0938 D4, RFC 0249 states)', () => {
  it('a terminal proposal refuses revise, apply, reject and archive with 409 proposal_state_conflict', async () => {
    const s = await draft(KEY_A, template());
    expect((await call(KEY_A, 'POST', `/proposals/${s.id}:apply`, { artifactDigest: s.artifactDigest })).status).toBe(200);
    for (const [m, p, b, action] of [
      ['PATCH', `/proposals/${s.id}`, { title: 'x' }, 'revise'],
      ['POST', `/proposals/${s.id}:apply`, { artifactDigest: s.artifactDigest }, 'apply'],
      ['POST', `/proposals/${s.id}:reject`, {}, 'reject'],
      ['DELETE', `/proposals/${s.id}`, undefined, 'archive'],
    ] as const) {
      const r = await call(KEY_A, m, p, b);
      expect(r.status, `${action} ${JSON.stringify(r.body)}`).toBe(409);
      expect(field(r.body, 'error')).toMatch(code('proposal_state_conflict'));
      expect(field(r.body, 'details')).toMatchObject({ state: 'applied', action });
    }
  });

  it('archive is soft, from a draft', async () => {
    const s = await draft(KEY_A, template());
    const r = await call(KEY_A, 'DELETE', `/proposals/${s.id}`);
    expect(r.status).toBe(200);
    expect(field(r.body, 'state')).toBe('archived');
    expect(await stateOf(s.id)).toBe('archived');
  });

  it('list filters by state and pages with nextCursor', async () => {
    // The case's own non-drafts: one applied, one archived (never another case's).
    const applied = await draft(KEY_A, template());
    expect((await call(KEY_A, 'POST', `/proposals/${applied.id}:apply`, { artifactDigest: applied.artifactDigest })).status).toBe(200);
    const archived = await draft(KEY_A, template());
    expect((await call(KEY_A, 'DELETE', `/proposals/${archived.id}`)).status).toBe(200);
    const drafts: string[] = [];
    for (let i = 0; i < 3; i++) drafts.push((await draft(KEY_A, template())).id);

    // Page the whole draft listing, two at a time (bounded: a cursor that never
    // advances fails here instead of looping).
    const seenIds: unknown[] = [];
    const states: unknown[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await call(KEY_A, 'GET', `/proposals?state=draft&limit=2${cursor !== undefined ? `&cursor=${cursor}` : ''}`);
      expect(page.status, JSON.stringify(page.body)).toBe(200);
      const ids = itemField(page.body, 'id');
      expect(ids.length).toBeGreaterThan(0);
      expect(ids.length).toBeLessThanOrEqual(2);
      seenIds.push(...ids);
      states.push(...itemField(page.body, 'state'));
      const next = field(page.body, 'nextCursor');
      if (next !== undefined && typeof next !== 'string') throw new Error(`nextCursor is not a string: ${JSON.stringify(next)}`);
      cursor = next;
      if (++pages > 200) throw new Error('the draft listing never ended (cursor did not advance)');
    } while (cursor !== undefined);

    expect(pages).toBeGreaterThan(1);
    expect(states.every((st) => st === 'draft')).toBe(true);
    expect(new Set(seenIds).size, 'no proposal on two pages').toBe(seenIds.length);
    for (const id of drafts) expect(seenIds).toContain(id);
    expect(seenIds).not.toContain(applied.id);
    expect(seenIds).not.toContain(archived.id);
  });
});

describe('the install refusals (ADR 0972 D5)', () => {
  it('a host template id is read-only: 409 proposal_install_conflict, nothing installed', async () => {
    const s = await draft(KEY_A, { templateId: 'conformance.prompt.writer-system', version: '9.0.0', kind: 'system', text: 'hijack' });
    const r = await call(KEY_A, 'POST', `/proposals/${s.id}:apply`, { artifactDigest: s.artifactDigest });
    expect(r.status, JSON.stringify(r.body)).toBe(409);
    expect(field(r.body, 'error')).toMatch(code('proposal_install_conflict'));
    expect(field(r.body, 'details')).toMatchObject({ reason: 'read-only' });
    expect(await stateOf(s.id)).toBe('draft');
    expect(field((await call(KEY_A, 'GET', '/prompts/conformance.prompt.writer-system')).body, 'text')).not.toBe('hijack');
  });

  it('an equal or lower version is version-not-greater; a higher one installs', async () => {
    const T = template('2.0.0');
    const first = await draft(KEY_A, T);
    expect((await call(KEY_A, 'POST', `/proposals/${first.id}:apply`, { artifactDigest: first.artifactDigest })).status).toBe(200);
    for (const version of ['2.0.0', '1.5.0']) {
      const s = await draft(KEY_A, { ...T, version, text: 'older' });
      const r = await call(KEY_A, 'POST', `/proposals/${s.id}:apply`, { artifactDigest: s.artifactDigest });
      expect(r.status, JSON.stringify(r.body)).toBe(409);
      expect(field(r.body, 'error')).toMatch(code('proposal_install_conflict'));
      expect(field(r.body, 'details')).toMatchObject({ reason: 'version-not-greater' });
    }
    const up = await draft(KEY_A, { ...T, version: '2.1.0', text: 'newer' });
    expect((await call(KEY_A, 'POST', `/proposals/${up.id}:apply`, { artifactDigest: up.artifactDigest })).status).toBe(200);
    expect(field((await call(KEY_A, 'GET', `/prompts/${T.templateId}`)).body, 'text')).toBe('newer');
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
      const p = await getProposal(TENANT_A, row.id);
      if (p === null) throw new Error('the seeded proposal was not stored');
      const { artifactDigestOf } = await import('../src/features/proposals/proposalsService.js');
      await expect(applyProposal(p, { artifactDigest: artifactDigestOf(p.artifact) })).rejects.toMatchObject({ details: { reason: 'proposal_stale' } });
      expect(rolledBack).toBe(true);
      expect((await call(KEY_A, 'GET', `/prompts/${T.templateId}`)).status).toBe(404);
    } finally {
      registerProposalInstaller('prompt-template', promptTemplateInstaller);
    }
  });
});
