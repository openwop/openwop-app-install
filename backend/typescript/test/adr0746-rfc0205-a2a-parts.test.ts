/**
 * ADR 0746 — RFC 0205: run artifacts and conversation turns speak A2A Parts.
 *
 * Route-level on purpose. Every rule this ADR adds — auth order, tenant
 * non-disclosure, the announcement + ownership gates, major-2-only negotiation —
 * is only observable through the HTTP boundary, so the service seams are driven
 * through `createApp` rather than called directly. Bodies are validated against
 * the VENDORED v2 schemas, the same files the corpus scenarios load, so a pass
 * here is a pass against the shape `v2-artifact-a2a-shape` and
 * `v2-conversation-turn-parts` check rather than against a restatement of it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

import { createApp } from '../src/index.js';
import { makeTurn } from '../src/host/conversation.js';
import { partsFromTurnContent, artifact10 } from '../src/host/a2aCodec10.js';
import { getEventLog } from '../src/executor/eventLog.js';
import { resolveRunArtifact } from '../src/host/runArtifactRead.js';
import { createMember } from '../src/host/accessControlService.js';
import { createDocument, addVersion } from '../src/features/documents/documentsService.js';
import type { EventRecord, RunRecord } from '../src/types.js';
import { issueApiKey } from '../src/features/developer-keys/apiKeyService.js';
import { mintRunStreamToken } from '../src/host/runStreamToken.js';
import { getRunArtifact } from '../src/host/runArtifactStore.js';

const V2_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'schemas', 'v2');

let ajv: Ajv2020 | undefined;
function v2(name: string): (doc: unknown) => { ok: boolean; errors: string } {
  if (!ajv) {
    ajv = new Ajv2020({ strict: false, allErrors: true });
    (addFormats as unknown as (a: unknown) => void)(ajv);
    for (const f of readdirSync(V2_DIR)) {
      if (!f.endsWith('.schema.json')) continue;
      try { ajv.addSchema(JSON.parse(readFileSync(join(V2_DIR, f), 'utf8')) as Record<string, unknown>); } catch { /* duplicate $id */ }
    }
  }
  const fn = ajv.getSchema(`https://openwop.dev/spec/v2/${name}.schema.json`);
  if (!fn) throw new Error(`schema ${name} not registered`);
  return (doc) => ({ ok: fn(doc) as boolean, errors: JSON.stringify(fn.errors ?? []) });
}

const KEY_A = 'ws3-key-a';
const KEY_B = 'ws3-key-b';
const A2A = 'application/a2a+json';
let server: Server;
let base = '';
const prevKeys = process.env.OPENWOP_API_KEYS;
const prevRunsPerMin = process.env.OPENWOP_RATELIMIT_SESSION_RUNS_PER_MIN;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  process.env.OPENWOP_API_KEYS = `${KEY_A}:ws3-tenant-a,${KEY_B}:ws3-tenant-b`;
  // This file starts more than the default 10 runs/min per session.
  process.env.OPENWOP_RATELIMIT_SESSION_RUNS_PER_MIN = '1000';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  server = await new Promise<Server>((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  if (prevKeys === undefined) delete process.env.OPENWOP_API_KEYS; else process.env.OPENWOP_API_KEYS = prevKeys;
  if (prevRunsPerMin === undefined) delete process.env.OPENWOP_RATELIMIT_SESSION_RUNS_PER_MIN; else process.env.OPENWOP_RATELIMIT_SESSION_RUNS_PER_MIN = prevRunsPerMin;
  await new Promise<void>((r) => server.close(() => r()));
});

/** v2 speaks unversioned paths selected by the header. */
function v2Headers(key: string, extra: Record<string, string> = {}): Record<string, string> {
  return { Authorization: `Bearer ${key}`, 'OpenWOP-Version': '2', 'Content-Type': 'application/json', ...extra };
}

type Json = Record<string, unknown>;

async function runToCompletion(workflowId: string, key = KEY_A): Promise<string> {
  const res = await fetch(`${base}/runs`, { method: 'POST', headers: v2Headers(key), body: JSON.stringify({ workflowId }) });
  expect(res.status, await res.clone().text()).toBe(201);
  const runId = String(((await res.json()) as Json)['runId'] ?? '');
  for (let i = 0; i < 100; i++) {
    const s = await fetch(`${base}/runs/${encodeURIComponent(runId)}`, { headers: v2Headers(key) });
    const status = ((await s.json()) as Json)['status'];
    if (status === 'completed') return runId;
    if (status === 'failed' || status === 'cancelled') throw new Error(`${workflowId} ended ${String(status)}`);
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`${workflowId} did not complete`);
}

async function v2Events(runId: string, key = KEY_A): Promise<Json[]> {
  const res = await fetch(`${base}/runs/${encodeURIComponent(runId)}/events/poll?timeout=1`, { headers: v2Headers(key) });
  return (((await res.json()) as Json)['events'] ?? []) as Json[];
}

function artifactUrl(runId: string, artifactId: string, prefix = ''): string {
  return `${base}${prefix}/runs/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(artifactId)}`;
}

async function emittedArtifact(): Promise<{ runId: string; artifactId: string }> {
  const runId = await runToCompletion('conformance-artifact-emit');
  const created = (await v2Events(runId)).find((e) => e['type'] === 'artifact.created');
  const artifactId = String(((created?.['payload'] ?? {}) as Json)['artifactId'] ?? '');
  expect(artifactId, 'the fixture must announce an artifactId or nothing below asserts anything').not.toBe('');
  return { runId, artifactId };
}

describe('RFC 0205 §B — turn parts (the pure encoder)', () => {
  it('string → text; text-only ContentPart[] → text Parts; JSON → data Part; null → none', () => {
    expect(partsFromTurnContent('hi')).toEqual([{ text: 'hi' }]);
    expect(partsFromTurnContent([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }])).toEqual([{ text: 'a' }, { text: 'b' }]);
    expect(partsFromTurnContent({ kind: 'no-response' })).toEqual([{ data: { kind: 'no-response' }, mediaType: 'application/json' }]);
    expect(partsFromTurnContent([1, 2])).toEqual([{ data: [1, 2], mediaType: 'application/json' }]);
    expect(partsFromTurnContent(null)).toBeUndefined();
  });

  it('media content gets NO parts — never a raw copy of the bytes, never a text-only half', () => {
    const img = [{ type: 'text', text: 'look' }, { type: 'image', mimeType: 'image/png', dataBase64: 'iVBORw0KGgo=' }];
    expect(partsFromTurnContent(img)).toBeUndefined();
    const turn = makeTurn({ conversationId: 'c', turnIndex: 1, role: 'user', from: 'user', content: img, ts: 1 });
    expect('parts' in turn).toBe(false);
    expect(turn.content, '§B.6 — content is unchanged').toBe(img);
  });

  it('makeTurn emits parts that validate against the closed v2 turn def, content unchanged', () => {
    const validate = v2('conversation-turn');
    const user = makeTurn({ conversationId: 'c', turnIndex: 1, role: 'user', from: 'user', content: 'Hello', ts: 1 });
    const agent = makeTurn({ conversationId: 'c', turnIndex: 2, role: 'agent', from: 'host:a', speakerId: 'host:a', content: { answer: 42 }, ts: 2 });
    expect(user.parts).toEqual([{ text: 'Hello' }]);
    expect(user.content).toBe('Hello');
    for (const t of [user, agent]) {
      const r = validate(t);
      expect(r.ok, r.errors).toBe(true);
    }
  });
});

describe('RFC 0205 §A — artifact10', () => {
  it('validates against artifact.schema.json and drops a type id outside the typeId grammar', () => {
    const validate = v2('artifact');
    const ok = artifact10({ artifactId: 'x', name: 'N', body: { kind: 'data', data: { a: 1 } }, artifactTypeId: 'conformance.artifact.brief' });
    expect(validate(ok).ok, validate(ok).errors).toBe(true);
    expect((ok['metadata'] as Json)['openwop']).toEqual({ artifactTypeId: 'conformance.artifact.brief' });
    const bad = artifact10({ artifactId: 'x', body: { kind: 'text', text: '# hi', mediaType: 'text/markdown' }, artifactTypeId: 'Not A Type' });
    expect(bad['metadata']).toBeUndefined();
    expect(validate(bad).ok, validate(bad).errors).toBe(true);
  });
});

describe('RFC 0205 §A — getArtifact over HTTP', () => {
  it('advertises the fixture and conversationPrimitive on the v2 root', async () => {
    const doc = (await (await fetch(`${base}/.well-known/openwop`, { headers: v2Headers(KEY_A) })).json()) as Json;
    expect(doc['fixtures']).toContain('conformance-artifact-emit');
    expect(doc['conversationPrimitive']).toMatchObject({ status: 'experimental', witness: 'claims-check' });
  });

  it('application/a2a+json → a schema-valid A2A Artifact whose artifactId is the path segment, Vary: Accept', async () => {
    const { runId, artifactId } = await emittedArtifact();
    const res = await fetch(artifactUrl(runId, artifactId), { headers: v2Headers(KEY_A, { Accept: `${A2A}, application/json;q=0.5` }) });
    expect(res.status).toBe(200);
    expect((res.headers.get('content-type') ?? '').split(';')[0]).toBe(A2A);
    expect(res.headers.get('vary') ?? '').toMatch(/accept/i);
    const body = (await res.json()) as Json;
    const r = v2('artifact')(body);
    expect(r.ok, r.errors).toBe(true);
    expect(body['artifactId']).toBe(artifactId);
    expect(body['parts']).toEqual([{ data: { title: 'Conformance brief', items: ['one', 'two'] }, mediaType: 'application/json' }]);
    expect(((body['metadata'] as Json)['openwop'] as Json)['artifactTypeId']).toBe('conformance.artifact.brief');
    expect(JSON.stringify(body), '§A.3 — no url Part is ever emitted').not.toContain('"url"');
  });

  it('application/json (or no preference) → the host-defined object', async () => {
    const { runId, artifactId } = await emittedArtifact();
    const res = await fetch(artifactUrl(runId, artifactId), { headers: v2Headers(KEY_A, { Accept: 'application/json' }) });
    expect(res.status).toBe(200);
    expect((res.headers.get('content-type') ?? '').split(';')[0]).toBe('application/json');
    const body = (await res.json()) as Json;
    expect(body).toMatchObject({ artifactId, artifactType: 'conformance.artifact.brief', mediaType: 'application/json', payload: { items: ['one', 'two'] } });
  });

  it('v1 does not negotiate (§A.4): an a2a preference still answers application/json', async () => {
    const { runId, artifactId } = await emittedArtifact();
    // v2 runIds are tenant-qualified (`<tenant>/<id>`); the v1 wire speaks the bare id.
    const bare = runId.slice(runId.lastIndexOf('/') + 1);
    const res = await fetch(artifactUrl(bare, artifactId, '/v1'), { headers: { Authorization: `Bearer ${KEY_A}`, Accept: A2A } });
    expect(res.status, await res.clone().text()).toBe(200);
    expect((res.headers.get('content-type') ?? '').split(';')[0]).toBe('application/json');
  });

  it('auth stacks above existence: 401 without a Bearer, 405 for a non-GET', async () => {
    const { runId, artifactId } = await emittedArtifact();
    expect((await fetch(artifactUrl(runId, artifactId), { headers: { 'OpenWOP-Version': '2' } })).status).toBe(401);
    const del = await fetch(artifactUrl(runId, artifactId), { method: 'DELETE', headers: v2Headers(KEY_A) });
    expect(del.status).toBe(405);
    // ADR 0755 (WIT-ART-9) — RFC 9110 §15.5.6: a 405 names what the resource supports.
    expect(del.headers.get('allow')).toBe('GET, HEAD');
    // (vendor-prefixed at major 2 — `method_not_allowed` is not a registered v2 code)
    expect(String(((await del.json()) as Json)['error'])).toMatch(/method_not_allowed$/);
    // …and HEAD, which it names, is served rather than refused.
    expect((await fetch(artifactUrl(runId, artifactId), { method: 'HEAD', headers: v2Headers(KEY_A) })).status).toBe(200);
  });

  it('ADR 0755 (WIT-ART-8) — an owk_ key without artifacts:read is refused 403 with the scope challenge; the control reads', async () => {
    const run2 = await emittedArtifact();
    const bare = run2.runId.slice(run2.runId.lastIndexOf('/') + 1);
    const key = async (scopes: string[]) => (await issueApiKey({ tenantId: 'ws3-tenant-a', name: 'wit-art-8', createdBy: 'user:wit-art-8', scopes })).token;
    const url = artifactUrl(bare, run2.artifactId, '/v1');
    const refused = await fetch(url, { headers: { Authorization: `Bearer ${await key(['runs:read'])}` } });
    expect(refused.status, await refused.clone().text()).toBe(403);
    expect(refused.headers.get('www-authenticate') ?? '').toMatch(/insufficient_scope/);
    expect(refused.headers.get('www-authenticate') ?? '').toMatch(/scope="artifacts:read"/);
    const ok = await fetch(url, { headers: { Authorization: `Bearer ${await key(['artifacts:read'])}` } });
    expect(ok.status, 'control: without it a host refusing every key passes the leg above').toBe(200);
  });

  it('ADR 0755 (WIT-ART-8) — the SSE ?streamToken grant does not open this door', async () => {
    const { runId, artifactId } = await emittedArtifact();
    const bare = runId.slice(runId.lastIndexOf('/') + 1);
    // A VALID stream token for the run, presented by another tenant's Bearer: if the
    // grant were honoured here the read would succeed; it is refused (streamToken:false)
    // and the tenant check answers the non-disclosing 404.
    const url = `${artifactUrl(bare, artifactId, '/v1')}?streamToken=${encodeURIComponent(mintRunStreamToken(bare))}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${KEY_B}` } });
    expect(res.status).toBe(404);
  });

  it('ADR 0755 (WIT-ART-1) — an announced row carries announcedType only, never a host artifactTypeId', async () => {
    const { artifactId } = await emittedArtifact();
    const row = await getRunArtifact(artifactId.slice('run-event:'.length));
    expect(row?.announcedType).toBe('conformance.artifact.brief');
    expect(row?.artifactTypeId, 'a conformance payload must never read as a typed Library deliverable').toBeUndefined();
  });

  it('another tenant never reads it: a bare id is a non-disclosing 404, a qualified one the ids.md 403 — neither challenges', async () => {
    const { runId, artifactId } = await emittedArtifact();
    const bare = runId.slice(runId.lastIndexOf('/') + 1);
    const asB = await fetch(artifactUrl(bare, artifactId), { headers: v2Headers(KEY_B, { Accept: A2A }) });
    expect(asB.status, await asB.clone().text()).toBe(404);
    expect(asB.headers.get('www-authenticate'), 'RFC 0200 §B.3 — a 404 carries no challenge').toBeNull();
    // The tenant segment of a qualified id is not the caller's: the id-kind rule
    // answers before any lookup, so nothing about the run is disclosed either way.
    const qualified = await fetch(artifactUrl(runId, artifactId), { headers: v2Headers(KEY_B, { Accept: A2A }) });
    expect(qualified.status).toBe(403);
    expect(((await qualified.json()) as Json)['error']).toBe('id_tenant_mismatch');
  });

  it('an id the run never announced is 404, even when a row exists under a sibling key', async () => {
    const { runId } = await emittedArtifact();
    expect((await fetch(artifactUrl(runId, `run-event:${runId}:nope`), { headers: v2Headers(KEY_A) })).status).toBe(404);
    // A malformed escape is a miss, not a 500.
    expect((await fetch(`${base}/runs/${encodeURIComponent(runId)}/artifacts/%E0`, { headers: v2Headers(KEY_A) })).status).toBe(404);
  });

  it('announcing is not owning: a run that announces ANOTHER run\'s artifact cannot read it', async () => {
    const { artifactId } = await emittedArtifact();
    const other = await runToCompletion('conformance-noop');
    // The log is keyed by the internal (bare) run id; the v2 wire id is tenant-qualified.
    await getEventLog().append({ runId: other.slice(other.lastIndexOf('/') + 1), nodeId: 'n', type: 'artifact.created', payload: { artifactId, artifactType: 'conformance.artifact.brief' } });
    // Control: the announcement IS visible to the reader — so the 404 below is
    // the ownership rule, not a missed scan.
    expect((await v2Events(other)).some((e) => e['type'] === 'artifact.created')).toBe(true);
    const res = await fetch(artifactUrl(other, artifactId), { headers: v2Headers(KEY_A, { Accept: A2A }) });
    expect(res.status, 'the row belongs to a different run in the same tenant').toBe(404);
  });
});

describe('RFC 0205 §B — the conversation fixture emits A2A-shaped turns', () => {
  it('every conversation.exchanged turn carries parts and validates against the v2 turn def', async () => {
    const runId = await runToCompletion('conformance-conversation-lifecycle');
    const turns = (await v2Events(runId))
      .filter((e) => e['type'] === 'conversation.exchanged')
      .map((e) => (e['payload'] as Json)['turn'] as Json);
    expect(turns.length).toBeGreaterThan(0);
    const validate = v2('conversation-turn');
    for (const t of turns) {
      expect(t['parts'], `turn ${String(t['messageId'])}`).toBeDefined();
      const r = validate(t);
      expect(r.ok, r.errors).toBe(true);
    }
  });
});

describe('RFC 0205 §A — a Documents-backed announcement reads through the ONE projection gate', () => {
  it('a member reads the version as a data Part payload; a non-member and an absent subject get nothing', async () => {
    const tenantId = `ws3-docs-${Date.now()}`;
    const orgId = `${tenantId}-org`;
    await createMember({ tenantId, orgId, subject: 'u-member', displayName: 'M', roles: ['viewer'] });
    const doc = await createDocument({ tenantId, orgId, title: 'SOW', kind: 'sow', provenance: { producedBy: { kind: 'run', id: 'r1' } }, createdBy: 'r1' });
    const v = await addVersion(tenantId, orgId, doc.documentId, { content: '# SOW', producedBy: { kind: 'run', id: 'r1' } });
    const run: RunRecord = { runId: 'r1', workflowId: 'w', tenantId, status: 'completed', inputs: {}, metadata: {}, configurable: {}, createdAt: '', updatedAt: '' };
    // The shape the documents `generate` node announces (packs/feature.documents.nodes).
    const events: EventRecord[] = [{
      eventId: 'e1', runId: 'r1', sequence: 1, type: 'artifact.created', nodeId: 'gen', timestamp: '',
      payload: { artifactId: v.versionId, artifactType: 'doc.sow', documentId: doc.documentId, versionId: v.versionId },
    }];
    const storage = logReader(events, run);
    const read = (subject: string | undefined) => resolveRunArtifact({ storage, run, artifactId: v.versionId, subject });

    const got = await read('u-member');
    expect(got?.body).toEqual({ kind: 'data', data: { content: '# SOW', title: 'SOW', kind: 'sow', documentId: doc.documentId } });
    expect(got?.artifactType).toBe('doc.sow');
    expect(await read('u-stranger'), 'the org membership gate applies at this door too').toBeNull();
    expect(await read(undefined), 'fail-closed: no subject is never read as the tenant owner').toBeNull();

    // ADR 0755 (WIT-ART-5) — announcing is not owning on this lane either: a
    // version ANOTHER run produced, announced by r1, is not r1's artifact.
    const foreign = await addVersion(tenantId, orgId, doc.documentId, { content: '# other', producedBy: { kind: 'run', id: 'r-other' } });
    const foreignEvents: EventRecord[] = [{ ...events[0]!, payload: { artifactId: foreign.versionId, artifactType: 'doc.sow', documentId: doc.documentId, versionId: foreign.versionId } }];
    const foreignRead = await resolveRunArtifact({ storage: logReader(foreignEvents, run), run, artifactId: foreign.versionId, subject: 'u-member' });
    expect(foreignRead, 'a member can read the doc, but r1 did not produce this version').toBeNull();
  });
});

/** An in-memory `findFirstEventByPayload` + `getRun` — the two reads `resolveRunArtifact` makes (ADR 0754). */
function logReader(events: EventRecord[], run: RunRecord) {
  return {
    findFirstEventByPayload: async (_runId: string, type: string, key: string, value: string) =>
      events.find((e) => e.type === type && (e.payload as Record<string, unknown> | null)?.[key] === value) ?? null,
    getRun: async () => run,
  };
}
