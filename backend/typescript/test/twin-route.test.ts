/**
 * Digital twin — Phase 1 (ADR 0044) ROUTE harness. Boots the real app and drives
 * the link + consent-grant surface:
 *   - toggle gating (404 when `twin-recall` is off)
 *   - admin links an agent to a user (workspace:write + tenant IDOR); a viewer can't
 *   - ONLY the linked user can grant/revoke (a non-linked caller is 404, fail-closed)
 *   - grant → visible to the user + on the agent link; revoke → gone
 *   - unlink revokes the grant
 *
 * Phase 1 has NO cross-subject recall — this proves only the authorization layer.
 *
 * @see docs/adr/0044-twin-cross-subject-recall.md
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { resolveBorrowedRecall } from '../src/features/twin/borrowedRecall.js';
import { __hostExtStorage } from '../src/host/hostExtPersistence.js';
import { setProfileKnowledge } from '../src/features/profiles/profilesService.js';
import { getKnowledgeBackend, setKnowledgeBackend } from '../src/host/knowledgeSurface.js';

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
  for (const id of ['users', 'twin-recall']) {
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
const enable = async (id: string, status: 'on' | 'off'): Promise<void> => { const d = getToggleDefault(id); if (d) await saveConfig({ ...d, status }, 'test'); };

/** Owner (admin) + a member (the prospective twin) in one tenant, + a standing agent. */
async function ownerMemberAgent(role = 'editor'): Promise<{ owner: Client; member: Client; memberId: string; rosterId: string; tenantId: string }> {
  const tenantId = `org:tw-${Date.now()}-${n++}`;
  const owner = client();
  await owner.post('/v1/host/openwop-app/test/login', { email: uniqEmail('tw-owner'), tenantId });
  const member = client();
  const m = await member.post('/v1/host/openwop-app/test/login', { email: uniqEmail('tw-member'), tenantId });
  const r = await owner.post('/v1/host/openwop-app/roster', { persona: 'Aide', agentRef: { agentId: 'core.openwop.agents.brief-writer' } });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  const org = await owner.post('/v1/host/openwop-app/orgs', { name: 'Acme' });
  await owner.post(`/v1/host/openwop-app/orgs/${encodeURIComponent(org.body.orgId)}/members`, { displayName: 'M', subject: m.body.user.userId, roles: [role] });
  return { owner, member, memberId: m.body.user.userId, rosterId: r.body.rosterId, tenantId };
}

const twin = (id: string): string => `/v1/host/openwop-app/agents/${encodeURIComponent(id)}/twin`;
const GRANTS = '/v1/host/openwop-app/profiles/me/twin-grants';

describe('twin — toggle gating', () => {
  it('404s when twin-recall is off', async () => {
    await enable('twin-recall', 'off');
    const { owner, rosterId } = await ownerMemberAgent();
    expect((await owner.get(twin(rosterId))).status).toBe(404);
    await enable('twin-recall', 'on');
  });
});

describe('twin — link + grant authority', () => {
  it('admin links; only the linked user can grant; revoke + unlink clear it', async () => {
    const { owner, member, memberId, rosterId } = await ownerMemberAgent();

    // Admin links the agent to the member.
    const link = await owner.put(twin(rosterId), { userId: memberId });
    expect(link.status, JSON.stringify(link.body)).toBe(200);
    expect(link.body.link.userId).toBe(memberId);

    // A NON-linked user (the owner) cannot grant for this agent → 404 fail-closed.
    expect((await owner.post(GRANTS, { agentId: rosterId, scopes: ['memory'] })).status).toBe(404);

    // The linked member grants → 201, visible to them + on the agent link.
    const g = await member.post(GRANTS, { agentId: rosterId, scopes: ['memory', 'knowledge'] });
    expect(g.status, JSON.stringify(g.body)).toBe(201);
    expect(g.body.grant.scopes).toEqual(['memory', 'knowledge']);
    expect((await member.get(GRANTS)).body.grants.length).toBe(1);
    expect((await owner.get(twin(rosterId))).body.grant.scopes).toEqual(['memory', 'knowledge']);

    // The member revokes → gone from the agent link's active grant. TWIN-UX-25:
    // the route now REPORTS `{removed}` at 200 instead of 404-ing a benign
    // idempotent re-revoke, so the SPA can suppress a misleading success notice.
    const rev = await member.del(`${GRANTS}/${encodeURIComponent(rosterId)}`);
    expect(rev.status).toBe(200);
    expect(rev.body.removed).toBe(true);
    // Idempotent: a double-click reports `removed:false`, not a scary failure.
    expect((await member.del(`${GRANTS}/${encodeURIComponent(rosterId)}`)).body.removed).toBe(false);
    expect((await owner.get(twin(rosterId))).body.grant).toBe(null);

    // Re-grant, then unlink (admin) — unlink must also revoke. TWIN-UX-3
    // (unlink lane): the route now reports `{removed}` at 200, mirroring the
    // revoke route above, instead of a 204 that made "unlinked a live twin"
    // and "there was nothing here" indistinguishable.
    await member.post(GRANTS, { agentId: rosterId, scopes: ['memory'] });
    const un = await owner.del(twin(rosterId));
    expect(un.status).toBe(200);
    expect(un.body.removed).toBe(true);
    expect((await owner.get(twin(rosterId))).body.link).toBe(null);
    expect((await owner.get(twin(rosterId))).body.grant).toBe(null);
  });

  // HIGH-1 — the stale-second-tab scenario. Two admin tabs both show the link;
  // the first unlinks; the second's unlink must report `removed:false` and, above
  // all, must NOT mint a `twin.unlink` audit row for an act that did not happen —
  // the audit log is the record consent is reviewed from.
  it('a second unlink reports nothing-removed and writes NO audit row', async () => {
    const { owner, memberId, rosterId } = await ownerMemberAgent();
    await owner.put(twin(rosterId), { userId: memberId });

    // DELTA-based: `rosterId` is not unique across this file's tenants (a
    // different tenant minting the same agent ref can produce the same
    // `agent:<rosterId>` resource string), so an absolute count of 1 is wrong
    // under a full-file run — measured: the sibling test's unlink already
    // contributes a row.
    const unlinkRows = async (): Promise<number> =>
      (await __hostExtStorage()!.listAudit({ actionPrefix: 'twin.unlink', limit: 500 }))
        .filter((r) => r.resource === `agent:${rosterId}`).length;
    const before = await unlinkRows();

    const first = await owner.del(twin(rosterId));
    expect(first.status).toBe(200);
    expect(first.body.removed).toBe(true);
    expect(await unlinkRows(), 'the REAL unlink must audit').toBe(before + 1);

    const second = await owner.del(twin(rosterId));
    expect(second.status).toBe(200);
    expect(second.body.removed).toBe(false);
    expect(await unlinkRows(), 'a no-op unlink must NOT fabricate an audit row').toBe(before + 1);
  });

  // TWIN-5 — the viewer-403 half of this test MOVED to
  // `test/twin-shared-workspace.test.ts`. Switching to the canonical
  // `requireTenantScope` (`featureRoute.ts:258`) adopted its
  // `isOwnPersonalWorkspace` short-circuit, and THIS harness collapses
  // `personalTenant` onto `tenantId` (GC-1), so every caller here reads as the
  // workspace's own owner and the refusal is not reachable. That collapse is why
  // the assertion has to live in a real `ws:` fixture to mean anything — asserting
  // it here would only have re-pinned the harness.
  it('unknown scope values are rejected (400), as are empty ones', async () => {
    const { owner, member, memberId, rosterId } = await ownerMemberAgent('viewer');
    expect((await owner.put(twin(rosterId), { userId: memberId })).status).toBe(200);
    expect((await member.post(GRANTS, { agentId: rosterId, scopes: [] })).status).toBe(400);
    // TWIN-20 — previously `raw as TwinScope[]`, salvaged only by grantTwin's
    // re-filter; an unknown scope silently became an empty grant → a 400 that
    // named the wrong field.
    const bad = await member.post(GRANTS, { agentId: rosterId, scopes: ['memory', 'mind-reading'] });
    expect(bad.status).toBe(400);
    expect(JSON.stringify(bad.body)).toContain('mind-reading');
  });
});

const MEM = '/v1/host/openwop-app/profiles/me/memory';

describe('twin — borrowed recall gate (Phase 2)', () => {
  it('the live gate yields the owner corpus only under toggle + link + active grant', async () => {
    const { owner, member, memberId, rosterId, tenantId } = await ownerMemberAgent();
    // The member (owner of the corpus) records a personal memory.
    await member.post(MEM, { content: 'I always cc finance on vendor contracts.' });

    // No link/grant yet ⇒ the gate is closed.
    expect(await resolveBorrowedRecall(tenantId, rosterId, { callerUserId: memberId })).toBeUndefined();

    // Admin links + the member grants `memory`.
    expect((await owner.put(twin(rosterId), { userId: memberId })).status).toBe(200);
    expect((await member.post(GRANTS, { agentId: rosterId, scopes: ['memory'] })).status).toBe(201);

    // Now the gate opens; the retriever yields the owner's note.
    const retrieve = await resolveBorrowedRecall(tenantId, rosterId, { callerUserId: memberId });
    expect(retrieve, 'gate should be open under an active grant').toBeDefined();
    const chunks = await retrieve!.retrieve('vendor contract finance');
    expect(chunks.map((c) => c.content).join(' ')).toContain('cc finance on vendor contracts');

    // Revoke ⇒ the gate closes immediately (live re-check, no stamp — ADR 0044 §4).
    expect((await member.del(`${GRANTS}/${encodeURIComponent(rosterId)}`)).body.removed).toBe(true);
    expect(await resolveBorrowedRecall(tenantId, rosterId, { callerUserId: memberId })).toBeUndefined();

    // Re-grant, then turn the toggle off ⇒ closed (fail-closed).
    await member.post(GRANTS, { agentId: rosterId, scopes: ['memory'] });
    expect(await resolveBorrowedRecall(tenantId, rosterId, { callerUserId: memberId })).toBeDefined();
    await enable('twin-recall', 'off');
    expect(await resolveBorrowedRecall(tenantId, rosterId, { callerUserId: memberId })).toBeUndefined();
    await enable('twin-recall', 'on');
  });

  // ADR 0589 §D2 — AUDIENCE. Before this, `BorrowedRecallResolver` was
  // `(tenantId, agentId)`: the seam's TYPE could not carry a caller, so every
  // member of the tenant addressing a granted twin received answers grounded in
  // one named person's private memory.
  it('a NON-OWNER caller gets no borrowed recall, and an unattributed dispatch gets none either', async () => {
    const { owner, member, memberId, rosterId, tenantId } = await ownerMemberAgent();
    await member.post(MEM, { content: 'I always cc finance on vendor contracts.' });
    expect((await owner.put(twin(rosterId), { userId: memberId })).status).toBe(200);
    expect((await member.post(GRANTS, { agentId: rosterId, scopes: ['memory'] })).status).toBe(201);

    // The OWNER of the corpus gets it (positive control — without this the two
    // refusals below would pass against a gate that refuses everything).
    expect(await resolveBorrowedRecall(tenantId, rosterId, { callerUserId: memberId })).toBeDefined();

    // Another human in the SAME tenant, addressing the SAME granted agent: denied.
    const meRes = await owner.get('/v1/host/openwop-app/users/me');
    const otherId = meRes.body?.user?.userId ?? meRes.body?.userId;
    expect(otherId, 'need a second real user id for the negative case').toBeTruthy();
    expect(otherId).not.toBe(memberId);
    expect(await resolveBorrowedRecall(tenantId, rosterId, { callerUserId: otherId })).toBeUndefined();

    // No caller at all (an unattributed run/heartbeat): denied, not allowed.
    expect(await resolveBorrowedRecall(tenantId, rosterId)).toBeUndefined();
    expect(await resolveBorrowedRecall(tenantId, rosterId, { runId: 'run-1' })).toBeUndefined();
  });

  // TWIN-3 — the consent copy promises revocation lands "including on any run
  // already in flight". The grant used to be captured ONCE into the returned
  // closure, so the turn in flight kept recalling for the rest of its life.
  it('revoking mid-turn cuts off a retriever that was already handed out', async () => {
    const { owner, member, memberId, rosterId, tenantId } = await ownerMemberAgent();
    await member.post(MEM, { content: 'I always cc finance on vendor contracts.' });
    expect((await owner.put(twin(rosterId), { userId: memberId })).status).toBe(200);
    expect((await member.post(GRANTS, { agentId: rosterId, scopes: ['memory'] })).status).toBe(201);

    const retrieve = await resolveBorrowedRecall(tenantId, rosterId, { callerUserId: memberId });
    expect(retrieve).toBeDefined();
    // Positive control on the SAME closure, before the revoke.
    expect((await retrieve!.retrieve('vendor contract finance')).length).toBeGreaterThan(0);

    expect((await member.del(`${GRANTS}/${encodeURIComponent(rosterId)}`)).body.removed).toBe(true);
    // The SAME already-handed-out closure now yields nothing.
    expect(await retrieve!.retrieve('vendor contract finance')).toEqual([]);
  });

  // RCL-3 — the ADR 0044 §5 consent audit row, previously untested and
  // result-gated. The row is now ACCESS-gated (one `ok` row per resolver-grant-
  // success dispatch, chunks count included even at zero) and carries
  // `tenantId` (the governance viewer's fail-closed tenant filter withholds
  // unstamped rows from tenant-scoped superadmins) plus the RESOLVE-TIME scopes
  // (what retrieval actually used). Denied audience probes write a durable
  // `outcome:'denied'` row.
  describe('the consent audit row (RCL-3)', () => {
    const recallRows = async (ownerId: string) =>
      (await __hostExtStorage()!.listAudit({ actionPrefix: 'twin.recall', limit: 500 }))
        .filter((r) => r.resource === `user:${ownerId}`);

    it('ONE ok row per dispatch — access-gated, tenant-stamped, resolve-time scopes, no double-write', async () => {
      const { owner, member, memberId, rosterId, tenantId } = await ownerMemberAgent();
      await member.post(MEM, { content: 'I always cc finance on vendor contracts.' });
      expect((await owner.put(twin(rosterId), { userId: memberId })).status).toBe(200);
      expect((await member.post(GRANTS, { agentId: rosterId, scopes: ['memory'] })).status).toBe(201);

      const before = (await recallRows(memberId)).length;
      const retrieve = await resolveBorrowedRecall(tenantId, rosterId, { callerUserId: memberId, runId: 'run-audit-1', dispatchId: 'turn:1' });
      expect(retrieve).toBeDefined();
      expect((await retrieve!.retrieve('vendor contract finance')).length).toBeGreaterThan(0);
      // A second retrieval in the SAME dispatch must not write a second row.
      await retrieve!.retrieve('vendor contract finance');

      const rows = (await recallRows(memberId)).filter((r) => (r.payload as { runId?: unknown }).runId === 'run-audit-1');
      expect((await recallRows(memberId)).length).toBe(before + 1);
      expect(rows.length, 'exactly one row per dispatch').toBe(1);
      const p = rows[0]!.payload as { tenantId?: unknown; scopes?: unknown; chunks?: unknown; grantVersion?: unknown; agentId?: unknown };
      expect(rows[0]!.outcome).toBe('ok');
      expect(rows[0]!.principalId).toBe(memberId); // the human who asked
      expect(p.tenantId).toBe(tenantId);           // RCL-UX-8 — viewer reachability
      expect(p.scopes).toEqual(['memory']);        // RCL-3(c) — the scopes actually used
      expect(typeof p.chunks).toBe('number');
      expect(p.agentId).toBe(rosterId);

      // RCL-3(d) / F1 — a re-execution of the SAME DISPATCH (crash-resume
      // replay of a node; a retried exchange recomputing the same turn index)
      // does not duplicate the row: same (runId, dispatchId) ⇒ one row.
      const replay = await resolveBorrowedRecall(tenantId, rosterId, { callerUserId: memberId, runId: 'run-audit-1', dispatchId: 'turn:1' });
      await replay!.retrieve('vendor contract finance');
      expect(
        (await recallRows(memberId)).filter((r) => (r.payload as { runId?: unknown }).runId === 'run-audit-1').length,
        'replay guard: the same dispatch identity must not append a second ok row',
      ).toBe(1);

      // F1 (the review's core finding) — a conversation is ONE run resolved
      // per TURN, so a SECOND TURN under the same runId is a GENUINE recall
      // and MUST write its own row. The previous guard keyed on bare
      // (runId, agentId, owner) and deduped it away — and the old version of
      // THIS test pinned that undercount as 'replay' (its leg was
      // byte-for-byte a second chat turn).
      const turn2 = await resolveBorrowedRecall(tenantId, rosterId, { callerUserId: memberId, runId: 'run-audit-1', dispatchId: 'turn:2' });
      await turn2!.retrieve('vendor contract finance');
      const perTurn = (await recallRows(memberId)).filter((r) => (r.payload as { runId?: unknown }).runId === 'run-audit-1');
      expect(perTurn.length, 'turn 2 of the same conversation run is a genuine recall — its own row').toBe(2);
      expect(perTurn.map((r) => (r.payload as { dispatchId?: unknown }).dispatchId).sort()).toEqual(['turn:1', 'turn:2']);
    });

    // F2a — the guard must key on the SUBJECT, not a host-global window: the
    // old newest-200 scan failed OPEN once 200 unrelated `twin.recall` rows
    // landed between a dispatch and its replay (review probe: a duplicate ok
    // row at 205 rows of noise). What this does NOT discriminate: >200 rows
    // for the SAME owner between dispatch and replay (the pushed-down window
    // is per-subject newest-200, where a replay's prior row is recent).
    it('the replay guard still suppresses a duplicate after 205 unrelated audit rows (subject pushdown)', async () => {
      const { owner, member, memberId, rosterId, tenantId } = await ownerMemberAgent();
      await member.post(MEM, { content: 'I always cc finance on vendor contracts.' });
      expect((await owner.put(twin(rosterId), { userId: memberId })).status).toBe(200);
      expect((await member.post(GRANTS, { agentId: rosterId, scopes: ['memory'] })).status).toBe(201);

      const first = await resolveBorrowedRecall(tenantId, rosterId, { callerUserId: memberId, runId: 'run-noise-1', dispatchId: 'turn:1' });
      await first!.retrieve('vendor contract finance');
      expect((await recallRows(memberId)).filter((r) => r.outcome === 'ok').length).toBe(1);

      // 205 rows of OTHER subjects' recall noise — the review's flood shape.
      // Timestamps STRICTLY NEWER than the owner's row (same-millisecond ties
      // let the owner's row survive an ORDER BY timestamp DESC window and made
      // the first version of this probe vacuous — sabotage caught it).
      for (let i = 0; i < 205; i++) {
        await __hostExtStorage()!.appendAudit({
          timestamp: new Date(Date.now() + 60_000 + i).toISOString(), principalId: `noise-${i}`, action: 'twin.recall',
          resource: `user:noise-subject-${i}`, outcome: 'ok', payload: { agentId: 'noise-agent', tenantId, runId: `noise-run-${i}` },
        });
      }

      const replay = await resolveBorrowedRecall(tenantId, rosterId, { callerUserId: memberId, runId: 'run-noise-1', dispatchId: 'turn:1' });
      await replay!.retrieve('vendor contract finance');
      expect(
        (await recallRows(memberId)).filter((r) => r.outcome === 'ok').length,
        'noise must not push the prior row out of the guard window (fail-open)',
      ).toBe(1);
    });

    // F3 — denied rows are the flood primitive (each deny wrote a durable row
    // BEFORE the grant check, so an innocent teammate's 50-message chat = 50
    // rows, and a malicious member could truncate every grantor's reader).
    // Now rate-bounded per (tenant, agent, prober) with an honest aggregate.
    it('a deny flood writes ONE durable row; the next window row carries the suppressed count as `attempts`', async () => {
      const { owner, member, memberId, rosterId, tenantId } = await ownerMemberAgent();
      expect((await owner.put(twin(rosterId), { userId: memberId })).status).toBe(200);
      expect((await member.post(GRANTS, { agentId: rosterId, scopes: ['memory'] })).status).toBe(201);
      const meRes = await owner.get('/v1/host/openwop-app/users/me');
      const otherId = meRes.body?.user?.userId ?? meRes.body?.userId;
      const deniedRows = async () => (await recallRows(memberId)).filter((r) => r.outcome === 'denied');

      // Five probes in quick succession — the 50-message-chat flood shape.
      for (let i = 0; i < 5; i++) {
        expect(await resolveBorrowedRecall(tenantId, rosterId, { callerUserId: otherId, runId: `run-flood-${i}` })).toBeUndefined();
      }
      const inWindow = await deniedRows();
      expect(inWindow.length, 'the flood writes ONE durable row, not five').toBe(1);
      expect((inWindow[0]!.payload as { attempts?: unknown }).attempts).toBe(1);

      // The window lapses; the next deny writes again and folds in the four
      // suppressed probes. Only `Date` is faked (the resolver's window reads
      // Date.now(); no timer is involved).
      vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 11 * 60_000 });
      try {
        expect(await resolveBorrowedRecall(tenantId, rosterId, { callerUserId: otherId, runId: 'run-flood-next' })).toBeUndefined();
      } finally {
        vi.useRealTimers();
      }
      const after = await deniedRows();
      expect(after.length, 'a new window writes a second row').toBe(2);
      const next = after.find((r) => (r.payload as { runId?: unknown }).runId === 'run-flood-next');
      expect(next, 'the post-window deny writes durably').toBeDefined();
      expect((next!.payload as { attempts?: unknown }).attempts, 'this deny plus the four suppressed ones').toBe(5);
      // What this does NOT discriminate: a suppressed tail that never gets a
      // follow-up deny (best-effort across restarts, stated in-code).
    });

    it('a ZERO-chunk authorized read still writes the row (access-gated, not result-gated)', async () => {
      // A fresh fixture whose owner has recorded NOTHING — retrieval is
      // authorized, reads the corpus, and yields zero chunks deterministically.
      const { owner, member, memberId, rosterId, tenantId } = await ownerMemberAgent();
      expect((await owner.put(twin(rosterId), { userId: memberId })).status).toBe(200);
      expect((await member.post(GRANTS, { agentId: rosterId, scopes: ['memory'] })).status).toBe(201);
      const retrieve = await resolveBorrowedRecall(tenantId, rosterId, { callerUserId: memberId, runId: 'run-audit-zero' });
      expect(retrieve).toBeDefined();
      const chunks = await retrieve!.retrieve('anything at all');
      expect(chunks.length).toBe(0);
      const rows = (await recallRows(memberId)).filter((r) => (r.payload as { runId?: unknown }).runId === 'run-audit-zero');
      expect(rows.length, 'a zero-match query still READ the corpus — the attempt is audited').toBe(1);
      expect((rows[0]!.payload as { chunks?: unknown }).chunks).toBe(0);
    });

    it('an audience-not-owner probe writes a durable DENIED row', async () => {
      const { owner, member, memberId, rosterId, tenantId } = await ownerMemberAgent();
      expect((await owner.put(twin(rosterId), { userId: memberId })).status).toBe(200);
      expect((await member.post(GRANTS, { agentId: rosterId, scopes: ['memory'] })).status).toBe(201);
      const meRes = await owner.get('/v1/host/openwop-app/users/me');
      const otherId = meRes.body?.user?.userId ?? meRes.body?.userId;
      expect(await resolveBorrowedRecall(tenantId, rosterId, { callerUserId: otherId, runId: 'run-audit-deny' })).toBeUndefined();
      const denied = (await recallRows(memberId)).filter((r) => r.outcome === 'denied');
      expect(denied.length).toBe(1);
      const p = denied[0]!.payload as { reason?: unknown; tenantId?: unknown; runId?: unknown };
      expect(p.reason).toBe('audience-not-owner');
      expect(p.tenantId).toBe(tenantId);
      expect(p.runId).toBe('run-audit-deny');
      expect(denied[0]!.principalId).toBe(otherId); // WHO probed
      // The cheap closures (no caller / not linked / toggle-off) stay log-only —
      // volume-bounded by design; this test does NOT discriminate their absence
      // beyond the deny count above staying at 1.
      expect(await resolveBorrowedRecall(tenantId, rosterId)).toBeUndefined();
      expect((await recallRows(memberId)).filter((r) => r.outcome === 'denied').length).toBe(1);
    });
  });

  // TWIN-UX-4 — the recall audit READER: the grantor's own rows, subject- and
  // tenant-scoped, fail-closed on unstamped rows.
  describe('GET /profiles/me/twin-recalls (TWIN-UX-4 reader)', () => {
    const RECALLS = '/v1/host/openwop-app/profiles/me/twin-recalls';

    it('returns the caller their OWN rows only — including denied probes — and withholds unstamped rows', async () => {
      const { owner, member, memberId, rosterId, tenantId } = await ownerMemberAgent();
      await member.post(MEM, { content: 'I always cc finance on vendor contracts.' });
      expect((await owner.put(twin(rosterId), { userId: memberId })).status).toBe(200);
      expect((await member.post(GRANTS, { agentId: rosterId, scopes: ['memory'] })).status).toBe(201);

      // One real recall + one denied probe.
      const retrieve = await resolveBorrowedRecall(tenantId, rosterId, { callerUserId: memberId, runId: 'run-reader-1' });
      expect((await retrieve!.retrieve('vendor contract finance')).length).toBeGreaterThan(0);
      const meRes = await owner.get('/v1/host/openwop-app/users/me');
      const otherId = meRes.body?.user?.userId ?? meRes.body?.userId;
      expect(await resolveBorrowedRecall(tenantId, rosterId, { callerUserId: otherId })).toBeUndefined();

      // A legacy (pre-stamping) row without payload.tenantId — must be WITHHELD.
      await __hostExtStorage()!.appendAudit({
        timestamp: new Date().toISOString(), principalId: memberId, action: 'twin.recall',
        resource: `user:${memberId}`, outcome: 'ok', payload: { agentId: rosterId, chunks: 1 },
      });

      const mine = await member.get(RECALLS);
      expect(mine.status).toBe(200);
      const recalls = mine.body.recalls as Array<{ outcome: string; agentId?: string; chunks?: number }>;
      expect(recalls.filter((r) => r.outcome === 'ok').length, 'the stamped ok row, not the unstamped legacy one').toBe(1);
      expect(recalls.filter((r) => r.outcome === 'denied').length).toBe(1);
      expect(recalls.every((r) => r.agentId === rosterId)).toBe(true);

      // Subject scoping: the OWNER (admin) is not the grantor — sees nothing.
      const theirs = await owner.get(RECALLS);
      expect(theirs.status).toBe(200);
      expect(theirs.body.recalls).toEqual([]);
    });

    // F2b — the reader must push the subject down to the store. The old
    // newest-500-then-filter read a HOST-GLOBAL window, so 500 unrelated rows
    // hid the subject's entire history (review probe: 7 eligible → 1 shown)
    // and the card said "Never recalled yet." over real recalls —
    // empty-as-success at the data layer, under the copy written to prevent
    // exactly that. What this does NOT discriminate: >500 rows for the SAME
    // subject (the limit now bounds the subject's own newest rows).
    it('shows ALL of the subject\'s rows even under 500 rows of other-subject noise', async () => {
      const { owner, member, memberId, rosterId, tenantId } = await ownerMemberAgent();
      expect((await owner.put(twin(rosterId), { userId: memberId })).status).toBe(200);
      expect((await member.post(GRANTS, { agentId: rosterId, scopes: ['memory'] })).status).toBe(201);

      // Seven eligible rows, shaped exactly as the resolver writes them.
      for (let i = 0; i < 7; i++) {
        await __hostExtStorage()!.appendAudit({
          timestamp: new Date().toISOString(), principalId: memberId, action: 'twin.recall',
          resource: `user:${memberId}`, outcome: 'ok',
          payload: { agentId: rosterId, tenantId, scopes: ['memory'], chunks: 1, runId: `run-eligible-${i}` },
        });
      }
      // 500 STRICTLY-NEWER rows of other subjects' noise — enough to fill the
      // old host-global window entirely (strictly newer for the same
      // tie-ordering reason as the guard probe above).
      for (let i = 0; i < 500; i++) {
        await __hostExtStorage()!.appendAudit({
          timestamp: new Date(Date.now() + 60_000 + i).toISOString(), principalId: `noise-${i}`, action: 'twin.recall',
          resource: `user:reader-noise-${i}`, outcome: 'ok', payload: { agentId: 'noise-agent', tenantId, chunks: 1 },
        });
      }

      const mine = await member.get(RECALLS);
      expect(mine.status).toBe(200);
      const ok = (mine.body.recalls as Array<{ outcome: string }>).filter((r) => r.outcome === 'ok');
      expect(ok.length, 'every eligible row survives the noise (no truncation)').toBe(7);
    });

    it('404s when the toggle is off (fail-closed like every twin surface)', async () => {
      const { member } = await ownerMemberAgent();
      await enable('twin-recall', 'off');
      expect((await member.get(RECALLS)).status).toBe(404);
      await enable('twin-recall', 'on');
    });
  });

  // WF-TWIN-2 / TWIN-4 — the PRODUCER half. `resolveBorrowedRecall` wraps the
  // shared retriever to add its audit; that wrapper used to be declared at arity
  // ONE, and a 1-ary function is assignable to the 2-ary `AgentKnowledgeRetrieve`,
  // so `onSourceError` was dropped with zero compile signal. This drives the REAL
  // resolver and faults a source the only way the shared retriever ever reports
  // one — internally, never by throwing.
  it('the real resolver FORWARDS onSourceError, so a faulted owner-corpus read is reported', async () => {
    const { owner, member, memberId, rosterId, tenantId } = await ownerMemberAgent();
    // Bind a collection id on the owner's profile and leave NO knowledge backend
    // installed: `agentKnowledgeComposition.ts` reports that absence via
    // `onSourceError('kb')` — "a corpus that was never searched is not a corpus
    // that returned nothing."
    await setProfileKnowledge(tenantId, memberId, { collectionIds: ['col-does-not-resolve'] });
    const prior = getKnowledgeBackend();
    setKnowledgeBackend(null);
    try {
      expect((await owner.put(twin(rosterId), { userId: memberId })).status).toBe(200);
      expect((await member.post(GRANTS, { agentId: rosterId, scopes: ['knowledge'] })).status).toBe(201);

      const retrieve = await resolveBorrowedRecall(tenantId, rosterId, { callerUserId: memberId });
      expect(retrieve).toBeDefined();
      // Arity is the defect's own shape — pin it directly. A 1-ary wrapper
      // type-checks and silently swallows the sink.
      expect(retrieve!.retrieve.length, 'the wrapper must DECLARE the onSourceError parameter').toBeGreaterThanOrEqual(2);

      const faulted: string[] = [];
      const chunks = await retrieve!.retrieve('anything', (src) => faulted.push(src));
      expect(chunks.length).toBe(0);
      expect(faulted, 'the sink must reach through the twin wrapper').toContain('kb');
    } finally {
      setKnowledgeBackend(prior);
    }
  });
});
