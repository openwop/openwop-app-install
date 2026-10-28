/**
 * User/Agent orchestration symmetry (ADR 0025 Phase 1, ADR 0045) — a human user
 * is a board-owning principal exactly like a roster agent. Personal boards are
 * auto-provisioned idempotently, carry a polymorphic owner, and are
 * tenant-isolated.
 *
 * Every case owns its tenant and provisions its own boards, so the file passes
 * in any order (it used to need case 1 to run before case 2). Persistence is the
 * DurableCollection layer only (no createApp boot: these are service calls).
 *
 * DOUBLE GUARD (named): `getPersonalBoard` is tenant-safe twice over — the
 * deterministic id hashes the tenant AND the read re-checks `b.tenantId`. A
 * single sabotage of either is vacuous by design; probe
 * ub-personal-cross-tenant defeats both.
 *
 * Witnessed (8f W4): ub-not-idempotent, ub-owner-kind, ub-subject-id-ignored,
 * ub-personal-cross-tenant, ub-listboards-tenant-r2.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { openStorage } from '../src/storage/index.js';
import {
  ensurePersonalBoard,
  getPersonalBoard,
  personalBoardId,
  boardOwner,
  boardSubject,
  listBoardsForSubject,
  createBoard,
  listBoards,
} from '../src/host/kanbanService.js';

let seq = 0;
const tenant = (label: string): string => `ws:ubs-${label}-${Date.now()}-${seq++}`;

describe('ADR 0025 — personal boards + polymorphic owner', () => {
  beforeAll(async () => {
    initHostExtPersistence(await openStorage('memory://'));
  });

  it('ensurePersonalBoard is idempotent (deterministic id — no duplicate boards)', async () => {
    const T = tenant('idem');
    const a = await ensurePersonalBoard(T, 'user:alice');
    const b = await ensurePersonalBoard(T, 'user:alice');
    expect(a.id).toBe(b.id);
    expect(a.id).toBe(personalBoardId(T, 'user:alice'));
    const boards = (await listBoards(T)).filter((bd) => bd.ownerUserId === 'user:alice');
    expect(boards).toHaveLength(1);
  });

  it('a personal board has a {kind:user} owner; a roster board has {kind:agent}', async () => {
    const T = tenant('owner');
    await ensurePersonalBoard(T, 'user:alice');
    const personal = await getPersonalBoard(T, 'user:alice');
    expect(personal).not.toBeNull();
    expect(boardOwner(personal!)).toEqual({ kind: 'user', userId: 'user:alice' });

    const agentBoard = await createBoard({ tenantId: T, name: "Sally's board", rosterId: 'host:sally-1' });
    expect(boardOwner(agentBoard)).toEqual({ kind: 'agent', rosterId: 'host:sally-1' });
  });

  it('ADR 0045 — listBoardsForSubject returns only that subject\'s boards (canonical owner query)', async () => {
    const T = tenant('subj');
    const OTHER = tenant('subj-other');
    // The same subjects own boards in ANOTHER tenant, so the tenant filter is
    // reachable: without it bob's and agent-9's lists would hold two boards.
    await ensurePersonalBoard(OTHER, 'user:bob');
    await createBoard({ tenantId: OTHER, name: 'Agent board elsewhere', rosterId: 'host:agent-9' });
    await ensurePersonalBoard(T, 'user:bob');
    await createBoard({ tenantId: T, name: 'Agent board', rosterId: 'host:agent-9' });

    const userBoards = await listBoardsForSubject(T, { kind: 'user', id: 'user:bob' });
    expect(userBoards.map((b) => b.tenantId)).toEqual([T]);
    expect(boardSubject(userBoards[0]!)).toEqual({ kind: 'user', id: 'user:bob' });

    const agentBoards = await listBoardsForSubject(T, { kind: 'agent', id: 'host:agent-9' });
    expect(agentBoards.map((b) => b.tenantId)).toEqual([T]);
    expect(boardSubject(agentBoards[0]!)).toEqual({ kind: 'agent', id: 'host:agent-9' });

    // No cross-subject bleed.
    expect(await listBoardsForSubject(T, { kind: 'user', id: 'user:nobody' })).toHaveLength(0);
  });

  it('getPersonalBoard is tenant-isolated', async () => {
    const TEAM = tenant('team');
    const OTHER = tenant('other');
    await ensurePersonalBoard(TEAM, 'user:bob', "Bob's board");
    // Positive control: the board exists where it was provisioned …
    expect((await getPersonalBoard(TEAM, 'user:bob'))?.name).toBe("Bob's board");
    // … and a different workspace yields no board for the same user.
    expect(await getPersonalBoard(OTHER, 'user:bob')).toBeNull();
  });
});
