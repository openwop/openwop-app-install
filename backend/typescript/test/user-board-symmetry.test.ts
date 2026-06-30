/**
 * User/Agent orchestration symmetry (ADR 0025 Phase 1) — a human user is a
 * board-owning principal exactly like a roster agent. Personal boards are
 * auto-provisioned idempotently and carry a polymorphic owner.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import { createApp } from '../src/index.js';
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

describe('ADR 0025 — personal boards + polymorphic owner', () => {
  let server: http.Server;

  beforeAll(async () => {
    process.env.OPENWOP_STORAGE_DSN = 'memory://';
    const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
    await new Promise<void>((res) => {
      server = app.listen(0, res);
    });
  });
  afterAll(async () => {
    await new Promise<void>((res) => server.close(() => res()));
  });

  it('ensurePersonalBoard is idempotent (deterministic id — no duplicate boards)', async () => {
    const a = await ensurePersonalBoard('user:alice', 'user:alice');
    const b = await ensurePersonalBoard('user:alice', 'user:alice');
    expect(a.id).toBe(b.id);
    expect(a.id).toBe(personalBoardId('user:alice', 'user:alice'));
    const boards = (await listBoards('user:alice')).filter((bd) => bd.ownerUserId === 'user:alice');
    expect(boards).toHaveLength(1);
  });

  it('a personal board has a {kind:user} owner; a roster board has {kind:agent}', async () => {
    const personal = await getPersonalBoard('user:alice', 'user:alice');
    expect(personal).not.toBeNull();
    expect(boardOwner(personal!)).toEqual({ kind: 'user', userId: 'user:alice' });

    const agentBoard = await createBoard({ tenantId: 'user:alice', name: "Sally's board", rosterId: 'host:sally-1' });
    expect(boardOwner(agentBoard)).toEqual({ kind: 'agent', rosterId: 'host:sally-1' });
  });

  it('ADR 0045 — listBoardsForSubject returns only that subject\'s boards (canonical owner query)', async () => {
    const T = 'tenant:subj';
    await ensurePersonalBoard(T, 'user:bob');
    await createBoard({ tenantId: T, name: 'Agent board', rosterId: 'host:agent-9' });

    const userBoards = await listBoardsForSubject(T, { kind: 'user', id: 'user:bob' });
    expect(userBoards).toHaveLength(1);
    expect(boardSubject(userBoards[0]!)).toEqual({ kind: 'user', id: 'user:bob' });

    const agentBoards = await listBoardsForSubject(T, { kind: 'agent', id: 'host:agent-9' });
    expect(agentBoards).toHaveLength(1);
    expect(boardSubject(agentBoards[0]!)).toEqual({ kind: 'agent', id: 'host:agent-9' });

    // No cross-subject bleed.
    expect(await listBoardsForSubject(T, { kind: 'user', id: 'user:nobody' })).toHaveLength(0);
  });

  it('getPersonalBoard is tenant-isolated', async () => {
    await ensurePersonalBoard('ws:team', 'user:bob', "Bob's board");
    // a different workspace yields no board for the same user
    expect(await getPersonalBoard('ws:other', 'user:bob')).toBeNull();
  });
});
