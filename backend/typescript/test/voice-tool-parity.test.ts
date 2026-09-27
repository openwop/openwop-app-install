/**
 * ADR 0324 — voice ⇄ chat tool-execution SCOPE PARITY.
 *
 * The incident: in a live (realtime voice) conversation the model was offered the
 * ADR 0315 baseline tools and called `documents.draft` — but the voice bridge built
 * its execution scope by hand and omitted `actingUserId`/`conversationId`, so every
 * ADR 0308 deliverable tool failed closed (`acting_user_required`) over voice while
 * working over chat ("voice Iris can't draft what chat Iris drafts").
 *
 * The contract under test:
 *  1. BOTH transports (chat tool loop, realtime bridge) compose their executor
 *     through the ONE composer (`createScopedAgentToolProvider`) — pinned at the
 *     source level so a third hand-rolled scope can't reappear.
 *  2. The realtime bridge threads actingUserId + conversationId to the tool.
 *  3. The identity is HOST-bound (session registry / sideband session at mint,
 *     from the authenticated caller) — the client body can never name it.
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/index.js';
import { saveConfig, __clearToggleStore } from '../src/host/featureToggles/service.js';
import { voiceFeature } from '../src/features/voice/feature.js';
import { setSecret } from '../src/byok/secretResolver.js';
import { registerFeatureAgentTool, createScopedAgentToolProvider } from '../src/host/agentToolProvider.js';
import type { BundleScope } from '../src/host/inMemorySurfaces.js';
import { executeRealtimeToolCall } from '../src/features/voice/realtime/toolBridge.js';
import { issueRealtimeSession, resolveRealtimeSession, __evictRealtimeSessionForTests } from '../src/features/voice/realtime/sessionRegistry.js';
import { handleSidebandEvent, type SidebandSession } from '../src/features/voice/realtime/openaiSideband.js';
import { getAgentRegistry } from '../src/executor/agentRegistry.js';
import { __clearAgentIdentityCache } from '../src/host/agentIdentity.js';
import { hostExtStorage } from '../src/host/hostExtPersistence.js';

let BASE: string;
let server: http.Server;
const H = { authorization: 'Bearer dev-token', 'content-type': 'application/json' };
const post = (p: string, b?: unknown) => fetch(`${BASE}${p}`, { method: 'POST', headers: H, body: b === undefined ? undefined : JSON.stringify(b) });
const put = (p: string, b: unknown) => fetch(`${BASE}${p}`, { method: 'PUT', headers: H, body: JSON.stringify(b) });
const RT = '/v1/host/openwop-app/voice/realtime';

/** A scope-capturing probe tool (registered via the ADR 0308 D2 seam) — the
 *  tool's ONLY job is to record the BundleScope each transport hands it. */
const CAPTURE_TOOL = 'openwop:parity.capture-scope';
const captured: BundleScope[] = [];
const PARITY_AGENT = 'probe.0324.parity-agent';

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  process.env.OPENWOP_TEST_SEAM_ENABLED = 'true';
  process.env.OPENWOP_VOICE_MOCK = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });

  registerFeatureAgentTool({
    contentTrust: 'trusted',
    def: { name: CAPTURE_TOOL, description: 'test probe — captures the execution scope', inputSchema: { type: 'object' } },
    run: async (_input, scope) => { captured.push(scope); return { content: 'captured-ok' }; },
  });
  getAgentRegistry().register({
    agentId: PARITY_AGENT, persona: 'Parity Probe', modelClass: 'chat',
    systemPrompt: 'parity probe', toolAllowlist: [CAPTURE_TOOL], packName: 'test.parity-0324', packVersion: '0.0.1',
  });
  __clearAgentIdentityCache();
  await saveConfig({ ...voiceFeature.toggleDefault!, status: 'on' }, 'test');
  await setSecret('rt-parity-key', 'gk-test', { tenantId: 'default' });
  await put(`${RT}/config`, { provider: 'gemini-live', credentialRef: 'rt-parity-key' });
});
afterAll(async () => {
  delete process.env.OPENWOP_TEST_SEAM_ENABLED;
  delete process.env.OPENWOP_VOICE_MOCK;
  await __clearToggleStore();
  await new Promise<void>((res) => server.close(() => res()));
});

const srcOf = (rel: string): string => readFileSync(fileURLToPath(new URL(`../src/${rel}`, import.meta.url)), 'utf8');

describe('ADR 0324 §1 — one scope composer, pinned at the source level', () => {
  it('the chat tool loop composes its executor through createScopedAgentToolProvider (no hand-rolled scope)', () => {
    const src = srcOf('host/conversationToolLoop.ts');
    expect(src).toContain('createScopedAgentToolProvider(');
    // No direct provider construction left — a new scope field added to the
    // composer reaches this transport by construction.
    expect(/\bcreateAgentToolProvider\(/.test(src)).toBe(false);
  });

  it('the realtime bridge composes its EXECUTION scope through the composer (direct construction only for the scope-less decls resolver)', () => {
    const src = srcOf('features/voice/realtime/toolBridge.ts');
    expect(src).toContain('createScopedAgentToolProvider(');
    const direct = src.match(/\bcreateAgentToolProvider\(/g) ?? [];
    expect(direct.length, 'only the tool-DECLARATION resolver may bypass the composer').toBeLessThanOrEqual(1);
    if (direct.length === 1) {
      const line = src.split('\n').find((l) => /\bcreateAgentToolProvider\(/.test(l)) ?? '';
      expect(line, 'the direct call must be the _decls resolver, never an executor').toContain("'_decls'");
    }
  });

  it('the composer forwards every parity field verbatim (chat-shaped input)', async () => {
    const { executeTool } = createScopedAgentToolProvider({ tenantId: 'default', runId: 'run-parity-1', actingUserId: 'user-chat-1', conversationId: 'conv-chat-1', personalTenant: 'user:pt-chat-1' });
    const out = await executeTool({ name: CAPTURE_TOOL, input: {} });
    expect(out.isError).toBeUndefined();
    // ADR 0627 D3 (review S3) — `personalTenant` is a parity field too: it GRANTS
    // (the req-less tenant gates' implicit-owner rule), so a transport that
    // drops it fails closed for the owner of a personal sandbox.
    expect(captured.at(-1)).toMatchObject({ tenantId: 'default', runId: 'run-parity-1', actingUserId: 'user-chat-1', conversationId: 'conv-chat-1', personalTenant: 'user:pt-chat-1' });
  });
});

describe('ADR 0324 §2 — the realtime bridge threads the acting user + conversation', () => {
  it('a voice tool call executes with actingUserId + conversationId on its scope (chat parity)', async () => {
    const out = await executeRealtimeToolCall({
      tenantId: 'default', agentId: PARITY_AGENT, sessionId: 'sess-parity-1', name: CAPTURE_TOOL, args: {},
      actingUserId: 'user-voice-1', conversationId: 'conv-voice-1', personalTenant: 'user:pt-voice-1',
    });
    expect(out.status).toBe('ok');
    expect(captured.at(-1)).toMatchObject({
      tenantId: 'default', runId: 'voice:sess-parity-1', actingUserId: 'user-voice-1', conversationId: 'conv-voice-1', personalTenant: 'user:pt-voice-1',
    });
  });

  it('without an authenticated opener the deliverable-tool floor still fail-closes (no synthetic user)', async () => {
    const out = await executeRealtimeToolCall({
      tenantId: 'default', agentId: PARITY_AGENT, sessionId: 'sess-parity-2', name: CAPTURE_TOOL, args: {},
    });
    expect(out.status).toBe('ok');
    expect(captured.at(-1)!.actingUserId).toBeUndefined();
  });

  it('the OpenAI sideband threads the session OPENER as the acting user — also while a tool call runs delegated', async () => {
    const s: SidebandSession = { callId: 'rtc_parity', tenantId: 'default', agentId: PARITY_AGENT, conversationId: 'conv-sb-1', userId: 'user-sideband-1' };
    const out = await handleSidebandEvent(s, { type: 'response.function_call_arguments.done', name: CAPTURE_TOOL, call_id: 'fc_p1', arguments: '{}' });
    expect(JSON.stringify(out[0])).toContain('captured-ok');
    expect(captured.at(-1)).toMatchObject({ actingUserId: 'user-sideband-1', conversationId: 'conv-sb-1' });
  });
});

describe('ADR 0324 §3 — the identity is HOST-bound, never the client body', () => {
  it('the session registry round-trips the mint-time binding (and still rejects cross-tenant)', async () => {
    const id = issueRealtimeSession('default', PARITY_AGENT, { userId: 'user-bound-1', conversationId: 'conv-bound-1', personalTenant: 'user:pt-bound-1' });
    await expect(resolveRealtimeSession(id, 'default')).resolves.toEqual({ agentId: PARITY_AGENT, userId: 'user-bound-1', conversationId: 'conv-bound-1', personalTenant: 'user:pt-bound-1' });
    await expect(resolveRealtimeSession(id, 'other-tenant')).resolves.toBeNull();
  });

  it('CS-VX-1 — a resolve on a NON-minting instance recovers the binding from the durable row', async () => {
    const id = issueRealtimeSession('default', PARITY_AGENT, { userId: 'user-xinst-2', conversationId: 'conv-xinst-2' });
    await new Promise((r) => setTimeout(r, 25)); // the fire-and-forget persist settles
    // Simulate the request landing on another instance: evict ONLY the
    // in-memory cache entry — the durable fallback must recover the binding
    // (previously this was a hard 403: every voice tool broken for the call).
    __evictRealtimeSessionForTests(id);
    await expect(resolveRealtimeSession(id, 'default')).resolves.toEqual({ agentId: PARITY_AGENT, userId: 'user-xinst-2', conversationId: 'conv-xinst-2' });
  });

  it('a client-body actingUserId/conversationId on …/tool-call is IGNORED (only the mint binding governs)', async () => {
    const mint = await (await post(`${RT}/session`, { agentId: PARITY_AGENT, conversationId: 'conv-never-created' })).json() as { hostSessionId: string };
    const res = await post(`${RT}/tool-call`, {
      sessionId: mint.hostSessionId, callId: 'c_forge', name: CAPTURE_TOOL, arguments: {},
      actingUserId: 'attacker-forged-user', conversationId: 'attacker-forged-conv',
    });
    expect(res.status).toBe(200);
    expect((await res.json() as { status: string }).status).toBe('ok');
    const scope = captured.at(-1)!;
    expect(scope.actingUserId).not.toBe('attacker-forged-user');
    // 'conv-never-created' fails the existence gate at mint; the forged body value never lands.
    expect(scope.conversationId).toBeUndefined();
  });

  it('a REAL, visible conversation named at mint reaches the tool scope through the registry', async () => {
    const conversationId = 'conv-parity-bound';
    const now = new Date().toISOString();
    await hostExtStorage().createChatSession({ sessionId: conversationId, tenantId: 'default', title: 'Parity', createdAt: now, updatedAt: now, messageCount: 0 });
    const mint = await (await post(`${RT}/session`, { agentId: PARITY_AGENT, conversationId })).json() as { hostSessionId: string };
    const res = await post(`${RT}/tool-call`, { sessionId: mint.hostSessionId, callId: 'c_ok', name: CAPTURE_TOOL, arguments: {} });
    expect(res.status).toBe(200);
    expect((await res.json() as { status: string }).status).toBe('ok');
    expect(captured.at(-1)!.conversationId).toBe(conversationId);
  });
});
