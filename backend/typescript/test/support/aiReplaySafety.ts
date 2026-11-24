/**
 * Public-adapter replay safety harness.
 * Real SQLite/era storage, invocation/event logs, policy, managed key bootstrap
 * and provider dispatchers; only their closed HTTP response data is simulated.
 */
import { expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  createAiProvidersAdapter, __lastInvocationCacheKeyForTests, __lastReplayLaneKeyForTests,
} from '../../src/aiProviders/aiProvidersHost.js';
import { beginNodeActivity } from '../../src/host/effectIdentity.js';
import { currentEffectContext, runWithEffectContext, ReplayEffectError } from '../../src/host/runEffectContext.js';
import { openStorage } from '../../src/storage/index.js';
import { getInvocationLog, setInvocationBackend, type InvocationRecordKey } from '../../src/executor/invocationLog.js';
import { getEventLog, setEventLogBackend } from '../../src/executor/eventLog.js';
import { configureSecretResolver } from '../../src/byok/secretResolver.js';
import {
  bootstrapManagedProvider, configureManagedProvider, getManagedProviderStatuses,
  registerManagedTierConfigProvider,
} from '../../src/providers/managedProvider.js';
import { createHostAdapterSuite } from '../../src/host/index.js';
import { initHostExtPersistence } from '../../src/host/hostExtPersistence.js';
import { initInMemorySurfaces } from '../../src/host/inMemorySurfaces.js';
import type { RunRecord } from '../../src/types.js';

export { getInvocationLog, ReplayEffectError };
export const PATHS = ['byok-plain', 'managed-plain', 'byok-tools', 'managed-tools'] as const;
export type PublicPath = typeof PATHS[number];
type Adapter = ReturnType<typeof createAiProvidersAdapter>;
export type AdapterResult = Awaited<ReturnType<Adapter['callAI']>> | Awaited<ReturnType<Adapter['callAIWithTools']>>;
export type Storage = Awaited<ReturnType<typeof openStorage>>;
export const MODEL = 'gemini-2.5-flash';
export const SYSTEM = 'Return the diagnostic evidence unchanged.';
export const TOOL = 'fixture_lookup';
export const BYOK_REF = 'google:replay-safety-2918';
const BYOK_KEY = 'diagnostic-byok-not-a-real-key-2918';
const MANAGED_KEY = 'diagnostic-managed-not-a-real-key-2918';
const TENANT = 'user:replay-safety-2918';
const STREAM_URL = 'https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(MODEL) + ':streamGenerateContent?alt=sse';
const TOOLS_URL = 'https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(MODEL) + ':generateContent';
export const TOOLS = [{
  name: TOOL, description: 'Read fixture context',
  inputSchema: { type: 'object', properties: { topic: { type: 'string' } }, required: ['topic'] },
}];
export interface Input { text: string; maxTokens?: number }
export interface Lane {
  path: PublicPath; runId: string; nodeId: string;
  mode: 'live' | 'replay' | 'branch'; parentRunId?: string; adapter: Adapter;
}
export interface Plan {
  path: PublicPath; input: Input; answer: string; consumed: boolean;
}
export interface RequestObservation {
  url: string; method: string; body: unknown;
  context: { runId: string | null; nodeId: string | null; replaying: boolean | null };
}
export type Captured = { kind: 'returned'; value: AdapterResult } | { kind: 'thrown'; error: unknown };
export async function capture(work: () => Promise<AdapterResult>): Promise<Captured> {
  try { return { kind: 'returned', value: await work() }; }
  catch (error) { return { kind: 'thrown', error }; }
}
export function assertMissing(outcome: Captured): void {
  expect(outcome.kind, 'actual public call must refuse, not merely avoid transport').toBe('thrown');
  if (outcome.kind !== 'thrown') throw new Error('Expected a typed public replay refusal');
  expect(outcome.error).toBeInstanceOf(ReplayEffectError);
  if (!(outcome.error instanceof ReplayEffectError)) throw new Error('Replay refusal lost its host error class');
  expect(outcome.error.code).toBe('replay_source_missing');
  expect(outcome.error.message).not.toContain('PRIVATE_STORAGE_READ_2918');
  expect(outcome.error.message).not.toContain(BYOK_KEY);
  expect(outcome.error.message).not.toContain(MANAGED_KEY);
}
export function assertAnswer(result: AdapterResult, path: PublicPath, answer: string): void {
  expect(result.content, 'real dispatcher decoded the distinctive HTTP response').toBe(answer);
  expect(result.usage).toEqual({ inputTokens: 7, outputTokens: 3 });
  if (path.endsWith('tools')) {
    if (!('toolCalls' in result)) throw new Error('Expected a real tool-round result');
    expect(result.toolCalls).toEqual([{ id: 'gemini-' + TOOL + '-0', name: TOOL, input: { topic: answer } }]);
  }
}
const OWN_ENV = [
  'OPENWOP_STORAGE_DSN', 'OPENWOP_BYOK_EPHEMERAL', 'OPENWOP_MANAGED_PROVIDER', 'GOOGLE_MODEL',
  'GOOGLE_API_KEY', 'OPENWOP_LLM_CACHE_KEY_RECIPE_2', 'OPENWOP_DEPLOY_POSTURE',
  'OPENWOP_TEST_SEAM_ENABLED', 'OPENWOP_MOCK_PROVIDER_ENABLED',
] as const;
const MUST_BE_ABSENT = [
  'GOOGLE_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'MINIMAX_API_KEY',
  'OPENWOP_BYOK_ENCRYPTION_KEY', 'OPENWOP_BYOK_KMS_KEY', 'OPENWOP_BOOT_SECRETS', 'OPENWOP_SAMPLE_SECRETS',
  'OPENWOP_AI_POLICY_GOOGLE', 'OPENWOP_AI_POLICY_OPENAI', 'OPENWOP_AI_POLICY_ANTHROPIC', 'OPENWOP_AI_POLICY_MINIMAX',
  'OPENWOP_SABOTAGE_LLM_KEY',
] as const;
async function closeStorage(storage: Storage): Promise<void> {
  if (!('close' in storage) || typeof storage.close !== 'function') {
    throw new Error('The real memory storage must expose its close operation');
  }
  await storage.close();
}

export function inLane<T>(lane: Lane, work: () => T): T {
  beginNodeActivity(lane.runId, lane.nodeId, 1);
  return runWithEffectContext({
    runId: lane.runId, nodeId: lane.nodeId, tenantId: TENANT, attempt: 1, replaying: lane.mode === 'replay',
    ...(lane.mode === 'replay' && lane.parentRunId ? { replaySourceRunId: lane.parentRunId } : {}),
  }, work);
}

export async function createHarness(opts: { installInvocationLog?: boolean } = {}) {
  const savedEnv = new Map<string, string | undefined>(OWN_ENV.map(name => [name, process.env[name]]));
  const originalFetch = globalThis.fetch;
  const requests: RequestObservation[] = [];
  const forbidden: Array<{ method: string; url: string }> = [];
  const pending: Plan[] = [];
  let storage: Storage | undefined;
  let root: string | undefined;
  let closed = false;
  let envChanged = false;
  // Installed before runtime bootstrap. Unknown routes are never forwarded.
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    if (method !== 'POST' || (url !== STREAM_URL && url !== TOOLS_URL)) {
      forbidden.push({ method, url }); throw new Error('Unadmitted fixture transport');
    }
    if (typeof init?.body !== 'string') throw new Error('Expected the real serialized provider body');
    const body: unknown = JSON.parse(init.body);
    const context = currentEffectContext();
    requests.push({ url, method, body, context: {
      runId: context?.runId ?? null, nodeId: context?.nodeId ?? null, replaying: context?.replaying ?? null,
    } });
    const plan = pending.shift();
    if (!plan) throw new Error('Unexpected additional closed provider request');
    plan.consumed = true;
    const tools = plan.path.endsWith('tools');
    expect(url).toBe(tools ? TOOLS_URL : STREAM_URL);
    const expectedKey = plan.path.startsWith('managed') ? MANAGED_KEY : BYOK_KEY;
    if (new Headers(init?.headers).get('x-goog-api-key') !== expectedKey) {
      throw new Error('The real dispatcher used an unexpected credential');
    }
    expect(body).toMatchObject({
      contents: [{ role: 'user', parts: [{ text: plan.input.text }] }],
      systemInstruction: { parts: [{ text: expect.stringContaining(SYSTEM) }] },
      generationConfig: { maxOutputTokens: plan.input.maxTokens ?? 64 },
    });
    if (tools) expect(body).toMatchObject({ tools: [{ functionDeclarations: [{ name: TOOL }] }] });
    const parts: Array<Record<string, unknown>> = [{ text: plan.answer }];
    if (tools) parts.push({ functionCall: { name: TOOL, args: { topic: plan.answer } } });
    const reply = { candidates: [{ content: { parts }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 3 } };
    return tools
      ? new Response(JSON.stringify(reply), { status: 200, headers: { 'content-type': 'application/json' } })
      : new Response('data: ' + JSON.stringify(reply) + '\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  const cleanup = async () => {
    if (closed) return;
    closed = true;
    globalThis.fetch = originalFetch;
    try { if (storage) await closeStorage(storage); }
    finally {
      if (envChanged) for (const [name, value] of savedEnv) {
        if (value === undefined) delete process.env[name]; else process.env[name] = value;
      }
      if (root) rmSync(root, { recursive: true, force: true });
    }
  };
  try {
    for (const name of MUST_BE_ABSENT) {
      if (process.env[name] !== undefined) throw new Error('Fixture requires a sanitized native environment: ' + name);
    }
    envChanged = true;
    process.env.OPENWOP_STORAGE_DSN = 'memory://';
    process.env.OPENWOP_BYOK_EPHEMERAL = 'true';
    process.env.OPENWOP_MANAGED_PROVIDER = 'google';
    process.env.GOOGLE_MODEL = MODEL;
    process.env.GOOGLE_API_KEY = MANAGED_KEY;
    process.env.OPENWOP_LLM_CACHE_KEY_RECIPE_2 = 'false';
    process.env.OPENWOP_DEPLOY_POSTURE = 'cookie-per-visitor';
    process.env.OPENWOP_TEST_SEAM_ENABLED = 'true';
    process.env.OPENWOP_MOCK_PROVIDER_ENABLED = 'true';
    root = mkdtempSync(join(tmpdir(), 'ai-replay-safety-2918-'));
    storage = await openStorage('memory://');
    const db = storage;
    configureSecretResolver({ storage: db, dataDir: root });
    if (!existsSync(join(root, '.byok-master-key'))) {
      throw new Error('Fresh native process required: master key was already configured elsewhere');
    }
    initHostExtPersistence(db);
    initInMemorySurfaces({ dataDir: root });
    configureManagedProvider({ storage: db, dataDir: root });
    registerManagedTierConfigProvider(null);
    setEventLogBackend(db);
    if (opts.installInvocationLog !== false) setInvocationBackend(db);
    const policyResolver = createHostAdapterSuite({ storage: db }).providerPolicyResolver;
    await bootstrapManagedProvider();
    expect((await getManagedProviderStatuses()).find(row => row.providerId === 'openwop-free')).toMatchObject({ ready: true });
    const encrypted = await db.getEncryptedSecret('managed:openwop-free@google');
    expect(typeof encrypted).toBe('string');
    expect(encrypted).not.toContain(MANAGED_KEY);
    return {
      storage: db, requests, forbidden,
      installInvocationLog(): void { setInvocationBackend(db); },
      plan(path: PublicPath, input: Input, answer: string): Plan {
        const plan = { path, input, answer, consumed: false }; pending.push(plan); return plan;
      },
      retire(plan: Plan): void {
        const index = pending.indexOf(plan);
        if (index >= 0) pending.splice(index, 1);
      },
      assertDrained(): void { expect(pending, 'every planned positive HTTP response was consumed or explicitly retired').toEqual([]); expect(forbidden).toEqual([]); },
      async lane(path: PublicPath, options: { source?: Lane; mode?: 'replay' | 'branch'; nodeId?: string } = {}): Promise<Lane> {
        const runId = 'run-2918-' + randomUUID(), nodeId = options.nodeId ?? options.source?.nodeId ?? 'model-2918-' + randomUUID();
        const mode = options.source ? (options.mode ?? 'replay') : 'live';
        const now = new Date().toISOString();
        const run: RunRecord = {
          runId, tenantId: TENANT, workflowId: 'diagnostic.public-adapter-safety', status: 'running',
          inputs: {}, metadata: {}, configurable: {}, createdAt: now, updatedAt: now,
          ...(options.source ? { parentRunId: options.source.runId, parentSeq: 0, forkMode: mode === 'branch' ? 'branch' as const : 'replay' as const } : {}),
        };
        await db.insertRun(run);
        const adapter = createAiProvidersAdapter({
          runId, nodeId, tenantId: TENANT, attempt: 1, secrets: { [BYOK_REF]: BYOK_KEY }, policyResolver,
          ...(mode === 'replay' && options.source ? { replayInvocationsFromRunId: options.source.runId } : {}),
          emit: async (type, payload) => {
            const event = await getEventLog().append({ runId, nodeId, type, payload });
            return { eventId: event.eventId, sequence: event.sequence };
          },
        });
        return { path, runId, nodeId, mode, ...(options.source ? { parentRunId: options.source.runId } : {}), adapter };
      },
      invoke(lane: Lane, input: Input): Promise<AdapterResult> {
        const managed = lane.path.startsWith('managed');
        const base = {
          provider: managed ? 'openwop-free' : 'google', model: managed ? 'openwop-free' : MODEL,
          credentialRef: managed ? 'managed:openwop-free' : BYOK_REF,
          systemPrompt: SYSTEM, messages: [{ role: 'user' as const, content: input.text }], maxTokens: input.maxTokens ?? 64,
        };
        return inLane(lane, () => lane.path.endsWith('tools')
          ? lane.adapter.callAIWithTools({ ...base, tools: TOOLS })
          : lane.adapter.callAI(base));
      },
      key(lane: Lane): InvocationRecordKey {
        const key = lane.path === 'byok-plain' ? __lastInvocationCacheKeyForTests() : __lastReplayLaneKeyForTests();
        if (!key) throw new Error('The public adapter never reached its real invocation identity');
        expect(key.runId).toBe(lane.runId); expect(key.nodeId).toBe(lane.nodeId);
        return { runId: key.runId, nodeId: key.nodeId, attempt: key.attempt, invocationId: key.invocationId };
      },
      async usage(lane: Lane): Promise<unknown[]> {
        return (await getEventLog().list(lane.runId)).filter(event => event.type === 'provider.usage').map(event => event.payload);
      },
      close: cleanup,
    };
  } catch (error) { await cleanup(); throw error; }
}
export type Harness = Awaited<ReturnType<typeof createHarness>>;
