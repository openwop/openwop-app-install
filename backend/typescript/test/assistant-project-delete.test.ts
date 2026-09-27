/**
 * PLAN-1 / DG-INT-3 (grade-data) — `deleteAssistantProject` scrubs, never
 * deletes, the project's soft references: commitments + decisions survive with
 * `projectId` cleared (both fields are optional; a commitment/decision has
 * standalone value in the task-deck and minutes). Bystander project's refs
 * untouched; delete of a missing project is a false no-op.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { openStorage } from '../src/storage/index.js';
import {
  createProject, deleteAssistantProject, getProject,
  upsertCommitmentBySource, listCommitments, getCommitment,
  logDecision, listDecisions,
} from '../src/features/assistant/assistantService.js';

beforeAll(async () => {
  initHostExtPersistence(await openStorage('memory://'));
});

const T = 'assist-del-t1';
const person = { kind: 'email' as const, address: 'dana@solsticeroasters.com' };
const src = (k: string) => ({
  kind: 'manual' as const, externalId: `manual-${k}`, contentHash: `hash-${k}`, capturedAt: new Date().toISOString(),
});

describe('deleteAssistantProject (PLAN-1)', () => {
  it('deletes the project, scrubs commitment/decision projectId, keeps the records', async () => {
    const doomed = await createProject(T, { name: 'Doomed Initiative' });
    const bystander = await createProject(T, { name: 'Bystander Initiative' });

    const { commitment: c1 } = await upsertCommitmentBySource(T, {
      owner: person, description: 'Send the Q3 wholesale proposal', source: src('a'), projectId: doomed.projectId,
    });
    const { commitment: c2 } = await upsertCommitmentBySource(T, {
      owner: person, description: 'Book the tasting room', source: src('b'), projectId: bystander.projectId,
    });
    const d1 = await logDecision(T, { statement: 'Standardize on the house blend', decidedBy: person, source: src('c'), projectId: doomed.projectId });

    expect(await deleteAssistantProject(T, doomed.projectId)).toBe(true);
    expect(await getProject(T, doomed.projectId)).toBeNull();

    // The commitment SURVIVES with its project ref scrubbed.
    const c1After = await getCommitment(T, c1.commitmentId);
    expect(c1After).not.toBeNull();
    expect(c1After!.projectId).toBeUndefined();
    // The decision likewise.
    const d1After = (await listDecisions(T)).find((d) => d.decisionId === d1.decisionId);
    expect(d1After).toBeDefined();
    expect(d1After!.projectId).toBeUndefined();
    // No commitments/decisions still claim the deleted project.
    expect(await listCommitments(T, { projectId: doomed.projectId })).toHaveLength(0);
    expect(await listDecisions(T, doomed.projectId)).toHaveLength(0);

    // Bystander project's refs untouched.
    expect((await getCommitment(T, c2.commitmentId))!.projectId).toBe(bystander.projectId);

    // Missing project → false, nothing thrown.
    expect(await deleteAssistantProject(T, doomed.projectId)).toBe(false);
  });
});
