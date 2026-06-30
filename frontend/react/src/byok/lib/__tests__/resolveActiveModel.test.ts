import { describe, it, expect } from 'vitest';
import { resolveActiveModel, getDefaultModel, getProvider, PROVIDERS } from '../providers.js';

/**
 * Regression guard for the "composer controls vanish after a catalog refresh" bug:
 * a model-catalog refresh renamed ids (e.g. `claude-opus-4-7`→`-4-8`, `MiniMax-M2`→`M3`),
 * stranding any saved `config.model`. The chat resolved the active model by EXACT id with
 * no fallback, so a stale id → `activeModel = null` → `supportsTools`/`supportsWebSearch`
 * false → the Tools/web composer controls silently disappeared. `resolveActiveModel` falls
 * back to the provider default so capability detection reflects a VALID model.
 */
describe('resolveActiveModel — stale-model fallback', () => {
  const anthropic = getProvider('anthropic');
  const known = anthropic.models[0]!.id;

  it('returns the exact model when the saved id is current', () => {
    expect(resolveActiveModel('anthropic', known)?.id).toBe(known);
  });

  it('falls back to the provider default for a STALE/renamed id (the bug)', () => {
    const stale = resolveActiveModel('anthropic', 'claude-opus-4-7'); // a real id removed by the refresh
    expect(stale).not.toBeNull();
    expect(stale).toBe(getDefaultModel('anthropic')); // the recommended-or-first model
    expect(stale?.capabilities?.includes('tools')).toBe(true); // so Tools/web stay visible
  });

  it('falls back for an empty/garbage saved id', () => {
    expect(resolveActiveModel('anthropic', '')).toBe(getDefaultModel('anthropic'));
  });

  it('returns null only for an unknown provider', () => {
    // @ts-expect-error — exercising the unknown-provider guard with an off-catalog id
    expect(resolveActiveModel('not-a-provider', 'x')).toBeNull();
  });

  it('every provider in the catalog resolves a non-null model for a stale id', () => {
    for (const p of PROVIDERS) {
      expect(resolveActiveModel(p.id, 'definitely-not-a-real-model')).not.toBeNull();
    }
  });
});
