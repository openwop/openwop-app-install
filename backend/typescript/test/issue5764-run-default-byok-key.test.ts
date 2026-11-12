/**
 * Issue #5764 — a workspace BYOK binding's key reaches a run that names none.
 *
 * Route-level on purpose: the binding is set through `PUT /byok/active-config`
 * with a key stored through `POST /byok/secrets`, and the run is started through
 * `POST /runs` with ONLY a workflowId (no `configurable.ai.credentialRef`), as a
 * server-started run is. Its one node calls `ctx.callAI` naming no provider, and
 * the synthetic vendor boundary records which key it received.
 *
 * Before the fix the run froze `{provider, model, source:'workspace'}` without
 * the ref, nothing seeded the key, and the step failed `byok_required`.
 *
 * A key cannot be deleted while a binding names it (the vault answers 409), so
 * "the bound key vanished" is covered by the unit cases (a ref not stored, or
 * stored but no longer resolving, freezes no name).
 *
 * Sabotage-witnessed: dropping `credentialRef` from the workspace freeze in
 * `resolveFrozenAiDefault`, or removing the frozen-ref seeding in
 * `prepareRunSecrets`, reds the first case.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/index.js';
import { getSetCookies } from './headerCookies.js';
import { registerWorkflow } from '../src/host/workflowsRegistry.js';
import { recordOwnership } from '../src/host/workflowOwnership.js';
import { getNodeRegistry } from '../src/executor/nodeRegistry.js';
import { getDefaultModel } from '../src/providers/catalog.js';
import { configureSecretResolver, clearCache } from '../src/byok/secretResolver.js';
import { resetCachedMasterKey } from '../src/byok/encryption.js';
import { RUN_AI_DEFAULT_KEY } from '../src/host/runAiDefault.js';
import type { Storage } from '../src/storage/storage.js';
import { bareRunId } from './support/bareRunId.js';

const KEY_VALUE = 'qa-synthetic-workspace-anthropic-value';
const REF = 'anthropic:acme';
const PROBE = 'test.issue5764-unnamed-ai-probe';
const TERMINAL = new Set(['completed', 'failed', 'cancelled']);
const nativeFetch = globalThis.fetch;
const seenKeys: string[] = [];
const probeErrors: string[] = [];
let server: Server;
let BASE = '';
let storage: Storage;
let n = 0;

beforeAll(async () => {
  resetCachedMasterKey();
  clearCache();
  vi.stubEnv('OPENWOP_BYOK_ENCRYPTION_KEY', '29'.repeat(32));
  vi.stubEnv('OPENWOP_STORAGE_DSN', 'memory://');
  vi.stubEnv('OPENWOP_SESSION_SECRET', 'test-session-secret-at-least-32-characters-long');
  vi.stubEnv('OPENWOP_TEST_AUTH_ENABLED', 'true');
  vi.stubEnv('OPENWOP_AUTH_DISABLE_COOKIES', 'false');
  vi.stubEnv('OPENWOP_BOOT_SECRETS', '{}');
  vi.stubEnv('OPENWOP_SAMPLE_SECRETS', '{}');
  vi.stubEnv('OPENWOP_BYOK_EPHEMERAL', 'false');
  vi.stubEnv('ANTHROPIC_API_KEY', '');
  vi.stubEnv('MINIMAX_API_KEY', '');
  vi.stubEnv('OPENWOP_RELEASE_BUS', 'off');
  // Loopback app HTTP passes through; the only vendor is a synthetic Anthropic.
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (BASE && url.origin === BASE) return nativeFetch(input, init);
    if (url.hostname === 'api.anthropic.com') {
      seenKeys.push(new Headers(init?.headers).get('x-api-key') ?? '');
      const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
      if (body && typeof body === 'object' && 'stream' in body && body.stream === true) {
        const events = [
          { type: 'message_start', message: { usage: { input_tokens: 1, output_tokens: 0 } } },
          { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
          { type: 'content_block_stop', index: 0 },
          { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
          { type: 'message_stop' },
        ];
        return new Response(events.map((e) => 'event: ' + e.type + '\ndata: ' + JSON.stringify(e) + '\n\n').join(''), { headers: { 'content-type': 'text/event-stream' } });
      }
      return new Response(JSON.stringify({ id: 'msg', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    throw new Error('Unexpected egress in issue #5764 fixture: ' + url.origin);
  }));
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  storage = app.locals.storage as Storage;
  configureSecretResolver({ storage, dataDir: mkdtempSync(join(tmpdir(), 'issue5764-')) });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  getNodeRegistry().register({
    typeId: PROBE, version: '1.0.0',
    async execute(ctx) {
      if (!ctx.callAI) throw new Error('executor AI seam missing');
      try {
        // Empty names: the real withRunAiDefault unnamed-provider branch.
        await ctx.callAI({ provider: '', model: '', messages: [{ role: 'user', content: 'Say ok.' }] });
        return { status: 'success', outputs: { ok: true } };
      } catch (err) {
        probeErrors.push(err instanceof Error ? err.message : String(err));
        throw err;
      }
    },
  });
});
afterAll(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await new Promise<void>((res) => (server ? server.close(() => res()) : res()));
});

function client() {
  let cookie = '';
  return async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]; }
    return { status: res.status, body: (await res.json().catch(() => undefined)) as Record<string, unknown> | undefined };
  };
}
async function waitTerminal(runId: string): Promise<string> {
  for (let i = 0; i < 200; i += 1) {
    const run = await storage.getRun(runId);
    if (run && TERMINAL.has(run.status)) return run.status;
    await new Promise((r) => setTimeout(r, 25));
  }
  return (await storage.getRun(runId))?.status ?? 'missing';
}
async function workspaceWithBinding() {
  const call = client();
  const tenantId = `org:issue5764-${Date.now()}-${n++}`;
  expect((await call('POST', '/host/openwop-app/test/login', { email: `owner-${n}@acme.test`, tenantId })).status).toBe(201);
  const stored = await call('POST', '/host/openwop-app/byok/secrets', { credentialRef: REF, value: KEY_VALUE });
  expect(stored.status, JSON.stringify(stored.body)).toBe(201);
  const bound = await call('PUT', '/host/openwop-app/byok/active-config', { provider: 'anthropic', model: getDefaultModel('anthropic'), credentialRef: REF });
  expect(bound.status, JSON.stringify(bound.body)).toBe(200);
  const workflowId = `wf-issue5764-${n}`;
  registerWorkflow({ workflowId, metadata: { name: 'issue 5764 probe' }, nodes: [{ nodeId: 'ai', typeId: PROBE }], edges: [] });
  await recordOwnership(tenantId, workflowId, { name: 'issue 5764 probe', nodeCount: 1 });
  return { call, tenantId, workflowId };
}

describe('issue #5764 — a server-started run uses the workspace binding\'s key', () => {
  it('POST /runs with only a workflowId: the AI step receives the bound key, and the run froze its NAME only', async () => {
    const { call, workflowId } = await workspaceWithBinding();
    seenKeys.length = 0; probeErrors.length = 0;
    const started = await call('POST', '/runs', { workflowId, inputs: {} });
    expect(started.status, JSON.stringify(started.body)).toBe(201);
    const runId = bareRunId(String(started.body?.runId));
    expect(await waitTerminal(runId), probeErrors.join(' | ')).toBe('completed');
    expect(seenKeys).toEqual([KEY_VALUE]);
    const run = await storage.getRun(runId);
    expect((run?.metadata as Record<string, unknown> | undefined)?.[RUN_AI_DEFAULT_KEY]).toMatchObject({ provider: 'anthropic', source: 'workspace', credentialRef: REF });
    // A name on run metadata, never the value; the run's own configurable is untouched.
    expect(JSON.stringify(run)).not.toContain(KEY_VALUE);
    expect(JSON.stringify(run?.configurable ?? {})).not.toContain(REF);
  });

});
