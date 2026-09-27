/**
 * ADR 0667 D3 (PMXWF-9) — `generate-agenda` duplicated a session + a board-agenda
 * Document + a version on BOTH replay and `:fork`. Two defects, two fixes.
 *
 * Born red: leg 1 saw `role:"action"` in the manifest (so the node was in neither
 * the side-effect floor nor the fast-path-served set, i.e. it re-executed on plain
 * REPLAY); leg 2 minted a second session from the run lane; leg 4 had no cap.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import { MANIFEST_SIDE_EFFECT_FLOOR, MANIFEST_FAST_PATH_SERVED, MANIFEST_DECLARED_TYPE_IDS } from '../src/executor/sideEffectFloor.generated.js';
import { isSideEffectingNode } from '../src/executor/sideEffects.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { openStorage } from '../src/storage/index.js';
import { __resetIgnitionClaims } from '../src/host/ignitionGuard.js';
import { createList, submitIdea, setIdeaScore, getSessionRow } from '../src/features/priority-matrix/priorityMatrixService.js';
import { buildPriorityMatrixSurface } from '../src/features/priority-matrix/surface.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const NODE_ID = 'feature.priority-matrix.nodes.generate-agenda';
const T = 'tAgendaIdem';
let listId = '';

beforeEach(async () => {
  const storage = await openStorage('memory://');
  initHostExtPersistence(storage);
  await __resetIgnitionClaims();
  const list = await createList(T, 'org-1', 'u1', { name: 'Bets', presetId: 'weighted' });
  listId = list.id;
  const idea = await submitIdea(T, listId, 'u1', { title: 'An idea' });
  await setIdeaScore(T, listId, idea.id, 'u1', { 'strategic-alignment': 8, roi: 7, urgency: 6, 'compliance-risk': 5, cost: 4 });
});

const surface = () => buildPriorityMatrixSurface({ tenantId: T } as never) as unknown as {
  generateAgenda: (a: Record<string, unknown>) => Promise<{ sessionId: string; deduped?: boolean }>;
};

describe('ADR 0667 D3 — generate-agenda duplicates neither on replay nor on fork', () => {
  it('leg 1 (the REPLAY half): the manifest declares side-effect, so the node is floored AND served', () => {
    const pack = JSON.parse(readFileSync(join(REPO, 'packs', 'feature.priority-matrix.nodes', 'pack.json'), 'utf8')) as {
      version: string; nodes: { typeId: string; role: string }[];
    };
    const node = pack.nodes.find((n) => n.typeId === NODE_ID);
    expect(node?.role, 'a durable writer declared `action` re-executes on replay').toBe('side-effect');
    expect(MANIFEST_DECLARED_TYPE_IDS.has(NODE_ID)).toBe(true);
    expect(MANIFEST_SIDE_EFFECT_FLOOR.has(NODE_ID), 'in the floor').toBe(true);
    expect(MANIFEST_FAST_PATH_SERVED.has(NODE_ID), 'and replay-SERVED, which is what stops the re-execution').toBe(true);
    expect(isSideEffectingNode(NODE_ID)).toBe(true);
    // The feature pin must equal the manifest, or the host runs a different pack.
    const feature = readFileSync(join(REPO, 'backend', 'typescript', 'src', 'features', 'priority-matrix', 'feature.ts'), 'utf8');
    expect(feature).toContain(`{ name: 'feature.priority-matrix.nodes', version: '${pack.version}' }`);
  });

  it('leg 2 (the FORK half): a re-execution with identical inputs returns the SAME session', async () => {
    const first = await surface().generateAgenda({ listId, n: 5 });
    const second = await surface().generateAgenda({ listId, n: 5 });
    expect(second.sessionId, 'a fork re-executes with identical list state and must collapse').toBe(first.sessionId);
    expect(second.deduped).toBe(true);
  });

  it('leg 3: a DIFFERENT request is not deduped — the latch must not wedge honest re-generation', async () => {
    const a = await surface().generateAgenda({ listId, n: 5 });
    const b = await surface().generateAgenda({ listId, n: 3 });
    expect(b.sessionId).not.toBe(a.sessionId);
    expect(b.deduped).toBeUndefined();
  });

  it('leg 4: the dedup returns a session that really exists and belongs to this list', async () => {
    const first = await surface().generateAgenda({ listId, n: 5 });
    const second = await surface().generateAgenda({ listId, n: 5 });
    const row = await getSessionRow(T, second.sessionId);
    expect(row, 'never hand back an id with no row behind it').toBeTruthy();
    expect(row?.listId).toBe(listId);
    expect(row?.id).toBe(first.sessionId);
  });
});
