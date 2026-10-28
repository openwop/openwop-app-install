/**
 * ADR 0784 P2 — `GET /host/openwop-app/chat/tool-effects?names=`: the
 * effect of tools the caller saw, by name. Pins: known read and write resolve;
 * the provider-sanitized spelling resolves to the same tool; an unknown name is
 * OMITTED (never guessed); the list is capped; the route is reachable over HTTP.
 *
 * What breaks if this goes red: the turn receipt ("2 reads · 1 change")
 * mislabels a tool, guesses an effect for an unknown one, or answers an
 * unbounded list. Wave 61: the cap is pinned as the literal 50 and tested at
 * the boundary from both sides (the 50th name is answered, the 51st is not),
 * rather than built from the imported constant.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { TOOL_EFFECTS_MAX_NAMES } from '../src/host/toolEffects.js';

let BASE: string;
let server: http.Server;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

const get = async (names: string[]) => {
  const r = await fetch(`${BASE}/host/openwop-app/chat/tool-effects?names=${encodeURIComponent(names.join(','))}`);
  return { status: r.status, body: await r.json() as { effects: Record<string, string> } };
};

describe('chat/tool-effects (ADR 0784 P2)', () => {
  it('resolves known reads and writes, by id and by the sanitized spelling', async () => {
    const r = await get(['openwop:knowledge.search', 'openwop:kanban.add-todo', 'openwop_kanban_add-todo']);
    expect(r.status).toBe(200);
    expect(r.body.effects).toEqual({
      'openwop:knowledge.search': 'read',
      'openwop:kanban.add-todo': 'write',
      'openwop_kanban_add-todo': 'write',
    });
  });

  it('omits an unknown name rather than guessing', async () => {
    const r = await get(['mcp__github__create_issue', 'openwop:knowledge.search']);
    expect(r.status).toBe(200);
    expect(r.body.effects).toEqual({ 'openwop:knowledge.search': 'read' });
  });

  it('caps the number of names answered', async () => {
    expect(TOOL_EFFECTS_MAX_NAMES).toBe(50);
    const fill = (n: number): string[] => Array.from({ length: n }, () => 'openwop:knowledge.search');
    // 49 + 1: the write is the 50th name, inside the cap, so it is answered…
    const inside = await get([...fill(49), 'openwop:kanban.add-todo']);
    expect(inside.status).toBe(200);
    expect(inside.body.effects).toEqual({ 'openwop:knowledge.search': 'read', 'openwop:kanban.add-todo': 'write' });
    // …50 + 1: it is the 51st, past the cap, so it is not.
    const past = await get([...fill(50), 'openwop:kanban.add-todo']);
    expect(past.status).toBe(200);
    expect(past.body.effects).toEqual({ 'openwop:knowledge.search': 'read' });
  });

  it('answers empty for no names', async () => {
    const r = await get([]);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ effects: {} });
  });
});
