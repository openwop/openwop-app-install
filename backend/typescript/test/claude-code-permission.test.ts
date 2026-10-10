/**
 * ADR 0785 P4 — a headless Claude Code task's permission prompts become approval
 * cards in the ONE queue, decided by the device's human.
 *
 * Through the real HTTP boundary, with the device's own key on the MCP mount:
 *   - `claude-code-permission` files a card, holds, and answers ALLOW (with the
 *     input echoed as `updatedInput`) once the owner claims it;
 *   - reject → DENY carrying the note;
 *   - nobody answers → DENY, and the card is closed (cannot be approved later);
 *   - the device's own key cannot decide (D7), nor can a co-tenant human; the card
 *     is invisible to that co-tenant (owner-only audience);
 *   - the stored card holds a summary + digest, never the raw input.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { getSetCookies } from './headerCookies.js';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { CLAUDE_CODE_OPERATOR_ENV, consentHash } from '../src/features/claude-code/constants.js';
import { __setPermissionWaitForTest, summarizePermission } from '../src/features/claude-code/mcpTools.js';
import { getApproval } from '../src/host/approvalService.js';

const CC = '/host/openwop-app/claude-code';
const MCP = '/host/openwop-app/mcp';
const APPROVALS = '/host/openwop-app/approvals';
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
afterAll(async () => { delete process.env[CLAUDE_CODE_OPERATOR_ENV]; await new Promise<void>((res) => server.close(() => res())); });
afterEach(() => { __setPermissionWaitForTest(null); });

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
async function human(tenantId: string) {
  const c = client();
  const subject = `ccperm-${Date.now()}-${n++}`;
  const r = await c.post('/host/openwop-app/test/login', { subject, tenantId, email: `${subject}@a.test` });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return c;
}
async function pairDevice(owner: ReturnType<typeof client>): Promise<string> {
  const anon = client();
  const s = await anon.post(`${CC}/pair/device/start`, { label: 'build box' });
  expect((await owner.post(`${CC}/pair/requests/${s.body.userCode}/approve`, { consentHash: consentHash() })).status).toBe(204);
  return (await anon.post(`${CC}/pair/device/poll`, { deviceCode: s.body.deviceCode })).body.token as string;
}
let rpcId = 0;
const askPermission = (device: ReturnType<typeof client>, toolName: string, input: Record<string, unknown>) =>
  device.post(MCP, { jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name: 'claude-code-permission', arguments: { tool_name: toolName, input, tool_use_id: 'tu_1' } } });
const answer = (r: Res): { behavior: string; updatedInput?: unknown; message?: string } => JSON.parse(r.body.result.content[0].text);

async function pendingCard(owner: ReturnType<typeof client>): Promise<{ approvalId: string; claudeCodePermission: Record<string, string> }> {
  for (let i = 0; i < 100; i += 1) {
    const list = await owner.get(`${APPROVALS}?status=pending&kind=claude-code-permission`);
    const item = (list.body?.items ?? [])[0];
    if (item) return item;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('no pending permission card appeared');
}

describe('ADR 0785 P4 — permission prompts as approval cards', () => {
  it('owner approves → ALLOW with the input echoed; the card stores a summary + digest, never the raw input', async () => {
    __setPermissionWaitForTest({ waitMs: 10_000, pollMs: 20 });
    const tenant = `org:ccperm-${Date.now()}`;
    const owner = await human(tenant);
    const device = client(await pairDevice(owner));
    const pending = askPermission(device, 'Bash', { command: 'rm -rf build', description: 'clean' });
    const card = await pendingCard(owner);
    expect(card.claudeCodePermission.tool).toBe('Bash');
    expect(card.claudeCodePermission.summary).toContain('rm -rf build');
    expect(JSON.stringify(card)).not.toContain('"description":"clean"');
    expect(card.claudeCodePermission.inputDigest).toMatch(/^[0-9a-f]{64}$/);

    expect((await owner.post(`${APPROVALS}/${card.approvalId}/claim`)).status).toBe(200);
    const r = await pending;
    expect(r.body.result?.isError, JSON.stringify(r.body)).toBe(false);
    expect(answer(r)).toEqual({ behavior: 'allow', updatedInput: { command: 'rm -rf build', description: 'clean' } });
  });

  it('owner rejects with a note → DENY carrying it', async () => {
    __setPermissionWaitForTest({ waitMs: 10_000, pollMs: 20 });
    const owner = await human(`org:ccperm-r-${Date.now()}`);
    const device = client(await pairDevice(owner));
    const pending = askPermission(device, 'Write', { file_path: '/etc/hosts', content: 'x' });
    const card = await pendingCard(owner);
    expect((await owner.post(`${APPROVALS}/${card.approvalId}/reject`, { note: 'not that file' })).status).toBe(200);
    expect(answer(await pending)).toEqual({ behavior: 'deny', message: 'Denied in the app: not that file' });
  });

  it('nobody answers → DENY, and the card is CLOSED so it cannot be approved into the void later', async () => {
    __setPermissionWaitForTest({ waitMs: 150, pollMs: 20 });
    const owner = await human(`org:ccperm-t-${Date.now()}`);
    const device = client(await pairDevice(owner));
    const r = await askPermission(device, 'WebFetch', { url: 'https://example.com' });
    expect(answer(r).behavior).toBe('deny');
    const closed = (await owner.get(`${APPROVALS}?status=rejected&kind=claude-code-permission`)).body.items[0];
    expect((await getApproval(closed.approvalId))?.status).toBe('rejected');
    expect((await owner.post(`${APPROVALS}/${closed.approvalId}/claim`)).status).toBe(409);
  });

  it('on_timeout:"defer" (the interactive hook) is told the prompt TIMED OUT — and the card is still closed', async () => {
    __setPermissionWaitForTest({ waitMs: 120, pollMs: 20 });
    const owner = await human(`org:ccperm-d-${Date.now()}`);
    const device = client(await pairDevice(owner));
    const r = await device.post(MCP, { jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name: 'claude-code-permission', arguments: { tool_name: 'Bash', input: { command: 'ls' }, on_timeout: 'defer' } } });
    expect(answer(r)).toMatchObject({ behavior: 'deny', timedOut: true });
    expect((await owner.get(`${APPROVALS}?status=pending&kind=claude-code-permission`)).body.items).toEqual([]);
  });

  it('the device key cannot decide its own prompt, a co-tenant cannot decide or even see it', async () => {
    __setPermissionWaitForTest({ waitMs: 3_000, pollMs: 20 });
    const tenant = `org:ccperm-x-${Date.now()}`;
    const owner = await human(tenant);
    const coTenant = await human(tenant);
    const token = await pairDevice(owner);
    const device = client(token);
    const pending = askPermission(device, 'Bash', { command: 'git push --force' });
    const card = await pendingCard(owner);

    const byKey = await device.post(`${APPROVALS}/${card.approvalId}/claim`);
    expect(byKey.status, 'a device key must never answer its own permission prompt').toBe(403);
    expect((await coTenant.get(`${APPROVALS}?status=pending&kind=claude-code-permission`)).body.items).toEqual([]);
    expect((await coTenant.post(`${APPROVALS}/${card.approvalId}/claim`)).status).toBe(403);

    expect((await owner.post(`${APPROVALS}/${card.approvalId}/reject`)).status).toBe(200);
    expect(answer(await pending).behavior).toBe('deny');
  });

  it('the summary names the tool and the one field a person needs, redacted and bounded', () => {
    expect(summarizePermission('Bash', { command: 'ls -la' })).toBe('Bash — ls -la');
    expect(summarizePermission('Edit', { file_path: '/repo/a.ts', old_string: 'x' })).toBe('Edit — /repo/a.ts');
    expect(summarizePermission('Custom', { a: 1, b: 2 })).toBe('Custom — a, b');
    expect(summarizePermission('Bash', { command: 'x'.repeat(1000) }).length).toBeLessThanOrEqual(300);
  });
});
