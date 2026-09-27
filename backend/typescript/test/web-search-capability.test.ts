/**
 * ADR 0101 Phase 4 — native web search on the tenant's own key, and the
 * SUITABILITY gate that decides whether its results may be STORED.
 *
 * Two facts are deliberately independent (see `host/webSearchCapability.ts`):
 * CAPABILITY (per-model `webSearch` in providers.json) and SUITABILITY (a
 * per-provider LICENSING fact). Conflating them is what would let Google's
 * Grounding links — licensed for display alongside the grounded answer, and
 * returned as per-request redirect URIs rather than publisher URLs — end up
 * hashed into a Challenge Factory evidence dossier that outlives the run and
 * backs a human's publication decision.
 *
 * These assertions are pinned against the real `providers.json`, so a catalog
 * refresh that flips a flag has to come here and say so.
 */
import { describe, expect, it } from 'vitest';
import {
  modelSupportsNativeSearch,
  nativeSearchSuitability,
  nativeSearchSatisfies,
  engineIsDurable,
} from '../src/host/webSearchCapability.js';

describe('capability — read from the per-MODEL providers.json flag', () => {
  it('google models advertise native search', () => {
    expect(modelSupportsNativeSearch('google', 'gemini-3.1-flash-lite')).toBe(true);
  });

  it('anthropic/openai are OFF pending their live check (capability honesty)', () => {
    // Implemented in the dispatchers but deliberately unflagged — see
    // dispatchProviderTools.ts. If this flips, it must flip in providers.json.
    expect(modelSupportsNativeSearch('anthropic', 'claude-opus-4-5-20260514')).toBe(false);
    expect(nativeSearchSuitability('anthropic', 'claude-opus-4-5-20260514')).toBe('none');
  });

  it('an unknown provider or model is `none`, never a default-yes', () => {
    expect(modelSupportsNativeSearch('acme', 'x')).toBe(false);
    expect(modelSupportsNativeSearch('google', 'not-a-real-model')).toBe(false);
    expect(nativeSearchSuitability('acme', 'x')).toBe('none');
  });
});

describe('suitability — the licensing gate', () => {
  it('THE POINT: google searches, but its links are ANSWER-ONLY (Grounding terms)', () => {
    expect(modelSupportsNativeSearch('google', 'gemini-3.1-flash-lite')).toBe(true);
    expect(nativeSearchSuitability('google', 'gemini-3.1-flash-lite')).toBe('answer-only');
    // …so it satisfies a display-time ask but NOT a storable-citation ask.
    expect(nativeSearchSatisfies('google', 'gemini-3.1-flash-lite', 'answer-only')).toBe(true);
    expect(nativeSearchSatisfies('google', 'gemini-3.1-flash-lite', 'durable')).toBe(false);
  });

  it('a durable provider satisfies BOTH asks (once its capability flag is on)', () => {
    // Asserted through engineIsDurable so the test states the licensing tier
    // without depending on a capability flag that is intentionally off today.
    expect(engineIsDurable('native:anthropic')).toBe(true);
    expect(engineIsDurable('native:openai')).toBe(true);
  });
});

describe('engineIsDurable — the gate at the point of PERSISTENCE', () => {
  it('refuses the stub/demo markers', () => {
    expect(engineIsDurable('demo')).toBe(false);
    expect(engineIsDurable('stub')).toBe(false);
    expect(engineIsDurable('')).toBe(false);
  });

  it('refuses an answer-only native engine even though its results are REAL', () => {
    // The defect this exists to stop: `search()` asks for a tier, but the host
    // key can fail at runtime and fall through to native, so the consumer that
    // persists must check the engine it actually received.
    expect(engineIsDurable('native:google')).toBe(false);
  });

  it('accepts a host-configured search vendor (operator’s own contract)', () => {
    expect(engineIsDurable('brave')).toBe(true);
  });

  it('an unknown native provider fails CLOSED', () => {
    expect(engineIsDurable('native:acme')).toBe(false);
  });

  // Code-review finding: `engine` reaches the dossier through a workflow node's
  // args (`kicktodo-creator/surface.ts` defaults a missing one to 'unknown'), so
  // it is caller-shaped, not trusted host output. An allowlist is therefore the
  // only safe shape — a deny-list would wave through 'unknown' and any invented
  // label as durable evidence.
  // The fail-open the first cut had: `surface.ts` defaults a missing engine to
  // 'unknown', so an unattributed source looked exactly like a real one.
  it('refuses the UNATTRIBUTED default', () => {
    expect(engineIsDurable('unknown')).toBe(false);
    expect(engineIsDurable('  ')).toBe(false);
  });

  it('accepts any NAMED host vendor — the set is not enumerable', () => {
    // Over-correction caught by the full suite: an allowlist of brave + the
    // configured label rejected `searx`, a real engine already in the seeded
    // corpus and in several existing fixtures.
    expect(engineIsDurable('searx')).toBe(true);
    expect(engineIsDurable('tavily')).toBe(true);
    expect(engineIsDurable('Brave')).toBe(true); // case-insensitive
  });
});

/**
 * The native leg must be BEST-EFFORT.
 *
 * Regression: resolving it reads durable storage + the BYOK resolver, either of
 * which can throw (e.g. persistence not initialised). The first cut called the
 * resolver outside a try, so the throw propagated out of `search()` — which is
 * also the path an SSRF refusal falls through, turning a contained egress denial
 * into a broken node. Caught by `web-research-ssrf.test.ts`; pinned here
 * explicitly so the guarantee is stated where the native leg lives.
 */
describe('native leg is best-effort', () => {
  it('degrades to the honest demo marker when the resolver throws', async () => {
    // No `initHostExtPersistence` in this suite, so `getHeadlessAiDefault`'s
    // durable read throws — the real failure mode, not a synthetic stub.
    const { createWebResearchSurface } = await import('../src/host/webResearchSurface.js');
    const surface = createWebResearchSurface({ tenantId: 'tenant-with-no-store' });

    const res = await surface.search({ query: 'anything' });

    expect(res.engine).toBe('demo'); // never a throw, never a silent empty
    expect(res.results.length).toBeGreaterThan(0);
  });
});

/**
 * Tracked-gap closures from the ADR 0101 Phase 4 assessments
 * (CAP-1/SSOT-1, CAP-2/DOS-1/PROV-1, RES-1, LIC-1).
 */
describe('ADR 0101 Phase 4 tracked-gap closures', () => {
  it('SSOT-1/CAP-1 — EVERY provider declares a searchSuitability, with its basis cited', async () => {
    // Omission fails closed ('none'), which is safe but silently disables native
    // search for a newly-added provider. Make the omission LOUD instead.
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const doc = JSON.parse(readFileSync(join(import.meta.dirname, '../../../providers.json'), 'utf8')) as {
      providers: Array<{ id: string; searchSuitability?: string; _searchSuitabilityNote?: string }>;
    };
    expect(doc.providers.length).toBeGreaterThan(3); // non-vacuity
    for (const p of doc.providers) {
      expect(p.searchSuitability, `provider "${p.id}" is missing searchSuitability — a new provider must state whether its native search results may be STORED (see host/webSearchCapability.ts)`).toBeDefined();
      expect(['durable', 'answer-only', 'none']).toContain(p.searchSuitability);
      // LIC-1 — the conclusion is a licensing call; record WHY so it can be
      // re-verified without re-reading four vendors' terms.
      expect(p._searchSuitabilityNote, `provider "${p.id}" states a searchSuitability with no cited basis`).toBeTruthy();
    }
  });

  it('CAP-2/DOS-1/PROV-1 — adversarial: a forged engine label cannot claim an unlicensed provider', () => {
    // `engine` is caller-shaped (a node's args), so probe the shapes a model might
    // emit to smuggle answer-only results into stored evidence.
    for (const forged of [
      'native:google',        // the honest label — must be refused
      'native:GOOGLE',        // case games
      'native:google ',       // whitespace
      'NATIVE:google',
      'native:google:durable',// suffix games
      'demo',
      'stub',
      'unknown',
      '',
    ]) {
      expect(engineIsDurable(forged), `engine "${forged}" must not qualify as durable evidence`).toBe(false);
    }
  });

  it('RES-1 — every engine tag `search()` can emit is classifiable by the persistence gate', () => {
    // The three exit paths tag results `demo`, the host engine, or `native:<provider>`.
    // None may be ambiguous to `engineIsDurable`, or the dossier gate would be
    // deciding on a value it does not understand.
    const emitted = ['demo', 'brave', 'searx', 'native:google', 'native:anthropic', 'native:openai'];
    for (const e of emitted) expect(typeof engineIsDurable(e)).toBe('boolean');
    // …and the classification is the intended one on both sides of the line.
    expect(emitted.filter((e) => engineIsDurable(e))).toEqual(['brave', 'searx', 'native:anthropic', 'native:openai']);
  });
});
