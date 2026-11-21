/**
 * CHAN-F19 #11 (ADR 0464 §9) — the builder-pair room index on a DSAR.
 *
 * A room index row (`builder-pair:room`) lists the suggestion keys shared with a
 * workflow's room, and a key is `tenant:<userId>:<conversationId>`: it carries the
 * requester's id. The eraser unlisted a key only while its suggestion still existed.
 * Suggestions age out after a day, but a room other members keep writing to stays fresh
 * and keeps the stale key, and the erased person's id with it. The eraser also matched
 * the subject with `===`, so a `user:`-spelled id was missed.
 *
 * Boots the real app and erases through `eraseSubject`. Pins:
 *  - R1: the subject's key whose suggestion aged out is stripped; a peer's live key is
 *    kept and still lists;
 *  - R2: the subject's context, suggestion and room key go when the stored id is the
 *    `user:` spelling of the key the DSAR names;
 *  - R3: a room left with no keys is deleted, not kept empty.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { eraseSubject } from '../src/host/subjectErasure.js';
import { hostExtStorage } from '../src/host/hostExtPersistence.js';
import {
  getPairContext, getSuggestion, listRoomSuggestions, putPairContext, putSuggestion, suggestionKey,
  type WorkflowEditSuggestion,
} from '../src/features/builder-pair/pairStores.js';

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
});

let n = 0;
const now = (): string => new Date().toISOString();

function suggestion(tenantId: string, workflowId: string, requestedBy: string, conversationId: string): WorkflowEditSuggestion {
  return {
    id: `sug-${n++}`, tenantId, workflowId, conversationId, requestedBy, baseRevision: 'r1',
    summary: 'add a step', ops: [], opState: [], visibility: 'room', createdAt: now(), updatedAt: now(),
  };
}

/** The room row as stored (its keys are not on any read surface). */
async function roomKeys(tenantId: string, workflowId: string): Promise<string[] | null> {
  const raw = await hostExtStorage().kvGet(`hostext:builder-pair:room:${tenantId}:wf:${workflowId}`);
  return raw === null ? null : (JSON.parse(raw) as { keys: string[] }).keys;
}

/** What the 1-day age-out does: the suggestion row goes, the room row is not touched. */
async function ageOut(tenantId: string, requestedBy: string, conversationId: string): Promise<void> {
  await hostExtStorage().kvDelete(`hostext:builder-pair:suggestion:${suggestionKey(tenantId, requestedBy, conversationId)}`);
}

describe('CHAN-F19 #11 — the builder-pair room index on a DSAR', () => {
  it('R1 strips the subject\'s aged-out room key and keeps a peer\'s live one', async () => {
    const tenantId = `f19k-${n++}`;
    const wf = 'wf-1';
    await putSuggestion(suggestion(tenantId, wf, 'user:f19k-ana', 'conv-a'));
    await putSuggestion(suggestion(tenantId, wf, 'user:f19k-peer', 'conv-p'));
    await ageOut(tenantId, 'user:f19k-ana', 'conv-a');
    const ana = suggestionKey(tenantId, 'user:f19k-ana', 'conv-a');
    const peer = suggestionKey(tenantId, 'user:f19k-peer', 'conv-p');
    expect(await roomKeys(tenantId, wf), 'non-vacuity: the stale key is still listed').toEqual([ana, peer]);

    await eraseSubject(tenantId, 'user:f19k-ana');

    expect(await roomKeys(tenantId, wf)).toEqual([peer]);
    expect((await listRoomSuggestions(tenantId, wf, undefined)).map((s) => s.summary)).toEqual(['add a step']);
  });

  it('R2 matches the user: spelling of the id the DSAR names', async () => {
    const tenantId = `f19k-${n++}`;
    const wf = 'wf-2';
    await putPairContext({ tenantId, userId: 'user:f19k-bia', conversationId: 'conv-b', workflowId: wf, selection: { nodeIds: [], edgeIds: [] }, droppedIds: [], updatedAt: now() });
    await putSuggestion(suggestion(tenantId, wf, 'user:f19k-bia', 'conv-b'));
    expect(await getPairContext(tenantId, 'user:f19k-bia', 'conv-b'), 'non-vacuity').not.toBeNull();

    await eraseSubject(tenantId, 'f19k-bia');

    expect(await getPairContext(tenantId, 'user:f19k-bia', 'conv-b')).toBeNull();
    expect(await getSuggestion(tenantId, 'user:f19k-bia', 'conv-b')).toBeNull();
    expect(await roomKeys(tenantId, wf)).toBeNull();
  });

  it('R3 deletes a room left with no keys', async () => {
    const tenantId = `f19k-${n++}`;
    const wf = 'wf-3';
    await putSuggestion(suggestion(tenantId, wf, 'user:f19k-cai', 'conv-c'));
    await ageOut(tenantId, 'user:f19k-cai', 'conv-c');
    expect(await roomKeys(tenantId, wf), 'non-vacuity').toHaveLength(1);

    await eraseSubject(tenantId, 'user:f19k-cai');

    expect(await roomKeys(tenantId, wf)).toBeNull();
  });
});
