/**
 * ADR 0784 P2 — `GET /host/openwop-app/chat/tool-effects?names=`: the
 * effect of tools the caller saw, by name. Pins: known read and write resolve;
 * the provider-sanitized spelling resolves to the same tool; an unknown name is
 * OMITTED (never guessed); the list is capped; the route is reachable over HTTP.
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
    expect(r.body.effects).toEqual({ 'openwop:knowledge.search': 'read' });
  });

  it('caps the number of names answered', async () => {
    const many = Array.from({ length: TOOL_EFFECTS_MAX_NAMES + 10 }, () => 'openwop:knowledge.search');
    const r = await get([...many.slice(0, TOOL_EFFECTS_MAX_NAMES), 'openwop:kanban.add-todo']);
    expect(r.body.effects['openwop:kanban.add-todo']).toBeUndefined();
  });

  it('answers empty for no names', async () => {
    expect((await get([])).body).toEqual({ effects: {} });
  });
});
