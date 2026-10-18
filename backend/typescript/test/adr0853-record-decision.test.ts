/**
 * ADR 0853 D2 — "Record as decision".
 *   - a writer records: a `decision-record` Document owned by the project, with a
 *     structured link back to its source; a PROPOSED delta adds it; the version
 *     does not move;
 *   - the OWNER with `accept: true` accepts in the same call (version + 1, the
 *     decision is on the ledger); anyone else's `accept` only proposes;
 *   - refused: a reader (403), no ledger (404), a link that is not an in-app path
 *     or https (javascript:, protocol-relative), a secret-shaped decision, an
 *     over-long title, an unknown source kind — each with its own error code and
 *     field, and none of them writes a delta or a decision.
 *
 * Sabotage-witnessed (/grade-tests w29): a non-owner's accept accepting
 * (`decisions.ts` owner check — the only guard, `acceptDelta` does not check)
 * reds case 1; the route's write gate relaxed to read, the link predicate
 * admitting `//` or `http:`, the title limit raised, the secret / source-kind
 * checks dropped each red case 3. The over-long title is spaced: an unbroken
 * 161-char blob is refused as SECRET-shaped first, which hid the limit (probe
 * w29g3-rd-title-limit was vacuous).
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getSetCookies } from './headerCookies.js';
import { createApp } from '../src/index.js';
import { createMember } from '../src/host/accessControlService.js';
import { getDocument } from '../src/features/documents/documentsService.js';
import { getLedger, listDeltas } from '../src/features/team-intent-ledger/ledgerStore.js';

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

/** The fields these legs read off a response. Each leg asserts the status first. */
interface ResBody {
  user?: { userId: string }; orgId?: string; id?: string;
  accepted?: boolean; documentId?: string; delta?: unknown;
  ledger?: { version: number }; state?: { decisionDocumentIds: string[] };
  error?: string; details?: { field?: string; limit?: number };
}
function client() {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: ResBody }> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]!; }
    const parsed = res.status === 204 ? undefined : ((await res.json().catch(() => undefined)) as ResBody | undefined);
    return { status: res.status, body: parsed ?? {} };
  };
  return { get: (p: string) => call('GET', p), post: (p: string, b?: unknown) => call('POST', p, b) };
}
const email = (who: string): string => `${who}-${Date.now()}-${n++}@acme.test`;

async function setup(opts: { ledger?: boolean } = {}) {
  const tenantId = `org:rd-${Date.now()}-${n++}`;
  const owner = client();
  const ownerId = (await owner.post('/host/openwop-app/test/login', { email: email('rd-owner'), tenantId })).body.user!.userId;
  const orgId = (await owner.post('/host/openwop-app/orgs', { name: 'DecideCo' })).body.orgId!;
  const proj = { id: (await owner.post('/host/openwop-app/projects', { orgId, name: 'Launch' })).body.id! };
  const L = `/host/openwop-app/team-ledger/projects/${proj.id}`;
  if (opts.ledger !== false) expect((await owner.post(L)).status).toBe(201);
  const mate = client();
  const mateId = (await mate.post('/host/openwop-app/test/login', { email: email('rd-mate'), tenantId })).body.user!.userId;
  await createMember({ tenantId, orgId, subject: mateId, displayName: 'Mate', roles: ['editor'] });
  const viewer = client();
  const viewerId = (await viewer.post('/host/openwop-app/test/login', { email: email('rd-viewer'), tenantId })).body.user!.userId;
  await createMember({ tenantId, orgId, subject: viewerId, displayName: 'View', roles: ['viewer'] });
  return { tenantId, orgId, owner, ownerId, mate, viewer, projectId: proj.id, L };
}
const DECISION = { title: 'Launch EU first', decision: 'We launch in the EU before the US.', rationale: 'Legal is ready there.', source: { kind: 'message', ref: 'msg-123', link: '/chat?conversation=c1' } };

describe('ADR 0853 D2 — record a decision', () => {
  it('a writer records: a linked decision record and a PROPOSED delta; the version does not move', async () => {
    const s = await setup();
    const r = await s.mate.post(`${s.L}/decisions`, { ...DECISION, accept: true }); // a non-owner's accept only proposes
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.accepted).toBe(false);
    expect(r.body.delta).toMatchObject({ status: 'proposed', source: { kind: 'message', ref: 'msg-123' }, patch: { decisionDocumentIds: [r.body.documentId] } });
    const doc = (await getDocument(s.tenantId, s.orgId, r.body.documentId!))!;
    expect(doc).toMatchObject({ kind: 'decision-record', title: 'Decision — Launch EU first', ownerSubject: { kind: 'project', id: s.projectId } });
    expect(doc.provenance.source).toEqual(DECISION.source);
    expect((await s.owner.get(s.L)).body.ledger!.version).toBe(1);
  });

  it('the owner accepts in the same call: version + 1, the decision is on the ledger', async () => {
    const s = await setup();
    const r = await s.owner.post(`${s.L}/decisions`, { ...DECISION, accept: true });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.accepted).toBe(true);
    const g = (await s.owner.get(s.L)).body;
    expect(g.ledger!.version).toBe(2);
    expect(g.state!.decisionDocumentIds).toEqual([r.body.documentId]);
  });

  it('refused: a reader, no ledger, unsafe links, secret-shaped text, over-long title, unknown source', async () => {
    const s = await setup();
    const ledger = (await getLedger(s.tenantId, s.projectId))!;
    const deltasBefore = (await listDeltas(s.tenantId, ledger.ledgerId)).length; // the creation delta
    const refused = async (c: ReturnType<typeof client>, body: unknown, status: number, error: string, details?: Record<string, unknown>, label = '') => {
      const r = await c.post(`${s.L}/decisions`, body);
      expect(r.status, `${label} ${JSON.stringify(r.body)}`).toBe(status);
      expect(r.body.error, label).toBe(error);
      if (details) expect(r.body.details, label).toMatchObject(details);
    };
    await refused(s.viewer, DECISION, 403, 'forbidden_scope', undefined, 'viewer');
    for (const link of ['javascript:alert(1)', '//evil.example', 'http://plain.example', 'chat']) {
      await refused(s.owner, { ...DECISION, source: { ...DECISION.source, link } }, 400, 'validation_error', { field: 'source.link' }, link);
    }
    await refused(s.owner, { ...DECISION, decision: `use key sk-ant-${'a'.repeat(48)}` }, 400, 'validation_error', { field: 'decision' }, 'secret');
    // Spaced, so it is too LONG rather than secret-shaped (an unbroken blob is refused as a secret first).
    await refused(s.owner, { ...DECISION, title: 'ab '.repeat(54) }, 400, 'validation_error', { field: 'title', limit: 160 }, 'title');
    await refused(s.owner, { ...DECISION, source: { kind: 'rumor', ref: 'x' } }, 400, 'validation_error', { field: 'source.kind' }, 'kind');
    // None of the refusals wrote anything.
    expect((await getLedger(s.tenantId, s.projectId))!.version).toBe(1);
    expect(await listDeltas(s.tenantId, ledger.ledgerId)).toHaveLength(deltasBefore);
    expect((await s.owner.get(s.L)).body.state!.decisionDocumentIds).toEqual([]);
    const t = await setup({ ledger: false });
    const none = await t.owner.post(`${t.L}/decisions`, DECISION);
    expect(none.status).toBe(404);
    expect(none.body.error).toBe('not_found');
  });
});
