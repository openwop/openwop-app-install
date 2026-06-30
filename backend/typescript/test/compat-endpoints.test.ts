/**
 * Compat endpoint config — RFC 0108 / ADR 0121. Covers the §A.2 dark-by-default
 * advertise helper, the §A.3 opaque non-URL provider id, the §B declared→RFC-0031
 * capability mapping, the tenant-scoped store, and the dispatch-resolution seam.
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { openStorage } from '../src/storage/index.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { dispatchChat } from '../src/providers/dispatch.js';
import {
  advertisedSelfHostedProviders,
  compatProviderId,
  compatDeclaredModelCapabilities,
  compatInputModalities,
  putCompatEndpoint,
  getCompatEndpoint,
  listCompatEndpoints,
  deleteCompatEndpoint,
  resolveCompatDispatch,
  type CompatEndpoint,
} from '../src/host/compatEndpoints.js';

const ep = (over: Partial<CompatEndpoint> = {}): CompatEndpoint => ({
  id: 'ep-abc',
  tenantId: 't1',
  orgId: 'o1',
  label: 'Internal vLLM',
  baseUrl: 'https://vllm.internal/v1',
  capabilities: { vision: false, tools: false, longContext: false },
  createdAt: '2026-06-24T00:00:00Z',
  updatedAt: '2026-06-24T00:00:00Z',
  ...over,
});

const URL_SHAPED = /:\/\/|^\/|^[^:]+:\d/; // ://, leading /, or host:port

beforeAll(async () => {
  initHostExtPersistence(await openStorage('memory://'));
});

describe('compat advertise + id (RFC 0108 §A.2 / §A.3)', () => {
  it('is DARK by default — no configured endpoints ⇒ []', () => {
    expect(advertisedSelfHostedProviders([])).toEqual([]);
  });

  it('a single endpoint advertises as the opaque `compat`', () => {
    expect(advertisedSelfHostedProviders([{ id: 'ep-abc' }])).toEqual(['compat']);
  });

  it('multiple endpoints disambiguate by OPAQUE id, never URL-shaped', () => {
    const ids = advertisedSelfHostedProviders([{ id: 'ep-abc' }, { id: 'ep-xyz' }]);
    expect(ids).toEqual(['compat:ep-abc', 'compat:ep-xyz']);
    for (const id of ids) expect(id).not.toMatch(URL_SHAPED); // §A.3 / §D
  });

  it('compatProviderId never encodes the endpoint URL/label', () => {
    expect(compatProviderId({ id: 'ep-abc' }, false)).toBe('compat');
    expect(compatProviderId({ id: 'ep-abc' }, true)).toBe('compat:ep-abc');
    expect(compatProviderId({ id: 'ep-abc' }, true)).not.toMatch(URL_SHAPED);
  });
});

describe('compat declared capabilities → RFC 0031 / RFC 0091 (§B non-inference)', () => {
  it('maps declared tools/longContext to RFC 0031 identifiers', () => {
    expect(compatDeclaredModelCapabilities({ vision: false, tools: true, longContext: true }))
      .toEqual(['function-calling', 'long-context']);
  });
  it('text-only by default (all flags false ⇒ no capabilities)', () => {
    expect(compatDeclaredModelCapabilities({ vision: false, tools: false, longContext: false })).toEqual([]);
  });
  it('vision is an RFC 0091 input modality, not a model capability', () => {
    expect(compatDeclaredModelCapabilities({ vision: true, tools: false, longContext: false })).toEqual([]);
    expect(compatInputModalities({ vision: true, tools: false, longContext: false })).toEqual(['image']);
    expect(compatInputModalities({ vision: false, tools: false, longContext: false })).toEqual([]);
  });
});

describe('compat endpoint store + dispatch resolution (tenant-scoped)', () => {
  it('round-trips put → get → list (org-filtered) → delete', async () => {
    await putCompatEndpoint(ep({ id: 'ep-1' }));
    await putCompatEndpoint(ep({ id: 'ep-2', orgId: 'o2' }));
    expect((await getCompatEndpoint('t1', 'ep-1'))?.baseUrl).toBe('https://vllm.internal/v1');
    const o1 = await listCompatEndpoints('t1', 'o1');
    expect(o1.map((e) => e.id)).toEqual(['ep-1']); // org filter excludes ep-2 (o2)
    expect(await deleteCompatEndpoint('t1', 'ep-1')).toBe(true);
    expect(await getCompatEndpoint('t1', 'ep-1')).toBeNull();
    await deleteCompatEndpoint('t1', 'ep-2');
  });

  it('resolveCompatDispatch returns the host-only baseUrl + empty key for a no-key endpoint', async () => {
    await putCompatEndpoint(ep({ id: 'ep-nokey' })); // no credentialRef ⇒ no resolveSecret call
    const r = await resolveCompatDispatch('t1', 'ep-nokey');
    expect(r).toEqual({ baseUrl: 'https://vllm.internal/v1', apiKey: '' });
    await deleteCompatEndpoint('t1', 'ep-nokey');
  });

  it('resolveCompatDispatch fails closed (null) for an unknown endpoint', async () => {
    expect(await resolveCompatDispatch('t1', 'nope')).toBeNull();
  });
});

describe('compat end-to-end: configure → resolve → dispatch a turn (dark path)', () => {
  const prev = process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE;
  afterEach(() => {
    if (prev === undefined) delete process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE;
    else process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE = prev;
  });

  function mockServer(): Promise<{ server: Server; baseUrl: string }> {
    return new Promise((resolve) => {
      const server = createServer((_req, res) => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('data: ' + JSON.stringify({
          choices: [{ delta: { content: 'hello world' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 2 },
        }) + '\n\n');
        res.write('data: [DONE]\n\n');
        res.end();
      });
      server.listen(0, '127.0.0.1', () => {
        const a = server.address();
        resolve({ server, baseUrl: `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}/v1` });
      });
    });
  }

  it('a configured endpoint routes a turn to its base URL (no advertisement involved)', async () => {
    process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE = 'true';
    const { server, baseUrl } = await mockServer();
    try {
      await putCompatEndpoint(ep({ id: 'ep-e2e', baseUrl }));
      const resolved = await resolveCompatDispatch('t1', 'ep-e2e');
      expect(resolved).not.toBeNull();
      const out = await dispatchChat({
        provider: 'compat', model: 'llama3', apiKey: resolved!.apiKey, baseUrl: resolved!.baseUrl,
        messages: [{ role: 'user', content: 'hi' }],
      });
      expect(out.provider).toBe('compat');
      expect(out.completion).toBe('hello world');
    } finally {
      server.close();
      await deleteCompatEndpoint('t1', 'ep-e2e');
    }
  });

  it('§D end-to-end: an unreachable configured endpoint fails scrubbed (no URL/host)', async () => {
    process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE = 'true';
    await putCompatEndpoint(ep({ id: 'ep-dead', baseUrl: 'http://127.0.0.1:1/v1' }));
    try {
      const resolved = await resolveCompatDispatch('t1', 'ep-dead');
      const err = await dispatchChat({
        provider: 'compat', model: 'm', apiKey: resolved!.apiKey, baseUrl: resolved!.baseUrl,
        messages: [{ role: 'user', content: 'hi' }],
      }).then(() => null, (e) => e as Error);
      expect(err?.message).toBe('compat_transport_error');
      expect(err?.message).not.toContain('127.0.0.1');
    } finally {
      await deleteCompatEndpoint('t1', 'ep-dead');
    }
  });
});
