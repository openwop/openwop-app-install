/**
 * AI-GATE-1 — the RFC 0031 capability gate evaluates against the NODE's pinned
 * provider, not a host-wide default.
 *
 * Found by /grade-code on the ADR 0505 delta. `executor.ts` built its gate input as
 * `activeProvider: gateConfig.defaultProvider` — one host-wide value from
 * `OPENWOP_DEFAULT_AI_PROVIDER` (else `supportedProviders[0]`). So a node declaring
 * `requiredModelCapabilities` was checked against a provider it does not use.
 *
 * That made the declaration DECORATIVE: pinning a node to a provider advertising no
 * capabilities (e.g. the managed tier, absent from `PROVIDER_CAPABILITIES`) still
 * passed, because the gate looked at Anthropic instead. ADR 0505 dropped a planned
 * `requiredModelCapabilities` declaration for exactly this reason — it would have
 * looked like a guard and protected nothing.
 *
 * `nodeRef.config` was already in scope at the call site; it was simply never read.
 */

import { describe, expect, it } from 'vitest';
import { evaluateModelCapabilityGate } from '../src/executor/modelCapabilityGate.js';

/** The shape `executor.ts` now builds — node pin first, host default as fallback. */
const gateInputFor = (nodeConfig: Record<string, unknown> | undefined, hostDefault: string) => ({
  module: { requiredModelCapabilities: ['structured-output'] },
  activeProvider: typeof nodeConfig?.provider === 'string' && nodeConfig.provider
    ? (nodeConfig.provider as string)
    : hostDefault,
  activeModel: 'default',
  substitutionSupported: false,
  supportedProviders: ['anthropic', 'openai', 'google', 'minimax', 'openwop-free'],
});

describe('the capability gate sees the node, not the host default', () => {
  it('REFUSES a node pinned to a provider that advertises no capabilities', () => {
    // The case the old code could not see: host default is Anthropic (which HAS
    // structured-output), but the node runs on the managed tier (which advertises
    // nothing). Before AI-GATE-1 this passed.
    const outcome = evaluateModelCapabilityGate(gateInputFor({ provider: 'openwop-free' }, 'anthropic'));
    expect(outcome.route, 'a node pinned to a capability-less provider must refuse').toBe('refuse');
  });

  it('ALLOWS a node pinned to a provider that does advertise the capability', () => {
    const outcome = evaluateModelCapabilityGate(gateInputFor({ provider: 'anthropic' }, 'anthropic'));
    expect(outcome.route).not.toBe('refuse');
  });

  it('is not fooled by a capable HOST default when the node pin is incapable', () => {
    // The precise inversion the bug produced — restated so a regression is obvious.
    const viaNode = evaluateModelCapabilityGate(gateInputFor({ provider: 'minimax' }, 'anthropic'));
    const viaHostOnly = evaluateModelCapabilityGate(gateInputFor(undefined, 'anthropic'));
    expect(viaNode.route).toBe('refuse');
    expect(viaHostOnly.route, 'with no node pin the host default still governs').not.toBe('refuse');
  });

  it('falls back to the host default when the node pins nothing', () => {
    // Non-chain nodes carry no provider in config and must be unaffected.
    expect(evaluateModelCapabilityGate(gateInputFor({}, 'anthropic')).route).not.toBe('refuse');
    expect(evaluateModelCapabilityGate(gateInputFor(undefined, 'openwop-free')).route).toBe('refuse');
  });

  it('ignores a non-string provider rather than coercing it', () => {
    // Defensive: pack config is JSON and could carry anything.
    expect(evaluateModelCapabilityGate(gateInputFor({ provider: 42 }, 'anthropic')).route).not.toBe('refuse');
  });
});

describe('the EXECUTOR actually feeds the node config to the gate', () => {
  it('reads nodeRef.config.provider/model at the gate call site', async () => {
    // Without this the suite above is VACUOUS in the REV-VIS-1 way: `gateInputFor`
    // re-implements the executor's expression, so every assertion would still pass
    // against an executor that kept using only the host default. A full executor
    // integration test is expensive; pinning the call site is the cheap honest
    // guard, and it fails loudly if someone reverts to `gateConfig.defaultProvider`.
    const { readFile } = await import('node:fs/promises');
    const src = await readFile(new URL('../src/executor/executor.ts', import.meta.url), 'utf8');
    expect(src, 'the gate input must derive activeProvider from the NODE').toMatch(/activeProvider:[\s\S]{0,200}nodeRef\.config\?\.provider/);
    expect(src, 'and activeModel likewise').toMatch(/activeModel:[\s\S]{0,200}nodeRef\.config\?\.model/);
  });
});
