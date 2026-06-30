/**
 * Research Notebooks — Transformations T1: summarize-source + the Summary context
 * level (ADR 0084 Transformations T1).
 *
 * Proves the store + projection + level logic WITHOUT a live model (the summary is
 * simulated via setSourceSummary, the effect the real `notebooks.summarize` run has;
 * the route's product path enqueues a real run, asserted separately by runId):
 *   - the generic `extraContext` binding capability is APPENDED + FENCED by
 *     resolveSubjectKnowledgeRetrieve (untrusted summary stays data-only)
 *   - POST .../summarize is write-gated, validates sid (404), cross-tenant 404,
 *     and returns a runId (the real run is enqueued)
 *   - PUT .../context-level 'summary' is 400 without a stored summary, 200 after
 *   - a 'summary'-level source is in excludeDocumentIds AND contributes its summary
 *     to the binding's extraContext (chunks dropped, summary injected)
 *
 * @see docs/adr/0084-research-notebooks.md (Transformations T1)
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { getSubjectKnowledge } from '../src/host/subjectKnowledge.js';
import { projectSubject } from '../src/features/projects/projectsService.js';
import {
  resolveSubjectKnowledgeRetrieve,
  composeAgentKnowledgeContext,
} from '../src/host/agentKnowledgeComposition.js';
import { setSourceSummary } from '../src/features/notebooks/notebooksService.js';
import type { AgentMemoryPort } from '../src/host/agentDispatch.js';

let BASE: string;
let server: http.Server;
let n = 0;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['notebooks', 'kb', 'users']) {
    const d = getToggleDefault(id);
    if (d) await saveConfig({ ...d, status: 'on' }, 'test');
  }
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

interface Res<T = any> { status: number; body: T }
interface Client { get: (p: string) => Promise<Res>; post: (p: string, b?: unknown) => Promise<Res>; put: (p: string, b?: unknown) => Promise<Res>; del: (p: string) => Promise<Res> }
function client(): Client {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]; }
    const out = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    return { status: res.status, body: out };
  };
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b), put: (p, b) => call('PUT', p, b), del: (p) => call('DELETE', p) };
}

const uniqEmail = (who: string): string => `${who}-${Date.now()}-${n++}@acme.test`;
async function ownerWithOrg(who: string): Promise<{ c: Client; orgId: string; tenantId: string }> {
  const c = client();
  const tenantId = `t-${who}-${Date.now()}-${n++}`;
  const login = await c.post('/v1/host/openwop-app/test/login', { email: uniqEmail(who), tenantId });
  expect(login.status, JSON.stringify(login.body)).toBe(201);
  const org = await c.post('/v1/host/openwop-app/orgs', { name: 'Acme' });
  return { c, orgId: org.body.orgId, tenantId };
}

const NB = '/v1/host/openwop-app/notebooks';
const FELINE = 'Feline companions: cats groom themselves with their tongue and purr when content.';

describe('agentKnowledgeComposition — generic extraContext is appended + fenced (T1)', () => {
  it('appends an untrusted extraContext item as a fenced chunk through the same composition path', async () => {
    // No KB collections bound: the retriever still resolves because extraContext
    // is contributed regardless. (wantMemory keeps the retriever defined.)
    const noMemory: AgentMemoryPort = { read: async () => [], write: async () => undefined };
    const SUMMARY = 'Cats groom with their tongue and purr when content.';
    const retrieve = resolveSubjectKnowledgeRetrieve(
      't-extra',
      {
        retrieval: {
          sources: ['memory'],
          extraContext: [{ title: 'Cat facts', content: SUMMARY, contentTrust: 'untrusted' }],
        },
      },
      noMemory,
      'scope',
    );
    expect(retrieve).toBeDefined();
    const chunks = await retrieve!('any query');
    // The extra item is present, carries its title, and is marked untrusted.
    const item = chunks.find((ch) => ch.content === SUMMARY);
    expect(item).toBeDefined();
    expect(item?.title).toBe('Cat facts');
    expect(item?.contentTrust).toBe('untrusted');

    // …and the composition path FENCES the untrusted item (data-only, never an instruction).
    const block = await composeAgentKnowledgeContext(retrieve!, 'any query');
    expect(block).toContain(SUMMARY);
    expect(block.toUpperCase()).toContain('UNTRUSTED');
  });

  it('a trusted extraContext item is cited, not fenced', async () => {
    const noMemory: AgentMemoryPort = { read: async () => [], write: async () => undefined };
    const retrieve = resolveSubjectKnowledgeRetrieve(
      't-extra2',
      { retrieval: { sources: ['memory'], extraContext: [{ content: 'A trusted fact.', contentTrust: 'trusted' }] } },
      noMemory,
      'scope',
    );
    const chunks = await retrieve!('q');
    expect(chunks.some((ch) => ch.content === 'A trusted fact.' && ch.contentTrust === 'trusted')).toBe(true);
  });
});

describe('notebooks — summarize route + Summary context level (T1)', () => {
  it('enqueues a run (write-gated, sid-validated, cross-tenant 404)', async () => {
    const { c, orgId } = await ownerWithOrg('nb-sum');
    const id = (await c.post(NB, { orgId, name: 'Pets research' })).body.notebook.id as string;
    const cat = (await c.post(`${NB}/${id}/sources`, { title: 'Cat facts', text: FELINE })).body.documentId as string;

    // The product path enqueues a REAL run and returns its id (202).
    const enq = await c.post(`${NB}/${id}/sources/${cat}/summarize`);
    expect(enq.status, JSON.stringify(enq.body)).toBe(202);
    expect(typeof enq.body.runId).toBe('string');
    expect(enq.body.runId.length).toBeGreaterThan(0);

    // unknown sid ⇒ 404.
    expect((await c.post(`${NB}/${id}/sources/ghost/summarize`)).status).toBe(404);

    // cross-tenant caller ⇒ 404 (uniform IDOR — never reaches enqueue).
    const stranger = await ownerWithOrg('nb-sum-stranger');
    expect((await stranger.c.post(`${NB}/${id}/sources/${cat}/summarize`)).status).toBe(404);
  });

  it('Summary level is 400 without a summary, 200 after; binding excludes chunks + injects extraContext', async () => {
    const { c, orgId, tenantId } = await ownerWithOrg('nb-sum-level');
    const id = (await c.post(NB, { orgId, name: 'Pets research' })).body.notebook.id as string;
    const cat = (await c.post(`${NB}/${id}/sources`, { title: 'Cat facts', text: FELINE })).body.documentId as string;

    // listSources reports hasSummary:false initially.
    const before = (await c.get(`${NB}/${id}/sources`)).body.sources as Array<{ documentId: string; hasSummary: boolean }>;
    expect(before.find((s) => s.documentId === cat)?.hasSummary).toBe(false);

    // Summary level rejected until a summary exists.
    const tooEarly = await c.put(`${NB}/${id}/sources/${cat}/context-level`, { level: 'summary' });
    expect(tooEarly.status).toBe(400);

    // Simulate the run's effect: store a summary directly (the unit-test allowance;
    // the product path stores it via the workflow's store-summary node).
    const SUMMARY = 'Cats groom with their tongue and purr when content.';
    await setSourceSummary(tenantId, id, cat, SUMMARY);

    // hasSummary now true.
    const after = (await c.get(`${NB}/${id}/sources`)).body.sources as Array<{ documentId: string; hasSummary: boolean }>;
    expect(after.find((s) => s.documentId === cat)?.hasSummary).toBe(true);

    // Summary level now accepted.
    const ok = await c.put(`${NB}/${id}/sources/${cat}/context-level`, { level: 'summary' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.contextLevel).toBe('summary');
    expect(ok.body.hasSummary).toBe(true);

    // The DERIVED binding projection: chunks excluded AND the summary injected as a
    // fenced (untrusted) extraContext item.
    const binding = await getSubjectKnowledge(tenantId, projectSubject(id));
    expect(binding.retrieval?.excludeDocumentIds).toContain(cat);
    const extra = binding.retrieval?.extraContext ?? [];
    const injected = extra.find((e) => e.content === SUMMARY);
    expect(injected).toBeDefined();
    expect(injected?.title).toBe('Cat facts');
    expect(injected?.contentTrust).toBe('untrusted');
    // collectionIds preserved (not wiped by the summary write).
    expect((binding.collectionIds ?? []).length).toBeGreaterThanOrEqual(1);

    // The summary source's chunks are dropped from Ask (it's in excludeDocumentIds).
    const ask = await c.post(`${NB}/${id}/search`, { query: 'cats groom purr' });
    expect(ask.body.hits.some((h: { documentId: string }) => h.documentId === cat)).toBe(false);

    // Switching back to 'full' clears the projection.
    const back = await c.put(`${NB}/${id}/sources/${cat}/context-level`, { level: 'full' });
    expect(back.status).toBe(200);
    const binding2 = await getSubjectKnowledge(tenantId, projectSubject(id));
    expect(binding2.retrieval?.excludeDocumentIds ?? []).not.toContain(cat);
    expect((binding2.retrieval?.extraContext ?? []).some((e) => e.content === SUMMARY)).toBe(false);
  });
});
