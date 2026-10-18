import { describe, it, expect } from 'vitest';
import { resolveActiveModel, getProvider, PROVIDERS } from '../providers.js';

/**
 * Regression guard for the "composer controls vanish after a catalog refresh" bug:
 * a model-catalog refresh renamed ids (e.g. `claude-opus-4-7`→`-4-8`, `MiniMax-M2`→`M3`),
 * stranding any saved `config.model`. The chat resolved the active model by EXACT id with
 * no fallback, so a stale id → `activeModel = null` → `supportsTools`/`supportsWebSearch`
 * false → the Tools/web composer controls silently disappeared. `resolveActiveModel` falls
 * back to the provider default so capability detection reflects a VALID model.
 *
 * Expectations are read from the CATALOG (providers.json via `getProvider`), never from
 * `getDefaultModel`, which implements the same recommended-or-first rule and would move
 * with a sabotage of it.
 *
 * Sabotage that turns these red (providers.ts `resolveActiveModel`): dropping the
 * exact-id match (the exact case uses a NON-default model, so the fallback cannot stand
 * in for it); dropping the fallback; resolving an unknown provider to a known one.
 *
 * HONEST CEILING: "recommended" vs "first" cannot be told apart with the shipped catalog,
 * because every provider lists its recommended model first. Pinning that ordering would
 * need a fake catalog, which would test a copy rather than providers.json.
 */
describe('resolveActiveModel — stale-model fallback', () => {
  const anthropic = getProvider('anthropic');
  const recommended = anthropic.models.find((m) => m.recommended === true)!;
  const nonDefault = anthropic.models.find((m) => m.recommended !== true)!;

  it('returns the exact model when the saved id is current', () => {
    // A model that is NOT the default: an exact-match bug that fell back to the
    // default would return a different id here.
    expect(nonDefault.id).not.toBe(recommended.id);
    expect(resolveActiveModel('anthropic', nonDefault.id)?.id).toBe(nonDefault.id);
  });

  it('falls back to the provider default for a STALE/renamed id (the bug)', () => {
    const stale = resolveActiveModel('anthropic', 'claude-opus-4-7'); // a real id removed by the refresh
    expect(anthropic.models.some((m) => m.id === 'claude-opus-4-7')).toBe(false);
    expect(stale?.id).toBe(recommended.id);
    expect(stale?.capabilities?.includes('tools')).toBe(true); // so Tools/web stay visible
  });

  it('falls back for an empty/garbage saved id', () => {
    expect(resolveActiveModel('anthropic', '')?.id).toBe(recommended.id);
  });

  it('returns null only for an unknown provider', () => {
    // The RUNTIME guard, not a type one: `resolveActiveModel` takes a plain
    // `string` provider, so an off-catalog id is well-typed and the directive
    // that used to sit here became an `Unused '@ts-expect-error'` error.
    expect(resolveActiveModel('not-a-provider', 'x')).toBeNull();
  });

  it('every provider in the catalog resolves a non-null model for a stale id', () => {
    for (const p of PROVIDERS) {
      const got = resolveActiveModel(p.id, 'definitely-not-a-real-model');
      expect(got, p.id).not.toBeNull();
      expect(p.models.some((m) => m.id === got?.id), p.id).toBe(true); // a REAL catalog model
    }
  });
});
