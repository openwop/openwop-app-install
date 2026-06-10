/**
 * A11 — agent capability negotiation (RFC 0092). Unmet `requiresCapabilities`
 * are surfaced via the merged `degraded[]` projection.
 */

import { describe, expect, it } from 'vitest';
import { mergeDegraded, unmetCapabilities } from '../src/host/agentCapabilities.js';

describe('agent capabilities (A11 / RFC 0092)', () => {
  it('computes unmet capabilities against the advertised set', () => {
    const advertised = new Set(['host.aiProviders', 'host.knowledge']);
    expect(unmetCapabilities(['host.aiProviders'], advertised)).toEqual([]);
    expect(unmetCapabilities(['host.workspace', 'host.aiProviders'], advertised)).toEqual(['host.workspace']);
    expect(unmetCapabilities(undefined, advertised)).toEqual([]);
  });

  it('merges pack degraded + unmet capabilities, sorted, or undefined when none', () => {
    const advertised = new Set(['host.knowledge']);
    expect(mergeDegraded(['x.pack.dep'], ['host.workspace'], advertised)).toEqual(['host.workspace', 'x.pack.dep']);
    expect(mergeDegraded(undefined, ['host.knowledge'], advertised)).toBeUndefined();
    expect(mergeDegraded([], [], advertised)).toBeUndefined();
  });
});
