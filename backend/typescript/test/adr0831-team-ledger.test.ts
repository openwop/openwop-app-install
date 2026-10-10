/**
 * ADR 0831 P1 — the team intent ledger, over real HTTP with real sign-ins.
 *
 *   - toggle OFF ⇒ 404 on every route (sabotage leg for the rest);
 *   - one ledger per project; the creator is the owner; version 1 = creation;
 *   - the charter stays the home of goal/objectives: an accepted goal change
 *     shows up in `charter.goal`, and a DIRECT charter edit bumps the version;
 *   - propose ≠ accept: a teammate with write proposes, only the owner accepts;
 *     a viewer cannot propose; a stranger gets 404 (no existence leak);
 *   - a stale base is refused until the owner says `rebased`;
 *   - every version's state is retrievable exactly (the P2 stamp relies on it);
 *   - decision references must be decision records in the project's org;
 *   - concurrent accepts serialize: versions are unique and contiguous;
 *   - DSAR redacts what the subject authored and leaves the shared record.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getSetCookies } from './headerCookies.js';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { createMember } from '../src/host/accessControlService.js';
import { createDocument } from '../src/features/documents/documentsService.js';
import { acceptDelta, countLedgerRowsForProject, deleteLedgerForProject, eraseTeamLedgerSubject, getLedger, getSeenVersion, listDeltas } from '../src/features/team-intent-ledger/ledgerStore.js';
import { getProject } from '../src/features/projects/projectsService.js';
import { ERASED } from '../src/host/subjectErasureRedaction.js';

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


interface Res<T = any> { status: number; body: T }
function client() {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]!; }
    return { status: res.status, body: res.status === 204 ? undefined : await res.json().catch(() => undefined) };
  };
  return { get: (p: string) => call('GET', p), post: (p: string, b?: unknown) => call('POST', p, b), patch: (p: string, b?: unknown) => call('PATCH', p, b) };
}
type Client = ReturnType<typeof client>;
const email = (who: string): string => `${who}-${Date.now()}-${n++}@acme.test`;

async function setup(): Promise<{ tenantId: string; orgId: string; projectId: string; owner: Client; ownerId: string; mate: Client; mateId: string; L: string }> {
  const tenantId = `org:tl-${Date.now()}-${n++}`;
  const owner = client();
  const ownerId = (await owner.post('/host/openwop-app/test/login', { email: email('tl-owner'), tenantId })).body.user.userId as string;
  const orgId = (await owner.post('/host/openwop-app/orgs', { name: 'LedgerCo' })).body.orgId as string;
  const p = await owner.post('/host/openwop-app/projects', { orgId, name: 'Launch' });
  expect(p.status, JSON.stringify(p.body)).toBe(201);
  // Before any ledger exists, so this edit is not recorded anywhere.
  expect((await owner.patch(`/host/openwop-app/projects/${p.body.id}`, { charter: { goal: 'Ship the launch', objectives: ['EU live'] } })).status).toBe(200);
  const mate = client();
  const mateId = (await mate.post('/host/openwop-app/test/login', { email: email('tl-mate'), tenantId })).body.user.userId as string;
  await createMember({ tenantId, orgId, subject: mateId, displayName: 'Mate', roles: ['editor'] });
  return { tenantId, orgId, projectId: p.body.id, owner, ownerId, mate, mateId, L: `/host/openwop-app/team-ledger/projects/${p.body.id}` };
}

describe('ADR 0831 P1 — team intent ledger', () => {
  it('always on: no toggle is registered, and a STORED "off" row left from when it had one changes nothing', async () => {
    // Production still holds config rows for both retired ids (a per-workspace
    // override saved them with a global "off"); they must not hide anything.
    expect(getToggleDefault('team-intent-ledger')).toBeNull();
    expect(getToggleDefault('structured-handoffs')).toBeNull();
    for (const id of ['team-intent-ledger', 'structured-handoffs']) {
      await saveConfig({ id, label: id, status: 'off', bucketUnit: 'tenant', salt: id } as never, 'test');
    }
    const s = await setup();
    expect((await s.owner.post(s.L)).status).toBe(201);
    expect((await s.owner.get(s.L)).status).toBe(200);
  });

  it('create: one per project, creator owns it, version 1 holds the charter goal', async () => {
    const s = await setup();
    const c = await s.owner.post(s.L);
    expect(c.status, JSON.stringify(c.body)).toBe(201);
    expect(c.body.ledger).toMatchObject({ version: 1, ownerSubject: s.ownerId });
    expect(c.body.state).toMatchObject({ goal: 'Ship the launch', objectives: ['EU live'] });
    expect((await s.owner.post(s.L)).status).toBe(409);
    expect((await s.owner.get(`${s.L}/versions/1`)).body.state.goal).toBe('Ship the launch');
  });

  it('propose ≠ accept; only the owner accepts; the accepted goal lands in the CHARTER', async () => {
    const s = await setup();
    await s.owner.post(s.L);
    const prop = await s.mate.post(`${s.L}/deltas`, { patch: { goal: 'Ship the EU launch first', openQuestions: ['Is the date fixed?'] }, why: 'Scope cut agreed Monday', baseVersion: 1 });
    expect(prop.status, JSON.stringify(prop.body)).toBe(201);
    expect((await s.owner.get(s.L)).body.ledger.version).toBe(1); // proposing moves nothing

    expect((await s.mate.post(`${s.L}/deltas/${prop.body.delta.deltaId}/accept`)).status).toBe(403);
    const acc = await s.owner.post(`${s.L}/deltas/${prop.body.delta.deltaId}/accept`);
    expect(acc.status, JSON.stringify(acc.body)).toBe(200);
    expect(acc.body.ledger.version).toBe(2);
    expect(acc.body.delta).toMatchObject({ status: 'accepted', resultVersion: 2 });

    const project = await s.owner.get(`/host/openwop-app/projects/${s.projectId}`);
    expect(project.body.charter.goal).toBe('Ship the EU launch first');
    expect((await s.owner.get(s.L)).body.state).toMatchObject({ goal: 'Ship the EU launch first', openQuestions: ['Is the date fixed?'] });
    // Version 1 is still exactly what it was.
    expect((await s.owner.get(`${s.L}/versions/1`)).body.state).toMatchObject({ goal: 'Ship the launch', openQuestions: [] });
    // Accepting twice is refused.
    expect((await s.owner.post(`${s.L}/deltas/${prop.body.delta.deltaId}/accept`)).status).toBe(409);
  });

  it('a direct charter edit is recorded as a version; a ledger write is not recorded twice', async () => {
    const s = await setup();
    await s.owner.post(s.L);
    const edit = await s.owner.patch(`/host/openwop-app/projects/${s.projectId}`, { charter: { goal: 'Ship it in October', objectives: ['EU live'] } });
    expect(edit.status, JSON.stringify(edit.body)).toBe(200);
    const after = await s.owner.get(s.L);
    expect(after.body.ledger.version).toBe(2);
    const log = (await s.owner.get(`${s.L}/deltas`)).body.deltas as Array<{ source?: { kind: string }; resultVersion?: number }>;
    expect(log.filter((d) => d.source?.kind === 'charter-edit')).toHaveLength(1);
    // Owner direct write through the ledger: exactly one new version, no charter-edit echo.
    const w = await s.owner.post(`${s.L}/write`, { patch: { goal: 'Ship it in November' }, why: 'Slipped a month' });
    expect(w.status, JSON.stringify(w.body)).toBe(200);
    expect(w.body.ledger.version).toBe(3);
    const log2 = (await s.owner.get(`${s.L}/deltas`)).body.deltas as Array<{ source?: { kind: string } }>;
    expect(log2.filter((d) => d.source?.kind === 'charter-edit')).toHaveLength(1);
  });

  it('a stale base is refused until the owner says rebased', async () => {
    const s = await setup();
    await s.owner.post(s.L);
    const a = (await s.mate.post(`${s.L}/deltas`, { patch: { inScope: ['EU'] }, why: 'a', baseVersion: 1 })).body.delta;
    const b = (await s.mate.post(`${s.L}/deltas`, { patch: { outOfScope: ['APAC'] }, why: 'b', baseVersion: 1 })).body.delta;
    expect((await s.owner.post(`${s.L}/deltas/${a.deltaId}/accept`)).status).toBe(200);
    const stale = await s.owner.post(`${s.L}/deltas/${b.deltaId}/accept`);
    expect(stale.status).toBe(409);
    expect(stale.body.details).toMatchObject({ baseVersion: 1, currentVersion: 2 });
    const ok = await s.owner.post(`${s.L}/deltas/${b.deltaId}/accept`, { rebased: true });
    expect(ok.status).toBe(200);
    expect(ok.body.delta.rebased).toBe(true);
    expect(ok.body.ledger.version).toBe(3);
    expect((await s.owner.get(s.L)).body.state).toMatchObject({ inScope: ['EU'], outOfScope: ['APAC'] });
  });

  it('RBAC: a viewer reads but cannot propose; a stranger gets 404; ownership moves only to a writer', async () => {
    const s = await setup();
    await s.owner.post(s.L);
    const viewer = client();
    const viewerId = (await viewer.post('/host/openwop-app/test/login', { email: email('tl-viewer'), tenantId: s.tenantId })).body.user.userId as string;
    await createMember({ tenantId: s.tenantId, orgId: s.orgId, subject: viewerId, displayName: 'V', roles: ['viewer'] });
    expect((await viewer.get(s.L)).status).toBe(200);
    expect((await viewer.post(`${s.L}/deltas`, { patch: { inScope: ['x'] }, why: 'y', baseVersion: 1 })).status).toBe(403);

    const stranger = client();
    await stranger.post('/host/openwop-app/test/login', { email: email('tl-stranger') });
    expect((await stranger.get(s.L)).status).toBe(404);

    expect((await s.owner.post(`${s.L}/owner`, { ownerSubject: viewerId })).status).toBe(400);
    const moved = await s.owner.post(`${s.L}/owner`, { ownerSubject: s.mateId });
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    expect((await s.owner.post(`${s.L}/owner`, { ownerSubject: s.ownerId })).status).toBe(403); // no longer owner
  });

  it('validation: unknown fields, empty why, and a decision id that is not a decision record are refused', async () => {
    const s = await setup();
    await s.owner.post(s.L);
    expect((await s.mate.post(`${s.L}/deltas`, { patch: { intent: 'x' }, why: 'w', baseVersion: 1 })).status).toBe(400);
    expect((await s.mate.post(`${s.L}/deltas`, { patch: { inScope: ['x'] }, why: '  ', baseVersion: 1 })).status).toBe(400);
    const memo = await createDocument({ tenantId: s.tenantId, orgId: s.orgId, title: 'Memo', kind: 'memo', format: 'markdown', createdBy: s.ownerId } as never);
    expect((await s.mate.post(`${s.L}/deltas`, { patch: { decisionDocumentIds: [memo.documentId] }, why: 'w', baseVersion: 1 })).status).toBe(400);
    const dec = await createDocument({ tenantId: s.tenantId, orgId: s.orgId, title: 'Decision — EU first', kind: 'decision-record', format: 'markdown', createdBy: s.ownerId } as never);
    const ok = await s.mate.post(`${s.L}/deltas`, { patch: { decisionDocumentIds: [dec.documentId] }, why: 'Recorded Monday', baseVersion: 1 });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
  });

  it('concurrent accepts serialize: two accepts that both read version 1 cannot both produce version 2', async () => {
    // Service-level on purpose. Over HTTP the accepts are effectively processed one
    // at a time, so the race never happens and an HTTP-level version of this
    // assertion passed with compare-and-swap REMOVED (measured). Calling the
    // service twice in the same tick makes both read the ledger before either writes.
    const s = await setup();
    await s.owner.post(s.L);
    const a = (await s.mate.post(`${s.L}/deltas`, { patch: { inScope: ['area A'] }, why: 'a', baseVersion: 1 })).body.delta;
    const b = (await s.mate.post(`${s.L}/deltas`, { patch: { outOfScope: ['area B'] }, why: 'b', baseVersion: 1 })).body.delta;
    const project = await getProject(s.tenantId, s.projectId);
    const results = await Promise.allSettled([
      acceptDelta(project!, a.deltaId, s.ownerId, { rebased: true }),
      acceptDelta(project!, b.deltaId, s.ownerId, { rebased: true }),
    ]);
    const versions = results.filter((r) => r.status === 'fulfilled').map((r) => (r as PromiseFulfilledResult<{ ledger: { version: number } }>).value.ledger.version).sort();
    expect(versions).toEqual([2, 3]);
    const ledger = await getLedger(s.tenantId, s.projectId);
    expect(ledger!.version).toBe(3);
    // Both changes survived: neither write clobbered the other.
    expect(ledger!.inScope).toEqual(['area A']);
    expect(ledger!.outOfScope).toEqual(['area B']);
  });

  it('D1: last-seen is per person, server-side, bounded, and never moves backward', async () => {
    const s = await setup();
    await s.owner.post(s.L);
    await s.owner.post(`${s.L}/write`, { patch: { inScope: ['EU'] }, why: 'v2', baseVersion: 1 });
    await s.owner.post(`${s.L}/write`, { patch: { inScope: ['EU', 'UK'] }, why: 'v3', baseVersion: 2 });
    expect((await s.owner.get(s.L)).body.seenVersion).toBeNull();
    expect((await s.owner.post(`${s.L}/seen`, { version: 2 })).body.seenVersion).toBe(2);
    expect((await s.owner.get(s.L)).body.seenVersion).toBe(2);
    // A stale tab sending an older version does not move it back.
    expect((await s.owner.post(`${s.L}/seen`, { version: 1 })).body.seenVersion).toBe(2);
    // Per person: the mate has seen nothing.
    expect((await s.mate.get(s.L)).body.seenVersion).toBeNull();
    // Bounded to real versions.
    for (const version of [0, 4, 2.5, '3', undefined]) {
      expect((await s.owner.post(`${s.L}/seen`, { version })).status, String(version)).toBe(400);
    }
    expect((await s.owner.post(`${s.L}/seen`, { version: 3 })).body.seenVersion).toBe(3);
  });

  it('D1: no ledger ⇒ 404; erasure deletes the subject\'s rows; the project delete takes them', async () => {
    const s = await setup();
    expect((await s.owner.post(`${s.L}/seen`, { version: 1 })).status).toBe(404);
    await s.owner.post(s.L);
    const before = await countLedgerRowsForProject(s.tenantId, s.projectId);
    await s.owner.post(`${s.L}/seen`, { version: 1 });
    await s.mate.post(`${s.L}/seen`, { version: 1 });
    const ledger = (await getLedger(s.tenantId, s.projectId))!;
    expect(await countLedgerRowsForProject(s.tenantId, s.projectId)).toBe(before + 2); // the cascade counts the two seen rows
    await eraseTeamLedgerSubject(s.tenantId, `user:${s.mateId}`);
    expect(await getSeenVersion(s.tenantId, ledger.ledgerId, s.mateId)).toBeNull();
    expect(await getSeenVersion(s.tenantId, ledger.ledgerId, s.ownerId)).toBe(1);
    expect(await deleteLedgerForProject(s.tenantId, s.projectId)).toBe(before + 1); // everything + the owner's seen row
    expect(await getSeenVersion(s.tenantId, ledger.ledgerId, s.ownerId)).toBeNull();
  });

  it('DSAR: the subject\'s authored text and identity are redacted; the ledger stays', async () => {
    const s = await setup();
    await s.owner.post(s.L);
    const prop = (await s.mate.post(`${s.L}/deltas`, { patch: { openQuestions: ['Personal note'] }, why: 'My reason', baseVersion: 1 })).body.delta;
    await eraseTeamLedgerSubject(s.tenantId, `user:${s.mateId}`);
    const ledger = await getLedger(s.tenantId, s.projectId);
    expect(ledger).not.toBeNull();
    const d = (await listDeltas(s.tenantId, ledger!.ledgerId)).find((x) => x.deltaId === prop.deltaId)!;
    expect(d.author.id).toBe(ERASED);
    expect(d.why).toBe(ERASED);
    expect(d.patch).toEqual({}); // a never-accepted proposal's text was only theirs
  });
});
