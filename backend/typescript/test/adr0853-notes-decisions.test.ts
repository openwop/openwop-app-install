/**
 * ADR 0853 D7 — `Decision:` lines in a project's documents (meeting notes) become
 * decision suggestions. Real app, real documents routes, the real version seam:
 *   - a new `Decision:` line in a PROJECT-owned document ⇒ one suggestion each,
 *     `source.kind:'meeting'`, linked to the document, suggested by the writer;
 *   - only lines NEW in this version count, so a long notes document keeps
 *     filing past the per-save cap; re-adding a line is idempotent (same ref);
 *   - an org-level document, a project with no ledger, or a decision record ⇒ nothing;
 *   - the parser takes list markers / bold and ignores "decisions" in prose.
 *
 * TST-BWD-4 (grade-tests w62): red when a decision record files, when a ledger-less
 * project files, when every line (not just new ones) counts toward the per-save cap, when
 * numbered lines stop parsing, or when the suggestion loses its writer or its link.
 * TWO RECORDED DOUBLE GUARDS: (1) "only new lines count" in the first case is also held by
 * `createSuggestion`'s ref idempotency (same document + same text ⇒ same ref), so the
 * before-filter is witnessed by the cap case, not that one; (2) an org-level document files
 * nothing even without the `ownerSubject` check, because `e.ownerSubject.id` then throws and
 * the observer runner (`host/documentVersionObservers.ts`) catches it — the leg stays green
 * either way, and the decision-record half of the same case is the witnessed one.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getSetCookies } from './headerCookies.js';
import { createApp } from '../src/index.js';
import { listSuggestions } from '../src/features/team-intent-ledger/suggestions.js';
import { decisionLines, MAX_PER_VERSION } from '../src/features/team-intent-ledger/notesSource.js';

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
    const payload = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    return { status: res.status, body: (payload ?? {}) as { user?: { userId: string }; orgId?: string; id?: string; documentId?: string } };
  };
  return { post: (p: string, b?: unknown) => call('POST', p, b) };
}
async function setup(opts: { ledger?: boolean } = {}) {
  const tenantId = `org:d7-${Date.now()}-${n++}`;
  const owner = client();
  const ownerId = (await owner.post('/host/openwop-app/test/login', { email: `d7-${n++}@acme.test`, tenantId })).body.user!.userId;
  const orgId = (await owner.post('/host/openwop-app/orgs', { name: 'NotesCo' })).body.orgId!;
  const proj = { id: (await owner.post('/host/openwop-app/projects', { orgId, name: 'Launch' })).body.id! };
  if (opts.ledger !== false) expect((await owner.post(`/host/openwop-app/team-ledger/projects/${proj.id}`)).status).toBe(201);
  const D = `/host/openwop-app/documents/orgs/${encodeURIComponent(orgId)}/documents`;
  const doc = async (owned: boolean, kind = 'brief'): Promise<string> => {
    const r = await owner.post(D, { title: 'Kickoff notes', kind, format: 'markdown', ...(owned ? { ownerSubject: { kind: 'project', id: proj.id } } : {}) });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return r.body.documentId!;
  };
  const save = async (documentId: string, content: string) => {
    const r = await owner.post(`${D}/${encodeURIComponent(documentId)}/versions`, { content });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
  };
  return { tenantId, ownerId, projectId: proj.id, doc, save };
}

describe('ADR 0853 D7 — Decision: lines in project documents', () => {
  it('a new Decision: line ⇒ one suggestion, linked to the document, by its writer; only new lines count', async () => {
    const s = await setup();
    const id = await s.doc(true);
    await s.save(id, '# Kickoff\nAttendees: Ana, Bo\n- Decision: Ship the EU first\nWe discussed decisions about pricing.\n');
    let list = await listSuggestions(s.tenantId, s.projectId);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      title: 'Ship the EU first', source: { kind: 'meeting', link: `/documents/${encodeURIComponent(id)}` },
      suggestedBy: { kind: 'user', id: s.ownerId },
    });
    expect(list[0]!.text).toContain('Kickoff notes');
    // Editing the rest, plus one new decision: only the new one is filed.
    await s.save(id, '# Kickoff (edited)\nAttendees: Ana, Bo, Cy\n- Decision: Ship the EU first\n**Decision:** Price Pro at €49\n');
    list = await listSuggestions(s.tenantId, s.projectId);
    expect(list.map((x) => x.title).sort()).toEqual(['Price Pro at €49', 'Ship the EU first']);
    // Removing then re-adding a line is idempotent (same document + same text).
    await s.save(id, '# Kickoff\n');
    await s.save(id, '- Decision: Ship the EU first\n');
    expect(await listSuggestions(s.tenantId, s.projectId)).toHaveLength(2);
  });

  it('the per-save cap counts only NEW lines, so a document past the cap keeps filing', async () => {
    const s = await setup();
    const id = await s.doc(true);
    const lines = Array.from({ length: MAX_PER_VERSION }, (_, i) => `Decision: Item ${i + 1}`);
    await s.save(id, lines.join('\n'));
    expect(await listSuggestions(s.tenantId, s.projectId)).toHaveLength(MAX_PER_VERSION);
    await s.save(id, [...lines, 'Decision: The one after the cap'].join('\n'));
    expect((await listSuggestions(s.tenantId, s.projectId)).map((x) => x.title)).toContain('The one after the cap');
  });

  it('nothing for an org-level document, a project with no ledger, or a decision record', async () => {
    const a = await setup();
    await a.save(await a.doc(false), 'Decision: Not a project doc\n');
    await a.save(await a.doc(true, 'decision-record'), 'Decision: A record already\n');
    expect(await listSuggestions(a.tenantId, a.projectId)).toHaveLength(0);
    const b = await setup({ ledger: false });
    await b.save(await b.doc(true), 'Decision: No ledger yet\n');
    expect(await listSuggestions(b.tenantId, b.projectId)).toHaveLength(0);
  });

  it('the parser: list markers, numbering and bold are accepted; prose mentioning decisions is not', () => {
    expect(decisionLines([
      'Decision: A', '- decision: B', '* DECISION — C', '1. Decision: D', '**Decision:** E', '**Decision**: F',
      'We made a decision: not this', 'Decisions: not this either', 'decision:', 'Decision: A',
    ].join('\n'))).toEqual(['A', 'B', 'C', 'D', 'E', 'F']);
  });
});
