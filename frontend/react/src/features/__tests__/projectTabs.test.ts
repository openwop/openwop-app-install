/**
 * ADR 1090 D3 — the shipped features' project tabs: every key is unique, lowercase
 * kebab, and repeats none of the host's own tabs. A test over the shipped
 * features, so a collision fails here, not as a tab that silently never renders.
 */
import { describe, expect, it } from 'vitest';
import { featureProjectTabs } from '../registry.js';
import { HOST_TAB_KEYS as HOST } from '../projects/ProjectDetailPage.js';

describe('ADR 1090 — shipped project tabs', () => {
  it('keys are unique, kebab-case and never a host tab', () => {
    const keys = featureProjectTabs().map((t) => t.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const k of keys) {
      expect(k).toMatch(/^[a-z][a-z0-9-]*$/);
      expect(HOST).not.toContain(k);
    }
  });
});
