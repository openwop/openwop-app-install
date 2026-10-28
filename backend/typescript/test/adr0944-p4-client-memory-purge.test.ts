/**
 * ADR 0944 P4 — client off-boarding, retention and the panel's routes (D8, D4 cap).
 *
 * Exit criteria: `deleteOrg` refuses while client memory exists, and the purge
 * empties all three memory stores (durable notes, the recall working set, the
 * vector namespace) plus receipts, proposals, snapshots and the designation.
 * Also: the purge is an agency-admin act, refused under a retention hold; an
 * untrusted summary in a client scope expires (180 days); curated notes are
 * never pushed out of recall by summaries at the scope cap.
 *
 * Sabotage-witnessed (P4): dropping `orgId` from the durable note row reds
 * "deleteOrg refuses"; dropping `purgeNamespaceVectors` from the purge reds "all
 * three stores"; dropping `requireAgencyAdmin` from the route reds the RBAC case;
 * dropping `evictionProtectedTag` reds the cap case.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import type http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { signSession, COOKIE_TTL_SECONDS } from '../src/middleware/cookieSession.js';
import { createMember, createOrg, createWorkspace, deleteOrg } from '../src/host/accessControlService.js';
import { upsertFromPrincipal } from '../src/features/users/usersService.js';
import { addClientNote, proposeClientNote, purgeClientMemory } from '../src/features/campaign-ops/clientMemory.js';
import { createSubjectMemoryPort, listSubjectNotes, CLIENT_SUMMARY_TTL_DAYS } from '../src/host/subjectMemory.js';
import { orgSubject } from '../src/host/subject.js';
import { getMemoryEntry, listMemoryEntries } from '../src/host/inMemorySurfaces.js';
import { MEMORY_UNTRUSTED_TAG } from '../src/host/agentDispatch.js';
import { buildHostSurfaceBundle } from '../src/host/inMemorySurfaces.js';
import { embedText, effectiveEmbedDims } from '../src/aiProviders/localEmbedding.js';
import { setRetentionHold, clearRetentionHold } from '../src/host/retentionHold.js';
import { hostExtStorage } from '../src/host/hostExtPersistence.js';
import { recordingRecall } from '../src/host/memoryReadReceipts.js';

let BASE: string;
let server: http.Server;
let TENANT: string;
let admin: string;
let editor: string;
let orgA: string;
const cookies: Record<string, string> = {};

const cookieFor = (userId: string, home: string): string => {
  const now = Math.floor(Date.now() / 1000);
  return `__session=${signSession({ sid: randomBytes(12).toString('hex'), tenantId: TENANT, tier: 'user', userId, personalTenant: home, iat: now, exp: now + COOKIE_TTL_SECONDS })}`;
};
async function call<T = Record<string, unknown>>(who: string, method: string, path: string, body?: unknown): Promise<{ status: number; body: T; raw: string }> {
  const res = await fetch(`${BASE}/host/openwop-app/campaign-ops${path}`, {
    method, headers: { cookie: cookies[who]!, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const raw = res.status === 204 ? '' : await res.text();
  let parsed: unknown;
  try { parsed = raw ? JSON.parse(raw) : undefined; } catch { parsed = undefined; }
  return { status: res.status, body: parsed as T, raw };
}

const vectorHits = async (orgId: string): Promise<number> => {
  const result = await buildHostSurfaceBundle({ tenantId: TENANT }).db.vector.query({ namespace: `org:${orgId}`, vector: embedText('anything', effectiveEmbedDims()), topK: 50 });
  if (!Array.isArray(result.matches)) throw new Error('Vector query did not return matches');
  return result.matches.length;
};

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['cms', 'campaign-ops']) {
    const d = getToggleDefault(id);
    if (d) await saveConfig({ ...d, status: 'on' }, 'test');
  }
  TENANT = (await createWorkspace({ name: 'Northwind Agency', ownerSubject: 'oidc:p4-owner' })).tenantId;
  admin = (await upsertFromPrincipal({ tenantId: TENANT, principalId: 'oidc:p4-admin', source: 'oidc' })).userId;
  editor = (await upsertFromPrincipal({ tenantId: TENANT, principalId: 'oidc:p4-editor', source: 'oidc' })).userId;
  await createMember({ tenantId: TENANT, orgId: TENANT, subject: admin, displayName: 'Admin', roles: ['admin'] });
  await createMember({ tenantId: TENANT, orgId: TENANT, subject: editor, displayName: 'Editor', roles: ['viewer'] });
  orgA = (await createOrg({ tenantId: TENANT, createdBy: 'seed', name: 'Client A' })).orgId;
  await createMember({ tenantId: TENANT, orgId: orgA, subject: editor, displayName: 'Editor', roles: ['editor'] });
  cookies.admin = cookieFor(admin, 'ws:home-admin');
  cookies.editor = cookieFor(editor, 'ws:home-editor');
  expect((await call('admin', 'POST', '/clients', { name: 'Client A', orgId: orgA })).status).toBe(201);
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

describe('ADR 0944 D8 — off-boarding', () => {
  it('expired client summaries stay absent from vector recall while curated notes remain', async () => {
    const client = (await createOrg({ tenantId: TENANT, createdBy: 'seed', name: 'Summary retention client' })).orgId;
    const scope = `org:${client}`;
    const port = createSubjectMemoryPort(TENANT);
    await addClientNote(TENANT, client, 'CURATED-RETENTION-NOTE', editor);
    await port.write(scope, { id: 'expiring-summary', content: 'EXPIRED-CLIENT-SUMMARY', tags: [MEMORY_UNTRUSTED_TAG] });
    expect((await port.read(scope, 'retention')).map((r) => r.content)).toEqual(expect.arrayContaining(['CURATED-RETENTION-NOTE', 'EXPIRED-CLIENT-SUMMARY']));
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + (CLIENT_SUMMARY_TTL_DAYS + 1) * 86_400_000);
    try {
      expect(await getMemoryEntry(TENANT, scope, 'expiring-summary')).toBeNull();
      expect((await port.read(scope, 'retention')).map((r) => r.content)).toEqual(['CURATED-RETENTION-NOTE']);
    } finally {
      clock.mockRestore();
    }
  });

  it('deleteOrg refuses while an org holds client memory, and not after the purge', async () => {
    // An org that is NOT a campaign-ops client, so only its memory can block it.
    const bare = (await createOrg({ tenantId: TENANT, createdBy: 'seed', name: 'Bare org' })).orgId;
    await addClientNote(TENANT, bare, 'NOTE-BARE', editor);
    expect((await deleteOrg(bare)).blocked?.rows).toBeGreaterThan(0);
    await purgeClientMemory(TENANT, bare);
    expect((await deleteOrg(bare)).blocked).toBeUndefined();
  });

  it('the purge empties all three stores and every client-memory row', async () => {
    await addClientNote(TENANT, orgA, 'NOTE-PURGE: lead with price', editor);
    await createSubjectMemoryPort(TENANT).write(`org:${orgA}`, { content: 'SUMMARY-PURGE', tags: ['agent', MEMORY_UNTRUSTED_TAG] });
    await proposeClientNote({ tenantId: TENANT, orgId: orgA, content: 'PROPOSED-PURGE', proposedBy: { runId: 'r1', nodeId: 'n1' } });
    expect(await vectorHits(orgA)).toBeGreaterThan(0);

    const viaEditor = await call('editor', 'DELETE', `/clients/${orgA}/memory`);
    expect(viaEditor.status).toBe(403); // not an agency admin
    const out = await call<{ report: { notes: number; recallEntries: number; proposals: number; complete: boolean } }>('admin', 'DELETE', `/clients/${orgA}/memory`);
    expect(out.status, out.raw).toBe(200);
    expect(out.body.report).toMatchObject({ complete: true });
    expect(out.body.report.notes).toBeGreaterThan(0);
    expect(out.body.report.proposals).toBeGreaterThan(0);

    expect(await listSubjectNotes(TENANT, orgSubject(orgA))).toEqual([]);
    expect(await listMemoryEntries(TENANT, `org:${orgA}`)).toEqual([]);
    expect(await vectorHits(orgA)).toBe(0);
    const proposals = await call<{ proposals: unknown[] }>('admin', 'GET', `/clients/${orgA}/memory/proposals`);
    expect(proposals.body.proposals).toEqual([]);
    // Idempotent.
    expect((await call('admin', 'DELETE', `/clients/${orgA}/memory`)).status).toBe(200);
  });

  it('is refused under a retention hold', async () => {
    await setRetentionHold(TENANT, 'litigation');
    try {
      await expect(purgeClientMemory(TENANT, orgA)).rejects.toBeTruthy();
    } finally {
      await clearRetentionHold(TENANT);
    }
  });
});

describe('ADR 0944 D4/D8 — retention inside a client scope', () => {
  it('receipt listing verifies the run’s current primary client rather than trusting an old receipt index', async () => {
    const storage = hostExtStorage();
    const runId = `receipt-owner-${randomBytes(4).toString('hex')}`;
    await storage.insertRun({ runId, workflowId: 'receipt-fixture', tenantId: TENANT, status: 'completed', inputs: null, configurable: {}, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), metadata: { 'openwop-app.campaignOps': { orgId: orgA } } });
    await recordingRecall({ memory: { read: async () => [], write: async () => {} } }).write({ tenantId: TENANT, runId, nodeId: 'copy', ordinal: 1, orgId: orgA, scope: `org:${orgA}` });
    const before = await call<{ receipts: unknown[] }>('editor', 'GET', `/clients/${orgA}/runs/${runId}/memory-receipts`);
    expect(before.status, before.raw).toBe(200);
    expect(before.body.receipts).toHaveLength(1);
    await storage.mergeRunMetadata(runId, { 'openwop-app.campaignOps': { orgId: 'another-client' } });
    expect((await call('editor', 'GET', `/clients/${orgA}/runs/${runId}/memory-receipts`)).status).toBe(404);
  });
  it('an untrusted summary expires; a note does not', async () => {
    const port = createSubjectMemoryPort(TENANT);
    await port.write(`org:${orgA}`, { content: 'SUMMARY-TTL', tags: ['agent', MEMORY_UNTRUSTED_TAG] });
    await addClientNote(TENANT, orgA, 'NOTE-TTL', editor);
    const rows = await listMemoryEntries(TENANT, `org:${orgA}`);
    const summary = rows.find((r) => r.content === 'SUMMARY-TTL');
    const note = rows.find((r) => r.content === 'NOTE-TTL');
    const days = (Date.parse(summary!.expiresAt!) - Date.now()) / 86_400_000;
    expect(Math.round(days)).toBe(CLIENT_SUMMARY_TTL_DAYS);
    expect(note?.expiresAt).toBeUndefined();
  });

  it('at the scope cap, summaries are evicted before curated notes', async () => {
    const org = (await createOrg({ tenantId: TENANT, createdBy: 'seed', name: 'Busy client' })).orgId;
    const note = await addClientNote(TENANT, org, 'NOTE-OLDEST: never evicted', editor);
    const first = await createSubjectMemoryPort(TENANT);
    await first.write(`org:${org}`, { content: 'S-FIRST', tags: ['agent'], id: 'summary-first' });
    const port = createSubjectMemoryPort(TENANT);
    for (let i = 0; i < 2005; i += 1) await port.write(`org:${org}`, { content: `S${i}`, tags: ['agent'] });
    // The oldest SUMMARY went; the older NOTE stayed (reads cap at 500, so by id).
    expect(await getMemoryEntry(TENANT, `org:${org}`, note.id)).not.toBeNull();
    expect(await getMemoryEntry(TENANT, `org:${org}`, 'summary-first')).toBeNull();
  }, 120_000);
});
