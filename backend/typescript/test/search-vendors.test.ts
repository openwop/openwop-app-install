/**
 * Multi-vendor web search (`host/searchVendors.ts`).
 *
 * `searchLive` spoke exactly one dialect — Brave's — so a tenant holding a Tavily
 * or Exa key could not use it: the key resolved fine and was then sent to Brave's
 * endpoint with Brave's header. Because the app's evidence-bound pipelines are
 * fail-closed without live search, that single hard-coded dialect is what kept
 * research gated behind an operator step almost nobody takes.
 *
 * These pin the two things that make the fix real: a pasted key reaches the RIGHT
 * vendor, and each vendor's response is normalized to the same result shape.
 */
import { describe, expect, it, afterEach } from 'vitest';
import { resolveSearchVendor, getSearchVendor, listSearchVendors } from '../src/host/searchVendors.js';
import { engineIsDurable } from '../src/host/webSearchCapability.js';

const savedEngine = process.env.OPENWOP_WEBSEARCH_ENGINE;
afterEach(() => {
  if (savedEngine === undefined) delete process.env.OPENWOP_WEBSEARCH_ENGINE;
  else process.env.OPENWOP_WEBSEARCH_ENGINE = savedEngine;
});

describe('vendor resolution — a pasted key reaches the right vendor', () => {
  it('infers Tavily from its `tvly-` key prefix', () => {
    expect(resolveSearchVendor('tvly-abc123').id).toBe('tavily');
  });

  it('infers Exa from its UUID-shaped key', () => {
    expect(resolveSearchVendor('a1b2c3d4-e5f6-7890-abcd-ef1234567890').id).toBe('exa');
  });

  it('infers Brave from its `BSA` key prefix', () => {
    expect(resolveSearchVendor('BSAabcdef123').id).toBe('brave');
  });

  it('an UNKNOWN key shape stays on Brave — the historical default', () => {
    // A deployment that worked before this change must keep working with no config.
    expect(resolveSearchVendor('some-opaque-key').id).toBe('brave');
  });

  it('an explicit OPENWOP_WEBSEARCH_ENGINE WINS over inference', () => {
    // An operator pointing at a self-hosted/proxied endpoint must not be
    // second-guessed by a key-prefix heuristic.
    process.env.OPENWOP_WEBSEARCH_ENGINE = 'exa';
    expect(resolveSearchVendor('tvly-abc123').id).toBe('exa');
  });

  it('an UNRECOGNIZED explicit engine falls through to inference, not to failure', () => {
    // A custom label alongside a custom base URL is a supported (Brave-shaped) setup.
    process.env.OPENWOP_WEBSEARCH_ENGINE = 'my-proxy';
    expect(resolveSearchVendor('tvly-abc123').id).toBe('tavily');
  });
});

describe('request shaping — each vendor gets its own dialect', () => {
  const args = { key: 'K', query: 'gratitude study', maxResults: 5 };

  it('Brave: GET with the subscription-token header', () => {
    const v = getSearchVendor('brave')!;
    const r = v.request({ ...args, baseUrl: v.baseUrl });
    expect(r.method).toBe('GET');
    expect(r.headers['x-subscription-token']).toBe('K');
    expect(r.url).toContain('q=gratitude%20study');
    expect(r.body).toBeUndefined();
  });

  it('Tavily: POST with a bearer token and a JSON body', () => {
    const v = getSearchVendor('tavily')!;
    const r = v.request({ ...args, baseUrl: v.baseUrl });
    expect(r.method).toBe('POST');
    expect(r.headers.authorization).toBe('Bearer K');
    expect(JSON.parse(r.body!)).toMatchObject({ query: 'gratitude study', max_results: 5 });
  });

  it('Exa: POST with an x-api-key header, REQUESTING highlights', () => {
    const v = getSearchVendor('exa')!;
    const r = v.request({ ...args, baseUrl: v.baseUrl });
    expect(r.method).toBe('POST');
    expect(r.headers['x-api-key']).toBe('K');
    const body = JSON.parse(r.body!) as Record<string, unknown>;
    expect(body).toMatchObject({ query: 'gratitude study', numResults: 5 });
    // Exa returns `highlights` ONLY when asked via `contents`. An earlier revision
    // sent `contents:{text:false}`, which suppressed the field it then parsed —
    // every Exa result came back snippet-less.
    //
    // Plain `true`, NOT a nested object: Exa's coding-agent guide documents
    // `maxCharacters` under `text` only and lists the old per-highlight knobs as
    // deprecated, so a nested highlights object risks a 400. Verified live.
    expect(body.contents).toEqual({ highlights: true });
    // `type:'auto'` is the guide's recommended default.
    expect(body.type).toBe('auto');
  });
});

describe('response normalization — every vendor yields ONE result shape', () => {
  it('Brave `web.results` → normalized rows', () => {
    const rows = getSearchVendor('brave')!.parse(
      { web: { results: [{ url: 'https://a.example', title: 'A', description: 'sa' }] } }, 5);
    expect(rows).toEqual([{ url: 'https://a.example', title: 'A', snippet: 'sa', rank: 1 }]);
  });

  it('Tavily `results[].content` → normalized rows', () => {
    const rows = getSearchVendor('tavily')!.parse(
      { results: [{ url: 'https://b.example', title: 'B', content: 'sb' }] }, 5);
    expect(rows).toEqual([{ url: 'https://b.example', title: 'B', snippet: 'sb', rank: 1 }]);
  });

  it('Exa `results[].highlights[0]` → the snippet (its real snippet field)', () => {
    const rows = getSearchVendor('exa')!.parse(
      { results: [{ url: 'https://c.example', title: 'C', highlights: ['first passage', 'second'] }] }, 5);
    expect(rows).toEqual([{ url: 'https://c.example', title: 'C', snippet: 'first passage', rank: 1 }]);
  });

  it('Exa falls back to `text` then `summary` when highlights are absent', () => {
    const v = getSearchVendor('exa')!;
    expect(v.parse({ results: [{ url: 'https://c.example', text: 'body' }] }, 5)[0]!.snippet).toBe('body');
    expect(v.parse({ results: [{ url: 'https://c.example', summary: 'sum' }] }, 5)[0]!.snippet).toBe('sum');
  });

  it('an Exa result with NO snippet field still yields a usable row', () => {
    // A missing snippet must not drop the citation — the URL is the evidence.
    const rows = getSearchVendor('exa')!.parse({ results: [{ url: 'https://c.example', title: 'C' }] }, 5);
    expect(rows).toEqual([{ url: 'https://c.example', title: 'C', rank: 1 }]);
  });

  it('a row with NO url is dropped, never back-filled with a placeholder', () => {
    // A row without a URL is not a citation. Inventing one would be exactly the
    // fabricated-source failure the evidence gate exists to prevent.
    const rows = getSearchVendor('brave')!.parse(
      { web: { results: [{ title: 'no url' }, { url: 'https://ok.example' }] } }, 5);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.url).toBe('https://ok.example');
  });

  it('an unexpected payload yields NO results rather than throwing', () => {
    // The caller decides what empty means (it falls through to the honest demo
    // marker); a parser that throws would surface as a broken node instead.
    for (const junk of [null, undefined, {}, { results: 'nope' }, []]) {
      expect(getSearchVendor('exa')!.parse(junk, 5)).toEqual([]);
    }
  });

  it('honours maxResults', () => {
    const many = Array.from({ length: 20 }, (_u, i) => ({ url: `https://x${i}.example` }));
    expect(getSearchVendor('tavily')!.parse({ results: many }, 3)).toHaveLength(3);
  });
});

describe('suitability — the descriptor is the SSoT for shipped vendors', () => {
  it('every shipped vendor declares durable, and the persistence gate agrees', () => {
    const vendors = listSearchVendors();
    expect(vendors.length).toBeGreaterThanOrEqual(3); // non-vacuity
    for (const v of vendors) {
      expect(v.suitability).toBe('durable');
      // The gate must classify the tag `searchLive` actually stamps (`vendor.id`).
      expect(engineIsDurable(v.id), `engine "${v.id}" must qualify as durable evidence`).toBe(true);
    }
  });

  it('every shipped vendor carries operator-facing signup + free-tier copy', () => {
    for (const v of listSearchVendors()) {
      expect(v.signupUrl).toMatch(/^https:\/\//);
      expect(v.freeTier).toBeTruthy();
    }
  });
});

/**
 * Regression guard found in self-review: inference must not change the request
 * SHAPE sent to an operator's own endpoint.
 */
describe('operator endpoints keep their historical shape', () => {
  const savedBase = process.env.OPENWOP_WEBSEARCH_BASE_URL;
  afterEach(() => {
    if (savedBase === undefined) delete process.env.OPENWOP_WEBSEARCH_BASE_URL;
    else process.env.OPENWOP_WEBSEARCH_BASE_URL = savedBase;
  });

  it('a configured BASE URL with no named engine stays Brave-shaped', () => {
    // Before this change, ANY key + a custom base URL meant Brave's shape. A
    // UUID-shaped key must NOT start POSTing Exa's body at the operator's proxy.
    process.env.OPENWOP_WEBSEARCH_BASE_URL = 'https://search.internal.example/api';
    expect(resolveSearchVendor('a1b2c3d4-e5f6-7890-abcd-ef1234567890').id).toBe('brave');
    expect(resolveSearchVendor('tvly-abc123').id).toBe('brave');
  });

  it('…unless the operator NAMES the engine, which is an explicit choice', () => {
    process.env.OPENWOP_WEBSEARCH_BASE_URL = 'https://search.internal.example/api';
    process.env.OPENWOP_WEBSEARCH_ENGINE = 'tavily';
    expect(resolveSearchVendor('anything').id).toBe('tavily');
  });
});

/**
 * REAL-RESPONSE fixture — captured from a live `POST https://api.exa.ai/search`
 * on 2026-07-26 with exactly the request `searchVendors.ts` builds
 * (`type:'auto'`, `contents:{highlights:true}`), then trimmed to two results with
 * volatile fields removed.
 *
 * This exists because the first cut of the Exa descriptor was WRONG in a way no
 * hand-written fixture would have caught: it sent `contents:{text:false}`, which
 * suppresses the very field it then parsed, so every result would have come back
 * snippet-less. Two Exa doc pages also disagree on whether `highlights` accepts a
 * nested object, so the shape is pinned against what the API actually returned
 * rather than against either page.
 */
describe('Exa — parsed from a REAL captured response', () => {
  it('yields publisher URLs, titles and snippets from the live shape', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const body = JSON.parse(
      readFileSync(join(import.meta.dirname, 'fixtures/exa-search-response.json'), 'utf8'),
    ) as unknown;

    const rows = getSearchVendor('exa')!.parse(body, 5);

    expect(rows.length).toBe(2);
    for (const r of rows) {
      // Real publisher URLs — NOT redirectors. This is the property that makes a
      // vendor `durable` (contrast Gemini grounding's per-request redirect URIs).
      expect(r.url).toMatch(/^https:\/\//);
      expect(r.url).not.toContain('grounding-api-redirect');
      expect(r.title).toBeTruthy();
      expect(r.snippet).toBeTruthy();
      expect(r.snippet!.length).toBeLessThanOrEqual(500); // the shared client-side cap
    }
    expect(rows.map((r) => r.rank)).toEqual([1, 2]);
  });
});
