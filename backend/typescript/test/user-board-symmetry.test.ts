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
  createBoard,
  listBoards,
} from '../src/host/kanbanService.js';

describe('ADR 0025 — personal boards + polymorphic owner', () => {
  let server: http.Server;
  const PORT = 18951;

  beforeAll(async () => {
    process.env.OPENWOP_STORAGE_DSN = 'memory://';
    const app = await createApp({ port: PORT, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
    await new Promise<void>((res) => {
      server = app.listen(PORT, res);
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

  it('getPersonalBoard is tenant-isolated', async () => {
    await ensurePersonalBoard('ws:team', 'user:bob', "Bob's board");
    // a different workspace yields no board for the same user
    expect(await getPersonalBoard('ws:other', 'user:bob')).toBeNull();
  });
});
