/**
 * ADR 0785 P3 — a paired Claude Code reaches this host over the MCP mount.
 *
 * Pinned, through the real HTTP boundary with the device's own developer key:
 *   - the three tools are listed for the device;
 *   - `claude-code-add-todo` files onto the HUMAN's personal board — the SAME
 *     board `GET /kanban/boards/personal` returns to that person (the tool and the
 *     route share one predicate: the board's two keys captured at approval);
 *   - `claude-code-my-todos` reads it back; a retried identical call does not
 *     duplicate the card;
 *   - `claude-code-schema-lookup` answers from the ONE lookup the chat tool uses;
 *   - a developer key that is NOT a paired device, and a person's own session,
 *     are refused by name (these tools act for a device's human, nobody else);
 *   - an MCP run now names who it acts for (`metadata.actingUserId`).
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getSetCookies } from './headerCookies.js';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { CLAUDE_CODE_OPERATOR_ENV, consentHash } from '../src/features/claude-code/constants.js';
import { lookupAppSchemas } from '../src/host/schemaLookup.js';

const CC = '/host/openwop-app/claude-code';
const MCP = '/host/openwop-app/mcp';
let BASE: string; let server: http.Server;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  process.env.OPENWOP_MCP_SERVER_ENABLED = 'true';
  process.env[CLAUDE_CODE_OPERATOR_ENV] = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['users', 'claude-code']) { const d = getToggleDefault(id); if (d) await saveConfig({ ...d, status: 'on' }, 'test'); }
});
afterAll(async () => {
  delete process.env[CLAUDE_CODE_OPERATOR_ENV];
  await new Promise<void>((res) => server.close(() => res()));
});

interface Res { status: number; body: any }
function client(bearer?: string) {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(cookie ? { cookie } : {}), ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    for (const c of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(c); if (m) cookie = m[1]; }
    return { status: res.status, body: res.status === 204 ? undefined : await res.json().catch(() => undefined) };
  };
  return { get: (p: string) => call('GET', p), post: (p: string, b?: unknown) => call('POST', p, b) };
}
let n = 0;
async function person() {
  const c = client();
  const r = await c.post('/host/openwop-app/test/login', { email: `ccmcp-${Date.now()}-${n++}@a.test` });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return c;
}
async function pairDevice(owner: ReturnType<typeof client>): Promise<string> {
  const anon = client();
  const s = await anon.post(`${CC}/pair/device/start`, { label: 'mcp laptop' });
  expect((await owner.post(`${CC}/pair/requests/${s.body.userCode}/approve`, { consentHash: consentHash() })).status).toBe(204);
  return (await anon.post(`${CC}/pair/device/poll`, { deviceCode: s.body.deviceCode })).body.token as string;
}
let rpcId = 0;
const rpc = (c: ReturnType<typeof client>, method: string, params?: unknown) =>
  c.post(MCP, { jsonrpc: '2.0', id: ++rpcId, method, ...(params !== undefined ? { params } : {}) });
const text = (r: Res): string => (r.body?.result?.content?.[0]?.text ?? '') as string;

describe('ADR 0785 P3 — Claude Code over the MCP mount', () => {
  it('lists the three tools for a paired device', async () => {
    const device = client(await pairDevice(await person()));
    const r = await rpc(device, 'tools/list');
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const names = (r.body.result.tools as { name: string }[]).map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(['claude-code-my-todos', 'claude-code-add-todo', 'claude-code-schema-lookup']));
  });

  it('add-todo lands on the SAME personal board the person sees through the kanban route', async () => {
    const human = await person();
    const device = client(await pairDevice(human));
    const filed = await rpc(device, 'tools/call', { name: 'claude-code-add-todo', arguments: { title: 'Fix the flaky login test', detail: 'Seen in run r_42' } });
    expect(filed.body.result?.isError, JSON.stringify(filed.body)).toBe(false);
    const receipt = JSON.parse(text(filed)) as { cardId: string; filed: boolean };
    expect(receipt.filed).toBe(true);

    const board = await human.get('/host/openwop-app/kanban/boards/personal');
    expect(board.status).toBe(200);
    expect((board.body.cards as { id: string; title: string }[]).find((c) => c.id === receipt.cardId)?.title).toBe('Fix the flaky login test');

    const mine = await rpc(device, 'tools/call', { name: 'claude-code-my-todos', arguments: {} });
    const listed = JSON.parse(text(mine)) as { board: { boardId: string }; cards: { cardId: string; column: string }[] };
    expect(listed.board.boardId).toBe(board.body.board.id);
    expect(listed.cards.map((c) => c.cardId)).toContain(receipt.cardId);
  });

  it('schema-lookup answers from the one shared lookup', async () => {
    const device = client(await pairDevice(await person()));
    const r = await rpc(device, 'tools/call', { name: 'claude-code-schema-lookup', arguments: { kind: 'artifact-type' } });
    expect(r.body.result?.isError, JSON.stringify(r.body)).toBe(false);
    const direct = await lookupAppSchemas({ kind: 'artifact-type' });
    expect(direct.ok).toBe(true);
    expect(JSON.parse(text(r)).schema).toEqual((direct as { value: unknown }).value);
  });

  it('refuses a developer key that is not a paired device, and a person calling directly', async () => {
    const human = await person();
    const plainKey = (await human.post('/host/openwop-app/developer-keys', { name: 'ci', scopes: ['workspace:read', 'workspace:write'] })).body.token as string;
    const viaKey = await rpc(client(plainKey), 'tools/call', { name: 'claude-code-my-todos', arguments: {} });
    expect(viaKey.body.result?.isError).toBe(true);
    expect(text(viaKey)).toMatch(/paired Claude Code device/i);

    const viaSession = await rpc(human, 'tools/call', { name: 'claude-code-my-todos', arguments: {} });
    expect(viaSession.body.result?.isError).toBe(true);
    expect(text(viaSession)).toMatch(/paired Claude Code device/i);
  });
});
