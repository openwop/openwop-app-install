/**
 * ADR 0853 D1 — decision suggestions.
 *   - created bounded + redacted, idempotent per (project, source kind, ref);
 *     at most 50 open per project (the 51st is refused, not queued);
 *   - listed to readers; dismissed by writers (a reader 403; a foreign or closed
 *     one 404);
 *   - "Record" from a suggestion marks it recorded (with the document) and takes
 *     it off the open list; recording a closed one is a 404 and writes nothing;
 *   - erasure (a person-suggested text, a decider) and the project-delete cascade.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getSetCookies } from './headerCookies.js';
import { createApp } from '../src/index.js';
import { createMember } from '../src/host/accessControlService.js';
import { ERASED } from '../src/host/subjectErasureRedaction.js';
import { listDeltas, getLedger } from '../src/features/team-intent-ledger/ledgerStore.js';
import {
  countSuggestionsForProject, createSuggestion, deleteSuggestionsForProject, eraseSuggestionSubject, getSuggestion, SUGGESTION_LIMITS,
} from '../src/features/team-intent-ledger/suggestions.js';

let BASE: string;
let server: http.Server;
let n = 0;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

function client() {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]!; }
    return { status: res.status, body: res.status === 204 ? undefined : await res.json().catch(() => undefined) as any };
  };
  return { get: (p: string) => call('GET', p), post: (p: string, b?: unknown) => call('POST', p, b) };
}
const email = (who: string): string => `${who}-${Date.now()}-${n++}@acme.test`;

async function setup() {
  const tenantId = `org:sg-${Date.now()}-${n++}`;
  const owner = client();
  const ownerId = (await owner.post('/host/openwop-app/test/login', { email: email('sg-owner'), tenantId })).body.user.userId as string;
  const orgId = (await owner.post('/host/openwop-app/orgs', { name: 'SuggCo' })).body.orgId as string;
  const proj = (await owner.post('/host/openwop-app/projects', { orgId, name: 'Launch' })).body as { id: string };
  const L = `/host/openwop-app/team-ledger/projects/${proj.id}`;
  expect((await owner.post(L)).status).toBe(201);
  const viewer = client();
  const viewerId = (await viewer.post('/host/openwop-app/test/login', { email: email('sg-viewer'), tenantId })).body.user.userId as string;
  await createMember({ tenantId, orgId, subject: viewerId, displayName: 'V', roles: ['viewer'] });
  return { tenantId, orgId, owner, ownerId, viewer, viewerId, projectId: proj.id, L };
}
const suggest = (s: { tenantId: string; projectId: string }, ref: string, over: Record<string, unknown> = {}) =>
  createSuggestion({ tenantId: s.tenantId, projectId: s.projectId, title: 'Ship EU first', text: 'We agreed to ship the EU first.', source: { kind: 'message', ref, link: '/chat?conversation=c1' }, suggestedBy: { kind: 'agent', id: 'suggester' }, ...over });

describe('ADR 0853 D1 — suggestions', () => {
  it('idempotent per source; bounded and redacted; the 51st open one is refused', async () => {
    const s = await setup();
    const a = await suggest(s, 'm1');
    expect(await suggest(s, 'm1')).toEqual(a);
    const long = await suggest(s, 'm-long', { text: `${'x'.repeat(2000)} sk-ant-${'k'.repeat(48)}` });
    expect(long!.text.length).toBeLessThanOrEqual(SUGGESTION_LIMITS.text);
    expect(long!.text).not.toMatch(/sk-ant-k{20}/);
    const evil = await suggest(s, 'm-evil', { source: { kind: 'message', ref: 'm-evil', link: 'javascript:alert(1)' } });
    expect(evil!.source.link).toBeUndefined();
    for (let i = 0; i < SUGGESTION_LIMITS.open - 3; i++) expect(await suggest(s, `fill-${i}`)).not.toBeNull();
    expect(await suggest(s, 'one-too-many')).toBeNull();
  });

  it('readers list; writers dismiss; a reader cannot; a closed or foreign one is a 404', async () => {
    const s = await setup();
    const a = (await suggest(s, 'm1'))!;
    const list = await s.viewer.get(`${s.L}/suggestions`);
    expect(list.status).toBe(200);
    expect(list.body.suggestions.map((x: any) => x.suggestionId)).toEqual([a.suggestionId]);
    expect((await s.viewer.post(`${s.L}/suggestions/${a.suggestionId}/dismiss`)).status).toBe(403);
    const d = await s.owner.post(`${s.L}/suggestions/${a.suggestionId}/dismiss`);
    expect(d.status).toBe(200);
    expect(d.body.suggestion).toMatchObject({ status: 'dismissed', decidedBy: s.ownerId });
    expect((await s.owner.post(`${s.L}/suggestions/${a.suggestionId}/dismiss`)).status).toBe(404);
    const other = await setup();
    const b = (await suggest(other, 'm2'))!;
    expect((await s.owner.post(`${s.L}/suggestions/${b.suggestionId}/dismiss`)).status).toBe(404);
    expect((await s.owner.get(`${s.L}/suggestions`)).body.suggestions).toEqual([]);
  });

  it('Record from a suggestion marks it recorded; recording a closed one writes nothing', async () => {
    const s = await setup();
    const a = (await suggest(s, 'm1'))!;
    const r = await s.owner.post(`${s.L}/decisions`, { title: a.title, decision: a.text, source: a.source, suggestionId: a.suggestionId });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(await getSuggestion(s.tenantId, a.suggestionId)).toMatchObject({ status: 'recorded', documentId: r.body.documentId, decidedBy: s.ownerId });
    expect((await s.owner.get(`${s.L}/suggestions`)).body.suggestions).toEqual([]);
    const ledger = (await getLedger(s.tenantId, s.projectId))!;
    const before = (await listDeltas(s.tenantId, ledger.ledgerId)).length;
    const again = await s.owner.post(`${s.L}/decisions`, { title: a.title, decision: a.text, suggestionId: a.suggestionId });
    expect(again.status).toBe(404);
    expect((await listDeltas(s.tenantId, ledger.ledgerId)).length).toBe(before);
  });

  it('erasure redacts a person-suggested text and a decider; the project delete takes them', async () => {
    const s = await setup();
    const mine = (await suggest(s, 'p1', { suggestedBy: { kind: 'user', id: s.viewerId } }))!;
    const theirs = (await suggest(s, 'p2'))!;
    await s.owner.post(`${s.L}/suggestions/${theirs.suggestionId}/dismiss`);
    await eraseSuggestionSubject(s.tenantId, `user:${s.viewerId}`);
    expect(await getSuggestion(s.tenantId, mine.suggestionId)).toMatchObject({ text: ERASED, title: ERASED, suggestedBy: { id: ERASED } });
    await eraseSuggestionSubject(s.tenantId, `user:${s.ownerId}`);
    expect((await getSuggestion(s.tenantId, theirs.suggestionId))!.decidedBy).toBe(ERASED);
    expect((await getSuggestion(s.tenantId, theirs.suggestionId))!.text).not.toBe(ERASED); // an agent's text is not the person's
    expect(await countSuggestionsForProject(s.tenantId, s.projectId)).toBe(2);
    expect(await deleteSuggestionsForProject(s.tenantId, s.projectId)).toBe(2);
    expect(await countSuggestionsForProject(s.tenantId, s.projectId)).toBe(0);
  });
});
