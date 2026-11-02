/**
 * ADR 0785 P3 — a paired Claude Code reaches this host over the MCP mount.
 *
 * Pinned, through the real HTTP boundary with the device's own developer key:
 *   - the four tools are listed for the device (add-todo, my-todos,
 *     schema-lookup, and the ADR 0785 P4 permission tool);
 *   - `claude-code-add-todo` files onto the HUMAN's personal board — the SAME
 *     board `GET /kanban/boards/personal` returns to that person (the tool and the
 *     route share one predicate: the board's two keys captured at approval);
 *   - `claude-code-my-todos` reads it back;
 *   - `claude-code-schema-lookup` answers from the ONE lookup the chat tool uses;
 *   - a developer key that is NOT a paired device, and a person's own session,
 *     are refused by name (these tools act for a device's human, nobody else).
 *
 * > CORRECTED 2026-10-29 (/grade-tests w67, TST-CEE-4): this header also claimed
 * > "a retried identical call does not duplicate the card" and "an MCP run names
 * > who it acts for (`metadata.actingUserId`)". Neither was asserted here. The
 * > add-todo card id hashes `ctx.runId` (`features/claude-code/mcpTools.ts:101`),
 * > so the dedupe is PER RUN (an executor retry of the node); a client that
 * > re-sends the same `tools/call` starts a new run and files a second card —
 * > recorded as grade-code row CCMCP-RETRY-1, not claimed here.
 *
 * Red when (w67g3, witnessed): the device check is bypassed (both of its guards
 * — `acting.startsWith('apikey:')` and `deviceForKey(...) !== null` — return the
 * same refusal, so this is a recorded double guard and the witness breaks both).
 * Ceiling: filing onto `device.tenantId/subject` instead of
 * `personalTenant/ownerUserId` is the same board for a test-login user (their
 * personal workspace IS the device's tenant), so that mutant is equivalent here.
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

interface Res<T> { status: number; body: T }
interface RpcResult { result?: { isError?: boolean; tools?: Array<{ name: string }>; content?: Array<{ text?: string }> } }
interface Pairing { userCode: string; deviceCode: string; token: string }
interface Board { board: { id: string }; cards: Array<{ id: string; title: string }> }
function client(bearer?: string) {
  let cookie = '';
  const call = async <T>(method: string, path: string, body?: unknown): Promise<Res<T>> => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(cookie ? { cookie } : {}), ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    for (const c of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(c); if (m) cookie = m[1]; }
    const text = await res.text();
    return { status: res.status, body: (text ? JSON.parse(text) : {}) as T };
  };
  return { get: <T>(p: string) => call<T>('GET', p), post: <T>(p: string, b?: unknown) => call<T>('POST', p, b) };
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
  const s = await anon.post<Pairing>(`${CC}/pair/device/start`, { label: 'mcp laptop' });
  expect((await owner.post(`${CC}/pair/requests/${s.body.userCode}/approve`, { consentHash: consentHash() })).status).toBe(204);
  return (await anon.post<Pairing>(`${CC}/pair/device/poll`, { deviceCode: s.body.deviceCode })).body.token;
}
let rpcId = 0;
const rpc = (c: ReturnType<typeof client>, method: string, params?: unknown) =>
  c.post<RpcResult>(MCP, { jsonrpc: '2.0', id: ++rpcId, method, ...(params !== undefined ? { params } : {}) });
const text = (r: Res<RpcResult>): string => r.body.result?.content?.[0]?.text ?? '';

describe('ADR 0785 P3 — Claude Code over the MCP mount', () => {
  it('lists the four claude-code tools for a paired device', async () => {
    const device = client(await pairDevice(await person()));
    const r = await rpc(device, 'tools/list');
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const names = (r.body.result?.tools ?? []).map((t) => t.name).filter((n) => n.startsWith('claude-code-')).sort();
    expect(names).toEqual(['claude-code-add-todo', 'claude-code-my-todos', 'claude-code-permission', 'claude-code-schema-lookup']);
  });

  it('add-todo lands on the SAME personal board the person sees through the kanban route', async () => {
    const human = await person();
    const device = client(await pairDevice(human));
    const filed = await rpc(device, 'tools/call', { name: 'claude-code-add-todo', arguments: { title: 'Fix the flaky login test', detail: 'Seen in run r_42' } });
    expect(filed.body.result?.isError, JSON.stringify(filed.body)).toBe(false);
    const receipt = JSON.parse(text(filed)) as { cardId: string; filed: boolean };
    expect(receipt.filed).toBe(true);

    const board = await human.get<Board>('/host/openwop-app/kanban/boards/personal');
    expect(board.status).toBe(200);
    expect(board.body.cards.find((c) => c.id === receipt.cardId)?.title).toBe('Fix the flaky login test');

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
    const plainKey = (await human.post<{ token: string }>('/host/openwop-app/developer-keys', { name: 'ci', scopes: ['workspace:read', 'workspace:write'] })).body.token;
    const viaKey = await rpc(client(plainKey), 'tools/call', { name: 'claude-code-my-todos', arguments: {} });
    expect(viaKey.body.result?.isError).toBe(true);
    expect(text(viaKey)).toMatch(/paired Claude Code device/i);

    const viaSession = await rpc(human, 'tools/call', { name: 'claude-code-my-todos', arguments: {} });
    expect(viaSession.body.result?.isError).toBe(true);
    expect(text(viaSession)).toMatch(/paired Claude Code device/i);
  });
});
