/**
 * ADR 0667 D3 (PMXWF-9) — `generate-agenda` duplicated a session + a board-agenda
 * Document + a version on BOTH replay and `:fork`. Two defects, two fixes.
 *
 * Born red: leg 1 saw `role:"action"` in the manifest (so the node was in neither
 * the side-effect floor nor the fast-path-served set, i.e. it re-executed on plain
 * REPLAY); leg 2 minted a second session from the run lane; leg 4 had no cap.
 *
 * Sabotage map (wave 15): the pack role → `action` and the feature pin drift redden leg 1
 * (`w15g1-ag-role`, `-ag-pin`); disabling the latch reddens legs 2 + 4 (`-ag-dedup`);
 * dropping `n` from the key reddens leg 3 (`-ag-key-n`); trusting any recorded prior —
 * a ghost id, or another list's session — reddens leg 4 (`-ag-prior-list`).
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import { MANIFEST_SIDE_EFFECT_FLOOR, MANIFEST_FAST_PATH_SERVED, MANIFEST_DECLARED_TYPE_IDS } from '../src/executor/sideEffectFloor.generated.js';
import { isSideEffectingNode } from '../src/executor/sideEffects.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { openStorage } from '../src/storage/index.js';
import { __resetIgnitionClaims, ignitionKey, claimIgnition, recordIgnitionRun } from '../src/host/ignitionGuard.js';
import { createList, submitIdea, setIdeaScore, getSessionRow } from '../src/features/priority-matrix/priorityMatrixService.js';
import { buildPriorityMatrixSurface } from '../src/features/priority-matrix/surface.js';
import { pinnedPackRef } from '../src/features/packPins.js';

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

/** The run-lane verb. The surface contract returns `Record<string, unknown>`; the JSON
 *  round-trip narrows it to the fields read here without a type assertion. */
async function agenda(args: Record<string, unknown>): Promise<{ sessionId: string; deduped?: boolean }> {
  return JSON.parse(JSON.stringify(await buildPriorityMatrixSurface({ tenantId: T }).generateAgenda(args)));
}
/** Plant a latch for THIS list's (n=5, no name) agenda pointing at `sessionId`. */
async function plantLatch(sessionId: string): Promise<void> {
  await __resetIgnitionClaims();
  const key = ignitionKey('priority-matrix.generate-agenda', listId, '', '5');
  expect(await claimIgnition(T, key)).toEqual({ claimed: true });
  await recordIgnitionRun(T, key, sessionId);
}

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
    expect(feature).toContain(`'feature.priority-matrix.nodes'`);
    expect(pinnedPackRef('feature.priority-matrix.nodes').version, 'the pin (features/packPins.ts, ADR 0919) must match the manifest').toBe(pack.version);
  });

  it('leg 2 (the FORK half): a re-execution with identical inputs returns the SAME session', async () => {
    const first = await agenda({ listId, n: 5 });
    const second = await agenda({ listId, n: 5 });
    expect(second.sessionId, 'a fork re-executes with identical list state and must collapse').toBe(first.sessionId);
    expect(second.deduped).toBe(true);
  });

  it('leg 3: a DIFFERENT request is not deduped — the latch must not wedge honest re-generation', async () => {
    const a = await agenda({ listId, n: 5 });
    const b = await agenda({ listId, n: 3 });
    expect(b.sessionId).not.toBe(a.sessionId);
    expect(b.deduped).toBeUndefined();
  });

  it('leg 4: the dedup returns a session that really exists and belongs to this list', async () => {
    // (a) A latch whose recorded id has NO row behind it is not reused.
    await plantLatch('psession-ghost');
    const fresh = await agenda({ listId, n: 5 });
    expect(fresh.sessionId, 'never hand back an id with no row behind it').not.toBe('psession-ghost');
    expect(fresh.deduped).toBeUndefined();
    expect((await getSessionRow(T, fresh.sessionId))?.listId).toBe(listId);

    // (b) A latch pointing at ANOTHER list's real session is not reused either.
    const other = await createList(T, 'org-1', 'u1', { name: 'Other', presetId: 'weighted' });
    const otherIdea = await submitIdea(T, other.id, 'u1', { title: 'Other idea' });
    await setIdeaScore(T, other.id, otherIdea.id, 'u1', { 'strategic-alignment': 5 });
    const foreign = await agenda({ listId: other.id, n: 5 });
    await plantLatch(foreign.sessionId);
    const mine = await agenda({ listId, n: 5 });
    expect(mine.sessionId).not.toBe(foreign.sessionId);
    expect(mine.deduped).toBeUndefined();
    expect((await getSessionRow(T, mine.sessionId))?.listId).toBe(listId);
  });
});
