/**
 * ADR 0625 — RFC 0165 host leg: `protocolVersions[]`, the `owner.subject`
 * record with the §B.3 legacy synthesis, the `run.started` owner echo, the
 * §B.4 fork copy, and the discovery `ETag` / `304`.
 *
 * The suite's own witnesses (`protocol-versions-array`, `owner-subject-shape`,
 * `owner-subject-echo`, the discovery ETag leg) run against this host under
 * `npm run test:conformance`; this file pins the HOST decisions those scenarios
 * cannot see: which lane each credential attests, that `subjectId` IS
 * `owner.principal` by construction, and that a fork keeps the source's owner
 * while `actingUserId` still re-stamps to the forker (ADR 0024).
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { PROTOCOL_VERSION } from '../src/routes/discovery.js';
import { LEGACY_SUBJECT_ISSUER, opaquePrincipal, runOwner, subjectChainDepth, type RunSubject } from '../src/host/runOwner.js';

const TOKEN = 'dev-token';
const GRAMMAR = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
let BASE = '';
let server: http.Server;
let workflowId = 'openwop-app.uppercase';

interface Owner { tenant: string; principal?: string; principalKind?: string; subject?: RunSubject }

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((r) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; r(); }); });
  const disco = (await (await fetch(`${BASE}/.well-known/openwop`)).json()) as { fixtures?: string[] };
  workflowId = disco.fixtures?.[0] ?? workflowId;
});
afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });

async function jf<T = unknown>(path: string, init: RequestInit = {}): Promise<{ status: number; body: T; headers: Headers }> {
  const res = await fetch(`${BASE}${path}`, { ...init, headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}`, ...((init.headers as Record<string, string>) ?? {}) } });
  const raw = res.status === 204 || res.status === 304 ? undefined : await res.json();
  return { status: res.status, body: raw as T, headers: res.headers };
}

async function waitTerminal(runId: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    const r = await jf<{ status: string }>(`/v1/runs/${runId}`);
    if (['completed', 'failed', 'cancelled'].includes(r.body.status)) return;
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe('RFC 0165 §A — protocolVersions[] (ADR 0625)', () => {
  it('is a non-empty unique array of MAJOR.MINOR strings at the document ROOT that contains the scalar', async () => {
    const doc = (await jf<{ protocolVersion: string; protocolVersions: unknown; capabilities?: Record<string, unknown> }>('/.well-known/openwop')).body;
    expect(doc.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(Array.isArray(doc.protocolVersions)).toBe(true);
    const arr = doc.protocolVersions as string[];
    expect(arr.length).toBeGreaterThan(0);
    for (const v of arr) expect(v).toMatch(GRAMMAR);
    expect(new Set(arr).size).toBe(arr.length);
    expect(arr).toContain(doc.protocolVersion);
    // A root property, not a capability family: not mirrored into the wrapper.
    expect(doc.capabilities && 'protocolVersions' in doc.capabilities).toBe(false);
  });
});

describe('RFC 0165 §C.2 — discovery ETag / If-None-Match → 304 (ADR 0625)', () => {
  it('sends a strong ETag equal to Capabilities-Etag, answers 304 on a match and 200 on a mismatch', async () => {
    const first = await fetch(`${BASE}/.well-known/openwop`);
    const etag = first.headers.get('etag');
    expect(etag).toMatch(/^"[0-9a-f]{16}"$/);
    expect(first.headers.get('capabilities-etag')).toBe(etag);
    const again = await fetch(`${BASE}/.well-known/openwop`, { headers: { 'if-none-match': etag! } });
    expect(again.status).toBe(304);
    expect(again.headers.get('etag')).toBe(etag);
    expect((await again.text()).length).toBe(0);
    const weak = await fetch(`${BASE}/.well-known/openwop`, { headers: { 'if-none-match': `W/${etag}` } });
    expect(weak.status).toBe(304);
    const miss = await fetch(`${BASE}/.well-known/openwop`, { headers: { 'if-none-match': '"0000000000000000"' } });
    expect(miss.status).toBe(200);
    expect(miss.headers.get('etag')).toBe(etag);
  });
});

describe('RFC 0165 §B — owner.subject on the snapshot, the run.started echo, and the fork (ADR 0625)', () => {
  it('a run created with the operator API key carries an api-key/workload subject whose subjectId IS owner.principal; run.started echoes it; the fork copies it verbatim', async () => {
    const created = await jf<{ runId: string }>('/v1/runs', { method: 'POST', body: JSON.stringify({ workflowId, inputs: { text: 'x' } }) });
    expect([201, 202]).toContain(created.status);
    const runId = created.body.runId;
    await waitTerminal(runId);

    const snap = (await jf<{ owner?: Owner }>(`/v1/runs/${runId}`)).body;
    const owner = snap.owner;
    expect(owner, 'an authenticated run MUST carry the owner block').toBeDefined();
    expect(owner!.principal).toMatch(/^[0-9a-f]{16}$/);
    expect(owner!.principalKind, 'a workload credential has no RFC 0132 principalKind').toBeUndefined();
    const subject = owner!.subject!;
    expect(subject.tenant).toBe(owner!.tenant);
    expect(subject.subjectId).toBe(owner!.principal);
    expect(subject.lane).toBe('api-key');
    expect(subject.kind).toBe('workload');
    expect(subject.issuer).toBe('urn:openwop-app:env-key');
    expect(subject.keyClass).toBeUndefined();
    expect(subject.actor).toBeUndefined();
    expect(subject.issuer).not.toBe(LEGACY_SUBJECT_ISSUER);
    // Opaque, never the raw credential/principal (SECURITY subject-record-opaque).
    expect(subject.subjectId).not.toContain('bearer');
    expect(subject.subjectId).not.toContain(TOKEN);

    // ADR 0625 — the spec-canonical poll cursor must not lose the FIRST event:
    // An ABSENT cursor means "from the first event"; `run.started` IS sequence 0,
    // so `lastSequence=0` would exclude it (the cursor is exclusive). `lastSequence`
    // at run.started's own sequence excludes it (strictly-after semantics).
    const viaCursor = (await jf<{ events: Array<{ type: string; sequence: number }> }>(`/v1/runs/${runId}/events/poll?timeout=1`)).body.events;
    const startedViaCursor = viaCursor.find((e) => e.type === 'run.started');
    expect(startedViaCursor, 'an ABSENT cursor MUST include run.started (RFC 0171 §A.3: it is sequence 0, and the cursor is exclusive)').toBeDefined();
    const after = (await jf<{ events: Array<{ type: string; sequence: number }> }>(`/v1/runs/${runId}/events/poll?lastSequence=${startedViaCursor!.sequence}&timeout=1`)).body.events;
    expect(after.some((e) => e.type === 'run.started')).toBe(false);
    expect(after.every((e) => e.sequence > startedViaCursor!.sequence)).toBe(true);

    // The run.started echo is the SAME block. No cursor: `run.started` is sequence 0
    // and the poll cursor is exclusive, so `fromSeq=0` would exclude the very event
    // this leg is about.
    const events = (await jf<{ events?: Array<{ type: string; payload?: { owner?: Owner } }> } | Array<{ type: string; payload?: { owner?: Owner } }>>(`/v1/runs/${runId}/events/poll?limit=200`)).body;
    const list = Array.isArray(events) ? events : (events.events ?? []);
    const started = list.find((e) => e.type === 'run.started');
    expect(started, 'run.started MUST be in the log').toBeDefined();
    expect(started!.payload?.owner).toEqual(owner);

    // §B.4 — the fork keeps tenant + subject (+ principal) from the SOURCE.
    const fork = await jf<{ runId: string }>(`/v1/runs/${runId}:fork`, { method: 'POST', body: JSON.stringify({ fromSeq: 0, mode: 'replay' }) });
    expect(fork.status).toBe(201);
    await waitTerminal(fork.body.runId);
    const child = (await jf<{ owner?: Owner }>(`/v1/runs/${fork.body.runId}`)).body;
    expect(child.owner?.tenant).toBe(owner!.tenant);
    expect(child.owner?.principal).toBe(owner!.principal);
    expect(child.owner?.subject).toEqual(subject);
  });
});

describe('RFC 0165 §B.3 — legacy synthesis and consistency guards (host/runOwner.ts unit)', () => {
  it('a pre-stamp run with actingUserId reads back with the legacy issuer, subjectId == principal, kind user, no principalKind', () => {
    const o = runOwner({ tenantId: 't1', metadata: { actingUserId: 'user-A' } })!;
    expect(o).toEqual({
      tenant: 't1',
      principal: opaquePrincipal('user-A'),
      subject: { issuer: LEGACY_SUBJECT_ISSUER, subjectId: opaquePrincipal('user-A'), tenant: 't1', lane: 'api-key', kind: 'user' },
    });
    expect(o.principal).not.toBe('user-A');
  });
  it('a pre-stamp anon run keeps its opaque anon principal and principalKind anonymous, with a legacy anonymous subject', () => {
    const o = runOwner({ tenantId: 'anon:1', metadata: { principalKind: 'anonymous', anonPrincipal: 'anon-xyz' } })!;
    expect(o.principal).toBe('anon-xyz');
    expect(o.principalKind).toBe('anonymous');
    expect(o.subject).toEqual({ issuer: LEGACY_SUBJECT_ISSUER, subjectId: 'anon-xyz', tenant: 'anon:1', lane: 'api-key', kind: 'anonymous' });
  });
  it('a run with neither stamp nor principal yields no owner', () => {
    expect(runOwner({ tenantId: 't1', metadata: {} })).toBeUndefined();
    expect(runOwner({ tenantId: 't1', metadata: null })).toBeUndefined();
  });
  it('a persisted stamp is emitted verbatim with subject.tenant forced to the run tenant', () => {
    const stamp = { principal: 'abcd', principalKind: 'user', subject: { issuer: 'https://idp.example', subjectId: 'abcd', lane: 'oidc', kind: 'user' } };
    const o = runOwner({ tenantId: 't9', metadata: { owner: stamp } })!;
    expect(o).toEqual({ tenant: 't9', principal: 'abcd', principalKind: 'user', subject: { ...stamp.subject, tenant: 't9' } });
  });
  it('a stamp whose subjectId disagrees with the principal falls back to the legacy form rather than violate §B.2', () => {
    const o = runOwner({ tenantId: 't9', metadata: { owner: { principal: 'abcd', subject: { issuer: 'https://idp.example', subjectId: 'zzzz', lane: 'oidc', kind: 'user' } } } })!;
    expect(o.principal).toBe('abcd');
    expect(o.subject?.issuer).toBe(LEGACY_SUBJECT_ISSUER);
    expect(o.subject?.subjectId).toBe('abcd');
  });
  it('a client-supplied metadata.owner is stripped at run creation (reserved key)', async () => {
    const forged = { principal: 'ffff', subject: { issuer: 'https://evil.example', subjectId: 'ffff', lane: 'saml', kind: 'user', keyClass: 'opaque-idp' } };
    const created = await jf<{ runId: string }>('/v1/runs', { method: 'POST', body: JSON.stringify({ workflowId, inputs: { text: 'x' }, metadata: { owner: forged } }) });
    expect([201, 202]).toContain(created.status);
    await waitTerminal(created.body.runId);
    const snap = (await jf<{ owner?: Owner }>(`/v1/runs/${created.body.runId}`)).body;
    expect(snap.owner?.principal).not.toBe('ffff');
    expect(snap.owner?.subject?.issuer).toBe('urn:openwop-app:env-key');
  });
  it('actor chain depth is measured from the root subject', () => {
    const s = (d: number): RunSubject => ({ issuer: 'i', subjectId: 's', tenant: 't', lane: 'oidc', kind: 'user', ...(d > 1 ? { actor: s(d - 1) } : {}) });
    expect(subjectChainDepth(undefined)).toBe(0);
    expect(subjectChainDepth(s(1))).toBe(1);
    expect(subjectChainDepth(s(5))).toBe(5);
  });
});
