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
 * secret-free `cachePrefixId`. No caching-enabled / fetch / env setup is needed:
 * the host sets the scope UNCONDITIONALLY on the request; the dispatcher applies
 * the marker only when caching is on.
 */
import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import type { AiProviderPolicy, ProviderPolicyResolver } from '../src/host/index.js';

const cap = vi.hoisted(() => ({ tools: [] as unknown[], chat: [] as unknown[] }));
vi.mock('../src/providers/dispatchAnthropicTools.js', async (orig) => ({
  ...(await orig<typeof import('../src/providers/dispatchAnthropicTools.js')>()),
  dispatchAnthropicToolsRound: (req: unknown) => {
    cap.tools.push(req);
    return Promise.resolve({ text: 'ok', toolUses: [], finishReason: 'end_turn', inputTokens: 1, outputTokens: 1 });
  },
}));
vi.mock('../src/providers/dispatch.js', async (orig) => ({
  ...(await orig<typeof import('../src/providers/dispatch.js')>()),
  dispatchChat: (req: unknown) => {
    cap.chat.push(req);
    return Promise.resolve({ completion: 'ok', usage: { inputTokens: 1, outputTokens: 1 }, finishReason: 'end_turn', model: 'm' });
  },
}));

const { createAiProvidersAdapter } = await import('../src/aiProviders/aiProvidersHost.js');

// The plain callAI path wraps dispatch in the invocation-log memoization, whose
// backend is installed at app bootstrap — construct the app once so it's present
// (no need to listen; construction installs the host backends).
beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_INSTALL_PACKS = 'none';
  const { createApp } = await import('../src/index.js');
  await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
});

function buildScope(secrets: Record<string, string>, policies?: AiProviderPolicy[]): Parameters<typeof createAiProvidersAdapter>[0] {
  const policyResolver: ProviderPolicyResolver = { async resolveForRun() { return policies ?? []; } };
  return { runId: 'test-run', nodeId: 'test-node', tenantId: 'tenant-A', attempt: 1, secrets, policyResolver };
}
const scopeOf = (req: unknown): { tenant?: string; cachePrefixId?: string } | undefined =>
  (req as { cachePrefixScope?: { tenant?: string; cachePrefixId?: string } }).cachePrefixScope;

beforeEach(() => { cap.tools = []; cap.chat = []; });

describe('CEC-2 — host stamps (tenant, cachePrefixId) onto the provider dispatch request', () => {
  it('callAIWithTools passes cachePrefixScope = { tenant: scope.tenantId, cachePrefixId } to the Anthropic tools dispatcher', async () => {
    await createAiProvidersAdapter(buildScope({ anthropic: 'sk-secret-xyz' })).callAIWithTools({
      provider: 'anthropic', model: 'claude-x', systemPrompt: 'You are careful.',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ name: 'foo', description: 'd', inputSchema: { type: 'object' } }],
    });
    expect(cap.tools).toHaveLength(1);
    const s = scopeOf(cap.tools[0]);
    expect(s?.tenant).toBe('tenant-A');
    expect(typeof s?.cachePrefixId).toBe('string');
    expect(s?.cachePrefixId).toBeTruthy();
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
    expect(cap.chat).toHaveLength(1);
    const s = scopeOf(cap.chat[0]);
    expect(s?.tenant).toBe('tenant-A');
    expect(s?.cachePrefixId).toBeTruthy();
  });

  it('cachePrefixId is STABLE across turns (same model+system+tools) but DIFFERS when the prefix changes', async () => {
    const call = (systemPrompt: string, userMsg: string) =>
      createAiProvidersAdapter(buildScope({ anthropic: 'sk' })).callAIWithTools({
        provider: 'anthropic', model: 'claude-x', systemPrompt,
        messages: [{ role: 'user', content: userMsg }],
        tools: [{ name: 'foo', description: 'd', inputSchema: { type: 'object' } }],
      });
    await call('SAME SYSTEM', 'turn one');
    await call('SAME SYSTEM', 'turn two — different volatile message');
    await call('DIFFERENT SYSTEM', 'turn three');
    const id1 = scopeOf(cap.tools[0])?.cachePrefixId;
    const id2 = scopeOf(cap.tools[1])?.cachePrefixId;
    const id3 = scopeOf(cap.tools[2])?.cachePrefixId;
    // Excludes volatile messages ⇒ stable across turns (cache actually hits)…
    expect(id2).toBe(id1);
    // …but changes when the cacheable prefix (system prompt) changes.
    expect(id3).not.toBe(id1);
  });
});
