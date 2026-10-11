/**
 * ADR 0277 P2 (cohort reconcile) / docs/steward/UX_UPGRADE-advisory-board.md R3.
 *
 * UX_UPGRADE low-tier R2 → advisory-board ROUND 3 — the two flagged silent
 * degradations, made OBSERVABLE with semantics unchanged.
 *
 * The cohort reconcile's own-board effective-kinds read used to fail silently
 * as [] ("nothing shared"): the reconcile then over-retained BY DESIGN (removed
 * advisors keep bindings until the next idempotent toggle/edit re-converges),
 * but a degraded pass was indistinguishable from a healthy one. R2 recorded
 * this open deliberately — a semantics "fix" against these binding rules is
 * riskier than the defect. R3 keeps every documented behaviour (over-retain,
 * never over-remove; never fail the caller) and adds a NAMED warn event
 * (`shared_knowledge_read_degraded`, with the phase) so an operator can see it.
 *
 * Sabotage-witnessed (/grade-tests w12): removing the warn reds cases 1 and 3;
 * rethrowing the read failure reds cases 1 and 3 (update fails; the delete's outer
 * catch logs a different event); always warning reds case 2; mislabelling the
 * delete phase, or skipping the row delete, reds case 3.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const warns: Array<{ msg: string; fields?: Record<string, unknown> }> = [];
vi.mock('../src/observability/logger.js', async (orig) => {
  const actual = await orig<typeof import('../src/observability/logger.js')>();
  return {
    ...actual,
    createLogger: (component: string) => {
      const real = actual.createLogger(component);
      return {
        ...real,
        warn: (msg: string, fields?: Record<string, unknown>) => { warns.push({ msg, fields }); real.warn(msg, fields); },
      };
    },
  };
});

let sharedKnowledgeFails = false;
vi.mock('../src/features/advisory-board/advisoryBoardKnowledgeService.js', async (orig) => {
  const actual = await orig<typeof import('../src/features/advisory-board/advisoryBoardKnowledgeService.js')>();
  return {
    ...actual,
    getBoardSharedKnowledge: async (...args: Parameters<typeof actual.getBoardSharedKnowledge>) => {
      if (sharedKnowledgeFails) throw new Error('kb binding store down');
      return actual.getBoardSharedKnowledge(...args);
    },
  };
});

import { openStorage } from '../src/storage/index.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { createRosterEntry } from '../src/host/rosterService.js';
import { createBoard, updateBoard, deleteBoard, getBoard } from '../src/features/advisory-board/service.js';

const T = 'tenant-ab-degraded';
let n = 0;

const degradedEvents = (): Array<Record<string, unknown> | undefined> =>
  warns.filter((w) => w.msg === 'shared_knowledge_read_degraded').map((w) => w.fields);

beforeEach(async () => {
  initHostExtPersistence(await openStorage('memory://'));
  warns.length = 0;
  sharedKnowledgeFails = false;
});

async function boardWithTwoAdvisors(): Promise<{ boardId: string; a: string; b: string; owner: string }> {
  const a = (await createRosterEntry({ tenantId: T, persona: `Advisor A${n}`, agentRef: { agentId: 'core.openwop.agents.brief-writer' } })).rosterId;
  const b = (await createRosterEntry({ tenantId: T, persona: `Advisor B${n}`, agentRef: { agentId: 'core.openwop.agents.brief-writer' } })).rosterId;
  n += 1;
  const owner = 'u-owner';
  const board = await createBoard(T, 'org-1', owner, { name: `Board ${n}`, advisors: [a, b] });
  return { boardId: board.boardId, a, b, owner };
}

describe('R3 — the degraded reconcile read is DISCLOSED, and its semantics are unchanged', () => {
  it('a failed shared-knowledge read during a cohort edit succeeds AND emits the named event', async () => {
    const { boardId, a, owner } = await boardWithTwoAdvisors();
    sharedKnowledgeFails = true;
    // The update (removing advisor b) must still succeed — a reconcile failure
    // never fails the board write (the documented best-effort contract).
    const updated = await updateBoard(T, owner, boardId, { advisors: [a] });
    expect(updated.advisors).toEqual([a]);
    const phases = degradedEvents().map((f) => f?.phase);
    expect(phases).toContain('update_cohort_reconcile');
  });

  it('a healthy cohort edit emits NO degraded event', async () => {
    const { boardId, a, owner } = await boardWithTwoAdvisors();
    const updated = await updateBoard(T, owner, boardId, { advisors: [a] });
    expect(updated.advisors).toEqual([a]);
    expect(degradedEvents()).toEqual([]);
  });

  it('a failed read during board delete still deletes, and names the delete phase', async () => {
    const { boardId, owner } = await boardWithTwoAdvisors();
    sharedKnowledgeFails = true;
    await deleteBoard(T, owner, boardId);
    await expect(getBoard(T, owner, boardId), 'the delete itself must still land').rejects.toMatchObject({ httpStatus: 404 });
    const phases = degradedEvents().map((f) => f?.phase);
    expect(phases).toContain('delete_cohort_reconcile');
  });
});
