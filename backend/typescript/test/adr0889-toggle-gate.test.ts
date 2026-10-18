/**
 * ADR 0889 post-merge review H1 — the `evals` toggle (+ plan) is enforced by the
 * SERVER on every agent-eval surface: the host-extension routes, the normative
 * `POST /runs {mode:"eval"}` branch (before any run row or idempotency claim),
 * and the chat tools. Before the fix it was UI-only, so a workspace whose plan
 * excluded `evals` could still create suites and spend judge calls.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createApp } from '../src/index.js';
import { getAgentRegistry } from '../src/executor/agentRegistry.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { builtinAgentTool } from '../src/host/agentToolProvider.js';
import { hostExtStorage } from '../src/host/hostExtPersistence.js';
import { evalWorkflowId } from '../src/host/evals/suiteStore.js';

let server: Server; let base = '';
const V2 = { Authorization: 'Bearer dev-token', 'Content-Type': 'application/json', 'OpenWOP-Version': '2' };
const AGENT = 'eval.toggle-agent';
const SUITE = { suiteId: 'test.acme.evals.toggle', version: '1.0.0', modes: ['golden'], tasks: [{ taskId: 't', input: {}, expected: { kind: 'golden', match: { strategy: 'contains', value: 'x' } } }] };
const REF = 'test.acme.evals.toggle@1.0.0';

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  process.env.OPENWOP_TEST_SEAM_ENABLED = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  server = await new Promise<Server>((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  getAgentRegistry().register({
    agentId: AGENT, persona: 'Eval subject', modelClass: 'research', systemPrompt: 'Answer.',
    packName: 'test', packVersion: '0', toolAllowlist: [], confidence: { defaultThreshold: 0.1 },
  });
});
afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });

async function send(method: string, path: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${base}${path}`, { method, headers: V2, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try { json = JSON.parse(text) as Record<string, unknown>; } catch { /* status asserted */ }
  return { status: res.status, json };
}

async function withEvalsOff(fn: () => Promise<void>): Promise<void> {
  const d = getToggleDefault('evals')!;
  await saveConfig({ ...d, status: 'off' }, 'test');
  try { await fn(); } finally { await saveConfig(d, 'test'); }
}

describe('ADR 0889 H1 — the evals toggle is enforced server-side', () => {
  it('ON: the surfaces work (control)', async () => {
    expect((await send('PUT', `/host/openwop-app/agent-evals/suites/${REF}`, SUITE)).status).toBe(200);
    expect((await send('GET', '/host/openwop-app/agent-evals/suites')).status).toBe(200);
  });

  it('OFF: suite routes refuse, POST /runs {mode:eval} refuses with no run row, and the tools refuse', async () => {
    await withEvalsOff(async () => {
      const put = await send('PUT', `/host/openwop-app/agent-evals/suites/${REF}`, SUITE);
      expect(put.status).toBe(403);
      expect((put.json['details'] as Record<string, unknown> | undefined)?.['reason']).toBe('feature_disabled');
      expect((await send('GET', '/host/openwop-app/agent-evals/suites')).status).toBe(403);
      expect((await send('GET', `/host/openwop-app/agent-evals/capture/${AGENT}`)).status).toBe(403);

      const before = (await hostExtStorage().listRuns({ tenantId: 'default', workflowId: evalWorkflowId(REF), limit: 50 })).length;
      const create = await send('POST', '/runs', { mode: 'eval', evalSuiteRef: REF, agentId: AGENT });
      expect(create.status).toBe(403);
      const after = (await hostExtStorage().listRuns({ tenantId: 'default', workflowId: evalWorkflowId(REF), limit: 50 })).length;
      expect(after).toBe(before);

      const scope = { tenantId: 'default', actingUserId: 'u-1' } as never;
      const run = await builtinAgentTool('openwop:agent-evals.run')!.run({ suiteRef: REF, agentId: AGENT }, scope);
      expect(run.isError).toBe(true);
      expect(JSON.parse(run.content).error).toBe('feature_disabled');
      const list = await builtinAgentTool('openwop:agent-evals.list-suites')!.run({}, scope);
      expect(JSON.parse(list.content)).toEqual({ items: [] });
      const after2 = (await hostExtStorage().listRuns({ tenantId: 'default', workflowId: evalWorkflowId(REF), limit: 50 })).length;
      expect(after2).toBe(before);
    });
  });
});
