/**
 * AI providers host surface (TST-BNM-3).
 *
 * Verifies:
 *   1. The v2 discovery family record is spec-shaped and names every BYOK
 *      provider under `apiKey` (v2 has no `byok` / `policies` projection yet).
 *   2. Each policy mode (`disabled` / `required` / `restricted`) and each
 *      credential failure produces the canonical `aiProviders` error code from
 *      `host-capabilities.md:141-154`; an ABSENT provider is `invalid_request`.
 *   3. A provider failure keeps the upstream body OUT of the error message (it
 *      reaches only `details.upstreamMessage`), so a provider-side credential
 *      echo cannot ride `node.failure.error.message`. (The run-event cleartext
 *      check lives in agent-dispatch-live-real.test.ts "SR-1".)
 *   4. The semantic request digest fills defaults before hashing (an omitted
 *      `maxTokens` equals the 4096 default), and provider tool-calling returns
 *      the `toolCalls[]` shape the `core.openwop.ai` toolCalling pack expects.
 *   5. Plain-reply streaming is opt-in (ADR 0079 Phase 4).
 *
 * Red when: an absent provider reaches `provider_not_supported`, a `required`
 * policy's credential failure is not re-coded `provider_policy_denied`, deltas
 * stream without `stream:true`, or the digest stops defaulting `maxTokens`.
 */

import { describe, expect, it, beforeAll, afterAll, afterEach, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { createApp } from '../src/index.js';
import { createAiProvidersAdapter, AiProviderError, advertisedByokProviders, __lastInvocationCacheKeyForTests } from '../src/aiProviders/aiProvidersHost.js';
import { programMock, resetMockPrograms } from '../src/providers/dispatchMock.js';
import type { AiProviderPolicy, ProviderPolicyResolver } from '../src/host/index.js';

let server: http.Server;
let BASE: string;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_INSTALL_PACKS = 'none'; // skip network install during tests
  const app = await createApp({
    port: 0,
    storageDsn: 'memory://',
    serviceName: 'test',
    serviceVersion: '0.0.1',
    enableConsoleTracer: false,
  });
  await new Promise<void>((res) => {
    server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); });
  });
});

afterAll(async () => {
  await new Promise<void>((res) => server.close(() => res()));
});

describe('aiProviders: discovery advertisement', () => {
  // ADR 0812 P3c-0 — this read the v1 document's `capabilities.aiProviders`
  // (`supported`, `byok`, `policies`, `toolCalling`). The v2 family record
  // carries `providers` + a flat `authModes` vocabulary; `byok` and `policies`
  // have no v2 projection yet (whd7-v2-projection-parity KNOWN_UNPROJECTED), and
  // the four policy-mode error codes are asserted against the adapter below.
  it('the v2 family record is spec-shaped and names every BYOK provider under apiKey', async () => {
    const r = await fetch(`${BASE}/.well-known/openwop`, { headers: { 'OpenWOP-Version': '2' } });
    const body = (await r.json()) as { aiProviders: { status?: string; witness?: string; providers?: string[]; authModes?: string[]; supported?: unknown } };
    const ap = body.aiProviders;
    expect(ap, 'aiProviders family present').toBeTruthy();
    expect(typeof ap.status).toBe('string');
    expect(typeof ap.witness).toBe('string');
    expect(ap.supported, 'presence is the advert at v2').toBeUndefined();
    expect(Array.isArray(ap.providers), 'aiProviders.providers is array').toBe(true);
    expect(advertisedByokProviders().length).toBeGreaterThan(0);
    expect(ap.providers).toEqual(expect.arrayContaining(advertisedByokProviders()));
    expect(ap.authModes).toContain('apiKey');
  });
});

describe('aiProviders: error codes are canonical per host-capabilities.md:141-154', () => {
  it('provider_not_supported when provider is unknown', async () => {
    const adapter = createAiProvidersAdapter(buildScope({ secrets: {} }));
    await expect(
      adapter.callAI({
        provider: 'acme-ai',
        model: 'foo',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    ).rejects.toMatchObject({ code: 'provider_not_supported' });
  });

  /**
   * ABSENCE IS NOT A VALUE (P1). A caller that OMITS `provider` used to reach
   * `assertProviderSupported` with `undefined`, which the template rendered as
   * the literal provider name "undefined" — so `provider_not_supported:
   * Provider "undefined" is not in the host's aiProviders.supported list`.
   * That message sent a real production diagnosis looking for a provider that
   * never existed, when the actual fault was a workflow node shipped with
   * `config: {}`. A missing field and a bogus field are different failures.
   */
  it('invalid_request (NOT provider_not_supported) when provider is ABSENT', async () => {
    const adapter = createAiProvidersAdapter(buildScope({ secrets: {} }));
    await expect(
      adapter.callAI({
        // provider deliberately omitted — the shape a node with empty config sends
        ...noProviderRequest(),
      }),
    ).rejects.toMatchObject({ code: 'invalid_request', details: { field: 'provider' } });
  });

  it('the absent-provider message names the REAL fault, not a fake provider', async () => {
    const adapter = createAiProvidersAdapter(buildScope({ secrets: {} }));
    const err = await adapter.callAI(noProviderRequest()).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(AiProviderError);
    const message = (err as AiProviderError).message;
    expect(message).toMatch(/No AI provider is configured/);
    // The old message must not come back: it named a provider called "undefined".
    expect(message).not.toMatch(/Provider "undefined"/);
  });

  it('provider_policy_denied for disabled provider', async () => {
    const scope = buildScope({
      secrets: { anthropic: 'sk-test' },
      policies: [{ provider: 'anthropic', mode: 'disabled' }],
    });
    const adapter = createAiProvidersAdapter(scope);
    await expect(
      adapter.callAI({
        provider: 'anthropic',
        model: 'claude-3-5-sonnet-latest',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    ).rejects.toMatchObject({ code: 'provider_policy_denied' });
  });

  // capabilities.md "Wire-format error": EVERY policy refusal carries the
  // advertised `policies.errorCode`; the cause rides `details.reason`.
  it('restricted + EMPTY allowlist: provider_policy_denied (reason model_not_allowed, fail-closed)', async () => {
    const scope = buildScope({
      secrets: { anthropic: 'sk-test' },
      policies: [{ provider: 'anthropic', mode: 'restricted', allowedModels: [] }],
    });
    const adapter = createAiProvidersAdapter(scope);
    await expect(
      adapter.callAI({
        provider: 'anthropic',
        model: 'claude-3-5-sonnet-latest',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    ).rejects.toMatchObject({ code: 'provider_policy_denied', details: { reason: 'model_not_allowed', allowed: [] } });
  });

  it('restricted + wildcard MISS: provider_policy_denied (reason model_not_allowed)', async () => {
    const scope = buildScope({
      secrets: { anthropic: 'sk-test' },
      policies: [{ provider: 'anthropic', mode: 'restricted', allowedModels: ['claude-3-5-sonnet-*'] }],
    });
    const adapter = createAiProvidersAdapter(scope);
    await expect(
      adapter.callAI({
        provider: 'anthropic',
        model: 'claude-3-haiku-20240307',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    ).rejects.toMatchObject({ code: 'provider_policy_denied', details: { reason: 'model_not_allowed' } });
  });

  it('provider_policy_denied (reason byok_required) for required mode with no credential', async () => {
    const scope = buildScope({
      secrets: {},
      policies: [{ provider: 'anthropic', mode: 'required' }],
    });
    const adapter = createAiProvidersAdapter(scope);
    await expect(
      adapter.callAI({
        provider: 'anthropic',
        model: 'claude-3-5-sonnet-latest',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    ).rejects.toMatchObject({ code: 'provider_policy_denied', details: { reason: 'byok_required' } });
  });

  it('required mode admits a call whose credential resolves (positive control)', async () => {
    const scope = buildScope({
      secrets: { anthropic: 'sk-test' },
      policies: [{ provider: 'anthropic', mode: 'required' }],
    });
    const adapter = createAiProvidersAdapter(scope);
    // The policy passing is witnessed by the call REACHING the provider.
    let reachedProvider = false;
    vi.stubGlobal('fetch', () => {
      reachedProvider = true;
      return Promise.reject(new Error('stubbed provider'));
    });
    try {
      await adapter
        .callAI({
          provider: 'anthropic',
          model: 'claude-3-5-sonnet-latest',
          messages: [{ role: 'user', content: 'hi' }],
        })
        .catch(() => undefined);
    } finally {
      vi.unstubAllGlobals();
    }
    expect(reachedProvider).toBe(true);
  });

  it('byok_required when no credential is available in any convention slot', async () => {
    const scope = buildScope({ secrets: {} });
    const adapter = createAiProvidersAdapter(scope);
    await expect(
      adapter.callAI({
        provider: 'anthropic',
        model: 'claude-3-5-sonnet-latest',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    ).rejects.toMatchObject({ code: 'byok_required' });
  });

  it('byok_required_but_unresolved when an explicit ref does not resolve', async () => {
    const scope = buildScope({ secrets: { 'anthropic-prod': 'sk-test' } });
    const adapter = createAiProvidersAdapter(scope);
    await expect(
      adapter.callAI({
        provider: 'anthropic',
        model: 'claude-3-5-sonnet-latest',
        messages: [{ role: 'user', content: 'hi' }],
        credentialRef: 'anthropic-dev',
      }),
    ).rejects.toMatchObject({ code: 'byok_required_but_unresolved' });
  });

  it('embeddings now supported (A5): returns a deterministic local vector', async () => {
    const scope = buildScope({ secrets: { anthropic: 'sk-test' } });
    const adapter = createAiProvidersAdapter(scope);
    const res = await adapter.callAI({
      provider: 'anthropic',
      model: 'claude-3-5-sonnet-latest',
      messages: [{ role: 'user', content: 'workflow engine' }],
      embeddingMode: true,
    });
    expect(Array.isArray(res.embedding)).toBe(true);
    expect(res.embedding!.length).toBeGreaterThan(0);
    expect(res.model).toBe('local-hash-v1');
  });

  it('tool-calling now supported for openai (A3): routes to the OpenAI round', async () => {
    const scope = buildScope({ secrets: { openai: 'sk-test' } });
    const adapter = createAiProvidersAdapter(scope);
    const urls: string[] = [];
    vi.stubGlobal('fetch', (url: string) => {
      urls.push(url);
      return Promise.resolve(new Response(JSON.stringify({
        choices: [{ message: { content: '', tool_calls: [{ id: 'tc1', type: 'function', function: { name: 'foo', arguments: '{}' } }] }, finish_reason: 'tool_calls' }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }), { status: 200, headers: { 'content-type': 'application/json' } }));
    });
    try {
      const res = await adapter.callAIWithTools({
        provider: 'openai',
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'hi' }],
        tools: [{ name: 'foo', description: 'd', inputSchema: { type: 'object' } }],
      });
      expect(res.toolCalls).toEqual([{ id: 'tc1', name: 'foo', input: {} }]);
      expect(urls.every((u) => u.startsWith('https://api.openai.com/'))).toBe(true);
      expect(urls.length).toBeGreaterThan(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('aiProviders: error details surface upstream message via details, not main message', () => {
  it('AiProviderError details.upstreamMessage is the truncation slot', async () => {
    // Real path: a provider 5xx whose body echoes something sensitive. The
    // canonical message is fixed; the body reaches details.upstreamMessage only.
    const adapter = createAiProvidersAdapter(buildScope({ secrets: { anthropic: 'sk-test' } }));
    vi.stubGlobal('fetch', () => Promise.resolve(new Response('sensitive-upstream-body', { status: 503 })));
    let err: unknown;
    try {
      err = await adapter
        .callAI({ provider: 'anthropic', model: 'claude-3-5-sonnet-latest', messages: [{ role: 'user', content: 'hi' }] })
        .then(() => null, (e: unknown) => e);
    } finally {
      vi.unstubAllGlobals();
    }
    expect(err).toBeInstanceOf(AiProviderError);
    const e = err as AiProviderError;
    expect(e.code).toBe('provider_unavailable');
    expect(e.message).toBe('Provider 5xx.');
    expect(e.message).not.toContain('sensitive-upstream-body');
    expect(String(e.details.upstreamMessage)).toContain('sensitive-upstream-body');
  });
});

describe('aiProviders: cache key canonicalization', () => {
  afterEach(() => resetMockPrograms());

  it('omitted maxTokens collides with default-filled maxTokens', async () => {
    // The semantic request digest (RFC 0150 §C) is over the EFFECTIVE request:
    // defaults are filled before hashing, so omitting `maxTokens` and passing
    // the 4096 default yield the SAME providerKey; a different value does not.
    const keyFor = async (nodeId: string, maxTokens?: number): Promise<string> => {
      programMock(nodeId, [{ content: 'ok' }]);
      const scope = { ...buildScope({ secrets: {} }), nodeId };
      await createAiProvidersAdapter(scope).callAI({
        provider: 'mock', model: 'mock-1', messages: [{ role: 'user', content: 'same request' }],
        ...(maxTokens !== undefined ? { maxTokens } : {}),
      });
      const key = __lastInvocationCacheKeyForTests();
      expect(key?.nodeId).toBe(nodeId);
      return key!.providerKey;
    };
    const omitted = await keyFor('ck-omitted');
    const defaulted = await keyFor('ck-4096', 4096);
    const other = await keyFor('ck-1024', 1024);
    expect(omitted).toBe(defaulted);
    expect(other, 'positive control: maxTokens IS in the digest').not.toBe(omitted);
  });
});

// ── Helpers ─────────────────────────────────────────────────────────

describe('aiProviders: ADR 0079 §Phase 4 — plain callAI streams output.chunk', () => {
  afterEach(() => resetMockPrograms());

  it('streams chunked deltas via scope.emit for a plain reply WHEN stream:true is opted in', async () => {
    programMock('stream-node', [{ content: 'Hello stream world' }]);
    const emitted: Array<{ type: string; payload: unknown }> = [];
    const scope = {
      ...buildScope({ secrets: {} }),
      nodeId: 'stream-node',
      emit: async (type: string, payload: unknown) => { emitted.push({ type, payload }); return { eventId: 'e', sequence: emitted.length }; },
    };
    const res = await createAiProvidersAdapter(scope).callAI({ provider: 'mock', model: 'mock-1', messages: [{ role: 'user', content: 'hi' }], stream: true });
    expect(res.content).toBe('Hello stream world');
    const chunks = emitted.filter((e) => e.type === 'output.chunk');
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.map((e) => (e.payload as { chunk?: string }).chunk).join('')).toBe('Hello stream world');
  });

  it('emits NO deltas by default (stream omitted) — opt-in guards against write amplification', async () => {
    programMock('noopt-node', [{ content: 'no deltas please' }]);
    const emitted: string[] = [];
    const scope = {
      ...buildScope({ secrets: {} }),
      nodeId: 'noopt-node',
      emit: async (type: string) => { emitted.push(type); return { eventId: 'e', sequence: emitted.length }; },
    };
    const res = await createAiProvidersAdapter(scope).callAI({ provider: 'mock', model: 'mock-1', messages: [{ role: 'user', content: 'hi' }] });
    expect(res.content).toBe('no deltas please');
    expect(emitted.filter((t) => t === 'output.chunk')).toHaveLength(0);
  });

  it('does NOT stream a structured (responseSchema) call even with stream:true — JSON mid-parse is noise', async () => {
    programMock('struct-node', [{ content: '{"ok":true}' }]);
    const emitted: string[] = [];
    const scope = {
      ...buildScope({ secrets: {} }),
      nodeId: 'struct-node',
      emit: async (type: string) => { emitted.push(type); return { eventId: 'e', sequence: emitted.length }; },
    };
    await createAiProvidersAdapter(scope).callAI({
      provider: 'mock', model: 'mock-1', messages: [{ role: 'user', content: 'hi' }], stream: true,
      responseSchema: { type: 'object', properties: { ok: { type: 'boolean' } } },
    });
    expect(emitted.filter((t) => t === 'output.chunk')).toHaveLength(0);
  });

  it('a scope WITHOUT emit dispatches normally (no streaming, no throw)', async () => {
    programMock('noemit-node', [{ content: 'no stream here' }]);
    const scope = { ...buildScope({ secrets: {} }), nodeId: 'noemit-node' };
    const res = await createAiProvidersAdapter(scope).callAI({ provider: 'mock', model: 'mock-1', messages: [{ role: 'user', content: 'hi' }] });
    expect(res.content).toBe('no stream here');
  });
});

/** A callAI request with NO `provider` — the shape a node with `config: {}`
 *  sends. Built from untyped JSON (its real origin), so no cast is needed. */
function noProviderRequest(): Parameters<ReturnType<typeof createAiProvidersAdapter>['callAI']>[0] {
  return JSON.parse('{"model":"foo","messages":[{"role":"user","content":"hi"}]}');
}

function buildScope(opts: {
  secrets: Record<string, string>;
  policies?: AiProviderPolicy[];
}) {
  const policyResolver: ProviderPolicyResolver = {
    async resolveForRun() {
      return opts.policies ?? [];
    },
  };
  return {
    runId: 'test-run',
    nodeId: 'test-node',
    tenantId: 'test-tenant',
    attempt: 1,
    secrets: opts.secrets,
    policyResolver,
  };
}
