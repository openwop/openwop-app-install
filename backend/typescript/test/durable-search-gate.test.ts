/**
 * ADR 0502 — a DURABLE search caller never receives the demo marker.
 *
 * The defect this pins (verified live against prod rev 00581-2nl on 2026-07-29):
 * `suitability: 'durable'` gated only WHICH NATIVE PROVIDER qualified. Both demo
 * fallbacks in `search()` fired regardless, so the Challenge Factory — which
 * stores its citations and puts them in front of a human approver — was handed
 * `engine: 'demo'` and a synthetic `duckduckgo.com/?q=…` URL. `core.web.fetch`
 * then fetched that search-results page as if it were a source (1 page, 0
 * failures) and a model call extracted "claims" from it, before
 * `recordResearch`'s `engineIsDurable` guard finally refused two nodes later.
 *
 * The two halves are tested separately on purpose, because shipping only the
 * first is exactly how this stayed dormant for a release:
 *   1. the MECHANISM refuses (the surface throws), and
 *   2. the Factory chain actually ASKS for it (the pack declares durable).
 */

import { describe, expect, it, beforeAll, afterAll, afterEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createApp } from '../src/index.js';
import { buildHostSurfaceBundle } from '../src/host/inMemorySurfaces.js';
import { DurableSearchUnavailableError } from '../src/host/webResearchSurface.js';

let app: http.Server;
let provider: http.Server;
let providerUrl: string;
let providerStatus = 200;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE = 'true';
  const a = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { app = a.listen(0, '127.0.0.1', res); });
  provider = http.createServer((_req, res) => {
    if (providerStatus !== 200) { res.writeHead(providerStatus).end('err'); return; }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ web: { results: [{ url: 'https://example.com/a', title: 'Result A', description: 'snippet A' }] } }));
  });
  await new Promise<void>((res) => provider.listen(0, '127.0.0.1', res));
  providerUrl = `http://127.0.0.1:${(provider.address() as AddressInfo).port}/search`;
});

afterAll(async () => {
  delete process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE;
  await new Promise<void>((res) => app.close(() => res()));
  await new Promise<void>((res) => provider.close(() => res()));
});

afterEach(() => {
  delete process.env.OPENWOP_WEBSEARCH_API_KEY;
  delete process.env.OPENWOP_WEBSEARCH_BASE_URL;
  delete process.env.OPENWOP_WEBSEARCH_ENGINE;
  providerStatus = 200;
});

const wr = () => buildHostSurfaceBundle({ tenantId: 'default' }).webResearch;

describe('durable search refuses rather than fabricating evidence', () => {
  it('throws instead of returning the demo marker when no adapter is configured', async () => {
    await expect(wr().search({ query: 'walking 20 minutes a day', suitability: 'durable' }))
      .rejects.toBeInstanceOf(DurableSearchUnavailableError);
  });

  it('names the reason as a configuration fact, not a transient fault', async () => {
    const err = await wr().search({ query: 'x', suitability: 'durable' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DurableSearchUnavailableError);
    expect((err as DurableSearchUnavailableError).reason).toBe('no_adapter');
    expect((err as DurableSearchUnavailableError).code).toBe('research_adapter_unconfigured');
  });

  it('refuses when the configured provider FAILS — a demo substitute is not a degraded answer', async () => {
    process.env.OPENWOP_WEBSEARCH_API_KEY = 'k';
    process.env.OPENWOP_WEBSEARCH_BASE_URL = providerUrl;
    providerStatus = 500;
    const err = await wr().search({ query: 'x', suitability: 'durable' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DurableSearchUnavailableError);
    expect((err as DurableSearchUnavailableError).reason).toBe('provider_failed');
  });

  it('does NOT refuse when a live provider answers — the gate must not block a working setup', async () => {
    process.env.OPENWOP_WEBSEARCH_API_KEY = 'k';
    process.env.OPENWOP_WEBSEARCH_BASE_URL = providerUrl;
    process.env.OPENWOP_WEBSEARCH_ENGINE = 'brave';
    const r = await wr().search({ query: 'x', suitability: 'durable' });
    expect(r.engine).toBe('brave');
    expect(r.results).toHaveLength(1);
  });

  it('leaves the answer-only contract intact — an ordinary lookup still gets the honest demo marker', async () => {
    const r = await wr().search({ query: 'anything' });
    expect(r.engine).toBe('demo');
    expect(r.results[0]!.url).toContain('duckduckgo.com');
  });

  it('research() FORWARDS suitability instead of dropping it to answer-only', async () => {
    // The composed op is what an evidence pipeline reaches for; it used to call
    // search() with no suitability at all, making the gate unreachable there.
    await expect(wr().research({ query: 'x', suitability: 'durable' }))
      .rejects.toBeInstanceOf(DurableSearchUnavailableError);
  });
});

describe('the evidence-storing chains ASK for the durable gate', () => {
  // A mechanism nothing invokes is the ADR 0101 Phase 4 failure mode repeating:
  // the durable predicate shipped correct and stayed dormant because the chain
  // that needed it never set the flag. These assert the wiring, not the code.
  const packPath = (name: string) =>
    join(import.meta.dirname, '..', '..', '..', 'examples', 'workflow-chain-packs', name, 'pack.json');

  const searchNodesOf = (name: string) => {
    const pack = JSON.parse(readFileSync(packPath(name), 'utf8')) as {
      chains: Array<{ dag?: { nodes?: Array<{ typeId: string; config?: Record<string, unknown>; inputs?: Record<string, unknown> }> } }>;
    };
    return pack.chains.flatMap((c) => c.dag?.nodes ?? []).filter((n) => n.typeId === 'core.web.search');
  };

  for (const chain of ['kicktodo-challenge-factory', 'kicktodo-research']) {
    it(`${chain} declares suitability:durable on every search node`, () => {
      const nodes = searchNodesOf(chain);
      expect(nodes.length, 'the chain must still have a search node for this to mean anything').toBeGreaterThan(0);
      for (const n of nodes) {
        expect(
          n.config?.suitability ?? n.inputs?.suitability,
          `${chain} search node stores its results as citable evidence, so it must request the durable gate`,
        ).toBe('durable');
      }
    });
  }
});
