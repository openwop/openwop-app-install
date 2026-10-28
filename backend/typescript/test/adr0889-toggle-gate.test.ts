/**
 * ADR 0889 post-merge review H1 — the `evals` toggle (+ plan) is enforced by the
 * SERVER on every agent-eval surface: the host-extension routes, the normative
 * `POST /runs {mode:"eval"}` branch (before any run row or idempotency claim),
 * and the chat tools. Before the fix it was UI-only, so a workspace whose plan
 * excluded `evals` could still create suites and spend judge calls (TST-BPA).
 *
 * Red when (sabotage-witnessed, wave 65): the namespace middleware in
 * `routes/agentEvals.ts` stops calling `requireAgentEvalsEnabled`; the `mode:"eval"`
 * branch of `POST /runs` drops it; the run tool or the list tool skips
 * `agentEvalsToolGate`; or the refusal reason is no longer `feature_disabled`. The tool
 * calls run as the OWNER of a personal workspace (who holds the route's scope), with a
 * toggle-ON control, so only the toggle can be what refuses them.
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
import { evalWorkflowId, putEvalSuite, validateEvalSuite } from '../src/host/evals/suiteStore.js';
import type { BundleScope } from '../src/host/inMemorySurfaces.js';

let server: Server; let base = '';
const V2 = { Authorization: 'Bearer dev-token', 'Content-Type': 'application/json', 'OpenWOP-Version': '2' };
const AGENT = 'eval.toggle-agent';
const SUITE = { suiteId: 'test.acme.evals.toggle', version: '1.0.0', modes: ['golden'], tasks: [{ taskId: 't', input: {}, expected: { kind: 'golden', match: { strategy: 'contains', value: 'x' } } }] };
const REF = 'test.acme.evals.toggle@1.0.0';
const OWN_REF = 'test.acme.evals.toggle-own@1.0.0';
const OWNER: BundleScope = { tenantId: 'user:u-tg', actingUserId: 'u-tg', personalTenant: 'user:u-tg' };

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
    // The tools act for the owner of a personal workspace, who holds the route's scope:
    // with the toggle ON the same call lists the seeded suite (control), so OFF is the
    // only thing that can empty it.
    await putEvalSuite(OWNER.tenantId, validateEvalSuite({ ...SUITE, suiteId: 'test.acme.evals.toggle-own' }), 'user:u-tg');
    const on = JSON.parse((await builtinAgentTool('openwop:agent-evals.list-suites')!.run({}, OWNER)).content) as { items: Array<{ ref: string }> };
    expect(on.items.map((i) => i.ref)).toContain(OWN_REF);
    await withEvalsOff(async () => {
      const reasonOf = (r: { json: Record<string, unknown> }) => (r.json['details'] as Record<string, unknown> | undefined)?.['reason'];
      const put = await send('PUT', `/host/openwop-app/agent-evals/suites/${REF}`, SUITE);
      expect(put.status).toBe(403);
      expect(reasonOf(put)).toBe('feature_disabled');
      const list = await send('GET', '/host/openwop-app/agent-evals/suites');
      expect(list.status).toBe(403);
      expect(reasonOf(list)).toBe('feature_disabled');
      const capture = await send('GET', `/host/openwop-app/agent-evals/capture/${AGENT}`);
      expect(capture.status).toBe(403);
      expect(reasonOf(capture)).toBe('feature_disabled');

      const before = (await hostExtStorage().listRuns({ tenantId: 'default', workflowId: evalWorkflowId(REF), limit: 50 })).length;
      const create = await send('POST', '/runs', { mode: 'eval', evalSuiteRef: REF, agentId: AGENT });
      expect(create.status).toBe(403);
      expect(reasonOf(create)).toBe('feature_disabled');
      const after = (await hostExtStorage().listRuns({ tenantId: 'default', workflowId: evalWorkflowId(REF), limit: 50 })).length;
      expect(after).toBe(before);

      const run = await builtinAgentTool('openwop:agent-evals.run')!.run({ suiteRef: OWN_REF, agentId: AGENT }, OWNER);
      expect(run.isError).toBe(true);
      expect(JSON.parse(run.content).error).toBe('feature_disabled');
      const tools = await builtinAgentTool('openwop:agent-evals.list-suites')!.run({}, OWNER);
      expect(JSON.parse(tools.content)).toEqual({ items: [] });
      const after2 = (await hostExtStorage().listRuns({ tenantId: 'default', workflowId: evalWorkflowId(REF), limit: 50 })).length;
      expect(after2).toBe(before);
      expect(await hostExtStorage().listRuns({ tenantId: OWNER.tenantId, workflowId: evalWorkflowId(OWN_REF), limit: 50 })).toEqual([]);
    });
  });
});
