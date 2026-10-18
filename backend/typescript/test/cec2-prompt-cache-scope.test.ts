/**
 * CEC-2 (RFC 0116 §43) — the host dispatch caller MUST populate
 * `cachePrefixScope` so the Anthropic prompt-cache prefix is namespaced by
 * `(tenant, cachePrefixId)`. Previously the marker mechanism existed
 * (`providers/promptCaching.ts`) and the dispatchers forwarded
 * `req.cachePrefixScope`, but `aiProvidersHost` never SET it — so the invariant
 * `prompt-prefix-cache-cross-tenant-isolation` (advertised by this reference
 * host) was proven only via the probe seam, dormant on the production path.
 *
 * These witnesses capture the request the host hands each dispatcher and assert
 * it carries `cachePrefixScope` with `tenant = scope.tenantId` and a stable,
 * secret-free `cachePrefixId` derived from model + system prompt + tool surface
 * (never the volatile messages). No caching-enabled / fetch / env setup is
 * needed: the host sets the scope UNCONDITIONALLY on the request; the dispatcher
 * applies the marker only when caching is on.
 *
 * Sabotage (grade-tests w28): stamping another field as `tenant`, dropping the
 * scope from either dispatch call, putting the credential into the id, or keying
 * the id on messages / dropping model, system or tools from it turns cases 1–3 red.
 */
import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import type { AiProviderPolicy, ProviderPolicyResolver } from '../src/host/index.js';
import type { dispatchAnthropicToolsRound } from '../src/providers/dispatchAnthropicTools.js';
import type { dispatchChat } from '../src/providers/dispatch.js';
import { setInvocationBackend } from '../src/executor/invocationLog.js';
import { openStorage } from '../src/storage/index.js';

type ToolsReq = Parameters<typeof dispatchAnthropicToolsRound>[0];
type ChatReq = Parameters<typeof dispatchChat>[0];

const cap = vi.hoisted(() => ({ tools: [] as ToolsReq[], chat: [] as ChatReq[] }));
vi.mock('../src/providers/dispatchAnthropicTools.js', async (orig) => ({
  ...(await orig<typeof import('../src/providers/dispatchAnthropicTools.js')>()),
  dispatchAnthropicToolsRound: (req: ToolsReq) => {
    cap.tools.push(req);
    return Promise.resolve({ text: 'ok', toolUses: [], finishReason: 'end_turn', inputTokens: 1, outputTokens: 1 });
  },
}));
vi.mock('../src/providers/dispatch.js', async (orig) => ({
  ...(await orig<typeof import('../src/providers/dispatch.js')>()),
  dispatchChat: (req: ChatReq) => {
    cap.chat.push(req);
    return Promise.resolve({ completion: 'ok', usage: { inputTokens: 1, outputTokens: 1 }, finishReason: 'end_turn', model: 'm' });
  },
}));

const { createAiProvidersAdapter } = await import('../src/aiProviders/aiProvidersHost.js');

// The plain callAI path consults the invocation log (replay memoization); install
// an in-memory backend so the lookup misses and dispatch proceeds. No app boot.
beforeAll(async () => {
  setInvocationBackend(await openStorage('memory://'));
});

function buildScope(secrets: Record<string, string>, policies?: AiProviderPolicy[]): Parameters<typeof createAiProvidersAdapter>[0] {
  const policyResolver: ProviderPolicyResolver = { async resolveForRun() { return policies ?? []; } };
  return { runId: 'test-run', nodeId: 'test-node', tenantId: 'tenant-A', attempt: 1, secrets, policyResolver };
}
const toolsReqs = (): ToolsReq[] => cap.tools;
const chatReqs = (): ChatReq[] => cap.chat;

beforeEach(() => { cap.tools = []; cap.chat = []; });

describe('CEC-2 — host stamps (tenant, cachePrefixId) onto the provider dispatch request', () => {
  it('callAIWithTools passes cachePrefixScope = { tenant: scope.tenantId, cachePrefixId } to the Anthropic tools dispatcher', async () => {
    await createAiProvidersAdapter(buildScope({ anthropic: 'sk-secret-xyz' })).callAIWithTools({
      provider: 'anthropic', model: 'claude-x', systemPrompt: 'You are careful.',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ name: 'foo', description: 'd', inputSchema: { type: 'object' } }],
    });
    expect(toolsReqs()).toHaveLength(1);
    const s = toolsReqs()[0]!.cachePrefixScope;
    expect(s?.tenant).toBe('tenant-A');
    // A sha256 hex digest of the stable prefix — not an opaque/secret string.
    expect(s?.cachePrefixId).toMatch(/^[0-9a-f]{64}$/);
    // §42 — the MARKER (tenant + cachePrefixId) is derived from prompt+tools+model,
    // NEVER secret material. (The dispatch request itself carries `apiKey` for auth,
    // as it must — the invariant is that the CACHE-SCOPE marker is secret-free.)
    expect(JSON.stringify(s)).not.toContain('sk-secret-xyz');
  });

  it('callAI (plain) passes cachePrefixScope to the chat dispatcher', async () => {
    await createAiProvidersAdapter(buildScope({ anthropic: 'sk-secret-xyz' })).callAI({
      provider: 'anthropic', model: 'claude-x', systemPrompt: 'You are careful.',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(chatReqs()).toHaveLength(1);
    const s = chatReqs()[0]!.cachePrefixScope;
    expect(s?.tenant).toBe('tenant-A');
    expect(s?.cachePrefixId).toMatch(/^[0-9a-f]{64}$/);
  });

  it('cachePrefixId is STABLE across turns (same model+system+tools) but DIFFERS when the prefix changes', async () => {
    const FOO = { name: 'foo', description: 'd', inputSchema: { type: 'object' } };
    const BAR = { name: 'bar', description: 'd', inputSchema: { type: 'object' } };
    const call = (systemPrompt: string, userMsg: string, model = 'claude-x', tool = FOO) =>
      createAiProvidersAdapter(buildScope({ anthropic: 'sk' })).callAIWithTools({
        provider: 'anthropic', model, systemPrompt,
        messages: [{ role: 'user', content: userMsg }],
        tools: [tool],
      });
    await call('SAME SYSTEM', 'turn one');
    await call('SAME SYSTEM', 'turn two — different volatile message');
    await call('DIFFERENT SYSTEM', 'turn three');
    await call('SAME SYSTEM', 'turn four', 'claude-y');
    await call('SAME SYSTEM', 'turn five', 'claude-x', BAR);
    const [id1, id2, idSystem, idModel, idTools] = toolsReqs().map((r) => r.cachePrefixScope?.cachePrefixId);
    // Excludes volatile messages ⇒ stable across turns (cache actually hits)…
    expect(id2).toBe(id1);
    // …but changes when any part of the cacheable prefix changes.
    expect(idSystem).not.toBe(id1);
    expect(idModel).not.toBe(id1);
    expect(idTools).not.toBe(id1);
  });
});
