/**
 * ADR 0605 R2 — `KSC-21`: a DSAR must reach `knowledge-sync:source`.
 *
 * Tier 3 added `SyncSource.createdBy` as the confused-deputy guard (`KSC-2`). That
 * made the store ACTOR-ATTRIBUTED, and the ADR 0464 feature-store ratchet saw it
 * for the first time — with NO eraser. A data-subject deletion therefore left two
 * things behind: a durable row naming the erased person, and a cadence still
 * fetching a drive on a credential nobody live had authorised. The second is the
 * same deputy confusion `createdBy` exists to prevent, re-created by the erasure.
 *
 * The cure DISABLES rather than deletes — this feature DELETES KB documents, so a
 * half-understood erasure has destructive reach into data that is not the erased
 * person's. The reasoning is argued at `eraseKnowledgeSyncSubject`; this file is
 * the witness, and every case below goes RED when the eraser is broken.
 *
 * THREE THINGS THIS FILE EXISTS TO PIN, because each is a way the cure could be
 * quietly wrong rather than absent:
 *   1. it must not pause the WRONG source (another member's, another tenant's);
 *   2. it must not pause a TENANT-LEVEL binding — Tier 3's predicate is
 *      `conn.userId && …` precisely because such a connection belongs to no
 *      person, and pausing it would stop a legitimate org sync for a hole it does
 *      not have;
 *   3. the pause must have a LIVE EXIT. R1 already caught one cure in this batch
 *      that paused a source with no way back (Resume disabled, no
 *      `onConnectionRestored`), and repeating it would be the same wedge.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../src/host/knowledgeSourceFetch.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  listFolder: vi.fn(async () => ({ files: [], complete: true })),
}));

import { createApp } from '../src/index.js';
import { createCollection, getCollection } from '../src/features/kb/kbService.js';
import { PREAUTHORIZED_CALLER } from '../src/host/subjectAccess.js';
import { eraseSubject, registeredSubjectEraserIds } from '../src/host/subjectErasure.js';
import { upsertOAuthConnection } from '../src/features/connections/connectionsService.js';
import {
  createSyncSource, getSyncSource, setSyncStatus, listFileStates, upsertFileState,
  eraseKnowledgeSyncSubject, ERASED_CREATOR,
} from '../src/features/knowledge-sync/knowledgeSyncService.js';
import { runKnowledgeSyncOnce } from '../src/features/knowledge-sync/knowledgeSyncRunner.js';

const NOW = '2026-06-22T00:00:00.000Z';
const FOLDER = '1AbcDEF_ghiJKL-mnoPQRstuVWxyz0123456789';

let server: http.Server;
let n = 0;
const tenantName = (s: string): string => `org:ks-erase-${s}-${Date.now()}-${n++}`;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  // A real boot, so the eraser is reached through the registry rather than by a
  // direct import — the mechanism-vs-wiring lesson. An eraser present in source but
  // never IMPORTED contributes to neither `total` nor `failed`.
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { void (server.address() as AddressInfo); res(); }); });
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

/** A source bound to a connection owned by `ownerUserId` (omit ⇒ TENANT-LEVEL). */
async function sourceOwnedBy(
  tenantId: string,
  createdBy: string | undefined,
  ownerUserId?: string,
): Promise<{ sourceId: string; connectionId: string }> {
  const conn = await upsertOAuthConnection({
    tenantId, provider: 'google', orgId: 'org-e',
    ...(ownerUserId ? { userId: ownerUserId } : {}),
    tokens: { accessToken: 't', tokenType: 'Bearer', scopes: [] },
  });
  // ADR 0643 R4 Should 3 — the runner resolves the target collection BEFORE listing; it must exist.
  if (!(await getCollection(tenantId, 'org-e', 'col', PREAUTHORIZED_CALLER))) await createCollection(tenantId, 'org-e', 'test', { name: 'col' }, { collectionId: 'col' });
  const s = await createSyncSource(tenantId, 'org-e', {
    connectionId: conn.connectionId, provider: 'google', externalFolderId: FOLDER,
    collectionId: 'col', cadence: 'hourly', ...(createdBy ? { createdBy } : {}),
  }, NOW);
  return { sourceId: s.id, connectionId: conn.connectionId };
}

describe('KSC-21 — the DSAR eraser is WIRED, not merely written', () => {
  it('a real createApp() boot registers it', () => {
    // LAYER the manifest test cannot substitute for here: this asserts the name is
    // live in the registry the fan-out actually iterates.
    expect(registeredSubjectEraserIds()).toContain('eraseKnowledgeSyncSubject');
  });

  it('the HOST fan-out reaches it — erasing the creator pauses and disowns the source', async () => {
    const tenantId = tenantName('fanout');
    const me = 'user:erased-one';
    const { sourceId } = await sourceOwnedBy(tenantId, me, me);

    // Through `eraseSubject`, not by calling the eraser directly: a helper nobody
    // invokes erases nothing (the `commerce:cart` lesson).
    const result = await eraseSubject(tenantId, me);
    expect(result.failed, JSON.stringify(result.failedFeatures)).toBe(0);

    const after = await getSyncSource(tenantId, sourceId);
    expect(after?.status, 'a source syncing as an erased member must not keep syncing').toBe('paused');
    expect(after?.pausedReason).toBe('creator-erased');
    // THE ERASURE ITSELF. The row must no longer name the person.
    expect(after?.createdBy).toBe(ERASED_CREATOR);
    expect(after?.createdBy).not.toBe(me);
    // …and the message must name the EXIT, not merely the state.
    expect(after?.lastError).toMatch(/add the folder again with your own connected account/i);
  });

  it('DISABLE, NOT DELETE — the binding and its diff cursor survive', async () => {
    // This feature deletes KB documents. An eraser that deleted the source would
    // stop an org's folder sync on one member's DSAR, and (via `deleteSyncSource`)
    // drop the cursor that is the only record of what has already been ingested.
    const tenantId = tenantName('keep');
    const me = 'user:erased-two';
    const { sourceId } = await sourceOwnedBy(tenantId, me, me);
    await upsertFileState({ sourceId, externalFileId: 'f1', documentId: `sync:${sourceId}:f1`, revision: 'r1', tenantId });

    await eraseKnowledgeSyncSubject(tenantId, me);

    const after = await getSyncSource(tenantId, sourceId);
    // POSITIVE CONTROL FIRST. Everything else in this case asserts a NON-effect
    // ("the row is still there"), which a DEAD eraser satisfies perfectly — and
    // that is not hypothetical: the no-op sabotage of this file left this case
    // GREEN until these two lines were added. An assertion that survives the
    // removal of the thing it guards is decorative.
    expect(after?.status, 'the eraser must actually have run').toBe('paused');
    expect(after?.createdBy).toBe(ERASED_CREATOR);
    // …and now the non-effects mean something.
    expect(after, 'the source row must survive the erasure').not.toBeNull();
    expect(after?.externalFolderId).toBe(FOLDER);
    expect(after?.collectionId).toBe('col');
    expect(await listFileStates(sourceId), 'the diff cursor is folder state, not subject data').toHaveLength(1);
  });

  it('TOMBSTONE, NOT DELETE THE FIELD — the deputy guard stays armed after erasure', async () => {
    // Deleting `createdBy` would return the row to the LEGACY shape, which
    // `runKnowledgeSyncOnce`'s guard SKIPS — so the erasure would hand the source
    // back the exact pre-`KSC-2` behaviour: sync on whatever the connection now
    // resolves to. Deletion becomes a grant.
    const tenantId = tenantName('tombstone');
    const me = 'user:erased-three';
    const { sourceId } = await sourceOwnedBy(tenantId, me, me);
    await eraseKnowledgeSyncSubject(tenantId, me);

    const after = await getSyncSource(tenantId, sourceId);
    expect(after?.createdBy, 'an ABSENT createdBy is the legacy shape the guard ignores').toBeDefined();
    // Prove the guard still bites, rather than inferring it from the field's value.
    await expect(runKnowledgeSyncOnce({ storage: {} as never }, after!))
      .rejects.toThrow(/has been erased/i);
  });

  it('the refusal names the EXIT, and it is a DIFFERENT message from the drifted-owner one', async () => {
    // Two states, two actions: a drifted connection owner means "this connection is
    // not the creator's"; an erased creator means "there is no creator any more —
    // re-bind". The generic message would be true and useless.
    const tenantId = tenantName('msg');
    const me = 'user:erased-four';
    const { sourceId } = await sourceOwnedBy(tenantId, me, me);
    await eraseKnowledgeSyncSubject(tenantId, me);
    const erased = await getSyncSource(tenantId, sourceId);
    await expect(runKnowledgeSyncOnce({ storage: {} as never }, erased!))
      .rejects.toThrow(/add the folder again with your own connected account/i);

    const other = await sourceOwnedBy(tenantId, 'user:someone', 'user:different');
    const drifted = await getSyncSource(tenantId, other.sourceId);
    await expect(runKnowledgeSyncOnce({ storage: {} as never }, drifted!))
      .rejects.toThrow(/refusing to act as a different user/i);
  });
});

describe('KSC-21 — the eraser\'s own failure modes', () => {
  it('does NOT touch a source created by a DIFFERENT member of the same tenant', async () => {
    const tenantId = tenantName('wrongsubject');
    const mine = await sourceOwnedBy(tenantId, 'user:stays', 'user:stays');
    const theirs = await sourceOwnedBy(tenantId, 'user:goes', 'user:goes');

    await eraseKnowledgeSyncSubject(tenantId, 'user:goes');

    const untouched = await getSyncSource(tenantId, mine.sourceId);
    expect(untouched?.status, 'a colleague\'s DSAR must not pause my sync').toBe('active');
    expect(untouched?.createdBy).toBe('user:stays');
    expect(untouched?.pausedReason).toBeUndefined();
    expect((await getSyncSource(tenantId, theirs.sourceId))?.status).toBe('paused');
  });

  it('does NOT reach across tenants, even for the same userId', async () => {
    const a = tenantName('tenant-a');
    const b = tenantName('tenant-b');
    const shared = 'user:in-two-workspaces';
    const inA = await sourceOwnedBy(a, shared, shared);
    const inB = await sourceOwnedBy(b, shared, shared);

    await eraseKnowledgeSyncSubject(a, shared);

    expect((await getSyncSource(a, inA.sourceId))?.status).toBe('paused');
    expect((await getSyncSource(b, inB.sourceId))?.status, 'tenant isolation — a DSAR in one workspace must not disable another\'s sync').toBe('active');
    expect((await getSyncSource(b, inB.sourceId))?.createdBy).toBe(shared);
  });

  it('a TENANT-LEVEL connection is disowned but NOT paused — Tier 3\'s predicate, both lanes', async () => {
    // `requireOwnConnection`'s first draft refused a connection with no `userId` and
    // was WRONG for it: the run acts as the bare tenant, so there is no identity to
    // have been erased. Pausing here would stop a legitimate org sync in the name of
    // a hole it does not have — the same over-reach, one lane over.
    const tenantId = tenantName('tenantconn');
    const me = 'user:erased-five';
    const { sourceId } = await sourceOwnedBy(tenantId, me, undefined);

    await eraseKnowledgeSyncSubject(tenantId, me);

    const after = await getSyncSource(tenantId, sourceId);
    expect(after?.createdBy, 'the identifier still goes — that is the erasure').toBe(ERASED_CREATOR);
    expect(after?.status, 'nobody to impersonate ⇒ nothing to disable').toBe('active');
    expect(after?.pausedReason).toBeUndefined();
    // …and it must still RUN. A tombstone that broke this lane would be the pause
    // in a different costume.
    await expect(runKnowledgeSyncOnce({ storage: {} as never }, after!)).resolves.toBeDefined();
  });

  it('an ALREADY-paused source keeps its own reason (a revoked pause must not lose its reconnect instruction)', async () => {
    const tenantId = tenantName('alreadypaused');
    const me = 'user:erased-six';
    const { sourceId } = await sourceOwnedBy(tenantId, me, me);
    await setSyncStatus(tenantId, sourceId, 'paused', NOW, {
      lastError: 'Connection revoked — reconnect to resume syncing.', pausedReason: 'connection-revoked',
    });

    await eraseKnowledgeSyncSubject(tenantId, me);

    const after = await getSyncSource(tenantId, sourceId);
    expect(after?.createdBy).toBe(ERASED_CREATOR);
    expect(after?.pausedReason, 'the row was already in the safe state; overwriting its reason destroys Tier 6\'s deliverable').toBe('connection-revoked');
    expect(after?.lastError).toMatch(/reconnect/i);
  });

  it('IDEMPOTENT — a second call over the same subject changes nothing (the contract invokes it once per resolved key)', async () => {
    const tenantId = tenantName('idem');
    const me = 'user:erased-seven';
    const { sourceId } = await sourceOwnedBy(tenantId, me, me);
    await eraseKnowledgeSyncSubject(tenantId, me);
    const first = await getSyncSource(tenantId, sourceId);
    // POSITIVE CONTROL — a dead eraser is trivially idempotent, so pin that the
    // state being repeated is the ERASED one (this case was green under the no-op
    // sabotage without these two lines).
    expect(first?.createdBy).toBe(ERASED_CREATOR);
    expect(first?.pausedReason).toBe('creator-erased');
    await eraseKnowledgeSyncSubject(tenantId, me);
    const second = await getSyncSource(tenantId, sourceId);
    expect(second).toEqual(first);
  });

  it('the TOMBSTONE is not itself a subject — a DSAR keyed on it re-pauses nothing', async () => {
    // Without the guard, an erasure whose key happened to equal the sentinel would
    // sweep every already-erased source in the tenant back into a fresh pause,
    // clobbering a `connection-revoked` reason on the way through.
    const tenantId = tenantName('sentinel');
    const me = 'user:erased-eight';
    const { sourceId } = await sourceOwnedBy(tenantId, me, me);
    await eraseKnowledgeSyncSubject(tenantId, me);
    // POSITIVE CONTROL — the row must really BE tombstoned, or the sentinel below
    // has nothing to match and this case passes for the wrong reason (it did,
    // under the no-op sabotage).
    expect((await getSyncSource(tenantId, sourceId))?.createdBy).toBe(ERASED_CREATOR);
    await setSyncStatus(tenantId, sourceId, 'active', NOW, { pausedReason: null });

    await eraseKnowledgeSyncSubject(tenantId, ERASED_CREATOR);

    expect((await getSyncSource(tenantId, sourceId))?.status).toBe('active');
  });

  it('an empty tenant or subject is a no-op, never a sweep', async () => {
    const tenantId = tenantName('failclosed');
    const { sourceId } = await sourceOwnedBy(tenantId, 'user:erased-nine', 'user:erased-nine');
    await eraseKnowledgeSyncSubject('', 'user:erased-nine');
    await eraseKnowledgeSyncSubject(tenantId, '');
    expect((await getSyncSource(tenantId, sourceId))?.status).toBe('active');
    // POSITIVE CONTROL — otherwise "nothing happened" is indistinguishable from an
    // eraser that never works at all, which is exactly how this case read under the
    // no-op sabotage. Prove the ONLY thing holding it back was the empty argument.
    await eraseKnowledgeSyncSubject(tenantId, 'user:erased-nine');
    expect((await getSyncSource(tenantId, sourceId))?.status).toBe('paused');
  });
});

describe('KSC-21 — the pause has a LIVE EXIT (the R1 wedge, not repeated)', () => {
  it('Resume still works on a creator-erased pause, and the run then says what to do', async () => {
    // Tier 6 disabled Resume for a revoked source and R1 re-enabled it, because with
    // no `onConnectionRestored` hook that left a source permanently paused with no
    // in-product exit. A `creator-erased` pause must not reproduce it: `POST
    // /:id/resume` is unconditional, so the schedule can be re-armed…
    const tenantId = tenantName('exit');
    const me = 'user:erased-ten';
    const { sourceId } = await sourceOwnedBy(tenantId, me, me);
    await eraseKnowledgeSyncSubject(tenantId, me);
    expect((await getSyncSource(tenantId, sourceId))?.status).toBe('paused');

    // …the same write the resume route performs.
    const resumed = await setSyncStatus(tenantId, sourceId, 'active', NOW, { pausedReason: null });
    expect(resumed?.status).toBe('active');
    expect(resumed?.pausedReason).toBeUndefined();

    // Resume re-arms the SCHEDULE; it does not re-authorise the CREDENTIAL, and the
    // run still refuses fail-closed. That is defence in depth, not a dead end —
    // the refusal names the real exit, which is re-binding with a live account.
    await expect(runKnowledgeSyncOnce({ storage: {} as never }, resumed!))
      .rejects.toThrow(/add the folder again with your own connected account/i);
  });

  it('the real exit WORKS: a live member re-binding their own connection syncs normally', async () => {
    // The whole cure rests on this being reachable. If it were not, "disable" would
    // just be "delete, slowly".
    const tenantId = tenantName('rebind');
    const me = 'user:erased-eleven';
    const dead = await sourceOwnedBy(tenantId, me, me);
    await eraseKnowledgeSyncSubject(tenantId, me);
    // POSITIVE CONTROL — without it "the new source runs" is true of a tree where
    // the eraser does nothing at all, and the case proves no exit from a state it
    // never established (green under the no-op sabotage).
    expect((await getSyncSource(tenantId, dead.sourceId))?.status).toBe('paused');

    const live = 'user:still-here';
    const rebound = await sourceOwnedBy(tenantId, live, live);
    const source = await getSyncSource(tenantId, rebound.sourceId);
    expect(source?.status).toBe('active');
    await expect(runKnowledgeSyncOnce({ storage: {} as never }, source!)).resolves.toBeDefined();
  });
});
