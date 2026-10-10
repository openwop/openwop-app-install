/**
 * ADR 0853 D2 — "Record as decision".
 *   - a writer records: a `decision-record` Document owned by the project, with a
 *     structured link back to its source; a PROPOSED delta adds it; the version
 *     does not move;
 *   - the OWNER with `accept: true` accepts in the same call (version + 1, the
 *     decision is on the ledger); anyone else's `accept` only proposes;
 *   - refused: a reader (403), no ledger (404), a link that is not an in-app path
 *     or https (javascript:, protocol-relative), a secret-shaped decision, an
 *     over-long title, an unknown source kind.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getSetCookies } from './headerCookies.js';
import { createApp } from '../src/index.js';
import { createMember } from '../src/host/accessControlService.js';
import { getDocument } from '../src/features/documents/documentsService.js';

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

async function setup(opts: { ledger?: boolean } = {}) {
  const tenantId = `org:rd-${Date.now()}-${n++}`;
  const owner = client();
  const ownerId = (await owner.post('/host/openwop-app/test/login', { email: email('rd-owner'), tenantId })).body.user.userId as string;
  const orgId = (await owner.post('/host/openwop-app/orgs', { name: 'DecideCo' })).body.orgId as string;
  const proj = (await owner.post('/host/openwop-app/projects', { orgId, name: 'Launch' })).body as { id: string };
  const L = `/host/openwop-app/team-ledger/projects/${proj.id}`;
  if (opts.ledger !== false) expect((await owner.post(L)).status).toBe(201);
  const mate = client();
  const mateId = (await mate.post('/host/openwop-app/test/login', { email: email('rd-mate'), tenantId })).body.user.userId as string;
  await createMember({ tenantId, orgId, subject: mateId, displayName: 'Mate', roles: ['editor'] });
  const viewer = client();
  const viewerId = (await viewer.post('/host/openwop-app/test/login', { email: email('rd-viewer'), tenantId })).body.user.userId as string;
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
    const doc = (await getDocument(s.tenantId, s.orgId, r.body.documentId))!;
    expect(doc).toMatchObject({ kind: 'decision-record', title: 'Decision — Launch EU first', ownerSubject: { kind: 'project', id: s.projectId } });
    expect(doc.provenance.source).toEqual(DECISION.source);
    expect((await s.owner.get(s.L)).body.ledger.version).toBe(1);
  });

  it('the owner accepts in the same call: version + 1, the decision is on the ledger', async () => {
    const s = await setup();
    const r = await s.owner.post(`${s.L}/decisions`, { ...DECISION, accept: true });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.accepted).toBe(true);
    const g = (await s.owner.get(s.L)).body;
    expect(g.ledger.version).toBe(2);
    expect(g.state.decisionDocumentIds).toEqual([r.body.documentId]);
  });

  it('refused: a reader, no ledger, unsafe links, secret-shaped text, over-long title, unknown source', async () => {
    const s = await setup();
    expect((await s.viewer.post(`${s.L}/decisions`, DECISION)).status).toBe(403);
    for (const link of ['javascript:alert(1)', '//evil.example', 'http://plain.example', 'chat']) {
      expect((await s.owner.post(`${s.L}/decisions`, { ...DECISION, source: { ...DECISION.source, link } })).status, link).toBe(400);
    }
    expect((await s.owner.post(`${s.L}/decisions`, { ...DECISION, decision: `use key sk-ant-${'a'.repeat(48)}` })).status).toBe(400);
    expect((await s.owner.post(`${s.L}/decisions`, { ...DECISION, title: 'x'.repeat(161) })).status).toBe(400);
    expect((await s.owner.post(`${s.L}/decisions`, { ...DECISION, source: { kind: 'rumor', ref: 'x' } })).status).toBe(400);
    const t = await setup({ ledger: false });
    expect((await t.owner.post(`${t.L}/decisions`, DECISION)).status).toBe(404);
  });
});
